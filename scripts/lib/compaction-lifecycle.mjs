import { inspectProject, isProjectRecoveryReadable } from "./lode-core.mjs";
import fs from "node:fs";
import { sessionStatePath, safeSessionPath } from "./session-routing.mjs";
import { readProjectDirectionView, sameProjectDirectionView } from "./project-direction-view.mjs";
import {
  abortCompaction,
  continueCompaction,
  inspectCompaction,
  prepareCompaction,
  prepareCompactionFromCurrentCheckpoint,
  settleCompactionContinuation,
  verifyCompaction,
} from "./compaction-recovery.mjs";
import { inspectConversationProjectExperience, recoveryReadiness } from "./project-bootstrap.mjs";
import { actionability } from "./experience-projection.mjs";
import { readSessionWorkContext } from "./session-work-context.mjs";

import { formatForVerifiedOwner } from "./project-storage-format.mjs";
import { ARTIFACT_COMPOSITION } from "./lode-artifact-composition.mjs";

export const COMPACTION_LIFECYCLE_VERSION = "0.1.0";
const EVENT_KINDS = new Set(["conversation-entry", "provider-replaced", "before-compaction", "after-compaction"]);
const OUTCOMES = new Set(["succeeded", "failed", "uncertain"]);
const RUNTIMES = new Set(["claude", "codex", "opencode"]);

const fail = (message, code = "COMPACTION_LIFECYCLE_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

function exactKeys(value, expected, label, code = "INVALID_COMPACTION_LIFECYCLE_INPUT") {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`, code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} fields must be exactly: ${wanted.join(", ")}.`, code);
  }
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} is required.`, "INVALID_COMPACTION_LIFECYCLE_INPUT");
  return value.trim();
}

function validateTurn(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail("Lifecycle userTurnId must be a non-negative safe integer.", "INVALID_USER_TURN_ID");
  return value;
}

function readyIdentity(root) {
  const inspected = inspectProject(root);
  if (inspected.status !== "ready") fail(`Project must be ready for Host compaction lifecycle processing; current status: ${inspected.status}.`, "PROJECT_NOT_READY");
  return {
    inspected,
    identity: {
      projectId: inspected.project.projectId,
      sessionId: inspected.state.sessionId,
      projectRoot: inspected.project.projectRoot,
    },
  };
}

function adapterDescriptor(adapter) {
  if (!adapter || typeof adapter.describe !== "function" || typeof adapter.nextEvent !== "function"
    || typeof adapter.retainContinuation !== "function" || typeof adapter.loadContinuation !== "function"
    || typeof adapter.acknowledge !== "function") {
    fail("Compaction lifecycle Host adapter is incomplete.", "INVALID_COMPACTION_LIFECYCLE_HOST");
  }
  const descriptor = adapter.describe();
  exactKeys(descriptor, [
    "adapterKey", "adapterVersion", "authorityPlane", "deliverySemantics", "providerNeutral",
    "providerSessionIdentityPersisted", "recoveryAuthority", "instructionAuthority", "promotionAuthority",
  ], "Compaction lifecycle Host descriptor", "INVALID_COMPACTION_LIFECYCLE_HOST");
  if (!new Set(["head.compaction-lifecycle-host", "lode.compaction-lifecycle-host"]).has(descriptor.adapterKey)
    || descriptor.adapterVersion !== COMPACTION_LIFECYCLE_VERSION
    || descriptor.authorityPlane !== "P5"
    || descriptor.deliverySemantics !== "journaled-no-uncertain-replay"
    || descriptor.providerNeutral !== true
    || descriptor.providerSessionIdentityPersisted !== false
    || descriptor.recoveryAuthority !== false
    || descriptor.instructionAuthority !== false
    || descriptor.promotionAuthority !== false) {
    fail("Compaction lifecycle Host descriptor attempts to change the provider-neutral P5 boundary.", "COMPACTION_LIFECYCLE_AUTHORITY_VIOLATION");
  }
  return descriptor;
}

function validateEvent(event, identity) {
  exactKeys(event, ["eventId", "kind", "projectId", "sessionId", "runtime", "userTurnId", "epochId", "outcome"], "Compaction lifecycle event");
  if (!/^compaction-event-[A-Za-z0-9._:-]{1,128}$/u.test(event.eventId || "")) fail("Lifecycle eventId is invalid.", "INVALID_COMPACTION_LIFECYCLE_EVENT");
  if (!EVENT_KINDS.has(event.kind)) fail("Lifecycle event kind is invalid.", "INVALID_COMPACTION_LIFECYCLE_EVENT");
  if (event.projectId !== identity.projectId) fail("Lifecycle event belongs to another Project.", "COMPACTION_LIFECYCLE_PROJECT_MISMATCH");
  if (event.sessionId !== identity.sessionId) fail("Lifecycle event belongs to another HEAD Session.", "COMPACTION_LIFECYCLE_SESSION_MISMATCH");
  if (!RUNTIMES.has(event.runtime)) fail("Lifecycle runtime is invalid.", "INVALID_COMPACTION_LIFECYCLE_EVENT");
  validateTurn(event.userTurnId);
  if (event.kind === "after-compaction") {
    if (!/^compaction-epoch-[a-f0-9-]{36}$/u.test(event.epochId || "") || !OUTCOMES.has(event.outcome)) {
      fail("After-compaction event requires an exact epoch and bounded outcome.", "INVALID_COMPACTION_LIFECYCLE_EVENT");
    }
  } else if (event.epochId !== null || event.outcome !== null) {
    fail("Only after-compaction events may carry an epoch or outcome.", "INVALID_COMPACTION_LIFECYCLE_EVENT");
  }
  return event;
}

function validateDirection(direction) {
  exactKeys(direction, ["purpose", "approvedDecisions", "currentPosition", "nextExpectedResult", "openReviewIds"], "HEAD recovery direction");
  return {
    purpose: requiredText(direction.purpose, "Recovery purpose"),
    approvedDecisions: direction.approvedDecisions,
    currentPosition: requiredText(direction.currentPosition, "Current position"),
    nextExpectedResult: requiredText(direction.nextExpectedResult, "Next expected result"),
    openReviewIds: direction.openReviewIds,
  };
}

function safeAcknowledge(adapter, event, disposition) {
  try {
    const result = adapter.acknowledge({ eventId: event.eventId, disposition });
    if (!result || !new Set(["acknowledged", "uncertain"]).has(result.status)) return { status: "uncertain" };
    return result;
  } catch {
    return { status: "uncertain" };
  }
}

function recoveryAttention(error, details = {}) {
  return {
    status: "recovery_attention_required",
    reasonCode: error?.code || "COMPACTION_LIFECYCLE_ERROR",
    recoveryDependentWorkBlocked: true,
    ordinaryWorkBlocked: false,
    userDecisionRequired: false,
    headActionRequired: true,
    authorityChanged: false,
    ...details,
  };
}

async function conversationProjection(root, recovery) {
  const publicRecovery = { ...recovery };
  delete publicRecovery.restore;
  const projectStatus = (await inspectConversationProjectExperience({ root, recoveryOverride: publicRecovery }));
  return {
    ...actionability(projectStatus),
    projectStatus,
    attention: projectStatus.attention,
    runtime: projectStatus.runtime,
    presentation: projectStatus.presentation,
  };
}

export async function enterConversationRecovery({ root = ".", readRelatedNativeContext = null } = {}) {
  const inspected = inspectProject(root);
  const readable = isProjectRecoveryReadable(inspected);
  const entryDirection = readable ? readProjectDirectionView({ root }) : null;
  const recovery = recoveryReadiness(inspected, { includeRestore: true });
  const composed = (await conversationProjection(root, recovery));
  // Optional P3 work is never a prerequisite for P2 restore or ordinary work.
  // Its absence/corruption cannot manufacture a purpose, next action or approval.
  if (readable) {
    try {
      composed.workContext = readSessionWorkContext({ root, expectedSessionId: inspected.state.sessionId,
        expectedCheckpointId: inspected.state.latestCheckpoint || null });
    } catch (error) {
      composed.workContext = { kind: "SessionWorkContextProjection", authorityPlane: "P4",
        status: "work_context_unavailable", reasonCode: error.code || "SESSION_WORK_EVIDENCE_READ_ERROR",
        records: [], persisted: false, recoveryAuthority: false, instructionAuthority: false,
        ordinaryWorkBlocked: false, executionReplayAllowed: false };
    }
    if (typeof readRelatedNativeContext === "function") {
      try {
        const related = readRelatedNativeContext({ childSessionId: inspected.state.sessionId });
        if (related && typeof related.then !== "function") composed.relatedNativeWorkContext = related;
      } catch { /* Historical related P3 is optional, not recovery authority. */ }
    }
  }
  const finish = (result) => {
    if (!readable) return result;
    const afterProject = JSON.parse(fs.readFileSync(safeSessionPath(root, formatForVerifiedOwner(inspected.storage).directory, "project.json"), "utf8"));
    const afterState = JSON.parse(fs.readFileSync(sessionStatePath(root, inspected.storage), "utf8"));
    const afterDirection = readProjectDirectionView({ root });
    if (JSON.stringify(afterProject) === JSON.stringify(inspected.project)
      && JSON.stringify(afterState) === JSON.stringify(inspected.state)
      && sameProjectDirectionView(afterDirection, entryDirection)) return result;
    // A sequential composition is not an atomic snapshot. Never publish old
    // next-action context together with a later cancellation as a stable entry.
    return { ...recoveryAttention({ code: "CONVERSATION_ENTRY_BASIS_CHANGED" }), persisted: false,
      ...afterDirection, sessionId: null, workContext: { status: "work_context_basis_changed", records: [], persisted: false },
      nextHeadAction: "Reread this bounded entry before dependent work. Continue independent work; do not replay effects or ask for routine approval.",
      presentation: { mode: "exception", summary: "Selected context changed during entry; only dependent context needs another read.", userActionRequired: false } };
  };
  if (!readable) {
    return {
      status: "conversation_recovery_unavailable",
      reasonCode: inspected.status === "not_initialized" ? "NOT_INITIALIZED" : "PROJECT_NOT_READY",
      recoveryDependentWorkBlocked: recovery.recoveryDependentWorkBlocked,
      ordinaryWorkBlocked: false,
      userDecisionRequired: false,
      headActionRequired: recovery.headActionRequired,
      authorityChanged: false,
      persisted: false,
      ...composed,
    };
  }
  if (!inspected.state.latestCheckpoint) {
    return finish({
      status: "conversation_ready",
      recoveryState: "no-current-checkpoint",
      recoveryDependentWorkBlocked: false,
      ordinaryWorkBlocked: false,
      userDecisionRequired: false,
      headActionRequired: false,
      authorityChanged: false,
      persisted: false,
      ...composed,
    });
  }
  if (recovery.restorable) {
    const restored = recovery.restore;
    return finish({
      status: "conversation_direction_restored",
      recoveryState: "verified-current-checkpoint",
      restore: restored,
      recoveryDependentWorkBlocked: false,
      ordinaryWorkBlocked: false,
      userDecisionRequired: false,
      headActionRequired: false,
      authorityChanged: false,
      persisted: false,
      ...composed,
    });
  }
  return finish({
    ...recoveryAttention({ code: recovery.reasonCode }, { persisted: false }),
    userDecisionRequired: false,
    ...composed,
  });
}

function currentEpochForEvent(root, event) {
  const status = inspectCompaction({ root });
  if (!status.epoch || status.epoch.epochId !== event.epochId) {
    fail("After-compaction event does not match the current Core epoch.", "COMPACTION_LIFECYCLE_EPOCH_MISMATCH");
  }
  if (status.epoch.runtime !== event.runtime) fail("Lifecycle runtime does not match the prepared epoch.", "COMPACTION_LIFECYCLE_RUNTIME_MISMATCH");
  return status;
}

async function currentDirectionAfterContinuationDrift(error, { root, event, hostAdapter }) {
  if (!new Set(["COMPACTION_CHECKPOINT_STALE", "COMPACTION_SESSION_DRIFT", "COMPACTION_RUN_DRIFT", "COMPACTION_RUN_POINTER_MISMATCH"]).has(error.code)) throw error;
  const current = inspectCompaction({ root });
  if (current.epoch?.epochId === event.epochId && ["prepared", "provider_compacted", "verified"].includes(current.epoch.state)) {
    abortCompaction({ root, epochId: event.epochId, reason: "current-p2-direction-superseded-transport-continuation" });
  }
  const conversationEntry = (await enterConversationRecovery({ root }));
  return {
    status: conversationEntry.status === "recovery_attention_required"
      ? "recovery_attention_required"
      : "conversation_direction_restored_without_transport_continuation",
    reasonCode: error.code,
    eventKind: event.kind,
    conversationEntry,
    continuationConsumed: false,
    freshLogicalHeadRequired: true,
    acknowledgement: safeAcknowledge(hostAdapter, event, "processed"),
    recoveryDependentWorkBlocked: conversationEntry.recoveryDependentWorkBlocked,
    ordinaryWorkBlocked: false,
    userDecisionRequired: false,
    headActionRequired: conversationEntry.headActionRequired,
    authorityChanged: false,
  };
}

export async function processCompactionLifecycle({ root = ".", hostAdapter = null, direction = null } = {}) {
  const entry = (await enterConversationRecovery({ root }));
  if (!hostAdapter) {
    return {
      status: "host_lifecycle_unavailable",
      conversationEntry: entry,
      hostLifecycleAvailable: false,
      recoveryDependentWorkBlocked: entry.recoveryDependentWorkBlocked,
      ordinaryWorkBlocked: false,
      userDecisionRequired: false,
      headActionRequired: entry.headActionRequired,
      authorityChanged: false,
    };
  }
  const { inspected, identity } = readyIdentity(root);
  const descriptor = adapterDescriptor(hostAdapter);
  const event = hostAdapter.nextEvent({ ...identity });
  if (event == null) {
    return {
      status: "no_lifecycle_event",
      conversationEntry: entry,
      hostLifecycleAvailable: true,
      recoveryDependentWorkBlocked: entry.recoveryDependentWorkBlocked,
      ordinaryWorkBlocked: false,
      userDecisionRequired: false,
      headActionRequired: entry.headActionRequired,
      authorityChanged: false,
    };
  }
  validateEvent(event, identity);

  if (event.kind === "conversation-entry" || event.kind === "provider-replaced") {
    let compaction = inspectCompaction({ root: identity.projectRoot });
    if (compaction.continuationOutcome === "uncertain") {
      settleCompactionContinuation({ root: identity.projectRoot, epochId: compaction.epoch.epochId });
      compaction = inspectCompaction({ root: identity.projectRoot });
    }
    let superseded = false;
    if (compaction.epoch && ["prepared", "provider_compacted", "verified"].includes(compaction.epoch.state)
      && event.userTurnId > compaction.epoch.userTurnIdAtPrepare) {
      try {
        verifyCompaction({
          root: identity.projectRoot,
          epochId: compaction.epoch.epochId,
          checkpointDigest: compaction.epoch.checkpointDigest,
          currentUserTurnId: event.userTurnId,
          providerCompacted: false,
        });
      } catch (error) {
        if (error.code !== "COMPACTION_SUPERSEDED") throw error;
        superseded = true;
      }
    }
    const refreshed = (await enterConversationRecovery({ root: identity.projectRoot }));
    return {
      status: refreshed.status,
      eventKind: event.kind,
      conversationEntry: refreshed,
      pendingContinuationSuperseded: superseded,
      acknowledgement: safeAcknowledge(hostAdapter, event, "processed"),
      hostDescriptor: descriptor,
      ordinaryWorkBlocked: false,
      userDecisionRequired: false,
      headActionRequired: refreshed.headActionRequired,
      authorityChanged: false,
    };
  }

  if (event.kind === "before-compaction") {
    let prepared;
    try {
      prepared = direction == null
        ? prepareCompactionFromCurrentCheckpoint({ root: identity.projectRoot, runtime: event.runtime, userTurnIdAtPrepare: event.userTurnId })
        : prepareCompaction({ root: identity.projectRoot, runtime: event.runtime, userTurnIdAtPrepare: event.userTurnId, ...validateDirection(direction) });
    } catch (error) {
      if (direction == null && new Set(["SESSION_RESTORE_CHECKPOINT_REQUIRED", "SESSION_RESTORE_CURRENT_CHECKPOINT_REQUIRED"]).has(error.code)) {
        return {
          status: "head_direction_required",
          eventKind: event.kind,
          recoveryDependentWorkBlocked: true,
          ordinaryWorkBlocked: false,
          userDecisionRequired: false,
          headActionRequired: true,
          authorityChanged: false,
          reasonCode: error.code,
        };
      }
      return recoveryAttention(error, { eventKind: event.kind });
    }
    let retained;
    try {
      retained = hostAdapter.retainContinuation({
        eventId: event.eventId,
        projectId: identity.projectId,
        sessionId: identity.sessionId,
        runtime: event.runtime,
        epochId: prepared.epoch.epochId,
        checkpointDigest: prepared.checkpoint.checkpointDigest,
        continuationToken: prepared.continuationToken,
      });
    } catch {
      retained = { status: "uncertain" };
    }
    if (!retained || retained.status !== "retained") {
      abortCompaction({ root: identity.projectRoot, epochId: prepared.epoch.epochId, reason: "host-continuation-retention-uncertain" });
      return recoveryAttention({ code: "COMPACTION_HOST_RETENTION_UNCERTAIN" }, {
        eventKind: event.kind,
        acknowledgement: safeAcknowledge(hostAdapter, event, "failed"),
      });
    }
    return {
      status: "compaction_lifecycle_prepared",
      eventKind: event.kind,
      epoch: prepared.epoch,
      checkpoint: prepared.checkpoint,
      checkpointReused: prepared.checkpointReused === true,
      hostContinuationRetained: true,
      continuationTokenDisclosed: false,
      acknowledgement: safeAcknowledge(hostAdapter, event, "processed"),
      ordinaryWorkBlocked: false,
      userDecisionRequired: false,
      headActionRequired: false,
      authorityChanged: direction != null,
    };
  }

  const compaction = currentEpochForEvent(identity.projectRoot, event);
  const restored = (await enterConversationRecovery({ root: identity.projectRoot }));
  if (restored.recoveryDependentWorkBlocked) {
    return recoveryAttention({ code: restored.reasonCode }, { eventKind: event.kind, conversationEntry: restored });
  }
  if (compaction.continuationOutcome === "uncertain") {
    if (event.outcome !== "succeeded") {
      fail("Host outcome conflicts with the compaction whose continuation was already consumed.", "COMPACTION_LIFECYCLE_DIVERGENT_OUTCOME");
    }
    settleCompactionContinuation({ root: identity.projectRoot, epochId: event.epochId });
    return {
      status: "conversation_direction_restored_after_uncertain_continuation",
      reasonCode: "COMPACTION_CONTINUATION_OUTCOME_UNCERTAIN",
      eventKind: event.kind,
      conversationEntry: restored,
      continuationConsumed: true,
      providerContinuationOutcome: "uncertain",
      retryAllowed: false,
      freshLogicalHeadRequired: true,
      acknowledgement: safeAcknowledge(hostAdapter, event, "processed"),
      recoveryDependentWorkBlocked: false,
      ordinaryWorkBlocked: false,
      userDecisionRequired: false,
      headActionRequired: false,
      authorityChanged: false,
    };
  }
  if (compaction.epoch.state === "continued" && event.outcome !== "succeeded") {
    fail("Host reported an outcome that conflicts with the already-consumed continuation.", "COMPACTION_LIFECYCLE_DIVERGENT_OUTCOME");
  }
  if (compaction.epoch.state === "aborted") {
    const transportOnlyAbort = new Set([
      "current-p2-direction-superseded-transport-continuation",
      "host-continuation-unavailable-fresh-logical-head",
      "COMPACTION_CHECKPOINT_STALE", "COMPACTION_SESSION_DRIFT", "COMPACTION_RUN_DRIFT", "COMPACTION_RUN_POINTER_MISMATCH",
    ]).has(compaction.epoch.abortReason);
    if (transportOnlyAbort) {
      if (event.outcome !== "succeeded") fail("Host outcome conflicts with the successful compaction whose transport continuation was closed.", "COMPACTION_LIFECYCLE_DIVERGENT_OUTCOME");
      return {
        status: "conversation_direction_restored_without_transport_continuation",
        eventKind: event.kind,
        conversationEntry: restored,
        continuationConsumed: false,
        freshLogicalHeadRequired: true,
        acknowledgement: safeAcknowledge(hostAdapter, event, "processed"),
        recoveryDependentWorkBlocked: false,
        ordinaryWorkBlocked: false,
        userDecisionRequired: false,
        headActionRequired: false,
        authorityChanged: false,
      };
    }
    if (event.outcome !== "failed") fail("Host outcome conflicts with the terminal aborted epoch.", "COMPACTION_LIFECYCLE_DIVERGENT_OUTCOME");
    return {
      status: "provider_compaction_failure_already_recorded",
      eventKind: event.kind,
      conversationEntry: restored,
      continuationConsumed: false,
      acknowledgement: safeAcknowledge(hostAdapter, event, "processed"),
      recoveryDependentWorkBlocked: false,
      ordinaryWorkBlocked: false,
      userDecisionRequired: false,
      headActionRequired: false,
      authorityChanged: false,
    };
  }
  if (compaction.epoch.state === "superseded") {
    if (event.outcome !== "succeeded") fail("Host outcome conflicts with the superseded epoch.", "COMPACTION_LIFECYCLE_DIVERGENT_OUTCOME");
    return {
      status: "compaction_lifecycle_superseded",
      eventKind: event.kind,
      conversationEntry: restored,
      continuationConsumed: false,
      acknowledgement: safeAcknowledge(hostAdapter, event, "processed"),
      ordinaryWorkBlocked: false,
      userDecisionRequired: false,
      headActionRequired: false,
      authorityChanged: false,
    };
  }
  if (event.outcome === "uncertain") {
    return {
      status: "provider_compaction_outcome_uncertain",
      eventKind: event.kind,
      conversationEntry: restored,
      retryAllowed: false,
      continuationConsumed: false,
      acknowledgement: safeAcknowledge(hostAdapter, event, "uncertain"),
      recoveryDependentWorkBlocked: false,
      ordinaryWorkBlocked: false,
      userDecisionRequired: false,
      headActionRequired: true,
      authorityChanged: false,
    };
  }
  if (event.outcome === "failed") {
    if (["prepared", "provider_compacted", "verified"].includes(compaction.epoch.state)) {
      if (compaction.epoch.state === "prepared") {
        try {
          verifyCompaction({ root: identity.projectRoot, epochId: event.epochId, checkpointDigest: compaction.epoch.checkpointDigest, currentUserTurnId: event.userTurnId, providerCompacted: false });
        } catch (error) {
          if (!new Set(["PROVIDER_COMPACTION_FAILED", "COMPACTION_SUPERSEDED"]).has(error.code)) throw error;
        }
      } else {
        abortCompaction({ root: identity.projectRoot, epochId: event.epochId, reason: "provider-compaction-failed" });
      }
    }
    return {
      status: "provider_compaction_failed",
      eventKind: event.kind,
      conversationEntry: restored,
      continuationConsumed: false,
      acknowledgement: safeAcknowledge(hostAdapter, event, "processed"),
      recoveryDependentWorkBlocked: false,
      ordinaryWorkBlocked: false,
      userDecisionRequired: false,
      headActionRequired: false,
      authorityChanged: false,
    };
  }
  if (compaction.epoch.state === "continued") {
    return {
      status: "compaction_lifecycle_already_continued",
      eventKind: event.kind,
      conversationEntry: restored,
      continuationConsumed: true,
      acknowledgement: safeAcknowledge(hostAdapter, event, "processed"),
      ordinaryWorkBlocked: false,
      userDecisionRequired: false,
      headActionRequired: false,
      authorityChanged: false,
    };
  }
  if (event.userTurnId > compaction.epoch.userTurnIdAtPrepare) {
    try {
      verifyCompaction({ root: identity.projectRoot, epochId: event.epochId, checkpointDigest: compaction.epoch.checkpointDigest, currentUserTurnId: event.userTurnId, providerCompacted: true });
    } catch (error) {
      if (error.code !== "COMPACTION_SUPERSEDED") throw error;
    }
    return {
      status: "compaction_lifecycle_superseded",
      eventKind: event.kind,
      conversationEntry: (await enterConversationRecovery({ root: identity.projectRoot })),
      continuationConsumed: false,
      acknowledgement: safeAcknowledge(hostAdapter, event, "processed"),
      ordinaryWorkBlocked: false,
      userDecisionRequired: false,
      headActionRequired: false,
      authorityChanged: false,
    };
  }
  if (compaction.epoch.state === "prepared" || compaction.epoch.state === "provider_compacted") {
    try { verifyCompaction({
      root: identity.projectRoot,
      epochId: event.epochId,
      checkpointDigest: compaction.epoch.checkpointDigest,
      currentUserTurnId: event.userTurnId,
      providerCompacted: true,
    }); } catch (error) {
      return (await currentDirectionAfterContinuationDrift(error, { root: identity.projectRoot, event, hostAdapter }));
    }
  } else if (compaction.epoch.state !== "verified") {
    fail(`After-compaction success cannot continue from state ${compaction.epoch.state}.`, "INVALID_COMPACTION_STATE");
  }
  let loaded;
  try {
    loaded = hostAdapter.loadContinuation({
      projectId: identity.projectId,
      sessionId: identity.sessionId,
      runtime: event.runtime,
      epochId: event.epochId,
      checkpointDigest: compaction.epoch.checkpointDigest,
    });
  } catch {
    loaded = { status: "unavailable" };
  }
  if (!loaded || loaded.status !== "available" || typeof loaded.continuationToken !== "string") {
    abortCompaction({ root: identity.projectRoot, epochId: event.epochId, reason: "host-continuation-unavailable-fresh-logical-head" });
    return {
      status: "conversation_direction_restored_without_transport_continuation",
      eventKind: event.kind,
      conversationEntry: restored,
      continuationConsumed: false,
      freshLogicalHeadRequired: true,
      acknowledgement: safeAcknowledge(hostAdapter, event, "processed"),
      recoveryDependentWorkBlocked: false,
      ordinaryWorkBlocked: false,
      userDecisionRequired: false,
      headActionRequired: false,
      authorityChanged: false,
    };
  }
  let continued;
  try { continued = continueCompaction({
    root: identity.projectRoot,
    epochId: event.epochId,
    continuationToken: loaded.continuationToken,
    currentUserTurnId: event.userTurnId,
  }); } catch (error) {
    return (await currentDirectionAfterContinuationDrift(error, { root: identity.projectRoot, event, hostAdapter }));
  }
  return {
    status: "compaction_lifecycle_continued",
    eventKind: event.kind,
    conversationEntry: restored,
    continuation: continued,
    continuationConsumed: true,
    acknowledgement: safeAcknowledge(hostAdapter, event, "processed"),
    ordinaryWorkBlocked: false,
    userDecisionRequired: false,
    headActionRequired: false,
    authorityChanged: false,
  };
}

export class InMemoryCompactionLifecycleHostAdapter {
  #events = [];
  #continuations = new Map();
  #acknowledgements = new Map();

  describe() {
    return {
      adapterKey: ARTIFACT_COMPOSITION.identity === "lode" ? "lode.compaction-lifecycle-host" : "head.compaction-lifecycle-host",
      adapterVersion: COMPACTION_LIFECYCLE_VERSION,
      authorityPlane: "P5",
      deliverySemantics: "journaled-no-uncertain-replay",
      providerNeutral: true,
      providerSessionIdentityPersisted: false,
      recoveryAuthority: false,
      instructionAuthority: false,
      promotionAuthority: false,
    };
  }

  enqueue(event) {
    this.#events.push(structuredClone(event));
  }

  nextEvent() {
    return this.#events.length ? structuredClone(this.#events[0]) : null;
  }

  retainContinuation(binding) {
    const key = `${binding.epochId}:${binding.checkpointDigest}`;
    const existing = this.#continuations.get(key);
    if (existing && existing !== binding.continuationToken) return { status: "uncertain" };
    this.#continuations.set(key, binding.continuationToken);
    return { status: "retained" };
  }

  loadContinuation(binding) {
    const token = this.#continuations.get(`${binding.epochId}:${binding.checkpointDigest}`);
    return token ? { status: "available", continuationToken: token } : { status: "unavailable" };
  }

  acknowledge({ eventId, disposition }) {
    const event = this.#events[0];
    if (!event || event.eventId !== eventId) return { status: "uncertain" };
    const previous = this.#acknowledgements.get(eventId);
    if (previous && previous !== disposition) return { status: "uncertain" };
    this.#acknowledgements.set(eventId, disposition);
    this.#events.shift();
    return { status: "acknowledged" };
  }

  inspectHostState() {
    return {
      pendingEventCount: this.#events.length,
      retainedContinuationCount: this.#continuations.size,
      acknowledgementCount: this.#acknowledgements.size,
    };
  }
}

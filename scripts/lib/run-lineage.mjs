import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sessionStatePath, assertRunSession, withSessionRoute, defaultSessionStatePath } from "./session-routing.mjs";
import { assertProjectActionsCurrent } from "./project-direction.mjs";
import { atomicWriteArtifact, atomicCreateArtifact } from "./artifact-storage.mjs";
import { inspectProject, SCHEMA_VERSION } from "./lode-core.mjs";
import { readContextCapsule } from "./context-compiler.mjs";
import { buildFreshLodeReview, createResultPacket, createReviewDecision, readLineageArtifact } from "./execution-lineage.mjs";
import { withProjectMutation } from "./project-mutation-lock.mjs";
import { noteProjectGraphChange } from "./discovery-index.mjs";

import { formatForVerifiedOwner, relativeProjectArtifact } from "./project-storage-format.mjs";

const fail = (message, code = "RUN_LINEAGE_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const now = () => new Date().toISOString();

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
export const sessionStateHash = (state) => crypto.createHash("sha256").update(JSON.stringify(canonical(state))).digest("hex");

export function operationPointerHash(state) {
  return sessionStateHash(Object.fromEntries([
    "sessionId", "mode", "currentWholePlanId", "activeRunId", "activeExecutionContractId",
    "lastResultPacketId", "pendingReview", "lastReviewDecisionId", "lastReviewedRunId", "requiredPlanAction",
  ].map((key) => [key, state[key] ?? null])));
}

function completedTransitionMatches(run, state, patch) {
  const transition = run.sessionTransition;
  const terminal = transition.kind === "start" ? run.status === "active" : transition.kind === "finish" ? run.status === "awaiting_review" : run.status === "reviewed";
  return terminal && Object.entries(patch).every(([key, value]) => sameValue(state[key], value));
}

const sameValue = (left, right) => JSON.stringify(canonical(left ?? null)) === JSON.stringify(canonical(right ?? null));
const publicRun = ({ sessionTransition, startOperation, ...run }) => run;
function unchangedSession(state, transition, patch) {
  return transition.before
    ? Object.entries(transition.before).every(([key, value]) => sameValue(state[key], value)) && sameValue(transition.patch, patch)
    : sessionStateHash(state) === transition.beforeSessionHash && sessionStateHash({ ...state, ...patch, updatedAt: transition.changedAt }) === transition.afterSessionHash;
}

function atomicWrite(file, content) {
  atomicWriteArtifact(file, content);
}

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { fail(`${label} is invalid JSON: ${error.message}`, "INVALID_RUN_CANON"); }
}

function readyProject(root, action) {
  const inspected = inspectProject(root);
  if (inspected.status !== "ready") {
    fail(`Project must be ready before ${action}; current status: ${inspected.status}.`, "PROJECT_NOT_READY");
  }
  return inspected;
}

function requireArtifact(root, artifactId, kind) {
  const result = readLineageArtifact({ root, artifactId });
  if (result.artifact.kind !== kind) fail(`Expected ${kind}: ${artifactId}`, "RUN_LINEAGE_KIND_MISMATCH");
  return result.artifact;
}

function runFile(root, runId, storage) {
  if (typeof runId !== "string" || !/^run-[0-9]+-[a-f0-9]{6}$/.test(runId)) fail("Run id is invalid.", "INVALID_RUN_LINEAGE");
  return path.join(root, formatForVerifiedOwner(storage).directory, "sessions", "runs", runId, "run.json");
}

function stateFile(root, storage) {
  return sessionStatePath(root, storage);
}

// Publish the final Run once, with only the Session fields this operation owns.
// An interrupted Session update can resume without a preparatory Run write or
// hashes over unrelated checkpoint metadata. Old prepared records remain readable.
function sessionChange({ run, inspected, kind, artifactId, changedAt, patch }) {
  const existing = run.sessionTransition;
  if (existing?.kind === kind) {
    if (existing.artifactId !== artifactId || existing.projectId !== inspected.project.projectId
      || existing.sessionId !== inspected.state.sessionId || existing.runId !== run.runId) {
      fail("Run transition retry differs from its recorded input or identity.", "RUN_TRANSITION_CONFLICT");
    }
    if (!completedTransitionMatches(run, inspected.state, patch) && !unchangedSession(inspected.state, existing, patch)) fail("Session changed in fields owned by the recorded Run operation.", "RUN_TRANSITION_SESSION_DRIFT");
    return existing;
  }
  const transition = {
    kind, artifactId, projectId: inspected.project.projectId,
    sessionId: inspected.state.sessionId, runId: run.runId, changedAt,
    before: Object.fromEntries([...new Set([...Object.keys(patch), "currentWholePlanId", "activeRunId", "activeExecutionContractId", "lastReviewedRunId"])]
      .map((key) => [key, inspected.state[key] ?? null])),
    patch,
  };
  return transition;
}

function commitSessionTransition({ root, inspected, run, patch }) {
  const transition = run.sessionTransition;
  // A later explicit checkpoint may change only checkpoint metadata. Once the
  // exact operation is committed, acknowledge it without restoring older P2.
  if (completedTransitionMatches(run, inspected.state, patch)) return inspected.state;
  const state = { ...inspected.state, ...patch, updatedAt: transition.changedAt };
  if (!unchangedSession(inspected.state, transition, patch)) {
    fail("Run transition cannot overwrite changed Session state.", "RUN_TRANSITION_SESSION_DRIFT");
  }
  try { atomicWrite(stateFile(root, inspected.storage), json(state)); }
  catch (error) {
    // Publication may have completed before staging/transport cleanup failed.
    // Exact target bytes prove storage only, never a worker/effect outcome.
    if (fs.readFileSync(stateFile(root, inspected.storage), "utf8") !== json(state)) throw error;
  }
  return state;
}

const startPatch = (run) => ({ mode: "run", currentWholePlanId: run.wholePlanId,
  activeRunId: run.runId, activeExecutionContractId: run.executionContractId, requiredPlanAction: null });
const finishPatch = (run) => ({ mode: "review", activeRunId: null, activeExecutionContractId: null,
  lastResultPacketId: run.resultPacketId, pendingReview: { runId: run.runId, wholePlanId: run.wholePlanId, resultPacketId: run.resultPacketId } });
const reviewPatch = (run, artifact) => ({ mode: "session", pendingReview: null,
  lastReviewDecisionId: run.reviewDecisionId, lastReviewedRunId: run.runId,
  requiredPlanAction: artifact.disposition === "accept" ? null : {
    kind: ["revise", "expand"].includes(artifact.disposition) ? "next-whole-plan" : "user-direction",
    disposition: artifact.disposition, wholePlanId: run.wholePlanId, reviewDecisionId: run.reviewDecisionId } });

function verifyRunLineage(root, run, inspected) {
  assertRunSession(root, run, inspected.state);
  if (run.projectId !== inspected.project.projectId) fail("Run belongs to another Project.", "RUN_LINEAGE_CONFLICT");
  const contract = requireArtifact(root, run.executionContractId, "ExecutionContract");
  requireArtifact(root, run.wholePlanId, "WholePlanSnapshot");
  readContextCapsule({ root, capsuleId: run.capsuleId });
  if (contract.wholePlanId !== run.wholePlanId || contract.capsuleId !== run.capsuleId) fail("Run lineage differs from its verified Contract.", "RUN_LINEAGE_CONFLICT");
  return contract;
}

function verifyStartOperation(root, run, inspected) {
  const op = run.startOperation;
  if (!op) return null;
  const { operationHash, ...payload } = op;
  if (operationHash !== sessionStateHash(payload) || op.projectId !== run.projectId || op.sessionId !== run.sessionId
    || op.runId !== run.runId || !sameValue(op.patch, startPatch(run))
    || op.transition?.kind !== "start" || op.transition?.artifactId !== run.runId
    || op.inputHash !== sessionStateHash({ executionContractId: run.executionContractId, wholePlanId: run.wholePlanId, capsuleId: run.capsuleId })
    || op.requestKeyHash !== null && !/^[a-f0-9]{64}$/.test(op.requestKeyHash || "")) fail("Run start identity is invalid.", "RUN_START_IDENTITY_CONFLICT");
  verifyRunLineage(root, run, inspected);
  return op;
}

function inspectTransition(inspected, run) {
  const root = inspected.project.projectRoot;
  verifyRunLineage(root, run, inspected);
  const transition = run.sessionTransition;
  if (!transition) return { status: "stable", runId: run.runId, transition: null, executionReplayAllowed: false };
  if (!transition.before || !transition.patch) return { status: "legacy", runId: run.runId, transition: { kind: transition.kind }, executionReplayAllowed: false };
  const kind = transition.kind;
  let artifact = null, patch;
  if (kind === "start") {
    const op = verifyStartOperation(root, run, inspected);
    if (!op || !sameValue(transition, op.transition)) fail("Run start transition differs from its request identity.", "RUN_START_IDENTITY_CONFLICT");
    patch = startPatch(run);
    if (run.status !== "active") fail("Start transition is not active.", "RUN_TRANSITION_CONFLICT");
  } else {
    if (!["finish", "review"].includes(kind)) fail("Unknown Run transition.", "RUN_TRANSITION_CONFLICT");
    const id = kind === "finish" ? run.resultPacketId : run.reviewDecisionId;
    if (transition.artifactId !== id || run.status !== (kind === "finish" ? "awaiting_review" : "reviewed")) fail("Run transition identity differs.", "RUN_TRANSITION_CONFLICT");
    try { artifact = requireArtifact(root, id, kind === "finish" ? "ResultPacket" : "ReviewDecision"); }
    catch (error) {
      if (error.code !== "LINEAGE_ARTIFACT_NOT_FOUND") throw error;
      const alreadyStored = kind === "finish" && sameValue(transition.patch, finishPatch(run))
        && completedTransitionMatches(run, inspected.state, finishPatch(run));
      if (transition.projectId !== inspected.project.projectId || transition.sessionId !== inspected.state.sessionId || transition.runId !== run.runId) fail("Run transition owner differs.", "RUN_TRANSITION_CONFLICT");
      return { status: alreadyStored ? "committed" : "incomplete", runId: run.runId, transition: { kind, artifactId: id, artifactStatus: "missing-evidence" }, executionReplayAllowed: false, unknownEffect: !alreadyStored };
    }
    if (kind === "finish" && artifact.executionContractId !== run.executionContractId
      || kind === "review" && (artifact.resultPacketId !== run.resultPacketId || artifact.wholePlanId !== run.wholePlanId || artifact.disposition !== run.reviewDisposition)) fail("Run transition artifact lineage differs.", "RUN_TRANSITION_CONFLICT");
    patch = kind === "finish" ? finishPatch(run) : reviewPatch(run, artifact);
  }
  if (transition.projectId !== inspected.project.projectId || transition.sessionId !== inspected.state.sessionId
    || transition.runId !== run.runId || !Number.isFinite(Date.parse(transition.changedAt)) || !sameValue(transition.patch, patch)
    || !sameValue(Object.keys(transition.before).sort(), [...new Set([...Object.keys(patch), "currentWholePlanId", "activeRunId", "activeExecutionContractId", "lastReviewedRunId"])].sort())) fail("Run Session preimage/patch is invalid.", "RUN_TRANSITION_CONFLICT");
  return { status: completedTransitionMatches(run, inspected.state, patch) ? "committed" : unchangedSession(inspected.state, transition, patch) ? "incomplete" : "conflict",
    runId: run.runId, transition: { kind, artifactId: transition.artifactId, artifactStatus: kind === "start" ? "not-required" : "verified" },
    executionReplayAllowed: false, unknownEffect: kind !== "review" };
}

// Read-only, affected current Run only. This never repairs a Session or creates
// results/decisions; historical checkpoint meaning need not depend on its result.
export function inspectRunStorageTransition({ root = ".", inspected = readyProject(root, "Run storage is inspected") } = {}) {
  const runId = inspected.state.activeRunId || inspected.state.pendingReview?.runId || inspected.state.lastReviewedRunId;
  if (!runId) return { status: "none", runId: null, transition: null, executionReplayAllowed: false };
  const run = readJson(runFile(inspected.project.projectRoot, runId, inspected.storage), "Run canon");
  if (run.runId !== runId) fail("Run file identity differs.", "INVALID_RUN_CANON");
  return inspectTransition(inspected, run);
}

function reconcileLocked(inspected) {
  const result = inspectRunStorageTransition({ inspected });
  if (result.status === "conflict") fail("Session changed after the recorded Run operation.", "RUN_TRANSITION_SESSION_DRIFT");
  if (result.status !== "incomplete" || result.transition.artifactStatus === "missing-evidence") return result;
  const run = readJson(runFile(inspected.project.projectRoot, result.runId, inspected.storage), "Run canon");
  commitSessionTransition({ root: inspected.project.projectRoot, inspected, run, patch: run.sessionTransition.patch });
  return { ...result, status: "committed", repaired: "session-storage-only" };
}

export function reconcileRunStorageTransition({ root = "." } = {}) {
  return withProjectMutation({ root, scope: "session-recovery" }, () => reconcileLocked(readyProject(root, "Run storage is reconciled")));
}

function committedResponse(root, response, changedPaths = null) {
  const projection = changedPaths ? noteProjectGraphChange(root, changedPaths) : { status: "not-requested", ordinaryWorkBlocked: false };
  return { ...response, canonicalCommit: "committed", executionReplayAllowed: false,
    projectionUpdate: { ...projection, status: changedPaths && projection.status !== "unavailable" ? "current" : projection.status } };
}

function pendingReviewBundle(root) {
  const inspected = readyProject(root, "pending review is read");
  if (inspected.state.activeRunId) fail("The active Run must finish before review.", "RUN_STILL_ACTIVE");
  const pending = inspected.state.pendingReview;
  if (!pending?.runId || !pending?.wholePlanId || !pending?.resultPacketId) {
    fail("No Result Packet is awaiting review.", "NO_PENDING_REVIEW");
  }
  const projectRoot = inspected.project.projectRoot;
  const file = runFile(projectRoot, pending.runId, inspected.storage);
  const run = readJson(file, "Run canon");
  assertRunSession(projectRoot, run, inspected.state);
  if (run.status !== "awaiting_review" || run.resultPacketId !== pending.resultPacketId || run.wholePlanId !== pending.wholePlanId) {
    fail("Pending review state does not match Run canon.", "RUN_REVIEW_CONFLICT");
  }
  return { inspected, pending, projectRoot, file, run };
}

export function getPendingReviewContext({ root = "." } = {}) {
  const bundle = pendingReviewBundle(root);
  const built = buildFreshLodeReview({
    root: bundle.projectRoot,
    wholePlanId: bundle.pending.wholePlanId,
    resultPacketId: bundle.pending.resultPacketId,
    sessionId: bundle.inspected.state.sessionId,
    runId: bundle.pending.runId,
  });
  return { ...built, pendingReview: bundle.pending };
}

export function startRun(options = {}) {
  return withRunStorageMutation(options.root, () => {
    try { return startRunLocked(options); }
    catch (error) { error.affectedOperation = "run-start"; error.executionReplayAllowed = false; throw error; }
  });
}

function withRunStorageMutation(root, operation) {
  let response;
  try { return withProjectMutation({ root, scope: "session-recovery" }, () => (response = operation())); }
  catch (error) {
    // A lease-release error after the exact transaction returned is operational
    // cleanup loss, not permission to repeat the already committed transition.
    if (response?.canonicalCommit !== "committed") throw error;
    return { ...response, executionReplayAllowed: false,
      operationalCleanup: { status: "incomplete", reasonCode: error.code || "RUN_MUTATION_RELEASE_FAILED", retryTarget: "exact-owned-operational-cleanup-not-execution" } };
  }
}

function startRunLocked({ root = ".", executionContractId, startRequestId } = {}) {
  if (typeof executionContractId !== "string" || !executionContractId.trim()) {
    fail("A verified Execution Contract is required to start a Run.", "EXECUTION_CONTRACT_REQUIRED");
  }
  if (startRequestId != null && (typeof startRequestId !== "string" || !startRequestId.trim() || startRequestId.length > 256)) fail("Run start request key must be non-empty text of at most 256 characters.", "INVALID_RUN_START_REQUEST");
  let inspected = readyProject(root, "a Run starts");
  const projectRoot = inspected.project.projectRoot;
  const contract = requireArtifact(projectRoot, executionContractId.trim(), "ExecutionContract");
  const plan = requireArtifact(projectRoot, contract.wholePlanId, "WholePlanSnapshot");
  readContextCapsule({ root: projectRoot, capsuleId: contract.capsuleId });
  const requestKeyHash = startRequestId == null ? null : sessionStateHash(startRequestId.trim());
  const inputHash = sessionStateHash({ executionContractId: contract.executionContractId, wholePlanId: contract.wholePlanId, capsuleId: contract.capsuleId });
  const matches = [], orphans = [];
  const directory = path.join(projectRoot, formatForVerifiedOwner(inspected.storage).directory, "sessions", "runs");
  if (fs.existsSync(directory)) for (const id of fs.readdirSync(directory).sort()) {
    if (!/^run-[0-9]+-[a-f0-9]{6}$/.test(id)) continue;
    // Failed staging before no-clobber publication may leave an empty directory,
    // not a canonical intent or an uncertain Run. Do not invent one from layout.
    if (!fs.existsSync(runFile(projectRoot, id, inspected.storage))) continue;
    let prior;
    try { prior = readJson(runFile(projectRoot, id, inspected.storage), "Run start candidate"); }
    catch { orphans.push({ runId: id, reason: "owner-unknown" }); continue; }
    // A demonstrably different owner is not this Session's history gate.
    const ownerId = prior.sessionId || readJson(defaultSessionStatePath(projectRoot, inspected.storage), "Default Session owner").sessionId;
    if (ownerId !== inspected.state.sessionId) {
      try { withSessionRoute(projectRoot, ownerId, () => {}); }
      catch { orphans.push({ runId: id, reason: "owner-unverified" }); continue; }
      if (prior.projectId === inspected.project.projectId) continue;
      orphans.push({ runId: id, reason: "project-owner-conflict" }); continue;
    }
    if (requestKeyHash && prior.startOperation?.requestKeyHash === requestKeyHash) {
      if (prior.runId !== id) fail("Run start candidate path differs.", "RUN_START_IDENTITY_CONFLICT");
      verifyStartOperation(projectRoot, prior, inspected);
      if (prior.startOperation.inputHash !== inputHash) fail("Run start request key was reused with different input.", "RUN_START_REQUEST_CONFLICT");
      matches.push(prior);
    }
    if (prior.status === "active" && prior.runId !== inspected.state.activeRunId) orphans.push({ runId: id, reason: "unattached-active-run" });
  }
  if (matches.length > 1) fail("Run start request identifies multiple Runs.", "RUN_START_UNRESOLVED");
  if (matches.length === 1) {
    const prior = matches[0], op = prior.startOperation;
    if (orphans.some((candidate) => candidate.runId !== prior.runId)) fail("Other unresolved Run start candidates require investigation.", "RUN_START_UNRESOLVED");
    if (prior.status === "active" && unchangedSession(inspected.state, op.transition, op.patch)) {
      assertProjectActionsCurrent({ root: projectRoot, actions: contract.allowedActions || [] });
      const state = commitSessionTransition({ root: projectRoot, inspected, run: prior, patch: op.patch });
      return committedResponse(projectRoot, { status: "run_started", run: publicRun(prior), state, storageRecovery: "session-storage-only", unknownEffect: true }, [path.relative(projectRoot, stateFile(projectRoot, inspected.storage)).replaceAll("\\", "/")]);
    }
    if (prior.status === "active" && inspected.state.activeRunId !== prior.runId) fail("Recorded start Session preimage changed.", "RUN_TRANSITION_SESSION_DRIFT");
    if (prior.status === "active" && inspectTransition(inspected, prior).status !== "committed") fail("Recorded start Session pointers changed.", "RUN_TRANSITION_SESSION_DRIFT");
    return { status: "run_start_already_committed", run: publicRun(prior), state: inspected.state,
      canonicalCommit: "committed", executionReplayAllowed: false, historical: prior.status !== "active", unknownEffect: prior.status === "active",
      projectionUpdate: { status: "not-requested", ordinaryWorkBlocked: false } };
  }
  if (orphans.length) fail("A Run start has no recoverable request identity; do not guess or create a replacement Run.", "RUN_START_UNRESOLVED");
  reconcileLocked(inspected);
  inspected = readyProject(root, "a Run starts");
  if (inspected.state.activeRunId) fail(`Run already active: ${inspected.state.activeRunId}`, "RUN_ALREADY_ACTIVE");
  if (inspected.state.pendingReview) fail("The previous Result Packet requires a ReviewDecision before another Run starts.", "RUN_REVIEW_REQUIRED");
  assertProjectActionsCurrent({ root: projectRoot, actions: contract.allowedActions || [] });
  const requiredPlanAction = inspected.state.requiredPlanAction;
  if (requiredPlanAction?.kind === "user-direction") {
    fail(`Review disposition ${requiredPlanAction.disposition} requires an explicit user-owned direction before another Run.`, "USER_DIRECTION_REQUIRED");
  }
  if (requiredPlanAction?.kind === "next-whole-plan") {
    const respondsToReview = (plan.lineage || []).some((link) => (
      link.relation === "responds-to" && link.targetId === requiredPlanAction.reviewDecisionId
    ));
    if (!respondsToReview || plan.previousWholePlanId !== requiredPlanAction.wholePlanId) {
      fail("The next Run requires a new WholePlanSnapshot created from the pending ReviewDecision.", "NEXT_WHOLE_PLAN_REQUIRED");
    }
  }

  const runId = `run-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const run = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    projectId: inspected.project.projectId,
    sessionId: inspected.state.sessionId,
    status: "active",
    goal: contract.scope,
    wholePlanId: contract.wholePlanId,
    capsuleId: contract.capsuleId,
    executionContractId: contract.executionContractId,
    startedAt: now(),
  };
  const patch = startPatch(run);
  run.sessionTransition = sessionChange({ run, inspected, kind: "start", artifactId: runId, changedAt: run.startedAt, patch });
  const operation = { projectId: run.projectId, sessionId: run.sessionId, runId, requestKeyHash, inputHash,
    patch, transition: run.sessionTransition };
  run.startOperation = { ...operation, operationHash: sessionStateHash(operation) };
  atomicCreateArtifact(runFile(projectRoot, runId, inspected.storage), json(run));
  const state = commitSessionTransition({ root: projectRoot, inspected, run, patch });
  return committedResponse(projectRoot, { status: "run_started", run: publicRun(run), state }, [path.relative(projectRoot, runFile(projectRoot, runId, inspected.storage)).replaceAll("\\", "/"), path.relative(projectRoot, stateFile(projectRoot, inspected.storage)).replaceAll("\\", "/")]);
}

export function finishRun(options = {}) {
  return withRunStorageMutation(options.root, () => {
    try { return finishRunLocked(options); }
    catch (error) { error.affectedOperation = "run-finish-storage"; error.executionReplayAllowed = false; throw error; }
  });
}

function finishRunLocked({ root = ".", outcome, evidence, planDelta = "", impactRadius = [], verification, unknowns = [], knowledgeProposals = [] } = {}) {
  const inspected = readyProject(root, "a Run finishes");
  const runId = inspected.state.activeRunId || inspected.state.pendingReview?.runId;
  if (!runId) fail("No active Run exists.", "NO_ACTIVE_RUN");
  const projectRoot = inspected.project.projectRoot;
  const file = runFile(projectRoot, runId, inspected.storage);
  let run = readJson(file, "Run canon");
  assertRunSession(projectRoot, run, inspected.state);
  if (run.sessionTransition?.kind === "review") fail("This Run already has an exact review transition; finish cannot replace it.", "RUN_TRANSITION_CONFLICT");
  if (run.runId !== runId || !["active", "awaiting_review"].includes(run.status) || !run.executionContractId) fail("Active Run canon is not bound to an Execution Contract.", "INVALID_RUN_LINEAGE");
  if (inspected.state.currentWholePlanId !== run.wholePlanId
    || inspected.state.activeRunId && inspected.state.activeExecutionContractId !== run.executionContractId
    || !inspected.state.activeRunId && (inspected.state.pendingReview?.resultPacketId !== run.resultPacketId || run.status !== "awaiting_review")) {
    fail("Session does not point to this Run transition.", "RUN_LINEAGE_CONFLICT");
  }
  const contract = requireArtifact(projectRoot, run.executionContractId, "ExecutionContract");
  if (contract.wholePlanId !== run.wholePlanId || contract.capsuleId !== run.capsuleId) {
    fail("Run canon does not match its Execution Contract.", "RUN_LINEAGE_CONFLICT");
  }
  const input = {
    root: projectRoot,
    executionContractId: run.executionContractId,
    outcome,
    evidence,
    planDelta,
    impactRadius,
    verification,
    unknowns,
    knowledgeProposals,
    persist: false,
  };
  const preview = createResultPacket(input).artifact;
  if (run.resultPacketId && run.resultPacketId !== preview.resultPacketId) fail("Run result retry differs from the recorded ResultPacket.", "RUN_TRANSITION_CONFLICT");
  const pendingReview = {
    runId,
    wholePlanId: run.wholePlanId,
    resultPacketId: preview.resultPacketId,
  };
  const patch = {
    mode: "review",
    activeRunId: null,
    activeExecutionContractId: null,
    lastResultPacketId: preview.resultPacketId,
    pendingReview,
  };
  const sessionTransition = sessionChange({ run, inspected, kind: "finish", artifactId: preview.resultPacketId, changedAt: run.completedAt || now(), patch });
  const completedRun = { ...run, sessionTransition, status: "awaiting_review", resultPacketId: preview.resultPacketId, completedAt: sessionTransition.changedAt };
  const alreadyCommitted = completedTransitionMatches(completedRun, inspected.state, patch);
  if (run.status !== "awaiting_review" || !run.sessionTransition) atomicWrite(file, json(completedRun));
  const resultPacket = createResultPacket({ ...input, persist: true }).artifact;
  const state = commitSessionTransition({ root: projectRoot, inspected, run: completedRun, patch });
  return committedResponse(projectRoot, { status: "run_awaiting_review", run: publicRun(completedRun), resultPacket, state },
    alreadyCommitted ? null : [path.relative(projectRoot, file).replaceAll("\\", "/"), relativeProjectArtifact(inspected.storage, "lineage", "result-packets", `${resultPacket.resultPacketId}.json`), path.relative(projectRoot, stateFile(projectRoot, inspected.storage)).replaceAll("\\", "/")]);
}

export function reviewRun(options = {}) {
  return withRunStorageMutation(options.root, () => {
    try { return reviewRunLocked(options); }
    catch (error) { error.affectedOperation = "run-review-storage"; error.executionReplayAllowed = false; throw error; }
  });
}

function reviewRunLocked({ root = ".", reviewContextId, disposition, rationale, nextActions = [], knowledgeProposalRecommendations = [] } = {}) {
  if (typeof reviewContextId !== "string" || !reviewContextId.trim()) {
    fail("The current Fresh HEAD review context id is required.", "FRESH_HEAD_REVIEW_REQUIRED");
  }
  const beforeRepair = readyProject(root, "a Run is reviewed");
  // Only a verified existing finish artifact can complete its missing Session
  // save. Missing results remain unknown, not inferred success/review inputs.
  if (beforeRepair.state.activeRunId) {
    const repair = reconcileLocked(beforeRepair);
    if (repair.status === "incomplete") fail("Run result evidence is missing; original finish input is required.", "RUN_TRANSITION_EVIDENCE_REQUIRED");
  }
  const inspected = readyProject(root, "a Run is reviewed");
  if (inspected.state.activeRunId) fail("The active Run must finish before review.", "RUN_STILL_ACTIVE");
  const projectRoot = inspected.project.projectRoot;
  const runId = inspected.state.pendingReview?.runId || inspected.state.lastReviewedRunId;
  if (!runId) fail("No Result Packet is awaiting review.", "NO_PENDING_REVIEW");
  const file = runFile(projectRoot, runId, inspected.storage);
  let run = readJson(file, "Run canon");
  assertRunSession(projectRoot, run, inspected.state);
  const pending = inspected.state.pendingReview || { runId, wholePlanId: run.wholePlanId, resultPacketId: run.resultPacketId };
  if (run.runId !== runId || !["awaiting_review", "reviewed"].includes(run.status)
    || run.resultPacketId !== pending.resultPacketId || run.wholePlanId !== pending.wholePlanId
    || inspected.state.currentWholePlanId !== run.wholePlanId
    || !inspected.state.pendingReview && (run.status !== "reviewed" || inspected.state.lastReviewDecisionId !== run.reviewDecisionId)) {
    fail("Pending review state does not match Run canon.", "RUN_REVIEW_CONFLICT");
  }
  const currentReview = buildFreshLodeReview({
    root: projectRoot,
    wholePlanId: pending.wholePlanId,
    resultPacketId: pending.resultPacketId,
    sessionId: inspected.state.sessionId,
    runId: pending.runId,
  }).review;
  if (currentReview.reviewContextId !== reviewContextId.trim()) {
    fail("ReviewDecision was prepared from a stale or different Fresh HEAD review context.", "STALE_FRESH_HEAD_REVIEW");
  }
  const input = {
    root: projectRoot,
    wholePlanId: pending.wholePlanId,
    resultPacketId: pending.resultPacketId,
    reviewContext: currentReview,
    disposition,
    rationale,
    nextActions,
    knowledgeProposalRecommendations,
    persist: false,
  };
  const preview = createReviewDecision(input).artifact;
  if (run.reviewDecisionId && run.reviewDecisionId !== preview.reviewDecisionId) fail("Run review retry differs from the recorded ReviewDecision.", "RUN_TRANSITION_CONFLICT");
  if (run.status === "reviewed" && run.reviewDisposition !== preview.disposition) fail("Run disposition differs from its exact ReviewDecision.", "RUN_TRANSITION_CONFLICT");
  const requiredPlanAction = preview.disposition === "accept"
    ? null
    : new Set(["revise", "expand"]).has(preview.disposition)
      ? {
          kind: "next-whole-plan",
          disposition: preview.disposition,
          wholePlanId: pending.wholePlanId,
          reviewDecisionId: preview.reviewDecisionId,
        }
      : {
          kind: "user-direction",
          disposition: preview.disposition,
          wholePlanId: pending.wholePlanId,
          reviewDecisionId: preview.reviewDecisionId,
        };
  const patch = {
    mode: "session",
    pendingReview: null,
    lastReviewDecisionId: preview.reviewDecisionId,
    lastReviewedRunId: runId,
    requiredPlanAction,
  };
  const sessionTransition = sessionChange({ run, inspected, kind: "review", artifactId: preview.reviewDecisionId, changedAt: run.reviewedAt || now(), patch });
  const reviewedRun = { ...run, sessionTransition, status: "reviewed", reviewDecisionId: preview.reviewDecisionId, reviewDisposition: preview.disposition, reviewedAt: sessionTransition.changedAt };
  const alreadyCommitted = completedTransitionMatches(reviewedRun, inspected.state, patch);
  if (run.status !== "reviewed" || run.sessionTransition?.kind !== "review") atomicWrite(file, json(reviewedRun));
  const reviewDecision = createReviewDecision({ ...input, persist: true }).artifact;
  const state = commitSessionTransition({ root: projectRoot, inspected, run: reviewedRun, patch });
  return committedResponse(projectRoot, { status: "run_reviewed", run: publicRun(reviewedRun), reviewDecision, state },
    alreadyCommitted ? null : [path.relative(projectRoot, file).replaceAll("\\", "/"), relativeProjectArtifact(inspected.storage, "lineage", "review-decisions", `${reviewDecision.reviewDecisionId}.json`), path.relative(projectRoot, stateFile(projectRoot, inspected.storage)).replaceAll("\\", "/")]);
}

// Internal historical-reader composition: validate original lineage and
// transition structure without treating a later Session pointer as corruption
// or repairing P2. Used by the explicit snapshot collector only.
export function verifyRetainedRunOriginal({ root, run, storage }) {
  if (!run || run.schemaVersion !== 1 || !["active", "awaiting_review", "reviewed"].includes(run.status)) fail("Retained Run schema is unsupported.", "INVALID_RUN_CANON");
  const ownerId = run.sessionId || readJson(defaultSessionStatePath(root, storage), "Default Session owner").sessionId;
  return withSessionRoute(root, ownerId, () => {
    const inspected = readyProject(root, "retained Run lineage is read");
    verifyRunLineage(root, run, inspected);
    verifyStartOperation(root, run, inspected);
    const transition = inspectTransition(inspected, run);
    if (transition.transition?.artifactStatus === "missing-evidence") fail("Retained Run transition original is missing.", "RUN_LINEAGE_CONFLICT");
    if (run.resultPacketId) requireArtifact(root, run.resultPacketId, "ResultPacket");
    if (run.reviewDecisionId) requireArtifact(root, run.reviewDecisionId, "ReviewDecision");
    return run;
  });
}

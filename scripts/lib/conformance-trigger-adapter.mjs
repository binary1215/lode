import path from "node:path";
import { inspectProject } from "./lode-core.mjs";
import { artifactAuthorityBoundary } from "./authority-plane-contract.mjs";
import { readChangeSet } from "./change-set.mjs";
import { readObservation } from "./observation-store.mjs";
import { readIncrementalRefreshReceipt } from "./incremental-refresh.mjs";
import { loadReleaseObservationProjection } from "./release-observation-projection.mjs";
import { conformanceCanonicalJson, conformanceDigest } from "./conformance-contract.mjs";
import { prepareConformanceAssessment } from "./conformance-reconciliation.mjs";

export const CONFORMANCE_TRIGGER_ADAPTER_VERSION = "0.1.0";
export const CONFORMANCE_TRIGGER_KINDS = Object.freeze(["change-set", "observation", "release-observation", "refresh-receipt"]);
const MAX_TRIGGER_PAGE = 64;
const fail = (message, code = "CONFORMANCE_TRIGGER_ERROR") => { const error = new Error(message); error.code = code; throw error; };

function coalescedRefreshCount(items) {
  return items.reduce((count, item) => count + (item.kind === "refresh-receipt" ? item.coalescedRefreshCount || 0 : 0), 0);
}

function readyProject(root) {
  const inspected = inspectProject(root);
  if (inspected.status !== "ready") fail(`Project must be ready for Conformance Host trigger use; current status: ${inspected.status}.`, "PROJECT_NOT_READY");
  return inspected;
}

function key(value, label, max = 192) {
  if (typeof value !== "string" || !value || value.length > max || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) fail(`${label} is invalid.`, "INVALID_CONFORMANCE_TRIGGER");
  return value;
}

function bindingIdentity({ projectId, sourceKey, triggerKinds, mode, providerAssessmentEnabled }) {
  const hash = conformanceDigest(conformanceCanonicalJson({ projectId, sourceKey, triggerKinds, mode, providerAssessmentEnabled, adapterVersion: CONFORMANCE_TRIGGER_ADAPTER_VERSION }));
  return { sourceId: `conformance-trigger-source-${hash.slice(0, 24)}`, bindingHash: hash };
}

async function verifyTriggerArtifact(projectRoot, projectId, trigger, storage) {
  const kind = key(trigger?.kind, "Conformance trigger kind", 32);
  if (!CONFORMANCE_TRIGGER_KINDS.includes(kind)) fail("Conformance trigger kind is unsupported.", "INVALID_CONFORMANCE_TRIGGER");
  const artifactId = key(trigger?.artifactId, "Conformance trigger artifactId", 128);
  let artifactHash;
  if (kind === "change-set") {
    const artifact = readChangeSet({ root: projectRoot, changeSetId: artifactId }).changeSet;
    artifactHash = artifact.changeSetHash;
  } else if (kind === "observation") {
    const artifact = readObservation({ root: projectRoot, observationId: artifactId }).observation;
    artifactHash = artifact.observationHash || artifact.derivedObservationHash;
  } else if (kind === "refresh-receipt") {
    const artifact = (await readIncrementalRefreshReceipt({ root: projectRoot, refreshReceiptId: artifactId })).receipt;
    artifactHash = artifact.refreshReceiptHash;
  } else {
    const projection = loadReleaseObservationProjection({ projectRoot, projectId, storage });
    const artifact = projection.releases.find((item) => item.releaseObservationId === artifactId);
    if (!artifact) fail("Conformance release trigger artifact is missing.", "CONFORMANCE_TRIGGER_ARTIFACT_NOT_FOUND");
    artifactHash = artifact.releaseObservationHash;
  }
  if (trigger.artifactHash && trigger.artifactHash !== artifactHash) fail("Conformance trigger artifact digest changed.", "CONFORMANCE_TRIGGER_ARTIFACT_DRIFT");
  return { kind, artifactId, artifactHash };
}

export class ConformanceTriggerRegistry {
  constructor() { this.sources = new Map(); }

  register({ root, sourceKey, triggerKinds = CONFORMANCE_TRIGGER_KINDS, mode = "opportunistic", providerAssessmentEnabled = false, confirmUserMonitorOptIn = false } = {}) {
    const inspected = readyProject(root);
    const normalizedSourceKey = key(sourceKey, "Conformance trigger sourceKey");
    if (!Array.isArray(triggerKinds) || !triggerKinds.length || triggerKinds.some((kind) => !CONFORMANCE_TRIGGER_KINDS.includes(kind)) || new Set(triggerKinds).size !== triggerKinds.length) fail("Conformance trigger kinds are invalid.", "INVALID_CONFORMANCE_TRIGGER_BINDING");
    const normalizedKinds = [...triggerKinds].sort();
    if (!new Set(["opportunistic", "monitor"]).has(mode)) fail("Conformance trigger mode is invalid.", "INVALID_CONFORMANCE_TRIGGER_BINDING");
    if (mode === "monitor" && confirmUserMonitorOptIn !== true) fail("Background Conformance monitor mode requires explicit user opt-in.", "CONFORMANCE_MONITOR_OPT_IN_REQUIRED");
    if (typeof providerAssessmentEnabled !== "boolean" || providerAssessmentEnabled && mode !== "monitor") fail("Automatic provider assessment is available only in explicit monitor mode.", "INVALID_CONFORMANCE_TRIGGER_BINDING");
    const identity = bindingIdentity({ projectId: inspected.project.projectId, sourceKey: normalizedSourceKey, triggerKinds: normalizedKinds, mode, providerAssessmentEnabled });
    if (this.sources.has(identity.sourceId)) return this.describeSource(this.sources.get(identity.sourceId));
    const source = { ...identity, projectRoot: inspected.project.projectRoot, projectId: inspected.project.projectId, storage: inspected.storage, sourceKey: normalizedSourceKey, triggerKinds: normalizedKinds, mode, providerAssessmentEnabled, queue: [], pendingBatch: null, uncertainAssessment: false };
    this.sources.set(identity.sourceId, source);
    return this.describeSource(source);
  }

  describeSource(source) {
    const queuedCoalescedRefreshCount = coalescedRefreshCount(source.queue);
    const pendingCoalescedRefreshCount = source.pendingBatch?.coalescedRefreshCount || 0;
    return {
      sourceId: source.sourceId,
      bindingHash: source.bindingHash,
      projectId: source.projectId,
      triggerKinds: source.triggerKinds,
      mode: source.mode,
      providerAssessmentEnabled: source.providerAssessmentEnabled,
      queuedTriggerCount: source.queue.length,
      pendingBatchId: source.pendingBatch?.batchId || null,
      coalescedRefreshCount: queuedCoalescedRefreshCount + pendingCoalescedRefreshCount,
      queuedCoalescedRefreshCount,
      pendingCoalescedRefreshCount,
      uncertainAssessment: source.uncertainAssessment,
      stateLocation: "host-local-process-memory",
      credentialsPersisted: false,
      providerIdentityPersisted: false,
      projectPathPersisted: false,
      authority: "P5-operational-trigger-binding",
      authorityBoundary: artifactAuthorityBoundary("ConformanceTriggerBinding"),
      semanticAuthority: false,
      ordinaryWorkBlocked: false,
    };
  }

  source(root, sourceId) {
    const inspected = readyProject(root);
    const source = this.sources.get(sourceId);
    if (!source) fail("Conformance trigger source is not configured.", "CONFORMANCE_TRIGGER_SOURCE_NOT_FOUND");
    if (source.projectId !== inspected.project.projectId || path.resolve(source.projectRoot) !== inspected.project.projectRoot) fail("Conformance trigger source belongs to another Project.", "CONFORMANCE_TRIGGER_PROJECT_MISMATCH");
    source.storage = inspected.storage;
    return source;
  }

  async enqueue({ root, sourceId, trigger } = {}) {
    const source = this.source(root, sourceId);
    const verified = (await verifyTriggerArtifact(source.projectRoot, source.projectId, trigger, source.storage));
    if (!source.triggerKinds.includes(verified.kind)) fail("Conformance trigger kind is outside this Host binding.", "CONFORMANCE_TRIGGER_KIND_NOT_BOUND");
    const exactId = `${verified.kind}:${verified.artifactId}:${verified.artifactHash}`;
    if (source.queue.some((item) => item.exactId === exactId)
      || source.pendingBatch?.triggers.some((item) => `${item.kind}:${item.artifactId}:${item.artifactHash}` === exactId)) return { status: "existing", source: this.describeSource(source), trigger: verified };
    let triggerCoalescedRefreshCount = 0;
    if (verified.kind === "refresh-receipt") {
      const removed = source.queue.filter((item) => item.kind === "refresh-receipt");
      triggerCoalescedRefreshCount = removed.reduce((count, item) => count + 1 + (item.coalescedRefreshCount || 0), 0);
      source.queue = source.queue.filter((item) => item.kind !== "refresh-receipt");
    }
    source.queue.push({ ...verified, exactId, coalescedRefreshCount: triggerCoalescedRefreshCount });
    source.queue.sort((a, b) => a.exactId.localeCompare(b.exactId));
    return { status: "queued", source: this.describeSource(source), trigger: verified };
  }

  inspect({ root, sourceId } = {}) {
    const source = this.source(root, sourceId);
    return { status: "configured", source: this.describeSource(source), nextAction: source.queue.length ? "prepare-bounded-assessment" : "continue-ordinary-work", authority: "P5-status-only" };
  }

  async prepare({ root, sourceId, limit = MAX_TRIGGER_PAGE } = {}) {
    const source = this.source(root, sourceId);
    const boundedLimit = Number(limit);
    if (!Number.isInteger(boundedLimit) || boundedLimit < 1 || boundedLimit > MAX_TRIGGER_PAGE) fail(`Conformance trigger page must be between 1 and ${MAX_TRIGGER_PAGE}.`, "INVALID_CONFORMANCE_TRIGGER_LIMIT");
    if (source.uncertainAssessment) fail("A prior provider assessment has an uncertain outcome and will not be replayed automatically.", "CONFORMANCE_TRIGGER_ASSESSMENT_UNCERTAIN");
    if (source.pendingBatch) return source.pendingBatch;
    if (!source.queue.length) return { status: "idle", source: this.describeSource(source), nextAction: "continue-ordinary-work", ordinaryWorkBlocked: false, authority: "P5-status-only" };
    const triggers = source.queue.slice(0, boundedLimit);
    const remainingTriggers = source.queue.slice(triggers.length);
    const preparation = (await prepareConformanceAssessment({ root: source.projectRoot, limit: 32 }));
    const batchCoalescedRefreshCount = coalescedRefreshCount(triggers);
    const payload = { projectId: source.projectId, sourceId: source.sourceId, bindingHash: source.bindingHash, triggerIds: triggers.map((item) => item.exactId), preparationId: preparation.projectionId, coalescedRefreshCount: batchCoalescedRefreshCount };
    const batchHash = conformanceDigest(conformanceCanonicalJson(payload));
    const batch = {
      schemaVersion: 1,
      kind: "ConformanceTriggerBatchProjection",
      batchId: `conformance-trigger-batch-${batchHash.slice(0, 24)}`,
      batchHash,
      projectId: source.projectId,
      sourceId: source.sourceId,
      triggers: triggers.map((item) => ({ kind: item.kind, artifactId: item.artifactId, artifactHash: item.artifactHash })),
      coalescedRefreshCount: batchCoalescedRefreshCount,
      remainingTriggerCount: remainingTriggers.length,
      preparation,
      providerAssessment: { enabled: source.providerAssessmentEnabled, executionOwnedByHost: true, automaticReplayAfterUncertainOutcome: false },
      authority: "non-persisted-P4-trigger-preparation-over-P5-host-state",
      authorityBoundary: artifactAuthorityBoundary("ConformanceTriggerBatchProjection"),
      instructionAuthority: false,
      promotionAuthority: false,
      recoveryAuthority: false,
      ordinaryWorkBlocked: false,
    };
    source.queue = remainingTriggers;
    source.pendingBatch = batch;
    return batch;
  }

  markAssessmentUncertain({ root, sourceId } = {}) {
    const source = this.source(root, sourceId);
    if (!source.pendingBatch) fail("No prepared Conformance assessment is pending.", "CONFORMANCE_TRIGGER_BATCH_NOT_FOUND");
    source.uncertainAssessment = true;
    return this.inspect({ root, sourceId });
  }

  completeAssessment({ root, sourceId, batchId } = {}) {
    const source = this.source(root, sourceId);
    if (!source.pendingBatch || source.pendingBatch.batchId !== batchId) fail("Conformance trigger batch is not the exact pending batch.", "CONFORMANCE_TRIGGER_BATCH_NOT_FOUND");
    if (source.uncertainAssessment) fail("An uncertain Conformance assessment cannot be completed before an explicit user retry decision.", "CONFORMANCE_TRIGGER_ASSESSMENT_UNCERTAIN");
    source.pendingBatch = null;
    source.uncertainAssessment = false;
    return this.inspect({ root, sourceId });
  }

  clearUncertainAfterUserDecision({ root, sourceId, confirmUserRetryDecision = false } = {}) {
    if (confirmUserRetryDecision !== true) fail("Clearing an uncertain assessment requires an explicit user retry decision.", "CONFORMANCE_TRIGGER_RETRY_CONFIRMATION_REQUIRED");
    const source = this.source(root, sourceId);
    if (!source.pendingBatch || !source.uncertainAssessment) fail("No uncertain Conformance assessment is pending.", "CONFORMANCE_TRIGGER_BATCH_NOT_FOUND");
    source.uncertainAssessment = false;
    return this.inspect({ root, sourceId });
  }
}

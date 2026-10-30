import crypto from "node:crypto";

import { formatForVerifiedOwner } from "./project-storage-format.mjs";

export const AUTHORITY_PLANE_CONTRACT_VERSION = "0.9.0";

const fail = (message, code = "AUTHORITY_PLANE_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

const canonicalJson = (value) => JSON.stringify(canonical(value));
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

const PLANE_DEFINITIONS = Object.freeze({
  P1: Object.freeze({
    name: "normative-authority",
    owns: "approved product meaning, policy, and explicit review decisions",
    mayAuthorizeCanonMutation: true,
    rebuildable: false,
  }),
  P2: Object.freeze({
    name: "canonical-recovery-lineage-record",
    owns: "provider-independent project, session, run, plan, context, contract, and checkpoint recovery",
    mayAuthorizeCanonMutation: false,
    rebuildable: false,
  }),
  P3: Object.freeze({
    name: "evidence-record",
    owns: "results, observations, candidates, claims, and audit receipts awaiting interpretation or review",
    mayAuthorizeCanonMutation: false,
    rebuildable: false,
  }),
  P4: Object.freeze({
    name: "derived-relation-view",
    owns: "rebuildable indexes, graph materializations, traversals, and human-facing projections",
    mayAuthorizeCanonMutation: false,
    rebuildable: true,
  }),
  P5: Object.freeze({
    name: "operational-effect",
    owns: "host-local process, delivery, endpoint, lease, token, proof, and provider-session effects",
    mayAuthorizeCanonMutation: false,
    rebuildable: false,
  }),
});

const ARTIFACT_PLANES = Object.freeze({
  ProductCanon: "P1",
  ProductModel: "P1",
  ProductModelRevision: "P1",
  PolicyCanon: "P1",
  ReviewedPolicy: "P1",
  ProductCanonFeature: "P1",
  ReviewedFeature: "P1",
  ReviewDecision: "P1",
  DocumentChangeReviewDecision: "P1",

  Project: "P2",
  ProjectDirection: "P2",
  HeadSession: "P2",
  Run: "P2",
  WholePlanSnapshot: "P2",
  ContextCapsule: "P2",
  ExecutionContract: "P2",
  SessionRunCheckpoint: "P2",

  ResultPacket: "P3",
  WorkerReport: "P3",
  CandidateSet: "P3",
  FeatureCandidate: "P3",
  ProductFeatureCandidate: "P3",
  PolicyCandidate: "P3",
  Evidence: "P3",
  Claim: "P3",
  Unknown: "P3",
  DocumentCanonApplicationReceipt: "P3",
  RunResultIntegrationRequest: "P3",
  RunResultIntegrationReceipt: "P3",
  BoundedWorkerDispatch: "P3",
  BoundedWorkerWave: "P3",
  BoundedWorkerWaveSeal: "P3",
  BoundedWorkerWaveAbandonment: "P3",
  WorkerPatchIntegrationIntent: "P3",
  WorkerIntegrationEffectClaim: "P3",
  WorkerIntegrationEffectAttempt: "P3",
  WorkerIntegrationEffectReceipt: "P3",
  WorkerIntegrationIncompleteSettlement: "P3",
  WorkerIntegrationVerification: "P3",
  WorkerIntegrationResultApplication: "P3",
  ObservationTypeDescriptor: "P3",
  ObservationRecord: "P3",
  DerivedObservationRecord: "P3",
  ObservationCollectionReceipt: "P3",
  SourceCollectionFailure: "P3",
  ConformanceFindingCandidate: "P3",
  ConformanceDispositionReceipt: "P3",
  ConformanceResolutionCandidate: "P3",

  GraphSnapshot: "P4",
  ProjectGraphDiscoveryProjection: "P4",
  ProjectGraphRecordIndex: "P4",
  GraphDBProjection: "P4",
  TraversalResult: "P4",
  DocumentProjection: "P4",
  MarkdownProjection: "P4",
  HEADContinuitySnapshot: "P4",
  SessionRestoreProjection: "P4",
  WorkerWaveStatusProjection: "P4",
  WorkerWaveResultProjection: "P4",
  ObservationStatusProjection: "P4",
  ObservationSourceDiscoveryProjection: "P4",
  ObservationPreparationProjection: "P4",
  SourceContextResult: "P4",
  ConformancePreparationProjection: "P4",
  ConformanceQueueProjection: "P4",
  ConformanceTriggerBatchProjection: "P4",
  ConformanceFindingGraphProjection: "P4",

  ProcessId: "P5",
  ControlToken: "P5",
  ProcessProof: "P5",
  LeaseLock: "P5",
  EndpointTarget: "P5",
  CoordinationInbox: "P5",
  DeliveryReceipt: "P5",
  ProviderSessionReference: "P5",
  ContinuationOutcome: "P5",
  BoundedWorkerWaitOutcome: "P5",
  BoundedWorkerWaveWaitOutcome: "P5",
  ObservationSourceBinding: "P5",
  ConformanceTriggerBinding: "P5",
});

const ARTIFACT_PLANES_V01 = Object.freeze({
  ProductCanon: "P1",
  ProductModel: "P1",
  ProductModelRevision: "P1",
  Policy: "P1",
  Feature: "P1",
  ReviewDecision: "P1",
  DocumentChangeReviewDecision: "P1",
  Project: "P2",
  HeadSession: "P2",
  Run: "P2",
  WholePlanSnapshot: "P2",
  ContextCapsule: "P2",
  ExecutionContract: "P2",
  SessionRunCheckpoint: "P2",
  ResultPacket: "P3",
  WorkerReport: "P3",
  CandidateSet: "P3",
  Evidence: "P3",
  Claim: "P3",
  Unknown: "P3",
  DocumentCanonApplicationReceipt: "P3",
  GraphSnapshot: "P4",
  GraphDBProjection: "P4",
  TraversalResult: "P4",
  DocumentProjection: "P4",
  MarkdownProjection: "P4",
  HEADContinuitySnapshot: "P4",
  ProcessId: "P5",
  ControlToken: "P5",
  ProcessProof: "P5",
  LeaseLock: "P5",
  EndpointTarget: "P5",
  CoordinationInbox: "P5",
  DeliveryReceipt: "P5",
  ProviderSessionReference: "P5",
});

function boundaryPayload(kind, contractVersion = AUTHORITY_PLANE_CONTRACT_VERSION) {
  const artifactPlanes = contractVersion === "0.1.0" ? ARTIFACT_PLANES_V01 : ARTIFACT_PLANES;
  const planeId = artifactPlanes[kind] || ({ LodeSession: "P2", LodeContinuitySnapshot: "P4" })[kind];
  if (!planeId) fail(`Artifact kind is not assigned to an authority plane: ${kind}`, "UNKNOWN_AUTHORITY_PLANE_ARTIFACT");
  const plane = PLANE_DEFINITIONS[planeId];
  return {
    contractVersion,
    artifactKind: kind,
    planeId,
    plane: plane.name,
    normativeAuthority: planeId === "P1",
    recoveryAuthority: planeId === "P2",
    evidenceAuthority: planeId === "P3",
    derived: planeId === "P4",
    operationalOnly: planeId === "P5",
    instructionAuthority: false,
    promotionAuthority: false,
    uniqueAuthority: false,
    rebuildable: plane.rebuildable,
  };
}

export function artifactAuthorityBoundary(kind) {
  return Object.freeze(boundaryPayload(kind));
}

export function verifyArtifactAuthorityBoundary(kind, boundary) {
  const contractVersion = boundary?.contractVersion;
  if (!new Set(["0.1.0", "0.2.0", "0.3.0", "0.4.0", "0.5.0", "0.6.0", "0.7.0", "0.8.0", AUTHORITY_PLANE_CONTRACT_VERSION]).has(contractVersion)) {
    fail(`${kind} authority-plane contract version is invalid.`, "INVALID_ARTIFACT_AUTHORITY_BOUNDARY");
  }
  const expected = boundaryPayload(kind, contractVersion);
  if (canonicalJson(boundary) !== canonicalJson(expected)) {
    fail(`${kind} authority-plane boundary is invalid.`, "INVALID_ARTIFACT_AUTHORITY_BOUNDARY");
  }
  return boundary;
}

export function authorityPlaneContract(storage = undefined) {
  const format = formatForVerifiedOwner(storage);
  const payload = {
    kind: "AuthorityPlaneContract",
    protocol: { name: format.protocol("head-agent-core-authority-plane-contract"), version: AUTHORITY_PLANE_CONTRACT_VERSION },
    semanticPlanes: PLANE_DEFINITIONS,
    artifactPlanes: Object.fromEntries(Object.entries(ARTIFACT_PLANES).map(([kind, plane]) => [format.kind(kind), plane])),
    architecturalPlanes: {
      Distribution: "packages and transports the same contracts without becoming a meaning authority",
      Host: "executes provider-neutral operational effects without becoming a meaning or recovery authority",
    },
    invariants: [
      "authority-does-not-amplify-upward-without-an-explicit-verified-review-decision",
      "evidence-derived-and-operational-planes-cannot-be-promoted-into-recovery-authority",
      "result-packets-and-worker-reports-are-evidence-not-recovery-canon",
      "session-run-checkpoints-remain-sufficient-after-evidence-artifact-deletion",
      "graph-snapshots-and-graphdb-are-rebuildable-derived-indexes-not-product-semantic-canon",
      "projection-writes-cannot-change-product-canon-bytes",
      "a-receipt-cannot-appear-in-the-graph-snapshot-that-the-receipt-names",
      "provider-summary-mail-inbox-reply-and-continuity-views-cannot-rewrite-checkpoint-fields",
      "observation-descriptors-records-receipts-and-derived-views-cannot-assert-product-meaning-or-rewrite-p1-p2",
      "conformance-findings-dispositions-resolutions-queues-and-host-triggers-cannot-authorize-execution-mutate-canon-write-recovery-or-block-ordinary-work",
    ],
  };
  const contractHash = digest(canonicalJson(payload));
  return Object.freeze({
    ...payload,
    contractId: `authority-plane-contract-${contractHash.slice(0, 24)}`,
    contractHash,
  });
}

export function assertNoAuthorityAmplification({ sourceKind, targetKind, reviewDecision = null, effect = "" } = {}) {
  const source = artifactAuthorityBoundary(sourceKind);
  const target = artifactAuthorityBoundary(targetKind);
  if (target.planeId === "P1" && source.planeId !== "P1") {
    const reviewDecisionId = reviewDecision?.reviewDecisionId;
    if (reviewDecision?.kind !== "ReviewDecision" || reviewDecision?.promotionAuthority !== true
      || !/^(?:review-decision|document-change-review-decision)-[a-f0-9]{24}$/.test(reviewDecisionId || "")) {
      fail(`Authority amplification from ${sourceKind} to ${targetKind} requires an explicit verified ReviewDecision.`, "AUTHORITY_AMPLIFICATION_REJECTED");
    }
    verifyArtifactAuthorityBoundary("ReviewDecision", reviewDecision.authorityBoundary);
  }
  if (target.planeId === "P2" && new Set(["P3", "P4", "P5"]).has(source.planeId)) {
    fail(`Recovery authority cannot be amplified from ${sourceKind} into ${targetKind}.`, "RECOVERY_AUTHORITY_AMPLIFICATION_REJECTED");
  }
  return Object.freeze({
    status: "authority-boundary-preserved",
    sourceKind,
    sourcePlaneId: source.planeId,
    targetKind,
    targetPlaneId: target.planeId,
    effect: typeof effect === "string" ? effect : "",
    reviewDecisionRequired: target.planeId === "P1" && source.planeId !== "P1",
  });
}

export function assertProjectionDidNotMutateCanon({ beforeBytes, afterBytes } = {}) {
  if ((beforeBytes !== null && !Buffer.isBuffer(beforeBytes)) || (afterBytes !== null && !Buffer.isBuffer(afterBytes))) {
    fail("Projection Canon fence requires exact before and after bytes.", "INVALID_CANON_MUTATION_FENCE");
  }
  if (beforeBytes === null || afterBytes === null ? beforeBytes !== afterBytes : !beforeBytes.equals(afterBytes)) {
    fail("A derived projection attempted to change Product Canon bytes.", "GRAPH_PROJECTION_AUTHORITY_AMPLIFICATION");
  }
  return true;
}

export function assertReceiptProjectedOnlyInChild({ receiptId, namedGraphSnapshotId, namedGraphReceiptIds, childGraphSnapshotId, childParentSourceSnapshotIds, namedSourceSnapshotId, childGraphReceiptIds } = {}) {
  if (typeof receiptId !== "string" || !receiptId || typeof namedGraphSnapshotId !== "string" || !namedGraphSnapshotId
    || typeof childGraphSnapshotId !== "string" || !childGraphSnapshotId || typeof namedSourceSnapshotId !== "string" || !namedSourceSnapshotId
    || !Array.isArray(namedGraphReceiptIds) || !Array.isArray(childParentSourceSnapshotIds) || !Array.isArray(childGraphReceiptIds)) {
    fail("Receipt child-projection proof is incomplete.", "INVALID_RECEIPT_CHILD_PROJECTION_PROOF");
  }
  if (namedGraphReceiptIds.includes(receiptId)) {
    fail("A receipt cannot appear in the GraphSnapshot that it names.", "GRAPH_SNAPSHOT_RECEIPT_SELF_REFERENCE");
  }
  if (childGraphSnapshotId === namedGraphSnapshotId || !childParentSourceSnapshotIds.includes(namedSourceSnapshotId)
    || !childGraphReceiptIds.includes(receiptId)) {
    fail("A receipt must appear only in a later child GraphSnapshot.", "GRAPH_SNAPSHOT_RECEIPT_CHILD_REQUIRED");
  }
  return true;
}

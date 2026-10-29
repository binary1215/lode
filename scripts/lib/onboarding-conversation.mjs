import { inspectProject } from "./head-core.mjs";
import { inspectOptionalOnboarding } from "./onboarding.mjs";
import { inspectWorldGraphProjection, inspectWorldMarkdownProjection } from "./world-model.mjs";

export const ONBOARDING_CONVERSATION_PROTOCOL_VERSION = "0.1.0";

const fail = (message, code = "ONBOARDING_CONVERSATION_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

function boundedLimit(value) {
  const limit = value == null ? 25 : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    fail("candidateLimit must be an integer from 1 through 200.", "INVALID_ONBOARDING_CONVERSATION_LIMIT");
  }
  return limit;
}

function compactCandidateSet(candidateSet, limit) {
  if (!candidateSet) return {
    candidateSetId: null,
    candidateCount: 0,
    returnedCandidateCount: 0,
    truncated: false,
    candidates: [],
    unknownCount: 0,
    unknowns: [],
  };
  const evidenceById = new Map(candidateSet.evidence.map((record) => [record.evidenceId, record]));
  const candidates = candidateSet.candidates.slice(0, limit).map((candidate) => {
    const evidence = candidate.evidenceIds.slice(0, 3).map((evidenceId) => evidenceById.get(evidenceId)).filter(Boolean)
      .map((record) => ({
        evidenceId: record.evidenceId,
        sourceKind: record.sourceKind,
        path: record.path || "",
        line: record.line || null,
        statement: record.statement,
      }));
    return {
      candidateId: candidate.candidateId,
      productKind: candidate.productKind,
      key: candidate.proposedEntity.key,
      name: candidate.proposedEntity.name,
      description: candidate.proposedEntity.description,
      confidence: candidate.confidence,
      origin: candidate.origin,
      explanation: candidate.explanation,
      evidence,
      omittedEvidenceCount: Math.max(0, candidate.evidenceIds.length - evidence.length),
      authority: "candidate-only-until-explicit-review",
    };
  });
  return {
    candidateSetId: candidateSet.candidateSetId,
    candidateCount: candidateSet.candidates.length,
    returnedCandidateCount: candidates.length,
    truncated: candidates.length < candidateSet.candidates.length,
    candidates,
    unknownCount: candidateSet.unknowns.length,
    unknowns: candidateSet.unknowns.slice(0, 10).map((unknown) => ({
      unknownId: unknown.unknownId,
      statement: unknown.statement,
      status: unknown.status,
    })),
  };
}

function actionFor({ status, world, graph, documents }) {
  if (["not_initialized", "promotion_recovery_pending", "review_recovery_pending"].includes(status)) return "initialize_or_resume";
  if (new Set(["migration_required", "initialized", "awaiting_evidence", "rejected"]).has(status)) return "initialize_or_resume";
  if (status === "ready_world_changed" || world?.status !== "current"
    || (new Set(["awaiting_review", "revision_required"]).has(status) && world.matchesCandidateSource === false)) return "refresh_or_reconcile_world";
  if (new Set(["awaiting_review", "revision_required"]).has(status)) return "review_candidates";
  if (graph?.status !== "current") return "verify_graph_projection";
  if (documents?.status !== "current") return "build_document_projection";
  if (status === "ready") return "ready";
  return "inspect_state";
}

function choicesFor(status) {
  if (status === "not_initialized") return ["project_mode", "source_scope", "storage_mode", "runtimes"];
  if (new Set(["awaiting_review", "revision_required"]).has(status)) return ["review_disposition"];
  if (status === "awaiting_evidence") return ["fresh_head_semantic_proposal_or_user_brief"];
  return [];
}

async function optionalProjection(read) {
  try { return await read(); }
  catch (error) {
    if (!/^(?:INVALID_)?(?:GRAPH_|DOCUMENT_|PUBLISHED_|ARCADEDB|WORLD_MODEL|TEMPORAL_)/.test(error.code || "")
      && !["ENOENT", "EACCES", "EPERM", "EISDIR"].includes(error.code)) throw error;
    return { status: "integrity_attention", reasonCode: error.code };
  }
}

export async function inspectConversationalOnboarding({ root = ".", candidateLimit = 25 } = {}) {
  const limit = boundedLimit(candidateLimit);
  const project = inspectProject(root);
  if (project.status === "not_initialized") return {
    schemaVersion: 1,
    kind: "ConversationalOnboardingProjection",
    protocolVersion: ONBOARDING_CONVERSATION_PROTOCOL_VERSION,
    status: "not_initialized",
    nextAction: "initialize_or_resume",
    materialChoicesRequired: choicesFor("not_initialized"),
    defaults: { projectMode: "existing", storageMode: "local", runtimes: ["claude", "codex", "opencode"] },
    project: { projectId: null, sessionId: null },
    storage: { mode: "unselected", graphdbConfigured: false, credentialValuesPersisted: false },
    review: compactCandidateSet(null, limit),
    readiness: { world: "missing", graph: "missing", documents: "missing" },
    authority: {
      productCanon: "user-owned-project-canon",
      conversationProjection: "non-authoritative-guidance",
      graph: "rebuildable-derived-evidence",
    },
  };

  const onboarding = (await inspectOptionalOnboarding({ root }));
  if (onboarding.status === "integrity_attention") return {
    schemaVersion: 1, kind: "ConversationalOnboardingProjection",
    protocolVersion: ONBOARDING_CONVERSATION_PROTOCOL_VERSION,
    status: onboarding.status, reasonCode: onboarding.reasonCode,
    nextAction: "inspect_product_governance", materialChoicesRequired: [],
    ordinaryWorkBlocked: false, userReviewRequired: false,
    project: { projectId: project.project.projectId, sessionId: project.state.sessionId },
    review: { candidateCount: null, candidates: [], verification: "unverified" },
    readiness: { world: "unverified", graph: "unverified", documents: "unverified" },
    authority: { conversationProjection: "non-authoritative-guidance" },
  };
  if (onboarding.status === "migration_required") return {
    schemaVersion: 1,
    kind: "ConversationalOnboardingProjection",
    protocolVersion: ONBOARDING_CONVERSATION_PROTOCOL_VERSION,
    status: onboarding.status,
    nextAction: "initialize_or_resume",
    materialChoicesRequired: [],
    project: { projectId: onboarding.projectId, sessionId: onboarding.sessionId },
    storage: { mode: "migration-required", graphdbConfigured: false, credentialValuesPersisted: false },
    review: compactCandidateSet(null, limit),
    readiness: { world: "missing", graph: "missing", documents: "missing" },
    authority: {
      productCanon: "user-owned-project-canon",
      conversationProjection: "non-authoritative-guidance",
      graph: "rebuildable-derived-evidence",
    },
  };

  const availableWorld = onboarding.worldModel && onboarding.worldModel.status !== "unavailable";
  const graph = availableWorld ? (await optionalProjection(async () => (await inspectWorldGraphProjection({ root })))) : null;
  const documents = availableWorld ? (await optionalProjection(async () => (await inspectWorldMarkdownProjection({ root })))) : null;
  const nextAction = actionFor({ status: onboarding.status, world: onboarding.worldModel, graph, documents });
  return {
    schemaVersion: 1,
    kind: "ConversationalOnboardingProjection",
    protocolVersion: ONBOARDING_CONVERSATION_PROTOCOL_VERSION,
    status: onboarding.status,
    phase: onboarding.state.phase,
    nextAction,
    materialChoicesRequired: nextAction === "refresh_or_reconcile_world" ? [] : choicesFor(onboarding.status),
    project: {
      projectId: onboarding.sessionRecord.projectId,
      sessionId: onboarding.sessionRecord.sessionId,
      stateRevision: onboarding.state.stateRevision,
    },
    storage: {
      mode: onboarding.storageSelection.mode,
      graphdbConfigured: onboarding.storageSelection.mode === "graphdb",
      capabilityStatus: onboarding.storageSelection.graphdb?.capabilityStatus || "local-complete",
      localFallback: onboarding.storageSelection.localFallback,
      credentialValuesPersisted: false,
    },
    review: compactCandidateSet(["promotion_recovery_pending", "review_recovery_pending"].includes(onboarding.status) ? null : onboarding.candidateSet, limit),
    historical: onboarding.historical ? {
      status: "historical-ready-opaque",
      boundaryId: onboarding.historical.boundaryId,
      boundaryIntegrity: onboarding.historical.boundaryIntegrity,
      applicationStatus: onboarding.historical.applicationStatus,
      nextAction: onboarding.historical.nextAction,
    } : null,
    readiness: {
      world: onboarding.worldModel?.status || "missing",
      worldModelId: onboarding.worldModel?.worldModelId || null,
      graph: graph?.status || "missing",
      graphSnapshotId: onboarding.worldModel?.graphSnapshotId || null,
      documents: documents?.status || "missing",
      documentProjectionId: documents?.projection?.documentProjectionId || null,
      ...(graph?.reasonCode ? { graphReasonCode: graph.reasonCode } : {}),
      ...(documents?.reasonCode ? { documentsReasonCode: documents.reasonCode } : {}),
    },
    reviewPolicy: {
      allowedDispositions: ["accept-all", "accept-selection", "revise", "reject"],
      acceptAllRequiresExplicitCompleteReview: true,
      promotionAuthority: "explicit-onboarding-review-only",
    },
    authority: {
      productCanon: "user-owned-project-canon",
      candidates: onboarding.historical ? "historical-ready-opaque" : "non-authoritative-until-review",
      conversationProjection: "non-authoritative-guidance",
      graph: "rebuildable-derived-evidence",
    },
  };
}

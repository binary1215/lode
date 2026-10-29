import { compileContext, DEFAULT_CONTEXT_BUDGET } from "./context-compiler.mjs";
import { familyFormatForOriginal, formatForVerifiedOwner } from "./project-storage-format.mjs";

export const CONTEXT_WORKFLOW_PROTOCOL_VERSION = "0.6.0";
export const CONTEXT_PREPARATION_PROTOCOL_VERSION = "0.3.0";

function projection(capsule) {
  const format = familyFormatForOriginal("head-agent-core-context-budget", capsule.budget) || formatForVerifiedOwner();
  const coverage = capsule.snapshot.coverage;
  const domains = capsule.repositoryWorldFreshness?.domains;
  const world = domains?.code?.status === "current" ? "current-verified"
    : domains?.code?.status === "unknown" ? "unknown-excluded"
    : domains?.code?.status === "unavailable" ? "unavailable-excluded"
    : domains?.code?.status === "stale" || coverage.includes("stale-repository-world-model-excluded") ? "stale-excluded"
    : coverage.includes("repository-world-model") ? "current-verified" : "not-built";
  return {
    kind: "ContextWorkflowProjection", protocolVersion: CONTEXT_WORKFLOW_PROTOCOL_VERSION,
    status: "ready_for_head_semantic_assessment", task: capsule.task,
    world: { state: world, coverage, worldModelDigest: capsule.snapshot.sourceDigests.repositoryWorldModel || null,
      ...(domains ? { domains } : {}), fullSnapshotReturned: false },
    evidenceNeeds: { owner: format.value("HEAD"), specifiedCount: capsule.evidenceNeedContract.needs.length,
      unmet: capsule.evidenceGaps, semanticAcceptance: "not-assessed-HEAD-owned" },
    budget: { requestedApproxTokens: capsule.budget.maxApproxTokens,
      usedApproxTokens: capsule.budget.usedApproxTokens, providerFitVerified: false },
    capsule: { capsuleId: capsule.capsuleId, previewOnly: true, persisted: false },
    explanation: { kind: "ContextExplanationCard",
      included: { totalCandidateCount: capsule.selection.includedIds.length,
        byKind: { claims: capsule.claims.length, decisions: capsule.decisions.length, unknowns: capsule.unknowns.length,
          repositoryFiles: capsule.repositoryContext.length, productConcepts: capsule.productContext.length,
          gitHistory: capsule.gitDecisionEvidence.length, runtimeObservations: capsule.runtimeStateEvidence.length,
          graphTraversals: capsule.graphTraversalEvidence.length, observations: capsule.observationEvidence.length } },
      intentionallyOmitted: capsule.omissions, remainingUncertainty: capsule.uncertainty,
      semanticSufficiencyOwner: format.value("HEAD"), userDecisionRequired: false, persisted: false },
    nextAction: { id: "head_assess_semantic_sufficiency",
      summary: "Use the selected context and inspect original sources or expand relevant graph anchors where evidence is missing.",
      note: "Lode decides which evidence is needed and whether it is sufficient; preparation does not require a World refresh, Product approval, Run or Capsule persistence." },
    authority: { advisoryOnly: true, persisted: false, mutatesWorldModel: false, persistsCapsule: false,
      selectsEvidenceNeeds: false, judgesSemanticSufficiency: false, grantsExecutionAuthorization: false,
      createsReviewDecision: false, writesRecoveryDirection: false },
  };
}

export async function previewContextWorkflow({ root = ".", task, budget = DEFAULT_CONTEXT_BUDGET, evidenceNeeds = [],
  graphProjectionAdapter = null, sourceObservations = [], includeRepositoryWorld = true } = {}) {
  const preview = (await compileContext({ root, task, budget, evidenceNeeds, persist: false,
    graphProjectionAdapter, sourceObservations, includeRepositoryWorld }));
  return { ...preview, workflow: projection(preview.capsule) };
}

export async function prepareContextWorkflow({ root = ".", task, budget = DEFAULT_CONTEXT_BUDGET, graphProjectionAdapter = null } = {}) {
  const preview = (await previewContextWorkflow({ root, task, budget, graphProjectionAdapter }));
  const { capsule, workflow } = preview;
  return {
    status: "prepared",
    preparation: {
      kind: "ContextPreparationProjection", protocolVersion: CONTEXT_PREPARATION_PROTOCOL_VERSION,
      status: "ready_for_head_semantic_assessment", task: capsule.task,
      world: workflow.world, currentState: capsule.currentState, currentDirection: capsule.currentDirection,
      selectedContext: { claims: capsule.claims, decisions: capsule.decisions, unknowns: capsule.unknowns,
        repositoryFiles: capsule.repositoryContext, productContext: capsule.productContext },
      provenance: capsule.provenance, omissions: capsule.omissions, remainingUncertainty: capsule.uncertainty,
      evidenceProposal: { selectionOwner: workflow.evidenceNeeds.owner, optional: true,
        note: "Specify only evidence useful to this task; direct source inspection is available without World activation." },
      nextAction: workflow.nextAction, authority: workflow.authority,
    },
  };
}

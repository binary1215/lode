import fs from "node:fs";
import { formatForVerifiedOwner } from "./project-storage-format.mjs";
import { ARTIFACT_COMPOSITION, publicToolName } from "./lode-artifact-composition.mjs";
import path from "node:path";
import { readProjectDirectionView } from "./project-direction-view.mjs";
import { noteProjectGraphChange, projectGraphIndexPath } from "./discovery-index.mjs";
import { fileURLToPath } from "node:url";
import { convergeProjectInstallation, initializeProject, inspectProject, isProjectRecoveryReadable } from "./lode-core.mjs";
import { inspectOnboarding, inspectOptionalOnboarding, inspectOptionalOnboardingForEntry, recoverOnboardingPromotion, refreshOnboardingCandidates, startOnboarding } from "./onboarding.mjs";
import { buildRepositorySourceScope } from "./repository-source-scope.mjs";
import { inspectRecoveryCheckpointDiagnosis } from "./recovery-checkpoint-diagnosis.mjs";
import { actionability, withExperienceProjections } from "./experience-projection.mjs";
import { linkProjectInstructions, validateInstructionIntegration } from "./project-instruction-link.mjs";
import { resumeProjectLocation } from "./project-relocation.mjs";
import { withSessionCallContext, validateRelocationSessionSelection, sessionSelectionUnresolved } from "./session-routing.mjs";
import { coreEntryGuidance } from "./lode-entry-guidance.mjs";

export const PROJECT_BOOTSTRAP_PROTOCOL_VERSION = "0.6.0";

const activePluginRoot = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));
const packageVersion = JSON.parse(fs.readFileSync(
  path.join(activePluginRoot, "package.json"),
  "utf8",
)).version;

const PROJECT_PROFILES = new Set(["core", "product"]);

const ALLOWED_ONBOARDING_FIELDS = new Set(["mode", "storage", "brief", "semanticProposal", "sourceScope"]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function validateOnboardingInput(value) {
  const source = value == null ? {} : value;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    fail("PROJECT_BOOTSTRAP_INPUT_INVALID", "Onboarding input must be an object.");
  }
  const unexpected = Object.keys(source).filter((field) => !ALLOWED_ONBOARDING_FIELDS.has(field));
  if (unexpected.length) fail("PROJECT_BOOTSTRAP_INPUT_INVALID", `Onboarding input contains unsupported fields: ${unexpected.sort().join(", ")}`);
  if (source.sourceScope != null) buildRepositorySourceScope(source.sourceScope);
  return source;
}

function validateProfile(value) {
  const profile = value == null ? "core" : String(value).trim();
  if (!PROJECT_PROFILES.has(profile)) {
    fail("PROJECT_BOOTSTRAP_PROFILE_INVALID", `Project profile must be one of: ${[...PROJECT_PROFILES].join(", ")}.`);
  }
  return profile;
}

function onboardingSummary(inspected) {
  if (inspected.status === "integrity_attention") return {
    status: inspected.status, reasonCode: inspected.reasonCode,
    candidateSetId: null, candidateCount: null, verification: "unverified",
  };
  const latestReviewDecisionId = inspected.state.latestReviewDecisionId ?? inspected.state.reviewDecisionId ?? null;
  return {
    status: inspected.status,
    phase: inspected.state.phase,
    stateRevision: inspected.state.stateRevision,
    storageMode: inspected.storageSelection.mode,
    candidateSetId: inspected.state.candidateSetId,
    candidateCount: inspected.candidateSet?.candidates.length || 0,
    latestReviewDecisionId,
    reviewDecisionId: latestReviewDecisionId,
    productModelId: inspected.state.productModelId,
    worldModelId: inspected.state.worldModelId,
    sourceSnapshotId: inspected.state.sourceSnapshotId,
  };
}

function productReadiness(status) {
  const states = {
    integrity_attention: {
      state: "integrity_attention", status: "product_integrity_attention",
      action: "inspect_product_governance",
      summary: "Core remains available. Inspect optional Product evidence before work that depends on it; no automatic repair or new review is performed.",
    },
    initialized: {
      state: "not_activated",
      status: "core_ready",
      action: "work_directly",
      summary: "The constitutional Core is ready. Use Product governance only when product meaning or governed projections are needed.",
    },
    migration_required: {
      state: "migration_required",
      status: "product_migration_required",
      action: "resume_product_governance",
      summary: "Core is ready, but legacy Product onboarding state must be migrated before Product governance can continue.",
    },
    awaiting_evidence: {
      state: "evidence_required",
      status: "product_evidence_required",
      action: "provide_product_evidence",
      summary: "Product governance is active and needs a user-owned brief or a fresh Lode semantic proposal bound to current repository evidence.",
    },
    awaiting_review: {
      state: "review_required",
      status: "product_review_required",
      action: "review_product_candidates",
      summary: "Evidence-linked Product candidates are waiting for an explicit user ReviewDecision.",
    },
    revision_required: {
      state: "review_required",
      status: "product_review_required",
      action: "review_product_candidates",
      summary: "A revised Product candidate set is waiting for an explicit user ReviewDecision.",
    },
    rejected: {
      state: "rejected",
      status: "product_rejected",
      action: "resume_product_governance",
      summary: "The current Product candidate set was rejected. Core remains ready and Product governance may be resumed explicitly.",
    },
    ready: {
      state: "ready",
      status: "product_ready",
      action: "work_with_product_context",
      summary: "Core and the reviewed Product/World path are ready for task-scoped use.",
    },
    ready_world_unchecked: {
      state: "reviewed_world_unchecked",
      status: "core_ready",
      action: "work_directly",
      summary: "Core and reviewed Product originals are available. Detailed World freshness was not inspected for this conversation; continue the task and validate World evidence only when it is needed.",
    },
    ready_world_changed: {
      state: "refresh_required",
      status: "product_refresh_required",
      action: "refresh_product_world",
      summary: "Reviewed Product Canon is preserved, but its derived World projection must be refreshed or reconciled.",
    },
    promotion_recovery_pending: {
      state: "refresh_required",
      status: "product_refresh_required",
      action: "resume_product_governance",
      summary: "The Product decision is already recorded. Product resume completes its interrupted application and derived projection without another user review; ordinary Core work remains available.",
    },
    review_recovery_pending: {
      state: "refresh_required",
      status: "product_refresh_required",
      action: "resume_product_governance",
      summary: "The revision or rejection is already recorded. Product resume completes its interrupted application without another user decision; ordinary Core work remains available.",
    },
  };
  return states[status] || {
    state: "inspection_required",
    status: "product_inspection_required",
    action: "inspect_product_governance",
    summary: `Product governance reported an unrecognized state: ${status}.`,
  };
}

function contextReadiness({ coreState, productState, onboardingInspection = null }) {
  const entrypoint = {
    cli: `${ARTIFACT_COMPOSITION.identity}-agent context-prepare <project> --task <exact-task>`,
    mcpTool: publicToolName("head_context_prepare"),
  };
  if (coreState !== "ready") return {
    state: "blocked",
    repositoryEvidence: "blocked-until-core-ready",
    worldModelId: null,
    entrypoint,
  };
  if (productState === "integrity_attention") return {
    state: "curated-only", repositoryEvidence: "unverified-excluded",
    worldModelId: null, entrypoint,
  };
  if (onboardingInspection?.worldModel?.status === "not-inspected") return {
    state: "world-not-inspected",
    repositoryEvidence: "not-inspected",
    worldModelId: null,
    entrypoint,
  };
  if (onboardingInspection?.worldModel?.status === "current") return {
    state: "repository-ready",
    repositoryEvidence: "available-current-world",
    worldModelId: onboardingInspection.worldModel.worldModelId,
    entrypoint,
  };
  if (productState === "refresh_required" || onboardingInspection?.worldModel) return {
    state: "world-refresh-required",
    repositoryEvidence: onboardingInspection?.worldModel?.status === "unavailable" ? "missing-excluded" : "stale-excluded",
    worldModelId: onboardingInspection?.worldModel?.status === "unavailable" ? null : onboardingInspection?.worldModel?.worldModelId || null,
    entrypoint,
  };
  return {
    state: "curated-only",
    repositoryEvidence: "requires-explicit-product-world",
    worldModelId: null,
    entrypoint,
  };
}

function runtimeProjection(projectInspection = null) {
  const configuredPackageVersion = projectInspection?.installation?.packageVersion || null;
  const configuredRoot = projectInspection?.installation?.pluginRoot || null;
  const configuredRootMatchesLoaded = configuredRoot == null ? null : path.resolve(configuredRoot) === activePluginRoot;
  const state = configuredPackageVersion == null ? "version-unrecorded"
    : configuredPackageVersion === packageVersion && configuredRootMatchesLoaded ? "current" : "project-integration-outdated";
  return {
    activePackageVersion: packageVersion,
    loadedPackageVersion: packageVersion,
    loadedPackageScope: "executing-cli-or-library-not-host-tool-inventory",
    hostLoadObservation: "not-observed-by-project-package-inspection",
    configuredPackageVersion,
    configuredRootMatchesLoaded,
    state,
    restartRequired: state === "project-integration-outdated",
    restartReason: state === "project-integration-outdated" ? "project-integration-points-to-a-different-package-root-or-version" : null,
    reloadSequence: state === "project-integration-outdated" ? ["converge-project-integration", "restart-host"] : [],
    reloadPolicy: "restart-host-after-install-or-upgrade",
    providerSessionIdentityPersisted: false,
    compactionLifecycle: {
      conversationEntryRecovery: "active",
      injectedHostContract: "active",
      packagedProviderEventAdapters: {
        claude: "not-bound",
        codex: "not-bound",
        opencode: "not-bound",
      },
      unavailableBehavior: "non-blocking-p2-artifact-entry-recovery",
    },
  };
}

export function recoveryReadiness(projectInspection, { includeRestore = false } = {}) {
  const authority = {
    advisoryOnly: true,
    writesRecoveryDirection: false,
    consumesContinuation: false,
    attachesProvider: false,
  };
  if (projectInspection.status === "not_initialized") {
    return {
      state: "unavailable-until-core-ready",
      currentCheckpoint: false,
      restorable: false,
      ...actionability({ headActionRequired: false }),
      authority,
    };
  }
  if (!isProjectRecoveryReadable(projectInspection)) {
    return {
      state: "blocked-by-core-drift",
      currentCheckpoint: Boolean(projectInspection.state?.latestCheckpoint),
      restorable: false,
      ...actionability({
        headActionRequired: true,
        recoveryDependentWorkBlocked: Boolean(projectInspection.state?.latestCheckpoint),
        blockedOperations: ["head-managed-mutation", ...(projectInspection.state?.latestCheckpoint ? ["checkpoint-dependent-work"] : [])],
      }),
      reasonCode: "CORE_DRIFT",
      authority,
    };
  }
  if (!projectInspection.state.latestCheckpoint) {
    return {
      state: "no-current-checkpoint",
      currentCheckpoint: false,
      restorable: false,
      ...actionability(),
      authority,
    };
  }
  const diagnosis = inspectRecoveryCheckpointDiagnosis({ root: projectInspection.project.projectRoot, includeRestore });
  if (diagnosis.diagnosis.state === "no-current-checkpoint") {
    return {
      state: "no-current-checkpoint",
      currentCheckpoint: false,
      restorable: false,
      ...actionability(),
      authority,
    };
  }
  if (new Set(["verified-checkpoint", "verified-checkpoint-with-missing-result-evidence"]).has(diagnosis.diagnosis.state)) {
    return {
      state: "verified-current-checkpoint",
      currentCheckpoint: true,
      restorable: true,
      ...actionability({ headActionRequired: diagnosis.headActionRequired,
        recoveryDependentWorkBlocked: diagnosis.recoveryDependentWorkBlocked,
        blockedOperations: diagnosis.recoveryDependentWorkBlocked ? ["run-storage-transition"] : [] }),
      checkpointId: diagnosis.currentCheckpoint.checkpointId,
      sessionRestoreId: diagnosis.artifactRecovery.sessionRestoreId,
      currentExecutionStatus: diagnosis.artifactRecovery.currentExecutionStatus,
      reasonCode: diagnosis.diagnosis.reasonCode,
      optionalResultEvidence: diagnosis.artifactRecovery.optionalResultEvidence,
      reviewDependentWorkBlocked: diagnosis.reviewDependentWorkBlocked,
      checkpointUpdate: diagnosis.checkpointUpdate,
      semanticFreshness: diagnosis.semanticFreshness,
      observationConsistency: diagnosis.observationConsistency,
      recoveryNextHeadAction: diagnosis.nextHeadAction,
      ...(includeRestore ? { restore: diagnosis.restore } : {}),
      authority,
    };
  }
  return {
    state: "attention-required",
    currentCheckpoint: Boolean(diagnosis.currentCheckpoint.checkpointId),
    restorable: false,
    ...actionability({
      headActionRequired: true,
      recoveryDependentWorkBlocked: diagnosis.recoveryDependentWorkBlocked,
      blockedOperations: diagnosis.recoveryDependentWorkBlocked ? ["checkpoint-dependent-work"] : [],
    }),
    reasonCode: diagnosis.diagnosis.reasonCode,
    checkpointDiagnosis: diagnosis.diagnosis.state,
    checkpointUpdate: diagnosis.checkpointUpdate,
    semanticFreshness: diagnosis.semanticFreshness,
    observationConsistency: diagnosis.observationConsistency,
    recoveryNextHeadAction: diagnosis.nextHeadAction,
    authority,
  };
}

function entrypoint(action, onboardingInspection = null) {
  const worldAbsent = onboardingInspection?.worldModel?.status === "unavailable";
  const entries = {
    initialize_core: {
      cli: `${ARTIFACT_COMPOSITION.identity}-agent init <project> --runtime <runtimes>`,
      mcpTool: publicToolName("head_project_initialize_or_resume"),
      mcpArguments: { profile: "core" },
    },
    review_managed_projection_drift: {
      cli: `${ARTIFACT_COMPOSITION.identity}-agent doctor <project>`,
      mcpTool: publicToolName("head_project_status"),
      note: "Review each reported managed-file drift before choosing an explicit repair.",
    },
    work_directly: {
      cli: null,
      mcpTool: null,
      note: "Continue the current authorized task using supplied context. Inspect status only for a relevant change or diagnosis.",
    },
    provide_product_evidence: {
      cli: `${ARTIFACT_COMPOSITION.identity}-agent resume <project> --profile product --input <onboarding.json>`,
      mcpTool: publicToolName("head_project_initialize_or_resume"),
      mcpArguments: { profile: "product" },
    },
    review_product_candidates: {
      cli: `${ARTIFACT_COMPOSITION.identity}-agent onboarding-status <project>`,
      mcpTool: publicToolName("head_onboarding_guide"),
    },
    resume_product_governance: {
      cli: `${ARTIFACT_COMPOSITION.identity}-agent resume <project> --profile product`,
      mcpTool: publicToolName("head_project_initialize_or_resume"),
      mcpArguments: { profile: "product" },
    },
    refresh_product_world: {
      cli: worldAbsent ? `${ARTIFACT_COMPOSITION.identity}-agent world-index <project>` : `${ARTIFACT_COMPOSITION.identity}-agent world-refresh <project>`,
      worldOperation: worldAbsent ? "rebuild" : "incremental-refresh",
      mcpTool: null,
      note: worldAbsent ? "The derived World is absent. Explicitly rebuild from retained Canon and evidence; no Product reapproval is needed."
        : "The current typed MCP surface is read-only for refresh state; use the explicit CLI mutation entrypoint.",
    },
    work_with_product_context: {
      cli: null,
      mcpTool: null,
      note: "Continue the user's task with the needed files and available Product evidence. Prepare a Capsule only for reproducible selected-context handoff, durable Run or recovery needs.",
      optionalContextTool: publicToolName("head_context_prepare"),
    },
    inspect_product_governance: {
      cli: `${ARTIFACT_COMPOSITION.identity}-agent onboarding-status <project>`,
      mcpTool: publicToolName("head_onboarding_guide"),
    },
  };
  return entries[action];
}

function capabilityGuide({ coreState, productState, contextState, runtimes = [] }) {
  const coreAvailable = coreState === "ready";
  const blocked = coreAvailable ? null : "blocked-until-core-ready";
  return [
    {
      id: "direct-work",
      // Core readiness scopes HEAD-managed capabilities, never ordinary work.
      availability: "available",
      useWhen: "The task can be completed coherently in the current Project and Session without durable execution governance.",
      entrypoint: "Use the active coding conversation; Lode artifacts are not required for ordinary edits.",
    },
    {
      id: "product-governance",
      availability: blocked || (productState === "not_activated" ? "available-not-activated"
        : productState === "reviewed_world_unchecked" ? "available-on-demand"
          : productState === "ready" ? "active-ready" : "active-action-required"),
      useWhen: "The task needs reviewed product meaning, World/Graph evidence, or governed document projections.",
      entrypoint: `${publicToolName("head_project_initialize_or_resume")} profile=product, then ${publicToolName("head_onboarding_guide")}`,
    },
    {
      id: "context-compiler",
      availability: blocked || contextState.repositoryEvidence,
      useWhen: "Reproducible selected-context handoff, a durable Run or recovery actually needs a Capsule. Ordinary reading/editing uses needed files directly; the Compiler does not decide semantic sufficiency.",
      entrypoint: publicToolName("head_context_prepare"),
    },
    {
      id: "durable-run",
      availability: blocked || "available-on-demand",
      useWhen: "Execution is long, risky, review-sensitive, or must survive provider/context loss.",
      entrypoint: "WholePlanSnapshot -> ExecutionContract + ContextCapsule -> ResultPacket -> Fresh Lode review",
    },
    {
      id: "bounded-workers",
      availability: blocked || "requires-session-or-run-authorization",
      useWhen: "Inspect or settle retained managed work, not ordinary parallel delegation or an automatic fallback.",
      entrypoint: "Use exact status/cancel diagnostics; explicit retained-work maintenance keeps original authorization and effect checks. Ordinary delegation uses available Host tools.",
    },
    {
      id: "compaction-recovery",
      availability: blocked || "available-on-demand",
      useWhen: "Direction must survive intentional compaction or provider replacement.",
      entrypoint: "Prepare and verify an immutable checkpoint before one-shot continuation.",
    },
    {
      id: "provider-runtime",
      availability: blocked || "requires-capability-inspection-and-authorization",
      useWhen: "A selected provider must execute an explicitly bounded Session or Run action.",
      entrypoint: `${publicToolName("head_runtime_adapters")}, then an exact ExecutionAuthorization`,
      selectedRuntimes: runtimes,
    },
  ];
}

function projectExperience(projectInspection, onboardingInspection = null, recoveryOverride = null) {
  if (projectInspection.status === "not_initialized") {
    const action = "initialize_core";
    const context = contextReadiness({ coreState: "not_initialized", productState: "unavailable" });
    return withExperienceProjections({
      kind: formatForVerifiedOwner(projectInspection.storage).kind("HeadProjectExperienceProjection"),
      protocolVersion: PROJECT_BOOTSTRAP_PROTOCOL_VERSION,
      status: "not_initialized",
      projectRoot: projectInspection.projectRoot,
      readiness: {
        core: { state: "not_initialized", managedProjectionDriftCount: 0 },
        product: { state: "unavailable", governanceActivated: false, onboardingStatus: null },
        context,
        recovery: recoveryOverride || recoveryReadiness(projectInspection),
      },
      nextAction: { id: action, summary: "Initialize the constitutional Core and one canonical Project/Session before using optional capabilities.", entrypoint: entrypoint(action) },
      capabilities: capabilityGuide({ coreState: "not_initialized", productState: "unavailable", contextState: context }),
      runtime: runtimeProjection(projectInspection),
      authority: { advisoryOnly: true, persisted: false, mutatesProject: false, activatesCapabilities: false, grantsAuthorization: false },
    }, projectInspection.storage);
  }

  const pendingCandidateNeedsWorld = ["awaiting_review", "revision_required"].includes(onboardingInspection?.status)
    && onboardingInspection.worldModel?.status !== "not-inspected"
    && (onboardingInspection.worldModel?.status !== "current" || onboardingInspection.worldModel.matchesCandidateSource === false);
  const product = onboardingInspection ? productReadiness(pendingCandidateNeedsWorld ? "ready_world_changed" : onboardingInspection.status) : {
    state: "inspection_blocked",
    status: "core_drifted",
    action: "review_managed_projection_drift",
    summary: "Managed project projections have drifted. Product readiness is not inferred until Core integrity is restored.",
  };
  const coreState = projectInspection.status === "ready" ? "ready" : "drifted";
  const projectionDriftOnly = coreState === "drifted" && isProjectRecoveryReadable(projectInspection);
  const unrelatedDefaultProductLoss = onboardingInspection?.unavailableDependency === "default-session";
  const context = contextReadiness({ coreState, productState: product.state, onboardingInspection });
  const recovery = recoveryOverride || recoveryReadiness(projectInspection);
  const action = coreState === "ready" ? unrelatedDefaultProductLoss ? "work_directly" : product.action
    : projectionDriftOnly ? "work_directly" : "review_managed_projection_drift";
  return withExperienceProjections({
    kind: "HeadProjectExperienceProjection",
    protocolVersion: PROJECT_BOOTSTRAP_PROTOCOL_VERSION,
    status: coreState === "ready" ? product.status : "core_drifted",
    project: { ...projectInspection.project, sessionId: projectInspection.state.sessionId },
    state: projectInspection.state,
    ...readProjectDirectionView({ root: projectInspection.project.projectRoot }),
    drift: projectInspection.drift,
    readiness: {
      core: { state: coreState, managedProjectionDriftCount: projectInspection.drift.length,
        ...(projectionDriftOnly ? { projectionDriftOnly: true } : {}) },
      product: {
        state: product.state,
        governanceActivated: onboardingInspection && onboardingInspection.status !== "integrity_attention" ? !["initialized", "migration_required"].includes(onboardingInspection.status) : null,
        onboardingStatus: onboardingInspection?.status || null,
        ...(onboardingInspection?.reasonCode ? { reasonCode: onboardingInspection.reasonCode } : {}),
      },
      context,
      recovery,
    },
    nextAction: {
      id: action,
      summary: unrelatedDefaultProductLoss ? "Continue from the selected Session. Optional Product facts depending on the damaged default Session are unavailable; they are not a prerequisite for this work."
        : coreState === "ready" ? product.summary : projectionDriftOnly
        ? "Continue the task from verified records. Generated projection differences remain untouched; review them only before an affected managed mutation."
        : "Review managed-file drift before any mutating Lode operation. No automatic repair is attempted.",
      entrypoint: entrypoint(action, onboardingInspection),
    },
    capabilities: capabilityGuide({ coreState, productState: product.state, contextState: context, runtimes: projectInspection.project.runtimes }),
    runtime: runtimeProjection(projectInspection),
    authority: { advisoryOnly: true, persisted: false, mutatesProject: false, activatesCapabilities: false, grantsAuthorization: false },
  }, projectInspection.storage);
}

// Physical location facts only: no Session selection, recovery, binding lookup,
// publication lock, or adoption. Normal owned roots retain their existing route.
export function inspectProjectLocationExperience({ root = ".", sessionId } = {}) {
  const location = resumeProjectLocation({ root, pluginRoot: activePluginRoot, inspectOnly: true,
    validateSelection: sessionId === undefined ? null : owner => {
      if (typeof sessionId !== "string") throw new Error("An explicit logical Session route must be text.");
      validateRelocationSessionSelection(owner, { sessionId });
    } });
  if (!location) return null;
  const state = location.publicationPending ? "relocation_pending" : "relocation_available";
  return withExperienceProjections({
    kind: "LodeProjectExperienceProjection", protocolVersion: PROJECT_BOOTSTRAP_PROTOCOL_VERSION, status: state,
    projectRoot: location.projectRoot,
    retainedProject: { projectId: location.projectId, previousRoot: location.previousRoot },
    projectLocation: { ...location, authorityPlane: "P4", executionReplayAllowed: false, nativeBindingTransferred: false },
    selectedSession: { status: "not-inspected", selectionClaimed: false },
    readiness: { core: { state }, product: { state: "not-inspected" }, context: { state: "not-inspected" },
      recovery: { state: "not-inspected", directionRestored: false, headActionRequired: false } },
    nextAction: { id: "resume_existing_project", summary: "Explicitly resume this existing Project at the new folder; do not initialize a replacement. This read has not selected or restored a Session.",
      entrypoint: { cli: "resume", tool: "lode_project_initialize_or_resume", profile: "core" } },
    authority: { plane: "P4", advisoryOnly: true, persisted: false, mutatesProject: false, grantsAuthorization: false,
      writesRecoveryDirection: false },
  });
}

export function inspectProjectExperience({ root = ".", recoveryOverride = null } = {}) {
  const location = inspectProjectLocationExperience({ root });
  if (location) return location;
  const project = inspectProject(root);
  if (project.status !== "ready") return projectExperience(project, null, recoveryOverride);
  return projectExperience(project, inspectOptionalOnboarding({ root }), recoveryOverride);
}

// Fixed internal consumer boundary. Keep the later managed-file/selected-owner
// observation; the entry's final pointer check does not rehash managed files.
export function inspectConversationProjectExperience({ root = ".", recoveryOverride = null } = {}) {
  const project = inspectProject(root);
  if (project.status !== "ready") return projectExperience(project, null, recoveryOverride);
  return projectExperience(project, inspectOptionalOnboardingForEntry({ root }), recoveryOverride);
}

function bootstrapResponse({ root, profile, before, installation, onboardingAction, inputDisposition, inspected, extra = {} }) {
  const experience = projectExperience(inspectProject(root), inspected);
  return {
    ...experience,
    profile,
    coreGuidance: coreEntryGuidance(),
    profileSemantics: "operation-choice-not-persisted-project-mode",
    projectAction: before.status === "not_initialized" ? "initialized" : "resumed",
    installationAction: installation.status,
    ...(installation.location ? { projectLocation: installation.location } : {}),
    ...(installation.instructionIntegration ? { instructionIntegration: installation.instructionIntegration } : {}),
    onboardingAction,
    inputDisposition,
    productGovernanceActivated: experience.readiness.product.governanceActivated,
    onboarding: onboardingSummary(inspected),
    ...extra,
  };
}

export async function initializeOrResumeProject(options = {}) {
  const { root = ".", pluginRoot, runtimes = null, profile: requestedProfile = "core", onboarding = null,
    instructionIntegration = null, projectSessionRoute = null } = options;
  validateInstructionIntegration(instructionIntegration);
  const profile = validateProfile(requestedProfile);
  const onboardingInput = validateOnboardingInput(onboarding);
  if (profile === "core" && Object.keys(onboardingInput).length) {
    fail("PROJECT_BOOTSTRAP_PROFILE_REQUIRED", "Onboarding input requires the explicit product profile.");
  }
  const location = resumeProjectLocation({ root, pluginRoot, runtimes,
    validateSelection: owner => validateRelocationSessionSelection(owner, projectSessionRoute ?? {}) });
  const operation = () => initializeOrResumeCurrentProject({ ...options, root, profile, onboardingInput, location });
  if (!projectSessionRoute) return operation();
  const route = { sessionId: projectSessionRoute.sessionId, context: projectSessionRoute.context };
  const unresolved = reasonCode => {
    const value = sessionSelectionUnresolved(root, { reasonCode });
    if (!location) return value;
    const summary = "Project folder location recovery was applied. Logical Session selection and Host linkage remain unconfirmed; no execution was replayed.";
    return { ...value, projectLocation: location, nextHeadAction: `${summary} ${value.nextHeadAction}`,
      presentation: { ...value.presentation, mode: "exception", summary } };
  };
  if (!route.context && projectSessionRoute.resolveContext) {
    try { route.context = await projectSessionRoute.resolveContext(); }
    catch (error) {
      if (route.sessionId === undefined) return unresolved(error.code || "HEAD_SESSION_CONTEXT_UNAVAILABLE");
      // The exact explicit route remains independent of optional P5 storage.
      // Its canonical validation below is never bypassed by Host availability.
    }
  }
  try { return await withSessionCallContext({ root, ...route }, operation); }
  catch (error) { if (error.code === "HEAD_SESSION_SELECTION_LOST") return unresolved(error.code); throw error; }
}

async function initializeOrResumeCurrentProject({ root, pluginRoot, runtimes = null, profile, onboardingInput,
  instructionIntegration = null, onValidatedSessionSelection = null, location = null, installationContext = null }) {
  const before = inspectProject(root);
  let initialization;
  let installation;
  if (before.status === "not_initialized") {
    initialization = initializeProject({ root, pluginRoot, runtimes: runtimes || undefined, installationContext });
    installation = {
      status: "initialized-current",
      projectId: initialization.project.projectId,
      sessionId: inspectProject(root).state.sessionId,
      pluginRootChanged: false,
      updatedManagedFiles: [],
    };
  } else {
    initialization = {
      status: "resumed-existing-project",
      project: before.project,
      integrations: before.project.integrations,
    };
    installation = convergeProjectInstallation({ root, pluginRoot, runtimes, onValidatedSessionSelection, installationContext });
  }
  if (location) installation.location = location;

  if (instructionIntegration != null) installation.instructionIntegration = linkProjectInstructions({ root, choice: instructionIntegration });
  if (profile === "product") await recoverOnboardingPromotion({ root });
  // Explicit resume can initialize a missing optional inventory. Existing
  // inventories are refreshed by actual record writers or explicit indexing;
  // unchanged resume must not create a new derived generation after view loss.
  if (!fs.existsSync(path.join(root, projectGraphIndexPath(initialization.storage ?? before.storage)))) noteProjectGraphChange(root);
  let current = profile === "core" ? inspectOptionalOnboarding({ root }) : inspectOnboarding({ root });
  if (profile === "core") {
    const productGovernanceActivated = !["initialized", "migration_required"].includes(current.status);
    return bootstrapResponse({
      root,
      profile,
      onboardingAction: productGovernanceActivated ? "preserved-existing-state" : "not-activated",
      inputDisposition: "not-applicable",
      before,
      installation,
      inspected: current,
    });
  }

  let onboardingAction;
  if (["initialized", "migration_required"].includes(current.status)
    || (current.status === "rejected" && Object.keys(onboardingInput).length)
    || (current.status === "awaiting_evidence" && Object.keys(onboardingInput).length)) {
    const started = await startOnboarding({ root, ...onboardingInput });
    onboardingAction = current.status === "initialized" || current.status === "migration_required" ? "started" : "resumed-analysis";
    const inspected = inspectOnboarding({ root });
    return bootstrapResponse({
      root,
      profile,
      onboardingAction,
      inputDisposition: "applied",
      before,
      installation,
      inspected,
      extra: { onboardingOperationStatus: started.status },
    });
  }

  if (current.status === "awaiting_evidence") {
    return bootstrapResponse({
      root,
      profile,
      onboardingAction: "evidence-required",
      inputDisposition: "semantic-proposal-or-user-brief-required",
      before,
      installation,
      inspected: current,
    });
  }

  if (current.status === "awaiting_review" || current.status === "revision_required") {
    const refresh = await refreshOnboardingCandidates({ root, semanticProposal: onboardingInput.semanticProposal || null });
    current = inspectOnboarding({ root });
    if (refresh.refreshed) {
      return bootstrapResponse({
        root,
        profile,
        onboardingAction: "refreshed-stale-candidates",
        inputDisposition: Object.keys(onboardingInput).length ? "not-reapplied-to-existing-authority-state" : "not-required",
        before,
        installation,
        inspected: current,
        extra: { previousCandidateSetId: refresh.previousCandidateSetId },
      });
    }
    if (refresh.status === "onboarding_semantic_reproposal_required") {
      const response = bootstrapResponse({
        root,
        profile,
        onboardingAction: "fresh-head-semantic-reproposal-required",
        inputDisposition: "semantic-proposal-required",
        before,
        installation,
        inspected: current,
        extra: { currentSourceSnapshotId: refresh.currentSourceSnapshotId },
      });
      return {
        ...response,
        status: "product_evidence_required",
        readiness: {
          ...response.readiness,
          product: { ...response.readiness.product, state: "evidence_required" },
        },
        nextAction: {
          id: "provide_product_evidence",
          summary: "Repository evidence changed. Re-inspect the current SourceSnapshot and submit a fresh Lode semantic proposal; do not review the stale candidate set.",
          entrypoint: entrypoint("provide_product_evidence"),
        },
      };
    }
  }

  const resumableWithoutMutation = new Set(["awaiting_review", "revision_required", "ready", "ready_world_changed", "promotion_recovery_pending", "review_recovery_pending", "rejected"]);
  if (!resumableWithoutMutation.has(current.status)) {
    fail("PROJECT_BOOTSTRAP_STATE_UNSUPPORTED", `Unsupported onboarding resume status: ${current.status}`);
  }
  return bootstrapResponse({
    root,
    profile,
    onboardingAction: current.status === "promotion_recovery_pending" ? "approved-projection-pending"
      : current.status === "review_recovery_pending" ? "review-projection-pending"
      : current.status === "rejected" ? "rejected-preserved"
      : current.status === "awaiting_review" || current.status === "revision_required" ? "review-required" : "already-ready",
    inputDisposition: Object.keys(onboardingInput).length ? "not-reapplied-to-existing-authority-state" : "not-required",
    before,
    installation,
    inspected: current,
  });
}

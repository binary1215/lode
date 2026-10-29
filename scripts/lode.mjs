#!/usr/bin/env node
import { inspectSnapshotPreservationClosure } from "./lib/snapshot-preservation-closure.mjs";
import { inspectSnapshotGarbageCollection } from "./lib/snapshot-gc.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARTIFACT_COMPOSITION } from "./lib/lode-artifact-composition.mjs";
import { commandEntry, isManagedMutation, requireOperationSurface, requireSurface } from "./lib/managed-maintenance-surface.mjs";
import { inspectProject, inspectRuntimeAdapters } from "./lib/lode-core.mjs";
import { withSessionRoute, withSessionCallContext, sessionCallRequiresBinding, sessionSelectionUnresolved, createLodeSession, readProjectDirection, updateProjectDirection, validateRelocationSessionSelection } from "./lib/session-routing.mjs";
import { resumeProjectLocation } from "./lib/project-relocation.mjs";
import { startBoundedWorkerJob, readBoundedWorkerJob, cancelBoundedWorkerJob, reconcileBoundedWorkerJob, readBoundedWorkerPatch } from "./lib/bounded-worker-job.mjs";
import { operateWorkerIntegration, inspectWorkerIntegration, validateWorkerIntegrationRequest, validateWorkerIntegrationStatusRequest } from "./lib/worker-integration-workflow.mjs";
import { resolveProjectStorage } from "./lib/project-storage-format.mjs";
import { validateRuntimeInvocationRecordIdentity } from "./lib/runtime-invocation-record.mjs";
import { prepareLocalBoundedWorker, startLocalBoundedWorker } from "./lib/local-worker-host.mjs";
import { compileContext, DEFAULT_CONTEXT_BUDGET, readContextCapsule } from "./lib/context-compiler.mjs";
import { prepareContextWorkflow, previewContextWorkflow } from "./lib/context-workflow.mjs";
import { prepareSourceContext, inspectSourceObservation } from "./lib/source-context-workflow.mjs";
import { createExecutionContract, createNextWholePlanSnapshot, createWholePlanSnapshot, readLineageArtifact } from "./lib/execution-lineage.mjs";
import { GitLogFileHistoryAdapter } from "./lib/git-history.mjs";
import { RuntimeStateFileAdapter } from "./lib/runtime-state.mjs";
import { finishRun, getPendingReviewContext, reviewRun, startRun } from "./lib/run-lineage.mjs";
import { buildWorldModel, captureWorldMarkdownChanges, inspectWorldGraphProjection, inspectWorldMarkdownProjection, inspectWorldModel, materializeWorldMarkdownProjection, queryWorldHistory, queryWorldModel, queryWorldRuntimeState, queryWorldTemporalGraph, readWorldDocumentChangeCandidateSet } from "./lib/world-model.mjs";
import { inspectOnboarding, proposeOnboardingSemanticRefresh, readOnboardingCandidateSet, readOnboardingReviewDecision, restoreOnboardingCandidate, reviewOnboarding, startOnboarding } from "./lib/onboarding.mjs";
import { inspectFeatureMapping, readFeatureMappingCandidateSet, readFeatureMappingReviewDecision, reviewFeatureMapping, startFeatureMapping } from "./lib/feature-mapping.mjs";
import { attachVcsEvidence, inspectChangeSets, readChangeImpactCandidateSet, readChangeImpactReviewDecision, readChangeSet, readVcsEvidence, recordChangeSet, reviewChangeImpact } from "./lib/change-set.mjs";
import { inspectIncrementalRefresh, inspectPostRefreshProjectionStatus, readIncrementalRefreshReceipt, readPostRefreshProjectionReceipt, refreshWorldModel } from "./lib/incremental-refresh.mjs";
import { inspectRefreshTriggers, processRefreshTriggerBatch, readRefreshTriggerDelivery, runFileSystemRefreshWatcher } from "./lib/refresh-trigger.mjs";
import { inspectPostRefreshProjectionPolicy, setPostRefreshProjectionPolicy } from "./lib/post-refresh-projection.mjs";
import { applyDocumentChangeReview, inspectDocumentChangeReviewStatus, readDocumentChangeApplicationReceipt, readDocumentChangeReviewDecision, reviewDocumentChanges } from "./lib/document-change-review.mjs";
import { activateArcadeDbGraphProjection, inspectArcadeDbGraphProjectionStatus } from "./lib/graphdb-projection-activation.mjs";
import { initializeArcadeDbDatabase, inspectArcadeDbDatabaseCompatibility } from "./lib/arcadedb-database-lifecycle.mjs";
import {
  buildRuntimeInvocationAuthorization,
  inspectRuntimeInvocationExecutionLease,
  readRuntimeInvocationAuthorization,
  reconcileWorkerMember,
} from "./lib/runtime-invocation-lifecycle.mjs";
import { executeRuntimeInvocation } from "./lib/runtime-one-shot-exec.mjs";
import { applyRuntimeRunResult, readRuntimeInvocationResult } from "./lib/runtime-run-result-application.mjs";
import { readRepositorySourceScope, writeRepositorySourceScope } from "./lib/repository-source-scope.mjs";
import { initializeOrResumeProject, inspectProjectExperience, inspectProjectLocationExperience } from "./lib/project-bootstrap.mjs";
import { buildLodeContinuitySnapshot, inspectProductOperatingLoop, observeProductOutcome, proposeProductInitiative, recordProductHypothesis, recordProductSignal, reviewProductInitiative } from "./lib/product-operating-loop.mjs";
import { inspectProductPolicyStatus, proposeProductPolicy, readProductPolicyCandidate, readProductPolicyReviewDecision, reviewProductPolicy } from "./lib/product-policy.mjs";
import { assessMetricComparison, compareMetricObservations, defineMetric, inspectMeasurements, recordMetricObservation, traceMeasurementLineage } from "./lib/measurement-workflow.mjs";
import { inspectReleaseObservations, observeReleaseState } from "./lib/release-observation.mjs";
import { inspectDeliveryState, recordDeliveryObservation } from "./lib/delivery-observation.mjs";
import { collectRegisteredObservation, ingestJsonObservationEventFile, ingestStructuredObservation, inspectObservationSources } from "./lib/observation-adapter.mjs";
import { queryObservations } from "./lib/observation-projection.mjs";
import { diffGraphLineage, inspectGraphLineage, traceGraphLineage } from "./lib/graph-lineage.mjs";
import { readObservation, recordDerivedObservation } from "./lib/observation-store.mjs";
import { prepareObservationEvidence } from "./lib/observation-workflow.mjs";
import { inspectConformanceQueue, prepareConformanceAssessment, proposeConformanceFindings, proposeConformanceResolution, readConformanceFinding, recordConformanceDisposition } from "./lib/conformance-reconciliation.mjs";
import { formatCliError, formatCliResult } from "./lib/cli-presentation.mjs";
import { abortCompaction, continueCompaction, createRecoveryCheckpoint, inspectCompaction, inspectRecoveryCheckpointBasis, prepareCompaction, syncRecoveryCheckpoint, verifyCompaction } from "./lib/compaction-recovery.mjs";
import { enterConversationRecovery, processCompactionLifecycle } from "./lib/compaction-lifecycle.mjs";
import { recordSessionWorkEvidence, readSessionWorkContext, readSessionWorkList } from "./lib/session-work-context.mjs";
import { integrateReviewedRunCheckpoint, readRunResultIntegration, restoreSessionFromArtifacts } from "./lib/session-recovery.mjs";
import { inspectRecoveryCheckpointDiagnosis } from "./lib/recovery-checkpoint-diagnosis.mjs";
import { continueSessionFromArtifacts } from "./lib/runtime-session-continuation.mjs";
import {
  applyBoundedWorkerDispatchResult,
  createBoundedWorkerDispatch,
  executeBoundedWorkerDispatch,
  readBoundedWorkerDispatch,
  waitForBoundedWorkerDispatch,
} from "./lib/bounded-worker-dispatch.mjs";
import {
  abandonBoundedWorkerWave,
  createBoundedWorkerWave,
  readBoundedWorkerWave,
  readBoundedWorkerWaveResults,
  readBoundedWorkerWaveStatus,
  sealBoundedWorkerWave,
  waitForBoundedWorkerWave,
} from "./lib/bounded-worker-wave.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageMetadata = JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"), "utf8"));

export function parse(argv) {
  const [command = "help", root = ".", ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) throw new Error(`Unexpected argument: ${item}`);
    const key = item.slice(2);
    if (command === "storage-gc" && key === "apply") { options[key] = true; continue; }
    if (command === "graph-explorer" && ["history", "share"].includes(key)) { options[key] = true; continue; }
    if (key === "details" || command === "session-work-read" && key === "scan-evidence" || command === "graph-query" && key === "inventory-page") {
      const value = rest[index + 1];
      options[key] = value === "false" ? false : true;
      if (value === "true" || value === "false") index += 1;
      continue;
    }
    if (key === "fresh") {
      options[key] = true;
      continue;
    }
    const value = rest[++index];
    if (!value || value.startsWith("--")) throw new Error(`A value is required for ${item}.`);
    options[key] = value;
  }
  return { command: command === "lode-continuity" ? "head-continuity" : command, root, options };
}

export function usage({ all = false, surface = "ordinary" } = {}) {
  requireSurface(surface);
  const cliDisplay = `${ARTIFACT_COMPOSITION.identity}-agent`;
  const continuityName = ARTIFACT_COMPOSITION.identity === "head" ? "head-continuity" : "lode-continuity";
  const allCommands = [
      `${cliDisplay} init <project> [--runtime claude,codex,opencode] [--profile core|product] [--input <onboarding.json>] [--instruction-integration link|preserve]`,
      `${cliDisplay} resume <project> [--runtime claude,codex,opencode] [--profile core|product] [--input <onboarding.json>] [--instruction-integration link|preserve]`,
      `${cliDisplay} --version`,
      `${cliDisplay} status <project>`,
      `${cliDisplay} doctor <project>`,
      `${cliDisplay} graph-query <project> --query <text> [--view all|work|product] [--paths <path,...>] [--anchors <id,...>] [--depth <n>] [--max-nodes <n>] [--max-edges <n>] [--world-model <id>] [--details] [--inventory-page --inventory-paths <owned-path,...> --inventory-cursor <returned-cursor>]`,
      `${cliDisplay} graph-index <project>`,
      `${cliDisplay} graph-explorer <project> [--layer project|code] [--query <text-or-source>] [--anchors <id,...>] [--paths <path,...>] [--history] [--share] [--output <new-file.html>]`,
      `${cliDisplay} session-create <project> [--purpose <text>] [--new-session <session-id>]`,
      `${cliDisplay} session-list <project> [--session <id>] [--max-sessions <1..64>] [--after-session <cursor>] [--conversation-candidates <json-file>]  # read-only preview and optional stored mappings; preserves selection`,
      `${cliDisplay} project-direction-read <project>`,
      `${cliDisplay} project-direction-update <project> --input <current-user-direction.json> [--expected-direction <id>]`,
      `${cliDisplay} runtime-adapters <project>`,
      `${cliDisplay} runtime-invocation-authorize <project> --input <authorization.json>`,
      `${cliDisplay} runtime-invocation-read <project> --authorization <execution-authorization-id>`,
      `${cliDisplay} worker-reconcile <project> --task-key <stable-task-key>`,
      `${cliDisplay} runtime-invocation-lease-status <project> --authorization <execution-authorization-id>`,
      `${cliDisplay} runtime-invocation-execute <project> --authorization <execution-authorization-id> [--input <execution.json>]`,
      `${cliDisplay} runtime-invocation-result <project> --authorization <execution-authorization-id>`,
      `${cliDisplay} runtime-invocation-apply-run-result <project> --authorization <execution-authorization-id>`,
      `${cliDisplay} worker-dispatch <project> --authorization <execution-authorization-id> --role <developer|coder|reviewer>`,
      `${cliDisplay} worker-read <project> --authorization <execution-authorization-id>`,
      `${cliDisplay} worker-wait <project> --authorization <execution-authorization-id> [--wait-timeout-ms <0..600000>]`,
      `${cliDisplay} worker-execute <project> --authorization <execution-authorization-id> --role <developer|coder|reviewer> [--input <session-request.json>]`,
      `${cliDisplay} worker-prepare <project> --task <text> --model <exact-model> [--task-key <member>] [--source <path,...>] [--propose <path,...>] [--context <text>] [--context-mode fresh|native-prefix]`,
      `${cliDisplay} worker-start <project> --task-key <member> | --authorization <execution-authorization-id> [--role <developer|coder|reviewer>]`,
      `${cliDisplay} worker-job-status|worker-job-reconcile|worker-job-patch|worker-cancel <project> --authorization <execution-authorization-id>`,
      `${cliDisplay} worker-apply <project> --authorization <execution-authorization-id>`,
      `${cliDisplay} worker-integrate <project> --input <head-integration-request.json>`,
      `${cliDisplay} worker-integration-status <project> --integration <worker-integration-id> [--verification <worker-integration-verification-id>]`,
      `${cliDisplay} worker-wave-create <project> --input <wave.json>`,
      `${cliDisplay} worker-wave-read <project> --wave <bounded-worker-wave-id>`,
      `${cliDisplay} worker-wave-seal <project> --wave <bounded-worker-wave-id>`,
      `${cliDisplay} worker-wave-status <project> --wave <bounded-worker-wave-id>`,
      `${cliDisplay} worker-wave-results <project> --wave <bounded-worker-wave-id>`,
      `${cliDisplay} worker-wave-wait <project> --wave <bounded-worker-wave-id> [--wait-timeout-ms <0..600000>]`,
      `${cliDisplay} worker-wave-abandon <project> --input <abandonment.json>`,
      `${cliDisplay} onboarding-start <project> [--input <onboarding.json>]`,
      `${cliDisplay} onboarding-semantic-refresh <project> --input <semantic-proposal.json>`,
      `${cliDisplay} onboarding-candidate-restore <project> --input <exact-restoration.json>`,
      `${cliDisplay} onboarding-status <project>`,
      `${cliDisplay} onboarding-review <project> --input <review.json>`,
      `${cliDisplay} onboarding-candidates <project> --candidate-set <onboarding-candidate-set-id>`,
      `${cliDisplay} onboarding-review-read <project> --review <onboarding-review-decision-id>`,
      `${cliDisplay} source-scope-set <project> --input <source-scope.json>`,
      `${cliDisplay} source-scope-status <project>`,
      `${cliDisplay} feature-mapping-start <project> [--input <semantic-mapping-proposal.json>] [--expected-candidate-set <pending-candidate-set-id>]`,
      `${cliDisplay} feature-mapping-status <project>`,
      `${cliDisplay} feature-mapping-review <project> --input <review.json>`,
      `${cliDisplay} feature-mapping-candidates <project> --candidate-set <feature-mapping-candidate-set-id>`,
      `${cliDisplay} feature-mapping-review-read <project> --review <feature-mapping-review-decision-id>`,
      `${cliDisplay} change-set-record <project> --input <change-set.json>`,
      `${cliDisplay} change-set-status <project>`,
      `${cliDisplay} change-set-read <project> --change-set <change-set-id>`,
      `${cliDisplay} change-impact-candidates <project> --candidate-set <change-impact-candidate-set-id>`,
      `${cliDisplay} change-impact-review <project> --input <review.json>`,
      `${cliDisplay} change-impact-review-read <project> --review <change-impact-review-decision-id>`,
      `${cliDisplay} change-set-vcs-attach <project> --input <vcs-evidence.json>`,
      `${cliDisplay} change-set-vcs-read <project> --vcs-evidence <vcs-evidence-id>`,
      `${cliDisplay} conformance-prepare <project> [--limit <1-64>] [--projection <projection-id> --cursor <kind:key>]`,
      `${cliDisplay} conformance-propose <project> --input <provider-head-proposal.json>`,
      `${cliDisplay} conformance-queue <project> [--canon-kind <kind> --canon-key <key>] [--status <state>] [--risk-hint <level>] [--limit <1-64>] [--projection <projection-id> --cursor <finding-id>]`,
      `${cliDisplay} conformance-read <project> --finding <conformance-finding-id>`,
      `${cliDisplay} conformance-disposition <project> --input <user-confirmed-disposition.json>`,
      `${cliDisplay} conformance-resolution-propose <project> --input <provider-head-resolution.json>`,
      `${cliDisplay} product-policy-propose <project> --input <policy-candidate.json>`,
      `${cliDisplay} product-policy-review <project> --input <review.json>`,
      `${cliDisplay} product-policy-status <project> --candidate <policy-candidate-id>`,
      `${cliDisplay} product-policy-candidate-read <project> --candidate <policy-candidate-id>`,
      `${cliDisplay} product-policy-review-read <project> --review <review-decision-id>`,
      `${cliDisplay} metric-define <project> --input <metric-definition.json>`,
      `${cliDisplay} metric-observe <project> --input <metric-observation.json>`,
      `${cliDisplay} metric-compare <project> --input <metric-comparison.json>`,
      `${cliDisplay} metric-assess <project> --input <metric-assessment.json>`,
      `${cliDisplay} metric-status <project>`,
      `${cliDisplay} metric-trace <project> (--anchor <node-id> | --metric <metric-key>) [--type-version <version>] [--depth <0..3>]`,
      `${cliDisplay} product-signal-record <project> --input <signal.json>`,
      `${cliDisplay} release-observe <project> --input <deployment-result.json>`,
      `${cliDisplay} release-status <project>`,
      `${cliDisplay} delivery-observe <project> --input <delivery-observation.json>`,
      `${cliDisplay} delivery-status <project> [--environment <key>] [--target <key>] [--history-limit <1..4096>]`,
      `${cliDisplay} observation-sources <project>`,
      `${cliDisplay} observation-prepare <project> --type-key <key> [--subject-type <key>] [--subject-key <key>] [--adapter-key <key>] [--observed-after <timestamp>] [--observed-before <timestamp>] [--source-availability <state>] [--existing-limit <1-100>] [--source-limit <1-64>] [--source-projection <id> --source-cursor <source-id>]`,
      `${cliDisplay} observation-source-collect <project> --source <observation-source-id>`,
      `${cliDisplay} observation-ingest <project> --input <observation.json>`,
      `${cliDisplay} observation-file-ingest <project> --input <host-source.json>`,
      `${cliDisplay} observation-derive <project> --input <derived-observation.json>`,
      `${cliDisplay} observation-read <project> --observation <observation-id>`,
      `${cliDisplay} observation-query <project> [--type-key <key>] [--subject-type <key>] [--subject-key <key>] [--adapter-key <key>] [--observed-after <timestamp>] [--observed-before <timestamp>] [--record-kind <all|observed|derived>] [--limit <1-100>] [--projection <observation-projection-id> --cursor <observation-id>]`,
      `${cliDisplay} product-hypothesis-record <project> --input <hypothesis.json>`,
      `${cliDisplay} product-initiative-propose <project> --input <initiative.json>`,
      `${cliDisplay} product-initiative-review <project> --input <review.json>`,
      `${cliDisplay} product-outcome-observe <project> --input <outcome.json>`,
      `${cliDisplay} product-operating-status <project> [--fresh]`,
      `${cliDisplay} ${continuityName} <project> [--fresh]`,
      `${cliDisplay} world-index <project> [--git-log <host-exported-log-file>] [--runtime-state <host-exported-json-file>] [--parent-snapshot <id,id>] [--revision-parents <json-file>]`,
      `${cliDisplay} world-status <project>`,
    `${cliDisplay} storage-gc <project> [--apply]  # reference inspection; apply currently preserves all snapshots`,
      `${cliDisplay} world-refresh <project> [--expect-changed <path,path>] [--trigger-evidence <id,id>] [--parent-snapshot <id,id>]`,
      `${cliDisplay} world-refresh-status <project>`,
      `${cliDisplay} world-refresh-read <project> --receipt <incremental-refresh-receipt-id>`,
      `${cliDisplay} world-refresh-events <project> --input <refresh-events.json>`,
      `${cliDisplay} world-refresh-watch <project> [--debounce-ms <25-60000>] [--max-events <1-4096>]`,
      `${cliDisplay} world-refresh-trigger-status <project>`,
      `${cliDisplay} world-refresh-trigger-read <project> --delivery <refresh-trigger-delivery-id>`,
      `${cliDisplay} world-graph-status <project>`,
      `${cliDisplay} world-graph-remote-database-status <project>`,
      `${cliDisplay} world-graph-remote-database-initialize <project> [--reset-incompatible true --confirm-database <exact-name>]`,
      `${cliDisplay} world-graph-remote-activate <project>`,
      `${cliDisplay} world-graph-remote-status <project>`,
      `${cliDisplay} world-docs-build <project>`,
      `${cliDisplay} world-docs-status <project>`,
      `${cliDisplay} world-docs-capture <project>`,
      `${cliDisplay} world-docs-candidates <project> --candidate-set <document-change-candidate-set-id>`,
      `${cliDisplay} world-docs-review <project> --input <review.json>`,
      `${cliDisplay} world-docs-apply <project> --review <document-change-review-decision-id>`,
      `${cliDisplay} world-docs-review-status <project> --candidate-set <document-change-candidate-set-id>`,
      `${cliDisplay} world-docs-review-read <project> --review <document-change-review-decision-id>`,
      `${cliDisplay} world-docs-application-read <project> --application <document-change-application-id>`,
      `${cliDisplay} world-docs-policy-set <project> --input <policy.json>`,
      `${cliDisplay} world-docs-policy-status <project>`,
      `${cliDisplay} world-docs-refresh-status <project>`,
      `${cliDisplay} world-docs-refresh-read <project> --receipt <post-refresh-projection-receipt-id>`,
      `${cliDisplay} world-query <project> --query <text> [--depth <0-3>] [--limit <1-500>]`,
      `${cliDisplay} world-temporal <project> (--query <discovery-text> | --anchor-ids <node-id,node-id> --graph-snapshot <graph-snapshot-id>) [--kind <kind,kind>] [--relations <type,type>] [--include-candidates <true|false>] [--depth <0-3>] [--limit <1-500>] [--edge-limit <0-1000>] [--min-confidence <0-1>]`,
      `${cliDisplay} world-history <project> [--query <text>] [--limit <1-500>]`,
      `${cliDisplay} graph-lineage-status <project> [--cursor <world-model-id>] [--limit <1-100>]`,
      `${cliDisplay} graph-lineage-trace <project> (--anchor <node-id> | --query <discovery-text>) [--world <world-model-id>] [--depth <0-3>] [--limit <1-500>] [--edge-limit <0-1000>]`,
      `${cliDisplay} graph-lineage-diff <project> --from <world-model-id> --to <world-model-id> [--limit <1-500>]`,
      `${cliDisplay} world-runtime <project> [--query <text>] [--runtime <name>] [--state <state>] [--kind <kind>] [--limit <1-500>]`,
      `${cliDisplay} checkpoint <project> --summary <text> [--next <text>]`,
      `${cliDisplay} checkpoint-basis <project>`,
      `${cliDisplay} checkpoint-diagnose <project>`,
      `${cliDisplay} checkpoint-sync <project> --input <head-direction.json>`,
      `${cliDisplay} session-work-record <project> --input <selected-work-evidence.json>`,
      `${cliDisplay} session-work-read <project> [--scan-evidence] [--after-evidence-id <returned-id>] [--input <read-bounds.json>]`,
      `${cliDisplay} session-restore <project> [--checkpoint <session-run-checkpoint-id>]`,
      `${cliDisplay} session-continue <project> --runtime <claude|codex|opencode> [--checkpoint <session-run-checkpoint-id>] [--binding-env <environment-name>]`,
      `${cliDisplay} compact-prepare <project> --input <recovery.json>`,
      `${cliDisplay} compact-verify <project> --input <verification.json>`,
      `${cliDisplay} compact-continue <project> --input <continuation.json>`,
      `${cliDisplay} compact-status <project>`,
      `${cliDisplay} compact-abort <project> --input <abort.json>`,
      `${cliDisplay} conversation-enter <project>`,
      `${cliDisplay} compaction-lifecycle-step <project> [--input <head-direction.json>]`,
      `${cliDisplay} lineage-plan <project> --input <whole-plan.json>`,
      `${cliDisplay} lineage-next-plan <project> --input <next-whole-plan.json>`,
      `${cliDisplay} lineage-contract <project> --input <execution-contract.json>`,
      `${cliDisplay} run-start <project> --contract <execution-contract-id>`,
      `${cliDisplay} run-finish <project> --input <result.json>`,
      `${cliDisplay} run-review-context <project>`,
      `${cliDisplay} run-review <project> --input <review.json>`,
      `${cliDisplay} run-integrate-checkpoint <project> --input <integration.json>`,
      `${cliDisplay} run-integration-read <project> --review <review-decision-id>`,
      `${cliDisplay} context-preview <project> --task <text> [--budget <tokens>] [--evidence-needs <json-file>]`,
      `${cliDisplay} context-prepare <project> --task <text> [--budget <tokens>]`,
      `${cliDisplay} source-context <project> --task <text> [--source <relative-path>] [--kind source|outgoing-calls|declarations|selected-source] [--symbol <qualified-name>] [--input <needs.json>] [--retain true] [--timeout <ms>]`,
      `${cliDisplay} source-observation-read <project> --bundle <key> | --failure <key>`,
      `${cliDisplay} context-compile <project> --task <text> [--budget <tokens>] [--evidence-needs <json-file>]`,
      `${cliDisplay} context-read <project> --capsule <capsule-id>`,
      `${cliDisplay} lineage-read <project> --artifact <lineage-artifact-id>`,
    ];
  const defaultCommands = [
    `${cliDisplay} init <project> [--runtime claude,codex,opencode]  # small Core is the default`,
    `${cliDisplay} resume <project> [--runtime claude,codex,opencode]`,
    `${cliDisplay} status <project>`,
    `${cliDisplay} graph-query <project> --query <text>  # bounded graph first; source fallback remains usable`,
    `${cliDisplay} graph-explorer <project>  # create an offline read-only graph viewer`,
    `${cliDisplay} session-list <project>  # use --session <logical-session-id> on project commands when needed`,
    `${cliDisplay} checkpoint-diagnose <project>  # only when recovery needs attention`,
    `${cliDisplay} compact-status <project>`,
    `${cliDisplay} help-all  # advanced, audit, and recovery commands`,
  ];
  return {
    surface: surface === "managed-maintenance" ? surface : all ? "ordinary-complete" : "light-default",
    commands: surface === "managed-maintenance"
      ? allCommands.map(line => line.replace(cliDisplay + " ", cliDisplay + " managed-maintenance "))
      : all ? allCommands.filter(line => !isManagedMutation(line.split(" ")[1])) : defaultCommands,
    laneRecommendationRequired: false,
    executionMeans: {
      default: (ARTIFACT_COMPOSITION.identity === "head" ? "head-direct" : "lode-direct"),
      delegation: "existing-host-tools-when-useful",
      delegationReasons: ["independently-reviewable-result", "preserve-judgment-context-in-long-sequential-work"],
      managedWhen: ["durable-ownership", "recovery-after-interruption", "effect-retry-or-duplicate-integration-control"],
      managedSelectionIsAutomatic: false,
      contextTransfer: "fork-or-fresh-is-separate-from-execution-and-authority",
      requiresUserSelection: false,
      hostFallback: [(ARTIFACT_COMPOSITION.identity === "head" ? "head-direct" : "lode-direct"), "sequential"],
      fallbackCondition: "not-started-or-confirmed-no-remaining-effects",
      uncertainOutcome: "inspect-affected-work-before-replacement",
      grantsPermission: false,
    },
    durableProductRecordCommandsAreDefault: false,
    contextPreparationRequired: false,
    contextGuidance: "Read needed files directly; compile only for reproducible selected-context handoff, durable Run or recovery needs.",
    advancedCommand: all ? null : `${cliDisplay} help-all`,
  };
}

function inputJson(options, label) {
  if (!options.input) throw new Error(`${label} requires --input <json-file>.`);
  const file = path.resolve(options.input);
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { throw new Error(`${label} input is invalid JSON: ${error.message}`); }
}

function optionalInputJson(options, label) {
  return options.input ? inputJson(options, label) : {};
}

function readJsonFile(file, label) {
  try { return JSON.parse(fs.readFileSync(path.resolve(file), "utf8")); }
  catch (error) { throw new Error(`${label} is invalid JSON: ${error.message}`); }
}

function evidenceNeedsInput(options) {
  if (!options["evidence-needs"]) return [];
  const value = readJsonFile(options["evidence-needs"], "Lode evidence needs");
  return Array.isArray(value) ? value : value?.evidenceNeeds ?? value;
}

function requireRuntimeSurface(command, surface, root, authorization) {
  if (surface === "managed-maintenance") return;
  // Older managed dispatches can reference a shared authorization without
  // workerInput. Inspect this exact record, never scan all project history.
  let workerBound = authorization.workerInput != null;
  if (!workerBound) {
    try { readBoundedWorkerDispatch({ root, authorizationId: authorization.authorizationId }); workerBound = true; }
    catch (error) { if (error.code !== "BOUNDED_WORKER_DISPATCH_NOT_FOUND") throw error; }
  }
  requireOperationSurface(command, surface, { workerBound });
}

async function preparedRuntimeRead(root, value) {
  try { return (await import("./lib/runtime-prepared-input-view.mjs")).withPreparedRuntimeInputView({ root, value }); }
  catch { return { ...value, preparedInput: { kind: "PreparedRuntimeInputProjection", authorityPlane: "P4", status: "unavailable", reasonCode: "PREPARED_INPUT_VIEW_UNAVAILABLE",
    persisted: false, instructionAuthority: false, recoveryAuthority: false, executionAuthorization: false, modelUse: "unknown" } }; }
}

export async function runCommand(argv = process.argv.slice(2), { observationRegistry = null, compactionLifecycleHost = null, workerJobHost = null, workerJobSupervisor = null, workerPreparationBackend = null, sessionContext = null, signal, onProcess } = {}) {
  const entry = commandEntry(argv);
  const parsed = parse(entry.argv);
  const index = argv.indexOf("--session");
  if (parsed.command === "session-list") {
    requireOperationSurface(parsed.command, entry.surface);
    if (argv.lastIndexOf("--session") !== index) throw new Error("Only one logical Session preview may be requested.");
    return readSessionWorkList({ root: parsed.root, sessionId: index >= 0 ? parsed.options.session : null,
      maxSessions: parsed.options["max-sessions"] === undefined ? 16 : Number(parsed.options["max-sessions"]),
      afterSessionId: parsed.options["after-session"] ?? null,
      conversationCandidates: parsed.options["conversation-candidates"] === undefined ? undefined
        : inputJson({ input: parsed.options["conversation-candidates"] }, "Conversation lookup selectors") });
  }
  if (["status", "doctor"].includes(parsed.command)) {
    if (argv.lastIndexOf("--session") !== index) throw new Error("Only one logical Session route may be selected.");
    requireOperationSurface(parsed.command, entry.surface);
    const location = inspectProjectLocationExperience({ root: parsed.root, sessionId: index >= 0 ? parsed.options.session : undefined });
    if (location) return location;
  }
  if (index >= 0 || sessionContext) {
    if (argv.lastIndexOf("--session") !== index) throw new Error("Only one logical Session route may be selected.");
    const routed = [...argv]; if (index >= 0) routed.splice(index, 2);
    if (["init", "resume"].includes(parsed.command)) {
      const projectSessionRoute = { sessionId: index >= 0 ? parsed.options.session : undefined, context: sessionContext };
      const relocation = resumeProjectLocation({ root: parsed.root, pluginRoot, runtimes: parsed.options.runtime?.split(","), inspectOnly: true,
        validateSelection: owner => validateRelocationSessionSelection(owner, projectSessionRoute) });
      if (relocation) return (await runRoutedCommand(routed, {
        observationRegistry, compactionLifecycleHost, workerJobHost, workerJobSupervisor, workerPreparationBackend, signal, onProcess, projectSessionRoute }));
    }
    const operation = async () => (await runRoutedCommand(routed, { observationRegistry, compactionLifecycleHost, workerJobHost, workerJobSupervisor, workerPreparationBackend, signal, onProcess }));
    if (index < 0 && !sessionCallRequiresBinding(parsed.command, "cli")) return (await operation());
    try { return withSessionCallContext({ root: parsed.root, sessionId: index >= 0 ? parsed.options.session : undefined, context: sessionContext }, operation); }
    catch (error) {
      if (error.code !== "HEAD_SESSION_SELECTION_LOST") throw error;
      return sessionSelectionUnresolved(parsed.root, { includeProjectFacts: ["status", "doctor", "conversation-enter"].includes(parsed.command) });
    }
  }
  return (await runRoutedCommand(argv, { observationRegistry, compactionLifecycleHost, workerJobHost, workerJobSupervisor, workerPreparationBackend, signal, onProcess }));
}

async function runRoutedCommand(argv, { observationRegistry = null, compactionLifecycleHost = null, workerJobHost = null, workerJobSupervisor = null, workerPreparationBackend = null, signal, onProcess, projectSessionRoute = null } = {}) {
  const entry = commandEntry(argv);
  const { surface } = entry;
  const { command, root, options } = parse(entry.argv);
  requireOperationSurface(command, surface);
  if (command === "help" || command === "--help" || command === "-h") return usage({ surface });
  if (command === "help-all") return usage({ all: true, surface });
  if (command === "--version" || command === "version") return { name: ARTIFACT_COMPOSITION.pluginName, version: packageMetadata.version };
  if (command === "init" || command === "resume") return (await initializeOrResumeProject({
    root,
    projectSessionRoute,
    pluginRoot,
    runtimes: options.runtime?.split(","),
    profile: options.profile || "core",
    instructionIntegration: options["instruction-integration"] ?? null,
    onboarding: options.input ? inputJson(options, "Project onboarding") : null,
  }));
  if (command === "status" || command === "doctor") return (await inspectProjectExperience({ root }));
  if (command === "graph-query") return import("./lib/project-graph.mjs").then(({ queryProjectGraph }) => queryProjectGraph({ root, query: options.query || "", view: options.view || "all",
    paths: options.paths?.split(",") || [], anchorIds: options.anchors?.split(",") || [], depth: options.depth == null ? 1 : Number(options.depth),
    details: options.details === true || options.details === "true", maxNodes: options["max-nodes"] == null ? undefined : Number(options["max-nodes"]), maxEdges: options["max-edges"] == null ? undefined : Number(options["max-edges"]), worldModelId: options["world-model"] || "",
    inventoryPage: options["inventory-page"] === true || options["inventory-page"] === "true", inventoryPaths: options["inventory-paths"]?.split(","), inventoryCursor: options["inventory-cursor"] }));
  if (command === "graph-index") return import("./lib/project-graph.mjs").then(({ indexProjectGraph }) => indexProjectGraph({ root }));
  if (command === "graph-explorer") return import("./lib/graph-explorer.mjs").then(({ exportGraphExplorer }) => exportGraphExplorer({ root,
    query: options.query || "", anchorIds: options.anchors?.split(",") || [], paths: options.paths?.split(",") || [], layer: options.layer || "project",
    history: options.history === true, share: options.share === true, output: options.output || null }));
  if (command === "session-create") return createLodeSession({ root, sessionId: options["new-session"], purpose: options.purpose });
  if (command === "session-list") return readSessionWorkList({ root });
  if (command === "project-direction-read") return readProjectDirection({ root });
  if (command === "project-direction-update") return updateProjectDirection({ root, expectedDirectionId: options["expected-direction"] || null, input: inputJson(options, "Current user Project direction") });
  if (command === "runtime-adapters") return (await inspectRuntimeAdapters(root));
  if (command === "runtime-invocation-authorize") {
    const input = inputJson(options, "Runtime invocation authorization");
    requireOperationSurface(command, surface, { workerBound: input.worker != null });
    const allowed = new Set(["runtime", "scope", "workspaceMode", "runtimeSelection", "worker", "retry", "limits"]);
    const unexpected = Object.keys(input).filter((key) => !allowed.has(key));
    if (unexpected.length) throw new Error(`Runtime invocation authorization contains unsupported fields: ${unexpected.sort().join(", ")}`);
    return inspectRuntimeAdapters(root).then((runtimeStatus) => buildRuntimeInvocationAuthorization({
      ...input,
      root,
      protocolEvidence: runtimeStatus.protocolEvidence,
      projectBinding: runtimeStatus.projectBinding,
      persist: true,
    }));
  }
  if (command === "runtime-invocation-read") return (await preparedRuntimeRead(root, readRuntimeInvocationAuthorization({ root, authorizationId: options.authorization })));
  if (command === "worker-reconcile") return reconcileWorkerMember({ root, taskKey: options["task-key"] });
  if (command === "worker-prepare") {
    const allowed = new Set(["input", "task", "task-key", "role", "outcome", "context", "source", "propose", "model", "runtime", "timeout-ms", "instruction-scope", "context-mode"]);
    if (Object.keys(options).some(key => !allowed.has(key)) || options.input && Object.keys(options).length > 1) throw new Error("Worker preparation accepts one bounded task description, not Host configuration.");
    return (await prepareLocalBoundedWorker(options.input ? inputJson(options, "Worker preparation") : {
      task: options.task, taskKey: options["task-key"], role: options.role, outcome: options.outcome, selectedContext: options.context, contextMode: options["context-mode"],
      sourcePaths: options.source ? options.source.split(",") : [], proposalPaths: options.propose ? options.propose.split(",") : [],
      model: options.model, runtime: options.runtime, timeoutMs: options["timeout-ms"] == null ? undefined : Number(options["timeout-ms"]),
      instructionScope: options["instruction-scope"],
    }, { root, supervisorSelection: workerJobSupervisor, protocolFixtureBackend: workerPreparationBackend, signal, onProcess }));
  }
  if (command === "worker-start") {
    if (Object.keys(options).some(key => !["task-key", "authorization", "role"].includes(key))) throw new Error("Worker start does not accept Host configuration.");
    return (await startLocalBoundedWorker({ root, authorizationId: options.authorization, taskKey: options["task-key"], role: options.role }, { host: workerJobHost, supervisorSelection: workerJobSupervisor, onProcess }));
  }
  if (command === "worker-job-status") return readBoundedWorkerJob({ root, authorizationId: options.authorization }, { onProcess, inspectorSelection: workerJobSupervisor });
  if (command === "worker-job-patch") return readBoundedWorkerPatch({ root, authorizationId: options.authorization }, { onProcess, inspectorSelection: workerJobSupervisor });
  if (command === "worker-cancel") return cancelBoundedWorkerJob({ root, authorizationId: options.authorization }, { onProcess, inspectorSelection: workerJobSupervisor });
  if (command === "worker-job-reconcile") return reconcileBoundedWorkerJob({ root, authorizationId: options.authorization }, { onProcess, inspectorSelection: workerJobSupervisor });
  if (command === "worker-integrate") {
    const input = validateWorkerIntegrationRequest(inputJson(options, "Worker integration"));
    return (await operateWorkerIntegration(input, { root, onProcess, storage: resolveProjectStorage(root) }));
  }
  if (command === "worker-integration-status") {
    const input = validateWorkerIntegrationStatusRequest({ integrationId: options.integration, ...(options.verification ? { verificationId: options.verification } : {}) });
    return inspectWorkerIntegration(input, { root, storage: resolveProjectStorage(root) });
  }
  if (command === "runtime-invocation-lease-status") return inspectRuntimeInvocationExecutionLease({ root, authorizationId: options.authorization });
  if (command === "runtime-invocation-execute") {
    const authorization = readRuntimeInvocationAuthorization({ root, authorizationId: options.authorization }).authorization;
    requireRuntimeSurface(command, surface, root, authorization);
    const input = optionalInputJson(options, "Runtime invocation execution");
    const unexpected = Object.keys(input).filter((key) => key !== "sessionRequest");
    if (unexpected.length) throw new Error(`Runtime invocation execution contains unsupported fields: ${unexpected.sort().join(", ")}`);
    return inspectRuntimeAdapters(root).then(async (runtimeStatus) => (await executeRuntimeInvocation({
      root,
      authorization,
      sessionRequest: input.sessionRequest || "",
      signal,
      onProcessEvent: onProcess,
      protocolEvidence: runtimeStatus.protocolEvidence,
      projectBinding: runtimeStatus.projectBinding,
      persist: true,
    })));
  }
  if (command === "runtime-invocation-result") {
    validateRuntimeInvocationRecordIdentity(options.authorization);
    return readRuntimeInvocationResult({ root, authorizationId: options.authorization, storage: resolveProjectStorage(root) });
  }
  if (command === "runtime-invocation-apply-run-result") {
    const authorization = readRuntimeInvocationAuthorization({ root, authorizationId: options.authorization }).authorization;
    requireRuntimeSurface(command, surface, root, authorization);
    return applyRuntimeRunResult({ root, authorizationId: options.authorization, storage: resolveProjectStorage(root) });
  }
  if (command === "worker-dispatch") return createBoundedWorkerDispatch({ root, authorizationId: options.authorization, role: options.role });
  if (command === "worker-read") return readBoundedWorkerDispatch({ root, authorizationId: options.authorization });
  if (command === "worker-wait") return (await waitForBoundedWorkerDispatch({
    root,
    authorizationId: options.authorization,
    timeoutMs: options["wait-timeout-ms"] == null ? 0 : Number(options["wait-timeout-ms"]),
  }));
  if (command === "worker-execute") {
    const input = options.input ? inputJson(options, "Bounded worker execution") : {};
    const unexpected = Object.keys(input).filter((key) => key !== "sessionRequest");
    if (unexpected.length) throw new Error(`Bounded worker execution contains unsupported fields: ${unexpected.sort().join(", ")}`);
    return inspectRuntimeAdapters(root).then(async (runtimeStatus) => (await executeBoundedWorkerDispatch({
      root,
      authorizationId: options.authorization,
      role: options.role,
      execution: {
        sessionRequest: input.sessionRequest ?? "",
        signal,
        onProcessEvent: onProcess,
        protocolEvidence: runtimeStatus.protocolEvidence,
        projectBinding: runtimeStatus.projectBinding,
      },
    })));
  }
  if (command === "worker-apply") return applyBoundedWorkerDispatchResult({ root, authorizationId: options.authorization });
  if (command === "worker-wave-create") {
    const input = inputJson(options, "Bounded worker wave");
    const unexpected = Object.keys(input).filter((key) => key !== "authorizationIds");
    if (unexpected.length) throw new Error(`Bounded worker wave contains unsupported fields: ${unexpected.sort().join(", ")}`);
    return createBoundedWorkerWave({ root, authorizationIds: input.authorizationIds });
  }
  if (command === "worker-wave-read") return readBoundedWorkerWave({ root, waveId: options.wave });
  if (command === "worker-wave-seal") return sealBoundedWorkerWave({ root, waveId: options.wave });
  if (command === "worker-wave-status") return readBoundedWorkerWaveStatus({ root, waveId: options.wave });
  if (command === "worker-wave-results") return readBoundedWorkerWaveResults({ root, waveId: options.wave });
  if (command === "worker-wave-wait") return (await waitForBoundedWorkerWave({
    root,
    waveId: options.wave,
    timeoutMs: options["wait-timeout-ms"] == null ? 0 : Number(options["wait-timeout-ms"]),
  }));
  if (command === "worker-wave-abandon") {
    const input = inputJson(options, "Bounded worker wave abandonment");
    const allowed = new Set(["waveId", "reasonCode", "reasonSummary"]);
    const unexpected = Object.keys(input).filter((key) => !allowed.has(key));
    if (unexpected.length) throw new Error(`Bounded worker wave abandonment contains unsupported fields: ${unexpected.sort().join(", ")}`);
    return abandonBoundedWorkerWave({ root, waveId: input.waveId, reasonCode: input.reasonCode, reasonSummary: input.reasonSummary || "" });
  }
  if (command === "onboarding-start") return (await startOnboarding({ ...optionalInputJson(options, "Onboarding start"), root }));
  if (command === "onboarding-semantic-refresh") {
    const input = inputJson(options, "Fresh onboarding semantic proposal");
    return (await proposeOnboardingSemanticRefresh({ root, semanticProposal: input.semanticProposal || input, recoveryBasis: input.recoveryBasis || null }));
  }
  if (command === "onboarding-candidate-restore") return restoreOnboardingCandidate({ ...inputJson(options, "Exact candidate restoration"), root });
  if (command === "onboarding-status") return (await inspectOnboarding({ root }));
  if (command === "onboarding-review") return (await reviewOnboarding({ ...inputJson(options, "Onboarding ReviewDecision"), root }));
  if (command === "onboarding-candidates") return readOnboardingCandidateSet({ root, candidateSetId: options["candidate-set"] });
  if (command === "onboarding-review-read") return readOnboardingReviewDecision({ root, reviewDecisionId: options.review });
  if (command === "source-scope-set") {
    const inspected = inspectProject(root);
    if (inspected.status !== "ready") throw new Error(`Project must be ready to configure source scope; current status: ${inspected.status}.`);
    return writeRepositorySourceScope({ projectRoot: inspected.project.projectRoot, selection: inputJson(options, "Repository source scope"), storage: inspected.storage });
  }
  if (command === "source-scope-status") {
    const inspected = inspectProject(root);
    if (inspected.status === "not_initialized") throw new Error("Lode Agent Core is not initialized.");
    return readRepositorySourceScope({ projectRoot: inspected.project.projectRoot, storage: inspected.storage });
  }
  if (command === "feature-mapping-start") return (await startFeatureMapping({ root, semanticProposal: options.input ? inputJson(options, "Feature mapping semantic proposal") : null, expectedCandidateSetId: options["expected-candidate-set"] ?? null }));
  if (command === "feature-mapping-status") return (await inspectFeatureMapping({ root }));
  if (command === "feature-mapping-review") return (await reviewFeatureMapping({ ...inputJson(options, "Feature mapping ReviewDecision"), root }));
  if (command === "feature-mapping-candidates") return readFeatureMappingCandidateSet({ root, candidateSetId: options["candidate-set"] });
  if (command === "feature-mapping-review-read") return readFeatureMappingReviewDecision({ root, reviewDecisionId: options.review });
  if (command === "change-set-record") return (await recordChangeSet({ ...inputJson(options, "ChangeSet"), root }));
  if (command === "change-set-status") return (await inspectChangeSets({ root }));
  if (command === "change-set-read") return readChangeSet({ root, changeSetId: options["change-set"] });
  if (command === "change-impact-candidates") return readChangeImpactCandidateSet({ root, candidateSetId: options["candidate-set"] });
  if (command === "change-impact-review") return (await reviewChangeImpact({ ...inputJson(options, "Change impact ReviewDecision"), root }));
  if (command === "change-impact-review-read") return readChangeImpactReviewDecision({ root, reviewDecisionId: options.review });
  if (command === "change-set-vcs-attach") return (await attachVcsEvidence({ ...inputJson(options, "VCS evidence attachment"), root }));
  if (command === "change-set-vcs-read") return readVcsEvidence({ root, vcsEvidenceId: options["vcs-evidence"] });
  if (command === "conformance-prepare") return (await prepareConformanceAssessment({ root, limit: options.limit == null ? 32 : Number(options.limit), projectionId: options.projection || "", cursor: options.cursor || "" }));
  if (command === "conformance-propose") return (await proposeConformanceFindings({ ...inputJson(options, "Conformance provider-Lode proposal"), root }));
  if (command === "conformance-queue") return (await inspectConformanceQueue({ root, status: options.status || "all", riskHint: options["risk-hint"] || "", limit: options.limit == null ? 25 : Number(options.limit), projectionId: options.projection || "", cursor: options.cursor || "", canonAnchor: options["canon-kind"] != null || options["canon-key"] != null ? { entityKind: options["canon-kind"], entityKey: options["canon-key"] } : null }));
  if (command === "conformance-read") return readConformanceFinding({ root, findingId: options.finding });
  if (command === "conformance-disposition") return (await recordConformanceDisposition({ ...inputJson(options, "Conformance user disposition"), root }));
  if (command === "conformance-resolution-propose") return (await proposeConformanceResolution({ ...inputJson(options, "Conformance provider-Lode resolution"), root }));
  if (command === "product-policy-propose") return (await proposeProductPolicy({ ...inputJson(options, "Product Policy proposal"), root }));
  if (command === "product-policy-review") return (await reviewProductPolicy({ ...inputJson(options, "Product Policy ReviewDecision"), root }));
  if (command === "product-policy-status") return inspectProductPolicyStatus({ root, candidateId: options.candidate });
  if (command === "product-policy-candidate-read") return readProductPolicyCandidate({ root, candidateId: options.candidate });
  if (command === "product-policy-review-read") return readProductPolicyReviewDecision({ root, reviewDecisionId: options.review });
  if (command === "metric-define") return (await defineMetric({ ...inputJson(options, "Metric definition"), root }));
  if (command === "metric-observe") return (await recordMetricObservation({ ...inputJson(options, "Metric observation"), root }));
  if (command === "metric-compare") return (await compareMetricObservations({ ...inputJson(options, "Metric comparison"), root }));
  if (command === "metric-assess") return (await assessMetricComparison({ ...inputJson(options, "Metric assessment"), root }));
  if (command === "metric-status") return inspectMeasurements({ root });
  if (command === "metric-trace") return (await traceMeasurementLineage({ root, anchorId: options.anchor || "", metricKey: options.metric || "", typeVersion: options["type-version"] || "", depth: options.depth == null ? 3 : Number(options.depth) }));
  if (command === "product-signal-record") return (await recordProductSignal({ ...inputJson(options, "ProductSignal"), root }));
  if (command === "product-hypothesis-record") return (await recordProductHypothesis({ ...inputJson(options, "ProductHypothesis"), root }));
  if (command === "product-initiative-propose") return (await proposeProductInitiative({ ...inputJson(options, "ProductInitiativeCandidate"), root }));
  if (command === "product-initiative-review") return (await reviewProductInitiative({ ...inputJson(options, "Product Initiative ReviewDecision"), root }));
  if (command === "product-outcome-observe") return (await observeProductOutcome({ ...inputJson(options, "OutcomeObservation"), root }));
  if (command === "product-operating-status") return inspectProductOperatingLoop({ root, fresh: options.fresh === true });
  if (command === "release-observe") return (await observeReleaseState({ root, input: inputJson(options, "DeploymentResultObservation") }));
  if (command === "release-status") return inspectReleaseObservations({ root });
  if (command === "delivery-observe") return (await recordDeliveryObservation({ ...inputJson(options, "Delivery observation"), root }));
  if (command === "delivery-status") return inspectDeliveryState({ root, environmentKey: options.environment || "", targetKey: options.target || "", historyLimit: options["history-limit"] == null ? 100 : Number(options["history-limit"]) });
  if (command === "observation-sources") return inspectObservationSources({
    root,
    registry: observationRegistry,
    typeKey: options["type-key"] || "",
    adapterKey: options["adapter-key"] || "",
    availabilityState: options.availability || "",
    limit: options.limit == null ? undefined : Number(options.limit),
    projectionId: options.projection || "",
    cursor: options.cursor || "",
  });
  if (command === "observation-prepare") return prepareObservationEvidence({
    root,
    registry: observationRegistry,
    typeKey: options["type-key"],
    subjectType: options["subject-type"] || "",
    subjectKey: options["subject-key"] || "",
    adapterKey: options["adapter-key"] || "",
    observedAfter: options["observed-after"] || "",
    observedBefore: options["observed-before"] || "",
    existingLimit: options["existing-limit"] == null ? 20 : Number(options["existing-limit"]),
    sourceLimit: options["source-limit"] == null ? 20 : Number(options["source-limit"]),
    sourceAvailability: options["source-availability"] || "",
    sourceProjectionId: options["source-projection"] || "",
    sourceCursor: options["source-cursor"] || "",
  });
  if (command === "observation-source-collect") return (await collectRegisteredObservation({ root, registry: observationRegistry, sourceId: options.source }));
  if (command === "observation-ingest") {
    const value = inputJson(options, "Observation collection");
    return (await ingestStructuredObservation({ root, binding: value.binding, descriptor: value.descriptor, input: value.input }));
  }
  if (command === "observation-file-ingest") {
    const value = inputJson(options, "Host JSON Observation source");
    return (await ingestJsonObservationEventFile({
      root,
      sourceKey: value.sourceKey,
      binding: value.binding,
      descriptor: value.descriptor,
      eventFile: value.eventFile,
      maxBytes: value.maxBytes,
    }));
  }
  if (command === "observation-derive") {
    const value = inputJson(options, "Derived Observation");
    return recordDerivedObservation({ root, descriptor: value.descriptor, input: value.input });
  }
  if (command === "observation-read") return readObservation({ root, observationId: options.observation });
  if (command === "observation-query") return queryObservations({
    root,
    typeKey: options["type-key"] || "",
    subjectType: options["subject-type"] || "",
    subjectKey: options["subject-key"] || "",
    adapterKey: options["adapter-key"] || "",
    observedAfter: options["observed-after"] || "",
    observedBefore: options["observed-before"] || "",
    recordKind: options["record-kind"] || "all",
    limit: options.limit == null ? 25 : Number(options.limit),
    projectionId: options.projection || "",
    cursor: options.cursor || "",
  });
  if (command === "head-continuity") return buildLodeContinuitySnapshot({ root, fresh: options.fresh === true });
  if (command === "world-index") return (await buildWorldModel({
    root,
    persist: true,
    gitHistoryAdapter: options["git-log"] ? new GitLogFileHistoryAdapter({ file: options["git-log"] }) : null,
    runtimeStateAdapter: options["runtime-state"] ? new RuntimeStateFileAdapter({ file: options["runtime-state"] }) : null,
    parentSourceSnapshotIds: options["parent-snapshot"] ? options["parent-snapshot"].split(",").map((item) => item.trim()).filter(Boolean) : [],
    revisionParentIds: options["revision-parents"] ? readJsonFile(options["revision-parents"], "Revision parent map") : {},
  }));
  if (command === "storage-gc") {
    const inspection = inspectSnapshotGarbageCollection({ root, apply: options.apply === true || options.apply === "true" });
    try { inspection.typedClosure = await inspectSnapshotPreservationClosure({ root }); }
    catch (error) { inspection.typedClosure = { status: "partial-preserved", reasonCode: error.code || "TYPED_CLOSURE_UNAVAILABLE", deletedCount: 0 }; }
    return inspection;
  }
  if (command === "world-status") return (await inspectWorldModel({ root }));
  if (command === "world-refresh") return (await refreshWorldModel({
    root,
    triggerKind: "manual",
    triggerEvidenceIds: options["trigger-evidence"] ? options["trigger-evidence"].split(",").map((item) => item.trim()).filter(Boolean) : [],
    expectedChangedPaths: options["expect-changed"] == null ? null : options["expect-changed"].split(",").map((item) => item.trim()).filter(Boolean),
    additionalParentSourceSnapshotIds: options["parent-snapshot"] ? options["parent-snapshot"].split(",").map((item) => item.trim()).filter(Boolean) : [],
  }));
  if (command === "world-refresh-status") return (await inspectIncrementalRefresh({ root }));
  if (command === "world-refresh-read") return (await readIncrementalRefreshReceipt({ root, refreshReceiptId: options.receipt }));
  if (command === "world-refresh-events") {
    const input = inputJson(options, "Refresh trigger event ingestion");
    const unexpected = Object.keys(input).filter((key) => !["sourceKind", "events", "maxEvents"].includes(key));
    if (unexpected.length) throw new Error(`Refresh trigger event ingestion contains unsupported fields: ${unexpected.sort().join(", ")}`);
    if (input.sourceKind !== "ci") throw new Error("world-refresh-events accepts only sourceKind ci; use world-refresh-watch for filesystem events.");
    return (await processRefreshTriggerBatch({ root, ...input }));
  }
  if (command === "world-refresh-watch") return (await runFileSystemRefreshWatcher({
    root,
    debounceMs: options["debounce-ms"] == null ? undefined : Number(options["debounce-ms"]),
    maxEvents: options["max-events"] == null ? undefined : Number(options["max-events"]),
  }));
  if (command === "world-refresh-trigger-status") return (await inspectRefreshTriggers({ root }));
  if (command === "world-refresh-trigger-read") return (await readRefreshTriggerDelivery({ root, triggerDeliveryId: options.delivery }));
  if (command === "world-graph-status") return (await inspectWorldGraphProjection({ root }));
  if (command === "world-graph-remote-database-status") return inspectArcadeDbDatabaseCompatibility({ root, storage: resolveProjectStorage(root) });
  if (command === "world-graph-remote-database-initialize") return initializeArcadeDbDatabase({
    root,
    storage: resolveProjectStorage(root),
    resetIncompatible: options["reset-incompatible"] === "true",
    confirmDatabase: options["confirm-database"] || "",
  });
  if (command === "world-graph-remote-activate") return (await activateArcadeDbGraphProjection({ root }));
  if (command === "world-graph-remote-status") return (await inspectArcadeDbGraphProjectionStatus({ root }));
  if (command === "world-docs-build") return (await materializeWorldMarkdownProjection({ root }));
  if (command === "world-docs-status") return (await inspectWorldMarkdownProjection({ root }));
  if (command === "world-docs-capture") return (await captureWorldMarkdownChanges({ root, persist: true }));
  if (command === "world-docs-candidates") return readWorldDocumentChangeCandidateSet({ root, candidateSetId: options["candidate-set"] });
  if (command === "world-docs-review") {
    const input = inputJson(options, "Document-change ReviewDecision");
    const allowed = new Set(["candidateSetId", "disposition", "acceptedCandidateIds", "resultingProductModel", "rationale", "apply"]);
    const unexpected = Object.keys(input).filter((key) => !allowed.has(key));
    if (unexpected.length) throw new Error(`Document-change ReviewDecision contains unsupported fields: ${unexpected.sort().join(", ")}`);
    return (await reviewDocumentChanges({ ...input, root }));
  }
  if (command === "world-docs-apply") return (await applyDocumentChangeReview({ root, reviewDecisionId: options.review }));
  if (command === "world-docs-review-status") return (await inspectDocumentChangeReviewStatus({ root, candidateSetId: options["candidate-set"] }));
  if (command === "world-docs-review-read") return readDocumentChangeReviewDecision({ root, reviewDecisionId: options.review });
  if (command === "world-docs-application-read") return readDocumentChangeApplicationReceipt({ root, applicationReceiptId: options.application });
  if (command === "world-docs-policy-set") {
    const input = inputJson(options, "Post-refresh document projection policy");
    const unexpected = Object.keys(input).filter((key) => key !== "mode");
    if (unexpected.length) throw new Error(`Post-refresh document projection policy contains unsupported fields: ${unexpected.sort().join(", ")}`);
    return setPostRefreshProjectionPolicy({ root, mode: input.mode });
  }
  if (command === "world-docs-policy-status") return inspectPostRefreshProjectionPolicy({ root });
  if (command === "world-docs-refresh-status") return (await inspectPostRefreshProjectionStatus({ root }));
  if (command === "world-docs-refresh-read") return (await readPostRefreshProjectionReceipt({ root, postRefreshProjectionReceiptId: options.receipt }));
  if (command === "world-query") return (await queryWorldModel({
    root,
    query: options.query,
    depth: options.depth == null ? 1 : Number(options.depth),
    maxResults: options.limit == null ? 100 : Number(options.limit),
  }));
  if (command === "world-temporal") return (await queryWorldTemporalGraph({
    root,
    query: options.query,
    anchorIds: options["anchor-ids"] ? options["anchor-ids"].split(",").map((item) => item.trim()).filter(Boolean) : null,
    expectedGraphSnapshotId: options["graph-snapshot"] || null,
    kinds: options.kind ? options.kind.split(",").map((item) => item.trim()).filter(Boolean) : null,
    relations: options.relations ? options.relations.split(",").map((item) => item.trim()).filter(Boolean) : null,
    includeUnreviewedCandidates: options["include-candidates"] === "true",
    minConfidence: options["min-confidence"] == null ? 0 : Number(options["min-confidence"]),
    depth: options.depth == null ? 1 : Number(options.depth),
    maxNodes: options.limit == null ? 100 : Number(options.limit),
    maxEdges: options["edge-limit"] == null ? 200 : Number(options["edge-limit"]),
  }));
  if (command === "world-history") return (await queryWorldHistory({
    root,
    query: options.query || "",
    limit: options.limit == null ? 50 : Number(options.limit),
  }));
  if (command === "graph-lineage-status") return (await inspectGraphLineage({
    root,
    cursor: options.cursor || "",
    limit: options.limit == null ? 25 : Number(options.limit),
  }));
  if (command === "graph-lineage-trace") return (await traceGraphLineage({
    root,
    worldModelId: options.world || "",
    anchorId: options.anchor || "",
    query: options.query || "",
    depth: options.depth == null ? 2 : Number(options.depth),
    maxNodes: options.limit == null ? 100 : Number(options.limit),
    maxEdges: options["edge-limit"] == null ? 200 : Number(options["edge-limit"]),
    includeExecution: options["include-execution"] !== "false",
  }));
  if (command === "graph-lineage-diff") return (await diffGraphLineage({
    root,
    fromWorldModelId: options.from,
    toWorldModelId: options.to,
    limit: options.limit == null ? 100 : Number(options.limit),
    scopePaths: options.path ? [options.path] : null,
    cursor: options.cursor || "",
  }));
  if (command === "world-runtime") return (await queryWorldRuntimeState({
    root,
    query: options.query || "",
    runtime: options.runtime || "",
    state: options.state || "",
    kind: options.kind || "",
    limit: options.limit == null ? 50 : Number(options.limit),
  }));
  if (command === "checkpoint") return createRecoveryCheckpoint({
    root,
    purpose: options.summary,
    currentPosition: options.summary,
    nextExpectedResult: options.next || options.summary,
    approvedDecisions: [],
    openReviewIds: [],
  });
  if (command === "checkpoint-basis") return inspectRecoveryCheckpointBasis({ root });
  if (command === "checkpoint-diagnose") return inspectRecoveryCheckpointDiagnosis({ root });
  if (command === "checkpoint-sync") return syncRecoveryCheckpoint({ ...inputJson(options, "Recovery checkpoint sync"), root });
  if (command === "session-work-record") return recordSessionWorkEvidence({ root, input: inputJson(options, "Selected Session work evidence") });
  if (command === "session-work-read") return readSessionWorkContext({ ...(options.input ? inputJson(options, "Session work read") : {}),
    ...(options["scan-evidence"] !== undefined ? { scanEvidence: options["scan-evidence"] === true || options["scan-evidence"] === "true" } : {}),
    ...(options["after-evidence-id"] !== undefined ? { afterEvidenceId: options["after-evidence-id"] } : {}), root });
  if (command === "session-restore") return restoreSessionFromArtifacts({ root, checkpointId: options.checkpoint || null });
  if (command === "session-continue") {
    return continueSessionFromArtifacts({
      root,
      checkpointId: options.checkpoint || null,
      runtime: options.runtime,
    });
  }
  if (command === "compact-prepare") return prepareCompaction({ ...inputJson(options, "Compaction prepare"), root });
  if (command === "compact-verify") return verifyCompaction({ ...inputJson(options, "Compaction verification"), root });
  if (command === "compact-continue") return continueCompaction({ ...inputJson(options, "Compaction continuation"), root });
  if (command === "compact-status") return inspectCompaction({ root });
  if (command === "compact-abort") return abortCompaction({ ...inputJson(options, "Compaction abort"), root });
  if (command === "conversation-enter") return (await enterConversationRecovery({ root }));
  if (command === "compaction-lifecycle-step") return (await processCompactionLifecycle({
    root,
    hostAdapter: compactionLifecycleHost,
    direction: options.input ? inputJson(options, "Lode compaction direction") : null,
  }));
  if (command === "lineage-plan") return createWholePlanSnapshot({ ...inputJson(options, "Whole plan"), root, persist: true });
  if (command === "lineage-next-plan") return createNextWholePlanSnapshot({ ...inputJson(options, "Next whole plan"), root, persist: true });
  if (command === "lineage-contract") return createExecutionContract({ ...inputJson(options, "Execution Contract"), root, persist: true });
  if (command === "run-start") return startRun({ root, executionContractId: options.contract, startRequestId: options["start-request"] });
  if (command === "run-finish") return finishRun({ ...inputJson(options, "Result Packet"), root });
  if (command === "run-review-context") return getPendingReviewContext({ root });
  if (command === "run-review") return reviewRun({ ...inputJson(options, "ReviewDecision"), root });
  if (command === "run-integrate-checkpoint") return integrateReviewedRunCheckpoint({ ...inputJson(options, "Run result integration"), root });
  if (command === "run-integration-read") return readRunResultIntegration({ root, reviewDecisionId: options.review });
  if (command === "context-prepare") return (await prepareContextWorkflow({ root, task: options.task, budget: options.budget == null ? DEFAULT_CONTEXT_BUDGET : Number(options.budget) }));
  if (command === "source-context") return (await prepareSourceContext({ root, task: options.task,
    needs: options.input ? inputJson(options, "Source needs").needs : options.source ? [{ kind: options.kind ?? (options.symbol ? "outgoing-calls" : "source"), path: options.source, symbol: options.symbol ?? "", required: options.required !== "false" }] : [],
    retain: options.retain === "true", budget: options.budget == null ? undefined : Number(options.budget), signal, onProcess,
    timeoutMs: options.timeout == null ? 15_000 : Number(options.timeout) }));
  if (command === "source-observation-read") return inspectSourceObservation({ root, bundleKey: options.bundle, failureKey: options.failure });
  if (command === "context-preview") return (await previewContextWorkflow({ root, task: options.task, budget: options.budget == null ? DEFAULT_CONTEXT_BUDGET : Number(options.budget), evidenceNeeds: evidenceNeedsInput(options) }));
  if (command === "context-compile") return (await compileContext({ root, task: options.task, budget: options.budget == null ? DEFAULT_CONTEXT_BUDGET : Number(options.budget), evidenceNeeds: evidenceNeedsInput(options), persist: true }));
  if (command === "context-read") return readContextCapsule({ root, capsuleId: options.capsule });
  if (command === "lineage-read") return readLineageArtifact({ root, artifactId: options.artifact });
  throw new Error(`Unknown command: ${command}`);
}

export function runCliMain(directArgs = process.argv.slice(2)) {
  const jsonOutput = directArgs.includes("--json");
  const withoutJson = directArgs.filter((item) => item !== "--json");
  const directCommand = commandEntry(withoutJson).argv[0] || "help";
  const normalizedArgs = withoutJson.filter(item => directCommand !== "graph-query" || item !== "--diagnostics");
  const sourceController = new AbortController();
  const abortSource = () => sourceController.abort();
  if (["source-context", "worker-execute", "runtime-invocation-execute"].includes(directCommand)) {
    process.on("SIGINT", abortSource); process.on("SIGTERM", abortSource);
  }
  return Promise.resolve().then(async () => (await runCommand(normalizedArgs, { signal: sourceController.signal,
    onProcess: (event) => process.stderr.write(`${JSON.stringify({ sourceProcess: event })}\n`) }))).then((result) => {
    if (directCommand === "storage-gc" && result?.requestedApply && result.applyAvailable === false) process.exitCode = 1;
    process.stdout.write(jsonOutput ? `${JSON.stringify(result, null, 2)}\n` : formatCliResult(directCommand, result, { diagnostics: directArgs.includes("--diagnostics") }));
  }).catch((error) => {
    const failure = { status: "failed", code: error.code || "HEAD_CLI_ERROR", error: error.message };
    process.stdout.write(jsonOutput ? `${JSON.stringify(failure, null, 2)}\n` : formatCliError(error));
    process.exitCode = 1;
  }).finally(() => {
    process.removeListener("SIGINT", abortSource); process.removeListener("SIGTERM", abortSource);
  });
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) runCliMain();

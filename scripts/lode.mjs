#!/usr/bin/env node
import { inspectSnapshotPreservationClosure } from "./lib/snapshot-preservation-closure.mjs";
import { inspectSnapshotGarbageCollection, applySnapshotGarbageCollection } from "./lib/snapshot-gc.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARTIFACT_COMPOSITION } from "./lib/lode-artifact-composition.mjs";
import { callRegistered, registeredCommand } from "./lib/operation-registry.mjs";
import { commandEntry, isManagedMutation, requireOperationSurface, requireSurface } from "./lib/managed-maintenance-surface.mjs";
import { inspectProject, inspectRuntimeAdapters } from "./lib/lode-core.mjs";
import { withSessionCallContext, sessionCallRequiresBinding, sessionSelectionUnresolved, createLodeSession } from "./lib/session-routing.mjs";
import {
  operateWorkerIntegration,
  inspectWorkerIntegration,
  validateWorkerIntegrationRequest,
  validateWorkerIntegrationStatusRequest,
} from "./lib/worker-integration-workflow.mjs";
import { resolveProjectStorage } from "./lib/project-storage-format.mjs";
import { validateRuntimeInvocationRecordIdentity } from "./lib/runtime-invocation-record.mjs";
import { compileContext, DEFAULT_CONTEXT_BUDGET } from "./lib/context-compiler.mjs";
import { createExecutionContract, createNextWholePlanSnapshot, createWholePlanSnapshot } from "./lib/execution-lineage.mjs";
import { GitLogFileHistoryAdapter } from "./lib/git-history.mjs";
import { RuntimeStateFileAdapter } from "./lib/runtime-state.mjs";
import { finishRun, reviewRun } from "./lib/run-lineage.mjs";
import { buildWorldModel, captureWorldMarkdownChanges, inspectWorldModel } from "./lib/world-model.mjs";
import { readOnboardingCandidateSet, readOnboardingReviewDecision, startOnboarding } from "./lib/onboarding.mjs";
import { readFeatureMappingCandidateSet, readFeatureMappingReviewDecision } from "./lib/feature-mapping.mjs";
import {
  attachVcsEvidence,
  readChangeImpactCandidateSet,
  readChangeImpactReviewDecision,
  readChangeSet,
  recordChangeSet,
  reviewChangeImpact,
} from "./lib/change-set.mjs";
import { refreshWorldModel } from "./lib/incremental-refresh.mjs";
import { processRefreshTriggerBatch, runFileSystemRefreshWatcher } from "./lib/refresh-trigger.mjs";
import { inspectPostRefreshProjectionPolicy, setPostRefreshProjectionPolicy } from "./lib/post-refresh-projection.mjs";
import { applyDocumentChangeReview, reviewDocumentChanges } from "./lib/document-change-review.mjs";
import { activateArcadeDbGraphProjection } from "./lib/graphdb-projection-activation.mjs";
import { initializeArcadeDbDatabase } from "./lib/arcadedb-database-lifecycle.mjs";
import { buildRuntimeInvocationAuthorization, readRuntimeInvocationAuthorization } from "./lib/runtime-invocation-lifecycle.mjs";
import { executeRuntimeInvocation } from "./lib/runtime-one-shot-exec.mjs";
import { applyRuntimeRunResult, readRuntimeInvocationResult } from "./lib/runtime-run-result-application.mjs";
import { readRepositorySourceScope, writeRepositorySourceScope } from "./lib/repository-source-scope.mjs";
import { initializeOrResumeProject, inspectProjectExperience, inspectProjectLocationExperience } from "./lib/project-bootstrap.mjs";
import { buildLodeContinuitySnapshot } from "./lib/product-operating-loop.mjs";
import { ingestJsonObservationEventFile } from "./lib/observation-adapter.mjs";
import { formatCliError, formatCliResult } from "./lib/cli-presentation.mjs";
import { createRecoveryCheckpoint } from "./lib/compaction-recovery.mjs";
import { readSessionWorkList } from "./lib/session-work-context.mjs";
import { continueSessionFromArtifacts } from "./lib/runtime-session-continuation.mjs";
import { executeBoundedWorkerDispatch, readBoundedWorkerDispatch } from "./lib/bounded-worker-dispatch.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageMetadata = JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"), "utf8"));

export function parse(argv) {
  const [command = "help", root = ".", ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) throw new Error(`Unexpected argument: ${item}`);
    const key = item.slice(2);
    if (command === "storage-gc" && ["apply", "diagnostics"].includes(key)) {
      options[key] = true;
      continue;
    }
    if (["init", "resume"].includes(command) && key === "write-root-instructions") {
      options[key] = true;
      continue;
    }
    if (command === "graph-explorer" && ["history", "share"].includes(key)) {
      options[key] = true;
      continue;
    }
    if (key === "details" || (command === "session-work-read" && key === "scan-evidence") || (command === "graph-query" && key === "inventory-page")) {
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
    `${cliDisplay} init <project> [--runtime claude,codex,opencode] [--profile core|product] [--copied-project verified-copy] [--input <onboarding.json>] [--instruction-integration link|preserve] [--write-root-instructions]`,
    `${cliDisplay} resume <project> [--runtime claude,codex,opencode] [--profile core|product] [--copied-project verified-copy] [--input <onboarding.json>] [--instruction-integration link|preserve]`,
    `${cliDisplay} --version`,
    `${cliDisplay} status <project>`,
    `${cliDisplay} doctor <project>`,
    `${cliDisplay} graph-query <project> --query <text> [--view all|work|product] [--paths <path,...>] [--anchors <id,...>] [--depth <n>] [--max-nodes <n>] [--max-edges <n>] [--world-model <id>] [--details] [--inventory-page --inventory-paths <owned-path,...> --inventory-cursor <returned-cursor>]`,
    `${cliDisplay} graph-index <project>`,
    `${cliDisplay} graph-explorer <project> [--layer project|code] [--query <text-or-source>] [--anchors <id,...>] [--paths <path,...>] [--history] [--share] [--output <new-file.html>]`,
    `${cliDisplay} project-export <project> --destination <bundle-folder> [--provenance project-proof-metadata|selected-only] [--sources selected-retained-sources|refs-only] [--session <logical-session>] (default: project-proof-metadata)`,
    `${cliDisplay} project-bundle-inspect <bundle-folder-or-HANDOFF.md> [--expected-bundle <bundle-id>] [--handoff-offset <bytes> --handoff-max-bytes <bytes>]`,
    `${cliDisplay} project-import <target-project> --bundle <bundle-folder> [--expected-bundle <bundle-id>]`,
    `${cliDisplay} project-native-history <bundle-folder> --action read|capture|restore|register [--provider codex|claude|opencode] [--native-home <exact-data-home> --executable <exact-client>] [--threads <exact-native-id,...>] [--runtime-root <current-workspace>]`,
    `${cliDisplay} session-create <project> [--purpose <text>] [--new-session <session-id>]  # session-id format: session-<36 hex digits and hyphens>, e.g. session-12345678-1234-1234-1234-123456789abc; omit to generate one`,
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
    `${cliDisplay} storage-gc <project> [--apply]  # inspect; explicitly reclaim verified orphan snapshot storage`,
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
    `${cliDisplay} checkpoint-sync <project> --input <head-direction.json>  # JSON keys: expectedRecoveryBasisId (recovery-basis-<24 hex>, from checkpoint-basis), purpose, currentPosition, nextExpectedResult (required text); optional approvedDecisions[], openReviewIds[], workEvidence`,
    `${cliDisplay} session-work-record <project> --input <selected-work-evidence.json> [--document-selection <HEAD-selection.json>]  # JSON keys (at least one meaningful): summary, judgments[{assessment,reason,alternatives[]}], observedWork[], pending[], unknowns[], suggestedFollowUp[], references[{path,digest,kind}], todos[{todoId,task,status,origin,nextAction}], workTopics[], workLink, executionObservation, occurrenceKey; e.g. {"summary":"Fixed the login timeout","pending":["Add a regression test"]}`,
    `${cliDisplay} work-document-prepare <project> --input <HEAD-selected-exact-evidence.json>`,
    `${cliDisplay} work-document-configure <project> --input <user-selected-destinations.json>`,
    `${cliDisplay} work-document-publish <project> --input <prepared-document-and-targets.json>`,
    `${cliDisplay} work-document-status <project> [--logical-key <key>]`,
    `${cliDisplay} project-document-prepare <project> --input <HEAD-project-selection.json>`,
    `${cliDisplay} project-document-publish <project> --input <prepared-project-and-targets.json>`,
    `${cliDisplay} project-document-status <project>`,
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
    ...(all || surface === "managed-maintenance"
      ? {
          commandNotes: {
            "project-native-history":
              "capture requires --provider; read/restore/register derive it only from a verified companion link. Claude/OpenCode effects also require --runtime-root; optional Claude --companions <selected-id/relative-file,...>. OpenCode source capture requires a registered Host export capability; its default CLI bootstrap remains unavailable pending qualification. A pinned Windows x64 baseline 1.19.5 binary can restore/register through an existing qualified isolated DB and current Project mapping, with whole-batch atomic publication and no app startup or automatic migration. The isolated destination workflow never switches the default profile.",
          },
        }
      : {}),
    surface: surface === "managed-maintenance" ? surface : all ? "ordinary-complete" : "light-default",
    commands:
      surface === "managed-maintenance"
        ? allCommands.map((line) => line.replace(cliDisplay + " ", cliDisplay + " managed-maintenance "))
        : all
          ? allCommands.filter((line) => !isManagedMutation(line.split(" ")[1]))
          : defaultCommands,
    // Command lines name the installer-created launcher; every install also has
    // the node entry point. Explain both spellings once.
    launcherNote: `${cliDisplay} exists only when scripts/install.sh or scripts/install.ps1 created that launcher; otherwise run node <plugin-root>/scripts/${ARTIFACT_COMPOSITION.identity}.mjs with the same arguments.`,
    laneRecommendationRequired: false,
    executionMeans: {
      default: ARTIFACT_COMPOSITION.identity === "head" ? "head-direct" : "lode-direct",
      delegation: "existing-host-tools-when-useful",
      delegationReasons: ["independently-reviewable-result", "preserve-judgment-context-in-long-sequential-work"],
      managedWhen: ["durable-ownership", "recovery-after-interruption", "effect-retry-or-duplicate-integration-control"],
      managedSelectionIsAutomatic: false,
      contextTransfer: "fork-or-fresh-is-separate-from-execution-and-authority",
      requiresUserSelection: false,
      hostFallback: [ARTIFACT_COMPOSITION.identity === "head" ? "head-direct" : "lode-direct", "sequential"],
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
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${label} input is invalid JSON: ${error.message}`);
  }
}

function optionalInputJson(options, label) {
  return options.input ? inputJson(options, label) : {};
}

function readJsonFile(file, label) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function evidenceNeedsInput(options) {
  if (!options["evidence-needs"]) return [];
  const value = readJsonFile(options["evidence-needs"], "Lode evidence needs");
  return Array.isArray(value) ? value : (value?.evidenceNeeds ?? value);
}

function requireRuntimeSurface(command, surface, root, authorization) {
  if (surface === "managed-maintenance") return;
  // Older managed dispatches can reference a shared authorization without
  // workerInput. Inspect this exact record, never scan all project history.
  let workerBound = authorization.workerInput != null;
  if (!workerBound) {
    try {
      readBoundedWorkerDispatch({ root, authorizationId: authorization.authorizationId });
      workerBound = true;
    } catch (error) {
      if (error.code !== "BOUNDED_WORKER_DISPATCH_NOT_FOUND") throw error;
    }
  }
  requireOperationSurface(command, surface, { workerBound });
}

export async function runCommand(
  argv = process.argv.slice(2),
  {
    observationRegistry = null,
    compactionLifecycleHost = null,
    workerJobHost = null,
    workerJobSupervisor = null,
    workerPreparationBackend = null,
    sessionContext = null,
    nativeHistoryHost = null,
    signal,
    onProcess,
    onExportScope = null,
  } = {},
) {
  const entry = commandEntry(argv);
  const parsed = parse(entry.argv);
  const index = argv.indexOf("--session");
  if (["project-import", "project-bundle-inspect", "project-native-history"].includes(parsed.command) && index >= 0)
    throw new Error("The bundle carries its exact Session selection; omit --session for import/inspection.");
  if (parsed.command === "session-list") {
    requireOperationSurface(parsed.command, entry.surface);
    if (argv.lastIndexOf("--session") !== index) throw new Error("Only one logical Session preview may be requested.");
    return readSessionWorkList({
      root: parsed.root,
      sessionId: index >= 0 ? parsed.options.session : null,
      maxSessions: parsed.options["max-sessions"] === undefined ? 16 : Number(parsed.options["max-sessions"]),
      afterSessionId: parsed.options["after-session"] ?? null,
      conversationCandidates:
        parsed.options["conversation-candidates"] === undefined
          ? undefined
          : inputJson({ input: parsed.options["conversation-candidates"] }, "Conversation lookup selectors"),
    });
  }
  if (["status", "doctor"].includes(parsed.command)) {
    if (argv.lastIndexOf("--session") !== index) throw new Error("Only one logical Session route may be selected.");
    requireOperationSurface(parsed.command, entry.surface);
    const location = inspectProjectLocationExperience({ root: parsed.root, sessionId: index >= 0 ? parsed.options.session : undefined });
    if (location) return location;
  }
  if (index >= 0 || sessionContext) {
    if (argv.lastIndexOf("--session") !== index) throw new Error("Only one logical Session route may be selected.");
    const routed = [...argv];
    if (index >= 0) routed.splice(index, 2);
    if (["init", "resume"].includes(parsed.command)) {
      const projectSessionRoute = { sessionId: index >= 0 ? parsed.options.session : undefined, context: sessionContext };
      return await runRoutedCommand(routed, {
        observationRegistry,
        compactionLifecycleHost,
        workerJobHost,
        workerJobSupervisor,
        workerPreparationBackend,
        nativeHistoryHost,
        signal,
        onProcess,
        onExportScope,
        projectSessionRoute,
      });
    }
    const operation = async () =>
      await runRoutedCommand(routed, {
        observationRegistry,
        compactionLifecycleHost,
        workerJobHost,
        workerJobSupervisor,
        workerPreparationBackend,
        nativeHistoryHost,
        signal,
        onProcess,
        onExportScope,
      });
    if (index < 0 && !sessionCallRequiresBinding(parsed.command, "cli")) return await operation();
    try {
      return withSessionCallContext({ root: parsed.root, sessionId: index >= 0 ? parsed.options.session : undefined, context: sessionContext }, operation);
    } catch (error) {
      if (error.code !== "HEAD_SESSION_SELECTION_LOST") throw error;
      return sessionSelectionUnresolved(parsed.root, { includeProjectFacts: ["status", "doctor", "conversation-enter"].includes(parsed.command) });
    }
  }
  return await runRoutedCommand(argv, {
    observationRegistry,
    compactionLifecycleHost,
    workerJobHost,
    workerJobSupervisor,
    workerPreparationBackend,
    nativeHistoryHost,
    signal,
    onProcess,
    onExportScope,
  });
}

async function runRoutedCommand(
  argv,
  {
    observationRegistry = null,
    compactionLifecycleHost = null,
    workerJobHost = null,
    workerJobSupervisor = null,
    workerPreparationBackend = null,
    nativeHistoryHost = null,
    signal,
    onProcess,
    onExportScope = null,
    projectSessionRoute = null,
  } = {},
) {
  const entry = commandEntry(argv);
  const { surface } = entry;
  const { command, root, options } = parse(entry.argv);
  requireOperationSurface(command, surface);
  const registered = registeredCommand(command);
  if (registered)
    return await callRegistered(registered, "cli", {
      root,
      options,
      inputJson,
      onProcess,
      signal,
      workerJobHost,
      workerJobSupervisor,
      workerPreparationBackend,
      observationRegistry,
      compactionLifecycleHost,
      evidenceNeedsInput,
    });
  if (command === "help" || command === "--help" || command === "-h") return usage({ surface });
  if (command === "help-all") return usage({ all: true, surface });
  if (command === "--version" || command === "version") return { name: ARTIFACT_COMPOSITION.pluginName, version: packageMetadata.version };
  if (command === "init" || command === "resume")
    return await initializeOrResumeProject({
      root,
      projectSessionRoute,
      pluginRoot,
      runtimes: options.runtime?.split(","),
      profile: options.profile || "core",
      copiedProject: options["copied-project"] ?? null,
      instructionIntegration: options["instruction-integration"] ?? null,
      writeRootInstructionFiles: options["write-root-instructions"] === true,
      onboarding: options.input ? inputJson(options, "Project onboarding") : null,
    });
  if (command === "project-native-history") {
    const allowed = new Set(["action", "provider", "native-home", "executable", "threads", "runtime-root", "expected-bundle", "companions"]);
    if (Object.keys(options).some((key) => !allowed.has(key))) throw new Error("Unsupported native history arguments.");
    return (await import("./lib/project-native-history.mjs")).operateProjectNativeHistory({
      action: options.action,
      provider: options.provider,
      bundleRoot: root,
      expectedBundleId: options["expected-bundle"] ?? null,
      nativeHome: options["native-home"],
      executable: options.executable,
      threadIds:
        options.threads === undefined
          ? undefined
          : String(options.threads)
              .split(",")
              .map((value) => value.trim()),
      companionPaths:
        options.companions === undefined
          ? []
          : String(options.companions)
              .split(",")
              .map((value) => value.trim()),
      root: options["runtime-root"],
      pluginRoot,
      nativeHistoryHost,
      signal,
      onProcess,
    });
  }
  if (command === "project-export")
    return (await import("./lib/project-portability.mjs")).exportProjectBundle({
      root,
      destination: options.destination,
      provenanceScope: options.provenance,
      sourceMode: options.sources,
      signal,
      onExportScope,
    });
  if (command === "project-bundle-inspect") {
    const handoffOptions = {
      offset: options["handoff-offset"] === undefined ? 0 : Number(options["handoff-offset"]),
      maxBytes: options["handoff-max-bytes"] === undefined ? 65536 : Number(options["handoff-max-bytes"]),
    };
    if (!fs.lstatSync(root).isDirectory()) {
      if (options["expected-bundle"] !== undefined) throw new Error("A standalone Handoff has no verified bundle identity.");
      return (await import("./lib/project-handoff.mjs")).readProjectHandoffFile({ file: root, ...handoffOptions, signal });
    }
    const core = await import("./lib/project-portability.mjs");
    return core.projectBundleSummary(
      core.inspectProjectBundle({ bundleRoot: root, expectedBundleId: options["expected-bundle"] ?? null, signal, handoffOptions }),
    );
  }
  if (command === "project-import") {
    const result = (await import("./lib/project-portability.mjs")).importProjectBundle({
      root,
      bundleRoot: options.bundle,
      expectedBundleId: options["expected-bundle"] ?? null,
      pluginRoot,
      signal,
    });
    return {
      ...result,
      nextRead: { command: "conversation-enter", projectRoot: result.targetRoot, sessionId: result.selectedSessionId },
      selectionScope: "exact-current-request-no-default-change",
    };
  }
  if (command === "status" || command === "doctor") return await inspectProjectExperience({ root });
  if (command === "graph-query")
    return import("./lib/project-graph.mjs").then(({ queryProjectGraph }) =>
      queryProjectGraph({
        root,
        query: options.query || "",
        view: options.view || "all",
        paths: options.paths?.split(",") || [],
        anchorIds: options.anchors?.split(",") || [],
        depth: options.depth == null ? 1 : Number(options.depth),
        details: options.details === true || options.details === "true",
        maxNodes: options["max-nodes"] == null ? undefined : Number(options["max-nodes"]),
        maxEdges: options["max-edges"] == null ? undefined : Number(options["max-edges"]),
        worldModelId: options["world-model"] || "",
        inventoryPage: options["inventory-page"] === true || options["inventory-page"] === "true",
        inventoryPaths: options["inventory-paths"]?.split(","),
        inventoryCursor: options["inventory-cursor"],
      }),
    );
  if (command === "graph-explorer")
    return import("./lib/graph-explorer.mjs").then(({ exportGraphExplorer }) =>
      exportGraphExplorer({
        root,
        query: options.query || "",
        anchorIds: options.anchors?.split(",") || [],
        paths: options.paths?.split(",") || [],
        layer: options.layer || "project",
        history: options.history === true,
        share: options.share === true,
        output: options.output || null,
      }),
    );
  if (command === "session-create") return createLodeSession({ root, sessionId: options["new-session"], purpose: options.purpose });
  if (command === "session-list") return readSessionWorkList({ root });
  if (command === "runtime-invocation-authorize") {
    const input = inputJson(options, "Runtime invocation authorization");
    requireOperationSurface(command, surface, { workerBound: input.worker != null });
    const allowed = new Set(["runtime", "scope", "workspaceMode", "runtimeSelection", "worker", "retry", "limits"]);
    const unexpected = Object.keys(input).filter((key) => !allowed.has(key));
    if (unexpected.length) throw new Error(`Runtime invocation authorization contains unsupported fields: ${unexpected.sort().join(", ")}`);
    return inspectRuntimeAdapters(root).then((runtimeStatus) =>
      buildRuntimeInvocationAuthorization({
        ...input,
        root,
        protocolEvidence: runtimeStatus.protocolEvidence,
        projectBinding: runtimeStatus.projectBinding,
        persist: true,
      }),
    );
  }
  if (command === "worker-integrate") {
    const input = validateWorkerIntegrationRequest(inputJson(options, "Worker integration"));
    return await operateWorkerIntegration(input, { root, onProcess, storage: resolveProjectStorage(root) });
  }
  if (command === "worker-integration-status") {
    const input = validateWorkerIntegrationStatusRequest({
      integrationId: options.integration,
      ...(options.verification ? { verificationId: options.verification } : {}),
    });
    return inspectWorkerIntegration(input, { root, storage: resolveProjectStorage(root) });
  }
  if (command === "runtime-invocation-execute") {
    const authorization = readRuntimeInvocationAuthorization({ root, authorizationId: options.authorization }).authorization;
    requireRuntimeSurface(command, surface, root, authorization);
    const input = optionalInputJson(options, "Runtime invocation execution");
    const unexpected = Object.keys(input).filter((key) => key !== "sessionRequest");
    if (unexpected.length) throw new Error(`Runtime invocation execution contains unsupported fields: ${unexpected.sort().join(", ")}`);
    return inspectRuntimeAdapters(root).then(
      async (runtimeStatus) =>
        await executeRuntimeInvocation({
          root,
          authorization,
          sessionRequest: input.sessionRequest || "",
          signal,
          onProcessEvent: onProcess,
          protocolEvidence: runtimeStatus.protocolEvidence,
          projectBinding: runtimeStatus.projectBinding,
          persist: true,
        }),
    );
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
  if (command === "worker-execute") {
    const input = options.input ? inputJson(options, "Bounded worker execution") : {};
    const unexpected = Object.keys(input).filter((key) => key !== "sessionRequest");
    if (unexpected.length) throw new Error(`Bounded worker execution contains unsupported fields: ${unexpected.sort().join(", ")}`);
    return inspectRuntimeAdapters(root).then(
      async (runtimeStatus) =>
        await executeBoundedWorkerDispatch({
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
        }),
    );
  }
  if (command === "onboarding-start") return await startOnboarding({ ...optionalInputJson(options, "Onboarding start"), root });
  if (command === "onboarding-candidates") return readOnboardingCandidateSet({ root, candidateSetId: options["candidate-set"] });
  if (command === "onboarding-review-read") return readOnboardingReviewDecision({ root, reviewDecisionId: options.review });
  if (command === "source-scope-set") {
    const inspected = inspectProject(root);
    if (inspected.status !== "ready") throw new Error(`Project must be ready to configure source scope; current status: ${inspected.status}.`);
    return writeRepositorySourceScope({
      projectRoot: inspected.project.projectRoot,
      selection: inputJson(options, "Repository source scope"),
      storage: inspected.storage,
    });
  }
  if (command === "source-scope-status") {
    const inspected = inspectProject(root);
    if (inspected.status === "not_initialized") throw new Error("Lode Agent Core is not initialized.");
    return readRepositorySourceScope({ projectRoot: inspected.project.projectRoot, storage: inspected.storage });
  }
  if (command === "feature-mapping-candidates") return readFeatureMappingCandidateSet({ root, candidateSetId: options["candidate-set"] });
  if (command === "feature-mapping-review-read") return readFeatureMappingReviewDecision({ root, reviewDecisionId: options.review });
  if (command === "change-set-record") return await recordChangeSet({ ...inputJson(options, "ChangeSet"), root });
  if (command === "change-set-read") return readChangeSet({ root, changeSetId: options["change-set"] });
  if (command === "change-impact-candidates") return readChangeImpactCandidateSet({ root, candidateSetId: options["candidate-set"] });
  if (command === "change-impact-review") return await reviewChangeImpact({ ...inputJson(options, "Change impact ReviewDecision"), root });
  if (command === "change-impact-review-read") return readChangeImpactReviewDecision({ root, reviewDecisionId: options.review });
  if (command === "change-set-vcs-attach") return await attachVcsEvidence({ ...inputJson(options, "VCS evidence attachment"), root });
  if (command === "observation-file-ingest") {
    const value = inputJson(options, "Host JSON Observation source");
    return await ingestJsonObservationEventFile({
      root,
      sourceKey: value.sourceKey,
      binding: value.binding,
      descriptor: value.descriptor,
      eventFile: value.eventFile,
      maxBytes: value.maxBytes,
    });
  }
  if (command === "head-continuity") return buildLodeContinuitySnapshot({ root, fresh: options.fresh === true });
  if (command === "world-index")
    return await buildWorldModel({
      root,
      persist: true,
      gitHistoryAdapter: options["git-log"] ? new GitLogFileHistoryAdapter({ file: options["git-log"] }) : null,
      runtimeStateAdapter: options["runtime-state"] ? new RuntimeStateFileAdapter({ file: options["runtime-state"] }) : null,
      parentSourceSnapshotIds: Object.hasOwn(options, "parent-snapshot")
        ? options["parent-snapshot"]
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
        : undefined,
      revisionParentIds: Object.hasOwn(options, "revision-parents") ? readJsonFile(options["revision-parents"], "Revision parent map") : undefined,
    });
  if (command === "storage-gc") {
    if (options.apply === true || options.apply === "true") return await applySnapshotGarbageCollection({ root, signal, onProcess });
    const inspection = inspectSnapshotGarbageCollection({ root });
    try {
      inspection.typedClosure = await inspectSnapshotPreservationClosure({ root });
    } catch (error) {
      inspection.typedClosure = { status: "partial-preserved", reasonCode: error.code || "TYPED_CLOSURE_UNAVAILABLE", deletedCount: 0 };
    }
    return inspection;
  }
  if (command === "world-status") return await inspectWorldModel({ root });
  if (command === "world-refresh")
    return await refreshWorldModel({
      root,
      triggerKind: "manual",
      triggerEvidenceIds: options["trigger-evidence"]
        ? options["trigger-evidence"]
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
        : [],
      expectedChangedPaths:
        options["expect-changed"] == null
          ? null
          : options["expect-changed"]
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean),
      additionalParentSourceSnapshotIds: options["parent-snapshot"]
        ? options["parent-snapshot"]
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
        : [],
    });
  if (command === "world-refresh-events") {
    const input = inputJson(options, "Refresh trigger event ingestion");
    const unexpected = Object.keys(input).filter((key) => !["sourceKind", "events", "maxEvents"].includes(key));
    if (unexpected.length) throw new Error(`Refresh trigger event ingestion contains unsupported fields: ${unexpected.sort().join(", ")}`);
    if (input.sourceKind !== "ci") throw new Error("world-refresh-events accepts only sourceKind ci; use world-refresh-watch for filesystem events.");
    return await processRefreshTriggerBatch({ root, ...input });
  }
  if (command === "world-refresh-watch")
    return await runFileSystemRefreshWatcher({
      root,
      debounceMs: options["debounce-ms"] == null ? undefined : Number(options["debounce-ms"]),
      maxEvents: options["max-events"] == null ? undefined : Number(options["max-events"]),
    });
  if (command === "world-graph-remote-database-initialize")
    return initializeArcadeDbDatabase({
      root,
      storage: resolveProjectStorage(root),
      resetIncompatible: options["reset-incompatible"] === "true",
      confirmDatabase: options["confirm-database"] || "",
    });
  if (command === "world-graph-remote-activate") return await activateArcadeDbGraphProjection({ root });
  if (command === "world-docs-capture") return await captureWorldMarkdownChanges({ root, persist: true });
  if (command === "world-docs-review") {
    const input = inputJson(options, "Document-change ReviewDecision");
    const allowed = new Set(["candidateSetId", "disposition", "acceptedCandidateIds", "resultingProductModel", "rationale", "apply"]);
    const unexpected = Object.keys(input).filter((key) => !allowed.has(key));
    if (unexpected.length) throw new Error(`Document-change ReviewDecision contains unsupported fields: ${unexpected.sort().join(", ")}`);
    return await reviewDocumentChanges({ ...input, root });
  }
  if (command === "world-docs-apply") return await applyDocumentChangeReview({ root, reviewDecisionId: options.review });
  if (command === "world-docs-policy-set") {
    const input = inputJson(options, "Post-refresh document projection policy");
    const unexpected = Object.keys(input).filter((key) => key !== "mode");
    if (unexpected.length) throw new Error(`Post-refresh document projection policy contains unsupported fields: ${unexpected.sort().join(", ")}`);
    return setPostRefreshProjectionPolicy({ root, mode: input.mode });
  }
  if (command === "world-docs-policy-status") return inspectPostRefreshProjectionPolicy({ root });
  if (command === "checkpoint")
    return createRecoveryCheckpoint({
      root,
      purpose: options.summary,
      currentPosition: options.summary,
      nextExpectedResult: options.next || options.summary,
      approvedDecisions: [],
      openReviewIds: [],
    });
  if (command === "session-work-record") {
    const input = inputJson(options, "Selected Session work evidence");
    let documentSelection, documentSelectionError;
    if (options["document-selection"]) {
      try {
        documentSelection = JSON.parse(fs.readFileSync(path.resolve(options["document-selection"]), "utf8"));
      } catch (error) {
        documentSelectionError = error.code || "WORK_DOCUMENT_SELECTION_JSON_INVALID";
      }
    }
    return (await import("./lib/session-work-document-workflow.mjs")).recordSessionWorkAndProjectDocuments({
      root,
      input,
      documentSelection,
      documentSelectionError,
    });
  }
  if (command === "project-document-status") return (await import("./lib/project-document-publication.mjs")).projectDocumentStatus({ root });
  if (["project-document-prepare", "project-document-publish"].includes(command)) {
    const api = await import("./lib/project-document-publication.mjs");
    const input = inputJson(options, "HEAD-selected Project documents");
    return api[command === "project-document-prepare" ? "prepareProjectDocuments" : "publishProjectDocuments"]({ ...input, root });
  }
  if (command === "work-document-status")
    return (await import("./lib/work-document-publication.mjs")).workDocumentStatus({ root, logicalKey: options["logical-key"] });
  if (["work-document-prepare", "work-document-configure", "work-document-publish"].includes(command)) {
    const api = await import("./lib/work-document-publication.mjs");
    const input = inputJson(options, "HEAD-selected work document operation");
    const method = {
      "work-document-prepare": "prepareWorkDocuments",
      "work-document-configure": "configureWorkDocuments",
      "work-document-publish": "publishWorkDocuments",
    }[command];
    return api[method]({ ...input, root });
  }
  if (command === "session-continue") {
    return continueSessionFromArtifacts({
      root,
      checkpointId: options.checkpoint || null,
      runtime: options.runtime,
    });
  }
  if (command === "lineage-plan") return createWholePlanSnapshot({ ...inputJson(options, "Whole plan"), root, persist: true });
  if (command === "lineage-next-plan") return createNextWholePlanSnapshot({ ...inputJson(options, "Next whole plan"), root, persist: true });
  if (command === "lineage-contract") return createExecutionContract({ ...inputJson(options, "Execution Contract"), root, persist: true });
  if (command === "run-finish") return finishRun({ ...inputJson(options, "Result Packet"), root });
  if (command === "run-review") return reviewRun({ ...inputJson(options, "ReviewDecision"), root });
  if (command === "context-compile")
    return await compileContext({
      root,
      task: options.task,
      budget: options.budget == null ? DEFAULT_CONTEXT_BUDGET : Number(options.budget),
      evidenceNeeds: evidenceNeedsInput(options),
      persist: true,
    });
  throw new Error(`Unknown command: ${command}`);
}

export function runCliMain(directArgs = process.argv.slice(2)) {
  const jsonOutput = directArgs.includes("--json");
  const withoutJson = directArgs.filter((item) => item !== "--json");
  const directCommand = commandEntry(withoutJson).argv[0] || "help";
  const normalizedArgs = withoutJson.filter((item) => directCommand !== "graph-query" || item !== "--diagnostics");
  const sourceController = new AbortController();
  const abortSource = () => sourceController.abort();
  if (
    ["source-context", "worker-execute", "runtime-invocation-execute"].includes(directCommand) ||
    (directCommand === "storage-gc" && directArgs.includes("--apply"))
  ) {
    process.on("SIGINT", abortSource);
    process.on("SIGTERM", abortSource);
  }
  return Promise.resolve()
    .then(
      async () =>
        await runCommand(normalizedArgs, {
          signal: sourceController.signal,
          onExportScope: (notice) =>
            fs.writeSync(
              process.stderr.fd,
              jsonOutput ? `${JSON.stringify({ projectExportScope: notice })}\n` : `${notice.message}\n${notice.sourceNotice || ""}\n`,
            ),
          onProcess: (event) => {
            if (directCommand === "storage-gc" && !directArgs.includes("--diagnostics")) return;
            if (event.purpose === "snapshot-filesystem-qualification" && !directArgs.includes("--diagnostics")) return;
            process.stderr.write(`${JSON.stringify({ sourceProcess: event })}\n`);
          },
        }),
    )
    .then((result) => {
      if (directCommand === "storage-gc" && result?.requestedApply && result.status !== "gc_applied") process.exitCode = 1;
      process.stdout.write(
        jsonOutput ? `${JSON.stringify(result, null, 2)}\n` : formatCliResult(directCommand, result, { diagnostics: directArgs.includes("--diagnostics") }),
      );
    })
    .catch((error) => {
      const failure = { status: "failed", code: error.code || "HEAD_CLI_ERROR", error: error.message };
      process.stdout.write(jsonOutput ? `${JSON.stringify(failure, null, 2)}\n` : formatCliError(error));
      process.exitCode = 1;
    })
    .finally(() => {
      process.removeListener("SIGINT", abortSource);
      process.removeListener("SIGTERM", abortSource);
    });
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) runCliMain();

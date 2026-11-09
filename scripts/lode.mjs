#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARTIFACT_COMPOSITION } from "./lib/lode-artifact-composition.mjs";
import { legacyReasonCodeFields } from "./lib/core/errors.mjs";
import { callRegistered, registeredCommand } from "./lib/operation-registry.mjs";
import { commandEntry, isManagedMutation, requireOperationSurface, requireSurface } from "./lib/managed-maintenance-surface.mjs";
import { withSessionCallContext, sessionCallRequiresBinding, sessionSelectionUnresolved } from "./lib/session-routing.mjs";
import { inspectProjectLocationExperience } from "./lib/project-bootstrap.mjs";
import { formatCliError, formatCliResult } from "./lib/cli-presentation.mjs";
import { readSessionWorkList } from "./lib/session-work-context.mjs";
import { readBoundedWorkerDispatch } from "./lib/bounded-worker-dispatch.mjs";

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
      if (error.code !== "SESSION_SELECTION_LOST") throw error;
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
      command,
      surface,
      inputJson,
      optionalInputJson,
      readJsonFile,
      evidenceNeedsInput,
      requireRuntimeSurface,
      usage,
      packageMetadata,
      pluginRoot,
      onProcess,
      signal,
      onExportScope,
      projectSessionRoute,
      nativeHistoryHost,
      workerJobHost,
      workerJobSupervisor,
      workerPreparationBackend,
      observationRegistry,
      compactionLifecycleHost,
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
      const code = error.code || "CLI_ERROR";
      // legacyReasonCode: the historical HEAD_* spelling, for one version (see LEGACY_REASON_CODES).
      const failure = { status: "failed", code, ...legacyReasonCodeFields(code), error: error.message };
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

#!/usr/bin/env node
import readline from "node:readline";
import { workDocumentTools, workDocumentFromMcp, workDocumentCompositionSchema } from "./lib/work-document-surface.mjs";
import { resolveOperation } from "./lib/lode-operation-contract.mjs";
import { requireMcpConfirmation } from "./lib/dispatch-adapters.mjs";
import { sessionWorkEvidenceSchema, workEvidenceText } from "./lib/tool-schemas.mjs";
import { callRegistered, registeredOperation, registeredTools } from "./lib/operation-registry.mjs";
import { assertProjectRootArgument } from "./lib/mcp-argument-validation.mjs";
import { ARTIFACT_COMPOSITION, publicToolName } from "./lib/lode-artifact-composition.mjs";
import { DISCOVERY_PREFIX_PAIRS } from "../compat/head/public-names.mjs";
const semanticToolName = (name) => resolveOperation(name)?.semanticName ?? name;
const presentedSchemas = new WeakMap();
const presentedSchema = (value) =>
  Array.isArray(value)
    ? value.map(presentedSchema)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [
            key,
            ["description", "title"].includes(key) && typeof entry === "string" ? entry.replace(/\bHEAD\b/g, "Lode") : presentedSchema(entry),
          ]),
        )
      : value;
const presentedTool = (tool) => {
  // Display prose only. Names, field keys, enums, defaults and wire identifiers
  // retain the original contract, including in legacy carrier packages.
  if (!presentedSchemas.has(tool)) presentedSchemas.set(tool, { ...presentedSchema(tool), name: publicToolName(tool.name) });
  return presentedSchemas.get(tool);
};
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isManagedMutation, requireOperationSurface, requireSurface } from "./lib/managed-maintenance-surface.mjs";
import { coreContract } from "./lib/core-contract.mjs";
import { coreEntryGuidance } from "./lib/lode-entry-guidance.mjs";
import { formatMcpToolContent } from "./lib/cli-presentation.mjs";
import { sessionCallRequiresBinding } from "./lib/session-routing.mjs";
import { createNativeSessionHostBridge } from "./lib/session-native-host.mjs";
import { SESSION_HOST_REQUEST_HELPER } from "./lib/session-host-request.mjs";
import { assessSubagentStateWrite, subagentWriteGuardEnabled } from "./lib/subagent-write-guard.mjs";
import fs from "node:fs";
import { resolveProjectStorage, familyFormatForOriginal } from "./lib/project-storage-format.mjs";

const protocolVersion = "2024-11-05";
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageVersion = JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"), "utf8")).version;
const workerIntegrationIdSchema = { type: "string", pattern: "^worker-integration-[a-f0-9]{24}--[a-f0-9]{24}$" };
const workerIntegrationVerificationIdSchema = { type: "string", pattern: "^worker-integration-verification-[a-f0-9]{24}$" };
const workerIntegrationActionFields = {
  prepare: ["authorization_ids", "max_bytes"],
  apply: ["integration_id"],
  reconcile: ["integration_id"],
  "settle-incomplete": ["integration_id", "basis_digest", "reason"],
  "prepare-result": ["integration_id", "basis_digest", "outcome", "evidence", "verification"],
  "publish-result": ["integration_id", "verification_id"],
};
const workerIntegrationOptionalFields = { apply: ["basis_digest", "retry_known_no_write"], "prepare-result": ["plan_delta", "impact_radius", "unknowns"] };
const workerIntegrationFieldNames = {
  action: "action",
  integration_id: "integrationId",
  authorization_ids: "authorizationIds",
  max_bytes: "maxBytes",
  basis_digest: "basisDigest",
  reason: "reason",
  verification_id: "verificationId",
  outcome: "outcome",
  evidence: "evidence",
  verification: "verification",
  plan_delta: "planDelta",
  impact_radius: "impactRadius",
  unknowns: "unknowns",
  retry_known_no_write: "retryKnownNoWrite",
};
function workerIntegrationInput(args) {
  if (typeof args.project_root !== "string" || !args.project_root.trim()) throw new Error("Worker integration requires project_root.");
  const request = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === "project_root") continue;
    if (!Object.hasOwn(workerIntegrationFieldNames, key))
      throw Object.assign(new Error(`Unsupported worker integration fields: ${key}.`), { code: "WORKER_INTEGRATION_INPUT_INVALID" });
    request[workerIntegrationFieldNames[key]] = value;
  }
  return request;
}
// Upper transport composition selects only the owned marker, after the same
// pre-filesystem guards. Lower historical readers keep their legacy defaults.
async function workerIntegrationFromMcp(args, onProcess, statusOnly = false) {
  const workflow = await import("./lib/worker-integration-workflow.mjs");
  const input = workerIntegrationInput(args);
  (statusOnly ? workflow.validateWorkerIntegrationStatusRequest : workflow.validateWorkerIntegrationRequest)(input);
  const options = { root: args.project_root, onProcess, storage: resolveProjectStorage(args.project_root) };
  return statusOnly ? workflow.inspectWorkerIntegration(input, options) : workflow.operateWorkerIntegration(input, options);
}
async function runtimeResultFromMcp(args) {
  const { validateRuntimeInvocationRecordIdentity } = await import("./lib/runtime-invocation-record.mjs");
  validateRuntimeInvocationRecordIdentity(args.authorization_id);
  return (await import("./lib/runtime-run-result-application.mjs")).readRuntimeInvocationResult({
    root: args.project_root,
    authorizationId: args.authorization_id,
    storage: resolveProjectStorage(args.project_root),
  });
}
async function initializeProjectFromMcp(args, { projectSessionRoute, onValidatedSessionSelection, pluginLaunch, servingModuleUrl, installationCaller }) {
  const onboarding = onboardingInputFromMcp(args);
  const { createPluginInitializationContext, releasePluginInitializationContext } = await import("./lib/plugin-mcp-composition.mjs");
  // The shared write guard already ran. Optional installation discovery must
  // never read Project originals before a proven child write is rejected.
  const installationContext = createPluginInitializationContext({
    launch: pluginLaunch,
    servingModuleUrl,
    caller: installationCaller,
    root: args.project_root,
  });
  try {
    return await (
      await import("./lib/project-bootstrap.mjs")
    ).initializeOrResumeProject({
      root: args.project_root,
      pluginRoot,
      projectSessionRoute,
      runtimes: args.runtimes || null,
      profile: args.profile || "core",
      copiedProject: args.copied_project ?? null,
      instructionIntegration: args.instruction_integration ?? null,
      writeRootInstructionFiles: args.write_root_instruction_files === true,
      onboarding,
      onValidatedSessionSelection,
      installationContext,
    });
  } finally {
    releasePluginInitializationContext(installationContext);
  }
}
// Host presentation hints describe the implemented effect; they do not grant
// permission or prove that a caller obtained a user's approval.
const supplementalReadOnlyHints = {
  head_core_contract: true,
  head_runtime_adapters: true,
  head_runtime_invocation_authorization: true,
  head_runtime_invocation_lease_status: true,
  head_runtime_invocation_result: true,
  head_onboarding_status: true,
  head_onboarding_semantic_refresh: false,
  head_onboarding_candidate_restore: false,
  head_product_policy_status: true,
  head_product_policy_candidate: true,
  head_product_policy_review_decision: true,
  head_metric_status: true,
  head_metric_trace: true,
  head_feature_mapping_status: true,
  head_change_set_status: true,
  head_vcs_evidence: true,
  head_context_capsule: true,
  head_lineage_artifact: true,
  head_pending_review: true,
  head_incremental_refresh_status: true,
  head_incremental_refresh_receipt: true,
  head_refresh_trigger_status: true,
  head_refresh_trigger_delivery: true,
  head_graph_projection_status: true,
  head_markdown_projection_status: true,
  head_post_refresh_projection_status: true,
  head_post_refresh_projection_receipt: true,
  head_document_change_candidates: true,
  head_document_change_review_status: true,
  head_document_change_review: true,
  head_document_change_application: true,
  head_world_query: true,
  head_git_history: true,
  head_temporal_graph: true,
  head_graph_lineage_status: true,
  head_graph_lineage_trace: true,
  head_graph_lineage_diff: true,
  head_runtime_state: true,
  head_compact_status: true,
  head_product_operating_status: true,
  head_release_status: true,
  head_delivery_status: true,
  head_continuity_snapshot: true,
  head_feature_mapping_propose: false,
  head_feature_mapping_review: false,
  head_conformance_propose: false,
  head_conformance_disposition: false,
  head_conformance_resolution_propose: false,
  head_conformance_trigger_prepare: false,
  head_compact_prepare: false,
  head_compact_verify: false,
  head_compact_continue: false,
  head_compact_abort: false,
  head_product_signal_record: false,
  head_product_policy_propose: false,
  head_product_policy_review: false,
  head_metric_define: false,
  head_metric_observe: false,
  head_metric_compare: false,
  head_metric_assess: false,
  head_product_hypothesis_record: false,
  head_product_initiative_propose: false,
  head_product_initiative_review: false,
  head_product_outcome_observe: false,
  head_delivery_observe: false,
};
const allTools = [
  ...workDocumentTools,
  {
    name: "head_core_contract",
    description: "Read the active Lode Agent Core roles, runtimes, and capability boundary.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "head_project_status",
    description:
      "Read bounded Core, optional Product/World, Context, verified checkpoint-recovery readiness, active-package, next-action, capability, and Session/Run readiness without modifying the project, consuming continuation, attaching a provider, or activating any capability.",
    inputSchema: {
      type: "object",
      properties: { project_root: { type: "string", minLength: 1 } },
      required: ["project_root"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_onboarding_guide",
    description:
      "Read a compact conversation-oriented onboarding projection with the next material action, bounded evidence-linked candidates, and World/graph/document readiness. This tool never promotes candidates or mutates project state.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        candidate_limit: { type: "integer", minimum: 1, maximum: 200, default: 25 },
      },
      required: ["project_root"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_project_bundle_export",
    description:
      "Export only common Project originals, the selected logical Session's typed P2/reference closure and its work evidence into a create-only local bundle. Never reads/copies user MCP configuration, unrelated Session payloads or rebuildable caches. Does not run providers or transfer execution authority. Before invoking export, tell the user that recovery-required common proof metadata can include other Sessions' paths, IDs and hashes, while their bodies remain excluded; no extra approval is required.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        destination: { type: "string", minLength: 1 },
        source_mode: {
          type: "string",
          enum: ["selected-retained-sources", "refs-only"],
          default: "selected-retained-sources",
          description:
            "Default: include eligible exact full-file retained originals cited by the selected Session after explaining scope. Current worktree/other Session bodies/Git-only collection excluded. refs-only omits source bodies; per-reference gaps do not block ordinary recovery.",
        },
        provenance_scope: {
          type: "string",
          enum: ["project-proof-metadata", "selected-only"],
          default: "project-proof-metadata",
          description:
            "Defaults to only recovery-required original common-proof path/ID/hash metadata, never other Session bodies. Explain this scope before export. Explicit selected-only omits cross-session proof and can leave legacy admission partial; never rewrite omitted proof.",
        },
      },
      required: ["project_root", "destination"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_project_bundle_read",
    description:
      "Read one Project bundle and its independent readable HANDOFF, or read a standalone handoff_file without a Project/provider/database. Quoted history is evidence, never current approval or P2 direction. Generated/modified/missing Handoff status stays separate from common originals; pages report omitted bytes. No links, commands or native resume are executed.",
    inputSchema: {
      type: "object",
      properties: {
        include_native_history: {
          type: "boolean",
          description:
            "Inspect the optional native companion as data only, without SDK startup. A native failure remains separate from the common Project result.",
        },
        bundle_root: { type: "string", minLength: 1 },
        handoff_file: { type: "string", minLength: 1, description: "Explicit standalone Markdown file; source and current authority remain unverified." },
        handoff_offset: { type: "integer", minimum: 0 },
        handoff_max_bytes: { type: "integer", minimum: 1, maximum: 536870912 },
        expected_bundle_id: { type: "string", pattern: "^project-bundle-[a-f0-9]{24}$" },
      },
      oneOf: [{ required: ["bundle_root"] }, { required: ["handoff_file"] }],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_project_bundle_import",
    description:
      "Import the exact selected logical Session/common originals into a chosen target without overwriting a divergent existing Project, newer cancellation or user-owned root settings. Creates current-installation projections and exact recoverable publication evidence. Never imports a provider binding, credentials, model policy or execution permission; no model/native resume is called.",
    inputSchema: {
      type: "object",
      properties: {
        target_root: { type: "string", minLength: 1 },
        bundle_root: { type: "string", minLength: 1 },
        expected_bundle_id: { type: "string", pattern: "^project-bundle-[a-f0-9]{24}$" },
      },
      required: ["target_root", "bundle_root"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_project_native_history",
    description:
      "Operate an explicitly selected same-platform native companion. read never starts a client and keeps Handoff/common recovery independent. capture requires provider; other actions derive it only from a verified link. Codex retains its pinned contract. Claude 2.1.223 restores exact files without overwriting conflicts; register optionally reads an installed SDK, never starts a model. OpenCode source capture still requires the current Host exact-ID export. Restore/register can use the fixed Windows x64 baseline 1.19.5 binary with an existing explicitly selected isolated DB, qualified schema/migrations and current Project mapping. All selected sessions/messages/parts publish in one transaction with source-bound field validation, global ID/ancestry checks and exact readback. No automatic DB initialization/migration, ordinary-profile fallback or default CLI bootstrap. A competing writer affects only native work; read-only clients need not stop. DB readback is distinct from official picker/model visibility. Claude/OpenCode effects require runtime_root; OpenCode source capture is Host-routed and does not accept source native_home/executable overrides. Missing tools/unsupported profiles limit native work only. Partial/uncertain effects are not automatically replayed; successful raw/history readback does not prove picker visibility, current model settings or continuation readiness. No model turn, app kill, configuration/credential migration or P2 authority; selected raw content is not redacted. HEAD supplies verified selection and paths, not user JSON.",
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          enum: ["codex", "claude", "opencode"],
          description:
            "Explicit source/expected same target platform. Required for capture; other actions may reuse only the verified companion link provider.",
        },
        action: { type: "string", enum: ["capture", "read", "restore", "register"] },
        bundle_root: { type: "string", minLength: 1 },
        expected_bundle_id: { type: "string", pattern: "^project-bundle-[a-f0-9]{24}$" },
        native_home: { type: "string", minLength: 1 },
        executable: { type: "string", minLength: 1 },
        thread_ids: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$" },
          description: "Exact selected native IDs for the explicit provider. Core applies that provider's format; OpenCode session IDs are not Codex UUIDs.",
        },
        runtime_root: { type: "string", minLength: 1 },
        companion_paths: {
          type: "array",
          uniqueItems: true,
          items: { type: "string", minLength: 1 },
          description:
            "Optional explicitly selected Claude companion paths relative to its project history directory, each below a selected native ID directory. The agent obtains these from the selected source; no external references are followed.",
        },
      },
      required: ["action", "bundle_root"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "head_project_initialize_or_resume",
    description:
      "Initialize or resume one Lode Project and its explicitly routed logical Session, and converge managed plugin projections. Core is the default. Core initialize/resume requires no Product brief or semantic proposal and leaves optional Product governance inactive or preserves its existing state. Only the explicit Product profile requires a fresh provider proposal or user-owned brief when Product candidates need to be created; Core verifies evidence but never infers product meaning. This writes only the selected project and never contacts GraphDB.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        profile: { type: "string", enum: ["core", "product"], default: "core" },
        copied_project: {
          type: "string",
          enum: ["verified-copy"],
          description:
            "Explicitly adopt this local copied Project when the initial origin cannot be proved. Retains exact originals and an origin-unverified label; does not transfer native bindings or execution permission. Not needed for ordinary proved relocation.",
        },
        instruction_integration: {
          type: "string",
          enum: ["link", "preserve"],
          description:
            "Optional existing setup choice. Link a bounded host-specific instruction block only when the user chose it; preserve makes no instruction edits. Never a prerequisite for ordinary work.",
        },
        write_root_instruction_files: {
          type: "boolean",
          default: false,
          description:
            'Create missing root CLAUDE.md, AGENTS.md, or opencode.json. Omitted or false leaves those files untouched, including in a non-interactive run, except that instruction_integration "link" creates a missing CLAUDE.md or AGENTS.md containing only the link block.',
        },
        runtimes: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          uniqueItems: true,
          items: { type: "string", enum: ["claude", "codex", "opencode"] },
        },
        mode: {
          type: "string",
          enum: ["existing", "new"],
          description:
            "Product onboarding only. Omit mode for Core initialization or resume; existing/new describes the optional Product analysis, not whether a Core Project exists.",
        },
        source_scope: {
          type: "object",
          properties: {
            include_roots: { type: "array", items: { type: "string" }, default: [] },
            exclude_roots: { type: "array", items: { type: "string" }, default: [] },
          },
          additionalProperties: false,
        },
        storage: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["local", "graphdb"] },
            endpoint: { type: "string" },
            database: { type: "string" },
            username_secret_reference: { type: "string", pattern: "^[A-Z][A-Z0-9_]{2,127}$" },
            password_secret_reference: { type: "string", pattern: "^[A-Z][A-Z0-9_]{2,127}$" },
          },
          required: ["mode"],
          additionalProperties: false,
        },
        brief: {
          type: "object",
          properties: {
            schemaVersion: { type: "integer", const: 1 },
            name: { type: "string" },
            summary: { type: "string" },
            featureGroups: { type: "array", items: { type: "object" } },
            capabilities: { type: "array", items: { type: "object" } },
            features: { type: "array", items: { type: "object" } },
            requirements: { type: "array", items: { type: "object" } },
            constraints: { type: "array", items: { type: "object" } },
            decisions: { type: "array", items: { type: "object" } },
          },
          required: ["schemaVersion"],
          additionalProperties: false,
        },
        semantic_proposal: {
          type: "object",
          description:
            "Fresh HEAD-authored P3 product candidates. Core verifies exact current source paths, digests, lines, optional symbols, bounds, and Product Model structure; it never treats the proposal as Product Canon or instruction authority.",
          properties: {
            schemaVersion: { type: "integer", const: 1 },
            sourceSnapshotId: { type: "string", pattern: "^source-snapshot-[a-f0-9]{24}$" },
            candidates: {
              type: "array",
              minItems: 1,
              maxItems: 200,
              items: {
                type: "object",
                properties: {
                  productKind: { type: "string", enum: ["FeatureGroup", "Capability", "Feature", "Requirement", "Constraint", "Decision"] },
                  proposedEntity: { type: "object" },
                  explanation: { type: "string", minLength: 1, maxLength: 2000 },
                  confidence: { type: "number", minimum: 0, maximum: 1 },
                  evidence: {
                    type: "array",
                    minItems: 1,
                    maxItems: 8,
                    items: {
                      type: "object",
                      properties: {
                        path: { type: "string", minLength: 1 },
                        line: { type: "integer", minimum: 1 },
                        contentDigest: {
                          type: "string",
                          pattern: "^[a-f0-9]{64}$",
                          description: "Optional optimistic freshness guard. Core always binds the verified current World digest even when omitted.",
                        },
                        symbol: {
                          type: "object",
                          properties: {
                            name: { type: "string", minLength: 1 },
                            kind: { type: "string", minLength: 1 },
                            line: { type: "integer", minimum: 1 },
                          },
                          required: ["name", "kind", "line"],
                          additionalProperties: false,
                        },
                      },
                      required: ["path", "line"],
                      additionalProperties: false,
                    },
                  },
                },
                required: ["productKind", "proposedEntity", "evidence", "explanation", "confidence"],
                additionalProperties: false,
              },
            },
          },
          required: ["schemaVersion", "sourceSnapshotId", "candidates"],
          additionalProperties: false,
        },
      },
      required: ["project_root"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  ...registeredTools(["head_onboarding_semantic_refresh", "head_onboarding_candidate_restore"]),
  ...registeredTools(["head_onboarding_review"]),
  ...registeredTools([
    "head_product_policy_propose",
    "head_product_policy_review",
    "head_product_policy_status",
    "head_product_policy_candidate",
    "head_product_policy_review_decision",
  ]),
  ...registeredTools([
    "head_metric_define",
    "head_metric_observe",
    "head_metric_compare",
    "head_metric_assess",
    "head_metric_status",
    "head_metric_trace",
    "head_delivery_observe",
    "head_delivery_status",
  ]),
  ...registeredTools(["head_markdown_projection_build"]),
  ...registeredTools(["head_runtime_adapters"]),
  ...registeredTools(["head_runtime_invocation_authorization"]),
  ...registeredTools(["head_runtime_invocation_lease_status"]),
  {
    name: "head_runtime_invocation_result",
    description:
      "Read and digest-verify one provider-neutral recorded invocation receipt, structured result draft, optional Run application, and transcript-free event envelopes without invoking or controlling a provider.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        authorization_id: { type: "string", pattern: "^execution-authorization-[a-f0-9]{24}$" },
      },
      required: ["project_root", "authorization_id"],
      additionalProperties: false,
    },
  },
  ...registeredTools(["head_onboarding_status"]),
  ...registeredTools(["head_feature_mapping_propose", "head_feature_mapping_status", "head_feature_mapping_review"]),
  ...registeredTools(["head_change_set_status", "head_vcs_evidence"]),
  ...registeredTools(["head_conformance_prepare"]),
  ...registeredTools(["head_conformance_propose"]),
  ...registeredTools(["head_conformance_queue", "head_conformance_read", "head_conformance_disposition"]),
  ...registeredTools(["head_conformance_resolution_propose"]),
  {
    name: "head_conformance_trigger_status",
    description:
      "Read one optional Host-local Conformance trigger binding. It is P5 operational state and does not imply Product meaning, source completeness, or authority.",
    inputSchema: {
      type: "object",
      properties: { project_root: { type: "string", minLength: 1 }, source_id: { type: "string", pattern: "^conformance-trigger-source-[a-f0-9]{24}$" } },
      required: ["project_root", "source_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_conformance_trigger_prepare",
    description:
      "Prepare the next bounded Host-local trigger batch and current read-only Conformance baseline. It invokes no provider, creates no Finding, and does not auto-replay an uncertain assessment.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        source_id: { type: "string", pattern: "^conformance-trigger-source-[a-f0-9]{24}$" },
        limit: { type: "integer", minimum: 1, maximum: 64, default: 64 },
      },
      required: ["project_root", "source_id"],
      additionalProperties: false,
    },
  },
  ...registeredTools(["head_source_context", "head_source_observation_read", "head_context_prepare", "head_context_preview"]),
  ...registeredTools([
    "head_context_capsule",
    "head_lineage_artifact",
    "head_pending_review",
    "head_checkpoint_basis",
    "head_checkpoint_diagnose",
    "head_checkpoint_sync",
  ]),
  {
    name: "head_session_work_record",
    description:
      "Optionally preserve meaningful Run-free work as one create-only P3 Evidence original in the exact selected Session, without a Run, checkpoint, Capsule, user form or save approval. HEAD supplies sparse otherwise-unrepresented context; exact retry does not re-execute work. When checkpoint sync is already useful, use its optional work_evidence instead.",
    inputSchema: {
      type: "object",
      properties: { project_root: workEvidenceText, evidence: sessionWorkEvidenceSchema, document_selection: workDocumentCompositionSchema },
      required: ["project_root", "evidence"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  ...registeredTools(["head_session_work_read", "head_session_restore"]),
  {
    name: "head_session_continue",
    description:
      "Restore the canonical P2 SessionRunCheckpoint first, then optionally verify the exact current live HEAD attachment through the host-injected P5 adapter. Failure falls back to a disclosed fresh logical HEAD and never imports provider session identity.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        runtime: { type: "string", enum: ["claude", "codex", "opencode"] },
        checkpoint_id: { type: "string", pattern: "^checkpoint-[a-f0-9]{24}$" },
      },
      required: ["project_root", "runtime"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_worker_integration",
    description:
      "HEAD combines exact completed worker patches, explicitly applies or reconciles bounded file effects, settles a quiescent incomplete attempt, or prepares/publishes one verified whole-Run result. HEAD supplies the structured fields from its task and evidence; do not ask the user to author JSON. prepare-result needs the current basis_digest and HEAD verification; publish-result needs that exact verification_id. Published results still require Fresh HEAD review; this never creates ReviewDecision, Product Canon or checkpoint direction. No provider is launched and no Host executable or transport is accepted.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        action: { type: "string", enum: Object.keys(workerIntegrationActionFields) },
        authorization_ids: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", pattern: "^execution-authorization-[a-f0-9]{24}$" } },
        max_bytes: {
          type: "integer",
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
          description: "Bound combined raw preimage/postimage bytes for prepare; not a semantic sufficiency budget.",
        },
        integration_id: workerIntegrationIdSchema,
        basis_digest: {
          type: "string",
          pattern: "^[a-f0-9]{64}$",
          description: "Exact current status basis after HEAD reassessment, never a user confirmation token.",
        },
        retry_known_no_write: {
          type: "boolean",
          default: false,
          description: "Only for apply: HEAD may explicitly retry an exact, quiescent, inspected known-no-write attempt. Unknown effects are never retried.",
        },
        reason: { type: "string", minLength: 1, maxLength: 4000 },
        verification_id: workerIntegrationVerificationIdSchema,
        outcome: { type: "string", minLength: 1 },
        evidence: { type: "array", minItems: 1, items: { type: "object" } },
        verification: { type: "array", minItems: 1, items: { type: "object" } },
        plan_delta: { type: "string" },
        impact_radius: { type: "array", items: { type: "string", minLength: 1 } },
        unknowns: { type: "array", items: { type: "string", minLength: 1 } },
      },
      required: ["project_root", "action"],
      additionalProperties: false,
      oneOf: Object.entries(workerIntegrationActionFields).map(([action, required]) => ({
        properties: {
          ...Object.fromEntries(["project_root", ...required, ...(workerIntegrationOptionalFields[action] || [])].map((key) => [key, {}])),
          action: { const: action },
        },
        required,
        additionalProperties: false,
      })),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_worker_integration_status",
    description:
      "Read verified integration history, current dependency/file-effect basis, outstanding overlapping effects and whole-result state in one non-persisted view. Repeated reads create no artifacts, invoke no provider and repair no state. Raw patch bytes are omitted, while exact member and evidence identities remain available. Source or Session drift is not rewritten as success or recovery direction.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        integration_id: workerIntegrationIdSchema,
        verification_id: workerIntegrationVerificationIdSchema,
      },
      required: ["project_root", "integration_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  ...registeredTools(["head_bounded_worker_prepare", "head_bounded_worker_start"]),
  ...registeredTools([
    "head_bounded_worker_job_status",
    "head_bounded_worker_job_reconcile",
    "head_bounded_worker_cancel",
    "head_bounded_worker_job_patch",
    "head_bounded_worker_reconcile",
    "head_bounded_worker_dispatch",
  ]),
  ...registeredTools(["head_bounded_worker_status"]),
  ...registeredTools([
    "head_bounded_worker_wait",
    "head_bounded_worker_apply_result",
    "head_bounded_worker_wave_create",
    "head_bounded_worker_wave_read",
    "head_bounded_worker_wave_seal",
    "head_bounded_worker_wave_status",
    "head_bounded_worker_wave_results",
    "head_bounded_worker_wave_wait",
    "head_bounded_worker_wave_abandon",
  ]),
  ...registeredTools(["head_run_integrate_checkpoint"]),
  ...registeredTools(["head_run_integration"]),
  {
    name: "head_world_model",
    description:
      "Completely freshness-check and digest-verify the current Repository World Model, then return a bounded read-only status projection with identities, counts, samples, and omission metadata.",
    inputSchema: {
      type: "object",
      properties: { project_root: { type: "string", minLength: 1 } },
      required: ["project_root"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  ...registeredTools(["head_incremental_refresh_status", "head_incremental_refresh_receipt", "head_refresh_trigger_status", "head_refresh_trigger_delivery"]),
  ...registeredTools(["head_graph_projection_status", "head_graphdb_projection_status", "head_graphdb_database_status"]),
  {
    name: "head_graphdb_connection_preflight",
    description:
      "Check whether the selected GraphDB credential reference names are visible to the current plugin process without contacting the endpoint or returning credential, endpoint, or database values.",
    inputSchema: {
      type: "object",
      properties: { project_root: { type: "string", minLength: 1 } },
      required: ["project_root"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_graphdb_database_initialize",
    description:
      "After explicit user confirmation, reuse a compatible selected ArcadeDB database or create a missing one. Reset is allowed only for a proven incompatible HEAD-reserved schema and an exact selected-database confirmation. Credential values are never accepted as tool input.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        confirm_initialize: { type: "boolean", const: true },
        reset_incompatible: { type: "boolean", default: false },
        confirm_database: { type: "string", minLength: 1 },
      },
      required: ["project_root", "confirm_initialize"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "head_graphdb_projection_activate",
    description:
      "After explicit user confirmation, materialize and verify the current rebuildable GraphSnapshot in the selected compatible ArcadeDB database, then advance its pointer only after complete conformance. Credential values are resolved only from stored environment reference names.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        confirm_remote_write: { type: "boolean", const: true },
      },
      required: ["project_root", "confirm_remote_write"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  ...registeredTools(["head_markdown_projection_status"]),
  ...registeredTools(["head_post_refresh_projection_status", "head_post_refresh_projection_receipt"]),
  ...registeredTools([
    "head_document_change_candidates",
    "head_document_change_review_status",
    "head_document_change_review",
    "head_document_change_application",
    "head_world_query",
    "head_git_history",
    "head_temporal_graph",
  ]),
  ...registeredTools(["head_graph_lineage_status", "head_graph_lineage_trace", "head_graph_lineage_diff"]),
  ...registeredTools(["head_runtime_state"]),
  ...registeredTools(["head_compact_prepare", "head_compact_verify", "head_compact_continue", "head_compact_status", "head_compact_abort"]),
  ...registeredTools(["head_product_signal_record", "head_product_hypothesis_record"]),
  ...registeredTools(["head_product_initiative_propose", "head_product_initiative_review"]),
  ...registeredTools(["head_product_outcome_observe", "head_product_operating_status"]),
  ...registeredTools(["head_release_observe"]),
  ...registeredTools(["head_release_status", "head_observation_sources"]),
  ...registeredTools(["head_observation_prepare", "head_observation_collect_source"]),
  ...registeredTools(["head_observation_ingest", "head_observation_derive"]),
  ...registeredTools(["head_conversation_enter", "head_compaction_lifecycle_step"]),
  ...registeredTools(["head_observation_read", "head_observation_query"]),
  {
    name: "head_continuity_snapshot",
    description:
      "Build an on-demand non-persisted derived reference view over exact Session, Run, lineage, product, and graph identities, with optional forced fresh verification. It is not recovery canon or HEAD judgment authority.",
    inputSchema: {
      type: "object",
      properties: { project_root: { type: "string", minLength: 1 }, fresh: { type: "boolean", default: false } },
      required: ["project_root"],
      additionalProperties: false,
    },
  },
];

allTools.push(
  {
    name: "head_project_graph",
    description:
      "Find project evidence through a bounded graph first. Verified historical records keep their original revision and candidate/rejection state. Missing/partial/failed graph or DB returns source fallback; no Product approval, current whole World, Run or Capsule prerequisite. Results never authorize effects or replace current user direction.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        query: { type: "string", default: "" },
        view: { type: "string", enum: ["all", "work", "product"], default: "all" },
        anchor_ids: { type: "array", items: { type: "string" }, maxItems: 32 },
        paths: { type: "array", items: { type: "string" } },
        depth: { type: "integer", minimum: 0, maximum: 8, default: 1 },
        max_nodes: { type: "integer", minimum: 1, maximum: 500 },
        max_edges: { type: "integer", minimum: 0, maximum: 1000 },
        details: {
          type: "boolean",
          default: false,
          description:
            "Default returns short core evidence (8 nodes/12 edges). Request details with fitting source paths or record anchors for original bounded payloads and relations (60/120 defaults), including recorded context and exact source comparisons when available. Recorded reasons, citations, byte changes and current state remain distinct; missing history does not require a Run, commit or new save.",
        },
        world_model_id: { type: "string" },
        include_candidates: { type: "boolean", default: true },
        inventory_page: {
          type: "boolean",
          description:
            "Opt-in read-only owned-record byte discovery. Separate untyped rows, bounded metadata/body traversal, exact read hints and explicit next arguments; never typed approval or currentness. Ordinary graph selection is unchanged when omitted.",
        },
        inventory_paths: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          items: { type: "string", minLength: 1, maxLength: 512 },
          description:
            "Optional owned canonical record files/subdirectories, usually copied from returned narrowing arguments. Separate from graph source paths.",
        },
        inventory_cursor: {
          type: "string",
          minLength: 1,
          maxLength: 4096,
          description: "Returned request-local lexical seek, bound to Project/storage/query/scope; not a durable snapshot or recovery direction.",
        },
        previous_result: { type: "object", description: "Optional prior verified result for identical-basis reuse, supplied by HEAD." },
      },
      required: ["project_root"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  ...registeredTools(["head_project_graph_index"]),
  {
    name: "head_session_create",
    description:
      "Create or reuse an independent logical HEAD Session within the canonical Project. Preserve the default Session and every existing active/unknown operation. HEAD chooses the route; users need no ID form.",
    inputSchema: {
      type: "object",
      properties: { project_root: { type: "string", minLength: 1 }, purpose: { type: "string" }, new_session_id: { type: "string" } },
      required: ["project_root"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "head_conversation_list",
    description:
      "List other live conversations for this same project across Claude Code, Codex, and OpenCode. Each row has a send address and whether it is reachable now.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        host_ticket: { type: "string", minLength: 32, maxLength: 32, description: "Host-written caller ticket. A model-authored value is not a caller." },
      },
      required: ["project_root"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_conversation_send",
    description:
      "Send a same-project conversation message. The sender is the live host caller, never an argument. The result is delivered, sent, queued, unknown, refused, or unreachable. Unknown handoffs are never automatically replayed.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        to: { type: "string", minLength: 3, maxLength: 420 },
        body: { type: "string", minLength: 1, maxLength: 6000 },
        reply_to: { type: "string", pattern: "^msg-[a-f0-9]{24}$" },
        host_ticket: { type: "string", minLength: 32, maxLength: 32, description: "Host-written caller ticket. A model-authored value is not a caller." },
      },
      required: ["project_root", "to", "body"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "head_session_list",
    description:
      "Read a bounded logical Session page; session_id previews one Session's exact work and Todo without changing any selection. Unread/failed entries remain explicit; recent results are not whole-work completion or ownership. Follow nextAfterSessionId when needed.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        max_sessions: { type: "integer", minimum: 1, maximum: 64 },
        after_session_id: { type: "string", maxLength: 512 },
        conversation_candidates: {
          type: "array",
          description:
            "Optional untrusted Host lookup selectors, at most 16 inspected. Each row supplies runtime, native_session_id, optional agent_id, and explicit environment_scope=current or unsupported-other. Invalid rows are reported separately. No caller, route, contact or ownership is inferred.",
          items: {},
        },
      },
      required: ["project_root"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  ...registeredTools(["head_project_direction_read", "head_project_direction_update"]),
);

allTools.push(...registeredTools(["head_run_start"]));

for (const tool of allTools) {
  if (tool.inputSchema?.properties?.project_root) {
    tool.inputSchema.properties.session_id = {
      type: "string",
      description: "Optional logical HEAD Session route, selected by HEAD/Host. Omit for the existing default. Never a provider session ID.",
    };
  }
  if (tool.annotations?.readOnlyHint === undefined && Object.hasOwn(supplementalReadOnlyHints, tool.name)) {
    tool.annotations = { ...tool.annotations, readOnlyHint: supplementalReadOnlyHints[tool.name] };
  }
}

// Stateless discovery, not a registration store or permission/activation system.
allTools.push({
  name: SESSION_HOST_REQUEST_HELPER,
  description:
    "Internal native Host Hook ingress for one transient request correlation. No logical Session selection, original write, permission or recovery authority. Ordinary model calls cannot mint native claims; users never fill this input.",
  inputSchema: {
    type: "object",
    properties: {
      native_session_id: { type: "string", minLength: 1, maxLength: 512 },
      native_agent_id: { type: ["string", "null"], maxLength: 512 },
      native_project_root: { type: "string", description: "Optional trusted Hook cwd; model input is not proof of plugin loading or Project scope." },
      tool_use_id: { type: "string", minLength: 1, maxLength: 512 },
      outer_tool_name: { type: "string", minLength: 1, maxLength: 512 },
      original_arguments: { type: "string", minLength: 2 },
    },
    required: ["native_session_id", "tool_use_id", "outer_tool_name", "original_arguments"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
});
const defaultToolNames = new Set([
  SESSION_HOST_REQUEST_HELPER,
  "head_core_contract",
  "head_project_initialize_or_resume",
  "head_conversation_enter",
  "head_conversation_list",
  "head_conversation_send",
  "head_project_graph",
  // The unresolved-Session entry names head_session_list as its discovery call, so
  // it must be directly callable from the default surface, not only via routing.
  "head_session_create",
  "head_session_list",
  "head_project_direction_update",
  "head_project_status",
  "head_checkpoint_diagnose",
  "head_checkpoint_basis",
  "head_checkpoint_sync",
  "head_session_restore",
  "head_pending_review",
  "head_runtime_invocation_lease_status",
  "head_bounded_worker_job_status",
  "head_bounded_worker_cancel",
  "head_worker_integration_status",
]);
const routedInputSchema = {
  type: "object",
  properties: {
    name: { type: "string", description: "Exact tool name from discovery or a known HEAD contract." },
    arguments: { type: "object", description: "Arguments following that tool's returned inputSchema; HEAD supplies them, not a user form." },
  },
  required: ["name", "arguments"],
  additionalProperties: false,
};
const discoveryTools = [
  {
    name: "head_tools_discover",
    description:
      "Read optional HEAD capability prefixes, or exact schemas by name/prefix. No Project, registration, activation or approval needed. Use only when the task needs Product, Graph, Observation, Context or retained-work diagnostics; page with nextOffset.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "One exact tool name; mutually exclusive with prefix." },
        prefix: { type: "string", description: "A returned tool prefix." },
        offset: { type: "integer", minimum: 0, default: 0 },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 8 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_tools_read",
    description:
      "Call a discovered read-only HEAD tool using its exact inputSchema. Returns the original result and errors. No discovery prerequisite, Project activation or authority change; independent work remains available if an optional capability fails.",
    inputSchema: routedInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "head_tools_call",
    description:
      "Call a discovered HEAD operation using its exact inputSchema within existing user scope. Original authority, current-basis, ownership, replay and maintenance checks still apply. Discovery grants no authorization. Prefer head_tools_read for read-only operations.",
    inputSchema: {
      ...routedInputSchema,
      properties: {
        ...routedInputSchema.properties,
        execution_mode: {
          type: "string",
          enum: ["ordinary", "managed"],
          default: "ordinary",
          description: "HEAD selects managed only for needed durable ownership/recovery/effect guarantees. It grants no new authorization.",
        },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
];
// Complete ordinary schemas for programmatic consumers; tools/list stays small.
export const catalogTools = allTools.map(presentedTool);
export function toolsForSurface(surface = "ordinary") {
  requireSurface(surface);
  return [...allTools.filter((tool) => (surface === "managed-maintenance" ? true : defaultToolNames.has(tool.name))), ...discoveryTools].map(presentedTool);
}
export const tools = toolsForSurface();

export function discoverTools({ name, prefix, offset = 0, limit = 8 } = {}, surface = "ordinary") {
  requireSurface(surface);
  if (
    (name != null && typeof name !== "string") ||
    (prefix != null && typeof prefix !== "string") ||
    (name != null && prefix != null) ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 20
  )
    throw new Error("Invalid tool discovery selector or page.");
  const available = allTools.map(presentedTool);
  if (name != null) name = publicToolName(name);
  if (prefix != null) {
    const known = DISCOVERY_PREFIX_PAIRS.find((pair) => pair.legacy === prefix || pair.canonical === prefix);
    if (known) prefix = ARTIFACT_COMPOSITION.identity === "lode" ? known.canonical : known.legacy;
  }
  const scope = {
    surface,
    persisted: false,
    grantsAuthorization: false,
    managedEntry: `${publicToolName("head_tools_call")} with execution_mode: managed; original authorization, scope, lease and result checks apply`,
    maintenanceEntry: "scripts/mcp-managed-maintenance.mjs (same managed execution contract; retained reader supported)",
  };
  if (name == null && prefix == null) {
    const counts = new Map();
    for (const tool of available) {
      const key = `${ARTIFACT_COMPOSITION.toolPrefix}${tool.name.split("_")[1]}_`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return { ...scope, prefixes: [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([prefix, count]) => ({ prefix, count })), nextOffset: null };
  }
  const matches = available.filter((tool) => {
    if (name != null) return tool.name === name;
    const descriptor = resolveOperation(tool.name);
    return tool.name.startsWith(prefix) || descriptor?.legacyName.startsWith(prefix) || descriptor?.canonicalName.startsWith(prefix);
  });
  if (name != null && !matches.length) throw new Error(`Unknown or unavailable tool on ${surface}: ${name}`);
  return {
    ...scope,
    total: matches.length,
    offset,
    nextOffset: offset + limit < matches.length ? offset + limit : null,
    tools: matches.slice(offset, offset + limit).map((tool) => ({
      ...tool,
      invokeWith: publicToolName(tool.annotations?.readOnlyHint === true ? "head_tools_read" : "head_tools_call"),
      ...(isManagedMutation(tool.name) ? { executionMode: "managed" } : {}),
    })),
  };
}

function requestedToolName(request) {
  return ["head_tools_read", "head_tools_call"].includes(semanticToolName(request.params?.name))
    ? semanticToolName(request.params?.arguments?.name)
    : semanticToolName(request.params?.name);
}

// Use the shared policy after router unwrap. OpenCode applies it to the exact
// Host before-hook; MCP uses its own caller and optional Codex observations.
// Disabled mode does not read observations.
async function subagentStateWriteRejection(name, args, caller, environment) {
  const selected = allTools.find((tool) => semanticToolName(tool.name) === name);
  if (!selected || selected.annotations?.readOnlyHint === true) return null;
  if (!subagentWriteGuardEnabled(environment, { caller })) return null;
  // A cold catalog or disabled guard must not load optional Codex observations.
  let current = caller && typeof caller === "object" ? { ...caller } : null;
  if (current?.runtime === "codex" && current.subagent !== true && typeof args?.project_root === "string" && typeof current.nativeSessionId === "string") {
    const { recordedSubagentCaller } = await import("./lib/subagent-caller-signal.mjs");
    if (recordedSubagentCaller({ root: args.project_root, runtime: "codex", nativeSessionId: current.nativeSessionId, environment }))
      current = { ...current, subagent: true };
  }
  const decision = assessSubagentStateWrite({ caller: current, readOnly: false });
  return decision.allowed ? null : decision.message;
}

const success = (id, result) => ({ jsonrpc: "2.0", id, result });
// Library errors carry a stable reason code (error.code). Keep it on the wire in
// error.data.reasonCode so agents can branch on the documented code, not the text.
const failure = (id, message, reasonCode) => ({
  jsonrpc: "2.0",
  id,
  error: { code: -32000, message, ...(typeof reasonCode === "string" && reasonCode ? { data: { reasonCode } } : {}) },
});
export const WORLD_MODEL_STATUS_MCP_MAX_BYTES = 4 * 1024 * 1024;

function onboardingInputFromMcp(args) {
  const onboarding = {};
  if (args.mode != null) onboarding.mode = args.mode;
  if (args.source_scope != null)
    onboarding.sourceScope = {
      includeRoots: args.source_scope.include_roots || [],
      excludeRoots: args.source_scope.exclude_roots || [],
    };
  if (args.storage != null)
    onboarding.storage =
      args.storage.mode === "local"
        ? { mode: "local" }
        : {
            mode: "graphdb",
            endpoint: args.storage.endpoint,
            database: args.storage.database,
            secretReferenceNames: {
              username: args.storage.username_secret_reference,
              password: args.storage.password_secret_reference,
            },
          };
  if (args.brief != null) onboarding.brief = args.brief;
  if (args.semantic_proposal != null) onboarding.semanticProposal = args.semantic_proposal;
  return onboarding;
}

async function initializeGraphDbFromMcp(args, transport) {
  requireMcpConfirmation(
    args.confirm_initialize,
    "ArcadeDB database initialization requires explicit user confirmation.",
    "ARCADEDB_DATABASE_INITIALIZE_CONFIRMATION_REQUIRED",
  );
  return (await import("./lib/arcadedb-database-lifecycle.mjs")).initializeArcadeDbDatabase({
    root: args.project_root,
    storage: resolveProjectStorage(args.project_root),
    resetIncompatible: args.reset_incompatible === true,
    confirmDatabase: args.confirm_database || "",
    transport,
  });
}

async function activateGraphDbFromMcp(args, transport) {
  requireMcpConfirmation(
    args.confirm_remote_write,
    "ArcadeDB graph projection activation requires explicit user confirmation.",
    "ARCADEDB_PROJECTION_ACTIVATION_CONFIRMATION_REQUIRED",
  );
  return await (await import("./lib/graphdb-projection-activation.mjs")).activateArcadeDbGraphProjection({ root: args.project_root, transport });
}

async function continueSessionFromMcp(args, coordinationWorkspaceHost) {
  const continuation = await import("./lib/runtime-session-continuation.mjs");
  if (!coordinationWorkspaceHost)
    return continuation.continueSessionFromArtifacts({
      root: args.project_root,
      checkpointId: args.checkpoint_id || null,
      runtime: args.runtime,
    });
  // Restore P2 before consulting a Host. Endpoint availability is optional P5,
  // not recovery direction or a new role-binding/token ceremony.
  const restored = (await import("./lib/session-recovery.mjs")).restoreSessionFromArtifacts({
    root: args.project_root,
    checkpointId: args.checkpoint_id || null,
  });
  const restoredFormat = familyFormatForOriginal("head-agent-core-artifact-session-restore", restored.projection);
  if (coordinationWorkspaceHost.projectRoot) {
    const requested = fs.realpathSync(path.resolve(args.project_root));
    const injected = fs.realpathSync(path.resolve(coordinationWorkspaceHost.projectRoot));
    if (requested !== injected) {
      const error = new Error("The host-injected attachment project does not match the requested project.");
      error.code = "HOST_ATTACHMENT_PROJECT_MISMATCH";
      throw error;
    }
  }
  let hostAttachment = null;
  try {
    hostAttachment = coordinationWorkspaceHost.adapter.attach({
      caller: coordinationWorkspaceHost.caller,
      boundary: {
        projectId: restored.projection.projectId,
        [restoredFormat.sessionIdField]: restored.projection.sessionId,
        role: "head",
        projectRoot: fs.realpathSync(path.resolve(args.project_root)),
      },
    });
  } catch (error) {
    if (["WORKSPACE_HOST_PROJECT_MISMATCH", "STALE_WORKSPACE_HOST_ATTACHMENT", "INVALID_WORKSPACE_HOST_BOUNDARY"].includes(error?.code)) throw error;
    // Optional Host availability cannot erase successfully restored direction.
  }
  return continuation.continueSessionFromArtifacts({
    root: args.project_root,
    checkpointId: args.checkpoint_id || null,
    runtime: args.runtime,
    hostAttachment,
    attachmentRequested: true,
    workspaceHostAdapter: coordinationWorkspaceHost.adapter,
  });
}

async function unresolvedSessionResponse(id, name, root, reasonCode) {
  try {
    const routing = await import("./lib/session-routing.mjs");
    const value = routing.sessionSelectionUnresolved(root, {
      includeProjectFacts: ["head_project_status", "head_conversation_enter"].includes(name),
      reasonCode,
    });
    // Keep the existing exceptional JSON-text + structuredContent contract.
    // Normal dispatch still uses each tool's own human/JSON presentation.
    return success(id, { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
  } catch (error) {
    return failure(id, error.message, error?.code);
  }
}

export async function dispatch(request, options = {}) {
  if (options.nativeSessionBridge && !options.sessionContext && !options.resolveSessionContext) {
    return options.nativeSessionBridge.dispatch(request, async (original, routing) => await dispatchSessionRequest(original, { ...options, ...routing }));
  }
  return await dispatchSessionRequest(request, options);
}

async function dispatchSessionRequest(request, options = {}) {
  const outer = request.params?.arguments;
  const routed = ["head_tools_read", "head_tools_call"].includes(semanticToolName(request.params?.name));
  const args = routed ? outer?.arguments : outer;
  const hasSelection = args && Object.hasOwn(args, "session_id");
  const requestedName = semanticToolName(routed ? outer?.name : request.params?.name);
  // A verified child write has the same optional policy regardless of whether
  // its caller has selected a logical Session. Reject it before an unrelated
  // absent-binding diagnostic can hide the existing write-guard explanation.
  // Unknown/parent callers and disabled guards retain their normal routing.
  if (request.method === "tools/call") {
    const rejection = await subagentStateWriteRejection(requestedName, args, options.caller, options.hostEnvironment ?? process.env);
    if (rejection) return failure(request.id ?? null, rejection);
    // The Session/location steps below read project_root before dispatch, so a
    // wrong type is refused here; the required/empty checks follow the surface,
    // router and read-only checks inside the routed dispatcher.
    if (args && typeof args === "object" && !Array.isArray(args) && args.project_root !== undefined && typeof args.project_root !== "string") {
      return failure(
        request.id ?? null,
        `Invalid arguments for ${publicToolName(requestedName)}: arguments.project_root must be string, got ${args.project_root === null ? "null" : typeof args.project_root}.`,
        "INVALID_TOOL_ARGUMENTS",
      );
    }
  }
  // Only views/effects that actually consume the selected Session need its
  // binding. Project-scoped Product/Observation/source work is independent.
  const dependent = sessionCallRequiresBinding(requestedName);
  let sessionContext = options.sessionContext;
  let bindingFailure = null;
  if (request.method === "tools/call" && args?.project_root && requestedName === "head_project_status") {
    try {
      const { inspectProjectLocationExperience } = await import("./lib/project-bootstrap.mjs");
      const projectLocationProjection = inspectProjectLocationExperience({ root: args.project_root, sessionId: hasSelection ? args.session_id : undefined });
      if (projectLocationProjection) return await dispatchRouted(request, { ...options, projectLocationProjection });
    } catch (error) {
      return failure(request.id ?? null, error.message, error?.code);
    }
  }
  // Explicit resume validates/adopts the local Project location before an
  // optional native Host adapter can read its binding at that current root.
  // Other tools retain the original selected-Session call boundary unchanged.
  if (
    request.method === "tools/call" &&
    args?.project_root &&
    requestedName === "head_project_initialize_or_resume" &&
    (hasSelection || sessionContext || options.resolveSessionContext)
  ) {
    try {
      if (hasSelection && typeof args.session_id !== "string")
        throw new Error("An explicit logical Session route must be text; omit it for an unspecified route.");
      const cleanArgs = { ...args };
      delete cleanArgs.session_id;
      const clean = { ...request, params: { ...request.params, arguments: routed ? { ...outer, arguments: cleanArgs } : cleanArgs } };
      const response = await dispatchRouted(clean, {
        ...options,
        projectSessionRoute: {
          sessionId: hasSelection ? args.session_id : undefined,
          context: sessionContext,
          resolveContext: options.resolveSessionContext
            ? async () => {
                try {
                  return await options.resolveSessionContext(request);
                } catch (error) {
                  bindingFailure = error.code || "HEAD_SESSION_CONTEXT_UNAVAILABLE";
                  throw error;
                }
              }
            : null,
        },
      });
      if (bindingFailure && hasSelection && response?.result)
        response.result._meta = {
          ...response.result._meta,
          headSessionBinding: {
            status: "unavailable",
            reasonCode: bindingFailure,
            scope: "current-explicit-request-only",
            retainedForSubsequentCalls: false,
            persisted: false,
          },
        };
      return response;
    } catch (error) {
      return failure(request.id ?? null, error.message, error?.code);
    }
  }
  // Discovery's existing session_id is an exact preview target, never a request
  // to update native persistence, a shared caller context, or the outer route.
  if (request.method === "tools/call" && requestedName === "head_session_list") return await dispatchRouted(request, options);
  if (args?.project_root && (hasSelection || dependent) && !sessionContext && options.resolveSessionContext) {
    try {
      sessionContext = await options.resolveSessionContext(request);
    } catch (error) {
      if (hasSelection) {
        // Exact explicit routing is independent of optional Host persistence.
        // Existing route validation below still rejects invalid/foreign IDs.
        bindingFailure = error.code || "HEAD_SESSION_CONTEXT_UNAVAILABLE";
      } else {
        return await unresolvedSessionResponse(request.id ?? null, requestedName, args.project_root, error.code || "HEAD_SESSION_CONTEXT_UNAVAILABLE");
      }
    }
  }
  if (request.method === "tools/call" && args?.project_root && (hasSelection || sessionContext)) {
    try {
      const name = routed ? outer.name : request.params.name;
      const selected = allTools.find((tool) => semanticToolName(tool.name) === semanticToolName(name));
      if (!selected?.inputSchema?.properties?.session_id) throw new Error("This operation has no project Session route.");
      if (hasSelection && typeof args.session_id !== "string")
        throw new Error("An explicit logical Session route must be text; omit it for an unspecified route.");
      const cleanArgs = { ...args };
      delete cleanArgs.session_id;
      const clean = { ...request, params: { ...request.params, arguments: routed ? { ...outer, arguments: cleanArgs } : cleanArgs } };
      if (!hasSelection && !dependent) return await dispatchRouted(clean, options);
      const { withSessionCallContext } = await import("./lib/session-routing.mjs");
      const response = await withSessionCallContext(
        { root: args.project_root, sessionId: hasSelection ? args.session_id : undefined, context: sessionContext },
        async () => await dispatchRouted(clean, options),
      );
      if (bindingFailure && response?.result)
        response.result._meta = {
          ...response.result._meta,
          headSessionBinding: {
            status: "unavailable",
            reasonCode: bindingFailure,
            scope: "current-explicit-request-only",
            retainedForSubsequentCalls: false,
            persisted: false,
          },
        };
      return response;
    } catch (error) {
      if (error.code === "HEAD_SESSION_SELECTION_LOST") {
        return await unresolvedSessionResponse(request.id ?? null, requestedName, args.project_root, error.code);
      }
      return failure(request.id ?? null, error.message, error?.code);
    }
  }
  return await dispatchRouted(request, options);
}

async function dispatchRouted(
  request,
  {
    surface = "ordinary",
    graphDbTransport = null,
    coordinationWorkspaceHost = null,
    observationRegistry = null,
    conformanceTriggerRegistry = null,
    compactionLifecycleHost = null,
    workerJobHost = null,
    workerJobSupervisor = null,
    workerPreparationBackend = null,
    nativeHistoryHost = null,
    signal,
    onProcess,
    onExportScope = null,
    onValidatedSessionSelection = null,
    readRelatedNativeContext = null,
    projectSessionRoute = null,
    projectLocationProjection = null,
    caller = null,
    hostEnvironment = process.env,
    pluginLaunch = null,
    servingModuleUrl = null,
    installationCaller = null,
  } = {},
) {
  requireSurface(surface);
  const id = request.id ?? null;
  if (request.method === "initialize") {
    return success(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: ARTIFACT_COMPOSITION.serverName, version: packageVersion },
      instructions: coreEntryGuidance(),
    });
  }
  if (request.method === "notifications/initialized") return null;
  if (request.method === "tools/list") return success(id, { tools: toolsForSurface(surface) });
  if (request.method !== "tools/call") return failure(id, "Method not found");
  try {
    let name = semanticToolName(request.params?.name);
    let args = request.params?.arguments || {};
    if (name === "head_tools_discover") {
      const value = discoverTools(args, surface);
      return success(id, { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
    }
    if (name === "head_tools_read" || name === "head_tools_call") {
      const selected = allTools.find((tool) => semanticToolName(tool.name) === semanticToolName(args.name));
      const descriptor = resolveOperation(args.name);
      if (
        !selected ||
        descriptor?.kind !== "operation" ||
        !args.arguments ||
        typeof args.arguments !== "object" ||
        Array.isArray(args.arguments) ||
        Object.keys(args).some((key) => !["name", "arguments", ...(name === "head_tools_call" ? ["execution_mode"] : [])].includes(key))
      )
        throw new Error("An exact HEAD tool name and arguments object are required; routing cannot be nested.");
      if (args.execution_mode != null && !["ordinary", "managed"].includes(args.execution_mode)) throw new Error("Unknown execution mode.");
      if (name === "head_tools_call" && args.execution_mode === "managed") surface = "managed-maintenance";
      if (name === "head_tools_read" && selected.annotations?.readOnlyHint !== true)
        throw new Error("The selected tool is not read-only; use its declared effectful route within existing authority.");
      name = semanticToolName(selected.name);
      args = args.arguments;
    }
    requireOperationSurface(name, surface);
    // A declared, required project_root is the contract: refuse its absence or a
    // wrong type after the surface, router and read-only checks and before any
    // handler reads it (otherwise a missing root meant the server's cwd). Other
    // argument rules stay with the operation's own, CLI-identical refusal.
    const declaredSchema = allTools.find((tool) => semanticToolName(tool.name) === name)?.inputSchema;
    if (declaredSchema) assertProjectRootArgument(publicToolName(name), declaredSchema, args);
    const registered = registeredOperation(name);
    const value = registered
      ? await callRegistered(registered, "mcp", args, {
          onProcess,
          signal,
          workerJobHost,
          workerJobSupervisor,
          workerPreparationBackend,
          observationRegistry,
          graphDbTransport,
          compactionLifecycleHost,
          readRelatedNativeContext,
        })
      : await (name === "head_core_contract"
          ? {
              ...coreContract(),
              runtime: {
                activePackageVersion: packageVersion,
                reloadPolicy: "restart-host-after-install-or-upgrade",
                providerSessionIdentityPersisted: false,
                compactionLifecycle: {
                  conversationEntryRecovery: "active",
                  injectedHostContract: "active",
                  packagedProviderEventAdapters: { claude: "not-bound", codex: "not-bound", opencode: "not-bound" },
                  unavailableBehavior: "non-blocking-p2-artifact-entry-recovery",
                },
              },
            }
          : name === "head_project_status"
            ? (projectLocationProjection ?? (await (await import("./lib/project-bootstrap.mjs")).inspectProjectExperience({ root: args.project_root })))
            : name === "head_project_graph"
              ? await (
                  await import("./lib/project-graph.mjs")
                ).queryProjectGraph({
                  root: args.project_root,
                  query: args.query ?? "",
                  view: args.view ?? "all",
                  anchorIds: args.anchor_ids ?? [],
                  paths: args.paths ?? [],
                  depth: args.depth,
                  details: args.details ?? false,
                  maxNodes: args.max_nodes,
                  maxEdges: args.max_edges,
                  worldModelId: args.world_model_id ?? "",
                  includeCandidates: args.include_candidates ?? true,
                  previousResult: args.previous_result ?? null,
                  inventoryPage: args.inventory_page === true,
                  inventoryPaths: args.inventory_paths,
                  inventoryCursor: args.inventory_cursor,
                })
              : name === "head_project_native_history"
                ? await projectNativeHistoryFromMcp(args, signal, nativeHistoryHost, onProcess)
                : name === "head_project_bundle_export" || name === "head_project_bundle_read" || name === "head_project_bundle_import"
                  ? await projectBundleFromMcp(name, args, signal, onExportScope)
                  : name === "head_session_create"
                    ? (await import("./lib/session-routing.mjs")).createHeadSession({
                        root: args.project_root,
                        sessionId: args.new_session_id,
                        purpose: args.purpose,
                      })
                    : name === "head_session_list"
                      ? await (
                          await import("./lib/session-work-context.mjs")
                        ).readSessionWorkList({
                          root: args.project_root,
                          sessionId: args.session_id ?? null,
                          maxSessions: args.max_sessions ?? 16,
                          afterSessionId: args.after_session_id ?? null,
                          conversationCandidates: args.conversation_candidates,
                          conversationEnvironment: hostEnvironment,
                        })
                      : name === "head_onboarding_guide"
                        ? await (
                            await import("./lib/onboarding-conversation.mjs")
                          ).inspectConversationalOnboarding({ root: args.project_root, candidateLimit: args.candidate_limit ?? 25 })
                        : name === "head_project_initialize_or_resume"
                          ? await initializeProjectFromMcp(args, {
                              projectSessionRoute,
                              onValidatedSessionSelection,
                              pluginLaunch,
                              servingModuleUrl,
                              installationCaller,
                            })
                          : name === "head_runtime_invocation_result"
                            ? await runtimeResultFromMcp(args)
                            : name === "head_conformance_trigger_status"
                              ? conformanceTriggerRegistry
                                ? conformanceTriggerRegistry.inspect({
                                    root: args.project_root,
                                    sourceId: args.source_id,
                                  })
                                : {
                                    status: "optional-host-adapter-unavailable",
                                    ordinaryWorkBlocked: false,
                                    authority: "P5-capability-disclosure-only",
                                  }
                              : name === "head_conformance_trigger_prepare"
                                ? conformanceTriggerRegistry
                                  ? conformanceTriggerRegistry.prepare({
                                      root: args.project_root,
                                      sourceId: args.source_id,
                                      limit: args.limit ?? 64,
                                    })
                                  : {
                                      status: "optional-host-adapter-unavailable",
                                      ordinaryWorkBlocked: false,
                                      authority: "P5-capability-disclosure-only",
                                    }
                                : name === "head_session_work_record"
                                  ? await (
                                      await import("./lib/session-work-document-workflow.mjs")
                                    ).recordSessionWorkAndProjectDocuments({
                                      root: args.project_root,
                                      input: args.evidence,
                                      documentSelection: args.document_selection,
                                    })
                                  : name.startsWith("head_work_document_") || name.startsWith("head_project_document_")
                                    ? await workDocumentFromMcp(name, args)
                                    : name === "head_session_continue"
                                      ? await continueSessionFromMcp(args, coordinationWorkspaceHost)
                                      : name === "head_worker_integration"
                                        ? await workerIntegrationFromMcp(args, onProcess)
                                        : name === "head_worker_integration_status"
                                          ? await workerIntegrationFromMcp(args, onProcess, true)
                                          : name === "head_world_model"
                                            ? await (
                                                await import("./lib/world-model.mjs")
                                              ).inspectWorldModelStatus({
                                                root: args.project_root,
                                              })
                                            : name === "head_graphdb_connection_preflight"
                                              ? (await import("./lib/graphdb-projection-activation.mjs")).inspectArcadeDbCredentialPreflight({
                                                  root: args.project_root,
                                                  transport: graphDbTransport,
                                                  storage: resolveProjectStorage(args.project_root),
                                                })
                                              : name === "head_graphdb_database_initialize"
                                                ? await initializeGraphDbFromMcp(args, graphDbTransport)
                                                : name === "head_graphdb_projection_activate"
                                                  ? await activateGraphDbFromMcp(args, graphDbTransport)
                                                  : name === "head_continuity_snapshot"
                                                    ? await (
                                                        await import("./lib/product-operating-loop.mjs")
                                                      ).buildHeadContinuitySnapshot({
                                                        root: args.project_root,
                                                        fresh: args.fresh ?? false,
                                                      })
                                                    : name === "head_conversation_list"
                                                      ? await (
                                                          await import("./lib/conversation-messaging.mjs")
                                                        ).listProjectConversations({
                                                          root: args.project_root,
                                                          caller,
                                                          environment: hostEnvironment,
                                                          hostTicket: args.host_ticket ?? null,
                                                        })
                                                      : name === "head_conversation_send"
                                                        ? await (
                                                            await import("./lib/conversation-messaging.mjs")
                                                          ).sendProjectConversation({
                                                            root: args.project_root,
                                                            caller,
                                                            environment: hostEnvironment,
                                                            to: args.to,
                                                            body: args.body,
                                                            replyTo: args.reply_to ?? null,
                                                            hostTicket: args.host_ticket ?? null,
                                                            waitMs: Number(hostEnvironment?.LODE_CONVERSATION_DELIVERY_WAIT_MS || 0),
                                                            signal,
                                                          })
                                                        : (() => {
                                                            throw new Error(`Unknown tool: ${name}`);
                                                          })());
    // MCP structuredContent is an optional object, never null/array/scalar.
    // Keep absent originals as their original text value, not fabricated state.
    const response = success(id, {
      content: [{ type: "text", text: formatMcpToolContent(name, value) }],
      ...(value !== null && typeof value === "object" && !Array.isArray(value) ? { structuredContent: value } : {}),
    });
    if (name === "head_world_model" && Buffer.byteLength(JSON.stringify(response), "utf8") > WORLD_MODEL_STATUS_MCP_MAX_BYTES) {
      throw new Error(`head_world_model response exceeds ${WORLD_MODEL_STATUS_MCP_MAX_BYTES} bytes.`);
    }
    return response;
  } catch (error) {
    return failure(id, error.message, error?.code);
  }
}

export function serveMcp({
  surface = "ordinary",
  coordinationWorkspaceHost = null,
  observationRegistry = null,
  conformanceTriggerRegistry = null,
  compactionLifecycleHost = null,
  workerJobHost = null,
  workerJobSupervisor = null,
  sessionContext = null,
  resolveSessionContext = null,
  nativeSessionBridge,
  pluginLaunch = null,
  onExportScope = null,
  nativeHistoryHost = null,
} = {}) {
  requireSurface(surface);
  if (nativeSessionBridge === undefined) nativeSessionBridge = createNativeSessionHostBridge({ pluginLaunch, servingModuleUrl: import.meta.url });
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const sourceRequests = new Map();
  const abortSources = () => {
    for (const controller of sourceRequests.values()) controller.abort();
  };
  let closing = false;
  const shutdown = () => {
    abortSources();
    input.close();
  };
  const cleanupSignals = () => {
    if (closing && !sourceRequests.size) {
      process.removeListener("SIGINT", shutdown);
      process.removeListener("SIGTERM", shutdown);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  input.once("close", () => {
    closing = true;
    abortSources();
    nativeSessionBridge?.dispose?.();
    cleanupSignals();
  });
  input.on("line", async (line) => {
    if (!line.trim()) return;
    let response;
    let sourceRequestId,
      ownsSourceRequest = false;
    try {
      const request = JSON.parse(line);
      if (request.method === "notifications/cancelled") {
        sourceRequests.get(request.params?.requestId)?.abort();
        return;
      }
      let controller;
      if (request.method === "tools/call" && requestedToolName(request) === "head_source_context") {
        sourceRequestId = request.id;
        if (sourceRequests.has(sourceRequestId)) throw new Error("Duplicate active source request id.");
        controller = new AbortController();
        sourceRequests.set(sourceRequestId, controller);
        ownsSourceRequest = true;
      }
      response = await dispatch(request, {
        surface,
        coordinationWorkspaceHost,
        observationRegistry,
        conformanceTriggerRegistry,
        compactionLifecycleHost,
        workerJobHost,
        workerJobSupervisor,
        sessionContext,
        resolveSessionContext,
        nativeSessionBridge,
        nativeHistoryHost,
        signal: controller?.signal,
        onExportScope: onExportScope ?? ((notice) => fs.writeSync(process.stderr.fd, `${JSON.stringify({ projectExportScope: notice })}\n`)),
        onProcess: (event) => process.stderr.write(`${JSON.stringify({ sourceProcess: event })}\n`),
      });
    } catch (error) {
      response = failure(null, `Parse error: ${error.message}`);
    } finally {
      if (ownsSourceRequest) sourceRequests.delete(sourceRequestId);
      cleanupSignals();
    }
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  });
  return input;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) serveMcp();

async function projectBundleFromMcp(name, args, signal, onExportScope = null) {
  const fields =
    name === "head_project_bundle_export"
      ? ["project_root", "destination", "provenance_scope", "source_mode"]
      : name === "head_project_bundle_read"
        ? ["bundle_root", "expected_bundle_id", "include_native_history", "handoff_file", "handoff_offset", "handoff_max_bytes"]
        : ["target_root", "bundle_root", "expected_bundle_id"];
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((key) => !fields.includes(key)))
    throw new Error("Unsupported Project bundle arguments.");
  const required =
    name === "head_project_bundle_export" ? ["project_root", "destination"] : name === "head_project_bundle_read" ? [] : ["target_root", "bundle_root"];
  if (required.some((key) => typeof args[key] !== "string" || !args[key].trim())) throw new Error("Project bundle locations must be non-empty text.");
  const core = await import("./lib/project-portability.mjs");
  if (name === "head_project_bundle_read") {
    const handoffOptions = { offset: args.handoff_offset ?? 0, maxBytes: args.handoff_max_bytes ?? 65536 };
    if (args.handoff_file !== undefined) {
      if (args.bundle_root !== undefined || args.expected_bundle_id !== undefined || args.include_native_history !== undefined)
        throw new Error("Choose a standalone handoff_file or one bundle_root.");
      return (await import("./lib/project-handoff.mjs")).readProjectHandoffFile({ file: args.handoff_file, ...handoffOptions, signal });
    }
    if (typeof args.bundle_root !== "string" || !args.bundle_root.trim()) throw new Error("A bundle_root or explicit standalone handoff_file is required.");
    if (args.include_native_history !== undefined && typeof args.include_native_history !== "boolean")
      throw new Error("include_native_history must be boolean.");
    const common = core.projectBundleSummary(
      core.inspectProjectBundle({ bundleRoot: args.bundle_root, expectedBundleId: args.expected_bundle_id ?? null, signal, handoffOptions }),
    );
    if (!args.include_native_history) return common;
    const native = await import("./lib/project-native-transfer.mjs");
    try {
      return {
        ...common,
        nativeHistory: native.projectNativeTransferSummary(
          native.readProjectNativeTransfer({ bundleRoot: args.bundle_root, expectedBundleId: common.bundleId, signal }),
        ),
      };
    } catch (error) {
      return {
        ...common,
        nativeHistory: {
          status: "native-transfer-invalid",
          isError: true,
          primaryFailure: { code: error.code || "NATIVE_TRANSFER_READ_FAILED" },
          ordinaryCoreBlocked: false,
        },
      };
    }
  }
  if (name === "head_project_bundle_export")
    return core.exportProjectBundle({
      root: args.project_root,
      destination: args.destination,
      provenanceScope: args.provenance_scope,
      sourceMode: args.source_mode,
      signal,
      onExportScope,
    });
  const result = core.importProjectBundle({
    root: args.target_root,
    bundleRoot: args.bundle_root,
    expectedBundleId: args.expected_bundle_id ?? null,
    pluginRoot,
    signal,
  });
  return {
    ...result,
    nextRead: { tool: publicToolName("head_conversation_enter"), arguments: { project_root: result.targetRoot, session_id: result.selectedSessionId } },
    selectionScope: "exact-current-request-no-default-change",
  };
}

async function projectNativeHistoryFromMcp(args, signal, nativeHistoryHost = null, onProcess) {
  const allowed = ["action", "provider", "bundle_root", "expected_bundle_id", "native_home", "executable", "thread_ids", "runtime_root", "companion_paths"];
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((key) => !allowed.includes(key)))
    throw new Error("Unsupported native history arguments.");
  if (typeof args.bundle_root !== "string" || !args.bundle_root.trim()) throw new Error("Native history requires one exact bundle location.");
  return (await import("./lib/project-native-history.mjs")).operateProjectNativeHistory({
    action: args.action,
    provider: args.provider,
    bundleRoot: args.bundle_root,
    expectedBundleId: args.expected_bundle_id ?? null,
    nativeHome: args.native_home,
    executable: args.executable,
    threadIds: args.thread_ids,
    root: args.runtime_root,
    companionPaths: args.companion_paths ?? [],
    nativeHistoryHost,
    pluginRoot,
    signal,
    onProcess,
  });
}

#!/usr/bin/env node
import readline from "node:readline";
import { resolveOperation } from "./lib/lode-operation-contract.mjs";
import { ARTIFACT_COMPOSITION, publicToolName } from "./lib/lode-artifact-composition.mjs";
import { DISCOVERY_PREFIX_PAIRS } from "../compat/head/public-names.mjs";
const semanticToolName = name => resolveOperation(name)?.semanticName ?? name;
const presentedSchemas = new WeakMap();
const presentedSchema = value => Array.isArray(value) ? value.map(presentedSchema)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    ["description", "title"].includes(key) && typeof entry === "string" ? entry.replace(/\bHEAD\b/g, "Lode") : presentedSchema(entry)])) : value;
const presentedTool = tool => {
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
import { DEFAULT_CONTEXT_BUDGET } from "./lib/context-budget.mjs";
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
const workEvidenceText = { type: "string", minLength: 1 };
const workEvidenceList = { type: "array", items: workEvidenceText };
const exactWorkEvidenceSchema = { type: "object", properties: {
  evidenceId: { type: "string", pattern: "^work-evidence-[a-f0-9]{24}$" },
  evidenceDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
}, required: ["evidenceId", "evidenceDigest"], additionalProperties: false };
const sessionWorkEvidenceSchema = {
  type: "object",
  description: "Sparse provider HEAD-authored P3 evidence. Reuse exact originals; select only otherwise unrepresented judgment/reasons/alternatives, observations, pending work and uncertainty. Never a user form, transcript, approval or P2 direction.",
  properties: {
    summary: workEvidenceText,
    judgments: { type: "array", items: { type: "object", properties: { assessment: workEvidenceText, reason: workEvidenceText, alternatives: workEvidenceList }, required: ["assessment", "reason"], additionalProperties: false } },
    observedWork: workEvidenceList, pending: workEvidenceList, unknowns: workEvidenceList, suggestedFollowUp: workEvidenceList,
    workTopics: { ...workEvidenceList, description: "Optional HEAD-authored navigation labels from actual work, not Product Features, completion, approval or P2 direction. No taxonomy or user form required." },
    todos: { type: "array", minItems: 1, description: "Optional explicit P3 task revisions. HEAD supplies stable IDs, exact prior and actual progress at meaningful changes; no user JSON/save ritual. Status is not execution authority or inferred from activity.",
      items: { type: "object", properties: {
        todoId: { type: "string", pattern: "^todo-[a-z0-9][a-z0-9-]{0,79}$" }, task: workEvidenceText,
        status: { type: "string", enum: ["pending", "partial", "waiting", "completed", "cancelled"] },
        origin: { type: "string", enum: ["user-directed", "head-proposed"], description: "Recorded attribution only; not proof of user approval." },
        nextAction: workEvidenceText, reason: workEvidenceText, progress: workEvidenceText, priority: workEvidenceText,
        prior: exactWorkEvidenceSchema, resolves: { type: "array", items: exactWorkEvidenceSchema, description: "Explicitly reconcile these other exact branches of the same task; no time-based winner." },
        relatedEvidence: { type: "array", items: exactWorkEvidenceSchema },
      }, required: ["todoId", "task", "status", "origin"], additionalProperties: false } },
    occurrenceKey: { ...workEvidenceText, description: "Optional HEAD-owned distinction for a genuinely separate occurrence; identical input retry reuses its original." },
    workLink: { type: "object", description: "Optional exact same-Session saved context anchor and predecessor; not execution identity or authority.",
      properties: { root: exactWorkEvidenceSchema, predecessor: exactWorkEvidenceSchema }, required: ["root", "predecessor"], additionalProperties: false },
    executionObservation: { type: "object", description: "Saved historical observation, never current live state or completion/approval proof. An optional exact target qualifies that note only.",
      properties: { state: { type: "string", enum: ["running", "paused", "ended", "unknown"] }, target: exactWorkEvidenceSchema }, required: ["state"], additionalProperties: false },
    references: { type: "array", items: { type: "object", properties: {
      path: workEvidenceText, digest: { type: "string", pattern: "^[a-f0-9]{64}$" }, kind: { type: "string", enum: ["source", "artifact"] },
    }, required: ["path", "digest", "kind"], additionalProperties: false } },
  },
  additionalProperties: false,
};
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
const workerIntegrationFieldNames = { action: "action", integration_id: "integrationId", authorization_ids: "authorizationIds",
  max_bytes: "maxBytes", basis_digest: "basisDigest", reason: "reason", verification_id: "verificationId", outcome: "outcome",
  evidence: "evidence", verification: "verification", plan_delta: "planDelta", impact_radius: "impactRadius", unknowns: "unknowns", retry_known_no_write: "retryKnownNoWrite" };
function workerIntegrationInput(args) {
  if (typeof args.project_root !== "string" || !args.project_root.trim()) throw new Error("Worker integration requires project_root.");
  const request = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === "project_root") continue;
    if (!Object.hasOwn(workerIntegrationFieldNames, key)) throw new Error(`Unsupported worker integration fields: ${key}.`);
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
    root: args.project_root, authorizationId: args.authorization_id, storage: resolveProjectStorage(args.project_root),
  });
}
async function initializeProjectFromMcp(args, { projectSessionRoute, onValidatedSessionSelection, pluginLaunch, servingModuleUrl, installationCaller }) {
  const onboarding = onboardingInputFromMcp(args);
  const { createPluginInitializationContext, releasePluginInitializationContext } = await import("./lib/plugin-mcp-composition.mjs");
  // The shared write guard already ran. Optional installation discovery must
  // never read Project originals before a proven child write is rejected.
  const installationContext = createPluginInitializationContext({ launch: pluginLaunch, servingModuleUrl,
    caller: installationCaller, root: args.project_root });
  try {
    return await (await import("./lib/project-bootstrap.mjs")).initializeOrResumeProject({ root: args.project_root, pluginRoot,
      projectSessionRoute, runtimes: args.runtimes || null, profile: args.profile || "core",
      instructionIntegration: args.instruction_integration ?? null, onboarding, onValidatedSessionSelection, installationContext });
  } finally { releasePluginInitializationContext(installationContext); }
}
const observationFieldSchema = {
  type: "object",
  properties: {
    key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$" },
    type: { type: "string", enum: ["string", "stable-key", "timestamp", "sha256", "boolean", "integer", "nonnegative-integer", "bounded-number", "enum", "array"] },
    required: { type: "boolean" }, min: { type: "number" }, max: { type: "number" }, enum: { type: "array", maxItems: 64 },
    items_type: { type: "string", enum: ["string", "stable-key", "timestamp", "sha256", "boolean", "integer", "nonnegative-integer", "bounded-number"] },
    max_items: { type: "integer", minimum: 0, maximum: 1024 },
  },
  required: ["key", "type", "required"], additionalProperties: false,
};
const observationDescriptorSchema = {
  type: "object",
  properties: {
    type_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$" },
    type_version: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$" },
    forms: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", enum: ["event", "snapshot", "aggregate"] } },
    payload_schema: { type: "object", properties: { fields: { type: "array", maxItems: 128, items: observationFieldSchema }, additional_fields: { const: false } }, required: ["fields", "additional_fields"], additionalProperties: false },
  },
  required: ["type_key", "type_version", "forms", "payload_schema"], additionalProperties: false,
};
const observationCoverageSchema = {
  type: "object",
  properties: {
    state: { type: "string", enum: ["complete", "sampled", "partial", "unknown"] }, basis: { type: "string", minLength: 1 },
    query_digest: { anyOf: [{ type: "string", pattern: "^[a-f0-9]{64}$" }, { type: "null" }] }, examined_count: { type: "integer", minimum: 0 },
    source_reported_total: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] }, omitted_count: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
    cursor_start_digest: { anyOf: [{ type: "string", pattern: "^[a-f0-9]{64}$" }, { type: "null" }] }, cursor_end_digest: { anyOf: [{ type: "string", pattern: "^[a-f0-9]{64}$" }, { type: "null" }] },
  },
  required: ["state", "basis", "query_digest", "examined_count", "source_reported_total", "omitted_count", "cursor_start_digest", "cursor_end_digest"], additionalProperties: false,
};
const observationBindingSchema = {
  type: "object",
  properties: {
    adapter_key: { const: "head.structured-host-observation" }, adapter_version: { const: "0.1.0" }, source_scope_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
    credential_reference_names: { type: "array", maxItems: 16, uniqueItems: true, items: { type: "string", pattern: "^[A-Z][A-Z0-9_]{2,127}$" } },
  },
  required: ["adapter_key", "adapter_version", "source_scope_digest", "credential_reference_names"], additionalProperties: false,
};
const observationInputSchema = {
  type: "object",
  properties: {
    subject: { type: "object", properties: { type: { type: "string", minLength: 1 }, key: { type: "string", minLength: 1 } }, required: ["type", "key"], additionalProperties: false },
    form: { type: "string", enum: ["event", "snapshot", "aggregate"] },
    temporal_scope: { type: "object", properties: { observed_at: { type: "string", format: "date-time" }, start: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] }, end: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] } }, required: ["observed_at", "start", "end"], additionalProperties: false },
    source_event_key_digest: { type: "string", pattern: "^[a-f0-9]{64}$" }, source_evidence_digest: { type: "string", pattern: "^[a-f0-9]{64}$" }, coverage: observationCoverageSchema, payload: { type: "object" },
  },
  required: ["subject", "form", "temporal_scope", "source_event_key_digest", "source_evidence_digest", "coverage", "payload"], additionalProperties: false,
};
const nullableIdentity = (pattern) => ({ anyOf: [{ type: "string", pattern }, { type: "null" }] });
const onboardingSemanticProposalSchema = {
  type: "object",
  description: "Fresh provider-HEAD-authored P3 product candidates. Core verifies exact current source evidence and never treats this proposal as Product Canon.",
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    sourceSnapshotId: { type: "string", pattern: "^source-snapshot-[a-f0-9]{24}$" },
    candidates: {
      type: "array", minItems: 1, maxItems: 200,
      items: {
        type: "object",
        properties: {
          productKind: { type: "string", enum: ["FeatureGroup", "Capability", "Feature", "Requirement", "Constraint", "Decision"] },
          proposedEntity: { type: "object" },
          explanation: { type: "string", minLength: 1, maxLength: 2000 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: {
            type: "array", minItems: 1, maxItems: 8,
            items: {
              type: "object",
              properties: {
                path: { type: "string", minLength: 1 },
                line: { type: "integer", minimum: 1 },
                contentDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
                symbol: {
                  type: "object",
                  properties: {
                    name: { type: "string", minLength: 1 }, kind: { type: "string", minLength: 1 }, line: { type: "integer", minimum: 1 },
                  },
                  required: ["name", "kind", "line"], additionalProperties: false,
                },
              },
              required: ["path", "line"], additionalProperties: false,
            },
          },
        },
        required: ["productKind", "proposedEntity", "evidence", "explanation", "confidence"], additionalProperties: false,
      },
    },
  },
  required: ["schemaVersion", "sourceSnapshotId", "candidates"], additionalProperties: false,
};
const conformanceBaselineSchema = {
  type: "object",
  properties: {
    product_model_id: { type: "string", pattern: "^product-model-[a-f0-9]{24}$" },
    product_model_hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    world_model_id: nullableIdentity("^world-model-[a-f0-9]{24}$"),
    world_model_hash: nullableIdentity("^[a-f0-9]{64}$"),
    source_snapshot_id: nullableIdentity("^source-snapshot-[a-f0-9]{24}$"),
    graph_snapshot_id: nullableIdentity("^graph-snapshot-[a-f0-9]{24}$"),
  },
  required: ["product_model_id", "product_model_hash", "world_model_id", "world_model_hash", "source_snapshot_id", "graph_snapshot_id"], additionalProperties: false,
};
const conformanceEvidenceAnchorSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["source", "change", "observation", "graph"] },
    path: { type: "string", minLength: 1 }, file_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
    start_line: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] }, end_line: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] }, excerpt_digest: nullableIdentity("^[a-f0-9]{64}$"),
    revision_id: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] }, symbol_id: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
    change_set_id: { type: "string", pattern: "^change-set-[a-f0-9]{24}$" }, change_set_hash: { type: "string", pattern: "^[a-f0-9]{64}$" }, change_id: { type: "string", pattern: "^change-record-[a-f0-9]{24}$" },
    observation_id: { type: "string", pattern: "^(?:observation|derived-observation)-[a-f0-9]{24}$" }, observation_hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    graph_snapshot_id: { type: "string", pattern: "^graph-snapshot-[a-f0-9]{24}$" }, node_id: { type: "string", minLength: 1 },
  },
  required: ["kind"], additionalProperties: false,
};
const conformanceFindingInputSchema = {
  type: "object",
  properties: {
    canon_anchor: { type: "object", properties: { entity_kind: { type: "string", enum: ["FeatureGroup", "Capability", "Feature", "Requirement", "Constraint", "Decision", "Policy"] }, entity_key: { type: "string", minLength: 1 } }, required: ["entity_kind", "entity_key"], additionalProperties: false },
    evidence_anchors: { type: "array", minItems: 1, maxItems: 64, items: conformanceEvidenceAnchorSchema },
    claim: { type: "object", properties: { kind: { type: "string", enum: ["potential-conflict", "possible-conformance-gap"] }, summary: { type: "string", minLength: 1 }, rationale: { type: "string", minLength: 1 }, risk_hint: { type: "string", enum: ["unknown", "low", "medium", "high"] } }, required: ["kind", "summary", "rationale", "risk_hint"], additionalProperties: false },
  },
  required: ["canon_anchor", "evidence_anchors", "claim"], additionalProperties: false,
};
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
  {
    name: "head_core_contract",
    description: "Read the active Lode Agent Core roles, runtimes, and capability boundary.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "head_project_status",
    description: "Read bounded Core, optional Product/World, Context, verified checkpoint-recovery readiness, active-package, next-action, capability, and Session/Run readiness without modifying the project, consuming continuation, attaching a provider, or activating any capability.",
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
    description: "Read a compact conversation-oriented onboarding projection with the next material action, bounded evidence-linked candidates, and World/graph/document readiness. This tool never promotes candidates or mutates project state.",
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
    name: "head_project_initialize_or_resume",
    description: "Initialize or resume one Lode Project and its explicitly routed logical Session, and converge managed plugin projections. Core is the default. Core initialize/resume requires no Product brief or semantic proposal and leaves optional Product governance inactive or preserves its existing state. Only the explicit Product profile requires a fresh provider proposal or user-owned brief when Product candidates need to be created; Core verifies evidence but never infers product meaning. This writes only the selected project and never contacts GraphDB.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        profile: { type: "string", enum: ["core", "product"], default: "core" },
        instruction_integration: { type: "string", enum: ["link", "preserve"], description: "Optional existing setup choice. Link a bounded host-specific instruction block only when the user chose it; preserve makes no instruction edits. Never a prerequisite for ordinary work." },
        runtimes: {
          type: "array", minItems: 1, maxItems: 3, uniqueItems: true,
          items: { type: "string", enum: ["claude", "codex", "opencode"] },
        },
        mode: { type: "string", enum: ["existing", "new"] },
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
          description: "Fresh HEAD-authored P3 product candidates. Core verifies exact current source paths, digests, lines, optional symbols, bounds, and Product Model structure; it never treats the proposal as Product Canon or instruction authority.",
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
                        contentDigest: { type: "string", pattern: "^[a-f0-9]{64}$", description: "Optional optimistic freshness guard. Core always binds the verified current World digest even when omitted." },
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
  {
    name: "head_onboarding_semantic_refresh",
    description: "Create a fresh current P3 semantic onboarding proposal after a completed historical boundary. This creates only P3 candidates and continuity evidence; Product Canon changes only through a later explicit user ReviewDecision.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        semantic_proposal: onboardingSemanticProposalSchema,
        recovery_basis: { type: "object", properties: { pointerHash: { type: "string", pattern: "^[a-f0-9]{64}$" }, rawHash: { type: ["string", "null"], pattern: "^[a-f0-9]{64}$" } }, required: ["pointerHash", "rawHash"], additionalProperties: false },
      },
      required: ["project_root", "semantic_proposal"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_onboarding_candidate_restore",
    description: "Restore verified original candidate content after preserving damaged bytes. Changes no Canon, decision or P2 direction; HEAD supplies exact observed raw hash, not a new user approval.",
    inputSchema: {
      type: "object", properties: {
        project_root: { type: "string", minLength: 1 },
        candidate_set_id: { type: "string", pattern: "^onboarding-candidates-[a-f0-9]{24}$" },
        source_content: { type: "string", minLength: 1, maxLength: 8388608 },
        expected_raw_hash: { type: ["string", "null"], pattern: "^[a-f0-9]{64}$" },
      }, required: ["project_root", "candidate_set_id", "source_content", "expected_raw_hash"], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_onboarding_review",
    description: "Apply one explicit user-authored ReviewDecision to the exact current onboarding candidate set. Accept dispositions may change Product Canon; revise and reject preserve candidate or canon boundaries enforced by Core.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        candidate_set_id: { type: "string", pattern: "^onboarding-candidates-[a-f0-9]{24}$" },
        disposition: { type: "string", enum: ["accept-all", "accept-selection", "revise", "reject"] },
        accepted_candidate_ids: { type: "array", uniqueItems: true, items: { type: "string", pattern: "^onboarding-candidate-[a-f0-9]{24}$" } },
        removed_candidate_ids: { type: "array", uniqueItems: true, items: { type: "string", pattern: "^onboarding-candidate-[a-f0-9]{24}$" } },
        user_edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              candidate_id: { type: "string", pattern: "^onboarding-candidate-[a-f0-9]{24}$" },
              entity: { type: "object" },
            },
            required: ["candidate_id", "entity"],
            additionalProperties: false,
          },
        },
        added_entities: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["FeatureGroup", "Capability", "Feature", "Requirement", "Constraint", "Decision"] },
              entity: { type: "object" },
            },
            required: ["kind", "entity"],
            additionalProperties: false,
          },
        },
        rationale: { type: "string", minLength: 1 },
      },
      required: ["project_root", "candidate_set_id", "disposition", "rationale"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "head_product_policy_propose",
    description: "Record one immutable P3 Policy create, revise, or retire candidate against the exact current Product Canon. The provider HEAD or user supplies meaning, explicit Feature or FeatureGroup applications, and optional exact Requirement, Constraint, or Decision references; Core never infers inheritance or promotes the candidate.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        operation: { type: "string", enum: ["create", "revise", "retire"] },
        key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
        name: { type: "string", minLength: 1, maxLength: 256 },
        description: { type: "string", maxLength: 4000 },
        statement: { type: "string", minLength: 1, maxLength: 8000 },
        applies_to: {
          type: "array", maxItems: 256, uniqueItems: true,
          items: { type: "object", properties: { kind: { type: "string", enum: ["Feature", "FeatureGroup"] }, key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" } }, required: ["kind", "key"], additionalProperties: false },
        },
        governed_by: {
          type: "array", maxItems: 256, uniqueItems: true,
          items: { type: "object", properties: { kind: { type: "string", enum: ["Requirement", "Constraint", "Decision"] }, key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" } }, required: ["kind", "key"], additionalProperties: false },
        },
        evidence_anchors: {
          type: "array", maxItems: 32,
          items: { type: "object", properties: { kind: { type: "string", enum: ["user-request", "source", "observation", "decision", "other"] }, reference: { type: "string", minLength: 1, maxLength: 1024 }, digest: { anyOf: [{ type: "string", pattern: "^[a-f0-9]{64}$" }, { type: "null" }] }, summary: { type: "string", maxLength: 1000 } }, required: ["kind", "reference"], additionalProperties: false },
        },
        explanation: { type: "string", maxLength: 4000 },
      },
      required: ["project_root", "operation", "key"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_product_policy_review",
    description: "Record one explicit user ReviewDecision for an exact Policy candidate. Accept changes Product Canon only when the candidate base is still current and no Run authority is active; reject is nonblocking. Exact retries repair missing derived projections without a second decision.",
    inputSchema: { type: "object", properties: {
      project_root: { type: "string", minLength: 1 }, candidate_id: { type: "string", pattern: "^policy-candidate-[a-f0-9]{24}$" }, disposition: { type: "string", enum: ["accept", "reject"] }, rationale: { type: "string", minLength: 1, maxLength: 4000 },
    }, required: ["project_root", "candidate_id", "disposition", "rationale"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_product_policy_status",
    description: "Read the exact Policy candidate, its optional ReviewDecision, and whether Canon is still at the candidate base or accepted result. This creates no state and never blocks ordinary work.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 }, candidate_id: { type: "string", pattern: "^policy-candidate-[a-f0-9]{24}$" } }, required: ["project_root", "candidate_id"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_product_policy_candidate",
    description: "Read and digest-verify one immutable P3 Product Policy candidate.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 }, candidate_id: { type: "string", pattern: "^policy-candidate-[a-f0-9]{24}$" } }, required: ["project_root", "candidate_id"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_product_policy_review_decision",
    description: "Read and digest-verify one exact Product Policy ReviewDecision and its candidate binding.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 }, review_decision_id: { type: "string", pattern: "^review-decision-[a-f0-9]{24}$" } }, required: ["project_root", "review_decision_id"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_metric_define",
    description: "Register a provider-neutral P3 metric data shape. This does not change Product Canon, execution authority, or recovery direction.",
    inputSchema: { type: "object", properties: {
      project_root: { type: "string", minLength: 1 }, metric_key: { type: "string", minLength: 1, maxLength: 128 }, unit: { type: "string", minLength: 1, maxLength: 64 }, direction: { type: "string", enum: ["increase", "decrease", "maintain"] }, type_version: { type: "string", minLength: 1, maxLength: 64, default: "1" },
    }, required: ["project_root", "metric_key", "unit", "direction"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_metric_observe",
    description: "Record one exact P3 metric observation through the common Observation contract. Partial coverage is disclosed and remains usable evidence; it is never upgraded to complete.",
    inputSchema: { type: "object", properties: {
      project_root: { type: "string", minLength: 1 }, metric_key: { type: "string", minLength: 1, maxLength: 128 }, type_version: { type: "string", minLength: 1, maxLength: 64 },
      subject_type: { type: "string", minLength: 1, maxLength: 192 }, subject_key: { type: "string", minLength: 1, maxLength: 192 }, value: { type: "number" }, sample_size: { type: "integer", minimum: 0 },
      form: { type: "string", enum: ["snapshot", "aggregate"], default: "snapshot" }, observed_at: { type: "string", minLength: 1 }, start: { type: ["string", "null"] }, end: { type: ["string", "null"] },
      coverage: { type: "object", properties: {
        state: { type: "string", enum: ["complete", "sampled", "partial", "unknown"] }, basis: { type: "string", minLength: 1, maxLength: 128 }, query_digest: { type: ["string", "null"], pattern: "^[a-f0-9]{64}$" }, examined_count: { type: "integer", minimum: 0 }, source_reported_total: { type: ["integer", "null"], minimum: 0 }, omitted_count: { type: ["integer", "null"], minimum: 0 }, cursor_start_digest: { type: ["string", "null"] }, cursor_end_digest: { type: ["string", "null"] },
      }, additionalProperties: false },
      adapter_key: { type: "string", minLength: 1, maxLength: 192 }, adapter_version: { type: "string", minLength: 1, maxLength: 64 }, source_scope_digest: { type: "string", pattern: "^[a-f0-9]{64}$" }, source_event_key_digest: { type: "string", pattern: "^[a-f0-9]{64}$" }, source_evidence_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
    }, required: ["project_root", "metric_key", "subject_type", "subject_key", "value", "source_scope_digest", "source_event_key_digest", "source_evidence_digest"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_metric_compare",
    description: "Create an exact P3 derived comparison between two compatible metric observations. The result preserves coverage disclosures and never claims causality.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 }, baseline_observation_id: { type: "string", minLength: 1 }, current_observation_id: { type: "string", minLength: 1 } }, required: ["project_root", "baseline_observation_id", "current_observation_id"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_metric_assess",
    description: "Record a bounded P3 ProductHypothesis interpreting one exact metric comparison. Supports/contradicts/inconclusive are hypotheses, not causal findings or Canon changes.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 }, comparison_observation_id: { type: "string", minLength: 1 }, assessment: { type: "string", enum: ["supports", "contradicts", "inconclusive"] }, statement: { type: "string", minLength: 1, maxLength: 4000 }, rationale: { type: "string", maxLength: 4000 } }, required: ["project_root", "comparison_observation_id", "assessment", "statement"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_metric_status",
    description: "Read the nonblocking metric definitions, observation count, and comparison count. This creates no authority or state.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 } }, required: ["project_root"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_metric_trace",
    description: "Read one bounded P4 measurement lineage from an exact graph anchor or metric key through the verified prepared-traversal path. This writes no Canon, decision, or recovery state.",
    inputSchema: { type: "object", properties: {
      project_root: { type: "string", minLength: 1 }, anchor_id: { type: "string", minLength: 1 }, metric_key: { type: "string", minLength: 1, maxLength: 128 }, type_version: { type: "string", minLength: 1, maxLength: 64 }, depth: { type: "integer", minimum: 0, maximum: 3, default: 3 }, max_nodes: { type: "integer", minimum: 1, maximum: 500, default: 128 }, max_edges: { type: "integer", minimum: 0, maximum: 1000, default: 256 },
    }, required: ["project_root"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_delivery_observe",
    description: "Record one provider-neutral P3 delivery event for an exact environment and target. This adds no deployment action or approval gate; failures do not overwrite prior success, and an optional World revision binding is mechanically verified.",
    inputSchema: { type: "object", properties: {
      project_root: { type: "string", minLength: 1 },
      environment_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
      target_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
      artifact_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$" },
      revision_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$" },
      revision_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
      outcome: { type: "string", enum: ["applied", "failed", "cancelled", "rolled-back"] },
      sequence: { type: "integer", minimum: 0 },
      predecessor_observation_id: { anyOf: [{ type: "string", pattern: "^observation-[a-f0-9]{24}$" }, { type: "null" }] },
      rollback_target_observation_id: { anyOf: [{ type: "string", pattern: "^observation-[a-f0-9]{24}$" }, { type: "null" }] },
      observed_at: { type: "string", format: "date-time" },
      source_scope_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
      source_event_key_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
      source_evidence_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
      adapter_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$" },
      adapter_version: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$" },
      revision_reference: { type: "object", properties: {
        world_model_id: { type: "string", pattern: "^world-model-[a-f0-9]{24}$" },
        revision_id: { type: "string", pattern: "^file-revision-[a-f0-9]{24}$" },
        source_path: { type: "string", minLength: 1, maxLength: 4096 },
        digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
      }, required: ["world_model_id", "revision_id", "source_path", "digest"], additionalProperties: false },
    }, required: ["project_root", "environment_key", "target_key", "artifact_key", "revision_key", "revision_digest", "outcome", "sequence", "source_scope_digest", "source_event_key_digest", "source_evidence_digest"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "head_delivery_status",
    description: "Read a bounded non-persisted P4 current-and-history delivery projection. Explicit sequence and predecessor evidence determine current state; receipt time, failed attempts, and unobserved targets never imply success.",
    inputSchema: { type: "object", properties: {
      project_root: { type: "string", minLength: 1 },
      environment_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
      target_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
      history_limit: { type: "integer", minimum: 1, maximum: 4096, default: 100 },
    }, required: ["project_root"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_markdown_projection_build",
    description: "Build or verify the deterministic local Markdown projection from the current verified GraphSnapshot. The generated view is rebuildable, non-authoritative, and never changes Product Canon.",
    inputSchema: {
      type: "object",
      properties: { project_root: { type: "string", minLength: 1 } },
      required: ["project_root"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_runtime_adapters",
    description: "Inspect provider-neutral runtime contracts, privacy-bounded executable discovery, fixed non-session version and protocol/capability evidence, and Lode project/session capability binding without creating or controlling a provider session.",
    inputSchema: {
      type: "object",
      properties: { project_root: { type: "string", minLength: 1 } },
      required: ["project_root"],
      additionalProperties: false,
    },
  },
  {
    name: "head_runtime_invocation_authorization",
    description: "Read and digest-verify one Session- or Run-scoped ExecutionAuthorization. A read-only historical view checks retained original input references and canonical bytes/digest where available; preparation does not prove delivery or model use. No provider invocation or current execution permission.",
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
  {
    name: "head_runtime_invocation_lease_status",
    description: "Read the durable at-most-once consumption and exact-owner release status for one runtime invocation authorization without claiming, replaying, or controlling a provider.",
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
  {
    name: "head_runtime_invocation_result",
    description: "Read and digest-verify one provider-neutral recorded invocation receipt, structured result draft, optional Run application, and transcript-free event envelopes without invoking or controlling a provider.",
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
  {
    name: "head_onboarding_status",
    description: "Read and digest-verify the project-scoped onboarding state, current candidate batch, storage selection, Product Canon identity, and local World Model status without promoting candidates or mutating project state.",
    inputSchema: {
      type: "object",
      properties: { project_root: { type: "string", minLength: 1 } },
      required: ["project_root"],
      additionalProperties: false,
    },
  },
  {
    name: "head_feature_mapping_propose",
    description: "Normalize one fresh HEAD semantic proposal for exact Product-to-code or Product-to-test mapping candidates. Core verifies current graph endpoints and records only P3 candidates; it does not infer mappings from lexical overlap or create reviewed relationships.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        expected_candidate_set_id: { type: "string", pattern: "^feature-mapping-candidates-[a-f0-9]{24}$", description: "Explicitly replace this exact pending unreviewed batch with fresh evidence; never replaces a durable user decision." },
        semantic_proposal: {
          type: "object",
          properties: {
            schema_version: { const: 1 },
            source_snapshot_id: { type: "string", pattern: "^source-snapshot-[a-f0-9]{24}$" },
            product_model_id: { type: "string", pattern: "^product-model-[a-f0-9]{24}$" },
            candidates: {
              type: "array", minItems: 1, maxItems: 500,
              items: {
                type: "object",
                properties: {
                  relationship_type: { type: "string", enum: ["IMPLEMENTS", "VERIFIED_BY"] },
                  source_node_id: { type: "string", minLength: 1 },
                  product_node_id: { type: "string", minLength: 1 },
                  explanation: { type: "string", minLength: 1, maxLength: 2000 },
                  confidence: { type: "number", minimum: 0, maximum: 1 },
                },
                required: ["relationship_type", "source_node_id", "product_node_id", "explanation", "confidence"],
                additionalProperties: false,
              },
            },
          },
          required: ["schema_version", "source_snapshot_id", "product_model_id", "candidates"],
          additionalProperties: false,
        },
      },
      required: ["project_root", "semantic_proposal"],
      additionalProperties: false,
    },
  },
  {
    name: "head_feature_mapping_status",
    description: "Read and digest-verify the current Feature mapping candidate batch or explicit reviewed relationship decision without creating or promoting mappings.",
    inputSchema: {
      type: "object",
      properties: { project_root: { type: "string", minLength: 1 } },
      required: ["project_root"],
      additionalProperties: false,
    },
  },
  {
    name: "head_feature_mapping_review",
    description: "Record one explicit user-authored ReviewDecision for the exact current Feature mapping candidate set. This requires explicit confirmation; only accepted candidates create separate reviewed relationships, and Product Canon remains unchanged.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        candidate_set_id: { type: "string", pattern: "^feature-mapping-candidates-[a-f0-9]{24}$" },
        disposition: { type: "string", enum: ["accept-all", "accept-selection", "reject"] },
        accepted_candidate_ids: {
          type: "array",
          uniqueItems: true,
          items: { type: "string", pattern: "^feature-mapping-candidate-[a-f0-9]{24}$" },
          default: [],
        },
        rationale: { type: "string", minLength: 1 },
        confirm_user_review: { type: "boolean" },
      },
      required: ["project_root", "candidate_set_id", "disposition", "rationale", "confirm_user_review"],
      additionalProperties: false,
    },
  },
  {
    name: "head_change_set_status",
    description: "Read and digest-verify the current provider-neutral ChangeSet, Feature impact state, and optional VCS evidence without mutating project state.",
    inputSchema: {
      type: "object",
      properties: { project_root: { type: "string", minLength: 1 } },
      required: ["project_root"],
      additionalProperties: false,
    },
  },
  {
    name: "head_vcs_evidence",
    description: "Read and digest-verify one optional VCS evidence attachment and its immutable Git commit observations without treating commits as ChangeSet or project authority.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        vcs_evidence_id: { type: "string", pattern: "^vcs-evidence-[a-f0-9]{24}$" },
      },
      required: ["project_root", "vcs_evidence_id"],
      additionalProperties: false,
    },
  },
  {
    name: "head_conformance_prepare",
    description: "Prepare bounded current Product Canon and optional World identities for provider HEAD semantic drift analysis. The user supplies no JSON or graph IDs; Core chooses no meaning, writes nothing, and never blocks ordinary work.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 }, limit: { type: "integer", minimum: 1, maximum: 64, default: 32 }, projection_id: { type: "string" }, cursor: { type: "string" } }, required: ["project_root"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_conformance_propose",
    description: "Record one or more provider-HEAD semantic Conformance candidates only after Core verifies exact current Canon and evidence anchors. Candidates are P3 evidence, never violations, decisions, execution authority, recovery direction, or ordinary-work gates.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 }, baseline: conformanceBaselineSchema, findings: { type: "array", minItems: 1, maxItems: 64, items: conformanceFindingInputSchema } }, required: ["project_root", "baseline", "findings"], additionalProperties: false },
  },
  {
    name: "head_conformance_queue",
    description: "Read a bounded, paginated P4 Conformance queue. Missing Graph or optional sources, partial coverage, risk hints, and open findings never block ordinary work.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 }, canon_anchor: conformanceFindingInputSchema.properties.canon_anchor, status: { type: "string", enum: ["all", "open", "acknowledged", "deferred", "action-requested", "needs-recheck", "resolution-proposed", "closed-dismissed", "closed-resolved"], default: "all" }, risk_hint: { type: "string", enum: ["", "unknown", "low", "medium", "high"], default: "" }, limit: { type: "integer", minimum: 1, maximum: 64, default: 25 }, projection_id: { type: "string" }, cursor: { type: "string", pattern: "^conformance-finding-[a-f0-9]{24}$" } }, required: ["project_root"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_conformance_read",
    description: "Read and digest-verify one exact Conformance Finding, its non-authoritative resolutions, and exact-finding dispositions.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 }, finding_id: { type: "string", pattern: "^conformance-finding-[a-f0-9]{24}$" } }, required: ["project_root", "finding_id"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_conformance_disposition",
    description: "Record a disposition for one exact Finding. HEAD may acknowledge/defer with actor=head without user confirmation, but cannot supersede user dispositions or close findings. User dispositions require explicit confirmation. Neither path authorizes execution, mutates Canon, or writes recovery direction.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 }, finding_id: { type: "string", pattern: "^conformance-finding-[a-f0-9]{24}$" }, disposition: { type: "string", enum: ["acknowledge", "defer", "dismiss", "request-code-fix", "request-canon-revision", "accept-resolution"] }, rationale: { type: "string", minLength: 1 }, defer_until: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] }, resolution_id: { anyOf: [{ type: "string", pattern: "^conformance-resolution-[a-f0-9]{24}$" }, { type: "null" }] }, actor: { type: "string", enum: ["user", "head"], default: "user" }, confirm_user_disposition: { type: "boolean", default: false } }, required: ["project_root", "finding_id", "disposition", "rationale"], additionalProperties: false },
  },
  {
    name: "head_conformance_resolution_propose",
    description: "Record a provider-HEAD resolution candidate against a fresh exact baseline. It does not close the Finding; only a later explicit exact-finding disposition can do so.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 }, finding_id: { type: "string", pattern: "^conformance-finding-[a-f0-9]{24}$" }, baseline: conformanceBaselineSchema, evidence_anchors: { type: "array", minItems: 1, maxItems: 64, items: conformanceEvidenceAnchorSchema }, assessment: { type: "string", enum: ["appears-resolved", "still-present", "uncertain"] }, rationale: { type: "string", minLength: 1 } }, required: ["project_root", "finding_id", "baseline", "evidence_anchors", "assessment", "rationale"], additionalProperties: false },
  },
  {
    name: "head_conformance_trigger_status",
    description: "Read one optional Host-local Conformance trigger binding. It is P5 operational state and does not imply Product meaning, source completeness, or authority.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 }, source_id: { type: "string", pattern: "^conformance-trigger-source-[a-f0-9]{24}$" } }, required: ["project_root", "source_id"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_conformance_trigger_prepare",
    description: "Prepare the next bounded Host-local trigger batch and current read-only Conformance baseline. It invokes no provider, creates no Finding, and does not auto-replay an uncertain assessment.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 }, source_id: { type: "string", pattern: "^conformance-trigger-source-[a-f0-9]{24}$" }, limit: { type: "integer", minimum: 1, maximum: 64, default: 64 } }, required: ["project_root", "source_id"], additionalProperties: false },
  },
  {
    name: "head_source_context",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: "Collect current task-scoped source evidence and compile it into Context without Product onboarding or full indexing. HEAD chooses exact needs after inspecting the user's task; never ask users to author JSON or IDs. Python outgoing-calls uses isolated parse-only stdlib AST, preserves unresolved calls, and claims no runtime truth or completeness. Optional retention stores P3 evidence only; failures affect dependent judgments, not independent work.",
    inputSchema: { type: "object", properties: {
      project_root: { type: "string", minLength: 1 }, task: { type: "string", minLength: 1 },
      needs: { type: "array", maxItems: 32, items: { type: "object", properties: {
        kind: { type: "string", enum: ["source", "outgoing-calls", "declarations", "selected-source"] }, path: { type: "string", minLength: 1 },
        symbol: { type: "string", maxLength: 512 }, required: { type: "boolean", default: true },
        selection: { type: "object", description: "Optional exact occurrence from a declarations response; selected-source only. No outline prerequisite for a known unique symbol.", properties: {
          path: { type: "string", minLength: 1, maxLength: 512 }, fileDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
          qualifiedName: { type: "string", minLength: 1, maxLength: 512 }, kind: { type: "string", enum: ["class", "function", "async-function", "method", "async-method"] },
          occurrence: { type: "integer", minimum: 1 }, range: { type: "object", properties: Object.fromEntries(["start", "end"].map((key) => [key, {
            type: "object", properties: { line: { type: "integer", minimum: 0 }, character: { type: "integer", minimum: 0 } }, required: ["line", "character"], additionalProperties: false,
          }])), required: ["start", "end"], additionalProperties: false },
        }, required: ["path", "fileDigest", "qualifiedName", "kind", "occurrence", "range"], additionalProperties: false },
      }, required: ["kind", "path"], additionalProperties: false } },
      retain: { type: "boolean", default: false, description: "HEAD selects retention for audit/reuse/handoff; no additional user approval. Ephemeral is the default." },
      timeout_ms: { type: "integer", minimum: 1, maximum: 120000, default: 15000 },
      budget: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    }, required: ["project_root", "task"], additionalProperties: false },
  },
  {
    name: "head_source_observation_read",
    description: "Audit exact retained original source/response after integrity verification, even after source edits. Reports current, stale or unavailable sourceState separately; historical data is not eligible as current Context or P2 recovery authority.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 }, bundle_key: { type: "string", pattern: "^[a-f0-9]{64}$" }, failure_key: { type: "string", pattern: "^[a-f0-9]{64}$", description: "Alternatively, read the exact retained failure. Supply exactly one key; HEAD obtains it from the collection result." } }, required: ["project_root"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_context_prepare",
    description: "Return source-linked selected context from the exact user task in one read-only call. Reuse this preparation directly; HEAD inspects originals or requests a guided preview only when useful. No World activation, JSON form, compulsory inclusion proof, token tier or new approval. HEAD judges semantic sufficiency; Core grants no authority and writes no recovery state.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        task: { type: "string", minLength: 1 },
        budget: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER, default: DEFAULT_CONTEXT_BUDGET },
      },
      required: ["project_root", "task"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_context_preview",
    description: "Prepare source-linked selected context from the exact user task, with optional HEAD evidence guidance. Reports omissions and uncertainty without an inclusion-proof gate or fixed token tiers. HEAD expands useful sources and assesses sufficiency. Writes nothing and grants no authority.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        task: { type: "string", minLength: 1 },
        budget: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER, default: DEFAULT_CONTEXT_BUDGET, description: "Approximate selected-context limit. HEAD may choose any positive safe integer or inspect more original evidence; this is not a provider-fit proof." },
        evidence_needs: {
          type: "array",
          maxItems: 32,
          description: "Task-local evidence requirements chosen by HEAD. The Compiler checks actual inclusion only; it does not infer requirements or judge semantic sufficiency.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" },
              kind: { type: "string", enum: ["claim", "decision", "git-decision", "observation", "product-context", "repository-file", "repository-source", "repository-test", "runtime-state", "semantic-relation", "temporal-relation", "unknown"] },
              paths: { type: "array", maxItems: 32, description: "Exact normalized project-relative repository paths selected by HEAD after semantic task analysis. Core verifies actual current inclusion; paths never grant authority.", items: { type: "string", minLength: 1 } },
              entityKeys: { type: "array", maxItems: 32, description: "Exact Product Canon entity keys selected by HEAD for product-context evidence. Core verifies actual current inclusion; keys never grant authority.", items: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" } },
              observationIds: { type: "array", minItems: 1, maxItems: 32, uniqueItems: true, description: "Exact immutable Observation identities selected by HEAD. Core verifies current existence and actual inclusion without lexical matching or semantic promotion.", items: { type: "string", pattern: "^(observation|derived-observation)-[a-f0-9]{24}$" } },
              facets: { type: "array", maxItems: 16, items: { type: "string", minLength: 1 } },
              relationTypes: { type: "array", maxItems: 16, items: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$" } },
              graphAnchor: {
                type: "object",
                description: "Exact task-local graph anchors proposed by HEAD after semantic analysis. Core only verifies current Project/World/Graph binding and bounded inclusion; the proposal has no Canon, instruction, review, or recovery authority.",
                properties: {
                  projectId: { type: "string", minLength: 1, maxLength: 256 },
                  worldModelId: { type: "string", pattern: "^world-model-[a-f0-9]{24}$" },
                  graphSnapshotId: { type: "string", pattern: "^graph-snapshot-[a-f0-9]{24}$" },
                  nodeIds: { type: "array", minItems: 1, maxItems: 32, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 256 } },
                  depth: { type: "integer", minimum: 1, maximum: 3 },
                  maxNodes: { type: "integer", minimum: 1, maximum: 500 },
                  maxEdges: { type: "integer", minimum: 1, maximum: 1000 }
                },
                required: ["projectId", "worldModelId", "graphSnapshotId", "nodeIds", "depth", "maxNodes", "maxEdges"],
                additionalProperties: false
              },
              minimumItems: { type: "integer", minimum: 1, maximum: 20, default: 1 },
              rationale: { type: "string", maxLength: 500 }
            },
            required: ["id", "kind"],
            additionalProperties: false
          }
        }
      },
      required: ["project_root", "task"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_context_capsule",
    description: "Read and digest-verify one persisted Context Capsule.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        capsule_id: { type: "string", pattern: "^capsule-[a-f0-9]{24}$" }
      },
      required: ["project_root", "capsule_id"],
      additionalProperties: false
    }
  },
  {
    name: "head_lineage_artifact",
    description: "Read and digest-verify one persisted Whole-plan Execution Lineage artifact.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        artifact_id: { type: "string", pattern: "^(whole-plan|execution-contract|result-packet|review-decision)-[a-f0-9]{24}$" }
      },
      required: ["project_root", "artifact_id"],
      additionalProperties: false
    }
  },
  {
    name: "head_pending_review",
    description: "Build the deterministic minimum-sufficient Fresh HEAD view for the Result Packet awaiting review.",
    inputSchema: {
      type: "object",
      properties: { project_root: { type: "string", minLength: 1 } },
      required: ["project_root"],
      additionalProperties: false
    }
  },
  {
    name: "head_checkpoint_basis",
    description: "Read one non-persisted exact Project/Session/Run/plan/contract/Capsule/review and transition basis before HEAD derives recovery direction. This is P4 comparison evidence and writes no P2 direction.",
    inputSchema: {
      type: "object",
      properties: { project_root: { type: "string", minLength: 1 } },
      required: ["project_root"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_checkpoint_diagnose",
    description: "Read a bounded P4 checkpoint diagnosis: current pointer, artifact-restore verification, mechanical sync availability, and the next HEAD action. It performs no write, repair, approval, or semantic-freshness judgment.",
    inputSchema: {
      type: "object",
      properties: { project_root: { type: "string", minLength: 1 } },
      required: ["project_root"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_checkpoint_sync",
    description: "Publish or reuse one canonical P2 recovery checkpoint only when the exact read-only basis is current. Identical retries converge; stale direction conflicts; incomplete Run or open compaction transitions defer only this sync.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        expected_recovery_basis_id: { type: "string", pattern: "^recovery-basis-[a-f0-9]{24}$" },
        purpose: { type: "string", minLength: 1 },
        approved_decisions: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
        current_position: { type: "string", minLength: 1 },
        next_expected_result: { type: "string", minLength: 1 },
        open_review_ids: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
        work_evidence: sessionWorkEvidenceSchema,
      },
      required: ["project_root", "expected_recovery_basis_id", "purpose", "approved_decisions", "current_position", "next_expected_result"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_session_work_record",
    description: "Optionally preserve meaningful Run-free work as one create-only P3 Evidence original in the exact selected Session, without a Run, checkpoint, Capsule, user form or save approval. HEAD supplies sparse otherwise-unrepresented context; exact retry does not re-execute work. When checkpoint sync is already useful, use its optional work_evidence instead.",
    inputSchema: { type: "object", properties: { project_root: workEvidenceText, evidence: sessionWorkEvidenceSchema },
      required: ["project_root", "evidence"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_session_work_read",
    description: "Read the selected Session's recent work and explicitly linked earlier reasons with verified originals and bounded output. Entry already provides work context; expand only when useful. Exact IDs avoid inventory enumeration; an explicit cursor reads an ID page. Some history may remain outside the returned bodies. No write, repair, replay or recovery direction.",
    inputSchema: { type: "object", properties: {
      project_root: workEvidenceText,
      evidence_ids: { type: "array", maxItems: 512, items: { type: "string", pattern: "^work-evidence-[a-f0-9]{24}$" } },
      after_evidence_id: { type: "string", pattern: "^work-evidence-[a-f0-9]{24}$", description: "Explicit lexical ID-page anchor, not a time-order cursor. Default global selection returns no continuation cursor." },
      scan_evidence: { type: "boolean", description: "Start the first bounded lexical original page without a seed ID; follow the returned next arguments when useful. Default recent-work selection is unchanged. No write or completeness claim." },
      max_records: { type: "integer", minimum: 1, maximum: 512 }, max_characters: { type: "integer", minimum: 2, maximum: 524288,
        description: "Actual emitted P3 JSON UTF16 budget: records, plus separate recordExcerpts and their coverage/selectors/expansion when present. Separate bounded outer/Todo metadata excluded; omissions/expansion disclosed." },
      todo_id: { type: "string", pattern: "^todo-[a-z0-9][a-z0-9-]{0,79}$", description: "Inspect this recorded task, including terminal or conflicting revisions, independently of recent work." },
      after_todo_id: { type: "string", pattern: "^todo-[a-z0-9][a-z0-9-]{0,79}$", description: "Continue the known unresolved Todo list by stable item ID." },
      scan_todos: { type: "boolean", description: "Read a bounded original ID page when the replaceable Todo index is missing or incomplete. Continue with after_evidence_id; no repair or World refresh." },
    }, required: ["project_root"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_session_restore",
    description: "Reconstruct the exact current Project/Session/Run consumer input from the canonical SessionRunCheckpoint and verified artifacts. This derived view never resumes or depends on a provider session.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        checkpoint_id: { type: "string", pattern: "^checkpoint-[a-f0-9]{24}$" },
      },
      required: ["project_root"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_session_continue",
    description: "Restore the canonical P2 SessionRunCheckpoint first, then optionally verify the exact current live HEAD attachment through the host-injected P5 adapter. Failure falls back to a disclosed fresh logical HEAD and never imports provider session identity.",
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
    description: "HEAD combines exact completed worker patches, explicitly applies or reconciles bounded file effects, settles a quiescent incomplete attempt, or prepares/publishes one verified whole-Run result. HEAD supplies the structured fields from its task and evidence; do not ask the user to author JSON. prepare-result needs the current basis_digest and HEAD verification; publish-result needs that exact verification_id. Published results still require Fresh HEAD review; this never creates ReviewDecision, Product Canon or checkpoint direction. No provider is launched and no Host executable or transport is accepted.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        action: { type: "string", enum: Object.keys(workerIntegrationActionFields) },
        authorization_ids: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", pattern: "^execution-authorization-[a-f0-9]{24}$" } },
        max_bytes: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Bound combined raw preimage/postimage bytes for prepare; not a semantic sufficiency budget." },
        integration_id: workerIntegrationIdSchema,
        basis_digest: { type: "string", pattern: "^[a-f0-9]{64}$", description: "Exact current status basis after HEAD reassessment, never a user confirmation token." },
        retry_known_no_write: { type: "boolean", default: false, description: "Only for apply: HEAD may explicitly retry an exact, quiescent, inspected known-no-write attempt. Unknown effects are never retried." },
        reason: { type: "string", minLength: 1, maxLength: 4000 },
        verification_id: workerIntegrationVerificationIdSchema,
        outcome: { type: "string", minLength: 1 },
        evidence: { type: "array", minItems: 1, items: { type: "object" } },
        verification: { type: "array", minItems: 1, items: { type: "object" } },
        plan_delta: { type: "string" },
        impact_radius: { type: "array", items: { type: "string", minLength: 1 } },
        unknowns: { type: "array", items: { type: "string", minLength: 1 } },
      },
      required: ["project_root", "action"], additionalProperties: false,
      oneOf: Object.entries(workerIntegrationActionFields).map(([action, required]) => ({
        properties: { ...Object.fromEntries(["project_root", ...required, ...(workerIntegrationOptionalFields[action] || [])].map(key => [key, {}])), action: { const: action } },
        required, additionalProperties: false,
      })),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_worker_integration_status",
    description: "Read verified integration history, current dependency/file-effect basis, outstanding overlapping effects and whole-result state in one non-persisted view. Repeated reads create no artifacts, invoke no provider and repair no state. Raw patch bytes are omitted, while exact member and evidence identities remain available. Source or Session drift is not rewritten as success or recovery direction.",
    inputSchema: { type: "object", properties: {
      project_root: { type: "string", minLength: 1 }, integration_id: workerIntegrationIdSchema,
      verification_id: workerIntegrationVerificationIdSchema,
    }, required: ["project_root", "integration_id"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_bounded_worker_prepare",
    description: "Optional managed path only, not a prerequisite for ordinary Host delegation. Prepare a bounded read-only patch-proposal worker through the built-in local Host without calling a model. HEAD supplies task, exact model, selected context and source/proposal paths from the conversation; never ask the user to write a module, JSON or IDs. Reuses current Session or active Run authority and an identical preparation. Does not apply patches, create a Run, approve results, inspect an account or start a worker. Host-global instruction selection is explicit input scope, not an enforcement assertion; selected-only is the default.",
    inputSchema: { type: "object", properties: {
      project_root: { type: "string", minLength: 1 }, task: { type: "string", minLength: 1 }, model: { type: "string", minLength: 1 },
      task_key: { type: "string", pattern: "^[a-z][a-z0-9-]{0,95}$" }, role: { type: "string", enum: ["developer", "coder", "reviewer"] },
      outcome: { type: "string", minLength: 1 }, selected_context: { type: "string" },
      source_paths: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
      proposal_paths: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
      runtime: { type: "string", enum: ["codex", "claude", "opencode"] },
      timeout_ms: { type: "integer", minimum: 1000, maximum: 3600000 },
      instruction_scope: { type: "string", enum: ["selected-only", "host-global"] },
      context_mode: { type: "string", enum: ["fresh", "native-prefix"], description: "Default fresh uses one model turn. Explicit native-prefix uses selected_context in a new durable controlled seed and then a fork child (two turns total); not a fork of the current conversation or a stronger code-worker sandbox. HEAD must keep both calls and seed persistence within the existing authorized scope." },
    }, required: ["project_root", "task", "model"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_bounded_worker_start",
    description: "Start an optional managed worker, not a general Host spawn. Start a prepared worker by its task key or exact authorization using the built-in local Host and bounded native owner. Embedding Hosts remain supported. Repeated start never relaunches an uncertain job; no runner, environment or enforcement assertion is accepted.",
    inputSchema: { type: "object", properties: {
      project_root: { type: "string", minLength: 1 },
      authorization_id: { type: "string", pattern: "^execution-authorization-[a-f0-9]{24}$" },
      task_key: { type: "string", pattern: "^[a-z][a-z0-9-]{0,95}$" },
      role: { type: "string", enum: ["developer", "coder", "reviewer"] },
    }, required: ["project_root"], oneOf: [{ required: ["authorization_id"], not: { required: ["task_key"] } },
      { required: ["task_key"], not: { required: ["authorization_id"] } }], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  ...["status", "reconcile", "cancel", "patch"].map((operation) => ({
    name: operation === "cancel" ? "head_bounded_worker_cancel" : `head_bounded_worker_job_${operation}`,
    description: operation === "cancel" ? "Request cancellation of one exact owned bounded job. A request is not proof of cleanup; inspect until terminal and owner exit are verified. No arbitrary PID or path is accepted."
      : operation === "patch" ? "Read exact owner-frozen workspace patch evidence bound to native terminal output and invocation lineage. This never applies edits, approves them or changes P2; later child edits cannot replace the frozen candidate."
      : operation === "reconcile" ? "Reconcile an exited worker against exact cleanup, durable lease and bounded provider output. Restore only missing matching P3 invocation evidence; never infer a release, relaunch, apply a result, or change P2."
        : "Read the same immutable bounded worker job after frontend loss. This does not relaunch, repair P2, or infer success from a spool alone.",
    inputSchema: { type: "object", properties: {
      project_root: { type: "string", minLength: 1 }, authorization_id: { type: "string", pattern: "^execution-authorization-[a-f0-9]{24}$" },
    }, required: ["project_root", "authorization_id"], additionalProperties: false },
    annotations: { readOnlyHint: operation === "status" || operation === "patch", destructiveHint: false, idempotentHint: true, openWorldHint: false },
  })),
  {
    name: "head_bounded_worker_reconcile",
    description: "Recover a current logical worker's exact frozen authorization after interrupted publication, without recapturing changed or missing source files. This repairs only missing lookup records; it never launches, retries, grants new authority, or changes P2 recovery direction.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        task_key: { type: "string", pattern: "^[a-z][a-z0-9-]{0,95}$" },
      },
      required: ["project_root", "task_key"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_bounded_worker_dispatch",
    description: "Create or verify one P3 non-HEAD worker ownership record bound to an exact current Run or idle Session ExecutionAuthorization. Execute via CLI worker-execute; for Session pass --input with the exact sessionRequest. This cannot change WholePlan, recovery direction, or review state.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        authorization_id: { type: "string", pattern: "^execution-authorization-[a-f0-9]{24}$" },
        role: { type: "string", enum: ["developer", "coder", "reviewer"] },
      },
      required: ["project_root", "authorization_id", "role"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_bounded_worker_status",
    description: "Read and verify one P3 bounded worker dispatch without consuming its authorization. The optional historical prepared-input view keeps original references, runtime observations and model-use uncertainty separate; it does not change current execution or recovery authority.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        authorization_id: { type: "string", pattern: "^execution-authorization-[a-f0-9]{24}$" },
      },
      required: ["project_root", "authorization_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_bounded_worker_wait",
    description: "Boundedly observe one worker's operational P5 lease/result state. Session results are evidence for HEAD consumption, without Run application or a review gate. The returned cursor is non-persisted and cannot create a ReviewDecision or recovery direction.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        authorization_id: { type: "string", pattern: "^execution-authorization-[a-f0-9]{24}$" },
        wait_timeout_ms: { type: "integer", minimum: 0, maximum: 600000, default: 0 },
      },
      required: ["project_root", "authorization_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_bounded_worker_apply_result",
    description: "Run-only: map one completed, actual-provider, native-supervised bounded-worker draft into the canonical ResultPacket and Fresh HEAD review context. This does not create a ReviewDecision or integrate checkpoint direction.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        authorization_id: { type: "string", pattern: "^execution-authorization-[a-f0-9]{24}$" },
      },
      required: ["project_root", "authorization_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_bounded_worker_wave_create",
    description: "Create one P3 grouping over 2-64 already-created bounded worker dispatches sharing the exact current Project/HEAD Session/Run/WholePlan/ExecutionContract/ContextCapsule lineage. It creates no authorization and widens no member scope.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        authorization_ids: { type: "array", minItems: 2, maxItems: 64, uniqueItems: true, items: { type: "string", pattern: "^execution-authorization-[a-f0-9]{24}$" } },
      },
      required: ["project_root", "authorization_ids"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_bounded_worker_wave_read",
    description: "Read and reverify one P3 worker wave, every member dispatch, current P2 lineage, and any create-only seal or abandonment evidence. This read cannot seal the wave.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        wave_id: { type: "string", pattern: "^bounded-worker-wave-[a-f0-9]{24}$" },
      },
      required: ["project_root", "wave_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_bounded_worker_wave_seal",
    description: "Create one P3 wave seal only after every independent member authorization has verified at-most-once lease consumption. A seal is not completion, review, or checkpoint integration.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        wave_id: { type: "string", pattern: "^bounded-worker-wave-[a-f0-9]{24}$" },
      },
      required: ["project_root", "wave_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_bounded_worker_wave_status",
    description: "Return one non-persisted P4 requested/started/returned/waiting/succeeded/failed projection. Status is observational and cannot create a seal, ReviewDecision, or recovery direction.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        wave_id: { type: "string", pattern: "^bounded-worker-wave-[a-f0-9]{24}$" },
      },
      required: ["project_root", "wave_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_bounded_worker_wave_results",
    description: "Read one non-persisted P4 aggregate of member result references after an explicit verified wave seal. It never applies ResultPackets or creates Fresh HEAD review.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        wave_id: { type: "string", pattern: "^bounded-worker-wave-[a-f0-9]{24}$" },
      },
      required: ["project_root", "wave_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_bounded_worker_wave_wait",
    description: "Boundedly observe one sealed wave as a non-persisted P5 outcome. Open or abandoned waves fail closed, and completion requires every member to succeed.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        wave_id: { type: "string", pattern: "^bounded-worker-wave-[a-f0-9]{24}$" },
        wait_timeout_ms: { type: "integer", minimum: 0, maximum: 600000, default: 0 },
      },
      required: ["project_root", "wave_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_bounded_worker_wave_abandon",
    description: "Create one P3 non-success abandoned handoff for an unsealed wave using a bounded reason code and non-authoritative sanitized summary. This cannot create review or recovery direction.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        wave_id: { type: "string", pattern: "^bounded-worker-wave-[a-f0-9]{24}$" },
        reason_code: { type: "string", enum: ["partial-launch", "lineage-drift", "operator-stop", "unrecoverable-member", "other"] },
        reason_summary: { type: "string", maxLength: 256, default: "" },
      },
      required: ["project_root", "wave_id", "reason_code"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_run_integrate_checkpoint",
    description: "After an exact accepted Fresh HEAD ReviewDecision, bind one reviewed Run result to one canonical recovery checkpoint. ResultPacket evidence cannot author checkpoint direction and no ReviewDecision is created here.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        run_id: { type: "string", pattern: "^run-[0-9]+-[a-f0-9]{6}$" },
        review_decision_id: { type: "string", pattern: "^review-decision-[a-f0-9]{24}$" },
        purpose: { type: "string", minLength: 1 },
        approved_decisions: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
        current_position: { type: "string", minLength: 1 },
        next_expected_result: { type: "string", minLength: 1 },
        open_review_ids: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
      },
      required: ["project_root", "run_id", "review_decision_id", "purpose", "approved_decisions", "current_position", "next_expected_result"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_run_integration",
    description: "Read and digest-verify the one-shot Run result integration receipt and its canonical recovery checkpoint.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        review_decision_id: { type: "string", pattern: "^review-decision-[a-f0-9]{24}$" },
      },
      required: ["project_root", "review_decision_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_world_model",
    description: "Completely freshness-check and digest-verify the current Repository World Model, then return a bounded read-only status projection with identities, counts, samples, and omission metadata.",
    inputSchema: {
      type: "object",
      properties: { project_root: { type: "string", minLength: 1 } },
      required: ["project_root"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_incremental_refresh_status",
    description: "Read and digest-verify the latest explicit incremental refresh receipt, World Model binding, freshness, and active-execution drift without triggering refresh or changing authority.",
    inputSchema: {
      type: "object",
      properties: { project_root: { type: "string", minLength: 1 } },
      required: ["project_root"],
      additionalProperties: false
    }
  },
  {
    name: "head_incremental_refresh_receipt",
    description: "Read and digest-verify one immutable incremental observed-state refresh receipt without advancing a pointer or changing Product Canon.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        refresh_receipt_id: { type: "string", pattern: "^incremental-refresh-receipt-[a-f0-9]{24}$" }
      },
      required: ["project_root", "refresh_receipt_id"],
      additionalProperties: false
    }
  },
  {
    name: "head_refresh_trigger_status",
    description: "Read and digest-verify the latest debounced filesystem or CI trigger batch, serialized delivery receipt, World Model binding, and writer state without starting a watcher or triggering refresh.",
    inputSchema: {
      type: "object",
      properties: { project_root: { type: "string", minLength: 1 } },
      required: ["project_root"],
      additionalProperties: false
    }
  },
  {
    name: "head_refresh_trigger_delivery",
    description: "Read and digest-verify one immutable refresh trigger delivery and its linked incremental refresh evidence without mutating observed state or Product Canon.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        trigger_delivery_id: { type: "string", pattern: "^refresh-trigger-delivery-[a-f0-9]{24}$" }
      },
      required: ["project_root", "trigger_delivery_id"],
      additionalProperties: false
    }
  },
  {
    name: "head_graph_projection_status",
    description: "Read and verify the current replaceable graph projection adapter state without treating the graph backend as canon or unique authority.",
    inputSchema: {
      type: "object",
      properties: { project_root: { type: "string", minLength: 1 } },
      required: ["project_root"],
      additionalProperties: false
    }
  },
  {
    name: "head_graphdb_projection_status",
    description: "Read the privacy-safe ArcadeDB projection activation, current semantic binding, and disclosed local fallback state without exposing credentials or granting the remote backend authority.",
    inputSchema: {
      type: "object",
      properties: { project_root: { type: "string", minLength: 1 } },
      required: ["project_root"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "head_graphdb_database_status",
    description: "Read a privacy-safe compatibility audit for the selected ArcadeDB database and HEAD-reserved schema without exposing the endpoint, database name, credentials, or mutation authority.",
    inputSchema: {
      type: "object",
      properties: { project_root: { type: "string", minLength: 1 } },
      required: ["project_root"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "head_graphdb_connection_preflight",
    description: "Check whether the selected GraphDB credential reference names are visible to the current plugin process without contacting the endpoint or returning credential, endpoint, or database values.",
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
    description: "After explicit user confirmation, reuse a compatible selected ArcadeDB database or create a missing one. Reset is allowed only for a proven incompatible HEAD-reserved schema and an exact selected-database confirmation. Credential values are never accepted as tool input.",
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
    description: "After explicit user confirmation, materialize and verify the current rebuildable GraphSnapshot in the selected compatible ArcadeDB database, then advance its pointer only after complete conformance. Credential values are resolved only from stored environment reference names.",
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
  {
    name: "head_markdown_projection_status",
    description: "Read and verify the deterministic Markdown projection, published-view drift, and current GraphSnapshot binding without treating generated documents as canon.",
    inputSchema: {
      type: "object",
      properties: { project_root: { type: "string", minLength: 1 } },
      required: ["project_root"],
      additionalProperties: false
    }
  },
  {
    name: "head_post_refresh_projection_status",
    description: "Read the effective manual-or-automatic Markdown projection policy and verify the latest post-refresh outcome without changing policy, documents, Product Canon, or active Run inputs.",
    inputSchema: {
      type: "object",
      properties: { project_root: { type: "string", minLength: 1 } },
      required: ["project_root"],
      additionalProperties: false
    }
  },
  {
    name: "head_post_refresh_projection_receipt",
    description: "Read and digest-verify one immutable post-refresh projection receipt with its linked incremental refresh, policy, DocumentProjection, or document-change candidate evidence.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        post_refresh_projection_receipt_id: { type: "string", pattern: "^post-refresh-projection-receipt-[a-f0-9]{24}$" }
      },
      required: ["project_root", "post_refresh_projection_receipt_id"],
      additionalProperties: false
    }
  },
  {
    name: "head_document_change_candidates",
    description: "Read and digest-verify one immutable DocumentChangeCandidateSet without accepting it or changing Product Canon.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        candidate_set_id: { type: "string", pattern: "^document-change-candidate-set-[a-f0-9]{24}$" }
      },
      required: ["project_root", "candidate_set_id"],
      additionalProperties: false
    }
  },
  {
    name: "head_document_change_review_status",
    description: "Read the explicit review and application status for one immutable DocumentChangeCandidateSet without accepting, applying, or mutating Product Canon.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        candidate_set_id: { type: "string", pattern: "^document-change-candidate-set-[a-f0-9]{24}$" }
      },
      required: ["project_root", "candidate_set_id"],
      additionalProperties: false
    }
  },
  {
    name: "head_document_change_review",
    description: "Read and digest-verify one explicit document-to-Product-Canon ReviewDecision and its exact candidate and resulting Product Model revision bindings.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        review_decision_id: { type: "string", pattern: "^document-change-review-decision-[a-f0-9]{24}$" }
      },
      required: ["project_root", "review_decision_id"],
      additionalProperties: false
    }
  },
  {
    name: "head_document_change_application",
    description: "Read and digest-verify one document-change application receipt linking the user ReviewDecision to exact before/after World, Graph, Canon, and Markdown projection identities.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        application_receipt_id: { type: "string", pattern: "^document-change-application-[a-f0-9]{24}$" }
      },
      required: ["project_root", "application_receipt_id"],
      additionalProperties: false
    }
  },
  {
    name: "head_world_query",
    description: "Traverse a bounded, digest-verified semantic neighborhood in the current Repository World Model as evidence, never instruction authority.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        query: { type: "string", minLength: 1 },
        depth: { type: "integer", minimum: 0, maximum: 3, default: 1 },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100 }
      },
      required: ["project_root", "query"],
      additionalProperties: false
    }
  },
  {
    name: "head_git_history",
    description: "Read bounded Git commit-message decision evidence from the current digest-verified World Model without promoting it to project decisions.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        query: { type: "string", default: "" },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 50 }
      },
      required: ["project_root"],
      additionalProperties: false
    }
  },
  {
    name: "head_temporal_graph",
    description: "Run a deterministic allowlisted traversal over the current rebuildable temporal provenance GraphSnapshot. Use exact_anchor_ids plus expected_graph_snapshot_id for HEAD-proposed semantic anchors; query is lexical discovery fallback only and never proves semantic relevance. Neither mode grants Canon, review, instruction, or recovery authority.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        query: { type: "string", minLength: 1 },
        exact_anchor_ids: { type: "array", minItems: 1, maxItems: 32, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 256 } },
        expected_graph_snapshot_id: { type: "string", pattern: "^graph-snapshot-[a-f0-9]{24}$" },
        kinds: { type: "array", items: { type: "string" }, uniqueItems: true },
        relation_types: { type: "array", items: { type: "string" }, uniqueItems: true },
        depth: { type: "integer", minimum: 0, maximum: 3, default: 1 },
        node_limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
        edge_limit: { type: "integer", minimum: 0, maximum: 1000, default: 200 },
        min_confidence: { type: "number", minimum: 0, maximum: 1, default: 0 },
        include_unreviewed_candidates: { type: "boolean", default: false }
      },
      required: ["project_root"],
      oneOf: [
        { required: ["query"] },
        { required: ["exact_anchor_ids", "expected_graph_snapshot_id"] }
      ],
      additionalProperties: false
    }
  },
  {
    name: "head_graph_lineage_status",
    description: "Read one bounded page of retained content-addressed World/Graph lineage as a non-persisted P4 hot/warm/cold projection. It creates no artifacts and never blocks ordinary work.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        cursor: { type: "string", pattern: "^world-model-[a-f0-9]{24}$" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 25 }
      },
      required: ["project_root"],
      additionalProperties: false
    }
  },
  {
    name: "head_graph_lineage_trace",
    description: "Trace an exact or discovery-selected Graph anchor in a verified current or retained snapshot, with a bounded read-only execution-lineage overlay. Discovery does not prove relevance and completion does not imply integration.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        world_model_id: { type: "string", pattern: "^world-model-[a-f0-9]{24}$" },
        anchor_id: { type: "string", minLength: 1, maxLength: 256 },
        query: { type: "string", minLength: 1 },
        depth: { type: "integer", minimum: 0, maximum: 3, default: 2 },
        node_limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
        edge_limit: { type: "integer", minimum: 0, maximum: 1000, default: 200 },
        include_execution: { type: "boolean", default: true }
      },
      required: ["project_root"],
      oneOf: [{ required: ["anchor_id"] }, { required: ["query"] }],
      additionalProperties: false
    }
  },
  {
    name: "head_graph_lineage_diff",
    description: "Compare two exact retained World/Graph snapshots as a bounded P4 view. Exact-content possible moves are evidence only and never automatic semantic identity.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        from_world_model_id: { type: "string", pattern: "^world-model-[a-f0-9]{24}$" },
        to_world_model_id: { type: "string", pattern: "^world-model-[a-f0-9]{24}$" },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
        scope_paths: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 500 },
        cursor: { type: "string", maxLength: 131072 }
      },
      required: ["project_root", "from_world_model_id", "to_world_model_id"],
      additionalProperties: false
    }
  },
  {
    name: "head_runtime_state",
    description: "Read bounded point-in-time external runtime observations from the current digest-verified World Model as evidence without granting runtime control authority.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: { type: "string", minLength: 1 },
        query: { type: "string", default: "" },
        runtime: { type: "string", default: "" },
        state: { type: "string", default: "" },
        kind: { type: "string", default: "" },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 50 }
      },
      required: ["project_root"],
      additionalProperties: false
    }
  },
  {
    name: "head_compact_prepare",
    description: "Create the canonical Session/Run recovery checkpoint and one bounded compaction epoch. This does not invoke a provider or treat a provider summary as recovery authority.",
    inputSchema: { type: "object", properties: {
      project_root: { type: "string", minLength: 1 }, runtime: { type: "string", enum: ["manual", "claude", "codex", "opencode"], default: "manual" }, user_turn_id_at_prepare: { type: "integer", minimum: 0 }, purpose: { type: "string", minLength: 1 }, approved_decisions: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } }, current_position: { type: "string", minLength: 1 }, next_expected_result: { type: "string", minLength: 1 }, open_review_ids: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
    }, required: ["project_root", "user_turn_id_at_prepare", "purpose", "approved_decisions", "current_position", "next_expected_result"], additionalProperties: false },
  },
  {
    name: "head_compact_verify",
    description: "Verify provider compaction against the exact canonical checkpoint. Provider transcripts, summaries, session identities, and HEADContinuitySnapshot are rejected as recovery sources.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 }, epoch_id: { type: "string", pattern: "^compaction-epoch-[a-f0-9-]{36}$" }, checkpoint_digest: { type: "string", pattern: "^[a-f0-9]{64}$" }, current_user_turn_id: { type: "integer", minimum: 0 }, provider_compacted: { type: "boolean" }, recovery_source: { type: "string", enum: ["canonical-checkpoint"] } }, required: ["project_root", "epoch_id", "checkpoint_digest", "current_user_turn_id", "provider_compacted"], additionalProperties: false },
  },
  {
    name: "head_compact_continue",
    description: "Consume a verified compaction continuation token at most once and return the checkpoint-bound continuation instruction. A newer real user turn supersedes it.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 }, epoch_id: { type: "string", pattern: "^compaction-epoch-[a-f0-9-]{36}$" }, continuation_token: { type: "string", minLength: 32 }, current_user_turn_id: { type: "integer", minimum: 0 } }, required: ["project_root", "epoch_id", "continuation_token", "current_user_turn_id"], additionalProperties: false },
  },
  {
    name: "head_compact_status",
    description: "Read the current compaction epoch and digest-verified Session/Run checkpoint without disclosing the continuation token.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 } }, required: ["project_root"], additionalProperties: false },
  },
  {
    name: "head_compact_abort",
    description: "Abort one open compaction epoch without changing its canonical Session/Run checkpoint or Product Canon.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 }, epoch_id: { type: "string", pattern: "^compaction-epoch-[a-f0-9-]{36}$" }, reason: { type: "string", minLength: 1 } }, required: ["project_root", "epoch_id", "reason"], additionalProperties: false },
  },
  {
    name: "head_product_signal_record",
    description: "Record an immutable observed-fact ProductSignal and rebuild the derived Product Graph without changing Product Canon.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 }, statement: { type: "string", minLength: 1 }, observed_at: { type: "string", format: "date-time" }, source: { type: "string" }, evidence_ids: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } } }, required: ["project_root", "statement"], additionalProperties: false },
  },
  {
    name: "head_product_hypothesis_record",
    description: "Record an immutable non-authoritative hypothesis linked to ProductSignals and/or exact common Observation identities.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 }, statement: { type: "string", minLength: 1 }, rationale: { type: "string" }, signal_ids: { type: "array", uniqueItems: true, items: { type: "string", pattern: "^product-signal-[a-f0-9]{24}$" } }, observation_ids: { type: "array", uniqueItems: true, items: { type: "string", pattern: "^(observation|derived-observation)-[a-f0-9]{24}$" } } }, required: ["project_root", "statement"], additionalProperties: false },
  },
  {
    name: "head_product_initiative_propose",
    description: "Propose a Product Initiative from persisted hypotheses or inline reasoning. Feature resolution may be deferred to explicit review; proposal never approves the initiative or mutates Product Canon.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 }, title: { type: "string", minLength: 1 }, description: { type: "string" }, reasoning: { type: "string" }, hypothesis_ids: { type: "array", uniqueItems: true, items: { type: "string", pattern: "^product-hypothesis-[a-f0-9]{24}$" } }, feature_resolution: { oneOf: [
      { type: "object", properties: { kind: { const: "existing-feature" }, feature_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" } }, required: ["kind", "feature_key"], additionalProperties: false },
      { type: "object", properties: { kind: { const: "candidate" }, feature: { type: "object", properties: { key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" }, name: { type: "string", minLength: 1 }, description: { type: "string" }, capability_keys: { type: "array", uniqueItems: true, items: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" } } }, required: ["key", "name"], additionalProperties: false } }, required: ["kind", "feature"], additionalProperties: false },
      { type: "object", properties: { kind: { const: "gap" }, reason: { type: "string", minLength: 1 } }, required: ["kind", "reason"], additionalProperties: false },
    ] } }, required: ["project_root", "title"], additionalProperties: false },
  },
  {
    name: "head_product_initiative_review",
    description: "Record the user's explicit accept/reject ReviewDecision for one Product Initiative candidate. Acceptance resolves any deferred Feature mapping, creates a separate reviewed Initiative, and never mutates Product Canon.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 }, initiative_candidate_id: { type: "string", pattern: "^product-initiative-candidate-[a-f0-9]{24}$" }, disposition: { type: "string", enum: ["accept", "reject"] }, rationale: { type: "string", minLength: 1 }, confirm_user_review: { type: "boolean" }, feature_resolution: { oneOf: [
      { type: "object", properties: { kind: { const: "existing-feature" }, feature_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" } }, required: ["kind", "feature_key"], additionalProperties: false },
      { type: "object", properties: { kind: { const: "candidate" }, feature: { type: "object", properties: { key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" }, name: { type: "string", minLength: 1 }, description: { type: "string" }, capability_keys: { type: "array", uniqueItems: true, items: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" } } }, required: ["key", "name"], additionalProperties: false } }, required: ["kind", "feature"], additionalProperties: false },
      { type: "object", properties: { kind: { const: "gap" }, reason: { type: "string", minLength: 1 } }, required: ["kind", "reason"], additionalProperties: false },
    ] } }, required: ["project_root", "initiative_candidate_id", "disposition", "rationale", "confirm_user_review"], additionalProperties: false },
  },
  {
    name: "head_product_outcome_observe",
    description: "Record observed or derived outcome evidence bound to an accepted ChangeSet, ResultPacket, and execution ReviewDecision without judging success or changing Feature status.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 }, change_set_id: { type: "string", pattern: "^change-set-[a-f0-9]{24}$" }, initiative_id: { type: "string", pattern: "^reviewed-product-initiative-[a-f0-9]{24}$" }, statement: { type: "string", minLength: 1 }, epistemic_class: { type: "string", enum: ["observed-fact", "derived-projection"] }, evidence_ids: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } } }, required: ["project_root", "change_set_id", "statement"], additionalProperties: false },
  },
  {
    name: "head_product_operating_status",
    description: "Read Product Operating Loop artifacts and authority classes, reusing a disclosed write-invalidated verified-snapshot cache unless fresh verification is requested.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 }, fresh: { type: "boolean", default: false } }, required: ["project_root"], additionalProperties: false },
  },
  {
    name: "head_release_observe",
    description: "Record a host-supplied deployment result and current product Git refs as immutable P3 evidence. A ReleaseObservation is created only for an approved successful result whose exact commit is reachable and present on a current product ref; this never approves deployment or changes Product Canon.",
    inputSchema: { type: "object", properties: {
      project_root: { type: "string", minLength: 1 }, environment_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" }, status: { type: "string", enum: ["succeeded", "failed", "cancelled"] }, commit: { type: "string", pattern: "^[a-fA-F0-9]{40,64}$" }, observed_at: { type: "string", format: "date-time" }, source_event_key_digest: { type: "string", pattern: "^[a-f0-9]{64}$" }, deployment_evidence_digest: { type: "string", pattern: "^[a-f0-9]{64}$" }, approved: { type: "boolean" }, approval_evidence_digest: { anyOf: [{ type: "string", pattern: "^[a-f0-9]{64}$" }, { type: "null" }] }, change_set_id: { anyOf: [{ type: "string", pattern: "^change-set-[a-f0-9]{24}$" }, { type: "null" }] }, vcs_evidence_id: { anyOf: [{ type: "string", pattern: "^vcs-evidence-[a-f0-9]{24}$" }, { type: "null" }] }, confirm_host_observation: { type: "boolean" },
    }, required: ["project_root", "environment_key", "status", "commit", "observed_at", "source_event_key_digest", "deployment_evidence_digest", "approved", "approval_evidence_digest", "change_set_id", "vcs_evidence_id", "confirm_host_observation"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "head_release_status",
    description: "Read digest-verified P3 BranchState, DeploymentResult, and Release observations. The projection is evidence-only and has no Product Canon, execution, or recovery authority.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 } }, required: ["project_root"], additionalProperties: false },
  },
  {
    name: "head_observation_sources",
    description: "Page and exactly filter provider-neutral Host-injected Observation source IDs with bounded descriptor shape and Host-local availability hints. Stale read-only cursors restart at the first page with disclosure; no external source is read.",
    inputSchema: { type: "object", properties: {
      project_root: { type: "string", minLength: 1 },
      type_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$" },
      adapter_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$" },
      availability: { type: "string", enum: ["unknown", "ready", "auth-missing", "rate-limited", "unavailable"] },
      limit: { type: "integer", minimum: 1, maximum: 64 },
      projection_id: { type: "string", pattern: "^observation-source-projection-[a-f0-9]{24}$" },
      cursor: { type: "string", pattern: "^observation-source-[a-f0-9]{24}$" },
    }, required: ["project_root"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_observation_prepare",
    description: "Prepare one reuse-first, non-persisted Observation view for an exact type selected by provider HEAD. It returns existing current Observation IDs before configured source IDs and never judges sufficiency, selects a source, collects data, or asks the user for provenance JSON.",
    inputSchema: { type: "object", properties: {
      project_root: { type: "string", minLength: 1 },
      type_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$" },
      subject_type: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$" },
      subject_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$" },
      adapter_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$" },
      observed_after: { type: "string", format: "date-time" },
      observed_before: { type: "string", format: "date-time" },
      existing_limit: { type: "integer", minimum: 1, maximum: 100 },
      source_limit: { type: "integer", minimum: 1, maximum: 64 },
      source_availability: { type: "string", enum: ["unknown", "ready", "auth-missing", "rate-limited", "unavailable"] },
      source_projection_id: { type: "string", pattern: "^observation-source-projection-[a-f0-9]{24}$" },
      source_cursor: { type: "string", pattern: "^observation-source-[a-f0-9]{24}$" },
    }, required: ["project_root", "type_key"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_observation_collect_source",
    description: "Collect one configured Host source by its bounded opaque source ID. The trusted Host owns paths, credentials, descriptor, scope, and provenance; this tool accepts none of them and records only non-authoritative P3 Observation evidence.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 }, source_id: { type: "string", pattern: "^observation-source-[a-f0-9]{24}$" } }, required: ["project_root", "source_id"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "head_observation_ingest",
    description: "Ingest one already constructed bounded CI or Host Observation. The Host adapter owns source access, binding, digests, coverage, and provenance confirmation; this tool does not ask the user to attest to machine evidence.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 }, binding: observationBindingSchema, descriptor: observationDescriptorSchema, observation: observationInputSchema, confirm_host_observation: { type: "boolean" } }, required: ["project_root", "binding", "descriptor", "observation", "confirm_host_observation"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "head_observation_derive",
    description: "Record a deterministic P3 derived Observation from exact existing Observation IDs and an algorithm digest. It cannot assert causality or Product success.",
    inputSchema: { type: "object", properties: {
      project_root: { type: "string", minLength: 1 }, descriptor: observationDescriptorSchema,
      subject: { type: "object", properties: { type: { type: "string", minLength: 1 }, key: { type: "string", minLength: 1 } }, required: ["type", "key"], additionalProperties: false },
      temporal_scope: observationInputSchema.properties.temporal_scope,
      input_observation_ids: { type: "array", minItems: 1, maxItems: 64, uniqueItems: true, items: { type: "string", pattern: "^observation-[a-f0-9]{24}$" } },
      algorithm: { type: "object", properties: { key: { type: "string", minLength: 1 }, version: { type: "string", minLength: 1 }, digest: { type: "string", pattern: "^[a-f0-9]{64}$" } }, required: ["key", "version", "digest"], additionalProperties: false },
      coverage: observationCoverageSchema, payload: { type: "object" }, confirm_host_derivation: { type: "boolean" },
    }, required: ["project_root", "descriptor", "subject", "temporal_scope", "input_observation_ids", "algorithm", "coverage", "payload", "confirm_host_derivation"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_conversation_enter",
    description: "Obtain missing current conversation context, or reuse sufficient verified supplied entry for the exact selected Session and current common direction. This read-only entry restores verified P2 direction and returns bounded status, Attention and package facts; detailed World freshness is explicitly not inspected. No continuation, provider attachment, review, Canon change or ordinary-work gate is created. Explicit project status retains full optional diagnostics when needed.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 } }, required: ["project_root"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_compaction_lifecycle_step",
    description: "Process one Host-injected provider-neutral compaction lifecycle event. The Host owns event delivery and compaction; Core restores P2 first, retains transport tokens only in P5, and never asks the user for event, epoch, turn, or token JSON. Without an injected Host adapter this is a non-blocking unavailable capability.",
    inputSchema: { type: "object", properties: {
      project_root: { type: "string", minLength: 1 },
      direction: {
        type: "object",
        description: "Optional current recovery direction authored by provider HEAD at a before-compaction boundary. Omit to reuse the exact current checkpoint.",
        properties: {
          purpose: { type: "string", minLength: 1 },
          approved_decisions: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
          current_position: { type: "string", minLength: 1 },
          next_expected_result: { type: "string", minLength: 1 },
          open_review_ids: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
        },
        required: ["purpose", "approved_decisions", "current_position", "next_expected_result", "open_review_ids"],
        additionalProperties: false,
      },
    }, required: ["project_root"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_observation_read",
    description: "Read one exact digest-verified observed or derived Observation by ID with its descriptor and bounded receipt or derivation lineage.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 }, observation_id: { type: "string", pattern: "^(?:observation|derived-observation)-[a-f0-9]{24}$" } }, required: ["project_root", "observation_id"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_observation_query",
    description: "Read global retained inventory counts and query a bounded P4 page of current Observation identities by exact type, subject, source, time, and record-kind filters. This is discovery only; it does not select semantic relevance or make records Context-eligible.",
    inputSchema: { type: "object", properties: {
      project_root: { type: "string", minLength: 1 },
      type_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$" },
      subject_type: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$" },
      subject_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$" },
      adapter_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$" },
      observed_after: { type: "string", format: "date-time" },
      observed_before: { type: "string", format: "date-time" },
      record_kind: { type: "string", enum: ["all", "observed", "derived"], default: "all" },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
      projection_id: { type: "string", pattern: "^observation-projection-[a-f0-9]{24}$" },
      cursor: { type: "string", pattern: "^(?:observation|derived-observation)-[a-f0-9]{24}$" },
    }, required: ["project_root"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_continuity_snapshot",
    description: "Build an on-demand non-persisted derived reference view over exact Session, Run, lineage, product, and graph identities, with optional forced fresh verification. It is not recovery canon or HEAD judgment authority.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 }, fresh: { type: "boolean", default: false } }, required: ["project_root"], additionalProperties: false },
  },
];

allTools.push(
  {
    name: "head_project_graph",
    description: "Find project evidence through a bounded graph first. Verified historical records keep their original revision and candidate/rejection state. Missing/partial/failed graph or DB returns source fallback; no Product approval, current whole World, Run or Capsule prerequisite. Results never authorize effects or replace current user direction.",
    inputSchema: { type: "object", properties: {
      project_root: { type: "string", minLength: 1 }, query: { type: "string", default: "" },
      view: { type: "string", enum: ["all", "work", "product"], default: "all" },
      anchor_ids: { type: "array", items: { type: "string" }, maxItems: 32 },
      paths: { type: "array", items: { type: "string" } }, depth: { type: "integer", minimum: 0, maximum: 8, default: 1 },
      max_nodes: { type: "integer", minimum: 1, maximum: 500 }, max_edges: { type: "integer", minimum: 0, maximum: 1000 },
      details: { type: "boolean", default: false, description: "Default returns short core evidence (8 nodes/12 edges). Request details with fitting source paths or record anchors for original bounded payloads and relations (60/120 defaults), including recorded context and exact source comparisons when available. Recorded reasons, citations, byte changes and current state remain distinct; missing history does not require a Run, commit or new save." },
      world_model_id: { type: "string" }, include_candidates: { type: "boolean", default: true },
      inventory_page: { type: "boolean", description: "Opt-in read-only owned-record byte discovery. Separate untyped rows, bounded metadata/body traversal, exact read hints and explicit next arguments; never typed approval or currentness. Ordinary graph selection is unchanged when omitted." },
      inventory_paths: { type: "array", minItems: 1, maxItems: 32, items: { type: "string", minLength: 1, maxLength: 512 }, description: "Optional owned canonical record files/subdirectories, usually copied from returned narrowing arguments. Separate from graph source paths." },
      inventory_cursor: { type: "string", minLength: 1, maxLength: 4096, description: "Returned request-local lexical seek, bound to Project/storage/query/scope; not a durable snapshot or recovery direction." },
      previous_result: { type: "object", description: "Optional prior verified result for identical-basis reuse, supplied by HEAD." },
    }, required: ["project_root"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "head_project_graph_index", description: "Refresh the replaceable graph inventory from existing verified records and observations. Reuse unchanged inputs; no Product approval, execution, checkpoint or semantic inference.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 } }, required: ["project_root"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_session_create", description: "Create or reuse an independent logical HEAD Session within the canonical Project. Preserve the default Session and every existing active/unknown operation. HEAD chooses the route; users need no ID form.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 }, purpose: { type: "string" }, new_session_id: { type: "string" } }, required: ["project_root"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "head_conversation_list", description: "List other live conversations for this same project across Claude Code, Codex, and OpenCode. Each row has a send address and whether it is reachable now.",
    inputSchema: { type: "object", properties: {
      project_root: { type: "string", minLength: 1 },
      host_ticket: { type: "string", minLength: 32, maxLength: 32, description: "Host-written caller ticket. A model-authored value is not a caller." },
    }, required: ["project_root"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_conversation_send", description: "Send a same-project conversation message. The sender is the live host caller, never an argument. The result is delivered, sent, or queued.",
    inputSchema: { type: "object", properties: {
      project_root: { type: "string", minLength: 1 },
      to: { type: "string", minLength: 3, maxLength: 420 },
      body: { type: "string", minLength: 1, maxLength: 6000 },
      reply_to: { type: "string", pattern: "^msg-[a-f0-9]{24}$" },
      host_ticket: { type: "string", minLength: 32, maxLength: 32, description: "Host-written caller ticket. A model-authored value is not a caller." },
    }, required: ["project_root", "to", "body"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "head_session_list", description: "Read a bounded logical Session page; session_id previews one Session's exact work and Todo without changing any selection. Unread/failed entries remain explicit; recent results are not whole-work completion or ownership. Follow nextAfterSessionId when needed.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 },
      max_sessions: { type: "integer", minimum: 1, maximum: 64 }, after_session_id: { type: "string", maxLength: 512 },
      conversation_candidates: { type: "array", description: "Optional untrusted Host lookup selectors, at most 16 inspected. Each row supplies runtime, native_session_id, optional agent_id, and explicit environment_scope=current or unsupported-other. Invalid rows are reported separately. No caller, route, contact or ownership is inferred.", items: {} } }, required: ["project_root"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_project_direction_read", description: "Read the current common user-directed goal, constraints and cancellation across Sessions. Historical graphs/checkpoints cannot override it.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 } }, required: ["project_root"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_project_direction_update", description: "Record a current user direction against the exact common-direction basis; identical retry reuses it. HEAD conveys the user's scoped decision. Observed evidence, projected approval and model consensus cannot author direction or grant deployment/Canon authority.",
    inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 }, expected_direction_id: { type: ["string", "null"] },
      direction: { type: "object", properties: { goal: { type: "string" }, constraints: { type: "array", items: { type: "string" } }, decisions: { type: "array", items: { type: "string" } }, cancelledActions: { type: "array", items: { type: "string" } } }, required: ["goal", "constraints", "decisions", "cancelledActions"], additionalProperties: false },
    }, required: ["project_root", "expected_direction_id", "direction"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
);

allTools.push({
  name: "head_run_start",
  description: "Start the existing contract-bound Run transaction. An optional Core request key makes exact retries converge; historical acknowledgments never authorize provider/worker replay. HEAD supplies the key without another prepare call or user form.",
  inputSchema: { type: "object", properties: {
    project_root: { type: "string", minLength: 1 }, execution_contract_id: { type: "string", pattern: "^execution-contract-[a-f0-9]{24}$" },
    start_request_id: { type: "string", minLength: 1, maxLength: 256 },
  }, required: ["project_root", "execution_contract_id"], additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
});

for (const tool of allTools) {
  if (tool.inputSchema?.properties?.project_root) {
    tool.inputSchema.properties.session_id = { type: "string", description: "Optional logical HEAD Session route, selected by HEAD/Host. Omit for the existing default. Never a provider session ID." };
  }
  if (tool.annotations?.readOnlyHint === undefined && Object.hasOwn(supplementalReadOnlyHints, tool.name)) {
    tool.annotations = { ...tool.annotations, readOnlyHint: supplementalReadOnlyHints[tool.name] };
  }
}

// Stateless discovery, not a registration store or permission/activation system.
allTools.push({
  name: SESSION_HOST_REQUEST_HELPER,
  description: "Internal native Host Hook ingress for one transient request correlation. No logical Session selection, original write, permission or recovery authority. Ordinary model calls cannot mint native claims; users never fill this input.",
  inputSchema: { type: "object", properties: {
    native_session_id: { type: "string", minLength: 1, maxLength: 512 },
    native_agent_id: { type: ["string", "null"], maxLength: 512 },
    native_project_root: { type: "string", description: "Optional trusted Hook cwd; model input is not proof of plugin loading or Project scope." },
    tool_use_id: { type: "string", minLength: 1, maxLength: 512 },
    outer_tool_name: { type: "string", minLength: 1, maxLength: 512 },
    original_arguments: { type: "string", minLength: 2 },
  }, required: ["native_session_id", "tool_use_id", "outer_tool_name", "original_arguments"], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
});
const defaultToolNames = new Set([
  SESSION_HOST_REQUEST_HELPER,
  "head_core_contract", "head_project_initialize_or_resume", "head_conversation_enter", "head_conversation_list", "head_conversation_send", "head_project_graph",
  "head_session_create", "head_project_direction_update",
  "head_project_status", "head_checkpoint_diagnose", "head_checkpoint_basis",
  "head_checkpoint_sync", "head_session_restore", "head_pending_review",
  "head_runtime_invocation_lease_status", "head_bounded_worker_job_status",
  "head_bounded_worker_cancel", "head_worker_integration_status",
]);
const routedInputSchema = {
  type: "object", properties: {
    name: { type: "string", description: "Exact tool name from discovery or a known HEAD contract." },
    arguments: { type: "object", description: "Arguments following that tool's returned inputSchema; HEAD supplies them, not a user form." },
  }, required: ["name", "arguments"], additionalProperties: false,
};
const discoveryTools = [
  {
    name: "head_tools_discover",
    description: "Read optional HEAD capability prefixes, or exact schemas by name/prefix. No Project, registration, activation or approval needed. Use only when the task needs Product, Graph, Observation, Context or retained-work diagnostics; page with nextOffset.",
    inputSchema: { type: "object", properties: {
      name: { type: "string", description: "One exact tool name; mutually exclusive with prefix." },
      prefix: { type: "string", description: "A returned tool prefix." },
      offset: { type: "integer", minimum: 0, default: 0 },
      limit: { type: "integer", minimum: 1, maximum: 20, default: 8 },
    }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "head_tools_read",
    description: "Call a discovered read-only HEAD tool using its exact inputSchema. Returns the original result and errors. No discovery prerequisite, Project activation or authority change; independent work remains available if an optional capability fails.",
    inputSchema: routedInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "head_tools_call",
    description: "Call a discovered HEAD operation using its exact inputSchema within existing user scope. Original authority, current-basis, ownership, replay and maintenance checks still apply. Discovery grants no authorization. Prefer head_tools_read for read-only operations.",
    inputSchema: { ...routedInputSchema, properties: { ...routedInputSchema.properties,
      execution_mode: { type: "string", enum: ["ordinary", "managed"], default: "ordinary", description: "HEAD selects managed only for needed durable ownership/recovery/effect guarantees. It grants no new authorization." },
    } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
];
// Complete ordinary schemas for programmatic consumers; tools/list stays small.
export const catalogTools = allTools.map(presentedTool);
export function toolsForSurface(surface = "ordinary") {
  requireSurface(surface);
  return [...allTools.filter(tool => surface === "managed-maintenance"
    ? true : defaultToolNames.has(tool.name)), ...discoveryTools].map(presentedTool);
}
export const tools = toolsForSurface();

export function discoverTools({ name, prefix, offset = 0, limit = 8 } = {}, surface = "ordinary") {
  requireSurface(surface);
  if ((name != null && typeof name !== "string") || (prefix != null && typeof prefix !== "string")
      || (name != null && prefix != null) || !Number.isInteger(offset) || offset < 0
      || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("Invalid tool discovery selector or page.");
  const available = allTools.map(presentedTool);
  if (name != null) name = publicToolName(name);
  if (prefix != null) { const known = DISCOVERY_PREFIX_PAIRS.find(pair => pair.legacy === prefix || pair.canonical === prefix); if (known) prefix = ARTIFACT_COMPOSITION.identity === "lode" ? known.canonical : known.legacy; }
  const scope = { surface, persisted: false, grantsAuthorization: false,
    managedEntry: `${publicToolName("head_tools_call")} with execution_mode: managed; original authorization, scope, lease and result checks apply`,
    maintenanceEntry: "scripts/mcp-managed-maintenance.mjs (same managed execution contract; retained reader supported)" };
  if (name == null && prefix == null) {
    const counts = new Map();
    for (const tool of available) {
      const key = `${ARTIFACT_COMPOSITION.toolPrefix}${tool.name.split("_")[1]}_`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return { ...scope, prefixes: [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([prefix, count]) => ({ prefix, count })),
      nextOffset: null };
  }
  const matches = available.filter(tool => {
    if (name != null) return tool.name === name;
    const descriptor = resolveOperation(tool.name);
    return tool.name.startsWith(prefix) || descriptor?.legacyName.startsWith(prefix) || descriptor?.canonicalName.startsWith(prefix);
  });
  if (name != null && !matches.length) throw new Error(`Unknown or unavailable tool on ${surface}: ${name}`);
  return { ...scope, total: matches.length, offset, nextOffset: offset + limit < matches.length ? offset + limit : null,
    tools: matches.slice(offset, offset + limit).map(tool => ({ ...tool,
      invokeWith: publicToolName(tool.annotations?.readOnlyHint === true ? "head_tools_read" : "head_tools_call"),
      ...(isManagedMutation(tool.name) ? { executionMode: "managed" } : {}),
    })) };
}

function requestedToolName(request) {
  return ["head_tools_read", "head_tools_call"].includes(semanticToolName(request.params?.name))
    ? semanticToolName(request.params?.arguments?.name) : semanticToolName(request.params?.name);
}

// Use the shared policy after router unwrap. OpenCode applies it to the exact
// Host before-hook; MCP uses its own caller and optional Codex observations.
// Disabled mode does not read observations.
async function subagentStateWriteRejection(name, args, caller, environment) {
  const selected = allTools.find(tool => semanticToolName(tool.name) === name);
  if (!selected || selected.annotations?.readOnlyHint === true) return null;
  if (!subagentWriteGuardEnabled(environment, { caller })) return null;
  // A cold catalog or disabled guard must not load optional Codex observations.
  let current = caller && typeof caller === "object" ? { ...caller } : null;
  if (current?.runtime === "codex" && current.subagent !== true && typeof args?.project_root === "string" && typeof current.nativeSessionId === "string") {
    const { recordedSubagentCaller } = await import("./lib/subagent-caller-signal.mjs");
    if (recordedSubagentCaller({ root: args.project_root, runtime: "codex", nativeSessionId: current.nativeSessionId, environment })) current = { ...current, subagent: true };
  }
  const decision = assessSubagentStateWrite({ caller: current, readOnly: false });
  return decision.allowed ? null : decision.message;
}

const success = (id, result) => ({ jsonrpc: "2.0", id, result });
const failure = (id, message) => ({ jsonrpc: "2.0", id, error: { code: -32000, message } });
export const WORLD_MODEL_STATUS_MCP_MAX_BYTES = 4 * 1024 * 1024;

function onboardingInputFromMcp(args) {
  const onboarding = {};
  if (args.mode != null) onboarding.mode = args.mode;
  if (args.source_scope != null) onboarding.sourceScope = {
    includeRoots: args.source_scope.include_roots || [],
    excludeRoots: args.source_scope.exclude_roots || [],
  };
  if (args.storage != null) onboarding.storage = args.storage.mode === "local" ? { mode: "local" } : {
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

function featureMappingProposalFromMcp(value) {
  return {
    schemaVersion: value.schema_version,
    sourceSnapshotId: value.source_snapshot_id,
    productModelId: value.product_model_id,
    candidates: value.candidates.map((candidate) => ({
      relationshipType: candidate.relationship_type,
      sourceNodeId: candidate.source_node_id,
      productNodeId: candidate.product_node_id,
      explanation: candidate.explanation,
      confidence: candidate.confidence,
    })),
  };
}

function productFeatureResolutionFromMcp(value) {
  if (value?.kind === "existing-feature") return { kind: value.kind, featureKey: value.feature_key };
  if (value?.kind === "candidate") return { kind: value.kind, feature: { key: value.feature?.key, name: value.feature?.name, description: value.feature?.description || "", capabilityKeys: value.feature?.capability_keys || [] } };
  return { kind: "gap", reason: value?.reason };
}

function observationDescriptorFromMcp(value) {
  return {
    typeKey: value.type_key,
    typeVersion: value.type_version,
    forms: value.forms,
    payloadSchema: {
      additionalFields: value.payload_schema.additional_fields,
      fields: value.payload_schema.fields.map((field) => ({
        key: field.key,
        type: field.type,
        required: field.required,
        ...(field.min == null ? {} : { min: field.min }),
        ...(field.max == null ? {} : { max: field.max }),
        ...(field.enum == null ? {} : { enum: field.enum }),
        ...(field.items_type == null ? {} : { itemsType: field.items_type }),
        ...(field.max_items == null ? {} : { maxItems: field.max_items }),
      })),
    },
  };
}

function observationCoverageFromMcp(value) {
  return {
    state: value.state,
    basis: value.basis,
    queryDigest: value.query_digest,
    examinedCount: value.examined_count,
    sourceReportedTotal: value.source_reported_total,
    omittedCount: value.omitted_count,
    cursorStartDigest: value.cursor_start_digest,
    cursorEndDigest: value.cursor_end_digest,
  };
}

function observationBindingFromMcp(value) {
  return {
    adapterKey: value.adapter_key,
    adapterVersion: value.adapter_version,
    sourceScopeDigest: value.source_scope_digest,
    credentialReferenceNames: value.credential_reference_names || [],
  };
}

function observationInputFromMcp(value) {
  return {
    subject: value.subject,
    form: value.form,
    temporalScope: { observedAt: value.temporal_scope.observed_at, start: value.temporal_scope.start, end: value.temporal_scope.end },
    sourceEventKeyDigest: value.source_event_key_digest,
    sourceEvidenceDigest: value.source_evidence_digest,
    coverage: observationCoverageFromMcp(value.coverage),
    payload: value.payload,
  };
}

function conformanceBaselineFromMcp(value) {
  return {
    productModelId: value.product_model_id,
    productModelHash: value.product_model_hash,
    worldModelId: value.world_model_id,
    worldModelHash: value.world_model_hash,
    sourceSnapshotId: value.source_snapshot_id,
    graphSnapshotId: value.graph_snapshot_id,
  };
}

function conformanceEvidenceAnchorFromMcp(value) {
  if (value.kind === "source") return { kind: value.kind, path: value.path, fileDigest: value.file_digest, startLine: value.start_line ?? null, endLine: value.end_line ?? null, excerptDigest: value.excerpt_digest ?? null, revisionId: value.revision_id ?? null, symbolId: value.symbol_id ?? null };
  if (value.kind === "change") return { kind: value.kind, changeSetId: value.change_set_id, changeSetHash: value.change_set_hash, changeId: value.change_id };
  if (value.kind === "observation") return { kind: value.kind, observationId: value.observation_id, observationHash: value.observation_hash };
  return { kind: value.kind, graphSnapshotId: value.graph_snapshot_id, nodeId: value.node_id };
}

function conformanceFindingFromMcp(value) {
  return {
    canonAnchor: { entityKind: value.canon_anchor.entity_kind, entityKey: value.canon_anchor.entity_key },
    evidenceAnchors: value.evidence_anchors.map(conformanceEvidenceAnchorFromMcp),
    claim: { kind: value.claim.kind, summary: value.claim.summary, rationale: value.claim.rationale, riskHint: value.claim.risk_hint },
  };
}

function compactReviewResult(result) {
  const latestReviewDecisionId = result.state.latestReviewDecisionId ?? result.state.reviewDecisionId ?? null;
  return {
    status: result.status,
    state: {
      phase: result.state.phase,
      stateRevision: result.state.stateRevision,
      candidateSetId: result.state.candidateSetId,
      latestReviewDecisionId,
      reviewDecisionId: latestReviewDecisionId,
      productModelId: result.state.productModelId,
      worldModelId: result.state.worldModelId,
      sourceSnapshotId: result.state.sourceSnapshotId,
    },
    reviewDecision: result.reviewDecision ? {
      reviewDecisionId: result.reviewDecision.reviewDecisionId,
      disposition: result.reviewDecision.disposition,
      promotionAuthority: result.reviewDecision.promotionAuthority,
      resultingProductModelId: result.reviewDecision.resultingProductModelId || null,
    } : null,
    successorCandidateSet: result.candidateSet ? {
      candidateSetId: result.candidateSet.candidateSetId,
      candidateCount: result.candidateSet.candidates.length,
    } : null,
    productModelId: result.productModel?.productModelId || null,
    worldModel: result.worldModel,
    authorityEffect: result.reviewDecision?.promotionAuthority ? "explicit-product-canon-transition" : "none",
  };
}

function compactMarkdownBuild(result) {
  return {
    status: result.status,
    worldModelStatus: result.worldModelStatus,
    worldModelId: result.worldModelId,
    graphSnapshotId: result.graphSnapshotId,
    documentProjectionId: result.documentProjectionId,
    publishedPageCount: result.projection?.projection?.documents?.length || 0,
    authority: result.authority,
  };
}

function requireMcpConfirmation(value, message, code) {
  if (value === true) return;
  const error = new Error(message);
  error.code = code;
  throw error;
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
  return (await (await import("./lib/graphdb-projection-activation.mjs")).activateArcadeDbGraphProjection({ root: args.project_root, transport }));
}

async function continueSessionFromMcp(args, coordinationWorkspaceHost) {
  const continuation = await import("./lib/runtime-session-continuation.mjs");
  if (!coordinationWorkspaceHost) return continuation.continueSessionFromArtifacts({
    root: args.project_root, checkpointId: args.checkpoint_id || null, runtime: args.runtime,
  });
  // Restore P2 before consulting a Host. Endpoint availability is optional P5,
  // not recovery direction or a new role-binding/token ceremony.
  const restored = (await import("./lib/session-recovery.mjs")).restoreSessionFromArtifacts({
    root: args.project_root, checkpointId: args.checkpoint_id || null,
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
      boundary: { projectId: restored.projection.projectId, [restoredFormat.sessionIdField]: restored.projection.sessionId, role: "head", projectRoot: fs.realpathSync(path.resolve(args.project_root)) },
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

function localWorkerInput(args, start = false) {
  if (typeof args.project_root !== "string" || !args.project_root.trim()) throw new Error("An exact project_root is required.");
  const fields = start ? { authorization_id: "authorizationId", task_key: "taskKey", role: "role" }
    : { task: "task", task_key: "taskKey", role: "role", outcome: "outcome", selected_context: "selectedContext",
      source_paths: "sourcePaths", proposal_paths: "proposalPaths", model: "model", runtime: "runtime", timeout_ms: "timeoutMs", instruction_scope: "instructionScope", context_mode: "contextMode" };
  if (Object.keys(args).some(key => key !== "project_root" && !Object.hasOwn(fields, key))) throw new Error("Worker surface does not accept Host configuration.");
  return Object.fromEntries(Object.entries(args).filter(([key]) => key !== "project_root").map(([key, value]) => [fields[key], value]));
}

async function unresolvedSessionResponse(id, name, root, reasonCode) {
  try {
    const routing = await import("./lib/session-routing.mjs");
    const value = routing.sessionSelectionUnresolved(root, {
      includeProjectFacts: ["head_project_status", "head_conversation_enter"].includes(name), reasonCode,
    });
    // Keep the existing exceptional JSON-text + structuredContent contract.
    // Normal dispatch still uses each tool's own human/JSON presentation.
    return success(id, { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
  } catch (error) { return failure(id, error.message); }
}

async function preparedRuntimeRead(root, value) {
  // Primary selection/owner/hash errors have already escaped. Optional view
  // loading or historical-original failures cannot become execution gates.
  try { return (await import("./lib/runtime-prepared-input-view.mjs")).withPreparedRuntimeInputView({ root, value }); }
  catch { return { ...value, preparedInput: { kind: "PreparedRuntimeInputProjection", authorityPlane: "P4", status: "unavailable", reasonCode: "PREPARED_INPUT_VIEW_UNAVAILABLE",
    persisted: false, instructionAuthority: false, recoveryAuthority: false, executionAuthorization: false, modelUse: "unknown" } }; }
}

export async function dispatch(request, options = {}) {
  if (options.nativeSessionBridge && !options.sessionContext && !options.resolveSessionContext) {
    return options.nativeSessionBridge.dispatch(request, async (original, routing) => (await dispatchSessionRequest(original, { ...options, ...routing })));
  }
  return (await dispatchSessionRequest(request, options));
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
  }
  // Only views/effects that actually consume the selected Session need its
  // binding. Project-scoped Product/Observation/source work is independent.
  const dependent = sessionCallRequiresBinding(requestedName);
  let sessionContext = options.sessionContext;
  let bindingFailure = null;
  let relocationNeeded = false;
  if (request.method === "tools/call" && args?.project_root && requestedName === "head_project_status") {
    try {
      const { inspectProjectLocationExperience } = await import("./lib/project-bootstrap.mjs");
      const projectLocationProjection = inspectProjectLocationExperience({ root: args.project_root,
        sessionId: hasSelection ? args.session_id : undefined });
      if (projectLocationProjection) return (await dispatchRouted(request, { ...options, projectLocationProjection }));
    } catch (error) { return failure(request.id ?? null, error.message); }
  }
  if (request.method === "tools/call" && args?.project_root && requestedName === "head_project_initialize_or_resume") {
    try {
      if (hasSelection && typeof args.session_id !== "string") throw new Error("An explicit logical Session route must be text; omit it for an unspecified route.");
      const { resumeProjectLocation } = await import("./lib/project-relocation.mjs");
      const { validateRelocationSessionSelection } = await import("./lib/session-routing.mjs");
      relocationNeeded = Boolean(resumeProjectLocation({ root: args.project_root, pluginRoot, runtimes: args.runtimes ?? null, inspectOnly: true,
        validateSelection: owner => validateRelocationSessionSelection(owner, { sessionId: hasSelection ? args.session_id : undefined, context: sessionContext }) }));
    } catch (error) { return failure(request.id ?? null, error.message); }
  }
  // Explicit resume validates/adopts the local Project location before an
  // optional native Host adapter can read its binding at that current root.
  // Other tools retain the original selected-Session call boundary unchanged.
  if (request.method === "tools/call" && args?.project_root && requestedName === "head_project_initialize_or_resume"
    && relocationNeeded && (hasSelection || sessionContext || options.resolveSessionContext)) {
    try {
      if (hasSelection && typeof args.session_id !== "string") throw new Error("An explicit logical Session route must be text; omit it for an unspecified route.");
      const cleanArgs = { ...args }; delete cleanArgs.session_id;
      const clean = { ...request, params: { ...request.params, arguments: routed ? { ...outer, arguments: cleanArgs } : cleanArgs } };
      const response = await dispatchRouted(clean, { ...options, projectSessionRoute: {
        sessionId: hasSelection ? args.session_id : undefined, context: sessionContext,
        resolveContext: options.resolveSessionContext ? async () => {
          try { return await options.resolveSessionContext(request); }
          catch (error) { bindingFailure = error.code || "HEAD_SESSION_CONTEXT_UNAVAILABLE"; throw error; }
        } : null } });
      if (bindingFailure && hasSelection && response?.result) response.result._meta = { ...response.result._meta,
        headSessionBinding: { status: "unavailable", reasonCode: bindingFailure, scope: "current-explicit-request-only", retainedForSubsequentCalls: false, persisted: false } };
      return response;
    } catch (error) { return failure(request.id ?? null, error.message); }
  }
  // Discovery's existing session_id is an exact preview target, never a request
  // to update native persistence, a shared caller context, or the outer route.
  if (request.method === "tools/call" && requestedName === "head_session_list") return (await dispatchRouted(request, options));
  if (args?.project_root && (hasSelection || dependent) && !sessionContext && options.resolveSessionContext) {
    try { sessionContext = await options.resolveSessionContext(request); }
    catch (error) {
      if (hasSelection) {
        // Exact explicit routing is independent of optional Host persistence.
        // Existing route validation below still rejects invalid/foreign IDs.
        bindingFailure = error.code || "HEAD_SESSION_CONTEXT_UNAVAILABLE";
      } else {
        return (await unresolvedSessionResponse(request.id ?? null, requestedName, args.project_root, error.code || "HEAD_SESSION_CONTEXT_UNAVAILABLE"));
      }
    }
  }
  if (request.method === "tools/call" && args?.project_root && (hasSelection || sessionContext)) {
    try {
      const name = routed ? outer.name : request.params.name;
      const selected = allTools.find(tool => semanticToolName(tool.name) === semanticToolName(name));
      if (!selected?.inputSchema?.properties?.session_id) throw new Error("This operation has no project Session route.");
      if (hasSelection && typeof args.session_id !== "string") throw new Error("An explicit logical Session route must be text; omit it for an unspecified route.");
      const cleanArgs = { ...args }; delete cleanArgs.session_id;
      const clean = { ...request, params: { ...request.params, arguments: routed ? { ...outer, arguments: cleanArgs } : cleanArgs } };
      if (!hasSelection && !dependent) return (await dispatchRouted(clean, options));
      const { withSessionCallContext } = await import("./lib/session-routing.mjs");
      const response = await withSessionCallContext({ root: args.project_root, sessionId: hasSelection ? args.session_id : undefined, context: sessionContext }, async () => (await dispatchRouted(clean, options)));
      if (bindingFailure && response?.result) response.result._meta = { ...response.result._meta,
        headSessionBinding: { status: "unavailable", reasonCode: bindingFailure, scope: "current-explicit-request-only", retainedForSubsequentCalls: false, persisted: false } };
      return response;
    } catch (error) {
      if (error.code === "HEAD_SESSION_SELECTION_LOST") {
        return (await unresolvedSessionResponse(request.id ?? null, requestedName, args.project_root, error.code));
      }
      return failure(request.id ?? null, error.message);
    }
  }
  return (await dispatchRouted(request, options));
}

async function dispatchRouted(request, { surface = "ordinary", graphDbTransport = null, coordinationWorkspaceHost = null, observationRegistry = null, conformanceTriggerRegistry = null, compactionLifecycleHost = null, workerJobHost = null, workerJobSupervisor = null, workerPreparationBackend = null, signal, onProcess, onValidatedSessionSelection = null, readRelatedNativeContext = null, projectSessionRoute = null, projectLocationProjection = null, caller = null, hostEnvironment = process.env, pluginLaunch = null, servingModuleUrl = null, installationCaller = null } = {}) {
  requireSurface(surface);
  const id = request.id ?? null;
    if (request.method === "initialize") {
      return success(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: ARTIFACT_COMPOSITION.serverName, version: packageVersion }, instructions: coreEntryGuidance() });
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
      const selected = allTools.find(tool => semanticToolName(tool.name) === semanticToolName(args.name));
      const descriptor = resolveOperation(args.name);
      if (!selected || descriptor?.kind !== "operation" || !args.arguments || typeof args.arguments !== "object" || Array.isArray(args.arguments)
          || Object.keys(args).some(key => !["name", "arguments", ...(name === "head_tools_call" ? ["execution_mode"] : [])].includes(key))) throw new Error("An exact HEAD tool name and arguments object are required; routing cannot be nested.");
      if (args.execution_mode != null && !["ordinary", "managed"].includes(args.execution_mode)) throw new Error("Unknown execution mode.");
      if (name === "head_tools_call" && args.execution_mode === "managed") surface = "managed-maintenance";
      if (name === "head_tools_read" && selected.annotations?.readOnlyHint !== true) throw new Error("The selected tool is not read-only; use its declared effectful route within existing authority.");
      name = semanticToolName(selected.name);
      args = args.arguments;
    }
    requireOperationSurface(name, surface);
    const value = await (name === "head_run_start"
      ? (await import("./lib/run-lineage.mjs")).startRun({ root: args.project_root, executionContractId: args.execution_contract_id, startRequestId: args.start_request_id })
      : name === "head_core_contract"
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
        ? projectLocationProjection ?? (await (await import("./lib/project-bootstrap.mjs")).inspectProjectExperience({ root: args.project_root }))
      : name === "head_project_graph"
        ? (await (await import("./lib/project-graph.mjs")).queryProjectGraph({ root: args.project_root, query: args.query ?? "", view: args.view ?? "all",
          anchorIds: args.anchor_ids ?? [], paths: args.paths ?? [], depth: args.depth, details: args.details ?? false, maxNodes: args.max_nodes, maxEdges: args.max_edges,
          worldModelId: args.world_model_id ?? "", includeCandidates: args.include_candidates ?? true, previousResult: args.previous_result ?? null,
          inventoryPage: args.inventory_page === true, inventoryPaths: args.inventory_paths, inventoryCursor: args.inventory_cursor }))
      : name === "head_project_graph_index"
        ? (await import("./lib/project-graph.mjs")).indexProjectGraph({ root: args.project_root })
      : name === "head_session_create"
        ? (await import("./lib/session-routing.mjs")).createHeadSession({ root: args.project_root, sessionId: args.new_session_id, purpose: args.purpose })
      : name === "head_session_list"
        ? await (await import("./lib/session-work-context.mjs")).readSessionWorkList({ root: args.project_root,
          sessionId: args.session_id ?? null, maxSessions: args.max_sessions ?? 16, afterSessionId: args.after_session_id ?? null,
          conversationCandidates: args.conversation_candidates, conversationEnvironment: hostEnvironment })
      : name === "head_project_direction_read"
        ? (await import("./lib/session-routing.mjs")).readProjectDirection({ root: args.project_root })
      : name === "head_project_direction_update"
        ? (await import("./lib/session-routing.mjs")).updateProjectDirection({ root: args.project_root, expectedDirectionId: args.expected_direction_id, input: args.direction })
      : name === "head_onboarding_guide"
        ? (await (await import("./lib/onboarding-conversation.mjs")).inspectConversationalOnboarding({ root: args.project_root, candidateLimit: args.candidate_limit ?? 25 }))
      : name === "head_project_initialize_or_resume"
        ? (await initializeProjectFromMcp(args, { projectSessionRoute, onValidatedSessionSelection, pluginLaunch, servingModuleUrl, installationCaller }))
      : name === "head_onboarding_semantic_refresh"
        ? (await (await import("./lib/onboarding.mjs")).proposeOnboardingSemanticRefresh({ root: args.project_root, semanticProposal: args.semantic_proposal, recoveryBasis: args.recovery_basis || null }))
      : name === "head_onboarding_candidate_restore"
        ? (await import("./lib/onboarding.mjs")).restoreOnboardingCandidate({ root: args.project_root, candidateSetId: args.candidate_set_id, sourceContent: args.source_content, expectedRawHash: args.expected_raw_hash })
      : name === "head_onboarding_review"
        ? compactReviewResult(await (await import("./lib/onboarding.mjs")).reviewOnboarding({
          root: args.project_root,
          candidateSetId: args.candidate_set_id,
          disposition: args.disposition,
          acceptedCandidateIds: args.accepted_candidate_ids || [],
          removedCandidateIds: args.removed_candidate_ids || [],
          userEdits: (args.user_edits || []).map((edit) => ({ candidateId: edit.candidate_id, entity: edit.entity })),
          addedEntities: args.added_entities || [],
          rationale: args.rationale,
        }))
      : name === "head_product_policy_propose"
        ? (await (await import("./lib/product-policy.mjs")).proposeProductPolicy({
          root: args.project_root,
          operation: args.operation,
          key: args.key,
          name: args.name,
          description: args.description,
          statement: args.statement,
          appliesTo: args.applies_to,
          governedBy: args.governed_by,
          evidenceAnchors: args.evidence_anchors || [],
          explanation: args.explanation || "",
        }))
      : name === "head_product_policy_review"
        ? (await (await import("./lib/product-policy.mjs")).reviewProductPolicy({ root: args.project_root, candidateId: args.candidate_id, disposition: args.disposition, rationale: args.rationale }))
      : name === "head_product_policy_status"
        ? (await import("./lib/product-policy.mjs")).inspectProductPolicyStatus({ root: args.project_root, candidateId: args.candidate_id })
      : name === "head_product_policy_candidate"
        ? (await import("./lib/product-policy.mjs")).readProductPolicyCandidate({ root: args.project_root, candidateId: args.candidate_id })
      : name === "head_product_policy_review_decision"
        ? (await import("./lib/product-policy.mjs")).readProductPolicyReviewDecision({ root: args.project_root, reviewDecisionId: args.review_decision_id })
      : name === "head_metric_define"
        ? (await (await import("./lib/measurement-workflow.mjs")).defineMetric({ root: args.project_root, metricKey: args.metric_key, unit: args.unit, direction: args.direction, typeVersion: args.type_version || "1" }))
      : name === "head_metric_observe"
        ? (await (await import("./lib/measurement-workflow.mjs")).recordMetricObservation({
          root: args.project_root,
          metricKey: args.metric_key,
          typeVersion: args.type_version || "",
          subjectType: args.subject_type,
          subjectKey: args.subject_key,
          value: args.value,
          sampleSize: args.sample_size ?? null,
          form: args.form || "snapshot",
          observedAt: args.observed_at ?? null,
          start: args.start ?? null,
          end: args.end ?? null,
          coverage: args.coverage ? {
            state: args.coverage.state,
            basis: args.coverage.basis,
            queryDigest: args.coverage.query_digest,
            examinedCount: args.coverage.examined_count,
            sourceReportedTotal: args.coverage.source_reported_total,
            omittedCount: args.coverage.omitted_count,
            cursorStartDigest: args.coverage.cursor_start_digest,
            cursorEndDigest: args.coverage.cursor_end_digest,
          } : {},
          adapterKey: args.adapter_key,
          adapterVersion: args.adapter_version,
          sourceScopeDigest: args.source_scope_digest,
          sourceEventKeyDigest: args.source_event_key_digest,
          sourceEvidenceDigest: args.source_evidence_digest,
        }))
      : name === "head_metric_compare"
        ? (await (await import("./lib/measurement-workflow.mjs")).compareMetricObservations({ root: args.project_root, baselineObservationId: args.baseline_observation_id, currentObservationId: args.current_observation_id }))
      : name === "head_metric_assess"
        ? (await (await import("./lib/measurement-workflow.mjs")).assessMetricComparison({ root: args.project_root, comparisonObservationId: args.comparison_observation_id, assessment: args.assessment, statement: args.statement, rationale: args.rationale || "" }))
      : name === "head_metric_status"
        ? (await import("./lib/measurement-workflow.mjs")).inspectMeasurements({ root: args.project_root })
      : name === "head_metric_trace"
        ? (await (await import("./lib/measurement-workflow.mjs")).traceMeasurementLineage({ root: args.project_root, anchorId: args.anchor_id || "", metricKey: args.metric_key || "", typeVersion: args.type_version || "", depth: args.depth ?? 3, maxNodes: args.max_nodes ?? 128, maxEdges: args.max_edges ?? 256 }))
      : name === "head_delivery_observe"
        ? (await (await import("./lib/delivery-observation.mjs")).recordDeliveryObservation({
          root: args.project_root,
          environmentKey: args.environment_key,
          targetKey: args.target_key,
          artifactKey: args.artifact_key,
          revisionKey: args.revision_key,
          revisionDigest: args.revision_digest,
          outcome: args.outcome,
          sequence: args.sequence,
          predecessorObservationId: args.predecessor_observation_id ?? null,
          rollbackTargetObservationId: args.rollback_target_observation_id ?? null,
          observedAt: args.observed_at ?? null,
          sourceScopeDigest: args.source_scope_digest,
          sourceEventKeyDigest: args.source_event_key_digest,
          sourceEvidenceDigest: args.source_evidence_digest,
          adapterKey: args.adapter_key,
          adapterVersion: args.adapter_version,
          revisionReference: args.revision_reference ? {
            worldModelId: args.revision_reference.world_model_id,
            revisionId: args.revision_reference.revision_id,
            sourcePath: args.revision_reference.source_path,
            digest: args.revision_reference.digest,
          } : null,
        }))
      : name === "head_delivery_status"
        ? (await import("./lib/delivery-observation.mjs")).inspectDeliveryState({ root: args.project_root, environmentKey: args.environment_key || "", targetKey: args.target_key || "", historyLimit: args.history_limit ?? 100 })
      : name === "head_feature_mapping_propose"
        ? (await (await import("./lib/feature-mapping.mjs")).startFeatureMapping({ root: args.project_root, semanticProposal: featureMappingProposalFromMcp(args.semantic_proposal), expectedCandidateSetId: args.expected_candidate_set_id ?? null }))
      : name === "head_feature_mapping_review"
        ? (requireMcpConfirmation(args.confirm_user_review, "Feature mapping review requires explicit user confirmation.", "FEATURE_MAPPING_REVIEW_CONFIRMATION_REQUIRED"), (await (await import("./lib/feature-mapping.mjs")).reviewFeatureMapping({
          root: args.project_root,
          candidateSetId: args.candidate_set_id,
          disposition: args.disposition,
          acceptedCandidateIds: args.accepted_candidate_ids || [],
          rationale: args.rationale,
        })))
      : name === "head_markdown_projection_build"
        ? compactMarkdownBuild((await (await import("./lib/world-model.mjs")).materializeWorldMarkdownProjection({ root: args.project_root })))
      : name === "head_runtime_adapters"
          ? (await (await import("./lib/lode-core.mjs")).inspectRuntimeAdapters(args.project_root))
        : name === "head_runtime_invocation_authorization"
          ? await preparedRuntimeRead(args.project_root, (await import("./lib/runtime-invocation-lifecycle.mjs")).readRuntimeInvocationAuthorization({ root: args.project_root, authorizationId: args.authorization_id }))
        : name === "head_runtime_invocation_lease_status"
          ? (await import("./lib/runtime-invocation-lifecycle.mjs")).inspectRuntimeInvocationExecutionLease({ root: args.project_root, authorizationId: args.authorization_id })
        : name === "head_runtime_invocation_result"
          ? await runtimeResultFromMcp(args)
        : name === "head_onboarding_status"
          ? (await (await import("./lib/onboarding.mjs")).inspectOnboarding({ root: args.project_root }))
        : name === "head_feature_mapping_status"
          ? (await (await import("./lib/feature-mapping.mjs")).inspectFeatureMapping({ root: args.project_root }))
        : name === "head_change_set_status"
          ? (await (await import("./lib/change-set.mjs")).inspectChangeSets({ root: args.project_root }))
        : name === "head_vcs_evidence"
          ? (await import("./lib/change-set.mjs")).readVcsEvidence({ root: args.project_root, vcsEvidenceId: args.vcs_evidence_id })
        : name === "head_conformance_prepare"
          ? (await (await import("./lib/conformance-reconciliation.mjs")).prepareConformanceAssessment({ root: args.project_root, limit: args.limit ?? 32, projectionId: args.projection_id || "", cursor: args.cursor || "" }))
        : name === "head_conformance_propose"
          ? (await (await import("./lib/conformance-reconciliation.mjs")).proposeConformanceFindings({ root: args.project_root, baseline: conformanceBaselineFromMcp(args.baseline), findings: args.findings.map(conformanceFindingFromMcp) }))
        : name === "head_conformance_queue"
          ? (await (await import("./lib/conformance-reconciliation.mjs")).inspectConformanceQueue({ root: args.project_root, status: args.status || "all", riskHint: args.risk_hint || "", limit: args.limit ?? 25, projectionId: args.projection_id || "", cursor: args.cursor || "", canonAnchor: args.canon_anchor == null ? null : { entityKind: args.canon_anchor.entity_kind, entityKey: args.canon_anchor.entity_key } }))
        : name === "head_conformance_read"
          ? (await import("./lib/conformance-reconciliation.mjs")).readConformanceFinding({ root: args.project_root, findingId: args.finding_id })
        : name === "head_conformance_disposition"
          ? (await (await import("./lib/conformance-reconciliation.mjs")).recordConformanceDisposition({ root: args.project_root, findingId: args.finding_id, disposition: args.disposition, rationale: args.rationale, deferUntil: args.defer_until ?? null, resolutionId: args.resolution_id ?? null, confirmUserDisposition: args.confirm_user_disposition, actor: args.actor ?? "user" }))
        : name === "head_conformance_resolution_propose"
          ? (await (await import("./lib/conformance-reconciliation.mjs")).proposeConformanceResolution({ root: args.project_root, findingId: args.finding_id, baseline: conformanceBaselineFromMcp(args.baseline), evidenceAnchors: args.evidence_anchors.map(conformanceEvidenceAnchorFromMcp), assessment: args.assessment, rationale: args.rationale }))
        : name === "head_conformance_trigger_status"
          ? (conformanceTriggerRegistry ? conformanceTriggerRegistry.inspect({ root: args.project_root, sourceId: args.source_id }) : { status: "optional-host-adapter-unavailable", ordinaryWorkBlocked: false, authority: "P5-capability-disclosure-only" })
        : name === "head_conformance_trigger_prepare"
          ? (conformanceTriggerRegistry ? conformanceTriggerRegistry.prepare({ root: args.project_root, sourceId: args.source_id, limit: args.limit ?? 64 }) : { status: "optional-host-adapter-unavailable", ordinaryWorkBlocked: false, authority: "P5-capability-disclosure-only" })
        : name === "head_source_context"
          ? (await (await import("./lib/source-context-workflow.mjs")).prepareSourceContext({ root: args.project_root, task: args.task, needs: args.needs ?? [], retain: args.retain ?? false, budget: args.budget, timeoutMs: args.timeout_ms ?? 15_000, signal, onProcess }))
        : name === "head_source_observation_read"
          ? (await import("./lib/source-context-workflow.mjs")).inspectSourceObservation({ root: args.project_root, bundleKey: args.bundle_key, failureKey: args.failure_key })
        : name === "head_context_prepare"
          ? (await (await import("./lib/context-workflow.mjs")).prepareContextWorkflow({ root: args.project_root, task: args.task, budget: args.budget ?? DEFAULT_CONTEXT_BUDGET }))
        : name === "head_context_preview"
          ? (await (await import("./lib/context-workflow.mjs")).previewContextWorkflow({ root: args.project_root, task: args.task, budget: args.budget ?? DEFAULT_CONTEXT_BUDGET, evidenceNeeds: args.evidence_needs || [] }))
          : name === "head_context_capsule"
            ? (await import("./lib/context-compiler.mjs")).readContextCapsule({ root: args.project_root, capsuleId: args.capsule_id })
            : name === "head_lineage_artifact"
              ? (await import("./lib/execution-lineage.mjs")).readLineageArtifact({ root: args.project_root, artifactId: args.artifact_id })
              : name === "head_pending_review"
                ? (await import("./lib/run-lineage.mjs")).getPendingReviewContext({ root: args.project_root })
                : name === "head_checkpoint_basis"
                  ? (await import("./lib/compaction-recovery.mjs")).inspectRecoveryCheckpointBasis({ root: args.project_root })
                : name === "head_checkpoint_diagnose"
                  ? (await import("./lib/recovery-checkpoint-diagnosis.mjs")).inspectRecoveryCheckpointDiagnosis({ root: args.project_root })
                : name === "head_checkpoint_sync"
                  ? (await import("./lib/compaction-recovery.mjs")).syncRecoveryCheckpoint({
                      root: args.project_root,
                      expectedRecoveryBasisId: args.expected_recovery_basis_id,
                      purpose: args.purpose,
                      approvedDecisions: args.approved_decisions,
                      currentPosition: args.current_position,
                      nextExpectedResult: args.next_expected_result,
                      openReviewIds: args.open_review_ids || [],
                      ...(args.work_evidence !== undefined ? { workEvidence: args.work_evidence } : {}),
                    })
                : name === "head_session_work_record"
                  ? (await import("./lib/session-work-context.mjs")).recordSessionWorkEvidence({ root: args.project_root, input: args.evidence })
                : name === "head_session_work_read"
                  ? (await import("./lib/session-work-context.mjs")).readSessionWorkContext({ root: args.project_root,
                      evidenceIds: args.evidence_ids ?? null, afterEvidenceId: args.after_evidence_id ?? null, scanEvidence: args.scan_evidence ?? false,
                      maxRecords: args.max_records ?? 8, maxCharacters: args.max_characters ?? 32768,
                      todoId: args.todo_id ?? null, afterTodoId: args.after_todo_id ?? null, scanTodos: args.scan_todos ?? false })
                : name === "head_session_restore"
                  ? (await import("./lib/session-recovery.mjs")).restoreSessionFromArtifacts({ root: args.project_root, checkpointId: args.checkpoint_id || null })
                  : name === "head_session_continue"
                    ? (await continueSessionFromMcp(args, coordinationWorkspaceHost))
                    : name === "head_worker_integration"
                      ? await workerIntegrationFromMcp(args, onProcess)
                    : name === "head_worker_integration_status"
                      ? await workerIntegrationFromMcp(args, onProcess, true)
                    : name === "head_bounded_worker_prepare"
                      ? await (await import("./lib/local-worker-host.mjs")).prepareLocalBoundedWorker(localWorkerInput(args), { root: args.project_root, supervisorSelection: workerJobSupervisor, protocolFixtureBackend: workerPreparationBackend, signal, onProcess })
                    : name === "head_bounded_worker_start"
                      ? await (await import("./lib/local-worker-host.mjs")).startLocalBoundedWorker({ root: args.project_root, ...localWorkerInput(args, true) }, { host: workerJobHost, supervisorSelection: workerJobSupervisor, onProcess })
                    : name === "head_bounded_worker_job_status"
                      ? (await import("./lib/bounded-worker-job.mjs")).readBoundedWorkerJob({ root: args.project_root, authorizationId: args.authorization_id }, { onProcess, inspectorSelection: workerJobSupervisor })
                    : name === "head_bounded_worker_job_patch"
                      ? (await import("./lib/bounded-worker-job.mjs")).readBoundedWorkerPatch({ root: args.project_root, authorizationId: args.authorization_id }, { onProcess, inspectorSelection: workerJobSupervisor })
                    : name === "head_bounded_worker_cancel"
                      ? (await import("./lib/bounded-worker-job.mjs")).cancelBoundedWorkerJob({ root: args.project_root, authorizationId: args.authorization_id }, { onProcess, inspectorSelection: workerJobSupervisor })
                    : name === "head_bounded_worker_job_reconcile"
                      ? (await import("./lib/bounded-worker-job.mjs")).reconcileBoundedWorkerJob({ root: args.project_root, authorizationId: args.authorization_id }, { onProcess, inspectorSelection: workerJobSupervisor })
                    : name === "head_bounded_worker_reconcile"
                    ? (await import("./lib/runtime-invocation-lifecycle.mjs")).reconcileWorkerMember({ root: args.project_root, taskKey: args.task_key })
                  : name === "head_bounded_worker_dispatch"
                    ? (await import("./lib/bounded-worker-dispatch.mjs")).createBoundedWorkerDispatch({ root: args.project_root, authorizationId: args.authorization_id, role: args.role })
                  : name === "head_bounded_worker_status"
                    ? await preparedRuntimeRead(args.project_root, (await import("./lib/bounded-worker-dispatch.mjs")).readBoundedWorkerDispatch({ root: args.project_root, authorizationId: args.authorization_id }))
                  : name === "head_bounded_worker_wait"
                    ? await (await import("./lib/bounded-worker-dispatch.mjs")).waitForBoundedWorkerDispatch({ root: args.project_root, authorizationId: args.authorization_id, timeoutMs: args.wait_timeout_ms ?? 0 })
                  : name === "head_bounded_worker_apply_result"
                    ? (await import("./lib/bounded-worker-dispatch.mjs")).applyBoundedWorkerDispatchResult({ root: args.project_root, authorizationId: args.authorization_id })
                  : name === "head_bounded_worker_wave_create"
                    ? (await import("./lib/bounded-worker-wave.mjs")).createBoundedWorkerWave({ root: args.project_root, authorizationIds: args.authorization_ids })
                  : name === "head_bounded_worker_wave_read"
                    ? (await import("./lib/bounded-worker-wave.mjs")).readBoundedWorkerWave({ root: args.project_root, waveId: args.wave_id })
                  : name === "head_bounded_worker_wave_seal"
                    ? (await import("./lib/bounded-worker-wave.mjs")).sealBoundedWorkerWave({ root: args.project_root, waveId: args.wave_id })
                  : name === "head_bounded_worker_wave_status"
                    ? (await import("./lib/bounded-worker-wave.mjs")).readBoundedWorkerWaveStatus({ root: args.project_root, waveId: args.wave_id })
                  : name === "head_bounded_worker_wave_results"
                    ? (await import("./lib/bounded-worker-wave.mjs")).readBoundedWorkerWaveResults({ root: args.project_root, waveId: args.wave_id })
                  : name === "head_bounded_worker_wave_wait"
                    ? await (await import("./lib/bounded-worker-wave.mjs")).waitForBoundedWorkerWave({ root: args.project_root, waveId: args.wave_id, timeoutMs: args.wait_timeout_ms ?? 0 })
                  : name === "head_bounded_worker_wave_abandon"
                    ? (await import("./lib/bounded-worker-wave.mjs")).abandonBoundedWorkerWave({ root: args.project_root, waveId: args.wave_id, reasonCode: args.reason_code, reasonSummary: args.reason_summary || "" })
                  : name === "head_run_integrate_checkpoint"
                    ? (await import("./lib/session-recovery.mjs")).integrateReviewedRunCheckpoint({
                        root: args.project_root,
                        runId: args.run_id,
                        reviewDecisionId: args.review_decision_id,
                        purpose: args.purpose,
                        approvedDecisions: args.approved_decisions,
                        currentPosition: args.current_position,
                        nextExpectedResult: args.next_expected_result,
                        openReviewIds: args.open_review_ids || [],
                      })
                    : name === "head_run_integration"
                      ? (await import("./lib/session-recovery.mjs")).readRunResultIntegration({ root: args.project_root, reviewDecisionId: args.review_decision_id })
                : name === "head_world_model"
                  ? (await (await import("./lib/world-model.mjs")).inspectWorldModelStatus({ root: args.project_root }))
                  : name === "head_incremental_refresh_status"
                    ? (await (await import("./lib/incremental-refresh.mjs")).inspectIncrementalRefresh({ root: args.project_root }))
                    : name === "head_incremental_refresh_receipt"
                      ? (await (await import("./lib/incremental-refresh.mjs")).readIncrementalRefreshReceipt({ root: args.project_root, refreshReceiptId: args.refresh_receipt_id }))
                    : name === "head_refresh_trigger_status"
                      ? (await (await import("./lib/refresh-trigger.mjs")).inspectRefreshTriggers({ root: args.project_root }))
                    : name === "head_refresh_trigger_delivery"
                      ? (await (await import("./lib/refresh-trigger.mjs")).readRefreshTriggerDelivery({ root: args.project_root, triggerDeliveryId: args.trigger_delivery_id }))
                  : name === "head_graph_projection_status"
                    ? (await (await import("./lib/world-model.mjs")).inspectWorldGraphProjection({ root: args.project_root }))
                : name === "head_graphdb_projection_status"
                  ? (await (await import("./lib/graphdb-projection-activation.mjs")).inspectArcadeDbGraphProjectionStatus({ root: args.project_root, transport: graphDbTransport }))
                : name === "head_graphdb_database_status"
                  ? (await import("./lib/arcadedb-database-lifecycle.mjs")).inspectArcadeDbDatabaseCompatibility({ root: args.project_root, transport: graphDbTransport, storage: resolveProjectStorage(args.project_root) })
                : name === "head_graphdb_connection_preflight"
                  ? (await import("./lib/graphdb-projection-activation.mjs")).inspectArcadeDbCredentialPreflight({ root: args.project_root, transport: graphDbTransport, storage: resolveProjectStorage(args.project_root) })
                : name === "head_graphdb_database_initialize"
                  ? (await initializeGraphDbFromMcp(args, graphDbTransport))
                : name === "head_graphdb_projection_activate"
                  ? (await activateGraphDbFromMcp(args, graphDbTransport))
                : name === "head_markdown_projection_status"
                    ? (await (await import("./lib/world-model.mjs")).inspectWorldMarkdownProjection({ root: args.project_root }))
                  : name === "head_post_refresh_projection_status"
                    ? (await (await import("./lib/incremental-refresh.mjs")).inspectPostRefreshProjectionStatus({ root: args.project_root }))
                  : name === "head_post_refresh_projection_receipt"
                    ? (await (await import("./lib/incremental-refresh.mjs")).readPostRefreshProjectionReceipt({ root: args.project_root, postRefreshProjectionReceiptId: args.post_refresh_projection_receipt_id }))
                  : name === "head_document_change_candidates"
                    ? (await import("./lib/world-model.mjs")).readWorldDocumentChangeCandidateSet({ root: args.project_root, candidateSetId: args.candidate_set_id })
                  : name === "head_document_change_review_status"
                    ? (await (await import("./lib/document-change-review.mjs")).inspectDocumentChangeReviewStatus({ root: args.project_root, candidateSetId: args.candidate_set_id }))
                  : name === "head_document_change_review"
                    ? (await import("./lib/document-change-review.mjs")).readDocumentChangeReviewDecision({ root: args.project_root, reviewDecisionId: args.review_decision_id })
                  : name === "head_document_change_application"
                    ? (await import("./lib/document-change-review.mjs")).readDocumentChangeApplicationReceipt({ root: args.project_root, applicationReceiptId: args.application_receipt_id })
                  : name === "head_world_query"
                    ? (await (await import("./lib/world-model.mjs")).queryWorldModel({
                      root: args.project_root,
                      query: args.query,
                      depth: args.depth ?? 1,
                      maxResults: args.limit ?? 100,
                    }))
                    : name === "head_git_history"
                      ? (await (await import("./lib/world-model.mjs")).queryWorldHistory({
                        root: args.project_root,
                        query: args.query || "",
                        limit: args.limit ?? 50,
                      }))
                      : name === "head_temporal_graph"
                        ? (await (await import("./lib/world-model.mjs")).queryWorldTemporalGraph({
                          root: args.project_root,
                          query: args.query,
                          anchorIds: args.exact_anchor_ids || null,
                          expectedGraphSnapshotId: args.expected_graph_snapshot_id || null,
                          kinds: args.kinds || null,
                          relations: args.relation_types || null,
                          includeUnreviewedCandidates: args.include_unreviewed_candidates ?? false,
                          minConfidence: args.min_confidence ?? 0,
                          depth: args.depth ?? 1,
                          maxNodes: args.node_limit ?? 100,
                          maxEdges: args.edge_limit ?? 200,
                        }))
                        : name === "head_graph_lineage_status"
                          ? (await (await import("./lib/graph-lineage.mjs")).inspectGraphLineage({ root: args.project_root, cursor: args.cursor || "", limit: args.limit ?? 25 }))
                          : name === "head_graph_lineage_trace"
                            ? (await (await import("./lib/graph-lineage.mjs")).traceGraphLineage({
                              root: args.project_root,
                              worldModelId: args.world_model_id || "",
                              anchorId: args.anchor_id || "",
                              query: args.query || "",
                              depth: args.depth ?? 2,
                              maxNodes: args.node_limit ?? 100,
                              maxEdges: args.edge_limit ?? 200,
                              includeExecution: args.include_execution ?? true,
                            }))
                            : name === "head_graph_lineage_diff"
                              ? (await (await import("./lib/graph-lineage.mjs")).diffGraphLineage({ root: args.project_root, fromWorldModelId: args.from_world_model_id, toWorldModelId: args.to_world_model_id, limit: args.limit ?? 100, scopePaths: args.scope_paths ?? null, cursor: args.cursor || "" }))
                        : name === "head_runtime_state"
                          ? (await (await import("./lib/world-model.mjs")).queryWorldRuntimeState({
                            root: args.project_root,
                            query: args.query || "",
                            runtime: args.runtime || "",
                            state: args.state || "",
                            kind: args.kind || "",
                            limit: args.limit ?? 50,
                          }))
                          : name === "head_compact_prepare"
                            ? (await import("./lib/compaction-recovery.mjs")).prepareCompaction({ root: args.project_root, runtime: args.runtime || "manual", userTurnIdAtPrepare: args.user_turn_id_at_prepare, purpose: args.purpose, approvedDecisions: args.approved_decisions, currentPosition: args.current_position, nextExpectedResult: args.next_expected_result, openReviewIds: args.open_review_ids || [] })
                          : name === "head_compact_verify"
                            ? (await import("./lib/compaction-recovery.mjs")).verifyCompaction({ root: args.project_root, epochId: args.epoch_id, checkpointDigest: args.checkpoint_digest, currentUserTurnId: args.current_user_turn_id, providerCompacted: args.provider_compacted, recoverySource: args.recovery_source || "canonical-checkpoint" })
                          : name === "head_compact_continue"
                            ? (await import("./lib/compaction-recovery.mjs")).continueCompaction({ root: args.project_root, epochId: args.epoch_id, continuationToken: args.continuation_token, currentUserTurnId: args.current_user_turn_id })
                          : name === "head_compact_status"
                            ? (await import("./lib/compaction-recovery.mjs")).inspectCompaction({ root: args.project_root })
                          : name === "head_compact_abort"
                            ? (await import("./lib/compaction-recovery.mjs")).abortCompaction({ root: args.project_root, epochId: args.epoch_id, reason: args.reason })
                          : name === "head_conversation_enter"
                            ? (await (await import("./lib/compaction-lifecycle.mjs")).enterConversationRecovery({ root: args.project_root, readRelatedNativeContext }))
                          : name === "head_compaction_lifecycle_step"
                            ? (await (await import("./lib/compaction-lifecycle.mjs")).processCompactionLifecycle({
                              root: args.project_root,
                              hostAdapter: compactionLifecycleHost,
                              direction: args.direction == null ? null : {
                                purpose: args.direction.purpose,
                                approvedDecisions: args.direction.approved_decisions,
                                currentPosition: args.direction.current_position,
                                nextExpectedResult: args.direction.next_expected_result,
                                openReviewIds: args.direction.open_review_ids,
                              },
                            }))
                          : name === "head_product_signal_record"
                            ? (await (await import("./lib/product-operating-loop.mjs")).recordProductSignal({ root: args.project_root, statement: args.statement, observedAt: args.observed_at, source: args.source || "", evidenceIds: args.evidence_ids || [] }))
                          : name === "head_product_hypothesis_record"
                            ? (await (await import("./lib/product-operating-loop.mjs")).recordProductHypothesis({ root: args.project_root, statement: args.statement, rationale: args.rationale || "", signalIds: args.signal_ids || [], observationIds: args.observation_ids || [] }))
                          : name === "head_product_initiative_propose"
                            ? (await (await import("./lib/product-operating-loop.mjs")).proposeProductInitiative({ root: args.project_root, title: args.title, description: args.description || "", reasoning: args.reasoning || "", hypothesisIds: args.hypothesis_ids || [], featureResolution: args.feature_resolution == null ? null : productFeatureResolutionFromMcp(args.feature_resolution) }))
                          : name === "head_product_initiative_review"
                            ? (requireMcpConfirmation(args.confirm_user_review, "Product Initiative review requires explicit user confirmation.", "PRODUCT_INITIATIVE_REVIEW_CONFIRMATION_REQUIRED"), (await (await import("./lib/product-operating-loop.mjs")).reviewProductInitiative({ root: args.project_root, initiativeCandidateId: args.initiative_candidate_id, disposition: args.disposition, rationale: args.rationale, featureResolution: args.feature_resolution == null ? null : productFeatureResolutionFromMcp(args.feature_resolution) })))
                          : name === "head_product_outcome_observe"
                            ? (await (await import("./lib/product-operating-loop.mjs")).observeProductOutcome({ root: args.project_root, changeSetId: args.change_set_id, initiativeId: args.initiative_id || "", statement: args.statement, epistemicClass: args.epistemic_class || "observed-fact", evidenceIds: args.evidence_ids || [] }))
                          : name === "head_product_operating_status"
                            ? (await import("./lib/product-operating-loop.mjs")).inspectProductOperatingLoop({ root: args.project_root, fresh: args.fresh ?? false })
                          : name === "head_release_observe"
                            ? (requireMcpConfirmation(args.confirm_host_observation, "Release observation requires explicit confirmation that the payload came from a host deployment observer.", "RELEASE_HOST_OBSERVATION_CONFIRMATION_REQUIRED"), (await (await import("./lib/release-observation.mjs")).observeReleaseState({ root: args.project_root, input: { environmentKey: args.environment_key, status: args.status, commit: args.commit, observedAt: args.observed_at, sourceEventKeyDigest: args.source_event_key_digest, deploymentEvidenceDigest: args.deployment_evidence_digest, approved: args.approved, approvalEvidenceDigest: args.approval_evidence_digest, changeSetId: args.change_set_id, vcsEvidenceId: args.vcs_evidence_id } })))
                          : name === "head_release_status"
                            ? (await import("./lib/release-observation.mjs")).inspectReleaseObservations({ root: args.project_root })
                          : name === "head_observation_sources"
                            ? (await import("./lib/observation-adapter.mjs")).inspectObservationSources({ root: args.project_root, registry: observationRegistry, typeKey: args.type_key || "", adapterKey: args.adapter_key || "", availabilityState: args.availability || "", limit: args.limit ?? 64, projectionId: args.projection_id || "", cursor: args.cursor || "" })
                          : name === "head_observation_prepare"
                            ? (await import("./lib/observation-workflow.mjs")).prepareObservationEvidence({ root: args.project_root, registry: observationRegistry, typeKey: args.type_key, subjectType: args.subject_type || "", subjectKey: args.subject_key || "", adapterKey: args.adapter_key || "", observedAfter: args.observed_after || "", observedBefore: args.observed_before || "", existingLimit: args.existing_limit ?? 20, sourceLimit: args.source_limit ?? 20, sourceAvailability: args.source_availability || "", sourceProjectionId: args.source_projection_id || "", sourceCursor: args.source_cursor || "" })
                          : name === "head_observation_collect_source"
                            ? (await (await import("./lib/observation-adapter.mjs")).collectRegisteredObservation({ root: args.project_root, registry: observationRegistry, sourceId: args.source_id }))
                          : name === "head_observation_ingest"
                            ? (requireMcpConfirmation(args.confirm_host_observation, "Observation collection requires explicit confirmation that the payload came from the exact Host source binding.", "OBSERVATION_HOST_CONFIRMATION_REQUIRED"), (await (await import("./lib/observation-adapter.mjs")).ingestStructuredObservation({ root: args.project_root, binding: observationBindingFromMcp(args.binding), descriptor: observationDescriptorFromMcp(args.descriptor), input: observationInputFromMcp(args.observation) })))
                          : name === "head_observation_derive"
                            ? (requireMcpConfirmation(args.confirm_host_derivation, "Derived Observation recording requires explicit confirmation that the payload came from the named deterministic algorithm.", "OBSERVATION_DERIVATION_CONFIRMATION_REQUIRED"), (await import("./lib/observation-store.mjs")).recordDerivedObservation({ root: args.project_root, descriptor: observationDescriptorFromMcp(args.descriptor), input: { subject: args.subject, temporalScope: { observedAt: args.temporal_scope.observed_at, start: args.temporal_scope.start, end: args.temporal_scope.end }, inputObservationIds: args.input_observation_ids, algorithm: args.algorithm, coverage: observationCoverageFromMcp(args.coverage), payload: args.payload } }))
                          : name === "head_observation_read"
                            ? (await import("./lib/observation-store.mjs")).readObservation({ root: args.project_root, observationId: args.observation_id })
                          : name === "head_observation_query"
                            ? (await import("./lib/observation-projection.mjs")).queryObservations({ root: args.project_root, typeKey: args.type_key || "", subjectType: args.subject_type || "", subjectKey: args.subject_key || "", adapterKey: args.adapter_key || "", observedAfter: args.observed_after || "", observedBefore: args.observed_before || "", recordKind: args.record_kind || "all", limit: args.limit ?? 25, projectionId: args.projection_id || "", cursor: args.cursor || "" })
                          : name === "head_continuity_snapshot"
                            ? (await (await import("./lib/product-operating-loop.mjs")).buildHeadContinuitySnapshot({ root: args.project_root, fresh: args.fresh ?? false }))
                          : name === "head_conversation_list"
                            ? await (await import("./lib/conversation-messaging.mjs")).listProjectConversations({ root: args.project_root, caller, environment: hostEnvironment, hostTicket: args.host_ticket ?? null })
                          : name === "head_conversation_send"
                            ? await (await import("./lib/conversation-messaging.mjs")).sendProjectConversation({ root: args.project_root, caller, environment: hostEnvironment, to: args.to, body: args.body, replyTo: args.reply_to ?? null, hostTicket: args.host_ticket ?? null, waitMs: Number(hostEnvironment?.LODE_CONVERSATION_DELIVERY_WAIT_MS || 0) })
                          : (() => { throw new Error(`Unknown tool: ${name}`); })());
    // MCP structuredContent is an optional object, never null/array/scalar.
    // Keep absent originals as their original text value, not fabricated state.
    const response = success(id, { content: [{ type: "text", text: formatMcpToolContent(name, value) }],
      ...(value !== null && typeof value === "object" && !Array.isArray(value) ? { structuredContent: value } : {}) });
    if (name === "head_world_model" && Buffer.byteLength(JSON.stringify(response), "utf8") > WORLD_MODEL_STATUS_MCP_MAX_BYTES) {
      throw new Error(`head_world_model response exceeds ${WORLD_MODEL_STATUS_MCP_MAX_BYTES} bytes.`);
    }
    return response;
  } catch (error) {
    return failure(id, error.message);
  }
}

export function serveMcp({ surface = "ordinary", coordinationWorkspaceHost = null, observationRegistry = null, conformanceTriggerRegistry = null, compactionLifecycleHost = null, workerJobHost = null, workerJobSupervisor = null, sessionContext = null, resolveSessionContext = null, nativeSessionBridge, pluginLaunch = null } = {}) {
  requireSurface(surface);
  if (nativeSessionBridge === undefined) nativeSessionBridge = createNativeSessionHostBridge({ pluginLaunch, servingModuleUrl: import.meta.url });
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const sourceRequests = new Map();
  const abortSources = () => { for (const controller of sourceRequests.values()) controller.abort(); };
  let closing = false;
  const shutdown = () => { abortSources(); input.close(); };
  const cleanupSignals = () => {
    if (closing && !sourceRequests.size) { process.removeListener("SIGINT", shutdown); process.removeListener("SIGTERM", shutdown); }
  };
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
  input.once("close", () => { closing = true; abortSources(); nativeSessionBridge?.dispose?.(); cleanupSignals(); });
  input.on("line", async (line) => {
    if (!line.trim()) return;
    let response;
    let sourceRequestId, ownsSourceRequest = false;
    try {
      const request = JSON.parse(line);
      if (request.method === "notifications/cancelled") { sourceRequests.get(request.params?.requestId)?.abort(); return; }
      let controller;
      if (request.method === "tools/call" && requestedToolName(request) === "head_source_context") {
        sourceRequestId = request.id;
        if (sourceRequests.has(sourceRequestId)) throw new Error("Duplicate active source request id.");
        controller = new AbortController(); sourceRequests.set(sourceRequestId, controller); ownsSourceRequest = true;
      }
      response = await dispatch(request, { surface, coordinationWorkspaceHost, observationRegistry, conformanceTriggerRegistry, compactionLifecycleHost, workerJobHost, workerJobSupervisor, sessionContext, resolveSessionContext, nativeSessionBridge,
        signal: controller?.signal, onProcess: (event) => process.stderr.write(`${JSON.stringify({ sourceProcess: event })}\n`) });
    }
    catch (error) { response = failure(null, `Parse error: ${error.message}`); }
    finally { if (ownsSourceRequest) sourceRequests.delete(sourceRequestId); cleanupSignals(); }
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  });
  return input;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) serveMcp();

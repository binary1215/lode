// One operation registry for the MCP server (scripts/mcp-server.mjs) and the CLI
// (scripts/lode.mjs). Each entry is one operation:
//   name   the internal operation name (resolveOperation(name).semanticName);
//   tool   the MCP tool definition, listed by allTools at its original position;
//   mcp    args(arguments, context) -> the implementation's argument list, with
//          optional before/after adapters (see callRegistered);
//   cli    command (and aliases), the option names it reads, args(context) ->
//          argument list or handle(context), and optional before/after adapters;
//          a CLI-only entry is named "cli:<command>" and has no tool or mcp side;
//   impl   lazy loader of the scripts/lib implementation (absent when every
//          surface uses handle);
//   mcp.maxResponseBytes  optional cap on the formatted MCP response.
// Both surfaces call impl()(...args). Surface-specific defaults stay explicit in
// each args function (for example CLI numbers arrive as text). Operations not yet
// listed here keep their original MCP/CLI dispatch branches.
// test/dispatch-recordings.test.mjs pins the call each surface makes.
import path from "node:path";
import fs from "node:fs";
import { resolveOperation } from "../core/lode-operation-contract.mjs";
import { DEFAULT_CONTEXT_BUDGET } from "./context-budget.mjs";
import { resolveProjectStorage } from "../storage/project-storage-format.mjs";
import { workDocumentCompositionSchema, workDocumentTools } from "../world/work-document-surface.mjs";
import {
  conformanceBaselineSchema,
  conformanceEvidenceAnchorSchema,
  conformanceFindingInputSchema,
  observationBindingSchema,
  observationCoverageSchema,
  observationDescriptorSchema,
  observationInputSchema,
  onboardingSemanticProposalSchema,
  sessionWorkEvidenceSchema,
  workerIntegrationActionFields,
  workerIntegrationIdSchema,
  workerIntegrationOptionalFields,
  workerIntegrationVerificationIdSchema,
  workEvidenceText,
} from "../core/tool-schemas.mjs";
import {
  compactMarkdownBuild,
  compactReviewResult,
  conformanceBaselineFromMcp,
  conformanceEvidenceAnchorFromMcp,
  conformanceFindingFromMcp,
  featureMappingProposalFromMcp,
  localWorkerInput,
  observationBindingFromMcp,
  observationCoverageFromMcp,
  observationDescriptorFromMcp,
  observationInputFromMcp,
  preparedRuntimeRead,
  productFeatureResolutionFromMcp,
  requireMcpConfirmation,
  activateGraphDbFromMcp,
  continueSessionFromMcp,
  initializeGraphDbFromMcp,
  initializeProjectFromMcp,
  projectBundleFromMcp,
  projectNativeHistoryFromMcp,
  runtimeResultFromMcp,
  workerIntegrationFromMcp,
} from "./dispatch-adapters.mjs";

// head_world_model's formatted MCP response cap.
export const WORLD_MODEL_STATUS_MCP_MAX_BYTES = 4 * 1024 * 1024;

const waitTimeout = (options) => (options["wait-timeout-ms"] == null ? 0 : Number(options["wait-timeout-ms"]));

function onlyFields(input, allowed, label) {
  const permitted = new Set(allowed);
  const unexpected = Object.keys(input).filter((key) => !permitted.has(key));
  if (unexpected.length) throw new Error(`${label} contains unsupported fields: ${unexpected.sort().join(", ")}`);
  return input;
}

export const OPERATIONS = Object.freeze([
  {
    name: "lode_project_document_prepare",
    tool: workDocumentTools.find((tool) => tool.name === "lode_project_document_prepare"),
    mcp: { args: (args) => ["lode_project_document_prepare", args] },
    impl: () => import("../world/work-document-surface.mjs").then((module) => module.workDocumentFromMcp),
  },
  {
    name: "lode_project_document_publish",
    tool: workDocumentTools.find((tool) => tool.name === "lode_project_document_publish"),
    mcp: { args: (args) => ["lode_project_document_publish", args] },
    impl: () => import("../world/work-document-surface.mjs").then((module) => module.workDocumentFromMcp),
  },
  {
    name: "lode_project_document_status",
    cli: {
      command: "project-document-status",
      flags: [],
      handle: async (context) => {
        const { root } = context;
        return (await import("../storage/project-document-publication.mjs")).projectDocumentStatus({ root });
      },
    },
    tool: workDocumentTools.find((tool) => tool.name === "lode_project_document_status"),
    mcp: { args: (args) => ["lode_project_document_status", args] },
    impl: () => import("../world/work-document-surface.mjs").then((module) => module.workDocumentFromMcp),
  },
  {
    name: "lode_work_document_configure",
    tool: workDocumentTools.find((tool) => tool.name === "lode_work_document_configure"),
    mcp: { args: (args) => ["lode_work_document_configure", args] },
    impl: () => import("../world/work-document-surface.mjs").then((module) => module.workDocumentFromMcp),
  },
  {
    name: "lode_work_document_prepare",
    tool: workDocumentTools.find((tool) => tool.name === "lode_work_document_prepare"),
    mcp: { args: (args) => ["lode_work_document_prepare", args] },
    impl: () => import("../world/work-document-surface.mjs").then((module) => module.workDocumentFromMcp),
  },
  {
    name: "lode_work_document_publish",
    tool: workDocumentTools.find((tool) => tool.name === "lode_work_document_publish"),
    mcp: { args: (args) => ["lode_work_document_publish", args] },
    impl: () => import("../world/work-document-surface.mjs").then((module) => module.workDocumentFromMcp),
  },
  {
    name: "lode_work_document_status",
    cli: {
      command: "work-document-status",
      flags: ["logical-key"],
      handle: async (context) => {
        const { root, options } = context;
        return (await import("../world/work-document-publication.mjs")).workDocumentStatus({ root, logicalKey: options["logical-key"] });
      },
    },
    tool: workDocumentTools.find((tool) => tool.name === "lode_work_document_status"),
    mcp: { args: (args) => ["lode_work_document_status", args] },
    impl: () => import("../world/work-document-surface.mjs").then((module) => module.workDocumentFromMcp),
  },
  {
    name: "lode_core_contract",
    tool: {
      name: "lode_core_contract",
      description: "Read the active Lode Agent Core roles, runtimes, and capability boundary.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    mcp: {
      args: () => [],
      after: (value, args, { packageVersion }) => ({
        ...value,
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
      }),
    },
    impl: () => import("../core/core-contract.mjs").then((module) => module.coreContract),
  },
  {
    name: "lode_project_status",
    cli: {
      command: "status",
      aliases: ["doctor"],
      flags: [],
      handle: async (context) => {
        const { root } = context;
        const { inspectProjectExperience } = await import("./project-bootstrap.mjs");
        return await inspectProjectExperience({ root });
      },
    },
    tool: {
      name: "lode_project_status",
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
    mcp: {
      // A Project location projection prepared by the session router wins.
      handle: async (args, { projectLocationProjection }, call) => projectLocationProjection ?? (await call({ root: args.project_root })),
    },
    impl: () => import("./project-bootstrap.mjs").then((module) => module.inspectProjectExperience),
  },
  {
    name: "lode_onboarding_guide",
    tool: {
      name: "lode_onboarding_guide",
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
    mcp: { args: (args) => [{ root: args.project_root, candidateLimit: args.candidate_limit ?? 25 }] },
    impl: () => import("./onboarding-conversation.mjs").then((module) => module.inspectConversationalOnboarding),
  },
  {
    name: "lode_project_bundle_export",
    cli: {
      command: "project-export",
      flags: ["destination", "provenance", "sources"],
      handle: async (context) => {
        const { root, options, signal, onExportScope } = context;
        return (await import("../storage/project-portability.mjs")).exportProjectBundle({
          root,
          destination: options.destination,
          provenanceScope: options.provenance,
          sourceMode: options.sources,
          signal,
          onExportScope,
        });
      },
    },
    tool: {
      name: "lode_project_bundle_export",
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
    mcp: { handle: (args, { signal, onExportScope }) => projectBundleFromMcp("lode_project_bundle_export", args, signal, onExportScope) },
  },
  {
    name: "lode_project_bundle_read",
    cli: {
      command: "project-bundle-inspect",
      flags: ["expected-bundle", "handoff-max-bytes", "handoff-offset"],
      handle: async (context) => {
        const { root, options, signal } = context;
        const handoffOptions = {
          offset: options["handoff-offset"] === undefined ? 0 : Number(options["handoff-offset"]),
          maxBytes: options["handoff-max-bytes"] === undefined ? 65536 : Number(options["handoff-max-bytes"]),
        };
        if (!fs.lstatSync(root).isDirectory()) {
          if (options["expected-bundle"] !== undefined) throw new Error("A standalone Handoff has no verified bundle identity.");
          return (await import("./project-handoff.mjs")).readProjectHandoffFile({ file: root, ...handoffOptions, signal });
        }
        const core = await import("../storage/project-portability.mjs");
        return core.projectBundleSummary(
          core.inspectProjectBundle({ bundleRoot: root, expectedBundleId: options["expected-bundle"] ?? null, signal, handoffOptions }),
        );
      },
    },
    tool: {
      name: "lode_project_bundle_read",
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
    mcp: { handle: (args, { signal, onExportScope }) => projectBundleFromMcp("lode_project_bundle_read", args, signal, onExportScope) },
  },
  {
    name: "lode_project_bundle_import",
    cli: {
      command: "project-import",
      flags: ["bundle", "expected-bundle"],
      handle: async (context) => {
        const { root, options, signal, pluginRoot } = context;
        const result = (await import("../storage/project-portability.mjs")).importProjectBundle({
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
      },
    },
    tool: {
      name: "lode_project_bundle_import",
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
    mcp: { handle: (args, { signal, onExportScope }) => projectBundleFromMcp("lode_project_bundle_import", args, signal, onExportScope) },
  },
  {
    name: "lode_project_native_history",
    cli: {
      command: "project-native-history",
      flags: ["action", "companions", "executable", "expected-bundle", "native-home", "provider", "runtime-root", "threads"],
      handle: async (context) => {
        const { root, options, onProcess, signal, nativeHistoryHost, pluginRoot } = context;
        const allowed = new Set(["action", "provider", "native-home", "executable", "threads", "runtime-root", "expected-bundle", "companions"]);
        if (Object.keys(options).some((key) => !allowed.has(key))) throw new Error("Unsupported native history arguments.");
        return (await import("./project-native-history.mjs")).operateProjectNativeHistory({
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
      },
    },
    tool: {
      name: "lode_project_native_history",
      description:
        "Operate an explicitly selected same-platform native companion. read never starts a client and keeps Handoff/common recovery independent. capture requires provider; other actions derive it only from a verified link. Codex retains its pinned contract. Claude 2.1.223 restores exact files without overwriting conflicts; register optionally reads an installed SDK, never starts a model. OpenCode source capture still requires the current Host exact-ID export. Restore/register can use the fixed Windows x64 baseline 1.19.5 binary with an existing explicitly selected isolated DB, qualified schema/migrations and current Project mapping. All selected sessions/messages/parts publish in one transaction with source-bound field validation, global ID/ancestry checks and exact readback. No automatic DB initialization/migration, ordinary-profile fallback or default CLI bootstrap. A competing writer affects only native work; read-only clients need not stop. DB readback is distinct from official picker/model visibility. Claude/OpenCode effects require runtime_root; OpenCode source capture is Host-routed and does not accept source native_home/executable overrides. Missing tools/unsupported profiles limit native work only. Partial/uncertain effects are not automatically replayed; successful raw/history readback does not prove picker visibility, current model settings or continuation readiness. No model turn, app kill, configuration/credential migration or P2 authority; selected raw content is not redacted. Lode supplies verified selection and paths, not user JSON.",
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
    mcp: { handle: (args, { signal, nativeHistoryHost, onProcess }) => projectNativeHistoryFromMcp(args, signal, nativeHistoryHost, onProcess) },
  },
  {
    name: "lode_project_initialize_or_resume",
    cli: {
      command: "init",
      aliases: ["resume"],
      flags: ["copied-project", "input", "instruction-integration", "profile", "runtime", "write-root-instructions"],
      handle: async (context) => {
        const { root, options, projectSessionRoute, pluginRoot, inputJson } = context;
        const { initializeOrResumeProject } = await import("./project-bootstrap.mjs");
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
      },
    },
    tool: {
      name: "lode_project_initialize_or_resume",
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
              "Fresh Lode-authored P3 product candidates. Core verifies exact current source paths, digests, lines, optional symbols, bounds, and Product Model structure; it never treats the proposal as Product Canon or instruction authority.",
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
    mcp: {
      handle: (args, { projectSessionRoute, onValidatedSessionSelection, pluginLaunch, servingModuleUrl, installationCaller }) =>
        initializeProjectFromMcp(args, { projectSessionRoute, onValidatedSessionSelection, pluginLaunch, servingModuleUrl, installationCaller }),
    },
  },
  {
    name: "lode_onboarding_semantic_refresh",
    tool: {
      name: "lode_onboarding_semantic_refresh",
      description:
        "Create a fresh current P3 semantic onboarding proposal after a completed historical boundary. This creates only P3 candidates and continuity evidence; Product Canon changes only through a later explicit user ReviewDecision.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          semantic_proposal: onboardingSemanticProposalSchema,
          recovery_basis: {
            type: "object",
            properties: { pointerHash: { type: "string", pattern: "^[a-f0-9]{64}$" }, rawHash: { type: ["string", "null"], pattern: "^[a-f0-9]{64}$" } },
            required: ["pointerHash", "rawHash"],
            additionalProperties: false,
          },
        },
        required: ["project_root", "semantic_proposal"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root, semanticProposal: args.semantic_proposal, recoveryBasis: args.recovery_basis || null }] },
    cli: {
      command: "onboarding-semantic-refresh",
      flags: ["input"],
      args: ({ root, options, inputJson }) => {
        const input = inputJson(options, "Fresh onboarding semantic proposal");
        return [{ root, semanticProposal: input.semanticProposal || input, recoveryBasis: input.recoveryBasis || null }];
      },
    },
    impl: () => import("./onboarding.mjs").then((module) => module.proposeOnboardingSemanticRefresh),
  },
  {
    name: "lode_onboarding_candidate_restore",
    tool: {
      name: "lode_onboarding_candidate_restore",
      description:
        "Restore verified original candidate content after preserving damaged bytes. Changes no Canon, decision or P2 direction; Lode supplies exact observed raw hash, not a new user approval.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          candidate_set_id: { type: "string", pattern: "^onboarding-candidates-[a-f0-9]{24}$" },
          source_content: { type: "string", minLength: 1, maxLength: 8388608 },
          expected_raw_hash: { type: ["string", "null"], pattern: "^[a-f0-9]{64}$" },
        },
        required: ["project_root", "candidate_set_id", "source_content", "expected_raw_hash"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: {
      args: (args) => [
        { root: args.project_root, candidateSetId: args.candidate_set_id, sourceContent: args.source_content, expectedRawHash: args.expected_raw_hash },
      ],
    },
    cli: {
      command: "onboarding-candidate-restore",
      flags: ["input"],
      args: ({ root, options, inputJson }) => [{ ...inputJson(options, "Exact candidate restoration"), root }],
    },
    impl: () => import("./onboarding.mjs").then((module) => module.restoreOnboardingCandidate),
  },
  {
    name: "lode_onboarding_review",
    tool: {
      name: "lode_onboarding_review",
      description:
        "Apply one explicit user-authored ReviewDecision to the exact current onboarding candidate set. Accept dispositions may change Product Canon; revise and reject preserve candidate or canon boundaries enforced by Core.",
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
    mcp: {
      args: (args) => [
        {
          root: args.project_root,
          candidateSetId: args.candidate_set_id,
          disposition: args.disposition,
          acceptedCandidateIds: args.accepted_candidate_ids || [],
          removedCandidateIds: args.removed_candidate_ids || [],
          userEdits: (args.user_edits || []).map((edit) => ({ candidateId: edit.candidate_id, entity: edit.entity })),
          addedEntities: args.added_entities || [],
          rationale: args.rationale,
        },
      ],
      after: (value) => compactReviewResult(value),
    },
    cli: {
      command: "onboarding-review",
      flags: ["input"],
      args: ({ root, options, inputJson }) => [{ ...inputJson(options, "Onboarding ReviewDecision"), root }],
    },
    impl: () => import("./onboarding.mjs").then((module) => module.reviewOnboarding),
  },
  {
    name: "lode_product_policy_propose",
    tool: {
      name: "lode_product_policy_propose",
      description:
        "Record one immutable P3 Policy create, revise, or retire candidate against the exact current Product Canon. The provider Lode or user supplies meaning, explicit Feature or FeatureGroup applications, and optional exact Requirement, Constraint, or Decision references; Core never infers inheritance or promotes the candidate.",
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
            type: "array",
            maxItems: 256,
            uniqueItems: true,
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["Feature", "FeatureGroup"] },
                key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
              },
              required: ["kind", "key"],
              additionalProperties: false,
            },
          },
          governed_by: {
            type: "array",
            maxItems: 256,
            uniqueItems: true,
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["Requirement", "Constraint", "Decision"] },
                key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
              },
              required: ["kind", "key"],
              additionalProperties: false,
            },
          },
          evidence_anchors: {
            type: "array",
            maxItems: 32,
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["user-request", "source", "observation", "decision", "other"] },
                reference: { type: "string", minLength: 1, maxLength: 1024 },
                digest: { anyOf: [{ type: "string", pattern: "^[a-f0-9]{64}$" }, { type: "null" }] },
                summary: { type: "string", maxLength: 1000 },
              },
              required: ["kind", "reference"],
              additionalProperties: false,
            },
          },
          explanation: { type: "string", maxLength: 4000 },
        },
        required: ["project_root", "operation", "key"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: {
      args: (args) => [
        {
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
        },
      ],
    },
    cli: {
      command: "product-policy-propose",
      flags: ["input"],
      args: ({ root, options, inputJson }) => [{ ...inputJson(options, "Product Policy proposal"), root }],
    },
    impl: () => import("../world/product-policy.mjs").then((module) => module.proposeProductPolicy),
  },
  {
    name: "lode_product_policy_review",
    tool: {
      name: "lode_product_policy_review",
      description:
        "Record one explicit user ReviewDecision for an exact Policy candidate. Accept changes Product Canon only when the candidate base is still current and no Run authority is active; reject is nonblocking. Exact retries repair missing derived projections without a second decision.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          candidate_id: { type: "string", pattern: "^policy-candidate-[a-f0-9]{24}$" },
          disposition: { type: "string", enum: ["accept", "reject"] },
          rationale: { type: "string", minLength: 1, maxLength: 4000 },
        },
        required: ["project_root", "candidate_id", "disposition", "rationale"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root, candidateId: args.candidate_id, disposition: args.disposition, rationale: args.rationale }] },
    cli: {
      command: "product-policy-review",
      flags: ["input"],
      args: ({ root, options, inputJson }) => [{ ...inputJson(options, "Product Policy ReviewDecision"), root }],
    },
    impl: () => import("../world/product-policy.mjs").then((module) => module.reviewProductPolicy),
  },
  {
    name: "lode_product_policy_status",
    tool: {
      name: "lode_product_policy_status",
      description:
        "Read the exact Policy candidate, its optional ReviewDecision, and whether Canon is still at the candidate base or accepted result. This creates no state and never blocks ordinary work.",
      inputSchema: {
        type: "object",
        properties: { project_root: { type: "string", minLength: 1 }, candidate_id: { type: "string", pattern: "^policy-candidate-[a-f0-9]{24}$" } },
        required: ["project_root", "candidate_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root, candidateId: args.candidate_id }] },
    cli: { command: "product-policy-status", flags: ["candidate"], args: ({ root, options }) => [{ root, candidateId: options.candidate }] },
    impl: () => import("../world/product-policy.mjs").then((module) => module.inspectProductPolicyStatus),
  },
  {
    name: "lode_product_policy_candidate",
    tool: {
      name: "lode_product_policy_candidate",
      description: "Read and digest-verify one immutable P3 Product Policy candidate.",
      inputSchema: {
        type: "object",
        properties: { project_root: { type: "string", minLength: 1 }, candidate_id: { type: "string", pattern: "^policy-candidate-[a-f0-9]{24}$" } },
        required: ["project_root", "candidate_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root, candidateId: args.candidate_id }] },
    cli: { command: "product-policy-candidate-read", flags: ["candidate"], args: ({ root, options }) => [{ root, candidateId: options.candidate }] },
    impl: () => import("../world/product-policy.mjs").then((module) => module.readProductPolicyCandidate),
  },
  {
    name: "lode_product_policy_review_decision",
    tool: {
      name: "lode_product_policy_review_decision",
      description: "Read and digest-verify one exact Product Policy ReviewDecision and its candidate binding.",
      inputSchema: {
        type: "object",
        properties: { project_root: { type: "string", minLength: 1 }, review_decision_id: { type: "string", pattern: "^review-decision-[a-f0-9]{24}$" } },
        required: ["project_root", "review_decision_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root, reviewDecisionId: args.review_decision_id }] },
    cli: { command: "product-policy-review-read", flags: ["review"], args: ({ root, options }) => [{ root, reviewDecisionId: options.review }] },
    impl: () => import("../world/product-policy.mjs").then((module) => module.readProductPolicyReviewDecision),
  },
  {
    name: "lode_metric_define",
    tool: {
      name: "lode_metric_define",
      description: "Register a provider-neutral P3 metric data shape. This does not change Product Canon, execution authority, or recovery direction.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          metric_key: { type: "string", minLength: 1, maxLength: 128 },
          unit: { type: "string", minLength: 1, maxLength: 64 },
          direction: { type: "string", enum: ["increase", "decrease", "maintain"] },
          type_version: { type: "string", minLength: 1, maxLength: 64, default: "1" },
        },
        required: ["project_root", "metric_key", "unit", "direction"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: {
      args: (args) => [
        { root: args.project_root, metricKey: args.metric_key, unit: args.unit, direction: args.direction, typeVersion: args.type_version || "1" },
      ],
    },
    cli: { command: "metric-define", flags: ["input"], args: ({ root, options, inputJson }) => [{ ...inputJson(options, "Metric definition"), root }] },
    impl: () => import("../world/measurement-workflow.mjs").then((module) => module.defineMetric),
  },
  {
    name: "lode_metric_observe",
    tool: {
      name: "lode_metric_observe",
      description:
        "Record one exact P3 metric observation through the common Observation contract. Partial coverage is disclosed and remains usable evidence; it is never upgraded to complete.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          metric_key: { type: "string", minLength: 1, maxLength: 128 },
          type_version: { type: "string", minLength: 1, maxLength: 64 },
          subject_type: { type: "string", minLength: 1, maxLength: 192 },
          subject_key: { type: "string", minLength: 1, maxLength: 192 },
          value: { type: "number" },
          sample_size: { type: "integer", minimum: 0 },
          form: { type: "string", enum: ["snapshot", "aggregate"], default: "snapshot" },
          observed_at: { type: "string", minLength: 1 },
          start: { type: ["string", "null"] },
          end: { type: ["string", "null"] },
          coverage: {
            type: "object",
            properties: {
              state: { type: "string", enum: ["complete", "sampled", "partial", "unknown"] },
              basis: { type: "string", minLength: 1, maxLength: 128 },
              query_digest: { type: ["string", "null"], pattern: "^[a-f0-9]{64}$" },
              examined_count: { type: "integer", minimum: 0 },
              source_reported_total: { type: ["integer", "null"], minimum: 0 },
              omitted_count: { type: ["integer", "null"], minimum: 0 },
              cursor_start_digest: { type: ["string", "null"] },
              cursor_end_digest: { type: ["string", "null"] },
            },
            additionalProperties: false,
          },
          adapter_key: { type: "string", minLength: 1, maxLength: 192 },
          adapter_version: { type: "string", minLength: 1, maxLength: 64 },
          source_scope_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
          source_event_key_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
          source_evidence_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
        },
        required: [
          "project_root",
          "metric_key",
          "subject_type",
          "subject_key",
          "value",
          "source_scope_digest",
          "source_event_key_digest",
          "source_evidence_digest",
        ],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: {
      args: (args) => [
        {
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
          coverage: args.coverage
            ? {
                state: args.coverage.state,
                basis: args.coverage.basis,
                queryDigest: args.coverage.query_digest,
                examinedCount: args.coverage.examined_count,
                sourceReportedTotal: args.coverage.source_reported_total,
                omittedCount: args.coverage.omitted_count,
                cursorStartDigest: args.coverage.cursor_start_digest,
                cursorEndDigest: args.coverage.cursor_end_digest,
              }
            : {},
          adapterKey: args.adapter_key,
          adapterVersion: args.adapter_version,
          sourceScopeDigest: args.source_scope_digest,
          sourceEventKeyDigest: args.source_event_key_digest,
          sourceEvidenceDigest: args.source_evidence_digest,
        },
      ],
    },
    cli: { command: "metric-observe", flags: ["input"], args: ({ root, options, inputJson }) => [{ ...inputJson(options, "Metric observation"), root }] },
    impl: () => import("../world/measurement-workflow.mjs").then((module) => module.recordMetricObservation),
  },
  {
    name: "lode_metric_compare",
    tool: {
      name: "lode_metric_compare",
      description:
        "Create an exact P3 derived comparison between two compatible metric observations. The result preserves coverage disclosures and never claims causality.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          baseline_observation_id: { type: "string", minLength: 1 },
          current_observation_id: { type: "string", minLength: 1 },
        },
        required: ["project_root", "baseline_observation_id", "current_observation_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: {
      args: (args) => [{ root: args.project_root, baselineObservationId: args.baseline_observation_id, currentObservationId: args.current_observation_id }],
    },
    cli: { command: "metric-compare", flags: ["input"], args: ({ root, options, inputJson }) => [{ ...inputJson(options, "Metric comparison"), root }] },
    impl: () => import("../world/measurement-workflow.mjs").then((module) => module.compareMetricObservations),
  },
  {
    name: "lode_metric_assess",
    tool: {
      name: "lode_metric_assess",
      description:
        "Record a bounded P3 ProductHypothesis interpreting one exact metric comparison. Supports/contradicts/inconclusive are hypotheses, not causal findings or Canon changes.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          comparison_observation_id: { type: "string", minLength: 1 },
          assessment: { type: "string", enum: ["supports", "contradicts", "inconclusive"] },
          statement: { type: "string", minLength: 1, maxLength: 4000 },
          rationale: { type: "string", maxLength: 4000 },
        },
        required: ["project_root", "comparison_observation_id", "assessment", "statement"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: {
      args: (args) => [
        {
          root: args.project_root,
          comparisonObservationId: args.comparison_observation_id,
          assessment: args.assessment,
          statement: args.statement,
          rationale: args.rationale || "",
        },
      ],
    },
    cli: { command: "metric-assess", flags: ["input"], args: ({ root, options, inputJson }) => [{ ...inputJson(options, "Metric assessment"), root }] },
    impl: () => import("../world/measurement-workflow.mjs").then((module) => module.assessMetricComparison),
  },
  {
    name: "lode_metric_status",
    tool: {
      name: "lode_metric_status",
      description: "Read the nonblocking metric definitions, observation count, and comparison count. This creates no authority or state.",
      inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 } }, required: ["project_root"], additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root }] },
    cli: { command: "metric-status", flags: [], args: ({ root }) => [{ root }] },
    impl: () => import("../world/measurement-workflow.mjs").then((module) => module.inspectMeasurements),
  },
  {
    name: "lode_metric_trace",
    tool: {
      name: "lode_metric_trace",
      description:
        "Read one bounded P4 measurement lineage from an exact graph anchor or metric key through the verified prepared-traversal path. This writes no Canon, decision, or recovery state.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          anchor_id: { type: "string", minLength: 1 },
          metric_key: { type: "string", minLength: 1, maxLength: 128 },
          type_version: { type: "string", minLength: 1, maxLength: 64 },
          depth: { type: "integer", minimum: 0, maximum: 3, default: 3 },
          max_nodes: { type: "integer", minimum: 1, maximum: 500, default: 128 },
          max_edges: { type: "integer", minimum: 0, maximum: 1000, default: 256 },
        },
        required: ["project_root"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: {
      args: (args) => [
        {
          root: args.project_root,
          anchorId: args.anchor_id || "",
          metricKey: args.metric_key || "",
          typeVersion: args.type_version || "",
          depth: args.depth ?? 3,
          maxNodes: args.max_nodes ?? 128,
          maxEdges: args.max_edges ?? 256,
        },
      ],
    },
    cli: {
      command: "metric-trace",
      flags: ["anchor", "depth", "metric", "type-version"],
      args: ({ root, options }) => [
        {
          root,
          anchorId: options.anchor || "",
          metricKey: options.metric || "",
          typeVersion: options["type-version"] || "",
          depth: options.depth == null ? 3 : Number(options.depth),
        },
      ],
    },
    impl: () => import("../world/measurement-workflow.mjs").then((module) => module.traceMeasurementLineage),
  },
  {
    name: "lode_delivery_observe",
    tool: {
      name: "lode_delivery_observe",
      description:
        "Record one provider-neutral P3 delivery event for an exact environment and target. This adds no deployment action or approval gate; failures do not overwrite prior success, and an optional World revision binding is mechanically verified.",
      inputSchema: {
        type: "object",
        properties: {
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
          revision_reference: {
            type: "object",
            properties: {
              world_model_id: { type: "string", pattern: "^world-model-[a-f0-9]{24}$" },
              revision_id: { type: "string", pattern: "^file-revision-[a-f0-9]{24}$" },
              source_path: { type: "string", minLength: 1, maxLength: 4096 },
              digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
            },
            required: ["world_model_id", "revision_id", "source_path", "digest"],
            additionalProperties: false,
          },
        },
        required: [
          "project_root",
          "environment_key",
          "target_key",
          "artifact_key",
          "revision_key",
          "revision_digest",
          "outcome",
          "sequence",
          "source_scope_digest",
          "source_event_key_digest",
          "source_evidence_digest",
        ],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    mcp: {
      args: (args) => [
        {
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
          revisionReference: args.revision_reference
            ? {
                worldModelId: args.revision_reference.world_model_id,
                revisionId: args.revision_reference.revision_id,
                sourcePath: args.revision_reference.source_path,
                digest: args.revision_reference.digest,
              }
            : null,
        },
      ],
    },
    cli: { command: "delivery-observe", flags: ["input"], args: ({ root, options, inputJson }) => [{ ...inputJson(options, "Delivery observation"), root }] },
    impl: () => import("../world/delivery-observation.mjs").then((module) => module.recordDeliveryObservation),
  },
  {
    name: "lode_delivery_status",
    tool: {
      name: "lode_delivery_status",
      description:
        "Read a bounded non-persisted P4 current-and-history delivery projection. Explicit sequence and predecessor evidence determine current state; receipt time, failed attempts, and unobserved targets never imply success.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          environment_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
          target_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
          history_limit: { type: "integer", minimum: 1, maximum: 4096, default: 100 },
        },
        required: ["project_root"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: {
      args: (args) => [
        { root: args.project_root, environmentKey: args.environment_key || "", targetKey: args.target_key || "", historyLimit: args.history_limit ?? 100 },
      ],
    },
    cli: {
      command: "delivery-status",
      flags: ["environment", "history-limit", "target"],
      args: ({ root, options }) => [
        {
          root,
          environmentKey: options.environment || "",
          targetKey: options.target || "",
          historyLimit: options["history-limit"] == null ? 100 : Number(options["history-limit"]),
        },
      ],
    },
    impl: () => import("../world/delivery-observation.mjs").then((module) => module.inspectDeliveryState),
  },
  {
    name: "lode_markdown_projection_build",
    tool: {
      name: "lode_markdown_projection_build",
      description:
        "Build or verify the deterministic local Markdown projection from the current verified GraphSnapshot. The generated view is rebuildable, non-authoritative, and never changes Product Canon.",
      inputSchema: {
        type: "object",
        properties: { project_root: { type: "string", minLength: 1 } },
        required: ["project_root"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root }], after: (value) => compactMarkdownBuild(value) },
    cli: { command: "world-docs-build", flags: [], args: ({ root }) => [{ root }] },
    impl: () => import("../world/world-model.mjs").then((module) => module.materializeWorldMarkdownProjection),
  },
  {
    name: "lode_runtime_adapters",
    tool: {
      name: "lode_runtime_adapters",
      description:
        "Inspect provider-neutral runtime contracts, privacy-bounded executable discovery, fixed non-session version and protocol/capability evidence, and Lode project/session capability binding without creating or controlling a provider session.",
      inputSchema: {
        type: "object",
        properties: { project_root: { type: "string", minLength: 1 } },
        required: ["project_root"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [args.project_root] },
    cli: { command: "runtime-adapters", flags: [], args: ({ root }) => [root] },
    impl: () => import("./lode-core.mjs").then((module) => module.inspectRuntimeAdapters),
  },
  {
    name: "lode_runtime_invocation_authorization",
    tool: {
      name: "lode_runtime_invocation_authorization",
      description:
        "Read and digest-verify one Session- or Run-scoped ExecutionAuthorization. A read-only historical view checks retained original input references and canonical bytes/digest where available; preparation does not prove delivery or model use. No provider invocation or current execution permission.",
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
    mcp: {
      args: (args) => [{ root: args.project_root, authorizationId: args.authorization_id }],
      after: (value, args) => preparedRuntimeRead(args.project_root, value),
    },
    cli: {
      command: "runtime-invocation-read",
      flags: ["authorization"],
      args: ({ root, options }) => [{ root, authorizationId: options.authorization }],
      after: (value, { root }) => preparedRuntimeRead(root, value),
    },
    impl: () => import("../runtime/runtime-invocation-lifecycle.mjs").then((module) => module.readRuntimeInvocationAuthorization),
  },
  {
    name: "lode_runtime_invocation_lease_status",
    tool: {
      name: "lode_runtime_invocation_lease_status",
      description:
        "Read the durable at-most-once consumption and exact-owner release status for one runtime invocation authorization without claiming, replaying, or controlling a provider.",
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
    mcp: { args: (args) => [{ root: args.project_root, authorizationId: args.authorization_id }] },
    cli: {
      command: "runtime-invocation-lease-status",
      flags: ["authorization"],
      args: ({ root, options }) => [{ root, authorizationId: options.authorization }],
    },
    impl: () => import("../runtime/runtime-invocation-lifecycle.mjs").then((module) => module.inspectRuntimeInvocationExecutionLease),
  },
  {
    name: "lode_runtime_invocation_result",
    cli: {
      command: "runtime-invocation-result",
      flags: ["authorization"],
      handle: async (context) => {
        const { root, options } = context;
        const { resolveProjectStorage } = await import("../storage/project-storage-format.mjs");
        const { validateRuntimeInvocationRecordIdentity } = await import("../runtime/runtime-invocation-record.mjs");
        const { readRuntimeInvocationResult } = await import("../runtime/runtime-run-result-application.mjs");
        validateRuntimeInvocationRecordIdentity(options.authorization);
        return readRuntimeInvocationResult({ root, authorizationId: options.authorization, storage: resolveProjectStorage(root) });
      },
    },
    tool: {
      name: "lode_runtime_invocation_result",
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
    mcp: { handle: (args) => runtimeResultFromMcp(args) },
  },
  {
    name: "lode_onboarding_status",
    tool: {
      name: "lode_onboarding_status",
      description:
        "Read and digest-verify the project-scoped onboarding state, current candidate batch, storage selection, Product Canon identity, and local World Model status without promoting candidates or mutating project state.",
      inputSchema: {
        type: "object",
        properties: { project_root: { type: "string", minLength: 1 } },
        required: ["project_root"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root }] },
    cli: { command: "onboarding-status", flags: [], args: ({ root }) => [{ root }] },
    impl: () => import("./onboarding.mjs").then((module) => module.inspectOnboarding),
  },
  {
    name: "lode_feature_mapping_propose",
    tool: {
      name: "lode_feature_mapping_propose",
      description:
        "Normalize one fresh Lode semantic proposal for exact Product-to-code or Product-to-test mapping candidates. Core verifies current graph endpoints and records only P3 candidates; it does not infer mappings from lexical overlap or create reviewed relationships.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          expected_candidate_set_id: {
            type: "string",
            pattern: "^feature-mapping-candidates-[a-f0-9]{24}$",
            description: "Explicitly replace this exact pending unreviewed batch with fresh evidence; never replaces a durable user decision.",
          },
          semantic_proposal: {
            type: "object",
            properties: {
              schema_version: { const: 1 },
              source_snapshot_id: { type: "string", pattern: "^source-snapshot-[a-f0-9]{24}$" },
              product_model_id: { type: "string", pattern: "^product-model-[a-f0-9]{24}$" },
              candidates: {
                type: "array",
                minItems: 1,
                maxItems: 500,
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
    mcp: {
      args: (args) => [
        {
          root: args.project_root,
          semanticProposal: featureMappingProposalFromMcp(args.semantic_proposal),
          expectedCandidateSetId: args.expected_candidate_set_id ?? null,
        },
      ],
    },
    cli: {
      command: "feature-mapping-start",
      flags: ["expected-candidate-set", "input"],
      args: ({ root, options, inputJson }) => [
        {
          root,
          semanticProposal: options.input ? inputJson(options, "Feature mapping semantic proposal") : null,
          expectedCandidateSetId: options["expected-candidate-set"] ?? null,
        },
      ],
    },
    impl: () => import("../world/feature-mapping.mjs").then((module) => module.startFeatureMapping),
  },
  {
    name: "lode_feature_mapping_status",
    tool: {
      name: "lode_feature_mapping_status",
      description:
        "Read and digest-verify the current Feature mapping candidate batch or explicit reviewed relationship decision without creating or promoting mappings.",
      inputSchema: {
        type: "object",
        properties: { project_root: { type: "string", minLength: 1 } },
        required: ["project_root"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root }] },
    cli: { command: "feature-mapping-status", flags: [], args: ({ root }) => [{ root }] },
    impl: () => import("../world/feature-mapping.mjs").then((module) => module.inspectFeatureMapping),
  },
  {
    name: "lode_feature_mapping_review",
    tool: {
      name: "lode_feature_mapping_review",
      description:
        "Record one explicit user-authored ReviewDecision for the exact current Feature mapping candidate set. This requires explicit confirmation; only accepted candidates create separate reviewed relationships, and Product Canon remains unchanged.",
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
    mcp: {
      before: (args) =>
        requireMcpConfirmation(
          args.confirm_user_review,
          "Feature mapping review requires explicit user confirmation.",
          "FEATURE_MAPPING_REVIEW_CONFIRMATION_REQUIRED",
        ),
      args: (args) => [
        {
          root: args.project_root,
          candidateSetId: args.candidate_set_id,
          disposition: args.disposition,
          acceptedCandidateIds: args.accepted_candidate_ids || [],
          rationale: args.rationale,
        },
      ],
    },
    cli: {
      command: "feature-mapping-review",
      flags: ["input"],
      args: ({ root, options, inputJson }) => [{ ...inputJson(options, "Feature mapping ReviewDecision"), root }],
    },
    impl: () => import("../world/feature-mapping.mjs").then((module) => module.reviewFeatureMapping),
  },
  {
    name: "lode_change_set_status",
    tool: {
      name: "lode_change_set_status",
      description:
        "Read and digest-verify the current provider-neutral ChangeSet, Feature impact state, and optional VCS evidence without mutating project state.",
      inputSchema: {
        type: "object",
        properties: { project_root: { type: "string", minLength: 1 } },
        required: ["project_root"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root }] },
    cli: { command: "change-set-status", flags: [], args: ({ root }) => [{ root }] },
    impl: () => import("../world/change-set.mjs").then((module) => module.inspectChangeSets),
  },
  {
    name: "lode_vcs_evidence",
    tool: {
      name: "lode_vcs_evidence",
      description:
        "Read and digest-verify one optional VCS evidence attachment and its immutable Git commit observations without treating commits as ChangeSet or project authority.",
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
    mcp: { args: (args) => [{ root: args.project_root, vcsEvidenceId: args.vcs_evidence_id }] },
    cli: { command: "change-set-vcs-read", flags: ["vcs-evidence"], args: ({ root, options }) => [{ root, vcsEvidenceId: options["vcs-evidence"] }] },
    impl: () => import("../world/change-set.mjs").then((module) => module.readVcsEvidence),
  },
  {
    name: "lode_conformance_prepare",
    tool: {
      name: "lode_conformance_prepare",
      description:
        "Prepare bounded current Product Canon and optional World identities for provider Lode semantic drift analysis. The user supplies no JSON or graph IDs; Core chooses no meaning, writes nothing, and never blocks ordinary work.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          limit: { type: "integer", minimum: 1, maximum: 64, default: 32 },
          projection_id: { type: "string" },
          cursor: { type: "string" },
        },
        required: ["project_root"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root, limit: args.limit ?? 32, projectionId: args.projection_id || "", cursor: args.cursor || "" }] },
    cli: {
      command: "conformance-prepare",
      flags: ["cursor", "limit", "projection"],
      args: ({ root, options }) => [
        { root, limit: options.limit == null ? 32 : Number(options.limit), projectionId: options.projection || "", cursor: options.cursor || "" },
      ],
    },
    impl: () => import("../runtime/conformance-reconciliation.mjs").then((module) => module.prepareConformanceAssessment),
  },
  {
    name: "lode_conformance_propose",
    tool: {
      name: "lode_conformance_propose",
      description:
        "Record one or more provider-Lode semantic Conformance candidates only after Core verifies exact current Canon and evidence anchors. Candidates are P3 evidence, never violations, decisions, execution authority, recovery direction, or ordinary-work gates.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          baseline: conformanceBaselineSchema,
          findings: { type: "array", minItems: 1, maxItems: 64, items: conformanceFindingInputSchema },
        },
        required: ["project_root", "baseline", "findings"],
        additionalProperties: false,
      },
    },
    mcp: {
      args: (args) => [
        { root: args.project_root, baseline: conformanceBaselineFromMcp(args.baseline), findings: args.findings.map(conformanceFindingFromMcp) },
      ],
    },
    cli: {
      command: "conformance-propose",
      flags: ["input"],
      args: ({ root, options, inputJson }) => [{ ...inputJson(options, "Conformance provider-Lode proposal"), root }],
    },
    impl: () => import("../runtime/conformance-reconciliation.mjs").then((module) => module.proposeConformanceFindings),
  },
  {
    name: "lode_conformance_queue",
    tool: {
      name: "lode_conformance_queue",
      description:
        "Read a bounded, paginated P4 Conformance queue. Missing Graph or optional sources, partial coverage, risk hints, and open findings never block ordinary work.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          canon_anchor: conformanceFindingInputSchema.properties.canon_anchor,
          status: {
            type: "string",
            enum: [
              "all",
              "open",
              "acknowledged",
              "deferred",
              "action-requested",
              "needs-recheck",
              "resolution-proposed",
              "closed-dismissed",
              "closed-resolved",
            ],
            default: "all",
          },
          risk_hint: { type: "string", enum: ["", "unknown", "low", "medium", "high"], default: "" },
          limit: { type: "integer", minimum: 1, maximum: 64, default: 25 },
          projection_id: { type: "string" },
          cursor: { type: "string", pattern: "^conformance-finding-[a-f0-9]{24}$" },
        },
        required: ["project_root"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: {
      args: (args) => [
        {
          root: args.project_root,
          status: args.status || "all",
          riskHint: args.risk_hint || "",
          limit: args.limit ?? 25,
          projectionId: args.projection_id || "",
          cursor: args.cursor || "",
          canonAnchor: args.canon_anchor == null ? null : { entityKind: args.canon_anchor.entity_kind, entityKey: args.canon_anchor.entity_key },
        },
      ],
    },
    cli: {
      command: "conformance-queue",
      flags: ["canon-key", "canon-kind", "cursor", "limit", "projection", "risk-hint", "status"],
      args: ({ root, options }) => [
        {
          root,
          status: options.status || "all",
          riskHint: options["risk-hint"] || "",
          limit: options.limit == null ? 25 : Number(options.limit),
          projectionId: options.projection || "",
          cursor: options.cursor || "",
          canonAnchor:
            options["canon-kind"] != null || options["canon-key"] != null ? { entityKind: options["canon-kind"], entityKey: options["canon-key"] } : null,
        },
      ],
    },
    impl: () => import("../runtime/conformance-reconciliation.mjs").then((module) => module.inspectConformanceQueue),
  },
  {
    name: "lode_conformance_read",
    tool: {
      name: "lode_conformance_read",
      description: "Read and digest-verify one exact Conformance Finding, its non-authoritative resolutions, and exact-finding dispositions.",
      inputSchema: {
        type: "object",
        properties: { project_root: { type: "string", minLength: 1 }, finding_id: { type: "string", pattern: "^conformance-finding-[a-f0-9]{24}$" } },
        required: ["project_root", "finding_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root, findingId: args.finding_id }] },
    cli: { command: "conformance-read", flags: ["finding"], args: ({ root, options }) => [{ root, findingId: options.finding }] },
    impl: () => import("../runtime/conformance-reconciliation.mjs").then((module) => module.readConformanceFinding),
  },
  {
    name: "lode_conformance_disposition",
    tool: {
      name: "lode_conformance_disposition",
      description:
        "Record a disposition for one exact Finding. Lode may acknowledge/defer with actor=head without user confirmation, but cannot supersede user dispositions or close findings. User dispositions require explicit confirmation. Neither path authorizes execution, mutates Canon, or writes recovery direction.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          finding_id: { type: "string", pattern: "^conformance-finding-[a-f0-9]{24}$" },
          disposition: { type: "string", enum: ["acknowledge", "defer", "dismiss", "request-code-fix", "request-canon-revision", "accept-resolution"] },
          rationale: { type: "string", minLength: 1 },
          defer_until: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
          resolution_id: { anyOf: [{ type: "string", pattern: "^conformance-resolution-[a-f0-9]{24}$" }, { type: "null" }] },
          actor: { type: "string", enum: ["user", "head"], default: "user" },
          confirm_user_disposition: { type: "boolean", default: false },
        },
        required: ["project_root", "finding_id", "disposition", "rationale"],
        additionalProperties: false,
      },
    },
    mcp: {
      args: (args) => [
        {
          root: args.project_root,
          findingId: args.finding_id,
          disposition: args.disposition,
          rationale: args.rationale,
          deferUntil: args.defer_until ?? null,
          resolutionId: args.resolution_id ?? null,
          confirmUserDisposition: args.confirm_user_disposition,
          actor: args.actor ?? "user",
        },
      ],
    },
    cli: {
      command: "conformance-disposition",
      flags: ["input"],
      args: ({ root, options, inputJson }) => [{ ...inputJson(options, "Conformance user disposition"), root }],
    },
    impl: () => import("../runtime/conformance-reconciliation.mjs").then((module) => module.recordConformanceDisposition),
  },
  {
    name: "lode_conformance_resolution_propose",
    tool: {
      name: "lode_conformance_resolution_propose",
      description:
        "Record a provider-Lode resolution candidate against a fresh exact baseline. It does not close the Finding; only a later explicit exact-finding disposition can do so.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          finding_id: { type: "string", pattern: "^conformance-finding-[a-f0-9]{24}$" },
          baseline: conformanceBaselineSchema,
          evidence_anchors: { type: "array", minItems: 1, maxItems: 64, items: conformanceEvidenceAnchorSchema },
          assessment: { type: "string", enum: ["appears-resolved", "still-present", "uncertain"] },
          rationale: { type: "string", minLength: 1 },
        },
        required: ["project_root", "finding_id", "baseline", "evidence_anchors", "assessment", "rationale"],
        additionalProperties: false,
      },
    },
    mcp: {
      args: (args) => [
        {
          root: args.project_root,
          findingId: args.finding_id,
          baseline: conformanceBaselineFromMcp(args.baseline),
          evidenceAnchors: args.evidence_anchors.map(conformanceEvidenceAnchorFromMcp),
          assessment: args.assessment,
          rationale: args.rationale,
        },
      ],
    },
    cli: {
      command: "conformance-resolution-propose",
      flags: ["input"],
      args: ({ root, options, inputJson }) => [{ ...inputJson(options, "Conformance provider-Lode resolution"), root }],
    },
    impl: () => import("../runtime/conformance-reconciliation.mjs").then((module) => module.proposeConformanceResolution),
  },
  {
    name: "lode_conformance_trigger_status",
    tool: {
      name: "lode_conformance_trigger_status",
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
    mcp: {
      // An optional Host capability, not a library call.
      handle: (args, { conformanceTriggerRegistry }) =>
        conformanceTriggerRegistry
          ? conformanceTriggerRegistry.inspect({ root: args.project_root, sourceId: args.source_id })
          : { status: "optional-host-adapter-unavailable", ordinaryWorkBlocked: false, authority: "P5-capability-disclosure-only" },
    },
  },
  {
    name: "lode_conformance_trigger_prepare",
    tool: {
      name: "lode_conformance_trigger_prepare",
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
    mcp: {
      handle: (args, { conformanceTriggerRegistry }) =>
        conformanceTriggerRegistry
          ? conformanceTriggerRegistry.prepare({ root: args.project_root, sourceId: args.source_id, limit: args.limit ?? 64 })
          : { status: "optional-host-adapter-unavailable", ordinaryWorkBlocked: false, authority: "P5-capability-disclosure-only" },
    },
  },
  {
    name: "lode_source_context",
    tool: {
      name: "lode_source_context",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        "Collect current task-scoped source evidence and compile it into Context without Product onboarding or full indexing. Lode chooses exact needs after inspecting the user's task; never ask users to author JSON or IDs. Python outgoing-calls uses isolated parse-only stdlib AST, preserves unresolved calls, and claims no runtime truth or completeness. Optional retention stores P3 evidence only; failures affect dependent judgments, not independent work.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          task: { type: "string", minLength: 1 },
          needs: {
            type: "array",
            maxItems: 32,
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["source", "outgoing-calls", "declarations", "selected-source"] },
                path: { type: "string", minLength: 1 },
                symbol: { type: "string", maxLength: 512 },
                required: { type: "boolean", default: true },
                selection: {
                  type: "object",
                  description:
                    "Optional exact occurrence from a declarations response; selected-source only. No outline prerequisite for a known unique symbol.",
                  properties: {
                    path: { type: "string", minLength: 1, maxLength: 512 },
                    fileDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
                    qualifiedName: { type: "string", minLength: 1, maxLength: 512 },
                    kind: { type: "string", enum: ["class", "function", "async-function", "method", "async-method"] },
                    occurrence: { type: "integer", minimum: 1 },
                    range: {
                      type: "object",
                      properties: Object.fromEntries(
                        ["start", "end"].map((key) => [
                          key,
                          {
                            type: "object",
                            properties: { line: { type: "integer", minimum: 0 }, character: { type: "integer", minimum: 0 } },
                            required: ["line", "character"],
                            additionalProperties: false,
                          },
                        ]),
                      ),
                      required: ["start", "end"],
                      additionalProperties: false,
                    },
                  },
                  required: ["path", "fileDigest", "qualifiedName", "kind", "occurrence", "range"],
                  additionalProperties: false,
                },
              },
              required: ["kind", "path"],
              additionalProperties: false,
            },
          },
          retain: {
            type: "boolean",
            default: false,
            description: "Lode selects retention for audit/reuse/handoff; no additional user approval. Ephemeral is the default.",
          },
          timeout_ms: { type: "integer", minimum: 1, maximum: 120000, default: 15000 },
          budget: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        },
        required: ["project_root", "task"],
        additionalProperties: false,
      },
    },
    mcp: {
      args: (args, { signal, onProcess }) => [
        {
          root: args.project_root,
          task: args.task,
          needs: args.needs ?? [],
          retain: args.retain ?? false,
          budget: args.budget,
          timeoutMs: args.timeout_ms ?? 15_000,
          signal,
          onProcess,
        },
      ],
    },
    cli: {
      command: "source-context",
      flags: ["budget", "input", "kind", "required", "retain", "source", "symbol", "task", "timeout"],
      args: ({ root, options, inputJson, signal, onProcess }) => [
        {
          root,
          task: options.task,
          needs: options.input
            ? inputJson(options, "Source needs").needs
            : options.source
              ? [
                  {
                    kind: options.kind ?? (options.symbol ? "outgoing-calls" : "source"),
                    path: options.source,
                    symbol: options.symbol ?? "",
                    required: options.required !== "false",
                  },
                ]
              : [],
          retain: options.retain === "true",
          budget: options.budget == null ? undefined : Number(options.budget),
          signal,
          onProcess,
          timeoutMs: options.timeout == null ? 15_000 : Number(options.timeout),
        },
      ],
    },
    impl: () => import("../world/source-context-workflow.mjs").then((module) => module.prepareSourceContext),
  },
  {
    name: "lode_source_observation_read",
    tool: {
      name: "lode_source_observation_read",
      description:
        "Audit exact retained original source/response after integrity verification, even after source edits. Reports current, stale or unavailable sourceState separately; historical data is not eligible as current Context or P2 recovery authority.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          bundle_key: { type: "string", pattern: "^[a-f0-9]{64}$" },
          failure_key: {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
            description: "Alternatively, read the exact retained failure. Supply exactly one key; Lode obtains it from the collection result.",
          },
        },
        required: ["project_root"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root, bundleKey: args.bundle_key, failureKey: args.failure_key }] },
    cli: {
      command: "source-observation-read",
      flags: ["bundle", "failure"],
      args: ({ root, options }) => [{ root, bundleKey: options.bundle, failureKey: options.failure }],
    },
    impl: () => import("../world/source-context-workflow.mjs").then((module) => module.inspectSourceObservation),
  },
  {
    name: "lode_context_prepare",
    tool: {
      name: "lode_context_prepare",
      description:
        "Return source-linked selected context from the exact user task in one read-only call. Reuse this preparation directly; Lode inspects originals or requests a guided preview only when useful. No World activation, JSON form, compulsory inclusion proof, token tier or new approval. Lode judges semantic sufficiency; Core grants no authority and writes no recovery state.",
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
    mcp: { args: (args) => [{ root: args.project_root, task: args.task, budget: args.budget ?? DEFAULT_CONTEXT_BUDGET }] },
    cli: {
      command: "context-prepare",
      flags: ["budget", "task"],
      args: ({ root, options }) => [{ root, task: options.task, budget: options.budget == null ? DEFAULT_CONTEXT_BUDGET : Number(options.budget) }],
    },
    impl: () => import("./context-workflow.mjs").then((module) => module.prepareContextWorkflow),
  },
  {
    name: "lode_context_preview",
    tool: {
      name: "lode_context_preview",
      description:
        "Prepare source-linked selected context from the exact user task, with optional Lode evidence guidance. Reports omissions and uncertainty without an inclusion-proof gate or fixed token tiers. Lode expands useful sources and assesses sufficiency. Writes nothing and grants no authority.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          task: { type: "string", minLength: 1 },
          budget: {
            type: "integer",
            minimum: 1,
            maximum: Number.MAX_SAFE_INTEGER,
            default: DEFAULT_CONTEXT_BUDGET,
            description:
              "Approximate selected-context limit. Lode may choose any positive safe integer or inspect more original evidence; this is not a provider-fit proof.",
          },
          evidence_needs: {
            type: "array",
            maxItems: 32,
            description:
              "Task-local evidence requirements chosen by Lode. The Compiler checks actual inclusion only; it does not infer requirements or judge semantic sufficiency.",
            items: {
              type: "object",
              properties: {
                id: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" },
                kind: {
                  type: "string",
                  enum: [
                    "claim",
                    "decision",
                    "git-decision",
                    "observation",
                    "product-context",
                    "repository-file",
                    "repository-source",
                    "repository-test",
                    "runtime-state",
                    "semantic-relation",
                    "temporal-relation",
                    "unknown",
                  ],
                },
                paths: {
                  type: "array",
                  maxItems: 32,
                  description:
                    "Exact normalized project-relative repository paths selected by Lode after semantic task analysis. Core verifies actual current inclusion; paths never grant authority.",
                  items: { type: "string", minLength: 1 },
                },
                entityKeys: {
                  type: "array",
                  maxItems: 32,
                  description:
                    "Exact Product Canon entity keys selected by Lode for product-context evidence. Core verifies actual current inclusion; keys never grant authority.",
                  items: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
                },
                observationIds: {
                  type: "array",
                  minItems: 1,
                  maxItems: 32,
                  uniqueItems: true,
                  description:
                    "Exact immutable Observation identities selected by Lode. Core verifies current existence and actual inclusion without lexical matching or semantic promotion.",
                  items: { type: "string", pattern: "^(observation|derived-observation)-[a-f0-9]{24}$" },
                },
                facets: { type: "array", maxItems: 16, items: { type: "string", minLength: 1 } },
                relationTypes: { type: "array", maxItems: 16, items: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$" } },
                graphAnchor: {
                  type: "object",
                  description:
                    "Exact task-local graph anchors proposed by Lode after semantic analysis. Core only verifies current Project/World/Graph binding and bounded inclusion; the proposal has no Canon, instruction, review, or recovery authority.",
                  properties: {
                    projectId: { type: "string", minLength: 1, maxLength: 256 },
                    worldModelId: { type: "string", pattern: "^world-model-[a-f0-9]{24}$" },
                    graphSnapshotId: { type: "string", pattern: "^graph-snapshot-[a-f0-9]{24}$" },
                    nodeIds: { type: "array", minItems: 1, maxItems: 32, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 256 } },
                    depth: { type: "integer", minimum: 1, maximum: 3 },
                    maxNodes: { type: "integer", minimum: 1, maximum: 500 },
                    maxEdges: { type: "integer", minimum: 1, maximum: 1000 },
                  },
                  required: ["projectId", "worldModelId", "graphSnapshotId", "nodeIds", "depth", "maxNodes", "maxEdges"],
                  additionalProperties: false,
                },
                minimumItems: { type: "integer", minimum: 1, maximum: 20, default: 1 },
                rationale: { type: "string", maxLength: 500 },
              },
              required: ["id", "kind"],
              additionalProperties: false,
            },
          },
        },
        required: ["project_root", "task"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: {
      args: (args) => [{ root: args.project_root, task: args.task, budget: args.budget ?? DEFAULT_CONTEXT_BUDGET, evidenceNeeds: args.evidence_needs || [] }],
    },
    cli: {
      command: "context-preview",
      flags: ["budget", "evidence-needs", "task"],
      args: ({ root, options, evidenceNeedsInput }) => [
        {
          root,
          task: options.task,
          budget: options.budget == null ? DEFAULT_CONTEXT_BUDGET : Number(options.budget),
          evidenceNeeds: evidenceNeedsInput(options),
        },
      ],
    },
    impl: () => import("./context-workflow.mjs").then((module) => module.previewContextWorkflow),
  },
  {
    name: "lode_context_capsule",
    tool: {
      name: "lode_context_capsule",
      description: "Read and digest-verify one persisted Context Capsule.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          capsule_id: { type: "string", pattern: "^capsule-[a-f0-9]{24}$" },
        },
        required: ["project_root", "capsule_id"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root, capsuleId: args.capsule_id }] },
    cli: { command: "context-read", flags: ["capsule"], args: ({ root, options }) => [{ root, capsuleId: options.capsule }] },
    impl: () => import("./context-compiler.mjs").then((module) => module.readContextCapsule),
  },
  {
    name: "lode_lineage_artifact",
    tool: {
      name: "lode_lineage_artifact",
      description: "Read and digest-verify one persisted Whole-plan Execution Lineage artifact.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          artifact_id: { type: "string", pattern: "^(whole-plan|execution-contract|result-packet|review-decision)-[a-f0-9]{24}$" },
        },
        required: ["project_root", "artifact_id"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root, artifactId: args.artifact_id }] },
    cli: { command: "lineage-read", flags: ["artifact"], args: ({ root, options }) => [{ root, artifactId: options.artifact }] },
    impl: () => import("../runtime/execution-lineage.mjs").then((module) => module.readLineageArtifact),
  },
  {
    name: "lode_pending_review",
    tool: {
      name: "lode_pending_review",
      description: "Build the deterministic minimum-sufficient Fresh Lode view for the Result Packet awaiting review.",
      inputSchema: {
        type: "object",
        properties: { project_root: { type: "string", minLength: 1 } },
        required: ["project_root"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root }] },
    cli: { command: "run-review-context", flags: [], args: ({ root }) => [{ root }] },
    impl: () => import("../runtime/run-lineage.mjs").then((module) => module.getPendingReviewContext),
  },
  {
    name: "lode_checkpoint_basis",
    tool: {
      name: "lode_checkpoint_basis",
      description:
        "Read one non-persisted exact Project/Session/Run/plan/contract/Capsule/review and transition basis before Lode derives recovery direction. This is P4 comparison evidence and writes no P2 direction.",
      inputSchema: {
        type: "object",
        properties: { project_root: { type: "string", minLength: 1 } },
        required: ["project_root"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root }] },
    cli: { command: "checkpoint-basis", flags: [], args: ({ root }) => [{ root }] },
    impl: () => import("./compaction-recovery.mjs").then((module) => module.inspectRecoveryCheckpointBasis),
  },
  {
    name: "lode_checkpoint_diagnose",
    tool: {
      name: "lode_checkpoint_diagnose",
      description:
        "Read a bounded P4 checkpoint diagnosis: current pointer, artifact-restore verification, mechanical sync availability, and the next Lode action. It performs no write, repair, approval, or semantic-freshness judgment.",
      inputSchema: {
        type: "object",
        properties: { project_root: { type: "string", minLength: 1 } },
        required: ["project_root"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root }] },
    cli: { command: "checkpoint-diagnose", flags: [], args: ({ root }) => [{ root }] },
    impl: () => import("./recovery-checkpoint-diagnosis.mjs").then((module) => module.inspectRecoveryCheckpointDiagnosis),
  },
  {
    name: "lode_checkpoint_sync",
    tool: {
      name: "lode_checkpoint_sync",
      description:
        "Publish or reuse one canonical P2 recovery checkpoint only when the exact read-only basis is current. Identical retries converge; stale direction conflicts; incomplete Run or open compaction transitions defer only this sync. A Host-verified caller may omit expected_recovery_basis_id after lode_checkpoint_basis or a created sync; a conflict or deferral requires a fresh basis read.",
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
        required: ["project_root", "purpose", "approved_decisions", "current_position", "next_expected_result"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    mcp: {
      args: (args) => [
        {
          root: args.project_root,
          expectedRecoveryBasisId: args.expected_recovery_basis_id,
          purpose: args.purpose,
          approvedDecisions: args.approved_decisions,
          currentPosition: args.current_position,
          nextExpectedResult: args.next_expected_result,
          openReviewIds: args.open_review_ids || [],
          ...(args.work_evidence !== undefined ? { workEvidence: args.work_evidence } : {}),
        },
      ],
    },
    cli: {
      command: "checkpoint-sync",
      flags: ["input"],
      args: ({ root, options, inputJson }) => [{ ...inputJson(options, "Recovery checkpoint sync"), root }],
    },
    impl: () => import("./compaction-recovery.mjs").then((module) => module.syncRecoveryCheckpoint),
  },
  {
    name: "lode_session_work_record",
    cli: {
      command: "session-work-record",
      flags: ["document-selection", "input"],
      handle: async (context) => {
        const { root, options, inputJson } = context;
        const input = inputJson(options, "Selected Session work evidence");
        let documentSelection, documentSelectionError;
        if (options["document-selection"]) {
          try {
            documentSelection = JSON.parse(fs.readFileSync(path.resolve(options["document-selection"]), "utf8"));
          } catch (error) {
            documentSelectionError = error.code || "WORK_DOCUMENT_SELECTION_JSON_INVALID";
          }
        }
        return (await import("./session-work-document-workflow.mjs")).recordSessionWorkAndProjectDocuments({
          root,
          input,
          documentSelection,
          documentSelectionError,
        });
      },
    },
    tool: {
      name: "lode_session_work_record",
      description:
        "Optionally preserve meaningful Run-free work as one create-only P3 Evidence original in the exact selected Session, without a Run, checkpoint, Capsule, user form or save approval. Lode supplies sparse otherwise-unrepresented context; exact retry does not re-execute work. When checkpoint sync is already useful, use its optional work_evidence instead.",
      inputSchema: {
        type: "object",
        properties: { project_root: workEvidenceText, evidence: sessionWorkEvidenceSchema, document_selection: workDocumentCompositionSchema },
        required: ["project_root", "evidence"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    mcp: { args: (args) => [{ root: args.project_root, input: args.evidence, documentSelection: args.document_selection }] },
    impl: () => import("./session-work-document-workflow.mjs").then((module) => module.recordSessionWorkAndProjectDocuments),
  },
  {
    name: "lode_session_work_read",
    tool: {
      name: "lode_session_work_read",
      description:
        "Read the selected Session's recent work and explicitly linked earlier reasons with verified originals and bounded output. Entry already provides work context; expand only when useful. Exact IDs avoid inventory enumeration; an explicit cursor reads an ID page. Some history may remain outside the returned bodies. No write, repair, replay or recovery direction.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: workEvidenceText,
          evidence_ids: { type: "array", maxItems: 512, items: { type: "string", pattern: "^work-evidence-[a-f0-9]{24}$" } },
          after_evidence_id: {
            type: "string",
            pattern: "^work-evidence-[a-f0-9]{24}$",
            description: "Explicit lexical ID-page anchor, not a time-order cursor. Default global selection returns no continuation cursor.",
          },
          scan_evidence: {
            type: "boolean",
            description:
              "Start the first bounded lexical original page without a seed ID; follow the returned next arguments when useful. Default recent-work selection is unchanged. No write or completeness claim.",
          },
          max_records: { type: "integer", minimum: 1, maximum: 512 },
          max_characters: {
            type: "integer",
            minimum: 2,
            maximum: 524288,
            description:
              "Actual emitted P3 JSON UTF16 budget: records, plus separate recordExcerpts and their coverage/selectors/expansion when present. Separate bounded outer/Todo metadata excluded; omissions/expansion disclosed.",
          },
          todo_id: {
            type: "string",
            pattern: "^todo-[a-z0-9][a-z0-9-]{0,79}$",
            description: "Inspect this recorded task, including terminal or conflicting revisions, independently of recent work.",
          },
          after_todo_id: {
            type: "string",
            pattern: "^todo-[a-z0-9][a-z0-9-]{0,79}$",
            description: "Continue the known unresolved Todo list by stable item ID.",
          },
          scan_todos: {
            type: "boolean",
            description:
              "Read a bounded original ID page when the replaceable Todo index is missing or incomplete. Continue with after_evidence_id; no repair or World refresh.",
          },
        },
        required: ["project_root"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: {
      args: (args) => [
        {
          root: args.project_root,
          evidenceIds: args.evidence_ids ?? null,
          afterEvidenceId: args.after_evidence_id ?? null,
          scanEvidence: args.scan_evidence ?? false,
          maxRecords: args.max_records ?? 8,
          maxCharacters: args.max_characters ?? 32768,
          todoId: args.todo_id ?? null,
          afterTodoId: args.after_todo_id ?? null,
          scanTodos: args.scan_todos ?? false,
        },
      ],
    },
    cli: {
      command: "session-work-read",
      flags: ["after-evidence-id", "input", "scan-evidence"],
      args: ({ root, options, inputJson }) => [
        {
          ...(options.input ? inputJson(options, "Session work read") : {}),
          ...(options["scan-evidence"] !== undefined ? { scanEvidence: options["scan-evidence"] === true || options["scan-evidence"] === "true" } : {}),
          ...(options["after-evidence-id"] !== undefined ? { afterEvidenceId: options["after-evidence-id"] } : {}),
          root,
        },
      ],
    },
    impl: () => import("./session-work-context.mjs").then((module) => module.readSessionWorkContext),
  },
  {
    name: "lode_session_restore",
    tool: {
      name: "lode_session_restore",
      description:
        "Reconstruct the exact current Project/Session/Run consumer input from the canonical SessionRunCheckpoint and verified artifacts. This derived view never resumes or depends on a provider session.",
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
    mcp: { args: (args) => [{ root: args.project_root, checkpointId: args.checkpoint_id || null }] },
    cli: { command: "session-restore", flags: ["checkpoint"], args: ({ root, options }) => [{ root, checkpointId: options.checkpoint || null }] },
    impl: () => import("./session-recovery.mjs").then((module) => module.restoreSessionFromArtifacts),
  },
  {
    name: "lode_session_continue",
    cli: {
      command: "session-continue",
      flags: ["checkpoint", "runtime"],
      handle: async (context) => {
        const { root, options } = context;
        const { continueSessionFromArtifacts } = await import("../runtime/runtime-session-continuation.mjs");
        return continueSessionFromArtifacts({
          root,
          checkpointId: options.checkpoint || null,
          runtime: options.runtime,
        });
      },
    },
    tool: {
      name: "lode_session_continue",
      description:
        "Restore the canonical P2 SessionRunCheckpoint first, then optionally verify the exact current live Lode attachment through the host-injected P5 adapter. Failure falls back to a disclosed fresh logical Lode and never imports provider session identity.",
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
    mcp: { handle: (args, { coordinationWorkspaceHost }) => continueSessionFromMcp(args, coordinationWorkspaceHost) },
  },
  {
    name: "lode_worker_integration",
    cli: {
      command: "worker-integrate",
      flags: ["input"],
      handle: async (context) => {
        const { root, options, onProcess, inputJson } = context;
        const { operateWorkerIntegration, validateWorkerIntegrationRequest } = await import("../worker/worker-integration-workflow.mjs");
        const { resolveProjectStorage } = await import("../storage/project-storage-format.mjs");
        const input = validateWorkerIntegrationRequest(inputJson(options, "Worker integration"));
        return await operateWorkerIntegration(input, { root, onProcess, storage: resolveProjectStorage(root) });
      },
    },
    tool: {
      name: "lode_worker_integration",
      description:
        "Lode combines exact completed worker patches, explicitly applies or reconciles bounded file effects, settles a quiescent incomplete attempt, or prepares/publishes one verified whole-Run result. Lode supplies the structured fields from its task and evidence; do not ask the user to author JSON. prepare-result needs the current basis_digest and Lode verification; publish-result needs that exact verification_id. Published results still require Fresh Lode review; this never creates ReviewDecision, Product Canon or checkpoint direction. No provider is launched and no Host executable or transport is accepted.",
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
            description: "Exact current status basis after Lode reassessment, never a user confirmation token.",
          },
          retry_known_no_write: {
            type: "boolean",
            default: false,
            description: "Only for apply: Lode may explicitly retry an exact, quiescent, inspected known-no-write attempt. Unknown effects are never retried.",
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
    mcp: { handle: (args, { onProcess }) => workerIntegrationFromMcp(args, onProcess) },
  },
  {
    name: "lode_worker_integration_status",
    cli: {
      command: "worker-integration-status",
      flags: ["integration", "verification"],
      handle: async (context) => {
        const { root, options } = context;
        const { inspectWorkerIntegration, validateWorkerIntegrationStatusRequest } = await import("../worker/worker-integration-workflow.mjs");
        const { resolveProjectStorage } = await import("../storage/project-storage-format.mjs");
        const input = validateWorkerIntegrationStatusRequest({
          integrationId: options.integration,
          ...(options.verification ? { verificationId: options.verification } : {}),
        });
        return inspectWorkerIntegration(input, { root, storage: resolveProjectStorage(root) });
      },
    },
    tool: {
      name: "lode_worker_integration_status",
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
    mcp: { handle: (args, { onProcess }) => workerIntegrationFromMcp(args, onProcess, true) },
  },
  {
    name: "lode_bounded_worker_prepare",
    tool: {
      name: "lode_bounded_worker_prepare",
      description:
        "Optional managed path only, not a prerequisite for ordinary Host delegation. Prepare a bounded read-only patch-proposal worker through the built-in local Host without calling a model. Lode supplies task, exact model, selected context and source/proposal paths from the conversation; never ask the user to write a module, JSON or IDs. Reuses current Session or active Run authority and an identical preparation. Does not apply patches, create a Run, approve results, inspect an account or start a worker. Host-global instruction selection is explicit input scope, not an enforcement assertion; selected-only is the default.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          task: { type: "string", minLength: 1 },
          model: { type: "string", minLength: 1 },
          task_key: { type: "string", pattern: "^[a-z][a-z0-9-]{0,95}$" },
          role: { type: "string", enum: ["developer", "coder", "reviewer"] },
          outcome: { type: "string", minLength: 1 },
          selected_context: { type: "string" },
          source_paths: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
          proposal_paths: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
          runtime: { type: "string", enum: ["codex", "claude", "opencode"] },
          timeout_ms: { type: "integer", minimum: 1000, maximum: 3600000 },
          instruction_scope: { type: "string", enum: ["selected-only", "host-global"] },
          context_mode: {
            type: "string",
            enum: ["fresh", "native-prefix"],
            description:
              "Default fresh uses one model turn. Explicit native-prefix uses selected_context in a new durable controlled seed and then a fork child (two turns total); not a fork of the current conversation or a stronger code-worker sandbox. Lode must keep both calls and seed persistence within the existing authorized scope.",
          },
        },
        required: ["project_root", "task", "model"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: {
      args: (args, { workerJobSupervisor, workerPreparationBackend, signal, onProcess }) => [
        localWorkerInput(args),
        { root: args.project_root, supervisorSelection: workerJobSupervisor, protocolFixtureBackend: workerPreparationBackend, signal, onProcess },
      ],
    },
    cli: {
      command: "worker-prepare",
      flags: [
        "context",
        "context-mode",
        "input",
        "instruction-scope",
        "model",
        "outcome",
        "propose",
        "role",
        "runtime",
        "source",
        "task",
        "task-key",
        "timeout-ms",
      ],
      args: ({ root, options, inputJson, workerJobSupervisor, workerPreparationBackend, signal, onProcess }) => {
        const allowed = new Set([
          "input",
          "task",
          "task-key",
          "role",
          "outcome",
          "context",
          "source",
          "propose",
          "model",
          "runtime",
          "timeout-ms",
          "instruction-scope",
          "context-mode",
        ]);
        if (Object.keys(options).some((key) => !allowed.has(key)) || (options.input && Object.keys(options).length > 1))
          throw new Error("Worker preparation accepts one bounded task description, not Host configuration.");
        return [
          options.input
            ? inputJson(options, "Worker preparation")
            : {
                task: options.task,
                taskKey: options["task-key"],
                role: options.role,
                outcome: options.outcome,
                selectedContext: options.context,
                contextMode: options["context-mode"],
                sourcePaths: options.source ? options.source.split(",") : [],
                proposalPaths: options.propose ? options.propose.split(",") : [],
                model: options.model,
                runtime: options.runtime,
                timeoutMs: options["timeout-ms"] == null ? undefined : Number(options["timeout-ms"]),
                instructionScope: options["instruction-scope"],
              },
          { root, supervisorSelection: workerJobSupervisor, protocolFixtureBackend: workerPreparationBackend, signal, onProcess },
        ];
      },
    },
    impl: () => import("../worker/local-worker-host.mjs").then((module) => module.prepareLocalBoundedWorker),
  },
  {
    name: "lode_bounded_worker_start",
    tool: {
      name: "lode_bounded_worker_start",
      description:
        "Start an optional managed worker, not a general Host spawn. Start a prepared worker by its task key or exact authorization using the built-in local Host and bounded native owner. Embedding Hosts remain supported. Repeated start never relaunches an uncertain job; no runner, environment or enforcement assertion is accepted.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          authorization_id: { type: "string", pattern: "^execution-authorization-[a-f0-9]{24}$" },
          task_key: { type: "string", pattern: "^[a-z][a-z0-9-]{0,95}$" },
          role: { type: "string", enum: ["developer", "coder", "reviewer"] },
        },
        required: ["project_root"],
        oneOf: [
          { required: ["authorization_id"], not: { required: ["task_key"] } },
          { required: ["task_key"], not: { required: ["authorization_id"] } },
        ],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    mcp: {
      args: (args, { workerJobHost, workerJobSupervisor, onProcess }) => [
        { root: args.project_root, ...localWorkerInput(args, true) },
        { host: workerJobHost, supervisorSelection: workerJobSupervisor, onProcess },
      ],
    },
    cli: {
      command: "worker-start",
      flags: ["authorization", "role", "task-key"],
      args: ({ root, options, workerJobHost, workerJobSupervisor, onProcess }) => {
        if (Object.keys(options).some((key) => !["task-key", "authorization", "role"].includes(key)))
          throw new Error("Worker start does not accept Host configuration.");
        return [
          { root, authorizationId: options.authorization, taskKey: options["task-key"], role: options.role },
          { host: workerJobHost, supervisorSelection: workerJobSupervisor, onProcess },
        ];
      },
    },
    impl: () => import("../worker/local-worker-host.mjs").then((module) => module.startLocalBoundedWorker),
  },
  {
    name: "lode_bounded_worker_job_status",
    tool: {
      name: "lode_bounded_worker_job_status",
      description: "Read the same immutable bounded worker job after frontend loss. This does not relaunch, repair P2, or infer success from a spool alone.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: {
            type: "string",
            minLength: 1,
          },
          authorization_id: {
            type: "string",
            pattern: "^execution-authorization-[a-f0-9]{24}$",
          },
        },
        required: ["project_root", "authorization_id"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    mcp: {
      args: (args, { onProcess, workerJobSupervisor }) => [
        { root: args.project_root, authorizationId: args.authorization_id },
        { onProcess, inspectorSelection: workerJobSupervisor },
      ],
    },
    cli: {
      command: "worker-job-status",
      flags: ["authorization"],
      args: ({ root, options, onProcess, workerJobSupervisor }) => [
        { root, authorizationId: options.authorization },
        { onProcess, inspectorSelection: workerJobSupervisor },
      ],
    },
    impl: () => import("../worker/bounded-worker-job.mjs").then((module) => module.readBoundedWorkerJob),
  },
  {
    name: "lode_bounded_worker_job_reconcile",
    tool: {
      name: "lode_bounded_worker_job_reconcile",
      description:
        "Reconcile an exited worker against exact cleanup, durable lease and bounded provider output. Restore only missing matching P3 invocation evidence; never infer a release, relaunch, apply a result, or change P2.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: {
            type: "string",
            minLength: 1,
          },
          authorization_id: {
            type: "string",
            pattern: "^execution-authorization-[a-f0-9]{24}$",
          },
        },
        required: ["project_root", "authorization_id"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    mcp: {
      args: (args, { onProcess, workerJobSupervisor }) => [
        { root: args.project_root, authorizationId: args.authorization_id },
        { onProcess, inspectorSelection: workerJobSupervisor },
      ],
    },
    cli: {
      command: "worker-job-reconcile",
      flags: ["authorization"],
      args: ({ root, options, onProcess, workerJobSupervisor }) => [
        { root, authorizationId: options.authorization },
        { onProcess, inspectorSelection: workerJobSupervisor },
      ],
    },
    impl: () => import("../worker/bounded-worker-job.mjs").then((module) => module.reconcileBoundedWorkerJob),
  },
  {
    name: "lode_bounded_worker_cancel",
    tool: {
      name: "lode_bounded_worker_cancel",
      description:
        "Request cancellation of one exact owned bounded job. A request is not proof of cleanup; inspect until terminal and owner exit are verified. No arbitrary PID or path is accepted.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: {
            type: "string",
            minLength: 1,
          },
          authorization_id: {
            type: "string",
            pattern: "^execution-authorization-[a-f0-9]{24}$",
          },
        },
        required: ["project_root", "authorization_id"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    mcp: {
      args: (args, { onProcess, workerJobSupervisor }) => [
        { root: args.project_root, authorizationId: args.authorization_id },
        { onProcess, inspectorSelection: workerJobSupervisor },
      ],
    },
    cli: {
      command: "worker-cancel",
      flags: ["authorization"],
      args: ({ root, options, onProcess, workerJobSupervisor }) => [
        { root, authorizationId: options.authorization },
        { onProcess, inspectorSelection: workerJobSupervisor },
      ],
    },
    impl: () => import("../worker/bounded-worker-job.mjs").then((module) => module.cancelBoundedWorkerJob),
  },
  {
    name: "lode_bounded_worker_job_patch",
    tool: {
      name: "lode_bounded_worker_job_patch",
      description:
        "Read exact owner-frozen workspace patch evidence bound to native terminal output and invocation lineage. This never applies edits, approves them or changes P2; later child edits cannot replace the frozen candidate.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: {
            type: "string",
            minLength: 1,
          },
          authorization_id: {
            type: "string",
            pattern: "^execution-authorization-[a-f0-9]{24}$",
          },
        },
        required: ["project_root", "authorization_id"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    mcp: {
      args: (args, { onProcess, workerJobSupervisor }) => [
        { root: args.project_root, authorizationId: args.authorization_id },
        { onProcess, inspectorSelection: workerJobSupervisor },
      ],
    },
    cli: {
      command: "worker-job-patch",
      flags: ["authorization"],
      args: ({ root, options, onProcess, workerJobSupervisor }) => [
        { root, authorizationId: options.authorization },
        { onProcess, inspectorSelection: workerJobSupervisor },
      ],
    },
    impl: () => import("../worker/bounded-worker-job.mjs").then((module) => module.readBoundedWorkerPatch),
  },
  {
    name: "lode_bounded_worker_reconcile",
    tool: {
      name: "lode_bounded_worker_reconcile",
      description:
        "Recover a current logical worker's exact frozen authorization after interrupted publication, without recapturing changed or missing source files. This repairs only missing lookup records; it never launches, retries, grants new authority, or changes P2 recovery direction.",
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
    mcp: { args: (args) => [{ root: args.project_root, taskKey: args.task_key }] },
    cli: { command: "worker-reconcile", flags: ["task-key"], args: ({ root, options }) => [{ root, taskKey: options["task-key"] }] },
    impl: () => import("../runtime/runtime-invocation-lifecycle.mjs").then((module) => module.reconcileWorkerMember),
  },
  {
    name: "lode_bounded_worker_dispatch",
    tool: {
      name: "lode_bounded_worker_dispatch",
      description:
        "Create or verify one P3 non-Lode worker ownership record bound to an exact current Run or idle Session ExecutionAuthorization. Execute via CLI worker-execute; for Session pass --input with the exact sessionRequest. This cannot change WholePlan, recovery direction, or review state.",
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
    mcp: { args: (args) => [{ root: args.project_root, authorizationId: args.authorization_id, role: args.role }] },
    cli: {
      command: "worker-dispatch",
      flags: ["authorization", "role"],
      args: ({ root, options }) => [{ root, authorizationId: options.authorization, role: options.role }],
    },
    impl: () => import("../worker/bounded-worker-dispatch.mjs").then((module) => module.createBoundedWorkerDispatch),
  },
  {
    name: "lode_bounded_worker_status",
    tool: {
      name: "lode_bounded_worker_status",
      description:
        "Read and verify one P3 bounded worker dispatch without consuming its authorization. The optional historical prepared-input view keeps original references, runtime observations and model-use uncertainty separate; it does not change current execution or recovery authority.",
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
    mcp: {
      args: (args) => [{ root: args.project_root, authorizationId: args.authorization_id }],
      after: (value, args) => preparedRuntimeRead(args.project_root, value),
    },
    cli: { command: "worker-read", flags: ["authorization"], args: ({ root, options }) => [{ root, authorizationId: options.authorization }] },
    impl: () => import("../worker/bounded-worker-dispatch.mjs").then((module) => module.readBoundedWorkerDispatch),
  },
  {
    name: "lode_bounded_worker_wait",
    tool: {
      name: "lode_bounded_worker_wait",
      description:
        "Boundedly observe one worker's operational P5 lease/result state. Session results are evidence for Lode consumption, without Run application or a review gate. The returned cursor is non-persisted and cannot create a ReviewDecision or recovery direction.",
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
    mcp: { args: (args) => [{ root: args.project_root, authorizationId: args.authorization_id, timeoutMs: args.wait_timeout_ms ?? 0 }] },
    cli: {
      command: "worker-wait",
      flags: ["authorization", "wait-timeout-ms"],
      args: ({ root, options }) => [{ root, authorizationId: options.authorization, timeoutMs: waitTimeout(options) }],
    },
    impl: () => import("../worker/bounded-worker-dispatch.mjs").then((module) => module.waitForBoundedWorkerDispatch),
  },
  {
    name: "lode_bounded_worker_apply_result",
    tool: {
      name: "lode_bounded_worker_apply_result",
      description:
        "Run-only: map one completed, actual-provider, native-supervised bounded-worker draft into the canonical ResultPacket and Fresh Lode review context. This does not create a ReviewDecision or integrate checkpoint direction.",
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
    mcp: { args: (args) => [{ root: args.project_root, authorizationId: args.authorization_id }] },
    cli: { command: "worker-apply", flags: ["authorization"], args: ({ root, options }) => [{ root, authorizationId: options.authorization }] },
    impl: () => import("../worker/bounded-worker-dispatch.mjs").then((module) => module.applyBoundedWorkerDispatchResult),
  },
  {
    name: "lode_bounded_worker_wave_create",
    tool: {
      name: "lode_bounded_worker_wave_create",
      description:
        "Create one P3 grouping over 2-64 already-created bounded worker dispatches sharing the exact current Project/Lode Session/Run/WholePlan/ExecutionContract/ContextCapsule lineage. It creates no authorization and widens no member scope.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          authorization_ids: {
            type: "array",
            minItems: 2,
            maxItems: 64,
            uniqueItems: true,
            items: { type: "string", pattern: "^execution-authorization-[a-f0-9]{24}$" },
          },
        },
        required: ["project_root", "authorization_ids"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root, authorizationIds: args.authorization_ids }] },
    cli: {
      command: "worker-wave-create",
      flags: ["input"],
      args: ({ root, options, inputJson }) => {
        const input = onlyFields(inputJson(options, "Bounded worker wave"), ["authorizationIds"], "Bounded worker wave");
        return [{ root, authorizationIds: input.authorizationIds }];
      },
    },
    impl: () => import("../worker/bounded-worker-wave.mjs").then((module) => module.createBoundedWorkerWave),
  },
  {
    name: "lode_bounded_worker_wave_read",
    tool: {
      name: "lode_bounded_worker_wave_read",
      description:
        "Read and reverify one P3 worker wave, every member dispatch, current P2 lineage, and any create-only seal or abandonment evidence. This read cannot seal the wave.",
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
    mcp: { args: (args) => [{ root: args.project_root, waveId: args.wave_id }] },
    cli: { command: "worker-wave-read", flags: ["wave"], args: ({ root, options }) => [{ root, waveId: options.wave }] },
    impl: () => import("../worker/bounded-worker-wave.mjs").then((module) => module.readBoundedWorkerWave),
  },
  {
    name: "lode_bounded_worker_wave_seal",
    tool: {
      name: "lode_bounded_worker_wave_seal",
      description:
        "Create one P3 wave seal only after every independent member authorization has verified at-most-once lease consumption. A seal is not completion, review, or checkpoint integration.",
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
    mcp: { args: (args) => [{ root: args.project_root, waveId: args.wave_id }] },
    cli: { command: "worker-wave-seal", flags: ["wave"], args: ({ root, options }) => [{ root, waveId: options.wave }] },
    impl: () => import("../worker/bounded-worker-wave.mjs").then((module) => module.sealBoundedWorkerWave),
  },
  {
    name: "lode_bounded_worker_wave_status",
    tool: {
      name: "lode_bounded_worker_wave_status",
      description:
        "Return one non-persisted P4 requested/started/returned/waiting/succeeded/failed projection. Status is observational and cannot create a seal, ReviewDecision, or recovery direction.",
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
    mcp: { args: (args) => [{ root: args.project_root, waveId: args.wave_id }] },
    cli: { command: "worker-wave-status", flags: ["wave"], args: ({ root, options }) => [{ root, waveId: options.wave }] },
    impl: () => import("../worker/bounded-worker-wave.mjs").then((module) => module.readBoundedWorkerWaveStatus),
  },
  {
    name: "lode_bounded_worker_wave_results",
    tool: {
      name: "lode_bounded_worker_wave_results",
      description:
        "Read one non-persisted P4 aggregate of member result references after an explicit verified wave seal. It never applies ResultPackets or creates Fresh Lode review.",
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
    mcp: { args: (args) => [{ root: args.project_root, waveId: args.wave_id }] },
    cli: { command: "worker-wave-results", flags: ["wave"], args: ({ root, options }) => [{ root, waveId: options.wave }] },
    impl: () => import("../worker/bounded-worker-wave.mjs").then((module) => module.readBoundedWorkerWaveResults),
  },
  {
    name: "lode_bounded_worker_wave_wait",
    tool: {
      name: "lode_bounded_worker_wave_wait",
      description:
        "Boundedly observe one sealed wave as a non-persisted P5 outcome. Open or abandoned waves fail closed, and completion requires every member to succeed.",
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
    mcp: { args: (args) => [{ root: args.project_root, waveId: args.wave_id, timeoutMs: args.wait_timeout_ms ?? 0 }] },
    cli: {
      command: "worker-wave-wait",
      flags: ["wait-timeout-ms", "wave"],
      args: ({ root, options }) => [{ root, waveId: options.wave, timeoutMs: waitTimeout(options) }],
    },
    impl: () => import("../worker/bounded-worker-wave.mjs").then((module) => module.waitForBoundedWorkerWave),
  },
  {
    name: "lode_bounded_worker_wave_abandon",
    tool: {
      name: "lode_bounded_worker_wave_abandon",
      description:
        "Create one P3 non-success abandoned handoff for an unsealed wave using a bounded reason code and non-authoritative sanitized summary. This cannot create review or recovery direction.",
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
    mcp: { args: (args) => [{ root: args.project_root, waveId: args.wave_id, reasonCode: args.reason_code, reasonSummary: args.reason_summary || "" }] },
    cli: {
      command: "worker-wave-abandon",
      flags: ["input"],
      args: ({ root, options, inputJson }) => {
        const input = onlyFields(
          inputJson(options, "Bounded worker wave abandonment"),
          ["waveId", "reasonCode", "reasonSummary"],
          "Bounded worker wave abandonment",
        );
        return [{ root, waveId: input.waveId, reasonCode: input.reasonCode, reasonSummary: input.reasonSummary || "" }];
      },
    },
    impl: () => import("../worker/bounded-worker-wave.mjs").then((module) => module.abandonBoundedWorkerWave),
  },
  {
    name: "lode_run_integrate_checkpoint",
    tool: {
      name: "lode_run_integrate_checkpoint",
      description:
        "After an exact accepted Fresh Lode ReviewDecision, bind one reviewed Run result to one canonical recovery checkpoint. ResultPacket evidence cannot author checkpoint direction and no ReviewDecision is created here.",
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
    mcp: {
      args: (args) => [
        {
          root: args.project_root,
          runId: args.run_id,
          reviewDecisionId: args.review_decision_id,
          purpose: args.purpose,
          approvedDecisions: args.approved_decisions,
          currentPosition: args.current_position,
          nextExpectedResult: args.next_expected_result,
          openReviewIds: args.open_review_ids || [],
        },
      ],
    },
    cli: {
      command: "run-integrate-checkpoint",
      flags: ["input"],
      args: ({ root, options, inputJson }) => [{ ...inputJson(options, "Run result integration"), root }],
    },
    impl: () => import("./session-recovery.mjs").then((module) => module.integrateReviewedRunCheckpoint),
  },
  {
    name: "lode_run_integration",
    tool: {
      name: "lode_run_integration",
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
    mcp: { args: (args) => [{ root: args.project_root, reviewDecisionId: args.review_decision_id }] },
    cli: { command: "run-integration-read", flags: ["review"], args: ({ root, options }) => [{ root, reviewDecisionId: options.review }] },
    impl: () => import("./session-recovery.mjs").then((module) => module.readRunResultIntegration),
  },
  {
    name: "lode_world_model",
    tool: {
      name: "lode_world_model",
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
    mcp: { args: (args) => [{ root: args.project_root }], maxResponseBytes: WORLD_MODEL_STATUS_MCP_MAX_BYTES },
    impl: () => import("../world/world-model.mjs").then((module) => module.inspectWorldModelStatus),
  },
  {
    name: "lode_incremental_refresh_status",
    tool: {
      name: "lode_incremental_refresh_status",
      description:
        "Read and digest-verify the latest explicit incremental refresh receipt, World Model binding, freshness, and active-execution drift without triggering refresh or changing authority.",
      inputSchema: {
        type: "object",
        properties: { project_root: { type: "string", minLength: 1 } },
        required: ["project_root"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root }] },
    cli: { command: "world-refresh-status", flags: [], args: ({ root }) => [{ root }] },
    impl: () => import("../world/incremental-refresh.mjs").then((module) => module.inspectIncrementalRefresh),
  },
  {
    name: "lode_incremental_refresh_receipt",
    tool: {
      name: "lode_incremental_refresh_receipt",
      description: "Read and digest-verify one immutable incremental observed-state refresh receipt without advancing a pointer or changing Product Canon.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          refresh_receipt_id: { type: "string", pattern: "^incremental-refresh-receipt-[a-f0-9]{24}$" },
        },
        required: ["project_root", "refresh_receipt_id"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root, refreshReceiptId: args.refresh_receipt_id }] },
    cli: { command: "world-refresh-read", flags: ["receipt"], args: ({ root, options }) => [{ root, refreshReceiptId: options.receipt }] },
    impl: () => import("../world/incremental-refresh.mjs").then((module) => module.readIncrementalRefreshReceipt),
  },
  {
    name: "lode_refresh_trigger_status",
    tool: {
      name: "lode_refresh_trigger_status",
      description:
        "Read and digest-verify the latest debounced filesystem or CI trigger batch, serialized delivery receipt, World Model binding, and writer state without starting a watcher or triggering refresh.",
      inputSchema: {
        type: "object",
        properties: { project_root: { type: "string", minLength: 1 } },
        required: ["project_root"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root }] },
    cli: { command: "world-refresh-trigger-status", flags: [], args: ({ root }) => [{ root }] },
    impl: () => import("../world/refresh-trigger.mjs").then((module) => module.inspectRefreshTriggers),
  },
  {
    name: "lode_refresh_trigger_delivery",
    tool: {
      name: "lode_refresh_trigger_delivery",
      description:
        "Read and digest-verify one immutable refresh trigger delivery and its linked incremental refresh evidence without mutating observed state or Product Canon.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          trigger_delivery_id: { type: "string", pattern: "^refresh-trigger-delivery-[a-f0-9]{24}$" },
        },
        required: ["project_root", "trigger_delivery_id"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root, triggerDeliveryId: args.trigger_delivery_id }] },
    cli: { command: "world-refresh-trigger-read", flags: ["delivery"], args: ({ root, options }) => [{ root, triggerDeliveryId: options.delivery }] },
    impl: () => import("../world/refresh-trigger.mjs").then((module) => module.readRefreshTriggerDelivery),
  },
  {
    name: "lode_graph_projection_status",
    tool: {
      name: "lode_graph_projection_status",
      description: "Read and verify the current replaceable graph projection adapter state without treating the graph backend as canon or unique authority.",
      inputSchema: {
        type: "object",
        properties: { project_root: { type: "string", minLength: 1 } },
        required: ["project_root"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root }] },
    cli: { command: "world-graph-status", flags: [], args: ({ root }) => [{ root }] },
    impl: () => import("../world/world-model.mjs").then((module) => module.inspectWorldGraphProjection),
  },
  {
    name: "lode_graphdb_projection_status",
    tool: {
      name: "lode_graphdb_projection_status",
      description:
        "Read the privacy-safe ArcadeDB projection activation, current semantic binding, and disclosed local fallback state without exposing credentials or granting the remote backend authority.",
      inputSchema: {
        type: "object",
        properties: { project_root: { type: "string", minLength: 1 } },
        required: ["project_root"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    mcp: { args: (args, { graphDbTransport }) => [{ root: args.project_root, transport: graphDbTransport }] },
    cli: { command: "world-graph-remote-status", flags: [], args: ({ root }) => [{ root }] },
    impl: () => import("../world/graphdb-projection-activation.mjs").then((module) => module.inspectArcadeDbGraphProjectionStatus),
  },
  {
    name: "lode_graphdb_database_status",
    tool: {
      name: "lode_graphdb_database_status",
      description:
        "Read a privacy-safe compatibility audit for the selected ArcadeDB database and Lode-reserved schema without exposing the endpoint, database name, credentials, or mutation authority.",
      inputSchema: {
        type: "object",
        properties: { project_root: { type: "string", minLength: 1 } },
        required: ["project_root"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    mcp: {
      args: (args, { graphDbTransport }) => [{ root: args.project_root, transport: graphDbTransport, storage: resolveProjectStorage(args.project_root) }],
    },
    cli: { command: "world-graph-remote-database-status", flags: [], args: ({ root }) => [{ root, storage: resolveProjectStorage(root) }] },
    impl: () => import("../world/arcadedb-database-lifecycle.mjs").then((module) => module.inspectArcadeDbDatabaseCompatibility),
  },
  {
    name: "lode_graphdb_connection_preflight",
    tool: {
      name: "lode_graphdb_connection_preflight",
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
    mcp: {
      args: (args, { graphDbTransport }) => [{ root: args.project_root, transport: graphDbTransport, storage: resolveProjectStorage(args.project_root) }],
    },
    impl: () => import("../world/graphdb-projection-activation.mjs").then((module) => module.inspectArcadeDbCredentialPreflight),
  },
  {
    name: "lode_graphdb_database_initialize",
    tool: {
      name: "lode_graphdb_database_initialize",
      description:
        "After explicit user confirmation, reuse a compatible selected ArcadeDB database or create a missing one. Reset is allowed only for a proven incompatible Lode-reserved schema and an exact selected-database confirmation. Credential values are never accepted as tool input.",
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
    mcp: { handle: (args, { graphDbTransport }) => initializeGraphDbFromMcp(args, graphDbTransport) },
  },
  {
    name: "lode_graphdb_projection_activate",
    tool: {
      name: "lode_graphdb_projection_activate",
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
    mcp: { handle: (args, { graphDbTransport }) => activateGraphDbFromMcp(args, graphDbTransport) },
  },
  {
    name: "lode_markdown_projection_status",
    tool: {
      name: "lode_markdown_projection_status",
      description:
        "Read and verify the deterministic Markdown projection, published-view drift, and current GraphSnapshot binding without treating generated documents as canon.",
      inputSchema: {
        type: "object",
        properties: { project_root: { type: "string", minLength: 1 } },
        required: ["project_root"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root }] },
    cli: { command: "world-docs-status", flags: [], args: ({ root }) => [{ root }] },
    impl: () => import("../world/world-model.mjs").then((module) => module.inspectWorldMarkdownProjection),
  },
  {
    name: "lode_post_refresh_projection_status",
    tool: {
      name: "lode_post_refresh_projection_status",
      description:
        "Read the effective manual-or-automatic Markdown projection policy and verify the latest post-refresh outcome without changing policy, documents, Product Canon, or active Run inputs.",
      inputSchema: {
        type: "object",
        properties: { project_root: { type: "string", minLength: 1 } },
        required: ["project_root"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root }] },
    cli: { command: "world-docs-refresh-status", flags: [], args: ({ root }) => [{ root }] },
    impl: () => import("../world/incremental-refresh.mjs").then((module) => module.inspectPostRefreshProjectionStatus),
  },
  {
    name: "lode_post_refresh_projection_receipt",
    tool: {
      name: "lode_post_refresh_projection_receipt",
      description:
        "Read and digest-verify one immutable post-refresh projection receipt with its linked incremental refresh, policy, DocumentProjection, or document-change candidate evidence.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          post_refresh_projection_receipt_id: { type: "string", pattern: "^post-refresh-projection-receipt-[a-f0-9]{24}$" },
        },
        required: ["project_root", "post_refresh_projection_receipt_id"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root, postRefreshProjectionReceiptId: args.post_refresh_projection_receipt_id }] },
    cli: { command: "world-docs-refresh-read", flags: ["receipt"], args: ({ root, options }) => [{ root, postRefreshProjectionReceiptId: options.receipt }] },
    impl: () => import("../world/incremental-refresh.mjs").then((module) => module.readPostRefreshProjectionReceipt),
  },
  {
    name: "lode_document_change_candidates",
    tool: {
      name: "lode_document_change_candidates",
      description: "Read and digest-verify one immutable DocumentChangeCandidateSet without accepting it or changing Product Canon.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          candidate_set_id: { type: "string", pattern: "^document-change-candidate-set-[a-f0-9]{24}$" },
        },
        required: ["project_root", "candidate_set_id"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root, candidateSetId: args.candidate_set_id }] },
    cli: { command: "world-docs-candidates", flags: ["candidate-set"], args: ({ root, options }) => [{ root, candidateSetId: options["candidate-set"] }] },
    impl: () => import("../world/world-model.mjs").then((module) => module.readWorldDocumentChangeCandidateSet),
  },
  {
    name: "lode_document_change_review_status",
    tool: {
      name: "lode_document_change_review_status",
      description:
        "Read the explicit review and application status for one immutable DocumentChangeCandidateSet without accepting, applying, or mutating Product Canon.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          candidate_set_id: { type: "string", pattern: "^document-change-candidate-set-[a-f0-9]{24}$" },
        },
        required: ["project_root", "candidate_set_id"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root, candidateSetId: args.candidate_set_id }] },
    cli: { command: "world-docs-review-status", flags: ["candidate-set"], args: ({ root, options }) => [{ root, candidateSetId: options["candidate-set"] }] },
    impl: () => import("../world/document-change-review.mjs").then((module) => module.inspectDocumentChangeReviewStatus),
  },
  {
    name: "lode_document_change_review",
    tool: {
      name: "lode_document_change_review",
      description:
        "Read and digest-verify one explicit document-to-Product-Canon ReviewDecision and its exact candidate and resulting Product Model revision bindings.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          review_decision_id: { type: "string", pattern: "^document-change-review-decision-[a-f0-9]{24}$" },
        },
        required: ["project_root", "review_decision_id"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root, reviewDecisionId: args.review_decision_id }] },
    cli: { command: "world-docs-review-read", flags: ["review"], args: ({ root, options }) => [{ root, reviewDecisionId: options.review }] },
    impl: () => import("../world/document-change-review.mjs").then((module) => module.readDocumentChangeReviewDecision),
  },
  {
    name: "lode_document_change_application",
    tool: {
      name: "lode_document_change_application",
      description:
        "Read and digest-verify one document-change application receipt linking the user ReviewDecision to exact before/after World, Graph, Canon, and Markdown projection identities.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          application_receipt_id: { type: "string", pattern: "^document-change-application-[a-f0-9]{24}$" },
        },
        required: ["project_root", "application_receipt_id"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root, applicationReceiptId: args.application_receipt_id }] },
    cli: { command: "world-docs-application-read", flags: ["application"], args: ({ root, options }) => [{ root, applicationReceiptId: options.application }] },
    impl: () => import("../world/document-change-review.mjs").then((module) => module.readDocumentChangeApplicationReceipt),
  },
  {
    name: "lode_world_query",
    tool: {
      name: "lode_world_query",
      description: "Traverse a bounded, digest-verified semantic neighborhood in the current Repository World Model as evidence, never instruction authority.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          query: { type: "string", minLength: 1 },
          depth: { type: "integer", minimum: 0, maximum: 3, default: 1 },
          limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
        },
        required: ["project_root", "query"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root, query: args.query, depth: args.depth ?? 1, maxResults: args.limit ?? 100 }] },
    cli: {
      command: "world-query",
      flags: ["depth", "limit", "query"],
      args: ({ root, options }) => [
        {
          root,
          query: options.query,
          depth: options.depth == null ? 1 : Number(options.depth),
          maxResults: options.limit == null ? 100 : Number(options.limit),
        },
      ],
    },
    impl: () => import("../world/world-model.mjs").then((module) => module.queryWorldModel),
  },
  {
    name: "lode_git_history",
    tool: {
      name: "lode_git_history",
      description: "Read bounded Git commit-message decision evidence from the current digest-verified World Model without promoting it to project decisions.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          query: { type: "string", default: "" },
          limit: { type: "integer", minimum: 1, maximum: 500, default: 50 },
        },
        required: ["project_root"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root, query: args.query || "", limit: args.limit ?? 50 }] },
    cli: {
      command: "world-history",
      flags: ["limit", "query"],
      args: ({ root, options }) => [{ root, query: options.query || "", limit: options.limit == null ? 50 : Number(options.limit) }],
    },
    impl: () => import("../world/world-model.mjs").then((module) => module.queryWorldHistory),
  },
  {
    name: "lode_temporal_graph",
    tool: {
      name: "lode_temporal_graph",
      description:
        "Run a deterministic allowlisted traversal over the current rebuildable temporal provenance GraphSnapshot. Use exact_anchor_ids plus expected_graph_snapshot_id for Lode-proposed semantic anchors; query is lexical discovery fallback only and never proves semantic relevance. Neither mode grants Canon, review, instruction, or recovery authority.",
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
          include_unreviewed_candidates: { type: "boolean", default: false },
        },
        required: ["project_root"],
        oneOf: [{ required: ["query"] }, { required: ["exact_anchor_ids", "expected_graph_snapshot_id"] }],
        additionalProperties: false,
      },
    },
    mcp: {
      args: (args) => [
        {
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
        },
      ],
    },
    cli: {
      command: "world-temporal",
      flags: ["anchor-ids", "depth", "edge-limit", "graph-snapshot", "include-candidates", "kind", "limit", "min-confidence", "query", "relations"],
      args: ({ root, options }) => [
        {
          root,
          query: options.query,
          anchorIds: options["anchor-ids"]
            ? options["anchor-ids"]
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean)
            : null,
          expectedGraphSnapshotId: options["graph-snapshot"] || null,
          kinds: options.kind
            ? options.kind
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean)
            : null,
          relations: options.relations
            ? options.relations
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean)
            : null,
          includeUnreviewedCandidates: options["include-candidates"] === "true",
          minConfidence: options["min-confidence"] == null ? 0 : Number(options["min-confidence"]),
          depth: options.depth == null ? 1 : Number(options.depth),
          maxNodes: options.limit == null ? 100 : Number(options.limit),
          maxEdges: options["edge-limit"] == null ? 200 : Number(options["edge-limit"]),
        },
      ],
    },
    impl: () => import("../world/world-model.mjs").then((module) => module.queryWorldTemporalGraph),
  },
  {
    name: "lode_graph_lineage_status",
    tool: {
      name: "lode_graph_lineage_status",
      description:
        "Read one bounded page of retained content-addressed World/Graph lineage as a non-persisted P4 hot/warm/cold projection. It creates no artifacts and never blocks ordinary work.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          cursor: { type: "string", pattern: "^world-model-[a-f0-9]{24}$" },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
        },
        required: ["project_root"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root, cursor: args.cursor || "", limit: args.limit ?? 25 }] },
    cli: {
      command: "graph-lineage-status",
      flags: ["cursor", "limit"],
      args: ({ root, options }) => [{ root, cursor: options.cursor || "", limit: options.limit == null ? 25 : Number(options.limit) }],
    },
    impl: () => import("../world/graph-lineage.mjs").then((module) => module.inspectGraphLineage),
  },
  {
    name: "lode_graph_lineage_trace",
    tool: {
      name: "lode_graph_lineage_trace",
      description:
        "Trace an exact or discovery-selected Graph anchor in a verified current or retained snapshot, with a bounded read-only execution-lineage overlay. Discovery does not prove relevance and completion does not imply integration.",
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
          include_execution: { type: "boolean", default: true },
        },
        required: ["project_root"],
        oneOf: [{ required: ["anchor_id"] }, { required: ["query"] }],
        additionalProperties: false,
      },
    },
    mcp: {
      args: (args) => [
        {
          root: args.project_root,
          worldModelId: args.world_model_id || "",
          anchorId: args.anchor_id || "",
          query: args.query || "",
          depth: args.depth ?? 2,
          maxNodes: args.node_limit ?? 100,
          maxEdges: args.edge_limit ?? 200,
          includeExecution: args.include_execution ?? true,
        },
      ],
    },
    cli: {
      command: "graph-lineage-trace",
      flags: ["anchor", "depth", "edge-limit", "include-execution", "limit", "query", "world"],
      args: ({ root, options }) => [
        {
          root,
          worldModelId: options.world || "",
          anchorId: options.anchor || "",
          query: options.query || "",
          depth: options.depth == null ? 2 : Number(options.depth),
          maxNodes: options.limit == null ? 100 : Number(options.limit),
          maxEdges: options["edge-limit"] == null ? 200 : Number(options["edge-limit"]),
          includeExecution: options["include-execution"] !== "false",
        },
      ],
    },
    impl: () => import("../world/graph-lineage.mjs").then((module) => module.traceGraphLineage),
  },
  {
    name: "lode_graph_lineage_diff",
    tool: {
      name: "lode_graph_lineage_diff",
      description:
        "Compare two exact retained World/Graph snapshots as a bounded P4 view. Exact-content possible moves are evidence only and never automatic semantic identity.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          from_world_model_id: { type: "string", pattern: "^world-model-[a-f0-9]{24}$" },
          to_world_model_id: { type: "string", pattern: "^world-model-[a-f0-9]{24}$" },
          limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
          scope_paths: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 500 },
          cursor: { type: "string", maxLength: 131072 },
        },
        required: ["project_root", "from_world_model_id", "to_world_model_id"],
        additionalProperties: false,
      },
    },
    mcp: {
      args: (args) => [
        {
          root: args.project_root,
          fromWorldModelId: args.from_world_model_id,
          toWorldModelId: args.to_world_model_id,
          limit: args.limit ?? 100,
          scopePaths: args.scope_paths ?? null,
          cursor: args.cursor || "",
        },
      ],
    },
    cli: {
      command: "graph-lineage-diff",
      flags: ["cursor", "from", "limit", "path", "to"],
      args: ({ root, options }) => [
        {
          root,
          fromWorldModelId: options.from,
          toWorldModelId: options.to,
          limit: options.limit == null ? 100 : Number(options.limit),
          scopePaths: options.path ? [options.path] : null,
          cursor: options.cursor || "",
        },
      ],
    },
    impl: () => import("../world/graph-lineage.mjs").then((module) => module.diffGraphLineage),
  },
  {
    name: "lode_runtime_state",
    tool: {
      name: "lode_runtime_state",
      description:
        "Read bounded point-in-time external runtime observations from the current digest-verified World Model as evidence without granting runtime control authority.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          query: { type: "string", default: "" },
          runtime: { type: "string", default: "" },
          state: { type: "string", default: "" },
          kind: { type: "string", default: "" },
          limit: { type: "integer", minimum: 1, maximum: 500, default: 50 },
        },
        required: ["project_root"],
        additionalProperties: false,
      },
    },
    mcp: {
      args: (args) => [
        {
          root: args.project_root,
          query: args.query || "",
          runtime: args.runtime || "",
          state: args.state || "",
          kind: args.kind || "",
          limit: args.limit ?? 50,
        },
      ],
    },
    cli: {
      command: "world-runtime",
      flags: ["kind", "limit", "query", "runtime", "state"],
      args: ({ root, options }) => [
        {
          root,
          query: options.query || "",
          runtime: options.runtime || "",
          state: options.state || "",
          kind: options.kind || "",
          limit: options.limit == null ? 50 : Number(options.limit),
        },
      ],
    },
    impl: () => import("../world/world-model.mjs").then((module) => module.queryWorldRuntimeState),
  },
  {
    name: "lode_compact_prepare",
    tool: {
      name: "lode_compact_prepare",
      description:
        "Create the canonical Session/Run recovery checkpoint and one bounded compaction epoch. This does not invoke a provider or treat a provider summary as recovery authority.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          runtime: { type: "string", enum: ["manual", "claude", "codex", "opencode"], default: "manual" },
          user_turn_id_at_prepare: { type: "integer", minimum: 0 },
          purpose: { type: "string", minLength: 1 },
          approved_decisions: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
          current_position: { type: "string", minLength: 1 },
          next_expected_result: { type: "string", minLength: 1 },
          open_review_ids: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
        },
        required: ["project_root", "user_turn_id_at_prepare", "purpose", "approved_decisions", "current_position", "next_expected_result"],
        additionalProperties: false,
      },
    },
    mcp: {
      args: (args) => [
        {
          root: args.project_root,
          runtime: args.runtime || "manual",
          userTurnIdAtPrepare: args.user_turn_id_at_prepare,
          purpose: args.purpose,
          approvedDecisions: args.approved_decisions,
          currentPosition: args.current_position,
          nextExpectedResult: args.next_expected_result,
          openReviewIds: args.open_review_ids || [],
        },
      ],
    },
    cli: { command: "compact-prepare", flags: ["input"], args: ({ root, options, inputJson }) => [{ ...inputJson(options, "Compaction prepare"), root }] },
    impl: () => import("./compaction-recovery.mjs").then((module) => module.prepareCompaction),
  },
  {
    name: "lode_compact_verify",
    tool: {
      name: "lode_compact_verify",
      description:
        "Verify provider compaction against the exact canonical checkpoint. Provider transcripts, summaries, session identities, and HEADContinuitySnapshot are rejected as recovery sources.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          epoch_id: { type: "string", pattern: "^compaction-epoch-[a-f0-9-]{36}$" },
          checkpoint_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
          current_user_turn_id: { type: "integer", minimum: 0 },
          provider_compacted: { type: "boolean" },
          recovery_source: { type: "string", enum: ["canonical-checkpoint"] },
        },
        required: ["project_root", "epoch_id", "checkpoint_digest", "current_user_turn_id", "provider_compacted"],
        additionalProperties: false,
      },
    },
    mcp: {
      args: (args) => [
        {
          root: args.project_root,
          epochId: args.epoch_id,
          checkpointDigest: args.checkpoint_digest,
          currentUserTurnId: args.current_user_turn_id,
          providerCompacted: args.provider_compacted,
          recoverySource: args.recovery_source || "canonical-checkpoint",
        },
      ],
    },
    cli: { command: "compact-verify", flags: ["input"], args: ({ root, options, inputJson }) => [{ ...inputJson(options, "Compaction verification"), root }] },
    impl: () => import("./compaction-recovery.mjs").then((module) => module.verifyCompaction),
  },
  {
    name: "lode_compact_continue",
    tool: {
      name: "lode_compact_continue",
      description:
        "Consume a verified compaction continuation token at most once and return the checkpoint-bound continuation instruction. A newer real user turn supersedes it.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          epoch_id: { type: "string", pattern: "^compaction-epoch-[a-f0-9-]{36}$" },
          continuation_token: { type: "string", minLength: 32 },
          current_user_turn_id: { type: "integer", minimum: 0 },
        },
        required: ["project_root", "epoch_id", "continuation_token", "current_user_turn_id"],
        additionalProperties: false,
      },
    },
    mcp: {
      args: (args) => [
        { root: args.project_root, epochId: args.epoch_id, continuationToken: args.continuation_token, currentUserTurnId: args.current_user_turn_id },
      ],
    },
    cli: {
      command: "compact-continue",
      flags: ["input"],
      args: ({ root, options, inputJson }) => [{ ...inputJson(options, "Compaction continuation"), root }],
    },
    impl: () => import("./compaction-recovery.mjs").then((module) => module.continueCompaction),
  },
  {
    name: "lode_compact_status",
    tool: {
      name: "lode_compact_status",
      description: "Read the current compaction epoch and digest-verified Session/Run checkpoint without disclosing the continuation token.",
      inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 } }, required: ["project_root"], additionalProperties: false },
    },
    mcp: { args: (args) => [{ root: args.project_root }] },
    cli: { command: "compact-status", flags: [], args: ({ root }) => [{ root }] },
    impl: () => import("./compaction-recovery.mjs").then((module) => module.inspectCompaction),
  },
  {
    name: "lode_compact_abort",
    tool: {
      name: "lode_compact_abort",
      description: "Abort one open compaction epoch without changing its canonical Session/Run checkpoint or Product Canon.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          epoch_id: { type: "string", pattern: "^compaction-epoch-[a-f0-9-]{36}$" },
          reason: { type: "string", minLength: 1 },
        },
        required: ["project_root", "epoch_id", "reason"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root, epochId: args.epoch_id, reason: args.reason }] },
    cli: { command: "compact-abort", flags: ["input"], args: ({ root, options, inputJson }) => [{ ...inputJson(options, "Compaction abort"), root }] },
    impl: () => import("./compaction-recovery.mjs").then((module) => module.abortCompaction),
  },
  {
    name: "lode_product_signal_record",
    tool: {
      name: "lode_product_signal_record",
      description: "Record an immutable observed-fact ProductSignal and rebuild the derived Product Graph without changing Product Canon.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          statement: { type: "string", minLength: 1 },
          observed_at: { type: "string", format: "date-time" },
          source: { type: "string" },
          evidence_ids: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
        },
        required: ["project_root", "statement"],
        additionalProperties: false,
      },
    },
    mcp: {
      args: (args) => [
        { root: args.project_root, statement: args.statement, observedAt: args.observed_at, source: args.source || "", evidenceIds: args.evidence_ids || [] },
      ],
    },
    cli: { command: "product-signal-record", flags: ["input"], args: ({ root, options, inputJson }) => [{ ...inputJson(options, "ProductSignal"), root }] },
    impl: () => import("../world/product-operating-loop.mjs").then((module) => module.recordProductSignal),
  },
  {
    name: "lode_product_hypothesis_record",
    tool: {
      name: "lode_product_hypothesis_record",
      description: "Record an immutable non-authoritative hypothesis linked to ProductSignals and/or exact common Observation identities.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          statement: { type: "string", minLength: 1 },
          rationale: { type: "string" },
          signal_ids: { type: "array", uniqueItems: true, items: { type: "string", pattern: "^product-signal-[a-f0-9]{24}$" } },
          observation_ids: { type: "array", uniqueItems: true, items: { type: "string", pattern: "^(observation|derived-observation)-[a-f0-9]{24}$" } },
        },
        required: ["project_root", "statement"],
        additionalProperties: false,
      },
    },
    mcp: {
      args: (args) => [
        {
          root: args.project_root,
          statement: args.statement,
          rationale: args.rationale || "",
          signalIds: args.signal_ids || [],
          observationIds: args.observation_ids || [],
        },
      ],
    },
    cli: {
      command: "product-hypothesis-record",
      flags: ["input"],
      args: ({ root, options, inputJson }) => [{ ...inputJson(options, "ProductHypothesis"), root }],
    },
    impl: () => import("../world/product-operating-loop.mjs").then((module) => module.recordProductHypothesis),
  },
  {
    name: "lode_product_initiative_propose",
    tool: {
      name: "lode_product_initiative_propose",
      description:
        "Propose a Product Initiative from persisted hypotheses or inline reasoning. Feature resolution may be deferred to explicit review; proposal never approves the initiative or mutates Product Canon.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 },
          description: { type: "string" },
          reasoning: { type: "string" },
          hypothesis_ids: { type: "array", uniqueItems: true, items: { type: "string", pattern: "^product-hypothesis-[a-f0-9]{24}$" } },
          feature_resolution: {
            oneOf: [
              {
                type: "object",
                properties: { kind: { const: "existing-feature" }, feature_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" } },
                required: ["kind", "feature_key"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  kind: { const: "candidate" },
                  feature: {
                    type: "object",
                    properties: {
                      key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
                      name: { type: "string", minLength: 1 },
                      description: { type: "string" },
                      capability_keys: { type: "array", uniqueItems: true, items: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" } },
                    },
                    required: ["key", "name"],
                    additionalProperties: false,
                  },
                },
                required: ["kind", "feature"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: { kind: { const: "gap" }, reason: { type: "string", minLength: 1 } },
                required: ["kind", "reason"],
                additionalProperties: false,
              },
            ],
          },
        },
        required: ["project_root", "title"],
        additionalProperties: false,
      },
    },
    mcp: {
      args: (args) => [
        {
          root: args.project_root,
          title: args.title,
          description: args.description || "",
          reasoning: args.reasoning || "",
          hypothesisIds: args.hypothesis_ids || [],
          featureResolution: args.feature_resolution == null ? null : productFeatureResolutionFromMcp(args.feature_resolution),
        },
      ],
    },
    cli: {
      command: "product-initiative-propose",
      flags: ["input"],
      args: ({ root, options, inputJson }) => [{ ...inputJson(options, "ProductInitiativeCandidate"), root }],
    },
    impl: () => import("../world/product-operating-loop.mjs").then((module) => module.proposeProductInitiative),
  },
  {
    name: "lode_product_initiative_review",
    tool: {
      name: "lode_product_initiative_review",
      description:
        "Record the user's explicit accept/reject ReviewDecision for one Product Initiative candidate. Acceptance resolves any deferred Feature mapping, creates a separate reviewed Initiative, and never mutates Product Canon.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          initiative_candidate_id: { type: "string", pattern: "^product-initiative-candidate-[a-f0-9]{24}$" },
          disposition: { type: "string", enum: ["accept", "reject"] },
          rationale: { type: "string", minLength: 1 },
          confirm_user_review: { type: "boolean" },
          feature_resolution: {
            oneOf: [
              {
                type: "object",
                properties: { kind: { const: "existing-feature" }, feature_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" } },
                required: ["kind", "feature_key"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  kind: { const: "candidate" },
                  feature: {
                    type: "object",
                    properties: {
                      key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
                      name: { type: "string", minLength: 1 },
                      description: { type: "string" },
                      capability_keys: { type: "array", uniqueItems: true, items: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" } },
                    },
                    required: ["key", "name"],
                    additionalProperties: false,
                  },
                },
                required: ["kind", "feature"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: { kind: { const: "gap" }, reason: { type: "string", minLength: 1 } },
                required: ["kind", "reason"],
                additionalProperties: false,
              },
            ],
          },
        },
        required: ["project_root", "initiative_candidate_id", "disposition", "rationale", "confirm_user_review"],
        additionalProperties: false,
      },
    },
    mcp: {
      before: (args) =>
        requireMcpConfirmation(
          args.confirm_user_review,
          "Product Initiative review requires explicit user confirmation.",
          "PRODUCT_INITIATIVE_REVIEW_CONFIRMATION_REQUIRED",
        ),
      args: (args) => [
        {
          root: args.project_root,
          initiativeCandidateId: args.initiative_candidate_id,
          disposition: args.disposition,
          rationale: args.rationale,
          featureResolution: args.feature_resolution == null ? null : productFeatureResolutionFromMcp(args.feature_resolution),
        },
      ],
    },
    cli: {
      command: "product-initiative-review",
      flags: ["input"],
      args: ({ root, options, inputJson }) => [{ ...inputJson(options, "Product Initiative ReviewDecision"), root }],
    },
    impl: () => import("../world/product-operating-loop.mjs").then((module) => module.reviewProductInitiative),
  },
  {
    name: "lode_product_outcome_observe",
    tool: {
      name: "lode_product_outcome_observe",
      description:
        "Record observed or derived outcome evidence bound to an accepted ChangeSet, ResultPacket, and execution ReviewDecision without judging success or changing Feature status.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          change_set_id: { type: "string", pattern: "^change-set-[a-f0-9]{24}$" },
          initiative_id: { type: "string", pattern: "^reviewed-product-initiative-[a-f0-9]{24}$" },
          statement: { type: "string", minLength: 1 },
          epistemic_class: { type: "string", enum: ["observed-fact", "derived-projection"] },
          evidence_ids: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
        },
        required: ["project_root", "change_set_id", "statement"],
        additionalProperties: false,
      },
    },
    mcp: {
      args: (args) => [
        {
          root: args.project_root,
          changeSetId: args.change_set_id,
          initiativeId: args.initiative_id || "",
          statement: args.statement,
          epistemicClass: args.epistemic_class || "observed-fact",
          evidenceIds: args.evidence_ids || [],
        },
      ],
    },
    cli: {
      command: "product-outcome-observe",
      flags: ["input"],
      args: ({ root, options, inputJson }) => [{ ...inputJson(options, "OutcomeObservation"), root }],
    },
    impl: () => import("../world/product-operating-loop.mjs").then((module) => module.observeProductOutcome),
  },
  {
    name: "lode_product_operating_status",
    tool: {
      name: "lode_product_operating_status",
      description:
        "Read Product Operating Loop artifacts and authority classes, reusing a disclosed write-invalidated verified-snapshot cache unless fresh verification is requested.",
      inputSchema: {
        type: "object",
        properties: { project_root: { type: "string", minLength: 1 }, fresh: { type: "boolean", default: false } },
        required: ["project_root"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root, fresh: args.fresh ?? false }] },
    cli: { command: "product-operating-status", flags: ["fresh"], args: ({ root, options }) => [{ root, fresh: options.fresh === true }] },
    impl: () => import("../world/product-operating-loop.mjs").then((module) => module.inspectProductOperatingLoop),
  },
  {
    name: "lode_release_observe",
    tool: {
      name: "lode_release_observe",
      description:
        "Record a host-supplied deployment result and current product Git refs as immutable P3 evidence. A ReleaseObservation is created only for an approved successful result whose exact commit is reachable and present on a current product ref; this never approves deployment or changes Product Canon.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          environment_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
          status: { type: "string", enum: ["succeeded", "failed", "cancelled"] },
          commit: { type: "string", pattern: "^[a-fA-F0-9]{40,64}$" },
          observed_at: { type: "string", format: "date-time" },
          source_event_key_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
          deployment_evidence_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
          approved: { type: "boolean" },
          approval_evidence_digest: { anyOf: [{ type: "string", pattern: "^[a-f0-9]{64}$" }, { type: "null" }] },
          change_set_id: { anyOf: [{ type: "string", pattern: "^change-set-[a-f0-9]{24}$" }, { type: "null" }] },
          vcs_evidence_id: { anyOf: [{ type: "string", pattern: "^vcs-evidence-[a-f0-9]{24}$" }, { type: "null" }] },
          confirm_host_observation: { type: "boolean" },
        },
        required: [
          "project_root",
          "environment_key",
          "status",
          "commit",
          "observed_at",
          "source_event_key_digest",
          "deployment_evidence_digest",
          "approved",
          "approval_evidence_digest",
          "change_set_id",
          "vcs_evidence_id",
          "confirm_host_observation",
        ],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    mcp: {
      before: (args) =>
        requireMcpConfirmation(
          args.confirm_host_observation,
          "Release observation requires explicit confirmation that the payload came from a host deployment observer.",
          "RELEASE_HOST_OBSERVATION_CONFIRMATION_REQUIRED",
        ),
      args: (args) => [
        {
          root: args.project_root,
          input: {
            environmentKey: args.environment_key,
            status: args.status,
            commit: args.commit,
            observedAt: args.observed_at,
            sourceEventKeyDigest: args.source_event_key_digest,
            deploymentEvidenceDigest: args.deployment_evidence_digest,
            approved: args.approved,
            approvalEvidenceDigest: args.approval_evidence_digest,
            changeSetId: args.change_set_id,
            vcsEvidenceId: args.vcs_evidence_id,
          },
        },
      ],
    },
    cli: {
      command: "release-observe",
      flags: ["input"],
      args: ({ root, options, inputJson }) => [{ root, input: inputJson(options, "DeploymentResultObservation") }],
    },
    impl: () => import("../distribution/release-observation.mjs").then((module) => module.observeReleaseState),
  },
  {
    name: "lode_release_status",
    tool: {
      name: "lode_release_status",
      description:
        "Read digest-verified P3 BranchState, DeploymentResult, and Release observations. The projection is evidence-only and has no Product Canon, execution, or recovery authority.",
      inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 } }, required: ["project_root"], additionalProperties: false },
    },
    mcp: { args: (args) => [{ root: args.project_root }] },
    cli: { command: "release-status", flags: [], args: ({ root }) => [{ root }] },
    impl: () => import("../distribution/release-observation.mjs").then((module) => module.inspectReleaseObservations),
  },
  {
    name: "lode_observation_sources",
    tool: {
      name: "lode_observation_sources",
      description:
        "Page and exactly filter provider-neutral Host-injected Observation source IDs with bounded descriptor shape and Host-local availability hints. Stale read-only cursors restart at the first page with disclosure; no external source is read.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          type_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$" },
          adapter_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$" },
          availability: { type: "string", enum: ["unknown", "ready", "auth-missing", "rate-limited", "unavailable"] },
          limit: { type: "integer", minimum: 1, maximum: 64 },
          projection_id: { type: "string", pattern: "^observation-source-projection-[a-f0-9]{24}$" },
          cursor: { type: "string", pattern: "^observation-source-[a-f0-9]{24}$" },
        },
        required: ["project_root"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: {
      args: (args, { observationRegistry }) => [
        {
          root: args.project_root,
          registry: observationRegistry,
          typeKey: args.type_key || "",
          adapterKey: args.adapter_key || "",
          availabilityState: args.availability || "",
          limit: args.limit ?? 64,
          projectionId: args.projection_id || "",
          cursor: args.cursor || "",
        },
      ],
    },
    cli: {
      command: "observation-sources",
      flags: ["adapter-key", "availability", "cursor", "limit", "projection", "type-key"],
      args: ({ root, options, observationRegistry }) => [
        {
          root,
          registry: observationRegistry,
          typeKey: options["type-key"] || "",
          adapterKey: options["adapter-key"] || "",
          availabilityState: options.availability || "",
          limit: options.limit == null ? undefined : Number(options.limit),
          projectionId: options.projection || "",
          cursor: options.cursor || "",
        },
      ],
    },
    impl: () => import("../world/observation-adapter.mjs").then((module) => module.inspectObservationSources),
  },
  {
    name: "lode_observation_prepare",
    tool: {
      name: "lode_observation_prepare",
      description:
        "Prepare one reuse-first, non-persisted Observation view for an exact type selected by provider Lode. It returns existing current Observation IDs before configured source IDs and never judges sufficiency, selects a source, collects data, or asks the user for provenance JSON.",
      inputSchema: {
        type: "object",
        properties: {
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
        },
        required: ["project_root", "type_key"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: {
      args: (args, { observationRegistry }) => [
        {
          root: args.project_root,
          registry: observationRegistry,
          typeKey: args.type_key,
          subjectType: args.subject_type || "",
          subjectKey: args.subject_key || "",
          adapterKey: args.adapter_key || "",
          observedAfter: args.observed_after || "",
          observedBefore: args.observed_before || "",
          existingLimit: args.existing_limit ?? 20,
          sourceLimit: args.source_limit ?? 20,
          sourceAvailability: args.source_availability || "",
          sourceProjectionId: args.source_projection_id || "",
          sourceCursor: args.source_cursor || "",
        },
      ],
    },
    cli: {
      command: "observation-prepare",
      flags: [
        "adapter-key",
        "existing-limit",
        "observed-after",
        "observed-before",
        "source-availability",
        "source-cursor",
        "source-limit",
        "source-projection",
        "subject-key",
        "subject-type",
        "type-key",
      ],
      args: ({ root, options, observationRegistry }) => [
        {
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
        },
      ],
    },
    impl: () => import("../world/observation-workflow.mjs").then((module) => module.prepareObservationEvidence),
  },
  {
    name: "lode_observation_collect_source",
    tool: {
      name: "lode_observation_collect_source",
      description:
        "Collect one configured Host source by its bounded opaque source ID. The trusted Host owns paths, credentials, descriptor, scope, and provenance; this tool accepts none of them and records only non-authoritative P3 Observation evidence.",
      inputSchema: {
        type: "object",
        properties: { project_root: { type: "string", minLength: 1 }, source_id: { type: "string", pattern: "^observation-source-[a-f0-9]{24}$" } },
        required: ["project_root", "source_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    mcp: { args: (args, { observationRegistry }) => [{ root: args.project_root, registry: observationRegistry, sourceId: args.source_id }] },
    cli: {
      command: "observation-source-collect",
      flags: ["source"],
      args: ({ root, options, observationRegistry }) => [{ root, registry: observationRegistry, sourceId: options.source }],
    },
    impl: () => import("../world/observation-adapter.mjs").then((module) => module.collectRegisteredObservation),
  },
  {
    name: "lode_observation_ingest",
    tool: {
      name: "lode_observation_ingest",
      description:
        "Ingest one already constructed bounded CI or Host Observation. The Host adapter owns source access, binding, digests, coverage, and provenance confirmation; this tool does not ask the user to attest to machine evidence.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          binding: observationBindingSchema,
          descriptor: observationDescriptorSchema,
          observation: observationInputSchema,
          confirm_host_observation: { type: "boolean" },
        },
        required: ["project_root", "binding", "descriptor", "observation", "confirm_host_observation"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    mcp: {
      before: (args) =>
        requireMcpConfirmation(
          args.confirm_host_observation,
          "Observation collection requires explicit confirmation that the payload came from the exact Host source binding.",
          "OBSERVATION_HOST_CONFIRMATION_REQUIRED",
        ),
      args: (args) => [
        {
          root: args.project_root,
          binding: observationBindingFromMcp(args.binding),
          descriptor: observationDescriptorFromMcp(args.descriptor),
          input: observationInputFromMcp(args.observation),
        },
      ],
    },
    cli: {
      command: "observation-ingest",
      flags: ["input"],
      args: ({ root, options, inputJson }) => {
        const value = inputJson(options, "Observation collection");
        return [{ root, binding: value.binding, descriptor: value.descriptor, input: value.input }];
      },
    },
    impl: () => import("../world/observation-adapter.mjs").then((module) => module.ingestStructuredObservation),
  },
  {
    name: "lode_observation_derive",
    tool: {
      name: "lode_observation_derive",
      description:
        "Record a deterministic P3 derived Observation from exact existing Observation IDs and an algorithm digest. It cannot assert causality or Product success.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          descriptor: observationDescriptorSchema,
          subject: {
            type: "object",
            properties: { type: { type: "string", minLength: 1 }, key: { type: "string", minLength: 1 } },
            required: ["type", "key"],
            additionalProperties: false,
          },
          temporal_scope: observationInputSchema.properties.temporal_scope,
          input_observation_ids: {
            type: "array",
            minItems: 1,
            maxItems: 64,
            uniqueItems: true,
            items: { type: "string", pattern: "^observation-[a-f0-9]{24}$" },
          },
          algorithm: {
            type: "object",
            properties: {
              key: { type: "string", minLength: 1 },
              version: { type: "string", minLength: 1 },
              digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
            },
            required: ["key", "version", "digest"],
            additionalProperties: false,
          },
          coverage: observationCoverageSchema,
          payload: { type: "object" },
          confirm_host_derivation: { type: "boolean" },
        },
        required: [
          "project_root",
          "descriptor",
          "subject",
          "temporal_scope",
          "input_observation_ids",
          "algorithm",
          "coverage",
          "payload",
          "confirm_host_derivation",
        ],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: {
      before: (args) =>
        requireMcpConfirmation(
          args.confirm_host_derivation,
          "Derived Observation recording requires explicit confirmation that the payload came from the named deterministic algorithm.",
          "OBSERVATION_DERIVATION_CONFIRMATION_REQUIRED",
        ),
      args: (args) => [
        {
          root: args.project_root,
          descriptor: observationDescriptorFromMcp(args.descriptor),
          input: {
            subject: args.subject,
            temporalScope: { observedAt: args.temporal_scope.observed_at, start: args.temporal_scope.start, end: args.temporal_scope.end },
            inputObservationIds: args.input_observation_ids,
            algorithm: args.algorithm,
            coverage: observationCoverageFromMcp(args.coverage),
            payload: args.payload,
          },
        },
      ],
    },
    cli: {
      command: "observation-derive",
      flags: ["input"],
      args: ({ root, options, inputJson }) => {
        const value = inputJson(options, "Derived Observation");
        return [{ root, descriptor: value.descriptor, input: value.input }];
      },
    },
    impl: () => import("../world/observation-store.mjs").then((module) => module.recordDerivedObservation),
  },
  {
    name: "lode_conversation_enter",
    tool: {
      name: "lode_conversation_enter",
      description:
        "Obtain missing current conversation context, or reuse sufficient verified supplied entry for the exact selected Session and current common direction. This read-only entry restores verified P2 direction and returns bounded status, Attention and package facts; detailed World freshness is explicitly not inspected. No continuation, provider attachment, review, Canon change or ordinary-work gate is created. Explicit project status retains full optional diagnostics when needed.",
      inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 } }, required: ["project_root"], additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: { args: (args, { readRelatedNativeContext }) => [{ root: args.project_root, readRelatedNativeContext }] },
    cli: { command: "conversation-enter", flags: [], args: ({ root }) => [{ root }] },
    impl: () => import("./compaction-lifecycle.mjs").then((module) => module.enterConversationRecovery),
  },
  {
    name: "lode_compaction_lifecycle_step",
    tool: {
      name: "lode_compaction_lifecycle_step",
      description:
        "Process one Host-injected provider-neutral compaction lifecycle event. The Host owns event delivery and compaction; Core restores P2 first, retains transport tokens only in P5, and never asks the user for event, epoch, turn, or token JSON. Without an injected Host adapter this is a non-blocking unavailable capability.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          direction: {
            type: "object",
            description:
              "Optional current recovery direction authored by provider Lode at a before-compaction boundary. Omit to reuse the exact current checkpoint.",
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
        },
        required: ["project_root"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: {
      args: (args, { compactionLifecycleHost }) => [
        {
          root: args.project_root,
          hostAdapter: compactionLifecycleHost,
          direction:
            args.direction == null
              ? null
              : {
                  purpose: args.direction.purpose,
                  approvedDecisions: args.direction.approved_decisions,
                  currentPosition: args.direction.current_position,
                  nextExpectedResult: args.direction.next_expected_result,
                  openReviewIds: args.direction.open_review_ids,
                },
        },
      ],
    },
    cli: {
      command: "compaction-lifecycle-step",
      flags: ["input"],
      args: ({ root, options, inputJson, compactionLifecycleHost }) => [
        { root, hostAdapter: compactionLifecycleHost, direction: options.input ? inputJson(options, "Lode compaction direction") : null },
      ],
    },
    impl: () => import("./compaction-lifecycle.mjs").then((module) => module.processCompactionLifecycle),
  },
  {
    name: "lode_observation_read",
    tool: {
      name: "lode_observation_read",
      description: "Read one exact digest-verified observed or derived Observation by ID with its descriptor and bounded receipt or derivation lineage.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          observation_id: { type: "string", pattern: "^(?:observation|derived-observation)-[a-f0-9]{24}$" },
        },
        required: ["project_root", "observation_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root, observationId: args.observation_id }] },
    cli: { command: "observation-read", flags: ["observation"], args: ({ root, options }) => [{ root, observationId: options.observation }] },
    impl: () => import("../world/observation-store.mjs").then((module) => module.readObservation),
  },
  {
    name: "lode_observation_query",
    tool: {
      name: "lode_observation_query",
      description:
        "Read global retained inventory counts and query a bounded P4 page of current Observation identities by exact type, subject, source, time, and record-kind filters. This is discovery only; it does not select semantic relevance or make records Context-eligible.",
      inputSchema: {
        type: "object",
        properties: {
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
        },
        required: ["project_root"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: {
      args: (args) => [
        {
          root: args.project_root,
          typeKey: args.type_key || "",
          subjectType: args.subject_type || "",
          subjectKey: args.subject_key || "",
          adapterKey: args.adapter_key || "",
          observedAfter: args.observed_after || "",
          observedBefore: args.observed_before || "",
          recordKind: args.record_kind || "all",
          limit: args.limit ?? 25,
          projectionId: args.projection_id || "",
          cursor: args.cursor || "",
        },
      ],
    },
    cli: {
      command: "observation-query",
      flags: ["adapter-key", "cursor", "limit", "observed-after", "observed-before", "projection", "record-kind", "subject-key", "subject-type", "type-key"],
      args: ({ root, options }) => [
        {
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
        },
      ],
    },
    impl: () => import("../world/observation-projection.mjs").then((module) => module.queryObservations),
  },
  {
    name: "lode_continuity_snapshot",
    tool: {
      name: "lode_continuity_snapshot",
      description:
        "Build an on-demand non-persisted derived reference view over exact Session, Run, lineage, product, and graph identities, with optional forced fresh verification. It is not recovery canon or Lode judgment authority.",
      inputSchema: {
        type: "object",
        properties: { project_root: { type: "string", minLength: 1 }, fresh: { type: "boolean", default: false } },
        required: ["project_root"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root, fresh: args.fresh ?? false }] },
    impl: () => import("../world/product-operating-loop.mjs").then((module) => module.buildHeadContinuitySnapshot),
  },
  {
    name: "lode_project_graph",
    cli: {
      command: "graph-query",
      flags: [
        "anchors",
        "depth",
        "details",
        "inventory-cursor",
        "inventory-page",
        "inventory-paths",
        "max-edges",
        "max-nodes",
        "paths",
        "query",
        "view",
        "world-model",
      ],
      handle: async (context) => {
        const { root, options } = context;
        return import("../world/project-graph.mjs").then(({ queryProjectGraph }) =>
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
      },
    },
    tool: {
      name: "lode_project_graph",
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
          previous_result: { type: "object", description: "Optional prior verified result for identical-basis reuse, supplied by Lode." },
        },
        required: ["project_root"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    mcp: {
      args: (args) => [
        {
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
        },
      ],
    },
    impl: () => import("../world/project-graph.mjs").then((module) => module.queryProjectGraph),
  },
  {
    name: "lode_project_graph_index",
    tool: {
      name: "lode_project_graph_index",
      description:
        "Refresh the replaceable graph inventory from existing verified records and observations. Reuse unchanged inputs; no Product approval, execution, checkpoint or semantic inference.",
      inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 } }, required: ["project_root"], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root }] },
    cli: { command: "graph-index", flags: [], args: ({ root }) => [{ root }] },
    impl: () => import("../world/project-graph.mjs").then((module) => module.indexProjectGraph),
  },
  {
    name: "lode_session_create",
    cli: {
      command: "session-create",
      flags: ["new-session", "purpose"],
      handle: async (context) => {
        const { root, options } = context;
        const { createLodeSession } = await import("./session-routing.mjs");
        return createLodeSession({ root, sessionId: options["new-session"], purpose: options.purpose });
      },
    },
    tool: {
      name: "lode_session_create",
      description:
        "Create or reuse an independent logical Lode Session within the canonical Project. Preserve the default Session and every existing active/unknown operation. Lode chooses the route; users need no ID form.",
      inputSchema: {
        type: "object",
        properties: { project_root: { type: "string", minLength: 1 }, purpose: { type: "string" }, new_session_id: { type: "string" } },
        required: ["project_root"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root, sessionId: args.new_session_id, purpose: args.purpose }] },
    impl: () => import("./session-routing.mjs").then((module) => module.createHeadSession),
  },
  {
    name: "lode_conversation_list",
    tool: {
      name: "lode_conversation_list",
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
    mcp: {
      args: (args, { caller, hostEnvironment }) => [{ root: args.project_root, caller, environment: hostEnvironment, hostTicket: args.host_ticket ?? null }],
    },
    impl: () => import("./conversation-messaging.mjs").then((module) => module.listProjectConversations),
  },
  {
    name: "lode_conversation_send",
    tool: {
      name: "lode_conversation_send",
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
    mcp: {
      args: (args, { caller, hostEnvironment, signal }) => [
        {
          root: args.project_root,
          caller,
          environment: hostEnvironment,
          to: args.to,
          body: args.body,
          replyTo: args.reply_to ?? null,
          hostTicket: args.host_ticket ?? null,
          waitMs: Number(hostEnvironment?.LODE_CONVERSATION_DELIVERY_WAIT_MS || 0),
          signal,
        },
      ],
    },
    impl: () => import("./conversation-messaging.mjs").then((module) => module.sendProjectConversation),
  },
  {
    name: "lode_session_list",
    cli: {
      command: "session-list",
      flags: [],
      handle: async (context) => {
        const { root } = context;
        const { readSessionWorkList } = await import("./session-work-context.mjs");
        return readSessionWorkList({ root });
      },
    },
    tool: {
      name: "lode_session_list",
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
    mcp: {
      args: (args, { hostEnvironment }) => [
        {
          root: args.project_root,
          sessionId: args.session_id ?? null,
          maxSessions: args.max_sessions ?? 16,
          afterSessionId: args.after_session_id ?? null,
          conversationCandidates: args.conversation_candidates,
          conversationEnvironment: hostEnvironment,
        },
      ],
    },
    impl: () => import("./session-work-context.mjs").then((module) => module.readSessionWorkList),
  },
  {
    name: "lode_project_direction_read",
    tool: {
      name: "lode_project_direction_read",
      description:
        "Read the current common user-directed goal, constraints and cancellation across Sessions. Historical graphs/checkpoints cannot override it.",
      inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 } }, required: ["project_root"], additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root }] },
    cli: { command: "project-direction-read", flags: [], args: ({ root }) => [{ root }] },
    impl: () => import("./session-routing.mjs").then((module) => module.readProjectDirection),
  },
  {
    name: "lode_project_direction_update",
    tool: {
      name: "lode_project_direction_update",
      description:
        "Record a current user direction against the exact common-direction basis; identical retry reuses it. Lode conveys the user's scoped decision. Observed evidence, projected approval and model consensus cannot author direction or grant deployment/Canon authority. A Host-verified caller may omit expected_direction_id after its status, entry, init/resume or own update showed the current direction.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          expected_direction_id: { type: ["string", "null"] },
          direction: {
            type: "object",
            properties: {
              goal: { type: "string" },
              constraints: { type: "array", items: { type: "string" } },
              decisions: { type: "array", items: { type: "string" } },
              cancelledActions: { type: "array", items: { type: "string" } },
            },
            required: ["goal", "constraints", "decisions", "cancelledActions"],
            additionalProperties: false,
          },
        },
        required: ["project_root", "direction"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root, expectedDirectionId: args.expected_direction_id, input: args.direction }] },
    cli: {
      command: "project-direction-update",
      flags: ["expected-direction", "input"],
      args: ({ root, options, inputJson }) => [
        { root, expectedDirectionId: options["expected-direction"] || null, input: inputJson(options, "Current user Project direction") },
      ],
    },
    impl: () => import("./session-routing.mjs").then((module) => module.updateProjectDirection),
  },
  {
    name: "lode_run_start",
    tool: {
      name: "lode_run_start",
      description:
        "Start the existing contract-bound Run transaction. An optional Core request key makes exact retries converge; historical acknowledgments never authorize provider/worker replay. Lode supplies the key without another prepare call or user form.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          execution_contract_id: { type: "string", pattern: "^execution-contract-[a-f0-9]{24}$" },
          start_request_id: { type: "string", minLength: 1, maxLength: 256 },
        },
        required: ["project_root", "execution_contract_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root, executionContractId: args.execution_contract_id, startRequestId: args.start_request_id }] },
    cli: {
      command: "run-start",
      flags: ["contract", "start-request"],
      args: ({ root, options }) => [{ root, executionContractId: options.contract, startRequestId: options["start-request"] }],
    },
    impl: () => import("../runtime/run-lineage.mjs").then((module) => module.startRun),
  },
  {
    name: "cli:help",
    cli: {
      command: "help",
      aliases: ["--help", "-h"],
      flags: [],
      handle: async (context) => {
        const { surface, usage } = context;
        return usage({ surface });
      },
    },
  },
  {
    name: "cli:help-all",
    cli: {
      command: "help-all",
      flags: [],
      handle: async (context) => {
        const { surface, usage } = context;
        return usage({ all: true, surface });
      },
    },
  },
  {
    name: "cli:--version",
    cli: {
      command: "--version",
      aliases: ["version"],
      flags: [],
      handle: async (context) => {
        const { packageMetadata } = context;
        const { ARTIFACT_COMPOSITION } = await import("../lode-artifact-composition.mjs");
        return { name: ARTIFACT_COMPOSITION.pluginName, version: packageMetadata.version };
      },
    },
  },
  {
    name: "cli:graph-explorer",
    cli: {
      command: "graph-explorer",
      flags: ["anchors", "history", "layer", "output", "paths", "query", "share"],
      handle: async (context) => {
        const { root, options } = context;
        return import("../world/graph-explorer.mjs").then(({ exportGraphExplorer }) =>
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
      },
    },
  },
  {
    name: "cli:runtime-invocation-authorize",
    cli: {
      command: "runtime-invocation-authorize",
      flags: ["input"],
      handle: async (context) => {
        const { root, options, command, surface, inputJson } = context;
        const { requireOperationSurface } = await import("./managed-maintenance-surface.mjs");
        const { inspectRuntimeAdapters } = await import("./lode-core.mjs");
        const { buildRuntimeInvocationAuthorization } = await import("../runtime/runtime-invocation-lifecycle.mjs");
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
      },
    },
  },
  {
    name: "cli:runtime-invocation-execute",
    cli: {
      command: "runtime-invocation-execute",
      flags: ["authorization", "input"],
      handle: async (context) => {
        const { root, options, command, surface, onProcess, signal, optionalInputJson, requireRuntimeSurface } = context;
        const { inspectRuntimeAdapters } = await import("./lode-core.mjs");
        const { readRuntimeInvocationAuthorization } = await import("../runtime/runtime-invocation-lifecycle.mjs");
        const { executeRuntimeInvocation } = await import("../runtime/runtime-one-shot-exec.mjs");
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
      },
    },
  },
  {
    name: "cli:runtime-invocation-apply-run-result",
    cli: {
      command: "runtime-invocation-apply-run-result",
      flags: ["authorization"],
      handle: async (context) => {
        const { root, options, command, surface, requireRuntimeSurface } = context;
        const { resolveProjectStorage } = await import("../storage/project-storage-format.mjs");
        const { readRuntimeInvocationAuthorization } = await import("../runtime/runtime-invocation-lifecycle.mjs");
        const { applyRuntimeRunResult } = await import("../runtime/runtime-run-result-application.mjs");
        const authorization = readRuntimeInvocationAuthorization({ root, authorizationId: options.authorization }).authorization;
        requireRuntimeSurface(command, surface, root, authorization);
        return applyRuntimeRunResult({ root, authorizationId: options.authorization, storage: resolveProjectStorage(root) });
      },
    },
  },
  {
    name: "cli:worker-execute",
    cli: {
      command: "worker-execute",
      flags: ["authorization", "input", "role"],
      handle: async (context) => {
        const { root, options, onProcess, signal, inputJson } = context;
        const { inspectRuntimeAdapters } = await import("./lode-core.mjs");
        const { executeBoundedWorkerDispatch } = await import("../worker/bounded-worker-dispatch.mjs");
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
      },
    },
  },
  {
    name: "cli:onboarding-start",
    cli: {
      command: "onboarding-start",
      flags: ["input"],
      handle: async (context) => {
        const { root, options, optionalInputJson } = context;
        const { startOnboarding } = await import("./onboarding.mjs");
        return await startOnboarding({ ...optionalInputJson(options, "Onboarding start"), root });
      },
    },
  },
  {
    name: "cli:onboarding-candidates",
    cli: {
      command: "onboarding-candidates",
      flags: ["candidate-set"],
      handle: async (context) => {
        const { root, options } = context;
        const { readOnboardingCandidateSet } = await import("./onboarding.mjs");
        return readOnboardingCandidateSet({ root, candidateSetId: options["candidate-set"] });
      },
    },
  },
  {
    name: "cli:onboarding-review-read",
    cli: {
      command: "onboarding-review-read",
      flags: ["review"],
      handle: async (context) => {
        const { root, options } = context;
        const { readOnboardingReviewDecision } = await import("./onboarding.mjs");
        return readOnboardingReviewDecision({ root, reviewDecisionId: options.review });
      },
    },
  },
  {
    name: "cli:source-scope-set",
    cli: {
      command: "source-scope-set",
      flags: ["input"],
      handle: async (context) => {
        const { root, options, inputJson } = context;
        const { inspectProject } = await import("./lode-core.mjs");
        const { writeRepositorySourceScope } = await import("../world/repository-source-scope.mjs");
        const inspected = inspectProject(root);
        if (inspected.status !== "ready") throw new Error(`Project must be ready to configure source scope; current status: ${inspected.status}.`);
        return writeRepositorySourceScope({
          projectRoot: inspected.project.projectRoot,
          selection: inputJson(options, "Repository source scope"),
          storage: inspected.storage,
        });
      },
    },
  },
  {
    name: "cli:source-scope-status",
    cli: {
      command: "source-scope-status",
      flags: [],
      handle: async (context) => {
        const { root } = context;
        const { inspectProject } = await import("./lode-core.mjs");
        const { readRepositorySourceScope } = await import("../world/repository-source-scope.mjs");
        const inspected = inspectProject(root);
        if (inspected.status === "not_initialized") throw new Error("Lode Agent Core is not initialized.");
        return readRepositorySourceScope({ projectRoot: inspected.project.projectRoot, storage: inspected.storage });
      },
    },
  },
  {
    name: "cli:feature-mapping-candidates",
    cli: {
      command: "feature-mapping-candidates",
      flags: ["candidate-set"],
      handle: async (context) => {
        const { root, options } = context;
        const { readFeatureMappingCandidateSet } = await import("../world/feature-mapping.mjs");
        return readFeatureMappingCandidateSet({ root, candidateSetId: options["candidate-set"] });
      },
    },
  },
  {
    name: "cli:feature-mapping-review-read",
    cli: {
      command: "feature-mapping-review-read",
      flags: ["review"],
      handle: async (context) => {
        const { root, options } = context;
        const { readFeatureMappingReviewDecision } = await import("../world/feature-mapping.mjs");
        return readFeatureMappingReviewDecision({ root, reviewDecisionId: options.review });
      },
    },
  },
  {
    name: "cli:change-set-record",
    cli: {
      command: "change-set-record",
      flags: ["input"],
      handle: async (context) => {
        const { root, options, inputJson } = context;
        const { recordChangeSet } = await import("../world/change-set.mjs");
        return await recordChangeSet({ ...inputJson(options, "ChangeSet"), root });
      },
    },
  },
  {
    name: "cli:change-set-read",
    cli: {
      command: "change-set-read",
      flags: ["change-set"],
      handle: async (context) => {
        const { root, options } = context;
        const { readChangeSet } = await import("../world/change-set.mjs");
        return readChangeSet({ root, changeSetId: options["change-set"] });
      },
    },
  },
  {
    name: "cli:change-impact-candidates",
    cli: {
      command: "change-impact-candidates",
      flags: ["candidate-set"],
      handle: async (context) => {
        const { root, options } = context;
        const { readChangeImpactCandidateSet } = await import("../world/change-set.mjs");
        return readChangeImpactCandidateSet({ root, candidateSetId: options["candidate-set"] });
      },
    },
  },
  {
    name: "cli:change-impact-review",
    cli: {
      command: "change-impact-review",
      flags: ["input"],
      handle: async (context) => {
        const { root, options, inputJson } = context;
        const { reviewChangeImpact } = await import("../world/change-set.mjs");
        return await reviewChangeImpact({ ...inputJson(options, "Change impact ReviewDecision"), root });
      },
    },
  },
  {
    name: "cli:change-impact-review-read",
    cli: {
      command: "change-impact-review-read",
      flags: ["review"],
      handle: async (context) => {
        const { root, options } = context;
        const { readChangeImpactReviewDecision } = await import("../world/change-set.mjs");
        return readChangeImpactReviewDecision({ root, reviewDecisionId: options.review });
      },
    },
  },
  {
    name: "cli:change-set-vcs-attach",
    cli: {
      command: "change-set-vcs-attach",
      flags: ["input"],
      handle: async (context) => {
        const { root, options, inputJson } = context;
        const { attachVcsEvidence } = await import("../world/change-set.mjs");
        return await attachVcsEvidence({ ...inputJson(options, "VCS evidence attachment"), root });
      },
    },
  },
  {
    name: "cli:observation-file-ingest",
    cli: {
      command: "observation-file-ingest",
      flags: ["input"],
      handle: async (context) => {
        const { root, options, inputJson } = context;
        const { ingestJsonObservationEventFile } = await import("../world/observation-adapter.mjs");
        const value = inputJson(options, "Host JSON Observation source");
        return await ingestJsonObservationEventFile({
          root,
          sourceKey: value.sourceKey,
          binding: value.binding,
          descriptor: value.descriptor,
          eventFile: value.eventFile,
          maxBytes: value.maxBytes,
        });
      },
    },
  },
  {
    name: "cli:lode-continuity",
    cli: {
      command: "lode-continuity",
      aliases: ["head-continuity"],
      flags: ["fresh"],
      handle: async (context) => {
        const { root, options } = context;
        const { buildLodeContinuitySnapshot } = await import("../world/product-operating-loop.mjs");
        return buildLodeContinuitySnapshot({ root, fresh: options.fresh === true });
      },
    },
  },
  {
    name: "cli:world-index",
    cli: {
      command: "world-index",
      flags: ["git-log", "parent-snapshot", "revision-parents", "runtime-state"],
      handle: async (context) => {
        const { root, options, readJsonFile } = context;
        const { GitLogFileHistoryAdapter } = await import("../world/git-history.mjs");
        const { RuntimeStateFileAdapter } = await import("../runtime/runtime-state.mjs");
        const { buildWorldModel } = await import("../world/world-model.mjs");
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
      },
    },
  },
  {
    name: "cli:storage-gc",
    cli: {
      command: "storage-gc",
      flags: ["apply"],
      handle: async (context) => {
        const { root, options, onProcess, signal } = context;
        const { inspectSnapshotPreservationClosure } = await import("../world/snapshot-preservation-closure.mjs");
        const { inspectSnapshotGarbageCollection, applySnapshotGarbageCollection } = await import("../world/snapshot-gc.mjs");
        if (options.apply === true || options.apply === "true") return await applySnapshotGarbageCollection({ root, signal, onProcess });
        const inspection = inspectSnapshotGarbageCollection({ root });
        try {
          inspection.typedClosure = await inspectSnapshotPreservationClosure({ root });
        } catch (error) {
          inspection.typedClosure = { status: "partial-preserved", reasonCode: error.code || "TYPED_CLOSURE_UNAVAILABLE", deletedCount: 0 };
        }
        return inspection;
      },
    },
  },
  {
    name: "cli:world-status",
    cli: {
      command: "world-status",
      flags: [],
      handle: async (context) => {
        const { root } = context;
        const { inspectWorldModel } = await import("../world/world-model.mjs");
        return await inspectWorldModel({ root });
      },
    },
  },
  {
    name: "cli:world-refresh",
    cli: {
      command: "world-refresh",
      flags: ["expect-changed", "parent-snapshot", "trigger-evidence"],
      handle: async (context) => {
        const { root, options } = context;
        const { refreshWorldModel } = await import("../world/incremental-refresh.mjs");
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
      },
    },
  },
  {
    name: "cli:world-refresh-events",
    cli: {
      command: "world-refresh-events",
      flags: ["input"],
      handle: async (context) => {
        const { root, options, inputJson } = context;
        const { processRefreshTriggerBatch } = await import("../world/refresh-trigger.mjs");
        const input = inputJson(options, "Refresh trigger event ingestion");
        const unexpected = Object.keys(input).filter((key) => !["sourceKind", "events", "maxEvents"].includes(key));
        if (unexpected.length) throw new Error(`Refresh trigger event ingestion contains unsupported fields: ${unexpected.sort().join(", ")}`);
        if (input.sourceKind !== "ci") throw new Error("world-refresh-events accepts only sourceKind ci; use world-refresh-watch for filesystem events.");
        return await processRefreshTriggerBatch({ root, ...input });
      },
    },
  },
  {
    name: "cli:world-refresh-watch",
    cli: {
      command: "world-refresh-watch",
      flags: ["debounce-ms", "max-events"],
      handle: async (context) => {
        const { root, options } = context;
        const { runFileSystemRefreshWatcher } = await import("../world/refresh-trigger.mjs");
        return await runFileSystemRefreshWatcher({
          root,
          debounceMs: options["debounce-ms"] == null ? undefined : Number(options["debounce-ms"]),
          maxEvents: options["max-events"] == null ? undefined : Number(options["max-events"]),
        });
      },
    },
  },
  {
    name: "cli:world-graph-remote-database-initialize",
    cli: {
      command: "world-graph-remote-database-initialize",
      flags: ["confirm-database", "reset-incompatible"],
      handle: async (context) => {
        const { root, options } = context;
        const { resolveProjectStorage } = await import("../storage/project-storage-format.mjs");
        const { initializeArcadeDbDatabase } = await import("../world/arcadedb-database-lifecycle.mjs");
        return initializeArcadeDbDatabase({
          root,
          storage: resolveProjectStorage(root),
          resetIncompatible: options["reset-incompatible"] === "true",
          confirmDatabase: options["confirm-database"] || "",
        });
      },
    },
  },
  {
    name: "cli:world-graph-remote-activate",
    cli: {
      command: "world-graph-remote-activate",
      flags: [],
      handle: async (context) => {
        const { root } = context;
        const { activateArcadeDbGraphProjection } = await import("../world/graphdb-projection-activation.mjs");
        return await activateArcadeDbGraphProjection({ root });
      },
    },
  },
  {
    name: "cli:world-docs-capture",
    cli: {
      command: "world-docs-capture",
      flags: [],
      handle: async (context) => {
        const { root } = context;
        const { captureWorldMarkdownChanges } = await import("../world/world-model.mjs");
        return await captureWorldMarkdownChanges({ root, persist: true });
      },
    },
  },
  {
    name: "cli:world-docs-review",
    cli: {
      command: "world-docs-review",
      flags: ["input"],
      handle: async (context) => {
        const { root, options, inputJson } = context;
        const { reviewDocumentChanges } = await import("../world/document-change-review.mjs");
        const input = inputJson(options, "Document-change ReviewDecision");
        const allowed = new Set(["candidateSetId", "disposition", "acceptedCandidateIds", "resultingProductModel", "rationale", "apply"]);
        const unexpected = Object.keys(input).filter((key) => !allowed.has(key));
        if (unexpected.length) throw new Error(`Document-change ReviewDecision contains unsupported fields: ${unexpected.sort().join(", ")}`);
        return await reviewDocumentChanges({ ...input, root });
      },
    },
  },
  {
    name: "cli:world-docs-apply",
    cli: {
      command: "world-docs-apply",
      flags: ["review"],
      handle: async (context) => {
        const { root, options } = context;
        const { applyDocumentChangeReview } = await import("../world/document-change-review.mjs");
        return await applyDocumentChangeReview({ root, reviewDecisionId: options.review });
      },
    },
  },
  {
    name: "cli:world-docs-policy-set",
    cli: {
      command: "world-docs-policy-set",
      flags: ["input"],
      handle: async (context) => {
        const { root, options, inputJson } = context;
        const { setPostRefreshProjectionPolicy } = await import("../world/post-refresh-projection.mjs");
        const input = inputJson(options, "Post-refresh document projection policy");
        const unexpected = Object.keys(input).filter((key) => key !== "mode");
        if (unexpected.length) throw new Error(`Post-refresh document projection policy contains unsupported fields: ${unexpected.sort().join(", ")}`);
        return setPostRefreshProjectionPolicy({ root, mode: input.mode });
      },
    },
  },
  {
    name: "cli:world-docs-policy-status",
    cli: {
      command: "world-docs-policy-status",
      flags: [],
      handle: async (context) => {
        const { root } = context;
        const { inspectPostRefreshProjectionPolicy } = await import("../world/post-refresh-projection.mjs");
        return inspectPostRefreshProjectionPolicy({ root });
      },
    },
  },
  {
    name: "cli:checkpoint",
    cli: {
      command: "checkpoint",
      flags: ["next", "summary"],
      handle: async (context) => {
        const { root, options } = context;
        const { createRecoveryCheckpoint } = await import("./compaction-recovery.mjs");
        return createRecoveryCheckpoint({
          root,
          purpose: options.summary,
          currentPosition: options.summary,
          nextExpectedResult: options.next || options.summary,
          approvedDecisions: [],
          openReviewIds: [],
        });
      },
    },
  },
  {
    name: "cli:project-document-prepare",
    cli: {
      command: "project-document-prepare",
      aliases: ["project-document-publish"],
      flags: ["input"],
      handle: async (context) => {
        const { root, options, command, inputJson } = context;
        const api = await import("../storage/project-document-publication.mjs");
        const input = inputJson(options, "Lode-selected Project documents");
        return api[command === "project-document-prepare" ? "prepareProjectDocuments" : "publishProjectDocuments"]({ ...input, root });
      },
    },
  },
  {
    name: "cli:work-document-prepare",
    cli: {
      command: "work-document-prepare",
      aliases: ["work-document-configure", "work-document-publish"],
      flags: ["input"],
      handle: async (context) => {
        const { root, options, command, inputJson } = context;
        const api = await import("../world/work-document-publication.mjs");
        const input = inputJson(options, "Lode-selected work document operation");
        const method = {
          "work-document-prepare": "prepareWorkDocuments",
          "work-document-configure": "configureWorkDocuments",
          "work-document-publish": "publishWorkDocuments",
        }[command];
        return api[method]({ ...input, root });
      },
    },
  },
  {
    name: "cli:lineage-plan",
    cli: {
      command: "lineage-plan",
      flags: ["input"],
      handle: async (context) => {
        const { root, options, inputJson } = context;
        const { createWholePlanSnapshot } = await import("../runtime/execution-lineage.mjs");
        return createWholePlanSnapshot({ ...inputJson(options, "Whole plan"), root, persist: true });
      },
    },
  },
  {
    name: "cli:lineage-next-plan",
    cli: {
      command: "lineage-next-plan",
      flags: ["input"],
      handle: async (context) => {
        const { root, options, inputJson } = context;
        const { createNextWholePlanSnapshot } = await import("../runtime/execution-lineage.mjs");
        return createNextWholePlanSnapshot({ ...inputJson(options, "Next whole plan"), root, persist: true });
      },
    },
  },
  {
    name: "cli:lineage-contract",
    cli: {
      command: "lineage-contract",
      flags: ["input"],
      handle: async (context) => {
        const { root, options, inputJson } = context;
        const { createExecutionContract } = await import("../runtime/execution-lineage.mjs");
        return createExecutionContract({ ...inputJson(options, "Execution Contract"), root, persist: true });
      },
    },
  },
  {
    name: "cli:run-finish",
    cli: {
      command: "run-finish",
      flags: ["input"],
      handle: async (context) => {
        const { root, options, inputJson } = context;
        const { finishRun } = await import("../runtime/run-lineage.mjs");
        return finishRun({ ...inputJson(options, "Result Packet"), root });
      },
    },
  },
  {
    name: "cli:run-review",
    cli: {
      command: "run-review",
      flags: ["input"],
      handle: async (context) => {
        const { root, options, inputJson } = context;
        const { reviewRun } = await import("../runtime/run-lineage.mjs");
        return reviewRun({ ...inputJson(options, "ReviewDecision"), root });
      },
    },
  },
  {
    name: "cli:context-compile",
    cli: {
      command: "context-compile",
      flags: ["budget", "evidence-needs", "task"],
      handle: async (context) => {
        const { root, options, evidenceNeedsInput } = context;
        const { compileContext, DEFAULT_CONTEXT_BUDGET } = await import("./context-compiler.mjs");
        return await compileContext({
          root,
          task: options.task,
          budget: options.budget == null ? DEFAULT_CONTEXT_BUDGET : Number(options.budget),
          evidenceNeeds: evidenceNeedsInput(options),
          persist: true,
        });
      },
    },
  },
]);

// Host presentation hints describe the implemented effect; they do not grant
// permission or prove that a caller obtained a user's approval.
const supplementalReadOnlyHints = {
  lode_core_contract: true,
  lode_runtime_adapters: true,
  lode_runtime_invocation_authorization: true,
  lode_runtime_invocation_lease_status: true,
  lode_runtime_invocation_result: true,
  lode_onboarding_status: true,
  lode_onboarding_semantic_refresh: false,
  lode_onboarding_candidate_restore: false,
  lode_product_policy_status: true,
  lode_product_policy_candidate: true,
  lode_product_policy_review_decision: true,
  lode_metric_status: true,
  lode_metric_trace: true,
  lode_feature_mapping_status: true,
  lode_change_set_status: true,
  lode_vcs_evidence: true,
  lode_context_capsule: true,
  lode_lineage_artifact: true,
  lode_pending_review: true,
  lode_incremental_refresh_status: true,
  lode_incremental_refresh_receipt: true,
  lode_refresh_trigger_status: true,
  lode_refresh_trigger_delivery: true,
  lode_graph_projection_status: true,
  lode_markdown_projection_status: true,
  lode_post_refresh_projection_status: true,
  lode_post_refresh_projection_receipt: true,
  lode_document_change_candidates: true,
  lode_document_change_review_status: true,
  lode_document_change_review: true,
  lode_document_change_application: true,
  lode_world_query: true,
  lode_git_history: true,
  lode_temporal_graph: true,
  lode_graph_lineage_status: true,
  lode_graph_lineage_trace: true,
  lode_graph_lineage_diff: true,
  lode_runtime_state: true,
  lode_compact_status: true,
  lode_product_operating_status: true,
  lode_release_status: true,
  lode_delivery_status: true,
  lode_continuity_snapshot: true,
  lode_feature_mapping_propose: false,
  lode_feature_mapping_review: false,
  lode_conformance_propose: false,
  lode_conformance_disposition: false,
  lode_conformance_resolution_propose: false,
  lode_conformance_trigger_prepare: false,
  lode_compact_prepare: false,
  lode_compact_verify: false,
  lode_compact_continue: false,
  lode_compact_abort: false,
  lode_product_signal_record: false,
  lode_product_policy_propose: false,
  lode_product_policy_review: false,
  lode_metric_define: false,
  lode_metric_observe: false,
  lode_metric_compare: false,
  lode_metric_assess: false,
  lode_product_hypothesis_record: false,
  lode_product_initiative_propose: false,
  lode_product_initiative_review: false,
  lode_product_outcome_observe: false,
  lode_delivery_observe: false,
};

// The MCP tool catalog in listing order: every registered operation's tool, with
// the optional logical Session route on each project_root tool and the
// supplemental read-only hints applied once.
const catalog = OPERATIONS.filter((entry) => entry.tool).map((entry) => entry.tool);
for (const tool of catalog) {
  if (tool.inputSchema?.properties?.project_root) {
    tool.inputSchema.properties.session_id = {
      type: "string",
      description: "Optional logical Lode Session route, selected by Lode/Host. Omit for the existing default. Never a provider session ID.",
    };
  }
  if (tool.annotations?.readOnlyHint === undefined && Object.hasOwn(supplementalReadOnlyHints, tool.name)) {
    tool.annotations = { ...tool.annotations, readOnlyHint: supplementalReadOnlyHints[tool.name] };
  }
}

export function registryCatalog() {
  return catalog;
}

const byName = new Map(OPERATIONS.filter((entry) => entry.mcp).map((entry) => [entry.name, entry]));
// MCP-only entries have no cli side; CLI-only entries (named "cli:<command>")
// have no tool or mcp side. A CLI command may have aliases ("doctor" for "status").
const byCommand = new Map(
  OPERATIONS.filter((entry) => entry.cli).flatMap((entry) => [entry.cli.command, ...(entry.cli.aliases ?? [])].map((command) => [command, entry])),
);

export function registeredOperation(name) {
  return byName.get(resolveOperation(name)?.semanticName ?? name) ?? null;
}

export function registeredCommand(command) {
  return byCommand.get(command) ?? null;
}

// Runs one registered operation for one surface ("mcp" or "cli"):
// before(input, context) -> args(input, context) -> impl()(...args) -> after(value, input, context).
// before and after are optional surface adapters (an explicit confirmation, a
// compact MCP result, an added optional view); they never run for the other surface.
//
// A surface may instead declare handle(input, context, call) for an operation
// whose result is not one implementation call (a whole-operation adapter, an
// optional Host capability); call(...args) runs the implementation. A surface
// may also name its own impl when it calls a different export.
export async function callRegistered(entry, surface, input, context = input) {
  const side = entry[surface];
  side.before?.(input, context);
  const loader = side.impl ?? entry.impl;
  let value;
  if (side.handle) {
    value = await side.handle(input, context, async (...callArguments) => {
      // A handle-only entry has no implementation for call() to run.
      if (!loader) throw new Error(`${entry.name} has no registered implementation to call.`);
      return (await loader())(...callArguments);
    });
  } else {
    const callArguments = side.args(input, context);
    const implementation = await loader();
    value = await implementation(...callArguments);
  }
  return side.after ? await side.after(value, input, context) : value;
}

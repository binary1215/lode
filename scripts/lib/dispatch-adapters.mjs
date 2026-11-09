// Argument and result adapters used by the MCP server, the CLI and the operation
// registry: MCP snake_case input to library shapes, explicit confirmations,
// compact MCP results, and the optional prepared-input view. Moved verbatim from
// scripts/mcp-server.mjs (scripts/lode.mjs had the same preparedRuntimeRead apart from comments).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publicToolName } from "./lode-artifact-composition.mjs";
import { familyFormatForOriginal, resolveProjectStorage } from "./project-storage-format.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function featureMappingProposalFromMcp(value) {
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

export function productFeatureResolutionFromMcp(value) {
  if (value?.kind === "existing-feature") return { kind: value.kind, featureKey: value.feature_key };
  if (value?.kind === "candidate")
    return {
      kind: value.kind,
      feature: {
        key: value.feature?.key,
        name: value.feature?.name,
        description: value.feature?.description || "",
        capabilityKeys: value.feature?.capability_keys || [],
      },
    };
  return { kind: "gap", reason: value?.reason };
}

export function observationDescriptorFromMcp(value) {
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

export function observationCoverageFromMcp(value) {
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

export function observationBindingFromMcp(value) {
  return {
    adapterKey: value.adapter_key,
    adapterVersion: value.adapter_version,
    sourceScopeDigest: value.source_scope_digest,
    credentialReferenceNames: value.credential_reference_names || [],
  };
}

export function observationInputFromMcp(value) {
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

export function conformanceBaselineFromMcp(value) {
  return {
    productModelId: value.product_model_id,
    productModelHash: value.product_model_hash,
    worldModelId: value.world_model_id,
    worldModelHash: value.world_model_hash,
    sourceSnapshotId: value.source_snapshot_id,
    graphSnapshotId: value.graph_snapshot_id,
  };
}

export function conformanceEvidenceAnchorFromMcp(value) {
  if (value.kind === "source")
    return {
      kind: value.kind,
      path: value.path,
      fileDigest: value.file_digest,
      startLine: value.start_line ?? null,
      endLine: value.end_line ?? null,
      excerptDigest: value.excerpt_digest ?? null,
      revisionId: value.revision_id ?? null,
      symbolId: value.symbol_id ?? null,
    };
  if (value.kind === "change") return { kind: value.kind, changeSetId: value.change_set_id, changeSetHash: value.change_set_hash, changeId: value.change_id };
  if (value.kind === "observation") return { kind: value.kind, observationId: value.observation_id, observationHash: value.observation_hash };
  return { kind: value.kind, graphSnapshotId: value.graph_snapshot_id, nodeId: value.node_id };
}

export function conformanceFindingFromMcp(value) {
  return {
    canonAnchor: { entityKind: value.canon_anchor.entity_kind, entityKey: value.canon_anchor.entity_key },
    evidenceAnchors: value.evidence_anchors.map(conformanceEvidenceAnchorFromMcp),
    claim: { kind: value.claim.kind, summary: value.claim.summary, rationale: value.claim.rationale, riskHint: value.claim.risk_hint },
  };
}

export function compactReviewResult(result) {
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
    reviewDecision: result.reviewDecision
      ? {
          reviewDecisionId: result.reviewDecision.reviewDecisionId,
          disposition: result.reviewDecision.disposition,
          promotionAuthority: result.reviewDecision.promotionAuthority,
          resultingProductModelId: result.reviewDecision.resultingProductModelId || null,
        }
      : null,
    successorCandidateSet: result.candidateSet
      ? {
          candidateSetId: result.candidateSet.candidateSetId,
          candidateCount: result.candidateSet.candidates.length,
        }
      : null,
    productModelId: result.productModel?.productModelId || null,
    worldModel: result.worldModel,
    authorityEffect: result.reviewDecision?.promotionAuthority ? "explicit-product-canon-transition" : "none",
  };
}

export function compactMarkdownBuild(result) {
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

export function requireMcpConfirmation(value, message, code) {
  if (value === true) return;
  const error = new Error(message);
  error.code = code;
  throw error;
}

export function localWorkerInput(args, start = false) {
  if (typeof args.project_root !== "string" || !args.project_root.trim()) throw new Error("An exact project_root is required.");
  const fields = start
    ? { authorization_id: "authorizationId", task_key: "taskKey", role: "role" }
    : {
        task: "task",
        task_key: "taskKey",
        role: "role",
        outcome: "outcome",
        selected_context: "selectedContext",
        source_paths: "sourcePaths",
        proposal_paths: "proposalPaths",
        model: "model",
        runtime: "runtime",
        timeout_ms: "timeoutMs",
        instruction_scope: "instructionScope",
        context_mode: "contextMode",
      };
  if (Object.keys(args).some((key) => key !== "project_root" && !Object.hasOwn(fields, key)))
    throw new Error("Worker surface does not accept Host configuration.");
  return Object.fromEntries(
    Object.entries(args)
      .filter(([key]) => key !== "project_root")
      .map(([key, value]) => [fields[key], value]),
  );
}

export async function preparedRuntimeRead(root, value) {
  // Primary selection/owner/hash errors have already escaped. Optional view
  // loading or historical-original failures cannot become execution gates.
  try {
    return (await import("./runtime-prepared-input-view.mjs")).withPreparedRuntimeInputView({ root, value });
  } catch {
    return {
      ...value,
      preparedInput: {
        kind: "PreparedRuntimeInputProjection",
        authorityPlane: "P4",
        status: "unavailable",
        reasonCode: "PREPARED_INPUT_VIEW_UNAVAILABLE",
        persisted: false,
        instructionAuthority: false,
        recoveryAuthority: false,
        executionAuthorization: false,
        modelUse: "unknown",
      },
    };
  }
}

// Whole-operation MCP adapters for the remaining operations whose MCP input is
// mapped, checked or composed before or after several library calls. Moved
// verbatim from scripts/mcp-server.mjs; pluginRoot is the same plugin root.

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

export function workerIntegrationInput(args) {
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
export async function workerIntegrationFromMcp(args, onProcess, statusOnly = false) {
  const workflow = await import("./worker-integration-workflow.mjs");
  const input = workerIntegrationInput(args);
  (statusOnly ? workflow.validateWorkerIntegrationStatusRequest : workflow.validateWorkerIntegrationRequest)(input);
  const options = { root: args.project_root, onProcess, storage: resolveProjectStorage(args.project_root) };
  return statusOnly ? workflow.inspectWorkerIntegration(input, options) : workflow.operateWorkerIntegration(input, options);
}

export async function runtimeResultFromMcp(args) {
  const { validateRuntimeInvocationRecordIdentity } = await import("./runtime-invocation-record.mjs");
  validateRuntimeInvocationRecordIdentity(args.authorization_id);
  return (await import("./runtime-run-result-application.mjs")).readRuntimeInvocationResult({
    root: args.project_root,
    authorizationId: args.authorization_id,
    storage: resolveProjectStorage(args.project_root),
  });
}

export function onboardingInputFromMcp(args) {
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

export async function initializeProjectFromMcp(args, { projectSessionRoute, onValidatedSessionSelection, pluginLaunch, servingModuleUrl, installationCaller }) {
  const onboarding = onboardingInputFromMcp(args);
  const { createPluginInitializationContext, releasePluginInitializationContext } = await import("./plugin-mcp-composition.mjs");
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
      await import("./project-bootstrap.mjs")
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

export async function initializeGraphDbFromMcp(args, transport) {
  requireMcpConfirmation(
    args.confirm_initialize,
    "ArcadeDB database initialization requires explicit user confirmation.",
    "ARCADEDB_DATABASE_INITIALIZE_CONFIRMATION_REQUIRED",
  );
  return (await import("./arcadedb-database-lifecycle.mjs")).initializeArcadeDbDatabase({
    root: args.project_root,
    storage: resolveProjectStorage(args.project_root),
    resetIncompatible: args.reset_incompatible === true,
    confirmDatabase: args.confirm_database || "",
    transport,
  });
}

export async function activateGraphDbFromMcp(args, transport) {
  requireMcpConfirmation(
    args.confirm_remote_write,
    "ArcadeDB graph projection activation requires explicit user confirmation.",
    "ARCADEDB_PROJECTION_ACTIVATION_CONFIRMATION_REQUIRED",
  );
  return await (await import("./graphdb-projection-activation.mjs")).activateArcadeDbGraphProjection({ root: args.project_root, transport });
}

export async function continueSessionFromMcp(args, coordinationWorkspaceHost) {
  const continuation = await import("./runtime-session-continuation.mjs");
  if (!coordinationWorkspaceHost)
    return continuation.continueSessionFromArtifacts({
      root: args.project_root,
      checkpointId: args.checkpoint_id || null,
      runtime: args.runtime,
    });
  // Restore P2 before consulting a Host. Endpoint availability is optional P5,
  // not recovery direction or a new role-binding/token ceremony.
  const restored = (await import("./session-recovery.mjs")).restoreSessionFromArtifacts({
    root: args.project_root,
    checkpointId: args.checkpoint_id || null,
  });
  const restoredFormat = familyFormatForOriginal("lode-agent-core-artifact-session-restore", restored.projection);
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

export async function projectBundleFromMcp(name, args, signal, onExportScope = null) {
  const fields =
    name === "lode_project_bundle_export"
      ? ["project_root", "destination", "provenance_scope", "source_mode"]
      : name === "lode_project_bundle_read"
        ? ["bundle_root", "expected_bundle_id", "include_native_history", "handoff_file", "handoff_offset", "handoff_max_bytes"]
        : ["target_root", "bundle_root", "expected_bundle_id"];
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((key) => !fields.includes(key)))
    throw new Error("Unsupported Project bundle arguments.");
  const required =
    name === "lode_project_bundle_export" ? ["project_root", "destination"] : name === "lode_project_bundle_read" ? [] : ["target_root", "bundle_root"];
  if (required.some((key) => typeof args[key] !== "string" || !args[key].trim())) throw new Error("Project bundle locations must be non-empty text.");
  const core = await import("./project-portability.mjs");
  if (name === "lode_project_bundle_read") {
    const handoffOptions = { offset: args.handoff_offset ?? 0, maxBytes: args.handoff_max_bytes ?? 65536 };
    if (args.handoff_file !== undefined) {
      if (args.bundle_root !== undefined || args.expected_bundle_id !== undefined || args.include_native_history !== undefined)
        throw new Error("Choose a standalone handoff_file or one bundle_root.");
      return (await import("./project-handoff.mjs")).readProjectHandoffFile({ file: args.handoff_file, ...handoffOptions, signal });
    }
    if (typeof args.bundle_root !== "string" || !args.bundle_root.trim()) throw new Error("A bundle_root or explicit standalone handoff_file is required.");
    if (args.include_native_history !== undefined && typeof args.include_native_history !== "boolean")
      throw new Error("include_native_history must be boolean.");
    const common = core.projectBundleSummary(
      core.inspectProjectBundle({ bundleRoot: args.bundle_root, expectedBundleId: args.expected_bundle_id ?? null, signal, handoffOptions }),
    );
    if (!args.include_native_history) return common;
    const native = await import("./project-native-transfer.mjs");
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
  if (name === "lode_project_bundle_export")
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
    nextRead: { tool: publicToolName("lode_conversation_enter"), arguments: { project_root: result.targetRoot, session_id: result.selectedSessionId } },
    selectionScope: "exact-current-request-no-default-change",
  };
}

export async function projectNativeHistoryFromMcp(args, signal, nativeHistoryHost = null, onProcess) {
  const allowed = ["action", "provider", "bundle_root", "expected_bundle_id", "native_home", "executable", "thread_ids", "runtime_root", "companion_paths"];
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((key) => !allowed.includes(key)))
    throw new Error("Unsupported native history arguments.");
  if (typeof args.bundle_root !== "string" || !args.bundle_root.trim()) throw new Error("Native history requires one exact bundle location.");
  return (await import("./project-native-history.mjs")).operateProjectNativeHistory({
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

// Argument and result adapters used by the MCP server, the CLI and the operation
// registry: MCP snake_case input to library shapes, explicit confirmations,
// compact MCP results, and the optional prepared-input view. Moved verbatim from
// scripts/mcp-server.mjs (preparedRuntimeRead was identical in scripts/lode.mjs).

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

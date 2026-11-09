// JSON Schema fragments shared by MCP tool definitions in scripts/mcp-server.mjs
// and scripts/lib/operation-registry.mjs. One object per fragment, so every tool
// that uses a fragment references the same schema object.
export const workEvidenceText = { type: "string", minLength: 1 };
export const workEvidenceList = { type: "array", items: workEvidenceText };
export const exactWorkEvidenceSchema = {
  type: "object",
  properties: {
    evidenceId: { type: "string", pattern: "^work-evidence-[a-f0-9]{24}$" },
    evidenceDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
  },
  required: ["evidenceId", "evidenceDigest"],
  additionalProperties: false,
};
export const sessionWorkEvidenceSchema = {
  type: "object",
  description:
    "Sparse provider Lode-authored P3 evidence. Reuse exact originals; select only otherwise unrepresented judgment/reasons/alternatives, observations, pending work and uncertainty. Never a user form, transcript, approval or P2 direction.",
  properties: {
    summary: workEvidenceText,
    judgments: {
      type: "array",
      items: {
        type: "object",
        properties: { assessment: workEvidenceText, reason: workEvidenceText, alternatives: workEvidenceList },
        required: ["assessment", "reason"],
        additionalProperties: false,
      },
    },
    observedWork: workEvidenceList,
    pending: workEvidenceList,
    unknowns: workEvidenceList,
    suggestedFollowUp: workEvidenceList,
    workTopics: {
      ...workEvidenceList,
      description:
        "Optional Lode-authored navigation labels from actual work, not Product Features, completion, approval or P2 direction. No taxonomy or user form required.",
    },
    todos: {
      type: "array",
      minItems: 1,
      description:
        "Optional explicit P3 task revisions. Lode supplies stable IDs, exact prior and actual progress at meaningful changes; no user JSON/save ritual. Status is not execution authority or inferred from activity.",
      items: {
        type: "object",
        properties: {
          todoId: { type: "string", pattern: "^todo-[a-z0-9][a-z0-9-]{0,79}$" },
          task: workEvidenceText,
          status: { type: "string", enum: ["pending", "partial", "waiting", "completed", "cancelled"] },
          origin: {
            type: "string",
            enum: ["user-directed", "lode-proposed", "head-proposed"],
            description: "Recorded attribution only; not proof of user approval. head-proposed is the old spelling of lode-proposed.",
          },
          nextAction: workEvidenceText,
          reason: workEvidenceText,
          progress: workEvidenceText,
          priority: workEvidenceText,
          prior: exactWorkEvidenceSchema,
          resolves: {
            type: "array",
            items: exactWorkEvidenceSchema,
            description: "Explicitly reconcile these other exact branches of the same task; no time-based winner.",
          },
          relatedEvidence: { type: "array", items: exactWorkEvidenceSchema },
        },
        required: ["todoId", "task", "status", "origin"],
        additionalProperties: false,
      },
    },
    occurrenceKey: {
      ...workEvidenceText,
      description: "Optional Lode-owned distinction for a genuinely separate occurrence; identical input retry reuses its original.",
    },
    workLink: {
      type: "object",
      description: "Optional exact same-Session saved context anchor and predecessor; not execution identity or authority.",
      properties: { root: exactWorkEvidenceSchema, predecessor: exactWorkEvidenceSchema },
      required: ["root", "predecessor"],
      additionalProperties: false,
    },
    executionObservation: {
      type: "object",
      description: "Saved historical observation, never current live state or completion/approval proof. An optional exact target qualifies that note only.",
      properties: { state: { type: "string", enum: ["running", "paused", "ended", "unknown"] }, target: exactWorkEvidenceSchema },
      required: ["state"],
      additionalProperties: false,
    },
    references: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: workEvidenceText,
          digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
          kind: { type: "string", enum: ["source", "artifact"] },
        },
        required: ["path", "digest", "kind"],
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

export const observationFieldSchema = {
  type: "object",
  properties: {
    key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$" },
    type: {
      type: "string",
      enum: ["string", "stable-key", "timestamp", "sha256", "boolean", "integer", "nonnegative-integer", "bounded-number", "enum", "array"],
    },
    required: { type: "boolean" },
    min: { type: "number" },
    max: { type: "number" },
    enum: { type: "array", maxItems: 64 },
    items_type: { type: "string", enum: ["string", "stable-key", "timestamp", "sha256", "boolean", "integer", "nonnegative-integer", "bounded-number"] },
    max_items: { type: "integer", minimum: 0, maximum: 1024 },
  },
  required: ["key", "type", "required"],
  additionalProperties: false,
};
export const observationDescriptorSchema = {
  type: "object",
  properties: {
    type_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$" },
    type_version: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$" },
    forms: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", enum: ["event", "snapshot", "aggregate"] } },
    payload_schema: {
      type: "object",
      properties: { fields: { type: "array", maxItems: 128, items: observationFieldSchema }, additional_fields: { const: false } },
      required: ["fields", "additional_fields"],
      additionalProperties: false,
    },
  },
  required: ["type_key", "type_version", "forms", "payload_schema"],
  additionalProperties: false,
};
export const observationCoverageSchema = {
  type: "object",
  properties: {
    state: { type: "string", enum: ["complete", "sampled", "partial", "unknown"] },
    basis: { type: "string", minLength: 1 },
    query_digest: { anyOf: [{ type: "string", pattern: "^[a-f0-9]{64}$" }, { type: "null" }] },
    examined_count: { type: "integer", minimum: 0 },
    source_reported_total: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
    omitted_count: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
    cursor_start_digest: { anyOf: [{ type: "string", pattern: "^[a-f0-9]{64}$" }, { type: "null" }] },
    cursor_end_digest: { anyOf: [{ type: "string", pattern: "^[a-f0-9]{64}$" }, { type: "null" }] },
  },
  required: ["state", "basis", "query_digest", "examined_count", "source_reported_total", "omitted_count", "cursor_start_digest", "cursor_end_digest"],
  additionalProperties: false,
};
export const observationBindingSchema = {
  type: "object",
  properties: {
    adapter_key: { const: "head.structured-host-observation" },
    adapter_version: { const: "0.1.0" },
    source_scope_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
    credential_reference_names: { type: "array", maxItems: 16, uniqueItems: true, items: { type: "string", pattern: "^[A-Z][A-Z0-9_]{2,127}$" } },
  },
  required: ["adapter_key", "adapter_version", "source_scope_digest", "credential_reference_names"],
  additionalProperties: false,
};
export const observationInputSchema = {
  type: "object",
  properties: {
    subject: {
      type: "object",
      properties: { type: { type: "string", minLength: 1 }, key: { type: "string", minLength: 1 } },
      required: ["type", "key"],
      additionalProperties: false,
    },
    form: { type: "string", enum: ["event", "snapshot", "aggregate"] },
    temporal_scope: {
      type: "object",
      properties: {
        observed_at: { type: "string", format: "date-time" },
        start: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
        end: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
      },
      required: ["observed_at", "start", "end"],
      additionalProperties: false,
    },
    source_event_key_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
    source_evidence_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
    coverage: observationCoverageSchema,
    payload: { type: "object" },
  },
  required: ["subject", "form", "temporal_scope", "source_event_key_digest", "source_evidence_digest", "coverage", "payload"],
  additionalProperties: false,
};
export const nullableIdentity = (pattern) => ({ anyOf: [{ type: "string", pattern }, { type: "null" }] });
export const conformanceBaselineSchema = {
  type: "object",
  properties: {
    product_model_id: { type: "string", pattern: "^product-model-[a-f0-9]{24}$" },
    product_model_hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    world_model_id: nullableIdentity("^world-model-[a-f0-9]{24}$"),
    world_model_hash: nullableIdentity("^[a-f0-9]{64}$"),
    source_snapshot_id: nullableIdentity("^source-snapshot-[a-f0-9]{24}$"),
    graph_snapshot_id: nullableIdentity("^graph-snapshot-[a-f0-9]{24}$"),
  },
  required: ["product_model_id", "product_model_hash", "world_model_id", "world_model_hash", "source_snapshot_id", "graph_snapshot_id"],
  additionalProperties: false,
};
export const conformanceEvidenceAnchorSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["source", "change", "observation", "graph"] },
    path: { type: "string", minLength: 1 },
    file_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
    start_line: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
    end_line: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
    excerpt_digest: nullableIdentity("^[a-f0-9]{64}$"),
    revision_id: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
    symbol_id: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
    change_set_id: { type: "string", pattern: "^change-set-[a-f0-9]{24}$" },
    change_set_hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    change_id: { type: "string", pattern: "^change-record-[a-f0-9]{24}$" },
    observation_id: { type: "string", pattern: "^(?:observation|derived-observation)-[a-f0-9]{24}$" },
    observation_hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    graph_snapshot_id: { type: "string", pattern: "^graph-snapshot-[a-f0-9]{24}$" },
    node_id: { type: "string", minLength: 1 },
  },
  required: ["kind"],
  additionalProperties: false,
};
export const conformanceFindingInputSchema = {
  type: "object",
  properties: {
    canon_anchor: {
      type: "object",
      properties: {
        entity_kind: { type: "string", enum: ["FeatureGroup", "Capability", "Feature", "Requirement", "Constraint", "Decision", "Policy"] },
        entity_key: { type: "string", minLength: 1 },
      },
      required: ["entity_kind", "entity_key"],
      additionalProperties: false,
    },
    evidence_anchors: { type: "array", minItems: 1, maxItems: 64, items: conformanceEvidenceAnchorSchema },
    claim: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["potential-conflict", "possible-conformance-gap"] },
        summary: { type: "string", minLength: 1 },
        rationale: { type: "string", minLength: 1 },
        risk_hint: { type: "string", enum: ["unknown", "low", "medium", "high"] },
      },
      required: ["kind", "summary", "rationale", "risk_hint"],
      additionalProperties: false,
    },
  },
  required: ["canon_anchor", "evidence_anchors", "claim"],
  additionalProperties: false,
};

export const onboardingSemanticProposalSchema = {
  type: "object",
  description:
    "Fresh provider-Lode-authored P3 product candidates. Core verifies exact current source evidence and never treats this proposal as Product Canon.",
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
                contentDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
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
};

export const workerIntegrationIdSchema = { type: "string", pattern: "^worker-integration-[a-f0-9]{24}--[a-f0-9]{24}$" };
export const workerIntegrationVerificationIdSchema = { type: "string", pattern: "^worker-integration-verification-[a-f0-9]{24}$" };
export const workerIntegrationActionFields = {
  prepare: ["authorization_ids", "max_bytes"],
  apply: ["integration_id"],
  reconcile: ["integration_id"],
  "settle-incomplete": ["integration_id", "basis_digest", "reason"],
  "prepare-result": ["integration_id", "basis_digest", "outcome", "evidence", "verification"],
  "publish-result": ["integration_id", "verification_id"],
};
export const workerIntegrationOptionalFields = {
  apply: ["basis_digest", "retry_known_no_write"],
  "prepare-result": ["plan_delta", "impact_radius", "unknowns"],
};

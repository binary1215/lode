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
    "Sparse provider HEAD-authored P3 evidence. Reuse exact originals; select only otherwise unrepresented judgment/reasons/alternatives, observations, pending work and uncertainty. Never a user form, transcript, approval or P2 direction.",
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
        "Optional HEAD-authored navigation labels from actual work, not Product Features, completion, approval or P2 direction. No taxonomy or user form required.",
    },
    todos: {
      type: "array",
      minItems: 1,
      description:
        "Optional explicit P3 task revisions. HEAD supplies stable IDs, exact prior and actual progress at meaningful changes; no user JSON/save ritual. Status is not execution authority or inferred from activity.",
      items: {
        type: "object",
        properties: {
          todoId: { type: "string", pattern: "^todo-[a-z0-9][a-z0-9-]{0,79}$" },
          task: workEvidenceText,
          status: { type: "string", enum: ["pending", "partial", "waiting", "completed", "cancelled"] },
          origin: { type: "string", enum: ["user-directed", "head-proposed"], description: "Recorded attribution only; not proof of user approval." },
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
      description: "Optional HEAD-owned distinction for a genuinely separate occurrence; identical input retry reuses its original.",
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

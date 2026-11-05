import { familyFormatForOriginal } from "./project-storage-format.mjs";
import { inspectObservationSources, ObservationAdapterRegistry } from "./observation-adapter.mjs";
import { OBSERVATION_PROTOCOL_VERSION, observationDigest } from "./observation-contract.mjs";
import { queryObservations } from "./observation-projection.mjs";
import { SCHEMA_VERSION } from "./lode-core.mjs";

const fail = (message, code = "OBSERVATION_PREPARATION_ERROR") => { const error = new Error(message); error.code = code; throw error; };

export function prepareObservationEvidence({
  root = ".",
  registry = null,
  typeKey,
  subjectType = "",
  subjectKey = "",
  adapterKey = "",
  observedAfter = "",
  observedBefore = "",
  existingLimit = 20,
  sourceLimit = 20,
  sourceAvailability = "",
  sourceProjectionId = "",
  sourceCursor = "",
} = {}) {
  const exactTypeKey = String(typeKey || "").trim();
  if (!exactTypeKey) fail("Observation preparation requires one exact HEAD-selected typeKey.", "OBSERVATION_PREPARATION_TYPE_REQUIRED");
  if (registry != null && !(registry instanceof ObservationAdapterRegistry)) fail("Host Observation adapter registry is invalid.", "INVALID_OBSERVATION_ADAPTER_REGISTRY");
  const existing = queryObservations({
    root,
    typeKey: exactTypeKey,
    subjectType,
    subjectKey,
    adapterKey,
    observedAfter,
    observedBefore,
    recordKind: "all",
    limit: existingLimit,
  });
  const storage = familyFormatForOriginal("head-agent-core-observation-query", existing);
  const configured = inspectObservationSources({
    root,
    registry,
    typeKey: exactTypeKey,
    adapterKey,
    availabilityState: sourceAvailability,
    limit: sourceLimit,
    projectionId: sourceProjectionId,
    cursor: sourceCursor,
  }, storage);
  const sourceCount = configured.registry.matchingSourceCount ?? 0;
  const nextAction = existing.returned > 0
    ? "head-assess-existing-observations"
    : sourceCount > 0
      ? "head-may-collect-one-source-if-durable-current-evidence-is-required"
      : "continue-without-persisted-observation-or-disclose-required-adapter-gap";
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: "ObservationPreparationProjection",
    protocol: { name: storage.protocol("head-agent-core-observation-preparation"), version: OBSERVATION_PROTOCOL_VERSION },
    projectId: existing.projectId,
    sessionId: existing.sessionId,
    exactNeed: {
      typeKey: exactTypeKey,
      subjectType: String(subjectType || "").trim() || null,
      subjectKey: String(subjectKey || "").trim() || null,
      adapterKey: String(adapterKey || "").trim() || null,
      observedAfter: String(observedAfter || "").trim() || null,
      observedBefore: String(observedBefore || "").trim() || null,
    },
    existing,
    configuredSources: configured.registry,
    workflow: {
      nextAction,
      semanticSelectionOwner: storage.value("provider-head"),
      semanticSufficiencyAssessed: false,
      sourceAutomaticallySelected: false,
      sourceAutomaticallyCollected: false,
      userAuthoredProvenanceRequired: false,
    },
    persisted: false,
    authority: "P4-reuse-first-observation-preparation",
    instructionAuthority: false,
    promotionAuthority: false,
    recoveryAuthority: false,
  };
  const preparationHash = observationDigest(payload);
  return { ...payload, preparationId: `observation-preparation-${preparationHash.slice(0, 24)}`, preparationHash };
}

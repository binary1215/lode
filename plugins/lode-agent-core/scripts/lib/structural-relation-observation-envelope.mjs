import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";
import crypto from "node:crypto";

export const STRUCTURAL_RELATION_OBSERVATION_ENVELOPE_VERSION = "0.1.0";

const LIMITS = Object.freeze({ claims: 16, runs: 16, sources: 64, rawRefs: 128, pairs: 10_000, occurrences: 20_000, supports: 40_000, itemBytes: 1_048_576, totalBytes: 8_388_608, envelopeBytes: 8_388_608, coordinate: 10_000_000 });
const CLAIM_SOURCES = new Set(["producer-output", "profile-declaration", "observer-recorded", "absent"]);
const EVIDENCE_STATUS = new Set(["partial", "unknown"]);
const RESPONSE_CLOSURE = new Set(["complete-frame-observed", "partial", "unknown"]);
const ascii = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const contractFailures = new WeakMap();
const fail = (message, code = "INVALID_STRUCTURAL_RELATION_OBSERVATION_ENVELOPE", disposition = null) => { const error = new Error(message); error.code = code; contractFailures.set(error, disposition); throw error; };
function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) {
    const array = ordinaryArray(value, "Canonical array");
    const parts = [];
    for (let index = 0; index < array.length; index += 1) parts.push(canonicalJson(array[index]));
    return `[${parts.join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = object(value, "Canonical object");
    const parts = [];
    for (const key of Object.keys(record).sort(ascii)) parts.push(`${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${parts.join(",")}}`;
  }
  fail("Canonical value contains an unsupported type.", "INVALID_STRUCTURAL_RELATION_OBSERVATION_ENVELOPE");
}
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const H = (value) => hash(canonicalJson(value));
const id = (prefix, value) => `${prefix}-${H(value).slice(0, 24)}`;
const object = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label} must be a plain object.`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor || !("value" in descriptor) || descriptor.enumerable !== true) fail(`${label} must contain enumerable own data properties only.`, "INVALID_STRUCTURAL_RELATION_OBSERVATION_ENVELOPE");
  }
  return value;
};
const fields = (value, allowed, label) => { const record = object(value, label); const extra = Object.keys(record).filter((key) => !allowed.includes(key)); if (extra.length) fail(`${label} contains unsupported fields: ${extra.join(", ")}.`, "UNSUPPORTED_STRUCTURAL_RELATION_OBSERVATION_FIELD"); return record; };
const text = (value, max, label, nullable = false) => { if (nullable && value === null) return null; if (typeof value !== "string" || !value || value.length > max) fail(`${label} is invalid.`); return value; };
const safe = (value, max, label) => {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} is outside the supported numeric range.`, "STRUCTURAL_RELATION_OBSERVATION_LIMIT", "invalid");
  if (value > max) fail(`${label} is outside the supported numeric range.`, "STRUCTURAL_RELATION_OBSERVATION_LIMIT");
  return value;
};
const hex = (value, label) => { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail(`${label} must be a SHA-256 digest.`); return value; };
const pathValue = (value, label) => { text(value, 512, label); if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || value.split("/").some((part) => !part || part === "." || part === "..")) fail(`${label} must be a normalized relative path.`, "INVALID_STRUCTURAL_RELATION_SOURCE_PATH"); return value; };
const unique = (values, label) => { if (new Set(values).size !== values.length) fail(`${label} contains duplicates.`, "DUPLICATE_STRUCTURAL_RELATION_OBSERVATION_ID"); };
const exactOrder = (values, sorted, label) => { if (canonicalJson(values) !== canonicalJson(sorted)) fail(`${label} is not in canonical order.`, "NON_CANONICAL_STRUCTURAL_RELATION_OBSERVATION"); };
const ordinaryArray = (value, label) => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(`${label} must be a dense plain array.`, "INVALID_STRUCTURAL_RELATION_OBSERVATION_ENVELOPE");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) fail(`${label} must be a dense plain array.`, "INVALID_STRUCTURAL_RELATION_OBSERVATION_ENVELOPE");
  const length = lengthDescriptor.value;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== length + 1 || ownKeys.some((key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)))) fail(`${label} must be a dense plain array.`, "INVALID_STRUCTURAL_RELATION_OBSERVATION_ENVELOPE");
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) fail(`${label} must contain enumerable own data elements only.`, "INVALID_STRUCTURAL_RELATION_OBSERVATION_ENVELOPE");
  }
  return value;
};
const boundedArray = (value, min, max, label) => {
  const array = ordinaryArray(value, label);
  if (array.length < min) fail(`${label} count is unsupported.`, "STRUCTURAL_RELATION_OBSERVATION_LIMIT", "invalid");
  if (array.length > max) {
    fail(`${label} count is unsupported.`, "STRUCTURAL_RELATION_OBSERVATION_LIMIT");
  }
  return array;
};
function jsonSize(value, label) {
  let encoded = 0;
  const add = (bytes) => {
    encoded += bytes;
    if (encoded > LIMITS.envelopeBytes) fail(`${label} exceeds the serialized envelope limit.`, "STRUCTURAL_RELATION_OBSERVATION_LIMIT");
  };
  const visit = (entry) => {
    if (entry === null) { add(4); return; }
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      const scalar = JSON.stringify(entry);
      if (scalar === undefined) fail(`${label} is unserializable.`, "STRUCTURAL_RELATION_OBSERVATION_LIMIT", "invalid");
      add(Buffer.byteLength(scalar, "utf8"));
      return;
    }
    if (Array.isArray(entry)) {
      const array = ordinaryArray(entry, label);
      add(2);
      for (let index = 0; index < array.length; index += 1) {
        if (index) add(1);
        visit(array[index]);
      }
      return;
    }
    if (entry && typeof entry === "object") {
      const record = object(entry, label);
      add(2);
      let index = 0;
      for (const key of Object.keys(record)) {
        if (index) add(1);
        add(Buffer.byteLength(JSON.stringify(key), "utf8") + 1);
        visit(record[key]);
        index += 1;
      }
      return;
    }
    fail(`${label} is unserializable.`, "STRUCTURAL_RELATION_OBSERVATION_LIMIT", "invalid");
  };
  visit(value);
  return encoded;
}
function structuralRange(value,label){fields(value,["start","end"],label);for(const [name,pos] of [["start",value.start],["end",value.end]]){fields(pos,["line","character"],`${label}.${name}`);safe(pos.line,LIMITS.coordinate,`${label}.${name}.line`);safe(pos.character,LIMITS.coordinate,`${label}.${name}.character`);}if(comparePos(value.start,value.end)>0)fail(`${label} is reversed.`,"STRUCTURAL_RELATION_COORDINATE_MISMATCH");return value;}

function observationPairs(value, label) {
  if (!Array.isArray(value)) fail(`${label} is outside the positive direct-name CALLS shape supported by v0.`, "UNSUPPORTED_STRUCTURAL_RELATION_OBSERVATION_SHAPE", "invalid");
  ordinaryArray(value, label);
  if (value.length === 0) fail(`${label} is outside the positive direct-name CALLS shape supported by v0.`, "UNSUPPORTED_STRUCTURAL_RELATION_OBSERVATION_SHAPE");
  if (value.length > LIMITS.pairs) fail(`${label} exceeds the pair count limit.`, "STRUCTURAL_RELATION_OBSERVATION_LIMIT");
  return boundedArray(value, 1, LIMITS.pairs, label);
}
function preflightByteMap(map, expectedKeys, label) {
  validateMap(map, label);
  unique(expectedKeys, `${label} expected keys`);
  if (map.size !== expectedKeys.length || expectedKeys.some((key) => !map.has(key))) fail(`${label} keys do not exactly match descriptors.`, "STRUCTURAL_RELATION_BYTE_MAP_MISMATCH");
  let total = 0;
  for (const [key, bytes] of map) {
    if (typeof key !== "string" || !expectedKeys.includes(key)) fail(`${label} contains an invalid key.`, "STRUCTURAL_RELATION_BYTE_MAP_MISMATCH");
    if (!(bytes instanceof Uint8Array)) fail(`${label}[${key}] must be Uint8Array.`, "INVALID_STRUCTURAL_RELATION_BYTE_MAP");
    if (bytes.byteLength > LIMITS.itemBytes) fail(`${label}[${key}] exceeds the per-item byte limit.`, "STRUCTURAL_RELATION_OBSERVATION_LIMIT");
    total += bytes.byteLength;
    if (total > LIMITS.totalBytes) fail(`${label} exceeds the total byte limit.`, "STRUCTURAL_RELATION_OBSERVATION_LIMIT");
  }
}
function preflightEndpoint(value, label) {
  fields(value, ["path", "digest", "name", "symbolKind", "declarationRange", "selectionRange"], label);
  pathValue(value.path, `${label}.path`);
  hex(value.digest, `${label}.digest`);
  text(value.name, 256, `${label}.name`);
  text(value.symbolKind, 128, `${label}.symbolKind`);
  structuralRange(value.declarationRange, `${label}.declarationRange`);
  structuralRange(value.selectionRange, `${label}.selectionRange`);
}
function preflightClaim(value, label, canonical) {
  fields(value, canonical
    ? ["name", "version", "executableIdentity", "profileIdentity", "reportedTransport", "reportedMethod", "analysisMethodClaim", "producerIdentityEvidenceStatus", "producerClaimId"]
    : ["producerClaimKey", "name", "version", "executableIdentity", "profileIdentity", "reportedTransport", "reportedMethod", "analysisMethodClaim", "producerIdentityEvidenceStatus"], label);
  if (!canonical) text(value.producerClaimKey, 128, `${label}.producerClaimKey`);
  text(value.name, 128, `${label}.name`);
  text(value.version, 128, `${label}.version`);
  text(value.executableIdentity, 128, `${label}.executableIdentity`);
  text(value.profileIdentity, 128, `${label}.profileIdentity`);
  text(value.reportedTransport, 128, `${label}.reportedTransport`);
  text(value.reportedMethod, 128, `${label}.reportedMethod`);
  fields(value.analysisMethodClaim, ["reportedValue", "reportSource", "truthStatus"], `${label}.analysisMethodClaim`);
  text(value.analysisMethodClaim.reportedValue, 128, `${label}.analysisMethodClaim.reportedValue`, true);
  if (!CLAIM_SOURCES.has(value.analysisMethodClaim.reportSource) || value.analysisMethodClaim.truthStatus !== "unknown") fail("Analysis method truth values other than unknown are unsupported.", "UNSUPPORTED_STRUCTURAL_RELATION_TRUTH_STATUS");
  if ((value.analysisMethodClaim.reportSource === "absent") !== (value.analysisMethodClaim.reportedValue === null)) fail("Absent analysis method claim must have null reportedValue.");
  if (!EVIDENCE_STATUS.has(value.producerIdentityEvidenceStatus)) fail("producerIdentityEvidenceStatus is unsupported.");
  if (canonical) text(value.producerClaimId, 128, `${label}.producerClaimId`);
}
function preflightRunCoverage(value, label) {
  fields(value, ["admittedSources", "queriedDirection", "queriedSymbols", "reportedResponseClosure", "programCoverage", "repositoryRelationCompleteness"], label);
  for (const [index, source] of boundedArray(value.admittedSources, 1, LIMITS.sources, `${label}.admittedSources`).entries()) {
    fields(source, ["path", "digest"], `${label}.admittedSources[${index}]`);
    pathValue(source.path, `${label}.admittedSources[${index}].path`);
    hex(source.digest, `${label}.admittedSources[${index}].digest`);
  }
  for (const [index, symbol] of boundedArray(value.queriedSymbols, 0, LIMITS.occurrences, `${label}.queriedSymbols`).entries()) {
    fields(symbol, ["path", "digest", "name", "symbolKind", "line"], `${label}.queriedSymbols[${index}]`);
    pathValue(symbol.path, `${label}.queriedSymbols[${index}].path`);
    hex(symbol.digest, `${label}.queriedSymbols[${index}].digest`);
    text(symbol.name, 256, `${label}.queriedSymbols[${index}].name`);
    text(symbol.symbolKind, 128, `${label}.queriedSymbols[${index}].symbolKind`);
    safe(symbol.line, LIMITS.coordinate, `${label}.queriedSymbols[${index}].line`);
  }
  if (value.queriedDirection !== "outgoing" || value.programCoverage !== "unknown" || value.repositoryRelationCompleteness !== "not-claimed" || !RESPONSE_CLOSURE.has(value.reportedResponseClosure)) fail("Run coverage makes an unsupported claim.", "UNSUPPORTED_STRUCTURAL_RELATION_COVERAGE");
}
function preflightInputBinding(value, label, canonical) {
  fields(value, canonical
    ? ["sourceManifestScope", "sourceManifestDigest", "configDigest", "profileDigest", "normalizerVersion", "normalizerImplementationDigest"]
    : ["sourceManifestScope", "configDigest", "profileDigest", "normalizerVersion", "normalizerImplementationDigest"], label);
  if (!new Set(["full", "subset"]).has(value.sourceManifestScope)) fail(`${label}.sourceManifestScope is unsupported.`);
  if (canonical) hex(value.sourceManifestDigest, `${label}.sourceManifestDigest`);
  hex(value.configDigest, `${label}.configDigest`);
  hex(value.profileDigest, `${label}.profileDigest`);
  text(value.normalizerVersion, 128, `${label}.normalizerVersion`);
  hex(value.normalizerImplementationDigest, `${label}.normalizerImplementationDigest`);
}
function preflightPairType(value) {
  if (typeof value !== "string" || value.length === 0) fail("Only direct-name CALLS pairs are supported.", "UNSUPPORTED_STRUCTURAL_RELATION_OBSERVATION_SHAPE", "invalid");
  if (value !== "CALLS") fail("Only direct-name CALLS pairs are supported.", "UNSUPPORTED_STRUCTURAL_RELATION_OBSERVATION_SHAPE");
}
function preflightDraft(draft, sourceBytesByPath, rawBytesById) {
  fields(draft, ["projectId", "sourceManifest", "producerClaims", "rawRefs", "runs", "pairs", "diagnosticLabels"], "Envelope draft");
  text(draft.projectId, 256, "projectId");
  const sourcePaths = boundedArray(draft.sourceManifest, 1, LIMITS.sources, "sourceManifest").map((entry, index) => {
    fields(entry, ["path", "language"], `sourceManifest[${index}]`);
    pathValue(entry.path, `sourceManifest[${index}].path`);
    text(entry.language, 128, `sourceManifest[${index}].language`);
    return entry.path;
  });
  unique(sourcePaths, "sourceManifest paths");
  preflightByteMap(sourceBytesByPath, sourcePaths, "sourceBytesByPath");
  const claimKeys = boundedArray(draft.producerClaims, 1, LIMITS.claims, "producerClaims").map((entry, index) => { preflightClaim(entry, `producerClaims[${index}]`, false); return entry.producerClaimKey; });
  unique(claimKeys, "producerClaim keys");
  const rawKeys = boundedArray(draft.rawRefs, 1, LIMITS.rawRefs, "rawRefs").map((entry, index) => {
    fields(entry, ["rawRefKey", "kind", "mediaType"], `rawRefs[${index}]`);
    text(entry.rawRefKey, 128, `rawRefs[${index}].rawRefKey`);
    text(entry.kind, 128, `rawRefs[${index}].kind`);
    text(entry.mediaType, 128, `rawRefs[${index}].mediaType`);
    return entry.rawRefKey;
  });
  unique(rawKeys, "rawRef keys");
  preflightByteMap(rawBytesById, rawKeys, "rawBytesById");
  const runKeys = boundedArray(draft.runs, 1, LIMITS.runs, "runs").map((run, index) => {
    fields(run, ["runKey", "producerClaimKey", "inputBinding", "coverage", "rawRefKeys"], `runs[${index}]`);
    text(run.runKey, 128, `runs[${index}].runKey`);
    text(run.producerClaimKey, 128, `runs[${index}].producerClaimKey`);
    preflightInputBinding(run.inputBinding, `runs[${index}].inputBinding`, false);
    preflightRunCoverage(run.coverage, `runs[${index}].coverage`);
    for (const [rawIndex, rawKey] of boundedArray(run.rawRefKeys, 1, LIMITS.rawRefs, `runs[${index}].rawRefKeys`).entries()) text(rawKey, 128, `runs[${index}].rawRefKeys[${rawIndex}]`);
    return run.runKey;
  });
  unique(runKeys, "run keys");
  let occurrenceCount = 0;
  let supportCount = 0;
  const pairKeys = observationPairs(draft.pairs, "pairs").map((pair, pairIndex) => {
    fields(pair, ["pairKey", "type", "from", "to", "language", "occurrences"], `pairs[${pairIndex}]`);
    text(pair.pairKey, 128, `pairs[${pairIndex}].pairKey`);
    preflightPairType(pair.type);
    preflightEndpoint(pair.from, `pairs[${pairIndex}].from`);
    preflightEndpoint(pair.to, `pairs[${pairIndex}].to`);
    text(pair.language, 128, `pairs[${pairIndex}].language`);
    for (const [occurrenceIndex, occurrence] of boundedArray(pair.occurrences, 1, LIMITS.occurrences, `pairs[${pairIndex}].occurrences`).entries()) {
      occurrenceCount += 1;
      if (occurrenceCount > LIMITS.occurrences) fail("Occurrence limit exceeded.", "STRUCTURAL_RELATION_OBSERVATION_LIMIT");
      fields(occurrence, ["occurrenceKey", "evidence", "supports"], `pairs[${pairIndex}].occurrences[${occurrenceIndex}]`);
      text(occurrence.occurrenceKey, 128, `pairs[${pairIndex}].occurrences[${occurrenceIndex}].occurrenceKey`);
      fields(occurrence.evidence, ["path", "digest", "range"], "occurrence.evidence");
      pathValue(occurrence.evidence.path, "occurrence.evidence.path");
      hex(occurrence.evidence.digest, "occurrence.evidence.digest");
      structuralRange(occurrence.evidence.range, "occurrence.evidence.range");
      for (const support of boundedArray(occurrence.supports, 1, LIMITS.supports, "occurrence.supports")) {
        supportCount += 1;
        if (supportCount > LIMITS.supports) fail("Support limit exceeded.", "STRUCTURAL_RELATION_OBSERVATION_LIMIT");
        fields(support, ["runKey", "rawRefKey"], "support");
        text(support.runKey, 128, "support.runKey");
        text(support.rawRefKey, 128, "support.rawRefKey");
      }
    }
    return pair.pairKey;
  });
  unique(pairKeys, "pair keys");
  const diagnosticLabels = draft.diagnosticLabels === undefined ? [] : boundedArray(draft.diagnosticLabels, 0, LIMITS.occurrences, "diagnosticLabels");
  for (const [index, label] of diagnosticLabels.entries()) text(label, 512, `diagnosticLabels[${index}]`);
}
function preflightDocument(document, sourceBytesByPath, rawBytesById) {
  fields(document, ["schemaVersion", "kind", "protocol", "subject", "producerClaims", "rawRefs", "runs", "pairs", "candidateProjection", "diagnosticLabels", "authority", "instructionAuthority", "promotionAuthority", "recoveryAuthority", "graphAuthority", "envelopeId", "envelopeHash"], "Envelope");
  if (document.schemaVersion !== 0) fail("Envelope schemaVersion is unsupported.");
  text(document.kind, 128, "kind");
  fields(document.protocol, ["name", "version"], "protocol");
  text(document.protocol.name, 128, "protocol.name");
  text(document.protocol.version, 128, "protocol.version");
  fields(document.subject, ["projectId", "sourceManifest", "sourceManifestDigest"], "subject");
  text(document.subject.projectId, 256, "subject.projectId");
  let sourceDeclaredTotal = 0;
  const sourceKeys = boundedArray(document.subject.sourceManifest, 1, LIMITS.sources, "sourceManifest").map((entry, index) => {
    fields(entry, ["path", "sha256", "language", "byteLength"], `sourceManifest[${index}]`);
    pathValue(entry.path, `sourceManifest[${index}].path`);
    hex(entry.sha256, `sourceManifest[${index}].sha256`);
    text(entry.language, 128, `sourceManifest[${index}].language`);
    sourceDeclaredTotal += safe(entry.byteLength, LIMITS.itemBytes, `sourceManifest[${index}].byteLength`);
    if (sourceDeclaredTotal > LIMITS.totalBytes) fail("Source descriptor total exceeds limit.", "STRUCTURAL_RELATION_OBSERVATION_LIMIT");
    return entry.path;
  });
  unique(sourceKeys, "sourceManifest paths");
  hex(document.subject.sourceManifestDigest, "subject.sourceManifestDigest");
  let rawDeclaredTotal = 0;
  const rawKeys = boundedArray(document.rawRefs, 1, LIMITS.rawRefs, "rawRefs").map((entry, index) => {
    fields(entry, ["kind", "mediaType", "sha256", "byteLength", "rawRefId"], `rawRefs[${index}]`);
    text(entry.kind, 128, `rawRefs[${index}].kind`);
    text(entry.mediaType, 128, `rawRefs[${index}].mediaType`);
    hex(entry.sha256, `rawRefs[${index}].sha256`);
    rawDeclaredTotal += safe(entry.byteLength, LIMITS.itemBytes, `rawRefs[${index}].byteLength`);
    if (rawDeclaredTotal > LIMITS.totalBytes) fail("Raw descriptor total exceeds limit.", "STRUCTURAL_RELATION_OBSERVATION_LIMIT");
    return text(entry.rawRefId, 128, `rawRefs[${index}].rawRefId`);
  });
  unique(rawKeys, "rawRef IDs");
  const claimIds = boundedArray(document.producerClaims, 1, LIMITS.claims, "producerClaims").map((entry, index) => { preflightClaim(entry, `producerClaims[${index}]`, true); return entry.producerClaimId; });
  unique(claimIds, "producerClaim IDs");
  const runIds = boundedArray(document.runs, 1, LIMITS.runs, "runs").map((run, index) => {
    fields(run, ["producerClaimId", "inputBinding", "coverage", "rawRefIds", "runId"], `runs[${index}]`);
    text(run.producerClaimId, 128, `runs[${index}].producerClaimId`);
    preflightInputBinding(run.inputBinding, `runs[${index}].inputBinding`, true);
    preflightRunCoverage(run.coverage, `runs[${index}].coverage`);
    for (const [rawIndex, rawId] of boundedArray(run.rawRefIds, 1, LIMITS.rawRefs, `runs[${index}].rawRefIds`).entries()) text(rawId, 128, `runs[${index}].rawRefIds[${rawIndex}]`);
    return text(run.runId, 128, `runs[${index}].runId`);
  });
  unique(runIds, "run IDs");
  let occurrenceCount = 0;
  let supportCount = 0;
  const pairIds = observationPairs(document.pairs, "pairs").map((pair, pairIndex) => {
    fields(pair, ["type", "from", "to", "language", "pairId", "occurrences"], `pairs[${pairIndex}]`);
    preflightPairType(pair.type);
    preflightEndpoint(pair.from, `pairs[${pairIndex}].from`);
    preflightEndpoint(pair.to, `pairs[${pairIndex}].to`);
    text(pair.language, 128, `pairs[${pairIndex}].language`);
    text(pair.pairId, 128, `pairs[${pairIndex}].pairId`);
    for (const occurrence of boundedArray(pair.occurrences, 1, LIMITS.occurrences, `pairs[${pairIndex}].occurrences`)) {
      occurrenceCount += 1;
      if (occurrenceCount > LIMITS.occurrences) fail("Occurrence limit exceeded.", "STRUCTURAL_RELATION_OBSERVATION_LIMIT");
      fields(occurrence, ["pairId", "evidence", "occurrenceId", "supports"], "occurrence");
      text(occurrence.pairId, 128, "occurrence.pairId");
      fields(occurrence.evidence, ["path", "digest", "range"], "occurrence.evidence");
      pathValue(occurrence.evidence.path, "occurrence.evidence.path");
      hex(occurrence.evidence.digest, "occurrence.evidence.digest");
      structuralRange(occurrence.evidence.range, "occurrence.evidence.range");
      text(occurrence.occurrenceId, 128, "occurrence.occurrenceId");
      for (const support of boundedArray(occurrence.supports, 1, LIMITS.supports, "occurrence.supports")) {
        supportCount += 1;
        if (supportCount > LIMITS.supports) fail("Support limit exceeded.", "STRUCTURAL_RELATION_OBSERVATION_LIMIT");
        fields(support, ["occurrenceId", "runId", "rawRefId", "supportId"], "support");
        text(support.occurrenceId, 128, "support.occurrenceId");
        text(support.runId, 128, "support.runId");
        text(support.rawRefId, 128, "support.rawRefId");
        text(support.supportId, 128, "support.supportId");
      }
    }
    return pair.pairId;
  });
  unique(pairIds, "pair IDs");
  fields(document.candidateProjection, ["status", "policy", "occurrenceDisposition", "repositoryCompleteness", "entries", "projectionDigest"], "candidateProjection");
  text(document.candidateProjection.status, 128, "candidateProjection.status");
  text(document.candidateProjection.policy, 128, "candidateProjection.policy");
  text(document.candidateProjection.occurrenceDisposition, 128, "candidateProjection.occurrenceDisposition");
  text(document.candidateProjection.repositoryCompleteness, 128, "candidateProjection.repositoryCompleteness");
  for (const entry of boundedArray(document.candidateProjection.entries, 1, LIMITS.pairs, "candidateProjection.entries")) {
    fields(entry, ["pairId", "occurrenceIds"], "candidateProjection.entry");
    text(entry.pairId, 128, "candidateProjection.entry.pairId");
    for (const occurrenceId of boundedArray(entry.occurrenceIds, 1, LIMITS.occurrences, "candidateProjection.entry.occurrenceIds")) text(occurrenceId, 128, "candidateProjection occurrenceId");
  }
  hex(document.candidateProjection.projectionDigest, "candidateProjection.projectionDigest");
  for (const [index, label] of boundedArray(document.diagnosticLabels, 0, LIMITS.occurrences, "diagnosticLabels").entries()) text(label, 512, `diagnosticLabels[${index}]`);
  text(document.authority, 128, "authority");
  for (const key of ["instructionAuthority", "promotionAuthority", "recoveryAuthority", "graphAuthority"]) if (typeof document[key] !== "boolean") fail(`${key} must be boolean.`);
  text(document.envelopeId, 128, "envelopeId");
  hex(document.envelopeHash, "envelopeHash");
  if (sourceBytesByPath !== undefined) preflightByteMap(sourceBytesByPath, sourceKeys, "sourceBytesByPath");
  if (rawBytesById !== undefined) preflightByteMap(rawBytesById, rawKeys, "rawBytesById");
}

function validateMap(map, label) { if (!(map instanceof Map)) fail(`${label} must be a Map.`, "INVALID_STRUCTURAL_RELATION_BYTE_MAP"); }
function mapExact(map, descriptors, label) {
  validateMap(map, label);
  const expected = descriptors.map((entry) => entry.path ?? entry.rawRefId).sort(ascii);
  const actual = [...map.keys()];
  if (actual.some((key) => typeof key !== "string")) fail(`${label} keys must be strings.`, "INVALID_STRUCTURAL_RELATION_BYTE_MAP");
  actual.sort(ascii);
  if (canonicalJson(actual) !== canonicalJson(expected)) fail(`${label} keys do not exactly match descriptors.`, "STRUCTURAL_RELATION_BYTE_MAP_MISMATCH");
  let total = 0;
  for (const descriptor of descriptors) {
    const key = descriptor.path ?? descriptor.rawRefId;
    const bytes = map.get(key);
    if (!(bytes instanceof Uint8Array)) fail(`${label}[${key}] must be Uint8Array.`, "INVALID_STRUCTURAL_RELATION_BYTE_MAP");
    if (bytes.byteLength > LIMITS.itemBytes) fail(`${label}[${key}] exceeds the per-item byte limit.`, "STRUCTURAL_RELATION_OBSERVATION_LIMIT");
    total += bytes.byteLength;
    if (total > LIMITS.totalBytes) fail(`${label} exceeds the total byte limit.`, "STRUCTURAL_RELATION_OBSERVATION_LIMIT");
    if (descriptor.byteLength !== bytes.byteLength || descriptor.sha256 !== hash(bytes)) fail(`${label}[${key}] does not match its descriptor.`, "STRUCTURAL_RELATION_BYTE_MAP_MISMATCH");
  }
}
function sourceText(bytes, label) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail(`${label} UTF-8 BOM is unsupported in v0.`, "UNSUPPORTED_STRUCTURAL_RELATION_SOURCE_BOM");
  let decoded; try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail(`${label} is not fatal-valid UTF-8.`, "INVALID_STRUCTURAL_RELATION_SOURCE_UTF8"); }
  if (/(^|[^\r])\r(?!\n)/.test(decoded)) fail(`${label} contains a lone CR.`, "UNSUPPORTED_STRUCTURAL_RELATION_LINE_ENDING");
  return { decoded, lines: decoded.split(/\r\n|\n/) };
}
function position(lines, value, label) {
  fields(value, ["line", "character"], label); const line = safe(value.line, LIMITS.coordinate, `${label}.line`); const character = safe(value.character, LIMITS.coordinate, `${label}.character`);
  if (line >= lines.length || character > lines[line].length) fail(`${label} is outside source bounds.`, "STRUCTURAL_RELATION_COORDINATE_MISMATCH");
  if (character > 0 && character < lines[line].length) { const before = lines[line].charCodeAt(character - 1); const after = lines[line].charCodeAt(character); if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) fail(`${label} splits a surrogate pair.`, "STRUCTURAL_RELATION_COORDINATE_MISMATCH"); }
  return { line, character };
}
function range(lines, value, label) { fields(value, ["start", "end"], label); const start = position(lines, value.start, `${label}.start`); const end = position(lines, value.end, `${label}.end`); if (start.line > end.line || (start.line === end.line && start.character > end.character)) fail(`${label} is reversed.`, "STRUCTURAL_RELATION_COORDINATE_MISMATCH"); return { start, end }; }
const comparePos = (a, b) => a.line - b.line || a.character - b.character;
const contains = (outer, inner) => comparePos(outer.start, inner.start) <= 0 && comparePos(inner.end, outer.end) <= 0;
function sliceRange(lines, value) { if (value.start.line !== value.end.line) return null; return lines[value.start.line].slice(value.start.character, value.end.character); }

function normalizeSourceDescriptors(input, sourceBytesByPath) {
  if (!Array.isArray(input) || input.length < 1 || input.length > LIMITS.sources) fail("sourceManifest count is unsupported.", "STRUCTURAL_RELATION_OBSERVATION_LIMIT");
  validateMap(sourceBytesByPath, "sourceBytesByPath");
  const paths = input.map((entry, index) => { fields(entry, ["path", "language"], `sourceManifest[${index}]`); return pathValue(entry.path, `sourceManifest[${index}].path`); }); unique(paths, "sourceManifest paths");
  const sourceMapKeys = [...sourceBytesByPath.keys()].sort(ascii); if (canonicalJson(sourceMapKeys) !== canonicalJson([...paths].sort(ascii))) fail("sourceBytesByPath keys do not exactly match sourceManifest.", "STRUCTURAL_RELATION_BYTE_MAP_MISMATCH");
  let total = 0;
  return input.map((entry, index) => { const bytes = sourceBytesByPath.get(entry.path); if (!(bytes instanceof Uint8Array)) fail(`sourceBytesByPath[${entry.path}] must be Uint8Array.`, "INVALID_STRUCTURAL_RELATION_BYTE_MAP"); if (bytes.byteLength > LIMITS.itemBytes) fail("Source exceeds per-item byte limit.", "STRUCTURAL_RELATION_OBSERVATION_LIMIT"); total += bytes.byteLength; if (total > LIMITS.totalBytes) fail("Sources exceed total byte limit.", "STRUCTURAL_RELATION_OBSERVATION_LIMIT"); return { path: entry.path, sha256: hash(bytes), language: text(entry.language, 128, `sourceManifest[${index}].language`), byteLength: bytes.byteLength }; }).sort((a, b) => ascii(a.path, b.path));
}
function normalizeRawDescriptors(input, rawBytesByKey) {
  if (!Array.isArray(input) || input.length < 1 || input.length > LIMITS.rawRefs) fail("rawRefs count is unsupported.", "STRUCTURAL_RELATION_OBSERVATION_LIMIT");
  validateMap(rawBytesByKey, "rawBytesById"); const keys = input.map((entry, index) => { fields(entry, ["rawRefKey", "kind", "mediaType"], `rawRefs[${index}]`); return text(entry.rawRefKey, 128, `rawRefs[${index}].rawRefKey`); }); unique(keys, "rawRef keys"); if (canonicalJson([...rawBytesByKey.keys()].sort(ascii)) !== canonicalJson([...keys].sort(ascii))) fail("rawBytesById keys do not exactly match builder rawRef keys.", "STRUCTURAL_RELATION_BYTE_MAP_MISMATCH");
  let total = 0; return input.map((entry, index) => { const bytes = rawBytesByKey.get(entry.rawRefKey); if (!(bytes instanceof Uint8Array)) fail(`rawBytesById[${entry.rawRefKey}] must be Uint8Array.`, "INVALID_STRUCTURAL_RELATION_BYTE_MAP"); if (bytes.byteLength > LIMITS.itemBytes) fail("Raw ref exceeds per-item byte limit.", "STRUCTURAL_RELATION_OBSERVATION_LIMIT"); total += bytes.byteLength; if (total > LIMITS.totalBytes) fail("Raw refs exceed total byte limit.", "STRUCTURAL_RELATION_OBSERVATION_LIMIT"); const payload = { kind: text(entry.kind, 128, `rawRefs[${index}].kind`), mediaType: text(entry.mediaType, 128, `rawRefs[${index}].mediaType`), sha256: hash(bytes), byteLength: bytes.byteLength }; return { ...payload, rawRefKey: entry.rawRefKey, rawRefId: id("structural-raw", payload) }; }).sort((a, b) => ascii(a.rawRefId, b.rawRefId));
}
function normalizeClaim(entry, index) {
  fields(entry, ["producerClaimKey", "name", "version", "executableIdentity", "profileIdentity", "reportedTransport", "reportedMethod", "analysisMethodClaim", "producerIdentityEvidenceStatus"], `producerClaims[${index}]`);
  fields(entry.analysisMethodClaim, ["reportedValue", "reportSource", "truthStatus"], `producerClaims[${index}].analysisMethodClaim`);
  if (!CLAIM_SOURCES.has(entry.analysisMethodClaim.reportSource) || entry.analysisMethodClaim.truthStatus !== "unknown") fail("Analysis method truth values other than unknown are unsupported.", "UNSUPPORTED_STRUCTURAL_RELATION_TRUTH_STATUS");
  if ((entry.analysisMethodClaim.reportSource === "absent") !== (entry.analysisMethodClaim.reportedValue === null)) fail("Absent analysis method claim must have null reportedValue.");
  if (!EVIDENCE_STATUS.has(entry.producerIdentityEvidenceStatus)) fail("producerIdentityEvidenceStatus is unsupported.");
  const payload = { name: text(entry.name, 128, "producer name"), version: text(entry.version, 128, "producer version"), executableIdentity: text(entry.executableIdentity, 128, "executableIdentity"), profileIdentity: text(entry.profileIdentity, 128, "profileIdentity"), reportedTransport: text(entry.reportedTransport, 128, "reportedTransport"), reportedMethod: text(entry.reportedMethod, 128, "reportedMethod"), analysisMethodClaim: { reportedValue: text(entry.analysisMethodClaim.reportedValue, 128, "reportedValue", true), reportSource: entry.analysisMethodClaim.reportSource, truthStatus: "unknown" }, producerIdentityEvidenceStatus: entry.producerIdentityEvidenceStatus };
  return { ...payload, producerClaimKey: text(entry.producerClaimKey, 128, "producerClaimKey"), producerClaimId: id("structural-producer", payload) };
}
function sourceSubsetDigest(descriptors) { return H(descriptors.map(({ path, sha256, language, byteLength }) => ({ path, sha256, language, byteLength })).sort((a, b) => ascii(a.path, b.path))); }
function endpoint(entry, label, sourcesByPath, sourceTexts) {
  fields(entry, ["path", "digest", "name", "symbolKind", "declarationRange", "selectionRange"], label); const source = sourcesByPath.get(pathValue(entry.path, `${label}.path`)); if (!source || entry.digest !== source.sha256) fail(`${label} does not bind to sourceManifest.`, "STRUCTURAL_RELATION_SOURCE_MISMATCH"); const lines = sourceTexts.get(entry.path).lines; const declarationRange = range(lines, entry.declarationRange, `${label}.declarationRange`); const selectionRange = range(lines, entry.selectionRange, `${label}.selectionRange`); if (!contains(declarationRange, selectionRange)) fail(`${label} selectionRange is outside declarationRange.`, "STRUCTURAL_RELATION_COORDINATE_MISMATCH"); const name = text(entry.name, 256, `${label}.name`); if (sliceRange(lines, selectionRange) !== name) fail(`${label} selection lexeme does not equal name.`, "STRUCTURAL_RELATION_LEXEME_MISMATCH"); return { path: entry.path, digest: entry.digest, name, symbolKind: text(entry.symbolKind, 128, `${label}.symbolKind`), declarationRange, selectionRange };
}

const DIGEST_PLACEHOLDER = "0".repeat(64);
const fixedId = (prefix) => `${prefix}-${"0".repeat(24)}`;

function preflightCanonicalEnvelopeBudget(draft, sourceBytesByPath, rawBytesById, storage) {
  const producerClaimId = fixedId("structural-producer");
  const rawRefId = fixedId("structural-raw");
  const runId = fixedId("structural-run");
  const pairId = fixedId("structural-pair");
  const occurrenceId = fixedId("structural-occurrence");
  const supportId = fixedId("structural-support");
  const sourceManifest = draft.sourceManifest.map((entry) => ({ path: entry.path, sha256: DIGEST_PLACEHOLDER, language: entry.language, byteLength: sourceBytesByPath.get(entry.path).byteLength }));
  const producerClaims = draft.producerClaims.map((entry) => ({ name: entry.name, version: entry.version, executableIdentity: entry.executableIdentity, profileIdentity: entry.profileIdentity, reportedTransport: entry.reportedTransport, reportedMethod: entry.reportedMethod, analysisMethodClaim: { reportedValue: entry.analysisMethodClaim.reportedValue, reportSource: entry.analysisMethodClaim.reportSource, truthStatus: "unknown" }, producerIdentityEvidenceStatus: entry.producerIdentityEvidenceStatus, producerClaimId }));
  const rawRefs = draft.rawRefs.map((entry) => ({ kind: entry.kind, mediaType: entry.mediaType, sha256: DIGEST_PLACEHOLDER, byteLength: rawBytesById.get(entry.rawRefKey).byteLength, rawRefId }));
  const runs = draft.runs.map((entry) => ({
    producerClaimId,
    inputBinding: { sourceManifestScope: entry.inputBinding.sourceManifestScope, sourceManifestDigest: DIGEST_PLACEHOLDER, configDigest: entry.inputBinding.configDigest, profileDigest: entry.inputBinding.profileDigest, normalizerVersion: entry.inputBinding.normalizerVersion, normalizerImplementationDigest: entry.inputBinding.normalizerImplementationDigest },
    coverage: { admittedSources: entry.coverage.admittedSources.map((item) => ({ path: item.path, digest: item.digest })), queriedDirection: "outgoing", queriedSymbols: entry.coverage.queriedSymbols.map((item) => ({ path: item.path, digest: item.digest, name: item.name, symbolKind: item.symbolKind, line: item.line })), reportedResponseClosure: entry.coverage.reportedResponseClosure, programCoverage: "unknown", repositoryRelationCompleteness: "not-claimed" },
    rawRefIds: entry.rawRefKeys.map(() => rawRefId),
    runId,
  }));
  const pairs = draft.pairs.map((entry) => ({
    type: "CALLS",
    from: entry.from,
    to: entry.to,
    language: entry.language,
    pairId,
    occurrences: entry.occurrences.map((occurrence) => ({ pairId, evidence: occurrence.evidence, occurrenceId, supports: occurrence.supports.map(() => ({ occurrenceId, runId, rawRefId, supportId })) })),
  }));
  const candidateProjection = {
    status: "candidate-only",
    policy: "relation-pair-only-v0",
    occurrenceDisposition: "preserved-in-envelope-not-in-pair",
    repositoryCompleteness: "not-claimed",
    entries: draft.pairs.map((entry) => ({ pairId, occurrenceIds: entry.occurrences.map(() => occurrenceId) })),
    projectionDigest: DIGEST_PLACEHOLDER,
  };
  const payload = {
    schemaVersion: 0,
    kind: "StructuralRelationObservationEnvelope",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-structural-relation-observation-envelope"), version: STRUCTURAL_RELATION_OBSERVATION_ENVELOPE_VERSION },
    subject: { projectId: draft.projectId, sourceManifest, sourceManifestDigest: DIGEST_PLACEHOLDER },
    producerClaims,
    rawRefs,
    runs,
    pairs,
    candidateProjection,
    diagnosticLabels: draft.diagnosticLabels === undefined ? [] : draft.diagnosticLabels,
    authority: "ephemeral-host-evidence-only",
    instructionAuthority: false,
    promotionAuthority: false,
    recoveryAuthority: false,
    graphAuthority: false,
  };
  return jsonSize({ ...payload, envelopeId: fixedId("structural-envelope"), envelopeHash: DIGEST_PLACEHOLDER }, "Canonical envelope");
}

/**
 * Builds the canonical, authority-free envelope from caller-owned descriptors.
 * Draft-only *Key fields bind references during construction and never enter
 * canonical identity. Source bytes and accepted decoded raw-record bytes remain
 * caller-owned; only their bounded descriptors and content identities persist.
 * Schema objects and arrays must be ordinary JSON-style containers composed of
 * enumerable own data properties/elements; accessors and collection overrides
 * are rejected before any caller-provided value is read or hashed. The draft
 * byte limit bounds transient untrusted input separately from the persisted
 * canonical-envelope limit. Hosts should construct ordinary data and compact
 * temporary keys automatically; users should not have to edit envelope JSON.
 * Do not execute arbitrary getters/toJSON or discard evidence to fit a limit.
 * A rejected observation grants no task-wide stop/continue authority. Hosts may
 * seek other evidence, preserving the failed observation's unknown coverage.
 * Never classify errors by the UNSUPPORTED prefix alone: invalid truth,
 * coverage and authority claims must remain rejected. An unsupported shape
 * describes this v0 capability, not relation absence or semantic sufficiency.
 */
export function buildStructuralRelationObservationEnvelope(draft, { sourceBytesByPath, rawBytesById } = {}, storage = null) {
  preflightDraft(draft, sourceBytesByPath, rawBytesById);
  jsonSize(draft, "Envelope draft");
  preflightCanonicalEnvelopeBudget(draft, sourceBytesByPath, rawBytesById, storage);
  const projectId = text(draft.projectId, 256, "projectId");
  const sources = normalizeSourceDescriptors(draft.sourceManifest, sourceBytesByPath); const sourcesByPath = new Map(sources.map((entry) => [entry.path, entry])); const sourceTexts = new Map(sources.map((entry) => [entry.path, sourceText(sourceBytesByPath.get(entry.path), entry.path)])); const sourceManifestDigest = sourceSubsetDigest(sources);
  const rawWithKeys = normalizeRawDescriptors(draft.rawRefs, rawBytesById); const rawByKey = new Map(rawWithKeys.map((entry) => [entry.rawRefKey, entry]));
  if (!Array.isArray(draft.producerClaims) || draft.producerClaims.length < 1 || draft.producerClaims.length > LIMITS.claims) fail("producerClaims count is unsupported.", "STRUCTURAL_RELATION_OBSERVATION_LIMIT"); const claimsWithKeys = draft.producerClaims.map(normalizeClaim); unique(claimsWithKeys.map((entry) => entry.producerClaimKey), "producerClaim keys"); unique(claimsWithKeys.map((entry) => entry.producerClaimId), "producerClaim IDs"); const claimByKey = new Map(claimsWithKeys.map((entry) => [entry.producerClaimKey, entry]));
  if (!Array.isArray(draft.runs) || draft.runs.length < 1 || draft.runs.length > LIMITS.runs) fail("runs count is unsupported.", "STRUCTURAL_RELATION_OBSERVATION_LIMIT");
  const runsWithKeys = draft.runs.map((entry, index) => {
    fields(entry, ["runKey", "producerClaimKey", "inputBinding", "coverage", "rawRefKeys"], `runs[${index}]`); fields(entry.inputBinding, ["sourceManifestScope", "configDigest", "profileDigest", "normalizerVersion", "normalizerImplementationDigest"], `runs[${index}].inputBinding`); fields(entry.coverage, ["admittedSources", "queriedDirection", "queriedSymbols", "reportedResponseClosure", "programCoverage", "repositoryRelationCompleteness"], `runs[${index}].coverage`);
    const claim = claimByKey.get(entry.producerClaimKey); if (!claim) fail("Run references unknown producer claim.", "STRUCTURAL_RELATION_CLOSURE_MISMATCH");
    const admitted = boundedArray(entry.coverage.admittedSources, 1, LIMITS.sources, "Run admittedSources").map((item, itemIndex) => { fields(item, ["path", "digest"], `admittedSources[${itemIndex}]`); const source = sourcesByPath.get(item.path); if (!source || source.sha256 !== item.digest) fail("Run admitted source is outside the envelope manifest.", "STRUCTURAL_RELATION_RUN_SOURCE_MISMATCH"); return { path: item.path, digest: item.digest }; }).sort((a, b) => ascii(a.path, b.path)); unique(admitted.map((item) => item.path), "admittedSources");
    const scope = entry.inputBinding.sourceManifestScope; if (!new Set(["full", "subset"]).has(scope)) fail("sourceManifestScope is unsupported."); if (scope === "full" && admitted.length !== sources.length) fail("Full run scope must admit the complete manifest.", "STRUCTURAL_RELATION_RUN_SOURCE_MISMATCH"); const admittedDescriptors = admitted.map((item) => sourcesByPath.get(item.path));
    const queriedSymbols = boundedArray(entry.coverage.queriedSymbols, 0, LIMITS.occurrences, "queriedSymbols").map((item, itemIndex) => { fields(item, ["path", "digest", "name", "symbolKind", "line"], `queriedSymbols[${itemIndex}]`); if (!admitted.some((source) => source.path === item.path && source.digest === item.digest)) fail("queriedSymbol is outside run admittedSources.", "STRUCTURAL_RELATION_RUN_SOURCE_MISMATCH"); return { path: item.path, digest: item.digest, name: text(item.name, 256, "queried symbol name"), symbolKind: text(item.symbolKind, 128, "queried symbol kind"), line: safe(item.line, LIMITS.coordinate, "queried symbol line") }; }).sort((a, b) => ascii(canonicalJson(a), canonicalJson(b)));
    if (entry.coverage.queriedDirection !== "outgoing" || entry.coverage.programCoverage !== "unknown" || entry.coverage.repositoryRelationCompleteness !== "not-claimed" || !RESPONSE_CLOSURE.has(entry.coverage.reportedResponseClosure)) fail("Run coverage makes an unsupported claim.", "UNSUPPORTED_STRUCTURAL_RELATION_COVERAGE");
    const rawRefIds = boundedArray(entry.rawRefKeys, 1, LIMITS.rawRefs, "Run rawRefKeys").map((key) => rawByKey.get(key)?.rawRefId || fail("Run references unknown rawRef.", "STRUCTURAL_RELATION_CLOSURE_MISMATCH")).sort(ascii); unique(rawRefIds, "run rawRefIds");
    const inputBinding = { sourceManifestScope: scope, sourceManifestDigest: sourceSubsetDigest(admittedDescriptors), configDigest: hex(entry.inputBinding.configDigest, "configDigest"), profileDigest: hex(entry.inputBinding.profileDigest, "profileDigest"), normalizerVersion: text(entry.inputBinding.normalizerVersion, 128, "normalizerVersion"), normalizerImplementationDigest: hex(entry.inputBinding.normalizerImplementationDigest, "normalizerImplementationDigest") };
    const coverage = { admittedSources: admitted, queriedDirection: "outgoing", queriedSymbols, reportedResponseClosure: entry.coverage.reportedResponseClosure, programCoverage: "unknown", repositoryRelationCompleteness: "not-claimed" }; const payload = { producerClaimId: claim.producerClaimId, inputBinding, coverage, rawRefIds }; return { ...payload, runKey: text(entry.runKey, 128, "runKey"), runId: id("structural-run", payload) };
  }); unique(runsWithKeys.map((entry) => entry.runKey), "run keys"); unique(runsWithKeys.map((entry) => entry.runId), "run IDs"); const runByKey = new Map(runsWithKeys.map((entry) => [entry.runKey, entry]));
  if (!Array.isArray(draft.pairs) || draft.pairs.length < 1 || draft.pairs.length > LIMITS.pairs) fail("Only positive bounded CALLS observations are supported.", "UNSUPPORTED_STRUCTURAL_RELATION_OBSERVATION_SHAPE"); let occurrenceCount = 0; let supportCount = 0;
  const pairsWithKeys = draft.pairs.map((entry, index) => {
    fields(entry, ["pairKey", "type", "from", "to", "language", "occurrences"], `pairs[${index}]`); if (entry.type !== "CALLS") fail("Only direct-name CALLS pairs are supported.", "UNSUPPORTED_STRUCTURAL_RELATION_OBSERVATION_SHAPE"); const from = endpoint(entry.from, `pairs[${index}].from`, sourcesByPath, sourceTexts); const to = endpoint(entry.to, `pairs[${index}].to`, sourcesByPath, sourceTexts); const pairPayload = { type: "CALLS", from, to, language: text(entry.language, 128, "pair language") }; const pairId = id("structural-pair", pairPayload);
    if (!Array.isArray(entry.occurrences) || entry.occurrences.length < 1) fail("Pair must contain occurrences.", "UNSUPPORTED_STRUCTURAL_RELATION_OBSERVATION_SHAPE"); const occurrences = entry.occurrences.map((occurrence, occurrenceIndex) => {
      occurrenceCount += 1; if (occurrenceCount > LIMITS.occurrences) fail("Occurrence limit exceeded.", "STRUCTURAL_RELATION_OBSERVATION_LIMIT"); fields(occurrence, ["occurrenceKey", "evidence", "supports"], `occurrences[${occurrenceIndex}]`); fields(occurrence.evidence, ["path", "digest", "range"], "occurrence.evidence"); const source = sourcesByPath.get(occurrence.evidence.path); if (!source || source.sha256 !== occurrence.evidence.digest) fail("Occurrence does not bind to sourceManifest.", "STRUCTURAL_RELATION_SOURCE_MISMATCH"); if (source.path !== from.path || source.sha256 !== from.digest) fail("Occurrence must bind to the caller source in v0.", "STRUCTURAL_RELATION_SOURCE_MISMATCH"); const evidenceRange = range(sourceTexts.get(source.path).lines, occurrence.evidence.range, "occurrence.evidence.range"); if (!contains(from.declarationRange, evidenceRange)) fail("Occurrence is outside caller declaration.", "STRUCTURAL_RELATION_COORDINATE_MISMATCH"); if (sliceRange(sourceTexts.get(source.path).lines, evidenceRange) !== to.name) fail("Name-different call occurrences are unsupported in v0.", "UNSUPPORTED_STRUCTURAL_RELATION_OBSERVATION_SHAPE"); const occurrencePayload = { pairId, evidence: { path: source.path, digest: source.sha256, range: evidenceRange } }; const occurrenceId = id("structural-occurrence", occurrencePayload);
      if (!Array.isArray(occurrence.supports) || occurrence.supports.length < 1) fail("Occurrence must have support.", "UNSUPPORTED_STRUCTURAL_RELATION_OBSERVATION_SHAPE"); const supports = occurrence.supports.map((support) => { supportCount += 1; if (supportCount > LIMITS.supports) fail("Support limit exceeded.", "STRUCTURAL_RELATION_OBSERVATION_LIMIT"); fields(support, ["runKey", "rawRefKey"], "support"); const run = runByKey.get(support.runKey); const raw = rawByKey.get(support.rawRefKey); if (!run || !raw || !run.rawRefIds.includes(raw.rawRefId)) fail("Support references are not closed.", "STRUCTURAL_RELATION_CLOSURE_MISMATCH"); for (const bound of [from, to, occurrencePayload.evidence]) if (!run.coverage.admittedSources.some((item) => item.path === bound.path && item.digest === bound.digest)) fail("Support uses a source outside run admittedSources.", "STRUCTURAL_RELATION_RUN_SOURCE_MISMATCH"); const payload = { occurrenceId, runId: run.runId, rawRefId: raw.rawRefId }; return { ...payload, supportId: id("structural-support", payload) }; }).sort((a, b) => ascii(a.supportId, b.supportId)); unique(supports.map((item) => item.supportId), "occurrence supports"); return { ...occurrencePayload, occurrenceKey: text(occurrence.occurrenceKey, 128, "occurrenceKey"), occurrenceId, supports };
    }).sort((a, b) => ascii(a.occurrenceId, b.occurrenceId)); unique(occurrences.map((item) => item.occurrenceId), "pair occurrences"); return { ...pairPayload, pairKey: text(entry.pairKey, 128, "pairKey"), pairId, occurrences };
  }).sort((a, b) => ascii(a.pairId, b.pairId)); unique(pairsWithKeys.map((entry) => entry.pairKey), "pair keys"); unique(pairsWithKeys.map((entry) => entry.pairId), "pair IDs");
  const usedRuns = new Set(); const usedRaw = new Set(); for (const pair of pairsWithKeys) for (const occurrence of pair.occurrences) for (const support of occurrence.supports) { usedRuns.add(support.runId); usedRaw.add(support.rawRefId); } const usedClaims = new Set(runsWithKeys.map((run) => run.producerClaimId)); if (usedRuns.size !== runsWithKeys.length || usedRaw.size !== rawWithKeys.length || usedClaims.size !== claimsWithKeys.length) fail("Envelope contains an orphan producer claim, run, or rawRef.", "STRUCTURAL_RELATION_CLOSURE_MISMATCH");
  const projectionEntries = pairsWithKeys.map((pair) => ({ pairId: pair.pairId, occurrenceIds: pair.occurrences.map((item) => item.occurrenceId).sort(ascii) })).sort((a, b) => ascii(a.pairId, b.pairId)); const projectionPayload = { policy: "relation-pair-only-v0", entries: projectionEntries }; const candidateProjection = { status: "candidate-only", policy: "relation-pair-only-v0", occurrenceDisposition: "preserved-in-envelope-not-in-pair", repositoryCompleteness: "not-claimed", entries: projectionEntries, projectionDigest: H(projectionPayload) };
  const clean = (entry) => Object.fromEntries(Object.entries(entry).filter(([key]) => !key.endsWith("Key")));
  const payload = { schemaVersion: 0, kind: "StructuralRelationObservationEnvelope", protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-structural-relation-observation-envelope"), version: STRUCTURAL_RELATION_OBSERVATION_ENVELOPE_VERSION }, subject: { projectId, sourceManifest: sources, sourceManifestDigest }, producerClaims: claimsWithKeys.map(clean).sort((a, b) => ascii(a.producerClaimId, b.producerClaimId)), rawRefs: rawWithKeys.map(clean).sort((a, b) => ascii(a.rawRefId, b.rawRefId)), runs: runsWithKeys.map(clean).sort((a, b) => ascii(a.runId, b.runId)), pairs: pairsWithKeys.map((pair) => clean({ ...pair, occurrences: pair.occurrences.map((occurrence) => clean(occurrence)) })), candidateProjection, diagnosticLabels: (draft.diagnosticLabels || []).map((value) => text(value, 512, "diagnostic label")).sort(ascii), authority: "ephemeral-host-evidence-only", instructionAuthority: false, promotionAuthority: false, recoveryAuthority: false, graphAuthority: false };
  const envelopeHash = H(payload); const document = { ...payload, envelopeId: `structural-envelope-${envelopeHash.slice(0, 24)}`, envelopeHash }; verifyStructuralRelationObservationEnvelope(document, { sourceBytesByPath, rawBytesById: new Map(rawWithKeys.map((entry) => [entry.rawRefId, rawBytesById.get(entry.rawRefKey)])) }); return document;
}

// Private Host preparation for an already authored v0 draft, not a provider
// semantic mapper. No persistence, retries, partial envelopes or task decisions.
const unavailableCodes = new Set([
  "UNSUPPORTED_STRUCTURAL_RELATION_OBSERVATION_SHAPE",
  "UNSUPPORTED_STRUCTURAL_RELATION_SOURCE_BOM",
  "UNSUPPORTED_STRUCTURAL_RELATION_LINE_ENDING",
]);
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength").get;
const typedInternalKind = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag).get;
const typedValues = typedArrayPrototype.values;
const typedSet = typedArrayPrototype.set;

function preparedByteMap(value, maxEntries, label) {
  if (!(value instanceof Map) || Object.getPrototypeOf(value) !== Map.prototype || Reflect.ownKeys(value).length !== 0) fail(`${label} must be an ordinary Map.`, "INVALID_STRUCTURAL_RELATION_BYTE_MAP");
  const size = Object.getOwnPropertyDescriptor(Map.prototype, "size").get.call(value);
  if (size > maxEntries) fail(`${label} exceeds the entry limit.`, "STRUCTURAL_RELATION_OBSERVATION_LIMIT");
  const result = new Map();
  let total = 0;
  for (const [key, bytes] of Map.prototype.entries.call(value)) {
    if (typeof key !== "string" || !ArrayBuffer.isView(bytes) || typedInternalKind.call(bytes) !== "Uint8Array" || ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(bytes))) fail(`${label} requires string keys and ordinary Uint8Array/Buffer bytes.`, "INVALID_STRUCTURAL_RELATION_BYTE_MAP");
    // ValidateTypedArray rejects detached/OOB backing stores even when their
    // intrinsic byteLength is zero. Genuine zero-length views remain valid.
    try { typedValues.call(bytes); }
    catch (error) {
      if (!(error instanceof TypeError)) throw error;
      fail(`${label} contains a detached or out-of-bounds byte view.`, "INVALID_STRUCTURAL_RELATION_BYTE_MAP");
    }
    // Intrinsic reads/copies do not consult caller byteLength, iterator or slice.
    const length = typedByteLength.call(bytes);
    total += length;
    if (length > LIMITS.itemBytes || total > LIMITS.totalBytes) fail(`${label} exceeds its byte limit.`, "STRUCTURAL_RELATION_OBSERVATION_LIMIT");
    const copy = new Uint8Array(length);
    typedSet.call(copy, bytes);
    result.set(key, copy);
  }
  return result;
}

function copyPreparedData(value) {
  if (Array.isArray(value)) return ordinaryArray(value, "Prepared array").map(copyPreparedData);
  if (value !== null && typeof value === "object") {
    const result = Object.create(null);
    for (const key of Object.keys(object(value, "Prepared object"))) result[key] = copyPreparedData(Object.getOwnPropertyDescriptor(value, key).value);
    return result;
  }
  return value;
}

/**
 * Prepare a bounded v0 observation without asking users to edit bookkeeping.
 * Original per-field/count/byte bounds and the final canonical budget are
 * checked before rekeying. The original serialized draft may exceed 8 MiB;
 * the compact draft still passes the strict builder's unchanged input limit.
 * Only module-owned contract failures become local results. An unavailable
 * result does not prove absence or authorize continuing/stopping a whole task.
 */
export function prepareStructuralRelationObservationEnvelope(draft, options = {}, storage = null) {
  let stage = "input";
  try {
    fields(options, ["sourceBytesByPath", "rawBytesById"], "Preparation options");
    const sourceBytesByPath = preparedByteMap(options.sourceBytesByPath, LIMITS.sources, "sourceBytesByPath");
    const rawBytesById = preparedByteMap(options.rawBytesById, LIMITS.rawRefs, "rawBytesById");
    preflightDraft(draft, sourceBytesByPath, rawBytesById);
    const claims = new Map(draft.producerClaims.map((entry, index) => [entry.producerClaimKey, `c${index}`]));
    const raw = new Map(draft.rawRefs.map((entry, index) => [entry.rawRefKey, `b${index}`]));
    const runs = new Map(draft.runs.map((entry, index) => [entry.runKey, `r${index}`]));
    const ref = (map, key) => map.has(key) ? map.get(key) : fail("Preparation references an unknown key.", "STRUCTURAL_RELATION_CLOSURE_MISMATCH");
    // Validate original references before replacing labels, so rekeying cannot
    // repair duplicates, dangling references or raw-map identity mismatches.
    for (const run of draft.runs) {
      ref(claims, run.producerClaimKey);
      unique(run.rawRefKeys, "run rawRefKeys");
      for (const key of run.rawRefKeys) ref(raw, key);
    }
    for (const pair of draft.pairs) for (const occurrence of pair.occurrences) for (const support of occurrence.supports) {
      ref(runs, support.runKey);
      ref(raw, support.rawRefKey);
    }
    stage = "canonical-budget";
    preflightCanonicalEnvelopeBudget(draft, sourceBytesByPath, rawBytesById, storage);
    stage = "key-preparation";
    const compact = copyPreparedData(draft);
    for (const claim of compact.producerClaims) claim.producerClaimKey = ref(claims, claim.producerClaimKey);
    for (const entry of compact.rawRefs) entry.rawRefKey = ref(raw, entry.rawRefKey);
    for (const run of compact.runs) {
      run.runKey = ref(runs, run.runKey);
      run.producerClaimKey = ref(claims, run.producerClaimKey);
      run.rawRefKeys = run.rawRefKeys.map((key) => ref(raw, key));
    }
    let occurrenceCount = 0;
    for (const [index, pair] of compact.pairs.entries()) {
      pair.pairKey = `p${index}`;
      for (const occurrence of pair.occurrences) {
        occurrence.occurrenceKey = `o${occurrenceCount++}`;
        for (const support of occurrence.supports) {
          support.runKey = ref(runs, support.runKey);
          support.rawRefKey = ref(raw, support.rawRefKey);
        }
      }
    }
    const compactRaw = new Map([...rawBytesById].map(([key, bytes]) => [ref(raw, key), bytes]));
    stage = "build";
    const envelope = buildStructuralRelationObservationEnvelope(compact, { sourceBytesByPath, rawBytesById: compactRaw }, storage);
    // Bind the verifier's map by content identity, not output sort position.
    const verifiedRaw = new Map(normalizeRawDescriptors(compact.rawRefs, compactRaw)
      .map((entry) => [entry.rawRefId, compactRaw.get(entry.rawRefKey)]));
    stage = "verify";
    const { verificationReport } = verifyStructuralRelationObservationEnvelope(envelope, { sourceBytesByPath, rawBytesById: verifiedRaw });
    return { status: "ready", envelope, verificationReport, preparation: { temporaryKeys: "compacted", occurrenceCount } };
  } catch (error) {
    if (!contractFailures.has(error)) throw error;
    if (contractFailures.get(error) === "invalid") return { status: "invalid", code: error.code, stage };
    if (error.code === "STRUCTURAL_RELATION_OBSERVATION_LIMIT") return { status: "unavailable", reason: "limit", code: error.code, stage };
    if (unavailableCodes.has(error.code)) return { status: "unavailable", reason: "unsupported", code: error.code, stage };
    return { status: "invalid", code: error.code, stage };
  }
}

/**
 * Verifies canonical structure alone when byte maps are absent, or additionally
 * verifies the exact supplied source/raw bytes when either map is present. The
 * returned report is deliberately outside the envelope identity and never
 * promotes producer truth, semantic support, response completeness, or Graph
 * authority.
 */
export function verifyStructuralRelationObservationEnvelope(document, { sourceBytesByPath, rawBytesById } = {}, storage) {
  preflightDocument(document, sourceBytesByPath, rawBytesById);
  jsonSize(document, "Envelope");
  fields(document.protocol, ["name", "version"], "protocol");
  if (document.schemaVersion !== 0 || document.kind !== "StructuralRelationObservationEnvelope" || !familyFormatForOriginal("head-agent-core-structural-relation-observation-envelope", document, storage) || document.protocol?.version !== STRUCTURAL_RELATION_OBSERVATION_ENVELOPE_VERSION) fail("Envelope protocol is unsupported.");
  if (document.authority !== "ephemeral-host-evidence-only" || document.instructionAuthority !== false || document.promotionAuthority !== false || document.recoveryAuthority !== false || document.graphAuthority !== false) fail("Envelope cannot carry authority.", "UNSUPPORTED_STRUCTURAL_RELATION_AUTHORITY");
  fields(document.subject, ["projectId", "sourceManifest", "sourceManifestDigest"], "subject"); text(document.subject.projectId, 256, "projectId"); if (!Array.isArray(document.subject.sourceManifest) || document.subject.sourceManifest.length < 1 || document.subject.sourceManifest.length > LIMITS.sources) fail("sourceManifest count invalid."); const sources = document.subject.sourceManifest; exactOrder(sources, [...sources].sort((a, b) => ascii(a.path, b.path)), "sourceManifest"); unique(sources.map((entry) => entry.path), "source paths"); let sourceDeclaredTotal=0; for (const entry of sources) { fields(entry, ["path", "sha256", "language", "byteLength"], "source descriptor"); pathValue(entry.path, "source path"); hex(entry.sha256, "source digest"); text(entry.language, 128, "source language"); sourceDeclaredTotal+=safe(entry.byteLength, LIMITS.itemBytes, "source byteLength");if(sourceDeclaredTotal>LIMITS.totalBytes)fail("Source descriptor total exceeds limit.","STRUCTURAL_RELATION_OBSERVATION_LIMIT"); } if (document.subject.sourceManifestDigest !== sourceSubsetDigest(sources)) fail("sourceManifestDigest mismatch.", "STRUCTURAL_RELATION_ID_MISMATCH");
  if (!Array.isArray(document.rawRefs) || document.rawRefs.length < 1 || document.rawRefs.length > LIMITS.rawRefs) fail("rawRefs count invalid."); exactOrder(document.rawRefs, [...document.rawRefs].sort((a, b) => ascii(a.rawRefId, b.rawRefId)), "rawRefs"); const rawById = new Map(); let rawDeclaredTotal=0; for (const entry of document.rawRefs) { fields(entry, ["kind", "mediaType", "sha256", "byteLength", "rawRefId"], "rawRef"); const payload = { kind: text(entry.kind, 128, "raw kind"), mediaType: text(entry.mediaType, 128, "raw mediaType"), sha256: hex(entry.sha256, "raw digest"), byteLength: safe(entry.byteLength, LIMITS.itemBytes, "raw byteLength") };rawDeclaredTotal+=payload.byteLength;if(rawDeclaredTotal>LIMITS.totalBytes)fail("Raw descriptor total exceeds limit.","STRUCTURAL_RELATION_OBSERVATION_LIMIT"); if (entry.rawRefId !== id("structural-raw", payload)) fail("rawRefId mismatch.", "STRUCTURAL_RELATION_ID_MISMATCH"); rawById.set(entry.rawRefId, entry); } unique([...rawById.keys()], "rawRef IDs");
  if (!Array.isArray(document.producerClaims) || document.producerClaims.length < 1 || document.producerClaims.length > LIMITS.claims) fail("producerClaims count invalid."); exactOrder(document.producerClaims, [...document.producerClaims].sort((a, b) => ascii(a.producerClaimId, b.producerClaimId)), "producerClaims"); const claims = new Set(); for (const entry of document.producerClaims) { fields(entry, ["name", "version", "executableIdentity", "profileIdentity", "reportedTransport", "reportedMethod", "analysisMethodClaim", "producerIdentityEvidenceStatus", "producerClaimId"], "producerClaim"); fields(entry.analysisMethodClaim,["reportedValue","reportSource","truthStatus"],"producerClaim.analysisMethodClaim");text(entry.name,128,"producer name");text(entry.version,128,"producer version");text(entry.executableIdentity,128,"executableIdentity");text(entry.profileIdentity,128,"profileIdentity");text(entry.reportedTransport,128,"reportedTransport");text(entry.reportedMethod,128,"reportedMethod");text(entry.analysisMethodClaim.reportedValue,128,"reportedValue",true); const payload = { ...entry }; delete payload.producerClaimId; if (entry.analysisMethodClaim.truthStatus !== "unknown" || !CLAIM_SOURCES.has(entry.analysisMethodClaim.reportSource) || !EVIDENCE_STATUS.has(entry.producerIdentityEvidenceStatus)) fail("Producer claim has unsupported truth semantics.", "UNSUPPORTED_STRUCTURAL_RELATION_TRUTH_STATUS"); if((entry.analysisMethodClaim.reportSource==="absent")!==(entry.analysisMethodClaim.reportedValue===null))fail("Absent analysis claim mismatch."); if (entry.producerClaimId !== id("structural-producer", payload)) fail("producerClaimId mismatch.", "STRUCTURAL_RELATION_ID_MISMATCH"); claims.add(entry.producerClaimId); } unique([...claims], "producerClaim IDs");
  const sourcesByPath = new Map(sources.map((entry) => [entry.path, entry]));
  const sourceTexts = sourceBytesByPath === undefined ? null : (mapExact(sourceBytesByPath, sources, "sourceBytesByPath"), new Map(sources.map((entry) => [entry.path, sourceText(sourceBytesByPath.get(entry.path), entry.path)])));
  if (rawBytesById !== undefined) mapExact(rawBytesById, document.rawRefs, "rawBytesById");
  boundedArray(document.runs, 1, LIMITS.runs, "runs"); exactOrder(document.runs, [...document.runs].sort((a, b) => ascii(a.runId, b.runId)), "runs"); const runById = new Map(); const usedClaims = new Set(); for (const run of document.runs) { fields(run, ["producerClaimId", "inputBinding", "coverage", "rawRefIds", "runId"], "run"); fields(run.inputBinding, ["sourceManifestScope", "sourceManifestDigest", "configDigest", "profileDigest", "normalizerVersion", "normalizerImplementationDigest"], "run.inputBinding"); fields(run.coverage, ["admittedSources", "queriedDirection", "queriedSymbols", "reportedResponseClosure", "programCoverage", "repositoryRelationCompleteness"], "run.coverage"); if (!claims.has(run.producerClaimId)) fail("Run claim closure mismatch.", "STRUCTURAL_RELATION_CLOSURE_MISMATCH"); usedClaims.add(run.producerClaimId); boundedArray(run.rawRefIds, 1, LIMITS.rawRefs, "run rawRefIds"); exactOrder(run.rawRefIds, [...run.rawRefIds].sort(ascii), "run rawRefIds"); unique(run.rawRefIds, "run rawRefIds"); for (const rawId of run.rawRefIds) if (!rawById.has(rawId)) fail("Run raw closure mismatch.", "STRUCTURAL_RELATION_CLOSURE_MISMATCH"); const admitted = boundedArray(run.coverage.admittedSources, 1, LIMITS.sources, "run admittedSources"); exactOrder(admitted,[...admitted].sort((a,b)=>ascii(a.path,b.path)),"run admittedSources");unique(admitted.map((item)=>item.path),"run admittedSources"); for (const item of admitted){fields(item,["path","digest"],"run admittedSource");pathValue(item.path,"run admittedSource.path");hex(item.digest,"run admittedSource.digest");if (!sourcesByPath.has(item.path) || sourcesByPath.get(item.path).sha256 !== item.digest) fail("Run source closure mismatch.", "STRUCTURAL_RELATION_RUN_SOURCE_MISMATCH");} if(!new Set(["full","subset"]).has(run.inputBinding.sourceManifestScope)||(run.inputBinding.sourceManifestScope==="full"&&admitted.length!==sources.length))fail("Run scope mismatch.","STRUCTURAL_RELATION_RUN_SOURCE_MISMATCH");hex(run.inputBinding.sourceManifestDigest,"run sourceManifestDigest");hex(run.inputBinding.configDigest,"run configDigest");hex(run.inputBinding.profileDigest,"run profileDigest");text(run.inputBinding.normalizerVersion,128,"run normalizerVersion");hex(run.inputBinding.normalizerImplementationDigest,"run normalizerImplementationDigest");if(run.coverage.queriedDirection!=="outgoing"||run.coverage.programCoverage!=="unknown"||run.coverage.repositoryRelationCompleteness!=="not-claimed"||!RESPONSE_CLOSURE.has(run.coverage.reportedResponseClosure))fail("Run coverage unsupported.","UNSUPPORTED_STRUCTURAL_RELATION_COVERAGE");boundedArray(run.coverage.queriedSymbols,0,LIMITS.occurrences,"queriedSymbols");exactOrder(run.coverage.queriedSymbols,[...run.coverage.queriedSymbols].sort((a,b)=>ascii(canonicalJson(a),canonicalJson(b))),"queriedSymbols");for(const symbol of run.coverage.queriedSymbols){fields(symbol,["path","digest","name","symbolKind","line"],"queriedSymbol");pathValue(symbol.path,"queriedSymbol.path");hex(symbol.digest,"queriedSymbol.digest");text(symbol.name,256,"queriedSymbol.name");text(symbol.symbolKind,128,"queriedSymbol.symbolKind");safe(symbol.line,LIMITS.coordinate,"queriedSymbol.line");if(!admitted.some((item)=>item.path===symbol.path&&item.digest===symbol.digest))fail("queriedSymbol outside run scope.","STRUCTURAL_RELATION_RUN_SOURCE_MISMATCH");} const digest = sourceSubsetDigest(admitted.map((item) => sourcesByPath.get(item.path))); if (run.inputBinding.sourceManifestDigest !== digest) fail("Run manifest digest mismatch.", "STRUCTURAL_RELATION_ID_MISMATCH"); const payload = { producerClaimId: run.producerClaimId, inputBinding: run.inputBinding, coverage: run.coverage, rawRefIds: run.rawRefIds }; if (run.runId !== id("structural-run", payload)) fail("runId mismatch.", "STRUCTURAL_RELATION_ID_MISMATCH"); runById.set(run.runId, run); }
  unique([...runById.keys()], "run IDs");
  observationPairs(document.pairs, "pairs"); exactOrder(document.pairs, [...document.pairs].sort((a, b) => ascii(a.pairId, b.pairId)), "pairs"); const projection = []; const seenOccurrences = new Set(); const seenSupports = new Set(); const usedRuns = new Set(); const usedRaw = new Set(); let occurrenceCount = 0; let supportCount = 0; for (const pair of document.pairs) { fields(pair, ["type", "from", "to", "language", "pairId", "occurrences"], "pair"); if (pair.type !== "CALLS") fail("Only CALLS supported.", "UNSUPPORTED_STRUCTURAL_RELATION_OBSERVATION_SHAPE"); text(pair.language, 128, "pair.language"); for (const [label, value] of [["pair.from", pair.from], ["pair.to", pair.to]]) { fields(value, ["path", "digest", "name", "symbolKind", "declarationRange", "selectionRange"], label); const bound = sourcesByPath.get(pathValue(value.path, `${label}.path`)); if (!bound || bound.sha256 !== value.digest) fail(`${label} source mismatch.`, "STRUCTURAL_RELATION_SOURCE_MISMATCH"); hex(value.digest, `${label}.digest`); text(value.name, 256, `${label}.name`); text(value.symbolKind, 128, `${label}.symbolKind`); structuralRange(value.declarationRange, `${label}.declarationRange`); structuralRange(value.selectionRange, `${label}.selectionRange`); if (!contains(value.declarationRange, value.selectionRange)) fail(`${label} selectionRange is outside declarationRange.`, "STRUCTURAL_RELATION_COORDINATE_MISMATCH"); } const pairPayload = { type: pair.type, from: pair.from, to: pair.to, language: pair.language }; if (pair.pairId !== id("structural-pair", pairPayload)) fail("pairId mismatch.", "STRUCTURAL_RELATION_ID_MISMATCH"); if (sourceTexts) { endpoint(pair.from, "pair.from", sourcesByPath, sourceTexts); endpoint(pair.to, "pair.to", sourcesByPath, sourceTexts); } boundedArray(pair.occurrences, 1, LIMITS.occurrences, "occurrences"); exactOrder(pair.occurrences, [...pair.occurrences].sort((a, b) => ascii(a.occurrenceId, b.occurrenceId)), "occurrences"); const occurrenceIds = []; for (const occurrence of pair.occurrences) { occurrenceCount += 1; if (occurrenceCount > LIMITS.occurrences) fail("Occurrence limit exceeded.", "STRUCTURAL_RELATION_OBSERVATION_LIMIT"); fields(occurrence, ["pairId", "evidence", "occurrenceId", "supports"], "occurrence"); fields(occurrence.evidence, ["path", "digest", "range"], "occurrence.evidence"); const occurrenceSource = sourcesByPath.get(pathValue(occurrence.evidence.path, "occurrence.evidence.path")); if (!occurrenceSource || occurrenceSource.sha256 !== occurrence.evidence.digest) fail("Occurrence source mismatch.", "STRUCTURAL_RELATION_SOURCE_MISMATCH"); if (occurrenceSource.path !== pair.from.path || occurrenceSource.sha256 !== pair.from.digest) fail("Occurrence must bind to the caller source in v0.", "STRUCTURAL_RELATION_SOURCE_MISMATCH"); hex(occurrence.evidence.digest, "occurrence.evidence.digest"); structuralRange(occurrence.evidence.range, "occurrence.evidence.range"); if (!contains(pair.from.declarationRange, occurrence.evidence.range)) fail("Occurrence is outside caller declaration.", "STRUCTURAL_RELATION_COORDINATE_MISMATCH"); if (occurrence.pairId !== pair.pairId) fail("Occurrence pair closure mismatch.", "STRUCTURAL_RELATION_CLOSURE_MISMATCH"); const payload = { pairId: pair.pairId, evidence: occurrence.evidence }; if (occurrence.occurrenceId !== id("structural-occurrence", payload)) fail("occurrenceId mismatch.", "STRUCTURAL_RELATION_ID_MISMATCH"); if (seenOccurrences.has(occurrence.occurrenceId)) fail("Duplicate occurrence.", "DUPLICATE_STRUCTURAL_RELATION_OBSERVATION_ID"); seenOccurrences.add(occurrence.occurrenceId); occurrenceIds.push(occurrence.occurrenceId); if (sourceTexts) { const r = range(sourceTexts.get(occurrenceSource.path).lines, occurrence.evidence.range, "occurrence range"); if (sliceRange(sourceTexts.get(occurrenceSource.path).lines, r) !== pair.to.name) fail("Name-different call occurrences are unsupported in v0.", "UNSUPPORTED_STRUCTURAL_RELATION_OBSERVATION_SHAPE"); } boundedArray(occurrence.supports, 1, LIMITS.supports, "supports"); exactOrder(occurrence.supports, [...occurrence.supports].sort((a, b) => ascii(a.supportId, b.supportId)), "supports"); for (const support of occurrence.supports) { supportCount += 1; if (supportCount > LIMITS.supports) fail("Support limit exceeded.", "STRUCTURAL_RELATION_OBSERVATION_LIMIT"); fields(support, ["occurrenceId", "runId", "rawRefId", "supportId"], "support"); const supportPayload = { occurrenceId: occurrence.occurrenceId, runId: support.runId, rawRefId: support.rawRefId }; if (support.occurrenceId !== occurrence.occurrenceId || support.supportId !== id("structural-support", supportPayload) || !runById.has(support.runId) || !rawById.has(support.rawRefId) || !runById.get(support.runId).rawRefIds.includes(support.rawRefId)) fail("Support closure mismatch.", "STRUCTURAL_RELATION_CLOSURE_MISMATCH"); if (seenSupports.has(support.supportId)) fail("Duplicate support.", "DUPLICATE_STRUCTURAL_RELATION_OBSERVATION_ID"); seenSupports.add(support.supportId); usedRuns.add(support.runId); usedRaw.add(support.rawRefId); } } projection.push({ pairId: pair.pairId, occurrenceIds: occurrenceIds.sort(ascii) }); }
  for(const pair of document.pairs)for(const occurrence of pair.occurrences)for(const support of occurrence.supports){const run=runById.get(support.runId);for(const bound of [pair.from,pair.to,occurrence.evidence])if(!run.coverage.admittedSources.some((item)=>item.path===bound.path&&item.digest===bound.digest))fail("Support uses source outside run admittedSources.","STRUCTURAL_RELATION_RUN_SOURCE_MISMATCH");}
  if (usedRuns.size !== document.runs.length || usedRaw.size !== document.rawRefs.length || usedClaims.size !== document.producerClaims.length) fail("Orphan producer claim/run/raw closure mismatch.", "STRUCTURAL_RELATION_CLOSURE_MISMATCH"); fields(document.candidateProjection,["status","policy","occurrenceDisposition","repositoryCompleteness","entries","projectionDigest"],"candidateProjection"); boundedArray(document.candidateProjection.entries, 1, LIMITS.pairs, "candidateProjection.entries"); for (const entry of document.candidateProjection.entries) { fields(entry, ["pairId", "occurrenceIds"], "candidateProjection.entry"); text(entry.pairId, 128, "candidateProjection.entry.pairId"); boundedArray(entry.occurrenceIds, 1, LIMITS.occurrences, "candidateProjection.entry.occurrenceIds"); unique(entry.occurrenceIds, "candidateProjection occurrenceIds"); exactOrder(entry.occurrenceIds, [...entry.occurrenceIds].sort(ascii), "candidateProjection occurrenceIds"); } exactOrder(document.candidateProjection.entries, projection.sort((a, b) => ascii(a.pairId, b.pairId)), "projection entries"); if (document.candidateProjection.status !== "candidate-only" || document.candidateProjection.policy !== "relation-pair-only-v0" || document.candidateProjection.occurrenceDisposition !== "preserved-in-envelope-not-in-pair" || document.candidateProjection.repositoryCompleteness !== "not-claimed" || document.candidateProjection.projectionDigest !== H({ policy: "relation-pair-only-v0", entries: document.candidateProjection.entries })) fail("Candidate projection is invalid.", "STRUCTURAL_RELATION_PROJECTION_MISMATCH"); if(!Array.isArray(document.diagnosticLabels)||document.diagnosticLabels.some((value)=>typeof value!=="string"||!value||value.length>512))fail("diagnosticLabels invalid.");exactOrder(document.diagnosticLabels,[...document.diagnosticLabels].sort(ascii),"diagnosticLabels");
  const payload = { ...document }; delete payload.envelopeId; delete payload.envelopeHash; const envelopeHash = H(payload); if (document.envelopeHash !== envelopeHash || document.envelopeId !== `structural-envelope-${envelopeHash.slice(0, 24)}`) fail("Envelope identity mismatch.", "STRUCTURAL_RELATION_ID_MISMATCH");
  const structuralContractVerification = "passed"; const sourceByteIntegrity = sourceBytesByPath === undefined ? "not-run" : "passed"; const sourceCoordinateValidation = sourceBytesByPath === undefined ? "not-run" : "passed"; const rawByteIntegrity = rawBytesById === undefined ? "not-run" : "passed"; return { envelope: document, verificationReport: { structuralContractVerification, sourceByteIntegrity, sourceCoordinateValidation, rawByteIntegrity, claimTruthVerification: "not-supported", rawSemanticSupportVerification: "not-evaluated", responseCompletenessVerification: "not-evaluated", finalStrongVerification: [structuralContractVerification, sourceByteIntegrity, sourceCoordinateValidation, rawByteIntegrity].every((value) => value === "passed") } };
}

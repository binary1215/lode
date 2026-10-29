import { withSnapshotReferences } from "./snapshot-reference-lifetime.mjs";
import { formatForVerifiedOwner, familyFormatForOriginal, relativeProjectArtifact } from "./project-storage-format.mjs";
import fs from "node:fs";
import path from "node:path";
import { createObservationTypeDescriptor, createObservationRecord, verifyObservationRecord, observationDigest } from "./observation-contract.mjs";
import { recordCollectedObservation } from "./observation-store.mjs";
import { artifactAuthorityBoundary, verifyArtifactAuthorityBoundary } from "./authority-plane-contract.mjs";
import { sourceDigest, sourceObjectDigest, readSourceBytes, sourceCurrent, sourceError, preparePythonObservation, preparePythonDeclarations } from "./python-source-collector.mjs";
import { noteProjectGraphChange } from "./discovery-index.mjs";


export const SOURCE_OBSERVATION_TYPE = "source.structural-context";
const adapterDescriptor = Object.freeze({ adapterKey: "python-stdlib-ast", adapterVersion: "1" });
const observationDataErrors = new Set(["INVALID_OBSERVATION_ARTIFACT", "INVALID_OBSERVATION_COVERAGE", "INVALID_OBSERVATION_DESCRIPTOR", "INVALID_OBSERVATION_INPUT", "INVALID_OBSERVATION_PAYLOAD", "INVALID_OBSERVATION_RECORD", "OBSERVATION_CONTRACT_ERROR", "OBSERVATION_DIGEST_MISMATCH", "UNPROVEN_COMPLETE_OBSERVATION_COVERAGE",
  "UNKNOWN_OBSERVATION_DESCRIPTOR", "INVALID_DERIVED_OBSERVATION", "DERIVED_OBSERVATION_INPUT_MISMATCH", "INVALID_OBSERVATION_RECEIPT", "INVALID_OBSERVATION_RECEIPT_LINEAGE", "OBSERVATION_RECEIPT_MISSING", "DUPLICATE_OBSERVATION_DESCRIPTOR", "DUPLICATE_OBSERVATION_RECORD", "DUPLICATE_OBSERVATION_RECEIPT", "DIVERGENT_OBSERVATION_REPLAY"]);
export function classifySourceStorageError(error) {
  if (observationDataErrors.has(error.code) || ["SOURCE_BUNDLE_JSON_INVALID", "SOURCE_OBSERVATION_INVALID", "SOURCE_RESPONSE_INVALID", "SOURCE_STORAGE_CONFLICT", "OBSERVATION_IMMUTABLE_COLLISION"].includes(error.code)) return "invalid";
  if (["ENOENT", "EACCES", "EPERM", "ENOTDIR", "EISDIR", "ENOSPC", "EROFS", "SOURCE_DRIFT", "SOURCE_BYTE_LIMIT", "SOURCE_STORAGE_UNSAFE", "SOURCE_SYMLINK_UNSUPPORTED", "SOURCE_NOT_REGULAR_FILE", "OBSERVATION_STORE_LIMIT", "OBSERVATION_SYMLINK_PATH", "OBSERVATION_PATH_ESCAPE"].includes(error.code)) return "unavailable";
  return null;
}
function parseStoredJson(bytes) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch (error) {
    if (error instanceof SyntaxError || error.code === "ERR_ENCODING_INVALID_ENCODED_DATA") throw sourceError("SOURCE_BUNDLE_JSON_INVALID");
    throw error;
  }
}
const recordShape = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export const sourceObservationDescriptor = createObservationTypeDescriptor({
  typeKey: SOURCE_OBSERVATION_TYPE, typeVersion: "1", forms: ["snapshot"],
  payloadSchema: { additionalFields: false, fields: [
    { key: "bundleKey", type: "sha256", required: true },
    { key: "evidenceKind", type: "enum", enum: ["source", "outgoing-calls"], required: true },
    { key: "path", type: "string", max: 512, required: true },
    { key: "symbol", type: "string", max: 512, required: true },
    { key: "details", type: "string", max: 65536, required: true },
    { key: "sourceDigest", type: "sha256", required: true },
    { key: "unresolvedCount", type: "nonnegative-integer", required: true },
    { key: "omittedSourceBytes", type: "nonnegative-integer", required: true },
  ] },
});

export const DECLARATION_OBSERVATION_TYPE = "source.python-declaration-context";
export const declarationObservationDescriptor = createObservationTypeDescriptor({
  typeKey: DECLARATION_OBSERVATION_TYPE, typeVersion: "1", forms: ["snapshot"],
  payloadSchema: { additionalFields: false, fields: sourceObservationDescriptor.payloadSchema.fields.map((field) =>
    field.key === "evidenceKind" ? { ...field, enum: ["declarations", "selected-source"] } : field) },
});
// Explicit dispatch: historical v1 records retain their descriptor and meaning.
const formats = Object.freeze({
  "1:source": sourceObservationDescriptor, "1:outgoing-calls": sourceObservationDescriptor,
  "2:declarations": declarationObservationDescriptor, "2:selected-source": declarationObservationDescriptor,
});
function descriptorFor(evidence, storage) {
  if (![1, 2].includes(evidence.version)) throw sourceError("SOURCE_OBSERVATION_INVALID");
  const descriptor = formats[`${evidence.version}:${evidence.kind}`];
  if (!descriptor) throw sourceError("SOURCE_OBSERVATION_INVALID");
  if (formatForVerifiedOwner(storage).dialect === "head") return descriptor;
  const { typeKey, typeVersion, forms, payloadSchema } = descriptor;
  return createObservationTypeDescriptor({ typeKey, typeVersion, forms, payloadSchema }, storage);
}
function declarationResult(evidence) {
  try {
    return preparePythonDeclarations({ query: evidence.query, sources: evidence.sources, profile: evidence.profile,
      response: { result: parseStoredJson(Buffer.from(evidence.response, "base64")) } });
  } catch (error) {
    if (error.code === "SOURCE_NEEDS_INVALID") throw sourceError("SOURCE_OBSERVATION_INVALID");
    throw error;
  }
}

export function sourceBundleKey(evidence) { return sourceObjectDigest(evidence); }

function observationInput(evidence) {
  const file = evidence.sources[0];
  const rawText = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(file.base64, "base64"));
  // End at an actual Unicode boundary, never manufacture a replacement glyph.
  let sourceExcerpt = rawText.slice(0, 60_000);
  while (Buffer.byteLength(sourceExcerpt) > 60_000 || /[\uD800-\uDBFF]$/u.test(sourceExcerpt)) sourceExcerpt = sourceExcerpt.slice(0, -1);
  const result = evidence.response ? JSON.parse(Buffer.from(evidence.response, "base64").toString("utf8")) : null;
  const details = evidence.version === 2 ? JSON.stringify(declarationResult(evidence).details) : evidence.kind === "outgoing-calls" ? JSON.stringify({
    claimTruth: "unknown", repositoryCompleteness: "not-claimed", profile: evidence.profile.runtime,
    pairs: result.results[0].pairs, unresolved: result.results[0].unresolved,
  }) : sourceExcerpt;
  const queryDigest = sourceObjectDigest(evidence.query);
  const sourceScopeDigest = sourceObjectDigest({ projectId: evidence.projectId, query: evidence.query, sources: evidence.sources.map(({ path, digest }) => ({ path, digest })), profile: evidence.profile });
  const bundleKey = sourceBundleKey(evidence);
  return { sourceScopeDigest, input: {
    subject: { type: "source-scope", key: `scope-${sourceScopeDigest.slice(0, 24)}` }, form: "snapshot",
    temporalScope: { observedAt: evidence.observedAt, start: null, end: null },
    coverage: { state: "partial", basis: "bounded-source-syntax-observation", queryDigest,
      examinedCount: evidence.kind === "outgoing-calls" ? result.results[0].pairs.length : 1, sourceReportedTotal: null, omittedCount: null, cursorStartDigest: null, cursorEndDigest: null },
    sourceEventKeyDigest: bundleKey, sourceEvidenceDigest: bundleKey,
    payload: { bundleKey, evidenceKind: evidence.kind, path: file.path, symbol: evidence.query[0].symbol ?? "",
      details, sourceDigest: file.digest, unresolvedCount: result?.results?.[0]?.unresolved?.length ?? 0,
      omittedSourceBytes: evidence.kind === "source" ? Math.max(0, Buffer.byteLength(rawText) - Buffer.byteLength(sourceExcerpt)) : 0 },
  } };
}

export function createSourceObservation(evidence, storage = null) {
  const descriptor = descriptorFor(evidence, storage);
  const { sourceScopeDigest, input } = observationInput(evidence);
  const observation = createObservationRecord({ projectId: evidence.projectId, descriptor,
    ...input, source: { ...adapterDescriptor, sourceScopeDigest, sourceEventKeyDigest: input.sourceEventKeyDigest, sourceEvidenceDigest: input.sourceEvidenceDigest } }, storage);
  return { evidence, descriptor, observation };
}

// This verifies both content and current source bytes for persisted AND ephemeral
// Context consumption. A hash alone is never treated as currentness or truth.
export function verifySourceObservation(root, projectId, bundle, { requireCurrent = true, storage } = {}) {
  if (!recordShape(bundle) || !recordShape(bundle.evidence) || !recordShape(bundle.descriptor) || !recordShape(bundle.observation)) throw sourceError("SOURCE_OBSERVATION_INVALID");
  const { evidence, descriptor, observation } = bundle;
  const format = familyFormatForOriginal("head-agent-core-observation", observation, storage);
  if (!format) throw sourceError("SOURCE_OBSERVATION_INVALID");
  if (descriptor.descriptorId !== descriptorFor(evidence, format).descriptorId || evidence.projectId !== projectId
    || !Array.isArray(evidence.sources) || evidence.sources.length !== 1 || !Array.isArray(evidence.query) || evidence.query.length !== 1
    || !recordShape(evidence.profile) || !recordShape(evidence.query[0]) || typeof evidence.query[0].path !== "string"
    || typeof evidence.query[0].symbol !== "string") throw sourceError("SOURCE_OBSERVATION_INVALID");
  verifyObservationRecord(observation, descriptor, projectId, format);
  for (const source of evidence.sources) {
    if (!recordShape(source) || typeof source.path !== "string" || typeof source.base64 !== "string" || !/^[a-f0-9]{64}$/.test(source.digest ?? "")) throw sourceError("SOURCE_OBSERVATION_INVALID");
    if (sourceDigest(Buffer.from(source.base64, "base64")) !== source.digest || source.path !== evidence.query[0].path) throw sourceError("SOURCE_OBSERVATION_INVALID");
    try { new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(source.base64, "base64")); }
    catch (error) { if (error.code === "ERR_ENCODING_INVALID_ENCODED_DATA") throw sourceError("SOURCE_OBSERVATION_INVALID"); throw error; }
  }
  if (evidence.kind === "outgoing-calls") {
    if (typeof evidence.response !== "string" || !recordShape(evidence.profile.runtime) || !recordShape(evidence.profile.implementation)) throw sourceError("SOURCE_OBSERVATION_INVALID");
    const raw = Buffer.from(evidence.response, "base64");
    const result = parseStoredJson(raw);
    const prepared = preparePythonObservation({ projectId, query: evidence.query, sources: evidence.sources, response: { raw, result }, profile: evidence.profile });
    if (prepared.status !== "ready" || prepared.envelope.envelopeHash !== evidence.envelopeHash) throw sourceError("SOURCE_OBSERVATION_INVALID");
  }
  if (evidence.version === 2) {
    if (typeof evidence.response !== "string" || !recordShape(evidence.profile.runtime) || !recordShape(evidence.profile.implementation)) throw sourceError("SOURCE_OBSERVATION_INVALID");
    const prepared = declarationResult(evidence);
    if (prepared.status !== "ready" || prepared.evidenceHash !== evidence.envelopeHash) throw sourceError("SOURCE_OBSERVATION_INVALID");
  }
  const expected = createSourceObservation(evidence, format);
  if (expected.observation.observationHash !== observation.observationHash) throw sourceError("SOURCE_OBSERVATION_INVALID");
  if (requireCurrent && !sourceCurrent(root, evidence.sources)) throw sourceError("SOURCE_DRIFT");
  return observation;
}

function directory(root, storage) {
  let current = fs.realpathSync(root);
  for (const segment of relativeProjectArtifact(storage, "observations", "source-bundles").split("/")) {
    current = path.join(current, segment);
    try { fs.mkdirSync(current); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw sourceError("SOURCE_STORAGE_UNSAFE");
  }
  return current;
}

function retainSourceObservationUncoordinated(root, bundle, storage = null) {
  storage = formatForVerifiedOwner(storage);
  verifySourceObservation(root, bundle.evidence.projectId, bundle, { storage });
  const key = sourceBundleKey(bundle.evidence);
  retainBundle(root, key, bundle, storage);
  const { sourceScopeDigest, input } = observationInput(bundle.evidence);
  recordCollectedObservation({ root, descriptor: bundle.descriptor, input, adapterDescriptor, sourceScopeDigest });
  noteProjectGraphChange(root, [`${relativeProjectArtifact(storage, "observations", "source-bundles")}/${key}.json`]);
  return key;
}

function retainBundle(root, key, bundle, storage) {
  const dir = directory(root, storage);
  const encoded = Buffer.from(JSON.stringify(bundle));
  if (encoded.length > 16 * 1024 * 1024) throw sourceError("SOURCE_BYTE_LIMIT");
  const destination = path.join(dir, `${key}.json`);
  const temporary = path.join(dir, `.pending-${process.pid}-${cryptoRandom()}`);
  try {
    fs.writeFileSync(temporary, encoded, { flag: "wx" });
    try { fs.linkSync(temporary, destination); }
    catch (error) { if (error.code !== "EEXIST") throw error;
      if (!readSourceBytes(root, `${relativeProjectArtifact(storage, "observations", "source-bundles")}/${key}.json`, 16 * 1024 * 1024).equals(encoded)) throw sourceError("SOURCE_STORAGE_CONFLICT"); }
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function cryptoRandom() { return sourceDigest(`${process.hrtime.bigint()}-${Math.random()}`).slice(0, 24); }

function readSourceObservationEntry(root, projectId, key, options, captureOriginal) {
  if (options === undefined) options = {};
  if (!/^[a-f0-9]{64}$/.test(key)) throw sourceError("SOURCE_BUNDLE_KEY_INVALID");
  const storage = formatForVerifiedOwner(options?.storage);
  const relativePath = `${relativeProjectArtifact(storage, "observations", "source-bundles")}/${key}.json`;
  const bytes = readSourceBytes(root, relativePath, 16 * 1024 * 1024);
  const bundle = parseStoredJson(bytes);
  if (!recordShape(bundle) || !recordShape(bundle.evidence)) throw sourceError("SOURCE_OBSERVATION_INVALID");
  if (sourceBundleKey(bundle.evidence) !== key) throw sourceError("SOURCE_OBSERVATION_INVALID");
  verifySourceObservation(root, projectId, bundle, options === null ? null : { ...options, storage });
  // Raw identity is derived from exactly the buffer parsed and verified above.
  return { bundle, ...(captureOriginal ? { original: { relativePath, byteLength: bytes.length, sha256: sourceDigest(bytes) } } : {}) };
}

export function readSourceObservation(root, projectId, key, options) {
  return readSourceObservationEntry(root, projectId, key, options, false).bundle;
}

// Internal preservation reader. No extra hash or public option on ordinary reads.
export function readSourceObservationOriginal(root, projectId, key, options) {
  return readSourceObservationEntry(root, projectId, key, options, true);
}

export function sourceObservationNode(root, projectId, bundle, storage = undefined) {
  const record = verifySourceObservation(root, projectId, bundle, { storage });
  return { ...record, nodeId: record.observationId, semanticAuthority: false, contextEligibility: "exact-evidence-need-only",
    observationProjectionId: `source-projection-${record.observationHash.slice(0, 24)}`, observationProjectionHash: observationDigest(record) };
}

function retainSourceFailureUncoordinated(root, input, storage = null) {
  const failure = { kind: "SourceCollectionFailure", version: 1, ...input,
    authority: "P3-failed-observation-evidence", authorityBoundary: artifactAuthorityBoundary("SourceCollectionFailure"),
    instructionAuthority: false, promotionAuthority: false, recoveryAuthority: false, mutatesCanon: false };
  const key = sourceObjectDigest(failure);
  // Identical source/profile/query/outcome coalesces; polling does not create
  // one artifact per attempt. This is not an execution or retry authorization.
  retainBundle(root, key, { failure }, storage);
  noteProjectGraphChange(root, [`${relativeProjectArtifact(storage, "observations", "source-bundles")}/${key}.json`]);
  return key;
}

export function readSourceFailure(root, projectId, key, storage = undefined) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw sourceError("SOURCE_BUNDLE_KEY_INVALID");
  const parsed = parseStoredJson(readSourceBytes(root, `${relativeProjectArtifact(storage, "observations", "source-bundles")}/${key}.json`, 16 * 1024 * 1024));
  if (!recordShape(parsed)) throw sourceError("SOURCE_OBSERVATION_INVALID");
  const { failure } = parsed;
  if (!failure || sourceObjectDigest(failure) !== key || failure.projectId !== projectId
    || failure.kind !== "SourceCollectionFailure" || failure.instructionAuthority !== false
    || failure.promotionAuthority !== false || failure.recoveryAuthority !== false) throw sourceError("SOURCE_OBSERVATION_INVALID");
  verifyArtifactAuthorityBoundary("SourceCollectionFailure", failure.authorityBoundary);
  let sourceState = "not-observed";
  if (failure.sources?.length) {
    try { sourceState = sourceCurrent(root, failure.sources) ? "current-source-bytes" : "stale"; }
    catch { sourceState = "unavailable"; }
  }
  return { failure, sourceState, authority: "historical-failure-evidence-only; never-retry-or-recovery-authority" };
}

export function retainSourceObservation(root, input, storage = null) {
  return withSnapshotReferences({ root, storage }, () => retainSourceObservationUncoordinated(root, input, storage));
}

export function retainSourceFailure(root, input, storage = null) {
  return withSnapshotReferences({ root, storage }, () => retainSourceFailureUncoordinated(root, input, storage));
}

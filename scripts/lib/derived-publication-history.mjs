import { isDeepStrictEqual as equal } from "node:util";
import { derivedHash as hash, derivedJson as json, derivedFail as fail, CLAUDE_DERIVED_FORMAT } from "./claude-derived-encoder.mjs";
import { parseCodexSourceJson } from "./codex-source-json.mjs";
import { physicalDerivationAlternatives } from "./project-native-derivation.mjs";
import { claudeNativeProjectName } from "./claude-native-history.mjs";

const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
const object = value => value && typeof value === "object" && !Array.isArray(value);
const fields = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const rootIdentity = value => fields(value, ["path", "dev", "ino"]) && typeof value.path === "string" && value.path.length > 0
  && !/[\u0000-\u001f]/u.test(value.path) && /^(?:[A-Za-z]:[\\/]|\/|\\\\)/u.test(value.path)
  && [value.dev, value.ino].every(part => typeof part === "string" && /^[0-9]+$/u.test(part));

function original(evidence, role) {
  if (evidence === null || evidence === undefined) return null;
  if (!Buffer.isBuffer(evidence.raw) || !digest(evidence.sha256) || !Number.isSafeInteger(evidence.bytes) || evidence.bytes < 0)
    fail("DERIVED_HISTORY_ORIGINAL_EVIDENCE_INVALID", { role });
  if (evidence.raw.length !== evidence.bytes || hash(evidence.raw) !== evidence.sha256)
    fail("DERIVED_HISTORY_ORIGINAL_DIGEST_MISMATCH", { role });
  let document = null, parsingFailure = null;
  try { document = parseCodexSourceJson(new TextDecoder("utf-8", { fatal: true }).decode(evidence.raw)); }
  catch (error) { parsingFailure = error.code || error.name; }
  return { ...evidence, document, parsingFailure };
}

// Pure evidence classification. No file access, current-root resolution,
// journal, lease, retry decision or authority is supplied by this function.
// Missing format/correlation evidence is opaque; changed original bytes are a
// primary integrity failure, never an apparently empty operational history.
export function classifyDerivedPublicationHistory({ record, manifest = null, intent = null, sourceDigest, threadId, relativePath }) {
  if (!digest(sourceDigest) || !uuid(threadId)) fail("DERIVED_HISTORY_SOURCE_SCOPE_INVALID");
  const r = original(record, "record"), m = original(manifest, "manifest"), i = original(intent, "intent");
  if (!r) fail("DERIVED_HISTORY_RECORD_REQUIRED");
  const opaque = reason => ({ sha256: r.sha256, bytes: r.bytes, nativeId: null,
    classificationProfile: "derived-publication-history-v1", interpretation: "opaque-operational-history-not-authority", reason,
    ...(r.parsingFailure ? { parsingFailure: r.parsingFailure } : {}) });
  const d = r.document, md = m?.document, it = i?.document;
  const address = /^native\/derived\/claude\/(derived-claude-[a-f0-9]{24})\/effects\/([a-f0-9]{24})\/(publication-attempt\.json|publication-receipt\.json)$/u.exec(relativePath ?? "");
  if (!address || !md || !it || !d) return opaque("missing-or-unparsed-original-correlation-evidence");
  const requiredManifest = ["schemaVersion", "kind", "authorityPlane", "derivationId", "inputDigest", "input", "source", "intentDigest", "target", "files", "publicationReady", "openSafety", "synthesizedMetadata", "originalCompanionUnchanged", "sourceOriginalsLocation", "logicalSessionOwnership", "historicalToolsExecuted", "transfersNativeBinding", "grantsRecoveryAuthority", "restoresExecutionPermission", "targetExecutionSettingsVerified"];
  if (!fields(md, requiredManifest, ["displayMetadata"]) || md.schemaVersion !== 1 || md.kind !== "CodexToClaudeDerivedHistory" || md.authorityPlane !== "P3"
    || md.publicationReady !== true || md.originalCompanionUnchanged !== true || md.historicalToolsExecuted !== false || md.transfersNativeBinding !== false
    || md.grantsRecoveryAuthority !== false || md.restoresExecutionPermission !== false || md.targetExecutionSettingsVerified !== false
    || !fields(it, ["schemaVersion", "kind", "authorityPlane", "inputDigest", "input", "targetNativeId", "createdAt", "grantsRecoveryAuthority", "restoresExecutionPermission"])
    || it.schemaVersion !== 1 || it.kind !== "ClaudeDerivedHistoryIntent" || it.authorityPlane !== "P3"
    || it.grantsRecoveryAuthority !== false || it.restoresExecutionPermission !== false
    || typeof it.createdAt !== "string" || !Number.isFinite(Date.parse(it.createdAt))) return opaque("unqualified-historical-manifest-or-intent");
  const input = md.input;
  if (!fields(input, ["source", "selection", "converter", "targetFormat", "targetRoot"])
    || !fields(input.source, ["kind", "nativePayloadId", "nativePayloadDigest", "nativeProjectId", "provider"])
    || input.source.kind !== "captured-physical" || input.source.provider !== "codex" || input.source.nativePayloadDigest !== sourceDigest
    || input.source.nativePayloadId !== "physical-history-" + sourceDigest.slice(0, 24)
    || input.source.nativeProjectId !== null && typeof input.source.nativeProjectId !== "string"
    || !fields(input.selection, ["threadId", "cutoffItemId"]) || input.selection.threadId !== threadId
    || input.selection.cutoffItemId !== null && (typeof input.selection.cutoffItemId !== "string" || !input.selection.cutoffItemId)
    || !rootIdentity(input.targetRoot) || input.targetFormat !== CLAUDE_DERIVED_FORMAT.id
    || !equal(md.source, input.source) || !equal(it.input, input)) return opaque("historical-source-or-selection-binding-unqualified");
  const inputDigest = hash(json(input));
  if (md.inputDigest !== inputDigest || it.inputDigest !== inputDigest || md.derivationId !== "derived-claude-" + inputDigest.slice(0, 24)
    || md.derivationId !== address[1] || md.intentDigest !== i.sha256) return opaque("historical-input-or-original-digest-binding-mismatch");
  const alternative = physicalDerivationAlternatives(input).find(row => row.converter === input.converter);
  if (!alternative || !fields(md.target, ["provider", "nativeId", "cwd", "format", "cliVersion", "sdkVersion"])
    || md.target.provider !== "claude" || md.target.nativeId !== alternative.nativeId || it.targetNativeId !== alternative.nativeId
    || md.target.cwd !== input.targetRoot.path || md.target.format !== input.targetFormat
    || md.target.cliVersion !== CLAUDE_DERIVED_FORMAT.cliVersion || md.target.sdkVersion !== CLAUDE_DERIVED_FORMAT.sdkVersion)
    return opaque("historical-profile-or-target-binding-unqualified");
  const attempt = address[3] === "publication-attempt.json";
  const top = ["schemaVersion", "kind", "authorityPlane", "operation", "grantsRecoveryAuthority", "restoresExecutionPermission"];
  if (!fields(d, [...top, ...(attempt ? ["automaticReplayAllowed"] : ["targetObservation", "filesWritten", "sourceOriginalsPreserved", "sharedMetadataWritten"])])
    || d.schemaVersion !== 1 || d.kind !== (attempt ? "ClaudeDerivedPublicationAttempt" : "ClaudeDerivedPublicationReceipt")
    || d.authorityPlane !== "P5" || d.grantsRecoveryAuthority !== false || d.restoresExecutionPermission !== false
    || attempt && d.automaticReplayAllowed !== false
    || !attempt && (d.filesWritten !== 1 || d.sourceOriginalsPreserved !== true || d.sharedMetadataWritten !== false || !object(d.targetObservation)))
    return opaque("unqualified-historical-operational-envelope");
  const op = d.operation;
  if (!fields(op, ["derivationDigest", "targetNativeId", "home", "project", "relative", "client"])
    || op.derivationDigest !== m.sha256 || op.targetNativeId !== md.target.nativeId || !rootIdentity(op.home) || !equal(op.project, input.targetRoot)
    || !fields(op.client, ["version", "executableDigest"], ["hostEvidence"]) || op.client.version !== md.target.cliVersion
    || op.client.executableDigest !== null && !digest(op.client.executableDigest)
    || Object.hasOwn(op.client, "hostEvidence") && typeof op.client.hostEvidence !== "string") return opaque("historical-operation-binding-mismatch");
  let expectedRelative;
  try { expectedRelative = "projects/" + claudeNativeProjectName(md.target.cwd) + "/" + md.target.nativeId + ".jsonl"; }
  catch { return opaque("unqualified-historical-project-path-profile"); }
  if (op.relative !== expectedRelative || hash(json({ derivationDigest: m.sha256, homePath: op.home.path, relative: op.relative })).slice(0, 24) !== address[2])
    return opaque("historical-operational-namespace-binding-mismatch");
  return { sha256: r.sha256, bytes: r.bytes, nativeId: md.target.nativeId,
    classificationProfile: "derived-publication-history-v1", interpretation: "qualified-historical-target-id-not-authority",
    historicalDerivationDigest: m.sha256, historicalConverter: input.converter };
}

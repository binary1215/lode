import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { atomicCreateArtifact } from "./artifact-storage.mjs";
import { copiedProjectFile, inspectCopiedProjectFile } from "./project-copy-evidence.mjs";
import { readProjectNativeTransfer, assertProjectNativeTransferCurrent } from "./project-native-transfer.mjs";
import { inspectCodexNativePayload } from "./codex-native-payload.mjs";
import { nativeCheck, nativeRoot, pinNativeRoot, nativeRaw, nativeOutcome } from "./provider-native-history-host.mjs";
import { readCodexDerivedEvents } from "./codex-derived-reader.mjs";
import { inspectCodexCapturedPhysicalSource, readCodexCapturedPhysicalEvents, CODEX_PHYSICAL_CONVERTER, CODEX_PHYSICAL_PRIOR_CONVERTER, CODEX_PHYSICAL_PROFILES } from "./codex-captured-physical-source.mjs";
import { CLAUDE_DERIVED_FORMAT, CODEX_COMPLETION_CONVERTER, encodeClaudeDerived, derivedHash as hash, derivedJson as json, derivedFail as fail } from "./claude-derived-encoder.mjs";
import { CODEX_HYBRID_CONVERTER, CODEX_HYBRID_PROFILES, readCodexHybridPhysical, encodeCodexHybrid } from "./codex-claude-hybrid.mjs";

const format = CLAUDE_DERIVED_FORMAT;
const sourceOrder = read => physicalProfiles.includes(read.converter)
  ? "selected physical prefix frame ordinals and explicit wire call/result order; computed raw semantic IR, not canonical DB rows"
  : "canonical item ordinals and explicit wire call/result order; not token-stream replay";
const physicalProfiles = [...CODEX_HYBRID_PROFILES, ...CODEX_PHYSICAL_PROFILES];
const readPhysical = args => CODEX_HYBRID_PROFILES.includes(args.converter) ? readCodexHybridPhysical(args) : readCodexCapturedPhysicalEvents(args);
const encodeRead = (read, args) => CODEX_HYBRID_PROFILES.includes(read.converter) ? encodeCodexHybrid({ read, ...args }) : encodeClaudeDerived({ events: read.events, diagnostics: read.diagnostics, displayMetadata: read.displayMetadata, ...args });
const mappingFor = (read, encoded) => ({ mappings: encoded.mappings, inventory: read.inventory, sourceSelection: read.sourceSelection,
  sourceOrder: sourceOrder(read), ...(encoded.hybridCoverage ? { hybridCoverage: encoded.hybridCoverage } : {}) });
const sourceBinding = selected => ["native-capture", "captured-physical"].includes(selected.sourceKind) ? {
  kind: selected.sourceKind, nativePayloadId: selected.native.payloadId, nativePayloadDigest: selected.native.payloadDigest,
  nativeProjectId: selected.native.payload.projectCatalog?.projectId ?? null, provider: "codex",
} : ({ bundleId: selected.bundleId, commonManifestDigest: selected.commonManifestDigest,
  nativePayloadId: selected.native.payloadId, nativePayloadDigest: selected.native.payloadDigest, originalLinkDigest: selected.linkDigest,
  projectId: selected.projectId, selectedSessionId: selected.selectedSessionId, provider: "codex" });
const derivationPath = id => {
  if (!/^derived-claude-[a-f0-9]{24}$/u.test(id || "")) fail("DERIVED_ID_INVALID");
  return "native/derived/claude/" + id;
};
function targetUuid(inputDigest) {
  const bytes = crypto.createHash("sha1").update(Buffer.from("0743ab47ab684b34a136ecf73eeff310", "hex")).update(inputDigest).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
  const h = bytes.toString("hex"); return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
}
export function physicalDerivationAlternatives(input) {
  if (input?.source?.kind !== "captured-physical" || !physicalProfiles.includes(input.converter)) return [];
  return physicalProfiles.map(converter => ({ converter, nativeId: targetUuid(hash(json({ ...input, converter }))) }));
}
function selectedSource({ bundleRoot, expectedBundleId, signal, assertCurrentAuthority }) {
  nativeCheck(signal, assertCurrentAuthority);
  const root = nativeRoot(bundleRoot), pinned = pinNativeRoot(root);
  const check = () => {
    nativeCheck(signal, assertCurrentAuthority); pinned.verify();
  };
  const header = JSON.parse(nativeRaw(root, "manifest.json", signal, check).raw.toString("utf8"));
  let selected;
  if (["CodexNativeHistoryPayload", "CodexCapturedPhysicalHistory"].includes(header?.kind)) {
    if (expectedBundleId !== null) fail("DERIVED_NATIVE_CAPTURE_IS_NOT_COMMON_BUNDLE");
    selected = header.kind === "CodexNativeHistoryPayload" ? { sourceKind: "native-capture", sourceProvider: "codex",
      native: inspectCodexNativePayload({ directory: root, signal }) } : { sourceKind: "captured-physical", sourceProvider: "codex",
      native: inspectCodexCapturedPhysicalSource({ directory: root, signal, assertCurrentAuthority: check }) };
  } else selected = readProjectNativeTransfer({ bundleRoot, expectedBundleId, signal });
  if (selected.sourceProvider !== "codex" || !selected.native) fail("DERIVED_CODEX_SOURCE_REQUIRED");
  const recheck = () => {
    check();
    if (!["native-capture", "captured-physical"].includes(selected.sourceKind))
      assertProjectNativeTransferCurrent({ bundleRoot: root, commonManifestDigest: selected.commonManifestDigest, linkDigest: selected.linkDigest, signal });
    if (inspectCopiedProjectFile(selected.native.directory, "manifest.json", { signal, assertCurrentAuthority: check }).sha256 !== selected.native.payloadDigest)
      fail("DERIVED_SOURCE_PAYLOAD_CHANGED");
    for (const file of selected.native.payload.files) {
      const current = inspectCopiedProjectFile(selected.native.directory, "objects/" + file.sha256 + ".bin", { signal, assertCurrentAuthority: check });
      if (current.sha256 !== file.sha256 || current.bytes !== file.bytes) fail("DERIVED_SOURCE_PAYLOAD_CHANGED");
    }
  };
  return { selected, root, check, recheck };
}
function descriptor(name, bytes) { return { file: name, bytes: bytes.length, sha256: hash(bytes) }; }
function verifyIntent(intent, input, inputDigest, nativeId) {
  const expected = { schemaVersion: 1, kind: "ClaudeDerivedHistoryIntent", authorityPlane: "P3", inputDigest, input,
    targetNativeId: nativeId, createdAt: intent?.createdAt, grantsRecoveryAuthority: false, restoresExecutionPermission: false };
  if (typeof intent?.createdAt !== "string" || !Number.isFinite(Date.parse(intent.createdAt)) || !isDeepStrictEqual(intent, expected))
    fail("DERIVED_INTENT_IDENTITY_MISMATCH");
}
function manifestFor({ derivationId, inputDigest, input, source, intent, encoded, bodies }) {
  return { schemaVersion: 1, kind: "CodexToClaudeDerivedHistory", authorityPlane: "P3", derivationId, inputDigest, input, source,
    intentDigest: hash(json(intent)), target: { provider: "claude", nativeId: intent.targetNativeId, cwd: input.targetRoot.path,
      format: format.id, cliVersion: format.cliVersion, sdkVersion: format.sdkVersion },
    files: Object.entries(bodies).map(([name, raw]) => descriptor(name, raw)), publicationReady: encoded.publicationReady, openSafety: encoded.openSafety,
    synthesizedMetadata: encoded.synthesizedMetadata, originalCompanionUnchanged: true,
    ...(encoded.displayMetadata ? { displayMetadata: encoded.displayMetadata } : {}),
    sourceOriginalsLocation: source.kind === "captured-physical" ? "verified captured selected physical prefixes; no live snapshot, canonical DB row or model-context equivalence is claimed"
      : source.kind === "native-capture" ? "original verified native capture; no common Project or logical Session is invented"
      : "original verified bundle and native companion; never rewritten",
    logicalSessionOwnership: "not-established-by-this-artifact", historicalToolsExecuted: false,
    transfersNativeBinding: false, grantsRecoveryAuthority: false, restoresExecutionPermission: false, targetExecutionSettingsVerified: false };
}
function createExact(root, relative, raw, check) {
  check(); const file = copiedProjectFile(root, relative);
  if (fs.existsSync(file)) {
    const actual = nativeRaw(root, relative, null, check);
    if (!actual.raw.equals(raw)) fail("DERIVED_ARTIFACT_CONFLICT", { relative });
    return false;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true }); copiedProjectFile(root, relative); check();
  try { atomicCreateArtifact(file, raw); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  if (!nativeRaw(root, relative, null, check).raw.equals(raw)) fail("DERIVED_ARTIFACT_CONFLICT", { relative });
  return true;
}
function summary(result) {
  const m = result.manifest, diagnostics = result.diagnostics;
  return { ...nativeOutcome("claude"), status: m.publicationReady ? "native-derived-artifact-ready" : "native-derived-artifact-needs-representation-review",
    authorityPlane: "P4", derivationId: m.derivationId, derivationDigest: result.digest,
    derivationDirectory: result.directory, source: m.source, sourceSelection: m.input.selection,
    target: m.target, publicationReady: m.publicationReady, originalCompanionUnchanged: true,
    ...(m.displayMetadata ? { displayMetadata: m.displayMetadata } : {}),
    openSafety: m.openSafety,
    messageCount: result.rows.length, mappingCount: result.mapping.length,
    diagnosticCount: diagnostics.length, diagnostics: diagnostics.slice(0, 32), omittedDiagnostics: Math.max(0, diagnostics.length - 32),
    diagnosticsOriginal: path.join(result.directory, "diagnostics.json"), mappingsOriginal: path.join(result.directory, "mapping.json"),
    nativeProfilePublished: false, officialReaderVerified: false, desktopVisibility: "not-observed", modelContextUse: "not-tested",
    logicalSessionOwnership: "not-established-by-derived-transcript", semanticSufficiencyClaimed: false,
  };
}

// New P3 evidence under the common bundle. No original native link, Project,
// Session, checkpoint, source object or current provider route is rewritten.
export function deriveProjectNativeHistory({ bundleRoot, expectedBundleId = null, root, threadIds, cutoffItemId = null, converter,
  signal, assertCurrentAuthority = () => {} }) {
  if (!Array.isArray(threadIds) || threadIds.length !== 1) fail("DERIVED_ONE_EXACT_SOURCE_THREAD_REQUIRED");
  if (cutoffItemId !== null && (typeof cutoffItemId !== "string" || !cutoffItemId || cutoffItemId.length > 256)) fail("DERIVED_CUTOFF_ITEM_INVALID");
  const source = selectedSource({ bundleRoot, expectedBundleId, signal, assertCurrentAuthority });
  return deriveSelectedNativeHistory({ root, threadIds, cutoffItemId, signal, converter }, source);
}
function deriveSelectedNativeHistory({ root, threadIds, cutoffItemId = null, signal, converter }, sourceContext) {
  if (converter !== undefined && !physicalProfiles.includes(converter)) fail("DERIVED_CONVERTER_PROFILE_UNQUALIFIED");
  if (!Array.isArray(threadIds) || threadIds.length !== 1) fail("DERIVED_ONE_EXACT_SOURCE_THREAD_REQUIRED");
  if (cutoffItemId !== null && (typeof cutoffItemId !== "string" || !cutoffItemId || cutoffItemId.length > 256)) fail("DERIVED_CUTOFF_ITEM_INVALID");
  const { selected, root: bundle, check, recheck } = sourceContext;
  const targetRoot = nativeRoot(root), targetPin = pinNativeRoot(targetRoot);
  const current = () => { check(); targetPin.verify(); };
  const targetStat = fs.lstatSync(targetRoot, { bigint: true });
  const source = sourceBinding(selected);
  if (converter !== undefined && selected.sourceKind !== "captured-physical") fail("DERIVED_CONVERTER_SOURCE_KIND_INVALID");
  const reader = selected.sourceKind === "captured-physical" ? readPhysical : readCodexDerivedEvents;
  let read = reader({ native: selected.native, threadId: threadIds[0], cutoffItemId, ...(converter ? { converter } : {}), signal, check: current });
  const inputFor = converter => ({ source, selection: { threadId: threadIds[0], cutoffItemId }, converter,
    targetFormat: format.id, targetRoot: { path: targetRoot, dev: String(targetStat.dev), ino: String(targetStat.ino) } });
  if (selected.sourceKind === "captured-physical" && converter === undefined) {
    const intentFor = converter => copiedProjectFile(bundle, derivationPath("derived-claude-" + hash(json(inputFor(converter))).slice(0, 24)) + "/intent.json");
    current();
    const existing = physicalProfiles.filter(profile => fs.lstatSync(intentFor(profile), { throwIfNoEntry: false }));
    if (existing.length > 1) fail("DERIVED_MULTIPLE_PHYSICAL_PROFILES_REQUIRE_EXISTING_SELECTION");
    // Existing source identity wins over a new naming default. Titles are
    // corrected separately; do not remint a native conversation.
    if (existing.length) read = reader({ native: selected.native, threadId: threadIds[0], cutoffItemId, converter: existing[0], signal, check: current });
  }
  const input = { source, selection: { threadId: threadIds[0], cutoffItemId }, converter: read.converter,
    targetFormat: format.id, targetRoot: { path: targetRoot, dev: String(targetStat.dev), ino: String(targetStat.ino) } };
  const inputDigest = hash(json(input)), derivationId = "derived-claude-" + inputDigest.slice(0, 24), relative = derivationPath(derivationId);
  const nativeId = targetUuid(inputDigest);
  const intentRelative = relative + "/intent.json", intentFile = copiedProjectFile(bundle, intentRelative);
  let intent;
  if (!fs.existsSync(intentFile)) {
    const proposed = { schemaVersion: 1, kind: "ClaudeDerivedHistoryIntent", authorityPlane: "P3", inputDigest, input,
      targetNativeId: nativeId, createdAt: new Date().toISOString(), grantsRecoveryAuthority: false, restoresExecutionPermission: false };
    fs.mkdirSync(path.dirname(intentFile), { recursive: true }); copiedProjectFile(bundle, intentRelative); current();
    try { atomicCreateArtifact(intentFile, json(proposed)); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  {
    intent = JSON.parse(nativeRaw(bundle, intentRelative, signal, current).raw.toString("utf8"));
    verifyIntent(intent, input, inputDigest, nativeId);
  }
  const encoded = encodeRead(read, { targetId: nativeId, cwd: targetRoot, createdAt: intent.createdAt });
  encoded.openSafety.sourceLifecycle = read.sourceLifecycle;
  encoded.openSafety.structurallySettled &&= read.sourceLifecycle.terminalAtCapture;
  const bodies = { "conversation.jsonl": encoded.raw, "mapping.json": json(mappingFor(read, encoded)),
    "diagnostics.json": json(encoded.diagnostics) };
  const manifest = manifestFor({ derivationId, inputDigest, input, source, intent, encoded, bodies });
  for (const [name, raw] of Object.entries(bodies)) createExact(bundle, relative + "/" + name, raw, current);
  recheck();
  createExact(bundle, relative + "/manifest.json", json(manifest), current);
  return summary(inspectSelectedNativeDerivation({ derivationId, expectedDerivationDigest: hash(json(manifest)), signal }, sourceContext));
}

export function inspectProjectNativeDerivation({ bundleRoot, expectedBundleId = null, derivationId, expectedDerivationDigest = null,
  signal, assertCurrentAuthority = () => {} }) {
  return inspectSelectedNativeDerivation({ derivationId, expectedDerivationDigest, signal }, selectedSource({ bundleRoot, expectedBundleId, signal, assertCurrentAuthority }));
}
function inspectSelectedNativeDerivation({ derivationId, expectedDerivationDigest = null, signal }, sourceContext) {
  const { selected, root: bundle, check, recheck } = sourceContext;
  const relative = derivationPath(derivationId), entry = nativeRaw(bundle, relative + "/manifest.json", signal, check);
  if (expectedDerivationDigest !== null && entry.entry.sha256 !== expectedDerivationDigest) fail("DERIVED_MANIFEST_DIGEST_MISMATCH");
  const manifest = JSON.parse(entry.raw.toString("utf8")), m = manifest;
  if (![format.converter, CODEX_COMPLETION_CONVERTER, ...physicalProfiles].includes(m?.input?.converter)) fail("DERIVED_CONVERTER_PROFILE_UNQUALIFIED");
  const reader = selected.sourceKind === "captured-physical" ? readPhysical : readCodexDerivedEvents;
  const read = reader({ native: selected.native, threadId: m.input?.selection?.threadId,
    cutoffItemId: m.input?.selection?.cutoffItemId, converter: m.input?.converter, signal, check });
  if (m.input.converter !== read.converter) fail("DERIVED_CONVERTER_PROFILE_UNQUALIFIED");
  const input = { source: sourceBinding(selected), selection: { threadId: m.input?.selection?.threadId, cutoffItemId: m.input?.selection?.cutoffItemId },
    converter: read.converter, targetFormat: format.id, targetRoot: { path: m.input?.targetRoot?.path, dev: m.input?.targetRoot?.dev, ino: m.input?.targetRoot?.ino } };
  if (m?.schemaVersion !== 1 || m.kind !== "CodexToClaudeDerivedHistory" || m.authorityPlane !== "P3"
    || m.derivationId !== derivationId || m.inputDigest !== hash(json(m.input)) || derivationId !== "derived-claude-" + m.inputDigest.slice(0, 24)
    || m.input?.targetFormat !== format.id || m.target?.format !== format.id || m.target.nativeId !== targetUuid(m.inputDigest)
    || m.target.cwd !== m.input.targetRoot?.path || m.target.cliVersion !== format.cliVersion || m.target.sdkVersion !== format.sdkVersion
    || m.grantsRecoveryAuthority !== false || m.restoresExecutionPermission !== false || m.transfersNativeBinding !== false
    || m.source?.commonManifestDigest !== selected.commonManifestDigest || m.source.originalLinkDigest !== selected.linkDigest
    || m.source.nativePayloadDigest !== selected.native.payloadDigest || m.source.projectId !== selected.projectId || m.source.selectedSessionId !== selected.selectedSessionId
    || !isDeepStrictEqual(m.source, m.input.source) || !isDeepStrictEqual(m.input, input)
    || typeof input.targetRoot.path !== "string" || !path.isAbsolute(input.targetRoot.path)
    || ![input.targetRoot.dev, input.targetRoot.ino].every(value => typeof value === "string" && /^\d+$/u.test(value))) fail("DERIVED_MANIFEST_IDENTITY_MISMATCH");
  const intent = nativeRaw(bundle, relative + "/intent.json", signal, check);
  if (intent.entry.sha256 !== m.intentDigest) fail("DERIVED_INTENT_CHANGED");
  const i = JSON.parse(intent.raw.toString("utf8"));
  verifyIntent(i, input, m.inputDigest, m.target.nativeId);
  const files = new Map();
  if (!Array.isArray(m.files) || m.files.length !== 3) fail("DERIVED_MANIFEST_FILES_INVALID");
  for (const file of m.files) {
    if (!["conversation.jsonl", "mapping.json", "diagnostics.json"].includes(file?.file) || files.has(file.file)) fail("DERIVED_MANIFEST_FILES_INVALID");
    const body = nativeRaw(bundle, relative + "/" + file.file, signal, check);
    if (body.entry.sha256 !== file.sha256 || body.entry.bytes !== file.bytes) fail("DERIVED_ARTIFACT_TAMPER", { relative: file.file });
    files.set(file.file, body.raw);
  }
  // Reproduce the exact supported representation from current verified source,
  // rather than trusting mutually editable JSON claims about item coverage.
  const encoded = encodeRead(read, { targetId: m.target.nativeId, cwd: m.target.cwd, createdAt: i.createdAt });
  encoded.openSafety.sourceLifecycle = read.sourceLifecycle;
  encoded.openSafety.structurallySettled &&= read.sourceLifecycle.terminalAtCapture;
  const mapping = JSON.parse(files.get("mapping.json").toString("utf8")), diagnostics = JSON.parse(files.get("diagnostics.json").toString("utf8"));
  const expectedMapping = mappingFor(read, encoded);
  const bodies = { "conversation.jsonl": encoded.raw, "mapping.json": json(expectedMapping), "diagnostics.json": json(encoded.diagnostics) };
  const expectedManifest = manifestFor({ derivationId, inputDigest: m.inputDigest, input, source: input.source, intent: i, encoded, bodies });
  if (!files.get("conversation.jsonl").equals(encoded.raw) || !isDeepStrictEqual(mapping, expectedMapping)
    || !isDeepStrictEqual(diagnostics, encoded.diagnostics)
    || !isDeepStrictEqual(m, expectedManifest)) fail("DERIVED_REPRODUCTION_MISMATCH");
  recheck();
  const directory = copiedProjectFile(bundle, relative), directoryPin = pinNativeRoot(directory);
  const recheckArtifact = () => {
    recheck(); directoryPin.verify();
    if (inspectCopiedProjectFile(directory, "manifest.json", { signal, assertCurrentAuthority: check }).sha256 !== entry.entry.sha256
      || inspectCopiedProjectFile(directory, "intent.json", { signal, assertCurrentAuthority: check }).sha256 !== m.intentDigest) fail("DERIVED_ARTIFACT_TAMPER");
    for (const file of m.files) {
      const body = inspectCopiedProjectFile(directory, file.file, { signal, assertCurrentAuthority: check });
      if (body.sha256 !== file.sha256 || body.bytes !== file.bytes) fail("DERIVED_ARTIFACT_TAMPER");
    }
  };
  return { bundleRoot: bundle, directory: copiedProjectFile(bundle, relative), digest: entry.entry.sha256, manifest: m,
    raw: encoded.raw, rows: encoded.rows, mapping: encoded.mappings, diagnostics, selected, check, ...(encoded.hybridCoverage ? { hybridCoverage: encoded.hybridCoverage } : {}),
    recheck: recheckArtifact };
}

async function portableSourceContext({ directory, archiveId, expectedArchiveDigest, threadId, signal, assertCurrentAuthority }) {
  if (typeof assertCurrentAuthority !== "function" || !/^[a-f0-9]{64}$/u.test(expectedArchiveDigest || "")) fail("PORTABLE_DERIVED_CURRENT_EXACT_SOURCE_REQUIRED");
  nativeCheck(signal, assertCurrentAuthority);
  const { inspectPortableProjectEvidence } = await import("./portable-project-evidence.mjs");
  const root = nativeRoot(directory), pin = pinNativeRoot(root), check = () => { nativeCheck(signal, assertCurrentAuthority); pin.verify(); };
  const inspected = inspectPortableProjectEvidence({ directory: root, archiveId, expectedArchiveDigest, workspaceSourceRoots: [], signal, assertCurrentAuthority: check });
  const source = inspected.sources.find(source => source.threadId === threadId);
  if (!source) fail("PORTABLE_DERIVED_EXACT_PHYSICAL_SOURCE_UNAVAILABLE");
  const selected = { sourceKind: "captured-physical", native: source.native };
  const recheck = () => {
    check(); const latest = inspectPortableProjectEvidence({ directory: root, archiveId, expectedArchiveDigest, workspaceSourceRoots: [], signal, assertCurrentAuthority: check });
    if (latest.sources.find(item => item.threadId === threadId)?.native.payloadDigest !== source.native.payloadDigest) fail("DERIVED_SOURCE_PAYLOAD_CHANGED");
  };
  return { root, selected, check, recheck, source };
}

// Reuse the exact supported derivation/inspection codec without recreating a
// native source store. Existing P3 intent/body originals can be resumed; old P5
// publication records stay archive observations and never become local leases.
export async function derivePortableProjectNativeHistory({ directory, archiveId, expectedArchiveDigest, root, threadId, signal, assertCurrentAuthority, converter }) {
  const source = await portableSourceContext({ directory, archiveId, expectedArchiveDigest, threadId, signal, assertCurrentAuthority });
  for (const entry of source.source.history.entries) {
    if (!["derivative-identity-original", "derivative-payload-original"].includes(entry.kind)) continue;
    if (!/^native\/derived\/claude\/derived-claude-[a-f0-9]{24}\/(?:intent\.json|manifest\.json|conversation\.jsonl|mapping\.json|diagnostics\.json)$/u.test(entry.path)) fail("PORTABLE_DERIVED_HISTORY_PATH_INVALID");
    source.check(); const original = nativeRaw(source.root, "objects/" + entry.original.sha256 + ".bin", signal, source.check);
    if (original.entry.sha256 !== entry.original.sha256 || original.entry.bytes !== entry.original.bytes) fail("DERIVED_SOURCE_PAYLOAD_CHANGED");
    createExact(source.root, entry.path, original.raw, source.check);
  }
  return deriveSelectedNativeHistory({ root, threadIds: [threadId], cutoffItemId: null, signal, converter }, source);
}

export async function inspectPortableProjectNativeDerivation({ directory, archiveId, expectedArchiveDigest, threadId, derivationId, expectedDerivationDigest = null,
  signal, assertCurrentAuthority }) {
  return inspectSelectedNativeDerivation({ derivationId, expectedDerivationDigest, signal },
    await portableSourceContext({ directory, archiveId, expectedArchiveDigest, threadId, signal, assertCurrentAuthority }));
}

export async function locatePortableProjectNativeDerivation({ directory, archiveId, expectedArchiveDigest, threadId, root, signal, assertCurrentAuthority, converter }) {
  if (converter !== undefined && !physicalProfiles.includes(converter)) fail("DERIVED_CONVERTER_PROFILE_UNQUALIFIED");
  const context = await portableSourceContext({ directory, archiveId, expectedArchiveDigest, threadId, signal, assertCurrentAuthority });
  context.check(); const target = nativeRoot(root), stat = fs.lstatSync(target, { bigint: true }), found = [];
  for (const profile of converter === undefined ? physicalProfiles : [converter]) {
    const input = { source: sourceBinding(context.selected), selection: { threadId, cutoffItemId: null }, converter: profile,
      targetFormat: format.id, targetRoot: { path: target, dev: String(stat.dev), ino: String(stat.ino) } };
    const derivationId = "derived-claude-" + hash(json(input)).slice(0, 24); context.check();
    const intent = fs.lstatSync(copiedProjectFile(context.root, derivationPath(derivationId) + "/intent.json"), { throwIfNoEntry: false });
    if (intent) found.push(derivationId);
  }
  if (found.length > 1) fail("DERIVED_MULTIPLE_PHYSICAL_PROFILES_REQUIRE_EXISTING_SELECTION");
  if (!found.length) return null;
  return inspectSelectedNativeDerivation({ derivationId: found[0], signal }, context);
}
export function projectNativeDerivationSummary(result) { return summary(result); }

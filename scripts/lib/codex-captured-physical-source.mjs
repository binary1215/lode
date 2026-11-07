import { capturedCodexDisplayMetadata } from "./codex-display-metadata.mjs";
import fs from "node:fs";
import { isHistoryBytes, historyEquals, readHistoryRaw, createHistoryArtifact, captureHistoryPrefix, HISTORY_MEMORY_BYTES } from "./native-history-bytes.mjs";
import path from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import { atomicCreateArtifact } from "./artifact-storage.mjs";
import { copiedProjectFile } from "./project-copy-evidence.mjs";
import { nativeRoot, pinNativeRoot, nativeRaw, nativeCheck, nativeSeparate } from "./provider-native-history-host.mjs";
import { resolveCodexPhysicalLineage } from "./codex-physical-lineage.mjs";
import { parseCodexSourceJson } from "./codex-source-json.mjs";
import { verifySelectedCodexStateEvidence } from "./codex-native-state-evidence.mjs";
import { verifyCodexLiveProjectObservation } from "./codex-live-project-source.mjs";
import { derivedHash as hash, derivedJson as json, derivedFail as fail } from "./claude-derived-encoder.mjs";

export const CODEX_PHYSICAL_CONVERTER = "codex-claude-physical-v3";
export const CODEX_PHYSICAL_TITLE_CONVERTER = "codex-claude-physical-v2";
export const CODEX_PHYSICAL_PROFILES = [CODEX_PHYSICAL_CONVERTER, CODEX_PHYSICAL_TITLE_CONVERTER, "codex-claude-physical-v1"];
export const CODEX_PHYSICAL_PRIOR_CONVERTER = "codex-claude-physical-v1";
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
const capturedBindings = new WeakSet();
function archiveContext(directory, signal, authority) {
  nativeCheck(signal, authority);
  const root = nativeRoot(directory), pin = pinNativeRoot(root);
  return { root, check: () => { nativeCheck(signal, authority); pin.verify(); } };
}
function exact(root, relative, bytes, check) {
  check(); const file = copiedProjectFile(root, relative);
  if (fs.lstatSync(file, { throwIfNoEntry: false })) {
    if (!historyEquals(readHistoryRaw(root, relative, null, check).raw, bytes)) fail("PHYSICAL_SOURCE_ARCHIVE_CONFLICT");
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true }); copiedProjectFile(root, relative); check();
  try { createHistoryArtifact(file, bytes, check); } catch (error) { if (error.code !== "EEXIST") throw error; }
  if (!historyEquals(readHistoryRaw(root, relative, null, check).raw, bytes)) fail("PHYSICAL_SOURCE_ARCHIVE_CONFLICT");
}

// Intake for explicitly selected already-captured JSONL prefixes. This reads no
// database, source settings, provider API, implicit sibling or transcript path.
// A matching declared digest identifies the bytes; it does not certify capture
// origin, native inventory completeness or a live consistent snapshot.
export function captureCodexPhysicalSourceFiles({ sourceRoot, directory, threadId, rolloutId, files,
  selectedStateEvidenceFile, expectedSelectedStateDigest,
  signal, assertCurrentAuthority = () => {} }) {
  if (!uuid(threadId) || !uuid(rolloutId) || !Array.isArray(files) || new Set(files.map(file => file?.rolloutId)).size !== files.length) fail("PHYSICAL_SOURCE_FILES_INVALID");
  if ((selectedStateEvidenceFile !== undefined || expectedSelectedStateDigest !== undefined)
    && (typeof selectedStateEvidenceFile !== "string" || !path.isAbsolute(selectedStateEvidenceFile)
      || !/^[a-f0-9]{64}$/u.test(expectedSelectedStateDigest || ""))) fail("PHYSICAL_STATE_EVIDENCE_EXACT_FILE_REQUIRED");
  const index = new Map();
  for (const file of files) {
    if (!file || !uuid(file.rolloutId) || !uuid(file.threadId) || typeof file.path !== "string"
      || !["-", "_"].some(separator => path.posix.basename(file.path).endsWith(separator + file.rolloutId + ".jsonl"))
      || !Number.isSafeInteger(file.endByteOffset) || file.endByteOffset < 1
      || !/^[a-f0-9]{64}$/u.test(file.sha256 || "")) fail("PHYSICAL_SOURCE_FILES_INVALID");
    index.set(file.rolloutId, file);
  }
  const source = archiveContext(sourceRoot, signal, assertCurrentAuthority);
  if (typeof directory !== "string" || !path.isAbsolute(directory)) fail("PHYSICAL_SOURCE_DESTINATION_REQUIRED");
  const absolute = path.resolve(directory), parent = nativeRoot(path.dirname(absolute)), parentPin = pinNativeRoot(parent);
  const destination = copiedProjectFile(parent, path.basename(absolute));
  const exists = Boolean(fs.lstatSync(destination, { throwIfNoEntry: false })), target = exists ? archiveContext(destination, signal, assertCurrentAuthority) : null;
  nativeSeparate(source.root, target?.root ?? destination);
  const check = () => { source.check(); parentPin.verify(); target?.check(); }, originals = [], seen = new Set();
  const owned = []; let failure = null;
  try {
  let selected = rolloutId, requiredBytes = null, selectedObservation = null;
  while (selected !== null) {
    check(); if (seen.has(selected)) fail("CODEX_LINEAGE_CYCLE"); seen.add(selected);
    const file = index.get(selected);
    if (!file) fail("CODEX_LINEAGE_ANCESTOR_MISSING");
    if (requiredBytes !== null && file.endByteOffset !== requiredBytes) fail("CODEX_LINEAGE_CUTOFF_MISMATCH");
    const filename = copiedProjectFile(source.root, file.path), before = fs.lstatSync(filename, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < BigInt(file.endByteOffset)) fail("PHYSICAL_SOURCE_FILE_UNSAFE");
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let raw;
    try {
      check(); const opened = fs.fstatSync(fd, { bigint: true });
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1n) fail("PHYSICAL_SOURCE_FILE_CHANGED");
      if (file.endByteOffset > HISTORY_MEMORY_BYTES) { const captured = captureHistoryPrefix(fd, file.endByteOffset, check); owned.push(captured); raw = captured.raw; }
      else { raw = Buffer.alloc(file.endByteOffset); let offset = 0;
      while (offset < raw.length) {
        check(); const count = fs.readSync(fd, raw, offset, Math.min(65536, raw.length - offset), offset);
        if (!count) fail("PHYSICAL_SOURCE_FILE_CHANGED"); offset += count;
      } }
      check(); const after = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(filename, { bigint: true });
      if (after.dev !== before.dev || after.ino !== before.ino || named.dev !== before.dev || named.ino !== before.ino
        || after.nlink !== 1n || named.nlink !== 1n || after.size < BigInt(raw.length) || hash(raw) !== file.sha256) fail("PHYSICAL_SOURCE_FILE_CHANGED");
      if (selected === rolloutId) selectedObservation = { canonicalPath: fs.realpathSync(filename), dev: String(after.dev), ino: String(after.ino) };
    } finally { fs.closeSync(fd); }
    const end = raw.indexOf(10);
    if (end < 0) fail("CODEX_LINEAGE_INCOMPLETE_JSONL");
    const header = parseCodexSourceJson(new TextDecoder("utf-8", { fatal: true }).decode(raw.subarray(0, end)));
    originals.push({ rolloutId: file.rolloutId, threadId: file.threadId, raw, sha256: file.sha256 });
    selected = header.payload?.history_base?.thread_id ?? null;
    requiredBytes = header.payload?.history_base?.end_byte_offset ?? null;
  }
  const proof = resolveCodexPhysicalLineage({ originals, rolloutId, check });
  let binding = null;
  if (selectedStateEvidenceFile !== undefined || expectedSelectedStateDigest !== undefined) {
    check();
    if (typeof selectedStateEvidenceFile !== "string" || !path.isAbsolute(selectedStateEvidenceFile)
      || !/^[a-f0-9]{64}$/u.test(expectedSelectedStateDigest || "")) fail("PHYSICAL_STATE_EVIDENCE_EXACT_FILE_REQUIRED");
    const evidenceRoot = archiveContext(path.dirname(selectedStateEvidenceFile), signal, assertCurrentAuthority);
    const evidenceCheck = () => { check(); evidenceRoot.check(); };
    const raw = nativeRaw(evidenceRoot.root, path.basename(selectedStateEvidenceFile), signal, evidenceCheck);
    if (raw.entry.sha256 !== expectedSelectedStateDigest) fail("PHYSICAL_STATE_EVIDENCE_CHANGED");
    const evidence = parseCodexSourceJson(new TextDecoder("utf-8", { fatal: true }).decode(raw.raw));
    const state = verifySelectedCodexStateEvidence(evidence, [threadId])[0];
    const selectedRaw = originals.find(original => original.rolloutId === rolloutId).raw;
    const selectedHeader = parseCodexSourceJson(new TextDecoder("utf-8", { fatal: true }).decode(selectedRaw.subarray(0, selectedRaw.indexOf(10)))).payload;
    binding = { kind: "captured-selected-state-path", status: "association-proposed", evidence, evidenceDigest: raw.entry.sha256,
      sourcePlatform: process.platform, stableNativeThreadId: threadId, physicalRolloutId: rolloutId,
      rootSessionId: proof.rootSessionId, selectedPrefixDigest: index.get(rolloutId).sha256,
      statePath: state.rollout_path, observedSource: selectedObservation, queryReplayVerified: false,
      reasonCode: "PHYSICAL_STATE_PATH_NOT_BOUND" };
    if (state.cli_version === selectedHeader.cli_version && state.history_mode === selectedHeader.history_mode
      && typeof state.rollout_path === "string" && path.isAbsolute(state.rollout_path)
      && ["-", "_"].some(separator => path.basename(state.rollout_path).endsWith(separator + rolloutId + ".jsonl"))) {
      const namespaced = value => process.platform === "win32" ? path.toNamespacedPath(value) : value;
      const relative = path.relative(namespaced(source.root), namespaced(state.rollout_path));
      if (relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) {
        evidenceCheck(); const named = copiedProjectFile(source.root, relative.split(path.sep).join("/")), stat = fs.lstatSync(named, { bigint: true, throwIfNoEntry: false });
        if (stat?.isFile() && stat.nlink === 1n && String(stat.dev) === selectedObservation.dev && String(stat.ino) === selectedObservation.ino) {
          binding.status = "captured-state-path-verified"; binding.stateCanonicalPath = fs.realpathSync(named); binding.reasonCode = null;
        }
      }
    }
    capturedBindings.add(binding);
  }
  check(); if (!exists) fs.mkdirSync(destination);
  return archiveCodexCapturedPhysicalSource({ directory: target?.root ?? destination, threadId, rolloutId, originals, _selectionBinding: binding,
    signal, assertCurrentAuthority: check });
  } catch (error) { failure = error; throw error;
  } finally {
    let cleanupFailure = null;
    for (const capture of owned) try { capture.release(); } catch (error) { cleanupFailure ??= error; }
    if (cleanupFailure) { if (failure) failure.captureCleanup = { code: cleanupFailure.code }; else throw cleanupFailure; }
  }
}

// Current trusted Host supplies already-captured bytes, not transcript paths,
// live DB handles or permission. Only the selected dependency prefixes survive
// in the archive. Other supplied originals/suffixes are never stored.
export function archiveCodexCapturedPhysicalSource({ directory, threadId, rolloutId, originals,
  _selectionBinding = null,
  signal, assertCurrentAuthority = () => {} }) {
  const { root, check } = archiveContext(directory, signal, assertCurrentAuthority);
  const { trimmed, raw, digest, payloadId } = encodeCapturedPhysicalSource({ threadId, rolloutId, originals, _selectionBinding, check });
  exact(root, "capture-intent.json", json({ schemaVersion: 1, kind: "CapturedPhysicalHistoryIntent", payloadId, payloadDigest: digest }), check);
  for (const original of trimmed) exact(root, "objects/" + original.sha256 + ".bin", original.raw, check);
  exact(root, "manifest.json", raw, check);
  const inspected = inspectCodexCapturedPhysicalSource({ directory: root, expectedPayloadId: payloadId, signal, assertCurrentAuthority });
  return { directory: root, payloadId, payloadDigest: inspected.payloadDigest, authorityPlane: "P4",
    physicalSegmentCount: trimmed.length, selectedThreadId: threadId, storedOnlySelectedPrefixes: true,
    selectionBindingStatus: inspected.selectionBinding?.status ?? "association-proposed",
    liveSourceSnapshotQualified: false, semanticConversionPerformed: false, grantsRecoveryAuthority: false };
}

function encodeCapturedPhysicalSource({ threadId, rolloutId, originals, _selectionBinding = null, check }) {
  if (_selectionBinding !== null && !capturedBindings.has(_selectionBinding)) fail("PHYSICAL_STATE_BINDING_CAPTURE_REQUIRED");
  const proof = resolveCodexPhysicalLineage({ originals, rolloutId, check });
  if (!uuid(threadId) || proof.segments.at(-1)?.threadId !== threadId) fail("PHYSICAL_SOURCE_SELECTION_MISMATCH");
  const byId = new Map(originals.map(original => [original.rolloutId, original]));
  const trimmed = proof.segments.map(segment => {
    const original = byId.get(segment.rolloutId), raw = original.raw.subarray(0, segment.endByteOffset);
    return { rolloutId: segment.rolloutId, threadId: segment.threadId, raw, sha256: hash(raw),
      ...(original.encoding ? { sourceEncoding: original.encoding } : {}) };
  });
  // Reproduce from the actual archived prefixes. Full parent-suffix digests or
  // counts are not identity inputs: changing an excluded future must not mint
  // a new selected source or target conversation.
  resolveCodexPhysicalLineage({ originals: trimmed, rolloutId, check });
  const payload = { schemaVersion: 1, kind: "CodexCapturedPhysicalHistory", authorityPlane: "P3",
    threadIds: [threadId], selectedRolloutId: rolloutId,
    ...(_selectionBinding ? { selectionBinding: _selectionBinding } : {}),
    files: trimmed.map(original => ({ rolloutId: original.rolloutId, threadId: original.threadId,
      sha256: original.sha256, bytes: original.raw.length, ...(original.sourceEncoding ? { sourceEncoding: original.sourceEncoding } : {}) })),
    sourceBasis: "explicitly-supplied-captured-physical-prefixes-not-a-live-provider-snapshot",
    canonicalDatabaseRowsClaimed: false, modelContextEquivalent: false, globalInventoryComplete: false,
    grantsRecoveryAuthority: false, restoresExecutionPermission: false };
  const raw = json(payload), digest = hash(raw), payloadId = "physical-history-" + digest.slice(0, 24);
  return { trimmed, raw, digest, payloadId };
}

// Shared physical codec, with no executable source store or source re-open.
// The trusted closed intake, not caller assertions, provides the path/FD basis.
export function encodeCodexObservedLivePhysicalSource({ observation, threadId, check = () => {} }) {
  check(); const observed = verifyCodexLiveProjectObservation(observation);
  const encoded = encodeVerifiedObservedSelection({ observation, observed, threadId, check });
  check(); verifyCodexLiveProjectObservation(observation); return encoded;
}

// No packet escapes until the whole exact observation passes again. This is
// batching identical work, not a caller-supplied verification token or scope.
export function encodeCodexObservedLivePhysicalSources({ observation, check = () => {} }) {
  check(); const observed = verifyCodexLiveProjectObservation(observation), encoded = new Map();
  for (const row of observed.conversations) {
    check(); encoded.set(row.threadId, encodeVerifiedObservedSelection({ observation, observed, threadId: row.threadId, check }));
  }
  check(); verifyCodexLiveProjectObservation(observation);
  return { observed, encoded };
}

function encodeVerifiedObservedSelection({ observation, observed, threadId, check }) {
  const selected = observed.conversations.find(row => row.threadId === threadId);
  if (!selected || selected.lineage?.status !== "physical-lineage-ranges-verified") return null;
  const leaf = selected.originals.find(row => row.rolloutId === selected.rolloutId), evidence = selected.selectedStateEvidence;
  const state = verifySelectedCodexStateEvidence(evidence, [threadId])[0], verified = selected.selectedStateHeaderAgreement === true;
  const binding = { kind: "captured-selected-state-path", status: verified ? "captured-state-path-verified" : "association-proposed",
    evidence, evidenceDigest: hash(json(evidence)), sourcePlatform: observation.evidence.platform, stableNativeThreadId: threadId,
    physicalRolloutId: selected.rolloutId, rootSessionId: selected.lineage.rootSessionId, selectedPrefixDigest: leaf.sha256,
    statePath: state.rollout_path, observedSource: { canonicalPath: leaf.canonicalPath, ...leaf.identity }, queryReplayVerified: false,
    reasonCode: verified ? null : "PHYSICAL_STATE_PATH_NOT_BOUND", ...(verified ? { stateCanonicalPath: leaf.canonicalPath } : {}) };
  capturedBindings.add(binding);
  const encoded = encodeCapturedPhysicalSource({ threadId, rolloutId: selected.rolloutId, originals: selected.originals, _selectionBinding: binding, check });
  check();
  return { manifestRaw: encoded.raw, intentRaw: json({ schemaVersion: 1, kind: "CapturedPhysicalHistoryIntent", payloadId: encoded.payloadId, payloadDigest: encoded.digest }),
    originals: encoded.trimmed, payloadId: encoded.payloadId, payloadDigest: encoded.digest };
}

export function inspectCodexCapturedPhysicalSource({ directory, expectedPayloadId = null, signal, assertCurrentAuthority = () => {} }) {
  const { root, check } = archiveContext(directory, signal, assertCurrentAuthority);
  const verified = verifyCodexCapturedPhysicalEvidence({ manifestRaw: nativeRaw(root, "manifest.json", signal, check).raw,
    captureIntentRaw: nativeRaw(root, "capture-intent.json", signal, check).raw, expectedPayloadId, check,
    readObject: file => readHistoryRaw(root, "objects/" + file.sha256 + ".bin", signal, check).raw });
  return { ...verified, directory: root, authorityPlane: "P4", check };
}

// Byte verification is shared by local captures and non-executable portable P3
// archives. It never resolves recorded source paths or creates a native store.
export function verifyCodexCapturedPhysicalEvidence({ manifestRaw, captureIntentRaw, readObject, expectedPayloadId = null, check = () => {} }) {
  check();
  const payloadDigest = hash(manifestRaw), payload = parseCodexSourceJson(new TextDecoder("utf-8", { fatal: true }).decode(manifestRaw));
  const payloadId = "physical-history-" + payloadDigest.slice(0, 24);
  const intent = parseCodexSourceJson(new TextDecoder("utf-8", { fatal: true }).decode(captureIntentRaw));
  if (!equal(intent, { schemaVersion: 1, kind: "CapturedPhysicalHistoryIntent", payloadId, payloadDigest })
    || expectedPayloadId !== null && expectedPayloadId !== payloadId) fail("PHYSICAL_SOURCE_IDENTITY_MISMATCH");
  if (payload?.schemaVersion !== 1 || payload.kind !== "CodexCapturedPhysicalHistory" || payload.authorityPlane !== "P3"
    || !Array.isArray(payload.threadIds) || payload.threadIds.length !== 1 || !uuid(payload.threadIds[0]) || !uuid(payload.selectedRolloutId)
    || !Array.isArray(payload.files) || !payload.files.length || new Set(payload.files.map(file => file.rolloutId)).size !== payload.files.length
    || payload.sourceBasis !== "explicitly-supplied-captured-physical-prefixes-not-a-live-provider-snapshot"
    || payload.canonicalDatabaseRowsClaimed !== false || payload.modelContextEquivalent !== false || payload.globalInventoryComplete !== false
    || payload.grantsRecoveryAuthority !== false || payload.restoresExecutionPermission !== false) fail("PHYSICAL_SOURCE_INVALID");
  const native = { payload, payloadId, payloadDigest };
  const originals = payload.files.map(file => {
    if (!uuid(file.rolloutId) || !uuid(file.threadId) || !/^[a-f0-9]{64}$/u.test(file.sha256 || "")
      || Object.hasOwn(file, "sourceEncoding") && file.sourceEncoding !== "zstd-decoded-selected-prefix"
      || !Number.isSafeInteger(file.bytes) || file.bytes < 1) fail("PHYSICAL_SOURCE_INVALID");
    check(); const supplied = readObject(file), raw = isHistoryBytes(supplied) ? supplied : Buffer.from(supplied);
    if (raw.length !== file.bytes || hash(raw) !== file.sha256) fail("NATIVE_HISTORY_PAYLOAD_IDENTITY_MISMATCH");
    return { ...file, raw };
  });
  for (const original of originals) {
    const end = original.raw.indexOf(10);
    if (end < 0) fail("CODEX_LINEAGE_INCOMPLETE_JSONL");
    parseCodexSourceJson(new TextDecoder("utf-8", { fatal: true }).decode(original.raw.subarray(0, end)));
  }
  const proof = resolveCodexPhysicalLineage({ originals, rolloutId: payload.selectedRolloutId, check });
  if (proof.segments.length !== originals.length || proof.segments.at(-1)?.threadId !== payload.threadIds[0]
    || proof.segments.some(segment => segment.endByteOffset !== segment.capturedBytes)) fail("PHYSICAL_SOURCE_SCOPE_MISMATCH");
  const binding = payload.selectionBinding ?? null;
  if (binding) {
    const state = verifySelectedCodexStateEvidence(binding.evidence, payload.threadIds)[0], selected = payload.files.find(file => file.rolloutId === payload.selectedRolloutId);
    const style = binding.sourcePlatform === "win32" ? path.win32 : ["linux", "darwin"].includes(binding.sourcePlatform) ? path.posix : null;
    const selectedRaw = originals.find(original => original.rolloutId === payload.selectedRolloutId).raw;
    const header = parseCodexSourceJson(selectedRaw.subarray(0, selectedRaw.indexOf(10)).toString("utf8")).payload;
    if (binding.kind !== "captured-selected-state-path" || !["association-proposed", "captured-state-path-verified"].includes(binding.status)
      || !/^[a-f0-9]{64}$/u.test(binding.evidenceDigest || "") || !style || binding.queryReplayVerified !== false
      || binding.stableNativeThreadId !== state.id || binding.physicalRolloutId !== payload.selectedRolloutId || binding.rootSessionId !== proof.rootSessionId
      || binding.selectedPrefixDigest !== selected.sha256 || binding.statePath !== state.rollout_path) fail("PHYSICAL_STATE_BINDING_INVALID");
    if (binding.status === "captured-state-path-verified" && (binding.reasonCode !== null
      || state.cli_version !== header.cli_version || state.history_mode !== header.history_mode
      || typeof binding.statePath !== "string" || !["-", "_"].some(separator => style.basename(binding.statePath).endsWith(separator + binding.physicalRolloutId + ".jsonl"))
      || typeof binding.stateCanonicalPath !== "string" || !style.isAbsolute(binding.stateCanonicalPath)
      || binding.stateCanonicalPath !== binding.observedSource?.canonicalPath
      || !/^\d+$/u.test(binding.observedSource?.dev || "") || !/^\d+$/u.test(binding.observedSource?.ino || ""))) fail("PHYSICAL_STATE_BINDING_INVALID");
  }
  return { ...native, proof, originals, selectionBinding: binding, authorityPlane: "P4", check };
}

// Semantic IR is computed from raw ItemCompleted/wire records. It is never
// persisted as counterfeit thread_items rows, current P2 or provider memory.
export function readCodexCapturedPhysicalEvents({ native, threadId, cutoffItemId = null, converter = CODEX_PHYSICAL_CONVERTER, check = () => {},
  diagnoseMalformedWireArguments = false }) {
  if (!CODEX_PHYSICAL_PROFILES.includes(converter)) fail("DERIVED_CONVERTER_PROFILE_UNQUALIFIED");
  if (native.payload.threadIds[0] !== threadId) fail("PHYSICAL_SOURCE_SELECTION_MISMATCH");
  if (cutoffItemId !== null) fail("PHYSICAL_SOURCE_ITEM_CUTOFF_UNQUALIFIED");
  const originals = new Map(native.originals.map(original => [original.rolloutId, original]));
  const events = [], diagnostics = [], inventory = [], pending = new Map(), seen = new Set(), seenItems = new Set(), canonicalTools = new Map();
  const problem = (source, code, blocksPublication = true) => diagnostics.push({ source, code, blocksPublication });
  const frames = native.proof.frames.map(frame => {
    check(); const object = originals.get(frame.source.rolloutId), raw = object.raw.subarray(frame.source.startByteOffset, frame.source.endByteOffset - 1);
    return { get document() { return parseCodexSourceJson(new TextDecoder("utf-8", { fatal: true }).decode(object.raw.subarray(frame.source.startByteOffset, frame.source.endByteOffset - 1))); }, source: {
      nativeId: frame.source.threadId, physicalRolloutId: frame.source.rolloutId, rawOrdinal: frame.source.ordinal,
      rawFrameSha256: hash(raw), prefixOrigin: frame.source.origin, recordOrigin: "captured-raw-not-canonical-DB-row" } };
  });
  let activeTurn = null;
  const startedTurns = new Set();
  for (const frame of frames) {
    const payload = frame.document.payload;
    if (frame.document.type === "event_msg" && payload?.type === "task_started") {
      if (typeof payload.turn_id !== "string" || !payload.turn_id || startedTurns.has(payload.turn_id)) problem(frame.source, "PHYSICAL_TURN_ID_UNQUALIFIED");
      if (activeTurn !== null) problem(frame.source, "PHYSICAL_OVERLAPPING_TASK_START_UNQUALIFIED");
      startedTurns.add(payload.turn_id); activeTurn = payload.turn_id;
    }
    frame.wireTurnId = activeTurn;
    if (frame.document.type === "event_msg" && ["task_complete", "task_aborted"].includes(payload?.type)) {
      frame.taskBoundaryVerified = typeof payload.turn_id === "string" && payload.turn_id === activeTurn;
      if (!frame.taskBoundaryVerified) problem(frame.source, "PHYSICAL_TASK_BOUNDARY_UNQUALIFIED");
    }
    const item = frame.document.type === "event_msg" && frame.document.payload?.type === "item_completed" ? frame.document.payload.item : null;
    if (item && (typeof activeTurn !== "string" || !activeTurn || payload.turn_id !== activeTurn))
      problem(frame.source, "PHYSICAL_ITEM_TURN_UNQUALIFIED");
    if (item?.type === "McpToolCall") {
      if (canonicalTools.has(item.id)) problem(frame.source, "PHYSICAL_CANONICAL_TOOL_ID_AMBIGUOUS");
      canonicalTools.set(item.id, { get item() { return frame.document.payload.item; }, source: frame.source, turnId: payload.turn_id, ordinal: frame.document.ordinal, matched: false });
    }
    if (frame.taskBoundaryVerified) activeTurn = null;
  }
  let terminalAtCapture = false, lastTurnStatus = "unknown";
  const add = (event, frame, sub = 0) => {
    const retained = Object.defineProperties({}, Object.getOwnPropertyDescriptors(event));
    Object.assign(retained, { at: frame.source.rawOrdinal, sub, source: { ...frame.source, ...(event.source || {}) } }); events.push(retained);
  };
  const outputEqual = (wire, canonical) => {
    if (equal(wire, canonical)) return true;
    if (typeof wire !== "string" || typeof canonical === "string") return false;
    try { return equal(parseCodexSourceJson(wire), canonical); }
    catch (error) { if (error.code === "CODEX_SOURCE_NUMERIC_PRECISION_UNQUALIFIED") throw error; return false; }
  };
  for (const frame of frames) {
    check(); const document = frame.document, p = document.payload, source = frame.source;
    inventory.push({ source, itemType: p?.item?.type ?? p?.type ?? document.type });
    if (document.type === "event_msg" && p?.type === "item_completed") {
      const item = p.item;
      if (!item || typeof item.id !== "string" || !uuid(p.thread_id) || typeof p.turn_id !== "string") { problem(source, "PHYSICAL_ITEM_IDENTITY_UNQUALIFIED"); continue; }
      if (p.thread_id !== source.nativeId && source.prefixOrigin !== "copied-inherited-prefix") fail("PHYSICAL_ITEM_NATIVE_IDENTITY_MISMATCH");
      const itemIdentity = p.thread_id + ":" + item.id;
      if (seenItems.has(itemIdentity)) problem(source, "PHYSICAL_ITEM_REVISION_OR_DUPLICATE_UNQUALIFIED");
      seenItems.add(itemIdentity);
      const itemSource = { itemId: item.id, recordedThreadId: p.thread_id, turnId: p.turn_id };
      if (item.type === "UserMessage") {
        if (!Array.isArray(item.content)) { problem(source, "PHYSICAL_USER_CONTENT_UNQUALIFIED"); continue; }
        for (const [index, part] of item.content.entries()) {
          if (part?.type === "text" && typeof part.text === "string") add({ kind: "user", get text() { return frame.document.payload.item.content[index].text; }, source: itemSource }, frame, index);
          else if (part?.type === "image" && typeof part.url === "string" && part.url.startsWith("data:")) add({ kind: "image", url: part.url, source: itemSource }, frame, index);
          else if (["image", "local_image"].includes(part?.type)) add({ kind: "attachment-unavailable", reference: structuredClone(part), source: itemSource }, frame, index);
          else problem(source, "PHYSICAL_USER_INPUT_UNQUALIFIED");
        }
      } else if (item.type === "AgentMessage") {
        if (item.phase != null && !["commentary", "partial_answer", "final_answer", "final"].includes(item.phase)) problem(source, "PHYSICAL_ASSISTANT_PHASE_UNQUALIFIED");
        if (!Array.isArray(item.content) || !item.content.every(part => part?.type === "Text" && typeof part.text === "string")) { problem(source, "PHYSICAL_ASSISTANT_CONTENT_UNQUALIFIED"); continue; }
        item.content.forEach((part, index) => add({ kind: "assistant", get text() { return frame.document.payload.item.content[index].text; }, source: itemSource }, frame, index));
      } else if (["Reasoning", "SystemMessage", "DeveloperMessage"].includes(item.type)) add({ kind: "archive", reason: "private-reasoning-or-source-instruction-not-replayed", source: itemSource }, frame);
      else if (item.type !== "McpToolCall") problem(source, "PHYSICAL_CANONICAL_ITEM_UNQUALIFIED");
      continue;
    }
    if (document.type === "event_msg" && ["task_started", "task_complete", "task_aborted"].includes(p?.type)) {
      if (source.physicalRolloutId === native.payload.selectedRolloutId && (p.type === "task_started" || frame.taskBoundaryVerified)) {
        terminalAtCapture = p.type !== "task_started"; lastTurnStatus = p.type === "task_complete" ? "completed" : p.type === "task_aborted" ? "aborted" : "inProgress";
      }
      continue;
    }
    if (document.type === "response_item" && ["function_call", "custom_tool_call"].includes(p?.type)) {
      if (typeof p.call_id !== "string" || seen.has(p.call_id)) { problem(source, "PHYSICAL_WIRE_CALL_AMBIGUOUS"); continue; }
      seen.add(p.call_id);
      let input;
      try { input = p.type === "function_call" ? typeof p.arguments === "string" ? parseCodexSourceJson(p.arguments) : p.arguments : { input: p.input }; }
      catch (error) {
        // A hybrid historical view may retain an invalid argument string as
        // passive source data. Strict/native mapping remains unqualified. Do
        // not catch outer JSON, UTF8, scope, precision or filesystem failures.
        if (diagnoseMalformedWireArguments !== true || !(error instanceof SyntaxError)) throw error;
        const address = native.proof.frames.find(candidate => candidate.source.rolloutId === source.physicalRolloutId
          && candidate.source.ordinal === source.rawOrdinal)?.source;
        if (!address) fail("PHYSICAL_WIRE_ARGUMENT_SOURCE_UNAVAILABLE");
        diagnostics.push({ code: "PHYSICAL_WIRE_ARGUMENT_JSON_UNQUALIFIED", source: { ...source,
          startByteOffset: address.startByteOffset, endByteOffset: address.endByteOffset,
          originalObjectSha256: originals.get(source.physicalRolloutId).sha256 },
          argumentBytes: Buffer.byteLength(p.arguments), argumentSha256: hash(Buffer.from(p.arguments)),
          nativeToolQualified: false, blocksPublication: true });
        continue;
      }
      const call = { kind: "tool-call", callId: p.call_id, name: p.name, namespace: p.namespace ?? null,
        get input() { const p = frame.document.payload; return p.type === "function_call" ? typeof p.arguments === "string" ? parseCodexSourceJson(p.arguments) : p.arguments : { input: p.input }; } };
      const canonical = canonicalTools.get(p.call_id);
      if (!frame.wireTurnId) problem(source, "PHYSICAL_WIRE_TURN_UNQUALIFIED");
      if (canonical && (p.type !== "function_call" || canonical.turnId !== frame.wireTurnId || canonical.ordinal < document.ordinal
        || canonical.item.tool !== p.name || canonical.item.server !== (p.namespace ?? null)
        || !equal(canonical.item.arguments, input))) problem(source, "PHYSICAL_CANONICAL_WIRE_DIVERGENCE");
      add(call, frame); pending.set(p.call_id, { call, canonical, kind: p.type, turnId: frame.wireTurnId, ordinal: document.ordinal }); continue;
    }
    if (document.type === "response_item" && ["function_call_output", "custom_tool_call_output"].includes(p?.type)) {
      const call = pending.get(p.call_id);
      if (!call || call.ordinal >= document.ordinal || call.turnId !== frame.wireTurnId
        || p.type !== (call.kind === "function_call" ? "function_call_output" : "custom_tool_call_output")) { problem(source, "PHYSICAL_WIRE_RESULT_WITHOUT_UNIQUE_CALL"); continue; }
      let isError = typeof p.is_error === "boolean" ? p.is_error : null;
      if (Object.hasOwn(p, "is_error") && typeof p.is_error !== "boolean") problem(source, "PHYSICAL_WIRE_ERROR_FLAG_UNQUALIFIED");
      if (call.canonical) {
        const item = call.canonical.item, hasResult = item.result != null, hasError = item.error != null;
        if (hasResult && (typeof item.result !== "object" || !Array.isArray(item.result.content))) problem(source, "PHYSICAL_MCP_RESULT_UNQUALIFIED");
        const output = hasResult && hasError ? { result: item.result, error: item.error } : hasError ? item.error : item.result;
        if (item.result && Object.hasOwn(item.result, "isError") && typeof item.result.isError !== "boolean") problem(source, "PHYSICAL_MCP_ERROR_FLAG_UNQUALIFIED");
        const knownError = item.status === "failed" || hasError || item.result?.isError === true;
        if (call.canonical.ordinal < document.ordinal || call.canonical.turnId !== frame.wireTurnId
          || !["completed", "failed"].includes(item.status) || !hasResult && !hasError || !outputEqual(p.output, output)
          || isError !== null && isError !== knownError) problem(source, "PHYSICAL_CANONICAL_WIRE_DIVERGENCE");
        else { call.canonical.matched = true; isError = knownError; }
      }
      if (isError === null) problem(source, "DERIVED_WIRE_TOOL_OUTCOME_UNRECORDED", false);
      add({ kind: "tool-result", callId: p.call_id, get output() { return frame.document.payload.output; }, isError,
        source: { errorFlagEvidence: isError === null ? "not-recorded" : "source-operational-observation" } }, frame);
      pending.delete(p.call_id); continue;
    }
    if (document.type === "turn_context" || document.type === "response_item" && ["message", "reasoning"].includes(p?.type)) continue;
    problem(source, "PHYSICAL_REPLAY_RECORD_UNQUALIFIED");
  }
  for (const call of pending.values()) problem({ callId: call.call.callId }, "PHYSICAL_WIRE_RESULT_MISSING");
  for (const canonical of canonicalTools.values()) if (!canonical.matched) problem(canonical.source, "PHYSICAL_CANONICAL_TOOL_MAPPING_UNQUALIFIED");
  const capturedState = native.selectionBinding ? verifySelectedCodexStateEvidence(native.selectionBinding.evidence, [threadId])[0] : null;
  const capturedTitle = typeof capturedState?.title === "string" ? capturedState.title : "";
  const visibleTitle = [...capturedTitle.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ").replace(/\s+/gu, " ").trim()].slice(0, 72).join("");
  const leaf = native.originals.find(original => original.rolloutId === native.payload.selectedRolloutId);
  const leafHeader = parseCodexSourceJson(new TextDecoder("utf-8", { fatal: true }).decode(leaf.raw.subarray(0, leaf.raw.indexOf(10)))).payload;
  const forkedFromId = uuid(leafHeader.forked_from_id) ? leafHeader.forked_from_id : null;
  const displayMetadata = { title: (visibleTitle || "Codex conversation") + " · " + threadId + (forkedFromId ? " · fork of " + forkedFromId : ""),
    basis: visibleTitle ? "captured-selected-state-title-plus-recorded-native-identities" : "synthesized-label-from-recorded-native-identities-no-semantic-title-inference",
    sourceNativeThreadId: threadId, recordedForkedFromId: forkedFromId, sourceTitleExcerptedForDisplay: capturedTitle !== visibleTitle,
    scope: "native-list-metadata-not-transcript-or-recovery-direction" };
  return { converter, ...(converter === CODEX_PHYSICAL_PRIOR_CONVERTER ? {} : { displayMetadata: converter === CODEX_PHYSICAL_CONVERTER ? capturedCodexDisplayMetadata(capturedState, threadId, forkedFromId) : displayMetadata }), events, diagnostics, inventory,
    sourceSelection: { threadId, physicalRolloutId: native.payload.selectedRolloutId, selectedPhysicalPrefixesVerified: true,
      canonicalDatabaseRowsClaimed: false, modelContextEquivalent: false },
    sourceLifecycle: { terminalAtCapture, lastTurnStatus, basis: "selected-leaf-captured-task-records-not-current-provider-status" } };
}

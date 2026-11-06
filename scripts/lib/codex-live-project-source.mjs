import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { withLiveCodexReadSnapshots } from "./codex-live-read-guard.mjs";
import { inspectCodexNativeDatabase, readSelectedCodexHistory, codexNativePortabilityProfile } from "./codex-native-portability.mjs";
import { readSelectedCodexStateEvidence, verifySelectedCodexStateEvidence } from "./codex-native-state-evidence.mjs";
import { readCodexProjectCatalog, readCodexExplicitProjectCatalog } from "./codex-project-catalog.mjs";
import { readCodexExplicitProjectSelection, codexSourcePathKey } from "./codex-explicit-project-selection.mjs";
import { copiedProjectFile } from "./project-copy-evidence.mjs";
import { pinNativeRoot } from "./provider-native-history-host.mjs";
import { decodeSqliteCell, readTypedSqliteRows } from "./native-sqlite-values.mjs";
import { parseCodexSourceJson } from "./codex-source-json.mjs";
import { resolveCodexPhysicalLineage, isCodexPaginatedCreationVersion } from "./codex-physical-lineage.mjs";
import { SNAPSHOT_STORAGE_LIMITS } from "./snapshot-storage-codec.mjs";
import { CODEX_NATIVE_MAX_FRAME_BYTES } from "./codex-native-rollout.mjs";
import { derivedHash as hash, derivedFail as fail } from "./claude-derived-encoder.mjs";

const profile = codexNativePortabilityProfile();
const observations = new WeakMap();
function observationDigest(value) {
  const digest = crypto.createHash("sha256");
  const visit = item => {
    if (item instanceof Uint8Array) { digest.update("bytes:" + item.byteLength + ":"); digest.update(item); return; }
    if (Array.isArray(item)) { digest.update("array:" + item.length + ":"); for (const child of item) visit(child); return; }
    if (item && typeof item === "object") { const keys = Object.keys(item).sort(); digest.update("object:" + keys.length + ":"); for (const key of keys) { digest.update(JSON.stringify(key)); visit(item[key]); } return; }
    if (item === undefined) { digest.update("undefined:"); return; }
    if (!["string", "number", "boolean"].includes(typeof item) && item !== null) fail("CODEX_LIVE_OBSERVATION_VALUE_UNQUALIFIED");
    digest.update(typeof item + ":" + JSON.stringify(item) + ":");
  };
  visit(value); return digest.digest("hex");
}
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
const filenameId = relative => /-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl$/u.exec(path.posix.basename(relative))?.[1];
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });
const parse = bytes => parseCodexSourceJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
function sourceRelative(root, absolute, inspectPath = true, observedRoot = root) {
  if (typeof absolute !== "string" || !path.isAbsolute(absolute)) fail("CODEX_LIVE_SELECTED_PATH_INVALID");
  if (codexSourcePathKey(absolute) === null) fail("CODEX_LIVE_SELECTED_PATH_UNQUALIFIED");
  const namespaced = value => process.platform === "win32" ? path.toNamespacedPath(value) : value;
  // Both spellings belong to the one home already validated and held by the
  // live guard. Native Windows realpath can expand its 8.3 ancestors while
  // existing state rows retain the caller's spelling. Never resolve an
  // arbitrary selected path to discover additional roots or follow aliases.
  const relatives = new Set();
  for (const spelling of new Set([root, observedRoot])) {
    const relative = path.relative(namespaced(spelling), namespaced(absolute)).split(path.sep).join("/");
    if (!/^(?:sessions|archived_sessions)\/.+\.jsonl$/u.test(relative) || !filenameId(relative)) continue;
    relatives.add(relative);
  }
  if (!relatives.size) fail("CODEX_LIVE_SELECTED_PATH_UNQUALIFIED");
  if (relatives.size !== 1) fail("CODEX_LIVE_PHYSICAL_ID_AMBIGUOUS");
  const [relative] = relatives;
  if (inspectPath) copiedProjectFile(root, relative); return relative;
}
function readRange(root, relative, check, { length = null, expectedIdentity = null, expectedDigest = null, firstFrameOnly = false } = {}) {
  check(); const file = copiedProjectFile(root, relative), before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || expectedIdentity && !equal(identity(before), expectedIdentity)) fail("CODEX_LIVE_ROLLOUT_IDENTITY_CHANGED");
  let count = firstFrameOnly ? Number(before.size < BigInt(CODEX_NATIVE_MAX_FRAME_BYTES + 1) ? before.size : BigInt(CODEX_NATIVE_MAX_FRAME_BYTES + 1)) : length ?? Number(before.size);
  if (!Number.isSafeInteger(count) || count < 1 || count > SNAPSHOT_STORAGE_LIMITS.decodedBytes || BigInt(count) > before.size) fail("CODEX_LIVE_ROLLOUT_RANGE_UNQUALIFIED");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    check(); const opened = fs.fstatSync(fd, { bigint: true });
    if (!equal(identity(opened), identity(before)) || opened.nlink !== 1n) fail("CODEX_LIVE_ROLLOUT_IDENTITY_CHANGED");
    let raw = Buffer.alloc(count);
    const read = destination => {
      let offset = 0;
      while (offset < destination.length) {
        check(); const size = fs.readSync(fd, destination, offset, Math.min(65536, destination.length - offset), offset);
        if (!size) fail("CODEX_LIVE_ROLLOUT_PREFIX_CHANGED"); offset += size;
      }
    };
    if (firstFrameOnly) {
      // Do not read an unknown owner's body while checking its header. Even a
      // chunk read could cross the first LF into an unselected conversation.
      let end = 0;
      while (end < count) {
        if (end % 65536 === 0) check();
        if (fs.readSync(fd, raw, end, 1, end) !== 1) fail("CODEX_LIVE_ROLLOUT_PREFIX_CHANGED");
        if (raw[end++] === 10) break;
      }
      if (!end || raw[end - 1] !== 10) fail("CODEX_LIVE_ROLLOUT_HEADER_UNAVAILABLE");
      raw = raw.subarray(0, end); count = end;
    } else read(raw);
    // Normal append is allowed. Reconcile retained bytes, not global mtime or
    // the unrelated source writer's commits. This is not an adversarial lock.
    const comparison = Buffer.alloc(Math.min(65536, count)); let compared = 0;
    while (compared < count) {
      check(); const size = fs.readSync(fd, comparison, 0, Math.min(comparison.length, count - compared), compared);
      if (!size || !raw.subarray(compared, compared + size).equals(comparison.subarray(0, size))) fail("CODEX_LIVE_ROLLOUT_PREFIX_CHANGED"); compared += size;
    }
    check();
    const named = fs.lstatSync(copiedProjectFile(root, relative), { bigint: true }), after = fs.fstatSync(fd, { bigint: true });
    if (!equal(identity(named), identity(before)) || !equal(identity(after), identity(before)) || named.nlink !== 1n || after.nlink !== 1n
      || named.size < BigInt(count) || after.size < BigInt(count)
      || expectedDigest !== null && hash(raw) !== expectedDigest) fail("CODEX_LIVE_ROLLOUT_PREFIX_CHANGED");
    check(); const canonicalPath = fs.realpathSync(file); check();
    return { raw, relative, canonicalPath, identity: identity(before), sha256: hash(raw) };
  } finally { fs.closeSync(fd); }
}
function header(original) {
  const end = original.raw.indexOf(10);
  if (end < 0 || end > CODEX_NATIVE_MAX_FRAME_BYTES) fail("CODEX_LIVE_ROLLOUT_HEADER_UNAVAILABLE");
  const frame = parse(original.raw.subarray(0, end));
  if (frame?.type !== "session_meta" || !uuid(frame.payload?.id) || !uuid(frame.payload?.session_id)) fail("CODEX_LIVE_ROLLOUT_HEADER_INVALID");
  return frame.payload;
}

// Missing physical dependencies only: current Project location metadata and
// its directly referenced directories, never recursive history discovery.
// Names are observed first; ambiguous candidates have no header/body read.
function projectAncestorLocator(state, projectId, root, check, exactLocations = null, observedRoot = root) {
  let locations = null;
  return rolloutId => {
    if (locations === null) {
      check(); locations = [];
      const candidates = exactLocations ?? readTypedSqliteRows(state, "threads", ["id", "rollout_path"], { where: 'WHERE "project_id" = ?', parameters: [projectId], orderBy: ["id"] })
        .map(row => ({ id: decodeSqliteCell(row[0]), rollout_path: decodeSqliteCell(row[1]) }));
      for (const row of candidates) {
        const threadId = row.id, absolute = row.rollout_path;
        try { locations.push({ threadId, relative: sourceRelative(root, absolute, false, observedRoot) }); }
        catch (error) { if (!["CODEX_LIVE_SELECTED_PATH_INVALID", "CODEX_LIVE_SELECTED_PATH_UNQUALIFIED"].includes(error.code)) throw error; }
      }
    }
    const indexed = locations.filter(row => filenameId(row.relative) === rolloutId), candidates = new Set(indexed.map(row => row.relative));
    // A current exact state path needs no directory enumeration. Multiple
    // paths are an unresolved identity, not a reason to pick the first one.
    if (candidates.size) return { status: candidates.size === 1 ? "located" : "ancestor-physical-location-ambiguous", source: "current-project-state-path", paths: [...candidates], expectedThreadIds: indexed.map(row => row.threadId), directoriesExamined: 0 };
    let directoriesExamined = 0, missingDirectories = 0;
    for (const relative of new Set(locations.map(row => path.posix.dirname(row.relative)))) {
      check(); const directory = copiedProjectFile(root, relative); let handle, pin;
      if (!fs.lstatSync(directory, { throwIfNoEntry: false })) { missingDirectories++; continue; }
      try { pin = pinNativeRoot(directory); check(); handle = fs.opendirSync(directory); }
      catch (error) { if (error.code !== "ENOENT" || error.path !== directory) throw error; missingDirectories++; continue; }
      directoriesExamined++;
      try {
        for (let entry; (entry = handle.readSync()); ) {
          check(); if (filenameId(entry.name) === rolloutId) candidates.add(relative + "/" + entry.name);
        }
        check(); pin.verify();
      } finally { handle.closeSync(); }
    }
    return { status: candidates.size === 1 ? "located" : candidates.size ? "ancestor-physical-location-ambiguous" : "ancestor-not-in-current-project-location-scope",
      source: "current-project-direct-directory-names", paths: [...candidates], directoriesExamined, missingDirectories,
      recursive: false, unrelatedBodiesRead: false, completeNativeInventoryClaimed: false };
  };
}
function historyAddresses(history, original) {
  const rows = new Map(history.tables.map(table => [table.name, table.rows.map(row => Object.fromEntries(table.columns.map((name, index) => [name, decodeSqliteCell(row[index])])))]));
  const projections = rows.get("thread_history_projection_state");
  if (projections.length !== 1) return { status: "projection-watermark-unavailable", addressCoverageComplete: false, canonicalRowContentsEquivalent: false };
  const mark = projections[0];
  if (mark.next_rollout_byte_offset === 0n && mark.next_rollout_ordinal === 0n)
    return { status: "projection-not-started", addressCoverageComplete: false, canonicalRowContentsEquivalent: false, projectedBytes: 0 };
  if (mark.next_rollout_byte_offset > BigInt(original.raw.length) || mark.next_rollout_byte_offset > BigInt(Number.MAX_SAFE_INTEGER)
    || mark.next_rollout_ordinal > BigInt(Number.MAX_SAFE_INTEGER)) fail("CODEX_LIVE_HISTORY_WATERMARK_AHEAD_OF_RAW");
  const end = Number(mark.next_rollout_byte_offset), positions = new Map(), ends = new Map(); let offset = 0, nextOrdinal = null;
  while (offset < end) {
    const newline = original.raw.indexOf(10, offset);
    if (newline < 0 || newline >= end || newline - offset > CODEX_NATIVE_MAX_FRAME_BYTES) fail("CODEX_LIVE_HISTORY_WATERMARK_BOUNDARY_INVALID");
    const frame = parse(original.raw.subarray(offset, newline));
    if (!Number.isSafeInteger(frame.ordinal) || frame.ordinal < 0 || nextOrdinal !== null && frame.ordinal !== nextOrdinal) fail("CODEX_LINEAGE_ORDINAL_MISMATCH");
    positions.set(BigInt(frame.ordinal).toString(), BigInt(offset)); ends.set(BigInt(frame.ordinal).toString(), BigInt(newline + 1));
    nextOrdinal = frame.ordinal + 1; offset = newline + 1;
  }
  if (end === 0 || nextOrdinal !== Number(mark.next_rollout_ordinal)) fail("CODEX_LIVE_HISTORY_WATERMARK_BOUNDARY_INVALID");
  for (const row of rows.get("thread_turns")) {
    if (positions.get(String(row.rollout_ordinal)) !== row.rollout_byte_offset
      || row.rollout_end_ordinal !== null && ends.get(String(row.rollout_end_ordinal)) !== row.rollout_end_byte_offset) fail("CODEX_LIVE_HISTORY_ADDRESS_MISMATCH");
  }
  for (const row of [...rows.get("thread_items"), ...rows.get("thread_realtime_items")]) {
    for (const field of ["rollout_ordinal", "updated_at_ordinal"]) if (row[field] !== undefined && !positions.has(String(row[field]))) fail("CODEX_LIVE_HISTORY_ADDRESS_MISMATCH");
  }
  return { status: "selected-physical-row-addresses-verified", addressCoverageComplete: true,
    canonicalRowContentsEquivalent: false, projectedBytes: end, nextOrdinal, rawOnlyTailBytes: original.raw.length - end,
    scope: "physical leaf only; ancestor history is original cutoff bytes, never current canonical rows filtered by creation ordinal" };
}

// Internal read-only intake. Host selects the exact Project/subset and any
// already-authorized ancestor path inventory. Missing dependencies may use only
// same-Project current location metadata and direct-directory names. Never scan
// the history tree or follow a path embedded in a transcript. In-memory P3,
// not an executable native payload, P2 recovery, publication or import success.
export async function readCodexLiveProjectSource({ home, sourceProjectId, threadIds, ancestorFiles = [], sourceSelectionFile, expectedSourceSelectionDigest,
  sourceProjectRoot, onBoundary = () => {}, ...guardOptions } = {}) {
  if (typeof sourceProjectId !== "string" || !sourceProjectId.trim() || sourceProjectId.trim() !== sourceProjectId
    || threadIds !== undefined && (!Array.isArray(threadIds) || !threadIds.length || new Set(threadIds).size !== threadIds.length || threadIds.some(id => !uuid(id)))
    || !Array.isArray(ancestorFiles)) fail("CODEX_LIVE_PROJECT_SELECTION_INVALID");
  const selectionRequested = [sourceSelectionFile, expectedSourceSelectionDigest, sourceProjectRoot].some(value => value !== undefined);
  const selection = selectionRequested ? readCodexExplicitProjectSelection({ file: sourceSelectionFile, expectedDigest: expectedSourceSelectionDigest,
    home, projectRoot: sourceProjectRoot, projectId: sourceProjectId, signal: guardOptions.signal, assertCurrentAuthority: guardOptions.assertCurrentAuthority }) : null;
  const result = await withLiveCodexReadSnapshots({ ...guardOptions, home }, ({ root, connections, check, evidence }) => {
    const observedRoot = path.resolve(home), state = connections["state_5.sqlite"], historyDb = connections["thread_history_1.sqlite"];
    const inspect = (db, file) => { check(); return inspectCodexNativeDatabase(db, { file, engineVersion: profile.engineVersion, platform: process.platform, architecture: process.arch,
      inspectionScope: "selected-live-read-schema" }); };
    const startedAt = new Date().toISOString(); inspect(state, "state_5.sqlite");
    selection?.check();
    const catalog = selection ? readCodexExplicitProjectCatalog(state, selection) : readCodexProjectCatalog(state, sourceProjectId), selected = threadIds ?? [...catalog.threadIds];
    if (!selected.length || selected.some(id => !catalog.threadIds.includes(id))) fail("CODEX_LIVE_PROJECT_MEMBERSHIP_MISMATCH");
    const stateEvidence = readSelectedCodexStateEvidence(state, selected), records = verifySelectedCodexStateEvidence(stateEvidence, selected);
    const inventory = new Map();
    for (const item of ancestorFiles) {
      if (!item || Object.keys(item).sort().join(",") !== "path,rolloutId" || !uuid(item.rolloutId) || typeof item.path !== "string"
        || sourceRelative(root, path.resolve(root, item.path)) !== item.path || filenameId(item.path) !== item.rolloutId || inventory.has(item.rolloutId)) fail("CODEX_LIVE_ANCESTOR_INVENTORY_INVALID");
      inventory.set(item.rolloutId, item.path);
    }
    const selections = records.map(row => {
      let relative;
      try { relative = sourceRelative(root, row.rollout_path, true, observedRoot); }
      catch (error) {
        if (!["CODEX_LIVE_SELECTED_PATH_INVALID", "CODEX_LIVE_SELECTED_PATH_UNQUALIFIED"].includes(error.code)) throw error;
        return { threadId: row.id, status: "selected-source-unavailable", reasonCode: error.code };
      }
      const rolloutId = filenameId(relative);
      if (inventory.has(rolloutId) && inventory.get(rolloutId) !== relative) fail("CODEX_LIVE_PHYSICAL_ID_AMBIGUOUS");
      inventory.set(rolloutId, relative); return { threadId: row.id, rolloutId, relative,
        ...(selection ? { expectedFileIdentity: selection.document.members.find(member => member.id === row.id).fileIdentity } : {}) };
    });
    const located = selections.filter(row => row.rolloutId);
    if (new Set(located.map(row => row.rolloutId)).size !== located.length) fail("CODEX_LIVE_PHYSICAL_ID_AMBIGUOUS");
    const locateAncestor = projectAncestorLocator(state, sourceProjectId, root, check,
      selection ? selection.document.members.map(member => ({ id: member.id, rollout_path: member.rolloutPath })) : null, observedRoot);
    const explicitPins = new Map();
    for (const member of selection?.document.members ?? []) {
      let relative;
      try { relative = sourceRelative(root, member.rolloutPath, false, observedRoot); }
      catch (error) { if (!["CODEX_LIVE_SELECTED_PATH_INVALID", "CODEX_LIVE_SELECTED_PATH_UNQUALIFIED"].includes(error.code)) throw error; continue; }
      const physicalId = filenameId(relative), pin = { relative, fileIdentity: member.fileIdentity };
      if (explicitPins.has(physicalId) && !equal(explicitPins.get(physicalId), pin)) fail("CODEX_LIVE_PHYSICAL_ID_AMBIGUOUS");
      explicitPins.set(physicalId, pin);
    }
    onBoundary("state-read"); check(); selection?.check();
    inspect(historyDb, "thread_history_1.sqlite");
    const history = located.length ? readSelectedCodexHistory(historyDb, { engineVersion: profile.engineVersion, platform: process.platform, architecture: process.arch,
      threadIds: located.map(row => row.rolloutId), inspectionScope: "selected-live-read-schema" }) : null;
    const conversations = selections.map(selection => {
      const selectedStateEvidence = readSelectedCodexStateEvidence(state, [selection.threadId]);
      const partial = extra => ({ ...selection, status: "selected-source-unavailable", selectedStateEvidence,
        originals: [], retained: [], nativePublicationReady: false, semanticHistoryEquivalent: false, ...extra });
      if (!selection.rolloutId) return partial({ reasonCode: selection.reasonCode });
      const selectedHistory = { ...history, threadIds: [selection.rolloutId], tables: history.tables.map(table => ({ ...table,
        rows: table.rows.filter(row => decodeSqliteCell(row[table.columns.indexOf("thread_id")]) === selection.rolloutId) })) };
      check(); let leaf;
      if (Object.hasOwn(selection, "expectedFileIdentity") && selection.expectedFileIdentity === null) {
        const present = fs.lstatSync(copiedProjectFile(root, selection.relative), { throwIfNoEntry: false });
        return partial({ history: selectedHistory, reasonCode: present ? "CODEX_EXPLICIT_SELECTION_ABSENCE_CHANGED" : "CODEX_LIVE_SELECTED_FILE_NOT_FOUND",
          primarySourceFailure: { code: present ? "CODEX_EXPLICIT_SELECTION_ABSENCE_CHANGED" : "ENOENT", syscall: "lstat" },
          sourceFileObservation: present ? "present-but-not-adopted; new observation required" : "absent-at-observation; no later file adopted" });
      }
      try { leaf = readRange(root, selection.relative, check, { expectedIdentity: selection.expectedFileIdentity ?? null }); }
      catch (error) {
        // Only this exact absent selected file is an ordinary per-row unknown.
        // Permission, source identity, hash and other primary failures survive.
        if (error.code !== "ENOENT" || error.path !== path.join(root, selection.relative)) throw error;
        return partial({ history: selectedHistory, reasonCode: "CODEX_LIVE_SELECTED_FILE_NOT_FOUND", primarySourceFailure: { code: error.code, syscall: error.syscall } });
      }
      const leafHeader = header(leaf);
      if (leafHeader.id !== selection.threadId) fail("CODEX_LIVE_SELECTED_HEADER_MISMATCH");
      const completeEnd = leaf.raw.lastIndexOf(10) + 1;
      const originals = [{ ...leaf, threadId: leafHeader.id, rolloutId: selection.rolloutId, raw: leaf.raw.subarray(0, completeEnd), sha256: hash(leaf.raw.subarray(0, completeEnd)) }];
      const retained = [leaf], seen = new Set([selection.rolloutId]), ancestorDiscovery = [];
      let base = leafHeader.history_base ?? null, unresolvedAncestorId = null, ancestorReason = null;
      const knownLeafProfile = isCodexPaginatedCreationVersion(leafHeader.cli_version) && leafHeader.history_mode === "paginated";
      if (!knownLeafProfile) { ancestorReason = "CODEX_LINEAGE_SOURCE_PROFILE_UNQUALIFIED"; base = null; }
      while (base !== null) {
        if (!uuid(base.thread_id) || !Number.isSafeInteger(base.end_byte_offset) || base.end_byte_offset < 1) fail("CODEX_LINEAGE_BASE_INVALID");
        if (seen.has(base.thread_id)) fail("CODEX_LINEAGE_CYCLE"); seen.add(base.thread_id);
        let relative = inventory.get(base.thread_id), candidateHeader = null, discovery = null;
        if (!relative) {
          discovery = locateAncestor(base.thread_id); ancestorDiscovery.push({ rolloutId: base.thread_id, ...discovery });
          if (discovery.status !== "located") { unresolvedAncestorId = base.thread_id; ancestorReason = discovery.status; break; }
          relative = discovery.paths[0];
        }
        const memberPin = explicitPins.get(base.thread_id);
        if (memberPin?.fileIdentity === null) {
          check(); const present = fs.lstatSync(copiedProjectFile(root, relative), { throwIfNoEntry: false });
          unresolvedAncestorId = base.thread_id;
          ancestorReason = present ? "CODEX_EXPLICIT_SELECTION_ABSENCE_CHANGED" : "explicit-ancestor-file-not-found";
          break;
        }
        if (discovery) {
          try { candidateHeader = readRange(root, relative, check, { firstFrameOnly: true, expectedIdentity: memberPin?.fileIdentity ?? null }); }
          catch (error) {
            if (error.code !== "ENOENT" || error.path !== path.join(root, relative)) throw error;
            unresolvedAncestorId = base.thread_id; ancestorReason = "discovered-ancestor-file-not-found"; break;
          }
          const candidateThreadId = header(candidateHeader).id;
          if (discovery.expectedThreadIds && !discovery.expectedThreadIds.includes(candidateThreadId)) fail("CODEX_LIVE_ANCESTOR_STATE_HEADER_MISMATCH");
          if (!catalog.threadIds.includes(candidateThreadId)) {
            unresolvedAncestorId = base.thread_id; ancestorReason = "ancestor-header-outside-current-project"; break;
          }
        }
        let original;
        try { original = readRange(root, relative, check, { length: base.end_byte_offset, expectedIdentity: memberPin?.fileIdentity ?? candidateHeader?.identity ?? null }); }
        catch (error) {
          if (error.code !== "ENOENT" || error.path !== path.join(root, relative)) throw error;
          unresolvedAncestorId = base.thread_id; ancestorReason = "explicit-ancestor-file-not-found"; break;
        }
        if (candidateHeader && !original.raw.subarray(0, candidateHeader.raw.length).equals(candidateHeader.raw)) fail("CODEX_LIVE_ROLLOUT_PREFIX_CHANGED");
        const meta = header(original);
        retained.push(original); originals.push({ ...original, threadId: meta.id, rolloutId: base.thread_id }); base = meta.history_base ?? null;
      }
      let proof = null;
      if (unresolvedAncestorId === null && knownLeafProfile) {
        try { proof = resolveCodexPhysicalLineage({ originals, rolloutId: selection.rolloutId, check }); }
        catch (error) { if (error.code !== "CODEX_LINEAGE_SOURCE_PROFILE_UNQUALIFIED") throw error; ancestorReason = error.code; }
      }
      const addresses = knownLeafProfile ? historyAddresses(selectedHistory, leaf)
        : { status: "not-checked-source-profile-unqualified", addressCoverageComplete: false, canonicalRowContentsEquivalent: false };
      const stateRecord = records.find(row => row.id === selection.threadId);
      return { ...selection, status: "selected-live-originals-observed", selectedStateEvidence, history: selectedHistory,
        selectedStateHeaderAgreement: stateRecord.cli_version === leafHeader.cli_version && stateRecord.history_mode === leafHeader.history_mode,
        stateHeaderAgreement: { cliVersion: stateRecord.cli_version === leafHeader.cli_version, historyMode: stateRecord.history_mode === leafHeader.history_mode,
          recordedValuesPreserved: true },
        originals, retained, lineage: proof ? { status: proof.status, rootSessionId: proof.rootSessionId, segments: proof.segments, ancestorDiscovery } : { status: ancestorReason, unresolvedAncestorId, ancestorDiscovery },
        historyCoverage: addresses, incompleteTail: { bytes: leaf.raw.length - completeEnd, sha256: hash(leaf.raw.subarray(completeEnd)), raw: leaf.raw.subarray(completeEnd) },
        semanticHistoryEquivalent: false, nativePublicationReady: false };
    });
    onBoundary("raw-read"); check(); selection?.check();
    // Bounded final reconciliation tolerates append. A selected prefix rewrite
    // is a source conflict, not a retry or an invitation to broaden selection.
    for (const conversation of conversations) for (const original of conversation.retained)
      readRange(root, original.relative, check, { length: original.raw.length, expectedIdentity: original.identity, expectedDigest: original.sha256 });
    return { kind: "CodexLiveProjectSourceObservation", schemaVersion: 1, authorityPlane: "P3", sourceProjectId, sourceRoot: root,
      sourceProjectNamespace: selection ? "caller-project-reference-not-native-membership" : "codex-native-project",
      appMembershipVerifiedByCore: false, selectionIsPermission: false,
      catalog, stateEvidence, conversations: conversations.map(({ retained, ...conversation }) => conversation),
      sourceCoverage: { selectedConversations: conversations.length, rawRetainedConversations: conversations.filter(row => row.originals.length > 0).length,
        unavailableConversations: conversations.filter(row => row.status === "selected-source-unavailable").length,
        unresolvedLineageConversations: conversations.filter(row => row.lineage && row.lineage.status !== "physical-lineage-ranges-verified").length,
        semanticHistoryEquivalent: false, completeNativeInventoryClaimed: false,
        databaseValidation: "exact-schema-and-selected-typed-rows-plus-raw-addresses", wholeDatabaseIntegrity: "not-observed" },
      snapshots: { state: "independent-state-read-transaction", history: "independent-history-read-transaction", startedAt,
        observedAt: new Date().toISOString(), globalAtomicSnapshotClaimed: false },
      evidence, currentAfterSnapshotRelease: "not-observed", allNativeHistoryObserved: false,
      nativePublicationAttempted: false, grantsRecoveryAuthority: false, restoresExecutionPermission: false };
  });
  if (result.status !== "live-source-components-observed") return result;
  const observation = { ...result, status: "live-project-source-observed", sourceBytesPersisted: false, nativePublicationAttempted: false };
  observations.set(observation, observationDigest(observation)); return observation;
}

// Provenance of this already-closed in-memory read only. A saved JSON object is
// not a read capability, current permission, source currentness or P2 direction.
export function verifyCodexLiveProjectObservation(observation) {
  const expected = observations.get(observation);
  if (!expected || observationDigest(observation) !== expected) fail("CODEX_LIVE_OBSERVATION_CHANGED_OR_NOT_CURRENT_INTAKE");
  return observation.value;
}

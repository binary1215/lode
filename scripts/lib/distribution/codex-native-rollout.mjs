import { inspectCopiedProjectFile } from "../storage/project-copy-evidence.mjs";
import { decodeSqliteCell } from "../core/native-sqlite-values.mjs";
import { codexNativePortabilityProfile, verifySelectedCodexHistory } from "./codex-native-portability.mjs";
import { failCode as fail } from "../core/errors.mjs";

const profile = codexNativePortabilityProfile();
// This is a bounded decoder limit, not a Context or P2 budget. Oversize input
// remains preservable as raw evidence; this measured native profile cannot
// certify it for publication without an expanded decoder.
export const CODEX_NATIVE_MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_FRAME_BYTES = CODEX_NATIVE_MAX_FRAME_BYTES;
const decoderLimitErrors = new WeakSet();
function decoderLimit() {
  const error = Object.assign(new Error("NATIVE_CODEX_FRAME_TOO_LARGE"), {
    code: "NATIVE_CODEX_FRAME_TOO_LARGE",
  });
  decoderLimitErrors.add(error);
  throw error;
}
const nonnegative = (value) => typeof value === "bigint" && value >= 0n;

function selectedRows(history, threadId) {
  verifySelectedCodexHistory(history);
  if (!history.threadIds.includes(threadId)) fail("NATIVE_CODEX_THREAD_SELECTION_INVALID");
  return new Map(
    history.tables.map((table) => [
      table.name,
      table.rows
        .map((row) => Object.fromEntries(table.columns.map((column, index) => [column, decodeSqliteCell(row[index])])))
        .filter((row) => row.thread_id === threadId),
    ]),
  );
}

// Pure streamed format/cutoff verification. It does not infer semantic history,
// stopped writers, API registration, current policy or recovery direction.
export function createCodexRolloutVerifier({ threadId, history }) {
  const rows = selectedRows(history, threadId);
  const starts = new Map(),
    ends = new Map(),
    requiredOrdinals = new Set();
  const requireOrdinal = (value) => {
    if (!nonnegative(value)) fail("NATIVE_CODEX_HISTORY_OFFSET_INVALID");
    requiredOrdinals.add(value.toString());
  };
  const address = (map, ordinal, offset) => {
    requireOrdinal(ordinal);
    if (!nonnegative(offset)) fail("NATIVE_CODEX_HISTORY_OFFSET_INVALID");
    const key = ordinal.toString(),
      existing = map.get(key);
    if (existing !== undefined && existing !== offset) fail("NATIVE_CODEX_CUTOFF_MISMATCH");
    map.set(key, offset);
  };
  for (const row of rows.get("thread_turns")) {
    address(starts, row.rollout_ordinal, row.rollout_byte_offset);
    if (row.rollout_end_ordinal !== null || row.rollout_end_byte_offset !== null) address(ends, row.rollout_end_ordinal, row.rollout_end_byte_offset);
  }
  for (const row of [...rows.get("thread_items"), ...rows.get("thread_realtime_items")]) {
    requireOrdinal(row.rollout_ordinal);
    if (row.updated_at_ordinal !== undefined) requireOrdinal(row.updated_at_ordinal);
  }
  const projections = rows.get("thread_history_projection_state");
  if (projections.length !== 1) fail("NATIVE_CODEX_CUTOFF_UNAVAILABLE");
  const projection = projections[0];
  if (!nonnegative(projection.next_rollout_byte_offset) || !nonnegative(projection.next_rollout_ordinal)) fail("NATIVE_CODEX_HISTORY_OFFSET_INVALID");
  let pending = [],
    pendingBytes = 0,
    consumed = 0n,
    ordinal = 0n,
    finished = false;
  let historyMode = null;
  const unresolvedClosure = new Set();
  const frame = (bytes) => {
    if (!bytes.length) fail("NATIVE_CODEX_ROLLOUT_FRAME_INVALID");
    let document;
    try {
      document = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
    } catch {
      fail("NATIVE_CODEX_ROLLOUT_FRAME_INVALID");
    }
    if (
      !document ||
      typeof document !== "object" ||
      Array.isArray(document) ||
      !Number.isSafeInteger(document.ordinal) ||
      document.ordinal < 0 ||
      BigInt(document.ordinal) !== ordinal ||
      typeof document.type !== "string"
    )
      fail("NATIVE_CODEX_ROLLOUT_FRAME_INVALID");
    if (ordinal === 0n) {
      if (
        document.type !== "session_meta" ||
        document.payload?.session_id !== threadId ||
        document.payload?.id !== threadId ||
        document.payload?.cli_version !== profile.engineVersion
      )
        fail("NATIVE_CODEX_ROLLOUT_IDENTITY_MISMATCH");
      historyMode = document.payload.history_mode;
      if (historyMode !== "paginated") fail("NATIVE_CODEX_ROLLOUT_PROFILE_UNSUPPORTED");
    }
    for (const key of ["forked_from_id", "forked_from", "parent_thread_id", "history_base", "history_base_path"])
      if (document.payload?.[key] != null) unresolvedClosure.add(key);
    if (starts.has(ordinal.toString()) && starts.get(ordinal.toString()) !== consumed) fail("NATIVE_CODEX_CUTOFF_MISMATCH");
    consumed += BigInt(bytes.length + 1);
    if (ends.has(ordinal.toString()) && ends.get(ordinal.toString()) !== consumed) fail("NATIVE_CODEX_CUTOFF_MISMATCH");
    requiredOrdinals.delete(ordinal.toString());
    ordinal++;
  };
  return {
    update(chunk) {
      if (finished || !(chunk instanceof Uint8Array)) fail("NATIVE_CODEX_ROLLOUT_STREAM_INVALID");
      let start = 0;
      for (let index = 0; index < chunk.length; index++)
        if (chunk[index] === 10) {
          const piece = chunk.subarray(start, index);
          if (pendingBytes + piece.length > MAX_FRAME_BYTES) decoderLimit();
          pending.push(Buffer.from(piece));
          frame(Buffer.concat(pending, pendingBytes + piece.length));
          pending = [];
          pendingBytes = 0;
          start = index + 1;
        }
      if (start < chunk.length) {
        const piece = chunk.subarray(start);
        pendingBytes += piece.length;
        if (pendingBytes > MAX_FRAME_BYTES) decoderLimit();
        pending.push(Buffer.from(piece));
      }
    },
    finish() {
      if (finished) fail("NATIVE_CODEX_ROLLOUT_STREAM_INVALID");
      finished = true;
      if (pendingBytes || ordinal === 0n) fail("NATIVE_CODEX_ROLLOUT_INCOMPLETE");
      if (requiredOrdinals.size || projection.next_rollout_byte_offset !== consumed || projection.next_rollout_ordinal !== ordinal)
        fail("NATIVE_CODEX_CUTOFF_MISMATCH");
      const turnIds = new Set(rows.get("thread_turns").map((row) => row.turn_id));
      if (rows.get("thread_turns").some((row) => row.root_turn_id !== null && !turnIds.has(row.root_turn_id))) unresolvedClosure.add("root_turn_id");
      return {
        profileId: profile.profileId,
        threadId,
        bytes: consumed.toString(),
        frameCount: ordinal.toString(),
        historyMode,
        cutoff: "selected-row-addresses-match-raw-boundaries",
        unresolvedClosure: [...unresolvedClosure].sort(),
        formatAndAddressReady: unresolvedClosure.size === 0,
        nativePublicationReady: false,
        quiescence: "not-observed",
        nativeWriteAuthorized: false,
        authorityPlane: "P3",
        grantsRecoveryAuthority: false,
      };
    },
  };
}

export function verifyCodexRollout({ root, relative, threadId, history, signal, assertCurrentAuthority }) {
  if (typeof relative !== "string" || !/^(?:sessions|archived_sessions)\/.+\.jsonl$/.test(relative)) fail("NATIVE_CODEX_ROLLOUT_PROFILE_UNSUPPORTED");
  const verifier = createCodexRolloutVerifier({ threadId, history });
  const raw = inspectCopiedProjectFile(root, relative, {
    signal,
    assertCurrentAuthority,
    onChunk: (chunk) => verifier.update(chunk),
  });
  return { ...verifier.finish(), raw };
}

// Preserve exact bytes when this decoder alone reaches its measured frame
// limit. All other errors (including permission, identity, malformed input and
// cutoff mismatch) retain their primary failure. A branded decoder error is
// required: a Host callback cannot be mistaken for a resource-limit fallback.
export function inspectCodexRolloutOriginal({ root, relative, threadId, history, signal, assertCurrentAuthority } = {}) {
  const verifier = createCodexRolloutVerifier({ threadId, history });
  try {
    const raw = inspectCopiedProjectFile(root, relative, {
      signal,
      assertCurrentAuthority,
      onChunk: (chunk) => verifier.update(chunk),
    });
    return { ...verifier.finish(), raw };
  } catch (error) {
    if (error.code !== "NATIVE_CODEX_FRAME_TOO_LARGE" || !decoderLimitErrors.has(error)) throw error;
    let lastByte = null;
    const raw = inspectCopiedProjectFile(root, relative, {
      signal,
      assertCurrentAuthority,
      onChunk: (chunk) => {
        if (chunk.length) lastByte = chunk[chunk.length - 1];
      },
    });
    if (lastByte !== 10) fail("NATIVE_CODEX_ROLLOUT_INCOMPLETE");
    const table = history.tables.find((item) => item.name === "thread_history_projection_state");
    const projections = table.rows
      .map((row) => Object.fromEntries(table.columns.map((key, index) => [key, decodeSqliteCell(row[index])])))
      .filter((row) => row.thread_id === threadId);
    if (projections.length !== 1 || projections[0].next_rollout_byte_offset !== BigInt(raw.bytes)) fail("NATIVE_CODEX_CUTOFF_MISMATCH");
    return {
      profileId: profile.profileId,
      threadId,
      raw,
      bytes: String(raw.bytes),
      formatAndAddressReady: false,
      cutoff: "raw-byte-length-matches-selected-cutoff; remaining-frame-boundaries-unverified",
      unresolvedClosure: ["frame-decoder-limit", "following-frame-boundaries-unverified", "following-native-dependencies-unverified"],
      nativePublicationReady: false,
      nativeWriteAuthorized: false,
      authorityPlane: "P3",
      grantsRecoveryAuthority: false,
    };
  }
}

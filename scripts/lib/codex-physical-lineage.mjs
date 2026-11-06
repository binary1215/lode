import crypto from "node:crypto";
import { codexNativePortabilityProfile } from "./codex-native-portability.mjs";
import { CODEX_NATIVE_MAX_FRAME_BYTES } from "./codex-native-rollout.mjs";

const profile = codexNativePortabilityProfile();
// Qualified historical creation metadata for the same paginated protocol.
// This does not relax the current SQLite engine/schema or destination pins.
export const CODEX_PAGINATED_CREATION_VERSIONS = Object.freeze([
  "0.158.0-alpha.2.1", "0.159.2", "0.160.0", "0.163.0-alpha.10.2", "0.165.0-alpha.1.2", profile.engineVersion,
]);
export const isCodexPaginatedCreationVersion = version => CODEX_PAGINATED_CREATION_VERSIONS.includes(version);
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const hash = raw => crypto.createHash("sha256").update(raw).digest("hex");
const fail = code => { throw Object.assign(new Error(code), { code }); };

// Pinned physical-format inspection, not semantic history/model-context
// reconstruction. No filesystem lookup, provider launch, source mutation or P2.
// A physical rollout ID is independently supplied from the captured filename;
// it is deliberately NOT required to equal the stable header thread ID.
function physical(original, check, cutoff) {
  check();
  if (original.compressed) fail("CODEX_LINEAGE_COMPRESSION_UNQUALIFIED");
  if (!uuid(original.rolloutId) || !uuid(original.threadId) || !(original.raw instanceof Uint8Array))
    fail("CODEX_LINEAGE_ORIGINAL_INVALID");
  const fullRaw = Buffer.from(original.raw.buffer, original.raw.byteOffset, original.raw.byteLength), digest = hash(fullRaw);
  if (original.sha256 !== digest) fail("CODEX_LINEAGE_ORIGINAL_DIGEST_MISMATCH");
  const firstEnd = fullRaw.indexOf(10);
  if (firstEnd < 0) fail("CODEX_LINEAGE_INCOMPLETE_JSONL");
  if (firstEnd > CODEX_NATIVE_MAX_FRAME_BYTES) fail("CODEX_LINEAGE_FRAME_UNQUALIFIED");
  let first;
  try { first = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fullRaw.subarray(0, firstEnd))); }
  catch { fail("CODEX_LINEAGE_FRAME_INVALID"); }
  if (cutoff && cutoff.end_byte_offset > fullRaw.length) fail("CODEX_LINEAGE_CUTOFF_OUT_OF_BOUNDS");
  const raw = cutoff ? fullRaw.subarray(0, cutoff.end_byte_offset) : fullRaw;
  const frames = [], byOrdinal = new Map();
  let offset = 0;
  while (offset < raw.length) {
    check();
    const end = raw.indexOf(10, offset);
    if (end < 0) fail(cutoff ? "CODEX_LINEAGE_CUTOFF_MISMATCH" : "CODEX_LINEAGE_INCOMPLETE_JSONL");
    if (end - offset > CODEX_NATIVE_MAX_FRAME_BYTES) fail("CODEX_LINEAGE_FRAME_UNQUALIFIED");
    let document;
    try { document = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw.subarray(offset, end))); }
    catch { fail("CODEX_LINEAGE_FRAME_INVALID"); }
    if (!document || !integer(document.ordinal) || typeof document.type !== "string") fail("CODEX_LINEAGE_FRAME_INVALID");
    if (frames.length && document.ordinal !== frames.at(-1).document.ordinal + 1) fail("CODEX_LINEAGE_ORDINAL_MISMATCH");
    const frame = { document, startByteOffset: offset, endByteOffset: end + 1 };
    frames.push(frame); byOrdinal.set(document.ordinal, frame); offset = end + 1;
  }
  const header = first?.payload;
  if (first?.type !== "session_meta" || !integer(first.ordinal) || header?.id !== original.threadId || !uuid(header.session_id)) fail("CODEX_LINEAGE_HEADER_MISMATCH");
  if (!isCodexPaginatedCreationVersion(header.cli_version) || header.history_mode !== "paginated") fail("CODEX_LINEAGE_SOURCE_PROFILE_UNQUALIFIED");
  const base = header.history_base ?? null;
  if (base !== null && (!base || typeof base !== "object" || Array.isArray(base)
    || Object.keys(base).sort().join(",") !== "end_byte_offset,end_ordinal_exclusive,thread_id"
    || !uuid(base.thread_id) || !integer(base.end_byte_offset) || !integer(base.end_ordinal_exclusive)))
    fail("CODEX_LINEAGE_BASE_INVALID");
  if (first.ordinal !== (base?.end_ordinal_exclusive ?? 0)) fail("CODEX_LINEAGE_ORDINAL_MISMATCH");
  for (const key of ["forked_from_id", "parent_thread_id"]) if (header[key] != null && !uuid(header[key])) fail("CODEX_LINEAGE_HEADER_MISMATCH");
  if (header.forked_from_ordinal_exclusive != null && !integer(header.forked_from_ordinal_exclusive)) fail("CODEX_LINEAGE_LOGICAL_BOUNDARY_INVALID");
  const local = header.subagent_history_start_ordinal ?? null;
  const nextOrdinal = frames.length ? frames.at(-1).document.ordinal + 1 : first.ordinal;
  if (local !== null && (!integer(local) || local < first.ordinal + 1 || (!cutoff && local > nextOrdinal))) fail("CODEX_LINEAGE_SUBAGENT_BOUNDARY_INVALID");
  return { original, raw, fullRaw, digest, frames, byOrdinal, header, base, initialOrdinal: first.ordinal, nextOrdinal };
}

// Originals are explicit already-captured byte objects, never paths supplied by
// a transcript. Resolve only the selected dependency chain, not its siblings.
// Source: openai/codex f79b26ccbb3116b052544666a181012fb45dc49b,
// protocol HistoryPosition/SessionMeta and rollout_lineage_tests.rs helpers.
export function resolveCodexPhysicalLineage({ originals, rolloutId, check = () => {} } = {}) {
  if (!Array.isArray(originals) || !uuid(rolloutId) || typeof check !== "function") fail("CODEX_LINEAGE_SELECTION_INVALID");
  const index = new Map();
  for (const original of originals) {
    if (!original || !uuid(original.rolloutId)) fail("CODEX_LINEAGE_ORIGINAL_INVALID");
    const matches = index.get(original.rolloutId) || []; matches.push(original); index.set(original.rolloutId, matches);
  }
  const chain = [], seen = new Set();
  let selected = rolloutId, cutoff = null, rootSessionId = null;
  for (;;) {
    check();
    if (seen.has(selected)) fail("CODEX_LINEAGE_CYCLE");
    seen.add(selected);
    const matches = index.get(selected);
    if (!matches?.length) fail("CODEX_LINEAGE_ANCESTOR_MISSING");
    if (matches.length !== 1) fail("CODEX_LINEAGE_PHYSICAL_ID_AMBIGUOUS");
    const parsed = physical(matches[0], check, cutoff);
    if (rootSessionId === null) rootSessionId = parsed.header.session_id;
    const child = chain.at(-1)?.parsed;
    if (child && parsed.header.session_id !== child.header.session_id) {
      // A user fork starts a new logical root while retaining an exact parent
      // prefix. A same-thread physical generation cannot reset that root.
      // Require the explicit logical parent and ordinal boundary to agree with
      // both the child base and the actual captured parent header.
      if (child.header.id === parsed.header.id || child.header.session_id !== child.header.id
        || child.header.forked_from_id !== parsed.header.id
        || child.header.forked_from_ordinal_exclusive !== child.base.end_ordinal_exclusive)
        fail("CODEX_LINEAGE_ROOT_SESSION_MISMATCH");
    }
    const endOrdinal = cutoff?.end_ordinal_exclusive ?? parsed.nextOrdinal;
    const endByteOffset = cutoff?.end_byte_offset ?? parsed.raw.length;
    if (endOrdinal < parsed.initialOrdinal || endOrdinal > parsed.nextOrdinal || endByteOffset > parsed.raw.length)
      fail("CODEX_LINEAGE_CUTOFF_OUT_OF_BOUNDS");
    const expectedBytes = endOrdinal === parsed.initialOrdinal ? 0 : parsed.byOrdinal.get(endOrdinal - 1)?.endByteOffset;
    if (expectedBytes === undefined || expectedBytes !== endByteOffset) fail("CODEX_LINEAGE_CUTOFF_MISMATCH");
    chain.push({ parsed, endOrdinal, endByteOffset });
    if (!parsed.base) break;
    selected = parsed.base.thread_id; cutoff = parsed.base;
  }
  chain.reverse();
  const segments = [], frames = [];
  for (const { parsed, endOrdinal, endByteOffset } of chain) {
    const header = parsed.header, inheritedEnd = header.subagent_history_start_ordinal ?? null;
    segments.push({ rolloutId: parsed.original.rolloutId, threadId: header.id, rootSessionId: header.session_id, creationCliVersion: header.cli_version,
      sourceSha256: parsed.digest, startOrdinal: parsed.initialOrdinal, endOrdinalExclusive: endOrdinal,
      selectedPrefixSha256: hash(parsed.raw), capturedBytes: parsed.fullRaw.length,
      startByteOffset: 0, endByteOffset,
      logicalParentId: header.forked_from_id ?? null, logicalForkOrdinalExclusive: header.forked_from_ordinal_exclusive ?? null,
      copiedSubagentPrefixEndOrdinal: inheritedEnd });
    for (const frame of parsed.frames) {
      if (frame.document.ordinal >= endOrdinal) break;
      if (frame.document.type === "session_meta") continue;
      frames.push({ source: { rolloutId: parsed.original.rolloutId, threadId: header.id,
        ordinal: frame.document.ordinal, startByteOffset: frame.startByteOffset, endByteOffset: frame.endByteOffset,
        origin: inheritedEnd !== null && frame.document.ordinal < inheritedEnd ? "copied-inherited-prefix" : "physical-segment" },
        document: frame.document });
    }
  }
  // No await/caller callback follows the last original-byte reconciliation.
  check();
  for (const { parsed } of chain) if (hash(parsed.fullRaw) !== parsed.digest) fail("CODEX_LINEAGE_ORIGINAL_CHANGED");
  return { status: "physical-lineage-ranges-verified", authorityPlane: "P4", rootSessionId, segments, frames,
    semanticHistoryReconstructed: false, modelContextEquivalent: false, historyPageEquivalent: false,
    sourceAuthority: "historical-P3-only", grantsRecoveryAuthority: false, grantsExecutionPermission: false,
    sourceFormatBasis: "pinned-public-source; synthetic qualification is not actual-native-runtime evidence" };
}

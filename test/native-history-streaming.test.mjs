import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { readCodexZstdPrefix, verifyCodexZstdPrefixObservation } from "../scripts/lib/codex-zstd-prefix.mjs";
import { captureHistoryPrefix, historyHash, historyView, historyLines, encodeHistoryLines, releaseHistoryBytes,
  readHistoryRaw, createHistoryArtifact, historyEquals, isHistoryBytes, HISTORY_IO_BYTES, HISTORY_FRAME_BYTES } from "../scripts/lib/native-history-bytes.mjs";
import { resolveCodexPhysicalLineage } from "../scripts/lib/codex-physical-lineage.mjs";
import { captureCodexPhysicalSourceFiles, inspectCodexCapturedPhysicalSource } from "../scripts/lib/codex-captured-physical-source.mjs";
import { readCodexHybridPhysical, encodeCodexHybrid } from "../scripts/lib/codex-claude-hybrid.mjs";
import { inspectClaudeHistoryOriginal } from "../scripts/lib/provider-native-history-format.mjs";

const id = "01900000-0000-7000-8000-000000000071", leaf = "01900000-0000-7000-8000-000000000072";
const target = "01900000-0000-7000-8000-000000000073";
function progress(stage, extra = {}) { if (process.env.LODE_STREAM_TEST_PROGRESS) fs.appendFileSync(process.env.LODE_STREAM_TEST_PROGRESS,
  JSON.stringify({ stage, ...extra, memory: process.memoryUsage() }) + "\n"); }
function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "lode-stream-test-"));
  const owner = fs.lstatSync(root), expected = fs.realpathSync(root); progress("fixture-created", { root });
  t.after(() => { const current = fs.lstatSync(root);
    assert.ok(current.isDirectory() && !current.isSymbolicLink() && current.dev === owner.dev && current.ino === owner.ino);
    assert.equal(fs.realpathSync(root), expected); fs.rmSync(root, { recursive: true }); }); return root; }
const line = (ordinal, type, payload) => Buffer.from(JSON.stringify({ ordinal, type, payload }) + "\n");
const meta = (version, base = null) => ({ id, session_id: id, cli_version: version, history_mode: "paginated", history_base: base });
const proof = (raw, rolloutId = id) => resolveCodexPhysicalLineage({ originals: [{ rolloutId, threadId: id, raw, sha256: historyHash(raw) }], rolloutId });

test("streamed capture freezes a finite prefix, bounds allocation and rejects changed originals without touching the source", t => {
  const root = fixture(t), file = path.join(root, "source.jsonl"), frame = Buffer.from("x".repeat(HISTORY_IO_BYTES - 1) + "\n");
  const fd = fs.openSync(file, "wx+"); t.after(() => fs.closeSync(fd));
  for (let i = 0; i < 18; i++) fs.writeSync(fd, frame);
  const length = fs.fstatSync(fd).size, captured = captureHistoryPrefix(fd, length);
  try {
    assert.ok(isHistoryBytes(captured.raw)); assert.equal(captured.raw.length, length);
    fs.writeSync(fd, Buffer.from("future\n"));
    assert.equal([...historyLines(captured.raw)].length, 18);
    assert.equal(captured.raw.lastIndexOf(10), length - 1);
    assert.equal(captured.raw.subarray(length - 8).toString(), "xxxxxxx\n");
    assert.equal(captured.raw.toString().length, length); // Below the per-frame decoding limit.
    const destination = path.join(root, "archive.bin"); createHistoryArtifact(destination, captured.raw);
    const archived = readHistoryRaw(root, "archive.bin").raw;
    assert.equal(historyHash(archived), historyHash(captured.raw));
    assert.throws(() => createHistoryArtifact(destination, Buffer.from("overwrite")), { code: "EEXIST" });
    assert.equal(fs.readdirSync(root).filter(name => name.endsWith(".tmp")).length, 0);
    fs.writeFileSync(destination, "tampered");
    assert.throws(() => historyHash(archived), { code: "NATIVE_HISTORY_BYTES_CHANGED" });
    assert.equal(fs.fstatSync(fd).size, length + 7);
  } finally { captured.release(); }
  assert.throws(() => historyHash(captured.raw), { code: "ENOENT" });
});

test("both historical creation profiles require exact paginated shape, ordinals, digests and cutoff agreement", t => {
  for (const version of ["0.148.0-alpha.15", "0.149.0-alpha.4.3", "0.153.4"]) {
    const raw = Buffer.concat([line(0, "session_meta", meta(version)), line(1, "event_msg", { type: "task_complete", turn_id: "turn" })]);
    assert.equal(proof(raw).segments[0].creationCliVersion, version);
    assert.throws(() => proof(Buffer.concat([line(0, "session_meta", { ...meta(version), history_mode: "legacy" }), line(1, "event_msg", {})])), { code: "CODEX_LINEAGE_SOURCE_PROFILE_UNQUALIFIED" });
    assert.throws(() => proof(Buffer.concat([line(0, "session_meta", meta(version)), line(2, "event_msg", {})])), { code: "CODEX_LINEAGE_ORDINAL_MISMATCH" });
    assert.throws(() => proof(raw.subarray(0, raw.length - 1)), { code: "CODEX_LINEAGE_INCOMPLETE_JSONL" });
    assert.throws(() => resolveCodexPhysicalLineage({ originals: [{ rolloutId: id, threadId: id, raw, sha256: "0".repeat(64) }], rolloutId: id }), { code: "CODEX_LINEAGE_ORIGINAL_DIGEST_MISMATCH" });
  }
  assert.throws(() => proof(line(0, "session_meta", meta("0.1.unknown"))), { code: "CODEX_LINEAGE_SOURCE_PROFILE_UNQUALIFIED" });
});

test("partial/zero writes and mid-capture denial terminate and remove only owned scratch", t => {
  const root = fixture(t), source = path.join(root, "source.bin"), fd = fs.openSync(source, "wx+");
  const original = Buffer.from("selected original"); fs.writeSync(fd, original); t.after(() => fs.closeSync(fd));
  const before = new Set(fs.readdirSync(os.tmpdir()).filter(n => n.startsWith("lode-history-"))), realWrite = fs.writeSync;
  let writes = 0;
  try {
    fs.writeSync = (output, bytes, offset, length, ...rest) => {
      if (output === fd) return realWrite(output, bytes, offset, length, ...rest);
      writes++; return writes === 1 ? realWrite(output, bytes, offset, Math.min(3, length), ...rest) : 0;
    };
    assert.throws(() => captureHistoryPrefix(fd, original.length), { code: "NATIVE_HISTORY_WRITE_INCOMPLETE" });
  } finally { fs.writeSync = realWrite; }
  let checks = 0;
  assert.throws(() => captureHistoryPrefix(fd, original.length, () => ++checks < 3), { code: "NATIVE_HISTORY_AUTHORITY_DENIED" });
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter(n => n.startsWith("lode-history-") && !before.has(n)), []);
  assert.deepEqual(fs.readFileSync(source), original);
});

test("large capture ownership is observable before data writes and stays separate from evidence authority", t => {
  const root=fixture(t),file=path.join(root,"source.bin");fs.writeFileSync(file,"prefix");const fd=fs.openSync(file,"r");
  let observed=null;
  const captured=captureHistoryPrefix(fd,6,()=>{},storage=>{observed=storage;assert.equal(fs.statSync(storage.file).size,0);assert.equal(storage.expectedBytes,6);});
  try{assert.equal(captured.storage.file,observed.file);assert.equal(captured.storage.fileIdentity.ino,String(fs.statSync(observed.file,{bigint:true}).ino));assert.equal(captured.raw.toString(),"prefix");assert.equal(Object.hasOwn(observed,"grantsRecoveryAuthority"),false);}finally{fs.closeSync(fd);captured.release();}
  assert.equal(fs.existsSync(observed.root),false);
});

test("bounded byte equality is symmetric across small/medium file views, and changed staging never publishes", t => {
  const root = fixture(t), raw = Buffer.from("same bytes"), original = path.join(root, "input.bin"); fs.writeFileSync(original, raw);
  const view = historyView(root, "input.bin"); assert.equal(historyEquals(raw, view), true); assert.equal(historyEquals(view, raw), true);
  assert.equal(historyEquals(Buffer.from("different!"), view), false);
  const target = path.join(root, "output.bin"); let replacement = null;
  assert.throws(() => createHistoryArtifact(target, raw, () => {
    const name = fs.readdirSync(root).find(name => name.endsWith(".tmp"));
    if (!replacement && name && fs.statSync(path.join(root, name)).size === raw.length) {
      replacement = path.join(root, name); fs.renameSync(replacement, replacement + ".owned"); fs.writeFileSync(replacement, raw);
    }
  }), { code: "NATIVE_HISTORY_STAGING_CLEANUP_CHANGED" });
  assert.equal(fs.existsSync(target), false); assert.deepEqual(fs.readFileSync(replacement), raw);
  const medium = encodeHistoryLines([{ text: "x".repeat(18 * HISTORY_IO_BYTES) }]);
  try { createHistoryArtifact(path.join(root, "medium.jsonl"), medium);
    const emitted = readHistoryRaw(root, "medium.jsonl").raw;
    assert.equal(historyEquals(emitted.subarray(0, medium.length), medium), true);
  } finally { releaseHistoryBytes(medium); }
});

test("capture and output failures preserve replacement files and the primary permission error", t => {
  const root = fixture(t), source = path.join(root, "source.bin"); fs.writeFileSync(source, "original");
  const fd = fs.openSync(source, "r"); t.after(() => fs.closeSync(fd));
  for (const mode of ["capture", "output"]) {
    const originalOpen = fs.openSync; let temporary = null, directoryOwner = null, swapped = false;
    const authority = () => {
      if (!temporary || swapped) return;
      swapped = true; fs.renameSync(temporary, temporary + ".owned"); fs.writeFileSync(temporary, "replacement-owned-by-someone-else");
      throw Object.assign(new Error("denied"), { code: "NATIVE_HISTORY_AUTHORITY_DENIED" });
    };
    try {
      fs.openSync = (file, flags, ...rest) => {
        const opened = originalOpen(file, flags, ...rest);
        if (typeof file === "string" && path.basename(file) === "prefix.bin" && flags === "wx") {
          temporary = file; directoryOwner = fs.lstatSync(path.dirname(file));
        }
        return opened;
      };
      assert.throws(() => mode === "capture" ? captureHistoryPrefix(fd, 8, authority)
        : encodeHistoryLines([{ text: "x".repeat(9 * HISTORY_IO_BYTES) }, { text: "y".repeat(9 * HISTORY_IO_BYTES) }], authority),
      error => error.code === "NATIVE_HISTORY_AUTHORITY_DENIED" && error.captureCleanup?.code === "NATIVE_HISTORY_CAPTURE_CLEANUP_CHANGED");
      assert.equal(fs.readFileSync(temporary, "utf8"), "replacement-owned-by-someone-else");
    } finally {
      fs.openSync = originalOpen;
      if (temporary) {
        const directory = path.dirname(temporary), resolved = fs.realpathSync(directory), current = fs.lstatSync(directory);
        assert.ok(resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
        assert.equal(current.dev, directoryOwner.dev); assert.equal(current.ino, directoryOwner.ino);
        fs.unlinkSync(temporary); fs.unlinkSync(temporary + ".owned"); fs.rmdirSync(directory);
      }
    }
  }
  assert.equal(fs.readFileSync(source, "utf8"), "original");
});

test("Zstd ancestor decoding retains only the exact prefix and discloses incomplete container verification", async t => {
  const root = fixture(t), prefix = Buffer.concat([line(0, "session_meta", meta("0.153.4")), line(1, "event_msg", { type: "task_started", turn_id: "t" })]);
  const future = line(2, "event_msg", { type: "private-future", text: "unselected".repeat(10000) });
  const compressed = bytes => zlib.zstdCompressSync(bytes, { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } });
  fs.mkdirSync(path.join(root, "sessions"));
  const relative = "sessions/rollout-" + id + ".jsonl.zst";
  for (const bytes of [compressed(Buffer.concat([prefix, future])), Buffer.concat([compressed(prefix), compressed(future)])]) {
    fs.writeFileSync(path.join(root, relative), bytes);
    const decoded = await readCodexZstdPrefix({ root, relative, length: prefix.length });
    try {
      assert.ok(decoded.raw.equals(prefix)); assert.equal(decoded.sha256, historyHash(prefix));
      assert.equal(decoded.compressionEvidence.fullContainerChecksumVerified, false);
      assert.equal(decoded.compressionEvidence.decodedFutureStored, false);
      assert.equal(decoded.compressionEvidence.compressedOriginalStored, false);
      assert.equal(decoded.compressionEvidence.offlineCompressionReproductionClaimed, false);
      assert.throws(() => verifyCodexZstdPrefixObservation({ ...decoded.compressionEvidence, decodedPrefixBytes: -1, decodedPrefixSha256: "x" }, { bytes: -1, sha256: "x" }), { code: "CODEX_ZSTD_PREFIX_EVIDENCE_INVALID" });
      assert.throws(() => verifyCodexZstdPrefixObservation({ ...decoded.compressionEvidence, fullContainerChecksumVerified: true }, { bytes: prefix.length, sha256: decoded.sha256 }), { code: "CODEX_ZSTD_PREFIX_EVIDENCE_INVALID" });
      assert.equal(proof(decoded.raw).segments[0].endOrdinalExclusive, 2);
      assert.equal(fs.readFileSync(path.join(root, relative)).equals(bytes), true);
    } finally { decoded.capture.release(); }
  }
  fs.writeFileSync(path.join(root, relative), compressed(prefix).subarray(0, 10));
  await assert.rejects(readCodexZstdPrefix({ root, relative, length: prefix.length }));
  fs.writeFileSync(path.join(root, relative), Buffer.from("not-a-zstd-stream"));
  await assert.rejects(readCodexZstdPrefix({ root, relative, length: prefix.length }));
  let checks = 0;
  await assert.rejects(readCodexZstdPrefix({ root, relative, length: prefix.length, check() {
    if (++checks >= 2) throw Object.assign(new Error("denied"), { code: "NATIVE_HISTORY_AUTHORITY_DENIED" });
  } }), { code: "NATIVE_HISTORY_AUTHORITY_DENIED" });
});

test("first Zstd scope denial or asynchronous authority performs no source access and no second check", async () => {
  for (const [authority, code] of [[() => false, "NATIVE_HISTORY_AUTHORITY_DENIED"], [() => Promise.resolve(true), "NATIVE_HISTORY_SYNCHRONOUS_AUTHORITY_REQUIRED"]]) {
    let checks = 0;
    await assert.rejects(readCodexZstdPrefix({ root: "does-not-exist", relative: "sessions/none.jsonl.zst", length: 10,
      check() { checks++; return authority(); } }), { code });
    assert.equal(checks, 1);
  }
});

test("underscore physical filenames preserve exact inherited cutoffs and reject unrelated suffix substitution", t => {
  const root = fixture(t), source = path.join(root, "source"); fs.mkdirSync(source);
  const parentRaw = Buffer.concat([line(0, "session_meta", meta("0.153.4")), line(1, "event_msg", { type: "task_started", turn_id: "t" })]);
  const childRaw = line(2, "session_meta", meta("0.163.0-alpha.10.2", { thread_id: id, end_byte_offset: parentRaw.length, end_ordinal_exclusive: 2 }));
  const descriptors = [[id, "rollout-" + id + ".jsonl", parentRaw], [leaf, "rollout-" + id + "_" + leaf + ".jsonl", childRaw]]
    .map(([rolloutId, relative, raw]) => { fs.writeFileSync(path.join(source, relative), raw); return { rolloutId, threadId: id, path: relative, endByteOffset: raw.length, sha256: historyHash(raw) }; });
  const capture = captureCodexPhysicalSourceFiles({ sourceRoot: source, directory: path.join(root, "capture"), threadId: id, rolloutId: leaf, files: descriptors });
  const inspected = inspectCodexCapturedPhysicalSource({ directory: capture.directory });
  assert.equal(inspected.proof.segments.length, 2); assert.equal(inspected.proof.segments[0].endByteOffset, parentRaw.length);
  assert.throws(() => captureCodexPhysicalSourceFiles({ sourceRoot: source, directory: path.join(root, "wrong"), threadId: id, rolloutId: leaf,
    files: descriptors.map(d => d.rolloutId === id ? { ...d, endByteOffset: d.endByteOffset - 1 } : d) }), { code: "CODEX_LINEAGE_CUTOFF_MISMATCH" });
  assert.equal(fs.existsSync(path.join(root, "wrong")), false);
});

test("Claude line output spills without a whole-string allocation and retains byte-identical records", t => {
  const root = fixture(t), text = "한글".repeat(100000), count = 30;
  const records = Array.from({ length: count }, (_, i) => ({ type: "assistant", uuid: "message" + i, parentUuid: i ? "message" + (i - 1) : null,
    sessionId: target, message: { role: "assistant", content: [{ type: "text", text }] } }));
  const raw = encodeHistoryLines(records);
  try {
    assert.ok(isHistoryBytes(raw)); assert.equal([...historyLines(raw)].length, count);
    assert.equal(inspectClaudeHistoryOriginal(raw, target).messageCount, count);
    const output = path.join(root, "conversation.jsonl"); createHistoryArtifact(output, raw);
    assert.equal(readHistoryRaw(root, "conversation.jsonl").entry.sha256, historyHash(raw));
  } finally { releaseHistoryBytes(raw); }
});

test("a source above 512MiB can be captured, reread and hybrid-encoded without raising snapshot or frame limits", { timeout: 600000 }, t => {
  const root = fixture(t), source = path.join(root, "source"); fs.mkdirSync(source);
  const relative = "rollout-" + id + ".jsonl", file = path.join(source, relative), fd = fs.openSync(file, "wx");
  let ordinal = 0;
  try {
    fs.writeSync(fd, line(ordinal++, "session_meta", meta("0.153.4")));
    // Large provider configuration is retained as exact original evidence,
    // never promoted to current instructions or repeated in Claude messages.
    const filler = "x".repeat(16 * HISTORY_IO_BYTES);
    for (let i = 0; i < 33; i++) fs.writeSync(fd, line(ordinal++, "world_state", { full: true, state: { base_instructions: filler } }));
    fs.writeSync(fd, line(ordinal++, "event_msg", { type: "task_started", turn_id: "t" }));
    fs.writeSync(fd, line(ordinal++, "event_msg", { type: "item_completed", thread_id: id, turn_id: "t", item: { id: "user", type: "UserMessage", content: [{ type: "text", text: "Synthetic question" }] } }));
    fs.writeSync(fd, line(ordinal++, "event_msg", { type: "item_completed", thread_id: id, turn_id: "t", item: { id: "assistant", type: "AgentMessage", content: [{ type: "Text", text: "Synthetic answer" }], phase: "final_answer" } }));
    fs.writeSync(fd, line(ordinal++, "event_msg", { type: "task_complete", turn_id: "t" }));
  } finally { fs.closeSync(fd); }
  const view = historyView(source, relative), bytes = view.length, sha256 = historyHash(view);
  assert.ok(bytes > 512 * HISTORY_IO_BYTES);
  assert.throws(() => view.toString(), { code: "NATIVE_HISTORY_WHOLE_STRING_UNQUALIFIED" });
  const captured = captureCodexPhysicalSourceFiles({ sourceRoot: source, directory: path.join(root, "capture"), threadId: id, rolloutId: id,
    files: [{ path: relative, rolloutId: id, threadId: id, endByteOffset: bytes, sha256 }] });
  const native = inspectCodexCapturedPhysicalSource({ directory: captured.directory });
  assert.equal(native.originals[0].raw.length, bytes); assert.ok(isHistoryBytes(native.originals[0].raw));
  const read = readCodexHybridPhysical({ native, threadId: id });
  const encoded = encodeCodexHybrid({ read, targetId: target, cwd: root, createdAt: "2026-11-07T00:00:00.000Z" });
  try {
    assert.equal(encoded.publicationReady, true, JSON.stringify(encoded.diagnostics.filter(d => d.blocksPublication)));
    assert.equal(encoded.hybridCoverage.authored.completeAuthoredMessageCoverage, true);
    assert.equal(encoded.hybridCoverage.sourceRecords, ordinal);
    assert.ok(encoded.raw.length < HISTORY_IO_BYTES);
    assert.equal(HISTORY_FRAME_BYTES, 64 * HISTORY_IO_BYTES);
    assert.equal(historyHash(view), sha256);
  } finally { releaseHistoryBytes(encoded.raw); }
});

test("many authored and tool bodies above 512MiB use lazy source references and streamed Claude output", { timeout: 600000 }, t => {
  const root = fixture(t), source = path.join(root, "source"); fs.mkdirSync(source);
  const relative = "rollout-" + id + ".jsonl", file = path.join(source, relative), fd = fs.openSync(file, "wx");
  const body = "m".repeat(4 * HISTORY_IO_BYTES), result = { content: [{ type: "text", text: body }], isError: false };
  let ordinal = 0;
  const write = (type, payload) => fs.writeSync(fd, line(ordinal++, type, payload));
  try {
    write("session_meta", meta("0.148.0-alpha.15"));
    for (let i = 0; i < 48; i++) {
      const turn = "turn" + i, call = "call" + i;
      write("event_msg", { type: "task_started", turn_id: turn });
      write("event_msg", { type: "item_completed", thread_id: id, turn_id: turn, item: { id: "user" + i, type: "UserMessage", content: [{ type: "text", text: body }] } });
      write("response_item", { type: "function_call", call_id: call, name: "read", namespace: "fixture", arguments: '{"input":"synthetic"}' });
      write("event_msg", { type: "item_completed", thread_id: id, turn_id: turn, item: { id: call, type: "McpToolCall", server: "fixture", tool: "read", arguments: { input: "synthetic" }, status: "completed", result, error: null } });
      write("response_item", { type: "function_call_output", call_id: call, output: JSON.stringify(result), is_error: false });
      write("event_msg", { type: "item_completed", thread_id: id, turn_id: turn, item: { id: "answer" + i, type: "AgentMessage", content: [{ type: "Text", text: "Answer " + i }], phase: "final_answer" } });
      write("event_msg", { type: "task_complete", turn_id: turn });
    }
  } finally { fs.closeSync(fd); }
  const raw = historyView(source, relative), sourceDigest = historyHash(raw);
  progress("many-written", { bytes: raw.length });
  assert.ok(raw.length > 512 * HISTORY_IO_BYTES);
  const sourceProof = resolveCodexPhysicalLineage({ originals: [{ rolloutId: id, threadId: id, raw, sha256: sourceDigest }], rolloutId: id });
  progress("many-proof", { frames: sourceProof.frames.length });
  const native = { payload: { threadIds: [id], selectedRolloutId: id }, originals: [{ rolloutId: id, threadId: id, raw, sha256: sourceDigest }], proof: sourceProof };
  const read = readCodexHybridPhysical({ native, threadId: id });
  progress("many-read", { records: read.records.length, events: read.events.length });
  const encoded = encodeCodexHybrid({ read, targetId: target, cwd: root, createdAt: "2026-11-07T00:00:00.000Z" });
  progress("many-encoded", { bytes: encoded.raw.length });
  try {
    assert.equal(encoded.publicationReady, true, JSON.stringify(encoded.diagnostics.filter(d => d.blocksPublication)));
    assert.equal(encoded.hybridCoverage.authored.completeAuthoredMessageCoverage, true);
    assert.equal(encoded.hybridCoverage.nativeToolRecords, 96);
    assert.ok(encoded.raw.length > 512 * HISTORY_IO_BYTES);
    assert.ok(isHistoryBytes(encoded.raw));
    const destination = path.join(root, "claude.jsonl"); createHistoryArtifact(destination, encoded.raw);
    const reread = readHistoryRaw(root, "claude.jsonl");
    assert.equal(reread.entry.sha256, historyHash(encoded.raw));
    assert.equal(inspectClaudeHistoryOriginal(reread.raw, target).messageCount, encoded.rows.length);
    assert.equal(historyHash(raw), sourceDigest);
    t.diagnostic(JSON.stringify({ sourceBytes: raw.length, claudeBytes: encoded.raw.length, nativeToolRecords: 96,
      maxRssKiB: process.resourceUsage().maxRSS, officialSdkUsed: false, modelCalled: false }));
  } finally { releaseHistoryBytes(encoded.raw); }
});


test("small-frame windows retain exact offsets and fresh full hashes with bounded IO", t => {
  const root = fixture(t), count = 20000, stride = 1024, bytes = Buffer.alloc(count * stride);
  for (let i = 0; i < count; i++) {
    const prefix = '{"ordinal":' + i + ',"padding":"';
    bytes.write(prefix + "x".repeat(stride - prefix.length - 3) + '"}\n', i * stride);
  }
  fs.writeFileSync(path.join(root, "small-frames.jsonl"), bytes, { flag: "wx" });
  const raw = historyView(root, "small-frames.jsonl"), realRead = fs.readSync;
  let reads = 0;
  fs.readSync = function (...args) { reads++; return realRead.apply(this, args); };
  try {
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < count; i++)
      assert.equal(JSON.parse(raw.subarray(i * stride, (i + 1) * stride).toString()).ordinal, i);
    // Many small frames must not each reopen/read a separate byte range.
    assert.ok(reads < count / 100, "small-frame traversal regressed to per-frame disk reads");
    for (const [start, end] of [[0, 0], [0, 1], [-13, undefined], [bytes.length, bytes.length + 1],
      [HISTORY_IO_BYTES - 7, HISTORY_IO_BYTES + 9], [HISTORY_IO_BYTES + 100, HISTORY_IO_BYTES + 200]])
      assert.deepEqual(raw.subarray(start, end), bytes.subarray(start, end));
    const exposed = raw.subarray(20000, 20100); exposed.fill(0);
    assert.deepEqual(raw.subarray(20000, 20100), bytes.subarray(20000, 20100));
    const beforeHash = reads;
    assert.equal(historyHash(raw), historyHash(bytes));
    assert.ok(reads > beforeHash, "full integrity hashes must bypass warmed fragment windows");
  } finally { fs.readSync = realRead; }
});

test("warm fragment windows reject mutation, name replacement and current authority denial", t => {
  const root = fixture(t);
  const changed = path.join(root, "changed.bin"); fs.writeFileSync(changed, Buffer.alloc(4096, 3));
  const raw = historyView(root, "changed.bin"); raw.subarray(5, 50);
  const fd = fs.openSync(changed, "r+");
  try { fs.writeSync(fd, Buffer.from([9]), 0, 1, 7); } finally { fs.closeSync(fd); }
  fs.utimesSync(changed, new Date(), new Date(Date.now() + 5000));
  assert.throws(() => raw.subarray(5, 50), { code: "NATIVE_HISTORY_BYTES_CHANGED" });
  const replaced = path.join(root, "replaced.bin"); fs.writeFileSync(replaced, Buffer.alloc(4096, 4));
  const old = historyView(root, "replaced.bin"); old.subarray(0, 10);
  fs.renameSync(replaced, path.join(root, "old.bin")); fs.writeFileSync(replaced, Buffer.alloc(4096, 4));
  assert.throws(() => old.subarray(0, 10), { code: "NATIVE_HISTORY_BYTES_CHANGED" });
  fs.writeFileSync(path.join(root, "authority.bin"), Buffer.alloc(4096, 5));
  let denied = false, checks = 0;
  const guarded = historyView(root, "authority.bin", () => { checks++; if (denied) throw Object.assign(new Error("denied"), { code: "EACCES" }); });
  guarded.subarray(0, 10); denied = true; const before = checks;
  assert.throws(() => guarded.subarray(0, 10), { code: "EACCES" }); assert.equal(checks, before + 1);
  assert.throws(() => guarded.subarray(0, 10), { code: "EACCES" }); assert.equal(checks, before + 1);
});


test("warm windows pin the directory owner and keep physical metadata failures primary", t => {
  const root = fixture(t), directory = path.join(root, "owned"); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "source.bin"), Buffer.alloc(4096, 1));
  const original = historyView(directory, "source.bin"); original.subarray(0, 10);
  fs.renameSync(directory, path.join(root, "prior")); fs.mkdirSync(directory);
  fs.renameSync(path.join(root, "prior/source.bin"), path.join(directory, "source.bin"));
  assert.throws(() => original.subarray(0, 10), { code: "NATIVE_HISTORY_ROOT_CHANGED" });
  fs.writeFileSync(path.join(root, "linked.bin"), Buffer.alloc(4096, 2));
  const linked = historyView(root, "linked.bin"); linked.subarray(0, 10);
  fs.linkSync(path.join(root, "linked.bin"), path.join(root, "alias.bin"));
  let first;
  try { linked.subarray(0, 10); assert.fail("changed link count must reject"); } catch (error) { first = error; }
  assert.equal(first.code, "NATIVE_HISTORY_BYTES_CHANGED"); fs.unlinkSync(path.join(root, "alias.bin"));
  assert.throws(() => linked.subarray(0, 10), error => error === first);
  fs.writeFileSync(path.join(root, "metadata.bin"), Buffer.alloc(4096, 3));
  const metadata = historyView(root, "metadata.bin"); metadata.subarray(0, 10);
  const stat = fs.lstatSync, denied = Object.assign(new Error("synthetic metadata denial"), { code: "EACCES" });
  fs.lstatSync = function (file, ...args) { if (path.basename(String(file)) === "metadata.bin") throw denied; return stat.call(this, file, ...args); };
  try { assert.throws(() => metadata.subarray(0, 10), error => error === denied); }
  finally { fs.lstatSync = stat; }
  assert.throws(() => metadata.subarray(0, 10), error => error === denied);
  assert.throws(() => historyHash(metadata), error => error === denied);
});


test("sequential source audit preserves exact CRLF and Unicode and excludes unselected rollouts", t => {
  const root = fixture(t);
  const frames = [line(0, "session_meta", meta("0.153.4")), line(1, "event_msg", { type: "task_started", turn_id: "t" }),
    line(2, "event_msg", { type: "item_completed", thread_id: id, turn_id: "t", item: { type: "UserMessage", id: "u", content: [{ type: "text", text: "한글\ufeff😀" }] } }),
    line(3, "event_msg", { type: "item_completed", thread_id: id, turn_id: "t", item: { type: "AgentMessage", id: "a", phase: "final_answer", content: [{ type: "Text", text: "Exact answer" }] } }),
    line(4, "event_msg", { type: "task_complete", turn_id: "t" })];
  const raw = Buffer.from(Buffer.concat(frames).toString().replace(/\n/g, "\r\n"));
  const originals = [{ rolloutId: id, threadId: id, raw, sha256: historyHash(raw) },
    { rolloutId: leaf, threadId: leaf, get raw() { throw new Error("Unselected source must not be read"); } }];
  const native = { payload: { threadIds: [id], selectedRolloutId: id }, originals,
    proof: resolveCodexPhysicalLineage({ originals, rolloutId: id }) };
  const read = readCodexHybridPhysical({ native, threadId: id }), encoded = encodeCodexHybrid({ read, targetId: target, cwd: root, createdAt: "2026-11-07T00:00:00Z" });
  try { assert.equal(encoded.publicationReady, true); assert.equal(encoded.hybridCoverage.sourceRecords, frames.length);
    assert.equal(encoded.rows.find(row => row.type === "user").message.content[0].text, "한글\ufeff😀");
    assert.ok(read.records.every(record => record.source.physicalRolloutId === id));
  } finally { releaseHistoryBytes(encoded.raw); }
});

test("sequential source audit keeps late mutation and scope failure primary without a new permission token", t => {
  const root = fixture(t), raw = Buffer.concat([line(0, "session_meta", meta("0.153.4")),
    line(1, "event_msg", { type: "task_started", turn_id: "t" }),
    line(2, "event_msg", { type: "item_completed", thread_id: id, turn_id: "t", item: { type: "UserMessage", id: "u", content: [{ type: "text", text: "Synthetic bytes" }] } }),
    line(3, "event_msg", { type: "item_completed", thread_id: id, turn_id: "t", item: { type: "AgentMessage", id: "a", content: [{ type: "Text", text: "Done" }], phase: "final_answer" } }),
    line(4, "event_msg", { type: "task_complete", turn_id: "t" })]);
  for (const mode of ["buffer", "file"]) {
    let body = Buffer.from(raw), active = false, checks = 0, changed = false;
    const file = path.join(root, mode + ".jsonl");
    if (mode === "file") { fs.writeFileSync(file, body); fs.utimesSync(file, 1000, 1000); body = historyView(root, mode + ".jsonl"); }
    const originals = [{ rolloutId: id, threadId: id, raw: body, sha256: historyHash(body) }];
    const native = { payload: { threadIds: [id], selectedRolloutId: id }, originals, proof: resolveCodexPhysicalLineage({ originals, rolloutId: id }) };
    let read;
    const scope = () => { if (active && ++checks === read.records.length + 1) {
      changed = true; const at = raw.indexOf("Synthetic bytes");
      if (mode === "buffer") body[at] = 88;
      else { const fd = fs.openSync(file, "r+"); try { fs.writeSync(fd, Buffer.from([88]), 0, 1, at); } finally { fs.closeSync(fd); } fs.utimesSync(file, 1000, 1000); }
    } };
    read = readCodexHybridPhysical({ native, threadId: id, check: scope }); active = true;
    let primary;
    try { encodeCodexHybrid({ read, targetId: target, cwd: root, createdAt: "2026-11-07T00:00:00Z" }); assert.fail("late mutation must reject"); }
    catch (error) { primary = error; }
    assert.ok(changed); assert.ok(["HYBRID_SOURCE_RECORD_CHANGED", "NATIVE_HISTORY_BYTES_CHANGED"].includes(primary.code));
    const before = checks;
    assert.throws(() => encodeCodexHybrid({ read, targetId: target, cwd: root, createdAt: "2026-11-07T00:00:00Z" }), error => error === primary);
    assert.equal(checks, before);
  }
  let armed = false, calls = 0;
  const source = { rolloutId: id, threadId: id, raw: Buffer.from(raw), sha256: historyHash(raw) };
  const native = { payload: { threadIds: [id], selectedRolloutId: id }, originals: [source], proof: resolveCodexPhysicalLineage({ originals: [source], rolloutId: id }) };
  const denied = Object.assign(new Error("Current scope denied"), { code: "EACCES" });
  const read = readCodexHybridPhysical({ native, threadId: id, check() { if (armed && ++calls === 3) throw denied; } }); armed = true;
  assert.throws(() => encodeCodexHybrid({ read, targetId: target, cwd: root, createdAt: "2026-11-07T00:00:00Z" }), error => error === denied);
  const before = calls;
  assert.throws(() => encodeCodexHybrid({ read, targetId: target, cwd: root, createdAt: "2026-11-07T00:00:00Z" }), error => error === denied);
  assert.equal(calls, before);
});

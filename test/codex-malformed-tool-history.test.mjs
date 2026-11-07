import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { resolveCodexPhysicalLineage } from "../scripts/lib/codex-physical-lineage.mjs";
import { readCodexCapturedPhysicalEvents, CODEX_PHYSICAL_PROFILES } from "../scripts/lib/codex-captured-physical-source.mjs";
import { CODEX_HYBRID_CONVERTER, readCodexHybridPhysical, encodeCodexHybrid } from "../scripts/lib/codex-claude-hybrid.mjs";

const id = "01900000-0000-7000-8000-000000009601", target = "01900000-0000-7000-8000-000000009602";
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function fixture({ input = "{SYNTHETIC invalid JSON", noResult = false, interleave = false, duplicate = false, conflict = false, custom = false, numericBefore = false, numericAfter = false } = {}) {
  const rows = [], add = (type, payload) => { rows.push({ ordinal: rows.length, type, payload }); return rows.at(-1); };
  add("session_meta", { id, session_id: id, cli_version: "0.148.0-alpha.15", history_mode: "paginated" });
  add("event_msg", { type: "task_started", turn_id: "t" });
  const authored = (type, itemId, text) => add("event_msg", { type: "item_completed", thread_id: id, turn_id: "t", item: { type, id: itemId, content: [{ type: type === "UserMessage" ? "text" : "Text", text }] } });
  const call = (callId, argumentsValue) => add("response_item", { type: "function_call", name: "observe", call_id: callId, arguments: argumentsValue });
  const result = callId => add("response_item", { type: "function_call_output", call_id: callId, output: "SYNTHETIC recorded output", is_error: false });
  authored("UserMessage", "u", "SYNTHETIC actual question");
  call("before", '{"value":1}');
  if (conflict) add("event_msg", { type: "item_completed", thread_id: id, turn_id: "t", item: { type: "McpToolCall", id: "before", tool: "observe", server: "synthetic", arguments: { value: 2 }, status: "completed", result: { content: [{ type: "text", text: "SYNTHETIC recorded output" }], isError: false } } });
  result("before"); authored("AgentMessage", "separator1", "SYNTHETIC middle note");
  if (numericBefore) { call("numeric-before", '{"value":9007199254740993}'); result("numeric-before"); }
  const bad = custom ? add("response_item", { type: "custom_tool_call", name: "observe", call_id: "bad", input }) : call("bad", input);
  if (interleave) authored("UserMessage", "u2", "SYNTHETIC intervening cancellation");
  if (!noResult) {
    if (custom) add("response_item", { type: "custom_tool_call_output", call_id: "bad", output: "SYNTHETIC custom output", is_error: true });
    else result("bad");
  }
  if (duplicate) { call("bad", '{"value":2}'); result("bad"); }
  if (numericAfter) { call("numeric-after", '{"value":9007199254740993}'); result("numeric-after"); }
  authored("AgentMessage", "separator2", "SYNTHETIC later note");
  call("after", '{"value":3}'); result("after"); authored("AgentMessage", "a", "SYNTHETIC final answer");
  add("event_msg", { type: "task_complete", turn_id: "t" });
  const raw = Buffer.from(rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const originals = [{ threadId: id, rolloutId: id, raw, sha256: hash(raw) }];
  const native = { payload: { threadIds: [id], selectedRolloutId: id }, originals,
    proof: resolveCodexPhysicalLineage({ originals, rolloutId: id }) };
  return { native, bad, raw };
}
function project(native, converter = CODEX_HYBRID_CONVERTER, check) {
  const read = readCodexHybridPhysical({ native, threadId: id, converter, ...(check ? { check } : {}) });
  const encoded = encodeCodexHybrid({ read, targetId: target, cwd: "C:/synthetic", createdAt: "2026-11-07T00:00:00Z" });
  return { read, encoded };
}

test("v6 preserves malformed nested argument strings verbatim without native tool promotion, while normal groups and lifecycle remain intact", () => {
  for (const input of ["{SYNTHETIC invalid JSON", '{"x":1,}', '{"x":"bad\ncontrol"}', "SYNTHETIC bare input"]) {
    const { native, bad, raw } = fixture({ input }), beforeHash = hash(raw), { read, encoded } = project(native);
    assert.equal(encoded.publicationReady, true);
    assert.equal(encoded.hybridCoverage.authored.completeAuthoredMessageCoverage, true);
    assert.equal(encoded.hybridCoverage.exactRecordLedger, true);
    assert.equal(read.sourceLifecycle.terminalAtCapture, true);
    assert.equal(read.sourceLifecycle.lastTurnStatus, "completed");
    const diagnostic = encoded.diagnostics.find(row => row.code === "HYBRID_MALFORMED_TOOL_ARGUMENTS_RAW_PRESERVED");
    assert.equal(diagnostic.nativeToolQualified, false); assert.equal(diagnostic.outcomeInferred, false);
    assert.equal(diagnostic.blocksPublication, false); assert.equal(diagnostic.argumentSha256, hash(Buffer.from(input)));
    assert.equal(diagnostic.source.rawOrdinal, bad.ordinal);
    assert.equal(hash(raw.subarray(diagnostic.source.startByteOffset, diagnostic.source.endByteOffset - 1)), diagnostic.source.rawFrameSha256);
    assert.equal(diagnostic.source.originalObjectSha256, beforeHash);
    assert.deepEqual(read.nativeEvents.filter(event => event.kind === "tool-call").map(event => event.callId), ["before", "after"]);
    const text = encoded.rows.flatMap(row => row.message.content).filter(part => part.type === "text").map(part => part.text);
    assert.ok(text.some(value => value.includes(JSON.stringify(bad))));
    assert.equal(encoded.rows.flatMap(row => row.message.content).some(part => part.type === "tool_use" && part.id === "bad"), false);
    assert.equal(hash(raw), beforeHash);
  }
});

test("old hybrid profiles and strict defaults keep their error behavior; diagnostic strict mode still blocks native mapping", () => {
  const { native } = fixture();
  for (const converter of ["codex-claude-physical-hybrid-v1", "codex-claude-physical-hybrid-v2", "codex-claude-physical-hybrid-v3", "codex-claude-physical-hybrid-v4", "codex-claude-physical-hybrid-v5"])
    assert.throws(() => project(native, converter), SyntaxError);
  for (const converter of CODEX_PHYSICAL_PROFILES) assert.throws(() => readCodexCapturedPhysicalEvents({ native, threadId: id, converter }), SyntaxError);
  const strict = readCodexCapturedPhysicalEvents({ native, threadId: id, diagnoseMalformedWireArguments: true });
  assert.ok(strict.diagnostics.some(row => row.code === "PHYSICAL_WIRE_ARGUMENT_JSON_UNQUALIFIED" && row.blocksPublication));
  assert.equal(strict.events.some(event => event.kind === "tool-call" && event.callId === "bad"), false);
});

test("duplicate IDs, valid reuse after malformed input, missing results and human interleaving stay historical rather than repair or replay", () => {
  for (const options of [{ duplicate: true }, { noResult: true }, { interleave: true }]) {
    const { read, encoded } = project(fixture(options).native);
    assert.equal(encoded.publicationReady, true);
    assert.equal(encoded.hybridCoverage.authored.completeAuthoredMessageCoverage, true);
    assert.equal(read.nativeEvents.some(event => event.callId === "bad"), false);
    assert.deepEqual(read.nativeEvents.filter(event => event.kind === "tool-call").map(event => event.callId), ["before", "after"]);
  }
});

test("outer JSON, UTF8, scope denial and canonical contradictions are not swallowed by nested-argument handling", () => {
  const denied = Object.assign(new Error("SYNTHETIC scope denied"), { code: "EACCES" });
  assert.throws(() => project(fixture().native, CODEX_HYBRID_CONVERTER, () => { throw denied; }), error => error === denied);
  assert.throws(() => project(fixture({ conflict: true }).native), { code: "PHYSICAL_CANONICAL_WIRE_DIVERGENCE" });
  const malformed = fixture(), invalid = Buffer.from('{"ordinal":0,"type":"session_meta","payload":\n');
  malformed.native.originals = [{ threadId: id, rolloutId: id, raw: invalid, sha256: hash(invalid) }];
  assert.throws(() => project(malformed.native), { code: "CODEX_LINEAGE_FRAME_INVALID" });
  const badUtf8 = fixture(), broken = Buffer.from([0xff, 0x0a]);
  badUtf8.native.originals = [{ threadId: id, rolloutId: id, raw: broken, sha256: hash(broken) }];
  assert.throws(() => project(badUtf8.native), { code: "CODEX_LINEAGE_FRAME_INVALID" });
});

test("valid JSON, custom raw inputs and exact-number protections retain their separate existing semantics", () => {
  for (const options of [{ input: '{"value":4}' }, { custom: true }, { input: '{"value":9007199254740993}' }]) {
    const { read, encoded } = project(fixture(options).native);
    assert.equal(encoded.publicationReady, true);
    assert.equal(encoded.diagnostics.some(row => row.code === "HYBRID_MALFORMED_TOOL_ARGUMENTS_RAW_PRESERVED"), false);
    if (options.input?.includes("9007199254740993")) assert.equal(read.nativeEvents.some(event => event.callId === "bad"), false);
  }
});

test("numeric fallback before or after a malformed input does not erase its exact historical diagnostic", () => {
  for (const options of [{ numericBefore: true }, { numericAfter: true }]) {
    const { bad, native } = fixture(options), { read, encoded } = project(native);
    assert.equal(encoded.publicationReady, true);
    assert.equal(read.sourceLifecycle.lastTurnStatus, "unknown");
    const malformed = encoded.diagnostics.filter(row => row.code === "HYBRID_MALFORMED_TOOL_ARGUMENTS_RAW_PRESERVED");
    assert.equal(malformed.length, 1); assert.equal(malformed[0].source.rawOrdinal, bad.ordinal);
    assert.equal(malformed[0].nativeToolQualified, false); assert.equal(malformed[0].outcomeInferred, false);
    assert.equal(read.nativeEvents.some(event => event.callId === "bad" || event.callId.startsWith("numeric-")), false);
    assert.equal(encoded.hybridCoverage.authored.completeAuthoredMessageCoverage, true);
  }
});

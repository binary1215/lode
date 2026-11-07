import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { resolveCodexPhysicalLineage } from "../scripts/lib/codex-physical-lineage.mjs";
import { readCodexHybridPhysical, encodeCodexHybrid, CODEX_HYBRID_CONVERTER, CODEX_HYBRID_CONTEXT_CONVERTER, CODEX_HYBRID_LEGACY_CONVERTER } from "../scripts/lib/codex-claude-hybrid.mjs";
import { recordedPluginContextEnvelope } from "../scripts/lib/codex-legacy-hybrid-shapes.mjs";

const id = "01900000-0000-7000-8000-000000008501";
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const wireRecord = payload => ({ ordinal: 3, type: "response_item", payload });
function envelope() {
  return { type: "message", id: "synthetic-provider-context", role: "user",
    content: ["SYNTHETIC_PLUGIN_INSTRUCTION_NOT_NATIVE", "SYNTHETIC_AGENTS_INSTRUCTION_NOT_NATIVE", "SYNTHETIC_ENVIRONMENT_NOT_NATIVE"].map(text => ({ type: "input_text", text })),
    internal_chat_message_metadata_passthrough: { turn_id: "synthetic-turn", create_time: 123,
      content_item_kinds: ["plugins.recommendations", "agents_md.instructions", "environments.environment_context"] } };
}
function fixture(payload = envelope(), version = "0.153.4") {
  const rows = [], add = (type, payload) => rows.push({ ordinal: rows.length, type, payload });
  add("session_meta", { id, session_id: id, cli_version: version, history_mode: "paginated" });
  add("event_msg", { type: "task_started", turn_id: "synthetic-turn" });
  add("event_msg", { type: "item_completed", thread_id: id, turn_id: "synthetic-turn",
    item: { type: "UserMessage", id: "synthetic-user", content: [{ type: "text", text: "SYNTHETIC actual user question" }] } });
  add("response_item", payload);
  add("event_msg", { type: "item_completed", thread_id: id, turn_id: "synthetic-turn",
    item: { type: "AgentMessage", id: "synthetic-answer", content: [{ type: "Text", text: "SYNTHETIC actual assistant answer" }] } });
  add("event_msg", { type: "task_complete", turn_id: "synthetic-turn" });
  const raw = Buffer.from(rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const originals = [{ threadId: id, rolloutId: id, raw, sha256: digest(raw) }];
  return { payload: { threadIds: [id], selectedRolloutId: id }, originals,
    proof: resolveCodexPhysicalLineage({ originals, rolloutId: id }) };
}
function project(native, converter = CODEX_HYBRID_CONVERTER) {
  const read = readCodexHybridPhysical({ native, threadId: id, converter });
  const encoded = encodeCodexHybrid({ read, targetId: "01900000-0000-7000-8000-000000008502", cwd: "C:/synthetic", createdAt: "2026-11-07T00:00:00Z" });
  return { read, encoded };
}

test("v5 and v6 retain the exact recorded provider envelope only in the original companion, without canonical attribution or native instructions", () => {
  for (const converter of [CODEX_HYBRID_CONTEXT_CONVERTER, CODEX_HYBRID_CONVERTER]) {
  const native = fixture(), sourceHash = digest(native.originals[0].raw);
  const { read, encoded } = project(native, converter);
  assert.equal(encoded.publicationReady, true);
  assert.equal(encoded.hybridCoverage.exactRecordLedger, true);
  assert.equal(encoded.hybridCoverage.authored.completeAuthoredMessageCoverage, true);
  assert.equal(encoded.hybridCoverage.authored.sourceMessages, 2);
  assert.equal(encoded.hybridCoverage.providerInstructionsReplayed, false);
  assert.equal(read.inventory.find(row => row.source.rawOrdinal === 3).classification, "provider-envelope-original-only");
  assert.equal(encoded.mappings.some(row => row.source.rawOrdinal === 3), false);
  for (const part of envelope().content) {
    assert.equal(native.originals[0].raw.includes(Buffer.from(part.text)), true);
    assert.equal(encoded.raw.includes(Buffer.from(part.text)), false);
  }
  const diagnostic = encoded.diagnostics.find(row => row.code === "HYBRID_RECORDED_PLUGIN_CONTEXT_ORIGINAL_ONLY");
  assert.equal(diagnostic.canonicalAuthoredMessageClaimed, false);
  assert.equal(diagnostic.providerInstructionsReplayed, false);
  assert.equal(diagnostic.blocksPublication, false);
  assert.equal(digest(native.originals[0].raw), sourceHash);
  }
});

test("v1 through v4 keep the provider context unsupported, preserving their prior classification and failed coverage", () => {
  for (const converter of ["codex-claude-physical-hybrid-v1", "codex-claude-physical-hybrid-v2", "codex-claude-physical-hybrid-v3", CODEX_HYBRID_LEGACY_CONVERTER]) {
    const { read, encoded } = project(fixture(), converter);
    assert.equal(encoded.publicationReady, false, converter);
    assert.equal(read.inventory.find(row => row.source.rawOrdinal === 3).classification, "wire-authored-replay-unqualified", converter);
    assert.equal(encoded.diagnostics.some(row => row.code === "HYBRID_WIRE_AUTHORED_REPLAY_UNCORROBORATED" && row.blocksPublication), true);
    assert.equal(encoded.diagnostics.some(row => row.code === "HYBRID_RECORDED_PLUGIN_CONTEXT_ORIGINAL_ONLY"), false);
  }
});

test("unknown kinds, reordered/count-mismatched parts, author roles and private or unknown fields do not qualify", () => {
  const cases = [
    p => { p.role = "assistant"; }, p => { p.id = ""; },
    p => { p.internal_chat_message_metadata_passthrough.turn_id = 7; },
    p => { p.internal_chat_message_metadata_passthrough.create_time = "123"; },
    p => { p.internal_chat_message_metadata_passthrough.content_item_kinds[0] = "user.text"; },
    p => { p.internal_chat_message_metadata_passthrough.content_item_kinds[0] = "private.reasoning"; },
    p => { p.internal_chat_message_metadata_passthrough.content_item_kinds.reverse(); },
    p => { p.internal_chat_message_metadata_passthrough.content_item_kinds.pop(); },
    p => { p.internal_chat_message_metadata_passthrough.content_item_kinds.push("user.text"); },
    p => { p.content.pop(); }, p => { p.content.push({ type: "input_text", text: "SYNTHETIC user text" }); },
    p => { p.content[0].type = "reasoning"; }, p => { p.content[0].type = "encrypted_content"; },
    p => { p.content[0].private = "SYNTHETIC private"; },
    p => { p.content[0].encrypted_content = "SYNTHETIC encrypted"; },
    p => { p.content[0].text = null; }, p => { p.unknown = true; },
    p => { p.reasoning = "SYNTHETIC private"; },
    p => { p.internal_chat_message_metadata_passthrough.unknown = true; },
    p => { p.internal_chat_message_metadata_passthrough.content_item_metadata = []; },
    p => { delete p.internal_chat_message_metadata_passthrough.content_item_kinds; }
  ];
  for (const [index, change] of cases.entries()) {
    const payload = envelope(); change(payload);
    assert.equal(recordedPluginContextEnvelope(wireRecord(payload), "0.153.4"), false, String(index));
    const { encoded } = project(fixture(payload));
    assert.equal(encoded.publicationReady, false, String(index));
    assert.equal(encoded.diagnostics.some(row => row.code === "HYBRID_WIRE_AUTHORED_REPLAY_UNCORROBORATED" && row.blocksPublication), true, String(index));
  }
  for (const version of ["0.148.0-alpha.15", "0.149.0-alpha.4.3", "0.163.0-alpha.10.2", "future", null]) {
    assert.equal(recordedPluginContextEnvelope(wireRecord(envelope()), version), false);
  }
  assert.equal(project(fixture(envelope(), "0.163.0-alpha.10.2")).encoded.publicationReady, false);
});

test("record type cannot smuggle the same payload through the new envelope qualification", () => {
  const native = fixture(), rows = native.originals[0].raw.toString("utf8").trimEnd().split("\n").map(JSON.parse);
  rows[3].type = "future_record";
  const raw = Buffer.from(rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  native.originals = [{ threadId: id, rolloutId: id, raw, sha256: digest(raw) }];
  native.proof = resolveCodexPhysicalLineage({ originals: native.originals, rolloutId: id });
  const { encoded } = project(native);
  assert.equal(encoded.publicationReady, false);
  assert.equal(encoded.diagnostics.some(row => row.code === "HYBRID_RECORDED_PLUGIN_CONTEXT_ORIGINAL_ONLY"), false);
});

test("unknown outer fields and malformed timestamps remain unqualified, while source timestamp strings remain passive metadata", () => {
  const good = wireRecord(envelope());
  assert.equal(recordedPluginContextEnvelope(good, "0.153.4"), true);
  assert.equal(recordedPluginContextEnvelope({ ...good, timestamp: "2026-11-07T00:00:00Z" }, "0.153.4"), true);
  for (const change of [
    row => { row.future_user_content = "SYNTHETIC unknown outer input"; },
    row => { row.private = "SYNTHETIC private outer data"; },
    row => { row.reasoning = "SYNTHETIC private outer reasoning"; },
    row => { row.encrypted_content = "SYNTHETIC encrypted outer data"; },
    row => { row.timestamp = null; }, row => { row.timestamp = 123; },
    row => { row.timestamp = { text: "SYNTHETIC unknown timestamp data" }; }
  ]) {
    const native = fixture(), rows = native.originals[0].raw.toString("utf8").trimEnd().split("\n").map(JSON.parse);
    change(rows[3]); assert.equal(recordedPluginContextEnvelope(rows[3], "0.153.4"), false);
    const raw = Buffer.from(rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    native.originals = [{ threadId: id, rolloutId: id, raw, sha256: digest(raw) }];
    native.proof = resolveCodexPhysicalLineage({ originals: native.originals, rolloutId: id });
    assert.equal(project(native).encoded.publicationReady, false);
  }
  for (const ordinal of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "3", null])
    assert.equal(recordedPluginContextEnvelope({ ...good, ordinal }, "0.153.4"), false);
});

test("only v6 recognizes the same observed provider envelope in a container created by 0.148, without inferring its record producer", () => {
  const native = fixture(envelope(), "0.148.0-alpha.15");
  assert.equal(project(native, CODEX_HYBRID_CONVERTER).encoded.publicationReady, true);
  const prior = project(native, CODEX_HYBRID_CONTEXT_CONVERTER);
  assert.equal(prior.encoded.publicationReady, false);
  assert.equal(prior.encoded.diagnostics.some(row => row.code === "HYBRID_WIRE_AUTHORED_REPLAY_UNCORROBORATED"), true);
  const record = wireRecord(envelope());
  assert.equal(recordedPluginContextEnvelope(record, "0.148.0-alpha.15"), false);
  assert.equal(recordedPluginContextEnvelope(record, "0.148.0-alpha.15", true), true);
  assert.equal(recordedPluginContextEnvelope(record, "0.148.0-alpha.15", "true"), false);
  for (const version of ["0.149.0-alpha.4.3", "0.163.0-alpha.10.2", "future"])
    assert.equal(recordedPluginContextEnvelope(record, version, true), false);
  const altered = wireRecord(envelope()); altered.payload.internal_chat_message_metadata_passthrough.content_item_kinds[0] = "user.text";
  assert.equal(recordedPluginContextEnvelope(altered, "0.148.0-alpha.15", true), false);
  assert.equal(recordedPluginContextEnvelope({ ...record, private: "SYNTHETIC unknown outer field" }, "0.148.0-alpha.15", true), false);
});

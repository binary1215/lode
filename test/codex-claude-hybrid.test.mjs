import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { codexNativePortabilityProfile } from "../scripts/lib/codex-native-portability.mjs";
import { resolveCodexPhysicalLineage } from "../scripts/lib/codex-physical-lineage.mjs";
import { CODEX_HYBRID_CONVERTER, readCodexHybridPhysical, encodeCodexHybrid } from "../scripts/lib/codex-claude-hybrid.mjs";
import { derivedHash as hash } from "../scripts/lib/claude-derived-encoder.mjs";
import { archiveCodexCapturedPhysicalSource } from "../scripts/lib/codex-captured-physical-source.mjs";
import { deriveProjectNativeHistory, inspectProjectNativeDerivation } from "../scripts/lib/project-native-derivation.mjs";
import { compareClaudeDerivedReader } from "../scripts/lib/claude-derived-reader-coverage.mjs";
import { claudeMessageDigest } from "../scripts/lib/claude-message-digest.mjs";
import { recordedContextualUserMessage, exactWireAuthoredProjection, exactMcpModelProjection } from "../scripts/lib/codex-hybrid-projections.mjs";
import { admitDestinationImportTarget, reserveDestinationImportEffect, executeDestinationImportEffect, openDestinationImportTarget } from "../scripts/lib/destination-import-journal.mjs";

const id = "01900000-0000-7000-8000-000000006201";
function fixture({ interleave = false, noTurn = false, mcp = false, conflict = false, unfinished = false, duplicate = false } = {}) {
  const rows = [], add = (type, payload) => rows.push({ ordinal: rows.length, type, payload });
  add("session_meta", { id, session_id: id, cli_version: codexNativePortabilityProfile().engineVersion, history_mode: "paginated", base_instructions: "SYNTHETIC_PRIVATE_INSTRUCTION_MUST_NOT_REPLAY" });
  if (!noTurn) add("event_msg", { type: "task_started", turn_id: "t1" });
  const message = (type, itemId, text) => add("event_msg", { type: "item_completed", thread_id: id, turn_id: "t1", item: { type, id: itemId, content: [{ type: type === "UserMessage" ? "text" : "Text", text }] } });
  message("UserMessage", "u1", "SYNTHETIC preserve original question; do not deploy");
  add("response_item", { type: "function_call", call_id: "c1", name: "observe", namespace: mcp ? "mcp__synthetic" : null, arguments: '{"value":1}' });
  if (duplicate) add("response_item", { type: "function_call", call_id: "c1", name: "observe", arguments: '{"value":1}' });
  if (interleave) { message("AgentMessage", "progress", "SYNTHETIC still running"); message("UserMessage", "u2", "SYNTHETIC cancel the deployment"); }
  if (!unfinished) add("response_item", { type: "function_call_output", call_id: "c1", output: mcp ? JSON.stringify([{ type: "text", text: "SYNTHETIC failed output" }]) : "SYNTHETIC failed output", ...(mcp ? {} : { is_error: true }) });
  if (mcp) add("event_msg", { type: "item_completed", thread_id: id, turn_id: "t1", item: { type: "McpToolCall", id: "c1", server: "synthetic", tool: "observe", arguments: { value: conflict ? 2 : 1 }, status: "failed", result: { content: [{ type: "text", text: "SYNTHETIC failed output" }], isError: true, _meta: { synthetic: true } } } });
  add("event_msg", { type: "item_completed", thread_id: id, turn_id: "t1", item: { type: "Extension", value: { activity: "SYNTHETIC opaque extension fields preserved" } } });
  add("event_msg", { type: "item_completed", thread_id: id, turn_id: "t1", item: { type: "SubAgentActivity", id: "worker1", status: "failed", output: "SYNTHETIC worker cancelled; no approval" } });
  add("event_msg", { type: "item_completed", thread_id: id, turn_id: "t1", item: { type: "Reasoning", id: "private1", text: "SYNTHETIC_PRIVATE_REASONING_MUST_NOT_REPLAY" } });
  add("world_state", { full: true, state: { permissions: { policy: "SYNTHETIC_SOURCE_POLICY_NOT_CURRENT" } } });
  add("token_usage_record", { usage: { tokens: 3 } });
  if (!unfinished) { message("AgentMessage", "a1", "SYNTHETIC failure and cancellation retained"); add("event_msg", { type: "task_complete", turn_id: "t1" }); }
  return { rows, add, message };
}
function nativeFor(rows) {
  const raw = Buffer.from(rows.map(row => JSON.stringify(row)).join("\n") + "\n"), originals = [{ threadId: id, rolloutId: id, raw, sha256: hash(raw) }];
  return { payload: { threadIds: [id], selectedRolloutId: id }, originals, proof: resolveCodexPhysicalLineage({ originals, rolloutId: id }) };
}
function project(rows) {
  const native = nativeFor(rows), read = readCodexHybridPhysical({ native, threadId: id });
  return { native, read, encoded: encodeCodexHybrid({ read, targetId: crypto.randomUUID(), cwd: "C:/synthetic", createdAt: "2026-11-06T00:00:00Z" }) };
}

test("hybrid preserves exact completed failed native tools, authored roles, literal extension/subagent fields and classified private originals", () => {
  const { read, encoded } = project(fixture().rows);
  assert.equal(encoded.publicationReady, true); assert.equal(encoded.hybridCoverage.exactRecordLedger, true);
  assert.equal(encoded.hybridCoverage.authored.completeAuthoredMessageCoverage, true);
  assert.equal(read.nativeEvents.length, 2);
  const result = encoded.rows.flatMap(row => row.message.content).find(block => block.type === "tool_result"); assert.equal(result.is_error, true);
  assert.ok(encoded.raw.includes(Buffer.from("SYNTHETIC opaque extension fields preserved")));
  assert.ok(encoded.raw.includes(Buffer.from("SYNTHETIC worker cancelled; no approval")));
  for (const secret of ["SYNTHETIC_PRIVATE_INSTRUCTION_MUST_NOT_REPLAY", "SYNTHETIC_PRIVATE_REASONING_MUST_NOT_REPLAY", "SYNTHETIC_SOURCE_POLICY_NOT_CURRENT"])
    assert.equal(encoded.raw.includes(Buffer.from(secret)), false);
  assert.equal(read.inventory.filter(row => row.classification === "telemetry-original-only").length, 1);
  assert.equal(encoded.openSafety.structurallySettled, true);
});

test("interleaved humans, missing turn proof, duplicate call IDs and unfinished calls remain ordered historical records without invented results or settled source claims", () => {
  for (const option of [{ interleave: true }, { noTurn: true }, { duplicate: true }, { unfinished: true }]) {
    const f = fixture(option), { read, encoded } = project(f.rows);
    assert.equal(read.nativeEvents.length, 0, JSON.stringify(option));
    assert.equal(encoded.publicationReady, true); assert.equal(encoded.hybridCoverage.authored.completeAuthoredMessageCoverage, true);
    assert.equal(encoded.rows.some(row => row.message.content.some(block => block.type === "tool_use" || block.type === "tool_result")), false);
    const ordinals = encoded.mappings.map(mapping => mapping.source.rawOrdinal); assert.deepEqual(ordinals, ordinals.slice().sort((a, b) => a - b));
    if (option.noTurn || option.unfinished) assert.equal(encoded.openSafety.structurallySettled, false);
    if (option.unfinished) assert.equal(encoded.openSafety.trailingUserMessage, true);
  }
});

test("MCP namespace prefix and exact content-array projection are qualified explicitly while actual same-ID contradictions remain primary", () => {
  const { read, encoded } = project(fixture({ mcp: true }).rows);
  assert.equal(encoded.publicationReady, true); assert.equal(read.nativeEvents.length, 2);
  const proof = read.inventory.find(row => row.canonicalWireEvidence)?.canonicalWireEvidence;
  assert.equal(proof.namespaceProjection, "explicit-mcp-namespace-prefix"); assert.equal(proof.resultProjection, "exact-recorded-content-array");
  assert.equal(encoded.rows.flatMap(row => row.message.content).find(block => block.type === "tool_result").is_error, true);
  assert.throws(() => project(fixture({ mcp: true, conflict: true }).rows), { code: "PHYSICAL_CANONICAL_WIRE_DIVERGENCE" });
});

test("uncorroborated wire human content and unknown provider-state fields cannot silently disappear behind complete native publication", () => {
  const f = fixture(); f.add("response_item", { type: "message", role: "user", id: "unmatched-human", content: [{ type: "input_text", text: "SYNTHETIC unique original wire question" }] });
  f.add("world_state", { full: true, state: { future_user_content: "SYNTHETIC unclassified semantic data" } });
  const { encoded } = project(f.rows); assert.equal(encoded.publicationReady, false);
  assert.ok(encoded.diagnostics.some(row => row.code === "HYBRID_WIRE_AUTHORED_REPLAY_UNCORROBORATED" && row.blocksPublication));
  assert.ok(encoded.diagnostics.some(row => row.code === "HYBRID_PROVIDER_STATE_FIELDS_UNQUALIFIED" && row.blocksPublication));
});

test("source hashes, identity, truncation and post-read record changes stay primary instead of historical fallback", () => {
  const f = fixture(), native = nativeFor(f.rows);
  native.originals[0].raw[0] = 91;
  assert.throws(() => readCodexHybridPhysical({ native, threadId: id }), { code: "CODEX_LINEAGE_ORIGINAL_DIGEST_MISMATCH" });
  const bad = structuredClone(f.rows); bad.find(row => row.payload?.item?.type === "Extension").payload.thread_id = "01900000-0000-7000-8000-000000006299";
  assert.throws(() => project(bad), { code: "PHYSICAL_ITEM_NATIVE_IDENTITY_MISMATCH" });
  const whole = nativeFor(f.rows), broken = whole.originals[0].raw.subarray(0, -1); whole.originals[0] = { ...whole.originals[0], raw: broken, sha256: hash(broken) };
  assert.throws(() => readCodexHybridPhysical({ native: whole, threadId: id }), { code: "CODEX_LINEAGE_INCOMPLETE_JSONL" });
  const prepared = project(f.rows); prepared.read.records[2].rawText += " ";
  assert.throws(() => encodeCodexHybrid({ read: prepared.read, targetId: crypto.randomUUID(), cwd: "C:/synthetic", createdAt: "2026-11-06T00:00:00Z" }), { code: "HYBRID_SOURCE_RECORD_CHANGED" });
});

test("Core creates a new hybrid identity beside immutable strict evidence and reproduces its exact record ledger before accepting it", t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lode-hybrid-core-"));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(base)), fs.realpathSync(os.tmpdir())); fs.rmSync(base, { recursive: true, force: true }); });
  const source = path.join(base, "source"), target = path.join(base, "target"); fs.mkdirSync(source); fs.mkdirSync(target);
  const native = nativeFor(fixture({ interleave: true }).rows);
  archiveCodexCapturedPhysicalSource({ directory: source, threadId: id, rolloutId: id, originals: native.originals });
  const args = { bundleRoot: source, root: target, threadIds: [id], assertCurrentAuthority: () => {} };
  const strict = deriveProjectNativeHistory(args), before = fs.readFileSync(path.join(strict.derivationDirectory, "conversation.jsonl"));
  const mixed = deriveProjectNativeHistory({ ...args, converter: CODEX_HYBRID_CONVERTER });
  assert.notEqual(mixed.derivationId, strict.derivationId); assert.notEqual(mixed.target.nativeId, strict.target.nativeId); assert.equal(mixed.publicationReady, true);
  assert.ok(fs.readFileSync(path.join(strict.derivationDirectory, "conversation.jsonl")).equals(before));
  const inspected = inspectProjectNativeDerivation({ bundleRoot: source, derivationId: mixed.derivationId, expectedDerivationDigest: mixed.derivationDigest });
  assert.equal(inspected.hybridCoverage.exactRecordLedger, true); assert.equal(inspected.hybridCoverage.authored.completeAuthoredMessageCoverage, true);
  const mapping = path.join(mixed.derivationDirectory, "mapping.json"), bytes = fs.readFileSync(mapping); fs.writeFileSync(mapping, Buffer.concat([bytes, Buffer.from(" ")]));
  assert.throws(() => inspectProjectNativeDerivation({ bundleRoot: source, derivationId: mixed.derivationId }), { code: "DERIVED_ARTIFACT_TAMPER" });
});

test("bounded SDK digest observations prove exact emitted message bodies/roles/order without transporting them and reject altered/missing/reordered digests", () => {
  const { encoded } = project(fixture().rows), nativeId = encoded.rows[0].sessionId;
  const returned = encoded.rows.map(row => ({ uuid: row.uuid, type: row.type, session_id: nativeId, messageSha256: claudeMessageDigest(row.message) }));
  const compare = rows => compareClaudeDerivedReader({ nativeMessages: encoded.rows, returned: rows, nativeId, prefixCount: encoded.rows.length, exactSessionObserved: true, digestObservation: true });
  assert.equal(compare(returned).rawCoverageComplete, true);
  const altered = structuredClone(returned); altered[0].messageSha256 = "0".repeat(64); assert.equal(compare(altered).rawCoverageComplete, false);
  assert.equal(compare(returned.slice(1)).rawCoverageComplete, false); assert.equal(compare(returned.slice().reverse()).rawCoverageComplete, false);
});

test("recorded provider attribution and same-turn exact text qualify user replay without guessing IDs or inspecting instruction words", () => {
  const f = fixture(), user = f.rows.find(row => row.payload?.item?.type === "UserMessage");
  f.add("response_item", { type: "message", role: "user", id: "different-wire-id", content: [{ type: "input_text", text: user.payload.item.content[0].text }], internal_chat_message_metadata_passthrough: { turn_id: "t1", content_item_kinds: ["user.text"] } });
  f.add("response_item", { type: "message", role: "user", id: "harness-context", content: [{ type: "input_text", text: "SYNTHETIC_OLD_INSTRUCTION_DO_NOT_REPLAY" }], internal_chat_message_metadata_passthrough: { content_item_kinds: ["environments.environment_context"] } });
  const good = project(f.rows); assert.equal(good.encoded.publicationReady, true);
  assert.equal(good.encoded.raw.includes(Buffer.from("SYNTHETIC_OLD_INSTRUCTION_DO_NOT_REPLAY")), false);
  const duplicate = structuredClone(f.rows.at(-2)); duplicate.ordinal = f.rows.length; f.rows.push(duplicate);
  assert.equal(project(f.rows).encoded.publicationReady, false); f.rows.pop();
  f.rows.at(-2).payload.internal_chat_message_metadata_passthrough.turn_id = "other-turn";
  assert.equal(project(f.rows).encoded.publicationReady, false);
  const contextual = f.rows.at(-1).payload;
  contextual.internal_chat_message_metadata_passthrough.content_item_metadata = [{ provenance: { type: "user" } }];
  assert.equal(recordedContextualUserMessage(contextual), false);
  contextual.internal_chat_message_metadata_passthrough.content_item_metadata = [{ provenance: { type: "harness", hook: true } }];
  assert.equal(recordedContextualUserMessage(contextual), false);
  contextual.internal_chat_message_metadata_passthrough.content_item_kinds = ["future-user-content"];
  delete contextual.internal_chat_message_metadata_passthrough.content_item_metadata;
  assert.equal(recordedContextualUserMessage(contextual), false);
});

test("pinned citation and MCP model projections require exact content and preserve the distinct original records", () => {
  const citation = { entries: [{ path: "synthetic.md", lineStart: 1, lineEnd: 2, note: "synthetic note" }], rolloutIds: [id] };
  const wire = { role: "assistant", content: [{ type: "output_text", text: "SYNTHETIC answer<oai-mem-citation><citation_entries>synthetic.md:1-2|note=[synthetic note]</citation_entries><rollout_ids>" + id + "</rollout_ids></oai-mem-citation>" }] };
  const canonical = { content: [{ type: "Text", text: "SYNTHETIC answer" }], memory_citation: citation };
  assert.equal(exactWireAuthoredProjection(wire, canonical), true);
  assert.equal(exactWireAuthoredProjection(wire, { ...canonical, memory_citation: null }), false);
  const result = { content: [{ type: "text", text: "SYNTHETIC failed result" }], isError: true };
  const model = [{ type: "input_text", text: "Wall time: 0.1234 seconds\nOutput:" }, { type: "input_text", text: result.content[0].text }];
  assert.equal(exactMcpModelProjection(result, model), true);
  model[1].text += "changed"; assert.equal(exactMcpModelProjection(result, model), false);
  const f = fixture({ mcp: true }), output = f.rows.find(row => row.payload?.type === "function_call_output");
  output.payload.output = [{ type: "input_text", text: "Wall time: 0.1234 seconds\nOutput:" }, { type: "input_text", text: "SYNTHETIC failed output" }];
  const at = f.rows.findIndex(row => row.payload?.item?.type === "McpToolCall");
  const entry = f.rows.splice(at, 1)[0]; f.rows.splice(f.rows.indexOf(output), 0, entry); f.rows.forEach((row, index) => { row.ordinal = index; });
  const bridged = project(f.rows); assert.equal(bridged.encoded.publicationReady, true); assert.equal(bridged.read.nativeEvents.length, 2);
  const toolRow = bridged.encoded.rows.find(row => row.message.content.some(part => part.type === "tool_use"));
  assert.deepEqual(toolRow.message.content.map(part => part.type), ["tool_use", "text"]);
  assert.match(toolRow.message.content[1].text, /Historical Codex activity/u);
  assert.deepEqual(bridged.encoded.mappings.map(row => row.source.rawOrdinal), bridged.encoded.mappings.map(row => row.source.rawOrdinal).slice().sort((a,b) => a-b));
  output.payload.output[1].text += "changed";
  const distinct = project(f.rows); assert.equal(distinct.encoded.publicationReady, true);
  assert.equal(distinct.read.nativeEvents.length, 0); assert.equal(distinct.encoded.hybridCoverage.unresolvedProjectionCount, 1);
  assert.equal(distinct.encoded.hybridCoverage.allToolSemanticEquivalenceClaimed, false);
  output.payload.is_error = false;
  assert.throws(() => project(f.rows), { code: "PHYSICAL_CANONICAL_WIRE_DIVERGENCE" });
});

test("profile-independent source conversation claims block duplicate projections without blocking sibling conversation selections", async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lode-hybrid-journal-"));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(base)), fs.realpathSync(os.tmpdir())); fs.rmSync(base, { recursive: true, force: true }); });
  const journalRoot = path.join(base, "journal"), nativeHome = path.join(base, "home"), projectRoot = path.join(base, "project");
  for (const root of [journalRoot, nativeHome, projectRoot]) fs.mkdirSync(root);
  const options = { journalRoot, nativeHome, projectRoot, hostId: "synthetic", provider: "claude", assertCurrentAuthority: () => {} };
  const receipt = admitDestinationImportTarget(options).receipt;
  const ids = [1,2,3,4].map(n => "01900000-0000-7000-8000-" + String(n).padStart(12, "0"));
  const request = (n, sourceConversationKey = "d".repeat(64)) => ({ ...options, receipt, sourceConversationKey, alternativeNativeIds: ids,
    operation: { provider: "claude", sourceDigest: "a".repeat(64), projectionDigest: String(n).repeat(64), nativeId: ids[n - 1], relativeFile: "projects/synthetic/" + ids[n - 1] + ".jsonl" },
    historicalDisposition: "current-explicit-new-target-intent", historyAssessment: { sameTargetAttemptObserved: false, unresolvedAttemptObserved: false, evidenceDigest: "c".repeat(64) } });
  const first = reserveDestinationImportEffect(request(1)); assert.equal(first.status, "destination-effect-reserved");
  assert.equal(reserveDestinationImportEffect(request(2)).reasonCode, "DESTINATION_ALTERNATE_PROFILE_ATTEMPT_OBSERVED");
  const sibling = request(3, "e".repeat(64)); sibling.alternativeNativeIds = [ids[2]];
  assert.equal(reserveDestinationImportEffect(sibling).status, "destination-effect-reserved");
  const ctx = openDestinationImportTarget({ ...options, receipt });
  const claims = path.join(journalRoot, "source-conversations", ctx.targetKey);
  const claim = path.join(claims, "d".repeat(64) + ".json"); fs.appendFileSync(claim, " ");
  let writes = 0;
  await assert.rejects(executeDestinationImportEffect({ lease: first.lease, execute: () => { writes++; }, observe: () => ({ state: "matches" }) }), { code: "DESTINATION_IMPORT_EFFECT_TAMPER" });
  assert.equal(writes, 0);
});

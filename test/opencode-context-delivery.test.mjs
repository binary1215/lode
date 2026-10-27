import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import plugin from "../scripts/opencode-plugin.mjs";
import { createSessionHostAdapter } from "../scripts/lib/session-host-adapter.mjs";
import { createHeadSession } from "../scripts/lib/session-routing.mjs";
import { updateProjectDirection } from "../scripts/lib/project-direction.mjs";
import { startupProjection, MAX_CONTEXT_CHARACTERS } from "../scripts/lib/session-host-context-projection.mjs";
import { buildCodexMarketplaceSnapshot } from "../scripts/lib/codex-marketplace.mjs";
import { buildClaudeMarketplaceSnapshot } from "../scripts/lib/claude-marketplace.mjs";
import { fixture, snapshot, pluginRoot } from "./helpers/session-work-linkage-fixture.mjs";
import { prepareRequest } from "./helpers/opencode-context-consumer.mjs";

async function setup(t, { selected = true, native = "ses_request", projectID = "host-project" } = {}) {
  const f = fixture(t), environment = { LODE_AGENT_OPERATIONAL_STATE_ROOT: f.operational }, calls = [];
  const session = { id: native, projectID, directory: f.root }, client = { session: {
    async get(input) { calls.push(input); return { data: { ...session } }; },
  } };
  const adapter = createSessionHostAdapter({ runtime: "opencode", nativeSessionId: native, environment });
  if (selected) adapter.select({ root: f.root, sessionId: f.session.sessionId, expectedRevision: 0 });
  const hooks = await plugin.server({ client, project: { id: projectID }, directory: f.root }, { environment });
  t.after(() => hooks.dispose());
  const transform = (output = { system: ["Original system"] }, id = native) => hooks["experimental.chat.system.transform"]({ sessionID: id, model: {} }, output).then(() => output);
  return { ...f, environment, nativeRecord: session, native, projectID, client, adapter, hooks, calls, transform };
}
const context = output => JSON.parse(output.system.at(-1));

test("ABC: actual OpenCode adapter retains partial reasons and tasks within its complete context bound", async t => {
  const f = await setup(t);
  f.save({ summary: "S".repeat(14000), observedWork: ["O".repeat(19000)],
    judgments: [{ assessment: "Keep the saved distinction", reason: "OpenCodePartialReasonMarker", alternatives: ["Do not infer completion"] }],
    pending: ["OpenCodePartialPendingMarker"], unknowns: ["Unreturned conditions may remain"] });
  updateProjectDirection({ root: f.root, input: { goal: "Inspect locally", cancelledActions: ["deploy"] } });
  const before = snapshot(f.base), output = await f.transform(), text = output.system.at(-1), value = context(output);
  assert(text.length <= MAX_CONTEXT_CHARACTERS.opencode);
  assert(value.recordExcerpts.length); assert.equal(value.workCoverage.sourceIncluded, 0);
  assert.equal(value.workCoverage.sourceExcerpted, 1);
  assert(text.includes("OpenCodePartialReasonMarker")); assert(text.includes("OpenCodePartialPendingMarker"));
  assert.deepEqual(value.currentProjectDirection.input.cancelledActions, ["deploy"]);
  assert.equal(value.logicalSessionId, f.session.sessionId); assert.equal(value.ordinaryWorkBlocked, false);
  assert.equal(output.system[0], "Original system"); assert.deepEqual(snapshot(f.base), before);
  t.diagnostic(JSON.stringify({ scope: "ABC public OpenCode adapter with local synthetic SDK, not a real Host/model",
    emittedUtf16Characters: text.length, full: value.records.length, excerpts: value.recordExcerpts.length }));
});

test("exact native request receives current recorded direction and work bodies without any file write", async t => {
  const f = await setup(t);
  f.save({ summary: "Recorded exact work body", pending: ["Check the remaining local issue"] });
  updateProjectDirection({ root: f.root, input: { goal: "Inspect only", constraints: ["Synthetic data only"], cancelledActions: ["Do not deploy"] } });
  const before = snapshot(f.base), writes = []; let tracking = false;
  for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "renameSync", "unlinkSync", "rmSync", "rmdirSync"]) {
    const original = fs[name];
    t.mock.method(fs, name, function(...args) { if (tracking) writes.push(name); return original.apply(this, args); });
  }
  f.nativeRecord.title = "Untrusted title must not become recovery direction";
  tracking = true;
  let output;
  try { output = await f.transform(); } finally { tracking = false; }
  const value = context(output);
  assert.deepEqual(writes, []); assert(!output.system.at(-1).includes(f.nativeRecord.title));
  assert.equal(value.logicalSessionId, f.session.sessionId);
  assert.equal(value.sessionPurpose, "Synthetic local investigation; no external effects");
  assert(value.records.some(r => r.content.summary === "Recorded exact work body"));
  assert.deepEqual(value.currentProjectDirection.input.cancelledActions, ["Do not deploy"]);
  assert.equal(value.persisted, false); assert.equal(value.ordinaryWorkBlocked, false); assert.equal(value.userDecisionRequired, false);
  assert.equal(output.system[0], "Original system");
  assert.deepEqual(snapshot(f.base), before);
  assert.equal(f.calls[0].path.id, f.native); assert.equal(f.calls[0].query.directory, f.root); assert(f.calls[0].signal instanceof AbortSignal);
});

test("same output is refreshed once; independent next requests receive context even with the same basis", async t => {
  const f = await setup(t), output = await f.transform();
  const first = output.system.at(-1), sameArray = output.system;
  await f.transform(output);
  assert.equal(output.system, sameArray); assert.equal(output.system.length, 2); assert.equal(output.system.at(-1), first);
  const next = await f.transform();
  assert.equal(next.system.length, 2); assert.equal(next.system.at(-1), first); assert.equal(f.calls.length, 3);
  updateProjectDirection({ root: f.root, input: { goal: "Changed current direction", cancelledActions: ["New cancellation"] } });
  await f.transform(output);
  assert.equal(output.system.length, 2); assert.equal(context(output).currentProjectDirection.input.goal, "Changed current direction");
  assert.deepEqual(context(output).currentProjectDirection.input.cancelledActions, ["New cancellation"]);
});

test("selection changes within the same native caller are read anew instead of retaining the previous Session", async t => {
  const f = await setup(t), first = await f.transform();
  const other = createHeadSession({ root: f.root, purpose: "Different selected investigation" });
  f.adapter.select({ root: f.root, sessionId: other.sessionId, expectedRevision: f.adapter.read({ root: f.root }).revision });
  const next = await f.transform(first);
  assert.equal(next.system.length, 2); assert.equal(context(next).logicalSessionId, other.sessionId);
  assert.equal(context(next).sessionPurpose, "Different selected investigation");
  assert(!next.system.at(-1).includes(f.session.sessionId));
});

test("absent, pending and lost binding never substitute the valid default Session", async t => {
  const f = await setup(t, { selected: false });
  const read = fs.readFileSync, defaultFile = path.join(f.root, ".lode/sessions/current.json"), defaultReads = [];
  t.mock.method(fs, "readFileSync", function(file, ...args) {
    if (file === defaultFile) defaultReads.push(file);
    return read.call(this, file, ...args);
  });
  for (const state of ["absent", "pending", "lost"]) {
    if (state === "pending") f.adapter.prepareSelection({ root: f.root, sessionId: f.session.sessionId });
    if (state === "lost") f.adapter.lose({ root: f.root, expectedRevision: f.adapter.read({ root: f.root }).revision });
    const before = snapshot(f.base); defaultReads.length = 0;
    const value = context(await f.transform());
    assert.deepEqual(defaultReads, [], "The default P2 record is not read and then hidden");
    assert.equal(value.status, "session_selection_unresolved"); assert.equal(value.logicalSessionId, null); assert.equal(value.route, null);
    assert.deepEqual(value.records, []); assert.equal(value.sessionPurpose, null);
    assert.deepEqual(snapshot(f.base), before);
  }
});

test("child/fork does not inherit its parent's binding; different Projects with identical native IDs stay separate", async t => {
  const parent = await setup(t), child = "ses_child";
  parent.nativeRecord.id = child; parent.nativeRecord.parentID = parent.native;
  const value = context(await parent.transform(undefined, child));
  assert.equal(value.logicalSessionId, null); assert.equal(value.sessionPurpose, null);
  const other = await setup(t, { native: parent.native, projectID: "another-host-project" });
  const a = context(await parent.transform(undefined, child)), b = context(await other.transform());
  assert.equal(a.logicalSessionId, null); assert.equal(b.logicalSessionId, other.session.sessionId);
  assert.equal(b.projectRoot, other.root); assert.notEqual(b.projectRoot, parent.root);
});

test("wrong native identity, Project or directory, malformed/oversized SDK responses and missing ID leave other output intact", async t => {
  const f = await setup(t), original = f.client.session.get;
  const responses = [{ data: { ...f.nativeRecord, id: "wrong" } }, { data: { ...f.nativeRecord, projectID: "wrong" } },
    { data: { ...f.nativeRecord, directory: path.parse(f.root).root } }, { data: { ...f.nativeRecord, extra: "x".repeat(70 * 1024) } },
    { data: null }, { data: [] }, { error: { status: 404 } }];
  const before = snapshot(f.base);
  for (const result of responses) {
    f.client.session.get = async () => result;
    const output = { system: ["System", "Another plugin"] }; await f.transform(output);
    assert.deepEqual(output.system, ["System", "Another plugin"]);
  }
  f.client.session.get = original;
  for (const id of [undefined, null, "", "bad\nidentity"]) {
    const output = { system: ["System"] };
    await f.hooks["experimental.chat.system.transform"]({ sessionID: id }, output);
    assert.deepEqual(output.system, ["System"]);
  }
  assert.deepEqual(snapshot(f.base), before);
});

test("other plugin strings, user prompts and summary prompts remain unchanged; callback return values are unused", async t => {
  const f = await setup(t), messages = [{ role: "user", content: "Do not change this user prompt" }];
  const other = { async "experimental.chat.system.transform"(_input, output) { output.system.push("Other plugin system"); return { system: ["Ignored return"] }; } };
  for (const summary of [false, true]) {
    const prompt = summary ? "Original summary agent prompt" : "Original ordinary agent prompt";
    const result = await prepareRequest([other, f.hooks], f.native, { system: [prompt], messages });
    assert.equal(result.output.system[0], prompt); assert.equal(result.output.system[1], "Other plugin system");
    assert.equal(result.messages.at(-1), messages[0]); assert(result.messages.some(m => m.role === "system" && m.content.includes(f.session.sessionId)));
    assert(!result.output.system.includes("Ignored return"));
  }
  const oauth = await prepareRequest([f.hooks], f.native, { messages, oauth: true });
  assert.equal(oauth.messages, messages); assert(oauth.options.instructions.includes(f.session.sessionId));
});

test("oversized projection stays bounded, labels omitted originals and preserves exact expansion routes", () => {
  const id = "session-AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
  const text = startupProjection({ status: "serializer-only", currentProjectDirection: { directionId: "direction-fixture", directionHash: "a".repeat(64),
    input: { goal: "Current goal".repeat(12000), cancelledActions: ["No deployment"] } },
  workContext: { sessionId: id, sessionPurpose: "Selected purpose", records: [{ evidenceId: "fixture-evidence", content: { summary: "x".repeat(50000) } }] } }, pluginRoot, "opencode");
  const value = JSON.parse(text);
  assert(text.length <= MAX_CONTEXT_CHARACTERS.opencode); assert.equal(value.currentProjectDirection.contentIncluded, false);
  assert(value.requiredSourceExpansion); assert.equal(value.omittedEvidenceCount, 1); assert.equal(value.route.session_id, id);
  assert.match(value.expansion, /lode_conversation_enter/); assert.equal(value.persisted, false);
});

test("renderer failure is bounded optional context, never a save/bind gate or a Host failure", async t => {
  const f = await setup(t), stringify = JSON.stringify, before = snapshot(f.base);
  t.mock.method(JSON, "stringify", function(value, ...args) {
    if (value?.hostCapability && Array.isArray(value.omittedEvidenceIds)) throw Object.assign(new Error("Synthetic render failure"), { code: "SYNTHETIC_RENDER_FAILURE" });
    return stringify.call(this, value, ...args);
  });
  const output = await f.transform();
  assert.equal(output.system[0], "Original system"); assert.match(output.system.at(-1), /SYNTHETIC_RENDER_FAILURE/);
  assert.doesNotMatch(output.system.at(-1), /must bind|must save|approval required/i);
  assert.deepEqual(snapshot(f.base), before);
});

test("unsupported code-mode, frozen output, restart and disposal do not block ordinary work or reuse a global caller", async t => {
  const f = await setup(t), before = snapshot(f.base);
  await f.hooks.config({ experimental: { code_mode: true } });
  assert.deepEqual((await f.transform()).system, ["Original system"]);
  await f.hooks.config({});
  const frozen = { system: Object.freeze(["Frozen original"]) }; await f.transform(frozen);
  assert.deepEqual(frozen.system, ["Frozen original"]);
  await f.hooks.dispose(); assert.deepEqual((await f.transform()).system, ["Original system"]);
  const restarted = await plugin.server({ client: f.client, project: { id: f.projectID }, directory: f.root }, { environment: f.environment });
  t.after(() => restarted.dispose());
  const output = { system: ["Restarted original"] };
  await restarted["experimental.chat.system.transform"]({ sessionID: f.native }, output);
  assert.equal(context(output).logicalSessionId, f.session.sessionId); assert.deepEqual(snapshot(f.base), before);
});

test("in-flight SDK lookup after disposal cannot inject context or write records", async t => {
  const f = await setup(t), before = snapshot(f.base); let finish;
  f.client.session.get = () => new Promise(resolve => { finish = resolve; });
  const output = { system: ["Original system"] }, pending = f.transform(output);
  await f.hooks.dispose(); finish({ data: { ...f.nativeRecord } }); await pending;
  assert.deepEqual(output.system, ["Original system"]); assert.deepEqual(snapshot(f.base), before);
});

test("lookup exceptions and bounded timeout preserve independent Host output and abort the optional lookup", async t => {
  const f = await setup(t), before = snapshot(f.base);
  f.client.session.get = async () => { throw new Error("Synthetic optional SDK failure"); };
  assert.deepEqual((await f.transform()).system, ["Original system"]);
  let aborted = false;
  f.client.session.get = ({ signal }) => new Promise(resolve => signal.addEventListener("abort", () => { aborted = true; resolve({ error: "cancelled" }); }));
  assert.deepEqual((await f.transform()).system, ["Original system"]);
  assert.equal(aborted, true); assert.deepEqual(snapshot(f.base), before);
});

test("corrupt existing linkage stays unresolved without repair or default direction", async t => {
  const f = await setup(t);
  const binding = fs.readdirSync(f.operational, { recursive: true }).find(p => p.endsWith("binding.json"));
  fs.writeFileSync(path.join(f.operational, binding), "{corrupt");
  const before = snapshot(f.base), value = context(await f.transform());
  assert.equal(value.logicalSessionId, null); assert.equal(value.status, "session_selection_unresolved");
  assert.deepEqual(value.records, []); assert.deepEqual(snapshot(f.base), before);
});

test("concurrent duplicate output is delivered once without serializing unrelated requests", async t => {
  const f = await setup(t), resolves = [];
  f.client.session.get = () => new Promise(resolve => resolves.push(resolve));
  const output = { system: ["Original system", "Other plugin"] };
  const first = f.transform(output), second = f.transform(output), unrelated = f.transform();
  resolves[1]({ data: { ...f.nativeRecord } }); await second;
  resolves[2]({ data: { ...f.nativeRecord } }); const independent = await unrelated;
  resolves[0]({ data: { ...f.nativeRecord } }); await first;
  assert.equal(output.system.length, 3); assert.equal(independent.system.length, 2);
  assert.equal(context(output).logicalSessionId, f.session.sessionId);
});

test("a later invalid caller on reused output removes only our previous direction and fences the earlier pending request", async t => {
  const f = await setup(t), output = await f.transform();
  updateProjectDirection({ root: f.root, input: { goal: "Local inspection only", cancelledActions: ["Do not publish"] } });
  const before = snapshot(f.base), resolves = [];
  f.client.session.get = () => new Promise(resolve => resolves.push(resolve));
  const pendingEarlier = f.transform(output);
  output.system.push("Other plugin remains intact");
  const invalidLater = f.transform(output, "ses_unverified");
  resolves[1]({ data: { ...f.nativeRecord, id: "wrong-caller" } }); await invalidLater;
  resolves[0]({ data: { ...f.nativeRecord } }); await pendingEarlier;
  assert.deepEqual(output.system, ["Original system", "", "Other plugin remains intact"]);
  assert(!output.system.some(text => text.includes(f.session.sessionId)));
  assert(!output.system.some(text => text.includes("Do not deploy")));
  assert.deepEqual(snapshot(f.base), before, "Loss of optional delivery never writes selection or fallback direction");
});

test("generated canonical/legacy packages contain and load the private renderer through the actual OpenCode shim", async t => {
  const f = await setup(t);
  for (const [provider, build] of [["codex", buildCodexMarketplaceSnapshot], ["claude", buildClaudeMarketplaceSnapshot]]) {
    for (const name of ["lode-agent-plugin", "head-agent-plugin"]) {
      const packageRoot = path.join(f.base, `${provider}-${name}`), built = build({ sourceRoot: pluginRoot, outputRoot: packageRoot, name, repository: "local", commit: "local" });
      const root = path.join(packageRoot, "plugins", built.pluginName), entry = path.join(root, "scripts/opencode-plugin.mjs");
      assert(fs.existsSync(path.join(root, "scripts/lib/session-host-context-projection.mjs")));
      const shim = path.join(f.base, `${provider}-${name}.mjs`);
      fs.writeFileSync(shim, `export {default} from ${JSON.stringify(pathToFileURL(entry).href)};\n`);
      const loaded = await import(pathToFileURL(shim).href), hooks = await loaded.default.server({ client: f.client, project: { id: f.projectID }, directory: f.root }, { environment: f.environment });
      try {
        const before = snapshot(f.root), output = { system: ["Packaged caller"] };
        await hooks["experimental.chat.system.transform"]({ sessionID: f.native }, output);
        assert.equal(context(output).logicalSessionId, f.session.sessionId); assert.deepEqual(snapshot(f.root), before);
      } finally { await hooks.dispose(); }
    }
  }
});

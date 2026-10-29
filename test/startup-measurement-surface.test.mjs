import { relativeProjectArtifact } from "../scripts/lib/project-storage-format.mjs";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { defineMetric, recordMetricObservation } from "../scripts/lib/measurement-workflow.mjs";
import { readObservation } from "../scripts/lib/observation-store.mjs";
import { buildWorldModel } from "../scripts/lib/world-model.mjs";
import { createHeadSession } from "../scripts/lib/session-routing.mjs";
import { createSessionHostAdapter } from "../scripts/lib/session-host-adapter.mjs";
import { createNativeObservationStore, NATIVE_OBSERVATION_LIMITS } from "../scripts/lib/native-session-observations.mjs";
import { sessionStartContext } from "../scripts/session-host-hook.mjs";
import { updateProjectDirection } from "../scripts/lib/project-direction.mjs";
import { runCommand } from "../scripts/head.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";
import { formatCliResult, formatMcpToolContent } from "../scripts/lib/cli-presentation.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const definition = { metricKey: "queue-duration", unit: "milliseconds", direction: "decrease" };
function fixture(t) {
  const parent = process.env.HEAD_AGENT_TEST_TMP || os.tmpdir(); fs.mkdirSync(parent, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, "head-startup-measurement-surface-")));
  if (process.env.HEAD_AGENT_KEEP_TEST_TMP !== "1") t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initializeProject({ root, pluginRoot, runtimes: ["codex", "claude"] });
  return { root, storage: inspectProject(root).storage };
}
function snapshot(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter(item => item.isFile()).map(item => {
    const file = path.join(item.parentPath, item.name), stat = fs.statSync(file);
    return [path.relative(root, file), sha(fs.readFileSync(file)), stat.mtimeMs, stat.mode];
  }).sort(([a], [b]) => a.localeCompare(b));
}
function authority(root, storage) {
  return [["project.json"], ["context", "product-model.json"], ["sessions", "current.json"]].map(parts => relativeProjectArtifact(storage, ...parts)).map(file => {
    const bytes = fs.readFileSync(path.join(root, file)); return [file, sha(bytes)];
  });
}
const observed = (number, value) => ({ metricKey: definition.metricKey, subjectType: "service", subjectKey: "synthetic-api", value,
  observedAt: `2026-01-0${number}T00:00:00.000Z`, sourceScopeDigest: sha("synthetic-scope"),
  sourceEventKeyDigest: sha(`event-${number}`), sourceEvidenceDigest: sha(`evidence-${number}`) });
const typed = input => Object.fromEntries(Object.entries(input).map(([key, value]) => [key.replace(/[A-Z]/g, part => `_${part.toLowerCase()}`), value]));
async function call(root, name, args, routed = false) {
  const response = await dispatch({ jsonrpc: "2.0", id: "synthetic-surface", method: "tools/call", params: {
    name: routed ? "head_tools_call" : name,
    arguments: routed ? { name, arguments: { project_root: root, ...args } } : { project_root: root, ...args },
  } });
  assert.equal(response.error, undefined, JSON.stringify(response));
  assert.equal(response.result?.isError, undefined, JSON.stringify(response));
  const result = response.result;
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.equal(result.content[0].text, formatMcpToolContent(name, result.structuredContent));
  return result.structuredContent;
}

for (const operation of ["define", "observe", "compare"]) test(`committed metric ${operation} survives CLI and MCP direct/router presentation under derived failure`, async t => {
  const { root, storage } = fixture(t); let input, id;
  if (operation !== "define") await defineMetric({ root, ...definition });
  else await buildWorldModel({ root, persist: true });
  if (operation === "define") { input = definition; id = result => result.descriptor.descriptorId; }
  if (operation === "observe") { input = observed(1, 70); id = result => result.observation.observationId; }
  if (operation === "compare") {
    const baseline = await recordMetricObservation({ root, ...observed(1, 70) });
    const current = await recordMetricObservation({ root, ...observed(2, 40) });
    input = { baselineObservationId: baseline.observation.observationId, currentObservationId: current.observation.observationId };
    id = result => result.comparison.derivedObservationId;
  }
  const pointer = path.join(root, relativeProjectArtifact(storage, "world-model", "current.json")), broken = "{synthetic-broken-derived-pointer";
  fs.writeFileSync(pointer, broken);
  const requestFile = path.join(root, "synthetic-input.json"); fs.writeFileSync(requestFile, JSON.stringify(input));
  const beforeAuthority = authority(root, storage);
  const command = `metric-${operation}`, tool = `head_metric_${operation}`;
  const cli = await runCommand([command, root, "--input", requestFile]);
  assert.equal(cli.status, "recorded"); assert.equal(cli.worldModel.status, "deferred");
  assert.equal(cli.worldModel.reasonCode, "INVALID_WORLD_MODEL_STORE_DOCUMENT");
  assert.equal(cli.ordinaryWorkBlocked, false);
  assert.deepEqual(JSON.parse(formatCliResult(command, cli)), cli);
  const originals = snapshot(path.join(root, relativeProjectArtifact(storage, "observations")));
  assert.ok(originals.length > 0, "The durable original store must actually be inspected");
  for (const routed of [false, true]) {
    const result = await call(root, tool, typed(input), routed);
    assert.equal(result.status, "existing"); assert.equal(id(result), id(cli));
    assert.deepEqual(result.worldModel, cli.worldModel); assert.equal(result.ordinaryWorkBlocked, false);
    if (operation === "observe") {
      assert.equal(result.receipt.receiptId, cli.receipt.receiptId);
      assert.equal(readObservation({ root, observationId: id(result) }).receipt.receiptId, result.receipt.receiptId);
    }
    if (operation === "compare") {
      assert.deepEqual(result.comparability, cli.comparability); assert.equal(result.causalityEstablished, false);
      assert.deepEqual(readObservation({ root, observationId: id(result) }).observation, result.comparison);
    }
  }
  assert.deepEqual(snapshot(path.join(root, relativeProjectArtifact(storage, "observations"))), originals);
  assert.deepEqual(authority(root, storage), beforeAuthority); assert.equal(fs.readFileSync(pointer, "utf8"), broken);
});

test("healthy metric consumer retains the original two-ID World response and JSON presentation", async t => {
  const { root, storage } = fixture(t), file = path.join(root, "synthetic-input.json"); fs.writeFileSync(file, JSON.stringify(definition));
  const cli = await runCommand(["metric-define", root, "--input", file]);
  const result = await call(root, "head_metric_define", typed(definition));
  assert.deepEqual(Object.keys(cli.worldModel).sort(), ["graphSnapshotId", "worldModelId"]);
  assert.deepEqual(Object.keys(result.worldModel).sort(), ["graphSnapshotId", "worldModelId"]);
  assert.equal(result.descriptor.descriptorId, cli.descriptor.descriptorId);
  assert.deepEqual(JSON.parse(formatCliResult("metric-define", cli)), cli);
});

test("actual hook command retains no-checkpoint purpose and unavailable direction; only optional caller P5 is written", async t => {
  const { root, storage } = fixture(t), operational = `${root}-host`;
  if (process.env.HEAD_AGENT_KEEP_TEST_TMP !== "1") t.after(() => fs.rmSync(operational, { recursive: true, force: true }));
  const selected = createHeadSession({ root, purpose: "Explain this synthetic issue only; no external effects" });
  // An absent synthetic registry prevents consulting the user's actual Claude registry.
  const environment = { HEAD_AGENT_OPERATIONAL_STATE_ROOT: operational, CLAUDE_CONFIG_DIR: path.join(root, "synthetic-claude-config") };
  const host = createSessionHostAdapter({ runtime: "claude", nativeSessionId: "synthetic-hook-caller", environment });
  assert.equal(host.select({ root, sessionId: selected.sessionId, expectedRevision: 0 }).retained, true);
  updateProjectDirection({ root, input: { goal: "Read locally", cancelledActions: ["deploy"] } });
  fs.unlinkSync(path.join(root, relativeProjectArtifact(storage, "project-direction", "current.json")));
  const before = snapshot(root), beforeOperational = snapshot(operational);
  const event = { hook_event_name: "SessionStart", source: "compact", session_id: "synthetic-hook-caller", cwd: root,
    prompt: "synthetic-private-prompt", last_assistant_message: "synthetic-private-response",
    token: "synthetic-private-token", command: "synthetic-private-command" };
  const output = spawnSync(process.execPath, [path.join(pluginRoot, "scripts/session-host-hook.mjs"), "--runtime", "claude"], {
    cwd: root, windowsHide: true, encoding: "utf8", env: { ...process.env, ...environment },
    input: JSON.stringify(event),
  });
  assert.equal(output.status, 0, output.stderr);
  const hook = JSON.parse(output.stdout), text = hook.hookSpecificOutput.additionalContext, context = JSON.parse(text);
  assert.ok(text.length <= 10000); assert.equal(context.logicalSessionId, selected.sessionId);
  assert.equal(context.sessionPurpose, "Explain this synthetic issue only; no external effects");
  assert.equal(context.currentProjectDirectionAvailability.status, "unavailable");
  assert.equal(context.currentProjectDirectionAvailability.reasonCode, "PROJECT_DIRECTION_UNAVAILABLE");
  assert.equal(context.currentProjectDirectionAvailability.dependentEffectsBlocked, true);
  assert.equal(context.persisted, false); assert.equal(context.ordinaryWorkBlocked, false);
  assert.equal(context.sessionRecovery, null); assert.equal(hook.hookSpecificOutput.permissionDecision, undefined);
  assert.deepEqual(snapshot(root), before);
  const project = JSON.parse(fs.readFileSync(path.join(root, relativeProjectArtifact(storage, "project.json")), "utf8"));
  const owner = { projectId: project.projectId, rootDigest: sha(fs.realpathSync(root)),
    callerDigest: sha(JSON.stringify(["claude", "synthetic-hook-caller", null])) };
  const snapshotRelative = path.join("native-observations", sha(JSON.stringify(owner)), "snapshot.json");
  assert.deepEqual(snapshot(operational).filter(([file]) => file !== snapshotRelative), beforeOperational,
    "Existing binding bytes/mtime/mode remain exact; no other operational artifact or lock may be added.");
  assert.equal(snapshot(operational).length, beforeOperational.length + 1);
  const raw = fs.readFileSync(path.join(operational, snapshotRelative), "utf8");
  assert.ok(Buffer.byteLength(raw) <= NATIVE_OBSERVATION_LIMITS.bytes);
  assert.doesNotMatch(raw, /synthetic-private-/u);
  const afterOperational = snapshot(operational);
  // Validates schema, exact owner, digest and every slot/replay bound without writing.
  const state = createNativeObservationStore({ environment }).read({ root,
    caller: { runtime: "claude", nativeSessionId: "synthetic-hook-caller", agentId: null } });
  assert.deepEqual(state.owner, owner);
  assert.equal(state.kind, "NativeObservationSnapshot"); assert.equal(state.version, 1);
  assert.equal(state.sequence, 1); assert.equal(state.omitted, 0); assert.deepEqual(state.replay, []);
  assert.equal(state.rows.length, 1);
  assert.deepEqual(state.rows[0].observation, { kind: "event", event: "SessionStart", phase: "start-observed",
    requestId: null, source: "compact", reason: null });
  assert.deepEqual((await sessionStartContext({ runtime: "claude", environment, event })), hook);
  assert.deepEqual(snapshot(root), before);
  assert.deepEqual(snapshot(operational), afterOperational, "Subsequent observation/startup reads have zero writes.");
});

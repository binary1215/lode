import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ARTIFACT_COMPOSITION, artifactCompositionForIdentity, publicToolName } from "../scripts/lib/lode-artifact-composition.mjs";
import { OPERATION_DESCRIPTORS, resolveOperation } from "../scripts/lib/lode-operation-contract.mjs";
import { dispatch, tools, toolsForSurface, catalogTools, discoverTools } from "../scripts/mcp-server.mjs";
import { runCommand } from "../scripts/lode.mjs";
import { workerIntegrationFixture } from "./helpers/worker-integration-fixture.mjs";
import { readRuntimeInvocationResult } from "../scripts/lib/runtime-run-result-application.mjs";

const request = name => dispatch({ jsonrpc: "2.0", id: "lode-composition-contract", method: "tools/call", params: { name, arguments: {} } });

test("one fixed source composition exposes one finite tool vocabulary and exact compatibility aliases", () => {
  assert.deepEqual(ARTIFACT_COMPOSITION, {
    identity: "lode", toolPrefix: "lode_", serverName: "lode", packageName: "@local/lode-agent-core-plugin",
    pluginName: "lode-agent-core", marketplaceName: "lode-agent-plugin", cliEntry: "scripts/lode.mjs",
    skills: { core: "lode-agent-core", onboarding: "lode-agent-onboarding", conversation: "lode-conversation" },
  });
  assert.ok(Object.isFrozen(ARTIFACT_COMPOSITION)); assert.ok(Object.isFrozen(ARTIFACT_COMPOSITION.skills));
  assert.equal(OPERATION_DESCRIPTORS.length, 136);
  assert.equal(new Set(OPERATION_DESCRIPTORS.flatMap(item => [item.legacyName, item.canonicalName])).size, 272);
  for (const item of OPERATION_DESCRIPTORS) {
    assert.equal(resolveOperation(item.legacyName), item); assert.equal(resolveOperation(item.canonicalName), item);
    assert.equal(item.semanticName, item.legacyName);
    assert.equal(publicToolName(item.legacyName), item.canonicalName); assert.equal(publicToolName(item.canonicalName), item.canonicalName);
  }
  for (const unknown of ["lode_unknown_mutation", "head_unknown_mutation", "lode_head_core_contract", "HEAD_core_contract", "head_core_contract_typo"]) {
    assert.equal(resolveOperation(unknown), null); assert.equal(publicToolName(unknown), unknown);
  }
  assert.equal(tools.length, 22);
  assert.ok(tools.every(tool => tool.name.startsWith("lode_")));
  assert.ok(catalogTools.every(tool => tool.name.startsWith("lode_")));
  assert.equal(new Set(catalogTools.map(tool => tool.name)).size, catalogTools.length);
  assert.equal(catalogTools.length, 133, "Discovery and the two routers are not private operation catalog entries");
  const routingSurface = new Map([["lode_tools_discover", false], ["lode_tools_read", true], ["lode_tools_call", true]]);
  const stableSurface = toolsForSurface();
  for (const tool of tools) {
    if (!routingSurface.has(tool.name)) assert.equal(catalogTools.find(item => item.name === tool.name), tool);
    else {
      assert.equal(catalogTools.some(item => item.name === tool.name), false);
      assert.equal(stableSurface.find(item => item.name === tool.name), tool);
      const descriptor = resolveOperation(tool.name);
      assert.equal(descriptor.canonicalName, tool.name); assert.equal(descriptor.router, routingSurface.get(tool.name));
    }
  }
});

test("strict listed client uses canonical discovery while legacy dispatch remains the same implementation", async () => {
  const advertised = new Set(tools.map(tool => tool.name));
  async function strictCall(name) { assert.ok(advertised.has(name), `Unlisted tool: ${name}`); return request(name); }
  const canonical = await strictCall("lode_core_contract");
  assert.equal(canonical.error, undefined);
  const legacy = await request("head_core_contract");
  assert.deepEqual(legacy, canonical);
  await assert.rejects(strictCall("head_core_contract"), /Unlisted tool/);
  assert.ok((await request("lode_core_contract_typo")).error);
  const discovered = discoverTools({ name: "lode_core_contract" });
  assert.equal(discovered.tools.length, 1); assert.equal(discovered.tools[0].name, "lode_core_contract");
  assert.equal(discovered.tools[0].invokeWith, "lode_tools_read");
});

test("legacy carrier metadata is a separate fixed vocabulary, not a runtime Project selector", () => {
  const legacy = artifactCompositionForIdentity("head");
  assert.equal(legacy.serverName, "lode"); assert.equal(legacy.toolPrefix, "head_");
  assert.deepEqual(legacy.skills, { core: "head-agent-core", onboarding: "head-agent-onboarding", conversation: "head-conversation" });
  assert.equal(ARTIFACT_COMPOSITION.identity, "lode", "Looking up carrier metadata must not switch active composition");
  assert.throws(() => artifactCompositionForIdentity("typo"), /Unknown package artifact composition/);
  // Actual carrier staging/listed-client execution is a separate distribution test,
  // not proved by this pure metadata lookup or by unlisted alias dispatch.
});

function compositionSnapshot(root) {
  const entries = [];
  function walk(relative) {
    const file = path.join(root, relative), stat = fs.lstatSync(file);
    const type = stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : "file";
    entries.push({ path: file, type, mode: stat.mode, mtimeMs: stat.mtimeMs,
      ...(type === "file" ? { bytes: fs.readFileSync(file).toString("base64") } : type === "link" ? { target: fs.readlinkSync(file) } : {}) });
    if (type === "directory") for (const name of fs.readdirSync(file).sort()) walk(path.join(relative, name));
  }
  walk(""); return entries;
}
function missingCompositionFixture(t) {
  const parent = process.env.LODE_AGENT_TEST_TMP || process.env.HEAD_AGENT_TEST_TMP || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const base = fs.realpathSync(fs.mkdtempSync(path.join(parent, "lode-public-guards-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: process.platform === "win32" ? 20 : 0, retryDelay: 100 }));
  return { base, root: path.join(base, "nonexistent-project") };
}
async function withoutCompositionEffects(scope, action, forbiddenRoot = null) {
  const before = compositionSnapshot(scope), originals = [], writes = [], forbiddenReads = [];
  const fileOf = value => value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : typeof value === "string" ? value : null;
  const inside = (root, value) => {
    const file = fileOf(value); if (!root || file === null) return false;
    const relative = path.relative(root, path.resolve(file));
    return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const destinations = new Set(["rename", "copyFile", "cp", "link", "symlink"]);
  function guard(object, name, mode) {
    const original = object[name]; if (typeof original !== "function") return;
    originals.push([object, name, original]);
    const wrapped = (...args) => {
      const flags = args[1] ?? "r";
      const writable = mode === "write" || mode === "open" && (typeof flags === "number"
        ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) : /[wa+]/.test(String(flags)));
      if (writable && (inside(scope, args[0]) || destinations.has(name.replace(/Sync$/, "")) && inside(scope, args[1]) || typeof args[0] === "number" || args[0] && typeof args[0].fd === "number")) {
        writes.push({ method: name, source: fileOf(args[0]) ?? args[0] });
        assert.fail(`Public read/invalid request attempted ${name}`);
      }
      if (!writable && inside(forbiddenRoot, args[0])) {
        forbiddenReads.push({ method: name, path: fileOf(args[0]) });
        assert.fail(`Input validation touched the nonexistent Project through ${name}`);
      }
      return original.apply(object, args);
    };
    Object.assign(wrapped, original); object[name] = wrapped;
  }
  for (const name of ["writeFile", "appendFile", "mkdir", "rename", "unlink", "rm", "rmdir", "truncate", "chmod", "utimes", "copyFile", "cp", "link", "symlink", "lchown", "chown", "lutimes", "mkdtemp", "write", "writev", "ftruncate", "fchmod", "fchown", "futimes"]) {
    guard(fs, name, "write"); guard(fs, `${name}Sync`, "write"); guard(fs.promises, name, "write");
  }
  for (const name of ["readFile", "readdir", "readlink", "stat", "lstat", "realpath", "access", "exists"]) {
    guard(fs, name, "read"); guard(fs, `${name}Sync`, "read"); guard(fs.promises, name, "read");
  }
  guard(fs, "open", "open"); guard(fs, "openSync", "open"); guard(fs.promises, "open", "open"); guard(fs, "createWriteStream", "write");
  syncBuiltinESMExports();
  try { return await action(); }
  finally {
    for (const [object, name, original] of originals.reverse()) object[name] = original;
    syncBuiltinESMExports(); assert.deepEqual(forbiddenReads, []); assert.deepEqual(writes, []);
    assert.deepEqual(compositionSnapshot(scope), before);
  }
}
const workerInputFields = { integrationId: "integration_id", verificationId: "verification_id", basisDigest: "basis_digest",
  authorizationIds: "authorization_ids", maxBytes: "max_bytes", retryKnownNoWrite: "retry_known_no_write" };
const typedWorkerInput = input => Object.fromEntries(Object.entries(input).map(([key, value]) => [workerInputFields[key] || key, value]));
const workerIdentity = `worker-integration-${"a".repeat(24)}--${"b".repeat(24)}`;
const authorizationIdentity = `execution-authorization-${"c".repeat(24)}`;
const malformedWorkerRequests = [
  { name: "action", input: { action: "not-an-action" }, code: "WORKER_INTEGRATION_INPUT_INVALID", message: "Unknown worker integration action." },
  { name: "unexpected field", input: { action: "reconcile", integrationId: workerIdentity, extra: true }, code: "WORKER_INTEGRATION_INPUT_INVALID", message: "Unsupported worker integration fields: extra." },
  { name: "identity", input: { action: "reconcile", integrationId: "not-an-integration" }, code: "WORKER_INTEGRATION_INPUT_INVALID", message: "Invalid worker integration identity." },
  { name: "retry boolean", input: { action: "apply", integrationId: workerIdentity, retryKnownNoWrite: "yes" }, code: "WORKER_INTEGRATION_INPUT_INVALID", message: "retryKnownNoWrite must be a boolean." },
  { name: "prepare identities", input: { action: "prepare", authorizationIds: [], maxBytes: 1 }, code: "WORKER_PATCH_INTEGRATION_CONFLICT", message: "Integration requires distinct worker identities and a finite byte bound." },
  { name: "prepare byte bound", input: { action: "prepare", authorizationIds: [authorizationIdentity], maxBytes: -1 }, code: "WORKER_PATCH_INTEGRATION_CONFLICT", message: "Integration requires distinct worker identities and a finite byte bound." },
  { name: "settlement explanation", input: { action: "settle-incomplete", integrationId: workerIdentity, basisDigest: "0".repeat(64), reason: "" }, code: "WORKER_INTEGRATION_APPLICATION_CONFLICT", message: "Incomplete handoff needs a bounded explanation, not executable instructions." },
];

for (const scenario of malformedWorkerRequests) test(`worker ${scenario.name} keeps its primary error before nonexistent Project selection in CLI and both MCP aliases`, async t => {
  const f = missingCompositionFixture(t), inputFile = path.join(f.base, "request.json");
  fs.writeFileSync(inputFile, JSON.stringify(scenario.input));
  await withoutCompositionEffects(f.base, async () => {
    await assert.rejects(async () => await runCommand(["managed-maintenance", "worker-integrate", f.root, "--input", inputFile]), error => {
      assert.equal(error.constructor, Error); assert.equal(error.code, scenario.code); assert.equal(error.message, scenario.message); return true;
    });
    for (const name of ["lode_worker_integration", "head_worker_integration"]) {
      const result = await dispatch({ jsonrpc: "2.0", id: "missing-worker-project", method: "tools/call", params: { name,
        arguments: { project_root: f.root, ...typedWorkerInput(scenario.input) } } }, { surface: "managed-maintenance" });
      assert.deepEqual(result.error, { code: -32000, message: scenario.message });
    }
  }, f.root);
  assert.equal(fs.existsSync(f.root), false);
});

test("invalid status and runtime-result identities retain their exact primary errors before Project reads", async t => {
  const f = missingCompositionFixture(t);
  for (const scenario of [
    { command: "worker-integration-status", option: "--integration", tools: ["lode_worker_integration_status", "head_worker_integration_status"], key: "integration_id", code: "WORKER_INTEGRATION_INPUT_INVALID", message: "Invalid worker integration identity." },
    { command: "runtime-invocation-result", option: "--authorization", tools: ["lode_runtime_invocation_result", "head_runtime_invocation_result"], key: "authorization_id", code: "INVALID_RUNTIME_INVOCATION_AUTHORIZATION_ID", message: "Runtime invocation authorization id is invalid." },
  ]) await withoutCompositionEffects(f.base, async () => {
    await assert.rejects(async () => await runCommand([scenario.command, f.root, scenario.option, "invalid"]), error => {
      assert.equal(error.constructor, Error); assert.equal(error.code, scenario.code); assert.equal(error.message, scenario.message); return true;
    });
    for (const name of scenario.tools) {
      const result = await dispatch({ jsonrpc: "2.0", id: "missing-read-project", method: "tools/call", params: { name,
        arguments: { project_root: f.root, [scenario.key]: "invalid" } } });
      assert.deepEqual(result.error, { code: -32000, message: scenario.message });
    }
  }, f.root);
  assert.equal(fs.existsSync(f.root), false);
});

test("selected Lode storage reaches the existing runtime result and worker status through CLI and both MCP aliases without effects", async t => {
  const f = await workerIntegrationFixture(t), authorizationId = f.members[0].authorizationId;
  assert.equal(f.storage.directory, ".lode");
  const frozen = compositionSnapshot(f.container);
  assert.ok(frozen.some(entry => entry.path === f.sessionFile));
  assert.ok(frozen.some(entry => entry.path === f.runFile));
  assert.ok(frozen.some(entry => entry.path.endsWith(`${authorizationId}${path.sep}receipt.json`)), "Fixture must contain the actual persisted lower runtime record");
  await withoutCompositionEffects(f.container, async () => {
    const expectedRuntime = readRuntimeInvocationResult({ root: f.root, authorizationId, storage: f.storage });
    assert.equal(expectedRuntime.status, "verified");
    assert.deepEqual(await runCommand(["runtime-invocation-result", f.root, "--authorization", authorizationId]), expectedRuntime);
    for (const name of ["lode_runtime_invocation_result", "head_runtime_invocation_result"]) {
      const response = await dispatch({ jsonrpc: "2.0", id: "selected-runtime-record", method: "tools/call", params: { name,
        arguments: { project_root: f.root, authorization_id: authorizationId } } });
      assert.equal(response.error, undefined); assert.notEqual(response.result?.isError, true);
      assert.deepEqual(response.result.structuredContent, expectedRuntime);
    }
    const status = await runCommand(["worker-integration-status", f.root, "--integration", f.integrationId]);
    assert.equal(status.integration.integrationId, f.integrationId); assert.equal(status.authorityEffect, "none");
    for (const name of ["lode_worker_integration_status", "head_worker_integration_status"]) {
      const response = await dispatch({ jsonrpc: "2.0", id: "selected-worker-record", method: "tools/call", params: { name,
        arguments: { project_root: f.root, integration_id: f.integrationId } } });
      assert.equal(response.error, undefined); assert.notEqual(response.result?.isError, true);
      assert.deepEqual(response.result.structuredContent, status);
    }
    for (const field of ["instructionAuthority", "promotionAuthority", "recoveryAuthority", "reviewDecisionCreated", "mutatesCanon"]) assert.equal(status[field], false);
  });
  assert.deepEqual(compositionSnapshot(f.container), frozen);
});

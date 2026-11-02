import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/lode-core.mjs";
import { exportProjectBundle, importProjectBundle } from "../scripts/lib/project-portability.mjs";
import { updateProjectDirection, readProjectDirection } from "../scripts/lib/project-direction.mjs";
import { adoptVerifiedProjectCopy } from "../scripts/lib/project-copy-adoption.mjs";
import { formatForVerifiedOwner } from "../scripts/lib/project-storage-format.mjs";
import { buildRuntimeVersionEvidence } from "../scripts/lib/runtime-machine-execution.mjs";
import { buildRuntimeProjectBinding, buildRuntimeProtocolEvidence } from "../scripts/lib/runtime-protocol-evidence.mjs";
import { buildRuntimeInvocationAuthorization } from "../scripts/lib/runtime-invocation-lifecycle.mjs";
import {
  RUNTIME_OPERATIONAL_STATE_ENV, createRuntimePreConsumeGateCapability,
  inspectRuntimeExecutionLease, verifyRuntimeExecutionLeaseOwnership, withRuntimeExecutionLease,
} from "../scripts/lib/runtime-execution-lease.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const ownerFenceDigest = crypto.createHash("sha256").update("synthetic lease observation owner").digest("hex");
console.log(JSON.stringify({ event: "owned-lease-observation-test", pid: process.pid, parentPid: process.ppid,
  command: process.execPath, args: process.argv.slice(1), cwd: process.cwd(), ports: [], actualProviderInvoked: false }));

// Public capability builders receive synthetic events; no OS child is launched.
function syntheticCapabilitySpawn(_command, args) {
  const output = args.join(" ") === "--version" ? "codex 1.2.3\n"
    : args.join(" ") === "--help" ? "exec\nmcp-server\napp-server\n"
      : args.join(" ") === "exec --help" ? "Run Codex non-interactively\n--json\n--output-schema\n--color\n--sandbox\n--skip-git-repo-check\n--cd\n--ephemeral\nresume\n"
        : "stdio://\ngenerate-json-schema\n--listen\n";
  const child = new EventEmitter();
  Object.assign(child, { pid: 1, stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null });
  child.kill = () => { throw new Error("Synthetic capability must never control a process"); };
  queueMicrotask(() => { child.stdout.emit("data", Buffer.from(output)); child.exitCode = 0; child.emit("close", 0, null); });
  return child;
}

async function fixture(t) {
  const parent = fs.realpathSync(process.env.LODE_AGENT_TEST_TMP || process.env.HEAD_AGENT_TEST_TMP || os.tmpdir());
  const container = fs.mkdtempSync(path.join(parent, "head-lease-observation-"));
  const [root, operational, bin] = ["project", "operational", "schema-capability"].map(name => {
    const directory = path.join(container, name); fs.mkdirSync(directory); return directory;
  });
  const previousOperational = process.env[RUNTIME_OPERATIONAL_STATE_ENV];
  process.env[RUNTIME_OPERATIONAL_STATE_ENV] = operational;
  t.after(() => {
    if (previousOperational === undefined) delete process.env[RUNTIME_OPERATIONAL_STATE_ENV];
    else process.env[RUNTIME_OPERATIONAL_STATE_ENV] = previousOperational;
    assert.equal(path.dirname(container), parent);
    assert.match(path.basename(container), /^head-lease-observation-/);
    fs.rmSync(container, { recursive: true, force: true });
  });
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  assert.equal(storage.directory, ".lode");
  assert.equal(fs.existsSync(path.resolve(root, ".lode/project.json")), true);
  assert.equal(fs.existsSync(path.resolve(root, ".head/project.json")), false);
  const executable = path.join(bin, process.platform === "win32" ? "codex.exe" : "codex");
  fs.writeFileSync(executable, "Synthetic capability only; never executed\n");
  if (process.platform !== "win32") fs.chmodSync(executable, 0o755);
  const environment = { ...process.env, PATH: bin }; delete environment.Path; delete environment.path;
  const versionEvidence = await buildRuntimeVersionEvidence({ runtimes: ["codex"], environment, spawnImplementation: syntheticCapabilitySpawn });
  const protocolEvidence = await buildRuntimeProtocolEvidence({ runtimes: ["codex"], environment, versionEvidence, spawnImplementation: syntheticCapabilitySpawn });
  const inspected = inspectProject(root);
  const projectBinding = buildRuntimeProjectBinding({ storage, projectId: inspected.project.projectId, headSessionId: inspected.state.sessionId,
    projectRoot: root, projectStatus: "ready", versionEvidence, protocolEvidence });
  const authorization = buildRuntimeInvocationAuthorization({ root, runtime: "codex", protocolEvidence, projectBinding,
    scope: { kind: "session", request: "Observe one synthetic lease without changing recovery direction" } }).authorization;
  const input = { projectRoot: root, projectId: authorization.projectId, authorizationId: authorization.authorizationId, storage };
  const leaseInput = { projectRoot: root, authorization, ownerFenceDigest };
  const lock = path.join(operational, "runtime-execution-leases", authorization.projectId, authorization.authorizationId, "owner.lock");
  return { storage, root, container, operational, authorization, versionEvidence, protocolEvidence, input, leaseInput, lock, ownerFile: path.join(lock, "owner.json") };
}

function snapshot(root) {
  const entries = {};
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      entries[path.relative(root, file)] = entry.isSymbolicLink() ? { link: fs.readlinkSync(file) }
        : entry.isDirectory() ? { directory: true } : { bytes: fs.readFileSync(file).toString("base64") };
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(file);
    }
  }
  walk(root);
  return entries;
}

function inspectReadOnly(f, expected, errorCode = null, readHooks = {}) {
  const before = snapshot(f.container);
  const methods = ["mkdirSync", "writeFileSync", "appendFileSync", "unlinkSync", "rmdirSync", "rmSync", "renameSync", "linkSync", "symlinkSync", "truncateSync"];
  const originals = new Map(methods.map(method => [method, fs[method]]));
  for (const method of Object.keys(readHooks)) originals.set(method, fs[method]);
  for (const method of methods) fs[method] = () => { throw new Error(`Inspection attempted ${method}`); };
  for (const [method, hook] of Object.entries(readHooks)) fs[method] = hook;
  try {
    if (errorCode) assert.throws(() => inspectRuntimeExecutionLease(f.input), { code: errorCode });
    else {
      const state = inspectRuntimeExecutionLease(f.input);
      for (const [field, value] of Object.entries(expected)) assert.deepEqual(state[field], value, field);
    }
  } finally {
    for (const [method, original] of originals) fs[method] = original;
  }
  assert.deepEqual(snapshot(f.container), before, "Inspection must preserve every project/P2 and operational byte and path");
}

const incomplete = { status: "claimed", ownerStatus: "stale-or-unknown", replayAllowed: false, singleUseConsumed: false, holdDeadlineExceeded: false };

test("lease inspection observes real mkdir-to-owner and unlink-to-rmdir gaps without writes", async (t) => {
  const f = await fixture(t);
  const mkdir = fs.mkdirSync;
  const unlink = fs.unlinkSync;
  const observed = [];
  fs.mkdirSync = function (file, ...args) {
    const result = mkdir.call(this, file, ...args);
    if (file === f.lock) { inspectReadOnly(f, incomplete); observed.push("mkdir-to-owner"); }
    return result;
  };
  fs.unlinkSync = function (file, ...args) {
    const result = unlink.call(this, file, ...args);
    if (file === f.ownerFile) {
      inspectReadOnly(f, { ...incomplete, status: "consumed-active", singleUseConsumed: true });
      observed.push("unlink-to-rmdir");
    }
    return result;
  };
  try {
    await withRuntimeExecutionLease(f.leaseInput, async () => {
      inspectReadOnly(f, { status: "consumed-active", ownerStatus: "active", replayAllowed: false, singleUseConsumed: true });
    });
  } finally { fs.mkdirSync = mkdir; fs.unlinkSync = unlink; }
  assert.deepEqual(observed, ["mkdir-to-owner", "unlink-to-rmdir"]);
  inspectReadOnly(f, { status: "consumed-released", ownerStatus: "none", replayAllowed: false, singleUseConsumed: true });
});

test("lease inspection keeps exact observed ENOENT transitions uncertain and other I/O failures strict", async (t) => {
  const f = await fixture(t);
  const gate = createRuntimePreConsumeGateCapability(async ({ commitConsumption }) => {
    for (const [method, target] of [["readdirSync", f.lock], ["realpathSync", f.lock], ["lstatSync", f.ownerFile], ["readFileSync", f.ownerFile]]) {
      const original = fs[method];
      let triggered = false;
      const hook = function (file, ...args) {
        if (file === target) {
          triggered = true;
          throw Object.assign(new Error("Synthetic exact observed disappearance"), { code: "ENOENT", path: file });
        }
        return original.call(this, file, ...args);
      };
      inspectReadOnly(f, incomplete, null, { [method]: hook });
      assert.equal(triggered, true, method);
    }
    for (const [code, target] of [["ENOENT", path.dirname(f.lock)], ["EIO", f.ownerFile], ["EACCES", f.lock]]) {
      const original = fs.lstatSync;
      const hook = function (file, ...args) {
        if (file === target) throw Object.assign(new Error("Synthetic non-transition failure"), { code, path: file });
        return original.call(this, file, ...args);
      };
      inspectReadOnly(f, null, code, { lstatSync: hook });
    }
    commitConsumption();
  });
  await withRuntimeExecutionLease(f.leaseInput, async () => {}, { preConsumeGate: gate });
});

test("lease inspection rejects live and dangling lock links", async (t) => {
  const f = await fixture(t);
  fs.mkdirSync(path.dirname(f.lock), { recursive: true });
  const target = path.join(f.operational, "synthetic-link-target");
  fs.mkdirSync(target);
  try { fs.symlinkSync(target, f.lock, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") return t.skip(`Host cannot create fixture directory links: ${error.code}`);
    throw error;
  }
  inspectReadOnly(f, null, "UNSAFE_RUNTIME_OPERATIONAL_STATE");
  fs.rmdirSync(target);
  assert.equal(fs.existsSync(f.lock), false);
  inspectReadOnly(f, null, "UNSAFE_RUNTIME_OPERATIONAL_STATE");
});

test("lease inspection preserves durable digest and released-owner contradictions", async (t) => {
  const f = await fixture(t);
  let owner;
  await withRuntimeExecutionLease(f.leaseInput, async ({ lease }) => { owner = lease; });
  const directory = path.join(f.root, f.storage.directory, "runtime/execution-leases", f.authorization.authorizationId);
  for (const [name, mutate, code] of [
    ["consumption.json", document => ({ ...document, ownerFenceDigest: "0".repeat(64) }), "RUNTIME_EXECUTION_LEASE_CONSUMPTION_DIGEST_MISMATCH"],
    ["release.json", document => ({ ...document, operationStatus: "failed" }), "RUNTIME_EXECUTION_LEASE_RELEASE_DIGEST_MISMATCH"],
  ]) {
    const file = path.join(directory, name);
    const original = fs.readFileSync(file);
    fs.writeFileSync(file, JSON.stringify(mutate(JSON.parse(original))));
    try { inspectReadOnly(f, null, code); }
    finally { fs.writeFileSync(file, original); }
  }
  fs.mkdirSync(f.lock, { recursive: true });
  inspectReadOnly(f, null, "INVALID_RUNTIME_EXECUTION_LEASE_STATE");
  fs.writeFileSync(f.ownerFile, JSON.stringify(owner));
  inspectReadOnly(f, null, "INVALID_RUNTIME_EXECUTION_LEASE_STATE");
});

test("stable incomplete locks cannot be acquired or verified and invalid owner evidence stays strict", async (t) => {
  const f = await fixture(t);
  fs.mkdirSync(f.lock, { recursive: true });
  inspectReadOnly(f, incomplete);
  await assert.rejects(() => withRuntimeExecutionLease(f.leaseInput, async () => assert.fail("Unknown owner cannot execute")), { code: "UNSAFE_RUNTIME_OPERATIONAL_STATE" });
  assert.deepEqual(fs.readdirSync(f.lock), []);
  fs.rmdirSync(f.lock);
  const gate = createRuntimePreConsumeGateCapability(async ({ owner, commitConsumption }) => {
    const original = fs.readFileSync(f.ownerFile);
    const withOwner = (content, code) => {
      fs.writeFileSync(f.ownerFile, content);
      try { inspectReadOnly(f, null, code); }
      finally { fs.writeFileSync(f.ownerFile, original); }
    };
    withOwner("{", "INVALID_RUNTIME_EXECUTION_LEASE"); // Partial publication cannot be distinguished from corrupt JSON.
    withOwner("{}", "INVALID_RUNTIME_EXECUTION_LEASE");
    withOwner(JSON.stringify({ ...owner, pid: 0 }), "INVALID_RUNTIME_EXECUTION_LEASE_OWNER");
    withOwner(JSON.stringify({ ...owner, projectId: `${formatForVerifiedOwner(f.storage).projectPrefix}${"0".repeat(20)}` }), "RUNTIME_EXECUTION_LEASE_PROJECT_MISMATCH");
    const unexpected = path.join(f.lock, "unexpected.json");
    fs.writeFileSync(unexpected, "{}");
    try { inspectReadOnly(f, null, "UNSAFE_RUNTIME_OPERATIONAL_STATE"); }
    finally { fs.unlinkSync(unexpected); }
    const linked = path.join(f.operational, "owner-hardlink.json");
    fs.linkSync(f.ownerFile, linked);
    try { inspectReadOnly(f, null, "UNSAFE_RUNTIME_OPERATIONAL_STATE"); }
    finally { fs.unlinkSync(linked); }
    for (const target of [f.lock, f.ownerFile]) {
      const lstat = fs.lstatSync;
      fs.lstatSync = function (file, ...args) {
        const stat = lstat.call(this, file, ...args);
        if (file === target) stat.isSymbolicLink = () => true;
        return stat;
      };
      try { inspectReadOnly(f, null, "UNSAFE_RUNTIME_OPERATIONAL_STATE"); }
      finally { fs.lstatSync = lstat; }
    }
    fs.unlinkSync(f.ownerFile);
    try {
      inspectReadOnly(f, incomplete);
      assert.throws(() => verifyRuntimeExecutionLeaseOwnership({ ...f.leaseInput, lease: owner }), { code: "UNSAFE_RUNTIME_OPERATIONAL_STATE" });
      assert.throws(commitConsumption, { code: "UNSAFE_RUNTIME_OPERATIONAL_STATE" });
    } finally { fs.writeFileSync(f.ownerFile, original, { flag: "wx" }); }
    throw Object.assign(new Error("End unconsumed synthetic lease"), { code: "FIXTURE_END" });
  });
  await assert.rejects(() => withRuntimeExecutionLease(f.leaseInput, async () => assert.fail("Must not execute"), { preConsumeGate: gate }), { code: "FIXTURE_END" });
  inspectReadOnly(f, { status: "available", ownerStatus: "none", replayAllowed: true, singleUseConsumed: false });
});

test("adopting a same-path copy fences old authorization before operational creation but retains lease observation", async t => {
  const f = await fixture(t), projectFile = path.join(f.root, ".lode/project.json");
  const project = JSON.parse(fs.readFileSync(projectFile));
  fs.writeFileSync(projectFile, JSON.stringify({ ...project, projectRoot: "C:/unverified/synthetic-old-pc" }, null, 2)+"\n");
  const mf = path.join(f.root, ".lode/generated/manifest.json"), manifest = JSON.parse(fs.readFileSync(mf));
  manifest.managed.find(entry => entry.path === ".lode/project.json").sha256 = crypto.createHash("sha256").update(fs.readFileSync(projectFile)).digest("hex");
  fs.writeFileSync(mf, JSON.stringify(manifest, null, 2)+"\n");
  assert.equal(adoptVerifiedProjectCopy({ root: f.root, pluginRoot }).status, "verified-copy-adopted");
  const before = snapshot(f.container); let launched = false;
  await assert.rejects(withRuntimeExecutionLease(f.leaseInput, async () => { launched = true; }), { code: "RUNTIME_IMPORTED_AUTHORIZATION_NOT_EXECUTABLE" });
  assert.equal(launched, false); assert.deepEqual(snapshot(f.container), before);
  const old = inspectRuntimeExecutionLease({ ...f.input, storage: inspectProject(f.root).storage });
  assert.equal(old.singleUseConsumed, false);
  const oldFile = path.join(f.root, ".lode/runtime/execution-authorizations", f.authorization.authorizationId+".json");
  assert(fs.existsSync(oldFile));
});


test("imported history cannot replace current cancellation or reach a provider callback", async t => {
  const f=await fixture(t);
  const bundle=exportProjectBundle({root:f.root,destination:path.join(f.container,"common-bundle")});
  const target=path.join(f.container,"target");fs.mkdirSync(target);
  importProjectBundle({root:target,bundleRoot:bundle.bundleRoot,pluginRoot});
  const inspected=inspectProject(target);
  const binding=buildRuntimeProjectBinding({storage:inspected.storage,projectId:inspected.project.projectId,
    headSessionId:inspected.state.sessionId,projectRoot:target,projectStatus:"ready",
    versionEvidence:f.versionEvidence,protocolEvidence:f.protocolEvidence});
  const authorize=()=>buildRuntimeInvocationAuthorization({root:target,runtime:"codex",
    protocolEvidence:f.protocolEvidence,projectBinding:binding,
    scope:{kind:"session",request:"Read only the selected synthetic evidence"}}).authorization;
  const currentAuthorization=authorize();
  updateProjectDirection({root:target,input:{goal:"Current target work",cancelledActions:["runtime.invoke"]}});
  importProjectBundle({root:target,bundleRoot:bundle.bundleRoot,pluginRoot});
  assert.deepEqual(readProjectDirection({root:target}).input.cancelledActions,["runtime.invoke"]);
  let providerCalls=0;
  await assert.rejects(withRuntimeExecutionLease({projectRoot:target,authorization:currentAuthorization,ownerFenceDigest},async()=>{providerCalls++;}),{code:"RUNTIME_PROJECT_DIRECTION_DRIFT"});
  const reassessed=authorize();
  await assert.rejects(withRuntimeExecutionLease({projectRoot:target,authorization:reassessed,ownerFenceDigest},async()=>{providerCalls++;}),{code:"PROJECT_ACTION_CANCELLED"});
  assert.equal(providerCalls,0);
  const observed=inspectRuntimeExecutionLease({projectRoot:target,projectId:currentAuthorization.projectId,
    authorizationId:currentAuthorization.authorizationId,storage:inspectProject(target).storage});
  assert.equal(observed.singleUseConsumed,false);
});

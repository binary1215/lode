import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createProcessSupervisorManifest, spawnSupervisedProcess } from "../scripts/lib/runtime/runtime-process-supervisor.mjs";

test("graceful stop lets its native owner complete cleanup; explicit force retains the platform's exact owned fallback", async t => {
  const windows = process.platform === "win32", strategy = windows ? "windows-job-object" : "posix-process-group";
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lode-stop-contract-"))), directory = path.join(root, "dist", (windows ? "windows" : process.platform) + "-" + process.arch);
  t.after(() => {
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("lode-stop-contract-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(directory, { recursive: true });
  const binaryFile = path.join(directory, windows ? "lode-agent-supervisor.exe" : "lode-agent-supervisor");
  fs.writeFileSync(binaryFile, "Synthetic never-executed supervisor manifest fixture");
  const manifest = createProcessSupervisorManifest({ platform: process.platform, arch: process.arch, binaryFile, manifestDirectory: directory });
  fs.writeFileSync(path.join(directory, "SUPERVISOR-MANIFEST.json"), JSON.stringify(manifest));
  // No native process is launched: the explicit fake spawn below exercises
  // the current platform's signalling without claiming native execution.
  const selection = { binaryPath: binaryFile, manifest };
  const child = new EventEmitter();
  Object.assign(child, { pid: 43210, exitCode: null, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const calls = [];
  child.kill = signal => { calls.push({ target: "owner", signal }); return true; };
  t.mock.method(process, "kill", (pid, signal) => { calls.push({ target: "group", pid, signal }); return true; });
  const controlFile = path.join(root, "control.jsonl");
  let ready;
  const observed = new Promise(resolve => { ready = resolve; });
  const handle = spawnSupervisedProcess({ selection, executablePath: process.execPath, args: [], cwd: root,
    providerEnvironment: {}, input: Buffer.alloc(0), controlFile, terminationGraceMs: 100,
    spawnImplementation() { queueMicrotask(() => child.emit("spawn")); return child; },
    onControlEvent(event) { if (event.type === "provider.started") ready(); } });
  t.after(() => { child.exitCode = 0; child.emit("close", 0, null); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); });
  const frame = value => JSON.stringify({ protocolVersion: "0.1.0", ...value }) + "\n";
  fs.writeFileSync(controlFile, frame({ type: "supervisor.ready", strategy, treeOwnershipEstablished: true })
    + frame({ type: "provider.started", strategy, treeOwnershipEstablished: true, providerPid: 424242 }));
  await observed;
  handle.terminate(false);
  assert.deepEqual(calls, [{ target: "owner", signal: "SIGTERM" }]);
  assert.equal(handle.finalize({ exactSupervisorExitObserved: false, terminationRequested: true }).treeCleanupVerified, false,
    "A requested stop without native cleanup evidence must remain unverified.");
  calls.length = 0;
  handle.terminate(true);
  assert.deepEqual(calls, [...(windows ? [] : [{ target: "group", pid: -424242, signal: "SIGKILL" }]), { target: "owner", signal: "SIGKILL" }]);
  fs.appendFileSync(controlFile, frame({ type: "provider.exited", providerPid: 424242, exitCode: 143 })
    + frame({ type: "supervisor.cleanup", strategy, cleanupAttempted: true, cleanupVerified: true, forceUsed: true, kernelCleanupOnExit: false }));
  const receipt = handle.finalize({ exactSupervisorExitObserved: true, terminationRequested: true });
  assert.equal(receipt.ownershipEstablished, true); assert.equal(receipt.treeCleanupVerified, true);
});

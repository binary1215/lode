// Controlled caller-policy test only: no OS child or native cleanup claim.
// Load the actual GC module, substituting only its imported transport.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

const scenarios = new Map();
export function resolveVerifiedProcessSupervisor() { return {}; }
export function spawnSupervisedProcess(options) {
  const config = scenarios.get(options.cwd);
  assert(config, "Only this controlled fixture can use the fake transport");
  const born = performance.now(), timers = new Set();
  const record = event => config.timeline.push({ at: Date.now(), milliseconds: performance.now() - born, ...event });
  const later = (delay, action) => { const timer = setTimeout(() => { timers.delete(timer); action(); }, delay); timers.add(timer); };
  const child = Object.assign(new EventEmitter(), { pid: 990001, exitCode: null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  let closed = false, requested = false, providerExited = false, cleanup = false;
  const control = event => { record({ event: "raw-control", ...event }); options.onControlEvent(event); };
  const close = (code, signal) => {
    if (closed) return; closed = true;
    for (const timer of timers) clearTimeout(timer); timers.clear();
    child.exitCode = code; child.signalCode = signal;
    record({ event: "supervisor-close", exitCode: code, signal });
    child.stdout.end(); child.stderr.end(); child.stdin.destroy(); child.emit("close", code, signal);
  };
  config.dispose = () => close(null, "SIGKILL");
  record({ event: "spawn", simulated: true, nativeTerminationGraceMs: options.terminationGraceMs });
  later(0, () => {
    control({ type: "provider.started", providerPid: 990002 });
    child.stdout.write(Buffer.from(config.cancel ? "a" : "over-cap"));
    later(80, () => { if (!closed) child.stdout.write(Buffer.from("x")); });
  });
  if (config.cancel) later(25, () => { record({ event: "caller-cancelled" }); config.controller.abort(); });
  return { child,
    terminate(force) {
      record({ event: force ? "force-supervisor-and-provider" : "graceful-termination-request" });
      if (force) { close(null, "SIGKILL"); return; }
      if (requested) return; requested = true;
      if (!config.stuck) {
        later(60, () => { providerExited = true; control({ type: "provider.exited", providerPid: 990002, exitCode: 143 }); });
        later(400, () => {
          cleanup = true; control({ type: "supervisor.cleanup", strategy: "posix-process-group", cleanupAttempted: true, cleanupVerified: true });
          close(143, null);
        });
      }
    },
    finalize(input) {
      const proof = { supervisionMode: "native-process-tree", supervisionStrategy: "posix-process-group",
        ownershipEstablished: true, providerChildStarted: true, providerChildExitObserved: providerExited,
        treeCleanupAttempted: requested, treeCleanupVerified: cleanup, providerPid: 990002, requestWritten: true, controlInvalid: false };
      record({ event: "finalize", input, proof }); return proof;
    },
  };
}

export async function controlledGcStop({ cancel = false, stuck = false, deadlineMs = 1000 } = {}) {
  const temporaryRoot = process.env.HEAD_AGENT_TEST_TMP || os.tmpdir();
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const parent = fs.realpathSync(temporaryRoot);
  const root = fs.mkdtempSync(path.join(parent, "lode-gc-control-")), timeline = [], events = [];
  const config = { cancel, stuck, timeline, controller: new AbortController() };
  scenarios.set(root, config);
  try {
    const lib = path.resolve(import.meta.dirname, "../../scripts/lib");
    const source = fs.readFileSync(path.join(lib, "snapshot-backend-reclamation.mjs"), "utf8");
    const lifted = source.replace(/from "(\.\/[^"\n]+)"/g, (_, relative) => "from " + JSON.stringify(relative === "./runtime-process-supervisor.mjs"
      ? import.meta.url : pathToFileURL(path.resolve(lib, relative)).href));
    const moduleFile = path.join(root, "gc-caller.mjs"); fs.writeFileSync(moduleFile, lifted, { flag: "wx" });
    const { SnapshotBackendReclamation } = await import(pathToFileURL(moduleFile).href);
    const worker = Object.create(SnapshotBackendReclamation.prototype), deadline = Date.now() + deadlineMs;
    Object.assign(worker, { root, deadline, signal: config.controller.signal, shouldContinue: () => true,
      store: { gitCommand: process.execPath, directory: root }, selectSupervisor: () => ({}), onProcess: e => events.push(e) });
    const file = path.join(root, "stage.pack"); let error;
    try { await worker.packStream(["a".repeat(64)], file, cancel ? 100 : 1); } catch (cause) { error = cause; }
    const closed = events.find(e => e.event === "closed");
    return { error, closed, timeline, stagedBytes: fs.statSync(file).size, deadline, deadlineAfter: worker.deadline, deadlineMs,
      scope: "controlled transport only; actual method, no native or provider process" };
  } finally {
    config.dispose?.(); scenarios.delete(root);
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert(path.basename(root).startsWith("lode-gc-control-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

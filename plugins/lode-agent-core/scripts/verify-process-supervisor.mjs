#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveVerifiedProcessSupervisor,
  spawnBoundedRuntimeOneShot,
  spawnSupervisedProcess,
} from "./lib/runtime-process-supervisor.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

async function waitForExit(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !processExists(pid);
}

const PROVIDER_FIXTURE = String.raw`
const { spawn } = require('node:child_process');
const mode = process.argv[1];
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  shell: false,
  windowsHide: true,
  stdio: 'ignore',
});
process.stdout.write(JSON.stringify({ descendantPid: descendant.pid }) + '\n');
if (mode === 'normal') setTimeout(() => process.exit(0), 50);
else setInterval(() => {}, 1000);
`;

const INTERACTIVE_PROVIDER_FIXTURE = String.raw`
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  shell: false, windowsHide: true, stdio: 'ignore',
});
process.stdout.write(JSON.stringify({ type: 'ready', providerPid: process.pid, descendantPid: descendant.pid }) + '\n');
const lines = createInterface({ input: process.stdin });
lines.on('line', line => process.stdout.write(JSON.stringify({ type: 'echo', value: line }) + '\n'));
lines.on('close', () => process.stdout.write(JSON.stringify({ type: 'eof' }) + '\n', () => process.exit(0)));
`;

async function runInteractiveScenario(selection) {
  let supervised;
  let providerPid = null;
  let descendantPid = null;
  let closed = false;
  let failure = null;
  let pending = "";
  let outputBytes = 0;
  let errorOutput = "";
  const records = [];
  const recordDescendant = () => {
    if (descendantPid || !providerPid) return;
    const ready = records.find(record => record.type === "ready" && record.providerPid === providerPid
      && Number.isSafeInteger(record.descendantPid) && record.descendantPid > 0);
    if (!ready) return;
    descendantPid = ready.descendantPid;
    process.stderr.write(`NESTED_CHILD_START pid=${descendantPid} parent=${providerPid} command=${JSON.stringify([process.execPath, "-e", "setInterval(() => {}, 1000)"])} cwd=${repositoryRoot} ports=none\n`);
  };
  const controlFile = path.join(path.dirname(selection.manifestPath), `.interactive-control-${process.pid}-${crypto.randomUUID()}.jsonl`);
  try {
    process.stderr.write(`CHILD_PREPARE parent=${process.pid} command=${JSON.stringify([selection.binaryPath, "--interactive"])} cwd=${repositoryRoot} ports=none\n`);
    process.stderr.write(`CHILD_PREPARE parent=supervisor command=${JSON.stringify([process.execPath, "-e", INTERACTIVE_PROVIDER_FIXTURE])} cwd=${repositoryRoot} ports=none\n`);
    supervised = spawnSupervisedProcess({
      selection, executablePath: process.execPath, args: ["-e", INTERACTIVE_PROVIDER_FIXTURE],
      cwd: repositoryRoot,
      providerEnvironment: { SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || "", PATH: process.env.PATH || "" },
      input: Buffer.alloc(0), controlFile, terminationGraceMs: 500,
      interactive: { timeoutMs: 15_000 },
      onControlEvent: event => {
        if (event.type === "provider.started") {
          providerPid = event.providerPid;
          process.stderr.write(`NESTED_CHILD_START pid=${providerPid} parent=${supervised?.child.pid || process.pid} command=node-interactive-fixture cwd=${repositoryRoot} ports=none\n`);
          recordDescendant();
        }
        if (event.type === "provider.exited") {
          process.stderr.write(`NESTED_CHILD_END pid=${event.providerPid} parent=${supervised?.child.pid || process.pid} exit=${event.exitCode} signal=none\n`);
        }
      },
    });
    process.stderr.write(`NESTED_CHILD_START pid=${supervised.child.pid} parent=${process.pid} command=lode-agent-process-supervisor--interactive cwd=${repositoryRoot} ports=none\n`);
    const completion = new Promise(resolve => {
      supervised.child.once("error", error => { failure ||= error; });
      supervised.child.once("close", (code, signal) => {
        closed = true;
        process.stderr.write(`NESTED_CHILD_END pid=${supervised.child.pid} parent=${process.pid} exit=${code ?? "null"} signal=${signal || "none"}\n`);
        resolve({ code, signal });
      });
    });
    for (const stream of [supervised.child.stdout, supervised.child.stderr]) {
      stream.on("error", error => { failure ||= error; });
    }
    supervised.child.stdout.on("data", chunk => {
      outputBytes += chunk.length;
      if (outputBytes > 64 * 1024) { failure ||= new Error("Interactive fixture exceeded its output bound."); return; }
      pending += chunk.toString("utf8");
      const lines = pending.split(/\r?\n/u);
      pending = lines.pop() || "";
      for (const line of lines) {
        try {
          const record = JSON.parse(line);
          if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Invalid fixture record.");
          records.push(record);
        }
        catch { failure ||= new Error("Interactive fixture emitted an invalid record."); }
      }
      recordDescendant();
    });
    supervised.child.stderr.on("data", chunk => {
      if (Buffer.byteLength(errorOutput) + chunk.length > 64 * 1024) failure ||= new Error("Interactive fixture exceeded its error-output bound.");
      else errorOutput += chunk.toString("utf8");
    });
    const waitFor = async predicate => {
      const deadline = Date.now() + 5_000;
      while (!predicate() && !failure && !closed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      if (failure) throw failure;
      assert(predicate(), `Interactive fixture did not complete its current exchange: ${errorOutput.trim() || "no supervisor stderr"}`);
    };
    await waitFor(() => providerPid && descendantPid);
    for (const value of ["first interactive exchange", "second interactive exchange"]) {
      await supervised.writeInput(Buffer.from(`${value}\n`));
      await waitFor(() => records.some(record => record.type === "echo" && record.value === value));
    }
    assert(!closed && supervised.child.exitCode === null, "Interactive input ended before the explicit EOF.");
    await supervised.endInput();
    await waitFor(() => closed);
    const outcome = await completion;
    assert(outcome.code === 0 && outcome.signal === null && records.some(record => record.type === "eof") && !pending,
      "Interactive fixture did not exit normally after explicit EOF.");
    const boundary = supervised.finalize({ exactSupervisorExitObserved: true, terminationRequested: false });
    assert(boundary.ownershipEstablished && boundary.treeCleanupVerified && boundary.providerChildExitObserved,
      "Interactive fixture did not prove exact provider exit and tree cleanup.");
    assert(await waitForExit(supervised.child.pid) && await waitForExit(providerPid) && await waitForExit(descendantPid),
      "Interactive fixture left an owned process alive.");
    process.stderr.write(`NESTED_CHILD_END pid=${descendantPid} parent=${providerPid} exit=null signal=supervised-tree-cleanup\n`);
    return {
      mode: "interactive", platform: process.platform, arch: process.arch,
      bidirectionalRoundTripVerified: true, gracefulEofVerified: true,
      ownershipEstablished: boundary.ownershipEstablished, treeCleanupVerified: boundary.treeCleanupVerified,
      providerExitObserved: boundary.providerChildExitObserved, providerSessionCreated: false,
    };
  } finally {
    if (supervised?.child && processExists(supervised.child.pid)) {
      void supervised.endInput().catch(() => {});
      if (!await waitForExit(supervised.child.pid)) {
        supervised.terminate(false);
        if (!await waitForExit(supervised.child.pid)) { supervised.terminate(true); await waitForExit(supervised.child.pid); }
      }
    }
    for (const pid of [providerPid, descendantPid]) {
      if (!processExists(pid)) continue;
      try { process.kill(pid, "SIGTERM"); } catch {}
      if (!await waitForExit(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} await waitForExit(pid); }
    }
    assert(!processExists(supervised?.child?.pid) && !processExists(providerPid) && !processExists(descendantPid),
      "Interactive fixture cleanup left an owned process alive.");
    if (descendantPid) process.stderr.write(`NESTED_CHILD_END pid=${descendantPid} parent=${providerPid} exit=null signal=interactive-cleanup-verified\n`);
    if (fs.existsSync(controlFile)) fs.unlinkSync(controlFile);
  }
}

async function runScenario(selection, mode) {
  let descendantPid = null;
  let providerPid = null;
  let output = "";
  let stderrOutput = "";
  let supervised;
  const controlFile = path.join(path.dirname(selection.manifestPath), `.supervisor-control-${process.pid}-${mode}-${crypto.randomUUID()}.jsonl`);
  try {
    supervised = spawnSupervisedProcess({
      selection,
      executablePath: process.execPath,
      args: ["-e", PROVIDER_FIXTURE, mode],
      cwd: repositoryRoot,
      providerEnvironment: {
        SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || "",
        PATH: process.env.PATH || "",
      },
      input: Buffer.alloc(0),
      controlFile,
      terminationGraceMs: 500,
      onControlEvent: (event) => {
        if (event.type === "provider.started") {
          providerPid = event.providerPid;
          process.stderr.write(`NESTED_CHILD_START pid=${providerPid} parent=${supervised?.child.pid || process.pid} command=node-provider-fixture cwd=${repositoryRoot} ports=none\n`);
        }
        if (event.type === "provider.exited") {
          process.stderr.write(`NESTED_CHILD_END pid=${event.providerPid} parent=${supervised?.child.pid || process.pid} exit=${event.exitCode} signal=none\n`);
        }
      },
    });
    process.stderr.write(`NESTED_CHILD_START pid=${supervised.child.pid} parent=${process.pid} command=lode-agent-process-supervisor cwd=${path.dirname(selection.binaryPath)} ports=none\n`);
    supervised.child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      for (const line of output.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (Number.isSafeInteger(record.descendantPid)) descendantPid = record.descendantPid;
        } catch {}
      }
    });
    supervised.child.stderr.on("data", (chunk) => { stderrOutput += chunk.toString("utf8"); });
    if (mode === "cancel") {
      const deadline = Date.now() + 2_000;
      while ((!descendantPid || !providerPid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert(descendantPid && providerPid, "Cancellation fixture did not expose its owned process tree.");
      process.stderr.write(`NESTED_CHILD_START pid=${descendantPid} parent=${providerPid} command=node-descendant-fixture cwd=${repositoryRoot} ports=none\n`);
      supervised.terminate(false);
    }
    const closed = await new Promise((resolve, reject) => {
      supervised.child.once("error", reject);
      supervised.child.once("close", (code, signal) => resolve({ code, signal }));
    });
    process.stderr.write(`NESTED_CHILD_END pid=${supervised.child.pid} parent=${process.pid} exit=${closed.code ?? "null"} signal=${closed.signal || "none"}\n`);
    if (mode === "normal") {
      const parsed = output.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      descendantPid = parsed.find((item) => Number.isSafeInteger(item.descendantPid))?.descendantPid || null;
      assert(descendantPid && providerPid, `Normal fixture did not expose its owned process tree: ${stderrOutput.trim() || "no supervisor stderr"}`);
      process.stderr.write(`NESTED_CHILD_START pid=${descendantPid} parent=${providerPid} command=node-descendant-fixture cwd=${repositoryRoot} ports=none\n`);
    }
    const boundary = supervised.finalize({ exactSupervisorExitObserved: true, terminationRequested: mode === "cancel" });
    assert(boundary.ownershipEstablished && boundary.treeCleanupVerified, `${mode} process-tree cleanup was not verified.`);
    assert(await waitForExit(providerPid), `${mode} provider process remained alive.`);
    assert(await waitForExit(descendantPid), `${mode} descendant process remained alive.`);
    process.stderr.write(`NESTED_CHILD_END pid=${descendantPid} parent=${providerPid} exit=null signal=supervised-tree-cleanup\n`);
    return {
      mode,
      supervisionStrategy: boundary.supervisionStrategy,
      ownershipEstablished: boundary.ownershipEstablished,
      treeCleanupVerified: boundary.treeCleanupVerified,
      providerExitObserved: boundary.providerChildExitObserved,
    };
  } finally {
    if (supervised?.child && supervised.child.exitCode === null && supervised.child.signalCode === null) {
      supervised.terminate(true);
      await waitForExit(supervised.child.pid);
    }
    if (descendantPid && processExists(descendantPid)) {
      try { process.kill(descendantPid, "SIGKILL"); } catch {}
      await waitForExit(descendantPid);
    }
    if (fs.existsSync(controlFile)) fs.unlinkSync(controlFile);
  }
}

async function runBoundedControlScenario(selection, runtime, action) {
  let controlled;
  let descendantPid = null;
  let providerPid = null;
  let output = "";
  const controlFile = path.join(path.dirname(selection.manifestPath), `.runtime-control-${process.pid}-${runtime}-${action}-${crypto.randomUUID()}.jsonl`);
  try {
    controlled = spawnBoundedRuntimeOneShot({
      runtime,
      selection,
      executablePath: process.execPath,
      args: ["-e", PROVIDER_FIXTURE, "control"],
      cwd: repositoryRoot,
      providerEnvironment: {
        SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || "",
        PATH: process.env.PATH || "",
      },
      input: Buffer.alloc(0),
      controlFile,
      terminationGraceMs: 500,
      onControlEvent: (event) => {
        if (event.type === "provider.started") providerPid = event.providerPid;
      },
    });
    process.stderr.write(`NESTED_CHILD_START pid=${controlled.child.pid} parent=${process.pid} command=lode-agent-bounded-${action} cwd=${path.dirname(selection.binaryPath)} ports=none\n`);
    controlled.child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      for (const line of output.split(/\r?\n/u)) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (Number.isSafeInteger(record.descendantPid)) descendantPid = record.descendantPid;
        } catch {}
      }
    });
    let unauthorized = null;
    try { controlled[action]({ token: "wrong-token" }); } catch (error) { unauthorized = error; }
    assert(unauthorized?.code === "RUNTIME_ONE_SHOT_CONTROL_UNAUTHORIZED", "Invalid bounded control token was accepted.");
    for (const deferred of ["resume", "stream"]) {
      let rejection = null;
      try { controlled[deferred](); } catch (error) { rejection = error; }
      assert(rejection?.code === "RUNTIME_ADAPTER_CONTROL_NOT_ENABLED", `${deferred} was unexpectedly activated.`);
    }
    const deadline = Date.now() + 2_000;
    while ((!providerPid || !descendantPid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert(providerPid && descendantPid, `Bounded ${action} fixture did not expose its exact process tree.`);
    process.stderr.write(`NESTED_CHILD_START pid=${providerPid} parent=${controlled.child.pid} command=node-provider-fixture cwd=${repositoryRoot} ports=none\n`);
    process.stderr.write(`NESTED_CHILD_START pid=${descendantPid} parent=${providerPid} command=node-descendant-fixture cwd=${repositoryRoot} ports=none\n`);
    controlled[action]({ token: controlled.controlToken });
    let conflict = null;
    try { controlled[action === "interrupt" ? "close" : "interrupt"]({ token: controlled.controlToken }); }
    catch (error) { conflict = error; }
    assert(conflict?.code === "RUNTIME_ONE_SHOT_CONTROL_CONFLICT", "Conflicting bounded control action was accepted.");
    const closed = await new Promise((resolve, reject) => {
      controlled.child.once("error", reject);
      controlled.child.once("close", (code, signal) => resolve({ code, signal }));
    });
    process.stderr.write(`NESTED_CHILD_END pid=${controlled.child.pid} parent=${process.pid} exit=${closed.code ?? "null"} signal=${closed.signal || "none"}\n`);
    const receipt = controlled.finalize({ token: controlled.controlToken, exactSupervisorExitObserved: true });
    assert(receipt.action === action && receipt.actionAccepted, `Bounded ${action} receipt did not bind the requested action.`);
    assert(receipt.ownershipEstablished && receipt.treeCleanupVerified, `Bounded ${action} cleanup was not verified.`);
    assert(receipt.resumeEnabled === false && receipt.streamEnabled === false, "Deferred controls changed state.");
    assert(!fs.readFileSync(controlFile).includes(controlled.controlToken), "Raw runtime control token persisted in supervisor evidence.");
    assert(await waitForExit(providerPid) && await waitForExit(descendantPid), `Bounded ${action} left an owned child alive.`);
    process.stderr.write(`NESTED_CHILD_END pid=${descendantPid} parent=${providerPid} exit=null signal=supervised-tree-cleanup\n`);
    return {
      runtime,
      action,
      receiptId: receipt.receiptId,
      ownershipEstablished: receipt.ownershipEstablished,
      treeCleanupVerified: receipt.treeCleanupVerified,
      controlTokenPersisted: receipt.controlTokenPersisted,
      providerSessionIdentityPersisted: receipt.providerSessionIdentityPersisted,
      resumeEnabled: receipt.resumeEnabled,
      streamEnabled: receipt.streamEnabled,
    };
  } finally {
    if (controlled?.child && controlled.child.exitCode === null && controlled.child.signalCode === null) {
      try { controlled.close({ token: controlled.controlToken }); } catch {}
      await waitForExit(controlled.child.pid);
    }
    if (descendantPid && processExists(descendantPid)) {
      try { process.kill(descendantPid, "SIGKILL"); } catch {}
      await waitForExit(descendantPid);
    }
    if (fs.existsSync(controlFile)) fs.unlinkSync(controlFile);
  }
}

async function main() {
  const pluginRoot = path.resolve(option("--plugin-root", process.env.LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT || process.env.HEAD_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT || repositoryRoot));
  const selection = resolveVerifiedProcessSupervisor({ pluginRoot });
  const normal = await runScenario(selection, "normal");
  const cancelled = await runScenario(selection, "cancel");
  const interactive = await runInteractiveScenario(selection);
  const interrupted = await runBoundedControlScenario(selection, "codex", "interrupt");
  const closed = await runBoundedControlScenario(selection, "opencode", "close");
  process.stdout.write(`${JSON.stringify({
    status: "process_supervisor_verified",
    manifestId: selection.manifest.manifestId,
    scenarios: [normal, cancelled],
    interactive,
    boundedRuntimeControl: [interrupted, closed],
    rawPidPersisted: false,
    shellInterpretation: false,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ status: "failed", code: error.code || "PROCESS_SUPERVISOR_VERIFY_ERROR", error: error.message })}\n`);
  process.exitCode = 1;
});

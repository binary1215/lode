import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { collectOutgoingCallEvidence } from "../scripts/lib/runtime/lsp-host-bridge.mjs";
import { sha256 } from "../scripts/lib/runtime/lsp-host-protocol.mjs";
import { resolveVerifiedProcessSupervisor } from "../scripts/lib/runtime/runtime-process-supervisor.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakeServer = path.join(root, "test", "fixtures", "lsp-host-fake-server.mjs");
const ready = Boolean(process.env.HEAD_LSP_QA_ROOT && process.env.HEAD_LSP_SUPERVISOR_ROOT);
const qaRoot = ready ? path.resolve(process.env.HEAD_LSP_QA_ROOT) : null;
const supervisorRoot = ready ? path.resolve(process.env.HEAD_LSP_SUPERVISOR_ROOT) : null;
const selection = ready ? resolveVerifiedProcessSupervisor({ pluginRoot: supervisorRoot }) : null;
const processTest = ready ? test : test.skip;
const generationDigest = sha256("lsp-host-generation-v1");

const baseSources = Object.freeze([
  Object.freeze({ path: "target.ts", text: "export function target() {}" }),
  Object.freeze({ path: "barrel.ts", text: "export { target } from \"./target\";" }),
  Object.freeze({ path: "caller.ts", text: "import { target } from \"./barrel\";\nexport function caller(){ target(); }" }),
]);

function profile(scenario, serverFile = fakeServer) {
  return { kind: "head-lsp-fake-v1", scenario, serverFile, serverDigest: sha256(fs.readFileSync(serverFile)) };
}

async function run(scenario, sources = baseSources, options = {}) {
  const events = [];
  const externalProcessEvent = options.onProcessEvent;
  const runQaRoot = fs.mkdtempSync(path.join(path.resolve(qaRoot), `collection-${process.pid}-`));
  try {
    const result = await collectOutgoingCallEvidence({
      projectId: "fixture-project",
      generationDigest,
      sources,
      profile: profile(scenario, options.serverFile || fakeServer),
      supervisorSelection: selection,
      qaRoot: runQaRoot,
      onProcessEvent: (event) => { events.push(event); externalProcessEvent?.(event, runQaRoot); },
      ...Object.fromEntries(Object.entries(options).filter(([key]) => !["serverFile", "onProcessEvent"].includes(key))),
    });
    assert.equal(result.realSupport, false);
    assert.equal(result.relationQuality, "unknown");
    assert.deepEqual(result.realGate, { id: "A03", status: "not-run", reason: "no-reviewed-pinned-real-profile-and-isolation" });
    assert.equal(result.e1bEligible, false);
    assert.equal(result.authority, "ephemeral-host-evidence-only");
    if (result.transport) {
      assert.equal(result.transport.ownershipEstablished, true);
      assert.equal(result.transport.treeCleanupVerified, true);
    }
    assert.equal(events.filter((event) => event.type === "spawn").length, events.filter((event) => event.type === "exit").length);
    for (const owned of result.fixtureTransport?.ownedProcesses || []) {
      assert.ok(Number.isSafeInteger(owned.pid) && owned.pid > 0);
      assert.ok(Number.isSafeInteger(owned.parentPid) && owned.parentPid > 0);
      assert.ok(Number.isFinite(Date.parse(owned.observedAt)));
      assert.equal(owned.ports, "none");
      assert.equal(await waitGone(owned.pid), true, `Owned LSP process ${owned.pid} remained alive.`);
    }
    return result;
  } finally {
    const entries = fs.readdirSync(runQaRoot);
    assert.deepEqual(entries, [], `Run QA root retained entries: ${entries.join(", ")}`);
    fs.rmdirSync(runQaRoot);
  }
}

function copyFake(name) {
  const fixtureRoot = fs.mkdtempSync(path.join(path.resolve(qaRoot), `owned-${process.pid}-${name}-`));
  const file = path.join(fixtureRoot, "lsp-host-fake-server.mjs");
  try {
    fs.copyFileSync(fakeServer, file, fs.constants.COPYFILE_EXCL);
    fs.copyFileSync(path.join(root, "test", "fixtures", "lsp-host-child.mjs"), path.join(fixtureRoot, "lsp-host-child.mjs"), fs.constants.COPYFILE_EXCL);
  } catch (error) {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    throw error;
  }
  return file;
}

function removeCopiedFake(file) {
  const qa = path.resolve(qaRoot);
  const owned = path.resolve(path.dirname(file));
  if (owned === qa || !owned.startsWith(`${qa}${path.sep}`) || !path.basename(owned).startsWith(`owned-${process.pid}-`)) throw new Error("Copied fake root escaped its QA root.");
  fs.rmSync(owned, { recursive: true });
}

function removeCurrentSnapshot(runQaRoot, relativePath) {
  const matches = [];
  for (const name of fs.readdirSync(runQaRoot)) {
    if (!name.startsWith("lsp-host-")) continue;
    const candidate = path.join(runQaRoot, name, "snapshot", relativePath);
    if (fs.existsSync(candidate)) matches.push(candidate);
  }
  if (matches.length !== 1) return false;
  fs.unlinkSync(matches[0]);
  return true;
}

async function waitForFile(file, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  return fs.existsSync(file);
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

async function waitGone(pid) {
  const deadline = Date.now() + 2_000;
  while (processExists(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  return !processExists(pid);
}

processTest("P01/P02 ready fake derives barrel and direct outgoing relations from didOpen", async () => {
  const barrel = await run("barrel");
  assert.equal(barrel.status, "completed");
  assert.equal(barrel.reason, "candidates");
  assert.equal(barrel.candidates.length, 1);
  assert.equal(barrel.candidates[0].caller.path, "caller.ts");
  assert.equal(barrel.candidates[0].target.path, "target.ts");
  const direct = await run("direct", baseSources.map((item) => item.path === "caller.ts" ? { ...item, text: item.text.replace("./barrel", "./target") } : item));
  assert.equal(direct.status, "completed");
  assert.equal(direct.candidates.length, 1);
});

processTest("P03/P04 semantic negatives and empty completion remain candidate-free", async () => {
  const falsePositiveSources = baseSources.map((item) => item.path === "caller.ts" ? { ...item, text: "import { target } from \"./barrel\";\nexport function caller(){ const text = \"target()\"; const ref = target; return [text, ref]; }" } : item);
  const falsePositive = await run("barrel", falsePositiveSources);
  assert.equal(falsePositive.status, "completed");
  assert.equal(falsePositive.provenance.publishedCandidateCount, 0);
  const brokenBarrelSources = baseSources.map((item) => item.path === "barrel.ts" ? { ...item, text: "export const unrelated = 1;" } : item);
  const brokenBarrel = await run("barrel", brokenBarrelSources);
  assert.equal(brokenBarrel.status, "completed");
  assert.equal(brokenBarrel.candidates.length, 0);
  for (const callerText of [
    "import { target } from \"./barrel\";\nexport function caller(){ const target = () => {}; target(); }",
    "import { target } from \"./barrel\";\nexport function caller(){ const obj = { target() {} }; obj.target(); }",
    "import { target } from \"./barrel\";\nexport function caller(){ function nested() { target(); } }",
    "// import { target } from \"./barrel\";\nexport function caller(){ target(); }",
  ]) {
    const negative = await run("barrel", baseSources.map((item) => item.path === "caller.ts" ? { ...item, text: callerText } : item));
    assert.equal(negative.status, "completed");
    assert.equal(negative.candidates.length, 0);
  }
  const commentedBarrel = await run("barrel", baseSources.map((item) => item.path === "barrel.ts" ? { ...item, text: `// ${item.text}` } : item));
  assert.equal(commentedBarrel.status, "completed");
  assert.equal(commentedBarrel.candidates.length, 0);
  const embeddedImport = ["const text = \"prefix" + "\\", "import { target } from './barrel';" + "\\", "\";", "function target() {}", "export function caller(){ target(); }"].join("\n");
  const stringImport = await run("barrel", baseSources.map((item) => item.path === "caller.ts" ? { ...item, text: embeddedImport } : item));
  assert.equal(stringImport.status, "completed");
  assert.equal(stringImport.candidates.length, 0);
  const embeddedExport = ["const text = \"prefix" + "\\", "export { target } from './target';" + "\\", "\";", "export const unrelated = 1;"].join("\n");
  const stringExport = await run("barrel", baseSources.map((item) => item.path === "barrel.ts" ? { ...item, text: embeddedExport } : item));
  assert.equal(stringExport.status, "completed");
  assert.equal(stringExport.candidates.length, 0);
  const regexBeforeEmbeddedExport = ["const marker = /\"/;", ...embeddedExport.split("\n"), "// \""].join("\n");
  const regexStringExport = await run("barrel", baseSources.map((item) => item.path === "barrel.ts" ? { ...item, text: regexBeforeEmbeddedExport } : item));
  assert.equal(regexStringExport.status, "completed");
  assert.equal(regexStringExport.candidates.length, 0);
  const embeddedTarget = ["const text = \"prefix" + "\\", "export function target() {}" + "\\", "\";"].join("\n");
  const regexBeforeEmbeddedTarget = ["const marker = /\"/;", ...embeddedTarget.split("\n"), "// \""].join("\n");
  const regexStringTarget = await run("barrel", baseSources.map((item) => item.path === "target.ts" ? { ...item, text: regexBeforeEmbeddedTarget } : item));
  assert.equal(regexStringTarget.status, "completed");
  assert.equal(regexStringTarget.candidates.length, 0);
  for (const [scenario, reason] of [["prepare-null", "no-prepared-item"], ["prepare-empty", "no-prepared-item"], ["hierarchy-null", "empty"], ["hierarchy-empty", "empty"]]) {
    const result = await run(scenario);
    assert.equal(result.status, "completed");
    assert.equal(result.reason, reason);
    assert.equal(result.candidates.length, 0);
  }
  const wrongMapping = await run("wrong-position");
  assert.equal(wrongMapping.status, "contaminated");
  assert.equal(wrongMapping.reason, "mapping-mismatch");
  const duplicateCallerSources = baseSources.map((item) => item.path === "barrel.ts" ? { ...item, text: `${item.text}\nexport function caller(){ target(); }` } : item);
  const wrongCallerDocument = await run("wrong-caller-document", duplicateCallerSources);
  assert.equal(wrongCallerDocument.status, "contaminated");
  assert.equal(wrongCallerDocument.reason, "mapping-mismatch");
});

processTest("P05/P06 allowed notifications and server requests do not create authority or side effects", async () => {
  for (const scenario of ["notifications", "server-requests", "fragmented"]) {
    const result = await run(scenario);
    assert.equal(result.status, "completed");
    assert.equal(result.candidates.length, 1);
  }
  for (const [scenario, reason] of [["notification-flood", "notification-limit"], ["unknown-notification", "unsupported-server-notification"], ["unknown-server-request", "unsupported-server-request"], ["invalid-show-message", "invalid-message"], ["frame-oversize", "frame-oversize"]]) {
    const result = await run(scenario);
    assert.equal(result.status, "failed");
    assert.equal(result.reason, reason);
    assert.equal(result.candidates.length, 0);
  }
  assert.equal(fs.existsSync(path.join(root, ".head")), false);
  assert.equal(fs.existsSync(path.join(root, ".lode")), false);
});

processTest("P07/P09 protocol corruption, ambiguity, timeout, cancellation, and crash fail closed", async () => {
  for (const [scenario, reason, failureStage] of [
    ["bad-header", "invalid-framing", "initialize"], ["invalid-json", "invalid-json", "initialize"], ["unknown-id", "unknown-response-id", "initialize"],
    ["duplicate-id", "duplicate-response-id", "prepare"], ["late-response", "duplicate-response-id", "hierarchy"],
    ["ambiguous", "ambiguous-prepared-item", "prepare"], ["timeout", "request-timeout", "prepare"], ["crash", "process-crash", "prepare"],
  ]) {
    const result = await run(scenario);
    assert.equal(result.status, "failed", scenario);
    assert.equal(result.reason, reason, scenario);
    assert.equal(result.candidates.length, 0, scenario);
    assert.equal(result.failureStage, failureStage, scenario);
  }
  const abortFile = copyFake("external-abort");
  const trace = `${abortFile}.trace`;
  const controller = new AbortController();
  try {
    const running = run("external-abort", baseSources, { serverFile: abortFile, signal: controller.signal });
    assert.equal(await waitForFile(trace), true, "External abort fixture never observed prepare.");
    controller.abort();
    const cancelled = await running;
    assert.equal(cancelled.status, "failed");
    assert.equal(cancelled.reason, "cancelled");
    assert.equal(cancelled.failureStage, "prepare");
    const methods = cancelled.fixtureTransport.transcript.filter((item) => item.direction === "out").map((item) => item.method);
    for (const method of ["$/cancelRequest", "textDocument/didClose", "shutdown", "exit"]) assert.ok(methods.includes(method), `Missing external cancel cleanup message ${method}.`);
  } finally {
    removeCopiedFake(abortFile);
  }
});

processTest("P08/P11 ownership and endpoint contamination never publish candidates", async () => {
  for (const [scenario, reason] of [["external-uri", "uri-outside-snapshot"], ["invalid-range", "invalid-range"]]) {
    const result = await run(scenario);
    assert.equal(result.status, "contaminated");
    assert.equal(result.reason, reason);
    assert.equal(result.candidates.length, 0);
  }
  const stale = profile("barrel");
  stale.serverDigest = sha256("stale");
  const result = await collectOutgoingCallEvidence({ projectId: "fixture-project", generationDigest, sources: baseSources, profile: stale, supervisorSelection: selection, qaRoot });
  assert.equal(result.status, "contaminated");
  assert.equal(result.reason, "profile-drift");
});

processTest("P10 repeated and reordered execution preserves semantic digest", async () => {
  const twoCalls = baseSources.map((item) => item.path === "caller.ts" ? { ...item, text: item.text.replace("target();", "target(); target();") } : item);
  const first = await run("barrel", twoCalls);
  const second = await run("barrel", twoCalls);
  const reordered = await run("reordered", twoCalls);
  assert.equal(first.candidates.length, 2);
  assert.deepEqual(first.candidates.map((item) => item.semanticDigest), second.candidates.map((item) => item.semanticDigest));
  assert.deepEqual(first.candidates.map((item) => item.semanticDigest), reordered.candidates.map((item) => item.semanticDigest));
  assert.notEqual(first.candidates[0].semanticDigest, first.candidates[1].semanticDigest);
});

processTest("P13/P17 ready profile exercises owned bridge, fake server, and intentional grandchild cleanup", async () => {
  const result = await run("grandchild");
  assert.equal(result.status, "completed");
  assert.equal(result.candidates.length, 1);
  const pids = result.fixtureTransport?.testOwnedPids || result.fixtureTransport?.ownedPids || [];
  assert.ok(pids.length >= 2);
  for (const pid of pids) assert.equal(await waitGone(pid), true, `Owned fixture process ${pid} remained alive.`);
  const negativeSources = baseSources.map((item) => item.path === "caller.ts" ? { ...item, text: item.text.replace("target();", "const value = target;") } : item);
  const negative = await run("barrel", negativeSources);
  assert.equal(negative.provenance.publishedCandidateCount, 0);
  const flood = await run("grandchild-flood");
  assert.equal(flood.status, "failed");
  assert.ok(flood.fixtureTransport.ownedPids.length >= 2);
  for (const pid of flood.fixtureTransport.ownedPids) assert.equal(await waitGone(pid), true, `Flood grandchild ${pid} remained alive.`);
  const cancelFile = copyFake("grandchild-cancel");
  const trace = `${cancelFile}.trace`;
  const controller = new AbortController();
  try {
    const running = run("grandchild-cancel", baseSources, { serverFile: cancelFile, signal: controller.signal });
    assert.equal(await waitForFile(trace), true);
    const traceMatch = fs.readFileSync(trace, "utf8").match(/:(\d+):ready/);
    assert.ok(traceMatch, "Grandchild cancel trace did not contain a ready PID.");
    const readyPid = Number(traceMatch[1]);
    assert.equal(processExists(readyPid), true, "Grandchild exited before cancellation.");
    controller.abort();
    const cancelled = await running;
    assert.equal(cancelled.reason, "cancelled");
    for (const pid of cancelled.fixtureTransport.ownedPids) assert.equal(await waitGone(pid), true, `Cancelled grandchild ${pid} remained alive.`);
  } finally {
    removeCopiedFake(cancelFile);
  }
});

processTest("P12/P18 shared deadlines, stderr, final producer, and setup cleanup are actual branches", async () => {
  const slowWorkStarted = Date.now();
  const slowWork = await run("slow-work");
  assert.equal(slowWork.status, "failed");
  assert.equal(slowWork.reason, "request-timeout");
  assert.equal(slowWork.candidates.length, 0);
  assert.ok(Date.now() - slowWorkStarted < 16_000);
  const slowShutdownStarted = Date.now();
  const slowShutdown = await run("slow-shutdown");
  assert.equal(slowShutdown.status, "failed");
  assert.equal(slowShutdown.reason, "request-timeout");
  assert.equal(slowShutdown.failureStage, "closing");
  assert.equal(slowShutdown.candidates.length, 0);
  assert.ok(Date.now() - slowShutdownStarted < 4_000);
  const stderrStarted = Date.now();
  const stderrLimited = await run("stderr-limit");
  assert.equal(stderrLimited.status, "failed");
  assert.equal(stderrLimited.reason, "stderr-limit");
  assert.equal(stderrLimited.failureStage, "prepare");
  assert.equal(stderrLimited.candidates.length, 0);
  assert.ok(Date.now() - stderrStarted < 4_000);

  const foreignRoot = fs.mkdtempSync(path.join(path.resolve(qaRoot), `lsp-host-000foreign-${process.pid}-`));
  const foreignSentinel = path.join(foreignRoot, "snapshot", "target.ts");
  const collisionBoundary = fs.mkdtempSync(path.join(path.resolve(qaRoot), `foreign-collision-${process.pid}-`));
  const legacyCollisionRoot = path.join(collisionBoundary, `lsp-host-000foreign-${process.pid}`);
  const legacyCollisionSentinel = path.join(legacyCollisionRoot, "snapshot", "keep-existing.txt");
  fs.mkdirSync(path.dirname(foreignSentinel), { recursive: true });
  fs.writeFileSync(foreignSentinel, "foreign-sentinel", { encoding: "utf8", flag: "wx" });
  fs.mkdirSync(path.dirname(legacyCollisionSentinel), { recursive: true });
  fs.writeFileSync(legacyCollisionSentinel, "keep-existing", { encoding: "utf8", flag: "wx" });
  try {
    for (const [relativePath, reason] of [["target.ts", "source-drift"], ["tsconfig.json", "config-drift"]]) {
      let removed = false;
      const drift = await run("barrel", baseSources, { onProcessEvent: (event, runQaRoot) => {
        if (!removed && event.type === "exit") removed = removeCurrentSnapshot(runQaRoot, relativePath);
      } });
      assert.equal(removed, true, `${relativePath} was not removed at the final validation boundary.`);
      assert.equal(drift.status, "contaminated");
      assert.equal(drift.reason, reason);
      assert.equal(drift.failureStage, "closing");
      assert.deepEqual(drift.cleanup, { attempted: true, verified: true, forced: false });
      assert.equal(drift.transport.treeCleanupVerified, true);
      assert.equal(drift.candidates.length, 0);
    }
    assert.equal(fs.readFileSync(foreignSentinel, "utf8"), "foreign-sentinel");
    assert.equal(fs.readFileSync(legacyCollisionSentinel, "utf8"), "keep-existing");
  } finally {
    fs.rmSync(foreignRoot, { recursive: true });
    assert.equal(fs.readFileSync(legacyCollisionSentinel, "utf8"), "keep-existing");
    fs.rmSync(collisionBoundary, { recursive: true });
  }

  const before = new Set(fs.readdirSync(qaRoot));
  const collision = await collectOutgoingCallEvidence({
    projectId: "fixture-project", generationDigest,
    sources: [{ path: "folder.ts", text: "x" }, { path: "folder.ts/nested.ts", text: "x" }, { path: "caller.ts", text: "export function caller(){}" }],
    profile: profile("barrel"), supervisorSelection: selection, qaRoot,
  });
  assert.equal(collision.status, "failed");
  assert.equal(collision.reason, "invalid-input");
  assert.deepEqual(fs.readdirSync(qaRoot).filter((name) => !before.has(name) && name.startsWith("lsp-host-")), []);

  const deleteFile = copyFake("delete-self");
  const producer = await run("delete-self", baseSources, { serverFile: deleteFile });
  assert.equal(producer.status, "contaminated");
  assert.equal(producer.reason, "producer-mismatch");
  assert.equal(producer.candidates.length, 0);
  removeCopiedFake(deleteFile);
});

test("P15/P16 absent profile and public integration remain explicit", async () => {
  const result = await collectOutgoingCallEvidence({ projectId: "fixture-project", generationDigest, sources: baseSources, profile: null });
  assert.equal(result.status, "not-configured");
  assert.equal(result.reason, "no-profile");
  assert.equal(result.provenance.producerDigest, null);
  assert.equal(result.realSupport, false);
});

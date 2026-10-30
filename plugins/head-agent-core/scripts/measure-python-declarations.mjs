// Developer measurement only. Never a runtime, deployment or semantic gate.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { initializeProject } from "./lib/head-core.mjs";
import { buildWorldModel, inspectWorldModelStatus } from "./lib/world-model.mjs";
import { createRepositoryScanReferenceAdapter } from "./lib/repository-scan.mjs";
import { dispatch } from "./mcp-server.mjs";

export const RUNTIME_BASELINE = "86c88d1ec105d11621122c050c3b0f298574bee1";
const pluginRoot = path.resolve(import.meta.dirname, ".."), script = fileURLToPath(import.meta.url);
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const selected = 'def target(value: str = "a  b"):\n    return value.strip()';
const large = Array.from({ length: 40 }, (_, i) => `def helper${i}():\n    return "${"x".repeat(900)}"\n\n`).join("") + selected + "\n";
const small = "def small(): return 1\n";
const fixture = Object.fromEntries(Object.entries({ large, small, selected }).map(([key, value]) => [key, { bytes: Buffer.byteLength(value), sha256: digest(value) }]));
const need = (kind, symbol = "", selection) => ({ kind, path: "module.py", symbol, ...(selection ? { selection } : {}) });
const ioNames = ["readFileSync", "readSync", "openSync", "lstatSync", "fstatSync", "realpathSync"];
const counter = () => Object.fromEntries(ioNames.map((key) => [key, 0]));
const delta = (a, b) => Object.fromEntries(ioNames.map((key) => [key, a[key] - b[key]]));
const metrics = ["elapsedMs", "structuredBytes", "envelopeBytes", "dispatchCalls", "explicitLocalReads", "childProcesses", "identityProcesses", "parseProcesses", "sourceBytesReturned"];

export function median(values) {
  assert.ok(values.length && values.every(Number.isFinite), "finite samples required");
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
export function verifySourceResult(result, kind, expected) {
  assert.equal(result.status, "observed", JSON.stringify(result.results)); assert.equal(result.results.length, 1);
  const item = result.results[0], evidence = result.context.capsule.observationEvidence;
  assert.equal(item.includedInContext, true); assert.deepEqual(result.context.capsule.evidenceGaps, []);
  assert.equal(evidence.length, 1); assert.equal(evidence[0].nodeId, item.observationId);
  if (kind === "source") {
    assert.equal(item.omittedSourceBytes, 0); assert.equal(evidence[0].payload.details, expected);
    return { exactEqual: true, omittedBytes: 0, sourceBytesReturned: Buffer.byteLength(expected), reused: item.reused, contextIncluded: true };
  }
  const details = JSON.parse(evidence[0].payload.details);
  assert.equal(details.status, "ready"); assert.equal(details.omitted, 0);
  if (kind === "selected-source") { assert.equal(details.source, expected); assert.equal(details.declarations.length, 1); }
  else {
    assert.equal(details.total, 41); assert.equal(details.declarations.length, 41);
    assert.equal(details.declarations.filter((d) => d.qualifiedName === "target").length, 1);
  }
  return { contextIncluded: true, exactEqual: kind === "selected-source" ? true : null, omittedDeclarations: 0,
    sourceBytesReturned: kind === "selected-source" ? Buffer.byteLength(expected) : 0, reused: item.reused,
    ...(kind === "declarations" ? { selectedQualifiedName: "target", declarationCount: 41 } : {}) };
}
export function aggregateTrials(trials) {
  assert.equal(trials.length, 3); assert.equal(new Set(trials.map((t) => t.trial)).size, 3);
  const labels = trials[0].measurements.map((m) => m.label);
  assert.equal(new Set(labels).size, labels.length);
  for (const trial of trials) {
    assert.deepEqual(trial.measurements.map((m) => m.label), labels);
    assert.deepEqual(trial.fixture, trials[0].fixture);
    assert.ok(trial.measurements.every((m) => m.verified === true), "unverified results cannot enter success aggregates");
    assert.ok(trial.measurements.every((m) => Number.isFinite(m.elapsedMs) && m.elapsedMs >= 0), "valid measured latency required");
  }
  return labels.map((label) => {
    const rows = trials.map((t) => t.measurements.find((m) => m.label === label));
    return { label, samples: rows.map((row, i) => ({ trial: trials[i].trial, ...row })),
      medians: Object.fromEntries(metrics.map((key) => [key, rows.every((r) => Number.isFinite(r[key])) ? median(rows.map((r) => r[key])) : null])) };
  });
}
export async function runTrial(trial, output) {
  const startupUptimeMs = process.uptime() * 1000, trialStart = performance.now();
  fs.mkdirSync(output, { recursive: true });
  const root = fs.mkdtempSync(path.join(process.env.HEAD_AGENT_TEST_TMP || os.tmpdir(), "declaration-cost-"));
  const events = [], measurements = [], io = counter(), originals = {};
  let active = null, collectionProfile = null;
  const onProcess = (event) => {
    const entry = { ...event, label: active?.label };
    if (event.event === "started") entry.phase = active.starts++ === 0 ? "identity" : "parse";
    events.push(entry); fs.appendFileSync(path.join(output, "processes.jsonl"), `${JSON.stringify(entry)}\n`);
  };
  for (const name of ioNames) { originals[name] = fs[name]; fs[name] = function (...args) { io[name]++; return Reflect.apply(originals[name], this, args); }; }
  const empty = { dispatchCalls: 0, localOperations: 0, explicitLocalReads: 0, childProcesses: 0, identityProcesses: 0, parseProcesses: 0, sourceBytesReturned: 0, structuredBytes: null, envelopeBytes: null };
  function local(label, fn, verify, explicitLocalReads = 0) {
    const before = { ...io }, start = performance.now(), value = fn(), elapsedMs = performance.now() - start, filesystemApiCalls = delta(io, before);
    measurements.push({ ...empty, label, elapsedMs, filesystemApiCalls, explicitLocalReads, localOperations: 1, ...verify(value), verified: true }); return value;
  }
  async function call(label, name, args, verify) {
    active = { label, starts: 0 };
    const before = { ...io }, offset = events.length, start = performance.now();
    const response = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { project_root: root, ...args } } }, { onProcess });
    const elapsedMs = performance.now() - start, filesystemApiCalls = delta(io, before);
    fs.writeFileSync(path.join(output, `${label}.json`), JSON.stringify({ request: { name, arguments: args }, response }));
    assert.ok(!response.error && !response.result?.isError, JSON.stringify(response));
    const value = response.result.structuredContent, correctness = verify(value), children = events.slice(offset).filter((e) => e.event === "started");
    measurements.push({ ...empty, label, elapsedMs, filesystemApiCalls, dispatchCalls: 1, structuredBytes: bytes(value), envelopeBytes: bytes(response),
      childProcesses: children.length, identityProcesses: children.filter((e) => e.phase === "identity").length,
      parseProcesses: children.filter((e) => e.phase === "parse").length, ...correctness, verified: true }); return value;
  }
  function sum(label, members) {
    const rows = members.map((m) => measurements.find((r) => r.label === m)); assert.ok(rows.every(Boolean));
    measurements.push({ label, derivedSum: members, verified: rows.every((r) => r.verified),
      ...Object.fromEntries(metrics.map((key) => [key, key === "envelopeBytes" && rows.some((r) => r[key] === null) ? null : rows.reduce((n, r) => n + (r[key] ?? 0), 0)])),
      note: "component latency sum, not separate wall clock; null envelope where a component has no MCP envelope" });
  }
  try {
    local("project.initialize", () => initializeProject({ root, pluginRoot, runtimes: ["codex"] }), () => ({ purpose: "common prerequisite; output not sent to model" }));
    fs.writeFileSync(path.join(root, "module.py"), large);
    for (const pass of ["initial", "repeated"]) {
      for (const [label, kind, symbol] of [["source", "source", ""], ["known-selected", "selected-source", "target"], ["outline", "declarations", ""]]) {
        const result = await call(`large.${label}.${pass}`, "head_source_context", { task: "Read target declaration", needs: [need(kind, symbol)] }, (v) => verifySourceResult(v, kind, kind === "source" ? large : selected));
        if (kind === "declarations") {
          const details = JSON.parse(result.context.capsule.observationEvidence[0].payload.details), chosen = details.declarations.find((d) => d.qualifiedName === "target");
          collectionProfile = details.collectionProfile;
          await call(`large.outline-selected.${pass}`, "head_source_context", { task: "Read target declaration", needs: [need("selected-source", "target", chosen.selection)] }, (v) => verifySourceResult(v, "selected-source", selected));
          sum(`large.outline-total.${pass}`, [`large.outline.${pass}`, `large.outline-selected.${pass}`]);
        }
      }
    }
    const before = { ...io }, start = performance.now(); await buildWorldModel({ root, computeAdapter: createRepositoryScanReferenceAdapter() });
    measurements.push({ ...empty, label: "world.build", localOperations: 1, elapsedMs: performance.now() - start, filesystemApiCalls: delta(io, before), verified: true,
      note: "local JS build; validity checked by subsequent currentness and queries; not sent to model" });
    for (const pass of ["initial", "repeated"]) {
      local(`world.currentness.${pass}`, async () => (await inspectWorldModelStatus({ root })), (v) => { assert.equal(v.status, "current"); return { status: "current" }; });
      for (const [label, query, limit] of [["known", "target", 2], ["outline", "module.py", 500]]) {
        const graph = await call(`world.${label}-query.${pass}`, "head_world_query", { query, depth: 0, limit }, (g) => {
          assert.equal(g.status, "current"); assert.equal(g.truncated, false);
          assert.equal(g.nodes.filter((n) => n.kind === "Symbol" && n.qualifiedName === "target" && n.path === "module.py").length, 1);
          if (label === "known") assert.equal(g.nodes.length, 1); else assert.equal(g.nodes.filter((n) => n.kind === "Symbol").length, 41);
          return { status: "current", nodeCount: g.nodes.length, truncated: false, query, limit, currentnessIncludedInQuery: true };
        });
        const symbol = graph.nodes.find((n) => n.kind === "Symbol" && n.qualifiedName === "target");
        local(`world.${label}-range.${pass}`, () => fs.readFileSync(path.join(root, "module.py"), "utf8").split("\n").slice(symbol.line - 1, symbol.endLine).join("\n"), (excerpt) => {
          assert.ok(excerpt.includes(selected)); return { structuredBytes: bytes({ path: "module.py", source: excerpt }), sourceBytesReturned: Buffer.byteLength(excerpt),
            exactEqual: excerpt === selected, containsTarget: true, line: symbol.line, endLine: symbol.endLine, note: "original World range; not silently trimmed; no MCP envelope" };
        }, 1);
        sum(`world.${label}-total.${pass}`, [`world.${label}-query.${pass}`, `world.${label}-range.${pass}`]);
        if (label === "known" && pass === "initial") sum("world.build-plus-known.initial", ["world.build", `world.${label}-query.${pass}`, `world.${label}-range.${pass}`]);
      }
    }
    fs.writeFileSync(path.join(root, "module.py"), small);
    for (const pass of ["initial", "repeated"]) {
      await call(`small.source.${pass}`, "head_source_context", { task: "Read small function", needs: [need("source")] }, (v) => verifySourceResult(v, "source", small));
      await call(`small.selected.${pass}`, "head_source_context", { task: "Read small function", needs: [need("selected-source", "small")] }, (v) => verifySourceResult(v, "selected-source", small.trimEnd()));
    }
    const children = events.filter((e) => e.event === "started"); assert.ok(children.every((e) => events.some((c) => c.event === "closed" && c.pid === e.pid)));
    const rows = measurements.filter((m) => !m.derivedSum);
    const result = { trial, fixture, runtimeBaseline: RUNTIME_BASELINE, collectionProfile,
      environment: { node: process.version, platform: process.platform, arch: process.arch, osRelease: os.release(), cpu: os.cpus()[0]?.model }, startupUptimeMs,
      trialBodyMs: performance.now() - trialStart, measurements,
      totals: { dispatchCalls: rows.reduce((n, r) => n + r.dispatchCalls, 0), explicitLocalReads: rows.reduce((n, r) => n + r.explicitLocalReads, 0), childProcesses: children.length, closedChildProcesses: events.filter((e) => e.event === "closed").length,
        filesystemApiCalls: Object.fromEntries(ioNames.map((key) => [key, rows.reduce((n, r) => n + (r.filesystemApiCalls?.[key] ?? 0), 0)])) },
      instrumentation: "sync filesystem API invocations, not physical IO; child Python file reads uncounted; identical counter overhead across paths",
      currentness: "explicit diagnostic measured separately; queries include built-in currentness, so do not add the optional diagnostic to normal query totals",
      latencyScope: "dispatch/local operation only; excludes harness assertions, raw log serialization and result file writes; trialBodyMs includes harness work" };
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2)); return result;
  } catch (error) { fs.writeFileSync(path.join(output, "failure.json"), JSON.stringify({ trial, error: error.stack, measurements }, null, 2)); throw error; }
  finally { for (const name of ioNames) fs[name] = originals[name]; fs.rmSync(root, { recursive: true, force: true }); }
}
async function main() {
  const args = process.argv.slice(2), output = args[args.indexOf("--output") + 1];
  if (!args.includes("--output") || !path.isAbsolute(output)) throw new Error("Use --output <new absolute measurement directory>");
  if (args.includes("--trial")) { await runTrial(Number(args[args.indexOf("--trial") + 1]), output); return; }
  fs.mkdirSync(output);
  const parentUptimeAtStartMs = process.uptime() * 1000, start = performance.now(), launches = [], trials = [];
  for (const trial of [1, 2, 3]) {
    const directory = path.join(output, `trial-${trial}`); fs.mkdirSync(directory);
    const command = [process.execPath, script, "--trial", String(trial), "--output", directory];
    const record = { trial, command, cwd: pluginRoot, ports: [], parentPid: process.pid };
    const log = (entry) => fs.appendFileSync(path.join(output, "runner-processes.jsonl"), `${JSON.stringify(entry)}\n`);
    log({ ...record, event: "planned" }); const launchStart = performance.now();
    await new Promise((resolve, reject) => {
      const child = spawn(command[0], command.slice(1), { cwd: pluginRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      log({ ...record, event: "started", pid: child.pid }); const stdout = [], stderr = [];
      child.stdout.on("data", (b) => stdout.push(b)); child.stderr.on("data", (b) => stderr.push(b)); child.on("error", reject);
      child.on("close", (code) => {
        log({ ...record, event: "closed", pid: child.pid, exitCode: code });
        fs.writeFileSync(path.join(directory, "stdout.txt"), Buffer.concat(stdout)); fs.writeFileSync(path.join(directory, "stderr.txt"), Buffer.concat(stderr));
        launches.push({ trial, childWallMs: performance.now() - launchStart, exitCode: code });
        code === 0 ? resolve() : reject(new Error(`trial ${trial} failed; raw evidence preserved`));
      });
    });
    trials.push(JSON.parse(fs.readFileSync(path.join(directory, "result.json"), "utf8")));
  }
  const report = { runtimeBaseline: RUNTIME_BASELINE, parentUptimeAtStartMs, runnerWallMs: performance.now() - start, launches, fixture, trials, aggregates: aggregateTrials(trials),
    executionOrder: "3 sequential fresh trial processes; each: large source/known/outline+selection initial then repeat; World build/currentness/known/outline initial then repeat; small source/selected initial then repeat",
    limits: ["fresh process is not OS cold cache", "fixed order permits warm-up and filesystem-cache effects", "in-process dispatch serialization, not stdio wire or installed Host cost", "local reads have no invented MCP envelope",
      "World known query uses limit 2 to detect truncation; limit 1 always marks a single result truncated", "three synthetic samples are not statistical or universal superiority evidence", "no provider calls or runtime changes"],
    providerTokens: "UNKNOWN", providerCost: "UNKNOWN", providerPromptCache: "UNKNOWN", installedHostSavings: "UNKNOWN" };
  fs.writeFileSync(path.join(output, "summary.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ summary: path.join(output, "summary.json"), trials: 3, runnerWallMs: report.runnerWallMs, runtimeBaseline: RUNTIME_BASELINE }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === script) await main();

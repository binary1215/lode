#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { tools } from "./mcp-server.mjs";
import { previewContextWorkflow } from "./lib/context-workflow.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");

function sourceRevision(root) {
  let cursor = root;
  for (let depth = 0; depth < 8; depth += 1) {
    const marker = path.join(cursor, ".git");
    if (fs.existsSync(marker)) {
      try {
        const gitDirectory = fs.statSync(marker).isDirectory() ? marker
          : path.resolve(cursor, fs.readFileSync(marker, "utf8").trim().replace(/^gitdir:\s*/, ""));
        const head = fs.readFileSync(path.join(gitDirectory, "HEAD"), "utf8").trim();
        if (/^[a-f0-9]{40,64}$/.test(head)) return { status: "observed", commit: head, worktreeClean: "not-measured" };
        const ref = head.replace(/^ref:\s*/, "");
        if (!ref.startsWith("refs/") || ref.includes("..")) break;
        const common = fs.existsSync(path.join(gitDirectory, "commondir"))
          ? path.resolve(gitDirectory, fs.readFileSync(path.join(gitDirectory, "commondir"), "utf8").trim()) : gitDirectory;
        for (const directory of new Set([gitDirectory, common])) {
          const loose = path.join(directory, ref);
          const commit = fs.existsSync(loose) ? fs.readFileSync(loose, "utf8").trim()
            : fs.existsSync(path.join(directory, "packed-refs"))
              ? fs.readFileSync(path.join(directory, "packed-refs"), "utf8").split(/\r?\n/).find((line) => line.endsWith(` ${ref}`))?.split(" ")[0] : null;
          if (/^[a-f0-9]{40,64}$/.test(commit || "")) return { status: "observed", commit, worktreeClean: "not-measured" };
        }
      } catch { /* A source archive or unreadable Git metadata is a usable diagnostic input. */ }
      break;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return { status: "unavailable", gitRequired: false };
}

function dependencySummary(root) {
  const library = path.join(root, "scripts", "lib");
  const files = fs.readdirSync(library, { withFileTypes: true })
    .filter((item) => item.isFile() && item.name.endsWith(".mjs"))
    .map((item) => path.join(library, item.name)).sort();
  const known = new Set(files);
  const graph = new Map();
  let sourceLines = 0;
  let sourceUtf8Bytes = 0;
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    sourceLines += source.split(/\r?\n/).length;
    sourceUtf8Bytes += Buffer.byteLength(source);
    const imports = [...source.matchAll(/^\s*(?:import\s+(?:(?:[\w*$\s{},]+)\s+from\s+)?|export\s+(?:[\w*$\s{},]+)\s+from\s+)["'](\.[^"']+)["']/gm)];
    graph.set(file, [...new Set(imports.map((match) => path.resolve(path.dirname(file), match[1])).filter((target) => known.has(target)))]);
  }
  const index = new Map();
  const low = new Map();
  const stack = [];
  const active = new Set();
  const cycles = [];
  let next = 0;
  function visit(node) {
    index.set(node, next);
    low.set(node, next++);
    stack.push(node);
    active.add(node);
    for (const target of graph.get(node)) {
      if (!index.has(target)) { visit(target); low.set(node, Math.min(low.get(node), low.get(target))); }
      else if (active.has(target)) low.set(node, Math.min(low.get(node), index.get(target)));
    }
    if (low.get(node) !== index.get(node)) return;
    const component = [];
    let member;
    do { member = stack.pop(); active.delete(member); component.push(member); } while (member !== node);
    if (component.length > 1 || graph.get(node).includes(node)) cycles.push(component.map((file) => path.relative(root, file).replaceAll("\\", "/")).sort());
  }
  for (const file of files) if (!index.has(file)) visit(file);
  return {
    moduleCount: files.length, sourceLines, sourceUtf8Bytes,
    staticRelativeImportEdges: [...graph.values()].reduce((count, targets) => count + targets.length, 0),
    cyclicComponents: cycles.sort((left, right) => left[0].localeCompare(right[0])),
    method: "static-relative-import-declaration-text-scan-within-scripts/lib",
    limitations: "Text scan, not a JavaScript parser; excludes dynamic imports, comments may affect results; no runtime cost or architectural defect inferred.",
  };
}

// Process-local instrumentation only. It is never installed by the plugin runtime.
async function observePreview(operation) {
  const originals = new Map();
  const metrics = { readFileSyncCalls: 0, readFileSyncReturnedPayloadBytes: 0, readSyncCalls: 0, readSyncReturnedBytes: 0, filesystemMutationAttempts: 0 };
  const replace = (name, fn) => { originals.set(name, fs[name]); fs[name] = fn; };
  const readFile = fs.readFileSync;
  replace("readFileSync", function (...args) {
    const value = Reflect.apply(readFile, fs, args);
    metrics.readFileSyncCalls += 1;
    metrics.readFileSyncReturnedPayloadBytes += typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.byteLength;
    return value;
  });
  const read = fs.readSync;
  replace("readSync", function (...args) {
    const count = Reflect.apply(read, fs, args);
    metrics.readSyncCalls += 1;
    metrics.readSyncReturnedBytes += count;
    return count;
  });
  const rejectWrite = () => {
    metrics.filesystemMutationAttempts += 1;
    const error = new Error("Context diagnostic attempted a filesystem mutation.");
    error.code = "DIAGNOSTIC_READ_ONLY_VIOLATION";
    throw error;
  };
  for (const name of ["writeFileSync", "appendFileSync", "writeSync", "mkdirSync", "mkdtempSync", "renameSync", "copyFileSync", "cpSync", "unlinkSync", "rmSync", "rmdirSync", "truncateSync", "ftruncateSync", "chmodSync", "chownSync", "utimesSync", "symlinkSync", "linkSync"]) {
    replace(name, rejectWrite);
  }
  const open = fs.openSync;
  replace("openSync", function (file, flags, ...rest) {
    if (typeof flags === "string" ? /[wa+]/.test(flags)
      : (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0) rejectWrite();
    return Reflect.apply(open, fs, [file, flags, ...rest]);
  });
  const start = performance.now();
  try { return { result: await operation(), elapsedMs: performance.now() - start, observedFs: metrics }; }
  finally { for (const [name, original] of originals) fs[name] = original; }
}

function percentiles(values) {
  if (!values.length) return { sampleCount: 0, p50Ms: null, p95Ms: null };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    sampleCount: sorted.length,
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}

export async function measureContextDiagnostics({ project = null, task = null, iterations = 5 } = {}) {
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 20) throw new Error("iterations must be an integer from 1 to 20");
  if ((project !== null || task !== null) && (typeof project !== "string" || !project.trim() || typeof task !== "string" || !task.trim())) {
    throw new Error("Provide both --project and --task for optional Context preview measurements.");
  }
  const countHint = (value) => tools.filter((tool) => tool.annotations?.readOnlyHint === value).length;
  const report = {
    schemaVersion: 1, kind: "ContextDiagnosticsReport",
    runtime: { node: process.version, platform: process.platform, architecture: process.arch, osRelease: os.release() },
    sourceRevision: sourceRevision(pluginRoot),
    mcpCatalog: {
      tools: tools.length, catalogArrayUtf8Bytes: Buffer.byteLength(JSON.stringify(tools), "utf8"),
      readOnlyTrue: countHint(true), readOnlyFalse: countHint(false),
      readOnlyHintMissing: tools.filter((tool) => !Object.hasOwn(tool.annotations || {}, "readOnlyHint")).length,
      readOnlyHintInvalid: tools.filter((tool) => Object.hasOwn(tool.annotations || {}, "readOnlyHint") && typeof tool.annotations.readOnlyHint !== "boolean").length,
      modelContextDeliveryBytes: "not-measured-host-discovery-dependent",
    },
    dependencies: dependencySummary(pluginRoot),
    contextPreview: { status: "not-requested" },
    interpretation: {
      authorityEffect: "none", persisted: false, persistsCapsule: false,
      timingInCapsuleIdentity: false,
      headDiscoveryQuality: "not-measured", semanticSufficiency: "not-measured-HEAD-owned",
      taskResumeAndFinalEditCorrectness: "not-measured-requires-independent-end-to-end-evaluation",
      repositoryCoverage: "Mechanical inclusion of indexed source records is not proof of source body consumption by the executor.",
    },
  };
  if (project !== null) {
    const samples = [];
    for (let index = 0; index < iterations; index += 1) {
      const { result, elapsedMs, observedFs } = await observePreview(async () => (await previewContextWorkflow({ root: project, task, evidenceNeeds: [] })));
      const { capsule, workflow } = result;
      samples.push({
        iteration: index + 1, phase: index === 0 ? "first-preview-in-process" : "repeated-preview-in-process",
        elapsedMs, observedFs, capsuleId: capsule.capsuleId, capsuleHash: capsule.capsuleHash,
        workflowStatus: workflow.status, worldState: workflow.world.state,
        evidenceGapCount: capsule.evidenceGaps.length,
        semanticSufficiencyOwner: "HEAD",
        repositoryRecordCount: capsule.repositoryContext.length,
        usedApproxTokens: capsule.budget.usedApproxTokens, maxApproxTokens: capsule.budget.maxApproxTokens,
      });
    }
    report.contextPreview = {
      status: "measured", taskSha256: createHash("sha256").update(task).digest("hex"), iterations,
      evidenceNeedSource: "none-lexical-baseline-only", samples,
      firstCall: percentiles(samples.slice(0, 1).map((sample) => sample.elapsedMs)),
      repeatedCalls: percentiles(samples.slice(1).map((sample) => sample.elapsedMs)),
      allCalls: percentiles(samples.map((sample) => sample.elapsedMs)),
      stableCapsuleIdentity: new Set(samples.map((sample) => sample.capsuleHash)).size === 1,
      osColdCache: "not-controlled-not-claimed", moduleImportTime: "excluded",
      fsMeasurement: "Observed synchronous fs API returned payload bytes only; UTF-8 strings re-encoded. Counters can overlap and must not be summed. Excludes async, native and child-process I/O; not physical disk I/O or cache-miss measurement.",
      noRefreshOrPersistenceRequested: true,
    };
  }
  return report;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.stderr.write(`${JSON.stringify({ event: "diagnostic-process", pid: process.pid, parentPid: process.ppid, command: "measure-context-diagnostics.mjs", cwd: process.cwd(), ports: [] })}\n`);
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--help") {
      process.stdout.write("Usage: node scripts/measure-context-diagnostics.mjs [--project <existing-project> --task <task>] [--iterations 1..20]\nRead-only local measurements. No provider call, refresh, initialization, or saved report.\n");
    } else {
      const options = {};
      for (let index = 0; index < args.length; index += 2) {
        const key = { "--project": "project", "--task": "task", "--iterations": "iterations" }[args[index]];
        if (!key || args[index + 1] === undefined || Object.hasOwn(options, key)) throw new Error("Unknown, repeated, or incomplete option. Use --help.");
        options[key] = key === "iterations" ? Number(args[index + 1]) : args[index + 1];
      }
      process.stdout.write(`${JSON.stringify(await measureContextDiagnostics(options), null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "failed", code: error.code || "DIAGNOSTIC_ERROR", message: error.message })}\n`);
    process.exitCode = 1;
  }
}

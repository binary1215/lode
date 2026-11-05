#!/usr/bin/env node
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { ArcadeDbHttpTransport } from "./lib/graph-projection-adapter.mjs";
import { buildStorageSelection } from "./lib/onboarding-contract.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const javascriptBridge = path.join(root, "scripts", "lib", "arcadedb-http-bridge.mjs");
const serverFile = path.join(root, "scripts", "fixtures", "arcadedb-query-batch-server.mjs");
const nativeIndex = process.argv.indexOf("--native");
const nativeBridge = nativeIndex >= 0 ? path.resolve(process.argv[nativeIndex + 1] || "") : "";
const iterationsIndex = process.argv.indexOf("--iterations");
const iterations = iterationsIndex >= 0 ? Number(process.argv[iterationsIndex + 1]) : 30;
const requireActivationThreshold = process.argv.includes("--require-activation-threshold");
if (!nativeBridge || !fs.statSync(nativeBridge, { throwIfNoEntry: false })?.isFile()) {
  throw new Error("--native must identify a built head-agent-arcadedb-bridge executable.");
}
if (!Number.isInteger(iterations) || iterations < 5 || iterations > 200) throw new Error("--iterations must be from 5 through 200.");

const server = childProcess.fork(serverFile, [], { stdio: ["ignore", "ignore", "inherit", "ipc"], windowsHide: true });
const ready = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("benchmark server startup timed out")), 5000);
  server.once("message", (message) => {
    clearTimeout(timer);
    if (message?.kind !== "ready" || !Number.isInteger(message.port)) reject(new Error("benchmark server returned invalid readiness"));
    else resolve(message);
  });
  server.once("exit", (code) => reject(new Error(`benchmark server exited before readiness: ${code}`)));
});

const environment = {
  ...process.env,
  HEAD_BENCHMARK_ARCADEDB_USERNAME: "benchmark-reader",
  HEAD_BENCHMARK_ARCADEDB_PASSWORD: "benchmark-secret",
};
const previousFixtureEnvironment = {
  username: process.env.HEAD_BENCHMARK_ARCADEDB_USERNAME,
  password: process.env.HEAD_BENCHMARK_ARCADEDB_PASSWORD,
};
process.env.HEAD_BENCHMARK_ARCADEDB_USERNAME = environment.HEAD_BENCHMARK_ARCADEDB_USERNAME;
process.env.HEAD_BENCHMARK_ARCADEDB_PASSWORD = environment.HEAD_BENCHMARK_ARCADEDB_PASSWORD;
const input = JSON.stringify({
  protocol: { name: "head-agent-core-arcadedb-query-batch", version: "0.1.0" },
  endpoint: `http://127.0.0.1:${ready.port}`,
  database: "head-benchmark",
  secretReferenceNames: { username: "HEAD_BENCHMARK_ARCADEDB_USERNAME", password: "HEAD_BENCHMARK_ARCADEDB_PASSWORD" },
  operation: "query-batch",
  timeoutMs: 5000,
  queries: [
    { language: "sql", command: "SELECT topologyJson FROM HeadAgentGraphTopology", params: { projectId: "benchmark" } },
    { language: "sql", command: "SELECT nodeJson FROM HeadAgentGraphNode", params: { projectId: "benchmark" } },
  ],
});

function execute(command, args) {
  const started = performance.now();
  const result = childProcess.spawnSync(command, args, {
    input,
    encoding: "utf8",
    windowsHide: true,
    timeout: 7000,
    maxBuffer: 4 * 1024 * 1024,
    env: environment,
  });
  const elapsedMs = performance.now() - started;
  if (result.error || result.status !== 0) throw new Error(`bridge failed: ${result.error?.message || result.stderr || result.stdout}`);
  return { elapsedMs, response: JSON.parse(result.stdout) };
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

let cleanupState = "pending";
let activationEligible = false;
let installedAdapterSmoke = false;
try {
  for (let index = 0; index < 3; index += 1) {
    execute(process.execPath, [javascriptBridge]);
    execute(nativeBridge, []);
  }
  const javascript = [];
  const native = [];
  for (let index = 0; index < iterations; index += 1) {
    const candidateFirst = index % 2 === 1;
    const candidate = candidateFirst ? execute(nativeBridge, []) : null;
    const reference = execute(process.execPath, [javascriptBridge]);
    const completedCandidate = candidate || execute(nativeBridge, []);
    if (JSON.stringify(canonical(reference.response)) !== JSON.stringify(canonical(completedCandidate.response))) {
      throw new Error(`bridge semantic mismatch at iteration ${index}`);
    }
    javascript.push(reference.elapsedMs);
    native.push(completedCandidate.elapsedMs);
  }
  const javascriptMedian = percentile(javascript, 0.5);
  const nativeMedian = percentile(native, 0.5);
  const speedup = javascriptMedian / nativeMedian;
  activationEligible = nativeMedian <= javascriptMedian * 0.8;
  const storageSelection = buildStorageSelection({
    projectId: "head-benchmark",
    selection: {
      mode: "graphdb",
      endpoint: `http://127.0.0.1:${ready.port}`,
      database: "head-benchmark",
      secretReferenceNames: { username: "HEAD_BENCHMARK_ARCADEDB_USERNAME", password: "HEAD_BENCHMARK_ARCADEDB_PASSWORD" },
    },
  });
  const transport = new ArcadeDbHttpTransport({
    storageSelection,
    timeoutMs: 5000,
    nativeBatchBridge: {
      executablePath: nativeBridge,
      sha256: crypto.createHash("sha256").update(fs.readFileSync(nativeBridge)).digest("hex"),
    },
  });
  const adapterResponse = transport.invokeQueryBatch(JSON.parse(input).queries);
  if (adapterResponse.length !== 2 || transport.preparedReadBatchDiagnostics().backend !== "go-exact-child") {
    throw new Error("installed native adapter smoke did not select the verified Go exact child");
  }
  installedAdapterSmoke = true;
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    kind: "ArcadeDbQueryBatchBenchmark",
    protocolVersion: "0.1.0",
    iterations,
    server: { pid: ready.pid, port: ready.port, ownership: "benchmark-exact-child" },
    native: {
      executableSha256: crypto.createHash("sha256").update(fs.readFileSync(nativeBridge)).digest("hex"),
      medianMs: Number(nativeMedian.toFixed(3)),
      p95Ms: Number(percentile(native, 0.95).toFixed(3)),
    },
    javascript: {
      medianMs: Number(javascriptMedian.toFixed(3)),
      p95Ms: Number(percentile(javascript, 0.95).toFixed(3)),
    },
    medianSpeedup: Number(speedup.toFixed(3)),
    semanticParity: true,
    installedAdapterSmoke,
    defaultActivationThreshold: "native-median-at-most-80-percent-of-javascript-median",
    defaultActivationEligible: activationEligible,
    authorityEffect: "none",
  }, null, 2)}\n`);
} finally {
  const exited = new Promise((resolve) => server.once("exit", resolve));
  if (server.connected) server.send({ kind: "shutdown" });
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
  if (server.exitCode == null && server.signalCode == null) server.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
  cleanupState = server.exitCode != null || server.signalCode != null ? "completed" : "unconfirmed";
  if (previousFixtureEnvironment.username == null) delete process.env.HEAD_BENCHMARK_ARCADEDB_USERNAME;
  else process.env.HEAD_BENCHMARK_ARCADEDB_USERNAME = previousFixtureEnvironment.username;
  if (previousFixtureEnvironment.password == null) delete process.env.HEAD_BENCHMARK_ARCADEDB_PASSWORD;
  else process.env.HEAD_BENCHMARK_ARCADEDB_PASSWORD = previousFixtureEnvironment.password;
  if (cleanupState !== "completed") throw new Error(`benchmark server cleanup was not confirmed for PID ${server.pid}`);
}
if (requireActivationThreshold && !activationEligible) throw new Error("Go bridge did not satisfy the default activation threshold.");

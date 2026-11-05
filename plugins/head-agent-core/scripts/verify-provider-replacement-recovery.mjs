#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { initializeProject, inspectProject } from "./lib/head-core.mjs";
import { formatForVerifiedOwner } from "./lib/project-storage-format.mjs";
import { buildRuntimeVersionEvidence } from "./lib/runtime-machine-execution.mjs";
import {
  buildRuntimeProjectBinding,
  buildRuntimeProtocolEvidence,
} from "./lib/runtime-protocol-evidence.mjs";
import {
  buildRuntimeInvocationAuthorization,
  readRuntimeInvocationAuthorization,
} from "./lib/runtime-invocation-lifecycle.mjs";
import {
  RUNTIME_OPERATIONAL_STATE_ENV,
} from "./lib/runtime-execution-lease.mjs";
import { executeCodexRuntimeInvocation } from "./lib/runtime-codex-exec.mjs";
import { executeOpenCodeRuntimeInvocation } from "./lib/runtime-opencode-run.mjs";
import { readRuntimeInvocationResult } from "./lib/runtime-run-result-application.mjs";
import { resolveVerifiedProcessSupervisor } from "./lib/runtime-process-supervisor.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const pluginRoot = path.resolve(path.dirname(scriptPath), "..");
const fixtureNonce = `${process.pid}-${Date.now()}`;
const temporaryRoot = path.join(pluginRoot, `.test-tmp-provider-replacement-${fixtureNonce}`);
const temporaryOperationalRoot = path.join(pluginRoot, `.test-tmp-provider-replacement-operational-${fixtureNonce}`);

const CODEX_EXEC_PROTOCOL_FIXTURE = String.raw`
let input = Buffer.alloc(0);
process.stdin.on('data', (chunk) => { input = Buffer.concat([input, chunk]); });
process.stdin.on('end', () => {
  const result = {
    schemaVersion: 1,
    kind: 'RuntimeStructuredResult',
    protocolVersion: '0.1.0',
    outcome: 'Codex pre-loss fixture completed.',
    evidence: ['The first provider completed before replacement.'],
    planDelta: '',
    impactRadius: [],
    verification: ['The provider-neutral record was persisted.'],
    unknowns: [],
  };
  const write = (value) => process.stdout.write(JSON.stringify(value) + '\n');
  write({ type: 'thread.started', thread_id: 'provider-session-id-must-not-persist' });
  write({ type: 'turn.started' });
  write({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } });
  write({ type: 'turn.completed', usage: { input_tokens: input.length, output_tokens: 1 } });
});
`;

const OPENCODE_RUN_PROTOCOL_FIXTURE = String.raw`
let input = Buffer.alloc(0);
process.stdin.on('data', (chunk) => { input = Buffer.concat([input, chunk]); });
process.stdin.on('end', () => {
  const result = {
    outcome: 'OpenCode replacement fixture completed.',
    evidence: ['A fresh process recovered HEAD identity from project artifacts.'],
    verification: ['No provider-session identity was supplied to the replacement process.'],
    unknowns: [],
  };
  const sessionID = 'replacement-provider-session-id-must-not-persist';
  const write = (value) => process.stdout.write(JSON.stringify(value) + '\n');
  write({ type: 'step_start', timestamp: 1, sessionID, part: { type: 'step-start', sessionID } });
  write({ type: 'text', timestamp: 2, sessionID, part: { type: 'text', sessionID, text: JSON.stringify(result), time: { start: 1, end: 2 } } });
  write({ type: 'step_finish', timestamp: 3, sessionID, part: { type: 'step-finish', sessionID, tokens: { input: input.length, output: 1 } } });
});
`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function recordProcess(event) {
  if (event.type === "spawn") {
    process.stderr.write(`NESTED_CHILD_START pid=${event.pid} parent=${event.parentPid} command=${event.command} cwd=${event.cwd} ports=${event.ports}\n`);
  } else {
    process.stderr.write(`NESTED_CHILD_END pid=${event.pid} parent=${event.parentPid} exit=${event.exitCode ?? "null"} signal=${event.signal}\n`);
  }
}

function recordingSpawn(command, args, options) {
  const child = spawn(command, args, options);
  child.once("spawn", () => recordProcess({
    type: "spawn",
    pid: child.pid,
    parentPid: process.pid,
    command: [command, ...args].join(" "),
    cwd: options.cwd,
    ports: "none",
  }));
  child.once("exit", (exitCode, signal) => recordProcess({
    type: "exit",
    pid: child.pid,
    parentPid: process.pid,
    exitCode,
    signal: signal || "none",
  }));
  return child;
}

function evidenceFixtureOutput(command, args) {
  const runtime = path.basename(command).toLowerCase().includes("opencode") ? "opencode" : "codex";
  const key = args.join(" ");
  if (key === "--version") return `${runtime} 1.2.3\n`;
  if (runtime === "codex" && key === "--help") return "exec\nmcp-server\napp-server\n";
  if (runtime === "codex" && key === "exec --help") return "Run Codex non-interactively\n--json\n--output-schema\n--color\n--sandbox\n--skip-git-repo-check\n--cd\n--ephemeral\nresume\n";
  if (runtime === "codex" && key === "app-server --help") return "stdio://\ngenerate-json-schema\n--listen\n";
  if (runtime === "opencode" && key === "--help") return "opencode run\nopencode acp\nopencode serve\nopencode session\n";
  if (runtime === "opencode" && key === "run --help") return "Run OpenCode with a message\n--format choices: json\n--pure\n--dir\n--title\n--session\n--continue\n";
  if (runtime === "opencode" && key === "acp --help") return "Agent Client Protocol\n--cwd\n--port\n";
  return "unsupported fixture invocation\n";
}

function evidenceFixtureSpawn(command, args, options) {
  const output = evidenceFixtureOutput(command, args);
  return recordingSpawn(process.execPath, ["-e", "process.stdout.write(process.argv[1])", output], {
    ...options,
    cwd: pluginRoot,
  });
}

function createRuntimeFixtureBin(operationalRoot) {
  const fixtureBin = path.join(operationalRoot, "runtime-discovery-fixture");
  fs.mkdirSync(fixtureBin, { recursive: false });
  for (const runtime of ["codex", "opencode"]) {
    const executableName = process.platform === "win32" ? `${runtime}.exe` : runtime;
    const executablePath = path.join(fixtureBin, executableName);
    fs.writeFileSync(executablePath, `head-agent ${runtime} recovery fixture\n`, "utf8");
    if (process.platform !== "win32") fs.chmodSync(executablePath, 0o755);
  }
  return fixtureBin;
}

async function buildFreshRuntimeBoundary(root, fixtureBin) {
  const environment = {
    ...process.env,
    PATH: `${fixtureBin}${path.delimiter}${process.env.PATH || ""}`,
  };
  const versionEvidence = await buildRuntimeVersionEvidence({
    runtimes: ["codex", "opencode"],
    environment,
    spawnImplementation: evidenceFixtureSpawn,
  });
  const protocolEvidence = await buildRuntimeProtocolEvidence({
    runtimes: ["codex", "opencode"],
    versionEvidence,
    environment,
    spawnImplementation: evidenceFixtureSpawn,
  });
  const inspected = inspectProject(root);
  assert(inspected.status === "ready", "Replacement process could not recover a ready HEAD project.");
  return {
    inspected,
    protocolEvidence,
    projectBinding: buildRuntimeProjectBinding({
      storage: inspected.storage,
      projectId: inspected.project.projectId,
      headSessionId: inspected.state.sessionId,
      projectRoot: root,
      projectStatus: inspected.status,
      versionEvidence,
      protocolEvidence,
    }),
  };
}

function assertProviderSessionIdentityAbsent(value, label) {
  const serialized = JSON.stringify(value);
  assert(!serialized.includes("provider-session-id-must-not-persist"), `${label} persisted the Codex provider-session fixture identity.`);
  assert(!serialized.includes("replacement-provider-session-id-must-not-persist"), `${label} persisted the OpenCode provider-session fixture identity.`);
}

async function executeCodexBeforeLoss({ root, fixtureBin, supervisorSelection }) {
  const boundary = await buildFreshRuntimeBoundary(root, fixtureBin);
  const request = "Persist a bounded provider-neutral result before the Codex provider disappears.";
  const authorization = buildRuntimeInvocationAuthorization({
    root,
    runtime: "codex",
    scope: { kind: "session", request },
    workspaceMode: "read-only",
    protocolEvidence: boundary.protocolEvidence,
    projectBinding: boundary.projectBinding,
    limits: { timeoutMs: 5_000 },
    persist: true,
  }).authorization;
  const observation = boundary.protocolEvidence.observations.find((item) => item.runtime === "codex");
  const execution = await executeCodexRuntimeInvocation({
    root,
    authorization,
    sessionRequest: request,
    protocolEvidence: boundary.protocolEvidence,
    projectBinding: boundary.projectBinding,
    targetResolver: () => ({ executablePath: process.execPath, observation: observation.executable }),
    supervisorSelection,
    providerArguments: ["-e", CODEX_EXEC_PROTOCOL_FIXTURE],
    evidenceMode: "protocol-fixture",
    onProcessEvent: recordProcess,
  });
  const persisted = readRuntimeInvocationResult({ root, storage: boundary.inspected.storage, authorizationId: authorization.authorizationId });
  assert(persisted.draft.draftHash === execution.draft.draftHash, "Codex pre-loss result did not round-trip through project artifacts.");
  assertProviderSessionIdentityAbsent(persisted, "Codex pre-loss record");
  return { boundary, authorization, execution };
}

async function replacementChild(root, previousAuthorizationId, fixtureBin) {
  const storage = inspectProject(root).storage;
  const previous = readRuntimeInvocationResult({ root, storage, authorizationId: previousAuthorizationId });
  const previousAuthorization = readRuntimeInvocationAuthorization({ root, authorizationId: previousAuthorizationId }).authorization;
  assert(previousAuthorization.runtime === "codex", "Replacement input did not identify a completed Codex artifact.");
  assert(previous.receipt.status === "completed", "Replacement input Codex artifact was not completed.");
  assertProviderSessionIdentityAbsent(previous, "Recovered Codex record");

  const boundary = await buildFreshRuntimeBoundary(root, fixtureBin);
  const format = formatForVerifiedOwner(boundary.inspected.storage);
  assert(boundary.inspected.state.sessionId === previousAuthorization[format.sessionIdField],
    "Fresh replacement process did not recover the original canonical HEAD Session.");
  const request = "Continue from canonical HEAD artifacts using OpenCode after Codex provider loss.";
  const authorization = buildRuntimeInvocationAuthorization({
    root,
    runtime: "opencode",
    scope: { kind: "session", request },
    workspaceMode: "read-only",
    protocolEvidence: boundary.protocolEvidence,
    projectBinding: boundary.projectBinding,
    limits: { timeoutMs: 5_000 },
    persist: true,
  }).authorization;
  const observation = boundary.protocolEvidence.observations.find((item) => item.runtime === "opencode");
  const supervisorRoot = path.resolve(process.env.LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT || process.env.HEAD_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT || pluginRoot);
  const execution = await executeOpenCodeRuntimeInvocation({
    root,
    authorization,
    sessionRequest: request,
    protocolEvidence: boundary.protocolEvidence,
    projectBinding: boundary.projectBinding,
    targetResolver: () => ({ executablePath: process.execPath, observation: observation.executable }),
    supervisorSelection: resolveVerifiedProcessSupervisor({ pluginRoot: supervisorRoot }),
    providerArguments: ["-e", OPENCODE_RUN_PROTOCOL_FIXTURE],
    evidenceMode: "protocol-fixture",
    onProcessEvent: recordProcess,
  });
  const persisted = readRuntimeInvocationResult({ root, storage: boundary.inspected.storage, authorizationId: authorization.authorizationId });
  assert(persisted.draft.draftHash === execution.draft.draftHash, "OpenCode replacement result did not round-trip through project artifacts.");
  assertProviderSessionIdentityAbsent(persisted, "OpenCode replacement record");
  process.stdout.write(`${JSON.stringify({
    kind: "ProviderReplacementChildResult",
    projectId: boundary.inspected.project.projectId,
    [format.sessionIdField]: boundary.inspected.state.sessionId,
    previousAuthorizationId,
    replacementAuthorizationId: authorization.authorizationId,
    replacementDraftHash: execution.draft.draftHash,
    replacementRuntime: authorization.runtime,
  })}\n`);
}

function runReplacementProcess({ root, previousAuthorizationId, fixtureBin, operationalRoot, supervisorRoot }) {
  return new Promise((resolve, reject) => {
    const child = recordingSpawn(process.execPath, [
      scriptPath,
      "--replacement-child",
      root,
      previousAuthorizationId,
      fixtureBin,
    ], {
      cwd: pluginRoot,
      env: {
        ...process.env,
        [RUNTIME_OPERATIONAL_STATE_ENV]: operationalRoot,
        LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT: supervisorRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > 1024 * 1024) child.kill();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr, "utf8") > 1024 * 1024) child.kill();
    });
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      if (exitCode !== 0) {
        reject(new Error(`Replacement process failed with exit=${exitCode ?? "null"} signal=${signal || "none"} stderrBytes=${Buffer.byteLength(stderr, "utf8")}.`));
        return;
      }
      try {
        const result = stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
          .find((value) => value.kind === "ProviderReplacementChildResult");
        assert(result, "Replacement process did not emit its bounded result.");
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function parentMain() {
  const resolvedRoot = path.resolve(temporaryRoot);
  const resolvedOperationalRoot = path.resolve(temporaryOperationalRoot);
  assert(resolvedRoot.startsWith(`${pluginRoot}${path.sep}`) && path.basename(resolvedRoot).startsWith(".test-tmp-provider-replacement-"),
    "Provider replacement fixture root escaped the plugin workspace.");
  assert(resolvedOperationalRoot.startsWith(`${pluginRoot}${path.sep}`) && path.basename(resolvedOperationalRoot).startsWith(".test-tmp-provider-replacement-operational-"),
    "Provider replacement operational root escaped the plugin workspace.");
  const previousOperationalRoot = process.env[RUNTIME_OPERATIONAL_STATE_ENV];
  process.env[RUNTIME_OPERATIONAL_STATE_ENV] = resolvedOperationalRoot;
  fs.mkdirSync(resolvedRoot, { recursive: false });
  fs.mkdirSync(resolvedOperationalRoot, { recursive: false });
  try {
    fs.writeFileSync(path.join(resolvedRoot, "example.mjs"), "export const answer = 42;\n", "utf8");
    const initialized = initializeProject({ root: resolvedRoot, pluginRoot, runtimes: ["codex", "opencode"] });
    const format = formatForVerifiedOwner(initialized.storage);
    assert(initialized.status === "ready", "Provider replacement fixture project initialization failed.");
    assert(!fs.existsSync(path.join(resolvedRoot, ".git")), "Provider replacement fixture unexpectedly required Git.");
    const fixtureBin = createRuntimeFixtureBin(resolvedOperationalRoot);
    const supervisorRoot = path.resolve(process.env.LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT || process.env.HEAD_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT || pluginRoot);
    const codex = await executeCodexBeforeLoss({
      root: resolvedRoot,
      fixtureBin,
      supervisorSelection: resolveVerifiedProcessSupervisor({ pluginRoot: supervisorRoot }),
    });
    const replacement = await runReplacementProcess({
      root: resolvedRoot,
      previousAuthorizationId: codex.authorization.authorizationId,
      fixtureBin,
      operationalRoot: resolvedOperationalRoot,
      supervisorRoot,
    });
    assert(replacement.projectId === initialized.project.projectId, "Provider replacement changed canonical project identity.");
    assert(replacement[format.sessionIdField] === codex.authorization[format.sessionIdField], "Provider replacement changed canonical HEAD Session identity.");
    assert(replacement.replacementRuntime === "opencode", "Provider replacement did not select OpenCode.");
    assert(replacement.replacementAuthorizationId !== codex.authorization.authorizationId,
      "Provider replacement reused the consumed Codex authorization.");
    const recoveredReplacement = readRuntimeInvocationResult({
      root: resolvedRoot,
      storage: initialized.storage,
      authorizationId: replacement.replacementAuthorizationId,
    });
    assert(recoveredReplacement.draft.draftHash === replacement.replacementDraftHash,
      "Parent process could not recover the replacement result from project artifacts.");
    assertProviderSessionIdentityAbsent(recoveredReplacement, "Parent-recovered replacement record");
    process.stdout.write(`${JSON.stringify({
      status: "provider_replacement_recovery_verified",
      projectId: initialized.project.projectId,
      [format.sessionIdField]: codex.authorization[format.sessionIdField],
      firstRuntime: "codex",
      replacementRuntime: replacement.replacementRuntime,
      firstAuthorizationId: codex.authorization.authorizationId,
      replacementAuthorizationId: replacement.replacementAuthorizationId,
      freshProcessBoundary: true,
      providerSessionIdentityPersisted: false,
      gitRequired: false,
      graphDbRequired: false,
    }, null, 2)}\n`);
  } finally {
    if (previousOperationalRoot === undefined) delete process.env[RUNTIME_OPERATIONAL_STATE_ENV];
    else process.env[RUNTIME_OPERATIONAL_STATE_ENV] = previousOperationalRoot;
    for (const { target, prefix } of [
      { target: resolvedRoot, prefix: ".test-tmp-provider-replacement-" },
      { target: resolvedOperationalRoot, prefix: ".test-tmp-provider-replacement-operational-" },
    ]) {
      assert(target.startsWith(`${pluginRoot}${path.sep}`) && path.basename(target).startsWith(prefix),
        "Refusing to remove an unverified provider replacement temporary directory.");
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
}

if (process.argv[2] === "--replacement-child") {
  replacementChild(path.resolve(process.argv[3]), process.argv[4], path.resolve(process.argv[5])).catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
} else {
  parentMain().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

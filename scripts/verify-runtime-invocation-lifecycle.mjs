#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { readRuntimeOutputSpool } from "./lib/runtime-output-spool.mjs";
import { initializeProject, inspectProject } from "./lib/head-core.mjs";
import { compileContext } from "./lib/context-compiler.mjs";
import { createExecutionContract, createWholePlanSnapshot } from "./lib/execution-lineage.mjs";
import { startRun } from "./lib/run-lineage.mjs";
import { runCommand } from "./head.mjs";
import { dispatch } from "./mcp-server.mjs";
import { publicToolName } from "./lib/lode-artifact-composition.mjs";
import { formatForVerifiedOwner } from "./lib/project-storage-format.mjs";
import { buildRuntimeVersionEvidence } from "./lib/runtime-machine-execution.mjs";
import {
  buildRuntimeProjectBinding,
  buildRuntimeProtocolEvidence,
} from "./lib/runtime-protocol-evidence.mjs";
import {
  buildRuntimeInvocationAuthorization,
  buildRuntimeInvocationLifecycleReceipt,
  buildRuntimeResultPacketDraft,
  inspectRuntimeInvocationExecutionLease,
  readRuntimeInvocationAuthorization,
  runRuntimeLifecycleConformance,
  verifyRuntimeInvocationAuthorization,
  verifyRuntimeInvocationLifecycleReceipt,
  verifyRuntimeResultPacketDraft,
  verifyRuntimeStructuredResult,
} from "./lib/runtime-invocation-lifecycle.mjs";
import {
  RUNTIME_OPERATIONAL_STATE_ENV,
  resolveRuntimeOperationalStateRoot,
  verifyRuntimeExecutionLeaseConsumption,
  verifyRuntimeExecutionLeaseRelease,
} from "./lib/runtime-execution-lease.mjs";
import {
  CODEX_EXEC_RESULT_SCHEMA,
  classifyCodexProviderDiagnostics,
  executeCodexRuntimeInvocation,
  verifyCodexExecWireResultSchema,
} from "./lib/runtime-codex-exec.mjs";
import {
  buildOpenCodeProviderEnvironment,
  classifyOpenCodeProviderDiagnostics,
  executeOpenCodeRuntimeInvocation,
  extractOpenCodeStructuredResult,
} from "./lib/runtime-opencode-run.mjs";
import {
  buildClaudePrintArguments,
  classifyClaudeProviderDiagnostics,
  executeClaudeRuntimeInvocation,
  extractClaudeStructuredResult,
} from "./lib/runtime-claude-print.mjs";
import {
  applyRuntimeRunResult,
  normalizeRuntimeRunResultTextProjection,
  readRuntimeInvocationResult,
} from "./lib/runtime-run-result-application.mjs";
import { resolveVerifiedProcessSupervisor } from "./lib/runtime-process-supervisor.mjs";
import {
  applyBoundedWorkerDispatchResult,
  createBoundedWorkerDispatch,
  executeBoundedWorkerDispatch,
  waitForBoundedWorkerDispatch,
} from "./lib/bounded-worker-dispatch.mjs";
import {
  abandonBoundedWorkerWave,
  createBoundedWorkerWave,
  readBoundedWorkerWaveResults,
  readBoundedWorkerWaveStatus,
  sealBoundedWorkerWave,
  waitForBoundedWorkerWave,
} from "./lib/bounded-worker-wave.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureNonce = `${process.pid}-${Date.now()}`;
const temporaryRoot = path.join(pluginRoot, `.test-tmp-runtime-lifecycle-${fixtureNonce}`);
const temporaryOperationalRoot = path.join(pluginRoot, `.test-tmp-runtime-operational-${fixtureNonce}`);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function rejectsWithCode(operation, expectedCode) {
  try { await operation(); }
  catch (error) { return error.code === expectedCode; }
  return false;
}

function canonicalFixtureValue(value) {
  if (Array.isArray(value)) return value.map(canonicalFixtureValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalFixtureValue(value[key])]));
  }
  return value;
}

function legacyAuthorizationFixture(authorization) {
  const payload = { ...authorization, protocolVersion: "0.2.0" };
  delete payload.runtimeSelection;
  delete payload.authorizationId;
  delete payload.authorizationHash;
  const hash = crypto.createHash("sha256").update(JSON.stringify(canonicalFixtureValue(payload))).digest("hex");
  return {
    ...payload,
    authorizationId: `execution-authorization-${hash.slice(0, 24)}`,
    authorizationHash: hash,
  };
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
  const basename = path.basename(command).toLowerCase();
  const runtime = basename.includes("opencode") ? "opencode" : basename.includes("claude") ? "claude" : "codex";
  const key = args.join(" ");
  if (key === "--version") return `${runtime} 1.2.3\n`;
  if (runtime === "claude" && key === "--help") return "-p, --print\n--output-format stream-json\n--json-schema\n--no-session-persistence\n-r, --resume\n-c, --continue\n--permission-mode\n--tools\n--allowedTools\n--disable-slash-commands\n--setting-sources\n--strict-mcp-config\n--mcp-config\n";
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
  return recordingSpawn(process.execPath, ["-e", "process.stdout.write(process.argv[1])", "--", output], {
    ...options,
    cwd: pluginRoot,
  });
}

function codexInvocationDriftFixtureSpawn(command, args, options) {
  const output = evidenceFixtureOutput(command, args).replace("--sandbox\n", "");
  return recordingSpawn(process.execPath, ["-e", "process.stdout.write(process.argv[1])", "--", output], {
    ...options,
    cwd: pluginRoot,
  });
}

const CODEX_EXEC_PROTOCOL_FIXTURE = String.raw`
let input = Buffer.alloc(0);
process.stdin.on('data', (chunk) => { input = Buffer.concat([input, chunk]); });
process.stdin.on('end', () => {
  const result = {
    schemaVersion: 1,
    kind: 'RuntimeStructuredResult',
    protocolVersion: '0.1.0',
    outcome: 'Codex protocol fixture completed.',
    evidence: ['Authorized input reached the exact fixture child.'],
    planDelta: '',
    impactRadius: [],
    verification: ['Structured result schema accepted.'],
    unknowns: [],
  };
  const write = (value) => process.stdout.write(JSON.stringify(value) + '\n');
  write({ type: 'thread.started', thread_id: 'codex-protocol-fixture-thread' });
  write({ type: 'turn.started' });
  write({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } });
  write({ type: 'turn.completed', usage: { input_tokens: input.length, output_tokens: 1 } });
});
`;

const CODEX_LARGE_EVENT_PROTOCOL_FIXTURE = String.raw`
let input = Buffer.alloc(0);
process.stdin.on('data', (chunk) => { input = Buffer.concat([input, chunk]); });
process.stdin.on('end', () => {
  const result = {
    schemaVersion: 1,
    kind: 'RuntimeStructuredResult',
    protocolVersion: '0.1.0',
    outcome: 'Codex large-event protocol fixture completed.',
    evidence: ['Structured output preceded one bounded large tool event.'],
    planDelta: '',
    impactRadius: [],
    verification: ['The terminal lifecycle event was observed.'],
    unknowns: [],
  };
  const write = (value) => process.stdout.write(JSON.stringify(value) + '\n');
  write({ type: 'thread.started', thread_id: 'codex-large-event-fixture-thread' });
  write({ type: 'turn.started' });
  write({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } });
  write({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'x'.repeat(160 * 1024), exit_code: 0, status: 'completed' } });
  setTimeout(() => write({ type: 'turn.completed', usage: { input_tokens: input.length, output_tokens: 1 } }), 250);
});
`;

const OPENCODE_RUN_PROTOCOL_FIXTURE = String.raw`
let input = Buffer.alloc(0);
process.stdin.on('data', (chunk) => { input = Buffer.concat([input, chunk]); });
process.stdin.on('end', () => {
  const result = {
    outcome: 'OpenCode protocol fixture completed.',
    evidence: ['Authorized input reached the exact fixture child.'],
    verification: ['Provider-specific text output normalized into the common structured result.'],
    unknowns: [],
  };
  const sessionID = 'opencode-protocol-fixture-session';
  const write = (value) => process.stdout.write(JSON.stringify(value) + '\n');
  write({ type: 'step_start', timestamp: 1, sessionID, part: { type: 'step-start', sessionID } });
  write({ type: 'text', timestamp: 2, sessionID, part: { type: 'text', sessionID, text: JSON.stringify(result), time: { start: 1, end: 2 } } });
  write({ type: 'step_finish', timestamp: 3, sessionID, part: { type: 'step-finish', sessionID, tokens: { input: input.length, output: 1 } } });
});
`;

const CLAUDE_PRINT_PROTOCOL_FIXTURE = String.raw`
let input = Buffer.alloc(0);
process.stdin.on('data', (chunk) => { input = Buffer.concat([input, chunk]); });
process.stdin.on('end', () => {
  const result = {
    schemaVersion: 1,
    kind: 'RuntimeStructuredResult',
    protocolVersion: '0.1.0',
    outcome: 'Claude protocol fixture completed.',
    evidence: ['Authorized input reached the exact fixture child.'],
    planDelta: '',
    impactRadius: [],
    verification: ['Claude structured output normalized into the common result.'],
    unknowns: [],
  };
  const write = (value) => process.stdout.write(JSON.stringify(value) + '\n');
  write({ type: 'system', subtype: 'init', session_id: 'claude-protocol-fixture-session' });
  write({ type: 'assistant', message: { role: 'assistant', content: [] }, session_id: 'claude-protocol-fixture-session' });
  write({ type: 'result', subtype: 'success', is_error: false, structured_output: result, result: JSON.stringify(result), session_id: 'claude-protocol-fixture-session', input_bytes: input.length });
});
`;

const BOUNDED_WORKER_RUN_PROTOCOL_FIXTURE = String.raw`
let input = Buffer.alloc(0);
process.stdin.on('data', (chunk) => { input = Buffer.concat([input, chunk]); });
process.stdin.on('end', () => {
  const result = {
    schemaVersion: 1,
    kind: 'RuntimeStructuredResult',
    protocolVersion: '0.1.0',
    outcome: 'Bounded worker completed the exact authorized Run scope.',
    evidence: ['The exact Run input reached one native-supervised worker process.'],
    planDelta: 'The bounded worker result is ready for Fresh HEAD review.',
    impactRadius: ['runtime lifecycle fixture'],
    verification: ['Structured result and owned process cleanup were verified.'],
    unknowns: [],
  };
  const write = (value) => process.stdout.write(JSON.stringify(value) + '\n');
  write({ type: 'thread.started', thread_id: 'bounded-worker-protocol-fixture-thread' });
  write({ type: 'turn.started' });
  write({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } });
  write({ type: 'turn.completed', usage: { input_tokens: input.length, output_tokens: 1 } });
});
`;

const BOUNDED_WORKER_FAILURE_PROTOCOL_FIXTURE = String.raw`
let input = Buffer.alloc(0);
process.stdin.on('data', (chunk) => { input = Buffer.concat([input, chunk]); });
process.stdin.on('end', () => {
  const write = (value) => process.stdout.write(JSON.stringify(value) + '\n');
  write({ type: 'thread.started', thread_id: 'bounded-worker-failure-fixture-thread' });
  write({ type: 'turn.started' });
  write({ type: 'turn.failed', error: { message: 'synthetic bounded worker failure' } });
  process.exitCode = 7;
});
`;

async function main() {
  const configuredProviderEnvironment = buildOpenCodeProviderEnvironment({
    PATH: process.env.PATH || "",
    FIXTURE_CUSTOM_API_KEY: "fixture-key",
    FIXTURE_CUSTOM_BASE_URL: "https://provider.invalid/custom-root/",
    UNSELECTED_API_KEY: "must-not-be-forwarded",
  }, "read-only", "fixture-custom/model-v1");
  const configuredProviderOverlay = JSON.parse(configuredProviderEnvironment.OPENCODE_CONFIG_CONTENT);
  assert(configuredProviderEnvironment.FIXTURE_CUSTOM_API_KEY === "fixture-key"
    && configuredProviderEnvironment.FIXTURE_CUSTOM_BASE_URL === "https://provider.invalid/custom-root/"
    && configuredProviderEnvironment.UNSELECTED_API_KEY === undefined,
  "OpenCode provider environment did not remain scoped to the selected provider.");
  assert(configuredProviderOverlay.provider === undefined,
    "HEAD replaced the user's OpenCode provider configuration instead of preserving OpenCode authority.");
  const nativeProviderEnvironment = buildOpenCodeProviderEnvironment({
    PATH: process.env.PATH || "",
    FIXTURE_NATIVE_API_KEY: "fixture-key",
    FIXTURE_NATIVE_BASE_URL: "https://native.invalid/provider-root/",
    FIXTURE_CUSTOM_API_KEY: "must-not-be-forwarded",
  }, "read-only", "fixture-native/model-v2");
  const nativeProviderOverlay = JSON.parse(nativeProviderEnvironment.OPENCODE_CONFIG_CONTENT);
  assert(nativeProviderEnvironment.FIXTURE_NATIVE_API_KEY === "fixture-key"
    && nativeProviderEnvironment.FIXTURE_NATIVE_BASE_URL === "https://native.invalid/provider-root/"
    && nativeProviderEnvironment.FIXTURE_CUSTOM_API_KEY === undefined,
  "OpenCode native provider environment did not remain scoped to the selected provider.");
  assert(nativeProviderOverlay.provider === undefined,
    "HEAD injected a provider preset into the OpenCode configuration overlay.");
  const resolvedRoot = path.resolve(temporaryRoot);
  const resolvedOperationalRoot = path.resolve(temporaryOperationalRoot);
  assert(resolvedRoot.startsWith(`${pluginRoot}${path.sep}`) && path.basename(resolvedRoot).startsWith(".test-tmp-runtime-lifecycle-"), "Temporary lifecycle root escaped the plugin workspace.");
  assert(resolvedOperationalRoot.startsWith(`${pluginRoot}${path.sep}`) && path.basename(resolvedOperationalRoot).startsWith(".test-tmp-runtime-operational-"), "Temporary operational root escaped the plugin workspace.");
  const previousOperationalRoot = process.env[RUNTIME_OPERATIONAL_STATE_ENV];
  process.env[RUNTIME_OPERATIONAL_STATE_ENV] = resolvedOperationalRoot;
  fs.mkdirSync(resolvedRoot, { recursive: false });
  fs.mkdirSync(resolvedOperationalRoot, { recursive: false });
  try {
    const codexWireSchema = verifyCodexExecWireResultSchema(CODEX_EXEC_RESULT_SCHEMA);
    const codexWireSchemaText = JSON.stringify(codexWireSchema);
    assert(!codexWireSchemaText.includes("$schema") && !codexWireSchemaText.includes("minLength")
      && !codexWireSchemaText.includes("maxLength") && !codexWireSchemaText.includes("minItems")
      && !codexWireSchemaText.includes("maxItems"), "Codex wire schema retained provider-specific constraint keywords.");
    let semanticResultBoundsRejected = false;
    try {
      verifyRuntimeStructuredResult({
        schemaVersion: 1,
        kind: "RuntimeStructuredResult",
        protocolVersion: "0.1.0",
        outcome: "bounded",
        evidence: Array.from({ length: 65 }, (_, index) => `evidence-${index}`),
        planDelta: "",
        impactRadius: [],
        verification: [],
        unknowns: [],
      }, { scopeKind: "session" });
    } catch (error) {
      semanticResultBoundsRejected = error.code === "INVALID_RUNTIME_STRUCTURED_RESULT";
    }
    assert(semanticResultBoundsRejected, "Provider-neutral structured-result bounds were weakened with the wire schema.");
    const classifiedCodexDiagnostics = classifyCodexProviderDiagnostics({
      record: { type: "turn.failed", error: { message: "Invalid JSON schema near C:\\private\\fixture.txt" } },
      stderr: "stream disconnected before completion",
      exitCode: 1,
      structuredResultObserved: false,
      eventTypes: ["thread.started", "turn.failed"],
    });
    assert(JSON.stringify(classifiedCodexDiagnostics) === JSON.stringify([
      "codex.missing-structured-result",
      "codex.nonzero-exit",
      "codex.structured-output-rejected",
      "codex.transport",
      "codex.turn-failed",
    ]), "Codex provider diagnostics were not classified deterministically.");
    assert(!JSON.stringify(classifiedCodexDiagnostics).includes("private"), "Codex provider diagnostics retained raw error content.");
    const normalizedOpenCodeResult = extractOpenCodeStructuredResult({
      type: "text",
      part: {
        type: "text",
        text: JSON.stringify({
          outcome: "OpenCode output normalized.",
          evidence: ["bounded event"],
          verification: ["schema verified"],
          unknowns: [],
        }),
      },
    }, { scopeKind: "session" });
    assert(normalizedOpenCodeResult?.kind === "RuntimeStructuredResult"
      && normalizedOpenCodeResult.planDelta === ""
      && normalizedOpenCodeResult.impactRadius.length === 0,
    "OpenCode text event did not normalize into the provider-neutral Session result contract.");
    const classifiedOpenCodeDiagnostics = classifyOpenCodeProviderDiagnostics({
      record: { type: "error", error: { message: "Permission denied while connecting" } },
      stderr: "rate limit 429",
      exitCode: 1,
      structuredResultObserved: false,
      eventTypes: ["error"],
    });
    assert(JSON.stringify(classifiedOpenCodeDiagnostics) === JSON.stringify([
      "opencode.missing-structured-result",
      "opencode.nonzero-exit",
      "opencode.permission",
      "opencode.provider-error",
      "opencode.rate-limit",
      "opencode.transport",
    ]), "OpenCode provider diagnostics were not classified deterministically.");
    const normalizedClaudeResult = extractClaudeStructuredResult({
      type: "result",
      subtype: "success",
      is_error: false,
      structured_output: {
        schemaVersion: 1,
        kind: "RuntimeStructuredResult",
        protocolVersion: "0.1.0",
        outcome: "Claude output normalized.",
        evidence: ["bounded event"],
        planDelta: "",
        impactRadius: [],
        verification: ["schema verified"],
        unknowns: [],
      },
    }, { scopeKind: "session" });
    assert(normalizedClaudeResult?.kind === "RuntimeStructuredResult"
      && normalizedClaudeResult.planDelta === ""
      && normalizedClaudeResult.impactRadius.length === 0,
    "Claude result event did not normalize into the provider-neutral Session result contract.");
    const classifiedClaudeDiagnostics = classifyClaudeProviderDiagnostics({
      record: { type: "result", subtype: "error", is_error: true, result: "Permission denied while connecting" },
      stderr: "rate limit 429",
      exitCode: 1,
      structuredResultObserved: false,
      eventTypes: ["error"],
    });
    assert(JSON.stringify(classifiedClaudeDiagnostics) === JSON.stringify([
      "claude.missing-structured-result",
      "claude.nonzero-exit",
      "claude.permission",
      "claude.provider-error",
      "claude.rate-limit",
      "claude.transport",
    ]), "Claude provider diagnostics were not classified deterministically.");
    const normalizedRunText = normalizeRuntimeRunResultTextProjection({
      outcome: "  completed  ",
      planDelta: "  wrote one file  ",
      impactRadius: ["  run-output.txt  "],
      unknowns: ["  none beyond bounded verification  "],
    });
    assert(JSON.stringify(normalizedRunText) === JSON.stringify({
      outcome: "completed",
      planDelta: "wrote one file",
      impactRadius: ["run-output.txt"],
      unknowns: ["none beyond bounded verification"],
    }), "Runtime Run result text projection diverged from Execution Lineage normalization.");
    fs.writeFileSync(path.join(resolvedRoot, "example.mjs"), "export const answer = 42;\n", "utf8");
    const initialized = initializeProject({ root: resolvedRoot, pluginRoot, runtimes: ["claude", "codex", "opencode"] });
    assert(initialized.status === "ready", "Fixture project initialization failed.");
    const initializedProject = inspectProject(resolvedRoot);
    assert(initializedProject.status === "ready", "Fixture project did not remain ready after initialization.");
    assert(resolveRuntimeOperationalStateRoot({ projectRoot: resolvedRoot, storage: initializedProject.storage, create: false }) === fs.realpathSync(resolvedOperationalRoot), "Host-local operational root did not resolve exactly.");
    const runtimeFixtureBin = path.join(resolvedOperationalRoot, "runtime-discovery-fixture");
    fs.mkdirSync(runtimeFixtureBin, { recursive: false });
    for (const runtime of ["claude", "codex", "opencode"]) {
      const executableName = process.platform === "win32" ? `${runtime}.exe` : runtime;
      const executablePath = path.join(runtimeFixtureBin, executableName);
      fs.writeFileSync(executablePath, `head-agent ${runtime} discovery fixture\n`, "utf8");
      if (process.platform !== "win32") fs.chmodSync(executablePath, 0o755);
    }
    const evidenceEnvironment = { ...process.env, PATH: runtimeFixtureBin };
    delete evidenceEnvironment.Path;
    delete evidenceEnvironment.path;
    let projectLocalOperationalRootRejected = false;
    const unsafeProjectLocalOperationalRoot = path.join(resolvedRoot, initializedProject.storage.directory, "unsafe-operational-state");
    try {
      resolveRuntimeOperationalStateRoot({
        projectRoot: resolvedRoot,
        storage: initializedProject.storage,
        environment: { ...process.env, [RUNTIME_OPERATIONAL_STATE_ENV]: unsafeProjectLocalOperationalRoot },
        create: true,
      });
    } catch (error) {
      projectLocalOperationalRootRejected = error.code === "UNSAFE_RUNTIME_OPERATIONAL_STATE_ROOT";
    }
    assert(projectLocalOperationalRootRejected, "Project-local operational root was accepted.");
    assert(!fs.existsSync(unsafeProjectLocalOperationalRoot), "Rejected project-local operational root was created before validation.");
    const capsule = (await compileContext({
      root: resolvedRoot,
      task: "Prove bounded provider-neutral runtime lifecycle conformance without changing project files.",
      budget: 32_768,
      persist: true,
    })).capsule;
    const plan = createWholePlanSnapshot({
      root: resolvedRoot,
      objective: "Verify the runtime invocation lifecycle boundary.",
      plan: ["Bind the active Run", "Execute a no-descendant conformance fixture", "Return a ResultPacket draft"],
      invariants: ["Do not mutate Product Canon", "Do not persist raw provider output"],
      persist: true,
    }).artifact;
    const contract = createExecutionContract({
      root: resolvedRoot,
      wholePlanId: plan.wholePlanId,
      capsuleId: capsule.capsuleId,
      scope: "Execute the bounded runtime lifecycle conformance fixture only.",
      acceptanceCriteria: ["Exact child exit is observed", "Events are JSONL-bounded", "A transcript-free ResultPacket draft is produced"],
      constraints: ["No actual provider invocation", "No descendants", "No project mutation"],
      allowedActions: ["runtime.invoke", "project.read"],
      forbiddenActions: ["project.write", "network.write", "canon.mutate"],
      persist: true,
    }).artifact;
    const versionEvidence = await buildRuntimeVersionEvidence({
      runtimes: ["claude", "codex", "opencode"],
      environment: evidenceEnvironment,
      spawnImplementation: evidenceFixtureSpawn,
    });
    const protocolEvidence = await buildRuntimeProtocolEvidence({
      runtimes: ["claude", "codex", "opencode"],
      versionEvidence,
      environment: evidenceEnvironment,
      spawnImplementation: evidenceFixtureSpawn,
    });
    assert(protocolEvidence.summary.allRequestedProtocolsObserved, `Protocol evidence fixture was partial: ${JSON.stringify(protocolEvidence.observations.map((item) => ({ runtime: item.runtime, negotiated: item.protocolNegotiationObserved, probes: item.probeOutcomes.map((probe) => ({ name: probe.name, status: probe.status, exitCode: probe.exitCode, stdoutBytes: probe.stdoutBytes, stderrBytes: probe.stderrBytes })), capabilities: item.capabilities })))}.`);
    const projectBinding = buildRuntimeProjectBinding({
      storage: initializedProject.storage,
      projectId: initialized.project.projectId,
      headSessionId: initializedProject.state.sessionId,
      projectRoot: resolvedRoot,
      projectStatus: "ready",
      versionEvidence,
      protocolEvidence,
    });
    const driftedCodexVersionEvidence = await buildRuntimeVersionEvidence({
      runtimes: ["codex"],
      environment: evidenceEnvironment,
      spawnImplementation: evidenceFixtureSpawn,
    });
    const driftedCodexProtocolEvidence = await buildRuntimeProtocolEvidence({
      runtimes: ["codex"],
      versionEvidence: driftedCodexVersionEvidence,
      environment: evidenceEnvironment,
      spawnImplementation: codexInvocationDriftFixtureSpawn,
    });
    const driftedCodexObservation = driftedCodexProtocolEvidence.observations.find((item) => item.runtime === "codex");
    const driftedInvocationSurface = driftedCodexObservation.capabilities.find((item) => item.capability === "one-shot-invocation-surface");
    assert(driftedCodexObservation.protocolNegotiationObserved === true
      && driftedInvocationSurface?.support === "not-observed",
    "Codex invocation-surface drift fixture did not preserve generic protocol negotiation while removing one fixed option.");
    const driftedCodexProjectBinding = buildRuntimeProjectBinding({
      storage: initializedProject.storage,
      projectId: initialized.project.projectId,
      headSessionId: initializedProject.state.sessionId,
      projectRoot: resolvedRoot,
      projectStatus: "ready",
      versionEvidence: driftedCodexVersionEvidence,
      protocolEvidence: driftedCodexProtocolEvidence,
    });
    const driftedCodexRequest = "Reject an incomplete Codex invocation surface before consuming the execution lease.";
    const driftedCodexAuthorization = buildRuntimeInvocationAuthorization({
      root: resolvedRoot,
      runtime: "codex",
      scope: { kind: "session", request: driftedCodexRequest },
      workspaceMode: "read-only",
      protocolEvidence: driftedCodexProtocolEvidence,
      projectBinding: driftedCodexProjectBinding,
      limits: { timeoutMs: 5_000 },
      persist: true,
    }).authorization;
    let codexInvocationSurfaceRejectedBeforeConsumption = false;
    try {
      await executeCodexRuntimeInvocation({
        root: resolvedRoot,
        authorization: driftedCodexAuthorization,
        sessionRequest: driftedCodexRequest,
        protocolEvidence: driftedCodexProtocolEvidence,
        projectBinding: driftedCodexProjectBinding,
        targetResolver: () => ({ executablePath: process.execPath, observation: driftedCodexObservation.executable }),
        onProcessEvent: recordProcess,
        persist: true,
      });
    } catch (error) {
      codexInvocationSurfaceRejectedBeforeConsumption = error.code === "CODEX_EXEC_INVOCATION_SURFACE_NOT_VERIFIED";
    }
    const driftedCodexLease = inspectRuntimeInvocationExecutionLease({
      root: resolvedRoot,
      authorizationId: driftedCodexAuthorization.authorizationId,
    });
    assert(codexInvocationSurfaceRejectedBeforeConsumption
      && driftedCodexLease.lease.status === "available"
      && driftedCodexLease.lease.singleUseConsumed === false,
    "Codex invocation-surface drift was not rejected before execution-lease consumption.");
    const selectedModelRequest = "Bind one exact runtime model without persisting the raw request.";
    const selectedModelAuthorization = buildRuntimeInvocationAuthorization({
      root: resolvedRoot,
      runtime: "opencode",
      scope: { kind: "session", request: selectedModelRequest },
      workspaceMode: "read-only",
      runtimeSelection: { model: "fixture-provider/model-v1" },
      protocolEvidence,
      projectBinding,
      limits: { timeoutMs: 5_000 },
      persist: false,
    }).authorization;
    const alternateModelAuthorization = buildRuntimeInvocationAuthorization({
      root: resolvedRoot,
      runtime: "opencode",
      scope: { kind: "session", request: selectedModelRequest },
      workspaceMode: "read-only",
      runtimeSelection: { model: "fixture-provider/model-v2" },
      protocolEvidence,
      projectBinding,
      limits: { timeoutMs: 5_000 },
      persist: false,
    }).authorization;
    assert(verifyRuntimeInvocationAuthorization(selectedModelAuthorization).runtimeSelection.model === "fixture-provider/model-v1",
      "Runtime model selection did not round-trip through authorization verification.");
    assert(selectedModelAuthorization.authorizationId !== alternateModelAuthorization.authorizationId,
      "Runtime model drift did not change the immutable authorization identity.");
    const legacyAuthorization = legacyAuthorizationFixture(selectedModelAuthorization);
    assert(!("runtimeSelection" in verifyRuntimeInvocationAuthorization(legacyAuthorization)),
      "Legacy authorization without runtime selection did not verify compatibly.");
    let invalidRuntimeSelectionRejected = false;
    try {
      buildRuntimeInvocationAuthorization({
        root: resolvedRoot,
        runtime: "opencode",
        scope: { kind: "session", request: selectedModelRequest },
        workspaceMode: "read-only",
        runtimeSelection: { model: "gpt-5.4-mini" },
        protocolEvidence,
        projectBinding,
        persist: false,
      });
    } catch (error) {
      invalidRuntimeSelectionRejected = error.code === "INVALID_RUNTIME_SELECTION";
    }
    assert(invalidRuntimeSelectionRejected, "Unqualified runtime model selection was accepted.");
    const sessionResults = [];
    for (const runtime of ["claude", "codex", "opencode"]) {
      const request = `Inspect the fixture locally through the ${runtime} Session lane without changing Product Canon.`;
      const sessionAuthorization = buildRuntimeInvocationAuthorization({
        root: resolvedRoot,
        runtime,
        scope: {
          kind: "session",
          request,
          contextCapsuleId: runtime === "opencode" ? capsule.capsuleId : null,
        },
        workspaceMode: "read-only",
        protocolEvidence,
        projectBinding,
        limits: { timeoutMs: 5_000 },
        persist: true,
      }).authorization;
      assert(sessionAuthorization.kind === "ExecutionAuthorization", `${runtime} Session authorization kind is invalid.`);
      assert(sessionAuthorization.scope.kind === "session", `${runtime} Session scope was not recorded.`);
      assert(sessionAuthorization.scope.runId === null && sessionAuthorization.scope.executionContractId === null, `${runtime} Session authorization acquired Run authority.`);
      let requestDriftRejected = false;
      try {
        await runRuntimeLifecycleConformance({
          root: resolvedRoot,
          authorization: sessionAuthorization,
          sessionRequest: `${request} changed`,
          mode: "success",
          onProcessEvent: recordProcess,
        });
      } catch (error) {
        requestDriftRejected = error.code === "RUNTIME_INVOCATION_INPUT_DRIFT";
      }
      assert(requestDriftRejected, `${runtime} Session request drift was accepted.`);
      const sessionSuccess = await runRuntimeLifecycleConformance({
        root: resolvedRoot,
        authorization: sessionAuthorization,
        sessionRequest: request,
        mode: "success",
        onProcessEvent: recordProcess,
      });
      const sessionDraft = buildRuntimeResultPacketDraft({
        authorization: sessionAuthorization,
        receipt: sessionSuccess.receipt,
        leaseRelease: sessionSuccess.executionLease.release,
      });
      verifyRuntimeResultPacketDraft(sessionDraft);
      assert(sessionSuccess.receipt.scopeKind === "session", `${runtime} Session receipt lost its scope.`);
      assert(sessionDraft.scopeKind === "session" && sessionDraft.freshHeadReviewRequired === false, `${runtime} Session result incorrectly requires Fresh HEAD review.`);
      const sessionPublicArtifacts = JSON.stringify({ authorization: sessionAuthorization, receipt: sessionSuccess.receipt, executionLease: sessionSuccess.executionLease, draft: sessionDraft });
      assert(!sessionPublicArtifacts.includes(request), `${runtime} Session authorization persisted the raw request.`);
      sessionResults.push({
        runtime,
        authorizationId: sessionAuthorization.authorizationId,
        receiptId: sessionSuccess.receipt.receiptId,
        draftId: sessionDraft.draftId,
        requestDriftRejected,
      });
    }
    const codexProtocolRequest = "Return one bounded structured Session result through the Codex exec JSONL protocol fixture.";
    const codexProtocolAuthorization = buildRuntimeInvocationAuthorization({
      root: resolvedRoot,
      runtime: "codex",
      scope: { kind: "session", request: codexProtocolRequest },
      workspaceMode: "read-only",
      protocolEvidence,
      projectBinding,
      limits: { timeoutMs: 5_000 },
      persist: true,
    }).authorization;
    const codexObservation = protocolEvidence.observations.find((item) => item.runtime === "codex");
    const supervisorFixtureRoot = path.resolve(process.env.LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT || process.env.HEAD_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT || pluginRoot);
    const supervisorSelection = resolveVerifiedProcessSupervisor({ pluginRoot: supervisorFixtureRoot });
    const codexProtocolExecution = await executeCodexRuntimeInvocation({
      root: resolvedRoot,
      authorization: codexProtocolAuthorization,
      sessionRequest: codexProtocolRequest,
      protocolEvidence,
      projectBinding,
      targetResolver: () => ({ executablePath: process.execPath, observation: codexObservation.executable }),
      supervisorSelection,
      providerArguments: ["-e", CODEX_EXEC_PROTOCOL_FIXTURE],
      evidenceMode: "protocol-fixture",
      onProcessEvent: recordProcess,
      persist: true,
    });
    assert(codexProtocolExecution.receipt.status === "completed", "Codex exec protocol fixture did not complete.");
    assert(codexProtocolExecution.actualProviderInvoked === false, "Codex protocol fixture was represented as an actual provider invocation.");
    assert(codexProtocolExecution.receipt.providerBoundary.structuredResultObserved === true, "Codex structured result was not observed.");
    assert(codexProtocolExecution.receipt.processBoundary.supervisionMode === "native-process-tree"
      && codexProtocolExecution.receipt.processBoundary.descendantTreeOwnershipValidated === true,
    "Codex protocol fixture did not pass native descendant-tree supervision.");
    assert(codexProtocolExecution.draft.providerResult?.outcome === "Codex protocol fixture completed.", "Codex structured result was not carried into the draft.");
    assert(codexProtocolExecution.draft.freshHeadReviewRequired === false, "Codex Session protocol fixture incorrectly required Fresh HEAD review.");
    const recordedCodexProtocolExecution = readRuntimeInvocationResult({
      root: resolvedRoot,
      storage: initializedProject.storage,
      authorizationId: codexProtocolAuthorization.authorizationId,
    });
    assert(recordedCodexProtocolExecution.application === null, "Session protocol fixture acquired a Run result application.");
    let sessionApplicationRejected = false;
    try {
      applyRuntimeRunResult({ root: resolvedRoot, storage: initializedProject.storage, authorizationId: codexProtocolAuthorization.authorizationId });
    } catch (error) {
      sessionApplicationRejected = error.code === "RUNTIME_RUN_AUTHORIZATION_REQUIRED";
    }
    assert(sessionApplicationRejected, "Session protocol fixture entered canonical Run result application.");
    assert(recordedCodexProtocolExecution.draft.draftHash === codexProtocolExecution.draft.draftHash, "Codex invocation record did not round-trip.");
    assert(!JSON.stringify(recordedCodexProtocolExecution).includes(codexProtocolRequest), "Codex invocation record persisted the raw Session request.");
    const cliCodexProtocolResult = await runCommand([
      "runtime-invocation-result", resolvedRoot, "--authorization", codexProtocolAuthorization.authorizationId,
    ]);
    assert(cliCodexProtocolResult.draft.draftHash === codexProtocolExecution.draft.draftHash, "Codex invocation CLI read failed.");
    const mcpCodexProtocolResult = await dispatch({
      jsonrpc: "2.0",
      id: "codex-protocol-result",
      method: "tools/call",
      params: {
        name: publicToolName("head_runtime_invocation_result"),
        arguments: { project_root: resolvedRoot, authorization_id: codexProtocolAuthorization.authorizationId },
      },
    });
    assert(mcpCodexProtocolResult.result?.structuredContent?.draft?.draftHash === codexProtocolExecution.draft.draftHash, "Codex invocation MCP read failed.");
    const opencodeProtocolRequest = "Return one bounded structured Session result through the OpenCode run JSONL protocol fixture.";
    const opencodeProtocolAuthorization = buildRuntimeInvocationAuthorization({
      root: resolvedRoot,
      runtime: "opencode",
      scope: { kind: "session", request: opencodeProtocolRequest },
      workspaceMode: "read-only",
      protocolEvidence,
      projectBinding,
      limits: { timeoutMs: 5_000 },
      persist: true,
    }).authorization;
    const opencodeObservation = protocolEvidence.observations.find((item) => item.runtime === "opencode");
    const opencodeProtocolExecution = await executeOpenCodeRuntimeInvocation({
      root: resolvedRoot,
      authorization: opencodeProtocolAuthorization,
      sessionRequest: opencodeProtocolRequest,
      protocolEvidence,
      projectBinding,
      targetResolver: () => ({ executablePath: process.execPath, observation: opencodeObservation.executable }),
      supervisorSelection,
      providerArguments: ["-e", OPENCODE_RUN_PROTOCOL_FIXTURE],
      evidenceMode: "protocol-fixture",
      onProcessEvent: recordProcess,
      persist: true,
    });
    assert(opencodeProtocolExecution.receipt.status === "completed", "OpenCode run protocol fixture did not complete.");
    assert(opencodeProtocolExecution.actualProviderInvoked === false, "OpenCode protocol fixture was represented as an actual provider invocation.");
    assert(opencodeProtocolExecution.receipt.providerBoundary.structuredResultObserved === true,
      "OpenCode structured result was not observed.");
    assert(opencodeProtocolExecution.receipt.processBoundary.supervisionMode === "native-process-tree"
      && opencodeProtocolExecution.receipt.processBoundary.descendantTreeOwnershipValidated === true,
    "OpenCode protocol fixture did not pass native descendant-tree supervision.");
    assert(opencodeProtocolExecution.draft.providerResult?.outcome === "OpenCode protocol fixture completed.",
      "OpenCode structured result was not carried into the draft.");
    assert(opencodeProtocolExecution.draft.freshHeadReviewRequired === false,
      "OpenCode Session protocol fixture incorrectly required Fresh HEAD review.");
    const recordedOpenCodeProtocolExecution = readRuntimeInvocationResult({
      root: resolvedRoot,
      storage: initializedProject.storage,
      authorizationId: opencodeProtocolAuthorization.authorizationId,
    });
    assert(recordedOpenCodeProtocolExecution.application === null,
      "OpenCode Session protocol fixture acquired a Run result application.");
    assert(recordedOpenCodeProtocolExecution.draft.draftHash === opencodeProtocolExecution.draft.draftHash,
      "OpenCode invocation record did not round-trip.");
    assert(!JSON.stringify(recordedOpenCodeProtocolExecution).includes(opencodeProtocolRequest),
      "OpenCode invocation record persisted the raw Session request.");
    const claudeProtocolRequest = "Return one bounded structured Session result through the Claude print stream-json protocol fixture.";
    const claudeProtocolAuthorization = buildRuntimeInvocationAuthorization({
      root: resolvedRoot,
      runtime: "claude",
      scope: { kind: "session", request: claudeProtocolRequest },
      workspaceMode: "read-only",
      protocolEvidence,
      projectBinding,
      limits: { timeoutMs: 5_000 },
      persist: true,
    }).authorization;
    const claudeObservation = protocolEvidence.observations.find((item) => item.runtime === "claude");
    const claudeArguments = buildClaudePrintArguments({ workspaceMode: "workspace-write", model: "anthropic/claude-test" });
    assert(claudeArguments.includes("--no-session-persistence")
      && claudeArguments.includes("--strict-mcp-config")
      && claudeArguments.includes("Read,Glob,Grep,Edit,Write")
      && !claudeArguments.includes("--dangerously-skip-permissions"),
    "Claude fixed one-shot arguments weakened the authorization or persistence boundary.");
    const claudeProtocolExecution = await executeClaudeRuntimeInvocation({
      root: resolvedRoot,
      authorization: claudeProtocolAuthorization,
      sessionRequest: claudeProtocolRequest,
      protocolEvidence,
      projectBinding,
      targetResolver: () => ({ executablePath: process.execPath, observation: claudeObservation.executable }),
      supervisorSelection,
      providerArguments: ["-e", CLAUDE_PRINT_PROTOCOL_FIXTURE],
      evidenceMode: "protocol-fixture",
      onProcessEvent: recordProcess,
      persist: true,
    });
    assert(claudeProtocolExecution.receipt.status === "completed"
      && claudeProtocolExecution.actualProviderInvoked === false
      && claudeProtocolExecution.receipt.providerBoundary.structuredResultObserved === true
      && claudeProtocolExecution.receipt.processBoundary.descendantTreeOwnershipValidated === true,
    "Claude print protocol fixture did not complete through native descendant-tree supervision.");
    assert(claudeProtocolExecution.draft.providerResult?.outcome === "Claude protocol fixture completed."
      && claudeProtocolExecution.draft.freshHeadReviewRequired === false,
    "Claude structured Session result did not preserve the common result boundary.");
    const recordedClaudeProtocolExecution = readRuntimeInvocationResult({
      root: resolvedRoot,
      storage: initializedProject.storage,
      authorizationId: claudeProtocolAuthorization.authorizationId,
    });
    assert(recordedClaudeProtocolExecution.application === null
      && recordedClaudeProtocolExecution.draft.draftHash === claudeProtocolExecution.draft.draftHash
      && !JSON.stringify(recordedClaudeProtocolExecution).includes(claudeProtocolRequest),
    "Claude invocation record did not round-trip without raw request persistence.");
    const legacyEventRequest = "Reproduce the historical Codex large-event boundary with the former explicit 128 KiB limit.";
    const legacyEventAuthorization = buildRuntimeInvocationAuthorization({
      root: resolvedRoot,
      runtime: "codex",
      scope: { kind: "session", request: legacyEventRequest },
      workspaceMode: "read-only",
      protocolEvidence,
      projectBinding,
      limits: { timeoutMs: 5_000, maxEventBytes: 128 * 1024 },
      persist: true,
    }).authorization;
    const legacyEventExecution = await executeCodexRuntimeInvocation({
      root: resolvedRoot,
      authorization: legacyEventAuthorization,
      sessionRequest: legacyEventRequest,
      protocolEvidence,
      projectBinding,
      targetResolver: () => ({ executablePath: process.execPath, observation: codexObservation.executable }),
      supervisorSelection,
      providerArguments: ["-e", CODEX_LARGE_EVENT_PROTOCOL_FIXTURE],
      evidenceMode: "protocol-fixture",
      onProcessEvent: recordProcess,
      persist: true,
    });
    assert(legacyEventExecution.receipt.status === "invalid-event"
      && legacyEventExecution.receipt.providerBoundary.structuredResultObserved === true
      && legacyEventExecution.receipt.providerBoundary.diagnosticCodes.includes("codex.event-byte-limit")
      && legacyEventExecution.draft.unknowns.includes("Provider diagnostic: codex.event-byte-limit")
      && !legacyEventExecution.receipt.eventTypes.includes("turn.completed"),
    "Former 128 KiB event boundary did not reproduce the live Run failure shape.");
    const recordedLegacyEventExecution = readRuntimeInvocationResult({
      root: resolvedRoot,
      storage: initializedProject.storage,
      authorizationId: legacyEventAuthorization.authorizationId,
    });
    assert(!JSON.stringify(recordedLegacyEventExecution).includes("aggregated_output"),
      "Rejected large event payload was persisted in the invocation record.");
    const defaultEventRequest = "Accept one bounded Codex large event under the current default and observe terminal completion.";
    const defaultEventAuthorization = buildRuntimeInvocationAuthorization({
      root: resolvedRoot,
      runtime: "codex",
      scope: { kind: "session", request: defaultEventRequest },
      workspaceMode: "read-only",
      protocolEvidence,
      projectBinding,
      limits: { timeoutMs: 5_000 },
      persist: true,
    }).authorization;
    assert(defaultEventAuthorization.limits.maxEventBytes === 2 * 1024 * 1024,
      "Current default did not reserve the bounded 2 MiB Codex event envelope.");
    assert(defaultEventAuthorization.limits.maxStdoutBytes === 8 * 1024 * 1024,
      "Current default did not retain the bounded 8 MiB total stdout envelope.");
    const defaultEventExecution = await executeCodexRuntimeInvocation({
      root: resolvedRoot,
      authorization: defaultEventAuthorization,
      sessionRequest: defaultEventRequest,
      protocolEvidence,
      projectBinding,
      targetResolver: () => ({ executablePath: process.execPath, observation: codexObservation.executable }),
      supervisorSelection,
      providerArguments: ["-e", CODEX_LARGE_EVENT_PROTOCOL_FIXTURE],
      evidenceMode: "protocol-fixture",
      onProcessEvent: recordProcess,
      persist: true,
    });
    assert(defaultEventExecution.receipt.status === "completed"
      && defaultEventExecution.receipt.providerBoundary.structuredResultObserved === true
      && defaultEventExecution.receipt.eventTypes.includes("turn.completed")
      && defaultEventExecution.receipt.providerBoundary.diagnosticCodes.length === 0,
    "Current bounded large-event default did not preserve structured result and terminal completion.");
    const recordedDefaultEventExecution = readRuntimeInvocationResult({
      root: resolvedRoot,
      storage: initializedProject.storage,
      authorizationId: defaultEventAuthorization.authorizationId,
    });
    assert(!JSON.stringify(recordedDefaultEventExecution).includes("aggregated_output"),
      "Accepted large event payload was persisted in the invocation record.");
    const sessionWritePreview = buildRuntimeInvocationAuthorization({
      root: resolvedRoot,
      runtime: "codex",
      scope: { kind: "session", request: "Apply one local reversible fixture edit without changing Product Canon." },
      workspaceMode: "workspace-write",
      protocolEvidence,
      projectBinding,
      persist: false,
    }).authorization;
    assert(sessionWritePreview.scope.kind === "session"
      && sessionWritePreview.requiredAllowedActions.includes("project.write")
      && sessionWritePreview.authorizationBoundary.freshHeadReviewRequired === false,
    "Low-risk Session workspace-write was not authorized through the lightweight lane.");
    const run = startRun({ root: resolvedRoot, executionContractId: contract.executionContractId }).run;
    const results = [];
    for (const runtime of ["claude", "codex", "opencode"]) {
      const authorization = buildRuntimeInvocationAuthorization({
        root: resolvedRoot,
        runtime,
        scope: { kind: "run" },
        workspaceMode: "read-only",
        protocolEvidence,
        projectBinding,
        limits: { timeoutMs: 5_000 },
        persist: true,
      }).authorization;
      verifyRuntimeInvocationAuthorization(authorization);
      const read = readRuntimeInvocationAuthorization({ root: resolvedRoot, authorizationId: authorization.authorizationId });
      assert(read.authorization.authorizationHash === authorization.authorizationHash, `${runtime} authorization did not round-trip.`);
      assert(authorization.scope.kind === "run", `${runtime} Run authorization scope is invalid.`);
      const cliRead = await runCommand(["runtime-invocation-read", resolvedRoot, "--authorization", authorization.authorizationId]);
      assert(cliRead.authorization.authorizationHash === authorization.authorizationHash, `${runtime} CLI authorization read failed.`);
      const mcpRead = await dispatch({
        jsonrpc: "2.0",
        id: runtime,
        method: "tools/call",
        params: { name: publicToolName("head_runtime_invocation_authorization"), arguments: { project_root: resolvedRoot, authorization_id: authorization.authorizationId } },
      });
      assert(mcpRead.result?.structuredContent?.authorization?.authorizationHash === authorization.authorizationHash, `${runtime} MCP authorization read failed.`);
      const success = await runRuntimeLifecycleConformance({
        root: resolvedRoot,
        authorization,
        mode: "success",
        onProcessEvent: recordProcess,
      });
      verifyRuntimeInvocationLifecycleReceipt(success.receipt);
      assert(success.receipt.status === "completed", `${runtime} success lifecycle did not complete.`);
      assert(success.receipt.processBoundary.descendantTreeOwnershipValidated === true, `${runtime} fixture ownership was not validated.`);
      assert(success.receipt.inputDigestObserved === authorization.executionInput.digest, `${runtime} input digest was not observed.`);
      if (runtime === "opencode") {
        const opencodeProtocolFixtureReceipt = buildRuntimeInvocationLifecycleReceipt({
          authorization,
          events: success.events,
          status: success.receipt.status,
          exitCode: success.receipt.exitCode,
          signal: success.receipt.signal,
          stdoutBytes: success.receipt.stdoutBytes,
          stderrBytes: success.receipt.stderrBytes,
          stdoutDigest: success.receipt.stdoutDigest,
          stderrDigest: success.receipt.stderrDigest,
          callerFenceDigest: success.receipt.processBoundary.callerFenceDigest,
          childFenceDigest: success.receipt.processBoundary.childFenceDigest,
          childStarted: success.receipt.processBoundary.exactChildStarted,
          childExitObserved: success.receipt.processBoundary.exactChildExitObserved,
          terminationRequested: success.receipt.processBoundary.terminationRequested,
          projectFenceValidated: success.receipt.processBoundary.projectFenceValidated,
          inputDigestObserved: success.receipt.inputDigestObserved,
          noDescendantFixture: true,
          descendantTreeOwnershipValidated: success.receipt.processBoundary.descendantTreeOwnershipValidated,
          consumption: success.executionLease.consumption,
          providerMode: "opencode-protocol-fixture",
        });
        assert(opencodeProtocolFixtureReceipt.runtime === "opencode"
          && opencodeProtocolFixtureReceipt.providerBoundary.mode === "opencode-protocol-fixture"
          && opencodeProtocolFixtureReceipt.providerBoundary.actualProviderInvoked === false,
        "OpenCode protocol fixture mode did not remain provider-neutral fixture evidence.");
      }
      verifyRuntimeExecutionLeaseConsumption(success.executionLease.consumption);
      verifyRuntimeExecutionLeaseRelease(success.executionLease.release);
      const tamperedConsumption = { ...success.executionLease.consumption, consumedAt: new Date(0).toISOString() };
      let consumptionTamperRejected = false;
      try { verifyRuntimeExecutionLeaseConsumption(tamperedConsumption); }
      catch { consumptionTamperRejected = true; }
      assert(consumptionTamperRejected, `${runtime} execution lease consumption tamper was accepted.`);
      assert(success.executionLease.release.operationStatus === "completed", `${runtime} execution lease release did not record completion.`);
      const leaseStatus = inspectRuntimeInvocationExecutionLease({ root: resolvedRoot, authorizationId: authorization.authorizationId });
      assert(leaseStatus.lease.status === "consumed-released", `${runtime} execution lease did not remain durably consumed.`);
      assert(leaseStatus.lease.replayAllowed === false, `${runtime} execution authorization remained replayable.`);
      const cliLeaseStatus = await runCommand(["runtime-invocation-lease-status", resolvedRoot, "--authorization", authorization.authorizationId]);
      assert(cliLeaseStatus.lease.release.releaseId === success.executionLease.release.releaseId, `${runtime} CLI lease inspection failed.`);
      const mcpLeaseStatus = await dispatch({
        jsonrpc: "2.0",
        id: `${runtime}-lease`,
        method: "tools/call",
        params: { name: publicToolName("head_runtime_invocation_lease_status"), arguments: { project_root: resolvedRoot, authorization_id: authorization.authorizationId } },
      });
      assert(mcpLeaseStatus.result?.structuredContent?.lease?.release?.releaseId === success.executionLease.release.releaseId, `${runtime} MCP lease inspection failed.`);
      let replayRejected = false;
      try {
        await runRuntimeLifecycleConformance({ root: resolvedRoot, authorization, mode: "success", onProcessEvent: recordProcess });
      } catch (error) {
        replayRejected = error.code === "RUNTIME_INVOCATION_AUTHORIZATION_ALREADY_CONSUMED";
      }
      assert(replayRejected, `${runtime} consumed authorization was replayed.`);
      const draft = buildRuntimeResultPacketDraft({
        authorization,
        receipt: success.receipt,
        leaseRelease: success.executionLease.release,
      });
      verifyRuntimeResultPacketDraft(draft);
      assert(draft.rawTranscriptIncluded === false && draft.finalResultPacketPersisted === false, `${runtime} draft crossed the result boundary.`);
      const publicArtifacts = JSON.stringify({ authorization, events: success.events, receipt: success.receipt, executionLease: success.executionLease, draft });
      assert(!publicArtifacts.includes(resolvedRoot), `${runtime} artifacts exposed the project root.`);
      assert(!publicArtifacts.includes("fixture-session"), `${runtime} artifacts exposed the provider-session reference.`);
      assert(!publicArtifacts.includes("answer = 42"), `${runtime} artifacts exposed project content.`);
      assert(!publicArtifacts.includes('"pid":'), `${runtime} artifacts exposed a PID.`);
      results.push({
        runtime,
        authorizationId: authorization.authorizationId,
        receiptId: success.receipt.receiptId,
        consumptionId: success.executionLease.consumption.consumptionId,
        releaseId: success.executionLease.release.releaseId,
        draftId: draft.draftId,
        eventCount: success.receipt.eventCount,
        replayRejected,
      });
    }
    const codexAuthorization = readRuntimeInvocationAuthorization({ root: resolvedRoot, authorizationId: results[0].authorizationId }).authorization;
    const timeoutAuthorization = {
      ...codexAuthorization,
      limits: { ...codexAuthorization.limits, timeoutMs: 1_000 },
    };
    delete timeoutAuthorization.authorizationId;
    delete timeoutAuthorization.authorizationHash;
    let timeoutRejected = false;
    try { verifyRuntimeInvocationAuthorization(timeoutAuthorization); }
    catch { timeoutRejected = true; }
    assert(timeoutRejected, "Tampered authorization was accepted.");
    const timeoutPlan = buildRuntimeInvocationAuthorization({
      root: resolvedRoot,
      runtime: "codex",
      scope: { kind: "run" },
      workspaceMode: "read-only",
      protocolEvidence,
      projectBinding,
      limits: { timeoutMs: 1_000 },
      persist: true,
    }).authorization;
    const timedOut = await runRuntimeLifecycleConformance({
      root: resolvedRoot,
      authorization: timeoutPlan,
      mode: "wait",
      onProcessEvent: recordProcess,
    });
    assert(timedOut.receipt.status === "timed-out", "Timeout lifecycle did not fail closed.");
    assert(timedOut.receipt.processBoundary.exactChildExitObserved === true, "Timed-out child exit was not observed.");
    assert(timedOut.executionLease.release.operationStatus === "timed-out", "Timed-out lease release was not recorded.");
    const cancellationPlan = buildRuntimeInvocationAuthorization({
      root: resolvedRoot,
      runtime: "codex",
      scope: { kind: "run" },
      workspaceMode: "read-only",
      protocolEvidence,
      projectBinding,
      limits: { timeoutMs: 5_000, maxEvents: 4_095 },
      persist: true,
    }).authorization;
    const cancellation = new AbortController();
    const cancellationRun = runRuntimeLifecycleConformance({
      root: resolvedRoot,
      authorization: cancellationPlan,
      mode: "wait",
      signal: cancellation.signal,
      onProcessEvent: recordProcess,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const activeLease = inspectRuntimeInvocationExecutionLease({ root: resolvedRoot, authorizationId: cancellationPlan.authorizationId });
    assert(activeLease.lease.status === "consumed-active", "In-flight execution lease was not visible as consumed and active.");
    assert(activeLease.lease.operationalState.location === "host-local-outside-project"
      && activeLease.lease.operationalState.pathExposed === false
      && activeLease.lease.operationalState.ownerLockPersistedInProject === false,
    "Execution lease inspection did not preserve the external operational-state boundary.");
    const projectOwnerLock = path.join(resolvedRoot, initializedProject.storage.directory, "runtime", "execution-leases", cancellationPlan.authorizationId, "owner.lock");
    const operationalOwnerLock = path.join(resolvedOperationalRoot, "runtime-execution-leases", initialized.project.projectId, cancellationPlan.authorizationId, "owner.lock");
    assert(!fs.existsSync(projectOwnerLock), "Operational owner lock leaked into project lineage.");
    assert(fs.existsSync(operationalOwnerLock), "Operational owner lock was not created in host-local state.");
    let concurrentReplayRejected = false;
    try {
      await runRuntimeLifecycleConformance({ root: resolvedRoot, authorization: cancellationPlan, mode: "success", onProcessEvent: recordProcess });
    } catch (error) {
      concurrentReplayRejected = error.code === "RUNTIME_INVOCATION_AUTHORIZATION_ALREADY_CONSUMED";
    }
    assert(concurrentReplayRejected, "Concurrent authorization replay was not rejected.");
    cancellation.abort();
    const cancelled = await cancellationRun;
    assert(cancelled.receipt.status === "cancelled", "Caller cancellation did not fail closed.");
    assert(cancelled.receipt.processBoundary.exactChildExitObserved === true, "Cancelled child exit was not observed.");
    assert(cancelled.executionLease.release.operationStatus === "cancelled", "Cancelled lease release was not recorded.");
    assert(!fs.existsSync(operationalOwnerLock), "Operational owner lock remained after cancellation cleanup.");
    const spawnFailureAuthorization = buildRuntimeInvocationAuthorization({
      root: resolvedRoot,
      runtime: "codex",
      scope: { kind: "run" },
      workspaceMode: "read-only",
      protocolEvidence,
      projectBinding,
      limits: { timeoutMs: 5_000, maxEvents: 4_094 },
      persist: true,
    }).authorization;
    let spawnFailureRejected = false;
    try {
      await runRuntimeLifecycleConformance({
        root: resolvedRoot,
        authorization: spawnFailureAuthorization,
        spawnImplementation: () => { throw new Error("synthetic spawn failure"); },
        onProcessEvent: recordProcess,
      });
    } catch (error) {
      spawnFailureRejected = error.code === "RUNTIME_CONFORMANCE_SPAWN_FAILED";
    }
    assert(spawnFailureRejected, "Synthetic spawn failure did not fail closed.");
    const spawnFailureLease = inspectRuntimeInvocationExecutionLease({
      root: resolvedRoot,
      authorizationId: spawnFailureAuthorization.authorizationId,
    });
    assert(spawnFailureLease.lease.status === "consumed-released", "Spawn failure lease was not durably released.");
    assert(spawnFailureLease.lease.release.operationStatus === "threw", "Spawn failure lease did not record the thrown operation.");
    let writeRejected = false;
    try {
      buildRuntimeInvocationAuthorization({
        root: resolvedRoot,
        runtime: "codex",
        scope: { kind: "run" },
        workspaceMode: "workspace-write",
        protocolEvidence,
        projectBinding,
        persist: false,
      });
    } catch (error) {
      writeRejected = error.code === "RUNTIME_INVOCATION_NOT_AUTHORIZED";
    }
    assert(writeRejected, "Workspace-write invocation was not rejected by the read-only ExecutionContract.");
    const legacyLockAuthorization = buildRuntimeInvocationAuthorization({
      root: resolvedRoot,
      runtime: "codex",
      scope: { kind: "run" },
      workspaceMode: "read-only",
      protocolEvidence,
      projectBinding,
      limits: { timeoutMs: 5_000, maxEvents: 4_093 },
      persist: true,
    }).authorization;
    const legacyProjectLock = path.join(resolvedRoot, initializedProject.storage.directory, "runtime", "execution-leases", legacyLockAuthorization.authorizationId, "owner.lock");
    fs.mkdirSync(legacyProjectLock, { recursive: true });
    let legacyProjectLockRejected = false;
    try {
      inspectRuntimeInvocationExecutionLease({ root: resolvedRoot, authorizationId: legacyLockAuthorization.authorizationId });
    } catch (error) {
      legacyProjectLockRejected = error.code === "LEGACY_PROJECT_OPERATIONAL_STATE_REQUIRES_RECOVERY";
    }
    assert(legacyProjectLockRejected, "Legacy project-local owner lock was silently ignored.");
    fs.rmdirSync(legacyProjectLock);
    const reviewDirectory = path.join(resolvedRoot, initializedProject.storage.directory, "lineage", "review-decisions");
    const reviewCount = () => fs.existsSync(reviewDirectory)
      ? fs.readdirSync(reviewDirectory).filter((name) => name.endsWith(".json")).length : 0;
    const reviewsBeforeDispatch = reviewCount();
    const workerAuthorization = buildRuntimeInvocationAuthorization({
      root: resolvedRoot,
      runtime: "codex",
      scope: { kind: "run" },
      workspaceMode: "read-only",
      protocolEvidence,
      projectBinding,
      limits: { timeoutMs: 5_000, maxEvents: 4_092 },
      worker: { taskKey: "provider-output-spool", role: "coder", outcome: "Return the synthetic bounded result", selectedContext: "Use the selected fixture evidence only." },
      persist: true,
    }).authorization;
    const workerDispatch = createBoundedWorkerDispatch({
      root: resolvedRoot,
      authorizationId: workerAuthorization.authorizationId,
      role: "coder",
    });
    assert(workerDispatch.status === "dispatched"
      && workerDispatch.dispatch.authorityBoundary.planeId === "P3"
      && workerDispatch.dispatch.ownershipBoundary.wholeOutcomeOwner === formatForVerifiedOwner(initializedProject.storage).roleField,
    "Bounded worker dispatch did not preserve P3 scope/result ownership beneath HEAD.");
    const sameDispatch = createBoundedWorkerDispatch({
      root: resolvedRoot,
      authorizationId: workerAuthorization.authorizationId,
      role: "coder",
    });
    assert(sameDispatch.status === "existing" && sameDispatch.dispatch.dispatchId === workerDispatch.dispatch.dispatchId,
      "Identical bounded worker dispatch did not replay to the same ownership record.");
    let competingOwnerRejected = false;
    try {
      createBoundedWorkerDispatch({
        root: resolvedRoot,
        authorizationId: workerAuthorization.authorizationId,
        role: "developer",
      });
    } catch (error) {
      competingOwnerRejected = error.code === "BOUNDED_WORKER_DISPATCH_OWNERSHIP_CONFLICT";
    }
    assert(competingOwnerRejected, "A second worker role acquired the same Run authorization.");
    const pendingWorker = await waitForBoundedWorkerDispatch({
      root: resolvedRoot,
      authorizationId: workerAuthorization.authorizationId,
      timeoutMs: 0,
    });
    assert(pendingWorker.waitOutcome.status === "pending"
      && pendingWorker.waitOutcome.authorityBoundary.planeId === "P5"
      && reviewCount() === reviewsBeforeDispatch,
    "Pending worker wait created authority or lost its P5 boundary.");
    const workerExecution = await executeBoundedWorkerDispatch({
      root: resolvedRoot,
      authorizationId: workerAuthorization.authorizationId,
      role: "coder",
      execution: {
        protocolEvidence,
        projectBinding,
        targetResolver: () => ({ executablePath: process.execPath, observation: codexObservation.executable }),
        supervisorSelection,
        providerArguments: ["-e", BOUNDED_WORKER_RUN_PROTOCOL_FIXTURE],
        evidenceMode: "protocol-fixture",
        onProcessEvent: recordProcess,
      },
    });
    assert(workerExecution.result.receipt.status === "completed"
      && workerExecution.result.descendantTreeOwnershipValidated === true,
    "Native-supervised bounded worker execution did not complete and clean up.");
    const workerSpool = readRuntimeOutputSpool({ operationalRoot: resolveRuntimeOperationalStateRoot({ projectRoot: resolvedRoot, storage: initializedProject.storage, create: false }), authorization: workerAuthorization });
    assert(workerSpool.status === "terminal-recorded"
      && workerSpool.terminal.result.receipt.receiptHash === workerExecution.result.receipt.receiptHash
      && workerSpool.terminal.ownerExitRequired === true
      && workerSpool.outputs.stdout.length > 0,
    "Provider production output did not reach the bounded durable Host spool.");
    const retryOptions = { root: resolvedRoot, runtime: "codex", protocolEvidence, projectBinding,
      worker: { taskKey: "provider-prestart-retry", role: "coder", outcome: "Verify retry", selectedContext: "Synthetic no-start fixture" } };
    const prestart = buildRuntimeInvocationAuthorization(retryOptions).authorization;
    let prestartFailed = false;
    try {
      await executeCodexRuntimeInvocation({ root: resolvedRoot, authorization: prestart, protocolEvidence, projectBinding,
        targetResolver: () => ({ executablePath: process.execPath, observation: codexObservation.executable }),
        supervisorSelection, providerArguments: ["-e", BOUNDED_WORKER_RUN_PROTOCOL_FIXTURE], evidenceMode: "protocol-fixture",
        spawnImplementation: () => { throw Object.assign(new Error("Synthetic OS spawn failure"), { code: "EAGAIN" }); } });
    } catch (error) { prestartFailed = error.code === "CODEX_EXEC_SPAWN_FAILED"; }
    assert(prestartFailed, "Provider no-start fixture unexpectedly ran.");
    const followup = buildRuntimeInvocationAuthorization({ ...retryOptions, retry: true }).authorization;
    assert(followup.workerInput.previousAuthorizationId === prestart.authorizationId,
      "Actual adapter path did not preserve a verified no-start retry.");
    const completedWorker = await waitForBoundedWorkerDispatch({
      root: resolvedRoot,
      authorizationId: workerAuthorization.authorizationId,
      timeoutMs: 1_000,
    });
    assert(completedWorker.waitOutcome.status === "completed"
      && completedWorker.waitOutcome.lifecycleReceiptId === workerExecution.result.receipt.receiptId
      && completedWorker.waitOutcome.resultDraftId === workerExecution.result.draft.draftId
      && reviewCount() === reviewsBeforeDispatch,
    "Durable worker wait did not return the exact result evidence without creating review authority.");

    const stateFile = path.join(resolvedRoot, initializedProject.storage.directory, "sessions", "current.json");
    const productCanonFile = path.join(resolvedRoot, initializedProject.storage.directory, "context", "product-model.json");
    const stateBeforeWave = fs.readFileSync(stateFile);
    const productCanonBeforeWave = fs.readFileSync(productCanonFile);
    const latestCheckpointBeforeWave = JSON.parse(stateBeforeWave).latestCheckpoint;
    const authorizationForWave = (maxEvents) => buildRuntimeInvocationAuthorization({
      root: resolvedRoot,
      runtime: "codex",
      scope: { kind: "run" },
      workspaceMode: "read-only",
      protocolEvidence,
      projectBinding,
      limits: { timeoutMs: 5_000, maxEvents },
      persist: true,
    }).authorization;
    const workerAuthorizationB = authorizationForWave(4_091);
    const workerAuthorizationC = authorizationForWave(4_090);
    createBoundedWorkerDispatch({ root: resolvedRoot, authorizationId: workerAuthorizationB.authorizationId, role: "developer" });
    createBoundedWorkerDispatch({ root: resolvedRoot, authorizationId: workerAuthorizationC.authorizationId, role: "reviewer" });
    let duplicateWaveMemberRejected = false;
    try {
      createBoundedWorkerWave({
        root: resolvedRoot,
        authorizationIds: [workerAuthorization.authorizationId, workerAuthorization.authorizationId],
      });
    } catch (error) {
      duplicateWaveMemberRejected = error.code === "BOUNDED_WORKER_WAVE_DUPLICATE_MEMBER";
    }
    assert(duplicateWaveMemberRejected, "A worker wave reused one authorization as two members.");
    assert(await rejectsWithCode(() => createBoundedWorkerWave({
      root: resolvedRoot,
      authorizationIds: [workerAuthorization.authorizationId, workerAuthorizationB.authorizationId],
      workspaceMode: "workspace-write",
    }), "BOUNDED_WORKER_WAVE_AUTHORIZATION_AMPLIFICATION_REJECTED"),
    "Worker wave accepted a request to widen member authorization scope.");
    const createdWave = createBoundedWorkerWave({
      root: resolvedRoot,
      authorizationIds: [workerAuthorizationC.authorizationId, workerAuthorization.authorizationId, workerAuthorizationB.authorizationId],
    });
    assert(createdWave.status === "created" && createdWave.wave.authorityBoundary.planeId === "P3"
      && createdWave.wave.waveBoundary.createsExecutionAuthorization === false
      && createdWave.wave.waveBoundary.widensMemberScope === false,
    "Worker wave did not remain a P3 grouping over existing exact authorizations.");
    const existingWave = createBoundedWorkerWave({
      root: resolvedRoot,
      authorizationIds: [workerAuthorization.authorizationId, workerAuthorizationB.authorizationId, workerAuthorizationC.authorizationId],
    });
    assert(existingWave.status === "existing" && existingWave.wave.waveId === createdWave.wave.waveId,
      "Identical worker wave create did not converge.");
    const openWave = readBoundedWorkerWaveStatus({ root: resolvedRoot, waveId: createdWave.wave.waveId }).projection;
    assert(openWave.state === "open" && openWave.counts.requested === 3 && openWave.counts.started === 1
      && openWave.counts.returned === 1 && openWave.counts.succeeded === 1 && openWave.counts.failed === 0
      && openWave.authorityBoundary.planeId === "P4",
    "Open worker wave status did not distinguish requested, started, returned, and succeeded members.");
    assert(await rejectsWithCode(
      () => sealBoundedWorkerWave({ root: resolvedRoot, waveId: createdWave.wave.waveId }),
      "BOUNDED_WORKER_WAVE_NOT_FULLY_STARTED",
    ), "A dispatch-only partial wave was sealed.");
    assert(await rejectsWithCode(
      () => waitForBoundedWorkerWave({ root: resolvedRoot, waveId: createdWave.wave.waveId, timeoutMs: 0 }),
      "BOUNDED_WORKER_WAVE_NOT_SEALED",
    ), "Wave wait did not fail closed before seal.");
    assert(await rejectsWithCode(
      () => readBoundedWorkerWaveResults({ root: resolvedRoot, waveId: createdWave.wave.waveId }),
      "BOUNDED_WORKER_WAVE_NOT_SEALED",
    ), "Wave result aggregation did not fail closed before seal.");

    await executeBoundedWorkerDispatch({
      root: resolvedRoot,
      authorizationId: workerAuthorizationB.authorizationId,
      role: "developer",
      execution: {
        protocolEvidence,
        projectBinding,
        targetResolver: () => ({ executablePath: process.execPath, observation: codexObservation.executable }),
        supervisorSelection,
        providerArguments: ["-e", BOUNDED_WORKER_RUN_PROTOCOL_FIXTURE],
        evidenceMode: "protocol-fixture",
        onProcessEvent: recordProcess,
      },
    });
    const partialWave = readBoundedWorkerWaveStatus({ root: resolvedRoot, waveId: createdWave.wave.waveId }).projection;
    assert(partialWave.counts.started === 2 && partialWave.counts.succeeded === 2 && partialWave.state === "open",
      "Partially launched wave was not kept open.");
    const successfulWave = createBoundedWorkerWave({
      root: resolvedRoot,
      authorizationIds: [workerAuthorization.authorizationId, workerAuthorizationB.authorizationId],
    });
    sealBoundedWorkerWave({ root: resolvedRoot, waveId: successfulWave.wave.waveId });
    const completedWave = readBoundedWorkerWaveStatus({ root: resolvedRoot, waveId: successfulWave.wave.waveId }).projection;
    assert(completedWave.state === "completed" && completedWave.counts.succeeded === 2 && completedWave.counts.failed === 0,
      "A fully successful sealed wave did not become completed.");
    assert(await rejectsWithCode(
      () => sealBoundedWorkerWave({ root: resolvedRoot, waveId: createdWave.wave.waveId }),
      "BOUNDED_WORKER_WAVE_NOT_FULLY_STARTED",
    ), "A partially started wave was sealed.");
    const failedWorkerExecution = await executeBoundedWorkerDispatch({
      root: resolvedRoot,
      authorizationId: workerAuthorizationC.authorizationId,
      role: "reviewer",
      execution: {
        protocolEvidence,
        projectBinding,
        targetResolver: () => ({ executablePath: process.execPath, observation: codexObservation.executable }),
        supervisorSelection,
        providerArguments: ["-e", BOUNDED_WORKER_FAILURE_PROTOCOL_FIXTURE],
        evidenceMode: "protocol-fixture",
        onProcessEvent: recordProcess,
      },
    });
    assert(failedWorkerExecution.result.receipt.status === "failed", "Fast terminal worker failure did not remain failed evidence.");
    const sealedWave = sealBoundedWorkerWave({ root: resolvedRoot, waveId: createdWave.wave.waveId });
    assert(sealedWave.status === "sealed" && sealedWave.seal.authorityBoundary.planeId === "P3"
      && sealedWave.seal.memberStartEvidence.length === 3,
    "Fully started worker wave did not produce one create-only P3 seal.");
    const failedWave = readBoundedWorkerWaveStatus({ root: resolvedRoot, waveId: createdWave.wave.waveId }).projection;
    assert(failedWave.state === "failed" && failedWave.counts.started === 3 && failedWave.counts.returned === 3
      && failedWave.counts.succeeded === 2 && failedWave.counts.failed === 1,
    "Fast terminal failure was mislabeled as wave success or completion.");
    const failedWaveWait = await waitForBoundedWorkerWave({ root: resolvedRoot, waveId: createdWave.wave.waveId, timeoutMs: 0 });
    assert(failedWaveWait.waitOutcome.authorityBoundary.planeId === "P5"
      && failedWaveWait.waitOutcome.state === "failed" && failedWaveWait.waitOutcome.reviewDecisionCreated === false,
    "Wave wait did not preserve the P5 failed outcome boundary.");
    const failedWaveResults = readBoundedWorkerWaveResults({ root: resolvedRoot, waveId: createdWave.wave.waveId });
    assert(failedWaveResults.projection.authorityBoundary.planeId === "P4"
      && failedWaveResults.projection.state === "failed" && failedWaveResults.projection.resultAuthority === "evidence-reference-only",
    "Wave result projection crossed out of P4 evidence references.");
    const sameSeal = sealBoundedWorkerWave({ root: resolvedRoot, waveId: createdWave.wave.waveId });
    assert(sameSeal.status === "existing" && sameSeal.seal.sealId === sealedWave.seal.sealId,
      "Wave seal replay did not converge.");
    const cliWaveStatus = await runCommand(["worker-wave-status", resolvedRoot, "--wave", createdWave.wave.waveId]);
    assert(cliWaveStatus.projection.statusProjectionId === failedWave.statusProjectionId,
      "CLI wave status did not preserve Core identity.");
    const mcpWaveStatus = await dispatch({
      jsonrpc: "2.0",
      id: 8_801,
      method: "tools/call",
      params: { name: publicToolName("head_bounded_worker_wave_status"), arguments: { project_root: resolvedRoot, wave_id: createdWave.wave.waveId } },
    });
    assert(mcpWaveStatus.result.structuredContent.projection.statusProjectionId === failedWave.statusProjectionId,
      "Typed MCP wave status did not preserve CLI/Core identity.");

    const sealPath = path.join(resolvedRoot, initializedProject.storage.directory, "runtime", "worker-waves", `${createdWave.wave.waveId}.terminal.json`);
    const sealBytes = fs.readFileSync(sealPath);
    const tamperedSeal = JSON.parse(sealBytes);
    tamperedSeal.sealHash = "0".repeat(64);
    fs.writeFileSync(sealPath, `${JSON.stringify(tamperedSeal, null, 2)}\n`);
    assert(await rejectsWithCode(
      () => readBoundedWorkerWaveStatus({ root: resolvedRoot, waveId: createdWave.wave.waveId }),
      "BOUNDED_WORKER_WAVE_SEAL_DIGEST_MISMATCH",
    ), "Tampered wave seal was accepted.");
    fs.writeFileSync(sealPath, sealBytes);
    const memberPath = path.join(resolvedRoot, initializedProject.storage.directory, "runtime", "worker-dispatches", `${workerAuthorizationB.authorizationId}.json`);
    const memberBytes = fs.readFileSync(memberPath);
    const tamperedMember = JSON.parse(memberBytes);
    tamperedMember.dispatchHash = "0".repeat(64);
    fs.writeFileSync(memberPath, `${JSON.stringify(tamperedMember, null, 2)}\n`);
    assert(await rejectsWithCode(
      () => readBoundedWorkerWaveStatus({ root: resolvedRoot, waveId: createdWave.wave.waveId }),
      "INVALID_BOUNDED_WORKER_DISPATCH",
    ), "Tampered wave member dispatch was accepted.");
    fs.writeFileSync(memberPath, memberBytes);
    const currentStateBytes = fs.readFileSync(stateFile);
    const driftedState = JSON.parse(currentStateBytes);
    driftedState.updatedAt = new Date(Date.parse(driftedState.updatedAt) + 1_000).toISOString();
    fs.writeFileSync(stateFile, `${JSON.stringify(driftedState, null, 2)}\n`);
    assert(readBoundedWorkerWaveStatus({ root: resolvedRoot, waveId: createdWave.wave.waveId }).projection.waveId === createdWave.wave.waveId,
      "An unrelated Session pointer update hid verified wave evidence.");
    assert(sealBoundedWorkerWave({ root: resolvedRoot, waveId: createdWave.wave.waveId }).status === "existing",
      "An unrelated Session pointer update invalidated unchanged execution lineage.");
    fs.writeFileSync(stateFile, currentStateBytes);
    const contractDriftState = JSON.parse(currentStateBytes);
    contractDriftState.activeExecutionContractId = `execution-contract-${"0".repeat(24)}`;
    fs.writeFileSync(stateFile, `${JSON.stringify(contractDriftState, null, 2)}\n`);
    assert(await rejectsWithCode(
      () => sealBoundedWorkerWave({ root: resolvedRoot, waveId: createdWave.wave.waveId }),
      "BOUNDED_WORKER_WAVE_LINEAGE_DRIFT",
    ), "A new ExecutionContract pointer did not stale the wave.");
    assert(readBoundedWorkerWaveStatus({ root: resolvedRoot, waveId: createdWave.wave.waveId }).projection.waveId === createdWave.wave.waveId,
      "ExecutionContract pointer drift hid historical evidence.");
    fs.writeFileSync(stateFile, currentStateBytes);
    const capsulePath = path.join(resolvedRoot, initializedProject.storage.directory, "context", "capsules", `${createdWave.wave.contextCapsuleId}.json`);
    const capsuleBytes = fs.readFileSync(capsulePath);
    const tamperedCapsule = JSON.parse(capsuleBytes);
    tamperedCapsule.capsuleHash = "0".repeat(64);
    fs.writeFileSync(capsulePath, `${JSON.stringify(tamperedCapsule, null, 2)}\n`);
    assert(await rejectsWithCode(
      () => readBoundedWorkerWaveStatus({ root: resolvedRoot, waveId: createdWave.wave.waveId }),
      "CAPSULE_DIGEST_MISMATCH",
    ), "Context Capsule tamper did not fail the wave status surface.");
    fs.writeFileSync(capsulePath, capsuleBytes);

    const workerAuthorizationD = authorizationForWave(4_089);
    const workerAuthorizationE = authorizationForWave(4_088);
    createBoundedWorkerDispatch({ root: resolvedRoot, authorizationId: workerAuthorizationD.authorizationId, role: "coder" });
    createBoundedWorkerDispatch({ root: resolvedRoot, authorizationId: workerAuthorizationE.authorizationId, role: "developer" });
    const abandonedWave = createBoundedWorkerWave({
      root: resolvedRoot,
      authorizationIds: [workerAuthorizationD.authorizationId, workerAuthorizationE.authorizationId],
    });
    const abandoned = abandonBoundedWorkerWave({
      root: resolvedRoot,
      waveId: abandonedWave.wave.waveId,
      reasonCode: "partial-launch",
      reasonSummary: "Launch evidence is incomplete; do not infer success or recovery direction.",
    });
    assert(abandoned.status === "abandoned" && abandoned.abandonment.authorityBoundary.planeId === "P3"
      && abandoned.abandonment.abandonBoundary.privilegedInstruction === false
      && readBoundedWorkerWaveStatus({ root: resolvedRoot, waveId: abandonedWave.wave.waveId }).projection.state === "abandoned",
    "Partial launch did not become explicit non-success P3 abandonment evidence.");
    const sameAbandonment = abandonBoundedWorkerWave({
      root: resolvedRoot,
      waveId: abandonedWave.wave.waveId,
      reasonCode: "partial-launch",
      reasonSummary: "Launch evidence is incomplete; do not infer success or recovery direction.",
    });
    assert(sameAbandonment.status === "existing" && sameAbandonment.abandonment.abandonmentId === abandoned.abandonment.abandonmentId,
      "Identical wave abandonment did not converge.");
    assert(await rejectsWithCode(() => abandonBoundedWorkerWave({
      root: resolvedRoot,
      waveId: abandonedWave.wave.waveId,
      reasonCode: "operator-stop",
      reasonSummary: "Divergent retry",
    }), "BOUNDED_WORKER_WAVE_ABANDON_CONFLICT"), "Divergent wave abandonment retry was accepted.");
    assert(await rejectsWithCode(
      () => sealBoundedWorkerWave({ root: resolvedRoot, waveId: abandonedWave.wave.waveId }),
      "BOUNDED_WORKER_WAVE_ABANDONED",
    ), "Abandoned wave was sealed.");
    assert(await rejectsWithCode(
      () => waitForBoundedWorkerWave({ root: resolvedRoot, waveId: abandonedWave.wave.waveId, timeoutMs: 0 }),
      "BOUNDED_WORKER_WAVE_NOT_SEALED",
    ), "Abandoned wave wait did not fail closed.");
    assert(fs.readFileSync(stateFile).equals(stateBeforeWave)
      && fs.readFileSync(productCanonFile).equals(productCanonBeforeWave)
      && JSON.parse(fs.readFileSync(stateFile, "utf8")).latestCheckpoint === latestCheckpointBeforeWave
      && reviewCount() === reviewsBeforeDispatch,
    "Wave surfaces changed P1 Canon, ReviewDecision, Session pointer, or P2 checkpoint state.");
    const persistedWaveText = [createdWave.wave, sealedWave.seal, abandoned.abandonment].map((value) => JSON.stringify(value)).join("\n");
    assert(!/(?:providerSession|callerHandle|paneId|socketPath|tuiCommand)/iu.test(persistedWaveText),
      "Provider, caller-handle, pane, socket, or TUI identity entered wave semantic state.");
    let duplicateWorkerConsumptionRejected = false;
    try {
      await executeBoundedWorkerDispatch({
        root: resolvedRoot,
        authorizationId: workerAuthorization.authorizationId,
        role: "coder",
        execution: {
          protocolEvidence,
          projectBinding,
          targetResolver: () => ({ executablePath: process.execPath, observation: codexObservation.executable }),
          supervisorSelection,
          providerArguments: ["-e", BOUNDED_WORKER_RUN_PROTOCOL_FIXTURE],
          evidenceMode: "protocol-fixture",
          onProcessEvent: recordProcess,
        },
      });
    } catch (error) {
      duplicateWorkerConsumptionRejected = error.code === "RUNTIME_INVOCATION_AUTHORIZATION_ALREADY_CONSUMED";
    }
    assert(duplicateWorkerConsumptionRejected, "The bounded worker authorization was consumed twice.");
    let fixtureApplicationRejected = false;
    try {
      applyBoundedWorkerDispatchResult({
        root: resolvedRoot,
        authorizationId: workerAuthorization.authorizationId,
      });
    } catch (error) {
      fixtureApplicationRejected = error.code === "RUNTIME_RUN_RESULT_NOT_APPLICABLE";
    }
    assert(fixtureApplicationRejected && reviewCount() === reviewsBeforeDispatch,
      "Protocol-fixture worker evidence crossed into canonical ResultPacket or review authority.");
    process.stdout.write(`${JSON.stringify({
      status: "runtime_invocation_lifecycle_verified",
      projectId: initialized.project.projectId,
      sessionId: initializedProject.state.sessionId,
      runId: run.runId,
      executionContractId: contract.executionContractId,
      protocolEvidenceId: protocolEvidence.evidenceId,
      projectBindingId: projectBinding.bindingId,
      runtimes: results,
      sessionScopes: sessionResults,
      timeoutReceiptId: timedOut.receipt.receiptId,
      cancellationReceiptId: cancelled.receipt.receiptId,
      singleUseLeaseVerified: true,
      replayRejected: true,
      concurrentReplayRejected,
      spawnFailureReleased: true,
      exactChildCleanupVerified: true,
      workspaceWriteRejected: true,
      sessionWorkspaceWriteAuthorized: true,
      sessionFreshHeadReviewRequired: false,
      codexExecProtocolFixtureValidated: true,
      codexStructuredResultRecorded: true,
      codexDescendantTreeSupervisionValidated: true,
      codexInvocationSurfacePreflightValidated: true,
      codexInvocationSurfaceDriftRejectedBeforeConsumption: true,
      runtimeModelSelectionBound: true,
      runtimeModelDriftChangesAuthorization: true,
      invalidRuntimeSelectionRejected,
      legacyExecutionAuthorizationVerified: true,
      codexPortableWireSchemaValidated: true,
      semanticResultBoundsRetained: true,
      codexPrivacyReducedDiagnosticsValidated: true,
    opencodeRunProtocolFixtureValidated: true,
    opencodeConfiguredProviderAuthorityPreserved: true,
    opencodeProviderEndpointRewritten: false,
    unselectedProviderCredentialsForwarded: false,
    opencodeStructuredResultRecorded: true,
      opencodeDescendantTreeSupervisionValidated: true,
      codexLargeEventBoundaryReproduced: true,
      codexLargeEventDefaultValidated: true,
      providerNeutralInvocationRecordValidated: true,
      opencodeProtocolFixtureModeValidated: true,
      sessionRunResultApplicationRejected: true,
      operationalStateExternalized: true,
      legacyProjectLockRejected,
      boundedWorker: {
        dispatchId: workerDispatch.dispatch.dispatchId,
        waitOutcomeId: completedWorker.waitOutcome.waitOutcomeId,
        competingOwnerRejected,
        duplicateWorkerConsumptionRejected,
        fixtureApplicationRejected,
        providerOutputSpoolVerified: true,
        providerPrestartRetryVerified: true,
      },
      boundedWorkerWave: {
        waveId: createdWave.wave.waveId,
        sealId: sealedWave.seal.sealId,
        failedStatusProjectionId: failedWave.statusProjectionId,
        abandonmentId: abandoned.abandonment.abandonmentId,
        duplicateMemberRejected: duplicateWaveMemberRejected,
        partialLaunchSealRejected: true,
        preSealWaitRejected: true,
        preSealResultReadRejected: true,
        terminalFailurePreserved: true,
        cliMcpParityVerified: true,
        authorityNonMutationVerified: true,
      },
      rawTranscriptPersistedInProject: false,
      boundedRawProviderOutputPersistedInHost: true,
      actualProviderInvoked: false,
      providerControlEnabled: false,
    }, null, 2)}\n`);
  } finally {
    if (previousOperationalRoot === undefined) delete process.env[RUNTIME_OPERATIONAL_STATE_ENV];
    else process.env[RUNTIME_OPERATIONAL_STATE_ENV] = previousOperationalRoot;
    const cleanupTargets = [
      { resolved: path.resolve(temporaryRoot), prefix: ".test-tmp-runtime-lifecycle-" },
      { resolved: path.resolve(temporaryOperationalRoot), prefix: ".test-tmp-runtime-operational-" },
    ];
    for (const { resolved, prefix } of cleanupTargets) {
      if (!resolved.startsWith(`${pluginRoot}${path.sep}`) || !path.basename(resolved).startsWith(prefix)) {
        throw new Error("Refusing to remove an unverified runtime temporary directory.");
      }
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ status: "failed", code: error.code || "RUNTIME_LIFECYCLE_VERIFY_ERROR", error: error.message })}\n`);
  process.exitCode = 1;
});

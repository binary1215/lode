import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/lode-core.mjs";
import { buildRuntimeVersionEvidence } from "../scripts/lib/runtime-machine-execution.mjs";
import { buildRuntimeProtocolEvidence, buildRuntimeProjectBinding } from "../scripts/lib/runtime-protocol-evidence.mjs";
import { buildRuntimeInvocationAuthorization, prepareRuntimeInvocationExecution } from "../scripts/lib/runtime-invocation-lifecycle.mjs";
import { createBoundedWorkerDispatch } from "../scripts/lib/bounded-worker-dispatch.mjs";
import { captureWorkerSourceBasis } from "../scripts/lib/worker-source-basis.mjs";
import { captureWorkerWriteBasis } from "../scripts/lib/worker-patch-basis.mjs";
import { prepareWorkerWorkspace } from "../scripts/lib/worker-workspace.mjs";
import { workerPatchProposalExecutionBoundary } from "../scripts/lib/worker-patch-proposal.mjs";
import { RUNTIME_OPERATIONAL_STATE_ENV, withRuntimeExecutionLease } from "../scripts/lib/runtime-execution-lease.mjs";
import { resolveVerifiedProcessSupervisor } from "../scripts/lib/runtime-process-supervisor.mjs";
import {
  buildCodexFreshProposalPolicyPlan,
  codexFreshProposalStartupArguments,
  codexFreshProposalThreadParams,
  codexFreshProposalTurnParams,
} from "../scripts/lib/runtime-codex-proposal-policy.mjs";
import {
  buildCodexNativePrefixPolicyPlan,
  verifyCodexNativePrefixPolicyPlan,
  codexNativePrefixStartupArguments,
} from "../scripts/lib/runtime-codex-prefix-policy.mjs";
import { createCodexNativePrefixSession } from "../scripts/lib/runtime-codex-prefix-session.mjs";
import {
  createCodexFreshProposalTransport,
  createCodexFreshProposalFixtureCapability,
  inspectCodexFreshProposalFixtureCapability,
  createCodexFreshProposalProtocolFixtureTransport,
  startCodexFreshProposalTransport,
} from "../scripts/lib/runtime-codex-app-server-transport.mjs";
import {
  createCodexNativePrefixProposalTransport,
  createCodexNativePrefixProposalFixtureTransport,
} from "../scripts/lib/runtime-codex-app-server-transport.mjs";
import { buildCodexProposalResultSchema } from "../scripts/lib/runtime-codex-proposal.mjs";
const pluginRoot = path.resolve(import.meta.dirname, "..");
const installedExecutable = process.env.LODE_AGENT_PREFIX_CAPTURE_EXECUTABLE || process.env.HEAD_AGENT_PREFIX_CAPTURE_EXECUTABLE;
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
async function terminal(transport, childThreadId) {
  let event;
  do {
    event = await transport.nextNotification({ childThreadId, deadlineAt: Date.now() + 2000 });
  } while (event.method !== "turn/completed");
  return event;
}
console.log(
  JSON.stringify({
    event: "proposal-transport-tests",
    pid: process.pid,
    parentPid: process.ppid,
    command: process.execPath,
    args: process.argv.slice(1),
    cwd: process.cwd(),
    ports: [],
    actualProviderInvoked: false,
  }),
);
function schemaSpawn(_command, args) {
  const command = args.join(" ");
  const output =
    command === "--version"
      ? "codex 1.2.3\n"
      : command === "--help"
        ? "exec\nmcp-server\napp-server\n"
        : command === "exec --help"
          ? "Run Codex non-interactively\n--json\n--output-schema\n--color\n--sandbox\n--skip-git-repo-check\n--cd\n--ephemeral\nresume\n"
          : "stdio://\ngenerate-json-schema\n--listen\n";
  const child = new EventEmitter();
  Object.assign(child, { pid: 1, stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null });
  queueMicrotask(() => {
    child.stdout.emit("data", Buffer.from(output));
    child.exitCode = 0;
    child.emit("close", 0, null);
  });
  return child;
}
async function fixture(t, scenario = "normal", options = {}) {
  const parent = fs.realpathSync(process.env.LODE_AGENT_TEST_TMP || process.env.HEAD_AGENT_TEST_TMP || os.tmpdir());
  const container = fs.mkdtempSync(path.join(parent, "proposal-rpc-"));
  const [root, operational, bin, codexHome] = ["project", "operational", "bin", "codex-home"].map((name) => {
    const value = path.join(container, name);
    fs.mkdirSync(value);
    return value;
  });
  const prior = process.env[RUNTIME_OPERATIONAL_STATE_ENV];
  process.env[RUNTIME_OPERATIONAL_STATE_ENV] = operational;
  let transport, identity;
  const journal = [];
  t.after(async () => {
    await transport?.close().catch(() => {});
    if (identity) {
      const observed = transport.inspect();
      assert.equal(observed.closed, true);
      assert.equal(observed.cleanup?.supervision.treeCleanupVerified, true);
      for (const pid of [identity.pid, observed.cleanup.supervision.providerPid].filter(Boolean)) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    }
    for (const event of journal.filter((item) => ["preflight-closed", "process-closed"].includes(item.event))) {
      assert.equal(event.supervision.treeCleanupVerified, true);
      for (const pid of [event.pid, event.supervision.providerPid].filter(Boolean)) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    }
    if (prior === undefined) delete process.env[RUNTIME_OPERATIONAL_STATE_ENV];
    else process.env[RUNTIME_OPERATIONAL_STATE_ENV] = prior;
    assert.equal(path.dirname(container), parent);
    assert.match(path.basename(container), /^proposal-rpc-/);
    fs.rmSync(container, { recursive: true, force: true });
  });
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  assert.equal(storage.directory, ".lode");
  assert.equal(fs.existsSync(path.resolve(root, ".lode/project.json")), true);
  assert.equal(fs.existsSync(path.resolve(root, ".head/project.json")), false);
  fs.writeFileSync(path.join(root, "selected.txt"), "selected synthetic bytes\n");
  const synthetic = path.join(bin, process.platform === "win32" ? "codex.exe" : "codex");
  fs.writeFileSync(synthetic, "Synthetic discovery target; never executed\n");
  if (process.platform !== "win32") fs.chmodSync(synthetic, 0o755);
  const environment = { ...process.env, PATH: bin };
  delete environment.Path;
  delete environment.path;
  const versionEvidence = await buildRuntimeVersionEvidence({ runtimes: ["codex"], environment, spawnImplementation: schemaSpawn });
  const protocolEvidence = await buildRuntimeProtocolEvidence({ runtimes: ["codex"], environment, versionEvidence, spawnImplementation: schemaSpawn });
  const inspected = inspectProject(root);
  const projectBinding = buildRuntimeProjectBinding({
    storage,
    projectId: inspected.project.projectId,
    headSessionId: inspected.state.sessionId,
    projectRoot: root,
    projectStatus: "ready",
    versionEvidence,
    protocolEvidence,
  });
  const sourceBasis = captureWorkerSourceBasis({ root, paths: ["selected.txt"], maxBytes: 1024 * 1024 });
  const proposalBasis = captureWorkerWriteBasis({ root, paths: ["selected.txt"], maxBytes: 1024 * 1024 });
  const workspaceBinding = prepareWorkerWorkspace({ projectRoot: root, workspaceRoot: path.join(container, "selected"), sourceBasis, maxBytes: 1024 * 1024 });
  const recipe = buildCodexFreshProposalPolicyPlan({
    executablePath: fs.realpathSync(options.actualExecutable || process.execPath),
    codexHome,
    evidenceMode: options.actualExecutable ? "actual-provider" : "protocol-fixture",
  });
  const policy = options.nativePrefix ? buildCodexNativePrefixPolicyPlan({ freshPolicy: recipe, seedText: "Synthetic controlled source." }) : recipe;
  const boundary = workerPatchProposalExecutionBoundary({ binding: workspaceBinding, policy, sourceBasis, proposalBasis });
  const authorization = buildRuntimeInvocationAuthorization({
    root,
    runtime: "codex",
    runtimeSelection: { model: policy.model },
    workspaceMode: "read-only",
    protocolEvidence,
    projectBinding,
    scope: { kind: "session", request: "Return a synthetic proposal only" },
    worker: {
      taskKey: "fresh-proposal-rpc",
      role: "coder",
      outcome: "Synthetic proposal",
      selectedContext: "Model-free protocol evidence",
      sourcePaths: ["selected.txt"],
      proposalPaths: ["selected.txt"],
      executionBoundary: boundary,
    },
    limits: { timeoutMs: 7000, terminationGraceMs: 600 },
  }).authorization;
  createBoundedWorkerDispatch({ root, authorizationId: authorization.authorizationId, role: "coder" });
  const input = prepareRuntimeInvocationExecution({ root, authorization }).input;
  // This fixture carries the real Core Session contract. Use its matching wire
  // schema, just as the executor does, without weakening subprocess assertions.
  const resultSchema = buildCodexProposalResultSchema(authorization.scope.kind);
  const config = {
    root,
    authorization,
    workspaceBinding,
    policy,
    authorizationHash: authorization.authorizationHash,
    policyDigest: hash(JSON.stringify(policy)),
    inputDigest: authorization.executionInput.digest,
    executionRoot: workspaceBinding.executionRoot,
    controlFile: path.join(operational, "control.jsonl"),
    supervisorSelection: resolveVerifiedProcessSupervisor({
      pluginRoot: process.env.LODE_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT || process.env.HEAD_AGENT_PROCESS_SUPERVISOR_FIXTURE_ROOT || pluginRoot,
    }),
    ...(options.nativePrefix ? { resultSchema } : {}),
    ...(options.actualExecutable ? { executablePath: policy.executablePath, executableDigest: policy.executableIdentity.contentDigest } : {}),
    providerEnvironment: { ...process.env, ...options.environment, CODEX_HOME: codexHome },
    terminationGraceMs: 600,
    ...(options.onStderrChunk ? { onStderrChunk: options.onStderrChunk } : {}),
    recordOperationalEvidence: (event) => {
      journal.push(event);
      if (event.event.startsWith("process-") || ["preflight-planned", "preflight-spawn", "preflight-closed"].includes(event.event))
        t.diagnostic(JSON.stringify(event));
      options.journal?.(event);
    },
  };
  const capability = createCodexFreshProposalFixtureCapability({ scenario });
  transport = options.nativePrefix
    ? options.actualExecutable
      ? createCodexNativePrefixProposalTransport(config)
      : createCodexNativePrefixProposalFixtureTransport(config, { capability })
    : createCodexFreshProposalProtocolFixtureTransport(config, { capability });
  const controller = new AbortController();
  let sequence = 0;
  let deadlineAt;
  const request = (method, params, extra = {}) =>
    transport.request({ requestId: `proposal-${sequence++}`, method, params, deadlineAt, signal: controller.signal, ...extra });
  const startParams = options.nativePrefix
    ? transport.prefixParams("thread/start")
    : codexFreshProposalThreadParams({ policy, executionRoot: config.executionRoot });
  const turnParams = (threadId) =>
    options.nativePrefix
      ? transport.prefixParams("turn/start", input.toString("utf8"))
      : codexFreshProposalTurnParams({ policy, threadId, input: input.toString("utf8"), outputSchema: resultSchema });
  const launch = async (context, overrides = {}) => {
    deadlineAt = Math.min(
      Date.parse(context.consumption.consumedAt) + authorization.limits.timeoutMs,
      Date.parse(context.consumption.holdDeadlineAt) - authorization.limits.terminationGraceMs,
    );
    identity = await startCodexFreshProposalTransport({
      ownedTransport: transport.ownedTransport,
      projectRoot: root,
      ...context,
      authorization,
      executionRoot: config.executionRoot,
      policyDigest: config.policyDigest,
      inputDigest: config.inputDigest,
      deadlineAt,
      signal: controller.signal,
      ...overrides,
    });
    return identity;
  };
  const run = (operation) =>
    withRuntimeExecutionLease({ projectRoot: root, authorization, ownerFenceDigest: hash("fresh-proposal-transport-test-owner") }, async (context) => {
      try {
        return await operation(context);
      } finally {
        await transport.close().catch(() => {});
      }
    });
  const ready = async () => {
    await request("config/read", { cwd: config.executionRoot, includeLayers: false });
    await request("skills/list", { cwds: [config.executionRoot], forceReload: true });
    await request("account/read", { refreshToken: false });
    await request("model/list", { limit: 100, includeHidden: false });
  };
  return { storage, root, config, policy, transport, journal, controller, request, launch, run, ready, startParams, turnParams, capability, authorization };
}

test("fresh constructor requires opaque fixture identity and rejects arbitrary launch recipes", async (t) => {
  const f = await fixture(t);
  for (const capability of [{}, JSON.parse(JSON.stringify(f.capability)), null])
    assert.throws(() => inspectCodexFreshProposalFixtureCapability(capability), { code: "CODEX_RPC_PROPOSAL_FIXTURE_CAPABILITY" });
  for (const extra of [{ args: ["app-server", "--remote-control"] }, { startupConfig: {} }, { sourceThreadId: "existing" }, { scenario: "normal" }]) {
    assert.throws(() => createCodexFreshProposalProtocolFixtureTransport({ ...f.config, ...extra }, { capability: f.capability }), {
      code: "CODEX_RPC_PROPOSAL_CONFIGURATION",
    });
  }
  assert.throws(() => createCodexFreshProposalTransport(f.config));
  const args = codexFreshProposalStartupArguments(f.policy);
  assert.deepEqual(args.slice(0, 3), ["app-server", "--listen", "stdio://"]);
  assert.equal(args.includes("--remote-control"), false);
  assert.equal(f.transport.startFixture, undefined);
  assert.equal(f.transport.start, undefined);
  assert.equal(f.transport.handle, undefined);
});

test("fresh launch rejects missing consumption, copied capability and wrong roots before spawn", async (t) => {
  const f = await fixture(t);
  await assert.rejects(startCodexFreshProposalTransport({ ownedTransport: f.transport.ownedTransport }), { code: "CODEX_RPC_PROPOSAL_BINDING_MISMATCH" });
  await f.run(async (context) => {
    for (const mismatch of [
      { ownedTransport: {} },
      { consumption: null },
      { policyDigest: "0".repeat(64) },
      { executionRoot: f.root },
      { inputDigest: "1".repeat(64) },
    ]) {
      await assert.rejects(f.launch(context, mismatch), { code: "CODEX_RPC_PROPOSAL_BINDING_MISMATCH" });
    }
    assert.equal(f.transport.inspect().started, false);
    assert.equal(f.journal.length, 0);
  });
});

test("fresh exact flow has one owned thread and turn, no inherited methods or tool approval", async (t) => {
  const f = await fixture(t);
  await f.run(async (context) => {
    const identity = await f.launch(context);
    assert.deepEqual(Object.keys(identity).sort(), ["parentPid", "pid", "started"]);
    for (const method of ["thread/read", "thread/resume", "thread/fork", "thread/goal/get", "thread/goal/clear", "account/login/start"]) {
      await assert.rejects(f.request(method, {}), { code: "CODEX_RPC_METHOD_UNSUPPORTED" });
    }
    await assert.rejects(f.request("thread/start", f.startParams), { code: "CODEX_RPC_PROPOSAL_PARAMS_MISMATCH" });
    await f.ready();
    const response = await f.request("thread/start", f.startParams);
    await assert.rejects(f.transport.nextNotification({ childThreadId: response.thread.id, deadlineAt: Date.now() + 1000 }), {
      code: "CODEX_RPC_PROPOSAL_TURN_NOT_STARTED",
    });
    await assert.rejects(f.request("turn/start", f.turnParams("unowned-thread")), { code: "CODEX_RPC_PROPOSAL_PARAMS_MISMATCH" });
    const wrongInput = f.turnParams(response.thread.id);
    wrongInput.input[0].text += "changed";
    await assert.rejects(f.request("turn/start", wrongInput), { code: "CODEX_RPC_PROPOSAL_PARAMS_MISMATCH" });
    const turn = await f.request("turn/start", f.turnParams(response.thread.id));
    const event = await f.transport.nextNotification({ childThreadId: response.thread.id, deadlineAt: Date.now() + 1000 });
    assert.equal(event.params.turn.id, turn.turn.id);
    await assert.rejects(f.request("turn/start", f.turnParams(response.thread.id)), { code: "CODEX_RPC_PROPOSAL_REQUEST_REPLAYED" });
  });
  assert.equal(f.transport.inspect().actualProviderInvoked, false);
  assert.equal(f.transport.inspect().modelCallAttempted, true, "synthetic turn write, not a real model call");
  assert.equal(fs.readFileSync(path.join(f.root, "selected.txt"), "utf8"), "selected synthetic bytes\n");
});

test("fresh concurrent start and caller mutations cannot select two threads or change fixed input", async (t) => {
  const f = await fixture(t);
  await f.run(async (context) => {
    await f.launch(context);
    await f.ready();
    const mutable = structuredClone(f.startParams);
    const first = f.request("thread/start", mutable);
    mutable.model = "other";
    await assert.rejects(f.request("thread/start", f.startParams), { code: "CODEX_RPC_PROPOSAL_REQUEST_REPLAYED" });
    const response = await first;
    assert.equal(response.model, f.policy.wireModel);
    assert.equal(f.journal.filter((item) => item.method === "thread/start" && item.event === "request-sent").length, 1);
  });
});

for (const scenario of ["wrong-model", "wrong-root", "inherited-thread", "wrong-policy", "enabled-mcp", "enabled-skill", "lost-start", "lost-turn"]) {
  test(`fresh ${scenario} closes without accepting a replacement or replay`, async (t) => {
    const f = await fixture(t, scenario);
    await f.run(async (context) => {
      await f.launch(context);
      await assert.rejects(
        (async () => {
          await f.ready();
          const response = await f.request("thread/start", f.startParams);
          if (scenario === "lost-turn") await f.request("turn/start", f.turnParams(response.thread.id));
        })(),
      );
      if (!["enabled-mcp", "enabled-skill"].includes(scenario)) {
        const failed = f.journal.find((item) => item.event === "request-failed" && item.method === (scenario === "lost-turn" ? "turn/start" : "thread/start"));
        assert.equal(failed?.state, "uncertain");
        assert.equal(failed.writeAttempted, true);
      }
      await assert.rejects(f.request("thread/start", f.startParams));
      assert.ok(f.journal.filter((item) => item.method === "thread/start" && item.event === "request-sent").length <= 1);
    });
  });
}

for (const scenario of ["wrong-event-thread", "wrong-event-turn"])
  test(`fresh ${scenario} cannot supply terminal completion`, async (t) => {
    const f = await fixture(t, scenario);
    await f.run(async (context) => {
      await f.launch(context);
      await f.ready();
      const response = await f.request("thread/start", f.startParams);
      await f.request("turn/start", f.turnParams(response.thread.id));
      await assert.rejects(f.transport.nextNotification({ childThreadId: response.thread.id, deadlineAt: Date.now() + 1000 }), {
        code: "CODEX_RPC_PROPOSAL_EVENT_MISMATCH",
      });
    });
  });

test("fresh startup notification cannot authorize another thread", async (t) => {
  const f = await fixture(t, "early-notification");
  await f.run(async (context) => {
    await f.launch(context);
    await f.ready();
    const response = await f.request("thread/start", f.startParams);
    assert.equal(f.transport.inspect().freshThreadId, response.thread.id);
    await assert.rejects(f.request("turn/start", f.turnParams("unowned-notification-thread")), { code: "CODEX_RPC_PROPOSAL_PARAMS_MISMATCH" });
  });
});

test("fresh pending turn cancellation keeps uncertain delivery and exact owned cleanup", async (t) => {
  const f = await fixture(t, "hang-turn");
  await f.run(async (context) => {
    await f.launch(context);
    await f.ready();
    const response = await f.request("thread/start", f.startParams);
    const pending = f.request("turn/start", f.turnParams(response.thread.id));
    const timer = setTimeout(() => f.controller.abort(), 100);
    try {
      await assert.rejects(pending, { code: "CODEX_RPC_CANCELLED" });
    } finally {
      clearTimeout(timer);
    }
    await f.transport.cleanup({ reason: "CODEX_FRESH_PROPOSAL_CANCELLED", commit: () => {} });
    assert.equal(f.journal.find((item) => item.event === "request-failed" && item.method === "turn/start").state, "uncertain");
    assert.equal(f.transport.inspect().cleanup.supervision.treeCleanupVerified, true);
  });
});

test("fresh environment cannot inject Node code, credentials, endpoint or debug overrides", async (t) => {
  const f = await fixture(t, "environment-check", {
    environment: {
      NODE_OPTIONS: "--this-flag-must-never-reach-node",
      OPENAI_API_KEY: "synthetic-not-a-key",
      OPENAI_BASE_URL: "https://invalid.example",
      CODEX_CONFIG: "synthetic-forbidden-config",
      CODEX_RS_LOG: "synthetic-forbidden-debug",
    },
  });
  await f.run(async (context) => {
    await f.launch(context);
    await f.ready();
    await f.request("thread/start", f.startParams);
  });
});

test("fresh returned-response journal failure closes before a turn can be written", async (t) => {
  const f = await fixture(t, "normal", {
    journal: (event) => {
      if (event.event === "request-returned" && event.method === "thread/start")
        throw Object.assign(new Error("synthetic journal failure"), { code: "TEST_PROPOSAL_JOURNAL_FAILURE" });
    },
  });
  await f.run(async (context) => {
    await f.launch(context);
    await f.ready();
    await assert.rejects(f.request("thread/start", f.startParams), { code: "TEST_PROPOSAL_JOURNAL_FAILURE" });
    assert.equal(f.transport.inspect().failureCode, "TEST_PROPOSAL_JOURNAL_FAILURE");
    await assert.rejects(f.request("turn/start", f.turnParams(f.transport.inspect().freshThreadId)));
    assert.equal(
      f.journal.some((item) => item.method === "turn/start" && item.event === "request-sent"),
      false,
    );
  });
});

test("fresh second transport cannot reuse an already reserved consumption", async (t) => {
  const f = await fixture(t);
  const other = createCodexFreshProposalProtocolFixtureTransport({ ...f.config, controlFile: f.config.controlFile + ".other" }, { capability: f.capability });
  try {
    await f.run(async (context) => {
      await f.launch(context);
      await assert.rejects(f.launch(context, { ownedTransport: other.ownedTransport }), { code: "CODEX_RPC_PROPOSAL_CONSUMPTION_REPLAYED" });
      assert.equal(other.inspect().started, false);
    });
  } finally {
    await other.close();
  }
});

for (const scenario of ["preflight-normal", "preflight-enabled", "preflight-hang"])
  test(`fresh private ${scenario} settles its exact owned child before app-server admission`, async (t) => {
    let preflightStarted;
    const spawned = new Promise((resolve) => {
      preflightStarted = resolve;
    });
    const stderr = [];
    const f = await fixture(t, scenario, {
      journal: (event) => {
        if (event.event === "preflight-control" && event.control.type === "provider.started") preflightStarted();
      },
      onStderrChunk: (chunk) => stderr.push(chunk),
    });
    await f.run(async (context) => {
      if (scenario === "preflight-hang") {
        const launch = f.launch(context);
        const rejected = assert.rejects(launch, { code: "CODEX_RPC_CANCELLED" });
        await spawned;
        await f.transport.close().catch(() => {});
        await rejected;
      } else if (scenario === "preflight-enabled") {
        await assert.rejects(f.launch(context), { code: "CODEX_FRESH_PROPOSAL_FEATURE_REMAINS_ENABLED" });
      } else {
        await f.launch(context);
        await f.ready();
        assert.match(Buffer.concat(stderr).toString(), /synthetic preflight stderr/u);
      }
      const observed = f.transport.inspect();
      assert.equal(observed.preflight.cleanup.actualProviderInvoked, false);
      assert.equal(observed.preflight.cleanup.exactExitObserved, true);
      assert.equal(observed.preflight.cleanup.supervision.treeCleanupVerified, true);
      if (scenario !== "preflight-normal") {
        assert.equal(
          f.journal.some((event) => event.event === "process-started"),
          false,
        );
        await f.transport.close().catch(() => {});
        const settled = f.transport.inspect();
        assert.equal(settled.started, true);
        assert.equal(settled.actualProviderInvoked, false);
        assert.deepEqual(settled.cleanup, settled.preflight.cleanup);
      }
    });
  });

for (const [scenario, code] of [
  ["approval", "CODEX_RPC_PROPOSAL_EFFECT_REJECTED"],
  ["trailing-effect", "CODEX_RPC_PROPOSAL_EFFECT_REJECTED"],
  ["duplicate-completion", "CODEX_RPC_PROPOSAL_AFTER_TERMINAL"],
  ["trailing-partial", "CODEX_RPC_PARTIAL_FRAME"],
  ["start-effect-item", "CODEX_RPC_PROPOSAL_EFFECT_REJECTED"],
])
  test(`fresh ${scenario} cannot remain successful through exact close`, async (t) => {
    const f = await fixture(t, scenario);
    await f.run(async (context) => {
      await f.launch(context);
      await f.ready();
      const response = await f.request("thread/start", f.startParams);
      await f.request("turn/start", f.turnParams(response.thread.id)).catch((cause) => assert.equal(cause.code, code));
      if (scenario === "start-effect-item") assert.equal(f.transport.inspect().freshTurnId, null);
      else
        await f.transport
          .nextNotification({ childThreadId: response.thread.id, deadlineAt: Date.now() + 1000 })
          .catch((cause) => assert.equal(cause.code, code));
      await f.transport.close().catch(() => {});
      assert.equal(f.transport.inspect().failureCode, code);
      if (scenario === "approval")
        assert.equal(
          f.journal.some((item) => item.event === "server-action-denied"),
          true,
        );
    });
  });

for (const [scenario, code] of [
  ["catalog-incomplete", "CODEX_RPC_PROPOSAL_CATALOG_INCOMPLETE"],
  ["model-unavailable", "CODEX_RPC_PROPOSAL_MODEL_UNAVAILABLE"],
])
  test(`fresh ${scenario} fails before thread creation with precise catalog evidence`, async (t) => {
    const f = await fixture(t, scenario);
    await f.run(async (context) => {
      await f.launch(context);
      await assert.rejects(f.ready(), { code });
      assert.equal(
        f.journal.some((item) => item.event === "request-sent" && ["thread/start", "turn/start"].includes(item.method)),
        false,
      );
    });
  });

test("native prefix policy cannot substitute caller source identity or reinterpret fresh authority", async (t) => {
  const f = await fixture(t, "prefix-normal", { nativePrefix: true });
  for (const change of [
    { seed: { ...f.policy.seed, provenance: "caller-verified" } },
    { observations: { ...f.policy.observations, childHistoryReadback: true } },
    { seed: { ...f.policy.seed, durableProviderHistory: false } },
    { sourceThreadId: "other" },
  ]) {
    assert.throws(() => verifyCodexNativePrefixPolicyPlan({ ...f.policy, ...change }), { code: "CODEX_NATIVE_PREFIX_POLICY_CONFLICT" });
  }
  for (const extra of [{ sourceThreadId: "other" }, { sourcePath: "other.jsonl" }, { sourceVerified: true }, { args: [] }]) {
    assert.throws(() => createCodexNativePrefixProposalFixtureTransport({ ...f.config, ...extra }, { capability: f.capability }));
  }
  assert.throws(() => createCodexNativePrefixProposalFixtureTransport({ ...f.config, policy: f.policy.recipe }, { capability: f.capability }));
  assert.equal(f.transport.inspect().started, false);
});

test("native prefix compares JSON values rather than field order and freezes the result schema", async (t) => {
  const f = await fixture(t, "prefix-normal", { nativePrefix: true });
  const schema = { type: "object", additionalProperties: false };
  const config = { policy: f.policy, executionRoot: f.config.executionRoot, inputDigest: f.config.inputDigest, resultSchema: schema };
  for (const resultSchema of [null, [], { type: "string" }])
    assert.throws(() => createCodexNativePrefixSession({ ...config, resultSchema }), { code: "CODEX_NATIVE_PREFIX_SCHEMA_REQUIRED" });
  const state = createCodexNativePrefixSession(config);
  schema.additionalProperties = true;
  const reversed = (value) =>
    Array.isArray(value)
      ? value.map(reversed)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .reverse()
              .map(([key, item]) => [key, reversed(item)]),
          )
        : value;
  const reply = {
    model: f.policy.wireModel,
    modelProvider: f.policy.wireModelProvider,
    cwd: f.config.executionRoot,
    runtimeWorkspaceRoots: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "readOnly", networkAccess: false },
    instructionSources: [],
    thread: {
      id: "synthetic-source",
      modelProvider: f.policy.wireModelProvider,
      cwd: f.config.executionRoot,
      ephemeral: false,
      historyMode: "legacy",
      status: { type: "idle" },
      turns: [],
    },
  };
  state.reserve("thread/start", reversed(state.params("thread/start")));
  state.response("thread/start", reply);
  state.reserve("turn/start", state.params("turn/start"));
  state.response("turn/start", { turn: { id: "synthetic-seed-turn", status: "inProgress", items: [] } });
  const turn = {
    id: "synthetic-seed-turn",
    status: "completed",
    items: [
      { id: "live-user", type: "userMessage", clientId: null, content: state.params("turn/start").input },
      { id: "seed-ack", type: "agentMessage", phase: "final_answer", text: '{"seed":"NATIVE_PREFIX_SEED_READY"}' },
    ],
  };
  for (const item of turn.items) state.notification({ method: "item/completed", params: { threadId: "synthetic-source", turnId: turn.id, item } });
  state.notification({ method: "turn/completed", params: { threadId: "synthetic-source", turn } });
  state.reserve("thread/read", state.params("thread/read"));
  const storedTurn = { ...turn, items: turn.items.map((item, index) => ({ ...item, id: `item-${index + 1}` })) };
  state.response("thread/read", { thread: { ...reply.thread, turns: [reversed(storedTurn)] } });
  state.reserve("thread/fork", state.params("thread/fork"));
  state.response("thread/fork", {
    ...reply,
    thread: { ...reply.thread, id: "synthetic-child", ephemeral: true, forkedFromId: "synthetic-source", turns: [storedTurn] },
  });
  assert.equal(state.params("turn/start", "unused in this pure state test").outputSchema.additionalProperties, false);
  assert.equal(f.transport.inspect().started, false);
});

test("native prefix fixed flow owns one seed and one child with exact prefix and no child history RPC", async (t) => {
  const f = await fixture(t, "prefix-normal", { nativePrefix: true });
  await f.run(async (context) => {
    await f.launch(context);
    await f.ready();
    for (const method of ["thread/resume", "thread/goal/get", "thread/goal/clear"])
      await assert.rejects(f.request(method, {}), { code: "CODEX_RPC_METHOD_UNSUPPORTED" });
    await assert.rejects(f.request("thread/fork", { threadId: "external" }), { code: "CODEX_NATIVE_PREFIX_SEQUENCE" });
    const source = await f.request("thread/start", f.startParams);
    await assert.rejects(f.request("thread/start", f.startParams), { code: "CODEX_NATIVE_PREFIX_REPLAY" });
    await assert.rejects(f.request("thread/read", f.transport.prefixParams("thread/read")), { code: "CODEX_NATIVE_PREFIX_SEQUENCE" });
    await f.request("turn/start", f.turnParams(source.thread.id));
    await terminal(f.transport, source.thread.id);
    await assert.rejects(f.request("thread/read", { threadId: "external", includeTurns: true }), { code: "CODEX_NATIVE_PREFIX_PARAMS_MISMATCH" });
    await f.request("thread/read", f.transport.prefixParams("thread/read"));
    const fork = f.transport.prefixParams("thread/fork");
    for (const extra of [{ threadId: "external" }, { path: "external.jsonl" }, { deferMaterialization: true }, { ephemeral: false }, { excludeTurns: true }]) {
      await assert.rejects(f.request("thread/fork", { ...fork, ...extra }));
    }
    const child = await f.request("thread/fork", fork);
    await assert.rejects(f.request("thread/fork", fork), { code: "CODEX_NATIVE_PREFIX_REPLAY" });
    await assert.rejects(f.request("thread/read", { threadId: child.thread.id, includeTurns: true }));
    const childInput = f.turnParams(child.thread.id);
    await assert.rejects(f.request("turn/start", { ...childInput, input: [{ type: "text", text: "unbound" }] }), { code: "CODEX_NATIVE_PREFIX_INPUT_DRIFT" });
    await f.request("turn/start", childInput);
    await terminal(f.transport, child.thread.id);
    await assert.rejects(f.request("turn/start", childInput), { code: "CODEX_NATIVE_PREFIX_REPLAY" });
    assert.equal(f.transport.inspect().prefix.childComplete, true);
  });
  const methods = f.journal.filter((event) => event.event === "request-sent").map((event) => event.method);
  assert.deepEqual(methods, [
    "initialize",
    "config/read",
    "skills/list",
    "account/read",
    "model/list",
    "thread/start",
    "turn/start",
    "thread/read",
    "thread/fork",
    "turn/start",
  ]);
  assert.equal(f.transport.inspect().actualProviderInvoked, false);
});

test(
  "native prefix actual constructor reaches fixed preflight recipe but is stopped before any process or account call",
  {
    skip:
      !installedExecutable &&
      "Set LODE_AGENT_PREFIX_CAPTURE_EXECUTABLE (legacy HEAD_AGENT_PREFIX_CAPTURE_EXECUTABLE is also accepted) for read-only installed binary capture",
  },
  async (t) => {
    let captured = null;
    const f = await fixture(t, "prefix-normal", {
      nativePrefix: true,
      actualExecutable: installedExecutable,
      journal: (event) => {
        if (event.event !== "preflight-planned") return;
        captured = event;
        throw Object.assign(new Error("Stop before spawning actual executable"), { code: "TEST_PREFIX_SPAWN_CAPTURED" });
      },
    });
    await f.run(async (context) => {
      await assert.rejects(f.launch(context), { code: "TEST_PREFIX_SPAWN_CAPTURED" });
      assert.deepEqual(captured.args.slice(0, 2), ["features", "list"]);
      assert.deepEqual(captured.args, ["features", "list", ...codexNativePrefixStartupArguments(f.policy).slice(3)]);
      assert.ok(captured.args.includes("show_raw_agent_reasoning=false"));
      assert.equal(f.policy.recipe.startupConfig.features.goals, false);
      assert.equal(captured.command, fs.realpathSync(installedExecutable));
      assert.equal(captured.cwd, f.config.executionRoot);
      assert.equal(
        f.journal.some((event) => event.event === "preflight-spawn" || event.event === "process-started" || event.event === "request-sent"),
        false,
      );
      assert.equal(f.transport.inspect().modelCallAttempted, false);
    });
  },
);

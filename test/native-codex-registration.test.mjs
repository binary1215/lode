import { registerCodexNativeHistory } from "../scripts/lib/distribution/codex-native-registration.mjs";
import os from "node:os";
import { openCodexNativeRegistrationRpc } from "../scripts/lib/distribution/codex-native-registration-rpc.mjs";
import { resolveVerifiedProcessSupervisor } from "../scripts/lib/runtime/runtime-process-supervisor.mjs";
import { nativeSqlitePath } from "../scripts/lib/distribution/codex-native-backup.mjs";
import { publishCodexNativeHistory } from "../scripts/lib/distribution/codex-native-publication.mjs";
import { captureCodexNativeHistory } from "../scripts/lib/distribution/codex-native-capture.mjs";
import { prepareCodexNativeOffline } from "../scripts/lib/distribution/codex-native-offline.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fixture, snapshot } from "./helpers/session-work-linkage-fixture.mjs";
import { pluginRoot } from "./helpers/session-work-linkage-fixture.mjs";
import crypto from "node:crypto";
import { DatabaseSync, backup } from "node:sqlite";
import { readTypedSqliteRows } from "../scripts/lib/core/native-sqlite-values.mjs";
import { nativeProfile, syntheticNativeDatabase } from "./helpers/native-portability-fixture.mjs";

test("opt-in exact installed SDK registers a fresh synthetic target without a model turn", async (t) => {
  const executable = process.env.LODE_NATIVE_CODEX_TEST_EXECUTABLE,
    supervisorRoot = process.env.LODE_NATIVE_CODEX_TEST_SUPERVISOR_ROOT,
    captureFile = process.env.LODE_NATIVE_CODEX_TEST_SOURCE_CAPTURE;
  if (
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    !executable ||
    !supervisorRoot ||
    !captureFile
  )
    return t.skip(
      "Opt-in synthetic exact-engine metadata integration; no personal home or model calls.",
    );
  const f = fixture(t),
    original = JSON.parse(fs.readFileSync(captureFile));
  assert.equal(original.kind, "StoppedSyntheticNativeCapture");
  assert.equal(original.modelCalls, 0);
  const oldRoot = fs.realpathSync(original.sourceRoot);
  assert.match(path.basename(oldRoot), /^lode-native-source-policy-v1-/);
  assert.equal(path.dirname(oldRoot), fs.realpathSync(os.tmpdir()));
  assert(original.rawRelativePath.startsWith("home/codex/sessions/"));
  const rawSource = fs.readFileSync(path.join(oldRoot, original.rawRelativePath));
  assert.equal(crypto.createHash("sha256").update(rawSource).digest("hex"), original.rawSha256);
  const sourceHome = path.join(f.base, "sdk-source");
  fs.mkdirSync(sourceHome);
  // Test fixture construction only. Production capture never copies a whole DB.
  for (const file of ["state_5.sqlite", "thread_history_1.sqlite"]) {
    const input = new DatabaseSync(nativeSqlitePath(path.join(oldRoot, "home/codex", file)), {
      readOnly: true,
    });
    try {
      await backup(input, nativeSqlitePath(path.join(sourceHome, file)));
    } finally {
      input.close();
    }
  }
  const relative = original.rawRelativePath.slice("home/codex/".length),
    sourceRaw = path.join(sourceHome, relative);
  fs.mkdirSync(path.dirname(sourceRaw), { recursive: true });
  fs.writeFileSync(sourceRaw, rawSource);
  const sourceState = new DatabaseSync(nativeSqlitePath(path.join(sourceHome, "state_5.sqlite")));
  try {
    sourceState
      .prepare("UPDATE threads SET rollout_path=? WHERE id=?")
      .run(sourceRaw, original.threadId);
  } finally {
    sourceState.close();
  }
  const observer = async () => ({ status: "observed", rows: [] }); // Explicit protocol-fixture stopped observation, not an OS-positive claim.
  const sourceOffline = await prepareCodexNativeOffline({
    home: sourceHome,
    executable,
    probe: observer,
  });
  const captured = await captureCodexNativeHistory({
    witness: sourceOffline.witness,
    threadIds: [original.threadId],
    destination: path.join(f.base, "sdk-payload"),
  });
  const targetHome = path.join(f.base, "sdk-target/home/codex"),
    runtimeRoot = path.join(f.base, "sdk-target/workspace");
  fs.mkdirSync(targetHome, { recursive: true });
  fs.mkdirSync(runtimeRoot);
  const state = syntheticNativeDatabase(
      t,
      "state_5.sqlite",
      path.join(targetHome, "state_5.sqlite"),
    ),
    history = syntheticNativeDatabase(
      t,
      "thread_history_1.sqlite",
      path.join(targetHome, "thread_history_1.sqlite"),
    );
  const unrelatedId = "01900000-0000-7000-8000-000000000009";
  state.row("threads", {
    id: unrelatedId,
    rollout_path: path.join(f.base, "unrelated-current-target.jsonl"),
    title: "Preserve current target metadata",
    model: "unrelated-target-model",
    model_provider: "unrelated-target-provider",
    approval_mode: "never",
    sandbox_policy: '{"type":"read-only"}',
  });
  const stateColumns = nativeProfile.databases
    .find((db) => db.file === "state_5.sqlite")
    .tables.find((table) => table.name === "threads")
    .columns.map((column) => column.name);
  const unrelatedBefore = readTypedSqliteRows(state.db, "threads", stateColumns, {
    where: 'WHERE "id" = ?',
    parameters: [unrelatedId],
  });
  state.close();
  history.close();
  const currentSandbox = process.env.LODE_NATIVE_CODEX_TEST_SANDBOX || "read-only";
  assert(["read-only", "workspace-write", "danger-full-access"].includes(currentSandbox));
  const currentModel = "offline-target-probe-do-not-run",
    currentProvider = "lode_offline_target_probe";
  fs.writeFileSync(
    path.join(targetHome, "config.toml"),
    'cli_auth_credentials_store = "file"\nmcp_oauth_credentials_store = "file"\nmodel_provider = "' +
      currentProvider +
      '"\nmodel = "' +
      currentModel +
      '"\nmodel_reasoning_effort = "low"\napproval_policy = "never"\nsandbox_mode = ' +
      JSON.stringify(currentSandbox) +
      "\n[model_providers." +
      currentProvider +
      ']\nname = "Offline metadata fixture"\nbase_url = "http://127.0.0.1:9"\nwire_api = "responses"\nrequires_openai_auth = false\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n',
  );
  const complexWorkspace =
    currentSandbox === "workspace-write" &&
    process.env.LODE_NATIVE_CODEX_TEST_WORKSPACE_OPTIONS !== "minimal";
  if (complexWorkspace) {
    const extra = path.join(f.base, "extra-current-writable-root");
    fs.mkdirSync(extra);
    fs.appendFileSync(
      path.join(targetHome, "config.toml"),
      "\n[sandbox_workspace_write]\nwritable_roots = [" +
        JSON.stringify(extra) +
        "]\nnetwork_access = true\nexclude_tmpdir_env_var = true\nexclude_slash_tmp = true\n",
    );
  }
  const targetOffline = await prepareCodexNativeOffline({
    home: targetHome,
    executable,
    probe: observer,
  });
  await publishCodexNativeHistory({
    witness: targetOffline.witness,
    directory: captured.directory,
  });
  const home = path.dirname(targetHome),
    environment = {
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      PATH: process.env.PATH,
      TEMP: path.join(home, "temp"),
      TMP: path.join(home, "temp"),
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: targetHome,
      APPDATA: path.join(home, "roaming"),
      LOCALAPPDATA: path.join(home, "local"),
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_STATE_HOME: path.join(home, "state"),
    };
  for (const value of Object.values(environment))
    if (typeof value === "string" && value.startsWith(home))
      fs.mkdirSync(value, { recursive: true });
  const events = [],
    selection = resolveVerifiedProcessSupervisor({ pluginRoot: supervisorRoot });
  const registered = await registerCodexNativeHistory({
    witness: targetOffline.witness,
    directory: captured.directory,
    cwd: runtimeRoot,
    environment,
    supervisorSelection: selection,
    controlFile: path.join(f.base, "sdk-host-supervisor.control.jsonl"),
    onEvent: (event) => events.push(event),
  });
  if (currentSandbox === "workspace-write") {
    assert.equal(registered.status, "native-registration-incomplete", JSON.stringify(registered));
    assert.equal(
      registered.results[0].primaryFailure.code,
      "NATIVE_CODEX_WORKSPACE_POLICY_PROFILE_UNVERIFIED",
    );
    assert.equal(registered.sdkLifecycleRequestedThisCall, true);
    assert.equal(registered.sdkMayHaveChangedMetadataThisCall, true);
    assert.equal(registered.explicitResumeRequestedThisCall, false);
    assert.equal(registered.continuationReady, false);
    assert.equal(registered.ordinaryCoreBlocked, false);
    assert(!events.some((event) => event.method === "turn/start"));
    assert(events.some((event) => event.event === "closed"));
    assert.deepEqual(
      fs.readFileSync(path.join(targetHome, relative)).subarray(0, rawSource.length),
      rawSource,
    );
    console.log(
      JSON.stringify({
        event: "exact-native-policy-counterexample",
        actualSdk: true,
        currentSandbox,
        complexWorkspace,
        policyEquivalence: "not-verified",
        supportedCombination: false,
        modelMethodSent: false,
        cleanupClosed: true,
        ports: [],
      }),
    );
    assert(!events.some((event) => event.method === "thread/resume"));
    return;
  }
  assert.equal(registered.status, "native-registered-read-verified", JSON.stringify(registered));
  assert.equal(registered.continuationReady, false);
  assert.equal(registered.currentInstructionBinding, "not-verified");
  assert.equal(events.filter((event) => event.method === "thread/resume").length, 1);
  const journalBefore = snapshot(path.join(targetHome, ".lode-native-portability"));
  const registeredAgain = await registerCodexNativeHistory({
    witness: targetOffline.witness,
    directory: captured.directory,
    cwd: runtimeRoot,
    environment,
    supervisorSelection: selection,
    controlFile: path.join(f.base, "sdk-host-readback.control.jsonl"),
    onEvent: (event) => events.push(event),
  });
  assert.equal(registeredAgain.status, "native-registered-read-verified");
  assert.equal(events.filter((event) => event.method === "thread/resume").length, 1);
  assert.deepEqual(snapshot(path.join(targetHome, ".lode-native-portability")), journalBefore);
  const rpc = await openCodexNativeRegistrationRpc({
    witness: targetOffline.witness,
    supervisorSelection: selection,
    controlFile: path.join(f.base, "sdk-supervisor.control.jsonl"),
    cwd: runtimeRoot,
    environment,
    nativeThreads: [{ threadId: original.threadId, path: relative }],
    onEvent: (event) => events.push(event),
  });
  let cleanup;
  try {
    await assert.rejects(rpc.request("turn/start", { threadId: original.threadId, input: [] }), {
      code: "NATIVE_CODEX_RPC_METHOD_NOT_ALLOWED",
    });
    const config = await rpc.request("config/read", { cwd: runtimeRoot, includeLayers: false });
    assert.equal(config.config.model, currentModel);
    assert.equal(config.config.model_provider, currentProvider);
    const params = {
      threadId: original.threadId,
      path: path.join(targetHome, relative),
      cwd: runtimeRoot,
      runtimeWorkspaceRoots: [runtimeRoot],
      model: config.config.model,
      modelProvider: config.config.model_provider,
      sandbox: config.config.sandbox_mode,
      approvalPolicy: config.config.approval_policy,
      config: { model_reasoning_effort: config.config.model_reasoning_effort },
      excludeTurns: true,
    };
    await assert.rejects(
      rpc.request("thread/resume", {
        ...params,
        baseInstructions: "Never send source prompt as target override",
      }),
      { code: "NATIVE_CODEX_RPC_PARAMS_MISMATCH" },
    );
    const metadata = await rpc.request("thread/read", {
      threadId: original.threadId,
      includeTurns: false,
    });
    assert.equal(metadata.thread.id, original.threadId);
    const turns = await rpc.request("thread/turns/list", {
      threadId: original.threadId,
      limit: 1,
      itemsView: "full",
    });
    assert.equal(turns.data.length, 1);
    const items = [];
    let cursor = null,
      pages = 0;
    do {
      const page = await rpc.request("thread/items/list", {
        threadId: original.threadId,
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      items.push(...page.data);
      cursor = page.nextCursor;
      assert(++pages <= 4);
    } while (cursor);
    assert.equal(items.length, 2);
    assert.equal(pages, 2);
    assert.equal(original.sourceOracle, "source-policy-api-oracle-v1.json");
    const sourceOracle = JSON.parse(
      fs.readFileSync(path.join(path.dirname(captureFile), "source-policy-api-oracle-v1.json")),
    );
    assert.deepEqual(turns.data, sourceOracle.result.turns.data);
    assert.deepEqual(
      items,
      sourceOracle.result.pages.flatMap((page) => page.data),
    );
    assert.deepEqual(
      fs.readFileSync(path.join(targetHome, relative)).subarray(0, rawSource.length),
      rawSource,
    );
    assert(
      !events.some(
        (event) =>
          event.method === "turn/start" ||
          event.method === "account/read" ||
          event.method === "model/list",
      ),
    );
    await rpc.request("thread/unsubscribe", { threadId: original.threadId });
  } finally {
    cleanup = await rpc.close();
  }
  assert.equal(cleanup.cleanup.treeCleanupVerified, true);
  assert.equal(cleanup.modelCallAttempted, false);
  assert.equal(rpc.inspect().closed, true);
  const stateAfter = new DatabaseSync(nativeSqlitePath(path.join(targetHome, "state_5.sqlite")), {
    readOnly: true,
  });
  try {
    const selectedState = stateAfter
      .prepare(
        "SELECT model,model_provider,reasoning_effort,approval_mode,cwd FROM threads WHERE id=?",
      )
      .get(original.threadId);
    assert.equal(selectedState.model, currentModel);
    assert.equal(selectedState.model_provider, currentProvider);
    assert.equal(selectedState.reasoning_effort, "low");
    assert.equal(selectedState.approval_mode, "never");
    assert.equal(nativeSqlitePath(selectedState.cwd), nativeSqlitePath(runtimeRoot));
    assert.equal(registered.localBeforeBackups.length, 1);
    assert(
      registered.localBeforeBackups[0].path.startsWith(".lode-native-portability/before-state/"),
    );
    assert.deepEqual(
      readTypedSqliteRows(stateAfter, "threads", stateColumns, {
        where: 'WHERE "id" = ?',
        parameters: [unrelatedId],
      }),
      unrelatedBefore,
    );
  } finally {
    stateAfter.close();
  }
  // A lost/denied operation after initialize must not make the next call start
  // a second SDK merely because its automatic discovery created a state row.
  const uncertainHome = path.join(f.base, "sdk-uncertain/home/codex"),
    uncertainRoot = path.join(f.base, "sdk-uncertain/workspace");
  fs.mkdirSync(uncertainHome, { recursive: true });
  fs.mkdirSync(uncertainRoot);
  const uncertainState = syntheticNativeDatabase(
      t,
      "state_5.sqlite",
      path.join(uncertainHome, "state_5.sqlite"),
    ),
    uncertainHistory = syntheticNativeDatabase(
      t,
      "thread_history_1.sqlite",
      path.join(uncertainHome, "thread_history_1.sqlite"),
    );
  uncertainState.close();
  uncertainHistory.close();
  fs.copyFileSync(path.join(targetHome, "config.toml"), path.join(uncertainHome, "config.toml"));
  const uncertainOffline = await prepareCodexNativeOffline({
    home: uncertainHome,
    executable,
    probe: observer,
  });
  await publishCodexNativeHistory({
    witness: uncertainOffline.witness,
    directory: captured.directory,
  });
  const uncertainBase = path.dirname(uncertainHome),
    uncertainEnvironment = Object.fromEntries(
      Object.entries(environment).map(([key, value]) => [
        key,
        typeof value === "string" && value.startsWith(home)
          ? uncertainBase + value.slice(home.length)
          : value,
      ]),
    );
  for (const value of Object.values(uncertainEnvironment))
    if (typeof value === "string" && value.startsWith(uncertainBase))
      fs.mkdirSync(value, { recursive: true });
  let stopAfterConfig = false;
  const uncertainEvents = [];
  const uncertain = await registerCodexNativeHistory({
    witness: uncertainOffline.witness,
    directory: captured.directory,
    cwd: uncertainRoot,
    environment: uncertainEnvironment,
    supervisorSelection: selection,
    controlFile: path.join(f.base, "sdk-uncertain.control.jsonl"),
    onEvent(event) {
      uncertainEvents.push(event);
      if (event.method === "config/read") stopAfterConfig = true;
    },
    assertCurrentAuthority() {
      if (stopAfterConfig)
        throw Object.assign(Error("Synthetic current permission changed"), {
          code: "SYNTHETIC_PERMISSION_CHANGED",
        });
    },
  });
  assert.equal(uncertain.status, "native-registration-incomplete");
  assert.equal(uncertain.results[0].primaryFailure.code, "SYNTHETIC_PERMISSION_CHANGED");
  const plannedBefore = uncertainEvents.filter((event) => event.event === "planned").length;
  const retried = await registerCodexNativeHistory({
    witness: uncertainOffline.witness,
    directory: captured.directory,
    cwd: uncertainRoot,
    environment: uncertainEnvironment,
    supervisorSelection: selection,
    controlFile: path.join(f.base, "sdk-uncertain-read.control.jsonl"),
    onEvent: (event) => uncertainEvents.push(event),
  });
  assert.equal(retried.results[0].status, "native-registration-uncertain");
  assert.equal(retried.results[0].verificationFreshness, "no-completed-sdk-view");
  assert.equal(uncertainEvents.filter((event) => event.event === "planned").length, plannedBefore);
  assert(!uncertainEvents.some((event) => event.method === "thread/resume"));
  console.log(
    JSON.stringify({
      event: "exact-native-metadata-integration",
      actualSdk: true,
      currentSandbox,
      offlineObservation: "protocol-fixture-not-OS-positive",
      modelMethodSent: false,
      registeredReadVerified: true,
      continuationReady: false,
      currentInstructionBinding: "not-verified",
      cleanupVerified: true,
      ports: [],
    }),
  );
});

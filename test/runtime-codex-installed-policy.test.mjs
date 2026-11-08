import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectCodexInstalledPolicySnapshot } from "../scripts/lib/runtime-codex-installed-policy.mjs";
import {
  inspectCodexNativeForkCandidate,
  inspectCurrentCodexNativeForkCompatibility,
  assertCodexInstalledForkRequest,
} from "../scripts/lib/runtime-codex-fork-compatibility.mjs";

test("native candidate checks known source restrictions without claiming enforcement", () => {
  const current = inspectCurrentCodexNativeForkCompatibility();
  assert.equal(current.apiCandidate, false);
  assert.equal(current.knownApiConflicts.length, 4);
  for (const [params, historyMode] of [
    [{ ephemeral: true, deferGoalContinuation: true }, "legacy"],
    [{ ephemeral: true, excludeTurns: false }, "paginated"],
    [{ lastTurnId: "a", beforeTurnId: "b" }, "legacy"],
    [{ permissions: "read", sandbox: "read-only" }, "legacy"],
  ])
    assert.throws(() => assertCodexInstalledForkRequest(params, historyMode), { code: "CODEX_NATIVE_FORK_API_CONFLICT" });
  for (const sourceHistoryMode of ["legacy", "paginated"]) {
    const candidate = inspectCodexNativeForkCandidate({
      forkParams: { ephemeral: true, excludeTurns: sourceHistoryMode === "paginated" },
      sourceHistoryMode,
      goalsEnabled: false,
    });
    assert.equal(candidate.apiCandidate, true);
    assert.equal(candidate.enforcementVerified, false);
    assert.equal(candidate.capabilityIssued, false);
    // Removing defer cannot fix the old post-fork sequence.
    const unchanged = inspectCodexNativeForkCandidate({
      forkParams: { ephemeral: true, excludeTurns: true },
      sourceHistoryMode,
      goalsEnabled: false,
      requiresChildHistoryRead: true,
      requiresGoalReadOrClear: true,
    });
    assert.equal(unchanged.knownApiConflicts.length, 3);
  }
  const durable = inspectCodexNativeForkCandidate({
    forkParams: { ephemeral: false, deferGoalContinuation: true },
    goalsEnabled: true,
    requiresChildHistoryRead: true,
    requiresGoalReadOrClear: true,
  });
  assert.equal(durable.apiCandidate, true);
  assert.equal(durable.capabilityIssued, false, "API compatibility does not authorize new persistence");
});
import {
  buildCodexWorkerPolicyPlan,
  verifyCodexWorkerPolicyPlan,
  inspectCodexWorkerPolicyCapability,
  CODEX_WORKER_REQUIRED_ENFORCEMENT,
} from "../scripts/lib/runtime-codex-worker-policy.mjs";

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));
console.log(
  JSON.stringify({
    event: "owned-codex-installed-policy-tests",
    pid: process.pid,
    parentPid: process.ppid,
    command: process.execPath,
    args: process.argv.slice(1),
    cwd: process.cwd(),
    ports: [],
    actualProviderInvoked: false,
  }),
);

function plan(options = {}) {
  return buildCodexWorkerPolicyPlan({
    executablePath: process.execPath,
    executableDigest: hash("synthetic-identity-only"),
    model: "openai/gpt-5.6-sol",
    wireModel: "gpt-5.6-sol",
    wireModelProvider: "openai",
    ...options,
  });
}

function fixture(t) {
  const parent = fs.realpathSync(process.env.LODE_AGENT_TEST_TMP || process.env.HEAD_AGENT_TEST_TMP || os.tmpdir());
  const directory = fs.mkdtempSync(path.join(parent, "head-codex-installed-policy-"));
  const schemaDirectory = path.join(directory, "schemas");
  fs.mkdirSync(path.join(schemaDirectory, "v2"), { recursive: true });
  const schemaFiles = [
    "PermissionsRequestApprovalParams.json",
    ...[
      "CommandExecParams",
      "CommandExecResponse",
      "WindowsSandboxReadinessResponse",
      "PermissionProfileListResponse",
      "ThreadStartParams",
      "ThreadStartResponse",
      "ConfigRequirementsReadResponse",
      "ConfigReadResponse",
      "AppsInstalledResponse",
      "ListMcpServerStatusResponse",
      "CommandExecTerminateParams",
      "ProcessSpawnParams",
    ].map((file) => `v2/${file}.json`),
  ];
  for (const file of schemaFiles) fs.writeFileSync(path.join(schemaDirectory, file), "{}");
  const executablePath = path.join(directory, "synthetic-codex.exe");
  const executableBytes = "Never executed. Synthetic identity is not an installed backend.";
  fs.writeFileSync(executablePath, executableBytes);
  const execHelpFile = path.join(directory, "exec-help.txt");
  fs.writeFileSync(execHelpFile, "--ignore-user-config\n--ignore-rules\nSynthetic help is not enforcement proof.\n");
  const options = { executablePath, schemaDirectory, execHelpFile };
  t.after(() => {
    assert.equal(path.dirname(directory), parent);
    assert.match(path.basename(directory), /^head-codex-installed-policy-/u);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    ...options,
    directory,
    schemaFiles,
    executableDigest: hash(executableBytes),
    inspect: (extra) => inspectCodexInstalledPolicySnapshot({ ...options, ...extra }),
  };
}

test("0.2 plan binds the actor scope and denies automatic trusted-substrate exemptions", () => {
  const selected = plan();
  assert.equal(selected.protocolVersion, "0.2.0");
  assert.equal(selected.policyScope.taskData, "model-visible-task-data");
  assert.equal(selected.policyScope.effects, "model-callable-tools-and-their-effects");
  assert.equal(selected.policyScope.instructions, "additional-configured-or-inherited-instructions");
  assert.equal(selected.policyScope.providerBaselineInstructions, "provider-owned-not-a-zero-semantic-influence-claim");
  assert.deepEqual(selected.policyScope.trustedSubstrate, {
    actor: "trusted-p5-host-and-provider-runtime",
    purposes: ["os-runtime", "provider-runtime", "provider-authentication"],
    automaticExemptions: false,
    exactHostVerifiedConstraintsRequired: true,
    mayExposeUnselectedTaskData: false,
    mayExposeProviderCredentialsToModelOrTools: false,
  });
  assert.deepEqual(selected.requiredEnforcement, CODEX_WORKER_REQUIRED_ENFORCEMENT);
  assert.equal(selected.enforcementVerified, false);
  assert.equal(Object.hasOwn(selected, "actualProviderInvoked"), false);
  assert.ok(Object.isFrozen(selected.policyScope.trustedSubstrate.purposes));
  assert.deepEqual(verifyCodexWorkerPolicyPlan(selected), selected);
  const fork = plan({ mode: "native-fork", retainedContextDigest: hash("retained exact prefix"), workspaceMode: "workspace-write" });
  assert.deepEqual(fork.policyScope, selected.policyScope);
  assert.equal(fork.invocationConstraints.writes, "exact-owned-model-callable-writes-only");
});

test("historical 0.1 policy identity is rejected, not upgraded or silently reinterpreted", () => {
  const historical = clone(plan());
  historical.protocolVersion = "0.1.0";
  delete historical.policyScope;
  historical.invocationConstraints.reads = "selected-inputs-only";
  historical.invocationConstraints.writes = "none";
  historical.invocationConstraints.network = "provider-transport-only";
  historical.invocationConstraints.instructions = "authorized-instructions-only";
  historical.invocationConstraints.tools = "exact-host-verified-scope";
  const before = JSON.stringify(historical);
  assert.throws(() => verifyCodexWorkerPolicyPlan(historical), { code: "INVALID_CODEX_WORKER_POLICY" });
  assert.equal(JSON.stringify(historical), before);
  historical.protocolVersion = "0.2.0";
  assert.throws(() => verifyCodexWorkerPolicyPlan(historical), { code: "INVALID_CODEX_WORKER_POLICY" });
});

test("scope/exception changes cannot reuse the exact 0.2 plan", () => {
  for (const modify of [
    (item) => {
      delete item.policyScope;
    },
    (item) => {
      item.policyScope.taskData = "all-host-process-files";
    },
    (item) => {
      item.policyScope.trustedSubstrate.automaticExemptions = true;
    },
    (item) => {
      item.policyScope.trustedSubstrate.exactHostVerifiedConstraintsRequired = false;
    },
    (item) => {
      item.policyScope.trustedSubstrate.mayExposeUnselectedTaskData = true;
    },
    (item) => {
      item.policyScope.trustedSubstrate.mayExposeProviderCredentialsToModelOrTools = true;
    },
    (item) => {
      item.policyScope.trustedSubstrate.purposes.push("all-local-task-data");
    },
    (item) => {
      item.policyScope.providerBaselineInstructions = "all-extra-instructions-allowed";
    },
    (item) => {
      item.invocationConstraints.tools = "all-tools";
    },
  ]) {
    const changed = clone(plan());
    modify(changed);
    assert.throws(() => verifyCodexWorkerPolicyPlan(changed), { code: "INVALID_CODEX_WORKER_POLICY" });
  }
});

test("synthetic schema controls and help never become an installed enforcement capability", (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    path.join(f.schemaDirectory, "PermissionsRequestApprovalParams.json"),
    JSON.stringify({
      definitions: { FileSystemAccessMode: { enum: ["read", "write", "deny"] } },
      enforcementAvailable: true,
      effectivePolicy: "a fabricated field is not proof",
    }),
  );
  const before = fs.readdirSync(f.directory, { recursive: true });
  const diagnostic = f.inspect();
  assert.equal(diagnostic.kind, "CodexInstalledPolicyDiagnostic");
  assert.equal(diagnostic.backendStatus, "missing-backend");
  assert.equal(diagnostic.enforcementAvailable, false);
  assert.equal(diagnostic.capabilityIssued, false);
  assert.equal(diagnostic.actualProviderInvoked, false);
  assert.equal(diagnostic.audit.status, "requires-new-snapshot-audit");
  assert.equal(diagnostic.setup.status, "not-probed");
  assert.deepEqual(
    diagnostic.obligations.map((row) => row.id),
    CODEX_WORKER_REQUIRED_ENFORCEMENT,
  );
  assert.equal(diagnostic.obligations.find((row) => row.id === "outside-root-denials").controls[0].present, true);
  assert.ok(diagnostic.obligations.every((row) => !row.enforcementVerified && !row.osSetupAloneSufficient));
  assert.ok(diagnostic.obligations.every((row) => row.apiObservation === "requires-new-snapshot-audit"));
  assert.equal(diagnostic.execHelp.ignoreUserConfigDocumented, true);
  assert.equal(diagnostic.execHelp.ignoreRulesDocumented, true);
  assert.ok(Object.isFrozen(diagnostic.obligations[0].controls));
  assert.throws(() => inspectCodexWorkerPolicyCapability(diagnostic), { code: "WORKER_JOB_POLICY_UNAVAILABLE" });
  assert.deepEqual(fs.readdirSync(f.directory, { recursive: true }), before);
});

test("retained readiness distinguishes setup requirements from enforcement and unknown current state", (t) => {
  const f = fixture(t);
  const observation = { observedAt: "2026-09-22T18:00:00.000Z", executableDigest: f.executableDigest };
  for (const status of ["notConfigured", "updateRequired", "ready"]) {
    const diagnostic = f.inspect({ windowsReadinessObservation: { ...observation, status } });
    assert.equal(diagnostic.setup.status, status === "ready" ? "ready-observed-not-enforced" : "setupRequired");
    assert.equal(diagnostic.setup.source, "caller-supplied-retained-observation-not-current-state");
    assert.equal(diagnostic.setup.enforcementEvidence, false);
    assert.equal(diagnostic.enforcementAvailable, false);
  }
  const changed = f.inspect({ windowsReadinessObservation: { ...observation, status: "ready", executableDigest: "a".repeat(64) } });
  assert.equal(changed.setup.status, "unbound-observation");
  assert.throws(() => f.inspect({ windowsReadinessObservation: { ...observation, status: "ready", enforced: true } }), {
    code: "INVALID_CODEX_INSTALLED_POLICY_SNAPSHOT",
  });
});

test("malformed, oversized and linked snapshot files fail closed without runtime admission", (t) => {
  const f = fixture(t);
  const file = path.join(f.schemaDirectory, "v2", "CommandExecParams.json");
  fs.writeFileSync(file, "not JSON");
  assert.throws(() => f.inspect(), { code: "INVALID_CODEX_INSTALLED_POLICY_SNAPSHOT" });
  fs.writeFileSync(file, "null");
  assert.throws(() => f.inspect(), { code: "INVALID_CODEX_INSTALLED_POLICY_SNAPSHOT" });
  fs.truncateSync(file, 8 * 1024 * 1024 + 1);
  assert.throws(() => f.inspect(), { code: "INVALID_CODEX_INSTALLED_POLICY_SNAPSHOT" });
  fs.writeFileSync(file, "{}");
  fs.linkSync(file, path.join(f.directory, "linked-schema.json"));
  assert.throws(() => f.inspect(), { code: "INVALID_CODEX_INSTALLED_POLICY_SNAPSHOT" });
  assert.throws(() => f.inspect({ schemaDirectory: "relative-schema-root" }), { code: "INVALID_CODEX_INSTALLED_POLICY_SNAPSHOT" });
});

const installedDirectory = process.env.LODE_AGENT_CODEX_INSTALLED_POLICY_SCHEMA_DIRECTORY || process.env.HEAD_AGENT_CODEX_INSTALLED_POLICY_SCHEMA_DIRECTORY;
const installedExecutable = process.env.LODE_AGENT_CODEX_INSTALLED_POLICY_EXECUTABLE || process.env.HEAD_AGENT_CODEX_INSTALLED_POLICY_EXECUTABLE;
test(
  "optional developer preflight recognizes retained installed bytes but still issues no proof",
  {
    skip: !installedDirectory || !installedExecutable,
  },
  () => {
    const diagnostic = inspectCodexInstalledPolicySnapshot({
      schemaDirectory: installedDirectory,
      executablePath: installedExecutable,
      execHelpFile: process.env.LODE_AGENT_CODEX_INSTALLED_POLICY_EXEC_HELP || process.env.HEAD_AGENT_CODEX_INSTALLED_POLICY_EXEC_HELP,
    });
    assert.equal(diagnostic.audit.status, "recognized-retained-schema-snapshot");
    assert.ok(diagnostic.obligations.every((row) => row.controls.every((control) => control.present)));
    assert.ok(diagnostic.obligations.every((row) => row.apiObservation === "not-established-by-installed-api"));
    assert.equal(diagnostic.enforcementAvailable, false);
    assert.equal(diagnostic.backendStatus, "missing-backend");
    assert.equal(diagnostic.capabilityIssued, false);
    assert.equal(diagnostic.nativeFork.apiCandidate, false);
    assert.equal(diagnostic.nativeFork.knownApiConflicts.length, 4);
    console.log(JSON.stringify({ event: "installed-policy-read-only-diagnostic", diagnostic }));
  },
);

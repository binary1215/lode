#!/usr/bin/env node
// Runs the README first-request flow on synthetic Git projects, once through
// the CLI and once through MCP, and checks that both surfaces return the same
// status, reasonCode and nextAction.id at every step, that the two conversation
// entry states listed below hold, and that every value seen is documented
// somewhere in README, docs/ or skills/ (a coverage check, not a wording check).
//
//   node scripts/verify-documented-flow.mjs
//
// Flow: conversation entry before init -> init (core) -> conversation entry ->
// graph query -> checkpoint basis/sync -> compact prepare/verify/continue ->
// session restore. A third synthetic project runs the verified MCP save (Codex
// thread route): init, entry, then one id-less checkpoint sync. Nothing outside
// the temporary projects and one temporary Host-state directory is written.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function syntheticProject(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `lode-documented-flow-${label}-`));
  fs.writeFileSync(path.join(root, "login.mjs"), "export function login(user) {\n  return Boolean(user);\n}\n");
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=flow@example.invalid", "-c", "user.name=flow", "commit", "-qm", "init");
  return root;
}

const recovery = {
  purpose: "Fix the login failure",
  approvedDecisions: ["Keep the existing login contract"],
  currentPosition: "Cause identified; fix pending",
  nextExpectedResult: "Login regression test passes",
};

// One step per documented call; `cli` and `mcp` receive the previous results.
const STEPS = [
  { id: "conversation-enter-before-init", cli: () => ["conversation-enter"], mcp: () => ["lode_conversation_enter", {}] },
  { id: "init-core", cli: () => ["init", "--profile", "core"], mcp: () => ["lode_project_initialize_or_resume", { profile: "core" }] },
  { id: "conversation-enter", cli: () => ["conversation-enter"], mcp: () => ["lode_conversation_enter", {}] },
  { id: "graph-query", cli: () => ["graph-query", "--query", "login"], mcp: () => ["lode_project_graph", { query: "login" }] },
  { id: "checkpoint-basis", cli: () => ["checkpoint-basis"], mcp: () => ["lode_checkpoint_basis", {}] },
  {
    id: "checkpoint-sync",
    cli: (prior, file) => ["checkpoint-sync", "--input", file({ expectedRecoveryBasisId: prior["checkpoint-basis"].basis.basisId, ...recovery })],
    mcp: (prior) => [
      "lode_checkpoint_sync",
      {
        expected_recovery_basis_id: prior["checkpoint-basis"].basis.basisId,
        purpose: recovery.purpose,
        approved_decisions: recovery.approvedDecisions,
        current_position: recovery.currentPosition,
        next_expected_result: recovery.nextExpectedResult,
      },
    ],
  },
  {
    id: "compact-prepare",
    cli: (prior, file) => ["compact-prepare", "--input", file({ runtime: "codex", userTurnIdAtPrepare: 7, ...recovery, openReviewIds: [] })],
    mcp: () => [
      "lode_compact_prepare",
      {
        runtime: "codex",
        user_turn_id_at_prepare: 7,
        purpose: recovery.purpose,
        approved_decisions: recovery.approvedDecisions,
        current_position: recovery.currentPosition,
        next_expected_result: recovery.nextExpectedResult,
        open_review_ids: [],
      },
    ],
  },
  {
    id: "compact-verify",
    cli: (prior, file) => [
      "compact-verify",
      "--input",
      file({
        epochId: prior["compact-prepare"].epoch.epochId,
        checkpointDigest: prior["compact-prepare"].checkpoint.checkpointDigest,
        currentUserTurnId: 7,
        providerCompacted: true,
      }),
    ],
    mcp: (prior) => [
      "lode_compact_verify",
      {
        epoch_id: prior["compact-prepare"].epoch.epochId,
        checkpoint_digest: prior["compact-prepare"].checkpoint.checkpointDigest,
        current_user_turn_id: 7,
        provider_compacted: true,
      },
    ],
  },
  {
    id: "compact-continue",
    cli: (prior, file) => [
      "compact-continue",
      "--input",
      file({ epochId: prior["compact-prepare"].epoch.epochId, continuationToken: prior["compact-prepare"].continuationToken, currentUserTurnId: 7 }),
    ],
    mcp: (prior) => [
      "lode_compact_continue",
      { epoch_id: prior["compact-prepare"].epoch.epochId, continuation_token: prior["compact-prepare"].continuationToken, current_user_turn_id: 7 },
    ],
  },
  { id: "session-restore", cli: () => ["session-restore"], mcp: () => ["lode_session_restore", {}] },
];

// Expected conversation entry states for this flow.
const EXPECTED_ENTRY_STATES = {
  "conversation-enter-before-init": { status: "conversation_recovery_unavailable", reasonCode: "NOT_INITIALIZED" },
  "conversation-enter": { status: "conversation_ready" },
};

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const summary = (value) => ({ status: value?.status ?? null, reasonCode: value?.reasonCode ?? null, nextAction: value?.nextAction?.id ?? null });

async function runCli(root, workDirectory) {
  const { runCommand } = await import("./lode.mjs");
  const results = {};
  let files = 0;
  const file = (value) => {
    const target = path.join(workDirectory, `cli-input-${++files}.json`);
    fs.writeFileSync(target, JSON.stringify(value));
    return target;
  };
  for (const step of STEPS) {
    const [command, ...rest] = step.cli(results, file);
    results[step.id] = await runCommand([command, root, ...rest]);
  }
  return results;
}

// The MCP save path of a caller the Host verified (Codex thread route): initialize,
// enter, then one lode_checkpoint_sync without expected_recovery_basis_id. The CLI
// and unverified MCP paths above keep the two-call save (basis, then sync).
async function runVerifiedMcpSave(root) {
  // Host-local state lives outside the Project, as for an installed plugin.
  const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lode-documented-flow-host-"));
  const { dispatch } = await import("./mcp-server.mjs");
  const { createNativeSessionHostBridge } = await import("./lib/session/session-native-host.mjs");
  const bridge = createNativeSessionHostBridge({
    runtime: "codex",
    // Only the Host state root: nothing from the ambient environment reaches it.
    environment: { HEAD_AGENT_OPERATIONAL_STATE_ROOT: hostRoot },
  });
  const call = async (name, args) => {
    const response = await dispatch(
      { jsonrpc: "2.0", id: name, method: "tools/call", params: { _meta: { threadId: "documented-flow" }, name, arguments: { project_root: root, ...args } } },
      { nativeSessionBridge: bridge },
    );
    if (response.error) throw Object.assign(new Error(`verified ${name}: ${response.error.message}`), { code: response.error.data?.reasonCode });
    return response.result.structuredContent;
  };
  try {
    await call("lode_project_initialize_or_resume", { profile: "core" });
    await call("lode_conversation_enter", {});
    const saved = await call("lode_checkpoint_sync", {
      purpose: recovery.purpose,
      approved_decisions: recovery.approvedDecisions,
      current_position: recovery.currentPosition,
      next_expected_result: recovery.nextExpectedResult,
    });
    assert.equal(saved.outcome, "created", `a verified caller saves in one call after entry: ${JSON.stringify(saved).slice(0, 400)}`);
    return { calls: 3, saveCalls: 1, outcome: saved.outcome };
  } finally {
    bridge.dispose();
    fs.rmSync(hostRoot, { recursive: true, force: true });
  }
}

async function runMcp(root) {
  const { dispatch } = await import("./mcp-server.mjs");
  const results = {};
  let id = 0;
  for (const step of STEPS) {
    const [name, args] = step.mcp(results);
    const response = await dispatch({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: { project_root: root, ...args } } });
    if (response.error) throw Object.assign(new Error(`${step.id}: ${response.error.message}`), { code: response.error.data?.reasonCode });
    results[step.id] = response.result.structuredContent ?? JSON.parse(response.result.content[0].text);
  }
  return results;
}

function documentationText() {
  const files = [path.join(pluginRoot, "README.md")];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith(".md")) files.push(file);
    }
  };
  walk(path.join(pluginRoot, "docs"));
  walk(path.join(pluginRoot, "skills"));
  return files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
}

export async function verifyDocumentedFlow() {
  const cliRoot = syntheticProject("cli");
  const mcpRoot = syntheticProject("mcp");
  const verifiedRoot = syntheticProject("verified");
  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "lode-documented-flow-input-"));
  try {
    const cli = await runCli(cliRoot, workDirectory);
    const mcp = await runMcp(mcpRoot);
    const steps = STEPS.map((step) => ({ id: step.id, cli: summary(cli[step.id]), mcp: summary(mcp[step.id]) }));
    for (const step of steps) assert.deepEqual(step.mcp, step.cli, `${step.id}: CLI and MCP differ`);
    for (const [id, expected] of Object.entries(EXPECTED_ENTRY_STATES)) {
      const actual = steps.find((step) => step.id === id).cli;
      for (const [field, value] of Object.entries(expected)) assert.equal(actual[field], value, `${id}.${field}`);
    }
    const docs = documentationText();
    const undocumented = [
      ...new Set(
        steps.flatMap((step) => Object.values(step.cli)).filter((value) => typeof value === "string" && !new RegExp(`\\b${escapeRegExp(value)}\\b`).test(docs)),
      ),
    ];
    assert.deepEqual(
      undocumented,
      [],
      `status/reasonCode/nextAction values missing from README, docs/ and skills/: ${JSON.stringify(steps.map(({ id, cli: values }) => ({ id, ...values })))}`,
    );
    const verifiedSave = await runVerifiedMcpSave(verifiedRoot);
    return {
      status: "documented_flow_verified",
      surfaces: ["cli", "mcp"],
      steps: steps.map(({ id, cli: values }) => ({ id, ...values })),
      verifiedMcpSave: verifiedSave,
    };
  } finally {
    for (const directory of [cliRoot, mcpRoot, verifiedRoot, workDirectory]) fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(await verifyDocumentedFlow(), null, 2)}\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "failed", code: error.code ?? null, message: error.message })}\n`);
    process.exit(1);
  }
}

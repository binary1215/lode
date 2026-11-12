import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildCodexFreshProposalPolicyPlan,
  verifyCodexFreshProposalPolicyPlan,
  codexFreshProposalStartupArguments,
  codexFreshProposalThreadParams,
  codexFreshProposalTurnParams,
  assertCodexFreshProposalEffectiveConfig,
  assertCodexFreshProposalSkills,
  codexFreshProposalEnvironment,
  assertCodexFreshProposalInstructionSources,
} from "../scripts/lib/runtime/runtime-codex-proposal-policy.mjs";

const copy = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
function fixture(t, options = {}) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(process.env.LODE_AGENT_TEST_TMP || process.env.HEAD_AGENT_TEST_TMP || os.tmpdir(), "head-proposal-policy-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "home");
  fs.mkdirSync(codexHome);
  return {
    root,
    codexHome,
    policy: buildCodexFreshProposalPolicyPlan({ executablePath: fs.realpathSync(process.execPath), codexHome, evidenceMode: "protocol-fixture", ...options }),
  };
}

test("fresh proposal plan is explicitly separate and never a serialized enforcement capability", (t) => {
  const { policy } = fixture(t);
  assert.equal(policy.mode, "fresh-selected-patch-proposal");
  assert.equal(policy.workspaceMode, "read-only");
  assert.equal(policy.enforcementVerified, false);
  assert.deepEqual(verifyCodexFreshProposalPolicyPlan(policy), policy);
  assert.throws(() => verifyCodexFreshProposalPolicyPlan({ ...policy, kind: "CodexWorkerPolicyPlan", protocolVersion: "0.2.0" }));
  for (const field of ["enforcementVerified", "instructionAuthority", "promotionAuthority", "recoveryAuthority"]) {
    assert.throws(() => verifyCodexFreshProposalPolicyPlan({ ...policy, [field]: true }));
  }
});

test("unselected global instructions fail only this optional proposal mode; exact selection binds bytes", (t) => {
  const { codexHome } = fixture(t);
  const file = path.join(codexHome, "AGENTS.md"),
    bytes = "Synthetic worker: retain the selected proposal boundary.\n";
  fs.writeFileSync(file, bytes, { flag: "wx" });
  const options = { executablePath: fs.realpathSync(process.execPath), codexHome, evidenceMode: "protocol-fixture" };
  assert.throws(() => buildCodexFreshProposalPolicyPlan(options), { code: "CODEX_FRESH_PROPOSAL_POLICY_CONFLICT", reason: "unselected-global-instructions" });
  fs.writeFileSync(path.join(codexHome, "AGENTS.override.md"), "\n", { flag: "wx" });
  assert.throws(() => buildCodexFreshProposalPolicyPlan(options), /Unselected global/);
  const approved = { "AGENTS.md": hash(bytes) };
  const selected = buildCodexFreshProposalPolicyPlan({ ...options, approvedGlobalInstructionDigests: approved });
  assert.equal(selected.globalInstructionState[1].selected, true);
  assert.equal(JSON.stringify(selected).includes(bytes.trim()), false);
  fs.writeFileSync(file, "changed synthetic instructions\n");
  assert.throws(() => buildCodexFreshProposalPolicyPlan({ ...options, approvedGlobalInstructionDigests: approved }), /Unselected/);
  assert.deepEqual(verifyCodexFreshProposalPolicyPlan(selected), selected, "historical proof remains readable without current Host state");
});

test("startup controls use real fixed keys and quoted MCP table names, not an empty-table erasure", (t) => {
  const { policy } = fixture(t, { mcpServerNames: ["a.b", "ordinary"] });
  const args = codexFreshProposalStartupArguments(policy);
  assert.deepEqual(args.slice(0, 3), ["app-server", "--listen", "stdio://"]);
  const mcp = args.find((value) => value.startsWith("mcp_servers="));
  assert.match(mcp, /"a\.b"=\{"enabled"=false\}/);
  assert.equal(args.includes("--ignore-user-config"), false);
  assert.equal(policy.startupConfig.features.memories, false);
  assert.equal(policy.startupConfig.features.request_permissions_tool, false);
  assert.equal(Object.hasOwn(policy.startupConfig.features, "memory_tool"), false);
  assert.equal(policy.startupConfig.features.code_mode_host, false);
  assert.deepEqual(policy.startupConfig.notify, []);
  assert.equal(policy.startupConfig.features.hooks, false);
  assert.equal(policy.startupConfig.features.plugins, false);
  assert.equal(policy.startupConfig.skills.bundled.enabled, false);
  assert.equal(policy.startupConfig.compact_prompt, policy.startupConfig.developer_instructions);
  const altered = copy(policy);
  altered.startupConfig.features.plugins = true;
  assert.throws(() => verifyCodexFreshProposalPolicyPlan(altered));
});

test("approved nonempty override does not demand approval for the inactive fallback", (t) => {
  const { codexHome } = fixture(t),
    override = "Synthetic selected override.\n";
  fs.writeFileSync(path.join(codexHome, "AGENTS.override.md"), override, { flag: "wx" });
  fs.writeFileSync(path.join(codexHome, "AGENTS.md"), "Inactive synthetic fallback.\n", { flag: "wx" });
  const options = {
    executablePath: fs.realpathSync(process.execPath),
    codexHome,
    evidenceMode: "protocol-fixture",
    approvedGlobalInstructionDigests: { "AGENTS.override.md": hash(override) },
  };
  const policy = buildCodexFreshProposalPolicyPlan(options);
  assert.equal(policy.globalInstructionState.length, 1);
  fs.writeFileSync(path.join(codexHome, "AGENTS.md"), "Changed inactive fallback.\n");
  assert.deepEqual(buildCodexFreshProposalPolicyPlan(options), policy);
  fs.unlinkSync(path.join(codexHome, "AGENTS.override.md"));
  assert.throws(() => buildCodexFreshProposalPolicyPlan(options), /disappeared/);
});

test("effective managed/config drift and any inherited enabled MCP registration are rejected", (t) => {
  const { policy } = fixture(t, { mcpServerNames: ["known"] });
  assert.equal(assertCodexFreshProposalEffectiveConfig({ policy, response: { config: copy(policy.startupConfig) } }).verified, true);
  for (const mutate of [
    (config) => {
      config.features.plugins = true;
    },
    (config) => {
      delete config.features.hooks;
    },
    (config) => {
      config.mcp_servers.surprise = { command: "must-not-run", enabled: true };
    },
    (config) => {
      config.mcp_servers.surprise = {};
    },
    (config) => {
      config.notify = ["must-not-run"];
    },
    (config) => {
      config.model_instructions_file = "unselected";
    },
    (config) => {
      config.skills.include_instructions = true;
    },
  ]) {
    const config = copy(policy.startupConfig);
    mutate(config);
    assert.throws(() => assertCodexFreshProposalEffectiveConfig({ policy, response: { config } }));
  }
});

test("provider identifier cannot silently select a custom endpoint", (t) => {
  const { policy } = fixture(t);
  assert.equal(
    assertCodexFreshProposalEffectiveConfig({
      policy,
      response: {
        config: {
          ...copy(policy.startupConfig),
          chatgpt_base_url: "https://chatgpt.com/backend-api/",
        },
      },
    }).verified,
    true,
  );
  for (const extra of [
    { openai_base_url: "https://example.invalid" },
    { chatgpt_base_url: "https://example.invalid" },
    { model_providers: { openai: { base_url: "https://example.invalid" } } },
  ]) {
    assert.throws(() => assertCodexFreshProposalEffectiveConfig({ policy, response: { config: { ...copy(policy.startupConfig), ...extra } } }));
  }
});

test("effective readback accepts documented empty omission, object order and disabled structured multi-agent", (t) => {
  const { root, codexHome, policy } = fixture(t);
  const config = copy(policy.startupConfig);
  delete config.skills.config;
  config.features.multi_agent_v2 = { enabled: false, instructions: "inactive" };
  assert.equal(assertCodexFreshProposalEffectiveConfig({ policy, response: { config } }).verified, true);
  const selected = buildCodexFreshProposalPolicyPlan({
    executablePath: fs.realpathSync(process.execPath),
    codexHome,
    evidenceMode: "protocol-fixture",
    disabledSkillPaths: [path.join(root, "synthetic", "SKILL.md")],
  });
  const ordered = copy(selected.startupConfig);
  ordered.skills.config[0] = { enabled: false, path: ordered.skills.config[0].path };
  assert.equal(assertCodexFreshProposalEffectiveConfig({ policy: selected, response: { config: ordered } }).verified, true);
  config.features.code_mode_host = { enabled: false, disable_in_process_fallback: true };
  assert.throws(() => assertCodexFreshProposalEffectiveConfig({ policy, response: { config } }));
});

test("skill readback validates discovered disabled paths rather than claiming full disk enumeration", (t) => {
  const { root, codexHome } = fixture(t),
    skillPath = path.join(root, "synthetic-skill", "SKILL.md");
  const policy = buildCodexFreshProposalPolicyPlan({
    executablePath: fs.realpathSync(process.execPath),
    codexHome,
    evidenceMode: "protocol-fixture",
    disabledSkillPaths: [skillPath],
  });
  const response = { data: [{ cwd: root, errors: [], skills: [{ path: skillPath, enabled: false }] }] };
  assert.equal(assertCodexFreshProposalSkills({ policy, response, executionRoot: root }).disabledCount, 1);
  for (const mutate of [
    (data) => {
      data[0].skills[0].enabled = true;
    },
    (data) => {
      data[0].skills[0].path = path.join(root, "other", "SKILL.md");
    },
    (data) => {
      data[0].errors.push({ path: "synthetic", message: "unreadable" });
    },
    (data) => {
      data[0].cwd = codexHome;
    },
  ]) {
    const changed = copy(response);
    mutate(changed.data);
    assert.throws(() => assertCodexFreshProposalSkills({ policy, response: changed, executionRoot: root }));
  }
});

test("fresh thread and turn have no environment, selected capabilities, dynamic tools or config mutation", (t) => {
  const { root, policy } = fixture(t);
  const start = codexFreshProposalThreadParams({ policy, executionRoot: root });
  assert.equal(start.ephemeral, true);
  assert.equal(start.allowProviderModelFallback, false);
  for (const field of ["environments", "runtimeWorkspaceRoots", "selectedCapabilityRoots", "dynamicTools"]) assert.deepEqual(start[field], []);
  assert.equal(start.approvalPolicy, "never");
  assert.equal(start.approvalsReviewer, "user");
  assert.equal(Object.hasOwn(start, "config"), false);
  const turn = codexFreshProposalTurnParams({ policy, threadId: "owned", input: "selected only", outputSchema: { type: "object" } });
  assert.deepEqual(turn.environments, []);
  assert.deepEqual(turn.runtimeWorkspaceRoots, []);
  assert.equal(turn.input[0].text, "selected only");
  assert.equal(Object.hasOwn(turn, "config"), false);
});

test("provider environment drops keys, custom endpoints and startup overrides but keeps existing home", (t) => {
  const { policy } = fixture(t);
  const environment = codexFreshProposalEnvironment({
    policy,
    environment: {
      SystemRoot: "system",
      PATH: "path",
      CODEX_HOME: "wrong",
      OPENAI_API_KEY: "synthetic-secret",
      CODEX_API_KEY: "synthetic-secret",
      OPENAI_BASE_URL: "https://example.invalid",
      NODE_OPTIONS: "--import unselected",
      CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "0",
    },
  });
  assert.deepEqual(environment, { SystemRoot: "system", PATH: "path", CODEX_HOME: policy.codexHome, CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1" });
});

test("advisory instruction paths may report selected sources but cannot add unselected inputs", (t) => {
  const { codexHome } = fixture(t),
    bytes = "Synthetic selected instructions.\n";
  const selected = path.join(codexHome, "AGENTS.md");
  fs.writeFileSync(selected, bytes, { flag: "wx" });
  const policy = buildCodexFreshProposalPolicyPlan({
    executablePath: fs.realpathSync(process.execPath),
    codexHome,
    evidenceMode: "protocol-fixture",
    approvedGlobalInstructionDigests: { "AGENTS.md": hash(bytes) },
  });
  assert.equal(assertCodexFreshProposalInstructionSources({ policy }).verified, true);
  assert.equal(
    assertCodexFreshProposalInstructionSources({ policy, instructionSources: [selected, policy.startupConfig.model_instructions_file] }).verified,
    true,
  );
  assert.throws(() => assertCodexFreshProposalInstructionSources({ policy, instructionSources: [path.join(codexHome, "unselected.md")] }));
});

test("historical structural verification does not bind a retained policy to the current cache location", (t) => {
  const { root, policy } = fixture(t),
    retained = copy(policy);
  retained.startupConfig.model_instructions_file = path.join(root, "retired-cache", "codex-proposal-instructions.txt");
  retained.startupConfig.experimental_compact_prompt_file = retained.startupConfig.model_instructions_file;
  assert.deepEqual(verifyCodexFreshProposalPolicyPlan(retained), retained);
  retained.startupConfig.compact_prompt = "unselected historical prompt";
  assert.throws(() => verifyCodexFreshProposalPolicyPlan(retained));
});

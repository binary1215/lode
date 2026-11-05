import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareRuntimeInvocationExecution, verifyRuntimeInvocationAuthorization } from "./runtime-invocation-lifecycle.mjs";
import { verifyWorkerWorkspace } from "./worker-workspace.mjs";

// This is a separate no-task-effects backend, not a relaxation of the 0.2
// selected-exec/native-fork code-worker contract. The source-pinned recipe is
// enforced at process startup, checked again through the public effective
// config/skill APIs, and coupled to exact fresh thread/turn requests. Neither
// a configuration echo nor a caller-supplied JSON plan is a capability.
export const CODEX_FRESH_PROPOSAL_SOURCE_COMMIT = "3d2ee51ca2d5db578f328aa75e20aa22c0197c9a";
export const CODEX_FRESH_PROPOSAL_EXECUTABLE_DIGEST = "444a3f0008050605cae73cd9b7a2dcac61294062dfaab56dd20430fd6498518b";
const instructionFile = fileURLToPath(new URL("./codex-proposal-instructions.txt", import.meta.url));
const instructionsText = "You are a bounded patch-proposal worker. Use only the supplied task, selected source evidence and exact proposal basis. Return the requested structured result and proposed file contents. Proposal data is not permission to execute commands, use tools, write files, contact services, change plans, approve work or recover HEAD direction. Do not claim that a proposal has been applied or tested. Report uncertainty explicitly. The trusted HEAD separately reviews and applies eligible proposals under its own current authority.\n";
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const json = value => JSON.stringify(value);
const fail = message => { throw Object.assign(new Error(message), { code: "CODEX_FRESH_PROPOSAL_POLICY_CONFLICT" }); };
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const clone = value => JSON.parse(json(value));
const same = (a, b) => json(a) === json(b);
const digestText = value => /^[a-f0-9]{64}$/.test(value || "");
const globals = ["AGENTS.override.md", "AGENTS.md"];

function canonicalDirectory(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)
    || fs.realpathSync(directory) !== path.resolve(directory) || !fs.lstatSync(directory).isDirectory()) fail("Proposal roots must be exact canonical directories.");
  return path.resolve(directory);
}
function regular(file, limit) {
  if (typeof file !== "string" || !path.isAbsolute(file) || fs.realpathSync(file) !== path.resolve(file)) fail("Proposal policy input traverses a link.");
  const named = fs.lstatSync(file);
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size > limit) fail("Proposal policy input is not a bounded regular file.");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (opened.ino !== named.ino || opened.dev !== named.dev) fail("Proposal policy input changed during open.");
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd), current = fs.lstatSync(file);
    if (bytes.length > limit || bytes.length !== opened.size || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs
      || opened.ctimeMs !== after.ctimeMs || current.dev !== after.dev || current.ino !== after.ino
      || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs) fail("Proposal policy input changed during read.");
    return bytes;
  } finally { fs.closeSync(fd); }
}
function globalInstructions(codexHome, approved = {}) {
  if (!approved || typeof approved !== "object" || Array.isArray(approved)
    || Object.entries(approved).some(([name, digest]) => !globals.includes(name) || !digestText(digest))) fail("Invalid selected global instruction identity.");
  const state = [];
  for (const name of globals) {
    const file = path.join(codexHome, name);
    try { fs.lstatSync(file); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (Object.hasOwn(approved, name)) fail("Selected global instructions disappeared.");
      state.push({ name, present: false, digest: null, size: 0, selected: false });
      continue;
    }
    const bytes = regular(file, 128 * 1024), digest = hash(bytes);
    const nonempty = bytes.toString("utf8").trim().length !== 0;
    if (nonempty && approved[name] !== digest || approved[name] !== undefined && approved[name] !== digest) {
      throw Object.assign(new Error("Unselected global instructions would enter this fresh proposal worker."), {
        code: "CODEX_FRESH_PROPOSAL_POLICY_CONFLICT", reason: "unselected-global-instructions",
      });
    }
    state.push({ name, present: true, digest, size: bytes.length, selected: approved[name] === digest });
    // Match CodexHomeUserInstructionsProvider's actual first-nonempty
    // precedence. An inactive fallback is neither transmitted nor a new gate.
    if (nonempty) break;
  }
  return state;
}

const disabledFeatures = ["hooks", "plugins", "apps", "executor_capability_discovery", "shell_tool", "image_generation",
  "view_image", "request_permissions_tool", "token_budget", "memories", "goals", "tool_suggest", "multi_agent_v2",
  "multi_agent", "code_mode_host", "skill_search", "chronicle", "code_mode_prewarm", "external_agent_memory_import",
  "skill_mcp_dependency_install", "recommended_plugins", "standalone_web_search", "deferred_executor",
  "guardian_approval", "guardianv2", "guardian_ext"];

function configuration({ mcpServerNames, disabledSkillPaths, model, instructions, materialPath = instructionFile }) {
  return {
    model, model_provider: "openai", approval_policy: "never", approvals_reviewer: "user",
    web_search: "disabled", notify: [], project_doc_max_bytes: 0,
    model_instructions_file: materialPath, experimental_compact_prompt_file: materialPath,
    developer_instructions: instructions, compact_prompt: instructions,
    features: Object.fromEntries(disabledFeatures.map(name => [name, false])),
    agents: { enabled: false },
    orchestrator: { skills: { enabled: false }, mcp: { enabled: false } },
    skills: { include_instructions: false, bundled: { enabled: false }, config: disabledSkillPaths.map(skillPath => ({ path: skillPath, enabled: false })) },
    // Tables deep-merge in the pinned provider. Disable each exact registration;
    // an empty object is never claimed to erase inherited registrations.
    mcp_servers: Object.fromEntries(mcpServerNames.map(name => [name, { enabled: false }])),
  };
}

export function buildCodexFreshProposalPolicyPlan({ executablePath, codexHome, model = "openai/gpt-5.6-sol",
  wireModel = "gpt-5.6-sol", wireModelProvider = "openai", evidenceMode = "actual-provider",
  mcpServerNames = [], disabledSkillPaths = [], approvedGlobalInstructionDigests = {} } = {}) {
  canonicalDirectory(codexHome);
  if (!["actual-provider", "protocol-fixture"].includes(evidenceMode) || wireModelProvider !== "openai"
    || model !== `${wireModelProvider}/${wireModel}` || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/.test(wireModel)) fail("Invalid fresh proposal provider/model identity.");
  const binary = regular(executablePath, 512 * 1024 * 1024), executableDigest = hash(binary);
  if (evidenceMode === "actual-provider" && (executableDigest !== CODEX_FRESH_PROPOSAL_EXECUTABLE_DIGEST || !/^codex(?:\.exe)?$/i.test(path.basename(executablePath)))
    || evidenceMode === "protocol-fixture" && (path.resolve(executablePath) !== fs.realpathSync(process.execPath) || executableDigest !== hash(regular(fs.realpathSync(process.execPath), 512 * 1024 * 1024)))) fail("Fresh proposal provider build is not the audited executable.");
  if (!Array.isArray(mcpServerNames) || mcpServerNames.length > 1024 || new Set(mcpServerNames).size !== mcpServerNames.length
    || mcpServerNames.some(name => typeof name !== "string" || !name || name.length > 256 || /[\x00-\x1f\x7f]/u.test(name))) fail("Invalid MCP registration inventory.");
  if (!Array.isArray(disabledSkillPaths) || disabledSkillPaths.length > 4096 || new Set(disabledSkillPaths).size !== disabledSkillPaths.length
    || disabledSkillPaths.some(skillPath => typeof skillPath !== "string" || !path.isAbsolute(skillPath) || path.resolve(skillPath) !== skillPath
      || path.basename(skillPath).toLowerCase() !== "skill.md" || /[\x00-\x1f\x7f]/u.test(skillPath))) fail("Invalid disabled skill inventory.");
  const instructions = regular(instructionFile, 16 * 1024).toString("utf8");
  if (instructions !== instructionsText) fail("Fixed proposal instructions changed.");
  const names = [...mcpServerNames].sort(), skills = [...disabledSkillPaths].sort();
  return freeze({ kind: "CodexFreshProposalPolicyPlan", protocolVersion: "0.1.0", runtime: "codex", mode: "fresh-selected-patch-proposal",
    evidenceMode, workspaceMode: "read-only", executablePath: path.resolve(executablePath), codexHome: path.resolve(codexHome),
    executableIdentity: { pathDigest: hash(path.resolve(executablePath)), contentDigest: executableDigest }, codexHomeDigest: hash(path.resolve(codexHome)),
    sourceAuditCommit: CODEX_FRESH_PROPOSAL_SOURCE_COMMIT, model, wireModel, wireModelProvider,
    mcpServerNames: names, disabledSkillPaths: skills, globalInstructionState: globalInstructions(codexHome, approvedGlobalInstructionDigests),
    instructionDigest: hash(instructions), startupConfig: configuration({ mcpServerNames: names, disabledSkillPaths: skills, model: wireModel, instructions }),
    enforcementVerified: false, instructionAuthority: false, promotionAuthority: false, recoveryAuthority: false });
}

// Historical inspection is pure: a retired cache, executable, or Codex home
// cannot make already-retained evidence unreadable. Current file state belongs
// to assertCodexFreshProposalPolicy at execution, not this structural verifier.
export function verifyCodexFreshProposalPolicyPlan(policy) {
  if (!policy || policy.kind !== "CodexFreshProposalPolicyPlan" || policy.protocolVersion !== "0.1.0"
    || !["actual-provider", "protocol-fixture"].includes(policy.evidenceMode)
    || policy.wireModelProvider !== "openai" || policy.model !== `openai/${policy.wireModel}`
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/.test(policy.wireModel)
    || ![policy.executablePath, policy.codexHome].every(file => typeof file === "string" && path.isAbsolute(file) && file === path.resolve(file))
    || !digestText(policy.executableIdentity?.contentDigest)
    || policy.evidenceMode === "actual-provider" && (policy.executableIdentity.contentDigest !== CODEX_FRESH_PROPOSAL_EXECUTABLE_DIGEST
      || !/^codex(?:\.exe)?$/i.test(path.basename(policy.executablePath)))
    || !Array.isArray(policy.mcpServerNames) || policy.mcpServerNames.length > 1024
    || !same(policy.mcpServerNames, [...new Set(policy.mcpServerNames)].sort())
    || policy.mcpServerNames.some(name => typeof name !== "string" || !name || name.length > 256 || /[\x00-\x1f\x7f]/u.test(name))
    || !Array.isArray(policy.disabledSkillPaths) || policy.disabledSkillPaths.length > 4096
    || !same(policy.disabledSkillPaths, [...new Set(policy.disabledSkillPaths)].sort())
    || policy.disabledSkillPaths.some(file => typeof file !== "string" || !path.isAbsolute(file) || path.resolve(file) !== file
      || path.basename(file).toLowerCase() !== "skill.md" || /[\x00-\x1f\x7f]/u.test(file))
    || !Array.isArray(policy.globalInstructionState) || policy.globalInstructionState.length < 1 || policy.globalInstructionState.length > globals.length
    || policy.globalInstructionState.length < globals.length && policy.globalInstructionState.at(-1)?.selected !== true
    || typeof policy.startupConfig?.model_instructions_file !== "string" || !path.isAbsolute(policy.startupConfig.model_instructions_file)
    || path.resolve(policy.startupConfig.model_instructions_file) !== policy.startupConfig.model_instructions_file
    || path.basename(policy.startupConfig.model_instructions_file) !== "codex-proposal-instructions.txt") fail("Invalid fresh proposal policy.");
  const instructionState = policy.globalInstructionState.map((item, index) => {
    if (!item || item.name !== globals[index] || typeof item.present !== "boolean" || typeof item.selected !== "boolean"
      || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > 128 * 1024
      || item.present && !digestText(item.digest) || !item.present && (item.digest !== null || item.size !== 0 || item.selected)) fail("Invalid retained global instruction identity.");
    return { name: item.name, present: item.present, digest: item.digest, size: item.size, selected: item.selected };
  });
  const rebuilt = { kind: "CodexFreshProposalPolicyPlan", protocolVersion: "0.1.0", runtime: "codex", mode: "fresh-selected-patch-proposal",
    evidenceMode: policy.evidenceMode, workspaceMode: "read-only", executablePath: policy.executablePath, codexHome: policy.codexHome,
    executableIdentity: { pathDigest: hash(policy.executablePath), contentDigest: policy.executableIdentity.contentDigest }, codexHomeDigest: hash(policy.codexHome),
    sourceAuditCommit: CODEX_FRESH_PROPOSAL_SOURCE_COMMIT, model: policy.model, wireModel: policy.wireModel, wireModelProvider: "openai",
    mcpServerNames: [...policy.mcpServerNames], disabledSkillPaths: [...policy.disabledSkillPaths], globalInstructionState: instructionState,
    instructionDigest: hash(instructionsText), startupConfig: configuration({ mcpServerNames: policy.mcpServerNames,
      disabledSkillPaths: policy.disabledSkillPaths, model: policy.wireModel, instructions: instructionsText,
      materialPath: policy.startupConfig.model_instructions_file }),
    enforcementVerified: false, instructionAuthority: false, promotionAuthority: false, recoveryAuthority: false };
  if (!same(rebuilt, policy)) fail("Fresh proposal policy differs from its fixed typed recipe.");
  return freeze(clone(rebuilt));
}

function toml(value) {
  if (typeof value === "string" || typeof value === "boolean" || Number.isSafeInteger(value)) return json(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).map(([key, item]) => `${json(key)}=${toml(item)}`).join(",")}}`;
  fail("Invalid fixed startup configuration value.");
}
export function codexFreshProposalStartupArguments(policy) {
  const fixed = verifyCodexFreshProposalPolicyPlan(policy);
  return ["app-server", "--listen", "stdio://", ...Object.entries(fixed.startupConfig).flatMap(([key, value]) => ["-c", `${key}=${toml(value)}`])];
}

function checkSubset(expected, actual, route = "config") {
  if (route === "config.skills.config" && Array.isArray(expected) && expected.length === 0 && actual === undefined) return;
  if (route === "config.features.multi_agent_v2" && expected === false && actual && typeof actual === "object" && !Array.isArray(actual)) {
    if (actual.enabled !== false) fail("Effective multi-agent delegation remains enabled.");
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || expected.length !== actual.length) fail(`Effective ${route} differs from its fixed array.`);
    for (let index = 0; index < expected.length; index++) checkSubset(expected[index], actual[index], `${route}[${index}]`);
  } else if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) fail(`Missing effective ${route}.`);
    for (const [key, value] of Object.entries(expected)) checkSubset(value, actual[key], `${route}.${key}`);
  } else if (!same(expected, actual)) fail(`Effective ${route} differs from the fixed no-task-effects recipe.`);
}
export function assertCodexFreshProposalEffectiveConfig({ policy, response }) {
  const fixed = verifyCodexFreshProposalPolicyPlan(policy), config = response?.config;
  checkSubset(fixed.startupConfig, config);
  if (!config?.mcp_servers || Object.values(config.mcp_servers).some(server => !server || server.enabled !== false)) fail("An inherited MCP registration remains enabled or unknown.");
  // Do not silently route approved ChatGPT-account work to a custom endpoint.
  // Packaged defaults.toml materializes this official URL in config/read even
  // for a completely empty Codex home. Non-null does not mean user override.
  if (config.chatgpt_base_url != null && config.chatgpt_base_url !== "https://chatgpt.com/backend-api/"
    || config.openai_base_url != null || config.model_providers?.openai != null) fail("A custom provider endpoint requires a separate audited backend.");
  return { verified: true, actualProviderInvoked: false, recoveryAuthority: false };
}
export function assertCodexFreshProposalSkills({ policy, response, executionRoot }) {
  const fixed = verifyCodexFreshProposalPolicyPlan(policy);
  const entries = response?.data;
  if (!Array.isArray(entries) || entries.length !== 1 || entries[0].cwd !== executionRoot
    || !Array.isArray(entries[0].errors) || entries[0].errors.length || !Array.isArray(entries[0].skills)) fail("The fresh proposal skill inventory is incomplete.");
  const seen = new Set();
  for (const skill of entries[0].skills) {
    if (!skill || typeof skill.path !== "string" || skill.enabled !== false || !fixed.disabledSkillPaths.includes(skill.path) || seen.has(skill.path)) fail("An unselected skill remains callable in fresh proposal mode.");
    seen.add(skill.path);
  }
  return { verified: true, disabledCount: seen.size, recoveryAuthority: false };
}

// The provider's source-path list is advisory, not instruction-byte proof.
// It may omit selected sources, but any reported source must be among the
// already locally verified fixed/selected inputs. Absence alone grants nothing.
export function assertCodexFreshProposalInstructionSources({ policy, instructionSources = [] }) {
  const fixed = verifyCodexFreshProposalPolicyPlan(policy);
  const allowed = new Set([fixed.startupConfig.model_instructions_file,
    ...fixed.globalInstructionState.filter(item => item.selected).map(item => path.join(fixed.codexHome, item.name))].map(file => path.resolve(file)));
  if (!Array.isArray(instructionSources) || instructionSources.some(file => typeof file !== "string" || !path.isAbsolute(file)
    || !allowed.has(path.resolve(file)))) fail("Provider reported an instruction source outside the selected proposal inputs.");
  return { verified: true, reportedSources: instructionSources.length, instructionAuthority: false };
}

export function assertCodexFreshProposalRecipeCurrent(policy) {
  const fixed = verifyCodexFreshProposalPolicyPlan(policy);
  const current = buildCodexFreshProposalPolicyPlan({ ...fixed, approvedGlobalInstructionDigests:
    Object.fromEntries(fixed.globalInstructionState.filter(item => item.selected).map(item => [item.name, item.digest])) });
  if (!same(current, fixed)) fail("Current proposal provider or instruction bindings drifted.");
  return fixed;
}

export function assertCodexFreshProposalPolicy({ policy, authorization, workspaceBinding, root, executablePath = policy?.executablePath,
  codexHome = policy?.codexHome } = {}) {
  const fixed = assertCodexFreshProposalRecipeCurrent(policy), auth = verifyRuntimeInvocationAuthorization(authorization);
  if (auth.protocolVersion !== "0.7.0" || auth.runtime !== "codex" || auth.workspaceMode !== "read-only"
    || auth.runtimeSelection?.model !== fixed.model || auth.workerInput?.executionBoundary?.mode !== fixed.mode
    || auth.workerInput.executionBoundary.policyDigest !== hash(json(fixed))
    || executablePath !== fixed.executablePath || codexHome !== fixed.codexHome
    || workspaceBinding?.canonicalRoot !== fs.realpathSync(root)
    || auth.workerInput.executionBoundary.workspaceBindingDigest !== workspaceBinding.bindingDigest
    || auth.workerInput.executionBoundary.executionRootDigest !== workspaceBinding.executionRootDigest) fail("Proposal policy does not match its exact pre-authorized member and workspace.");
  verifyWorkerWorkspace({ binding: workspaceBinding, sourceBasis: auth.workerInput.sourceBasis });
  const prepared = prepareRuntimeInvocationExecution({ root, authorization: auth, sessionRequest: auth.workerInput.sessionRequest || "" });
  return { ...prepared, policy: fixed, executionRoot: workspaceBinding.executionRoot, inputDigest: auth.executionInput.digest };
}
export function codexFreshProposalThreadParams({ policy, executionRoot }) {
  const fixed = verifyCodexFreshProposalPolicyPlan(policy), instructions = instructionsText;
  if (typeof executionRoot !== "string" || !path.isAbsolute(executionRoot)) fail("Invalid proposal execution root.");
  return { model: fixed.wireModel, modelProvider: fixed.wireModelProvider, cwd: executionRoot,
    approvalPolicy: "never", approvalsReviewer: "user", sandbox: "read-only", ephemeral: true,
    environments: [], runtimeWorkspaceRoots: [], selectedCapabilityRoots: [], dynamicTools: [],
    allowProviderModelFallback: false, baseInstructions: instructions, developerInstructions: instructions };
}
export function codexFreshProposalTurnParams({ policy, threadId, input, outputSchema }) {
  const fixed = verifyCodexFreshProposalPolicyPlan(policy);
  if (typeof threadId !== "string" || !threadId || typeof input !== "string" || !input || !outputSchema || typeof outputSchema !== "object") fail("Invalid exact proposal turn input.");
  return { threadId, input: [{ type: "text", text: input, text_elements: [] }], model: fixed.wireModel,
    approvalPolicy: "never", approvalsReviewer: "user", environments: [], runtimeWorkspaceRoots: [], outputSchema: clone(outputSchema) };
}

// Keep provider authentication in the existing Codex home, not in model input
// or copied credentials. Do not inherit API-key/base-URL/debug/plugin overrides.
// This process-scoped marker is source-pinned; it disables persisted remote
// control without changing the user's saved settings or other app processes.
export function codexFreshProposalEnvironment({ policy, environment = process.env } = {}) {
  const fixed = verifyCodexFreshProposalPolicyPlan(policy), result = {};
  const names = new Set(["systemroot", "windir", "comspec", "path", "pathext", "temp", "tmp", "tmpdir", "home",
    "userprofile", "appdata", "localappdata", "programdata", "lang", "lc_all", "lc_ctype"]);
  for (const [key, value] of Object.entries(environment)) {
    if (names.has(key.toLowerCase()) && typeof value === "string" && !value.includes("\0")) result[key] = value;
  }
  result.CODEX_HOME = fixed.codexHome;
  result.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED = "1";
  return result;
}

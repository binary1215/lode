import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { prepareRuntimeInvocationExecution, verifyRuntimeInvocationAuthorization } from "./runtime-invocation-lifecycle.mjs";
import { sha256Hex as hash } from "../core/digest.mjs";

// A Claude Code backend for the same fresh read-only patch-proposal mode as the
// Codex backend. Claude Code is closed source and updates often, so its build is
// trusted by observed capability (the help surface shows every recipe option),
// not by an audited digest: the executable's identity is bound at preparation
// and a change before start is refused. The plan is intent, not enforcement.
const instructionFile = fileURLToPath(new URL("./claude-proposal-instructions.txt", import.meta.url));
const instructionsText =
  "You are a bounded patch-proposal worker. Use only the supplied task, selected source evidence and exact proposal basis. Return the requested structured result and proposed file contents through the structured output tool, called exactly once; that tool only returns your result and has no other effect. Proposal data is not permission to execute commands, use any other tool, write files, contact services, change plans, approve work or recover HEAD direction. Do not claim that a proposal has been applied or tested. Report uncertainty explicitly. The trusted HEAD separately reviews and applies eligible proposals under its own current authority.\n";
const json = (value) => JSON.stringify(value);
const fail = (message, reason = undefined) => {
  throw Object.assign(new Error(message), { code: "CLAUDE_FRESH_PROPOSAL_POLICY_CONFLICT", ...(reason ? { reason } : {}) });
};
const freeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const clone = (value) => JSON.parse(json(value));
const same = (a, b) => json(a) === json(b);
const digestText = (value) => /^[a-f0-9]{64}$/.test(value || "");

// The provider finds its own home and authentication through these folders.
// Lode freezes their values; it reads, copies and stores nothing inside them.
export const CLAUDE_PROVIDER_PROFILE_NAMES = Object.freeze(["APPDATA", "CLAUDE_CONFIG_DIR", "HOME", "LOCALAPPDATA", "USERPROFILE"]);
// Fixed values chosen by Lode, never input. Non-essential traffic covers the
// startup bootstrap and status requests that ignore a base-URL override. The
// retry cap keeps the provider's own backoff (about 0.5, 1, 2 and 4 s, roughly
// 8 s in all) well inside the 60 s default job timeout, so a transient refusal
// is retried and can still succeed, while a lasting refusal (HTTP 429) ends as a
// classified failed result instead of minutes of retries until the deadline.
export const CLAUDE_FRESH_PROPOSAL_FIXED_ENVIRONMENT = Object.freeze({
  CI: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CLAUDE_CODE_MAX_RETRIES: "4",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_TELEMETRY: "1",
  NO_COLOR: "1",
  TERM: "dumb",
});
// What the checked recipe could not be shown to exclude on the installed build.
// Stated in the plan instead of being claimed away.
export const CLAUDE_FRESH_PROPOSAL_KNOWN_UNEXCLUDED = Object.freeze(["claude-built-in-plugin-hooks", "claude-provider-home-bookkeeping-writes"]);
// Every option of the recipe, as the installed help must show it (D1: trust by
// observed capability). Checked on the same help bytes the protocol observation
// read; the shared observation signals cover only part of this list.
export const CLAUDE_FRESH_PROPOSAL_RECIPE_SURFACE = Object.freeze([
  "--print",
  "--output-format",
  "stream-json",
  "--verbose",
  "--no-session-persistence",
  "--json-schema",
  "--permission-mode",
  "dontAsk",
  "--tools",
  "--disable-slash-commands",
  "--setting-sources",
  "--strict-mcp-config",
  "--mcp-config",
  "--system-prompt",
  "--model",
]);
export function claudeRecipeSurfaceMissing(helpText) {
  const text = typeof helpText === "string" ? helpText : "";
  // A whole option word: not a prefix of a longer one such as --system-prompt-snapshot.
  const shown = (option) => text.split(/[\s,"()|[\]<>]+/u).includes(option);
  return CLAUDE_FRESH_PROPOSAL_RECIPE_SURFACE.filter((option) => !shown(option));
}
const MODEL_PATTERN = /^claude-[a-z0-9][a-z0-9.-]{0,95}$/;
export const isClaudeModelId = (value) => typeof value === "string" && MODEL_PATTERN.test(value);

function canonicalDirectory(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory) || directory.includes("\0")) fail("Provider profile folders must be absolute paths.");
  const resolved = fs.realpathSync(directory);
  if (!fs.lstatSync(resolved).isDirectory()) fail("Provider profile folders must be directories.");
  return resolved;
}

// Streams the executable so a large native build is digested without holding it.
function fileIdentity(file, limit) {
  if (typeof file !== "string" || !path.isAbsolute(file) || fs.realpathSync(file) !== path.resolve(file)) fail("Provider executable traverses a link.");
  const named = fs.lstatSync(file);
  if (!named.isFile() || named.isSymbolicLink() || named.size > limit) fail("Provider executable is not a bounded regular file.");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (opened.ino !== named.ino || opened.dev !== named.dev) fail("Provider executable changed during open.");
    const hasher = createHash("sha256"),
      buffer = Buffer.alloc(4 * 1024 * 1024);
    let total = 0;
    for (;;) {
      const n = fs.readSync(fd, buffer, 0, buffer.length, total);
      if (!n) break;
      hasher.update(buffer.subarray(0, n));
      total += n;
      if (total > limit) fail("Provider executable exceeds its bound.");
    }
    const after = fs.fstatSync(fd),
      current = fs.lstatSync(file);
    if (
      total !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      current.ino !== after.ino ||
      current.dev !== after.dev ||
      current.mtimeMs !== after.mtimeMs
    )
      fail("Provider executable changed during read.");
    return { contentDigest: hasher.digest("hex"), byteLength: total };
  } finally {
    fs.closeSync(fd);
  }
}

function regularText(file, limit) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit || fs.realpathSync(file) !== path.resolve(file)) fail("Fixed instruction file is unsafe.");
  return fs.readFileSync(file, "utf8");
}

// Exact present values only, case-insensitive like the Windows environment.
export function claudeProviderProfile(environment = process.env) {
  const profile = {};
  for (const name of CLAUDE_PROVIDER_PROFILE_NAMES) {
    const keys = Object.keys(environment || {}).filter((key) => key.toUpperCase() === name);
    if (keys.length > 1 && new Set(keys.map((key) => environment[key])).size > 1) fail(`Conflicting ${name} spellings.`);
    const value = keys.length ? environment[keys[0]] : undefined;
    if (typeof value === "string" && value.trim()) profile[name] = canonicalDirectory(value);
  }
  if (!profile.HOME && !profile.USERPROFILE) fail("The provider profile needs HOME or USERPROFILE.");
  return profile;
}

function fixedArguments(wireModel) {
  return [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
    "--tools",
    "",
    "--disable-slash-commands",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    json({ mcpServers: {} }),
    "--system-prompt",
    instructionsText,
    "--model",
    wireModel,
  ];
}

function plan({ evidenceMode, executablePath, identity, providerProfile, wireModel }) {
  return {
    kind: "ClaudeFreshProposalPolicyPlan",
    protocolVersion: "0.1.0",
    runtime: "claude",
    mode: "fresh-selected-patch-proposal",
    evidenceMode,
    workspaceMode: "read-only",
    executablePath,
    executableIdentity: { pathDigest: hash(executablePath), contentDigest: identity.contentDigest, byteLength: identity.byteLength },
    trust: "observed-capability",
    providerProfile,
    model: `anthropic/${wireModel}`,
    wireModel,
    instructionScope: "selected-only",
    instructionDigest: hash(instructionsText),
    fixedArguments: fixedArguments(wireModel),
    resultSchemaArgument: "--json-schema",
    fixedEnvironment: { ...CLAUDE_FRESH_PROPOSAL_FIXED_ENVIRONMENT },
    recipeSurface: [...CLAUDE_FRESH_PROPOSAL_RECIPE_SURFACE],
    toolsAvailable: ["StructuredOutput"],
    knownUnexcluded: [...CLAUDE_FRESH_PROPOSAL_KNOWN_UNEXCLUDED],
    enforcementVerified: false,
    instructionAuthority: false,
    promotionAuthority: false,
    recoveryAuthority: false,
  };
}

export function buildClaudeFreshProposalPolicyPlan({
  executablePath,
  environment = process.env,
  wireModel,
  evidenceMode = "actual-provider",
  instructionScope = "selected-only",
} = {}) {
  if (!["actual-provider", "protocol-fixture"].includes(evidenceMode) || !isClaudeModelId(wireModel)) fail("Invalid Claude proposal provider/model identity.");
  // Including the user's own instruction file needs its own recipe; until then
  // the scope stays selected-only and host-global is reported, not widened.
  if (instructionScope !== "selected-only")
    fail("This Claude proposal recipe cannot include Host-global instructions.", "unselected-global-instructions-unsupported");
  if (typeof executablePath !== "string" || !path.isAbsolute(executablePath)) fail("Provider executable must be an absolute path.");
  const resolved = path.resolve(executablePath);
  if (evidenceMode === "actual-provider" && !/^claude(?:\.exe)?$/i.test(path.basename(resolved))) fail("Provider executable is not a Claude Code executable.");
  if (evidenceMode === "protocol-fixture" && resolved !== fs.realpathSync(process.execPath))
    fail("A protocol fixture runs only the current Node executable.");
  const identity = fileIdentity(resolved, 1024 * 1024 * 1024);
  if (regularText(instructionFile, 16 * 1024) !== instructionsText) fail("Fixed proposal instructions changed.");
  return freeze(plan({ evidenceMode, executablePath: resolved, identity, providerProfile: claudeProviderProfile(environment), wireModel }));
}

// Historical inspection is pure: today's executable or profile cannot make
// retained evidence unreadable. Current state is checked before execution only.
export function verifyClaudeFreshProposalPolicyPlan(policy) {
  if (
    !policy ||
    policy.kind !== "ClaudeFreshProposalPolicyPlan" ||
    policy.protocolVersion !== "0.1.0" ||
    !["actual-provider", "protocol-fixture"].includes(policy.evidenceMode) ||
    !isClaudeModelId(policy.wireModel) ||
    typeof policy.executablePath !== "string" ||
    !path.isAbsolute(policy.executablePath) ||
    policy.executablePath !== path.resolve(policy.executablePath) ||
    (policy.evidenceMode === "actual-provider" && !/^claude(?:\.exe)?$/i.test(path.basename(policy.executablePath))) ||
    !digestText(policy.executableIdentity?.contentDigest) ||
    !Number.isSafeInteger(policy.executableIdentity?.byteLength) ||
    policy.executableIdentity.byteLength < 0 ||
    !policy.providerProfile ||
    typeof policy.providerProfile !== "object" ||
    Array.isArray(policy.providerProfile) ||
    Object.keys(policy.providerProfile).some((name) => !CLAUDE_PROVIDER_PROFILE_NAMES.includes(name)) ||
    !same(Object.keys(policy.providerProfile), CLAUDE_PROVIDER_PROFILE_NAMES.filter((name) => Object.hasOwn(policy.providerProfile, name))) ||
    Object.values(policy.providerProfile).some((value) => typeof value !== "string" || !path.isAbsolute(value) || value !== path.resolve(value)) ||
    (!policy.providerProfile.HOME && !policy.providerProfile.USERPROFILE)
  )
    fail("Invalid Claude fresh proposal policy.");
  const rebuilt = plan({
    evidenceMode: policy.evidenceMode,
    executablePath: policy.executablePath,
    identity: policy.executableIdentity,
    providerProfile: { ...policy.providerProfile },
    wireModel: policy.wireModel,
  });
  if (!same(rebuilt, policy)) fail("Claude proposal policy differs from its fixed typed recipe.");
  return freeze(clone(rebuilt));
}

// The current executable and profile must still be the ones bound at
// preparation. An updated Claude Code needs a new preparation.
export function assertClaudeFreshProposalRecipeCurrent(policy) {
  const fixed = verifyClaudeFreshProposalPolicyPlan(policy);
  let current;
  try {
    current = buildClaudeFreshProposalPolicyPlan({
      executablePath: fixed.executablePath,
      environment: fixed.providerProfile,
      wireModel: fixed.wireModel,
      evidenceMode: fixed.evidenceMode,
    });
  } catch (error) {
    if (error.code === "ENOENT") fail("The prepared Claude executable or profile folder is gone; prepare the worker again.", "executable-changed");
    throw error;
  }
  if (!same(current.executableIdentity, fixed.executableIdentity))
    fail("The Claude executable changed after preparation; prepare the worker again.", "executable-changed");
  if (!same(current, fixed)) fail("Current Claude proposal provider bindings drifted.");
  return fixed;
}

// verifyWorkspace is the worker layer's selected-workspace verifier, handed in by
// the caller so this runtime module does not import a higher layer.
export function assertClaudeFreshProposalPolicy({
  policy,
  authorization,
  workspaceBinding,
  root,
  executablePath = policy?.executablePath,
  verifyWorkspace,
} = {}) {
  if (typeof verifyWorkspace !== "function") fail("The selected-workspace verifier is required.");
  const fixed = assertClaudeFreshProposalRecipeCurrent(policy),
    auth = verifyRuntimeInvocationAuthorization(authorization);
  if (
    auth.protocolVersion !== "0.7.0" ||
    auth.runtime !== "claude" ||
    auth.workspaceMode !== "read-only" ||
    auth.runtimeSelection?.model !== fixed.model ||
    auth.workerInput?.executionBoundary?.mode !== fixed.mode ||
    auth.workerInput.executionBoundary.policyDigest !== hash(json(fixed)) ||
    executablePath !== fixed.executablePath ||
    workspaceBinding?.canonicalRoot !== fs.realpathSync(root) ||
    auth.workerInput.executionBoundary.workspaceBindingDigest !== workspaceBinding.bindingDigest ||
    auth.workerInput.executionBoundary.executionRootDigest !== workspaceBinding.executionRootDigest
  )
    fail("Claude proposal policy does not match its exact pre-authorized member and workspace.");
  verifyWorkspace({ binding: workspaceBinding, sourceBasis: auth.workerInput.sourceBasis });
  const prepared = prepareRuntimeInvocationExecution({ root, authorization: auth, sessionRequest: auth.workerInput.sessionRequest || "" });
  return { ...prepared, policy: fixed, executionRoot: workspaceBinding.executionRoot, inputDigest: auth.executionInput.digest };
}

export function claudeFreshProposalArguments({ policy, resultSchema }) {
  const fixed = verifyClaudeFreshProposalPolicyPlan(policy);
  if (!resultSchema || typeof resultSchema !== "object" || Array.isArray(resultSchema)) fail("Invalid proposal result schema.");
  const args = [...fixed.fixedArguments];
  // The schema is the scope's fixed proposal grammar; it goes right after the
  // ephemeral-session flag, as in the checked recipe.
  args.splice(args.indexOf("--no-session-persistence") + 1, 0, fixed.resultSchemaArgument, json(resultSchema));
  return args;
}

// The worker gets the system folders, its frozen profile and Lode's fixed
// values. No PATH, NODE_OPTIONS, credential or proxy variable is forwarded.
export function claudeFreshProposalEnvironment({ policy, environment = process.env } = {}) {
  const fixed = verifyClaudeFreshProposalPolicyPlan(policy),
    result = {};
  const system = new Set(["systemroot", "windir", "temp", "tmp"]);
  for (const [key, value] of Object.entries(environment || {})) {
    const seen = Object.keys(result).some((name) => name.toLowerCase() === key.toLowerCase());
    if (system.has(key.toLowerCase()) && typeof value === "string" && !value.includes("\0") && !seen) result[key] = value;
  }
  Object.assign(result, fixed.providerProfile, fixed.fixedEnvironment);
  return result;
}

import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";
const originalFormat = record => familyFormatForOriginal({ kind: record?.kind }, record);
import crypto from "node:crypto";
import fs from "node:fs";
import { verifyCodexFreshProposalPolicyPlan, assertCodexFreshProposalRecipeCurrent,
  codexFreshProposalThreadParams, codexFreshProposalTurnParams, codexFreshProposalStartupArguments } from "./runtime-codex-proposal-policy.mjs";
import { prepareRuntimeInvocationExecution, verifyRuntimeInvocationAuthorization } from "./runtime-invocation-lifecycle.mjs";
import { verifyWorkerWorkspace } from "./worker-workspace.mjs";

export const CODEX_NATIVE_PREFIX_MODE = "native-prefix-patch-proposal";
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const json = value => JSON.stringify(value);
const fail = () => { throw Object.assign(new Error("Native prefix proposal policy or controlled source changed"), { code: "CODEX_NATIVE_PREFIX_POLICY_CONFLICT" }); };
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export const CODEX_NATIVE_PREFIX_SEED_REPLY = "HEAD_NATIVE_PREFIX_SEED_READY";
export const CODEX_NATIVE_PREFIX_SEED_SCHEMA = freeze({ type: "object", additionalProperties: false,
  required: ["seed"], properties: { seed: { type: "string", enum: [CODEX_NATIVE_PREFIX_SEED_REPLY] } } });

// Intent, not permission or provenance. The concrete transport creates its own
// legacy seed with the fixed fresh recipe; no source ID/path/proof is accepted.
// This optional mode explicitly includes durable seed preparation and two model
// turns (one seed, one child), unlike the existing one-turn fresh mode.
export function buildCodexNativePrefixPolicyPlan({ freshPolicy, seedText } = {}) {
  const recipe = verifyCodexFreshProposalPolicyPlan(freshPolicy);
  if (typeof seedText !== "string" || !seedText.trim() || Buffer.byteLength(seedText) > 16 * 1024) fail();
  return freeze({ kind: "CodexNativePrefixPolicyPlan", protocolVersion: "0.1.0", runtime: "codex", mode: CODEX_NATIVE_PREFIX_MODE,
    evidenceMode: recipe.evidenceMode, workspaceMode: "read-only", model: recipe.model,
    wireModel: recipe.wireModel, wireModelProvider: recipe.wireModelProvider, executablePath: recipe.executablePath,
    executableIdentity: recipe.executableIdentity, codexHome: recipe.codexHome, recipe,
    seed: { text: seedText, digest: hash(seedText), provenance: "fixed-owned-fresh-legacy-seed",
      durableProviderHistory: true, maximumSourceThreads: 1, maximumSourceTurns: 1, maximumChildThreads: 1, maximumChildTurns: 1 },
    legacyHistory: { projection: "codex-3d2ee51-text-seed", showRawAgentReasoning: false },
    observations: { childHistoryReadback: false, childGoalReadback: false, forkResponsePrefix: true,
      explicitChildTurnNotifications: true, exactOwnerExitRequired: true },
    enforcementVerified: false, instructionAuthority: false, promotionAuthority: false, recoveryAuthority: false });
}
export function verifyCodexNativePrefixPolicyPlan(policy) {
  const rebuilt = buildCodexNativePrefixPolicyPlan({ freshPolicy: policy?.recipe, seedText: policy?.seed?.text });
  if (json(rebuilt) !== json(policy)) fail();
  return rebuilt;
}
export function assertCodexNativePrefixPolicy({ policy, root, authorization, workspaceBinding,
  executablePath = policy?.executablePath, codexHome = policy?.codexHome } = {}) {
  const fixed = verifyCodexNativePrefixPolicyPlan(policy);
  assertCodexFreshProposalRecipeCurrent(fixed.recipe);
  const auth = verifyRuntimeInvocationAuthorization(authorization), boundary = auth.workerInput?.executionBoundary;
  if (auth.protocolVersion !== "0.7.0" || auth.runtime !== "codex" || auth.workspaceMode !== "read-only"
    || auth.runtimeSelection?.model !== fixed.model || boundary?.mode !== CODEX_NATIVE_PREFIX_MODE
    || boundary.policyDigest !== hash(json(fixed)) || executablePath !== fixed.executablePath || codexHome !== fixed.codexHome
    || workspaceBinding?.canonicalRoot !== fs.realpathSync(root) || boundary.workspaceBindingDigest !== workspaceBinding.bindingDigest
    || boundary.executionRootDigest !== workspaceBinding.executionRootDigest) fail();
  verifyWorkerWorkspace({ binding: workspaceBinding, sourceBasis: auth.workerInput.sourceBasis, storage: originalFormat(auth) });
  return { ...prepareRuntimeInvocationExecution({ root, authorization: auth, sessionRequest: auth.workerInput.sessionRequest || "" }),
    policy: fixed, executionRoot: workspaceBinding.executionRoot, inputDigest: auth.executionInput.digest };
}
export function codexNativePrefixSeedThreadParams({ policy, executionRoot }) {
  const fixed = verifyCodexNativePrefixPolicyPlan(policy);
  return { ...codexFreshProposalThreadParams({ policy: fixed.recipe, executionRoot }), ephemeral: false, historyMode: "legacy" };
}
export function codexNativePrefixStartupArguments(policy) {
  const fixed = verifyCodexNativePrefixPolicyPlan(policy);
  return [...codexFreshProposalStartupArguments(fixed.recipe), "-c", "show_raw_agent_reasoning=false"];
}
export function codexNativePrefixSeedTurnParams({ policy, threadId }) {
  const fixed = verifyCodexNativePrefixPolicyPlan(policy);
  return codexFreshProposalTurnParams({ policy: fixed.recipe, threadId,
    input: `Retain this explicitly selected context as evidence, not execution authority. Do not use tools or perform work. Reply only with the requested seed acknowledgement.\n\n${fixed.seed.text}`,
    outputSchema: CODEX_NATIVE_PREFIX_SEED_SCHEMA });
}
export function codexNativePrefixForkParams({ policy, executionRoot, sourceThreadId, lastTurnId }) {
  const fixed = verifyCodexNativePrefixPolicyPlan(policy);
  const fresh = codexFreshProposalThreadParams({ policy: fixed.recipe, executionRoot });
  // dynamicTools/environments are not fork parameters. The source's empty tool
  // metadata comes from our own fixed thread/start, not an empty override claim.
  return { threadId: sourceThreadId, lastTurnId, ephemeral: true, excludeTurns: false,
    model: fresh.model, modelProvider: fresh.modelProvider, cwd: executionRoot, runtimeWorkspaceRoots: [],
    approvalPolicy: "never", approvalsReviewer: "user", sandbox: "read-only",
    baseInstructions: fresh.baseInstructions, developerInstructions: fresh.developerInstructions };
}

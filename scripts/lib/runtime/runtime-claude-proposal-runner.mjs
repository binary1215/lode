import { executeClaudeFreshProposalInvocation } from "./runtime-claude-proposal.mjs";
import { verifyClaudeFreshProposalPolicyPlan } from "./runtime-claude-proposal-policy.mjs";

// The detached owner recreates the fixed Claude backend, not a caller-selected
// module or a serialized claim of enforcement. Current executable, profile and
// workspace checks and the at-most-once lease stay inside the invocation.
export default async function runClaudeProposal({
  root,
  executionRoot,
  authorization,
  policy,
  workspaceBinding,
  hostModuleFile = null,
  supervisorSelection = null,
  signal,
  onProcess = () => {},
  verifyWorkspace,
}) {
  const fixed = verifyClaudeFreshProposalPolicyPlan(policy);
  if (hostModuleFile !== null || executionRoot !== workspaceBinding?.executionRoot || root !== workspaceBinding?.canonicalRoot) {
    throw Object.assign(new Error("Claude proposal jobs require the fixed backend and exact selected workspace."), { code: "WORKER_JOB_POLICY_UNAVAILABLE" });
  }
  return await executeClaudeFreshProposalInvocation({
    root,
    authorization,
    policy: fixed,
    workspaceBinding,
    supervisorSelection,
    signal,
    onProcessEvent: onProcess,
    persist: true,
    verifyWorkspace,
  });
}

import { buildWorkerPatchCandidate } from "./worker-patch-basis.mjs";
import { verifyRuntimeInvocationAuthorization, verifyRuntimeStructuredResult } from "./runtime-invocation-lifecycle.mjs";
import { isWorkerPatchProposalMode } from "./worker-patch-proposal-contract.mjs";
export { WORKER_PATCH_PROPOSAL_MODE, isWorkerPatchProposalMode, verifyWorkerPatchProposalExecutionBoundary, workerPatchProposalExecutionBoundary, verifyWorkerPatchProposal } from "./worker-patch-proposal-contract.mjs";
const fail = message => { const error = new Error(message); error.code = "INVALID_WORKER_PATCH_PROPOSAL"; throw error; };

export function buildWorkerPatchProposalCandidate({ authorization, structuredResult }) {
  const verified = verifyRuntimeInvocationAuthorization(authorization);
  if (verified.protocolVersion !== "0.7.0" || !isWorkerPatchProposalMode(verified.workerInput?.executionBoundary?.mode)) {
    fail("Only an exact fresh read-only proposal authorization can produce a proposal candidate.");
  }
  const result = verifyRuntimeStructuredResult(structuredResult, { scopeKind: verified.scope.kind, authorization: verified });
  return buildWorkerPatchCandidate({ basis: verified.workerInput.proposalBasis,
    changes: result.patchProposal.changes, maxBytes: verified.limits.maxInputBytes });
}

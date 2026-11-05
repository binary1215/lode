import crypto from "node:crypto";
import { buildWorkerPatchCandidate, verifyWorkerWriteBasis } from "./worker-patch-basis.mjs";
import { verifyWorkerExecutionBoundary, verifyWorkerWorkspace } from "./worker-workspace.mjs";

export const WORKER_PATCH_PROPOSAL_MODE = "fresh-selected-patch-proposal";
export const isWorkerPatchProposalMode = mode => [WORKER_PATCH_PROPOSAL_MODE, "native-prefix-patch-proposal"].includes(mode);
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = message => { const error = new Error(message); error.code = "INVALID_WORKER_PATCH_PROPOSAL"; throw error; };
const exactFields = (value, fields) => value && typeof value === "object" && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...fields].sort());

// Targets describe evidence the read-only worker may propose changing. They are
// not owned paths, provider write permission, or authority to apply the result.
export function verifyWorkerPatchProposalExecutionBoundary(boundary, sourceBasis, workspaceMode, proposalBasis, maxBytes, storage = undefined) {
  if (!exactFields(boundary, ["mode", "workspaceBindingDigest", "executionRootDigest", "sourceBasisDigest", "policyDigest", "ownedPaths", "proposalBasisDigest"])
    || !isWorkerPatchProposalMode(boundary.mode) || workspaceMode !== "read-only"
    || !Array.isArray(boundary.ownedPaths) || boundary.ownedPaths.length !== 0
    || !/^[a-f0-9]{64}$/.test(boundary.proposalBasisDigest || "")) fail("Proposal execution requires an exact read-only boundary with no owned paths.");
  const { proposalBasisDigest, ...selected } = boundary;
  verifyWorkerExecutionBoundary({ ...selected, mode: "selected-snapshot" }, sourceBasis, "read-only", null, 0, storage);
  verifyWorkerWriteBasis(proposalBasis, maxBytes, storage);
  if (hash(JSON.stringify(proposalBasis)) !== proposalBasisDigest) fail("Proposal preimages differ from their authorized digest.");
  for (const entry of proposalBasis) {
    const source = sourceBasis.find(source => source.path === entry.path);
    if (entry.kind === "absent" ? source !== undefined
      : !source || source.digest !== entry.digest || source.bytes !== entry.bytes) fail("Proposal preimages differ from the selected read evidence.");
  }
  return boundary;
}

export function workerPatchProposalExecutionBoundary({ binding, policy, sourceBasis, proposalBasis, storage }) {
  verifyWorkerWorkspace({ binding, sourceBasis, storage });
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) fail("Proposal policy must be Host supplied.");
  const mode = policy.mode === "native-prefix-patch-proposal" ? policy.mode : WORKER_PATCH_PROPOSAL_MODE;
  return verifyWorkerPatchProposalExecutionBoundary({ mode,
    workspaceBindingDigest: binding.bindingDigest, executionRootDigest: binding.executionRootDigest,
    sourceBasisDigest: binding.sourceBasisDigest, policyDigest: hash(JSON.stringify(policy)), ownedPaths: [],
    proposalBasisDigest: hash(JSON.stringify(proposalBasis)) }, sourceBasis, "read-only", proposalBasis, binding.maxBytes, storage);
}

export function verifyWorkerPatchProposal(proposal, { basis = null, basisDigest = null, maxBytes = 128 * 1024, storage } = {}) {
  if (!exactFields(proposal, ["proposalBasisDigest", "changes"])
    || !/^[a-f0-9]{64}$/.test(proposal.proposalBasisDigest || "")
    || basisDigest !== null && proposal.proposalBasisDigest !== basisDigest
    || !Array.isArray(proposal.changes) || proposal.changes.length > 256
    || Buffer.byteLength(JSON.stringify(proposal)) > 128 * 1024) fail("Patch proposal exceeds its exact shape, lineage or result bound.");
  // Reuse the mechanical path/image checker, never provider-supplied hashes.
  const checkedBasis = basis ?? proposal.changes.map(change => ({ path: change?.path, kind: "absent" })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  buildWorkerPatchCandidate({ basis: checkedBasis, changes: proposal.changes, maxBytes, storage });
  return proposal;
}


import fs from "node:fs";
import path from "node:path";
import {
  historicalBoundaryCanonicalJson,
  historicalBoundaryDigest,
  readCommittedHistoricalArtifactBoundary,
} from "./historical-artifact-boundary-store.mjs";

import { formatForVerifiedOwner, familyFormatForOriginal, relativeProjectArtifact } from "./project-storage-format.mjs";

export const HISTORICAL_CONTINUITY_PROTOCOL_VERSION = "0.1.0";

function fail(message, code = "HISTORICAL_CONTINUITY_ERROR") {
  throw Object.assign(new Error(message), { code });
}

function document(input, storage) {
  const payload = {
    schemaVersion: 1,
    kind: "HistoricalContinuityReceipt",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-historical-continuity"), version: HISTORICAL_CONTINUITY_PROTOCOL_VERSION },
    projectId: input.projectId,
    boundaryId: input.boundaryId,
    boundaryHash: input.boundaryHash,
    historicalCandidateSetId: input.historicalCandidateSetId,
    historicalCandidateSetHash: input.historicalCandidateSetHash,
    currentCandidateSetId: input.currentCandidateSetId,
    currentCandidateSetHash: input.currentCandidateSetHash,
    relation: "HISTORICALLY_FOLLOWS",
    authorityClass: "evidence",
    instructionAuthority: false,
    promotionAuthority: false,
    recoveryAuthority: false,
  };
  const receiptHash = historicalBoundaryDigest(historicalBoundaryCanonicalJson(payload));
  return { ...payload, receiptId: `historical-continuity-${receiptHash.slice(0, 24)}`, receiptHash };
}

export function verifyHistoricalContinuityReceipt(receipt, { boundary, currentCandidateSet } = {}) {
  const payload = { ...receipt };
  delete payload.receiptId;
  delete payload.receiptHash;
  const hash = historicalBoundaryDigest(historicalBoundaryCanonicalJson(payload));
  if (receipt?.kind !== "HistoricalContinuityReceipt" || !familyFormatForOriginal("head-agent-core-historical-continuity", receipt, familyFormatForOriginal("head-agent-core-historical-artifact-boundary", boundary))
    || receipt.protocol?.version !== HISTORICAL_CONTINUITY_PROTOCOL_VERSION || receipt.receiptHash !== hash
    || receipt.receiptId !== `historical-continuity-${hash.slice(0, 24)}` || receipt.relation !== "HISTORICALLY_FOLLOWS"
    || receipt.authorityClass !== "evidence" || receipt.instructionAuthority !== false || receipt.promotionAuthority !== false || receipt.recoveryAuthority !== false
    || receipt.projectId !== boundary?.projectId || receipt.boundaryId !== boundary?.boundaryId || receipt.boundaryHash !== boundary?.boundaryHash
    || receipt.currentCandidateSetId !== currentCandidateSet?.candidateSetId || receipt.currentCandidateSetHash !== currentCandidateSet?.candidateSetHash) {
    fail("Historical continuity receipt is invalid.", "INVALID_HISTORICAL_CONTINUITY_RECEIPT");
  }
  const historical = boundary.entries.find((entry) => entry.role === "historical-candidate-set" && entry.artifactId === receipt.historicalCandidateSetId);
  if (!historical || historical.sha256 !== receipt.historicalCandidateSetHash) fail("Historical continuity source is not in the committed boundary.", "HISTORICAL_CONTINUITY_SOURCE_MISMATCH");
  return receipt;
}

export function publishHistoricalContinuityReceipt({ root = ".", currentCandidateSet, storage } = {}) {
  const application = readCommittedHistoricalArtifactBoundary({ root, allowAbsent: true, storage });
  if (!application) return null;
  const historicalCandidates = application.boundary.entries.filter((entry) => entry.role === "historical-candidate-set");
  const historical = historicalCandidates.find((entry) => entry.artifactId === application.boundary.validatedHistoricalApproval?.candidateSetId)
    || historicalCandidates.at(-1);
  if (!historical) fail("Committed historical boundary has no candidate source.", "HISTORICAL_CONTINUITY_SOURCE_MISMATCH");
  const receipt = document({
    projectId: application.boundary.projectId,
    boundaryId: application.boundary.boundaryId,
    boundaryHash: application.boundary.boundaryHash,
    historicalCandidateSetId: historical.artifactId,
    historicalCandidateSetHash: historical.sha256,
    currentCandidateSetId: currentCandidateSet.candidateSetId,
    currentCandidateSetHash: currentCandidateSet.candidateSetHash,
  }, storage);
  verifyHistoricalContinuityReceipt(receipt, { boundary: application.boundary, currentCandidateSet });
  const directory = path.join(fs.realpathSync(path.resolve(root)), ...relativeProjectArtifact(storage, "onboarding", "historical-continuity").split("/"));
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${receipt.receiptId}.json`);
  const content = `${JSON.stringify(receipt, null, 2)}\n`;
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, "utf8") !== content) fail("Historical continuity identity conflicts.", "HISTORICAL_CONTINUITY_CONFLICT");
  } else fs.writeFileSync(file, content, { flag: "wx" });
  return receipt;
}

export function readHistoricalContinuityReceipts({ root = ".", boundary, currentCandidateSets = [], storage } = {}) {
  const projectRoot = fs.realpathSync(path.resolve(root));
  const directory = path.join(projectRoot, ...relativeProjectArtifact(storage, "onboarding", "historical-continuity").split("/"));
  if (!fs.existsSync(directory)) return [];
  const byId = new Map(currentCandidateSets.map((candidate) => [candidate.candidateSetId, candidate]));
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en")).map((entry) => {
    if (!entry.isFile() || entry.isSymbolicLink() || !/^historical-continuity-[a-f0-9]{24}\.json$/.test(entry.name)) fail("Historical continuity directory is invalid.", "INVALID_HISTORICAL_CONTINUITY_PATH");
    const receipt = JSON.parse(fs.readFileSync(path.join(directory, entry.name), "utf8"));
    return verifyHistoricalContinuityReceipt(receipt, { boundary, currentCandidateSet: byId.get(receipt.currentCandidateSetId) });
  });
}

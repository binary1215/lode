import fs from "node:fs";
import path from "node:path";
import { copiedProjectFile } from "../storage/project-copy-evidence.mjs";
import { readDocumentChangeApplicationReceipt } from "../world/document-change-review.mjs";
import { readProductPolicyReviewDecisionRecord } from "../world/product-policy-records.mjs";
import { verifyProductModelRevisionForProjection } from "../world/product-model-revision-verification.mjs";
import { readWorldModelSnapshot } from "../world/world-model.mjs";
import { sha256Hex } from "../core/digest.mjs";
import { failWith } from "../core/errors.mjs";

const fail = failWith("ONBOARDING_PRODUCT_CANON_DRIFT");

const KEPT_CODES = new Set(["ONBOARDING_PRODUCT_CANON_DRIFT", "ONBOARDING_PRODUCT_SUCCESSOR_UNVERIFIABLE", "DOCUMENT_CHANGE_PROJECTION_LIMIT"]);
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
// Same per-family bounds as the readers that own these records: the
// document-change projection (128 per kind) and Product Policy reviews (1024).
const FAMILIES = [
  ...["applications", "review-decisions", "candidate-sets", "product-model-revisions"].map((kind) => ({
    kind,
    relative: `document-changes/${kind}`,
    max: 128,
    limitCode: "DOCUMENT_CHANGE_PROJECTION_LIMIT",
  })),
  { kind: "policy-review-decisions", relative: "product-policy/review-decisions", max: 1024, limitCode: "ONBOARDING_PRODUCT_SUCCESSOR_UNVERIFIABLE" },
];
const identity = (id, hash) => `${id}:${hash}`;

// Bound the physical originals before the detailed family readers consume
// them. This is a read-only observation, not an index or another authority.
function observeOriginals(root, storage) {
  const files = [];
  let totalBytes = 0;
  for (const family of FAMILIES) {
    const relative = `${storage.directory}/${family.relative}`;
    const directory = copiedProjectFile(root, relative);
    if (!fs.existsSync(directory)) continue;
    const entries = fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.name.endsWith(".json"));
    if (entries.length > family.max) fail(`Product successor records exceed the ${family.max}-record bound: ${family.relative}`, family.limitCode);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = copiedProjectFile(root, `${relative}/${entry.name}`);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES)
        fail(`Product successor record is not a bounded regular file: ${family.relative}/${entry.name}`, "ONBOARDING_PRODUCT_SUCCESSOR_UNVERIFIABLE");
      totalBytes += stat.size;
      if (totalBytes > MAX_TOTAL_BYTES) fail("Product successor records exceed the byte bound.", "ONBOARDING_PRODUCT_SUCCESSOR_UNVERIFIABLE");
      files.push({ path: `${relative}/${entry.name}`, kind: family.kind, sha256: sha256Hex(fs.readFileSync(file)) });
    }
  }
  return files;
}

// Every record read here is verified by its own family reader. Any failure
// other than drift or a family bound means the records cannot prove anything.
function verifiable(read) {
  try {
    return read();
  } catch (error) {
    if (KEPT_CODES.has(error.code)) throw error;
    fail(`Product successor records cannot be verified (${error.code || "unknown"}): ${error.message}`, "ONBOARDING_PRODUCT_SUCCESSOR_UNVERIFIABLE");
  }
}

function documentEdges(root, observed, projectId) {
  const edges = [];
  for (const file of observed.filter((item) => item.kind === "applications")) {
    const verified = readDocumentChangeApplicationReceipt({ root, applicationReceiptId: path.basename(file.path, ".json") });
    const receipt = verified.applicationReceipt,
      review = verified.reviewDecision;
    if (receipt.projectId !== projectId || review.projectId !== projectId)
      fail("Document successor belongs to a different Project.", "ONBOARDING_PRODUCT_SUCCESSOR_UNVERIFIABLE");
    const previous = identity(receipt.previousProductModelId, receipt.previousProductModelHash);
    const resulting = identity(receipt.resultingProductModelId, receipt.resultingProductModelHash);
    // Rejections and no-op receipts leave Canon unchanged: they are not a step.
    if (previous === resulting) continue;
    if (!receipt.canonChanged || !review.promotionAuthority || !verified.resultingProductModelRevision)
      fail("A non-promoting document application cannot advance Product Canon.", "ONBOARDING_PRODUCT_SUCCESSOR_UNVERIFIABLE");
    edges.push({
      id: receipt.applicationReceiptId,
      previous,
      resulting,
      revision: () => verified.resultingProductModelRevision,
      hop: {
        family: "document-change",
        applicationReceiptId: receipt.applicationReceiptId,
        applicationReceiptHash: receipt.applicationReceiptHash,
        reviewDecisionId: review.reviewDecisionId,
        reviewDecisionHash: review.reviewDecisionHash,
        candidateSetId: verified.candidateSet.candidateSetId,
        candidateSetHash: verified.candidateSet.candidateSetHash,
        previousProductModelId: receipt.previousProductModelId,
        previousProductModelHash: receipt.previousProductModelHash,
        resultingProductModelId: receipt.resultingProductModelId,
        resultingProductModelHash: receipt.resultingProductModelHash,
      },
    });
  }
  return edges;
}

// An accepted Product Policy ReviewDecision is the user's explicit approval of
// one exact base -> result Canon change, bound to its candidate by digest.
function policyEdges(root, observed, projectId, storage, readPolicyRevision) {
  const edges = [];
  for (const file of observed.filter((item) => item.kind === "policy-review-decisions")) {
    const { reviewDecision: review, candidate } = readProductPolicyReviewDecisionRecord({
      root,
      reviewDecisionId: path.basename(file.path, ".json"),
      storage,
    });
    if (review.projectId !== projectId) fail("Product Policy successor belongs to a different Project.", "ONBOARDING_PRODUCT_SUCCESSOR_UNVERIFIABLE");
    if (review.disposition !== "accept") continue;
    const previous = identity(review.previousProductModelId, review.previousProductModelHash);
    const resulting = identity(review.resultingProductModelId, review.resultingProductModelHash);
    if (previous === resulting) continue;
    edges.push({
      id: review.reviewDecisionId,
      previous,
      resulting,
      revision: () => readPolicyRevision(review.resultingProductModelId),
      hop: {
        family: "product-policy",
        reviewDecisionId: review.reviewDecisionId,
        reviewDecisionHash: review.reviewDecisionHash,
        candidateId: candidate.candidateId,
        candidateHash: candidate.candidateHash,
        previousProductModelId: review.previousProductModelId,
        previousProductModelHash: review.previousProductModelHash,
        resultingProductModelId: review.resultingProductModelId,
        resultingProductModelHash: review.resultingProductModelHash,
      },
    });
  }
  return edges;
}

// Each reviewed change is written only while Canon equals its previous model,
// so the changes actually applied form one sequence, each starting where the
// previous one ended. Receipts carry no order of their own; this finds such a
// sequence that uses every recorded change exactly once. Its end is fixed by
// the records (the one model entered once more than it is left), so the Canon
// on disk must be the result of the latest change: a later Canon restored by
// hand, or any change made outside review, is drift. Changes recorded before
// the onboarding base (an existing Canon adopted as the base) are a prefix of
// the same sequence; the steps from the base onward are returned.
function sequenceThrough(base, end, edges) {
  const balance = new Map();
  const shift = (node, by) => balance.set(node, (balance.get(node) || 0) + by);
  for (const edge of edges) {
    shift(edge.previous, 1);
    shift(edge.resulting, -1);
  }
  const unbalanced = [...balance].filter(([, value]) => value !== 0);
  let start = end;
  if (unbalanced.length) {
    const first = unbalanced.find(([, value]) => value === 1);
    if (unbalanced.length !== 2 || !first || balance.get(end) !== -1) return null;
    start = first[0];
  }
  // Hierholzer: deterministic order (by record id) among equally valid sequences.
  const outgoing = new Map();
  for (const edge of [...edges].sort((left, right) => right.id.localeCompare(left.id))) {
    if (!outgoing.has(edge.previous)) outgoing.set(edge.previous, []);
    outgoing.get(edge.previous).push(edge);
  }
  const stack = [{ node: start, edge: null }];
  const sequence = [];
  while (stack.length) {
    const top = stack[stack.length - 1];
    const next = outgoing.get(top.node)?.pop();
    if (next) stack.push({ node: next.resulting, edge: next });
    else {
      stack.pop();
      if (top.edge) sequence.push(top.edge);
    }
  }
  sequence.reverse();
  if (sequence.length !== edges.length) return null;
  let cursor = start,
    fromBase = cursor === base ? 0 : -1;
  for (const [index, edge] of sequence.entries()) {
    if (edge.previous !== cursor) return null;
    cursor = edge.resulting;
    if (fromBase < 0 && cursor === base) fromBase = index + 1;
  }
  if (cursor !== end || fromBase < 0 || fromBase === sequence.length) return null;
  return sequence.slice(fromBase);
}

// The caller has verified the completed onboarding review or opaque historical
// boundary. Its base remains unchanged; only reviewed changes on record can
// explain today's different Canon. No projection grants approval.
export async function readOnboardingProductSuccessor({ root, storage, projectId, state, currentModel, baseRevision = null, readPolicyRevision }) {
  if (state.phase !== "ready" || state.projectId !== projectId) fail("Only a completed ready onboarding base can have a reviewed successor.");
  let base;
  if (baseRevision) {
    verifyProductModelRevisionForProjection(baseRevision, storage);
    if (baseRevision.productModelId !== state.productModelId || (baseRevision.projectId && baseRevision.projectId !== projectId))
      fail("Onboarding base revision does not match its owner.");
    base = { family: "onboarding", productModelId: baseRevision.productModelId, productModelHash: baseRevision.productModelHash };
  } else {
    if (state.candidateSetId || state.latestReviewDecisionId || !state.worldModelId) fail("Completed onboarding base revision is unavailable.");
    const { snapshot } = await readWorldModelSnapshot({ root, worldModelId: state.worldModelId });
    if (snapshot.projectId !== projectId || snapshot.productModel.productModelId !== state.productModelId)
      fail("Recorded onboarding World does not prove its original Product base.");
    base = {
      family: "recorded-world",
      worldModelId: state.worldModelId,
      productModelId: snapshot.productModel.productModelId,
      productModelHash: snapshot.productModel.productModelHash,
    };
  }
  const observed = verifiable(() => observeOriginals(root, storage));
  const edges = verifiable(() => [...documentEdges(root, observed, projectId), ...policyEdges(root, observed, projectId, storage, readPolicyRevision)]);
  const sequence = sequenceThrough(
    identity(base.productModelId, base.productModelHash),
    identity(currentModel.productModelId, currentModel.productModelHash),
    edges,
  );
  if (!sequence) fail("The reviewed Product Canon changes on record do not lead from the onboarding base to the current Canon.");
  const last = sequence[sequence.length - 1];
  const currentRevision = verifiable(last.revision);
  if (currentRevision.productModelId !== currentModel.productModelId || currentRevision.productModelHash !== currentModel.productModelHash)
    fail("Reviewed successor revision does not match current Canon.");
  if (JSON.stringify(verifiable(() => observeOriginals(root, storage))) !== JSON.stringify(observed))
    fail("Product successor records changed while being verified.", "ONBOARDING_PRODUCT_SUCCESSOR_UNVERIFIABLE");
  return {
    status: "verified-reviewed-successor",
    base,
    current: { family: last.hop.family, revision: currentRevision },
    hops: sequence.map((edge) => edge.hop),
    hopOrder: "one-sequence-consistent-with-the-records",
    authority: "verified-original-lineage-only",
    instructionAuthority: false,
    promotionAuthority: false,
  };
}

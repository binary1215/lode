import fs from "node:fs";
import path from "node:path";
import { copiedProjectFile } from "../storage/project-copy-evidence.mjs";
import { readDocumentChangeApplicationReceipt, readDocumentChangeReviewDecision } from "../world/document-change-review.mjs";
import { verifyProductModelRevisionForProjection } from "../world/product-model-revision-verification.mjs";
import { readWorldModelSnapshot } from "../world/world-model.mjs";
import { sha256Hex } from "../core/digest.mjs";
import { failWith } from "../core/errors.mjs";

const fail = failWith("ONBOARDING_PRODUCT_SUCCESSOR_UNVERIFIABLE");
const MAX_RECORDS = 128;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const identity = (id, hash) => `${id}:${hash}`;

// Bound the physical originals before the detailed family readers consume
// them. This is a read-only observation, not an index or another authority.
function observeOriginals(root, storage) {
  const files = [];
  let totalBytes = 0;
  for (const kind of ["applications", "review-decisions", "candidate-sets", "product-model-revisions"]) {
    const relative = `${storage.directory}/document-changes/${kind}`;
    const directory = copiedProjectFile(root, relative);
    if (!fs.existsSync(directory)) continue;
    const entries = fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.name.endsWith(".json"));
    if (entries.length > MAX_RECORDS) fail("Document successor originals exceed the record bound.", "ONBOARDING_PRODUCT_SUCCESSOR_LIMIT");
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = copiedProjectFile(root, `${relative}/${entry.name}`);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES)
        fail("Document successor original is not a bounded regular file.", "ONBOARDING_PRODUCT_SUCCESSOR_LIMIT");
      totalBytes += stat.size;
      if (totalBytes > MAX_TOTAL_BYTES) fail("Document successor originals exceed the byte bound.", "ONBOARDING_PRODUCT_SUCCESSOR_LIMIT");
      files.push({ path: `${relative}/${entry.name}`, kind, sha256: sha256Hex(fs.readFileSync(file)) });
    }
  }
  return files;
}

// The caller has verified the completed onboarding review or opaque historical
// boundary. Its base remains unchanged; only an exact applied document-review
// chain can explain today's different Canon. No projection grants approval.
export async function readOnboardingProductSuccessor({ root, storage, projectId, state, currentModel, baseRevision = null }) {
  if (state.phase !== "ready" || state.projectId !== projectId)
    fail("Only a completed ready onboarding base can have a document successor.", "ONBOARDING_PRODUCT_CANON_DRIFT");
  let base;
  if (baseRevision) {
    verifyProductModelRevisionForProjection(baseRevision, storage);
    if (baseRevision.productModelId !== state.productModelId || (baseRevision.projectId && baseRevision.projectId !== projectId))
      fail("Onboarding base revision does not match its owner.", "ONBOARDING_PRODUCT_CANON_DRIFT");
    base = { family: "onboarding", productModelId: baseRevision.productModelId, productModelHash: baseRevision.productModelHash };
  } else {
    if (state.candidateSetId || state.latestReviewDecisionId || !state.worldModelId)
      fail("Completed onboarding base revision is unavailable.", "ONBOARDING_PRODUCT_SUCCESSOR_BASE_MISSING");
    const { snapshot } = await readWorldModelSnapshot({ root, worldModelId: state.worldModelId });
    if (snapshot.projectId !== projectId || snapshot.productModel.productModelId !== state.productModelId)
      fail("Recorded onboarding World does not prove its original Product base.", "ONBOARDING_PRODUCT_CANON_DRIFT");
    base = {
      family: "recorded-world",
      worldModelId: state.worldModelId,
      productModelId: snapshot.productModel.productModelId,
      productModelHash: snapshot.productModel.productModelHash,
    };
  }
  let observed;
  try {
    observed = observeOriginals(root, storage);
  } catch (error) {
    if (error.code?.startsWith("ONBOARDING_")) throw error;
    fail(`Document successor originals cannot be read safely: ${error.code || "unknown"}`);
  }
  const edges = [];
  for (const file of observed.filter((item) => item.kind === "applications")) {
    const applicationReceiptId = path.basename(file.path, ".json");
    const verified = readDocumentChangeApplicationReceipt({ root, applicationReceiptId });
    const receipt = verified.applicationReceipt;
    const review = readDocumentChangeReviewDecision({ root, reviewDecisionId: verified.reviewDecision.reviewDecisionId });
    if (receipt.projectId !== projectId || review.reviewDecision.projectId !== projectId) fail("Document successor belongs to a different Project.");
    const previous = identity(receipt.previousProductModelId, receipt.previousProductModelHash);
    const resulting = identity(receipt.resultingProductModelId, receipt.resultingProductModelHash);
    // Rejections and no-op receipts preserve Canon. They cannot supply a hop,
    // but their presence does not invalidate an otherwise verified successor.
    if (previous === resulting) continue;
    if (!receipt.canonChanged || !review.reviewDecision.promotionAuthority || !review.resultingProductModelRevision)
      fail("A non-promoting document application cannot advance Product Canon.");
    edges.push({ previous, resulting, receipt, review });
  }
  const target = identity(base.productModelId, base.productModelHash);
  let cursor = identity(currentModel.productModelId, currentModel.productModelHash);
  const seen = new Set();
  const chain = [];
  while (cursor !== target) {
    if (seen.has(cursor)) fail("Document successor lineage contains a cycle.", "ONBOARDING_PRODUCT_SUCCESSOR_CYCLE");
    seen.add(cursor);
    const matches = edges.filter((edge) => edge.resulting === cursor);
    if (matches.length !== 1)
      fail(
        matches.length ? "Document successor lineage has distinct competing predecessors." : "No completed document application proves this Product successor.",
        matches.length ? "ONBOARDING_PRODUCT_SUCCESSOR_AMBIGUOUS" : "ONBOARDING_PRODUCT_CANON_DRIFT",
      );
    chain.push(matches[0]);
    cursor = matches[0].previous;
  }
  if (!chain.length) fail("A different Product Canon requires an applied successor.", "ONBOARDING_PRODUCT_CANON_DRIFT");
  const currentRevision = chain[0].review.resultingProductModelRevision;
  if (currentRevision.productModelId !== currentModel.productModelId || currentRevision.productModelHash !== currentModel.productModelHash)
    fail("Document successor revision does not match current Canon.", "ONBOARDING_PRODUCT_CANON_DRIFT");
  if (JSON.stringify(observeOriginals(root, storage)) !== JSON.stringify(observed))
    fail("Document successor originals changed while being verified.", "ONBOARDING_PRODUCT_SUCCESSOR_SOURCE_CHANGED");
  return {
    status: "verified-document-successor",
    base,
    current: { family: "document-change", revision: currentRevision },
    hops: chain.reverse().map(({ receipt, review }) => ({
      applicationReceiptId: receipt.applicationReceiptId,
      applicationReceiptHash: receipt.applicationReceiptHash,
      reviewDecisionId: review.reviewDecision.reviewDecisionId,
      reviewDecisionHash: review.reviewDecision.reviewDecisionHash,
      candidateSetId: review.candidateSet.candidateSetId,
      candidateSetHash: review.candidateSet.candidateSetHash,
      previousProductModelId: receipt.previousProductModelId,
      previousProductModelHash: receipt.previousProductModelHash,
      resultingProductModelId: receipt.resultingProductModelId,
      resultingProductModelHash: receipt.resultingProductModelHash,
    })),
    authority: "verified-original-lineage-only",
    instructionAuthority: false,
    promotionAuthority: false,
  };
}

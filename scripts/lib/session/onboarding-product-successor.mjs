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
// so the changes actually applied after the onboarding base form one sequence
// from that base, each starting where the previous one ended. Receipts carry
// no order of their own; this finds such a sequence that uses every recorded
// change exactly once. Its start is the base and its end is fixed by the
// records (the one model entered once more than it is left, or the base when
// every model is entered as often as it is left), so the Canon on disk must be
// the result of the latest change: a Canon restored by hand to an earlier
// reviewed result, or any change made outside review, is drift.
function sequenceFrom(start, end, edges) {
  const balance = new Map();
  const shift = (node, by) => balance.set(node, (balance.get(node) || 0) + by);
  for (const edge of edges) {
    shift(edge.previous, 1);
    shift(edge.resulting, -1);
  }
  for (const [node, value] of balance) {
    const expected = start === end ? 0 : node === start ? 1 : node === end ? -1 : 0;
    if (value !== expected) return null;
  }
  if (start !== end && (balance.get(start) !== 1 || balance.get(end) !== -1)) return null;
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
  let cursor = start;
  for (const edge of sequence) {
    if (edge.previous !== cursor) return null;
    cursor = edge.resulting;
  }
  return cursor === end ? sequence : null;
}

// Changes already on record when the base was established precede it (an
// existing Canon adopted as the base, or a later onboarding review that moved
// the base). The World recorded with the onboarding state names exactly those
// records; without that World nothing is treated as preceding the base.
async function recordsBeforeBase(root, state, snapshot = null) {
  let world = snapshot;
  if (!world) {
    if (!state.worldModelId) return null;
    try {
      world = (await readWorldModelSnapshot({ root, worldModelId: state.worldModelId })).snapshot;
    } catch (error) {
      if (["WORLD_MODEL_NOT_BUILT", "WORLD_MODEL_SNAPSHOT_MISSING"].includes(error.code)) return null;
      throw error;
    }
  }
  const graph = world.temporalProvenanceGraph || {};
  const receipts = graph.documentChangeProjection?.applicationReceiptIds;
  const policies = graph.productPolicyProjection?.reviewDecisionIds;
  if (!Array.isArray(receipts) && !Array.isArray(policies)) return null;
  return new Set([...(Array.isArray(receipts) ? receipts : []), ...(Array.isArray(policies) ? policies : [])]);
}
const afterBase = (edges, before) => (before ? edges.filter((edge) => !before.has(edge.id)) : edges);

// Per process: the same records, base and Canon give the same verified answer.
const verifiedSequences = new Map();
const MAX_CACHED = 32;

// The caller has verified the completed onboarding review or opaque historical
// boundary. Its base remains unchanged; only reviewed changes on record can
// explain today's different Canon. No projection grants approval.
export async function readOnboardingProductSuccessor({ root, storage, projectId, state, currentModel, baseRevision = null, readPolicyRevision }) {
  if (state.phase !== "ready" || state.projectId !== projectId) fail("Only a completed ready onboarding base can have a reviewed successor.");
  let base,
    baseWorld = null;
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
    baseWorld = snapshot;
    base = {
      family: "recorded-world",
      worldModelId: state.worldModelId,
      productModelId: snapshot.productModel.productModelId,
      productModelHash: snapshot.productModel.productModelHash,
    };
  }
  const start = identity(base.productModelId, base.productModelHash),
    end = identity(currentModel.productModelId, currentModel.productModelHash);
  const observed = verifiable(() => observeOriginals(root, storage));
  const key = JSON.stringify([root, storage.directory, projectId, state.worldModelId || null, start, end, observed]);
  if (verifiedSequences.has(key)) {
    const cached = structuredClone(verifiedSequences.get(key));
    // A Policy result revision lives outside the observed records: reread it.
    if (cached.current.family === "product-policy") {
      const revision = verifiable(() => readPolicyRevision(currentModel.productModelId));
      if (revision.productModelHash !== currentModel.productModelHash) fail("Reviewed successor revision does not match current Canon.");
    }
    return cached;
  }
  const before = await recordsBeforeBase(root, state, baseWorld);
  const edges = afterBase(
    verifiable(() => [...documentEdges(root, observed, projectId), ...policyEdges(root, observed, projectId, storage, readPolicyRevision)]),
    before,
  );
  const sequence = start === end ? null : sequenceFrom(start, end, edges);
  if (!sequence || !sequence.length) fail("The reviewed Product Canon changes on record do not lead from the onboarding base to the current Canon.");
  const last = sequence[sequence.length - 1];
  const currentRevision = verifiable(last.revision);
  if (currentRevision.productModelId !== currentModel.productModelId || currentRevision.productModelHash !== currentModel.productModelHash)
    fail("Reviewed successor revision does not match current Canon.");
  if (JSON.stringify(verifiable(() => observeOriginals(root, storage))) !== JSON.stringify(observed))
    fail("Product successor records changed while being verified.", "ONBOARDING_PRODUCT_SUCCESSOR_UNVERIFIABLE");
  const result = {
    status: "verified-reviewed-successor",
    base,
    current: { family: last.hop.family, revision: currentRevision },
    hops: sequence.map((edge) => edge.hop),
    hopOrder: "one-sequence-consistent-with-the-records",
    authority: "verified-original-lineage-only",
    instructionAuthority: false,
    promotionAuthority: false,
  };
  if (verifiedSequences.size >= MAX_CACHED) verifiedSequences.delete(verifiedSequences.keys().next().value);
  verifiedSequences.set(key, structuredClone(result));
  return result;
}

// Canon equal to the onboarding base is ready unless the reviewed changes on
// record after the base end elsewhere (a later Canon put back by hand, or an
// accepted Product Policy review whose Canon write did not complete). Records
// are first read as plain JSON; only an apparent mismatch is verified in full.
// Records that cannot be read here keep the previous answer (ready).
export async function verifyOnboardingCanonAtBase({ root, storage, projectId, state, currentModel, readPolicyRevision }) {
  if (state.phase !== "ready" || state.projectId !== projectId) return;
  const base = identity(currentModel.productModelId, currentModel.productModelHash);
  let observed, raw;
  try {
    observed = observeOriginals(root, storage);
    raw = [];
    for (const file of observed) {
      if (!["applications", "policy-review-decisions"].includes(file.kind)) continue;
      const record = JSON.parse(fs.readFileSync(copiedProjectFile(root, file.path), "utf8"));
      const accepted = file.kind === "applications" ? record.canonChanged === true : record.disposition === "accept";
      const previous = identity(record.previousProductModelId, record.previousProductModelHash);
      const resulting = identity(record.resultingProductModelId, record.resultingProductModelHash);
      if (accepted && previous !== resulting) raw.push({ id: path.basename(file.path, ".json"), previous, resulting });
    }
  } catch {
    return;
  }
  if (!raw.length || sequenceFrom(base, base, raw)) return;
  let before;
  try {
    before = await recordsBeforeBase(root, state);
  } catch {
    return;
  }
  const remaining = afterBase(raw, before);
  if (!remaining.length || sequenceFrom(base, base, remaining)) return;
  let edges;
  try {
    edges = afterBase([...documentEdges(root, observed, projectId), ...policyEdges(root, observed, projectId, storage, readPolicyRevision)], before);
  } catch {
    return;
  }
  if (edges.length && !sequenceFrom(base, base, edges))
    fail("Product Canon equals the onboarding base, but the reviewed changes on record after the base end at another Canon.");
}

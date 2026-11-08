import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeProject } from "../../../scripts/lib/head-core.mjs";
import { reviewOnboarding, startOnboarding } from "../../../scripts/lib/onboarding.mjs";
import { onboardingCanonicalJson, onboardingDigest } from "../../../scripts/lib/onboarding-contract.mjs";

export const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function identified(document, idField, hashField, prefix) {
  const payload = structuredClone(document);
  delete payload[idField];
  delete payload[hashField];
  const hash = onboardingDigest(onboardingCanonicalJson(payload));
  return { ...payload, [idField]: `${prefix}-${hash.slice(0, 24)}`, [hashField]: hash };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function legacyReadyFixture({ version = "0.3.0", opaquePreviousRevision = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "head-mig-r3-")));
  fs.writeFileSync(path.join(root, "README.md"), "# Delivery service\n");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "delivery.mjs"), "export const deliver = value => ({ delivered: value });\n");
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const started = await startOnboarding({
    root,
    mode: "new",
    brief: {
      schemaVersion: 1,
      name: "Delivery",
      summary: "Deliver one message.",
      capabilities: [{ key: "delivery", name: "Delivery", description: "Deliver a message." }],
    },
  });
  const accepted = await reviewOnboarding({
    root,
    candidateSetId: started.candidateSet.candidateSetId,
    disposition: "accept-all",
    rationale: "Fixture-only approval.",
  });
  const oldCandidateFile = path.join(root, ".head", "onboarding", "candidate-sets", `${started.candidateSet.candidateSetId}.json`);
  const oldReviewFile = path.join(root, ".head", "onboarding", "review-decisions", `${accepted.reviewDecision.reviewDecisionId}.json`);
  const legacyCandidates = started.candidateSet.candidates.map((item) =>
    identified({ ...item, producer: "head-agent-core-onboarding-inference", producerVersion: version }, "candidateId", "candidateHash", "onboarding-candidate"),
  );
  const candidatePayload = structuredClone(started.candidateSet);
  delete candidatePayload.candidateSetId;
  delete candidatePayload.candidateSetHash;
  candidatePayload.protocol.version = version;
  candidatePayload.candidates = legacyCandidates;
  candidatePayload.limits = { maxInferredSymbols: 24, maxCandidates: 200, maxEvidenceRecords: 250, maxUnknowns: 100 };
  delete candidatePayload.producerReviewDecisionId;
  delete candidatePayload.worldModelId;
  if (version === "0.1.0") {
    candidatePayload.worldModelId = accepted.state.worldModelId;
    candidatePayload.reviewDecisionId = null;
  } else if (version === "0.2.0") candidatePayload.reviewDecisionId = null;
  else candidatePayload.producerReviewDecisionId = null;
  const candidate = identified(candidatePayload, "candidateSetId", "candidateSetHash", "onboarding-candidates");
  const reviewPayload = structuredClone(accepted.reviewDecision);
  delete reviewPayload.reviewDecisionId;
  delete reviewPayload.reviewDecisionHash;
  reviewPayload.candidateSetId = candidate.candidateSetId;
  reviewPayload.acceptedCandidateIds = legacyCandidates.map((item) => item.candidateId).sort();
  reviewPayload.lineage = reviewPayload.lineage.map((lineage) =>
    lineage.relation === "reviews-candidate-set" ? { ...lineage, targetId: candidate.candidateSetId } : lineage,
  );
  const review = identified(reviewPayload, "reviewDecisionId", "reviewDecisionHash", "onboarding-review-decision");
  const stateFile = path.join(root, ".head", "onboarding", "current.json");
  const statePayload = structuredClone(accepted.state);
  delete statePayload.pointerHash;
  statePayload.candidateSetId = candidate.candidateSetId;
  statePayload.latestReviewDecisionId = review.reviewDecisionId;
  const state = { ...statePayload, pointerHash: onboardingDigest(onboardingCanonicalJson(statePayload)) };
  writeJson(path.join(path.dirname(oldCandidateFile), `${candidate.candidateSetId}.json`), candidate);
  writeJson(path.join(path.dirname(oldReviewFile), `${review.reviewDecisionId}.json`), review);
  fs.unlinkSync(oldCandidateFile);
  fs.unlinkSync(oldReviewFile);
  writeJson(stateFile, state);
  if (opaquePreviousRevision) {
    const file = path.join(root, ".head", "onboarding", "product-model-revisions", `${review.previousProductModelId}.json`);
    const revision = JSON.parse(fs.readFileSync(file, "utf8"));
    delete revision.authority;
    writeJson(file, revision);
  }
  return { root, started, accepted, candidate, review, state };
}

export async function legacyRevisedReadyFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "head-mig-r3-chain-")));
  fs.writeFileSync(path.join(root, "README.md"), "# Delivery service\n");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "delivery.mjs"), "export const deliver = value => ({ delivered: value });\n");
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const started = await startOnboarding({
    root,
    mode: "new",
    brief: {
      schemaVersion: 1,
      name: "Delivery",
      summary: "Deliver one message.",
      capabilities: [{ key: "delivery", name: "Delivery", description: "Deliver a message." }],
    },
  });
  const sourceCapability = started.candidateSet.candidates.find((candidate) => candidate.productKind === "Capability");
  const revised = await reviewOnboarding({
    root,
    candidateSetId: started.candidateSet.candidateSetId,
    disposition: "revise",
    userEdits: [{ candidateId: sourceCapability.candidateId, entity: { ...sourceCapability.proposedEntity, name: "Reviewed Delivery" } }],
    rationale: "Fixture-only revision.",
  });
  const accepted = await reviewOnboarding({
    root,
    candidateSetId: revised.candidateSet.candidateSetId,
    disposition: "accept-all",
    rationale: "Fixture-only revised approval.",
  });
  const legacyCandidate = (source, { parents, producerReviewDecisionId }) => {
    const payload = structuredClone(source);
    delete payload.candidateSetId;
    delete payload.candidateSetHash;
    payload.protocol.version = "0.3.0";
    payload.parentCandidateSetIds = parents;
    payload.producerReviewDecisionId = producerReviewDecisionId;
    payload.candidates = payload.candidates.map((item) =>
      identified(
        { ...item, producer: "head-agent-core-onboarding-inference", producerVersion: "0.3.0" },
        "candidateId",
        "candidateHash",
        "onboarding-candidate",
      ),
    );
    payload.limits = { maxInferredSymbols: 24, maxCandidates: 200, maxEvidenceRecords: 250, maxUnknowns: 100 };
    delete payload.worldModelId;
    return identified(payload, "candidateSetId", "candidateSetHash", "onboarding-candidates");
  };
  const firstCandidate = legacyCandidate(started.candidateSet, { parents: [], producerReviewDecisionId: null });
  const firstReviewPayload = structuredClone(revised.reviewDecision);
  delete firstReviewPayload.reviewDecisionId;
  delete firstReviewPayload.reviewDecisionHash;
  firstReviewPayload.candidateSetId = firstCandidate.candidateSetId;
  firstReviewPayload.acceptedCandidateIds = [];
  firstReviewPayload.rejectedCandidateIds = [];
  firstReviewPayload.lineage = firstReviewPayload.lineage.map((lineage) =>
    lineage.relation === "reviews-candidate-set" ? { ...lineage, targetId: firstCandidate.candidateSetId } : lineage,
  );
  const firstReview = identified(firstReviewPayload, "reviewDecisionId", "reviewDecisionHash", "onboarding-review-decision");
  const secondCandidate = legacyCandidate(revised.candidateSet, {
    parents: [firstCandidate.candidateSetId],
    producerReviewDecisionId: firstReview.reviewDecisionId,
  });
  const secondReviewPayload = structuredClone(accepted.reviewDecision);
  delete secondReviewPayload.reviewDecisionId;
  delete secondReviewPayload.reviewDecisionHash;
  secondReviewPayload.candidateSetId = secondCandidate.candidateSetId;
  secondReviewPayload.acceptedCandidateIds = secondCandidate.candidates.map((candidate) => candidate.candidateId).sort();
  secondReviewPayload.lineage = secondReviewPayload.lineage.map((lineage) =>
    lineage.relation === "reviews-candidate-set" ? { ...lineage, targetId: secondCandidate.candidateSetId } : lineage,
  );
  const secondReview = identified(secondReviewPayload, "reviewDecisionId", "reviewDecisionHash", "onboarding-review-decision");
  const candidateDirectory = path.join(root, ".head", "onboarding", "candidate-sets");
  const reviewDirectory = path.join(root, ".head", "onboarding", "review-decisions");
  for (const file of fs.readdirSync(candidateDirectory)) fs.rmSync(path.join(candidateDirectory, file));
  for (const file of fs.readdirSync(reviewDirectory)) fs.rmSync(path.join(reviewDirectory, file));
  writeJson(path.join(candidateDirectory, `${firstCandidate.candidateSetId}.json`), firstCandidate);
  writeJson(path.join(candidateDirectory, `${secondCandidate.candidateSetId}.json`), secondCandidate);
  writeJson(path.join(reviewDirectory, `${firstReview.reviewDecisionId}.json`), firstReview);
  writeJson(path.join(reviewDirectory, `${secondReview.reviewDecisionId}.json`), secondReview);
  const stateFile = path.join(root, ".head", "onboarding", "current.json");
  const statePayload = structuredClone(accepted.state);
  delete statePayload.pointerHash;
  statePayload.candidateSetId = secondCandidate.candidateSetId;
  statePayload.latestReviewDecisionId = secondReview.reviewDecisionId;
  const state = { ...statePayload, pointerHash: onboardingDigest(onboardingCanonicalJson(statePayload)) };
  writeJson(stateFile, state);
  return { root, firstCandidate, firstReview, secondCandidate, secondReview, state };
}

export function snapshotFiles(root, predicate = () => true) {
  const output = {};
  const visit = (directory) => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) visit(file);
      else {
        const relative = path.relative(root, file).replaceAll("\\", "/");
        if (predicate(relative)) output[relative] = fs.readFileSync(file).toString("base64");
      }
    }
  };
  visit(root);
  return output;
}

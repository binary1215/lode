import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { formatForVerifiedOwner } from "../scripts/lib/project-storage-format.mjs";
import { buildWorldModel } from "../scripts/lib/world-model.mjs";
import { recordProductSignal, recordProductHypothesis, proposeProductInitiative, reviewProductInitiative, observeProductOutcome } from "../scripts/lib/product-operating-loop.mjs";
import { compileContext } from "../scripts/lib/context-compiler.mjs";
import { createWholePlanSnapshot, createExecutionContract } from "../scripts/lib/execution-lineage.mjs";
import { startRun, finishRun, getPendingReviewContext, reviewRun } from "../scripts/lib/run-lineage.mjs";
import { recordChangeSet } from "../scripts/lib/change-set.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deferred = { status: "deferred", reasonCode: "INVALID_WORLD_MODEL_STORE_DOCUMENT", ordinaryWorkBlocked: false };
const signalInput = { statement: "A synthetic interface failure was observed.", observedAt: "2026-10-16T00:00:00.000Z" };

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(process.env.HEAD_AGENT_TEST_TMP || os.tmpdir(), "head-product-projection-result-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  const layout = formatForVerifiedOwner(storage);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/fixture.mjs"), "export const fixture = true;\n");
  await buildWorldModel({ root, persist: true });
  return { root, storage, layout };
}

function breakWorld(root, layout) {
  const pointer = path.join(root, layout.directory, "world-model/current.json");
  fs.writeFileSync(pointer, "{invalid-world-pointer");
  return { pointer, bytes: fs.readFileSync(pointer) };
}

function preserved(root, layout) {
  return [`${layout.directory}/project.json`, `${layout.directory}/sessions/current.json`, `${layout.directory}/context/product-model.json`]
    .filter(relative => fs.existsSync(path.join(root, relative)))
    .map(relative => [relative, fs.readFileSync(path.join(root, relative))]);
}

function assertPreserved(root, originals, broken) {
  for (const [relative, bytes] of originals) assert.deepEqual(fs.readFileSync(path.join(root, relative)), bytes);
  assert.deepEqual(fs.readFileSync(broken.pointer), broken.bytes);
}

test("committed Signal returns exact identity independently of failed derived projection; exact retry converges", async t => {
  const { root, layout } = await fixture(t), originals = preserved(root, layout), broken = breakWorld(root, layout);
  const first = await recordProductSignal({ root, ...signalInput });
  assert.equal(first.status, "recorded");
  assert.deepEqual(first.productGraph, deferred);
  assert.equal(path.basename(first.file), `${first.signal.signalId}.json`);
  assert.deepEqual(JSON.parse(fs.readFileSync(first.file, "utf8")), first.signal);
  const before = fs.readFileSync(first.file);
  const second = await recordProductSignal({ root, ...signalInput });
  assert.equal(second.status, "existing");
  assert.deepEqual(second.signal, first.signal);
  assert.deepEqual(second.productGraph, deferred);
  assert.deepEqual(fs.readFileSync(first.file), before);
  assert.equal(fs.readdirSync(path.dirname(first.file)).filter(name => name.endsWith(".json")).length, 1);
  assertPreserved(root, originals, broken);
});

test("normal projection response retains exactly its three existing identity fields", async t => {
  const { root, layout } = await fixture(t);
  const recorded = await recordProductSignal({ root, ...signalInput });
  assert.equal(recorded.status, "recorded");
  assert.deepEqual(Object.keys(recorded.productGraph).sort(), ["graphSnapshotId", "projectionInputId", "worldModelId"]);
  for (const value of Object.values(recorded.productGraph)) assert.equal(typeof value, "string");
});

test("Hypothesis, Initiative and both exact review paths preserve committed records on projection failure", async t => {
  const { root, layout } = await fixture(t);
  const signal = await recordProductSignal({ root, ...signalInput });
  const originals = preserved(root, layout), broken = breakWorld(root, layout);
  const hypothesis = await recordProductHypothesis({ root, statement: "An interface defect may explain the observation.", signalIds: [signal.signal.signalId] });
  assert.equal(hypothesis.status, "recorded");
  assert.deepEqual(hypothesis.productGraph, deferred);
  const proposed = await proposeProductInitiative({ root, title: "Improve the interface", hypothesisIds: [hypothesis.hypothesis.hypothesisId], featureResolution: { kind: "candidate", feature: { key: "interface", name: "Interface", capabilityKeys: [] } } });
  assert.equal(proposed.status, "recorded");
  assert.deepEqual(proposed.productGraph, deferred);
  assert.ok(fs.existsSync(proposed.file));
  assert.ok(proposed.featureCandidate.featureCandidateId);
  const request = { root, initiativeCandidateId: proposed.initiativeCandidate.initiativeCandidateId, disposition: "accept", rationale: "Accept this bounded proposal, not Product Canon." };
  const reviewed = await reviewProductInitiative(request);
  assert.equal(reviewed.status, "initiative_accepted");
  assert.equal(reviewed.persistenceStatus, "recorded");
  assert.equal(reviewed.productCanonMutated, false);
  assert.deepEqual(reviewed.productGraph, deferred);
  const replay = await reviewProductInitiative(request);
  assert.equal(replay.persistenceStatus, "existing");
  assert.deepEqual(replay.reviewDecision, reviewed.reviewDecision);
  assert.deepEqual(replay.productGraph, deferred);
  await assert.rejects(() => reviewProductInitiative({ ...request, disposition: "reject" }), { code: "PRODUCT_INITIATIVE_ALREADY_REVIEWED" });
  assertPreserved(root, originals, broken);
});

test("Outcome returns its exact committed evidence without claiming Feature success or recovery authority", async t => {
  const { root, layout } = await fixture(t);
  const capsule = (await compileContext({ root, task: "Synthetic bounded implementation", budget: 32_768, persist: true }));
  const plan = createWholePlanSnapshot({ root, objective: "Synthetic bounded implementation", plan: [{ id: "change", outcome: "A verified synthetic change" }] });
  const contract = createExecutionContract({ root, wholePlanId: plan.artifact.wholePlanId, capsuleId: capsule.capsule.capsuleId, scope: "Synthetic fixture only", acceptanceCriteria: ["Return fixture evidence"] });
  startRun({ root, executionContractId: contract.artifact.executionContractId });
  fs.appendFileSync(path.join(root, "src/fixture.mjs"), "export const changed = true;\n");
  const finished = finishRun({ root, outcome: "Synthetic fixture result", evidence: [{ uri: "fixture", digest: "synthetic", summary: "Synthetic evidence" }], verification: [{ check: "fixture", status: "passed" }] });
  const pending = getPendingReviewContext({ root });
  const review = reviewRun({ root, reviewContextId: pending.review.reviewContextId, disposition: "accept", rationale: "Accept exact synthetic result." });
  await buildWorldModel({ root, persist: true });
  const change = await recordChangeSet({ root, resultPacketId: finished.resultPacket.resultPacketId, reviewDecisionId: review.reviewDecision.reviewDecisionId });
  const originals = preserved(root, layout), broken = breakWorld(root, layout);
  const request = { root, changeSetId: change.changeSet.changeSetId, statement: "The synthetic change was observed." };
  const result = await observeProductOutcome(request);
  assert.equal(result.status, "recorded");
  assert.deepEqual(result.productGraph, deferred);
  assert.equal(result.featureStatusMutated, false);
  assert.equal(result.successJudgmentRecorded, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(result.file, "utf8")), result.outcomeObservation);
  const replay = await observeProductOutcome(request);
  assert.equal(replay.status, "existing");
  assert.deepEqual(replay.outcomeObservation, result.outcomeObservation);
  assertPreserved(root, originals, broken);
});

test("invalid input and referenced evidence digest still fail before primary publication", async t => {
  const { root, layout } = await fixture(t);
  await assert.rejects(() => recordProductSignal({ root, statement: "" }), { code: "INVALID_PRODUCT_OPERATING_INPUT" });
  const signal = await recordProductSignal({ root, ...signalInput });
  const document = JSON.parse(fs.readFileSync(signal.file, "utf8"));
  document.statement = "Tampered source";
  fs.writeFileSync(signal.file, JSON.stringify(document));
  await assert.rejects(() => recordProductHypothesis({ root, statement: "Do not accept tampered evidence.", signalIds: [signal.signal.signalId] }), { code: "PRODUCT_OPERATING_DIGEST_MISMATCH" });
  assert.equal(fs.existsSync(path.join(root, layout.directory, "product-operations/hypotheses")), false);
  await assert.rejects(() => recordProductSignal({ root, ...signalInput }), { code: "PRODUCT_OPERATING_IMMUTABLE_COLLISION" });
});

test("primary permission and uncertain publication errors are never converted into projection success", async t => {
  const { root, layout } = await fixture(t);
  const originalLink = fs.linkSync;
  const signalDirectory = path.join(root, layout.directory, "product-operations/signals");
  for (const publishFirst of [false, true]) {
    let injected = 0;
    fs.linkSync = function(source, destination, ...rest) {
      if (path.dirname(path.resolve(String(destination))) === signalDirectory) {
        injected += 1;
        if (publishFirst) originalLink.call(fs, source, destination, ...rest);
        throw Object.assign(new Error("Synthetic primary publication failure"), { code: publishFirst ? "EIO" : "EACCES" });
      }
      return originalLink.call(fs, source, destination, ...rest);
    };
    try {
      await assert.rejects(() => recordProductSignal({ root, ...signalInput, statement: `Synthetic primary failure ${publishFirst}` }), { code: publishFirst ? "EIO" : "EACCES" });
      assert.equal(injected, 1);
    } finally { fs.linkSync = originalLink; }
  }
  assert.equal(fs.readdirSync(signalDirectory).filter(name => name.endsWith(".json")).length, 1);
});

test("partial multi-record Initiative publication remains an error and preserves the committed prefix", async t => {
  const { root, layout } = await fixture(t);
  const originalLink = fs.linkSync;
  const candidateDirectory = path.join(root, layout.directory, "product-operations/initiative-candidates");
  fs.linkSync = function(source, destination, ...rest) {
    if (path.dirname(path.resolve(String(destination))) === candidateDirectory) throw Object.assign(new Error("Synthetic last primary write failure"), { code: "EIO" });
    return originalLink.call(fs, source, destination, ...rest);
  };
  try {
    await assert.rejects(() => proposeProductInitiative({ root, title: "Partial primary must not become success", reasoning: "Synthetic bounded test", featureResolution: { kind: "candidate", feature: { key: "partial", name: "Partial", capabilityKeys: [] } } }), { code: "EIO" });
  } finally { fs.linkSync = originalLink; }
  const prefixDirectory = path.join(root, layout.directory, "product-operations/feature-candidates");
  assert.equal(fs.readdirSync(prefixDirectory).filter(name => name.endsWith(".json")).length, 1);
  assert.equal(fs.readdirSync(candidateDirectory).filter(name => name.endsWith(".json")).length, 0);
});

test("post-commit error diagnostics are bounded and never echo paths or arbitrary error text", async t => {
  const { root, layout } = await fixture(t);
  const originalStat = fs.statSync;
  const signalDirectory = path.join(root, layout.directory, "product-operations/signals");
  let injected = 0;
  fs.statSync = function(file, ...rest) {
    if (path.dirname(path.resolve(String(file))) === signalDirectory) {
      injected += 1;
      throw Object.assign(new Error("private/path and arbitrary detail"), { code: "private/path\nUNTRUSTED" });
    }
    return originalStat.call(fs, file, ...rest);
  };
  let result;
  try { result = await recordProductSignal({ root, ...signalInput }); }
  finally { fs.statSync = originalStat; }
  assert.ok(injected > 0);
  assert.equal(result.status, "recorded");
  assert.deepEqual(result.productGraph, { status: "deferred", reasonCode: "PRODUCT_OPERATING_PROJECTION_FAILED", ordinaryWorkBlocked: false });
  assert.equal(JSON.stringify(result.productGraph).includes("private"), false);
});

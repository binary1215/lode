import { worldSnapshotFile, graphSnapshotFile, readFixtureSnapshot, writeFixtureSnapshot } from "./helpers/snapshot-storage-fixture.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import { readSnapshotFile } from "../scripts/lib/snapshot-storage-codec.mjs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { formatForVerifiedOwner } from "../scripts/lib/project-storage-format.mjs";
import { initializeOrResumeProject, inspectProjectExperience } from "../scripts/lib/project-bootstrap.mjs";
import { inspectOnboarding, recoverOnboardingPromotion, refreshOnboardingCandidates, restoreOnboardingCandidate, reviewOnboarding, startOnboarding } from "../scripts/lib/onboarding.mjs";
import crypto from "node:crypto";
import { inspectConversationalOnboarding } from "../scripts/lib/onboarding-conversation.mjs";
import { enterConversationRecovery } from "../scripts/lib/compaction-lifecycle.mjs";
import { readProductModelCanon } from "../scripts/lib/product-model.mjs";
import { inspectWorldModel } from "../scripts/lib/world-model.mjs";
import { createHeadSession, withSessionRoute } from "../scripts/lib/session-routing.mjs";
import { createRecoveryCheckpoint } from "../scripts/lib/compaction-recovery.mjs";
import { updateProjectDirection } from "../scripts/lib/project-direction.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const moduleUrl = new URL("../scripts/lib/onboarding.mjs", import.meta.url).href;

async function fixture() {
  const root = fs.mkdtempSync(path.join(pluginRoot, ".qa-onboarding-recovery-"));
  try {
    fs.writeFileSync(path.join(root, "README.md"), "# Message delivery service\n");
    initializeProject({ root, pluginRoot, runtimes: ["codex"] });
    const storage = inspectProject(root).storage, layout = formatForVerifiedOwner(storage);
    const canonPath = `${layout.directory}/context/product-model.json`;
    const statePath = `${layout.directory}/onboarding/current.json`;
    const reviewDirectory = `${layout.directory}/onboarding/review-decisions`;
    const started = await startOnboarding({
      root, mode: "new", brief: {
        schemaVersion: 1, name: "Message service", summary: "Deliver one reviewed message.",
        capabilities: [{ key: "delivery", name: "Delivery", description: "Deliver a message." }],
      },
    });
    return { root, storage, layout, canonPath, statePath, reviewDirectory, request: { root, candidateSetId: started.candidateSet.candidateSetId, disposition: "accept-all", rationale: "Adopt the reviewed delivery capability." } };
  } catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error; }
}

function authorityBytes(root, layout) {
  return [`${layout.directory}/project.json`, `${layout.directory}/sessions/current.json`, `${layout.directory}/context/product-model.json`, `${layout.directory}/onboarding/current.json`]
    .map((relative) => fs.readFileSync(path.join(root, relative), "utf8"));
}

test("optional candidate damage cannot block public Core entry or resume", async () => {
  const { root, layout, canonPath, statePath, reviewDirectory, request } = await fixture();
  try {
    const file = path.join(root, layout.directory, "onboarding/candidate-sets", `${request.candidateSetId}.json`);
    const original = fs.readFileSync(file);
    const p2 = authorityBytes(root, layout).slice(0, 2);
    for (const fault of ["schema", "parse", "missing"]) {
      if (fault === "missing") fs.unlinkSync(file);
      else fs.writeFileSync(file, fault === "parse" ? "{" : JSON.stringify({ ...JSON.parse(original), schemaVersion: 99 }));
      const status = (await inspectProjectExperience({ root }));
      assert.equal(status.readiness.core.state, "ready");
      assert.equal(status.readiness.product.state, "integrity_attention");
      assert.equal(status.attention.ordinaryWorkBlocked, false);
      assert.equal(status.attention.userDecisionRequired, false);
      const entry = (await enterConversationRecovery({ root }));
      assert.equal(entry.status, "conversation_ready");
      assert.equal(entry.projectStatus.readiness.product.state, "integrity_attention");
      assert.equal((await initializeOrResumeProject({ root, pluginRoot, profile: "core" })).readiness.core.state, "ready");
      assert.equal((await inspectConversationalOnboarding({ root })).status, "integrity_attention");
      await assert.rejects(() => reviewOnboarding(request));
      assert.deepEqual(authorityBytes(root, layout).slice(0, 2), p2);
      fs.writeFileSync(file, original);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("exact candidate restoration preserves damaged bytes and does not repeat approval", async () => {
  const { root, layout, canonPath, statePath, reviewDirectory, request } = await fixture();
  try {
    await reviewOnboarding(request);
    const file = path.join(root, layout.directory, "onboarding/candidate-sets", `${request.candidateSetId}.json`);
    const sourceContent = fs.readFileSync(file, "utf8");
    const p1p2 = authorityBytes(root, layout);
    const damaged = Buffer.from("{broken");
    fs.writeFileSync(file, damaged);
    const expectedRawHash = crypto.createHash("sha256").update(damaged).digest("hex");
    assert.throws(() => restoreOnboardingCandidate({ ...request, sourceContent, expectedRawHash: "0".repeat(64) }), { code: "ONBOARDING_RECOVERY_CONFLICT" });
    assert.deepEqual(fs.readFileSync(file), damaged);
    const result = restoreOnboardingCandidate({ ...request, sourceContent, expectedRawHash });
    assert.equal(result.status, "restored");
    assert.deepEqual(fs.readFileSync(result.custodyFile), damaged);
    assert.deepEqual(authorityBytes(root, layout), p1p2);
    const replay = restoreOnboardingCandidate({ ...request, sourceContent: JSON.stringify(JSON.parse(sourceContent)), expectedRawHash });
    assert.equal(replay.status, "already-restored");
    assert.equal(replay.sourceRawBytesEqual, false);
    assert.equal(fs.readFileSync(file, "utf8"), sourceContent);
    fs.unlinkSync(file);
    assert.equal(restoreOnboardingCandidate({ ...request, sourceContent, expectedRawHash: null }).status, "restored");
    assert.equal((await inspectOnboarding({ root })).status, "ready");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("damaged unreviewed candidate uses existing semantic refresh without inheriting authority", async () => {
  const { root, layout, canonPath, statePath, reviewDirectory, request } = await fixture();
  try {
    const state = (await inspectOnboarding({ root })).state;
    const world = (await inspectWorldModel({ root })).snapshot;
    const file = path.join(root, layout.directory, "onboarding/candidate-sets", `${request.candidateSetId}.json`);
    const damaged = Buffer.from("{broken");
    fs.writeFileSync(file, damaged);
    const p1p2 = authorityBytes(root, layout).slice(0, 3);
    const semanticProposal = { schemaVersion: 1, sourceSnapshotId: world.temporalProvenanceGraph.sourceSnapshotId,
      candidates: [{ productKind: "Capability", proposedEntity: { key: "dispatch", name: "Dispatch", description: "Deliver reviewed messages." },
        explanation: "The project README describes message delivery.", confidence: 0.8, evidence: [{ path: "README.md", line: 1 }] }] };
    const result = await refreshOnboardingCandidates({ root, semanticProposal,
      recoveryBasis: { pointerHash: state.pointerHash, rawHash: crypto.createHash("sha256").update(damaged).digest("hex") } });
    assert.notEqual(result.candidateSet.candidateSetId, request.candidateSetId);
    assert.deepEqual(result.candidateSet.parentCandidateSetIds, []);
    assert.equal(result.state.latestReviewDecisionId, null);
    assert.deepEqual(authorityBytes(root, layout).slice(0, 3), p1p2);
    assert.equal((await inspectOnboarding({ root })).status, "awaiting_review");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("semantic recovery preserves failed preconditions and resumes exact custody after interruption", async () => {
  for (const fault of ["canon-drift", "throw-after-unlink", "crash-after-unlink"]) {
    const { root, layout, canonPath, statePath, reviewDirectory, request } = await fixture();
    try {
      const state = (await inspectOnboarding({ root })).state, world = (await inspectWorldModel({ root })).snapshot;
      const file = path.join(root, layout.directory, "onboarding/candidate-sets", `${request.candidateSetId}.json`);
      const damaged = Buffer.from("{broken");
      fs.writeFileSync(file, damaged);
      const options = { root, recoveryBasis: { pointerHash: state.pointerHash, rawHash: crypto.createHash("sha256").update(damaged).digest("hex") },
        semanticProposal: { schemaVersion: 1, sourceSnapshotId: world.temporalProvenanceGraph.sourceSnapshotId,
          candidates: [{ productKind: "Capability", proposedEntity: { key: "dispatch", name: "Dispatch", description: "Deliver messages." },
            explanation: "README describes delivery.", confidence: 0.8, evidence: [{ path: "README.md", line: 1 }] }] } };
      if (fault === "canon-drift") {
        fs.writeFileSync(path.join(root, canonPath), JSON.stringify({ schemaVersion: 1, featureGroups: [], capabilities: [{ key: "later", name: "Later", description: "Later approved value." }], features: [], requirements: [], constraints: [], decisions: [] }));
        const before = authorityBytes(root, layout);
        await assert.rejects(() => refreshOnboardingCandidates(options), { code: "ONBOARDING_PRODUCT_CANON_DRIFT" });
        assert.deepEqual(authorityBytes(root, layout), before);
        assert.deepEqual(fs.readFileSync(file), damaged);
        assert.equal(fs.existsSync(path.join(root, layout.directory, "onboarding/recovery-custody")), false);
        continue;
      }
      const before = authorityBytes(root, layout);
      const source = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
        const original=fs.unlinkSync;fs.unlinkSync=function(file){const result=original.apply(this,arguments);if(String(file)===${JSON.stringify(file)}){${fault === "crash-after-unlink" ? "process.exit(44)" : "throw Object.assign(new Error('injected'),{code:'TEST_INJECTED'})"};}return result;};syncBuiltinESMExports();
        const {refreshOnboardingCandidates}=await import(${JSON.stringify(moduleUrl)});
        try{await refreshOnboardingCandidates(${JSON.stringify(options)});}catch(error){if(error.code!=='TEST_INJECTED')throw error;}`;
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], { cwd: pluginRoot, encoding: "utf8", timeout: 45000, windowsHide: true });
      assert.equal(child.error, undefined);
      assert.equal(child.status, fault === "crash-after-unlink" ? 44 : 0, child.stderr);
      if (fault === "throw-after-unlink") assert.deepEqual(fs.readFileSync(file), damaged);
      else assert.equal(fs.existsSync(file), false);
      assert.deepEqual(authorityBytes(root, layout), before);
      const result = await refreshOnboardingCandidates(options);
      assert.equal(result.status, "onboarding_candidates_refreshed");
      assert.deepEqual(authorityBytes(root, layout).slice(0, 3), before.slice(0, 3));
      assert.deepEqual(result.candidateSet.parentCandidateSetIds, []);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

// Inject a process exit immediately after a real durable rename. The production
// modules and source are unchanged; no test-only crash switch exists in Core.
function interruptedReview(request, boundary, { layout, throwInstead = false } = {}) {
  const canonPath = `${layout.directory}/context/product-model.json`;
  const statePath = `${layout.directory}/onboarding/current.json`;
  const reviewDirectory = `${layout.directory}/onboarding/review-decisions`;
  const source = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    const request = ${JSON.stringify(request)};
    const boundary = ${JSON.stringify(boundary)};
    process.stderr.write(JSON.stringify({event:'process-start',pid:process.pid,parentPid:process.ppid,command:process.execPath+' onboarding crash injection '+boundary,cwd:process.cwd(),ports:[]})+'\\n');
    const original = fs.renameSync;
    let revisions = 0;
    let states = 0;
    fs.renameSync = function(from, to) {
      const relative = path.relative(request.root, String(to)).replaceAll('\\\\','/');
      const result = original.apply(this, arguments);
      const isRevision = relative.startsWith(${JSON.stringify(`${layout.directory}/onboarding/product-model-revisions/`)});
      if (isRevision) revisions++;
      if (relative === ${JSON.stringify(statePath)}) states++;
      const hit = boundary === 'revision-1' && isRevision && revisions === 1
        || boundary === 'revision-2' && isRevision && revisions === 2
        || boundary === 'decision' && relative.startsWith(${JSON.stringify(`${reviewDirectory}/`)})
        || boundary === 'canon' && relative === ${JSON.stringify(canonPath)}
        || boundary === 'candidate' && relative.startsWith(${JSON.stringify(`${layout.directory}/onboarding/candidate-sets/`)})
        || boundary === 'state-1' && relative === ${JSON.stringify(statePath)} && states === 1
        || boundary === 'world' && relative === ${JSON.stringify(`${layout.directory}/world-model/current.json`)}
        || boundary === 'state-2' && relative === ${JSON.stringify(statePath)} && states === 2;
      if (hit) {
        process.stderr.write(JSON.stringify({event:'injected-boundary',pid:process.pid,boundary,relative})+'\\n');
        ${throwInstead ? "throw Object.assign(new Error('Injected projection failure'), {code:'TEST_PROJECTION_FAILURE'});" : "process.exit(44);"}
      }
      return result;
    };
    syncBuiltinESMExports();
    const {reviewOnboarding} = await import(${JSON.stringify(moduleUrl)});
    const result = await reviewOnboarding(request);
    process.stdout.write(JSON.stringify(result));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: pluginRoot, encoding: "utf8", timeout: 45_000,
  });
  if (result.stderr) process.stderr.write(result.stderr);
  assert.equal(result.error, undefined, `subprocess must complete: ${result.error}`);
  assert.equal(result.signal, null);
  assert.equal(result.status, throwInstead ? 0 : 44, result.stderr);
  process.stderr.write(`${JSON.stringify({ event: "process-ended", pid: result.pid, ports: [] })}\n`);
  return throwInstead ? JSON.parse(result.stdout) : null;
}

test("onboarding crash recovery follows durable approval at every publication boundary", async () => {
  for (const boundary of ["revision-1", "revision-2", "decision", "canon", "state-1", "world", "state-2"]) {
    const { root, layout, canonPath, statePath, reviewDirectory, request } = await fixture();
    try {
      const before = authorityBytes(root, layout);
      interruptedReview(request, boundary, { layout });
      const afterCrash = authorityBytes(root, layout);
      assert.deepEqual(afterCrash.slice(0, 2), before.slice(0, 2), "no Project/Session recovery mutation");
      const hasDecision = fs.existsSync(path.join(root, reviewDirectory));
      if (!hasDecision) {
        assert.equal(await recoverOnboardingPromotion({ root }), null);
        assert.deepEqual(authorityBytes(root, layout), before, "unapproved revision evidence cannot change Canon");
        const completed = await reviewOnboarding(request);
        assert.equal(completed.status, "onboarding_ready");
      } else {
        const inspected = (await inspectOnboarding({ root }));
        if (boundary !== "state-2") {
          assert.equal(inspected.status, "promotion_recovery_pending");
          const guide = (await inspectConversationalOnboarding({ root }));
          assert.equal(guide.nextAction, "initialize_or_resume");
          assert.deepEqual(guide.materialChoicesRequired, []);
          const readOnlyBefore = authorityBytes(root, layout);
          const coreResume = await initializeOrResumeProject({ root, pluginRoot, profile: "core" });
          assert.equal(coreResume.readiness.core.state, "ready");
          assert.deepEqual(authorityBytes(root, layout), readOnlyBefore, "Core resume must not activate Product recovery");
        }
        await initializeOrResumeProject({ root, pluginRoot, profile: "product" });
      }
      assert.equal((await inspectOnboarding({ root })).status, "ready", boundary);
      assert.equal((await inspectWorldModel({ root })).status, "current");
      const completed = authorityBytes(root, layout);
      const retry = await reviewOnboarding(request);
      assert.equal(retry.status, "onboarding_ready");
      assert.deepEqual(authorityBytes(root, layout), completed, "identical retry must not create pointer generations");
      assert.equal(fs.readdirSync(path.join(root, reviewDirectory)).length, 1);
      await assert.rejects(() => reviewOnboarding({ ...request, rationale: "A different approval." }), { code: "ONBOARDING_REVIEW_REPLAY_CONFLICT" });
      assert.deepEqual(authorityBytes(root, layout), completed);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("failed optional projection preserves approval and resumes without a second decision", async () => {
  const { root, storage, layout, canonPath, statePath, reviewDirectory, request } = await fixture();
  try {
    const result = interruptedReview(request, "world", { layout, throwInstead: true });
    assert.equal(result.status, "onboarding_approved_projection_pending");
    assert.equal(result.projection.ordinaryWorkBlocked, false);
    assert.equal(result.projection.userReviewRequired, false);
    assert.equal(readProductModelCanon({ projectRoot: root, storage }).model.capabilities.length, 1);
    assert.equal((await inspectOnboarding({ root })).status, "promotion_recovery_pending");
    await initializeOrResumeProject({ root, pluginRoot, profile: "product" });
    assert.equal((await inspectOnboarding({ root })).status, "ready");
    assert.equal(fs.readdirSync(path.join(root, reviewDirectory)).length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("recovery and old replay preserve a foreign later Canon and reject tampered decisions", async () => {
  const { root, layout, canonPath, statePath, reviewDirectory, request } = await fixture();
  try {
    interruptedReview(request, "decision", { layout });
    const canonFile = path.join(root, canonPath);
    const foreignCanon = JSON.parse(fs.readFileSync(canonFile, "utf8"));
    foreignCanon.capabilities.push({ key: "later", name: "Later approved state", description: "Must not be overwritten." });
    fs.writeFileSync(canonFile, `${JSON.stringify(foreignCanon)}\n`);
    const foreignBytes = fs.readFileSync(canonFile, "utf8");
    await assert.rejects(() => recoverOnboardingPromotion({ root }), { code: "ONBOARDING_PRODUCT_CANON_DRIFT" });
    await assert.rejects(() => reviewOnboarding(request), { code: "ONBOARDING_PRODUCT_CANON_DRIFT" });
    assert.equal(fs.readFileSync(canonFile, "utf8"), foreignBytes);
    const decisionFile = path.join(root, reviewDirectory, fs.readdirSync(path.join(root, reviewDirectory))[0]);
    const decision = JSON.parse(fs.readFileSync(decisionFile, "utf8"));
    const aliasFile = path.join(root, reviewDirectory, `onboarding-review-decision-${"0".repeat(24)}.json`);
    fs.renameSync(decisionFile, aliasFile);
    await assert.rejects(() => recoverOnboardingPromotion({ root }), { code: "ONBOARDING_REVIEW_IDENTITY_MISMATCH" });
    fs.renameSync(aliasFile, decisionFile);
    decision.rationale = "tampered";
    fs.writeFileSync(decisionFile, JSON.stringify(decision));
    await assert.rejects(() => recoverOnboardingPromotion({ root }), { code: "ONBOARDING_REVIEW_DIGEST_MISMATCH" });
    assert.equal(fs.readFileSync(canonFile, "utf8"), foreignBytes);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("concurrent identical reviews converge and completed replay does not refresh later source edits", async () => {
  const { root, layout, canonPath, statePath, reviewDirectory, request } = await fixture();
  try {
    const results = await Promise.all([reviewOnboarding(request), reviewOnboarding(request)]);
    assert.equal(results[0].reviewDecision.reviewDecisionId, results[1].reviewDecision.reviewDecisionId);
    assert.equal(fs.readdirSync(path.join(root, reviewDirectory)).length, 1);
    const stable = authorityBytes(root, layout);
    const worldPointer = fs.readFileSync(path.join(root, layout.directory, "world-model/current.json"), "utf8");
    fs.appendFileSync(path.join(root, "README.md"), "\nLater repository evidence.\n");
    const replay = await reviewOnboarding(request);
    assert.equal(replay.status, "onboarding_approved_projection_pending");
    assert.equal(replay.productCanonChanged, false);
    assert.deepEqual(authorityBytes(root, layout), stable);
    assert.equal(fs.readFileSync(path.join(root, layout.directory, "world-model/current.json"), "utf8"), worldPointer);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("approved promotion recovers without a retained World graph", async () => {
  for (const missing of ["directory", "snapshot"]) {
    const { root, layout, canonPath, statePath, reviewDirectory, request } = await fixture();
    try {
      const worldModelId = (await inspectOnboarding({ root })).worldModel.worldModelId;
      interruptedReview(request, "decision", { layout });
      if (missing === "directory") fs.rmSync(path.join(root, layout.directory, "world-model"), { recursive: true, force: true });
      else fs.unlinkSync(worldSnapshotFile(root, worldModelId));
      const result = await recoverOnboardingPromotion({ root });
      assert.equal(result.status, "onboarding_ready");
      assert.equal((await inspectOnboarding({ root })).status, "ready");
      assert.equal(fs.readdirSync(path.join(root, reviewDirectory)).length, 1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("decision deletion between recovery lookup and commit cannot publish Canon from memory", async () => {
  const { root, layout, canonPath, statePath, reviewDirectory, request } = await fixture();
  const originalRead = fs.readFileSync;
  try {
    interruptedReview(request, "decision", { layout });
    const before = authorityBytes(root, layout);
    const decisionFile = path.join(root, reviewDirectory, fs.readdirSync(path.join(root, reviewDirectory))[0]);
    let decisionReads = 0;
    fs.readFileSync = function (file, ...options) {
      const bytes = originalRead.call(this, file, ...options);
      if (path.resolve(String(file)) === decisionFile && ++decisionReads === 2) fs.unlinkSync(decisionFile);
      return bytes;
    };
    await assert.rejects(() => recoverOnboardingPromotion({ root }), { code: "ONBOARDING_REVIEW_NOT_FOUND" });
    fs.readFileSync = originalRead;
    assert.equal(decisionReads, 2, "delete after the approved decision was loaded into memory");
    assert.deepEqual(authorityBytes(root, layout), before);
  } finally {
    fs.readFileSync = originalRead;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function treeBytes(root) {
  const result = {};
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else result[path.relative(root, absolute)] = fs.readFileSync(absolute).toString("base64");
    }
  }
  visit(root);
  return result;
}

function treeReadSnapshot(root) {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter(item => item.isFile()).map(item => {
    const file = path.join(item.parentPath, item.name), stat = fs.statSync(file);
    return [path.relative(root, file), crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"), stat.mtimeMs, stat.mode];
  }).sort(([a], [b]) => a.localeCompare(b));
}

for (const worldState of ["current", "stale", "missing", "corrupt"]) test(`ordinary entry leaves ${worldState} aggregate World explicitly unchecked without weakening full diagnosis`, async () => {
  const { root, layout, canonPath, statePath, reviewDirectory, request } = await fixture();
  try {
    const accepted = await reviewOnboarding(request);
    const worldFile = worldSnapshotFile(root, accepted.worldModel.worldModelId);
    if (worldState === "stale") fs.appendFileSync(path.join(root, "README.md"), "\nChanged synthetic source after approval.\n");
    if (worldState === "missing") fs.unlinkSync(worldFile);
    if (worldState === "corrupt") fs.writeFileSync(worldFile, "{broken-derived-world");
    const before = treeReadSnapshot(root), fullBefore = (await inspectProjectExperience({ root }));
    if (worldState === "corrupt") {
      (await assert.rejects(async () => (await inspectOnboarding({ root }))));
      assert.equal(fullBefore.readiness.product.state, "integrity_attention");
    } else {
      const full = (await inspectOnboarding({ root }));
      assert.equal(full.worldModel.status, worldState === "missing" ? "unavailable" : worldState);
      assert.equal(fullBefore.readiness.product.state, worldState === "current" ? "ready" : "refresh_required");
      assert.equal(fullBefore.readiness.context.repositoryEvidence,
        worldState === "current" ? "available-current-world" : worldState === "missing" ? "missing-excluded" : "stale-excluded");
    }
    const entry = (await enterConversationRecovery({ root })), product = entry.projectStatus.readiness.product;
    assert.equal(entry.status, "conversation_ready");
    assert.equal(entry.projectStatus.status, "core_ready");
    assert.equal(product.state, "reviewed_world_unchecked");
    assert.equal(product.onboardingStatus, "ready_world_unchecked");
    assert.equal(product.governanceActivated, true);
    assert.equal(entry.projectStatus.readiness.context.state, "world-not-inspected");
    assert.equal(entry.projectStatus.readiness.context.repositoryEvidence, "not-inspected");
    assert.equal(entry.projectStatus.readiness.context.worldModelId, null);
    assert.equal(entry.projectStatus.capabilities.find(item => item.id === "product-governance").availability, "available-on-demand");
    assert.equal(entry.projectStatus.nextAction.id, "work_directly");
    assert.equal(entry.headActionRequired, false);
    assert.equal(entry.userDecisionRequired, false);
    assert.equal(entry.ordinaryWorkBlocked, false);
    assert.deepEqual(entry.blockedOperations, []);
    assert.deepEqual((await inspectProjectExperience({ root })), fullBefore, "Explicit full diagnostic facts do not change after unchecked entry");
    assert.deepEqual(treeReadSnapshot(root), before, "All entry/full diagnostic reads preserve bytes, mtime and mode");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("entry still validates ReviewDecision and Product Canon originals rather than treating unchecked World as approval", async () => {
  const { root, layout, canonPath, statePath, reviewDirectory, request } = await fixture();
  try {
    const accepted = await reviewOnboarding(request);
    const reviewFile = path.join(root, reviewDirectory, `${accepted.reviewDecision.reviewDecisionId}.json`);
    for (const file of [reviewFile, path.join(root, canonPath)]) {
      const original = fs.readFileSync(file), data = JSON.parse(original);
      if (file === reviewFile) data.rationale = "Tampered synthetic approval";
      else data.capabilities[0].name = "Tampered synthetic Canon";
      fs.writeFileSync(file, JSON.stringify(data));
      const before = treeReadSnapshot(root), entry = (await enterConversationRecovery({ root }));
      assert.equal(entry.projectStatus.readiness.product.state, "integrity_attention");
      assert.equal(entry.projectStatus.readiness.product.governanceActivated, null);
      assert.equal(entry.projectStatus.readiness.context.repositoryEvidence, "unverified-excluded");
      assert.equal(entry.ordinaryWorkBlocked, false);
      assert.equal(entry.userDecisionRequired, false);
      (await assert.rejects(async () => (await inspectOnboarding({ root }))));
      assert.deepEqual(treeReadSnapshot(root), before);
      fs.writeFileSync(file, original);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("entry keeps explicitly selected P2 when the separate default Product owner is damaged", async () => {
  const { root, layout, canonPath, statePath, reviewDirectory, request } = await fixture();
  try {
    await reviewOnboarding(request);
    const selected = createHeadSession({ root, purpose: "Inspect selected synthetic Session, not default" });
    const checkpoint = withSessionRoute(root, selected.sessionId, () => createRecoveryCheckpoint({ root,
      purpose: selected.state.purpose, approvedDecisions: [], currentPosition: "Selected original checkpoint",
      nextExpectedResult: "Explain only; never deploy" }).checkpoint);
    const latest = updateProjectDirection({ root, input: { goal: "Independent local explanation", cancelledActions: ["deploy"] } }).direction;
    fs.writeFileSync(path.join(root, layout.directory, "sessions/current.json"), "{broken-default-session");
    const before = treeReadSnapshot(root);
    const entry = (await withSessionRoute(root, selected.sessionId, async () => (await enterConversationRecovery({ root }))));
    assert.equal(entry.projectStatus.project.sessionId, selected.sessionId);
    assert.equal(entry.projectStatus.state.sessionId, selected.sessionId);
    assert.equal(entry.restore.checkpoint.checkpointDigest, checkpoint.checkpointDigest);
    assert.equal(entry.projectStatus.currentProjectDirection.directionId, latest.directionId);
    assert.deepEqual(entry.projectStatus.currentProjectDirection.input.cancelledActions, ["deploy"]);
    assert.equal(entry.projectStatus.readiness.product.state, "integrity_attention");
    assert.equal(entry.projectStatus.nextAction.id, "work_directly");
    assert.equal(entry.ordinaryWorkBlocked, false);
    assert.equal(entry.recoveryDependentWorkBlocked, false);
    assert.equal(entry.persisted, false);
    assert.deepEqual(treeReadSnapshot(root), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("completed acceptance tolerates absent World across Core entry, status and both resumes without writes", async () => {
  for (const missing of ["directory", "snapshot"]) {
    const { root, layout, canonPath, statePath, reviewDirectory, request } = await fixture();
    try {
      const approved = await reviewOnboarding(request);
      if (missing === "directory") fs.rmSync(path.join(root, layout.directory, "world-model"), { recursive: true, force: true });
      else fs.unlinkSync(worldSnapshotFile(root, approved.worldModel.worldModelId));
      const before = treeBytes(root);
      const status = (await inspectOnboarding({ root }));
      assert.equal(status.status, "ready_world_changed");
      assert.equal(status.worldModel.status, "unavailable");
      assert.equal(status.worldModel.reasonCode, missing === "directory" ? "WORLD_MODEL_NOT_BUILT" : "WORLD_MODEL_SNAPSHOT_MISSING");
      const experience = (await inspectProjectExperience({ root }));
      assert.equal(experience.readiness.core.state, "ready");
      assert.equal(experience.readiness.product.state, "refresh_required");
      assert.equal((await inspectConversationalOnboarding({ root })).nextAction, "refresh_or_reconcile_world");
      const entry = await enterConversationRecovery({ root });
      assert.equal(entry.status, "conversation_ready");
      assert.equal(await recoverOnboardingPromotion({ root }), null);
      for (const profile of ["core", "product"]) {
        const resumed = await initializeOrResumeProject({ root, pluginRoot, profile });
        assert.equal(resumed.readiness.core.state, "ready");
        assert.equal(resumed.readiness.product.state, "refresh_required");
      }
      const replay = await reviewOnboarding(request);
      assert.equal(replay.status, "onboarding_approved_projection_pending");
      assert.deepEqual(treeBytes(root), before, "optional World absence must not write any project file during entry, status, or resume");
      const decisionFile = path.join(root, reviewDirectory, fs.readdirSync(path.join(root, reviewDirectory))[0]);
      const decision = JSON.parse(fs.readFileSync(decisionFile, "utf8"));
      decision.rationale = "tampered";
      fs.writeFileSync(decisionFile, JSON.stringify(decision));
      (await assert.rejects(async () => (await inspectOnboarding({ root })), { code: "ONBOARDING_REVIEW_DIGEST_MISMATCH" }));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

async function nonPromotingRequest(root, request, disposition) {
  if (disposition === "reject") return { ...request, disposition };
  const candidate = (await inspectOnboarding({ root })).candidateSet.candidates[0];
  return { ...request, disposition, userEdits: [{ candidateId: candidate.candidateId,
    entity: { ...candidate.proposedEntity, name: "Reviewed delivery" } }] };
}

test("revise and reject recover every publication boundary and their actual next workflow", async () => {
  for (const disposition of ["revise", "reject"]) {
    for (const boundary of ["decision", ...(disposition === "revise" ? ["candidate"] : []), "state-1", "world", "state-2"]) {
      const { root, layout, canonPath, statePath, reviewDirectory, request: initial } = await fixture();
      try {
        const request = (await nonPromotingRequest(root, initial, disposition));
        const before = authorityBytes(root, layout);
        interruptedReview(request, boundary, { layout });
        assert.deepEqual(authorityBytes(root, layout).slice(0, 3), before.slice(0, 3), "non-promoting decision never changes Canon/Project/Session");
        const status = (await inspectOnboarding({ root }));
        if (boundary !== "state-2") {
          assert.equal(status.status, "review_recovery_pending", `${disposition}:${boundary}`);
          const guide = (await inspectConversationalOnboarding({ root }));
          assert.equal(guide.nextAction, "initialize_or_resume");
          assert.deepEqual(guide.materialChoicesRequired, []);
        }
        const replay = await reviewOnboarding(request);
        assert.equal(replay.status, disposition === "revise" ? "onboarding_revision_awaiting_review" : "onboarding_rejected", JSON.stringify(replay.projection));
        const after = treeBytes(root);
        await initializeOrResumeProject({ root, pluginRoot, profile: "product" });
        assert.equal(await recoverOnboardingPromotion({ root }), null);
        const repeated = await reviewOnboarding(request);
        assert.equal(repeated.reviewDecision.reviewDecisionId, replay.reviewDecision.reviewDecisionId);
        assert.deepEqual(treeBytes(root), after, "completed exact retry/resume does not create new decision/state/graph generations");
        await assert.rejects(() => reviewOnboarding({ ...request, rationale: "Different decision." }), { code: "ONBOARDING_REVIEW_REPLAY_CONFLICT" });
        assert.deepEqual(treeBytes(root), after);
        if (disposition === "revise") {
          const successor = (await inspectOnboarding({ root })).candidateSet;
          const accepted = await reviewOnboarding({ root, candidateSetId: successor.candidateSetId, disposition: "accept-all", rationale: "Approve the reviewed successor." });
          assert.equal(accepted.status, "onboarding_ready", `${disposition}:${boundary} ${JSON.stringify(accepted.projection)}`);
          assert.equal(accepted.productModel.capabilities[0].name, "Reviewed delivery");
        } else assert.equal((await inspectOnboarding({ root })).status, "rejected");
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
  }
});

test("legacy Graph-only review remnants reconcile from persisted records without inventing a decision", async () => {
  for (const disposition of ["revise", "reject"]) {
    const { root, layout, canonPath, statePath, reviewDirectory, request: initial } = await fixture();
    try {
      const request = (await nonPromotingRequest(root, initial, disposition));
      const beforeState = fs.readFileSync(path.join(root, statePath), "utf8");
      const beforeCanon = fs.readFileSync(path.join(root, canonPath), "utf8");
      const completed = await reviewOnboarding(request);
      // Construct the exact filesystem boundary produced by the former
      // Graph-first implementation, using a real verified current snapshot.
      fs.writeFileSync(path.join(root, statePath), beforeState);
      fs.unlinkSync(path.join(root, reviewDirectory, `${completed.reviewDecision.reviewDecisionId}.json`));
      if (completed.candidateSet) fs.unlinkSync(path.join(root, layout.directory, "onboarding/candidate-sets", `${completed.candidateSet.candidateSetId}.json`));
      assert.equal((await inspectWorldModel({ root })).status, "stale");
      assert.equal(await recoverOnboardingPromotion({ root }), null);
      const refreshed = await refreshOnboardingCandidates({ root });
      assert.equal(refreshed.status, "onboarding_candidates_current");
      assert.equal(fs.readdirSync(path.join(root, reviewDirectory)).length, 0, "a P4 decision copy never recreates P1");
      assert.equal(fs.readFileSync(path.join(root, canonPath), "utf8"), beforeCanon);
      assert.equal(fs.readFileSync(path.join(root, statePath), "utf8"), beforeState);
      const reviewed = await reviewOnboarding(request);
      assert.equal(reviewed.status, disposition === "revise" ? "onboarding_revision_awaiting_review" : "onboarding_rejected");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("awaiting review refreshes missing optional World before offering the original decision", async () => {
  for (const missing of ["directory", "snapshot"]) {
    const { root, layout, canonPath, statePath, reviewDirectory, request } = await fixture();
    try {
      const initial = (await inspectOnboarding({ root }));
      if (missing === "directory") fs.rmSync(path.join(root, layout.directory, "world-model"), { recursive: true, force: true });
      else fs.unlinkSync(worldSnapshotFile(root, initial.worldModel.worldModelId));
      const before = treeBytes(root);
      const authority = authorityBytes(root, layout);
      const guide = (await inspectConversationalOnboarding({ root }));
      assert.equal(guide.nextAction, "refresh_or_reconcile_world");
      assert.deepEqual(guide.materialChoicesRequired, []);
      assert.equal((await inspectProjectExperience({ root })).readiness.product.state, "refresh_required");
      assert.equal((await inspectProjectExperience({ root })).readiness.context.repositoryEvidence, "missing-excluded");
      const entry = (await enterConversationRecovery({ root }));
      assert.equal(entry.projectStatus.readiness.product.state, "review_required");
      assert.equal(entry.projectStatus.readiness.context.repositoryEvidence, "not-inspected");
      assert.equal(entry.attention.items.find(item => item.id === "product-canon-review").actionability,
        "when-product-governance-is-in-scope");
      assert.equal(entry.userDecisionRequired, false);
      assert.equal(entry.ordinaryWorkBlocked, false);
      await initializeOrResumeProject({ root, pluginRoot, profile: "core" });
      assert.deepEqual(treeBytes(root), before, "read-only entry/status and Core resume do not refresh Product views");
      const resumed = await initializeOrResumeProject({ root, pluginRoot, profile: "product" });
      assert.equal(resumed.readiness.product.state, "review_required");
      assert.equal((await inspectOnboarding({ root })).candidateSet.candidateSetId, request.candidateSetId);
      assert.equal((await inspectConversationalOnboarding({ root })).nextAction, "review_candidates");
      assert.deepEqual(authorityBytes(root, layout), authority, "view reconstruction preserves Canon, Session and exact candidate pointer");
      assert.equal(fs.existsSync(path.join(root, reviewDirectory)), false, "refresh creates no approval");
      assert.equal((await reviewOnboarding(request)).status, "onboarding_ready");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("completed revise and reject replay disclose later source drift without rebuilding", async () => {
  for (const disposition of ["revise", "reject"]) {
    const { root, layout, canonPath, statePath, reviewDirectory, request: initial } = await fixture();
    try {
      const request = (await nonPromotingRequest(root, initial, disposition));
      const completed = await reviewOnboarding(request);
      fs.appendFileSync(path.join(root, "README.md"), "\nRepository changed after the decision.\n");
      const before = treeBytes(root);
      assert.equal(await recoverOnboardingPromotion({ root }), null);
      const replay = await reviewOnboarding(request);
      assert.equal(replay.reviewDecision.reviewDecisionId, completed.reviewDecision.reviewDecisionId);
      assert.equal(replay.projection.reasonCode, "WORLD_MODEL_STALE");
      assert.equal(replay.projection.userReviewRequired, false);
      assert.deepEqual(treeBytes(root), before, "historical disposition replay never refreshes current observations");
      if (disposition === "revise") {
        const resumed = await initializeOrResumeProject({ root, pluginRoot, profile: "product" });
        assert.equal(resumed.onboardingAction, "fresh-head-semantic-reproposal-required");
        assert.equal((await inspectConversationalOnboarding({ root })).nextAction, "refresh_or_reconcile_world");
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("optional World availability does not conceal snapshot tampering", async () => {
  const { root, layout, canonPath, statePath, reviewDirectory, request } = await fixture();
  try {
    const accepted = await reviewOnboarding(request);
    const filename = worldSnapshotFile(root, accepted.worldModel.worldModelId);
    const snapshot = readFixtureSnapshot(filename);
    snapshot.worldModelId = "tampered";
    writeFixtureSnapshot(filename, snapshot);
    (await assert.rejects(async () => (await inspectOnboarding({ root })), (error) => !["WORLD_MODEL_NOT_BUILT", "WORLD_MODEL_SNAPSHOT_MISSING"].includes(error.code)));
    const core = await initializeOrResumeProject({ root, pluginRoot, profile: "core" });
    assert.equal(core.readiness.core.state, "ready");
    assert.equal(core.readiness.product.state, "integrity_attention");
    fs.unlinkSync(filename);
    const pointerFile = path.join(root, layout.directory, "world-model/current.json");
    const pointer = JSON.parse(fs.readFileSync(pointerFile, "utf8"));
    pointer.worldModelHash = "0".repeat(64);
    fs.writeFileSync(pointerFile, JSON.stringify(pointer));
    (await assert.rejects(async () => (await inspectOnboarding({ root })), { code: "WORLD_MODEL_POINTER_MISMATCH" }));
    await assert.rejects(async () => (await initializeOrResumeProject({ root, pluginRoot, profile: "product" })), { code: "WORLD_MODEL_POINTER_MISMATCH" });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("physical composition and part damage remain strict Product errors without blocking Core", async t => {
  const { root, canonPath, request } = await fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const accepted = await reviewOnboarding(request);
  const file = worldSnapshotFile(root, accepted.worldModel.worldModelId);
  const canonFile = path.resolve(root, canonPath);
  const original = fs.readFileSync(file), canon = fs.readFileSync(canonFile);
  const physical = readSnapshotFile(file).document;
  assert.equal(physical.kind, "SnapshotComposition");
  assert.equal(physical.schemaVersion, 2);
  const partFile = path.join(root, physical.code.address), originalPart = fs.readFileSync(partFile);
  const forgedPart = (value, raw, graph = false) => {
    const ref = graph ? value.graph.code : value.code;
    ref.sha256 = crypto.createHash("sha256").update(raw).digest("hex"); ref.byteLength = raw.length;
    ref.address = path.posix.join(path.posix.dirname(ref.address), `${ref.sha256}.json.gz`);
    const target = path.join(root, ref.address);
    fs.writeFileSync(target, zlib.gzipSync(raw), { flag: "wx" });
    writeFixtureSnapshot(file, value);
    return target;
  };
  const changedPayload = (change, graph = false) => {
    const value = structuredClone(physical), ref = graph ? value.graph.code : value.code;
    const part = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root, ref.address)))); change(part);
    return forgedPart(value, Buffer.from(JSON.stringify(part) + "\n"), graph);
  };
  const cases = [
    ["root encoding", "INVALID_WORLD_MODEL_STORE_DOCUMENT", () => fs.writeFileSync(file, "invalid gzip")],
    ["root shape", "INVALID_SNAPSHOT_COMPOSITION", () => {
      const value = structuredClone(physical); value.unrecorded = true; writeFixtureSnapshot(file, value);
    }],
    ["reconstructed digest", "SNAPSHOT_COMPOSITION_DIGEST_MISMATCH", () => {
      const value = structuredClone(physical); value.reconstructedSha256 = "0".repeat(64); writeFixtureSnapshot(file, value);
    }],
    ["part encoding", "INVALID_SNAPSHOT_BUNDLE_ENCODING", () => fs.writeFileSync(partFile, "invalid gzip")],
    ["part digest", "SNAPSHOT_BUNDLE_DIGEST_MISMATCH", () => {
      const value = JSON.parse(zlib.gunzipSync(originalPart)); value.projectId = "x" + value.projectId.slice(1);
      fs.writeFileSync(partFile, zlib.gzipSync(JSON.stringify(value) + "\n"));
    }],
    ["root null body", "INVALID_SNAPSHOT_COMPOSITION", () => {
      const value = structuredClone(physical); value.body = null; writeFixtureSnapshot(file, value);
    }],
    ["legacy null graph reference", "SNAPSHOT_BUNDLE_TYPE_MISMATCH", () => {
      const value = structuredClone(physical); value.schemaVersion = 1; value.producer.version = "0.1.0"; value.graph = null; writeFixtureSnapshot(file, value);
    }],
    ["rehashed invalid UTF8", "INVALID_SNAPSHOT_BUNDLE_ENCODING", () => forgedPart(structuredClone(physical), Buffer.from([0xff, 0x0a]))],
    ["rehashed non JSON", "INVALID_SNAPSHOT_BUNDLE_ENCODING", () => forgedPart(structuredClone(physical), Buffer.from("{invalid}\n"))],
    ["rehashed null bundle", "SNAPSHOT_BUNDLE_TYPE_MISMATCH", () => forgedPart(structuredClone(physical), Buffer.from("null\n"))],
    ["rehashed null world payload", "INVALID_SNAPSHOT_BUNDLE_SHAPE", () => changedPayload(part => { part.payload = null; })],
    ["rehashed null graph payload", "INVALID_SNAPSHOT_BUNDLE_SHAPE", () => changedPayload(part => { part.payload = null; }, true)],
    ["rehashed invalid graph arrays", "INVALID_SNAPSHOT_BUNDLE_SHAPE", () => changedPayload(part => { part.payload.nodes = null; part.payload.edges = {}; }, true)],
    ["graph order exceeds code records", "INVALID_SNAPSHOT_BUNDLE_SHAPE", () => {
      const value = structuredClone(physical); value.graph.nodeOrder.push(true); writeFixtureSnapshot(file, value);
    }],
  ];
  for (const [name, code, corrupt] of cases) await t.test(name, async () => {
    try {
      const observedPart = corrupt() || partFile;
      const badRoot = fs.readFileSync(file), badPart = fs.readFileSync(observedPart);
      await assert.rejects(() => inspectOnboarding({ root }), { code });
      await assert.rejects(() => initializeOrResumeProject({ root, pluginRoot, profile: "product" }), { code });
      const core = await initializeOrResumeProject({ root, pluginRoot, profile: "core" });
      assert.equal(core.readiness.core.state, "ready");
      assert.equal(core.readiness.product.state, "integrity_attention");
      assert.deepEqual(fs.readFileSync(file), badRoot);
      assert.deepEqual(fs.readFileSync(observedPart), badPart);
      assert.deepEqual(fs.readFileSync(canonFile), canon);
    } finally { fs.writeFileSync(file, original); fs.writeFileSync(partFile, originalPart); }
  });
  await inspectOnboarding({ root });
});

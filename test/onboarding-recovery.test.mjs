import { worldSnapshotFile, graphSnapshotFile, readFixtureSnapshot, writeFixtureSnapshot } from "./helpers/snapshot-storage-fixture.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import { readSnapshotFile } from "../scripts/lib/world/snapshot-storage-codec.mjs";
import { createSnapshotComposition } from "../scripts/lib/world/snapshot-domain-bundles.mjs";
import { snapshotReaderRequirements } from "../scripts/lib/world/snapshot-storage-compatibility.mjs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { formatForVerifiedOwner } from "../scripts/lib/storage/project-storage-format.mjs";
import { initializeOrResumeProject, inspectProjectExperience } from "../scripts/lib/session/project-bootstrap.mjs";
import {
  inspectOptionalOnboarding,
  inspectOptionalOnboardingForEntry,
  inspectOnboarding,
  proposeOnboardingSemanticRefresh,
  recoverOnboardingPromotion,
  refreshOnboardingCandidates,
  restoreOnboardingCandidate,
  reviewOnboarding,
  startOnboarding,
} from "../scripts/lib/session/onboarding.mjs";
import crypto from "node:crypto";
import { inspectConversationalOnboarding } from "../scripts/lib/session/onboarding-conversation.mjs";
import { enterConversationRecovery } from "../scripts/lib/session/compaction-lifecycle.mjs";
import { readProductModelCanon, normalizeProductModelDocument } from "../scripts/lib/world/product-model.mjs";
import { readOnboardingProductSuccessor } from "../scripts/lib/session/onboarding-product-successor.mjs";
import { proposeProductPolicy, reviewProductPolicy } from "../scripts/lib/world/product-policy.mjs";
import { inspectWorldModel } from "../scripts/lib/world/world-model.mjs";
import { createHeadSession, withSessionRoute } from "../scripts/lib/session/session-routing.mjs";
import { createRecoveryCheckpoint } from "../scripts/lib/session/compaction-recovery.mjs";
import { updateProjectDirection } from "../scripts/lib/session/project-direction.mjs";
import { buildWorldModel, materializeWorldMarkdownProjection, captureWorldMarkdownChanges } from "../scripts/lib/world/world-model.mjs";
import { reviewDocumentChanges, inspectDocumentChangeReviewStatus, documentChangeReviewCanonicalJson } from "../scripts/lib/world/document-change-review.mjs";
import {
  captureHistoricalBoundaryApplicationBasis,
  createVerifiedHistoricalInventoryCapability,
  applyHistoricalArtifactBoundary,
} from "../scripts/lib/world/historical-artifact-boundary.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const moduleUrl = new URL("../scripts/lib/session/onboarding.mjs", import.meta.url).href;

async function fixture() {
  const root = fs.mkdtempSync(path.join(pluginRoot, ".qa-onboarding-recovery-"));
  try {
    fs.writeFileSync(path.join(root, "README.md"), "# Message delivery service\n");
    initializeProject({ root, pluginRoot, runtimes: ["codex"] });
    const storage = inspectProject(root).storage,
      layout = formatForVerifiedOwner(storage);
    const canonPath = `${layout.directory}/context/product-model.json`;
    const statePath = `${layout.directory}/onboarding/current.json`;
    const reviewDirectory = `${layout.directory}/onboarding/review-decisions`;
    const started = await startOnboarding({
      root,
      mode: "new",
      brief: {
        schemaVersion: 1,
        name: "Message service",
        summary: "Deliver one reviewed message.",
        capabilities: [{ key: "delivery", name: "Delivery", description: "Deliver a message." }],
      },
    });
    return {
      root,
      storage,
      layout,
      canonPath,
      statePath,
      reviewDirectory,
      request: { root, candidateSetId: started.candidateSet.candidateSetId, disposition: "accept-all", rationale: "Adopt the reviewed delivery capability." },
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function authorityBytes(root, layout) {
  return [
    `${layout.directory}/project.json`,
    `${layout.directory}/sessions/current.json`,
    `${layout.directory}/context/product-model.json`,
    `${layout.directory}/onboarding/current.json`,
  ].map((relative) => fs.readFileSync(path.join(root, relative), "utf8"));
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
      const status = await inspectProjectExperience({ root });
      assert.equal(status.readiness.core.state, "ready");
      assert.equal(status.readiness.product.state, "integrity_attention");
      assert.equal(status.attention.ordinaryWorkBlocked, false);
      assert.equal(status.attention.userDecisionRequired, false);
      const entry = await enterConversationRecovery({ root });
      assert.equal(entry.status, "conversation_ready");
      assert.equal(entry.projectStatus.readiness.product.state, "integrity_attention");
      assert.equal((await initializeOrResumeProject({ root, pluginRoot, profile: "core" })).readiness.core.state, "ready");
      assert.equal((await inspectConversationalOnboarding({ root })).status, "integrity_attention");
      await assert.rejects(() => reviewOnboarding(request));
      assert.deepEqual(authorityBytes(root, layout).slice(0, 2), p2);
      fs.writeFileSync(file, original);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
    const semanticProposal = {
      schemaVersion: 1,
      sourceSnapshotId: world.temporalProvenanceGraph.sourceSnapshotId,
      candidates: [
        {
          productKind: "Capability",
          proposedEntity: { key: "dispatch", name: "Dispatch", description: "Deliver reviewed messages." },
          explanation: "The project README describes message delivery.",
          confidence: 0.8,
          evidence: [{ path: "README.md", line: 1 }],
        },
      ],
    };
    const result = await refreshOnboardingCandidates({
      root,
      semanticProposal,
      recoveryBasis: { pointerHash: state.pointerHash, rawHash: crypto.createHash("sha256").update(damaged).digest("hex") },
    });
    assert.notEqual(result.candidateSet.candidateSetId, request.candidateSetId);
    assert.deepEqual(result.candidateSet.parentCandidateSetIds, []);
    assert.equal(result.state.latestReviewDecisionId, null);
    assert.deepEqual(authorityBytes(root, layout).slice(0, 3), p1p2);
    assert.equal((await inspectOnboarding({ root })).status, "awaiting_review");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("semantic recovery preserves failed preconditions and resumes exact custody after interruption", async () => {
  for (const fault of ["canon-drift", "throw-after-unlink", "crash-after-unlink"]) {
    const { root, layout, canonPath, statePath, reviewDirectory, request } = await fixture();
    try {
      const state = (await inspectOnboarding({ root })).state,
        world = (await inspectWorldModel({ root })).snapshot;
      const file = path.join(root, layout.directory, "onboarding/candidate-sets", `${request.candidateSetId}.json`);
      const damaged = Buffer.from("{broken");
      fs.writeFileSync(file, damaged);
      const options = {
        root,
        recoveryBasis: { pointerHash: state.pointerHash, rawHash: crypto.createHash("sha256").update(damaged).digest("hex") },
        semanticProposal: {
          schemaVersion: 1,
          sourceSnapshotId: world.temporalProvenanceGraph.sourceSnapshotId,
          candidates: [
            {
              productKind: "Capability",
              proposedEntity: { key: "dispatch", name: "Dispatch", description: "Deliver messages." },
              explanation: "README describes delivery.",
              confidence: 0.8,
              evidence: [{ path: "README.md", line: 1 }],
            },
          ],
        },
      };
      if (fault === "canon-drift") {
        fs.writeFileSync(
          path.join(root, canonPath),
          JSON.stringify({
            schemaVersion: 1,
            featureGroups: [],
            capabilities: [{ key: "later", name: "Later", description: "Later approved value." }],
            features: [],
            requirements: [],
            constraints: [],
            decisions: [],
          }),
        );
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
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
        cwd: pluginRoot,
        encoding: "utf8",
        timeout: 45000,
        windowsHide: true,
      });
      assert.equal(child.error, undefined);
      assert.equal(child.status, fault === "crash-after-unlink" ? 44 : 0, child.stderr);
      if (fault === "throw-after-unlink") assert.deepEqual(fs.readFileSync(file), damaged);
      else assert.equal(fs.existsSync(file), false);
      assert.deepEqual(authorityBytes(root, layout), before);
      const result = await refreshOnboardingCandidates(options);
      assert.equal(result.status, "onboarding_candidates_refreshed");
      assert.deepEqual(authorityBytes(root, layout).slice(0, 3), before.slice(0, 3));
      assert.deepEqual(result.candidateSet.parentCandidateSetIds, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
    cwd: pluginRoot,
    encoding: "utf8",
    timeout: 45_000,
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
        const inspected = await inspectOnboarding({ root });
        if (boundary !== "state-2") {
          assert.equal(inspected.status, "promotion_recovery_pending");
          const guide = await inspectConversationalOnboarding({ root });
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
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((item) => item.isFile())
    .map((item) => {
      const file = path.join(item.parentPath, item.name),
        stat = fs.statSync(file);
      return [path.relative(root, file), crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"), stat.mtimeMs, stat.mode];
    })
    .sort(([a], [b]) => a.localeCompare(b));
}

for (const worldState of ["current", "stale", "missing", "corrupt"])
  test(`ordinary entry leaves ${worldState} aggregate World explicitly unchecked without weakening full diagnosis`, async () => {
    const { root, layout, canonPath, statePath, reviewDirectory, request } = await fixture();
    try {
      const accepted = await reviewOnboarding(request);
      const worldFile = worldSnapshotFile(root, accepted.worldModel.worldModelId);
      if (worldState === "stale") fs.appendFileSync(path.join(root, "README.md"), "\nChanged synthetic source after approval.\n");
      if (worldState === "missing") fs.unlinkSync(worldFile);
      if (worldState === "corrupt") fs.writeFileSync(worldFile, "{broken-derived-world");
      const before = treeReadSnapshot(root),
        fullBefore = await inspectProjectExperience({ root });
      if (worldState === "corrupt") {
        await assert.rejects(async () => await inspectOnboarding({ root }));
        assert.equal(fullBefore.readiness.product.state, "integrity_attention");
      } else {
        const full = await inspectOnboarding({ root });
        assert.equal(full.worldModel.status, worldState === "missing" ? "unavailable" : worldState);
        assert.equal(fullBefore.readiness.product.state, worldState === "current" ? "ready" : "refresh_required");
        assert.equal(
          fullBefore.readiness.context.repositoryEvidence,
          worldState === "current" ? "available-current-world" : worldState === "missing" ? "missing-excluded" : "stale-excluded",
        );
      }
      const entry = await enterConversationRecovery({ root }),
        product = entry.projectStatus.readiness.product;
      assert.equal(entry.status, "conversation_ready");
      assert.equal(entry.projectStatus.status, "core_ready");
      assert.equal(product.state, "reviewed_world_unchecked");
      assert.equal(product.onboardingStatus, "ready_world_unchecked");
      assert.equal(product.governanceActivated, true);
      assert.equal(entry.projectStatus.readiness.context.state, "world-not-inspected");
      assert.equal(entry.projectStatus.readiness.context.repositoryEvidence, "not-inspected");
      assert.equal(entry.projectStatus.readiness.context.worldModelId, null);
      assert.equal(entry.projectStatus.capabilities.find((item) => item.id === "product-governance").availability, "available-on-demand");
      assert.equal(entry.projectStatus.nextAction.id, "work_directly");
      assert.equal(entry.headActionRequired, false);
      assert.equal(entry.userDecisionRequired, false);
      assert.equal(entry.ordinaryWorkBlocked, false);
      assert.deepEqual(entry.blockedOperations, []);
      assert.deepEqual(await inspectProjectExperience({ root }), fullBefore, "Explicit full diagnostic facts do not change after unchecked entry");
      assert.deepEqual(treeReadSnapshot(root), before, "All entry/full diagnostic reads preserve bytes, mtime and mode");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

test("entry still validates ReviewDecision and Product Canon originals rather than treating unchecked World as approval", async () => {
  const { root, layout, canonPath, statePath, reviewDirectory, request } = await fixture();
  try {
    const accepted = await reviewOnboarding(request);
    const reviewFile = path.join(root, reviewDirectory, `${accepted.reviewDecision.reviewDecisionId}.json`);
    for (const file of [reviewFile, path.join(root, canonPath)]) {
      const original = fs.readFileSync(file),
        data = JSON.parse(original);
      if (file === reviewFile) data.rationale = "Tampered synthetic approval";
      else data.capabilities[0].name = "Tampered synthetic Canon";
      fs.writeFileSync(file, JSON.stringify(data));
      const before = treeReadSnapshot(root),
        entry = await enterConversationRecovery({ root });
      assert.equal(entry.projectStatus.readiness.product.state, "integrity_attention");
      assert.equal(entry.projectStatus.readiness.product.governanceActivated, null);
      assert.equal(entry.projectStatus.readiness.context.repositoryEvidence, "unverified-excluded");
      assert.equal(entry.ordinaryWorkBlocked, false);
      assert.equal(entry.userDecisionRequired, false);
      await assert.rejects(async () => await inspectOnboarding({ root }));
      assert.deepEqual(treeReadSnapshot(root), before);
      fs.writeFileSync(file, original);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("entry keeps explicitly selected P2 when the separate default Product owner is damaged", async () => {
  const { root, layout, canonPath, statePath, reviewDirectory, request } = await fixture();
  try {
    await reviewOnboarding(request);
    const selected = createHeadSession({ root, purpose: "Inspect selected synthetic Session, not default" });
    const checkpoint = withSessionRoute(
      root,
      selected.sessionId,
      () =>
        createRecoveryCheckpoint({
          root,
          purpose: selected.state.purpose,
          approvedDecisions: [],
          currentPosition: "Selected original checkpoint",
          nextExpectedResult: "Explain only; never deploy",
        }).checkpoint,
    );
    const latest = updateProjectDirection({ root, input: { goal: "Independent local explanation", cancelledActions: ["deploy"] } }).direction;
    fs.writeFileSync(path.join(root, layout.directory, "sessions/current.json"), "{broken-default-session");
    const before = treeReadSnapshot(root);
    const entry = await withSessionRoute(root, selected.sessionId, async () => await enterConversationRecovery({ root }));
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
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("completed acceptance tolerates absent World across Core entry, status and both resumes without writes", async () => {
  for (const missing of ["directory", "snapshot"]) {
    const { root, layout, canonPath, statePath, reviewDirectory, request } = await fixture();
    try {
      const approved = await reviewOnboarding(request);
      if (missing === "directory") fs.rmSync(path.join(root, layout.directory, "world-model"), { recursive: true, force: true });
      else fs.unlinkSync(worldSnapshotFile(root, approved.worldModel.worldModelId));
      const before = treeBytes(root);
      const status = await inspectOnboarding({ root });
      assert.equal(status.status, "ready_world_changed");
      assert.equal(status.worldModel.status, "unavailable");
      assert.equal(status.worldModel.reasonCode, missing === "directory" ? "WORLD_MODEL_NOT_BUILT" : "WORLD_MODEL_SNAPSHOT_MISSING");
      const experience = await inspectProjectExperience({ root });
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
      await assert.rejects(async () => await inspectOnboarding({ root }), { code: "ONBOARDING_REVIEW_DIGEST_MISMATCH" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

async function nonPromotingRequest(root, request, disposition) {
  if (disposition === "reject") return { ...request, disposition };
  const candidate = (await inspectOnboarding({ root })).candidateSet.candidates[0];
  return { ...request, disposition, userEdits: [{ candidateId: candidate.candidateId, entity: { ...candidate.proposedEntity, name: "Reviewed delivery" } }] };
}

test("revise and reject recover every publication boundary and their actual next workflow", async () => {
  for (const disposition of ["revise", "reject"]) {
    for (const boundary of ["decision", ...(disposition === "revise" ? ["candidate"] : []), "state-1", "world", "state-2"]) {
      const { root, layout, canonPath, statePath, reviewDirectory, request: initial } = await fixture();
      try {
        const request = await nonPromotingRequest(root, initial, disposition);
        const before = authorityBytes(root, layout);
        interruptedReview(request, boundary, { layout });
        assert.deepEqual(authorityBytes(root, layout).slice(0, 3), before.slice(0, 3), "non-promoting decision never changes Canon/Project/Session");
        const status = await inspectOnboarding({ root });
        if (boundary !== "state-2") {
          assert.equal(status.status, "review_recovery_pending", `${disposition}:${boundary}`);
          const guide = await inspectConversationalOnboarding({ root });
          assert.equal(guide.nextAction, "initialize_or_resume");
          assert.deepEqual(guide.materialChoicesRequired, []);
        }
        const replay = await reviewOnboarding(request);
        assert.equal(
          replay.status,
          disposition === "revise" ? "onboarding_revision_awaiting_review" : "onboarding_rejected",
          JSON.stringify(replay.projection),
        );
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
          const accepted = await reviewOnboarding({
            root,
            candidateSetId: successor.candidateSetId,
            disposition: "accept-all",
            rationale: "Approve the reviewed successor.",
          });
          assert.equal(accepted.status, "onboarding_ready", `${disposition}:${boundary} ${JSON.stringify(accepted.projection)}`);
          assert.equal(accepted.productModel.capabilities[0].name, "Reviewed delivery");
        } else assert.equal((await inspectOnboarding({ root })).status, "rejected");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  }
});

test("legacy Graph-only review remnants reconcile from persisted records without inventing a decision", async () => {
  for (const disposition of ["revise", "reject"]) {
    const { root, layout, canonPath, statePath, reviewDirectory, request: initial } = await fixture();
    try {
      const request = await nonPromotingRequest(root, initial, disposition);
      const beforeState = fs.readFileSync(path.join(root, statePath), "utf8");
      const beforeCanon = fs.readFileSync(path.join(root, canonPath), "utf8");
      const completed = await reviewOnboarding(request);
      // Construct the exact filesystem boundary produced by the former
      // Graph-first implementation, using a real verified current snapshot.
      fs.writeFileSync(path.join(root, statePath), beforeState);
      fs.unlinkSync(path.join(root, reviewDirectory, `${completed.reviewDecision.reviewDecisionId}.json`));
      if (completed.candidateSet)
        fs.unlinkSync(path.join(root, layout.directory, "onboarding/candidate-sets", `${completed.candidateSet.candidateSetId}.json`));
      assert.equal((await inspectWorldModel({ root })).status, "stale");
      assert.equal(await recoverOnboardingPromotion({ root }), null);
      const refreshed = await refreshOnboardingCandidates({ root });
      assert.equal(refreshed.status, "onboarding_candidates_current");
      assert.equal(fs.readdirSync(path.join(root, reviewDirectory)).length, 0, "a P4 decision copy never recreates P1");
      assert.equal(fs.readFileSync(path.join(root, canonPath), "utf8"), beforeCanon);
      assert.equal(fs.readFileSync(path.join(root, statePath), "utf8"), beforeState);
      const reviewed = await reviewOnboarding(request);
      assert.equal(reviewed.status, disposition === "revise" ? "onboarding_revision_awaiting_review" : "onboarding_rejected");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("awaiting review refreshes missing optional World before offering the original decision", async () => {
  for (const missing of ["directory", "snapshot"]) {
    const { root, layout, canonPath, statePath, reviewDirectory, request } = await fixture();
    try {
      const initial = await inspectOnboarding({ root });
      if (missing === "directory") fs.rmSync(path.join(root, layout.directory, "world-model"), { recursive: true, force: true });
      else fs.unlinkSync(worldSnapshotFile(root, initial.worldModel.worldModelId));
      const before = treeBytes(root);
      const authority = authorityBytes(root, layout);
      const guide = await inspectConversationalOnboarding({ root });
      assert.equal(guide.nextAction, "refresh_or_reconcile_world");
      assert.deepEqual(guide.materialChoicesRequired, []);
      assert.equal((await inspectProjectExperience({ root })).readiness.product.state, "refresh_required");
      assert.equal((await inspectProjectExperience({ root })).readiness.context.repositoryEvidence, "missing-excluded");
      const entry = await enterConversationRecovery({ root });
      assert.equal(entry.projectStatus.readiness.product.state, "review_required");
      assert.equal(entry.projectStatus.readiness.context.repositoryEvidence, "not-inspected");
      assert.equal(entry.attention.items.find((item) => item.id === "product-canon-review").actionability, "when-product-governance-is-in-scope");
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
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("completed revise and reject replay disclose later source drift without rebuilding", async () => {
  for (const disposition of ["revise", "reject"]) {
    const { root, layout, canonPath, statePath, reviewDirectory, request: initial } = await fixture();
    try {
      const request = await nonPromotingRequest(root, initial, disposition);
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
        assert.equal(resumed.onboardingAction, "fresh-lode-semantic-reproposal-required");
        assert.equal((await inspectConversationalOnboarding({ root })).nextAction, "refresh_or_reconcile_world");
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
    await assert.rejects(
      async () => await inspectOnboarding({ root }),
      (error) => !["WORLD_MODEL_NOT_BUILT", "WORLD_MODEL_SNAPSHOT_MISSING"].includes(error.code),
    );
    const core = await initializeOrResumeProject({ root, pluginRoot, profile: "core" });
    assert.equal(core.readiness.core.state, "ready");
    assert.equal(core.readiness.product.state, "integrity_attention");
    fs.unlinkSync(filename);
    const pointerFile = path.join(root, layout.directory, "world-model/current.json");
    const pointer = JSON.parse(fs.readFileSync(pointerFile, "utf8"));
    pointer.worldModelHash = "0".repeat(64);
    fs.writeFileSync(pointerFile, JSON.stringify(pointer));
    await assert.rejects(async () => await inspectOnboarding({ root }), { code: "WORLD_MODEL_POINTER_MISMATCH" });
    await assert.rejects(async () => await initializeOrResumeProject({ root, pluginRoot, profile: "product" }), { code: "WORLD_MODEL_POINTER_MISMATCH" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("physical composition and part damage remain strict Product errors without blocking Core", async (t) => {
  for (const layout of ["shared-domains-v2", "chunked-code-v3"])
    await t.test(layout, async (t) => {
      const { root, storage, canonPath, request } = await fixture();
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const accepted = await reviewOnboarding(request);
      const file = worldSnapshotFile(root, accepted.worldModel.worldModelId);
      const chunked = layout === "chunked-code-v3";
      if (!chunked) {
        // An explicit retained v2 fixture supplements, rather than replaces, the
        // omitted-layout production default exercised by the v3 branch.
        const document = readFixtureSnapshot(file);
        const composition = createSnapshotComposition({ root, storage, document, layout }).document;
        writeFixtureSnapshot(file, composition);
        const pointerFile = path.join(root, storage.directory, "world-model/current.json");
        const pointer = JSON.parse(fs.readFileSync(pointerFile, "utf8"));
        pointer.readerRequirements = snapshotReaderRequirements({ document, snapshotStorage: { layout } });
        fs.writeFileSync(pointerFile, JSON.stringify(pointer));
      }
      await inspectOnboarding({ root });
      const canonFile = path.resolve(root, canonPath);
      const original = fs.readFileSync(file),
        canon = fs.readFileSync(canonFile);
      const protectedAuthority = authorityBytes(root, formatForVerifiedOwner(storage));
      const physical = readSnapshotFile(file).document;
      assert.equal(physical.kind, "SnapshotComposition");
      assert.equal(physical.schemaVersion, chunked ? 3 : 2);
      const partFile = path.join(root, physical.code.address),
        originalPart = fs.readFileSync(partFile);
      const writePart = (ref, raw) => {
        ref.sha256 = crypto.createHash("sha256").update(raw).digest("hex");
        ref.byteLength = raw.length;
        ref.address = path.posix.join(path.posix.dirname(ref.address), String(ref.sha256) + ".json.gz");
        const target = path.join(root, ref.address);
        fs.writeFileSync(target, zlib.gzipSync(raw), { flag: "wx" });
        return target;
      };
      const forgedPart = (value, raw, graph = false) => {
        const target = writePart(graph ? value.graph.code : value.code, raw);
        writeFixtureSnapshot(file, value);
        return target;
      };
      const changedPayload = (change, graph = false) => {
        const value = structuredClone(physical),
          ref = graph ? value.graph.code : value.code;
        const part = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root, ref.address))));
        change(part);
        return forgedPart(value, Buffer.from(JSON.stringify(part) + "\n"), graph);
      };
      const changedLeaf = (change) => {
        const value = structuredClone(physical);
        const index = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root, value.code.address))));
        assert.ok(index.payload.chunks.length > 0);
        const ref = index.payload.chunks[0].ref;
        const leaf = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root, ref.address))));
        change(leaf);
        const leafFile = writePart(ref, Buffer.from(JSON.stringify(leaf) + "\n"));
        return [forgedPart(value, Buffer.from(JSON.stringify(index) + "\n")), leafFile];
      };
      const payloadError = chunked ? "INVALID_SNAPSHOT_CODE_CHUNKS" : "INVALID_SNAPSHOT_BUNDLE_SHAPE";
      const cases = [
        [
          "duplicate exact representation",
          "SNAPSHOT_REPRESENTATION_CONFLICT",
          () => {
            const duplicate = file.replace(/\.gz$/, "");
            assert.notEqual(duplicate, file);
            fs.writeFileSync(duplicate, zlib.gunzipSync(original), { flag: "wx" });
            return duplicate;
          },
          () => fs.unlinkSync(file.replace(/\.gz$/, "")),
        ],
        ["root encoding", "INVALID_WORLD_MODEL_STORE_DOCUMENT", () => fs.writeFileSync(file, "invalid gzip")],
        [
          "root shape",
          "INVALID_SNAPSHOT_COMPOSITION",
          () => {
            const value = structuredClone(physical);
            value.unrecorded = true;
            writeFixtureSnapshot(file, value);
          },
        ],
        [
          "unsupported schema",
          "STORAGE_VERSION_MISMATCH",
          () => {
            const value = structuredClone(physical);
            value.schemaVersion = 4;
            writeFixtureSnapshot(file, value);
          },
        ],
        [
          "unsupported producer",
          "STORAGE_VERSION_MISMATCH",
          () => {
            const value = structuredClone(physical);
            value.producer.version = "9.0.0";
            writeFixtureSnapshot(file, value);
          },
        ],
        [
          "same address conflicting descriptor",
          "CONFLICTING_SNAPSHOT_BUNDLE_DESCRIPTOR",
          () => {
            const value = structuredClone(physical);
            Object.assign(value.code, { address: value.graph.code.address, sha256: value.graph.code.sha256, byteLength: value.graph.code.byteLength });
            writeFixtureSnapshot(file, value);
          },
        ],
        [
          "reconstructed digest",
          "SNAPSHOT_COMPOSITION_DIGEST_MISMATCH",
          () => {
            const value = structuredClone(physical);
            value.reconstructedSha256 = "0".repeat(64);
            writeFixtureSnapshot(file, value);
          },
        ],
        ["part encoding", "INVALID_SNAPSHOT_BUNDLE_ENCODING", () => fs.writeFileSync(partFile, "invalid gzip")],
        [
          "part digest",
          "SNAPSHOT_BUNDLE_DIGEST_MISMATCH",
          () => {
            const value = JSON.parse(zlib.gunzipSync(originalPart));
            value.projectId = "x" + value.projectId.slice(1);
            fs.writeFileSync(partFile, zlib.gzipSync(JSON.stringify(value) + "\n"));
          },
        ],
        [
          "root null body",
          "INVALID_SNAPSHOT_COMPOSITION",
          () => {
            const value = structuredClone(physical);
            value.body = null;
            writeFixtureSnapshot(file, value);
          },
        ],
        [
          "legacy null graph reference",
          "SNAPSHOT_BUNDLE_TYPE_MISMATCH",
          () => {
            const value = structuredClone(physical);
            value.schemaVersion = 1;
            value.producer.version = "0.1.0";
            value.graph = null;
            writeFixtureSnapshot(file, value);
          },
        ],
        ["rehashed invalid UTF8", "INVALID_SNAPSHOT_BUNDLE_ENCODING", () => forgedPart(structuredClone(physical), Buffer.from([0xff, 0x0a]))],
        ["rehashed non JSON", "INVALID_SNAPSHOT_BUNDLE_ENCODING", () => forgedPart(structuredClone(physical), Buffer.from("{invalid}\n"))],
        ["rehashed null bundle", "SNAPSHOT_BUNDLE_TYPE_MISMATCH", () => forgedPart(structuredClone(physical), Buffer.from("null\n"))],
        [
          "rehashed null world payload",
          payloadError,
          () =>
            changedPayload((part) => {
              part.payload = null;
            }),
        ],
        [
          "rehashed null graph payload",
          payloadError,
          () =>
            changedPayload((part) => {
              part.payload = null;
            }, true),
        ],
        [
          "rehashed invalid graph arrays",
          payloadError,
          () =>
            changedPayload((part) => {
              if (chunked) {
                part.payload.lists.nodes.order = null;
                part.payload.lists.edges.order = {};
              } else {
                part.payload.nodes = null;
                part.payload.edges = {};
              }
            }, true),
        ],
        [
          "graph order exceeds code records",
          "INVALID_SNAPSHOT_BUNDLE_SHAPE",
          () => {
            const value = structuredClone(physical);
            value.graph.nodeOrder.push(true);
            writeFixtureSnapshot(file, value);
          },
        ],
        ...(chunked
          ? [
              [
                "rehashed invalid bucket order",
                payloadError,
                () =>
                  changedPayload((part) => {
                    part.payload.lists.files.order.push(64);
                  }),
              ],
              [
                "rehashed leaf array group",
                payloadError,
                () =>
                  changedLeaf((part) => {
                    part.payload.group = ["world"];
                  }),
              ],
              [
                "rehashed leaf list shape",
                payloadError,
                () =>
                  changedLeaf((part) => {
                    part.payload.lists.files = null;
                  }),
              ],
            ]
          : []),
      ];
      for (const [name, code, corrupt, cleanup] of cases)
        await t.test(name, async () => {
          try {
            const result = corrupt();
            const observedParts = Array.isArray(result) ? result : [result || partFile];
            const badRoot = fs.readFileSync(file),
              badParts = observedParts.map((part) => fs.readFileSync(part));
            await assert.rejects(() => inspectOnboarding({ root }), { code });
            await assert.rejects(() => initializeOrResumeProject({ root, pluginRoot, profile: "product" }), { code });
            const diagnostic = await inspectOptionalOnboarding({ root });
            assert.equal(diagnostic.reasonCode, code);
            assert.equal(diagnostic.ordinaryWorkBlocked, false);
            const core = await initializeOrResumeProject({ root, pluginRoot, profile: "core" });
            assert.equal(core.readiness.core.state, "ready");
            assert.equal(core.readiness.product.state, "integrity_attention");
            assert.deepEqual(fs.readFileSync(file), badRoot);
            observedParts.forEach((part, index) => assert.deepEqual(fs.readFileSync(part), badParts[index]));
            assert.deepEqual(fs.readFileSync(canonFile), canon);
            assert.deepEqual(authorityBytes(root, formatForVerifiedOwner(storage)), protectedAuthority);
          } finally {
            fs.writeFileSync(file, original);
            fs.writeFileSync(partFile, originalPart);
            cleanup?.();
          }
        });
      await inspectOnboarding({ root });
    });
});

// Public application and read regressions, independent of generated graphs as
// approval evidence. Optional diagnostics never overwrite baseline evidence.
async function approvedDocumentSuccessorFixture(t, historical, hops) {
  const f = await fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  await reviewOnboarding(f.request);
  if (historical) {
    // Synthetic boundary uses exact current fixture originals; no real legacy
    // bytes are parsed, migrated or rewritten by this regression.
    const basis = captureHistoricalBoundaryApplicationBasis({ root: f.root });
    const state = basis.onboardingState;
    const entries = [
      ["historical-candidate-set", "candidate-sets", state.candidateSetId],
      ["historical-review", "review-decisions", state.latestReviewDecisionId],
      ["historical-product-revision", "product-model-revisions", state.productModelId],
    ]
      .map(([role, directory, artifactId]) => {
        const relative = `${f.layout.directory}/onboarding/${directory}/${artifactId}.json`;
        const raw = fs.readFileSync(path.join(f.root, relative));
        const doc = JSON.parse(raw);
        return {
          path: relative,
          role,
          artifactId,
          protocolFamily: doc.protocol?.name || doc.kind,
          protocolVersion: doc.protocol?.version || String(doc.schemaVersion || ""),
          byteLength: raw.length,
          sha256: crypto.createHash("sha256").update(raw).digest("hex"),
          interpretationMode: role === "historical-product-revision" ? "current-typed-with-historical-provenance" : "opaque-historical",
        };
      })
      .sort((a, b) => a.path.localeCompare(b.path, "en"));
    const capability = createVerifiedHistoricalInventoryCapability({
      root: f.root,
      projectId: basis.projectId,
      storage: f.storage,
      entries,
      validation: {
        status: "complete-ready-verified",
        instructionAuthority: false,
        promotionAuthority: false,
        supportedCandidateVersions: ["0.3.0"],
        historicalReadyCandidateSetId: state.candidateSetId,
        historicalReadyReviewDecisionId: state.latestReviewDecisionId,
        historicalResultingProductModelId: state.productModelId,
      },
    });
    applyHistoricalArtifactBoundary({ root: f.root, verifiedInventory: capability, hostMode: "explicit-one-shot" });
    await buildWorldModel({ root: f.root });
  }
  assert.equal((await inspectOnboarding({ root: f.root })).status, "ready");
  const beforeState = fs.readFileSync(path.join(f.root, f.statePath));
  const applications = [];
  for (let hop = 1; hop <= hops; hop++) {
    await materializeWorldMarkdownProjection({ root: f.root });
    fs.appendFileSync(path.join(f.root, f.layout.directory, "generated/knowledge/index.md"), `\nSynthetic reviewed successor ${hop}.\n`);
    const captured = await captureWorldMarkdownChanges({ root: f.root, persist: true });
    const model = JSON.parse(fs.readFileSync(path.join(f.root, f.canonPath)));
    model.capabilities[0].description = `Explicitly reviewed delivery contract ${hop}.`;
    const applied = await reviewDocumentChanges({
      root: f.root,
      candidateSetId: captured.candidateSet.candidateSetId,
      disposition: "accept-all",
      rationale: `Synthetic explicit successor ${hop} approval.`,
      resultingProductModel: model,
      apply: true,
    });
    const status = await inspectDocumentChangeReviewStatus({ root: f.root, candidateSetId: captured.candidateSet.candidateSetId });
    assert.equal(status.canonApplied, true);
    assert.equal(status.projectionsReady, true);
    assert.equal(status.status, "applied");
    applications.push({ status, application: applied.applicationReceipt });
  }
  assert.deepEqual(fs.readFileSync(path.join(f.root, f.statePath)), beforeState);
  assert.equal((await inspectWorldModel({ root: f.root })).status, "current");
  const guide = await inspectConversationalOnboarding({ root: f.root });
  return { ...f, beforeState, guide, applications };
}

for (const historical of [false, true])
  for (const hops of [1, 2])
    test(`approved document successor lineage: ${historical ? "historical" : "modern"} ready with ${hops} hop(s) remains readable`, async (t) => {
      const f = await approvedDocumentSuccessorFixture(t, historical, hops);
      // Canon ownership is established by the public document review/application,
      // not by a direct file write or by this status assertion.
      const status = await inspectOnboarding({ root: f.root });
      assert.equal(status.status, "ready");
      assert.equal(status.productModel.productModelId, f.applications.at(-1).status.resultingProductModelId);
      assert.deepEqual(fs.readFileSync(path.join(f.root, f.statePath)), f.beforeState);
    });

test("approved document successor lineage: historical fresh semantic proposal uses current reviewed base", async (t) => {
  const f = await approvedDocumentSuccessorFixture(t, true, 1);
  const world = (await inspectWorldModel({ root: f.root })).snapshot;
  const proposed = await proposeOnboardingSemanticRefresh({
    root: f.root,
    semanticProposal: {
      schemaVersion: 1,
      sourceSnapshotId: world.temporalProvenanceGraph.sourceSnapshotId,
      candidates: [
        {
          productKind: "Capability",
          proposedEntity: { key: "fresh-delivery", name: "Fresh delivery", description: "Fresh explicitly unreviewed proposal." },
          evidence: [{ path: "README.md", line: 1 }],
          explanation: "Synthetic current source evidence.",
          confidence: 0.9,
        },
      ],
    },
  });
  assert.equal(proposed.candidateSet.productModelId, f.applications.at(-1).status.resultingProductModelId);
  assert.equal(proposed.state.latestReviewDecisionId, null);
  assert.deepEqual(proposed.candidateSet.parentCandidateSetIds, []);
});

function successorTreeObservation(root) {
  const result = {};
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const next = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) {
        const file = path.join(root, next),
          raw = fs.readFileSync(file),
          stat = fs.statSync(file);
        result[next] = { hash: crypto.createHash("sha256").update(raw).digest("hex"), mtimeMs: stat.mtimeMs, mode: stat.mode };
      }
    }
  };
  walk(inspectProject(root).storage.directory);
  return result;
}

async function appendReviewedDocument(root, layout, description, { apply = true, disposition = "accept-all" } = {}) {
  await materializeWorldMarkdownProjection({ root });
  fs.appendFileSync(path.join(root, layout.directory, "generated/knowledge/index.md"), `\nSynthetic proposal: ${description}.\n`);
  const captured = await captureWorldMarkdownChanges({ root, persist: true });
  const model = JSON.parse(fs.readFileSync(path.join(root, layout.directory, "context/product-model.json")));
  model.capabilities[0].description = description;
  const result = await reviewDocumentChanges({
    root,
    candidateSetId: captured.candidateSet.candidateSetId,
    disposition,
    rationale: "Synthetic explicit decision.",
    ...(disposition === "reject" ? {} : { resultingProductModel: model }),
    apply,
  });
  return { captured, result, model };
}

test("approved document successor rejects damaged or incomplete original closure without read effects", async (t) => {
  const f = await approvedDocumentSuccessorFixture(t, false, 1);
  const status = f.applications[0].status;
  const paths = {
    application: `${f.layout.directory}/document-changes/applications/${status.applicationReceiptId}.json`,
    review: `${f.layout.directory}/document-changes/review-decisions/${status.reviewDecisionId}.json`,
    candidate: `${f.layout.directory}/document-changes/candidate-sets/${status.candidateSetId}.json`,
    revision: `${f.layout.directory}/document-changes/product-model-revisions/${status.resultingProductModelId}.json`,
  };
  const healthy = successorTreeObservation(f.root);
  const entry = await inspectOptionalOnboardingForEntry({ root: f.root });
  assert.equal(entry.status, "ready_world_unchecked");
  assert.equal(entry.productCanonLineage.hops.length, 1);
  assert.equal(entry.productCanonLineage.current.family, "document-change");
  assert.deepEqual(successorTreeObservation(f.root), healthy);
  for (const [kind, relative] of Object.entries(paths)) {
    for (const mutation of ["missing", "tampered"])
      await t.test(`${kind}-${mutation}`, async () => {
        const file = path.join(f.root, relative),
          original = fs.readFileSync(file);
        try {
          if (mutation === "missing") fs.unlinkSync(file);
          else {
            const changed = JSON.parse(original);
            changed.projectId = "lode-" + "f".repeat(20);
            fs.writeFileSync(file, JSON.stringify(changed));
          }
          const before = successorTreeObservation(f.root);
          const diagnostic = await inspectOptionalOnboardingForEntry({ root: f.root });
          assert.equal(diagnostic.status, "integrity_attention");
          // Without its receipt the change is not on record (drift); any other
          // missing or altered record makes the records unverifiable.
          assert.equal(
            diagnostic.reasonCode,
            kind === "application" && mutation === "missing" ? "ONBOARDING_PRODUCT_CANON_DRIFT" : "ONBOARDING_PRODUCT_SUCCESSOR_UNVERIFIABLE",
          );
          assert.deepEqual(successorTreeObservation(f.root), before);
        } finally {
          fs.writeFileSync(file, original);
        }
      });
  }
  await t.test("direct-canon-edit", async () => {
    const file = path.join(f.root, f.canonPath),
      original = fs.readFileSync(file);
    try {
      const changed = JSON.parse(original);
      changed.capabilities[0].description = "Unreviewed edit";
      fs.writeFileSync(file, JSON.stringify(changed));
      const before = successorTreeObservation(f.root);
      assert.equal((await inspectOptionalOnboardingForEntry({ root: f.root })).reasonCode, "ONBOARDING_PRODUCT_CANON_DRIFT");
      assert.deepEqual(successorTreeObservation(f.root), before);
    } finally {
      fs.writeFileSync(file, original);
    }
  });
  await t.test("second-receipt-for-the-same-step", async () => {
    const receipt = JSON.parse(fs.readFileSync(path.join(f.root, paths.application)));
    delete receipt.applicationReceiptId;
    delete receipt.applicationReceiptHash;
    receipt.after.documentProjectionHash = "f".repeat(64);
    const hash = crypto.createHash("sha256").update(documentChangeReviewCanonicalJson(receipt)).digest("hex");
    receipt.applicationReceiptId = `document-change-application-${hash.slice(0, 24)}`;
    receipt.applicationReceiptHash = hash;
    const file = path.join(f.root, f.layout.directory, "document-changes/applications", receipt.applicationReceiptId + ".json");
    fs.writeFileSync(file, JSON.stringify(receipt));
    try {
      const before = successorTreeObservation(f.root);
      const diagnostic = await inspectOptionalOnboardingForEntry({ root: f.root });
      // Two completed applications cannot both start from the base: drift.
      assert.equal(diagnostic.reasonCode, "ONBOARDING_PRODUCT_CANON_DRIFT");
      assert.deepEqual(successorTreeObservation(f.root), before);
    } finally {
      fs.unlinkSync(file);
    }
  });
  await t.test("byte-bound", async () => {
    const file = path.join(f.root, paths.application),
      original = fs.readFileSync(file);
    try {
      fs.truncateSync(file, 8 * 1024 * 1024 + 1);
      assert.equal((await inspectOptionalOnboardingForEntry({ root: f.root })).reasonCode, "ONBOARDING_PRODUCT_SUCCESSOR_UNVERIFIABLE");
    } finally {
      fs.writeFileSync(file, original);
    }
  });
  await t.test("record-bound", async () => {
    const files = [];
    try {
      for (let index = 0; index < 128; index++) {
        const file = path.join(
          f.root,
          f.layout.directory,
          "document-changes/applications",
          `document-change-application-${index.toString(16).padStart(24, "0")}.json`,
        );
        fs.writeFileSync(file, "{}");
        files.push(file);
      }
      // The document-change projection's own bound and code.
      assert.equal((await inspectOptionalOnboardingForEntry({ root: f.root })).reasonCode, "DOCUMENT_CHANGE_PROJECTION_LIMIT");
    } finally {
      for (const file of files) fs.unlinkSync(file);
    }
  });
  await t.test("stray-record-file", async () => {
    const file = path.join(f.root, f.layout.directory, "document-changes/applications", "notes.json");
    fs.writeFileSync(file, "{}");
    try {
      const diagnostic = await inspectOptionalOnboardingForEntry({ root: f.root });
      assert.equal(diagnostic.status, "integrity_attention");
      assert.equal(diagnostic.reasonCode, "ONBOARDING_PRODUCT_SUCCESSOR_UNVERIFIABLE");
    } finally {
      fs.unlinkSync(file);
    }
  });
});

test("ready existing Canon without onboarding revision uses only its recorded World base", async (t) => {
  const root = fs.mkdtempSync(path.join(pluginRoot, ".qa-onboarding-existing-canon-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "README.md"), "# Existing reviewed service\n");
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const layout = inspectProject(root).storage;
  await buildWorldModel({ root });
  await materializeWorldMarkdownProjection({ root });
  fs.appendFileSync(path.join(root, layout.directory, "generated/knowledge/index.md"), "\nInitial reviewed delivery.\n");
  const captured = await captureWorldMarkdownChanges({ root, persist: true });
  await reviewDocumentChanges({
    root,
    candidateSetId: captured.candidateSet.candidateSetId,
    disposition: "accept-all",
    rationale: "Synthetic initial Canon approval.",
    apply: true,
    resultingProductModel: {
      schemaVersion: 1,
      featureGroups: [],
      capabilities: [{ key: "delivery", name: "Delivery", description: "Initial delivery." }],
      features: [],
      requirements: [],
      constraints: [],
      decisions: [],
    },
  });
  const started = await startOnboarding({ root, mode: "existing" });
  assert.equal(started.status, "ready_existing_product_canon");
  assert.equal(started.state.candidateSetId, null);
  assert.equal(started.state.latestReviewDecisionId, null);
  assert.equal(fs.existsSync(path.join(root, layout.directory, "onboarding/product-model-revisions", started.state.productModelId + ".json")), false);
  await appendReviewedDocument(root, layout, "Successor to existing Canon");
  const before = successorTreeObservation(root);
  const status = await inspectOnboarding({ root });
  assert.equal(status.status, "ready");
  assert.equal(status.productCanonLineage.base.family, "recorded-world");
  assert.deepEqual(successorTreeObservation(root), before);
  const snapshotFile = worldSnapshotFile(root, started.state.worldModelId),
    original = fs.readFileSync(snapshotFile);
  fs.unlinkSync(snapshotFile);
  try {
    const missing = await inspectOptionalOnboardingForEntry({ root });
    assert.equal(missing.status, "integrity_attention");
    assert.equal(missing.reasonCode, "WORLD_MODEL_SNAPSHOT_MISSING");
  } finally {
    fs.writeFileSync(snapshotFile, original);
  }
});

test("reject receipts and later projection drift do not erase applied successor proof", async (t) => {
  const f = await approvedDocumentSuccessorFixture(t, false, 1);
  await appendReviewedDocument(f.root, f.layout, "Do not adopt this proposal", { disposition: "reject" });
  const status = await inspectOnboarding({ root: f.root });
  assert.equal(status.status, "ready");
  assert.equal(status.productCanonLineage.hops.length, 1);
  fs.appendFileSync(path.join(f.root, "README.md"), "\nLater source change.\n");
  const changed = await inspectOnboarding({ root: f.root });
  assert.equal(changed.status, "ready_world_changed");
  assert.equal(changed.productCanonLineage.hops.length, 1);
});

test("pending onboarding candidates are never rebased by a separate document approval", async (t) => {
  const f = await fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  await materializeWorldMarkdownProjection({ root: f.root });
  fs.appendFileSync(path.join(f.root, f.layout.directory, "generated/knowledge/index.md"), "\nSeparate reviewed contract.\n");
  const captured = await captureWorldMarkdownChanges({ root: f.root, persist: true });
  await reviewDocumentChanges({
    root: f.root,
    candidateSetId: captured.candidateSet.candidateSetId,
    disposition: "accept-all",
    rationale: "Synthetic separate approval.",
    apply: true,
    resultingProductModel: {
      schemaVersion: 1,
      featureGroups: [],
      capabilities: [{ key: "separate", name: "Separate", description: "Separately reviewed contract." }],
      features: [],
      requirements: [],
      constraints: [],
      decisions: [],
    },
  });
  const before = successorTreeObservation(f.root);
  assert.equal((await inspectOptionalOnboardingForEntry({ root: f.root })).reasonCode, "ONBOARDING_PRODUCT_CANON_DRIFT");
  assert.deepEqual(successorTreeObservation(f.root), before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, f.statePath))).phase, "awaiting-review");
});

test("public no-op document approval is rejected without granting another successor", async (t) => {
  const f = await approvedDocumentSuccessorFixture(t, false, 1);
  await materializeWorldMarkdownProjection({ root: f.root });
  fs.appendFileSync(path.join(f.root, f.layout.directory, "generated/knowledge/index.md"), "\nConfirm the existing contract without changing Canon.\n");
  const captured = await captureWorldMarkdownChanges({ root: f.root, persist: true });
  const current = JSON.parse(fs.readFileSync(path.join(f.root, f.canonPath)));
  const applicationDirectory = path.join(f.root, f.layout.directory, "document-changes/applications");
  const reviewDirectory = path.join(f.root, f.layout.directory, "document-changes/review-decisions");
  const originalApplications = fs.readdirSync(applicationDirectory).sort();
  const originalReviews = fs.readdirSync(reviewDirectory).sort();
  await assert.rejects(
    reviewDocumentChanges({
      root: f.root,
      candidateSetId: captured.candidateSet.candidateSetId,
      disposition: "accept-all",
      rationale: "Synthetic approval retains exactly the current Product contract.",
      resultingProductModel: current,
      apply: true,
    }),
    { code: "DOCUMENT_CHANGE_CANON_CHANGE_REQUIRED" },
  );
  assert.deepEqual(fs.readdirSync(applicationDirectory).sort(), originalApplications);
  assert.deepEqual(fs.readdirSync(reviewDirectory).sort(), originalReviews);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, f.canonPath))), current);
  const before = successorTreeObservation(f.root);
  const inspected = await inspectOnboarding({ root: f.root });
  assert.equal(inspected.status, "ready_world_changed");
  assert.equal(inspected.productCanonLineage.hops.length, 1);
  assert.deepEqual(successorTreeObservation(f.root), before);
  assert.deepEqual(fs.readFileSync(path.join(f.root, f.statePath)), f.beforeState);
});

function identifiedSuccessorArtifact(document, idField, hashField, prefix) {
  const payload = structuredClone(document);
  delete payload[idField];
  delete payload[hashField];
  const hash = crypto.createHash("sha256").update(documentChangeReviewCanonicalJson(payload)).digest("hex");
  return { ...payload, [idField]: `${prefix}-${hash.slice(0, 24)}`, [hashField]: hash };
}

test("rehashed foreign owner and wrong predecessor cannot borrow an approved successor", async (t) => {
  const f = await approvedDocumentSuccessorFixture(t, false, 1),
    status = f.applications[0].status;
  const appDir = path.join(f.root, f.layout.directory, "document-changes/applications"),
    reviewDir = path.join(f.root, f.layout.directory, "document-changes/review-decisions");
  const appFile = path.join(appDir, status.applicationReceiptId + ".json"),
    originalApp = fs.readFileSync(appFile);
  const review = JSON.parse(fs.readFileSync(path.join(reviewDir, status.reviewDecisionId + ".json")));
  for (const kind of ["foreign-project", "wrong-predecessor"])
    await t.test(kind, async () => {
      const created = [];
      try {
        const changed = JSON.parse(originalApp);
        if (kind === "foreign-project") changed.projectId = "lode-" + "f".repeat(20);
        else {
          const forgedReview = identifiedSuccessorArtifact(
            { ...review, reviewedProductModelId: "product-model-" + "f".repeat(24), reviewedProductModelHash: "f".repeat(64) },
            "reviewDecisionId",
            "reviewDecisionHash",
            "document-change-review-decision",
          );
          const file = path.join(reviewDir, forgedReview.reviewDecisionId + ".json");
          fs.writeFileSync(file, JSON.stringify(forgedReview));
          created.push(file);
          changed.reviewDecisionId = forgedReview.reviewDecisionId;
          changed.reviewDecisionHash = forgedReview.reviewDecisionHash;
          changed.previousProductModelId = forgedReview.reviewedProductModelId;
          changed.previousProductModelHash = forgedReview.reviewedProductModelHash;
        }
        const receipt = identifiedSuccessorArtifact(changed, "applicationReceiptId", "applicationReceiptHash", "document-change-application");
        const file = path.join(appDir, receipt.applicationReceiptId + ".json");
        fs.writeFileSync(file, JSON.stringify(receipt));
        created.push(file);
        fs.unlinkSync(appFile);
        const before = successorTreeObservation(f.root);
        const diagnostic = await inspectOptionalOnboardingForEntry({ root: f.root });
        assert.equal(diagnostic.status, "integrity_attention");
        // A foreign record is unverifiable; a change from another predecessor
        // does not start from the base, so the Canon is unexplained (drift).
        assert.equal(diagnostic.reasonCode, kind === "foreign-project" ? "ONBOARDING_PRODUCT_SUCCESSOR_UNVERIFIABLE" : "ONBOARDING_PRODUCT_CANON_DRIFT");
        assert.deepEqual(successorTreeObservation(f.root), before);
      } finally {
        for (const file of created) fs.unlinkSync(file);
        fs.writeFileSync(appFile, originalApp);
      }
    });
});

test("a reviewed but unapplied successor is not completed lineage even with its exact Canon bytes", async (t) => {
  const f = await approvedDocumentSuccessorFixture(t, false, 1);
  const pending = await appendReviewedDocument(f.root, f.layout, "Reviewed but not applied", { apply: false });
  assert.equal(pending.result.status, "reviewed-awaiting-application");
  assert.equal((await inspectOptionalOnboardingForEntry({ root: f.root })).status, "ready_world_unchecked");
  // Synthetic partial publication: approval exists but completion receipt does
  // not. The reader must not complete this application or create a new review.
  fs.writeFileSync(path.join(f.root, f.canonPath), JSON.stringify(pending.model));
  const before = successorTreeObservation(f.root);
  assert.equal((await inspectOptionalOnboardingForEntry({ root: f.root })).reasonCode, "ONBOARDING_PRODUCT_CANON_DRIFT");
  assert.deepEqual(successorTreeObservation(f.root), before);
});

test("reviewed changes that cannot start from the supplied verified base are drift", async (t) => {
  const f = await approvedDocumentSuccessorFixture(t, false, 1);
  const baseState = JSON.parse(f.beforeState);
  const originalBase = JSON.parse(
    fs.readFileSync(path.join(f.root, f.layout.directory, "onboarding/product-model-revisions", baseState.productModelId + ".json")),
  );
  await appendReviewedDocument(f.root, f.layout, originalBase.document.capabilities[0].description);
  // Isolated traversal test: public approvals provide real A→B→A edges.
  // Supply a distinct synthetic typed base that none of them starts from,
  // rather than the public equal-Canon fast path. This is not an approval fixture.
  const unreachableDocument = structuredClone(originalBase.document);
  unreachableDocument.capabilities[0].description = "Unreachable synthetic typed base.";
  const model = normalizeProductModelDocument(unreachableDocument, f.storage);
  const baseRevision = { ...originalBase, document: unreachableDocument, productModelId: model.productModelId, productModelHash: model.productModelHash };
  const before = successorTreeObservation(f.root);
  await assert.rejects(
    readOnboardingProductSuccessor({
      root: f.root,
      storage: f.storage,
      projectId: inspectProject(f.root).project.projectId,
      state: { ...baseState, productModelId: model.productModelId },
      currentModel: readProductModelCanon({ projectRoot: f.root, storage: f.storage }).model,
      baseRevision,
    }),
    { code: "ONBOARDING_PRODUCT_CANON_DRIFT" },
  );
  assert.deepEqual(successorTreeObservation(f.root), before);
});

test("completed Canon receipt before projection audit remains distinct from ready projections", async (t) => {
  const f = await approvedDocumentSuccessorFixture(t, false, 1);
  const pending = await appendReviewedDocument(f.root, f.layout, "Second reviewed receipt before audit", { apply: false });
  const id = pending.result.reviewDecision.reviewDecisionId;
  const source = `import fs from 'node:fs';import path from 'node:path';import {syncBuiltinESMExports} from 'node:module';
    const root=${JSON.stringify(f.root)}, prefix=${JSON.stringify(f.layout.directory + "/document-changes/applications/")};
    const rename=fs.renameSync;fs.renameSync=function(from,to){const result=rename.apply(this,arguments);if(path.relative(root,String(to)).replaceAll('\\\\','/').startsWith(prefix))process.exit(44);return result;};syncBuiltinESMExports();
    const {applyDocumentChangeReview}=await import(${JSON.stringify(new URL("../scripts/lib/world/document-change-review.mjs", import.meta.url).href)});
    await applyDocumentChangeReview({root,reviewDecisionId:${JSON.stringify(id)}});`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], { cwd: pluginRoot, encoding: "utf8", timeout: 45000, windowsHide: true });
  t.diagnostic(JSON.stringify({ event: "document-receipt-interruption-child-closed", pid: child.pid, exitCode: child.status }));
  assert.equal(child.error, undefined);
  assert.equal(child.status, 44, child.stderr);
  const before = successorTreeObservation(f.root);
  const status = await inspectOnboarding({ root: f.root });
  assert.equal(status.productCanonLineage.hops.length, 2);
  assert.equal(status.status, "ready_world_changed");
  assert.equal(
    (await inspectDocumentChangeReviewStatus({ root: f.root, candidateSetId: pending.captured.candidateSet.candidateSetId })).projectionsReady,
    false,
  );
  assert.deepEqual(successorTreeObservation(f.root), before);
});

// Rule: the Canon on disk is the result of the latest reviewed change, and the
// reviewed changes on record lead, one after another, from the onboarding base.
test("a Canon restored by hand to an earlier reviewed result is drift", async (t) => {
  const f = await approvedDocumentSuccessorFixture(t, false, 2);
  const first = JSON.parse(
    fs.readFileSync(
      path.join(f.root, f.layout.directory, "document-changes/product-model-revisions", f.applications[0].status.resultingProductModelId + ".json"),
    ),
  );
  fs.writeFileSync(path.join(f.root, f.canonPath), JSON.stringify(first.document, null, 2) + "\n");
  assert.equal(readProductModelCanon({ projectRoot: f.root, storage: f.storage }).model.productModelId, f.applications[0].status.resultingProductModelId);
  const before = successorTreeObservation(f.root);
  await assert.rejects(() => inspectOnboarding({ root: f.root }), { code: "ONBOARDING_PRODUCT_CANON_DRIFT" });
  const entry = await inspectOptionalOnboardingForEntry({ root: f.root });
  assert.equal(entry.status, "integrity_attention");
  assert.equal(entry.reasonCode, "ONBOARDING_PRODUCT_CANON_DRIFT");
  assert.deepEqual(successorTreeObservation(f.root), before);
});

for (const [name, steps] of [
  ["A→B→C→B", ["Contract B", "Contract C", "Contract B"]],
  ["A→B→A→B", ["Contract B", null, "Contract B"]],
])
  test(`a reviewed revert ${name} stays ready and follows every application`, async (t) => {
    const f = await fixture();
    t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    await reviewOnboarding(f.request);
    const original = JSON.parse(fs.readFileSync(path.join(f.root, f.canonPath))).capabilities[0].description;
    for (const step of steps) assert.equal((await appendReviewedDocument(f.root, f.layout, step ?? original)).result.status, "applied");
    const status = await inspectOnboarding({ root: f.root });
    assert.ok(["ready", "ready_world_changed"].includes(status.status), status.status);
    const hops = status.productCanonLineage.hops;
    assert.equal(hops.length, 3);
    assert.equal(hops[0].previousProductModelId, status.productCanonLineage.base.productModelId);
    hops.slice(1).forEach((hop, index) => assert.equal(hop.previousProductModelHash, hops[index].resultingProductModelHash));
    assert.equal(hops.at(-1).resultingProductModelId, status.productModel.productModelId);
    assert.equal((await inspectOptionalOnboardingForEntry({ root: f.root })).status, "ready_world_unchecked");
  });

for (const order of ["policy only", "document then policy", "policy then document"])
  test(`a Product Policy approval is a reviewed successor too: ${order}`, async (t) => {
    const f = await fixture();
    t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    await reviewOnboarding(f.request);
    const policy = async () => {
      const proposed = await proposeProductPolicy({
        root: f.root,
        operation: "create",
        key: "exact-evidence",
        name: "Exact evidence",
        statement: "Use exact evidence.",
      });
      const reviewed = await reviewProductPolicy({
        root: f.root,
        candidateId: proposed.candidate.candidateId,
        disposition: "accept",
        rationale: "Synthetic acceptance.",
      });
      assert.equal(reviewed.canonChanged, true);
    };
    if (order === "document then policy") await appendReviewedDocument(f.root, f.layout, "Contract B");
    await policy();
    if (order === "policy then document") await appendReviewedDocument(f.root, f.layout, "Contract B");
    const status = await inspectOnboarding({ root: f.root });
    assert.ok(["ready", "ready_world_changed"].includes(status.status), status.status);
    const families = status.productCanonLineage.hops.map((hop) => hop.family);
    assert.deepEqual(
      families,
      order === "policy only"
        ? ["product-policy"]
        : order === "document then policy"
          ? ["document-change", "product-policy"]
          : ["product-policy", "document-change"],
    );
    assert.equal(status.productCanonLineage.current.revision.productModelHash, status.productModel.productModelHash);
    assert.equal((await inspectOptionalOnboardingForEntry({ root: f.root })).status, "ready_world_unchecked");
  });

const canonBytes = (f) => fs.readFileSync(path.join(f.root, f.canonPath));
async function expectDrift(f, message) {
  await assert.rejects(() => inspectOnboarding({ root: f.root }), { code: "ONBOARDING_PRODUCT_CANON_DRIFT" }, message);
  const entry = await inspectOptionalOnboardingForEntry({ root: f.root });
  assert.equal(entry.status, "integrity_attention", message);
  assert.equal(entry.reasonCode, "ONBOARDING_PRODUCT_CANON_DRIFT", message);
}

// The sequence starts at the onboarding base, so a reviewed history that
// returns to the base fixes its end at the base.
for (const [name, steps, restore] of [
  ["A→B→A, then B by hand", ["Contract B", null], 0],
  ["A→B→C→A, then B by hand", ["Contract B", "Contract C", null], 0],
  ["A→B→C→A, then C by hand", ["Contract B", "Contract C", null], 1],
])
  test(`a reviewed history back at the base, then an earlier result restored by hand, is drift: ${name}`, async (t) => {
    const f = await fixture();
    t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    await reviewOnboarding(f.request);
    const original = JSON.parse(canonBytes(f)).capabilities[0].description;
    const results = [];
    for (const step of steps) {
      await appendReviewedDocument(f.root, f.layout, step ?? original);
      results.push(canonBytes(f));
    }
    assert.equal((await inspectOnboarding({ root: f.root })).status, "ready", "the reviewed history itself is ready");
    fs.writeFileSync(path.join(f.root, f.canonPath), results[restore]);
    await expectDrift(f, name);
  });

test("Canon equal to the onboarding base is checked against the reviewed changes after the base", async (t) => {
  const f = await fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  await reviewOnboarding(f.request);
  const base = canonBytes(f);
  // Reviewed A→B→A stays ready.
  const original = JSON.parse(base).capabilities[0].description;
  await appendReviewedDocument(f.root, f.layout, "Contract B");
  await appendReviewedDocument(f.root, f.layout, original);
  assert.equal((await inspectOnboarding({ root: f.root })).status, "ready");
  // An accepted Product Policy change from the base whose Canon is not on disk
  // (here put back by hand, the same state as an unfinished Canon write).
  const proposed = await proposeProductPolicy({
    root: f.root,
    operation: "create",
    key: "exact-evidence",
    name: "Exact evidence",
    statement: "Use exact evidence.",
  });
  await reviewProductPolicy({ root: f.root, candidateId: proposed.candidate.candidateId, disposition: "accept", rationale: "Synthetic acceptance." });
  assert.notDeepEqual(canonBytes(f), base);
  fs.writeFileSync(path.join(f.root, f.canonPath), base);
  const before = successorTreeObservation(f.root);
  await expectDrift(f, "accepted change from the base not on disk");
  assert.deepEqual(successorTreeObservation(f.root), before);
});

test("a reviewed change after an accepted fresh onboarding proposal reads ready from the new base", async (t) => {
  const f = await approvedDocumentSuccessorFixture(t, true, 1);
  const world = (await inspectWorldModel({ root: f.root })).snapshot;
  const proposed = await proposeOnboardingSemanticRefresh({
    root: f.root,
    semanticProposal: {
      schemaVersion: 1,
      sourceSnapshotId: world.temporalProvenanceGraph.sourceSnapshotId,
      candidates: [
        {
          productKind: "Capability",
          proposedEntity: { key: "fresh-delivery", name: "Fresh delivery", description: "Fresh explicitly reviewed proposal." },
          evidence: [{ path: "README.md", line: 1 }],
          explanation: "Synthetic current source evidence.",
          confidence: 0.9,
        },
      ],
    },
  });
  await reviewOnboarding({
    root: f.root,
    candidateSetId: proposed.candidateSet.candidateSetId,
    disposition: "accept-all",
    rationale: "Adopt the fresh proposal.",
  });
  const rebased = await inspectOnboarding({ root: f.root });
  assert.equal(rebased.status, "ready");
  const newBase = rebased.state.productModelId;
  assert.equal(rebased.productModel.productModelId, newBase);
  assert.equal((await appendReviewedDocument(f.root, f.layout, "Contract after the new base")).result.status, "applied");
  const status = await inspectOnboarding({ root: f.root });
  assert.ok(["ready", "ready_world_changed"].includes(status.status), status.status);
  // The change before the new base precedes it; only the change after it is a step.
  assert.equal(status.productCanonLineage.hops.length, 1);
  assert.equal(status.productCanonLineage.hops[0].previousProductModelId, newBase);
  assert.equal((await inspectOptionalOnboardingForEntry({ root: f.root })).status, "ready_world_unchecked");
});

// World snapshots are local and untracked (a fresh clone has none). Without the
// World recorded with the onboarding state it is unknown which records precede
// the base, so Canon equal to the base keeps its previous answer. Each read runs
// in a fresh process so no per-process cache stands in for the missing World.
test("Canon equal to a moved base reads ready when the recorded World is not on disk", async (t) => {
  const f = await approvedDocumentSuccessorFixture(t, true, 1);
  const world = (await inspectWorldModel({ root: f.root })).snapshot;
  const proposed = await proposeOnboardingSemanticRefresh({
    root: f.root,
    semanticProposal: {
      schemaVersion: 1,
      sourceSnapshotId: world.temporalProvenanceGraph.sourceSnapshotId,
      candidates: [
        {
          productKind: "Capability",
          proposedEntity: { key: "fresh-delivery", name: "Fresh delivery", description: "Fresh explicitly reviewed proposal." },
          evidence: [{ path: "README.md", line: 1 }],
          explanation: "Synthetic current source evidence.",
          confidence: 0.9,
        },
      ],
    },
  });
  await reviewOnboarding({
    root: f.root,
    candidateSetId: proposed.candidateSet.candidateSetId,
    disposition: "accept-all",
    rationale: "Adopt the fresh proposal.",
  });
  const state = JSON.parse(fs.readFileSync(path.join(f.root, f.statePath)));
  const read = () => {
    const source = `const { inspectOnboarding, inspectOptionalOnboardingForEntry } = await import(${JSON.stringify(
      new URL("../scripts/lib/session/onboarding.mjs", import.meta.url).href,
    )});
      const root = ${JSON.stringify(f.root)};
      let strict;
      try { strict = (await inspectOnboarding({ root })).status; } catch (error) { strict = error.code; }
      const entry = await inspectOptionalOnboardingForEntry({ root });
      console.log(JSON.stringify({ strict, entry: entry.status, reasonCode: entry.reasonCode ?? null }));`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], { cwd: pluginRoot, encoding: "utf8", timeout: 60000, windowsHide: true });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout.trim().split("\n").at(-1));
  };
  // With the World present: Canon is the new base and the earlier change precedes it.
  const present = read();
  assert.equal(present.strict, "ready");
  assert.equal(present.reasonCode, null);
  // Without it (as in a fresh clone): the previous answer, not drift.
  const file = worldSnapshotFile(f.root, state.worldModelId),
    original = fs.readFileSync(file);
  fs.unlinkSync(file);
  try {
    const missing = read();
    assert.notEqual(missing.strict, "ONBOARDING_PRODUCT_CANON_DRIFT");
    assert.ok(["ready", "ready_world_changed"].includes(missing.strict), missing.strict);
    assert.equal(missing.entry, "ready_world_unchecked");
  } finally {
    fs.writeFileSync(file, original);
  }
  // With the World back the check runs again and reads ready.
  assert.equal(read().strict, "ready");
});

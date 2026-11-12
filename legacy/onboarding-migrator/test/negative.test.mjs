import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { buildWorldModel } from "../../../scripts/lib/world/world-model.mjs";
import {
  loadOnboardingGraphProjection,
  verifyOnboardingGraphProjectionInput,
  verifyProductModelRevisionForProjection,
} from "../../../scripts/lib/session/onboarding-projection.mjs";
import { verifyTemporalProvenanceGraph } from "../../../scripts/lib/world/temporal-provenance.mjs";
import { createRecoveryCheckpoint, inspectRecoveryCheckpointBasis, readRecoveryCheckpoint } from "../../../scripts/lib/session/compaction-recovery.mjs";
import { createVerifiedHistoricalInventoryCapability, applyHistoricalArtifactBoundary } from "../../../scripts/lib/world/historical-artifact-boundary.mjs";
import {
  historicalBoundaryStorageFiles,
  historicalBoundaryDigest,
  verifyHistoricalInventoryEntries,
} from "../../../scripts/lib/world/historical-artifact-boundary-store.mjs";
import { onboardingCanonicalJson, onboardingDigest } from "../../../scripts/lib/session/onboarding-contract.mjs";
import { inspectLegacyOnboarding } from "../src/legacy-validator.mjs";
import { applyMigration } from "../src/migrator.mjs";
import { legacyReadyFixture, pluginRoot, snapshotFiles } from "./fixture.mjs";

const boundaryFiles = (root) => snapshotFiles(root, (name) => name.startsWith(".head/onboarding/historical-boundaries/"));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
function identify(document, idField, hashField, prefix) {
  const payload = structuredClone(document);
  delete payload[idField];
  delete payload[hashField];
  const hash = onboardingDigest(onboardingCanonicalJson(payload));
  return { ...payload, [idField]: `${prefix}-${hash.slice(0, 24)}`, [hashField]: hash };
}
function rewriteState(root, mutate) {
  const file = path.join(root, ".head", "onboarding", "current.json");
  const payload = readJson(file);
  delete payload.pointerHash;
  mutate(payload);
  writeJson(file, { ...payload, pointerHash: onboardingDigest(onboardingCanonicalJson(payload)) });
}
function identifyGraph(graph) {
  const payload = structuredClone(graph);
  delete payload.graphSnapshotId;
  delete payload.graphSnapshotHash;
  const hash = onboardingDigest(onboardingCanonicalJson(payload));
  return { ...payload, graphSnapshotId: `graph-snapshot-${hash.slice(0, 24)}`, graphSnapshotHash: hash };
}
async function expectNoBoundaryWrite(t, mutate, expectedCode) {
  const fixture = await legacyReadyFixture({ version: "0.3.0" });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  await mutate(fixture);
  const before = snapshotFiles(fixture.root);
  assert.throws(
    () => applyMigration({ root: fixture.root }),
    (error) => expectedCode == null || error.code === expectedCode,
  );
  assert.deepEqual(snapshotFiles(fixture.root), before);
  assert.deepEqual(boundaryFiles(fixture.root), {});
}

test("first slice rejects unsupported, incomplete, and current-unreadable bases with zero writes", async (t) => {
  await expectNoBoundaryWrite(
    t,
    async ({ root }) =>
      rewriteState(root, (state) => {
        state.protocol.version = "0.1.0";
      }),
    "LEGACY_MIGRATOR_UNSUPPORTED_STATE",
  );
  await expectNoBoundaryWrite(
    t,
    async ({ root }) =>
      rewriteState(root, (state) => {
        state.phase = "awaiting-review";
      }),
    "LEGACY_MIGRATOR_INCOMPLETE_READY",
  );
  await expectNoBoundaryWrite(
    t,
    async ({ root, candidate }) => fs.rmSync(path.join(root, ".head", "onboarding", "candidate-sets", `${candidate.candidateSetId}.json`)),
    "LEGACY_MIGRATOR_UNSUPPORTED_CHAIN",
  );
  await expectNoBoundaryWrite(
    t,
    async ({ root, review }) => fs.rmSync(path.join(root, ".head", "onboarding", "review-decisions", `${review.reviewDecisionId}.json`)),
    "LEGACY_MIGRATOR_UNSUPPORTED_CHAIN",
  );
  await expectNoBoundaryWrite(
    t,
    async ({ root, review }) => fs.rmSync(path.join(root, ".head", "onboarding", "product-model-revisions", `${review.resultingProductModelId}.json`)),
    "LEGACY_MIGRATOR_ARTIFACT_MISSING",
  );
  await expectNoBoundaryWrite(
    t,
    async ({ root }) => fs.rmSync(path.join(root, ".head", "context", "product-model.json")),
    "LEGACY_MIGRATOR_CURRENT_CANON_UNSUPPORTED",
  );
  await expectNoBoundaryWrite(t, async ({ root }) => fs.rmSync(path.join(root, ".head", "sessions", "current.json")), null);
});

test("legacy family binding violations fail without publishing a boundary", async (t) => {
  for (const version of ["0.1.0", "0.2.0", "0.3.0"]) {
    const fixture = await legacyReadyFixture({ version });
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    const file = path.join(fixture.root, ".head", "onboarding", "candidate-sets", `${fixture.candidate.candidateSetId}.json`);
    const candidate = readJson(file);
    candidate.candidates[0] = identify(
      { ...candidate.candidates[0], producerVersion: version === "0.1.0" ? "0.2.0" : "0.1.0" },
      "candidateId",
      "candidateHash",
      "onboarding-candidate",
    );
    const rewritten = identify(candidate, "candidateSetId", "candidateSetHash", "onboarding-candidates");
    fs.rmSync(file);
    writeJson(path.join(path.dirname(file), `${rewritten.candidateSetId}.json`), rewritten);
    const before = snapshotFiles(fixture.root);
    assert.throws(() => applyMigration({ root: fixture.root }), { code: "LEGACY_MIGRATOR_CANDIDATE_INVALID" });
    assert.deepEqual(snapshotFiles(fixture.root), before);
    assert.deepEqual(boundaryFiles(fixture.root), {});
  }
});

test("ready review pointer and closed parent ancestry are exact preconditions", async (t) => {
  await expectNoBoundaryWrite(
    t,
    async ({ root }) =>
      rewriteState(root, (state) => {
        state.latestReviewDecisionId = `onboarding-review-decision-${"f".repeat(24)}`;
      }),
    "LEGACY_MIGRATOR_INCOMPLETE_READY",
  );

  const fixture = await legacyReadyFixture({ version: "0.3.0" });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const candidateFile = path.join(fixture.root, ".head", "onboarding", "candidate-sets", `${fixture.candidate.candidateSetId}.json`);
  const candidatePayload = readJson(candidateFile);
  delete candidatePayload.candidateSetId;
  delete candidatePayload.candidateSetHash;
  candidatePayload.parentCandidateSetIds = [`onboarding-candidates-${"e".repeat(24)}`];
  const candidate = identify(candidatePayload, "candidateSetId", "candidateSetHash", "onboarding-candidates");
  const reviewFile = path.join(fixture.root, ".head", "onboarding", "review-decisions", `${fixture.review.reviewDecisionId}.json`);
  const reviewPayload = readJson(reviewFile);
  delete reviewPayload.reviewDecisionId;
  delete reviewPayload.reviewDecisionHash;
  reviewPayload.candidateSetId = candidate.candidateSetId;
  reviewPayload.lineage = reviewPayload.lineage.map((lineage) =>
    lineage.relation === "reviews-candidate-set" ? { ...lineage, targetId: candidate.candidateSetId } : lineage,
  );
  const review = identify(reviewPayload, "reviewDecisionId", "reviewDecisionHash", "onboarding-review-decision");
  fs.rmSync(candidateFile);
  fs.rmSync(reviewFile);
  writeJson(path.join(path.dirname(candidateFile), `${candidate.candidateSetId}.json`), candidate);
  writeJson(path.join(path.dirname(reviewFile), `${review.reviewDecisionId}.json`), review);
  rewriteState(fixture.root, (state) => {
    state.candidateSetId = candidate.candidateSetId;
    state.latestReviewDecisionId = review.reviewDecisionId;
  });
  const before = snapshotFiles(fixture.root);
  assert.throws(() => applyMigration({ root: fixture.root }), { code: "LEGACY_MIGRATOR_DANGLING_PARENT" });
  assert.deepEqual(snapshotFiles(fixture.root), before);
  assert.deepEqual(boundaryFiles(fixture.root), {});
});

test("first apply rejects a capability whose exact preflight basis drifted", async (t) => {
  const fixture = await legacyReadyFixture({ version: "0.3.0" });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const inspected = inspectLegacyOnboarding({ root: fixture.root });
  rewriteState(fixture.root, (state) => {
    state.updatedAt = "2099-01-01T00:00:00.000Z";
  });
  const before = snapshotFiles(fixture.root);
  assert.throws(() => applyHistoricalArtifactBoundary({ root: fixture.root, verifiedInventory: inspected.capability, hostMode: "explicit-one-shot" }), {
    code: "HISTORICAL_BOUNDARY_PREFLIGHT_BASIS_DRIFT",
  });
  assert.deepEqual(snapshotFiles(fixture.root), before);
  assert.deepEqual(boundaryFiles(fixture.root), {});
});

test("first apply requires current-readable checkpoint and Run P2 while accepting a verified checkpoint", async (t) => {
  const brokenRun = await legacyReadyFixture({ version: "0.3.0" });
  t.after(() => fs.rmSync(brokenRun.root, { recursive: true, force: true }));
  const runId = "run-1234567890123-abcdef";
  writeJson(path.join(brokenRun.root, ".head", "sessions", "runs", runId, "run.json"), { runId });
  const brokenStateFile = path.join(brokenRun.root, ".head", "sessions", "current.json");
  writeJson(brokenStateFile, { ...readJson(brokenStateFile), activeRunId: runId });
  assert.throws(() => inspectRecoveryCheckpointBasis({ root: brokenRun.root }), { code: "INVALID_RUN_CANON" });
  const beforeBrokenRun = snapshotFiles(brokenRun.root);
  assert.throws(() => applyMigration({ root: brokenRun.root }), { code: "INVALID_RUN_CANON" });
  assert.deepEqual(snapshotFiles(brokenRun.root), beforeBrokenRun);
  assert.deepEqual(boundaryFiles(brokenRun.root), {});

  const crossProject = await legacyReadyFixture({ version: "0.3.0" });
  t.after(() => fs.rmSync(crossProject.root, { recursive: true, force: true }));
  const original = createRecoveryCheckpoint({
    root: crossProject.root,
    purpose: "Fixture-only validation",
    approvedDecisions: [],
    currentPosition: "Before migration",
    nextExpectedResult: "Validate current P2",
  });
  const payload = { ...original.checkpoint, projectId: `head-${"f".repeat(20)}` };
  delete payload.checkpointId;
  delete payload.checkpointDigest;
  const checkpointDigest = onboardingDigest(onboardingCanonicalJson(payload));
  const checkpoint = { ...payload, checkpointId: `checkpoint-${checkpointDigest.slice(0, 24)}`, checkpointDigest };
  const checkpointFile = path.join(path.dirname(original.file), `${checkpoint.checkpointId}.json`);
  writeJson(checkpointFile, checkpoint);
  const crossStateFile = path.join(crossProject.root, ".head", "sessions", "current.json");
  writeJson(crossStateFile, { ...readJson(crossStateFile), latestCheckpoint: checkpoint.checkpointId });
  assert.throws(() => readRecoveryCheckpoint({ root: crossProject.root, checkpointId: checkpoint.checkpointId }), { code: "INVALID_RECOVERY_CHECKPOINT" });
  const beforeCrossProject = snapshotFiles(crossProject.root);
  assert.throws(() => applyMigration({ root: crossProject.root }), { code: "INVALID_RECOVERY_CHECKPOINT" });
  assert.deepEqual(snapshotFiles(crossProject.root), beforeCrossProject);
  assert.deepEqual(boundaryFiles(crossProject.root), {});

  const verified = await legacyReadyFixture({ version: "0.3.0" });
  t.after(() => fs.rmSync(verified.root, { recursive: true, force: true }));
  const validCheckpoint = createRecoveryCheckpoint({
    root: verified.root,
    purpose: "Fixture-only validation",
    approvedDecisions: [],
    currentPosition: "Before migration",
    nextExpectedResult: "Preserve current P2",
  });
  assert.equal(readRecoveryCheckpoint({ root: verified.root, checkpointId: validCheckpoint.checkpoint.checkpointId }).status, "verified");
  assert.equal(applyMigration({ root: verified.root }).status, "applied");
});

test("legacy semantic validation and inventory identity use one bounded byte generation", async (t) => {
  const fixture = await legacyReadyFixture({ version: "0.3.0" });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const candidateFile = path.join(fixture.root, ".head", "onboarding", "candidate-sets", `${fixture.candidate.candidateSetId}.json`);
  const originalRead = fs.readFileSync;
  let injected = false;
  fs.readFileSync = function instrumentedRead(input, options) {
    if (!injected && typeof input === "string" && path.resolve(input) === path.resolve(candidateFile) && options === undefined) {
      injected = true;
      const changed = JSON.parse(originalRead.call(fs, candidateFile, "utf8"));
      changed.promotionAuthority = true;
      writeJson(candidateFile, changed);
    }
    return originalRead.call(fs, input, options);
  };
  try {
    assert.throws(() => applyMigration({ root: fixture.root }), { code: "LEGACY_MIGRATOR_DIGEST_MISMATCH" });
  } finally {
    fs.readFileSync = originalRead;
  }
  assert.equal(injected, true);
  assert.deepEqual(boundaryFiles(fixture.root), {});
});

test("candidate and review filenames must equal their document identities", async (t) => {
  for (const role of ["candidate", "review"]) {
    const fixture = await legacyReadyFixture({ version: "0.3.0" });
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    const document = role === "candidate" ? fixture.candidate : fixture.review;
    const directory = path.join(fixture.root, ".head", "onboarding", role === "candidate" ? "candidate-sets" : "review-decisions");
    const id = role === "candidate" ? document.candidateSetId : document.reviewDecisionId;
    const renamed = role === "candidate" ? `onboarding-candidates-${"f".repeat(24)}.json` : `onboarding-review-decision-${"f".repeat(24)}.json`;
    fs.renameSync(path.join(directory, `${id}.json`), path.join(directory, renamed));
    const before = snapshotFiles(fixture.root);
    assert.throws(() => applyMigration({ root: fixture.root }), { code: "LEGACY_MIGRATOR_ARTIFACT_ID_PATH_MISMATCH" });
    assert.deepEqual(snapshotFiles(fixture.root), before);
    assert.deepEqual(boundaryFiles(fixture.root), {});
  }

  const canonical = await legacyReadyFixture({ version: "0.3.0" });
  t.after(() => fs.rmSync(canonical.root, { recursive: true, force: true }));
  const inspected = inspectLegacyOnboarding({ root: canonical.root });
  const candidateEntry = inspected.entries.find((entry) => entry.role === "historical-candidate-set");
  assert.throws(
    () =>
      verifyHistoricalInventoryEntries([{ ...candidateEntry, path: `.head/onboarding/candidate-sets/onboarding-candidates-${"f".repeat(24)}.json` }], {
        projectRoot: canonical.root,
        verifyBytes: false,
      }),
    { code: "HISTORICAL_BOUNDARY_ROLE_PATH_MISMATCH" },
  );
});

test("current Core independently derives every historical Product revision interpretation", async (t) => {
  const opaque = await legacyReadyFixture({ version: "0.3.0", opaquePreviousRevision: true });
  t.after(() => fs.rmSync(opaque.root, { recursive: true, force: true }));
  const opaquePreflight = inspectLegacyOnboarding({ root: opaque.root });
  const opaqueEntry = opaquePreflight.entries.find((entry) => entry.interpretationMode === "opaque-legacy-revision");
  assert.ok(opaqueEntry);
  assert.throws(() => verifyProductModelRevisionForProjection(readJson(path.join(opaque.root, opaqueEntry.path))), {
    code: "INVALID_ONBOARDING_PRODUCT_REVISION",
  });
  const falselyTyped = opaquePreflight.entries.map((entry) =>
    entry.path === opaqueEntry.path ? { ...entry, interpretationMode: "current-typed-with-historical-provenance" } : entry,
  );
  const beforeOpaque = snapshotFiles(opaque.root);
  assert.throws(
    () =>
      createVerifiedHistoricalInventoryCapability({
        root: opaque.root,
        projectId: opaquePreflight.projectId,
        entries: falselyTyped,
        validation: opaquePreflight.validation,
      }),
    { code: "HISTORICAL_BOUNDARY_REVISION_INTERPRETATION_MISMATCH" },
  );
  assert.deepEqual(snapshotFiles(opaque.root), beforeOpaque);
  assert.deepEqual(boundaryFiles(opaque.root), {});

  const typed = await legacyReadyFixture({ version: "0.3.0" });
  t.after(() => fs.rmSync(typed.root, { recursive: true, force: true }));
  const typedPreflight = inspectLegacyOnboarding({ root: typed.root });
  const typedEntry = typedPreflight.entries.find((entry) => entry.interpretationMode === "current-typed-with-historical-provenance");
  assert.ok(typedEntry);
  const falselyOpaque = typedPreflight.entries.map((entry) =>
    entry.path === typedEntry.path ? { ...entry, interpretationMode: "opaque-legacy-revision" } : entry,
  );
  const beforeTyped = snapshotFiles(typed.root);
  assert.throws(
    () =>
      createVerifiedHistoricalInventoryCapability({
        root: typed.root,
        projectId: typedPreflight.projectId,
        entries: falselyOpaque,
        validation: typedPreflight.validation,
      }),
    { code: "HISTORICAL_BOUNDARY_REVISION_INTERPRETATION_MISMATCH" },
  );
  assert.deepEqual(snapshotFiles(typed.root), beforeTyped);
  assert.deepEqual(boundaryFiles(typed.root), {});
});

test("historical projection and temporal coverage reject surplus and orphan references", async (t) => {
  const fixture = await legacyReadyFixture({ version: "0.3.0" });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const applied = applyMigration({ root: fixture.root });
  const projection = loadOnboardingGraphProjection({
    projectRoot: fixture.root,
    projectId: applied.boundary.projectId,
    currentProductModelId: applied.boundary.appliedAtBasis.canon.id,
  });
  const forgedProjectionPayload = structuredClone(projection);
  delete forgedProjectionPayload.projectionInputId;
  delete forgedProjectionPayload.projectionInputHash;
  forgedProjectionPayload.historicalCoverage.references.push({
    path: "unrecognized/example.json",
    role: "unrecognized-role",
    artifactId: `product-model-${"d".repeat(24)}`,
    sha256: "d".repeat(64),
    interpretationMode: "unrecognized-mode",
  });
  const forgedProjection = identify(forgedProjectionPayload, "projectionInputId", "projectionInputHash", "onboarding-graph-input");
  assert.throws(() => verifyOnboardingGraphProjectionInput(forgedProjection), { code: "INVALID_ONBOARDING_HISTORICAL_COVERAGE" });

  const built = await buildWorldModel({ root: fixture.root, persist: true });
  const graphPayload = structuredClone(built.snapshot.temporalProvenanceGraph);
  graphPayload.onboardingProjection.historicalCoverage.typedRevisionIds.push(`product-model-${"d".repeat(24)}`);
  graphPayload.onboardingProjection.historicalCoverage.typedRevisionIds.sort();
  const forgedGraph = identifyGraph(graphPayload);
  assert.throws(() => verifyTemporalProvenanceGraph(forgedGraph), { code: "ONBOARDING_TEMPORAL_SET_MISMATCH" });
});

test("current-unreadable live historical result cannot gain P1 through the boundary", async (t) => {
  await expectNoBoundaryWrite(
    t,
    async ({ root, review }) => {
      const file = path.join(root, ".head", "onboarding", "product-model-revisions", `${review.resultingProductModelId}.json`);
      const revision = readJson(file);
      delete revision.authority;
      writeJson(file, revision);
    },
    "LEGACY_MIGRATOR_CURRENT_CANON_UNSUPPORTED",
  );
});

test("exact partial retry completes, while partial basis drift refuses finalization", async (t) => {
  const exact = await legacyReadyFixture({ version: "0.3.0" });
  t.after(() => fs.rmSync(exact.root, { recursive: true, force: true }));
  const inspected = inspectLegacyOnboarding({ root: exact.root });
  const applied = applyHistoricalArtifactBoundary({ root: exact.root, verifiedInventory: inspected.capability, hostMode: "explicit-one-shot" });
  const files = historicalBoundaryStorageFiles(exact.root, applied.boundary.boundaryId);
  fs.rmSync(files.receipt);
  fs.rmSync(files.commit);
  const completed = applyHistoricalArtifactBoundary({ root: exact.root, verifiedInventory: inspected.capability, hostMode: "explicit-one-shot" });
  assert.equal(completed.status, "applied");
  assert.equal(completed.writes, 2);

  const drift = await legacyReadyFixture({ version: "0.3.0" });
  t.after(() => fs.rmSync(drift.root, { recursive: true, force: true }));
  const driftInspected = inspectLegacyOnboarding({ root: drift.root });
  const driftApplied = applyHistoricalArtifactBoundary({ root: drift.root, verifiedInventory: driftInspected.capability, hostMode: "explicit-one-shot" });
  const driftFiles = historicalBoundaryStorageFiles(drift.root, driftApplied.boundary.boundaryId);
  fs.rmSync(driftFiles.receipt);
  fs.rmSync(driftFiles.commit);
  rewriteState(drift.root, (state) => {
    state.worldModelId = null;
  });
  const before = snapshotFiles(drift.root);
  assert.throws(() => applyHistoricalArtifactBoundary({ root: drift.root, verifiedInventory: driftInspected.capability, hostMode: "explicit-one-shot" }), {
    code: "INCOMPLETE_HISTORICAL_BOUNDARY_BASIS_DRIFT",
  });
  assert.deepEqual(snapshotFiles(drift.root), before);
});

test("committed replay rejects a divergent inventory and cross-project or wrong-host application", async (t) => {
  const fixture = await legacyReadyFixture({ version: "0.3.0" });
  const other = await legacyReadyFixture({ version: "0.3.0" });
  t.after(() => {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(other.root, { recursive: true, force: true });
  });
  const inspected = inspectLegacyOnboarding({ root: fixture.root });
  assert.throws(() => applyHistoricalArtifactBoundary({ root: fixture.root, verifiedInventory: inspected.capability, hostMode: "automatic" }), {
    code: "HISTORICAL_BOUNDARY_HOST_MODE_REQUIRED",
  });
  assert.throws(() => applyHistoricalArtifactBoundary({ root: other.root, verifiedInventory: inspected.capability, hostMode: "explicit-one-shot" }), {
    code: "HISTORICAL_BOUNDARY_PROJECT_MISMATCH",
  });
  applyHistoricalArtifactBoundary({ root: fixture.root, verifiedInventory: inspected.capability, hostMode: "explicit-one-shot" });
  const worldModelId = fixture.accepted.state.worldModelId;
  const worldPath = `.head/world-model/snapshots/${worldModelId}.json`;
  const worldFile = path.join(fixture.root, ...worldPath.split("/"));
  const world = readJson(worldFile);
  const worldBytes = fs.readFileSync(worldFile);
  const extraEntries = [
    ...inspected.entries,
    {
      path: worldPath,
      role: "legacy-world-embedding-reference",
      artifactId: worldModelId,
      protocolFamily: world.protocol?.name || world.kind,
      protocolVersion: world.protocol?.version || String(world.schemaVersion),
      byteLength: worldBytes.byteLength,
      sha256: historicalBoundaryDigest(worldBytes),
      interpretationMode: "opaque-historical",
    },
  ].sort((left, right) => left.path.localeCompare(right.path, "en"));
  const divergent = createVerifiedHistoricalInventoryCapability({
    root: fixture.root,
    projectId: inspected.projectId,
    entries: extraEntries,
    validation: inspected.validation,
  });
  assert.throws(() => applyHistoricalArtifactBoundary({ root: fixture.root, verifiedInventory: divergent, hostMode: "explicit-one-shot" }), {
    code: "HISTORICAL_BOUNDARY_DIVERGENT_REPLAY",
  });
});

test("inventory bounds reject path escape, oversize, excessive count, and symlink entries", async (t) => {
  const fixture = await legacyReadyFixture({ version: "0.3.0" });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const base = inspectLegacyOnboarding({ root: fixture.root }).entries[0];
  assert.throws(() => verifyHistoricalInventoryEntries([{ ...base, path: "../outside.json" }], { projectRoot: fixture.root }), {
    code: "HISTORICAL_BOUNDARY_PATH_ESCAPE",
  });
  assert.throws(() => verifyHistoricalInventoryEntries([{ ...base, byteLength: 8 * 1024 * 1024 + 1 }], { projectRoot: fixture.root, verifyBytes: false }), {
    code: "HISTORICAL_BOUNDARY_LIMIT",
  });
  assert.throws(
    () =>
      verifyHistoricalInventoryEntries(
        Array.from({ length: 513 }, (_, index) => ({ ...base, path: `fixture/${index}.json` })),
        { projectRoot: fixture.root, verifyBytes: false },
      ),
    { code: "HISTORICAL_BOUNDARY_LIMIT" },
  );
  const target = path.join(fixture.root, "README.md");
  const link = path.join(fixture.root, "legacy-link.json");
  try {
    fs.symlinkSync(target, link, "file");
  } catch (error) {
    if (!["EPERM", "EACCES"].includes(error.code)) throw error;
    const junction = path.join(fixture.root, "legacy-junction");
    try {
      fs.symlinkSync(path.join(fixture.root, ".head", "onboarding"), junction, "junction");
      const stateBytes = fs.readFileSync(path.join(junction, "current.json"));
      assert.throws(
        () =>
          verifyHistoricalInventoryEntries(
            [
              {
                ...base,
                path: "legacy-junction/current.json",
                byteLength: stateBytes.byteLength,
                sha256: crypto.createHash("sha256").update(stateBytes).digest("hex"),
              },
            ],
            { projectRoot: fixture.root },
          ),
        { code: "HISTORICAL_BOUNDARY_SYMLINK" },
      );
      return;
    } catch (junctionError) {
      if (["EPERM", "EACCES"].includes(junctionError.code)) return t.skip(`Symlink and junction creation unavailable: ${error.code}/${junctionError.code}`);
      throw junctionError;
    }
  }
  const bytes = fs.readFileSync(target);
  assert.throws(
    () =>
      verifyHistoricalInventoryEntries(
        [{ ...base, path: "legacy-link.json", byteLength: bytes.byteLength, sha256: crypto.createHash("sha256").update(bytes).digest("hex") }],
        { projectRoot: fixture.root },
      ),
    { code: "HISTORICAL_BOUNDARY_SYMLINK" },
  );
});

test("committed original, marker, missing-file, and extra-legacy drift fail closed", async (t) => {
  for (const mode of ["original", "marker", "missing", "extra"]) {
    const fixture = await legacyReadyFixture({ version: "0.3.0" });
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    const applied = applyMigration({ root: fixture.root });
    if (mode === "original") fs.appendFileSync(path.join(fixture.root, applied.boundary.entries[0].path), " ");
    if (mode === "missing") fs.rmSync(path.join(fixture.root, applied.boundary.entries[0].path));
    if (mode === "marker") {
      const files = historicalBoundaryStorageFiles(fixture.root, applied.boundary.boundaryId);
      const marker = readJson(files.commit);
      marker.inventoryHash = "0".repeat(64);
      writeJson(files.commit, marker);
    }
    if (mode === "extra") {
      const source = fixture.candidate;
      const extra = identify(
        { ...source, inputMode: source.inputMode === "new" ? "existing" : "new" },
        "candidateSetId",
        "candidateSetHash",
        "onboarding-candidates",
      );
      writeJson(path.join(fixture.root, ".head", "onboarding", "candidate-sets", `${extra.candidateSetId}.json`), extra);
    }
    await assert.rejects(() => buildWorldModel({ root: fixture.root, persist: false }));
  }
});

test("two standalone apply processes serialize and converge on one committed boundary", async (t) => {
  const fixture = await legacyReadyFixture({ version: "0.3.0" });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const cli = path.join(pluginRoot, "legacy", "onboarding-migrator", "bin", "head-onboarding-migrate.mjs");
  const launch = () =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, "apply", fixture.root], { cwd: pluginRoot, windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ pid: child.pid, code, stdout, stderr }));
    });
  const results = await Promise.all([launch(), launch()]);
  assert.equal(
    results.every((result) => result.code === 0),
    true,
    JSON.stringify(results),
  );
  const statuses = results.map((result) => JSON.parse(result.stdout).status).sort();
  assert.deepEqual(statuses, ["already-applied", "applied"]);
  assert.equal(Object.keys(boundaryFiles(fixture.root)).length, 3);
  t.diagnostic(`child processes exited: ${results.map((result) => result.pid).join(", ")}; cwd=${pluginRoot}; ports=none`);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { inspectMigration, applyMigration } from "../src/migrator.mjs";
import { inspectOnboarding, proposeOnboardingSemanticRefresh, reviewOnboarding } from "../../../scripts/lib/session/onboarding.mjs";
import { buildWorldModel, inspectWorldModel } from "../../../scripts/lib/world/world-model.mjs";
import { stageDistributionRelease } from "../../../scripts/lib/distribution/distribution-lifecycle.mjs";
import { applyHistoricalArtifactBoundary } from "../../../scripts/lib/world/historical-artifact-boundary.mjs";
import { runCommand } from "../../../scripts/head.mjs";
import { legacyReadyFixture, legacyRevisedReadyFixture, pluginRoot, snapshotFiles } from "./fixture.mjs";

const protectedPath = (name) =>
  name === ".head/project.json" ||
  name.startsWith(".head/sessions/") ||
  name.startsWith(".head/world-model/") ||
  name === ".head/context/product-model.json" ||
  name === ".head/onboarding/current.json" ||
  name.startsWith(".head/onboarding/candidate-sets/") ||
  name.startsWith(".head/onboarding/review-decisions/") ||
  name.startsWith(".head/onboarding/product-model-revisions/");

function subset(value, predicate) {
  return Object.fromEntries(Object.entries(value).filter(([name]) => predicate(name)));
}

function proposal(root, suffix) {
  const world = inspectWorldModel({ root }).snapshot;
  const file = world.files.find((item) => item.path === "src/delivery.mjs");
  return {
    schemaVersion: 1,
    sourceSnapshotId: world.temporalProvenanceGraph.sourceSnapshotId,
    candidates: [
      {
        productKind: "Capability",
        proposedEntity: { key: `delivery-${suffix.toLowerCase()}`, name: `Delivery ${suffix}`, description: `Current ${suffix} delivery.` },
        evidence: [{ path: file.path, line: 1, contentDigest: file.digest, symbol: null }],
        explanation: `Fresh current ${suffix} meaning.`,
        confidence: 0.9,
      },
    ],
  };
}

for (const version of ["0.1.0", "0.2.0", "0.3.0"])
  test(`standalone migrator applies complete ${version} ready history without authority mutation`, async (t) => {
    const { root } = await legacyReadyFixture({ version, opaquePreviousRevision: true });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const before = snapshotFiles(root);
    const inspected = inspectMigration({ root });
    assert.equal(inspected.candidateProtocolVersion, version);
    assert.equal(
      inspected.entries.some((entry) => entry.interpretationMode === "opaque-legacy-revision"),
      true,
    );
    assert.deepEqual(snapshotFiles(root), before, "inspect is read-only");
    const applied = applyMigration({ root });
    assert.equal(applied.status, "applied");
    assert.equal(applied.boundary.instructionAuthority, false);
    assert.equal(applied.boundary.promotionAuthority, false);
    assert.deepEqual(subset(snapshotFiles(root), protectedPath), subset(before, protectedPath), "P1/P2 and historical bytes are unchanged");
    const retryBefore = snapshotFiles(root);
    const retry = applyMigration({ root });
    assert.equal(retry.status, "already-applied");
    assert.equal(retry.writes, 0);
    assert.deepEqual(snapshotFiles(root), retryBefore);
    const status = inspectOnboarding({ root });
    assert.equal(status.status, "ready_world_changed");
    assert.equal(status.historical.boundaryIntegrity, "verified");
  });

test("standalone migrator accepts a closed legacy revise-to-successor-to-accept chain", async (t) => {
  const fixture = await legacyRevisedReadyFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const before = snapshotFiles(fixture.root);
  const inspected = inspectMigration({ root: fixture.root });
  assert.equal(inspected.entries.filter((entry) => entry.role === "historical-candidate-set").length, 2);
  assert.equal(inspected.entries.filter((entry) => entry.role === "historical-review").length, 2);
  const applied = applyMigration({ root: fixture.root });
  assert.equal(applied.status, "applied");
  assert.equal(applied.boundary.validatedHistoricalApproval.candidateSetId, fixture.secondCandidate.candidateSetId);
  assert.equal(applied.boundary.validatedHistoricalApproval.reviewDecisionId, fixture.secondReview.reviewDecisionId);
  assert.deepEqual(subset(snapshotFiles(fixture.root), protectedPath), subset(before, protectedPath));
});

test("distribution without migrator supports fresh B to C, cold status/World/Context, and C to D", async (t) => {
  const { root } = await legacyReadyFixture({ version: "0.3.0", opaquePreviousRevision: true });
  const stageParent = fs.mkdtempSync(path.join(os.tmpdir(), "head-mig-runtime-"));
  const stage = path.join(stageParent, "plugin");
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stageParent, { recursive: true, force: true });
  });
  const historicalPaths = (name) => name.startsWith(".head/onboarding/candidate-sets/") || name.startsWith(".head/onboarding/review-decisions/");
  const historicalBefore = subset(snapshotFiles(root), historicalPaths);
  const historicalNames = new Set(Object.keys(historicalBefore));
  applyMigration({ root });
  await buildWorldModel({ root, persist: true });
  const proposalFile = path.join(stageParent, "semantic-proposal-c.json");
  fs.writeFileSync(proposalFile, `${JSON.stringify(proposal(root, "C"), null, 2)}\n`);
  const first = await runCommand(["onboarding-semantic-refresh", root, "--input", proposalFile]);
  fs.rmSync(proposalFile);
  assert.deepEqual(first.candidateSet.parentCandidateSetIds, []);
  assert.equal(first.candidateSet.producerReviewDecisionId, null);
  assert.ok(first.continuityReceipt);
  assert.equal(
    (await reviewOnboarding({ root, candidateSetId: first.candidateSet.candidateSetId, disposition: "accept-all", rationale: "Fixture-only C approval." }))
      .status,
    "onboarding_ready",
  );
  const continuityGraph = inspectWorldModel({ root }).snapshot.temporalProvenanceGraph;
  assert.equal(
    continuityGraph.nodes.some(
      (node) => node.kind === "HistoricalOnboardingCandidateReference" && node.nodeId === first.continuityReceipt.historicalCandidateSetId,
    ),
    true,
  );
  assert.equal(
    continuityGraph.edges.some(
      (edge) =>
        edge.type === "HISTORICALLY_FOLLOWS" && edge.from === first.continuityReceipt.historicalCandidateSetId && edge.to === first.candidateSet.candidateSetId,
    ),
    true,
  );
  const manifest = stageDistributionRelease({ sourceRoot: pluginRoot, destinationRoot: stage });
  assert.equal(
    manifest.files.some((item) => item.path.startsWith("legacy/")),
    false,
  );
  assert.equal(fs.existsSync(path.join(stage, "legacy")), false, "standalone helper is physically absent from runtime payload");
  const onboardingUrl = new URL(`file:///${path.join(stage, "scripts/lib/session/onboarding.mjs").replaceAll("\\", "/")}`).href;
  const worldUrl = new URL(`file:///${path.join(stage, "scripts/lib/world/world-model.mjs").replaceAll("\\", "/")}`).href;
  const contextUrl = new URL(`file:///${path.join(stage, "scripts/lib/session/context-compiler.mjs").replaceAll("\\", "/")}`).href;
  const mcpUrl = new URL(`file:///${path.join(stage, "scripts/mcp-server.mjs").replaceAll("\\", "/")}`).href;
  const childSource = `
    import {inspectOnboarding,reviewOnboarding} from ${JSON.stringify(onboardingUrl)};
    import {inspectWorldModel} from ${JSON.stringify(worldUrl)};
    import {compileContext} from ${JSON.stringify(contextUrl)};
    import {dispatch} from ${JSON.stringify(mcpUrl)};
    const root=${JSON.stringify(root)};
    const status=inspectOnboarding({root});
    const world=inspectWorldModel({root});
    const context=compileContext({root,task:'Inspect current delivery implementation',budget:32768,persist:false});
    const file=world.snapshot.files.find(item=>item.path==='src/delivery.mjs');
    const semanticProposal={schemaVersion:1,sourceSnapshotId:world.snapshot.temporalProvenanceGraph.sourceSnapshotId,candidates:[{productKind:'Capability',proposedEntity:{key:'delivery-d',name:'Delivery D',description:'Current D delivery.'},evidence:[{path:file.path,line:1,contentDigest:file.digest,symbol:null}],explanation:'Fresh current D meaning.',confidence:0.9}]};
    const response=await dispatch({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'head_onboarding_semantic_refresh',arguments:{project_root:root,semantic_proposal:semanticProposal}}});
    if(response.error) throw new Error(JSON.stringify(response.error));
    const proposed=response.result.structuredContent;
    const accepted=await reviewOnboarding({root,candidateSetId:proposed.candidateSet.candidateSetId,disposition:'accept-all',rationale:'Fixture-only D approval.'});
    process.stdout.write(JSON.stringify({status:status.status,world:world.status,context:context.status,accepted:accepted.status,parentIds:proposed.candidateSet.parentCandidateSetIds}));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", childSource], { cwd: stage, encoding: "utf8", timeout: 60_000 });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.deepEqual(
    { status: result.status, world: result.world, context: result.context, accepted: result.accepted },
    { status: "ready", world: "current", context: "preview", accepted: "onboarding_ready" },
  );
  assert.equal(result.parentIds.length, 1, "current-to-current semantic refresh keeps current ancestry only");
  const retrySnapshot = snapshotFiles(root);
  const retryAfterCurrentEvolution = applyMigration({ root });
  assert.equal(retryAfterCurrentEvolution.status, "already-applied");
  assert.equal(retryAfterCurrentEvolution.writes, 0);
  assert.deepEqual(snapshotFiles(root), retrySnapshot, "completed retry remains read-only after current state evolves");
  assert.deepEqual(
    subset(snapshotFiles(root), (name) => historicalNames.has(name)),
    historicalBefore,
    "opaque history bytes remain immutable while new current artifacts remain allowed",
  );
});

test("unsupported and forged inputs fail without writes", async (t) => {
  const { root } = await legacyReadyFixture({ version: "0.3.0" });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = snapshotFiles(root);
  assert.throws(() => applyHistoricalArtifactBoundary({ root, verifiedInventory: { validated: true }, hostMode: "explicit-one-shot" }), {
    code: "HISTORICAL_BOUNDARY_CAPABILITY_REQUIRED",
  });
  assert.deepEqual(snapshotFiles(root), before);
});

test("historical A to B may be bounded after current Canon has already advanced to C without rollback", async (t) => {
  const { root } = await legacyReadyFixture({ version: "0.3.0", opaquePreviousRevision: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const firstBoundary = applyMigration({ root });
  await buildWorldModel({ root, persist: true });
  const currentC = await proposeOnboardingSemanticRefresh({ root, semanticProposal: proposal(root, "C") });
  const acceptedC = await reviewOnboarding({
    root,
    candidateSetId: currentC.candidateSet.candidateSetId,
    disposition: "accept-all",
    rationale: "Fixture-only C approval before migration replay.",
  });
  const canonBefore = fs.readFileSync(path.join(root, ".head", "context", "product-model.json"));
  const stateBefore = fs.readFileSync(path.join(root, ".head", "onboarding", "current.json"));
  fs.rmSync(path.join(root, ".head", "onboarding", "historical-boundaries"), { recursive: true, force: true });
  fs.rmSync(path.join(root, ".head", "onboarding", "historical-continuity"), { recursive: true, force: true });
  const migratedAfterC = applyMigration({ root });
  assert.equal(migratedAfterC.status, "applied");
  assert.notEqual(
    migratedAfterC.boundary.boundaryHash,
    firstBoundary.boundary.boundaryHash,
    "application basis records the later current state while inventory identity stays historical",
  );
  assert.equal(migratedAfterC.boundary.inventoryHash, firstBoundary.boundary.inventoryHash);
  assert.equal(fs.readFileSync(path.join(root, ".head", "context", "product-model.json")).equals(canonBefore), true);
  assert.equal(fs.readFileSync(path.join(root, ".head", "onboarding", "current.json")).equals(stateBefore), true);
  assert.equal(acceptedC.reviewDecision.resultingProductModelId, migratedAfterC.boundary.appliedAtBasis.canon.id);
});

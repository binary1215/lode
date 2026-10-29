import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileContext, readContextCapsule, DEFAULT_CONTEXT_BUDGET } from "../scripts/lib/context-compiler.mjs";
import { prepareContextWorkflow, previewContextWorkflow } from "../scripts/lib/context-workflow.mjs";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { buildWorldModel, readWorldModel } from "../scripts/lib/world-model.mjs";
import { prepareSourceContext } from "../scripts/lib/source-context-workflow.mjs";
import { updateProjectDirection } from "../scripts/lib/project-direction.mjs";
import { proposeProductPolicy, reviewProductPolicy } from "../scripts/lib/product-policy.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "head-light-context-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const layout = inspectProject(root).storage;
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/CacheRelay.mjs"), "export function preserveQueue(value) { return value; }\n");
  fs.writeFileSync(path.join(root, "src/무인큐.mjs"), "export const 무인큐 = true;\n");
  return { root, layout };
}
function originalFiles(root, layout) {
  const out = {};
  function walk(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) walk(file);
      else out[path.relative(root, file)] = fs.readFileSync(file).toString("base64");
    }
  }
  walk(path.join(root, layout.directory));
  assert.ok(Object.hasOwn(out, path.join(layout.directory, "project.json")));
  assert.ok(Object.hasOwn(out, path.join(layout.directory, "sessions", "current.json")));
  return out;
}

test("ordinary preparation preserves exact task and current direction without World or a new decision", async t => {
  const { root, layout } = fixture(t);
  const direction = updateProjectDirection({ root, expectedDirectionId: null,
    input: { goal: "Inspect the queue", constraints: ["Keep source local"], decisions: ["Retain pending requests"], cancelledActions: ["Deploy"] } }).direction;
  const task = "  CacheRelay를 조사한다\n";
  const before = originalFiles(root, layout);
  const preview = (await previewContextWorkflow({ root, task,
    evidenceNeeds: [{ id: "source", kind: "repository-source", paths: ["src/CacheRelay.mjs"] }] }));
  assert.equal(preview.capsule.task, task);
  assert.deepEqual(preview.capsule.currentDirection, direction);
  assert.equal(preview.workflow.status, "ready_for_head_semantic_assessment");
  assert.equal(preview.workflow.world.state, "not-built");
  assert.equal(preview.workflow.authority.grantsExecutionAuthorization, false);
  assert.equal(preview.capsule.evidenceGaps[0].reason, "matching-evidence-unavailable");
  assert(preview.capsule.uncertainty.some(text => text.includes("current source")));
  assert(!("coverageAssessment" in preview.capsule));
  assert(!("sufficiency" in preview.capsule));
  assert(!("proofDigest" in preview.capsule));
  assert(!("allowedTiers" in preview.workflow.budget));
  const prepared = (await prepareContextWorkflow({ root, task }));
  assert.equal(prepared.preparation.status, "ready_for_head_semantic_assessment");
  assert.deepEqual(prepared.preparation.currentDirection, direction);
  assert.deepEqual(originalFiles(root, layout), before);
});

test("positive budgets are caller bounds, without fixed tiers or automatic retries", async t => {
  const { root, layout } = fixture(t);
  await buildWorldModel({ root });
  for (const budget of [1, 8000, 50_000, 786_432]) {
    const preview = (await previewContextWorkflow({ root, task: "Inspect CacheRelay", budget,
      evidenceNeeds: [{ id: "source", kind: "repository-source", paths: ["src/CacheRelay.mjs"] }] }));
    assert.equal(preview.capsule.budget.maxApproxTokens, budget);
    assert(!("attemptedTiers" in preview.workflow.budget));
    assert.equal(preview.workflow.status, "ready_for_head_semantic_assessment");
    if (budget === 1) {
      assert.equal(preview.capsule.evidenceGaps[0].reason, "context-budget");
      assert(preview.capsule.omissions.byReason["context-budget"] > 0);
      assert(preview.capsule.uncertainty.some(text => text.includes("exceeds")));
    } else assert.equal(preview.capsule.repositoryContext[0].path, "src/CacheRelay.mjs");
  }
  assert.equal((await compileContext({ root, task: "Inspect queue" })).capsule.budget.maxApproxTokens, DEFAULT_CONTEXT_BUDGET);
  for (const budget of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity])
    (await assert.rejects(async () => (await compileContext({ root, task: "Inspect queue", budget })), { code: "INVALID_CONTEXT_BUDGET" }));
});

test("lexical ranking never excludes otherwise eligible curated evidence", async t => {
  const { root, layout } = fixture(t), file = path.join(root, layout.directory, "context/knowledge.json");
  const knowledge = JSON.parse(fs.readFileSync(file, "utf8"));
  knowledge.claims.push({ id: "claim-color", statement: "The login button uses a blue palette.", status: "active", importance: 1, tags: ["frontend"] });
  fs.writeFileSync(file, JSON.stringify(knowledge));
  const capsule = (await compileContext({ root, task: "Explain queue retention" })).capsule;
  assert(capsule.selection.includedIds.includes("claim-color"));
  assert(!capsule.selection.excluded.some(item => item.reason === "low-relevance"));
});

test("case, Korean and exact paths guide context while original body consumption remains disclosed", async t => {
  const { root, layout } = fixture(t);
  await buildWorldModel({ root });
  const before = originalFiles(root, layout);
  for (const task of ["CacheRelay", "cacherelay", "CACHERELAY", "CacheRelay를 설명해", "src/CacheRelay.mjs"]) {
    const capsule = (await compileContext({ root, task })).capsule;
    assert.equal(capsule.repositoryContext[0].path, "src/CacheRelay.mjs", task);
    assert.equal(capsule.repositoryContext[0].representation.sourceBodyIncluded, false);
    assert(capsule.uncertainty.some(text => text.includes("source bodies")));
  }
  assert.equal((await compileContext({ root, task: "무인큐를 설명해" })).capsule.repositoryContext[0].path, "src/무인큐.mjs");
  assert.deepEqual(originalFiles(root, layout), before);
});

test("stale World excludes metadata but permits selected current original source without indexing", async t => {
  const { root, layout } = fixture(t);
  await buildWorldModel({ root });
  fs.writeFileSync(path.join(root, "src/CacheRelay.mjs"), "export function preserveQueue(value) { return [value]; }\n");
  const before = originalFiles(root, layout);
  const stale = (await previewContextWorkflow({ root, task: "Inspect CacheRelay",
    evidenceNeeds: [{ id: "source", kind: "repository-source", paths: ["src/CacheRelay.mjs"] }] }));
  assert.equal(stale.workflow.world.state, "stale-excluded");
  assert.equal(stale.workflow.status, "ready_for_head_semantic_assessment");
  assert.deepEqual(stale.capsule.repositoryContext, []);
  const source = await prepareSourceContext({ root, task: "Inspect current CacheRelay", retain: false,
    needs: [{ kind: "source", path: "src/CacheRelay.mjs" }] });
  assert.equal(source.status, "observed");
  assert.equal(source.results[0].includedInContext, true);
  assert.deepEqual(source.context.capsule.evidenceGaps, []);
  assert.deepEqual(originalFiles(root, layout), before);
});

test("missing evidence reports meaningful unknowns without a semantic or execution score", async t => {
  const { root, layout } = fixture(t);
  await buildWorldModel({ root });
  const capsule = (await compileContext({ root, task: "Inspect queue",
    evidenceNeeds: [{ id: "missing-test", kind: "repository-test", paths: ["test/absent.mjs"] }], persist: true })).capsule;
  assert.equal(capsule.evidenceGaps[0].available, 0);
  assert.equal(capsule.evidenceGaps[0].selected, 0);
  assert.equal(capsule.evidenceGaps[0].reason, "matching-evidence-unavailable");
  assert.equal(capsule.semanticSufficiencyOwner, "Lode");
  assert.equal(readContextCapsule({ root, capsuleId: capsule.capsuleId }).capsule.capsuleId, capsule.capsuleId);
});

test("durable Capsules preserve same-project identity and exact original hash on read", async t => {
  const { root, layout } = fixture(t), { root: other, layout: otherLayout } = fixture(t);
  const first = (await compileContext({ root, task: "Inspect queue", persist: true }));
  assert.equal(readContextCapsule({ root, capsuleId: first.capsule.capsuleId }).capsule.capsuleHash, first.capsule.capsuleHash);
  const copied = path.join(other, otherLayout.directory, "context/capsules", path.basename(first.file));
  fs.mkdirSync(path.dirname(copied), { recursive: true }); fs.copyFileSync(first.file, copied);
  assert.throws(() => readContextCapsule({ root: other, capsuleId: first.capsule.capsuleId }), { code: "CONTEXT_CAPSULE_PROJECT_MISMATCH" });
});

test("historical Capsule reader preserves old payload without enforcing an inclusion gate", async t => {
  const { root, layout } = fixture(t);
  const current = (await compileContext({ root, task: "Inspect queue" })).capsule;
  const payload = { kind: "ContextCapsule", schemaVersion: current.schemaVersion, task: "Legacy exact task",
    snapshot: current.snapshot, budget: { maxApproxTokens: 32768 },
    coverageAssessment: { mechanicalCoverageSatisfied: true, proofDigest: "historical-stored-proof" },
    selection: { includedIds: ["old-record-id"], excluded: [] }, claims: [] };
  function sorted(value) { return Array.isArray(value) ? value.map(sorted) : value && typeof value === "object" ?
    Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value; }
  const capsuleHash = crypto.createHash("sha256").update(JSON.stringify(sorted(payload))).digest("hex");
  const capsule = { ...payload, capsuleHash, capsuleId: "capsule-" + capsuleHash.slice(0, 24) };
  const directory = path.join(root, layout.directory, "context/capsules"); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, capsule.capsuleId + ".json"), JSON.stringify(capsule));
  assert.deepEqual(readContextCapsule({ root, capsuleId: capsule.capsuleId }).capsule, capsule);
});

test("exact bounded graph anchors retain Project and revision identity", async t => {
  const { root, layout } = fixture(t);
  await buildWorldModel({ root });
  const snapshot = (await readWorldModel({ root })).snapshot, graph = snapshot.temporalProvenanceGraph;
  const node = graph.nodes.find(item => item.kind === "File" && item.path === "src/CacheRelay.mjs");
  const need = { id: "file-revision", kind: "temporal-relation", relationTypes: ["HAS_REVISION"],
    graphAnchor: { projectId: snapshot.projectId, worldModelId: snapshot.worldModelId, graphSnapshotId: graph.graphSnapshotId,
      nodeIds: [node.nodeId], depth: 1, maxNodes: 8, maxEdges: 12 } };
  const capsule = (await compileContext({ root, task: "Inspect exact revision", evidenceNeeds: [need] })).capsule;
  assert(capsule.graphTraversalEvidence[0].relationships.some(edge => edge.type === "HAS_REVISION"));
  assert.equal(capsule.graphTraversalEvidence[0].graphSnapshotId, graph.graphSnapshotId);
  assert.deepEqual(capsule.evidenceGaps, []);
  (await assert.rejects(async () => (await compileContext({ root, task: "Inspect exact revision",
    evidenceNeeds: [{ ...need, graphAnchor: { ...need.graphAnchor, projectId: "other-project" } }] })), { code: "GRAPH_ANCHOR_PROJECT_MISMATCH" }));
});

test("HEAD exact Product keys retain current Canon revisions and missing facets remain advisory", async t => {
  const { root, layout } = fixture(t);
  const { candidate } = await proposeProductPolicy({ root, operation: "create", key: "local-boundary",
    name: "LocalBoundary", statement: "Keep upload cancellation local." });
  await reviewProductPolicy({ root, candidateId: candidate.candidateId, disposition: "accept", rationale: "Adopt this local test policy." });
  await buildWorldModel({ root });
  const before = originalFiles(root, layout);
  const selected = (await compileContext({ root, task: "Review local boundary", evidenceNeeds: [
    { id: "policy", kind: "product-context", entityKeys: ["local-boundary"] } ] })).capsule;
  const entities = selected.productContext.flatMap(record => record.entities);
  assert(entities.some(entity => entity.key === "local-boundary" && entity.logicalEntityId && entity.currentRevisionId
    && entity.authorityClass === "canon-projected" && entity.freshness === "current"));
  assert.deepEqual(selected.evidenceGaps, []);
  const missing = (await compileContext({ root, task: "Review local boundary", evidenceNeeds: [
    { id: "policy", kind: "product-context", entityKeys: ["local-boundary"], facets: ["UnseenNebulaValue"] } ] })).capsule;
  assert.equal(missing.evidenceGaps[0].reason, "matching-evidence-unavailable");
  const metadata = (await compileContext({ root, task: "Review local boundary", evidenceNeeds: [
    { id: "metadata", kind: "product-context", entityKeys: ["local-boundary"], facets: ["instructionAuthority"] } ] })).capsule;
  assert.equal(metadata.evidenceGaps[0].available, 0);
  assert.deepEqual(originalFiles(root, layout), before);
});

test("bounded source metadata omissions disclose counts without asserting total coverage", async t => {
  const { root, layout } = fixture(t);
  fs.writeFileSync(path.join(root, "src/CacheRelay.mjs"), Array.from({ length: 24 }, (_, index) =>
    `export function relay${index}() { return ${index}; }`).join("\n"));
  await buildWorldModel({ root });
  const capsule = (await compileContext({ root, task: "Inspect CacheRelay source", evidenceNeeds: [
    { id: "unknown-symbol", kind: "repository-source", paths: ["src/CacheRelay.mjs"], facets: ["UnseenNebulaValue"] } ] })).capsule;
  const file = capsule.repositoryContext.find(record => record.path === "src/CacheRelay.mjs");
  assert(file.evidenceOmissions.symbols > 0);
  assert(capsule.omissions.boundedRepresentations.some(item => item.candidateId === "repository-file:src/CacheRelay.mjs" && item.symbols > 0));
  assert.equal(capsule.evidenceGaps[0].availabilityScope, "compiled-candidate-material-only");
  assert.equal(capsule.evidenceGaps[0].missingEvidenceMayExist, true);
  assert(capsule.omissions.countsScope.includes("not-total-project-coverage"));
});

import { worldSnapshotFile, graphSnapshotFile, readFixtureSnapshot, writeFixtureSnapshot } from "./helpers/snapshot-storage-fixture.mjs";
import { relativeProjectArtifact } from "../scripts/lib/project-storage-format.mjs";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { createHeadSession, withSessionRoute } from "../scripts/lib/session-routing.mjs";
import { buildWorldModel, inspectWorldModel, inspectWorldDomainFreshness, readWorldModelForDiscovery,
  buildWorldTraversalEligibility, queryWorldModel, queryWorldTemporalGraph } from "../scripts/lib/world-model.mjs";
import { queryTemporalProvenanceGraph, buildTemporalProvenanceGraph } from "../scripts/lib/temporal-provenance.mjs";
import { emptyProductModelDocument, normalizeProductModelDocument } from "../scripts/lib/product-model.mjs";
import { initialOnboardingDocuments } from "../scripts/lib/onboarding-contract.mjs";
import { compileContext } from "../scripts/lib/context-compiler.mjs";
import { queryGraphProjection } from "../scripts/lib/graph-projection-adapter.mjs";
import { SOURCE_ANALYSIS_VERSION } from "../scripts/lib/source-analysis.mjs";
import { writeRepositorySourceScope } from "../scripts/lib/repository-source-scope.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
function bytes(root) {
  const result = {};
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else result[path.relative(root, file)] = fs.readFileSync(file).toString("base64");
    }
  }
  visit(root); return result;
}
// Synthetic legacy contract seed only; genuine old-producer interoperability is verified separately.
function seedLegacyProject(root) {
  root = fs.realpathSync(root);
  const createdAt = "2026-09-22T00:00:00.000Z";
  const project = { schemaVersion: 1, projectId: `head-${crypto.createHash("sha256").update(root).digest("hex").slice(0, 20)}`,
    projectRoot: root, createdAt, runtimes: ["claude", "codex", "opencode"], integrations: {},
    authority: { head: "ordinary investigation, strategy, integration, and completion judgment",
      user: "material product, policy, architecture, cost, workflow, and consequential external actions" } };
  const sessionState = { schemaVersion: 1, sessionId: `session-${crypto.randomUUID()}`, mode: "session",
    currentWholePlanId: null, activeRunId: null, activeExecutionContractId: null, lastResultPacketId: null,
    pendingReview: null, lastReviewDecisionId: null, requiredPlanAction: null, latestCheckpoint: null, updatedAt: createdAt };
  const product = emptyProductModelDocument();
  const onboarding = initialOnboardingDocuments({ project, sessionState,
    productModelId: normalizeProductModelDocument(product).productModelId, updatedAt: createdAt });
  const records = new Map([
    [".head/project.json", project], [".head/sessions/current.json", sessionState],
    [".head/context/knowledge.json", { schemaVersion: 1, evidence: [], claims: [], decisions: [], unknowns: [] }],
    [".head/context/product-model.json", product], [".head/onboarding/current.json", onboarding.state],
    [`.head/sessions/records/${onboarding.sessionRecord.sessionId}.json`, onboarding.sessionRecord],
    [`.head/onboarding/storage-selections/${onboarding.storageSelection.storageSelectionId}.json`, onboarding.storageSelection],
  ]);
  for (const [relative, value] of records) {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  }
  const immutable = [...records.keys()].filter(relative => relative === ".head/project.json"
    || relative.startsWith(".head/sessions/records/") || relative.startsWith(".head/onboarding/storage-selections/"));
  const manifest = { schemaVersion: 1, generatedAt: createdAt, pluginRoot,
    packageVersion: JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"))).version,
    managed: immutable.map(relative => ({ path: relative, sha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(root, relative))).digest("hex") })) };
  fs.mkdirSync(path.join(root, ".head/generated"), { recursive: true });
  fs.writeFileSync(path.join(root, ".head/generated/manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  const inspected = inspectProject(root); assert.equal(inspected.status, "ready");
  assert.equal(inspected.storage.directory, ".head");
  return { project };
}

async function fixture(t, { legacy = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "head-domain-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (legacy) seedLegacyProject(root);
  else initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/main.mjs"), "import { relay } from './relay.mjs';\nexport function start(value) { return relay(value); }\n");
  fs.writeFileSync(path.join(root, "src/relay.mjs"), "export function relay(value) { return value; }\n");
  await buildWorldModel({ root });
  return { root, storage };
}
function mutateSession(root, storage, patch) {
  const file = path.join(root, relativeProjectArtifact(storage, "sessions", "current.json"));
  const state = JSON.parse(fs.readFileSync(file));
  fs.writeFileSync(file, JSON.stringify({ ...state, ...patch })); return state;
}
function retainedStore(snapshot) {
  // Existing in-memory adapter shape, no network or persistence.
  return { adapterKind: "fixture", adapterVersion: "0.1.0", describe() { return { adapterKind: "fixture",
    authority: "derived-evidence-only", rebuildable: true, uniqueAuthority: false }; },
    readPointer() { return { document: { schemaVersion: 1, kind: "WorldModelPointer", projectId: snapshot.projectId,
      worldModelId: snapshot.worldModelId, worldModelHash: snapshot.worldModelHash } }; },
    readSnapshot(id) { return id === snapshot.worldModelId ? { document: snapshot } : null; },
    listSnapshotIds() { return [snapshot.worldModelId]; }, writePointer() { throw Error("read-only"); }, writeSnapshot() { throw Error("read-only"); } };
}

test("temporal verification scopes own immutable copies without trusting frozen lookalikes or closed scopes", async t => {
  const { root } = await fixture(t), snapshot = (await readWorldModelForDiscovery({ root })).snapshot;
  const api = await import("../scripts/lib/temporal-provenance.mjs");
  assert.equal(typeof api.createTemporalVerificationScope, "function");
  const scope = api.createTemporalVerificationScope(), nested = api.createTemporalVerificationScope();
  const createHash = crypto.createHash;
  let hashes = 0;
  const hashProbe = t.mock.method(crypto, "createHash", function(...args) { hashes += 1; return createHash.apply(this, args); });
  try {
    const owned = api.ownWorldSnapshotForTemporalScope(scope, snapshot);
    assert.notEqual(owned, snapshot);
    assert.notEqual(owned.temporalProvenanceGraph, snapshot.temporalProvenanceGraph);
    api.verifyTemporalProvenanceGraph(owned.temporalProvenanceGraph);
    assert(hashes > 0, "the first owned graph check must verify the actual hash");
    hashes = 0; api.verifyTemporalProvenanceGraph(owned.temporalProvenanceGraph);
    assert.equal(hashes, 0, "only this exact owned immutable graph reuses verification");
    assert(Object.isFrozen(owned.temporalProvenanceGraph.nodes[0]));
    const projection = api.queryTemporalProvenanceGraph(owned.temporalProvenanceGraph, { query: "main.mjs" });
    assert(projection.nodes.length);
    assert(projection.nodes.every(node => !Object.isFrozen(node)));
    projection.nodes[0].name = "caller-local projection change";
    assert(!owned.temporalProvenanceGraph.nodes.some(node => node.name === "caller-local projection change"));
    const sibling = api.ownWorldSnapshotForTemporalScope(nested, snapshot);
    api.verifyTemporalProvenanceGraph(sibling.temporalProvenanceGraph);
    scope.close();
    hashes = 0; api.verifyTemporalProvenanceGraph(owned.temporalProvenanceGraph);
    assert(hashes > 0, "closing the scope discards its verification memo");
    hashes = 0;
    assert.equal(api.verifyTemporalProvenanceGraph(sibling.temporalProvenanceGraph), sibling.temporalProvenanceGraph);
    assert.equal(hashes, 0, "closing a different scope cannot disturb a nested request");
    assert.throws(() => api.ownWorldSnapshotForTemporalScope(scope, snapshot), { code: "TEMPORAL_VERIFICATION_SCOPE_CLOSED" });
    assert.throws(() => api.ownWorldSnapshotForTemporalScope({ ownSnapshot: () => snapshot }, snapshot), { code: "INVALID_TEMPORAL_VERIFICATION_SCOPE" });
    const tampered = structuredClone(snapshot.temporalProvenanceGraph);
    tampered.nodes[0].name = "forged nested alias";
    Object.freeze(tampered);
    assert.throws(() => api.verifyTemporalProvenanceGraph(tampered), { code: "TEMPORAL_GRAPH_DIGEST_MISMATCH" });
    const ownedTamper = api.ownWorldSnapshotForTemporalScope(nested, { ...snapshot, temporalProvenanceGraph: tampered });
    assert.throws(() => api.verifyTemporalProvenanceGraph(ownedTamper.temporalProvenanceGraph), { code: "TEMPORAL_GRAPH_DIGEST_MISMATCH" });
    // An unused outer function is omitted by the existing canonical JSON
    // contract. Request-local optimization must not reject an accepted store.
    const extended = { ...snapshot, unusedInspectionHelper() { return "not graph evidence"; } };
    const extendedStore = retainedStore(extended);
    assert.equal((await readWorldModelForDiscovery({ root, storeAdapter: extendedStore })).snapshot, extended);
    const extendedRead = (await readWorldModelForDiscovery({ root, storeAdapter: extendedStore, temporalVerificationScope: nested }));
    assert.equal(extendedRead.snapshot, extended, "uncloneable accepted input must retain the ordinary full-verification path");
    assert.equal(Object.isFrozen(extended.temporalProvenanceGraph.nodes[0]), false);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      hashes = 0; api.verifyTemporalProvenanceGraph(extended.temporalProvenanceGraph);
      assert(hashes > 0, "fallback graphs must never acquire a verification memo");
    }
    const originalName = extended.temporalProvenanceGraph.nodes[0].name;
    try {
      extended.temporalProvenanceGraph.nodes[0].name = "later external mutation";
      assert.throws(() => api.verifyTemporalProvenanceGraph(extended.temporalProvenanceGraph), { code: "TEMPORAL_GRAPH_DIGEST_MISMATCH" });
    } finally {
      if (originalName === undefined) delete extended.temporalProvenanceGraph.nodes[0].name;
      else extended.temporalProvenanceGraph.nodes[0].name = originalName;
    }
  } finally { hashProbe.mock.restore(); scope.close(); nested.close(); }
});

test("project graph isolates retained adapter aliases before await and leaves returned projections mutable", async t => {
  const { root } = await fixture(t), snapshot = (await readWorldModelForDiscovery({ root })).snapshot;
  const { queryProjectGraph } = await import("../scripts/lib/project-graph.mjs");
  const store = retainedStore(snapshot), read = store.readSnapshot;
  store.readSnapshot = function(id) {
    const entry = read.call(this, id);
    queueMicrotask(() => { snapshot.temporalProvenanceGraph.nodes[0].name = "unverified microtask mutation"; });
    return entry;
  };
  const result = await queryProjectGraph({ root, storeAdapter: store, query: "main.mjs", depth: 1, details: true });
  assert.equal(result.adapter.status, "verified", JSON.stringify(result.adapter));
  assert(!result.integrity.excluded.some(entry => entry.layer === "world"));
  assert(!result.nodes.some(node => node.name === "unverified microtask mutation"));
  assert(result.nodes.length);
  const checkMutable = (value, at) => {
    if (!value || typeof value !== "object") return;
    assert.equal(Object.isFrozen(value), false, at);
    for (const [key, nested] of Object.entries(value)) checkMutable(nested, `${at}.${key}`);
  };
  // Authority metadata was already intentionally frozen before this change.
  // Owned evidence, not those preexisting contracts, must remain mutable.
  assert.equal(Object.isFrozen(result.authorityBoundary), true);
  assert.equal(Object.isFrozen(result.authority), true);
  checkMutable(result.nodes, "nodes"); checkMutable(result.edges, "edges");
  result.nodes[0].sourceReference.path = "caller-only-change";
  (await assert.rejects(async () => (await readWorldModelForDiscovery({ root, storeAdapter: store })), { code: "WORLD_MODEL_DIGEST_MISMATCH" }));
  assert.equal(Object.isFrozen(snapshot), false);
  assert.equal(Object.isFrozen(snapshot.temporalProvenanceGraph.nodes[0]), false);
});

test("runtime/checkpoint drift preserves code query and Context; reads leave every byte unchanged", async t => {
  const { root, storage } = await fixture(t), original = (await readWorldModelForDiscovery({ root })).snapshot;
  assert.equal((await inspectWorldModel({ root })).status, "current");
  mutateSession(root, storage, { latestCheckpoint: { checkpointId: "checkpoint-fixture", digest: "a".repeat(64) } });
  const before = bytes(root);
  const full = (await inspectWorldModel({ root }));
  assert.equal(full.status, "stale");
  assert.equal(full.freshness.domains.runtime.status, "stale");
  assert.equal(full.freshness.domains.code.status, "current");
  const scoped = (await inspectWorldDomainFreshness({ root, domains: ["code"] }));
  assert.deepEqual(Object.keys(scoped.freshness.domains), ["code"]);
  const queried = (await queryWorldModel({ root, query: "start", depth: 2 }));
  assert.equal(queried.status, "current");
  assert(queried.edges.some(edge => edge.type === "CALLS"));
  assert(queried.edges.some(edge => edge.type === "IMPORTS"));
  const capsule = (await compileContext({ root, task: "Inspect relay implementation" })).capsule;
  assert(capsule.repositoryContext.some(item => item.path === "src/relay.mjs"));
  assert.equal(capsule.repositoryWorldFreshness.domains.runtime.status, "stale");
  assert.equal(capsule.repositoryGraph.semanticGraphId, original.semanticGraph.semanticGraphId);
  const temporal = (await queryWorldTemporalGraph({ root, query: "main.mjs" }));
  assert.equal(temporal.graphSnapshotId, original.temporalProvenanceGraph.graphSnapshotId);
  assert.equal(temporal.graphSnapshotHash, original.temporalProvenanceGraph.graphSnapshotHash);
  assert.deepEqual(bytes(root), before);
});

test("code-only query never reads unrelated current Product, Session, observation or runtime readers", async t => {
  const { root, storage } = await fixture(t);
  fs.writeFileSync(path.join(root, relativeProjectArtifact(storage, "context", "product-model.json")), "broken-product-json");
  const codeContext = (await compileContext({ root, task: "Inspect source", evidenceNeeds: [{ id: "code", kind: "repository-source", paths: ["src/main.mjs"] }] })).capsule;
  assert.deepEqual(Object.keys(codeContext.repositoryWorldFreshness.domains), ["code"]);
  assert(codeContext.repositoryContext.some(item => item.path === "src/main.mjs"));
  fs.writeFileSync(path.join(root, relativeProjectArtifact(storage, "sessions", "current.json")), "broken-session-json");
  const before = bytes(root);
  assert.equal((await inspectWorldDomainFreshness({ root, domains: ["code"] })).freshness.domains.code.status, "current");
  assert.equal((await queryWorldModel({ root, query: "relay" })).status, "current");
  const mixed = (await inspectWorldDomainFreshness({ root }));
  assert.equal(mixed.freshness.domains.code.status, "current");
  assert.equal(mixed.freshness.domains.product.status, "unavailable");
  assert.equal(mixed.freshness.domains.runtime.status, "unavailable");
  assert.deepEqual(bytes(root), before);
});

test("capture owner remains Session A while Session B is selected; no World copy per Session", async t => {
  const { root, storage } = await fixture(t), original = (await readWorldModelForDiscovery({ root })).snapshot;
  const second = createHeadSession({ root, purpose: "Independent work" }).sessionId;
  const before = bytes(root);
  (await withSessionRoute(root, second, async () => {
    const full = (await inspectWorldModel({ root }));
    assert.equal(full.status, "current");
    assert.equal(full.capturedRuntimeSessionId, original.runtimeState.sessionId);
    assert.equal(full.selectedSessionState.sessionId, second);
    const runtime = (await inspectWorldDomainFreshness({ root, domains: ["runtime"] }));
    assert.equal(runtime.freshness.domains.runtime.status, "current");
    assert.equal(runtime.freshness.domains.runtime.capturedSessionId, original.runtimeState.sessionId);
    assert.equal((await queryWorldModel({ root, query: "relay" })).status, "current");
  }));
  assert.deepEqual(bytes(root), before);
});

test("add/delete/rename invalidate all code relations, including unchanged importer; source fallback is non-writing", async t => {
  for (const operation of ["add", "delete", "rename", "edit"]) {
    const { root, storage } = await fixture(t), importer = fs.readFileSync(path.join(root, "src/main.mjs"));
    if (operation === "add") fs.writeFileSync(path.join(root, "src/extra.mjs"), "export const extra = 1;\n");
    if (operation === "delete") fs.unlinkSync(path.join(root, "src/relay.mjs"));
    if (operation === "rename") fs.renameSync(path.join(root, "src/relay.mjs"), path.join(root, "src/renamed.mjs"));
    if (operation === "edit") fs.appendFileSync(path.join(root, "src/relay.mjs"), "export const changed = 1;\n");
    const before = bytes(root), scoped = (await inspectWorldDomainFreshness({ root, domains: ["code"] }));
    assert.equal(scoped.freshness.domains.code.status, "stale", operation);
    assert.deepEqual(fs.readFileSync(path.join(root, "src/main.mjs")), importer);
    const queried = (await queryWorldModel({ root, query: "main.mjs" }));
    assert.equal(queried.status, "stale"); assert.equal(queried.fallback, "original-source"); assert.deepEqual(queried.edges, []);
    assert.equal((await compileContext({ root, task: "main" })).capsule.repositoryGraph, null);
    assert.deepEqual(bytes(root), before);
  }
});

test("SourceScope and recorded analyzer basis are genuine invalidators, not runtime aliases", async t => {
  const { root, storage } = await fixture(t), snapshot = (await readWorldModelForDiscovery({ root })).snapshot;
  assert.equal(snapshot.analysisBasis.sourceAnalysisVersion, SOURCE_ANALYSIS_VERSION);
  assert.equal(snapshot.indexer.sourceAnalysisVersion, SOURCE_ANALYSIS_VERSION);
  writeRepositorySourceScope({ projectRoot: root, selection: { excludeRoots: ["src"] }, storage });
  const before = bytes(root);
  assert.equal((await inspectWorldDomainFreshness({ root, domains: ["code"] })).freshness.domains.code.status, "stale");
  assert.deepEqual(bytes(root), before);
  const tampered = structuredClone(snapshot);
  tampered.analysisBasis.sourceAnalysisVersion = "unproved-parser";
  delete tampered.worldModelId; delete tampered.worldModelHash;
  tampered.worldModelHash = hash(tampered); tampered.worldModelId = `world-model-${tampered.worldModelHash.slice(0, 24)}`;
  // Stable relations bind their own analysis basis, checked before domain bases.
  await assert.rejects(() => readWorldModelForDiscovery({ root, storeAdapter: retainedStore(tampered) }),
    { code: "WORLD_MODEL_ANALYSIS_BASIS_MISMATCH" });
  const wrongDomain = structuredClone(snapshot);
  wrongDomain.domainBases.code = "f".repeat(64);
  delete wrongDomain.worldModelId; delete wrongDomain.worldModelHash;
  wrongDomain.worldModelHash = hash(wrongDomain); wrongDomain.worldModelId = `world-model-${wrongDomain.worldModelHash.slice(0, 24)}`;
  await assert.rejects(() => readWorldModelForDiscovery({ root, storeAdapter: retainedStore(wrongDomain) }),
    { code: "WORLD_DOMAIN_BASIS_MISMATCH" });
  assert.deepEqual(bytes(root), before);
});

test("an unchanged importer's newly resolved target needs the existing refresh, not guessed traversal", async t => {
  const { root, storage } = await fixture(t);
  fs.appendFileSync(path.join(root, "src/main.mjs"), "import { optional } from './optional.mjs';\n");
  const first = (await buildWorldModel({ root })).snapshot;
  assert(first.semanticGraph.summary.unresolvedImportCount > 0);
  const importerDigest = first.files.find(file => file.path === "src/main.mjs").digest;
  fs.writeFileSync(path.join(root, "src/optional.mjs"), "export const optional = true;\n");
  assert.equal((await inspectWorldDomainFreshness({ root, domains: ["code"] })).freshness.domains.code.status, "stale");
  assert.deepEqual((await queryWorldModel({ root, query: "main.mjs" })).edges, []);
  const second = (await buildWorldModel({ root })).snapshot;
  assert.equal(second.files.find(file => file.path === "src/main.mjs").digest, importerDigest);
  assert.notEqual(second.worldModelId, first.worldModelId);
  assert.equal(second.semanticGraph.summary.unresolvedImportCount, 0);
  assert((await queryWorldModel({ root, query: "optional.mjs" })).edges.some(edge => edge.type === "IMPORTS"));
  assert(fs.existsSync(worldSnapshotFile(root, first.worldModelId)));
});

test("product Git branch drift remains observable without invalidating unrelated code", async t => {
  const { root, storage } = await fixture(t);
  fs.mkdirSync(path.join(root, ".git/refs/heads"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git/HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(root, ".git/refs/heads/main"), `${"1".repeat(40)}\n`);
  const before = bytes(root), domains = (await inspectWorldDomainFreshness({ root }));
  assert.equal(domains.freshness.domains.git.status, "stale");
  assert.equal(domains.freshness.domains.code.status, "current");
  assert.equal((await queryWorldModel({ root, query: "main.mjs" })).status, "current");
  assert.deepEqual(bytes(root), before);
});

test("Product drift excludes only Product links while current code remains available to Context", async t => {
  const { root, storage } = await fixture(t), productFile = path.join(root, relativeProjectArtifact(storage, "context", "product-model.json"));
  const product = { schemaVersion: 1, featureGroups: [], capabilities: [{ key: "relay", name: "Relay", description: "Forward a message" }],
    features: [], requirements: [], constraints: [], decisions: [] };
  fs.writeFileSync(productFile, JSON.stringify(product)); await buildWorldModel({ root });
  product.capabilities[0].description = "Different current Product meaning";
  fs.writeFileSync(productFile, JSON.stringify(product));
  const before = bytes(root), inspected = (await inspectWorldDomainFreshness({ root }));
  assert.equal(inspected.freshness.domains.product.status, "stale");
  assert.equal(inspected.freshness.domains.code.status, "current");
  assert.equal((await queryWorldModel({ root, query: "start" })).status, "current");
  const capsule = (await compileContext({ root, task: "Relay source implementation" })).capsule;
  assert(capsule.repositoryContext.some(item => item.path === "src/relay.mjs"));
  assert.deepEqual(capsule.productContext, []);
  const temporal = (await queryWorldTemporalGraph({ root, query: "main.mjs", depth: 3 }));
  assert(temporal.nodes.some(node => node.kind === "File"));
  assert(!temporal.nodes.some(node => node.kind === "Capability"));
  assert(temporal.exclusion.domainExcludedNodes > 0);
  assert.deepEqual(bytes(root), before);
});

test("legacy 0.18 snapshots remain verified historical evidence without invented analysis currentness", async t => {
  const { root, storage } = await fixture(t, { legacy: true }), original = (await readWorldModelForDiscovery({ root })).snapshot;
  assert.equal(storage.directory, ".head");
  assert.equal(original.protocol.name, "head-agent-core-world-model");
  const hybrid = structuredClone(original);
  delete hybrid.analysisBasis; delete hybrid.domainBases; delete hybrid.worldModelId; delete hybrid.worldModelHash;
  hybrid.protocol.version = "0.18.0";
  hybrid.worldModelHash = hash(hybrid); hybrid.worldModelId = `world-model-${hybrid.worldModelHash.slice(0, 24)}`;
  await assert.rejects(() => readWorldModelForDiscovery({ root, storeAdapter: retainedStore(hybrid) }),
    { code: "WORLD_MODEL_ANALYSIS_BASIS_MISMATCH" });
  const legacy = structuredClone(original);
  // Build historical relation identities with the existing 0.15 producer. Merely
  // relabelling a new 0.16 graph leaves an incoherent retained analysis basis.
  const projectionArgs = { storage, projectRoot: root, projectId: original.projectId,
    currentProductModelId: original.productModel.productModelId };
  const projections = {};
  for (const [key, module, loader] of [
    ["onboardingProjection", "onboarding-projection", "loadOnboardingGraphProjection"],
    ["productPolicyProjection", "product-policy-projection", "loadProductPolicyGraphProjection"],
    ["featureMappingProjection", "feature-mapping-projection", "loadFeatureMappingProjection"],
    ["changeSetProjection", "change-set-projection", "loadChangeSetProjection"],
    ["documentChangeProjection", "document-change-projection", "loadDocumentChangeProjection"],
    ["observationProjection", "observation-projection", "loadObservationProjection"],
    ["productOperatingProjection", "product-operating-projection", "loadProductOperatingProjection"],
    ["releaseObservationProjection", "release-observation-projection", "loadReleaseObservationProjection"],
  ]) projections[key] = (await import(`../scripts/lib/${module}.mjs`))[loader](projectionArgs);
  legacy.temporalProvenanceGraph = buildTemporalProvenanceGraph({ ...original, ...projections, storage });
  assert.equal(legacy.temporalProvenanceGraph.protocol.version, "0.15.0");
  assert.equal(Object.hasOwn(legacy.temporalProvenanceGraph, "relationAnalysisBasis"), false);
  delete legacy.analysisBasis; delete legacy.domainBases; delete legacy.worldModelId; delete legacy.worldModelHash;
  legacy.protocol.version = "0.18.0";
  legacy.worldModelHash = hash(legacy); legacy.worldModelId = `world-model-${legacy.worldModelHash.slice(0, 24)}`;
  const storeAdapter = retainedStore(legacy);
  const before = bytes(root), retained = JSON.stringify(legacy);
  assert.equal((await readWorldModelForDiscovery({ root, storeAdapter })).snapshot.worldModelId, legacy.worldModelId);
  const scoped = (await inspectWorldDomainFreshness({ root, storeAdapter, domains: ["code"] }));
  assert.equal(scoped.freshness.domains.code.status, "unknown");
  assert.equal((await queryWorldModel({ root, storeAdapter, query: "relay" })).fallback, "original-source");
  const tampered = structuredClone(legacy); tampered.productPolicyProjection.projectionInputHash = "f".repeat(64);
  delete tampered.worldModelId; delete tampered.worldModelHash;
  tampered.worldModelHash = hash(tampered); tampered.worldModelId = `world-model-${tampered.worldModelHash.slice(0, 24)}`;
  (await assert.rejects(async () => (await readWorldModelForDiscovery({ root, storeAdapter: retainedStore(tampered) })), { code: "PRODUCT_POLICY_TEMPORAL_IDENTITY_MISMATCH" }));
  assert.equal(JSON.stringify(legacy), retained);
  assert.deepEqual(bytes(root), before);
});

test("mixed traversal filters stale bridge BEFORE expansion, retains exact identity, and avoids unsupported remote adapter", async t => {
  const { root, storage } = await fixture(t), snapshot = (await readWorldModelForDiscovery({ root })).snapshot;
  const productModel = normalizeProductModelDocument({ schemaVersion: 1, featureGroups: [],
    capabilities: [{ key: "relay", name: "Relay", description: "Forward messages" }], features: [], requirements: [], constraints: [], decisions: [] });
  const graph = buildTemporalProvenanceGraph({ projectId: snapshot.projectId, files: snapshot.files, productModel });
  const file = graph.nodes.find(node => node.kind === "File" && node.path === "src/main.mjs");
  const product = graph.nodes.find(node => node.kind === "Capability");
  // Repository CONTAINS is a genuine existing mixed-domain bridge to Product.
  const repository = graph.nodes.find(node => node.kind === "Repository");
  const domainFreshness = { code: { status: "current" }, product: { status: "stale" }, git: { status: "current" },
    runtime: { status: "stale" }, observations: { status: "current" } };
  const eligibility = buildWorldTraversalEligibility({ ...snapshot, temporalProvenanceGraph: graph }, domainFreshness);
  assert(!eligibility.nodeIds.includes(product.nodeId));
  const query = { anchorIds: [repository.nodeId], expectedGraphSnapshotId: graph.graphSnapshotId, depth: 3, maxNodes: 100, eligibility };
  const before = JSON.stringify(graph);
  const result = queryTemporalProvenanceGraph(graph, query);
  assert(result.nodes.some(node => node.nodeId === file.nodeId));
  assert(!result.nodes.some(node => node.nodeId === product.nodeId));
  assert(result.exclusion.domainExcludedEdges > 0);
  assert.equal(result.graphSnapshotId, graph.graphSnapshotId); assert.equal(result.graphSnapshotHash, graph.graphSnapshotHash);
  assert.throws(() => queryTemporalProvenanceGraph(graph, { ...query, expectedGraphSnapshotId: "graph-snapshot-stale" }), { code: "TEMPORAL_GRAPH_SNAPSHOT_MISMATCH" });
  assert.throws(() => queryTemporalProvenanceGraph(graph, { ...query, eligibility: { ...eligibility, graphSnapshotHash: "f".repeat(64) } }), { code: "TEMPORAL_ELIGIBILITY_SNAPSHOT_MISMATCH" });
  let remoteCalls = 0;
  const adapter = new Proxy({}, { get() { remoteCalls++; throw Error("unsupported remote must not be invoked"); } });
  const projected = (await queryGraphProjection({ projectRoot: root, graph, adapter, query }));
  assert.equal(remoteCalls, 0); assert.equal(projected.diagnostics.executionMode, "embedded-domain-eligibility-fallback");
  assert.deepEqual(projected.result, result); assert.equal(JSON.stringify(graph), before);
});

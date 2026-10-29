#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeProject as initializeCoreProject } from "./lib/head-core.mjs";
import { compileContext } from "./lib/context-compiler.mjs";
import { onboardingCanonicalJson, onboardingDigest, verifyOnboardingState } from "./lib/onboarding-contract.mjs";
import { inspectOnboarding, readOnboardingCandidateSet, reviewOnboarding, startOnboarding } from "./lib/onboarding.mjs";
import { verifyOnboardingCandidateSetForProjection, verifyOnboardingReviewDecisionForProjection } from "./lib/onboarding-projection.mjs";
import { normalizeProductModelDocument } from "./lib/product-model.mjs";
import { verifyTemporalProvenanceGraph } from "./lib/temporal-provenance.mjs";
import { inspectWorldModel, queryWorldTemporalGraph } from "./lib/world-model.mjs";
import { dispatch as dispatchMcp } from "./mcp-server.mjs";
import { runCommand } from "./head.mjs";
import { publicToolName } from "./lib/lode-artifact-composition.mjs";
import { formatForVerifiedOwner } from "./lib/project-storage-format.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots = [];

// Retain the actual layout returned by successful fixture initialization. Later
// corruption tests must inspect that same storage, not rediscover or repair it.
const fixtureDirectories = new Map();
const fixtureStorages = new Map();
function initializeProject(options) {
  const initialized = initializeCoreProject(options);
  fixtureDirectories.set(initialized.storage.projectRoot, initialized.storage.directory);
  fixtureStorages.set(initialized.storage.projectRoot, initialized.storage);
  return initialized;
}
function fixtureStorage(root) {
  const storage = fixtureStorages.get(fs.realpathSync(root));
  assert(storage, "Verification fixture has not been initialized.");
  return storage;
}
function fixtureDirectory(root) {
  const directory = fixtureDirectories.get(fs.realpathSync(root));
  assert(directory, "Verification fixture has not been initialized.");
  return directory;
}

function temporaryProject(label) {
  const root = fs.mkdtempSync(path.join(pluginRoot, `.qa-onboarding-${label}-`));
  roots.push(root);
  return root;
}

function write(root, relative, content) {
  const file = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function filesUnder(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile()) files.push(candidate);
    }
  };
  visit(root);
  return files.sort();
}

async function rejectsCode(action, code) {
  await assert.rejects(action, (error) => error?.code === code);
}

function productDocument({ suffix = "" } = {}) {
  return {
    schemaVersion: 1,
    featureGroups: [{ key: `group:core${suffix}`, name: `Core${suffix}`, description: "Primary product grouping", parentFeatureGroupKeys: [] }],
    capabilities: [{ key: `capability:serve${suffix}`, name: `Serve${suffix}`, description: "Serve a verified request" }],
    features: [{
      key: `feature:serve${suffix}`,
      name: `Serve${suffix}`,
      description: "Serve one request",
      featureGroupKeys: [`group:core${suffix}`],
      capabilityKeys: [`capability:serve${suffix}`],
      governedBy: [],
    }],
    requirements: [],
    constraints: [],
    decisions: [],
  };
}

async function semanticProductProposal(root, relativePath, document = productDocument()) {
  const world = (await inspectWorldModel({ root }));
  assert.equal(world.status, "current");
  const file = world.snapshot.files.find((item) => item.path === relativePath);
  assert.ok(file);
  const symbol = file.symbols[0] || null;
  const evidence = {
    path: relativePath,
    line: symbol?.line || 1,
    contentDigest: file.digest,
    ...(symbol ? { symbol: { name: symbol.name, kind: symbol.kind, line: symbol.line } } : {}),
  };
  const arrays = {
    FeatureGroup: "featureGroups",
    Capability: "capabilities",
    Feature: "features",
    Requirement: "requirements",
    Constraint: "constraints",
    Decision: "decisions",
  };
  return {
    schemaVersion: 1,
    sourceSnapshotId: world.snapshot.temporalProvenanceGraph.sourceSnapshotId,
    candidates: Object.entries(arrays).flatMap(([productKind, field]) => document[field].map((proposedEntity) => ({
      productKind,
      proposedEntity,
      evidence: [evidence],
      explanation: "Fresh HEAD proposes this product concept from current repository evidence; Core only validates and gates it.",
      confidence: 0.8,
    }))),
  };
}

async function verifyExistingProjectPromotion() {
  const root = temporaryProject("existing");
  write(root, "README.md", "# Request Service\n\nObserved repository documentation.\n");
  write(root, "src/service.mjs", "export function serveRequest(value) { return value; }\nexport function closeWindow() { return true; }\nexport function configure_process_logging() { return true; }\n");
  write(root, "tests/service.test.mjs", "export function verifiesDelivery() { return true; }\n");
  write(root, ".generated-evidence/draft.md", "# Draft Internal Model\n\nThis is intentionally outside the selected product source scope.\n");
  initializeProject({ root, pluginRoot, runtimes: ["codex", "opencode"] });
  const initial = (await inspectOnboarding({ root }));
  assert.equal(initial.status, "initialized");
  assert.equal(initial.sessionRecord.identityBoundary, "project-scoped-lode-session-not-provider-conversation");

  const discovery = await startOnboarding({ root, mode: "existing", sourceScope: { excludeRoots: [".generated-evidence"] } });
  assert.equal(discovery.status, "awaiting_onboarding_evidence");
  assert.equal(discovery.candidateSet.candidates.length, 0);
  assert.match(discovery.candidateSet.unknowns[0].statement, /semantic product candidates are required/i);
  const driftedProposal = (await semanticProductProposal(root, "src/service.mjs"));
  driftedProposal.candidates[0].evidence[0].contentDigest = "0".repeat(64);
  await rejectsCode(async () => (await startOnboarding({ root, mode: "existing", semanticProposal: driftedProposal })), "ONBOARDING_SEMANTIC_EVIDENCE_DRIFT");
  const started = await startOnboarding({
    root,
    mode: "existing",
    semanticProposal: (await semanticProductProposal(root, "src/service.mjs")),
  });
  assert.equal(started.status, "awaiting_onboarding_review");
  assert.equal(started.storageSelection.mode, "local");
  assert.deepEqual(started.sourceScope.excludeRoots, [".generated-evidence"]);
  assert.deepEqual((await runCommand(["source-scope-status", root])).sourceScope.excludeRoots, [".generated-evidence"]);
  assert.equal(started.candidateSet.candidates.some((candidate) => candidate.productKind === "FeatureGroup"), true);
  assert.equal(started.candidateSet.candidates.some((candidate) => candidate.productKind === "Capability"), true);
  assert.equal(started.candidateSet.candidates.some((candidate) => candidate.productKind === "Feature"), true);
  assert.equal(started.candidateSet.candidates.some((candidate) => candidate.productKind === "Capability" && candidate.proposedEntity.name === "Serve"), true);
  assert.equal(started.candidateSet.candidates.filter((candidate) => candidate.productKind === "Feature").every((candidate) => candidate.proposedEntity.featureGroupKeys.length === 1), true);
  assert.equal(started.candidateSet.candidates.every((candidate) => candidate.origin === formatForVerifiedOwner(fixtureStorage(root)).value("fresh-head-semantic-proposal")), true);
  assert.equal(started.candidateSet.evidence.every((record) => record.contentDigest && record.path === "src/service.mjs"), true);
  assert.equal(started.candidateSet.candidates.every((candidate) => candidate.instructionAuthority === false && candidate.promotionAuthority === false), true);
  assert.equal(normalizeProductModelDocument().features.length, 0);
  const candidateGraph = (await inspectWorldModel({ root }));
  assert.equal(candidateGraph.status, "current");
  assert.equal(candidateGraph.snapshot.files.some((file) => file.path.startsWith(".generated-evidence/")), false);
  assert.deepEqual(candidateGraph.snapshot.repositoryScan.sourceScope.excludeRoots, [".generated-evidence"]);
  assert.equal(candidateGraph.snapshot.temporalProvenanceGraph.summary.onboardingCandidateSetCount, 2);
  assert.equal(candidateGraph.snapshot.temporalProvenanceGraph.summary.onboardingCandidateCount, started.candidateSet.candidates.length);
  assert.equal(candidateGraph.snapshot.temporalProvenanceGraph.summary.onboardingReviewDecisionCount, 0);
  const candidateId = started.candidateSet.candidates[0].candidateId;
  const hiddenCandidate = (await queryWorldTemporalGraph({
    root,
    query: candidateId,
    kinds: ["OnboardingProductCandidate"],
    depth: 0,
  }));
  assert.equal(hiddenCandidate.nodes.length, 0);
  assert.equal(hiddenCandidate.exclusion.unreviewedCandidatesExcluded > 0, true);
  const explicitCandidate = await runCommand([
    "world-temporal",
    root,
    "--query",
    candidateId,
    "--kind",
    "OnboardingProductCandidate,OnboardingEvidence,ProductConceptReference",
    "--include-candidates",
    "true",
    "--depth",
    "1",
  ]);
  assert.equal(explicitCandidate.nodes.some((node) => node.nodeId === candidateId), true);
  assert.equal(explicitCandidate.edges.some((edge) => edge.type === "SUPPORTED_BY"), true);
  const mcpCandidate = await dispatchMcp({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: publicToolName("head_temporal_graph"),
      arguments: {
        project_root: root,
        query: candidateId,
        kinds: ["OnboardingProductCandidate"],
        include_unreviewed_candidates: true,
        depth: 0,
      },
    },
  });
  assert.equal(mcpCandidate.result.structuredContent.nodes[0].nodeId, candidateId);

  const reread = readOnboardingCandidateSet({ root, candidateSetId: started.candidateSet.candidateSetId });
  assert.equal(reread.candidateSet.candidateSetHash, started.candidateSet.candidateSetHash);
  const sourceFile = path.join(root, "src", "service.mjs");
  const sourceBytes = fs.readFileSync(sourceFile, "utf8");
  fs.appendFileSync(sourceFile, "export const drift = () => true;\n");
  await rejectsCode(async () => (await reviewOnboarding({
    root,
    candidateSetId: started.candidateSet.candidateSetId,
    disposition: "accept-all",
    rationale: "Stale source evidence must not be promoted.",
  })), "ONBOARDING_SOURCE_DRIFT");
  fs.writeFileSync(sourceFile, sourceBytes);
  const accepted = await reviewOnboarding({
    root,
    candidateSetId: started.candidateSet.candidateSetId,
    disposition: "accept-all",
    rationale: "Adopt this evidence-linked bootstrap batch as the initial Product Canon.",
  });
  assert.equal(accepted.status, "onboarding_ready");
  assert.equal(accepted.reviewDecision.decisionScope, "product-canon-bootstrap");
  assert.equal(accepted.reviewDecision.promotionAuthority, true);
  assert.equal(accepted.productModel.features.length > 0, true);
  const ready = (await inspectOnboarding({ root }));
  assert.equal(ready.status, "ready");
  assert.equal(ready.worldModel.status, "current");
  assert.equal(ready.productModel.productModelId, accepted.productModel.productModelId);
  assert.equal(ready.worldModel.sourceSnapshotId, accepted.worldModel.sourceSnapshotId);
  const promotedGraph = (await inspectWorldModel({ root })).snapshot.temporalProvenanceGraph;
  assert.equal(promotedGraph.summary.onboardingReviewDecisionCount, 1);
  assert.equal(promotedGraph.summary.productModelRevisionReceiptCount, 2);
  assert.equal(promotedGraph.edges.some((edge) => edge.type === "REVIEWED_BY" && edge.to === accepted.reviewDecision.reviewDecisionId), true);
  assert.equal(promotedGraph.edges.some((edge) => edge.type === "PRODUCES" && edge.to === accepted.productModel.productModelId), true);
  assert.equal(promotedGraph.edges.some((edge) => edge.type === "PROMOTED_FROM"), true);
  assert.equal(promotedGraph.nodes.find((node) => node.nodeId === candidateId).instructionAuthority, false);
  assert.equal(verifyTemporalProvenanceGraph(promotedGraph).temporalGraphId, promotedGraph.temporalGraphId);
  const tamperedGraph = structuredClone(promotedGraph);
  tamperedGraph.nodes.find((node) => node.kind === "OnboardingReviewDecision").disposition = "reject";
  assert.throws(() => verifyTemporalProvenanceGraph(tamperedGraph), { code: "TEMPORAL_GRAPH_DIGEST_MISMATCH" });
  const reviewTraversal = (await queryWorldTemporalGraph({
    root,
    query: accepted.reviewDecision.reviewDecisionId,
    kinds: ["OnboardingReviewDecision", "ProductModelRevision"],
    relations: ["PRODUCES", "PARENT_OF"],
    depth: 1,
  }));
  assert.equal(reviewTraversal.nodes.some((node) => node.kind === "OnboardingReviewDecision"), true);
  assert.equal(reviewTraversal.nodes.some((node) => node.kind === "ProductModelRevision"), true);
  const capsule = (await compileContext({ root, task: "Explain the accepted product capability.", budget: 32_768, persist: false })).capsule;
  assert.equal(capsule.productContext.length > 0, true);
  assert.equal(capsule.productContext.every((item) => item.trustBoundary === "derived-projection-of-user-owned-product-canon"), true);
  const anchoredProductContext = (await compileContext({
    root,
    task: "Resolve opaque ticket omega without relying on vocabulary overlap.",
    evidenceNeeds: [{ id: "accepted-capability", kind: "product-context", entityKeys: ["capability:serve"] }],
  })).capsule;
  assert.deepEqual(anchoredProductContext.evidenceGaps, []);
  assert.equal(anchoredProductContext.productContext.some((item) => item.entities.some((entity) => entity.semantic?.key === "capability:serve" || entity.key === "capability:serve")), true);
  const multipleProductKeys = (await compileContext({
    root,
    task: "Resolve opaque ticket sigma without relying on vocabulary overlap.",
    evidenceNeeds: [{
      id: "accepted-product-entities",
      kind: "product-context",
      entityKeys: ["capability:serve", "feature:serve"],
      minimumItems: 2,
    }],
  })).capsule;
  assert.deepEqual(multipleProductKeys.evidenceGaps, []);
  const includedKeys = new Set(multipleProductKeys.productContext.flatMap(item => item.entities.map(entity => entity.semantic?.key || entity.key)));
  assert.equal(includedKeys.has("capability:serve") && includedKeys.has("feature:serve"), true);
  const previousRevision = JSON.parse(fs.readFileSync(path.join(
    root,
    fixtureDirectory(root),
    "onboarding",
    "product-model-revisions",
    `${started.state.productModelId}.json`,
  ), "utf8"));
  assert.equal(previousRevision.document.features.length, 0);

  const candidateFile = reread.file;
  const original = fs.readFileSync(candidateFile, "utf8");
  const tampered = JSON.parse(original);
  tampered.candidates[0].confidence = 0;
  fs.writeFileSync(candidateFile, `${JSON.stringify(tampered, null, 2)}\n`);
  (await assert.rejects(async () => (await inspectOnboarding({ root })), { code: "ONBOARDING_CANDIDATE_SET_DIGEST_MISMATCH" }));
  fs.writeFileSync(candidateFile, original);
  assert.equal((await inspectOnboarding({ root })).status, "ready");
  const revisionFile = path.join(
    root,
    fixtureDirectory(root),
    "onboarding",
    "product-model-revisions",
    `${accepted.productModel.productModelId}.json`,
  );
  const revisionBytes = fs.readFileSync(revisionFile, "utf8");
  const tamperedRevision = JSON.parse(revisionBytes);
  tamperedRevision.document.features[0].name = "Tampered";
  fs.writeFileSync(revisionFile, `${JSON.stringify(tamperedRevision, null, 2)}\n`);
  (await assert.rejects(async () => (await inspectOnboarding({ root })), { code: "PRODUCT_MODEL_REVISION_DIGEST_MISMATCH" }));
  fs.writeFileSync(revisionFile, revisionBytes);
  assert.equal((await inspectOnboarding({ root })).status, "ready");
  fs.appendFileSync(sourceFile, "export const laterChange = true;\n");
  const driftedReady = (await inspectOnboarding({ root }));
  assert.equal(driftedReady.status, "ready_world_changed");
  assert.equal(driftedReady.worldModel.status, "stale");
  fs.writeFileSync(sourceFile, sourceBytes);
  assert.equal((await inspectOnboarding({ root })).status, "ready");
  return { candidateSetId: started.candidateSet.candidateSetId, reviewDecisionId: accepted.reviewDecision.reviewDecisionId };
}

async function verifyNewProjectBriefAndRevision() {
  const root = temporaryProject("brief");
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const brief = { schemaVersion: 1, name: "Brief Product", summary: "User-owned bootstrap brief", ...productDocument({ suffix: "-brief" }) };
  const started = await startOnboarding({ root, mode: "new", brief });
  assert.equal(started.status, "awaiting_onboarding_review");
  assert.equal(started.candidateSet.candidates.every((candidate) => candidate.origin === "user-owned-brief-candidate"), true);
  const capability = started.candidateSet.candidates.find((candidate) => candidate.productKind === "Capability");
  const revisedEntity = { ...capability.proposedEntity, name: "Serve Reviewed Request" };
  const revised = await reviewOnboarding({
    root,
    candidateSetId: started.candidateSet.candidateSetId,
    disposition: "revise",
    userEdits: [{ candidateId: capability.candidateId, entity: revisedEntity }],
    rationale: "Use the reviewed product wording before promotion.",
  });
  assert.equal(revised.status, "onboarding_revision_awaiting_review");
  assert.notEqual(revised.candidateSet.candidateSetId, started.candidateSet.candidateSetId);
  assert.equal(revised.candidateSet.parentCandidateSetIds.includes(started.candidateSet.candidateSetId), true);
  assert.equal(revised.candidateSet.producerReviewDecisionId, revised.reviewDecision.reviewDecisionId);
  const awaitingReview = (await inspectOnboarding({ root }));
  assert.equal(awaitingReview.status, "awaiting_review");
  assert.equal(awaitingReview.reviewLineage.producerReviewDecisionId, revised.reviewDecision.reviewDecisionId);
  assert.equal(awaitingReview.reviewLineage.latestReviewDecisionId, revised.reviewDecision.reviewDecisionId);
  assert.equal(revised.candidateSet.candidates.find((candidate) => candidate.productKind === "Capability").name, undefined);
  assert.equal(revised.candidateSet.candidates.find((candidate) => candidate.productKind === "Capability").proposedEntity.name, "Serve Reviewed Request");
  const accepted = await reviewOnboarding({
    root,
    candidateSetId: revised.candidateSet.candidateSetId,
    disposition: "accept-all",
    rationale: "Accept the revised brief batch.",
  });
  assert.equal(accepted.productModel.capabilities[0].name, "Serve Reviewed Request");
  const ready = (await inspectOnboarding({ root }));
  assert.equal(ready.status, "ready");
  assert.equal(ready.reviewLineage.producerReviewDecisionId, revised.reviewDecision.reviewDecisionId);
  assert.equal(ready.reviewLineage.latestReviewDecisionId, accepted.reviewDecision.reviewDecisionId);
  assert.notEqual(ready.reviewLineage.producerReviewDecisionId, ready.reviewLineage.latestReviewDecisionId);
  assert.equal(accepted.reviewDecision.protocol.version, "0.1.0");
  assert.equal(verifyOnboardingReviewDecisionForProjection(accepted.reviewDecision, revised.candidateSet, ready.state.projectId).reviewDecisionId,
    accepted.reviewDecision.reviewDecisionId);
  const legacyState = structuredClone(ready.state);
  legacyState.protocol.version = "0.1.0";
  legacyState.reviewDecisionId = legacyState.latestReviewDecisionId;
  delete legacyState.latestReviewDecisionId;
  delete legacyState.pointerHash;
  legacyState.pointerHash = onboardingDigest(onboardingCanonicalJson(legacyState));
  const legacyInputBefore = structuredClone(legacyState);
  const fixtureBytesBefore = Object.fromEntries(filesUnder(root).map((file) => [path.relative(root, file), fs.readFileSync(file).toString("base64")]));
  assert.throws(() => verifyOnboardingState(legacyState, { storage: fixtureStorage(root) }), { code: "ONBOARDING_LEGACY_STATE_REQUIRES_MIGRATOR" });
  assert.deepEqual(legacyState, legacyInputBefore);
  assert.deepEqual(Object.fromEntries(filesUnder(root).map((file) => [path.relative(root, file), fs.readFileSync(file).toString("base64")])),
    fixtureBytesBefore, "legacy state verification is read-only and writes no files");
  const graph = (await inspectWorldModel({ root })).snapshot.temporalProvenanceGraph;
  assert.equal(graph.edges.some((edge) => edge.type === "PRODUCES"
    && edge.from === revised.reviewDecision.reviewDecisionId
    && edge.to === revised.candidateSet.candidateSetId), true);
  const guide = await dispatchMcp({
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: { name: publicToolName("head_onboarding_guide"), arguments: { project_root: root } },
  });
  assert.equal(guide.result.structuredContent.status, "ready");
  const producerFile = path.join(root, fixtureDirectory(root), "onboarding", "review-decisions", `${revised.reviewDecision.reviewDecisionId}.json`);
  const producerBytes = fs.readFileSync(producerFile, "utf8");
  fs.rmSync(producerFile);
  (await assert.rejects(async () => (await inspectOnboarding({ root })), { code: "ONBOARDING_REVIEW_NOT_FOUND" }));
  fs.writeFileSync(producerFile, producerBytes);
  assert.equal((await inspectOnboarding({ root })).status, "ready");
  return { initialCandidateSetId: started.candidateSet.candidateSetId, revisedCandidateSetId: revised.candidateSet.candidateSetId };
}

async function verifyEmptyEvidenceAndAddition() {
  const root = temporaryProject("empty");
  initializeProject({ root, pluginRoot, runtimes: ["opencode"] });
  const started = await startOnboarding({ root, mode: "existing" });
  assert.equal(started.status, "awaiting_onboarding_evidence");
  assert.equal(started.candidateSet.candidates.length, 0);
  assert.equal(started.candidateSet.unknowns.length > 0, true);
  await rejectsCode(async () => (await reviewOnboarding({
    root,
    candidateSetId: started.candidateSet.candidateSetId,
    disposition: "accept-all",
    rationale: "This must not accept empty evidence.",
  })), "ONBOARDING_EVIDENCE_REQUIRED");
  const revised = await reviewOnboarding({
    root,
    candidateSetId: started.candidateSet.candidateSetId,
    disposition: "revise",
    addedEntities: [{
      kind: "Feature",
      entity: {
        key: "feature:user-seeded",
        name: "User Seeded Feature",
        description: "Explicitly proposed during onboarding review",
        featureGroupKeys: [],
        capabilityKeys: [],
        governedBy: [],
      },
    }],
    rationale: "Supply the missing user-owned product evidence.",
  });
  assert.equal(revised.candidateSet.candidates.length, 1);
  assert.equal(revised.candidateSet.candidates[0].promotionAuthority, false);
  const accepted = await reviewOnboarding({
    root,
    candidateSetId: revised.candidateSet.candidateSetId,
    disposition: "accept-all",
    rationale: "Adopt the explicitly reviewed seed.",
  });
  assert.equal(accepted.productModel.features[0].key, "feature:user-seeded");
  assert.equal((await inspectOnboarding({ root })).status, "ready");
}

async function verifySemanticNeutralityAndRetiredCandidateProtocols() {
  const root = temporaryProject("semantic-neutrality");
  write(root, "src/storage.mjs", [
    "export function writeFileEntry() {}",
    "export function saveFileEntry() {}",
    "export function persistFileEntry() {}",
    "export function exportFileEntry() {}",
    "",
  ].join("\n"));
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const awaitingEvidence = await startOnboarding({ root, mode: "existing" });
  assert.equal(awaitingEvidence.status, "awaiting_onboarding_evidence");
  assert.equal(awaitingEvidence.candidateSet.candidates.length, 0);
  assert.equal(awaitingEvidence.candidateSet.unknowns.some((item) => /semantic product candidates/i.test(item.statement)), true);

  const current = await startOnboarding({ root, semanticProposal: (await semanticProductProposal(root, "src/storage.mjs")) });
  const retired = structuredClone(current.candidateSet);
  retired.protocol.version = "0.3.0";
  delete retired.candidateSetId;
  delete retired.candidateSetHash;
  retired.candidateSetHash = onboardingDigest(onboardingCanonicalJson(retired));
  retired.candidateSetId = `onboarding-candidates-${retired.candidateSetHash.slice(0, 24)}`;
  assert.throws(
    () => verifyOnboardingCandidateSetForProjection(retired, retired.projectId, fixtureStorage(root)),
    { code: "INVALID_ONBOARDING_PROJECTION_CANDIDATE_SET" },
  );
}

async function verifySuccessorSelectionAndRejection() {
  const selectionRoot = temporaryProject("successor-selection");
  initializeProject({ root: selectionRoot, pluginRoot, runtimes: ["codex"] });
  const selectionStarted = await startOnboarding({ root: selectionRoot, mode: "new", brief: {
    schemaVersion: 1,
    name: "Successor Selection",
    summary: "Exercise phase-aware successor review lineage.",
    ...productDocument({ suffix: "-successor-selection" }),
  } });
  const selectionCapability = selectionStarted.candidateSet.candidates.find((candidate) => candidate.productKind === "Capability");
  const selectionRevised = await reviewOnboarding({
    root: selectionRoot,
    candidateSetId: selectionStarted.candidateSet.candidateSetId,
    disposition: "revise",
    userEdits: [{ candidateId: selectionCapability.candidateId, entity: { ...selectionCapability.proposedEntity, name: "Reviewed Selection Capability" } }],
    rationale: "Create a successor before selecting one reviewed concept.",
  });
  const revisedCapability = selectionRevised.candidateSet.candidates.find((candidate) => candidate.productKind === "Capability");
  const selected = await reviewOnboarding({
    root: selectionRoot,
    candidateSetId: selectionRevised.candidateSet.candidateSetId,
    disposition: "accept-selection",
    acceptedCandidateIds: [revisedCapability.candidateId],
    rationale: "Accept only the reviewed successor capability.",
  });
  assert.equal(selected.productModel.capabilities[0].name, "Reviewed Selection Capability");
  assert.equal((await inspectOnboarding({ root: selectionRoot })).status, "ready");

  const rejectionRoot = temporaryProject("successor-rejection");
  initializeProject({ root: rejectionRoot, pluginRoot, runtimes: ["codex"] });
  const rejectionStarted = await startOnboarding({ root: rejectionRoot, mode: "new", brief: {
    schemaVersion: 1,
    name: "Successor Rejection",
    summary: "Exercise rejection after revision.",
    ...productDocument({ suffix: "-successor-rejection" }),
  } });
  const rejectionCapability = rejectionStarted.candidateSet.candidates.find((candidate) => candidate.productKind === "Capability");
  const rejectionRevised = await reviewOnboarding({
    root: rejectionRoot,
    candidateSetId: rejectionStarted.candidateSet.candidateSetId,
    disposition: "revise",
    userEdits: [{ candidateId: rejectionCapability.candidateId, entity: { ...rejectionCapability.proposedEntity, name: "Still Not Canon" } }],
    rationale: "Create a successor that will be rejected separately.",
  });
  await reviewOnboarding({
    root: rejectionRoot,
    candidateSetId: rejectionRevised.candidateSet.candidateSetId,
    disposition: "reject",
    rationale: "Reject the reviewed successor without mutating Product Canon.",
  });
  const rejected = (await inspectOnboarding({ root: rejectionRoot }));
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.reviewLineage.producerReviewDecisionId, rejectionRevised.reviewDecision.reviewDecisionId);
  assert.notEqual(rejected.reviewLineage.producerReviewDecisionId, rejected.reviewLineage.latestReviewDecisionId);
}

async function verifyRejection() {
  const root = temporaryProject("reject");
  write(root, "src/reject.mjs", "export function rejectMe() {}\n");
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  await startOnboarding({ root });
  const started = await startOnboarding({ root, semanticProposal: (await semanticProductProposal(root, "src/reject.mjs")) });
  const rejected = await reviewOnboarding({
    root,
    candidateSetId: started.candidateSet.candidateSetId,
    disposition: "reject",
    rationale: "Observed implementation does not represent intended product meaning.",
  });
  assert.equal(rejected.productCanonChanged, false);
  const status = (await inspectOnboarding({ root }));
  assert.equal(status.status, "rejected");
  assert.equal(status.productModel.features.length, 0);
  const restarted = await startOnboarding({ root, semanticProposal: (await semanticProductProposal(root, "src/reject.mjs")) });
  assert.notEqual(restarted.candidateSet.candidateSetId, started.candidateSet.candidateSetId);
  assert.deepEqual(restarted.candidateSet.parentCandidateSetIds, [started.candidateSet.candidateSetId]);
  const capability = restarted.candidateSet.candidates.find((candidate) => candidate.productKind === "Capability");
  const selected = await reviewOnboarding({
    root,
    candidateSetId: restarted.candidateSet.candidateSetId,
    disposition: "accept-selection",
    acceptedCandidateIds: [capability.candidateId],
    rationale: "Adopt only the reviewed capability; reject the inferred feature mapping.",
  });
  assert.equal(selected.productModel.capabilities.length, 1);
  assert.equal(selected.productModel.features.length, 0);
  const graph = (await inspectWorldModel({ root })).snapshot.temporalProvenanceGraph;
  assert.equal(graph.summary.onboardingReviewDecisionCount, 2);
  assert.equal(graph.summary.onboardingAcceptedCandidateCount, 1);
  assert.equal(graph.summary.onboardingRejectedCandidateCount > 0, true);
  assert.equal(graph.edges.some((edge) => edge.type === "ACCEPTED_BY"), true);
  assert.equal(graph.edges.some((edge) => edge.type === "REJECTED_BY"), true);
}

async function verifyExistingCanonSkip() {
  const root = temporaryProject("canon");
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  write(root, `${fixtureDirectory(root)}/context/product-model.json`, `${JSON.stringify(productDocument({ suffix: "-existing" }), null, 2)}\n`);
  const started = await startOnboarding({ root });
  assert.equal(started.status, "ready_existing_product_canon");
  assert.equal(started.state.candidateSetId, null);
  assert.equal((await inspectOnboarding({ root })).status, "ready");
}

async function verifyCandidateBounds() {
  const root = temporaryProject("bounds");
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const capabilities = Array.from({ length: 201 }, (_, index) => ({
    key: `capability:bounded-${String(index).padStart(3, "0")}`,
    name: `Bounded ${index}`,
    description: "Candidate bound fixture",
  }));
  await rejectsCode(async () => (await startOnboarding({
    root,
    mode: "new",
    brief: {
      schemaVersion: 1,
      name: "Oversized brief",
      summary: "Must fail the candidate bound.",
      featureGroups: [],
      capabilities,
      features: [],
      requirements: [],
      constraints: [],
      decisions: [],
    },
  })), "ONBOARDING_CANDIDATE_SET_LIMIT");
  assert.equal((await inspectOnboarding({ root })).status, "initialized");
}

async function verifyGraphDbSelectionAndSecretRejection() {
  const rejectedRoot = temporaryProject("secret");
  initializeProject({ root: rejectedRoot, pluginRoot, runtimes: ["codex"] });
  await rejectsCode(async () => (await startOnboarding({
    root: rejectedRoot,
    storage: {
      mode: "graphdb",
      endpoint: "https://graph.example.test",
      database: "head",
      secretReferenceNames: { username: "HEAD_GRAPHDB_USERNAME", password: "HEAD_GRAPHDB_PASSWORD" },
      password: "plaintext-secret",
    },
  })), "ONBOARDING_SECRET_VALUE_REJECTED");
  const rejectedContent = filesUnder(rejectedRoot).map((file) => fs.readFileSync(file, "utf8")).join("\n");
  assert.equal(rejectedContent.includes("plaintext-secret"), false);

  const root = temporaryProject("graphdb");
  write(root, "src/graph.mjs", "export function traverseGraph() {}\n");
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const started = await startOnboarding({
    root,
    storage: {
      mode: "graphdb",
      endpoint: "https://graph.example.test",
      database: "head",
      secretReferenceNames: { username: "HEAD_GRAPHDB_USERNAME", password: "HEAD_GRAPHDB_PASSWORD" },
    },
  });
  assert.equal(started.storageSelection.graphdb.capabilityStatus, "pending-unverified-adapter");
  assert.equal(started.storageSelection.localFallback, true);
  assert.match(started.disclosure, /local materialization remains active/i);
  const content = filesUnder(root).map((file) => fs.readFileSync(file, "utf8")).join("\n");
  assert.equal(content.includes("plaintext-secret"), false);
}

async function verifyLegacyMigrationAndReadOnlyMcp() {
  const root = temporaryProject("migration");
  write(root, "src/legacy.mjs", "export function legacyFeature() {}\n");
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const initial = (await inspectOnboarding({ root }));
  const managedManifestFile = path.join(root, fixtureDirectory(root), "generated", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(managedManifestFile, "utf8"));
  manifest.managed = manifest.managed.filter((item) => (
    item.path !== `${fixtureDirectory(root)}/onboarding/current.json`
    && !item.path.startsWith(`${fixtureDirectory(root)}/onboarding/storage-selections/`)
    && !item.path.startsWith(`${fixtureDirectory(root)}/sessions/records/`)
  ));
  fs.writeFileSync(managedManifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.rmSync(path.join(root, fixtureDirectory(root), "onboarding"), { recursive: true, force: true });
  fs.rmSync(path.join(root, fixtureDirectory(root), "sessions", "records"), { recursive: true, force: true });
  fs.rmSync(path.join(root, fixtureDirectory(root), "context", "product-model.json"), { force: true });
  const migration = (await inspectOnboarding({ root }));
  assert.equal(migration.status, "migration_required");
  assert.equal(fs.existsSync(path.join(root, fixtureDirectory(root), "onboarding")), false);
  const started = await runCommand(["onboarding-start", root]);
  assert.equal(started.state.migration, "legacy-missing-state-v1");
  assert.equal(started.state.sessionId, initial.state.sessionId);
  const proposed = await startOnboarding({ root, semanticProposal: (await semanticProductProposal(root, "src/legacy.mjs")) });
  assert.equal((await runCommand(["onboarding-status", root])).state.candidateSetId, proposed.candidateSet.candidateSetId);
  const mcp = await dispatchMcp({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: publicToolName("head_onboarding_status"), arguments: { project_root: root } },
  });
  assert.equal(mcp.result.structuredContent.state.candidateSetId, proposed.candidateSet.candidateSetId);
  assert.equal(mcp.result.structuredContent.authority.candidates, "non-authoritative-until-review");
  const accepted = await reviewOnboarding({
    root,
    candidateSetId: proposed.candidateSet.candidateSetId,
    disposition: "accept-all",
    rationale: "Create Product Canon from the reviewed legacy-migration batch.",
  });
  assert.equal(accepted.status, "onboarding_ready");
  assert.equal(fs.existsSync(path.join(root, fixtureDirectory(root), "context", "product-model.json")), true);
}

try {
  const existing = await verifyExistingProjectPromotion();
  const brief = await verifyNewProjectBriefAndRevision();
  await verifyEmptyEvidenceAndAddition();
  await verifySemanticNeutralityAndRetiredCandidateProtocols();
  await verifySuccessorSelectionAndRejection();
  await verifyRejection();
  await verifyExistingCanonSkip();
  await verifyCandidateBounds();
  await verifyGraphDbSelectionAndSecretRejection();
  await verifyLegacyMigrationAndReadOnlyMcp();
  process.stdout.write(`${JSON.stringify({
    status: "verified",
    scenarios: [
      "existing-project-semantic-proposal-and-promotion",
      "post-ready-world-drift-disclosure",
      "new-project-brief-revision-and-promotion",
      "empty-evidence-user-seed",
      "helper-symbols-do-not-become-product-taxonomy",
      "retired-lexical-candidate-protocols-rejected",
      "successor-selection-and-phase-aware-ready-status",
      "successor-rejection-and-phase-aware-rejected-status",
      "successor-producer-review-missing-fail-closed",
      "candidate-rejection",
      "deterministic-restart-and-selection-acceptance",
      "candidate-review-promotion-temporal-projection",
      "candidate-traversal-opt-in-and-context-exclusion",
      "temporal-projection-tamper-detection",
      "pre-existing-canon-skip",
      "candidate-set-resource-bounds",
      "graphdb-pending-local-fallback-and-secret-rejection",
      "legacy-state-migration-and-read-only-mcp",
      "git-absent",
      "go-binary-absent-javascript-fallback",
    ],
    artifactEvidence: { ...existing, ...brief },
    authorityEffect: "only-explicit-onboarding-review-promotes-product-canon",
  }, null, 2)}\n`);
} finally {
  for (const root of roots.reverse()) fs.rmSync(root, { recursive: true, force: true });
}

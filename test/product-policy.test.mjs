import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { formatForVerifiedOwner } from "../scripts/lib/project-storage-format.mjs";
import { startOnboarding, reviewOnboarding } from "../scripts/lib/onboarding.mjs";
import { normalizeProductModelDocument, productModelDocument, readProductModelCanon } from "../scripts/lib/product-model.mjs";
import { inspectProductPolicyStatus, productPolicyCanonicalJson, proposeProductPolicy, readProductPolicyCandidate, reviewProductPolicy, verifyProductPolicyCandidate } from "../scripts/lib/product-policy.mjs";
import { withProjectMutationAsync } from "../scripts/lib/project-mutation-lock.mjs";
import { buildWorldModel, inspectWorldModel, queryWorldTemporalGraph } from "../scripts/lib/world-model.mjs";
import { traceGraphLineage } from "../scripts/lib/graph-lineage.mjs";
import { runCommand } from "../scripts/head.mjs";
import { dispatch, catalogTools as tools } from "../scripts/mcp-server.mjs";
import { recordSessionWorkEvidence, readSessionWorkContext } from "../scripts/lib/session-work-context.mjs";
import { queryProjectGraph } from "../scripts/lib/project-graph.mjs";
import { snapshot } from "./helpers/session-work-linkage-fixture.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "head-agent-policy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "service.mjs"), "export function serve() { return true; }\n");
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  const layout = formatForVerifiedOwner(storage);
  const started = await startOnboarding({ root, mode: "new", brief: {
    schemaVersion: 1,
    name: "Generic service",
    summary: "Provide one generic capability.",
    featureGroups: [{ key: "platform", name: "Platform", parentFeatureGroupKeys: [] }],
    capabilities: [{ key: "serve", name: "Serve" }],
    features: [{ key: "request", name: "Request handling", featureGroupKeys: ["platform"], capabilityKeys: ["serve"], governedBy: [] }],
    requirements: [{ key: "review-evidence", statement: "Material policy changes require an explicit evidence-linked review." }],
  } });
  await reviewOnboarding({ root, candidateSetId: started.candidateSet.candidateSetId, disposition: "accept-all", rationale: "Approve the exact generic product concepts." });
  return { root, storage, layout, started };
}

test("final gap: public onboarding and policy Product revisions support exact SessionWork citation and graph expansion", async t => {
  const { root, storage, layout } = await fixture(t), owner = inspectProject(root);
  const first = readProductModelCanon({ projectRoot: root, storage }).model;
  const proposed = await proposeProductPolicy({ root, operation: "create", key: "citation-policy", name: "Citation policy",
    statement: "Use exact evidence", appliesTo: [{ kind: "Feature", key: "request" }], governedBy: [], evidenceAnchors: [], explanation: "Synthetic policy citation" });
  await reviewProductPolicy({ root, candidateId: proposed.candidate.candidateId, disposition: "accept", rationale: "Synthetic exact acceptance" });
  const second = readProductModelCanon({ projectRoot: root, storage }).model;
  const files = [first, second].map(model => path.join(root, layout.directory, "onboarding/product-model-revisions", `${model.productModelId}.json`));
  const before = files.map(file => ({ bytes: fs.readFileSync(file), mode: fs.statSync(file).mode, mtime: fs.statSync(file).mtimeMs }));
  const outcomes = [], saved = [];
  for (const [index, file] of files.entries()) {
    const ref = { path: path.relative(root, file).replaceAll("\\", "/"), digest: sha(before[index].bytes), kind: "artifact" };
    try { saved.push(recordSessionWorkEvidence({ root, input: { summary: `Exact Product citation ${index}`, references: [ref] } })); outcomes.push("ok"); }
    catch (error) { outcomes.push(error.code); }
  }
  t.diagnostic(JSON.stringify({ producers: ["onboarding", "product-policy"], citationOutcomes: outcomes,
    projectIds: before.map(item => JSON.parse(item.bytes).projectId ?? null) }));
  for (const [index, file] of files.entries()) {
    assert.deepEqual(fs.readFileSync(file), before[index].bytes); assert.equal(fs.statSync(file).mode, before[index].mode); assert.equal(fs.statSync(file).mtimeMs, before[index].mtime);
  }
  assert.deepEqual(outcomes, ["ok", "ok"]);
  const graph = await queryProjectGraph({ root, anchorIds: saved.map(item => item.evidence.evidenceId), depth: 1, maxNodes: 40, maxEdges: 80 });
  for (const [index, item] of saved.entries()) {
    const model = [first, second][index], edge = graph.edges.find(edge => edge.type === "CITES_ARTIFACT" && edge.from === item.evidence.evidenceId && edge.to === model.productModelId);
    assert.ok(edge, "Citation must resolve through the existing exact typed container");
    const node = graph.nodes.find(node => node.nodeId === item.evidence.evidenceId);
    const expanded = await dispatch({ id: 1, method: "tools/call", params: { name: node.originalExpansion.tool, arguments: node.originalExpansion.arguments } });
    assert.equal(expanded.result?.isError, undefined);
    const work = expanded.result.structuredContent;
    assert.deepEqual(work.records[0].content, item.evidence.content);
    assert.equal(work.records[0].references[0].status, "intact-retained-original");
    assert.equal(work.records[0].references[0].originalOwner.projectId, owner.project.projectId);
    assert.equal(work.records[0].references[0].recoveryAuthority, false);
  }
});

test("final gap: identical Product content keeps Project ownership separate and rejects forged or changed citations", async t => {
  const a = await fixture(t), b = await fixture(t), modelA = readProductModelCanon({ projectRoot: a.root, storage: a.storage }).model;
  const modelB = readProductModelCanon({ projectRoot: b.root, storage: b.storage }).model;
  assert.equal(modelA.productModelId, modelB.productModelId); assert.equal(modelA.productModelHash, modelB.productModelHash);
  const ownFile = path.join(a.root, a.layout.directory, "onboarding/product-model-revisions", `${modelA.productModelId}.json`);
  const otherFile = path.join(b.root, b.layout.directory, "onboarding/product-model-revisions", `${modelB.productModelId}.json`);
  const ownBytes = fs.readFileSync(ownFile), otherBytes = fs.readFileSync(otherFile), owned = JSON.parse(ownBytes);
  assert.notEqual(owned.projectId, JSON.parse(otherBytes).projectId); assert.notEqual(sha(ownBytes), sha(otherBytes));
  const legacy = { ...owned }; delete legacy.projectId;
  const corrupt = structuredClone(owned); corrupt.document.capabilities[0].name = "Tampered model, old identity";
  const variants = [
    ["foreign", otherBytes, "SESSION_WORK_REFERENCE_PROJECT_MISMATCH"],
    ["ownerless", Buffer.from(JSON.stringify(legacy)), "SESSION_WORK_REFERENCE_PROJECT_MISMATCH"],
    ["tampered", Buffer.from(JSON.stringify(corrupt)), "ONBOARDING_PRODUCT_REVISION_DIGEST_MISMATCH"],
    ["unsupported", Buffer.from(JSON.stringify({ ...owned, authority: "unrecognized-family" })), "SESSION_WORK_REFERENCE_UNSUPPORTED_PRODUCT_REVISION"],
    ["arbitrary", Buffer.from(JSON.stringify({ kind: "ProductModelRevision", projectId: owned.projectId, authority: "user-owned-project-canon-revision", document: {} })), null],
    ["extra-authority", Buffer.from(JSON.stringify({ ...owned, instructionAuthority: true })), "SESSION_WORK_REFERENCE_UNSUPPORTED_PRODUCT_REVISION"],
  ];
  for (const [name, bytes] of variants) fs.writeFileSync(path.join(a.root, `${name}.json`), bytes);
  const before = snapshot(a.root);
  for (const [name, bytes, code] of variants) {
    assert.throws(() => recordSessionWorkEvidence({ root: a.root, input: { references: [{ path: `${name}.json`, digest: sha(bytes), kind: "artifact" }] } }), code ? { code } : undefined);
  }
  assert.throws(() => recordSessionWorkEvidence({ root: a.root, input: { references: [{ path: path.relative(a.root, ownFile).replaceAll("\\", "/"), digest: "0".repeat(64), kind: "artifact" }] } }), { code: "SESSION_WORK_REFERENCE_CHANGED" });
  assert.deepEqual(snapshot(a.root), before);
  // A previously valid quote becomes unavailable on a typed-content change,
  // even when the caller supplies the changed byte digest for a new save.
  fs.writeFileSync(path.join(a.root, "tampered.json"), ownBytes);
  const saved = recordSessionWorkEvidence({ root: a.root, input: { references: [{ path: "tampered.json", digest: sha(ownBytes), kind: "artifact" }] } });
  fs.writeFileSync(path.join(a.root, "tampered.json"), JSON.stringify(corrupt));
  const read = readSessionWorkContext({ root: a.root, evidenceIds: [saved.evidence.evidenceId], maxRecords: 1 });
  assert.equal(read.records[0].references[0].status, "unavailable");
  assert.equal(read.records[0].references[0].reasonCode, "SESSION_WORK_REFERENCE_CHANGED");
});

test("final gap: ownerless historical bytes survive public retries and policy transition without becoming owned", async t => {
  const f = await fixture(t), model = readProductModelCanon({ projectRoot: f.root, storage: f.storage }).model;
  const file = path.join(f.root, f.layout.directory, "onboarding/product-model-revisions", `${model.productModelId}.json`);
  const historical = JSON.parse(fs.readFileSync(file)); delete historical.projectId;
  fs.writeFileSync(file, JSON.stringify(historical, null, 2) + "\n"); // Historical-shape fixture setup only.
  const bytes = fs.readFileSync(file), stat = fs.statSync(file);
  await reviewOnboarding({ root: f.root, candidateSetId: f.started.candidateSet.candidateSetId, disposition: "accept-all", rationale: "Approve the exact generic product concepts." });
  const proposed = await proposeProductPolicy({ root: f.root, operation: "create", key: "historical-base", name: "Historical base",
    statement: "Preserve immutable originals", appliesTo: [{ kind: "Feature", key: "request" }], governedBy: [], evidenceAnchors: [], explanation: "Synthetic historical replay" });
  const request = { root: f.root, candidateId: proposed.candidate.candidateId, disposition: "accept", rationale: "Approve new content without relabeling old bytes" };
  await reviewProductPolicy(request); await reviewProductPolicy(request);
  assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(fs.statSync(file).mode, stat.mode); assert.equal(fs.statSync(file).mtimeMs, stat.mtimeMs);
  assert.equal(historical.productModelId, model.productModelId); assert.equal(historical.productModelHash, model.productModelHash);
  assert.throws(() => recordSessionWorkEvidence({ root: f.root, input: { references: [{ path: path.relative(f.root, file).replaceAll("\\", "/"), digest: sha(bytes), kind: "artifact" }] } }), { code: "SESSION_WORK_REFERENCE_PROJECT_MISMATCH" });
  const next = readProductModelCanon({ projectRoot: f.root, storage: f.storage }).model;
  const nextFile = path.join(f.root, f.layout.directory, "onboarding/product-model-revisions", `${next.productModelId}.json`);
  assert.equal(JSON.parse(fs.readFileSync(nextFile)).projectId, inspectProject(f.root).project.projectId);
  assert.doesNotThrow(() => recordSessionWorkEvidence({ root: f.root, input: { references: [{ path: path.relative(f.root, nextFile).replaceAll("\\", "/"), digest: sha(fs.readFileSync(nextFile)), kind: "artifact" }] } }));
});

test("schema 1 Product Model bytes and identity remain exact", () => {
  const document = { schemaVersion: 1, featureGroups: [], capabilities: [], features: [], requirements: [], constraints: [], decisions: [] };
  const model = normalizeProductModelDocument(document);
  assert.equal(JSON.stringify(document), '{"schemaVersion":1,"featureGroups":[],"capabilities":[],"features":[],"requirements":[],"constraints":[],"decisions":[]}');
  assert.equal(model.protocol.version, "0.1.0");
  assert.equal(model.productModelHash, "670ff9620ae5089e7e75e456807b931cc2e33438e6a12c43f8ccd6e62ceb6ebc");
  assert.equal(model.productModelId, "product-model-670ff9620ae5089e7e75e456");
});

test("explicit Policy applications preserve review and revision genealogy without group inheritance", async (t) => {
  const { root, storage, layout } = await fixture(t);
  const proposed = await proposeProductPolicy({
    root,
    operation: "create",
    key: "review-required",
    name: "Review required",
    statement: "Changes to the platform group require explicit review.",
    appliesTo: [{ kind: "FeatureGroup", key: "platform" }],
    governedBy: [{ kind: "Requirement", key: "review-evidence" }],
    evidenceAnchors: [],
    explanation: "The user may approve this proposal even when external evidence is unavailable.",
  });
  assert.equal(proposed.status, "awaiting-review");
  assert.equal(proposed.ordinaryWorkBlocked, false);
  assert.equal(proposed.candidate.authorityBoundary.planeId, "P3");
  assert.equal(proposed.candidate.evidenceStatus, "not-supplied");
  const before = readProductModelCanon({ projectRoot: root, storage }).model;
  assert.equal(before.schemaVersion, 1);

  const accepted = await reviewProductPolicy({ root, candidateId: proposed.candidate.candidateId, disposition: "accept", rationale: "Approve this exact explicit group application." });
  assert.equal(accepted.status, "accepted", JSON.stringify(accepted.projectionError));
  assert.equal(accepted.review.authorityBoundary.planeId, "P1");
  assert.equal(accepted.additionalUserReviewRequired, false);
  const canon = readProductModelCanon({ projectRoot: root, storage }).model;
  assert.equal(canon.schemaVersion, 2);
  assert.deepEqual(canon.policies[0].appliesTo, [{ kind: "FeatureGroup", key: "platform" }]);
  assert.deepEqual(canon.policies[0].governedBy, [{ kind: "Requirement", key: "review-evidence" }]);
  const graph = (await inspectWorldModel({ root })).snapshot.temporalProvenanceGraph;
  const policy = graph.nodes.find((node) => node.kind === "Policy" && node.key === "review-required");
  const policyRevision = graph.nodes.find((node) => node.kind === "PolicyRevision" && node.key === "review-required");
  const policyCandidate = graph.nodes.find((node) => node.kind === "ProductPolicyCandidate" && node.nodeId === proposed.candidate.candidateId);
  const policyReview = graph.nodes.find((node) => node.kind === "ProductPolicyReviewDecision" && node.nodeId === accepted.review.reviewDecisionId);
  const productRevisionReference = graph.nodes.find((node) => node.kind === "ProductModelRevisionReference" && node.referencedProductModelId === canon.productModelId);
  const group = graph.nodes.find((node) => node.kind === "FeatureGroup" && node.key === "platform");
  const feature = graph.nodes.find((node) => node.kind === "Feature" && node.key === "request");
  const requirement = graph.nodes.find((node) => node.kind === "Requirement" && node.key === "review-evidence");
  assert.ok(graph.edges.some((edge) => edge.type === "GOVERNED_BY" && edge.from === group.nodeId && edge.to === policy.nodeId));
  assert.ok(graph.edges.some((edge) => edge.type === "GOVERNED_BY" && edge.from === policy.nodeId && edge.to === requirement.nodeId));
  assert.equal(graph.edges.some((edge) => edge.type === "GOVERNED_BY" && edge.from === feature.nodeId && edge.to === policy.nodeId), false);
  assert.equal(policyCandidate.applicationStatus, "applied-current");
  assert.equal(policyReview.applicationStatus, "applied-current");
  assert.ok(graph.edges.some((edge) => edge.type === "REVIEWED_BY" && edge.from === policyCandidate.nodeId && edge.to === policyReview.nodeId));
  assert.ok(graph.edges.some((edge) => edge.type === "PRODUCES" && edge.from === policyReview.nodeId && edge.to === productRevisionReference.nodeId));
  assert.ok(graph.edges.some((edge) => edge.type === "PRODUCES" && edge.from === policyReview.nodeId && edge.to === policyRevision.nodeId));

  const replay = await reviewProductPolicy({ root, candidateId: proposed.candidate.candidateId, disposition: "accept", rationale: "Approve this exact explicit group application." });
  assert.equal(replay.review.reviewDecisionId, accepted.review.reviewDecisionId);
  assert.equal(replay.canonChanged, false);
  await assert.rejects(async () => (await reviewProductPolicy({ root, candidateId: proposed.candidate.candidateId, disposition: "accept", rationale: "A divergent reason." })), { code: "PRODUCT_POLICY_REVIEW_CONFLICT" });

  const revised = await proposeProductPolicy({ root, operation: "revise", key: "review-required", appliesTo: [{ kind: "Feature", key: "request" }], explanation: "Narrow the exact application." });
  await reviewProductPolicy({ root, candidateId: revised.candidate.candidateId, disposition: "accept", rationale: "Approve the narrower explicit application." });
  assert.equal(inspectProductPolicyStatus({ root, candidateId: proposed.candidate.candidateId }).status, "accepted-historical");
  assert.equal(inspectProductPolicyStatus({ root, candidateId: proposed.candidate.candidateId }).canonState, "superseded");
  const revisedGraph = (await inspectWorldModel({ root })).snapshot.temporalProvenanceGraph;
  const revisions = revisedGraph.nodes.filter((node) => node.kind === "PolicyRevision" && node.key === "review-required");
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].parentRevisionIds.length, 1);
  assert.ok(revisedGraph.nodes.some((node) => node.kind === "RevisionReference" && node.nodeId === revisions[0].parentRevisionIds[0]));
  const revisedPolicy = revisedGraph.nodes.find((node) => node.kind === "Policy" && node.key === "review-required");
  const revisedFeature = revisedGraph.nodes.find((node) => node.kind === "Feature" && node.key === "request");
  const revisedGroup = revisedGraph.nodes.find((node) => node.kind === "FeatureGroup" && node.key === "platform");
  assert.ok(revisedGraph.edges.some((edge) => edge.type === "GOVERNED_BY" && edge.from === revisedFeature.nodeId && edge.to === revisedPolicy.nodeId));
  assert.equal(revisedGraph.edges.some((edge) => edge.type === "GOVERNED_BY" && edge.from === revisedGroup.nodeId && edge.to === revisedPolicy.nodeId), false);

  const retired = await proposeProductPolicy({ root, operation: "retire", key: "review-required", explanation: "Retire without deleting its lineage." });
  await reviewProductPolicy({ root, candidateId: retired.candidate.candidateId, disposition: "accept", rationale: "Approve retirement while preserving history." });
  const retiredGraph = (await inspectWorldModel({ root })).snapshot.temporalProvenanceGraph;
  const retiredRevision = retiredGraph.nodes.find((node) => node.kind === "PolicyRevision" && node.key === "review-required");
  assert.equal(retiredRevision.semantic.status, "retired");
  assert.equal(retiredRevision.parentRevisionIds.length, 1);
  const retiredPolicy = retiredGraph.nodes.find((node) => node.kind === "Policy" && node.key === "review-required");
  assert.equal(retiredGraph.edges.some((edge) => edge.type === "GOVERNED_BY" && edge.to === retiredPolicy.nodeId), false);
});

test("Policy semantic references are optional, exact, and never inferred", async (t) => {
  const { root, layout } = await fixture(t);
  await assert.rejects(() => proposeProductPolicy({
    root,
    operation: "create",
    key: "unknown-basis",
    name: "Unknown basis",
    statement: "This must not enter a proposal with a dangling semantic reference.",
    governedBy: [{ kind: "Requirement", key: "missing" }],
  }), { code: "UNKNOWN_PRODUCT_REFERENCE" });
  const proposed = await proposeProductPolicy({ root, operation: "create", key: "no-basis", name: "No basis", statement: "An explicit policy may have no semantic basis references." });
  assert.deepEqual(proposed.candidate.proposedPolicy.governedBy, []);
  assert.equal(proposed.ordinaryWorkBlocked, false);
});

test("Policy artifact identity, declared transition scope, evidence freshness, and Session fence fail closed", async (t) => {
  const { root, storage, layout } = await fixture(t);
  const first = await proposeProductPolicy({ root, operation: "create", key: "first", name: "First", statement: "First exact policy." });
  const second = await proposeProductPolicy({ root, operation: "create", key: "second", name: "Second", statement: "Second exact policy." });
  const firstFile = path.join(root, layout.directory, "product-policy", "candidates", `${first.candidate.candidateId}.json`);
  const firstBytes = fs.readFileSync(firstFile, "utf8");
  fs.writeFileSync(firstFile, `${JSON.stringify(second.candidate, null, 2)}\n`);
  assert.throws(() => readProductPolicyCandidate({ root, candidateId: first.candidate.candidateId }), { code: "PRODUCT_POLICY_ARTIFACT_IDENTITY_MISMATCH" });
  fs.writeFileSync(firstFile, firstBytes);

  const expanded = structuredClone(first.candidate);
  expanded.resultingProductModelDocument.features[0].name = "Unrelated feature rewrite";
  const changedResult = normalizeProductModelDocument(expanded.resultingProductModelDocument, storage);
  expanded.resultingProductModelDocument = productModelDocument(changedResult);
  expanded.resultingProductModelId = changedResult.productModelId;
  expanded.resultingProductModelHash = changedResult.productModelHash;
  delete expanded.candidateId;
  delete expanded.candidateHash;
  expanded.candidateHash = sha(productPolicyCanonicalJson(expanded));
  expanded.candidateId = `policy-candidate-${expanded.candidateHash.slice(0, 24)}`;
  assert.throws(() => verifyProductPolicyCandidate(expanded), { code: "PRODUCT_POLICY_TRANSITION_MISMATCH" });

  const sourceProposal = await proposeProductPolicy({
    root,
    operation: "create",
    key: "source-bound",
    name: "Source bound",
    statement: "This proposal is bound to exact local source evidence.",
    evidenceAnchors: [{ kind: "source", reference: "src/service.mjs", summary: "Exact source at proposal time" }],
  });
  assert.equal(sourceProposal.candidate.evidenceStatus, "local-source-bound");
  assert.equal(sourceProposal.candidate.evidenceAnchors[0].digest, sha("export function serve() { return true; }\n"));
  fs.writeFileSync(path.join(root, "src", "service.mjs"), "export function serve() { return false; }\n");
  await assert.rejects(async () => (await reviewProductPolicy({ root, candidateId: sourceProposal.candidate.candidateId, disposition: "accept", rationale: "Do not accept stale evidence." })), { code: "PRODUCT_POLICY_EVIDENCE_STALE" });

  let releaseFence;
  let fenceReady;
  const ready = new Promise((resolve) => { fenceReady = resolve; });
  const held = new Promise((resolve) => { releaseFence = resolve; });
  const fence = withProjectMutationAsync({ root, scope: "session-recovery", storage }, async () => {
    fenceReady();
    await held;
  });
  await ready;
  await assert.rejects(async () => (await reviewProductPolicy({ root, candidateId: first.candidate.candidateId, disposition: "accept", rationale: "This cannot cross an active Session fence." })), { code: "PROJECT_MUTATION_BUSY" });
  releaseFence();
  await fence;
  fs.writeFileSync(path.join(root, "src", "service.mjs"), "export function serve() { return true; }\n");
  const accepted = await reviewProductPolicy({ root, candidateId: sourceProposal.candidate.candidateId, disposition: "accept", rationale: "Approve the exact restored source digest." });
  assert.equal(accepted.status, "accepted", JSON.stringify(accepted.projectionError));
  const graph = (await inspectWorldModel({ root })).snapshot.temporalProvenanceGraph;
  const evidence = graph.nodes.find((node) => node.kind === "ProductPolicyEvidence" && node.candidateId === sourceProposal.candidate.candidateId);
  assert.equal(evidence.reference, "src/service.mjs");
  assert.ok(graph.edges.some((edge) => edge.type === "SUPPORTED_BY" && edge.from === sourceProposal.candidate.candidateId && edge.to === evidence.nodeId));

  let status = inspectProductPolicyStatus({ root, candidateId: sourceProposal.candidate.candidateId });
  assert.equal(status.evidenceCurrentness.byteFreshness, "unchanged");
  assert.equal(status.evidenceCurrentness.semanticReassessment, "not-assessed");
  fs.writeFileSync(path.join(root, "src", "service.mjs"), "export function serve() { return false; }\n");
  status = inspectProductPolicyStatus({ root, candidateId: sourceProposal.candidate.candidateId });
  assert.equal(status.status, "accepted");
  assert.equal(status.evidenceCurrentness.byteFreshness, "changed-or-missing");
  assert.equal(status.evidenceCurrentness.items[0].state, "changed");
  assert.equal(status.evidenceCurrentness.automaticReviewRequired, false);
  assert.equal(status.ordinaryWorkBlocked, false);
  await buildWorldModel({ root, persist: true });
  const trace = (await traceGraphLineage({ root, anchorId: sourceProposal.candidate.candidateId, depth: 1, includeExecution: false }));
  assert.equal(trace.policyEvidenceCurrentness[0].candidateId, sourceProposal.candidate.candidateId);
  assert.equal(trace.policyEvidenceCurrentness[0].byteFreshness, "changed-or-missing");
  fs.unlinkSync(path.join(root, "src", "service.mjs"));
  status = inspectProductPolicyStatus({ root, candidateId: sourceProposal.candidate.candidateId });
  assert.equal(status.evidenceCurrentness.items[0].state, "missing");
});

test("mixed Policy evidence keeps exact anchor mapping while exact replay repairs only P4 projection", async (t) => {
  const { root, layout } = await fixture(t);
  const rationale = "Approve the exact mixed-evidence candidate.";
  const proposed = await proposeProductPolicy({
    root,
    operation: "create",
    key: "mixed-evidence",
    name: "Mixed evidence",
    statement: "Keep each declared evidence anchor distinct and traceable.",
    evidenceAnchors: [
      { kind: "user-request", reference: "conversation:policy-request", summary: "Explicit request" },
      { kind: "source", reference: "src/service.mjs", summary: "Exact implementation source" },
      { kind: "observation", reference: "observation:generic-service", summary: "Provider-supplied observation" },
      { kind: "decision", reference: "decision:review-boundary", summary: "Existing decision reference" },
      { kind: "other", reference: "external:design-note", summary: "Non-authoritative design evidence" },
    ],
  });
  const accepted = await reviewProductPolicy({ root, candidateId: proposed.candidate.candidateId, disposition: "accept", rationale });
  assert.equal(accepted.status, "accepted", JSON.stringify(accepted.projectionError));

  const graph = (await inspectWorldModel({ root })).snapshot.temporalProvenanceGraph;
  const candidateNode = graph.nodes.find((node) => node.nodeId === proposed.candidate.candidateId);
  assert.ok(candidateNode);
  const evidenceNodes = graph.nodes.filter((node) => node.kind === "ProductPolicyEvidence" && node.candidateId === proposed.candidate.candidateId);
  assert.equal(evidenceNodes.length, proposed.candidate.evidenceAnchors.length);
  // Project-derived hashes can coincidentally already be sorted. Assert the
  // actual anchor-to-ID mapping, not a probabilistic property of fixture IDs.
  assert.deepEqual(candidateNode.evidenceNodeIds, proposed.candidate.evidenceAnchors.map((anchor) => evidenceNodes.find((node) =>
    node.evidenceKind === anchor.kind && node.reference === anchor.reference && node.contentDigest === anchor.digest && node.summary === anchor.summary)?.nodeId));
  for (const anchor of proposed.candidate.evidenceAnchors) {
    const evidence = evidenceNodes.find((node) => node.evidenceKind === anchor.kind
      && node.reference === anchor.reference && node.contentDigest === anchor.digest && node.summary === anchor.summary);
    assert.ok(evidence, `missing exact evidence mapping for ${anchor.kind}:${anchor.reference}`);
    assert.ok(graph.edges.some((edge) => edge.type === "SUPPORTED_BY" && edge.from === proposed.candidate.candidateId && edge.to === evidence.nodeId));
  }
  const supportedIds = graph.edges.filter((edge) => edge.type === "SUPPORTED_BY" && edge.from === proposed.candidate.candidateId).map((edge) => edge.to).sort();
  assert.deepEqual(supportedIds, [...candidateNode.evidenceNodeIds].sort());

  const cliTrace = await runCommand(["graph-lineage-trace", root, "--anchor", proposed.candidate.candidateId, "--depth", "1"]);
  assert.equal(cliTrace.kind, "GraphLineageTraceProjection");
  assert.equal(cliTrace.policyEvidenceCurrentness[0].candidateId, proposed.candidate.candidateId);
  const mcpTrace = await dispatch({ jsonrpc: "2.0", id: "mixed-lineage", method: "tools/call", params: { name: "head_graph_lineage_trace", arguments: {
    project_root: root, anchor_id: proposed.candidate.candidateId, depth: 1,
  } } });
  assert.equal(mcpTrace.error, undefined, JSON.stringify(mcpTrace.error));
  assert.equal(mcpTrace.result.structuredContent.policyEvidenceCurrentness[0].candidateId, proposed.candidate.candidateId);

  const canonFile = path.join(root, layout.directory, "context", "product-model.json");
  const reviewDirectory = path.join(root, layout.directory, "product-policy", "review-decisions");
  const reviewFile = path.join(reviewDirectory, `${accepted.review.reviewDecisionId}.json`);
  const canonBytes = fs.readFileSync(canonFile, "utf8");
  const reviewBytes = fs.readFileSync(reviewFile, "utf8");
  const reviewNames = fs.readdirSync(reviewDirectory).sort();
  fs.unlinkSync(path.join(root, layout.directory, "world-model", "current.json"));

  const replay = await reviewProductPolicy({ root, candidateId: proposed.candidate.candidateId, disposition: "accept", rationale });
  assert.equal(replay.status, "accepted", JSON.stringify(replay.projectionError));
  assert.equal(replay.review.reviewDecisionId, accepted.review.reviewDecisionId);
  assert.equal(replay.canonChanged, false);
  assert.equal(replay.additionalUserReviewRequired, false);
  assert.equal(replay.evidenceCheck.replayed, true);
  assert.equal(fs.readFileSync(canonFile, "utf8"), canonBytes);
  assert.equal(fs.readFileSync(reviewFile, "utf8"), reviewBytes);
  assert.deepEqual(fs.readdirSync(reviewDirectory).sort(), reviewNames);
  assert.equal((await inspectWorldModel({ root })).status, "current");
});

test("Policy candidates are nonblocking while stale acceptance and divergent decisions fail closed", async (t) => {
  const { root, layout } = await fixture(t);
  const first = await proposeProductPolicy({ root, operation: "create", key: "first", name: "First", statement: "First explicit policy." });
  const second = await proposeProductPolicy({ root, operation: "create", key: "second", name: "Second", statement: "Second explicit policy." });
  assert.equal(inspectProductPolicyStatus({ root, candidateId: second.candidate.candidateId }).ordinaryWorkBlocked, false);
  await reviewProductPolicy({ root, candidateId: first.candidate.candidateId, disposition: "accept", rationale: "Approve the first exact candidate." });
  await assert.rejects(async () => (await reviewProductPolicy({ root, candidateId: second.candidate.candidateId, disposition: "accept", rationale: "Attempt stale approval." })), { code: "PRODUCT_POLICY_CANON_DRIFT" });
  const rejected = await reviewProductPolicy({ root, candidateId: second.candidate.candidateId, disposition: "reject", rationale: "Reject the stale candidate without blocking work." });
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.ordinaryWorkBlocked, false);
});

test("content-addressed Policy history supports repeated semantics, multiple successors, and cycles", async (t) => {
  const { root, layout } = await fixture(t);
  const created = await proposeProductPolicy({ root, operation: "create", key: "cyclic", name: "Cyclic", statement: "A" });
  await reviewProductPolicy({ root, candidateId: created.candidate.candidateId, disposition: "accept", rationale: "Approve A." });
  const revisedB = await proposeProductPolicy({ root, operation: "revise", key: "cyclic", statement: "B" });
  await reviewProductPolicy({ root, candidateId: revisedB.candidate.candidateId, disposition: "accept", rationale: "Approve B." });
  const revertedA = await proposeProductPolicy({ root, operation: "revise", key: "cyclic", statement: "A" });
  await reviewProductPolicy({ root, candidateId: revertedA.candidate.candidateId, disposition: "accept", rationale: "Approve the exact return to A." });
  const revisedC = await proposeProductPolicy({ root, operation: "revise", key: "cyclic", statement: "C" });
  const acceptedC = await reviewProductPolicy({ root, candidateId: revisedC.candidate.candidateId, disposition: "accept", rationale: "Approve C from the repeated A model." });
  assert.equal(acceptedC.status, "accepted", JSON.stringify(acceptedC.projectionError));
  assert.equal(inspectProductPolicyStatus({ root, candidateId: created.candidate.candidateId }).status, "accepted-historical");
  assert.equal((await inspectWorldModel({ root })).status, "current");
});

test("unrelated Policy changes preserve current entity approval lineage and unreviewed candidates stay opt-in", async (t) => {
  const { root, layout } = await fixture(t);
  const first = await proposeProductPolicy({ root, operation: "create", key: "first", name: "First", statement: "First exact policy." });
  const firstReview = await reviewProductPolicy({ root, candidateId: first.candidate.candidateId, disposition: "accept", rationale: "Approve the first policy." });
  const second = await proposeProductPolicy({ root, operation: "create", key: "second", name: "Second", statement: "Second exact policy." });
  await reviewProductPolicy({ root, candidateId: second.candidate.candidateId, disposition: "accept", rationale: "Approve the unrelated second policy." });
  const unreviewed = await proposeProductPolicy({ root, operation: "create", key: "third", name: "Third", statement: "Unreviewed policy candidate." });

  await buildWorldModel({ root, persist: true });
  const current = (await inspectWorldModel({ root }));
  const graph = current.snapshot.temporalProvenanceGraph;
  const firstRevision = graph.nodes.find((node) => node.kind === "PolicyRevision" && node.key === "first");
  const firstCandidate = graph.nodes.find((node) => node.nodeId === first.candidate.candidateId);
  assert.equal(firstCandidate.applicationStatus, "applied-historical");
  assert.ok(graph.edges.some((edge) => edge.type === "PRODUCES" && edge.from === firstReview.review.reviewDecisionId && edge.to === firstRevision.nodeId));

  const hidden = (await queryWorldTemporalGraph({
    root,
    query: "third",
    kinds: ["ProductPolicyCandidate", "ProductPolicyEvidence"],
    freshness: ["historical"],
    authorityClasses: ["derived"],
    includeUnreviewedCandidates: false,
    depth: 0,
  }));
  assert.equal(hidden.nodes.some((node) => node.nodeId === unreviewed.candidate.candidateId), false);
  assert.ok(hidden.exclusion.unreviewedCandidatesExcluded >= 1);
  const explicit = (await queryWorldTemporalGraph({
    root,
    anchorIds: [unreviewed.candidate.candidateId],
    expectedGraphSnapshotId: graph.graphSnapshotId,
    kinds: ["ProductPolicyCandidate"],
    freshness: ["historical"],
    authorityClasses: ["derived"],
    includeUnreviewedCandidates: true,
    depth: 0,
  }));
  assert.equal(explicit.nodes[0].nodeId, unreviewed.candidate.candidateId);
});

test("CLI and typed MCP expose the same conversational Policy workflow", async (t) => {
  const { root, layout } = await fixture(t);
  assert.ok(tools.some((tool) => tool.name === "lode_product_policy_propose"));
  const mcp = await dispatch({ jsonrpc: "2.0", id: "policy", method: "tools/call", params: { name: "head_product_policy_propose", arguments: {
    project_root: root,
    operation: "create",
    key: "typed",
    name: "Typed policy",
    statement: "Use the typed conversation surface.",
    applies_to: [{ kind: "Feature", key: "request" }],
    governed_by: [{ kind: "Requirement", key: "review-evidence" }],
  } } });
  assert.equal(mcp.error, undefined, JSON.stringify(mcp.error));
  const candidateId = mcp.result.structuredContent.candidate.candidateId;
  assert.deepEqual(mcp.result.structuredContent.candidate.proposedPolicy.governedBy, [{ kind: "Requirement", key: "review-evidence" }]);
  const cli = await runCommand(["product-policy-status", root, "--candidate", candidateId]);
  assert.equal(cli.status, "awaiting-review");
  const review = await dispatch({ jsonrpc: "2.0", id: "policy-review", method: "tools/call", params: { name: "head_product_policy_review", arguments: {
    project_root: root, candidate_id: candidateId, disposition: "accept", rationale: "Approve the typed candidate.",
  } } });
  assert.equal(review.error, undefined, JSON.stringify(review.error));
  assert.equal(review.result.structuredContent.status, "accepted", JSON.stringify(review.result.structuredContent.projectionError));
});

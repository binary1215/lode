import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { formatForVerifiedOwner } from "../scripts/lib/project-storage-format.mjs";
import { buildWorldModel } from "../scripts/lib/world-model.mjs";
import { refreshWorldModel } from "../scripts/lib/incremental-refresh.mjs";
import {
  inspectConformanceQueue,
  prepareConformanceAssessment,
  proposeConformanceFindings,
  proposeConformanceResolution,
  readConformanceFinding,
  recordConformanceDisposition,
} from "../scripts/lib/conformance-reconciliation.mjs";
import { ConformanceTriggerRegistry } from "../scripts/lib/conformance-trigger-adapter.mjs";
import { dispatch as dispatchMcp, catalogTools as mcpTools } from "../scripts/mcp-server.mjs";
import { ingestStructuredObservation } from "../scripts/lib/observation-adapter.mjs";
import { runCommand } from "../scripts/head.mjs";
import { formatReviewOutcome, formatConformanceFinding, formatConformanceQueue } from "../scripts/lib/cli-presentation.mjs";
import { conformanceCanonicalJson, createConformanceDispositionReceipt, HEAD_CONFORMANCE_MAINTENANCE_AUTHORITY } from "../scripts/lib/conformance-contract.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testParent = process.env.HEAD_AGENT_TEST_TMP || os.tmpdir();
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");

test("HEAD maintenance stays visible, preserves user authority, and rejects forged author chains", async (t) => {
  const { root, layout } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "source.mjs"), "export const value = 1;\n");
  const finding = (await proposeConformanceFindings(proposal(root, (await prepareConformanceAssessment({ root })), "source.mjs"))).findings[0];
  const protectedPaths = [`${layout.directory}/project.json`, `${layout.directory}/sessions/current.json`, `${layout.directory}/context/product-model.json`];
  const before = protectedPaths.map(p => fs.readFileSync(path.join(root, p)));
  const request = { root, findingId: finding.findingId, actor: "head", disposition: "acknowledge", rationale: "HEAD inspected this candidate; no user response is needed." };
  const input = path.join(root, "maintenance.json");
  fs.writeFileSync(input, JSON.stringify(request));
  const acknowledged = await runCommand(["conformance-disposition", root, "--input", input]);
  assert.equal(acknowledged.disposition.authority, layout.value(HEAD_CONFORMANCE_MAINTENANCE_AUTHORITY));
  assert.equal((await recordConformanceDisposition(request)).status, "existing");
  assert.match(formatReviewOutcome(acknowledged), /no user decision was claimed/);
  const deferred = await dispatchMcp({ jsonrpc: "2.0", id: "head-maintenance", method: "tools/call", params: { name: "head_conformance_disposition", arguments: { project_root: root, finding_id: finding.findingId, actor: "head", disposition: "defer", rationale: "Not needed for the present task." } } });
  assert.equal(deferred.result.isError, undefined);
  const row = (await inspectConformanceQueue({ root })).findings[0];
  assert.equal(row.status, "deferred");
  assert.equal(row.latestDisposition.actor, "lode");
  assert.match(formatConformanceQueue((await inspectConformanceQueue({ root }))), /\(lode\)/);
  assert.match(formatConformanceFinding(readConformanceFinding({ root, findingId: finding.findingId })), /without a user response/);
  for (const disposition of ["dismiss", "accept-resolution", "request-code-fix", "request-canon-revision"]) (await assert.rejects(async () => (await recordConformanceDisposition({ ...request, disposition })), { code: "CONFORMANCE_HEAD_MAINTENANCE_ONLY" }));
  (await assert.rejects(async () => (await recordConformanceDisposition({ ...request, confirmUserDisposition: true })), { code: "CONFORMANCE_HEAD_MAINTENANCE_ONLY" }));
  const user = (await recordConformanceDisposition({ ...request, actor: "user", confirmUserDisposition: true }));
  assert.notEqual(user.disposition.dispositionId, acknowledged.disposition.dispositionId);
  (await assert.rejects(async () => (await recordConformanceDisposition(request)), { code: "CONFORMANCE_HEAD_MAINTENANCE_ONLY" }));
  protectedPaths.forEach((p, i) => assert.deepEqual(fs.readFileSync(path.join(root, p)), before[i]));
  const exactFinding = readConformanceFinding({ root, findingId: finding.findingId }).finding;
  const forged = createConformanceDispositionReceipt({ projectId: exactFinding.projectId, sessionId: exactFinding.sessionId, finding: exactFinding, disposition: "defer", rationale: "Forged transition", previousDisposition: user.disposition }, layout);
  delete forged.dispositionId; delete forged.dispositionHash;
  forged.authority = layout.value(HEAD_CONFORMANCE_MAINTENANCE_AUTHORITY);
  forged.dispositionHash = sha(conformanceCanonicalJson(forged));
  forged.dispositionId = `conformance-disposition-${forged.dispositionHash.slice(0, 24)}`;
  fs.writeFileSync(path.join(root, layout.directory, "conformance/dispositions", `${forged.dispositionId}.json`), JSON.stringify(forged));
  (await assert.rejects(async () => (await inspectConformanceQueue({ root })), { code: "INVALID_CONFORMANCE_DISPOSITION_CHAIN" }));
});

test("exact logical Canon lookup survives revision drift and preserves deferred findings without unrelated source reads", async (t) => {
  const { root, layout } = fixture({ constraints: 66 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "selected.mjs"), "export const selected = true;\n");
  fs.writeFileSync(path.join(root, "unrelated.mjs"), "export const unrelated = true;\n");
  const baseline = (await prepareConformanceAssessment({ root })).baseline;
  const findings = Array.from({ length: 66 }, (_, i) => proposal(root, { baseline }, i === 65 ? "selected.mjs" : "unrelated.mjs", { constraint: `constraint.${i}` }).findings[0]);
  const saved = [];
  for (let i = 0; i < findings.length; i += 64) saved.push(...(await proposeConformanceFindings({ root, baseline, findings: findings.slice(i, i + 64) })).findings);
  const chosen = (await inspectConformanceQueue({ root, canonAnchor: { entityKind: "Constraint", entityKey: "constraint.65" } })).findings[0];
  (await recordConformanceDisposition({ root, findingId: chosen.findingId, disposition: "defer", actor: "head", rationale: "Not material to the earlier task." }));
  const canonAnchor = chosen.canonAnchor;
  assert.equal((await inspectConformanceQueue({ root, canonAnchor })).findings[0].status, "deferred");
  const canonPath = path.join(root, layout.directory, "context/product-model.json");
  const canon = JSON.parse(fs.readFileSync(canonPath));
  canon.constraints[65].statement = "Revised logical policy";
  fs.writeFileSync(canonPath, JSON.stringify(canon));
  const protectedPaths = [canonPath, path.join(root, layout.directory, "project.json"), path.join(root, layout.directory, "sessions/current.json")];
  const before = protectedPaths.map(p => fs.readFileSync(p));
  const read = fs.readFileSync;
  let unrelatedReads = 0;
  fs.readFileSync = function(file, ...args) {
    if (String(file).endsWith("unrelated.mjs")) unrelatedReads++;
    return read.call(this, file, ...args);
  };
  let queue;
  try { queue = (await inspectConformanceQueue({ root, canonAnchor })); } finally { fs.readFileSync = read; }
  assert.equal(unrelatedReads, 0);
  assert.equal(queue.totalMatches, 1);
  assert.equal(queue.findings[0].findingId, chosen.findingId);
  assert.equal(queue.findings[0].status, "needs-recheck");
  assert.deepEqual(queue.filters.canonAnchor, canonAnchor);
  const cli = await runCommand(["conformance-queue", root, "--canon-kind", "Constraint", "--canon-key", "constraint.65"]);
  const mcp = await dispatchMcp({ jsonrpc: "2.0", id: "canon-filter", method: "tools/call", params: { name: "head_conformance_queue", arguments: { project_root: root, canon_anchor: { entity_kind: "Constraint", entity_key: "constraint.65" } } } });
  assert.deepEqual(cli, queue);
  assert.deepEqual(mcp.result.structuredContent, queue);
  const other = (await inspectConformanceQueue({ root, canonAnchor: { ...canonAnchor, entityKey: "absent" }, projectionId: queue.projectionId, cursor: chosen.findingId }));
  assert.equal(other.resynchronization.occurred, true);
  assert.equal(other.totalMatches, 0);
  protectedPaths.forEach((p, i) => assert.deepEqual(fs.readFileSync(p), before[i]));
});

function fixture({ constraints = 1 } = {}) {
  fs.mkdirSync(testParent, { recursive: true });
  const root = fs.mkdtempSync(path.join(testParent, "head-agent-conformance-"));
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const layout = formatForVerifiedOwner(inspectProject(root).storage);
  const product = {
    schemaVersion: 1,
    featureGroups: [], capabilities: [], features: [], requirements: [], decisions: [],
    constraints: Array.from({ length: constraints }, (_, index) => ({ key: `constraint.${index}`, statement: `Approved constraint ${index}.`, description: "" })),
  };
  fs.writeFileSync(path.join(root, layout.directory, "context", "product-model.json"), `${JSON.stringify(product, null, 2)}\n`);
  return { root, layout };
}

function sourceAnchor(root, relativePath, { startLine = 1, endLine = 1 } = {}) {
  const bytes = fs.readFileSync(path.join(root, ...relativePath.split("/")));
  const lines = bytes.toString("utf8").split(/\r?\n/);
  return {
    kind: "source",
    path: relativePath,
    fileDigest: sha(bytes),
    startLine,
    endLine,
    excerptDigest: sha(Buffer.from(lines.slice(startLine - 1, endLine).join("\n"))),
    revisionId: null,
    symbolId: null,
  };
}

function proposal(root, prepared, relativePath, { constraint = "constraint.0", summary = "Potential mismatch.", riskHint = "medium" } = {}) {
  return {
    root,
    baseline: prepared.baseline,
    findings: [{
      canonAnchor: { entityKind: "Constraint", entityKey: constraint },
      evidenceAnchors: [sourceAnchor(root, relativePath)],
      claim: { kind: "potential-conflict", summary, rationale: "Provider HEAD inferred a possible semantic conflict from the exact cited source.", riskHint },
    }],
  };
}

test("records semantic candidates without Graph, lexical gates, Canon mutation, or ordinary-work blocking", async (t) => {
  const { root, layout } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "opaque-name.mjs"), "export const value = 1;\n");
  const canonFile = path.join(root, layout.directory, "context", "product-model.json");
  const sessionFile = path.join(root, layout.directory, "sessions", "current.json");
  const canonBefore = fs.readFileSync(canonFile, "utf8");
  const sessionBefore = fs.readFileSync(sessionFile, "utf8");

  const prepared = (await prepareConformanceAssessment({ root }));
  assert.equal(prepared.world.status, "unavailable");
  assert.equal(prepared.workflow.graphRequired, false);
  assert.equal(prepared.workflow.userStructuredInputRequired, false);
  const recorded = (await proposeConformanceFindings(proposal(root, prepared, "src/opaque-name.mjs")));
  assert.equal(recorded.outcome, "accepted-with-disclosure");
  assert.deepEqual(recorded.findings[0].disclosures, ["direct-source-anchor-used", "graph-unavailable"]);
  assert.equal(recorded.ordinaryWorkBlocked, false);
  assert.equal(fs.readFileSync(canonFile, "utf8"), canonBefore);
  assert.equal(fs.readFileSync(sessionFile, "utf8"), sessionBefore);
  assert.equal(inspectProject(root).status, "ready");
  const queue = (await inspectConformanceQueue({ root }));
  assert.equal(queue.findings[0].status, "open");
  assert.equal(queue.ordinaryWorkBlocked, false);
  const exact = readConformanceFinding({ root, findingId: recorded.findings[0].findingId });
  assert.equal(exact.graphProjection.graphPolicy.candidateSpaceHiddenByDefault, true);
  assert.equal(exact.graphProjection.edges.some((edge) => ["VIOLATES", "CONFORMS_TO", "SATISFIES", "RESOLVED"].includes(edge.type)), false);
});

test("converges wording-only duplicates and rejects only stale or unsafe exact evidence", async (t) => {
  const { root, layout } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "module.mjs"), "export const state = true;\n");
  const prepared = (await prepareConformanceAssessment({ root }));
  const staleProposal = proposal(root, prepared, "src/module.mjs", { summary: "First wording." });
  const first = (await proposeConformanceFindings(staleProposal));
  const replay = (await proposeConformanceFindings(proposal(root, prepared, "src/module.mjs", { summary: "Different wording over the same exact claim." })));
  assert.equal(replay.status, "existing");
  assert.equal(replay.findings[0].findingId, first.findings[0].findingId);

  fs.writeFileSync(path.join(root, "src", "module.mjs"), "export const state = false;\n");
  (await assert.rejects(async () => (await proposeConformanceFindings(staleProposal)), { code: "CONFORMANCE_SOURCE_DRIFT" }));
  const queue = (await inspectConformanceQueue({ root }));
  assert.equal(queue.findings[0].status, "needs-recheck");
  assert.equal(queue.findings[0].currency.reasonCode, "conformance_source_drift");
});

test("converges wording-only duplicate candidates inside one proposal batch", async (t) => {
  const { root, layout } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "batch.mjs"), "export const state = true;\n");
  const prepared = (await prepareConformanceAssessment({ root }));
  const first = proposal(root, prepared, "src/batch.mjs").findings[0];
  const second = structuredClone(first);
  second.claim.summary = "Different explanatory wording for the same exact semantic anchors.";
  second.claim.rationale = "The provider phrased the same candidate differently in one delivery batch.";
  const recorded = (await proposeConformanceFindings({ root, baseline: prepared.baseline, findings: [first, second] }));
  assert.equal(recorded.status, "recorded");
  assert.equal(recorded.findings.length, 1);
  assert.equal(recorded.convergedInBatchDuplicateCount, 1);
  assert.equal((await inspectConformanceQueue({ root })).totalMatches, 1);
  const replay = (await proposeConformanceFindings({ root, baseline: prepared.baseline, findings: [second, first] }));
  assert.equal(replay.status, "existing");
  assert.equal(replay.findings[0].findingId, recorded.findings[0].findingId);
  assert.equal(replay.convergedInBatchDuplicateCount, 1);
});

test("isolates an oversized current source anchor to one needs-recheck queue row", async (t) => {
  const { root, layout } = fixture({ constraints: 2 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "large.mjs"), "export const large = false;\n");
  fs.writeFileSync(path.join(root, "src", "current.mjs"), "export const current = true;\n");
  const prepared = (await prepareConformanceAssessment({ root }));
  (await proposeConformanceFindings({
    root,
    baseline: prepared.baseline,
    findings: [
      proposal(root, prepared, "src/large.mjs", { constraint: "constraint.0" }).findings[0],
      proposal(root, prepared, "src/current.mjs", { constraint: "constraint.1" }).findings[0],
    ],
  }));
  fs.truncateSync(path.join(root, "src", "large.mjs"), 64 * 1024 * 1024 + 1);
  const queue = (await inspectConformanceQueue({ root }));
  assert.equal(queue.totalMatches, 2);
  const oversized = queue.findings.find((item) => item.canonAnchor.entityKey === "constraint.0");
  const current = queue.findings.find((item) => item.canonAnchor.entityKey === "constraint.1");
  assert.equal(oversized.status, "needs-recheck");
  assert.equal(oversized.currency.reasonCode, "direct-source-anchor-exceeds-current-bound");
  assert.equal(current.currency.state, "current");
});

test("binds optional World source identities to the same exact file", async (t) => {
  const { root, layout } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "first.mjs"), "export const first = true;\n");
  fs.writeFileSync(path.join(root, "src", "second.mjs"), "export const second = true;\n");
  const built = await buildWorldModel({ root });
  const wrongRevision = built.snapshot.temporalProvenanceGraph.nodes.find((node) => node.kind === "FileRevision" && node.path === "src/second.mjs");
  assert.ok(wrongRevision);
  const prepared = (await prepareConformanceAssessment({ root }));
  const attempted = proposal(root, prepared, "src/first.mjs");
  attempted.findings[0].evidenceAnchors[0].revisionId = wrongRevision.nodeId;
  (await assert.rejects(async () => (await proposeConformanceFindings(attempted)), { code: "CONFORMANCE_EVIDENCE_NOT_FOUND" }));
});

test("keeps dispositions non-authoritative and closes only an explicitly accepted current resolution", async (t) => {
  const { root, layout } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "policy.mjs"), "export const enabled = false;\n");
  const prepared = (await prepareConformanceAssessment({ root }));
  const recorded = (await proposeConformanceFindings(proposal(root, prepared, "src/policy.mjs")));
  const findingId = recorded.findings[0].findingId;
  (await assert.rejects(async () => (await recordConformanceDisposition({ root, findingId, disposition: "dismiss", rationale: "No.", confirmUserDisposition: false })), { code: "CONFORMANCE_USER_CONFIRMATION_REQUIRED" }));
  (await assert.rejects(async () => (await recordConformanceDisposition({ root, findingId, disposition: "defer", rationale: "Later.", deferUntil: "not-a-date", confirmUserDisposition: true })), { code: "INVALID_CONFORMANCE_DISPOSITION" }));
  const requested = (await recordConformanceDisposition({ root, findingId, disposition: "request-code-fix", rationale: "Prepare a normal bounded fix, without authorizing it.", confirmUserDisposition: true }));
  assert.equal(requested.disposition.instructionAuthority, false);
  assert.equal(requested.authority.executionAuthorized, false);
  assert.equal((await inspectConformanceQueue({ root })).findings[0].status, "action-requested");

  fs.writeFileSync(path.join(root, "src", "policy.mjs"), "export const enabled = true;\n");
  const fresh = (await prepareConformanceAssessment({ root }));
  const resolutionAnchor = sourceAnchor(root, "src/policy.mjs");
  (await assert.rejects(async () => (await proposeConformanceResolution({ root, findingId, baseline: fresh.baseline, evidenceAnchors: [resolutionAnchor, resolutionAnchor], assessment: "appears-resolved", rationale: "Duplicate evidence must not inflate a reassessment." })), { code: "DUPLICATE_CONFORMANCE_EVIDENCE" }));
  const resolution = (await proposeConformanceResolution({ root, findingId, baseline: fresh.baseline, evidenceAnchors: [resolutionAnchor], assessment: "appears-resolved", rationale: "Provider HEAD reassessed the exact current source." }));
  assert.equal((await inspectConformanceQueue({ root })).findings[0].status, "needs-recheck");
  const closed = (await recordConformanceDisposition({ root, findingId, disposition: "accept-resolution", rationale: "Accept this exact resolution candidate.", resolutionId: resolution.resolution.resolutionId, confirmUserDisposition: true }));
  assert.equal(closed.disposition.mutatesCanon, false);
  assert.equal((await inspectConformanceQueue({ root })).findings[0].status, "closed-resolved");
});

test("pages beyond the sixty-fourth finding and resynchronizes stale read-only cursors", async (t) => {
  const { root, layout } = fixture({ constraints: 65 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  for (let index = 0; index < 65; index += 1) fs.writeFileSync(path.join(root, "src", `file-${index}.mjs`), `export const value = ${index};\n`);
  const prepared = (await prepareConformanceAssessment({ root, limit: 64 }));
  assert.equal(prepared.productCanon.entities.length, 64);
  assert.ok(prepared.nextCursor);
  const secondCanonPage = (await prepareConformanceAssessment({ root, limit: 64, projectionId: prepared.nextCursor.projectionId, cursor: prepared.nextCursor.cursor }));
  assert.equal(secondCanonPage.productCanon.entities.length, 1);

  const batch = Array.from({ length: 64 }, (_, index) => proposal(root, prepared, `src/file-${index}.mjs`, { constraint: `constraint.${index}`, summary: `Finding ${index}.` }).findings[0]);
  (await proposeConformanceFindings({ root, baseline: prepared.baseline, findings: batch }));
  (await proposeConformanceFindings(proposal(root, prepared, "src/file-64.mjs", { constraint: "constraint.64", summary: "Finding 64." })));
  const first = (await inspectConformanceQueue({ root, limit: 64 }));
  assert.equal(first.findings.length, 64);
  assert.ok(first.nextCursor);
  const second = (await inspectConformanceQueue({ root, limit: 64, projectionId: first.nextCursor.projectionId, cursor: first.nextCursor.cursor }));
  assert.equal(second.findings.length, 1);
  (await recordConformanceDisposition({ root, findingId: first.findings[0].findingId, disposition: "acknowledge", rationale: "Acknowledge one exact item.", confirmUserDisposition: true }));
  const resynchronized = (await inspectConformanceQueue({ root, limit: 64, projectionId: first.nextCursor.projectionId, cursor: first.nextCursor.cursor }));
  assert.equal(resynchronized.resynchronization.occurred, true);
  assert.equal(resynchronized.resynchronization.restartedAtFirstPage, true);
});

test("keeps Host triggers optional, coalesced, Project-bound, and uncertain-safe", async (t) => {
  const { root, layout } = fixture();
  const { root: other } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  const registry = new ConformanceTriggerRegistry();
  assert.throws(() => registry.register({ root, sourceKey: "monitor", mode: "monitor", providerAssessmentEnabled: true }), { code: "CONFORMANCE_MONITOR_OPT_IN_REQUIRED" });
  const source = registry.register({ root, sourceKey: "interactive", triggerKinds: ["observation"], mode: "opportunistic" });
  assert.equal(source.stateLocation, "host-local-process-memory");
  assert.equal(source.providerIdentityPersisted, false);
  assert.equal(registry.inspect({ root, sourceId: source.sourceId }).nextAction, "continue-ordinary-work");
  assert.equal((await registry.prepare({ root, sourceId: source.sourceId })).status, "idle");
  assert.equal(registry.inspect({ root, sourceId: source.sourceId }).source.pendingBatchId, null);
  assert.throws(() => registry.inspect({ root: other, sourceId: source.sourceId }), { code: "CONFORMANCE_TRIGGER_PROJECT_MISMATCH" });
  const observed = await ingestStructuredObservation({
    root,
    binding: { adapterKey: "lode.structured-host-observation", adapterVersion: "0.1.0", sourceScopeDigest: sha("trigger-source"), credentialReferenceNames: [] },
    descriptor: { typeKey: "example.trigger", typeVersion: "1.0.0", forms: ["event"], payloadSchema: { fields: [{ key: "changed", type: "boolean", required: true }], additionalFields: false } },
    input: { subject: { type: "example.target", key: "global" }, form: "event", temporalScope: { observedAt: "2026-09-02T00:00:00.000Z", start: null, end: null }, sourceEventKeyDigest: sha("trigger-event"), sourceEvidenceDigest: sha("trigger-evidence"), coverage: { state: "partial", basis: "bounded-event", queryDigest: null, examinedCount: 1, sourceReportedTotal: null, omittedCount: null, cursorStartDigest: null, cursorEndDigest: null }, payload: { changed: true } },
  });
  const trigger = { kind: "observation", artifactId: observed.observation.observationId, artifactHash: observed.observation.observationHash };
  assert.equal((await registry.enqueue({ root, sourceId: source.sourceId, trigger })).status, "queued");
  assert.equal((await registry.enqueue({ root, sourceId: source.sourceId, trigger })).status, "existing");
  const batch = (await registry.prepare({ root, sourceId: source.sourceId }));
  assert.equal(batch.triggers.length, 1);
  assert.equal((await registry.enqueue({ root, sourceId: source.sourceId, trigger })).status, "existing");
  assert.equal((await registry.prepare({ root, sourceId: source.sourceId })).batchId, batch.batchId);
  registry.markAssessmentUncertain({ root, sourceId: source.sourceId });
  (await assert.rejects(async () => (await registry.prepare({ root, sourceId: source.sourceId })), { code: "CONFORMANCE_TRIGGER_ASSESSMENT_UNCERTAIN" }));
  assert.throws(() => registry.completeAssessment({ root, sourceId: source.sourceId, batchId: batch.batchId }), { code: "CONFORMANCE_TRIGGER_ASSESSMENT_UNCERTAIN" });
  assert.throws(() => registry.clearUncertainAfterUserDecision({ root, sourceId: source.sourceId }), { code: "CONFORMANCE_TRIGGER_RETRY_CONFIRMATION_REQUIRED" });
  registry.clearUncertainAfterUserDecision({ root, sourceId: source.sourceId, confirmUserRetryDecision: true });
  assert.equal((await registry.prepare({ root, sourceId: source.sourceId })).batchId, batch.batchId);
  registry.completeAssessment({ root, sourceId: source.sourceId, batchId: batch.batchId });
  assert.equal(registry.inspect({ root, sourceId: source.sourceId }).source.pendingBatchId, null);
});

test("retains queued triggers when preparation fails before batch commit", async (t) => {
  const { root, layout } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = new ConformanceTriggerRegistry();
  const source = registry.register({ root, sourceKey: "atomic-prepare", triggerKinds: ["observation"], mode: "opportunistic" });
  const observed = await ingestStructuredObservation({
    root,
    binding: { adapterKey: "lode.structured-host-observation", adapterVersion: "0.1.0", sourceScopeDigest: sha("atomic-trigger-source"), credentialReferenceNames: [] },
    descriptor: { typeKey: "example.atomic-trigger", typeVersion: "1.0.0", forms: ["event"], payloadSchema: { fields: [{ key: "changed", type: "boolean", required: true }], additionalFields: false } },
    input: { subject: { type: "example.target", key: "global" }, form: "event", temporalScope: { observedAt: "2026-09-02T00:00:00.000Z", start: null, end: null }, sourceEventKeyDigest: sha("atomic-trigger-event"), sourceEvidenceDigest: sha("atomic-trigger-evidence"), coverage: { state: "partial", basis: "bounded-event", queryDigest: null, examinedCount: 1, sourceReportedTotal: null, omittedCount: null, cursorStartDigest: null, cursorEndDigest: null }, payload: { changed: true } },
  });
  (await registry.enqueue({ root, sourceId: source.sourceId, trigger: { kind: "observation", artifactId: observed.observation.observationId, artifactHash: observed.observation.observationHash } }));
  const canonFile = path.join(root, layout.directory, "context", "product-model.json");
  const canonBytes = fs.readFileSync(canonFile);
  fs.writeFileSync(canonFile, "{ invalid json\n");
  (await assert.rejects(async () => (await registry.prepare({ root, sourceId: source.sourceId })), { code: "INVALID_PRODUCT_MODEL_JSON" }));
  const afterFailure = registry.inspect({ root, sourceId: source.sourceId }).source;
  assert.equal(afterFailure.queuedTriggerCount, 1);
  assert.equal(afterFailure.pendingBatchId, null);
  fs.writeFileSync(canonFile, canonBytes);
  const batch = (await registry.prepare({ root, sourceId: source.sourceId }));
  assert.equal(batch.triggers.length, 1);
  assert.equal(registry.inspect({ root, sourceId: source.sourceId }).source.queuedTriggerCount, 0);
});

test("reports refresh omission counts only in the batch that owns the coalesced receipt", async (t) => {
  const { root, layout } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  const sourceFile = path.join(root, "src", "refresh.mjs");
  fs.writeFileSync(sourceFile, "export const revision = 0;\n");
  await buildWorldModel({ root });
  const registry = new ConformanceTriggerRegistry();
  const source = registry.register({ root, sourceKey: "refresh-coalescing", triggerKinds: ["observation", "refresh-receipt"], mode: "opportunistic" });
  const enqueueRefresh = async (receipt) => (await registry.enqueue({ root, sourceId: source.sourceId, trigger: { kind: "refresh-receipt", artifactId: receipt.refreshReceiptId, artifactHash: receipt.refreshReceiptHash } }));

  fs.writeFileSync(sourceFile, "export const revision = 1;\n");
  const first = await refreshWorldModel({ root });
  (await enqueueRefresh(first.receipt));
  fs.writeFileSync(sourceFile, "export const revision = 2;\n");
  const second = await refreshWorldModel({ root });
  (await enqueueRefresh(second.receipt));
  const observed = await ingestStructuredObservation({
    root,
    binding: { adapterKey: "lode.structured-host-observation", adapterVersion: "0.1.0", sourceScopeDigest: sha("coalescing-page-source"), credentialReferenceNames: [] },
    descriptor: { typeKey: "example.coalescing-page", typeVersion: "1.0.0", forms: ["event"], payloadSchema: { fields: [{ key: "changed", type: "boolean", required: true }], additionalFields: false } },
    input: { subject: { type: "example.target", key: "global" }, form: "event", temporalScope: { observedAt: "2026-09-02T00:00:00.000Z", start: null, end: null }, sourceEventKeyDigest: sha("coalescing-page-event"), sourceEvidenceDigest: sha("coalescing-page-evidence"), coverage: { state: "partial", basis: "bounded-event", queryDigest: null, examinedCount: 1, sourceReportedTotal: null, omittedCount: null, cursorStartDigest: null, cursorEndDigest: null }, payload: { changed: true } },
  });
  (await registry.enqueue({ root, sourceId: source.sourceId, trigger: { kind: "observation", artifactId: observed.observation.observationId, artifactHash: observed.observation.observationHash } }));
  assert.equal(registry.inspect({ root, sourceId: source.sourceId }).source.queuedCoalescedRefreshCount, 1);
  const leadingBatch = (await registry.prepare({ root, sourceId: source.sourceId, limit: 1 }));
  assert.equal(leadingBatch.triggers[0].kind, "observation");
  assert.equal(leadingBatch.coalescedRefreshCount, 0);
  assert.equal(registry.inspect({ root, sourceId: source.sourceId }).source.queuedCoalescedRefreshCount, 1);
  registry.completeAssessment({ root, sourceId: source.sourceId, batchId: leadingBatch.batchId });
  const firstBatch = (await registry.prepare({ root, sourceId: source.sourceId }));
  assert.equal(firstBatch.coalescedRefreshCount, 1);
  assert.equal(firstBatch.triggers[0].artifactId, second.receipt.refreshReceiptId);
  registry.completeAssessment({ root, sourceId: source.sourceId, batchId: firstBatch.batchId });

  fs.writeFileSync(sourceFile, "export const revision = 3;\n");
  const third = await refreshWorldModel({ root });
  (await enqueueRefresh(third.receipt));
  fs.writeFileSync(sourceFile, "export const revision = 4;\n");
  const fourth = await refreshWorldModel({ root });
  (await enqueueRefresh(fourth.receipt));
  const secondBatch = (await registry.prepare({ root, sourceId: source.sourceId }));
  assert.equal(secondBatch.coalescedRefreshCount, 1);
  assert.equal(secondBatch.triggers[0].artifactId, fourth.receipt.refreshReceiptId);
  registry.markAssessmentUncertain({ root, sourceId: source.sourceId });
  registry.clearUncertainAfterUserDecision({ root, sourceId: source.sourceId, confirmUserRetryDecision: true });
  assert.equal((await registry.prepare({ root, sourceId: source.sourceId })).coalescedRefreshCount, 1);
});

test("exposes the same conversational Core flow through typed MCP without Host configuration", async (t) => {
  const { root, layout } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "mcp.mjs"), "export const mcp = true;\n");
  const requiredTools = ["lode_conformance_prepare", "lode_conformance_propose", "lode_conformance_queue", "lode_conformance_read", "lode_conformance_disposition", "lode_conformance_resolution_propose", "lode_conformance_trigger_status", "lode_conformance_trigger_prepare"];
  assert.equal(requiredTools.every((name) => mcpTools.some((tool) => tool.name === name)), true);
  const preparedResponse = await dispatchMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "head_conformance_prepare", arguments: { project_root: root } } });
  const prepared = preparedResponse.result.structuredContent;
  const anchor = sourceAnchor(root, "src/mcp.mjs");
  const proposedResponse = await dispatchMcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "head_conformance_propose", arguments: {
    project_root: root,
    baseline: { product_model_id: prepared.baseline.productModelId, product_model_hash: prepared.baseline.productModelHash, world_model_id: null, world_model_hash: null, source_snapshot_id: null, graph_snapshot_id: null },
    findings: [{ canon_anchor: { entity_kind: "Constraint", entity_key: "constraint.0" }, evidence_anchors: [{ kind: "source", path: anchor.path, file_digest: anchor.fileDigest, start_line: anchor.startLine, end_line: anchor.endLine, excerpt_digest: anchor.excerptDigest, revision_id: null, symbol_id: null }], claim: { kind: "potential-conflict", summary: "MCP candidate.", rationale: "Provider HEAD cites exact evidence.", risk_hint: "unknown" } }],
  } } });
  assert.equal(proposedResponse.result.structuredContent.ordinaryWorkBlocked, false);
  const unavailable = await dispatchMcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "head_conformance_trigger_status", arguments: { project_root: root, source_id: `conformance-trigger-source-${"0".repeat(24)}` } } });
  assert.equal(unavailable.result.structuredContent.status, "optional-host-adapter-unavailable");
  assert.equal(unavailable.result.structuredContent.ordinaryWorkBlocked, false);
});

test("normalizes omitted whole-file source fields before shared CLI and Core verification", async (t) => {
  const { root, layout } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  const sourceFile = path.join(root, "src", "whole-file.mjs");
  fs.writeFileSync(sourceFile, "export const wholeFile = true;\n");
  const prepared = (await prepareConformanceAssessment({ root }));
  const omitted = { kind: "source", path: "src/whole-file.mjs", fileDigest: sha(fs.readFileSync(sourceFile)) };
  const explicitNull = { ...omitted, startLine: null, endLine: null, excerptDigest: null, revisionId: null, symbolId: null };
  const findingInput = (anchor, summary) => ({
    root,
    baseline: prepared.baseline,
    findings: [{
      canonAnchor: { entityKind: "Constraint", entityKey: "constraint.0" },
      evidenceAnchors: [anchor],
      claim: { kind: "potential-conflict", summary, rationale: "The whole-file digest is exact mechanical evidence.", riskHint: "low" },
    }],
  });
  const omittedFinding = (await proposeConformanceFindings(findingInput(omitted, "Whole-file omitted-field proposal.")));
  const nullReplay = (await proposeConformanceFindings(findingInput(explicitNull, "Equivalent explicit-null proposal.")));
  assert.equal(omittedFinding.status, "recorded");
  assert.equal(nullReplay.status, "existing");
  assert.equal(nullReplay.findings[0].findingId, omittedFinding.findings[0].findingId);
  const stored = readConformanceFinding({ root, findingId: omittedFinding.findings[0].findingId });
  assert.deepEqual(stored.finding.evidenceAnchors[0], explicitNull);
  const omittedResolution = (await proposeConformanceResolution({ root, findingId: stored.finding.findingId, baseline: prepared.baseline, evidenceAnchors: [omitted], assessment: "appears-resolved", rationale: "The same whole-file evidence now appears resolved." }));
  const nullResolutionReplay = (await proposeConformanceResolution({ root, findingId: stored.finding.findingId, baseline: prepared.baseline, evidenceAnchors: [explicitNull], assessment: "appears-resolved", rationale: "The same whole-file evidence now appears resolved." }));
  assert.equal(omittedResolution.status, "recorded");
  assert.equal(nullResolutionReplay.status, "existing");
  assert.equal(nullResolutionReplay.resolution.resolutionId, omittedResolution.resolution.resolutionId);
});

test("revalidates resolution evidence only for a new acceptance and preserves exact recorded replay", async (t) => {
  const { root, layout } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  const sourceFile = path.join(root, "src", "resolution.mjs");
  fs.writeFileSync(sourceFile, "export const enabled = false;\n");
  const canonFile = path.join(root, layout.directory, "context", "product-model.json");
  const sessionFile = path.join(root, layout.directory, "sessions", "current.json");
  const canonBefore = fs.readFileSync(canonFile, "utf8");
  const sessionBefore = fs.readFileSync(sessionFile, "utf8");
  const initial = (await prepareConformanceAssessment({ root }));
  const finding = (await proposeConformanceFindings(proposal(root, initial, "src/resolution.mjs"))).findings[0];
  fs.writeFileSync(sourceFile, "export const enabled = true;\n");
  const resolutionBaseline = (await prepareConformanceAssessment({ root }));
  const staleResolution = (await proposeConformanceResolution({ root, findingId: finding.findingId, baseline: resolutionBaseline.baseline, evidenceAnchors: [sourceAnchor(root, "src/resolution.mjs")], assessment: "appears-resolved", rationale: "The exact current source appears to resolve the Finding." })).resolution;
  fs.writeFileSync(sourceFile, "export const enabled = false; // later edit\n");
  await assert.rejects(
    async () => (await recordConformanceDisposition({ root, findingId: finding.findingId, disposition: "accept-resolution", rationale: "Accept this exact resolution candidate.", resolutionId: staleResolution.resolutionId, confirmUserDisposition: true })),
    (error) => error.code === "CONFORMANCE_RESOLUTION_STALE" && /Ordinary work remains available/.test(error.message),
  );
  assert.equal(readConformanceFinding({ root, findingId: finding.findingId }).dispositions.length, 0);
  assert.notEqual((await inspectConformanceQueue({ root })).findings[0].status, "closed-resolved");
  assert.equal((await inspectConformanceQueue({ root })).ordinaryWorkBlocked, false);

  const currentBaseline = (await prepareConformanceAssessment({ root }));
  const currentResolution = (await proposeConformanceResolution({ root, findingId: finding.findingId, baseline: currentBaseline.baseline, evidenceAnchors: [sourceAnchor(root, "src/resolution.mjs")], assessment: "appears-resolved", rationale: "HEAD reassessed the later exact source." })).resolution;
  const request = { root, findingId: finding.findingId, disposition: "accept-resolution", rationale: "Accept the current exact resolution candidate.", resolutionId: currentResolution.resolutionId, confirmUserDisposition: true };
  const accepted = (await recordConformanceDisposition(request));
  assert.equal(accepted.status, "recorded");
  assert.equal((await inspectConformanceQueue({ root })).findings[0].status, "closed-resolved");
  fs.writeFileSync(sourceFile, "export const enabled = true; // post-decision edit\n");
  const exactReplay = (await recordConformanceDisposition(request));
  assert.equal(exactReplay.status, "existing");
  assert.equal(exactReplay.disposition.dispositionId, accepted.disposition.dispositionId);
  assert.equal(readConformanceFinding({ root, findingId: finding.findingId }).dispositions.length, 1);
  assert.equal(fs.readFileSync(canonFile, "utf8"), canonBefore);
  assert.equal(fs.readFileSync(sessionFile, "utf8"), sessionBefore);
});

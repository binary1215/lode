import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { formatForVerifiedOwner } from "../scripts/lib/project-storage-format.mjs";
import {
  assessMetricComparison,
  compareMetricObservations,
  defineMetric,
  inspectMeasurements,
  recordMetricObservation,
  traceMeasurementLineage,
} from "../scripts/lib/measurement-workflow.mjs";
import { proposeProductInitiative, reviewProductInitiative } from "../scripts/lib/product-operating-loop.mjs";
import { queryTemporalProvenanceGraph } from "../scripts/lib/temporal-provenance.mjs";
import { inspectWorldModel } from "../scripts/lib/world-model.mjs";
import { runCommand } from "../scripts/head.mjs";
import { dispatch, catalogTools as tools } from "../scripts/mcp-server.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testParent = process.env.HEAD_AGENT_TEST_TMP || os.tmpdir();
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");

function fixture(t) {
  fs.mkdirSync(testParent, { recursive: true });
  const root = fs.mkdtempSync(path.join(testParent, "head-agent-measurement-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  const layout = formatForVerifiedOwner(storage);
  return { root, storage, layout };
}

function observationInput(overrides = {}) {
  return {
    metricKey: "request-latency",
    subjectType: "service",
    subjectKey: "public-api",
    value: 120,
    observedAt: "2026-01-01T00:00:00.000Z",
    coverage: {
      state: "complete",
      queryDigest: sha("bounded-query"),
      examinedCount: 1,
      sourceReportedTotal: 1,
      omittedCount: 0,
    },
    sourceScopeDigest: sha("bounded-source-scope"),
    sourceEventKeyDigest: sha("baseline-event"),
    sourceEvidenceDigest: sha("baseline-evidence"),
    ...overrides,
  };
}

test("metric evidence remains P3/P4, discloses partial coverage, and requires the existing initiative review for follow-up", async (t) => {
  const { root, layout } = fixture(t);
  const canonFile = path.join(root, layout.directory, "context", "product-model.json");
  const sessionFile = path.join(root, layout.directory, "sessions", "current.json");
  const canonBefore = fs.readFileSync(canonFile, "utf8");
  const sessionBefore = fs.readFileSync(sessionFile, "utf8");

  const defined = await defineMetric({ root, metricKey: "request-latency", unit: "milliseconds", direction: "decrease" });
  assert.equal(defined.definition.authority, "P3-data-shape-and-measurement-proposal-not-product-canon");
  assert.equal(defined.ordinaryWorkBlocked, false);

  const baseline = await recordMetricObservation({ root, ...observationInput() });
  const current = await recordMetricObservation({ root, ...observationInput({
    value: 90,
    observedAt: "2026-01-02T00:00:00.000Z",
    coverage: { state: "partial", basis: "bounded-window", examinedCount: 1 },
    sourceEventKeyDigest: sha("current-event"),
    sourceEvidenceDigest: sha("current-evidence"),
  }) });
  const compared = await compareMetricObservations({
    root,
    baselineObservationId: baseline.observation.observationId,
    currentObservationId: current.observation.observationId,
  });
  assert.equal(compared.comparison.payload.absolute_change, -30);
  assert.equal(compared.comparison.coverage.state, "partial");
  assert.equal(compared.comparability.underlyingCoverageComplete, false);
  assert.equal(compared.causalityEstablished, false);
  assert.equal(compared.ordinaryWorkBlocked, false);

  const assessed = await assessMetricComparison({
    root,
    comparisonObservationId: compared.comparison.derivedObservationId,
    assessment: "supports",
    statement: "The exact comparison supports investigating the bounded change.",
  });
  assert.equal(assessed.causalityEstablished, false);
  assert.match(assessed.hypothesis.rationale, /Causality is not established\./);
  assert.equal(assessed.conformanceQueueMutated, false);

  const followUp = await proposeProductInitiative({
    root,
    hypothesisIds: [assessed.hypothesis.hypothesisId],
    title: "Investigate the measured latency change",
    reasoning: "Follow up on the exact metric assessment without treating correlation as causation.",
  });
  assert.equal(followUp.status, "recorded");
  assert.equal(followUp.initiativeCandidate.authority, "candidate-not-approved-decision");
  assert.equal(followUp.initiativeCandidate.instructionAuthority, false);
  assert.equal(followUp.initiativeCandidate.promotionAuthority, false);
  assert.deepEqual(followUp.initiativeCandidate.hypothesisIds, [assessed.hypothesis.hypothesisId]);
  assert.equal(fs.readFileSync(canonFile, "utf8"), canonBefore);
  assert.equal(fs.readFileSync(sessionFile, "utf8"), sessionBefore);
  assert.equal(fs.existsSync(path.join(root, layout.directory, "conformance")), false);

  const graph = (await inspectWorldModel({ root })).snapshot.temporalProvenanceGraph;
  const ids = new Set(graph.nodes.map((node) => node.nodeId));
  assert.ok(ids.has(defined.descriptor.descriptorId));
  assert.ok(ids.has(baseline.observation.observationId));
  assert.ok(ids.has(current.observation.observationId));
  assert.ok(ids.has(compared.comparison.derivedObservationId));
  assert.ok(ids.has(assessed.hypothesis.hypothesisId));
  assert.ok(ids.has(followUp.initiativeCandidate.initiativeCandidateId));
  assert.ok(graph.edges.some((edge) => edge.type === "DERIVED_FROM" && edge.from === compared.comparison.derivedObservationId && edge.to === baseline.observation.observationId));
  assert.ok(graph.edges.some((edge) => edge.type === "REFERENCES" && edge.from === assessed.hypothesis.hypothesisId && edge.to === compared.comparison.derivedObservationId));
  assert.ok(graph.edges.some((edge) => edge.type === "PROPOSES_FROM" && edge.from === followUp.initiativeCandidate.initiativeCandidateId && edge.to === assessed.hypothesis.hypothesisId));
  assert.equal(graph.nodes.some((node) => node.kind === "ProductInitiativeReviewDecision"), false);
  const trace = (await traceMeasurementLineage({ root, anchorId: compared.comparison.derivedObservationId }));
  const reference = queryTemporalProvenanceGraph(graph, trace.queryParameters);
  assert.equal(trace.graph.resultId, reference.resultId);
  assert.equal(trace.graph.resultHash, reference.resultHash);
  assert.deepEqual(trace.graph.nodes, reference.nodes);
  assert.deepEqual(trace.graph.edges, reference.edges);
  assert.equal(trace.authority.ordinaryWorkBlocked, false);
  assert.equal(trace.semantics.correlationImpliesCausation, false);
  const reviewed = await reviewProductInitiative({ root, initiativeCandidateId: followUp.initiativeCandidate.initiativeCandidateId,
    disposition: "accept", rationale: "The exact hypothesis is a conditional follow-up, not a proved effect.",
    featureResolution: { kind: "gap", reason: "No Product Canon feature decision is implied." } });
  assert.equal(reviewed.reviewDecision.initiativeCandidateId, followUp.initiativeCandidate.initiativeCandidateId);
  assert.equal(reviewed.reviewDecision.initiativeCandidateHash, followUp.initiativeCandidate.initiativeCandidateHash);
  assert.equal(reviewed.productCanonMutated, false);
  assert.equal(fs.readFileSync(canonFile, "utf8"), canonBefore);
  assert.equal(fs.readFileSync(sessionFile, "utf8"), sessionBefore);
});

test("metric comparison fails closed only for real comparability mismatches", async (t) => {
  const { root, layout } = fixture(t);
  const firstDefinition = await defineMetric({ root, metricKey: "request-latency", unit: "milliseconds", direction: "decrease", typeVersion: "1" });
  const exactDefinitionReplay = await defineMetric({ root, metricKey: "request-latency", unit: "milliseconds", direction: "decrease", typeVersion: "1" });
  assert.equal(exactDefinitionReplay.status, "existing");
  assert.equal(exactDefinitionReplay.descriptor.descriptorHash, firstDefinition.descriptor.descriptorHash);
  await assert.rejects(
    async () => (await defineMetric({ root, metricKey: "request-latency", unit: "seconds", direction: "decrease", typeVersion: "1" })),
    { code: "METRIC_DEFINITION_CONFLICT" },
  );
  await defineMetric({ root, metricKey: "request-latency", unit: "seconds", direction: "decrease", typeVersion: "2" });
  const baseline = await recordMetricObservation({ root, ...observationInput({
    typeVersion: "1",
    form: "aggregate",
    start: "2026-01-01T00:00:00.000Z",
    end: "2026-01-02T00:00:00.000Z",
    observedAt: "2026-01-02T00:00:00.000Z",
    sampleSize: 100,
  }) });
  const comparable = await recordMetricObservation({ root, ...observationInput({
    typeVersion: "1",
    value: 110,
    form: "aggregate",
    start: "2026-01-02T00:00:00.000Z",
    end: "2026-01-03T00:00:00.000Z",
    observedAt: "2026-01-03T00:00:00.000Z",
    sampleSize: 100,
    sourceEventKeyDigest: sha("comparable-event"),
    sourceEvidenceDigest: sha("comparable-evidence"),
  }) });
  const comparableResult = await compareMetricObservations({
    root,
    baselineObservationId: baseline.observation.observationId,
    currentObservationId: comparable.observation.observationId,
  });
  assert.equal(comparableResult.comparability.recordedCollectionConditionsEquivalent, true);
  assert.equal(comparableResult.comparability.semanticEquivalenceEstablished, false);
  assert.equal(comparableResult.comparability.semanticEquivalenceAssessment, "not-assessed");
  const otherVersion = await recordMetricObservation({ root, ...observationInput({
    typeVersion: "2",
    value: 0.09,
    observedAt: "2026-01-02T00:00:00.000Z",
    sourceEventKeyDigest: sha("other-version-event"),
    sourceEvidenceDigest: sha("other-version-evidence"),
  }) });
  await assert.rejects(async () => (await compareMetricObservations({ root, baselineObservationId: baseline.observation.observationId, currentObservationId: otherVersion.observation.observationId })), { code: "INCOMPARABLE_METRIC_OBSERVATIONS" });

  const otherSubject = await recordMetricObservation({ root, ...observationInput({
    typeVersion: "1",
    subjectKey: "internal-api",
    value: 95,
    observedAt: "2026-01-02T00:00:00.000Z",
    sourceEventKeyDigest: sha("other-subject-event"),
    sourceEvidenceDigest: sha("other-subject-evidence"),
  }) });
  await assert.rejects(async () => (await compareMetricObservations({ root, baselineObservationId: baseline.observation.observationId, currentObservationId: otherSubject.observation.observationId })), { code: "INCOMPARABLE_METRIC_OBSERVATIONS" });
  assert.equal(inspectMeasurements({ root }).ordinaryWorkBlocked, false);
});

test("metric observation retry without an observed timestamp reuses the durable event time", async (t) => {
  const { root, layout } = fixture(t);
  await defineMetric({ root, metricKey: "request-latency", unit: "milliseconds", direction: "decrease" });
  const input = observationInput();
  delete input.observedAt;
  const first = await recordMetricObservation({ root, ...input });
  const replay = await recordMetricObservation({ root, ...input });
  assert.equal(replay.status, "existing");
  assert.equal(replay.observation.observationId, first.observation.observationId);
  assert.equal(replay.observation.temporalScope.observedAt, first.observation.temporalScope.observedAt);
  await assert.rejects(
    async () => (await recordMetricObservation({ root, ...input, value: 121 })),
    { code: "DIVERGENT_OBSERVATION_REPLAY" },
  );
});

test("metric comparison remains available while disclosing unequal collection conditions", async (t) => {
  const { root, layout } = fixture(t);
  await defineMetric({ root, metricKey: "request-latency", unit: "milliseconds", direction: "decrease" });
  const baseline = await recordMetricObservation({ root, ...observationInput({
    form: "aggregate",
    start: "2026-01-01T00:00:00.000Z",
    end: "2026-01-02T00:00:00.000Z",
    observedAt: "2026-01-02T00:00:00.000Z",
    sampleSize: 100,
  }) });
  const current = await recordMetricObservation({ root, ...observationInput({
    form: "aggregate",
    start: "2026-01-02T00:00:00.000Z",
    end: "2026-01-09T00:00:00.000Z",
    observedAt: "2026-01-09T00:00:00.000Z",
    sampleSize: 1000,
    value: 90,
    adapterVersion: "2.0.0",
    sourceScopeDigest: sha("different-source-scope"),
    sourceEventKeyDigest: sha("condition-current-event"),
    sourceEvidenceDigest: sha("condition-current-evidence"),
  }) });
  const result = await compareMetricObservations({
    root,
    baselineObservationId: baseline.observation.observationId,
    currentObservationId: current.observation.observationId,
  });
  assert.equal(result.comparison.payload.absolute_change, -30);
  assert.equal(result.comparability.numericComparisonAvailable, true);
  assert.equal(result.comparability.recordedCollectionConditionsEquivalent, false);
  assert.equal(result.comparability.semanticEquivalenceEstablished, false);
  assert.equal(result.comparability.semanticEquivalenceAssessment, "not-assessed");
  assert.equal(result.comparability.collectionConditions.sourceScope.state, "different");
  assert.equal(result.comparability.collectionConditions.adapter.key.state, "same");
  assert.equal(result.comparability.collectionConditions.adapter.version.state, "different");
  assert.equal(result.comparability.collectionConditions.adapter.descriptorDigest.state, "different");
  assert.equal(result.comparability.collectionConditions.form.state, "same");
  assert.equal(result.comparability.collectionConditions.duration.state, "different");
  assert.equal(result.comparability.collectionConditions.sampleSize.state, "different");
  assert.equal(result.comparability.collectionConditions.normalizationApplied, false);
  assert.match(result.comparability.collectionConditions.interpretation, /^conditional-/);
  assert.equal(result.comparison.coverage.state, "partial");
  assert.equal(result.causalityEstablished, false);
  assert.equal(result.ordinaryWorkBlocked, false);
});

test("CLI and typed MCP expose the same nonblocking metric status", async (t) => {
  const { root, layout } = fixture(t);
  assert.ok(tools.some((tool) => tool.name === "lode_metric_define"));
  assert.ok(tools.some((tool) => tool.name === "lode_metric_status"));
  assert.ok(tools.some((tool) => tool.name === "lode_metric_trace"));
  const defined = await dispatch({ jsonrpc: "2.0", id: "metric-define", method: "tools/call", params: { name: "head_metric_define", arguments: {
    project_root: root, metric_key: "request-latency", unit: "milliseconds", direction: "decrease",
  } } });
  assert.equal(defined.error, undefined, JSON.stringify(defined.error));
  const mcp = await dispatch({ jsonrpc: "2.0", id: "metric-status", method: "tools/call", params: { name: "head_metric_status", arguments: { project_root: root } } });
  assert.equal(mcp.error, undefined, JSON.stringify(mcp.error));
  const cli = await runCommand(["metric-status", root]);
  assert.equal(mcp.result.structuredContent.status, cli.status);
  assert.deepEqual(mcp.result.structuredContent.definitions, cli.definitions);
  const traceMcp = await dispatch({ jsonrpc: "2.0", id: "metric-trace", method: "tools/call", params: { name: "head_metric_trace", arguments: { project_root: root, metric_key: "request-latency", depth: 0 } } });
  assert.equal(traceMcp.error, undefined, JSON.stringify(traceMcp.error));
  const traceCli = await runCommand(["metric-trace", root, "--metric", "request-latency", "--depth", "0"]);
  assert.equal(traceMcp.result.structuredContent.graph.resultId, traceCli.graph.resultId);
});

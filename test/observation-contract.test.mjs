import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { formatForVerifiedOwner } from "../scripts/lib/project-storage-format.mjs";
import { compileContext } from "../scripts/lib/context-compiler.mjs";
import {
  JsonEventFileObservationAdapter,
  ObservationAdapterRegistry,
  StructuredObservationAdapter,
  collectObservation,
  ingestJsonObservationEventFile,
  ingestStructuredObservation,
  inspectObservationSources,
} from "../scripts/lib/observation-adapter.mjs";
import { createObservationTypeDescriptor } from "../scripts/lib/observation-contract.mjs";
import { loadObservationProjection, queryObservations } from "../scripts/lib/observation-projection.mjs";
import { recordCollectedObservation, recordDerivedObservation } from "../scripts/lib/observation-store.mjs";
import { prepareObservationEvidence } from "../scripts/lib/observation-workflow.mjs";
import { recordProductHypothesis, recordProductSignal } from "../scripts/lib/product-operating-loop.mjs";
import { buildWorldModel, inspectWorldModelStatus, readWorldModel } from "../scripts/lib/world-model.mjs";
import { runCommand } from "../scripts/head.mjs";
import { dispatch as dispatchMcp, catalogTools as mcpTools } from "../scripts/mcp-server.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testParent = process.env.HEAD_AGENT_TEST_TMP || os.tmpdir();
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");

function fixture() {
  fs.mkdirSync(testParent, { recursive: true });
  const root = fs.mkdtempSync(path.join(testParent, "head-agent-observation-"));
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  const layout = formatForVerifiedOwner(storage);
  return { root, storage, layout };
}

function descriptor(typeKey, fields, forms = ["event", "snapshot", "aggregate"]) {
  return { typeKey, typeVersion: "1.0.0", forms, payloadSchema: { fields, additionalFields: false } };
}

function coverage(overrides = {}) {
  return {
    state: "complete",
    basis: "enumerated-bounded-query",
    queryDigest: sha("query"),
    examinedCount: 1,
    sourceReportedTotal: 1,
    omittedCount: 0,
    cursorStartDigest: null,
    cursorEndDigest: null,
    ...overrides,
  };
}

function binding() {
  return {
    adapterKey: "lode.structured-host-observation",
    adapterVersion: "0.1.0",
    sourceScopeDigest: sha("bounded-source-scope"),
    credentialReferenceNames: ["HEAD_TEST_SOURCE_TOKEN"],
  };
}

function fileBinding(source = "bounded-ci-event-file") {
  return {
    adapterKey: "lode.json-event-file-observation",
    adapterVersion: "0.1.0",
    sourceScopeDigest: sha(source),
    credentialReferenceNames: ["HEAD_TEST_CI_TOKEN"],
  };
}

function event({ eventKey = "build-42", subjectType = "example.ci.target", payload = { succeeded: true } } = {}) {
  return {
    schemaVersion: 1,
    eventKey,
    subject: { type: subjectType, key: "app" },
    form: "event",
    temporalScope: { observedAt: "2026-09-01T01:00:00.000Z", start: null, end: null },
    coverage: coverage(),
    payload,
  };
}

function projectArtifactText(root, layout) {
  const pending = [path.join(root, layout.directory)];
  const content = [];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) content.push(fs.readFileSync(target, "utf8"));
    }
  }
  return content.join("\n");
}

function input({ suffix, subjectType, payload, form = "event", coverageValue = coverage() }) {
  return {
    subject: { type: subjectType, key: "global" },
    form,
    temporalScope: { observedAt: "2026-09-01T00:00:00.000Z", start: form === "aggregate" ? "2026-08-31T23:00:00.000Z" : null, end: form === "aggregate" ? "2026-09-01T00:00:00.000Z" : null },
    sourceEventKeyDigest: sha(`event:${suffix}`),
    sourceEvidenceDigest: sha(`evidence:${suffix}`),
    coverage: coverageValue,
    payload,
  };
}

test("uses one evidence-only contract across unrelated typed product observations", async (t) => {
  const { root, storage, layout } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const canonFile = path.join(root, layout.directory, "context", "product-model.json");
  const sessionFile = path.join(root, layout.directory, "sessions", "current.json");
  const canonBefore = fs.readFileSync(canonFile, "utf8");
  const sessionBefore = fs.readFileSync(sessionFile, "utf8");

  const cases = [
    { key: "head.build.result", type: "head.build.target", fields: [{ key: "succeeded", type: "boolean", required: true }], payload: { succeeded: true } },
    { key: "example.billing.failure-summary", type: "example.billing.checkout", fields: [{ key: "failureCount", type: "nonnegative-integer", required: true }], payload: { failureCount: 3 } },
    { key: "example.support.ticket-volume", type: "example.support.queue", fields: [{ key: "ticketCount", type: "nonnegative-integer", required: true }], payload: { ticketCount: 7 } },
  ];
  const observations = [];
  for (const [index, value] of cases.entries()) {
    const recorded = await ingestStructuredObservation({ root, binding: binding(), descriptor: descriptor(value.key, value.fields), input: input({ suffix: index, subjectType: value.type, payload: value.payload }) });
    observations.push(recorded.observation);
    assert.equal(recorded.authority.productCanonMutated, false);
    assert.equal(recorded.sourceBinding.credentialsPersisted, false);
  }
  assert.equal(fs.readFileSync(canonFile, "utf8"), canonBefore);
  assert.equal(fs.readFileSync(sessionFile, "utf8"), sessionBefore);
  const project = JSON.parse(fs.readFileSync(path.join(root, layout.directory, "project.json"), "utf8"));
  const projection = loadObservationProjection({ projectRoot: root, projectId: project.projectId, storage });
  assert.equal(projection.observationIds.length, 3);
  assert.deepEqual(projection.graphPolicy.automaticRelations, ["CONFORMS_TO", "DERIVED_FROM", "EVIDENCED_BY"]);
  assert.equal(projection.graphPolicy.automaticSemanticRelations, false);
  assert.equal(projection.nodes.filter((node) => node.kind === "ObservationRecord").every((node) => node.contextEligibility === "exact-evidence-need-only"), true);
  assert.equal(projection.edges.some((edge) => ["IMPACTS", "MEASURES", "MOTIVATES", "GOVERNS"].includes(edge.type)), false);

  const replay = await ingestStructuredObservation({ root, binding: binding(), descriptor: descriptor(cases[0].key, cases[0].fields), input: input({ suffix: 0, subjectType: cases[0].type, payload: cases[0].payload }) });
  assert.equal(replay.status, "existing");
  assert.equal(replay.observation.observationId, observations[0].observationId);
});

test("collects product-shaped CI events through a process-local Host registry without persisting Host secrets", async (t) => {
  const { root, storage, layout } = fixture();
  const hostRoot = fs.mkdtempSync(path.join(testParent, "head-agent-observation-host-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(hostRoot, { recursive: true, force: true }));
  const eventFile = path.join(hostRoot, "ci-event.json");
  const rawEventKey = "provider-build-run-42";
  const rawCredentialReference = "HEAD_TEST_CI_TOKEN";
  fs.writeFileSync(eventFile, JSON.stringify(event({ eventKey: rawEventKey })));
  const type = descriptor("example.ci.build-result", [{ key: "succeeded", type: "boolean", required: true }], ["event"]);
  const canonFile = path.join(root, layout.directory, "context", "product-model.json");
  const sessionFile = path.join(root, layout.directory, "sessions", "current.json");
  const canonBefore = fs.readFileSync(canonFile, "utf8");
  const sessionBefore = fs.readFileSync(sessionFile, "utf8");

  const registry = new ObservationAdapterRegistry();
  const registered = registry.register({
    projectRoot: root,
    sourceKey: "ci-main",
    binding: fileBinding(),
    descriptor: type,
    adapter: new JsonEventFileObservationAdapter({ descriptor: type, eventFile }, storage),
  });
  assert.equal(registered.stateLocation, "host-local-outside-project");
  assert.equal(registered.productMeaningAssigned, false);
  assert.equal(registry.inspect({ root }).configuredSourceCount, 1);
  const collected = await registry.collect({ root, sourceKey: "ci-main" });
  assert.equal(collected.status, "recorded");
  assert.equal(collected.observation.typeKey, "example.ci.build-result");
  assert.equal(collected.authority.productCanonMutated, false);
  assert.equal(fs.readFileSync(canonFile, "utf8"), canonBefore);
  assert.equal(fs.readFileSync(sessionFile, "utf8"), sessionBefore);
  const persisted = projectArtifactText(root, layout);
  assert.equal(persisted.includes(eventFile), false);
  assert.equal(persisted.includes(rawEventKey), false);
  assert.equal(persisted.includes(rawCredentialReference), false);
  assert.equal(persisted.includes("ci-main"), false);

  const replay = await registry.collect({ root, sourceKey: "ci-main" });
  assert.equal(replay.status, "existing");
  fs.writeFileSync(eventFile, JSON.stringify(event({ eventKey: rawEventKey, payload: { succeeded: false } })));
  await assert.rejects(() => registry.collect({ root, sourceKey: "ci-main" }), (error) => error.code === "DIVERGENT_OBSERVATION_REPLAY");
});

test("bounds Host source projection without imposing an arbitrary registration gate", async (t) => {
  const { root, storage, layout } = fixture();
  const hostRoot = fs.mkdtempSync(path.join(testParent, "head-agent-observation-host-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(hostRoot, { recursive: true, force: true }));
  const eventFile = path.join(hostRoot, "event.json");
  fs.writeFileSync(eventFile, JSON.stringify(event()));
  const type = descriptor("example.ci.build-result", [{ key: "succeeded", type: "boolean", required: true }], ["event"]);
  const adapter = new JsonEventFileObservationAdapter({ descriptor: type, eventFile }, storage);
  const registry = new ObservationAdapterRegistry();
  registry.register({ projectRoot: root, sourceKey: "ci-main", binding: fileBinding(), descriptor: type, adapter });
  assert.throws(() => registry.register({ projectRoot: root, sourceKey: "ci-main", binding: fileBinding(), descriptor: type, adapter }), { code: "DUPLICATE_OBSERVATION_ADAPTER_SOURCE" });
  await assert.rejects(() => registry.collect({ root, sourceKey: "missing" }), (error) => error.code === "OBSERVATION_ADAPTER_SOURCE_NOT_FOUND");
  assert.throws(() => new JsonEventFileObservationAdapter({ descriptor: type, eventFile: "relative-event.json" }), { code: "INVALID_OBSERVATION_EVENT_FILE" });
  assert.throws(() => new JsonEventFileObservationAdapter({ descriptor: type, eventFile, maxBytes: 512 * 1024 + 1 }), { code: "INVALID_OBSERVATION_EVENT_FILE_BOUND" });
  const tiny = new ObservationAdapterRegistry();
  tiny.register({ projectRoot: root, sourceKey: "tiny", binding: fileBinding("tiny"), descriptor: type, adapter: new JsonEventFileObservationAdapter({ descriptor: type, eventFile, maxBytes: 1 }, storage) });
  await assert.rejects(() => tiny.collect({ root, sourceKey: "tiny" }), (error) => error.code === "UNSAFE_OBSERVATION_EVENT_FILE");
  fs.writeFileSync(eventFile, JSON.stringify({ ...event(), unexpected: true }));
  await assert.rejects(() => registry.collect({ root, sourceKey: "ci-main" }), (error) => error.code === "INVALID_OBSERVATION_SOURCE_EVENT");

  const bounded = new ObservationAdapterRegistry();
  for (let index = 0; index < 80; index += 1) bounded.register({
    projectRoot: root,
    sourceKey: `source-${index}`,
    binding: fileBinding(`scope-${index}`),
    descriptor: type,
    adapter: new JsonEventFileObservationAdapter({ descriptor: type, eventFile }, storage),
    availability: index % 2 ? { state: "ready", observedAt: "2026-09-01T01:00:00.000Z" } : { state: "unavailable", observedAt: "2026-09-01T01:00:00.000Z", reasonCode: "maintenance" },
  });
  const status = bounded.inspect({ root });
  assert.equal(status.configuredSourceCount, 80);
  assert.equal(status.sources.length, 64);
  assert.equal(status.bounded.returnedSourceCount, 64);
  assert.equal(status.bounded.omittedSourceCount, 16);
  assert.equal(bounded.inspect({ root, limit: 10 }).sources.length, 10);
  assert.throws(() => bounded.inspect({ root, limit: 65 }), { code: "INVALID_OBSERVATION_ADAPTER_INSPECTION_LIMIT" });
  const readyPage = bounded.inspect({ root, availabilityState: "ready", limit: 10 });
  assert.equal(readyPage.matchingSourceCount, 40);
  assert.equal(readyPage.sources.every((source) => source.availability.state === "ready"), true);
  assert.equal(readyPage.sources.every((source) => source.shape.typeKey === "example.ci.build-result"), true);
  assert.equal(readyPage.sources.every((source) => source.shape.semanticAuthority === false), true);
  assert.equal(readyPage.nextCursor.projectionId, readyPage.projectionId);
  const secondPage = bounded.inspect({ root, availabilityState: "ready", limit: 10, projectionId: readyPage.nextCursor.projectionId, cursor: readyPage.nextCursor.sourceId });
  assert.equal(secondPage.sources.length, 10);
  assert.notEqual(secondPage.sources[0].sourceId, readyPage.sources[0].sourceId);
  bounded.register({ projectRoot: root, sourceKey: "source-new", binding: fileBinding("scope-new"), descriptor: type, adapter: new JsonEventFileObservationAdapter({ descriptor: type, eventFile }, storage), availability: { state: "ready" } });
  const resynchronized = bounded.inspect({ root, availabilityState: "ready", limit: 10, projectionId: readyPage.nextCursor.projectionId, cursor: readyPage.nextCursor.sourceId });
  assert.equal(resynchronized.resynchronization.occurred, true);
  assert.equal(resynchronized.resynchronization.restartedAtFirstPage, true);
  assert.equal(resynchronized.matchingSourceCount, 41);
  assert.throws(() => bounded.inspect({ root, projectionId: readyPage.projectionId }), { code: "INVALID_OBSERVATION_ADAPTER_INSPECTION_CURSOR" });
  assert.throws(() => bounded.inspect({ root, availabilityState: "healthy" }), { code: "INVALID_OBSERVATION_ADAPTER_INSPECTION_FILTER" });
  assert.throws(() => bounded.register({ projectRoot: root, sourceKey: "invalid-availability", binding: fileBinding("invalid-availability"), descriptor: type, adapter, availability: { state: "ready", reasonCode: "not-ready" } }), { code: "INVALID_OBSERVATION_SOURCE_AVAILABILITY" });
  const wideType = descriptor("example.wide.event", Array.from({ length: 20 }, (_, index) => ({ key: `field-${index}`, type: "boolean", required: false })), ["event"]);
  bounded.register({ projectRoot: root, sourceKey: "wide-source", binding: fileBinding("wide-source"), descriptor: wideType, adapter: new JsonEventFileObservationAdapter({ descriptor: wideType, eventFile }, storage) });
  const wide = bounded.inspect({ root, typeKey: "example.wide.event" });
  assert.equal(wide.matchingSourceCount, 1);
  assert.equal(wide.sources[0].shape.fields.length, 16);
  assert.equal(wide.sources[0].shape.omittedFieldCount, 4);
});

test("exposes the JSON event-file reference adapter through the advanced Host CLI only", async (t) => {
  const { root, storage, layout } = fixture();
  const hostRoot = fs.mkdtempSync(path.join(testParent, "head-agent-observation-host-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(hostRoot, { recursive: true, force: true }));
  const eventFile = path.join(hostRoot, "release-event.json");
  const configFile = path.join(hostRoot, "source.json");
  const type = descriptor("example.release.health", [{ key: "healthy", type: "boolean", required: true }], ["event"]);
  fs.writeFileSync(eventFile, JSON.stringify(event({ eventKey: "release-17", subjectType: "example.release", payload: { healthy: true } })));
  fs.writeFileSync(configFile, JSON.stringify({ binding: fileBinding("release-health"), descriptor: type, eventFile }));
  const result = await runCommand(["observation-file-ingest", root, "--input", configFile]);
  assert.equal(result.observation.typeKey, "example.release.health");
  const sources = inspectObservationSources();
  assert.equal(sources.adapters.some((adapterValue) => adapterValue.adapterKey === "head.json-event-file-observation"), true);
  assert.equal(sources.registry.persisted, false);
  assert.equal(mcpTools.some((tool) => tool.name === "lode_observation_file_ingest"), false);

  const replay = await ingestJsonObservationEventFile({ root, sourceKey: "release-health", binding: fileBinding("release-health"), descriptor: type, eventFile });
  assert.equal(replay.status, "existing");
});

test("preflights the local project before a Host adapter can perform external collection", async () => {
  const missingRoot = path.join(testParent, `head-agent-observation-missing-${crypto.randomUUID()}`);
  const type = createObservationTypeDescriptor(descriptor("example.preflight.event", [{ key: "value", type: "integer", required: true }], ["event"]));
  let collectCalled = false;
  const adapter = {
    describe: () => ({
      adapterKey: binding().adapterKey,
      adapterVersion: binding().adapterVersion,
      descriptorId: type.descriptorId,
      descriptorHash: type.descriptorHash,
      authority: "observed-evidence-only",
      providerNeutral: true,
      persistsCredentials: false,
      persistsProviderIdentity: false,
      executesProjectCode: false,
    }),
    collect: () => { collectCalled = true; return input({ suffix: "preflight", subjectType: "example.preflight", payload: { value: 1 } }); },
  };
  await assert.rejects(() => collectObservation({ root: missingRoot, binding: binding(), descriptor: type, adapter }), (error) => error.code === "PROJECT_NOT_FOUND");
  assert.equal(collectCalled, false);
});

test("lets CLI and MCP collect a Host-injected source by opaque ID without user-authored provenance", async (t) => {
  const { root, storage, layout } = fixture();
  const { root: otherRoot, storage: otherStorage } = fixture();
  const hostRoot = fs.mkdtempSync(path.join(testParent, "head-agent-observation-host-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(otherRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(hostRoot, { recursive: true, force: true }));
  const eventFile = path.join(hostRoot, "configured-event.json");
  const type = descriptor("example.configured.health", [{ key: "healthy", type: "boolean", required: true }], ["event"]);
  fs.writeFileSync(eventFile, JSON.stringify(event({ eventKey: "configured-9", subjectType: "example.configured.target", payload: { healthy: true } })));
  const registry = new ObservationAdapterRegistry();
  const registered = registry.register({ projectRoot: root, sourceKey: "configured-health", binding: fileBinding("configured-health"), descriptor: type, adapter: new JsonEventFileObservationAdapter({ descriptor: type, eventFile }, storage) });
  const otherRegistered = registry.register({ projectRoot: otherRoot, sourceKey: "configured-health", binding: fileBinding("configured-health"), descriptor: type, adapter: new JsonEventFileObservationAdapter({ descriptor: type, eventFile }, otherStorage) });
  assert.notEqual(otherRegistered.sourceId, registered.sourceId);
  await assert.rejects(() => registry.collect({ root: otherRoot, sourceId: registered.sourceId }), (error) => error.code === "OBSERVATION_ADAPTER_SOURCE_PROJECT_MISMATCH");

  const beforeCollection = prepareObservationEvidence({ root, registry, typeKey: "example.configured.health" });
  assert.equal(beforeCollection.existing.returned, 0);
  assert.equal(beforeCollection.configuredSources.matchingSourceCount, 1);
  assert.equal(beforeCollection.workflow.nextAction, "head-may-collect-one-source-if-durable-current-evidence-is-required");

  const cliSources = (await runCommand(["observation-sources", root], { observationRegistry: registry }));
  assert.equal(cliSources.registry.configuredSourceCount, 1);
  assert.equal(cliSources.registry.sources[0].sourceId, registered.sourceId);
  const cliCollected = await runCommand(["observation-source-collect", root, "--source", registered.sourceId], { observationRegistry: registry });
  assert.equal(cliCollected.observation.typeKey, "example.configured.health");
  const artifactsBeforePrepare = projectArtifactText(root, layout);
  const prepared = prepareObservationEvidence({ root, registry, typeKey: "example.configured.health", sourceLimit: 10 });
  assert.equal(prepared.existing.returned, 1);
  assert.equal(prepared.configuredSources.matchingSourceCount, 1);
  assert.equal(prepared.workflow.nextAction, "head-assess-existing-observations");
  assert.equal(prepared.workflow.semanticSufficiencyAssessed, false);
  assert.equal(prepared.persisted, false);
  assert.match(prepared.preparationId, /^observation-preparation-[a-f0-9]{24}$/);
  assert.equal(prepareObservationEvidence({ root, registry, typeKey: "example.configured.health", sourceLimit: 10 }).preparationId, prepared.preparationId);
  assert.equal(projectArtifactText(root, layout), artifactsBeforePrepare);

  const mcpSources = await dispatchMcp({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "head_observation_sources", arguments: { project_root: root } } }, { observationRegistry: registry });
  assert.equal(mcpSources.result.structuredContent.registry.sources[0].sourceId, registered.sourceId);
  const mcpCollected = await dispatchMcp({ jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "head_observation_collect_source", arguments: { project_root: root, source_id: registered.sourceId } } }, { observationRegistry: registry });
  assert.equal(mcpCollected.result.structuredContent.status, "existing");
  assert.equal(mcpCollected.result.structuredContent.observation.observationId, cliCollected.observation.observationId);
  const unavailable = await dispatchMcp({ jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "head_observation_collect_source", arguments: { project_root: root, source_id: registered.sourceId } } });
  assert.match(unavailable.error.message, /No trusted Host Observation adapter registry/);
  const sourceTool = mcpTools.find((tool) => tool.name === "lode_observation_collect_source");
  assert.deepEqual(Object.keys(sourceTool.inputSchema.properties).sort(), ["project_root", "session_id", "source_id"]);
  const mcpPrepared = await dispatchMcp({ jsonrpc: "2.0", id: 23, method: "tools/call", params: { name: "head_observation_prepare", arguments: { project_root: root, type_key: "example.configured.health" } } }, { observationRegistry: registry });
  assert.equal(mcpPrepared.result.structuredContent.existing.returned, 1);
  assert.equal(mcpPrepared.result.structuredContent.configuredSources.sources[0].sourceId, registered.sourceId);
  const prepareTool = mcpTools.find((tool) => tool.name === "lode_observation_prepare");
  assert.equal(prepareTool.annotations.readOnlyHint, true);
  assert.equal(prepareTool.inputSchema.required.includes("type_key"), true);
  const sourcesTool = mcpTools.find((tool) => tool.name === "lode_observation_sources");
  assert.deepEqual(["cursor", "projection_id"].every((key) => Object.hasOwn(sourcesTool.inputSchema.properties, key)), true);
  assert.equal(projectArtifactText(root, layout), artifactsBeforePrepare);
});

test("fails closed for divergent replay, false completeness, and schema or adapter authority drift", async (t) => {
  const { root, storage, layout } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const build = descriptor("head.build.result", [{ key: "succeeded", type: "boolean", required: true }]);
  await ingestStructuredObservation({ root, binding: binding(), descriptor: build, input: input({ suffix: "same", subjectType: "head.build.target", payload: { succeeded: true } }) });
  await assert.rejects(() => ingestStructuredObservation({ root, binding: binding(), descriptor: build, input: input({ suffix: "same", subjectType: "head.build.target", payload: { succeeded: false } }) }), (error) => error.code === "DIVERGENT_OBSERVATION_REPLAY");
  await assert.rejects(() => ingestStructuredObservation({ root, binding: binding(), descriptor: build, input: input({ suffix: "coverage", subjectType: "head.build.target", payload: { succeeded: true }, coverageValue: coverage({ queryDigest: null }) }) }), (error) => error.code === "UNPROVEN_COMPLETE_OBSERVATION_COVERAGE");
  await assert.rejects(() => ingestStructuredObservation({ root, binding: binding(), descriptor: build, input: input({ suffix: "payload", subjectType: "head.build.target", payload: { succeeded: true, productSuccess: true } }) }), (error) => error.code === "INVALID_OBSERVATION_PAYLOAD");
  await assert.rejects(() => ingestStructuredObservation({ root, binding: { ...binding(), adapterKey: "example.other" }, descriptor: build, input: input({ suffix: "adapter", subjectType: "head.build.target", payload: { succeeded: true } }) }), (error) => error.code === "INVALID_OBSERVATION_ADAPTER_AUTHORITY");
});

test("scopes at-most-once replay to the exact adapter and source binding", async (t) => {
  const { root, storage, layout } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const type = descriptor("example.source.event", [{ key: "value", type: "integer", required: true }]);
  const observed = input({ suffix: "shared-upstream-id", subjectType: "example.source.subject", payload: { value: 1 } });
  const firstBinding = binding();
  const secondBinding = { ...binding(), sourceScopeDigest: sha("independent-source-scope") };
  const first = await ingestStructuredObservation({ root, binding: firstBinding, descriptor: type, input: observed });
  const second = await ingestStructuredObservation({ root, binding: secondBinding, descriptor: type, input: observed });
  assert.notEqual(first.observation.observationId, second.observation.observationId);
  assert.equal(queryObservations({ root }).inventorySummary.counts.observations, 2);
  await assert.rejects(() => ingestStructuredObservation({ root, binding: firstBinding, descriptor: type, input: { ...observed, payload: { value: 2 } } }), (error) => error.code === "DIVERGENT_OBSERVATION_REPLAY");
});

test("records deterministic derivation without promoting causal or product meaning", async (t) => {
  const { root, storage, layout } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceDescriptor = descriptor("example.runtime.error-count", [{ key: "count", type: "nonnegative-integer", required: true }], ["aggregate"]);
  const first = await ingestStructuredObservation({ root, binding: binding(), descriptor: sourceDescriptor, input: input({ suffix: "before", subjectType: "example.runtime.service", payload: { count: 2 }, form: "aggregate" }) });
  const second = await ingestStructuredObservation({ root, binding: binding(), descriptor: sourceDescriptor, input: input({ suffix: "after", subjectType: "example.runtime.service", payload: { count: 5 }, form: "aggregate" }) });
  const comparisonDescriptor = createObservationTypeDescriptor(descriptor("example.runtime.error-count-delta", [{ key: "delta", type: "integer", required: true }], ["aggregate"]), storage);
  const derived = recordDerivedObservation({ root, descriptor: comparisonDescriptor, input: {
    subject: { type: "example.runtime.service", key: "global" },
    temporalScope: { observedAt: "2026-09-01T00:05:00.000Z", start: "2026-08-31T23:00:00.000Z", end: "2026-09-01T00:00:00.000Z" },
    inputObservationIds: [first.observation.observationId, second.observation.observationId],
    algorithm: { key: "example.count-delta", version: "1.0.0", digest: sha("count-delta-v1") },
    coverage: coverage({ examinedCount: 2, sourceReportedTotal: 2 }),
    payload: { delta: 3 },
  } });
  assert.equal(derived.derivedObservation.epistemicClass, "derived-projection");
  const project = JSON.parse(fs.readFileSync(path.join(root, layout.directory, "project.json"), "utf8"));
  const projection = loadObservationProjection({ projectRoot: root, projectId: project.projectId, storage });
  assert.equal(projection.edges.filter((edge) => edge.type === "DERIVED_FROM").length, 2);
  assert.equal(projection.edges.some((edge) => edge.type === "IMPACTS"), false);
});

test("exposes the same bounded contract through CLI and MCP while requiring Host confirmation", async (t) => {
  const { root, storage, layout } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const type = descriptor("head.test.summary", [{ key: "passed", type: "nonnegative-integer", required: true }]);
  const observed = input({ suffix: "cli", subjectType: "head.test.suite", payload: { passed: 4 } });
  const cliInput = path.join(root, "observation-input.json");
  fs.writeFileSync(cliInput, JSON.stringify({ binding: binding(), descriptor: type, input: observed }));
  const cli = await runCommand(["observation-ingest", root, "--input", cliInput]);
  assert.equal(cli.observation.typeKey, "head.test.summary");
  assert.equal((await runCommand(["observation-query", root])).inventorySummary.counts.observations, 1);
  assert.equal((await runCommand(["observation-sources", root])).dynamicProjectCodeLoading, false);
  const cliQuery = (await runCommand(["observation-query", root, "--type-key", type.typeKey, "--limit", "1"]));
  assert.equal(cliQuery.results[0].observationId, cli.observation.observationId);
  assert.equal(cliQuery.results[0].payload, undefined);
  const cliRead = (await runCommand(["observation-read", root, "--observation", cli.observation.observationId]));
  assert.equal(cliRead.descriptor.descriptorId, cli.observation.descriptorId);
  assert.equal(cliRead.lineage.receiptId, cli.receipt.receiptId);

  const mcpArguments = {
    project_root: root,
    binding: { adapter_key: binding().adapterKey, adapter_version: binding().adapterVersion, source_scope_digest: binding().sourceScopeDigest, credential_reference_names: binding().credentialReferenceNames },
    descriptor: { type_key: type.typeKey, type_version: type.typeVersion, forms: type.forms, payload_schema: { additional_fields: false, fields: type.payloadSchema.fields } },
    observation: {
      subject: observed.subject, form: observed.form,
      temporal_scope: { observed_at: observed.temporalScope.observedAt, start: observed.temporalScope.start, end: observed.temporalScope.end },
      source_event_key_digest: observed.sourceEventKeyDigest, source_evidence_digest: observed.sourceEvidenceDigest,
      coverage: { state: observed.coverage.state, basis: observed.coverage.basis, query_digest: observed.coverage.queryDigest, examined_count: observed.coverage.examinedCount, source_reported_total: observed.coverage.sourceReportedTotal, omitted_count: observed.coverage.omittedCount, cursor_start_digest: observed.coverage.cursorStartDigest, cursor_end_digest: observed.coverage.cursorEndDigest },
      payload: observed.payload,
    },
    confirm_host_observation: false,
  };
  const denied = await dispatchMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "head_observation_ingest", arguments: mcpArguments } });
  assert.match(denied.error.message, /exact Host source binding/);
  const accepted = await dispatchMcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "head_observation_ingest", arguments: { ...mcpArguments, confirm_host_observation: true } } });
  assert.equal(accepted.result.structuredContent.observation.observationId, cli.observation.observationId);
  const queried = await dispatchMcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "head_observation_query", arguments: { project_root: root, type_key: type.typeKey, limit: 1 } } });
  assert.equal(queried.result.structuredContent.results[0].observationId, cli.observation.observationId);
  const itemsType = mcpTools.find((tool) => tool.name === "lode_observation_ingest").inputSchema.properties.descriptor.properties.payload_schema.properties.fields.items.properties.items_type.enum;
  assert.equal(itemsType.includes("enum"), false);
});

test("keeps unrelated ProductSignal flow independent from unused Observation storage", async (t) => {
  const { root, storage, layout } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const recorded = await ingestStructuredObservation({
    root,
    binding: binding(),
    descriptor: descriptor("example.optional.event", [{ key: "value", type: "integer", required: true }]),
    input: input({ suffix: "optional", subjectType: "example.optional.subject", payload: { value: 1 } }),
  });
  fs.unlinkSync(path.join(root, layout.directory, "observations", "receipts", `${recorded.receipt.receiptId}.json`));
  const signal = await recordProductSignal({ root, statement: "A separate user-authored product fact.", source: "user" });
  assert.equal(signal.signal.kind, "ProductSignal");
  const isolatedWorld = (await readWorldModel({ root })).snapshot;
  assert.equal(isolatedWorld.observationProjection.status, "unavailable");
  assert.equal(isolatedWorld.observationProjection.reasonCode, "OBSERVATION_RECEIPT_MISSING");
  assert.equal(isolatedWorld.temporalProvenanceGraph.summary.observationRecordCount, 0);
  assert.deepEqual((await inspectWorldModelStatus({ root })).observations, {
    status: "unavailable",
    reasonCode: "OBSERVATION_RECEIPT_MISSING",
    descriptorCount: 0,
    observationCount: 0,
    derivedObservationCount: 0,
    effect: "observation-graph-layer-only",
  });
  await assert.rejects(() => recordProductHypothesis({ root, statement: "This exact observation may matter.", observationIds: [recorded.observation.observationId] }), (error) => error.code === "OBSERVATION_RECEIPT_MISSING");
});

test("bounds Observation status and cursor query without semantic selection", async (t) => {
  const { root, storage, layout } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const type = descriptor("example.query.event", [{ key: "value", type: "integer", required: true }]);
  for (let index = 0; index < 3; index += 1) await ingestStructuredObservation({
    root,
    binding: binding(),
    descriptor: type,
    input: { ...input({ suffix: `query-${index}`, subjectType: "example.query.subject", payload: { value: index } }), temporalScope: { observedAt: `2026-09-01T00:0${index}:00.000Z`, start: null, end: null } },
  });
  const status = queryObservations({ root });
  assert.equal(status.inventorySummary.counts.observations, 3);
  assert.equal(status.inventorySummary.nodes, undefined);
  const first = queryObservations({ root, typeKey: type.typeKey, limit: 2 });
  assert.equal(first.returned, 2);
  assert.equal(first.semanticSelection, false);
  assert.equal(first.nextCursor.projectionId, first.sourceProjectionId);
  const second = queryObservations({ root, typeKey: type.typeKey, limit: 2, projectionId: first.nextCursor.projectionId, cursor: first.nextCursor.observationId });
  assert.equal(second.returned, 1);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(new Set([...first.results, ...second.results].map((item) => item.observationId)).size, 3);
  await ingestStructuredObservation({ root, binding: binding(), descriptor: type, input: input({ suffix: "query-new", subjectType: "example.query.subject", payload: { value: 4 } }) });
  assert.throws(() => queryObservations({ root, typeKey: type.typeKey, limit: 2, projectionId: first.nextCursor.projectionId, cursor: first.nextCursor.observationId }), { code: "STALE_OBSERVATION_QUERY_CURSOR" });
});

test("admits Observation evidence only by exact HEAD need and keeps semantic interpretation in a hypothesis", async (t) => {
  const { root, storage, layout } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "service.mjs"), "export const service = true;\n");
  await buildWorldModel({ root });
  const observed = await ingestStructuredObservation({
    root,
    binding: binding(),
    descriptor: descriptor("example.delivery.latency", [{ key: "milliseconds", type: "nonnegative-integer", required: true }]),
    input: input({ suffix: "latency", subjectType: "example.delivery.endpoint", payload: { milliseconds: 42 } }),
  });
  const task = "Investigate the unrelated onboarding experience";
  const withoutExactNeed = (await compileContext({ root, task }));
  assert.deepEqual(withoutExactNeed.capsule.observationEvidence, []);
  assert.equal(withoutExactNeed.capsule.selection.candidateIds.includes(observed.observation.observationId), false);

  const withExactNeed = (await compileContext({ root, task, evidenceNeeds: [{
    id: "exact-latency-evidence",
    kind: "observation",
    observationIds: [observed.observation.observationId],
    rationale: "Fresh HEAD selected this immutable observation after semantic task analysis.",
  }] }));
  assert.deepEqual(withExactNeed.capsule.evidenceGaps, []);
  assert.deepEqual(withExactNeed.capsule.observationEvidence.map((item) => item.nodeId), [observed.observation.observationId]);
  assert.equal(withExactNeed.capsule.observationEvidence[0].semanticAuthority, false);

  const hypothesis = await recordProductHypothesis({
    root,
    statement: "The measured latency may contribute to the reported experience.",
    observationIds: [observed.observation.observationId],
    rationale: "This is HEAD-authored inferred meaning, not a fact copied from the adapter.",
  });
  assert.deepEqual(hypothesis.hypothesis.observationIds, [observed.observation.observationId]);
  assert.deepEqual(hypothesis.hypothesis.signalIds, []);
  assert.equal(hypothesis.hypothesis.epistemicClass, "hypothesis");
  assert.equal(hypothesis.hypothesis.promotionAuthority, false);
  const graph = (await readWorldModel({ root })).snapshot.temporalProvenanceGraph;
  assert.equal(graph.nodes.some((node) => node.nodeId === observed.observation.observationId && node.kind === "ObservationRecord"), true);
  assert.equal(graph.edges.some((edge) => edge.type === "REFERENCES" && edge.from === hypothesis.hypothesis.hypothesisId && edge.to === observed.observation.observationId), true);

  (await assert.rejects(async () => (await compileContext({ root, task, evidenceNeeds: [{ id: "invalid-observation", kind: "observation", observationIds: [] }] })), { code: "INVALID_EVIDENCE_NEEDS" }));
  await assert.rejects(() => recordProductHypothesis({ root, statement: "Unsupported", observationIds: ["observation-000000000000000000000000"] }), (error) => error.code === "UNKNOWN_OBSERVATION");
});

function observationAuthorityDigests(root, layout) {
  return Object.fromEntries([`${layout.directory}/context/product-model.json`, `${layout.directory}/sessions/current.json`].map((relative) => [relative, sha(fs.readFileSync(path.join(root, ...relative.split("/"))))]));
}

function observationJsonFiles(root, relative) {
  const directory = path.join(root, ...relative.split("/"));
  return fs.existsSync(directory)
    ? fs.readdirSync(directory).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")))
    : [];
}

test("publishes one Observation and one receipt when divergent writers collide at the create-only boundary", async (t) => {
  const { root, storage, layout } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = observationAuthorityDigests(root, layout);
  const type = descriptor("example.concurrent.build-result", [{ key: "succeeded", type: "boolean", required: true }], ["event"]);
  const firstInput = input({ suffix: "same-concurrent-event", subjectType: "example.concurrent.target", payload: { succeeded: true } });
  const secondInput = { ...structuredClone(firstInput), sourceEvidenceDigest: sha("different-concurrent-evidence"), payload: { succeeded: false } };
  const recordDirectory = path.join(root, layout.directory, "observations", "records", "by-source-key");
  const originalLink = fs.linkSync;
  let injected = false;
  let secondResult = null;
  let secondError = null;
  fs.linkSync = function (source, destination, ...rest) {
    if (!injected && path.dirname(path.resolve(String(destination))) === recordDirectory && String(destination).endsWith(".json")) {
      injected = true;
      const adapter = new StructuredObservationAdapter({ descriptor: type, input: secondInput }, storage);
      try {
        secondResult = recordCollectedObservation({ root, descriptor: type, input: secondInput, adapterDescriptor: adapter.describe(), sourceScopeDigest: binding().sourceScopeDigest });
      } catch (error) { secondError = error; }
    }
    return originalLink.call(fs, source, destination, ...rest);
  };
  let firstError = null;
  try {
    await ingestStructuredObservation({ root, binding: binding(), descriptor: type, input: firstInput });
  } catch (error) { firstError = error; }
  finally { fs.linkSync = originalLink; }
  assert.equal(injected, true);
  assert.equal(secondError, null);
  assert.equal(secondResult.status, "recorded");
  assert.equal(firstError?.code, "DIVERGENT_OBSERVATION_REPLAY");
  const records = observationJsonFiles(root, `${layout.directory}/observations/records/by-source-key`);
  const receipts = observationJsonFiles(root, `${layout.directory}/observations/receipts`);
  assert.equal(records.length, 1);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].observationId, records[0].observationId);
  assert.equal(queryObservations({ root }).inventorySummary.counts.observations, 1);
  assert.equal((await ingestStructuredObservation({ root, binding: binding(), descriptor: type, input: secondInput })).status, "existing");
  await assert.rejects(() => ingestStructuredObservation({ root, binding: binding(), descriptor: type, input: firstInput }), (error) => error.code === "DIVERGENT_OBSERVATION_REPLAY");
  assert.deepEqual(observationAuthorityDigests(root, layout), before);
  assert.equal(fs.readdirSync(recordDirectory).some((name) => name.endsWith(".tmp")), false);
});

test("keeps divergent Observation replay process-safe across independent Node writers", async (t) => {
  const { root, storage, layout } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = observationAuthorityDigests(root, layout);
  const type = descriptor("example.process.build-result", [{ key: "succeeded", type: "boolean", required: true }], ["event"]);
  const firstInput = input({ suffix: "same-process-event", subjectType: "example.process.target", payload: { succeeded: true } });
  const secondInput = { ...structuredClone(firstInput), sourceEvidenceDigest: sha("different-process-evidence"), payload: { succeeded: false } };
  const startFile = path.join(root, "start-observation-writers.flag");
  const adapterUrl = pathToFileURL(path.join(pluginRoot, "scripts", "lib", "observation-adapter.mjs")).href;
  const workerSource = `
    import fs from "node:fs";
    import { setTimeout as delay } from "node:timers/promises";
    import { ingestStructuredObservation } from ${JSON.stringify(adapterUrl)};
    const request = JSON.parse(process.argv[1]);
    while (!fs.existsSync(request.startFile)) await delay(2);
    try {
      const result = await ingestStructuredObservation(request.operation);
      process.stdout.write(JSON.stringify({ status: result.status, observationId: result.observation.observationId }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ code: error.code || null, message: error.message }));
      process.exitCode = error.code === "DIVERGENT_OBSERVATION_REPLAY" ? 2 : 3;
    }
  `;
  const children = [];
  t.after(() => { for (const child of children) if (child.exitCode == null && child.signalCode == null) child.kill(); });
  function launch(observed) {
    const child = spawn(process.execPath, ["--input-type=module", "-e", workerSource, JSON.stringify({ startFile, operation: { root, binding: binding(), descriptor: type, input: observed } })], { cwd: pluginRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const started = new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    const completed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr, result: JSON.parse(stdout) }));
    });
    return { started, completed };
  }
  let first;
  let second;
  try {
    first = launch(firstInput);
    second = launch(secondInput);
  } catch (error) {
    if (error?.code === "EPERM") { t.skip("The local sandbox forbids nested process creation; the atomic collision test still runs."); return; }
    throw error;
  }
  await Promise.all([first.started, second.started]);
  fs.writeFileSync(startFile, "start\n", { flag: "wx" });
  const outcomes = await Promise.all([first.completed, second.completed]);
  assert.deepEqual(outcomes.map((item) => item.code).sort(), [0, 2]);
  assert.equal(outcomes.filter((item) => item.result.status === "recorded").length, 1);
  assert.equal(outcomes.filter((item) => item.result.code === "DIVERGENT_OBSERVATION_REPLAY").length, 1);
  assert.equal(outcomes.every((item) => item.signal === null && item.stderr === ""), true);
  const records = observationJsonFiles(root, `${layout.directory}/observations/records/by-source-key`);
  const receipts = observationJsonFiles(root, `${layout.directory}/observations/receipts`);
  assert.equal(records.length, 1);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].observationId, records[0].observationId);
  assert.equal(queryObservations({ root }).inventorySummary.counts.observations, 1);
  assert.deepEqual(observationAuthorityDigests(root, layout), before);
});

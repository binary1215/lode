import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { formatForVerifiedOwner } from "../scripts/lib/project-storage-format.mjs";
import { observationDigest } from "../scripts/lib/observation-contract.mjs";
import { defineMetric, recordMetricObservation, compareMetricObservations } from "../scripts/lib/measurement-workflow.mjs";
import {
  loadObservationArtifacts, readObservation,
} from "../scripts/lib/observation-store.mjs";
import { LocalJsonWorldModelStoreAdapter } from "../scripts/lib/world-model-store.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha = observationDigest;
const definition = { metricKey: "latency", unit: "milliseconds", direction: "decrease" };
const malformedPointer = "{malformed-derived-world";

function fixture(t) {
  const parent = process.env.HEAD_AGENT_TEST_TMP || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "measurement-committed-"));
  t.diagnostic(JSON.stringify({ fixture: root, pid: process.pid, parentPid: process.ppid, cwd: process.cwd(), ports: [] }));
  if (process.env.HEAD_AGENT_KEEP_TEST_TMP !== "1") t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  const layout = formatForVerifiedOwner(storage);
  return { root, storage, layout };
}

function input(overrides = {}) {
  return {
    metricKey: definition.metricKey, subjectType: "service", subjectKey: "api", value: 120,
    form: "aggregate", observedAt: "2026-01-02T00:00:00.000Z",
    start: "2026-01-01T00:00:00.000Z", end: "2026-01-02T00:00:00.000Z", sampleSize: 10,
    coverage: { state: "complete", queryDigest: sha("query"), examinedCount: 1, sourceReportedTotal: 1, omittedCount: 0 },
    sourceScopeDigest: sha("scope"), sourceEventKeyDigest: sha("baseline"), sourceEvidenceDigest: sha("baseline-evidence"),
    ...overrides,
  };
}

function files(root, layout, relative = `${layout.directory}/observations`) {
  const result = {};
  function walk(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else result[path.relative(root, file).replaceAll("\\", "/")] = sha(fs.readFileSync(file).toString("utf8"));
    }
  }
  walk(path.join(root, relative));
  return result;
}

function authority(root, layout) {
  return Object.fromEntries([`${layout.directory}/project.json`, `${layout.directory}/context/product-model.json`, `${layout.directory}/sessions/current.json`]
    .map((relative) => [relative, sha(fs.readFileSync(path.join(root, relative)).toString("utf8"))]));
}

function artifacts(root, storage) {
  return loadObservationArtifacts({ projectRoot: root, projectId: storage.projectId, storage });
}

function healthy(result) {
  assert.deepEqual(Object.keys(result.worldModel).sort(), ["graphSnapshotId", "worldModelId"]);
  assert.match(result.worldModel.worldModelId, /^world-model-[a-f0-9]{24}$/);
  assert.match(result.worldModel.graphSnapshotId, /^graph-snapshot-[a-f0-9]{24}$/);
  assert.equal(result.ordinaryWorkBlocked, false);
}

function deferred(result, reasonCode = "INVALID_WORLD_MODEL_STORE_DOCUMENT") {
  assert.deepEqual(result.worldModel, { status: "deferred", reasonCode, ordinaryWorkBlocked: false });
  assert.equal(result.ordinaryWorkBlocked, false);
}

function breakPointer(root, layout) {
  const file = path.join(root, layout.directory, "world-model/current.json");
  const original = fs.readFileSync(file);
  fs.writeFileSync(file, malformedPointer);
  return { file, original };
}

async function pair(root) {
  await defineMetric({ root, ...definition });
  const baseline = await recordMetricObservation({ root, ...input() });
  const current = await recordMetricObservation({ root, ...input({
    value: 90, observedAt: "2026-01-03T00:00:00.000Z",
    start: "2026-01-02T00:00:00.000Z", end: "2026-01-03T00:00:00.000Z",
    sourceEventKeyDigest: sha("current"), sourceEvidenceDigest: sha("current-evidence"),
  }) });
  return { baseline, current, comparisonInput: { root, baselineObservationId: baseline.observation.observationId, currentObservationId: current.observation.observationId } };
}

test("healthy measurement writes retain primary evidence, statuses and exact two-ID World responses", { concurrency: false }, async (t) => {
  const { root, storage, layout } = fixture(t);
  const defined = await defineMetric({ root, ...definition });
  healthy(defined);
  assert.equal(defined.status, "recorded");
  const { baseline, current, comparisonInput } = await pair(root);
  for (const result of [baseline, current]) {
    healthy(result);
    assert.equal(result.status, "recorded");
    assert.deepEqual(readObservation({ root, observationId: result.observation.observationId }).receipt, result.receipt);
    assert.equal(result.receipt.observationId, result.observation.observationId);
  }
  const compared = await compareMetricObservations(comparisonInput);
  healthy(compared);
  assert.equal(compared.status, "recorded");
  assert.equal(compared.comparison, compared.derivedObservation);
  assert.equal(compared.comparison.payload.absolute_change, -30);
  assert.equal(compared.comparison.payload.relative_change, -0.25);
  assert.equal(compared.comparison.coverage.state, "complete");
  assert.equal(compared.comparability.recordedCollectionConditionsEquivalent, true);
  assert.equal(compared.comparability.semanticEquivalenceEstablished, false);
  assert.equal(compared.causalityEstablished, false);
  assert.equal((await defineMetric({ root, ...definition })).status, "existing");
});

test("committed define, observe and compare survive broken World with exact replay and later projection recovery", { concurrency: false }, async (t) => {
  const { root, storage, layout } = fixture(t);
  await defineMetric({ root, metricKey: "setup", unit: "count", direction: "increase" });
  const pointer = breakPointer(root, layout);
  const beforeAuthority = authority(root, layout);
  const unchanged = () => {
    assert.equal(fs.readFileSync(pointer.file, "utf8"), malformedPointer);
    assert.deepEqual(authority(root, layout), beforeAuthority);
  };
  const defined = await defineMetric({ root, ...definition });
  deferred(defined); unchanged();
  const baselineInput = { root, ...input({ observedAt: null }) };
  const baseline = await recordMetricObservation(baselineInput);
  deferred(baseline); unchanged();
  const currentInput = { root, ...input({ value: 90,
    observedAt: new Date(Date.parse(baseline.observation.temporalScope.observedAt) + 1000).toISOString(),
    sourceEventKeyDigest: sha("current"), sourceEvidenceDigest: sha("current-evidence"),
  }) };
  const current = await recordMetricObservation(currentInput);
  deferred(current); unchanged();
  const comparisonInput = { root, baselineObservationId: baseline.observation.observationId, currentObservationId: current.observation.observationId };
  const compared = await compareMetricObservations(comparisonInput);
  deferred(compared); unchanged();
  assert.equal(compared.comparison.payload.absolute_change, -30);
  assert.equal(compared.comparability.numericComparisonAvailable, true);
  assert.equal(compared.causalityEstablished, false);
  const stored = artifacts(root, storage);
  assert.ok(stored.descriptors.some((item) => item.descriptorId === defined.descriptor.descriptorId));
  for (const result of [baseline, current]) {
    const read = readObservation({ root, observationId: result.observation.observationId });
    assert.deepEqual(read.observation, result.observation);
    assert.deepEqual(read.receipt, result.receipt);
  }
  assert.deepEqual(readObservation({ root, observationId: compared.comparison.derivedObservationId }).observation, compared.comparison);
  const committedFiles = files(root, layout);
  const repeat = async (expectHealthy) => {
    const retries = [await defineMetric({ root, ...definition }), await recordMetricObservation(baselineInput),
      await recordMetricObservation(currentInput), await compareMetricObservations(comparisonInput)];
    for (const result of retries) { (expectHealthy ? healthy : deferred)(result); assert.equal(result.status, "existing"); }
    assert.equal(retries[0].descriptor.descriptorId, defined.descriptor.descriptorId);
    assert.deepEqual(retries[1].observation, baseline.observation);
    assert.equal(retries[1].receipt.receiptId, baseline.receipt.receiptId);
    assert.equal(retries[2].observation.observationId, current.observation.observationId);
    assert.equal(retries[3].comparison.derivedObservationId, compared.comparison.derivedObservationId);
    assert.deepEqual(files(root, layout), committedFiles);
    assert.deepEqual(artifacts(root, storage), stored);
    assert.deepEqual(authority(root, layout), beforeAuthority);
  };
  await repeat(false); unchanged();
  fs.writeFileSync(pointer.file, pointer.original);
  await repeat(true);
  t.diagnostic(JSON.stringify({ descriptorId: defined.descriptor.descriptorId, observationId: baseline.observation.observationId,
    receiptId: baseline.receipt.receiptId, comparisonId: compared.comparison.derivedObservationId,
    omittedObservedAtReused: true, primaryFilesUnchangedOnRetry: true, authorityUnchanged: true }));
});

test("primary validation, conflicts and divergent replay still reject under broken World", { concurrency: false }, async (t) => {
  const { root, storage, layout } = fixture(t);
  const { baseline, current, comparisonInput } = await pair(root);
  const other = await recordMetricObservation({ root, ...input({ subjectKey: "other", sourceEventKeyDigest: sha("other") }) });
  breakPointer(root, layout);
  const before = files(root, layout);
  const cases = [
    ["INVALID_MEASUREMENT_INPUT", async () => (await defineMetric({ root, ...definition, direction: "sideways" }))],
    ["METRIC_DEFINITION_CONFLICT", async () => (await defineMetric({ root, ...definition, unit: "seconds" }))],
    ["INVALID_MEASUREMENT_INPUT", async () => (await recordMetricObservation({ root, ...input({ value: NaN }) }))],
    ["UNPROVEN_COMPLETE_MEASUREMENT_COVERAGE", async () => (await recordMetricObservation({ root, ...input({ coverage: { state: "complete" } }) }))],
    ["INVALID_OBSERVATION_INPUT", async () => (await recordMetricObservation({ root, ...input({ sourceScopeDigest: "bad" }) }))],
    ["DIVERGENT_OBSERVATION_REPLAY", async () => (await recordMetricObservation({ root, ...input({ value: 121 }) }))],
    ["INCOMPARABLE_METRIC_OBSERVATIONS", async () => (await compareMetricObservations({ ...comparisonInput, currentObservationId: baseline.observation.observationId }))],
    ["INCOMPARABLE_METRIC_OBSERVATIONS", async () => (await compareMetricObservations({ ...comparisonInput, currentObservationId: other.observation.observationId }))],
    ["INCOMPARABLE_METRIC_OBSERVATIONS", async () => (await compareMetricObservations({ root, baselineObservationId: current.observation.observationId, currentObservationId: baseline.observation.observationId }))],
  ];
  for (const [code, operation] of cases) { await assert.rejects(operation, { code }); assert.deepEqual(files(root, layout), before); }
});

test("original digest, owner and read-permission failures escape before derived projection", { concurrency: false }, async (t) => {
  const { root, storage, layout } = fixture(t);
  const { baseline } = await pair(root);
  breakPointer(root, layout);
  const directory = path.join(root, `${layout.directory}/observations/records/by-source-key`);
  const file = fs.readdirSync(directory).map((name) => path.join(directory, name))
    .find((candidate) => JSON.parse(fs.readFileSync(candidate, "utf8")).observationId === baseline.observation.observationId);
  const original = fs.readFileSync(file, "utf8");
  const invoke = async () => (await defineMetric({ root, metricKey: "new-metric", unit: "count", direction: "increase" }));
  try {
    const changed = JSON.parse(original); changed.payload.value += 1;
    fs.writeFileSync(file, JSON.stringify(changed));
    const beforeDigest = files(root, layout);
    await assert.rejects(invoke, { code: "OBSERVATION_DIGEST_MISMATCH" });
    assert.deepEqual(files(root, layout), beforeDigest);
    const wrongOwner = JSON.parse(original); wrongOwner.projectId = `head-${sha("other-project").slice(0, 20)}`;
    const payload = { ...wrongOwner }; delete payload.observationId; delete payload.observationHash;
    wrongOwner.observationHash = sha(payload); wrongOwner.observationId = `observation-${wrongOwner.observationHash.slice(0, 24)}`;
    fs.writeFileSync(file, JSON.stringify(wrongOwner));
    const beforeOwner = files(root, layout);
    await assert.rejects(invoke, { code: "INVALID_OBSERVATION_RECORD" });
    assert.deepEqual(files(root, layout), beforeOwner);
  } finally { fs.writeFileSync(file, original); }
  const readFile = fs.readFileSync;
  const error = Object.assign(new Error("fixture-only denied original read"), { code: "EACCES" });
  let hits = 0;
  try {
    fs.readFileSync = function (target, ...args) {
      if (typeof target === "string" && path.resolve(target) === file) { hits += 1; throw error; }
      return readFile.call(this, target, ...args);
    };
    await assert.rejects(invoke, (actual) => actual === error);
  } finally { fs.readFileSync = readFile; }
  assert.equal(hits, 1);
});

async function failFinalPublish(t, root, layout, relative, kind, operation) {
  const directory = path.join(root, relative);
  const original = fs.linkSync;
  const error = Object.assign(new Error("fixture-only final primary publish failure"), { code: "EIO" });
  let hit = null;
  try {
    fs.linkSync = function (stage, target, ...args) {
      if (path.dirname(path.resolve(target)) === directory && target.endsWith(".json")) {
        assert.equal(hit, null);
        hit = { target, stageKind: JSON.parse(fs.readFileSync(stage, "utf8")).kind, targetExisted: fs.existsSync(target) };
        throw error;
      }
      return original.call(this, stage, target, ...args);
    };
    await assert.rejects(operation, (actual) => actual === error);
  } finally { fs.linkSync = original; }
  assert.ok(hit, "fault must reach final primary publication");
  assert.equal(hit.stageKind, kind);
  assert.equal(hit.targetExisted, false);
  assert.equal(fs.existsSync(hit.target), false);
  assert.equal(Object.keys(files(root, layout)).some((file) => file.endsWith(".tmp")), false);
  t.diagnostic(JSON.stringify({ finalPublishReached: true, ...hit, originalErrorPropagated: true }));
}

test("final primary publish and multi-artifact partial commits remain failures", { concurrency: false }, async (t) => {
  await t.test("descriptor final publish", async (t) => {
    const { root, storage, layout } = fixture(t);
    await failFinalPublish(t, root, layout, `${layout.directory}/observations/descriptors`, "ObservationTypeDescriptor", async () => (await defineMetric({ root, ...definition })));
    assert.deepEqual(files(root, layout), {});
  });
  await t.test("observation final publish", async (t) => {
    const { root, storage, layout } = fixture(t); await defineMetric({ root, ...definition }); breakPointer(root, layout);
    const before = files(root, layout);
    await failFinalPublish(t, root, layout, `${layout.directory}/observations/records/by-source-key`, "ObservationRecord", async () => (await recordMetricObservation({ root, ...input() })));
    assert.deepEqual(files(root, layout), before);
  });
  await t.test("receipt failure preserves the partial observation without reporting success", async (t) => {
    const { root, storage, layout } = fixture(t); await defineMetric({ root, ...definition }); breakPointer(root, layout);
    await failFinalPublish(t, root, layout, `${layout.directory}/observations/receipts`, "ObservationCollectionReceipt", async () => (await recordMetricObservation({ root, ...input() })));
    assert.equal(fs.readdirSync(path.join(root, `${layout.directory}/observations/records/by-source-key`)).filter((name) => name.endsWith(".json")).length, 1);
    assert.equal(fs.readdirSync(path.join(root, `${layout.directory}/observations/receipts`)).length, 0);
    assert.throws(() => artifacts(root, storage), { code: "OBSERVATION_RECEIPT_MISSING" });
  });
  await t.test("derived failure preserves the comparison descriptor without reporting success", async (t) => {
    const { root, storage, layout } = fixture(t); const { comparisonInput } = await pair(root); breakPointer(root, layout);
    await failFinalPublish(t, root, layout, `${layout.directory}/observations/derived`, "DerivedObservationRecord", async () => (await compareMetricObservations(comparisonInput)));
    const stored = artifacts(root, storage);
    assert.equal(stored.descriptors.filter((descriptor) => descriptor.typeKey.endsWith(".comparison")).length, 1);
    assert.equal(stored.derivedObservations.length, 0);
    assert.equal(stored.observations.length, 2);
  });
});

test("projection wrapper emits only bounded codes and hides messages, paths and stacks", { concurrency: false }, async (t) => {
  const { root, storage, layout } = fixture(t);
  await defineMetric({ root, ...definition });
  const original = LocalJsonWorldModelStoreAdapter.prototype.readPointer;
  const cases = [
    ["KNOWN_PROJECTION_ERROR:TEST-1", "KNOWN_PROJECTION_ERROR:TEST-1"],
    ["A".repeat(128), "A".repeat(128)],
    ["A".repeat(129), "MEASUREMENT_PROJECTION_FAILED"],
    ["invalid lower case", "MEASUREMENT_PROJECTION_FAILED"],
    ["C:/private/fixture-secret", "MEASUREMENT_PROJECTION_FAILED"],
    [undefined, "MEASUREMENT_PROJECTION_FAILED"],
    [42, "MEASUREMENT_PROJECTION_FAILED"],
  ];
  for (const [code, expected] of cases) {
    const error = Object.assign(new Error("hidden-message C:/private/fixture-secret"), { code, stack: "hidden-stack" });
    let hits = 0;
    try {
      LocalJsonWorldModelStoreAdapter.prototype.readPointer = function (...args) {
        if (this.projectRoot === root && hits === 0) { hits += 1; throw error; }
        return original.apply(this, args);
      };
      const result = await defineMetric({ root, ...definition });
      deferred(result, expected);
      assert.equal(result.status, "existing");
      assert.equal(hits, 1, "fault must reach the projection wrapper");
      assert.doesNotMatch(JSON.stringify(result), /hidden-message|hidden-stack|fixture-secret|C:\/private/);
    } finally { LocalJsonWorldModelStoreAdapter.prototype.readPointer = original; }
  }
});

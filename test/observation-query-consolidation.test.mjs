import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { formatForVerifiedOwner } from "../scripts/lib/project-storage-format.mjs";
import { ingestStructuredObservation } from "../scripts/lib/observation-adapter.mjs";
import { recordDerivedObservation } from "../scripts/lib/observation-store.mjs";
import * as api from "../scripts/lib/observation-projection.mjs";

const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const pluginRoot = path.resolve(import.meta.dirname, "..");
const coverage = {
  state: "partial",
  basis: "bounded-fixture",
  queryDigest: null,
  examinedCount: 1,
  sourceReportedTotal: null,
  omittedCount: null,
  cursorStartDigest: null,
  cursorEndDigest: null,
};
const descriptor = (typeKey) => ({
  typeKey,
  typeVersion: "1",
  forms: ["event"],
  payloadSchema: { fields: [{ key: "count", type: "nonnegative-integer", required: true }], additionalFields: false },
});
function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, "head-observation-query-")));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert(path.basename(root).startsWith("head-observation-query-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  const layout = formatForVerifiedOwner(storage);
  return { root, storage, layout };
}
function snapshot(root) {
  const files = {};
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else files[path.relative(root, file)] = digest(fs.readFileSync(file));
    }
  };
  walk(root);
  return files;
}
async function record(root, index, typeKey = "example.query.a") {
  return ingestStructuredObservation({
    root,
    descriptor: descriptor(typeKey),
    binding: {
      adapterKey: "lode.structured-host-observation",
      adapterVersion: "0.1.0",
      sourceScopeDigest: digest("fixture-scope"),
      credentialReferenceNames: [],
    },
    input: {
      subject: { type: "example.unit", key: "unit" },
      form: "event",
      temporalScope: { observedAt: `2026-10-0${index + 1}T00:00:00.000Z`, start: null, end: null },
      sourceEventKeyDigest: digest(`event-${index}`),
      sourceEvidenceDigest: digest(`evidence-${index}`),
      coverage,
      payload: { count: index },
    },
  });
}

test("query replaces status with exact unfiltered summary and preserves filtered paging/coverage", async (t) => {
  const { root, storage, layout } = fixture(t),
    first = await record(root, 0);
  await record(root, 1);
  await record(root, 2, "example.query.b");
  recordDerivedObservation({
    root,
    descriptor: descriptor("example.query.comparison"),
    input: {
      subject: { type: "example.unit", key: "unit" },
      temporalScope: { observedAt: "2026-10-04T00:00:00.000Z", start: "2026-10-01T00:00:00.000Z", end: "2026-10-03T00:00:00.000Z" },
      inputObservationIds: [first.observation.observationId],
      algorithm: { key: "fixture-count", version: "1", digest: digest("count") },
      coverage,
      payload: { count: 1 },
    },
  });
  const before = snapshot(root),
    project = inspectProject(root).project;
  const projection = api.loadObservationProjection({ projectRoot: project.projectRoot, projectId: project.projectId, storage });
  const page = api.queryObservations({ root, typeKey: "example.query.a", recordKind: "observed", limit: 1 });
  assert.equal(api.inspectObservations, undefined);
  assert.deepEqual(page.inventorySummary, {
    scope: "all-retained-observations",
    status: "active",
    counts: {
      descriptors: projection.descriptorIds.length,
      observations: 3,
      derivedObservations: 1,
      receipts: 3,
      nodes: projection.nodes.length,
      edges: projection.edges.length,
    },
    graphPolicy: projection.graphPolicy,
  });
  assert.equal(page.sourceProjectionId, projection.projectionId);
  assert.equal(page.sourceProjectionHash, projection.projectionHash);
  assert.equal(page.totalMatches, 2);
  assert.equal(page.returned, 1);
  assert.equal(page.omitted, 1);
  assert.equal(page.results[0].coverage.state, "partial");
  assert.equal(page.results[0].payload, undefined);
  assert.equal(page.inventorySummary.graphPolicy.automaticSemanticRelations, false);
  const next = api.queryObservations({
    root,
    typeKey: "example.query.a",
    recordKind: "observed",
    limit: 1,
    projectionId: page.nextCursor.projectionId,
    cursor: page.nextCursor.observationId,
  });
  assert.notEqual(next.results[0].observationId, page.results[0].observationId);
  assert.equal(next.returned, 1);
  assert.equal(next.omitted, 0);
  assert.equal(next.nextCursor, null);
  assert.deepEqual(next.inventorySummary, page.inventorySummary);
  const none = api.queryObservations({ root, typeKey: "example.query.missing" });
  assert.equal(none.totalMatches, 0);
  assert.equal(none.inventorySummary.status, "active");
  const derived = api.queryObservations({ root, recordKind: "derived" });
  assert.equal(derived.returned, 1);
  assert.equal(derived.results[0].kind, "DerivedObservationRecord");
  for (const result of [page, next, none, derived]) {
    assert.equal(result.semanticSelection, false);
    for (const field of ["instructionAuthority", "promotionAuthority", "recoveryAuthority"]) assert.equal(result[field], false);
  }
  assert.deepEqual(snapshot(root), before);
  assert.equal(fs.existsSync(path.join(root, layout.directory, "world-model/current.json")), false);
});

test("empty inventory and cursor errors are explicit and do not block unrelated ordinary work", async (t) => {
  const { root, layout } = fixture(t);
  const empty = api.queryObservations({ root });
  assert.equal(empty.inventorySummary.status, "not_started");
  assert.deepEqual(empty.inventorySummary.counts, { descriptors: 0, observations: 0, derivedObservations: 0, receipts: 0, nodes: 0, edges: 0 });
  assert.equal(empty.returned, 0);
  await record(root, 0);
  await record(root, 1);
  const page = api.queryObservations({ root, limit: 1 });
  await record(root, 2);
  const before = snapshot(root);
  assert.throws(() => api.queryObservations({ root, limit: 1, projectionId: page.nextCursor.projectionId, cursor: page.nextCursor.observationId }), {
    code: "STALE_OBSERVATION_QUERY_CURSOR",
  });
  assert.throws(() => api.queryObservations({ root, limit: 0 }), { code: "INVALID_OBSERVATION_QUERY" });
  assert.equal(inspectProject(root).status, "ready");
  assert.deepEqual(snapshot(root), before);
});

test("missing exact receipt remains an observation-local error rather than an ordinary work gate", async (t) => {
  const { root, layout } = fixture(t);
  await record(root, 0);
  const receipts = path.join(root, layout.directory, "observations/receipts");
  const receipt = path.join(receipts, fs.readdirSync(receipts)[0]);
  fs.unlinkSync(receipt); // Synthetic fixture only; not a user-data migration.
  const before = snapshot(root);
  assert.throws(() => api.queryObservations({ root }), { code: "OBSERVATION_RECEIPT_MISSING" });
  assert.equal(inspectProject(root).status, "ready");
  assert.deepEqual(snapshot(root), before);
});

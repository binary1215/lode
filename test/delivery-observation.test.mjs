import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { deliveryObservationDescriptor, inspectDeliveryState, recordDeliveryObservation } from "../scripts/lib/delivery-observation.mjs";
import { loadObservationArtifacts, recordCollectedObservation } from "../scripts/lib/observation-store.mjs";
import { verifyTemporalProvenanceGraph } from "../scripts/lib/temporal-provenance.mjs";
import { buildWorldModel, inspectWorldModel } from "../scripts/lib/world-model.mjs";
import { runCommand } from "../scripts/head.mjs";
import { dispatch, catalogTools as tools } from "../scripts/mcp-server.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testParent = process.env.HEAD_AGENT_TEST_TMP || os.tmpdir();
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;

function reidentifyGraph(graph) {
  const payload = { ...graph }; delete payload.graphSnapshotId; delete payload.graphSnapshotHash;
  const hash = sha(JSON.stringify(canonical(payload)));
  return { ...payload, graphSnapshotId: `graph-snapshot-${hash.slice(0, 24)}`, graphSnapshotHash: hash };
}

async function fixture(t) {
  fs.mkdirSync(testParent, { recursive: true });
  const root = fs.mkdtempSync(path.join(testParent, "head-agent-delivery-observation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const layout = inspectProject(root).storage;
  fs.mkdirSync(path.join(root, "revisions"), { recursive: true });
  fs.writeFileSync(path.join(root, "revisions", "v1.txt"), "public fixture revision one\n");
  fs.writeFileSync(path.join(root, "revisions", "v2.txt"), "public fixture revision two\n");
  const built = await buildWorldModel({ root, persist: true });
  const revisions = new Map(built.snapshot.temporalProvenanceGraph.nodes
    .filter((node) => node.kind === "FileRevision")
    .map((node) => [node.path, node]));
  return { root, layout, initialWorld: built.snapshot, v1: revisions.get("revisions/v1.txt"), v2: revisions.get("revisions/v2.txt") };
}

function input({ targetKey, revision, revisionKey, suffix, sequence = 0, outcome = "applied", predecessorObservationId = null, rollbackTargetObservationId = null, environmentKey = "environment-a", artifactKey = "service.public-api", worldModelId, exact = true, observedAt = "2026-09-01T00:00:00.000Z" }) {
  return {
    environmentKey,
    targetKey,
    artifactKey,
    revisionKey,
    revisionDigest: revision.digest,
    outcome,
    sequence,
    predecessorObservationId,
    rollbackTargetObservationId,
    observedAt,
    sourceScopeDigest: sha(`scope:${environmentKey}`),
    sourceEventKeyDigest: sha(`event:${suffix}`),
    sourceEvidenceDigest: sha(`evidence:${suffix}`),
    ...(exact ? { revisionReference: {
      worldModelId,
      revisionId: revision.nodeId,
      sourcePath: revision.path,
      digest: revision.digest,
    } } : {}),
  };
}

test("delivery history derives mixed, failed, and rollback state without authority amplification", async (t) => {
  const { root, layout, initialWorld, v1, v2 } = await fixture(t);
  const canonFile = path.join(root, layout.directory, "context", "product-model.json");
  const sessionFile = path.join(root, layout.directory, "sessions", "current.json");
  const canonBefore = fs.readFileSync(canonFile, "utf8");
  const sessionBefore = fs.readFileSync(sessionFile, "utf8");
  const worldModelId = initialWorld.worldModelId;

  const aOneV1 = await recordDeliveryObservation({ root, ...input({ targetKey: "target-one", revision: v1, revisionKey: "v1", suffix: "a-one-v1", worldModelId }) });
  const aTwoV1 = await recordDeliveryObservation({ root, ...input({ targetKey: "target-two", revision: v1, revisionKey: "v1", suffix: "a-two-v1", worldModelId }) });
  await recordDeliveryObservation({ root, ...input({ targetKey: "target-one", revision: v2, revisionKey: "v2", suffix: "b-one-v2", environmentKey: "environment-b", worldModelId }) });
  await recordDeliveryObservation({ root, ...input({ targetKey: "target-two", revision: v2, revisionKey: "v2", suffix: "b-two-v2", environmentKey: "environment-b", worldModelId }) });
  assert.equal((await inspectDeliveryState({ root, environmentKey: "environment-a" })).environments[0].state, "uniform");

  const aOneV2 = await recordDeliveryObservation({ root, ...input({
    targetKey: "target-one", revision: v2, revisionKey: "v2", suffix: "a-one-v2", sequence: 1,
    predecessorObservationId: aOneV1.observation.observationId, worldModelId,
  }) });
  const mixed = (await inspectDeliveryState({ root, environmentKey: "environment-a" }));
  assert.equal(mixed.environments[0].state, "mixed");
  assert.equal(mixed.environments[0].deploymentCompleteEstablished, false);
  assert.equal(mixed.environments[0].unobservedTargetsInferred, false);

  const failed = await recordDeliveryObservation({ root, ...input({
    targetKey: "target-one", revision: v2, revisionKey: "v2", suffix: "a-one-failed", sequence: 2, outcome: "failed",
    predecessorObservationId: aOneV2.observation.observationId, worldModelId,
  }) });
  const afterFailure = (await inspectDeliveryState({ root, environmentKey: "environment-a", targetKey: "target-one" })).targets[0];
  assert.equal(afterFailure.current.revisionKey, "v2");
  assert.equal(afterFailure.lastAttempt.outcome, "failed");

  const rollback = await recordDeliveryObservation({ root, ...input({
    targetKey: "target-one", revision: v1, revisionKey: "v1", suffix: "a-one-rollback", sequence: 3, outcome: "rolled-back",
    predecessorObservationId: failed.observation.observationId,
    rollbackTargetObservationId: aOneV2.observation.observationId,
    worldModelId,
  }) });
  const final = (await inspectDeliveryState({ root, environmentKey: "environment-a" }));
  assert.equal(final.environments[0].state, "uniform");
  assert.equal(final.targets.find((target) => target.targetKey === "target-one").current.observationId, rollback.observation.observationId);
  assert.equal(final.targets.find((target) => target.targetKey === "target-two").current.observationId, aTwoV1.observation.observationId);
  assert.equal(final.semantics.failedAttemptOverwritesCurrentSuccess, false);
  assert.equal(final.semantics.unobservedTargetSuccessInferred, false);
  assert.equal(final.authority.projection, "P4-derived-nonpersisted");
  assert.equal(final.ordinaryWorkBlocked, false);
  assert.equal(fs.readFileSync(canonFile, "utf8"), canonBefore);
  assert.equal(fs.readFileSync(sessionFile, "utf8"), sessionBefore);

  const graph = (await inspectWorldModel({ root })).snapshot.temporalProvenanceGraph;
  for (const observed of [aOneV1, aTwoV1, aOneV2, failed, rollback]) {
    assert.ok(graph.edges.some((edge) => edge.type === "AT_REVISION" && edge.from === observed.observation.observationId && edge.to === observed.observation.payload.bound_revision_id));
  }
  assert.ok(graph.nodes.some((node) => node.nodeId === v1.nodeId && node.kind === "FileRevision"));
  const tampered = structuredClone(graph);
  tampered.edges = tampered.edges.filter((edge) => !(edge.type === "AT_REVISION" && edge.from === rollback.observation.observationId));
  assert.throws(() => verifyTemporalProvenanceGraph(reidentifyGraph(tampered)), (error) => error.code === "DELIVERY_REVISION_REFERENCE_MISSING");
});

test("delivery order conflicts remain unknown and never select newest receipt time", async (t) => {
  const { root, layout, initialWorld, v1, v2 } = await fixture(t);
  const first = await recordDeliveryObservation({ root, ...input({ targetKey: "target-conflict", revision: v1, revisionKey: "v1", suffix: "conflict-0", worldModelId: initialWorld.worldModelId, observedAt: "2026-09-03T00:00:00.000Z" }) });
  await recordDeliveryObservation({ root, ...input({
    targetKey: "target-conflict", revision: v2, revisionKey: "v2", suffix: "conflict-2", sequence: 2,
    predecessorObservationId: first.observation.observationId, worldModelId: initialWorld.worldModelId,
    observedAt: "2026-09-01T00:00:00.000Z",
  }) });
  const status = (await inspectDeliveryState({ root, targetKey: "target-conflict" }));
  assert.equal(status.targets[0].state, "unknown");
  assert.equal(status.targets[0].current, null);
  assert.equal(status.targets[0].ordering.coherent, false);
  assert.ok(status.targets[0].ordering.issues.some((issue) => issue.code === "predecessor-sequence-mismatch"));
  assert.equal(status.semantics.currentSelectionBasis, "explicit-sequence-and-predecessor-not-receipt-time");
});

test("independent artifacts on one target keep independent order and do not manufacture mixed versions", async (t) => {
  const { root, layout, initialWorld, v1, v2 } = await fixture(t);
  await recordDeliveryObservation({ root, ...input({
    targetKey: "shared-target", artifactKey: "service.api", revision: v1, revisionKey: "v1", suffix: "artifact-api", worldModelId: initialWorld.worldModelId,
  }) });
  await recordDeliveryObservation({ root, ...input({
    targetKey: "shared-target", artifactKey: "service.worker", revision: v2, revisionKey: "v2", suffix: "artifact-worker", worldModelId: initialWorld.worldModelId,
  }) });
  const status = (await inspectDeliveryState({ root, environmentKey: "environment-a", targetKey: "shared-target" }));
  assert.equal(status.targets.length, 2);
  assert.equal(status.environments[0].observedTargetCount, 1);
  assert.equal(status.environments[0].observedArtifactTargetCount, 2);
  assert.equal(status.environments[0].artifacts.length, 2);
  assert.equal(status.environments[0].state, "uniform");
});

test("declared revisions remain disclosed while invalid exact bindings fail before persistence", async (t) => {
  const { root, layout, initialWorld, v1 } = await fixture(t);
  const before = loadObservationArtifacts({ projectRoot: root, projectId: initialWorld.projectId, storage: layout }).observations.length;
  await assert.rejects(async () => (await recordDeliveryObservation({ root, ...input({
    targetKey: "invalid", revision: v1, revisionKey: "v1", suffix: "invalid", worldModelId: initialWorld.worldModelId,
    revisionReference: undefined,
  }), revisionReference: {
    worldModelId: initialWorld.worldModelId,
    revisionId: v1.nodeId,
    sourcePath: v1.path,
    digest: sha("not-the-revision"),
  } })), { code: "DELIVERY_REVISION_REFERENCE_INVALID" });
  assert.equal(loadObservationArtifacts({ projectRoot: root, projectId: initialWorld.projectId, storage: layout }).observations.length, before);

  const declared = await recordDeliveryObservation({ root, ...input({ targetKey: "declared", revision: v1, revisionKey: "v1", suffix: "declared", worldModelId: initialWorld.worldModelId, exact: false }) });
  assert.equal(declared.observation.payload.revision_binding, "declared");
  const current = (await inspectDeliveryState({ root, targetKey: "declared" })).targets[0].current;
  assert.equal(current.revisionReference.exactRevisionReferenceEstablished, false);
  const graph = (await inspectWorldModel({ root })).snapshot.temporalProvenanceGraph;
  assert.equal(graph.edges.some((edge) => edge.type === "AT_REVISION" && edge.from === declared.observation.observationId), false);
});

test("generic Observation ingest cannot self-assert Core delivery revision proof", async (t) => {
  const { root, layout, initialWorld, v1 } = await fixture(t);
  const before = loadObservationArtifacts({ projectRoot: root, projectId: initialWorld.projectId, storage: layout }).observations.length;
  const descriptor = deliveryObservationDescriptor(layout);
  const genericInput = {
    subject: { type: "delivery-target", key: "delivery.unverified" },
    form: "event",
    temporalScope: { observedAt: "2026-09-01T00:00:00.000Z", start: null, end: null },
    coverage: {
      state: "partial", basis: "unverified-generic-input", queryDigest: null, examinedCount: 1,
      sourceReportedTotal: null, omittedCount: null, cursorStartDigest: null, cursorEndDigest: null,
    },
    sourceEventKeyDigest: sha("generic-delivery-event"),
    sourceEvidenceDigest: sha("generic-delivery-evidence"),
    payload: {
      environment_key: "environment-a",
      target_key: "target-generic",
      artifact_key: "service.public-api",
      revision_key: "v1",
      revision_digest: v1.digest,
      outcome: "applied",
      sequence: 0,
      revision_binding: "verified-source-revision",
    },
  };
  assert.throws(() => recordCollectedObservation({
    root,
    descriptor,
    input: genericInput,
    adapterDescriptor: {
      adapterKey: "host.unverified",
      adapterVersion: "1",
      authority: "evidence-only",
      providerNeutral: true,
      persistsProviderIdentity: false,
    },
    sourceScopeDigest: sha("generic-delivery-scope"),
  }), { code: "RESERVED_OBSERVATION_TYPE_REQUIRES_SPECIALIZED_WRITER" });
  assert.equal(loadObservationArtifacts({ projectRoot: root, projectId: initialWorld.projectId, storage: layout }).observations.length, before);
  assert.equal((await inspectDeliveryState({ root })).status, "not_started");

  const mcp = await dispatch({ jsonrpc: "2.0", id: "generic-delivery", method: "tools/call", params: {
    name: "head_observation_ingest",
    arguments: {
      project_root: root,
      binding: {
        adapter_key: "lode.structured-host-observation",
        adapter_version: "0.1.0",
        source_scope_digest: sha("generic-delivery-scope"),
        credential_reference_names: [],
      },
      descriptor: {
        type_key: descriptor.typeKey,
        type_version: descriptor.typeVersion,
        forms: descriptor.forms,
        payload_schema: {
          additional_fields: false,
          fields: descriptor.payloadSchema.fields.map((field) => ({
            key: field.key,
            type: field.type,
            required: field.required,
            ...(field.max == null ? {} : { max: field.max }),
            ...(field.enum == null ? {} : { enum: field.enum }),
          })),
        },
      },
      observation: {
        subject: genericInput.subject,
        form: genericInput.form,
        temporal_scope: {
          observed_at: genericInput.temporalScope.observedAt,
          start: genericInput.temporalScope.start,
          end: genericInput.temporalScope.end,
        },
        source_event_key_digest: genericInput.sourceEventKeyDigest,
        source_evidence_digest: genericInput.sourceEvidenceDigest,
        coverage: {
          state: genericInput.coverage.state,
          basis: genericInput.coverage.basis,
          query_digest: genericInput.coverage.queryDigest,
          examined_count: genericInput.coverage.examinedCount,
          source_reported_total: genericInput.coverage.sourceReportedTotal,
          omitted_count: genericInput.coverage.omittedCount,
          cursor_start_digest: genericInput.coverage.cursorStartDigest,
          cursor_end_digest: genericInput.coverage.cursorEndDigest,
        },
        payload: genericInput.payload,
      },
      confirm_host_observation: true,
    },
  } });
  assert.match(mcp.error?.message || "", /dedicated delivery writer/i);
  assert.equal(loadObservationArtifacts({ projectRoot: root, projectId: initialWorld.projectId, storage: layout }).observations.length, before);
});

test("verified historical source revisions remain connected through a derived RevisionReference", async (t) => {
  const { root, layout, initialWorld, v1 } = await fixture(t);
  fs.unlinkSync(path.join(root, "revisions", "v1.txt"));
  await buildWorldModel({ root, persist: true });
  const observed = await recordDeliveryObservation({ root, ...input({
    targetKey: "historical-target", revision: v1, revisionKey: "v1", suffix: "historical-v1", worldModelId: initialWorld.worldModelId,
  }) });
  const graph = (await inspectWorldModel({ root })).snapshot.temporalProvenanceGraph;
  const reference = graph.nodes.find((node) => node.nodeId === v1.nodeId);
  assert.equal(reference.kind, "RevisionReference");
  assert.equal(reference.referencedWorldModelId, initialWorld.worldModelId);
  assert.equal(reference.path, v1.path);
  assert.equal(reference.digest, v1.digest);
  assert.ok(graph.edges.some((edge) => edge.type === "AT_REVISION" && edge.from === observed.observation.observationId && edge.to === reference.nodeId));
});

test("delivery observation replay is exact and CLI and typed MCP agree on bounded status", async (t) => {
  const { root, layout, initialWorld, v1 } = await fixture(t);
  const firstInput = input({ targetKey: "target-one", revision: v1, revisionKey: "v1", suffix: "replay", worldModelId: initialWorld.worldModelId });
  const first = await recordDeliveryObservation({ root, ...firstInput });
  const replay = await recordDeliveryObservation({ root, ...firstInput });
  assert.equal(replay.status, "existing");
  assert.equal(replay.observation.observationId, first.observation.observationId);
  await assert.rejects(async () => (await recordDeliveryObservation({ root, ...firstInput, outcome: "failed" })), { code: "DIVERGENT_OBSERVATION_REPLAY" });

  assert.ok(tools.some((tool) => tool.name === "lode_delivery_observe"));
  assert.ok(tools.some((tool) => tool.name === "lode_delivery_status"));
  const cli = await runCommand(["delivery-status", root, "--environment", "environment-a", "--history-limit", "1"]);
  const mcp = await dispatch({ jsonrpc: "2.0", id: "delivery-status", method: "tools/call", params: { name: "head_delivery_status", arguments: {
    project_root: root, environment_key: "environment-a", history_limit: 1,
  } } });
  assert.equal(mcp.error, undefined, JSON.stringify(mcp.error));
  assert.equal(mcp.result.structuredContent.projectionId, cli.projectionId);
  assert.deepEqual(mcp.result.structuredContent.targets, cli.targets);
  assert.match(mcp.result.content[0].text, /observed target/);
  assert.match(mcp.result.content[0].text, /completeness and unobserved target success are not inferred/);
  assert.equal(cli.history.complete, true);
});

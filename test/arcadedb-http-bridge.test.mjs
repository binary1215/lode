import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { readFixtureSnapshot, writeFixtureSnapshot } from "./helpers/snapshot-storage-fixture.mjs";
import { ArcadeDbHttpTransport, ActivatedArcadeDbGraphProjectionAdapter, LocalJsonGraphProjectionAdapter, buildGraphProjectionPointer } from "../scripts/lib/graph-projection-adapter.mjs";
import { buildStorageSelection } from "../scripts/lib/onboarding-contract.mjs";
import { buildTemporalProvenanceGraph } from "../scripts/lib/temporal-provenance.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const fixture = new URL("./helpers/arcadedb-fetch-fault-fixture.mjs", import.meta.url).href;
const selection = buildStorageSelection({ projectId: "bridge-test-project", selection: {
  mode: "graphdb", endpoint: "https://synthetic.invalid", database: "fixture",
  secretReferenceNames: { username: "HEAD_TEST_BRIDGE_USER", password: "HEAD_TEST_BRIDGE_PASSWORD" },
} });

test("actual bridge classifies body interruption and adapter only falls back before remote observation", async () => {
  const root = fs.mkdtempSync(path.join(pluginRoot, ".qa-bridge-recovery-"));
  const originalSpawn = childProcess.spawnSync;
  const oldUser = process.env.HEAD_TEST_BRIDGE_USER, oldPassword = process.env.HEAD_TEST_BRIDGE_PASSWORD;
  process.env.HEAD_TEST_BRIDGE_USER = "synthetic";
  process.env.HEAD_TEST_BRIDGE_PASSWORD = "synthetic";
  let mode = "body";
  childProcess.spawnSync = (command, args, options) => {
    if (args?.[0]?.endsWith("arcadedb-http-bridge.mjs")) {
      const result = originalSpawn(command, ["--import", fixture, ...args], { ...options, env: { ...options.env, HEAD_TEST_BRIDGE_FAULT: mode } });
      process.stderr.write(result.stderr || "");
      process.stderr.write(`${JSON.stringify({ event: "closed", pid: result.pid, exitCode: result.status, ports: [] })}\n`);
      return result;
    }
    return originalSpawn(command, args, options);
  };
  try {
    const graph = buildTemporalProvenanceGraph({ projectId: selection.projectId, files: [] });
    const local = new LocalJsonGraphProjectionAdapter({ projectRoot: root });
    (await local.writeSnapshot(graph.graphSnapshotId, graph));
    local.writePointer(buildGraphProjectionPointer(graph));
    for (mode of ["headers", "body", "timeout"]) {
      const transport = new ArcadeDbHttpTransport({ storageSelection: selection });
      assert.throws(() => transport.invoke("query", { command: "SELECT 1" }), { code: "ARCADEDB_TRANSPORT_UNAVAILABLE" });
      const adapter = new ActivatedArcadeDbGraphProjectionAdapter({ projectRoot: root, storageSelection: selection, transport });
      assert.equal((await adapter.readPointer()).document.graphSnapshotId, graph.graphSnapshotId);
      assert.equal(adapter.fallbackUsed, true);
      assert.throws(() => transport.invoke("command", { command: "UPDATE synthetic SET value=1" }), { code: "ARCADEDB_WRITE_OUTCOME_UNKNOWN" });
    }
    for (const [fault, code] of [["empty", "ARCADEDB_REMOTE_RESPONSE_INVALID"], ["malformed", "ARCADEDB_REMOTE_RESPONSE_INVALID"], ["auth", "ARCADEDB_AUTHENTICATION_FAILED"]]) {
      mode = fault;
      const adapter = new ActivatedArcadeDbGraphProjectionAdapter({ projectRoot: root, storageSelection: selection });
      await assert.rejects(() => adapter.readPointer(), { code });
      assert.equal(adapter.fallbackUsed, false);
    }
    mode = "body";
    const unavailable = () => { throw Object.assign(new Error("lost"), { code: "ARCADEDB_TRANSPORT_UNAVAILABLE" }); };
    const observed = new ActivatedArcadeDbGraphProjectionAdapter({ projectRoot: root, storageSelection: selection,
      remoteAdapter: { readPointer: () => null, readSnapshot: unavailable } });
    assert.equal(await observed.readPointer(), null);
    (await assert.rejects(async () => (await observed.readSnapshot(graph.graphSnapshotId)), { code: "ARCADEDB_TRANSPORT_UNAVAILABLE" }));
    assert.equal(observed.fallbackUsed, false);
    const tampered = readFixtureSnapshot(local.snapshotLocation(graph.graphSnapshotId));
    tampered.projectId = "wrong-project";
    writeFixtureSnapshot(local.snapshotLocation(graph.graphSnapshotId), tampered);
    await assert.rejects(() => new ActivatedArcadeDbGraphProjectionAdapter({ projectRoot: root, storageSelection: selection }).readPointer());
  } finally {
    childProcess.spawnSync = originalSpawn;
    if (oldUser === undefined) delete process.env.HEAD_TEST_BRIDGE_USER; else process.env.HEAD_TEST_BRIDGE_USER = oldUser;
    if (oldPassword === undefined) delete process.env.HEAD_TEST_BRIDGE_PASSWORD; else process.env.HEAD_TEST_BRIDGE_PASSWORD = oldPassword;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

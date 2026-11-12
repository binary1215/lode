import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createArcadeDbNativeBridgeManifest,
  resolveVerifiedArcadeDbNativeBridge,
  verifyArcadeDbNativeBridgeManifest,
} from "../scripts/lib/world/arcadedb-native-bridge.mjs";
import { buildStorageSelection } from "../scripts/lib/session/onboarding-contract.mjs";
import { ArcadeDbHttpTransport, buildArcadeDbBridgeEnvironment } from "../scripts/lib/world/graph-projection-adapter.mjs";

const javascriptBridge = fileURLToPath(new URL("../scripts/lib/world/arcadedb-http-bridge.mjs", import.meta.url));

const targets = {
  "darwin-arm64": { directory: "darwin-arm64", executable: "lode-agent-arcadedb-bridge" },
  "darwin-x64": { directory: "darwin-x64", executable: "lode-agent-arcadedb-bridge" },
  "linux-arm64": { directory: "linux-arm64", executable: "lode-agent-arcadedb-bridge" },
  "linux-x64": { directory: "linux-x64", executable: "lode-agent-arcadedb-bridge" },
  "win32-x64": { directory: "windows-x64", executable: "lode-agent-arcadedb-bridge.exe" },
};

test("pins the read-only ArcadeDB native bridge to one target binary and authority contract", () => {
  const target = targets[`${process.platform}-${process.arch}`];
  assert(target);
  const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "head-arcadedb-bridge-manifest-"));
  try {
    const directory = path.join(pluginRoot, "dist", target.directory);
    fs.mkdirSync(directory, { recursive: true });
    const binaryFile = path.join(directory, target.executable);
    fs.writeFileSync(binaryFile, "fixture bridge\n", { flag: "wx", mode: 0o755 });
    const manifest = createArcadeDbNativeBridgeManifest({
      platform: process.platform,
      arch: process.arch,
      binaryFile,
      manifestDirectory: directory,
    });
    fs.writeFileSync(path.join(directory, "ARCADEDB-BRIDGE-MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    const resolved = resolveVerifiedArcadeDbNativeBridge({ pluginRoot });
    assert.equal(resolved.binaryPath, fs.realpathSync(binaryFile));
    assert.equal(resolved.manifest.authority.kind, "read-only-transport");
    assert.equal(resolved.manifest.processModel.databaseWrites, "forbidden-by-query-endpoint");

    const elevated = structuredClone(manifest);
    elevated.authority.canonicalAuthority = true;
    assert.throws(() => verifyArcadeDbNativeBridgeManifest(elevated), { code: "INVALID_ARCADEDB_NATIVE_BRIDGE_MANIFEST" });

    fs.appendFileSync(binaryFile, "tampered\n");
    assert.throws(() => resolveVerifiedArcadeDbNativeBridge({ pluginRoot }), { code: "ARCADEDB_NATIVE_BRIDGE_BINARY_DIGEST_MISMATCH" });
  } finally {
    fs.rmSync(pluginRoot, { recursive: true, force: true });
  }
});

test("the JavaScript reference batch rejects non-SELECT text before network access", () => {
  const result = childProcess.spawnSync(process.execPath, [javascriptBridge], {
    input: JSON.stringify({
      protocol: { name: "head-agent-core-arcadedb-query-batch", version: "0.1.0" },
      endpoint: "http://127.0.0.1:1",
      database: "head-test",
      secretReferenceNames: { username: "HEAD_TEST_USERNAME", password: "HEAD_TEST_PASSWORD" },
      operation: "query-batch",
      timeoutMs: 1000,
      queries: [{ language: "sql", command: "DELETE FROM HeadAgentGraphNode", params: {} }],
    }),
    encoding: "utf8",
    windowsHide: true,
    timeout: 3000,
    env: { ...process.env, HEAD_TEST_USERNAME: "reader", HEAD_TEST_PASSWORD: "secret" },
  });
  assert.equal(result.status, 1);
  const response = JSON.parse(result.stdout);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "ARCADEDB_BRIDGE_INVALID_INPUT");
});

test("the exact child receives only its credential references and bounded operational environment", () => {
  const input = { secretReferenceNames: { username: "HEAD_TEST_USERNAME", password: "HEAD_TEST_PASSWORD" } };
  const environment = buildArcadeDbBridgeEnvironment(input, {
    HEAD_TEST_USERNAME: "reader",
    HEAD_TEST_PASSWORD: "secret",
    SystemRoot: "C:\\Windows",
    HTTPS_PROXY: "http://proxy.invalid",
    NODE_OPTIONS: "--require=untrusted.js",
    UNRELATED_API_KEY: "must-not-cross-the-child-boundary",
  });
  assert.deepEqual(environment, {
    SystemRoot: "C:\\Windows",
    HTTPS_PROXY: "http://proxy.invalid",
    HEAD_TEST_USERNAME: "reader",
    HEAD_TEST_PASSWORD: "secret",
  });
  assert.equal("NODE_OPTIONS" in environment, false);
  assert.equal("UNRELATED_API_KEY" in environment, false);

  assert.throws(
    () =>
      buildStorageSelection({
        projectId: "head-test",
        selection: {
          mode: "graphdb",
          endpoint: "https://graph.example.invalid",
          database: "head-test",
          secretReferenceNames: { username: "NODE_OPTIONS", password: "HEAD_TEST_PASSWORD" },
        },
      }),
    { code: "INVALID_ONBOARDING_SECRET_REFERENCE" },
  );
});

test("native batch policy keeps off explicit and fails closed on post-selection integrity drift", () => {
  const storageSelection = buildStorageSelection({
    projectId: "head-test",
    selection: {
      mode: "graphdb",
      endpoint: "http://127.0.0.1:1",
      database: "head-test",
      secretReferenceNames: { username: "HEAD_TEST_USERNAME", password: "HEAD_TEST_PASSWORD" },
    },
  });
  const disabled = new ArcadeDbHttpTransport({ storageSelection, nativeBatchBridge: "off" });
  assert.equal(disabled.describe().nativeBatchMode, "off");
  assert.equal(disabled.describe().nativeBatchCandidateSelected, false);
  assert.throws(() => new ArcadeDbHttpTransport({ storageSelection, nativeBatchBridge: "sometimes" }), { code: "INVALID_ARCADEDB_NATIVE_BRIDGE_MODE" });

  const actualDigest = crypto.createHash("sha256").update(fs.readFileSync(process.execPath)).digest("hex");
  const driftedDigest = `${actualDigest[0] === "0" ? "1" : "0"}${actualDigest.slice(1)}`;
  const required = new ArcadeDbHttpTransport({
    storageSelection,
    nativeBatchBridge: { executablePath: process.execPath, sha256: driftedDigest },
  });
  assert.equal(required.describe().nativeBatchMode, "required");
  assert.throws(() => required.invokeQueryBatch([{ language: "sql", command: "SELECT 1", params: {} }]), { code: "ARCADEDB_NATIVE_BRIDGE_INTEGRITY_MISMATCH" });
  assert.deepEqual(required.preparedReadBatchDiagnostics(), {
    backend: "javascript-exact-child",
    fallbackUsed: false,
    fallbackReasonCode: "",
  });
});

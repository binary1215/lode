#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { createGoWorkerManifest } from "./lib/go-worker-adapter.mjs";
import { createProcessSupervisorManifest, PROCESS_SUPERVISOR_MANIFEST_VERSION, PROCESS_SUPERVISOR_INTERACTIVE_PROTOCOL_VERSION } from "./lib/runtime-process-supervisor.mjs";
import { createArcadeDbNativeBridgeManifest } from "./lib/arcadedb-native-bridge.mjs";
import { acquireVerifiedNativeArtifact, assembleVerifiedNativeBundle, verifyNativeBundleOverlay } from "./lib/native-artifact-delivery.mjs";
import { installDistribution, inspectDistribution, uninstallDistribution } from "./lib/distribution-lifecycle.mjs";
import { buildCodexMarketplaceSnapshot, verifyCodexMarketplaceSnapshot } from "./lib/codex-marketplace.mjs";
import { buildClaudeMarketplaceSnapshot, verifyClaudeMarketplaceSnapshot } from "./lib/claude-marketplace.mjs";
import { ARTIFACT_COMPOSITION } from "./lib/lode-artifact-composition.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8")).version;
const goNotices = fs.readFileSync(path.join(sourceRoot, "native", "GO-NOTICES.txt"));
const scratchRoot = path.join(os.tmpdir(), `head-native-delivery-e2e-${process.pid}`);
const fixtureRoot = path.join(scratchRoot, "fixture");
const targetMap = {
  "darwin-arm64": { platform: "darwin", arch: "arm64", package: "lode-agent-worker-darwin-arm64", directory: "darwin-arm64", goos: "darwin", goarch: "arm64", worker: "lode-agent-worker", supervisor: "lode-agent-supervisor", bridge: "lode-agent-arcadedb-bridge" },
  "darwin-x64": { platform: "darwin", arch: "x64", package: "lode-agent-worker-darwin-amd64", directory: "darwin-x64", goos: "darwin", goarch: "amd64", worker: "lode-agent-worker", supervisor: "lode-agent-supervisor", bridge: "lode-agent-arcadedb-bridge" },
  "linux-arm64": { platform: "linux", arch: "arm64", package: "lode-agent-worker-linux-arm64", directory: "linux-arm64", goos: "linux", goarch: "arm64", worker: "lode-agent-worker", supervisor: "lode-agent-supervisor", bridge: "lode-agent-arcadedb-bridge" },
  "linux-x64": { platform: "linux", arch: "x64", package: "lode-agent-worker-linux-amd64", directory: "linux-x64", goos: "linux", goarch: "amd64", worker: "lode-agent-worker", supervisor: "lode-agent-supervisor", bridge: "lode-agent-arcadedb-bridge" },
  "win32-x64": { platform: "win32", arch: "x64", package: "lode-agent-worker-windows-amd64", directory: "windows-x64", goos: "windows", goarch: "amd64", worker: "lode-agent-worker.exe", supervisor: "lode-agent-supervisor.exe", bridge: "lode-agent-arcadedb-bridge.exe" },
};
const target = targetMap[`${process.platform}-${process.arch}`];
assert(target, `Native delivery fixture does not support ${process.platform}-${process.arch}.`);

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function writeOctal(header, start, length, value) {
  const text = value.toString(8).padStart(length - 1, "0");
  header.write(text, start, length - 1, "ascii");
  header[start + length - 1] = 0;
}

function tarEntry(name, bytes, mode = 0o644) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, bytes.length);
  writeOctal(header, 136, 12, 0);
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 32;
  const padding = Buffer.alloc((512 - bytes.length % 512) % 512);
  return Buffer.concat([header, bytes, padding]);
}

function archive(entries) {
  return zlib.gzipSync(Buffer.concat([
    ...entries.map(({ name, bytes, mode }) => tarEntry(name, bytes, mode)),
    Buffer.alloc(1024),
  ]), { level: 9, mtime: 0 });
}

function fixtureArchive(fixtureTarget = target, { notices = true, extraEntries = [] } = {}) {
  const directory = path.join(fixtureRoot, fixtureTarget.directory);
  fs.mkdirSync(directory, { recursive: true });
  const workerFile = path.join(directory, fixtureTarget.worker);
  const supervisorFile = path.join(directory, fixtureTarget.supervisor);
  const bridgeFile = path.join(directory, fixtureTarget.bridge);
  fs.writeFileSync(workerFile, "fixture worker\n", { mode: 0o755 });
  fs.writeFileSync(supervisorFile, "fixture supervisor\n", { mode: 0o755 });
  fs.writeFileSync(bridgeFile, "fixture arcadedb bridge\n", { mode: 0o755 });
  const workerManifest = createGoWorkerManifest({ platform: fixtureTarget.platform, arch: fixtureTarget.arch, binaryFile: workerFile, manifestDirectory: directory });
  const supervisorManifest = createProcessSupervisorManifest({ platform: fixtureTarget.platform, arch: fixtureTarget.arch, binaryFile: supervisorFile, manifestDirectory: directory });
  const bridgeManifest = createArcadeDbNativeBridgeManifest({ platform: fixtureTarget.platform, arch: fixtureTarget.arch, binaryFile: bridgeFile, manifestDirectory: directory });
  const metadata = { version, commit: "a".repeat(40), goos: fixtureTarget.goos, goarch: fixtureTarget.goarch, cgoEnabled: false };
  const files = [
    ...(notices ? [["GO-NOTICES.txt", goNotices, 0o644]] : []),
    ["BUILD-METADATA.json", Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`), 0o644],
    ["WORKER-MANIFEST.json", Buffer.from(`${JSON.stringify(workerManifest, null, 2)}\n`), 0o644],
    ["SUPERVISOR-MANIFEST.json", Buffer.from(`${JSON.stringify(supervisorManifest, null, 2)}\n`), 0o644],
    ["ARCADEDB-BRIDGE-MANIFEST.json", Buffer.from(`${JSON.stringify(bridgeManifest, null, 2)}\n`), 0o644],
    [fixtureTarget.worker, fs.readFileSync(workerFile), 0o755],
    [fixtureTarget.supervisor, fs.readFileSync(supervisorFile), 0o755],
    [fixtureTarget.bridge, fs.readFileSync(bridgeFile), 0o755],
    ...extraEntries,
  ];
  return archive(files.map(([name, bytes, mode]) => ({ name: `${fixtureTarget.directory}/${name}`, bytes, mode })));
}

function fetchFixture(assetName, archiveBytes, { unavailable = false } = {}) {
  return async (url) => {
    if (unavailable) return new Response("missing", { status: 404 });
    if (url.endsWith("/SHA256SUMS")) {
      return new Response(`${sha256(archiveBytes)}  ${assetName}\n`, { status: 200, headers: { "content-length": String(66 + assetName.length) } });
    }
    if (url.endsWith(`/${assetName}`)) return new Response(archiveBytes, { status: 200, headers: { "content-length": String(archiveBytes.length) } });
    return new Response("missing", { status: 404 });
  };
}

try {
  fs.mkdirSync(scratchRoot, { recursive: true });
  const archiveBytes = fixtureArchive();
  const assetName = `${target.package}.tar.gz`;
  const acquired = await acquireVerifiedNativeArtifact({
    version,
    mode: "required",
    fetchImplementation: fetchFixture(assetName, archiveBytes),
    temporaryParent: scratchRoot,
  });
  assert.equal(acquired.status, "verified");
  assert.equal(acquired.assetName, assetName);
  assert.deepEqual(fs.readFileSync(path.join(acquired.pluginRoot, "dist", target.directory, "GO-NOTICES.txt")), goNotices);
  const acquiredSupervisorBytes = fs.readFileSync(path.join(acquired.pluginRoot, "dist", target.directory, "SUPERVISOR-MANIFEST.json"));
  const acquiredSupervisor = JSON.parse(acquiredSupervisorBytes);
  assert.equal(acquiredSupervisor.manifestVersion, PROCESS_SUPERVISOR_MANIFEST_VERSION);
  assert.equal(acquiredSupervisor.manifestVersion, "0.3.0");
  assert.equal(acquiredSupervisor.capabilities.declarationOnly, true);
  assert.deepEqual(acquiredSupervisor.capabilities.processSupervision, {
    oneShotProtocolVersion: "0.1.0", jobProtocolVersion: "0.1.0",
    detachedJobAvailability: "runtime-platform-preflight-required",
    interactiveProtocolVersion: PROCESS_SUPERVISOR_INTERACTIVE_PROTOCOL_VERSION,
    interactiveTransport: "bounded-bootstrap-line-streaming-stdio",
  });
  assert.equal(acquiredSupervisor.processModel.transport, "single-request-stdio-with-control-fd3");
  assert.equal(acquiredSupervisor.authority.grantsExecutionAuthorization, false);
  assert.equal(acquiredSupervisor.authority.grantsWriteAuthorization, false);
  assert.equal(acquiredSupervisor.authority.recoveryAuthority, false);

  const legacyArchive = fixtureArchive(target, { notices: false });
  const legacy = await acquireVerifiedNativeArtifact({ version, mode: "required", fetchImplementation: fetchFixture(assetName, legacyArchive), temporaryParent: scratchRoot });
  assert.equal(legacy.status, "verified");
  assert.equal(fs.existsSync(path.join(legacy.pluginRoot, "dist", target.directory, "GO-NOTICES.txt")), false);
  legacy.cleanup();
  for (const name of ["GO-NOTICES.txt", "unexpected.txt"]) {
    const invalidArchive = fixtureArchive(target, { extraEntries: [[name, goNotices, 0o644]] });
    await assert.rejects(
      acquireVerifiedNativeArtifact({ version, mode: "required", fetchImplementation: fetchFixture(assetName, invalidArchive), temporaryParent: scratchRoot }),
      (error) => error.code === "HEAD_NATIVE_ARCHIVE_CONTENT_INVALID",
    );
  }

  const installRoot = path.join(scratchRoot, "install");
  const binDirectory = path.join(scratchRoot, "bin");
  const installed = installDistribution({
    sourceRoot,
    installRoot,
    binDirectory,
    nativeOverlayRoot: acquired.pluginRoot,
  });
  assert.equal(installed.native.status, "verified");
  assert.equal(inspectDistribution({ installRoot, binDirectory }).native, "verified");
  const releaseTarget = path.join(installRoot, "releases", installed.releaseId, "dist", target.directory);
  assert.equal(fs.existsSync(path.join(releaseTarget, target.worker)), true);
  assert.equal(fs.existsSync(path.join(releaseTarget, target.bridge)), true);
  assert.deepEqual(fs.readFileSync(path.join(releaseTarget, "SUPERVISOR-MANIFEST.json")), acquiredSupervisorBytes);
  assert.deepEqual(fs.readFileSync(path.join(releaseTarget, "GO-NOTICES.txt")), goNotices);
  assert.deepEqual(fs.readFileSync(path.join(installRoot, "releases", installed.releaseId, "native", "GO-NOTICES.txt")), goNotices);
  acquired.cleanup();

  const unavailable = await acquireVerifiedNativeArtifact({
    version,
    mode: "auto",
    fetchImplementation: fetchFixture(assetName, archiveBytes, { unavailable: true }),
    temporaryParent: scratchRoot,
  });
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.reasonCode, "HEAD_NATIVE_RELEASE_UNAVAILABLE");

  const corruptedFetch = async (url) => {
    if (url.endsWith("/SHA256SUMS")) return new Response(`${"0".repeat(64)}  ${assetName}\n`, { status: 200 });
    return new Response(archiveBytes, { status: 200 });
  };
  await assert.rejects(
    acquireVerifiedNativeArtifact({ version, mode: "auto", fetchImplementation: corruptedFetch, temporaryParent: scratchRoot }),
    (error) => error.code === "HEAD_NATIVE_ARCHIVE_DIGEST_MISMATCH",
  );

  const unsafeArchive = archive([{ name: "../escape", bytes: Buffer.from("unsafe"), mode: 0o644 }]);
  await assert.rejects(
    acquireVerifiedNativeArtifact({ version, mode: "required", fetchImplementation: fetchFixture(assetName, unsafeArchive), temporaryParent: scratchRoot }),
    (error) => error.code === "HEAD_NATIVE_ARCHIVE_PATH_UNSAFE",
  );

  const artifactsRoot = path.join(scratchRoot, "all-platform-artifacts");
  fs.mkdirSync(artifactsRoot);
  for (const fixtureTarget of Object.values(targetMap)) {
    fs.writeFileSync(path.join(artifactsRoot, `${fixtureTarget.package}.tar.gz`), fixtureArchive(fixtureTarget), { flag: "wx" });
  }
  const bundleRoot = path.join(scratchRoot, "native-bundle");
  const assembled = assembleVerifiedNativeBundle({
    artifactsRoot,
    outputRoot: bundleRoot,
    version,
    commit: "a".repeat(40),
  });
  assert.equal(assembled.targets.length, 5);
  assert.equal(verifyNativeBundleOverlay({ pluginRoot: bundleRoot, version }).nativeBundleId, assembled.nativeBundleId);

  const missingArtifactsRoot = path.join(scratchRoot, "missing-platform-artifacts");
  fs.cpSync(artifactsRoot, missingArtifactsRoot, { recursive: true });
  fs.rmSync(path.join(missingArtifactsRoot, `${target.package}.tar.gz`));
  assert.throws(
    () => assembleVerifiedNativeBundle({ artifactsRoot: missingArtifactsRoot, outputRoot: path.join(scratchRoot, "invalid-bundle"), version }),
    (error) => error.code === "HEAD_NATIVE_BUNDLE_ARTIFACTS_INVALID",
  );

  const codexMarketplaceRoot = path.join(scratchRoot, "codex-marketplace");
  const codexMarketplace = buildCodexMarketplaceSnapshot({ sourceRoot, outputRoot: codexMarketplaceRoot, nativeOverlayRoot: bundleRoot });
  assert.equal(codexMarketplace.nativeTargetCount, 5);
  assert.equal(verifyCodexMarketplaceSnapshot({ root: codexMarketplaceRoot, requireNativeBundle: true }).nativeBundleId, assembled.nativeBundleId);

  const claudeMarketplaceRoot = path.join(scratchRoot, "claude-marketplace");
  const claudeMarketplace = buildClaudeMarketplaceSnapshot({ sourceRoot, outputRoot: claudeMarketplaceRoot, nativeOverlayRoot: bundleRoot });
  assert.equal(claudeMarketplace.nativeTargetCount, 5);
  assert.equal(verifyClaudeMarketplaceSnapshot({ root: claudeMarketplaceRoot, requireNativeBundle: true }).nativeBundleId, assembled.nativeBundleId);
  for (const marketplaceRoot of [codexMarketplaceRoot, claudeMarketplaceRoot]) {
    const pluginRoot = path.join(marketplaceRoot, "plugins", ARTIFACT_COMPOSITION.pluginName);
    assert.deepEqual(fs.readFileSync(path.join(pluginRoot, "native", "GO-NOTICES.txt")), goNotices);
    for (const fixtureTarget of Object.values(targetMap)) {
      assert.deepEqual(fs.readFileSync(path.join(pluginRoot, "dist", fixtureTarget.directory, "GO-NOTICES.txt")), goNotices);
      assert.deepEqual(fs.readFileSync(path.join(pluginRoot, "dist", fixtureTarget.directory, "SUPERVISOR-MANIFEST.json")),
        fs.readFileSync(path.join(bundleRoot, "dist", fixtureTarget.directory, "SUPERVISOR-MANIFEST.json")));
    }
  }

  uninstallDistribution({ installRoot, binDirectory, purge: true });
  process.stdout.write(`${JSON.stringify({
    status: "passed",
    platform: process.platform,
    arch: process.arch,
    verifiedArchiveInstalled: true,
    automaticFallbackVerified: true,
    checksumFailureClosed: true,
    pathEscapeRejected: true,
    immutableReleaseIncludesNative: true,
    exactFivePlatformBundleVerified: true,
    missingPlatformFailsClosed: true,
    codexMarketplaceIncludesNativeBundle: true,
    claudeMarketplaceIncludesNativeBundle: true,
    goNoticesPreservedAcrossArchiveInstallAndMarketplaces: true,
    supervisorCapabilityDeclarationPreservedWithoutWriteOrRecoveryAuthority: true,
    supervisorInteractiveDeclarationPreservedWithoutProviderAuthorization: true,
    legacyArchiveWithoutNoticesReadable: true,
  }, null, 2)}\n`);
} finally {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
}

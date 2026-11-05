import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { resolveVerifiedGoWorker, validateGoWorkerManifest } from "./go-worker-adapter.mjs";
import { resolveVerifiedProcessSupervisor, verifyProcessSupervisorManifest } from "./runtime-process-supervisor.mjs";
import { resolveVerifiedArcadeDbNativeBridge, verifyArcadeDbNativeBridgeManifest } from "./arcadedb-native-bridge.mjs";

export const NATIVE_ARTIFACT_DELIVERY_VERSION = "0.1.0";
const DEFAULT_RELEASE_ROOT = "https://github.com/binary1215/lode/releases/download";
const MAX_CHECKSUM_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const LEGACY_TARGETS = Object.freeze({
  "darwin-arm64": Object.freeze({ package: "head-agent-worker-darwin-arm64", directory: "darwin-arm64", goos: "darwin", goarch: "arm64", binaries: ["head-agent-worker", "head-agent-supervisor", "head-agent-arcadedb-bridge"] }),
  "darwin-x64": Object.freeze({ package: "head-agent-worker-darwin-amd64", directory: "darwin-x64", goos: "darwin", goarch: "amd64", binaries: ["head-agent-worker", "head-agent-supervisor", "head-agent-arcadedb-bridge"] }),
  "linux-arm64": Object.freeze({ package: "head-agent-worker-linux-arm64", directory: "linux-arm64", goos: "linux", goarch: "arm64", binaries: ["head-agent-worker", "head-agent-supervisor", "head-agent-arcadedb-bridge"] }),
  "linux-x64": Object.freeze({ package: "head-agent-worker-linux-amd64", directory: "linux-x64", goos: "linux", goarch: "amd64", binaries: ["head-agent-worker", "head-agent-supervisor", "head-agent-arcadedb-bridge"] }),
  "win32-x64": Object.freeze({ package: "head-agent-worker-windows-amd64", directory: "windows-x64", goos: "windows", goarch: "amd64", binaries: ["head-agent-worker.exe", "head-agent-supervisor.exe", "head-agent-arcadedb-bridge.exe"] }),
});
const TARGETS = Object.freeze({
  "darwin-arm64": Object.freeze({ package: "lode-agent-worker-darwin-arm64", directory: "darwin-arm64", goos: "darwin", goarch: "arm64", binaries: ["lode-agent-worker", "lode-agent-supervisor", "lode-agent-arcadedb-bridge"] }),
  "darwin-x64": Object.freeze({ package: "lode-agent-worker-darwin-amd64", directory: "darwin-x64", goos: "darwin", goarch: "amd64", binaries: ["lode-agent-worker", "lode-agent-supervisor", "lode-agent-arcadedb-bridge"] }),
  "linux-arm64": Object.freeze({ package: "lode-agent-worker-linux-arm64", directory: "linux-arm64", goos: "linux", goarch: "arm64", binaries: ["lode-agent-worker", "lode-agent-supervisor", "lode-agent-arcadedb-bridge"] }),
  "linux-x64": Object.freeze({ package: "lode-agent-worker-linux-amd64", directory: "linux-x64", goos: "linux", goarch: "amd64", binaries: ["lode-agent-worker", "lode-agent-supervisor", "lode-agent-arcadedb-bridge"] }),
  "win32-x64": Object.freeze({ package: "lode-agent-worker-windows-amd64", directory: "windows-x64", goos: "windows", goarch: "amd64", binaries: ["lode-agent-worker.exe", "lode-agent-supervisor.exe", "lode-agent-arcadedb-bridge.exe"] }),
});

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizedMode(mode) {
  const value = String(mode || "auto").trim().toLowerCase();
  if (!new Set(["auto", "off", "required"]).has(value)) {
    fail("HEAD_NATIVE_MODE_INVALID", "Native artifact mode must be auto, off, or required.");
  }
  return value;
}

function supportedTarget(platform, arch, legacy = false) {
  return (legacy ? LEGACY_TARGETS : TARGETS)[`${platform}-${arch}`] || null;
}

function releaseUrls(version, target, releaseRoot = DEFAULT_RELEASE_ROOT) {
  if (!/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(version)) {
    fail("HEAD_NATIVE_VERSION_INVALID", `Native artifact version is invalid: ${version}`);
  }
  let root;
  try { root = new URL(`${releaseRoot.replace(/\/+$/u, "")}/v${version}/`); }
  catch { fail("HEAD_NATIVE_RELEASE_URL_INVALID", "Native artifact release root is invalid."); }
  if (root.protocol !== "https:" && root.hostname !== "127.0.0.1" && root.hostname !== "localhost") {
    fail("HEAD_NATIVE_RELEASE_URL_INVALID", "Native artifact release root must use HTTPS.");
  }
  const assetName = `${target.package}.tar.gz`;
  return {
    assetName,
    assetUrl: new URL(assetName, root).toString(),
    checksumsUrl: new URL("SHA256SUMS", root).toString(),
  };
}

async function fetchBytes(url, { fetchImplementation, maximumBytes, unavailableCode }) {
  let response;
  try {
    response = await fetchImplementation(url, {
      redirect: "follow",
      headers: { "user-agent": "lode-agent-core-native-installer" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    fail(unavailableCode, `Native artifact request failed: ${error.message}`);
  }
  if (!response.ok) fail(unavailableCode, `Native artifact request returned HTTP ${response.status}.`);
  let finalUrl;
  try { finalUrl = new URL(response.url || url); }
  catch { fail("HEAD_NATIVE_RELEASE_URL_INVALID", "Native artifact response URL is invalid."); }
  if (finalUrl.protocol !== "https:" && finalUrl.hostname !== "127.0.0.1" && finalUrl.hostname !== "localhost") {
    fail("HEAD_NATIVE_RELEASE_URL_INVALID", "Native artifact response left the HTTPS boundary.");
  }
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    fail("HEAD_NATIVE_ARTIFACT_TOO_LARGE", "Native artifact exceeds the fixed download budget.");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maximumBytes) fail("HEAD_NATIVE_ARTIFACT_TOO_LARGE", "Native artifact exceeds the fixed download budget.");
  return bytes;
}

function expectedChecksum(checksums, assetName) {
  const matches = checksums.toString("utf8").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
    .map((line) => line.match(/^([a-f0-9]{64})\s+\*?([^/\\\s]+)$/u))
    .filter(Boolean)
    .filter((match) => match[2] === assetName);
  if (matches.length !== 1) fail("HEAD_NATIVE_CHECKSUM_MISSING", `SHA256SUMS must contain exactly one entry for ${assetName}.`);
  return matches[0][1];
}

function tarText(block, start, length) {
  const end = block.indexOf(0, start);
  return block.subarray(start, end >= start && end < start + length ? end : start + length).toString("utf8").trim();
}

function tarOctal(block, start, length, label) {
  const value = tarText(block, start, length).replace(/\s+$/u, "");
  if (!/^[0-7]+$/u.test(value)) fail("HEAD_NATIVE_ARCHIVE_INVALID", `Native archive ${label} is invalid.`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail("HEAD_NATIVE_ARCHIVE_INVALID", `Native archive ${label} is outside the supported range.`);
  return parsed;
}

function verifyTarHeaderChecksum(block) {
  const expected = tarOctal(block, 148, 8, "header checksum");
  let actual = 0;
  for (let index = 0; index < block.length; index += 1) actual += index >= 148 && index < 156 ? 32 : block[index];
  if (actual !== expected) fail("HEAD_NATIVE_ARCHIVE_INVALID", "Native archive header checksum verification failed.");
}

function safeArchivePath(value, targetDirectory) {
  if (!value || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/u.test(value)) {
    fail("HEAD_NATIVE_ARCHIVE_PATH_UNSAFE", `Native archive path is unsafe: ${value}`);
  }
  const normalized = path.posix.normalize(value.replace(/\/+$/u, ""));
  if (normalized !== value.replace(/\/+$/u, "") || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    fail("HEAD_NATIVE_ARCHIVE_PATH_UNSAFE", `Native archive path is unsafe: ${value}`);
  }
  if (normalized !== targetDirectory && !normalized.startsWith(`${targetDirectory}/`)) {
    fail("HEAD_NATIVE_ARCHIVE_PATH_UNSAFE", `Native archive path is outside ${targetDirectory}: ${value}`);
  }
  return normalized;
}

function extractTarGz(archive, destination, target) {
  let tar;
  try { tar = zlib.gunzipSync(archive, { maxOutputLength: MAX_EXPANDED_BYTES }); }
  catch (error) { fail("HEAD_NATIVE_ARCHIVE_INVALID", `Native archive decompression failed: ${error.message}`); }
  const expectedFiles = new Set([
    `${target.directory}/BUILD-METADATA.json`,
    `${target.directory}/WORKER-MANIFEST.json`,
    `${target.directory}/SUPERVISOR-MANIFEST.json`,
    `${target.directory}/ARCADEDB-BRIDGE-MANIFEST.json`,
    ...target.binaries.map((name) => `${target.directory}/${name}`),
  ]);
  const observedFiles = new Set();
  const noticeFile = `${target.directory}/GO-NOTICES.txt`;
  let offset = 0;
  let terminated = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      terminated = true;
      break;
    }
    verifyTarHeaderChecksum(header);
    if (tarText(header, 257, 6) !== "ustar") fail("HEAD_NATIVE_ARCHIVE_INVALID", "Native archive is not in the required USTAR format.");
    const name = tarText(header, 0, 100);
    const prefix = tarText(header, 345, 155);
    const relative = safeArchivePath(prefix ? `${prefix}/${name}` : name, target.directory);
    const size = tarOctal(header, 124, 12, "entry size");
    const type = String.fromCharCode(header[156] || 48);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) fail("HEAD_NATIVE_ARCHIVE_INVALID", "Native archive entry is truncated.");
    const absolute = path.resolve(destination, ...relative.split("/"));
    const relativeToDestination = path.relative(destination, absolute);
    if (!relativeToDestination || relativeToDestination.startsWith("..") || path.isAbsolute(relativeToDestination)) {
      fail("HEAD_NATIVE_ARCHIVE_PATH_UNSAFE", `Native archive path escaped extraction root: ${relative}`);
    }
    if (type === "5") {
      fs.mkdirSync(absolute, { recursive: true });
    } else if (type === "0") {
      if ((!expectedFiles.has(relative) && relative !== noticeFile) || observedFiles.has(relative)) fail("HEAD_NATIVE_ARCHIVE_CONTENT_INVALID", `Unexpected or duplicate native archive file: ${relative}`);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, tar.subarray(dataStart, dataEnd), { flag: "wx", mode: target.binaries.some((nameValue) => relative.endsWith(`/${nameValue}`)) ? 0o755 : 0o644 });
      observedFiles.add(relative);
    } else {
      fail("HEAD_NATIVE_ARCHIVE_CONTENT_INVALID", `Native archive entry type is unsupported: ${type}`);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (!terminated || tar.subarray(offset).some((byte) => byte !== 0)) {
    fail("HEAD_NATIVE_ARCHIVE_INVALID", "Native archive termination blocks are invalid.");
  }
  if ([...expectedFiles].some((file) => !observedFiles.has(file))) {
    fail("HEAD_NATIVE_ARCHIVE_CONTENT_INVALID", "Native archive does not contain the exact required file set.");
  }
}

function verifyBuildMetadata(pluginRoot, target, version) {
  const file = path.join(pluginRoot, "dist", target.directory, "BUILD-METADATA.json");
  let metadata;
  try { metadata = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { fail("HEAD_NATIVE_BUILD_METADATA_INVALID", "Native BUILD-METADATA.json is invalid."); }
  const keys = Object.keys(metadata).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["cgoEnabled", "commit", "goarch", "goos", "version"].sort())
    || metadata.version !== version || metadata.goos !== target.goos || metadata.goarch !== target.goarch
    || metadata.cgoEnabled !== false || !/^[a-f0-9]{40}$/u.test(metadata.commit || "")) {
    fail("HEAD_NATIVE_BUILD_METADATA_INVALID", "Native build metadata does not match the selected plugin version and target.");
  }
  return metadata;
}

function isUnavailable(error) {
  return new Set(["HEAD_NATIVE_RELEASE_UNAVAILABLE", "HEAD_NATIVE_TARGET_UNSUPPORTED"]).has(error?.code);
}

export async function acquireVerifiedNativeArtifact({
  version,
  mode = "auto",
  platform = process.platform,
  arch = process.arch,
  releaseRoot = DEFAULT_RELEASE_ROOT,
  fetchImplementation = globalThis.fetch,
  temporaryParent = os.tmpdir(),
} = {}) {
  const selectedMode = normalizedMode(mode);
  if (selectedMode === "off") return { status: "disabled", mode: selectedMode, cleanup() {} };
  let target = supportedTarget(platform, arch);
  if (!target) {
    const error = Object.assign(new Error(`No native artifact is published for ${platform}-${arch}.`), { code: "HEAD_NATIVE_TARGET_UNSUPPORTED" });
    if (selectedMode === "auto") return { status: "unavailable", mode: selectedMode, reasonCode: error.code, cleanup() {} };
    throw error;
  }
  if (typeof fetchImplementation !== "function") fail("HEAD_NATIVE_FETCH_UNAVAILABLE", "A fetch implementation is required for native artifact delivery.");
  const temporaryRoot = fs.mkdtempSync(path.join(path.resolve(temporaryParent), "lode-agent-native-"));
  const pluginRoot = path.join(temporaryRoot, "plugin");
  fs.mkdirSync(path.join(pluginRoot, "dist"), { recursive: true });
  const cleanup = () => fs.rmSync(temporaryRoot, { recursive: true, force: true });
  try {
    let urls = releaseUrls(version, target, releaseRoot);
    let checksums;
    let archive;
    try {
      checksums = await fetchBytes(urls.checksumsUrl, { fetchImplementation, maximumBytes: MAX_CHECKSUM_BYTES, unavailableCode: "HEAD_NATIVE_RELEASE_UNAVAILABLE" });
      try { expectedChecksum(checksums, urls.assetName); }
      catch (error) {
        if (error.code !== "HEAD_NATIVE_CHECKSUM_MISSING") throw error;
        target = supportedTarget(platform, arch, true);
        urls = releaseUrls(version, target, releaseRoot);
        expectedChecksum(checksums, urls.assetName);
      }
      archive = await fetchBytes(urls.assetUrl, { fetchImplementation, maximumBytes: MAX_ARCHIVE_BYTES, unavailableCode: "HEAD_NATIVE_RELEASE_UNAVAILABLE" });
    } catch (error) {
      if (selectedMode === "auto" && isUnavailable(error)) {
        cleanup();
        return { status: "unavailable", mode: selectedMode, reasonCode: error.code, assetName: urls.assetName, cleanup() {} };
      }
      throw error;
    }
    const expected = expectedChecksum(checksums, urls.assetName);
    const observed = sha256(archive);
    if (observed !== expected) fail("HEAD_NATIVE_ARCHIVE_DIGEST_MISMATCH", "Native release archive failed SHA-256 verification.");
    extractTarGz(archive, path.join(pluginRoot, "dist"), target);
    const metadata = verifyBuildMetadata(pluginRoot, target, version);
    const worker = resolveVerifiedGoWorker({ pluginRoot, platform, arch });
    const supervisor = resolveVerifiedProcessSupervisor({ pluginRoot, platform, arch });
    const arcadedbBridge = resolveVerifiedArcadeDbNativeBridge({ pluginRoot, platform, arch });
    return {
      status: "verified",
      mode: selectedMode,
      pluginRoot,
      assetName: urls.assetName,
      assetSha256: observed,
      target: { platform, arch, directory: target.directory },
      buildCommit: metadata.commit,
      workerManifestId: worker.manifest.manifestId,
      supervisorManifestId: supervisor.manifest.manifestId,
      arcadedbBridgeManifestId: arcadedbBridge.manifest.manifestId,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

export function verifyNativeOverlay({ pluginRoot, platform = process.platform, arch = process.arch, version = null } = {}) {
  let target = supportedTarget(platform, arch);
  if (!target) fail("HEAD_NATIVE_TARGET_UNSUPPORTED", `No native artifact is published for ${platform}-${arch}.`);
  const targetRoot = path.join(path.resolve(pluginRoot), "dist", target.directory);

  let entries;
  try {
    const targetStat = fs.lstatSync(targetRoot);
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) throw new Error("unsafe target directory");
    entries = fs.readdirSync(targetRoot).sort();
  }
  catch { fail("HEAD_NATIVE_OVERLAY_INVALID", "Native overlay target directory is unavailable."); }
  // File names select only a candidate tuple; every original manifest and
  // binary is still verified below before this overlay is accepted.
  const requiredEntries = entries.filter((entry) => entry !== "GO-NOTICES.txt");
  const legacyTarget = supportedTarget(platform, arch, true);
  const legacyEntries = ["ARCADEDB-BRIDGE-MANIFEST.json", "BUILD-METADATA.json", "SUPERVISOR-MANIFEST.json", "WORKER-MANIFEST.json", ...legacyTarget.binaries].sort();
  const legacy = JSON.stringify(requiredEntries) === JSON.stringify(legacyEntries);
  target = legacy ? legacyTarget : target;
  const expectedEntries = ["ARCADEDB-BRIDGE-MANIFEST.json", "BUILD-METADATA.json", "SUPERVISOR-MANIFEST.json", "WORKER-MANIFEST.json", ...target.binaries].sort();
  if (JSON.stringify(requiredEntries) !== JSON.stringify(expectedEntries)) {
    fail("HEAD_NATIVE_OVERLAY_INVALID", "Native overlay must contain the exact verified target file set.");
  }
  for (const entry of entries) {
    const stat = fs.lstatSync(path.join(targetRoot, entry));
    if (!stat.isFile() || stat.isSymbolicLink()) fail("HEAD_NATIVE_OVERLAY_INVALID", `Native overlay entry is unsafe: ${entry}`);
  }
  const metadata = version ? verifyBuildMetadata(pluginRoot, target, version) : null;
  const currentTarget = platform === process.platform && arch === process.arch;
  const verifyForeignBinary = (manifestName, validateManifest) => {
    const manifestPath = path.join(targetRoot, manifestName);
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); }
    catch { fail("HEAD_NATIVE_OVERLAY_INVALID", `Native overlay manifest is invalid: ${manifestName}`); }
    validateManifest(manifest, { platform, arch });
    const binaryPath = path.resolve(targetRoot, ...manifest.binary.relativePath.split("/"));
    const relative = path.relative(targetRoot, binaryPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      fail("HEAD_NATIVE_OVERLAY_INVALID", `Native overlay binary escaped its target directory: ${manifestName}`);
    }
    const binaryStat = fs.lstatSync(binaryPath, { throwIfNoEntry: false });
    if (!binaryStat?.isFile() || binaryStat.isSymbolicLink()) {
      fail("HEAD_NATIVE_OVERLAY_INVALID", `Native overlay binary is missing or unsafe: ${manifest.binary.relativePath}`);
    }
    const bytes = fs.readFileSync(binaryPath);
    if (bytes.length !== manifest.binary.size || sha256(bytes) !== manifest.binary.sha256) {
      fail("HEAD_NATIVE_OVERLAY_INVALID", `Native overlay binary failed integrity verification: ${manifest.binary.relativePath}`);
    }
    return { manifest, manifestPath, binaryPath };
  };
  const worker = currentTarget
    ? resolveVerifiedGoWorker({ pluginRoot, platform, arch })
    : verifyForeignBinary("WORKER-MANIFEST.json", validateGoWorkerManifest);
  const supervisor = currentTarget
    ? resolveVerifiedProcessSupervisor({ pluginRoot, platform, arch })
    : verifyForeignBinary("SUPERVISOR-MANIFEST.json", verifyProcessSupervisorManifest);
  const arcadedbBridge = currentTarget
    ? resolveVerifiedArcadeDbNativeBridge({ pluginRoot, platform, arch })
    : verifyForeignBinary("ARCADEDB-BRIDGE-MANIFEST.json", verifyArcadeDbNativeBridgeManifest);
  if (worker.manifest.kind !== (legacy ? "HeadAgentWorkerManifest" : "LodeAgentWorkerManifest")
    || supervisor.manifest.kind !== (legacy ? "HeadAgentProcessSupervisorManifest" : "LodeAgentProcessSupervisorManifest")
    || arcadedbBridge.manifest.kind !== (legacy ? "HeadAgentArcadeDbBridgeManifest" : "LodeAgentArcadeDbBridgeManifest")) {
    fail("HEAD_NATIVE_OVERLAY_INVALID", "Native overlay manifest families are incoherent.");
  }
  return {
    targetDirectory: path.basename(path.dirname(worker.manifestPath)),
    buildCommit: metadata?.commit || null,
    workerManifestId: worker.manifest.manifestId,
    supervisorManifestId: supervisor.manifest.manifestId,
    arcadedbBridgeManifestId: arcadedbBridge.manifest.manifestId,
  };
}

export function verifyNativeBundleOverlay({ pluginRoot, version, commit = null } = {}) {
  if (!pluginRoot || !version) fail("HEAD_NATIVE_BUNDLE_ARGUMENTS", "Native bundle root and version are required.");
  const root = path.resolve(pluginRoot);
  const distRoot = path.join(root, "dist");
  const expectedDirectories = Object.values(TARGETS).map((target) => target.directory).sort();
  let entries;
  try { entries = fs.readdirSync(distRoot, { withFileTypes: true }); }
  catch { fail("HEAD_NATIVE_BUNDLE_INVALID", "Native bundle dist directory is unavailable."); }
  const actualDirectories = entries.map((entry) => entry.name).sort();
  if (entries.some((entry) => !entry.isDirectory() || entry.isSymbolicLink())
    || JSON.stringify(actualDirectories) !== JSON.stringify(expectedDirectories)) {
    fail("HEAD_NATIVE_BUNDLE_INVALID", "Native bundle must contain the exact supported platform directories.");
  }
  const targets = Object.entries(TARGETS).sort(([left], [right]) => left.localeCompare(right, "en")).map(([targetKey]) => {
    const separator = targetKey.lastIndexOf("-");
    const platform = targetKey.slice(0, separator);
    const arch = targetKey.slice(separator + 1);
    const verified = verifyNativeOverlay({ pluginRoot: root, platform, arch, version });
    if (commit && verified.buildCommit !== commit) {
      fail("HEAD_NATIVE_BUNDLE_COMMIT_MISMATCH", "Native bundle target does not match the expected source commit.");
    }
    return { platform, arch, ...verified };
  });
  const buildCommits = [...new Set(targets.map((target) => target.buildCommit))];
  if (buildCommits.length !== 1) fail("HEAD_NATIVE_BUNDLE_COMMIT_MISMATCH", "Native bundle targets do not share one source commit.");
  const manifestKinds = new Set(targets.map(target => JSON.parse(fs.readFileSync(path.join(distRoot, target.targetDirectory, "WORKER-MANIFEST.json"), "utf8")).kind));
  if (manifestKinds.size !== 1) fail("HEAD_NATIVE_BUNDLE_INVALID", "Native bundle targets do not share one manifest family.");
  const identity = {
    protocolVersion: NATIVE_ARTIFACT_DELIVERY_VERSION,
    kind: manifestKinds.has("HeadAgentWorkerManifest")
      ? "HeadAgentNativeBundle" : "LodeAgentNativeBundle",
    version,
    buildCommit: buildCommits[0],
    targets,
    authorityEffect: "none",
  };
  return {
    ...identity,
    nativeBundleId: `native-bundle-${sha256(Buffer.from(canonical(identity))).slice(0, 24)}`,
  };
}

export function assembleVerifiedNativeBundle({ artifactsRoot, outputRoot, version, commit = null } = {}) {
  if (!artifactsRoot || !outputRoot || !version) {
    fail("HEAD_NATIVE_BUNDLE_ARGUMENTS", "Native artifact directory, output root, and version are required.");
  }
  const artifacts = path.resolve(artifactsRoot);
  const output = path.resolve(outputRoot);
  if (fs.existsSync(output)) fail("HEAD_NATIVE_BUNDLE_OUTPUT_EXISTS", "Native bundle output root already exists.");
  let artifactEntries;
  try {
    const stat = fs.lstatSync(artifacts);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe artifact root");
    artifactEntries = fs.readdirSync(artifacts, { withFileTypes: true });
  } catch {
    fail("HEAD_NATIVE_BUNDLE_ARTIFACTS_INVALID", "Native bundle artifact directory is unavailable or unsafe.");
  }
  const actualArchives = artifactEntries.map((entry) => entry.name).sort();
  const legacyArchives = Object.values(LEGACY_TARGETS).map((target) => `${target.package}.tar.gz`).sort();
  const selectedTargets = JSON.stringify(actualArchives) === JSON.stringify(legacyArchives) ? LEGACY_TARGETS : TARGETS;
  const expectedArchives = Object.values(selectedTargets).map((target) => `${target.package}.tar.gz`).sort();
  if (artifactEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
    || JSON.stringify(actualArchives) !== JSON.stringify(expectedArchives)) {
    fail("HEAD_NATIVE_BUNDLE_ARTIFACTS_INVALID", "Native bundle requires the exact supported platform archives.");
  }
  fs.mkdirSync(path.join(output, "dist"), { recursive: true });
  try {
    for (const target of Object.values(selectedTargets)) {
      const archiveFile = path.join(artifacts, `${target.package}.tar.gz`);
      const archive = fs.readFileSync(archiveFile);
      if (archive.length > MAX_ARCHIVE_BYTES) fail("HEAD_NATIVE_ARTIFACT_TOO_LARGE", "Native artifact exceeds the fixed download budget.");
      extractTarGz(archive, path.join(output, "dist"), target);
    }
    return verifyNativeBundleOverlay({ pluginRoot: output, version, commit });
  } catch (error) {
    fs.rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

export { DEFAULT_RELEASE_ROOT };

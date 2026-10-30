import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ARCADEDB_NATIVE_BRIDGE_MANIFEST_VERSION = "0.1.0";
export const ARCADEDB_NATIVE_BRIDGE_PROTOCOL_VERSION = "0.1.0";

const TARGETS = Object.freeze({
  "darwin-arm64": Object.freeze({ platform: "darwin", arch: "arm64", directory: "darwin-arm64", executable: "head-agent-arcadedb-bridge" }),
  "darwin-x64": Object.freeze({ platform: "darwin", arch: "x64", directory: "darwin-x64", executable: "head-agent-arcadedb-bridge" }),
  "linux-arm64": Object.freeze({ platform: "linux", arch: "arm64", directory: "linux-arm64", executable: "head-agent-arcadedb-bridge" }),
  "linux-x64": Object.freeze({ platform: "linux", arch: "x64", directory: "linux-x64", executable: "head-agent-arcadedb-bridge" }),
  "win32-x64": Object.freeze({ platform: "win32", arch: "x64", directory: "windows-x64", executable: "head-agent-arcadedb-bridge.exe" }),
});

const fail = (message, code = "ARCADEDB_NATIVE_BRIDGE_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

const canonicalJson = (value) => JSON.stringify(canonical(value));

function targetFor(platform = process.platform, arch = process.arch, legacy = false) {
  const target = TARGETS[`${platform}-${arch}`];
  if (!target) fail(`Unsupported ArcadeDB native bridge target: ${platform}-${arch}.`, "ARCADEDB_NATIVE_BRIDGE_TARGET_UNSUPPORTED");
  return legacy ? target : { ...target, executable: target.executable.replace("head-agent-", "lode-agent-") };
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((field) => !fields.includes(field)) || fields.some((field) => !(field in value))) {
    fail(`${label} fields are invalid.`, "INVALID_ARCADEDB_NATIVE_BRIDGE_MANIFEST");
  }
}

function payload({ target, binary, legacy = false }) {
  return {
    schemaVersion: 1,
    kind: legacy ? "HeadAgentArcadeDbBridgeManifest" : "LodeAgentArcadeDbBridgeManifest",
    manifestVersion: ARCADEDB_NATIVE_BRIDGE_MANIFEST_VERSION,
    bridgeProtocolVersion: ARCADEDB_NATIVE_BRIDGE_PROTOCOL_VERSION,
    target,
    binary,
    operations: ["query-batch"],
    processModel: {
      stdio: "single-request-single-response-json",
      descendants: "forbidden",
      network: "request-selected-http-or-https-endpoint",
      databaseWrites: "forbidden-by-query-endpoint",
      projectWrites: "forbidden",
    },
    authority: {
      kind: "read-only-transport",
      instructionAuthority: false,
      promotionAuthority: false,
      canonicalAuthority: false,
      mutatesProject: false,
      mutatesCanon: false,
    },
  };
}

function withIdentity(value) {
  const manifestHash = digest(canonicalJson(value));
  return { ...value, manifestId: `arcadedb-bridge-manifest-${manifestHash.slice(0, 24)}`, manifestHash };
}

export function createArcadeDbNativeBridgeManifest({ platform, arch, binaryFile, manifestDirectory } = {}) {
  const target = targetFor(platform, arch);
  const root = path.resolve(manifestDirectory || ".");
  const file = path.resolve(binaryFile || "");
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!inside(root, file) || !stat?.isFile() || stat.isSymbolicLink()) fail("ArcadeDB native bridge binary is missing or unsafe.", "ARCADEDB_NATIVE_BRIDGE_BINARY_MISSING");
  const relativePath = path.relative(root, file).replaceAll("\\", "/");
  if (relativePath !== target.executable) fail("ArcadeDB native bridge binary name does not match its target.", "INVALID_ARCADEDB_NATIVE_BRIDGE_MANIFEST");
  return verifyArcadeDbNativeBridgeManifest(withIdentity(payload({
    target: { platform: target.platform, arch: target.arch, directory: target.directory },
    binary: { relativePath, sha256: digest(fs.readFileSync(file)), size: stat.size },
  })), { platform, arch });
}

export function verifyArcadeDbNativeBridgeManifest(manifest, { platform = process.platform, arch = process.arch } = {}) {
  assertFields(manifest, [
    "schemaVersion", "kind", "manifestVersion", "bridgeProtocolVersion", "target", "binary", "operations",
    "processModel", "authority", "manifestId", "manifestHash",
  ], "ArcadeDB native bridge manifest");
  assertFields(manifest.target, ["platform", "arch", "directory"], "ArcadeDB native bridge target");
  assertFields(manifest.binary, ["relativePath", "sha256", "size"], "ArcadeDB native bridge binary");
  assertFields(manifest.processModel, ["stdio", "descendants", "network", "databaseWrites", "projectWrites"], "ArcadeDB native bridge process model");
  assertFields(manifest.authority, ["kind", "instructionAuthority", "promotionAuthority", "canonicalAuthority", "mutatesProject", "mutatesCanon"], "ArcadeDB native bridge authority");
  const legacy = manifest.kind === "HeadAgentArcadeDbBridgeManifest";
  const target = targetFor(platform, arch, legacy);
  const expected = payload({
    legacy,
    target: { platform: target.platform, arch: target.arch, directory: target.directory },
    binary: manifest.binary,
  });
  const identityPayload = { ...manifest };
  delete identityPayload.manifestId;
  delete identityPayload.manifestHash;
  if (manifest.schemaVersion !== 1 || !["HeadAgentArcadeDbBridgeManifest", "LodeAgentArcadeDbBridgeManifest"].includes(manifest.kind)
    || manifest.manifestVersion !== ARCADEDB_NATIVE_BRIDGE_MANIFEST_VERSION
    || manifest.bridgeProtocolVersion !== ARCADEDB_NATIVE_BRIDGE_PROTOCOL_VERSION
    || manifest.binary.relativePath !== target.executable || !/^[a-f0-9]{64}$/.test(manifest.binary.sha256 || "")
    || !Number.isSafeInteger(manifest.binary.size) || manifest.binary.size < 1
    || canonicalJson(identityPayload) !== canonicalJson(expected)) {
    fail("ArcadeDB native bridge manifest contract is invalid.", "INVALID_ARCADEDB_NATIVE_BRIDGE_MANIFEST");
  }
  const identity = withIdentity(identityPayload);
  if (identity.manifestId !== manifest.manifestId || identity.manifestHash !== manifest.manifestHash) {
    fail("ArcadeDB native bridge manifest digest verification failed.", "ARCADEDB_NATIVE_BRIDGE_MANIFEST_DIGEST_MISMATCH");
  }
  return manifest;
}

export function defaultArcadeDbNativeBridgeManifestPath({ pluginRoot = ".", platform = process.platform, arch = process.arch } = {}) {
  return path.join(path.resolve(pluginRoot), "dist", targetFor(platform, arch).directory, "ARCADEDB-BRIDGE-MANIFEST.json");
}

export function resolveVerifiedArcadeDbNativeBridge({ pluginRoot = ".", manifestFile = null, platform = process.platform, arch = process.arch } = {}) {
  const root = fs.realpathSync(path.resolve(pluginRoot));
  const manifestPath = path.resolve(manifestFile || defaultArcadeDbNativeBridgeManifestPath({ pluginRoot: root, platform, arch }));
  if (!inside(root, manifestPath)) fail("ArcadeDB native bridge manifest escaped the plugin root.", "ARCADEDB_NATIVE_BRIDGE_PATH_ESCAPE");
  const manifestStat = fs.lstatSync(manifestPath, { throwIfNoEntry: false });
  if (!manifestStat?.isFile() || manifestStat.isSymbolicLink()) fail("ArcadeDB native bridge manifest is unavailable.", "ARCADEDB_NATIVE_BRIDGE_NOT_AVAILABLE");
  const realManifest = fs.realpathSync(manifestPath);
  if (!inside(root, realManifest)) fail("ArcadeDB native bridge manifest resolved outside the plugin root.", "ARCADEDB_NATIVE_BRIDGE_PATH_ESCAPE");
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(realManifest, "utf8")); }
  catch { fail("ArcadeDB native bridge manifest is invalid JSON.", "INVALID_ARCADEDB_NATIVE_BRIDGE_MANIFEST"); }
  verifyArcadeDbNativeBridgeManifest(manifest, { platform, arch });
  const binaryPath = path.resolve(path.dirname(realManifest), manifest.binary.relativePath);
  const binaryStat = fs.lstatSync(binaryPath, { throwIfNoEntry: false });
  if (!inside(root, binaryPath) || !binaryStat?.isFile() || binaryStat.isSymbolicLink()) fail("ArcadeDB native bridge binary is unavailable or unsafe.", "ARCADEDB_NATIVE_BRIDGE_BINARY_MISSING");
  const realBinary = fs.realpathSync(binaryPath);
  if (!inside(root, realBinary) || path.dirname(realBinary) !== path.dirname(realManifest)) fail("ArcadeDB native bridge binary escaped its immutable distribution directory.", "ARCADEDB_NATIVE_BRIDGE_PATH_ESCAPE");
  if (platform !== "win32" && (binaryStat.mode & 0o111) === 0) fail("ArcadeDB native bridge binary is not executable.", "ARCADEDB_NATIVE_BRIDGE_BINARY_NOT_EXECUTABLE");
  const bytes = fs.readFileSync(realBinary);
  if (bytes.length !== manifest.binary.size || digest(bytes) !== manifest.binary.sha256) fail("ArcadeDB native bridge binary digest verification failed.", "ARCADEDB_NATIVE_BRIDGE_BINARY_DIGEST_MISMATCH");
  return Object.freeze({ manifest, manifestPath: realManifest, binaryPath: realBinary });
}

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateGoWorkerManifest } from "../../scripts/lib/go-worker-adapter.mjs";
import { verifyArcadeDbNativeBridgeManifest } from "../../scripts/lib/arcadedb-native-bridge.mjs";

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const canonical = (value) =>
  JSON.stringify(value, function (_key, item) {
    return item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort(compare)
            .map((key) => [key, item[key]]),
        )
      : item;
  });
const fail = (message) => {
  throw Object.assign(new Error(message), { code: "LEGACY_MARKETPLACE_OWNERSHIP_REJECTED" });
};
const approved = Object.freeze({
  codex: {
    commit: "559f38e955a9ea79512d551afcf209391ca631bc",
    digest: "1702eaa7801a4a9ef497ba04634d243851343fa1769ec9fa5d83c8befee3e9d0",
    marker: ".head-agent-marketplace-generated.json",
    markerBlob: "f9638387da1b7dbaae4cf6e3603a8f797717d256",
    snapshotId: "codex-marketplace-0acf99bdb22eddfb00fa7905",
  },
  claude: {
    commit: "1b6201d6966b07964ddb3c2e6a523ce60c460a09",
    digest: "e77b78d6afdd8febfa129863ba1c31a3ec5f6ec75d3b94954cf45db2e642cfd8",
    marker: ".head-agent-claude-marketplace-generated.json",
    markerBlob: "0169ffe7ea2d826b1955da86ec290d37f20a007d",
    snapshotId: "claude-marketplace-9fd4dcfd26edcc7904a5dd08",
  },
});
const targets = [
  ["darwin", "arm64", "darwin-arm64"],
  ["darwin", "x64", "darwin-x64"],
  ["linux", "arm64", "linux-arm64"],
  ["linux", "x64", "linux-x64"],
  ["win32", "x64", "windows-x64"],
];

// Read-only historical proof, not a runtime resolver or compatibility adapter.
export function snapshotInventory(root) {
  const inventory = [];
  function walk(relative) {
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) fail("Historical snapshot contains a link.");
    if (stat.isDirectory()) {
      if (relative) inventory.push({ path: relative, type: "directory" });
      for (const name of fs.readdirSync(absolute).sort(compare)) walk(relative ? `${relative}/${name}` : name);
    } else if (relative && stat.isFile()) {
      const bytes = fs.readFileSync(absolute);
      inventory.push({ path: relative, type: "file", bytes: bytes.length, sha256: sha256(bytes) });
    } else fail("Historical snapshot contains an unsupported entry.");
  }
  walk("");
  return inventory.sort((a, b) => compare(a.path, b.path));
}

export function verifyHistoricalSupervisorManifest(manifest, { platform, arch }) {
  const target = targets.find(([p, a]) => p === platform && a === arch);
  if (!target || !manifest?.binary || !/^[a-f0-9]{64}$/.test(manifest.binary.sha256) || !Number.isSafeInteger(manifest.binary.size) || manifest.binary.size < 1)
    fail("Unknown historical supervisor target or binary.");
  const payload = {
    schemaVersion: 1,
    kind: "HeadAgentProcessSupervisorManifest",
    manifestVersion: "0.1.0",
    supervisorProtocolVersion: "0.1.0",
    target: { platform, arch, directory: target[2] },
    binary: { relativePath: `head-agent-supervisor${platform === "win32" ? ".exe" : ""}`, sha256: manifest.binary.sha256, size: manifest.binary.size },
    processModel: {
      transport: "single-request-stdio-with-control-fd3",
      windowsTreeOwnership: "job-object-kill-on-close",
      posixTreeOwnership: "isolated-process-group",
      shellInterpretation: false,
    },
    authority: { kind: "operational-process-control-only", instructionAuthority: false, promotionAuthority: false, mutatesCanon: false },
  };
  const hash = sha256(canonical(payload));
  if (canonical(manifest) !== canonical({ ...payload, manifestId: `process-supervisor-manifest-${hash.slice(0, 24)}`, manifestHash: hash })) {
    fail("Historical supervisor schema or identity differs.");
  }
  return manifest;
}

export function verifyHistoricalMarketplaceOwnership({ root, provider, expectedRepository, expectedMarketplaceName, expectedSnapshotCommit } = {}) {
  const pin = approved[provider];
  if (
    !root ||
    !pin ||
    expectedRepository !== "binary1215/head-agent-plugin" ||
    expectedMarketplaceName !== "head-agent-plugin" ||
    expectedSnapshotCommit !== pin.commit
  )
    fail("Not an approved historical ownership lookup.");
  const resolved = path.resolve(root);
  const inventory = snapshotInventory(resolved);
  const contentDigest = sha256(JSON.stringify(inventory));
  if (contentDigest !== pin.digest) fail("Historical snapshot whole-tree bytes differ from the approved source.");
  const markerBytes = fs.readFileSync(path.join(resolved, pin.marker));
  const markerBlob = crypto
    .createHash("sha1")
    .update(Buffer.from(`blob ${markerBytes.length}\0`))
    .update(markerBytes)
    .digest("hex");
  const marker = JSON.parse(markerBytes);
  if (
    markerBlob !== pin.markerBlob ||
    marker.snapshotId !== pin.snapshotId ||
    marker.sourceRepository !== expectedRepository ||
    marker.marketplaceName !== expectedMarketplaceName ||
    marker.sourceCommit !== "e496d9621dc6b39fe05dc454d6258084caeb6a52" ||
    marker.pluginVersion !== "0.3.0-beta.12+codex.20260907233130" ||
    marker.pluginName !== "head-agent-core"
  )
    fail("Historical marker identity differs.");
  const pluginRoot = path.join(resolved, "plugins", marker.pluginName);
  for (const [platform, arch, directory] of targets) {
    const targetRoot = path.join(pluginRoot, "dist", directory);
    for (const [file, validator] of [
      ["WORKER-MANIFEST.json", validateGoWorkerManifest],
      ["SUPERVISOR-MANIFEST.json", verifyHistoricalSupervisorManifest],
      ["ARCADEDB-BRIDGE-MANIFEST.json", verifyArcadeDbNativeBridgeManifest],
    ]) {
      const manifest = JSON.parse(fs.readFileSync(path.join(targetRoot, file), "utf8"));
      validator(manifest, { platform, arch });
      const binary = fs.readFileSync(path.join(targetRoot, manifest.binary.relativePath));
      if (binary.length !== manifest.binary.size || sha256(binary) !== manifest.binary.sha256) fail("Historical native binary hash differs.");
    }
    const metadata = JSON.parse(fs.readFileSync(path.join(targetRoot, "BUILD-METADATA.json"), "utf8"));
    if (metadata.commit !== marker.sourceCommit || metadata.version !== marker.pluginVersion) fail("Historical native build identity differs.");
  }
  return {
    status: "historical_marketplace_ownership_verified",
    provider,
    snapshotCommit: pin.commit,
    snapshotId: marker.snapshotId,
    contentDigest,
    nativeTargetCount: targets.length,
    authorityEffect: "none",
    executable: false,
    installable: false,
    purpose: "existing-branch-replacement-only",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const names = {
    "--root": "root",
    "--provider": "provider",
    "--expected-repository": "expectedRepository",
    "--expected-marketplace-name": "expectedMarketplaceName",
    "--expected-snapshot-commit": "expectedSnapshotCommit",
  };
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = names[process.argv[i]],
      value = process.argv[i + 1];
    if (!key || !value || value.startsWith("--") || Object.hasOwn(options, key)) fail("Invalid historical ownership arguments.");
    options[key] = value;
  }
  process.stdout.write(`${JSON.stringify(verifyHistoricalMarketplaceOwnership(options), null, 2)}\n`);
}

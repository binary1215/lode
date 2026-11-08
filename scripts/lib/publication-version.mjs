import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { verifyCodexMarketplaceSnapshot } from "./codex-marketplace.mjs";
import { verifyClaudeMarketplaceSnapshot } from "./claude-marketplace.mjs";

export const BUILD_RECIPE = ".github/workflows/go-worker-build-release.yml";
export const RELEASE_ASSETS = ["darwin-amd64", "darwin-arm64", "linux-amd64", "linux-arm64", "windows-amd64"]
  .map((target) => `lode-agent-worker-${target}.tar.gz`)
  .concat("SHA256SUMS")
  .sort();
function fail(message) {
  throw new Error(`PUBLICATION_VERSION_CONFLICT: ${message}`);
}
function sha(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
export { comparePublicationVersions } from "./semantic-version.mjs";
import { comparePublicationVersions, versionParts } from "./semantic-version.mjs";

// This is publication input equivalence, not proof of executable equivalence.
// Dist bytes may differ after a rebuild. A successful retry MUST keep the old bytes/ref.
export function logicalPublicationDigest({ files, recipe, nativeTargetCount }) {
  if (!Array.isArray(files) || !files.length || !Buffer.isBuffer(recipe) || !recipe.length)
    fail("Publication equivalence unknown: missing source/build recipe.");
  const source = files
    .filter((file) => !file.path.startsWith("dist/"))
    .map(({ path: file, bytes, sha256 }) => ({ path: file, bytes, sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path, "en"));
  if (nativeTargetCount && !source.some((file) => file.path.startsWith("native/") && file.path.endsWith(".go"))) {
    fail("Publication equivalence unknown: native source missing.");
  }
  return sha(JSON.stringify({ source, recipe: sha(recipe), nativeTargetCount }));
}

export function decideMarketplacePublication({ candidate, previous = null, tagCommit = null }) {
  versionParts(candidate.pluginVersion);
  if (
    previous &&
    (candidate.marketplaceName !== previous.marketplaceName ||
      candidate.pluginName !== previous.pluginName ||
      candidate.sourceRepository !== previous.sourceRepository ||
      candidate.provider !== previous.provider)
  )
    fail("Marketplace identity changed.");
  const order = previous ? comparePublicationVersions(candidate.pluginVersion, previous.pluginVersion) : 1;
  if (order < 0) fail("Version downgrade/reuse is not allowed.");
  if (order === 0) {
    if (candidate.pluginVersion !== previous.pluginVersion) fail("Build metadata cannot reuse version precedence.");
    if (!candidate.logicalDigest || !previous.logicalDigest || candidate.logicalDigest !== previous.logicalDigest)
      fail("Same version has different or unknown logical payload; use a new version.");
    if (tagCommit && tagCommit !== candidate.sourceCommit && tagCommit !== previous.sourceCommit) fail("Existing version tag belongs to another source.");
    return { action: "already_published", write: false, preservedSourceCommit: previous.sourceCommit };
  }
  if (tagCommit && tagCommit !== candidate.sourceCommit) fail("Existing version tag belongs to another source; use a new version.");
  return { action: "publish", write: true };
}

export function decideReleasePublication({ version, sourceCommit, tagCommit, release = null }) {
  versionParts(version);
  if (tagCommit && tagCommit !== sourceCommit) fail("Release tag source differs from this build.");
  if (!release) return { action: "publish", write: true };
  if (!tagCommit || release.tag_name !== `v${version}` || release.draft || !release.body?.includes(`Source commit: \`${sourceCommit}\``))
    fail("Existing release provenance unknown; preserve it and use a new version.");
  const assets = release.assets || [];
  if (
    JSON.stringify(assets.map((asset) => asset.name).sort()) !== JSON.stringify(RELEASE_ASSETS) ||
    assets.some((asset) => !Number.isSafeInteger(asset.size) || asset.size <= 0 || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || ""))
  ) {
    fail("Existing release is partial/unverifiable; do not overwrite assets.");
  }
  return { action: "already_published", write: false, releaseId: release.id };
}

export function readPublicationSnapshot({
  root,
  provider,
  repository,
  marketplaceName,
  requireNativeBundle = false,
  allowLegacyBytePreservation = false,
  allowLegacyInterfaceForOwnership = false,
}) {
  const verify = provider === "codex" ? verifyCodexMarketplaceSnapshot : provider === "claude" ? verifyClaudeMarketplaceSnapshot : null;
  if (!verify) fail("Unknown publication provider.");
  const verified = verify({
    root,
    expectedRepository: repository,
    expectedMarketplaceName: marketplaceName,
    requireNativeBundle,
    allowLegacyBytePreservation,
    allowLegacyInterfaceForOwnership,
  });
  const identity = verified.pluginName === "lode-agent-core" ? "lode" : "head";
  const manifestFile = provider === "codex" ? "distribution-manifest.json" : `.${identity}-source-distribution-manifest.json`;
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "plugins", verified.pluginName, manifestFile), "utf8"));
  return { ...verified, provider, files: manifest.files };
}

// Read-only, fixed-origin API. No subprocesses, arbitrary URL inputs, or stored credentials.
export function publicationGithub({ repository, token = "", fetchImpl = fetch }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) fail("Invalid source repository.");
  async function get(endpoint) {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/${endpoint}`, {
      headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (response.status === 404) return null;
    if (!response.ok) fail(`GitHub proof unavailable (${response.status}).`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        await response.body.cancel().catch(() => {});
        fail("GitHub proof exceeds bounded response size.");
      }
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  return {
    async tag(version) {
      versionParts(version);
      let ref = await get(`git/ref/tags/${encodeURIComponent(`v${version}`)}`);
      if (!ref) return null;
      let object = ref.object;
      for (let i = 0; i < 4 && object?.type === "tag"; i++) {
        if (!/^[a-f0-9]{40}$/.test(object.sha)) fail("Invalid tag proof.");
        object = (await get(`git/tags/${object.sha}`))?.object;
      }
      if (object?.type !== "commit" || !/^[a-f0-9]{40}$/.test(object.sha)) fail("Tag source proof unavailable.");
      return object.sha;
    },
    release: (version) => {
      versionParts(version);
      return get(`releases/tags/${encodeURIComponent(`v${version}`)}`);
    },
    async recipe(commit) {
      if (!/^[a-f0-9]{40}$/.test(commit)) fail("Invalid source commit.");
      const item = await get(`contents/${BUILD_RECIPE}?ref=${commit}`);
      if (!item || item.encoding !== "base64" || !item.content) fail("Publication equivalence unknown: build recipe unavailable.");
      const bytes = Buffer.from(item.content, "base64");
      const blob = crypto
        .createHash("sha1")
        .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
        .digest("hex");
      if (bytes.length !== item.size || blob !== item.sha) fail("Build recipe proof mismatch.");
      return bytes;
    },
  };
}

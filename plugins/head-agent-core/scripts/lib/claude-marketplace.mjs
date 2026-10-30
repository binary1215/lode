import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stageDistributionRelease } from "./distribution-lifecycle.mjs";
import { verifyNativeBundleOverlay } from "./native-artifact-delivery.mjs";
import { ARTIFACT_COMPOSITION, artifactCompositionForIdentity } from "./lode-artifact-composition.mjs";
import { historicalArtifactServerName } from "../../compat/head/artifact-composition.mjs";
import { verifyMarketplaceContent } from "./marketplace-content.mjs";

const CLAUDE_MARKETPLACE_PROTOCOL = "0.1.0";
const DEFAULT_MARKETPLACE_NAME = ARTIFACT_COMPOSITION.marketplaceName;
const MARKETPLACE_GIT_ATTRIBUTES = "* -text\n";
function marketplaceComposition(name) {
  for (const identity of ["lode", "head"]) {
    const composition = artifactCompositionForIdentity(identity);
    if (name === composition.marketplaceName) return composition;
  }
  fail("HEAD_CLAUDE_MARKETPLACE_NAME_INVALID", "Marketplace identity must match one exact supported artifact composition.");
}

function generatedMarker(composition) { return `.${composition.identity}-agent-claude-marketplace-generated.json`; }
function sourceDistributionFile(composition) { return `.${composition.identity}-source-distribution-manifest.json`; }

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function readJson(file, code) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(code, `Cannot read valid JSON from ${file}: ${error.message}`);
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

function replaceJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function assertExactKeys(value, keys, label, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, `${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, `${label} fields are invalid.`);
  }
}

function marketplaceName(value) {
  if (typeof value !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) || value.length > 64) {
    fail("HEAD_CLAUDE_MARKETPLACE_NAME_INVALID", "Marketplace name must be lower-case hyphen-case and at most 64 characters.");
  }
  return value;
}

function sourceRepository(value) {
  if (value === "local") return value;
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    fail("HEAD_CLAUDE_MARKETPLACE_REPOSITORY_INVALID", "Source repository must be owner/repository or local.");
  }
  return value;
}

function sourceCommit(value) {
  if (value === "local") return value;
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    fail("HEAD_CLAUDE_MARKETPLACE_COMMIT_INVALID", "Source commit must be a full lower-case Git commit or local.");
  }
  return value;
}

function treeEntries(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const childRelative = path.join(relative, entry.name);
    const normalized = childRelative.split(path.sep).join("/");
    if (entry.isSymbolicLink()) fail("HEAD_CLAUDE_MARKETPLACE_SYMLINK", `Marketplace snapshot cannot contain symlinks: ${normalized}`);
    if (entry.isDirectory()) {
      entries.push({ path: normalized, type: "directory" }, ...treeEntries(root, childRelative));
    } else if (entry.isFile()) {
      entries.push({ path: normalized, type: "file" });
    } else {
      fail("HEAD_CLAUDE_MARKETPLACE_FILE_TYPE", `Marketplace snapshot contains an unsupported file type: ${normalized}`);
    }
  }
  return entries;
}

function expectedTreeEntries(files) {
  const entries = new Map();
  for (const file of files) {
    const parts = file.split("/");
    for (let index = 1; index < parts.length; index += 1) entries.set(parts.slice(0, index).join("/"), "directory");
    entries.set(file, "file");
  }
  return [...entries].map(([entryPath, type]) => ({ path: entryPath, type }))
    .sort((left, right) => left.path.localeCompare(right.path, "en") || left.type.localeCompare(right.type, "en"));
}

function fileInventory(root, excluded = new Set()) {
  return treeEntries(root)
    .filter((entry) => entry.type === "file" && !excluded.has(entry.path))
    .map((entry) => {
      const bytes = fs.readFileSync(path.join(root, ...entry.path.split("/")));
      return { path: entry.path, bytes: bytes.byteLength, sha256: sha256(bytes) };
    })
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function sourceDistributionIdentity(manifest) {
  assertExactKeys(manifest, ["protocolVersion", "name", "version", "files", "releaseId", "packageName"], "Source distribution manifest", "HEAD_CLAUDE_MARKETPLACE_SOURCE_DISTRIBUTION_INVALID");
  if (!Array.isArray(manifest.files) || !manifest.files.length) {
    fail("HEAD_CLAUDE_MARKETPLACE_SOURCE_DISTRIBUTION_INVALID", "Source distribution file list is empty.");
  }
  if (manifest.protocolVersion !== "0.1.0") {
    fail("HEAD_CLAUDE_MARKETPLACE_SOURCE_DISTRIBUTION_INVALID", "Unsupported source distribution protocol.");
  }
  const seenPaths = new Set();
  for (const file of manifest.files) {
    assertExactKeys(file, ["path", "bytes", "sha256"], "Source distribution file", "HEAD_CLAUDE_MARKETPLACE_SOURCE_DISTRIBUTION_INVALID");
    const pathSegments = typeof file.path === "string" ? file.path.split("/") : [];
    if (typeof file.path !== "string" || !file.path || file.path.includes("\\") || file.path.includes(":") || file.path.startsWith("/")
      || pathSegments.some((segment) => !segment || segment === "." || segment === "..") || seenPaths.has(file.path)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      fail("HEAD_CLAUDE_MARKETPLACE_SOURCE_DISTRIBUTION_INVALID", `Invalid source distribution entry: ${file.path || "<missing>"}`);
    }
    seenPaths.add(file.path);
  }
  const sortedPaths = [...seenPaths].sort((left, right) => left.localeCompare(right, "en"));
  if (manifest.files.some((file, index) => file.path !== sortedPaths[index]) || !seenPaths.has(".mcp.json")) {
    fail("HEAD_CLAUDE_MARKETPLACE_SOURCE_DISTRIBUTION_INVALID", "Source distribution paths must be unique, sorted, and include .mcp.json.");
  }
  const identity = {
    protocolVersion: manifest.protocolVersion,
    name: manifest.name,
    version: manifest.version,
    files: manifest.files,
  };
  const expectedReleaseId = `release-${sha256(Buffer.from(canonical(identity))).slice(0, 24)}`;
  if (manifest.releaseId !== expectedReleaseId) {
    fail("HEAD_CLAUDE_MARKETPLACE_SOURCE_DISTRIBUTION_INVALID", "Source distribution release identity is invalid.");
  }
  return identity;
}

function claudeMcpDocument(composition, entry = "scripts/mcp-plugin-server.mjs") {
  return {
    mcpServers: {
      [composition.serverName]: {
        command: "node",
        args: ["${CLAUDE_PLUGIN_ROOT}/" + entry],
        cwd: "${CLAUDE_PLUGIN_ROOT}",
      },
    },
  };
}

function claudePluginDocument(sourcePlugin) {
  return {
    name: sourcePlugin.name,
    version: sourcePlugin.version,
    description: sourcePlugin.description,
    author: { name: sourcePlugin.author?.name || "ccolt" },
    license: sourcePlugin.license || "UNLICENSED",
    keywords: Array.isArray(sourcePlugin.keywords) ? sourcePlugin.keywords : [],
    skills: "./skills/",
    mcpServers: "./.mcp.json",
    hooks: "./hooks/claude.json",
  };
}

function marketplaceDocument({ name, plugin }) {
  const description = "Verified Claude Code distribution of the provider-neutral Lode Agent Core.";
  return {
    name,
    owner: { name: plugin.author.name },
    description,
    metadata: { description },
    plugins: [{
      name: plugin.name,
      source: `./plugins/${plugin.name}`,
      description: plugin.description,
      version: plugin.version,
      author: { name: plugin.author.name },
    }],
  };
}

function markerIdentity({ marketplaceName: name, pluginName, pluginVersion, releaseId, repository, commit, contentDigest }) {
  return {
    protocolVersion: CLAUDE_MARKETPLACE_PROTOCOL,
    kind: marketplaceComposition(name).identity === "lode" ? "LodeAgentClaudeMarketplaceSnapshot" : "HeadAgentClaudeMarketplaceSnapshot",
    marketplaceName: name,
    pluginName,
    pluginVersion,
    sourceDistributionReleaseId: releaseId,
    sourceRepository: repository,
    sourceCommit: commit,
    projectionContentDigest: contentDigest,
    authorityEffect: "none",
  };
}

function snapshotMarker(identity) {
  return {
    ...identity,
    snapshotId: `claude-marketplace-${sha256(Buffer.from(canonical(identity))).slice(0, 24)}`,
  };
}

export function buildClaudeMarketplaceSnapshot({
  sourceRoot,
  outputRoot,
  name = DEFAULT_MARKETPLACE_NAME,
  repository = "local",
  commit = "local",
  nativeOverlayRoot = null,
} = {}) {
  if (!sourceRoot || !outputRoot) fail("HEAD_CLAUDE_MARKETPLACE_ARGUMENTS", "Source and output roots are required.");
  const source = path.resolve(sourceRoot);
  const output = path.resolve(outputRoot);
  marketplaceName(name);
  const composition = marketplaceComposition(name);
  const markerFile = generatedMarker(composition);
  const sourceManifestFile = sourceDistributionFile(composition);
  sourceRepository(repository);
  sourceCommit(commit);
  if (fs.existsSync(output)) fail("HEAD_CLAUDE_MARKETPLACE_OUTPUT_EXISTS", "Marketplace output root already exists.");
  const sourcePlugin = readJson(path.join(source, ".codex-plugin", "plugin.json"), "HEAD_CLAUDE_MARKETPLACE_PLUGIN_INVALID");
  marketplaceName(sourcePlugin.name);

  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = fs.mkdtempSync(`${output}.stage-`);
  try {
    const pluginRoot = path.join(temporary, "plugins", composition.pluginName);
    const distribution = stageDistributionRelease({ sourceRoot: source, destinationRoot: pluginRoot, nativeOverlayRoot, artifactIdentity: composition.identity });
    fs.renameSync(
      path.join(pluginRoot, "distribution-manifest.json"),
      path.join(pluginRoot, sourceManifestFile),
    );
    const entry = distribution.files.some(file => file.path === "scripts/mcp-plugin-server.mjs")
      ? "scripts/mcp-plugin-server.mjs" : "scripts/mcp-server.mjs";
    replaceJson(path.join(pluginRoot, ".mcp.json"), claudeMcpDocument(composition, entry));
    const stagedPlugin = readJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "HEAD_CLAUDE_MARKETPLACE_PLUGIN_INVALID");
    const claudePlugin = claudePluginDocument(stagedPlugin);
    writeJson(path.join(pluginRoot, ".claude-plugin", "plugin.json"), claudePlugin);
    fs.writeFileSync(path.join(temporary, ".gitattributes"), MARKETPLACE_GIT_ATTRIBUTES, { flag: "wx" });
    writeJson(path.join(temporary, ".claude-plugin", "marketplace.json"), marketplaceDocument({ name, plugin: claudePlugin }));

    const contentDigest = sha256(Buffer.from(canonical(fileInventory(temporary))));
    writeJson(path.join(temporary, markerFile), snapshotMarker(markerIdentity({
      marketplaceName: name,
      pluginName: composition.pluginName,
      pluginVersion: sourcePlugin.version,
      releaseId: distribution.releaseId,
      repository,
      commit,
      contentDigest,
    })));
    verifyClaudeMarketplaceSnapshot({ root: temporary, requireNativeBundle: Boolean(nativeOverlayRoot) });
    fs.renameSync(temporary, output);
    return verifyClaudeMarketplaceSnapshot({ root: output, requireNativeBundle: Boolean(nativeOverlayRoot) });
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

// Package-local verification for the executing plugin carrier. This does not
// verify an outer marketplace snapshot, repository, commit or installed Host.
export function verifyClaudePluginPayload({ pluginRoot, composition = ARTIFACT_COMPOSITION, entry = null, requireNativeBundle = false } = {}) {
  const sourceManifestFile = sourceDistributionFile(composition);
  for (const relative of [sourceManifestFile, ".claude-plugin/plugin.json"]) {
    const stat = fs.lstatSync(path.join(pluginRoot, ...relative.split("/")));
    if (!stat.isFile() || stat.isSymbolicLink()) fail("HEAD_CLAUDE_MARKETPLACE_SOURCE_FILE_DRIFT", "Plugin metadata must be regular package-local files.");
  }
  const plugin = readJson(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "HEAD_CLAUDE_MARKETPLACE_PLUGIN_INVALID");
  assertExactKeys(plugin, ["name", "version", "description", "author", "license", "keywords", "skills", "mcpServers", ...(Object.hasOwn(plugin, "hooks") ? ["hooks"] : [])], "Claude plugin manifest", "HEAD_CLAUDE_MARKETPLACE_PLUGIN_INVALID");
  assertExactKeys(plugin.author, ["name"], "Claude plugin author", "HEAD_CLAUDE_MARKETPLACE_PLUGIN_INVALID");
  if (entry && (plugin.name !== entry.name || plugin.version !== entry.version || plugin.description !== entry.description
    || plugin.author.name !== entry.author.name) || plugin.skills !== "./skills/" || plugin.mcpServers !== "./.mcp.json"
    || Object.hasOwn(plugin, "hooks") && plugin.hooks !== "./hooks/claude.json") {
    fail("HEAD_CLAUDE_MARKETPLACE_PLUGIN_MISMATCH", "Marketplace entry and Claude plugin manifest do not match.");
  }
  const pkg = readJson(path.join(pluginRoot, "package.json"), "HEAD_CLAUDE_MARKETPLACE_PLUGIN_INVALID");
  const codexPlugin = readJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "HEAD_CLAUDE_MARKETPLACE_PLUGIN_INVALID");
  if (codexPlugin.hooks && plugin.hooks !== "./hooks/claude.json") fail("HEAD_CLAUDE_MARKETPLACE_PLUGIN_MISMATCH", "Current source hooks require the exact Claude hook projection.");
  if (pkg.version !== plugin.version || codexPlugin.name !== plugin.name || codexPlugin.version !== plugin.version
    || plugin.name !== composition.pluginName || pkg.name !== composition.packageName) {
    fail("HEAD_CLAUDE_MARKETPLACE_PLUGIN_MISMATCH", "Claude projection does not match the provider-neutral source metadata.");
  }

  const projectedMcp = readJson(path.join(pluginRoot, ".mcp.json"), "HEAD_CLAUDE_MARKETPLACE_MCP_INVALID");
  const sourceDistribution = readJson(path.join(pluginRoot, sourceManifestFile), "HEAD_CLAUDE_MARKETPLACE_SOURCE_DISTRIBUTION_INVALID");
  sourceDistributionIdentity(sourceDistribution);
  if (sourceDistribution.name !== plugin.name || sourceDistribution.version !== plugin.version || sourceDistribution.packageName !== pkg.name) {
    fail("HEAD_CLAUDE_MARKETPLACE_SOURCE_DISTRIBUTION_MISMATCH", "Claude projection does not match its verified source distribution identity.");
  }
  const hasNativeBundle = sourceDistribution.files.some((file) => file.path.startsWith("dist/"));
  const nativeBundle = hasNativeBundle ? verifyNativeBundleOverlay({ pluginRoot, version: plugin.version }) : null;
  if (requireNativeBundle && !nativeBundle) {
    fail("HEAD_CLAUDE_MARKETPLACE_NATIVE_REQUIRED", "Claude marketplace snapshot is missing the verified cross-platform native bundle.");
  }
  for (const file of sourceDistribution.files) {
    const absolute = path.resolve(pluginRoot, ...file.path.split("/"));
    const relative = path.relative(pluginRoot, absolute);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      fail("HEAD_CLAUDE_MARKETPLACE_PATH_ESCAPE", `Unsafe source distribution path: ${file.path}`);
    }
    if (file.path === ".mcp.json") continue;
    const stat = fs.lstatSync(absolute);
    const bytes = fs.readFileSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) {
      fail("HEAD_CLAUDE_MARKETPLACE_SOURCE_FILE_DRIFT", `Source distribution file failed integrity verification: ${file.path}`);
    }
  }

  const descriptorEntry = sourceDistribution.files.find((file) => file.path === "scripts/lib/lode-artifact-composition.mjs");
  if (descriptorEntry) {
    const descriptor = fs.readFileSync(path.join(pluginRoot, ...descriptorEntry.path.split("/")), "utf8");
    const literals = descriptor.match(/const ARTIFACT_IDENTITY = "(?:lode|head)";/g) || [];
    const skills = fs.readdirSync(path.join(pluginRoot, "skills")).sort();
    if (literals.length !== 1 || literals[0] !== `const ARTIFACT_IDENTITY = ${JSON.stringify(composition.identity)};`
      || canonical(skills) !== canonical(Object.values(composition.skills).sort())) {
      fail("HEAD_CLAUDE_MARKETPLACE_SOURCE_DISTRIBUTION_MISMATCH", "Claude carrier descriptor and Skill vocabulary must match its exact package identity.");
    }
  } else if (composition.identity !== "head") {
    fail("HEAD_CLAUDE_MARKETPLACE_SOURCE_DISTRIBUTION_MISMATCH", "Canonical Claude carrier is missing its verified composition descriptor.");
  }

  // Resolve only from the descriptor whose bytes the source manifest verified.
  // Current producers still emit one current server; old snapshots are not rewritten.
  const verifiedServerName = historicalArtifactServerName(composition.identity, descriptorEntry?.sha256) || composition.serverName;
  const mcpEntry = sourceDistribution.files.some(file => file.path === "scripts/mcp-plugin-server.mjs")
    ? "scripts/mcp-plugin-server.mjs" : "scripts/mcp-server.mjs";
  if (mcpEntry === "scripts/mcp-plugin-server.mjs" && canonical(plugin) !== canonical(claudePluginDocument(codexPlugin))) {
    fail("HEAD_CLAUDE_MARKETPLACE_PLUGIN_MISMATCH", "Plugin entry metadata must match its exact source projection.");
  }
  if (canonical(projectedMcp) !== canonical(claudeMcpDocument({ ...composition, serverName: verifiedServerName }, mcpEntry))) {
    fail("HEAD_CLAUDE_MARKETPLACE_MCP_INVALID", "Claude MCP projection must use its verified artifact server and exact plugin cache root.");
  }

  const expectedFiles = [...sourceDistribution.files.map(file => file.path), ".claude-plugin/plugin.json", sourceManifestFile];
  const actualTree = treeEntries(pluginRoot)
    .sort((left, right) => left.path.localeCompare(right.path, "en") || left.type.localeCompare(right.type, "en"));
  if (canonical(actualTree) !== canonical(expectedTreeEntries(expectedFiles))) {
    fail("HEAD_CLAUDE_MARKETPLACE_TREE_MISMATCH", "Plugin payload contains missing or unexpected files or directories.");
  }
  verifyMarketplaceContent({ root: pluginRoot, files: expectedFiles });

  return { plugin, pkg, sourceDistribution, nativeBundle };
}

export function verifyClaudeMarketplaceSnapshot({
  root,
  expectedRepository = null,
  expectedMarketplaceName = null,
  expectedCommit = null,
  requireNativeBundle = false,
} = {}) {
  if (!root) fail("HEAD_CLAUDE_MARKETPLACE_VERIFY_ARGUMENTS", "Marketplace root is required.");
  const marketplaceRoot = path.resolve(root);
  const rootEntries = fs.readdirSync(marketplaceRoot).sort();
  const markers = ["lode", "head"].map((identity) => generatedMarker(artifactCompositionForIdentity(identity))).filter((file) => rootEntries.includes(file));
  if (markers.length !== 1) fail("HEAD_CLAUDE_MARKETPLACE_ROOT_CONTENT", "Marketplace must contain one exact generation marker.");
  const markerFile = markers[0];
  const expectedRootEntries = [".claude-plugin", ".gitattributes", markerFile, "plugins"].sort();
  if (canonical(rootEntries) !== canonical(expectedRootEntries)) {
    fail("HEAD_CLAUDE_MARKETPLACE_ROOT_CONTENT", "Marketplace root contains unexpected files or directories.");
  }
  if (fs.readFileSync(path.join(marketplaceRoot, ".gitattributes"), "utf8") !== MARKETPLACE_GIT_ATTRIBUTES) {
    fail("HEAD_CLAUDE_MARKETPLACE_GIT_ATTRIBUTES", "Marketplace Git attributes must preserve exact cross-platform bytes.");
  }

  const marketplace = readJson(path.join(marketplaceRoot, ".claude-plugin", "marketplace.json"), "HEAD_CLAUDE_MARKETPLACE_CATALOG_INVALID");
  assertExactKeys(marketplace, ["name", "owner", "description", "metadata", "plugins"], "Marketplace catalog", "HEAD_CLAUDE_MARKETPLACE_CATALOG_INVALID");
  marketplaceName(marketplace.name);
  const composition = marketplaceComposition(marketplace.name);
  const sourceManifestFile = sourceDistributionFile(composition);
  if (markerFile !== generatedMarker(composition)) fail("HEAD_CLAUDE_MARKETPLACE_MARKER_MISMATCH", "Marketplace marker and catalog identities disagree.");
  assertExactKeys(marketplace.owner, ["name"], "Marketplace owner", "HEAD_CLAUDE_MARKETPLACE_CATALOG_INVALID");
  assertExactKeys(marketplace.metadata, ["description"], "Marketplace metadata", "HEAD_CLAUDE_MARKETPLACE_CATALOG_INVALID");
  if (typeof marketplace.owner.name !== "string" || !marketplace.owner.name.trim()
    || typeof marketplace.description !== "string" || !marketplace.description.trim()
    || marketplace.metadata.description !== marketplace.description
    || !Array.isArray(marketplace.plugins) || marketplace.plugins.length !== 1) {
    fail("HEAD_CLAUDE_MARKETPLACE_CATALOG_INVALID", "Marketplace metadata is incomplete.");
  }
  const entry = marketplace.plugins[0];
  assertExactKeys(entry, ["name", "source", "description", "version", "author"], "Marketplace plugin entry", "HEAD_CLAUDE_MARKETPLACE_ENTRY_INVALID");
  marketplaceName(entry.name);
  assertExactKeys(entry.author, ["name"], "Marketplace plugin author", "HEAD_CLAUDE_MARKETPLACE_ENTRY_INVALID");
  if (entry.source !== `./plugins/${entry.name}` || entry.author.name !== marketplace.owner.name
    || typeof entry.description !== "string" || !entry.description.trim() || typeof entry.version !== "string" || !entry.version) {
    fail("HEAD_CLAUDE_MARKETPLACE_ENTRY_INVALID", "Marketplace plugin entry does not match the supported install contract.");
  }

  const pluginRoot = path.resolve(marketplaceRoot, entry.source);
  const relativePluginRoot = path.relative(marketplaceRoot, pluginRoot);
  if (!relativePluginRoot || relativePluginRoot.startsWith("..") || path.isAbsolute(relativePluginRoot)) {
    fail("HEAD_CLAUDE_MARKETPLACE_PATH_ESCAPE", "Marketplace plugin path escapes the snapshot root.");
  }
  const { plugin, pkg, sourceDistribution, nativeBundle } = verifyClaudePluginPayload({ pluginRoot, composition, entry, requireNativeBundle });

  const marker = readJson(path.join(marketplaceRoot, markerFile), "HEAD_CLAUDE_MARKETPLACE_MARKER_INVALID");
  assertExactKeys(marker, [
    "protocolVersion", "kind", "marketplaceName", "pluginName", "pluginVersion", "sourceDistributionReleaseId",
    "sourceRepository", "sourceCommit", "projectionContentDigest", "authorityEffect", "snapshotId",
  ], "Marketplace generation marker", "HEAD_CLAUDE_MARKETPLACE_MARKER_INVALID");
  marketplaceName(marker.marketplaceName);
  sourceRepository(marker.sourceRepository);
  sourceCommit(marker.sourceCommit);
  const contentDigest = sha256(Buffer.from(canonical(fileInventory(marketplaceRoot, new Set([markerFile])))));
  const expectedMarker = snapshotMarker(markerIdentity({
    marketplaceName: marketplace.name,
    pluginName: plugin.name,
    pluginVersion: plugin.version,
    releaseId: sourceDistribution.releaseId,
    repository: marker.sourceRepository,
    commit: marker.sourceCommit,
    contentDigest,
  }));
  if (canonical(marker) !== canonical(expectedMarker)) {
    fail("HEAD_CLAUDE_MARKETPLACE_MARKER_MISMATCH", "Marketplace generation marker does not match the verified snapshot.");
  }
  if (expectedRepository && marker.sourceRepository !== sourceRepository(expectedRepository)) {
    fail("HEAD_CLAUDE_MARKETPLACE_REPOSITORY_MISMATCH", "Marketplace snapshot belongs to a different source repository.");
  }
  if (expectedMarketplaceName && marketplace.name !== marketplaceName(expectedMarketplaceName)) {
    fail("HEAD_CLAUDE_MARKETPLACE_NAME_MISMATCH", "Marketplace snapshot has a different marketplace name.");
  }
  if (expectedCommit && marker.sourceCommit !== sourceCommit(expectedCommit)) {
    fail("HEAD_CLAUDE_MARKETPLACE_COMMIT_MISMATCH", "Marketplace snapshot belongs to a different source commit.");
  }

  const expectedFiles = [
    ".claude-plugin/marketplace.json",
    ".gitattributes",
    markerFile,
    ...sourceDistribution.files.map((file) => `plugins/${plugin.name}/${file.path}`),
    `plugins/${plugin.name}/.claude-plugin/plugin.json`,
    `plugins/${plugin.name}/${sourceManifestFile}`,
  ].sort((left, right) => left.localeCompare(right, "en"));
  const actualTree = treeEntries(marketplaceRoot)
    .sort((left, right) => left.path.localeCompare(right.path, "en") || left.type.localeCompare(right.type, "en"));
  if (canonical(actualTree) !== canonical(expectedTreeEntries(expectedFiles))) {
    fail("HEAD_CLAUDE_MARKETPLACE_TREE_MISMATCH", "Marketplace snapshot contains missing or unexpected files or directories.");
  }
  verifyMarketplaceContent({ root: marketplaceRoot, files: expectedFiles });

  return {
    status: "claude_marketplace_snapshot_verified",
    marketplaceName: marketplace.name,
    pluginName: plugin.name,
    pluginVersion: plugin.version,
    sourceDistributionReleaseId: sourceDistribution.releaseId,
    snapshotId: marker.snapshotId,
    projectionContentDigest: marker.projectionContentDigest,
    sourceRepository: marker.sourceRepository,
    sourceCommit: marker.sourceCommit,
    pluginFileCount: sourceDistribution.files.length + 2,
    nativeBundleId: nativeBundle?.nativeBundleId || null,
    nativeTargetCount: nativeBundle?.targets.length || 0,
    claudePluginRootProjection: true,
    credentialInputsAccepted: false,
    sourceAllowlistOnly: true,
    authorityEffect: "none",
  };
}

export { CLAUDE_MARKETPLACE_PROTOCOL, DEFAULT_MARKETPLACE_NAME };

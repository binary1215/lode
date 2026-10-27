import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { ARTIFACT_COMPOSITION, artifactCompositionForIdentity } from "../scripts/lib/lode-artifact-composition.mjs";
import { historicalArtifactServerName } from "../compat/head/artifact-composition.mjs";
import { stageDistributionRelease, verifyDistributionRelease, installDistribution, rollbackDistribution, inspectDistribution } from "../scripts/lib/distribution-lifecycle.mjs";
import { dispatch, catalogTools } from "../scripts/mcp-server.mjs";

const sourceRoot = path.resolve(import.meta.dirname, "..");
const oldDescriptor = fs.readFileSync(path.join(import.meta.dirname, "fixtures/lode-mcp-beta45-composition.txt"), "utf8");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function fixture(t) {
  const parent = fs.realpathSync(process.env.LODE_AGENT_TEST_TMP || process.env.HEAD_AGENT_TEST_TMP || os.tmpdir());
  const base = fs.realpathSync(fs.mkdtempSync(path.join(parent, "lode-mcp-name-")));
  t.after(() => {
    assert.equal(path.dirname(base), parent); assert(path.basename(base).startsWith("lode-mcp-name-"));
    fs.rmSync(base, { recursive: true, force: true, maxRetries: process.platform === "win32" ? 20 : 0, retryDelay: 100 });
  });
  return base;
}
function write(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
function historicalRelease(root, identity) {
  const composition = artifactCompositionForIdentity(identity);
  const server = identity === "head" ? "head_core" : "lode_core";
  const descriptor = oldDescriptor.replace('const ARTIFACT_IDENTITY = "lode";', `const ARTIFACT_IDENTITY = "${identity}";`);
  assert.equal(historicalArtifactServerName(identity, hash(descriptor)), server, "Fixture must be the exact accepted historical descriptor, not a fabricated lookalike");
  const files = new Map([
    ["package.json", JSON.stringify({ name: composition.packageName, version: "historical-name-fixture" }) + "\n"],
    [".codex-plugin/plugin.json", JSON.stringify({ name: composition.pluginName, version: "historical-name-fixture" }) + "\n"],
    [".mcp.json", JSON.stringify({ mcpServers: { [server]: { command: "node", args: ["scripts/mcp-server.mjs"] } } }) + "\n"],
    ["scripts/lib/lode-artifact-composition.mjs", descriptor],
    ["scripts/head.mjs", 'console.log(JSON.stringify({ historical: true }));\n'],
    ...Object.values(composition.skills).map(name => [`skills/${name}/SKILL.md`, "Historical fixture Skill\n"]),
  ]);
  for (const [relative, bytes] of files) write(path.join(root, relative), bytes);
  const manifest = {
    protocolVersion: "0.1.0", name: composition.pluginName, version: "historical-name-fixture",
    files: [...files].map(([relative, bytes]) => ({ path: relative, bytes: Buffer.byteLength(bytes), sha256: hash(bytes) })),
  };
  manifest.releaseId = `release-${hash(canonical(manifest)).slice(0, 24)}`;
  manifest.packageName = composition.packageName;
  write(path.join(root, "distribution-manifest.json"), JSON.stringify(manifest) + "\n");
  return manifest;
}
function rehashMcpManifest(root, manifest) {
  const bytes = fs.readFileSync(path.join(root, ".mcp.json"));
  const entry = manifest.files.find(file => file.path === ".mcp.json");
  entry.bytes = bytes.length; entry.sha256 = hash(bytes);
  const identity = { protocolVersion: manifest.protocolVersion, name: manifest.name, version: manifest.version, files: manifest.files };
  manifest.releaseId = `release-${hash(canonical(identity)).slice(0, 24)}`;
  write(path.join(root, "distribution-manifest.json"), JSON.stringify(manifest) + "\n");
}

test("Core initialization copy scopes semantic proposals to explicit Product activation", () => {
  const tool = catalogTools.find(item => item.name === "lode_project_initialize_or_resume");
  assert(tool);
  assert.match(tool.description, /Core initialize\/resume requires no Product brief or semantic proposal/);
  assert.match(tool.description, /Only the explicit Product profile/);
  assert.doesNotMatch(tool.description, /\bHEAD project\b/);
  assert.deepEqual(tool.inputSchema.properties.profile.enum, ["core", "product"]);
});

test("MCP registration and protocol initialization both use exact lode without changing operation aliases", async () => {
  assert.equal(ARTIFACT_COMPOSITION.serverName, "lode");
  assert.equal(artifactCompositionForIdentity("head").serverName, "lode");
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(sourceRoot, ".mcp.json"), "utf8")).mcpServers), ["lode"]);
  const initialized = await dispatch({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
  assert.equal(initialized.result.serverInfo.name, "lode");
  const call = name => dispatch({ id: 2, method: "tools/call", params: { name, arguments: {} } });
  assert.deepEqual(await call("head_core_contract"), await call("lode_core_contract"));
  assert.notEqual((await call("lode_unknown_mutation")).error, undefined);
  assert.equal(historicalArtifactServerName("lode", "0".repeat(64)), null);
  assert.equal(historicalArtifactServerName("head", hash(oldDescriptor)), null, "A canonical descriptor cannot authorize a historical HEAD namespace");
});

for (const identity of ["lode", "head"]) {
  test(`new ${identity} distribution advertises one lode server with its one tool and Skill vocabulary`, async t => {
    const base = fixture(t), releaseRoot = path.join(base, "new-release");
    const manifest = stageDistributionRelease({ sourceRoot, destinationRoot: releaseRoot, artifactIdentity: identity });
    assert.equal(verifyDistributionRelease({ releaseRoot, expectedReleaseId: manifest.releaseId }).releaseId, manifest.releaseId);
    const composition = artifactCompositionForIdentity(identity);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(releaseRoot, ".mcp.json"), "utf8")).mcpServers), ["lode"]);
    assert.deepEqual(fs.readdirSync(path.join(releaseRoot, "skills")).sort(), Object.values(composition.skills).sort());
    const hooks = JSON.parse(fs.readFileSync(path.join(releaseRoot, "hooks/claude.json"), "utf8"));
    assert.deepEqual(hooks.hooks.PreToolUse.map(group => group.hooks[0].server), ["lode", `plugin:${composition.pluginName}:lode`]);
    assert(hooks.hooks.PreToolUse[0].matcher.startsWith("^mcp__lode__"));
    const staged = await import(pathToFileURL(path.join(releaseRoot, "scripts/mcp-server.mjs")).href);
    const stagedCli = await import(pathToFileURL(path.join(releaseRoot, "scripts/lode.mjs")).href);
    const stagedHelp = stagedCli.runCommand(["help"]);
    assert(stagedHelp.commands.every(line => line.startsWith(`${identity}-agent `)));
    assert.equal(stagedHelp.advancedCommand, `${identity}-agent help-all`);
    assert(staged.tools.every(tool => tool.name.startsWith(composition.toolPrefix)));
    assert.equal(new Set(staged.tools.map(tool => tool.name)).size, staged.tools.length);
    assert.equal((await staged.dispatch({ id: 1, method: "initialize", params: {} })).result.serverInfo.name, "lode");
    const wrong = { mcpServers: { [identity === "head" ? "head_core" : "lode_core"]: { command: "node" } } };
    write(path.join(releaseRoot, ".mcp.json"), JSON.stringify(wrong));
    rehashMcpManifest(releaseRoot, manifest);
    assert.throws(() => verifyDistributionRelease({ releaseRoot }), { code: "HEAD_DISTRIBUTION_RELEASE_INVALID" });
  });

  test(`historical ${identity} descriptor retains only its exact namespace and immutable rollback`, t => {
    const base = fixture(t), original = path.join(base, "historical");
    const old = historicalRelease(original, identity);
    const oldManifestBytes = fs.readFileSync(path.join(original, "distribution-manifest.json"));
    const oldMcpBytes = fs.readFileSync(path.join(original, ".mcp.json"));
    assert.equal(verifyDistributionRelease({ releaseRoot: original, expectedReleaseId: old.releaseId }).releaseId, old.releaseId);
    write(path.join(original, ".mcp.json"), JSON.stringify({ mcpServers: { lode: { command: "node" } } }));
    assert.throws(() => verifyDistributionRelease({ releaseRoot: original, expectedReleaseId: old.releaseId }), { code: "HEAD_DISTRIBUTION_FILE_DRIFT" });
    rehashMcpManifest(original, structuredClone(old));
    assert.throws(() => verifyDistributionRelease({ releaseRoot: original }), { code: "HEAD_DISTRIBUTION_RELEASE_INVALID" });
    write(path.join(original, ".mcp.json"), oldMcpBytes);
    write(path.join(original, "distribution-manifest.json"), oldManifestBytes);
    const installRoot = path.join(base, "owned-install"), binDirectory = path.join(base, "owned-bin");
    const releaseRoot = path.join(installRoot, "releases", old.releaseId);
    fs.mkdirSync(path.dirname(releaseRoot), { recursive: true }); fs.renameSync(original, releaseRoot);
    const ownership = JSON.stringify({ product: "head-agent-core", protocolVersion: "0.1.0" }) + "\n";
    write(path.join(installRoot, "installation.json"), ownership);
    write(path.join(installRoot, "current.json"), JSON.stringify({ protocolVersion: "0.1.0", activeReleaseId: old.releaseId, history: [] }));
    const installed = installDistribution({ sourceRoot, installRoot, binDirectory });
    assert.equal(installed.previousReleaseId, old.releaseId);
    assert.equal(rollbackDistribution({ installRoot, binDirectory }).activeReleaseId, old.releaseId);
    assert.equal(inspectDistribution({ installRoot, binDirectory }).activeReleaseId, old.releaseId);
    const launcher = fs.readFileSync(path.join(binDirectory, "lode-agent-launcher.mjs"), "utf8");
    assert(launcher.includes(historicalArtifactServerName.toString()), "Generated launcher must embed the same trusted historical verifier");
    assert.deepEqual(fs.readFileSync(path.join(releaseRoot, "distribution-manifest.json")), oldManifestBytes);
    assert.deepEqual(fs.readFileSync(path.join(releaseRoot, ".mcp.json")), oldMcpBytes);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(installRoot, "installation.json"), "utf8")),
      { ...JSON.parse(ownership), binDirectory: path.resolve(binDirectory) });
  });
}

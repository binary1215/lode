import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject } from "../scripts/lib/head-core.mjs";
import { buildGraphExplorerSnapshot } from "../scripts/lib/graph-explorer.mjs";
import { portableMcpDocument } from "../scripts/lib/portable-client-command.mjs";
import { TRACKED_HOME_PATH_ALLOWLIST, absoluteLaunchValues, findHomePathFindings, trackedFiles } from "../scripts/lib/path-purity.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const clients = ["claude", "codex", "opencode"];

function tempProject(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, "lode-path-purity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("tracked files have no concrete personal home paths outside the explicit allowlist", () => {
  const findings = findHomePathFindings({ root: pluginRoot, files: trackedFiles(pluginRoot), allowlist: TRACKED_HOME_PATH_ALLOWLIST });
  assert.deepEqual(findings, []);
});

test("synthetic home installs stay out of Claude, Codex, and OpenCode launch documents", () => {
  const projectRoot = "/tmp/lode-project";
  // Split so this tracked test does not itself contain a concrete home path.
  const homePlugin = "/home/" + "fixture-person" + "/lode";
  for (const client of clients) {
    const { document, pathForm } = portableMcpDocument({ client, pluginRoot: homePlugin, projectRoot });
    assert.equal(pathForm, "host-placeholder");
    assert.deepEqual(absoluteLaunchValues(document), []);
    assert.equal(JSON.stringify(document).includes("fixture-person"), false);
    assert.equal(JSON.stringify(document).includes(homePlugin), false);
  }
  const inside = portableMcpDocument({ client: "claude", pluginRoot: projectRoot, projectRoot });
  assert.equal(inside.pathForm, "project-relative");
  assert.deepEqual(inside.document.args, ["scripts/mcp-server.mjs"]);
  assert.equal(inside.document.command, "node");
});

test("only explicit local Claude installation projection names the selected package; portable clients remain path-free", async (t) => {
  const root = tempProject(t);
  initializeProject({ root, pluginRoot, runtimes: clients });
  assert.deepEqual(findHomePathFindings({ root, allowlist: [".lode/project.json", ".lode/generated/manifest.json", ".mcp.json", ".lode/generated/claude.mcp.json"] }), []);
  const claude = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
  const opencode = JSON.parse(fs.readFileSync(path.join(root, "opencode.json"), "utf8"));
  const generatedClaude = JSON.parse(fs.readFileSync(path.join(root, ".lode", "generated", "claude.mcp.json"), "utf8"));
  const generatedOpenCode = JSON.parse(fs.readFileSync(path.join(root, ".lode", "generated", "opencode.json"), "utf8"));
  for (const document of [opencode, generatedOpenCode]) {
    assert.deepEqual(absoluteLaunchValues(document), []);
  }
  for (const document of [claude, generatedClaude]) {
    assert.deepEqual(document.mcpServers.lode.args, [path.join(fs.realpathSync(pluginRoot), "scripts", "mcp-server.mjs")]);
    assert.equal(document.mcpServers.lode.cwd, fs.realpathSync(pluginRoot));
    assert.equal(JSON.stringify(document).includes("LODE_PLUGIN_ROOT"), false);
  }
  assert.equal(fs.existsSync(path.join(root, "AGENTS.md")), true);
  assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8").includes(pluginRoot), false);
  const codex = portableMcpDocument({ client: "codex", pluginRoot, projectRoot: root });
  assert.equal(codex.pathForm, "host-placeholder");
  assert.deepEqual(absoluteLaunchValues(codex.document), []);

  const local = await buildGraphExplorerSnapshot({ root, share: false });
  const shared = await buildGraphExplorerSnapshot({ root, share: true });
  assert.equal(local.project.root, fs.realpathSync(root));
  assert.equal(local.regenerate.argv[0], process.execPath);
  assert.equal(shared.project.root, undefined);
  assert.equal(shared.regenerate.argv, undefined);
  assert.equal(JSON.stringify(shared).includes(process.execPath), false);
  assert.equal(JSON.stringify(shared).includes(fs.realpathSync(root)), false);
});

test("installed Claude roots with spaces work without Host environment or cwd/PATH fallbacks", t => {
  const base = tempProject(t), selected = path.join(base, "selected package with spaces"), replacement = path.join(base, "replacement package");
  for (const root of [selected, replacement]) {
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(root, "scripts", "mcp-server.mjs"), "// synthetic MCP entry\n");
  }
  for (const pluginRoot of [selected, replacement]) {
    const { document, pathForm } = portableMcpDocument({ client: "claude", pluginRoot, projection: "installed-project" });
    assert.equal(pathForm, "installed-project");
    assert.deepEqual(document, { command: "node", args: [path.join(fs.realpathSync(pluginRoot), "scripts", "mcp-server.mjs")], cwd: fs.realpathSync(pluginRoot), env: {} });
  }
  for (const pluginRoot of [undefined, "", ".", "relative/package"]) {
    assert.throws(() => portableMcpDocument({ client: "claude", pluginRoot, projection: "installed-project" }), { code: "INVALID_INSTALLED_MCP_ROOT" });
  }
  assert.throws(() => portableMcpDocument({ client: "claude", pluginRoot: path.join(base, "absent"), projection: "installed-project" }), { code: "ENOENT" });
  assert.equal(portableMcpDocument({ client: "claude", pluginRoot: selected }).document.args[0], "${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs", "Marketplace/portable contract is unchanged.");
  const hangul = path.join(base, "한글 café (team)'s project");
  fs.mkdirSync(hangul);
  const projected = portableMcpDocument({ client: "claude", pluginRoot: selected, projectRoot: hangul, projection: "project-file" });
  assert.equal(projected.pathForm, "env-placeholder");
  assert.deepEqual(projected.document.args, ["${LODE_PLUGIN_ROOT}/scripts/mcp-server.mjs"]);
  assert.equal(JSON.stringify(projected.document).includes(selected), false);
});

test("Claude initialization preserves existing user-owned MCP bytes", t => {
  const root = tempProject(t), file = path.join(root, ".mcp.json"), content = '{"mcpServers":{"user_owned":{"command":"preserve-me"}}}\n';
  fs.writeFileSync(file, content);
  initializeProject({ root, pluginRoot, runtimes: ["claude"] });
  assert.equal(fs.readFileSync(file, "utf8"), content);
});

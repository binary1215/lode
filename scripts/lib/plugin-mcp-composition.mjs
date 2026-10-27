import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARTIFACT_COMPOSITION } from "./lode-artifact-composition.mjs";
import { verifyClaudePluginPayload } from "./claude-marketplace.mjs";
import { resolveProjectStorage } from "./project-storage-format.mjs";
import { parseClaudeNativeToolName } from "./session-host-request.mjs";

// Private, request-scoped installation composition, not an authorization or a
// model-supplied loaded flag. No native identity is written into Project state.
const launches = new WeakMap(), requests = new WeakMap();
const packageRoot = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));
const entryPath = path.join(packageRoot, "scripts", "mcp-plugin-server.mjs");
const serverPath = path.join(packageRoot, "scripts", "mcp-server.mjs");
const pluginNamespace = `plugin_${ARTIFACT_COMPOSITION.pluginName}_${ARTIFACT_COMPOSITION.serverName}`;

function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file) throw new Error("Unverified plugin entry.");
}
function verifiedEntryIdentity(manifest) {
  for (const required of ["scripts/mcp-plugin-server.mjs", "scripts/mcp-server.mjs", "scripts/lib/plugin-mcp-composition.mjs"]) {
    if (!manifest.files.some(file => file.path === required)) throw new Error("Plugin composition code is outside the verified payload.");
  }
  return manifest.releaseId;
}
function verifyOwnPackage() {
  regular(entryPath); regular(serverPath); regular(path.join(packageRoot, ".mcp.json"));
  // Only Claude currently supplies the exact private Hook/root correlation
  // consumed below. Other carriers keep standalone provisioning; a CLI/client
  // label or a source/Codex package is not a verified Claude plugin projection.
  return verifiedEntryIdentity(verifyClaudePluginPayload({ pluginRoot: packageRoot }).sourceDistribution);
}
function ownerAt(root) {
  const storage = resolveProjectStorage(root);
  if (!storage) return null;
  const value = JSON.parse(fs.readFileSync(storage.projectFile));
  if (value.schemaVersion !== 1 || value.projectRoot !== root || value.projectId !== storage.projectId) throw new Error("Unverified Project owner.");
  return value.projectId;
}
export function createPluginMcpLaunch(entryUrl) {
  try {
    if (fileURLToPath(entryUrl) !== entryPath || !process.argv[1] || fs.realpathSync(process.argv[1]) !== entryPath) return null;
    const launch = Object.freeze({}); launches.set(launch, { releaseId: verifyOwnPackage() }); return launch;
  } catch { return null; } // Unknown composition keeps ordinary standalone setup.
}
export function createPluginInitializationContext({ launch, servingModuleUrl, caller, root } = {}) {
  try {
    const known = launches.get(launch), parsed = parseClaudeNativeToolName(caller?.outerToolName);
    if (!known || fileURLToPath(servingModuleUrl) !== serverPath || caller?.status !== "known" || caller.runtime !== "claude"
      || caller.correlation !== "exact-native-tool-use" || parsed?.server !== pluginNamespace
      || typeof caller.nativeProjectRoot !== "string" || !path.isAbsolute(caller.nativeProjectRoot) || typeof root !== "string") return null;
    const canonical = fs.realpathSync(path.resolve(root));
    if (fs.realpathSync(caller.nativeProjectRoot) !== canonical || !fs.statSync(canonical).isDirectory()
      || verifyOwnPackage() !== known.releaseId) return null;
    const context = Object.freeze({});
    requests.set(context, { root: canonical, projectId: ownerAt(canonical), launch }); return context;
  } catch { return null; }
}
export function pluginMcpServesProject(context, root, projectId) {
  try {
    const request = requests.get(context);
    const launch = request && launches.get(request.launch);
    if (!request || !launch || fs.realpathSync(root) !== request.root || verifyOwnPackage() !== launch.releaseId) return false;
    const current = ownerAt(request.root);
    // A fresh request stays fresh only until its matching Core owner is built;
    // existing owners must match both the observed owner and the supplied owner.
    if (request.projectId !== null) return current === request.projectId && current === projectId;
    if (current === null && typeof projectId === "string" && projectId) request.createdProjectId ??= projectId;
    return request.createdProjectId === projectId && (current === null || current === projectId);
  } catch { return false; }
}
export function releasePluginInitializationContext(context) { if (context) requests.delete(context); }

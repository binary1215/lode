import fs from "node:fs";
import path from "node:path";
import { ARTIFACT_COMPOSITION } from "../lode-artifact-composition.mjs";
import { claudeNativeHookMatchers } from "../session/session-host-request.mjs";

export const CLAUDE_HOOKS_FILE = "hooks/claude.json";

// hooks/claude.json is hand-maintained except for the two PreToolUse matchers,
// which are derived from the MCP catalog by claudeNativeHookMatchers(). Only
// those two strings are replaced; every other key, value and order is kept.
export function renderClaudeHooks(currentText, catalog) {
  const hooks = JSON.parse(currentText);
  const groups = hooks?.hooks?.PreToolUse;
  const matchers = claudeNativeHookMatchers(catalog);
  const servers = [ARTIFACT_COMPOSITION.serverName, `plugin:${ARTIFACT_COMPOSITION.pluginName}:${ARTIFACT_COMPOSITION.serverName}`];
  if (!Array.isArray(groups) || groups.length !== matchers.length || groups.some((group, index) => group?.hooks?.[0]?.server !== servers[index])) {
    throw Object.assign(new Error("hooks/claude.json PreToolUse groups must be the direct and plugin MCP namespaces, in that order."), {
      code: "CLAUDE_HOOKS_SHAPE_UNEXPECTED",
    });
  }
  groups.forEach((group, index) => {
    group.matcher = matchers[index];
  });
  return `${JSON.stringify(hooks, null, 2)}\n`;
}

export async function generateClaudeHooks({ root, check = false } = {}) {
  // The operation registry is the tool list; the MCP-only host request helper is
  // never matched (claudeNativeHookMatchers skips it).
  const { registryCatalog } = await import("../session/operation-registry.mjs");
  const file = path.join(root, CLAUDE_HOOKS_FILE);
  const current = fs.readFileSync(file, "utf8");
  const next = renderClaudeHooks(current, registryCatalog());
  if (current === next) return { status: "current", file: CLAUDE_HOOKS_FILE };
  if (check) return { status: "stale", file: CLAUDE_HOOKS_FILE };
  fs.writeFileSync(file, next);
  return { status: "written", file: CLAUDE_HOOKS_FILE };
}

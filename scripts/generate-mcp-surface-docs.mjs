#!/usr/bin/env node
// Regenerates the grouped-tool mapping tables in docs/mcp-surface.md and
// docs/ko/mcp-surface.md from scripts/lib/operation-groups.mjs. Only the text
// between the two generated markers is replaced.
//
//   node scripts/generate-mcp-surface-docs.mjs [--check]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MCP_SURFACE_DOCS = Object.freeze(["docs/mcp-surface.md", "docs/ko/mcp-surface.md"]);
const BEGIN = "<!-- generated: mcp-surface-groups (node scripts/generate-mcp-surface-docs.mjs) -->";
const END = "<!-- end generated: mcp-surface-groups -->";
const MANAGED_ROUTE = {
  "docs/mcp-surface.md": " with `execution_mode: managed`",
  "docs/ko/mcp-surface.md": ", `execution_mode: managed` 필요",
};
const HEADERS = {
  "docs/mcp-surface.md": ["Grouped tool", "`action`", "Route", "Deprecated name"],
  "docs/ko/mcp-surface.md": ["묶음 도구", "`action`", "경로", "폐기 예정 이름"],
};

export async function renderMcpSurfaceTable(file) {
  const { operationCatalogTools } = await import("./mcp-server.mjs");
  const { DEPRECATED_ALIAS_REMOVAL_VERSION, OPERATION_GROUPS } = await import("./lib/operation-groups.mjs");
  const { isManagedMutation } = await import("./lib/managed-maintenance-surface.mjs");
  const operations = new Map(operationCatalogTools.map((tool) => [tool.name, tool]));
  const [group, action, route, alias] = HEADERS[file];
  const lines = [`| ${group} | ${action} | ${route} | ${alias} (${DEPRECATED_ALIAS_REMOVAL_VERSION}) |`, "| --- | --- | --- | --- |"];
  for (const entry of OPERATION_GROUPS) {
    for (const { action: name, operation } of entry.actions) {
      const router = operations.get(operation).annotations?.readOnlyHint === true ? "lode_tools_read" : "lode_tools_call";
      const managed = isManagedMutation(operation) ? MANAGED_ROUTE[file] : "";
      lines.push(`| \`${entry.name}\` | \`${name}\` | \`${router}\`${managed} | \`${operation}\` |`);
    }
  }
  return lines.join("\n");
}

export async function renderMcpSurfaceDoc(file, text) {
  const begin = text.indexOf(BEGIN),
    end = text.indexOf(END);
  if (begin < 0 || end < begin) throw new Error(`${file} has no generated mcp-surface-groups section.`);
  return `${text.slice(0, begin + BEGIN.length)}\n\n${await renderMcpSurfaceTable(file)}\n\n${text.slice(end)}`;
}

export async function generateMcpSurfaceDocs({ root, check = false } = {}) {
  const results = [];
  for (const file of MCP_SURFACE_DOCS) {
    const target = path.join(root, file);
    const current = fs.readFileSync(target, "utf8");
    const next = await renderMcpSurfaceDoc(file, current);
    if (current === next) results.push({ file, status: "current" });
    else if (check) results.push({ file, status: "stale" });
    else {
      fs.writeFileSync(target, next);
      results.push({ file, status: "written" });
    }
  }
  return results;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const results = await generateMcpSurfaceDocs({ root, check: process.argv.includes("--check") });
  process.stdout.write(`${JSON.stringify(results)}\n`);
  if (results.some((result) => result.status === "stale")) {
    process.stderr.write("docs/mcp-surface.md is stale; run: node scripts/generate-mcp-surface-docs.mjs\n");
    process.exitCode = 1;
  }
}

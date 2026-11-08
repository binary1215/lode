#!/usr/bin/env node
// Regenerates the PreToolUse matchers in hooks/claude.json from the MCP catalog.
// --check writes nothing and exits 1 when the committed file is stale.

import path from "node:path";
import { generateClaudeHooks } from "./lib/claude-hooks-generation.mjs";

const flags = process.argv.slice(2);
try {
  if (flags.some(flag => flag !== "--check")) throw new Error("Usage: node scripts/generate-claude-hooks.mjs [--check]");
  const result = await generateClaudeHooks({ root: path.resolve(import.meta.dirname, ".."), check: flags.includes("--check") });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === "stale") {
    process.stderr.write("hooks/claude.json is stale; run: node scripts/generate-claude-hooks.mjs\n");
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

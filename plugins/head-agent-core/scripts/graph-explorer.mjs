#!/usr/bin/env node
import { exportGraphExplorer } from "./lib/graph-explorer.mjs";

try {
  const options = {}, args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--help") {
      process.stdout.write("Usage: node scripts/graph-explorer.mjs [--root project] [--layer project|code] [--query text] [--anchors id,...] [--paths path,...] [--history] [--output new-file.html]\nCreates a local read-only HTML snapshot; no server, setup, Session binding or refresh.\n");
      process.exit(0);
    }
    const key = { "--root": "root", "--layer": "layer", "--query": "query", "--anchors": "anchorIds", "--paths": "paths", "--output": "output", "--history": "history" }[flag];
    if (!key || Object.hasOwn(options, key)) throw new Error("Unsupported or duplicate option.");
    if (key === "history") options.history = true;
    else { const value = args[++index]; if (!value || value.startsWith("--")) throw new Error("Option value is missing."); options[key] = ["anchorIds", "paths"].includes(key) ? value.split(",") : value; }
  }
  process.stdout.write(`${JSON.stringify(await exportGraphExplorer(options), null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.code || "GRAPH_EXPLORER_ERROR"}: ${error.message}\n`);
  process.exitCode = 1;
}

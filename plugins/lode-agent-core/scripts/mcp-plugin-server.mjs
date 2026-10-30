#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveMcp } from "./mcp-server.mjs";
import { createPluginMcpLaunch } from "./lib/plugin-mcp-composition.mjs";

// Only the packaged plugin config uses this entry. Source imports and the
// distribution launcher's internal MCP mode keep standalone composition.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  serveMcp({ pluginLaunch: createPluginMcpLaunch(import.meta.url) });
}

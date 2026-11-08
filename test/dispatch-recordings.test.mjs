import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const fixtureFile = path.join(pluginRoot, "test/fixtures/dispatch-recordings.json");
const register = pathToFileURL(path.join(pluginRoot, "test/helpers/dispatch-recording-register.mjs")).href;
const runner = path.join(pluginRoot, "test/helpers/dispatch-recording-run.mjs");

// Recorded before any operation moved to scripts/lib/operation-registry.mjs. Each
// entry names the scripts/lib function an MCP tool or CLI command calls and the
// exact arguments it passes; moving an operation must not change any entry.
// Regenerate only for an intended dispatch change, never to absorb a move:
//   node --import ./test/helpers/dispatch-recording-register.mjs test/helpers/dispatch-recording-run.mjs --out test/fixtures/dispatch-recordings.json
const key = (entry) => (entry.surface === "mcp" ? `mcp ${entry.tool} ${JSON.stringify(entry.input)}` : `cli ${JSON.stringify(entry.argv)}`);

test("MCP tools and CLI commands still call the recorded library functions with the recorded arguments", async () => {
  const result = spawnSync(process.execPath, ["--import", register, runner], { cwd: pluginRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  const expected = JSON.parse(fs.readFileSync(fixtureFile, "utf8"));
  const recorded = new Map(expected.entries.map((entry) => [key(entry), entry]));
  const current = new Map(actual.entries.map((entry) => [key(entry), entry]));
  assert.deepEqual(
    [...current.keys()].filter((name) => !recorded.has(name)),
    [],
    "inputs without a recording",
  );
  assert.deepEqual(
    [...recorded.keys()].filter((name) => !current.has(name)),
    [],
    "recordings without a current input",
  );
  const changed = [];
  for (const [name, entry] of recorded) {
    const now = current.get(name);
    if (JSON.stringify({ calls: now.calls, outcome: now.outcome }) !== JSON.stringify({ calls: entry.calls, outcome: entry.outcome })) changed.push(name);
  }
  if (changed.length) {
    const first = changed[0];
    assert.deepEqual(
      { calls: current.get(first).calls, outcome: current.get(first).outcome },
      { calls: recorded.get(first).calls, outcome: recorded.get(first).outcome },
      `${changed.length} recorded dispatches changed; first: ${first}`,
    );
  }
});

test("the recordings cover every catalog tool and every CLI command branch", async () => {
  const { catalogTools } = await import("../scripts/mcp-server.mjs");
  const { cliCommands } = await import("./helpers/dispatch-recording-run.mjs");
  const expected = JSON.parse(fs.readFileSync(fixtureFile, "utf8"));
  const tools = new Set(expected.entries.filter((entry) => entry.surface === "mcp").map((entry) => entry.tool));
  const commands = new Set(expected.entries.filter((entry) => entry.surface === "cli").map((entry) => entry.command));
  assert.deepEqual(
    catalogTools.map((tool) => tool.name).filter((name) => !tools.has(name)),
    [],
  );
  assert.deepEqual(
    [...cliCommands().keys()].filter((name) => !commands.has(name)),
    [],
  );
  assert.equal(tools.size, catalogTools.length);
  // Most recordings reach an implementation; the rest stop at a recorded refusal.
  const reached = expected.entries.filter((entry) => entry.calls.length).length;
  assert.ok(reached / expected.entries.length > 0.8, `${reached}/${expected.entries.length}`);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

// Two real processes, two workers of one Project, create and remove their own
// operational folders under the same shared parents as fast as they can. With
// the lost-race rule neither may ever throw; before it, both backends threw
// ENOENT, ENOTEMPTY or (Windows) EPERM here.
const pluginRoot = path.resolve(import.meta.dirname, "..");
const child = path.join(pluginRoot, "test", "helpers", "proposal-folders-race-child.mjs");
const backends = [
  { name: "Claude", file: "scripts/lib/runtime/runtime-claude-proposal.mjs", exportName: "claudeProposalOperationalDirectory" },
  { name: "Codex", file: "scripts/lib/runtime/runtime-codex-proposal.mjs", exportName: "codexProposalOperationalFiles" },
];

function run(args) {
  return new Promise((resolve, reject) => {
    const processChild = spawn(process.execPath, [child, ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "",
      err = "";
    processChild.stdout.on("data", (data) => (out += data));
    processChild.stderr.on("data", (data) => (err += data));
    processChild.on("error", reject);
    processChild.on("close", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`race child exited ${code}: ${err}`))));
  });
}

for (const backend of backends) {
  test(`${backend.name} proposal workers of one Project create and remove their folders at the same moment without failing`, async (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "head-proposal-folders-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const start = path.join(root, "start");
    const workers = ["a", "b"].map((suffix) =>
      run([path.join(pluginRoot, backend.file), backend.exportName, root, "project-0123456789abcdef", `execution-authorization-race-${suffix}`, "60", start]),
    );
    fs.writeFileSync(start, "go");
    const results = await Promise.all(workers);
    assert.deepEqual(
      results.map((result) => result.errors),
      [[], []],
      JSON.stringify(results),
    );
    // Both workers left nothing behind: the shared parents went with the last one.
    assert.deepEqual(
      fs.readdirSync(root).filter((name) => name !== "start"),
      [],
    );
  });
}

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withProjectMutation } from "../scripts/lib/project-mutation-lock.mjs";
import { compileContext, readContextCapsule } from "../scripts/lib/context-compiler.mjs";
import { catalogTools } from "../scripts/mcp-server.mjs";
import { initializeProject } from "../scripts/lib/lode-core.mjs";
import { runCommand } from "../scripts/lode.mjs";

const source = path.resolve(import.meta.dirname, "..");

test("current CLI input diagnostics use Lode while protected wire identities stay unchanged", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lode-input-labels-")));
  try {
    initializeProject({ root, pluginRoot: source, runtimes: ["codex"] });
    const bad = path.join(root, "bad-input.json"); fs.writeFileSync(bad, "{");
    for (const [args, label] of [
      [["managed-maintenance", "conformance-propose", root, "--input", bad], "Conformance provider-Lode proposal"],
      [["managed-maintenance", "conformance-resolution-propose", root, "--input", bad], "Conformance provider-Lode resolution"],
      [["compaction-lifecycle-step", root, "--input", bad], "Lode compaction direction"],
      [["context-preview", root, "--task", "Inspect fixture", "--evidence-needs", bad], "Lode evidence needs"],
    ]) (await assert.rejects(async () => (await runCommand(args)), error => error.message.includes(label)));
  } finally { assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); }
});
test("the twelve accepted current display labels use Lode and keep compatibility error codes", () => {
  const files = ["scripts/lode.mjs", "scripts/mcp-server.mjs", ...["distribution-lifecycle", "compaction-recovery", "context-compiler", "execution-lineage", "project-mutation-lock", "runtime-invocation-lifecycle", "session-routing", "world-model"].map(name => `scripts/lib/${name}.mjs`)];
  const text = files.map(file => fs.readFileSync(path.join(source, file), "utf8")).join("\n");
  assert.doesNotMatch(text, /HEAD Agent Core/);
  assert.equal((text.match(/Lode Agent Core/g) || []).length, 12);
  assert.match(text, /HEAD_DISTRIBUTION_INSTALL_ROOT_CONFLICT/);
  assert.match(text, /HEAD_DISTRIBUTION_NOT_INSTALLED/);
  assert.equal(catalogTools.find(tool => tool.name === "lode_core_contract").description, "Read the active Lode Agent Core roles, runtimes, and capability boundary.");
  const checkProse = value => {
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if (["description", "title"].includes(key) && typeof entry === "string") assert.doesNotMatch(entry, /\bHEAD\b/);
      else checkProse(entry);
    }
  };
  for (const tool of catalogTools) checkProse(tool);
});

test("not-initialized paths preserve exact error identity with the corrected display name", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lode-label-errors-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => withProjectMutation({ root, scope: "fixture" }, () => assert.fail("not reached")), {
    code: "NOT_INITIALIZED", message: "Lode Agent Core is not initialized.",
  });
  assert.throws(() => readContextCapsule({ root, capsuleId: `capsule-${"a".repeat(24)}` }), {
    code: "NOT_INITIALIZED", message: "Lode Agent Core is not initialized.",
  });
  (await assert.rejects(async () => (await compileContext({ root, task: "synthetic fixture", budget: 32768, persist: false })), {
    code: "PROJECT_NOT_READY", message: "Project must be ready to compile context; current status: not_initialized.",
  }));
});

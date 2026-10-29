import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject, inspectProject, convergeProjectInstallation, inspectRuntimeAdapters, createCheckpoint, coreContract } from "../scripts/lib/lode-core.mjs";
import { prepareContextWorkflow, previewContextWorkflow } from "../scripts/lib/context-workflow.mjs";
import { formatForVerifiedOwner } from "../scripts/lib/project-storage-format.mjs";
import { runCommand } from "../scripts/lode.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const read = relative => fs.readFileSync(path.join(pluginRoot, relative), "utf8");
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function fixture(t) {
  const parent = fs.realpathSync(process.env.LODE_AGENT_TEST_TMP || process.env.HEAD_AGENT_TEST_TMP || os.tmpdir());
  const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, "lode-display-labels-")));
  t.after(() => {
    assert.equal(path.dirname(root), parent); assert(path.basename(root).startsWith("lode-display-labels-"));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: process.platform === "win32" ? 20 : 0, retryDelay: 100 });
  });
  return root;
}
function inventory(root) {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
    const file = path.join(entry.parentPath, entry.name);
    return [path.relative(root, file).replaceAll("\\", "/"), digest(fs.readFileSync(file))];
  }).sort(([a], [b]) => a.localeCompare(b));
}

test("ordinary EN/KO CLI examples use the actual installed lode-agent launcher and retain raw arguments", () => {
  const counts = { "bounded-worker-wave": 7, "compaction-recovery": 5, "conformance-reconciliation": 6,
    "delivery-observation": 2, "document-change-review": 5, "product-operating-loop": 7,
    "release-observation": 2, "session-recovery": 17 };
  let count = 0;
  for (const [name, expected] of Object.entries(counts)) for (const prefix of ["docs/", "docs/ko/"]) {
    const text = read(`${prefix}${name}.md`);
    assert.equal((text.match(/^lode-agent /gm) || []).length, expected);
    assert.equal((text.match(/^head |^lode /gm) || []).length, 0, "Neither bare command is an installed launcher");
    count += expected;
  }
  assert.equal(count, 102);
  assert(read("scripts/lib/distribution-lifecycle.mjs").includes('const command = `${identity}-agent`;'));
  for (const prefix of ["docs/", "docs/ko/"]) {
    assert(read(prefix + "session-recovery.md").includes("--input <head-direction.json>"));
    assert(read(prefix + "session-recovery.md").includes("--role <non-head-role>"));
    assert(read(prefix + "product-operating-loop.md").includes("lode-agent head-continuity"));
    assert(read(prefix + "conformance-reconciliation.md").includes("<provider-head-proposal.json>"));
    assert(read(prefix + "original-head-core-comparison.md").includes("`head help`"), "Historical source comparison remains original");
    assert(read(prefix + "architecture.md").includes("scripts/lib/lode-core   project canon"));
  }
  assert(fs.existsSync(path.join(pluginRoot, "scripts/lib/head-core.mjs")), "Import shim is retained");
});

test("canonical light and complete help use the real launcher without changing surface or execution semantics", async () => {
  const light = (await runCommand(["help"])), complete = (await runCommand(["help-all"]));
  assert.equal(light.surface, "light-default"); assert.equal(complete.surface, "ordinary-complete");
  assert(light.commands.every(line => line.startsWith("lode-agent ")));
  assert(complete.commands.every(line => line.startsWith("lode-agent ")));
  assert.equal(light.advancedCommand, "lode-agent help-all");
  assert.equal(complete.advancedCommand, null);
  assert.equal(light.executionMeans.default, "lode-direct");
  assert.equal(light.executionMeans.requiresUserSelection, false);
  assert.equal(light.laneRecommendationRequired, false);
  assert.equal(light.commands.includes("lode-agent product-signal-record <project> --input <signal.json>"), false);
  assert.equal(complete.commands.includes("lode-agent product-signal-record <project> --input <signal.json>"), true);
});

test("fresh instruction and diagnostics use Lode while retaining exact existing error codes and roles", async t => {
  const root = fixture(t), empty = fixture(t);
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  assert(read("scripts/lib/lode-core.mjs").includes("# Project-specific Lode context"));
  assert(fs.readFileSync(path.join(root, ".lode/instructions/project.md"), "utf8").startsWith("# Project-specific Lode context\n"));
  const before = inventory(root);
  assert.throws(() => initializeProject({ root, pluginRoot, runtimes: ["codex"] }),
    { code: "ALREADY_INITIALIZED", message: "Lode Agent Core is already initialized for this project." });
  assert.throws(() => convergeProjectInstallation({ root: empty, pluginRoot }),
    { code: "NOT_INITIALIZED", message: "Lode Agent Core is not initialized." });
  await assert.rejects(inspectRuntimeAdapters(empty),
    { code: "NOT_INITIALIZED", message: "Lode Agent Core is not initialized." });
  assert.throws(() => createCheckpoint({ root, summary: "Do not save" }), error => {
    assert.equal(error.code, "LEGACY_CHECKPOINT_API_RETIRED");
    assert(error.message.includes("`lode-agent checkpoint`")); return true;
  });
  assert.deepEqual(coreContract().roles, ["head", "developer", "coder", "reviewer"]);
  assert.deepEqual(inventory(root), before); assert.deepEqual(fs.readdirSync(empty), []);
});

test("an existing HEAD-labelled instruction and managed manifest are not rewritten on convergence", t => {
  const root = fixture(t);
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  // Synthetic existing-document fixture, not a claim to be an old-producer release.
  const file = path.join(root, ".lode/instructions/project.md");
  const original = "# Project-specific HEAD context\n\nRecord project identity, canonical sources, repository boundaries, and fixed constraints here.\n";
  fs.writeFileSync(file, original);
  const manifestFile = path.join(root, ".lode/generated/manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  assert.equal(manifest.managed.some(entry => entry.path === ".lode/instructions/project.md"), false,
    "User-owned Project context is mutable Canon, not a generated-file checksum entry");
  assert.equal(inspectProject(root).status, "ready");
  const before = inventory(root), selected = inspectProject(root).state.sessionId;
  assert.equal(convergeProjectInstallation({ root, pluginRoot }).status, "current");
  assert.equal(inspectProject(root).state.sessionId, selected);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.deepEqual(inventory(root), before);
});

test("context display note changes no serialized status, authority, Capsule identity or Project bytes", async t => {
  const root = fixture(t); initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const before = inventory(root), task = "Inspect current local evidence";
  const preview = (await previewContextWorkflow({ root, task }));
  const prepared = (await prepareContextWorkflow({ root, task }));
  assert(preview.workflow.nextAction.note.startsWith("Lode decides which evidence is needed"));
  assert.equal(preview.workflow.status, "ready_for_head_semantic_assessment");
  assert.equal(preview.workflow.evidenceNeeds.semanticAcceptance, "not-assessed-HEAD-owned");
  assert.equal(preview.workflow.nextAction.id, "head_assess_semantic_sufficiency");
  assert.equal(preview.workflow.evidenceNeeds.owner, formatForVerifiedOwner(inspectProject(root)).value("HEAD"));
  assert.equal(preview.workflow.authority.advisoryOnly, true);
  assert.equal(preview.workflow.authority.judgesSemanticSufficiency, false);
  assert.equal(preview.workflow.authority.writesRecoveryDirection, false);
  assert.equal((await previewContextWorkflow({ root, task })).capsule.capsuleId, preview.capsule.capsuleId);
  assert.deepEqual(prepared.preparation.selectedContext.repositoryFiles, preview.capsule.repositoryContext);
  assert.equal(prepared.preparation.nextAction.note, preview.workflow.nextAction.note);
  assert.deepEqual(inventory(root), before);
});

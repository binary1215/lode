import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { measureContextDiagnostics } from "../scripts/measure-context-diagnostics.mjs";
import { initializeProject } from "../scripts/lib/head-core.mjs";
import { buildWorldModel } from "../scripts/lib/world-model.mjs";
import { previewContextWorkflow } from "../scripts/lib/context-workflow.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");

function treeDigest(root) {
  const result = {};
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else result[path.relative(root, file)] = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    }
  }
  visit(root);
  return result;
}

test("diagnostics preserve generic project bytes and Capsule identity with truthful coverage and timing scope", async (t) => {
  const root = fs.mkdtempSync(path.join(process.env.HEAD_AGENT_TEST_TMP || os.tmpdir(), "head-context-diagnostics-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "queue.mjs"), "export const enqueue = (items, value) => [...items, value];\n");
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  await buildWorldModel({ root });
  const task = "Explain how the queue appends one item";
  const before = treeDigest(root);
  const expected = (await previewContextWorkflow({ root, task })).capsule;
  const originalRead = fs.readFileSync;
  const originalWrite = fs.writeFileSync;
  const report = await measureContextDiagnostics({ project: root, task, iterations: 3 });
  assert.deepEqual(treeDigest(root), before);
  assert.equal(fs.readFileSync, originalRead);
  assert.equal(fs.writeFileSync, originalWrite);
  assert.equal(report.contextPreview.samples.length, 3);
  assert.equal(report.contextPreview.stableCapsuleIdentity, true);
  for (const sample of report.contextPreview.samples) {
    assert.equal(sample.capsuleHash, expected.capsuleHash);
    assert.equal(sample.evidenceGapCount, 0);
    assert.equal(sample.semanticSufficiencyOwner, "HEAD");
    assert.equal(sample.worldState, "current-verified");
    assert.equal(sample.observedFs.filesystemMutationAttempts, 0);
    assert.ok(sample.observedFs.readFileSyncReturnedPayloadBytes > 0);
    assert.ok(Number.isFinite(sample.elapsedMs));
  }
  assert.equal(report.contextPreview.firstCall.sampleCount, 1);
  assert.equal(report.contextPreview.repeatedCalls.sampleCount, 2);
  assert.equal(report.interpretation.headDiscoveryQuality, "not-measured");
  assert.equal(report.interpretation.semanticSufficiency, "not-measured-HEAD-owned");
  assert.equal(report.interpretation.timingInCapsuleIdentity, false);
  assert.equal(JSON.stringify(report).includes(task), false);
  assert.equal(JSON.stringify(report).includes("export const enqueue"), false);
  const catalog = report.mcpCatalog;
  assert.equal(catalog.readOnlyTrue + catalog.readOnlyFalse + catalog.readOnlyHintMissing + catalog.readOnlyHintInvalid, catalog.tools);

  fs.writeFileSync(path.join(root, "src", "queue.mjs"), "export const enqueue = (items, value) => items.concat(value);\n");
  const staleBefore = treeDigest(root);
  const stale = await measureContextDiagnostics({ project: root, task, iterations: 1 });
  assert.equal(stale.contextPreview.samples[0].worldState, "stale-excluded");
  assert.equal(stale.contextPreview.samples[0].repositoryRecordCount, 0);
  assert.deepEqual(treeDigest(root), staleBefore);
  assert.equal(stale.contextPreview.repeatedCalls.p95Ms, null);
});

test("diagnostics reject malformed requests before preview and restore instrumentation on failure", async () => {
  for (const iterations of [0, 21, 1.5, NaN]) await assert.rejects(() => measureContextDiagnostics({ iterations }), /iterations/);
  await assert.rejects(() => measureContextDiagnostics({ project: "." }), /both --project and --task/);
  await assert.rejects(() => measureContextDiagnostics({ task: "a task" }), /both --project and --task/);
  const originalRead = fs.readFileSync;
  const originalWrite = fs.writeFileSync;
  await assert.rejects(() => measureContextDiagnostics({ project: path.join(os.tmpdir(), "no-head-diagnostic-project"), task: "Inspect queue", iterations: 1 }));
  assert.equal(fs.readFileSync, originalRead);
  assert.equal(fs.writeFileSync, originalWrite);
});

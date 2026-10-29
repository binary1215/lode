import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { prepareSourceContext } from "../scripts/lib/source-context-workflow.mjs";
import { readSourceObservation } from "../scripts/lib/source-observation.mjs";
import { indexProjectGraph, queryProjectGraph } from "../scripts/lib/project-graph.mjs";
import { refreshWorldModel } from "../scripts/lib/incremental-refresh.mjs";
import { buildWorldModel, readWorldModel } from "../scripts/lib/world-model.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");

function fixture(t, world = false) {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const root = fs.realpathSync(fs.mkdtempSync(path.join(temporaryRoot, "head-graph-maintenance-")));
  t.after(() => {
    // Validate the exact owned temporary target before recursive cleanup.
    assert.equal(path.dirname(root), temporaryRoot);
    assert.ok(path.basename(root).startsWith("head-graph-maintenance-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const layout = inspectProject(root).storage;
  fs.mkdirSync(path.join(root, "src"));
  if (world) {
    // Synthetic existing Canon fixture, not a runtime promotion/approval.
    write(root, `${layout.directory}/context/product-model.json`, JSON.stringify({
      schemaVersion: 1,
      featureGroups: [{ key: "greeting", name: "Greeting", description: "Present a greeting." }],
      capabilities: [{ key: "formatting", name: "Formatting", description: "Format text." }],
      features: [{ key: "welcome", name: "Welcome", description: "Welcome a reader.",
        featureGroupKeys: ["greeting"], capabilityKeys: ["formatting"], governedBy: [] }],
      requirements: [], constraints: [], decisions: [],
    }));
  }
  return { root, layout };
}

function write(root, relative, text) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}

function authorityBytes(root, layout) {
  const result = {};
  function capture(relative) {
    const target = path.join(root, relative);
    if (!fs.existsSync(target)) return;
    if (fs.statSync(target).isDirectory()) {
      for (const entry of fs.readdirSync(target).sort()) capture(`${relative}/${entry}`);
    } else result[relative] = fs.readFileSync(target).toString("base64");
  }
  for (const relative of [`${layout.directory}/project.json`, `${layout.directory}/sessions`, `${layout.directory}/project-direction`,
    `${layout.directory}/context/product-model.json`, `${layout.directory}/lineage`, `${layout.directory}/onboarding`, `${layout.directory}/product-policy`]) capture(relative);
  assert.ok(Object.hasOwn(result, `${layout.directory}/project.json`));
  assert.ok(Object.hasOwn(result, `${layout.directory}/sessions/current.json`));
  return result;
}

function relation(graph, type, fromPath, targetName) {
  return graph.edges.find(edge => edge.type === type
    && graph.nodes.find(node => node.id === edge.from)?.path === fromPath
    && graph.nodes.find(node => node.id === edge.to)?.name === targetName);
}

test("Core-only retained originals reuse indexing without World, Canon or recovery ceremony", async t => {
  const { root, layout } = fixture(t);
  write(root, "src/greeting.mjs", "export function greeting() { return 'Hello'; }\n");
  write(root, "purpose.md", "Purpose: greet the reader. Proposed refinement, not approved Canon.\n");
  const before = authorityBytes(root, layout);
  const first = await prepareSourceContext({ root, task: "Inspect greeting and its purpose", retain: true,
    needs: [{ kind: "source", path: "src/greeting.mjs" }, { kind: "source", path: "purpose.md" }] });
  assert.equal(first.status, "observed");
  assert.equal(indexProjectGraph({ root }).status, "reused");
  const projectId = inspectProject(root).project.projectId;
  const original = first.results[0];
  const graph = await queryProjectGraph({ root, anchorIds: [original.observationId], depth: 0 });
  assert.ok(graph.nodes.some(node => node.nodeId === original.observationId));
  for (const field of ["instructionAuthority", "promotionAuthority", "recoveryAuthority", "executionAuthority", "ordinaryWorkBlocked"]) {
    assert.equal(graph.authority[field], false);
  }
  write(root, "src/greeting.mjs", "export function greeting() { return 'Welcome'; }\n");
  assert.throws(() => readSourceObservation(root, projectId, original.bundleKey, { storage: layout }), { code: "SOURCE_DRIFT" });
  assert.equal(readSourceObservation(root, projectId, original.bundleKey, { requireCurrent: false, storage: layout }).observation.observationId,
    original.observationId);
  const current = await prepareSourceContext({ root, task: "Inspect changed greeting", retain: true,
    needs: [{ kind: "source", path: "src/greeting.mjs" }] });
  assert.equal(current.status, "observed");
  assert.notEqual(current.results[0].sourceDigest, original.sourceDigest);
  assert.equal(indexProjectGraph({ root }).status, "reused");
  (await assert.rejects(async () => (await readWorldModel({ root })), { code: "WORLD_MODEL_NOT_BUILT" }));
  assert.deepEqual(authorityBytes(root, layout), before);
});

test("HEAD refreshes integrated additions and changed code, reusing unchanged callers without inventing PASS or meaning", async t => {
  const { root, layout } = fixture(t, true);
  write(root, "src/greeting.mjs", "export function greeting() { return 'Hello'; }\n");
  write(root, "src/app.mjs", "import { greeting } from './greeting.mjs';\nexport function render() { return greeting(); }\n");
  await buildWorldModel({ root });
  const before = authorityBytes(root, layout);
  // Two independently owned contributions reconciled by HEAD in one checkout.
  write(root, "src/greeting.mjs", "export function greeting() { return 'Welcome'; }\nexport function farewell() { return 'Bye'; }\n");
  write(root, "test/farewell.test.mjs", "import { farewell } from '../src/greeting.mjs';\nexport function verifiesFarewell() { return farewell() === 'Bye'; }\n");
  write(root, "purpose.md", "Proposed farewell purpose: end a conversation. Implementation: src/greeting.mjs#farewell. Verification: test/farewell.test.mjs; execution not yet claimed.\n");
  const refreshed = await refreshWorldModel({ root });
  assert.equal(refreshed.status, "refreshed");
  const scan = refreshed.diagnostics.repositoryScan;
  assert.ok(scan.reusedPaths.includes("src/app.mjs"));
  assert.ok(scan.analyzedPaths.includes("src/greeting.mjs"));
  assert.ok(scan.changes.added.includes("test/farewell.test.mjs"));
  const graph = (await readWorldModel({ root })).snapshot.semanticGraph;
  const call = relation(graph, "CALLS", "src/app.mjs", "greeting");
  assert.ok(call);
  assert.equal(call.confidence, "heuristic");
  assert.ok(relation(graph, "CALLS", "test/farewell.test.mjs", "farewell"));
  assert.ok(graph.nodes.some(node => node.path === "test/farewell.test.mjs" && node.classification === "test"));
  // Discovering a test never executes it or creates approval/result/checkpoint records.
  assert.deepEqual(authorityBytes(root, layout), before);
  const check = await import(pathToFileURL(path.join(root, "test/farewell.test.mjs")).href);
  assert.equal(check.verifiesFarewell(), true);
  const basis = ["src/greeting.mjs", "test/farewell.test.mjs"].map(relative =>
    `${relative}: ${crypto.createHash("sha256").update(fs.readFileSync(path.join(root, relative))).digest("hex")}`).join("\n");
  write(root, "verification.md", `Actual synthetic check under node --test test/graph-update-guidance.test.mjs: imported test/farewell.test.mjs and asserted verifiesFarewell() === true after the integrated refresh; PASS for this exact temporary fixture only.\n${basis}\n`);
  const retained = await prepareSourceContext({ root, task: "Retain original purpose and actual verification", retain: true,
    needs: [{ kind: "source", path: "purpose.md" }, { kind: "source", path: "verification.md" }] });
  assert.equal(retained.status, "observed");
  // World changes may require reconciling more than source persistence hooks updated.
  assert.equal(indexProjectGraph({ root }).ordinaryWorkBlocked, false);
  assert.equal(indexProjectGraph({ root }).status, "reused");
  for (const original of retained.results) {
    const evidence = await queryProjectGraph({ root, anchorIds: [original.observationId], depth: 0 });
    assert.ok(evidence.nodes.some(node => node.nodeId === original.observationId));
    assert.equal(evidence.authority.promotionAuthority, false);
    assert.equal(evidence.authority.recoveryAuthority, false);
  }
  assert.deepEqual(authorityBytes(root, layout), before);
});

test("Rename/delete recomputes unchanged importers; failed refresh leaves source fallback and independent work usable", async t => {
  const { root, layout } = fixture(t, true);
  write(root, "src/old.mjs", "export function greeting() { return 'Hello'; }\n");
  write(root, "src/app.mjs", "import { greeting } from './old.mjs';\nexport function render() { return greeting(); }\n");
  await buildWorldModel({ root });
  const before = authorityBytes(root, layout);
  const previous = (await readWorldModel({ root })).snapshot;
  fs.unlinkSync(path.join(root, "src/old.mjs"));
  write(root, "src/new.mjs", "export function salute() { return 'Hello'; }\n");
  const renamed = await refreshWorldModel({ root });
  assert.ok(renamed.diagnostics.repositoryScan.changes.removed.includes("src/old.mjs"));
  assert.ok(renamed.diagnostics.repositoryScan.changes.added.includes("src/new.mjs"));
  assert.ok(renamed.diagnostics.repositoryScan.reusedPaths.includes("src/app.mjs"));
  const unresolved = (await readWorldModel({ root })).snapshot;
  assert.equal(unresolved.semanticGraph.nodes.some(node => node.path === "src/old.mjs"), false);
  assert.ok(unresolved.semanticGraph.summary.unresolvedImportCount > 0);
  assert.equal(Boolean(relation(unresolved.semanticGraph, "CALLS", "src/app.mjs", "greeting")), false);
  assert.ok(previous.semanticGraph.nodes.some(node => node.path === "src/old.mjs"));
  write(root, "src/app.mjs", "import { salute } from './new.mjs';\nexport function render() { return salute(); }\n");
  // Deliberately wrong EXACT expectation, not a changed-files-only selection.
  await assert.rejects(refreshWorldModel({ root, expectedChangedPaths: ["src/not-changed.mjs"] }),
    { code: "REFRESH_CHANGE_EXPECTATION_MISMATCH" });
  assert.equal((await readWorldModel({ root })).snapshot.worldModelId, unresolved.worldModelId);
  const fallback = await prepareSourceContext({ root, task: "Inspect current importer while World is unrefreshed",
    needs: [{ kind: "source", path: "src/app.mjs" }] });
  assert.equal(fallback.status, "observed");
  write(root, "independent.md", "Independent investigation continues from current originals.\n");
  assert.ok(fs.readFileSync(path.join(root, "independent.md"), "utf8"));
  const recovered = await refreshWorldModel({ root });
  assert.equal(recovered.status, "refreshed");
  assert.ok(relation((await readWorldModel({ root })).snapshot.semanticGraph, "CALLS", "src/app.mjs", "salute"));
  assert.deepEqual(authorityBytes(root, layout), before);
});

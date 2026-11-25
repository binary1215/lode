import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { buildWorldModel, captureWorldMarkdownChanges, materializeWorldMarkdownProjection, readWorldModel } from "../scripts/lib/world/world-model.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");

// Capture published Markdown edits `captures` times. Page A (index.md) is edited
// once before the first capture and then left alone, so every capture proposes
// the same candidate for it; page B is edited again before each capture.
async function recaptured(t, captures) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lode-document-recapture-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "service.mjs"), "export function deliver() { return true; }\n");
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const layout = inspectProject(root).storage;
  await buildWorldModel({ root });
  await materializeWorldMarkdownProjection({ root });
  const knowledge = path.join(root, layout.directory, "generated/knowledge");
  const pageB = path.join(
    knowledge,
    "nodes",
    fs.readdirSync(path.join(knowledge, "nodes")).find((name) => name.startsWith("file-")),
  );
  fs.appendFileSync(path.join(knowledge, "index.md"), "\nEdit of page A, once.\n");
  const sets = [];
  for (let capture = 1; capture <= captures; capture += 1) {
    fs.appendFileSync(pageB, `\nEdit ${capture} of page B.\n`);
    sets.push((await captureWorldMarkdownChanges({ root, persist: true })).candidateSet);
  }
  return { root, sets };
}

function documentChangeView(snapshot) {
  const graph = snapshot.temporalProvenanceGraph;
  const nodes = graph.nodes.filter((node) => node.kind === "DocumentChangeCandidate");
  const contains = (setId, candidateId) => graph.edges.some((edge) => edge.type === "CONTAINS" && edge.from === setId && edge.to === candidateId);
  return { summary: graph.summary, nodes, contains };
}

for (const captures of [2, 3]) {
  test(`${captures} captures sharing an unchanged page build a World whose candidate count is the node count`, async (t) => {
    const { root, sets } = await recaptured(t, captures);
    const shared = sets[0].candidates.find((candidate) => candidate.relativePath === "index.md").candidateId;
    for (const set of sets)
      assert.ok(
        set.candidates.some((candidate) => candidate.candidateId === shared),
        "the unchanged page keeps its candidate id",
      );
    const distinct = new Set(sets.flatMap((set) => set.candidates.map((candidate) => candidate.candidateId)));
    assert.equal(distinct.size, captures + 1, "one shared page A candidate and one page B candidate per capture");

    await buildWorldModel({ root });
    const { snapshot } = await readWorldModel({ root });
    const view = documentChangeView(snapshot);
    assert.equal(view.summary.documentChangeCandidateSetCount, captures);
    assert.equal(view.summary.documentChangeCandidateCount, distinct.size);
    assert.equal(view.summary.documentChangeCandidateCount, view.nodes.length);
    assert.deepEqual(view.nodes.map((node) => node.nodeId).sort(), [...distinct].sort());
    for (const set of sets)
      for (const candidate of set.candidates) assert.ok(view.contains(set.candidateSetId, candidate.candidateId), "every set keeps its own CONTAINS edge");

    // A later build on the same records keeps working (the reported failure hit every later build).
    await buildWorldModel({ root });
    assert.equal((await readWorldModel({ root })).snapshot.temporalProvenanceGraph.summary.documentChangeCandidateCount, distinct.size);
  });
}

test("a World with one capture counts its candidates as before (sum of the set equals the distinct count)", async (t) => {
  const { root, sets } = await recaptured(t, 1);
  await buildWorldModel({ root });
  const { snapshot } = await readWorldModel({ root });
  const view = documentChangeView(snapshot);
  const previousCount = sets.reduce((count, set) => count + set.candidates.length, 0);
  assert.equal(previousCount, 2);
  assert.equal(view.summary.documentChangeCandidateSetCount, 1);
  assert.equal(view.summary.documentChangeCandidateCount, previousCount);
  assert.equal(view.summary.documentChangeCandidateCount, view.nodes.length);
});

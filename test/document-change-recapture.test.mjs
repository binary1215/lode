import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { buildWorldModel, captureWorldMarkdownChanges, inspectWorldModel, materializeWorldMarkdownProjection } from "../scripts/lib/world/world-model.mjs";
import { applyDocumentChangeReview, inspectDocumentChangeReviewStatus, reviewDocumentChanges } from "../scripts/lib/world/document-change-review.mjs";
import { readProductModelCanon } from "../scripts/lib/world/product-model.mjs";

// Capturing edits of the same published Markdown more than once is ordinary use. A page that did not
// change between two captures gets the same candidate id in both sets. Every later step works on the
// latest set; earlier unreviewed sets stay as they are.

const pluginRoot = path.resolve(import.meta.dirname, "..");
const model = (description) => ({
  schemaVersion: 1,
  featureGroups: [],
  capabilities: [{ key: "delivery", name: "Delivery", description }],
  features: [],
  requirements: [],
  constraints: [],
  decisions: [],
});

async function recaptured(t, captures) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lode-document-recapture-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "service.mjs"), "export function deliver() { return true; }\n");
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const layout = inspectProject(root).storage;
  await buildWorldModel({ root });
  await materializeWorldMarkdownProjection({ root });
  const knowledge = path.join(root, layout.directory, "generated", "knowledge");
  const pageA = path.join(knowledge, "index.md");
  const pageB = path.join(
    knowledge,
    "nodes",
    fs.readdirSync(path.join(knowledge, "nodes")).find((name) => name.startsWith("file-")),
  );
  fs.appendFileSync(pageA, "\nEdit of page A, once.\n");
  const sets = [];
  for (let index = 1; index <= captures; index++) {
    fs.appendFileSync(pageB, `\nEdit ${index} of page B.\n`);
    sets.push((await captureWorldMarkdownChanges({ root, persist: true })).candidateSet);
  }
  const shared = sets[0].candidates.find((candidate) => candidate.relativePath === "index.md");
  assert.ok(shared, "page A candidate");
  for (const set of sets) {
    assert.equal(set.candidates.length, 2);
    assert.ok(
      set.candidates.some((candidate) => candidate.candidateId === shared.candidateId),
      "unchanged page A keeps one candidate id in every set",
    );
  }
  assert.equal(new Set(sets.map((set) => set.candidateSetId)).size, captures);
  return { root, layout, sets, latest: sets.at(-1), shared, pageB };
}

function cli(...args) {
  const result = spawnSync(process.execPath, [path.join(pluginRoot, "scripts", "lode.mjs"), ...args], { encoding: "utf8", windowsHide: true });
  const text = `${result.stdout}${result.stderr}`;
  let json = null;
  if (args.includes("--json")) json = JSON.parse(result.stdout);
  return { status: result.status, text, json };
}

async function assertWorldBuilds(root) {
  const index = cli("world-index", root, "--json");
  assert.equal(index.status, 0, index.text);
  await buildWorldModel({ root });
  assert.equal((await inspectWorldModel({ root })).status, "current");
}

async function assertEarlierSetsStayUnreviewable(root, sets) {
  for (const earlier of sets.slice(0, -1)) {
    assert.equal((await inspectDocumentChangeReviewStatus({ root, candidateSetId: earlier.candidateSetId })).status, "awaiting-review");
    assert.equal(cli("world-docs-candidates", root, "--candidate-set", earlier.candidateSetId, "--json").status, 0);
    for (const request of [{ disposition: "reject" }, { disposition: "accept-all", resultingProductModel: model("Late.") }]) {
      await assert.rejects(reviewDocumentChanges({ root, candidateSetId: earlier.candidateSetId, rationale: "Late.", ...request }), {
        code: "DOCUMENT_CHANGE_CANDIDATE_BASE_DRIFT",
      });
    }
  }
}

test("two captures without any review keep the World buildable", async (t) => {
  const { root, sets } = await recaptured(t, 2);
  await assertWorldBuilds(root);
  for (const set of sets) assert.equal((await inspectDocumentChangeReviewStatus({ root, candidateSetId: set.candidateSetId })).status, "awaiting-review");
  const status = cli("status", root);
  assert.equal(status.status, 0, status.text);
});

for (const captures of [2, 3]) {
  test(`${captures} captures: accept-all on the latest set applies, and the status reads follow it`, async (t) => {
    const { root, sets, latest } = await recaptured(t, captures);
    await assertWorldBuilds(root);
    const applied = await reviewDocumentChanges({
      root,
      candidateSetId: latest.candidateSetId,
      disposition: "accept-all",
      rationale: "Adopt.",
      resultingProductModel: model("Deliver a message."),
    });
    assert.equal(applied.status, "applied");
    const status = await inspectDocumentChangeReviewStatus({ root, candidateSetId: latest.candidateSetId });
    assert.equal(status.status, "applied");
    assert.equal(status.projectionsReady, true);
    const viaCli = cli("world-docs-review-status", root, "--candidate-set", latest.candidateSetId, "--json");
    assert.equal(viaCli.status, 0, viaCli.text);
    assert.equal(viaCli.json.status, "applied");
    assert.equal(cli("world-docs-review-read", root, "--review", status.reviewDecisionId, "--json").status, 0);
    assert.equal(cli("world-docs-application-read", root, "--application", status.applicationReceiptId, "--json").status, 0);
    assert.equal(cli("world-docs-status", root, "--json").json.status, "current");
    await assertWorldBuilds(root);
    assert.equal(
      (
        await reviewDocumentChanges({
          root,
          candidateSetId: latest.candidateSetId,
          disposition: "accept-all",
          rationale: "Adopt.",
          resultingProductModel: model("Deliver a message."),
        })
      ).status,
      "already-applied",
    );
    await assertEarlierSetsStayUnreviewable(root, sets);
    await assertWorldBuilds(root);
  });
}

test("accept-selection naming only the shared candidate applies on the latest of three captures", async (t) => {
  const { root, sets, latest, shared } = await recaptured(t, 3);
  const result = await reviewDocumentChanges({
    root,
    candidateSetId: latest.candidateSetId,
    disposition: "accept-selection",
    acceptedCandidateIds: [shared.candidateId],
    rationale: "Adopt page A only.",
    resultingProductModel: model("Deliver a message."),
  });
  assert.equal(result.status, "applied");
  assert.deepEqual(result.reviewDecision.acceptedCandidateIds, [shared.candidateId]);
  assert.equal(result.reviewDecision.rejectedCandidateIds.length, 1);
  assert.equal((await inspectDocumentChangeReviewStatus({ root, candidateSetId: latest.candidateSetId })).status, "applied");
  await assertWorldBuilds(root);
  await assertEarlierSetsStayUnreviewable(root, sets);
});

test("reject on the latest of two captures reconciles and leaves Canon unchanged", async (t) => {
  const { root, layout, sets, latest, pageB } = await recaptured(t, 2);
  const canon = readProductModelCanon({ storage: layout, projectRoot: root }).model.productModelId;
  const result = await reviewDocumentChanges({ root, candidateSetId: latest.candidateSetId, disposition: "reject", rationale: "Keep the pages as built." });
  assert.equal(result.status, "rejected-and-reconciled");
  assert.equal(readProductModelCanon({ storage: layout, projectRoot: root }).model.productModelId, canon);
  assert.doesNotMatch(fs.readFileSync(pageB, "utf8"), /Edit \d of page B/);
  assert.equal((await inspectDocumentChangeReviewStatus({ root, candidateSetId: latest.candidateSetId })).status, "rejected-and-reconciled");
  await assertWorldBuilds(root);
  await assertEarlierSetsStayUnreviewable(root, sets);
});

test("an earlier set reviewed while a later set exists is refused; the latest set still applies", async (t) => {
  const { root, sets, latest } = await recaptured(t, 2);
  await assert.rejects(
    reviewDocumentChanges({ root, candidateSetId: sets[0].candidateSetId, disposition: "accept-all", rationale: "First.", resultingProductModel: model("v1") }),
    { code: "DOCUMENT_CHANGE_CANDIDATE_PUBLISHED_DRIFT" },
  );
  assert.equal(
    fs.readdirSync(path.join(root, inspectProject(root).storage.directory, "document-changes")).includes("review-decisions"),
    false,
    "no decision saved",
  );
  const result = await reviewDocumentChanges({
    root,
    candidateSetId: latest.candidateSetId,
    disposition: "accept-all",
    rationale: "Second.",
    resultingProductModel: model("v2"),
  });
  assert.equal(result.status, "applied");
});

// The state an older Lode left after a second capture: the ReviewDecision and the application basis
// are saved and Product Canon is published, then the World build failed before anything else was
// written. Ending the process right after the Canon publication leaves exactly those records.
function stopAfterCanonPublication(root, reviewDecisionId, layout) {
  const source = `
    import fs from 'node:fs'; import path from 'node:path';
    import {syncBuiltinESMExports} from 'node:module';
    const root=${JSON.stringify(root)}, management=${JSON.stringify(layout.directory)};
    const rename=fs.renameSync;
    fs.renameSync=function(from,to){ const result=rename.apply(this,arguments);
      if(path.relative(root,String(to)).replaceAll('\\\\','/')===management+'/context/product-model.json')process.exit(44);
      return result;}; syncBuiltinESMExports();
    const {applyDocumentChangeReview}=await import(${JSON.stringify(new URL("../scripts/lib/world/document-change-review.mjs", import.meta.url).href)});
    await applyDocumentChangeReview({root,reviewDecisionId:${JSON.stringify(reviewDecisionId)}});
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { cwd: pluginRoot, encoding: "utf8", timeout: 60000, windowsHide: true });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 44, result.stderr);
}

test("a Project left with Canon applied and projection pending completes with world-docs-apply alone", async (t) => {
  const { root, layout, sets, latest } = await recaptured(t, 2);
  const reviewed = await reviewDocumentChanges({
    root,
    candidateSetId: latest.candidateSetId,
    disposition: "accept-all",
    rationale: "Adopt.",
    resultingProductModel: model("Deliver a message."),
    apply: false,
  });
  const reviewDecisionId = reviewed.reviewDecision.reviewDecisionId;
  stopAfterCanonPublication(root, reviewDecisionId, layout);
  const changes = path.join(root, layout.directory, "document-changes");
  assert.deepEqual(fs.readdirSync(path.join(changes, "application-bases")), [`${reviewDecisionId}.json`]);
  assert.equal(fs.existsSync(path.join(changes, "applications")) && fs.readdirSync(path.join(changes, "applications")).length > 0, false);
  assert.equal(readProductModelCanon({ storage: layout, projectRoot: root }).model.productModelId, reviewed.reviewDecision.resultingProductModelId);
  assert.equal((await inspectDocumentChangeReviewStatus({ root, candidateSetId: latest.candidateSetId })).status, "canon-applied-projection-pending");
  const before = new Map(
    fs
      .readdirSync(changes, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => [path.join(entry.parentPath, entry.name), fs.readFileSync(path.join(entry.parentPath, entry.name))]),
  );

  const applied = cli("world-docs-apply", root, "--review", reviewDecisionId, "--json");
  assert.equal(applied.status, 0, applied.text);
  assert.equal(applied.json.status, "applied");
  for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(file), bytes, `${file} unchanged`);
  const status = await inspectDocumentChangeReviewStatus({ root, candidateSetId: latest.candidateSetId });
  assert.equal(status.status, "applied");
  assert.equal(status.projectionsReady, true);
  await assertWorldBuilds(root);
  assert.equal(cli("world-docs-apply", root, "--review", reviewDecisionId, "--json").json.status, "already-applied");
  assert.equal((await applyDocumentChangeReview({ root, reviewDecisionId })).status, "already-applied");
  await assertEarlierSetsStayUnreviewable(root, sets);
});

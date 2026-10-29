import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { buildWorldModel, materializeWorldMarkdownProjection, captureWorldMarkdownChanges, inspectWorldModel } from "../scripts/lib/world-model.mjs";
import { applyDocumentChangeReview, reviewDocumentChanges, inspectDocumentChangeReviewStatus } from "../scripts/lib/document-change-review.mjs";
import { readProductModelCanon } from "../scripts/lib/product-model.mjs";
import crypto from "node:crypto";
import { recordSessionWorkEvidence, readSessionWorkContext } from "../scripts/lib/session-work-context.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
async function fixture(disposition = "accept-all") {
  const root = fs.mkdtempSync(path.join(pluginRoot, ".qa-document-recovery-"));
  fs.writeFileSync(path.join(root, "service.mjs"), "export function deliver() { return true; }\n");
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const layout = inspectProject(root).storage;
  await buildWorldModel({ root });
  (await materializeWorldMarkdownProjection({ root }));
  fs.appendFileSync(path.join(root, layout.directory, "generated/knowledge/index.md"), "\nReviewed proposal: message delivery.\n");
  const captured = (await captureWorldMarkdownChanges({ root, persist: true }));
  const request = { root, candidateSetId: captured.candidateSet.candidateSetId, disposition: "accept-all", rationale: "Adopt the reviewed delivery capability.",
    resultingProductModel: { schemaVersion: 1, featureGroups: [], capabilities: [{ key: "delivery", name: "Delivery", description: "Deliver a message." }], features: [], requirements: [], constraints: [], decisions: [] } };
  if (disposition === "reject") { request.disposition = "reject"; delete request.resultingProductModel; }
  const reviewed = await reviewDocumentChanges({ ...request, apply: false });
  return { root, layout, request, review: reviewed.reviewDecision };
}

test("final gap: existing document-change revision family remains citable with its own hash verifier", async () => {
  const { root, layout, review } = await fixture();
  try {
    await applyDocumentChangeReview({ root, reviewDecisionId: review.reviewDecisionId });
    const relative = `${layout.directory}/document-changes/product-model-revisions/${review.resultingProductModelId}.json`;
    const file = path.join(root, relative), bytes = fs.readFileSync(file), stat = fs.statSync(file), hash = value => crypto.createHash("sha256").update(value).digest("hex");
    const revision = JSON.parse(bytes);
    assert.equal(revision.authority, "explicit-user-reviewed-product-canon-revision"); assert.ok(revision.revisionHash);
    const saved = recordSessionWorkEvidence({ root, input: { references: [{ path: relative, digest: hash(bytes), kind: "artifact" }] } });
    const read = readSessionWorkContext({ root, evidenceIds: [saved.evidence.evidenceId], maxRecords: 1 });
    assert.equal(read.records[0].references[0].status, "intact-retained-original");
    assert.equal(read.records[0].references[0].originalOwner.projectId, inspectProject(root).project.projectId);
    assert.equal(read.records[0].references[0].instructionAuthority, false);
    const corrupt = { ...revision, revisionHash: "0".repeat(64) }, corruptBytes = Buffer.from(JSON.stringify(corrupt));
    fs.writeFileSync(path.join(root, "forged-document-revision.json"), corruptBytes);
    assert.throws(() => recordSessionWorkEvidence({ root, input: { references: [{ path: "forged-document-revision.json", digest: hash(corruptBytes), kind: "artifact" }] } }), { code: "DOCUMENT_CHANGE_PRODUCT_REVISION_DIGEST_MISMATCH" });
    assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(fs.statSync(file).mode, stat.mode); assert.equal(fs.statSync(file).mtimeMs, stat.mtimeMs);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function crash(root, reviewDecisionId, boundary, layout) {
  const source = `
    import fs from 'node:fs'; import path from 'node:path';
    import {syncBuiltinESMExports} from 'node:module';
    const root=${JSON.stringify(root)}, boundary=${JSON.stringify(boundary)}, management=${JSON.stringify(layout.directory)};
    process.stderr.write(JSON.stringify({event:'started',pid:process.pid,parentPid:process.ppid,command:process.execPath+' document-crash '+boundary,cwd:process.cwd(),ports:[]})+'\\n');
    const rename=fs.renameSync; let worlds=0;
    fs.renameSync=function(from,to){ const result=rename.apply(this,arguments); const name=path.relative(root,String(to)).replaceAll('\\\\','/');
      if(name===management+'/world-model/current.json')worlds++;
      if(boundary==='canon'&&name===management+'/context/product-model.json'
        ||boundary==='markdown'&&name.startsWith(management+'/generated/knowledge/')
        ||boundary==='receipt'&&name.startsWith(management+'/document-changes/applications/')
        ||boundary==='audit-world'&&name===management+'/world-model/current.json'&&worlds===2)process.exit(44);
      return result;}; syncBuiltinESMExports();
    const {applyDocumentChangeReview}=await import(${JSON.stringify(new URL("../scripts/lib/document-change-review.mjs", import.meta.url).href)});
    await applyDocumentChangeReview({root,reviewDecisionId:${JSON.stringify(reviewDecisionId)}});
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { cwd: pluginRoot, encoding: "utf8", timeout: 45000, windowsHide: true });
  process.stderr.write(result.stderr || "");
  process.stderr.write(`${JSON.stringify({ event: "closed", pid: result.pid, exitCode: result.status, ports: [] })}\n`);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 44, result.stderr);
}

test("durable document approval resumes actual Canon, partial Markdown, receipt and audit crashes", async () => {
  for (const boundary of ["canon", "markdown", "receipt", "audit-world", "legacy-canon"]) {
    const { root, layout, request, review } = await fixture();
    try {
      const p2 = fs.readFileSync(path.join(root, layout.directory, "sessions/current.json"));
      crash(root, review.reviewDecisionId, boundary === "legacy-canon" ? "canon" : boundary, layout);
      const canon = fs.readFileSync(path.join(root, layout.directory, "context/product-model.json"));
      assert.equal(readProductModelCanon({ projectRoot: root, storage: layout }).model.productModelId, review.resultingProductModelId);
      if (boundary === "legacy-canon") {
        fs.unlinkSync(path.join(root, layout.directory, "document-changes/application-bases", `${review.reviewDecisionId}.json`));
        await buildWorldModel({ root });
      }
      process.stderr.write(`${JSON.stringify({ boundary, changes: (await inspectWorldModel({ root })).changes })}\n`);
      const result = await applyDocumentChangeReview({ root, reviewDecisionId: review.reviewDecisionId });
      assert.ok(["applied", "already-applied"].includes(result.status));
      assert.deepEqual(fs.readFileSync(path.join(root, layout.directory, "context/product-model.json")), canon);
      assert.deepEqual(fs.readFileSync(path.join(root, layout.directory, "sessions/current.json")), p2);
      assert.equal((await inspectWorldModel({ root })).status, "current");
      assert.equal((await inspectDocumentChangeReviewStatus({ root, candidateSetId: request.candidateSetId })).projectionsReady, true);
      assert.equal((await reviewDocumentChanges(request)).status, "already-applied");
      assert.equal(fs.readdirSync(path.join(root, layout.directory, "document-changes/review-decisions")).length, 1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("document recovery preserves later user edits and never rolls approved Canon back", async () => {
  const { root, layout, review } = await fixture();
  try {
    crash(root, review.reviewDecisionId, "markdown", layout);
    const file = path.join(root, layout.directory, "generated/knowledge/index.md");
    fs.appendFileSync(file, "\nLater user edit must survive.\n");
    const edited = fs.readFileSync(file);
    const canon = fs.readFileSync(path.join(root, layout.directory, "context/product-model.json"));
    await assert.rejects(() => applyDocumentChangeReview({ root, reviewDecisionId: review.reviewDecisionId }), { code: "DOCUMENT_CHANGE_CANDIDATE_PUBLISHED_DRIFT" });
    assert.deepEqual(fs.readFileSync(file), edited);
    assert.deepEqual(fs.readFileSync(path.join(root, layout.directory, "context/product-model.json")), canon);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("durable reject resumes partial publication before and after receipt without another approval", async () => {
  for (const boundary of ["markdown", "receipt", "legacy-markdown", "later-edit"]) {
    const { root, layout, request, review } = await fixture("reject");
    try {
      const canon = fs.readFileSync(path.join(root, layout.directory, "context/product-model.json"));
      const p2 = fs.readFileSync(path.join(root, layout.directory, "sessions/current.json"));
      crash(root, review.reviewDecisionId, boundary === "receipt" ? "receipt" : "markdown", layout);
      if (boundary === "legacy-markdown") fs.unlinkSync(path.join(root, layout.directory, "document-changes/application-bases", `${review.reviewDecisionId}.json`));
      if (boundary === "later-edit") {
        const file = path.join(root, layout.directory, "generated/knowledge/index.md");
        fs.appendFileSync(file, "\nLater edit stays.\n");
        const edited = fs.readFileSync(file);
        await assert.rejects(() => applyDocumentChangeReview({ root, reviewDecisionId: review.reviewDecisionId }), { code: "DOCUMENT_CHANGE_CANDIDATE_PUBLISHED_DRIFT" });
        assert.deepEqual(fs.readFileSync(file), edited);
      } else {
        await applyDocumentChangeReview({ root, reviewDecisionId: review.reviewDecisionId });
        assert.equal((await inspectWorldModel({ root })).status, "current");
        assert.equal((await inspectDocumentChangeReviewStatus({ root, candidateSetId: request.candidateSetId })).projectionsReady, true);
      }
      assert.deepEqual(fs.readFileSync(path.join(root, layout.directory, "context/product-model.json")), canon);
      assert.deepEqual(fs.readFileSync(path.join(root, layout.directory, "sessions/current.json")), p2);
      assert.equal(fs.readdirSync(path.join(root, layout.directory, "document-changes/review-decisions")).length, 1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

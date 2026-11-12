import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { createHeadSession, withSessionRoute } from "../scripts/lib/session/session-routing.mjs";
import { recordSessionWorkEvidence, readSessionWorkEvidenceOwner } from "../scripts/lib/session/session-work-context.mjs";
import { updateProjectDirection } from "../scripts/lib/session/project-direction.mjs";
import { readWorkDocumentBasis, renderWorkDocument, resolveWorkDocumentLinks, workDocumentHash } from "../scripts/lib/world/work-document-source.mjs";
import { createSourceObservation, retainSourceObservation } from "../scripts/lib/world/source-observation.mjs";
import { createRecoveryCheckpoint } from "../scripts/lib/session/compaction-recovery.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lode-work-document-")));
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const sessionId = createHeadSession({ root, purpose: "Clarify sign-in expiration; no deployment" }).sessionId;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const save = (input) => withSessionRoute(root, sessionId, () => recordSessionWorkEvidence({ root, input })).evidence;
  return { root, sessionId, save };
}
test("Core-only exact originals -> stable human/agent facts; no authority, provider or completion inference", async (t) => {
  const { root, sessionId, save } = setup(t);
  updateProjectDirection({
    root,
    expectedDirectionId: null,
    input: {
      goal: "Local wording and tests only",
      constraints: ["No external deployment", "Do not retry network requests"],
      cancelledActions: ["Earlier wording withdrawn"],
    },
  });
  fs.writeFileSync(path.join(root, "local-test.log"), "Old revision: 175 checks passed. Current revision not executed.\n");
  const original = save({
    summary: "Expiry wording clarified; mobile review agreement is an author summary without original user quote.",
    judgments: [{ assessment: "Keep explicit expiry wording", reason: "Automatic retries can duplicate requests", alternatives: ["Retry silently"] }],
    observedWork: ["Updated the local explanation"],
    pending: ["Mobile manual test and deployment not executed"],
    unknowns: ["Specification hash matches but its version explanation contradicts later code", "Old test success is not a current-code test"],
    references: [{ path: "local-test.log", digest: workDocumentHash(fs.readFileSync(path.join(root, "local-test.log"))), kind: "source" }],
    todos: [
      {
        todoId: "todo-expiry",
        task: "Clarify expiry wording",
        status: "completed",
        origin: "user-directed",
        progress: "Local explanation saved; mobile untested",
      },
    ],
  });
  const selection = { root, sessionId, todoId: "todo-expiry", evidenceIds: [original.evidenceId] };
  const stateFile = path.join(root, readSessionWorkEvidenceOwner({ root, sessionId }).statePath);
  const before = fs.readFileSync(stateFile);
  const basis = await readWorkDocumentBasis(selection);
  assert.equal(basis.basisId, (await readWorkDocumentBasis(selection)).basisId);
  for (const audience of ["human", "agent"]) {
    const view = renderWorkDocument(basis, { audience, title: "Sign-in expiration" });
    for (const text of [
      "No external deployment",
      "Do not retry network requests",
      "Earlier wording withdrawn",
      "Automatic retries can duplicate requests",
      "Mobile manual test and deployment not executed",
      "Old test success is not a current-code test",
    ])
      assert.ok(view.markdown.includes(text));
    assert.ok(!view.markdown.includes(root));
    const notion = resolveWorkDocumentLinks(view, { peer: "https://www.notion.so/peer", start: "https://www.notion.so/start" });
    const vault = resolveWorkDocumentLinks(view, { peer: "agent.md", start: "start.md" });
    assert.notEqual(notion.payloadDigest, vault.payloadDigest);
    assert.equal(notion.viewId, vault.viewId);
    assert.ok(!notion.markdown.includes("lode-view:"));
  }
  assert.deepEqual(before, fs.readFileSync(stateFile));
});
test("manual work without Todos is readable; mixed tasks and wrong Session never silently merge", async (t) => {
  const { root, sessionId, save } = setup(t);
  const manual = save({ summary: "Compared options", observedWork: ["Read the original files"], unknowns: ["No test run"] });
  const selection = { root, sessionId, taskEvidenceId: manual.evidenceId, evidenceIds: [manual.evidenceId] };
  assert.ok(renderWorkDocument(await readWorkDocumentBasis(selection), { title: "Options" }).markdown.includes("No test run"));
  const other = createHeadSession({ root, purpose: "Same title, different owner" });
  await assert.rejects(readWorkDocumentBasis({ ...selection, sessionId: other.sessionId }), { code: "WORK_DOCUMENT_ORIGINAL_UNAVAILABLE" });
  const mixed = save({
    summary: "Mixed results",
    todos: [
      { todoId: "todo-a", task: "A", status: "completed", origin: "lode-proposed" },
      { todoId: "todo-b", task: "B", status: "completed", origin: "lode-proposed" },
    ],
  });
  await assert.rejects(readWorkDocumentBasis({ root, sessionId, todoId: "todo-a", evidenceIds: [mixed.evidenceId] }), {
    code: "WORK_DOCUMENT_SCOPE_AMBIGUOUS",
  });
});
test("reopen and conflicting revisions stay visible even when reading an old completed original", async (t) => {
  const { root, sessionId, save } = setup(t);
  const first = save({ observedWork: ["Local work saved"], todos: [{ todoId: "todo-a", task: "Task A", status: "completed", origin: "lode-proposed" }] });
  const prior = { evidenceId: first.evidenceId, evidenceDigest: first.evidenceDigest };
  save({
    pending: ["Reopened due to later correction"],
    todos: [{ todoId: "todo-a", task: "Task A", status: "partial", origin: "lode-proposed", prior, nextAction: "Correct the earlier report" }],
  });
  const basis = await readWorkDocumentBasis({ root, sessionId, todoId: "todo-a", evidenceIds: [first.evidenceId] });
  assert.equal(basis.taskState.items[0].status, "partial");
  save({ todos: [{ todoId: "todo-a", task: "Task A", status: "cancelled", origin: "lode-proposed", prior, reason: "Cancelled separately" }] });
  const conflict = await readWorkDocumentBasis({ root, sessionId, todoId: "todo-a", evidenceIds: [first.evidenceId] });
  assert.equal(conflict.taskState.items[0].status, "conflict");
  assert.ok(renderWorkDocument(conflict, { title: "Task A" }).markdown.includes("conflict"));
});
test("retained exact before/after and selected log quotes; unrelated checkpoint is neither exported nor a basis change", async (t) => {
  const { root, sessionId, save } = setup(t),
    storage = inspectProject(root).storage;
  const observe = (text) => {
    fs.writeFileSync(path.join(root, "login.mjs"), text);
    retainSourceObservation(
      root,
      createSourceObservation(
        {
          version: 1,
          projectId: storage.projectId,
          kind: "source",
          query: [{ path: "login.mjs", symbol: "" }],
          sources: [{ path: "login.mjs", digest: workDocumentHash(text), base64: Buffer.from(text).toString("base64") }],
          profile: {},
          observedAt: "2026-01-01T00:00:00Z",
          response: null,
          envelopeHash: null,
        },
        storage,
      ),
      storage,
    );
    return { path: "login.mjs", digest: workDocumentHash(text), kind: "source" };
  };
  const first = save({
    summary: "Old wording",
    references: [observe("export const expiry = 'try again';\n")],
    todos: [{ todoId: "todo-expiry", task: "Clarify wording", status: "partial", nextAction: "Avoid suggesting retry", origin: "lode-proposed" }],
  });
  const second = save({
    summary: "Clarified without auto retry",
    observedWork: ["Changed the expiry literal"],
    references: [observe("export const expiry = 'sign in again';\n")],
    todos: [
      {
        todoId: "todo-expiry",
        task: "Clarify wording",
        status: "completed",
        origin: "lode-proposed",
        prior: { evidenceId: first.evidenceId, evidenceDigest: first.evidenceDigest },
      },
    ],
  });
  const selection = {
    root,
    sessionId,
    todoId: "todo-expiry",
    evidenceIds: [first.evidenceId, second.evidenceId],
    diffs: [{ before: { evidenceId: first.evidenceId, referenceIndex: 0 }, after: { evidenceId: second.evidenceId, referenceIndex: 0 } }],
    excerpts: [{ evidenceId: second.evidenceId, referenceIndex: 0, startLine: 1, endLine: 1 }],
  };
  const basis = await readWorkDocumentBasis(selection);
  assert.equal(basis.comparisons[0].status, "observed");
  assert.equal(basis.comparisons[0].sourceAvailability.before.reasonCode, "SESSION_WORK_REFERENCE_CHANGED");
  assert.equal(basis.quotations[0].status, "exact-byte-quotation");
  for (const audience of ["human", "agent"]) {
    const view = renderWorkDocument(basis, { audience, title: "Expiry" });
    assert.ok(view.markdown.includes("try again"));
    assert.ok(view.markdown.includes("sign in again"));
  }
  withSessionRoute(root, sessionId, () =>
    createRecoveryCheckpoint({
      root,
      purpose: "UNRELATED_CHECKPOINT_TASK_B",
      approvedDecisions: ["Unrelated historical operation"],
      currentPosition: "Do not export task B",
      nextExpectedResult: "Other work",
    }),
  );
  const next = await readWorkDocumentBasis(selection);
  assert.equal(next.basisId, basis.basisId);
  assert.ok(!renderWorkDocument(next, { title: "Expiry" }).markdown.includes("UNRELATED_CHECKPOINT_TASK_B"));
  fs.unlinkSync(path.join(root, "login.mjs"));
  // Retained exact bytes remain available; deleting that retained original later
  // must not cause a same-title/current-file substitution.
  const retained = await readWorkDocumentBasis(selection);
  assert.equal(retained.comparisons[0].status, "observed");
  assert.equal(retained.quotations[0].sourceBasis.kind, "retained-source-observation");
  assert.equal(retained.quotations[0].primaryReferenceFailure.reasonCode, "ENOENT");
});

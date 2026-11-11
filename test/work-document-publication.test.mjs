import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject } from "../scripts/lib/head-core.mjs";
import { createHeadSession, withSessionRoute } from "../scripts/lib/session-routing.mjs";
import { recordSessionWorkEvidence, readSessionWorkEvidenceOwner } from "../scripts/lib/session-work-context.mjs";
import { createSourceObservation, retainSourceObservation } from "../scripts/lib/source-observation.mjs";
import { queryProjectGraph } from "../scripts/lib/project-graph.mjs";
import { prepareWorkDocuments, publishWorkDocuments, configureWorkDocuments, workDocumentStatus } from "../scripts/lib/work-document-publication.mjs";
import { createNotionWorkDocumentAdapter, createBoundedNotionRequest } from "../scripts/lib/work-document-destinations.mjs";
import { workDocumentHash } from "../scripts/lib/work-document-source.mjs";
import { recordSessionWorkAndProjectDocuments } from "../scripts/lib/session-work-document-workflow.mjs";
import { workDocumentStore } from "../scripts/lib/work-document-store.mjs";
import { dispatch, operationCatalogTools as catalogTools } from "../scripts/mcp-server.mjs";
import { runCommand } from "../scripts/lode.mjs";
import { formatCliResult } from "../scripts/lib/cli-presentation.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
function setup(t) {
  const area = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lode-publication-")));
  const root = path.join(area, "project"),
    vault = path.join(area, "vault");
  fs.mkdirSync(root);
  fs.mkdirSync(vault);
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const sessionId = createHeadSession({ root, purpose: "Local sign-in wording; do not deploy" }).sessionId;
  t.after(() => fs.rmSync(area, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "result.log"), "Synthetic local test: passed; current revision only.\n");
  const save = (status = "completed", prior = null) =>
    withSessionRoute(root, sessionId, () =>
      recordSessionWorkEvidence({
        root,
        input: {
          summary: "Clarified expiry text; no automatic network retry",
          observedWork: ["Saved wording; inspected the exact local test log"],
          judgments: [{ assessment: "Keep no retry", reason: "Duplicate requests are possible", alternatives: [] }],
          pending: ["Mobile verification and deployment not executed"],
          unknowns: ["No original user quote for claimed mobile agreement"],
          references: [{ path: "result.log", digest: workDocumentHash(fs.readFileSync(path.join(root, "result.log"))), kind: "source" }],
          todos: [
            {
              todoId: "todo-expiry",
              task: "Clarify expiry",
              status,
              origin: "user-directed",
              ...(prior ? { prior: { evidenceId: prior.evidenceId, evidenceDigest: prior.evidenceDigest } } : {}),
              ...(["partial", "waiting"].includes(status)
                ? { nextAction: "Correct wording", reason: "A later correction is needed" }
                : status === "cancelled"
                  ? { reason: "Cancelled" }
                  : {}),
            },
          ],
        },
      }),
    ).evidence;
  const prepare = (evidence) => prepareWorkDocuments({ root, sessionId, todoId: "todo-expiry", evidenceIds: [evidence.evidenceId], title: "Expiry wording" });
  return { root, vault, sessionId, save, prepare };
}
function fakeNotion() {
  const parent = "10000000-0000-4000-8000-000000000001",
    pages = new Map(),
    calls = [];
  const fault = { lostCreate: false, denied: false, missingBody: false, asyncPatch: false, taskStatus: "succeeded", taskMissing: false };
  let sequence = 10;
  const request = async (call) => {
    calls.push({ method: call.method, url: call.url, body: call.body });
    if (fault.denied) return { status: 403, body: { object: "error" } };
    if (fault.deniedMethod === call.method)
      return (
        fault.denial || {
          status: 403,
          body: { object: "error", status: 403, code: "restricted_resource", message: "Synthetic workspace block limit; repair the limit first." },
        }
      );
    const url = new URL(call.url),
      match = /\/pages\/([^/]+)(\/markdown)?$/.exec(url.pathname);
    if (/\/async_tasks\//.test(url.pathname))
      return {
        status: fault.taskMissing ? 404 : 200,
        body: {
          object: "async_task",
          id: "task_synthetic",
          status: fault.taskStatus,
          ...(fault.taskStatus === "succeeded" ? { result: { object: "page_markdown", id: fault.taskPageId } } : {}),
        },
      };
    if (call.method === "POST") {
      const id = `10000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;
      pages.set(id, { id, parent: { page_id: parent }, markdown: call.body.markdown });
      if (fault.lostCreate) {
        fault.lostCreate = false;
        throw Object.assign(new Error("Synthetic lost response"), { code: "ECONNRESET" });
      }
      return { status: 200, body: { object: "page", id, parent: { page_id: parent } } };
    }
    if (/\/blocks\//.test(url.pathname))
      return { status: 200, body: { results: [...pages.keys()].map((id) => ({ id, type: "child_page" })), has_more: false } };
    const page = pages.get(match?.[1]);
    if (!page) return { status: 404, body: { object: "error" } };
    if (call.method === "PATCH") {
      assert.equal(call.body.type, "update_content");
      const { old_str: oldText, new_str: newText } = call.body.update_content.content_updates[0];
      if (page.markdown.split(oldText).length !== 2) return { status: 400, body: { object: "error" } };
      page.markdown = page.markdown.replace(oldText, newText);
      if (fault.lostPatch) {
        fault.lostPatch = false;
        throw Object.assign(new Error("Synthetic lost patch response"), { code: "ECONNRESET" });
      }
      if (fault.asyncPatch) {
        fault.asyncPatch = false;
        fault.taskPageId = page.id;
        return { status: 202, body: { object: "async_task", id: "task_synthetic", status: "queued", poll_after_seconds: 1 } };
      }
      return { status: 200, body: { object: "page_markdown", id: page.id, markdown: page.markdown, truncated: false, unknown_block_ids: [] } };
    }
    return {
      status: 200,
      body: match[2]
        ? {
            object: "page_markdown",
            id: page.id,
            markdown: fault.missingBody ? page.markdown.slice(0, 50) : page.markdown,
            truncated: false,
            unknown_block_ids: [],
          }
        : { object: "page", id: page.id, parent: page.parent },
    };
  };
  return { parent, pages, calls, fault, request, adapter: createNotionWorkDocumentAdapter({ parentPageId: parent, request }) };
}
test("four real read paths, stable current links, zero duplicate replay; preserve notes and unowned vault files", async (t) => {
  const { root, vault, sessionId, save, prepare } = setup(t),
    fake = fakeNotion();
  fs.writeFileSync(path.join(vault, "Personal.md"), "Unowned notes");
  const targets = [
    { id: "vault", kind: "obsidian", vaultRoot: vault, todoIds: ["todo-expiry"], automatic: true },
    { id: "notion", kind: "notion", parentPageId: fake.parent, tokenEnvironment: "LODE_SYNTHETIC_NOT_USED", todoIds: ["todo-expiry"], automatic: true },
  ];
  configureWorkDocuments({ root, sessionId, targets });
  const projection = await prepare(save());
  const options = { root, sessionId, projectionId: projection.projectionId, targetIds: ["vault", "notion"], adapters: { notion: fake.adapter } };
  const first = await publishWorkDocuments(options);
  assert.equal(first.status, "published", JSON.stringify(first));
  const count = fake.calls.filter((call) => call.method === "POST").length;
  assert.equal(count, 4);
  const directory = path.join(vault, "Lode", projection.basis.projectId, sessionId, projection.basis.logicalKey);
  fs.appendFileSync(path.join(directory, "Notes.md"), "\nUser notes retained.");
  const start = fs.readFileSync(path.join(directory, "Start.md"), "utf8");
  fs.appendFileSync(path.join(directory, "Start.md"), "\nOutside managed area.");
  const second = await publishWorkDocuments(options);
  assert.equal(second.status, "published", JSON.stringify(second));
  assert.equal(fake.calls.filter((call) => call.method === "POST").length, count);
  assert.equal(fs.readFileSync(path.join(vault, "Personal.md"), "utf8"), "Unowned notes");
  assert.ok(fs.readFileSync(path.join(directory, "Notes.md"), "utf8").includes("User notes retained"));
  assert.ok(fs.readFileSync(path.join(directory, "Start.md"), "utf8").startsWith(start));
  for (const name of fs.readdirSync(directory).filter((name) => /^(human|agent)-/.test(name))) {
    const text = fs.readFileSync(path.join(directory, name), "utf8");
    assert.ok(text.includes("Mobile verification and deployment not executed"));
    for (const link of [...text.matchAll(/\]\(([^)]+\.md)\)/g)]) assert.ok(fs.existsSync(path.join(directory, decodeURIComponent(link[1]))));
  }
  for (const page of [...fake.pages.values()].filter((value) => /Source basis:/.test(value.markdown))) {
    assert.ok(page.markdown.includes("Duplicate requests are possible"));
    for (const ref of [...page.markdown.matchAll(/https:\/\/www.notion.so\/([a-f0-9]{32})/g)])
      assert.ok([...fake.pages.keys()].some((id) => id.replaceAll("-", "") === ref[1]));
  }
  assert.equal(workDocumentStatus({ root, sessionId, logicalKey: projection.basis.logicalKey }).destinations.length, 2);
});

test("POST/PATCH rejected writes require explicit exact retry; repeated denial preserves attempts and concurrent clicks cannot duplicate", async (t) => {
  for (const method of ["POST", "PATCH"])
    await t.test(method, async (t) => {
      const { root, sessionId, save, prepare } = setup(t),
        fake = fakeNotion();
      configureWorkDocuments({
        root,
        sessionId,
        targets: [{ id: "notion", kind: "notion", parentPageId: fake.parent, tokenEnvironment: "LODE_NOT_USED", automatic: true, todoIds: ["todo-expiry"] }],
      });
      const projection = await prepare(save()),
        options = { root, sessionId, projectionId: projection.projectionId, targetIds: ["notion"], adapters: { notion: fake.adapter } };
      const store = workDocumentStore({ root, sessionId });
      fake.fault.deniedMethod = method;
      const first = (await publishWorkDocuments(options)).destinations[0];
      assert.equal(first.status, "request-rejected-no-write", JSON.stringify(first));
      assert.match(first.rejectedWrite.message, /block limit/);
      const original = fs.readFileSync(store.file("attempts", `${first.retry.attemptId}.json`));
      const rejection = fs.readFileSync(store.file("outcomes", `${first.retry.attemptId}.json`));
      assert.equal((await publishWorkDocuments(options)).destinations[0].status, "request-rejected-no-write");
      assert.equal(fake.calls.filter((call) => call.method === method).length, 1);
      const second = (await publishWorkDocuments({ ...options, retryRejectedWrites: [first.retry] })).destinations[0];
      assert.equal(second.status, "request-rejected-no-write");
      assert.notEqual(second.retry.attemptId, first.retry.attemptId);
      assert.equal(fake.calls.filter((call) => call.method === method).length, 2);
      await publishWorkDocuments({ ...options, retryRejectedWrites: [first.retry] });
      assert.equal(fake.calls.filter((call) => call.method === method).length, 2, "old retry token cannot advance another rejection");
      fake.fault.deniedMethod = null;
      assert.equal((await publishWorkDocuments(options)).destinations[0].status, "request-rejected-no-write", "repair alone never auto retries");
      const concurrent = await Promise.all([0, 1].map(() => publishWorkDocuments({ ...options, retryRejectedWrites: [second.retry] })));
      assert.ok(
        concurrent.some((result) => result.status === "published"),
        JSON.stringify(concurrent),
      );
      assert.equal(fake.pages.size, 4);
      assert.equal(fake.calls.filter((call) => call.method === "POST").length, method === "POST" ? 6 : 4);
      const count = fake.calls.filter((call) => call.method === "POST" || call.method === "PATCH").length;
      assert.equal((await publishWorkDocuments(options)).status, "published");
      assert.equal(
        (await publishWorkDocuments({ ...options, retryRejectedWrites: [second.retry] })).status,
        "published",
        "completed click reads verified success without another write",
      );
      assert.equal(fake.calls.filter((call) => call.method === "POST" || call.method === "PATCH").length, count);
      assert.deepEqual(fs.readFileSync(store.file("attempts", `${first.retry.attemptId}.json`)), original);
      assert.deepEqual(fs.readFileSync(store.file("outcomes", `${first.retry.attemptId}.json`)), rejection);
      const attempt = store.read("attempts", `${first.retry.attemptId}.json`);
      store.write(["attempts", `${first.retry.attemptId}.json`], { ...attempt, attemptId: "0".repeat(64) }, true);
      const tampered = (await publishWorkDocuments(options)).destinations[0];
      assert.equal(tampered.reasonCode, "WORK_DOCUMENT_RECORD_TAMPER", "valid envelope cannot excuse divergent attempt coordinates");
      assert.equal(fake.calls.filter((call) => call.method === "POST" || call.method === "PATCH").length, count);
    });
});

test("a repaired rejected write with lost retry response becomes unknown then reconciles without another mutation", async (t) => {
  for (const method of ["POST", "PATCH"])
    await t.test(method, async (t) => {
      const { root, sessionId, save, prepare } = setup(t),
        fake = fakeNotion();
      configureWorkDocuments({
        root,
        sessionId,
        targets: [{ id: "notion", kind: "notion", parentPageId: fake.parent, tokenEnvironment: "LODE_NOT_USED", automatic: false, todoIds: [] }],
      });
      const projection = await prepare(save()),
        options = { root, sessionId, projectionId: projection.projectionId, targetIds: ["notion"], adapters: { notion: fake.adapter } };
      fake.fault.deniedMethod = method;
      const denied = (await publishWorkDocuments(options)).destinations[0];
      fake.fault.deniedMethod = null;
      fake.fault[method === "POST" ? "lostCreate" : "lostPatch"] = true;
      assert.equal((await publishWorkDocuments({ ...options, retryRejectedWrites: [denied.retry] })).destinations[0].status, "publication-unconfirmed");
      assert.equal((await publishWorkDocuments({ ...options, retryRejectedWrites: [denied.retry] })).status, "published");
      assert.equal(fake.pages.size, 4);
      assert.equal(fake.calls.filter((call) => call.method === "POST").length, method === "POST" ? 5 : 4);
      assert.equal(fake.calls.filter((call) => call.method === "PATCH").length, method === "PATCH" ? 4 : 3);
    });
});

test("HTTP numbers, malformed envelopes, mismatched status/code and caller error flags never attest no-write", async (t) => {
  for (const response of [
    { status: 403, body: { object: "error" } },
    { status: 403, body: { object: "error", status: 401, code: "restricted_resource", message: "Denied" } },
    { status: 403, body: { object: "error", status: 403, code: "service_unavailable", message: "Denied" } },
    { status: 503, body: { object: "error", status: 503, code: "service_unavailable", message: "Change may be saved" } },
    { status: 401, body: { object: "error", status: 401, code: "unauthorized", message: "Invalid token" } },
  ]) {
    const fake = createNotionWorkDocumentAdapter({ parentPageId: "10000000-0000-4000-8000-000000000001", request: async () => response });
    const input = { title: "Synthetic", markdown: "bounded" },
      intent = fake.writeIntent("create", input);
    await assert.rejects(fake.create(input), (error) => {
      assert.equal(fake.describeWriteRejection(error, intent), null);
      return true;
    });
    assert.equal(fake.describeWriteRejection({ knownNoWrite: true, code: "WORK_DOCUMENT_PERMISSION_DENIED" }, intent), null);
  }
});

test("explicit retry rechecks projection/configuration and exact PATCH text before any mutation", async (t) => {
  const { root, sessionId, save, prepare } = setup(t),
    fake = fakeNotion();
  const target = { id: "notion", kind: "notion", parentPageId: fake.parent, tokenEnvironment: "LODE_NOT_USED", automatic: false, todoIds: [] };
  const config = configureWorkDocuments({ root, sessionId, targets: [target] });
  const evidence = save(),
    projection = await prepare(evidence),
    options = { root, sessionId, projectionId: projection.projectionId, targetIds: ["notion"], adapters: { notion: fake.adapter } };
  fake.fault.deniedMethod = "PATCH";
  const denied = (await publishWorkDocuments(options)).destinations[0];
  fake.fault.deniedMethod = null;
  const mutations = () => fake.calls.filter((call) => ["POST", "PATCH"].includes(call.method)).length;
  const before = mutations(),
    store = workDocumentStore({ root, sessionId });
  const attempt = store.read("attempts", `${denied.retry.attemptId}.json`);
  const page = fake.pages.get(attempt.id),
    old = page.markdown;
  page.markdown = "User edited this managed body.";
  assert.equal((await publishWorkDocuments({ ...options, retryRejectedWrites: [denied.retry] })).destinations[0].reasonCode, "WORK_DOCUMENT_REMOTE_DRIFT");
  assert.equal(mutations(), before);
  page.markdown = old;
  configureWorkDocuments({ root, sessionId, targets: [{ ...target, automatic: true }], expectedConfigurationDigest: config.configurationDigest });
  assert.equal(
    (await publishWorkDocuments({ ...options, retryRejectedWrites: [denied.retry] })).destinations[0].reasonCode,
    "WORK_DOCUMENT_RETRY_SCOPE_CHANGED",
  );
  assert.equal(mutations(), before);
  await prepare(save("partial", evidence));
  assert.equal((await publishWorkDocuments({ ...options, retryRejectedWrites: [denied.retry] })).status, "source-basis-changed");
  assert.equal(mutations(), before);
});

test("failure to persist rejection leaves an unknown attempt, preserves primary error and cannot enable retry", async (t) => {
  const { root, sessionId, save, prepare } = setup(t),
    fake = fakeNotion();
  configureWorkDocuments({
    root,
    sessionId,
    targets: [{ id: "notion", kind: "notion", parentPageId: fake.parent, tokenEnvironment: "LODE_NOT_USED", automatic: false, todoIds: [] }],
  });
  const projection = await prepare(save()),
    options = { root, sessionId, projectionId: projection.projectionId, targetIds: ["notion"], adapters: { notion: fake.adapter } };
  const store = workDocumentStore({ root, sessionId });
  const mkdir = fs.mkdirSync;
  t.mock.method(fs, "mkdirSync", function (directory, ...args) {
    if (String(directory) === store.file("outcomes")) throw Object.assign(new Error("Synthetic rejection persistence failure"), { code: "EACCES" });
    return mkdir.call(this, directory, ...args);
  });
  fake.fault.deniedMethod = "POST";
  const first = (await publishWorkDocuments(options)).destinations[0];
  assert.equal(first.reasonCode, "WORK_DOCUMENT_PERMISSION_DENIED");
  assert.ok(first.rejectionRecordingFailure);
  assert.equal(first.retry, undefined);
  assert.match(first.observedServiceError.message, /block limit/);
  t.mock.restoreAll();
  fake.fault.deniedMethod = null;
  assert.equal((await publishWorkDocuments(options)).destinations[0].reasonCode, "WORK_DOCUMENT_CREATE_UNKNOWN");
  assert.equal(fake.calls.filter((call) => call.method === "POST").length, 1);
});

test("public MCP/CLI explicit recovery works; ordinary work-record retry never inherits permission to retry rejection", async (t) => {
  for (const method of ["POST", "PATCH"])
    await t.test(method, async (t) => {
      const { root, sessionId, save, prepare } = setup(t),
        fake = fakeNotion();
      const environment = "LODE_TEST_REJECTED_WRITE_TOKEN",
        previous = process.env[environment];
      process.env[environment] = "synthetic-not-a-real-token";
      t.after(() => {
        if (previous === undefined) delete process.env[environment];
        else process.env[environment] = previous;
      });
      t.mock.method(globalThis, "fetch", async (url, input) => {
        assert.equal(new URL(url).origin, "https://api.notion.com");
        const response = await fake.request({ method: input.method, url, ...(input.body ? { body: JSON.parse(input.body) } : {}) });
        return new Response(JSON.stringify(response.body), { status: response.status });
      });
      configureWorkDocuments({
        root,
        sessionId,
        targets: [{ id: "notion", kind: "notion", parentPageId: fake.parent, tokenEnvironment: environment, automatic: true, todoIds: ["todo-expiry"] }],
      });
      const evidence = save(),
        projection = await prepare(evidence);
      const call = async (retry) => {
        const response = await dispatch({
          jsonrpc: "2.0",
          id: "explicit-rejected-write",
          method: "tools/call",
          params: {
            name: "lode_work_document_publish",
            arguments: {
              project_root: root,
              session_id: sessionId,
              projection_id: projection.projectionId,
              target_ids: ["notion"],
              ...(retry ? { retry_rejected_writes: [{ target_id: retry.targetId, attempt_id: retry.attemptId }] } : {}),
            },
          },
        });
        assert.equal(response.error, undefined, JSON.stringify(response));
        return response.result.structuredContent;
      };
      fake.fault.deniedMethod = method;
      const first = (await call()).destinations[0];
      assert.equal(first.status, "request-rejected-no-write");
      fake.fault.deniedMethod = null;
      const exactInput = { ...evidence.content };
      delete exactInput.occurrenceKey;
      const automatic = await withSessionRoute(root, sessionId, () => recordSessionWorkAndProjectDocuments({ root, input: exactInput }));
      assert.equal(automatic.writes, 0);
      assert.equal(automatic.evidence.evidenceId, evidence.evidenceId);
      assert.equal(automatic.documentProjection.destinations[0].status, "request-rejected-no-write");
      assert.equal(fake.calls.filter((call) => call.method === method).length, 1);
      const file = path.join(root, "head-owned-retry.json");
      fs.writeFileSync(file, JSON.stringify({ projectionId: projection.projectionId, targetIds: ["notion"], retryRejectedWrites: [first.retry] }));
      const result = method === "POST" ? await call(first.retry) : await runCommand(["work-document-publish", root, "--session", sessionId, "--input", file]);
      assert.equal(result.status, "published", JSON.stringify(result));
      const writes = fake.calls.filter((call) => ["POST", "PATCH"].includes(call.method)).length;
      assert.equal((await call(first.retry)).status, "published");
      assert.equal(fake.calls.filter((call) => ["POST", "PATCH"].includes(call.method)).length, writes);
    });
});

test("source change rejects the stale pair but a fresh basis can explicitly retry the identical stable container without an old-source ritual", async (t) => {
  const { root, sessionId, save, prepare } = setup(t),
    fake = fakeNotion();
  configureWorkDocuments({
    root,
    sessionId,
    targets: [{ id: "notion", kind: "notion", parentPageId: fake.parent, tokenEnvironment: "LODE_NOT_USED", automatic: false, todoIds: [] }],
  });
  const original = save(),
    first = await prepare(original);
  const options = { root, sessionId, projectionId: first.projectionId, targetIds: ["notion"], adapters: { notion: fake.adapter } };
  fake.fault.deniedMethod = "POST";
  const denied = (await publishWorkDocuments(options)).destinations[0];
  fake.fault.deniedMethod = null;
  const fresh = await prepare(save("partial", original));
  assert.equal((await publishWorkDocuments({ ...options, retryRejectedWrites: [denied.retry] })).status, "source-basis-changed");
  assert.equal((await publishWorkDocuments({ ...options, projectionId: fresh.projectionId })).destinations[0].status, "request-rejected-no-write");
  assert.equal(fake.calls.filter((call) => call.method === "POST").length, 1);
  assert.equal((await publishWorkDocuments({ ...options, projectionId: fresh.projectionId, retryRejectedWrites: [denied.retry] })).status, "published");
  assert.deepEqual(
    fake.calls
      .filter((call) => call.method === "POST")
      .slice(0, 2)
      .map((call) => call.body),
    [fake.calls[0].body, fake.calls[0].body],
  );
  const current = workDocumentStatus({ root, sessionId, logicalKey: fresh.basis.logicalKey }).destinations[0].current;
  assert.equal(current.projectionId, fresh.projectionId);
});
test("lost create response recovers bounded parent content; permission failure preserves other destination success", async (t) => {
  const { root, vault, sessionId, save, prepare } = setup(t),
    fake = fakeNotion();
  configureWorkDocuments({
    root,
    sessionId,
    targets: [
      { id: "notion", kind: "notion", parentPageId: fake.parent, tokenEnvironment: "LODE_NOT_USED", automatic: false, todoIds: [] },
      { id: "vault", kind: "obsidian", vaultRoot: vault, automatic: false, todoIds: [] },
    ],
  });
  const projection = await prepare(save()),
    options = { root, sessionId, projectionId: projection.projectionId, targetIds: ["notion", "vault"], adapters: { notion: fake.adapter } };
  fake.fault.lostCreate = true;
  const failed = await publishWorkDocuments(options);
  assert.equal(failed.destinations[0].status, "publication-unconfirmed");
  assert.equal(failed.destinations[1].status, "current");
  assert.equal((await publishWorkDocuments(options)).status, "published");
  assert.equal(fake.calls.filter((call) => call.method === "POST").length, 4);
  fake.fault.denied = true;
  const denied = await publishWorkDocuments(options);
  assert.equal(denied.destinations[0].status, "permission-denied");
  assert.equal(denied.destinations[1].status, "current");
});
test("new partial result updates related current docs; stale completion cannot rewind; remote edits preserved", async (t) => {
  const { root, vault, sessionId, save, prepare } = setup(t);
  configureWorkDocuments({ root, sessionId, targets: [{ id: "vault", kind: "obsidian", vaultRoot: vault, automatic: true, todoIds: ["todo-expiry"] }] });
  const original = save(),
    first = await prepare(original);
  const publish = (projection) => publishWorkDocuments({ root, sessionId, projectionId: projection.projectionId, targetIds: ["vault"] });
  assert.equal((await publish(first)).status, "published");
  const revision = save("partial", original),
    second = await prepare(revision);
  assert.equal((await publish(second)).status, "published");
  assert.equal((await publish(first)).status, "source-basis-changed");
  const directory = path.join(vault, "Lode", first.basis.projectId, sessionId, first.basis.logicalKey);
  assert.ok(fs.readFileSync(path.join(directory, "Start.md"), "utf8").includes("partial"));
  const human = path.join(directory, `human-${second.views[0].viewId}.md`);
  fs.appendFileSync(human, "\nUser edits must survive.");
  assert.equal((await publish(second)).status, "partial-or-unconfirmed");
  assert.ok(fs.readFileSync(human, "utf8").endsWith("User edits must survive."));
  const oldBytes = fs.readFileSync(human),
    copy = path.join(directory, "Copied.md");
  fs.writeFileSync(copy, oldBytes);
  fs.unlinkSync(human);
  fs.renameSync(copy, human);
  const replaced = await publish(second);
  assert.equal(replaced.destinations[0].reasonCode, "WORK_DOCUMENT_RESOURCE_REPLACED");
  assert.deepEqual(fs.readFileSync(human), oldBytes);
});
test("stream bound cancels chunked/no-length responses during receipt; parent recovery shares one finite request budget", async () => {
  let reads = 0,
    cancelled = 0;
  const request = createBoundedNotionRequest({
    token: "synthetic-token",
    maxBytes: 10,
    fetchFunction: async () => ({
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          async read() {
            reads++;
            return { done: false, value: new Uint8Array(8) };
          },
          async cancel() {
            cancelled++;
          },
          releaseLock() {},
        }),
      },
    }),
  });
  await assert.rejects(request({ url: "https://api.notion.com/v1/pages/example", method: "GET" }), { code: "WORK_DOCUMENT_RESPONSE_BOUND" });
  assert.equal(reads, 2);
  assert.equal(cancelled, 1);
  let count = 0;
  const parent = "10000000-0000-4000-8000-000000000001",
    child = "10000000-0000-4000-8000-000000000002";
  const adapter = createNotionWorkDocumentAdapter({
    parentPageId: parent,
    requestBudget: 3,
    request: async ({ url }) => {
      count++;
      if (/\/blocks\//.test(url))
        return { status: 200, body: { results: Array.from({ length: 100 }, () => ({ id: child, type: "child_page" })), has_more: true, next_cursor: "more" } };
      return {
        status: 200,
        body: url.includes("/markdown")
          ? { object: "page_markdown", id: child, markdown: "different", truncated: false, unknown_block_ids: [] }
          : { id: child, parent: { page_id: parent } },
      };
    },
  });
  await assert.rejects(adapter.find({ markdown: "target" }), { code: "WORK_DOCUMENT_TRANSPORT_BUDGET" });
  assert.equal(count, 3);
});
test("async public record preserves exact original retry; no configuration has no effect; typed MCP/CLI route same selected Session", async (t) => {
  const { root, vault, sessionId, save } = setup(t);
  const old = save(),
    input = { ...old.content };
  delete input.occurrenceKey; // replay the original input, not normalized null extensions
  const route = (callback) => withSessionRoute(root, sessionId, callback);
  const unconnected = await route(() => recordSessionWorkAndProjectDocuments({ root, input }));
  assert.equal(unconnected.status, "session_work_evidence_reused");
  assert.equal(unconnected.writes, 0);
  assert.equal(unconnected.documentProjection.status, "unconnected");
  configureWorkDocuments({ root, sessionId, targets: [{ id: "vault", kind: "obsidian", vaultRoot: vault, automatic: true, todoIds: ["todo-expiry"] }] });
  const projected = await route(() => recordSessionWorkAndProjectDocuments({ root, input }));
  assert.equal(projected.writes, 0);
  assert.equal(projected.documentProjection.status, "published");
  const store = workDocumentStore({ root, sessionId });
  const preparedCount = fs.readdirSync(store.file("prepared")).length;
  assert.equal((await route(() => recordSessionWorkAndProjectDocuments({ root, input }))).documentProjection.status, "published");
  assert.equal(fs.readdirSync(store.file("prepared")).length, preparedCount);
  assert.ok(catalogTools.some((tool) => tool.name === "lode_work_document_status"));
  const response = await dispatch({
    jsonrpc: "2.0",
    id: "work-doc",
    method: "tools/call",
    params: { name: "lode_work_document_status", arguments: { project_root: root, session_id: sessionId } },
  });
  assert.equal(response.error, undefined, JSON.stringify(response));
  assert.equal(response.result.structuredContent.sessionId, sessionId);
  const cli = await route(() => runCommand(["work-document-status", root]));
  assert.equal(cli.sessionId, sessionId);
});
test("202 requires terminal success even with full body already visible; failure or expiry never succeeds or replays", async (t) => {
  for (const disposition of ["succeeded", "failed", "expired"])
    await t.test(disposition, async (t) => {
      let clock = Date.now();
      t.mock.method(Date, "now", () => clock);
      const { root, sessionId, save, prepare } = setup(t),
        fake = fakeNotion();
      configureWorkDocuments({
        root,
        sessionId,
        targets: [{ id: "notion", kind: "notion", parentPageId: fake.parent, tokenEnvironment: "LODE_NOT_USED", automatic: false, todoIds: [] }],
      });
      const projection = await prepare(save()),
        options = { root, sessionId, projectionId: projection.projectionId, targetIds: ["notion"], adapters: { notion: fake.adapter } };
      fake.fault.asyncPatch = true;
      assert.equal((await publishWorkDocuments(options)).status, "partial-or-unconfirmed");
      const creates = fake.calls.filter((call) => call.method === "POST").length,
        writes = fake.calls.filter((call) => call.method === "PATCH").length;
      assert.equal((await publishWorkDocuments(options)).status, "partial-or-unconfirmed");
      assert.equal(fake.calls.filter((call) => call.url.includes("async_tasks")).length, 0);
      clock += 2000;
      fake.fault.taskStatus = disposition === "expired" ? "succeeded" : disposition;
      fake.fault.taskMissing = disposition === "expired";
      const result = await publishWorkDocuments(options);
      assert.equal(result.status, disposition === "succeeded" ? "published" : "partial-or-unconfirmed", JSON.stringify(result));
      assert.equal(fake.calls.filter((call) => call.method === "POST").length, creates);
      if (disposition !== "succeeded") assert.equal(fake.calls.filter((call) => call.method === "PATCH").length, writes);
    });
});
test("duplicate recovered copies, missing body without warnings and local journal tamper never permit blind recreation", async (t) => {
  const { root, sessionId, save, prepare } = setup(t),
    fake = fakeNotion();
  configureWorkDocuments({
    root,
    sessionId,
    targets: [{ id: "notion", kind: "notion", parentPageId: fake.parent, tokenEnvironment: "LODE_NOT_USED", automatic: false, todoIds: [] }],
  });
  const projection = await prepare(save()),
    options = { root, sessionId, projectionId: projection.projectionId, targetIds: ["notion"], adapters: { notion: fake.adapter } };
  fake.fault.lostCreate = true;
  await publishWorkDocuments(options);
  const original = [...fake.pages.values()][0],
    clone = "10000000-0000-4000-8000-000000009999";
  fake.pages.set(clone, { ...original, id: clone });
  assert.equal((await publishWorkDocuments(options)).status, "partial-or-unconfirmed");
  assert.equal(fake.calls.filter((call) => call.method === "POST").length, 1);
  fake.pages.delete(clone);
  fake.fault.missingBody = true;
  assert.equal((await publishWorkDocuments(options)).status, "partial-or-unconfirmed");
  assert.equal(fake.calls.filter((call) => call.method === "POST").length, 1);
  const store = workDocumentStore({ root, sessionId }),
    preparedFile = store.file("prepared", `${projection.projectionId}.json`);
  const record = JSON.parse(fs.readFileSync(preparedFile));
  record.value.views[0].markdown += "tampered";
  fs.writeFileSync(preparedFile, JSON.stringify(record));
  await assert.rejects(publishWorkDocuments(options), { code: "WORK_DOCUMENT_RECORD_TAMPER" });
});
test("real async MCP/CLI retry retains rich selection; new cancellation requests HEAD selection then finishes prepare/publish without re-saving", async (t) => {
  const { root, vault, sessionId, save } = setup(t),
    owner = readSessionWorkEvidenceOwner({ root, sessionId });
  configureWorkDocuments({ root, sessionId, targets: [{ id: "vault", kind: "obsidian", vaultRoot: vault, automatic: true, todoIds: ["todo-expiry"] }] });
  const retainLog = () => {
    const bytes = fs.readFileSync(path.join(root, "result.log"));
    retainSourceObservation(
      root,
      createSourceObservation(
        {
          version: 1,
          projectId: owner.projectId,
          kind: "source",
          query: [{ path: "result.log", symbol: "" }],
          sources: [{ path: "result.log", digest: workDocumentHash(bytes), base64: bytes.toString("base64") }],
          profile: {},
          observedAt: "2026-01-01T00:00:00Z",
          response: null,
          envelopeHash: null,
        },
        owner.storage,
      ),
      owner.storage,
    );
  };
  retainLog();
  const first = save("partial");
  fs.writeFileSync(path.join(root, "result.log"), "Synthetic current result: wording changed; mobile NOT RUN.\n");
  retainLog();
  const current = save("completed", first),
    input = { ...current.content };
  delete input.occurrenceKey;
  const another = createHeadSession({ root, purpose: "Related accessibility suggestion, not approval" });
  const suggestion = withSessionRoute(root, another.sessionId, () =>
    recordSessionWorkEvidence({ root, input: { summary: "Related suggestion is unapproved" } }),
  ).evidence;
  const graph = await queryProjectGraph({ root, paths: [`${owner.workDirectory}/${current.evidenceId}.json`], depth: 1, details: true });
  const anchor = graph.nodes.find((node) => node.sourceReference?.path.endsWith(`${current.evidenceId}.json`))?.nodeId;
  assert.ok(anchor, "actual exact work-graph anchor must be available without World/Product");
  const selection = {
    root,
    sessionId,
    todoId: "todo-expiry",
    title: "Expiry explanation",
    evidenceIds: [first.evidenceId, current.evidenceId],
    related: [{ sessionId: another.sessionId, evidenceId: suggestion.evidenceId, evidenceDigest: suggestion.evidenceDigest }],
    graphAnchors: [anchor],
    diffs: [{ before: { evidenceId: first.evidenceId, referenceIndex: 0 }, after: { evidenceId: current.evidenceId, referenceIndex: 0 } }],
    excerpts: [{ evidenceId: current.evidenceId, referenceIndex: 0, startLine: 1, endLine: 1 }],
  };
  const manual = await prepareWorkDocuments(selection);
  assert.equal((await publishWorkDocuments({ root, sessionId, projectionId: manual.projectionId, targetIds: ["vault"] })).status, "published");
  let lastText = "";
  const call = async (name, args) => {
    const result = await dispatch({
      jsonrpc: "2.0",
      id: "rich-work-doc",
      method: "tools/call",
      params: { name, arguments: { project_root: root, session_id: sessionId, ...args } },
    });
    assert.equal(result.error, undefined, JSON.stringify(result));
    lastText = result.result.content[0].text;
    return result.result.structuredContent;
  };
  const retried = await call("lode_session_work_record", { evidence: input });
  assert.equal(retried.writes, 0);
  assert.equal(retried.documentProjection.status, "published", JSON.stringify(retried));
  assert.equal(retried.documentProjection.projectionId, manual.projectionId);
  const inputFile = path.join(root, "owned-input.json");
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const cliRetry = await runCommand(["session-work-record", root, "--session", sessionId, "--input", inputFile]);
  assert.equal(cliRetry.writes, 0);
  assert.equal(cliRetry.documentProjection.projectionId, manual.projectionId);
  const cancelledInput = {
    ...input,
    summary: "Synthetic cancellation recorded; do not present old completion as current",
    pending: [],
    todos: [
      {
        ...input.todos[0],
        status: "cancelled",
        reason: "Cancellation recorded for this exact task",
        prior: { evidenceId: current.evidenceId, evidenceDigest: current.evidenceDigest },
      },
    ],
  };
  const cancelled = await call("lode_session_work_record", { evidence: cancelledInput });
  assert.equal(cancelled.writes, 1);
  assert.equal(cancelled.documentProjection.status, "lode-selection-required");
  assert.equal(cancelled.documentProjection.userActionRequired, false);
  assert.equal(cancelled.documentProjection.savedTaskStatus, "cancelled");
  assert.equal(cancelled.documentProjection.remoteDocumentState, "previous-published-basis-not-updated");
  assert.match(lastText, /lode-selection-required/);
  assert.match(lastText, /cancelled/);
  assert.match(lastText, /user action not required/);
  assert.match(lastText, /lode_work_document \(action: prepare\)/);
  assert.match(lastText, /Remote documents are not updated/);
  const followUpPrefix = "documentProjection.followUp: ";
  const textOnlyFollowUp = JSON.parse(lastText.slice(lastText.indexOf(followUpPrefix) + followUpPrefix.length));
  assert.deepEqual(textOnlyFollowUp, cancelled.documentProjection.followUp);
  const status = workDocumentStatus({ root, sessionId, logicalKey: manual.basis.logicalKey });
  assert.equal(status.destinations[0].current.projectionId, manual.projectionId);
  const originalsBeforeFollowUp = fs.readdirSync(path.join(root, owner.workDirectory));
  // Synthetic HEAD consumer follows the public response, retaining the historical
  // pair explicitly; it does not relabel that old after as today's new change.
  const prepared = await call("lode_work_document_prepare", {
    title: selection.title,
    todo_id: "todo-expiry",
    evidence_ids: [first.evidenceId, current.evidenceId, textOnlyFollowUp.recorded.evidenceId],
    related: selection.related,
    graph_anchors: [anchor],
    diffs: selection.diffs,
    excerpts: selection.excerpts,
  });
  assert.equal(prepared.basis.comparisons[0].recordScope, "historical-pair-not-current-task-change");
  const textOnlyPrepared = JSON.parse(lastText);
  const done = await call("lode_work_document_publish", { projection_id: textOnlyPrepared.projectionId, target_ids: textOnlyFollowUp.targetIds });
  assert.equal(done.status, "published");
  assert.deepEqual(fs.readdirSync(path.join(root, owner.workDirectory)), originalsBeforeFollowUp);
  const again = await call("lode_session_work_record", { evidence: cancelledInput });
  assert.equal(again.writes, 0);
  assert.equal(again.documentProjection.projectionId, prepared.projectionId);
  const nextInput = {
    ...cancelledInput,
    summary: "Synthetic correction is partial",
    todos: [
      {
        ...cancelledInput.todos[0],
        status: "partial",
        nextAction: "Inspect the recorded correction",
        prior: { evidenceId: cancelled.evidence.evidenceId, evidenceDigest: cancelled.evidence.evidenceDigest },
      },
    ],
  };
  const inline = await call("lode_session_work_record", {
    evidence: nextInput,
    document_selection: {
      evidenceIds: [cancelled.evidence.evidenceId, "recorded"],
      related: selection.related,
      graphAnchors: [anchor],
      diffs: [{ before: { evidenceId: cancelled.evidence.evidenceId, referenceIndex: 0 }, after: { evidenceId: "recorded", referenceIndex: 0 } }],
      excerpts: [{ evidenceId: "recorded", referenceIndex: 0, startLine: 1, endLine: 1 }],
    },
  });
  assert.equal(inline.documentProjection.status, "published", JSON.stringify(inline));
  const store = workDocumentStore({ root, sessionId }),
    paired = store.read("prepared", `${inline.documentProjection.projectionId}.json`);
  assert.equal(paired.basis.comparisons.length, 1);
  assert.equal(paired.basis.quotations.length, 1);
  assert.deepEqual(paired.basis.selection.graphAnchors, [anchor]);
  assert.equal(paired.basis.comparisons[0].recordScope, "explicit-pair-cited-by-current-task-record-not-decision-cause");
  assert.equal(paired.basis.comparisons[0].fileBytes, "unchanged");
  assert.ok(paired.basis.graph.nodes.some((node) => node.label && node.labelSourceField !== "kind"));
  // CLI receives the same optional authored selection without putting it into
  // the immutable P3 schema. A bad optional file cannot erase a saved result.
  const composition = {
    evidenceIds: [cancelled.evidence.evidenceId, "recorded"],
    related: selection.related,
    graphAnchors: [anchor],
    diffs: [{ before: { evidenceId: cancelled.evidence.evidenceId, referenceIndex: 0 }, after: { evidenceId: "recorded", referenceIndex: 0 } }],
    excerpts: [{ evidenceId: "recorded", referenceIndex: 0, startLine: 1, endLine: 1 }],
  };
  const selectionFile = path.join(root, "owned-selection.json");
  fs.writeFileSync(inputFile, JSON.stringify(nextInput));
  fs.writeFileSync(selectionFile, JSON.stringify(composition));
  const cliInline = await runCommand(["session-work-record", root, "--session", sessionId, "--input", inputFile, "--document-selection", selectionFile]);
  assert.equal(cliInline.writes, 0);
  assert.equal(cliInline.documentProjection.projectionId, inline.documentProjection.projectionId);
  const cliMissing = await runCommand([
    "session-work-record",
    root,
    "--session",
    sessionId,
    "--input",
    inputFile,
    "--document-selection",
    path.join(root, "missing.json"),
  ]);
  assert.equal(cliMissing.writes, 0);
  assert.equal(cliMissing.documentProjection.originalWorkSaved, true);
  assert.equal(cliMissing.documentProjection.reasonCode, "ENOENT");
  const text = formatCliResult("session-work-record", cliMissing);
  assert.match(text, /document-update-unconfirmed/);
  assert.match(text, /ENOENT/);
  assert.match(text, /original work save remains successful/i);
});
test("answer-only completed result publishes without external refs; bare status stays unconfirmed; manual and automatic mean the same", async (t) => {
  const { root, vault, sessionId } = setup(t);
  configureWorkDocuments({ root, sessionId, targets: [{ id: "vault", kind: "obsidian", vaultRoot: vault, automatic: true, todoIds: ["todo-answer"] }] });
  const route = (callback) => withSessionRoute(root, sessionId, callback);
  const bare = await route(() =>
    recordSessionWorkAndProjectDocuments({
      root,
      input: { todos: [{ todoId: "todo-answer", task: "Explain the tradeoff", status: "completed", origin: "lode-proposed" }] },
    }),
  );
  assert.equal(bare.documentProjection.status, "document-result-unconfirmed");
  const input = {
    summary: "Keep the existing exact reader: it preserves source identity without a new service.",
    judgments: [{ assessment: "Reuse the reader", reason: "Another reader would duplicate validation", alternatives: ["Add a new reader"] }],
    unknowns: ["This is analysis, not an executed implementation or a user approval"],
    todos: [
      {
        todoId: "todo-answer",
        task: "Explain the tradeoff",
        status: "completed",
        origin: "lode-proposed",
        prior: { evidenceId: bare.evidence.evidenceId, evidenceDigest: bare.evidence.evidenceDigest },
      },
    ],
  };
  const automatic = await route(() => recordSessionWorkAndProjectDocuments({ root, input }));
  assert.equal(automatic.documentProjection.status, "published", JSON.stringify(automatic));
  assert.deepEqual(automatic.evidence.content.references, []);
  const manual = await prepareWorkDocuments({
    root,
    sessionId,
    todoId: "todo-answer",
    title: "Explain the tradeoff",
    evidenceIds: [automatic.evidence.evidenceId],
  });
  assert.equal(manual.projectionId, automatic.documentProjection.projectionId);
  for (const view of manual.views) {
    assert.ok(view.markdown.includes(input.summary));
    assert.ok(view.markdown.includes(input.unknowns[0]));
    assert.equal(view.authorityPlane, "P4");
  }
  const retry = await route(() => recordSessionWorkAndProjectDocuments({ root, input }));
  assert.equal(retry.writes, 0);
  assert.equal(retry.documentProjection.projectionId, manual.projectionId);
});
test("valid P3 survives missing referenced file; failed exact diff/quote remain unknown and P3 tamper still fails basis validation", async (t) => {
  const { root, vault, sessionId, save } = setup(t);
  const record = save(),
    input = { ...record.content };
  delete input.occurrenceKey;
  configureWorkDocuments({ root, sessionId, targets: [{ id: "vault", kind: "obsidian", vaultRoot: vault, automatic: true, todoIds: ["todo-expiry"] }] });
  fs.writeFileSync(path.join(root, "result.log"), "Different current bytes; no retained original for the recorded digest.\n");
  const changed = await prepareWorkDocuments({
    root,
    sessionId,
    todoId: "todo-expiry",
    title: input.todos[0].task,
    evidenceIds: [record.evidenceId],
    diffs: [{ before: { evidenceId: record.evidenceId, referenceIndex: 0 }, after: { evidenceId: record.evidenceId, referenceIndex: 0 } }],
    excerpts: [{ evidenceId: record.evidenceId, referenceIndex: 0, startLine: 1, endLine: 1 }],
  });
  assert.equal(changed.basis.records[0].references[0].reasonCode, "SESSION_WORK_REFERENCE_CHANGED");
  assert.equal(changed.basis.comparisons[0].status, "unknown");
  assert.equal(changed.basis.quotations[0].primaryReferenceFailure.reasonCode, "SESSION_WORK_REFERENCE_CHANGED");
  fs.unlinkSync(path.join(root, "result.log"));
  const projection = await prepareWorkDocuments({
    root,
    sessionId,
    todoId: "todo-expiry",
    title: input.todos[0].task,
    evidenceIds: [record.evidenceId],
    diffs: [{ before: { evidenceId: record.evidenceId, referenceIndex: 0 }, after: { evidenceId: record.evidenceId, referenceIndex: 0 } }],
    excerpts: [{ evidenceId: record.evidenceId, referenceIndex: 0, startLine: 1, endLine: 1 }],
  });
  assert.equal(projection.basis.records[0].references[0].reasonCode, "ENOENT");
  assert.equal(projection.basis.comparisons[0].status, "unknown");
  assert.equal(projection.basis.comparisons[0].sourceAvailability.before.reasonCode, "ENOENT");
  assert.equal(projection.basis.quotations[0].status, "unavailable");
  for (const view of projection.views) assert.ok(view.markdown.includes("ENOENT"));
  const result = await withSessionRoute(root, sessionId, () => recordSessionWorkAndProjectDocuments({ root, input }));
  assert.equal(result.writes, 0);
  assert.equal(result.documentProjection.status, "published");
  const owner = readSessionWorkEvidenceOwner({ root, sessionId }),
    originalFile = path.join(root, owner.workDirectory, `${record.evidenceId}.json`);
  const tampered = JSON.parse(fs.readFileSync(originalFile));
  tampered.content.summary = "tampered without resealing original";
  fs.writeFileSync(originalFile, JSON.stringify(tampered));
  await assert.rejects(
    prepareWorkDocuments({ root, sessionId, todoId: "todo-expiry", title: "Tamper", evidenceIds: [record.evidenceId] }),
    (error) => error.code === "WORK_DOCUMENT_ORIGINAL_UNAVAILABLE" && error.primaryReasonCode === "SESSION_WORK_EVIDENCE_INTEGRITY",
  );
});
test("source permission denial is preserved and never retried through a different source reader", async (t) => {
  const { root, sessionId, save } = setup(t),
    record = save(),
    log = path.join(root, "result.log"),
    original = fs.readFileSync;
  let deniedReads = 0;
  t.mock.method(fs, "readFileSync", function (file, ...args) {
    if (typeof file === "string" && path.resolve(file) === path.resolve(log)) {
      deniedReads++;
      throw Object.assign(new Error("Synthetic source permission denial"), { code: "EACCES" });
    }
    return original.call(this, file, ...args);
  });
  const projection = await prepareWorkDocuments({
    root,
    sessionId,
    todoId: "todo-expiry",
    title: "Denied source",
    evidenceIds: [record.evidenceId],
    diffs: [{ before: { evidenceId: record.evidenceId, referenceIndex: 0 }, after: { evidenceId: record.evidenceId, referenceIndex: 0 } }],
    excerpts: [{ evidenceId: record.evidenceId, referenceIndex: 0, startLine: 1, endLine: 1 }],
  });
  assert.equal(deniedReads, 1, "all dependent source expansion reuses the existing denial instead of another read/fallback");
  assert.equal(projection.basis.comparisons[0].sourceAvailability.before.reasonCode, "EACCES");
  assert.equal(projection.basis.quotations[0].reasonCode, "EACCES");
  for (const view of projection.views) assert.ok(view.markdown.includes("EACCES"));
});

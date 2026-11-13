import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject } from "../scripts/lib/session/lode-core.mjs";
import { createHeadSession, withSessionRoute } from "../scripts/lib/session/session-routing.mjs";
import { recordSessionWorkEvidence } from "../scripts/lib/session/session-work-context.mjs";
import { projectDocumentStore, workDocumentStore } from "../scripts/lib/world/work-document-store.mjs";
import { readProjectDocumentBasis } from "../scripts/lib/storage/project-document-hierarchy.mjs";
import { createNotionWorkDocumentAdapter, documentDestinationIdentity } from "../scripts/lib/world/work-document-destinations.mjs";
import { configureWorkDocuments, prepareWorkDocuments, publishWorkDocuments } from "../scripts/lib/world/work-document-publication.mjs";
import { prepareProjectDocuments, publishProjectDocuments, projectDocumentStatus } from "../scripts/lib/world/project-document-publication.mjs";
import { recordSessionWorkAndProjectDocuments } from "../scripts/lib/session/session-work-document-workflow.mjs";
import { createDocumentEffectWriter } from "../scripts/lib/world/work-document-effect-writer.mjs";
import { workDocumentHash } from "../scripts/lib/world/work-document-source.mjs";
import { createSourceObservation, retainSourceObservation } from "../scripts/lib/world/source-observation.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";
import { runCommand } from "../scripts/lode.mjs";
import { updateProjectDirection } from "../scripts/lib/session/project-direction.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
function fixture(t) {
  const area = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lode-project-docs-")));
  const root = path.join(area, "same-name"),
    vault = path.join(area, "vault");
  fs.mkdirSync(root);
  fs.mkdirSync(vault);
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const a = createHeadSession({ root, purpose: "Synthetic wording evidence" }).sessionId;
  const b = createHeadSession({ root, purpose: "Another synthetic task, not inherited direction" }).sessionId;
  t.after(() => {
    assert.ok(area.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
    fs.rmSync(area, { recursive: true, force: true });
  });
  const store = projectDocumentStore({ root, sessionId: a });
  const canon = path.join(root, store.owner.storage.directory, "context", "product-model.json");
  const model = {
    schemaVersion: 1,
    featureGroups: [
      { key: "g1", name: "계정", description: "계정 사용 흐름", parentFeatureGroupKeys: [] },
      { key: "g2", name: "보안", parentFeatureGroupKeys: ["g1"] },
      { key: "g3", name: "공유 구성", parentFeatureGroupKeys: ["g1", "g2"] },
    ],
    features: [
      {
        key: "fa",
        name: "로그인",
        description: "입력한 계정으로 로그인합니다.",
        featureGroupKeys: ["g1", "g3"],
        capabilityKeys: [],
        governedBy: [{ kind: "Decision", key: "d1" }],
      },
      { key: "fb", name: "만료 안내", featureGroupKeys: ["g2"], capabilityKeys: [], governedBy: [{ kind: "Decision", key: "d1" }] },
      { key: "orphan", name: "소속 미확인 기능", featureGroupKeys: [], capabilityKeys: [], governedBy: [] },
    ],
    capabilities: [],
    requirements: [],
    constraints: [],
    decisions: [{ key: "d1", statement: "네트워크 재시도는 사용자가 선택합니다.", status: "active" }],
  };
  const write = () => fs.writeFileSync(canon, JSON.stringify(model, null, 2) + "\n");
  write();
  const save = (sessionId, summary) =>
    withSessionRoute(root, sessionId, () =>
      recordSessionWorkEvidence({
        root,
        input: {
          summary,
          observedWork: ["합성 원문을 읽어 설명했습니다."],
          pending: ["모바일 검증과 외부 배포는 실행하지 않았습니다."],
          judgments: [{ assessment: "자동 네트워크 재시도를 추가하지 않음", reason: "중복 요청 가능성을 남겨둡니다.", alternatives: ["명시적 재시도"] }],
          unknowns: ["이 기록은 사용자 승인 원문이 아닙니다."],
        },
      }),
    ).evidence;
  return { area, root, vault, a, b, store, canon, model, write, save };
}
const select = (record, featureKeys = []) => ({
  sessionId: record.sessionId,
  evidenceId: record.evidenceId,
  evidenceDigest: record.evidenceDigest,
  featureKeys,
});

test("actual Canon DAG, shared decision and multi-feature Session remain linked once; both audiences retain facts and uncertainty", (t) => {
  const f = fixture(t),
    first = f.save(f.a, "로그인·만료 안내를 함께 검토했습니다."),
    second = f.save(f.b, "계정 이름과 무관한 미분류 분석입니다.");
  const work = [select(first, ["fa"]), select(first, ["fb"]), select(second, ["unknown-feature"])];
  const basis = readProjectDocumentBasis({
    root: f.root,
    sessionId: f.a,
    projectTitle: "같은 이름",
    workEvidence: work,
    narratives: [
      {
        kind: "Feature",
        key: "fa",
        sourceKeys: ["Feature:fa", `work:${first.sessionId}/${first.evidenceId}`],
        purpose: "계정으로 로그인하는 흐름을 설명합니다.",
        useFlow: "계정을 입력한 뒤 로그인합니다.",
        currentBehavior: "관찰한 설명 범위입니다. 모바일 검증·배포는 미실행입니다.",
      },
    ],
  });
  const find = (kind, key) => basis.nodes.find((n) => n.kind === kind && n.key === key);
  assert.equal(find("FeatureGroup", "g3").parents.length, 2);
  assert.equal(find("Feature", "fa").parents.length, 2);
  assert.equal(basis.nodes.filter((n) => n.kind === "Decision" && n.key === "d1").length, 1);
  assert.equal(find("Decision", "d1").related.length, 2);
  assert.equal(basis.nodes.filter((n) => n.kind === "Work").length, 2, "same original/digest coalesces reading links, not Canon");
  assert.equal(find("Session", f.a).related.length, 2);
  const workNode = find("Work", `${first.sessionId}/${first.evidenceId}`);
  assert.equal(workNode.related.length, 2);
  assert.ok(find("unclassified", "unclassified").children.includes(find("Feature", "orphan").id));
  const unclassified = find("Work", `${second.sessionId}/${second.evidenceId}`);
  assert.deepEqual(unclassified.data.unresolvedFeatureKeys, ["unknown-feature"]);
  assert.ok(find("unclassified", "unclassified").children.includes(unclassified.id));
  // How these facts read once published is covered by the publication tests below.
  assert.equal(workNode.data.content.pending[0], "모바일 검증과 외부 배포는 실행하지 않았습니다.");
  assert.equal(find("Feature", "fa").narrative.useFlow, "계정을 입력한 뒤 로그인합니다.");
  assert.equal(basis.authority.recoveryAuthority, false);
});

test("renaming does not change logical page identity; current ownership changes remain actual Canon relationships", (t) => {
  const f = fixture(t),
    before = readProjectDocumentBasis({ root: f.root, sessionId: f.a });
  f.model.features[0].name = "새 로그인 이름";
  f.model.features[0].featureGroupKeys = ["g2"];
  f.write();
  const after = readProjectDocumentBasis({ root: f.root, sessionId: f.a });
  const old = before.nodes.find((n) => n.kind === "Feature" && n.key === "fa"),
    fresh = after.nodes.find((n) => n.kind === "Feature" && n.key === "fa");
  assert.equal(old.id, fresh.id);
  assert.notEqual(before.basisId, after.basisId);
  assert.equal(fresh.title, "새 로그인 이름");
  assert.equal(fresh.parents.length, 1);
  assert.equal(after.nodes.find((n) => n.id === fresh.parents[0]).key, "g2");
});

test("actual absence allows unclassified work; malformed Canon and permission denial preserve primary failure", (t) => {
  const f = fixture(t),
    record = f.save(f.a, "설명만 작성한 결과도 유효합니다.");
  const options = { root: f.root, sessionId: f.a, workEvidence: [select(record, ["fa"])] };
  fs.unlinkSync(f.canon);
  const absent = readProjectDocumentBasis(options);
  assert.equal(absent.productCanon.status, "missing-empty-default");
  assert.equal(absent.nodes.filter((n) => n.kind === "Feature").length, 0);
  assert.equal(absent.nodes.find((n) => n.kind === "Work").data.unresolvedFeatureKeys[0], "fa");
  fs.writeFileSync(f.canon, "{ malformed Canon");
  assert.throws(() => readProjectDocumentBasis(options), { code: "INVALID_PRODUCT_MODEL_JSON" });
  f.write();
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", function (file, ...args) {
    if (String(file) === f.canon) throw Object.assign(new Error("Synthetic permission refusal"), { code: "EACCES" });
    return read.call(this, file, ...args);
  });
  assert.throws(() => readProjectDocumentBasis(options), { code: "EACCES" });
});

test("Project P5 is shared across logical Sessions; task stores and Session direction remain separate", (t) => {
  const f = fixture(t),
    a = projectDocumentStore({ root: f.root, sessionId: f.a }),
    b = projectDocumentStore({ root: f.root, sessionId: f.b });
  const aState = fs.readFileSync(path.join(f.root, a.caller.statePath)),
    bState = fs.readFileSync(path.join(f.root, b.caller.statePath));
  assert.equal(a.file("receipt.json"), b.file("receipt.json"));
  a.write(["receipt.json"], { links: ["A"] });
  assert.deepEqual(b.read("receipt.json"), { links: ["A"] });
  const envelope = JSON.parse(fs.readFileSync(a.file("receipt.json")));
  assert.equal(envelope.authorityPlane, "P5");
  assert.equal(envelope.sessionId, null);
  assert.equal(envelope.executionReplayAllowed, false);
  const taskA = workDocumentStore({ root: f.root, sessionId: f.a }),
    taskB = workDocumentStore({ root: f.root, sessionId: f.b });
  taskA.write(["selection.json"], { owner: "A" });
  assert.equal(taskB.read("selection.json"), null);
  assert.deepEqual(fs.readFileSync(path.join(f.root, a.caller.statePath)), aState);
  assert.deepEqual(fs.readFileSync(path.join(f.root, b.caller.statePath)), bState);
});

test("destination aliases share actual resource identity; child Notion scope keeps exact parent and one publication budget", async (t) => {
  const f = fixture(t),
    parent = "10000000-0000-4000-8000-000000000001",
    container = "10000000-0000-4000-8000-000000000002",
    page = "10000000-0000-4000-8000-000000000003";
  assert.equal(
    documentDestinationIdentity({ kind: "obsidian", id: "alpha", vaultRoot: f.vault }),
    documentDestinationIdentity({ kind: "obsidian", id: "beta", vaultRoot: path.join(f.vault, ".") }),
  );
  assert.equal(
    documentDestinationIdentity({ kind: "notion", parentPageId: parent }),
    documentDestinationIdentity({ kind: "notion", parentPageId: parent.replaceAll("-", "") }),
  );
  let calls = 0;
  const request = async (call) => {
    calls++;
    const url = new URL(call.url),
      id = url.pathname.split("/")[3];
    return {
      status: 200,
      body: url.pathname.endsWith("/markdown")
        ? { object: "page_markdown", id, markdown: "Synthetic body", truncated: false, unknown_block_ids: [] }
        : { object: "page", id, parent: { page_id: id === container ? parent : container } },
    };
  };
  const adapter = createNotionWorkDocumentAdapter({ parentPageId: parent, request, requestBudget: 3 }),
    child = adapter.scoped(container);
  adapter.beginPublication();
  await adapter.read(container);
  child.beginPublication();
  await assert.rejects(child.read(page), { code: "WORK_DOCUMENT_TRANSPORT_BUDGET" });
  assert.equal(calls, 3, "child begin cannot reset the shared transport budget");
  adapter.beginPublication();
  await assert.rejects(adapter.read(page), { code: "WORK_DOCUMENT_REMOTE_DRIFT" });
  assert.throws(() => createNotionWorkDocumentAdapter({ parentPageId: parent, request, _sharedBudget: { used: -100, deadline: Infinity } }));
});

const connect = (f, sessionId = f.a, id = "docs", projectDocuments = true) =>
  configureWorkDocuments({ root: f.root, sessionId, targets: [{ id, kind: "obsidian", vaultRoot: f.vault, automatic: false, todoIds: [], projectDocuments }] });
async function finish(f, prepared, sessionId = f.a, targetId = "docs", extra = {}) {
  for (let i = 0; i < 400; i++) {
    const result = await publishProjectDocuments({ root: f.root, sessionId, projectionId: prepared.projectionId, targetIds: [targetId], ...extra });
    if (result.status === "published") return result;
    assert.equal(result.status, "continuation-required", JSON.stringify(result));
  }
  assert.fail("Bounded continuation made no terminal progress");
}
async function publishResult(f, projectionId, targetIds = ["docs"], sessionId = f.a, adapters) {
  for (let i = 0; i < 8; i++) {
    const result = await publishWorkDocuments({ root: f.root, sessionId, projectionId, targetIds, adapters });
    if (result.status !== "continuation-required") return result;
  }
  assert.fail("Result publication made no terminal progress");
}
function vaultFiles(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? vaultFiles(path.join(directory, entry.name)) : [path.join(directory, entry.name)]));
}
const assertVaultLinks = (vault) => {
  for (const file of vaultFiles(vault))
    for (const match of fs.readFileSync(file, "utf8").matchAll(/\]\(([^)]+\.md)\)/g))
      assert.ok(fs.existsSync(path.resolve(path.dirname(file), decodeURIComponent(match[1]))), "real relative link exists: " + file + " -> " + match[1]);
};
const productDir = (f, title = "same-name") => path.join(f.vault, "Lode", title);
test("project scope is explicit; the tree navigates; a reading's result is linked from 작업 기록; same-basis replay changes nothing", async (t) => {
  const f = fixture(t),
    record = f.save(f.a, "로그인 동작을 설명했습니다.");
  const pair = await prepareWorkDocuments({
    root: f.root,
    sessionId: f.a,
    title: "로그인 근거",
    taskEvidenceId: record.evidenceId,
    evidenceIds: [record.evidenceId],
    featureKeys: ["fa"],
  });
  connect(f, f.a, "docs", false);
  const prepared = await prepareProjectDocuments({
    root: f.root,
    sessionId: f.a,
    projectTitle: "같은 제품",
    workEvidence: [select(record, ["fa"])],
    readings: [{ sessionId: f.a, projectionId: pair.projectionId }],
  });
  const denied = await publishProjectDocuments({ root: f.root, sessionId: f.a, projectionId: prepared.projectionId, targetIds: ["docs"] });
  assert.equal(denied.destinations[0].status, "project-scope-not-connected");
  assert.deepEqual(fs.readdirSync(f.vault), []);
  const current = workDocumentStore({ root: f.root, sessionId: f.a }).read("configuration.json");
  configureWorkDocuments({
    root: f.root,
    sessionId: f.a,
    expectedConfigurationDigest: current.configurationDigest,
    targets: [{ id: "docs", kind: "obsidian", vaultRoot: f.vault, automatic: false, todoIds: [], projectDocuments: true }],
  });
  assert.equal((await publishResult(f, pair.projectionId)).status, "published");
  await finish(f, prepared);
  const files = vaultFiles(f.vault),
    project = projectDocumentStatus({ root: f.root, sessionId: f.a }).destinations[0].current;
  assert.equal(project.remoteCAS, false);
  assert.equal(project.layoutVersion, 2);
  assert.ok(
    files.every((file) => file.startsWith(productDir(f, "같은 제품") + path.sep)),
    "everything lives in the product folder",
  );
  assertVaultLinks(f.vault);
  assert.ok(!files.some((file) => /^(Start|Notes)\.md$/.test(path.basename(file))));
  const records = fs.readFileSync(path.join(productDir(f, "같은 제품"), "작업 기록", "작업 기록.md"), "utf8");
  assert.match(records, /### 로그인 동작을 설명했습니다\./);
  assert.match(records, /\[로그인 근거 결과 1\]\(\.\.\/계정|\[로그인 근거 결과 1\]\(\.\.\/%EA%B3%84%EC%A0%95/);
  assert.ok(files.some((file) => fs.readFileSync(file, "utf8").includes("정확한 변경 전후 비교는 선택하지 않았습니다")));
  const conditions = fs.readFileSync(path.join(productDir(f, "같은 제품"), "결정과 조건", "결정과 조건.md"), "utf8");
  assert.match(conditions, /- \[네트워크 재시도는 사용자가 선택합니다\.\]\([^)]+\) — 결정/);
  const before = new Map(files.map((file) => [file, fs.readFileSync(file)]));
  await finish(f, prepared);
  assert.equal(vaultFiles(f.vault).length, files.length, "same-basis publish creates no new artifacts");
  for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(file), bytes);
});

test("folder documents change in place while unchanged by people; a person's edit is kept and reported; no history copies", async (t) => {
  const f = fixture(t);
  connect(f);
  let prepared = await prepareProjectDocuments({ root: f.root, sessionId: f.a });
  await finish(f, prepared);
  const feature = path.join(productDir(f), "계정", "보안", "만료 안내", "만료 안내.md");
  const count = vaultFiles(f.vault).length;
  for (const text of ["First change", "Second change"]) {
    f.model.features[1].description = text;
    f.write();
    prepared = await prepareProjectDocuments({ root: f.root, sessionId: f.a });
    await finish(f, prepared);
    assert.match(fs.readFileSync(feature, "utf8"), new RegExp("> " + text));
  }
  assert.equal(vaultFiles(f.vault).length, count, "updates are in place: no history documents");
  const body = fs.readFileSync(feature),
    mtime = fs.statSync(feature).mtimeMs;
  const record = f.save(f.a, "A-only evidence one");
  prepared = await prepareProjectDocuments({ root: f.root, sessionId: f.a, workEvidence: [select(record, ["fa"])] });
  await finish(f, prepared);
  assert.deepEqual(fs.readFileSync(feature), body);
  assert.equal(fs.statSync(feature).mtimeMs, mtime, "no write to an unchanged document");
  fs.appendFileSync(feature, "\n사람이 덧붙인 메모\n");
  f.model.features[1].description = "Third change";
  f.write();
  prepared = await prepareProjectDocuments({ root: f.root, sessionId: f.a });
  const result = await finish(f, prepared);
  assert.deepEqual(
    result.destinations[0].personEdited.map((value) => value.document),
    ["만료 안내"],
  );
  const kept = fs.readFileSync(feature, "utf8");
  assert.ok(kept.endsWith("사람이 덧붙인 메모\n"));
  assert.ok(!kept.includes("Third change"), "a person's document is not rewritten");
  updateProjectDirection({
    root: f.root,
    input: { goal: "Synthetic work direction, not Product purpose", constraints: ["Keep the quoted source conditions"], decisions: [], cancelledActions: [] },
  });
  prepared = await prepareProjectDocuments({ root: f.root, sessionId: f.a });
  await finish(f, prepared);
  for (const file of vaultFiles(f.vault).filter((name) => !name.split(path.sep).includes("근거")))
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /direction-|[a-f0-9]{64}/, file);
});

test("a shared destination keeps A/B contributions; renaming keeps folders, follows titles, and keeps listing the folder where it stays", async (t) => {
  const f = fixture(t),
    a = f.save(f.a, "A 기록"),
    b = f.save(f.b, "B 기록");
  connect(f);
  connect(f, f.b, "alias");
  const first = await prepareProjectDocuments({ root: f.root, sessionId: f.a, workEvidence: [select(a, ["fa"])] });
  await finish(f, first);
  const second = await prepareProjectDocuments({ root: f.root, sessionId: f.b, workEvidence: [select(b, ["fb"])] });
  await finish(f, second, f.b, "alias");
  const sa = projectDocumentStatus({ root: f.root, sessionId: f.a }).destinations[0].current;
  const sb = projectDocumentStatus({ root: f.root, sessionId: f.b }).destinations[0].current;
  assert.equal(sa.productDocument, sb.productDocument);
  assert.equal(sb.projectionId, second.projectionId);
  f.model.features[0].name = "새 로그인";
  f.model.features[0].featureGroupKeys = ["g2"];
  f.write();
  const third = await prepareProjectDocuments({ root: f.root, sessionId: f.a, workEvidence: [select(a, ["fa"])] });
  await finish(f, third);
  const records = fs.readFileSync(path.join(productDir(f), "작업 기록", "작업 기록.md"), "utf8");
  assert.ok(records.includes("A 기록") && records.includes("B 기록"), "unselected B is retained");
  const login = path.join(productDir(f), "계정", "로그인", "로그인.md");
  assert.ok(fs.existsSync(login), "the folder is not moved or renamed");
  assert.ok(!fs.existsSync(path.join(productDir(f), "계정", "보안", "새 로그인")));
  const text = fs.readFileSync(login, "utf8");
  assert.match(text, /^# 새 로그인\n/);
  assert.match(text, /상위: \[보안\]\([^)]+\)\n/, "parents follow the current model");
  assert.match(
    fs.readFileSync(path.join(productDir(f), "계정", "보안", "보안.md"), "utf8"),
    /- \[새 로그인\]\(\.\.\/%EB%A1%9C%EA%B7%B8%EC%9D%B8\/[^)]+\) — 기능/,
  );
  assertVaultLinks(f.vault);
  const beforeUnknown = projectDocumentStatus({ root: f.root, sessionId: f.a }).destinations[0].current;
  const bOwner = projectDocumentStore({ root: f.root, sessionId: f.b }).caller,
    bPath = path.join(f.root, bOwner.workDirectory, b.evidenceId + ".json"),
    read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", function (file, ...args) {
    if (path.resolve(String(file)) === path.resolve(bPath)) throw Object.assign(new Error("Synthetic prior contributor denied"), { code: "EACCES" });
    return read.call(this, file, ...args);
  });
  await assert.rejects(prepareProjectDocuments({ root: f.root, sessionId: f.a, workEvidence: [select(a, ["fa"])] }), (error) =>
    Boolean(error.code && error.primaryReasonCode),
  );
  assert.deepEqual(projectDocumentStatus({ root: f.root, sessionId: f.a }).destinations[0].current, beforeUnknown);
});

test("same-title Projects share one vault and one Notion parent with separate product folders and pages", async (t) => {
  const a = fixture(t),
    b = fixture(t),
    fake = notionFixture();
  b.vault = a.vault;
  for (const f of [a, b])
    configureWorkDocuments({
      root: f.root,
      sessionId: f.a,
      targets: [
        { id: "docs", kind: "obsidian", vaultRoot: f.vault, automatic: false, todoIds: [], projectDocuments: true },
        {
          id: "notion",
          kind: "notion",
          parentPageId: fake.parent,
          tokenEnvironment: "LODE_SYNTHETIC_UNUSED",
          automatic: false,
          todoIds: [],
          projectDocuments: true,
        },
      ],
    });
  const pa = await prepareProjectDocuments({ root: a.root, sessionId: a.a, projectTitle: "Same title" });
  const pb = await prepareProjectDocuments({ root: b.root, sessionId: b.a, projectTitle: "Same title" });
  for (const [f, p] of [
    [a, pa],
    [b, pb],
  ]) {
    await finish(f, p);
    await finish(f, p, f.a, "notion", { adapters: { notion: fake.adapter } });
  }
  const roots = [...fake.pages.values()].filter((page) => page.parent.page_id === fake.parent);
  assert.equal(roots.length, 2);
  assert.equal(new Set(roots.map((page) => page.title)).size, 2, "titles under one parent never repeat");
  assert.deepEqual(
    fs
      .readdirSync(path.join(a.vault, "Lode"))
      .map((name) => name.replace(/ \([a-f0-9]{4,}\)$/, ""))
      .sort(),
    ["Same title", "Same title"],
  );
  const bPage = roots.find((page) => page.title !== "Same title") || roots[1];
  const oldB = bPage.markdown;
  a.model.features[0].description = "Only Project A changed";
  a.write();
  const next = await prepareProjectDocuments({ root: a.root, sessionId: a.a, projectTitle: "Same title" });
  await finish(a, next, a.a, "notion", { adapters: { notion: fake.adapter } });
  assert.equal(fake.pages.get(bPage.id).markdown, oldB);
  assert.ok([...fake.pages.values()].some((page) => page.markdown.includes("Only Project A changed")));
});

test("many documents progress without restarting; a stale basis is refused; a person's edit is reported, not overwritten", async (t) => {
  const f = fixture(t);
  connect(f);
  for (let i = 0; i < 35; i++) f.model.features.push({ key: "extra" + i, name: "항목 " + i, featureGroupKeys: ["g1"], capabilityKeys: [], governedBy: [] });
  f.write();
  const prepared = await prepareProjectDocuments({ root: f.root, sessionId: f.a });
  const initial = await publishProjectDocuments({ root: f.root, sessionId: f.a, projectionId: prepared.projectionId, targetIds: ["docs"] });
  assert.equal(initial.status, "continuation-required");
  assert.ok(initial.destinations[0].documentCount > 40);
  const progressed = await publishProjectDocuments({ root: f.root, sessionId: f.a, projectionId: prepared.projectionId, targetIds: ["docs"] });
  assert.equal(progressed.destinations[0].processed, initial.destinations[0].processed + 3, "no prefix restart");
  f.model.features[0].name = "새 제목";
  f.write();
  const stale = await publishProjectDocuments({ root: f.root, sessionId: f.a, projectionId: prepared.projectionId, targetIds: ["docs"] });
  assert.equal(stale.destinations[0].reasonCode, "PROJECT_DOCUMENT_SOURCE_CHANGED");
  const fresh = await prepareProjectDocuments({ root: f.root, sessionId: f.a });
  await finish(f, fresh);
  assert.equal(vaultFiles(path.join(productDir(f), "계정")).filter((file) => /항목 \d+\.md$/.test(file)).length, 35);
  const home = path.join(productDir(f), "same-name.md");
  fs.appendFileSync(home, "\nUser edit\n");
  f.model.features[1].name = "또 바뀐 이름";
  f.write();
  const next = await prepareProjectDocuments({ root: f.root, sessionId: f.a });
  const edited = await finish(f, next);
  assert.ok(edited.destinations[0].personEdited.some((value) => value.document === "same-name"));
  assert.ok(fs.readFileSync(home, "utf8").endsWith("User edit\n"));
});

test("automatic publication files a saved analysis under its feature without a Todo; a retained narrative is marked as about an earlier original", async (t) => {
  const f = fixture(t);
  configureWorkDocuments({
    root: f.root,
    sessionId: f.a,
    targets: [{ id: "docs", kind: "obsidian", vaultRoot: f.vault, automatic: true, todoIds: [], projectDocuments: true }],
  });
  const saved = await withSessionRoute(f.root, f.a, () =>
    recordSessionWorkAndProjectDocuments({
      root: f.root,
      input: { summary: "분석만 수행했고 배포는 실행하지 않았습니다." },
      documentSelection: { featureKeys: ["fa"] },
    }),
  );
  assert.equal(saved.status, "session_work_evidence_recorded");
  assert.equal(saved.documentProjection.projectDocuments.resultDocuments.status, "published");
  assert.equal(saved.documentProjection.projectDocuments.status, "continuation-required");
  const follow = saved.documentProjection.projectDocuments.followUp;
  await finish(f, { projectionId: follow.projectionId });
  const results = vaultFiles(path.join(productDir(f), "계정", "로그인")).filter((file) => / 결과 1\.md$/.test(file));
  assert.equal(results.length, 1, "the result file sits in the chosen feature folder");
  assert.ok(!vaultFiles(f.vault).some((file) => /^(Start|Notes)\.md$/.test(path.basename(file))), "no per-task Start or Notes documents");
  const first = await prepareProjectDocuments({
    root: f.root,
    sessionId: f.a,
    narratives: [{ kind: "Feature", key: "fa", sourceKeys: ["Feature:fa"], currentBehavior: "로그인 설명 원문을 읽었습니다." }],
  });
  await finish(f, first);
  const login = path.join(productDir(f), "계정", "로그인", "로그인.md");
  assert.match(fs.readFileSync(login, "utf8"), /## 현재 동작에 대한 설명\n\n로그인 설명 원문을 읽었습니다\./);
  f.model.features[0].description = "이전과 달라진 원문";
  f.write();
  const next = await prepareProjectDocuments({ root: f.root, sessionId: f.a });
  await finish(f, next);
  const text = fs.readFileSync(login, "utf8");
  assert.ok(text.includes("이전에 선택한 원문") && text.includes("로그인 설명 원문을 읽었습니다"));
  assert.match(text, /## 이 기능의 결과\n\n- \[/, "the results list survives whole-document updates");
});

test("damaged optional publication configuration cannot hide or fail an already saved P3 result", async (t) => {
  const f = fixture(t);
  connect(f);
  const taskStore = workDocumentStore({ root: f.root, sessionId: f.a });
  fs.writeFileSync(taskStore.file("configuration.json"), "{ broken optional operational record");
  const result = await withSessionRoute(f.root, f.a, () =>
    recordSessionWorkAndProjectDocuments({ root: f.root, input: { summary: "Saved independently of optional publication" } }),
  );
  assert.equal(result.status, "session_work_evidence_recorded");
  assert.equal(result.documentProjection.originalWorkSaved, true);
  assert.equal(result.documentProjection.reasonCode, "WORK_DOCUMENT_RECORD_TAMPER");
  assert.equal(result.documentProjection.ordinaryWorkBlocked, false);
  assert.deepEqual(fs.readdirSync(f.vault), []);
});

function notionFixture() {
  const parent = "10000000-0000-4000-8000-000000000001",
    pages = new Map(),
    calls = [],
    fault = {};
  let sequence = 10;
  const request = async (call) => {
    const url = new URL(call.url);
    calls.push({ method: call.method, url: call.url, body: call.body });
    if (call.method === "POST") {
      if (fault.reject) return { status: 403, body: { object: "error", status: 403, code: "restricted_resource", message: "Synthetic bounded refusal" } };
      const id = "10000000-0000-4000-8000-" + String(sequence++).padStart(12, "0"),
        page = {
          id,
          parent: { page_id: call.body.parent.page_id },
          title: call.body.properties.title.title.map((part) => part.text.content).join(""),
          markdown: call.body.markdown,
        };
      pages.set(id, page);
      if (fault.lose) {
        fault.lose = false;
        throw Object.assign(new Error("Synthetic response loss"), { code: "ECONNRESET" });
      }
      return { status: 200, body: { object: "page", id, parent: page.parent } };
    }
    if (url.pathname.includes("/blocks/")) {
      const id = url.pathname.split("/")[3],
        children = [...pages.values()].filter((page) => page.parent.page_id === id);
      const offset = Number(url.searchParams.get("start_cursor") || 0),
        chunk = children.slice(offset, offset + 100);
      return {
        status: 200,
        body: {
          results: chunk.map((page) => ({ id: page.id, type: "child_page", child_page: { title: page.title ?? "" } })),
          has_more: offset + 100 < children.length,
          next_cursor: String(offset + 100),
        },
      };
    }
    if (url.pathname.includes("/async_tasks/"))
      return {
        status: 200,
        body: {
          id: "task_fixture",
          status: fault.taskStatus || "running",
          ...(fault.taskStatus === "succeeded" ? { result: { object: "page_markdown", id: fault.taskPageId } } : {}),
        },
      };
    const match = /\/pages\/([^/]+)(\/markdown)?$/.exec(url.pathname),
      page = pages.get(match?.[1]);
    if (!page) return { status: 404, body: { object: "error" } };
    if (call.method === "PATCH") {
      if (fault.rejectPatch)
        return { status: 403, body: { object: "error", status: 403, code: "restricted_resource", message: "Synthetic progress marker refusal" } };
      const { old_str, new_str } = call.body.update_content.content_updates[0];
      assert.equal(page.markdown.split(old_str).length, 2);
      page.markdown = page.markdown.replace(old_str, new_str);
      if (fault.losePatch || fault.losePatchId === page.id) {
        fault.losePatch = false;
        fault.losePatchId = null;
        throw Object.assign(new Error("Lost update"), { code: "ECONNRESET" });
      }
      if (fault.asyncPatch) {
        fault.asyncPatch = false;
        fault.taskPageId = page.id;
        return { status: 202, body: { id: "task_fixture", status: "queued", poll_after_seconds: 1 } };
      }
    }
    return {
      status: 200,
      body: match[2]
        ? { object: "page_markdown", id: page.id, markdown: page.markdown, truncated: false, unknown_block_ids: [] }
        : { object: "page", id: page.id, parent: page.parent, properties: { title: { title: [{ plain_text: page.title ?? "" }] } } },
    };
  };
  return { parent, pages, calls, fault, adapter: createNotionWorkDocumentAdapter({ parentPageId: parent, request }), request };
}
const notionTarget = (fake) => ({
  id: "notion",
  kind: "notion",
  parentPageId: fake.parent,
  tokenEnvironment: "LODE_SYNTHETIC_UNUSED",
  automatic: false,
  todoIds: [],
  projectDocuments: true,
});
test("Notion: a lost product create after a title change binds the one page; titles follow; foreign and refused retries stay exact", async (t) => {
  const f = fixture(t),
    fake = notionFixture();
  configureWorkDocuments({ root: f.root, sessionId: f.a, targets: [notionTarget(fake)] });
  const first = await prepareProjectDocuments({ root: f.root, sessionId: f.a, projectTitle: "Old name" });
  fake.fault.lose = true;
  const lost = await publishProjectDocuments({
    root: f.root,
    sessionId: f.a,
    projectionId: first.projectionId,
    targetIds: ["notion"],
    adapters: { notion: fake.adapter },
  });
  assert.equal(lost.destinations[0].reasonCode, "ECONNRESET");
  const fresh = await prepareProjectDocuments({ root: f.root, sessionId: f.a, projectTitle: "New name" });
  await finish(f, fresh, f.a, "notion", { adapters: { notion: fake.adapter } });
  const roots = [...fake.pages.values()].filter((page) => page.parent.page_id === fake.parent);
  assert.equal(roots.length, 1, "renaming cannot replay the unresolved old create");
  assert.equal(roots[0].title, "Old name", "the page keeps the name it was created with");
  assert.match(roots[0].markdown, /^# New name\n/, "the document title follows the current title");
  for (const page of fake.pages.values())
    for (const link of page.markdown.matchAll(/https:\/\/www\.notion\.so\/([a-f0-9]{32})/g)) {
      assert.ok([...fake.pages.keys()].some((id) => id.replaceAll("-", "") === link[1]));
    }
  const before = fake.calls.length;
  const invalid = await publishProjectDocuments({
    root: f.root,
    sessionId: f.a,
    projectionId: fresh.projectionId,
    targetIds: ["notion"],
    adapters: { notion: fake.adapter },
    retryRejectedWrites: [{ targetId: "notion", attemptId: "a".repeat(64) }],
  });
  assert.equal(invalid.destinations[0].reasonCode, "WORK_DOCUMENT_RETRY_SCOPE_CHANGED");
  assert.equal(fake.calls.length, before);
  const another = fixture(t),
    refusal = notionFixture();
  refusal.fault.reject = true;
  configureWorkDocuments({ root: another.root, sessionId: another.a, targets: [notionTarget(refusal)] });
  const p = await prepareProjectDocuments({ root: another.root, sessionId: another.a });
  const options = { root: another.root, sessionId: another.a, projectionId: p.projectionId, targetIds: ["notion"], adapters: { notion: refusal.adapter } };
  const rejected = await publishProjectDocuments(options);
  assert.equal(rejected.destinations[0].status, "request-rejected-no-write");
  refusal.fault.reject = false;
  const posts = refusal.calls.filter((call) => call.method === "POST").length;
  const again = await publishProjectDocuments(options);
  assert.equal(again.destinations[0].status, "request-rejected-no-write");
  assert.equal(refusal.calls.filter((call) => call.method === "POST").length, posts);
  const retried = await publishProjectDocuments({ ...options, retryRejectedWrites: [rejected.destinations[0].retry] });
  assert.equal(retried.status, "continuation-required");
  await finish(another, p, another.a, "notion", { adapters: { notion: refusal.adapter } });
});

test("Project async updates require terminal success even when the new body is visible; a failed task cannot publish or replay", async (t) => {
  for (const disposition of ["succeeded", "failed"])
    await t.test(disposition, async (t) => {
      let clock = Date.now();
      t.mock.method(Date, "now", () => clock);
      const f = fixture(t),
        fake = notionFixture();
      configureWorkDocuments({ root: f.root, sessionId: f.a, targets: [notionTarget(fake)] });
      const prepared = await prepareProjectDocuments({ root: f.root, sessionId: f.a }),
        options = { root: f.root, sessionId: f.a, projectionId: prepared.projectionId, targetIds: ["notion"], adapters: { notion: fake.adapter } };
      fake.fault.asyncPatch = true;
      const pending = await publishProjectDocuments(options);
      assert.equal(pending.destinations[0].reasonCode, "WORK_DOCUMENT_ASYNC_PENDING");
      const posts = fake.calls.filter((call) => call.method === "POST").length;
      clock += 2000;
      const still = await publishProjectDocuments(options);
      assert.equal(still.destinations[0].reasonCode, "WORK_DOCUMENT_ASYNC_PENDING");
      assert.equal(fake.calls.filter((call) => call.method === "POST").length, posts, "nothing else is written while a change is pending");
      assert.equal(projectDocumentStatus({ root: f.root, sessionId: f.a }).destinations[0].current, null);
      fake.fault.taskStatus = disposition;
      clock += 2000;
      if (disposition === "succeeded") await finish(f, prepared, f.a, "notion", { adapters: { notion: fake.adapter } });
      else {
        const failed = await publishProjectDocuments(options);
        assert.equal(failed.destinations[0].reasonCode, "WORK_DOCUMENT_ASYNC_FAILED");
        const again = await publishProjectDocuments(options);
        assert.equal(again.destinations[0].reasonCode, "WORK_DOCUMENT_ASYNC_FAILED");
        assert.equal(projectDocumentStatus({ root: f.root, sessionId: f.a }).destinations[0].current, null);
        assert.equal(fake.calls.filter((call) => call.method === "POST").length, posts);
      }
      // The async change itself was sent once; later list updates of the same page are new changes.
      const asyncBody = JSON.stringify(
        fake.calls.find((call) => call.method === "PATCH" && new URL(call.url).pathname === "/v1/pages/" + fake.fault.taskPageId + "/markdown").body,
      );
      assert.equal(fake.calls.filter((call) => call.method === "PATCH" && JSON.stringify(call.body) === asyncBody).length, 1);
    });
});

test("a refused change stops the publication, is never retried automatically and keeps the prior current receipt", async (t) => {
  const f = fixture(t),
    fake = notionFixture();
  configureWorkDocuments({ root: f.root, sessionId: f.a, targets: [notionTarget(fake)] });
  const first = await prepareProjectDocuments({ root: f.root, sessionId: f.a });
  await finish(f, first, f.a, "notion", { adapters: { notion: fake.adapter } });
  const old = projectDocumentStatus({ root: f.root, sessionId: f.a }).destinations[0].current;
  f.model.features[0].name = "Successor title";
  f.write();
  const next = await prepareProjectDocuments({ root: f.root, sessionId: f.a }),
    options = { root: f.root, sessionId: f.a, projectionId: next.projectionId, targetIds: ["notion"], adapters: { notion: fake.adapter } };
  fake.fault.rejectPatch = true;
  let refused;
  for (let i = 0; i < 40; i++) {
    refused = await publishProjectDocuments(options);
    if (refused.status !== "continuation-required") break;
  }
  assert.equal(refused.destinations[0].status, "request-rejected-no-write");
  assert.deepEqual(projectDocumentStatus({ root: f.root, sessionId: f.a }).destinations[0].current, old);
  fake.fault.rejectPatch = false;
  const before = fake.calls.length,
    notRetried = await publishProjectDocuments(options);
  assert.equal(notRetried.destinations[0].status, "request-rejected-no-write");
  assert.equal(fake.calls.slice(before).filter((call) => call.method !== "GET").length, 0);
  const allowed = await publishProjectDocuments({ ...options, retryRejectedWrites: [refused.destinations[0].retry] });
  assert.notEqual(allowed.destinations[0].status, "request-rejected-no-write");
  await finish(f, next, f.a, "notion", { adapters: { notion: fake.adapter } });
  assert.ok([...fake.pages.values()].some((page) => page.markdown.startsWith("# Successor title\n")));
});

test("unknown creation beyond 65 siblings reaches candidate evidence without claiming current uniqueness or another POST", async (t) => {
  const f = fixture(t),
    fake = notionFixture(),
    store = projectDocumentStore({ root: f.root, sessionId: f.a });
  for (let i = 0; i < 70; i++)
    fake.pages.set("10000000-0000-4000-8000-" + String(100 + i).padStart(12, "0"), {
      id: "10000000-0000-4000-8000-" + String(100 + i).padStart(12, "0"),
      parent: { page_id: fake.parent },
      markdown: "Other " + i,
    });
  const writer = createDocumentEffectWriter({
    store,
    adapter: fake.adapter,
    key: "synthetic-search",
    target: { id: "notion" },
    configurationDigest: "a".repeat(64),
    prepared: { projectionId: "b".repeat(64) },
    previous: null,
  });
  fake.fault.lose = true;
  await assert.rejects(writer.create("page", "Start.md", "Exact title", "Exact body"), { code: "ECONNRESET" });
  let candidate;
  for (let i = 0; i < 12; i++) {
    fake.adapter.beginPublication();
    try {
      await writer.create("page", "Start.md", "Exact title", "Exact body");
      assert.fail("Paged observations must not create a binding");
    } catch (error) {
      if (error.code === "WORK_DOCUMENT_CREATE_CANDIDATE_UNCONFIRMED") {
        candidate = error;
        break;
      }
      assert.equal(error.code, "WORK_DOCUMENT_CREATE_UNKNOWN");
    }
  }
  assert.ok(candidate?.candidateObservations.some((value) => value.status === "exact-body-at-last-read"));
  assert.equal(candidate.primaryReasonCode, "WORK_DOCUMENT_CREATE_UNKNOWN");
  assert.equal(fake.calls.filter((call) => call.method === "POST").length, 1);
  const first = [...fake.pages.values()][0];
  first.markdown = "Exact body";
  fake.adapter.beginPublication();
  await assert.rejects(writer.create("page", "Start.md", "Exact title", "Exact body"), { code: "WORK_DOCUMENT_CREATE_CANDIDATE_UNCONFIRMED" });
  assert.equal(fs.existsSync(store.file("recovered")), false);
});

test("a lost update is settled from readback before anything else; restoring the source restores the document", async (t) => {
  const f = fixture(t),
    fake = notionFixture();
  configureWorkDocuments({ root: f.root, sessionId: f.a, targets: [notionTarget(fake)] });
  const originalBytes = fs.readFileSync(f.canon),
    first = await prepareProjectDocuments({ root: f.root, sessionId: f.a });
  await finish(f, first, f.a, "notion", { adapters: { notion: fake.adapter } });
  const login = [...fake.pages.values()].find((page) => page.title === "로그인");
  const original = login.markdown;
  f.model.features[0].description = "Uncertain successor body must not survive source restoration";
  f.write();
  const successor = await prepareProjectDocuments({ root: f.root, sessionId: f.a });
  fake.fault.losePatchId = login.id;
  let lost;
  for (let i = 0; i < 100; i++) {
    const result = await publishProjectDocuments({
      root: f.root,
      sessionId: f.a,
      projectionId: successor.projectionId,
      targetIds: ["notion"],
      adapters: { notion: fake.adapter },
    });
    if (result.status !== "continuation-required") {
      lost = result;
      break;
    }
  }
  assert.equal(lost.destinations[0].reasonCode, "ECONNRESET");
  assert.match(fake.pages.get(login.id).markdown, /Uncertain successor body/);
  fs.writeFileSync(f.canon, originalBytes);
  const restored = await prepareProjectDocuments({ root: f.root, sessionId: f.a });
  const result = await finish(f, restored, f.a, "notion", { adapters: { notion: fake.adapter } });
  assert.equal(result.destinations[0].personEdited, undefined, "a lost update is not mistaken for a person's edit");
  assert.equal(fake.pages.get(login.id).markdown, original);
});

test("paged prefix body drift and changed/deleted prior candidates never establish binding across restart or new basis", async (t) => {
  for (const mode of ["prefix-new-match", "old-match-changed", "old-match-deleted"])
    await t.test(mode, async (t) => {
      const f = fixture(t),
        fake = notionFixture(),
        store = projectDocumentStore({ root: f.root, sessionId: f.a });
      for (let i = 0; i < 12; i++) {
        const id = "10000000-0000-4000-8000-" + String(100 + i).padStart(12, "0");
        fake.pages.set(id, { id, parent: { page_id: fake.parent }, markdown: i === 0 && mode !== "prefix-new-match" ? "Exact body" : "Other " + i });
      }
      const make = (projectionId) =>
        createDocumentEffectWriter({
          store,
          adapter: fake.adapter,
          key: "same-owned-attempt",
          target: { id: "canonical-destination" },
          configurationDigest: "a".repeat(64),
          prepared: { projectionId },
          previous: null,
          stableContainerIds: ["Start.md"],
        });
      let writer = make("b".repeat(64));
      fake.fault.lose = true;
      await assert.rejects(writer.create("same", "Start.md", "Original title", "Exact body"), { code: "ECONNRESET" });
      fake.adapter.beginPublication();
      await assert.rejects(writer.create("same", "Start.md", "Original title", "Exact body"), { code: "WORK_DOCUMENT_CREATE_UNKNOWN" });
      const first = [...fake.pages.values()][0];
      if (mode === "prefix-new-match") first.markdown = "Exact body";
      else if (mode === "old-match-changed") first.markdown = "Changed content";
      else fake.pages.delete(first.id);
      writer = make("c".repeat(64));
      fake.adapter.beginPublication();
      let observed;
      for (let i = 0; i < 4; i++) {
        try {
          await writer.create("same", "Start.md", "Original title", "Exact body");
          assert.fail("Must not recover from paged observations");
        } catch (error) {
          if (error.code === "WORK_DOCUMENT_CREATE_CANDIDATE_UNCONFIRMED") {
            observed = error;
            break;
          }
          assert.equal(error.code, "WORK_DOCUMENT_CREATE_UNKNOWN");
        }
        fake.adapter.beginPublication();
      }
      assert.ok(observed);
      assert.equal(fake.calls.filter((call) => call.method === "POST").length, 1);
      assert.equal(fs.existsSync(store.file("recovered")), false);
      if (mode !== "prefix-new-match") assert.ok(observed.candidateObservations.some((row) => row.id === first.id && row.status !== "exact-body-at-last-read"));
      // Even a now-small listing or a lost replaceable search cache cannot erase
      // the immutable fact that this attempt required different-time slices.
      for (const page of [...fake.pages.values()])
        if (page.id !== observed.candidateObservations.find((row) => row.status === "exact-body-at-last-read")?.id) fake.pages.delete(page.id);
      for (const file of fs.readdirSync(store.file("search"))) fs.unlinkSync(store.file("search", file));
      fake.adapter.beginPublication();
      await assert.rejects(make("d".repeat(64)).create("same", "Start.md", "Original title", "Exact body"), {
        code: "WORK_DOCUMENT_CREATE_CANDIDATE_UNCONFIRMED",
      });
    });
});

test("typed MCP and CLI share Project identity; a retained before/after reading is published as a result and linked", async (t) => {
  const f = fixture(t),
    owner = f.store.caller;
  connect(f);
  updateProjectDirection({
    root: f.root,
    input: {
      goal: "Synthetic work direction, not Product purpose",
      constraints: ["External deployment is not authorized by this documentation"],
      decisions: [],
      cancelledActions: [],
    },
  });
  const retain = (text) => {
    const bytes = Buffer.from(text);
    fs.writeFileSync(path.join(f.root, "login.mjs"), bytes);
    const digest = workDocumentHash(bytes);
    retainSourceObservation(
      f.root,
      createSourceObservation(
        {
          version: 1,
          projectId: owner.projectId,
          kind: "source",
          query: [{ path: "login.mjs", symbol: "" }],
          sources: [{ path: "login.mjs", digest, base64: bytes.toString("base64") }],
          profile: {},
          observedAt: "2026-01-01T00:00:00Z",
          response: null,
          envelopeHash: null,
        },
        owner.storage,
      ),
      owner.storage,
    );
    return withSessionRoute(f.root, f.a, () =>
      recordSessionWorkEvidence({
        root: f.root,
        input: { summary: "Exact source quotation, not implementation proof", references: [{ kind: "source", path: "login.mjs", digest }] },
      }),
    ).evidence;
  };
  const before = retain("export function login() { return false; }\n");
  const after = retain("export function login() { return true; }\n");
  const call = async (name, args) => {
    const response = await dispatch({
      jsonrpc: "2.0",
      id: name,
      method: "tools/call",
      params: { name, arguments: { project_root: f.root, session_id: f.a, ...args } },
    });
    assert.equal(response.result?.isError, undefined, JSON.stringify(response));
    return response.result.structuredContent;
  };
  const pair = await call("lode_work_document_prepare", {
    title: "Actual before/after",
    task_evidence_id: before.evidenceId,
    evidence_ids: [before.evidenceId],
    feature_keys: ["fa", "not-a-feature"],
    related: [{ sessionId: f.a, evidenceId: after.evidenceId, evidenceDigest: after.evidenceDigest }],
    diffs: [{ before: { evidenceId: before.evidenceId, referenceIndex: 0 }, after: { evidenceId: after.evidenceId, referenceIndex: 0 } }],
    excerpts: [{ evidenceId: after.evidenceId, referenceIndex: 0, startLine: 1, endLine: 1 }],
  });
  assert.deepEqual(pair.rejectedFeatureKeys, ["not-a-feature"]);
  let published;
  for (let i = 0; i < 8; i++) {
    published = await call("lode_work_document_publish", { projection_id: pair.projectionId, target_ids: ["docs"] });
    if (published.status !== "continuation-required") break;
  }
  assert.equal(published.status, "published", JSON.stringify(published));
  assert.deepEqual(published.destinations[0].rejectedFeatureKeys, ["not-a-feature"]);
  const prepared = await call("lode_project_document_prepare", {
    work_evidence: [select(before, ["fa"]), select(after, ["fa"])],
    readings: [{ sessionId: f.a, projectionId: pair.projectionId }],
  });
  assert.ok(prepared?.projectionId);
  await finish(f, prepared);
  const cli = await withSessionRoute(f.root, f.a, () => runCommand(["project-document-status", f.root]));
  assert.equal(cli.projectId, owner.projectId);
  const resultDir = path.join(productDir(f), "계정", "로그인");
  const evidence = fs.readFileSync(path.join(resultDir, "근거", "Actual before after 결과 1 근거.md"), "utf8");
  assert.ok(evidence.includes("return false") && evidence.includes("return true") && evidence.includes("바이트 비교는 승인"));
  const human = fs.readFileSync(path.join(resultDir, "Actual before after 결과 1.md"), "utf8");
  assert.doesNotMatch(human, /return false|[a-f0-9]{64}/, "exact bytes and digests stay in the evidence document");
  for (const file of vaultFiles(f.vault)) assert.doesNotMatch(fs.readFileSync(file, "utf8"), /undefined/, file);
  assert.match(fs.readFileSync(path.join(productDir(f), "작업 기록", "작업 기록.md"), "utf8"), /\[Actual before after 결과 1\]/);
  assertVaultLinks(f.vault);
  if (process.env.LODE_PROJECT_DOCUMENT_QA_OUTPUT) {
    const output = process.env.LODE_PROJECT_DOCUMENT_QA_OUTPUT;
    fs.mkdirSync(output);
    const manifest = [];
    for (const file of vaultFiles(f.vault)) {
      const relative = path.relative(f.vault, file),
        target = path.join(output, relative),
        bytes = fs.readFileSync(file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes, { flag: "wx" });
      manifest.push({ path: relative.replaceAll(path.sep, "/"), bytes: bytes.length, sha256: workDocumentHash(bytes) });
    }
    fs.writeFileSync(
      path.join(output, "manifest.json"),
      JSON.stringify({ scope: "synthetic real vault generation; no live Notion or app GUI claim", projectId: owner.projectId, files: manifest }, null, 2) +
        "\n",
      { flag: "wx" },
    );
  }
});

// Layout v2 ("published documents readable for people"): every check publishes
// into a temporary vault or a fake Notion server.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject } from "../scripts/lib/session/lode-core.mjs";
import { createHeadSession, withSessionRoute } from "../scripts/lib/session/session-routing.mjs";
import { recordSessionWorkEvidence } from "../scripts/lib/session/session-work-context.mjs";
import { projectDocumentStore, workDocumentStore } from "../scripts/lib/world/work-document-store.mjs";
import { configureWorkDocuments, prepareWorkDocuments, publishWorkDocuments } from "../scripts/lib/world/work-document-publication.mjs";
import { createNotionWorkDocumentAdapter } from "../scripts/lib/world/work-document-destinations.mjs";
import { workDocumentHash } from "../scripts/lib/world/work-document-source.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const sampleModel = () => ({
  schemaVersion: 1,
  featureGroups: [
    { key: "g1", name: "계정", description: "계정 사용 흐름", parentFeatureGroupKeys: [] },
    { key: "g2", name: "보안", parentFeatureGroupKeys: ["g1"] },
    { key: "g3", name: "공유 구성", parentFeatureGroupKeys: ["g2", "g1"] },
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
    { key: "fc", name: "알림", featureGroupKeys: [], capabilityKeys: [], governedBy: [] },
  ],
  capabilities: [],
  requirements: [],
  constraints: [],
  decisions: [{ key: "d1", statement: "네트워크 재시도는 사용자가 선택합니다.", status: "active" }],
});

function fixture(t, { model = sampleModel(), name = "샘플 제품" } = {}) {
  const area = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lode-tree-")));
  const root = path.join(area, name),
    vault = path.join(area, "vault");
  fs.mkdirSync(root);
  fs.mkdirSync(vault);
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const sessionId = createHeadSession({ root, purpose: "Readable publication" }).sessionId;
  t.after(() => fs.rmSync(area, { recursive: true, force: true }));
  const store = projectDocumentStore({ root, sessionId });
  const canon = path.join(root, store.owner.storage.directory, "context", "product-model.json");
  const write = (value) => fs.writeFileSync(canon, JSON.stringify(value, null, 2) + "\n");
  if (model) write(model);
  const save = (todoId, task, status = "completed", prior = null, extra = {}) =>
    withSessionRoute(root, sessionId, () =>
      recordSessionWorkEvidence({
        root,
        input: {
          summary: `${task}: 문구를 저장하고 로컬 테스트 로그를 확인했습니다.`,
          judgments: [{ assessment: "자동 재시도를 넣지 않았습니다.", reason: "중복 요청이 생길 수 있기 때문입니다.", alternatives: ["사용자가 직접 재시도"] }],
          pending: ["모바일 검증과 배포는 실행하지 않았습니다."],
          unknowns: ["모바일 합의에 대한 사용자 원문이 없습니다."],
          todos: [
            {
              todoId,
              task,
              status,
              origin: "user-directed",
              ...(prior ? { prior: { evidenceId: prior.evidenceId, evidenceDigest: prior.evidenceDigest } } : {}),
              ...(status === "partial" ? { reason: "모바일 문구 남음", nextAction: "모바일 문구 수정" } : {}),
            },
          ],
          ...extra,
        },
      }),
    ).evidence;
  const connect = (targets = [{ id: "vault", kind: "obsidian", vaultRoot: vault, automatic: false, todoIds: [] }]) =>
    configureWorkDocuments({ root, sessionId, targets });
  const publish = async (evidence, todoId, title, featureKeys, targetIds = ["vault"], adapters) => {
    const prepared = await prepareWorkDocuments({ root, sessionId, todoId, evidenceIds: [evidence.evidenceId], title, featureKeys });
    // A new Notion tree can need more than one bounded publication call.
    let published;
    for (let call = 0; call < 8; call++) {
      published = await publishWorkDocuments({ root, sessionId, projectionId: prepared.projectionId, targetIds, adapters });
      if (published.status !== "continuation-required") break;
    }
    return { prepared, published };
  };
  return { area, root, vault, sessionId, store, canon, write, save, connect, publish };
}
const files = (vault) => {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (fs.statSync(file).isDirectory()) walk(file);
      else out.push(path.relative(vault, file).split(path.sep).join("/"));
    }
  };
  walk(vault);
  return out.sort();
};
const read = (vault, relative) => fs.readFileSync(path.join(vault, ...relative.split("/")), "utf8");
const links = (text) => [...text.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);
function assertLinksResolve(vault) {
  for (const file of files(vault).filter((name) => name.startsWith("Lode/")))
    for (const link of links(read(vault, file)).filter((value) => !/^https:/.test(value)))
      assert.ok(fs.existsSync(path.join(vault, ...path.posix.join(path.posix.dirname(file), decodeURIComponent(link)).split("/"))), `${file} -> ${link}`);
}
const isEvidence = (file) => file.split("/").includes("근거");

test("the sample product publishes the agreed tree with readable names and no broken links", async (t) => {
  // The agreed sample: two group levels, three features, two tasks, three results.
  const model = sampleModel();
  model.featureGroups = model.featureGroups.filter((group) => group.key !== "g3");
  model.features[0].featureGroupKeys = ["g1"];
  const f = fixture(t, { model });
  f.connect();
  const login = f.save("todo-login", "로그인 오류 안내");
  assert.equal((await f.publish(login, "todo-login", "로그인 오류 안내", ["fa"])).published.status, "published");
  const expiry = f.save("todo-expiry", "만료 안내 문구");
  await f.publish(expiry, "todo-expiry", "만료 안내 문구", ["fb"]);
  const second = f.save("todo-expiry", "만료 안내 문구", "partial", expiry);
  assert.equal((await f.publish(second, "todo-expiry", "만료 안내 문구", ["fb"])).published.status, "published");
  assert.deepEqual(
    files(f.vault),
    [
      "Lode/샘플 제품/근거/샘플 제품 근거.md",
      "Lode/샘플 제품/샘플 제품.md",
      "Lode/샘플 제품/계정/계정.md",
      "Lode/샘플 제품/계정/근거/계정 근거.md",
      "Lode/샘플 제품/계정/로그인/근거/로그인 근거.md",
      "Lode/샘플 제품/계정/로그인/근거/로그인 오류 안내 결과 1 근거.md",
      "Lode/샘플 제품/계정/로그인/로그인 오류 안내 결과 1.md",
      "Lode/샘플 제품/계정/로그인/로그인.md",
      "Lode/샘플 제품/계정/보안/근거/보안 근거.md",
      "Lode/샘플 제품/계정/보안/만료 안내/근거/만료 안내 근거.md",
      "Lode/샘플 제품/계정/보안/만료 안내/근거/만료 안내 문구 결과 1 근거.md",
      "Lode/샘플 제품/계정/보안/만료 안내/근거/만료 안내 문구 결과 2 근거.md",
      "Lode/샘플 제품/계정/보안/만료 안내/만료 안내 문구 결과 1.md",
      "Lode/샘플 제품/계정/보안/만료 안내/만료 안내 문구 결과 2.md",
      "Lode/샘플 제품/계정/보안/만료 안내/만료 안내.md",
      "Lode/샘플 제품/계정/보안/보안.md",
    ].sort(),
  );
  assertLinksResolve(f.vault);
  for (const file of files(f.vault)) assert.ok(file.length <= 180, file);
  const result = read(f.vault, "Lode/샘플 제품/계정/보안/만료 안내/만료 안내 문구 결과 2.md");
  assert.match(
    result,
    /^# 만료 안내 문구 — 결과 2\n\n상태: 진행 중 \(모바일 문구 남음\) · 기록 [^\n]+ UTC\n\n## 한 일\n\n- [^\n]+\n\n## 판단과 이유\n\n- 자동 재시도를 넣지 않았습니다\. 중복 요청이 생길 수 있기 때문입니다\. \(다른 선택지: 사용자가 직접 재시도\)\n\n## 남은 일\n\n- 모바일 검증과 배포는 실행하지 않았습니다\.\n- 모바일 문구 수정\n\n## 확인하지 못한 것\n\n- 모바일 합의에 대한 사용자 원문이 없습니다\.\n\n---\n\n\[이전 결과\]\([^)]+\) · \[기능: 만료 안내\]\([^)]+\) · \[근거 문서\]\([^)]+\)\n$/,
  );
  const feature = read(f.vault, "Lode/샘플 제품/계정/보안/만료 안내/만료 안내.md");
  assert.match(
    feature,
    /## 이 기능의 결과\n\n- \[만료 안내 문구 결과 2\]\([^)]+\) — 진행 중 · \d{4}-\d{2}-\d{2}\n- \[만료 안내 문구 결과 1\]\([^)]+\) — 완료 · /,
  );
  assert.match(feature, /## 관련 결정과 조건\n\n- 네트워크 재시도는 사용자가 선택합니다\. — 결정/);
});

test("human documents carry no management lines; the evidence document holds them", async (t) => {
  const f = fixture(t);
  f.connect();
  const evidence = f.save("todo-login", "로그인 오류 안내");
  const { prepared, published } = await f.publish(evidence, "todo-login", "로그인 오류 안내", ["fa"]);
  const owner = f.store.caller;
  for (const file of files(f.vault).filter((name) => !isEvidence(name))) {
    const text = read(f.vault, file);
    assert.ok(!/[a-f0-9]{64}/.test(text), file);
    for (const value of [
      "Lode document identity",
      "links begin",
      "links end",
      "<!--",
      "%%",
      owner.projectId,
      f.sessionId,
      evidence.evidenceId,
      "todo-login",
      "승인·지시·완료 증명",
      "WORK_DOCUMENT",
    ])
      assert.ok(!text.includes(value), `${file}: ${value}`);
  }
  const proof = read(f.vault, "Lode/샘플 제품/계정/로그인/근거/로그인 오류 안내 결과 1 근거.md");
  assert.match(proof, /^# 로그인 오류 안내 — 결과 1 근거\n\n## 관리 정보\n\n- 이 문서는 Lode가 게시한 읽기용 사본입니다\. 승인·지시·완료 증명이 아닙니다\./);
  for (const value of [
    owner.projectId,
    f.sessionId,
    "todo-login",
    evidence.evidenceId,
    evidence.evidenceDigest,
    prepared.basis.basisId,
    "결과 번호: 1",
    "문서 규칙 버전: 4",
    "배치 방식 버전: 2",
  ])
    assert.ok(proof.includes(value), value);
  assert.match(proof, /\[사람용 문서\]\(\.\.\/%EB%A1%9C%EA%B7%B8%EC%9D%B8%20%EC%98%A4%EB%A5%98%20%EC%95%88%EB%82%B4%20%EA%B2%B0%EA%B3%BC%201\.md\)\n$/);
  const folderProof = read(f.vault, "Lode/샘플 제품/계정/로그인/근거/로그인 근거.md");
  assert.match(folderProof, /## 관리 정보[\s\S]*대상: feature fa/);
  assert.ok(!files(f.vault).some((file) => /(^|\/)(Start|Notes)\.md$/.test(file)), "no Start or Notes documents");
  assert.equal(published.destinations[0].result.name, "로그인 오류 안내 결과 1");
});

test("re-running creates nothing; a second result adds one human and one evidence file and one list line", async (t) => {
  const f = fixture(t);
  f.connect();
  const first = f.save("todo-expiry", "만료 안내 문구");
  const one = await f.publish(first, "todo-expiry", "만료 안내 문구", ["fb"]);
  const before = files(f.vault),
    bytes = new Map(before.map((file) => [file, read(f.vault, file)]));
  await publishWorkDocuments({ root: f.root, sessionId: f.sessionId, projectionId: one.prepared.projectionId, targetIds: ["vault"] });
  assert.deepEqual(files(f.vault), before);
  for (const [file, text] of bytes) assert.equal(read(f.vault, file), text, file);
  const next = f.save("todo-expiry", "만료 안내 문구", "partial", first);
  await f.publish(next, "todo-expiry", "만료 안내 문구", ["fb"]);
  const added = files(f.vault).filter((file) => !before.includes(file));
  assert.deepEqual(added, [
    "Lode/샘플 제품/계정/보안/만료 안내/근거/만료 안내 문구 결과 2 근거.md",
    "Lode/샘플 제품/계정/보안/만료 안내/만료 안내 문구 결과 2.md",
  ]);
  const featureFile = "Lode/샘플 제품/계정/보안/만료 안내/만료 안내.md";
  for (const [file, text] of bytes) if (file !== featureFile) assert.equal(read(f.vault, file), text, `${file} unchanged`);
  const beforeLines = bytes.get(featureFile).split("\n"),
    afterLines = read(f.vault, featureFile).split("\n");
  assert.equal(afterLines.length, beforeLines.length + 1);
  assert.deepEqual(afterLines.filter((value) => !beforeLines.includes(value)).length, 1);
});

test("tree rules: first-listed parent, links elsewhere, first feature holds the file, no feature or unknown key goes to 소속 미확인, Canon untouched", async (t) => {
  const f = fixture(t);
  f.connect();
  const canonBytes = fs.readFileSync(f.canon);
  const both = f.save("todo-both", "공통 문구");
  const out = (await f.publish(both, "todo-both", "공통 문구", ["fa", "fb"])).published.destinations[0];
  assert.equal(out.result.url, "Lode/샘플 제품/계정/로그인/공통 문구 결과 1.md");
  assert.match(read(f.vault, "Lode/샘플 제품/계정/보안/만료 안내/만료 안내.md"), /\[공통 문구 결과 1\]\(\.\.\/\.\.\/%EB%A1%9C%EA%B7%B8%EC%9D%B8\//);
  // A multi-parent group lives under its first-listed parent and is linked from the other.
  const shared = f.save("todo-shared", "공유 구성 정리");
  await f.publish(shared, "todo-shared", "공유 구성 정리", ["fa"]);
  const unknown = f.save("todo-unknown", "이름 없는 기능");
  const prepared = await prepareWorkDocuments({
    root: f.root,
    sessionId: f.sessionId,
    todoId: "todo-unknown",
    evidenceIds: [unknown.evidenceId],
    title: "이름 없는 기능",
    featureKeys: ["not-a-feature"],
  });
  assert.deepEqual(prepared.rejectedFeatureKeys, ["not-a-feature"]);
  const rejected = (await publishWorkDocuments({ root: f.root, sessionId: f.sessionId, projectionId: prepared.projectionId, targetIds: ["vault"] }))
    .destinations[0];
  assert.deepEqual(rejected.rejectedFeatureKeys, ["not-a-feature"]);
  assert.equal(rejected.result.url, "Lode/샘플 제품/소속 미확인/이름 없는 기능 결과 1.md");
  const none = f.save("todo-none", "기능 없음");
  assert.equal((await f.publish(none, "todo-none", "기능 없음")).published.destinations[0].result.url, "Lode/샘플 제품/소속 미확인/기능 없음 결과 1.md");
  const alone = f.save("todo-alone", "알림 정리");
  assert.equal((await f.publish(alone, "todo-alone", "알림 정리", ["fc"])).published.destinations[0].result.url, "Lode/샘플 제품/알림/알림 정리 결과 1.md");
  assert.deepEqual(fs.readFileSync(f.canon), canonBytes, "the Product model is never changed");
  // fa is in g1 and g3: its folder is under g1 (first listed); g3 links to it.
  assert.ok(fs.existsSync(path.join(f.vault, "Lode", "샘플 제품", "계정", "로그인", "로그인.md")));
  const login = read(f.vault, "Lode/샘플 제품/계정/로그인/로그인.md");
  assert.match(login, /상위: \[계정\]\([^)]+\) · \[공유 구성\]\([^)]+\)/);
  const product = read(f.vault, "Lode/샘플 제품/샘플 제품.md");
  assert.match(product, /- \[계정\]\([^)]+\) — 기능군/);
  assert.match(product, /- \[알림\]\([^)]+\) — 기능/);
  assert.match(product, /- \[소속 미확인\]\([^)]+\) — 기능이 정해지지 않은 결과/);
  assertLinksResolve(f.vault);
});

test("multi-parent groups: the folder sits under the first-listed parent and the other parent links to it", async (t) => {
  const model = sampleModel();
  model.features.push({ key: "fd", name: "공유 기능", featureGroupKeys: ["g3"], capabilityKeys: [], governedBy: [] });
  const f = fixture(t, { model });
  f.connect();
  await f.publish(f.save("todo-d", "공유 기능 정리"), "todo-d", "공유 기능 정리", ["fd"]);
  // g3 lists g2 first, so it lives under 계정/보안; 계정 links to it as well.
  assert.ok(fs.existsSync(path.join(f.vault, "Lode", "샘플 제품", "계정", "보안", "공유 구성", "공유 기능", "공유 기능.md")));
  assert.match(read(f.vault, "Lode/샘플 제품/계정/계정.md"), /\[공유 구성\]\(%EB%B3%B4%EC%95%88\/%EA%B3%B5%EC%9C%A0%20%EA%B5%AC%EC%84%B1\//);
  assertLinksResolve(f.vault);
});

test("without a Product model only the product folder and 소속 미확인 are created", async (t) => {
  const f = fixture(t, { model: null, name: "모델 없는 제품" });
  f.connect();
  const out = (await f.publish(f.save("todo-a", "첫 작업"), "todo-a", "첫 작업", ["fa"])).published.destinations[0];
  assert.deepEqual(out.rejectedFeatureKeys, ["fa"]);
  assert.deepEqual(
    files(f.vault),
    [
      "Lode/모델 없는 제품/근거/모델 없는 제품 근거.md",
      "Lode/모델 없는 제품/모델 없는 제품.md",
      "Lode/모델 없는 제품/소속 미확인/근거/소속 미확인 근거.md",
      "Lode/모델 없는 제품/소속 미확인/소속 미확인.md",
      "Lode/모델 없는 제품/소속 미확인/첫 작업 결과 1.md",
      "Lode/모델 없는 제품/소속 미확인/근거/첫 작업 결과 1 근거.md",
    ].sort(),
  );
  assert.match(read(f.vault, "Lode/모델 없는 제품/모델 없는 제품.md"), /제품 설명 원문이 아직 없습니다/);
});

test("renaming or moving a feature keeps its folder; titles and link text follow the new name", async (t) => {
  const f = fixture(t);
  f.connect();
  const first = f.save("todo-expiry", "만료 안내 문구");
  await f.publish(first, "todo-expiry", "만료 안내 문구", ["fb"]);
  const model = sampleModel();
  model.features[1].name = "세션 만료 안내";
  model.features[1].featureGroupKeys = ["g1"];
  f.write(model);
  const next = f.save("todo-expiry", "만료 안내 문구", "partial", first);
  const out = (await f.publish(next, "todo-expiry", "만료 안내 문구", ["fb"])).published.destinations[0];
  assert.equal(out.result.url, "Lode/샘플 제품/계정/보안/만료 안내/만료 안내 문구 결과 2.md", "new results keep landing in the existing folder");
  assert.ok(!fs.existsSync(path.join(f.vault, "Lode", "샘플 제품", "계정", "세션 만료 안내")));
  assert.match(read(f.vault, "Lode/샘플 제품/계정/보안/만료 안내/만료 안내 문구 결과 2.md"), /\[기능: 세션 만료 안내\]/);
});

test("person edits: an edited list region is reported and kept, other edits survive list updates, person files and names are never reused", async (t) => {
  const f = fixture(t);
  f.connect();
  const first = f.save("todo-expiry", "만료 안내 문구");
  await f.publish(first, "todo-expiry", "만료 안내 문구", ["fb"]);
  const featureFile = path.join(f.vault, "Lode", "샘플 제품", "계정", "보안", "만료 안내", "만료 안내.md");
  // A note outside the list region survives; the list is still updated.
  fs.writeFileSync(
    featureFile,
    fs.readFileSync(featureFile, "utf8").replace("## 이 기능의 결과", "개인 메모: 이 문단은 사람이 썼습니다.\n\n## 이 기능의 결과"),
  );
  const personal = path.join(path.dirname(featureFile), "만료 안내 문구 결과 2.md");
  fs.writeFileSync(personal, "사람이 직접 만든 파일입니다.");
  const second = f.save("todo-expiry", "만료 안내 문구", "partial", first);
  const out = (await f.publish(second, "todo-expiry", "만료 안내 문구", ["fb"])).published;
  assert.equal(out.status, "published");
  assert.equal(fs.readFileSync(personal, "utf8"), "사람이 직접 만든 파일입니다.", "a person's file is untouched");
  const suffixed = out.destinations[0].result.name;
  assert.match(suffixed, /^만료 안내 문구 결과 2 \([a-f0-9]{4}\)$/);
  let text = fs.readFileSync(featureFile, "utf8");
  assert.ok(text.includes("개인 메모: 이 문단은 사람이 썼습니다."));
  assert.ok(text.includes(suffixed));
  // Now the person edits the list itself: it is not overwritten, and the result still publishes.
  fs.writeFileSync(featureFile, text.replace("— 진행 중", "— 진행 중 (사람이 덧붙임)"));
  text = fs.readFileSync(featureFile, "utf8");
  const third = f.save("todo-expiry", "만료 안내 문구", "completed", second);
  const edited = (await f.publish(third, "todo-expiry", "만료 안내 문구", ["fb"])).published;
  assert.equal(edited.status, "published");
  assert.deepEqual(edited.destinations[0].personEdited, [{ document: "만료 안내", region: "results", status: "person-edited-not-overwritten" }]);
  assert.equal(fs.readFileSync(featureFile, "utf8"), text);
  assert.ok(fs.existsSync(path.join(path.dirname(featureFile), "만료 안내 문구 결과 3.md")));
});

test("old-layout publications stay in place; the next result links back and the old Start list is replaced once", async (t) => {
  for (const edited of [false, true])
    await t.test(edited ? "edited Start is skipped and reported" : "Start list linked once", async (t) => {
      const f = fixture(t);
      f.connect();
      const first = f.save("todo-expiry", "만료 안내 문구");
      // An old (layout 1) publication of the first result, as the previous release wrote it.
      const owner = f.store.caller;
      const logicalKey = workDocumentHash([owner.projectId, f.sessionId, "todo-expiry", "work-document"]);
      const oldDir = path.join(f.vault, "Lode", owner.projectId, f.sessionId, logicalKey);
      fs.mkdirSync(oldDir, { recursive: true });
      const currentText =
        "Lode current links begin\n\n마지막으로 게시·조회 확인한 근거: " + "a".repeat(64) + "\n\n[사람용](human-old.md)\n\nLode current links end";
      const oldFiles = {
        "Start.md": `# Lode work\n\n${currentText}\n\nLode document identity: ${logicalKey}\n`,
        "Notes.md": "# Personal notes\n\n사람의 메모\n",
        "human-old.md": "# 만료 안내 문구\n\n옛 사람용 문서\n",
        "agent-old.md": "# 만료 안내 문구\n\n옛 에이전트용 문서\n",
      };
      for (const [name, text] of Object.entries(oldFiles)) fs.writeFileSync(path.join(oldDir, name), text);
      if (edited) fs.appendFileSync(path.join(oldDir, "Start.md"), "\n");
      if (edited) fs.writeFileSync(path.join(oldDir, "Start.md"), oldFiles["Start.md"].replace("[사람용](human-old.md)", "[사람용](human-old.md) 사람이 고침"));
      const target = configureWorkDocuments({
        root: f.root,
        sessionId: f.sessionId,
        targets: [{ id: "vault", kind: "obsidian", vaultRoot: f.vault, automatic: false, todoIds: [] }],
      });
      assert.ok(target);
      const key = workDocumentHash(["vault", "obsidian", f.vault, logicalKey]);
      workDocumentStore({ root: f.root, sessionId: f.sessionId }).write(
        ["current", `${key}.json`],
        {
          kind: "WorkDocumentPublicationReceipt",
          authorityPlane: "P5",
          basisId: "b".repeat(64),
          projectionId: "c".repeat(64),
          logicalKey,
          startId: "Start.md",
          notesId: "Notes.md",
          currentText,
          views: [
            { audience: "human", viewId: "d".repeat(64), url: "human-old.md", id: "human-old.md" },
            { audience: "agent", viewId: "e".repeat(64), url: "agent-old.md", id: "agent-old.md" },
          ],
          taskRevision: { evidenceId: first.evidenceId, evidenceDigest: first.evidenceDigest },
          title: "만료 안내 문구",
          executionReplayAllowed: false,
        },
        true,
      );
      const before = new Map(Object.keys(oldFiles).map((name) => [name, fs.readFileSync(path.join(oldDir, name), "utf8")]));
      const second = f.save("todo-expiry", "만료 안내 문구", "partial", first);
      const out = (await f.publish(second, "todo-expiry", "만료 안내 문구", ["fb"])).published.destinations[0];
      assert.equal(out.status, "current", JSON.stringify(out));
      const human = read(f.vault, out.result.url);
      const previous = links(human)[0];
      assert.ok(fs.existsSync(path.join(f.vault, ...path.posix.join(path.posix.dirname(out.result.url), decodeURIComponent(previous)).split("/"))));
      assert.ok(decodeURIComponent(previous).endsWith(`${logicalKey}/human-old.md`));
      for (const name of ["Notes.md", "human-old.md", "agent-old.md"]) assert.equal(fs.readFileSync(path.join(oldDir, name), "utf8"), before.get(name), name);
      const start = fs.readFileSync(path.join(oldDir, "Start.md"), "utf8");
      if (edited) {
        assert.equal(start, before.get("Start.md"));
        assert.equal(out.oldLayoutLink.status, "person-edited-not-overwritten");
      } else {
        assert.equal(out.oldLayoutLink.status, "linked-to-new-location");
        assert.ok(!start.includes(currentText));
        assert.match(start, /이후 결과는 새 위치에 있습니다: \[만료 안내 문구 결과 1\]\(([^)]+)\)/);
        const link = /새 위치에 있습니다: \[[^\]]+\]\(([^)]+)\)/.exec(start)[1];
        assert.ok(fs.existsSync(path.join(oldDir, ...decodeURIComponent(link).split("/"))));
      }
      // The next result never touches the old layout again.
      const startBytes = fs.readFileSync(path.join(oldDir, "Start.md"));
      const third = f.save("todo-expiry", "만료 안내 문구", "completed", second);
      const later = (await f.publish(third, "todo-expiry", "만료 안내 문구", ["fb"])).published.destinations[0];
      assert.equal(later.status, "current");
      assert.deepEqual(fs.readFileSync(path.join(oldDir, "Start.md")), startBytes);
      assert.match(read(f.vault, later.result.url), /\[이전 결과\]\(%EB%A7%8C%EB%A3%8C/);
    });
});

test("deep groups are flattened so no vault path exceeds 180 characters; links keep the hierarchy", async (t) => {
  const long = (label) => `${label} ${"가".repeat(40)}`;
  const model = sampleModel();
  model.featureGroups = [0, 1, 2, 3, 4].map((index) => ({
    key: `deep${index}`,
    name: long(`단계${index}`),
    parentFeatureGroupKeys: index ? [`deep${index - 1}`] : [],
  }));
  model.features = [{ key: "leaf", name: long("기능"), featureGroupKeys: ["deep4"], capabilityKeys: [], governedBy: [] }];
  const f = fixture(t, { model, name: "깊은 제품" });
  f.connect();
  await f.publish(f.save("todo-deep", long("작업")), "todo-deep", long("작업"), ["leaf"]);
  const all = files(f.vault);
  for (const file of all) assert.ok(file.length <= 180, `${file.length}: ${file}`);
  assert.ok(Math.max(...all.map((file) => file.split("/").length)) < 8, "intermediate folders were skipped");
  assertLinksResolve(f.vault);
  const leaf = all.find((file) => /\/기능 가+\.md$/.test(file));
  assert.match(read(f.vault, leaf), /상위: \[단계4 가+\]/, "the canonical parent is still linked");
});

// Fake Notion server with exact parent tracking and page titles.
function notion() {
  const parent = "20000000-0000-4000-8000-000000000001",
    pages = new Map(),
    calls = [],
    fault = {};
  let sequence = 10;
  const request = async (call) => {
    const url = new URL(call.url);
    calls.push({ method: call.method, url: call.url, body: call.body });
    if (call.method === "POST") {
      const id = "20000000-0000-4000-8000-" + String(sequence++).padStart(12, "0");
      const page = {
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
      const id = url.pathname.split("/")[3];
      return {
        status: 200,
        body: {
          results: [...pages.values()]
            .filter((page) => page.parent.page_id === id)
            .map((page) => ({ id: page.id, type: "child_page", child_page: { title: page.title } })),
          has_more: false,
        },
      };
    }
    const match = /\/pages\/([^/]+)(\/markdown)?$/.exec(url.pathname),
      page = pages.get(match?.[1]);
    if (!page) return { status: 404, body: { object: "error" } };
    if (call.method === "PATCH") {
      const { old_str, new_str } = call.body.update_content.content_updates[0];
      if (page.markdown.split(old_str).length !== 2) return { status: 400, body: { object: "error" } };
      page.markdown = page.markdown.replace(old_str, new_str);
    }
    return {
      status: 200,
      body: match[2]
        ? { object: "page_markdown", id: page.id, markdown: page.markdown, truncated: false, unknown_block_ids: [] }
        : { object: "page", id: page.id, parent: page.parent, properties: { title: { title: [{ plain_text: page.title }] } } },
    };
  };
  return { parent, pages, calls, fault, request, adapter: () => createNotionWorkDocumentAdapter({ parentPageId: parent, request }) };
}
const notionTarget = (fake) => ({
  id: "notion",
  kind: "notion",
  parentPageId: fake.parent,
  tokenEnvironment: "LODE_SYNTHETIC_UNUSED",
  automatic: false,
  todoIds: [],
});
const childrenOf = (fake, id) => [...fake.pages.values()].filter((page) => page.parent.page_id === id);
const titled = (fake, parentId, title) => childrenOf(fake, parentId).find((page) => page.title === title);

test("Notion: the same tree as pages with file-name titles, 근거 pages, and no identity line in human pages", async (t) => {
  const f = fixture(t),
    fake = notion();
  f.connect([notionTarget(fake), { id: "vault", kind: "obsidian", vaultRoot: f.vault, automatic: false, todoIds: [] }]);
  const first = f.save("todo-expiry", "만료 안내 문구");
  await f.publish(first, "todo-expiry", "만료 안내 문구", ["fb"], ["notion", "vault"], { notion: fake.adapter() });
  const second = f.save("todo-expiry", "만료 안내 문구", "partial", first);
  const out = await f.publish(second, "todo-expiry", "만료 안내 문구", ["fb"], ["notion", "vault"], { notion: fake.adapter() });
  assert.equal(out.published.status, "published", JSON.stringify(out.published));
  const product = titled(fake, fake.parent, "샘플 제품");
  const group = titled(fake, product.id, "계정"),
    sub = titled(fake, group.id, "보안"),
    feature = titled(fake, sub.id, "만료 안내");
  assert.ok(feature);
  assert.deepEqual(
    childrenOf(fake, feature.id)
      .map((page) => page.title)
      .sort(),
    ["근거", "만료 안내 문구 결과 1", "만료 안내 문구 결과 2"],
  );
  assert.deepEqual(
    childrenOf(fake, titled(fake, feature.id, "근거").id)
      .map((page) => page.title)
      .sort(),
    ["만료 안내 근거", "만료 안내 문구 결과 1 근거", "만료 안내 문구 결과 2 근거"],
  );
  assert.equal(childrenOf(fake, fake.parent).length, 1, "only the product page under the configured parent");
  // Titles match the vault file names; human bodies match too, apart from link targets.
  const vaultResult = read(f.vault, "Lode/샘플 제품/계정/보안/만료 안내/만료 안내 문구 결과 2.md");
  const notionResult = titled(fake, feature.id, "만료 안내 문구 결과 2").markdown;
  const unlink = (text) => text.replace(/\]\([^)]+\)/g, "]()");
  assert.equal(unlink(notionResult), unlink(vaultResult));
  for (const page of fake.pages.values()) {
    const evidence = page.title.endsWith("근거");
    if (!evidence) {
      assert.ok(!/Lode document identity|[a-f0-9]{64}/.test(page.markdown), page.title);
    }
    for (const link of page.markdown.matchAll(/https:\/\/www\.notion\.so\/([a-f0-9]{32})/g))
      assert.ok(
        [...fake.pages.keys()].some((id) => id.replaceAll("-", "") === link[1]),
        `${page.title} -> ${link[1]}`,
      );
  }
});

// Repeats a publication while it only reports bounded continuation.
async function untilDone(options) {
  let result;
  for (let call = 0; call < 8; call++) {
    result = await publishWorkDocuments(options);
    if (result.status !== "continuation-required") break;
  }
  return result;
}
test("Notion unknown create: binds only one exact title+body page not recorded for another document; otherwise stops without a duplicate", async (t) => {
  for (const mode of ["one-match", "two-matches", "no-match", "recorded-elsewhere"])
    await t.test(mode, async (t) => {
      const f = fixture(t),
        fake = notion();
      f.connect([notionTarget(fake)]);
      const evidence = f.save("todo-login", "로그인 오류 안내");
      const prepared = await prepareWorkDocuments({
        root: f.root,
        sessionId: f.sessionId,
        todoId: "todo-login",
        evidenceIds: [evidence.evidenceId],
        title: "로그인 오류 안내",
        featureKeys: ["fa"],
      });
      const options = {
        root: f.root,
        sessionId: f.sessionId,
        projectionId: prepared.projectionId,
        targetIds: ["notion"],
        adapters: { notion: fake.adapter() },
      };
      const posts = () => fake.calls.filter((call) => call.method === "POST").length;
      // Loses the response of the create whose page title is given (the page exists).
      const losing = (title) =>
        createNotionWorkDocumentAdapter({
          parentPageId: fake.parent,
          request: async (call) => {
            if (call.method === "POST" && call.body.properties.title.title[0].text.content === title) fake.fault.lose = true;
            return fake.request(call);
          },
        });
      if (mode === "recorded-elsewhere") {
        assert.equal((await untilDone(options)).status, "published");
        const next = f.save("todo-login", "로그인 오류 안내", "partial", evidence);
        const nextPrepared = await prepareWorkDocuments({
          root: f.root,
          sessionId: f.sessionId,
          todoId: "todo-login",
          evidenceIds: [next.evidenceId],
          title: "로그인 오류 안내",
          featureKeys: ["fa"],
        });
        const nextOptions = { ...options, projectionId: nextPrepared.projectionId };
        const lost = await untilDone({ ...nextOptions, adapters: { notion: losing("로그인 오류 안내 결과 2 근거") } });
        assert.equal(lost.destinations[0].status, "publication-unconfirmed");
        const created = [...fake.pages.values()].find((page) => page.title === "로그인 오류 안내 결과 2 근거");
        // A page already recorded for another document now has the same title and body.
        const recorded = [...fake.pages.values()].find((page) => page.title === "로그인 오류 안내 결과 1 근거");
        Object.assign(recorded, { title: created.title, markdown: created.markdown });
        const before = posts();
        const again = await untilDone({ ...nextOptions, adapters: { notion: fake.adapter() } });
        assert.equal(again.destinations[0].status, "current", JSON.stringify(again.destinations[0]));
        // Only the human page of result 2 is created; its lost 근거 page is bound, not created again.
        assert.equal(posts(), before + 1);
        assert.equal(fake.calls.filter((call) => call.method === "POST").at(-1).body.properties.title.title[0].text.content, "로그인 오류 안내 결과 2");
        assert.ok(again.destinations[0].result.evidenceUrl.endsWith(created.id.replaceAll("-", "")), "the recorded page is never bound twice");
        return;
      }
      const lost = await untilDone({ ...options, adapters: { notion: losing("로그인 오류 안내 결과 1") } });
      assert.equal(lost.destinations[0].status, "publication-unconfirmed");
      const created = [...fake.pages.values()].find((page) => page.title === "로그인 오류 안내 결과 1");
      if (mode === "two-matches") fake.pages.set("20000000-0000-4000-8000-000000009999", { ...created, id: "20000000-0000-4000-8000-000000009999" });
      if (mode === "no-match") fake.pages.delete(created.id);
      const before = posts();
      const again = await untilDone(options);
      assert.equal(posts(), before, "an unknown create is never issued again");
      if (mode === "one-match") {
        assert.equal(again.status, "published", JSON.stringify(again));
        assert.equal([...fake.pages.values()].filter((page) => page.title === "로그인 오류 안내 결과 1").length, 1);
      } else {
        assert.equal(again.destinations[0].status, "publication-unconfirmed");
        assert.equal(again.destinations[0].reasonCode, "WORK_DOCUMENT_CREATE_UNKNOWN");
      }
    });
});

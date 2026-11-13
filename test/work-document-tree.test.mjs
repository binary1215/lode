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
import { configureWorkDocuments, prepareWorkDocuments, publishWorkDocuments, workDocumentStatus } from "../scripts/lib/world/work-document-publication.mjs";
import { prepareProjectDocuments, publishProjectDocuments, projectDocumentStatus } from "../scripts/lib/world/project-document-publication.mjs";
import { readableName } from "../scripts/lib/world/work-document-tree.mjs";
import { createDocumentEffectWriter } from "../scripts/lib/world/work-document-effect-writer.mjs";
import { createNotionWorkDocumentAdapter, documentDestinationIdentity } from "../scripts/lib/world/work-document-destinations.mjs";
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
    /^# 만료 안내 문구 — 결과 2\n\n상태: 진행 중 \(모바일 문구 남음\) · 기록 [^\n]+ UTC\n\n## 한 일\n\n- [^\n]+\n\n## 판단과 이유\n\n- 자동 재시도를 넣지 않았습니다. — 이유: 중복 요청이 생길 수 있기 때문입니다\. \(다른 선택지: 사용자가 직접 재시도\)\n\n## 남은 일\n\n- 모바일 검증과 배포는 실행하지 않았습니다\.\n- 모바일 문구 수정\n\n## 확인하지 못한 것\n\n- 모바일 합의에 대한 사용자 원문이 없습니다\.\n\n---\n\n\[이전 결과\]\([^)]+\) · \[기능: 만료 안내\]\([^)]+\) · \[근거 문서\]\([^)]+\)\n$/,
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
  // The feature document, its parent line and the parents' lists follow the model on the result path.
  const feature = read(f.vault, "Lode/샘플 제품/계정/보안/만료 안내/만료 안내.md");
  assert.match(feature, /^# 세션 만료 안내\n/);
  assert.match(feature, /\n상위: \[계정\]\(\.\.\/\.\.\/%EA%B3%84%EC%A0%95\.md\)\n/);
  assert.match(read(f.vault, "Lode/샘플 제품/계정/계정.md"), /- \[세션 만료 안내\]\([^)]+\) — 기능/);
  assert.match(read(f.vault, "Lode/샘플 제품/계정/보안/보안.md"), /- \[세션 만료 안내\]\([^)]+\) — 기능/);
  assertLinksResolve(f.vault);
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
      // Listings come in pages of 100, as the real API returns them.
      const id = url.pathname.split("/")[3],
        children = [...pages.values()].filter((page) => page.parent.page_id === id),
        offset = Number(url.searchParams.get("start_cursor") || 0);
      return {
        status: 200,
        body: {
          results: children.slice(offset, offset + 100).map((page) => ({ id: page.id, type: "child_page", child_page: { title: page.title } })),
          has_more: offset + 100 < children.length,
          next_cursor: offset + 100 < children.length ? String(offset + 100) : null,
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
      if (fault.losePatchId === page.id) {
        fault.losePatchId = null;
        throw Object.assign(new Error("Synthetic lost update"), { code: "ECONNRESET" });
      }
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

// ---- Review round: failure recovery, person changes and earlier layouts ----

const featureDoc = "Lode/샘플 제품/계정/보안/만료 안내/만료 안내.md";
test("a failed vault create is settled by name: absent creates it, the same text binds it, a person's file is kept", async (t) => {
  for (const mode of ["absent", "same-text", "person-file"])
    await t.test(mode, async (t) => {
      const f = fixture(t);
      f.connect();
      const target = path.join(f.vault, ...featureDoc.split("/"));
      const link = fs.linkSync;
      let fired = false;
      t.mock.method(fs, "linkSync", function (from, to) {
        if (!fired && String(to) === target) {
          fired = true;
          if (mode === "same-text") link.call(this, from, to);
          throw Object.assign(new Error("Synthetic transient failure"), { code: "EBUSY" });
        }
        return link.call(this, from, to);
      });
      const evidence = f.save("todo-expiry", "만료 안내 문구");
      const first = (await f.publish(evidence, "todo-expiry", "만료 안내 문구", ["fb"])).published.destinations[0];
      assert.ok(fired);
      assert.equal(first.status, "publication-unconfirmed");
      if (mode === "person-file") fs.writeFileSync(target, "사람이 같은 이름으로 만든 파일\n");
      const second = (await f.publish(evidence, "todo-expiry", "만료 안내 문구", ["fb"])).published.destinations[0];
      if (mode === "person-file") {
        assert.equal(second.reasonCode, "WORK_DOCUMENT_NAME_OCCUPIED");
        assert.equal(fs.readFileSync(target, "utf8"), "사람이 같은 이름으로 만든 파일\n", "never overwritten");
        // Other features are not blocked by it.
        const other = (await f.publish(f.save("todo-alone", "알림 정리"), "todo-alone", "알림 정리", ["fc"])).published.destinations[0];
        assert.equal(other.status, "current");
        return;
      }
      assert.equal(second.status, "current", JSON.stringify(second));
      assert.match(fs.readFileSync(target, "utf8"), /^# 만료 안내\n/);
      assert.equal(files(f.vault).filter((file) => file.endsWith("/만료 안내.md")).length, 1, "no duplicate");
      const other = (await f.publish(f.save("todo-other", "다른 작업"), "todo-other", "다른 작업", ["fb"])).published.destinations[0];
      assert.equal(other.status, "current");
    });
});

test("Lode's own refusal before a write leaves no unknown attempt: a fresh preparation and later results publish", async (t) => {
  const f = fixture(t);
  f.connect([{ id: "vault", kind: "obsidian", vaultRoot: f.vault, automatic: false, todoIds: [], projectDocuments: true }]);
  let prepared = await prepareProjectDocuments({ root: f.root, sessionId: f.sessionId });
  // The Product model changes while this call is between documents.
  const link = fs.linkSync;
  let journaled = 0,
    changed = false;
  t.mock.method(fs, "linkSync", function (from, to) {
    const result = link.call(this, from, to);
    if (!changed && String(to).includes(path.sep + "attempts" + path.sep) && ++journaled === 2) {
      changed = true;
      const model = sampleModel();
      model.features[0].description = "다른 세션이 방금 고친 설명";
      f.write(model);
    }
    return result;
  });
  const during = await publishProjectDocuments({ root: f.root, sessionId: f.sessionId, projectionId: prepared.projectionId, targetIds: ["vault"] });
  t.mock.restoreAll();
  assert.ok(changed);
  assert.equal(during.destinations[0].reasonCode, "PROJECT_DOCUMENT_SOURCE_CHANGED");
  prepared = await prepareProjectDocuments({ root: f.root, sessionId: f.sessionId });
  let last;
  for (let i = 0; i < 60; i++) {
    last = await publishProjectDocuments({ root: f.root, sessionId: f.sessionId, projectionId: prepared.projectionId, targetIds: ["vault"] });
    if (last.status !== "continuation-required") break;
  }
  assert.equal(last.status, "published", JSON.stringify(last));
  const result = (await f.publish(f.save("todo-expiry", "만료 안내 문구"), "todo-expiry", "만료 안내 문구", ["fb"])).published;
  assert.equal(result.status, "published", JSON.stringify(result));
  assert.match(read(f.vault, "Lode/샘플 제품/계정/로그인/로그인.md"), /다른 세션이 방금 고친 설명/);
});

test("a person re-saving, deleting or renaming a folder document never stops a result; deletions are reported, not undone", async (t) => {
  for (const mode of ["re-saved", "deleted", "renamed"])
    await t.test(mode, async (t) => {
      const f = fixture(t);
      f.connect();
      const first = f.save("todo-expiry", "만료 안내 문구");
      await f.publish(first, "todo-expiry", "만료 안내 문구", ["fb"]);
      const target = path.join(f.vault, ...featureDoc.split("/"));
      const bytes = fs.readFileSync(target);
      if (mode === "re-saved") {
        // Editors and sync tools save through a temporary file: new inode, same text.
        fs.writeFileSync(target + ".tmp", bytes);
        fs.unlinkSync(target);
        fs.renameSync(target + ".tmp", target);
      } else if (mode === "deleted") fs.unlinkSync(target);
      else fs.renameSync(target, path.join(path.dirname(target), "만료 안내 메모.md"));
      const second = f.save("todo-expiry", "만료 안내 문구", "partial", first);
      const out = (await f.publish(second, "todo-expiry", "만료 안내 문구", ["fb"])).published.destinations[0];
      assert.equal(out.status, "current", JSON.stringify(out));
      assert.ok(fs.existsSync(path.join(path.dirname(target), "만료 안내 문구 결과 2.md")));
      if (mode === "re-saved") {
        assert.equal(out.personEdited, undefined);
        assert.match(fs.readFileSync(target, "utf8"), /\[만료 안내 문구 결과 2\]/, "the list is updated by content");
      } else {
        assert.deepEqual(out.personEdited, [{ document: "만료 안내", status: "document-missing-not-recreated" }]);
        assert.ok(!fs.existsSync(target), "a deleted folder document is not recreated");
        if (mode === "renamed") assert.deepEqual(fs.readFileSync(path.join(path.dirname(target), "만료 안내 메모.md")), bytes);
      }
    });
});

test("an old-layout Project publication still reads as published in the old layout", async (t) => {
  const f = fixture(t);
  const target = { id: "vault", kind: "obsidian", vaultRoot: f.vault, automatic: false, todoIds: [], projectDocuments: true };
  f.connect([target]);
  const oldKey = workDocumentHash([f.store.owner.projectId, documentDestinationIdentity(target), "project-documents-v1"]);
  const receipt = { kind: "ProjectDocumentPublicationReceipt", authorityPlane: "P5", projectId: f.store.owner.projectId, pages: 20, homeId: "Start.md" };
  f.store.write(["current", oldKey + ".json"], receipt);
  const status = projectDocumentStatus({ root: f.root, sessionId: f.sessionId }).destinations[0];
  assert.equal(status.layoutVersion, 1);
  assert.equal(status.current.layout, "old-layout");
  assert.equal(status.current.pages, 20);
});

test("Notion recovery lists the exact parent to its end and binds the single title and body match among many children", async (t) => {
  for (const others of [13, 130])
    await t.test(`${others} other pages`, async (t) => {
      const f = fixture(t),
        fake = notion();
      for (let i = 0; i < others; i++) {
        const id = "20000000-0000-4000-8000-" + String(5000 + i).padStart(12, "0");
        fake.pages.set(id, { id, parent: { page_id: fake.parent }, title: `다른 페이지 ${i}`, markdown: `다른 내용 ${i}` });
      }
      f.connect([notionTarget(fake)]);
      const losing = createNotionWorkDocumentAdapter({
        parentPageId: fake.parent,
        request: async (call) => {
          if (call.method === "POST" && call.body.properties.title.title[0].text.content === "샘플 제품") fake.fault.lose = true;
          return fake.request(call);
        },
      });
      const evidence = f.save("todo-login", "로그인 오류 안내");
      const lost = await f.publish(evidence, "todo-login", "로그인 오류 안내", ["fa"], ["notion"], { notion: losing });
      assert.equal(lost.published.destinations[0].status, "publication-unconfirmed");
      const posts = fake.calls.filter((call) => call.method === "POST").length;
      const again = await f.publish(evidence, "todo-login", "로그인 오류 안내", ["fa"], ["notion"], { notion: fake.adapter() });
      assert.equal(again.published.status, "published", JSON.stringify(again.published));
      assert.equal([...fake.pages.values()].filter((page) => page.title === "샘플 제품").length, 1, "no duplicate product page");
      assert.ok(fake.calls.filter((call) => call.method === "POST").length > posts, "the rest of the tree follows");
      // Every POST made exactly one page: the lost one was bound, none was repeated.
      assert.equal(fake.calls.filter((call) => call.method === "POST").length, fake.pages.size - others);
    });
});

test("non-blocking review items: feature change on a published result, names, line endings and the fixed folders", async (t) => {
  await t.test("a different feature for an already published result is reported", async (t) => {
    const f = fixture(t);
    f.connect();
    const evidence = f.save("todo-x", "공통 문구");
    await f.publish(evidence, "todo-x", "공통 문구", ["fa"]);
    const out = (await f.publish(evidence, "todo-x", "공통 문구", ["fb"])).published.destinations[0];
    assert.deepEqual(out.featureChangeIgnored.kept, ["fa"]);
    assert.deepEqual(out.featureChangeIgnored.requested, ["fb"]);
  });
  await t.test("reserved Windows names and the UTF-16 cap", () => {
    for (const [value, expected] of [
      ["con", "con 문서"],
      ["CON.txt", "CON 문서.txt"],
      ["nul ", "nul 문서"],
      ["com1. ", "com1 문서"],
      ["lpt9 .md", "lpt9 문서 .md"],
      ["console", "console"],
    ])
      assert.equal(readableName(value), expected, value);
    const wide = readableName("😀".repeat(30));
    assert.equal(wide.length, 40, "40 UTF-16 units, no split pair");
  });
  await t.test("a feature named like its group's document and a feature named 소속 미확인 keep separate places", async (t) => {
    const model = sampleModel();
    model.features.push({ key: "fx", name: "계정.md", featureGroupKeys: ["g1"], capabilityKeys: [], governedBy: [] });
    model.features.push({ key: "fy", name: "소속 미확인", featureGroupKeys: [], capabilityKeys: [], governedBy: [] });
    const f = fixture(t, { model });
    f.connect();
    const x = (await f.publish(f.save("todo-x", "이름 겹침"), "todo-x", "이름 겹침", ["fx"])).published.destinations[0];
    assert.equal(x.status, "current", JSON.stringify(x));
    assert.match(x.result.url, /^Lode\/샘플 제품\/계정\/계정\.md \([a-f0-9]{4}\)\//);
    const y = (await f.publish(f.save("todo-y", "고정 폴더"), "todo-y", "고정 폴더", ["fy"])).published.destinations[0];
    const none = (await f.publish(f.save("todo-z", "기능 없음"), "todo-z", "기능 없음")).published.destinations[0];
    assert.match(y.result.url, /^Lode\/샘플 제품\/소속 미확인 \([a-f0-9]{4}\)\//);
    assert.match(none.result.url, /^Lode\/샘플 제품\/소속 미확인\/기능 없음 결과 1\.md$/);
    assertLinksResolve(f.vault);
  });
  await t.test("a document converted to CRLF keeps CRLF when a list changes", async (t) => {
    const f = fixture(t);
    f.connect();
    const first = f.save("todo-expiry", "만료 안내 문구");
    await f.publish(first, "todo-expiry", "만료 안내 문구", ["fb"]);
    const target = path.join(f.vault, ...featureDoc.split("/"));
    fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace(/\n/g, "\r\n"));
    await f.publish(f.save("todo-expiry", "만료 안내 문구", "partial", first), "todo-expiry", "만료 안내 문구", ["fb"]);
    const text = fs.readFileSync(target, "utf8");
    assert.match(text, /만료 안내 문구 결과 2/);
    assert.ok(!/[^\r]\n/.test(text), "every line ends with CRLF");
  });
});

test("Project publication: decision documents link their features on the first publication; a multi-call publication says it is in progress", async (t) => {
  const f = fixture(t);
  f.connect([{ id: "vault", kind: "obsidian", vaultRoot: f.vault, automatic: false, todoIds: [], projectDocuments: true }]);
  const prepared = await prepareProjectDocuments({ root: f.root, sessionId: f.sessionId });
  const product = path.join(f.vault, "Lode", "샘플 제품", "샘플 제품.md");
  let first = true,
    last;
  for (let i = 0; i < 60; i++) {
    last = await publishProjectDocuments({ root: f.root, sessionId: f.sessionId, projectionId: prepared.projectionId, targetIds: ["vault"] });
    if (first) assert.match(fs.readFileSync(product, "utf8"), /문서를 갱신하는 중입니다/);
    first = false;
    if (last.status !== "continuation-required") break;
  }
  assert.equal(last.status, "published");
  assert.doesNotMatch(fs.readFileSync(product, "utf8"), /문서를 갱신하는 중입니다/);
  const decision = read(f.vault, "Lode/샘플 제품/결정과 조건/네트워크 재시도는 사용자가 선택합니다.md");
  assert.match(decision, /## 관련 기능\n\n- \[로그인\]\([^)]+\)\n- \[만료 안내\]\([^)]+\)/);
  assertLinksResolve(f.vault);
});

test("earlier layout: the same result is not copied again; old receipts are labelled; a lost Start update is recognised", async (t) => {
  const oldPublication = (f, evidence, { basisId = "b".repeat(64), startId = "Start.md", url = "human-old.md" } = {}) => {
    const owner = f.store.caller;
    const logicalKey = workDocumentHash([owner.projectId, f.sessionId, "todo-expiry", "work-document"]);
    const currentText = "Lode current links begin\n\n[사람용](human-old.md)\n\nLode current links end";
    return {
      logicalKey,
      currentText,
      receipt: {
        kind: "WorkDocumentPublicationReceipt",
        authorityPlane: "P5",
        basisId,
        projectionId: "c".repeat(64),
        logicalKey,
        startId,
        currentText,
        views: [{ audience: "human", id: "human-old.md", url }],
        taskRevision: { evidenceId: evidence.evidenceId, evidenceDigest: evidence.evidenceDigest },
        title: "만료 안내 문구",
        executionReplayAllowed: false,
      },
    };
  };
  await t.test("the same result", async (t) => {
    const f = fixture(t);
    f.connect();
    const evidence = f.save("todo-expiry", "만료 안내 문구");
    const prepared = await prepareWorkDocuments({
      root: f.root,
      sessionId: f.sessionId,
      todoId: "todo-expiry",
      evidenceIds: [evidence.evidenceId],
      title: "만료 안내 문구",
      featureKeys: ["fb"],
    });
    const old = oldPublication(f, evidence, { basisId: prepared.basis.basisId });
    const key = workDocumentHash(["vault", "obsidian", f.vault, old.logicalKey]);
    workDocumentStore({ root: f.root, sessionId: f.sessionId }).write(["current", `${key}.json`], old.receipt, true);
    const status = workDocumentStatus({ root: f.root, sessionId: f.sessionId, logicalKey: old.logicalKey }).destinations[0].current;
    assert.equal(status.layout, "old-layout");
    const out = (await publishWorkDocuments({ root: f.root, sessionId: f.sessionId, projectionId: prepared.projectionId, targetIds: ["vault"] }))
      .destinations[0];
    assert.equal(out.alreadyPublishedInOldLayout, true);
    assert.deepEqual(files(f.vault), [], "nothing is copied into the new tree");
  });
  await t.test("a lost Notion Start update", async (t) => {
    const f = fixture(t),
      fake = notion();
    f.connect([notionTarget(fake)]);
    const first = f.save("todo-expiry", "만료 안내 문구");
    const startId = "20000000-0000-4000-8000-000000009000";
    const old = oldPublication(f, first, { startId, url: "https://www.notion.so/20000000000040008000000000009001" });
    fake.pages.set(startId, { id: startId, parent: { page_id: fake.parent }, title: "Lode work", markdown: `# Lode work\n\n${old.currentText}\n` });
    const key = workDocumentHash(["notion", "notion", fake.parent, old.logicalKey]);
    workDocumentStore({ root: f.root, sessionId: f.sessionId }).write(["current", `${key}.json`], old.receipt, true);
    fake.fault.losePatchId = startId;
    const second = f.save("todo-expiry", "만료 안내 문구", "partial", first);
    const lost = (await f.publish(second, "todo-expiry", "만료 안내 문구", ["fb"], ["notion"], { notion: fake.adapter() })).published.destinations[0];
    assert.equal(lost.status, "publication-unconfirmed");
    const again = (await f.publish(second, "todo-expiry", "만료 안내 문구", ["fb"], ["notion"], { notion: fake.adapter() })).published.destinations[0];
    assert.equal(again.status, "current", JSON.stringify(again));
    assert.equal(again.oldLayoutLink.status, "linked-to-new-location");
    assert.equal(again.personEdited, undefined);
  });
});

// ---- Review round 3: failed updates, fixed names, the in-progress line ----

test("a failed vault update is settled by the file's text: applied, or kept and reported when a person changed or deleted it", async (t) => {
  for (const mode of ["unchanged", "person-appended", "person-deleted"])
    await t.test(mode, async (t) => {
      const f = fixture(t);
      f.connect();
      await f.publish(f.save("todo-a", "첫 작업"), "todo-a", "첫 작업", ["fb"]);
      const target = path.join(f.vault, ...featureDoc.split("/"));
      const rename = fs.renameSync;
      // A file held by an editor, sync tool or antivirus: every rename over it fails.
      t.mock.method(fs, "renameSync", function (from, to) {
        if (String(to) === target) throw Object.assign(new Error("Synthetic busy file"), { code: "EBUSY" });
        return rename.call(this, from, to);
      });
      const second = f.save("todo-b", "둘째 작업");
      const failed = (await f.publish(second, "todo-b", "둘째 작업", ["fb"])).published.destinations[0];
      assert.equal(failed.status, "publication-unconfirmed");
      t.mock.restoreAll();
      if (mode === "person-appended") fs.appendFileSync(target, "\n사람이 덧붙인 줄\n");
      if (mode === "person-deleted") fs.unlinkSync(target);
      const again = (await f.publish(second, "todo-b", "둘째 작업", ["fb"])).published.destinations[0];
      assert.equal(again.status, "current", JSON.stringify(again));
      const other = (await f.publish(f.save("todo-c", "셋째 작업"), "todo-c", "셋째 작업", ["fb"])).published.destinations[0];
      assert.equal(other.status, "current", JSON.stringify(other));
      if (mode === "unchanged") {
        assert.equal(again.personEdited, undefined);
        assert.match(fs.readFileSync(target, "utf8"), /\[둘째 작업 결과 1\][\s\S]*\[첫 작업 결과 1\]/);
      } else if (mode === "person-appended") {
        assert.deepEqual(
          again.personEdited.map((value) => value.status),
          ["person-edited-not-overwritten"],
        );
        assert.ok(fs.readFileSync(target, "utf8").endsWith("사람이 덧붙인 줄\n"));
      } else {
        assert.deepEqual(again.personEdited, [{ document: "만료 안내", status: "document-missing-not-recreated" }]);
        assert.ok(!fs.existsSync(target));
      }
    });
});

test("the Notion request budget is checked before an attempt is journaled", async (t) => {
  const f = fixture(t),
    fake = notion();
  const adapter = createNotionWorkDocumentAdapter({ parentPageId: fake.parent, request: fake.request, requestBudget: 1 });
  adapter.beginPublication();
  await adapter.childTitles();
  const writer = createDocumentEffectWriter({
    store: f.store,
    adapter,
    key: "budget-probe",
    target: { id: "budget-probe" },
    configurationDigest: "a".repeat(64),
    prepared: { projectionId: "b".repeat(64) },
    previous: null,
  });
  await assert.rejects(writer.create("page", "Page", "Page", "Body"), { code: "WORK_DOCUMENT_TRANSPORT_BUDGET" });
  assert.equal(fs.existsSync(f.store.file("attempts")), false, "no attempt is left behind");
  assert.equal(fake.calls.filter((call) => call.method === "POST").length, 0);
});

test("result publication keeps Project narratives and follows a group rename", async (t) => {
  const f = fixture(t);
  f.connect([{ id: "vault", kind: "obsidian", vaultRoot: f.vault, automatic: false, todoIds: [], projectDocuments: true }]);
  const prepared = await prepareProjectDocuments({
    root: f.root,
    sessionId: f.sessionId,
    narratives: [{ kind: "Feature", key: "fa", sourceKeys: ["Feature:fa"], useFlow: "계정을 입력한 뒤 로그인합니다." }],
  });
  for (let i = 0; i < 60; i++)
    if (
      (await publishProjectDocuments({ root: f.root, sessionId: f.sessionId, projectionId: prepared.projectionId, targetIds: ["vault"] })).status !==
      "continuation-required"
    )
      break;
  const login = path.join(f.vault, "Lode", "샘플 제품", "계정", "로그인", "로그인.md");
  assert.match(fs.readFileSync(login, "utf8"), /## 사용 흐름\n\n계정을 입력한 뒤 로그인합니다\./);
  const model = sampleModel();
  model.featureGroups[0].name = "회원";
  f.write(model);
  const out = (await f.publish(f.save("todo-a", "로그인 문구"), "todo-a", "로그인 문구", ["fa"])).published.destinations[0];
  assert.equal(out.status, "current", JSON.stringify(out));
  const text = fs.readFileSync(login, "utf8");
  assert.match(text, /## 사용 흐름\n\n계정을 입력한 뒤 로그인합니다\./, "the narrative survives a result publication");
  assert.match(text, /아래 설명은 이전에 선택한 원문에 대한 것입니다/, "and is marked once the model changed");
  assert.match(text, /\n상위: \[회원\]\([^)]+\)/);
  assert.match(read(f.vault, "Lode/샘플 제품/계정/계정.md"), /^# 회원\n/);
  assert.match(read(f.vault, "Lode/샘플 제품/샘플 제품.md"), /- \[회원\]\(%EA%B3%84%EC%A0%95\/[^)]+\) — 기능군/);
  assertLinksResolve(f.vault);
});

test("non-BMP names keep every vault path within 180 UTF-16 units", async (t) => {
  const wide = (label) => `${label} ${"😀".repeat(30)}`;
  const model = sampleModel();
  model.featureGroups = [0, 1, 2].map((index) => ({
    key: `deep${index}`,
    name: wide(`단계${index}`),
    parentFeatureGroupKeys: index ? [`deep${index - 1}`] : [],
  }));
  model.features = [{ key: "leaf", name: wide("기능"), featureGroupKeys: ["deep2"], capabilityKeys: [], governedBy: [] }];
  const f = fixture(t, { model, name: "넓은 제품" });
  f.connect();
  await f.publish(f.save("todo-w", wide("작업")), "todo-w", wide("작업"), ["leaf"]);
  for (const file of files(f.vault)) assert.ok(file.length <= 180, `${file.length}: ${file}`);
  assertLinksResolve(f.vault);
});

test("a person's folder already named like a fixed folder is left alone; Lode uses a suffixed folder beside it", async (t) => {
  const f = fixture(t);
  f.connect();
  // Lode made the product folder earlier; the person then made a folder with a fixed name.
  await f.publish(f.save("todo-a", "알림 정리"), "todo-a", "알림 정리", ["fc"]);
  const personal = path.join(f.vault, "Lode", "샘플 제품", "소속 미확인");
  fs.mkdirSync(personal, { recursive: true });
  fs.writeFileSync(path.join(personal, "메모.md"), "사람의 메모\n");
  const out = (await f.publish(f.save("todo-n", "기능 없음"), "todo-n", "기능 없음")).published.destinations[0];
  assert.equal(out.status, "current", JSON.stringify(out));
  assert.match(out.result.url, /^Lode\/샘플 제품\/소속 미확인 \([a-f0-9]{4}\)\/기능 없음 결과 1\.md$/);
  assert.deepEqual(fs.readdirSync(personal), ["메모.md"]);
});

test("a vault name held by a folder is reported with its path", async (t) => {
  const f = fixture(t);
  f.connect();
  const target = path.join(f.vault, ...featureDoc.split("/"));
  const link = fs.linkSync;
  let fired = false;
  t.mock.method(fs, "linkSync", function (from, to) {
    if (!fired && String(to) === target) {
      fired = true;
      throw Object.assign(new Error("Synthetic transient failure"), { code: "EBUSY" });
    }
    return link.call(this, from, to);
  });
  const evidence = f.save("todo-expiry", "만료 안내 문구");
  await f.publish(evidence, "todo-expiry", "만료 안내 문구", ["fb"]);
  t.mock.restoreAll();
  fs.mkdirSync(target);
  const out = (await f.publish(evidence, "todo-expiry", "만료 안내 문구", ["fb"])).published.destinations[0];
  assert.equal(out.reasonCode, "WORK_DOCUMENT_NAME_OCCUPIED");
  assert.equal(out.occupiedPath, featureDoc);
  assert.ok(fs.statSync(target).isDirectory());
});

test("the in-progress line leaves an edited product document and an abandoned publication", async (t) => {
  for (const mode of ["person-edited", "abandoned"])
    await t.test(mode, async (t) => {
      const f = fixture(t);
      f.connect([{ id: "vault", kind: "obsidian", vaultRoot: f.vault, automatic: false, todoIds: [], projectDocuments: true }]);
      const prepared = await prepareProjectDocuments({ root: f.root, sessionId: f.sessionId });
      const product = path.join(f.vault, "Lode", "샘플 제품", "샘플 제품.md");
      const call = () => publishProjectDocuments({ root: f.root, sessionId: f.sessionId, projectionId: prepared.projectionId, targetIds: ["vault"] });
      assert.equal((await call()).status, "continuation-required");
      assert.match(fs.readFileSync(product, "utf8"), /문서를 갱신하는 중입니다/);
      if (mode === "person-edited") {
        fs.appendFileSync(product, "\n사람의 메모\n");
        let last;
        for (let i = 0; i < 60; i++) if ((last = await call()).status !== "continuation-required") break;
        assert.equal(last.status, "published");
        assert.ok(fs.readFileSync(product, "utf8").endsWith("사람의 메모\n"));
      } else {
        const model = sampleModel();
        model.features[0].description = "다른 세션이 바꾼 설명";
        f.write(model);
        assert.equal((await call()).destinations[0].reasonCode, "PROJECT_DOCUMENT_SOURCE_CHANGED");
      }
      assert.doesNotMatch(fs.readFileSync(product, "utf8"), /문서를 갱신하는 중입니다/);
    });
});

test("Notion recovery reads every same-title child; a parent too large for one call is reported, not repeated", async (t) => {
  for (const [count, exact] of [
    [13, true],
    [40, false],
  ])
    await t.test(`${count} children with the same title`, async () => {
      const fake = notion();
      for (let i = 0; i < count; i++) {
        const id = "20000000-0000-4000-8000-" + String(7000 + i).padStart(12, "0");
        fake.pages.set(id, { id, parent: { page_id: fake.parent }, title: "같은 제목", markdown: exact && i === count - 1 ? "정확한 본문" : `다른 본문 ${i}` });
      }
      const adapter = fake.adapter();
      adapter.beginPublication();
      const found = await adapter.find({ title: "같은 제목", markdown: "정확한 본문" });
      if (exact) {
        assert.equal(found.complete, true);
        assert.equal(found.matches.length, 1);
      } else {
        assert.equal(found.complete, false);
        assert.equal(found.limit, "parent-listing-exceeds-one-call-budget");
        assert.equal(found.cursor, undefined, "no partial position is kept or offered for a repeat");
      }
    });
});

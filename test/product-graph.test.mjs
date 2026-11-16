// 제품 그래프 bundle 1: store, 기능/코드 extraction and 정합성 검사.
// Fixtures are synthetic; no other project is read.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fixture, snapshot, pluginRoot } from "./helpers/session-work-linkage-fixture.mjs";
import { buildProductGraph, checkProductGraph, approveProductGraphDocument, moveProductGraphBaseline } from "../scripts/lib/world/product-graph.mjs";
import { queryProductGraph } from "../scripts/lib/world/product-graph-query.mjs";
import { buildGraphExplorerSnapshot } from "../scripts/lib/world/graph-explorer.mjs";
import { registryCatalog, OPERATIONS } from "../scripts/lib/session/operation-registry.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";
import { runCommand } from "../scripts/lode.mjs";
import { exportProjectBundle, inspectProjectBundle, importProjectBundle } from "../scripts/lib/storage/project-portability.mjs";
import { adoptVerifiedProjectCopy } from "../scripts/lib/storage/project-copy-adoption.mjs";
import { buildSnapshotDeletionClosure } from "../scripts/lib/world/snapshot-deletion-closure.mjs";
import { inspectSnapshotPreservationClosure } from "../scripts/lib/world/snapshot-preservation-closure.mjs";
import { buildWorldModel } from "../scripts/lib/world/world-model.mjs";

const fixtures = path.join(pluginRoot, "test", "fixtures", "product-graph");
const signalProduct = path.join(fixtures, "ui-signal");
const signalDocuments = path.join(fixtures, "ui-signal-documents");
const emptyRules = path.join(fixtures, "empty-rules.json");
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function temporary(t, prefix = "lode-product-graph-") {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(process.env.HEAD_AGENT_TEST_TMP || os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

function tree(root) {
  const out = {};
  const visit = (relative) => {
    const absolute = path.join(root, relative);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(child);
      else out[child] = sha(fs.readFileSync(path.join(root, child)));
    }
  };
  visit("");
  return out;
}

const signalCheck = (extra = {}) => checkProductGraph({ sourceRoot: signalProduct, documentsDirectory: signalDocuments, rulesFile: emptyRules, ...extra });
const check = (result, key) => result.checks.find((item) => item.key === key);

// Puts the synthetic product and its documents into a fresh Lode Project.
function productProject(t, { documents = true } = {}) {
  const f = fixture(t);
  fs.cpSync(signalProduct, f.root, { recursive: true });
  const family = path.join(f.root, ".lode", "context", "product-graph");
  if (documents) fs.cpSync(signalDocuments, family, { recursive: true });
  return { ...f, family };
}

test("acceptance 1: Lode on itself yields tool:, cli:, hook: and command: 기능 matching the live registry, hook files and skills", (t) => {
  const out = path.join(temporary(t), "out");
  const empty = path.join(path.dirname(out), "documents");
  fs.mkdirSync(empty);
  const result = buildProductGraph({
    sourceRoot: pluginRoot,
    documentsDirectory: empty,
    rulesFile: path.join(fixtures, "lode-entry-rules.json"),
    outputDirectory: out,
  });
  const graph = JSON.parse(fs.readFileSync(path.join(out, "graph.json"), "utf8"));
  const ids = new Set(graph.nodes.filter((node) => node.type === "기능").map((node) => node.id));
  const kind = (prefix) => new Set([...ids].filter((id) => id.startsWith(prefix)));
  assert.deepEqual(
    [...kind("tool:")].sort(),
    registryCatalog()
      .map((tool) => `tool:${tool.name}`)
      .sort(),
  );
  const registered = OPERATIONS.filter((entry) => entry.cli)
    .flatMap((entry) => [entry.cli.command, ...(entry.cli.aliases ?? [])])
    .map((name) => `cli:${name}`);
  for (const name of registered) assert(ids.has(name), name);
  // Extra cli: 기능 come only from a package.json bin (built-in rule).
  const extra = [...kind("cli:")].filter((id) => !registered.includes(id));
  for (const id of extra)
    assert(
      graph.nodes.find((node) => node.id === id).positions.every((position) => position.path.endsWith("package.json")),
      id,
    );
  const events = new Set();
  for (const file of ["hooks/claude.json", "hooks/codex.json"])
    for (const event of Object.keys(JSON.parse(fs.readFileSync(path.join(pluginRoot, file), "utf8")).hooks)) events.add(`hook:${event}`);
  assert.deepEqual([...kind("hook:")].sort(), [...events].sort());
  const skills = fs.readdirSync(path.join(pluginRoot, "skills")).filter((name) => fs.existsSync(path.join(pluginRoot, "skills", name, "SKILL.md")));
  assert.deepEqual([...kind("command:")].sort(), skills.map((name) => `command:${name}`).sort());
  // The first build into a folder also takes the comparison baseline (bundle 2, 8A.2).
  assert.deepEqual(
    result.written.map((item) => item.name),
    ["graph.json", "check.json", "check.txt", "build-context.json", "baseline.json", "baseline-content.json"],
  );
});

// Builds one synthetic product with no documents and returns its graph and check.
function family(t, product, rules = emptyRules) {
  const base = temporary(t);
  fs.mkdirSync(path.join(base, "documents"));
  const result = buildProductGraph({
    sourceRoot: product,
    documentsDirectory: path.join(base, "documents"),
    rulesFile: rules,
    outputDirectory: path.join(base, "out"),
  });
  const graph = JSON.parse(fs.readFileSync(path.join(base, "out", "graph.json"), "utf8"));
  const handler = (id) => graph.edges.filter((edge) => edge.type === "기능→코드" && edge.from === id).map((edge) => edge.to);
  const front = graph.nodes.filter((node) => node.type === "기능" && node.id.startsWith("fe/")).map((node) => node.id);
  const notTaken = result.lists.notTakenBindings.map(({ path: file, event, pattern }) => [file, event, pattern]);
  return { result, graph, handler, front, notTaken };
}

test("acceptance 2, DOM: listeners, on<event> properties, inline attributes and the page's own start-up", (t) => {
  const { front, handler, notTaken, result } = family(t, path.join(fixtures, "ui-dom"));
  assert.deepEqual(front, [
    "fe/app/app@click:clear",
    "fe/app/app@click:saveForm",
    "fe/app/app@effect:loadDraft",
    "fe/app/app@effect:pollStatus",
    "fe/app/bindShortcuts@keydown:window",
    "fe/dialog/dialog@click:confirmDelete",
    "fe/index/index@click:submitDraft",
    "fe/index/index@click:요소#1",
    "fe/index/index@effect:init",
  ]);
  assert.deepEqual(handler("fe/app/app@click:saveForm"), ["app.js#saveForm"]);
  assert.deepEqual(handler("fe/app/app@click:clear"), ["app.js#clearForm"]);
  assert.deepEqual(notTaken, [["app.js", "saved", "DOM addEventListener"]]);
  assert.match(result.text, /기능으로 삼지 않은 연결: 1개/);
  assert.deepEqual(result.lists.uiWithoutRule, []);
});

test("acceptance 2, component templates: JSX, Vue and Svelte bindings and what each screen runs by itself", (t) => {
  const { front, handler, notTaken } = family(t, path.join(fixtures, "ui-template"));
  assert.deepEqual(front, [
    "fe/src/App/App@click:handleSave",
    "fe/src/App/App@click:요소#1",
    "fe/src/App/App@effect:요소#2",
    "fe/src/App/SettingsDialog@click:closeDialog",
    "fe/src/Panel/Panel@click:refresh",
    "fe/src/Panel/Panel@effect:요소#1",
    "fe/src/Panel/Panel@keyup:search",
    "fe/src/Toggle/Toggle@click:flip",
    "fe/src/Toggle/Toggle@effect:요소#1",
  ]);
  assert.deepEqual(handler("fe/src/App/App@click:handleSave"), ["src/App.jsx#App.handleSave"]);
  assert.deepEqual(handler("fe/src/App/App@effect:요소#2"), ["src/App.jsx#loadItems"]);
  assert.deepEqual(notTaken, [
    ["src/App.jsx", "load", "JSX on<Event>"],
    ["src/Panel.vue", "selected", "Vue @event / v-on:"],
    ["src/Toggle.svelte", "introend", "Svelte on:event"],
  ]);
});

test("acceptance 2, signal/slot and callback toolkits: connect, overridden event methods, command= and bind", (t) => {
  const { front, handler, notTaken, graph } = family(t, signalProduct);
  const window = "fe/station/ui/main_window",
    tk = "fe/station/tools/calibrate_tk/CalibrateWindow";
  assert.deepEqual(front, [
    `${tk}@Button-1:mark`,
    `${tk}@command:start`,
    `${tk}@command:stop_button`,
    `${tk}@effect:tick`,
    `${window}/ExportDialog@clicked:accept`,
    `${window}/MainWindow@clicked:_save`,
    `${window}/MainWindow@clicked:help_button`,
    `${window}/MainWindow@clicked:reset_button`,
    `${window}/MainWindow@close:closeEvent`,
    `${window}/MainWindow@effect:_poll`,
    `${window}/MainWindow@toggled:_toggle_details`,
  ]);
  assert.deepEqual(handler(`${window}/MainWindow@clicked:reset_button`), ["station/ui/main_window.py#MainWindow._reset_view"]);
  assert.deepEqual(handler(`${tk}@command:stop_button`), ["station/tools/calibrate_tk.py#CalibrateWindow.stop"]);
  assert.deepEqual(handler("cli:sample-station"), ["station/app.py#main"]);
  assert.deepEqual(notTaken, [
    ["station/tools/calibrate_tk.py", "Configure", "Tk bind"],
    ["station/ui/main_window.py", "changed", "Qt signal.connect"],
    ["station/ui/main_window.py", "destroyed", "Qt signal.connect"],
  ]);
  assert(
    graph.edges.some(
      (edge) =>
        edge.type === "callback" && edge.from === "station/ui/main_window.py#MainWindow.__init__" && edge.to === "station/ui/main_window.py#MainWindow._render",
    ),
  );
});

test("acceptance 2, a toolkit with no built-in pattern: its project rule alone yields 기능; without it the file is a listed gap", (t) => {
  const without = family(t, path.join(fixtures, "ui-custom"));
  assert.deepEqual(without.front, []);
  assert.deepEqual(without.result.lists.uiWithoutRule, [{ path: "app/window.py", sign: "GTK" }]);
  assert.match(without.result.text, /화면 코드인데 규칙이 없음: 1개/);
  const ruled = family(t, path.join(fixtures, "ui-custom"), path.join(fixtures, "ui-custom-rules.json"));
  assert.deepEqual(ruled.front, ["fe/app/window/NotesWindow@activate:entry", "fe/app/window/NotesWindow@clicked:on_save"]);
  assert.deepEqual(ruled.handler("fe/app/window/NotesWindow@clicked:on_save"), ["app/window.py#NotesWindow.on_save"]);
  assert.deepEqual(ruled.notTaken, [["app/window.py", "destroy", "GTK widget.connect"]]);
  assert.deepEqual(ruled.result.lists.uiWithoutRule, []);
});

test("acceptance 2, Lode on itself: the Graph Explorer's DOM listeners yield fe/ 기능 and are all accounted for", (t) => {
  const out = path.join(temporary(t), "out");
  fs.mkdirSync(path.join(path.dirname(out), "documents"));
  const result = buildProductGraph({
    sourceRoot: pluginRoot,
    documentsDirectory: path.join(path.dirname(out), "documents"),
    rulesFile: path.join(fixtures, "lode-entry-rules.json"),
    outputDirectory: out,
  });
  const graph = JSON.parse(fs.readFileSync(path.join(out, "graph.json"), "utf8"));
  // The map (browser.js) and, since bundle 2, the other views (views.js).
  const pages = ["scripts/graph-explorer/browser.js", "scripts/graph-explorer/views.js"];
  const front = graph.nodes.filter((node) => node.type === "기능" && node.id.startsWith("fe/"));
  assert(front.length > 0);
  for (const node of front) assert.match(node.id, /^fe\/scripts\/graph-explorer\/(browser|views)\//, node.id);
  for (const page of pages) {
    // Every listener line is a 기능 position or a listed wiring not taken, except
    // one whose event name is computed at run time (not readable by regex).
    const seen = new Set([
      ...front.flatMap((node) => node.positions.filter((position) => position.path === page).map((position) => position.line)),
      ...result.lists.notTakenBindings.filter((item) => item.path === page).map((item) => item.line),
    ]);
    const lines = fs.readFileSync(path.join(pluginRoot, page), "utf8").split("\n");
    const unread = lines.map((line, index) => [line, index + 1]).filter(([line, number]) => line.includes(".addEventListener(") && !seen.has(number));
    assert(
      unread.every(([line]) => !/addEventListener\(\s*["'`]/.test(line)),
      JSON.stringify(unread),
    );
  }
});

test("acceptance 3: checks over the document fixture find each planted gap exactly and say why the others cannot run", () => {
  const result = signalCheck({ includeEstimates: true });
  const ids = (key) => check(result, key).findings.map((finding) => finding.id);
  assert.deepEqual(ids("element-function-without-activity"), ["DLG-01#1", "MAIN-01#2", "MAIN-01#3"]);
  assert.deepEqual(ids("screen-without-activity"), ["DLG-01"]);
  const policy = check(result, "screen-policy-differs").findings;
  assert.deepEqual(
    policy.map((item) => [item.screen, item.id, item.differences.map((difference) => difference.field)]),
    [["MAIN-01", "P1", ["행위"]]],
  );
  assert.deepEqual(
    result.lists.missingIds.map((item) => item.id),
    ["fe/station/ui/main_window/MainWindow@clicked:_export"],
  );
  assert.deepEqual(
    ["product-core-policy", "activity-navigate", "journey-order-differs"].map((key) => [check(result, key).outcome, check(result, key).reason]),
    [
      ["검사 못 함", "제품 정의서가 없다"],
      ["검사 못 함", "navigate 연결을 뽑지 않음"],
      ["검사 못 함", "유저 저니맵이 없다"],
    ],
  );
  for (const item of result.checks) assert.equal(["findings", "0건", "검사 못 함"].includes(item.outcome), true);
  for (const item of result.checks) if (item.outcome === "검사 못 함") assert(!item.findings && !item.compared);
  // Readable Korean, with the original's phrases and no English node-type labels.
  for (const phrase of ["제품코어와 부딪히는 정책", "어떤 유저 활동도 가리키지 않는 화면", "목적 없는 화면", "막힌 동선"])
    assert(result.text.includes(phrase), phrase);
  for (const word of ["Screen", "Feature", "Policy", "Activity", "Element", "Function"]) assert(!result.text.includes(word), word);
});

test("the journey check compares 다음 활동 with the stage order when the 유저 저니맵 lists activity IDs", (t) => {
  const documents = path.join(temporary(t), "documents");
  fs.cpSync(signalDocuments, documents, { recursive: true });
  const activity = fs.readFileSync(path.join(documents, "유저플로우 기획서", "UA-MAIN-01.md"), "utf8");
  fs.writeFileSync(
    path.join(documents, "유저플로우 기획서", "UA-MAIN-02.md"),
    activity.replaceAll("UA-MAIN-01", "UA-MAIN-02").replace("## 다음 활동\n\n없음.", "## 다음 활동\n\n- UA-MAIN-01"),
  );
  fs.writeFileSync(
    path.join(documents, "유저 저니맵.md"),
    "# 유저 저니맵\n\n## 단계\n\n| 단계 | 원하는 것 | 유저 활동 |\n|---|---|---|\n| 시작 | 켠다 | UA-MAIN-01 |\n| 끝 | 마친다 | UA-MAIN-02 |\n",
  );
  const result = checkProductGraph({ sourceRoot: signalProduct, documentsDirectory: documents, rulesFile: emptyRules, includeEstimates: true });
  const journey = check(result, "journey-order-differs");
  assert.equal(journey.outcome, "findings");
  assert.deepEqual(
    journey.findings.map((item) => [item.id, item.next]),
    [["UA-MAIN-02", "UA-MAIN-01"]],
  );
});

test("acceptance 4: only approved documents count; an edit unapproves; the estimate option labels findings", async (t) => {
  const f = productProject(t);
  let result = checkProductGraph({ root: f.root });
  assert.deepEqual([result.documents.approved, result.documents.estimated], [0, 4]);
  assert.equal(check(result, "element-function-without-activity").reason, "승인된 화면설계서가 없다 (추정 2개는 기본 검사에 쓰지 않는다)");
  assert.match(result.text, /문서: 승인 0, 승인 뒤 바뀜 0, 추정 4/);
  const digest = (relative) => result.documents.list.find((item) => item.path === relative).approvalDigest;
  // Through the router, the review needs explicit confirmation.
  const call = (args) =>
    dispatch({
      jsonrpc: "2.0",
      id: "approve",
      method: "tools/call",
      params: { name: "lode_tools_call", arguments: { name: "lode_product_graph_approve", arguments: args } },
    });
  const base = {
    project_root: f.root,
    document: "화면설계서/MAIN-01.md",
    expected_sha256: digest("화면설계서/MAIN-01.md"),
    rationale: "User read the screen spec.",
  };
  const refused = await call({ ...base, confirm_user_review: false });
  assert.match(JSON.stringify(refused), /PRODUCT_GRAPH_APPROVAL_CONFIRMATION_REQUIRED/);
  const readOnly = await dispatch({
    jsonrpc: "2.0",
    id: "read-approve",
    method: "tools/call",
    params: { name: "lode_tools_read", arguments: { name: "lode_product_graph_approve", arguments: { ...base, confirm_user_review: true } } },
  });
  assert(readOnly.error || readOnly.result?.isError, JSON.stringify(readOnly));
  const stale = await call({ ...base, expected_sha256: "0".repeat(64), confirm_user_review: true });
  assert.match(JSON.stringify(stale), /PRODUCT_GRAPH_APPROVAL_STALE/);
  const approved = await call({ ...base, confirm_user_review: true });
  assert(!approved.error && !approved.result?.isError, JSON.stringify(approved));
  for (const relative of ["화면설계서/DLG-01.md", "유저플로우 기획서/UA-MAIN-01.md", "정책.md"])
    assert.equal(
      approveProductGraphDocument({ root: f.root, document: relative, expectedSha256: digest(relative), rationale: "User approved." }).status,
      "recorded",
    );
  assert.equal(
    approveProductGraphDocument({ root: f.root, document: "정책.md", expectedSha256: digest("정책.md"), rationale: "User approved." }).status,
    "existing",
  );
  result = checkProductGraph({ root: f.root });
  assert.deepEqual([result.documents.approved, result.documents.estimated], [4, 0]);
  assert.deepEqual(
    check(result, "element-function-without-activity").findings.map((item) => item.id),
    ["DLG-01#1", "MAIN-01#2", "MAIN-01#3"],
  );
  assert(check(result, "element-function-without-activity").findings.every((item) => !item.labels.length));
  // A status word typed into the document proves nothing; an edit unapproves.
  const main = path.join(f.family, "화면설계서", "MAIN-01.md");
  fs.writeFileSync(main, fs.readFileSync(main, "utf8") + "\n상태: 승인\n");
  result = checkProductGraph({ root: f.root });
  assert.deepEqual([result.documents.approved, result.documents.changedAfterApproval, result.documents.estimated], [3, 1, 0]);
  assert.equal(result.documents.list.find((item) => item.path === "화면설계서/MAIN-01.md").status, "승인 뒤 바뀜");
  assert.deepEqual(
    check(result, "element-function-without-activity").findings.map((item) => item.id),
    ["DLG-01#1"],
  );
  assert(result.lists.missingIds.some((item) => item.id === "MAIN-01#1" && item.note === "추정 문서에만 있음"));
  const estimated = checkProductGraph({ root: f.root, includeEstimates: true });
  const finding = check(estimated, "element-function-without-activity").findings.find((item) => item.id === "MAIN-01#2");
  assert.deepEqual(finding.labels, ["추정: 코드만 보고 쓴 추정, 승인 뒤 바뀜"]);
  assert.match(estimated.text, /MAIN-01#2 .*\[추정: 코드만 보고 쓴 추정, 승인 뒤 바뀜\]/);
});

// H3: every generated file, both modes, byte for byte.
const filesUnder = (directory) => {
  const out = new Map();
  const visit = (relative) => {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(child);
      else out.set(child, fs.readFileSync(path.join(directory, child)));
    }
  };
  visit("");
  return out;
};

test("acceptance 5 / 15: two builds of the same input give byte-identical files, in stand-alone and project mode", (t) => {
  const base = temporary(t);
  for (const name of ["first", "second"])
    buildProductGraph({
      sourceRoot: signalProduct,
      documentsDirectory: signalDocuments,
      rulesFile: emptyRules,
      outputDirectory: path.join(base, name),
      includeEstimates: true,
    });
  const first = filesUnder(path.join(base, "first")),
    second = filesUnder(path.join(base, "second"));
  assert.deepEqual([...first.keys()].sort(), ["baseline-content.json", "baseline.json", "build-context.json", "check.json", "check.txt", "graph.json"]);
  assert.deepEqual([...second.keys()].sort(), [...first.keys()].sort());
  // Each folder took its own baseline at its own time (bundle 2, 8A.2), and the
  // check names that time; graph.json is byte-identical across folders.
  assert.deepEqual(second.get("graph.json"), first.get("graph.json"));
  // Building again into the same folder changes no byte.
  buildProductGraph({
    sourceRoot: signalProduct,
    documentsDirectory: signalDocuments,
    rulesFile: emptyRules,
    outputDirectory: path.join(base, "first"),
    includeEstimates: true,
  });
  for (const [name, bytes] of filesUnder(path.join(base, "first"))) assert.deepEqual(bytes, first.get(name), name);

  const f = productProject(t);
  const build = path.join(f.family, "build");
  buildProductGraph({ root: f.root });
  const projectFirst = filesUnder(build);
  buildProductGraph({ root: f.root });
  const projectSecond = filesUnder(build);
  assert.deepEqual([...projectFirst.keys()].sort(), [
    ".gitignore",
    "baseline-content.json",
    "baseline.json",
    "build-context.json",
    "check.json",
    "check.txt",
    "graph.json",
  ]);
  assert.deepEqual([...projectSecond.keys()].sort(), [...projectFirst.keys()].sort());
  for (const [name, bytes] of projectFirst) assert.deepEqual(projectSecond.get(name), bytes, name);
});

test("acceptance 6: with no documents the build gives the code layer and the check names what is missing", (t) => {
  const base = temporary(t);
  fs.mkdirSync(path.join(base, "documents"));
  const result = buildProductGraph({
    sourceRoot: signalProduct,
    documentsDirectory: path.join(base, "documents"),
    rulesFile: emptyRules,
    outputDirectory: path.join(base, "out"),
  });
  assert.equal(result.counts["기능"], 12);
  assert(result.counts["코드"] > 0);
  assert.deepEqual(
    result.checks.map((item) => [item.outcome, item.reason]),
    [
      ["검사 못 함", "제품 정의서가 없다, 정책 파일이 없다"],
      ["검사 못 함", "화면설계서가 없다"],
      ["검사 못 함", "navigate 연결을 뽑지 않음"],
      ["검사 못 함", "화면설계서가 없다"],
      ["검사 못 함", "정책 파일이 없다"],
      ["검사 못 함", "유저 저니맵이 없다"],
    ],
  );
  assert.match(result.text, /어떤 화면요소·화면도 가리키지 않는 기능: 기능 12개 중 — 검사 못 함: 화면설계서가 없다/);
  assert(result.checks.every((item) => item.outcome !== "0건"));
});

test("acceptance 14: with no documents a guide names each missing input; with everything approved there is none", (t) => {
  const base = temporary(t);
  fs.mkdirSync(path.join(base, "documents"));
  const empty = checkProductGraph({ sourceRoot: signalProduct, documentsDirectory: path.join(base, "documents"), rulesFile: emptyRules });
  assert.deepEqual(
    empty.guide.map((item) => [item.input, item.state]),
    [
      ["제품 정의서", "없음"],
      ["유저 저니맵", "없음"],
      ["화면설계서", "없음"],
      ["유저플로우 기획서", "없음"],
      ["정책 파일", "없음"],
    ],
  );
  assert(empty.guide.every((item) => item.unlocks.length && item.next));
  const lines = empty.text.split("\n");
  assert(lines.includes("처음 쓸 때 — 빠진 입력"));
  assert(lines.some((line) => line.startsWith("- 화면설계서 (없음). 쓰는 곳: 검사 2, 검사 4, 검사 5, 목록: 어떤 화면요소·화면도 가리키지 않는 기능. 다음: ")));
  // Stand-alone: the next step is what works there, not an approval.
  assert(empty.guide.every((item) => item.next.includes("--include-estimates") && !item.next.includes("product-graph-approve")));
  assert(empty.checks.every((item) => item.outcome === "검사 못 함" && item.reason));
  const head = lines.findIndex((line) => line.startsWith("어떤 화면요소·화면도 가리키지 않는 기능:"));
  assert(lines[head].endsWith("검사 못 함: 화면설계서가 없다"));
  assert(!lines[head + 1].startsWith("  - "), "the unpointed list prints a count, not every 기능");
  assert.equal(empty.lists.unpointedFunctionsReason, "화면설계서가 없다");

  // Every input written and approved: no guide block.
  const f = productProject(t);
  const write = (name, text) => fs.writeFileSync(path.join(f.family, name), text);
  write("제품 정의서.md", "# 제품 정의서\n\n## 정체성\n\n스테이션\n\n## 타겟 유저\n\n운영자\n\n## 제공 가치\n\n상태\n\n## 브랜딩\n\n없음\n");
  write("유저 저니맵.md", "# 유저 저니맵\n\n## 단계\n\n| 단계 | 유저 활동 |\n|---|---|\n| 시작 | UA-MAIN-01 |\n");
  for (const item of checkProductGraph({ root: f.root }).documents.list)
    approveProductGraphDocument({ root: f.root, document: item.path, expectedSha256: item.approvalDigest, rationale: "ok" });
  const full = checkProductGraph({ root: f.root });
  assert.deepEqual(full.guide, []);
  assert(!full.text.includes("처음 쓸 때 — 빠진 입력"));
});

test("acceptance 7: stand-alone mode writes only under the output directory; project mode only the build folder", async (t) => {
  const base = temporary(t);
  const source = path.join(base, "analysed");
  fs.cpSync(signalProduct, source, { recursive: true });
  const before = tree(source),
    documentsBefore = tree(signalDocuments);
  await runCommand(["product-graph-build", source, "--documents", signalDocuments, "--rules", emptyRules, "--out", path.join(base, "out")]);
  assert.deepEqual(tree(source), before);
  assert.deepEqual(tree(signalDocuments), documentsBefore);
  assert.deepEqual(Object.keys(tree(path.join(base, "out"))).sort(), [
    "baseline-content.json",
    "baseline.json",
    "build-context.json",
    "check.json",
    "check.txt",
    "graph.json",
  ]);
  const checkBefore = tree(source);
  await runCommand(["product-graph-check", source, "--documents", signalDocuments, "--rules", emptyRules]);
  assert.deepEqual(tree(source), checkBefore);
  await assert.rejects(runCommand(["product-graph-build", source, "--documents", signalDocuments]), { code: "PRODUCT_GRAPH_STANDALONE_INPUT_REQUIRED" });

  // World ids before any product graph file exists, and after documents and
  // a build were added: the family is not a World input.
  const f = productProject(t, { documents: false });
  const productModel = fs.readFileSync(path.join(f.root, ".lode", "context", "product-model.json"));
  await buildWorldModel({ root: f.root });
  const worldBefore = JSON.parse(fs.readFileSync(path.join(f.root, ".lode", "world-model", "current.json"), "utf8"));
  fs.cpSync(signalDocuments, f.family, { recursive: true });
  const projectBefore = snapshot(f.root);
  const built = buildProductGraph({ root: f.root });
  const changed = Object.keys(snapshot(f.root)).filter((file) => projectBefore[file]?.digest !== snapshot(f.root)[file]?.digest);
  assert(changed.length > 0);
  for (const file of changed) assert.match(file.replaceAll("\\", "/"), /\.lode\/context\/product-graph\/build\//);
  assert.equal(built.outputLocation, ".lode/context/product-graph/build");
  assert.equal(fs.readFileSync(path.join(f.family, "build", ".gitignore"), "utf8").includes("*"), true);
  assert.deepEqual(fs.readFileSync(path.join(f.root, ".lode", "context", "product-model.json")), productModel);
  await buildWorldModel({ root: f.root });
  const worldAfter = JSON.parse(fs.readFileSync(path.join(f.root, ".lode", "world-model", "current.json"), "utf8"));
  assert.equal(worldAfter.worldModelId, worldBefore.worldModelId);
  assert.equal(worldAfter.sourceSnapshotId ?? null, worldBefore.sourceSnapshotId ?? null);
  assert.match(fs.readFileSync(path.join(f.root, ".lode", ".gitignore"), "utf8"), /\/context\/product-graph\/build\//);
});

test("the family travels through export and import with Korean names; build output and unknown files do not", (t) => {
  const f = productProject(t);
  const result = checkProductGraph({ root: f.root });
  const relative = "화면설계서/MAIN-01.md";
  approveProductGraphDocument({
    root: f.root,
    document: relative,
    expectedSha256: result.documents.list.find((item) => item.path === relative).approvalDigest,
    rationale: "ok",
  });
  buildProductGraph({ root: f.root });
  fs.writeFileSync(path.join(f.family, "메모.txt"), "not part of the family\n");
  const bundle = f.route(() => exportProjectBundle({ root: f.root, destination: path.join(f.base, "bundle") }));
  const inspected = inspectProjectBundle({ bundleRoot: bundle.bundleRoot });
  const family = inspected.manifest.files.map((file) => file.path).filter((name) => name.startsWith(".lode/context/product-graph/"));
  assert(family.includes(".lode/context/product-graph/화면설계서/MAIN-01.md"));
  assert(family.includes(".lode/context/product-graph/유저플로우 기획서/UA-MAIN-01.md"));
  assert(family.includes(".lode/context/product-graph/기능 뜻.md"));
  assert(family.some((name) => /\/승인\/product-graph-approval-[a-f0-9]{24}\.json$/.test(name)));
  assert(!family.some((name) => name.includes("/build/") || name.endsWith("메모.txt")));
  const target = path.join(f.base, "imported");
  fs.mkdirSync(target);
  assert.equal(importProjectBundle({ bundleRoot: bundle.bundleRoot, root: target, pluginRoot }).status, "imported");
  for (const name of family) assert.deepEqual(fs.readFileSync(path.join(target, name)), fs.readFileSync(path.join(f.root, name)), name);
  fs.cpSync(signalProduct, target, { recursive: true });
  assert.equal(checkProductGraph({ root: target }).documents.approved, 1);
});

test("folder-copy adoption verifies the family and keeps it byte-identical; a broken approval stops it", (t) => {
  const f = productProject(t);
  const result = checkProductGraph({ root: f.root });
  approveProductGraphDocument({
    root: f.root,
    document: "정책.md",
    expectedSha256: result.documents.list.find((item) => item.path === "정책.md").approvalDigest,
    rationale: "ok",
  });
  const unverified = (root) => {
    const file = path.join(root, ".lode/project.json");
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), projectRoot: "C:/unverified-origin/synthetic-project" }, null, 2) + "\n");
    const manifestFile = path.join(root, ".lode/generated/manifest.json"),
      manifest = JSON.parse(fs.readFileSync(manifestFile));
    manifest.managed.find((entry) => entry.path === ".lode/project.json").sha256 = sha(fs.readFileSync(file));
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  };
  const copy = path.join(f.base, "copy");
  fs.cpSync(f.root, copy, { recursive: true });
  unverified(copy);
  const family = tree(path.join(copy, ".lode", "context", "product-graph"));
  assert.equal(adoptVerifiedProjectCopy({ root: copy, pluginRoot }).status, "verified-copy-adopted");
  assert.deepEqual(tree(path.join(copy, ".lode", "context", "product-graph")), family);
  const broken = path.join(f.base, "broken");
  fs.cpSync(f.root, broken, { recursive: true });
  unverified(broken);
  const approvals = path.join(broken, ".lode", "context", "product-graph", "승인");
  const approval = path.join(approvals, fs.readdirSync(approvals)[0]);
  fs.writeFileSync(approval, fs.readFileSync(approval, "utf8").replace("ok", "changed"));
  assert.throws(() => adoptVerifiedProjectCopy({ root: broken, pluginRoot }), { code: "PRODUCT_GRAPH_APPROVAL_INVALID" });
});

test("acceptance 19: unrecognised files in the family are kept and named, not GC issues; broken records and links still are", async (t) => {
  const f = productProject(t);
  buildProductGraph({ root: f.root });
  const closure = await buildSnapshotDeletionClosure({ root: f.root });
  assert.deepEqual(
    closure.issues.filter((item) => item.path.includes("product-graph")),
    [],
  );
  assert(closure.entries.some((row) => row.path === ".lode/context/product-graph/화면설계서/MAIN-01.md"));
  assert(!closure.entries.some((row) => row.path.includes("/product-graph/build/")));
  const certifiedBefore = closure.certified;
  fs.writeFileSync(path.join(f.family, "메모.txt"), "unknown\n");
  fs.mkdirSync(path.join(f.family, "초안"));
  fs.writeFileSync(path.join(f.family, "초안", "생각.md"), "draft\n");
  const before = tree(f.family);
  const kept = await buildSnapshotDeletionClosure({ root: f.root });
  assert.deepEqual(
    kept.issues.filter((item) => item.path.includes("product-graph")),
    [],
  );
  assert.equal(certifiedBefore, true);
  assert.equal(kept.certified, true);
  assert.deepEqual(kept.productGraphKept, [
    { path: ".lode/context/product-graph/메모.txt", kind: "file" },
    { path: ".lode/context/product-graph/초안", kind: "folder" },
  ]);
  assert(!kept.entries.some((row) => row.path.includes("메모.txt") || row.path.includes("초안")));
  const preservation = await inspectSnapshotPreservationClosure({ root: f.root });
  assert.equal(preservation.coverage.productGraph, "user-owned-canon-and-generated-output-hold-no-snapshot-references");
  assert.deepEqual(preservation.productGraphKept, kept.productGraphKept);
  assert.deepEqual(tree(f.family), before);
  // A recognised file that fails verification is still an issue.
  const approvals = path.join(f.family, "승인");
  fs.mkdirSync(approvals, { recursive: true });
  fs.writeFileSync(path.join(approvals, `product-graph-approval-${"a".repeat(24)}.json`), "{}\n");
  const broken = await buildSnapshotDeletionClosure({ root: f.root });
  assert(broken.issues.some((item) => item.path.includes("승인/product-graph-approval-") && item.reasonCode === "PRODUCT_GRAPH_APPROVAL_INVALID"));
  assert.equal(broken.certified, false);
  fs.rmSync(approvals, { recursive: true });
  // A link in place of a family folder is refused.
  const outside = path.join(f.base, "outside-screens");
  fs.mkdirSync(outside);
  fs.renameSync(path.join(f.family, "화면설계서"), path.join(f.base, "screens-moved"));
  if (link(t, outside, path.join(f.family, "화면설계서"))) {
    const linked = await buildSnapshotDeletionClosure({ root: f.root });
    assert.equal(linked.certified, false);
    assert(linked.issues.length > 0);
  }
});

test("the product graph tools are routed, not listed by default, and check is read-only", async () => {
  const listed = await dispatch({ jsonrpc: "2.0", id: "list", method: "tools/list", params: {} });
  assert(!listed.result.tools.some((tool) => tool.name.startsWith("lode_product_graph")));
  const catalog = new Map(registryCatalog().map((tool) => [tool.name, tool]));
  assert.equal(catalog.get("lode_product_graph_check").annotations.readOnlyHint, true);
  assert.equal(catalog.get("lode_product_graph_build").annotations.readOnlyHint, false);
  assert.equal(catalog.get("lode_product_graph_approve").annotations.readOnlyHint, false);
});

test("every built-in UI binding pattern is an ordinary table entry: it passes the same check as a Project rule", async () => {
  const { BUILT_IN_UI_PATTERNS } = await import("../scripts/lib/world/product-graph-ui-patterns.mjs");
  const { verifyProductGraphRules } = await import("../scripts/lib/storage/product-graph-store.mjs");
  const rules = { schemaVersion: 1, kind: "LodeProductGraphEntryRules", rules: BUILT_IN_UI_PATTERNS.map((entry) => ({ 종류: "프론트", ...entry })) };
  assert.doesNotThrow(() => verifyProductGraphRules(JSON.parse(JSON.stringify(rules))));
  assert(new Set(BUILT_IN_UI_PATTERNS.map((entry) => entry.이름)).size === BUILT_IN_UI_PATTERNS.length);
});

const reachProduct = path.join(fixtures, "reach");

test("acceptance 9: code no 기능 reaches is listed; code two resolved hops away is not; the head carries the bounds", (t) => {
  const { result } = family(t, reachProduct);
  const unreached = result.lists.unreachedCode.files.flatMap((file) => file.declarations);
  assert(unreached.includes("tool/cli.py#orphan"));
  assert(unreached.includes("tool/steps.py#unused"));
  assert(!unreached.includes("tool/steps.py#second"), "two hops: main -> first -> second");
  assert(!unreached.includes("tool/steps.py#first"));
  assert.equal(result.lists.unreachedCode.files.find((file) => file.path === "tool/mixed.py").nothingReached, true);
  const head = result.text.split("\n").find((line) => line.startsWith("어느 기능에서도 닿지 않는 코드:"));
  const { resolved, all } = result.lists.unresolvedReferences;
  assert(head.includes(`풀린 호출 ${resolved} / 전체 ${all}`), head);
  assert(head.includes("죽은 코드라는 뜻이 아니다"), head);
});

test("acceptance 9 on Lode itself: the unreached-code list prints (no count pinned)", (t) => {
  const base = temporary(t);
  fs.mkdirSync(path.join(base, "documents"));
  const result = checkProductGraph({
    sourceRoot: pluginRoot,
    documentsDirectory: path.join(base, "documents"),
    rulesFile: path.join(fixtures, "lode-entry-rules.json"),
  });
  assert(result.text.includes("어느 기능에서도 닿지 않는 코드: 선언 "));
  assert(Array.isArray(result.lists.unreachedCode.files));
});

test("acceptance 10: the limits block is the first block of build and check text, in both modes, and the structured result carries it", async (t) => {
  const firstBlock = (text) => text.split("\n\n")[0].split("\n");
  const base = temporary(t);
  fs.mkdirSync(path.join(base, "documents"));
  const standalone = { sourceRoot: reachProduct, documentsDirectory: path.join(base, "documents"), rulesFile: emptyRules };
  const f = productProject(t);
  const runs = [
    checkProductGraph(standalone),
    buildProductGraph({ ...standalone, outputDirectory: path.join(base, "out") }),
    checkProductGraph({ root: f.root }),
    buildProductGraph({ root: f.root }),
  ];
  for (const result of runs) {
    const block = firstBlock(result.text);
    assert.equal(block[0], "이 그래프가 답하지 못하는 것");
    assert(block.some((line) => line.includes(`호출 ${result.limits.calls.all}개.`)));
    assert(block.some((line) => line.includes(`제품 코드일 수 있는 호출 ${result.limits.calls.canBeProduct}개 중 ${result.limits.calls.resolved}개`)));
    assert(block.some((line) => line.includes("아무것도 실행하지 않았다")));
    assert(block.some((line) => line.includes("여러 줄 문자열과 템플릿 문자열")));
    assert(
      block.some((line) =>
        line.startsWith(
          `- 문서: 승인 ${result.limits.documents.approved}, 승인 뒤 바뀜 ${result.limits.documents.changedAfterApproval}, 추정 ${result.limits.documents.estimated}`,
        ),
      ),
    );
    assert.deepEqual(result.limits.referenceKinds.emitted, ["call", "callback"]);
    assert.deepEqual(result.limits.notExtracted.nodeTypes, ["데이터", "외부 연결", "DB", "계측 이벤트"]);
  }
  for (const directory of [path.join(base, "out"), path.join(f.family, "build")]) {
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(directory, "graph.json"), "utf8")).limits,
      JSON.parse(fs.readFileSync(path.join(directory, "check.json"), "utf8")).limits,
    );
    assert(fs.readFileSync(path.join(directory, "check.txt"), "utf8").startsWith("이 그래프가 답하지 못하는 것\n"));
  }
  // The same facts are not repeated as prose further down.
  assert(!runs[0].text.includes("코드→코드 reference:"));
});

test("acceptance 11: unresolved calls are counted per reason, the reasons add up, and files not read as code are counted", (t) => {
  const { result } = family(t, reachProduct);
  const calls = result.lists.unresolvedReferences;
  const count = (key) => calls.byReason.find((reason) => reason.reason === key);
  assert.deepEqual(
    count("ambiguous").callees.map((item) => item.callee),
    ["helper"],
  );
  assert.deepEqual(
    count("no-declaration").callees.map((item) => item.callee),
    ["undefined_thing"],
  );
  assert.deepEqual(
    count("external-import").callees.map((item) => item.callee),
    ["get"],
  );
  assert.equal(
    calls.byReason.reduce((sum, reason) => sum + reason.count, 0),
    calls.unresolved,
  );
  assert.equal(calls.resolved + calls.unresolved, calls.all);
  for (const reason of calls.byReason) assert(reason.settle.length > 0);
  assert.deepEqual(result.lists.notLookedAt.byExtension, [
    { extension: ".csv", count: 1 },
    { extension: ".md", count: 1 },
    { extension: ".toml", count: 1 },
  ]);
  assert.match(result.text, /코드로 읽지 않은 파일\(보지 않음\): 3개/);
});

test("acceptance 12: IDs carry no line numbers, survive inserted lines, and a vanished 기능's 뜻 line is kept and listed", (t) => {
  const base = temporary(t);
  const source = path.join(base, "source");
  fs.cpSync(reachProduct, source, { recursive: true });
  fs.mkdirSync(path.join(base, "documents"));
  const graphOf = (name) => {
    buildProductGraph({ sourceRoot: source, documentsDirectory: path.join(base, "documents"), rulesFile: emptyRules, outputDirectory: path.join(base, name) });
    return JSON.parse(fs.readFileSync(path.join(base, name, "graph.json"), "utf8"));
  };
  const before = graphOf("before");
  for (const name of ["cli.py", "steps.py", "mixed.py"]) {
    const file = path.join(source, "tool", name);
    fs.writeFileSync(file, "\n\n\n" + fs.readFileSync(file, "utf8"));
  }
  const after = graphOf("after");
  const ids = (graph) => graph.nodes.map((node) => node.id);
  const ends = (graph) => graph.edges.map((edge) => `${edge.type}|${edge.from}|${edge.to}`);
  assert.deepEqual(ids(after), ids(before));
  assert.deepEqual(ends(after), ends(before));
  assert.notDeepEqual(
    after.nodes.filter((node) => node.type === "코드").map((node) => node.lines),
    before.nodes.filter((node) => node.type === "코드").map((node) => node.lines),
  );
  assert(ids(before).includes("tool/mixed.py#helper~1") && ids(before).includes("tool/mixed.py#helper~2"));
  for (const id of ids(before)) assert(!/@\d+$/.test(id), id);

  // Project mode: the 뜻 line of a removed 기능 is listed, never touched.
  const f = fixture(t);
  fs.cpSync(reachProduct, f.root, { recursive: true });
  const family = path.join(f.root, ".lode", "context", "product-graph");
  fs.mkdirSync(family, { recursive: true });
  const meanings = path.join(family, "기능 뜻.md");
  fs.writeFileSync(meanings, "# 기능 뜻\n\n| 기능 | 뜻 |\n|---|---|\n| cli:reach-tool | 단계를 차례로 돈다 |\n");
  fs.writeFileSync(
    path.join(family, "정책.md"),
    "# 정책\n\n| ID | 종류 | 조건 | 주체 | 행위 | 지키는 기능 |\n|---|---|---|---|---|---|\n| P1 | 처리 | 언제나 | 도구 | 한 번만 돈다 | cli:reach-tool |\n",
  );
  const meaningBytes = fs.readFileSync(meanings);
  assert.deepEqual(checkProductGraph({ root: f.root }).lists.vanishedMeanings, []);
  const project = path.join(f.root, "pyproject.toml");
  fs.writeFileSync(project, fs.readFileSync(project, "utf8").replace('reach-tool = "tool.cli:main"', ""));
  const built = buildProductGraph({ root: f.root, includeEstimates: true });
  assert.deepEqual(built.lists.vanishedMeanings, [{ id: "cli:reach-tool", text: "단계를 차례로 돈다", at: { path: "기능 뜻.md", line: 5 } }]);
  assert(!built.lists.missingIds.some((item) => item.kind === "기능 뜻이 가리키는 기능"));
  assert(built.lists.missingIds.some((item) => item.kind === "정책이 가리키는 기능" && item.id === "cli:reach-tool"));
  assert.match(built.text, /사라진 기능의 뜻: 1개\n {2}- cli:reach-tool — "단계를 차례로 돈다"/);
  assert.deepEqual(fs.readFileSync(meanings), meaningBytes);
});

// ---------- review findings F1-F4, S1-S7 ----------

function scratchProduct(t, files) {
  const base = temporary(t);
  const source = path.join(base, "source");
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
    fs.writeFileSync(path.join(source, name), text);
  }
  fs.mkdirSync(path.join(base, "documents"));
  let run = 0;
  const build = () => {
    const out = path.join(base, `out-${(run += 1)}`);
    const result = buildProductGraph({ sourceRoot: source, documentsDirectory: path.join(base, "documents"), rulesFile: emptyRules, outputDirectory: out });
    return { result, graph: JSON.parse(fs.readFileSync(path.join(out, "graph.json"), "utf8")) };
  };
  return { base, source, build };
}

test("F1: two same-named declarations on one line get distinct IDs; a duplicate ID stops the build", async (t) => {
  const { graph } = scratchProduct(t, { "page.js": "function a() { return 1; } function a() { return 2; }\n" }).build();
  const ids = graph.nodes.filter((node) => node.type === "코드").map((node) => node.id);
  assert.deepEqual(ids, ["page.js", "page.js#a~1", "page.js#a~2"]);
  const { assertUniqueIds } = await import("../scripts/lib/world/product-graph-extraction.mjs");
  assert.throws(() => assertUniqueIds([{ id: "x" }, { id: "x" }]), { code: "PRODUCT_GRAPH_DUPLICATE_NODE_ID" });
});

test("F2: a lookup call without a literal id names no element; each 기능→코드 edge points at its own wiring site", (t) => {
  const { graph } = scratchProduct(t, {
    "page.js": [
      'const menu = document.getElementById("menu");',
      'for (const id of ["a", "b"]) $(id).addEventListener("click", () => go(id));',
      'menu.addEventListener("click", () => openA());',
      "",
      "",
      'menu.addEventListener("click", () => openB());',
      "function go(id) { return id; }",
      "function openA() { return 1; }",
      "function openB() { return 2; }",
      "",
    ].join("\n"),
  }).build();
  const front = graph.nodes.filter((node) => node.type === "기능").map((node) => node.id);
  assert.deepEqual(front, ["fe/page/page@click:menu", "fe/page/page@click:요소#1"]);
  const at = (to) => graph.edges.find((edge) => edge.type === "기능→코드" && edge.from === "fe/page/page@click:menu" && edge.to === to).at.line;
  assert.equal(at("page.js#openA"), 3);
  assert.equal(at("page.js#openB"), 6);
});

test("F3: wiring inside a block comment or a multi-line string is not a 기능", (t) => {
  const tick = String.fromCharCode(96);
  const { graph, result } = scratchProduct(t, {
    "page.js": [
      'document.getElementById("x");',
      "/*",
      '  old.addEventListener("click", save);',
      "*/",
      `const help = ${tick}`,
      '  button.addEventListener("click", load);',
      `${tick};`,
      `const live = ${tick}\${document.body.addEventListener("click", real)}${tick};`,
      "function save() {}",
      "function load() {}",
      "function real() {}",
      "",
    ].join("\n"),
  }).build();
  assert.deepEqual(
    graph.nodes.filter((node) => node.type === "기능").map((node) => node.id),
    ["fe/page/page@click:real"],
  );
  assert.deepEqual(result.lists.notTakenBindings, []);
});

test("F4: an ordinary property that starts with 'on' is not a DOM event", (t) => {
  const { graph, result } = scratchProduct(t, {
    "page.js": ['document.getElementById("x");', "state.online = true;", "state.only = save;", "button.onclick = save;", "function save() {}", ""].join("\n"),
  }).build();
  assert.deepEqual(result.lists.notTakenBindings, []);
  assert(!graph.edges.some((edge) => edge.type === "callback"));
  assert.deepEqual(
    graph.nodes.filter((node) => node.type === "기능").map((node) => node.id),
    ["fe/page/page@click:save"],
  );
});

function link(t, target, at) {
  try {
    fs.symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    t.diagnostic(`link not created: ${error.code}`);
    return false;
  }
}

test("S1: a linked build/ or 승인/ is refused before anything is written", (t) => {
  const f = productProject(t);
  const outside = path.join(f.base, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "graph.json"), "keep\n");
  if (!link(t, outside, path.join(f.family, "build"))) return t.skip("cannot create a directory link here");
  assert.throws(() => buildProductGraph({ root: f.root }), { code: "PRODUCT_GRAPH_LINKED_PATH" });
  assert.deepEqual(fs.readdirSync(outside), ["graph.json"]);
  assert.equal(fs.readFileSync(path.join(outside, "graph.json"), "utf8"), "keep\n");
  fs.unlinkSync(path.join(f.family, "build"));
  const approvals = path.join(f.base, "approvals-outside");
  fs.mkdirSync(approvals);
  assert(link(t, approvals, path.join(f.family, "승인")));
  const digest = checkProductGraph({ root: f.root }).documents.list.find((item) => item.path === "정책.md").approvalDigest;
  assert.throws(() => approveProductGraphDocument({ root: f.root, document: "정책.md", expectedSha256: digest, rationale: "ok" }), {
    code: "PRODUCT_GRAPH_LINKED_PATH",
  });
  assert.deepEqual(fs.readdirSync(approvals), []);
});

test("S2/S3: export names the family files it does not carry; a file named like a family folder is not a crash", (t) => {
  const f = productProject(t);
  fs.writeFileSync(path.join(f.family, "메모.md"), "note\n");
  fs.writeFileSync(path.join(f.family, "화면설계서", "cht-01.md"), "near miss\n");
  fs.rmSync(path.join(f.family, "유저플로우 기획서"), { recursive: true });
  fs.writeFileSync(path.join(f.family, "유저플로우 기획서"), "a file, not a folder\n");
  const exported = f.route(() => exportProjectBundle({ root: f.root, destination: path.join(f.base, "bundle") }));
  assert.equal(exported.status, "exported");
  assert.deepEqual(exported.productGraph.notRecognised, [
    ".lode/context/product-graph/메모.md",
    ".lode/context/product-graph/유저플로우 기획서",
    ".lode/context/product-graph/화면설계서/cht-01.md",
  ]);
  const copy = path.join(f.base, "copy");
  fs.cpSync(f.root, copy, { recursive: true });
  const file = path.join(copy, ".lode/project.json");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), projectRoot: "C:/unverified-origin/synthetic-project" }, null, 2) + "\n");
  const manifestFile = path.join(copy, ".lode/generated/manifest.json"),
    manifest = JSON.parse(fs.readFileSync(manifestFile));
  manifest.managed.find((entry) => entry.path === ".lode/project.json").sha256 = sha(fs.readFileSync(file));
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  assert.equal(adoptVerifiedProjectCopy({ root: copy, pluginRoot }).status, "verified-copy-adopted");
});

const nfd = (text) => text.normalize("NFD");

test("S4: NFC and NFD spellings of one document name are a listed problem, never two documents", (t) => {
  const f = productProject(t);
  fs.writeFileSync(path.join(f.family, nfd("정책.md")), "# 정책\n\n다른 내용\n");
  if (fs.readdirSync(f.family).filter((name) => name.normalize("NFC") === "정책.md").length < 2) return t.skip("this filesystem keeps one spelling");
  const result = checkProductGraph({ root: f.root });
  assert(!result.documents.list.some((item) => item.path === "정책.md"));
  assert(result.lists.formatIssues.some((item) => item.path === "정책.md" && item.kind.startsWith("유니코드 정규화만 다른")));
  assert.throws(() => approveProductGraphDocument({ root: f.root, document: "정책.md", expectedSha256: "0".repeat(64), rationale: "x" }), {
    code: "PRODUCT_GRAPH_NAME_TWIN",
  });
  assert.throws(() => f.route(() => exportProjectBundle({ root: f.root, destination: path.join(f.base, "bundle") })), { code: "PRODUCT_GRAPH_NAME_TWIN" });
});

test("S5: a family folder stored under its NFD name does not block snapshot GC; an approval record is a verified root", async (t) => {
  const f = productProject(t);
  const digest = checkProductGraph({ root: f.root }).documents.list.find((item) => item.path === "정책.md").approvalDigest;
  approveProductGraphDocument({ root: f.root, document: "정책.md", expectedSha256: digest, rationale: "ok" });
  const before = tree(f.family);
  let closure = await buildSnapshotDeletionClosure({ root: f.root });
  assert.deepEqual(
    closure.issues.filter((item) => item.path.normalize("NFC").includes("product-graph")),
    [],
  );
  assert(closure.entries.some((row) => /\/승인\/product-graph-approval-[a-f0-9]{24}\.json$/.test(row.path)));
  fs.renameSync(path.join(f.family, "화면설계서"), path.join(f.family, nfd("화면설계서")));
  if (fs.readdirSync(f.family).includes(nfd("화면설계서"))) {
    closure = await buildSnapshotDeletionClosure({ root: f.root });
    assert.deepEqual(
      closure.issues.filter((item) => item.path.normalize("NFC").includes("product-graph")),
      [],
    );
  }
  fs.renameSync(path.join(f.family, nfd("화면설계서")), path.join(f.family, "화면설계서"));
  assert.deepEqual(tree(f.family), before);
});

test("S6: stand-alone --out may not be the documents folder or the source root", (t) => {
  const base = temporary(t);
  const documents = path.join(base, "documents");
  fs.cpSync(signalDocuments, documents, { recursive: true });
  for (const out of [documents, path.join(documents, "out"), signalProduct])
    assert.throws(() => buildProductGraph({ sourceRoot: signalProduct, documentsDirectory: documents, rulesFile: emptyRules, outputDirectory: out }), {
      code: "PRODUCT_GRAPH_OUTPUT_OVERLAPS",
    });
});

test("S7: an oversized family file is refused from its size, before it is read", (t) => {
  const f = productProject(t);
  const big = path.join(f.family, "정책.md");
  fs.writeFileSync(big, "x".repeat(1024 * 1024 + 1));
  const read = fs.readFileSync;
  let readBig = false;
  t.mock.method(fs, "readFileSync", function (file, ...rest) {
    if (String(file) === big) readBig = true;
    return read.call(this, file, ...rest);
  });
  assert.throws(() => checkProductGraph({ root: f.root }), { code: "PRODUCT_GRAPH_FILE_TOO_LARGE" });
  assert.equal(readBig, false);
});

test("acceptance 13: export, import and adoption say what they carried for the family and name what they left out", (t) => {
  const f = fixture(t);
  fs.cpSync(signalProduct, f.root, { recursive: true });
  const family = path.join(f.root, ".lode", "context", "product-graph");
  fs.mkdirSync(path.join(family, "화면설계서"), { recursive: true });
  for (const name of ["MAIN-01.md", "DLG-01.md"]) fs.copyFileSync(path.join(signalDocuments, "화면설계서", name), path.join(family, "화면설계서", name));
  fs.writeFileSync(path.join(family, "메모.md"), "note\n");
  const digest = checkProductGraph({ root: f.root }).documents.list.find((item) => item.path === "화면설계서/MAIN-01.md").approvalDigest;
  approveProductGraphDocument({ root: f.root, document: "화면설계서/MAIN-01.md", expectedSha256: digest, rationale: "ok" });
  const expected = {
    documents: 2,
    approvalRecords: 1,
    otherUserFiles: [],
    notRecognised: [".lode/context/product-graph/메모.md"],
  };
  const pick = (summary) => ({
    documents: summary.documents,
    approvalRecords: summary.approvalRecords,
    otherUserFiles: summary.otherUserFiles,
    notRecognised: summary.notRecognised,
  });
  const exported = f.route(() => exportProjectBundle({ root: f.root, destination: path.join(f.base, "bundle") }));
  assert.deepEqual(pick(exported.productGraph), expected);
  assert.equal(exported.productGraph.buildOutput, "not-carried-rebuilt-by-product-graph-build");
  const manifest = JSON.parse(fs.readFileSync(path.join(exported.bundleRoot, "manifest.json"), "utf8"));
  assert(!Object.hasOwn(manifest, "productGraph"));
  const target = path.join(f.base, "imported");
  fs.mkdirSync(target);
  const imported = importProjectBundle({ bundleRoot: exported.bundleRoot, root: target, pluginRoot });
  assert.deepEqual(pick(imported.productGraph), { ...expected, notRecognised: [] });
  assert.equal(imported.productGraph.placement, "written-to-the-new-project-store");
  // A differing existing file is named in the refusal.
  const clash = path.join(f.base, "clash");
  fs.mkdirSync(path.join(clash, ".lode", "context", "product-graph", "화면설계서"), { recursive: true });
  fs.writeFileSync(path.join(clash, ".lode", "context", "product-graph", "화면설계서", "MAIN-01.md"), "different\n");
  assert.throws(
    () => importProjectBundle({ bundleRoot: exported.bundleRoot, root: clash, pluginRoot }),
    (error) => error.code === "PROJECT_COPY_SOURCE_CHANGED" && error.message.includes(".lode/context/product-graph/화면설계서/MAIN-01.md"),
  );
  assert.equal(fs.readFileSync(path.join(clash, ".lode", "context", "product-graph", "화면설계서", "MAIN-01.md"), "utf8"), "different\n");
  const copy = path.join(f.base, "copy");
  fs.cpSync(f.root, copy, { recursive: true });
  const file = path.join(copy, ".lode/project.json");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), projectRoot: "C:/unverified-origin/synthetic-project" }, null, 2) + "\n");
  const manifestFile = path.join(copy, ".lode/generated/manifest.json"),
    generated = JSON.parse(fs.readFileSync(manifestFile));
  generated.managed.find((entry) => entry.path === ".lode/project.json").sha256 = sha(fs.readFileSync(file));
  fs.writeFileSync(manifestFile, JSON.stringify(generated, null, 2) + "\n");
  const adopted = adoptVerifiedProjectCopy({ root: copy, pluginRoot });
  assert.deepEqual(pick(adopted.productGraph), expected);
  assert.equal(adopted.productGraph.notRecognisedHandling, "left-in-place-not-verified");
});

test("acceptance 16: a document changed after approval is shown apart, not used, and approved again once restored", (t) => {
  const f = productProject(t);
  const policy = path.join(f.family, "정책.md");
  const original = fs.readFileSync(policy);
  const status = () => checkProductGraph({ root: f.root }).documents.list.find((item) => item.path === "정책.md").status;
  const digest = checkProductGraph({ root: f.root }).documents.list.find((item) => item.path === "정책.md").approvalDigest;
  approveProductGraphDocument({ root: f.root, document: "정책.md", expectedSha256: digest, rationale: "ok" });
  assert.equal(status(), "승인");
  fs.writeFileSync(policy, original.toString("utf8").replace("저장 버튼을 막는다", "저장 버튼을 숨긴다"));
  const changed = checkProductGraph({ root: f.root });
  assert.equal(changed.documents.list.find((item) => item.path === "정책.md").status, "승인 뒤 바뀜");
  assert.deepEqual([changed.documents.approved, changed.documents.changedAfterApproval, changed.documents.estimated], [0, 1, 3]);
  assert.equal(changed.documents.list.find((item) => item.path === "정책.md").estimateKind, "코드만 보고 쓴 추정");
  assert.match(check(changed, "screen-policy-differs").reason, /승인된 정책 파일이 없다/);
  assert.match(changed.text, /- 문서: 승인 0, 승인 뒤 바뀜 1, 추정 3\./);
  assert.match(changed.text, /정책\.md — 승인 뒤 바뀜 \(코드만 보고 쓴 추정\)/);
  fs.writeFileSync(policy, original);
  assert.equal(status(), "승인");
});

test("acceptance 18: an approval binds to the normalised text: line endings, BOM and NFD keep it; a trailing space or a letter does not", async (t) => {
  const f = productProject(t);
  const relative = "화면설계서/MAIN-01.md";
  const file = path.join(f.family, ...relative.split("/"));
  const text = fs.readFileSync(file, "utf8");
  const listed = () => checkProductGraph({ root: f.root }).documents.list.find((item) => item.path === relative);
  const printed = listed().approvalDigest;
  const { productGraphApprovalDigest, PRODUCT_GRAPH_APPROVAL_DIGEST_BASIS } = await import("../scripts/lib/storage/product-graph-store.mjs");
  assert.equal(printed, productGraphApprovalDigest(fs.readFileSync(file)));
  const recorded = approveProductGraphDocument({ root: f.root, document: relative, expectedSha256: printed, rationale: "ok" });
  assert.equal(recorded.digestBasis, PRODUCT_GRAPH_APPROVAL_DIGEST_BASIS);
  const record = JSON.parse(fs.readFileSync(path.join(f.family, "승인", fs.readdirSync(path.join(f.family, "승인"))[0]), "utf8"));
  assert.equal(record.digestBasis, PRODUCT_GRAPH_APPROVAL_DIGEST_BASIS);
  assert.equal(record.documentTextSha256, printed);
  const crlf = text.replace(/\n/g, "\r\n");
  for (const variant of [crlf, "﻿" + text, text.normalize("NFD"), "﻿" + crlf.normalize("NFD")]) {
    fs.writeFileSync(file, variant);
    assert.equal(listed().status, "승인");
  }
  for (const variant of [text + " ", text.replace("저장 버튼", "저장 단추"), "﻿﻿" + text]) {
    fs.writeFileSync(file, variant);
    assert.equal(listed().status, "승인 뒤 바뀜");
  }
  // A digest of the raw CRLF bytes is not the approval digest: refused as stale.
  fs.writeFileSync(file, crlf);
  assert.throws(() => approveProductGraphDocument({ root: f.root, document: relative, expectedSha256: sha(Buffer.from(crlf, "utf8")), rationale: "x" }), {
    code: "PRODUCT_GRAPH_APPROVAL_STALE",
  });
  assert.equal(approveProductGraphDocument({ root: f.root, document: relative, expectedSha256: listed().approvalDigest, rationale: "ok" }).status, "existing");
});

test("acceptance 17: the usage doc says what an approval record is, in both languages", () => {
  const en = fs.readFileSync(path.join(pluginRoot, "docs", "product-graph-usage.md"), "utf8");
  const ko = fs.readFileSync(path.join(pluginRoot, "docs", "ko", "product-graph-usage.md"), "utf8");
  assert.match(en, /not a security boundary/);
  assert.match(en, /version-control history of the `승인\/` folder/);
  assert.match(ko, /보안 경계가 아닙니다/);
  assert.match(ko, /`승인\/` 폴더의 버전 관리 이력/);
});

// ---------- review of ea56fd1: A, B, G, H ----------

test("A: a regex after a keyword, an unrecognised regex and JSX text with a backtick do not hide later wiring", (t) => {
  const tick = String.fromCharCode(96);
  const wiring = 'el.addEventListener("click", save);';
  const cases = {
    "after-return.js": `document.getElementById("x");\nfunction f(s) { return /${tick}/.test(s); }\n${wiring}\nconst later = ${tick}x${tick};\nfunction save() {}\n`,
    "after-condition.js": `document.getElementById("x");\nif (ok) /${tick}/.test(s);\n${wiring}\nfunction save() {}\n`,
    "after-typeof.js": `document.getElementById("x");\nconst k = typeof /${tick}/;\n${wiring}\nfunction save() {}\n`,
    "jsx-text.jsx": `document.getElementById("x");\nconst v = <p>Use ${tick} to quote</p>;\n${wiring}\nfunction save() {}\n`,
  };
  const { result, graph } = scratchProduct(t, cases).build();
  const ids = graph.nodes.filter((node) => node.type === "기능").map((node) => node.id);
  for (const name of Object.keys(cases)) {
    const stem = name.replace(/\.[^.]+$/, "");
    assert(ids.includes(`fe/${stem}/${stem}@click:save`), `${name}: ${ids.join(", ")}`);
  }
  // The keyword cases are read exactly; the other two trip the guard and are named.
  assert.deepEqual(result.limits.lineLocalFallback.files, ["after-condition.js", "jsx-text.jsx"]);
  assert.equal(result.limits.lineLocalFallback.count, 2);
  const block = result.text.split("\n\n")[0];
  assert.match(block, /코드만 판정을 줄 단위로 되돌린 파일 2개: after-condition\.js, jsx-text\.jsx/);
});

test("B: the check text prints the approval digest of every document that is not 승인, and approve accepts it", (t) => {
  const f = productProject(t);
  const text = checkProductGraph({ root: f.root }).text;
  const line = text.split("\n").find((item) => item.includes("화면설계서/MAIN-01.md — 추정"));
  const printed = /승인할 digest ([a-f0-9]{64})/.exec(line)?.[1];
  assert(printed, line);
  assert.equal(approveProductGraphDocument({ root: f.root, document: "화면설계서/MAIN-01.md", expectedSha256: printed, rationale: "ok" }).status, "recorded");
  const after = checkProductGraph({ root: f.root })
    .text.split("\n")
    .find((item) => item.includes("화면설계서/MAIN-01.md — "));
  assert(!after.includes("승인할 digest"), after);
});

test("G: a regular file where the build folder should be is refused with a product graph reason", (t) => {
  const f = productProject(t);
  fs.writeFileSync(path.join(f.family, "build"), "not a folder\n");
  assert.throws(() => buildProductGraph({ root: f.root }), { code: "PRODUCT_GRAPH_OUTPUT_NOT_DIRECTORY" });
});

// Every new read under build/ meets a regular file in place of the folder with
// a product graph answer, whatever error code the platform gives for a path
// under a file (ENOTDIR on POSIX, ENOENT on Windows).
test("G (bundle 2): check, query, export and the baseline move meet a regular file in place of build/ with a product graph answer", async (t) => {
  const f = productProject(t);
  const build = path.join(f.family, "build");
  fs.writeFileSync(build, "not a folder\n");
  const before = fs.readFileSync(build);
  assert.match(checkProductGraph({ root: f.root }).changes.reason, /출력 폴더 자리에 폴더가 아닌 것이 있어/);
  const answer = queryProductGraph({ root: f.root });
  assert.equal(answer.code, "PRODUCT_GRAPH_OUTPUT_NOT_DIRECTORY");
  assert.match(answer.text, /빌드 폴더 자리에 폴더가 아닌 것이 있다/);
  assert.throws(() => moveProductGraphBaseline({ root: f.root }), { code: "PRODUCT_GRAPH_OUTPUT_NOT_DIRECTORY" });
  const snapshot = await buildGraphExplorerSnapshot({ root: f.root });
  assert.equal(snapshot.productGraph.status, "unreadable");
  assert.match(snapshot.productGraph.reason, /빌드 폴더 자리에 폴더가 아닌 것이 있다/);
  assert.deepEqual(fs.readFileSync(build), before, "nothing wrote over the file");
});

test("H: the preservation closure names a link in the family as a link", async (t) => {
  const f = productProject(t);
  const outside = path.join(f.base, "outside-notes");
  fs.mkdirSync(outside);
  if (!link(t, outside, path.join(f.family, "메모"))) return t.skip("cannot create a directory link here");
  const preservation = await inspectSnapshotPreservationClosure({ root: f.root });
  assert.deepEqual(preservation.productGraphKept, [{ path: ".lode/context/product-graph/메모", kind: "link" }]);
});

// ---------- T1: 표 항목의 처리 코드 ----------

test("acceptance 20: each table row names its own 처리 코드, never the table's file", (t) => {
  const { result, graph, handler } = family(t, path.join(fixtures, "table"), path.join(fixtures, "table-rules.json"));
  const expected = {
    "cli:save": ["files.mjs#saveFile"],
    "cli:inline": ["commands.mjs#localHelper"],
    "cli:lazy": ["lazy.mjs#runLazy"],
    "cli:deploy": ["commands.mjs#buildProject"],
    "cli:compile": ["handlers.py#run_build"],
    "cli:clean": ["handlers.py#run_clean"],
    "cli:broken": [],
    // A statement row never crosses a function, class or block body.
    "cli:open": ["wiring.mjs#openDoc"],
    "cli:close": ["wiring.mjs#closeDoc"],
    "cli:print": ["wiring.mjs#printDoc"],
    // A decorator is read from the match's line, whether the pattern starts
    // with "@" or after it; blank lines and other decorators are skipped.
    "cli:greet": ["decorated.py#greet"],
    "cli:leave": ["decorated.py#leave"],
    "cli:wave": ["decorated_after.py#wave"],
    // A JS/TS class method is a declaration (call precision 마), so a decorated
    // method is the 처리 코드 of its row.
    "cli:hide": ["decorated.ts#Commands.hide"],
    // Partly resolved: the name that resolved stays the 처리 코드.
    "cli:plugin": ["wiring.mjs#pluginPath"],
    // A template's ${...} is balanced for row bracket counting: a template
    // before the match, inside the matched row, and a nested template before a
    // statement-form registration.
    "tool:save": ["template-handlers.mjs#saveFile"],
    "tool:load": ["template-handlers.mjs#loadFile"],
    "tool:print": ["template-handlers.mjs#printFile"],
    "tool:last": ["template-handlers.mjs#saveFile"],
    "cli:tail": ["templates.mjs#afterBanner"],
    // The registering call itself is not a handler, even when the registrar
    // is product code; its arguments are.
    "cli:sync": ["registered.mjs#syncNow"],
    "cli:push": ["registered.mjs#pushAll"],
  };
  for (const [id, handlers] of Object.entries(expected)) assert.deepEqual(handler(id), handlers, id);
  for (const node of graph.nodes.filter((item) => item.type === "기능")) assert(!handler(node.id).includes("commands.mjs"), node.id);
  assert.deepEqual(
    result.lists.unresolvedHandlers.map((item) => [item.id, item.reason]),
    [["cli:broken", "항목의 동적 import가 경로를 글자로 쓰지 않았거나 같은 식에서 이름을 꺼내지 않음"]],
  );
  assert.deepEqual(result.lists.partlyResolvedRows, [
    {
      id: "cli:plugin",
      position: { path: "wiring.mjs", line: 24 },
      reason: "일부만 풀림: 항목의 동적 import가 경로를 글자로 쓰지 않았거나 같은 식에서 이름을 꺼내지 않음",
    },
  ]);
  assert.match(result.text, /표 항목의 일부만 풀린 기능: 1개/);
  const unreached = result.lists.unreachedCode.files.flatMap((file) => file.declarations);
  assert(unreached.includes("commands.mjs#neverNamed"));
  assert(!unreached.includes("files.mjs#writeOut"), "called only by row (a)'s handler");
  assert.deepEqual(result.lists.multiRowFunctions, [
    {
      id: "cli:save",
      positions: [
        { path: "commands.mjs", line: 15 },
        { path: "commands.mjs", line: 19 },
      ],
    },
  ]);
  assert.match(result.text, /여러 표 항목에서 나온 기능: 1개/);
  assert.match(result.text.split("\n\n")[0], /처리 코드를 표 항목에서 찾는 규칙은/);
  // A literal dynamic import is a call to the member it names, everywhere.
  assert(graph.edges.some((edge) => edge.type === "call" && edge.to === "lazy.mjs#runLazy"));
  assert.equal(result.lists.unresolvedReferences.byReason.find((reason) => reason.reason === "dynamic-import").count, 2);
});

test("acceptance 21: on Lode itself no tool: or cli: 기능 of the registry has the registry file as 처리 코드", (t) => {
  const base = temporary(t);
  fs.mkdirSync(path.join(base, "documents"));
  const out = path.join(base, "out");
  const result = buildProductGraph({
    sourceRoot: pluginRoot,
    documentsDirectory: path.join(base, "documents"),
    rulesFile: path.join(fixtures, "lode-entry-rules.json"),
    outputDirectory: out,
  });
  const graph = JSON.parse(fs.readFileSync(path.join(out, "graph.json"), "utf8"));
  const registry = "scripts/lib/session/operation-registry.mjs";
  const unresolved = new Map(result.lists.unresolvedHandlers.map((item) => [item.id, item.reason]));
  const fromRegistry = graph.nodes.filter(
    (node) => node.type === "기능" && /^(tool|cli):/.test(node.id) && node.positions.some((position) => position.path === registry),
  );
  const registered = new Set([
    ...registryCatalog().map((tool) => `tool:${tool.name}`),
    ...OPERATIONS.filter((entry) => entry.cli)
      .flatMap((entry) => [entry.cli.command, ...(entry.cli.aliases ?? [])])
      .map((name) => `cli:${name}`),
  ]);
  assert.deepEqual(new Set(fromRegistry.map((node) => node.id)), registered);
  for (const node of fromRegistry) {
    const handlers = graph.edges.filter((edge) => edge.type === "기능→코드" && edge.from === node.id).map((edge) => edge.to);
    assert(!handlers.includes(registry), node.id);
    assert(handlers.length > 0 || unresolved.has(node.id), node.id);
  }
  assert.deepEqual(result.lists.multiRowFunctions, []);
});

test("acceptance 22: with table-row rules, two builds are byte-identical and no ID carries a line number", (t) => {
  const base = temporary(t);
  fs.mkdirSync(path.join(base, "documents"));
  const run = (name) =>
    buildProductGraph({
      sourceRoot: path.join(fixtures, "table"),
      documentsDirectory: path.join(base, "documents"),
      rulesFile: path.join(fixtures, "table-rules.json"),
      outputDirectory: path.join(base, name),
    });
  run("first");
  run("second");
  const first = filesUnder(path.join(base, "first"));
  // graph.json is byte-identical across folders; each folder's baseline has its own time.
  assert.deepEqual(filesUnder(path.join(base, "second")).get("graph.json"), first.get("graph.json"));
  run("first");
  for (const [name, bytes] of filesUnder(path.join(base, "first"))) assert.deepEqual(bytes, first.get(name), name);
  const graph = JSON.parse(first.get("graph.json").toString("utf8"));
  for (const node of graph.nodes) assert(!/@\d+$/.test(node.id), node.id);
});

// Review of #84: every build derives everything again. A same-length edit that
// only a cache would miss (static to public) leaves no edge a clean build lacks.
test("a static member made an instance member gives the graph a clean build gives: no stale call edge", (t) => {
  const base = temporary(t);
  const source = path.join(base, "source"),
    documents = path.join(base, "documents"),
    out = path.join(base, "out"),
    clean = path.join(base, "clean");
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(documents);
  fs.writeFileSync(path.join(source, "package.json"), '{"bin":{"tool":"a.ts"}}\n');
  fs.writeFileSync(path.join(source, "b.ts"), "export class C { static run() { return 1; } }\n");
  fs.writeFileSync(path.join(source, "a.ts"), 'import { C } from "./b";\nexport function useIt() { return C.run(); }\nuseIt();\n');
  const options = { sourceRoot: source, documentsDirectory: documents, rulesFile: emptyRules };
  buildProductGraph({ ...options, outputDirectory: out });
  const edge = (graph) => graph.edges.some((item) => item.type === "call" && item.from === "a.ts#useIt" && item.to === "b.ts#C.run");
  assert.equal(edge(JSON.parse(fs.readFileSync(path.join(out, "graph.json"), "utf8"))), true, "the static call resolves");
  // Same byte length: "static" and "public" are both six letters.
  fs.writeFileSync(path.join(source, "b.ts"), "export class C { public run() { return 1; } }\n");
  buildProductGraph({ ...options, outputDirectory: out });
  buildProductGraph({ ...options, outputDirectory: clean });
  const again = JSON.parse(fs.readFileSync(path.join(out, "graph.json"), "utf8")),
    fresh = JSON.parse(fs.readFileSync(path.join(clean, "graph.json"), "utf8"));
  assert.equal(edge(again), false, "no call edge to an instance method through the class");
  assert.deepEqual(again.edges, fresh.edges);
  assert.deepEqual(again.nodes, fresh.nodes);
});

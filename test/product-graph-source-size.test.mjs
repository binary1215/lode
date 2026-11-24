// Product graph 3: the file limit counts files Lode would read, data-like
// folders are left out only when the build would pass the limit, and a
// failure says why (synthetic trees, run with smaller numbers than a build's).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildProductGraph } from "../scripts/lib/world/product-graph.mjs";
import { SOURCE_LIMITS, withSourceLimits } from "../scripts/lib/world/product-graph-extraction.mjs";
import { queryProductGraph } from "../scripts/lib/world/product-graph-query.mjs";

const SMALL = { filesToRead: 40, dataFolderFiles: 50, entriesVisited: 2_000 };
const RULES_HEAD = { schemaVersion: 1, kind: "LodeProductGraphEntryRules" };

function tree(t, { code, dataFiles = 55, dataCode = 5, source = undefined }) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(process.env.HEAD_AGENT_TEST_TMP || os.tmpdir(), "lode-product-graph-size-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const write = (name, text) => {
    fs.mkdirSync(path.dirname(path.join(base, "source", name)), { recursive: true });
    fs.writeFileSync(path.join(base, "source", name), text);
  };
  for (let index = 0; index < code; index += 1) write(`src/m${index}.py`, `def f${index}():\n    return ${index}\n`);
  for (let index = 0; index < dataFiles; index += 1) write(`data/samples/s${index}.dat`, `${index}\n`);
  for (let index = 0; index < dataCode; index += 1) write(`data/tools/t${index}.py`, `def t${index}():\n    return ${index}\n`);
  fs.mkdirSync(path.join(base, "documents"));
  const rulesFile = path.join(base, "rules.json");
  fs.writeFileSync(rulesFile, JSON.stringify({ ...RULES_HEAD, rules: [], ...(source ? { source } : {}) }, null, 2));
  const out = path.join(base, "out");
  const build = () =>
    withSourceLimits(SMALL, () => buildProductGraph({ sourceRoot: path.join(base, "source"), documentsDirectory: path.join(base, "documents"), rulesFile, outputDirectory: out }));
  const graph = () => JSON.parse(fs.readFileSync(path.join(out, "graph.json"), "utf8"));
  return { build, graph, out };
}
const codeFiles = (graph) => graph.nodes.filter((node) => node.type === "코드" && node.kind === "file").map((node) => node.id);

test("the numbers a build uses", () => {
  assert.deepEqual({ ...SOURCE_LIMITS }, { filesToRead: 50_000, entriesVisited: 2_000_000, dataFolderFiles: 2_000, dataFolderShare: 0.1 });
});

test("over the limit, a data-like folder is left out and reported; the build goes on", (t) => {
  const p = tree(t, { code: 38 });
  const result = p.build();
  const graph = p.graph();
  assert.equal(codeFiles(graph).filter((id) => id.startsWith("data/")).length, 0);
  assert.equal(codeFiles(graph).filter((id) => id.startsWith("src/")).length, 38);
  assert.deepEqual(graph.inputs.leftOutFolders, ["data"]);
  const size = result.limits.sourceSize;
  assert.equal(size.filesToRead, 38);
  assert.deepEqual(size.leftOut, [{ path: "data", files: 60, toRead: 5, code: 5, share: 0.083 }]);
  assert.deepEqual(size.candidates, []);
  const check = JSON.parse(fs.readFileSync(path.join(p.out, "check.json"), "utf8"));
  assert.deepEqual(check.limits.sourceSize.leftOut, size.leftOut);
  assert.deepEqual(check.lists.sourceSize.leftOut, size.leftOut);
  const line = "읽지 않은 데이터 폴더 1개 — 읽을 파일이 한도를 넘어 자동으로 뺐다: data/ (파일 60, 읽었을 파일 5, 그중 코드 5, 8.3%). 그 안의 코드 파일 5개도 읽지 않음.";
  assert.ok(result.text.includes(line));
  assert.ok(fs.readFileSync(path.join(p.out, "check.txt"), "utf8").includes(line));
  assert.ok(queryProductGraph({ buildDirectory: p.out, question: "overview" }).text.includes(line));
  const gaps = queryProductGraph({ buildDirectory: p.out, question: "gaps" }).text;
  assert.ok(gaps.includes(line), gaps);
});

test("source.포함 brings the folder back, and the build then fails with the numbers", (t) => {
  const p = tree(t, { code: 38, source: { 포함: ["data"] } });
  assert.throws(p.build, (error) => {
    assert.equal(error.code, "PRODUCT_GRAPH_SOURCE_TOO_LARGE");
    assert.match(error.message, /^읽을 파일이 43개로 한도 40개\(판단\)를 넘는다\. 맨 위 폴더\(파일 \/ 읽을 파일\): src\/ 38 \/ 38, data\/ 60 \/ 5\. 읽지 않을 폴더는 호출 방식 표의 source\.제외에 적으면 빠진다\.$/);
    return true;
  });
  // 제외 wins over 포함 for the same path.
  const both = tree(t, { code: 38, source: { 제외: ["data"], 포함: ["data"] } });
  both.build();
  assert.equal(both.graph().inputs.leftOutFolders, undefined);
  assert.equal(codeFiles(both.graph()).filter((id) => id.startsWith("data/")).length, 0);
});

test("under the limit everything is read and the folder is only a candidate", (t) => {
  const p = tree(t, { code: 30 });
  const result = p.build();
  const graph = p.graph();
  assert.equal(codeFiles(graph).filter((id) => id.startsWith("data/")).length, 5);
  assert.equal(graph.inputs.leftOutFolders, undefined);
  assert.deepEqual(result.limits.sourceSize.leftOut, []);
  assert.deepEqual(
    result.limits.sourceSize.candidates.map((row) => row.path),
    ["data"],
  );
  assert.ok(result.text.includes("데이터 폴더로 보이는 곳 1개 (다 읽었다. 빼려면 source.제외): data/ (파일 60, 읽었을 파일 5, 그중 코드 5, 8.3%)"));
});

test("too many files to read and no data-like folder: the failure says so (4.6)", (t) => {
  const p = tree(t, { code: 45, dataFiles: 0, dataCode: 0 });
  assert.throws(p.build, (error) => {
    assert.equal(error.code, "PRODUCT_GRAPH_SOURCE_TOO_LARGE");
    assert.equal(error.message, "읽을 파일이 45개로 한도 40개(판단)를 넘는다. 맨 위 폴더(파일 / 읽을 파일): src/ 45 / 45. 읽지 않을 폴더는 호출 방식 표의 source.제외에 적으면 빠진다.");
    return true;
  });
});

test("the walk's safety stop ends a runaway tree with its own wording", (t) => {
  const p = tree(t, { code: 10, dataFiles: 3000, dataCode: 0 });
  assert.throws(p.build, (error) => {
    assert.equal(error.code, "PRODUCT_GRAPH_SOURCE_TOO_LARGE");
    assert.match(error.message, /^소스 루트 아래 항목이 너무 많아 2000개를 지나고 멈췄다\(안전 한도, 판단\)\. 멈출 때까지 지난 맨 위 폴더\(파일 수\): data\/ \d+\. /);
    return true;
  });
});

test("a table with source.포함 but no source.제외 is valid; an unknown key is refused", (t) => {
  tree(t, { code: 1, dataFiles: 0, dataCode: 0, source: { 포함: ["src"] } }).build();
  assert.throws(tree(t, { code: 1, dataFiles: 0, dataCode: 0, source: { 넣기: ["src"] } }).build, /source에 모르는 항목 넣기/);
});

// 4.8: the UI-binding stage keeps no file's text, mask or blanked copy after
// that file. 3,000 UI-candidate files of about 100 KB each build in a child
// process at Node's default heap with a peak RSS under 1.5 GB.
test("3,000 large UI-candidate files build within 1.5 GB of peak RSS", { timeout: 600_000 }, async (t) => {
  const { spawnSync } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const base = fs.realpathSync(fs.mkdtempSync(path.join(process.env.HEAD_AGENT_TEST_TMP || os.tmpdir(), "lode-product-graph-memory-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(path.join(base, "source", "ui"), { recursive: true });
  fs.mkdirSync(path.join(base, "source", "src"), { recursive: true });
  fs.mkdirSync(path.join(base, "documents"));
  fs.writeFileSync(path.join(base, "source", "src", "app.js"), "export function go() {\n  return 1;\n}\n");
  const filler = `<div class="row">${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(20)}</div>\n`.repeat(90);
  for (let index = 0; index < 3000; index += 1)
    fs.writeFileSync(path.join(base, "source", "ui", `p${index}.html`), `<html><body>\n<button id="b${index}" onclick="go()">Go</button>\n${filler}</body></html>\n`);
  assert.ok(fs.statSync(path.join(base, "source", "ui", "p0.html")).size >= 100_000);
  fs.writeFileSync(path.join(base, "rules.json"), JSON.stringify({ ...RULES_HEAD, rules: [] }));
  const moduleUrl = pathToFileURL(path.resolve("scripts/lib/world/product-graph.mjs")).href;
  const script = `
    const { buildProductGraph } = await import(${JSON.stringify(moduleUrl)});
    const base = ${JSON.stringify(base)};
    buildProductGraph({ sourceRoot: base + "/source", documentsDirectory: base + "/documents", rulesFile: base + "/rules.json", outputDirectory: base + "/out" });
    console.log(JSON.stringify({ maxRssMB: Math.round(process.resourceUsage().maxRSS / 1024) }));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", maxBuffer: 1 << 24 });
  assert.equal(child.status, 0, child.stderr);
  const measured = JSON.parse(child.stdout.trim().split("\n").pop());
  const graph = JSON.parse(fs.readFileSync(path.join(base, "out", "graph.json"), "utf8"));
  assert.equal(graph.nodes.filter((node) => node.type === "기능").length, 3000);
  assert.ok(measured.maxRssMB < 1536, `peak RSS ${measured.maxRssMB} MB`);
});

// 4.7: a folder read by the baseline and left out now (or the reverse) is
// named on its own line; its nodes are not 신규 or 사라짐.
test("the comparison names a folder the reading range left out or took back", (t) => {
  const p = tree(t, { code: 30 });
  p.build();
  const base = path.dirname(p.out);
  for (let index = 30; index < 38; index += 1) fs.writeFileSync(path.join(base, "source", "src", `m${index}.py`), `def f${index}():\n    return ${index}\n`);
  const narrower = p.build();
  assert.deepEqual(narrower.changes.readRange.leftOut, ["data"]);
  assert.deepEqual(narrower.changes.readRange.readAgain, []);
  assert.equal(narrower.changes.readRange.removed.length, 10);
  assert.ok(narrower.changes.readRange.removed.every((id) => id.startsWith("data/tools/")));
  assert.equal(narrower.changes.counts.removed, 0);
  assert.equal(narrower.changes.counts.added, 16);
  assert.match(narrower.text, /\n- 읽는 범위가 달라짐: data\/ 이번에 읽지 않음 — 그래서 사라진 노드 10개, 생긴 노드 0개, 닿는 범위가 달라진 기능 0개 \(신규·사라짐·닿는 코드가 바뀜에 넣지 않는다\)\n/);
  // Set the baseline here, then go back under the limit: the folder is read again.
  fs.rmSync(path.join(base, "out", "baseline.json"));
  p.build();
  for (let index = 30; index < 38; index += 1) fs.rmSync(path.join(base, "source", "src", `m${index}.py`));
  const wider = p.build();
  assert.deepEqual(wider.changes.readRange.readAgain, ["data"]);
  assert.equal(wider.changes.readRange.added.length, 10);
  assert.equal(wider.changes.counts.added, 0);
  assert.equal(wider.changes.counts.removed, 16);
  assert.match(wider.text, /읽는 범위가 달라짐: data\/ 이번에 읽음 — 그래서 사라진 노드 0개, 생긴 노드 10개/);
});

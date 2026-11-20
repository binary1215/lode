// Confirmation records of the product graph (what a 뜻 line or a document row
// was checked against) and the readable status pages.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, pluginRoot } from "./helpers/session-work-linkage-fixture.mjs";
import {
  approveProductGraphDocument,
  buildProductGraph,
  checkProductGraph,
  confirmProductGraph,
  moveProductGraphBaseline,
  readProductGraphBuild,
} from "../scripts/lib/world/product-graph.mjs";
import { queryProductGraph } from "../scripts/lib/world/product-graph-query.mjs";
import {
  PRODUCT_GRAPH_CHECK_MAX_BYTES,
  PRODUCT_GRAPH_CHECK_MAX_ITEMS,
  PRODUCT_GRAPH_CHECK_MAX_RECORDS,
  PRODUCT_GRAPH_MAX_FILE_BYTES,
  productGraphCheckRecord,
  verifyProductGraphCheck,
} from "../scripts/lib/storage/product-graph-store.mjs";
import { exportProjectBundle, importProjectBundle, inspectProjectBundle } from "../scripts/lib/storage/project-portability.mjs";
import { adoptVerifiedProjectCopy } from "../scripts/lib/storage/project-copy-adoption.mjs";
import { buildSnapshotDeletionClosure } from "../scripts/lib/world/snapshot-deletion-closure.mjs";
import { GRAPH_EXPLORER_SCRIPTS, graphExplorerScript } from "../scripts/lib/world/graph-explorer-html.mjs";
import { explorerReading } from "../scripts/graph-explorer/reading.js";
import { dispatch } from "../scripts/mcp-server.mjs";
import { runCommand } from "../scripts/lode.mjs";

const fixtures = path.join(pluginRoot, "test", "fixtures", "product-graph");
const SAVE = "fe/station/ui/main_window/MainWindow@clicked:_save";
const MAIN = "화면설계서/MAIN-01.md";
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function project(t) {
  const f = fixture(t);
  fs.cpSync(path.join(fixtures, "ui-signal"), f.root, { recursive: true });
  const family = path.join(f.root, ".lode", "context", "product-graph");
  fs.cpSync(path.join(fixtures, "ui-signal-documents"), family, { recursive: true });
  return { ...f, family, checks: path.join(family, "확인"), window: path.join(f.root, "station", "ui", "main_window.py") };
}

// Every file of the Project outside build/ and the confirmation folder.
function outside(root) {
  const out = {};
  const visit = (relative) => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (/product-graph\/(build|확인)$/.test(child) || child.startsWith(".lode/runtime") || child.startsWith(".lode/locks")) continue;
      if (entry.isDirectory()) visit(child);
      else out[child] = sha(fs.readFileSync(path.join(root, child)));
    }
  };
  visit("");
  return out;
}

const editSave = (f) =>
  fs.writeFileSync(f.window, fs.readFileSync(f.window, "utf8").replace("    def _save(self):\n        self.model.refresh()", "    def _save(self):\n        self.model.refresh()\n        self.model.refresh()"));
const ids = (list) => list.map((item) => item.id || `${item.document}|${item.type}|${item.from}|${item.to}`);

test("acceptance 1, 2, 6: never checked survives a baseline move; a check holds until the code moves; only a new check clears it", (t) => {
  const f = project(t);
  let built = buildProductGraph({ root: f.root });
  assert(ids(built.confirmations.neverChecked).includes(SAVE));
  moveProductGraphBaseline({ root: f.root });
  built = buildProductGraph({ root: f.root });
  assert(ids(built.confirmations.neverChecked).includes(SAVE), "a baseline move does not clear a line nobody looked at");
  assert.match(built.text, /확인 기록 \(기준과 따로/);
  assert.match(built.text, new RegExp(`뜻 줄 기능 뜻\\.md:[0-9]+ 기능 ${SAVE.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} — 확인한 적 없음`));

  const files = outside(f.root);
  const confirmed = confirmProductGraph({ root: f.root, features: [SAVE], rationale: "Re-read MainWindow._save." });
  assert.equal(confirmed.status, "recorded");
  assert.equal(confirmed.by, "agent-checked");
  assert.equal(confirmed.authority, "agent-check-of-code-not-user-approval");
  assert.equal(confirmed.executionAuthority, false);
  assert.deepEqual(outside(f.root), files, "a confirm writes only its record");
  assert.deepEqual(
    fs.readdirSync(f.checks),
    confirmed.records.map((id) => `${id}.json`),
  );
  // The build still reads as fresh; the new record is named next to it.
  const read = readProductGraphBuild({ root: f.root });
  assert.equal(read.freshness.state, "fresh");
  assert.equal(read.freshness.confirmations.changed, true);

  built = buildProductGraph({ root: f.root });
  assert(!ids(built.confirmations.neverChecked).includes(SAVE));
  assert.equal(built.confirmations.counts.current, 1);
  const checkJson = fs.readFileSync(path.join(f.family, "build", "check.json"));
  const graphJson = fs.readFileSync(path.join(f.family, "build", "graph.json"));
  buildProductGraph({ root: f.root });
  assert.deepEqual(fs.readFileSync(path.join(f.family, "build", "check.json")), checkJson, "two builds of the same input are byte-identical");
  assert.deepEqual(fs.readFileSync(path.join(f.family, "build", "graph.json")), graphJson);
  assert.equal(readProductGraphBuild({ root: f.root }).freshness.confirmations.changed, false);

  editSave(f);
  assert.throws(() => confirmProductGraph({ root: f.root, features: [SAVE] }), { code: "PRODUCT_GRAPH_BUILD_STALE" });
  built = buildProductGraph({ root: f.root });
  const changed = built.confirmations.changedSinceCheck.find((item) => item.id === SAVE);
  assert.deepEqual(changed.nodes, [{ id: SAVE, change: "reachChanged" }]);
  assert.equal(changed.by, "agent-checked");
  assert.match(built.text, /확인 뒤 코드가 바뀜: .*닿는 코드가 바뀜\) — 에이전트 확인/);
  moveProductGraphBaseline({ root: f.root });
  built = buildProductGraph({ root: f.root });
  assert(ids(built.confirmations.changedSinceCheck).includes(SAVE), "still listed after the baseline moved");
  confirmProductGraph({ root: f.root, features: [SAVE] });
  built = buildProductGraph({ root: f.root });
  assert(!ids(built.confirmations.changedSinceCheck).includes(SAVE));
  assert.equal(built.confirmations.counts.current, 1);
});

test("acceptance 3: approval records the user's code basis for the document's rows; agent and user records stay apart", (t) => {
  const f = project(t);
  let built = buildProductGraph({ root: f.root });
  confirmProductGraph({ root: f.root, features: [SAVE] });
  const digest = built.documents.list.find((item) => item.path === MAIN).approvalDigest;
  const approved = approveProductGraphDocument({ root: f.root, document: MAIN, expectedSha256: digest, rationale: "User read the screen." });
  assert.equal(approved.status, "recorded");
  assert.equal(approved.codeBasis.status, "recorded");
  assert.equal(approved.codeBasis.rows, 5);
  assert.equal(approved.codeBasis.records.length, 1);
  const record = JSON.parse(fs.readFileSync(path.join(f.checks, `${approved.codeBasis.records[0]}.json`), "utf8"));
  assert.equal(record.by, "user-approved");
  assert.equal(record.authority, "explicit-user-product-graph-approval");
  assert(record.items.every((item) => item.kind === "documentRow" && item.document === MAIN));
  built = buildProductGraph({ root: f.root });
  assert.equal(built.confirmations.counts.current, 6);
  editSave(f);
  built = buildProductGraph({ root: f.root });
  const byWho = Object.fromEntries(built.confirmations.changedSinceCheck.map((item) => [item.kind === "meaning" ? item.id : `${item.type}|${item.from}`, item.by]));
  assert.equal(byWho[SAVE], "agent-checked");
  assert.equal(byWho[`화면요소→기능|MAIN-01#1`], "user-approved");
  assert.match(built.text, /에이전트 확인/);
  assert.match(built.text, /사용자 승인/);
  // A stale build approves the text and says the code basis was not recorded.
  const dialog = built.documents.list.find((item) => item.path === "화면설계서/DLG-01.md").approvalDigest;
  fs.appendFileSync(f.window, "\n# later\n");
  const stale = approveProductGraphDocument({ root: f.root, document: "화면설계서/DLG-01.md", expectedSha256: dialog, rationale: "User read it." });
  assert.equal(stale.status, "recorded");
  assert.equal(stale.approved, true);
  assert.equal(stale.codeBasis.status, "not-recorded");
  assert.equal(stale.codeBasis.code, "PRODUCT_GRAPH_BUILD_STALE");
});

test("acceptance 4, 5: a tampered or foreign record is an issue and excuses nothing; another reader is listed to look at again", (t) => {
  const f = project(t);
  let built = buildProductGraph({ root: f.root });
  const confirmed = confirmProductGraph({ root: f.root, features: [SAVE] });
  const checkId = confirmed.records[0];
  const file = path.join(f.checks, `${checkId}.json`);
  const original = fs.readFileSync(file, "utf8");
  const record = JSON.parse(original);
  // Another reader: a valid record of this Project read another way.
  const reader = { ...record.reader, graphVersion: "older-reader" };
  const other = productGraphCheckRecord({ projectId: record.projectId, by: "agent-checked", checkedAt: "2099-01-01T00:00:00.000Z", rationale: null, reader, items: record.items });
  fs.writeFileSync(path.join(f.checks, `${other.checkId}.json`), JSON.stringify(other, null, 2) + "\n");
  built = buildProductGraph({ root: f.root });
  assert.deepEqual(ids(built.confirmations.otherReader), [SAVE]);
  assert.match(built.text, /다른 방식으로 읽은 때 확인함/);
  fs.rmSync(path.join(f.checks, `${other.checkId}.json`));
  // Tampered: the basis no longer matches the content address.
  const tampered = JSON.parse(original);
  tampered.items[0].basis[0].contentSha256 = "0".repeat(64);
  fs.writeFileSync(file, JSON.stringify(tampered));
  built = buildProductGraph({ root: f.root });
  assert.deepEqual(built.confirmations.issues, [
    { path: `확인/${checkId}.json`, code: "PRODUCT_GRAPH_CHECK_INVALID", reason: "확인 기록의 모양이나 내용 주소가 맞지 않는다" },
  ]);
  assert(ids(built.confirmations.neverChecked).includes(SAVE), "a broken record excuses nothing");
  assert.match(built.text, /읽지 못한 확인 기록 \(아무것도 확인한 것으로 치지 않는다\): 1개/);
  // Foreign: a valid record of another Project.
  const foreign = productGraphCheckRecord({ ...record, projectId: "another-project" });
  fs.writeFileSync(file, original);
  fs.writeFileSync(path.join(f.checks, `${foreign.checkId}.json`), JSON.stringify(foreign));
  built = buildProductGraph({ root: f.root });
  assert.deepEqual(
    built.confirmations.issues.map((issue) => issue.code),
    ["PRODUCT_GRAPH_CHECK_PROJECT_MISMATCH"],
  );
  assert.throws(() => verifyProductGraphCheck(foreign, { projectId: record.projectId }), { code: "PRODUCT_GRAPH_CHECK_PROJECT_MISMATCH" });
  assert.equal(built.confirmations.counts.current, 1, "the Project's own valid record still counts");
});

test("confirm refuses what is not there and never writes a partial record; stand-alone runs read no records", (t) => {
  const f = project(t);
  assert.throws(() => confirmProductGraph({ root: f.root, features: [SAVE] }), { code: "PRODUCT_GRAPH_NOT_BUILT" });
  buildProductGraph({ root: f.root });
  assert.throws(() => confirmProductGraph({ root: f.root }), { code: "PRODUCT_GRAPH_CHECK_TARGET_INVALID" });
  assert.throws(() => confirmProductGraph({ root: f.root, features: [SAVE, "cli:nothing-here"] }), { code: "PRODUCT_GRAPH_CHECK_TARGET_MISSING" });
  assert.throws(() => confirmProductGraph({ root: f.root, documents: ["정책.md"] }), { code: "PRODUCT_GRAPH_CHECK_TARGET_MISSING" });
  assert.equal(fs.existsSync(f.checks), false);
  // A document's rows, all at once.
  const rows = confirmProductGraph({ root: f.root, documents: [MAIN] });
  assert.equal(rows.documentRows, 5);
  assert.equal(rows.meanings, 0);
  // An approval after the build changes a document's status, not the code a record stores: confirm still works.
  const digest = checkProductGraph({ root: f.root }).documents.list.find((item) => item.path === "정책.md").approvalDigest;
  approveProductGraphDocument({ root: f.root, document: "정책.md", expectedSha256: digest, rationale: "ok" });
  assert.equal(confirmProductGraph({ root: f.root, features: [SAVE] }).status, "recorded");
  const standalone = checkProductGraph({
    sourceRoot: path.join(fixtures, "ui-signal"),
    documentsDirectory: path.join(fixtures, "ui-signal-documents"),
    rulesFile: path.join(fixtures, "empty-rules.json"),
  });
  assert.equal(standalone.confirmations.status, "not-read");
});

test("query, node lines, CLI and MCP show the same statuses", async (t) => {
  const f = project(t);
  buildProductGraph({ root: f.root });
  const never = queryProductGraph({ root: f.root, question: "changes", list: "neverChecked", limit: 50 });
  assert.match(never.title, /확인 기록 — 확인한 적 없음 9개/);
  assert(never.rows.some((row) => row.id === SAVE));
  const overview = queryProductGraph({ root: f.root, question: "changes" });
  assert(overview.rows.some((row) => /확인할 수 있는 뜻 줄·문서 줄 9개/.test(row.text)));
  // A line nobody checked carries no mark; it is listed in the confirmation block only.
  assert.doesNotMatch(queryProductGraph({ root: f.root, question: "node", id: SAVE }).text, /\{뜻:/);
  const unknown = queryProductGraph({ root: f.root, question: "changes", list: "nope" });
  assert.match(unknown.message, /neverChecked/);
  const input = path.join(f.base, "confirm.json");
  fs.writeFileSync(input, JSON.stringify({ features: [SAVE], rationale: "Re-read." }));
  await runCommand(["product-graph-confirm", f.root, "--input", input]);
  assert.equal(fs.readdirSync(f.checks).length, 1);
  const reply = await dispatch({
    jsonrpc: "2.0",
    id: "confirm",
    method: "tools/call",
    params: { name: "lode_tools_call", arguments: { name: "lode_product_graph_confirm", arguments: { project_root: f.root, documents: [MAIN] } } },
  });
  assert(!reply.error && !reply.result?.isError, JSON.stringify(reply));
  assert.equal(fs.readdirSync(f.checks).length, 2);
  buildProductGraph({ root: f.root });
  assert.doesNotMatch(queryProductGraph({ root: f.root, question: "node", id: SAVE }).text, /\{뜻:/);
});

test("acceptance 7: export, import, folder-copy adoption and GC carry or keep the records like approvals", async (t) => {
  const f = project(t);
  buildProductGraph({ root: f.root });
  const confirmed = confirmProductGraph({ root: f.root, features: [SAVE] });
  const name = `.lode/context/product-graph/확인/${confirmed.records[0]}.json`;
  const bundle = f.route(() => exportProjectBundle({ root: f.root, destination: path.join(f.base, "bundle") }));
  const files = inspectProjectBundle({ bundleRoot: bundle.bundleRoot }).manifest.files.map((file) => file.path);
  assert(files.includes(name));
  const target = path.join(f.base, "imported");
  fs.mkdirSync(target);
  assert.equal(importProjectBundle({ bundleRoot: bundle.bundleRoot, root: target, pluginRoot }).status, "imported");
  assert.deepEqual(fs.readFileSync(path.join(target, name)), fs.readFileSync(path.join(f.root, name)));

  const closure = await buildSnapshotDeletionClosure({ root: f.root });
  assert.deepEqual(
    closure.issues.filter((item) => item.path.includes("product-graph")),
    [],
  );
  assert(closure.entries.some((row) => row.path === name));

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
  assert.equal(adoptVerifiedProjectCopy({ root: copy, pluginRoot }).status, "verified-copy-adopted");
  assert.deepEqual(fs.readFileSync(path.join(copy, name)), fs.readFileSync(path.join(f.root, name)));
  const broken = path.join(f.base, "broken");
  fs.cpSync(f.root, broken, { recursive: true });
  unverified(broken);
  fs.writeFileSync(path.join(broken, name), fs.readFileSync(path.join(broken, name), "utf8").replace('"agent-checked"', '"user-approved"'));
  assert.throws(() => adoptVerifiedProjectCopy({ root: broken, pluginRoot }), { code: "PRODUCT_GRAPH_CHECK_INVALID" });
});

test("B1: authored text becomes headings, lists, code and paragraphs; inline Markdown stays literal", () => {
  const blocks = explorerReading.blocks("# Why\r\nWe kept **two** paths.\nStill one paragraph.\n\n- first\n  more of first\n- second\n1. one\n\n```\nconst a = `<b>`;\n```\n### Tail ###");
  assert.deepEqual(blocks, [
    { kind: "heading", level: 1, text: "Why" },
    { kind: "paragraph", text: "We kept **two** paths.\nStill one paragraph." },
    { kind: "list", ordered: false, items: ["first\nmore of first", "second"] },
    { kind: "list", ordered: true, items: ["1. one"] },
    { kind: "code", text: "const a = `<b>`;" },
    { kind: "heading", level: 3, text: "Tail" },
  ]);
  assert.deepEqual(explorerReading.blocks("```\nunclosed"), [{ kind: "code", text: "unclosed" }]);
  const many = explorerReading.blocks(Array.from({ length: 1000 }, (_, i) => `# h${i}`).join("\n"));
  assert.equal(many.length, explorerReading.MAX_BLOCKS);
  assert.match(many.at(-1).text, /# h999$/, "nothing is dropped past the bound");
});

test("B2: a source page has line numbers, 80 lines, the recorded span marked and opened", () => {
  const text = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\r\n") + "\r\n";
  const first = explorerReading.sourcePage(text);
  assert.deepEqual([first.total, first.pages, first.page, first.from, first.to, first.span], [200, 3, 0, 1, 80, null]);
  assert.deepEqual(first.lines[0], { number: 1, text: "line 1", inSpan: false });
  const spanned = explorerReading.sourcePage(text, { span: { startLine: 150, endLine: 152 } });
  assert.equal(spanned.page, 1);
  assert.deepEqual(
    spanned.lines.filter((line) => line.inSpan).map((line) => line.number),
    [150, 151, 152],
  );
  const last = explorerReading.sourcePage(text, { page: 9 });
  assert.deepEqual([last.page, last.from, last.to], [2, 161, 200]);
  assert.equal(explorerReading.sourcePage(text, { span: { startLine: 500, endLine: 501 } }).span, null);
  assert.deepEqual(explorerReading.sourcePage("").lines, [{ number: 1, text: "", inSpan: false }]);
});

test("B3: controls and bidi marks are shown escaped; the page bundles the reader and renders text only", () => {
  assert.equal(explorerReading.displayText("a\u202Eb\u2066c\u0007d\te\nf\u200F"), "a\\u202eb\\u2066c\\u0007d\te\nf\\u200f");
  // Line ends written on Windows stay line ends.
  assert.equal(explorerReading.displayText("one\r\ntwo\rthree"), "one\ntwo\nthree");
  const views = fs.readFileSync(path.join(pluginRoot, "scripts", "graph-explorer", "views.js"), "utf8");
  assert.match(views, /node\.textContent = explorerReading\.displayText\(options\.text\)/);
  assert(GRAPH_EXPLORER_SCRIPTS.indexOf("reading.js") >= 0 && GRAPH_EXPLORER_SCRIPTS.indexOf("reading.js") < GRAPH_EXPLORER_SCRIPTS.indexOf("views.js"));
  assert.match(graphExplorerScript(), /const explorerReading = /);
  const reading = fs.readFileSync(path.join(pluginRoot, "scripts", "graph-explorer", "reading.js"), "utf8");
  assert.doesNotMatch(reading, /\bfetch\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage|innerHTML|document\./);
  for (const key of ["reasonHeading", "recordedSpan", "noRecordedSpan", "sourceLines", "sourcePrevious", "sourceNext"])
    assert.match(fs.readFileSync(path.join(pluginRoot, "scripts", "graph-explorer", "i18n.js"), "utf8").split(key).length - 1 === 2 ? "ok" : "", /ok/, key);
});

test("records never stop a build or fail an approval: count and size bounds, a failed record write, two approvals in a row", (t) => {
  const f = project(t);
  let built = buildProductGraph({ root: f.root });
  const digest = (relative) => built.documents.list.find((item) => item.path === relative).approvalDigest;
  // Two approvals in a row: the second still records its code basis.
  const first = approveProductGraphDocument({ root: f.root, document: MAIN, expectedSha256: digest(MAIN), rationale: "ok" });
  const second = approveProductGraphDocument({ root: f.root, document: "화면설계서/DLG-01.md", expectedSha256: digest("화면설계서/DLG-01.md"), rationale: "ok" });
  assert.equal(first.codeBasis.status, "recorded");
  assert.equal(second.codeBasis.status, "recorded");
  // A record write that fails after the approval is written leaves the approval standing.
  const other = project(t);
  built = buildProductGraph({ root: other.root });
  fs.writeFileSync(other.checks, "not a folder\n");
  const approved = approveProductGraphDocument({
    root: other.root,
    document: MAIN,
    expectedSha256: built.documents.list.find((item) => item.path === MAIN).approvalDigest,
    rationale: "ok",
  });
  assert.equal(approved.status, "recorded");
  assert.equal(approved.codeBasis.status, "not-recorded");
  assert.equal(checkProductGraph({ root: other.root }).documents.approved, 1);
  // At the record limit confirm refuses and writes nothing; builds keep working.
  const records = fs.readdirSync(f.checks).length;
  const current = buildProductGraph({ root: f.root }).confirmations.counts.current;
  assert(current > 0);
  for (let index = records; index < PRODUCT_GRAPH_CHECK_MAX_RECORDS; index++)
    fs.writeFileSync(path.join(f.checks, `product-graph-check-${index.toString(16).padStart(24, "0")}.json`), "{}");
  buildProductGraph({ root: f.root });
  assert.throws(() => confirmProductGraph({ root: f.root, features: [SAVE] }), { code: "PRODUCT_GRAPH_CHECK_LIMIT" });
  assert.equal(fs.readdirSync(f.checks).length, PRODUCT_GRAPH_CHECK_MAX_RECORDS);
  built = buildProductGraph({ root: f.root });
  assert.equal(built.confirmations.issues.length, PRODUCT_GRAPH_CHECK_MAX_RECORDS - records);
  assert.equal(built.confirmations.counts.current, current, "broken files excuse nothing and take nothing away");
});

test("a record is closed: item count, ISO time, reader values, and a basis that names what the item describes", () => {
  const base = {
    projectId: "p",
    by: "agent-checked",
    checkedAt: "2026-11-18T00:00:00.000Z",
    rationale: null,
    reader: { generator: "lode-product-graph", graphVersion: 1, sourceAnalysis: 1 },
  };
  const hash = "a".repeat(64);
  const meaning = (id, basisId = id) => ({ kind: "meaning", id, textSha256: hash, basis: [{ id: basisId, contentSha256: hash }] });
  assert.ok(productGraphCheckRecord({ ...base, items: [meaning("F1")] }).checkId);
  assert.throws(() => productGraphCheckRecord({ ...base, items: [meaning("F1", "OTHER")] }), { code: "PRODUCT_GRAPH_CHECK_INVALID" });
  assert.throws(() => productGraphCheckRecord({ ...base, checkedAt: "2026", items: [meaning("F1")] }), { code: "PRODUCT_GRAPH_CHECK_INVALID" });
  assert.throws(() => productGraphCheckRecord({ ...base, reader: { ...base.reader, generator: { nested: true } }, items: [meaning("F1")] }), {
    code: "PRODUCT_GRAPH_CHECK_INVALID",
  });
  const many = Array.from({ length: PRODUCT_GRAPH_CHECK_MAX_ITEMS + 1 }, (_, index) => meaning(`F${index}`));
  assert.throws(() => productGraphCheckRecord({ ...base, items: many }), { code: "PRODUCT_GRAPH_CHECK_INVALID" });
  const row = (type, from, to, basisId) => ({
    kind: "documentRow",
    document: MAIN,
    type,
    from,
    to,
    documentTextSha256: hash,
    basis: [{ id: basisId, contentSha256: hash }],
  });
  assert.ok(productGraphCheckRecord({ ...base, items: [row("기능→화면요소", "F1", "E1", "F1")] }));
  assert.throws(() => productGraphCheckRecord({ ...base, items: [row("기능→화면요소", "F1", "E1", "E1")] }), { code: "PRODUCT_GRAPH_CHECK_INVALID" });
  // The largest record Lode may write stays well under the file limit a build reads.
  assert(PRODUCT_GRAPH_CHECK_MAX_BYTES < PRODUCT_GRAPH_MAX_FILE_BYTES);
});

// ---------- review fixes C1–C9 ----------

const writeRecord = (f, record) => {
  fs.mkdirSync(f.checks, { recursive: true });
  fs.writeFileSync(path.join(f.checks, `${record.checkId}.json`), JSON.stringify(record, null, 2) + "\n");
};
const nodeLine = (f, id) =>
  queryProductGraph({ root: f.root, question: "node", id })
    .text.split("\n")
    .find((line) => line.startsWith("기능 "));

test("C1: a source file stored with a decomposed name: confirm works and approve records the approval and its code basis", (t) => {
  const f = project(t);
  const decomposed = "창".normalize("NFD");
  const ui = path.join(f.root, "station", "ui");
  fs.renameSync(path.join(ui, "main_window.py"), path.join(ui, `${decomposed}.py`));
  const rename = (file) => fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("main_window", decomposed));
  for (const name of ["화면설계서/MAIN-01.md", "화면설계서/DLG-01.md", "기능 뜻.md", "정책.md", "유저플로우 기획서/UA-MAIN-01.md"]) rename(path.join(f.family, name));
  for (const name of ["station/app.py", "station/ui/__init__.py", "station/tools/calibrate_tk.py"]) rename(path.join(f.root, name));
  const built = buildProductGraph({ root: f.root });
  const save = JSON.parse(fs.readFileSync(path.join(f.family, "build", "graph.json"), "utf8")).nodes.find(
    (node) => node.type === "기능" && /@clicked:_save$/.test(node.id),
  ).id;
  assert.notEqual(save, save.normalize("NFC"), "the graph keeps the decomposed id");
  const confirmed = confirmProductGraph({ root: f.root, features: [save], documents: [MAIN] });
  assert.equal(confirmed.status, "recorded");
  const stored = JSON.parse(fs.readFileSync(path.join(f.checks, `${confirmed.records[0]}.json`), "utf8"));
  assert(stored.items.some((item) => item.kind === "meaning" && item.id === save), "stored exactly as the graph has it");
  const digest = built.documents.list.find((item) => item.path === "화면설계서/DLG-01.md").approvalDigest;
  const approved = approveProductGraphDocument({ root: f.root, document: "화면설계서/DLG-01.md", expectedSha256: digest, rationale: "User read it." });
  assert.equal(approved.status, "recorded");
  assert.equal(approved.codeBasis.status, "recorded");
  assert.equal(fs.readdirSync(path.join(f.family, "승인")).length, 1);
  const after = buildProductGraph({ root: f.root });
  assert.deepEqual(after.confirmations.issues, []);
  assert(!ids(after.confirmations.neverChecked).includes(save));
});

test("C1: nothing in the code-basis step can stop an approval", (t) => {
  const f = project(t);
  const built = buildProductGraph({ root: f.root });
  // A graph the confirmation step cannot read: the approval is still written as on main.
  const graphFile = path.join(f.family, "build", "graph.json");
  const graph = JSON.parse(fs.readFileSync(graphFile, "utf8"));
  graph.nodes.find((node) => node.id === SAVE).contentSha256 = 12;
  fs.writeFileSync(graphFile, JSON.stringify(graph));
  const digest = built.documents.list.find((item) => item.path === MAIN).approvalDigest;
  const approved = approveProductGraphDocument({ root: f.root, document: MAIN, expectedSha256: digest, rationale: "User read it." });
  assert.equal(approved.status, "recorded");
  assert.equal(approved.approved, true);
  assert.equal(approved.codeBasis.status, "not-recorded");
  assert.equal(fs.readdirSync(path.join(f.family, "승인")).length, 1);
});

test("C2: an oversized, unreadable or surplus record never stops a build, a check, the freshness read, an approval or a baseline move", (t) => {
  const f = project(t);
  buildProductGraph({ root: f.root });
  const good = confirmProductGraph({ root: f.root, features: [SAVE] }).records[0];
  fs.mkdirSync(path.join(f.checks), { recursive: true });
  // Past the 1 MiB file limit and past the record size bound.
  const huge = `product-graph-check-${"a".repeat(24)}.json`;
  fs.writeFileSync(path.join(f.checks, huge), Buffer.alloc(PRODUCT_GRAPH_MAX_FILE_BYTES + 1, 0x20));
  const large = `product-graph-check-${"b".repeat(24)}.json`;
  fs.writeFileSync(path.join(f.checks, large), Buffer.alloc(PRODUCT_GRAPH_CHECK_MAX_BYTES + 1, 0x20));
  // Past the record count: names that sort after the real record.
  for (let index = 0; index < PRODUCT_GRAPH_CHECK_MAX_RECORDS + 5; index++)
    fs.writeFileSync(path.join(f.checks, `product-graph-check-${"f".repeat(18)}${index.toString(16).padStart(6, "0")}.json`), "{}");
  const built = buildProductGraph({ root: f.root });
  assert.equal(built.confirmations.counts.current, 1, "the real record is read (file-name order)");
  const byCode = (code) => built.confirmations.issues.filter((issue) => issue.code === code).map((issue) => issue.path);
  assert(byCode("PRODUCT_GRAPH_CHECK_LIMIT").includes(`확인/${huge}`));
  assert(byCode("PRODUCT_GRAPH_CHECK_LIMIT").includes(`확인/${large}`));
  const records = [good, huge.slice(0, -5), large.slice(0, -5)].length;
  assert.equal(byCode("PRODUCT_GRAPH_CHECK_LIMIT").length, 2 + (PRODUCT_GRAPH_CHECK_MAX_RECORDS + 5 + records - PRODUCT_GRAPH_CHECK_MAX_RECORDS));
  assert.equal(built.confirmations.recordLimit.present, PRODUCT_GRAPH_CHECK_MAX_RECORDS + 5 + records);
  assert.match(built.text, /확인 기록 2008개 가운데 파일 이름 순으로 앞의 2000개만 읽었다/);
  assert.equal(checkProductGraph({ root: f.root }).confirmations.counts.current, 1);
  assert.equal(readProductGraphBuild({ root: f.root }).freshness.state, "fresh");
  assert.equal(queryProductGraph({ root: f.root, question: "changes" }).title, "기준과 비교");
  const digest = built.documents.list.find((item) => item.path === MAIN).approvalDigest;
  assert.equal(approveProductGraphDocument({ root: f.root, document: MAIN, expectedSha256: digest, rationale: "ok" }).status, "recorded");
  assert.equal(moveProductGraphBaseline({ root: f.root }).status !== undefined, true);
});

test("C3: a document of more than 500 rows is confirmed and approved with its code basis in several records", (t) => {
  const f = project(t);
  const main = path.join(f.family, MAIN);
  const rows = Array.from({ length: 501 }, (_, index) => `| MAIN-01#${index + 10} | 버튼 ${index} | \`station/ui/main_window.py:18\` | \`${SAVE}\` | |`).join("\n");
  fs.writeFileSync(main, fs.readFileSync(main, "utf8").replace("| MAIN-01#5 |", `${rows}\n| MAIN-01#5 |`));
  const built = buildProductGraph({ root: f.root });
  const confirmed = confirmProductGraph({ root: f.root, documents: [MAIN] });
  assert.equal(confirmed.status, "recorded");
  assert(confirmed.records.length >= 2);
  assert.equal(confirmed.recordsWritten, confirmed.records.length);
  assert.equal(confirmed.documentRows, 506);
  for (const id of confirmed.records)
    assert(JSON.parse(fs.readFileSync(path.join(f.checks, `${id}.json`), "utf8")).items.length <= PRODUCT_GRAPH_CHECK_MAX_ITEMS);
  const digest = built.documents.list.find((item) => item.path === MAIN).approvalDigest;
  const approved = approveProductGraphDocument({ root: f.root, document: MAIN, expectedSha256: digest, rationale: "ok" });
  assert.equal(approved.codeBasis.status, "recorded");
  assert.equal(approved.codeBasis.rows, 506);
  assert(approved.codeBasis.records.length >= 2);
  const after = buildProductGraph({ root: f.root });
  assert.equal(after.confirmations.counts.neverChecked, after.confirmations.counts.items - 506);
  // A refusal at the record limit writes nothing.
  const present = fs.readdirSync(f.checks).length;
  for (let index = present; index < PRODUCT_GRAPH_CHECK_MAX_RECORDS - 1; index++)
    fs.writeFileSync(path.join(f.checks, `product-graph-check-${index.toString(16).padStart(24, "0")}.json`), "{}");
  editSave(f);
  buildProductGraph({ root: f.root });
  assert.throws(() => confirmProductGraph({ root: f.root, documents: [MAIN] }), { code: "PRODUCT_GRAPH_CHECK_LIMIT" });
  assert.equal(fs.readdirSync(f.checks).length, PRODUCT_GRAPH_CHECK_MAX_RECORDS - 1);
});

test("C4: the record a confirm writes counts for its items whatever the clocks say", (t) => {
  const f = project(t);
  buildProductGraph({ root: f.root });
  const first = confirmProductGraph({ root: f.root, features: [SAVE] });
  const good = JSON.parse(fs.readFileSync(path.join(f.checks, `${first.records[0]}.json`), "utf8"));
  fs.rmSync(path.join(f.checks, `${first.records[0]}.json`));
  const stale = good.items.map((item) => ({ ...item, basis: item.basis.map((node) => ({ ...node, contentSha256: "0".repeat(64) })) }));
  const make = (checkedAt, items, extra = {}) =>
    productGraphCheckRecord({ projectId: good.projectId, by: "agent-checked", checkedAt, rationale: null, reader: good.reader, items, ...extra });
  // One time format: a time without milliseconds is not a record.
  assert.throws(() => make("2026-11-19T10:00:00Z", stale), { code: "PRODUCT_GRAPH_CHECK_INVALID" });
  // A stale record dated far ahead, then a real confirm now.
  writeRecord(f, make("2099-01-01T00:00:00.000Z", stale));
  let built = buildProductGraph({ root: f.root });
  assert(ids(built.confirmations.changedSinceCheck).includes(SAVE));
  const now = confirmProductGraph({ root: f.root, features: [SAVE] });
  assert.equal(now.status, "recorded");
  const written = JSON.parse(fs.readFileSync(path.join(f.checks, `${now.records[0]}.json`), "utf8"));
  assert.deepEqual(written.supersedes, [make("2099-01-01T00:00:00.000Z", stale).checkId]);
  assert.match(written.checkedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  built = buildProductGraph({ root: f.root });
  assert(!ids(built.confirmations.changedSinceCheck).includes(SAVE));
  assert.equal(built.confirmations.counts.current, 1);
  // Unrelated records (neither replaces the other): the later instant decides, not the string.
  for (const name of fs.readdirSync(f.checks)) fs.rmSync(path.join(f.checks, name));
  writeRecord(f, make("2026-11-19T10:00:00.000Z", stale));
  writeRecord(f, make("2026-11-19T10:00:00.500Z", good.items));
  built = buildProductGraph({ root: f.root });
  assert.equal(built.confirmations.counts.current, 1);
  // A record that replaces another wins even when it is dated earlier.
  for (const name of fs.readdirSync(f.checks)) fs.rmSync(path.join(f.checks, name));
  const later = make("2026-11-19T12:00:00.000Z", stale);
  writeRecord(f, later);
  writeRecord(f, make("2026-11-19T08:00:00.000Z", good.items, { supersedes: [later.checkId] }));
  built = buildProductGraph({ root: f.root });
  assert.equal(built.confirmations.counts.current, 1);
});

test("C5: of two 뜻 rows for one 기능 the checked one is the row the graph shows (the last)", (t) => {
  const f = project(t);
  const meaning = path.join(f.family, "기능 뜻.md");
  fs.appendFileSync(meaning, `| ${SAVE} | 둘째 줄의 뜻 |\n`);
  buildProductGraph({ root: f.root });
  assert.match(nodeLine(f, SAVE), /둘째 줄의 뜻/);
  confirmProductGraph({ root: f.root, features: [SAVE] });
  // Editing the first (hidden) row changes nothing that was checked.
  fs.writeFileSync(meaning, fs.readFileSync(meaning, "utf8").replace("지금 상태를 저장한다", "지금 상태를 파일로 저장한다"));
  let built = buildProductGraph({ root: f.root });
  assert.equal(built.confirmations.counts.textChanged, 0);
  // Editing the shown row is a changed text.
  fs.writeFileSync(meaning, fs.readFileSync(meaning, "utf8").replace("둘째 줄의 뜻", "전혀 다른 뜻으로 고침"));
  built = buildProductGraph({ root: f.root });
  assert.deepEqual(ids(built.confirmations.textChanged), [SAVE]);
});

test("C6: authored text keeps a heading's own #, the numbers written, line breaks, and a bound of exactly 400 blocks", () => {
  assert.deepEqual(explorerReading.blocks("# Why C#\nbody"), [
    { kind: "heading", level: 1, text: "Why C#" },
    { kind: "paragraph", text: "body" },
  ]);
  assert.deepEqual(explorerReading.blocks("## Tail ##")[0].text, "Tail");
  assert.deepEqual(explorerReading.blocks("#hashtag")[0], { kind: "paragraph", text: "#hashtag" });
  assert.deepEqual(explorerReading.blocks("결정 경위\n2026. 11. 17. 사용자가 정했다")[1], { kind: "list", ordered: true, items: ["2026. 11. 17. 사용자가 정했다"] });
  assert.deepEqual(explorerReading.blocks("3. third\n4) fourth")[0].items, ["3. third", "4) fourth"]);
  assert.deepEqual(explorerReading.blocks("one\r\ntwo\n\n- a\r\n  b")[0], { kind: "paragraph", text: "one\ntwo" });
  assert.deepEqual(explorerReading.blocks("one\r\ntwo\n\n- a\r\n  b")[1].items, ["a\nb"]);
  // A fence closes only with the same character, at least as long.
  assert.deepEqual(explorerReading.blocks("~~~\ncode\n```\n~~~\nafter")[0], { kind: "code", text: "code\n```" });
  for (const count of [399, 400, 401, 402]) {
    const many = explorerReading.blocks(Array.from({ length: count }, (_, i) => `# h${i}`).join("\n") + "\npara\n- item");
    assert(many.length <= explorerReading.MAX_BLOCKS, `${count}: ${many.length}`);
    assert.match(many.at(-1).text, /item$/, "nothing is dropped");
  }
  // Linear: long headings with many inner spaces or ' #' pairs take no time.
  for (const line of [`# a${" ".repeat(20000)}b`, `# a${" #".repeat(20000)}b`, `#${" ".repeat(20000)}`]) {
    const started = process.hrtime.bigint();
    explorerReading.blocks(line);
    assert(Number(process.hrtime.bigint() - started) / 1e6 < 200, "under 200 ms");
  }
});

test("C7: freshness notices a record changed in place; repeating an approval or a confirm with nothing changed writes nothing", (t) => {
  const f = project(t);
  let built = buildProductGraph({ root: f.root });
  const confirmed = confirmProductGraph({ root: f.root, features: [SAVE] });
  buildProductGraph({ root: f.root });
  assert.equal(readProductGraphBuild({ root: f.root }).freshness.confirmations.changed, false);
  fs.writeFileSync(path.join(f.checks, `${confirmed.records[0]}.json`), "{}");
  assert.equal(readProductGraphBuild({ root: f.root }).freshness.confirmations.changed, true);
  fs.rmSync(f.checks, { recursive: true });
  built = buildProductGraph({ root: f.root });
  confirmProductGraph({ root: f.root, features: [SAVE] });
  const again = confirmProductGraph({ root: f.root, features: [SAVE] });
  assert.equal(again.status, "unchanged");
  assert.equal(again.recordsWritten, 0);
  assert.equal(again.itemsAlreadyCurrent, 1);
  const digest = built.documents.list.find((item) => item.path === MAIN).approvalDigest;
  const first = approveProductGraphDocument({ root: f.root, document: MAIN, expectedSha256: digest, rationale: "ok" });
  assert.equal(first.codeBasis.status, "recorded");
  const records = fs.readdirSync(f.checks).length;
  const second = approveProductGraphDocument({ root: f.root, document: MAIN, expectedSha256: digest, rationale: "ok" });
  assert.equal(second.codeBasis.status, "unchanged");
  assert.equal(second.codeBasis.rowsAlreadyCurrent, 5);
  assert.equal(fs.readdirSync(f.checks).length, records);
  // An agent check of the same rows is another kind: it is recorded.
  assert.equal(confirmProductGraph({ root: f.root, documents: [MAIN] }).status, "recorded");
});

test("C9: the 뜻 mark appears only when a check no longer holds; with no record the walk answers are those without confirmations", (t) => {
  const f = project(t);
  buildProductGraph({ root: f.root });
  const questions = [
    { question: "node", id: SAVE },
    { question: "find", text: "save" },
    { question: "down", id: SAVE },
    { question: "up", id: SAVE },
    { question: "reach", id: SAVE },
  ];
  const answers = () => questions.map((question) => JSON.stringify(queryProductGraph({ root: f.root, ...question })));
  const withRecordsBlock = answers();
  assert(withRecordsBlock.every((answer) => !answer.includes("{뜻:")), "never checked: no mark");
  // The same answers from a check.json without the confirmation block.
  const checkFile = path.join(f.family, "build", "check.json");
  const check = JSON.parse(fs.readFileSync(checkFile, "utf8"));
  delete check.confirmations;
  fs.writeFileSync(checkFile, JSON.stringify(check, null, 2) + "\n");
  assert.deepEqual(answers(), withRecordsBlock);
  buildProductGraph({ root: f.root });
  confirmProductGraph({ root: f.root, features: [SAVE] });
  buildProductGraph({ root: f.root });
  assert.doesNotMatch(nodeLine(f, SAVE), /\{뜻:/, "a check that holds: no mark");
  editSave(f);
  buildProductGraph({ root: f.root });
  assert.match(nodeLine(f, SAVE), /\{뜻: 확인 뒤 코드가 바뀜\}/);
  const meaning = path.join(f.family, "기능 뜻.md");
  fs.writeFileSync(meaning, fs.readFileSync(meaning, "utf8").replace("지금 상태를 저장한다", "지금 상태를 파일로 저장한다"));
  buildProductGraph({ root: f.root });
  assert.match(nodeLine(f, SAVE), /\{뜻: 확인 뒤 뜻 줄이 바뀜\}/);
});

// ---------- C8: the page itself (the in-memory DOM the viewer tests use) ----------

const { explorerDom, visibleText } = await import("./helpers/graph-explorer-dom-fixture.mjs");
const { buildGraphExplorerSnapshot } = await import("../scripts/lib/world/graph-explorer.mjs");
const all = (element) => [element, ...element.children.flatMap(all)];
const clickButton = (ui, view, pattern) => {
  const target = all(ui.ids.get(view)).find((element) => element.tagName === "button" && pattern.test(element.textContent));
  assert(target, String(pattern));
  ui.event(target);
  return target;
};

async function richRecordPage(t) {
  const f = fixture(t, "# Goal\n- read the notes\n- keep them");
  fs.mkdirSync(path.join(f.root, "lib"), { recursive: true });
  const text = Array.from({ length: 170 }, (_, i) => `// line ${i + 1}`).join("\n") + "\n";
  fs.writeFileSync(path.join(f.root, "lib", "notes.mjs"), text);
  f.save({
    summary: "Read the notes file.",
    pending: ["# Next\n- first step\n- second step"],
    unknowns: ["Line one\r\nline two"],
    judgments: [{ assessment: "Keep it", reason: "## Why\n2026. 11. 17. decided\n\nA closing line.", alternatives: [] }],
    references: [{ kind: "source", path: "lib/notes.mjs", digest: sha(text) }],
  });
  const ui = explorerDom(await buildGraphExplorerSnapshot({ root: f.root, paths: ["lib/notes.mjs"] }));
  return { f, ui };
}

test("C8: the record page shows authored text as blocks with its line breaks and numbers, and reads a referred file in pages", async (t) => {
  const { ui } = await richRecordPage(t);
  clickButton(ui, "view-status", /record of/);
  const page = all(ui.ids.get("view-status"));
  const texts = (tag) => page.filter((element) => element.tagName === tag).map((element) => element.textContent);
  // Pending work: a heading and a list.
  assert(page.some((element) => element.tagName === "p" && /rich-heading/.test(element.className) && element.textContent === "Next"));
  assert(texts("li").includes("first step"));
  // An unknown's line break (CRLF) stays a line break.
  const unknown = page.find((element) => element.tagName === "p" && element.textContent === "Line oneline two");
  assert(unknown && unknown.children.some((child) => child.tagName === "br"));
  // The reason keeps the number its author wrote.
  const numbered = page.find((element) => element.tagName === "ol" && /rich-numbered/.test(element.className));
  assert.equal(numbered.children[0].textContent, "2026. 11. 17. decided");
  // The referred file: line numbers, 80 lines a page, then the next page.
  clickButton(ui, "view-status", /^Show content$/);
  const lines = () =>
    all(ui.ids.get("view-status"))
      .filter((element) => element.className === "source-no")
      .map((element) => Number(element.textContent));
  assert.deepEqual([lines()[0], lines().at(-1), lines().length], [1, 80, 80]);
  assert(all(ui.ids.get("view-status")).some((element) => element.textContent === "File reference; no recorded line range"));
  clickButton(ui, "view-status", /^Next 80 lines$/);
  assert.deepEqual([lines()[0], lines().at(-1)], [81, 160]);
  clickButton(ui, "view-status", /^Next 80 lines$/);
  assert.deepEqual([lines()[0], lines().at(-1)], [161, 170]);
  assert(!all(ui.ids.get("view-status")).some((element) => element.tagName === "button" && /^Next 80 lines$/.test(element.textContent)));
});

test("C8: the Session page shows a multi-line purpose as blocks", async (t) => {
  const { ui } = await richRecordPage(t);
  clickButton(ui, "view-status", /^# GoalLatest:|^GoalLatest:|Latest: Read the notes file/);
  const page = all(ui.ids.get("view-status"));
  assert(page.some((element) => element.tagName === "p" && /rich-heading/.test(element.className) && element.textContent === "Goal"));
  assert(page.some((element) => element.tagName === "li" && element.textContent === "read the notes"));
});

test("C8: the Gaps view shows the confirmation block, each status folded, each item linked to its node", async (t) => {
  const f = project(t);
  buildProductGraph({ root: f.root });
  confirmProductGraph({ root: f.root, features: [SAVE] });
  editSave(f);
  buildProductGraph({ root: f.root });
  const ui = explorerDom(await buildGraphExplorerSnapshot({ root: f.root, view: "gaps" }));
  const view = ui.ids.get("view-gaps");
  assert.match(visibleText(view), /확인 기록 \(기준과 따로/);
  const changed = all(view).find((element) => element.tagName === "details" && /^확인 뒤 코드가 바뀜: 1$/.test(element.children[0]?.textContent || ""));
  assert(changed, "a folded list per status");
  changed.open = true;
  ui.event(changed, "toggle");
  const link = all(changed).find((element) => element.tagName === "button" && element.textContent.includes(SAVE));
  assert(link, "the item links to its node");
  assert(all(view).some((element) => element.tagName === "details" && /^확인한 적 없음: 8$/.test(element.children[0]?.textContent || "")));
});

test("C8: the new page parts wrap within a narrow screen (CSS rules; no browser layout)", () => {
  const css = fs.readFileSync(path.join(pluginRoot, "scripts", "graph-explorer", "views.css"), "utf8");
  const rule = (selector) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\{([^}]*)\\}`))?.[1] || "";
  for (const selector of [".source-reader", ".source-text", ".item-text.rich"]) assert.match(rule(selector), /min-width:0/, selector);
  for (const selector of [".source-text", ".rich-code"]) assert.match(rule(selector), /overflow-wrap:anywhere/, selector);
  assert.match(rule(".source-nav"), /flex-wrap:wrap/);
  // No fixed width a 375 px screen could not hold.
  for (const selector of [".source-reader", ".source-nav", ".source-lines", ".source-line", ".source-text", ".rich-code", ".rich-text>*"])
    assert.doesNotMatch(rule(selector), /(?:^|;)(?:min-)?width:\s*(?:[4-9][0-9]{2}|[0-9]{4,})px/, selector);
});

// ---------- review round 2: D1–D9 ----------

const bigDocument = (f, count = 1001) => {
  const main = path.join(f.family, MAIN);
  const rows = Array.from({ length: count }, (_, index) => `| MAIN-01#${index + 10} | 버튼 ${index} | \`station/ui/main_window.py:18\` | \`${SAVE}\` | |`).join("\n");
  fs.writeFileSync(main, fs.readFileSync(main, "utf8").replace("| MAIN-01#5 |", `${rows}\n| MAIN-01#5 |`));
};
const staleCopy = (record, checkedAt) =>
  productGraphCheckRecord({
    projectId: record.projectId,
    by: "agent-checked",
    checkedAt,
    rationale: null,
    reader: record.reader,
    items: record.items.map((item) => ({ ...item, basis: item.basis.map((node) => ({ ...node, contentSha256: "0".repeat(64) })) })),
  });

test("D1: a confirm counts at once even when the item has two unrelated current records dated ahead", (t) => {
  const f = project(t);
  buildProductGraph({ root: f.root });
  const first = confirmProductGraph({ root: f.root, features: [SAVE] });
  const good = JSON.parse(fs.readFileSync(path.join(f.checks, `${first.records[0]}.json`), "utf8"));
  fs.rmSync(path.join(f.checks, `${first.records[0]}.json`));
  // Two stores merged: two stale records nobody replaced, both dated ahead.
  const a = staleCopy(good, "2099-01-01T00:00:00.000Z");
  const b = staleCopy({ ...good, reader: good.reader }, "2098-01-01T00:00:00.000Z");
  writeRecord(f, a);
  writeRecord(f, { ...b });
  assert.notEqual(a.checkId, b.checkId);
  let built = buildProductGraph({ root: f.root });
  assert(ids(built.confirmations.changedSinceCheck).includes(SAVE));
  const now = confirmProductGraph({ root: f.root, features: [SAVE] });
  assert.equal(now.status, "recorded");
  const written = JSON.parse(fs.readFileSync(path.join(f.checks, `${now.records[0]}.json`), "utf8"));
  assert.deepEqual(written.supersedes, [a.checkId, b.checkId].sort());
  built = buildProductGraph({ root: f.root });
  assert.equal(built.confirmations.counts.current, 1, "one confirm is enough");
  assert(!ids(built.confirmations.changedSinceCheck).includes(SAVE));
});

test("D2: a 확인 folder that cannot be listed, and one record that cannot be read, are issues; nothing else stops", (t) => {
  const f = project(t);
  let built = buildProductGraph({ root: f.root });
  const confirmed = confirmProductGraph({ root: f.root, features: [SAVE] });
  const record = path.join(f.checks, `${confirmed.records[0]}.json`);
  // One record that cannot be read.
  const originalRead = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (file, ...rest) => {
    if (String(file) === record) throw Object.assign(new Error("fixture denied"), { code: "EACCES" });
    return originalRead(file, ...rest);
  });
  built = buildProductGraph({ root: f.root });
  t.mock.restoreAll();
  assert.deepEqual(
    built.confirmations.issues.map((issue) => [issue.path, issue.code]),
    [[`확인/${confirmed.records[0]}.json`, "PRODUCT_GRAPH_CHECK_UNREADABLE"]],
  );
  assert(ids(built.confirmations.neverChecked).includes(SAVE), "an unreadable record excuses nothing");
  // A folder that cannot be listed.
  const originalList = fs.readdirSync;
  t.mock.method(fs, "readdirSync", (directory, ...rest) => {
    if (String(directory) === f.checks) throw Object.assign(new Error("fixture denied"), { code: "EPERM" });
    return originalList(directory, ...rest);
  });
  built = buildProductGraph({ root: f.root });
  assert.deepEqual(
    built.confirmations.issues.map((issue) => [issue.path, issue.code]),
    [["확인/", "PRODUCT_GRAPH_CHECK_UNREADABLE"]],
  );
  assert.equal(checkProductGraph({ root: f.root }).confirmations.issues.length, 1);
  assert.equal(readProductGraphBuild({ root: f.root }).freshness.state, "fresh");
  assert.equal(queryProductGraph({ root: f.root, question: "changes" }).title, "기준과 비교");
  moveProductGraphBaseline({ root: f.root });
  const digest = built.documents.list.find((item) => item.path === MAIN).approvalDigest;
  const approved = approveProductGraphDocument({ root: f.root, document: MAIN, expectedSha256: digest, rationale: "ok" });
  assert.equal(approved.status, "recorded");
  assert.equal(approved.codeBasis.status, "not-recorded");
  assert.throws(() => confirmProductGraph({ root: f.root, features: [SAVE] }), { code: "PRODUCT_GRAPH_CHECK_UNREADABLE" });
  t.mock.restoreAll();
});

test("D3: reading the build and every query read no record body; a size change is noticed, a same-size change waits for the build", (t) => {
  const f = project(t);
  buildProductGraph({ root: f.root });
  const confirmed = confirmProductGraph({ root: f.root, features: [SAVE] });
  buildProductGraph({ root: f.root });
  const originalRead = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, "readFileSync", (file, ...rest) => {
    if (String(file).includes(`${path.sep}확인${path.sep}`)) reads += 1;
    return originalRead(file, ...rest);
  });
  readProductGraphBuild({ root: f.root });
  for (const question of [{ question: "changes" }, { question: "node", id: SAVE }, { question: "overview" }]) queryProductGraph({ root: f.root, ...question });
  t.mock.restoreAll();
  assert.equal(reads, 0);
  const file = path.join(f.checks, `${confirmed.records[0]}.json`);
  const text = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, text.replace(/"rationale": null/, '"rationale": "x"'));
  assert.equal(readProductGraphBuild({ root: f.root }).freshness.confirmations.changed, true, "size changed");
  fs.writeFileSync(file, text.replace("agent-checked", "agent-checkeX"));
  assert.equal(readProductGraphBuild({ root: f.root }).freshness.confirmations.changed, false, "same size: noticed at the next build");
  assert.equal(buildProductGraph({ root: f.root }).confirmations.issues.length, 1);
});

test("D4: surplus records past the count are named up to 100, then counted", (t) => {
  const f = project(t);
  buildProductGraph({ root: f.root });
  fs.mkdirSync(f.checks, { recursive: true });
  for (let index = 0; index < PRODUCT_GRAPH_CHECK_MAX_RECORDS + 350; index++)
    fs.writeFileSync(path.join(f.checks, `product-graph-check-${index.toString(16).padStart(24, "0")}.json`), "{}");
  const built = buildProductGraph({ root: f.root });
  const surplus = built.confirmations.issues.filter((issue) => issue.code === "PRODUCT_GRAPH_CHECK_LIMIT");
  assert.equal(surplus.length, 101);
  assert.deepEqual(surplus.find((issue) => issue.path === "확인/"), {
    path: "확인/",
    code: "PRODUCT_GRAPH_CHECK_LIMIT",
    reason: "그 밖에 확인 기록 250개를 더 읽지 않았다(이름은 앞의 100개만 적는다)",
    count: 250,
  });
  assert.equal(built.confirmations.recordLimit.present, PRODUCT_GRAPH_CHECK_MAX_RECORDS + 350);
});

test("D5: a record write that fails part way: confirm and approve name what was written and what was not", (t) => {
  const f = project(t);
  bigDocument(f);
  let built = buildProductGraph({ root: f.root });
  const link = fs.linkSync;
  let calls = 0;
  t.mock.method(fs, "linkSync", (from, to) => {
    if (String(to).includes("product-graph-check-") && ++calls === 2) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    return link(from, to);
  });
  const confirmed = confirmProductGraph({ root: f.root, documents: [MAIN] });
  t.mock.restoreAll();
  assert.equal(confirmed.status, "partial");
  assert.equal(confirmed.writeError, "ENOSPC");
  assert.equal(confirmed.records.length, 1);
  assert(confirmed.notWritten.length >= 2);
  assert.deepEqual(
    fs.readdirSync(f.checks).filter((name) => name.endsWith(".json")),
    confirmed.records.map((id) => `${id}.json`),
  );
  // Nothing written at all: a named failure.
  fs.rmSync(f.checks, { recursive: true });
  t.mock.method(fs, "linkSync", (from, to) => {
    if (String(to).includes("product-graph-check-")) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    return link(from, to);
  });
  assert.throws(() => confirmProductGraph({ root: f.root, documents: [MAIN] }), { code: "PRODUCT_GRAPH_CHECK_WRITE_FAILED" });
  t.mock.restoreAll();
  // Approve: the approval stands, the code basis is partial.
  built = buildProductGraph({ root: f.root });
  calls = 0;
  t.mock.method(fs, "linkSync", (from, to) => {
    if (String(to).includes("product-graph-check-") && ++calls === 2) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    return link(from, to);
  });
  const digest = built.documents.list.find((item) => item.path === MAIN).approvalDigest;
  const approved = approveProductGraphDocument({ root: f.root, document: MAIN, expectedSha256: digest, rationale: "ok" });
  t.mock.restoreAll();
  assert.equal(approved.status, "recorded");
  assert.equal(approved.codeBasis.status, "partial");
  assert.equal(approved.codeBasis.code, "ENOSPC");
  assert.equal(approved.codeBasis.records.length, 1);
  assert(approved.codeBasis.notWritten.length >= 2);
});

test("D6: a 기능 id longer than 2048 characters can be confirmed and approved with its code basis", (t) => {
  const f = project(t);
  const long = `_save${"x".repeat(2100)}`;
  for (const file of [f.window, path.join(f.family, MAIN), path.join(f.family, "기능 뜻.md")])
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("_save", long));
  const built = buildProductGraph({ root: f.root });
  const id = SAVE.replace("_save", long);
  assert(id.length > 2048);
  assert.equal(confirmProductGraph({ root: f.root, features: [id] }).status, "recorded");
  assert.equal(confirmProductGraph({ root: f.root, documents: [MAIN] }).status, "recorded");
  const digest = built.documents.list.find((item) => item.path === "화면설계서/DLG-01.md").approvalDigest;
  assert.equal(approveProductGraphDocument({ root: f.root, document: "화면설계서/DLG-01.md", expectedSha256: digest, rationale: "ok" }).codeBasis.status, "recorded");
  const after = buildProductGraph({ root: f.root });
  assert.deepEqual(after.confirmations.issues, []);
  assert(!ids(after.confirmations.neverChecked).includes(id));
});

test("D7: a 확인 or 승인 folder stored decomposed is used as it is: one folder, freshness settles", (t) => {
  const f = project(t);
  let built = buildProductGraph({ root: f.root });
  confirmProductGraph({ root: f.root, features: [SAVE] });
  const decomposed = path.join(f.family, "확인".normalize("NFD"));
  fs.renameSync(f.checks, decomposed);
  built = buildProductGraph({ root: f.root });
  assert.equal(built.confirmations.counts.current, 1);
  assert.equal(readProductGraphBuild({ root: f.root }).freshness.confirmations.changed, false);
  confirmProductGraph({ root: f.root, documents: [MAIN] });
  const folders = fs.readdirSync(f.family).filter((name) => name.normalize("NFC") === "확인");
  assert.deepEqual(folders, ["확인".normalize("NFD")]);
  assert.equal(fs.readdirSync(decomposed).length, 2);
  // 승인 the same way.
  fs.mkdirSync(path.join(f.family, "승인".normalize("NFD")));
  const digest = built.documents.list.find((item) => item.path === "화면설계서/DLG-01.md").approvalDigest;
  approveProductGraphDocument({ root: f.root, document: "화면설계서/DLG-01.md", expectedSha256: digest, rationale: "ok" });
  assert.deepEqual(
    fs.readdirSync(f.family).filter((name) => name.normalize("NFC") === "승인"),
    ["승인".normalize("NFD")],
  );
  assert.equal(checkProductGraph({ root: f.root }).documents.approved, 1);
});

test("D8: a 확인 that is a file: confirm is refused by name, approve still approves", (t) => {
  const f = project(t);
  const built = buildProductGraph({ root: f.root });
  fs.writeFileSync(f.checks, "not a folder\n");
  assert.throws(() => confirmProductGraph({ root: f.root, features: [SAVE] }), { code: "PRODUCT_GRAPH_CHECK_FOLDER_INVALID" });
  const digest = built.documents.list.find((item) => item.path === MAIN).approvalDigest;
  const approved = approveProductGraphDocument({ root: f.root, document: MAIN, expectedSha256: digest, rationale: "ok" });
  assert.equal(approved.status, "recorded");
  assert.equal(approved.codeBasis.code, "PRODUCT_GRAPH_CHECK_FOLDER_INVALID");
});

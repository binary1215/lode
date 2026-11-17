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
import { productGraphCheckRecord, verifyProductGraphCheck } from "../scripts/lib/storage/product-graph-store.mjs";
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
  assert.deepEqual(fs.readdirSync(f.checks), [`${confirmed.checkId}.json`]);
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
  const record = JSON.parse(fs.readFileSync(path.join(f.checks, `${approved.codeBasis.checkId}.json`), "utf8"));
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
  const file = path.join(f.checks, `${confirmed.checkId}.json`);
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
    { path: `확인/${confirmed.checkId}.json`, code: "PRODUCT_GRAPH_CHECK_INVALID", reason: "확인 기록의 모양이나 내용 주소가 맞지 않는다" },
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
  // An approval after the build changes the graph (the document's status): the build is not current.
  const digest = checkProductGraph({ root: f.root }).documents.list.find((item) => item.path === "정책.md").approvalDigest;
  approveProductGraphDocument({ root: f.root, document: "정책.md", expectedSha256: digest, rationale: "ok" });
  assert.throws(() => confirmProductGraph({ root: f.root, features: [SAVE] }), { code: "PRODUCT_GRAPH_BUILD_STALE" });
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
  assert.match(queryProductGraph({ root: f.root, question: "node", id: SAVE }).text, /\{뜻: 확인한 적 없음\}/);
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
  const name = `.lode/context/product-graph/확인/${confirmed.checkId}.json`;
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
    { kind: "list", ordered: true, items: ["one"] },
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
  const views = fs.readFileSync(path.join(pluginRoot, "scripts", "graph-explorer", "views.js"), "utf8");
  assert.match(views, /node\.textContent = explorerReading\.displayText\(options\.text\)/);
  assert(GRAPH_EXPLORER_SCRIPTS.indexOf("reading.js") >= 0 && GRAPH_EXPLORER_SCRIPTS.indexOf("reading.js") < GRAPH_EXPLORER_SCRIPTS.indexOf("views.js"));
  assert.match(graphExplorerScript(), /const explorerReading = /);
  const reading = fs.readFileSync(path.join(pluginRoot, "scripts", "graph-explorer", "reading.js"), "utf8");
  assert.doesNotMatch(reading, /\bfetch\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage|innerHTML|document\./);
  for (const key of ["reasonHeading", "recordedSpan", "noRecordedSpan", "sourceLines", "sourcePrevious", "sourceNext"])
    assert.match(fs.readFileSync(path.join(pluginRoot, "scripts", "graph-explorer", "i18n.js"), "utf8").split(key).length - 1 === 2 ? "ok" : "", /ok/, key);
});

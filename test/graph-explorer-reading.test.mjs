import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { explorerDom, visibleText } from "./helpers/graph-explorer-dom-fixture.mjs";

const load = (file, name) => vm.runInNewContext(fs.readFileSync(new URL(`../scripts/graph-explorer/${file}.js`, import.meta.url), "utf8") + `\n${name}`);
const factory = load("reading-model", "explorerReadingModel");
const summary = load("type-summary", "explorerTypeSummary");
const digest = "a".repeat(64), otherDigest = "b".repeat(64);
function fixture(count = 3, { overview = false } = {}) {
  const nodes = Array.from({ length: count }, (_, i) => ({ nodeId: `N${i}`, name: `Record ${i}`, kind: i ? "File" : "UserActivity", views: ["work"],
    projectId: "synthetic-reading", currentTraversalEligible: true, freshness: "snapshot-evidence",
    executionSource: { path: "src/example.mjs", digest, startLine: 2, endLine: 3 } }));
  const edges = nodes.slice(1).map(node => ({ edgeId: `E${node.nodeId}`, from: "N0", to: node.nodeId, type: "CALLS" }));
  return { kind: "GraphExplorerSnapshot", project: { projectId: "synthetic-reading" }, graph: { nodes, edges, basis: { projectId: "synthetic-reading", graphSnapshotId: "G1" }, initialNodeId: "N0",
    ...(overview ? { query: { query: "", paths: [], anchorIds: [] } } : {}), coverage: { state: "verified-available-layers" } },
    codeGraph: { nodes: [], edges: [], status: "unavailable" }, originals: {
      [JSON.stringify(["src/example.mjs", digest])]: { status: "verified-exact-bytes", digest, reference: { path: "src/example.mjs", digest }, text: "first\nsecond\nthird\nfourth" },
    }, history: { entries: [] } };
}
const pair = (id, d = digest) => ({ identity: id, scope: "recorded-work", before: { path: "src/example.mjs", digest: d }, after: { path: "src/example.mjs", digest: otherDigest },
  diff: { regions: [{ before: { startLine: 2, text: "second\nthird" }, after: { startLine: 2, text: "changed\nthird" } }] } });
const buttons = element => element.children.filter(child => child.tagName === "button");
async function counted(ui) { for (let i = 0; i < 100; i++) { await Promise.resolve(); ui.flush(); if (ui.ids.get("type-summary-cancel").hidden) return; } throw Error("Count did not settle"); }

test("exact reading address rebinds to its original, never a forged Project/basis/source/span or another pair side", () => {
  const data = fixture(), before = JSON.stringify(data), model = factory.create(data, data.graph), address = model.addresses(data.graph.nodes[0])[0];
  assert.equal(model.read(address).status, "available");
  for (const change of [{ projectId: "other" }, { basis: "other" }, { nodeId: "missing" }, { key: "forged" }]) assert.equal(model.resolve({ ...address, ...change }), null);
  // Caller-modified duplicate fields cannot redirect a verified canonical key.
  assert.equal(model.resolve({ ...address, path: "elsewhere", span: { startLine: 999, endLine: 1000 } }).path, address.path);
  assert.equal(model.resolve({ ...address, digest: otherDigest }).digest, digest);
  data.graph.contextLineage = { files: [{ path: "src/example.mjs", comparisons: [pair("old"), pair("new")] }] };
  const contextual = factory.create(data, data.graph), ref = contextual.addresses(data.graph.nodes[0])[0];
  const choices = contextual.comparisons(ref); assert.equal(choices.length, 2);
  assert.equal(contextual.read(ref, { key: choices[0].key, side: "after" }).status, "ambiguous-or-unbound-pair");
  assert.equal(contextual.read(ref, choices[0]).selected.pair.identity, "old");
  assert.equal(contextual.read(ref, choices[1]).selected.pair.identity, "new");
  assert.equal(contextual.read(ref, { key: "stale", side: "before" }).status, "ambiguous-or-unbound-pair");
  delete data.graph.contextLineage; assert.equal(JSON.stringify(data), before);
});

test("missing text, file-only references, disjoint excerpts and ambiguous comparisons remain navigable without invented span proof", () => {
  const data = fixture(); data.originals = {};
  data.graph.contextLineage = { files: [{ path: "src/example.mjs", comparisons: [pair("one"), pair("two")] }] };
  const model = factory.create(data, data.graph), address = model.addresses(data.graph.nodes[0])[0];
  assert.equal(model.read(address).status, "choose-exact-comparison");
  data.graph.contextLineage.files[0].comparisons[0].diff.regions = [{ before: { startLine: 1, text: "first\nsecond" } }, { before: { startLine: 3, text: "third" } }];
  const choices = model.comparisons(address), read = model.read(address, choices[0]);
  assert.equal(read.status, "span-not-included"); assert.equal(read.chunks.length, 2);
  data.graph.nodes[0].executionSource = { path: "src/example.mjs", digest }; const file = model.addresses(data.graph.nodes[0])[0];
  assert.equal(file.span, null); assert.equal(model.read(file, model.comparisons(file)[0]).status, "available");
  for (const path of ["../secret", ".lode/state.json", "C:/secret", "/secret", "src\\secret"]) {
    data.graph.nodes[0].executionSource = { path, digest }; assert.equal(model.addresses(data.graph.nodes[0]).length, 0);
  }
});

test("directed groups preserve self once, parallel IDs independently, filter counts and unknown endpoints", () => {
  const data = fixture(); data.graph.edges.push({ edgeId: "self", from: "N0", to: "N0", type: "CALLS" },
    { edgeId: "parallel", from: "N0", to: "N1", type: "CALLS" }, { edgeId: "incoming", from: "N1", to: "N0", type: "CALLS" },
    { edgeId: "missing", from: "N0", to: "not-exported", type: "IMPORTS" });
  const model = factory.create(data, data.graph), grouped = model.groups(data.graph.nodes[0], edge => edge.edgeId !== "parallel");
  assert.equal(grouped.included, 6); assert.equal(grouped.filtered, 1); assert.equal(grouped.unknownEndpoints, 1); assert.equal(grouped.omitted, null);
  assert.equal(grouped.groups.find(group => group.direction === "self").edges.length, 1);
  assert(grouped.groups.find(group => group.direction === "incoming"));
  assert.equal(grouped.groups.find(group => group.direction === "outgoing" && group.type === "CALLS").included, 3);
});

test("kind counts are actual exported types, with unique IDs and missing/filtered edges separated; partial counts never complete", async () => {
  const data = fixture(1100); data.graph.nodes.push(data.graph.nodes[0]); data.graph.edges.push(data.graph.edges[0], { edgeId: "self", from: "N0", to: "N0", type: "SELF" }, { edgeId: "gap", from: "N0", to: "missing", type: "CALLS" });
  const result = await summary.count(data.graph, { includeNode: node => node.nodeId !== "N1" });
  assert.equal(result.complete, true); assert.equal(result.exportedNodes, 1100); assert.equal(result.includedNodes, 1099);
  assert.equal(result.exportedEdges, 1101); assert.equal(result.missingEndpointEdges, 1); assert.equal(result.filteredEdges, 1); assert.equal(result.eligibleEdges, 1099);
  assert.equal(result.kinds.map(row => row.kind).join(), "File,UserActivity");
  let yields = 0; const cancelled = await summary.count(data.graph, { yieldWork: async () => { yields++; }, cancelled: () => yields > 2 });
  assert.equal(cancelled.complete, false); assert(cancelled.examinedNodes < 1100); assert.equal(cancelled.examinedEdges, 0);
});

test("unanchored Overview reaches the last actual record; exact anchor/query/path intent opens Reading instead", async () => {
  const data = fixture(1105, { overview: true }), before = JSON.stringify(data), ui = explorerDom(data);
  await counted(ui); assert.equal(ui.document.documentElement.dataset.explorerView, "types");
  const fileKind = ui.ids.get("type-summary-kinds").children.find(el => el.getAttribute("data-export-kind") === "File");
  ui.event(fileKind); assert.equal(ui.document.documentElement.dataset.explorerView, "records");
  for (let i = 0; i < 11; i++) ui.event("records-next");
  assert(ui.ids.get("records").textContent.includes("Record 1104"));
  ui.event(ui.ids.get("records").children.at(-1).children[0]); assert.match(ui.ids.get("reading-flow-title").textContent, /Record 1104/);
  assert.equal(ui.document.documentElement.dataset.explorerView, "reading"); assert.equal(JSON.stringify(data), before);
  for (const query of [{ anchorIds: ["N0"] }, { query: "Record 0" }, { paths: ["src/example.mjs"] }]) {
    const target = fixture(3, { overview: true }); Object.assign(target.graph.query, query);
    if (query.anchorIds) target.graph.detailSelection = { anchorIds: query.anchorIds };
    assert.equal(explorerDom(target).document.documentElement.dataset.explorerView, "reading");
  }
});

test("source/read return is one purposeful jump, Back restores exact source focus, and a later click invalidates late restoration", async () => {
  const data = fixture(), before = JSON.stringify(data), ui = explorerDom(data, { resetDetachedScroll: true }); await ui.settle();
  ui.event(buttons(ui.ids.get("reading-sources"))[0]); ui.flush();
  assert.equal(ui.document.documentElement.dataset.readingTab, "source"); assert.match(ui.ids.get("reading-source-code").textContent, /2  second/);
  assert.equal(ui.ids.get("reading-source-code").querySelectorAll("[data-reading-line]").length, 4);
  ui.ids.get("reading-source-code").scrollTop = 83; ui.event("reading-source-return");
  assert.equal(ui.document.documentElement.dataset.readingTab, "explanation");
  ui.event("back"); ui.flush(); assert.equal(ui.document.documentElement.dataset.readingTab, "source"); assert.equal(ui.ids.get("reading-source-code").scrollTop, 83);
  ui.event("forward"); ui.event(ui.ids.get("records").children[1].children[0]); ui.flush();
  assert.match(ui.ids.get("reading-flow-title").textContent, /Record 1/); assert.equal(ui.document.documentElement.dataset.readingTab, "explanation");
  assert.equal(JSON.stringify(data), before);
});

test("group members, group headers and exact comparison choices continue to the end with bounded live DOM", async () => {
  const data = fixture(104); data.graph.edges.push(...Array.from({ length: 26 }, (_, i) => ({ edgeId: `T${i}`, from: "N0", to: "N1", type: `TYPE${i}` })));
  data.graph.contextLineage = { files: [{ path: "src/example.mjs", comparisons: Array.from({ length: 45 }, (_, i) => pair(`P${i}`)) }] };
  const ui = explorerDom(data); await ui.settle(); ui.event("read-connections");
  const group = ui.ids.get("reading-neighbors").children.find(el => el.textContent.includes("Calls")); group.open = true; ui.event(group, "toggle");
  const rows = group.children[1], nav = group.children[2]; assert.equal(rows.children.length, 20);
  for (let i = 0; i < 5; i++) ui.event(nav.children[2]); assert(rows.textContent.includes("Record 103")); assert.equal(rows.children.length, 3);
  ui.event("reading-groups-next"); assert.equal(ui.ids.get("reading-neighbors").children.length, 7);
  ui.event(buttons(ui.ids.get("reading-sources"))[0]); ui.flush(); assert.equal(buttons(ui.ids.get("reading-source-choices")).length, 20);
  ui.event("reading-choices-next"); ui.event("reading-choices-next"); assert.equal(buttons(ui.ids.get("reading-source-choices")).length, 5);
  assert(buttons(ui.ids.get("reading-source-choices")).at(-1).getAttribute("data-reading-comparison").includes("P44"));
});

test("cancelled and superseded kind scopes cannot overwrite a fresh count; complete cache is reused", async () => {
  const data = fixture(1200, { overview: true }), ui = explorerDom(data);
  ui.event("type-summary-cancel"); ui.flush(); await Promise.resolve();
  assert.match(ui.ids.get("type-summary-status").textContent, /cancel/i); assert.equal(ui.ids.get("type-summary-kinds").children.length, 0);
  ui.event("type-summary-retry"); ui.ids.get("search").value = "Record 1199"; ui.event("search", "input"); await counted(ui);
  assert.match(ui.ids.get("type-summary-status").textContent, /1 shown \/ 1200 records/);
  const duration = ui.document.documentElement.dataset.explorerTypeSummaryMs;
  ui.event("view-records"); ui.event("view-types"); assert.equal(ui.document.documentElement.dataset.explorerTypeSummaryMs, duration);
  assert.match(ui.ids.get("type-summary-status").textContent, /1 shown \/ 1200 records/);
});

test("a structural layer cannot borrow Project comparisons; truncated text cannot claim an exact highlighted span", () => {
  const data = fixture(); data.originals = {};
  const comparison = pair("partial"); comparison.diff.regions[0].before.textTruncated = true;
  data.graph.contextLineage = { files: [{ path: "src/example.mjs", comparisons: [comparison] }] };
  const project = factory.create(data, data.graph), address = project.addresses(data.graph.nodes[0])[0];
  assert.equal(project.read(address).status, "partial-source");
  data.codeGraph = { nodes: [structuredClone(data.graph.nodes[0])], edges: [], status: "current", worldModelId: "W2", semanticGraphId: "S2" };
  const code = factory.create(data, data.codeGraph), other = code.addresses(data.codeGraph.nodes[0])[0];
  assert.equal(code.comparisons(other).length, 0); assert.equal(code.read(other).status, "source-not-included");
  assert.equal(code.resolve(address), null);
});

test("source selection never carries another record's source, missing bytes keep the reader usable, and display treats markup as text", async () => {
  const data = fixture(); data.graph.nodes[1].name = "<img src=x onerror=alert(1)>";
  data.graph.nodes[1].executionSource = { path: "src/missing.mjs", digest: otherDigest, line: 8 };
  const before = JSON.stringify(data), ui = explorerDom(data); await ui.settle();
  ui.event(buttons(ui.ids.get("reading-sources"))[0]); ui.flush();
  ui.event("view-records"); ui.event(ui.ids.get("records").children[1].children[0]);
  assert.equal(ui.ids.get("reading-source").hidden, true);
  assert.equal(ui.ids.get("reading-flow-title").textContent, data.graph.nodes[1].name);
  assert.equal(ui.ids.get("reading-flow-title").children.length, 0);
  ui.event(buttons(ui.ids.get("reading-sources"))[0]); ui.flush();
  assert.match(ui.ids.get("reading-source-status").textContent, /Source text not included/);
  assert.equal(ui.ids.get("reading-source-next").disabled, true); assert.equal(ui.ids.get("reading-source-prev").disabled, true);
  ui.event("reading-source-return"); assert.equal(ui.document.documentElement.dataset.readingTab, "explanation");
  assert.match(ui.ids.get("reading-flow-title").textContent, /onerror/); assert.equal(JSON.stringify(data), before);
});

test("same-byte ambiguous comparisons retain exact pair-side choice through Back and return to their actual record", async () => {
  const data = fixture(); data.graph.contextLineage = { files: [{ path: "src/example.mjs", associations: [{ nodeId: "N0" }], comparisons: [pair("first"), pair("second")] }] };
  const before = JSON.stringify(data), ui = explorerDom(data); await ui.settle();
  ui.event(buttons(ui.ids.get("reading-sources"))[0]); ui.flush();
  ui.event(buttons(ui.ids.get("reading-source-choices"))[1]);
  const selected = ui.document.body.querySelectorAll("[data-reading-pair]").find(el => el.getAttribute("data-reading-pair").includes("second"));
  assert(selected?.open); assert.equal(ui.document.documentElement.dataset.readingTab, "source");
  const back = ui.document.body.querySelectorAll("[data-reading-return-pair]").find(el => el.getAttribute("data-reading-return-pair").includes("second"));
  assert(back && !back.hidden); ui.event(back); ui.flush(); assert.equal(ui.document.documentElement.dataset.readingTab, "explanation");
  ui.event("back"); ui.flush(); assert.equal(ui.document.documentElement.dataset.readingTab, "source");
  assert.equal(ui.ids.get("reading-source").hidden, false);
  assert.match(ui.ids.get("reading-source-code").getAttribute("data-reading-key"), /second/);
  assert.equal(JSON.stringify(data), before);
});

test("Back restores the exact kind/type page after a different scope replaced the completed count cache", async () => {
  const data = fixture(45, { overview: true });
  data.graph.nodes.forEach((node, i) => { node.kind = `Kind-${String(i).padStart(2, "0")}`; });
  data.graph.edges.forEach((edge, i) => { edge.type = `Type-${String(i).padStart(2, "0")}`; });
  const ui = explorerDom(data); await counted(ui);
  ui.event("type-kinds-next"); ui.event("type-relations-next");
  const firstKind = ui.ids.get("type-summary-kinds").children[0].getAttribute("data-export-kind");
  const firstType = ui.ids.get("type-summary-relations").children[0].textContent.split(" · ")[0];
  ui.event("view-records"); ui.ids.get("search-kind").value = "Kind-42"; ui.event("search-kind", "change");
  ui.event("view-types"); await counted(ui);
  ui.event("back"); ui.flush(); ui.event("back"); ui.flush(); ui.event("back"); ui.flush(); await counted(ui);
  assert.equal(ui.document.documentElement.dataset.explorerView, "types");
  assert.equal(ui.ids.get("search-kind").value, "all");
  assert.equal(ui.ids.get("type-summary-kinds").children[0].getAttribute("data-export-kind"), firstKind);
  assert.equal(ui.ids.get("type-summary-relations").children[0].textContent.split(" · ")[0], firstType);
});

test("generated technical identity is closed by default, while authored checksum text survives title, explanation and source", async () => {
  const data = fixture(), authoredHash = "c".repeat(64), before = JSON.stringify(data);
  data.graph.nodes[0].name = `Checksum guide ${authoredHash}`;
  data.graph.nodes[0].description = `Keep the documented checksum ${authoredHash}.`;
  data.graph.nodes[0].origin = { layer: "sessionWork", path: `.lode/records/${digest}.json`, digest };
  data.originals[JSON.stringify(["src/example.mjs", digest])].text = `// checksum ${authoredHash}\nconst ready = true;\nexport { ready };`;
  const original = JSON.stringify(data), ui = explorerDom(data); await ui.settle();
  const defaultText = visibleText(ui.document.body);
  assert(defaultText.includes(authoredHash)); assert(!defaultText.includes(digest));
  assert(!defaultText.includes(data.graph.nodes[0].origin.path));
  assert.equal(ui.ids.get("reading-technical").open, false);
  ui.ids.get("reading-technical").open = true;
  assert(visibleText(ui.document.body).includes(digest));
  ui.ids.get("reading-technical").open = false;
  const sourceControl = buttons(ui.ids.get("reading-sources"))[0];
  assert(!String(sourceControl.title || "").includes(digest)); ui.event(sourceControl); ui.flush();
  assert(ui.ids.get("reading-source-code").textContent.includes(authoredHash));
  assert(!visibleText(ui.ids.get("reading-source")).includes(digest));
  ui.ids.get("reading-source-technical").open = true;
  assert(visibleText(ui.ids.get("reading-source")).includes(digest));
  assert.equal(JSON.stringify(data), original); assert.notEqual(original, before);
});

test("unnamed generated paths never become readable fallback titles, and duplicate human titles keep exact source identity", async () => {
  const data = fixture();
  data.graph.nodes[0] = { ...data.graph.nodes[0], name: undefined, path: `.lode/records/${digest}.json` };
  data.graph.nodes[1] = { ...data.graph.nodes[1], name: undefined, origin: { path: `.lode/records/${otherDigest}.json` } };
  const ui = explorerDom(data); await ui.settle();
  assert(!ui.ids.get("reading-flow-title").textContent.includes(digest));
  assert(!ui.ids.get("reading-flow-description").textContent.includes(".lode/"));
  data.graph.nodes[0].name = data.graph.nodes[1].name = "Same readable title";
  data.graph.nodes[1].executionSource = { path: "src/example.mjs", digest: otherDigest, line: 2 };
  const duplicateUi = explorerDom(data); await duplicateUi.settle();
  const entries = duplicateUi.ids.get("records").children.slice(0, 2).map(row => row.children[0]);
  assert.equal(entries[0].textContent.split("Source")[0].trim().startsWith("Same readable title"), true);
  assert.notEqual(entries[0].getAttribute("data-record-entry"), entries[1].getAttribute("data-record-entry"));
  duplicateUi.event(entries[1]); duplicateUi.event(buttons(duplicateUi.ids.get("reading-sources"))[0]); duplicateUi.flush();
  assert(duplicateUi.ids.get("reading-source-code").getAttribute("data-reading-key").includes(otherDigest));
  assert(!visibleText(duplicateUi.ids.get("reading-source")).includes(otherDigest));
});

test("source-description provenance does not invent an approval queue, and actual unreviewed/cancelled/partial/unavailable states stay readable", async () => {
  const data = fixture(); Object.assign(data.graph.nodes[0], { claimBasis: "authored", reviewState: "non-canonical-source-claim" });
  const ui = explorerDom(data); await ui.settle();
  assert.match(ui.ids.get("reading-flow-status").textContent, /Recorded description/);
  assert.doesNotMatch(ui.ids.get("reading-flow-status").textContent, /Not reviewed|approval|non-canonical/);
  Object.assign(data.graph.nodes[0], { reviewState: "unreviewed", status: "cancelled", contentPartial: true, executionEvidence: { state: "unavailable" } });
  const qualified = explorerDom(data); await qualified.settle();
  const status = qualified.ids.get("reading-flow-status").textContent;
  assert.match(status, /Not reviewed/); assert.match(status, /Cancelled/); assert.match(status, /Partial/); assert.match(status, /Source unavailable/);
});

test("authored names remain intact even when a checksum happens to equal the node identity", async () => {
  const data = fixture(), name = "f".repeat(64); data.graph.nodes[0].nodeId = name; data.graph.nodes[0].name = name; data.graph.initialNodeId = name;
  const original = JSON.stringify(data), ui = explorerDom(data); await ui.settle();
  assert.equal(ui.ids.get("reading-flow-title").textContent, name); assert.equal(JSON.stringify(data), original);
});

test("authored structures stay literal and bounded, preserving numbering, negation, code and oversized grapheme gaps", () => {
  const document = load("reading-document", "explorerDocument");
  const text = ["# 목적", "", "배포하지 않는다. 판단은 아직 불확실하다.", "", "3. 기록된 세 번째 항목", "7. 원문은 7번이다.", "", "~~~js", "<script>not executed</script>", "const checksum = \"keep\";", "~~~"].join("\n");
  const model = document.create(text), page = model.page();
  assert.equal(model.original, text); assert.equal(page.complete, true);
  assert.equal(model.blocks.filter(b => b.kind === "item").map(b => b.marker).join(","), "3.,7.");
  assert(model.blocks.some(b => b.kind === "code" && b.text.includes("<script>")));
  for (const unsupported of ["~~~js\nunfinished", "| a | b |\n| - | - |", "[Run](javascript:unsafe)"]) { const m = document.create(unsupported); assert.equal(m.original, unsupported); assert.equal(m.blocks.map(b => b.text).join("\n"), unsupported); }
  const source = "한글 가́ 나👨‍👩‍👧‍👦다", normal = document.create(source); let cursor, joined = "", parts = 0;
  do { const p = normal.page(cursor, { maxCharacters: 12 }); joined += p.blocks.map(b => b.text).join(""); assert(p.blocks.every(b => b.text.length <= 12 && !b.omittedTextUnitLength)); cursor = p.next; assert(++parts < 20); } while (cursor);
  assert.equal(joined, source);
  const huge = "a" + "\u0301".repeat(24000), g = document.create(huge).page();
  assert.equal(g.original, huge); assert.equal(g.complete, false); assert.equal(g.blocks[0].omittedTextUnitLength, huge.length); assert(g.blocks.every(b => b.text.length <= 12000));
});

test("one reading page exposes authored content and a real next target without a prerequisite perspective", async () => {
  const data = fixture(), original = JSON.stringify(data); data.graph.nodes[0].description = "# Recorded purpose\n\nDo not deploy.\n\n3. Inspect\n7. Keep the exception";
  const supplied = JSON.stringify(data), ui = explorerDom(data); await ui.settle();
  assert(visibleText(ui.ids.get("reading-flow-description")).includes("Do not deploy."));
  assert(visibleText(ui.ids.get("reading-next")).includes("Record 1"));
  assert.equal(ui.ids.get("reading-all-relations").open, false); assert.equal(ui.ids.get("reading-technical").open, false);
  const next = ui.ids.get("reading-next").querySelectorAll("[data-next-record]")[0]; next.focus(); const nextFocus = next.getAttribute("data-reading-focus"); assert(nextFocus); ui.event(next); ui.flush();
  assert.equal(ui.ids.get("reading-flow-title").textContent, "Record 1"); assert.equal(ui.stats.scrolled, ui.ids.get("reading-flow-title")); ui.event("back"); ui.flush();
  assert.equal(ui.ids.get("reading-flow-title").textContent, "Record 0"); assert(visibleText(ui.ids.get("reading-flow-description")).includes("7.")); assert.equal(ui.stats.focusedElement.getAttribute("data-reading-focus"), nextFocus);
  assert.equal(JSON.stringify(data), supplied); assert.notEqual(original, supplied);
});

test("document continuation and explicit oversized-unit disclosure keep complete exported text reachable", async () => {
  const data = fixture(); data.graph.nodes[0].description = "One complete paragraph.\n\n".repeat(40) + "Do NOT infer approval.";
  const supplied = JSON.stringify(data), ui = explorerDom(data); await ui.settle();
  assert.equal(ui.ids.get("reading-document-pages").hidden, false);
  ui.event("reading-document-next"); assert(visibleText(ui.ids.get("reading-flow-description")).includes("Do NOT infer approval."));
  ui.event("reading-document-prev"); assert(!visibleText(ui.ids.get("reading-flow-description")).includes("Do NOT infer approval.")); assert.equal(JSON.stringify(data), supplied);
  const oversized = fixture(); oversized.graph.nodes[0].description = "a" + "\u0301".repeat(24000); const u = explorerDom(oversized); await u.settle();
  assert.match(visibleText(u.ids.get("reading-flow-description")), /exceeds this display page/);
  const action = buttons(u.ids.get("reading-flow-description").children[0])[0]; u.event(action);
  assert.equal(u.ids.get("reading-selection").open, true); assert.equal(u.ids.get("focus-inspector").open, true); assert(u.ids.get("evidence").textContent.includes(oversized.graph.nodes[0].description));
});

test("next reading keeps self, parallel and missing relationships exact with visible scope and bounded previews", async () => {
  const data = fixture(1201); data.graph.edges.push({ edgeId: "parallel", from: "N0", to: "N1", type: "CALLS" }, { edgeId: "self", from: "N0", to: "N0", type: "CALLS" }, { edgeId: "gap", from: "N0", to: "missing", type: "CALLS" });
  const model = factory.create(data, data.graph), original = JSON.stringify(data), next = model.nextRead(data.graph.nodes[0]);
  assert.equal(next.rows.length, 4); assert.equal(next.rows[0].edges.length, 2); assert.equal(model.groups(data.graph.nodes[0]).included, 1203);
  const ui = explorerDom(data); await ui.settle(); assert.match(visibleText(ui.ids.get("reading-related")), /1 links have targets not included/);
  assert.equal(ui.ids.get("reading-next").querySelectorAll("[data-next-record]").length, 4); assert.equal(JSON.stringify(data), original);
  const only = fixture(1); only.graph.edges = [{ edgeId: "self", from: "N0", to: "N0", type: "CALLS" }];
  const selfUi = explorerDom(only); await selfUi.settle(); assert.match(visibleText(selfUi.ids.get("reading-next")), /No other connected record/);
  assert.match(selfUi.ids.get("reading-all-relations-label").textContent, /1/);
});


test("Back retains the exact later relation trigger after a delayed native details toggle", async () => {
  const data = fixture(85), supplied = JSON.stringify(data), ui = explorerDom(data); await ui.settle();
  let group = ui.ids.get("reading-neighbors").children[0]; group.open = true; ui.event(group, "toggle");
  ui.event(buttons(group.children[2]).find(b => b.textContent === "More members"));
  const trigger = buttons(group.children[1].children[0]).find(b => b.textContent.startsWith("Read Record ")); assert(trigger); trigger.focus();
  const key = trigger.getAttribute("data-reading-focus"); assert(key); ui.event(trigger); ui.flush();
  ui.event("back"); ui.flush(); group = ui.ids.get("reading-neighbors").children[0];
  const restored = group.querySelectorAll("[data-reading-focus]").find(b => b.getAttribute("data-reading-focus") === key); assert(restored);
  assert.equal(ui.stats.focusedElement, restored); assert.match(visibleText(group), /21–40/);
  ui.event(group, "toggle"); assert.equal(ui.stats.focusedElement, restored); assert(ui.document.body.contains(restored));
  assert.equal(JSON.stringify(data), supplied);
});

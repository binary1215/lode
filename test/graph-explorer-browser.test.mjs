import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { explorerDom } from "./helpers/graph-explorer-dom-fixture.mjs";

test("narrow controls preserve selection and card rectangles replace compressed circle captions", () => {
  const snapshot = fixture(12), before = JSON.stringify(snapshot), ui = explorerDom(snapshot, { narrow: true });
  assert.equal(ui.ids.get("selection-tools").open, false); assert.equal(ui.ids.get("display-options").open, false);
  const selected = ui.ids.get("selection-count").textContent;
  ui.ids.get("selection-tools").open = true;
  assert.equal(ui.ids.get("selection-count").textContent, selected);
  assert.equal(explorerDom(snapshot).ids.get("selection-tools").open, true);
  assert.equal(JSON.stringify(snapshot), before);
  const nodes = ui.ids.get("graph").children.filter(element => element.getAttribute("data-node"));
  assert(nodes.length); assert(nodes.every(node => node.children.some(child => child.tagName === "foreignObject")));
  for (const node of nodes) { const rectangle = node.children[0]; assert.equal(rectangle.tagName, "rect"); assert(Number(rectangle.getAttribute("width")) >= 200); assert(Number(rectangle.getAttribute("height")) > 0); }
  const source = fs.readFileSync(new URL("../scripts/graph-explorer/browser.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /textLength|spacingAndGlyphs|svg\("circle"/);
});

test("explicit direct-neighbor map navigation keeps narrow cards readable, selection, pins and one-step camera history", async () => {
  const snapshot = fixture(3), original = JSON.stringify(snapshot), ui = explorerDom(snapshot, { narrow: true, cardMeasure: () => 100 });
  await ui.settle();
  const mapNode = id => ui.ids.get("graph").children.find(element => element.getAttribute("data-node") === id);
  const displaced = mapNode("generic-2"); assert(displaced);
  const position = /translate\(([^,]+),([^\)]+)\)/.exec(displaced.getAttribute("transform"));
  for (let i = 0; i < 50; i++) ui.event(displaced, "keydown", { shiftKey: true, key: "ArrowRight" });
  const targetPin = `translate(${Number(position[1]) + 1000},${Number(position[2])})`;
  ui.rectangle("graph", { left: 0, top: 0, width: 390, height: 440 }); ui.windowEvent("resize"); await ui.settle();
  ui.event("focus");
  ui.event(mapNode("generic-0"), "keydown", { shiftKey: true, key: "ArrowRight" });
  const pinned = mapNode("generic-0").getAttribute("transform");
  ui.event(ui.ids.get("records").children[1].children[0]);
  const camera = ui.ids.get("graph").getAttribute("viewBox"), rootCard = ui.ids.get("selection-cards").children[0];
  rootCard.open = true;
  const actions = rootCard.querySelectorAll("[data-map-neighbor]");
  const go = actions.find(control => control.getAttribute("data-map-neighbor") === "generic-2");
  assert(go, "Every exported direct endpoint needs an explicit Show on map action in its reading card");
  assert(!mapNode("generic-2"), "The exact linked record starts off-screen, not absent from the snapshot");
  ui.event(go); await ui.settle();
  assert.match(ui.ids.get("selection-count").textContent, /3/);
  const target = mapNode("generic-2"); assert(target);
  assert.equal(target.getAttribute("transform"), targetPin); assert.equal(target.dataset.pinned, "true");
  assert.equal(target.dataset.expanded, "false", "Navigation must not expand title-only cards");
  assert.equal(ui.ids.get("graph").getAttribute("viewBox").split(" ").slice(2).join(" "), "390 440", "Center at readable 1:1 scale, never whole-map fit");
  assert.equal(ui.stats.focused, "generic-2"); assert.equal(ui.stats.scrolled, target, "Scroll the actual target, not the start of a tall mobile map");
  assert(rootCard.open); assert.equal(ui.ids.get("selection-cards").children[0], rootCard);
  const reached = ui.ids.get("graph").getAttribute("viewBox");
  ui.event("back"); assert.equal(ui.ids.get("graph").getAttribute("viewBox"), camera);
  assert.match(ui.ids.get("selection-count").textContent, /2/); assert.equal(mapNode("generic-0").getAttribute("transform"), pinned);
  ui.event("forward"); assert.equal(ui.ids.get("graph").getAttribute("viewBox"), reached);
  assert.match(ui.ids.get("selection-count").textContent, /3/);
  const endpoint = ui.ids.get("relations").children.flatMap(row => row.children).find(control => control.getAttribute("data-map-neighbor") === "generic-0");
  assert(endpoint, "The focused inspector offers the same exact-endpoint navigation"); ui.event(endpoint);
  assert.equal(mapNode("generic-0").getAttribute("transform"), pinned); assert.equal(mapNode("generic-0").dataset.pinned, "true");
  assert.equal(JSON.stringify(snapshot), original);
});

test("direct connection gestures stay exactly one hop and high-degree cancel preserves readable state", async t => {
  const snapshot = fixture(1500); snapshot.graph.edges = [
    { edgeId: "first", from: "generic-0", to: "generic-1", type: "NEXT" },
    ...snapshot.graph.nodes.slice(2, -1).map(node => ({ edgeId: node.nodeId, from: "generic-1", to: node.nodeId, type: "NEXT" })),
    { edgeId: "second-hop", from: "generic-2", to: "generic-1499", type: "NEXT" }];
  const before = JSON.stringify(snapshot), ui = explorerDom(snapshot, { cardMeasure: () => 100 }); await ui.settle();
  const mapNode = id => ui.ids.get("graph").children.find(el => el.getAttribute("data-node") === id);
  ui.event(mapNode("generic-0"), "keydown", { shiftKey: true, key: "ArrowRight" });
  const pinned = mapNode("generic-0").getAttribute("transform"), initialCamera = ui.ids.get("graph").getAttribute("viewBox");
  // Read keeps the camera; explicit direct expansion may center a readable card.
  ui.event(ui.ids.get("records").children[1].children[0]); assert.equal(ui.ids.get("graph").getAttribute("viewBox"), initialCamera);
  ui.event("expand-direct"); ui.event("cancel-work"); await ui.settle();
  assert.match(ui.ids.get("operation-status").textContent, /Cancelled/); assert.equal(mapNode("generic-0").getAttribute("transform"), pinned);
  const created = ui.stats.created, at = performance.now();
  ui.event(mapNode("generic-1"), "dblclick");
  ui.event("graph", "keydown", { key: "ArrowRight" }); ui.event("zoom-out");
  const newerCamera = ui.ids.get("graph").getAttribute("viewBox"); await ui.settle();
  assert.equal(ui.ids.get("graph").getAttribute("viewBox"), newerCamera, "Direct completion must not overwrite newer pan/zoom input");
  assert.match(ui.ids.get("operation-status").textContent, /1498 exact direct relationships/);
  assert(!/1499 neighboring/.test(ui.ids.get("operation-status").textContent));
  assert.equal(mapNode("generic-0").getAttribute("transform"), pinned); assert.equal(mapNode("generic-0").dataset.pinned, "true");
  assert(ui.ids.get("records").children.length <= 100); assert(ui.ids.get("relations").children.length <= 100);
  ui.event("expand-direct"); await ui.settle();
  const expandedCamera = ui.ids.get("graph").getAttribute("viewBox");
  ui.event("back"); assert.equal(ui.ids.get("graph").getAttribute("viewBox"), newerCamera);
  ui.event("forward"); assert.equal(ui.ids.get("graph").getAttribute("viewBox"), expandedCamera);
  ui.event(mapNode("generic-1"), "keydown", { shiftKey: true, key: "Enter" }); await ui.settle();
  assert.match(ui.ids.get("operation-status").textContent, /1498 exact direct relationships/);
  assert.equal(JSON.stringify(snapshot), before);
  t.diagnostic(JSON.stringify({ model: "DOM-double-not-browser-speed", nodes: snapshot.graph.nodes.length, edges: snapshot.graph.edges.length,
    elapsedMs: performance.now() - at, createdElements: ui.stats.created - created, queuedFrames: ui.pendingFrames() }));
});

test("missing current source displays exact retained text without manufacturing an empty after-version", () => {
  const snapshot = fixture(12), digest = "a".repeat(64);
  snapshot.graph.contextLineage = { events: [], recordedReasons: [], canonChanges: [], files: [{ path: "src/generic-0.mjs",
    currentObservation: { reasonCode: "ENOENT", explanation: "Current path not found; deletion and rename remain unproven." }, associations: [],
    renameEvidence: { candidates: [{ path: "src/moved.mjs", digest }] }, comparisons: [{ status: "unknown", after: null,
      citedReference: { path: "src/generic-0.mjs", digest }, retainedOriginal: { path: "src/generic-0.mjs", digest,
        text: "retained <script>not executable</script>", omittedLines: 12, textTruncated: false } }], unrecordedIntervals: "Unknown" }] };
  const before = JSON.stringify(snapshot), ui = explorerDom(snapshot), body = ui.ids.get("context-lineage-body").textContent;
  assert(body.includes("retained <script>not executable</script>")); assert(body.includes("not an after-version"));
  assert(body.includes("Partial historical excerpt")); assert(body.includes("not confirmed continuity"));
  assert(!body.includes("No byte differences")); assert.equal(ui.ids.get("show-code-diff").hidden, true);
  assert.equal(JSON.stringify(snapshot), before);
});

function fixture(count = 60000) {
  const historicalStart = count >= 5000 ? count - 5000 : count;
  const nodes = Array.from({ length: count }, (_, i) => ({ nodeId: `generic-${i}`, kind: "File", path: `src/generic-${i}.mjs`, name: `Generic ${i}`,
    views: ["work"], freshness: i >= historicalStart ? "domain-not-current" : "snapshot-evidence", currentTraversalEligible: i < historicalStart,
    detailCoverage: i ? "metadata-only" : "selected-detail", sourceReference: { path: `src/generic-${i}.mjs`, digest: "a".repeat(64) } }));
  const edges = nodes.slice(1).map((node, i) => ({ edgeId: `edge-${i}`, from: nodes[i].nodeId, to: node.nodeId, type: "NEXT" }));
  for (let i = 1; i <= Math.min(10000, count - 1); i++) edges.push({ edgeId: `star-${i}`, from: "generic-0", to: `generic-${i}`, type: "LINK" });
  return { kind: "GraphExplorerSnapshot", project: { projectId: "synthetic" }, generatedAt: "2026-10-21T00:00:00.000Z",
    graph: { nodes, edges, initialNodeId: "generic-0", coverage: { state: "verified-available-layers" }, contextLineage: null },
    codeGraph: { nodes: [], edges: [], status: "unavailable" }, originals: {}, history: { status: "not-requested", entries: [] } };
}

function assertExploredOverview(ui, snapshot) {
  const status = ui.ids.get("status").textContent;
  assert.match(status, /^Explored evidence overview:/);
  assert(status.includes(`${snapshot.graph.nodes.length} filtered records`));
  assert(status.includes(`${snapshot.graph.edges.length} shown / ${snapshot.graph.edges.length} exported relationships`));
  assert(status.includes(`${snapshot.graph.nodes.length} total exported records`));
  assert.equal(ui.ids.get("overview").hidden, false); assert.equal(ui.ids.get("graph").hidden, true);
  assert(!ui.ids.get("expand").disabled, "Completing a whole fit must not gate further exploration");
}

test("actual bundled UI script reaches all 60000 IDs through complete search/overview, with bounded DOM and explicit historical scope", async t => {
  const snapshot = fixture(), before = JSON.stringify(snapshot), ui = explorerDom(snapshot, { cardMeasure: () => 220 });
  assert.equal(ui.document.documentElement.dataset.explorerReady, "true");
  assert(ui.ids.get("selected-title").textContent.includes("Generic 0"));
  assert(ui.ids.get("records").children.length <= 100); assert(ui.ids.get("relations").children.length <= 100);
  assert(ui.stats.svg < 1000, "Initial 10000-neighbor selection must not create an all-inventory SVG DOM");
  assert(ui.ids.get("status").textContent.includes("off-screen"));
  ui.event("records-next"); assert(ui.ids.get("records").children[0].textContent.includes("Generic 100"));
  ui.ids.get("search").value = "generic-59999"; ui.event("search", "input");
  assert.equal(ui.ids.get("records").children.length, 0);
  ui.ids.get("include-history").checked = true; ui.event("include-history", "change");
  assert(ui.ids.get("records").children.length > 0);
  ui.event(ui.ids.get("records").children[0].children[0]);
  assert(ui.ids.get("selected-title").textContent.includes("59999")); assert(ui.ids.get("detail-scope").textContent.includes("does not mean no change"));
  ui.ids.get("search").value = ""; ui.event("search", "input");
  const fills = ui.stats.fills; ui.event("overview-button");
  assert.equal(ui.stats.fills - fills, 60000); assert(ui.ids.get("status").textContent.includes("60000 filtered records"));
  assert.equal(ui.ids.get("graph").hidden, true); assert.equal(ui.ids.get("overview").hidden, false);
  ui.event("focus"); assert.equal(ui.ids.get("graph").hidden, false); await ui.settle();
  const svg = ui.stats.svg; ui.event("graph", "wheel", { deltaY: 1 }); ui.event("graph", "wheel", { deltaY: 1 });
  assert.equal(ui.pendingFrames(), 1); ui.flush(); assert(ui.stats.svg > svg);
  await ui.settle();
  assert(Number(ui.document.documentElement.dataset.explorerCardMeasures) < 10, "Untouched 60000 metadata bodies must not be premeasured");
  assert.equal(JSON.stringify(snapshot), before);
  t.diagnostic(JSON.stringify({ scope: "Node VM + limited DOM/Canvas double; not actual browser or GUI", initialMs: ui.initialMs, svgCreated: ui.stats.svg }));
});

test("1000-plus initial neighbors prepare only a first-screen batch, cancel atomically before commit, and remain accessible for explicit placement", async () => {
  const snapshot = fixture(1100), ui = explorerDom(snapshot, { cardMeasure: (_element, size) => 220 * size / 14 });
  assert.match(ui.ids.get("status").textContent, /1097 positions not prepared/); assert(!ui.ids.get("expand").disabled);
  const root = () => ui.ids.get("graph").children.find(element => element.getAttribute("data-node") === "generic-0");
  const transform = root().getAttribute("transform"), camera = ui.ids.get("graph").getAttribute("viewBox");
  ui.frame(); await Promise.resolve(); assert.equal(Number(ui.document.documentElement.dataset.explorerCardMeasures), 15, "3 initial cards + viewport-derived 12-card batch, not every hub neighbor");
  assert(!ui.ids.get("cancel-work").disabled, "First-screen batch yields before committing, so cancellation can still discard every staged position");
  ui.event("cancel-work"); await ui.settle();
  assert.match(ui.ids.get("status").textContent, /1097 positions not prepared/); assert.match(ui.ids.get("operation-status").textContent, /Cancelled neighbor.*not a completed layout/);
  assert.equal(root().getAttribute("transform"), transform); assert.equal(ui.ids.get("graph").getAttribute("viewBox"), camera);
  ui.ids.get("search").value = "generic-1099"; ui.event("search", "input"); assert.equal(ui.ids.get("records").children.length, 1);
  ui.event(ui.ids.get("records").children[0].children[0]); ui.event("focus"); await ui.settle();
  assert(ui.ids.get("graph").children.some(element => element.getAttribute("data-node") === "generic-1099"));
  ui.event("reset"); await ui.settle(); assertExploredOverview(ui, snapshot);
  ui.event(ui.ids.get("records").children[0].children[0]); ui.event("focus"); await ui.settle();
  assert(ui.ids.get("graph").children.some(element => element.getAttribute("data-node") === "generic-1099"), "Exact late record remains readable after the Canvas fit, without all-card placement");
  ui.ids.get("search").value = '"generic-0"'; ui.event("search", "input"); ui.event(ui.ids.get("records").children[0].children[0]);
  ui.event("restart"); assert.match(ui.ids.get("operation-status").textContent, /Preparing/);
  ui.frame(); await Promise.resolve();
  ui.ids.get("layer").value = "code"; ui.event("layer", "change"); await ui.settle();
  assert(!ui.ids.get("graph").children.some(element => element.getAttribute("data-node"))); assert(ui.ids.get("cancel-work").disabled);
  assert(!/Preparing/.test(ui.ids.get("operation-status").textContent));
});

test("font changes during initial measurement cannot commit mixed-basis positions or impersonate completed preparation", async () => {
  const snapshot = fixture(1100), before = JSON.stringify(snapshot), ui = explorerDom(snapshot, { cardMeasure: (_element, size) => 220 * size / 14 });
  const root = () => ui.ids.get("graph").children.find(element => element.getAttribute("data-node") === "generic-0");
  ui.event(root(), "keydown", { shiftKey: true, key: "ArrowRight" }); const pin = root().getAttribute("transform"), camera = ui.ids.get("graph").getAttribute("viewBox");
  ui.frame(); await Promise.resolve(); ui.setModeledFontSize(28); ui.windowEvent("resize"); await ui.settle();
  assert.match(ui.ids.get("status").textContent, /1097 positions not prepared/); assert.equal(root().getAttribute("transform"), pin);
  assert.equal(ui.ids.get("graph").getAttribute("viewBox"), camera); assert(ui.ids.get("cancel-work").disabled);
  assert(!/Direct-neighbor positions prepared/.test(ui.ids.get("operation-status").textContent));
  ui.event("reset"); await ui.settle(); assertExploredOverview(ui, snapshot);
  ui.event("focus"); await ui.settle(); assert.equal(root().getAttribute("transform"), pin);
  assert.equal(JSON.stringify(snapshot), before);
});

test("a retained non-current relationship is labelled before selection and opt-in preserves its exact endpoint", () => {
  const snapshot = fixture(12);
  snapshot.graph.edges[3].currentTraversalEligible = false;
  snapshot.graph.edges[3].viewerCurrentness = "domain-not-current";
  snapshot.graph.edges[3].from = "generic-0";
  const ui = explorerDom(snapshot), rows = ui.ids.get("relations").children;
  const row = rows.find(item => item.textContent.includes("Generic 4") && item.textContent.includes("NEXT"));
  assert(row); assert(row.textContent.includes("Historical / non-current"));
  ui.event(row.children[0]); assert.equal(ui.ids.get("include-history").checked, true);
  assert(ui.ids.get("selected-title").textContent.includes("Generic 4"));
});

test("exact bounded excerpt UI shows additions/removals, line roles and missing detail honestly", () => {
  const snapshot = fixture(12);
  snapshot.graph.contextLineage = { events: [], recordedReasons: [], canonChanges: [], files: [{ path: "src/generic-0.mjs", current: { digest: "a".repeat(64) }, associations: [{ nodeId: "generic-0" }],
    comparisons: [{ status: "verified", scope: "recorded-changeset-snapshot-pair", before: { digest: "a".repeat(64) }, after: { digest: "b".repeat(64) }, currentMatchesRecordedAfter: false, symbols: [], diff: { changed: true,
      before: { startLine: 10, text: "same\nold", omittedLines: 20 }, after: { startLine: 20, text: "same\nnew", textTruncated: true } } }], unrecordedIntervals: "Unknown unsaved work" }] };
  const ui = explorerDom(snapshot), body = ui.ids.get("context-lineage-body").textContent;
  assert(body.includes("− 11/· old")); assert(body.includes("+ ·/21 new"));
  assert(body.includes("Recorded after — not necessarily current")); assert(body.includes("Partial comparison excerpt"));
  assert.equal(ui.ids.get("show-code-diff").hidden, false);
  ui.event("show-code-diff"); assert.equal(ui.ids.get("context-lineage").open, true);
});

test("modeled font/width changes preserve camera, pins and keyed reading state through cancel after measured first placement", async t => {
  const snapshot = fixture(80), before = JSON.stringify(snapshot);
  const ui = explorerDom(snapshot, { cardMeasure: (element, size) => 210 * size / 14 + Math.ceil(element.textContent.length / Math.max(1, parseFloat(element.style.width))) * 18 });
  assert.equal(Number(ui.document.documentElement.dataset.explorerCardMeasures), 3, "Only the starting cards are measured synchronously");
  assert.match(ui.ids.get("operation-status").textContent, /Preparing.*direct-neighbor/); assert(!ui.ids.get("expand").disabled);
  await ui.settle();
  const mapNode = () => ui.ids.get("graph").children.find(element => element.getAttribute("data-node") === "generic-0");
  const root = mapNode(), read = ui.ids.get("selection-cards").children[0], detail = read.children.find(item => item.tagName === "details"); read.open = true; detail.open = true;
  ui.event(root, "keydown", { shiftKey: true, key: "ArrowRight" }); await ui.settle();
  const pin = mapNode().getAttribute("transform"), camera = ui.ids.get("graph").getAttribute("viewBox"), height = Number(mapNode().children[0].getAttribute("height"));
  assert.equal(Number(ui.document.documentElement.dataset.explorerCardMeasures), 15, "Every first-screen neighbor has its actual extent; 65 offscreen neighbors remain on demand");
  assert.match(ui.ids.get("status").textContent, /65 positions not prepared/);
  assert.match(ui.ids.get("operation-status").textContent, /65 further positions remain on demand/);
  ui.setModeledFontSize(28); ui.windowEvent("resize"); ui.frame();
  assert.match(ui.ids.get("operation-status").textContent, /Measuring changed/);
  ui.event("cancel-work"); await ui.settle();
  assert.equal(mapNode().getAttribute("transform"), pin); assert.equal(Number(mapNode().children[0].getAttribute("height")), height);
  assert.equal(ui.ids.get("graph").getAttribute("viewBox"), camera); assert(detail.open); assert.equal(ui.ids.get("selection-cards").children[0], read);
  ui.finishModeledFonts(); await ui.settle();
  assert(Number(mapNode().children[0].getAttribute("height")) > height * 1.5);
  assert.equal(mapNode().getAttribute("transform"), pin); assert.equal(ui.ids.get("graph").getAttribute("viewBox"), camera); assert(detail.open);
  ui.rectangle("graph", { left: 0, top: 0, width: 260, height: 700 }); ui.windowEvent("resize"); await ui.settle();
  assert.equal(Number(mapNode().children[0].getAttribute("width")), 220); assert.equal(mapNode().getAttribute("transform"), pin);
  assert.equal(JSON.stringify(snapshot), before);
  t.diagnostic("Font/width and layout measurements above are an explicit model, NOT actual browser, mobile, 200% text or font-load acceptance.");
});

test("pending automatic measurements do not cancel a user expansion and newer font changes do not leave a busy calculation stuck", async () => {
  const snapshot = fixture(1100); snapshot.graph.edges = [{ edgeId: "start", from: "generic-0", to: "generic-1", type: "LINK" },
    ...snapshot.graph.nodes.slice(2).map(node => ({ edgeId: `child-${node.nodeId}`, from: "generic-1", to: node.nodeId, type: "LINK" }))];
  const ui = explorerDom(snapshot, { cardMeasure: (_element, size) => 220 * size / 14 });
  ui.event("expand"); await ui.settle();
  assert.match(ui.ids.get("trail").textContent, /Expand 1098/); assert(ui.ids.get("cancel-work").disabled);
  ui.setModeledFontSize(30); ui.windowEvent("resize"); ui.frame(); ui.setModeledFontSize(32); ui.windowEvent("resize"); await ui.settle();
  assert(ui.ids.get("cancel-work").disabled); assert(!/Calculation failed/.test(ui.ids.get("operation-status").textContent));
  assert.equal(ui.pendingFrames(), 0);
});

test("first reading of a previously off-screen tall card cannot re-place it or previously read cards at unchanged metrics", async () => {
  const snapshot = fixture(80), ui = explorerDom(snapshot, { cardMeasure: element => Number(/Generic (\d+)/.exec(element.textContent)?.[1]) < 3 ? 210 : 900 });
  await ui.settle();
  ui.ids.get("search").value = "generic-10"; ui.event("search", "input"); ui.event(ui.ids.get("records").children[0].children[0]); ui.event("focus");
  const card = () => ui.ids.get("graph").children.find(element => element.getAttribute("data-node") === "generic-10");
  const position = card()?.getAttribute("transform"), camera = ui.ids.get("graph").getAttribute("viewBox"); assert(position);
  const measures = ui.document.documentElement.dataset.explorerCardMeasures;
  await ui.settle(); assert.equal(card()?.getAttribute("transform"), position); assert.equal(ui.ids.get("graph").getAttribute("viewBox"), camera);
  ui.event("zoom-out"); ui.flush(); ui.event("zoom-in"); ui.flush();
  assert.equal(ui.document.documentElement.dataset.explorerCardMeasures, measures, "Normal focus/zoom cannot invalidate committed extents");
});

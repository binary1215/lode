import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { explorerCodec } from "../graph-explorer/codec.js";

export function renderGraphExplorer(snapshot) {
  const nonce = crypto.randomBytes(24).toString("base64");
  const assets = path.resolve(import.meta.dirname, "../graph-explorer");
  const css = fs.readFileSync(path.join(assets, "style.css"), "utf8");
  const codec = fs.readFileSync(path.join(assets, "codec.js"), "utf8").replace(/^export const explorerCodec =/m, "const explorerCodec =");
  const script = codec + "\n" + ["cards.js", "exploration.js", "product-perspectives.js", "browser.js"].map(file => fs.readFileSync(path.join(assets, file), "utf8")).join("\n");
  const json = JSON.stringify(explorerCodec.encode(snapshot)).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'none'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'">
<title>Lode Graph Explorer</title><style nonce="${nonce}">${css}</style></head><body>
<header><div><span class="eyebrow">LODE / LOCAL EVIDENCE</span><h1>Graph Explorer</h1><p id="project"></p></div><div class="snapshot"><strong>Read-only snapshot</strong><span id="generated"></span><span id="coverage"></span></div></header>
<details class="report-disclosure"><summary>Read-only local report · originals may contain sensitive content</summary><p class="hint" id="report-notice">HTML size: __LODE_REPORT_BYTE_COUNT__ bytes. Large reports can take substantial browser memory and time; no node/edge cutoff is applied. ${snapshot.metadataPolicy?.mode === "share-generated-metadata" ? "Shared-report mode omits generated local execution/project paths only. " : "Local report includes generated machine paths. "}Original evidence may contain sensitive paths or content. This is not anonymization.</p></details>
<main><aside class="controls" aria-label="Graph controls"><label for="search">Search all exported metadata</label><input id="search" type="search" placeholder="Name, exact ID, source, decision…">
<label class="check"><input id="hide-nonmatches" type="checkbox"> Hide nonmatches (selection stays)</label>
<details id="display-options" open><summary>Evidence scope &amp; display</summary>
<label for="layer">Evidence layer</label><select id="layer"><option value="project">Project purpose &amp; lineage</option><option value="code">Source imports &amp; calls</option></select>
<p id="layer-info" class="hint"></p>
<label for="axis">Show</label><select id="axis"><option value="all">All connections</option><option value="code">Code &amp; sources</option><option value="context">Purpose &amp; work</option></select>
<label for="view">Original graph view</label><select id="view"><option value="all">Both views</option><option value="product">Product</option><option value="work">Work</option></select>
<label class="check"><input id="include-history" type="checkbox"> Include historical / non-current evidence</label>
<label for="relation-filter">Relationship scope</label><select id="relation-filter"><option value="all">All relationship types</option></select>
<label for="kind-filter">Add / connect these records</label><select id="kind-filter"><option value="all">All record kinds</option><option value="code">Code &amp; sources</option><option value="judgment">Judgments &amp; direction</option><option value="execution">Execution &amp; results</option></select>
</details><p class="hint">Current evidence first. Historical records remain available, not current permission.</p></aside>
<section class="canvas-section" aria-label="Graph map"><div class="toolbar"><div class="legend"><span id="legend-left" class="code-dot">Code &amp; sources</span><span id="legend-right" class="context-dot">Purpose &amp; work</span></div><div><button id="back" aria-label="Previous explored record">←</button><button id="forward" aria-label="Next explored record">→</button><button id="zoom-out" aria-label="Zoom out">−</button><button id="zoom-in" aria-label="Zoom in">+</button><button id="focus">Focus selection</button><button id="reset">Explored map</button><button id="overview-button">All evidence</button><button id="restart">Start here</button></div></div>
<nav id="trail" aria-label="Exploration path"></nav><div class="reading-jump"><button id="jump-reading">Read selection ↓</button><button id="jump-diff">Recorded code changes ↓</button></div>
<details id="selection-tools" class="selection-tools" open><summary>Selection tools · <span id="selection-count" role="status"></span></summary><div class="selection-toolbar"><button id="clear-selection">Clear selection</button><button id="only-focus">Select only focus</button><button id="restore-scope">Show selected scope</button><label class="check"><input id="rectangle-mode" type="checkbox"> Rectangle select</label></div></details>
<svg id="graph" viewBox="0 0 1000 700" role="group" tabindex="0" aria-label="Evidence connections. Select records with Enter; pan the canvas with arrow keys."></svg>
<canvas id="overview" width="1000" height="700" hidden role="group" tabindex="0" aria-label="All filtered exported metadata and actual relationships. Pan with arrow keys. Select a point or use the complete searchable record list."></canvas>
<svg id="selection-box" hidden aria-hidden="true"><rect id="selection-rect" x="0" y="0" width="0" height="0"></rect></svg>
<p id="overview-note" class="hint canvas-note" hidden>Evidence overview. Direction, parallel relationships and readable labels are available after selecting a record. Layout is not meaning or authority.</p>
<div id="status" role="status" aria-live="polite"></div><p class="hint canvas-note">Overview stays compact. Focused map cards and selected records show short source excerpts and status; + opens longer details independently. In a reading card's actual relationships, Show on map centers one connected record at readable size without fitting the whole map or clearing selection. Headers select or drag to pin; Ctrl/Cmd, checkbox or Space toggles selection. Expanded body text selects and scrolls normally. Shift + background drag selects intersecting cards; background drag pans. Code ↔ · purpose/product/operations ↕ are display guides, not authority.</p></section>
<section class="records-panel" aria-label="Complete searchable metadata"><h2>All exported records</h2><p id="count" class="hint"></p><p id="inventory-gaps" class="hint"></p><ul id="records" aria-label="Exported graph records"></ul><nav class="list-pages" aria-label="Record pages"><button id="records-prev">Previous page</button><button id="records-next">Next page</button></nav></section>
<section class="detail" aria-label="Read selected evidence together"><h2 id="reading-heading" tabindex="-1">Read selected records</h2><div class="reading-actions"><button id="jump-map">Back to map ↑</button><button id="wide-reading" aria-pressed="false">Widen reading area</button></div>
<div class="reading-actions"><button id="expand-direct" disabled>Open direct connections</button><button id="expand" disabled>Expand next boundary</button><button id="collapse">Fold last addition</button><button id="connect-selection">Show selected connections</button><button id="cancel-work" disabled>Cancel calculation</button></div>
<p id="operation-status" role="status" class="hint"></p><p id="connection-status" class="hint"></p><ul id="connection-roots"></ul><nav class="list-pages"><button id="roots-prev">Previous references</button><button id="roots-next">Next references</button></nav><p id="reading-range" class="hint"></p>
<section id="feature-perspectives" hidden aria-label="Same Feature evidence perspectives"><h3 id="feature-title"></h3><p id="feature-identity" class="hint"></p><nav class="reading-actions" aria-label="Feature perspectives"><button id="feature-structure" aria-pressed="true">Structure</button><button id="feature-work" aria-pressed="false">Recorded work</button><button id="feature-changes" aria-pressed="false">Changes &amp; related impact</button></nav><p id="feature-range" class="hint" role="status"></p><div id="feature-body"></div><nav class="list-pages" aria-label="Feature evidence pages"><button id="feature-first">First evidence</button><button id="feature-prev">Previous evidence</button><button id="feature-next">Next evidence</button><button id="feature-last">Last evidence</button></nav></section>
<div id="selection-cards" class="selection-cards"></div><nav class="list-pages"><button id="cards-prev">Previous records</button><button id="cards-next">Next records</button></nav>
<button id="show-code-diff" hidden>Show recorded code changes</button>
<details id="focus-inspector"><summary>Focused record — full details and diagnostics</summary><h2 id="selected-title" tabindex="-1">Follow a connection</h2><p id="selected-caption" class="hint">Select a record or relationship to see its exact reference.</p><div id="selected-summary"></div><p id="detail-scope" class="hint"></p><p id="expansion" class="hint"></p>
<details><summary>Exact original</summary><p id="original-state" class="hint"></p><pre id="original">Select a record to inspect retained text.</pre><details id="raw-original-details" hidden><summary>Raw original / unknown fields</summary><pre id="raw-original"></pre></details></details>
<details><summary>Record identity &amp; evidence</summary><pre id="evidence">No record selected.</pre></details>
</details><details id="context-lineage" hidden><summary>Recorded code context</summary><h3>Selected changes &amp; file comparisons</h3>
<p class="hint">Recorded pairs only; bounded excerpts, not a full Git or semantic diff. Export-observed current is not live. Unknowns and exact source provenance stay with each comparison.</p>
<nav class="reading-actions"><button id="file-prev">Previous file</button><button id="file-next">Next file</button><button id="change-prev">Previous changed region</button><button id="change-next">Next changed region</button></nav><p id="comparison-position" role="status" class="hint"></p><ul id="comparison-files"></ul><div id="context-lineage-body"></div></details>
<details><summary>Snapshot basis &amp; omissions (diagnostics)</summary><pre id="basis"></pre></details><details id="history"><summary>Retained graph structure (diagnostics)</summary><div id="history-body"></div></details></section></main>
<footer>Double-click a map title, press Shift+Enter on its card, or use Open direct connections for exact one-hop exploration. Read alone keeps the camera. This file has no runtime fetch, server or action controls. Selecting a historical Session changes this display only. New work and recovery remain in your normal Lode conversation.</footer>
<script nonce="${nonce}" id="snapshot" type="application/json">${json}</script><script nonce="${nonce}">${script}</script></body></html>\n`;
  // Include the exact UTF-8 file size, including this decimal field. It is an
  // advisory, never an export limit; convergence only depends on digit count.
  let bytes = 0;
  for (;;) {
    const result = html.replace("__LODE_REPORT_BYTE_COUNT__", String(bytes));
    const actual = Buffer.byteLength(result);
    if (actual === bytes) return result;
    bytes = actual;
  }
}

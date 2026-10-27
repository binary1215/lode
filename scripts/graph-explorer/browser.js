(() => {
  "use strict";
  const initialTime = performance.now();
  let data;
  try {
    data = explorerCodec.decode(JSON.parse(document.getElementById("snapshot").textContent));
    if (data?.kind !== "GraphExplorerSnapshot" || !Array.isArray(data.graph?.nodes) || !Array.isArray(data.graph?.edges)) throw new Error("Invalid snapshot");
  }
  catch { document.getElementById("status").textContent = "Snapshot data could not be decoded. Original records were not changed; regenerate this optional report."; return; }
  const $ = id => document.getElementById(id), ns = "http://www.w3.org/2000/svg";
  const hide = (element, value) => { element.hidden = value; if (value) element.setAttribute("hidden", ""); else element.removeAttribute("hidden"); };
  let activeGraph = data.initialLayer === "code" ? data.codeGraph : data.graph, selected = null;
  $("layer").value = activeGraph === data.graph ? "project" : "code";
  let box = [0, 0, 1000, 700], drag = null, suppressClick = false;
  let cameraIntent = 0;
  const layerStates = new Map();
  let contextSelection = null;
  let mapMode = "focus", listPage = 0, relationPage = 0, relationSelection = null, foundIds = new Set(), visibleMatches = [], cameraFrame = null;
  const canvasMode = () => mapMode === "overview" || mapMode === "explored-overview";
  const overviewStates = new WeakMap(), PAGE_SIZE = 100;
  let chosenEdges = new Set(), edgeVersion = 0, cardPage = 0, viewHistory = [], viewCursor = -1;
  let scopeCache = null, cardsCache = null, comparisonsCache = null, connectionResult = null, connectionKey = null;
  let jobSerial = 0, busy = false, jobKind = null, drawnNodeIds = new Set(), comparisonFiles = [], changeHunks = [], fileCursor = 0, changeCursor = -1, rootPage = 0;
  const historyCounts = new WeakMap(), edgeKeys = new WeakMap();
  const comparisonStates = new WeakMap();
  const documentPanels = new WeakMap();
  const comparisonFileNavigation = new WeakMap();
  let comparisonGraph = null, comparisonNavigationSerial = 0;
  const filterIds = ["search", "hide-nonmatches", "axis", "view", "include-history", "relation-filter", "kind-filter"];
  // Yield to input without paying a whole display frame for every 512 edges.
  // The first paint/disclosure still uses requestAnimationFrame separately.
  const yieldWork = () => typeof globalThis.scheduler?.yield === "function" ? globalThis.scheduler.yield() : new Promise(resolve => requestAnimationFrame(resolve));
  const label = node => displayText(explorerCards.title(node));
  const isCode = node => $("layer").value === "code" || /^(File|Symbol|Source|Directory|Dependency|ExternalDependency)/.test(node.kind || "");
  const relation = edge => {
    const code = edge.type || edge.relation;
    return displayText(({ CITES_EXACT_REVISION: "Mentioned source version", CITES_WORK_EVIDENCE: "Cited work record", CITES_ARTIFACT: "Cited original document (not every contained decision)", DECLARES_WORK_ROOT: "Declared work starting point",
      FOLLOWS_WORK_EVIDENCE: "Previous work record", RECORDED_RESULT: "Recorded result", RECORDED_REVIEW: "Recorded review",
      OBSERVES_BEFORE_REVISION: "Recorded before revision", OBSERVES_AFTER_REVISION: "Recorded after revision",
      REFERS_TO_PREVIOUS_CANON: "Previous recorded Canon", REFERS_TO_BASE_CANON: "Base recorded Canon", REFERS_TO_RESULT_CANON: "Resulting recorded Canon",
      CALLS: "Calls", IMPORTS: "Imports" })[code] || code || "Relationship");
  };
  const key = reference => JSON.stringify([reference?.path || null, reference?.digest || null]);
  const displayText = value => String(value ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const text = (tag, value, className) => { const el = document.createElement(tag); el.textContent = displayText(value); if (className) el.className = className; return el; };
  const button = (value, action) => { const el = text("button", value); el.type = "button"; el.addEventListener("click", action); return el; };
  const svg = (tag, attributes) => { const el = document.createElementNS(ns, tag); for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, displayText(value)); return el; };
  const graphemes = typeof Intl?.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
  const shorten = (value, length) => {
    let result = "", count = 0;
    for (const part of graphemes ? graphemes.segment(String(value)) : Array.from(String(value))) { if (count++ === length) return result + "…"; result += part.segment ?? part; }
    return result;
  };
  const measure = document.createElement("canvas").getContext("2d");
  const measuredExtents = new WeakMap();
  const cardIndexes = new WeakMap(), mapCaches = new WeakMap(), readingStates = new WeakMap(), modelMetrics = new WeakMap();
  const mapOpenStates = new WeakMap(), mapDisclosures = new WeakMap(), mapScrollStates = new WeakMap();
  const suppressedMetrics = new WeakMap();
  let fontEpoch = 0, metricFrame = null;
  function cardIndex(graph = activeGraph) {
    if (!cardIndexes.has(graph)) cardIndexes.set(graph, explorerCards.create(data, graph, graph === data.graph ? "project" : "code"));
    return cardIndexes.get(graph);
  }
  function metrics() {
    const root = typeof getComputedStyle === "function" ? getComputedStyle(document.documentElement) : null;
    const size = parseFloat(root?.fontSize) || 14, width = Math.min(288, Math.max(200, ($("graph").clientWidth || 1000) - 40));
    const viewportHeight = globalThis.innerHeight || document.documentElement.clientHeight || $("graph").clientHeight || 700;
    return { size, width, key: JSON.stringify([size, width, viewportHeight, root?.fontFamily || "system-ui", fontEpoch]) };
  }
  function openedMap(graph = activeGraph) {
    if (!mapOpenStates.has(graph)) mapOpenStates.set(graph, new Set()); return mapOpenStates.get(graph);
  }
  function mapScroll(graph = activeGraph) {
    if (!mapScrollStates.has(graph)) mapScrollStates.set(graph, new Map()); return mapScrollStates.get(graph);
  }
  function mapContent(descriptor, expanded = false, toggle = () => {}, read = () => {}) {
    const body = text("div", "", "map-card"), header = text("div", "", "map-card-header");
    header.setAttribute("data-card-header", "");
    const control = button(expanded ? "−" : "+", event => { event.stopPropagation(); toggle(); });
    control.setAttribute("data-card-control", ""); control.setAttribute("aria-expanded", String(expanded));
    control.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} details: ${descriptor.title}`);
    header.append(text("h3", descriptor.title, "map-card-title"), control);
    const content = text("div", "", "map-card-body"); content.setAttribute("data-card-body", "");
    content.append(text("p", descriptor.kind, "map-card-kind"));
    content.append(text("p", descriptor.preview ? shorten(descriptor.preview, 420) : descriptor.emptyNotice, "map-card-excerpt"));
    if (descriptor.conditions.length) content.append(text("p", descriptor.conditions.join(" · "), "map-card-conditions"));
    if (descriptor.groups.length) content.append(text("p", descriptor.groups.slice(0, 2).map(group => `${group.type}: ${group.title}`).join(" · ")
      + (descriptor.groups.length > 2 ? ` · +${descriptor.groups.length - 2} memberships in the reading card` : ""), "map-card-memberships"));
    if (descriptor.source) content.append(text("p", descriptor.source, "map-card-source"));
    if (descriptor.excerptNotice) content.append(text("p", descriptor.excerptNotice, "map-card-notice"));
    const full = button("Read full record", event => { event.stopPropagation(); read(); }); full.setAttribute("data-card-control", ""); content.append(full);
    hide(content, !expanded);
    body.append(header, content); return body;
  }
  const textWidth = (value, size) => {
    if (!measure) return Array.from(value).length * size;
    measure.font = `${size}px system-ui, sans-serif`; return measure.measureText(value).width;
  };
  function nodeExtent(node, graph = activeGraph) {
    const basis = metrics(), cached = measuredExtents.get(node), expanded = mapDisclosures.get(graph)?.get(node.nodeId) ?? openedMap(graph).has(node.nodeId);
    const measurementKey = JSON.stringify([basis.key, expanded]);
    if (cached?.key === measurementKey && cached.graph === graph) return cached.extent;
    const descriptor = cardIndex(graph).describe(node);
    const lines = (value, size) => Math.max(1, Math.ceil(textWidth(value, size) / Math.max(1, basis.width - 28)));
    // The fallback is only an estimate when DOM layout is unavailable. Real
    // browsers measure the same HTML/CSS used by visible foreignObject cards.
    let collapsedHeight = 24 + basis.size * Math.min(2, lines(descriptor.title, basis.size)) * 1.4;
    let height = expanded ? 30 + basis.size * (1.4 + Math.min(2, lines(descriptor.title, basis.size)) * 1.4
      + Math.min(3, lines(shorten(descriptor.preview, 420), basis.size)) * 1.45
      + lines(descriptor.conditions.join(" · "), basis.size * .86) * 1.3
      + (descriptor.groups.length ? lines(descriptor.groups.slice(0, 2).map(group => group.title).join(" · "), basis.size * .86) * 1.3 : 0) + 2.7) : collapsedHeight;
    let measured = false;
    if (document.body && typeof getComputedStyle === "function") {
      const probe = mapContent(descriptor, expanded); probe.className += " map-measure"; probe.style.width = `${basis.width}px`;
      document.body.append(probe);
      try {
        const value = probe.getBoundingClientRect().height;
        if (Number.isFinite(value) && value > 0) {
          height = value; measured = true;
          if (expanded) { hide(probe.children[1], true); collapsedHeight = probe.getBoundingClientRect().height || collapsedHeight; }
          else collapsedHeight = height;
        }
      }
      finally { probe.remove(); }
    }
    // Keep the title/header at its previous vertical anchor when opening.
    const extent = { left: basis.width / 2 + 2, right: basis.width / 2 + 2, top: collapsedHeight / 2 + 2, bottom: height - collapsedHeight / 2 + 2 };
    measuredExtents.set(node, { key: measurementKey, graph, extent, actual: measured });
    document.documentElement.dataset.explorerCardMeasures = String(Number(document.documentElement.dataset.explorerCardMeasures || 0) + 1);
    return extent;
  }
  const newModel = graph => {
    const index = cardIndex(graph), result = explorerModel.create(graph, node => isCode(node) ? "code" : "context", node => nodeExtent(node, graph), (id, positions) => index.anchor(id, positions));
    modelMetrics.set(result, metrics().key); return result;
  };
  let model = newModel(activeGraph);
  const kindName = explorerCards.kindName;
  function reconcile(parent, desired, fallback = parent) {
    const keep = new Set(desired), active = document.activeElement;
    for (const child of [...parent.children]) if (!keep.has(child)) {
      if (active && (active === child || child.contains?.(active))) { fallback.setAttribute("tabindex", "-1"); fallback.focus({ preventScroll: true }); }
      child.remove();
    }
    desired.forEach((child, index) => { if (parent.children[index] !== child) parent.insertBefore(child, parent.children[index] || null); });
  }
  function savedReading(entry) {
    const state = { paths: [], connectionPage: entry.connectionPage || 0, groupPages: entry.groupPages || [] };
    const walk = (element, path) => {
      if (element.tagName?.toLowerCase() === "details" || element.scrollTop || element.scrollLeft)
        state.paths.push({ path, tag: element.tagName, open: element.open, top: element.scrollTop || 0, left: element.scrollLeft || 0 });
      [...element.children].forEach((child, index) => walk(child, [...path, index]));
    }; walk(entry.card, []); return state;
  }
  function restoreReading(entry, state) {
    if (!state) return;
    entry.connectionPage = state.connectionPage; entry.groupPages = state.groupPages || []; entry.refreshConnections();
    for (const item of state.paths) if (item.open !== undefined) {
      const element = item.path.reduce((parent, index) => parent?.children[index], entry.card);
      if (element?.tagName === item.tag) element.open = item.open;
    }
    entry.refreshGroups?.();
    for (const item of state.paths) {
      const element = item.path.reduce((parent, index) => parent?.children[index], entry.card);
      if (!element || element.tagName !== item.tag) continue;
      if (item.open !== undefined) element.open = item.open; element.scrollTop = item.top; element.scrollLeft = item.left;
    }
  }
  function geometryChanged() {
    const basis = metrics().key;
    if (busy || jobKind || drag || canvasMode() || metricFrame !== null || suppressedMetrics.get(model) === basis || modelMetrics.get(model) === basis) return;
    metricFrame = requestAnimationFrame(() => { metricFrame = null; if (!busy && !jobKind && !drag && !canvasMode()) resizeCards().catch(calculationFailed); });
  }
  const deferredInitial = () => Boolean(document.body && typeof getComputedStyle === "function");
  function screenCapacity() {
    const e = model.current ? model.extent(model.current) : { left: 155, right: 155, top: 44, bottom: 84 };
    return Math.max(1, Math.ceil(box[2] / (e.left + e.right + 18)) * Math.ceil(box[3] / (e.top + e.bottom + 18)));
  }
  function startNeighborhood(node, reset = false) {
    const options = { placeNeighbors: !deferredInitial() };
    if (reset) model.reset(node.nodeId, options); else model.visit(node.nodeId, true, options);
    // A readable starting view, not an inventory/neighbor cap. The remaining
    // direct neighborhood is measured/placed below with yielding and cancel.
    if (deferredInitial()) for (const id of model.neighbors(node.nodeId).filter(id => inEvidenceScope(model.nodes.get(id))).slice(0, 2)) model.place(id);
    modelMetrics.set(model, metrics().key);
  }
  async function prepareNeighborhood() {
    const target = model, basis = metrics().key, unplaced = [...model.visible].filter(id => !model.positions.has(id) && inEvidenceScope(model.nodes.get(id)));
    // This is a first-screen layout budget, never an evidence/inventory limit.
    // Explicit selection/Expand/Explored map can prepare every remaining card.
    const ids = unplaced.slice(0, screenCapacity());
    if (!ids.length) return;
    cancelWork(false); const serial = ++jobSerial; jobKind = "initial"; $("cancel-work").disabled = false;
    $("operation-status").textContent = `Preparing ${ids.length} direct-neighbor card positions. All metadata, reading and explicit exploration remain available; preparation can be cancelled.`;
    // Initial preparation is not a busy gate. A user operation can supersede it.
    await yieldWork();
    if (serial !== jobSerial || target !== model) return;
    const applied = await target.placeBatch(ids, { cancelled: () => serial !== jobSerial || target !== model || metrics().key !== basis, yieldWork, yieldBeforeCommit: true });
    if (serial !== jobSerial || target !== model) return;
    jobKind = null; $("cancel-work").disabled = true;
    $("operation-status").textContent = applied ? `First-screen direct-neighbor positions prepared; ${unplaced.length - ids.length} further positions remain on demand via selection, Expand or Explored map. All metadata and relationships retained.`
      : "Direct-neighbor preparation superseded; only committed positions shown. Unplaced records remain searchable and readable; Focus or Explored map can place them.";
    render();
  }
  async function resizeCards() {
    const target = model, basis = metrics().key;
    if (modelMetrics.get(target) === basis) return;
    const ids = [...target.positions.keys()];
    cancelWork(false); const serial = ++jobSerial; busy = true; jobKind = "geometry"; $("cancel-work").disabled = false;
    $("operation-status").textContent = "Measuring changed card sizes; existing positions retained until the adjustment completes…";
    const applied = await target.remeasure(ids, { cancelled: () => serial !== jobSerial || target !== model || metrics().key !== basis, yieldWork, yieldBeforeCommit: true });
    if (!applied) {
      if (serial === jobSerial && target === model) {
        busy = false; jobKind = null; $("cancel-work").disabled = true;
        $("operation-status").textContent = "Card size calculation superseded; previous committed layout retained."; geometryChanged();
      }
      return;
    }
    if (serial !== jobSerial || target !== model) return;
    modelMetrics.set(target, basis); busy = false; jobKind = null; $("cancel-work").disabled = true;
    $("operation-status").textContent = "Changed card sizes applied; pins, unaffected coordinates, camera and reading state retained."; render();
  }
  function recordKey(value) {
    if (value.nodeId) return `node:${value.nodeId}`;
    if (!edgeKeys.has(value)) edgeKeys.set(value, `edge:${value.edgeId || activeGraph.edges.indexOf(value)}`);
    return edgeKeys.get(value);
  }
  function selectionValues() { return [...model.chosen].map(id => model.nodes.get(id)).concat([...chosenEdges]); }
  function filterState() { return Object.fromEntries(filterIds.map(id => [id, $(id).type === "checkbox" || ["include-history", "hide-nonmatches"].includes(id) ? $(id).checked : $(id).value])); }
  function restoreFilters(state) { for (const id of filterIds) { if (typeof state[id] === "boolean") $(id).checked = state[id]; else $(id).value = state[id]; } scopeCache = null; }
  function viewState(title) { return { title, model: model.capture(), selected, chosenEdges: [...chosenEdges], box: [...box], mapMode, cardPage, filters: filterState(), connectionResult, connectionKey, operationStatus: $("operation-status").textContent }; }
  function remember(title) { viewHistory.splice(viewCursor + 1); viewHistory.push(viewState(title)); viewCursor = viewHistory.length - 1; renderTrail(); }
  function travelView(index) {
    const state = viewHistory[index]; if (!state) return;
    cancelWork(false); viewCursor = index; model.restore(state.model); selected = state.selected; chosenEdges = new Set(state.chosenEdges); edgeVersion++;
    box = [...state.box]; mapMode = state.mapMode; restoreFilters(state.filters); connectionResult = state.connectionResult; connectionKey = state.connectionKey;
    $("operation-status").textContent = state.operationStatus;
    cardPage = state.cardPage || 0; comparisonsCache = null; render();
  }
  function cancelWork(announce = true, keepDisclosures = false) {
    if (!keepDisclosures) mapDisclosures.get(activeGraph)?.clear();
    if (jobKind === "geometry" && announce) suppressedMetrics.set(model, metrics().key);
    jobSerial++; if (announce && (busy || jobKind)) $("operation-status").textContent = jobKind === "initial"
      ? "Cancelled neighbor preparation; previous committed positions retained. Unplaced neighbors remain searchable/readable, not a completed layout."
      : "Cancelled calculation; previous committed view and selection retained."; busy = false; jobKind = null; $("cancel-work").disabled = true;
  }
  async function toggleMapCard(node) {
    const target = model, graph = activeGraph, basis = metrics().key;
    if (target.nodes.get(node.nodeId) !== node) return;
    if (!mapDisclosures.has(graph)) mapDisclosures.set(graph, new Map());
    const pending = mapDisclosures.get(graph), desired = !(pending.get(node.nodeId) ?? openedMap(graph).has(node.nodeId));
    cancelWork(false, true); pending.set(node.nodeId, desired);
    const changes = new Map(pending), serial = ++jobSerial; jobKind = "disclosure"; $("cancel-work").disabled = false;
    $("operation-status").textContent = "Preparing card details; other cards, pins and camera stay in place…";
    const applied = await target.remeasure(changes.keys(), { yieldWork, yieldBeforeCommit: true,
      area: { left: box[0] + 8, top: box[1] + 8, right: box[0] + box[2] - 8, bottom: box[1] + box[3] - 8 },
      cancelled: () => serial !== jobSerial || target !== model || metrics().key !== basis,
      onCommit: () => { for (const [id, open] of changes) { if (open) openedMap(graph).add(id); else openedMap(graph).delete(id); } } });
    if (serial !== jobSerial || target !== model) return;
    pending.clear(); jobKind = null; $("cancel-work").disabled = true;
    $("operation-status").textContent = applied ? "Card details updated; other coordinates, pins, camera and independent reading state retained."
      : "Card detail change cancelled/superseded; previous committed display retained.";
    render();
  }
  function operationKey() { const filters = filterState(); if (!filters["hide-nonmatches"]) filters.search = "";
    return JSON.stringify([[...model.chosen], [...chosenEdges].map(recordKey), filters]); }
  const historical = node => node.currentTraversalEligible === false || node.snapshotState === "historical" || node.historical === true
    || /^(?:historical|domain-not-current|unavailable)/.test(node.freshness || "");
  const inEvidenceScope = node => node && ($("include-history").checked || !historical(node))
    && ($("axis").value === "all" || ($("axis").value === "code") === isCode(node))
    && ($("view").value === "all" || node.views?.includes($("view").value));
  function matches() {
    const scopeKey = JSON.stringify(filterState());
    if (scopeCache?.graph === activeGraph && scopeCache.key === scopeKey) return scopeCache.found;
    document.documentElement.dataset.explorerSearchPasses = String(Number(document.documentElement.dataset.explorerSearchPasses || 0) + 1);
    const eligible = activeGraph.nodes.filter(inEvidenceScope), found = model.search($("search").value.trim().toLocaleLowerCase(), eligible);
    scopeCache = { graph: activeGraph, key: scopeKey, found, foundIds: new Set(found.map(node => node.nodeId)), eligible,
      shown: $("hide-nonmatches").checked ? found : eligible };
    scopeCache.shownIds = new Set(scopeCache.shown.map(node => node.nodeId)); return found;
  }
  const inDisplayScope = node => inEvidenceScope(node) && (!$("hide-nonmatches").checked || scopeCache?.foundIds.has(node.nodeId));
  const edgeInScope = edge => ($("include-history").checked || !historical(edge)) && ($("relation-filter").value === "all" || !$("relation-filter").value || (edge.type || edge.relation) === $("relation-filter").value);
  function operationNode(node) {
    if (!node || !inDisplayScope(node)) return false;
    if (model.chosen.has(node.nodeId) || $("kind-filter").value === "all" || !$("kind-filter").value) return true;
    return ({ code: /^(File|Symbol|Source|Directory|Dependency)/, judgment: /Direction|Review|Decision|Policy|Requirement|Constraint/,
      execution: /Run|Result|Execution|Worker/ })[$("kind-filter").value]?.test(node.kind || "");
  }
  function setBox() { $("graph").setAttribute("viewBox", box.join(" ")); }
  function focusCamera(initial = false) {
    let point = model.positions.get(selected?.kind === "node" ? selected.value.nodeId : model.current);
    if (selected?.kind === "edge") {
      for (const id of [selected.value.from, selected.value.to]) model.reveal(id);
      const a = model.positions.get(selected.value.from), b = model.positions.get(selected.value.to);
      point = a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : a || b;
    }
    if (!point) return;
    hide($("graph"), false);
    const width = $("graph").clientWidth || 1000, height = $("graph").clientHeight || 700;
    if (initial && selected?.kind === "node") {
      let bounds = explorerCards.bounds(point, model.extent(selected.value.nodeId)), included = 1;
      for (const id of model.neighbors(selected.value.nodeId)) {
        if (included >= 3 || !inEvidenceScope(model.nodes.get(id))) continue;
        const at = model.positions.get(id); if (!at) continue;
        const other = explorerCards.bounds(at, model.extent(id)), next = { left: Math.min(bounds.left, other.left), right: Math.max(bounds.right, other.right), top: Math.min(bounds.top, other.top), bottom: Math.max(bounds.bottom, other.bottom) };
        if (next.right - next.left <= width - 24 && next.bottom - next.top <= height - 24) { bounds = next; included++; }
      }
      point = { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 };
    }
    box = [point.x - width / 2, point.y - height / 2, width, height]; setBox();
  }
  function redrawCamera() {
    if (cameraFrame !== null) return;
    cameraFrame = requestAnimationFrame(() => { cameraFrame = null; if (canvasMode()) renderOverview(scopeCache.shown); else renderGraph(visibleMatches); });
  }
  function fit() {
    const points = [...model.positions].filter(([id]) => inEvidenceScope(model.nodes.get(id)) && model.visible.has(id))
      .map(([id, point]) => ({ point, extent: model.extent(id) }));
    if (!points.length) box = [0, 0, 1000, 700];
    else {
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      for (const { point: p, extent: e } of points) {
        left = Math.min(left, p.x - e.left); top = Math.min(top, p.y - e.top);
        right = Math.max(right, p.x + e.right); bottom = Math.max(bottom, p.y + e.bottom);
      }
      box = [left, top, Math.max(650, right - left), Math.max(480, bottom - top)];
    }
    setBox();
  }
  function overviewModel() {
    if (!overviewStates.has(activeGraph)) overviewStates.set(activeGraph, explorerModel.overview(activeGraph, node => isCode(node) ? "code" : "context"));
    return overviewStates.get(activeGraph);
  }
  function overviewIncluded() {
    return mapMode === "explored-overview" ? new Set([...model.visible].filter(id => scopeCache.shownIds.has(id))) : scopeCache.shownIds;
  }
  function renderOverview(found) {
    const canvas = $("overview"), ctx = canvas.getContext("2d"), overview = overviewModel();
    if (!ctx) { $("status").textContent = "Canvas unavailable; every record remains reachable in the complete searchable list."; return; }
    const rect = canvas.getBoundingClientRect(), camera = explorerModel.viewport(box, rect), dpr = globalThis.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr)); canvas.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr * camera.scale, 0, 0, dpr * camera.scale, dpr * (camera.left - box[0] * camera.scale), dpr * (camera.top - box[1] * camera.scale));
    ctx.strokeStyle = "#627b9e"; ctx.globalAlpha = .22; ctx.beginPath();
    let edges = 0; const included = overviewIncluded();
    const window = overview.window(box);
    for (const edge of window.edges) {
      if (!included.has(edge.from) || !included.has(edge.to) || !edgeInScope(edge)) continue;
      const a = overview.points.get(edge.from), b = overview.points.get(edge.to);
      if (a && b) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); edges++; }
    }
    ctx.stroke(); ctx.globalAlpha = 1;
    for (const id of window.nodes) {
      if (!included.has(id)) continue;
      const node = model.nodes.get(id);
      const point = overview.points.get(node.nodeId); if (!point) continue;
      if (point.x < box[0] || point.x > box[0] + box[2] || point.y < box[1] || point.y > box[1] + box[3]) continue;
      ctx.fillStyle = model.chosen.has(node.nodeId) ? "#ffffff" : connectionResult?.nodes.has(node.nodeId) ? "#96e4c0" : $("search").value && foundIds.has(node.nodeId) ? "#f2d674" : historical(node) ? "#a38baa" : isCode(node) ? "#80baff" : "#eabd87";
      const radius = (model.chosen.has(node.nodeId) ? 3 : 1) / camera.scale;
      ctx.fillRect(point.x - radius, point.y - radius, radius * 2, radius * 2);
    }
    // Highlight actual directed relationships without reversing their stored ends.
    ctx.strokeStyle = "#96e4c0"; ctx.lineWidth = 2 / camera.scale; ctx.beginPath();
    const highlighted = new Set([...(connectionResult?.edges || []), ...chosenEdges]);
    for (const id of model.chosen) for (const edge of model.links(id)) if (model.chosen.has(edge.from) && model.chosen.has(edge.to)) highlighted.add(edge);
    for (const edge of highlighted) if (included.has(edge.from) && included.has(edge.to) && edgeInScope(edge)) {
      const a = overview.points.get(edge.from), b = overview.points.get(edge.to); if (a && b) {
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        const length = Math.hypot(b.x - a.x, b.y - a.y), size = 5 / camera.scale;
        if (length) { const ux = (b.x - a.x) / length, uy = (b.y - a.y) / length;
          ctx.moveTo(b.x - ux * size - uy * size / 2, b.y - uy * size + ux * size / 2); ctx.lineTo(b.x, b.y); ctx.lineTo(b.x - ux * size + uy * size / 2, b.y - uy * size - ux * size / 2);
        }
      }
    } ctx.stroke();
    $("status").textContent = `${mapMode === "explored-overview" ? "Explored evidence" : "All evidence"} overview: ${included.size} filtered records, ${edges} shown / ${activeGraph.edges.length} exported relationships, ${activeGraph.nodes.length} total exported records. Search highlights ${visibleMatches.length} matches; selection stays in this view. Read directed relationship types in the selected cards/detail list.${mapMode === "explored-overview" ? " Explored subset only, using overview coordinates; prior card coordinates/pins retained. Focus selection returns to cards; All evidence shows the whole inventory." : ""}`;
  }
  function zoom(factor) {
    if (jobKind === "fit") cancelWork();
    const [x, y, width, height] = box, next = width * factor, scale = next / width;
    if (!Number.isFinite(next) || next <= 0 || !Number.isFinite(height * scale)) return;
    cameraIntent++;
    box = [x + (width - next) / 2, y + (height - height * scale) / 2, next, height * scale]; setBox(); redrawCamera();
  }
  function selectNode(node, keyboard = false, event = {}) {
    if (!node) return;
    const before = model.selectionVersion, previous = selected?.value;
    if (!model.choose(node.nodeId, { toggle: Boolean(event.ctrlKey || event.metaKey || event.key === " " || event.toggle), only: event.only === true, position: !canvasMode() })) return;
    if (event.only) { chosenEdges.clear(); edgeVersion++; }
    if (before !== model.selectionVersion) cancelWork();
    selected = model.focus ? { kind: "node", value: model.nodes.get(model.focus) } : chosenEdges.size ? { kind: "edge", value: [...chosenEdges][0] } : null;
    if (event.mapNavigation) {
      // Explicit endpoint navigation is one history step, not the ordinary
      // read/selection path. Center one card; never fit or reposition its peers.
      cancelWork(false);
      if (inDisplayScope(node)) { model.place(node.nodeId); mapMode = "focus"; focusCamera(); }
      else $("operation-status").textContent = "Selected connection is outside current filters. Selection and camera retained; use Show selected scope, then Focus selection to see it.";
    }
    if (event.mapNavigation || before !== model.selectionVersion || previous !== selected?.value)
      remember(`${event.mapNavigation ? "Show on map" : "Read"} ${shorten(label(node), 32)}`);
    render();
    if (keyboard || event.mapNavigation) {
      const target = [...$("graph").children].find(el => el.getAttribute("data-node") === node.nodeId);
      if (event.mapNavigation && target) target.scrollIntoView({ block: "center", inline: "nearest" });
      target?.focus({ preventScroll: Boolean(event.mapNavigation) });
    }
  }
  function mapNeighborButton(node) {
    const graph = activeGraph, control = button(`Show on map: ${label(node)}`, () => {
      if (activeGraph === graph && model.nodes.get(node.nodeId) === node) selectNode(node, true, { mapNavigation: true });
    });
    control.setAttribute("data-map-neighbor", node.nodeId); return control;
  }
  // This immutable report contains all navigation metadata, not every exact
  // original. Index declared source citations once; never join by path alone.
  let sourceCitations = null;
  function citingWork(relative, digest) {
    if (!sourceCitations) {
      sourceCitations = new Map();
      for (const node of data.graph.nodes) if (node.subtype === "SessionWorkEvidence" && node.origin?.layer === "sessionWork") {
        const seen = new Set();
        for (const ref of node.referenceEvidence || []) if (ref.kind === "source") {
          const identity = key(ref); if (seen.has(identity)) continue; seen.add(identity);
          if (!sourceCitations.has(identity)) sourceCitations.set(identity, []);
          sourceCitations.get(identity).push(node);
        }
      }
    }
    return sourceCitations.get(key({ path: relative, digest })) || [];
  }
  function readCitingWork(nodeId) {
    if (activeGraph !== data.graph) { $("layer").value = "project"; changeLayer(); }
    const node = model.nodes.get(nodeId); if (!node) return;
    const selectedIndex = [...model.chosen].indexOf(nodeId);
    cardPage = Math.floor((selectedIndex < 0 ? model.chosen.size : selectedIndex) / PAGE_SIZE);
    selectNode(node);
    const card = cardsCache?.entries.get(recordKey(node))?.card;
    if (card) { card.open = true; card.scrollIntoView({ block: "nearest" }); card.children[0].focus(); }
  }
  function appendCitingWork(body, file, pair) {
    const rows = new Map();
    for (const [side, digest] of [[pair.before?.digest ? "Recorded / cited before" : "Cited reference (historical bytes unavailable)", pair.before?.digest || pair.citedReference?.digest],
      [pair.scope === "recorded-changeset-snapshot-pair" ? "Recorded after (not necessarily current)" : pair.scope === "explicit-work-chain-citation-pair-not-request-boundary" ? "Cited version B" : "Export-observed current", pair.after?.digest]]) {
      if (!digest) continue;
      for (const node of citingWork(file.path, digest)) {
        if (!rows.has(node.nodeId)) rows.set(node.nodeId, { node, sides: [] });
        rows.get(node.nodeId).sides.push(`${side} · ${digest}`);
      }
    }
    if (!rows.size) return;
    const section = text("section", "", "exact-citations"), list = text("ul", ""), controls = text("nav", "", "list-pages"), count = text("span", "");
    section.append(text("h4", "Exact citing work — not proven change causes"), list, controls); body.append(section);
    const values = [...rows.values()]; let page = 0;
    const update = () => {
      list.replaceChildren();
      for (const { node, sides } of values.slice(page * 20, (page + 1) * 20)) {
        const row = text("li", sides.join(" · ")), control = button(`Read citing work: ${label(node)}`, () => readCitingWork(node.nodeId));
        control.setAttribute("data-citing-work", node.nodeId); row.append(control);
        row.append(text("p", node.detailCoverage === "metadata-only"
          ? "Original / comparison detail was not included for this work. Read its available recorded judgments, or request a separate exact-detail report."
          : "A recorded citation is not proof that this work caused the byte change.", "hint")); list.append(row);
      }
      count.textContent = `${page * 20 + 1}–${Math.min(values.length, (page + 1) * 20)} / ${values.length} exact citing records`;
      previous.disabled = page === 0; next.disabled = (page + 1) * 20 >= values.length;
    };
    const previous = button("Previous citing records", () => { page--; update(); }), next = button("Next citing records", () => { page++; update(); });
    controls.append(count, previous, next); update();
  }
  function selectEdge(edge, keyboard = false, event = {}) {
    const toggle = event.ctrlKey || event.metaKey || event.key === " ";
    const changed = toggle || !chosenEdges.has(edge);
    if (toggle && chosenEdges.has(edge)) chosenEdges.delete(edge); else chosenEdges.add(edge);
    if (changed) { edgeVersion++; cancelWork(); } selected = chosenEdges.has(edge) ? { kind: "edge", value: edge } : model.focus ? { kind: "node", value: model.nodes.get(model.focus) } : null;
    remember(`Read ${relation(edge)}`); render(); if (keyboard) $("selected-title").focus();
  }
  function accessibleActivate(el, action) {
    el.addEventListener("click", event => { if (!suppressClick) action(event.detail === 0, event); });
    el.addEventListener("keydown", event => {
      if (event.target !== el && (event.target.closest?.("[data-card-control]") || event.target.closest?.("[data-card-body]"))) return;
      if (event.key === "Enter" && event.shiftKey && el.getAttribute("data-node")) return;
      if (["Enter", " "].includes(event.key)) { event.preventDefault(); action(true, event); }
    });
  }
  function renderList(found) {
    $("records").replaceChildren();
    listPage = Math.min(listPage, Math.max(0, Math.ceil(found.length / PAGE_SIZE) - 1));
    for (const node of found.slice(listPage * PAGE_SIZE, (listPage + 1) * PAGE_SIZE)) {
      const activate = (event, toggle = false) => {
        selectNode(node, false, toggle ? { toggle: true } : event);
        // Rendering replaces the list. Keep keyboard/checkbox work in that
        // list instead of moving focus to a different map control.
        const attribute = toggle ? "data-record-toggle" : "data-record-entry";
        for (const row of $("records").children) for (const control of row.children)
          if (control.getAttribute(attribute) === node.nodeId) control.focus();
      };
      const entry = button(label(node), event => activate(event)), item = text("li", "");
      entry.setAttribute("data-record-entry", node.nodeId);
      entry.addEventListener("keydown", event => { if (event.key === " ") { event.preventDefault(); activate({ toggle: true }); } });
      entry.append(text("span", `${node.kind} · ${node.freshness || "freshness unknown"}`, "record-kind"));
      entry.setAttribute("aria-pressed", String(model.chosen.has(node.nodeId)));
      const toggle = document.createElement("input"); toggle.type = "checkbox"; toggle.checked = model.chosen.has(node.nodeId);
      toggle.setAttribute("data-record-toggle", node.nodeId);
      toggle.setAttribute("aria-label", `Toggle selection: ${label(node)}`); toggle.addEventListener("change", event => activate(event, true));
      item.append(entry, toggle); $("records").append(item);
    }
    if (!historyCounts.has(activeGraph)) historyCounts.set(activeGraph, activeGraph.nodes.reduce((count, node) => count + Number(historical(node)), 0));
    const past = historyCounts.get(activeGraph);
    $("count").textContent = `${found.length} matching / ${activeGraph.nodes.length} exported (${activeGraph.nodes.length - past} current/retained, ${past} historical/non-current). Page ${listPage + 1} of ${Math.max(1, Math.ceil(found.length / PAGE_SIZE))}. All exported metadata is searchable; page size is not an export limit.`;
    const exclusions = activeGraph.integrity?.excluded || [], omittedOriginals = Object.values(data.originals).filter(original => original.status !== "verified-exact-bytes").length;
    $("inventory-gaps").textContent = `${activeGraph.coverage?.state || activeGraph.status || "Coverage unknown"}. ${exclusions.length} excluded metadata inputs/layers; unavailable-node totals may be unknown. ${omittedOriginals} omitted/unavailable references in the focused original bundle. See snapshot basis for exact reasons.`;
    $("records-prev").disabled = listPage === 0; $("records-next").disabled = (listPage + 1) * PAGE_SIZE >= found.length;
  }
  function renderTrail() {
    $("trail").replaceChildren();
    const start = Math.max(0, viewCursor - PAGE_SIZE + 1);
    viewHistory.slice(start, start + PAGE_SIZE).forEach((state, offset) => {
      const index = start + offset;
      const entry = button(shorten(state.title, 28), () => travelView(index));
      if (index === viewCursor) entry.setAttribute("aria-current", "step"); $("trail").append(entry);
    });
    $("back").disabled = viewCursor <= 0; $("forward").disabled = viewCursor >= viewHistory.length - 1;
    $("restart").disabled = !model.current;
  }
  function renderGraph(found) {
    if (!mapCaches.has(activeGraph)) mapCaches.set(activeGraph, { nodes: new Map(), edges: new Map(), groups: new Map() });
    const cache = mapCaches.get(activeGraph), children = [], viewport = { left: box[0], top: box[1], right: box[0] + box[2], bottom: box[1] + box[3] };
    const focus = selected?.kind === "node" ? selected.value.nodeId : null, neighborhood = new Set(focus ? [focus, ...model.neighbors(focus)] : []);
    const intended = model.visible;
    // Search narrows the record list/overview, not the selected journey. Explicit
    // history, axis and original-view scope still govern every drawn record.
    const scope = [...intended].map(id => model.nodes.get(id)).filter(inDisplayScope), scopeIds = new Set(scope.map(node => node.nodeId));
    const canvas = $("graph"), shown = scope.filter(node => {
      if (!intended.has(node.nodeId)) return false;
      const p = model.positions.get(node.nodeId); if (!p) return false;
      return explorerCards.intersects(explorerCards.bounds(p, model.extent(node.nodeId)), viewport);
    }), shownIds = new Set(shown.map(node => node.nodeId)); drawnNodeIds = shownIds;
    const selectedEdges = [...new Set(shown.flatMap(node => model.links(node.nodeId)))].filter(edge => shownIds.has(edge.from) && shownIds.has(edge.to)
      && model.positions.has(edge.from) && model.positions.has(edge.to) && edgeInScope(edge));
    const origin = model.positions.get(model.current);
    if (origin) {
      if (!cache.guides) { cache.guides = svg("g", { class: "axis-guides", "aria-hidden": "true", "pointer-events": "none" }); cache.guides.append(svg("line", {}), svg("line", {})); }
      for (const [name, value] of Object.entries({ x1: origin.x - 1400, y1: origin.y, x2: origin.x + 1400, y2: origin.y })) cache.guides.children[0].setAttribute(name, value);
      for (const [name, value] of Object.entries({ x1: origin.x, y1: origin.y - 1200, x2: origin.x, y2: origin.y + 1200, opacity: $("layer").value === "code" ? 0 : 1 })) cache.guides.children[1].setAttribute(name, value);
      children.push(cache.guides);
    }
    if (!cache.defs) { cache.defs = svg("defs", {}); const marker = svg("marker", { id: "edge-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 5, markerHeight: 5, orient: "auto" });
      marker.append(svg("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#8ca6c9" })); cache.defs.append(marker); }
    children.push(cache.defs);
    const index = cardIndex(), rectangles = new Map(shown.map(node => [node.nodeId, explorerCards.bounds(model.positions.get(node.nodeId), model.extent(node.nodeId))]));
    const visibleGroups = new Set();
    const detailedGroups = new Set();
    for (const id of shownIds) if (openedMap().has(id)) for (const key of index.memberships.get(id) || []) detailedGroups.add(key);
    const groupIndex = new Map([...detailedGroups].map(key => [key, index.groups.get(key)]));
    for (const group of explorerCards.groupGeometry(groupIndex, index.memberships, rectangles)) {
      visibleGroups.add(group.key);
      if (!cache.groups.has(group.key)) { const element = svg("g", { class: "record-group", "pointer-events": "none" }); element.append(svg("rect", {}), svg("text", { class: "group-caption" })); cache.groups.set(group.key, element); }
      const element = cache.groups.get(group.key), [background, caption] = element.children;
      for (const [name, value] of Object.entries({ x: group.box.left, y: group.box.top, width: group.box.right - group.box.left, height: group.box.bottom - group.box.top, rx: 16, opacity: group.enclosure ? 1 : 0 })) background.setAttribute(name, value);
      caption.setAttribute("x", group.box.left + 8); caption.setAttribute("y", group.box.top + 19);
      caption.textContent = displayText(`${shorten(group.title, 48)} · ${group.shown} shown / ${group.exported} exported${group.enclosure ? "" : " · membership list, not an enclosure"}`);
      children.push(element);
    }
    const edgeGroups = new Map();
    for (const edge of selectedEdges) { const pair = JSON.stringify([edge.from, edge.to].sort()); if (!edgeGroups.has(pair)) edgeGroups.set(pair, []); edgeGroups.get(pair).push(edge); }
    const visibleEdges = new Set();
    for (const edge of selectedEdges) {
      const a = model.positions.get(edge.from), b = model.positions.get(edge.to);
      const isSelected = chosenEdges.has(edge), incident = focus && (edge.from === focus || edge.to === focus);
      const joined = model.chosen.has(edge.from) && model.chosen.has(edge.to), path = connectionResult?.edges.has(edge);
      const siblings = edgeGroups.get(JSON.stringify([edge.from, edge.to].sort())), offset = (siblings.indexOf(edge) - (siblings.length - 1) / 2) * 48 * (edge.from <= edge.to ? 1 : -1);
      const geometry = explorerCards.edgeGeometry(a, b, model.extent(edge.from), model.extent(edge.to), offset);
      if (!explorerCards.intersects(geometry.bounds, viewport)) continue;
      visibleEdges.add(edge);
      if (!cache.edges.has(edge)) {
        const group = svg("g", {}), title = svg("title", {}), hit = svg("path", { fill: "none", class: "edge-hit", tabindex: 0, role: "button", "data-edge": edge.edgeId || `${edge.from}:${edge.to}` });
        accessibleActivate(hit, (keyboard, event) => selectEdge(edge, keyboard, event));
        const line = svg("path", { fill: "none", "marker-end": "url(#edge-arrow)", class: "edge", "pointer-events": "none" });
        const caption = svg("text", { "text-anchor": "middle", class: "edge-label", "pointer-events": "none" });
        title.textContent = relation(edge); caption.textContent = relation(edge); group.append(title, hit, line, caption); cache.edges.set(edge, group);
      }
      const group = cache.edges.get(edge); group.setAttribute("class", `connection${isSelected || incident || joined || path ? " highlighted" : ""}${path ? " selected-path" : ""}`);
      group.children[1].setAttribute("aria-label", `${relation(edge)}: ${label(model.nodes.get(edge.from))} to ${label(model.nodes.get(edge.to))}`);
      for (const line of [group.children[1], group.children[2]]) line.setAttribute("d", geometry.path);
      group.children[3].setAttribute("x", geometry.caption.x); group.children[3].setAttribute("y", geometry.caption.y); children.push(group);
    }
    for (const node of shown) {
      const p = model.positions.get(node.nodeId), focused = focus === node.nodeId, pinned = model.pinned.has(node.nodeId);
      const descriptor = index.describe(node), extent = model.extent(node.nodeId), width = extent.left + extent.right - 4, height = extent.top + extent.bottom - 4;
      if (!cache.nodes.has(node.nodeId)) {
        const group = svg("g", { tabindex: 0, role: "group", "data-node": node.nodeId }), rectangle = svg("rect", { rx: 12, class: "card-frame" }), content = svg("foreignObject", { class: "card-content" }), title = svg("title", {});
        const graph = activeGraph, body = mapContent(descriptor, openedMap(graph).has(node.nodeId),
          () => { toggleMapCard(node).catch(calculationFailed); },
          () => { if (activeGraph !== graph) return; selectNode(node); const card = cardsCache?.entries.get(recordKey(node))?.card; if (card) { card.open = true; card.scrollIntoView({ block: "nearest" }); card.children[0].focus(); } });
        body.children[1].addEventListener("scroll", () => { if (openedMap(graph).has(node.nodeId)) mapScroll(graph).set(node.nodeId, { top: body.children[1].scrollTop || 0, left: body.children[1].scrollLeft || 0 }); });
        title.textContent = label(node); content.append(body); group.append(rectangle, content, title);
        accessibleActivate(group, (keyboard, event) => { if (!event.target.closest?.("[data-card-body]") && !event.target.closest?.("[data-card-control]")) selectNode(node, keyboard, event); });
        const direct = event => {
          if (event.target.closest?.("[data-card-body]") || event.target.closest?.("[data-card-control]")) return;
          event.preventDefault(); event.stopPropagation(); runDirect(node).catch(calculationFailed);
        };
        group.addEventListener("dblclick", direct);
        group.addEventListener("keydown", event => {
          if (event.shiftKey && event.key === "Enter") { direct(event); return; }
          const delta = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[event.key];
          if (!event.shiftKey || !delta || event.target.closest?.("[data-card-control]")) return; event.preventDefault(); if (jobKind === "geometry" || jobKind === "disclosure") cancelWork(); const at = model.positions.get(node.nodeId); model.move(node.nodeId, at.x + delta[0], at.y + delta[1]); renderGraph(visibleMatches); group.focus();
        }); cache.nodes.set(node.nodeId, group);
      }
      const group = cache.nodes.get(node.nodeId);
      const expanded = openedMap().has(node.nodeId), mapBody = group.children[1].children[0], disclosure = mapBody.children[0].children[1];
      if (group.dataset.expanded === "true" && !expanded) mapScroll().set(node.nodeId, { top: mapBody.children[1].scrollTop || 0, left: mapBody.children[1].scrollLeft || 0 });
      hide(mapBody.children[1], !expanded); disclosure.textContent = expanded ? "−" : "+";
      if (expanded && group.dataset.expanded !== "true") { const state = mapScroll().get(node.nodeId); if (state) { mapBody.children[1].scrollTop = state.top; mapBody.children[1].scrollLeft = state.left; } }
      group.dataset.expanded = String(expanded);
      disclosure.setAttribute("aria-expanded", String(expanded)); disclosure.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} details: ${descriptor.title}`);
      group.setAttribute("transform", `translate(${p.x},${p.y})`);
      group.setAttribute("class", `node${isCode(node) ? " code" : " context"}${model.chosen.has(node.nodeId) ? " selected" : ""}${connectionResult?.nodes.has(node.nodeId) ? " selected-path" : ""}${$("search").value && foundIds.has(node.nodeId) ? " search-match" : ""}`);
      group.setAttribute("aria-label", `${model.chosen.has(node.nodeId) ? "Selected: " : ""}${descriptor.title}${expanded ? `. ${descriptor.kind}. ${descriptor.conditions.join(". ")}` : ". Details collapsed"}${pinned ? ". Position pinned on this screen" : ""}`);
      group.dataset.pinned = String(pinned); group.dataset.focused = String(focused);
      for (const element of [group.children[0], group.children[1]]) for (const [name, value] of Object.entries({ x: -extent.left + 2, y: -extent.top + 2, width, height })) element.setAttribute(name, value);
      children.push(group);
    }
    if (!shown.length) { if (!cache.empty) cache.empty = svg("text", { x: 60, y: 90, class: "empty" }); cache.empty.textContent = selected?.kind === "node" && !inDisplayScope(selected.value)
      ? "Selected record is hidden by the current filters. Use Show selected scope; the selection has not been removed."
      : scope.length ? "Selected context is off-screen. Use Focus selection or pan." : "Choose a starting record from the list. Empty coverage does not prove absence."; children.push(cache.empty); }
    for (const [id, group] of cache.nodes) if (!shownIds.has(id) && openedMap().has(id)) {
      const body = group.children[1].children[0].children[1]; mapScroll().set(id, { top: body.scrollTop || 0, left: body.scrollLeft || 0 });
    }
    reconcile(canvas, children, canvas);
    for (const id of cache.nodes.keys()) if (!shownIds.has(id)) cache.nodes.delete(id);
    for (const edge of cache.edges.keys()) if (!visibleEdges.has(edge)) cache.edges.delete(edge);
    for (const key of cache.groups.keys()) if (!visibleGroups.has(key)) cache.groups.delete(key);
    const hidden = [...intended].filter(id => !scopeIds.has(id)).length, offscreen = scope.length - shown.length;
    const unplaced = scope.filter(node => !model.positions.has(node.nodeId)).length;
    $("status").textContent = `${mapMode === "focus" ? "Selected & direct connections" : "Explored map"}: ${shown.length} on screen, ${offscreen - unplaced} off-screen, ${unplaced} positions not prepared, ${hidden} unavailable/outside evidence scope / ${activeGraph.nodes.length} exported. Search narrows the list and overview; eligible selected context stays visible.${selected?.kind === "node" && !inDisplayScope(selected.value) ? " Selected record is hidden by current filters; use Show selected scope to restore it." : ""}${activeGraph.reasonCode ? ` ${activeGraph.reasonCode}` : ""}`;
    setBox();
    if (deferredInitial()) geometryChanged();
  }
  function renderSelectionCards() {
    const values = selectionValues(), focusedKey = selected ? recordKey(selected.value) : null;
    const hidden = values.filter(value => value.nodeId ? !inDisplayScope(value) : !edgeInScope(value)).length;
    $("selection-count").textContent = `${values.length} selected · ${hidden} outside current evidence scope`;
    $("restore-scope").textContent = hidden ? `Show ${hidden} hidden selection${hidden === 1 ? "" : "s"}` : "Show selected scope";
    $("clear-selection").disabled = values.length === 0; $("only-focus").disabled = !selected;
    $("collapse").disabled = model.steps.length === 0 || busy; $("connect-selection").disabled = model.chosen.size < 2 || busy;
    const pageCount = Math.max(1, Math.ceil(values.length / PAGE_SIZE)); cardPage = Math.min(cardPage, pageCount - 1);
    $("reading-range").textContent = `${values.length ? cardPage * PAGE_SIZE + 1 : 0}–${Math.min(values.length, (cardPage + 1) * PAGE_SIZE)} of ${values.length} selected records. Reading focus does not replace other cards or move the camera.`;
    $("cards-prev").disabled = cardPage === 0; $("cards-next").disabled = (cardPage + 1) * PAGE_SIZE >= values.length;
    const same = cardsCache?.model === model && cardsCache.version === model.selectionVersion && cardsCache.edgeVersion === edgeVersion && cardsCache.page === cardPage;
    if (!same) {
      const body = $("selection-cards"), previous = cardsCache;
      if (!readingStates.has(activeGraph)) readingStates.set(activeGraph, new Map());
      const states = readingStates.get(activeGraph), entries = new Map(), children = [], index = cardIndex();
      for (const value of values.slice(cardPage * PAGE_SIZE, (cardPage + 1) * PAGE_SIZE)) {
        const identity = recordKey(value), scopeIdentity = index.identity(value), retained = previous?.model === model && previous.entries.get(identity);
        if (retained && retained.value === value && retained.scopeIdentity === scopeIdentity) { entries.set(identity, retained); children.push(retained.card); continue; }
        const descriptor = index.describe(value), node = Boolean(value.nodeId), entryModel = model, card = text("details", "", "selection-card");
        card.setAttribute("data-record", identity); card.append(text("summary", node ? label(value) : relation(value)));
        card.append(text("p", `${descriptor.kind} · ${value.kind || value.type || "relationship"}`, "record-kind"));
        const conditions = [...descriptor.conditions,
          node && !inDisplayScope(value) || !node && !edgeInScope(value) ? "outside evidence scope — selection retained" : null].filter(item => typeof item === "string" && item);
        const conditionsElement = text("p", conditions.join(" · "), "card-conditions"); card.append(conditionsElement);
        for (const note of descriptor.notes) card.append(text("p", note, "hint"));
        if (descriptor.body) card.append(text("p", descriptor.body));
        else if (!descriptor.hasDisplayText) card.append(text("p", node ? descriptor.emptyNotice : `${label(model.nodes.get(value.from))} → ${label(model.nodes.get(value.to))}`));
        for (const [heading, facts] of descriptor.facts) {
          card.append(text("strong", heading)); const list = text("ul", "", "record-facts");
          for (const fact of facts) {
            if (heading === "Recorded Todo revisions (historical)" && fact && typeof fact.todoId === "string") {
              const row = text("li", `${fact.todoId} [${fact.status}; ${fact.origin}]: ${fact.task}`);
              for (const key of ["nextAction", "reason", "progress", "priority", "prior", "resolves", "relatedEvidence"]) if (Object.hasOwn(fact, key)) {
                row.append(text("p", `${key}: ${typeof fact[key] === "string" ? fact[key] : JSON.stringify(fact[key])}`));
              }
              list.append(row); continue;
            }
            const row = text("li", typeof fact === "string" ? fact : fact.assessment || "Recorded judgment");
            if (fact && typeof fact === "object") { row.append(text("p", fact.reason || "No recorded reason included.")); for (const alternative of fact.alternatives || []) row.append(text("p", alternative, "hint")); }
            list.append(row);
          } card.append(list);
        }
        for (const excerpt of descriptor.excerpts) card.append(text("strong", excerpt.heading), text("pre", excerpt.text, "record-excerpt"));
        if (!value.rationale && !value.workContent?.judgments?.length && !value.workContent?.todos?.some(todo => todo.reason)
          && !(value.workContentExcerpts || []).some(entry => ["judgments", "todos"].includes(entry.field) && entry.subfield === "reason" && entry.text))
          card.append(text("p", "No recorded reason included for this record.", "hint"));
        const actions = text("div", "", "reading-actions");
        actions.append(button("Read focus", () => node ? selectNode(value) : selectEdge(value)),
          button("Only this", () => {
            if (node) selectNode(value, false, { only: true });
            else { model.clearSelection(); chosenEdges = new Set([value]); edgeVersion++; selected = { kind: "edge", value }; cancelWork(); remember("Select one relationship"); render(); }
          }), button("Remove", () => node ? selectNode(value, false, { toggle: true }) : selectEdge(value, false, { ctrlKey: true })));
        if (node && (activeGraph.contextLineage?.files || []).some(file => fileMatches(value, file))) actions.append(button("Recorded code context", () => {
          selectNode(value); $("context-lineage").open = true;
          const at = comparisonFiles.findIndex(section => section.dataset.sourcePath === (value.path || value.sourceReference?.path));
          if (at >= 0) { fileCursor = at; comparisonFiles[at].scrollIntoView({ block: "nearest" }); comparisonFiles[at].focus(); comparisonPosition("file"); }
          else $("context-lineage").scrollIntoView({ block: "nearest" });
        }));
        if (node && value.detailCoverage === "metadata-only") {
          card.append(text("p", "Exact original / comparison detail is not included for this record. Available metadata and explicit connections remain readable.", "hint"));
          const options = button("Exact detail options", () => {
            selectNode(value); $("focus-inspector").open = true; $("detail-scope").setAttribute("tabindex", "-1");
            $("detail-scope").scrollIntoView({ block: "nearest" }); $("detail-scope").focus();
          }); options.setAttribute("data-detail-options", value.nodeId); actions.append(options);
        }
        for (const item of (value.relationCoverage || []).filter(item => item.type === "CITES_ARTIFACT" && item.status === "unavailable")) {
          card.append(text("p", `Exact document link unavailable: ${item.reference?.path || "reference not included"} · ${item.reasonCode}. Citation bytes are not typed approval or cause.`, "hint"));
        }
        card.append(actions);
        const links = node ? model.links(value.nodeId) : [value];
        const connections = text("details", ""); connections.append(text("summary", `${links.length} actual relationships (direction and type)`));
        const rows = text("ul", ""), pages = text("nav", "", "list-pages"), range = text("span", ""); let page = 0;
        const previousPage = button("Previous", () => { page--; listConnections(); }), nextPage = button("Next", () => { page++; listConnections(); });
        pages.append(range, previousPage, nextPage);
        const listConnections = () => {
          const children = [];
          for (const edge of links.slice(page * 20, (page + 1) * 20)) {
            const from = entryModel.nodes.get(edge.from), to = entryModel.nodes.get(edge.to), row = text("li", "");
            row.append(text("p", `${from ? label(from) : "Endpoint not exported"} → ${to ? label(to) : "Endpoint not exported"} · ${relation(edge)}${edgeInScope(edge) ? "" : " · outside current relationship scope"}`));
            row.append(button("Read relationship", () => selectEdge(edge)));
            const endpoints = node ? [edge.from === value.nodeId ? edge.to : edge.from] : [...new Set([edge.from, edge.to])];
            for (const id of endpoints) { const endpoint = entryModel.nodes.get(id); if (endpoint) row.append(mapNeighborButton(endpoint)); }
            children.push(row);
          }
          reconcile(rows, children, connections.children[0]);
          range.textContent = `${page * 20 + (links.length ? 1 : 0)}–${Math.min(links.length, (page + 1) * 20)} / ${links.length}`;
          previousPage.disabled = page === 0; nextPage.disabled = (page + 1) * 20 >= links.length;
        }; listConnections(); connections.append(rows, pages); card.append(connections);
        const groupReaders = [];
        for (const membership of descriptor.groups) {
          const section = text("details", "", "record-membership"), rows = text("ul", ""), pages = text("nav", "", "list-pages"), range = text("span", ""); let page = 0;
          section.append(text("summary", `${membership.type}: ${membership.title} · ${membership.members.size} exported members including root`));
          const members = [...membership.members];
          const update = () => {
            if (!section.open) return;
            const children = [];
            for (const id of members.slice(page * 20, (page + 1) * 20)) {
              const member = entryModel.nodes.get(id); if (member) { const row = text("li", ""); row.append(button(label(member), () => selectNode(member))); children.push(row); }
            }
            reconcile(rows, children, section.children[0]);
            prev.disabled = page === 0; next.disabled = (page + 1) * 20 >= members.length;
            range.textContent = `${page * 20 + 1}–${Math.min(members.length, (page + 1) * 20)} / ${members.length}`;
          };
          const prev = button("Previous members", () => { page--; update(); }), next = button("Next members", () => { page++; update(); }); pages.append(range, prev, next);
          section.addEventListener("toggle", update); section.append(rows, pages); card.append(section);
          groupReaders.push({ update, get page() { return page; }, set page(value) { page = value; } });
        }
        const original = data.originals[key(value.sourceReference || value.provenance)], detail = text("details", "");
        detail.append(text("summary", "Exact original & identity"));
        detail.append(text("p", original?.status || "Exact original not included", "hint"));
        if (original?.reasonCode) detail.append(text("p", original.reasonCode, "hint"));
        if (original?.text) detail.append(text("pre", readableOriginal(original.text, value) ?? original.text));
        const raw = text("details", ""); raw.append(text("summary", "Raw original / unknown fields / identifiers"), text("pre", original?.text || "Original not included"), text("pre", JSON.stringify(value, null, 2))); detail.append(raw); card.append(detail);
        const entry = { card, value, descriptor, scopeIdentity, conditionsElement, refreshConnections: listConnections, refreshGroups: () => groupReaders.forEach(reader => reader.update()),
          get groupPages() { return groupReaders.map(reader => reader.page); }, set groupPages(values) { groupReaders.forEach((reader, index) => { reader.page = values[index] || 0; }); },
          get connectionPage() { return page; }, set connectionPage(value) { page = value; } };
        let beforeFold = null;
        card.children[0].addEventListener("click", () => { if (card.open) beforeFold = savedReading(entry); });
        card.addEventListener("toggle", () => { if (card.open && beforeFold) restoreReading(entry, beforeFold); });
        restoreReading(entry, scopeIdentity ? states.get(scopeIdentity) : null); entries.set(identity, entry); children.push(card);
      }
      if (previous?.graph === activeGraph) for (const [identity, entry] of previous.entries) if (!entries.has(identity) && entry.scopeIdentity) states.set(entry.scopeIdentity, savedReading(entry));
      if (!values.length) children.push(text("p", "Select records to read together. The explored map remains intact.", "hint"));
      reconcile(body, children, $("reading-range"));
      cardsCache = { model, graph: activeGraph, version: model.selectionVersion, edgeVersion, page: cardPage, scope: scopeCache.key, entries };
    }
    if (cardsCache.scope !== scopeCache.key) {
      for (const entry of cardsCache.entries.values()) entry.refreshConnections();
      cardsCache.scope = scopeCache.key;
    }
    for (const [identity, entry] of cardsCache.entries) {
      const { card, value, conditionsElement } = entry;
      card.dataset.focused = String(identity === focusedKey); card.setAttribute("aria-label", `${identity === focusedKey ? "Reading focus" : "Selected record"}: ${value.nodeId ? label(value) : relation(value)}`);
      conditionsElement.textContent = displayText([...entry.descriptor.conditions,
        value.nodeId ? !inDisplayScope(value) ? "outside evidence scope — selection retained" : null : !edgeInScope(value) ? "outside relationship scope — selection retained" : null].filter(item => typeof item === "string" && item).join(" · "));
    }
    $("connection-roots").replaceChildren();
    if (connectionResult) {
      const stale = connectionKey !== operationKey();
      $("connection-status").textContent = `${stale ? "Previous connection result — scope/selection changed; run again to update. " : "Selected connections: "}Bidirectional adjacency search; shortest connection branches with all equal predecessors, not all paths or directed execution. ${connectionResult.roots.length} component(s), ${connectionResult.outsideScope.length} selected outside scope; absence here is not global absence. Longer branches remain available with Expand.`;
      rootPage = Math.min(rootPage, Math.max(0, Math.ceil(connectionResult.roots.length / PAGE_SIZE) - 1));
      for (const component of connectionResult.roots.slice(rootPage * PAGE_SIZE, (rootPage + 1) * PAGE_SIZE)) {
        const row = text("li", `Fixed reference: ${label(model.nodes.get(component.root))} → ${component.targets.length} selected record(s). `);
        row.append(button("Read reference", () => selectNode(model.nodes.get(component.root)))); $("connection-roots").append(row);
      }
    } else $("connection-status").textContent = "Direct relationships between selected records are highlighted. Show selected connections finds recorded branches; it cannot establish cause, approval or completion.";
    $("roots-prev").disabled = !connectionResult || rootPage === 0; $("roots-next").disabled = !connectionResult || (rootPage + 1) * PAGE_SIZE >= connectionResult.roots.length;
  }
  async function runExpansion() {
    cancelWork(false); const serial = ++jobSerial, basis = metrics().key; busy = true; jobKind = "expand"; $("cancel-work").disabled = false;
    $("operation-status").textContent = "Finding the next unexpanded boundary…"; renderSelectionCards();
    const result = await model.expandWave({ key: operationKey(), allowed: operationNode, edgeAllowed: edgeInScope, cancelled: () => serial !== jobSerial || metrics().key !== basis, yieldWork, placementLimit: screenCapacity(),
      progress: value => { $("operation-status").textContent = `Examining boundary: ${value.examinedEdges} actual relationships; not yet committed.`; } });
    if (serial !== jobSerial) return; if (result.status === "cancelled") { supersededCalculation(serial); return; } busy = false; jobKind = null; $("cancel-work").disabled = true;
    $("operation-status").textContent = `${result.status}: ${result.added || 0} newly exposed records · ${result.edges || 0} actual relationships · ${result.frontier || 0} next-boundary records. Camera, mode, prior positions and selection retained. First-screen positions prepared; remaining records stay searchable/readable and can be positioned with selection or Explored map.`;
    remember(`Expand ${result.added || 0}`); render();
  }
  async function runDirect(node = selected?.kind === "node" ? selected.value : null) {
    if (!node || model.nodes.get(node.nodeId) !== node) return;
    if (!model.chosen.has(node.nodeId) || selected?.value !== node) selectNode(node);
    cancelWork(false); const target = model, serial = ++jobSerial, basis = metrics().key, initialCameraIntent = cameraIntent;
    busy = true; jobKind = "direct"; $("cancel-work").disabled = false;
    $("operation-status").textContent = `Opening exact direct connections of ${label(node)}…`; renderSelectionCards();
    await yieldWork(); if (serial !== jobSerial || target !== model) return;
    const result = await target.expandDirect(node.nodeId, { allowed: operationNode, edgeAllowed: edgeInScope, placementLimit: screenCapacity(), yieldWork,
      cancelled: () => serial !== jobSerial || target !== model || metrics().key !== basis,
      progress: value => { $("operation-status").textContent = `${value.examinedEdges} direct relationships examined; not yet committed.`; } });
    if (serial !== jobSerial || target !== model) return;
    if (result.status === "cancelled") { supersededCalculation(serial); return; }
    busy = false; jobKind = null; $("cancel-work").disabled = true;
    // An explicit expansion may center initially, but never overwrite newer pan
    // or zoom input made while its cooperative calculation was awaiting input.
    if (result.status !== "outside-scope" && cameraIntent === initialCameraIntent) { mapMode = "focus"; focusCamera(); }
    $("operation-status").textContent = result.status === "outside-scope" ? "Selected record is outside current filters; selection and camera retained. Show selected scope to open its connections."
      : `${result.edges} exact direct relationships · ${result.nodes - 1} neighboring records. Only this one hop; pins, selection and prior positions retained. Off-screen records remain in the searchable list and paged relationship reader; no evidence removed.`;
    remember(`Direct connections ${shorten(label(node), 24)}`); render();
  }
  async function runConnections() {
    cancelWork(false); const serial = ++jobSerial, basis = operationKey(), geometryBasis = metrics().key; busy = true; jobKind = "connections"; $("cancel-work").disabled = false;
    $("operation-status").textContent = "Computing selected connection branches within this export and filters…"; renderSelectionCards();
    const result = await model.connectSelection({ allowed: operationNode, edgeAllowed: edgeInScope, reference: selected?.kind === "node" ? selected.value.nodeId : null,
      cancelled: () => serial !== jobSerial || metrics().key !== geometryBasis, yieldWork });
    if (serial !== jobSerial) return;
    if (result.status === "cancelled") { supersededCalculation(serial); return; }
    if (!await model.showConnections(result, { cancelled: () => serial !== jobSerial || metrics().key !== geometryBasis, yieldWork })) { supersededCalculation(serial); return; }
    if (serial !== jobSerial) return;
    connectionResult = result; connectionKey = basis; rootPage = 0; busy = false; jobKind = null; $("cancel-work").disabled = true;
    $("operation-status").textContent = `Connection result ready: ${result.nodes.size} records, ${result.edges.size} actual relationships; reference fixed until an explicit new calculation.`;
    remember("Selected connections"); render();
  }
  async function fitExplored() {
    cancelWork(false); const serial = ++jobSerial, basis = metrics().key; busy = true; jobKind = "fit"; $("cancel-work").disabled = false;
    $("operation-status").textContent = "Preparing explored view; existing positions remain fixed…";
    const ids = [...model.visible].filter(id => inDisplayScope(model.nodes.get(id)));
    if (ids.length > screenCapacity()) {
      // A whole-fit card smaller than a readable screen is a Canvas overview,
      // not thousands of tiny foreignObjects. Metadata/relationships are intact.
      await yieldWork(); if (serial !== jobSerial || metrics().key !== basis) { supersededCalculation(serial); return; }
      mapMode = "explored-overview"; box = [0, 0, 1000, 700]; setBox();
      render();
      busy = false; jobKind = null; $("cancel-work").disabled = true;
      $("operation-status").textContent = "Explored subset overview ready; no card positions changed. Select then Focus selection to read cards; All evidence remains the complete inventory.";
      renderSelectionCards(); renderDetail(); remember("Fit explored evidence overview");
      return;
    }
    if (!await model.placeBatch(ids, { cancelled: () => serial !== jobSerial || metrics().key !== basis, yieldWork, yieldBeforeCommit: true })) { supersededCalculation(serial); return; }
    if (serial !== jobSerial) return;
    mapMode = "explored"; fit(); render(); busy = false; jobKind = null; $("cancel-work").disabled = true;
    $("operation-status").textContent = "Explored cards fitted; existing coordinates, pins and selection retained.";
    renderSelectionCards(); renderDetail(); remember("Fit explored map");
  }
  function supersededCalculation(serial) {
    if (serial !== jobSerial) return;
    cancelWork(false); $("operation-status").textContent = "Calculation superseded by changed geometry; previous committed selection, coordinates and camera retained."; render();
  }
  function renderDetail() {
    renderContextLineage();
    let relations = $("relations"); if (!relations) { relations = text("ul", ""); relations.id = "relations"; relations.setAttribute("aria-label", "Follow included connections"); $("expansion").after(relations); } relations.replaceChildren();
    $("expand").disabled = model.chosen.size === 0 || busy;
    $("expand-direct").disabled = selected?.kind !== "node" || busy;
    if ($("relation-pages")) $("relation-pages").hidden = !selected;
    if (!selected) {
      $("selected-title").textContent = "Where do you want to start?"; $("selected-caption").textContent = "Choose a record to unfold its connected evidence.";
      $("selected-summary").textContent = "The map follows existing links, without making product decisions.";
      $("evidence").textContent = "No record selected."; $("original").textContent = "No record selected."; $("raw-original").textContent = ""; $("raw-original-details").hidden = true; $("original-state").textContent = ""; $("expansion").textContent = ""; return;
    }
    const value = selected.value, node = selected.kind === "node", reference = value.sourceReference || value.provenance;
    const selectionId = value.nodeId || value.edgeId;
    if (relationSelection !== selectionId) { relationPage = 0; relationSelection = selectionId; }
    $("detail-scope").textContent = (value.detailCoverage === "metadata-only"
      ? "Metadata only for this record. Missing original/comparison does not mean no change. Request a separate report with this exact anchor and its cited sources."
      : "Detail is bounded to the export selection, not complete file history. A missing comparison does not mean unchanged.")
      + ` Snapshot: ${data.generatedAt || "time not included"}. Regeneration re-reads evidence at a new basis; it is not executed by this file.`;
    const detailPaths = [...new Set([value.path, ...(value.referenceEvidence || []).filter(ref => ref.kind === "source").map(ref => ref.path)].filter(Boolean))];
    if (node && data.regenerate?.argv) {
      const powershell = data.regenerate.shell === "powershell", quote = arg => powershell ? `'${String(arg).replaceAll("'", "''")}'` : `'${String(arg).replaceAll("'", `'"'"'`)}'`;
      // Exact anchors identify records; paths alone are never a decision join.
      // The existing CLI CSV path option cannot express a comma in a filename.
      // In that case the exact work anchor still brings its citations through
      // the common lineage reader, rather than producing a misleading command.
      const safePaths = detailPaths.filter(path => !path.includes(",")).slice(0, 32);
      $("detail-scope").append(text("pre", `${powershell ? "& " : ""}${[...data.regenerate.argv, "--layer", activeGraph === data.graph ? "project" : "code", "--anchors", value.nodeId,
        ...(safePaths.length ? ["--paths", safePaths.join(",")] : [])].map(quote).join(" ")}`));
      if (safePaths.length !== detailPaths.length) $("detail-scope").append(text("p", "Some paths cannot be listed in this CLI option; the exact work anchor retains its citations. Use the typed graph query for explicit path arrays.", "hint"));
    }
    $("selected-title").textContent = displayText(node ? label(value) : relation(value));
    $("selected-caption").textContent = displayText(node ? [value.kind, value.freshness || "freshness unknown", value.reviewState || "review unknown", value.status, value.state, value.historical ? "historical" : null].filter(item => typeof item === "string").join(" · ") : `Existing relationship · ${value.viewerCurrentness || value.freshness || "currentness unknown"} · not an execution permission`);
    const summary = $("selected-summary"); summary.replaceChildren();
    summary.append(text("p", String(value.description || value.workContent?.summary || value.summary || value.proposedPolicy?.statement || value.statement || value.purpose || value.objective || value.directionEvidence?.goal || value.rationale || value.planDelta || value.outcome || value.assessment || (node ? "Follow a connection below, or open its exact original." : `${label(model.nodes.get(value.from))} → ${label(model.nodes.get(value.to))}`))));
    if (value.contentPartial) summary.append(text("p", `Partial navigation excerpt; exact originals remain separate. ${JSON.stringify(value.contentCoverage || {})}`, "hint"));
    for (const [heading, items] of [["Constraints", value.directionEvidence?.constraints], ["Cancelled actions", value.directionEvidence?.cancelledActions], ["Unknowns", value.workContent?.unknowns || value.unknowns], ["Pending", value.workContent?.pending], ["Recorded judgments", value.workContent?.judgments]]) {
      if (!Array.isArray(items) || !items.length) continue;
      summary.append(text("strong", heading)); const list = text("ul", ""); list.className = "record-facts";
      for (const item of items) {
        const entry = text("li", typeof item === "string" ? item : item.assessment || "Recorded judgment");
        if (item && typeof item === "object") { if (item.reason) entry.append(text("p", item.reason)); for (const alternative of item.alternatives || []) entry.append(text("p", alternative, "hint")); }
        list.append(entry);
      } summary.append(list);
    }
    if (value.directionContentCoverage?.partial) summary.append(text("p", "Direction excerpt is partial; the exact original may contain more.", "hint"));
    if (value.contentPartial || value.workContentCoverage?.partial) summary.append(text("p", "Work excerpt is partial; record identity retains exact excerpt metadata.", "hint"));
    $("evidence").textContent = displayText(JSON.stringify(value, null, 2));
    const original = data.originals[key(reference)];
    $("original-state").textContent = original ? `${original.status}${original.reasonCode ? ` · ${original.reasonCode}` : ""}` : "Exact original not included. Reference remains available under record identity.";
    const readable = original?.text ? readableOriginal(original.text, value) : null;
    $("original").textContent = displayText(readable ?? original?.text ?? "Exact original not included for this selection; this is not evidence of absence or no change.");
    $("raw-original").textContent = displayText(original?.text || ""); $("raw-original-details").hidden = readable === null;
    const links = node ? model.links(value.nodeId) : [value];
    const unavailable = node ? new Set(links.flatMap(edge => [edge.from, edge.to]).filter(id => !model.nodes.has(id))).size : 0;
    const filteredOut = node ? model.neighbors(value.nodeId).filter(id => !foundIds.has(id)).length : 0;
    $("expansion").textContent = node ? `${links.length} included connections${unavailable ? ` · ${unavailable} endpoints not exported` : ""}${filteredOut ? ` · ${filteredOut} neighbors hidden by your filters` : ""}.` : "Follow an endpoint:";
    let pages = $("relation-pages");
    if (!pages) {
      pages = text("nav", "", "list-pages"); pages.id = "relation-pages"; pages.setAttribute("aria-label", "Connection pages");
      pages.append(button("Previous connections", () => { relationPage--; renderDetail(); }), button("Next connections", () => { relationPage++; renderDetail(); })); relations.before(pages);
    }
    relationPage = Math.min(Math.max(0, relationPage), Math.max(0, Math.ceil(links.length / PAGE_SIZE) - 1));
    pages.hidden = links.length <= PAGE_SIZE;
    pages.children[0].disabled = relationPage === 0; pages.children[1].disabled = (relationPage + 1) * PAGE_SIZE >= links.length;
    $("expansion").textContent += ` Connection page ${relationPage + 1} of ${Math.max(1, Math.ceil(links.length / PAGE_SIZE))}; every included connection is reachable.`;
    for (const edge of links.slice(relationPage * PAGE_SIZE, (relationPage + 1) * PAGE_SIZE)) {
      const targets = node ? [edge.from === value.nodeId ? edge.to : edge.from] : [edge.from, edge.to];
      for (const id of targets) {
        const target = model.nodes.get(id), row = text("li", ""), direction = edge.from === value.nodeId ? "→" : "←";
        const condition = historical(edge) || target && historical(target) ? "[Historical / non-current] " : "";
        const state = target?.reviewState && target.reviewState !== "not-applicable" ? ` · ${target.reviewState}` : "";
        const outside = target && !foundIds.has(id) ? " · outside current filters" : "";
        const entry = button(node ? `${condition}${direction} ${relation(edge)} · ${target ? label(target) : "Not exported"}${state}${outside}` : label(target), () => {
          if (historical(edge) || target && historical(target)) $("include-history").checked = true;
          selectNode(target);
        }); entry.disabled = !target;
        row.append(entry); if (node) row.append(button("ⓘ", () => selectEdge(edge)));
        if (target) row.append(mapNeighborButton(target)); relations.append(row);
      }
    }
  }
  function readableOriginal(raw, node) {
    let record; try { record = JSON.parse(raw); } catch { return null; }
    if (!record || typeof record !== "object") return null;
    // A repository JSON file can imitate any kind/subtype. Only originals
    // supplied by a verified typed record layer get record-specific language.
    if (!["sessionWork", "direction", "lineage", "onboarding", "policy", "product"].includes(node?.origin?.layer)) return null;
    const canon = node?.kind === "ProductModelRevision" || node?.origin?.layer === "product";
    if (record.kind !== node?.kind && !canon) return null;
    const lines = [], put = (title, value) => {
      const values = Array.isArray(value) ? value : value == null ? [] : [value];
      for (const item of values.slice(0, 32)) {
        const full = typeof item === "string" ? item : JSON.stringify(item);
        lines.push(`${title}: ${full.slice(0, 4096)}${full.length > 4096 ? ` [${full.length - 4096} characters omitted; exact raw original below]` : ""}`);
      }
      if (values.length > 32) lines.push(`${title}: ${values.length - 32} further entries not displayed; exact raw original below.`);
    };
    if (record.kind === "Evidence" && record.subtype === "SessionWorkEvidence" && node.subtype === "SessionWorkEvidence" && node.origin.layer === "sessionWork" && record.content) {
      lines.push("Agent-authored recorded work evidence; not a captured user transcript.");
      const c = record.content; put("Summary", c.summary);
      for (const judgment of c.judgments || []) { put("Assessment", judgment.assessment); put("Recorded reason", judgment.reason); put("Alternative", judgment.alternatives); }
      for (const [field, title] of [["observedWork", "Recorded observation"], ["pending", "Recorded pending"], ["unknowns", "Unknown"], ["suggestedFollowUp", "Suggested follow-up (not approval)"]]) put(title, c[field]);
    } else if (record.kind === "ProjectDirection" && record.input) {
      lines.push("Caller-conveyed user direction — not transcript capture."); put("Goal", record.input.goal); put("Constraint", record.input.constraints); put("Decision", record.input.decisions); put("Cancelled action", record.input.cancelledActions);
    } else if (record.kind === "ReviewDecision") {
      lines.push("Historical recorded review — not current effect permission."); put("Disposition", record.disposition); put("Recorded reason", record.rationale);
      put("Recorded next action (not execution permission)", record.nextActions);
    } else if (record.kind === "ResultPacket") {
      lines.push("Recorded execution result — not independently re-run by this view."); put("Outcome", record.outcome); put("Plan delta", record.planDelta);
      put("Recorded check / verification", record.verification); put("Recorded evidence (not independent verification)", record.evidence); put("Recorded impact radius", record.impactRadius);
      put("Unknown", record.unknowns);
    } else if (record.kind === "ProductPolicyCandidate") {
      lines.push("Proposed policy — not an approval or automatic Canon promotion."); put("Name", record.proposedPolicy?.name); put("Proposed statement", record.proposedPolicy?.statement); put("Description", record.proposedPolicy?.description);
    } else {
      const model = record.kind === "ProductModelRevision" ? record.document : record;
      if (!canon || !Array.isArray(model?.features) || !Array.isArray(model?.constraints)) return null;
      lines.push("Recorded Product Canon content; its historical/current state is shown above.");
      for (const field of ["featureGroups", "capabilities", "features", "requirements", "constraints", "decisions", "policies"]) for (const entity of model[field] || []) {
        if (!entity || typeof entity !== "object") continue;
        put(field, entity.name || entity.key); put("Statement", entity.statement); put("Description", entity.description); put("Recorded reason", entity.rationale);
      }
    }
    lines.push("Known fields rendered from the exact original. Unknown fields and full identity remain in raw-original diagnostics.");
    return lines.join("\n\n");
  }
  function pairMatches(value, file, pair) {
    if (activeGraph === data.graph && [pair.changeSet?.nodeId, pair.recordedReviewDecisionId, pair.recordedResultPacketId, pair.leftRecord?.nodeId, pair.rightRecord?.nodeId].some(id => id && id === value.nodeId)) return true;
    const digests = new Set([pair.before?.digest, pair.after?.digest, pair.citedReference?.digest, pair.gap?.expectedDigest,
      ...(pair.gaps || []).map(gap => gap.expectedDigest)].filter(Boolean));
    if ((value.path === file.path || value.sourceReference?.path === file.path) && digests.has(value.digest || value.fileDigest || value.sourceReference?.digest)) return true;
    if (activeGraph === data.graph && (value.referenceEvidence || []).some(ref => ref.kind === "source" && ref.path === file.path && digests.has(ref.digest))) return true;
    return activeGraph === data.graph && (file.associations || []).some(item => item.nodeId === value.nodeId && digests.has(item.source?.digest));
  }
  function fileMatches(value, file) {
    if (activeGraph !== data.graph) {
      const digest = value.digest || value.fileDigest || value.sourceReference?.digest;
      return Boolean(digest && (value.path === file.path || value.sourceReference?.path === file.path) && file.current?.digest === digest)
        || (file.comparisons || []).some(pair => pairMatches(value, file, pair));
    }
    return value.path === file.path || value.sourceReference?.path === file.path || (file.associations || []).some(item => item.nodeId === value.nodeId)
      || (file.comparisons || []).some(pair => pairMatches(value, file, pair));
  }
  function comparisonPosition(intent) {
    // User navigation belongs to this exact exported graph/file/pair, not to
    // whichever global ordinal happens to occupy the panel on the next render.
    if (intent && comparisonGraph) {
      const file = comparisonFiles[fileCursor]?.comparisonFile;
      if (file) {
        if (!comparisonFileNavigation.has(comparisonGraph)) comparisonFileNavigation.set(comparisonGraph, new Map());
        comparisonFileNavigation.get(comparisonGraph).set(file, ++comparisonNavigationSerial);
        const hunk = changeHunks[changeCursor];
        if (intent === "hunk" && hunk?.file === fileCursor) {
          const entry = comparisonStates.get(comparisonGraph)?.get(hunk.pair)?.get(file.path);
          if (entry) entry.navigation = { element: hunk.element, serial: comparisonNavigationSerial };
        }
      }
    }
    $("comparison-position").textContent = `File ${comparisonFiles.length ? fileCursor + 1 : 0}/${comparisonFiles.length} · changed region ${changeCursor >= 0 ? changeCursor + 1 : 0}/${changeHunks.length}. All included comparisons stay open; missing regions are not reconstructed.`;
    $("file-prev").disabled = fileCursor <= 0; $("file-next").disabled = fileCursor >= comparisonFiles.length - 1;
    $("change-prev").disabled = changeCursor <= 0; $("change-next").disabled = changeCursor >= changeHunks.length - 1;
  }
  function renderContextLineage() {
    const context = activeGraph.contextLineage, panel = $("context-lineage"), body = $("context-lineage-body"); panel.hidden = !context;
    if (comparisonsCache?.model === model && comparisonsCache.version === model.selectionVersion && comparisonsCache.edgeVersion === edgeVersion) return;
    const previousGraph = comparisonGraph, previousFile = comparisonFiles[fileCursor]?.comparisonFile, previousHunk = changeHunks[changeCursor];
    comparisonGraph = activeGraph;
    if (!comparisonStates.has(activeGraph)) comparisonStates.set(activeGraph, new Map());
    const pairStates = comparisonStates.get(activeGraph);
    // Capture the display being left, not the layer being entered. Detached
    // cached nodes may report scroll zero in a real browser; never overwrite
    // their last attached reading position with that artificial value.
    for (const entries of comparisonStates.get(previousGraph)?.values() || []) for (const entry of entries.values()) {
      if (!body.contains(entry.body)) continue;
      entry.scroll = []; const walk = element => { if (element.scrollTop || element.scrollLeft) entry.scroll.push([element, element.scrollTop, element.scrollLeft]); for (const child of element.children) walk(child); }; walk(entry.body);
    }
    for (const entry of documentPanels.get(previousGraph)?.values() || []) {
      if (!body.contains(entry.panel)) continue;
      entry.scroll = entry.readers.map(element => [element, element.scrollTop, element.scrollLeft]);
    }
    comparisonsCache = { model, version: model.selectionVersion, edgeVersion }; body.replaceChildren();
    comparisonFiles = []; changeHunks = []; fileCursor = 0; changeCursor = -1; $("comparison-files").replaceChildren(); comparisonPosition();
    $("show-code-diff").hidden = true; $("jump-diff").disabled = true;
    if (!context) return;
    body.append(text("p", "Recorded reasons, byte changes and associations are different evidence. No historical cause or current permission is inferred.", "hint"));
    if (context.status === "unavailable") { body.append(text("p", context.reasonCode || "Context unavailable", "hint")); return; }
    const values = selectionValues(), selectedIds = new Set(activeGraph === data.graph ? values.map(value => value.nodeId).filter(Boolean) : []);
    const selectionKey = JSON.stringify(values.map(recordKey));
    if (contextSelection !== selectionKey) contextSelection = selectionKey;
    for (const event of (context.events || []).filter(item => selectedIds.has(item.nodeId))) {
      body.append(text("p", event.sourceRole === "HEAD-authored-P3-work-evidence-not-user-transcript"
        ? "Agent-authored work evidence; not a captured user transcript" : event.sourceRole, "hint"));
      for (const connection of event.connections) {
        const other = connection.from === event.nodeId ? connection.to : connection.from, target = model.nodes.get(other);
        const entry = button(`${relation({ type: connection.relation })} · ${target ? label(target) : "Not included in this layer"}`, () => selectNode(target)); entry.disabled = !target; body.append(entry);
      }
      if (event.missingLink) body.append(text("p", event.missingLink, "hint"));
    }
    const navigation = context.documentNavigation;
    if (navigation) {
      if (!documentPanels.has(activeGraph)) documentPanels.set(activeGraph, new Map());
      const panels = documentPanels.get(activeGraph);
      const roots = new Set((navigation.roots || []).filter(root => (root.citedBy || []).some(citation => selectedIds.has(citation.nodeId))
        || values.some(value => (value.path || value.sourceReference?.path) === root.path
          && (value.digest || value.fileDigest || value.sourceReference?.digest) === root.digest)).map(root => root.key));
      const documents = (navigation.documents || []).filter(document => document.rootKeys.some(key => roots.has(key)));
      const includedDocuments = new Set(documents.map(document => document.documentId).filter(Boolean));
      for (const document of documents) {
        const identity = document.documentId || JSON.stringify([document.path, document.expectedDigest]);
        let cached = panels.get(identity);
        if (!cached) {
          const panel = text("details", "", "file-comparison"), readers = [], openTargets = [];
          panel.setAttribute("data-document-id", identity);
          panel.append(text("summary", `Document links · ${document.path} · ${(document.digest || document.expectedDigest || "unknown").slice(0, 12)}`));
          panel.append(text("p", "Exact document bytes; linked targets are current files unless their version is separately proven. Links do not prove implementation or approval.", "hint"));
          if (document.status !== "available") panel.append(text("p", `Exact document unavailable: ${document.reasonCode}. Today's document was not substituted.`, "hint"));
          for (const link of document.links || []) {
            const section = text("details", "");
            section.setAttribute("data-document-link", `${document.path}:${link.line}:${link.column}`);
            section.append(text("summary", `${link.label} → ${link.path || link.href} · ${link.status}`));
            section.append(text("p", `${document.path}@${document.digest} · line ${link.line}, column ${link.column}${link.reasonCode ? " · " + link.reasonCode : ""}`, "hint"));
            if (link.versionScope) section.append(text("p", link.versionScope, "hint"));
            if (link.excerpt !== undefined) {
              const excerpt = text("pre", link.excerpt, "record-excerpt"); readers.push(excerpt); section.append(excerpt);
              if (link.omittedCharacters) section.append(text("p", `${link.omittedCharacters} characters omitted from this excerpt; exact path and digest remain above.`, "hint"));
            }
            const target = [...model.nodes.values()].find(node => (node.path || node.sourceReference?.path) === link.path
              && (node.digest || node.fileDigest || node.sourceReference?.digest) === link.digest);
            if (target) section.append(mapNeighborButton(target));
            if (link.documentId) {
              const open = button("Read linked document references", () => {
              const next = panels.get(link.documentId)?.panel;
              if (next && body.contains(next)) { next.open = true; next.tabIndex = -1; next.scrollIntoView({ block: "nearest" }); next.focus(); }
              }); open.setAttribute("data-document-open", link.documentId);
              const notice = text("p", "", "hint"); section.append(open, notice);
              openTargets.push({ element: open, notice, targetId: link.documentId });
            }
            panel.append(section);
          }
          if (document.omittedLinks) panel.append(text("p", `${document.omittedLinks} additional links omitted by the navigation bound.`, "hint"));
          cached = { panel, readers, openTargets, scroll: [] }; panels.set(identity, cached);
        }
        for (const target of cached.openTargets) {
          const included = includedDocuments.has(target.targetId);
          target.element.disabled = !included;
          target.notice.textContent = included ? "" : "Target document is outside this selection's bounded view. Its source path and read limits remain visible; select its cited root or request exact detail to expand.";
          hide(target.notice, included);
        }
        body.append(cached.panel);
        for (const [element, top, left] of cached.scroll) { element.scrollTop = top; element.scrollLeft = left; }
      }
      if (documents.length && (navigation.coverage.omittedLinks || navigation.coverage.pendingFileCount || navigation.coverage.depthLimited)) {
        body.append(text("p", `Document navigation is bounded: ${navigation.coverage.omittedLinks} links omitted, ${navigation.coverage.pendingFileCount} files deferred; depth-limited: ${navigation.coverage.depthLimited}. Missing results do not establish absence.`, "hint"));
      }
    }
    const candidates = (context.files || []).filter(file => values.some(value => fileMatches(value, file))), relatedIds = new Set(selectedIds);
    for (const value of values) if (!candidates.some(file => fileMatches(value, file))) body.append(text("p", `${value.nodeId ? label(value) : relation(value)}: No exact code comparison included. This does not mean unchanged.`, "hint"));
    const outerBody = body;
    for (const file of candidates) {
      const body = text("section", "", "file-comparison"); body.dataset.sourcePath = file.path; body.comparisonFile = file; outerBody.append(body); comparisonFiles.push(body); body.tabIndex = -1;
      const fileIndex = comparisonFiles.length - 1, entry = text("li", "");
      entry.append(button(file.path, () => { panel.open = true; fileCursor = fileIndex; body.scrollIntoView({ block: "nearest" }); body.focus(); comparisonPosition("file"); })); $("comparison-files").append(entry);
      const owners = values.filter(value => fileMatches(value, file));
      body.append(text("h3", file.path));
      body.append(text("p", `Selected references: ${owners.map(value => value.nodeId ? label(value) : relation(value)).join(" · ")}`, "hint"));
      if (file.currentObservation) body.append(text("p", [file.currentObservation.reasonCode, file.currentObservation.explanation].filter(Boolean).join(" · "), "hint"));
      for (const candidate of file.renameEvidence?.candidates || []) body.append(text("p", `Historical rename candidate — not confirmed continuity: ${candidate.path}. Current identity and cause remain unverified.`, "hint"));
      if (file.renameEvidence) body.append(text("p", file.renameEvidence.status === "observed-most-recent-path-change-only"
        ? "Move lookup checked only the most recent recorded path change; other moves remain unknown."
        : "Move lookup is partial, unavailable or lacks an exact historical source basis; no absence or continuity established.", "hint"));
      const pairs = (file.comparisons || []).filter(pair => values.some(value => pairMatches(value, file, pair)));
      const endpoints = pairs.flatMap(pair => Object.values(pair.snapshotLookup || {}).map(side => side.requested).filter(Boolean));
      const linkedIds = new Set([...owners.map(value => value.nodeId), ...pairs.flatMap(pair => [pair.changeSet?.nodeId, pair.leftRecord?.nodeId, pair.rightRecord?.nodeId])].filter(Boolean));
      // Reader lookups are keyed by the complete recorded endpoint, not World
      // alone. A linked node ID cannot widen a lookup to a different pair.
      const relevantGaps = (context.gaps || []).filter(gap => gap.lookup ? endpoints.some(endpoint =>
        gap.lookup === (endpoint.worldModelId ? "recorded-exact-world-id" : "recorded-source-graph-pair")
        && ["worldModelId", "sourceSnapshotId", "graphSnapshotId"].every(field => (gap[field] || null) === (endpoint[field] || null)))
        : Boolean(gap.nodeId && linkedIds.has(gap.nodeId)));
      for (const gap of relevantGaps) {
        const identity = gap.worldModelId ? `Recorded World ${gap.worldModelId} · Source ${gap.sourceSnapshotId} · Graph ${gap.graphSnapshotId}` : gap.sourceSnapshotId && gap.graphSnapshotId
          ? `Source ${gap.sourceSnapshotId} · Graph ${gap.graphSnapshotId} · World ID not recorded` : `Recorded reference ${gap.nodeId}`;
        const budget = Number.isInteger(gap.inspectedSnapshotCount) && Number.isInteger(gap.retainedSnapshotCount)
          ? ` · ${gap.inspectedSnapshotCount} inspected / ${gap.retainedSnapshotCount} retained${Number.isInteger(gap.uninspectedSnapshotCount) ? ` · ${gap.uninspectedSnapshotCount} uninspected` : ""}` : "";
        body.append(text("p", `Source lookup: ${gap.reasonCode || "CONTEXT_SOURCE_UNAVAILABLE"} · ${identity}${budget}${gap.absenceEstablished === false ? " · absence not established" : ""}`, "comparison-gap"));
      }
      if (!pairs.length) body.append(text("p", "No exact source comparison for these selected references. Same path alone does not establish a revision pair; unavailable data is not an empty diff.", "hint"));
      body.append(text("p", "File-level context; not automatically the reason for each symbol."));
      for (const association of file.associations || []) if (selectedIds.has(association.nodeId)) relatedIds.add(association.nodeId);
      for (const pair of pairs) {
        // The decoded exact pair object is immutable snapshot identity. A path,
        // node selection or merely equal-looking text is not a comparison key.
        if (!pairStates.has(pair)) pairStates.set(pair, new Map());
        const entries = pairStates.get(pair), retained = entries.get(file.path);
        if (pair.recordedReviewDecisionId) relatedIds.add(pair.recordedReviewDecisionId);
        const linkedText = `Linked selected records: ${values.filter(value => pairMatches(value, file, pair)).map(value => value.nodeId ? label(value) : relation(value)).join(" · ")}`;
        if (retained) {
          retained.linked.textContent = displayText(linkedText); body.append(retained.body);
          for (const [element, top, left] of retained.scroll || []) { element.scrollTop = top; element.scrollLeft = left; }
          if (retained.hunks.length) { $("show-code-diff").hidden = false; $("jump-diff").disabled = false; }
          for (const element of retained.hunks) changeHunks.push({ element, file: fileIndex, pair });
          continue;
        }
        const parent = body;
        {
        const body = text("section", "", "comparison-pair"); parent.append(body);
        body.setAttribute("data-comparison-before", pair.before?.digest || ""); body.setAttribute("data-comparison-after", pair.after?.digest || "");
        appendCitingWork(body, file, pair);
        const firstHunk = changeHunks.length;
        if (pair.retainedOriginal) {
          const original = pair.retainedOriginal;
          body.append(text("h4", "Exact cited historical source — current path unavailable, not an after-version"), text("pre", original.text));
          if (original.omittedLines || original.textTruncated) body.append(text("p", `Partial historical excerpt: ${original.omittedLines} omitted lines; text truncated ${Boolean(original.textTruncated)}.`, "hint"));
        }
        body.append(text("p", `${pair.status} · file bytes ${pair.fileBytes || "unknown"} · ${pair.scope}`));
        const scopeLabel = pair.scope === "recorded-changeset-snapshot-pair" ? "Recorded snapshot before / after — not request fulfillment"
          : pair.scope === "explicit-work-chain-citation-pair-not-request-boundary" ? "Cited version A / B — not a request boundary"
            : "Cited revision / export-observed current — not live";
        const linked = text("p", linkedText, "hint"); body.append(text("h4", scopeLabel), linked);
        for (const side of ["before", "after"]) body.append(text("p", `${side}: ${pair[side]?.revisionId || pair[side]?.digest || "Version bytes unavailable"} · time not retained in this comparison`, "comparison-basis"));
        const provenance = text("details", ""); provenance.append(text("summary", "Exact comparison provenance"), text("pre", JSON.stringify({ scope: pair.scope, retainedOriginal: pair.retainedOriginal ? { ...pair.retainedOriginal, text: undefined } : undefined, renameEvidence: file.renameEvidence, before: pair.before, after: pair.after, snapshotLookup: pair.snapshotLookup, citedReference: pair.citedReference, changeSet: pair.changeSet, leftRecord: pair.leftRecord, rightRecord: pair.rightRecord, recordedResultPacketId: pair.recordedResultPacketId, recordedReviewDecisionId: pair.recordedReviewDecisionId }, null, 2))); body.append(provenance);
        const list = text("ul", ""); list.className = "record-facts";
        for (const symbol of pair.symbols || []) list.append(text("li", `${symbol.after?.qualifiedName || symbol.before?.qualifiedName}: ${symbol.observation}${symbol.locationChanged ? " · line location changed" : ""}`));
        body.append(list);
        if (pair.currentMatchesRecordedAfter === false) body.append(text("p", "Recorded after differs from current. Later changes remain separate.", "hint"));
        if (pair.diff && !pair.diff.changed) body.append(text("p", "No byte differences in this included comparison. Other versions or intervals may differ.", "hint"));
        const regions = pair.diff?.regions || (pair.diff?.before && pair.diff?.after ? [{ before: pair.diff.before, after: pair.diff.after }] : []);
        if (pair.diff?.changed && regions.length) {
          $("show-code-diff").hidden = false; $("jump-diff").disabled = false;
          body.append(text("h3", "Bounded excerpt changes"), text("p", "− removed / + added. Line numbers belong to their respective exact excerpts; not a full-file or semantic comparison.", "hint"));
          if (pair.diff.coverage) body.append(text("p", `Included ${pair.diff.coverage.includedRegionCount}/${pair.diff.coverage.changedRegionCount} changed regions; ${pair.diff.coverage.omittedRegionCount} regions omitted. Excerpts are separate source-contiguous regions, not joined file text.`, "comparison-partial"));
          for (const region of regions) {
          if (typeof region.before?.text !== "string" || typeof region.after?.text !== "string") continue;
          const delta = explorerModel.lineDelta(region.before, region.after), pre = text("pre", "");
          for (const side of ["before", "after"]) {
            const excerpt = region[side];
            if (excerpt.omittedLines || excerpt.textTruncated) body.append(text("p", `Partial comparison excerpt (${side}): ${excerpt.omittedLines ?? "unknown"} omitted lines; text truncated: ${excerpt.textTruncated === true ? "yes" : "no"}. More remains outside this included comparison.`, "comparison-partial"));
          }
          let hunk = null;
          for (const line of delta.lines) {
            if (line.kind === "context") hunk = null;
            else if (!hunk) { hunk = text("span", "", "change-hunk"); hunk.tabIndex = -1; changeHunks.push({ element: hunk, file: fileIndex, pair }); pre.append(hunk); }
            const row = text("span", `${line.kind === "removed" ? "−" : line.kind === "added" ? "+" : " "} ${line.beforeLine ?? "·"}/${line.afterLine ?? "·"} ${line.text}`, `diff-line ${line.kind}`);
            (hunk || pre).append(row);
          }
          if (delta.reasonCode) body.append(text("p", delta.reasonCode, "hint")); else body.append(pre);
          const excerpts = text("details", ""); excerpts.append(text("summary", "Exact before / after excerpts"));
          for (const [side, title] of [["before", "Recorded/cited source"], ["after", pair.scope === "recorded-changeset-snapshot-pair" ? "Recorded after — not necessarily current" : pair.scope === "explicit-work-chain-citation-pair-not-request-boundary" ? "Cited version B — not necessarily current" : "Export-observed current source — not live"]]) {
            const excerpt = region[side]; excerpts.append(text("h3", `${pair.labels?.[side] || title} · line ${excerpt.startLine}`), text("pre", excerpt.text));
            if (excerpt.omittedLines || excerpt.textTruncated) excerpts.append(text("p", "Partial comparison excerpt; more remains in the exact source.", "hint"));
          }
          body.append(excerpts);
          }
        }
        if (pair.reasonCode || pair.gap) body.append(text("p", pair.reasonCode || pair.gap.reasonCode, "hint"));
        for (const gap of pair.gaps || []) body.append(text("p", gap.reasonCode || "Source bytes unavailable", "hint"));
        entries.set(file.path, { body, linked, hunks: changeHunks.slice(firstHunk).map(item => item.element) });
        }
      }
      body.append(text("p", file.unrecordedIntervals, "hint"));
    }
    for (const reason of context.recordedReasons || []) if (relatedIds.has(reason.nodeId)) {
      body.append(text("h3", "Recorded reason (not proven cause)"));
      body.append(text("p", reason.reason || reason.rationale || reason.assessment));
      if (reason.contentPartial) body.append(text("p", `Partial recorded reason; see the exact original. ${JSON.stringify(reason.contentCoverage || {})}`, "hint"));
      body.append(text("p", `${reason.reviewState} · ${reason.reference?.path || reason.nodeId}`, "hint"));
    }
    for (const delta of context.canonChanges || []) if ([delta.review.nodeId, delta.before.nodeId, delta.after.nodeId].some(id => selectedIds.has(id))) {
      body.append(text("h3", "Recorded Canon comparison")); body.append(text("p", delta.status));
      if (delta.rationale) body.append(text("p", delta.rationale));
      for (const change of delta.changes) {
        body.append(text("h3", `${change.field} · ${change.key}`));
        const describe = value => value === undefined || value === null ? "Not present" : Array.isArray(value)
          ? value.map(item => typeof item === "string" ? item : `${item.kind}: ${item.key}`).join("; ") || "(none)" : value === "" ? "(empty)" : String(value);
        // Show changed normalized fields, not a preferred sentence that can
        // conceal retirement, changed conditions or removed relationships.
        for (const field of ["name", "statement", "description", "status", "parentFeatureGroupKeys", "featureGroupKeys", "capabilityKeys", "governedBy", "appliesTo"])
          if (JSON.stringify(change.before?.[field]) !== JSON.stringify(change.after?.[field])) {
            body.append(text("h4", field), text("p", `Before: ${describe(change.before?.[field])}`), text("p", `After: ${describe(change.after?.[field])}`));
          }
      }
      if (delta.omittedChangeCount) body.append(text("p", `${delta.omittedChangeCount} further changes omitted from this view.`, "hint"));
    }
    if (!candidates.length && !relatedIds.size) body.append(text("p", "Select a source or recorded review to follow its available context.", "hint"));
    const retainedFile = previousGraph === activeGraph ? comparisonFiles.findIndex(section => section.comparisonFile === previousFile) : -1;
    if (retainedFile >= 0) fileCursor = retainedFile;
    else {
      const navigatedFiles = comparisonFileNavigation.get(activeGraph);
      let latest = -1;
      comparisonFiles.forEach((section, index) => { const serial = navigatedFiles?.get(section.comparisonFile); if (serial > latest) { latest = serial; fileCursor = index; } });
    }
    changeCursor = previousGraph === activeGraph && previousHunk ? changeHunks.findIndex(item => item.file === fileCursor && item.element === previousHunk.element && item.pair === previousHunk.pair) : -1;
    if (changeCursor < 0) {
      let latest = -1;
      changeHunks.forEach((item, index) => {
        if (item.file !== fileCursor) return;
        const navigation = pairStates.get(item.pair)?.get(comparisonFiles[item.file].comparisonFile.path)?.navigation;
        if (navigation?.element === item.element && navigation.serial > latest) { latest = navigation.serial; changeCursor = index; }
      });
    }
    comparisonPosition();
  }
  function render() {
    setBox();
    const started = performance.now(), found = matches(); visibleMatches = found; foundIds = scopeCache.foundIds;
    hide($("graph"), canvasMode()); hide($("overview"), !canvasMode()); hide($("overview-note"), !canvasMode());
    renderList(found); renderTrail(); if (canvasMode()) renderOverview(scopeCache.shown); else renderGraph(found); renderSelectionCards(); renderDetail();
    document.documentElement.dataset.explorerLastRenderMs = String(performance.now() - started);
  }
  $("project").textContent = data.project ? `${data.project.projectId} · ${data.initialLayer === "code" ? "Source" : "Project"} view` : "No initialized Project. Ordinary work can continue.";
  $("generated").textContent = `Generated ${data.generatedAt}`;
  $("coverage").textContent = `${activeGraph.coverage?.state || activeGraph.status || "unavailable"} · snapshot, not live`;
  $("layer-info").textContent = activeGraph === data.graph ? "Project purpose, work and retained lineage. No Session is selected by this map."
    : "Complete verified structural metadata; no synthetic Project joins. Non-current evidence is labelled separately.";
  if (activeGraph !== data.graph) {
    $("view").disabled = $("axis").disabled = true;
    $("legend-left").textContent = "Structural evidence"; $("legend-right").textContent = "Existing imports & calls";
  }
  $("basis").textContent = JSON.stringify({ project: data.project, basis: data.graph.basis, coverage: data.graph.coverage, boundary: data.graph.boundary, sourceFallback: data.graph.sourceFallback,
    codeBasis: { worldModelId: data.codeGraph.worldModelId, semanticGraphId: data.codeGraph.semanticGraphId, sourceAnchor: data.codeGraph.sourceAnchor, status: data.codeGraph.status, omittedEdgeCount: data.codeGraph.omittedEdgeCount },
    unavailable: data.unavailable, bounds: data.bounds, metrics: data.metrics, interpretation: data.interpretation }, null, 2);
  $("history-body").append(text("p", data.history.status === "not-requested" ? "No history included. Optional --history includes a bounded retained comparison." : `Retained history: ${data.history.status}${data.history.reasonCode ? ` · ${data.history.reasonCode}` : ""}`, "hint"));
  for (const entry of data.history.entries) $("history-body").append(text("div", `${entry.tier} · ${entry.worldModelId}`, "history-entry"));
  if (data.history.diff) { const pre = text("pre", JSON.stringify({ comparison: data.history.comparison, ...data.history.diff }, null, 2)); $("history-body").append(pre); }
  function populateRelationships() {
    const target = $("relation-filter"); target.replaceChildren();
    const option = (value, title) => { const entry = text("option", title); entry.value = value; target.append(entry); };
    option("all", "All relationship types"); for (const type of [...new Set(activeGraph.edges.map(edge => edge.type || edge.relation).filter(Boolean))].sort()) option(type, type);
    target.value = "all";
  }
  for (const id of filterIds) $(id).addEventListener(id === "search" ? "input" : "change", () => {
    listPage = 0; scopeCache = null; if (id !== "search" || $("hide-nonmatches").checked) cancelWork();
    remember(`Scope: ${id}`); render();
  });
  $("records-prev").addEventListener("click", () => { listPage--; renderList(visibleMatches); });
  $("records-next").addEventListener("click", () => { listPage++; renderList(visibleMatches); });
  function changeLayer() {
    const previousSelection = selected?.kind === "node" ? selected.value : null;
    if (cardsCache?.graph) {
      if (!readingStates.has(cardsCache.graph)) readingStates.set(cardsCache.graph, new Map());
      for (const entry of cardsCache.entries.values()) if (entry.scopeIdentity) readingStates.get(cardsCache.graph).set(entry.scopeIdentity, savedReading(entry));
    }
    const operationStatus = jobKind ? "Earlier calculation not completed; committed state retained. Unplaced records remain available." : $("operation-status").textContent;
    cancelWork(false); const next = $("layer").value;
    layerStates.set(activeGraph === data.graph ? "project" : "code", { model, selected, chosenEdges, box: [...box], mapMode, listPage, cardPage, viewHistory, viewCursor, filters: filterState(), connectionResult, connectionKey, operationStatus, comparisonOpen: $("context-lineage").open });
    activeGraph = next === "code" ? data.codeGraph : data.graph;
    const retained = layerStates.get(next); model = retained?.model || newModel(activeGraph); selected = retained?.selected || null; box = retained?.box || [0, 0, 1000, 700];
    $("operation-status").textContent = retained?.operationStatus || "";
    $("context-lineage").open = retained?.comparisonOpen || false;
    chosenEdges = retained?.chosenEdges || new Set(); edgeVersion++; viewHistory = retained?.viewHistory || []; viewCursor = retained?.viewCursor ?? -1;
    connectionResult = retained?.connectionResult || null; connectionKey = retained?.connectionKey || null; cardPage = retained?.cardPage || 0;
    mapMode = retained?.mapMode || "focus"; listPage = retained?.listPage || 0; populateRelationships();
    $("view").value = "all"; $("axis").value = "all"; $("view").disabled = $("axis").disabled = next === "code";
    restoreFilters(retained?.filters || { search: "", "hide-nonmatches": false, axis: "all", view: "all", "include-history": false, "relation-filter": "all", "kind-filter": "all" });
    scopeCache = cardsCache = comparisonsCache = null;
    $("legend-left").textContent = next === "code" ? "Structural evidence" : "Code & sources"; $("legend-right").textContent = next === "code" ? "Existing imports & calls" : "Purpose & work";
    $("layer-info").textContent = next === "code" ? "Complete verified structural metadata; no synthetic Project joins. Non-current evidence is labelled separately." : "Project purpose, work and retained lineage. No Session is selected by this map.";
    $("coverage").textContent = `${activeGraph.coverage?.state || activeGraph.status || "unavailable"} · snapshot, not live`;
    const reference = value => ({ path: value?.path || value?.sourceReference?.path, digest: value?.digest || value?.fileDigest || value?.sourceReference?.digest });
    const previousReference = reference(previousSelection);
    const exact = matches().filter(node => {
      const current = reference(node);
      if (!previousReference.path || !previousReference.digest || previousReference.path !== current.path || previousReference.digest !== current.digest) return false;
      const file = value => /^(?:File|FileRevision|Source|SourceFile)$/.test(value?.kind || "");
      if (file(previousSelection) && file(node)) return true;
      return previousSelection?.kind === node.kind && previousSelection?.qualifiedName && previousSelection.qualifiedName === node.qualifiedName;
    });
    const first = exact.length === 1 ? exact[0] : null;
    if (!retained && first) { startNeighborhood(first); model.choose(first.nodeId); selected = { kind: "node", value: first }; focusCamera(true); remember(`Exact source ${shorten(label(first), 24)}`); }
    else if (!retained) $("layer-info").append(text("p", "No unique exact source identity matches the previous selection in this layer. Choose a record below; names, paths alone and coincident IDs are not an automatic link.", "hint"));
    render();
    if (!retained && first) prepareNeighborhood().catch(calculationFailed); geometryChanged();
  }
  $("layer").addEventListener("change", changeLayer);
  const calculationFailed = error => { cancelWork(false); $("operation-status").textContent = `Calculation failed (${error?.name || "unknown"}); no partial result is presented as complete.`; render(); };
  $("expand").addEventListener("click", () => { runExpansion().catch(calculationFailed); });
  $("expand-direct").addEventListener("click", () => { runDirect().catch(calculationFailed); });
  $("connect-selection").addEventListener("click", () => { runConnections().catch(calculationFailed); });
  $("collapse").addEventListener("click", () => { cancelWork(false); const step = model.collapse(); $("operation-status").textContent = step ? "Folded the last addition only. Shared, selected, pinned and pre-existing records remain." : "No addition to fold."; remember("Fold last addition"); render(); });
  $("cancel-work").addEventListener("click", () => { cancelWork(); render(); });
  for (const [id, direction] of [["back", -1], ["forward", 1]]) $(id).addEventListener("click", () => travelView(viewCursor + direction));
  $("restart").addEventListener("click", () => { if (model.current) { cancelWork(false); const id = model.current; startNeighborhood(model.nodes.get(id), true); model.choose(id); chosenEdges.clear(); edgeVersion++; selected = { kind: "node", value: model.nodes.get(id) }; connectionResult = null; mapMode = "focus"; focusCamera(true); remember("Start here"); render(); prepareNeighborhood().catch(calculationFailed); } });
  $("zoom-in").addEventListener("click", () => { zoom(.8); remember("Zoom in"); }); $("zoom-out").addEventListener("click", () => { zoom(1.25); remember("Zoom out"); });
  $("focus").addEventListener("click", () => { cancelWork(false); if (model.focus) model.place(model.focus); mapMode = "focus"; focusCamera(); remember("Center reading focus"); render(); });
  $("reset").addEventListener("click", () => { fitExplored().catch(calculationFailed); });
  $("overview-button").addEventListener("click", () => { cancelWork(false); mapMode = "overview"; box = [0, 0, 1000, 700]; setBox(); remember("All evidence"); render(); });
  $("overview").addEventListener("click", event => {
    if (suppressClick) return;
    const camera = explorerModel.viewport(box, $("overview").getBoundingClientRect()), point = camera.fromClient(event.clientX, event.clientY);
    const id = overviewModel().hit(point.x, point.y, overviewIncluded(), 8 / camera.scale);
    if (id) selectNode(model.nodes.get(id), event.detail === 0, event);
  });
  $("clear-selection").addEventListener("click", () => { cancelWork(); model.clearSelection(); chosenEdges.clear(); edgeVersion++; selected = null; remember("Clear selection only"); render(); });
  $("only-focus").addEventListener("click", () => { if (selected?.kind === "node") selectNode(selected.value, false, { only: true }); else if (selected) { chosenEdges = new Set([selected.value]); model.clearSelection(); edgeVersion++; cancelWork(); remember("Select only relationship"); render(); } });
  $("restore-scope").addEventListener("click", () => { cancelWork(); $("axis").value = $("view").value = $("relation-filter").value = $("kind-filter").value = "all"; $("hide-nonmatches").checked = false;
    if (selectionValues().some(historical)) $("include-history").checked = true; scopeCache = null; remember("Show selected scope"); render(); });
  $("wide-reading").addEventListener("click", () => { const wide = document.documentElement.dataset.readingWide !== "true"; document.documentElement.dataset.readingWide = String(wide); $("wide-reading").setAttribute("aria-pressed", String(wide)); $("wide-reading").textContent = wide ? "Compact reading area" : "Widen reading area"; redrawCamera(); });
  $("jump-reading").addEventListener("click", () => { $("reading-heading").scrollIntoView({ block: "start" }); $("reading-heading").focus(); });
  $("jump-map").addEventListener("click", () => { const map = canvasMode() ? $("overview") : $("graph"); map.scrollIntoView({ block: "start" }); map.focus(); });
  $("cards-prev").addEventListener("click", () => { cardPage--; renderSelectionCards(); }); $("cards-next").addEventListener("click", () => { cardPage++; renderSelectionCards(); });
  $("roots-prev").addEventListener("click", () => { rootPage--; renderSelectionCards(); }); $("roots-next").addEventListener("click", () => { rootPage++; renderSelectionCards(); });
  for (const [id, delta] of [["file-prev", -1], ["file-next", 1]]) $(id).addEventListener("click", () => {
    $("context-lineage").open = true;
    fileCursor = Math.max(0, Math.min(comparisonFiles.length - 1, fileCursor + delta)); const target = comparisonFiles[fileCursor]; if (target) { target.scrollIntoView({ block: "nearest" }); target.focus(); } comparisonPosition("file");
  });
  for (const [id, delta] of [["change-prev", -1], ["change-next", 1]]) $(id).addEventListener("click", () => {
    $("context-lineage").open = true;
    changeCursor = Math.max(0, Math.min(changeHunks.length - 1, changeCursor + delta)); const target = changeHunks[changeCursor]; if (target) { fileCursor = target.file; target.element.scrollIntoView({ block: "nearest" }); target.element.focus(); } comparisonPosition("hunk");
  });
  $("show-code-diff").addEventListener("click", () => { $("context-lineage").open = true; $("context-lineage").scrollIntoView({ block: "nearest" }); });
  $("jump-diff").addEventListener("click", () => { $("context-lineage").open = true; $("context-lineage").setAttribute("tabindex", "-1"); $("context-lineage").scrollIntoView({ block: "start" }); $("context-lineage").focus(); });
  function cancelGesture() {
    if (drag) { box = [...drag.box]; if (drag.id && drag.original) { if (drag.overview) overviewModel().move(drag.id, drag.original.x, drag.original.y); else model.move(drag.id, drag.original.x, drag.original.y); if (!drag.wasPinned) model.pinned.delete(drag.id); } }
    drag = null; hide($("selection-box"), true); suppressClick = false; setBox(); redrawCamera();
  }
  function bindMap(canvas, overview) {
  const camera = () => explorerModel.viewport(box, canvas.getBoundingClientRect());
  canvas.addEventListener("wheel", event => { if (event.ctrlKey || event.metaKey || event.target.closest?.("[data-card-body]")) return; event.preventDefault(); zoom(event.deltaY > 0 ? 1.12 : .89); }, { passive: false });
  canvas.addEventListener("pointerdown", event => {
    if (event.button !== 0 || event.target.closest("[data-edge]") || event.target.closest("[data-card-control]")) return;
    if (jobKind === "fit" || jobKind === "geometry" || jobKind === "disclosure") cancelWork();
    const transform = camera(), at = transform.fromClient(event.clientX, event.clientY);
    const node = event.target.closest("[data-node]"), id = overview ? overviewModel().hit(at.x, at.y, overviewIncluded(), 8 / transform.scale) : node?.getAttribute("data-node");
    if (!overview && node && event.target !== node && !event.target.closest("[data-card-header]")) return;
    const rectangle = $("rectangle-mode").checked || event.shiftKey && !id;
    const original = id ? (overview ? overviewModel().points : model.positions).get(id) : null;
    drag = { id: rectangle ? null : id, rectangle, transform, at, overview, original: original && { ...original }, wasPinned: model.pinned.has(id), clientX: event.clientX, clientY: event.clientY, box: [...box], moved: false };
    // Capturing a plain SVG-node pointerup at the map retargets its native
    // click to the map as well. Capture background/Canvas now, node drags
    // only after the movement threshold; ordinary node clicks keep their target.
    if (overview || rectangle || !id) canvas.setPointerCapture(event.pointerId);
    suppressClick = false;
  });
  canvas.addEventListener("pointermove", event => {
    if (!drag) return;
    if (Math.hypot(event.clientX - drag.clientX, event.clientY - drag.clientY) < 5 && !drag.moved) return;
    const at = drag.transform.fromClient(event.clientX, event.clientY);
    if (!drag.moved && drag.id && !overview) canvas.setPointerCapture(event.pointerId);
    drag.moved = true;
    if (drag.rectangle) {
      hide($("selection-box"), false); const ghost = $("selection-rect");
      for (const [key, value] of Object.entries({ x: Math.min(event.clientX, drag.clientX), y: Math.min(event.clientY, drag.clientY), width: Math.abs(event.clientX - drag.clientX), height: Math.abs(event.clientY - drag.clientY) })) ghost.setAttribute(key, String(value)); return;
    }
    if (drag.id && drag.original) { const x = drag.original.x + at.x - drag.at.x, y = drag.original.y + at.y - drag.at.y;
      if (overview) { overviewModel().move(drag.id, x, y); model.pinned.add(drag.id); } else model.move(drag.id, x, y);
    } else { cameraIntent++; box = [drag.box[0] - (at.x - drag.at.x), drag.box[1] - (at.y - drag.at.y), ...drag.box.slice(2)]; setBox(); }
    redrawCamera();
  });
  canvas.addEventListener("pointerup", event => {
    const state = drag; drag = null; hide($("selection-box"), true); suppressClick = Boolean(state?.moved);
    if (state?.rectangle && state.moved) {
      const finish = state.transform.fromClient(event.clientX, event.clientY), left = Math.min(state.at.x, finish.x), right = Math.max(state.at.x, finish.x), top = Math.min(state.at.y, finish.y), bottom = Math.max(state.at.y, finish.y);
      const positions = overview ? overviewModel().points : model.positions, included = overview ? overviewIncluded() : drawnNodeIds, picked = [];
      cancelWork(false);
      const selection = { left: Math.max(left, box[0]), right: Math.min(right, box[0] + box[2]), top: Math.max(top, box[1]), bottom: Math.min(bottom, box[1] + box[3]) };
      for (const id of included) {
        const point = positions.get(id); if (!point) continue;
        if (overview ? point.x >= selection.left && point.x <= selection.right && point.y >= selection.top && point.y <= selection.bottom
          : explorerCards.intersects(selection, explorerCards.bounds(point, model.extent(id)))) picked.push(id);
      }
      const serial = ++jobSerial, previous = selected, basis = metrics().key; busy = true; jobKind = "rectangle"; $("cancel-work").disabled = false;
      $("operation-status").textContent = `Selecting ${picked.length} visible records…`;
      model.chooseBatch(picked, { position: !overview, yieldWork, cancelled: () => serial !== jobSerial || metrics().key !== basis }).then(applied => {
        if (serial !== jobSerial) return;
        if (!applied) { supersededCalculation(serial); return; }
        if (selected !== previous && selected?.kind === "node") model.choose(selected.value.nodeId, { position: !overview });
        else selected = model.focus ? { kind: "node", value: model.nodes.get(model.focus) } : selected;
        busy = false; jobKind = null; $("cancel-work").disabled = true; $("operation-status").textContent = `Added the rectangle's ${picked.length} records to selection; camera and mode retained.`; remember("Rectangle selection"); render();
      }).catch(calculationFailed);
    } else if (state?.moved) remember(state.id ? "Pin position" : "Pan camera");
    if (state?.moved) setTimeout(() => { suppressClick = false; }, 0);
  });
  canvas.addEventListener("pointercancel", cancelGesture);
   canvas.addEventListener("keydown", event => { if (event.target !== canvas) return; const delta = { ArrowLeft: [-50, 0], ArrowRight: [50, 0], ArrowUp: [0, -50], ArrowDown: [0, 50] }[event.key]; if (delta) { event.preventDefault(); cameraIntent++; box[0] += delta[0]; box[1] += delta[1]; setBox(); redrawCamera(); remember("Pan camera with keyboard"); } });
  canvas.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); cancelGesture(); cancelWork(); render(); } });
  }
  bindMap($("graph"), false); bindMap($("overview"), true);
  if (typeof globalThis.addEventListener === "function") { globalThis.addEventListener("resize", () => { geometryChanged(); redrawCamera(); }); globalThis.addEventListener("keydown", event => { if (event.key === "Escape") { cancelGesture(); cancelWork(); render(); } }); }
  if (typeof ResizeObserver === "function") new ResizeObserver(geometryChanged).observe(document.documentElement);
  if (document.fonts) {
    const loaded = () => { fontEpoch++; geometryChanged(); };
    // An already-resolved fonts.ready is not a metric change: treating it as
    // one would supersede every initial async neighborhood in real browsers.
    if (typeof document.fonts.addEventListener === "function") document.fonts.addEventListener("loadingdone", loaded);
    else if (document.fonts.status === "loading") document.fonts.ready?.then(loaded);
  }
  if (typeof matchMedia === "function") {
    const narrow = matchMedia("(max-width:650px)").matches;
    $("selection-tools").open = !narrow;
    if (narrow) $("display-options").open = false;
  }
  populateRelationships();
  const initialMatches = matches(), explicitFocus = (activeGraph === data.graph ? data.graph.detailSelection?.anchorIds : activeGraph.focusSelection?.requestedIds)?.length > 0;
  const first = explicitFocus ? model.nodes.get(activeGraph.initialNodeId) : initialMatches.find(node => node.nodeId === activeGraph.initialNodeId) || initialMatches[0];
  if (first) { startNeighborhood(first); model.choose(first.nodeId); selected = { kind: "node", value: first }; if (inDisplayScope(first)) focusCamera(true); remember(`Start ${shorten(label(first), 24)}`); }
  else if (explicitFocus) $("operation-status").textContent = "The exact requested record was not retained in this layer. No different record was selected; choose available evidence or regenerate at a new basis.";
  render();
  if (first) prepareNeighborhood().catch(calculationFailed);
  document.documentElement.dataset.explorerReady = "true"; document.documentElement.dataset.explorerInitialRenderMs = String(performance.now() - initialTime);
})();

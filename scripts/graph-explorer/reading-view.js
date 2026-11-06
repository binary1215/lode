// Export-local reading UI. State is display-only; no writer or runtime calls.
const explorerReadingView = (() => {
  function create(options) {
    const { snapshot, getGraph, getSelected, describe, label, relation, eligible, scopeKey,
      select, remember, beforeNavigate, renderAll, openComparison } = options;
    const $ = id => document.getElementById(id), models = new WeakMap(), states = new WeakMap();
    const text = (tag, value, className) => { const el = document.createElement(tag); el.textContent = String(value ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")); if (className) el.className = className; return el; };
    const button = (title, action) => { const el = text("button", title); el.addEventListener("click", action); return el; };
    const exactModel = () => {
      const graph = getGraph();
      if (!models.has(graph)) models.set(graph, explorerReadingModel.create(snapshot, graph));
      return models.get(graph);
    };
    const state = () => {
      const graph = getGraph();
      if (!states.has(graph)) states.set(graph, { source: null, groups: new Map(), groupStart: null, factStart: 0, bodyCursor: { block: 0, offset: 0 }, bodyHistory: [], cached: null });
      return states.get(graph);
    };
    let serial = 0, renderKey = null;
    function invalidate() { serial++; }
    function capture() {
      const basis = explorerReadingModel.basisFor(snapshot, getGraph()), current = state();
      return { basis, focusKey: current.focusKey, source: current.source ? JSON.parse(JSON.stringify(current.source)) : null,
        groups: [...current.groups].map(([key, value]) => [key, { ...value }]), groupStart: current.groupStart, factStart: current.factStart, bodyCursor: { ...current.bodyCursor }, bodyHistory: current.bodyHistory.map(item => ({ ...item })),
        panels: [...document.body.querySelectorAll("[data-reading-key]")].map(el => ({
          key: el.getAttribute("data-reading-key"), open: typeof el.open === "boolean" ? el.open : undefined,
          top: el.scrollTop || 0, left: el.scrollLeft || 0,
        })), scroll: { x: globalThis.scrollX || 0, y: globalThis.scrollY || 0 },
        focusId: document.activeElement?.id || null,
        focus: document.activeElement?.getAttribute?.("data-reading-focus") || document.activeElement?.getAttribute?.("data-record-entry") || document.activeElement?.getAttribute?.("data-record-toggle") || null };
    }
    function restore(saved) {
      const model = exactModel();
      if (!saved || saved.basis !== model.basis) return;
      const ticket = ++serial, current = state();
      current.source = saved.source && model.resolve(saved.source.address) ? JSON.parse(JSON.stringify(saved.source)) : null;
      current.groups = new Map((saved.groups || []).map(([key, value]) => [key, { ...value }])); current.groupStart = saved.groupStart; current.factStart = saved.factStart || 0;
      current.bodyCursor = { ...(saved.bodyCursor || { block: 0, offset: 0 }) }; current.bodyHistory = (saved.bodyHistory || []).map(item => ({ ...item }));
      current.focusKey = saved.focusKey; current.cached = null;
      $("reading-neighbors").removeAttribute("data-group-render");
      renderKey = null; renderAll();
      requestAnimationFrame(() => {
        if (ticket !== serial || exactModel().basis !== saved.basis) return;
        const elements = new Map([...document.body.querySelectorAll("[data-reading-key]")].map(el => [el.getAttribute("data-reading-key"), el]));
        for (const item of saved.panels || []) {
          const el = elements.get(item.key); if (!el) continue;
          if (typeof item.open === "boolean" && typeof el.open === "boolean") el.open = item.open;
          el.scrollTop = item.top; el.scrollLeft = item.left;
        }
        if (typeof globalThis.scrollTo === "function") globalThis.scrollTo(saved.scroll?.x || 0, saved.scroll?.y || 0);
        if (saved.focus) [...document.body.querySelectorAll("[data-reading-focus]"), ...document.body.querySelectorAll("[data-record-entry]"), ...document.body.querySelectorAll("[data-record-toggle]")]
          .find(el => (el.getAttribute("data-reading-focus") || el.getAttribute("data-record-entry") || el.getAttribute("data-record-toggle")) === saved.focus)?.focus({ preventScroll: true });
        else if (saved.focusId) $(saved.focusId)?.focus({ preventScroll: true });
        options.afterNavigate?.();
      });
    }
    function beginNavigation() { beforeNavigate(); invalidate(); }
    function openSource(value, address) {
      const model = exactModel(), exact = model.resolve(address);
      if (!exact) return;
      const previous = state().source;
      const returnReading = previous?.returnReading || { ...capture(), source: null };
      const returnTab = previous?.returnTab || options.getReadingTab?.() || "explanation";
      beginNavigation(); options.activateSource?.(); select(value); options.activateSource?.();
      state().source = { address: exact, choice: null, chunkStart: null, firstLine: exact.span?.startLine || 1, returnReading, returnTab };
      renderKey = null; renderAll(); remember("Read source: " + exact.path);
      const ticket = serial;
      requestAnimationFrame(() => {
        if (ticket !== serial || !exactModel().resolve(exact)) return;
        $("reading-source").scrollIntoView({ block: "nearest" });
        $("reading-source-code").focus({ preventScroll: true });
        options.afterNavigate?.();
      });
    }
    function returnToRecord() {
      const current = state().source, model = exactModel();
      if (!current || !model.resolve(current.address)) return false;
      const value = model.origin(current.address);
      if (!value) return false;
      beginNavigation(); state().source = null; select(value); options.activateRecord?.(current.returnTab); renderKey = null; renderAll();
      remember("Return to record: " + label(value));
      if (current.returnReading) restore(current.returnReading);
      else { $("reading-flow").scrollIntoView({ block: "nearest" }); $("reading-flow-title").focus(); options.afterNavigate?.(); }
      return true;
    }
    function compare(choice) {
      const current = state().source, model = exactModel();
      if (!current) return;
      const read = model.read(current.address, choice);
      if (!read.selected) return;
      beginNavigation(); current.choice = { key: choice.key, side: choice.side }; options.activateSource?.();
      select(model.origin(current.address)); renderKey = null; renderAll();
      const result = openComparison(read.selected, current.address);
      $("reading-source-status").textContent += result?.spanIncluded === false
        ? " Requested span is not included in this comparison; no unchanged or execution claim." : "";
      remember("Read exact comparison: " + choice.side + " " + current.address.path);
    }
    function bindPairReturn(control, file, pair) {
      control.setAttribute("data-reading-return-pair", exactModel().pairKey(file, pair));
      control.setAttribute("data-reading-focus", JSON.stringify([exactModel().basis, "return-to-record", exactModel().pairKey(file, pair)]));
      control.addEventListener("click", () => {
        const source = state().source;
        if (source && exactModel().comparisons(source.address).some(item => item.key === control.getAttribute("data-reading-return-pair"))) returnToRecord();
      });
    }
    function renderSource() {
      const current = state().source, model = exactModel(), panel = $("reading-source");
      panel.hidden = !current;
      if (!current) return;
      const read = model.read(current.address, current.choice);
      $("reading-source-title").textContent = current.address.path;
      $("reading-source-status").textContent = [explorerCards.statusLabel(read.status), current.address.span
        ? "Recorded lines " + current.address.span.startLine + "–" + current.address.span.endLine : "File reference; no recorded line range"].filter(Boolean).join(" · ");
      const technical = $("reading-source-technical"), sourceKey = JSON.stringify([model.basis, "source-technical", current.address.key, current.choice]);
      if (technical.getAttribute("data-reading-key") !== sourceKey) technical.open = false;
      technical.setAttribute("data-reading-key", sourceKey);
      $("reading-source-technical-body").textContent = JSON.stringify({ address: current.address, choice: current.choice, status: read.status,
        comparison: read.selected ? { before: read.selected.pair.before, after: read.selected.pair.after, scope: read.selected.pair.scope } : null }, null, 2);
      const choices = $("reading-source-choices"); choices.replaceChildren();
      const allChoices = read.choices || [];
      const choicePage = Math.floor(Math.max(0, allChoices.findIndex(choice => choice.key + choice.side === current.firstChoice)) / 20);
      for (const choice of allChoices.slice(choicePage * 20, (choicePage + 1) * 20)) {
        const index = allChoices.indexOf(choice) + 1;
        const control = button("Comparison " + index + " · " + explorerCards.comparisonSide(choice.pair, choice.side), () => compare(choice));
        control.setAttribute("data-reading-comparison", choice.key); choices.append(control);
      }
      $("reading-choices-range").textContent = allChoices.length ? (choicePage * 20 + 1) + "–" + Math.min(allChoices.length, (choicePage + 1) * 20) + " / " + allChoices.length + " exact comparison sides" : "No retained comparison sides";
      $("reading-choices-prev").disabled = choicePage === 0; $("reading-choices-next").disabled = (choicePage + 1) * 20 >= allChoices.length;
      for (const [id, delta] of [["reading-choices-prev", -1], ["reading-choices-next", 1]]) $(id).onclick = () => { const choice = allChoices[(choicePage + delta) * 20]; if (choice) { current.firstChoice = choice.key + choice.side; renderSource(); } };
      const code = $("reading-source-code"); code.replaceChildren();
      $("reading-source-prev").disabled = $("reading-source-next").disabled = true;
      $("reading-source-prev").onclick = $("reading-source-next").onclick = null; $("reading-source-range").textContent = "";
      code.setAttribute("data-reading-key", JSON.stringify([model.basis, "source-code", current.address.key, current.choice]));
      code.setAttribute("data-reading-focus", current.address.key);
      if (!read.chunks.length) { code.append(text("span", "Exact text is not included for this address. Available records and file candidates remain readable.")); return; }
      let at = read.chunks.findIndex(chunk => chunk.startLine === current.chunkStart);
      if (at < 0) at = Math.max(0, read.chunks.findIndex(chunk => chunk.startLine <= current.firstLine && chunk.startLine + chunk.text.split("\n").length > current.firstLine));
      const chunk = read.chunks[at], lines = chunk.text.split("\n");
      current.chunkStart = chunk.startLine;
      const page = Math.max(0, Math.min(Math.floor((current.firstLine - chunk.startLine) / 80), Math.ceil(lines.length / 80) - 1));
      const start = page * 80; current.firstLine = chunk.startLine + start;
      for (let i = start; i < Math.min(lines.length, start + 80); i++) {
        const line = chunk.startLine + i;
        const highlighted = Boolean(read.status === "available" && current.address.span && line >= current.address.span.startLine && line <= current.address.span.endLine);
        const row = text("span", line + "  " + lines[i] + "\n", highlighted ? "reading-source-line reading-highlight" : "reading-source-line");
        row.setAttribute("data-reading-line", String(line)); code.append(row);
      }
      const range = $("reading-source-range"); range.textContent = "Included region " + (at + 1) + "/" + read.chunks.length
        + " · lines " + (chunk.startLine + start) + "–" + (chunk.startLine + Math.min(lines.length, start + 80) - 1)
        + (chunk.completeOriginal ? " · exact original bytes" : " · bounded excerpt; other source remains outside this region");
      $("reading-source-prev").disabled = at === 0 && page === 0;
      $("reading-source-next").disabled = at === read.chunks.length - 1 && start + 80 >= lines.length;
      $("reading-source-prev").onclick = () => {
        if (page) current.firstLine -= 80;
        else { const previous = read.chunks[at - 1]; current.chunkStart = previous.startLine; current.firstLine = previous.startLine + Math.floor((previous.text.split("\n").length - 1) / 80) * 80; }
        renderSource();
      };
      $("reading-source-next").onclick = () => {
        if (start + 80 < lines.length) current.firstLine += 80;
        else { current.chunkStart = read.chunks[at + 1].startLine; current.firstLine = current.chunkStart; }
        renderSource();
      };
    }
    function renderDocument(descriptor, current, identity) {
      const target = $("reading-flow-description"); target.replaceChildren();
      const authored = descriptor.body && descriptor.body !== descriptor.title ? descriptor.body : "";
      if (current.documentText !== authored) { current.documentText = authored; current.documentModel = explorerDocument.create(authored); }
      const page = current.documentModel.page(current.bodyCursor);
      let list = null;
      for (const block of page.blocks) {
        if (block.omittedTextUnitLength) {
          list = null;
          const note = text("div", "A single text unit exceeds this display page. Its full retained text is available in the exported record.", "reading-text-partial");
          note.append(button("Read full exported record", () => options.openExportedRecord?.())); target.append(note); continue;
        }
        let node;
        if (block.kind === "item") {
          if (!list) { list = text("ul", "", "reading-authored-list"); target.append(list); }
          node = text("li", ""); node.append(text("span", block.marker, "reading-list-marker"), text("span", block.text)); list.append(node);
        } else {
          list = null; node = text(block.kind === "heading" ? "h" + Math.min(6, block.level + 2) : block.kind === "code" || block.kind === "literal" ? "pre" : "p", block.text, "reading-authored-" + block.kind); target.append(node);
        }
        if (block.partial || block.continued) node.append(text("span", block.partial ? "\nMore of this text continues on the next page." : "\nContinued from the previous page.", "reading-text-partial"));
      }
      if (!authored && !descriptor.facts.length && !descriptor.excerpts.length) target.append(text("p", "No recorded description is included. Follow a connected record or source.", "hint"));
      const nav = $("reading-document-pages"); nav.hidden = !current.bodyHistory.length && !page.next;
      nav.setAttribute("data-reading-key", identity + ":document-page");
      $("reading-document-range").textContent = "Text part " + (current.bodyHistory.length + 1) + (page.next ? " · more recorded text remains" : "");
      $("reading-document-prev").disabled = !current.bodyHistory.length; $("reading-document-next").disabled = !page.next;
      const move = next => { beforeNavigate(); invalidate(); if (next) { current.bodyHistory.push({ ...current.bodyCursor }); current.bodyCursor = page.next; } else current.bodyCursor = current.bodyHistory.pop(); renderKey = null; render(); remember("Read recorded text"); target.scrollIntoView({ block: "nearest" }); target.setAttribute("tabindex", "-1"); target.focus(); options.afterNavigate?.(); };
      $("reading-document-prev").onclick = () => { if (current.bodyHistory.length) move(false); };
      $("reading-document-next").onclick = () => { if (page.next) move(true); };
    }
    function renderNext(value, current, cacheKey) {
      if (current.nextKey === cacheKey) return;
      current.nextKey = cacheKey;
      const target = $("reading-next"); target.replaceChildren();
      const preview = exactModel().nextRead(value, eligible);
      for (const row of preview.rows) {
        const descriptor = describe(row.node), card = text("div", "", "reading-next-card");
        const direction = row.direction === "incoming" ? "← " : "→ ";
        card.append(text("p", direction + relation({ type: row.type }) + (row.edges.length > 1 ? " · " + row.edges.length + " recorded links" : ""), "reading-next-relation"));
        const control = button(descriptor.title, () => options.navigateNode(row.node)); control.setAttribute("data-next-record", row.node.nodeId); control.setAttribute("data-reading-focus", JSON.stringify([cacheKey, "next-record", row.direction, row.type, row.node.nodeId])); card.append(control);
        card.append(text("p", descriptor.kind, "hint"));
        if (descriptor.summaryConditions.length) card.append(text("p", descriptor.summaryConditions.join(" · "), "card-conditions"));
        target.append(card);
      }
      if (!preview.rows.length) target.append(text("p", "No other connected record is included in this scope. Self-links and available references remain in all recorded connections.", "hint"));
      $("reading-all-relations-label").textContent = "All recorded connections · " + preview.included;
      const all = $("reading-all-relations"); if (all.getAttribute("data-reading-key") !== cacheKey + ":all-relations") all.open = false; all.setAttribute("data-reading-key", cacheKey + ":all-relations");
    }
    function render() {
      if (!getSelected()) { $("reading-flow").hidden = $("reading-source").hidden = true; $("reading-empty").hidden = false; state().source = null; return; }
      const model = exactModel(), value = model.origin(getSelected()), current = state();
      const selectionPanel = $("reading-selection"); if (selectionPanel.getAttribute("data-reading-key") !== model.basis + ":selection") selectionPanel.open = false; selectionPanel.setAttribute("data-reading-key", model.basis + ":selection");
      const panel = $("reading-flow"); panel.hidden = !value; $("reading-empty").hidden = Boolean(value);
      $("reading-source-empty").hidden = Boolean(current.source) || options.getReadingTab?.() !== "source";
      if (value) {
        const descriptor = describe(value), id = value.nodeId || value.edgeId;
        const focusKey = JSON.stringify([model.basis, id]);
        if (current.focusKey !== focusKey) {
          current.focusKey = focusKey; current.factStart = 0; current.bodyCursor = { block: 0, offset: 0 }; current.bodyHistory = [];
          if (current.source && (current.source.address.nodeId || current.source.address.edgeId) !== id) current.source = null;
        }
        const identity = JSON.stringify([model.basis, id, scopeKey()]);
        $("reading-flow-title").textContent = descriptor.title;
        $("reading-flow-title").setAttribute("data-reading-focus", focusKey);
        $("reading-flow-status").textContent = [descriptor.kind, ...descriptor.summaryConditions].join(" · ");
        const technical = $("reading-technical");
        if (technical.getAttribute("data-reading-key") !== focusKey + ":technical") technical.open = false;
        technical.setAttribute("data-reading-key", focusKey + ":technical");
        $("reading-technical-body").textContent = JSON.stringify({ record: descriptor.technical, graph: { basis: getGraph().basis, coverage: getGraph().coverage, omittedEdgeCount: getGraph().omittedEdgeCount } }, null, 2);
        if (renderKey !== identity) {
          renderKey = identity;
          renderDocument(descriptor, current, identity);
          const facts = descriptor.facts.flatMap(([heading, items]) => items.map((item, index) => ({ heading, item, index })));
          const factsBox = $("reading-explanation");
          factsBox.hidden = !facts.length && !descriptor.excerpts.length;
          factsBox.setAttribute("data-reading-key", JSON.stringify([model.basis, id, "explanation"]));
          const body = $("reading-facts");
          const showFacts = () => {
            body.replaceChildren();
            const from = Math.max(0, Math.min(current.factStart, Math.max(0, facts.length - 1)));
            current.factStart = Math.floor(from / 20) * 20;
            for (const row of facts.slice(current.factStart, current.factStart + 20)) {
              const section = text("div", "", "reading-fact");
              section.append(text("strong", row.heading));
              if (typeof row.item === "string") section.append(text("p", row.item));
              else if (row.item && typeof row.item === "object") {
                section.append(text("p", explorerCards.factText(row.item)));
                if (row.item.reason) section.append(text("p", row.item.reason));
                for (const alternative of row.item.alternatives || []) section.append(text("p", alternative));
              }
              body.append(section);
            }
            for (const excerpt of descriptor.excerpts) body.append(text("strong", excerpt.heading), text("pre", excerpt.text));
            $("reading-facts-range").textContent = facts.length ? (current.factStart + 1) + "–" + Math.min(facts.length, current.factStart + 20) + " / " + facts.length + " recorded facts" : "Recorded excerpts";
            $("reading-facts-prev").disabled = current.factStart === 0; $("reading-facts-next").disabled = current.factStart + 20 >= facts.length;
          };
          $("reading-facts-prev").onclick = () => { current.factStart -= 20; showFacts(); };
          $("reading-facts-next").onclick = () => { current.factStart += 20; showFacts(); };
          showFacts();
          const sources = $("reading-sources"); sources.replaceChildren();
          for (const address of model.addresses(value)) {
            const control = button("Read " + address.role + " · " + address.path, () => openSource(value, address));
            control.setAttribute("data-reading-focus", address.key); sources.append(control);
          }
        }
        const cacheKey = JSON.stringify([model.basis, id, scopeKey()]);
        if (current.cached?.key !== cacheKey) current.cached = { key: cacheKey, ...model.groups(value, eligible) };
        const grouped = current.cached, groups = grouped.groups;
        renderNext(value, current, cacheKey);
        $("reading-relations-status").textContent = grouped.included + " retained links"
          + (grouped.filteredKnown ? " · " + grouped.filteredKnown + " outside the current scope" : "")
          + (grouped.unknownEndpoints ? " · " + grouped.unknownEndpoints + " links have targets not included" : "")
          + (grouped.omitted ? " · the export omits " + grouped.omitted + " relationships" : grouped.omitted == null ? " · links outside the export are unknown" : "");
        const first = Math.max(0, groups.findIndex(group => group.key === current.groupStart));
        const page = Math.floor(first / 20), target = $("reading-neighbors");
        const groupRenderKey = JSON.stringify([cacheKey, page]);
        if (target.getAttribute("data-group-render") !== groupRenderKey) {
          target.setAttribute("data-group-render", groupRenderKey); target.replaceChildren();
          for (const group of groups.slice(page * 20, (page + 1) * 20)) {
            const details = text("details", "", "reading-neighbor-group");
            details.setAttribute("data-reading-key", group.key);
            details.append(text("summary", group.direction + " · " + relation({ type: group.type }) + " · " + group.edges.length + " shown / " + group.included + " recorded"));
            const state = current.groups.get(group.key) || { open: false, firstEdge: null };
            current.groups.set(group.key, state); details.open = state.open;
            const rows = text("div", "", "reading-neighbor-rows"), nav = text("nav", "", "list-pages");
            const range = text("span", ""), previous = button("Previous members", () => move(-1)), next = button("More members", () => move(1));
            nav.append(range, previous, next); details.append(rows, nav);
            let memberPage = Math.floor(Math.max(0, group.edges.findIndex(edge => edge.edgeId === state.firstEdge)) / 20);
            let filledPage = null;
            const fill = () => {
              if (!details.open) { rows.replaceChildren(); filledPage = null; return; }
              // Native toggle can arrive after history restored focus. Do not
              // replace an already rendered exact page and detach its trigger.
              if (filledPage === memberPage) return;
              filledPage = memberPage; rows.replaceChildren();
              for (const edge of group.edges.slice(memberPage * 20, (memberPage + 1) * 20)) {
                const row = text("div", "", "reading-neighbor");
                const from = model.nodes.get(edge.from), to = model.nodes.get(edge.to);
                row.append(text("p", (from ? label(from) : "Not exported") + " → " + (to ? label(to) : "Not exported") + " · " + relation(edge)));
                const relationButton = button("Read relation", () => options.selectRelation(edge));
                relationButton.setAttribute("data-reading-focus", JSON.stringify([cacheKey, group.key, edge.edgeId, "relation"])); row.append(relationButton);
                const targets = value.nodeId ? [edge.from === value.nodeId ? edge.to : edge.from] : [...new Set([edge.from, edge.to])];
                for (const targetId of targets) {
                  const node = model.nodes.get(targetId);
                  if (node) {
                    const targetButton = button("Read " + label(node), () => options.navigateNode(node));
                    targetButton.setAttribute("data-reading-focus", JSON.stringify([cacheKey, group.key, edge.edgeId, "target", targetId])); row.append(targetButton);
                    const conditions = describe(node).summaryConditions;
                    if (conditions.length) row.append(text("p", conditions.join(" · "), "card-conditions"));
                  }
                }
                rows.append(row);
              }
              range.textContent = (group.edges.length ? memberPage * 20 + 1 : 0) + "–" + Math.min(group.edges.length, (memberPage + 1) * 20) + " / " + group.edges.length;
              previous.disabled = memberPage === 0; next.disabled = (memberPage + 1) * 20 >= group.edges.length;
            };
            function move(delta) { memberPage += delta; state.firstEdge = group.edges[memberPage * 20]?.edgeId || null; fill(); }
            details.addEventListener("toggle", () => { state.open = details.open; fill(); });
            fill(); target.append(details);
          }
        }
        $("reading-groups-range").textContent = (groups.length ? page * 20 + 1 : 0) + "–" + Math.min(groups.length, (page + 1) * 20) + " / " + groups.length + " direction/type groups";
        $("reading-groups-prev").disabled = page === 0; $("reading-groups-next").disabled = (page + 1) * 20 >= groups.length;
        $("reading-groups-prev").onclick = () => { current.groupStart = groups[(page - 1) * 20].key; render(); };
        $("reading-groups-next").onclick = () => { current.groupStart = groups[(page + 1) * 20].key; render(); };
      }
      renderSource();
      const source = current.source;
      const pairKeys = source ? new Set(model.comparisons(source.address).map(item => item.key)) : new Set();
      for (const control of document.body.querySelectorAll("[data-reading-return-pair]")) control.hidden = !pairKeys.has(control.getAttribute("data-reading-return-pair"));
    }
    function closeSource() { return returnToRecord(); }
    $("reading-source-close").addEventListener("click", closeSource);
    $("reading-source-return").addEventListener("click", returnToRecord);
    return { render, capture, restore, invalidate, model: exactModel, bindPairReturn, openSource,
      escape: closeSource };
  }
  return { create };
})();

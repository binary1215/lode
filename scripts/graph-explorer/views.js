// The frame and the status, product graph and gaps views of the offline
// report. Every string of these views comes from explorerText (one table per
// language); words the product graph build produced are shown as they are.
// Only expanded tree levels are in the DOM. Nothing here changes anything.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let data = null;
  try {
    data = explorerCodec.decode(JSON.parse($("snapshot").textContent));
  } catch {
    data = null;
  }
  globalThis.explorerSnapshotData = data;
  const lang = data?.lang === "ko" ? "ko" : "en";
  const T = explorerText[lang];
  const t = (key, ...args) => {
    const value = T[key];
    if (value === undefined) throw new Error(`Missing text ${key}`);
    return typeof value === "function" ? value(...args) : value;
  };
  const PAGE = 50;
  const el = (tag, options = {}, ...children) => {
    const node = document.createElement(tag);
    if (options.className) node.className = options.className;
    // Controls and bidi marks are shown as \uXXXX, never applied (B3).
    if (options.text !== undefined) node.textContent = explorerReading.displayText(options.text);
    for (const [name, value] of Object.entries(options.attrs || {})) node.setAttribute(name, value);
    if (options.onClick) node.addEventListener("click", options.onClick);
    for (const child of children) if (child) node.append(child);
    return node;
  };
  const hide = (node, value) => {
    node.hidden = value;
    if (value) node.setAttribute("hidden", "");
    else node.removeAttribute("hidden");
  };
  const button = (text, onClick, className = "link-button", attrs = {}) => el("button", { text, onClick, className, attrs: { type: "button", ...attrs } });
  const badge = (text, kind) => el("span", { text, className: `badge badge-${kind}` });
  // Authored text with headings, lists and code fences as blocks; inline
  // Markdown stays literal. Rendered through textContent only.
  const richText = (text) => {
    const box = el("div", { className: "rich-text" });
    for (const block of explorerReading.blocks(text)) {
      if (block.kind === "heading") box.append(el("p", { className: `rich-heading rich-h${block.level}`, text: block.text }));
      else if (block.kind === "list") box.append(el(block.ordered ? "ol" : "ul", {}, ...block.items.map((item) => el("li", { text: item }))));
      else if (block.kind === "code") box.append(el("pre", { className: "rich-code", text: block.text }));
      else box.append(el("p", { text: block.text }));
    }
    return box;
  };
  // One line stays a line; text with line breaks becomes blocks.
  const authored = (text, className = "") =>
    /\n/.test(String(text ?? "")) ? el("div", { className: `${className} rich`.trim() }, richText(text)) : el("span", { className, text });
  const reasonLine = (reason) =>
    /\n/.test(String(reason ?? "")) ? el("div", {}, el("div", { text: t("reasonHeading") }), richText(reason)) : el("div", { text: t("reason", reason || t("noReason")) });

  // A bounded reader of an exported original: line numbers, the recorded
  // line range marked when the reference has one, PAGE_LINES lines a page.
  function sourceReader(text, span) {
    const box = el("div", { className: "source-reader" });
    let page = null;
    const draw = (focus = null) => {
      const view = explorerReading.sourcePage(text, { page, span });
      page = view.page;
      const nav = el(
        "div",
        { className: "source-nav" },
        el("span", { className: "hint", text: view.span ? t("recordedSpan", view.span.startLine, view.span.endLine) : t("noRecordedSpan") }),
        el("span", { className: "hint", text: t("sourceLines", view.from, view.to, view.total) }),
      );
      const previous = view.page > 0 ? button(t("sourcePrevious", view.pageLines), () => ((page -= 1), draw("previous"))) : null;
      const next = view.page < view.pages - 1 ? button(t("sourceNext", view.pageLines), () => ((page += 1), draw("next"))) : null;
      if (previous) nav.append(previous);
      if (next) nav.append(next);
      const lines = el(
        "div",
        { className: "source-lines" },
        ...view.lines.map((line) =>
          el(
            "div",
            { className: line.inSpan ? "source-line in-span" : "source-line" },
            el("span", { className: "source-no", text: String(line.number), attrs: { "aria-hidden": "true" } }),
            el("span", { className: "source-text", text: line.text || " " }),
          ),
        ),
      );
      box.replaceChildren(nav, lines);
      // Paging keeps the keyboard where it was.
      const target = focus === "previous" ? previous || next : focus === "next" ? next || previous : null;
      if (target) target.focus();
    };
    draw();
    return box;
  }
  const localTime = (iso) => {
    if (!iso) return t("timeUnknown");
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString(lang === "ko" ? "ko-KR" : "en-US", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  // ---------- frame ----------

  const VIEWS = ["status", "product", "gaps", "map"];
  let active = VIEWS.includes(data?.initialView) ? data.initialView : "map";
  let mapStarted = false;
  const tabs = new Map();
  const startMap = () => {
    if (mapStarted || typeof startExplorerMap !== "function") return;
    mapStarted = true;
    startExplorerMap();
  };
  function show(view, { focus = false } = {}) {
    active = view;
    for (const name of VIEWS) {
      const panel = $(`view-${name}`),
        tab = tabs.get(name);
      if (name === "map") panel.className = view === "map" ? "view view-map" : "view view-map view-offstage";
      else hide(panel, name !== view);
      if (name === "map") panel.setAttribute("aria-hidden", view === "map" ? "false" : "true");
      tab.setAttribute("aria-selected", name === view ? "true" : "false");
      tab.setAttribute("tabindex", name === view ? "0" : "-1");
    }
    if (focus) tabs.get(view).focus();
    if (view === "map") startMap();
  }
  function frame() {
    $("frame-eyebrow").textContent = t("eyebrow");
    $("frame-title").textContent = projectTitle();
    $("frame-saved").textContent = data ? t("savedCopy", localTime(data.generatedAt)) : t("decodeFailed");
    $("frame-time-note").textContent = t("timeZoneNote");
    const list = $("view-tabs");
    list.setAttribute("aria-label", t("tabsLabel"));
    for (const name of VIEWS) {
      const tab = $(`tab-${name}`);
      tab.textContent = t(`tab_${name}`);
      tabs.set(name, tab);
      tab.addEventListener("click", () => show(name));
      tab.addEventListener("keydown", (event) => {
        const index = VIEWS.indexOf(name);
        const next = event.key === "ArrowRight" ? VIEWS[(index + 1) % VIEWS.length] : event.key === "ArrowLeft" ? VIEWS[(index + VIEWS.length - 1) % VIEWS.length] : event.key === "Home" ? VIEWS[0] : event.key === "End" ? VIEWS[VIEWS.length - 1] : null;
        if (next) {
          event.preventDefault?.();
          show(next, { focus: true });
        }
      });
    }
    const note = $("map-language-note");
    if (lang !== "en") {
      note.textContent = t("mapEnglishOnly");
      hide(note, false);
    }
  }
  function projectTitle() {
    if (!data?.project) return t("noProjectTitle");
    if (data.project.root) return data.project.root.split(/[\\/]/).filter(Boolean).pop() || data.project.projectId;
    return data.project.projectId;
  }

  // ---------- status ----------

  const status = data ? explorerStatus.model(data) : null;
  let statusPage = { kind: "home" };
  const sessionTitle = (group) => group.purpose || group.sessionId;
  const sessionOf = (id) => status.sessions.find((group) => group.sessionId === id);

  function block(title, ...children) {
    return el("section", { className: "card" }, el("h2", { text: title }), ...children);
  }
  function marked(title, mark, kind, ...children) {
    return el("section", { className: "card" }, el("div", { className: "card-head" }, el("h2", { text: title }), badge(mark, kind)), ...children);
  }
  const list = (items, render, className = "plain-list") => el("ul", { className }, ...items.map((item) => el("li", {}, render(item))));

  function renderStatus() {
    const root = $("view-status");
    root.replaceChildren();
    if (!data) {
      root.append(block(t("decodeFailed")));
      return;
    }
    if (statusPage.kind === "session") return renderSession(root, statusPage.id);
    if (statusPage.kind === "record") return renderRecord(root, statusPage.id);
    root.append(el("p", { className: "notice", text: t("copyNotice", localTime(data.generatedAt)) }));
    if (!status.project.available) {
      root.append(block(t("notProject"), el("p", { text: t("notProjectBody") })));
      root.append(aboutCopy());
      return;
    }
    root.append(directionBlock());
    root.append(countsBlock());
    if (!status.records.size) root.append(block(t("noRecords"), el("p", { text: t("noRecordsBody") })));
    else {
      root.append(sessionsBlock());
      root.append(itemsBlock());
    }
    root.append(entrancesBlock());
    root.append(el("div", { attrs: { id: "status-answer" } }));
    root.append(footerBlock());
  }

  function directionBlock() {
    const current = status.direction.current;
    const children = [];
    if (!current) children.push(el("p", { text: t("noDirection") }));
    else {
      children.push(el("p", { className: "goal", text: current.goal || current.objective || t("noGoal") }));
      const part = (title, items) => (items?.length ? el("div", { className: "direction-part" }, el("h3", { text: title }), list(items, (text) => el("span", { text }))) : null);
      const parts = el("div", { className: "direction-parts" }, part(t("constraints"), current.constraints), part(t("decisions"), current.decisions), part(t("cancelled"), current.cancelledActions));
      children.push(parts);
      if (current.partial) children.push(el("p", { className: "hint", text: t("directionPartial") }));
    }
    for (const old of status.direction.superseded)
      children.push(el("p", { className: "historical" }, badge(t("supersededDirection"), "historical"), el("span", { text: ` ${old.goal}` })));
    return marked(t("directionTitle"), t("userDecided"), "user", ...children);
  }

  function countsBlock() {
    const count = (value, label) => el("div", { className: "count" }, el("strong", { text: String(value) }), el("span", { text: label }));
    const c = status.counts;
    return el(
      "section",
      { className: "counts", attrs: { "aria-label": t("countsLabel") } },
      count(c.sessions, t("countSessions")),
      count(c.records, t("countRecords")),
      count(c.pending, t("pending")),
      count(c.unknowns, t("unknowns")),
      count(c.files, t("countFilesFolded")),
    );
  }

  const partialBadge = (group) => (group.partial ? badge(t("partialBadge"), "historical") : null);

  function sessionRow(group) {
    const rank = group.pending ? "pending" : group.unknowns ? "unknown" : "none";
    const marks = el("span", { className: "row-marks" });
    if (group.pending) marks.append(badge(t("pendingCount", group.pending), "pending"));
    if (group.unknowns) marks.append(badge(t("unknownCount", group.unknowns), "unknown"));
    if (group.partial) marks.append(partialBadge(group));
    marks.append(el("span", { className: "hint", text: t("recordsAt", group.records.length, localTime(group.latest?.recordedAt)) }));
    const row = button("", () => openSession(group.sessionId), `session-row session-${rank}`);
    row.append(
      el("span", { className: `mark mark-${rank}`, attrs: { "aria-hidden": "true" } }),
      el("span", { className: "row-main" }, el("span", { className: "row-title", text: sessionTitle(group) }), el("span", { className: "hint", text: group.latest?.summary ? t("latest", group.latest.summary) : t("noSummary") })),
      marks,
    );
    return row;
  }

  let restOpen = false;
  function sessionsBlock() {
    const first = status.sessions.filter((group) => group.pending || group.unknowns || group.partial);
    const rest = status.sessions.filter((group) => !group.pending && !group.unknowns && !group.partial);
    const rows = el("div", { className: "rows" }, ...first.map(sessionRow));
    if (rest.length) {
      const holder = el("div", { className: "rows" });
      const toggle = button(restOpen ? t("foldRest", rest.length) : t("unfoldRest", rest.length), () => {
        restOpen = !restOpen;
        renderStatus();
      }, "fold-button", { "aria-expanded": restOpen ? "true" : "false" });
      rows.append(toggle);
      if (restOpen) for (const group of rest) holder.append(sessionRow(group));
      rows.append(holder);
    }
    const legend = el(
      "p",
      { className: "legend hint" },
      el("span", { className: "mark mark-pending", attrs: { "aria-hidden": "true" } }),
      el("span", { text: ` ${t("legendPending")}  ` }),
      el("span", { className: "mark mark-unknown", attrs: { "aria-hidden": "true" } }),
      el("span", { text: ` ${t("legendUnknown")}  ` }),
      el("span", { className: "mark mark-none", attrs: { "aria-hidden": "true" } }),
      el("span", { text: ` ${t("legendNone")} · ${t("legendComputed")}` }),
    );
    return el("section", { className: "card" }, el("div", { className: "card-head" }, el("h2", { text: t("workTitle") }), el("span", { className: "hint", text: t("workOrder") })), rows, legend);
  }

  function itemRow(item) {
    const group = sessionOf(item.sessionId);
    const kind = item.type === "pending" ? "pending" : "unknown";
    const row = el("div", { className: "item" }, badge(item.type === "pending" ? t("pending") : t("unknown"), kind), authored(item.text, "item-text"));
    const where = el("div", { className: "hint" }, button(t("fromRecord", sessionTitle(group), localTime(item.recordedAt)), () => openRecord(item.recordId)));
    const state = itemState(item);
    if (state) where.append(el("span", { text: " · " }), state);
    return el("div", {}, row, where);
  }

  // The state a later record gave an item, with the link to that record.
  function itemState(item) {
    if (item.state === "finished") return button(t("finishedLater"), () => openRecord(item.finishedBy));
    if (item.state === "cancelled") return button(t("cancelledLater"), () => openRecord(item.cancelledBy));
    if (item.state === "earlier") return button(t("laterRevision"), () => openRecord(item.laterRevision));
    return null;
  }

  function itemsBlock() {
    const open = status.items.filter((item) => item.state === "open");
    const closed = status.items.filter((item) => item.state === "finished" || item.state === "cancelled");
    const children = [list(open, itemRow, "item-list")];
    if (!open.length) children.unshift(el("p", { text: t("noOpenItems") }));
    if (closed.length) {
      const details = el("details", {}, el("summary", { text: t("finishedItems", closed.length) }), list(closed, itemRow, "item-list"));
      children.push(details);
    }
    if (status.counts.partialRecords) children.push(el("p", { className: "hint", text: t("partialRecords", status.counts.partialRecords) }));
    children.push(el("p", { className: "hint", text: t("onlyRecorded") }));
    return el("section", { className: "card" }, el("div", { className: "card-head" }, el("h2", { text: t("itemsTitle") }), el("span", { className: "hint", text: t("itemsAcross") })), ...children);
  }

  function entrancesBlock() {
    const answer = (render) => () => {
      const target = $("status-answer");
      target.replaceChildren(render());
      target.scrollIntoView?.({ block: "nearest" });
    };
    const search = el("input", { attrs: { type: "search", id: "status-search", "aria-label": t("searchLabel"), placeholder: t("searchLabel") } });
    search.addEventListener("input", () => {
      const target = $("status-answer");
      target.replaceChildren(searchAnswer(search.value));
    });
    return el(
      "section",
      { className: "card" },
      el("h2", { text: t("findTitle") }),
      el(
        "div",
        { className: "entrances" },
        button(t("askItems"), answer(itemsAnswer), "entrance"),
        button(t("askRecent"), answer(recentAnswer), "entrance"),
        button(t("askDecisions"), answer(decisionsAnswer), "entrance"),
        button(t("askFiles"), answer(filesAnswer), "entrance"),
      ),
      el("label", { className: "search-label", text: t("searchLabel"), attrs: { for: "status-search" } }),
      search,
    );
  }

  const answerBlock = (title, items, render) => {
    const shown = el("ul", { className: "item-list" });
    let count = 0;
    const more = button("", () => page(), "fold-button");
    const page = () => {
      for (const item of items.slice(count, count + PAGE)) shown.append(el("li", {}, render(item)));
      count = Math.min(items.length, count + PAGE);
      more.textContent = t("showMore", items.length - count);
      hide(more, count >= items.length);
    };
    page();
    return el("section", { className: "card answer" }, el("h2", { text: title }), items.length ? shown : el("p", { text: t("nothingFound") }), more);
  };
  const recordLink = (recordId, recordedAt, sessionId) => button(t("fromRecord", sessionTitle(sessionOf(sessionId)), localTime(recordedAt)), () => openRecord(recordId));
  const itemsAnswer = () => answerBlock(t("askItems"), status.items.filter((item) => item.state === "open"), itemRow);
  const recentAnswer = () =>
    answerBlock(t("askRecent"), explorerStatus.recent(status), (record) => el("div", {}, el("span", { text: record.summary || t("noSummary") }), el("div", { className: "hint" }, recordLink(record.id, record.recordedAt, record.sessionId))));
  const decisionsAnswer = () => {
    const user = status.direction.current?.decisions || [];
    const agent = explorerStatus.judgments(status);
    return el(
      "div",
      {},
      marked(t("decisions"), t("userDecided"), "user", user.length ? list(user, (text) => el("span", { text })) : el("p", { text: t("noUserDecisions") })),
      el(
        "section",
        { className: "card" },
        el("div", { className: "card-head" }, el("h2", { text: t("agentJudgments") }), badge(t("agentWrote"), "agent")),
        answerBlock(t("askDecisions"), agent, (judgment) =>
          el(
            "div",
            {},
            el("strong", { text: judgment.assessment }),
            reasonLine(judgment.reason),
            judgment.alternatives?.length ? el("div", { className: "hint", text: t("alternatives", judgment.alternatives.join(" / ")) }) : null,
            el("div", { className: "hint" }, recordLink(judgment.recordId, judgment.recordedAt, judgment.sessionId)),
          ),
        ),
      ),
    );
  };
  const filesAnswer = () =>
    answerBlock(t("askFiles"), explorerStatus.files(status), (file) =>
      el("div", {}, el("code", { text: file.path }), el("div", { className: "hint" }, ...file.uses.map((use) => recordLink(use.recordId, use.recordedAt, use.sessionId)))),
    );
  const searchAnswer = (text) =>
    answerBlock(t("searchResults", text), explorerStatus.search(status, text), (found) => el("div", {}, el("span", { text: found.match }), el("div", { className: "hint" }, recordLink(found.recordId, found.recordedAt, found.sessionId))));

  function aboutCopy() {
    return el(
      "details",
      { className: "about" },
      el("summary", { text: t("aboutTitle") }),
      el("p", { text: t("aboutContains") }),
      el("p", { text: t("aboutLeavesOut") }),
      el("p", { text: t("aboutAnother") }),
      ...(data.metadataPolicy?.mode === "share-generated-metadata" ? [el("p", { text: t("aboutShared") })] : []),
    );
  }

  function footerBlock() {
    return el(
      "section",
      { className: "card footer-card" },
      el("p", { text: t("filesFolded", status.counts.files) }),
      button(t("openMap"), () => show("map", { focus: true }), "primary-button"),
      aboutCopy(),
    );
  }

  function pathLine(...parts) {
    const nav = el("nav", { className: "path-line", attrs: { "aria-label": t("pathLabel") } });
    parts.forEach((part, index) => {
      if (index) nav.append(el("span", { className: "path-sep", text: " › ", attrs: { "aria-hidden": "true" } }));
      nav.append(part.onClick ? button(part.text, part.onClick) : el("span", { text: part.text }));
    });
    return nav;
  }

  function openSession(id) {
    statusPage = { kind: "session", id };
    renderStatus();
    $("view-status").scrollIntoView?.();
  }
  function openRecord(id) {
    statusPage = { kind: "record", id };
    renderStatus();
    $("view-status").scrollIntoView?.();
  }
  const home = () => {
    statusPage = { kind: "home" };
    renderStatus();
  };

  function renderSession(root, id) {
    const group = sessionOf(id);
    if (!group) return home();
    root.append(pathLine({ text: projectTitle(), onClick: home }, { text: sessionTitle(group) }));
    root.append(el("p", { className: "notice", text: t("copyNoticeShort", localTime(data.generatedAt)) }));
    const head = el("section", { className: "card" }, el("h1", { text: sessionTitle(group) }));
    const marks = el("div", { className: "row-marks" });
    if (group.pending) marks.append(badge(t("pendingCount", group.pending), "pending"));
    if (group.unknowns) marks.append(badge(t("unknownCount", group.unknowns), "unknown"));
    head.append(marks);
    if (group.purpose) head.append(el("div", { className: "card-head" }, el("h2", { text: t("sessionPurpose") }), badge(t("purposeRecorded"), "neutral")), richText(group.purpose));
    root.append(head);
    const rows = el("div", { className: "rows" });
    for (const record of group.records) {
      const open = record.pending.filter((item) => item.state === "open").length;
      const finished = record.pending.filter((item) => item.state === "finished").length;
      const cancelled = record.pending.filter((item) => item.state === "cancelled").length;
      const row = button("", () => openRecord(record.id), "record-row");
      const notes = el("span", { className: "row-marks" });
      if (open) notes.append(badge(t("pendingCount", open), "pending"));
      if (record.unknowns.length) notes.append(badge(t("unknownCount", record.unknowns.length), "unknown"));
      if (finished) notes.append(badge(t("finishedCount", finished), "finished"));
      if (cancelled) notes.append(badge(t("cancelledCount", cancelled), "neutral"));
      if (record.partial) notes.append(badge(t("partialBadge"), "historical"));
      else if (!open && !record.unknowns.length && !finished && !cancelled) notes.append(el("span", { className: "hint", text: t("noItems") }));
      row.append(el("span", { className: "hint", text: localTime(record.recordedAt) }), el("span", { className: "row-title", text: record.summary || t("noSummary") }), notes);
      rows.append(row);
    }
    root.append(el("section", { className: "card" }, el("div", { className: "card-head" }, el("h2", { text: t("recordsTitle", group.records.length) }), el("span", { className: "hint", text: t("recordsOrder") })), rows));
  }

  function renderRecord(root, id) {
    const record = status.records.get(id);
    if (!record) return home();
    const group = sessionOf(record.sessionId);
    root.append(pathLine({ text: projectTitle(), onClick: home }, { text: sessionTitle(group), onClick: () => openSession(group.sessionId) }, { text: t("recordAt", localTime(record.recordedAt)) }));
    root.append(el("p", { className: "notice", text: t("copyNoticeShort", localTime(data.generatedAt)) }));
    root.append(el("section", { className: "card" }, el("p", { className: "hint", text: t("recordAt", localTime(record.recordedAt)) }), el("h1", { text: record.summary || t("noSummary") })));
    const before = record.before && status.records.get(record.before),
      after = record.after && status.records.get(record.after);
    const flow = el("p", {});
    if (before) flow.append(el("span", { text: t("flowBefore") }), button(before.summary || localTime(before.recordedAt), () => openRecord(before.id)));
    if (after) flow.append(el("span", { text: t("flowAfter") }), button(after.summary || localTime(after.recordedAt), () => openRecord(after.id)));
    if (!before && !after) flow.append(el("span", { text: t("flowAlone") }));
    root.append(block(t("flowTitle"), flow));
    if (!record.bodyIncluded) root.append(block(t("bodyMissing")));
    else if (record.partial) root.append(block(t("partialBody")));
    if (record.judgments.length)
      root.append(
        marked(
          t("agentJudgments"),
          t("agentWrote"),
          "agent",
          list(record.judgments, (judgment) =>
            el(
              "div",
              {},
              el("strong", { text: judgment.assessment }),
              reasonLine(judgment.reason),
              judgment.alternatives?.length ? el("div", { className: "hint", text: t("alternatives", judgment.alternatives.join(" / ")) }) : null,
            ),
          ),
        ),
      );
    const pendingRows = record.pending.map((item) =>
      el(
        "div",
        { className: "item" },
        authored(item.text, "item-text"),
        itemState(item) || badge(t("notFinished"), "neutral"),
        item.nextAction ? el("div", { className: "hint", text: t("nextAction", item.nextAction) }) : null,
      ),
    );
    root.append(marked(t("pending"), t("agentWrote"), "agent", pendingRows.length ? el("div", {}, ...pendingRows) : el("p", { text: t("none") })));
    root.append(marked(t("unknowns"), t("agentWrote"), "agent", record.unknowns.length ? list(record.unknowns, (item) => authored(item.text)) : el("p", { text: t("none") })));
    const files = record.references.map((ref) => {
      const original = data.originals?.[JSON.stringify([ref.path || null, ref.digest || null])];
      const row = el("div", { className: "file-row" }, el("code", { text: ref.path }));
      if (ref.currentness && ref.currentness !== "current")
        row.append(badge(T[`currentness_${ref.currentness}`] ? t(`currentness_${ref.currentness}`) : t("currentness_other", ref.currentness), "historical"));
      if (original?.status === "verified-exact-bytes") {
        // Built when first opened; a reference without a recorded line range
        // opens on its first page.
        const span = Number.isInteger(ref.startLine) ? { startLine: ref.startLine, endLine: Number.isInteger(ref.endLine) ? ref.endLine : ref.startLine } : null;
        let reader = null;
        const toggle = button(
          t("showContent"),
          () => {
            if (!reader) {
              reader = sourceReader(original.text, span);
              hide(reader, true);
              row.append(reader);
            }
            hide(reader, !reader.hidden);
            toggle.setAttribute("aria-expanded", reader.hidden ? "false" : "true");
          },
          "link-button",
          { "aria-expanded": "false" },
        );
        row.append(toggle);
      } else row.append(el("span", { className: "hint", text: t("bodyNotIncluded") }));
      return row;
    });
    root.append(block(t("filesTitle"), files.length ? el("div", {}, ...files) : el("p", { text: t("none") })));
    root.append(
      el(
        "details",
        { className: "card" },
        el("summary", { text: t("managementTitle") }),
        el("p", { className: "hint", text: t("managementBody") }),
        el("p", { className: "mono", text: `${t("recordId")} ${record.id} · ${t("digest")} ${record.digest || record.originDigest || "-"}` }),
        record.path ? el("p", { className: "mono", text: record.path }) : null,
      ),
    );
  }

  // ---------- product graph ----------

  const pg = data?.productGraph || null;
  const built = pg?.status === "built";
  const ctx = built ? productGraphWalk.context({ graph: pg.graph, check: pg.check, freshness: pg.freshness, builtAt: pg.builtAt, baselineNow: pg.baselineNow }) : null;

  function notBuilt(root) {
    root.append(
      block(
        pg?.status === "unreadable" ? t("pgUnreadable") : t("pgNotBuilt"),
        pg?.reason && pg.status === "unreadable" ? el("p", { text: pg.reason }) : null,
        el("p", { text: t("pgBuildWith") }),
        el("pre", { text: pg?.buildCommand || "product-graph-build <project>" }),
      ),
    );
  }

  function textLines(lines) {
    return el("pre", { className: "board", text: lines.join("\n") });
  }

  let treeRoot = null;
  let treeFocus = null;
  let boardRequest = { question: "overview" };

  function renderProduct() {
    const root = $("view-product");
    root.replaceChildren();
    if (!data) return;
    if (!built) return notBuilt(root);
    const overview = productGraphWalk.ask(ctx, { question: "overview" });
    const parts = productGraphWalk.overviewParts(ctx);
    const W = productGraphWalk.WORDS;
    root.append(
      el(
        "section",
        { className: "card" },
        el("h2", { text: t("pgFirstBlock") }),
        el("p", { text: t("pgBuiltAt", localTime(pg.builtAt)) }),
        el("ul", { className: "plain-list board-lines" }, ...overview.header.map((line) => el("li", { text: line }))),
        textLines(parts.facts.map((row) => `${"  ".repeat(row.depth)}${row.text}`)),
        el("details", {}, el("summary", { text: t("pgComparison") }), textLines(productGraphWalk.renderChanges(ctx.changes || { status: "none", reason: productGraphWalk.WORDS.noComparison }))),
      ),
    );
    const starts = el("div", { className: "entrances" });
    const start = (id) => button(productGraphWalk.nodeLine(ctx, id), () => setRoot(id), "entrance");
    if (parts.guide.length)
      starts.append(el("div", { className: "guide" }, el("strong", { text: W.guide }), list(parts.guide, (item) => el("span", { text: `${item.input} (${item.state}). ${W.next}: ${item.next}` }))));
    for (const row of parts.starts) starts.append(start(row.id));
    const questions = el(
      "div",
      { className: "entrances" },
      button(t("pgAskElement"), () => setRoot(productGraphWalk.QUESTION_STARTS.element), "entrance"),
      button(t("pgAskFunction"), () => setRoot(productGraphWalk.QUESTION_STARTS.function), "entrance"),
      button(t("pgAskFile"), () => setRoot(productGraphWalk.QUESTION_STARTS.file), "entrance"),
      button(t("pgAskGaps"), () => show("gaps", { focus: true }), "entrance"),
    );
    const search = el("input", { attrs: { type: "search", id: "product-search", "aria-label": t("pgSearch"), placeholder: t("pgSearch") } });
    const results = el("div", { attrs: { id: "product-search-results" } });
    // Ranked search over the whole graph: run once typing pauses (150 ms), not on every keystroke.
    let pending = null;
    const runSearch = () => {
      pending = null;
      const found = search.value ? productGraphWalk.find(ctx, search.value) : [];
      results.replaceChildren(
        search.value
          ? answerBlock(t("pgFound", found.length), found, (node) => button(productGraphWalk.nodeLine(ctx, node.id), () => setRoot(node.id), "tree-link"))
          : el("span", {}),
      );
    };
    search.addEventListener("input", () => {
      if (pending !== null) clearTimeout(pending);
      pending = setTimeout(runSearch, 150);
    });
    root.append(
      el("section", { className: "card" }, el("h2", { text: t("pgStarts") }), starts, el("h3", { text: t("pgQuestions") }), questions, el("label", { text: t("pgSearch"), attrs: { for: "product-search" } }), search, results),
    );
    const tree = el("section", { className: "card", attrs: { id: "product-tree-card" } });
    root.append(tree);
    renderTree();
  }

  // The tree: the start, then one level per expansion. Each row knows the
  // path from the start to it; a node already on that path is not expanded.
  function setRoot(id) {
    treeRoot = id;
    treeFocus = { id, path: [id] };
    boardRequest = { question: "down", id };
    renderTree();
    $("product-tree-card")?.scrollIntoView?.({ block: "start" });
  }

  function renderTree() {
    const card = $("product-tree-card");
    if (!card) return;
    card.replaceChildren(el("h2", { text: t("pgTree") }));
    if (!treeRoot) {
      card.append(el("p", { className: "hint", text: t("pgPickStart") }));
      return;
    }
    const pathNav = el("nav", { className: "path-line", attrs: { "aria-label": t("pathLabel"), id: "product-path" } });
    card.append(pathNav);
    const tree = el("div", { attrs: { role: "tree", "aria-label": t("pgTree"), id: "product-tree" } });
    card.append(tree);
    tree.append(treeRow(treeRoot, [treeRoot], 0, null));
    const result = el("div", { attrs: { id: "product-result" } });
    card.append(result);
    const board = el("details", { className: "text-board", attrs: { id: "product-board" } }, el("summary", { text: t("pgTextBoard") }), el("pre", { className: "board", attrs: { id: "product-board-text" } }));
    card.append(board);
    updatePath();
  }

  function updatePath() {
    const nav = $("product-path");
    if (!nav || !treeFocus) return;
    nav.replaceChildren(el("span", { text: `${t("pgPath")} ` }));
    treeFocus.path.forEach((id, index) => {
      if (index) nav.append(el("span", { className: "path-sep", text: " › ", attrs: { "aria-hidden": "true" } }));
      nav.append(el("span", { className: "path-part", text: id }));
    });
    const text = $("product-board-text");
    if (text) text.textContent = productGraphWalk.ask(ctx, boardRequest).text;
  }

  function treeRow(id, path, depth, item) {
    const wrapper = el("div", { attrs: { role: "none" }, className: "tree-node" });
    const onPath = depth > 0 && path.slice(0, -1).includes(id);
    const expandable = !onPath && (id.startsWith("@") || (ctx.ix.nodes.has(id) && (productGraphWalk.step(ctx, id, "down") || []).length > 0));
    const label = item ? productGraphWalk.childText(ctx, item) : productGraphWalk.nodeLine(ctx, id);
    const row = el("div", {
      className: `tree-row depth-${Math.min(depth, 12)}`,
      attrs: {
        role: "treeitem",
        tabindex: "0",
        "aria-level": String(depth + 1),
        // The row's name for assistive technology: its line, without the buttons.
        "aria-label": label + (onPath ? ` ${productGraphWalk.WORDS.onPath}` : ""),
        ...(expandable ? { "aria-expanded": "false" } : {}),
        "data-tree-id": id,
      },
    });
    row.style.paddingLeft = `min(${depth * 1.1}rem, 30vw)`;
    const toggle = el("span", { className: "tree-toggle", text: expandable ? "▸" : onPath ? "↺" : "·", attrs: { "aria-hidden": "true" } });
    row.append(toggle, el("span", { className: "tree-text", text: label + (onPath ? ` ${productGraphWalk.WORDS.onPath}` : "") }));
    const actions = el("span", { className: "tree-actions" });
    if (!id.startsWith("@") && ctx.ix.nodes.has(id)) {
      actions.append(button(t("pgUp"), () => answer({ question: "up", id }, path), "mini-button"));
      const reach = productGraphWalk.reachDirection(ctx, id);
      if (reach) actions.append(button(t(reach === "code" ? "pgReachCode" : "pgReachFunctions"), () => answer({ question: "reach", id }, path), "mini-button"));
    }
    row.append(actions);
    const children = el("div", { attrs: { role: "group" } });
    hide(children, true);
    wrapper.append(row, children);
    let loaded = 0;
    let items = null;
    const expand = () => {
      if (!expandable) return;
      if (items === null) {
        items = productGraphWalk.step(ctx, id, "down") || [];
        loadMore();
      }
      hide(children, false);
      row.setAttribute("aria-expanded", "true");
      toggle.textContent = "▾";
    };
    const fold = () => {
      if (!expandable) return;
      // Folding removes the level from the DOM; expanding again rebuilds it.
      children.replaceChildren();
      items = null;
      loaded = 0;
      hide(children, true);
      row.setAttribute("aria-expanded", "false");
      toggle.textContent = "▸";
    };
    const loadMore = () => {
      const groups = new Map();
      for (const entry of items) groups.set(entry.group, (groups.get(entry.group) || 0) + 1);
      let lastGroup = loaded ? items[loaded - 1].group : null;
      for (const entry of items.slice(loaded, loaded + PAGE)) {
        if (entry.group !== lastGroup) {
          children.append(el("div", { className: "tree-group", text: productGraphWalk.WORDS.groupCount(entry.group, groups.get(entry.group)), attrs: { role: "presentation" } }));
          lastGroup = entry.group;
        }
        children.append(treeRow(entry.to, [...path, entry.to], depth + 1, entry));
      }
      loaded = Math.min(items.length, loaded + PAGE);
      const remaining = items.length - loaded;
      if (remaining > 0) {
        const more = button(t("pgMore", remaining, items.length), () => {
          more.remove();
          loadMore();
        }, "fold-button");
        children.append(more);
      }
    };
    const focusRow = () => {
      treeFocus = { id, path };
      boardRequest = { question: "down", id };
      updatePath();
    };
    row.addEventListener("click", (event) => {
      if (event.target?.closest?.("button")) return;
      focusRow();
      if (row.getAttribute("aria-expanded") === "true") fold();
      else expand();
    });
    row.addEventListener("focus", focusRow);
    row.addEventListener("keydown", (event) => {
      if (event.target !== row) return;
      if (event.key === "Enter" || event.key === "ArrowRight") {
        event.preventDefault?.();
        focusRow();
        if (event.key === "Enter" && row.getAttribute("aria-expanded") === "true") fold();
        else expand();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault?.();
        fold();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault?.();
        const rows = Array.from($("product-tree").querySelectorAll("[data-tree-id]")).filter((candidate) => !hiddenInTree(candidate));
        const index = rows.indexOf(row);
        rows[index + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
      }
    });
    return wrapper;
  }

  const hiddenInTree = (node) => {
    for (let current = node.parentNode; current && current.id !== "product-tree"; current = current.parentNode) if (current.hidden) return true;
    return false;
  };

  function answer(request, path) {
    boardRequest = request;
    treeFocus = { id: request.id, path };
    const result = productGraphWalk.ask(ctx, { ...request, limit: 100000 });
    const target = $("product-result");
    const rows = result.rows.slice(1);
    const title = request.question === "up" ? t("pgPointingHere") : t("pgReachTitle");
    target.replaceChildren(
      answerBlock(`${title}: ${request.id}`, rows, (row) => (row.id ? button(row.text, () => setRoot(row.id), "tree-link") : el("span", { className: row.kind === "group" ? "tree-group" : "", text: row.text }))),
    );
    updatePath();
  }

  // ---------- gaps ----------

  function renderGaps() {
    const root = $("view-gaps");
    root.replaceChildren();
    if (!data) return;
    if (!built) return notBuilt(root);
    const check = pg.check;
    root.append(el("section", { className: "card" }, el("h2", { text: productGraphWalk.LIMITS_TITLE }), textLines(productGraphWalk.renderLimits(check.limits).slice(1))));
    const W = productGraphWalk.WORDS;
    root.append(el("section", { className: "card" }, el("h2", { text: W.comparison }), textLines(productGraphWalk.renderChanges(check.changes || { status: "none", reason: W.noComparison }).slice(1))));
    // What was checked against the code, independent of the baseline. Each
    // item opens its node; a build from before this has no block.
    if (check.confirmations) {
      const block = el("section", { className: "card" }, el("h2", { text: W.confirmations }));
      block.append(textLines(productGraphWalk.confirmationHead(check.confirmations)));
      for (const entry of productGraphWalk.CONFIRMATION_LISTS) {
        const items = productGraphWalk.confirmationItems(check.confirmations, entry.key);
        if (!items.length) continue;
        const details = el("details", { className: "gap-list" }, el("summary", { text: `${entry.title}: ${items.length}` }));
        whenOpened(details, () => answerBlock(t("gapItems", items.length), items, (item) => nodeLink(item.text, item.nodeId)));
        block.append(details);
      }
      root.append(block);
    }
    if (check.guide?.length) root.append(el("section", { className: "card" }, el("h2", { text: W.guide }), textLines(productGraphWalk.renderGuide(check.guide).slice(1))));
    const checks = el("section", { className: "card" }, el("h2", { text: W.checks }));
    check.checks.forEach((item, index) => {
      const outcome =
        item.outcome === W.unchecked
          ? el("p", { className: "outcome outcome-unchecked" }, el("span", { className: "outcome-mark", text: "⊘ ", attrs: { "aria-hidden": "true" } }), el("span", { text: `${W.unchecked}: ${item.reason}` }))
          : item.outcome === W.noFindings
            ? el("p", { className: "outcome outcome-none" }, el("span", { className: "outcome-mark", text: "✓ ", attrs: { "aria-hidden": "true" } }), el("span", { text: W.noFindings }))
            : el("p", { className: "outcome outcome-found" }, el("span", { className: "outcome-mark", text: "● ", attrs: { "aria-hidden": "true" } }), el("span", { text: W.findings(item.findings.length) }));
      const findings = productGraphWalk.findingItems(item);
      checks.append(
        el(
          "div",
          { className: "check" },
          el("h3", { text: `${index + 1}. ${item.heading} — ${item.meaning}` }),
          outcome,
          findings.length ? list(findings, (finding) => el("div", {}, nodeLink(finding.text, finding.nodeId), ...(finding.more || []).map((line) => el("div", { className: "hint", text: line })))) : null,
        ),
      );
    });
    root.append(checks);
    for (const entry of productGraphWalk.gapLists(check, (pg.graph.nodeTypes || []).map((item) => item.type))) {
      const details = el("details", { className: "card gap-list" }, el("summary", { text: entry.head[0] }));
      for (const line of entry.head.slice(1)) details.append(el("p", { className: "hint", text: line.trim() }));
      // A list's items, and a file's unreached declarations, are built when
      // they are opened, not at load.
      if (entry.items.length)
        whenOpened(details, () =>
          answerBlock(t("gapItems", entry.items.length), entry.items, (item) => {
            if (!item.declarations?.length) return nodeLink(item.text, item.nodeId);
            const file = el("details", {}, el("summary", {}, nodeLink(item.text, item.nodeId)));
            whenOpened(file, () => list(item.declarations, (id) => nodeLink(id, id)));
            return file;
          }),
        );
      root.append(details);
    }
  }

  function whenOpened(details, build) {
    let built = false;
    const fill = () => {
      if (built || !details.open) return;
      built = true;
      details.append(build());
    };
    details.addEventListener("toggle", fill);
    fill();
  }

  function nodeLink(text, id) {
    if (!id || !ctx.ix.nodes.has(id)) return el("span", { text });
    return button(text, () => {
      show("product");
      setRoot(id);
    }, "tree-link");
  }

  // ---------- start ----------

  // A view that cannot read its part of the copy (for example a product graph
  // build in a shape this page does not know) says so; the others still work.
  const guarded = (render, id, title) => {
    try {
      render();
    } catch (error) {
      $(id).replaceChildren(block(title, el("p", { className: "mono", text: String(error?.message || error) })));
    }
  };
  frame();
  guarded(renderStatus, "view-status", t("decodeFailed"));
  guarded(renderProduct, "view-product", t("pgUnreadable"));
  guarded(renderGaps, "view-gaps", t("pgUnreadable"));
  show(active);
  document.documentElement.dataset.viewsReady = "true";
  // Time from the start of page load until the first view was drawn.
  document.documentElement.dataset.viewsReadyMs = String(Math.round(performance.now()));
  // The map prepares after the first view is on screen.
  setTimeout(startMap, 0);
})();

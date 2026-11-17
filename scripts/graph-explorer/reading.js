// Reading helpers for the status view, shared with Node tests: authored text
// split into blocks, a bounded page of a source original with line numbers,
// and escaping of characters that would hide or reorder what is shown.
// Pure functions; the page renders their results through textContent only.
export const explorerReading = (() => {
  "use strict";
  // C0/C1 controls (except tab and line feed), bidi marks, embeddings,
  // overrides and isolates, and the line/paragraph separators.
  const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu;
  const displayText = (value) => String(value ?? "").replace(HIDDEN, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

  const MAX_BLOCKS = 400;
  const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
  const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const ITEM = /^\s{0,3}([-*+]|[0-9]{1,9}[.)])\s+(.*)$/;

  // Headings, lists, fenced code and paragraphs. Inline Markdown (emphasis,
  // links, code spans) stays literal text. Never more than MAX_BLOCKS blocks;
  // the rest is one last paragraph so nothing is dropped.
  function blocks(text) {
    const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let paragraph = [],
      list = null,
      code = null;
    const flush = () => {
      if (paragraph.length) out.push({ kind: "paragraph", text: paragraph.join("\n") });
      paragraph = [];
      if (list) out.push(list);
      list = null;
    };
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (out.length >= MAX_BLOCKS - 1) {
        flush();
        out.push({ kind: "paragraph", text: lines.slice(index).join("\n") });
        return out;
      }
      if (code) {
        if (line.trim().startsWith(code.fence) && line.trim().replace(/[`~]/g, "") === "") {
          out.push({ kind: "code", text: code.lines.join("\n") });
          code = null;
        } else code.lines.push(line);
        continue;
      }
      const fence = FENCE.exec(line);
      if (fence) {
        flush();
        code = { fence: fence[1], lines: [] };
        continue;
      }
      if (!line.trim()) {
        flush();
        continue;
      }
      const heading = HEADING.exec(line);
      if (heading) {
        flush();
        out.push({ kind: "heading", level: heading[1].length, text: heading[2] });
        continue;
      }
      const item = ITEM.exec(line);
      if (item) {
        const ordered = /[0-9]/.test(item[1]);
        if (paragraph.length) {
          out.push({ kind: "paragraph", text: paragraph.join("\n") });
          paragraph = [];
        }
        if (list && list.ordered !== ordered) flush();
        list ??= { kind: "list", ordered, items: [] };
        list.items.push(item[2]);
        continue;
      }
      // An indented line under a list item continues that item.
      if (list && /^\s{2,}\S/.test(line)) {
        list.items[list.items.length - 1] += `\n${line.trim()}`;
        continue;
      }
      if (list) flush();
      paragraph.push(line);
    }
    // An unclosed fence keeps its text as code.
    if (code) out.push({ kind: "code", text: code.lines.join("\n") });
    flush();
    return out;
  }

  const PAGE_LINES = 80;

  // One page of a source original: line numbers from 1, the recorded span
  // (when the reference has one) marked, PAGE_LINES lines a page. Without a
  // requested page it opens on the page holding the span's first line.
  function sourcePage(text, { page = null, span = null } = {}) {
    const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const total = lines.length;
    const pages = Math.max(1, Math.ceil(total / PAGE_LINES));
    const validSpan =
      span && Number.isInteger(span.startLine) && Number.isInteger(span.endLine) && span.startLine >= 1 && span.endLine >= span.startLine && span.startLine <= total
        ? { startLine: span.startLine, endLine: Math.min(span.endLine, total) }
        : null;
    const start = page === null ? (validSpan ? Math.floor((validSpan.startLine - 1) / PAGE_LINES) : 0) : page;
    const current = Math.min(Math.max(0, Number.isInteger(start) ? start : 0), pages - 1);
    const from = current * PAGE_LINES;
    const shown = lines.slice(from, from + PAGE_LINES).map((line, offset) => {
      const number = from + offset + 1;
      return { number, text: line, inSpan: Boolean(validSpan && number >= validSpan.startLine && number <= validSpan.endLine) };
    });
    return { total, pages, page: current, from: shown.length ? from + 1 : 0, to: from + shown.length, span: validSpan, lines: shown, pageLines: PAGE_LINES };
  }

  return Object.freeze({ displayText, blocks, sourcePage, PAGE_LINES, MAX_BLOCKS });
})();

// Reading helpers for the status view, shared with Node tests: authored text
// split into blocks, a bounded page of a source original with line numbers,
// and escaping of characters that would hide or reorder what is shown.
// Pure functions; the page renders their results through textContent only.
export const explorerReading = (() => {
  "use strict";
  // C0/C1 controls (except tab and line feed), bidi marks, embeddings,
  // overrides and isolates, the line/paragraph separators, and characters
  // that show nothing (zero-width space, word joiner, BOM, soft hyphen).
  const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b\u200e\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/gu;
  // A carriage return is a line end, not a hidden character.
  const displayText = (value) =>
    String(value ?? "")
      .replace(/\r\n?/g, "\n")
      .replace(HIDDEN, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

  const MAX_BLOCKS = 400;
  const ITEM = /^ {0,3}([-*+]|[0-9]{1,9}[.)])[ \t]+(\S.*)$/;
  const isSpace = (c) => c === " " || c === "\t";

  // An ATX heading: up to three spaces, 1-6 #, then a space or the end. A
  // closing run of # is dropped only when a space comes before it ("# Why C#"
  // keeps its #). A plain scan, linear in the line's length.
  function heading(line) {
    let index = 0;
    while (index < 3 && line[index] === " ") index += 1;
    let level = 0;
    while (line[index + level] === "#") level += 1;
    if (level < 1 || level > 6) return null;
    const after = index + level;
    if (after < line.length && !isSpace(line[after])) return null;
    let text = line.slice(after).trim();
    let hashes = text.length;
    while (hashes > 0 && text[hashes - 1] === "#") hashes -= 1;
    if (hashes === 0) text = "";
    else if (hashes < text.length && isSpace(text[hashes - 1])) text = text.slice(0, hashes).trimEnd();
    return { kind: "heading", level, text };
  }

  // A fence opens with three or more backticks or tildes; it closes with a
  // line of only the same character, at least as many.
  function fenceOf(line) {
    const trimmed = line.replace(/^ {0,3}/, "");
    const char = trimmed[0];
    if (char !== "`" && char !== "~") return null;
    let length = 0;
    while (trimmed[length] === char) length += 1;
    return length >= 3 ? { char, length, rest: trimmed.slice(length) } : null;
  }
  const closes = (line, fence) => {
    const found = fenceOf(line);
    return Boolean(found && found.char === fence.char && found.length >= fence.length && !found.rest.trim());
  };

  // Headings, lists, fenced code and paragraphs. Inline Markdown (emphasis,
  // links, code spans) stays literal text; line breaks inside a paragraph or a
  // list item stay. An ordered item keeps the number the author wrote, in its
  // text. Never more than MAX_BLOCKS blocks: past that, everything from the
  // last block's first line on is one paragraph, so nothing is dropped.
  function blocks(text) {
    const lines = String(text ?? "")
      .replace(/\r\n?/g, "\n")
      .split("\n");
    const out = [];
    let paragraph = null,
      list = null,
      code = null;
    const flush = () => {
      if (paragraph) out.push({ kind: "paragraph", text: paragraph.lines.join("\n"), from: paragraph.from });
      paragraph = null;
      if (list) out.push(list);
      list = null;
    };
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (code) {
        if (closes(line, code.fence)) {
          out.push({ kind: "code", text: code.lines.join("\n"), from: code.from });
          code = null;
        } else code.lines.push(line);
        continue;
      }
      const fence = fenceOf(line);
      if (fence && !(fence.char === "`" && fence.rest.includes("`"))) {
        flush();
        code = { fence, lines: [], from: index };
        continue;
      }
      if (!line.trim()) {
        flush();
        continue;
      }
      const head = heading(line);
      if (head) {
        flush();
        out.push({ ...head, from: index });
        continue;
      }
      const item = ITEM.exec(line);
      if (item) {
        const ordered = /[0-9]/.test(item[1]);
        if (paragraph) {
          out.push({ kind: "paragraph", text: paragraph.lines.join("\n"), from: paragraph.from });
          paragraph = null;
        }
        if (list && list.ordered !== ordered) flush();
        list ??= { kind: "list", ordered, items: [], from: index };
        list.items.push(ordered ? `${item[1]} ${item[2]}` : item[2]);
        continue;
      }
      // An indented line under a list item continues that item.
      if (list && /^\s{2,}\S/.test(line)) {
        list.items[list.items.length - 1] += `\n${line.trim()}`;
        continue;
      }
      if (list) flush();
      paragraph ??= { lines: [], from: index };
      paragraph.lines.push(line);
    }
    // An unclosed fence keeps its text as code.
    if (code) out.push({ kind: "code", text: code.lines.join("\n"), from: code.from });
    flush();
    const bounded =
      out.length > MAX_BLOCKS ? [...out.slice(0, MAX_BLOCKS - 1), { kind: "paragraph", text: lines.slice(out[MAX_BLOCKS - 1].from).join("\n") }] : out;
    return bounded.map(({ from, ...block }) => block);
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

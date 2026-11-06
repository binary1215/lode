// Safe presentation of authored structure, not a Markdown/HTML interpreter.
// Selected exported text only: no IO, links, inference or canonical mutations.
const explorerDocument = (() => {
  const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
  function parse(original) {
    const lines = [], blocks = [];
    let at = 0;
    while (at < original.length) {
      const end = original.indexOf("\n", at), stop = end < 0 ? original.length : end;
      lines.push({ text: original.slice(at, stop).replace(/\r$/, ""), start: at, end: stop, next: end < 0 ? stop : stop + 1 });
      at = end < 0 ? original.length : stop + 1;
    }
    const fence = line => /^(`{3,}|~{3,})([A-Za-z0-9_+.-]*)\s*$/.exec(line);
    const heading = line => /^(#{1,6}) +(.+)$/.exec(line);
    const item = line => /^([-+*]|[0-9]+[.)]) +(.+)$/.exec(line);
    for (let i = 0; i < lines.length;) {
      const first = lines[i];
      if (!first.text.trim()) { i++; continue; }
      const f = fence(first.text), h = heading(first.text), li = item(first.text);
      if (f) {
        let close = i + 1;
        while (close < lines.length && lines[close].text.trim() !== f[1]) close++;
        if (close < lines.length) {
          blocks.push({ kind: "code", text: lines.slice(i + 1, close).map(row => row.text).join("\n"), start: first.start, end: lines[close].next });
          i = close + 1; continue;
        }
        // An unfinished fence remains literal, including the marker and tail.
        blocks.push({ kind: "literal", text: original.slice(first.start), start: first.start, end: original.length }); break;
      }
      if (h) { blocks.push({ kind: "heading", level: h[1].length, text: h[2], start: first.start, end: first.next }); i++; continue; }
      if (li) { blocks.push({ kind: "item", marker: li[1], text: li[2], start: first.start, end: first.next }); i++; continue; }
      let end = i + 1;
      while (end < lines.length && lines[end].text.trim() && !fence(lines[end].text) && !heading(lines[end].text) && !item(lines[end].text)) end++;
      blocks.push({ kind: "paragraph", text: lines.slice(i, end).map(row => row.text).join("\n"), start: first.start, end: lines[end - 1].next });
      i = end;
    }
    return blocks;
  }
  function prefix(text, budget) {
    if (text.length <= budget) return text;
    let end = 0;
    for (const part of segmenter.segment(text)) {
      const next = part.index + part.segment.length;
      if (next > budget) break;
      end = next;
      if (end >= budget) break;
    }
    return text.slice(0, end);
  }
  function create(text) {
    const original = typeof text === "string" ? text : "", blocks = parse(original);
    function page(cursor = { block: 0, offset: 0 }, { maxBlocks = 24, maxCharacters = 12000 } = {}) {
      let block = Math.max(0, cursor.block || 0), offset = Math.max(0, cursor.offset || 0), used = 0;
      const included = [];
      while (block < blocks.length && included.length < maxBlocks && used < maxCharacters) {
        const source = blocks[block], rest = source.text.slice(offset), fragment = prefix(rest, maxCharacters - used);
        if (rest && !fragment) {
          const unit = segmenter.segment(rest)[Symbol.iterator]().next().value.segment;
          // A grapheme larger than the whole page cannot be split safely. Make
          // the display omission explicit; retain the exact original and move
          // only the display cursor, never the underlying evidence.
          if (unit.length <= maxCharacters && included.length) break;
          included.push({ ...source, text: "", offset, omittedTextUnitLength: unit.length, partial: true });
          offset += unit.length;
          if (offset >= source.text.length) { block++; offset = 0; }
          continue;
        }
        included.push({ ...source, text: fragment, offset, continued: offset > 0, partial: fragment.length < rest.length });
        used += Math.max(1, fragment.length);
        if (fragment.length < rest.length) { offset += fragment.length; break; }
        block++; offset = 0;
      }
      return { blocks: included, next: block < blocks.length ? { block, offset } : null, totalBlocks: blocks.length,
        complete: block >= blocks.length && !included.some(item => item.omittedTextUnitLength), original };
    }
    return { original, blocks, page };
  }
  return { create };
})();

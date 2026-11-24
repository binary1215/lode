// Changed-part comparison of the product graph (bundle 2, 8A): a content
// signature next to every identity, a baseline that only an explicit move
// changes, and the four cases of the original (변화 없음, 변경, 신규,
// 사라짐) per ID. The build still derives the whole graph every time; this
// only compares. Every value here lives in generated build/ output.
import fs from "node:fs";
import { sha256Hex } from "../core/digest.mjs";
import { canonicalJson } from "../core/canonical-json.mjs";
import { failCode as fail } from "../core/errors.mjs";
import { SOURCE_ANALYSIS_VERSION } from "./source-analysis.mjs";
import { productGraphWalk as walk } from "../../graph-explorer/product-graph-walk.js";

const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const LODE_VERSION = JSON.parse(fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version;
export const PRODUCT_GRAPH_BASELINE_FILE = "baseline.json";
const REACH_NODES_SHOWN = 20;
// Node types a reader older than PRODUCT_GRAPH_VERSION 2 did not produce.
const READER_NEW_TYPES = Object.freeze(["데이터", "외부 연결", "DB"]);

// UTF-8 text, a leading BOM dropped, CR LF and lone CR turned into LF.
// Nothing else, so another checkout's line endings give the same hashes.
export const normalizeSourceText = (text) => text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
const textHash = (text) => sha256Hex(Buffer.from(text, "utf8"));
export const sourceTextHash = (text) => textHash(normalizeSourceText(text));

export function productGraphReader(graphVersion) {
  return { generator: "lode-product-graph", graphVersion, lode: LODE_VERSION, sourceAnalysis: SOURCE_ANALYSIS_VERSION };
}

// What changes how code is read: the generator, its graph version and the
// shared source analysis. The Lode version is kept in inputs.reader as
// information only, so an upgrade that reads code the same way is not a
// change of reader. (The rules hash is compared on its own.)
export const readerKey = (reader) =>
  canonicalJson(
    reader ? { generator: reader.generator ?? null, graphVersion: reader.graphVersion ?? null, sourceAnalysis: reader.sourceAnalysis ?? null } : null,
  );

// The text of a declaration's line range without the blank lines at its end
// (the scan's last range in a file can include the empty segment after the
// final newline, and a range can end in blank lines before the next one), so
// appending after a declaration or moving it to the file's end keeps its hash.
export function declarationText(fileLines, [start, end]) {
  const slice = fileLines.slice(start - 1, end);
  while (slice.length && !slice[slice.length - 1].trim()) slice.pop();
  return slice.join("\n");
}

// What a non-code node's content hash covers, and what its "content" display
// shows: exactly these fields, so the display hashes to contentSha256 and a
// line shift in a document (positions, a 기능's oneLine) is not a content change.
function statedContent(node, ix, reasons) {
  if (node.type === "기능") {
    const handlers = walk.handlersOf(ix, node.id).sort(compare);
    const entries = walk.entriesOf(ix, node.id).sort(compare);
    // 입구 is stated only when a rule gives one, so a 기능 without reads as before.
    return {
      kind: node.kind,
      handling: node.handling,
      handlers,
      ...(entries.length ? { entries } : {}),
      reasons: handlers.length ? [] : [...(reasons.get(node.id) || [])].sort(compare),
    };
  }
  const { at, basis, contentSha256, reachSha256, ...stated } = node;
  return stated;
}

const reasonsOf = (unresolvedHandlers = []) => {
  const reasons = new Map();
  for (const item of unresolvedHandlers) {
    if (!reasons.has(item.id)) reasons.set(item.id, new Set());
    reasons.get(item.id).add(item.reason);
  }
  return reasons;
};

// Adds contentSha256 to every node and reachSha256 to every 기능, in place.
// Hashes are attributes; no ID changes. Derived from scratch on every build.
export function addContentHashes(graph, readFiles, unresolvedHandlers = []) {
  const texts = new Map();
  for (const [file, text] of readFiles) texts.set(file, normalizeSourceText(text));
  const linesOf = new Map();
  const lines = (file) => {
    if (!linesOf.has(file)) linesOf.set(file, texts.get(file).split("\n"));
    return linesOf.get(file);
  };
  const reasons = reasonsOf(unresolvedHandlers);
  const ix = walk.index(graph);
  for (const node of graph.nodes) {
    if (node.type === "코드") {
      if (!texts.has(node.file)) node.contentSha256 = null;
      else if (node.id === node.file || !node.lines) node.contentSha256 = textHash(texts.get(node.file));
      else node.contentSha256 = textHash(declarationText(lines(node.file), node.lines));
    } else node.contentSha256 = sha256Hex(canonicalJson(statedContent(node, ix, reasons)));
  }
  for (const node of graph.nodes) {
    if (node.type !== "기능") continue;
    const reached = [...walk.reachOf(ix, [node.id]).keys()]
      .filter((id) => ix.nodes.get(id)?.type === "코드")
      .sort(compare)
      .map((id) => [id, ix.nodes.get(id).contentSha256]);
    node.reachSha256 = sha256Hex(canonicalJson(reached));
  }
  return graph;
}

// ---------- retained content (before/after display) ----------

// The "before" side of a content change is kept in one generated local file
// next to the baseline. It is never in check.json, check.txt, a build or check
// reply or a Graph Explorer export; only `changes --list content` reads it.
export const PRODUCT_GRAPH_RETAINED_CONTENT_FILE = "baseline-content.json";
export const RETAINED_CONTENT_BUDGET = Object.freeze({ totalBytes: 2 * 1024 * 1024, entryBytes: 16 * 1024 });
// A reader never reads a retained file larger than this.
export const RETAINED_CONTENT_MAX_FILE_BYTES = 4 * 1024 * 1024;

// One node's content as text, or null when it cannot be shown exactly: code is
// the normalised source range (its hash is contentSha256); every other node is
// its stated fields as indented JSON (the canonical form of which hashes to
// contentSha256). sourceFor(path) gives the normalised text of a file whose
// hash matches the graph's record of it, or null.
export function nodeContent(node, { sourceFor, ix, reasons }) {
  if (node.type === "코드") {
    const text = sourceFor(node.file);
    if (text === null || text === undefined) return null;
    const shown = node.id === node.file || !node.lines ? text : declarationText(text.split("\n"), node.lines);
    return textHash(shown) === node.contentSha256 ? { format: "source-lines", text: shown } : null;
  }
  const stated = statedContent(node, ix, reasons);
  return sha256Hex(canonicalJson(stated)) === node.contentSha256 ? { format: "stated-fields", text: JSON.stringify(stated, null, 2) } : null;
}

// A source reader bound to the graph's own record of each file.
export function graphSourceReader(graph, readText) {
  const recorded = new Map((graph.inputs?.sourceFiles || []).map((file) => [file.path, file.sha256]));
  const cache = new Map();
  return (relative) => {
    if (!cache.has(relative)) {
      let text = null;
      try {
        const raw = readText(relative);
        if (typeof raw === "string" && recorded.get(relative) === sourceTextHash(raw)) text = normalizeSourceText(raw);
      } catch {
        text = null;
      }
      cache.set(relative, text);
    }
    return cache.get(relative);
  };
}

// An exact prefix of text within maxBytes, never splitting a character.
export function textPrefix(text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let shown = Buffer.from(text).subarray(0, maxBytes).toString("utf8");
  while (Buffer.byteLength(shown) > maxBytes || !text.startsWith(shown)) shown = shown.slice(0, -1);
  return shown;
}

// The retained-content document for a baseline. Only whole contents are
// kept, so every "before" shown can be checked against the baseline's hash.
// The budget (file bytes: each entry's key and JSON) goes to the smallest
// contents first, so no node loses its text because of its ID's order; a
// content larger than the per-node bound or the rest of the budget is not
// kept, and has no entry. only(id) limits it to some nodes (a backfill keeps
// only those whose content equals the baseline's).
export function retainedContentFor({ graph, baselineBytes, readText, unresolvedHandlers = [], only = null, budget = RETAINED_CONTENT_BUDGET }) {
  const ix = walk.index(graph);
  const reasons = reasonsOf(unresolvedHandlers);
  const sourceFor = graphSourceReader(graph, readText);
  const costOf = (id, entry) => Buffer.byteLength(JSON.stringify(id)) + Buffer.byteLength(JSON.stringify(entry)) + 2;
  const contents = [];
  for (const node of graph.nodes) {
    if (only && !only(node)) continue;
    const content = nodeContent(node, { sourceFor, ix, reasons });
    if (!content) continue;
    const entry = { format: content.format, text: content.text };
    contents.push({ id: node.id, entry, cost: costOf(node.id, entry) });
  }
  contents.sort((a, b) => a.cost - b.cost || compare(a.id, b.id));
  let remaining = budget.totalBytes;
  const entries = {};
  let kept = 0,
    keptBytes = 0,
    tooLarge = 0,
    overBudget = 0;
  for (const item of contents) {
    if (item.cost > budget.entryBytes) tooLarge += 1;
    else if (item.cost > remaining) overBudget += 1;
    else {
      entries[item.id] = item.entry;
      remaining -= item.cost;
      keptBytes += item.cost;
      kept += 1;
    }
  }
  return {
    schemaVersion: 1,
    kind: "LodeProductGraphRetainedContent",
    baselineSha256: sha256Hex(baselineBytes),
    reader: JSON.parse(readerKey(graph.inputs.reader)),
    budget: { totalBytes: budget.totalBytes, entryBytes: budget.entryBytes, counted: "file bytes of each entry (key and JSON)" },
    counts: { nodes: graph.nodes.length, shown: contents.length, kept, tooLarge, overBudget, notShown: graph.nodes.length - contents.length, bytes: keptBytes },
    entries,
  };
}

// Compact: the budget is in file bytes.
export const serializeRetainedContent = (document) => `${JSON.stringify(document)}\n`;

// Reads the retained "before" content of the baseline at baselineBytes. Each
// entry is checked against the baseline: a complete entry must hash to the
// baseline node's contentSha256 (code: its text; stated fields: their
// canonical form); a partial entry is a prefix of such content and cannot be
// re-verified on its own. The file is bound to the baseline's bytes and to the
// way code is read (readerKey), not to the installed Lode, so an update that
// reads code the same way keeps it.
export function readRetainedContent(file, { baseline, baselineBytes }) {
  let document;
  try {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return { status: "missing", entries: new Map(), reason: "보관 본문 파일이 없다" };
    if (!stat.isFile() || stat.isSymbolicLink()) return { status: "unreadable", entries: new Map(), reason: "보관 본문 파일이 보통 파일이 아니다" };
    if (stat.size > RETAINED_CONTENT_MAX_FILE_BYTES) return { status: "unreadable", entries: new Map(), reason: "보관 본문 파일이 너무 크다" };
    document = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { status: "unreadable", entries: new Map(), reason: "보관 본문 파일을 읽지 못했다" };
  }
  if (document?.kind !== "LodeProductGraphRetainedContent" || document.schemaVersion !== 1 || !document.entries || typeof document.entries !== "object")
    return { status: "unreadable", entries: new Map(), reason: "보관 본문 파일의 모양이 다르다" };
  if (document.baselineSha256 !== sha256Hex(baselineBytes)) return { status: "other-baseline", entries: new Map(), reason: "다른 기준의 보관 본문이다" };
  if (readerKey(document.reader) !== readerKey(baseline.reader))
    return { status: "other-reader", entries: new Map(), reason: "코드를 다르게 읽는 버전의 보관 본문이다" };
  const hashes = new Map(baseline.nodes.map(([id, , , , , contentSha256]) => [id, contentSha256]));
  const entries = new Map();
  let rejected = 0;
  for (const [id, entry] of Object.entries(document.entries)) {
    const expected = hashes.get(id);
    // Whole entries only: the text must hash to the baseline's content hash.
    const ok =
      entry &&
      typeof entry.text === "string" &&
      ["source-lines", "stated-fields"].includes(entry.format) &&
      expected &&
      (entry.format === "source-lines"
        ? textHash(entry.text) === expected
        : (() => {
            try {
              return sha256Hex(canonicalJson(JSON.parse(entry.text))) === expected;
            } catch {
              return false;
            }
          })());
    if (ok) entries.set(id, { format: entry.format, text: entry.text, complete: true, totalBytes: Buffer.byteLength(entry.text) });
    else rejected += 1;
  }
  return { status: "read", entries, rejected, counts: document.counts || null, budget: document.budget || null };
}

// ---------- baseline ----------

const edgeKey = (type, from, to) => `${type}\u0000${from}\u0000${to}`;

// What reach needs of an edge beyond [type, from, to], kept as an optional
// fourth tuple element so the baseline's closure can be rebuilt exactly: 역할
// when it is 입구, the 줄 ranges of a 기능→코드 edge, and the lines of a
// reference from a handler those ranges split (2.1, 2.9). A boundary is an
// edge of its own type (2.4). Absent means none, so a common edge costs nothing.
function reachExtra(edge, ranged) {
  const extra = {};
  if (edge.type === "기능→코드" && edge.역할 === "입구") extra.역할 = "입구";
  if (edge.type === "기능→코드" && edge.줄) extra.줄 = edge.줄;
  if (ranged.has(edge.from) && edge.type !== "기능→코드") extra.lines = edge.lines || (edge.at?.line ? [edge.at.line] : []);
  return Object.keys(extra).length ? extra : null;
}
const EXTRA_KEYS = new Set(["역할", "줄", "lines"]);
const validExtra = (extra) =>
  Boolean(extra) &&
  typeof extra === "object" &&
  !Array.isArray(extra) &&
  Object.keys(extra).length > 0 &&
  Object.keys(extra).every((key) => EXTRA_KEYS.has(key)) &&
  (extra.역할 === undefined || extra.역할 === "입구") &&
  (extra.줄 === undefined ||
    (Array.isArray(extra.줄) && extra.줄.every((range) => Array.isArray(range) && range.length === 2 && range.every(Number.isSafeInteger)))) &&
  (extra.lines === undefined || (Array.isArray(extra.lines) && extra.lines.every(Number.isSafeInteger)));

export function baselineFromGraph(graph, { setAt, previous = null }) {
  const edges = new Set();
  const extras = new Map();
  const ranged = new Set(graph.edges.filter((edge) => edge.type === "기능→코드" && edge.줄).map((edge) => edge.to));
  for (const edge of graph.edges) {
    const key = edgeKey(edge.type, edge.from, edge.to);
    edges.add(key);
    const extra = reachExtra(edge, ranged);
    if (extra) extras.set(key, extra);
  }
  const positions = new Map(graph.nodes.map((node, position) => [node.id, position]));
  return {
    schemaVersion: 1,
    kind: "LodeProductGraphBaseline",
    derived: true,
    note: "제품 그래프 비교의 기준. product-graph-baseline으로만 옮긴다. 지우면 바뀐 것 목록만 잃는다.",
    setAt,
    previous,
    reader: graph.inputs.reader,
    rulesSha256: graph.inputs.rulesSha256,
    documents: graph.inputs.documents.map(({ path, sha256 }) => ({ path, sha256 })),
    sourceFiles: graph.inputs.sourceFiles,
    // [id, type, kind, file, lines, contentSha256, reachSha256]
    nodes: graph.nodes.map((node) => [
      node.id,
      node.type,
      node.kind ?? null,
      node.file ?? null,
      node.lines ?? null,
      node.contentSha256 ?? null,
      node.reachSha256 ?? null,
    ]),
    // [type, from, to] or [type, from, to, { 역할?, 줄?, lines? }]: an end that is a
    // node is its position in nodes; the fourth element is what reach needs.
    edges: [...edges].sort(compare).map((key) => {
      const [type, from, to] = key.split("\u0000");
      const tuple = [type, positions.get(from) ?? from, positions.get(to) ?? to];
      return extras.has(key) ? [...tuple, extras.get(key)] : tuple;
    }),
  };
}

export function serializeBaseline(baseline) {
  const { nodes, edges, ...head } = baseline;
  const lines = [JSON.stringify(head).slice(0, -1) + ',"nodes":['];
  nodes.forEach((node, position) => lines.push(JSON.stringify(node) + (position < nodes.length - 1 ? "," : "")));
  lines.push('],"edges":[');
  edges.forEach((edge, position) => lines.push(JSON.stringify(edge) + (position < edges.length - 1 ? "," : "")));
  lines.push("]}");
  return lines.join("\n") + "\n";
}

// A baseline as stored, checked for shape. Returns { baseline } or { reason }.
export function readBaseline(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    // A path under a regular file has no baseline either (ENOTDIR on POSIX).
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return { missing: true, reason: "기준 파일이 없다" };
    return { reason: `기준 파일을 읽지 못했다 (${error.code || "읽기 실패"})` };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { reason: "기준 파일을 JSON으로 읽지 못했다" };
  }
  const shaped =
    value?.kind === "LodeProductGraphBaseline" &&
    value.schemaVersion === 1 &&
    typeof value.setAt === "string" &&
    Array.isArray(value.nodes) &&
    Array.isArray(value.edges) &&
    Array.isArray(value.sourceFiles) &&
    Array.isArray(value.documents) &&
    value.nodes.every((node) => Array.isArray(node) && node.length === 7 && typeof node[0] === "string" && typeof node[1] === "string") &&
    value.edges.every(
      (edge) =>
        Array.isArray(edge) &&
        (edge.length === 3 || (edge.length === 4 && validExtra(edge[3]))) &&
        typeof edge[0] === "string" &&
        edge.slice(1, 3).every((part) => typeof part === "string" || (Number.isInteger(part) && part >= 0 && part < value.nodes.length)),
    );
  if (!shaped) return { reason: "기준 파일의 모양이 맞지 않는다" };
  return { baseline: value };
}

// ---------- comparison ----------

// The name two nodes share when one may have moved: a 코드 node's kind and
// qualified name (a file node's base name), any other node's ID.
function movableName(node) {
  if (node.type !== "코드") return `${node.type}\u0000${node.id}`;
  if (node.id === node.file) return `코드\u0000${node.kind}\u0000${node.id.split("/").pop()}`;
  const hash = node.id.indexOf("#");
  return `코드\u0000${node.kind}\u0000${hash >= 0 ? node.id.slice(hash + 1).replace(/~\d+$/, "") : node.id}`;
}

export function baselineGraph(baseline) {
  const endpoint = (value) => (typeof value === "number" ? baseline.nodes[value][0] : value);
  return {
    nodeTypes: [],
    nodes: baseline.nodes.map(([id, type, kind, file, lines, contentSha256, reachSha256]) => ({ id, type, kind, file, lines, contentSha256, reachSha256 })),
    // A baseline of 0.3.0-beta.133 has three-element tuples: no 입구, ranges or lines.
    edges: baseline.edges.map(([type, from, to, extra]) => ({ type, from: endpoint(from), to: endpoint(to), ...(extra || {}) })),
  };
}

// meaningLines: [{ id, at }] — the lines of 기능 뜻.md.
// retained: what readRetainedContent found for this baseline (only its counts
// and which nodes have a "before" are used here; no text leaves this file).
// baselineSha256: the hash of the baseline file's bytes, so a later reader of
// these changes knows which baseline they belong to.
export function compareWithBaseline(graph, baseline, { meaningLines = [], retained = null, baselineSha256 = null } = {}) {
  const sameReader = readerKey(graph.inputs.reader) === readerKey(baseline.reader);
  const sameRules = (graph.inputs.rulesSha256 ?? null) === (baseline.rulesSha256 ?? null);
  const before = baselineGraph(baseline);
  const beforeIx = walk.index(before);
  const afterIx = walk.index(graph);
  const sourceBefore = new Map(baseline.sourceFiles.map((item) => [item.path, item.sha256]));
  const sourceAfter = new Map((Array.isArray(graph.inputs.sourceFiles) ? graph.inputs.sourceFiles : []).map((item) => [item.path, item.sha256]));
  const sourceMoved = [...new Set([...sourceBefore.keys(), ...sourceAfter.keys()])]
    .filter((file) => sourceBefore.get(file) !== sourceAfter.get(file))
    .sort(compare);
  const fileSame = (file) => Boolean(file) && sourceBefore.has(file) && sourceBefore.get(file) === sourceAfter.get(file);
  const documentsBefore = new Map(baseline.documents.map((item) => [item.path, item.sha256]));
  const documentsAfter = new Map(graph.inputs.documents.map((item) => [item.path, item.sha256]));
  const documentsMoved = [...new Set([...documentsBefore.keys(), ...documentsAfter.keys()])]
    .filter((file) => documentsBefore.get(file) !== documentsAfter.get(file))
    .sort(compare);

  // Under the same reader, a 코드 node in a file whose text is the baseline's
  // must be the baseline's node. Otherwise the build is not reproducible and
  // nothing it says about change can be trusted.
  if (sameReader) {
    const broken = [];
    for (const node of graph.nodes) {
      if (node.type !== "코드" || !fileSame(node.file)) continue;
      const old = beforeIx.nodes.get(node.id);
      if (!old) continue;
      if (old.contentSha256 !== node.contentSha256 || canonicalJson(old.lines ?? null) !== canonicalJson(node.lines ?? null)) broken.push(node.id);
    }
    if (broken.length)
      fail(
        "PRODUCT_GRAPH_NOT_REPRODUCIBLE",
        `같은 읽는 방식, 기준과 같은 내용의 파일에서 같은 ID의 내용 해시나 줄 범위가 다르다. 아무것도 쓰지 않았다: ${broken.slice(0, 20).join(", ")}${broken.length > 20 ? ` 외 ${broken.length - 20}개` : ""}. 이어 가려면 build/baseline.json을 지우고 다시 빌드한다(그 빌드가 새 기준이 되고, 이전 기준 뒤 바뀐 것 목록은 잃는다). 같은 입력에서 이것이 되풀이되면 코드 읽기의 결함이니 알려 달라.`,
      );
  }

  const status = new Map();
  const byType = [];
  const types = [
    ...new Set([...(graph.nodeTypes || []).map((item) => item.type), ...graph.nodes.map((node) => node.type), ...before.nodes.map((node) => node.type)]),
  ];
  // Node types the baseline's reader did not produce (2.8): under another
  // reader their nodes are new to the reading, not to the product.
  const readerNewTypes = new Set(sameReader ? [] : READER_NEW_TYPES.filter((type) => !(beforeIx.byType.get(type) || []).length));
  const readerNewNodes = [];
  for (const type of types) {
    const group = { type, unchanged: 0, changed: [], added: [], removed: [] };
    for (const node of afterIx.byType.get(type) || []) {
      const old = beforeIx.nodes.get(node.id);
      if (!old && readerNewTypes.has(type)) readerNewNodes.push(node.id);
      else if (!old) {
        group.added.push(node.id);
        status.set(node.id, "added");
      } else if (old.contentSha256 !== node.contentSha256) {
        group.changed.push(node.id);
        status.set(node.id, "changed");
      } else group.unchanged += 1;
    }
    for (const node of beforeIx.byType.get(type) || [])
      if (!afterIx.nodes.has(node.id)) {
        group.removed.push(node.id);
        status.set(node.id, "removed");
      }
    for (const field of ["changed", "added", "removed"]) group[field].sort(compare);
    if (group.unchanged || group.changed.length || group.added.length || group.removed.length) byType.push(group);
  }

  // Under another reader, a removed and a new 코드 node in a file whose text
  // is the baseline's, at the same first line and with the same last name
  // segment, are one function the reader now names differently (source
  // analysis 0.3.4 reads a body it used to miss, so a nested function gets
  // its container's prefix). Counted apart, never 신규 or 사라짐.
  const renamed = [];
  let readerNewCode = 0;
  const codeGroup = sameReader ? null : byType.find((group) => group.type === "코드");
  if (codeGroup) {
    const lastSegment = (id) => {
      const name = id.slice(id.indexOf("#") + 1);
      // Without the occurrence suffix "~N" of a name that was not unique.
      return name.slice(name.lastIndexOf(".") + 1).replace(/~\d+$/, "");
    };
    const keyOf = (node) =>
      node && fileSame(node.file) && Array.isArray(node.lines) ? `${node.file}\u0000${node.lines[0]}\u0000${lastSegment(node.id)}` : null;
    const byKey = (ids, ix) => {
      const keyed = new Map();
      for (const id of ids) {
        const key = keyOf(ix.nodes.get(id));
        if (key === null) continue;
        if (!keyed.has(key)) keyed.set(key, []);
        keyed.get(key).push(id);
      }
      return keyed;
    };
    const added = byKey(codeGroup.added, afterIx);
    for (const [key, from] of byKey(codeGroup.removed, beforeIx)) {
      const to = added.get(key);
      if (from.length === 1 && to?.length === 1) renamed.push({ from: from[0], to: to[0] });
    }
    const paired = new Set(renamed.flatMap((pair) => [pair.from, pair.to]));
    for (const id of paired) status.delete(id);
    codeGroup.added = codeGroup.added.filter((id) => !paired.has(id));
    codeGroup.removed = codeGroup.removed.filter((id) => !paired.has(id));
    renamed.sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to));
    // The rest of the new 코드 in files whose text is the baseline's is what
    // the reader now finds (arrows 0.3.4 reads): new to the reading, not 신규.
    const readerCode = codeGroup.added.filter((id) => fileSame(afterIx.nodes.get(id)?.file));
    for (const id of readerCode) {
      status.delete(id);
      readerNewNodes.push(id);
    }
    readerNewCode = readerCode.length;
    codeGroup.added = codeGroup.added.filter((id) => !readerCode.includes(id));
  }

  // The reading range (4.7): folders the build leaves out as data-like now
  // that the baseline read, and data-like folders read now (under the limit
  // or through source.포함) of which the baseline read no file. Derived from
  // the paths alone; nodes that leave or come only because of that are
  // counted there, never 신규 or 사라짐.
  const holds = (files, folder) => files.some((file) => file.startsWith(`${folder}/`));
  const beforeFiles = [...sourceBefore.keys()];
  const afterFiles = [...sourceAfter.keys()];
  const size = graph.limits?.sourceSize;
  const rangeLeftOut = (graph.inputs.leftOutFolders || []).filter((folder) => holds(beforeFiles, folder));
  const rangeReadAgain = [...(size?.candidates || []), ...(size?.included || [])]
    .map((row) => row.path)
    .filter((folder) => !holds(beforeFiles, folder) && holds(afterFiles, folder))
    .sort(compare);
  const inRange = (file) => Boolean(file) && [...rangeLeftOut, ...rangeReadAgain].some((folder) => file.startsWith(`${folder}/`));
  const rangeRemoved = [];
  const rangeAdded = [];
  if (rangeLeftOut.length || rangeReadAgain.length)
    for (const group of byType) {
      const removed = group.removed.filter((id) => inRange(beforeIx.nodes.get(id)?.file));
      const added = group.added.filter((id) => inRange(afterIx.nodes.get(id)?.file));
      for (const id of [...removed, ...added]) status.delete(id);
      rangeRemoved.push(...removed);
      rangeAdded.push(...added);
      group.removed = group.removed.filter((id) => !removed.includes(id));
      group.added = group.added.filter((id) => !added.includes(id));
    }
  const rangeReach = [];

  // 기능 whose own content is the same and whose reached code differs. Under
  // another reader, a difference whose nodes (reached now or in the baseline,
  // and differing) all lie in files whose text is the baseline's comes from
  // the reader: counted apart, not listed, not 다시 볼 것.
  const reachChanged = [];
  const readerReach = [];
  for (const node of afterIx.byType.get("기능") || []) {
    const old = beforeIx.nodes.get(node.id);
    if (!old || status.has(node.id) || !old.reachSha256 || old.reachSha256 === node.reachSha256) continue;
    const now = new Set(walk.reachOf(afterIx, [node.id]).keys());
    // The baseline keeps what reach needs on its edges (역할 입구, 줄 ranges,
    // reference lines; boundaries are edges), so its reach is rebuilt with the
    // same rule. A beta.133 baseline has none of them by definition.
    const then = new Set(walk.reachOf(beforeIx, [node.id]).keys());
    const code = (ix, id) => ix.nodes.get(id)?.type === "코드";
    const nodes = [];
    for (const id of new Set([...now, ...then])) {
      if (!code(afterIx, id) && !code(beforeIx, id)) continue;
      const change = status.get(id) || (now.has(id) && !then.has(id) ? "reached" : !now.has(id) && then.has(id) ? "unreached" : null);
      if (change) nodes.push({ id, change });
    }
    nodes.sort((a, b) => compare(a.change, b.change) || compare(a.id, b.id));
    const fileOfNode = (id) => afterIx.nodes.get(id)?.file || beforeIx.nodes.get(id)?.file || null;
    if (
      nodes.length &&
      nodes.some((item) => inRange(fileOfNode(item.id))) &&
      nodes.every((item) => inRange(fileOfNode(item.id)) || (!sameReader && fileSame(fileOfNode(item.id))))
    ) {
      rangeReach.push(node.id);
      continue;
    }
    if (!sameReader && nodes.every((item) => fileSame(fileOfNode(item.id)))) {
      readerReach.push(node.id);
      continue;
    }
    reachChanged.push({ id: node.id, nodes: nodes.slice(0, REACH_NODES_SHOWN), total: nodes.length });
  }
  const reach = new Set(reachChanged.map((item) => item.id));

  const edgesBefore = new Set(before.edges.map((edge) => edgeKey(edge.type, edge.from, edge.to)));
  const edgesAfter = new Set(graph.edges.map((edge) => edgeKey(edge.type, edge.from, edge.to)));
  const edgeChanges = { call: { added: 0, removed: 0 }, callback: { added: 0, removed: 0 }, added: [], removed: [] };
  const edgeDelta = [];
  for (const [set, other, side] of [
    [edgesAfter, edgesBefore, "added"],
    [edgesBefore, edgesAfter, "removed"],
  ])
    for (const key of set) {
      if (other.has(key)) continue;
      const [type, from, to] = key.split("\u0000");
      edgeDelta.push({ type, from, to, change: side });
      if (type === "call" || type === "callback") edgeChanges[type][side] += 1;
      else edgeChanges[side].push({ type, from, to });
    }
  for (const side of ["added", "removed"]) edgeChanges[side].sort((a, b) => compare(a.type, b.type) || compare(a.from, b.from) || compare(a.to, b.to));

  // A 사라짐 and a 신규 of the same type, name and content: a hint, the two
  // stay two identities.
  const removedByName = new Map();
  for (const group of byType)
    for (const id of group.removed) {
      const node = beforeIx.nodes.get(id);
      if (!node.contentSha256) continue;
      const key = `${movableName(node)}\u0000${node.contentSha256}`;
      if (!removedByName.has(key)) removedByName.set(key, []);
      removedByName.get(key).push(id);
    }
  const maybeMoved = [];
  for (const group of byType)
    for (const id of group.added) {
      const node = afterIx.nodes.get(id);
      if (!node.contentSha256) continue;
      const candidates = removedByName.get(`${movableName(node)}\u0000${node.contentSha256}`);
      if (candidates?.length) maybeMoved.push({ type: node.type, from: candidates.shift(), to: id });
    }
  maybeMoved.sort((a, b) => compare(a.type, b.type) || compare(a.from, b.from) || compare(a.to, b.to));

  // Changes where the source text is the baseline's, under the same reader
  // and rules: listed, no cause stated.
  let unexplained;
  if (!sameReader || !sameRules)
    unexplained = { compared: false, reason: !sameReader ? "읽는 방식이 기준과 다르다" : "호출 방식 표가 기준과 다르다", nodes: [], edges: [] };
  else {
    const fileOf = (id) => afterIx.nodes.get(id)?.file || beforeIx.nodes.get(id)?.file || null;
    const nodes = [];
    for (const group of byType) {
      if (group.type !== "코드") continue;
      for (const field of ["added", "removed"]) for (const id of group[field]) if (fileSame(fileOf(id))) nodes.push({ id, type: group.type, change: field });
    }
    const edges = edgeDelta.filter((edge) => fileSame(fileOf(edge.from)) && fileSame(fileOf(edge.to)));
    edges.sort((a, b) => compare(a.change, b.change) || compare(a.type, b.type) || compare(a.from, b.from) || compare(a.to, b.to));
    unexplained = { compared: true, nodes: nodes.sort((a, b) => compare(a.change, b.change) || compare(a.id, b.id)), edges };
  }

  // 다시 볼 것: what hangs on the changed scope. Reported only.
  const changeOf = (id) => (status.get(id) === "changed" ? "changed" : reach.has(id) ? "reach" : null);
  const meaningIds = new Set(meaningLines.map((item) => item.id));
  const reviewAgain = {
    meaningLines: meaningLines
      .filter((item) => changeOf(item.id))
      .map((item) => ({ id: item.id, at: item.at, change: changeOf(item.id) }))
      .sort((a, b) => compare(a.at.path, b.at.path) || a.at.line - b.at.line),
    newWithoutMeaning: (byType.find((group) => group.type === "기능")?.added || []).filter((id) => !meaningIds.has(id)),
    documentRows: [],
  };
  for (const edge of graph.edges) {
    const target = edge.type === "기능→화면요소" ? edge.from : ["화면요소→기능", "화면→코드"].includes(edge.type) ? edge.to : null;
    // A machine-made edge (2.6) is evidence, not a document row.
    if (!target || !edge.basis || edge.machine) continue;
    const change = changeOf(target);
    if (!change) continue;
    reviewAgain.documentRows.push({
      type: edge.type,
      from: edge.from,
      to: edge.to,
      at: edge.at,
      target,
      change,
      status: edge.basis.status,
      approved: edge.basis.status === "승인",
    });
  }
  const sum = (field) => byType.reduce((total, group) => total + group[field].length, 0);
  // Which nodes' content changed, and whether a "before" is retained for
  // them. The text itself is only in the answer to `changes --list content`.
  const contentChanges = [];
  for (const [id, change] of [...status].sort(([a], [b]) => compare(a, b))) {
    const node = afterIx.nodes.get(id) || beforeIx.nodes.get(id);
    contentChanges.push({ id, type: node?.type || null, change, beforeRetained: Boolean(retained?.entries?.has(id)) });
  }
  const changes = {
    status: "compared",
    baseline: { setAt: baseline.setAt, previous: baseline.previous ?? null },
    moved: {
      sourceFiles: sourceMoved.length,
      sourceFileList: sourceMoved,
      documents: documentsMoved.length,
      documentList: documentsMoved,
      rules: !sameRules,
      reader: !sameReader,
    },
    byType,
    reachChanged,
    // What the reader alone changed (section 3): counted, never listed as 신규 or 닿는 코드가 바뀜.
    ...(sameReader
      ? {}
      : {
          readerChanged: {
            reach: readerReach.sort(compare),
            newNodes: readerNewNodes.sort(compare),
            // Only the types that have a new node here (코드 is counted in newCode).
            newNodeTypes: [...new Set(readerNewNodes.map((id) => afterIx.nodes.get(id)?.type).filter((type) => type && type !== "코드"))].sort(compare),
            newCode: readerNewCode,
            renamed,
          },
        }),
    ...(rangeLeftOut.length || rangeReadAgain.length
      ? {
          readRange: {
            leftOut: rangeLeftOut,
            readAgain: rangeReadAgain,
            removed: rangeRemoved.sort(compare),
            added: rangeAdded.sort(compare),
            reach: rangeReach.sort(compare),
          },
        }
      : {}),
    edges: edgeChanges,
    maybeMoved,
    unexplained,
    reviewAgain,
    contentChanges,
    content: {
      question: "changes --list content",
      baselineSha256,
      changed: contentChanges.length,
      beforeRetained: contentChanges.filter((item) => item.beforeRetained).length,
      retainedFile: retained
        ? { status: retained.status, ...(retained.reason ? { reason: retained.reason } : {}), ...(retained.action ? { action: retained.action } : {}) }
        : { status: "not-read" },
      note: "본문은 이 결과에 넣지 않는다. 전후 본문은 changes --list content 질문으로만 보인다.",
    },
    interpretation: {
      kind: "net-diff",
      intermediateEvents: "not-observed",
      changeReasons: "not-inferred",
      rawByteEquality: false,
      declarationBoundary: "scanner-line-range; not an AST body",
    },
  };
  changes.counts = {
    changed: sum("changed"),
    added: sum("added"),
    removed: sum("removed"),
    reachChanged: reachChanged.length,
    reviewAgain: walk.changeCount(changes, "reviewAgain"),
  };
  return changes;
}

export const noBaseline = (reason) => ({ status: "no-baseline", reason });

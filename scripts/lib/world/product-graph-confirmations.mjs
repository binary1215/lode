// Confirmation records: what a 뜻 line or a document row was checked against,
// and whether that still holds. Independent of the comparison baseline: moving
// the baseline does not clear an item nobody looked at.
//
// A record grants nothing. "agent-checked" says an agent re-read the code a
// line describes; "user-approved" is written alongside the user's approval of
// a document. Both stay distinguishable in every output.
import { sha256Hex } from "../core/digest.mjs";
import {
  productGraphCheckItemKey,
  productGraphCheckRecord,
  PRODUCT_GRAPH_CHECK_MAX_BYTES,
  PRODUCT_GRAPH_CHECK_MAX_ITEMS,
  PRODUCT_GRAPH_CHECK_MAX_SUPERSEDES,
} from "../storage/product-graph-store.mjs";
import { readerKey } from "./product-graph-compare.mjs";

export const CONFIRMATION_ROW_TYPES = Object.freeze(["기능→화면요소", "화면요소→기능", "화면→코드"]);

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const meaningTextSha256 = (text) => sha256Hex(Buffer.from(String(text).normalize("NFC"), "utf8"));

// The node a document row says something about (the same target "다시 볼 것"
// uses for document rows).
export function rowTarget(edge) {
  if (edge.type === "기능→화면요소") return edge.from;
  if (edge.type === "화면요소→기능" || edge.type === "화면→코드") return edge.to;
  return null;
}

// The code basis of a node as the graph has it now: content hash, and for a
// 기능 the hash of all code it reaches. Null when the build has no hashes.
export function nodeBasis(node) {
  if (!node || typeof node.contentSha256 !== "string") return null;
  return node.type === "기능" && typeof node.reachSha256 === "string"
    ? { id: node.id, contentSha256: node.contentSha256, reachSha256: node.reachSha256 }
    : { id: node.id, contentSha256: node.contentSha256 };
}

// Every item that can be checked in this build: each 뜻 line whose 기능 is in
// the graph, and each document row (an edge read from a document) of the three
// row types.
export function checkableItems({ graph, meaningDocument, documents }) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const items = [];
  const seen = new Set();
  const once = (item) => {
    const key = productGraphCheckItemKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  // The graph shows the last 뜻 row of a 기능; that row is the one checked.
  const shown = new Map();
  for (const meaning of meaningDocument?.parsed?.meanings || []) shown.set(meaning.id, meaning);
  for (const meaning of shown.values()) {
    const node = nodes.get(meaning.id);
    if (!node || node.type !== "기능" || !once({ kind: "meaning", id: meaning.id })) continue;
    items.push({
      kind: "meaning",
      id: meaning.id,
      textSha256: meaningTextSha256(meaning.text),
      at: { path: meaningDocument.path, line: meaning.line },
      targets: [meaning.id],
    });
  }
  const documentDigest = new Map((documents || []).map((document) => [document.path, document]));
  for (const edge of graph.edges) {
    if (!CONFIRMATION_ROW_TYPES.includes(edge.type) || !edge.basis || !edge.at?.path) continue;
    const document = documentDigest.get(edge.at.path);
    if (!document?.approvable || !document.approvalDigest) continue;
    // A row naming something the graph does not have is a gap, not code to check.
    if (!nodes.has(rowTarget(edge))) continue;
    if (!once({ kind: "documentRow", document: edge.at.path, type: edge.type, from: edge.from, to: edge.to })) continue;
    items.push({
      kind: "documentRow",
      document: edge.at.path,
      type: edge.type,
      from: edge.from,
      to: edge.to,
      documentTextSha256: document.approvalDigest,
      documentStatus: edge.basis.status,
      at: edge.at,
      targets: [rowTarget(edge)],
    });
  }
  // In reading order: file, line, then identity.
  return items.sort(
    (a, b) => compare(a.at.path, b.at.path) || (a.at.line || 0) - (b.at.line || 0) || compare(productGraphCheckItemKey(a), productGraphCheckItemKey(b)),
  );
}

// The stored item for a checkable item, with its basis from the graph now.
export function recordItemFor(item, nodes) {
  const basis = item.targets.map((id) => nodeBasis(nodes.get(id)));
  if (basis.some((entry) => !entry)) return null;
  return item.kind === "meaning"
    ? { kind: "meaning", id: item.id, textSha256: item.textSha256, basis }
    : {
        kind: "documentRow",
        document: item.document,
        type: item.type,
        from: item.from,
        to: item.to,
        documentTextSha256: item.documentTextSha256,
        basis,
      };
}

const instant = (time) => {
  const value = Date.parse(time);
  return Number.isFinite(value) ? value : -Infinity;
};

// The record that counts for each item: among the valid records naming it,
// the one no other valid record naming it replaces (`supersedes`). Between
// unrelated records (none replaces the other) the later instant, then the
// larger id, decides. A pure function of the records: no clock is read.
export function currentChecks(records) {
  const naming = new Map();
  for (const record of records)
    for (const item of record.items) {
      const key = productGraphCheckItemKey(item);
      if (!naming.has(key)) naming.set(key, []);
      naming.get(key).push({ record, item });
    }
  const current = new Map();
  for (const [key, list] of naming) {
    const replaced = new Set(list.flatMap(({ record }) => record.supersedes || []));
    const heads = list.filter(({ record }) => !replaced.has(record.checkId));
    const pool = heads.length ? heads : list;
    pool.sort((a, b) => instant(b.record.checkedAt) - instant(a.record.checkedAt) || compare(b.record.checkId, a.record.checkId));
    current.set(key, pool[0]);
  }
  return current;
}

const readerOf = (graph) => {
  const reader = graph.inputs?.reader || {};
  return { generator: reader.generator ?? null, graphVersion: reader.graphVersion ?? null, sourceAnalysis: reader.sourceAnalysis ?? null };
};
const sameStored = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The records a command writes for checkable items: items whose current
// record is already of the same kind (by) with the same text and code basis,
// read the same way, are left out (nothing new to say). The rest go into as
// many records as the bounds need; each names the current records of its
// items as replaced. Returns { records, unchanged } or { missingBasis }.
export function confirmationRecords({ projectId, by, rationale = null, graph, items, records = [], checkedAt = new Date().toISOString() }) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const reader = readerOf(graph);
  const current = currentChecks(records);
  const pending = [];
  let unchanged = 0;
  for (const item of items) {
    const stored = recordItemFor(item, nodes);
    if (!stored) return { missingBasis: true };
    const head = current.get(productGraphCheckItemKey(stored));
    if (head && head.record.by === by && readerKey(head.record.reader) === readerKey(reader) && sameStored(head.item, stored)) {
      unchanged += 1;
      continue;
    }
    pending.push({ stored, replaces: head ? [head.record.checkId] : [] });
  }
  const build = (chunk) =>
    productGraphCheckRecord({
      projectId,
      by,
      checkedAt,
      rationale,
      reader,
      items: chunk.map((entry) => entry.stored),
      supersedes: [...new Set(chunk.flatMap((entry) => entry.replaces))].sort(),
    });
  const fits = (chunk) => {
    if (chunk.length > PRODUCT_GRAPH_CHECK_MAX_ITEMS) return null;
    if (new Set(chunk.flatMap((entry) => entry.replaces)).size > PRODUCT_GRAPH_CHECK_MAX_SUPERSEDES) return null;
    const record = build(chunk);
    // The written file is the record as pretty JSON with a final newline.
    return Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`) <= PRODUCT_GRAPH_CHECK_MAX_BYTES ? record : null;
  };
  // Halve until every part fits; a single item always fits (its basis is
  // bounded by the record's own shape).
  const split = (chunk) => {
    if (!chunk.length) return [];
    const record = fits(chunk);
    if (record) return [record];
    if (chunk.length === 1) return null;
    const middle = Math.ceil(chunk.length / 2);
    const left = split(chunk.slice(0, middle));
    const right = left && split(chunk.slice(middle));
    return left && right ? [...left, ...right] : null;
  };
  const written = split(pending);
  if (!written) return { tooLarge: true };
  return { records: written, unchanged };
}

const describe = (item) =>
  item.kind === "meaning"
    ? { kind: "meaning", id: item.id, at: item.at }
    : { kind: "documentRow", document: item.document, type: item.type, from: item.from, to: item.to, at: item.at, documentStatus: item.documentStatus };

// The status of every checkable item against the latest valid record that
// names it. records: verified confirmation records; issues: records that did
// not verify (they excuse nothing).
export function confirmationStatus({ graph, meaningDocument, documents, records, issues = [], read = true }) {
  if (!read)
    return {
      status: "not-read",
      reason: "독립 실행은 확인 기록을 읽지 않는다(확인 기록은 Lode 프로젝트에만 있다)",
    };
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const hashed = graph.nodes.some((node) => typeof node.contentSha256 === "string");
  const latest = currentChecks(records);
  const readerNow = readerKey(graph.inputs?.reader);
  const result = {
    status: "compared",
    records: records.length,
    issues,
    counts: { items: 0, current: 0, neverChecked: 0, changedSinceCheck: 0, textChanged: 0, otherReader: 0 },
    neverChecked: [],
    changedSinceCheck: [],
    textChanged: [],
    otherReader: [],
  };
  for (const item of checkableItems({ graph, meaningDocument, documents })) {
    result.counts.items += 1;
    const found = latest.get(productGraphCheckItemKey(item));
    if (!found) {
      result.neverChecked.push(describe(item));
      continue;
    }
    const { record, item: checked } = found;
    const who = { by: record.by, checkedAt: record.checkedAt, checkId: record.checkId };
    if (readerKey(record.reader) !== readerNow) {
      result.otherReader.push({ ...describe(item), ...who });
      continue;
    }
    const text = item.kind === "meaning" ? item.textSha256 : item.documentTextSha256;
    const textThen = checked.kind === "meaning" ? checked.textSha256 : checked.documentTextSha256;
    if (text !== textThen) {
      result.textChanged.push({ ...describe(item), ...who });
      continue;
    }
    const moved = [];
    for (const then of checked.basis) {
      const now = nodeBasis(nodes.get(then.id));
      if (!now) moved.push({ id: then.id, change: nodes.has(then.id) ? "unhashed" : "removed" });
      else if (now.contentSha256 !== then.contentSha256) moved.push({ id: then.id, change: "changed" });
      else if ((then.reachSha256 || null) !== (now.reachSha256 || null)) moved.push({ id: then.id, change: "reachChanged" });
    }
    if (moved.length) result.changedSinceCheck.push({ ...describe(item), ...who, nodes: moved });
    else result.counts.current += 1;
  }
  result.counts.neverChecked = result.neverChecked.length;
  result.counts.changedSinceCheck = result.changedSinceCheck.length;
  result.counts.textChanged = result.textChanged.length;
  result.counts.otherReader = result.otherReader.length;
  if (!hashed) result.note = "이 빌드에는 내용 해시가 없어 확인 기록과 비교하지 못한다. 다시 빌드한다";
  return result;
}

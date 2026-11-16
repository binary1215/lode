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

// Adds contentSha256 to every node and reachSha256 to every 기능, in place.
// Hashes are attributes; no ID changes.
export function addContentHashes(graph, readFiles, unresolvedHandlers = [], cache = null) {
  const texts = new Map();
  for (const [file, text] of readFiles) texts.set(file, normalizeSourceText(text));
  const linesOf = new Map();
  const lines = (file) => {
    if (!linesOf.has(file)) linesOf.set(file, texts.get(file).split("\n"));
    return linesOf.get(file);
  };
  const reasons = new Map();
  for (const item of unresolvedHandlers) {
    if (!reasons.has(item.id)) reasons.set(item.id, new Set());
    reasons.get(item.id).add(item.reason);
  }
  const ix = walk.index(graph);
  for (const node of graph.nodes) {
    if (node.type === "코드") {
      if (!texts.has(node.file)) node.contentSha256 = null;
      else if (node.id === node.file || !node.lines) node.contentSha256 = textHash(texts.get(node.file));
      else node.contentSha256 = textHash(declarationText(lines(node.file), node.lines));
    } else if (node.type === "기능") {
      const handlers = walk.handlersOf(ix, node.id).sort(compare);
      node.contentSha256 = sha256Hex(
        canonicalJson({ kind: node.kind, handling: node.handling, handlers, reasons: handlers.length ? [] : [...(reasons.get(node.id) || [])].sort(compare) }),
      );
    } else {
      const { at, basis, contentSha256, ...stated } = node;
      node.contentSha256 = sha256Hex(canonicalJson(stated));
    }
  }
  const closureCache = new Map();
  const relationBasis = cache
    ? cache.signature({
        codes: graph.nodes.filter((node) => node.type === "코드").map((node) => [node.id, node.kind]),
        edges: graph.edges.filter((edge) => ["call", "callback"].includes(edge.type)).map((edge) => [edge.type, edge.from, edge.to]),
        constructors: [...ix.constructors],
      })
    : null;
  for (const node of graph.nodes) {
    if (node.type !== "기능") continue;
    const handlers = walk.handlersOf(ix, node.id).sort(compare),
      key = JSON.stringify(handlers);
    const cachedKey = `reach:${key}`,
      cached = cache?.getWork(cachedKey, relationBasis);
    if (!closureCache.has(key))
      closureCache.set(
        key,
        Array.isArray(cached?.ids) && cached.ids.every((id) => ix.nodes.get(id)?.type === "코드")
          ? cached.ids
          : [...walk.closure(ix, handlers)].filter((id) => ix.nodes.get(id)?.type === "코드").sort(compare),
      );
    const ids = closureCache.get(key),
      reached = ids.map((id) => [id, ix.nodes.get(id).contentSha256]);
    const contentKey = canonicalJson(reached);
    const reused = cached?.contentKey === contentKey && typeof cached?.reachSha256 === "string";
    node.reachSha256 = reused ? cached.reachSha256 : sha256Hex(contentKey);
    if (cache) {
      const stat = reused ? "reachHashesReused" : "reachHashesComputed";
      cache.stats[stat] = (cache.stats[stat] || 0) + 1;
      cache.putWork(cachedKey, relationBasis, { ids, contentKey, reachSha256: node.reachSha256 });
    }
  }
  return graph;
}

// ---------- baseline ----------

const edgeKey = (type, from, to) => `${type}\u0000${from}\u0000${to}`;

export function displayEvidence(graph, readFiles = new Map()) {
  let remaining = 2 * 1024 * 1024;
  const evidence = Object.create(null);
  // Prefer declarations to duplicate whole-file displays. This is one
  // replaceable baseline's bounded display, not a permanent source archive.
  const nodes = [...graph.nodes].sort((a, b) => Number(a.id === a.file) - Number(b.id === b.file) || compare(a.id, b.id));
  const files = new Map((graph.inputs?.sourceFiles || []).map((file) => [file.path, file.sha256]));
  const sources = new Map();
  for (const node of nodes) {
    let text, format;
    if (node.type === "코드") {
      if (!sources.has(node.file)) {
        const source = readFiles.get(node.file);
        const normalized = typeof source === "string" && sourceTextHash(source) === files.get(node.file) ? normalizeSourceText(source) : null;
        sources.set(node.file, normalized === null ? null : { text: normalized, lines: normalized.split("\n") });
      }
      const source = sources.get(node.file);
      if (!source) continue;
      text = node.id === node.file || !node.lines ? source.text : declarationText(source.lines, node.lines);
      if (textHash(text) !== node.contentSha256) continue;
      format = "normalized-source-lines";
    } else {
      const { at, basis, contentSha256, reachSha256, ...stated } = node;
      text = JSON.stringify(stated, null, 2);
      format = "stated-fields";
    }
    const bytes = Buffer.from(text),
      maximum = Math.min(16 * 1024, remaining);
    // UTF-8 decode truncation is avoided: a display is an exact text prefix.
    let shown = text;
    if (bytes.length > maximum) {
      shown = bytes.subarray(0, maximum).toString("utf8");
      while (Buffer.byteLength(shown) > maximum || !text.startsWith(shown)) shown = shown.slice(0, -1);
    }
    remaining -= Buffer.byteLength(shown);
    const meaningSource = node.type === "기능" && node.oneLine ? (graph.inputs.documents || []).find((doc) => doc.path === "기능 뜻.md") : null;
    const sourcePath = meaningSource?.path || node.file || node.at?.path || node.basis?.path || null;
    evidence[node.id] = {
      status: !maximum ? "unavailable" : shown === text ? "available" : "partial",
      ...(!maximum ? { reason: "표시 예산을 넘었다; 전체 표시값 digest만 보존" } : {}),
      format,
      text: shown,
      textSha256: textHash(shown),
      fullTextSha256: textHash(text),
      contentSha256: node.contentSha256,
      sourceSha256: files.get(node.file) || (graph.inputs.documents || []).find((doc) => doc.path === sourcePath)?.sha256 || null,
      sourcePath,
      sourceHashKind:
        node.type === "코드"
          ? "BOM-dropped LF-normalized UTF-8"
          : node.type === "기능"
            ? meaningSource
              ? "meaning document bytes; entry/rule fields are derived"
              : "derived entry/rule fields"
            : "document bytes",
      basis: node.basis || null,
      lines: node.lines || null,
      totalBytes: bytes.length,
    };
  }
  return evidence;
}

function verifiedDisplay(entry, node) {
  if (!entry || typeof entry.text !== "string" || entry.contentSha256 !== node?.contentSha256 || textHash(entry.text) !== entry.textSha256)
    return { status: "unavailable", reason: "이 기준에 검증 가능한 과거 본문/표시값이 없다" };
  if (!["available", "partial", "unavailable"].includes(entry.status) || !["normalized-source-lines", "stated-fields"].includes(entry.format))
    return { status: "unavailable", reason: "표시 근거 형식을 확인할 수 없다" };
  if (
    entry.fullTextSha256 &&
    (!/^[a-f0-9]{64}$/.test(entry.fullTextSha256) ||
      (entry.status === "available" && entry.fullTextSha256 !== entry.textSha256) ||
      (entry.format === "normalized-source-lines" && entry.fullTextSha256 !== node.contentSha256))
  )
    return { status: "unavailable", reason: "전체 표시값 digest가 보관 본문/기준과 일치하지 않는다" };
  if (entry.format === "normalized-source-lines" && entry.status === "available" && entry.textSha256 !== node.contentSha256)
    return { status: "unavailable", reason: "구간 내용 해시가 기준과 다르다" };
  return entry.sourcePath && entry.sourceSha256 ? entry : { ...entry, sourceHashKind: "derived display fields; original source witness unavailable" };
}

export function baselineFromGraph(graph, { setAt, previous = null, readFiles = new Map(), scope = null }) {
  const edges = new Set();
  for (const edge of graph.edges) edges.add(edgeKey(edge.type, edge.from, edge.to));
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
    displayEvidence: displayEvidence(graph, readFiles),
    scope,
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
    // [type, from, to]; an end that is a node is its position in nodes.
    edges: [...edges].sort(compare).map((key) => {
      const [type, from, to] = key.split("\u0000");
      return [type, positions.get(from) ?? from, positions.get(to) ?? to];
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
        edge.length === 3 &&
        typeof edge[0] === "string" &&
        edge.slice(1).every((part) => typeof part === "string" || (Number.isInteger(part) && part >= 0 && part < value.nodes.length)),
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
    edges: baseline.edges.map(([type, from, to]) => ({ type, from: endpoint(from), to: endpoint(to) })),
  };
}

// meaningLines: [{ id, at }] — the lines of 기능 뜻.md.
export function compareWithBaseline(graph, baseline, { meaningLines = [], readFiles = new Map(), scope = null } = {}) {
  const reasons = [],
    priorScope = baseline.scope;
  const validScope = (value) =>
    value &&
    /^[a-f0-9]{64}$/.test(value.sourceRootHash || "") &&
    /^[a-f0-9]{64}$/.test(value.parserSha256 || "") &&
    value.reader &&
    (value.projectId === null || typeof value.projectId === "string");
  if (!validScope(priorScope) || !validScope(scope)) reasons.push("기준/현재의 Project·소스 루트·reader 근거가 없다");
  else {
    if (priorScope.projectId !== scope.projectId) reasons.push("다른 Project의 기준이다");
    if (priorScope.sourceRootHash !== scope.sourceRootHash) reasons.push("다른 소스 루트의 기준이다");
    if (
      priorScope.parserSha256 !== scope.parserSha256 ||
      readerKey(priorScope.reader) !== readerKey(scope.reader) ||
      readerKey(priorScope.reader) !== readerKey(baseline.reader) ||
      readerKey(scope.reader) !== readerKey(graph.inputs.reader)
    )
      reasons.push("기준/현재 reader witness가 다르거나 일치하지 않는다");
  }
  const comparisonScope = {
    status: reasons.length ? "partial" : "verified",
    reasons,
    oldBodyEligible: reasons.length === 0,
    structuralComparison: "ID/content/reach/edge only; not source lineage authority",
  };
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
  for (const type of types) {
    const group = { type, unchanged: 0, changed: [], added: [], removed: [] };
    for (const node of afterIx.byType.get(type) || []) {
      const old = beforeIx.nodes.get(node.id);
      if (!old) {
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

  // 기능 whose own content is the same and whose reached code differs.
  const reachChanged = [];
  for (const node of afterIx.byType.get("기능") || []) {
    const old = beforeIx.nodes.get(node.id);
    if (!old || status.has(node.id) || !old.reachSha256 || old.reachSha256 === node.reachSha256) continue;
    const now = walk.closure(afterIx, walk.handlersOf(afterIx, node.id));
    const then = walk.closure(beforeIx, walk.handlersOf(beforeIx, node.id));
    const code = (ix, id) => ix.nodes.get(id)?.type === "코드";
    const nodes = [];
    for (const id of new Set([...now, ...then])) {
      if (!code(afterIx, id) && !code(beforeIx, id)) continue;
      const change = status.get(id) || (now.has(id) && !then.has(id) ? "reached" : !now.has(id) && then.has(id) ? "unreached" : null);
      if (change) nodes.push({ id, change });
    }
    nodes.sort((a, b) => compare(a.change, b.change) || compare(a.id, b.id));
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
    if (!target || !edge.basis) continue;
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
  const afterDisplay = displayEvidence(graph, readFiles);
  const contentChanges = [];
  const displayCoverage = { compared: 0, unknownComparison: 0, unavailableBefore: 0, unavailableAfter: 0 };
  for (const id of [...new Set([...beforeIx.nodes.keys(), ...afterIx.nodes.keys()])].sort(compare)) {
    const old = beforeIx.nodes.get(id),
      now = afterIx.nodes.get(id);
    const oldDisplay = old
      ? comparisonScope.oldBodyEligible
        ? verifiedDisplay(baseline.displayEvidence?.[id], old)
        : { status: "unavailable", reason: reasons.join(" / ") }
      : { status: "absent" };
    const nowDisplay = now ? verifiedDisplay(afterDisplay[id], now) : { status: "absent" };
    const fingerprint = (entry) =>
      /^[a-f0-9]{64}$/.test(entry.fullTextSha256 || "") ? entry.fullTextSha256 : entry.status === "available" ? entry.textSha256 : null;
    const oldFingerprint = fingerprint(oldDisplay),
      nowFingerprint = fingerprint(nowDisplay);
    if (old && now) {
      if (oldFingerprint && nowFingerprint) displayCoverage.compared += 1;
      else displayCoverage.unknownComparison += 1;
    }
    if (oldDisplay.status === "unavailable") displayCoverage.unavailableBefore += 1;
    if (nowDisplay.status === "unavailable") displayCoverage.unavailableAfter += 1;
    const displayChanged = oldFingerprint && nowFingerprint && oldFingerprint !== nowFingerprint;
    if (!status.has(id) && !displayChanged) continue;
    contentChanges.push({ id, type: now?.type || old?.type, change: status.get(id) || "display-changed", before: oldDisplay, after: nowDisplay });
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
    edges: edgeChanges,
    maybeMoved,
    unexplained,
    reviewAgain,
    contentChanges,
    displayCoverage,
    comparisonScope,
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

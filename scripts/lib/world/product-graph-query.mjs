// product-graph-query: the agent's way to ask the existing product graph
// build. Read-only: it reads the build and never builds, checks, approves or
// writes. The answer text is the page's text board for the same question.
import { failCode as fail } from "../core/errors.mjs";
import { readProductGraphBuild, readProductGraphBuildContext, readProductGraphRetainedContent, sourceTextNow } from "./product-graph.mjs";
import { productGraphWalk as walk } from "../../graph-explorer/product-graph-walk.js";
import { graphSourceReader, nodeContent, readerKey, textPrefix } from "./product-graph-compare.mjs";
import { sha256Hex } from "../core/digest.mjs";
import { canonicalJson } from "../core/canonical-json.mjs";

export const PRODUCT_GRAPH_QUESTIONS = Object.freeze(["overview", "node", "down", "up", "reach", "find", "gaps", "changes", "impact"]);
const MAX_LIMIT = 500;

export function productGraphQueryContext(read) {
  return walk.context({ graph: read.graph, check: read.check, freshness: read.freshness, builtAt: read.builtAt, baselineNow: read.baselineNow });
}

export function queryProductGraph(options = {}) {
  const {
    question = "overview",
    id = null,
    text = null,
    list = null,
    limit = walk.LIMIT,
    cursor = 0,
    depth = 1,
    candidateBuildDirectory = null,
    proposalBaseBuildDirectory = null,
    nodeTypes = [],
    relatedTo = null,
    edgeTypes = [],
    basisStates = [],
    expectedBasisSha256 = null,
    ...location
  } = options;
  if (!PRODUCT_GRAPH_QUESTIONS.includes(question)) fail("PRODUCT_GRAPH_QUERY_INVALID", `질문은 ${PRODUCT_GRAPH_QUESTIONS.join(", ")} 중 하나다.`);
  if (["node", "down", "up", "reach"].includes(question) && (typeof id !== "string" || !id))
    fail("PRODUCT_GRAPH_QUERY_INVALID", `${question}에는 노드 ID가 필요하다.`);
  if (question === "find" && (typeof text !== "string" || !text)) fail("PRODUCT_GRAPH_QUERY_INVALID", "find에는 찾을 글자가 필요하다.");
  const number = (value, name, minimum, maximum) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum)
      fail("PRODUCT_GRAPH_QUERY_INVALID", `${name}는 ${minimum}부터 ${maximum}까지의 정수다.`);
    return parsed;
  };
  const request = {
    question,
    id: id ?? "",
    text: text ?? "",
    list,
    limit: number(limit, "limit", 1, MAX_LIMIT),
    cursor: number(cursor, "cursor", 0, Number.MAX_SAFE_INTEGER),
    depth: number(depth, "depth", 1, 8),
    nodeTypes,
    relatedTo,
    edgeTypes,
    basisStates,
  };
  const read = readProductGraphBuild(location);
  const common = { readOnly: true, persisted: false, ordinaryWorkBlocked: false };
  if (read.status !== "built") {
    const message =
      read.status === "not-built"
        ? `제품 그래프 빌드가 없다 (없음, 빌드 필요). 만들려면: ${read.buildCommand}`
        : `제품 그래프 빌드를 읽지 못했다: ${read.reason}. 다시 만들려면: ${read.buildCommand}`;
    return { status: read.status, code: read.code, message, buildCommand: read.buildCommand, text: `${message}\n`, ...common };
  }
  const refuse = (code, message) => ({ status: "refused", code, message, question, text: `${message}\n`, ...common });
  // An exact anchor that is not in the graph is said, not answered with nothing.
  if (relatedTo !== null && relatedTo !== undefined && relatedTo !== "") {
    const anchor = walk.resolveId(productGraphQueryContext(read), String(relatedTo));
    if (!read.graph.nodes.some((node) => node.id === anchor))
      return refuse("PRODUCT_GRAPH_NODE_NOT_FOUND", `--related-to ${relatedTo}라는 노드가 이 그래프에 없다. 이웃 범위가 없어 찾지 않았다.`);
  }
  let proposalFreshness = null,
    candidateRead = null,
    baseRead = null;
  if (question === "impact") {
    // A build folder that was given but cannot be read is said as such, never
    // treated as not given.
    if (candidateBuildDirectory) {
      candidateRead = readProductGraphBuild({ buildDirectory: candidateBuildDirectory });
      if (candidateRead.status !== "built")
        return refuse(candidateRead.code || "PRODUCT_GRAPH_BUILD_UNREADABLE", `제안 빌드(${candidateBuildDirectory})를 읽지 못했다: ${candidateRead.reason}`);
    }
    if (proposalBaseBuildDirectory) {
      baseRead = readProductGraphBuild({ buildDirectory: proposalBaseBuildDirectory });
      if (baseRead.status !== "built")
        return refuse(baseRead.code || "PRODUCT_GRAPH_BUILD_UNREADABLE", `제안 출발 빌드(${proposalBaseBuildDirectory})를 읽지 못했다: ${baseRead.reason}`);
    }
    request.candidate = candidateRead ? candidateRead.graph : null;
    // An explicitly given basis never falls back to another convenient one.
    request.proposalBase = baseRead ? baseRead.graph : read.baselineEvidence;
    const scopeOf = (built) => readProductGraphBuildContext(built)?.scope || null;
    const scopes = [scopeOf(read), baseRead ? scopeOf(baseRead) : read.baselineEvidence ? scopeOf(read) : null, candidateRead ? scopeOf(candidateRead) : null];
    const reasons = [];
    if (scopes.some((scope) => !scope)) reasons.push("빌드 scope 기록(build-context.json)이 없는 기준/후보가 있다");
    else {
      // All three from the same Project, or all three stand-alone (no Project).
      if (new Set(scopes.map((scope) => scope.projectId)).size !== 1)
        reasons.push("같은 Project의 빌드가 아니다 (Project 빌드와 독립 실행 --out 빌드가 섞였거나 다른 Project다)");
      if (new Set(scopes.map((scope) => scope.sourceRootHash)).size !== 1) reasons.push("서로 다른 소스 루트에서 만든 빌드다");
      if (new Set(scopes.map((scope) => readerKey(scope.reader))).size !== 1) reasons.push("코드를 읽는 방식이 다르다");
    }
    const graphs = [read.graph, request.proposalBase, request.candidate].filter(Boolean);
    if (new Set(graphs.map((graph) => graph.rulesSha256 ?? graph.inputs?.rulesSha256 ?? null)).size !== 1) reasons.push("호출 방식 표가 다르다");
    request.compatibility = { status: reasons.length ? "partial" : "verified", reasons };
    proposalFreshness = {
      candidate: candidateRead?.freshness || { state: "unknown" },
      base: baseRead?.freshness || { state: "unknown" },
      explicitBase: Boolean(proposalBaseBuildDirectory),
    };
  }
  // What a later page must be answered from: the build files' own bytes (not
  // a re-serialisation of the graph), the comparison and the question.
  // Taken only when needed: to check a given basis, for the impact preview,
  // or when there is a next page to bind (see below).
  const basisOf = () =>
    sha256Hex(
      canonicalJson({
        graph: read.graphFileSha256,
        check: read.checkFileSha256,
        base: baseRead ? baseRead.graphFileSha256 : question === "impact" && read.baselineEvidence ? read.baselineEvidence.setAt : null,
        candidate: candidateRead ? candidateRead.graphFileSha256 : null,
        compatibility: request.compatibility || null,
        query: { question, text: request.text, id: request.id, list, nodeTypes, relatedTo, edgeTypes, basisStates, depth: request.depth },
      }),
    );
  let basisSha256 = expectedBasisSha256 || question === "impact" ? basisOf() : null;
  if (expectedBasisSha256 && expectedBasisSha256 !== basisSha256)
    return {
      status: "basis-changed",
      code: "PRODUCT_GRAPH_QUERY_BASIS_CHANGED",
      text: "조회 기준이 바뀌었다(빌드·기준·후보 또는 질문). 이전 페이지와 섞지 않았다. 현재 기준에서 처음부터 다시 조회한다.\n",
      basisSha256,
      ...common,
    };
  // A build in a shape no released version wrote may lack what one question
  // needs. That question answers with a stated code; other questions that the
  // build can answer still work.
  const ctx = productGraphQueryContext(read);
  if (question === "changes" && list === "content") ctx.content = contentPage(read, request);
  let answer;
  try {
    answer = walk.ask(ctx, request);
  } catch {
    const message = `이 빌드(${read.directory})는 이 질문에 답할 모양이 아니다: 알려진 어느 버전의 빌드와도 모양이 다르다. 다시 만들려면: ${read.buildCommand}`;
    return { status: "unreadable", code: "PRODUCT_GRAPH_BUILD_UNREADABLE", message, buildCommand: read.buildCommand, text: `${message}\n`, ...common };
  }
  const { text: answerText, ok, code, message, ...structured } = answer;
  // A printed next-page hint repeats the question exactly: its filters, its
  // build folders and the basis it was answered from.
  if (structured.page?.remaining && basisSha256 === null) basisSha256 = basisOf();
  const flags = [];
  const quote = (value) => (/^[\p{L}\p{N}_./:@,-]+$/u.test(String(value)) ? String(value) : JSON.stringify(String(value)));
  if (nodeTypes.length) flags.push(`--node-types ${quote(nodeTypes.join(","))}`);
  if (relatedTo) flags.push(`--related-to ${quote(relatedTo)}`);
  if (edgeTypes.length) flags.push(`--edge-types ${quote(edgeTypes.join(","))}`);
  if (basisStates.length) flags.push(`--basis-states ${quote(basisStates.join(","))}`);
  if (request.depth !== 1) flags.push(`--depth ${request.depth}`);
  if (request.limit !== walk.LIMIT) flags.push(`--limit ${request.limit}`);
  if (candidateBuildDirectory) flags.push(`--candidate-build ${quote(candidateBuildDirectory)}`);
  if (proposalBaseBuildDirectory) flags.push(`--proposal-base-build ${quote(proposalBaseBuildDirectory)}`);
  flags.push(`--expected-basis-sha256 ${basisSha256}`);
  let rows = structured.rows;
  if (Array.isArray(rows))
    rows = rows.map((row) =>
      row.kind === "more" && typeof row.hint === "string" && row.hint.includes("--cursor") ? { ...row, text: `${row.text} ${flags.join(" ")}` } : row,
    );
  const answerTextNow =
    Array.isArray(rows) && Array.isArray(structured.header)
      ? [...structured.header, structured.title, ...rows.map((row) => `${"  ".repeat(row.depth)}${row.text}`)].join("\n") + "\n"
      : answerText;
  if (structured.page?.remaining)
    structured.page.nextArguments = {
      question,
      id,
      text: request.text,
      list,
      nodeTypes,
      relatedTo,
      edgeTypes,
      basisStates,
      depth: request.depth,
      limit: request.limit,
      cursor: structured.page.nextCursor,
      candidateBuildDirectory,
      proposalBaseBuildDirectory,
      expectedBasisSha256: basisSha256,
    };
  return {
    status: ok ? "answered" : "refused",
    ...(ok ? {} : { code, message }),
    question,
    builtAt: read.builtAt,
    ...(basisSha256 ? { basisSha256 } : {}),
    freshness: { state: read.freshness.state, text: read.freshness.text },
    ...(proposalFreshness ? { proposalFreshness } : {}),
    ...structured,
    ...(Array.isArray(rows) ? { rows } : {}),
    text: answerTextNow,
    ...common,
    note: "글자 스캔으로 만든 그래프다. 타입이 없고, 풀린 call·callback만 따라간다.",
  };
}

// The before/after content of one page of `changes --list content`. Before
// comes from the retained file next to the baseline; after from the source as
// it is now, only where it still matches this build. Bounded per side and per
// page; what the bound left out is said.
export const CONTENT_PAGE_BYTES = 256 * 1024;
export const CONTENT_SIDE_BYTES = 16 * 1024;
function contentPage(read, request) {
  const changes = read.check.changes;
  const items = changes?.status === "compared" ? changes.contentChanges || [] : [];
  const slice = items.slice(request.cursor, request.cursor + request.limit);
  const retained = readProductGraphRetainedContent(read);
  const sourceRoot = read.inputs?.sourceRoot || null;
  const sourceFor = sourceRoot ? graphSourceReader(read.graph, (relative) => sourceTextNow(sourceRoot, relative)) : () => null;
  const ix = walk.index(read.graph);
  const reasons = new Map();
  for (const item of read.check.lists?.unresolvedHandlers || []) {
    if (!reasons.has(item.id)) reasons.set(item.id, new Set());
    reasons.get(item.id).add(item.reason);
  }
  const nodes = new Map(read.graph.nodes.map((node) => [node.id, node]));
  let left = CONTENT_PAGE_BYTES;
  const side = (value, absentReason) => {
    if (!value) return { status: "unavailable", reason: absentReason };
    const allowed = Math.min(CONTENT_SIDE_BYTES, left);
    const shown = textPrefix(value.text, Math.max(0, allowed));
    left -= Buffer.byteLength(shown);
    const total = value.totalBytes ?? Buffer.byteLength(value.text);
    const cut = total - Buffer.byteLength(shown);
    return {
      status: cut > 0 || value.complete === false ? "partial" : "available",
      format: value.format,
      text: shown,
      ...(cut > 0
        ? { omittedBytes: cut, omittedBecause: value.complete === false ? "보관 한도" : allowed < CONTENT_SIDE_BYTES ? "이 페이지의 한도" : "한 쪽 한도" }
        : {}),
    };
  };
  const map = new Map();
  for (const item of slice) {
    const now = nodes.get(item.id);
    const before =
      item.change === "added"
        ? { status: "absent" }
        : side(retained.entries.get(item.id), retained.status === "read" ? "이 노드의 이전 본문은 보관되지 않았다" : `보관 본문 없음: ${retained.reason}`);
    let after;
    if (!now) after = { status: "absent" };
    else if (read.freshness?.state !== "fresh" && now.type === "코드") after = side(null, "소스가 빌드 뒤 바뀌었거나 확인되지 않아 현재 본문을 보이지 않는다");
    else after = side(nodeContent(now, { sourceFor, ix, reasons }), sourceRoot ? "현재 소스가 이 빌드와 다르거나 읽을 수 없다" : "소스 루트를 모른다");
    map.set(item.id, { before, after });
  }
  return { entries: map, retained: { status: retained.status, ...(retained.reason ? { reason: retained.reason } : {}) }, pageBytes: CONTENT_PAGE_BYTES };
}

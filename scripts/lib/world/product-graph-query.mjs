// product-graph-query: the agent's way to ask the existing product graph
// build. Read-only: it reads the build and never builds, checks, approves or
// writes. The answer text is the page's text board for the same question.
import { failCode as fail } from "../core/errors.mjs";
import { readProductGraphBuild } from "./product-graph.mjs";
import { productGraphWalk as walk } from "../../graph-explorer/product-graph-walk.js";
import { readerKey } from "./product-graph-compare.mjs";
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
  let proposalFreshness = null;
  if (question === "impact") {
    const candidate = candidateBuildDirectory ? readProductGraphBuild({ buildDirectory: candidateBuildDirectory }) : null;
    const base = proposalBaseBuildDirectory ? readProductGraphBuild({ buildDirectory: proposalBaseBuildDirectory }) : null;
    request.candidate = candidate?.status === "built" ? candidate.graph : null;
    // An explicitly missing basis never falls back to another convenient one.
    request.proposalBase = proposalBaseBuildDirectory ? (base?.status === "built" ? base.graph : null) : read.baselineEvidence;
    const scopes = [
      read.buildContext?.scope,
      base?.buildContext?.scope || (!proposalBaseBuildDirectory ? read.baselineEvidence?.scope : null),
      candidate?.buildContext?.scope,
    ];
    const reasons = [];
    if (scopes.some((scope) => !scope)) reasons.push("빌드 scope 증거가 없는 기준/후보가 있다");
    else {
      if (new Set(scopes.map((scope) => scope.projectId)).size !== 1) reasons.push("다른 Project의 빌드다");
      if (new Set(scopes.map((scope) => scope.sourceRootHash)).size !== 1) reasons.push("서로 다른 소스 루트다; 명시적인 동일 제품 매핑은 확인되지 않았다");
      if (new Set(scopes.map((scope) => readerKey(scope.reader))).size !== 1) reasons.push("읽는 방식이 다르다");
      if (scopes.some((scope) => !scope.parserSha256) || new Set(scopes.map((scope) => scope.parserSha256)).size !== 1)
        reasons.push("실제 parser 구현이 다르거나 미확인이다");
    }
    const graphs = [read.graph, request.proposalBase, request.candidate].filter(Boolean);
    if (new Set(graphs.map((graph) => graph.rulesSha256 ?? graph.inputs?.rulesSha256 ?? null)).size !== 1) reasons.push("호출 방식 표가 다르다");
    request.compatibility = { status: reasons.length ? "partial" : "verified", reasons };
    proposalFreshness = {
      candidate: candidate?.freshness || { state: "unknown" },
      base: base?.freshness || { state: "unknown" },
      explicitBase: Boolean(proposalBaseBuildDirectory),
    };
  }
  const basisSha256 = sha256Hex(
    canonicalJson({
      graph: read.graph,
      changes: read.check.changes || null,
      base: request.proposalBase || null,
      candidate: request.candidate || null,
      compatibility: request.compatibility || null,
      query: { question, text, id, list, nodeTypes, relatedTo, edgeTypes, basisStates, depth },
    }),
  );
  if (expectedBasisSha256 && expectedBasisSha256 !== basisSha256)
    return {
      status: "basis-changed",
      code: "PRODUCT_GRAPH_QUERY_BASIS_CHANGED",
      text: "조회 기준이 바뀌었다. 이전 페이지와 섞지 않았다. 현재 기준에서 다시 조회할 수 있다.\n",
      basisSha256,
      ...common,
    };
  // A build in a shape no released version wrote may lack what one question
  // needs. That question answers with a stated code; other questions that the
  // build can answer still work.
  let answer;
  try {
    answer = walk.ask(productGraphQueryContext(read), request);
  } catch {
    const message = `이 빌드(${read.directory})는 이 질문에 답할 모양이 아니다: 알려진 어느 버전의 빌드와도 모양이 다르다. 다시 만들려면: ${read.buildCommand}`;
    return { status: "unreadable", code: "PRODUCT_GRAPH_BUILD_UNREADABLE", message, buildCommand: read.buildCommand, text: `${message}\n`, ...common };
  }
  const { text: answerText, ok, code, message, ...structured } = answer;
  if (structured.page?.remaining)
    structured.page.nextArguments = {
      question,
      id,
      text,
      list,
      nodeTypes,
      relatedTo,
      edgeTypes,
      basisStates,
      depth,
      limit,
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
    basisSha256,
    freshness: { state: read.freshness.state, text: read.freshness.text },
    ...(proposalFreshness ? { proposalFreshness } : {}),
    ...structured,
    text: answerText,
    ...common,
    note: "글자 스캔으로 만든 그래프다. 타입이 없고, 풀린 call·callback만 따라간다.",
  };
}

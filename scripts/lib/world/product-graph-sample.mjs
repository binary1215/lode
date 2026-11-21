// A seeded sample of the product graph's edges for a person to review (2.5).
// Read-only: it picks edges, spread over the edge types present, and prints
// both ends with file and line range, where each edge was read and its
// evidence. It stores nothing and gives no verdict; the reviewer reads the
// source and reports.
import { failCode as fail } from "../core/errors.mjs";
import { readProductGraphBuild } from "./product-graph.mjs";

const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
export const PRODUCT_GRAPH_SAMPLE_DEFAULT = 30;
export const PRODUCT_GRAPH_SAMPLE_MAX = 500;

// mulberry32: small, seeded, the same sequence on every platform.
function generator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const where = (at) => (at ? `${at.path}:${at.line}` : "위치 없음");

function end(nodes, id) {
  const node = nodes.get(id);
  if (!node) return { id, type: null };
  if (node.type === "코드") return { id, type: node.type, file: node.file, lines: node.lines || null };
  return { id, type: node.type, ...(node.at ? { at: node.at } : {}), ...(node.positions?.length ? { at: node.positions[0] } : {}) };
}

const endText = (item) =>
  item.type === "코드"
    ? `${item.id} (${item.file}${item.lines ? `:${item.lines[0]}${item.lines[1] !== item.lines[0] ? `-${item.lines[1]}` : ""}` : ""})`
    : `${item.type || "없는 노드"} ${item.id}${item.at ? ` (${where(item.at)})` : ""}`;

function evidenceOf(edge) {
  return {
    kind: edge.type,
    ...(edge.count ? { count: edge.count } : {}),
    ...(edge.역할 ? { 역할: edge.역할 } : {}),
    ...(edge.judgement ? { judgement: true } : {}),
    ...(edge.설명 ? { 설명: edge.설명 } : {}),
    ...(edge.근거 ? { 근거: edge.근거 } : {}),
    ...(edge.basis ? { basis: edge.basis.status } : {}),
  };
}

const evidenceText = (evidence) =>
  [
    evidence.kind,
    evidence.역할 ? `역할 ${evidence.역할}` : null,
    evidence.judgement ? "판단" : null,
    evidence.count > 1 ? `${evidence.count}곳` : null,
    evidence.근거 ? `근거 ${[].concat(evidence.근거).join(", ")}` : null,
    evidence.basis ? `문서 ${evidence.basis}` : null,
    evidence.설명 ? `"${evidence.설명}"` : null,
  ]
    .filter(Boolean)
    .join(", ");

export function sampleProductGraph(options = {}) {
  const { seed = null, count = PRODUCT_GRAPH_SAMPLE_DEFAULT, types = [], ...location } = options;
  const wanted = Number(count);
  if (!Number.isInteger(wanted) || wanted < 1 || wanted > PRODUCT_GRAPH_SAMPLE_MAX)
    fail("PRODUCT_GRAPH_QUERY_INVALID", `count는 1부터 ${PRODUCT_GRAPH_SAMPLE_MAX}까지의 정수다.`);
  if (seed !== null && seed !== undefined && (!Number.isInteger(Number(seed)) || Number(seed) < 0 || Number(seed) > 0xffffffff))
    fail("PRODUCT_GRAPH_QUERY_INVALID", "seed는 0부터 4294967295까지의 정수다.");
  const read = readProductGraphBuild(location);
  const common = { readOnly: true, persisted: false, verdict: "none" };
  if (read.status !== "built") {
    const message = read.status === "not-built" ? `제품 그래프 빌드가 없다. 만들려면: ${read.buildCommand}` : `제품 그래프 빌드를 읽지 못했다: ${read.reason}`;
    return { status: read.status, code: read.code, message, text: `${message}\n`, ...common };
  }
  // Without a seed: one derived from the build, so the same build gives the same sample.
  const used = seed === null || seed === undefined ? parseInt(read.graphFileSha256.slice(0, 8), 16) : Number(seed);
  const random = generator(used);
  const nodes = new Map(read.graph.nodes.map((node) => [node.id, node]));
  const byType = new Map();
  for (const edge of read.graph.edges) {
    if (types.length && !types.includes(edge.type)) continue;
    if (!byType.has(edge.type)) byType.set(edge.type, []);
    byType.get(edge.type).push(edge);
  }
  // Each type shuffled by the seed, then taken in turn, so every type present
  // is in the sample before any type gets a second edge.
  const queues = [...byType.keys()].sort(compare).map((type) => {
    const list = [...byType.get(type)];
    for (let index = list.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random() * (index + 1));
      [list[index], list[other]] = [list[other], list[index]];
    }
    return list;
  });
  const picked = [];
  while (picked.length < wanted && queues.some((queue) => queue.length))
    for (const queue of queues) if (queue.length && picked.length < wanted) picked.push(queue.shift());
  const edges = picked.map((edge) => ({
    type: edge.type,
    from: end(nodes, edge.from),
    to: end(nodes, edge.to),
    at: edge.at || null,
    evidence: evidenceOf(edge),
  }));
  const total = [...byType.values()].reduce((sum, list) => sum + list.length, 0);
  const lines = [
    `표본: seed ${used}${seed === null || seed === undefined ? " (빌드에서 정함)" : ""}, 연결 ${total}개 중 ${edges.length}개${types.length ? ` (종류: ${types.join(", ")})` : ""}. 종류: ${
      [...byType.keys()]
        .sort(compare)
        .map((type) => `${type} ${byType.get(type).length}`)
        .join(", ") || "없음"
    }.`,
    "저장하지 않고 판정하지 않는다. 소스를 읽고 각 연결이 맞는지 알린다.",
    ...edges.map(
      (edge, index) =>
        `${index + 1}. ${edge.type}: ${endText(edge.from)} → ${endText(edge.to)} — 읽은 곳 ${where(edge.at)}; 근거: ${evidenceText(edge.evidence)}`,
    ),
  ];
  return {
    status: "sampled",
    ...common,
    seed: used,
    seedFrom: seed === null || seed === undefined ? "build" : "given",
    count: edges.length,
    total,
    types: Object.fromEntries([...byType.keys()].sort(compare).map((type) => [type, byType.get(type).length])),
    buildSha256: read.graphFileSha256,
    edges,
    text: `${lines.join("\n")}\n`,
  };
}

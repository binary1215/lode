// Checking reach against a real run (2.7). Read-only, stores nothing. The
// folder is what Node writes with NODE_V8_COVERAGE when the project ran one
// 기능 (Lode runs nothing). Every function range with a count above zero maps
// to the innermost declaration of the graph; the answer lists what ran outside
// the 기능's reach (the graph misses a path) and what the reach says but did
// not run (untaken branches and error paths are in there too).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { failCode as fail } from "../core/errors.mjs";
import { readProductGraphBuild } from "./product-graph.mjs";
import { productGraphWalk as walk } from "../../graph-explorer/product-graph-walk.js";

const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const MAX_COVERAGE_FILES = 2000;
const MAX_COVERAGE_BYTES = 64 * 1024 * 1024;
export const COVERAGE_FORMAT = "V8 coverage: NODE_V8_COVERAGE 폴더의 coverage-*.json (result[].url, functions[].ranges)";
const LISTED = 200;

// The 1-based line of a UTF-16 offset in text.
function lineOfOffset(text, offset) {
  let line = 1;
  for (let index = text.indexOf("\n"); index >= 0 && index < offset; index = text.indexOf("\n", index + 1)) line += 1;
  return line;
}

function readCoverage(folder) {
  let names;
  try {
    names = fs
      .readdirSync(folder)
      .filter((name) => /^coverage-.*\.json$/.test(name))
      .sort();
  } catch (error) {
    fail("PRODUCT_GRAPH_COVERAGE_UNREADABLE", `커버리지 폴더를 읽지 못했다(${error.code || "오류"}).`);
  }
  if (names.length > MAX_COVERAGE_FILES) fail("PRODUCT_GRAPH_COVERAGE_INVALID", `커버리지 파일이 ${MAX_COVERAGE_FILES}개를 넘는다.`);
  const scripts = [];
  let bytes = 0;
  for (const name of names) {
    const file = path.join(folder, name);
    const stat = fs.statSync(file);
    bytes += stat.size;
    if (bytes > MAX_COVERAGE_BYTES) fail("PRODUCT_GRAPH_COVERAGE_INVALID", `커버리지 파일이 모두 ${MAX_COVERAGE_BYTES}바이트를 넘는다.`);
    let document;
    try {
      document = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      fail("PRODUCT_GRAPH_COVERAGE_INVALID", `${name}을 V8 커버리지 JSON으로 읽지 못했다.`);
    }
    if (!Array.isArray(document?.result)) fail("PRODUCT_GRAPH_COVERAGE_INVALID", `${name}에 result 목록이 없다(V8 커버리지 형식이 아니다).`);
    for (const script of document.result)
      if (typeof script?.url === "string" && Array.isArray(script.functions)) scripts.push({ ...script, writtenAt: stat.mtimeMs });
  }
  return { files: names.length, scripts };
}

export function coverageProductGraph(options = {}) {
  const { feature = null, v8 = null, ...location } = options;
  if (typeof feature !== "string" || !feature) fail("PRODUCT_GRAPH_QUERY_INVALID", "기능 ID가 필요하다.");
  if (typeof v8 !== "string" || !v8) fail("PRODUCT_GRAPH_QUERY_INVALID", "V8 커버리지 폴더가 필요하다.");
  const read = readProductGraphBuild(location);
  const common = { readOnly: true, persisted: false, format: COVERAGE_FORMAT, lodeRan: false };
  if (read.status !== "built") {
    const message = read.status === "not-built" ? `제품 그래프 빌드가 없다. 만들려면: ${read.buildCommand}` : `제품 그래프 빌드를 읽지 못했다: ${read.reason}`;
    return { status: read.status, code: read.code, message, text: `${message}\n`, ...common };
  }
  const ctx = walk.context({ graph: read.graph });
  const node = ctx.ix.nodes.get(feature);
  if (!node || node.type !== "기능") fail("PRODUCT_GRAPH_NODE_NOT_FOUND", `${feature}라는 기능이 이 그래프에 없다.`);
  const sourceRoot = read.inputs?.sourceRoot ? path.resolve(read.inputs.sourceRoot) : null;
  const coverage = readCoverage(path.resolve(v8));
  const reached = walk.reachOf(ctx.ix, [feature]);
  const codeByFile = new Map();
  for (const item of read.graph.nodes) if (item.type === "코드") (codeByFile.get(item.file) || codeByFile.set(item.file, []).get(item.file)).push(item);
  const innermost = (file, line) => {
    let best = null;
    for (const item of codeByFile.get(file) || [])
      if (
        item.id !== item.file &&
        item.lines &&
        item.lines[0] <= line &&
        line <= item.lines[1] &&
        (!best || item.lines[1] - item.lines[0] < best.lines[1] - best.lines[0])
      )
        best = item;
    return best ? best.id : file;
  };
  // Scripts under the source root whose text is the current source. V8
  // coverage does not carry the text it ran: a script counts as the current
  // source when its length (its top-level range) equals the current file's
  // and the file was not changed after the coverage was written.
  const compared = new Set(),
    differs = [],
    executed = new Set();
  const outside = new Set();
  if (sourceRoot)
    for (const script of coverage.scripts) {
      if (!script.url.startsWith("file:")) continue;
      let absolute;
      try {
        absolute = fileURLToPath(script.url);
      } catch {
        continue;
      }
      const relative = path.relative(sourceRoot, absolute).replaceAll("\\", "/");
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        outside.add(script.url);
        continue;
      }
      if (!codeByFile.has(relative)) continue;
      let text, stat;
      try {
        text = fs.readFileSync(absolute, "utf8");
        stat = fs.statSync(absolute);
      } catch {
        differs.push({ path: relative, reason: "지금 소스를 읽지 못함" });
        continue;
      }
      const top = script.functions.find((item) => item.ranges?.[0]?.startOffset === 0);
      const length = top?.ranges[0].endOffset;
      if (length !== text.length || stat.mtimeMs > script.writtenAt) {
        differs.push({ path: relative, reason: length !== text.length ? "실행한 길이와 지금 길이가 다름" : "커버리지를 쓴 뒤 파일이 바뀜" });
        continue;
      }
      compared.add(relative);
      for (const item of script.functions) {
        const range = item.ranges?.[0];
        if (!range || !(range.count > 0)) continue;
        // A file's top level runs whenever the module is loaded: not counted.
        if (range.startOffset === 0) continue;
        const declaration = innermost(relative, lineOfOffset(text, range.startOffset));
        if (declaration !== relative) executed.add(declaration);
      }
    }
  const reason = !sourceRoot
    ? "소스 루트 없이 빌드 폴더만 받아 소스와 비교하지 못했다"
    : !coverage.scripts.length
      ? "커버리지 폴더에 스크립트가 없다"
      : !compared.size
        ? "커버리지의 스크립트 가운데 지금 소스와 같은 제품 코드 파일이 없다"
        : null;
  // Code that ran behind a stop of the walk from 입구 (another 기능's 처리
  // 코드) is told apart from code behind a missing edge.
  const behindStops = walk.closure(
    ctx.ix,
    (reached.stops || []).map((item) => item.id),
  );
  const ranBehindStop = reason ? null : [...executed].filter((id) => !reached.has(id) && behindStops.has(id)).sort(compare);
  const ranOutside = reason ? null : [...executed].filter((id) => !reached.has(id) && !behindStops.has(id)).sort(compare);
  const notRun = reason
    ? null
    : [...reached.keys()]
        .filter(
          (id) =>
            ctx.ix.nodes.get(id)?.type === "코드" &&
            ctx.ix.nodes.get(id).id !== ctx.ix.nodes.get(id).file &&
            compared.has(ctx.ix.nodes.get(id).file) &&
            !executed.has(id),
        )
        .sort(compare);
  const differsSorted = differs.sort((a, b) => compare(a.path, b.path));
  const listed = (items) =>
    items
      .slice(0, LISTED)
      .map((id) => `  - ${walk.nodeLine(ctx, id)}`)
      .concat(items.length > LISTED ? [`  - 외 ${items.length - LISTED}개 (구조화된 결과에 모두 있다)`] : []);
  const lines = [
    `커버리지와 닿는 범위: ${feature}`,
    `읽은 형식: ${COVERAGE_FORMAT}. 다른 형식은 읽지 않는다. Lode는 아무것도 실행하지 않았다. 아무것도 저장하지 않는다.`,
    `커버리지 파일 ${coverage.files}개, 스크립트 ${coverage.scripts.length}개, 지금 소스와 비교한 제품 코드 파일 ${compared.size}개. 같은 소스인지는 실행한 길이와 파일을 바꾼 시각으로만 본다(V8 커버리지는 실행한 글을 담지 않는다). 선언만 견주고, 모듈을 불러올 때 도는 파일 맨 위는 세지 않는다.`,
    ...(differsSorted.length
      ? [
          `실행한 파일이 지금 소스와 다름: ${differsSorted.length}개 (건너뜀)`,
          ...differsSorted.slice(0, LISTED).map((item) => `  - ${item.path} — ${item.reason}`),
        ]
      : []),
    ...(reason
      ? [`실행됐는데 닿는 범위 밖: 비교하지 않음 — ${reason}`, `닿는다고 했는데 돌지 않음: 비교하지 않음 — ${reason}`]
      : [
          `실행됐는데 닿는 범위 밖: ${ranOutside.length}개 (그래프가 놓친 경로다. 입구로 닿는 코드는 범위 안이다)`,
          ...listed(ranOutside),
          ...(ranBehindStop.length
            ? [
                `실행됐는데 입구에서 멈춘 곳 뒤에 있음: ${ranBehindStop.length}개 (닿는 범위는 입구에서 다른 기능의 처리 코드 앞에서 멈춘다. 빠진 연결이 아니다)`,
                ...listed(ranBehindStop),
              ]
            : []),
          `닿는다고 했는데 돌지 않음: ${notRun.length}개 (가지 않은 분기와 오류 경로도 여기에 든다. 비교한 파일의 선언만 센다)`,
          ...listed(notRun),
        ]),
  ];
  return {
    status: reason ? "not-compared" : "compared",
    ...common,
    feature,
    ...(reason
      ? {
          reason,
          missing: [
            { kind: "notCompared", site: "coverage", list: "ranOutsideReach" },
            { kind: "notCompared", site: "coverage", list: "reachedNotRun" },
          ],
        }
      : {}),
    coverageFiles: coverage.files,
    scripts: coverage.scripts.length,
    comparedFiles: [...compared].sort(compare),
    differs: differsSorted,
    outsideSourceRoot: outside.size,
    ranOutsideReach: ranOutside,
    ranBehindEntryStop: ranBehindStop,
    entryStops: reached.stops || [],
    reachedNotRun: notRun,
    text: `${lines.join("\n")}\n`,
  };
}

// Run records and the 기능→화면요소 edges the machine finds from evidence
// (2.6). Lode runs nothing: a project hands it what it ran and what came back
// (product-graph-runs-add). A run counts only while the 기능's content and
// reach hashes and the way code is read are what they were when it was
// recorded. 화면요소 nodes still come only from the user's documents; the
// edge to the 기능 that shows a result there is found here, from quoted
// phrases in the 화면요소 row (run output and code string literals), next to
// the row's own 보여 주는 기능 (근거 "문서"). Machine edges are evidence, not
// approval: they never change a document, an approval or a 확인 record, and
// they are derived again on every build. Pure: no file, clock or network.
import { codeMask } from "./source-code-mask.mjs";
import { productGraphWalk as walk } from "../../graph-explorer/product-graph-walk.js";

const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const where = (at) => `${at.path}:${at.line}`;
export const PHRASE_MIN = 4;
export const PHRASE_SPECIFIC = 10;
const WILDCARD = /<[^<>]*>|…/g;

// R<record short id>-<n>: the first 8 hex digits of the record id and the run's number.
export const runLabel = (runId, number) => `R${runId.replace(/^product-graph-run-/, "").slice(0, 8)}-${number}`;

// The quoted phrases of a 화면요소 row: backtick segments of its 한 줄 cell
// with at least PHRASE_MIN literal characters (<…> and … match any text). A
// row with a specific phrase (PHRASE_SPECIFIC literal characters or more)
// does not use its shorter ones.
export function rowPhrases(oneLine) {
  const phrases = [];
  for (const match of String(oneLine || "").matchAll(/`([^`]+)`/g)) {
    const text = match[1];
    const pieces = text.split(WILDCARD).filter((piece) => piece.length);
    const literal = pieces.join("").length;
    if (literal < PHRASE_MIN) continue;
    const source = pieces.map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\S]*?");
    phrases.push({ text, literal, pattern: new RegExp(source) });
  }
  const specific = phrases.filter((phrase) => phrase.literal >= PHRASE_SPECIFIC);
  return specific.length ? specific : phrases;
}

// Which runs count: the newest run of each (기능, 실행 label) replaces older
// ones in every list; a run whose 기능 changed since (content or reach hash,
// the reader) or left the graph gives no edge and is listed.
export function runStates({ graph, records, reader }) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const all = [];
  for (const record of [...records].sort((a, b) => compare(a.recordedAt, b.recordedAt) || compare(a.runId, b.runId)))
    for (const run of record.runs) all.push({ record, run, id: runLabel(record.runId, run.번호) });
  const newest = new Map();
  for (const item of all) newest.set(`${item.run.기능}\u0000${item.run.실행}`, item);
  const kept = [...newest.values()];
  const sameReader = (record) =>
    record.reader.generator === (reader?.generator ?? null) &&
    record.reader.graphVersion === (reader?.graphVersion ?? null) &&
    record.reader.sourceAnalysis === (reader?.sourceAnalysis ?? null);
  const current = [],
    stale = [];
  for (const item of kept) {
    const node = nodes.get(item.run.기능);
    const reason = !node
      ? "기능이 그래프에 없음"
      : !sameReader(item.record)
        ? "다른 방식으로 읽은 코드에서 실행함"
        : node.contentSha256 !== item.run.basis.contentSha256
          ? "기능의 내용이 바뀜"
          : node.reachSha256 !== item.run.basis.reachSha256
            ? "기능이 닿는 코드가 바뀜"
            : null;
    const entry = {
      id: item.id,
      record: item.record.runId,
      number: item.run.번호,
      기능: item.run.기능,
      실행: item.run.실행,
      상태: item.run.상태,
      종료: item.run.종료,
      recordedAt: item.record.recordedAt,
    };
    if (reason) stale.push({ ...entry, reason });
    else current.push({ ...entry, 출력: item.run.출력 });
  }
  const order = (a, b) => compare(a.기능, b.기능) || compare(a.실행, b.실행) || compare(a.id, b.id);
  return {
    current: current.sort(order),
    stale: stale.sort(order),
    replaced: all.length - kept.length,
    records: records.length,
    functions: new Set(all.map((item) => item.run.기능)).size,
    currentFunctions: new Set(current.map((item) => item.기능)).size,
  };
}

// String literals of a file (by the code mask), each with its text and start.
function literals(text, python) {
  const mask = codeMask(text, python ? "python" : "javascript");
  if (!mask.trusted) return [];
  const spans = [];
  for (let index = 0; index < text.length; index += 1) {
    if (mask[index] !== 0 || text[index] === "\n") continue;
    let end = index;
    while (end < text.length && mask[end] === 0) end += 1;
    const first = text[index];
    if (['"', "'", "`", "}"].includes(first)) spans.push({ start: index, body: text.slice(index + 1, end) });
    index = end;
  }
  return spans;
}

// Where a phrase is in the code: every string literal holding it, and for a
// module-level constant holding it, the places that use the constant (in its
// own file, or a file importing it by name). A use that cannot be resolved is
// kept apart.
// Each file read once per build (B3): its literals, lines and line starts.
// The read count says how many files were read.
export function fileReader(files) {
  const cache = new Map();
  const reader = (relative) => {
    if (!cache.has(relative)) {
      const text = files.get(relative);
      const starts = [0];
      for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) starts.push(index + 1);
      const lineOf = (offset) => {
        let low = 0,
          high = starts.length - 1;
        while (low < high) {
          const middle = (low + high + 1) >>> 1;
          if (starts[middle] <= offset) low = middle;
          else high = middle - 1;
        }
        return low + 1;
      };
      const lines = text.split("\n");
      const spans = literals(text, relative.endsWith(".py")).map((span) => ({ ...span, line: lineOf(span.start) }));
      cache.set(relative, { text, lines, lineOf, spans });
      reader.reads += 1;
    }
    return cache.get(relative);
  };
  reader.reads = 0;
  return reader;
}

function codePositions({ phrase, files, read }) {
  const positions = [],
    unresolved = [];
  for (const [relative, text] of files) {
    const python = relative.endsWith(".py");
    const file = read(relative);
    for (const span of file.spans) {
      if (!phrase.pattern.test(span.body)) continue;
      const line = span.line;
      const lineText = file.lines[line - 1] || "";
      const constant = python ? /^([A-Za-z_]\w*)\s*=/.exec(lineText)?.[1] : /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/.exec(lineText)?.[1];
      if (!constant) {
        positions.push({ path: relative, line });
        continue;
      }
      let used = false;
      const name = constant.replace(/[$]/g, "\\$");
      const stem = relative
        .split("/")
        .pop()
        .replace(/\.[^.]+$/, "")
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const word = new RegExp(`(?<![\\w$.])${name}(?![\\w$])`, "g");
      // A file that imports from the constant's module: by the constant's name
      // (its uses are resolved), or otherwise (its uses are not).
      const fromModule = new RegExp(`\\bimport\\b[^;]*\\bfrom\\s*["'][^"']*\\b${stem}(?:\\.[a-z]+)?["']|^from\\s+\\S*\\b${stem}\\s+import\\b`, "m");
      const byName = new RegExp(
        `\\bimport\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*["'][^"']*\\b${stem}(?:\\.[a-z]+)?["']|^from\\s+\\S*\\b${stem}\\s+import\\s+[^\\n]*\\b${name}\\b`,
        "m",
      );
      for (const [other, otherText] of files) {
        const resolved = other === relative || byName.test(otherText);
        if (!resolved && !fromModule.test(otherText)) continue;
        for (const match of otherText.matchAll(word)) {
          const at = read(other).lineOf(match.index);
          if (other === relative && at === line) continue;
          const statement = (read(other).lines[at - 1] || "").trim();
          if (/^(?:import|from)\b/.test(statement)) continue;
          if (resolved) {
            positions.push({ path: other, line: at, constant });
            used = true;
          } else unresolved.push({ path: other, line: at, constant, definedAt: { path: relative, line } });
        }
      }
      if (!used) positions.push({ path: relative, line, constant, unused: true });
    }
  }
  return { positions, unresolved };
}

// The machine's edges for one build. graph: the graph before machine edges;
// screens: the 화면 documents in use (approved, or estimates with the option);
// codeOf(path, line): the innermost code node there; files: the code texts.
export function machineEdges({ graph, screens, states, files, codeOf, removals = [] }) {
  const read = fileReader(files);
  const ctx = walk.context({ graph });
  const elements = [];
  for (const screen of screens)
    for (const element of screen.parsed.elements) elements.push({ element, screen, phrases: rowPhrases(element.oneLineCell ?? element.oneLine) });
  const functionIds = new Set(graph.nodes.filter((node) => node.type === "기능").map((node) => node.id));
  const evidence = new Map();
  const add = (functionId, element, screen, item) => {
    const key = `${functionId}\u0000${element.id}`;
    if (!evidence.has(key)) evidence.set(key, { functionId, element, screen, items: [] });
    evidence.get(key).items.push(item);
  };
  const reachersOf = new Map();
  const reachers = (codeId) => {
    if (!reachersOf.has(codeId)) reachersOf.set(codeId, codeId && ctx.ix.nodes.has(codeId) ? walk.reach(ctx, codeId).ids : []);
    return reachersOf.get(codeId);
  };
  const unconnected = [],
    unresolvedUses = [];
  let operatedOnly = 0;
  for (const { element, screen, phrases } of elements) {
    for (const id of element.shows) if (functionIds.has(id)) add(id, element, screen, { kind: "문서" });
    if (!phrases.length) {
      // S5: quoted text too short to use is said as such.
      const quoted = /`[^`]+`/.test(element.oneLineCell ?? "");
      // A row that only operates a 기능 (a button) shows no result: not a gap (F3).
      if (!element.shows.length && !quoted && element.operates?.length) {
        operatedOnly += 1;
        continue;
      }
      if (!element.shows.length)
        unconnected.push({
          id: element.id,
          at: { path: screen.path, line: element.line },
          reason: quoted ? `따옴표로 묶은 글이 너무 짧음(글자 ${PHRASE_MIN}개 미만)` : "따옴표로 묶은 글이 없음",
        });
      continue;
    }
    // Run evidence: the phrase in the output of a current run.
    const byRun = new Map();
    for (const run of states.current) if (phrases.some((phrase) => phrase.pattern.test(run.출력))) push(byRun, run.기능, run.id);
    for (const [functionId, ids] of byRun) if (functionIds.has(functionId)) add(functionId, element, screen, { kind: "실행", runs: ids.sort(compare) });
    // Code evidence: for a 화면요소 no run matched, or whose row names the 기능
    // that show it (the document narrows, it does not widen).
    let codeFound = false,
      codeReached = false;
    if (!byRun.size || element.shows.length) {
      for (const phrase of phrases) {
        const found = codePositions({ phrase, files, read });
        unresolvedUses.push(...found.unresolved.map((item) => ({ ...item, element: element.id, phrase: phrase.text })));
        for (const position of found.positions) {
          codeFound = true;
          const functions = reachers(codeOf(position.path, position.line)).filter((id) => !element.shows.length || element.shows.includes(id));
          if (functions.length) codeReached = true;
          for (const functionId of functions) add(functionId, element, screen, { kind: "코드", at: { path: position.path, line: position.line } });
        }
      }
    }
    if (!byRun.size && !codeReached && !element.shows.length)
      unconnected.push({
        id: element.id,
        at: { path: screen.path, line: element.line },
        reason: codeFound ? "코드에서 찾은 자리에 닿는 기능이 없음" : "글이 어느 실행 출력과 코드에도 없음",
        phrases: phrases.map((phrase) => phrase.text),
      });
  }
  // A judged rule removes a wrong machine edge; a rule that no longer matches
  // one is stale.
  const ruleIssues = [];
  for (const [index, rule] of removals.entries()) {
    const entry = evidence.get(`${rule["기능"]}\u0000${rule["화면요소"]}`);
    const machine = entry?.items.filter((item) => item.kind !== "문서") || [];
    if (!machine.length) {
      ruleIssues.push({
        종류: `빼는 연결[${index}]`,
        path: `${rule["기능"]} → ${rule["화면요소"]}`,
        reason: "규칙이 낡음 — 빼려는 기계 연결이 없음",
        rule: index,
      });
      continue;
    }
    entry.items = entry.items.filter((item) => item.kind === "문서");
    entry.removed = { rule: index, 이유: rule["이유"] };
  }
  const edges = [];
  const removed = [];
  for (const entry of [...evidence.values()].sort((a, b) => compare(a.functionId, b.functionId) || compare(a.element.id, b.element.id))) {
    if (entry.removed) removed.push({ from: entry.functionId, to: entry.element.id, ...entry.removed });
    if (!entry.items.length) continue;
    const kinds = new Set(entry.items.map((item) => item.kind));
    const runs = [...new Set(entry.items.filter((item) => item.kind === "실행").flatMap((item) => item.runs))].sort(compare);
    const codeAt = [...new Map(entry.items.filter((item) => item.kind === "코드").map((item) => [where(item.at), item.at])).values()].sort(
      (a, b) => compare(a.path, b.path) || a.line - b.line,
    );
    const 근거 = [...(kinds.has("문서") ? ["문서"] : []), ...(runs.length ? [`실행 ${runs.join(", ")}`] : []), ...codeAt.map((at) => `코드 ${where(at)}`)];
    edges.push({
      from: entry.functionId,
      to: entry.element.id,
      document: kinds.has("문서"),
      machine: kinds.has("실행") || kinds.has("코드"),
      근거,
      at: { path: entry.screen.path, line: entry.element.line },
      codeAt,
      runs,
    });
  }
  return {
    edges,
    removed,
    ruleIssues,
    lists: {
      documentOnly: edges.filter((edge) => edge.document && !edge.machine).map(({ from, to, at }) => ({ from, to, at })),
      machineOnly: edges.filter((edge) => !edge.document && edge.machine).map(({ from, to, at, 근거 }) => ({ from, to, at, 근거 })),
      unconnected: unconnected.sort((a, b) => compare(a.id, b.id)),
      unresolvedConstantUses: unresolvedUses.sort((a, b) => compare(a.path, b.path) || a.line - b.line),
    },
    phrased: elements.filter((item) => item.phrases.length).length,
    operatedOnly,
    filesRead: read.reads,
  };
}

function push(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

// Reads the product graph's documents (bundle 1). Every edge comes from an ID
// cited in a document; nothing is inferred from wording. Positions are the
// document path and 1-based line.
import { ACTIVITY_ID, SCREEN_ID } from "../storage/product-graph-store.mjs";

// IDs in the original's shapes. Look-behind keeps "UA-OPS-01" from also
// reading as the 화면 ID "OPS-01".
const ELEMENT_PATTERN = /(?<![\w-])([A-Z][A-Z0-9]*-[0-9]+)#([0-9]+(?:-[0-9]+)*)(?![\w-])/g;
const SCREEN_PATTERN = /(?<![\w#-])([A-Z][A-Z0-9]*-[0-9]+)(?![\w#-])/g;
const ACTIVITY_PATTERN = /(?<![\w-])(UA-[A-Z][A-Z0-9]*-[0-9]+)(?![\w-])/g;
export const ESTIMATE_KINDS = Object.freeze(["코드만 보고 쓴 추정", "화면만 보고 쓴 추정"]);

export function elementIdsIn(text) {
  return [...String(text).matchAll(ELEMENT_PATTERN)].map((match) => `${match[1]}#${match[2]}`);
}
export function screenIdsIn(text) {
  return [...String(text).matchAll(SCREEN_PATTERN)].map((match) => match[1]).filter((id) => !/^UA-/.test(id));
}
export function activityIdsIn(text) {
  return [...String(text).matchAll(ACTIVITY_PATTERN)].map((match) => match[1]);
}

// A cell that cites IDs: several are separated by commas; backticks are
// optional. "없음", "-" and empty cells cite nothing.
export function citedIds(cell) {
  return String(cell || "")
    .split(/[,，]/)
    .map((item) => item.replace(/`/g, "").trim())
    .filter((item) => item && !["없음", "-", "—"].includes(item));
}

function splitRow(line) {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  const cells = [];
  let current = "",
    code = false;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === "\\" && body[index + 1] === "|") {
      current += "|";
      index += 1;
    } else if (character === "`") {
      code = !code;
      current += character;
    } else if (character === "|" && !code) {
      cells.push(current.trim());
      current = "";
    } else current += character;
  }
  cells.push(current.trim());
  return cells;
}

const isSeparator = (line) => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);

// Parses one Markdown document into its title, level-2 sections and tables.
export function parseMarkdown(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const sections = [];
  let title = null,
    current = { heading: null, line: 1, lines: [] };
  sections.push(current);
  lines.forEach((line, index) => {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading && heading[1].length === 1 && title === null) {
      title = { text: heading[2].trim(), line: index + 1 };
      return;
    }
    if (heading && heading[1].length === 2) {
      current = { heading: heading[2].trim(), line: index + 1, lines: [] };
      sections.push(current);
      return;
    }
    current.lines.push({ text: line, line: index + 1 });
  });
  for (const section of sections) section.tables = tablesIn(section.lines);
  return { title, sections, lineCount: lines.length };
}

function tablesIn(lines) {
  const tables = [];
  for (let index = 0; index + 1 < lines.length; index += 1) {
    if (!lines[index].text.trim().startsWith("|") || !isSeparator(lines[index + 1].text)) continue;
    const header = splitRow(lines[index].text);
    const rows = [];
    let cursor = index + 2;
    for (; cursor < lines.length && lines[cursor].text.trim().startsWith("|"); cursor += 1)
      rows.push({ cells: splitRow(lines[cursor].text), line: lines[cursor].line });
    tables.push({ header, rows, line: lines[index].line });
    index = cursor - 1;
  }
  return tables;
}

export function section(parsed, heading) {
  return parsed.sections.find((item) => item.heading === heading) || null;
}

const columnIndex = (table, test) => table.header.findIndex((cell) => test(cell.replace(/`/g, "").trim()));

// A 항목 / 내용 table anywhere in the document: first cell names the row.
function metadata(parsed) {
  const rows = new Map();
  for (const part of parsed.sections)
    for (const table of part.tables)
      if (table.header.length >= 2 && ["항목", ""].includes(table.header[0]))
        for (const row of table.rows)
          if (row.cells[0] && !rows.has(row.cells[0])) rows.set(row.cells[0].replace(/`/g, "").trim(), { value: row.cells[1] || "", line: row.line });
  return rows;
}

function estimateOf(parsed) {
  const row = metadata(parsed).get("추정");
  if (!row) return { kind: null, line: null };
  const value = row.value.replace(/`/g, "").trim();
  return { kind: ESTIMATE_KINDS.includes(value) ? value : null, written: value, line: row.line };
}

const plain = (text) =>
  String(text || "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();

export const SCREEN_HEADINGS = Object.freeze(["이 화면이 무엇인가", "개요", "화면 흐름", "화면요소", "화면 정책"]);
export const ACTIVITY_HEADINGS = Object.freeze(["무엇을 하는가", "언제 하게 되나", "차례", "얻는 것", "다음 활동"]);

function missingHeadings(parsed, headings) {
  return headings.filter((heading) => !section(parsed, heading));
}

// 화면설계서. The file name is the 화면 ID.
export function parseScreenDocument({ id, path, text }) {
  const parsed = parseMarkdown(text);
  const meta = metadata(parsed);
  const issues = missingHeadings(parsed, SCREEN_HEADINGS).map((heading) => ({ kind: "절 없음", detail: heading, line: 1 }));
  const screen = {
    id,
    path,
    line: parsed.title?.line || 1,
    name: plain(meta.get("이름")?.value) || (parsed.title ? plain(parsed.title.text.replace(id, "")) : ""),
    group: plain(meta.get("IA 묶음")?.value) || id.split("-")[0],
    commonAreas: [],
    drawsCode: [],
    estimate: estimateOf(parsed),
    elements: [],
    policies: [],
    issues,
  };
  const metaId = meta.get("ID");
  if (metaId && plain(metaId.value) !== id) issues.push({ kind: "ID가 파일 이름과 다름", detail: plain(metaId.value), line: metaId.line });
  const common = meta.get("공통 영역");
  if (common) for (const cited of screenIdsIn(common.value)) screen.commonAreas.push({ id: cited, line: common.line });
  const draws = meta.get("그리는 코드");
  if (draws) for (const cited of citedIds(draws.value)) screen.drawsCode.push({ ref: cited, line: draws.line });
  const elements = section(parsed, "화면요소");
  for (const table of elements?.tables || []) {
    const idColumn = columnIndex(table, (cell) => cell === "ID");
    if (idColumn < 0) continue;
    const oneLine = columnIndex(table, (cell) => cell === "한 줄"),
      location = columnIndex(table, (cell) => cell === "위치"),
      operates = columnIndex(table, (cell) => cell.startsWith("조작")),
      shows = columnIndex(table, (cell) => cell.startsWith("보여"));
    for (const row of table.rows) {
      const elementId = plain(row.cells[idColumn]);
      if (!elementId) continue;
      const match = /^([A-Z][A-Z0-9]*-[0-9]+)#([0-9]+(?:-[0-9]+)*)$/.exec(elementId);
      if (!match) {
        issues.push({ kind: "화면요소 ID 모양이 아님", detail: elementId, line: row.line });
        continue;
      }
      if (match[1] !== id) issues.push({ kind: "다른 화면의 화면요소 ID", detail: elementId, line: row.line });
      const number = match[2];
      screen.elements.push({
        id: elementId,
        line: row.line,
        oneLine: oneLine >= 0 ? plain(row.cells[oneLine]) : "",
        location: location >= 0 ? plain(row.cells[location]) : "",
        parent: number.includes("-") ? `${match[1]}#${number.split("-").slice(0, -1).join("-")}` : null,
        operates: operates >= 0 ? citedIds(row.cells[operates]) : [],
        shows: shows >= 0 ? citedIds(row.cells[shows]) : [],
      });
    }
  }
  const policies = section(parsed, "화면 정책");
  for (const table of policies?.tables || []) {
    const idColumn = columnIndex(table, (cell) => cell === "정책" || cell === "ID");
    if (idColumn < 0) continue;
    const condition = columnIndex(table, (cell) => cell === "조건"),
      subject = columnIndex(table, (cell) => cell === "주체"),
      action = columnIndex(table, (cell) => cell === "행위");
    for (const row of table.rows) {
      const policyId = plain(row.cells[idColumn]);
      if (!policyId) continue;
      screen.policies.push({
        id: policyId,
        line: row.line,
        조건: condition >= 0 ? plain(row.cells[condition]) : null,
        주체: subject >= 0 ? plain(row.cells[subject]) : null,
        행위: action >= 0 ? plain(row.cells[action]) : null,
      });
    }
  }
  return screen;
}

// 유저플로우 기획서. The file name is the 유저 활동 ID.
export function parseActivityDocument({ id, path, text }) {
  const parsed = parseMarkdown(text);
  const meta = metadata(parsed);
  const issues = missingHeadings(parsed, ACTIVITY_HEADINGS).map((heading) => ({ kind: "절 없음", detail: heading, line: 1 }));
  const metaId = meta.get("ID");
  if (metaId && plain(metaId.value) !== id) issues.push({ kind: "ID가 파일 이름과 다름", detail: plain(metaId.value), line: metaId.line });
  const activity = {
    id,
    path,
    line: parsed.title?.line || 1,
    oneLine: plain(meta.get("한 줄")?.value) || (parsed.title ? plain(parsed.title.text.replace(id, "")) : ""),
    estimate: estimateOf(parsed),
    steps: [],
    next: [],
    issues,
  };
  const steps = section(parsed, "차례");
  for (const table of steps?.tables || []) {
    const cites = columnIndex(table, (cell) => cell === "화면요소");
    for (const row of table.rows) {
      const cells = cites >= 0 ? [row.cells[cites] || ""] : row.cells;
      const text = cells.join(" ");
      const elements = elementIdsIn(text);
      const screens = screenIdsIn(text.replace(ELEMENT_PATTERN, " "));
      activity.steps.push({ label: plain(row.cells[0]), line: row.line, elements, screens });
    }
  }
  const next = section(parsed, "다음 활동");
  for (const line of next?.lines || []) for (const cited of activityIdsIn(line.text)) activity.next.push({ id: cited, line: line.line });
  return activity;
}

// 유저 저니맵: 단계 table whose 유저 활동 column lists activity IDs per stage.
export function parseJourneyDocument({ path, text }) {
  const parsed = parseMarkdown(text);
  const stages = [];
  for (const part of parsed.sections)
    for (const table of part.tables) {
      const activities = columnIndex(table, (cell) => cell === "유저 활동");
      const stageColumn = columnIndex(table, (cell) => cell === "단계");
      if (activities < 0) continue;
      for (const row of table.rows)
        stages.push({
          name: plain(row.cells[stageColumn >= 0 ? stageColumn : 0]),
          line: row.line,
          activities: activityIdsIn(row.cells[activities] || "").map((cited) => ({ id: cited, line: row.line })),
        });
    }
  return { path, estimate: estimateOf(parsed), stages, hasActivityIds: stages.some((stage) => stage.activities.length) };
}

// IA 문서: 화면 목록 table (화면 ID, 이름, IA 묶음).
export function parseIaDocument({ path, text }) {
  const parsed = parseMarkdown(text);
  const screens = [];
  for (const part of parsed.sections)
    for (const table of part.tables) {
      const idColumn = columnIndex(table, (cell) => cell === "화면");
      if (idColumn < 0) continue;
      const name = columnIndex(table, (cell) => cell === "이름"),
        group = columnIndex(table, (cell) => cell === "IA 묶음");
      for (const row of table.rows)
        for (const cited of screenIdsIn(row.cells[idColumn] || ""))
          screens.push({ id: cited, line: row.line, name: name >= 0 ? plain(row.cells[name]) : "", group: group >= 0 ? plain(row.cells[group]) : "" });
    }
  return { path, estimate: estimateOf(parsed), screens };
}

export const CORE_HEADINGS = Object.freeze(["정체성", "타겟 유저", "제공 가치", "브랜딩"]);

// 제품 정의서: kept as its four parts for a reader; never judged by machine.
export function parseCoreDocument({ path, text }) {
  const parsed = parseMarkdown(text);
  const parts = CORE_HEADINGS.map((heading) => {
    const found = section(parsed, heading);
    return {
      heading,
      line: found?.line || null,
      text: found
        ? found.lines
            .map((line) => line.text)
            .join("\n")
            .trim()
        : null,
    };
  });
  return { path, estimate: estimateOf(parsed), parts };
}

// 정책.md: | ID | 종류 | 조건 | 주체 | 행위 | 지키는 기능 |
export function parsePolicyFile({ path, text }) {
  const parsed = parseMarkdown(text);
  const policies = [],
    issues = [];
  for (const part of parsed.sections)
    for (const table of part.tables) {
      const idColumn = columnIndex(table, (cell) => cell === "ID");
      const condition = columnIndex(table, (cell) => cell === "조건");
      if (idColumn < 0 || condition < 0) continue;
      const kind = columnIndex(table, (cell) => cell === "종류"),
        subject = columnIndex(table, (cell) => cell === "주체"),
        action = columnIndex(table, (cell) => cell === "행위"),
        keeps = columnIndex(table, (cell) => cell === "지키는 기능");
      for (const row of table.rows) {
        const id = plain(row.cells[idColumn]);
        if (!id) continue;
        const policyKind = kind >= 0 ? plain(row.cells[kind]) : "";
        if (!["처리", "표시"].includes(policyKind)) issues.push({ kind: "정책 종류가 처리·표시가 아님", detail: id, line: row.line });
        if (policies.some((item) => item.id === id)) issues.push({ kind: "같은 정책 ID가 두 번", detail: id, line: row.line });
        policies.push({
          id,
          line: row.line,
          kind: policyKind,
          조건: plain(row.cells[condition]),
          주체: subject >= 0 ? plain(row.cells[subject]) : "",
          행위: action >= 0 ? plain(row.cells[action]) : "",
          functions: keeps >= 0 ? citedIds(row.cells[keeps]) : [],
        });
      }
    }
  return { path, estimate: estimateOf(parsed), policies, issues };
}

// 기능 뜻.md: | 기능 | 뜻 | — one meaning line per 기능, apart from script output.
export function parseMeaningFile({ path, text }) {
  const parsed = parseMarkdown(text);
  const meanings = [];
  for (const part of parsed.sections)
    for (const table of part.tables) {
      const idColumn = columnIndex(table, (cell) => cell === "기능");
      const meaning = columnIndex(table, (cell) => cell === "뜻");
      if (idColumn < 0 || meaning < 0) continue;
      for (const row of table.rows) {
        const id = plain(row.cells[idColumn]);
        if (id) meanings.push({ id, line: row.line, text: plain(row.cells[meaning]) });
      }
    }
  return { path, meanings };
}

export { ACTIVITY_ID, SCREEN_ID };

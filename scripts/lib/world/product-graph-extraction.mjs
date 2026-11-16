// Code-origin nodes of the product graph (bundle 1): 코드 from the existing
// regex-based source analysis, 기능 from the entry-rule table (the original's
// 호출 방식 표). Same input, same output: the walk is sorted, nothing reads the
// clock, and no absolute path enters the result.
import fs from "node:fs";
import path from "node:path";
import { analyzeSourceFile, classifySourcePath, methodDefinitionSites, signatureSites } from "./source-analysis.mjs";
import { REPOSITORY_SCAN_EXCLUDED_DIRECTORIES } from "./repository-scan.mjs";
import { BUILT_IN_UI_MARKERS, BUILT_IN_UI_PATTERNS } from "./product-graph-ui-patterns.mjs";
import { codeMask, codeMaskKind } from "./source-code-mask.mjs";
import { bracketPairs, dynamicImports, findRow, lineStarts, rowNames, statementCallChain } from "./product-graph-table-rows.mjs";
import { effectiveGlobals } from "./product-graph-builtins.mjs";
import { bindingAt, definedMemberNames, javascriptFacts, pythonFacts } from "./product-graph-scopes.mjs";
import { failCode as fail } from "../core/errors.mjs";
import { sha256Hex } from "../core/digest.mjs";

const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const MAX_FILES = 50_000;
const MAX_READ_BYTES = 1024 * 1024;
const CODE_LANGUAGES = Object.freeze({
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".py": "python",
});
// Hidden directories that can hold entry configuration; other dot-directories
// (.git, caches, Lode's own store) are not product code.
const KEPT_HIDDEN_DIRECTORIES = new Set([".claude", ".codex", ".claude-plugin", ".codex-plugin"]);
const EXCLUDED = new Set([...REPOSITORY_SCAN_EXCLUDED_DIRECTORIES, ".lode", ".head"]);

// Built-in entry rules. Each is a judgement (판단) and states its handling as
// the original's B-2 does. A project rule of the same 종류 without 파일/패턴
// replaces the handling; one with 파일/패턴 adds a pattern source.
export const BUILT_IN_ENTRY_RULES = Object.freeze([
  Object.freeze({
    종류: "hook",
    처리: "따라간다",
    판단: true,
    설명: "Claude Code·Codex 플러그인/프로젝트의 hook 설정 JSON(hooks/*.json, .claude/settings*.json, .codex/hooks.json, 플러그인 매니페스트가 가리키는 파일)의 이벤트 하나가 기능 하나다. ID hook:<이벤트 이름>.",
  }),
  Object.freeze({
    종류: "command",
    처리: "따라간다",
    판단: true,
    설명: "slash command 파일(commands/*.md, .claude/commands/**/*.md)과 유저가 부를 수 있는 skill(skills/<이름>/SKILL.md, user-invocable: false가 아닌 것) 하나가 기능 하나다. ID command:<이름>.",
  }),
  Object.freeze({
    종류: "tool",
    처리: "따라간다",
    판단: true,
    설명: "MCP tool은 정해진 모양이 없어 프로젝트 규칙(파일 + 패턴)으로만 찾는다. ID tool:<이름>.",
  }),
  Object.freeze({
    종류: "cli",
    처리: "따라간다",
    판단: true,
    설명: "package.json bin, pyproject.toml [project.scripts]·[project.gui-scripts], 그리고 하위 명령 표는 프로젝트 규칙(파일 + 패턴)으로 찾는다. ID cli:<이름>.",
  }),
  Object.freeze({
    종류: "프론트",
    처리: "따라간다",
    판단: true,
    설명: "UI가 유저의 신호를 코드에 잇는 곳 하나가 기능 하나다. 툴킷마다 잇는 모양은 UI 연결 패턴 표의 항목(데이터)이고, 같은 방식 하나가 모든 항목을 읽는다. ID fe/<경로>/<구성요소>@<이벤트>:<대상>.",
  }),
]);

function walkSource(sourceRoot, excludes, skipped = new Map()) {
  const files = [];
  const skip = (reason) => skipped.set(reason, (skipped.get(reason) || 0) + 1);
  const excluded = (relative) => excludes.some((prefix) => relative === prefix || relative.startsWith(prefix + "/"));
  const visit = (relative) => {
    const absolute = relative ? path.join(sourceRoot, ...relative.split("/")) : sourceRoot;
    let entries;
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => compare(a.name, b.name))) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (excluded(child)) {
        skip("호출 방식 표의 source.제외");
        continue;
      }
      if (entry.isSymbolicLink()) {
        skip("심볼릭 링크");
        continue;
      }
      if (entry.isDirectory()) {
        if (EXCLUDED.has(entry.name) || (entry.name.startsWith(".") && !KEPT_HIDDEN_DIRECTORIES.has(entry.name))) {
          skip(`읽지 않는 폴더 ${entry.name}/`);
          continue;
        }
        visit(child);
      } else if (entry.isFile()) {
        if (files.length >= MAX_FILES) fail("PRODUCT_GRAPH_SOURCE_TOO_LARGE");
        files.push(child);
      }
    }
  };
  visit("");
  return files;
}

// Every file the build reads as text, by path: its text as read. The build
// hashes these (inputs.sourceFiles) so a later reader can tell whether the
// source moved since. Set only while extractProductGraphCode runs.
let readLog = null;
let rawReadLog = null;
let parseCache = null;

function readText(sourceRoot, relative) {
  const file = path.join(sourceRoot, ...relative.split("/"));
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > MAX_READ_BYTES) return null;
  try {
    const bytes = fs.readFileSync(file);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
    if (readLog) readLog.set(relative, text);
    if (rawReadLog) rawReadLog.set(relative, { sha256: sha256Hex(bytes), bytes: bytes.length });
    return text;
  } catch {
    return null;
  }
}

// The files a build would read as code now: the same walk and the same
// classification as the build. Used to tell a new code file from an unread one.
export function productGraphCodeFiles(sourceRoot, excludes = []) {
  return walkSource(
    path.resolve(sourceRoot),
    excludes.map((item) => item.replace(/\/$/, "")),
  ).filter((relative) => {
    const extension = path.posix.extname(relative).toLowerCase();
    return CODE_LANGUAGES[extension] && classifySourcePath(relative, extension) !== "test";
  });
}

// A 코드 ID carries no line number. A declaration whose qualified name repeats
// in its file (whatever its kind) gets ~<n>, its order among those
// declarations in source order (1-based), so two on one line differ too. That
// does not move when lines change elsewhere; it changes only when a
// same-named declaration is added, removed or moved before it, or when a
// second one appears (the first then gains ~1).
// A module-level value binding that is called (다): a 코드 node of its own kind.
const VALUE_KIND = "값";
const MAX_EXPORT_STEPS = 32;

const symbolId = (file, symbol) => symbol.id ?? `${file}#${symbol.qualifiedName}`;

function assignSymbolIds(relative, symbols) {
  const total = new Map();
  for (const symbol of symbols) total.set(symbol.qualifiedName, (total.get(symbol.qualifiedName) || 0) + 1);
  const seen = new Map();
  for (const symbol of symbols) {
    const ordinal = (seen.get(symbol.qualifiedName) || 0) + 1;
    seen.set(symbol.qualifiedName, ordinal);
    symbol.id = `${relative}#${symbol.qualifiedName}${total.get(symbol.qualifiedName) > 1 ? `~${ordinal}` : ""}`;
  }
}

const LANGUAGE_KEYWORDS = new Set(["async", "await", "elif", "except", "import", "in", "is", "not", "or", "and", "super", "yield"]);

// Why an unresolved call stayed unresolved. Only what the scan determined;
// every unresolved call is counted under exactly one reason. The "group" says
// which of the limits block's numbers it falls in: calls that cannot be
// product code (built-in, a keyword) or go to a module outside the product,
// and calls that can be product code.
export const UNRESOLVED_REASONS = Object.freeze([
  Object.freeze({
    key: "ambiguous",
    group: "product",
    label: "같은 이름의 선언이 여럿이라 하나로 정하지 못함",
    settle: "어느 선언인지 정해 줄 import 경로나 타입 정보",
  }),
  Object.freeze({
    key: "keyword",
    group: "keyword",
    label: "호출처럼 보이지만 언어 키워드임 (import(, async (, super( 같은 것)",
    settle: "정할 것이 없다. 호출이 아니다",
  }),
  Object.freeze({
    key: "builtin-namespace",
    group: "built-in",
    label: "언어·런타임 내장 네임스페이스의 멤버 (JSON.parse, Math.max 같은 것). 파일이 그 이름을 선언·들여오거나 묶지 않음",
    settle: "정할 것이 없다. 제품 코드가 아니다. 내장 이름 표에 없는 전역이면 프로젝트 규칙의 내장 이름에 더한다",
  }),
  Object.freeze({
    key: "builtin-global",
    group: "built-in",
    label: "언어·런타임 내장 함수나 생성자 (String(, setTimeout(, len( 같은 것). 파일이 그 이름을 선언·들여오거나 묶지 않음",
    settle: "정할 것이 없다. 제품 코드가 아니다. 내장 이름 표에 없는 전역이면 프로젝트 규칙의 내장 이름에 더한다",
  }),
  Object.freeze({
    key: "member-nowhere",
    group: "built-in",
    label: "제품 어디에도 그 이름의 함수·멤버가 없는 메서드 호출. 내장 메서드이거나 제품 밖 객체의 메서드라 제품 코드일 수 없음",
    settle: "정할 것이 없다. 제품 코드라면 그 함수가 있는 파일이 스캔 범위(확장자, source.제외)에 드는지 확인",
  }),
  Object.freeze({
    key: "external-import",
    group: "external",
    label: "제품 밖 모듈(상대 경로가 아닌 import)에서 들여온 이름",
    settle: "그 패키지 코드를 스캔 범위에 넣거나, 제품 밖 경계로 둔다는 판단",
  }),
  Object.freeze({
    key: "no-declaration",
    group: "product",
    label: "스캔한 코드 어디에도 그 이름의 선언이 없음",
    settle: "제품 코드라면 그 파일이 스캔 범위(확장자, source.제외)에 드는지 확인. 표에 없는 전역 이름이면 프로젝트 규칙의 내장 이름에 더한다",
  }),
  Object.freeze({
    key: "declared-elsewhere",
    group: "product",
    label: "이 파일에는 그 이름의 함수·클래스 선언이 없고 다른 파일에만 있으며, 잇는 import도 없음",
    settle: "전역 이름이나 star import까지 읽는 해석기 (타입 정보)",
  }),
  Object.freeze({
    key: "unknown-receiver",
    group: "product",
    label: "받는 쪽(객체)의 타입을 모르는 호출. 그 메서드 이름은 제품에 있음",
    settle: "타입 정보(구문 트리와 타입 검사기)",
  }),
  Object.freeze({
    key: "inherited",
    group: "product",
    label:
      "상속받은 멤버일 수 있음: 클래스에 그 이름의 메서드가 없고, 클래스가 다른 클래스를 상속하거나 그 이름을 본문 없는 선언(abstract, 시그니처)으로만 가짐 (super.x( 포함)",
    settle: "상속을 따라가는 해석기",
  }),
  Object.freeze({
    key: "local-function",
    group: "product",
    label: "매개변수나 지역 변수에 담긴 함수",
    settle: "데이터 흐름 분석 (어떤 함수가 그 변수에 들어오는지)",
  }),
  Object.freeze({
    key: "dynamic-import",
    group: "product",
    label: "동적 import: 경로가 글자 그대로가 아니거나, 같은 식에서 꺼내는 이름이 없음",
    settle: "경로를 글자로 쓰고 같은 식에서 이름을 꺼내기(.then((m) => m.이름) 또는 const { 이름 } = await import(...)), 또는 프로젝트 규칙",
  }),
  Object.freeze({
    key: "rest",
    group: "product",
    label: "그 밖: 스캔이 이유를 정하지 못함 (들여온 모듈을 찾지 못함, 모듈에 그 이름이 없음, 한 줄에 같은 이름이 메서드와 함수로 함께 쓰임)",
    settle: "구문 트리 기반의 더 정밀한 해석기",
  }),
]);

function resolveModule(fromFile, specifier, language, fileSet) {
  const tries = [];
  if (language === "python") {
    const dots = /^\.+/.exec(specifier)?.[0].length || 0;
    const rest = specifier.slice(dots).split(".").filter(Boolean).join("/");
    const bases = dots ? [path.posix.join(path.posix.dirname(fromFile), ...Array(dots - 1).fill(".."))] : ["", "src"];
    for (const base of bases) {
      const joined = path.posix.normalize(path.posix.join(base || ".", rest));
      tries.push(`${joined}.py`, `${joined}/__init__.py`);
    }
  } else {
    if (!specifier.startsWith(".")) return null;
    const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
    tries.push(
      joined,
      ...[".mjs", ".js", ".ts", ".tsx", ".jsx", ".cjs", ".mts"].map((ext) => joined + ext),
      ...["index.mjs", "index.js", "index.ts"].map((name) => `${joined}/${name}`),
    );
  }
  return tries.find((candidate) => fileSet.has(candidate.replace(/^\.\//, ""))) || null;
}

// A specifier that names a module of the product: relative in JavaScript;
// in Python, one that resolves to a scanned file (an absolute name that does
// not is taken as outside the product).
function isExternalSpecifier(relative, specifier, language, fileSet) {
  if (language === "python") return !specifier.startsWith(".") && !resolveModule(relative, specifier, language, fileSet);
  return !specifier.startsWith(".");
}

// Builds the 코드 layer: one node per file and per declaration, a 값 node per
// module-level value binding that is called, and call references that resolve
// to exactly one of them.
function buildCodeLayer(sourceRoot, files, excludes, projectGlobals = null) {
  const globals = effectiveGlobals(projectGlobals);
  const codeFiles = files.filter((relative) => {
    const extension = path.posix.extname(relative).toLowerCase();
    return CODE_LANGUAGES[extension] && classifySourcePath(relative, extension) !== "test";
  });
  const fileSet = new Set(codeFiles);
  const analyses = new Map();
  const parsingStarted = performance.now();
  for (const relative of codeFiles) {
    const text = readText(sourceRoot, relative);
    if (text === null) continue;
    const language = CODE_LANGUAGES[path.posix.extname(relative).toLowerCase()];
    const raw = rawReadLog?.get(relative);
    if (parseCache && raw) {
      parseCache.stats.verifiedSourceBytes += raw.bytes;
      const cached = parseCache.get(relative, raw.sha256);
      if (cached) {
        analyses.set(relative, { ...cached, text });
        continue;
      }
    }
    const { maskedText, classBodies, ...analysis } = analyzeSourceFile(text, language, path.posix.basename(relative), {
      maxSymbols: 10_000,
      withCallIndexes: true,
      withMaskedText: true,
    });
    assignSymbolIds(relative, analysis.symbols);
    const starts = lineStarts(text);
    const sites = language === "python" ? [] : methodDefinitionSites(maskedText, text);
    const signatures =
      language === "python"
        ? []
        : signatureSites(
            maskedText,
            classBodies.map((body) => body.open),
          );
    const facts = language === "python" ? pythonFacts(text, maskedText, analysis.symbols, starts) : javascriptFacts(text, maskedText, sites);
    // Names a class has only as a signature without a body (abstract, overloads).
    const bodyOwner = new Map(classBodies.map((body) => [body.open, body.qualifiedName]));
    const abstractMembers = new Map();
    for (const site of signatures) {
      const owner = bodyOwner.get(site.owner);
      if (!owner) continue;
      if (!abstractMembers.has(owner)) abstractMembers.set(owner, new Set());
      abstractMembers.get(owner).add(site.name);
    }
    // "new C(...)" is a reference to C (and so to its constructor): read here
    // as a call of the product graph, not a call fact of the shared scan.
    const lineAtIndex = (index) => {
      let low = 0,
        high = starts.length - 1;
      while (low < high) {
        const middle = (low + high + 1) >>> 1;
        if (starts[middle] <= index) low = middle;
        else high = middle - 1;
      }
      return low + 1;
    };
    const constructions = facts.constructions.map((item) => ({
      callee: item.callee,
      line: lineAtIndex(item.index),
      index: item.index,
      callerQualifiedName: null,
      callerIdentityAmbiguous: false,
      construction: true,
    }));
    const calls = [...analysis.semanticFacts.calls, ...constructions].sort((left, right) => left.line - right.line);
    analyses.set(relative, {
      text,
      language,
      lineCount: text.split("\n").length,
      starts,
      facts,
      abstractMembers,
      definedNames: definedMemberNames(text, maskedText, language, sites, signatures),
      ...analysis,
      semanticFacts: { ...analysis.semanticFacts, calls },
    });
    if (parseCache && raw) parseCache.put(relative, raw.sha256, analyses.get(relative));
  }
  if (parseCache) parseCache.stats.readAndParseMilliseconds = performance.now() - parsingStarted;
  const nodes = [];
  const declarations = new Map();
  const names = new Set();
  const lineOfIndex = (starts, index) => {
    let low = 0,
      high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >>> 1;
      if (starts[middle] <= index) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
  // Value candidates (다): a module-level binding that is not a declaration,
  // unique by name in its file. Only those that are called become nodes.
  const valuesOf = new Map();
  for (const [relative, analysis] of analyses) {
    nodes.push({ id: relative, type: "코드", kind: "file", file: relative, lines: [1, analysis.lineCount] });
    const byName = new Map();
    for (const symbol of analysis.symbols) {
      nodes.push({ id: symbol.id, type: "코드", kind: symbol.kind, file: relative, lines: [symbol.line, symbol.endLine ?? symbol.line] });
      if (!byName.has(symbol.qualifiedName)) byName.set(symbol.qualifiedName, []);
      byName.get(symbol.qualifiedName).push(symbol);
      names.add(symbol.name);
    }
    declarations.set(relative, byName);
    const counts = new Map();
    for (const value of analysis.facts.values) counts.set(value.name, (counts.get(value.name) || 0) + 1);
    const values = new Map();
    for (const value of analysis.facts.values)
      if (counts.get(value.name) === 1 && !byName.has(value.name))
        values.set(value.name, {
          id: `${relative}#${value.name}`,
          name: value.name,
          qualifiedName: value.name,
          kind: VALUE_KIND,
          line: lineOfIndex(analysis.starts, value.startIndex),
          endLine: lineOfIndex(analysis.starts, Math.max(value.startIndex, value.endIndex - 1)),
          file: relative,
        });
    valuesOf.set(relative, values);
  }
  // A method name that exists in the product: a declaration's name or a value
  // binding's name. A method call whose name is neither cannot be product code.
  // Every spelling that can define a callable member name counts too (class
  // fields, class expressions, object literals anywhere, signatures, quoted
  // names, assignments of functions), whether or not it became a declaration.
  const memberNames = new Set(names);
  for (const values of valuesOf.values()) for (const name of values.keys()) memberNames.add(name);
  for (const analysis of analyses.values()) for (const name of analysis.definedNames) memberNames.add(name);
  const found = (relative, qualifiedName) => declarations.get(relative)?.get(qualifiedName) || [];
  const unique = (relative, qualifiedName) => {
    const list = found(relative, qualifiedName);
    return list.length === 1 ? list[0] : null;
  };
  const bindingsOf = new Map(
    [...analyses].map(([relative, analysis]) => [relative, new Map(analysis.semanticFacts.bindings.map((binding) => [binding.local, binding]))]),
  );
  // Names a file declares, imports or binds anywhere: a global of the same
  // name there is not taken as the built-in.
  for (const [relative, analysis] of analyses) {
    const bound = new Set([...declarations.get(relative).keys()].map((name) => name.split(".")[0]));
    for (const symbol of analysis.symbols) bound.add(symbol.name);
    for (const local of bindingsOf.get(relative).keys()) bound.add(local);
    for (const value of analysis.facts.values) bound.add(value.name);
    for (const scope of [...analysis.facts.scopes, analysis.facts.moduleScope]) {
      for (const name of scope.params) bound.add(name);
      for (const name of scope.locals.keys()) bound.add(name);
    }
    analysis.boundNames = bound;
  }
  // Does a module have this name: a declaration, a value binding, or an object
  // literal binding whose members are declarations (<name>.<member>)?
  const declaresName = (module, name) =>
    declarations.get(module)?.has(name) ||
    valuesOf.get(module)?.has(name) ||
    analyses.get(module)?.symbols.some((symbol) => symbol.scopePath === name && !declarations.get(module).has(name));
  // Follows re-exports (라) to the module that has the name: export { a as b }
  // from, export * from, a local export list naming an import, and (Python) an
  // imported name of a package module. Bounded and cycle-safe.
  const follow = (module, name, seen = new Set()) => {
    const key = `${module}\0${name}`;
    if (seen.has(key) || seen.size >= MAX_EXPORT_STEPS) return null;
    seen.add(key);
    if (declaresName(module, name)) return { module, name };
    const analysis = analyses.get(module);
    if (!analysis) return null;
    const viaBinding = (local) => {
      const binding = bindingsOf.get(module)?.get(local);
      if (!binding || binding.namespace || isExternalSpecifier(module, binding.specifier, analysis.language, fileSet)) return null;
      const next = resolveModule(module, binding.specifier, analysis.language, fileSet);
      return next ? follow(next, binding.imported === "default" ? local : binding.imported, seen) : null;
    };
    if (analysis.language === "python") return viaBinding(name);
    for (const item of analysis.facts.exports) {
      if (item.kind === "re-export" && item.exported === name) {
        const next = item.specifier.startsWith(".") ? resolveModule(module, item.specifier, analysis.language, fileSet) : null;
        if (!next) return null;
        // "default" is the module's default export; a module that does not say
        // which name that is may still declare the requested name.
        return item.imported === "default" ? follow(next, "default", new Set(seen)) || follow(next, name, seen) : follow(next, item.imported, seen);
      }
      if (item.kind === "local" && item.exported === name) return declaresName(module, item.local) ? { module, name: item.local } : viaBinding(item.local);
    }
    const hits = new Map();
    for (const item of analysis.facts.exports)
      if (item.kind === "star" && item.specifier.startsWith(".")) {
        const next = resolveModule(module, item.specifier, analysis.language, fileSet);
        const hit = next && follow(next, name, new Set(seen));
        if (hit) hits.set(`${hit.module}\0${hit.name}`, hit);
      }
    return hits.size === 1 ? [...hits.values()][0] : null;
  };
  const context = { analyses, found, unique, fileSet, names, memberNames, globals, follow, bindingsOf, valuesOf };
  // Global names/ambiguity and re-exports can affect an otherwise unrelated
  // file. Reuse call contributions only under the exact resolution universe.
  // A non-class signature's body text is not used by resolution; its current
  // file still binds to raw bytes below (receiver lines/dynamic imports).
  const resolutionBasis = parseCache
    ? parseCache.signature({
        files: [...fileSet],
        globals,
        analyses: [...analyses].map(([file, analysis]) => {
          const { text, prepared, ...facts } = analysis;
          return [file, { ...facts, symbols: facts.symbols.map((symbol) => ({ ...symbol, signature: symbol.kind === "class" ? symbol.signature : null })) }];
        }),
      })
    : null;
  const references = new Map();
  const unresolvedByReason = new Map(UNRESOLVED_REASONS.map((reason) => [reason.key, new Map()]));
  let resolvedCount = 0,
    allCount = 0;
  let contribution = null;
  const addReference = (from, to, kind, file, line) => {
    const key = `${from}\0${to}\0${kind}`;
    if (!references.has(key)) references.set(key, { type: kind, from, to, source: { path: file, line }, count: 0 });
    references.get(key).count += 1;
    if (contribution) contribution.references.push({ from, to, kind, file, line });
  };
  const addUnresolved = (reason, callee) => {
    const bucket = unresolvedByReason.get(reason);
    bucket.set(callee, (bucket.get(callee) || 0) + 1);
    if (contribution) contribution.unresolved.push({ reason, callee });
  };
  // Two passes: the first finds which value bindings are called (they become
  // nodes and callers); the second records references and reasons.
  const calledValues = new Set();
  const markCalled = (id) => {
    calledValues.add(id);
    if (contribution) contribution.called.push(id);
  };
  for (const pass of ["values", "references"]) {
    for (const [relative, analysis] of analyses) {
      const workKey = `resolution:${pass}:${relative}`;
      const workBasis = parseCache ? parseCache.signature([resolutionBasis, rawReadLog.get(relative)?.sha256, pass, [...calledValues].sort()]) : null;
      const reused = parseCache?.getWork(workKey, workBasis);
      if (reused && Array.isArray(reused.references) && Array.isArray(reused.unresolved) && Array.isArray(reused.called)) {
        for (const ref of reused.references) addReference(ref.from, ref.to, ref.kind, ref.file, ref.line);
        for (const item of reused.unresolved) addUnresolved(item.reason, item.callee);
        for (const id of reused.called) calledValues.add(id);
        allCount += reused.allCount;
        resolvedCount += reused.resolvedCount;
        parseCache.stats.resolutionPassesReused = (parseCache.stats.resolutionPassesReused || 0) + 1;
        continue;
      }
      const beforeAll = allCount,
        beforeResolved = resolvedCount;
      contribution = parseCache ? { references: [], unresolved: [], called: [] } : null;
      const bindings = bindingsOf.get(relative);
      const callers = analysis.symbols.filter((symbol) => symbol.kind === "function" || symbol.kind === "binding");
      if (pass === "references") for (const value of valuesOf.get(relative).values()) if (calledValues.has(value.id)) callers.push(value);
      // Once per file: the line view and dynamic imports, kept for both passes.
      if (!analysis.prepared) {
        const lineMask = codeMask(analysis.text, analysis.language === "python" ? "python" : "javascript");
        let view = "";
        for (let index = 0; index < analysis.text.length; index += 1)
          view += !lineMask.trusted || lineMask[index] || analysis.text[index] === "\n" ? analysis.text[index] : " ";
        analysis.prepared = {
          maskedLines: view.split("\n"),
          dynamic: analysis.language !== "python" ? dynamicImports(analysis.text, lineMask) : [],
          receivers: new Map(),
        };
      }
      const { maskedLines, receivers } = analysis.prepared;
      // Dynamic imports on each line, in order, for the "import" pseudo-calls.
      const dynamicByLine = new Map();
      for (const item of analysis.prepared.dynamic) {
        if (!dynamicByLine.has(item.line)) dynamicByLine.set(item.line, []);
        dynamicByLine.get(item.line).push(item);
      }
      // The call scan keeps only a name for "expr).map(": look at the call's own
      // line to see whether every use of that name there follows a ".".
      const receiverOf = (line, callee) => {
        const key = `${line}\0${callee}`;
        if (receivers.has(key)) return receivers.get(key);
        const text = maskedLines[line - 1] || "";
        const name = callee.replace(/[$]/g, "\\$");
        const methods = [...text.matchAll(new RegExp(`\\.\\s*${name}\\s*\\(`, "g"))].length;
        const plain = [...text.matchAll(new RegExp(`(?<![\\w$.]\\s*)(?<![\\w$.])${name}\\s*\\(`, "g"))].length;
        const receiver = !methods && !plain ? "unknown" : methods && !plain ? "method" : methods ? "mixed" : "plain";
        receivers.set(key, receiver);
        return receiver;
      };
      for (const call of analysis.semanticFacts.calls) {
        // Only a plain name can be a value binding: the first pass skips the rest.
        if (pass === "values" && (call.callee.includes(".") || call.callee === "import")) continue;
        if (pass === "references") allCount += 1;
        // The innermost function, binding or called value whose lines hold the
        // call: exact even when its name repeats in the file.
        let caller = null;
        for (const symbol of callers)
          if (
            symbol.line <= call.line &&
            call.line <= (symbol.endLine ?? symbol.line) &&
            (!caller || (symbol.endLine ?? symbol.line) - symbol.line < (caller.endLine ?? caller.line) - caller.line)
          )
            caller = symbol;
        if (call.callee === "import" && analysis.language !== "python") {
          const item = dynamicByLine.get(call.line)?.shift();
          if (item) {
            if (pass === "values") continue;
            const outcome = resolveDynamicImport(relative, item, context);
            if (outcome.targets) {
              resolvedCount += 1;
              for (const target of outcome.targets) addReference(caller?.id || relative, target.id, "call", relative, call.line);
            } else {
              addUnresolved(outcome.reason, "import");
            }
            continue;
          }
        }
        const outcome = resolveCall(
          relative,
          analysis,
          {
            ...call,
            callerQualifiedName: caller?.qualifiedName ?? call.callerQualifiedName,
            receiver: call.callee.includes(".") ? null : receiverOf(call.line, call.callee),
          },
          bindings,
          context,
        );
        if (pass === "values") {
          if (outcome.target?.kind === VALUE_KIND) markCalled(outcome.target.id);
          continue;
        }
        if (outcome.target) {
          resolvedCount += 1;
          if (outcome.target.kind === VALUE_KIND) markCalled(outcome.target.id);
          addReference(caller?.id || relative, outcome.target.id, "call", relative, call.line);
        } else {
          addUnresolved(outcome.reason, call.callee);
        }
      }
      if (parseCache) {
        parseCache.putWork(workKey, workBasis, { ...contribution, allCount: allCount - beforeAll, resolvedCount: resolvedCount - beforeResolved });
        parseCache.stats.resolutionPassesComputed = (parseCache.stats.resolutionPassesComputed || 0) + 1;
      }
      contribution = null;
    }
  }
  for (const values of valuesOf.values())
    for (const value of values.values())
      if (calledValues.has(value.id)) nodes.push({ id: value.id, type: "코드", kind: VALUE_KIND, file: value.file, lines: [value.line, value.endLine] });
  const byReason = UNRESOLVED_REASONS.map((reason) => {
    const bucket = unresolvedByReason.get(reason.key);
    return {
      reason: reason.key,
      group: reason.group,
      label: reason.label,
      settle: reason.settle,
      count: [...bucket.values()].reduce((sum, count) => sum + count, 0),
      callees: [...bucket.entries()].map(([callee, count]) => ({ callee, count })).sort((a, b) => b.count - a.count || compare(a.callee, b.callee)),
    };
  });
  // Resolution helpers for table rows (T1): the same rules as for calls; a
  // value binding counts only when it is a node.
  const nodeValue = (module, name) => {
    const value = valuesOf.get(module)?.get(name);
    return value && calledValues.has(value.id) ? value : null;
  };
  const resolveName = (relative, name) => {
    const local = unique(relative, name) || nodeValue(relative, name);
    if (local) return local;
    const binding = bindingsOf.get(relative)?.get(name);
    if (!binding || binding.namespace) return null;
    const language = analyses.get(relative)?.language;
    if (isExternalSpecifier(relative, binding.specifier, language, fileSet)) return null;
    const module = resolveModule(relative, binding.specifier, language, fileSet);
    const place = module && (binding.imported === "default" ? follow(module, name) || follow(module, "default") : follow(module, binding.imported));
    return place ? unique(place.module, place.name) || nodeValue(place.module, place.name) : null;
  };
  const resolveMember = (relative, head, member) => {
    const binding = bindingsOf.get(relative)?.get(head);
    if (!binding) return unique(relative, `${head}.${member}`);
    const language = analyses.get(relative)?.language;
    if (isExternalSpecifier(relative, binding.specifier, language, fileSet)) return null;
    const module = resolveModule(relative, binding.specifier, language, fileSet);
    if (!module) return null;
    const place = binding.namespace ? follow(module, member) : follow(module, binding.imported === "default" ? head : binding.imported);
    if (!place) return null;
    return binding.namespace ? unique(place.module, place.name) || nodeValue(place.module, place.name) : unique(place.module, `${place.name}.${member}`);
  };
  return {
    analyses,
    nodes,
    unique,
    resolveName,
    resolveMember,
    resolveDynamic: (relative, item) => resolveDynamicImport(relative, item, context),
    references,
    referenceSummary: {
      allCalls: allCount,
      resolvedCalls: resolvedCount,
      unresolvedCalls: allCount - resolvedCount,
      unresolvedByReason: byReason,
    },
    excludes,
  };
}

// A dynamic import with a literal relative path and a member named in the
// same expression resolves to that export; anything else says why not.
function resolveDynamicImport(relative, item, { unique, fileSet, follow }) {
  if (item.specifier === null || !item.members.length) return { reason: "dynamic-import" };
  if (!item.specifier.startsWith(".")) return { reason: "external-import" };
  const module = resolveModule(relative, item.specifier, "javascript", fileSet);
  if (!module) return { reason: "rest" };
  const targets = item.members.map((member) => {
    const place = follow(module, member);
    return place ? unique(place.module, place.name) : null;
  });
  return targets.every(Boolean) ? { targets } : { reason: "rest" };
}

function enclosingClass(analysis, qualifiedName) {
  if (!qualifiedName) return null;
  const parts = qualifiedName.split(".");
  for (let length = parts.length; length > 0; length -= 1) {
    const candidate = parts.slice(0, length).join(".");
    if (analysis.symbols.some((symbol) => symbol.qualifiedName === candidate && symbol.kind === "class")) return candidate;
  }
  return null;
}

// Whether a class declares a base class: "class C extends B", "class C(Base):".
function classExtends(analysis, qualifiedName) {
  const symbol = analysis.symbols.find((item) => item.kind === "class" && item.qualifiedName === qualifiedName);
  if (!symbol) return false;
  if (analysis.language === "python") return /^class\s+\w+\s*\(\s*(?!object\s*\))[^)\s]/.test(symbol.signature || "");
  return /\bextends\b/.test(symbol.signature || "");
}

// Resolves one call to exactly one declaration or called value, or says why it did not.
function resolveCall(relative, analysis, call, bindings, context) {
  const { found, unique, fileSet, names, memberNames, globals, follow, analyses, valuesOf } = context;
  const callee = call.callee;
  const language = analysis.language;
  const table = globals[language === "python" ? "python" : "javascript"];
  const pick = (file, qualifiedName, filter = null) => {
    const list = found(file, qualifiedName).filter((symbol) => !filter || filter(symbol));
    return list.length === 1 ? { target: list[0] } : list.length > 1 ? { reason: "ambiguous" } : null;
  };
  const valueAt = (file, name) => {
    const value = valuesOf.get(file)?.get(name);
    return value ? { target: value } : null;
  };
  // A method name that exists nowhere in the product cannot be product code.
  const unknownMember = (member) => ({ reason: memberNames.has(member.replace(/^#/, "")) || memberNames.has(member) ? "unknown-receiver" : "member-nowhere" });
  // A member of a class (JavaScript: C.x needs a static method; v.x where v = new C() any method).
  const classMember = (module, className, member, needsStatic) => {
    const outcome = pick(
      module,
      `${className}.${member}`,
      needsStatic && language !== "python" ? (symbol) => /(^|\s)static\s/.test(symbol.signature || "") : null,
    );
    if (outcome) return outcome;
    if (classExtends(analyses.get(module), className) || analyses.get(module)?.abstractMembers?.get(className)?.has(member)) return { reason: "inherited" };
    return unknownMember(member);
  };
  // The scope chain of the caller, innermost first, for a plain name.
  const scope = call.callerQualifiedName ? call.callerQualifiedName.split(".") : [];
  const nested = (name) => {
    for (let length = scope.length; length >= 1; length -= 1) {
      const outcome = pick(relative, [...scope.slice(0, length), name].join("."));
      if (outcome) return outcome;
    }
    return null;
  };
  // Where an imported name lives (through re-exports), or a reason.
  const imported = (binding, local) => {
    if (isExternalSpecifier(relative, binding.specifier, language, fileSet)) return { reason: "external-import" };
    const module = resolveModule(relative, binding.specifier, language, fileSet);
    // A default import: the declaration of the local's name (as before), else
    // the module's default export.
    const place = module && (binding.imported === "default" ? follow(module, local) || follow(module, "default") : follow(module, binding.imported));
    return place ? { place } : { reason: "rest" };
  };
  const self = language === "python" ? "self." : "this.";
  if (callee.startsWith(self)) {
    const member = callee.slice(self.length);
    const owner = enclosingClass(analysis, call.callerQualifiedName);
    if (owner) return classMember(relative, owner, member, false);
    return unknownMember(member);
  }
  if (!callee.includes(".")) {
    if (LANGUAGE_KEYWORDS.has(callee)) return { reason: "keyword" };
    // A method called on an expression the scan dropped ("a().map(").
    if (call.receiver === "method") return unknownMember(callee);
    const inner = nested(callee);
    if (inner) return inner;
    // Python "cls(...)" in a classmethod constructs the enclosing class.
    if (language === "python" && callee === "cls") {
      const owner = enclosingClass(analysis, call.callerQualifiedName);
      const method = analysis.symbols.find((symbol) => symbol.qualifiedName === call.callerQualifiedName && symbol.kind === "function");
      if (owner && /\(\s*cls\b/.test(method?.signature || "")) {
        const outcome = pick(relative, owner);
        if (outcome) return outcome;
      }
    }
    // A parameter or local of an enclosing function holds the function (바).
    if (call.index !== undefined && bindingAt(analysis.facts, call.index, callee)) return { reason: "local-function" };
    const top = pick(relative, callee) || valueAt(relative, callee);
    if (top) return top;
    const binding = bindings.get(callee);
    if (binding && !binding.namespace) {
      const outcome = imported(binding, callee);
      if (!outcome.place) return outcome;
      return pick(outcome.place.module, outcome.place.name) || valueAt(outcome.place.module, outcome.place.name) || { reason: "rest" };
    }
    if (binding?.namespace) return { reason: isExternalSpecifier(relative, binding.specifier, language, fileSet) ? "external-import" : "rest" };
    if (table.functions.has(callee) && !analysis.boundNames.has(callee)) return { reason: "builtin-global" };
    if (call.receiver !== "plain") return { reason: "rest" };
    return { reason: names.has(callee) ? "declared-elsewhere" : "no-declaration" };
  }
  const [head, member] = callee.split(".");
  if (head === "super") return { reason: "inherited" };
  // A parameter or local of an enclosing function: only "const v = new C(...)"
  // (Python: v = C(...) assigned once in that function) says what v is.
  const local = call.index !== undefined ? bindingAt(analysis.facts, call.index, head) : null;
  const created = (entries) => {
    if (!entries || entries.length !== 1) return null;
    const entry = entries[0];
    return entry.kind === "const-new" || entry.kind === "call-assign" ? entry.className : null;
  };
  const classNamed = (name) => {
    // A class this file can name: nested or module level here, or imported.
    const here = nested(name) || pick(relative, name);
    if (here?.target?.kind === "class") return { module: relative, name: here.target.qualifiedName };
    const binding = bindings.get(name);
    if (binding && !binding.namespace) {
      const outcome = imported(binding, name);
      if (outcome.place && unique(outcome.place.module, outcome.place.name)?.kind === "class") return outcome.place;
    }
    return null;
  };
  if (local) {
    const className = created(local.entries);
    const owner = className && classNamed(className);
    return owner ? classMember(owner.module, owner.name, member, false) : unknownMember(member);
  }
  const binding = bindings.get(head);
  if (binding?.namespace) {
    // A namespace import: the member is a name of that module (through re-exports).
    if (isExternalSpecifier(relative, binding.specifier, language, fileSet)) return { reason: "external-import" };
    const module = resolveModule(relative, binding.specifier, language, fileSet);
    const place = module && follow(module, member);
    return (place && (pick(place.module, place.name) || valueAt(place.module, place.name))) || { reason: "rest" };
  }
  if (binding) {
    const outcome = imported(binding, head);
    if (!outcome.place) return outcome;
    const { module, name } = outcome.place;
    if (unique(module, name)?.kind === "class") return classMember(module, name, member, true);
    return pick(module, `${name}.${member}`) || unknownMember(member);
  }
  // Module level of this file: a class, an object literal binding, or a const
  // created once by new C(...).
  const headClass = pick(relative, head);
  if (headClass?.target?.kind === "class") return classMember(relative, head, member, true);
  const literal = pick(relative, `${head}.${member}`);
  if (literal) return literal;
  const moduleCreated = created(analysis.facts.moduleScope.locals.get(head));
  if (moduleCreated) {
    const owner = classNamed(moduleCreated);
    if (owner) return classMember(owner.module, owner.name, member, false);
  }
  if (table.namespaces.has(head) && !analysis.boundNames.has(head)) return { reason: "builtin-namespace" };
  return unknownMember(member);
}

// Innermost declaration whose line range holds one line, else the file.
function enclosingCode(code, relative, line) {
  const analysis = code.analyses.get(relative);
  if (!analysis) return null;
  let best = null;
  for (const symbol of analysis.symbols) {
    const end = symbol.endLine ?? symbol.line;
    if (symbol.line <= line && line <= end && (!best || end - symbol.line < (best.endLine ?? best.line) - best.line)) best = symbol;
  }
  return best ? symbolId(relative, best) : relative;
}

function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const fields = {};
  if (match)
    for (const line of match[1].split(/\r?\n/)) {
      const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
      if (field) fields[field[1]] = field[2].replace(/^["']|["']$/g, "").trim();
    }
  return fields;
}

function lineOf(text, index) {
  let line = 1;
  for (let position = text.indexOf("\n"); position >= 0 && position < index; position = text.indexOf("\n", position + 1)) line += 1;
  return line;
}

// Reads an expression from `start` to its end: a top-level comma, an
// unmatched closing bracket, or the end of the line for an unbracketed
// assignment. Strings and nested brackets are skipped.
function readExpression(text, start) {
  let depth = 0,
    quote = null;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") quote = character;
    else if ("([{".includes(character)) depth += 1;
    else if (")]}".includes(character)) {
      if (depth === 0) return text.slice(start, index);
      depth -= 1;
    } else if (depth === 0 && (character === "," || character === ";" || character === "\n")) return text.slice(start, index);
  }
  return text.slice(start);
}

const NO_NAME_EMITTERS = new Set(["self", "this", "cls"]);
// The emitting object's name: an element id it is looked up by with a
// literal, else the last name of a plain dotted name. A call or an indexed
// expression without a literal id ("$(id)", "list[i]") names no element, and
// self/this/cls alone have none.
function emitterName(emitter) {
  if (!emitter) return null;
  const id = /(?:getElementById|\$)\(\s*["'`]#?([\w-]+)["'`]\s*\)$|querySelector\(\s*["'`]#([\w-]+)["'`]\s*\)$/.exec(emitter);
  if (id) return id[1] || id[2];
  const plain = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(emitter);
  if (!plain) return null;
  const last = emitter.split(".").at(-1);
  return NO_NAME_EMITTERS.has(last) || NO_NAME_EMITTERS.has(emitter) ? null : last;
}

function tagId(text, index) {
  const open = text.lastIndexOf("<", index),
    close = text.indexOf(">", index);
  if (open < 0) return null;
  const tag = text.slice(open, close < 0 ? text.length : close);
  return /\sid\s*=\s*["'{]\s*["']?([\w-]+)/.exec(tag)?.[1] || null;
}

function assignedName(text, index) {
  const start = text.lastIndexOf("\n", index) + 1;
  return /^\s*(?:(?:self|this)\.)?([A-Za-z_$][\w$]*)\s*=[^=]/.exec(text.slice(start, index))?.[1] || null;
}

// A target that names its handler: a name, self./this. member, a bound
// method, or a plain call of one name. Inline functions name none.
function handlerNameOf(target) {
  const text = target.trim().replace(/;$/, "").trim();
  if (/^(?:lambda\b|function\b|async\b|\(|[A-Za-z_$][\w$]*\s*=>)/.test(text)) return null;
  return (
    /^(?:(?:this|self|cls)\.)?([A-Za-z_$][\w$]*)$/.exec(text)?.[1] ||
    /^(?:this\.)?([A-Za-z_$][\w$]*)\.bind\(\s*this\s*\)$/.exec(text)?.[1] ||
    /^(?:(?:this|self)\.)?([A-Za-z_$][\w$]*)\s*\([^()]*\)$/.exec(text)?.[1] ||
    null
  );
}

function transformEvent(event, transforms = []) {
  let value = event;
  for (const step of transforms) {
    if (step === "소문자") value = value.toLowerCase();
    else if (step === "첫 글자 소문자") value = value.charAt(0).toLowerCase() + value.slice(1);
    else if (step?.떼기) value = value.replace(new RegExp(step.떼기, "g"), "");
  }
  return value;
}

// Effective rules: built-ins with project overrides, plus project pattern
// rules (tool, cli) and the UI binding pattern table (built-in entries, then
// project entries; a project entry with the same 이름 replaces a built-in).
export function effectiveEntryRules(projectRules) {
  const rules = BUILT_IN_ENTRY_RULES.map((rule) => ({ ...rule, 출처: "기본" }));
  const patterns = [];
  const ui = new Map(BUILT_IN_UI_PATTERNS.map((entry) => [entry.이름, { ...entry, 출처: "기본" }]));
  for (const rule of projectRules?.rules || []) {
    if (rule["종류"] === "프론트" && (rule["모양"] !== undefined || rule["메서드"] !== undefined)) {
      const { 종류, ...entry } = rule;
      ui.set(rule["이름"], { 판단: true, ...entry, 출처: "프로젝트" });
      continue;
    }
    if (rule["패턴"] !== undefined) {
      patterns.push({
        종류: rule["종류"],
        처리: rule["처리"] || rules.find((item) => item.종류 === rule["종류"]).처리,
        판단: true,
        설명: rule["설명"] || "",
        파일: [...rule["파일"]],
        패턴: rule["패턴"],
        "처리 코드": rule["처리 코드"] || "줄을 감싼 코드",
        출처: "프로젝트",
      });
      continue;
    }
    const base = rules.find((item) => item.종류 === rule["종류"]);
    if (rule["처리"]) base.처리 = rule["처리"];
    if (rule["설명"]) base.설명 = rule["설명"];
    base.출처 = "기본 + 프로젝트";
  }
  const markers = [...BUILT_IN_UI_MARKERS, ...(projectRules?.["화면 코드 표시"] || []).map((entry) => ({ ...entry, 출처: "프로젝트" }))];
  return { rules, patterns, uiPatterns: [...ui.values()], uiMarkers: markers, uiFiles: [...(projectRules?.["화면 파일"] || [])] };
}

// One mechanism for every UI binding pattern: reads each table entry against
// the files it names. Returns wiring found, per file, for the gap list.
function extractUiBindings({ root, files, code, uiPatterns, addFunction }) {
  const notTaken = [];
  const callbacks = [];
  const wired = new Set();
  const texts = new Map();
  const textOf = (relative) => {
    if (!texts.has(relative)) texts.set(relative, readText(root, relative));
    return texts.get(relative);
  };
  // Code only: comments and string contents blanked by the lexer mask, so a
  // file sign or a wiring written in a comment or a string does not count.
  const maskOf = new Map();
  const maskFor = (relative, text) => {
    if (!maskOf.has(relative)) maskOf.set(relative, codeMask(text, codeMaskKind(path.posix.extname(relative).toLowerCase())));
    return maskOf.get(relative);
  };
  // A file whose mask is not trusted (the lexer ended inside a string,
  // template or comment) falls back to the line-local check for 코드만 and
  // to its raw text for file signs; it is named in the limits block.
  const untrustedMask = new Set();
  const maskedOf = new Map();
  const masked = (relative, text) => {
    if (!maskedOf.has(relative)) {
      const mask = maskFor(relative, text);
      if (!mask.trusted) {
        untrustedMask.add(relative);
        maskedOf.set(relative, text);
        return text;
      }
      let view = "";
      for (let index = 0; index < text.length; index += 1) view += mask[index] || text[index] === "\n" ? text[index] : " ";
      maskedOf.set(relative, view);
    }
    return maskedOf.get(relative);
  };
  const inCode = (relative, text, start) => {
    const mask = maskFor(relative, text);
    if (mask.trusted) return Boolean(mask[start]);
    untrustedMask.add(relative);
    return startsInCodeOnLine(text, start, relative.endsWith(".py"));
  };
  const unnamed = new Map();
  const nextUnnamed = (key) => {
    const value = (unnamed.get(key) || 0) + 1;
    unnamed.set(key, value);
    return `요소#${value}`;
  };
  const componentAt = (relative, line) => {
    const analysis = code.analyses.get(relative);
    const stem = path.posix.basename(relative).replace(/\.[^.]+$/, "");
    if (!analysis) return { name: stem, qualified: null };
    // A member of an object literal (<binding>.<member>, no declaration of that
    // binding) is not a component: the 프론트 ID stays what it was before members
    // were declarations. A class method never is either (its class comes first).
    const declared = new Set(analysis.symbols.map((symbol) => symbol.qualifiedName));
    const holding = analysis.symbols.filter(
      (symbol) => symbol.line <= line && line <= (symbol.endLine ?? symbol.line) && !(symbol.scopePath && !declared.has(symbol.scopePath)),
    );
    const innermost = (kinds) =>
      holding.filter((symbol) => kinds.includes(symbol.kind)).sort((a, b) => (a.endLine ?? a.line) - a.line - ((b.endLine ?? b.line) - b.line))[0] || null;
    const owner = innermost(["class"]) || innermost(["function", "binding"]);
    return owner ? { name: owner.qualifiedName, qualified: owner.qualifiedName, isClass: owner.kind === "class" } : { name: stem, qualified: null };
  };
  const resolve = (relative, component, name, target) => {
    if (name) {
      if (component.qualified) {
        const member = code.unique(relative, `${component.qualified}.${name}`);
        if (member) return member.id;
      }
      return code.unique(relative, name)?.id || null;
    }
    const called = [...new Set([...target.matchAll(/(?:\b(?:self|this)\.)?\b([A-Za-z_$][\w$]*)\s*\(/g)].map((item) => item[1]))];
    const resolved = [
      ...new Set(
        called
          .map((callee) => (component.qualified && code.unique(relative, `${component.qualified}.${callee}`)?.id) || code.unique(relative, callee)?.id)
          .filter(Boolean),
      ),
    ];
    return resolved.length === 1 ? resolved[0] : null;
  };
  for (const entry of uiPatterns) {
    const extensions = new Set(entry["확장자"].map((item) => item.toLowerCase()));
    const marker = entry["파일 표시"] ? new RegExp(entry["파일 표시"], "m") : null;
    for (const relative of files) {
      if (!extensions.has(path.posix.extname(relative).toLowerCase())) continue;
      const text = textOf(relative);
      if (text === null) continue;
      const blank = masked(relative, text);
      if (marker && !marker.test(blank)) continue;
      const stem = relative.replace(/\.[^./]+$/, "");
      if (entry["메서드"] !== undefined) {
        const analysis = code.analyses.get(relative);
        if (!analysis) continue;
        const expression = new RegExp(entry["메서드"]);
        for (const symbol of analysis.symbols) {
          const owner = symbol.kind === "function" && analysis.symbols.find((item) => item.kind === "class" && item.qualifiedName === symbol.scopePath);
          const match = owner && expression.exec(symbol.name);
          if (!match) continue;
          const event = transformEvent(match.groups?.event ?? symbol.name, entry["이벤트 바꾸기"]);
          wired.add(relative);
          addFunction({
            id: `fe/${stem}/${owner.qualifiedName}@${event}:${symbol.name}`,
            kind: "프론트",
            position: { path: relative, line: symbol.line },
            handler: symbolId(relative, symbol),
            rule: entry,
          });
        }
        continue;
      }
      const expression = new RegExp(entry["모양"], "gmd");
      const user = new Set(entry["유저 조작"] || []),
        notUser = new Set(entry["유저 조작 아님"] || []),
        selfRun = new Set(entry["스스로 도는"] || []),
        known = entry["그 밖의 이벤트"] ? new Set(entry["그 밖의 이벤트"]) : null;
      for (const match of text.matchAll(expression)) {
        const start = match.index || 0;
        if (entry["코드만"] && !inCode(relative, text, start)) continue;
        const groups = match.groups || {};
        const rawEvent = groups.event ?? entry["이벤트 고정"];
        if (!rawEvent) continue;
        const event = transformEvent(rawEvent, entry["이벤트 바꾸기"]);
        const targetStart = match.indices?.groups?.target?.[0] ?? start + match[0].length;
        const target = (entry["대상 읽기"] === "식" ? readExpression(text, targetStart) : (groups.target ?? "")).trim();
        const line = lineOf(text, start);
        const component = componentAt(relative, line);
        const name = handlerNameOf(target);
        const handler = resolve(relative, component, name, target);
        wired.add(relative);
        const role = selfRun.has(event) ? "effect" : (user.has("*") && !notUser.has(event)) || user.has(event) ? "user" : "other";
        // An entry that lists its other known events treats any other name as
        // not a wiring at all ("state.online = true" is not an event).
        if (role === "other" && known && !known.has(event)) continue;
        if (role === "other") {
          notTaken.push({
            path: relative,
            line,
            pattern: entry.이름,
            component: component.name,
            emitter: groups.emitter || null,
            event,
            target: target.replace(/\s+/g, " ").slice(0, 120),
          });
          if (handler) callbacks.push({ from: enclosingCode(code, relative, line) || relative, to: handler, file: relative, line });
          continue;
        }
        let shown = name;
        if (!shown)
          for (const source of entry["요소 이름"] || []) {
            shown =
              source === "보내는 쪽"
                ? emitterName(groups.emitter)
                : source === "같은 태그 id"
                  ? tagId(text, targetStart)
                  : source === "줄 앞 대입"
                    ? assignedName(text, start)
                    : null;
            if (shown) break;
          }
        shown ||= nextUnnamed(`${relative}\0${component.name}`);
        addFunction({
          id: `fe/${stem}/${component.name}@${role === "effect" ? "effect" : event}:${shown}`,
          kind: "프론트",
          position: { path: relative, line },
          handler,
          handlerReason: name ? `${name}의 정의를 찾지 못함` : "대상이 이름이 아닌 식이고, 그 안에서 처리 코드를 하나로 정하지 못함",
          rule: entry,
        });
      }
    }
  }
  return { notTaken, callbacks, wired, textOf, masked, untrustedMask: [...untrustedMask].sort() };
}

// Finds 기능 (entry points) and links each to the code that receives it.
export function extractProductGraphCode({ sourceRoot, projectRules = null, cache = null }) {
  const previous = readLog;
  const previousRaw = rawReadLog,
    previousCache = parseCache;
  readLog = new Map();
  rawReadLog = new Map();
  parseCache = cache;
  try {
    const result = extractWithReadLog({ sourceRoot, projectRules });
    return { ...result, readFiles: readLog, rawReadFiles: rawReadLog };
  } finally {
    readLog = previous;
    rawReadLog = previousRaw;
    parseCache = previousCache;
  }
}

function extractWithReadLog({ sourceRoot, projectRules }) {
  const root = path.resolve(sourceRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail("PRODUCT_GRAPH_SOURCE_ROOT_MISSING");
  const excludes = (projectRules?.source?.["제외"] || []).map((item) => item.replace(/\/$/, ""));
  const skipped = new Map();
  const files = walkSource(root, excludes, skipped);
  const code = buildCodeLayer(root, files, excludes, projectRules?.["내장 이름"] ?? null);
  const { rules, patterns, uiPatterns, uiMarkers, uiFiles } = effectiveEntryRules(projectRules);
  const handling = Object.fromEntries(rules.map((rule) => [rule.종류, rule.처리]));
  const functions = new Map();
  const outOfScope = [];
  const unresolvedHandlers = [];
  const ruleIssues = [];
  const extraCodeNodes = new Map();
  const entryFiles = files.filter((relative) => classifySourcePath(relative, path.posix.extname(relative).toLowerCase()) !== "test");

  const addFunction = ({ id, kind, oneLine, position, handler, handlerReason, rule }) => {
    const ruleHandling = rule?.처리 || handling[kind];
    if (ruleHandling === "범위 밖") {
      outOfScope.push({ id, kind, position });
      return;
    }
    if (!functions.has(id))
      functions.set(id, { id, type: "기능", kind, oneLine: oneLine || "", handling: ruleHandling, positions: [], handlers: [], handlerAt: {} });
    const entry = functions.get(id);
    if (!entry.positions.some((item) => item.path === position.path && item.line === position.line)) entry.positions.push(position);
    if (ruleHandling === "경계로 둔다") return;
    if (handler) {
      if (!entry.handlers.includes(handler)) {
        entry.handlers.push(handler);
        // The wiring site this handler came from, for the 기능→코드 edge.
        entry.handlerAt[handler] = position;
      }
    } else unresolvedHandlers.push({ id, position, reason: handlerReason || "처리 코드를 찾지 못함" });
  };
  const fileNode = (relative, kind = "file") => {
    if (code.analyses.has(relative)) return relative;
    if (!extraCodeNodes.has(relative)) {
      const text = readText(root, relative);
      extraCodeNodes.set(relative, { id: relative, type: "코드", kind, file: relative, lines: [1, text === null ? 1 : text.split("\n").length] });
    }
    return relative;
  };
  const fileSet = new Set(files);

  // hook: Claude Code / Codex hook configuration JSON.
  const manifestHooks = new Set();
  for (const manifest of entryFiles.filter((relative) => /(?:^|\/)\.(?:claude|codex)-plugin\/plugin\.json$/.test(relative))) {
    try {
      const value = JSON.parse(readText(root, manifest) || "null")?.hooks;
      const pluginRoot = path.posix.dirname(path.posix.dirname(manifest));
      for (const item of typeof value === "string" ? [value] : Array.isArray(value) ? value : [])
        if (typeof item === "string") manifestHooks.add(path.posix.normalize(path.posix.join(pluginRoot === "." ? "" : pluginRoot, item)).replace(/^\.\//, ""));
    } catch {}
  }
  const hookFiles = entryFiles.filter(
    (relative) =>
      /(?:^|\/)hooks\/[^/]+\.json$/.test(relative) ||
      /(?:^|\/)\.claude\/settings(?:\.local)?\.json$/.test(relative) ||
      /(?:^|\/)\.codex\/hooks\.json$/.test(relative) ||
      manifestHooks.has(relative),
  );
  for (const relative of hookFiles) {
    const text = readText(root, relative);
    let document;
    try {
      document = JSON.parse(text || "null");
    } catch {
      continue;
    }
    if (!document?.hooks || typeof document.hooks !== "object" || Array.isArray(document.hooks)) continue;
    // Script paths in a hook command are relative to the plugin or project
    // root: the folder above hooks/ for a plugin's hooks/*.json, the folder
    // above .claude/ or .codex/ for a project's settings. Both are two levels up.
    const base = path.posix.dirname(path.posix.dirname(relative));
    for (const [event, groups] of Object.entries(document.hooks).sort(([a], [b]) => compare(a, b))) {
      if (!/^[A-Z][A-Za-z]+$/.test(event) || !Array.isArray(groups)) continue;
      const index = text.indexOf(`"${event}"`);
      const position = { path: relative, line: index >= 0 ? lineOf(text, index) : 1 };
      const commands = groups
        .flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
        .map((hook) => hook?.command)
        .filter((value) => typeof value === "string");
      const handlers = [],
        missingScripts = [];
      for (const command of commands) {
        const script = /(?:\$\{[A-Z_]+\}\/|\$[A-Z_]+\/)?((?:[\w.-]+\/)*[\w.-]+\.(?:mjs|cjs|js|ts|py|sh|ps1))/.exec(command)?.[1];
        const resolved = script ? path.posix.normalize(path.posix.join(base === "." ? "" : base, script)).replace(/^\.\//, "") : null;
        if (resolved && fileSet.has(resolved)) handlers.push(fileNode(resolved));
        else if (resolved) missingScripts.push(resolved);
      }
      const mcpTools = groups
        .flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
        .filter((hook) => hook?.type === "mcp_tool" && typeof hook.tool === "string")
        .map((hook) => hook.tool);
      const reason = mcpTools.length
        ? `mcp_tool hook은 파일이 아니라 MCP tool ${[...new Set(mcpTools)].sort().join(", ")}을 부른다`
        : missingScripts.length
          ? `hook 명령이 가리키는 스크립트 파일이 없음: ${[...new Set(missingScripts)].sort().join(", ")}`
          : "hook 명령에 스크립트 파일이 적혀 있지 않음";
      if (!handlers.length) addFunction({ id: `hook:${event}`, kind: "hook", position, handlerReason: reason });
      for (const handler of handlers) addFunction({ id: `hook:${event}`, kind: "hook", position, handler });
    }
  }

  // command: slash command files and user-invocable skills.
  for (const relative of entryFiles) {
    let name = null;
    if (/(?:^|\/)commands\/[^/]+\.md$/.test(relative) || /(?:^|\/)\.claude\/commands\/.+\.md$/.test(relative)) name = path.posix.basename(relative, ".md");
    else if (/(?:^|\/)skills\/[^/]+\/SKILL\.md$/.test(relative)) {
      const fields = frontmatter(readText(root, relative) || "");
      if (fields["user-invocable"] === "false") continue;
      name = fields.name || path.posix.basename(path.posix.dirname(relative));
    }
    if (name) addFunction({ id: `command:${name}`, kind: "command", position: { path: relative, line: 1 }, handler: fileNode(relative) });
  }

  // cli: package.json bin and pyproject.toml scripts.
  for (const relative of entryFiles.filter((item) => path.posix.basename(item) === "package.json")) {
    let document;
    try {
      document = JSON.parse(readText(root, relative) || "null");
    } catch {
      continue;
    }
    const base = path.posix.dirname(relative);
    const bin = typeof document?.bin === "string" ? { [String(document.name || "").replace(/^@[^/]+\//, "")]: document.bin } : document?.bin;
    if (!bin || typeof bin !== "object") continue;
    const text = readText(root, relative);
    for (const [name, target] of Object.entries(bin).sort(([a], [b]) => compare(a, b))) {
      if (!name || typeof target !== "string") continue;
      const resolved = path.posix.normalize(path.posix.join(base === "." ? "" : base, target)).replace(/^\.\//, "");
      const index = text.indexOf(`"${name}"`);
      addFunction({
        id: `cli:${name}`,
        kind: "cli",
        position: { path: relative, line: index >= 0 ? lineOf(text, index) : 1 },
        handler: fileSet.has(resolved) ? fileNode(resolved) : null,
        handlerReason: "bin이 가리키는 파일이 없음",
      });
    }
  }
  for (const relative of entryFiles.filter((item) => path.posix.basename(item) === "pyproject.toml")) {
    const text = readText(root, relative) || "";
    const base = path.posix.dirname(relative);
    let inScripts = false;
    text.split(/\r?\n/).forEach((line, index) => {
      const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
      if (header) {
        inScripts = ["project.scripts", "project.gui-scripts"].includes(header[1].trim());
        return;
      }
      const entry = inScripts && /^\s*["']?([\w.-]+)["']?\s*=\s*["']([\w.]+)(?::([\w.]+))?["']/.exec(line);
      if (!entry) return;
      const module = entry[2].split(".").join("/");
      const candidates = [`${module}.py`, `${module}/__init__.py`, `src/${module}.py`, `src/${module}/__init__.py`].map((item) =>
        path.posix.normalize(path.posix.join(base === "." ? "" : base, item)),
      );
      const file = candidates.find((item) => code.analyses.has(item));
      const handler = file ? (entry[3] ? code.unique(file, entry[3])?.id || null : file) : null;
      addFunction({
        id: `cli:${entry[1]}`,
        kind: "cli",
        position: { path: relative, line: index + 1 },
        handler,
        handlerReason: file ? `${entry[3]} 함수를 찾지 못함` : `${entry[2]} 모듈 파일을 찾지 못함`,
      });
    });
  }

  // tool / cli by project pattern rules.
  const rowsOf = new Map();
  const partlyResolved = [];
  for (const rule of patterns) {
    for (const relative of rule.파일) {
      if (!fileSet.has(relative)) {
        ruleIssues.push({ 종류: rule.종류, path: relative, reason: "규칙이 가리키는 파일이 없음" });
        continue;
      }
      const text = readText(root, relative) || "";
      const expression = new RegExp(rule.패턴, "gm");
      for (const match of text.matchAll(expression)) {
        const name = match.slice(1).find((value) => typeof value === "string" && value);
        if (!name) continue;
        const line = lineOf(text, match.index || 0);
        const id = `${rule.종류}:${name}`;
        const position = { path: relative, line };
        if (rule["처리 코드"] === "항목") {
          const row = readTableRow(code, relative, text, match.index || 0);
          if (!rowsOf.has(id)) rowsOf.set(id, new Map());
          rowsOf.get(id).set(`${relative}:${row.start}`, position);
          if (row.targets.length) for (const handler of row.targets) addFunction({ id, kind: rule.종류, position, handler, rule });
          else addFunction({ id, kind: rule.종류, position, handlerReason: row.reason, rule });
          if (row.partial) partlyResolved.push({ id, position, reason: `일부만 풀림: ${row.partial}` });
          continue;
        }
        const handler = rule["처리 코드"] === "파일" ? fileNode(relative) : enclosingCode(code, relative, line) || fileNode(relative);
        addFunction({ id, kind: rule.종류, position, handler, rule });
      }
    }
  }

  // 프론트: every UI binding pattern of the table, by one mechanism.
  const ui = extractUiBindings({ root, files: entryFiles, code, uiPatterns, addFunction });
  for (const callback of ui.callbacks) {
    const key = `${callback.from}\0${callback.to}\0callback`;
    if (!code.references.has(key))
      code.references.set(key, { type: "callback", from: callback.from, to: callback.to, source: { path: callback.file, line: callback.line }, count: 0 });
    code.references.get(key).count += 1;
  }
  // Files that look like UI code but no pattern read: a gap, not zero 기능.
  const uiWithoutRule = [];
  const namedUiFiles = new Set(uiFiles);
  for (const relative of entryFiles) {
    if (ui.wired.has(relative)) continue;
    const extension = path.posix.extname(relative).toLowerCase();
    let sign = namedUiFiles.has(relative) ? "호출 방식 표의 화면 파일" : null;
    if (!sign)
      for (const marker of uiMarkers) {
        if (!marker["확장자"].map((item) => item.toLowerCase()).includes(extension)) continue;
        const text = ui.textOf(relative);
        if (text !== null && new RegExp(marker["표시"], "m").test(ui.masked(relative, text))) {
          sign = marker["이름"];
          break;
        }
      }
    if (sign) uiWithoutRule.push({ path: relative, sign });
  }

  const functionNodes = [...functions.values()]
    .map((entry) => ({ ...entry, positions: entry.positions.sort((a, b) => compare(a.path, b.path) || a.line - b.line), handlers: entry.handlers.sort() }))
    .sort((a, b) => compare(a.id, b.id));
  const codeNodes = [...code.nodes, ...extraCodeNodes.values()].sort((a, b) => compare(a.id, b.id));
  assertUniqueIds([...codeNodes, ...functionNodes]);
  return {
    rules: { 기본과프로젝트: rules, 패턴: patterns, "UI 연결 패턴": uiPatterns, "화면 코드 표시": uiMarkers, "화면 파일": uiFiles },
    codeNodes,
    functionNodes,
    references: [...code.references.values()].sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to) || compare(a.type, b.type)),
    referenceSummary: code.referenceSummary,
    // 기능 found in more than one table row: kept with every row's handlers
    // and listed, so a pattern that also matches a mention shows up.
    multiRowFunctions: [...rowsOf.entries()]
      .filter(([, rows]) => rows.size > 1)
      .map(([id, rows]) => ({ id, positions: [...rows.values()].sort((a, b) => compare(a.path, b.path) || a.line - b.line) }))
      .sort((a, b) => compare(a.id, b.id)),
    tableRowRules: patterns.filter((rule) => rule["처리 코드"] === "항목").length,
    partlyResolvedRows: partlyResolved.sort((a, b) => compare(a.id, b.id) || compare(a.position.path, b.position.path) || a.position.line - b.position.line),
    unresolvedHandlers: unresolvedHandlers.sort(
      (a, b) => compare(a.id, b.id) || compare(a.position.path, b.position.path) || a.position.line - b.position.line,
    ),
    untrustedMaskFiles: ui.untrustedMask,
    notTakenBindings: ui.notTaken.sort((a, b) => compare(a.path, b.path) || a.line - b.line || compare(a.pattern, b.pattern)),
    uiWithoutRule: uiWithoutRule.sort((a, b) => compare(a.path, b.path)),
    outOfScope: outOfScope.sort((a, b) => compare(a.id, b.id)),
    ruleIssues,
    notLookedAt: notLookedAt(files, code, skipped),
    unreachedCode: unreachedCode(code, functionNodes, extraCodeNodes),
    scannedFiles: files.length,
    codeFiles: code.analyses.size,
    excludes: [...excludes].sort(),
  };
}

// Files under the source root that were not read as code, kept apart from
// code that was read and left unresolved.
function notLookedAt(files, code, skipped) {
  const byExtension = new Map();
  let testCode = 0,
    unreadable = 0;
  for (const relative of files) {
    const extension = path.posix.extname(relative).toLowerCase() || "(확장자 없음)";
    if (code.analyses.has(relative)) continue;
    if (CODE_LANGUAGES[extension]) {
      if (classifySourcePath(relative, extension) === "test") testCode += 1;
      else unreadable += 1;
      continue;
    }
    byExtension.set(extension, (byExtension.get(extension) || 0) + 1);
  }
  return {
    files: [...byExtension.values()].reduce((sum, count) => sum + count, 0),
    byExtension: [...byExtension.entries()]
      .map(([extension, count]) => ({ extension, count }))
      .sort((a, b) => b.count - a.count || compare(a.extension, b.extension)),
    testCodeFiles: testCode,
    unreadableCodeFiles: unreadable,
    skipped: [...skipped.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || compare(a.reason, b.reason)),
  };
}

// The original asks for the code no 기능's 처리 코드 reaches by following
// reference. Start from every 기능's resolved handler and follow resolved
// call and callback references. A file-level handler (a script, a command
// file) reaches the file and the calls made at its top level; a declaration in
// that file is reached only through a resolved reference. Reaching a class
// reaches its constructor (__init__ / constructor). "Not reached" means no
// resolved path was found, not that the code is dead.
function unreachedCode(code, functionNodes, extraCodeNodes) {
  const edges = new Map();
  for (const reference of code.references.values()) {
    if (!edges.has(reference.from)) edges.set(reference.from, []);
    edges.get(reference.from).push(reference.to);
  }
  const constructors = new Map();
  for (const [relative, analysis] of code.analyses)
    for (const symbol of analysis.symbols)
      if (symbol.kind === "function" && ["__init__", "constructor"].includes(symbol.name)) {
        const owner = analysis.symbols.find((item) => item.kind === "class" && item.qualifiedName === symbol.scopePath);
        if (owner) constructors.set(owner.id, [...(constructors.get(owner.id) || []), symbol.id]);
      }
  const visited = new Set();
  const queue = functionNodes.flatMap((entry) => entry.handlers);
  while (queue.length) {
    const id = queue.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    queue.push(...(edges.get(id) || []), ...(constructors.get(id) || []));
  }
  const files = [];
  for (const [relative, analysis] of code.analyses) {
    const unreached = analysis.symbols.filter((symbol) => !visited.has(symbol.id)).map((symbol) => symbol.id);
    const anyReached = visited.has(relative) || analysis.symbols.some((symbol) => visited.has(symbol.id));
    if (!unreached.length && anyReached) continue;
    files.push({ path: relative, nothingReached: !anyReached, declarations: unreached });
  }
  files.sort((a, b) => b.declarations.length - a.declarations.length || compare(a.path, b.path));
  return {
    declarations: files.reduce((sum, file) => sum + file.declarations.length, 0),
    filesNothingReached: files.filter((file) => file.nothingReached).length,
    filesPartlyReached: files.filter((file) => !file.nothingReached).length,
    files,
    startedFrom: functionNodes.reduce((sum, entry) => sum + entry.handlers.length, 0),
    extraCodeNodes: extraCodeNodes.size,
  };
}

// Two nodes never share an ID: a clash is a defect in ID construction, so the
// build stops with a reason instead of keeping both.
export function assertUniqueIds(nodes) {
  const seen = new Set(),
    clashes = [];
  for (const node of nodes) {
    if (seen.has(node.id)) clashes.push(node.id);
    seen.add(node.id);
  }
  if (clashes.length) fail("PRODUCT_GRAPH_DUPLICATE_NODE_ID", `같은 ID를 가진 노드가 둘 이상이다: ${[...new Set(clashes)].sort().slice(0, 20).join(", ")}`);
}

// The pre-lexer check, used only for a file whose lexer mask is not trusted:
// a match is code when no line comment starts before it on its line and it is
// not inside a string opened earlier on that line.
function startsInCodeOnLine(text, index, python) {
  const prefix = text.slice(text.lastIndexOf("\n", index - 1) + 1, index);
  let quote = null;
  for (let position = 0; position < prefix.length; position += 1) {
    const character = prefix[position];
    if (quote) {
      if (character === "\\") position += 1;
      else if (character === quote) quote = null;
    } else if (character === '"' || character === "'" || (!python && character === "`")) quote = character;
    else if (python ? character === "#" : character === "/" && prefix[position + 1] === "/") return false;
  }
  return quote === null;
}

// T1: the code a table row names. The row is found with the code mask
// (findRow); it is read like a function body: names that resolve to one
// declaration (a function named as a value, calls in inline functions),
// "namespace.member" through an import, and members of literal dynamic
// imports. A Python decorator row's handler is the definition it decorates.
function readTableRow(code, relative, text, index) {
  const analysis = code.analyses.get(relative);
  const python = relative.endsWith(".py");
  // Per file, once: the code mask, its bracket pairs, line starts and the
  // dynamic imports. A file read for several rows reuses them.
  code.rowFiles ??= new Map();
  if (!code.rowFiles.has(relative)) {
    const mask = codeMask(text, python ? "python" : "javascript");
    if (!mask.trusted) mask.fill(1);
    const starts = lineStarts(text);
    code.rowFiles.set(relative, { mask, pairs: bracketPairs(text, mask), starts, dynamic: python ? [] : dynamicImports(text, mask, starts) });
  }
  const { mask, pairs, dynamic } = code.rowFiles.get(relative);
  const row = findRow(text, mask, index, python, pairs);
  const targets = new Map();
  if (row.kind === "decorator") {
    // The decorated definition: the first line after the decorator lines that
    // is neither blank nor another decorator, if the scan has a declaration there.
    const lines = text.slice(row.end + 1).split("\n");
    let offset = 1;
    while (offset <= lines.length && /^\s*(?:@|$)/.test(lines[offset - 1])) offset += 1;
    const line = lineOf(text, index) + offset;
    const decorated = analysis?.symbols.find((symbol) => (symbol.kind === "function" || symbol.kind === "class") && symbol.line === line);
    if (decorated) targets.set(decorated.id, decorated);
    return {
      ...row,
      targets: [...targets.keys()].sort(),
      reason: decorated ? null : "데코레이터가 꾸미는 정의를 스캔이 선언으로 갖고 있지 않음",
      partial: null,
    };
  }
  // In a statement row the registering call itself is not a handler; its
  // arguments are read as before. Element rows are read whole.
  const skip = row.kind === "statement" ? statementCallChain(text, mask, pairs, row.start, row.end, index) : [];
  const { names, members } = rowNames(text, mask, row.start, row.end, skip);
  for (const name of names) {
    const target = code.resolveName(relative, name);
    if (target && target.kind !== "file") targets.set(target.id, target);
  }
  for (const [head, member] of members) {
    const target = code.resolveMember(relative, head, member);
    if (target) targets.set(target.id, target);
  }
  let dynamicReason = null;
  for (const item of dynamic.filter((entry) => entry.index >= row.start && entry.index < row.end)) {
    const outcome = code.resolveDynamic(relative, item);
    if (outcome.targets) for (const target of outcome.targets) targets.set(target.id, target);
    else
      dynamicReason =
        outcome.reason === "dynamic-import"
          ? "항목의 동적 import가 경로를 글자로 쓰지 않았거나 같은 식에서 이름을 꺼내지 않음"
          : outcome.reason === "external-import"
            ? "항목의 동적 import가 제품 밖 모듈을 가리킴"
            : "항목의 동적 import가 가리키는 모듈에서 그 이름의 함수·클래스 선언을 찾지 못함 (상수일 수 있음)";
  }
  return {
    ...row,
    targets: [...targets.keys()].sort(),
    reason: targets.size ? null : dynamicReason || "항목 안에 하나의 선언으로 풀리는 이름이 없음",
    // Some of the row resolved, but a dynamic import in it did not.
    partial: targets.size && dynamicReason ? dynamicReason : null,
  };
}

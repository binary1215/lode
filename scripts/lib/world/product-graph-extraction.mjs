// Code-origin nodes of the product graph (bundle 1): 코드 from the existing
// regex-based source analysis, 기능 from the entry-rule table (the original's
// 호출 방식 표). Same input, same output: the walk is sorted, nothing reads the
// clock, and no absolute path enters the result.
import fs from "node:fs";
import path from "node:path";
import { analyzeSourceFile, classifySourcePath, maskSourceText } from "./source-analysis.mjs";
import { REPOSITORY_SCAN_EXCLUDED_DIRECTORIES } from "./repository-scan.mjs";
import { BUILT_IN_UI_MARKERS, BUILT_IN_UI_PATTERNS } from "./product-graph-ui-patterns.mjs";
import { failCode as fail } from "../core/errors.mjs";

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

export const CODE_PRECISION = Object.freeze({
  method: "정규식 기반 소스 분석(구문 트리가 아님)",
  references:
    "코드→코드 reference는 이름으로 하나로 정해지는 호출만 call로 적는다(같은 파일의 선언, self./this. 메서드, import로 들여온 이름). UI 연결 중 기능으로 삼지 않은 것은 callback으로 적는다. 그 밖의 종류(framework-invoked, render, type reference, re-render, response, enqueue, navigate, http, defines)는 구별하지 못하므로 적지 않는다.",
  javascriptMethods:
    "JavaScript 클래스 메서드는 선언으로 잡히지 않는다(function, class, 함수 바인딩만). 그래서 그 안의 UI 연결은 감싼 클래스나 함수, 없으면 파일 이름을 구성요소로 쓴다.",
  uiBindings:
    "UI 연결은 패턴의 정규식으로만 찾는다. 여러 줄에 걸친 연결, 문자열로 만든 연결, 툴킷이 이름으로 자동으로 잇는 연결은 보지 못한다. 템플릿의 같은 태그 id는 가장 가까운 < 와 > 사이에서 찾으므로 속성 안의 > 에 흔들릴 수 있다. 이벤트 메서드는 이름으로만 찾고 상속은 확인하지 않는다.",
});

function walkSource(sourceRoot, excludes) {
  const files = [];
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
      if (excluded(child) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (EXCLUDED.has(entry.name) || (entry.name.startsWith(".") && !KEPT_HIDDEN_DIRECTORIES.has(entry.name))) continue;
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

function readText(sourceRoot, relative) {
  const file = path.join(sourceRoot, ...relative.split("/"));
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > MAX_READ_BYTES) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file)).replace(/^﻿/, "");
  } catch {
    return null;
  }
}

const symbolId = (file, symbol) => `${file}#${symbol.qualifiedName}${symbol.identityAmbiguous ? `@${symbol.line}` : ""}`;

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

// Builds the 코드 layer: one node per file and per declaration, and call
// references that resolve to exactly one declaration.
function buildCodeLayer(sourceRoot, files, excludes) {
  const codeFiles = files.filter((relative) => {
    const extension = path.posix.extname(relative).toLowerCase();
    return CODE_LANGUAGES[extension] && classifySourcePath(relative, extension) !== "test";
  });
  const fileSet = new Set(codeFiles);
  const analyses = new Map();
  for (const relative of codeFiles) {
    const text = readText(sourceRoot, relative);
    if (text === null) continue;
    const language = CODE_LANGUAGES[path.posix.extname(relative).toLowerCase()];
    const analysis = analyzeSourceFile(text, language, path.posix.basename(relative), { maxSymbols: 10_000 });
    analyses.set(relative, { text, language, lineCount: text.split("\n").length, ...analysis });
  }
  const nodes = [];
  const declarations = new Map();
  for (const [relative, analysis] of analyses) {
    nodes.push({ id: relative, type: "코드", kind: "file", file: relative, lines: [1, analysis.lineCount] });
    const byName = new Map();
    for (const symbol of analysis.symbols) {
      const id = symbolId(relative, symbol);
      nodes.push({ id, type: "코드", kind: symbol.kind, file: relative, lines: [symbol.line, symbol.endLine ?? symbol.line] });
      if (!byName.has(symbol.qualifiedName)) byName.set(symbol.qualifiedName, []);
      byName.get(symbol.qualifiedName).push({ ...symbol, id });
    }
    declarations.set(relative, byName);
  }
  const unique = (relative, qualifiedName) => {
    const found = declarations.get(relative)?.get(qualifiedName) || [];
    return found.length === 1 ? found[0] : null;
  };
  const references = new Map();
  const unresolved = new Map();
  let resolvedCount = 0;
  const addReference = (from, to, kind, file, line) => {
    const key = `${from}\0${to}\0${kind}`;
    if (!references.has(key)) references.set(key, { type: kind, from, to, source: { path: file, line }, count: 0 });
    references.get(key).count += 1;
  };
  for (const [relative, analysis] of analyses) {
    const bindings = new Map(analysis.semanticFacts.bindings.map((binding) => [binding.local, binding]));
    for (const call of analysis.semanticFacts.calls) {
      const caller = call.callerQualifiedName && !call.callerIdentityAmbiguous ? unique(relative, call.callerQualifiedName) : null;
      const from = caller?.id || relative;
      const target = resolveCall(relative, analysis, call, bindings, unique, fileSet);
      if (target) {
        resolvedCount += 1;
        addReference(from, target.id, "call", relative, call.line);
      } else unresolved.set(call.callee, (unresolved.get(call.callee) || 0) + 1);
    }
  }
  return {
    analyses,
    nodes,
    unique,
    references,
    referenceSummary: {
      resolvedCalls: resolvedCount,
      unresolvedCalls: [...unresolved.values()].reduce((sum, count) => sum + count, 0),
      unresolved: [...unresolved.entries()].map(([callee, count]) => ({ callee, count })).sort((a, b) => b.count - a.count || compare(a.callee, b.callee)),
    },
    excludes,
  };
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

function resolveCall(relative, analysis, call, bindings, unique, fileSet) {
  const callee = call.callee;
  const self = analysis.language === "python" ? "self." : "this.";
  if (callee.startsWith(self)) {
    const owner = enclosingClass(analysis, call.callerQualifiedName);
    return owner ? unique(relative, `${owner}.${callee.slice(self.length)}`) : null;
  }
  if (!callee.includes(".")) {
    const local = unique(relative, callee);
    if (local) return local;
    const binding = bindings.get(callee);
    if (binding && !binding.namespace) {
      const module = resolveModule(relative, binding.specifier, analysis.language, fileSet);
      return module ? unique(module, binding.imported === "default" ? callee : binding.imported) : null;
    }
    return null;
  }
  const [head, member] = callee.split(".");
  const binding = bindings.get(head);
  if (binding?.namespace) {
    const module = resolveModule(relative, binding.specifier, analysis.language, fileSet);
    return module ? unique(module, member) : null;
  }
  return null;
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

// Whether a match starts in code: not after a line comment and not inside a
// string opened earlier on the same line. Line-local on purpose: a file-wide
// string scan loses its place in template literals and would hide real code.
function startsInCode(text, index, python) {
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

const NO_NAME_EMITTERS = new Set(["self", "this", "cls"]);
// The emitting object's name: an element id it is looked up by, else the
// last name of the expression; self/this/cls alone have none.
function emitterName(emitter) {
  if (!emitter) return null;
  const id = /(?:getElementById|\$)\(\s*["'`]#?([\w-]+)["'`]\s*\)|querySelector\(\s*["'`]#([\w-]+)["'`]\s*\)/.exec(emitter);
  if (id) return id[1] || id[2];
  if (NO_NAME_EMITTERS.has(emitter)) return null;
  const last = /([A-Za-z_$][\w$]*)\s*$/.exec(emitter.replace(/\([^()]*\)\s*$/, ""));
  return last && !NO_NAME_EMITTERS.has(last[1]) ? last[1] : null;
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
  const maskedOf = new Map();
  const masked = (relative, text) => {
    if (!maskedOf.has(relative)) {
      const language = code.analyses.get(relative)?.language;
      maskedOf.set(relative, language ? maskSourceText(text, language) : text);
    }
    return maskedOf.get(relative);
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
    const holding = analysis.symbols.filter((symbol) => symbol.line <= line && line <= (symbol.endLine ?? symbol.line));
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
        selfRun = new Set(entry["스스로 도는"] || []);
      for (const match of text.matchAll(expression)) {
        const start = match.index || 0;
        if (entry["코드만"] && !startsInCode(text, start, relative.endsWith(".py"))) continue;
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
  return { notTaken, callbacks, wired, textOf, masked };
}

// Finds 기능 (entry points) and links each to the code that receives it.
export function extractProductGraphCode({ sourceRoot, projectRules = null }) {
  const root = path.resolve(sourceRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail("PRODUCT_GRAPH_SOURCE_ROOT_MISSING");
  const excludes = (projectRules?.source?.["제외"] || []).map((item) => item.replace(/\/$/, ""));
  const files = walkSource(root, excludes);
  const code = buildCodeLayer(root, files, excludes);
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
    if (!functions.has(id)) functions.set(id, { id, type: "기능", kind, oneLine: oneLine || "", handling: ruleHandling, positions: [], handlers: [] });
    const entry = functions.get(id);
    if (!entry.positions.some((item) => item.path === position.path && item.line === position.line)) entry.positions.push(position);
    if (ruleHandling === "경계로 둔다") return;
    if (handler) {
      if (!entry.handlers.includes(handler)) entry.handlers.push(handler);
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
    const base = /(?:^|\/)hooks\/[^/]+\.json$/.test(relative)
      ? path.posix.dirname(path.posix.dirname(relative))
      : path.posix.dirname(path.posix.dirname(relative));
    for (const [event, groups] of Object.entries(document.hooks).sort(([a], [b]) => compare(a, b))) {
      if (!/^[A-Z][A-Za-z]+$/.test(event) || !Array.isArray(groups)) continue;
      const index = text.indexOf(`"${event}"`);
      const position = { path: relative, line: index >= 0 ? lineOf(text, index) : 1 };
      const commands = groups
        .flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
        .map((hook) => hook?.command)
        .filter((value) => typeof value === "string");
      const handlers = [];
      for (const command of commands) {
        const script = /(?:\$\{[A-Z_]+\}\/|\$[A-Z_]+\/)?((?:[\w.-]+\/)*[\w.-]+\.(?:mjs|cjs|js|ts|py|sh|ps1))/.exec(command)?.[1];
        const resolved = script ? path.posix.normalize(path.posix.join(base === "." ? "" : base, script)).replace(/^\.\//, "") : null;
        if (resolved && fileSet.has(resolved)) handlers.push(fileNode(resolved));
      }
      const mcpTools = groups
        .flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : []))
        .filter((hook) => hook?.type === "mcp_tool" && typeof hook.tool === "string")
        .map((hook) => hook.tool);
      const reason = mcpTools.length
        ? `mcp_tool hook은 파일이 아니라 MCP tool ${[...new Set(mcpTools)].sort().join(", ")}을 부른다`
        : "hook 명령에서 스크립트 파일을 찾지 못함";
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
        const handler = rule["처리 코드"] === "파일" ? fileNode(relative) : enclosingCode(code, relative, line) || fileNode(relative);
        addFunction({ id: `${rule.종류}:${name}`, kind: rule.종류, position: { path: relative, line }, handler, rule });
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
  return {
    rules: { 기본과프로젝트: rules, 패턴: patterns, "UI 연결 패턴": uiPatterns, "화면 코드 표시": uiMarkers, "화면 파일": uiFiles },
    codeNodes,
    functionNodes,
    references: [...code.references.values()].sort((a, b) => compare(a.from, b.from) || compare(a.to, b.to) || compare(a.type, b.type)),
    referenceSummary: code.referenceSummary,
    unresolvedHandlers: unresolvedHandlers.sort(
      (a, b) => compare(a.id, b.id) || compare(a.position.path, b.position.path) || a.position.line - b.position.line,
    ),
    notTakenBindings: ui.notTaken.sort((a, b) => compare(a.path, b.path) || a.line - b.line || compare(a.pattern, b.pattern)),
    uiWithoutRule: uiWithoutRule.sort((a, b) => compare(a.path, b.path)),
    outOfScope: outOfScope.sort((a, b) => compare(a.id, b.id)),
    ruleIssues,
    scannedFiles: files.length,
    codeFiles: code.analyses.size,
    excludes: [...excludes].sort(),
  };
}

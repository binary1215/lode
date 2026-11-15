// Table rows and dynamic imports for the product graph (T1, approved
// 2026-11-15). Many products register entry points as rows of a table (an
// array of objects, a name -> handler map, a chain of registration calls); a
// pattern rule with "처리 코드": "항목" takes the 처리 코드 its own row names.
// Brackets are counted only where the code mask says code, and the "${" that
// opens a template expression is not a bracket: its closing "}" is template
// text, so counting the "{" would leave every ${...} unclosed.

import { TEMPLATE_EXPRESSION_OPEN } from "./source-code-mask.mjs";

const OPEN = "([{";
const CLOSE = ")]}";
const PAIR = { ")": "(", "]": "[", "}": "{" };
const LITERAL_KEYWORDS = new Set(["return", "yield", "await", "case", "throw", "export", "default"]);

// A character that can pair as a bracket: code, and not a template's "${".
const bracketCode = (mask, index) => Boolean(mask[index]) && mask[index] !== TEMPLATE_EXPRESSION_OPEN;

function previousSignificant(text, mask, index) {
  let position = index - 1;
  while (position >= 0 && (!mask[position] || /\s/.test(text[position]))) position -= 1;
  return position;
}

function wordBefore(text, end) {
  let start = end + 1;
  while (start > 0 && /[\w$]/.test(text[start - 1])) start -= 1;
  return text.slice(start, end + 1);
}

function matchingClose(text, mask, open) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (!bracketCode(mask, index)) continue;
    if (OPEN.includes(text[index])) depth += 1;
    else if (CLOSE.includes(text[index]) && --depth === 0) return index;
  }
  return text.length;
}

// The row that holds index:
//  - inside a list / object / dict literal: the direct element (between
//    top-level commas) of the outermost such literal, not crossing a
//    function, class or block body;
//  - a Python decorator line: the decorated definition (handled by the caller);
//  - otherwise: the statement holding index (a registration call, a call
//    chain continuing on lines that start with ".").
// Partner of every bracket that is code: an opener's matching closer and a
// closer's matching opener, or -1. Computed once per file.
export function bracketPairs(text, mask) {
  const partner = new Int32Array(text.length).fill(-1);
  const stack = [];
  for (let index = 0; index < text.length; index += 1) {
    if (!bracketCode(mask, index)) continue;
    const character = text[index];
    if (OPEN.includes(character)) stack.push(index);
    else if (CLOSE.includes(character)) {
      if (stack.length && text[stack.at(-1)] === PAIR[character]) {
        const open = stack.pop();
        partner[open] = index;
        partner[index] = open;
      }
    }
  }
  return partner;
}

// Start offset of every line (0-based offsets of line 1, 2, ...).
export function lineStarts(text) {
  const starts = [0];
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) starts.push(index + 1);
  return starts;
}

function lineAt(starts, index) {
  let low = 0,
    high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >>> 1;
    if (starts[middle] <= index) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

// The row that holds index:
//  - inside a list / object / dict literal: the direct element (between
//    top-level commas) of the outermost such literal, not crossing a
//    function, class or block body;
//  - a decorator line (the match's line starts with "@"): the decorated
//    definition (resolved by the caller);
//  - otherwise: the statement holding index, started only by brackets opened
//    inside the innermost enclosing body (a registration call, a call chain
//    continuing on lines that start with ".").
export function findRow(text, mask, index, python, pairs = bracketPairs(text, mask)) {
  // Enclosing openers, innermost first: walk back, jumping over closed pairs.
  const openers = [];
  for (let position = index - 1; position >= 0; position -= 1) {
    if (!bracketCode(mask, position)) continue;
    const character = text[position];
    if (CLOSE.includes(character) && pairs[position] >= 0) position = pairs[position];
    else if (OPEN.includes(character) && (pairs[position] < 0 || pairs[position] >= index)) openers.push(position);
  }
  let literal = null;
  const insideBody = [];
  for (const open of openers) {
    const character = text[open];
    if (character === "(") {
      insideBody.push(open);
      continue;
    }
    const before = previousSignificant(text, mask, open);
    const previous = before < 0 ? "" : mask[before] === TEMPLATE_EXPRESSION_OPEN ? "(" : text[before];
    if (character === "[") {
      insideBody.push(open);
      if (/[\w$)\]]/.test(previous) && !LITERAL_KEYWORDS.has(wordBefore(text, before))) continue; // index access
      literal = open;
      continue;
    }
    // "{": a Python brace is always a literal; in JavaScript a brace after an
    // operator or at the start of an element is an object, anything else a body.
    if (python || previous === "" || "(,=:[?".includes(previous) || LITERAL_KEYWORDS.has(wordBefore(text, before))) {
      insideBody.push(open);
      literal = open;
    } else break;
  }
  if (literal !== null) {
    const close = pairs[literal] >= 0 ? pairs[literal] : text.length;
    let start = literal + 1,
      depth = 0;
    for (let position = literal + 1; position < close; position += 1) {
      if (!bracketCode(mask, position)) continue;
      const character = text[position];
      if (OPEN.includes(character)) depth += 1;
      else if (CLOSE.includes(character)) depth -= 1;
      else if (character === "," && depth === 0) {
        if (position > index) return { kind: "element", start, end: position };
        start = position + 1;
      }
    }
    return { kind: "element", start, end: close };
  }
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const lineEnd = text.indexOf("\n", index) < 0 ? text.length : text.indexOf("\n", index);
  if (/^\s*@/.test(text.slice(lineStart, lineEnd))) return { kind: "decorator", start: lineStart, end: lineEnd };
  // Only brackets opened inside the innermost enclosing body start the statement.
  const outermostParen = insideBody.filter((open) => text[open] === "(").at(-1);
  // The body the walk stopped at bounds the statement's start.
  const body = openers.find((open) => !insideBody.includes(open));
  const bound = body === undefined ? 0 : body + 1;
  let start = Math.max(bound, outermostParen === undefined ? lineStart : text.lastIndexOf("\n", outermostParen - 1) + 1);
  let depth = 0;
  // A ";", a line end or an unmatched closer before index ends an earlier
  // statement: the row starts after it.
  const boundary = (position) => {
    if (position < index) {
      start = position + 1;
      return null;
    }
    return { kind: "statement", start, end: position };
  };
  for (let position = outermostParen ?? start; position < text.length; position += 1) {
    if (!bracketCode(mask, position)) continue;
    const character = text[position];
    let ended = null;
    if (OPEN.includes(character)) depth += 1;
    else if (CLOSE.includes(character)) {
      if (depth === 0) ended = boundary(position);
      else depth -= 1;
    } else if (depth === 0 && character === ";") ended = boundary(position);
    else if (depth === 0 && character === "\n" && !/^\s*\./.test(text.slice(position + 1, position + 200))) ended = boundary(position);
    if (ended) return ended;
  }
  return { kind: "statement", start, end: text.length };
}

const IDENTIFIER = /[A-Za-z_$][\w$]*/y;

// Dynamic imports in JavaScript text, in order: each with its line, its
// specifier when written as a literal, and the member(s) the same
// expression takes from it. Forms read:
//   import("<path>").then((m) => m.<name>)      (also "m => m.<name>")
//   (await import("<path>")).<name>
//   const { <name>, <name>: <alias> } = await import("<path>")
export function dynamicImports(text, mask, starts = lineStarts(text)) {
  const found = [];
  for (const match of text.matchAll(/\bimport\s*\(/g)) {
    const at = match.index;
    if (!mask[at] || (at > 0 && text[at - 1] === ".")) continue;
    let position = at + match[0].length;
    while (/\s/.test(text[position] || "")) position += 1;
    let specifier = null;
    const quote = text[position];
    if (quote === '"' || quote === "'" || quote === "`") {
      const end = text.indexOf(quote, position + 1);
      const literal = end > 0 ? text.slice(position + 1, end) : "";
      if (end > 0 && !(quote === "`" && literal.includes("${"))) {
        let after = end + 1;
        while (/\s/.test(text[after] || "")) after += 1;
        if (text[after] === ")") {
          specifier = literal;
          position = after + 1;
        }
      }
    }
    const line = lineAt(starts, at);
    const members = [];
    if (specifier !== null) {
      const rest = text.slice(position, position + 300);
      const then = /^\s*\.then\(\s*\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*\(?\s*\1\.([A-Za-z_$][\w$]*)/.exec(rest);
      const thenDestructured = /^\s*\.then\(\s*\(\s*\{([^{}]*)\}\s*\)\s*=>/.exec(rest);
      const awaited = /\(\s*await\s*$/.test(text.slice(Math.max(0, at - 40), at)) && /^\s*\)\s*\.([A-Za-z_$][\w$]*)/.exec(rest);
      const destructured = /(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*await\s*$/.exec(text.slice(Math.max(0, at - 300), at));
      const list = (thenDestructured || destructured)?.[1];
      if (then) members.push(then[2]);
      else if (awaited) members.push(awaited[1]);
      else if (list)
        for (const part of list.split(",")) {
          IDENTIFIER.lastIndex = 0;
          const name = IDENTIFIER.exec(part.trim())?.[0];
          if (name) members.push(name);
        }
    }
    found.push({ index: at, line, specifier, members });
  }
  return found;
}

const NOT_NAMES = new Set([
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "def",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "false",
  "False",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "is",
  "lambda",
  "let",
  "new",
  "None",
  "not",
  "null",
  "of",
  "or",
  "and",
  "return",
  "self",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "True",
  "try",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

// Names in a row that may name code: a plain name that is not an object key
// and not a member after ".", and "namespace.member" pairs.
export function rowNames(text, mask, start, end) {
  let view = "";
  for (let index = start; index < end; index += 1) view += bracketCode(mask, index) ? text[index] : " ";
  const names = new Set(),
    members = [];
  for (const match of view.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?/g)) {
    const after = view.slice(match.index + match[0].length);
    if (!match[2] && /^\s*:(?!:)/.test(after) && !/\?\s*$/.test(view.slice(0, match.index))) continue; // object key
    if (NOT_NAMES.has(match[1])) continue;
    names.add(match[1]);
    if (match[2]) members.push([match[1], match[2]]);
  }
  return { names: [...names], members };
}

// Table rows and dynamic imports for the product graph (T1, approved
// 2026-11-15). Many products register entry points as rows of a table (an
// array of objects, a name -> handler map, a chain of registration calls); a
// pattern rule with "처리 코드": "항목" takes the 처리 코드 its own row names.
// Brackets are counted only where the code mask says code.

const OPEN = "([{";
const CLOSE = ")]}";
const PAIR = { ")": "(", "]": "[", "}": "{" };
const LITERAL_KEYWORDS = new Set(["return", "yield", "await", "case", "throw", "export", "default"]);

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
    if (!mask[index]) continue;
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
export function findRow(text, mask, index, python) {
  const openers = [];
  const closers = [];
  for (let position = index - 1; position >= 0; position -= 1) {
    if (!mask[position]) continue;
    const character = text[position];
    if (CLOSE.includes(character)) closers.push(character);
    else if (OPEN.includes(character)) {
      if (closers.length && PAIR[closers.at(-1)] === character) closers.pop();
      else openers.push(position);
    }
  }
  let literal = null;
  for (const open of openers) {
    const character = text[open];
    if (character === "(") continue;
    const before = previousSignificant(text, mask, open);
    const previous = before < 0 ? "" : text[before];
    if (character === "[") {
      if (/[\w$)\]]/.test(previous) && !LITERAL_KEYWORDS.has(wordBefore(text, before))) continue; // index access
      literal = open;
      continue;
    }
    // "{": a Python brace is always a literal; in JavaScript a brace after an
    // operator or at the start of an element is an object, anything else a body.
    if (python || previous === "" || "(,=:[?".includes(previous) || LITERAL_KEYWORDS.has(wordBefore(text, before))) literal = open;
    else break;
  }
  if (literal !== null) {
    const close = matchingClose(text, mask, literal);
    let start = literal + 1,
      depth = 0;
    for (let position = literal + 1; position < close; position += 1) {
      if (!mask[position]) continue;
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
  if (python && /^\s*@/.test(text.slice(lineStart, index)))
    return { kind: "decorator", start: lineStart, end: text.indexOf("\n", index) < 0 ? text.length : text.indexOf("\n", index) };
  const outermostParen = openers.filter((open) => text[open] === "(").at(-1);
  const start = outermostParen === undefined ? lineStart : text.lastIndexOf("\n", outermostParen - 1) + 1;
  let depth = 0;
  for (let position = start; position < text.length; position += 1) {
    if (!mask[position]) continue;
    const character = text[position];
    if (OPEN.includes(character)) depth += 1;
    else if (CLOSE.includes(character)) depth = Math.max(0, depth - 1);
    else if (depth === 0 && character === ";") return { kind: "statement", start, end: position };
    else if (depth === 0 && character === "\n" && !/^\s*\./.test(text.slice(position + 1, position + 200))) return { kind: "statement", start, end: position };
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
export function dynamicImports(text, mask) {
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
    const line = text.slice(0, at).split("\n").length;
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
  for (let index = start; index < end; index += 1) view += mask[index] ? text[index] : " ";
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

import { codeMask, TEMPLATE_EXPRESSION_OPEN } from "./source-code-mask.mjs";

export const SOURCE_ANALYSIS_VERSION = "0.3.4";

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function analysisContext(text, language) {
  const indexes = new Map();
  return {
    text,
    language,
    masked: null,
    readConfidence: null,
    declarations: null,
    methodSites: null,
    withCallIndexes: false,
    lineAt(value, index) {
      let offsets = indexes.get(value);
      if (!offsets) {
        offsets = [];
        for (let position = value.indexOf("\n"); position >= 0; position = value.indexOf("\n", position + 1)) offsets.push(position);
        indexes.set(value, offsets);
      }
      let low = 0,
        high = offsets.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (offsets[middle] < index) low = middle + 1;
        else high = middle;
      }
      return low + 1;
    },
  };
}

export function languageForSource(extension, base) {
  if (base === "Dockerfile") return "dockerfile";
  const languages = {
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".mts": "typescript",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".cs": "csharp",
    ".rb": "ruby",
    ".php": "php",
    ".md": "markdown",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".html": "html",
    ".css": "css",
    ".sql": "sql",
    ".ps1": "powershell",
    ".sh": "shell",
    ".vue": "vue",
    ".svelte": "svelte",
  };
  return languages[extension] || extension.slice(1) || "text";
}

export function classifySourcePath(relative, extension) {
  const segments = relative.toLowerCase().split("/");
  const base = segments.at(-1);
  if (segments.some((item) => item === "test" || item === "tests" || item === "__tests__") || /(?:^|[._-])(test|spec)\./.test(base)) return "test";
  if (extension === ".md" || segments.includes("docs")) return "documentation";
  if ([".json", ".yaml", ".yml", ".toml"].includes(extension) || base.startsWith(".")) return "configuration";
  return "source";
}

function normalizedSignature(value) {
  return Array.from(
    String(value || "")
      .replace(/\s+/g, " ")
      .trim(),
  )
    .slice(0, 500)
    .join("");
}

// Comments and string contents become spaces; line breaks and offsets stay.
// JavaScript and TypeScript are read with the shared lexer (source-code-mask),
// which follows template literals with nested ${...}, regular-expression
// literals and comments. A template's ${ and its closing } are masked too, so
// braces in the masked text stay balanced; the expression inside is code.
// When the lexer cannot trust its reading (the file ends inside a template,
// block comment or ${...}), a character counts as code if either the lexer or
// the plain quote scan says so: that reading loses least, and the file is
// reported as read with reduced confidence.
function maskNonCode(text, language) {
  return maskedReading(text, language).masked;
}

function maskedReading(text, language) {
  if (!["javascript", "typescript"].includes(language)) return { masked: quoteScanMask(text, language), readConfidence: "full" };
  const mask = codeMask(text, "javascript");
  const fallback = mask.trusted ? null : quoteScanMask(text, language);
  // Regex offsets and text[index] use UTF-16 code units, including lone surrogates.
  const output = text.split("");
  for (let index = 0; index < output.length; index += 1) {
    const character = output[index];
    if (character === "\n" || character === "\r") continue;
    const code = (mask[index] && mask[index] !== TEMPLATE_EXPRESSION_OPEN) || (fallback !== null && fallback[index] !== " ");
    if (!code) output[index] = " ";
  }
  return { masked: output.join(""), readConfidence: mask.trusted ? "full" : "reduced" };
}

// The plain quote scan: Python masking, and the fallback for JavaScript text
// the lexer cannot trust. It knows comments and quoted strings only.
function quoteScanMask(text, language) {
  if (!["javascript", "typescript", "python"].includes(language)) return text;
  // Regex offsets and text[index] use UTF-16 code units, including lone surrogates.
  const output = text.split("");
  let mode = "code";
  let quote = "";
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1] || "";
    const triple = text.slice(index, index + 3);
    const preserve = character === "\n" || character === "\r";
    if (mode === "line-comment") {
      if (character === "\n") mode = "code";
      else output[index] = " ";
      continue;
    }
    if (mode === "block-comment") {
      if (character === "*" && next === "/") {
        output[index] = output[index + 1] = " ";
        index += 1;
        mode = "code";
      } else if (!preserve) output[index] = " ";
      continue;
    }
    if (mode === "string") {
      if (!preserve) output[index] = " ";
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) mode = "code";
      continue;
    }
    if (mode === "triple-string") {
      if (triple === quote.repeat(3)) {
        output[index] = output[index + 1] = output[index + 2] = " ";
        index += 2;
        mode = "code";
      } else if (!preserve) output[index] = " ";
      continue;
    }
    if (language === "python" && character === "#") {
      output[index] = " ";
      mode = "line-comment";
    } else if (language !== "python" && character === "/" && next === "/") {
      output[index] = output[index + 1] = " ";
      index += 1;
      mode = "line-comment";
    } else if (language !== "python" && character === "/" && next === "*") {
      output[index] = output[index + 1] = " ";
      index += 1;
      mode = "block-comment";
    } else if (language === "python" && (triple === "'''" || triple === '\"\"\"')) {
      quote = character;
      output[index] = output[index + 1] = output[index + 2] = " ";
      index += 2;
      mode = "triple-string";
    } else if (character === "'" || character === '"' || (language !== "python" && character === "`")) {
      quote = character;
      output[index] = " ";
      mode = "string";
    }
  }
  return output.join("");
}

function lineRecords(text) {
  const records = [];
  let start = 0;
  for (let index = 0; index <= text.length; index += 1)
    if (index === text.length || text[index] === "\n") {
      records.push({ line: records.length + 1, start, end: index, text: text.slice(start, index) });
      start = index + 1;
    }
  return records;
}

function finalizeDeclarations(declarations, maxSymbols) {
  const counts = new Map();
  for (const declaration of declarations) {
    const key = `${declaration.kind}:${declaration.qualifiedName}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return declarations
    .sort((left, right) => left.line - right.line || compareText(left.name, right.name))
    .slice(0, maxSymbols)
    .map(({ startIndex, endIndex, indentation, ...declaration }) => ({
      ...declaration,
      identityAmbiguous: counts.get(`${declaration.kind}:${declaration.qualifiedName}`) > 1,
    }));
}

function attachFirstRanges(finalized, declarations) {
  const ranges = new Map();
  const keyFor = (item) => `${item.line}\0${item.kind}\0${item.qualifiedName}`;
  // finalizeDeclarations sorts in place. Preserve the original first-match
  // policy even for duplicate names on the same line, rather than repairing it
  // silently while removing repeated linear find operations.
  for (const item of declarations) if (!ranges.has(keyFor(item))) ranges.set(keyFor(item), item);
  return finalized.map((item) => {
    const source = ranges.get(keyFor(item));
    return { ...item, startIndex: source.startIndex, endIndex: source.endIndex };
  });
}

function pythonHeaderEnd(masked, startIndex) {
  let depth = 0;
  for (let index = startIndex; index < masked.length; index += 1) {
    const character = masked[index];
    if (character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === ")" || character === "]" || character === "}") depth = Math.max(0, depth - 1);
    else if (character === ":" && depth === 0) return index + 1;
  }
  return -1;
}

function pythonDeclarations(text, masked, maxSymbols, includeRanges = false, context) {
  const maskedLines = lineRecords(masked);
  const declarations = [];
  const scope = [];
  const declarationPattern = /^(\s*)(?:(async)\s+)?(?:(def)\s+([A-Za-z_][\w]*)|(class)\s+([A-Za-z_][\w]*))\b/;
  for (let index = 0; index < maskedLines.length; index += 1) {
    const maskedLine = maskedLines[index].text;
    if (!maskedLine.trim()) continue;
    const indentation = (maskedLine.match(/^\s*/) || [""])[0].replaceAll("\t", "    ").length;
    while (scope.length && indentation <= scope.at(-1).indentation) scope.pop();
    const match = maskedLine.match(declarationPattern);
    if (!match) continue;
    const kind = match[3] ? "function" : "class";
    const name = match[4] || match[6];
    const scopePath = scope.map((item) => item.name).join(".");
    const qualifiedName = scopePath ? `${scopePath}.${name}` : name;
    const startIndex = maskedLines[index].start + (match[1]?.length || 0);
    const headerEndIndex = pythonHeaderEnd(masked, startIndex);
    if (headerEndIndex < 0) continue;
    const headerEndLine = context.lineAt(masked, headerEndIndex - 1);
    let endLine = maskedLines.length;
    let endIndex = masked.length;
    for (let after = headerEndLine; after < maskedLines.length; after += 1) {
      if (!maskedLines[after].text.trim()) continue;
      const afterIndentation = (maskedLines[after].text.match(/^\s*/) || [""])[0].replaceAll("\t", "    ").length;
      if (afterIndentation <= indentation) {
        endLine = Math.max(index + 1, maskedLines[after].line - 1);
        endIndex = maskedLines[after].start;
        break;
      }
    }
    const declaration = {
      name,
      kind,
      line: index + 1,
      endLine,
      scopePath,
      qualifiedName,
      signature: normalizedSignature(text.slice(startIndex, headerEndIndex)),
      startIndex,
      endIndex,
      indentation,
    };
    declarations.push(declaration);
    scope.push(declaration);
    index = headerEndLine - 1;
  }
  const finalized = finalizeDeclarations(declarations, maxSymbols);
  if (includeRanges) return attachFirstRanges(finalized, declarations);
  return finalized;
}

function matchingBrace(masked, openIndex) {
  if (openIndex < 0 || masked[openIndex] !== "{") return -1;
  let depth = 0;
  for (let index = openIndex; index < masked.length; index += 1) {
    if (masked[index] === "{") depth += 1;
    else if (masked[index] === "}" && --depth === 0) return index;
  }
  return -1;
}

// ASCII white space (the masked text turns comments and strings into spaces).
const isBlank = (character) => character === " " || character === "\t" || character === "\n" || character === "\r" || character === "\v" || character === "\f";

// Names that can stand before "(" without being a method name.
const NOT_METHOD_NAMES = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "with",
  "function",
  "return",
  "typeof",
  "new",
  "class",
  "do",
  "else",
  "try",
  "finally",
  "yield",
  "await",
  "delete",
  "void",
  "throw",
  "in",
  "of",
  "instanceof",
  "super",
  "import",
  "export",
  "case",
  "default",
]);
const MEMBER_MODIFIERS = new Set(["static", "async", "get", "set", "public", "private", "protected", "readonly", "override", "abstract"]);

// Partner of every bracket in masked text, by plain counting of ( [ { and
// ) ] } (a closer pairs with the most recent opener of any kind), or -1.
// The same counting as a forward scan for the matching closer.
function bracketPartners(masked) {
  const partner = new Int32Array(masked.length).fill(-1);
  const stack = [];
  for (let index = 0; index < masked.length; index += 1) {
    const character = masked[index];
    if (character === "(" || character === "[" || character === "{") stack.push(index);
    else if ((character === ")" || character === "]" || character === "}") && stack.length) {
      const open = stack.pop();
      partner[open] = index;
      partner[index] = open;
    }
  }
  return partner;
}

// ---------- reading a function's header (0.3.4) ----------
// After a function's name the header is read by bracket partners (counting
// ( [ { together), so a "{" inside the parameter list (a default "= {}", a
// destructured parameter) is never taken as the body.

const skipBlanks = (masked, index) => {
  while (index < masked.length && isBlank(masked[index])) index += 1;
  return index;
};

// "<…>" starting at index (masked[index] === "<"): the index after its ">",
// counting nested "<>" and skipping bracketed groups whole; "=>" is not a
// closer. -1 when it does not close.
function skipAngles(masked, brackets, index) {
  let depth = 0;
  for (; index < masked.length; index += 1) {
    const character = masked[index];
    if (character === "(" || character === "[" || character === "{") {
      if (brackets[index] < 0) return -1;
      index = brackets[index];
    } else if (character === "<") depth += 1;
    else if (character === ">" && masked[index - 1] !== "=") {
      depth -= 1;
      if (depth === 0) return index + 1;
    } else if (character === ";" || character === ")" || character === "]" || character === "}") return -1;
  }
  return -1;
}

// Words that start a statement: met in a return type, they end it (a
// declaration without a body is followed by the next statement).
const STATEMENT_WORDS = new Set([
  "function",
  "class",
  "const",
  "let",
  "var",
  "export",
  "declare",
  "import",
  "interface",
  "type",
  "enum",
  "namespace",
  "module",
  "abstract",
  "async",
  "return",
  "if",
  "for",
  "while",
]);

// A TypeScript return type starting at index (after ":"): the index of the
// body's "{", or -1 when no body follows. Brackets and type arguments are
// skipped whole; a "{" after one of : | & , < ( [ = or "=>" is a type
// literal; ";", a closing bracket, "=" not followed by ">" or the start of a
// statement on a later line end the search. With untilArrow the type ends at
// a top-level "=>", whose index is returned instead (an arrow's return type).
function returnTypeEnd(masked, text, brackets, index, { untilArrow = false } = {}) {
  let newline = false;
  for (; index < masked.length; index += 1) {
    const character = masked[index];
    if (character === "\n") newline = true;
    if (isBlank(character)) continue;
    if (character === "(" || character === "[") {
      if (brackets[index] < 0) return -1;
      index = brackets[index];
    } else if (character === "<") {
      const after = skipAngles(masked, brackets, index);
      if (after < 0) return -1;
      index = after - 1;
    } else if (character === "{") {
      let before = index - 1;
      while (before >= 0 && isBlank(text[before])) before -= 1;
      const previous = text[before];
      const literal = ":|&,<([=".includes(previous) || (previous === ">" && text[before - 1] === "=");
      if (!literal) return untilArrow ? -1 : index;
      if (brackets[index] < 0) return -1;
      index = brackets[index];
    } else if (character === "=") {
      if (masked[index + 1] !== ">") return -1;
      if (untilArrow) return index;
      index += 1;
    } else if (character === ";" || character === ")" || character === "]" || character === "}") return -1;
    else if (/[A-Za-z_$]/.test(character)) {
      let end = index;
      while (end < masked.length && /[\w$]/.test(masked[end])) end += 1;
      if (newline && STATEMENT_WORDS.has(masked.slice(index, end))) return -1;
      newline = false;
      index = end - 1;
    }
  }
  return -1;
}

// The header after a function's name (index just after the name):
// { status: "body", open } | { status: "none" } | { status: "unclosed" }.
function functionHeader(masked, text, brackets, index) {
  index = skipBlanks(masked, index);
  if (masked[index] === "<") {
    index = skipAngles(masked, brackets, index);
    if (index < 0) return { status: "unclosed" };
    index = skipBlanks(masked, index);
  }
  if (masked[index] !== "(" || brackets[index] < 0) return { status: "unclosed" };
  let after = skipBlanks(masked, brackets[index] + 1);
  if (masked[after] === "{") return { status: "body", open: after };
  if (masked[after] === ":") {
    const open = returnTypeEnd(masked, text, brackets, after + 1);
    return open >= 0 ? { status: "body", open } : { status: "none" };
  }
  return { status: "none" };
}

// A binding that may hold a function: "const name" followed by ":" or "=".
const BINDING_START = /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)(?=\s*[:=](?![=>]))/g;

// The value of a binding (index just after its name): a function expression
// ({ kind: "function", header }), an arrow ({ kind: "arrow", arrowEnd } just
// after "=>"), { kind: "unclosed" } when its parameter list does not close, or
// { kind: "other" }. Reads "[: Type] = [async] [<T>] (params) [: R] =>",
// "= [async] param =>" and "= [async] function [*] [inner] (…)".
function bindingValue(masked, text, brackets, index) {
  index = skipBlanks(masked, index);
  if (masked[index] === ":") {
    // A type annotation runs to the "=" that is not part of "=>".
    for (index += 1; index < masked.length; index += 1) {
      const character = masked[index];
      if (character === "(" || character === "[" || character === "{") {
        if (brackets[index] < 0) return { kind: "other" };
        index = brackets[index];
      } else if (character === "<") {
        const after = skipAngles(masked, brackets, index);
        if (after < 0) return { kind: "other" };
        index = after - 1;
      } else if (character === "=" && masked[index + 1] === ">") index += 1;
      else if (character === "=") break;
      else if (character === ";" || character === ")" || character === "]" || character === "}") return { kind: "other" };
    }
  }
  if (masked[index] !== "=" || masked[index + 1] === "=" || masked[index + 1] === ">") return { kind: "other" };
  index = skipBlanks(masked, index + 1);
  const word = (at) => /^[A-Za-z_$][\w$]*/.exec(masked.slice(at, at + 64))?.[0] || "";
  if (word(index) === "async" && /[\s(<]/.test(masked[index + 5] || "")) index = skipBlanks(masked, index + 5);
  if (word(index) === "function") {
    let after = skipBlanks(masked, index + 8);
    if (masked[after] === "*") after = skipBlanks(masked, after + 1);
    const inner = word(after);
    if (inner) after += inner.length;
    const header = functionHeader(masked, text, brackets, after);
    return header.status === "unclosed" ? { kind: "unclosed" } : { kind: "function", header };
  }
  if (masked[index] === "<") {
    index = skipAngles(masked, brackets, index);
    if (index < 0) return { kind: "other" };
    index = skipBlanks(masked, index);
  }
  if (masked[index] === "(") {
    if (brackets[index] < 0) return { kind: "unclosed" };
    let after = skipBlanks(masked, brackets[index] + 1);
    if (masked[after] === ":") {
      after = returnTypeEnd(masked, text, brackets, after + 1, { untilArrow: true });
      if (after < 0) return { kind: "other" };
    }
    return masked[after] === "=" && masked[after + 1] === ">" ? { kind: "arrow", arrowEnd: after + 2 } : { kind: "other" };
  }
  const parameter = word(index);
  if (parameter) {
    const after = skipBlanks(masked, index + parameter.length);
    if (masked[after] === "=" && masked[after + 1] === ">") return { kind: "arrow", arrowEnd: after + 2 };
  }
  return { kind: "other" };
}

// The bracket partner table of a file, made once per analysis.
function partnersOf(context, masked) {
  return (context.brackets ??= bracketPartners(masked));
}

// Partner of every "{" counting braces only (as matchingBrace does), or -1.
function bracePartners(masked) {
  const partner = new Int32Array(masked.length).fill(-1);
  const stack = [];
  for (let index = 0; index < masked.length; index += 1) {
    if (masked[index] === "{") stack.push(index);
    else if (masked[index] === "}" && stack.length) partner[stack.pop()] = index;
  }
  return partner;
}

// Method definitions in JavaScript / TypeScript text, in a class body or an
// object literal: a name (optionally #private) followed by a parameter list
// and a body ("name(...) {", "name(...): Type {"). Such a site is not a call.
// Everything between ")" and "{" must be code in the original text too (a
// template's blanked text is not), so "`${f()} ${ {a} }`" is not a definition.
// Returns { nameIndex, startIndex, name, open, close } in source order.
// Whether "function" (optionally with "*") stands right before index, across
// blanks only. No fixed window, so it reads the same in any text encoding.
function precededByFunction(masked, index) {
  let cursor = index - 1;
  while (cursor >= 0 && isBlank(masked[cursor])) cursor -= 1;
  if (cursor >= 0 && masked[cursor] === "*") {
    cursor -= 1;
    while (cursor >= 0 && isBlank(masked[cursor])) cursor -= 1;
  }
  const end = cursor + 1;
  while (cursor >= 0 && /[A-Za-z]/.test(masked[cursor])) cursor -= 1;
  return masked.slice(cursor + 1, end) === "function" && !(cursor >= 0 && /[\w$.]/.test(masked[cursor]));
}

export function methodDefinitionSites(masked, text, brackets = bracketPartners(masked)) {
  const sites = [];
  const braces = bracePartners(masked);
  for (const match of masked.matchAll(/(?<![\w$.@#])(#?)([A-Za-z_$][\w$]*)(?:\s*<[^<>()\n]*>)?\s*\(/g)) {
    const startIndex = match.index;
    if (startIndex > 0 && /[\w$.@#]/.test(masked[startIndex - 1])) continue;
    if (!match[1] && NOT_METHOD_NAMES.has(match[2])) continue;
    if (precededByFunction(masked, startIndex)) continue;
    const close = brackets[startIndex + match[0].length - 1];
    if (close < 0) continue;
    let after = close + 1;
    while (isBlank(masked[after])) after += 1;
    if (masked[after] === ":") {
      // A TypeScript return type: "): Type {", read as a function's (0.3.4).
      after = returnTypeEnd(masked, text, brackets, after + 1);
      if (after < 0) continue;
    }
    if (masked[after] !== "{" || masked.slice(close + 1, after) !== text.slice(close + 1, after)) continue;
    const bodyClose = braces[after];
    if (bodyClose < 0) continue;
    sites.push({ nameIndex: startIndex + match[1].length, startIndex, name: match[1] + match[2], open: after, close: bodyClose });
  }
  return sites;
}

// Whether a member starts at index: after its modifiers, only blanks stand
// between it and a "{", ";", "}", "," or a line break.
function startsMember(masked, index) {
  let cursor = memberSignatureStart(masked, index) - 1;
  while (cursor >= 0 && (masked[cursor] === " " || masked[cursor] === "\t")) cursor -= 1;
  return cursor < 0 || "{};,\n\r".includes(masked[cursor]);
}

// TypeScript signatures without a body directly in a class or interface body
// ("abstract render(): void;", "run(): void;", overloads). They are neither
// calls nor declarations. Returns { nameIndex, name, owner } in source order;
// owner is the body's "{".
export function signatureSites(masked, classBodyOpens, brackets = null) {
  const opens = new Set(classBodyOpens);
  for (const match of masked.matchAll(/\binterface\s+[A-Za-z_$][\w$]*[^{;]*\{/g)) opens.add(match.index + match[0].length - 1);
  if (!opens.size) return [];
  brackets ??= bracketPartners(masked);
  const candidates = [];
  for (const match of masked.matchAll(/(?<![\w$.@#])(#?)([A-Za-z_$][\w$]*)\s*\??\s*(?:<[^<>()\n]*>)?\s*\(/g)) {
    if (!match[1] && NOT_METHOD_NAMES.has(match[2])) continue;
    const close = brackets[match.index + match[0].length - 1];
    if (close < 0 || !startsMember(masked, match.index)) continue;
    let after = close + 1;
    while (after < masked.length && (masked[after] === " " || masked[after] === "\t")) after += 1;
    if (masked[after] === ":") while (after < masked.length && !";{}\n\r=".includes(masked[after])) after += 1;
    if (masked[after] === "\n" || masked[after] === "\r") {
      // A line end ends the signature unless the body follows on the next line.
      let next = after;
      while (next < masked.length && isBlank(masked[next])) next += 1;
      if (masked[next] === "{") continue;
    } else if (!(masked[after] === ";" || masked[after] === "}" || masked[after] === ",")) continue;
    candidates.push({ nameIndex: match.index + match[1].length, name: match[1] + match[2] });
  }
  const owners = innermostBraces(
    masked,
    [...new Set(candidates.map((item) => item.nameIndex))].sort((a, b) => a - b),
  );
  return candidates.filter((item) => opens.has(owners.get(item.nameIndex))).map((item) => ({ ...item, owner: owners.get(item.nameIndex) }));
}

// For each index (ascending, unique), the innermost "{" still open before it, or -1.
function innermostBraces(masked, indexes) {
  const result = new Map();
  const stack = [];
  let cursor = 0;
  for (let index = 0; index <= masked.length && cursor < indexes.length; index += 1) {
    while (cursor < indexes.length && indexes[cursor] === index) result.set(indexes[cursor++], stack.length ? stack[stack.length - 1] : -1);
    if (masked[index] === "{") stack.push(index);
    else if (masked[index] === "}") stack.pop();
  }
  return result;
}

// Bracket depth, counting ( [ and {, at each index (ascending, unique).
function bracketDepths(masked, indexes) {
  const result = new Map();
  let depth = 0,
    cursor = 0;
  for (let index = 0; index <= masked.length && cursor < indexes.length; index += 1) {
    while (cursor < indexes.length && indexes[cursor] === index) result.set(indexes[cursor++], depth);
    const character = masked[index];
    if (character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === ")" || character === "]" || character === "}") depth = Math.max(0, depth - 1);
  }
  return result;
}

function memberSignatureStart(masked, startIndex) {
  // Modifiers before the name (static, async, get, set, *, ...) belong to the signature.
  let signatureStart = startIndex;
  for (;;) {
    let cursor = signatureStart;
    while (cursor > 0 && (masked[cursor - 1] === " " || masked[cursor - 1] === "\t")) cursor -= 1;
    if (cursor > 0 && masked[cursor - 1] === "*") {
      signatureStart = cursor - 1;
      continue;
    }
    let wordStart = cursor;
    while (wordStart > 0 && /[A-Za-z]/.test(masked[wordStart - 1])) wordStart -= 1;
    if (wordStart < cursor && MEMBER_MODIFIERS.has(masked.slice(wordStart, cursor)) && !(wordStart > 0 && /[\w$.]/.test(masked[wordStart - 1]))) {
      signatureStart = wordStart;
      continue;
    }
    return signatureStart;
  }
}

// Members that are declarations (item 마): methods of a class body, with the
// qualified name <Class>.<method>, and function-valued members of an object
// literal bound to a module-level name, as <binding>.<member>. Nested object
// literals and literals not bound to a module-level name are left out.
function javascriptMembers(text, masked, declarations, classOpens, sites, context) {
  const literalCandidates = [...masked.matchAll(/\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;{]+)?=\s*\{/g)];
  const depths = bracketDepths(
    masked,
    literalCandidates.map((match) => match.index),
  );
  const literalOpens = new Map();
  for (const match of literalCandidates) if (depths.get(match.index) === 0) literalOpens.set(match.index + match[0].length - 1, match[1]);
  // Key members ("key: (...) =>", "key: function"), looked for only inside
  // those literals.
  const keyMembers = [];
  const keyPattern = /([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g;
  for (const open of literalOpens.keys()) {
    const close = matchingBrace(masked, open);
    keyPattern.lastIndex = open + 1;
    for (let match = keyPattern.exec(masked); match && (close < 0 || match.index < close); match = keyPattern.exec(masked))
      if (!(match.index > 0 && /[\w$.#]/.test(masked[match.index - 1]))) keyMembers.push(match);
  }
  // A class body "{" belongs to the class whose declaration starts last (the
  // innermost one when two resolve to the same "{").
  const classOf = new Map();
  for (const declaration of declarations)
    if (classOpens.has(declaration.startIndex)) {
      const open = classOpens.get(declaration.startIndex);
      if (!classOf.has(open) || classOf.get(open).startIndex < declaration.startIndex) classOf.set(open, declaration);
    }
  // Class fields holding a function ("name = (...) =>", "static name = async
  // function", "#name = x =>"), directly in a class body.
  const fields = [];
  const fieldPattern = /(#?[A-Za-z_$][\w$]*)\s*(?::[^=;{}()]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g;
  for (const open of [...classOf.keys()].sort((a, b) => a - b)) {
    const close = matchingBrace(masked, open);
    fieldPattern.lastIndex = open + 1;
    for (let match = fieldPattern.exec(masked); match && (close < 0 || match.index < close); match = fieldPattern.exec(masked))
      if (!(match.index > 0 && /[\w$.#]/.test(masked[match.index - 1])) && startsMember(masked, match.index)) fields.push(match);
  }
  const owners = innermostBraces(
    masked,
    [...new Set([...sites.map((site) => site.nameIndex), ...keyMembers.map((match) => match.index), ...fields.map((match) => match.index)])].sort(
      (a, b) => a - b,
    ),
  );
  // Class bodies for in-memory readers (withMaskedText): body "{" and class.
  context.classBodies = [...classOf].map(([open, declaration]) => ({ open, qualifiedName: declaration.qualifiedName }));
  const members = [];
  const push = (name, scopePath, startIndex, signatureStart, signatureEnd, endIndex) =>
    members.push({
      name,
      kind: "function",
      line: context.lineAt(masked, startIndex),
      endLine: context.lineAt(masked, Math.max(startIndex, endIndex - 1)),
      scopePath,
      qualifiedName: `${scopePath}.${name}`,
      signature: normalizedSignature(text.slice(signatureStart, signatureEnd)),
      startIndex,
      endIndex,
    });
  for (const site of sites) {
    const owner = owners.get(site.nameIndex);
    const ownerClass = classOf.get(owner);
    const literal = literalOpens.get(owner);
    if (!ownerClass && literal === undefined) continue;
    push(site.name, ownerClass ? ownerClass.qualifiedName : literal, site.startIndex, memberSignatureStart(masked, site.startIndex), site.open, site.close + 1);
  }
  for (const match of keyMembers) {
    const literal = literalOpens.get(owners.get(match.index));
    if (literal === undefined) continue;
    let previous = match.index - 1;
    while (previous >= 0 && isBlank(masked[previous])) previous -= 1;
    if (masked[previous] !== "{" && masked[previous] !== ",") continue;
    const matchEnd = match.index + match[0].length;
    let open = -1;
    if (match[0].endsWith("=>")) {
      let body = matchEnd;
      while (isBlank(masked[body])) body += 1;
      if (masked[body] === "{") open = body;
    } else open = masked.indexOf("{", matchEnd);
    const close = open >= 0 ? matchingBrace(masked, open) : -1;
    let endIndex = close >= 0 ? close + 1 : matchEnd;
    if (close < 0) {
      // An expression body runs to the next "," or closing bracket of the literal.
      let depth = 0;
      for (; endIndex < masked.length; endIndex += 1) {
        const character = masked[endIndex];
        if (character === "(" || character === "[" || character === "{") depth += 1;
        else if (character === ")" || character === "]" || character === "}") {
          if (depth === 0) break;
          depth -= 1;
        } else if (character === "," && depth === 0) break;
      }
    }
    push(match[1], literal, match.index, match.index, close >= 0 ? open : endIndex, endIndex);
  }
  for (const match of fields) {
    const ownerClass = classOf.get(owners.get(match.index));
    if (!ownerClass) continue;
    const matchEnd = match.index + match[0].length;
    let open = -1;
    if (match[0].endsWith("=>")) {
      let body = matchEnd;
      while (isBlank(masked[body])) body += 1;
      if (masked[body] === "{") open = body;
    } else open = masked.indexOf("{", matchEnd);
    const close = open >= 0 ? matchingBrace(masked, open) : -1;
    let endIndex = close >= 0 ? close + 1 : matchEnd;
    if (close < 0) {
      // An expression body runs to a ";", a line end or a closing bracket of
      // the class body; it starts at the first non-blank after "=>".
      while (isBlank(masked[endIndex])) endIndex += 1;
      let depth = 0;
      for (; endIndex < masked.length; endIndex += 1) {
        const character = masked[endIndex];
        if (character === "(" || character === "[" || character === "{") depth += 1;
        else if (character === ")" || character === "]" || character === "}") {
          if (depth === 0) break;
          depth -= 1;
        } else if (depth === 0 && (character === ";" || character === "\n")) break;
      }
    }
    push(match[1], ownerClass.qualifiedName, match.index, memberSignatureStart(masked, match.index), close >= 0 ? open : endIndex, endIndex);
  }
  return members;
}

function javascriptDeclarations(text, masked, maxSymbols, includeRanges = false, context) {
  const patterns = [
    // A generator declaration (function* name) is a function declaration too.
    ["function", /\b(?:export\s+)?(?:async\s+)?function(?:\s*\*\s*|\s+)([A-Za-z_$][\w$]*)/g],
    // "class extends B" is an anonymous class, not a class named "extends".
    ["class", /\b(?:export\s+)?class\s+(?!extends\b)([A-Za-z_$][\w$]*)/g],
    ["binding", /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g],
    // A class expression bound to a name is a class of that name.
    ["class", /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*class\b/g],
    // An anonymous default class is the class "default".
    ["class", /\bexport\s+default\s+(class)\b(?=\s*(?:\{|extends\b))/g, "default"],
  ];
  const declarations = [];
  const brackets = partnersOf(context, masked);
  // Declarations that kept the old reading because their parameter list did not close (2.6).
  context.rangeFallbacks ??= 0;
  // Body "{" of each class declaration, by the declaration's start.
  const classOpens = new Map();
  // The old reading of a binding, by its start: kept for a value that is not
  // an arrow by the new reading (an immediately invoked function stays as it was read).
  const oldBindings = new Map([...masked.matchAll(patterns[2][1])].map((match) => [match.index || 0, match]));
  const seenBindings = new Set();
  for (const [kind, rawExpression, fixedName] of patterns) {
    const expression = kind === "binding" ? BINDING_START : rawExpression;
    for (const rawMatch of masked.matchAll(expression)) {
      const match = rawMatch;
      if (fixedName) match[1] = fixedName;
      const startIndex = match.index || 0;
      let matchEnd = startIndex + match[0].length;
      let boundedOpen = -1;
      let header = null;
      if (kind === "function") header = functionHeader(masked, text, brackets, matchEnd);
      else if (kind === "binding") {
        const value = bindingValue(masked, text, brackets, matchEnd);
        if (value.kind === "function") header = value.header;
        else if (value.kind === "arrow") {
          matchEnd = value.arrowEnd;
          const bodyStart = skipBlanks(masked, matchEnd);
          if (masked[bodyStart] === "{") boundedOpen = bodyStart;
          header = { status: "arrow" };
        } else {
          // Not a function value by the new reading: the old reading, if it had one.
          const old = oldBindings.get(startIndex);
          if (!old) continue;
          if (value.kind === "unclosed") context.rangeFallbacks += 1;
          matchEnd = startIndex + old[0].length;
          if (old[0].includes("=>")) {
            const bodyStart = skipBlanks(masked, matchEnd);
            if (masked[bodyStart] === "{") boundedOpen = bodyStart;
            header = { status: "arrow" };
          }
        }
        if (seenBindings.has(startIndex)) continue;
        seenBindings.add(startIndex);
      }
      const lineEnd = masked.indexOf("\n", matchEnd) < 0 ? masked.length : masked.indexOf("\n", matchEnd);
      if (header?.status === "body") boundedOpen = header.open;
      else if (header?.status === "none") boundedOpen = -1;
      else if (header?.status !== "arrow") {
        // The old reading: a class, or a function whose parameter list did not close.
        if (header?.status === "unclosed") context.rangeFallbacks += 1;
        const openIndex = masked.indexOf("{", matchEnd);
        boundedOpen = openIndex >= 0 && openIndex <= lineEnd + 500 ? openIndex : -1;
      }
      const closeIndex = matchingBrace(masked, boundedOpen);
      if (kind === "class" && closeIndex >= 0) classOpens.set(startIndex, boundedOpen);
      const statementEnd = (() => {
        const semicolon = masked.indexOf(";", matchEnd);
        return semicolon >= 0 && semicolon <= lineEnd ? semicolon + 1 : lineEnd;
      })();
      declarations.push({
        name: match[1],
        kind,
        line: context.lineAt(masked, startIndex),
        endLine: closeIndex >= 0 ? context.lineAt(masked, closeIndex) : context.lineAt(masked, statementEnd),
        scopePath: "",
        qualifiedName: match[1],
        signature: normalizedSignature(text.slice(startIndex, boundedOpen >= 0 ? boundedOpen : statementEnd)),
        startIndex,
        endIndex: closeIndex >= 0 ? closeIndex + 1 : statementEnd,
      });
    }
  }
  declarations.sort((left, right) => left.startIndex - right.startIndex);
  let active = [],
    sameStart = [],
    start = -1;
  for (const declaration of declarations) {
    if (declaration.startIndex !== start) {
      active = active.concat(sameStart).filter((candidate) => candidate.endIndex >= declaration.startIndex);
      sameStart = [];
      start = declaration.startIndex;
    }
    const containers = active.filter((candidate) => candidate.endIndex >= declaration.endIndex);
    declaration.scopePath = containers.map((item) => item.name).join(".");
    declaration.qualifiedName = declaration.scopePath ? `${declaration.scopePath}.${declaration.name}` : declaration.name;
    sameStart.push(declaration);
  }
  // Members get their scope from their class or binding; they are not
  // containers for the declarations above, whose names stay as they were.
  declarations.push(...javascriptMembers(text, masked, declarations, classOpens, methodSites(context, masked), context));
  context.classBodyOpens = [...new Set(classOpens.values())].sort((a, b) => a - b);
  const finalized = finalizeDeclarations(declarations, maxSymbols);
  if (includeRanges) return attachFirstRanges(finalized, declarations);
  return finalized;
}

function markdownDeclarations(text, maxSymbols, context) {
  const declarations = [];
  const scope = [];
  for (const match of text.matchAll(/^(#{1,6})\s+(.+?)\s*$/gm)) {
    const level = match[1].length;
    while (scope.length >= level) scope.pop();
    const name = match[2];
    const scopePath = scope.filter(Boolean).join(" / ");
    declarations.push({
      name,
      kind: "heading",
      line: context.lineAt(text, match.index || 0),
      endLine: context.lineAt(text, match.index || 0),
      scopePath,
      qualifiedName: scopePath ? `${scopePath} / ${name}` : name,
      signature: `${match[1]} ${name}`,
      startIndex: match.index || 0,
      endIndex: (match.index || 0) + match[0].length,
    });
    scope[level - 1] = name;
  }
  return finalizeDeclarations(declarations, maxSymbols);
}

function methodSites(context, masked) {
  return (context.methodSites ??= methodDefinitionSites(masked, context.text, partnersOf(context, masked)));
}

function maskedText(context) {
  if (context.masked === null) Object.assign(context, maskedReading(context.text, context.language));
  return context.masked;
}

function analyzeDeclarations(text, language, maxSymbols, includeRanges = false, context = analysisContext(text, language)) {
  const masked = maskedText(context);
  if (["javascript", "typescript"].includes(language)) return javascriptDeclarations(text, masked, maxSymbols, includeRanges, context);
  if (language === "python") return pythonDeclarations(text, masked, maxSymbols, includeRanges, context);
  if (language === "markdown") return markdownDeclarations(text, maxSymbols, context);
  return [];
}

export function extractSourceSymbols(text, language, { maxSymbols = 200 } = {}) {
  if (!Number.isInteger(maxSymbols) || maxSymbols < 1 || maxSymbols > 10_000)
    throw Object.assign(new Error("maxSymbols is invalid."), { code: "INVALID_SOURCE_SYMBOL_LIMIT" });
  return analyzeDeclarations(text, language, maxSymbols, false);
}

export function extractSourceDependencies(text, language, base) {
  return sourceDependencies(text, language, base, analysisContext(text, language));
}

function sourceDependencies(text, language, base, context) {
  const dependencies = [];
  const seen = new Set();
  const add = (specifier, kind, line = 1) => {
    if (!specifier || seen.has(`${kind}:${specifier}`)) return;
    seen.add(`${kind}:${specifier}`);
    dependencies.push({ specifier, kind, line });
  };
  if (["javascript", "typescript"].includes(language)) {
    for (const match of text.matchAll(/\b(?:from\s+|import\s*\(|require\s*\()\s*["']([^"']+)["']/g))
      add(match[1], "module", context.lineAt(text, match.index || 0));
  } else if (language === "python") {
    for (const match of text.matchAll(/^\s*(?:from|import)\s+([A-Za-z_][\w.]*)/gm)) add(match[1], "module", context.lineAt(text, match.index || 0));
  }
  if (base === "package.json") {
    try {
      const parsed = JSON.parse(text);
      for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        for (const name of Object.keys(parsed[section] || {})) add(name, section, 1);
      }
    } catch {}
  }
  return dependencies.sort((left, right) => compareText(left.kind, right.kind) || compareText(left.specifier, right.specifier));
}

function extractImportBindings(text, language) {
  const bindings = [];
  const add = (local, imported, specifier, namespace = false) => {
    if (local && specifier) bindings.push({ local, imported, specifier, namespace });
  };
  if (["javascript", "typescript"].includes(language)) {
    // One import clause, whatever its layout: comments and line breaks are
    // dropped first, so a list spread over lines reads like one on a line.
    const addClause = (rawClause, specifier) => {
      const clause = rawClause
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\/\/[^\n]*/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const namespace = clause.match(/(?:^|,)\s*\*\s*as\s+([A-Za-z_$][\w$]*)$/);
      if (namespace) add(namespace[1], "*", specifier, true);
      const named = clause.match(/\{([^}]+)\}/);
      if (named)
        for (const item of named[1].split(",")) {
          const parts = item.trim().split(/\s+as\s+/);
          if (parts[0]) add(parts[1] || parts[0], parts[0], specifier);
        }
      const defaultBinding = clause.split(",")[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(defaultBinding)) add(defaultBinding, "default", specifier);
    };
    for (const match of text.matchAll(/\bimport\s+([^;\n]+?)\s+from\s+["']([^"']+)["']/g)) addClause(match[1], match[2]);
    // A clause spread over lines (the single-line form above never matches it).
    for (const match of text.matchAll(
      /\bimport\s+((?:type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?(?:\*\s*as\s+[A-Za-z_$][\w$]*|\{[^}]*\}))\s*from\s*["']([^"']+)["']/g,
    ))
      if (match[1].includes("\n")) addClause(match[1], match[2]);
    for (const match of text.matchAll(/\b(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g)) {
      for (const item of match[1].split(",")) {
        const parts = item.trim().split(/\s*:\s*/);
        if (parts[0]) add(parts[1] || parts[0], parts[0], match[2]);
      }
    }
    for (const match of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g))
      add(match[1], "*", match[2], true);
  } else if (language === "python") {
    // "from m import a, b as c", also a parenthesised list over lines and a
    // line continued with a backslash. Comments are dropped.
    for (const match of text.matchAll(/^\s*from\s+([.A-Za-z_][\w.]*)\s+import[ \t]+/gm)) {
      const start = match.index + match[0].length;
      let clause;
      if (text[start] === "(") {
        const close = text.indexOf(")", start);
        clause = text.slice(start + 1, close < 0 ? text.length : close);
      } else {
        let end = start;
        for (;;) {
          const lineEnd = text.indexOf("\n", end) < 0 ? text.length : text.indexOf("\n", end);
          const line = text.slice(end, lineEnd).replace(/#.*/, "");
          if (!/\\\s*$/.test(line) || lineEnd === text.length) {
            end = lineEnd;
            break;
          }
          end = lineEnd + 1;
        }
        clause = text.slice(start, end).replace(/\\\s*\n/g, " ");
      }
      clause = clause.replace(/#[^\n]*/g, " ");
      for (const item of clause.split(",")) {
        const parts = item.trim().split(/\s+as\s+/);
        if (parts[0]) add(parts[1] || parts[0], parts[0], match[1]);
      }
    }
    for (const match of text.matchAll(/^\s*import\s+([A-Za-z_][\w.]*)(?:\s+as\s+([A-Za-z_][\w]*))?/gm))
      add(match[2] || match[1].split(".")[0], "*", match[1], true);
  }
  return bindings.sort(
    (left, right) => compareText(left.local, right.local) || compareText(left.specifier, right.specifier) || compareText(left.imported, right.imported),
  );
}

function callerLookup(declarations) {
  const pending = declarations
    .map((declaration, rank) => ({ ...declaration, rank }))
    .filter((item) => ["function", "binding"].includes(item.kind))
    .sort((a, b) => a.startIndex - b.startIndex || a.rank - b.rank);
  const heap = [];
  const compare = (a, b) => a.endIndex - a.startIndex - (b.endIndex - b.startIndex) || a.rank - b.rank;
  const push = (value) => {
    let index = heap.length;
    heap.push(value);
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (compare(heap[parent], value) <= 0) break;
      heap[index] = heap[parent];
      index = parent;
    }
    heap[index] = value;
  };
  const pop = () => {
    const value = heap.pop();
    if (!heap.length) return;
    let index = 0;
    while (index * 2 + 1 < heap.length) {
      let next = index * 2 + 1;
      if (next + 1 < heap.length && compare(heap[next + 1], heap[next]) < 0) next += 1;
      if (compare(value, heap[next]) <= 0) break;
      heap[index] = heap[next];
      index = next;
    }
    heap[index] = value;
  };
  let cursor = 0;
  return (index) => {
    while (cursor < pending.length && pending[cursor].startIndex < index) push(pending[cursor++]);
    while (heap.length && heap[0].endIndex <= index) pop();
    return heap[0] || null;
  };
}

function extractCalls(text, language, context = analysisContext(text, language)) {
  if (!["javascript", "typescript", "python"].includes(language)) return [];
  const masked = maskedText(context);
  const declarations = (context.declarations ??= analyzeDeclarations(text, language, 10_000, true, context));
  const callerAt = callerLookup(declarations);
  const excluded = new Set(["if", "for", "while", "switch", "catch", "function", "return", "typeof", "new", "class", "def", "with", "assert", "lambda"]);
  // A method definition ("name(...) {" in a class body or object literal) is not a call.
  // Neither is a TypeScript signature without a body in a class or interface.
  const definitions =
    language === "python"
      ? null
      : new Set([
          ...methodSites(context, masked).map((site) => site.nameIndex),
          ...signatureSites(masked, context.classBodyOpens || [], partnersOf(context, masked)).map((site) => site.nameIndex),
        ]);
  const calls = [];
  for (const match of masked.matchAll(/\b([A-Za-z_$][\w$]*(?:\.#?[A-Za-z_$][\w$]*)?)\s*\(/g)) {
    const callee = match[1];
    const prefix = masked.slice(Math.max(0, (match.index || 0) - 24), match.index || 0);
    if (excluded.has(callee) || /\b(?:function\s*\*?|class|def|new)\s*$/.test(prefix)) continue;
    const callIndex = match.index || 0;
    if (definitions?.has(callIndex)) continue;
    const caller = callerAt(callIndex);
    const call = {
      callee,
      line: context.lineAt(masked, callIndex),
      callerQualifiedName: caller?.qualifiedName || null,
      callerIdentityAmbiguous: caller?.identityAmbiguous || false,
    };
    if (context.withCallIndexes) call.index = callIndex;
    calls.push(call);
  }
  return calls.sort((left, right) => left.line - right.line || compareText(left.callee, right.callee));
}

export function extractSemanticSourceFacts(text, language) {
  return {
    bindings: extractImportBindings(text, language),
    calls: extractCalls(text, language),
  };
}

// Internal repository-analysis boundary. No context/cache escapes the exact file.
// withReadConfidence adds readConfidence: "full", or "reduced" when the lexer
// could not trust its reading of the file (see maskNonCode). It is opt-in so
// that records built from this result keep their stored shape. In the same way,
// withCallIndexes adds each call's offset (index) and withMaskedText adds the
// masked text the scans read (maskedText) and the class bodies (classBodies:
// { open, qualifiedName }), for in-memory readers only.
export function analyzeSourceFile(
  text,
  language,
  base,
  { maxSymbols = 200, withReadConfidence = false, withCallIndexes = false, withMaskedText = false } = {},
) {
  if (!Number.isInteger(maxSymbols) || maxSymbols < 1 || maxSymbols > 10_000)
    throw Object.assign(new Error("maxSymbols is invalid."), { code: "INVALID_SOURCE_SYMBOL_LIMIT" });
  const context = analysisContext(text, language);
  context.withCallIndexes = withCallIndexes;
  context.declarations = analyzeDeclarations(text, language, 10_000, true, context);
  const result = {
    symbols: context.declarations.slice(0, maxSymbols).map(({ startIndex, endIndex, ...symbol }) => symbol),
    dependencies: sourceDependencies(text, language, base, context),
    semanticFacts: { bindings: extractImportBindings(text, language), calls: extractCalls(text, language, context) },
  };
  if (withReadConfidence) result.readConfidence = context.readConfidence ?? "full";
  if (withMaskedText) {
    result.maskedText = maskedText(context);
    result.classBodies = context.classBodies || [];
    // The bracket partner table the declaration scan used (JavaScript and
    // TypeScript), so in-memory readers do not build it again, and the
    // declarations that kept the old range reading (0.3.4).
    result.bracketPartners = context.brackets || null;
    result.rangeFallbacks = context.rangeFallbacks || 0;
  }
  return result;
}

// The same comment/string masking the declaration and call scans use, for
// callers that scan one file for their own syntax (offsets are unchanged).
export function maskSourceText(text, language) {
  return maskNonCode(text, language);
}

// Minimal JavaScript scanner for codemods: skips strings, templates, comments
// and regular-expression literals so bracket matching stays exact. It is not a
// parser; callers match normalized text and skip anything they do not recognize.

const REGEX_KEYWORDS = new Set(["return", "typeof", "case", "in", "of", "void", "delete", "throw", "new", "yield", "await", "else", "do", "instanceof"]);

function skipString(src, i) {
  const quote = src[i];
  for (i += 1; i < src.length; i += 1) {
    if (src[i] === "\\") i += 1;
    else if (src[i] === quote) return i + 1;
    else if (src[i] === "\n") break;
  }
  throw new Error(`Unterminated string at ${i}`);
}

function skipTemplate(src, i) {
  for (i += 1; i < src.length;) {
    const c = src[i];
    if (c === "\\") i += 2;
    else if (c === "`") return i + 1;
    else if (c === "$" && src[i + 1] === "{") i = skipCode(src, i + 2, "}");
    else i += 1;
  }
  throw new Error(`Unterminated template at ${i}`);
}

function regexAllowed(src, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j -= 1;
  if (j < 0) return true;
  const p = src[j];
  if (/[(,=:[!&|?{};+\-*%<>~^]/.test(p)) return true;
  if (/[\w$]/.test(p)) {
    let k = j;
    while (k >= 0 && /[\w$]/.test(src[k])) k -= 1;
    return REGEX_KEYWORDS.has(src.slice(k + 1, j + 1));
  }
  return false;
}

function skipRegex(src, i) {
  let inClass = false;
  for (i += 1; i < src.length; i += 1) {
    const c = src[i];
    if (c === "\\") i += 1;
    else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      i += 1;
      while (/[a-z]/.test(src[i] ?? "")) i += 1;
      return i;
    } else if (c === "\n") break;
  }
  throw new Error(`Unterminated regex at ${i}`);
}

// Returns the index just after `closer` (or src.length when closer is null).
export function skipCode(src, i, closer) {
  while (i < src.length) {
    const c = src[i];
    if (c === closer) return i + 1;
    if (c === '"' || c === "'") i = skipString(src, i);
    else if (c === "`") i = skipTemplate(src, i);
    else if (c === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      i = end < 0 ? src.length : end;
    } else if (c === "/" && src[i + 1] === "*") i = src.indexOf("*/", i + 2) + 2;
    else if (c === "/" && regexAllowed(src, i)) i = skipRegex(src, i);
    else if (c === "(") i = skipCode(src, i + 1, ")");
    else if (c === "[") i = skipCode(src, i + 1, "]");
    else if (c === "{") i = skipCode(src, i + 1, "}");
    else if (c === ")" || c === "]" || c === "}") throw new Error(`Unbalanced ${c} at ${i}`);
    else i += 1;
  }
  if (closer === null) return i;
  throw new Error(`Missing ${closer}`);
}

// Splits the text between an opening "(" at `open` and its closer into top-level arguments.
export function callArguments(src, open) {
  const end = skipCode(src, open + 1, ")");
  const args = [];
  let start = open + 1;
  for (let i = open + 1; i < end - 1;) {
    const c = src[i];
    if (c === ",") {
      args.push(src.slice(start, i));
      start = i + 1;
      i += 1;
    } else if (c === '"' || c === "'") i = skipString(src, i);
    else if (c === "`") i = skipTemplate(src, i);
    else if (c === "/" && src[i + 1] === "/") i = src.indexOf("\n", i);
    else if (c === "/" && src[i + 1] === "*") i = src.indexOf("*/", i + 2) + 2;
    else if (c === "/" && regexAllowed(src, i)) i = skipRegex(src, i);
    else if (c === "(") i = skipCode(src, i + 1, ")");
    else if (c === "[") i = skipCode(src, i + 1, "]");
    else if (c === "{") i = skipCode(src, i + 1, "}");
    else i += 1;
  }
  const last = src.slice(start, end - 1);
  if (last.trim() || args.length) args.push(last);
  return { args: args.filter((arg, index) => arg.trim() || index < args.length - 1), end };
}

// Top-level `function NAME(...) {...}` and `const NAME = ...;` definitions.
export function topLevelDefinitions(src) {
  const definitions = [];
  const re = /^(export )?(?:(async )?function (\w+)\s*\(|const (\w+) = )/gm;
  for (let match; (match = re.exec(src));) {
    const start = match.index;
    try {
      let end;
      if (match[3]) {
        const close = skipCode(src, re.lastIndex, ")");
        const brace = src.indexOf("{", close);
        if (src.slice(close, brace).trim()) continue;
        end = skipCode(src, brace + 1, "}");
      } else {
        end = skipCode(src, re.lastIndex, ";");
      }
      if (src[end] === "\n") end += 1;
      definitions.push({
        name: match[3] ?? match[4],
        exported: Boolean(match[1]),
        kind: match[3] ? "function" : "const",
        start,
        end,
        text: src.slice(start, end),
      });
      re.lastIndex = end;
    } catch {
      // Unrecognized shape: leave it alone.
    }
  }
  return definitions;
}

// Whitespace-, trailing-comma- and name-insensitive form of a definition.
export function normalize(text, renames = {}) {
  let out = text.replace(/^export /, "").replace(/\s+/g, " ");
  out = out.replace(/ ?([(){}[\],;:?=>.+|&!]) ?/g, "$1").replace(/,([)\]}])/g, "$1");
  for (const [from, to] of Object.entries(renames)) out = out.replace(new RegExp(`(?<![.\\w$])${from}(?![\\w$:])`, "g"), to);
  return out.replace(/;$/, "");
}

// Marks which offsets are executable code (1) rather than string, template text,
// comment or regex contents (0). Template `${...}` expressions count as code.
export function codeMask(src) {
  const mask = new Uint8Array(src.length);
  const code = (i, closer) => {
    while (i < src.length) {
      const c = src[i];
      if (c === closer) {
        mask[i] = 1;
        return i + 1;
      }
      if (c === '"' || c === "'") i = skipString(src, i);
      else if (c === "`") i = template(i);
      else if (c === "/" && src[i + 1] === "/") {
        const end = src.indexOf("\n", i);
        i = end < 0 ? src.length : end;
      } else if (c === "/" && src[i + 1] === "*") i = src.indexOf("*/", i + 2) + 2;
      else if (c === "/" && regexAllowed(src, i)) i = skipRegex(src, i);
      else {
        mask[i] = 1;
        if (c === "(") i = code(i + 1, ")");
        else if (c === "[") i = code(i + 1, "]");
        else if (c === "{") i = code(i + 1, "}");
        else i += 1;
      }
    }
    return i;
  };
  const template = (i) => {
    for (i += 1; i < src.length;) {
      const c = src[i];
      if (c === "\\") i += 2;
      else if (c === "`") return i + 1;
      else if (c === "$" && src[i + 1] === "{") i = code(i + 2, "}");
      else i += 1;
    }
    return i;
  };
  code(0, null);
  return mask;
}

// Per-file facts the product graph reads for call precision (approved
// 2026-11-15), from the shared scan's masked text (comments and strings are
// spaces, offsets unchanged). Lexical only; nothing here is stored.
//  - scopes: each function's parameters and locals, for "a function held in a
//    parameter or local" (바) and for "v = new C(...)" receivers (마);
//  - values: module-level value bindings (const fail = failWith("X")), for 다;
//  - exports: re-exports and local export lists, for 라.

const isBlank = (character) => character === " " || character === "\t" || character === "\n" || character === "\r" || character === "\v" || character === "\f";
const IDENTIFIER = /[A-Za-z_$][\w$]*/y;

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

// Bracket depth at every index (0 at module level).
function depthArray(masked) {
  const depth = new Int32Array(masked.length + 1);
  let current = 0;
  for (let index = 0; index < masked.length; index += 1) {
    depth[index] = current;
    const character = masked[index];
    if (character === "(" || character === "[" || character === "{") current += 1;
    else if (character === ")" || character === "]" || character === "}") current = Math.max(0, current - 1);
  }
  depth[masked.length] = current;
  return depth;
}

function splitTopLevel(text) {
  const parts = [];
  let depth = 0,
    start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if ("([{".includes(character)) depth += 1;
    else if (")]}".includes(character)) depth -= 1;
    else if (character === "," && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

// Names bound by a destructuring pattern or one parameter.
function patternNames(part) {
  const text = part
    .trim()
    .replace(/^\.\.\./, "")
    .replace(/^\*{1,2}/, "")
    .replace(/^(?:public|private|protected|readonly|override)\s+/, "");
  if (text.startsWith("{") || text.startsWith("[")) {
    const inner = text.slice(1, text.lastIndexOf(text[0] === "{" ? "}" : "]"));
    return splitTopLevel(inner).flatMap((item) => {
      const value = item.includes(":") && text[0] === "{" ? item.slice(item.indexOf(":") + 1) : item;
      return patternNames(value.split("=")[0]);
    });
  }
  IDENTIFIER.lastIndex = 0;
  const name = IDENTIFIER.exec(text)?.[0];
  return name ? [name] : [];
}

const parameterNames = (text) => splitTopLevel(text).flatMap((part) => patternNames(part.split("=")[0]));

// Smallest scope whose range holds index, or null (module level).
export function innermostScope(scopes, index) {
  let best = null;
  for (const scope of scopes) if (scope.start < index && index < scope.end && (!best || scope.end - scope.start < best.end - best.start)) best = scope;
  return best;
}

function addLocal(target, name, entry) {
  if (!target.locals.has(name)) target.locals.set(name, []);
  target.locals.get(name).push(entry);
}

// End of a module-level statement that starts at start: a ";" at depth 0, or
// a line end at depth 0 that is not continued by an operator on either side.
function statementEnd(masked, start, depth) {
  const base = depth[start];
  for (let index = start; index < masked.length; index += 1) {
    if (depth[index] < base) return index;
    if (depth[index] !== base) continue;
    const character = masked[index];
    if (character === ";") return index + 1;
    if (character === "\n") {
      let before = index - 1;
      while (before >= start && isBlank(masked[before])) before -= 1;
      let after = index + 1;
      while (after < masked.length && isBlank(masked[after])) after += 1;
      const continued = "=(,+-*/%?:|&{[<>!".includes(masked[before] || "") || ".?:+-*/%|&,=)]}>".includes(masked[after] || "");
      if (!continued) return index;
    }
  }
  return masked.length;
}

export function javascriptFacts(text, masked, sites) {
  const pairs = bracketPartners(masked);
  const depth = depthArray(masked);
  const scopes = [];
  const scopeWith = (start, end, parameters) => {
    if (end < 0) return;
    scopes.push({ start, end, params: new Set(parameterNames(parameters)), locals: new Map() });
  };
  const bodyAfter = (close) => {
    let after = close + 1;
    while (isBlank(masked[after] || "x")) after += 1;
    if (masked[after] === ":") while (after < masked.length && !"{};=".includes(masked[after])) after += 1;
    return masked[after] === "{" ? pairs[after] : -1;
  };
  for (const match of masked.matchAll(/\bfunction\b\s*\*?\s*(?:[A-Za-z_$][\w$]*)?\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const close = pairs[open];
    if (close >= 0) scopeWith(open, bodyAfter(close), masked.slice(open + 1, close));
  }
  for (const site of sites) {
    const open = masked.indexOf("(", site.nameIndex);
    if (open >= 0 && pairs[open] >= 0) scopeWith(open, site.close, masked.slice(open + 1, pairs[open]));
  }
  for (let arrow = masked.indexOf("=>"); arrow >= 0; arrow = masked.indexOf("=>", arrow + 2)) {
    let before = arrow - 1;
    while (before >= 0 && isBlank(masked[before])) before -= 1;
    let start, parameters;
    if (masked[before] === ")" && pairs[before] >= 0) {
      start = pairs[before];
      parameters = masked.slice(start + 1, before);
    } else if (/[\w$]/.test(masked[before] || "")) {
      start = before;
      while (start > 0 && /[\w$]/.test(masked[start - 1])) start -= 1;
      parameters = masked.slice(start, before + 1);
    } else continue;
    let body = arrow + 2;
    while (isBlank(masked[body] || "x")) body += 1;
    let end;
    if (masked[body] === "{") end = pairs[body];
    else {
      // An expression body runs to a "," or ";" at its depth or an unmatched closer.
      end = body;
      const base = depth[body];
      for (; end < masked.length; end += 1) {
        if (depth[end] < base) break;
        if (depth[end] === base && (masked[end] === "," || masked[end] === ";")) break;
      }
    }
    scopeWith(start, end, parameters);
  }
  const moduleScope = { start: -1, end: masked.length + 1, params: new Set(), locals: new Map() };
  const ownerOf = (index) => innermostScope(scopes, index) || moduleScope;
  // An initializer that loads a module (require(...), await import(...)) makes
  // an import binding of the shared scan, not a variable holding a function.
  const loadsModule = (rest) => /^\s*(?::[^=;]+)?=\s*(?:require\s*\(|await\s+import\s*\()/.test(rest);
  for (const match of masked.matchAll(/\b(const|let|var)\s+(?:([A-Za-z_$][\w$]*)|([{[]))/g)) {
    if (match[2]) {
      const rest = masked.slice(match.index + match[0].length, match.index + match[0].length + 200);
      const created = match[1] === "const" ? /^\s*(?::[^=;]+)?=\s*new\s+([A-Za-z_$][\w$]*)\s*[(<]/.exec(rest) : null;
      // A function expression bound to a name is a declaration of the shared
      // scan (kind binding), not a variable that holds some function.
      const declared = /^\s*(?::[^=;]+)?=\s*(?:async\b\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.test(rest);
      addLocal(ownerOf(match.index), match[2], {
        kind: declared ? "function-binding" : loadsModule(rest) ? "import" : created ? "const-new" : match[1],
        className: created?.[1] ?? null,
        index: match.index,
      });
    } else {
      const open = match.index + match[0].length - 1;
      if (pairs[open] < 0) continue;
      const kind = loadsModule(masked.slice(pairs[open] + 1, pairs[open] + 200)) ? "import" : match[1];
      for (const name of patternNames(masked.slice(open, pairs[open] + 1))) addLocal(ownerOf(match.index), name, { kind, className: null, index: match.index });
    }
  }
  for (const match of masked.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g))
    addLocal(ownerOf(match.index), match[1], { kind: "catch", className: null, index: match.index });
  // Module-level value bindings: "const name = <not a function, not a module>".
  const values = [];
  for (const match of masked.matchAll(/\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=(?!=|>)/g)) {
    if (depth[match.index] !== 0) continue;
    const initializer = masked.slice(match.index + match[0].length, match.index + match[0].length + 200);
    if (/^\s*(?:async\b\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.test(initializer)) continue;
    if (/^\s*(?:require\s*\(|await\s+import\s*\()/.test(initializer)) continue;
    values.push({ name: match[1], startIndex: match.index, endIndex: statementEnd(masked, match.index, depth) });
  }
  // Exports: "export { a, b as c } from", "export * from", and a local list.
  const exports = [];
  const specifierAt = (index) => /^\s*["']([^"']+)["']/.exec(text.slice(index, index + 600))?.[1] ?? null;
  const listItems = (list) =>
    list
      .split(",")
      .map((item) => item.trim().split(/\s+as\s+/))
      .filter((parts) => parts[0])
      .map((parts) => ({ local: parts[0].replace(/^type\s+/, ""), exported: parts[1] || parts[0].replace(/^type\s+/, "") }));
  // The specifier is a string, blanked in the masked text: read it from the
  // original text right after "from".
  for (const match of masked.matchAll(/\bexport\s+(?:type\s*)?\{([^}]*)\}(\s*from\b)?/g)) {
    if (match[2]) {
      const specifier = specifierAt(match.index + match[0].length);
      if (specifier) for (const item of listItems(match[1])) exports.push({ kind: "re-export", imported: item.local, exported: item.exported, specifier });
    } else for (const item of listItems(match[1])) exports.push({ kind: "local", local: item.local, exported: item.exported });
  }
  for (const match of masked.matchAll(/\bexport\s*\*\s*from\b/g)) {
    const specifier = specifierAt(match.index + match[0].length);
    if (specifier) exports.push({ kind: "star", specifier });
  }
  // The default export by name: "export default function run", "export
  // default class Store", "export default run;". An anonymous default class
  // is itself the declaration "default".
  for (const match of masked.matchAll(/\bexport\s+default\s+(?:async\s+)?(?:function\s*\*?\s*|class\s+)?([A-Za-z_$][\w$]*)/g))
    if (!["function", "class", "async", "extends"].includes(match[1])) exports.push({ kind: "local", local: match[1], exported: "default" });
  // "new C(...)" sites: a construction is a reference to C (its constructor).
  const constructions = [];
  for (const match of masked.matchAll(/\bnew\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*[(<]/g))
    constructions.push({ callee: match[1], index: match.index + match[0].indexOf(match[1], 3) });
  return { scopes, moduleScope, values, exports, constructions };
}

// Every name the scanned code can define as a callable member, whether or not
// it is a declaration: a deliberately wide net, so that a method name outside
// it cannot be product code. Names built at run time are not seen.
export function definedMemberNames(text, masked, language, sites = [], signatures = []) {
  const names = new Set();
  const add = (name) => {
    if (!name) return;
    names.add(name);
    names.add(name.replace(/^#/, ""));
  };
  if (language === "python") {
    for (const match of masked.matchAll(/\bdef\s+([A-Za-z_]\w*)/g)) add(match[1]);
    // An assignment (a class attribute, self.x = ..., a lambda) can hold a callable.
    for (const match of masked.matchAll(/(?<!\w)([A-Za-z_]\w*)\s*(?::[^=\n]+)?=(?!=)/g)) add(match[1]);
    for (const match of text.matchAll(/setattr\s*\([^,]+,\s*["']([A-Za-z_]\w*)["']/g)) add(match[1]);
    return names;
  }
  for (const site of sites) add(site.name);
  for (const site of signatures) add(site.name);
  // Members of any object literal ("key: (...) =>", "key: function").
  // (Each pattern starts at a word start: an identifier never starts inside one.)
  for (const match of masked.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g)) add(match[1]);
  // Fields and assignments holding a function ("name = () =>", "x.y = function",
  // "X.prototype.y = (...)").
  for (const match of masked.matchAll(/(?<![\w$#])(#?[A-Za-z_$][\w$]*)\s*(?::[^=;{}()]+)?=\s*(?:async\s*)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)/g))
    add(match[1]);
  // Interface and type members ("run(): void", "run?: () => void").
  for (const match of masked.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)\s*\??\s*:\s*\(/g)) add(match[1]);
  // Quoted and computed names ("'run'() {", "['run']: function", "\"run\": () =>").
  for (const match of text.matchAll(/["'`]([A-Za-z_$][\w$]*)["'`]\s*\]?\s*(?:\(|:\s*(?:async\s*)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>))/g)) add(match[1]);
  // Object.defineProperty(x, "name", ...) and Reflect.defineProperty.
  for (const match of text.matchAll(/defineProperty\s*\([^,]+,\s*["'`]([A-Za-z_$][\w$]*)["'`]/g)) add(match[1]);
  return names;
}

export function pythonFacts(text, masked, symbols, starts) {
  const pairs = bracketPartners(masked);
  const lineEnd = (line) => (line < starts.length ? starts[line] - 1 : masked.length);
  const scopes = [];
  for (const match of masked.matchAll(/^[ \t]*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm)) {
    const open = match.index + match[0].length - 1;
    const close = pairs[open];
    if (close < 0) continue;
    let low = 0,
      high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >>> 1;
      if (starts[middle] <= match.index) low = middle;
      else high = middle - 1;
    }
    const line = low + 1;
    const symbol = symbols.find((item) => item.kind === "function" && item.line === line && item.name === match[1]);
    if (!symbol) continue;
    scopes.push({
      start: open,
      end: lineEnd(symbol.endLine ?? symbol.line),
      params: new Set(parameterNames(masked.slice(open + 1, close))),
      locals: new Map(),
    });
  }
  const moduleScope = { start: -1, end: masked.length + 1, params: new Set(), locals: new Map() };
  const ownerOf = (index) => innermostScope(scopes, index) || moduleScope;
  for (const match of masked.matchAll(/^([ \t]*)([A-Za-z_]\w*)\s*(?::[^=\n]+)?=(?!=)/gm)) {
    const at = match.index + match[1].length;
    // The callee may be dotted ("v = mod.Store()"): the product graph resolves
    // it only through a binding that names a module.
    const created = /^\s*([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*\(/.exec(masked.slice(match.index + match[0].length, match.index + match[0].length + 200));
    addLocal(ownerOf(at), match[2], { kind: created ? "call-assign" : "assign", className: created?.[1].replace(/\s+/g, "") ?? null, index: at });
  }
  // An import statement's alias ("import pkg.mod as pm", "from pkg import
  // mod as m", also inside a function) names the import, not a local of
  // unknown type; "with … as" and "except … as" stay locals.
  const importSpans = [];
  for (const match of masked.matchAll(/^[ \t]*(?:from[ \t]+[\w.]+[ \t]+)?import\b[^\n]*/gm)) {
    let end = match.index + match[0].length;
    const open = match[0].indexOf("(");
    if (open >= 0 && pairs[match.index + open] > 0) end = Math.max(end, pairs[match.index + open] + 1);
    importSpans.push([match.index, end]);
  }
  const inImport = (index) => importSpans.some(([start, end]) => start <= index && index < end);
  for (const match of masked.matchAll(/\b(?:for|as)\s+([A-Za-z_]\w*)\b/g))
    if (!(match[0].startsWith("as") && inImport(match.index)))
      addLocal(ownerOf(match.index), match[1], { kind: "assign", className: null, index: match.index });
  const values = [];
  for (const match of masked.matchAll(/^([A-Za-z_]\w*)\s*(?::[^=\n]+)?=(?!=)/gm)) {
    if (symbols.some((symbol) => symbol.qualifiedName === match[1])) continue;
    // To the next line that starts at column 0 outside brackets.
    let end = match.index;
    let depth = 0;
    for (; end < masked.length; end += 1) {
      const character = masked[end];
      if ("([{".includes(character)) depth += 1;
      else if (")]}".includes(character)) depth = Math.max(0, depth - 1);
      else if (character === "\n" && depth === 0 && end + 1 < masked.length && !isBlank(masked[end + 1])) break;
    }
    values.push({ name: match[1], startIndex: match.index, endIndex: end });
  }
  return { scopes, moduleScope, values, exports: [], constructions: [] };
}

// A name bound at index: a parameter or local of an enclosing function. Returns
// the entries of the innermost function that binds it, or null. A function
// expression bound there is a declaration, so the name is not a held function.
export function bindingAt(facts, index, name) {
  const chain = facts.scopes.filter((scope) => scope.start < index && index < scope.end).sort((a, b) => a.end - a.start - (b.end - b.start));
  for (const scope of chain) {
    if (scope.params.has(name)) return { scope, entries: [{ kind: "parameter" }] };
    if (scope.locals.has(name)) {
      const entries = scope.locals.get(name);
      return entries.some((entry) => entry.kind === "function-binding" || entry.kind === "import") ? null : { scope, entries };
    }
  }
  return null;
}

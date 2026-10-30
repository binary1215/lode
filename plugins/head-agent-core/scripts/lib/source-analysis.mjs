export const SOURCE_ANALYSIS_VERSION = "0.3.1";

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function analysisContext(text, language) {
  const indexes = new Map();
  return { text, language, masked: null, declarations: null,
    lineAt(value, index) {
      let offsets = indexes.get(value);
      if (!offsets) {
        offsets = [];
        for (let position = value.indexOf("\n"); position >= 0; position = value.indexOf("\n", position + 1)) offsets.push(position);
        indexes.set(value, offsets);
      }
      let low = 0, high = offsets.length;
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
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".ts": "typescript",
    ".tsx": "typescript", ".mts": "typescript", ".py": "python", ".go": "go", ".rs": "rust",
    ".java": "java", ".kt": "kotlin", ".kts": "kotlin", ".cs": "csharp", ".rb": "ruby",
    ".php": "php", ".md": "markdown", ".json": "json", ".yaml": "yaml", ".yml": "yaml",
    ".toml": "toml", ".html": "html", ".css": "css", ".sql": "sql", ".ps1": "powershell",
    ".sh": "shell", ".vue": "vue", ".svelte": "svelte",
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
  return Array.from(String(value || "").replace(/\s+/g, " ").trim()).slice(0, 500).join("");
}

function maskNonCode(text, language) {
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
  for (let index = 0; index <= text.length; index += 1) if (index === text.length || text[index] === "\n") {
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
  const keyFor = item => `${item.line}\0${item.kind}\0${item.qualifiedName}`;
  // finalizeDeclarations sorts in place. Preserve the original first-match
  // policy even for duplicate names on the same line, rather than repairing it
  // silently while removing repeated linear find operations.
  for (const item of declarations) if (!ranges.has(keyFor(item))) ranges.set(keyFor(item), item);
  return finalized.map(item => {
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

function javascriptDeclarations(text, masked, maxSymbols, includeRanges = false, context) {
  const patterns = [
    ["function", /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g],
    ["class", /\b(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g],
    ["binding", /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g],
  ];
  const declarations = [];
  for (const [kind, expression] of patterns) for (const match of masked.matchAll(expression)) {
    const startIndex = match.index || 0;
    const matchEnd = startIndex + match[0].length;
    const lineEnd = masked.indexOf("\n", matchEnd) < 0 ? masked.length : masked.indexOf("\n", matchEnd);
    let boundedOpen = -1;
    if (kind === "binding" && match[0].includes("=>")) {
      let bodyStart = matchEnd;
      while (/\s/.test(masked[bodyStart] || "")) bodyStart += 1;
      if (masked[bodyStart] === "{") boundedOpen = bodyStart;
    } else {
      const openIndex = masked.indexOf("{", matchEnd);
      boundedOpen = openIndex >= 0 && openIndex <= lineEnd + 500 ? openIndex : -1;
    }
    const closeIndex = matchingBrace(masked, boundedOpen);
    const statementEnd = (() => {
      const semicolon = masked.indexOf(";", matchEnd);
      return semicolon >= 0 && semicolon <= lineEnd ? semicolon + 1 : lineEnd;
    })();
    declarations.push({
      name: match[1], kind, line: context.lineAt(masked, startIndex), endLine: closeIndex >= 0 ? context.lineAt(masked, closeIndex) : context.lineAt(masked, statementEnd),
      scopePath: "", qualifiedName: match[1],
      signature: normalizedSignature(text.slice(startIndex, boundedOpen >= 0 ? boundedOpen : statementEnd)),
      startIndex, endIndex: closeIndex >= 0 ? closeIndex + 1 : statementEnd,
    });
  }
  declarations.sort((left, right) => left.startIndex - right.startIndex);
  let active = [], sameStart = [], start = -1;
  for (const declaration of declarations) {
    if (declaration.startIndex !== start) {
      active = active.concat(sameStart).filter(candidate => candidate.endIndex >= declaration.startIndex);
      sameStart = []; start = declaration.startIndex;
    }
    const containers = active.filter(candidate => candidate.endIndex >= declaration.endIndex);
    declaration.scopePath = containers.map((item) => item.name).join(".");
    declaration.qualifiedName = declaration.scopePath ? `${declaration.scopePath}.${declaration.name}` : declaration.name;
    sameStart.push(declaration);
  }
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
    declarations.push({ name, kind: "heading", line: context.lineAt(text, match.index || 0), endLine: context.lineAt(text, match.index || 0),
      scopePath, qualifiedName: scopePath ? `${scopePath} / ${name}` : name, signature: `${match[1]} ${name}`,
      startIndex: match.index || 0, endIndex: (match.index || 0) + match[0].length });
    scope[level - 1] = name;
  }
  return finalizeDeclarations(declarations, maxSymbols);
}

function analyzeDeclarations(text, language, maxSymbols, includeRanges = false, context = analysisContext(text, language)) {
  const masked = context.masked ??= maskNonCode(text, language);
  if (["javascript", "typescript"].includes(language)) return javascriptDeclarations(text, masked, maxSymbols, includeRanges, context);
  if (language === "python") return pythonDeclarations(text, masked, maxSymbols, includeRanges, context);
  if (language === "markdown") return markdownDeclarations(text, maxSymbols, context);
  return [];
}

export function extractSourceSymbols(text, language, { maxSymbols = 200 } = {}) {
  if (!Number.isInteger(maxSymbols) || maxSymbols < 1 || maxSymbols > 10_000) throw Object.assign(new Error("maxSymbols is invalid."), { code: "INVALID_SOURCE_SYMBOL_LIMIT" });
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
    for (const match of text.matchAll(/\b(?:from\s+|import\s*\(|require\s*\()\s*["']([^"']+)["']/g)) add(match[1], "module", context.lineAt(text, match.index || 0));
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
    for (const match of text.matchAll(/\bimport\s+([^;\n]+?)\s+from\s+["']([^"']+)["']/g)) {
      const clause = match[1].trim();
      const specifier = match[2];
      const namespace = clause.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (namespace) add(namespace[1], "*", specifier, true);
      const named = clause.match(/\{([^}]+)\}/);
      if (named) for (const item of named[1].split(",")) {
        const parts = item.trim().split(/\s+as\s+/);
        if (parts[0]) add(parts[1] || parts[0], parts[0], specifier);
      }
      const defaultBinding = clause.split(",")[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(defaultBinding)) add(defaultBinding, "default", specifier);
    }
    for (const match of text.matchAll(/\b(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g)) {
      for (const item of match[1].split(",")) {
        const parts = item.trim().split(/\s*:\s*/);
        if (parts[0]) add(parts[1] || parts[0], parts[0], match[2]);
      }
    }
    for (const match of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g)) add(match[1], "*", match[2], true);
  } else if (language === "python") {
    for (const match of text.matchAll(/^\s*from\s+([.A-Za-z_][\w.]*)\s+import\s+([^#\n]+)/gm)) {
      for (const item of match[2].split(",")) {
        const parts = item.trim().split(/\s+as\s+/);
        if (parts[0]) add(parts[1] || parts[0], parts[0], match[1]);
      }
    }
    for (const match of text.matchAll(/^\s*import\s+([A-Za-z_][\w.]*)(?:\s+as\s+([A-Za-z_][\w]*))?/gm)) add(match[2] || match[1].split(".")[0], "*", match[1], true);
  }
  return bindings.sort((left, right) => compareText(left.local, right.local) || compareText(left.specifier, right.specifier) || compareText(left.imported, right.imported));
}

function callerLookup(declarations) {
  const pending = declarations.map((declaration, rank) => ({ ...declaration, rank }))
    .filter(item => ["function", "binding"].includes(item.kind))
    .sort((a, b) => a.startIndex - b.startIndex || a.rank - b.rank);
  const heap = [];
  const compare = (a, b) => (a.endIndex - a.startIndex) - (b.endIndex - b.startIndex) || a.rank - b.rank;
  const push = value => {
    let index = heap.length; heap.push(value);
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (compare(heap[parent], value) <= 0) break;
      heap[index] = heap[parent]; index = parent;
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
      heap[index] = heap[next]; index = next;
    }
    heap[index] = value;
  };
  let cursor = 0;
  return index => {
    while (cursor < pending.length && pending[cursor].startIndex < index) push(pending[cursor++]);
    while (heap.length && heap[0].endIndex <= index) pop();
    return heap[0] || null;
  };
}

function extractCalls(text, language, context = analysisContext(text, language)) {
  if (!["javascript", "typescript", "python"].includes(language)) return [];
  const masked = context.masked ??= maskNonCode(text, language);
  const declarations = context.declarations ??= analyzeDeclarations(text, language, 10_000, true, context);
  const callerAt = callerLookup(declarations);
  const excluded = new Set(["if", "for", "while", "switch", "catch", "function", "return", "typeof", "new", "class", "def", "with", "assert", "lambda"]);
  const calls = [];
  for (const match of masked.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(/g)) {
    const callee = match[1];
    const prefix = masked.slice(Math.max(0, (match.index || 0) - 24), match.index || 0);
    if (excluded.has(callee) || /\b(?:function|class|def|new)\s*$/.test(prefix)) continue;
    const callIndex = match.index || 0;
    const caller = callerAt(callIndex);
    calls.push({ callee, line: context.lineAt(masked, callIndex), callerQualifiedName: caller?.qualifiedName || null,
      callerIdentityAmbiguous: caller?.identityAmbiguous || false });
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
export function analyzeSourceFile(text, language, base, { maxSymbols = 200 } = {}) {
  if (!Number.isInteger(maxSymbols) || maxSymbols < 1 || maxSymbols > 10_000) throw Object.assign(new Error("maxSymbols is invalid."), { code: "INVALID_SOURCE_SYMBOL_LIMIT" });
  const context = analysisContext(text, language);
  context.declarations = analyzeDeclarations(text, language, 10_000, true, context);
  return {
    symbols: context.declarations.slice(0, maxSymbols).map(({ startIndex, endIndex, ...symbol }) => symbol),
    dependencies: sourceDependencies(text, language, base, context),
    semanticFacts: { bindings: extractImportBindings(text, language), calls: extractCalls(text, language, context) },
  };
}

#!/usr/bin/env node
// Stage 3-B codemod: move scripts/lib onto scripts/lib/core helpers.
//
//   node scripts/codemods/core-helpers.mjs [--write]
//
// Every rewrite matches an exact, normalized shape and replaces it with a core
// helper that has the same behavior; anything else is reported and left alone.
// One-shot: it was run once on the stage 3-A tree. Running it again on the result
// would turn the inline sha256() that distribution-lifecycle.mjs keeps for its
// toString()-serialized launcher into a core import and break the launcher
// (test/lib-core-helpers.test.mjs catches it).
import fs from "node:fs";
import path from "node:path";
import { callArguments, codeMask, normalize, skipCode, topLevelDefinitions } from "./js-scan.mjs";

const maskOf = (src) => codeMask(src.replace(/^#!.*\n/, (line) => `${" ".repeat(line.length - 1)}\n`));

// String.replace limited to matches that start in executable code, so source text
// embedded in strings or templates (child-process scripts) is never rewritten.
function replaceInCode(src, re, replacer) {
  const mask = maskOf(src);
  return src.replace(re, (...args) => {
    const offset = args.find((arg, index) => index > 0 && typeof arg === "number");
    return mask[offset] ? replacer(...args) : args[0];
  });
}

const pluginRoot = path.resolve(import.meta.dirname, "../..");
const libRoot = path.join(pluginRoot, "scripts/lib");
const write = process.argv.includes("--write");

export function libFiles() {
  const files = [];
  (function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (file !== path.join(libRoot, "core")) walk(file);
      } else if (entry.name.endsWith(".mjs")) files.push(file);
    }
  })(libRoot);
  return files.sort();
}

// ---- shape catalog -------------------------------------------------------

const shapes = (...texts) => new Set(texts.map((text) => normalize(text)));

const SHA_ONE_SHOT = shapes("const N = (V) => sha256Hex(V);", "function N(V) { return sha256Hex(V); }");
const SHA_JSON = shapes("const N = (V) => H(JSON.stringify(V));", "function N(V) { return H(JSON.stringify(V)); }");
const SHA_CANONICAL = shapes(
  "const N = (V) => H(J(V));",
  "const N = (V) => H(JSON.stringify(C(V)));",
  "function N(V) { return H(JSON.stringify(C(V))); }",
  "function N(V) { return H(J(V)); }",
);

const sortedBody = (sort) => `Object.fromEntries(Object.keys(V).sort(${sort}).map((key) => [key, N(V[key])]))`;
const canonicalShapes = (sort) =>
  shapes(
    `function N(V) { if (Array.isArray(V)) return V.map(N); if (V && typeof V === "object") return ${sortedBody(sort)}; return V; }`,
    `function N(V) { if (Array.isArray(V)) return V.map(N); if (V && typeof V === "object") { return ${sortedBody(sort)}; } return V; }`,
    `function N(V) { return Array.isArray(V) ? V.map(N) : V && typeof V === "object" ? ${sortedBody(sort)} : V; }`,
    `const N = (V) => Array.isArray(V) ? V.map(N) : V && typeof V === "object" ? ${sortedBody(sort)} : V;`,
    `const N = (V) => (Array.isArray(V) ? V.map(N) : V && typeof V === "object" ? ${sortedBody(sort)} : V);`,
    `const N = (V) => V && typeof V === "object" ? (Array.isArray(V) ? V.map(N) : ${sortedBody(sort)}) : V;`,
    `const N = (V) => (V && typeof V === "object" ? (Array.isArray(V) ? V.map(N) : ${sortedBody(sort)}) : V);`,
  );
const CANONICAL_SORTED = canonicalShapes("");
const CANONICAL_COMPARED = canonicalShapes("compareText");
const CANONICAL_JSON = shapes("const N = (V) => JSON.stringify(C(V));", "function N(V) { return JSON.stringify(C(V)); }");
const COMPARE_TEXT = shapes(
  "const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);",
  "const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;",
  "function compareText(left, right) { return left < right ? -1 : left > right ? 1 : 0; }",
);
const ATOMIC_WRITE = shapes(`function N(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), \`.\${path.basename(file)}.\${crypto.randomUUID()}.tmp\`);
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}`);

// fail helpers, parameters renamed positionally to P1/P2 and defaults to D.
const FAIL_MESSAGE_CODE = shapes(
  "const N = (P1, P2) => { throw Object.assign(new Error(P1), { code: P2 }); };",
  "const N = (P1, P2) => { const error = new Error(P1); error.code = P2; throw error; };",
  "function N(P1, P2) { throw Object.assign(new Error(P1), { code: P2 }); }",
  "function N(P1, P2) { const error = new Error(P1); error.code = P2; throw error; }",
);
const FAIL_MESSAGE_DEFAULT_CODE = shapes(
  "const N = (P1, P2 = D) => { throw Object.assign(new Error(P1), { code: P2 }); };",
  "const N = (P1, P2 = D) => { const error = new Error(P1); error.code = P2; throw error; };",
);
const FAIL_CODE_ONLY = shapes("const N = (V) => { throw Object.assign(new Error(V), { code: V }); };");
const FAIL_CODE_MESSAGE_DEFAULT = shapes("const N = (P1, P2 = P1) => { throw Object.assign(new Error(P2), { code: P1 }); };");
const FAIL_CODE_FIRST = shapes(
  "function N(P1, P2) { const error = new Error(P2); error.code = P1; throw error; }",
  "const N = (P1, P2) => { throw Object.assign(new Error(P2), { code: P1 }); };",
);

// ---- helpers ---------------------------------------------------------------

function paramsOf(text) {
  const match = /^(?:export )?(?:async )?(?:function \w+\s*\(|const \w+ = (?:async )?\()([^)]*)\)/.exec(text);
  return match
    ? match[1]
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
    : null;
}

// Shape key of a definition: name -> N, params -> V (single) or P1/P2.
function shapeOf(definition, extra = {}) {
  const params = paramsOf(definition.text) ?? [];
  if (params.some((param) => !/^[\w$]+(\s*=\s*("[A-Z][A-Z0-9_]*"|[\w$]+))?$/.test(param)))
    return { key: normalize(definition.text), params, defaultCode: null };
  const renames = { [definition.name]: "N", ...extra };
  if (params.length === 1 && !params[0].includes("=")) renames[params[0]] = "V";
  let text = definition.text;
  // `{ code }` shorthand is `{ code: code }`.
  text = text.replace(/\{\s*(\w+)\s*\}\)/g, (whole, name) => (params.some((param) => param.split("=")[0].trim() === name) ? `{ code: ${name} })` : whole));
  params.forEach((param, index) => {
    const name = param.split("=")[0].trim();
    if (params.length > 1 || param.includes("=")) renames[name] = `P${index + 1}`;
  });
  let defaultCode = null;
  text = text.replace(/=\s*("[A-Z][A-Z0-9_]*")\s*\)/, (whole, literal) => {
    defaultCode = literal;
    return "= D)";
  });
  return { key: normalize(text, renames), params, defaultCode };
}

function identifierUses(src, name) {
  return [...src.matchAll(new RegExp(`(?<![\\w$.])${name}\\b(?!\\s*:)`, "g"))].length;
}

function importBlockEnd(src) {
  let end = 0;
  const re = /^import\s[\s\S]*?from\s+"[^"]+";\n|^import\s+"[^"]+";\n/gm;
  for (let match; (match = re.exec(src));) {
    if (match.index !== end && src.slice(end, match.index).trim() && !/^(\/\/.*\n|\s)*$/.test(src.slice(end, match.index))) break;
    end = match.index + match[0].length;
  }
  return end;
}

function addImport(src, file, module, specifiers) {
  if (!specifiers.size) return src;
  const relative = path
    .relative(path.dirname(file), path.join(libRoot, "core", module))
    .split(path.sep)
    .join("/");
  const from = relative.startsWith(".") ? relative : `./${relative}`;
  const list = [...specifiers].sort((a, b) => a.localeCompare(b, "en")).join(", ");
  const line = `import { ${list} } from "${from}";\n`;
  const at = importBlockEnd(src.replace(/^#!.*\n/, (shebang) => shebang));
  return src.slice(0, at) + line + src.slice(at);
}

function dropUnusedDefaultImport(src, name, module) {
  const re = new RegExp(`^import ${name} from "${module}";\\n`, "m");
  if (!re.test(src)) return src;
  const rest = src.replace(re, "");
  return identifierUses(rest, name) ? src : rest;
}

function removeDefinition(src, definition) {
  return src.slice(0, definition.start) + src.slice(definition.end).replace(/^\n(?=\n)/, "");
}

// Rewrites createHash("sha256").update(X).digest("hex") (one update, one argument).
function rewriteOneShotHashes(src, report) {
  const re = /(?:crypto\s*\.\s*)?createHash\(\s*["']sha256["']\s*\)\s*\.\s*update\(/g;
  const mask = maskOf(src);
  let out = "",
    last = 0;
  for (let match; (match = re.exec(src));) {
    if (!mask[match.index]) continue;
    if (/[\w$.]$/.test(src.slice(0, match.index)) && !src.slice(match.index).startsWith("crypto")) continue;
    const open = match.index + match[0].length - 1;
    const { args, end } = callArguments(src, open);
    const tail = /^\s*\.\s*digest\(\s*["']hex["']\s*\)/.exec(src.slice(end));
    if (!tail || args.length !== 1) continue;
    out += src.slice(last, match.index) + `sha256Hex(${args[0].trim()})`;
    last = end + tail[0].length;
    re.lastIndex = last;
    report.oneShot += 1;
  }
  return out + src.slice(last);
}

// ---- per-file transform ----------------------------------------------------

export function transform(file, original) {
  const report = { oneShot: 0, hashers: 0, digestHelpers: [], canonical: [], fail: [], atomic: 0, renames: 0, pathChecks: 0, skipped: new Set() };
  const imports = {
    "digest.mjs": new Set(),
    "canonical-json.mjs": new Set(),
    "errors.mjs": new Set(),
    "fs-atomic.mjs": new Set(),
    "path-safety.mjs": new Set(),
  };
  const exportsAfter = [];
  let src = original;

  // Repeats `action` on the first matching top-level definition until none match,
  // so every rewrite sees fresh offsets.
  const eachDefinition = (action) => {
    for (let changed = true; changed;) {
      changed = false;
      for (const definition of topLevelDefinitions(src)) {
        if (action(definition)) {
          changed = true;
          break;
        }
      }
    }
  };
  const useImport = (module, coreName, localName, definition) => {
    imports[module].add(coreName === localName ? coreName : `${coreName} as ${localName}`);
    if (definition.exported) exportsAfter.push(localName);
    src = removeDefinition(src, definition);
  };

  // 1. one-shot hashes, then remaining createHash -> createHasher.
  src = rewriteOneShotHashes(src, report);
  if (report.oneShot) imports["digest.mjs"].add("sha256Hex");
  const toHasher = () => {
    report.hashers += 1;
    return "createHasher(";
  };
  src = replaceInCode(src, /\bcrypto\s*\.\s*createHash\(/g, toHasher);
  src = replaceInCode(src, /(?<![\w$.])createHash\(/g, toHasher);
  if (report.hashers) imports["digest.mjs"].add("createHasher");

  // 2. canonical normalizers (before digest-of-canonical helpers).
  const compareTextDefinition = topLevelDefinitions(src).find((definition) => definition.name === "compareText");
  const plainCompareText = Boolean(compareTextDefinition && COMPARE_TEXT.has(normalize(compareTextDefinition.text)));
  const canonicalAliases = new Map(); // local name -> core name
  eachDefinition((definition) => {
    const { key } = shapeOf(definition);
    if (CANONICAL_SORTED.has(key)) {
      canonicalAliases.set(definition.name, "canonicalValue");
      useImport("canonical-json.mjs", "canonicalValue", definition.name, definition);
    } else if (CANONICAL_COMPARED.has(key) && plainCompareText) {
      canonicalAliases.set(definition.name, "runtimeCanonicalValue");
      useImport("canonical-json.mjs", "runtimeCanonicalValue", definition.name, definition);
    } else {
      if (CANONICAL_COMPARED.has(key)) report.skipped.add(`${definition.name}: compareText is not the code-unit comparator`);
      return false;
    }
    report.canonical.push(definition.name);
    return true;
  });
  const jsonAliases = new Map();
  eachDefinition((definition) => {
    for (const [local, core] of canonicalAliases) {
      if (!CANONICAL_JSON.has(shapeOf(definition, { [local]: "C" }).key)) continue;
      const coreJson = core === "canonicalValue" ? "canonicalJson" : "runtimeCanonicalJson";
      jsonAliases.set(definition.name, coreJson);
      useImport("canonical-json.mjs", coreJson, definition.name, definition);
      report.canonical.push(definition.name);
      return true;
    }
    return false;
  });
  // A code-unit compareText left unused by the move.
  const compareAfter = topLevelDefinitions(src).find((definition) => definition.name === "compareText");
  if (compareAfter && plainCompareText && identifierUses(src, "compareText") === 1) src = removeDefinition(src, compareAfter);

  // 3. digest helpers.
  const sha256Aliases = new Set(["sha256Hex"]);
  eachDefinition((definition) => {
    if (SHA_ONE_SHOT.has(shapeOf(definition).key)) {
      sha256Aliases.add(definition.name);
      useImport("digest.mjs", "sha256Hex", definition.name, definition);
      report.digestHelpers.push(definition.name);
      return true;
    }
    let matched = null;
    for (const hash of sha256Aliases) {
      if (SHA_JSON.has(shapeOf(definition, { [hash]: "H" }).key)) matched = "sha256Json";
      for (const [local, core] of canonicalAliases) {
        if (core === "canonicalValue" && SHA_CANONICAL.has(shapeOf(definition, { [hash]: "H", [local]: "C" }).key)) matched = "sha256CanonicalJson";
      }
      for (const [local, core] of jsonAliases) {
        if (core === "canonicalJson" && SHA_CANONICAL.has(shapeOf(definition, { [hash]: "H", [local]: "J" }).key)) matched = "sha256CanonicalJson";
      }
    }
    if (!matched) return false;
    useImport("digest.mjs", matched, definition.name, definition);
    report.digestHelpers.push(definition.name);
    return true;
  });
  if (imports["digest.mjs"].has("sha256Hex") && identifierUses(src, "sha256Hex") === 0) imports["digest.mjs"].delete("sha256Hex");

  // 4. atomic writes and renames.
  eachDefinition((definition) => {
    if (!ATOMIC_WRITE.has(normalize(definition.text, { [definition.name]: "N" }))) return false;
    useImport("fs-atomic.mjs", "atomicWriteText", definition.name, definition);
    report.atomic += 1;
    return true;
  });
  src = replaceInCode(src, /(?<![\w$.])fs\.renameSync\(/g, () => {
    report.renames += 1;
    return "renamePath(";
  });
  if (report.renames) imports["fs-atomic.mjs"].add("renamePath");
  src = src.replace(/(from ")((?:\.\.\/)+|\.\/)artifact-storage\.mjs(";)/g, (whole, a, dots, b) => `${a}${dots}core/fs-atomic.mjs${b}`);

  // 5. path-escape checks.
  src = replaceInCode(src, /(?<![\w$.])([\w$]+(?:\.[\w$]+)*)\.startsWith\("\.\."\) \|\| path\.isAbsolute\(\1\)/g, (whole, name) => {
    report.pathChecks += 1;
    imports["path-safety.mjs"].add("escapesRootByPrefix");
    return `escapesRootByPrefix(${name})`;
  });
  src = replaceInCode(
    src,
    /(?<![\w$.])([\w$]+(?:\.[\w$]+)*) === "\.\." \|\| \1\.startsWith\(`\.\.\$\{path\.sep\}`\) \|\| path\.isAbsolute\(\1\)/g,
    (whole, name) => {
      report.pathChecks += 1;
      imports["path-safety.mjs"].add("escapesRoot");
      return `escapesRoot(${name})`;
    },
  );

  // 6. fail helpers.
  eachDefinition((definition) => {
    const { key, defaultCode } = shapeOf(definition);
    const name = definition.name;
    const onlyCalled = () => {
      const calls = callsOf(src, name, definition);
      return identifierUses(src, name) === calls.length + 1 ? calls : null;
    };
    if (FAIL_MESSAGE_CODE.has(key)) {
      useImport("errors.mjs", "fail", name, definition);
      report.fail.push(`${name}: fail`);
      return true;
    }
    if (FAIL_MESSAGE_DEFAULT_CODE.has(key) && definition.kind === "const") {
      const replacement = `${definition.exported ? "export " : ""}const ${name} = failWith(${defaultCode});\n`;
      src = src.slice(0, definition.start) + replacement + src.slice(definition.end);
      imports["errors.mjs"].add("failWith");
      report.fail.push(`${name}: failWith(${defaultCode})`);
      return true;
    }
    if (FAIL_CODE_MESSAGE_DEFAULT.has(key)) {
      useImport("errors.mjs", "failCode", name, definition);
      report.fail.push(`${name}: failCode`);
      return true;
    }
    if (FAIL_CODE_ONLY.has(key)) {
      const calls = onlyCalled();
      if (!calls || calls.some((call) => call.args.length > 1)) {
        report.skipped.add(`${name}: code-only fail is passed as a value or called with more than one argument`);
        return false;
      }
      useImport("errors.mjs", "failCode", name, definition);
      report.fail.push(`${name}: failCode`);
      return true;
    }
    if (FAIL_CODE_FIRST.has(key)) {
      const calls = onlyCalled();
      if (!calls || calls.some((call) => call.args.length !== 2)) {
        report.skipped.add(`${name}: code-first fail is passed as a value or not called with exactly two arguments`);
        return false;
      }
      // Swap (code, message) -> (message, code), from the end so offsets stay valid.
      for (const call of [...calls].reverse()) {
        const [code, message] = call.args;
        const lead = code.match(/^\s*/)[0];
        const trail = message.match(/\s*$/)[0];
        src = src.slice(0, call.open + 1) + `${lead}${message.trim()}, ${code.trim()}${trail}` + src.slice(call.end - 1);
      }
      const moved = topLevelDefinitions(src).find((candidate) => candidate.name === name && candidate.text === definition.text);
      useImport("errors.mjs", "fail", name, moved);
      report.fail.push(`${name}: fail (arguments swapped at ${calls.length} calls)`);
      return true;
    }
    return false;
  });

  if (exportsAfter.length) src = src.replace(/\n*$/, `\n\nexport { ${exportsAfter.join(", ")} };\n`);
  for (const [module, specifiers] of Object.entries(imports)) src = addImport(src, file, module, specifiers);
  src = dropUnusedDefaultImport(src, "crypto", "node:crypto");
  src = src.replace(/^import \{ createHash \} from "node:crypto";\n/m, "");
  src = src.replace(/^import \{ createHash, (.*) \} from "node:crypto";\n/m, 'import { $1 } from "node:crypto";\n');
  src = src.replace(/^import \{ (.*), createHash \} from "node:crypto";\n/m, 'import { $1 } from "node:crypto";\n');
  report.skipped = [...report.skipped];
  return { src, report };
}

function callsOf(src, name, definition) {
  const calls = [];
  const re = new RegExp(`(?<![\\w$.])${name}\\(`, "g");
  for (let match; (match = re.exec(src));) {
    if (match.index >= definition.start && match.index < definition.end) continue;
    const open = match.index + match[0].length - 1;
    const { args, end } = callArguments(src, open);
    calls.push({ open, end, args });
  }
  return calls;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const totals = { files: 0, oneShot: 0, hashers: 0, digestHelpers: 0, canonical: 0, fail: 0, atomic: 0, renames: 0, pathChecks: 0 };
  for (const file of libFiles()) {
    const original = fs.readFileSync(file, "utf8");
    const { src, report } = transform(file, original);
    skipCode(src.replace(/^#!.*\n/, "\n"), 0, null);
    if (src === original) continue;
    totals.files += 1;
    for (const key of ["oneShot", "hashers", "atomic", "renames", "pathChecks"]) totals[key] += report[key];
    for (const key of ["digestHelpers", "canonical", "fail"]) totals[key] += report[key].length;
    const name = path.relative(pluginRoot, file).split(path.sep).join("/");
    if (report.skipped.length) console.error(`${name}: skipped ${report.skipped.join("; ")}`);
    if (process.argv.includes("--verbose")) console.log(name, JSON.stringify(report));
    if (write) fs.writeFileSync(file, src);
  }
  console.log(JSON.stringify(totals));
}

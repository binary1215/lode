// The shared source scan reads JavaScript / TypeScript with one lexer
// (scripts/lib/world/source-code-mask.mjs): nested template literals, regular
// expression literals and comments no longer flip its string/code state.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { analyzeSourceFile, extractSemanticSourceFacts, extractSourceSymbols } from "../scripts/lib/world/source-analysis.mjs";
import { codeMask } from "../scripts/lib/world/source-code-mask.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const tick = String.fromCharCode(96);
const names = (text, language = "javascript") => extractSourceSymbols(text, language, { maxSymbols: 10_000 }).map((symbol) => symbol.name);

test("each text the plain quote scan misread is followed by a declaration that is found", () => {
  const cases = {
    "template inside a template's ${...}": `const a = ${tick}outer \${${tick}inner \${x}${tick}} end${tick};\n`,
    "regex with quotes and a backtick after =": `const b = /["'${tick}]/g;\n`,
    "regex with quotes and a backtick after (": `const c = text.replace(/["'${tick}]/g, "");\n`,
    "regex with quotes and a backtick after return": `function d(s) { return /["'${tick}]/.test(s); }\n`,
    "template with quotes inside ${...}": `const e = ${tick}\${map["key"] + 'x'}${tick};\n`,
    "block comment with quotes": `/* it's "quoted" and ${tick}ticked */\n`,
    "string containing //": `const f = "http://example.test";\n`,
  };
  for (const [label, prefix] of Object.entries(cases)) {
    const text = `${prefix}function after() { return helper(); }\nfunction helper() { return 1; }\n`;
    const found = names(text);
    assert(found.includes("after") && found.includes("helper"), `${label}: ${found.join(", ")}`);
    const calls = extractSemanticSourceFacts(text, "javascript").calls.filter((call) => call.callee === "helper");
    assert.deepEqual(
      calls.map((call) => call.callerQualifiedName),
      ["after"],
      label,
    );
  }
});

test("a call inside a template's ${...} is read, and the braces of ${...} do not unbalance a body", () => {
  const text = `function outer() {\n  return ${tick}a \${inner()} b \${ {x: 1}.x }${tick};\n}\nfunction inner() { return 2; }\n`;
  const symbols = extractSourceSymbols(text, "javascript");
  assert.deepEqual(
    symbols.map((symbol) => [symbol.name, symbol.line, symbol.endLine]),
    [
      ["outer", 1, 3],
      ["inner", 4, 4],
    ],
  );
  assert.deepEqual(
    extractSemanticSourceFacts(text, "javascript").calls.map((call) => [call.callee, call.callerQualifiedName]),
    [["inner", "outer"]],
  );
});

test("a generator declaration is a function declaration", () => {
  const text = "export function* rows() { yield next(); }\nasync function *pages() {}\nfunction next() {}\n";
  assert.deepEqual(
    extractSourceSymbols(text, "javascript").map((symbol) => [symbol.name, symbol.kind]),
    [
      ["rows", "function"],
      ["pages", "function"],
      ["next", "function"],
    ],
  );
  assert.deepEqual(
    extractSemanticSourceFacts(text, "javascript").calls.map((call) => call.callee),
    ["next"],
  );
});

test("a file the lexer cannot decide is reported as read with reduced confidence, never silently dropped", () => {
  // The file ends inside a template literal: the lexer cannot trust its reading.
  const text = `function before() { return 1; }\nconst open = ${tick}never closed\nfunction later() {}\n`;
  const result = analyzeSourceFile(text, "javascript", "undecided.mjs", { withReadConfidence: true });
  assert.equal(result.readConfidence, "reduced");
  assert(result.symbols.some((symbol) => symbol.name === "before"));
  const decided = analyzeSourceFile("function fine() {}\n", "javascript", "fine.mjs", { withReadConfidence: true });
  assert.equal(decided.readConfidence, "full");
  // Without the option the result keeps the shape stored records are built from.
  assert.deepEqual(Object.keys(analyzeSourceFile(text, "javascript", "undecided.mjs")), ["symbols", "dependencies", "semanticFacts"]);
});

// Declarations that a line regex sees but that really are text: PowerShell
// functions inside String.raw templates sent to a child process.
const DECLARATIONS_IN_TEXT = new Set(["scripts/lib/runtime/windows-exact-process-query.mjs", "scripts/lib/runtime/windows-process-query-wire.mjs"]);

test("Lode itself: every top-level function declaration a line regex sees under scripts/ is found", () => {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (/\.(?:m?js|cjs|ts|mts)$/.test(entry.name)) files.push(full);
    }
  };
  walk(path.join(pluginRoot, "scripts"));
  const missing = [];
  let seen = 0;
  for (const file of files) {
    const relative = path.relative(pluginRoot, file).split(path.sep).join("/");
    const text = fs.readFileSync(file, "utf8");
    const found = new Set(extractSourceSymbols(text, "javascript", { maxSymbols: 10_000 }).map((symbol) => `${symbol.name}:${symbol.line}`));
    const mask = DECLARATIONS_IN_TEXT.has(relative) ? codeMask(text, "javascript") : null;
    let offset = 0;
    text.split("\n").forEach((line, index) => {
      const match = /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(line);
      const lineStart = offset;
      offset += line.length + 1;
      if (!match) return;
      seen += 1;
      if (found.has(`${match[1]}:${index + 1}`)) return;
      // Allowed only where the lexer says the line is inside a string.
      if (mask && !mask[lineStart]) return;
      missing.push(`${relative}:${index + 1} ${match[1]}`);
    });
  }
  assert(seen > 1000, `only ${seen} declarations seen`);
  assert.deepEqual(missing, []);
});

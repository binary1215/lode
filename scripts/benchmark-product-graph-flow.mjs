// Reproducible synthetic-only comparison. No model, external service or user
// history is opened. The optional baseline is a local source checkout.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { buildProductGraph } from "./lib/world/product-graph.mjs";
import { productGraphWalk as walk } from "./graph-explorer/product-graph-walk.js";

const args = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [process.argv[2 + i * 2], process.argv[3 + i * 2]]));
const iterations = Number(args["--iterations"] || 5),
  count = Number(args["--files"] || 60),
  declarations = Number(args["--declarations"] || 2);
if (!Number.isInteger(iterations) || iterations < 1 || iterations > 20 || !Number.isInteger(count) || count < 3 || count > 500)
  throw new Error("Use 1..20 iterations and 3..500 synthetic files");
if (!Number.isInteger(declarations) || declarations < 2 || declarations > 100) throw new Error("Use 2..100 declarations per synthetic file");
const baseline = args["--baseline-root"] ? await import(pathToFileURL(path.join(args["--baseline-root"], "scripts/lib/world/product-graph.mjs"))) : null;
const baselineWalk = args["--baseline-root"]
  ? (await import(pathToFileURL(path.join(args["--baseline-root"], "scripts/graph-explorer/product-graph-walk.js")))).productGraphWalk
  : null;
const root = fs.mkdtempSync(path.join(process.env.HEAD_AGENT_TEST_TMP || os.tmpdir(), "lode-graph-benchmark-"));
const write = (name, content) => {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const read = (out) => JSON.parse(fs.readFileSync(path.join(out, "graph.json"), "utf8"));
const samples = [],
  searchSamples = [];
const sourceText = (i, value) =>
  `export function saveNote${i}() { return store${i}(); }\nfunction store${i}() { return ${value}; }\n` +
  Array.from({ length: declarations - 2 }, (_, n) => `export function helper${n}(value) {\n  const output = value + ${n};\n  return output;\n}\n`).join("\n");
try {
  fs.mkdirSync(path.join(root, "documents"));
  write("rules.json", '{"schemaVersion":1,"kind":"LodeProductGraphEntryRules","rules":[]}');
  write("source/package.json", '{"bin":{"notes":"bin.mjs"}}');
  let bin = "";
  for (let i = 0; i < count; i += 1) {
    bin += `import { saveNote${i} } from "./part-${i}.mjs";\nsaveNote${i}();\n`;
    write(`source/part-${i}.mjs`, sourceText(i, 1));
  }
  write("source/bin.mjs", bin);
  const options = { sourceRoot: path.join(root, "source"), documentsDirectory: path.join(root, "documents"), rulesFile: path.join(root, "rules.json") };
  const measure = (engine, mode, iteration, build, out, incremental) => {
    const start = performance.now(),
      result = build({ ...options, outputDirectory: out, incremental });
    const ms = performance.now() - start;
    samples.push({ engine, mode, iteration, ms, processing: result.processing || { scope: "full" }, nodes: result.nodes, edges: result.edges });
    return read(out);
  };
  for (let i = 0; i < iterations; i += 1) {
    const cached = path.join(root, `cached-${i}`),
      full = path.join(root, `full-${i}`),
      old = path.join(root, `old-${i}`);
    write("source/part-0.mjs", sourceText(0, 1));
    const cold = measure("candidate", "cold", i, buildProductGraph, cached, true);
    const golden = measure("candidate", "full", i, buildProductGraph, full, false);
    assert.deepEqual(cold, golden);
    if (baseline) assert.deepEqual(measure("main", "full", i, baseline.buildProductGraph, old, false), golden);
    assert.deepEqual(measure("candidate", "unchanged", i, buildProductGraph, cached, true), golden);
    write("source/part-0.mjs", sourceText(0, 2));
    const changed = measure("candidate", "one-file", i, buildProductGraph, cached, true);
    assert.deepEqual(changed, measure("candidate", "one-file-full", i, buildProductGraph, full, false));
    write("rules.json", '{"schemaVersion":1,"kind":"LodeProductGraphEntryRules","rules":[],"source":{"제외":[]}}');
    assert.deepEqual(
      measure("candidate", "rules-change", i, buildProductGraph, cached, true),
      measure("candidate", "rules-change-full", i, buildProductGraph, full, false),
    );
    write("rules.json", '{"schemaVersion":1,"kind":"LodeProductGraphEntryRules","rules":[]}');
  }
  const graph = {
    nodes: [
      { id: "UA-01", type: "유저 활동", oneLine: "메모 저장 오류를 확인한다" },
      { id: "UI-01#1", type: "화면요소", oneLine: "메모 저장 버튼" },
      { id: "cli:saveNote", type: "기능", oneLine: "메모 저장", positions: [] },
      ...Array.from({ length: 100 }, (_, i) => ({ id: `other-${i}`, type: "기능", oneLine: "사진 저장", positions: [] })),
    ],
    edges: [
      { type: "유저 활동→화면요소", from: "UA-01", to: "UI-01#1" },
      { type: "화면요소→기능", from: "UI-01#1", to: "cli:saveNote" },
    ],
  };
  for (const [name, implementation] of [["candidate", walk], ...(baselineWalk ? [["main", baselineWalk]] : [])]) {
    const ctx = implementation.context({ graph }),
      buildStart = performance.now();
    implementation.find(ctx, "saveNote");
    const indexMs = performance.now() - buildStart;
    for (const query of ["메모를 저장할 때", "saveNote", "cli:saveNote"]) {
      const start = performance.now(),
        hits = implementation.find(ctx, query),
        ms = performance.now() - start;
      const top = hits.slice(0, 5),
        relevant = new Set(["UA-01", "UI-01#1", "cli:saveNote"]);
      searchSamples.push({
        engine: name,
        query,
        ms,
        indexMs,
        returned: hits.length,
        top5Relevant: top.filter((n) => relevant.has(n.id)).length,
        top5Noise: top.filter((n) => !relevant.has(n.id)).length,
        outputBytes: Buffer.byteLength(JSON.stringify(top)),
      });
    }
  }
  const summary = [...new Set(samples.map((s) => `${s.engine}/${s.mode}`))].map((key) => {
    const group = samples.filter((s) => `${s.engine}/${s.mode}` === key),
      times = group.map((s) => s.ms).sort((a, b) => a - b);
    return { key, medianMs: times[Math.floor(times.length / 2)], minMs: times[0], maxMs: times.at(-1) };
  });
  console.log(
    JSON.stringify(
      {
        fixture: { synthetic: true, files: count + 1, declarationsPerFile: declarations, iterations, node: process.version, platform: process.platform },
        graphEquality: "deep-equal before/after and cached/full at every measured state",
        scope: "dependency-bound parse/resolution/document/reach reuse; I/O hashing, graph assembly, global invalidation and serialization remain",
        samples,
        summary,
        searchSamples,
        limits:
          "Small labelled lexical fixture, not semantic recall or production performance; local OS cache/JIT not controlled; search rank is not execution evidence",
      },
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

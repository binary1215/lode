import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildRepositoryScanInput,
  executeIncrementalRepositoryScan,
  inspectRepositoryScanFreshness,
  scanRepositoryReference,
  validateRepositoryScanResult,
} from "../scripts/lib/world/repository-scan.mjs";
import { buildSemanticGraph } from "../scripts/lib/world/semantic-graph.mjs";
import { extractSemanticSourceFacts, extractSourceSymbols } from "../scripts/lib/world/source-analysis.mjs";
import { buildTemporalProvenanceGraph } from "../scripts/lib/world/temporal-provenance.mjs";
import { normalizeProductModelDocument } from "../scripts/lib/world/product-model.mjs";

const testParent = process.env.HEAD_AGENT_TEST_TMP || os.tmpdir();

test("work evidence is excluded without hiding sources or changing their freshness", async (t) => {
  fs.mkdirSync(testParent, { recursive: true });
  const root = fs.mkdtempSync(path.join(testParent, "head-work-scope-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of ["src/app.js", ".github/workflow.yml", ".custom-source/module.py"]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "value = 1\n");
  }
  const input = buildRepositoryScanInput({ projectRoot: root });
  const before = scanRepositoryReference(input);
  for (const file of [".agent-work/review.md", "src/.agent-work/result.json", "src/nested/.AGENT-WORK/notes.md"]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "work evidence\n");
  }
  const after = scanRepositoryReference(input);
  assert.deepEqual(after.files, before.files);
  assert.equal(after.skipped.excludedDirectory, 3);
  assert.equal(inspectRepositoryScanFreshness({ projectRoot: root, storedFiles: before.files }).status, "unchanged");
  const payload = { ...before, protocol: { ...before.protocol, version: "0.5.0" } };
  delete payload.scanId;
  delete payload.scanHash;
  const old = reidentifyScan(payload);
  assert.doesNotThrow(() => validateRepositoryScanResult(old));
  const { files, skipped, ...repositoryScan } = old;
  const upgraded = await executeIncrementalRepositoryScan({ projectRoot: root, previousSnapshot: { repositoryScan, files, skipped } });
  assert.equal(upgraded.result.protocol.version, "0.5.1");
  assert.deepEqual(upgraded.diagnostics.reusedPaths, []);
  assert.deepEqual(upgraded.result.files, before.files);
  const historicalFiles = [...before.files, { ...before.files[0], path: ".agent-work/review.md" }];
  assert.deepEqual(inspectRepositoryScanFreshness({ projectRoot: root, storedFiles: historicalFiles }).changes.removed, [".agent-work/review.md"]);
});

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

function reidentifyScan(payload) {
  const scanHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(payload)))
    .digest("hex");
  return { ...payload, scanId: `repository-scan-${scanHash.slice(0, 24)}`, scanHash };
}

function emptyProductModel() {
  return normalizeProductModelDocument({
    schemaVersion: 1,
    featureGroups: [],
    capabilities: [],
    features: [],
    requirements: [],
    constraints: [],
    decisions: [],
  });
}

test("qualified declarations preserve Python annotations, multiline headers, and same-name scopes", () => {
  const source = `class A:
    def read(self) -> bool:
        return helper()

class B:
    async def read(
        self,
        value: str,
    ) -> bool:
        return helper()

def helper():
    return True
`;
  const symbols = extractSourceSymbols(source, "python");
  assert.deepEqual(
    symbols.filter((symbol) => symbol.name === "read").map((symbol) => symbol.qualifiedName),
    ["A.read", "B.read"],
  );
  assert.match(symbols.find((symbol) => symbol.qualifiedName === "A.read").signature, /-> bool:/u);
  assert.match(symbols.find((symbol) => symbol.qualifiedName === "B.read").signature, /value: str/u);
  const facts = extractSemanticSourceFacts(source, "python");
  assert.deepEqual(
    facts.calls.filter((call) => call.callee === "helper").map((call) => call.callerQualifiedName),
    ["A.read", "B.read"],
  );

  const file = {
    path: "src/readers.py",
    digest: crypto.createHash("sha256").update(source).digest("hex"),
    freshness: "active",
    bytes: Buffer.byteLength(source),
    classification: "source",
    language: "python",
    symbols,
    dependencies: [],
    semanticFacts: facts,
  };
  const semantic = buildSemanticGraph({ files: [file] });
  const nodes = new Map(semantic.nodes.map((node) => [node.id, node]));
  assert.deepEqual(
    semantic.edges
      .filter((edge) => edge.type === "CALLS")
      .map((edge) => nodes.get(edge.from).qualifiedName)
      .sort(),
    ["A.read", "B.read"],
  );
  const temporal = buildTemporalProvenanceGraph({ projectId: "project-source-analysis", files: [file], productModel: emptyProductModel() });
  const reads = temporal.nodes.filter((node) => node.kind === "Symbol" && node.name === "read");
  assert.equal(new Set(reads.map((node) => node.nodeId)).size, 2);
  assert.deepEqual(reads.map((node) => node.qualifiedName).sort(), ["A.read", "B.read"]);
});

test("expression arrows cannot capture the next declaration and comments cannot create relations", () => {
  const source = `// function phantom() { return hidden(); }
export const first = () => 1;
export function second() {
  const text = "third()";
  return third();
}
export function third() { return 3; }
`;
  const symbols = extractSourceSymbols(source, "javascript");
  assert.deepEqual(
    symbols.map(({ qualifiedName, line, endLine }) => ({ qualifiedName, line, endLine })),
    [
      { qualifiedName: "first", line: 2, endLine: 2 },
      { qualifiedName: "second", line: 3, endLine: 6 },
      { qualifiedName: "third", line: 7, endLine: 7 },
    ],
  );
  const calls = extractSemanticSourceFacts(source, "javascript").calls.filter((call) => call.callee === "third");
  assert.deepEqual(calls, [{ callee: "third", line: 5, callerQualifiedName: "second", callerIdentityAmbiguous: false }]);
});

test("canonical declaration ranges exclude calls after a closed body", () => {
  assert.equal(extractSourceSymbols("def f():\n    return 1\n", "python")[0].endLine, 3);
  assert.deepEqual(extractSemanticSourceFacts("function f() {} f();", "javascript").calls, [
    { callee: "f", line: 1, callerQualifiedName: null, callerIdentityAmbiguous: false },
  ]);
});

test("0.4 scans remain readable but are reanalyzed instead of reused as 0.5 metadata", async (t) => {
  fs.mkdirSync(testParent, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(testParent, "head-agent-legacy-scan-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "app.py"), "def read_cancel_token() -> bool:\n    return True\n");
  const current = scanRepositoryReference(buildRepositoryScanInput({ projectRoot: root }));
  const legacyPayload = {
    ...structuredClone(current),
    protocol: { ...current.protocol, version: "0.4.0" },
    sourceAnalysisVersion: "0.2.0",
    files: current.files.map((file) => ({
      ...file,
      symbols: file.symbols.map(({ name, kind, line }) => ({ name, kind, line })),
      semanticFacts: {
        bindings: file.semanticFacts.bindings,
        calls: file.semanticFacts.calls.map(({ callee, line }) => ({ callee, line })),
      },
    })),
  };
  delete legacyPayload.scanId;
  delete legacyPayload.scanHash;
  const legacy = reidentifyScan(legacyPayload);
  assert.doesNotThrow(() => validateRepositoryScanResult(legacy));

  const { files, skipped, ...repositoryScan } = legacy;
  const upgraded = await executeIncrementalRepositoryScan({
    projectRoot: root,
    previousSnapshot: { repositoryScan, files, skipped },
  });
  assert.deepEqual(upgraded.diagnostics.reusedPaths, []);
  assert.deepEqual(upgraded.diagnostics.analyzedPaths, ["app.py"]);
  assert.equal(upgraded.result.protocol.version, "0.5.1");
  assert.equal(upgraded.result.sourceAnalysisVersion, "0.3.1");
  assert.equal(upgraded.result.files[0].symbols[0].qualifiedName, "read_cancel_token");
});

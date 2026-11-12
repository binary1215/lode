import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  buildStructuralRelationObservationEnvelope,
  verifyStructuralRelationObservationEnvelope,
  prepareStructuralRelationObservationEnvelope,
} from "../scripts/lib/world/structural-relation-observation-envelope.mjs";

const enc = new TextEncoder();
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const ascii = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort(ascii).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
const H = (value) => digest(Buffer.from(canonicalJson(value)));
const contentId = (prefix, value) => `${prefix}-${H(value).slice(0, 24)}`;
const range = (line, start, end) => ({ start: { line, character: start }, end: { line, character: end } });
const ids = (document) => new Map(document.rawRefs.map((entry) => [entry.kind, entry.rawRefId]));

function fixture({ lineEnding = "\n", callerText = null } = {}) {
  const caller = callerText ?? ["export function caller() {", "  target(); target();", "}", ""].join(lineEnding);
  const target = ["export function target() {}", ""].join(lineEnding);
  const sourceBytesByPath = new Map([["src/caller.ts", enc.encode(caller)], ["src/target.ts", enc.encode(target)]]);
  const rawBytesById = new Map([["raw-a", enc.encode('{"method":"callHierarchy/outgoingCalls","result":"A"}')], ["raw-b", enc.encode('{"method":"callHierarchy/outgoingCalls","result":"B"}')]]);
  const callerDigest = digest(sourceBytesByPath.get("src/caller.ts"));
  const targetDigest = digest(sourceBytesByPath.get("src/target.ts"));
  const endpoint = (name, path, sha256, end) => ({ path, digest: sha256, name, symbolKind: "function", declarationRange: { start: { line: 0, character: 0 }, end }, selectionRange: range(0, 16, 16 + name.length) });
  const admittedSources = [{ path: "src/caller.ts", digest: callerDigest }, { path: "src/target.ts", digest: targetDigest }];
  const draft = {
    projectId: "seo-r1-test",
    sourceManifest: [{ path: "src/caller.ts", language: "typescript" }, { path: "src/target.ts", language: "typescript" }],
    producerClaims: [{ producerClaimKey: "producer", name: "fixture-producer", version: "1", executableIdentity: "fixture-executable", profileIdentity: "fixture-profile", reportedTransport: "lsp", reportedMethod: "callHierarchy/outgoingCalls", analysisMethodClaim: { reportedValue: "language-service", reportSource: "observer-recorded", truthStatus: "unknown" }, producerIdentityEvidenceStatus: "partial" }],
    rawRefs: [{ rawRefKey: "raw-a", kind: "accepted-decoded-record-a", mediaType: "application/json" }, { rawRefKey: "raw-b", kind: "accepted-decoded-record-b", mediaType: "application/json" }],
    runs: ["a", "b"].map((suffix) => ({ runKey: `run-${suffix}`, producerClaimKey: "producer", inputBinding: { sourceManifestScope: "full", configDigest: "1".repeat(64), profileDigest: "2".repeat(64), normalizerVersion: "0.3.0", normalizerImplementationDigest: "3".repeat(64) }, coverage: { admittedSources, queriedDirection: "outgoing", queriedSymbols: [{ path: "src/caller.ts", digest: callerDigest, name: "caller", symbolKind: "function", line: 0 }], reportedResponseClosure: "complete-frame-observed", programCoverage: "unknown", repositoryRelationCompleteness: "not-claimed" }, rawRefKeys: [`raw-${suffix}`] })),
    pairs: [{ pairKey: "calls", type: "CALLS", from: endpoint("caller", "src/caller.ts", callerDigest, { line: 2, character: 1 }), to: endpoint("target", "src/target.ts", targetDigest, { line: 0, character: 27 }), language: "typescript", occurrences: [
      { occurrenceKey: "first", evidence: { path: "src/caller.ts", digest: callerDigest, range: range(1, 2, 8) }, supports: [{ runKey: "run-a", rawRefKey: "raw-a" }, { runKey: "run-b", rawRefKey: "raw-b" }] },
      { occurrenceKey: "second", evidence: { path: "src/caller.ts", digest: callerDigest, range: range(1, 12, 18) }, supports: [{ runKey: "run-a", rawRefKey: "raw-a" }, { runKey: "run-b", rawRefKey: "raw-b" }] },
    ] }],
    diagnosticLabels: ["fixture-only"],
  };
  return { draft, sourceBytesByPath, rawBytesById };
}

function build(value = fixture()) { return { value, document: buildStructuralRelationObservationEnvelope(value.draft, { sourceBytesByPath: value.sourceBytesByPath, rawBytesById: value.rawBytesById }) }; }
function verifierRawMap(value, document) { const map = ids(document); return new Map([[map.get("accepted-decoded-record-a"), value.rawBytesById.get("raw-a")], [map.get("accepted-decoded-record-b"), value.rawBytesById.get("raw-b")]]); }
function clone(value) { return structuredClone(value); }
function freezeJson(value) {
  if (value && typeof value === "object") {
    for (const entry of Array.isArray(value) ? value : Object.values(value)) freezeJson(entry);
    Object.freeze(value);
  }
  return value;
}
function reseal(document) {
  const payload = { ...document }; delete payload.envelopeId; delete payload.envelopeHash;
  document.envelopeHash = H(payload); document.envelopeId = `structural-envelope-${document.envelopeHash.slice(0, 24)}`;
  return document;
}
function recomputeLineage(document) {
  document.subject.sourceManifest.sort((a, b) => ascii(a.path, b.path));
  document.subject.sourceManifestDigest = H(document.subject.sourceManifest.map(({ path, sha256, language, byteLength }) => ({ path, sha256, language, byteLength })));
  const sources = new Map(document.subject.sourceManifest.map((entry) => [entry.path, entry]));
  const runMap = new Map();
  for (const run of document.runs) {
    const oldRunId = run.runId;
    {
      const descriptors = run.coverage.admittedSources.map((entry) => sources.get(entry.path)).sort((a, b) => ascii(a.path, b.path));
      run.inputBinding.sourceManifestDigest = H(descriptors.map(({ path, sha256, language, byteLength }) => ({ path, sha256, language, byteLength })));
    }
    const payload = { producerClaimId: run.producerClaimId, inputBinding: run.inputBinding, coverage: run.coverage, rawRefIds: run.rawRefIds };
    run.runId = contentId("structural-run", payload); runMap.set(oldRunId, run.runId);
  }
  document.runs.sort((a, b) => ascii(a.runId, b.runId));
  for (const pair of document.pairs) {
    const pairPayload = { type: pair.type, from: pair.from, to: pair.to, language: pair.language };
    pair.pairId = contentId("structural-pair", pairPayload);
    for (const occurrence of pair.occurrences) {
      occurrence.pairId = pair.pairId;
      occurrence.occurrenceId = contentId("structural-occurrence", { pairId: pair.pairId, evidence: occurrence.evidence });
      for (const support of occurrence.supports) {
        support.occurrenceId = occurrence.occurrenceId;
        support.runId = runMap.get(support.runId) ?? support.runId;
        support.supportId = contentId("structural-support", { occurrenceId: support.occurrenceId, runId: support.runId, rawRefId: support.rawRefId });
      }
      occurrence.supports.sort((a, b) => ascii(a.supportId, b.supportId));
    }
    pair.occurrences.sort((a, b) => ascii(a.occurrenceId, b.occurrenceId));
  }
  document.pairs.sort((a, b) => ascii(a.pairId, b.pairId));
  document.candidateProjection.entries = document.pairs.map((pair) => ({ pairId: pair.pairId, occurrenceIds: pair.occurrences.map((entry) => entry.occurrenceId).sort(ascii) }));
  document.candidateProjection.projectionDigest = H({ policy: "relation-pair-only-v0", entries: document.candidateProjection.entries });
  return reseal(document);
}

test("UX rejected observations do not mutate inputs or poison subsequent valid observations", () => {
  const baseline = build().document;
  const cases = [
    ["unsupported shape", (value) => { value.draft.pairs = []; }, "UNSUPPORTED_STRUCTURAL_RELATION_OBSERVATION_SHAPE"],
    ["resource limit", (value) => { value.rawBytesById.set("raw-a", new Uint8Array(1_048_577)); }, "STRUCTURAL_RELATION_OBSERVATION_LIMIT"],
    ["invalid truth claim", (value) => { value.draft.producerClaims[0].analysisMethodClaim.truthStatus = "verified"; }, "UNSUPPORTED_STRUCTURAL_RELATION_TRUTH_STATUS"],
    ["invalid coverage claim", (value) => { value.draft.runs[0].coverage.repositoryRelationCompleteness = "complete"; }, "UNSUPPORTED_STRUCTURAL_RELATION_COVERAGE"],
  ];
  for (const [label, change, code] of cases) {
    const rejected = fixture();
    change(rejected);
    const before = clone(rejected);
    assert.throws(() => build(rejected), { code }, label);
    assert.deepEqual(rejected, before, `${label}: caller data preserved`);
    const { value, document } = build();
    assert.deepEqual(document, baseline, `${label}: next observation unchanged`);
    const { verificationReport } = verifyStructuralRelationObservationEnvelope(document, {
      sourceBytesByPath: value.sourceBytesByPath,
      rawBytesById: verifierRawMap(value, document),
    });
    assert.equal(verificationReport.finalStrongVerification, true);
    assert.equal(verificationReport.claimTruthVerification, "not-supported");
    assert.equal(verificationReport.responseCompletenessVerification, "not-evaluated");
  }
});

test("SEO01 unknown claim survives strong integrity verification without truth promotion", () => {
  const { value, document } = build();
  const result = verifyStructuralRelationObservationEnvelope(document, { sourceBytesByPath: value.sourceBytesByPath, rawBytesById: verifierRawMap(value, document) });
  assert.equal(result.verificationReport.finalStrongVerification, true);
  assert.equal(result.verificationReport.claimTruthVerification, "not-supported");
  assert.equal(document.producerClaims[0].analysisMethodClaim.truthStatus, "unknown");
  const bad = clone(value.draft); bad.producerClaims[0].analysisMethodClaim.truthStatus = "proven";
  assert.throws(() => buildStructuralRelationObservationEnvelope(bad, { sourceBytesByPath: value.sourceBytesByPath, rawBytesById: value.rawBytesById }), { code: "UNSUPPORTED_STRUCTURAL_RELATION_TRUTH_STATUS" });
});

test("SEO02 unrelated but correct raw stays opaque and semantic support is not evaluated", () => {
  const value = fixture(); value.rawBytesById.set("raw-a", enc.encode("delete everything now"));
  const { document } = build(value); const report = verifyStructuralRelationObservationEnvelope(document, { sourceBytesByPath: value.sourceBytesByPath, rawBytesById: verifierRawMap(value, document) }).verificationReport;
  assert.equal(report.rawByteIntegrity, "passed"); assert.equal(report.rawSemanticSupportVerification, "not-evaluated");
});

test("SEO03 coordinates support LF and CRLF, reject BOM, fatal UTF-8, lone CR, and surrogate splits", () => {
  assert.equal(build(fixture({ lineEnding: "\r\n" })).document.pairs[0].occurrences.length, 2);
  for (const bytes of [new Uint8Array([0xef, 0xbb, 0xbf, 0x61]), new Uint8Array([0xff]), enc.encode("export function caller() {\r  target(); target();\r}\r")]) {
    const value = fixture(); value.sourceBytesByPath.set("src/caller.ts", bytes); assert.throws(() => build(value));
  }
  const value = fixture({ callerText: "export function caller() {\n  😀target(); target();\n}\n" }); value.draft.pairs[0].occurrences[0].evidence.range = range(1, 3, 10); assert.throws(() => build(value), { code: "STRUCTURAL_RELATION_COORDINATE_MISMATCH" });
});

test("SEO04 supports aggregate A/B and reject run sources outside admitted subset", () => {
  const { document } = build(); assert.equal(document.pairs[0].occurrences.flatMap((entry) => entry.supports).length, 4);
  const value = fixture(); value.draft.runs[0].inputBinding.sourceManifestScope = "subset"; value.draft.runs[0].coverage.admittedSources = [value.draft.runs[0].coverage.admittedSources[0]];
  assert.throws(() => build(value), { code: "STRUCTURAL_RELATION_RUN_SOURCE_MISMATCH" });
  // This check uses the local synthetic sources and raw bytes, not an external capture.
  const verified = verifyStructuralRelationObservationEnvelope(document, {
    sourceBytesByPath: fixture().sourceBytesByPath,
    rawBytesById: verifierRawMap(fixture(), document),
  });
  assert.equal(verified.verificationReport.finalStrongVerification, true);
});

test("SEO05 projection and run/raw/support closure fail closed", () => {
  const { value, document } = build(); const omitted = clone(document); omitted.candidateProjection.entries[0].occurrenceIds.pop(); assert.throws(() => verifyStructuralRelationObservationEnvelope(omitted), { code: "NON_CANONICAL_STRUCTURAL_RELATION_OBSERVATION" });
  const orphan = clone(value.draft); const orphanRun = { ...clone(orphan.runs[0]), runKey: "orphan", rawRefKeys: ["raw-a"] }; orphanRun.inputBinding.profileDigest = "4".repeat(64); orphan.runs.push(orphanRun); assert.throws(() => build({ ...value, draft: orphan }), { code: "STRUCTURAL_RELATION_CLOSURE_MISMATCH" });
});

test("SEO06 byte maps distinguish omitted, partial, extra, swapped, length and byte drift", () => {
  const { value, document } = build(); const structural = verifyStructuralRelationObservationEnvelope(document); assert.equal(structural.verificationReport.sourceByteIntegrity, "not-run"); assert.equal(structural.verificationReport.finalStrongVerification, false);
  const raw = verifierRawMap(value, document); assert.equal(verifyStructuralRelationObservationEnvelope(document, { rawBytesById: raw }).verificationReport.sourceCoordinateValidation, "not-run");
  const partial = new Map(raw); partial.delete([...partial.keys()][0]); assert.throws(() => verifyStructuralRelationObservationEnvelope(document, { rawBytesById: partial }), { code: "STRUCTURAL_RELATION_BYTE_MAP_MISMATCH" });
  const extra = new Map(raw); extra.set("extra", enc.encode("x")); assert.throws(() => verifyStructuralRelationObservationEnvelope(document, { rawBytesById: extra }), { code: "STRUCTURAL_RELATION_BYTE_MAP_MISMATCH" });
  const rawIds = [...raw.keys()]; const swapped = new Map([[rawIds[0], raw.get(rawIds[1])], [rawIds[1], raw.get(rawIds[0])]]); assert.throws(() => verifyStructuralRelationObservationEnvelope(document, { rawBytesById: swapped }), { code: "STRUCTURAL_RELATION_BYTE_MAP_MISMATCH" });
  const wrong = new Map(raw); wrong.set([...wrong.keys()][0], enc.encode("x")); assert.throws(() => verifyStructuralRelationObservationEnvelope(document, { rawBytesById: wrong }), { code: "STRUCTURAL_RELATION_BYTE_MAP_MISMATCH" });
  assert.throws(() => verifyStructuralRelationObservationEnvelope(document, { rawBytesById: { ...raw } }), { code: "INVALID_STRUCTURAL_RELATION_BYTE_MAP" });
});

test("SEO07 coverage unknown/not-claimed is preserved and exaggeration is rejected", () => {
  const { document } = build(); assert.ok(document.runs.every((run) => run.coverage.programCoverage === "unknown" && run.coverage.repositoryRelationCompleteness === "not-claimed"));
  const value = fixture(); value.draft.runs[0].coverage.repositoryRelationCompleteness = "complete"; assert.throws(() => build(value), { code: "UNSUPPORTED_STRUCTURAL_RELATION_COVERAGE" });
});

test("SEO08 source path/digest binding has no automatic rebinding", () => {
  const { value, document } = build(); const changed = new Map(value.sourceBytesByPath); changed.set("src/caller.ts", enc.encode("changed")); assert.throws(() => verifyStructuralRelationObservationEnvelope(document, { sourceBytesByPath: changed }), { code: "STRUCTURAL_RELATION_BYTE_MAP_MISMATCH" });
});

test("SEO09 producer transport, method claim, and truth status remain distinct", () => {
  const { document } = build(); const claim = document.producerClaims[0]; assert.equal(claim.reportedTransport, "lsp"); assert.equal(claim.reportedMethod, "callHierarchy/outgoingCalls"); assert.equal(claim.analysisMethodClaim.reportedValue, "language-service"); assert.equal(claim.analysisMethodClaim.truthStatus, "unknown");
});

test("SEO10 authority fields reject while imperative raw remains opaque", () => {
  const { document } = build(); const bad = clone(document); bad.instructionAuthority = true; assert.throws(() => verifyStructuralRelationObservationEnvelope(bad), { code: "UNSUPPORTED_STRUCTURAL_RELATION_AUTHORITY" });
  const value = fixture(); value.draft.instructionAuthority = true; assert.throws(() => build(value), { code: "UNSUPPORTED_STRUCTURAL_RELATION_OBSERVATION_FIELD" });
});

test("SEO11 envelope is isolated and rejects legacy kind", async () => {
  const legacy = await import("../scripts/lib/world/source-relation-evidence.mjs");
  const analysis = await import("../scripts/lib/world/source-analysis.mjs");
  const graphApi = await import("../scripts/lib/world/semantic-graph.mjs");
  const caller = "export function caller() { target(); }\n";
  const target = "export function target() {}\n";
  const files = [["src/caller.ts", caller], ["src/target.ts", target]].map(([path, content]) => ({
    path,
    digest: digest(Buffer.from(content)),
    language: "typescript",
    classification: "source",
    symbols: analysis.extractSourceSymbols(content, "typescript"),
    dependencies: analysis.extractSourceDependencies(content, "typescript", path.split("/").at(-1)),
    semanticFacts: analysis.extractSemanticSourceFacts(content, "typescript"),
  }));
  const manifest = files.map(({ path, digest: sha256, language }) => ({ path, digest: sha256, language }));
  const evidence = legacy.buildSourceRelationEvidenceSet({
    projectId: "legacy-seo-baseline",
    files: manifest,
    analyzer: { name: "legacy-fixture", version: "1", method: "ast" },
    relations: [{
      type: "CALLS",
      from: { kind: "symbol", path: "src/caller.ts", name: "caller", symbolKind: "function", line: 1 },
      to: { kind: "symbol", path: "src/target.ts", name: "target", symbolKind: "function", line: 1 },
      evidence: { path: "src/caller.ts", line: 1, digest: manifest[0].digest },
      language: "typescript",
    }],
  });
  const graph = graphApi.buildSemanticGraph({ files, sourceRelationEvidence: evidence });
  assert.equal(evidence.evidenceSetId, "source-relation-evidence-2a3612e23ebe669d19e70bcd");
  assert.equal(evidence.evidenceSetHash, "2a3612e23ebe669d19e70bcd5b819453a6cd6844c4d16d3a5ca3437d91bbdda2");
  // This historical fixture used analyzer 0.3.0. The accepted 0.3.1 scanner
  // produces the same facts here, but DECLARES provenance is hash input. Build
  // the old payload without changing Core or relabeling a stored original.
  assert.equal(analysis.SOURCE_ANALYSIS_VERSION, "0.3.1");
  const currentBefore = JSON.stringify(graph), historical = structuredClone(graph);
  for (const edge of historical.edges) if (edge.type === "DECLARES") {
    assert.equal(edge.evidenceSource.sourceAnalysisVersion, analysis.SOURCE_ANALYSIS_VERSION);
    edge.evidenceSource.sourceAnalysisVersion = "0.3.0";
    const { id, ...payload } = edge;
    edge.id = contentId("semantic-edge", payload);
  }
  historical.edges.sort((a, b) => a.id.localeCompare(b.id));
  const { semanticGraphId, semanticGraphHash, ...historicalPayload } = historical;
  historical.semanticGraphHash = H(historicalPayload);
  historical.semanticGraphId = `semantic-graph-${historical.semanticGraphHash.slice(0, 24)}`;
  assert.equal(historical.semanticGraphId, "semantic-graph-d4b9ddfb4b6ff9b205818d8f");
  assert.equal(historical.semanticGraphHash, "d4b9ddfb4b6ff9b205818d8fe6df669f7962a0f8d2637bba16c25166143646c1");
  const oldBefore = JSON.stringify(historical);
  graphApi.verifySemanticGraph(historical); graphApi.verifySemanticGraph(graph);
  assert.equal(JSON.stringify(historical), oldBefore); assert.equal(JSON.stringify(graph), currentBefore);
  assert.deepEqual(graph.nodes, historical.nodes);
  assert.deepEqual(graph.edges.filter(edge => edge.type !== "DECLARES"), historical.edges.filter(edge => edge.type !== "DECLARES"));
  assert.equal(graph.edges.filter(edge => edge.type === "DECLARES").length, 2);
  assert.notEqual(graph.semanticGraphId, historical.semanticGraphId);
  assert.notEqual(graph.semanticGraphHash, historical.semanticGraphHash);
  assert.deepEqual(graph.summary, { nodeCount: 4, edgeCount: 3, fileNodeCount: 2, symbolNodeCount: 2, externalDependencyNodeCount: 0, importEdgeCount: 0, callEdgeCount: 1, astEvidenceEdgeCount: 1, unresolvedImportCount: 0, unresolvedCallCount: 1 });
  const { document } = build(); assert.throws(() => legacy.verifySourceRelationEvidenceSet(document));
});

test("SEO12 caps, exact fields, canonical order, cycles, duplicate occurrence and support reject", () => {
  const value = fixture(); value.draft.extra = true; assert.throws(() => build(value), { code: "UNSUPPORTED_STRUCTURAL_RELATION_OBSERVATION_FIELD" });
  const cyclic = fixture(); cyclic.draft.self = cyclic.draft; assert.throws(() => build(cyclic), { code: "UNSUPPORTED_STRUCTURAL_RELATION_OBSERVATION_FIELD" });
  const duplicateOccurrence = fixture(); duplicateOccurrence.draft.pairs[0].occurrences.push(clone(duplicateOccurrence.draft.pairs[0].occurrences[0])); assert.throws(() => build(duplicateOccurrence), { code: "DUPLICATE_STRUCTURAL_RELATION_OBSERVATION_ID" });
  const duplicateSupport = fixture(); duplicateSupport.draft.pairs[0].occurrences[0].supports.push(clone(duplicateSupport.draft.pairs[0].occurrences[0].supports[0])); assert.throws(() => build(duplicateSupport), { code: "DUPLICATE_STRUCTURAL_RELATION_OBSERVATION_ID" });
  const { document } = build(); const reordered = clone(document); reordered.rawRefs.reverse(); assert.throws(() => verifyStructuralRelationObservationEnvelope(reordered), { code: "NON_CANONICAL_STRUCTURAL_RELATION_OBSERVATION" });
  const malformed = clone(document); malformed.pairs = {}; assert.throws(() => verifyStructuralRelationObservationEnvelope(malformed), { code: "UNSUPPORTED_STRUCTURAL_RELATION_OBSERVATION_SHAPE" });
  const unsupported = clone(document); unsupported.pairs[0].from.selectionRange = range(3, 0, 1); assert.throws(() => verifyStructuralRelationObservationEnvelope(unsupported), { code: "STRUCTURAL_RELATION_COORDINATE_MISMATCH" });
});

test("R1 occurrence coordinates are bound to the caller file in builder and both verifier modes", () => {
  const value = fixture(); const occurrence = value.draft.pairs[0].occurrences[0]; const target = value.draft.pairs[0].to;
  occurrence.evidence = { path: target.path, digest: target.digest, range: clone(target.selectionRange) };
  assert.throws(() => build(value), { code: "STRUCTURAL_RELATION_SOURCE_MISMATCH" });
  const valid = build(); const invalid = clone(valid.document); invalid.pairs[0].occurrences[0].evidence = { path: invalid.pairs[0].to.path, digest: invalid.pairs[0].to.digest, range: clone(invalid.pairs[0].to.selectionRange) };
  assert.throws(() => verifyStructuralRelationObservationEnvelope(invalid), { code: "STRUCTURAL_RELATION_SOURCE_MISMATCH" });
  assert.throws(() => verifyStructuralRelationObservationEnvelope(invalid, { sourceBytesByPath: valid.value.sourceBytesByPath, rawBytesById: verifierRawMap(valid.value, valid.document) }), { code: "STRUCTURAL_RELATION_SOURCE_MISMATCH" });
  assert.equal(valid.document.pairs[0].occurrences.length, 2);
});

test("R2 producer claims reject duplicates and orphans while shared claims and input reordering remain stable", () => {
  const value = fixture(); const orphan = clone(value.draft.producerClaims[0]); orphan.producerClaimKey = "orphan"; orphan.name = "unused-producer"; value.draft.producerClaims.push(orphan);
  assert.throws(() => build(value), { code: "STRUCTURAL_RELATION_CLOSURE_MISMATCH" });
  const valid = build(); assert.equal(new Set(valid.document.runs.map((run) => run.producerClaimId)).size, 1);
  const duplicate = clone(valid.document); duplicate.producerClaims.push(clone(duplicate.producerClaims[0])); assert.throws(() => verifyStructuralRelationObservationEnvelope(duplicate), { code: "DUPLICATE_STRUCTURAL_RELATION_OBSERVATION_ID" });
  const canonicalOrphan = clone(valid.document); const orphanPayload = { ...clone(canonicalOrphan.producerClaims[0]), name: "unused-producer" }; delete orphanPayload.producerClaimId; canonicalOrphan.producerClaims.push({ ...orphanPayload, producerClaimId: contentId("structural-producer", orphanPayload) }); canonicalOrphan.producerClaims.sort((a, b) => ascii(a.producerClaimId, b.producerClaimId)); reseal(canonicalOrphan);
  assert.throws(() => verifyStructuralRelationObservationEnvelope(canonicalOrphan), { code: "STRUCTURAL_RELATION_CLOSURE_MISMATCH" });
  assert.throws(() => verifyStructuralRelationObservationEnvelope(canonicalOrphan, { sourceBytesByPath: valid.value.sourceBytesByPath, rawBytesById: verifierRawMap(valid.value, valid.document) }), { code: "STRUCTURAL_RELATION_CLOSURE_MISMATCH" });
  const reordered = fixture(); reordered.draft.sourceManifest.reverse(); reordered.draft.rawRefs.reverse(); reordered.draft.runs.reverse(); assert.deepEqual(build(reordered).document, valid.document);
});

test("R3 fixed-shape preflight rejects callbacks, malformed collections and caps before hashing", () => {
  const callback = fixture(); let callbackInvocations = 0; callback.draft.unapproved = { toJSON() { callbackInvocations += 1; return "x"; } };
  assert.throws(() => build(callback), { code: "UNSUPPORTED_STRUCTURAL_RELATION_OBSERVATION_FIELD" }); assert.equal(callbackInvocations, 0);
  const cases = [
    () => { const value = fixture(); value.draft.diagnosticLabels = {}; return () => build(value); },
    () => { const value = fixture(); value.draft.pairs = Array(1); return () => build(value); },
    () => { const { document } = build(); document.subject.sourceManifest = [null, null]; return () => verifyStructuralRelationObservationEnvelope(document); },
  ];
  for (const make of cases) { let error; try { make()(); } catch (caught) { error = caught; } assert.ok(error); assert.equal(typeof error.code, "string"); }
  for (const { mutate, code } of [
    { mutate: (value) => { value.draft.diagnosticLabels = ["x".repeat(513)]; }, code: "INVALID_STRUCTURAL_RELATION_OBSERVATION_ENVELOPE" },
    { mutate: (value) => { value.draft.pairs = Array(10_001).fill(null); }, code: "STRUCTURAL_RELATION_OBSERVATION_LIMIT" },
    { mutate: (value) => { value.sourceBytesByPath.set("src/caller.ts", new Uint8Array(1_048_577)); }, code: "STRUCTURAL_RELATION_OBSERVATION_LIMIT" },
  ]) {
    const value = fixture(); mutate(value); let hashCalls = 0; const original = crypto.createHash; crypto.createHash = (...args) => { hashCalls += 1; return original(...args); };
    try { assert.throws(() => build(value), { code }); } finally { crypto.createHash = original; }
    assert.equal(hashCalls, 0);
  }
  const boundary = fixture(); const prefix = "export function target() {}\n"; boundary.sourceBytesByPath.set("src/target.ts", enc.encode(prefix + " ".repeat(1_048_576 - Buffer.byteLength(prefix)))); assert.equal(boundary.sourceBytesByPath.get("src/target.ts").byteLength, 1_048_576); const targetDigest = digest(boundary.sourceBytesByPath.get("src/target.ts")); boundary.draft.pairs[0].to.digest = targetDigest; boundary.draft.runs.forEach((run) => { run.coverage.admittedSources.find((entry) => entry.path === "src/target.ts").digest = targetDigest; }); assert.equal(build(boundary).document.subject.sourceManifest.find((entry) => entry.path === "src/target.ts").byteLength, 1_048_576);
});

test("R4 source paths reject drive, URI, slash, backslash and dot forms while raw URI text stays opaque", () => {
  for (const invalidPath of ["C:/repo/caller.ts", "C:relative.ts", "file:repo/caller.ts", "/src/caller.ts", "src\\caller.ts", "src/../caller.ts", "./src/caller.ts"]) {
    const value = fixture(); value.draft.sourceManifest[0].path = invalidPath;
    assert.throws(() => build(value), { code: "INVALID_STRUCTURAL_RELATION_SOURCE_PATH" });
  }
  const valid = build();
  for (const mutate of [
    (document) => { document.pairs[0].from.path = "C:/repo/caller.ts"; },
    (document) => { document.pairs[0].occurrences[0].evidence.path = "file:repo/caller.ts"; },
    (document) => { document.runs[0].coverage.queriedSymbols[0].path = "src\\caller.ts"; },
  ]) { const document = clone(valid.document); mutate(document); assert.throws(() => verifyStructuralRelationObservationEnvelope(document), { code: "INVALID_STRUCTURAL_RELATION_SOURCE_PATH" }); }
  const opaque = fixture(); opaque.rawBytesById.set("raw-a", enc.encode("file:///C:/snapshot/caller.ts")); assert.equal(build(opaque).document.instructionAuthority, false);
});

test("R5 aliases and empty observations are typed unsupported without hiding endpoint defects", () => {
  const alias = fixture(); const aliasSource = "import { target as aliasX } from './target.js';\nexport function caller() {\n  aliasX();\n}\n"; alias.sourceBytesByPath.set("src/caller.ts", enc.encode(aliasSource)); const callerDigest = digest(alias.sourceBytesByPath.get("src/caller.ts")); const pair = alias.draft.pairs[0]; pair.from.digest = callerDigest; pair.from.declarationRange = { start: { line: 1, character: 0 }, end: { line: 3, character: 1 } }; pair.from.selectionRange = range(1, 16, 22); pair.occurrences = [{ occurrenceKey: "alias", evidence: { path: "src/caller.ts", digest: callerDigest, range: range(2, 2, 8) }, supports: [{ runKey: "run-a", rawRefKey: "raw-a" }, { runKey: "run-b", rawRefKey: "raw-b" }] }]; alias.draft.runs.forEach((run) => { run.coverage.admittedSources.find((entry) => entry.path === "src/caller.ts").digest = callerDigest; run.coverage.queriedSymbols[0].digest = callerDigest; run.coverage.queriedSymbols[0].line = 1; });
  assert.throws(() => build(alias), { code: "UNSUPPORTED_STRUCTURAL_RELATION_OBSERVATION_SHAPE" });
  const valid = build(); const aliasDocument = clone(valid.document); const callerDescriptor = aliasDocument.subject.sourceManifest.find((entry) => entry.path === "src/caller.ts"); callerDescriptor.sha256 = callerDigest; callerDescriptor.byteLength = alias.sourceBytesByPath.get("src/caller.ts").byteLength; const aliasPair = aliasDocument.pairs[0]; aliasPair.from.digest = callerDigest; aliasPair.from.declarationRange = clone(pair.from.declarationRange); aliasPair.from.selectionRange = clone(pair.from.selectionRange); aliasPair.occurrences = [clone(valid.document.pairs[0].occurrences[0])]; aliasPair.occurrences[0].evidence.digest = callerDigest; aliasPair.occurrences[0].evidence.range = range(2, 2, 8); aliasDocument.runs.forEach((run) => { run.coverage.admittedSources.find((entry) => entry.path === "src/caller.ts").digest = callerDigest; run.coverage.queriedSymbols[0].digest = callerDigest; run.coverage.queriedSymbols[0].line = 1; }); recomputeLineage(aliasDocument);
  assert.throws(() => verifyStructuralRelationObservationEnvelope(aliasDocument, { sourceBytesByPath: alias.sourceBytesByPath, rawBytesById: verifierRawMap(alias, aliasDocument) }), { code: "UNSUPPORTED_STRUCTURAL_RELATION_OBSERVATION_SHAPE" });
  const emptyDraft = fixture(); emptyDraft.draft.pairs = []; assert.throws(() => build(emptyDraft), { code: "UNSUPPORTED_STRUCTURAL_RELATION_OBSERVATION_SHAPE" });
  const emptyDocument = clone(valid.document); emptyDocument.pairs = []; assert.throws(() => verifyStructuralRelationObservationEnvelope(emptyDocument), { code: "UNSUPPORTED_STRUCTURAL_RELATION_OBSERVATION_SHAPE" });
  const badEndpoint = fixture(); badEndpoint.draft.pairs[0].to.selectionRange = range(0, 16, 21); assert.throws(() => build(badEndpoint), { code: "STRUCTURAL_RELATION_LEXEME_MISMATCH" });
});

test("R3a ordinary-data preflight rejects getters, index accessors, subclasses, and own method overrides before execution", () => {
  const attempts = [
    () => {
      const value = fixture(); let calls = 0; const original = value.draft.projectId;
      Object.defineProperty(value.draft, "projectId", { enumerable: true, configurable: true, get() { calls += 1; return original; } });
      return { invoke: () => build(value), calls: () => calls };
    },
    () => {
      const { document } = build(); let calls = 0; const original = document.subject.projectId;
      Object.defineProperty(document.subject, "projectId", { enumerable: true, configurable: true, get() { calls += 1; return original; } });
      return { invoke: () => verifyStructuralRelationObservationEnvelope(document), calls: () => calls };
    },
    () => {
      const value = fixture(); let calls = 0;
      Object.defineProperty(value.draft.diagnosticLabels, "0", { enumerable: true, configurable: true, get() { calls += 1; return "fixture-only"; } });
      return { invoke: () => build(value), calls: () => calls };
    },
    () => {
      const value = fixture(); let calls = 0; const entries = value.draft.sourceManifest;
      class HostArray extends Array { map(...args) { calls += 1; return super.map(...args); } }
      value.draft.sourceManifest = HostArray.from(entries);
      return { invoke: () => build(value), calls: () => calls };
    },
    () => {
      const { document } = build(); let calls = 0;
      Object.defineProperty(document.diagnosticLabels, "map", { enumerable: false, configurable: true, value(...args) { calls += 1; return Array.prototype.map.apply(this, args); } });
      return { invoke: () => verifyStructuralRelationObservationEnvelope(document), calls: () => calls };
    },
  ];
  for (const make of attempts) {
    const attempt = make(); let hashCalls = 0; const originalHash = crypto.createHash; crypto.createHash = (...args) => { hashCalls += 1; return originalHash(...args); };
    try { assert.throws(attempt.invoke, { code: "INVALID_STRUCTURAL_RELATION_OBSERVATION_ENVELOPE" }); } finally { crypto.createHash = originalHash; }
    assert.equal(attempt.calls(), 0);
    assert.equal(hashCalls, 0);
  }
});

test("R3b final canonical byte budget rejects output overflow before hashing with exact UTF-8 and escape accounting", () => {
  const limit = 8_388_608;
  const baseline = fixture(); baseline.draft.diagnosticLabels = [];
  const baselineDocument = build(baseline).document;
  const baselineBytes = Buffer.byteLength(canonicalJson(baselineDocument), "utf8");

  for (const label of ["x".repeat(512), "é\"\\\n".repeat(128)]) {
    const itemBytes = Buffer.byteLength(JSON.stringify(label), "utf8");
    let insideCount = Math.floor((limit - baselineBytes + 1) / (itemBytes + 1));
    while (baselineBytes + insideCount * (itemBytes + 1) - 1 > limit) insideCount -= 1;
    const insideExpected = baselineBytes + insideCount * (itemBytes + 1) - 1;
    const inside = fixture(); inside.draft.diagnosticLabels = Array(insideCount).fill(label);
    const insideDocument = build(inside).document;
    assert.equal(Buffer.byteLength(canonicalJson(insideDocument), "utf8"), insideExpected);
    assert.ok(insideExpected <= limit);

    const outside = fixture(); outside.draft.diagnosticLabels = Array(insideCount + 1).fill(label);
    assert.ok(Buffer.byteLength(canonicalJson(outside.draft), "utf8") <= limit, "counterexample must fit the draft budget");
    let hashCalls = 0; const originalHash = crypto.createHash; crypto.createHash = (...args) => { hashCalls += 1; return originalHash(...args); };
    let error; try { build(outside); } catch (caught) { error = caught; } finally { crypto.createHash = originalHash; }
    assert.equal(error?.code, "STRUCTURAL_RELATION_OBSERVATION_LIMIT");
    assert.match(error.message, /Canonical envelope exceeds/);
    assert.equal(hashCalls, 0);
  }

  const oversizedDocument = clone(baselineDocument);
  const itemBytes = Buffer.byteLength(JSON.stringify("x".repeat(512)), "utf8");
  const outsideCount = Math.floor((limit - baselineBytes + 1) / (itemBytes + 1)) + 1;
  oversizedDocument.diagnosticLabels = Array(outsideCount).fill("x".repeat(512));
  let hashCalls = 0; const originalHash = crypto.createHash; crypto.createHash = (...args) => { hashCalls += 1; return originalHash(...args); };
  try { assert.throws(() => verifyStructuralRelationObservationEnvelope(oversizedDocument), { code: "STRUCTURAL_RELATION_OBSERVATION_LIMIT" }); } finally { crypto.createHash = originalHash; }
  assert.equal(hashCalls, 0);
});

test("UX ordinary JSON round-trips and frozen data remain accepted without mutable-container requirements", () => {
  const roundTripped = fixture(); roundTripped.draft = JSON.parse(JSON.stringify(roundTripped.draft));
  const roundTrippedDocument = build(roundTripped).document;
  assert.equal(verifyStructuralRelationObservationEnvelope(roundTrippedDocument).verificationReport.structuralContractVerification, "passed");

  const frozen = fixture(); freezeJson(frozen.draft);
  const frozenDocument = build(frozen).document;
  freezeJson(frozenDocument);
  const report = verifyStructuralRelationObservationEnvelope(frozenDocument, { sourceBytesByPath: frozen.sourceBytesByPath, rawBytesById: verifierRawMap(frozen, frozenDocument) }).verificationReport;
  assert.equal(report.finalStrongVerification, true);
  assert.equal(report.claimTruthVerification, "not-supported");
  assert.equal(report.rawSemanticSupportVerification, "not-evaluated");
});

export { fixture, verifierRawMap };

const prepare = (value) => prepareStructuralRelationObservationEnvelope(value.draft, {
  sourceBytesByPath: value.sourceBytesByPath, rawBytesById: value.rawBytesById,
});

function renameKeys(value) {
  const draft = value.draft;
  const claims = new Map(draft.producerClaims.map((entry, index) => [entry.producerClaimKey, `c${index}`.padEnd(128, "c")]));
  const raw = new Map(draft.rawRefs.map((entry, index) => [entry.rawRefKey, `b${index}`.padEnd(128, "b")]));
  const runs = new Map(draft.runs.map((entry, index) => [entry.runKey, `r${index}`.padEnd(128, "r")]));
  for (const entry of draft.producerClaims) entry.producerClaimKey = claims.get(entry.producerClaimKey);
  for (const entry of draft.rawRefs) entry.rawRefKey = raw.get(entry.rawRefKey);
  value.rawBytesById = new Map([...value.rawBytesById].map(([key, bytes]) => [raw.get(key), bytes]));
  for (const run of draft.runs) {
    run.runKey = runs.get(run.runKey); run.producerClaimKey = claims.get(run.producerClaimKey);
    run.rawRefKeys = run.rawRefKeys.map((key) => raw.get(key));
  }
  for (const [index, pair] of draft.pairs.entries()) {
    pair.pairKey = `p${index}`.padEnd(128, "p");
    for (const occurrence of pair.occurrences) {
      occurrence.occurrenceKey = "o".repeat(128); // Repeated labels remain legal.
      for (const support of occurrence.supports) { support.runKey = runs.get(support.runKey); support.rawRefKey = raw.get(support.rawRefKey); }
    }
  }
  return value;
}

function padCanonical(value, targetBytes) {
  value.draft.diagnosticLabels = [];
  const baseBytes = Buffer.byteLength(canonicalJson(build(value).document));
  const delta = targetBytes - baseBytes;
  const count = Math.floor((delta + 1) / 515);
  const labels = Array(count).fill("x".repeat(512));
  let remainder = delta - (count * 515 - 1);
  if (remainder > 0) {
    if (remainder < 4) { labels[count - 1] = "x".repeat(508); remainder += 4; }
    labels.push("x".repeat(remainder - 3));
  }
  value.draft.diagnosticLabels = labels;
}

test("Preparation preserves frozen input, arbitrary bookkeeping names/order and identical raw bytes with different descriptors", () => {
  const original = fixture();
  original.rawBytesById.set("raw-b", original.rawBytesById.get("raw-a"));
  const expected = build(original).document;
  const value = renameKeys(clone(original));
  value.draft.runs.reverse(); value.draft.rawRefs.reverse(); value.draft.sourceManifest.reverse();
  value.draft.pairs[0].occurrences.reverse();
  freezeJson(value.draft);
  const before = clone(value);
  const result = prepare(value);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.envelope, expected);
  assert.equal(result.verificationReport.finalStrongVerification, true);
  assert.equal(result.verificationReport.rawSemanticSupportVerification, "not-evaluated");
  assert.deepEqual(value, before);
});

test("Preparation admits long bookkeeping above draft limit while preserving exact canonical 8 MiB and rejecting +1 before hashing", () => {
  const value = fixture();
  const caller = `export function caller() {\n  ${Array(100).fill("target();").join(" ")}\n}\n`;
  value.sourceBytesByPath.set("src/caller.ts", enc.encode(caller));
  const callerDigest = digest(value.sourceBytesByPath.get("src/caller.ts"));
  value.draft.pairs[0].from.digest = callerDigest;
  for (const run of value.draft.runs) {
    run.coverage.admittedSources.find((entry) => entry.path === "src/caller.ts").digest = callerDigest;
    run.coverage.queriedSymbols[0].digest = callerDigest;
  }
  const supports = value.draft.pairs[0].occurrences[0].supports;
  value.draft.pairs[0].occurrences = Array.from({ length: 100 }, (_, index) => ({
    occurrenceKey: `o${index}`, evidence: { path: "src/caller.ts", digest: callerDigest, range: range(1, 2 + 10 * index, 8 + 10 * index) }, supports: clone(supports),
  }));
  padCanonical(value, 8_388_608);
  const expected = build(value).document;
  assert.equal(Buffer.byteLength(canonicalJson(expected)), 8_388_608);
  renameKeys(value);
  assert.ok(Buffer.byteLength(canonicalJson(value.draft)) > 8_388_608);
  assert.throws(() => build(value), { code: "STRUCTURAL_RELATION_OBSERVATION_LIMIT" });
  const result = prepare(value);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.envelope, expected);
  value.draft.diagnosticLabels[0] = value.draft.diagnosticLabels[0].replace(/^x/, "é");
  let calls = 0; const original = crypto.createHash;
  crypto.createHash = (...args) => { calls++; return original(...args); };
  try { assert.deepEqual(prepare(value), { status: "unavailable", reason: "limit", code: "STRUCTURAL_RELATION_OBSERVATION_LIMIT", stage: "canonical-budget" }); }
  finally { crypto.createHash = original; }
  assert.equal(calls, 0);
});

test("Preparation rejects original reference defects and false claims without rekey repair", () => {
  const changes = [
    (v) => v.draft.producerClaims.push(clone(v.draft.producerClaims[0])),
    (v) => { v.draft.runs[0].producerClaimKey = "missing"; },
    (v) => { v.draft.pairs[0].occurrences[0].supports[0].runKey = "missing"; },
    (v) => v.draft.runs[0].rawRefKeys.push(v.draft.runs[0].rawRefKeys[0]),
    (v) => v.rawBytesById.set("extra", enc.encode("x")),
    (v) => { v.draft.pairs[0].from.digest = "f".repeat(64); },
    (v) => { v.draft.producerClaims[0].analysisMethodClaim.truthStatus = "verified"; },
    (v) => { v.draft.runs[0].coverage.repositoryRelationCompleteness = "complete"; },
    (v) => { v.draft.instructionAuthority = true; },
  ];
  for (const change of changes) {
    const value = fixture(); change(value); const before = clone(value);
    assert.equal(prepare(value).status, "invalid");
    assert.deepEqual(value, before);
  }
});

test("Preparation guards options and collections without invoking callbacks and propagates unexpected errors", () => {
  let calls = 0;
  const getter = () => { calls++; throw new Error("callback executed"); };
  const value = fixture();
  const options = { rawBytesById: value.rawBytesById };
  Object.defineProperty(options, "sourceBytesByPath", { enumerable: true, get: getter });
  assert.equal(prepareStructuralRelationObservationEnvelope(value.draft, options).status, "invalid");
  for (const change of [
    (v) => Object.defineProperty(v.draft, "projectId", { enumerable: true, get: getter }),
    (v) => Object.defineProperty(v.draft.pairs, "0", { enumerable: true, get: getter }),
    (v) => { v.draft.toJSON = getter; },
    (v) => { v.rawBytesById[Symbol.iterator] = getter; },
    (v) => { v.rawBytesById.get = getter; },
  ]) {
    const input = fixture(); change(input); assert.equal(prepare(input).status, "invalid");
  }
  assert.equal(calls, 0);
  const original = crypto.createHash;
  const unexpected = Object.assign(new Error("unexpected implementation error"), { code: "STRUCTURAL_RELATION_OBSERVATION_LIMIT" });
  crypto.createHash = () => { throw unexpected; };
  try { assert.throws(() => prepare(value), (error) => error === unexpected); }
  finally { crypto.createHash = original; }
});

test("Preparation test consumer retains unavailable and invalid outcomes before next independent success", () => {
  const unsupported = fixture(); unsupported.draft.pairs = [];
  const limited = fixture(); limited.rawBytesById.set("raw-a", new Uint8Array(1_048_577));
  const invalid = fixture(); invalid.draft.runs[0].coverage.programCoverage = "complete";
  const results = [fixture(), unsupported, limited, invalid, fixture()].map(prepare);
  assert.deepEqual(results.map((result) => result.status), ["ready", "unavailable", "unavailable", "invalid", "ready"]);
  assert.equal(results[1].reason, "unsupported"); assert.equal(results[2].reason, "limit");
  assert.deepEqual(results[0].envelope, results[4].envelope);
  for (const result of results.slice(1, 4)) assert.equal(Object.hasOwn(result, "envelope"), false);
  for (const result of results) for (const field of ["canContinue", "complete", "retained", "workBlocked"]) assert.equal(Object.hasOwn(result, field), false);
});

test("Preparation uses internal byte view identity and distinguishes invalid backing stores from empty/offset buffers", () => {
  for (const makeInvalid of [
    () => Object.setPrototypeOf(new Uint16Array([0x4241]), Uint8Array.prototype),
    () => { const buffer = new ArrayBuffer(4); const view = new Uint8Array(buffer); structuredClone(buffer, { transfer: [buffer] }); return view; },
    () => { const buffer = new ArrayBuffer(4, { maxByteLength: 8 }); const view = new Uint8Array(buffer, 0, 4); buffer.resize(0); return view; },
  ]) {
    const value = fixture(); value.rawBytesById.set("raw-a", makeInvalid());
    assert.deepEqual(prepare(value), { status: "invalid", code: "INVALID_STRUCTURAL_RELATION_BYTE_MAP", stage: "input" });
  }
  for (const bytes of [new Uint8Array(0), Buffer.alloc(0), Buffer.from([65, 66]), new Uint8Array([0, 65, 66, 0]).subarray(1, 3)]) {
    const value = fixture(); value.rawBytesById.set("raw-a", bytes);
    const expected = build(value).document;
    assert.deepEqual(prepare(value).envelope, expected);
  }
  const value = fixture(); const expected = build(value).document;
  let callbacks = 0;
  for (const bytes of [...value.sourceBytesByPath.values(), ...value.rawBytesById.values()]) {
    for (const key of ["byteLength", "buffer", "length", "slice", Symbol.iterator, Symbol.toStringTag]) {
      Object.defineProperty(bytes, key, { get() { callbacks++; throw new Error("byte getter invoked"); } });
    }
  }
  assert.deepEqual(prepare(value).envelope, expected);
  assert.equal(callbacks, 0);
});

test("Preparation distinguishes malformed values from actual capacity and capability limits without changing strict codes", () => {
  for (const coordinate of [-1, 2.5, "2", NaN, undefined]) {
    const value = fixture(); value.draft.pairs[0].occurrences[0].evidence.range.start.character = coordinate;
    assert.equal(prepare(value).status, "invalid");
    assert.throws(() => build(value), { code: "STRUCTURAL_RELATION_OBSERVATION_LIMIT" });
  }
  for (const change of [
    (v) => { delete v.draft.runs[0].coverage.queriedSymbols[0].line; },
    (v) => { v.draft.pairs[0].occurrences[0].supports = []; },
    (v) => { v.draft.producerClaims = []; },
  ]) { const value = fixture(); change(value); assert.equal(prepare(value).status, "invalid"); }
  for (const pairs of [null, "CALLS", {}, undefined]) {
    const value = fixture(); value.draft.pairs = pairs;
    assert.equal(prepare(value).status, "invalid");
    assert.throws(() => build(value), { code: "UNSUPPORTED_STRUCTURAL_RELATION_OBSERVATION_SHAPE" });
  }
  const empty = fixture(); empty.draft.pairs = [];
  assert.equal(prepare(empty).reason, "unsupported");
  const upper = fixture(); upper.draft.pairs[0].occurrences[0].evidence.range.start.character = 10_000_001;
  assert.equal(prepare(upper).reason, "limit");
});

test("Preparation distinguishes malformed relation discriminators and unserializable fields from unavailable evidence", () => {
  for (const type of [undefined, null, 1, {}, [], true, "", Symbol("CALLS")]) {
    const value = fixture(); value.draft.pairs[0].type = type;
    assert.equal(prepare(value).status, "invalid");
    assert.throws(() => build(value), { code: "UNSUPPORTED_STRUCTURAL_RELATION_OBSERVATION_SHAPE" });
  }
  const unsupported = fixture(); unsupported.draft.pairs[0].type = "IMPORTS";
  assert.equal(prepare(unsupported).reason, "unsupported");
  const unserializable = fixture(); unserializable.draft.diagnosticLabels = undefined;
  assert.equal(prepare(unserializable).status, "invalid");
  assert.throws(() => build(unserializable), { code: "STRUCTURAL_RELATION_OBSERVATION_LIMIT" });
  assert.equal(Object.hasOwn(unserializable.draft, "diagnosticLabels"), true);
  const omitted = fixture(); delete omitted.draft.diagnosticLabels;
  assert.equal(prepare(omitted).status, "ready");
});

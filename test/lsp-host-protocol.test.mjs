import assert from "node:assert/strict";
import test from "node:test";
import {
  LSP_HOST_LIMITS,
  LSP_HOST_REAL_LIMITS,
  LSP_HOST_REASONS,
  LSP_HOST_STAGES,
  LSP_HOST_STATUSES,
  LspFrameParser,
  admittedRealDocumentFromUri,
  boundedFixtureCallRanges,
  boundedFixtureFunctionIdentity,
  boundedFixtureModuleRoute,
  createPendingTable,
  createSnapshotDescriptor,
  encodeLspMessage,
  offsetAtPosition,
  relationSemanticDigest,
  relativePathFromUri,
  serializePinnedTlsWindowsFixtureUri,
  sha256,
  snapshotUri,
  terminalResult,
  validateRange,
  verifyOwnershipBinding,
} from "../scripts/lib/runtime/lsp-host-protocol.mjs";

const generationDigest = sha256("generation");
const sources = [
  { path: "target.ts", text: "export function target() {}" },
  { path: "barrel.ts", text: "export { target } from \"./target\";" },
  { path: "caller.ts", text: "import { target } from \"./barrel\";\nexport function caller(){ target(); }" },
];

test("RQ-V03 pinned Windows fixture URI and finite admission reject aliases", () => {
  const native = "C:\\lode-fixture\\profile\\Documents\\Codex\\fixture-a\\target.ts";
  const pinned = "file:///c%3A/lode-fixture/profile/Documents/Codex/fixture-a/target.ts";
  const nodeClient = "file:///C:/lode-fixture/profile/Documents/Codex/fixture-a/target.ts";
  assert.equal(serializePinnedTlsWindowsFixtureUri(native), pinned);
  const admitted = { relativePath: "target.ts", languageId: "typescript", allowedUris: [pinned, nodeClient] };
  assert.equal(admittedRealDocumentFromUri(pinned, [admitted]), admitted);
  assert.equal(admittedRealDocumentFromUri(nodeClient, [admitted]), admitted);
  for (const invalid of [
    "c:\\lode-fixture\\target.ts", "C:/lode-fixture/target.ts", "C:\\lode-fixture\\two words\\target.ts",
    "C:\\lode-fixture\\한글\\target.ts", "C:\\lode-fixture\\..\\target.ts", "C:\\lode-fixture\\CON\\target.ts",
    "\\\\server\\share\\target.ts", "\\\\?\\C:\\lode-fixture\\target.ts",
  ]) assert.throws(() => serializePinnedTlsWindowsFixtureUri(invalid), { code: "unsupported-profile" });
  for (const alias of [
    "file:///c:/lode-fixture/profile/Documents/Codex/fixture-a/target.ts",
    `${pinned}?query=1`, `${pinned}#fragment`,
    "file://user@/c%3A/lode-fixture/profile/Documents/Codex/fixture-a/target.ts",
    "file:///c%3A/lode-fixture/profile/Documents/Codex/fixture-a/../target.ts",
  ]) assert.throws(() => admittedRealDocumentFromUri(alias, [admitted]), { code: "uri-outside-snapshot" });
  assert.equal(LSP_HOST_REAL_LIMITS.requestTimeoutMs, 10_000);
  assert.equal(LSP_HOST_REAL_LIMITS.totalTimeoutMs, 40_000);
});

test("P03 bounded fixture semantics require a real route and direct unshadowed calls", () => {
  const caller = sources[2].text;
  const identity = boundedFixtureFunctionIdentity(caller, "caller");
  assert.equal(boundedFixtureModuleRoute(caller, sources[1].text), "barrel");
  assert.equal(boundedFixtureCallRanges(caller, identity, "target").length, 1);
  assert.equal(boundedFixtureModuleRoute(`// ${caller}`, sources[1].text), null);
  assert.equal(boundedFixtureModuleRoute(caller, `// ${sources[1].text}`), null);
  const embeddedImport = ["const text = \"prefix" + "\\", "import { target } from './barrel';" + "\\", "\";", "function target() {}", "export function caller(){ target(); }"].join("\n");
  const embeddedExport = ["const text = \"prefix" + "\\", "export { target } from './target';" + "\\", "\";", "export const unrelated = 1;"].join("\n");
  const regexBeforeEmbeddedExport = ["const marker = /\"/;", ...embeddedExport.split("\n"), "// \""].join("\n");
  const embeddedTarget = ["const text = \"prefix" + "\\", "export function target() {}" + "\\", "\";"].join("\n");
  const regexBeforeEmbeddedTarget = ["const marker = /\"/;", ...embeddedTarget.split("\n"), "// \""].join("\n");
  assert.equal(boundedFixtureModuleRoute(embeddedImport, sources[1].text), null);
  assert.equal(boundedFixtureModuleRoute(caller, embeddedExport), null);
  assert.equal(boundedFixtureModuleRoute(caller, regexBeforeEmbeddedExport), null);
  assert.equal(boundedFixtureFunctionIdentity(regexBeforeEmbeddedTarget, "target"), null);
  for (const body of ["const target = () => {}; target();", "const obj = { target() {} }; obj.target();", "function nested(){ target(); }"]) {
    const text = `import { target } from \"./barrel\";\nexport function caller(){ ${body} }`;
    assert.deepEqual(boundedFixtureCallRanges(text, boundedFixtureFunctionIdentity(text, "caller"), "target"), []);
  }
});

test("P07 framing is byte-safe, fragmented, bounded, and fail-closed", () => {
  const message = { jsonrpc: "2.0", id: 1, result: { emoji: "😀" } };
  const bytes = encodeLspMessage(message);
  const parser = new LspFrameParser();
  const observed = [];
  for (const byte of bytes) observed.push(...parser.feed(Buffer.from([byte])));
  parser.end();
  assert.deepEqual(observed, [message]);
  assert.throws(() => new LspFrameParser().feed(Buffer.from("junk\r\n\r\n{}")), { code: "invalid-framing" });
  assert.throws(() => new LspFrameParser().feed(Buffer.from("Content-Length: 1\r\n\r\n{")), { code: "invalid-json" });
  const invalidUtf8 = Buffer.concat([Buffer.from('{"jsonrpc":"2.0","id":1,"result":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  assert.throws(() => new LspFrameParser().feed(Buffer.concat([Buffer.from(`Content-Length: ${invalidUtf8.length}\r\n\r\n`), invalidUtf8])), { code: "invalid-json" });
  const truncatedUtf8 = Buffer.concat([Buffer.from('{"jsonrpc":"2.0","id":1,"result":"'), Buffer.from([0xf0, 0x9f]), Buffer.from('"}')]);
  assert.throws(() => new LspFrameParser().feed(Buffer.concat([Buffer.from(`Content-Length: ${truncatedUtf8.length}\r\n\r\n`), truncatedUtf8])), { code: "invalid-json" });
  assert.throws(() => new LspFrameParser().feed(Buffer.from(`Content-Length: ${LSP_HOST_LIMITS.maxFrameBytes + 1}\r\n\r\n`)), { code: "frame-oversize" });
  const oneFrame = encodeLspMessage({ jsonrpc: "2.0", method: "window/logMessage", params: {} });
  const frameLimited = new LspFrameParser({ ...LSP_HOST_LIMITS, maxFrames: 1 });
  assert.equal(frameLimited.feed(oneFrame).length, 1);
  assert.throws(() => frameLimited.feed(oneFrame), { code: "frame-limit" });
  const incomplete = new LspFrameParser();
  incomplete.feed(Buffer.from("Content-Length: 4\r\n\r\n{}"));
  assert.throws(() => incomplete.end(), { code: "invalid-framing" });
});

test("P07 response correlation rejects unknown, duplicate, and mapping drift", () => {
  const binding = { projectId: "p", generationDigest };
  const pending = createPendingTable(binding);
  const id = pending.issue("initialize");
  assert.equal(pending.consume({ jsonrpc: "2.0", id, result: {} }).method, "initialize");
  assert.throws(() => pending.consume({ jsonrpc: "2.0", id, result: {} }), { code: "duplicate-response-id" });
  assert.throws(() => pending.consume({ jsonrpc: "2.0", id: 91, result: {} }), { code: "unknown-response-id" });
  const changed = createPendingTable(binding);
  const changedId = changed.issue("prepare");
  assert.throws(() => changed.consume({ jsonrpc: "2.0", id: changedId, result: [] }, { ...binding, projectId: "other" }), { code: "mapping-mismatch" });
});

test("P08 every Host ownership field has a distinct fail-closed contamination code", () => {
  const binding = {
    collectionId: "collection",
    projectId: "project",
    generationDigest,
    snapshotManifestDigest: sha256("snapshot"),
    producerDigest: sha256("producer"),
  };
  assert.equal(verifyOwnershipBinding(binding, { ...binding }), true);
  for (const [field, code] of [
    ["collectionId", "mapping-mismatch"],
    ["projectId", "project-mismatch"],
    ["generationDigest", "generation-mismatch"],
    ["snapshotManifestDigest", "manifest-mismatch"],
    ["producerDigest", "producer-mismatch"],
  ]) {
    assert.throws(() => verifyOwnershipBinding(binding, { ...binding, [field]: `${binding[field]}-changed` }), { code });
  }
});

test("P08/P11 snapshot identity, URI admission, CRLF, and UTF-16 ranges are exact", () => {
  const descriptor = createSnapshotDescriptor({ projectId: "project", generationDigest, sources });
  assert.equal(descriptor.documents.length, 4);
  const uri = snapshotUri("collection-1", "caller.ts");
  assert.equal(relativePathFromUri(uri, "collection-1", new Set(["caller.ts"])), "caller.ts");
  assert.throws(() => relativePathFromUri("file:///outside.ts", "collection-1", new Set(["caller.ts"])), { code: "uri-outside-snapshot" });
  assert.throws(() => relativePathFromUri(snapshotUri("collection-2", "caller.ts"), "collection-1", new Set(["caller.ts"])), { code: "uri-outside-snapshot" });
  for (const alias of [
    "head-lsp://collection-1/a/../caller.ts",
    "head-lsp://collection-1/%63aller.ts",
    "head-lsp://user@collection-1/caller.ts",
    "head-lsp://collection-1:123/caller.ts",
  ]) assert.throws(() => relativePathFromUri(alias, "collection-1", new Set(["caller.ts"])), { code: "uri-outside-snapshot" });
  const text = "😀x\r\ny";
  assert.equal(offsetAtPosition(text, { line: 0, character: 2 }), 2);
  assert.deepEqual(validateRange(text, { start: { line: 0, character: 2 }, end: { line: 1, character: 1 } }), { start: 2, end: 6 });
  assert.throws(() => validateRange(text, { start: { line: 3, character: 0 }, end: { line: 3, character: 1 } }), { code: "invalid-range" });
});

test("P12 snapshot and JSON resource bounds reject excess", () => {
  assert.equal(createSnapshotDescriptor({ projectId: "p", generationDigest, sources }).documents.length, 4);
  assert.throws(() => createSnapshotDescriptor({ projectId: "p", generationDigest, sources: [...sources, { path: "extra.ts", text: "export const extra = 1;" }] }), { code: "invalid-input" });
  assert.throws(() => createSnapshotDescriptor({ projectId: "p", generationDigest, sources, profileIdentity: { kind: "unsupported" } }), { code: "invalid-input" });
  assert.throws(() => createSnapshotDescriptor({ projectId: "p", generationDigest, sources: sources.slice(0, 2) }), { code: "invalid-input" });
  assert.throws(() => createSnapshotDescriptor({ projectId: "p", generationDigest, sources: sources.map((item, index) => index === 0 ? { ...item, text: "x".repeat(LSP_HOST_LIMITS.maxDocumentBytes + 1) } : item) }), { code: "invalid-input" });
  assert.throws(() => createSnapshotDescriptor({ projectId: "p", generationDigest, sources: [{ path: "../target.ts", text: "x" }, ...sources.slice(1)] }), { code: "invalid-input" });
  const tooDeep = {};
  let cursor = tooDeep;
  for (let index = 0; index < LSP_HOST_LIMITS.maxJsonDepth + 1; index += 1) cursor = cursor.next = {};
  assert.throws(() => encodeLspMessage(tooDeep), { code: "invalid-message" });
});

test("P10 semantic digest excludes transport identity but preserves callsites", () => {
  const base = {
    projectId: "p",
    generationDigest,
    snapshotManifestDigest: sha256("snapshot"),
    producerDigest: sha256("producer"),
    direction: "outgoing",
    callerPath: "caller.ts",
    callerRange: { start: { line: 1, character: 26 }, end: { line: 1, character: 32 } },
    targetPath: "target.ts",
    targetRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 22 } },
  };
  assert.equal(relationSemanticDigest(base), relationSemanticDigest({ ...base, collectionId: "ignored", requestId: 99, time: Date.now() }));
  assert.notEqual(relationSemanticDigest(base), relationSemanticDigest({ ...base, callerRange: { start: { line: 2, character: 1 }, end: { line: 2, character: 7 } } }));
});

test("P16/P18 closed result vocabulary preserves authority and failure stage", () => {
  for (const status of LSP_HOST_STATUSES) {
    const reason = status === "not-configured" ? "no-profile" : status === "unsupported" ? "unsupported-profile" : status === "completed" ? "empty" : status === "contaminated" ? "mapping-mismatch" : "invalid-input";
    const result = terminalResult({ status, reason, stage: "closed", failureStage: status === "completed" ? null : "prepare" });
    assert.equal(result.realSupport, false);
    assert.equal(result.relationQuality, "unknown");
    assert.deepEqual(result.realGate, { id: "A03", status: "not-run", reason: "no-reviewed-pinned-real-profile-and-isolation" });
    assert.equal(result.e1bEligible, false);
    assert.equal(result.authority, "ephemeral-host-evidence-only");
    assert.equal(result.failureStage, status === "completed" ? null : "prepare");
  }
  for (const reason of LSP_HOST_REASONS) assert.ok(typeof terminalResult({ status: reason === "candidates" || reason === "empty" || reason === "no-prepared-item" ? "completed" : "failed", reason, stage: LSP_HOST_STAGES.at(-1) }).reason === "string");
  assert.throws(() => terminalResult({ status: "invented", reason: "empty", stage: "closed" }), { code: "invalid-input" });
});

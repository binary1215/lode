import { withSnapshotReferences, withSnapshotReferencesAsync } from "./snapshot-reference-lifetime.mjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { atomicCreateArtifact } from "./artifact-storage.mjs";
import { formatForVerifiedOwner, assertProjectStorageUnchanged } from "./project-storage-format.mjs";
import { safeSnapshotPath, SNAPSHOT_STORAGE_LIMITS } from "./snapshot-storage-codec.mjs";
const producer = Object.freeze({ name: "lode-domain-bundle", version: "0.1.0" });
export const DOMAIN_BUNDLE_LAYOUT = "domain-bundles-v1";
const hash = b => crypto.createHash("sha256").update(b).digest("hex");
const bytes = value => Buffer.from(JSON.stringify(value) + "\n");
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const fail = (code, message = code) => { throw Object.assign(new Error(message), { code }); };
const codeKinds = new Set(["File", "FileRevision", "Symbol", "SymbolRevision", "Test", "TestRevision"]);
const equal = (a,b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function encode(raw, encoding) {
  if (encoding === "gzip") return zlib.gzipSync(raw);
  if (encoding === "zstd" && typeof zlib.zstdCompressSync === "function") return zlib.zstdCompressSync(raw);
  fail("SNAPSHOT_BUNDLE_CODEC_UNAVAILABLE");
}
function bundleDirectory(root, storage) { return path.join(root, formatForVerifiedOwner(storage).directory, "snapshot-bundles"); }
function put(context, domain, payload) {
  const document = { kind: "SnapshotDomainBundle", schemaVersion: 1, projectId: context.storage.projectId, domain, producer, payload };
  const raw = bytes(canonical(document));
  context.metrics.serializationCount++; context.metrics.serializedBytes += raw.length;
  context.metrics.hashCount++; context.metrics.hashedBytes += raw.length;
  if (raw.length > SNAPSHOT_STORAGE_LIMITS.decodedBytes) fail("SNAPSHOT_STORAGE_LIMIT");
  const sha256 = hash(raw), suffix = context.encoding === "zstd" ? ".json.zst" : ".json.gz";
  const file = safeSnapshotPath(context.root, path.join(bundleDirectory(context.root, context.storage), sha256 + suffix));
  const ref = { kind: document.kind, schemaVersion: 1, projectId: document.projectId, domain, producer,
    sha256, byteLength: raw.length, encoding: context.encoding, address: path.relative(context.root, file).replaceAll("\\", "/") };
  assertProjectStorageUnchanged(context.storage);
  if (!fs.existsSync(file)) {
    const encoded = encode(raw, context.encoding);
    if (encoded.length > SNAPSHOT_STORAGE_LIMITS.compressedBytes) fail("SNAPSHOT_STORAGE_LIMIT");
    try { atomicCreateArtifact(file, encoded); context.metrics.createdBytes += encoded.length; context.metrics.createdBundles++; }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  // Existing bytes are verified before reuse. No mtime/size-only equivalence.
  readBundle(context, ref, 1);
  context.metrics.bundleReferences++;
  return ref;
}
function readBundle(context, ref, depth) {
  if (!ref || ref.kind !== "SnapshotDomainBundle" || ref.schemaVersion !== 1 || ref.projectId !== context.storage.projectId
    || !equal(ref.producer, producer) || !/^[a-f0-9]{64}$/.test(ref.sha256 || "")
    || !Number.isSafeInteger(ref.byteLength) || ref.byteLength < 1 || ref.byteLength > SNAPSHOT_STORAGE_LIMITS.decodedBytes
    || !["gzip", "zstd"].includes(ref.encoding) || depth > 3) fail("INVALID_SNAPSHOT_BUNDLE_REFERENCE");
  const suffix = ref.encoding === "zstd" ? ".json.zst" : ".json.gz";
  const expected = path.relative(context.root, path.join(bundleDirectory(context.root, context.storage), ref.sha256 + suffix)).replaceAll("\\", "/");
  if (ref.address !== expected) fail("INVALID_SNAPSHOT_BUNDLE_ADDRESS");
  const key = JSON.stringify(ref);
  if (context.active.has(ref.sha256)) fail("SNAPSHOT_BUNDLE_CYCLE");
  if (context.cache.has(key)) return context.cache.get(key);
  if (++context.metrics.verifiedBundles > 8) fail("SNAPSHOT_BUNDLE_COUNT_LIMIT");
  context.metrics.decodedBytes += ref.byteLength;
  if (context.metrics.decodedBytes > SNAPSHOT_STORAGE_LIMITS.decodedBytes) fail("SNAPSHOT_STORAGE_LIMIT");
  const file = safeSnapshotPath(context.root, path.join(context.root, ref.address));
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.isSymbolicLink() || stat.size > SNAPSHOT_STORAGE_LIMITS.compressedBytes) fail("UNSAFE_SNAPSHOT_PATH");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let encoded;
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size || opened.nlink !== 1) fail("SNAPSHOT_STORAGE_DRIFT");
    encoded = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (encoded.length !== stat.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) fail("SNAPSHOT_STORAGE_DRIFT");
  } finally { fs.closeSync(fd); }
  let raw;
  try {
    if (ref.encoding === "gzip") raw = zlib.gunzipSync(encoded, { maxOutputLength: ref.byteLength });
    else if (typeof zlib.zstdDecompressSync === "function") raw = zlib.zstdDecompressSync(encoded, { maxOutputLength: ref.byteLength });
    else fail("SNAPSHOT_BUNDLE_CODEC_UNAVAILABLE");
  } catch (error) { if (error.code === "SNAPSHOT_BUNDLE_CODEC_UNAVAILABLE") throw error; fail("INVALID_SNAPSHOT_BUNDLE_ENCODING"); }
  context.metrics.hashCount++; context.metrics.hashedBytes += raw.length;
  if (raw.length !== ref.byteLength || hash(raw) !== ref.sha256) fail("SNAPSHOT_BUNDLE_DIGEST_MISMATCH");
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  if (value.kind !== ref.kind || value.schemaVersion !== ref.schemaVersion || value.projectId !== ref.projectId
    || value.domain !== ref.domain || !equal(value.producer, ref.producer)) fail("SNAPSHOT_BUNDLE_TYPE_MISMATCH");
  context.cache.set(key, value.payload);
  return value.payload;
}
function contextFor(root, storage, encoding = "gzip") {
  if (!storage?.projectId || fs.realpathSync(root) !== storage.projectRoot) fail("SNAPSHOT_BUNDLE_OWNER_REQUIRED");
  assertProjectStorageUnchanged(storage);
  return { root, storage, encoding, cache: new Map(), active: new Set(), metrics: { createdBytes: 0, createdBundles: 0, bundleReferences: 0, verifiedBundles: 0, decodedBytes: 0, serializationCount: 0, serializedBytes: 0, hashCount: 0, hashedBytes: 0 } };
}
function splitGraph(context, graph) {
  const codeIds = new Set(graph.nodes.filter(node => codeKinds.has(node.kind)).map(node => node.nodeId));
  const normalize = record => {
    const body = { ...record }, sourceBound = body.sourceSnapshotId === graph.sourceSnapshotId;
    if (sourceBound) delete body.sourceSnapshotId;
    return { sourceBound, body };
  };
  const codeNodes = [], codeEdges = [], otherNodes = [], otherEdges = [], nodeOrder = [], edgeOrder = [];
  for (const node of graph.nodes) { const code = codeIds.has(node.nodeId); nodeOrder.push(code); (code ? codeNodes : otherNodes).push(code ? normalize(node) : node); }
  for (const edge of graph.edges) { const code = codeIds.has(edge.from) && codeIds.has(edge.to); edgeOrder.push(code); (code ? codeEdges : otherEdges).push(code ? normalize(edge) : edge); }
  const code = put(context, "graph-code", { nodes: codeNodes, edges: codeEdges });
  return put(context, "graph-composition", { body: { ...graph, nodes: null, edges: null }, code, otherNodes, otherEdges, nodeOrder, edgeOrder });
}
function joinGraph(context, ref, depth) {
  if (ref.domain !== "graph-composition") fail("SNAPSHOT_BUNDLE_TYPE_MISMATCH");
  const composition = readBundle(context, ref, depth);
  context.active.add(ref.sha256);
  try {
    const codeRef = composition.code;
    if (codeRef.domain !== "graph-code") fail("SNAPSHOT_BUNDLE_TYPE_MISMATCH");
    const code = readBundle(context, codeRef, depth + 1);
    const restore = record => record.sourceBound ? { ...record.body, sourceSnapshotId: composition.body.sourceSnapshotId } : record.body;
    function merge(order, originals, codeRecords) {
      if (!Array.isArray(order) || order.some(flag => typeof flag !== "boolean")) fail("INVALID_SNAPSHOT_BUNDLE_SHAPE");
      let i=0,j=0; const result=order.map(flag => flag ? restore(codeRecords[i++]) : originals[j++]);
      if (i !== codeRecords.length || j !== originals.length) fail("INVALID_SNAPSHOT_BUNDLE_SHAPE");
      return result;
    }
    return { ...composition.body, nodes: merge(composition.nodeOrder, composition.otherNodes, code.nodes), edges: merge(composition.edgeOrder, composition.otherEdges, code.edges) };
  } finally { context.active.delete(ref.sha256); }
}
function createSnapshotCompositionUncoordinated({ root, storage, document, encoding = "gzip" }) {
  const context = contextFor(root, storage, encoding), world = document.kind === "RepositoryWorldModel" || Boolean(document.worldModelId);
  const body = { ...document };
  const graph = world ? document.temporalProvenanceGraph : document;
  if (!graph || graph.kind !== "GraphSnapshot" || graph.projectId !== storage.projectId || document.projectId !== storage.projectId) fail("INVALID_SNAPSHOT_BUNDLE_INPUT");
  const graphRef = splitGraph(context, graph);
  let code = null;
  if (world) {
    code = put(context, "world-code", { files: document.files, semanticGraph: document.semanticGraph,
      analysisBasis: document.analysisBasis, domainBasis: document.domainBases?.code, rules: document.rules,
      sourceScope: document.repositoryScan?.sourceScope });
    body.files = null; body.semanticGraph = null; body.temporalProvenanceGraph = null;
  }
  const snapshotId = document.worldModelId || document.graphSnapshotId;
  const reconstructed = bytes(canonical(document));
  context.metrics.serializationCount++; context.metrics.serializedBytes += reconstructed.length;
  context.metrics.hashCount++; context.metrics.hashedBytes += reconstructed.length;
  return { document: { kind: "SnapshotComposition", schemaVersion: 1, producer, projectId: storage.projectId,
    [world ? "worldModelId" : "graphSnapshotId"]: snapshotId, snapshotKind: world ? "world-model" : "graph-snapshot",
    reconstructedByteLength: reconstructed.length, reconstructedSha256: hash(reconstructed),
    body: world ? body : null, code, graph: graphRef }, metrics: context.metrics };
}
export function hydrateSnapshotComposition({ root, storage, document }) {
  if (document?.kind !== "SnapshotComposition") return { document, dependencies: [], metrics: null };
  const context = contextFor(root, storage);
  if (document.schemaVersion !== 1 || document.projectId !== storage.projectId || !equal(document.producer, producer)
    || !["world-model", "graph-snapshot"].includes(document.snapshotKind)
    || !Number.isSafeInteger(document.reconstructedByteLength) || document.reconstructedByteLength < 1
    || document.reconstructedByteLength > SNAPSHOT_STORAGE_LIMITS.decodedBytes
    || !/^[a-f0-9]{64}$/.test(document.reconstructedSha256 || "")) fail("INVALID_SNAPSHOT_COMPOSITION");
  const representationBytes = Buffer.byteLength(JSON.stringify(document), "utf8") + 1;
  context.metrics.serializationCount++; context.metrics.serializedBytes += representationBytes;
  context.metrics.decodedBytes += representationBytes;
  if (context.metrics.decodedBytes > SNAPSHOT_STORAGE_LIMITS.decodedBytes) fail("SNAPSHOT_STORAGE_LIMIT");
  const graph = joinGraph(context, document.graph, 1);
  let result = graph;
  if (document.snapshotKind === "world-model") {
    if (document.code?.domain !== "world-code") fail("SNAPSHOT_BUNDLE_TYPE_MISMATCH");
    const code = readBundle(context, document.code, 1);
    if (!equal(code.analysisBasis, document.body.analysisBasis) || code.domainBasis !== document.body.domainBases?.code
      || !equal(code.rules, document.body.rules) || !equal(code.sourceScope, document.body.repositoryScan?.sourceScope)) fail("SNAPSHOT_BUNDLE_BASIS_MISMATCH");
    result = { ...document.body, files: code.files, semanticGraph: code.semanticGraph, temporalProvenanceGraph: graph };
  }
  const raw = bytes(canonical(result));
  context.metrics.serializationCount++; context.metrics.serializedBytes += raw.length;
  context.metrics.hashCount++; context.metrics.hashedBytes += raw.length;
  if (raw.length !== document.reconstructedByteLength || hash(raw) !== document.reconstructedSha256
    || result.projectId !== document.projectId || (result.worldModelId || result.graphSnapshotId) !== (document.worldModelId || document.graphSnapshotId)) fail("SNAPSHOT_COMPOSITION_DIGEST_MISMATCH");
  assertProjectStorageUnchanged(storage);
  return { document: result, dependencies: [...context.cache.keys()].map(key => JSON.parse(key)), metrics: context.metrics };
}
export function hydrateSnapshotEntry({ root, storage, entry }) {
  if (!entry || entry.document?.kind !== "SnapshotComposition") return entry;
  const hydrated = hydrateSnapshotComposition({ root, storage, document: entry.document });
  return { ...entry, document: hydrated.document, snapshotStorage: { ...(entry.snapshotStorage || { kind: "local-file" }),
    layout: DOMAIN_BUNDLE_LAYOUT, reconstructedSha256: entry.document.reconstructedSha256, dependencies: hydrated.dependencies } };
}

export function createSnapshotComposition(options = {}, ...rest) {
  return withSnapshotReferences({ root: options.root ?? ".", storage: options.storage }, () => createSnapshotCompositionUncoordinated(options, ...rest));
}

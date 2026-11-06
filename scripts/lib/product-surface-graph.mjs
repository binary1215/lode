import { createObservationTypeDescriptor, observationDigest } from "./observation-contract.mjs";
import { readSourceBytes, sourceDigest } from "./python-source-collector.mjs";

export const SURFACE_ENTITY_KINDS = Object.freeze([
  "UserActivity", "ProductSurface", "SurfaceElement", "ExecutionEntrypoint", "DataResource", "ExternalConnection",
]);
const basisKinds = new Set(["authored", "inferred", "declared", "runtime-recorded", "unknown"]);
const domains = Object.freeze({
  ACTIVITY_USES_ELEMENT: [["UserActivity"], ["SurfaceElement"]],
  SURFACE_CONTAINS_ELEMENT: [["ProductSurface", "SurfaceElement"], ["SurfaceElement"]],
  ELEMENT_INVOKES_ENTRYPOINT: [["SurfaceElement"], ["ExecutionEntrypoint"]],
  ENTRYPOINT_RETURNS_ELEMENT: [["ExecutionEntrypoint"], ["SurfaceElement"]],
  ACTIVITY_NEXT: [["UserActivity"], ["UserActivity"]],
  READS_DATA: [["ExecutionEntrypoint"], ["DataResource"]],
  WRITES_DATA: [["ExecutionEntrypoint"], ["DataResource"]],
  CALLS_EXTERNAL: [["ExecutionEntrypoint"], ["ExternalConnection"]],
  COMPARES_RECORDED_OUTPUT: [["SurfaceElement", "ProductSurface"], ["SurfaceElement", "ProductSurface"]],
});
const entityColumns = {
  keys: ["string", 192], kinds: ["string", 64], names: ["string", 512], bases: ["string", 32],
  paths: ["string", 512], sourceDigests: ["string", 64],
  startLines: ["nonnegative-integer"], endLines: ["nonnegative-integer"], excerpts: ["string", 2048],
  surfaceKinds: ["string", 64], codePaths: ["string", 512], codeDigests: ["string", 64],
  codeSymbols: ["string", 512], codeLines: ["nonnegative-integer"],
};
const relationColumns = {
  keys: ["string", 192], types: ["string", 64],
  fromObservationIds: ["string", 96], fromObservationHashes: ["string", 64], fromKeys: ["string", 192],
  toObservationIds: ["string", 96], toObservationHashes: ["string", 64], toKeys: ["string", 192],
  bases: ["string", 32], paths: ["string", 512], sourceDigests: ["string", 64],
  startLines: ["nonnegative-integer"], endLines: ["nonnegative-integer"], excerpts: ["string", 2048],
};
export function productSurfaceProfile(kind = "entities") {
  if (!["entities", "relations"].includes(kind)) throw new Error("Unknown surface profile.");
  const columns = kind === "entities" ? entityColumns : relationColumns;
  return { typeKey: "lode.product-surface." + kind, typeVersion: "1.0.0", forms: ["snapshot"],
    payloadSchema: { additionalFields: false, fields: [
      { key: "mapKey", type: "stable-key", required: true },
      { key: "mapRevision", type: "sha256", required: true },
      { key: "mapBasisPaths", type: "array", itemsType: "string", min: 1, max: 512, maxItems: 1024, required: true },
      { key: "mapBasisDigests", type: "array", itemsType: "sha256", maxItems: 1024, required: true },
      { key: "batchIndex", type: "nonnegative-integer", min: 0, max: 4095, required: true },
      { key: "batchCount", type: "nonnegative-integer", min: 0, max: 4096, required: true },
      ...Object.entries(columns).map(([key, [itemsType, max]]) => ({
        key, type: "array", itemsType, maxItems: 1024, required: true, ...(max ? { min: 0, max } : {}),
      })),
    ] } };
}
const sha = value => /^[a-f0-9]{64}$/.test(value || "");
const keyValid = value => typeof value === "string" && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value);
const id = payload => "surface-fact-" + observationDigest(payload).slice(0, 24);
const noAuthority = { instructionAuthority: false, promotionAuthority: false,
  recoveryAuthority: false, executionAuthority: false, ordinaryWorkBlocked: false };
function reference(payload, i) {
  return { path: payload.paths[i], digest: payload.sourceDigests[i],
    startLine: payload.startLines[i], endLine: payload.endLines[i] };
}
function pathValid(value) {
  return typeof value === "string" && value && !/[\\:\x00-\x1f\x7f]/.test(value)
    && !value.startsWith("/") && value.split("/").every(part => part && part !== "." && part !== "..");
}
export function productSurfaceMapRevision(projectId, mapKey, paths, digests) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 1024 || !Array.isArray(digests)
    || paths.length !== digests.length || paths.some(path => !pathValid(path)) || digests.some(digest => !sha(digest))) {
    throw Object.assign(new Error("Map basis invalid."), { code: "INVALID_SURFACE_MAP_BASIS" });
  }
  const sources = paths.map((path, i) => ({ path, digest: digests[i] }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0);
  if (new Set(sources.map(value => JSON.stringify(value))).size !== sources.length) {
    throw Object.assign(new Error("Duplicate map basis."), { code: "INVALID_SURFACE_MAP_BASIS" });
  }
  return observationDigest({ projectId, mapKey, sources });
}
function rowsFor(record, columns) {
  const p = record.payload, size = p?.keys?.length;
  if (p.mapRevision !== productSurfaceMapRevision(record.projectId, p.mapKey, p.mapBasisPaths, p.mapBasisDigests)) {
    throw Object.assign(new Error("Map revision does not bind declared sources."), { code: "SURFACE_MAP_REVISION_MISMATCH" });
  }
  if (p.batchCount && p.batchIndex >= p.batchCount) {
    throw Object.assign(new Error("Batch range invalid."), { code: "INVALID_SURFACE_BATCH_RANGE" });
  }
  if (!Number.isInteger(size) || size > 1024 || Object.keys(columns).some(key => !Array.isArray(p[key]) || p[key].length !== size)
    || new Set(p.keys).size !== size || p.keys.some(key => !keyValid(key))) {
    throw Object.assign(new Error("Surface batch columns/keys are invalid."), { code: "INVALID_SURFACE_BATCH" });
  }
  for (let i = 0; i < size; i++) {
    if (!basisKinds.has(p.bases[i]) || !pathValid(p.paths[i]) || !sha(p.sourceDigests[i])
      || p.startLines[i] < 1 || p.endLines[i] < p.startLines[i] || p.endLines[i] - p.startLines[i] > 512) {
      throw Object.assign(new Error("Surface evidence reference is invalid."), { code: "INVALID_SURFACE_REFERENCE" });
    }
  }
  const basis = new Set(p.mapBasisPaths.map((path, i) => JSON.stringify([path, p.mapBasisDigests[i]])));
  for (let i = 0; i < size; i++) {
    if (!basis.has(JSON.stringify([p.paths[i], p.sourceDigests[i]]))
      || columns === entityColumns && p.codePaths[i] && !basis.has(JSON.stringify([p.codePaths[i], p.codeDigests[i]]))) {
      throw Object.assign(new Error("Row source is outside map basis."), { code: "SURFACE_ROW_OUTSIDE_MAP_BASIS" });
    }
  }
  return size;
}
// Called only with originals already verified by the existing observation store.
// Exact descriptor identity is required; a spoofed type key adds no semantics.
export function projectProductSurfaceFacts({ projectId, storage, artifacts, origins }) {
  const nodes = [], edges = [], sources = [], issues = [], entities = new Map(), supported = [];
  const addIssue = (subject, reasonCode) => issues.push({ subject, reasonCode });
  const descriptors = new Map(artifacts.descriptors.map(item => [item.descriptorId, item]));
  for (const record of artifacts.observations) {
    if (!record.typeKey.startsWith("lode.product-surface.")) continue;
    const kind = record.typeKey.slice("lode.product-surface.".length);
    if (!["entities", "relations"].includes(kind)) { addIssue(record.observationId, "UNSUPPORTED_SURFACE_PROFILE"); continue; }
    const descriptor = descriptors.get(record.descriptorId);
    const expected = createObservationTypeDescriptor(productSurfaceProfile(kind), storage);
    if (descriptor?.descriptorHash !== expected.descriptorHash || record.descriptorHash !== expected.descriptorHash) {
      addIssue(record.observationId, "UNSUPPORTED_SURFACE_PROFILE"); continue;
    }
    try { supported.push({ record, kind, count: rowsFor(record, kind === "entities" ? entityColumns : relationColumns) }); }
    catch (error) { addIssue(record.observationId, error.code || "INVALID_SURFACE_BATCH"); }
  }
  const batchGroups = new Map();
  for (const { record, kind } of supported) {
    const p = record.payload, key = JSON.stringify([p.mapKey, p.mapRevision, kind]);
    if (!batchGroups.has(key)) batchGroups.set(key, []);
    batchGroups.get(key).push(record);
  }
  const batches = [...batchGroups.values()].map(records => {
    const p = records[0].payload, indices = new Set(records.map(r => r.payload.batchIndex));
    const counts = new Set(records.map(r => r.payload.batchCount));
    const state = !p.batchCount ? "open-batch-set"
      : counts.size !== 1 || indices.size !== records.length ? "ambiguous-batch-set"
        : indices.size === p.batchCount ? "declared-batches-present" : "incomplete-batch-set";
    return { mapKey: p.mapKey, mapRevision: p.mapRevision, typeKey: records[0].typeKey, state,
      loadedBatches: records.length, declaredBatchCount: p.batchCount,
      missingCount: p.batchCount ? Math.max(0, p.batchCount - indices.size) : null };
  });
  for (const { record, kind, count } of supported) if (kind === "entities") {
    const p = record.payload, origin = origins.get(record.observationId);
    if (record.projectId !== projectId || !origin) { addIssue(record.observationId, "SURFACE_PROJECT_OR_ORIGINAL_MISMATCH"); continue; }
    for (let i = 0; i < count; i++) {
      if (!SURFACE_ENTITY_KINDS.includes(p.kinds[i]) || !p.names[i]?.trim()
        || p.codePaths[i] && (!pathValid(p.codePaths[i]) || !sha(p.codeDigests[i]))) {
        addIssue(record.observationId + ":" + p.keys[i], "INVALID_SURFACE_ENTITY"); continue;
      }
      const nodeId = id({ projectId, mapKey: p.mapKey, mapRevision: p.mapRevision,
        observationId: record.observationId, observationHash: record.observationHash, key: p.keys[i] });
      const claimReference = reference(p, i);
      const node = {
        nodeId, kind: p.kinds[i], name: p.names[i], key: p.keys[i], projectId, revisionId: record.observationId,
        mapKey: p.mapKey, mapRevision: p.mapRevision, claimBasis: p.bases[i], surfaceKind: p.surfaceKinds[i], statement: p.excerpts[i],
        observationId: record.observationId, observationHash: record.observationHash, claimReference,
        executionSource: p.codePaths[i] ? {
          path: p.codePaths[i], digest: p.codeDigests[i], symbol: p.codeSymbols[i], line: p.codeLines[i],
        } : null,
        origin: { ...origin, layer: "product-surface" }, views: ["product", "work"],
        reviewState: "non-canonical-source-claim", integrity: "verified",
        claimEvidence: { state: "not-inspected", meaning: "Record integrity proves the retained claim, not execution, accepted meaning or freshness." },
        freshness: "retained-evidence",
        sourceReference: { artifactId: record.observationId, path: origin.path, digest: origin.digest, entityKey: p.keys[i] },
        ...noAuthority,
      };
      nodes.push(node);
      entities.set(record.observationId + "\0" + p.keys[i], node);
      sources.push({ path: claimReference.path, digest: claimReference.digest, nodeId, origin });
      edges.push({ edgeId: id({ projectId, from: nodeId, to: record.observationId, type: "SURFACE_FACT_FROM_OBSERVATION" }),
        type: "SURFACE_FACT_FROM_OBSERVATION", from: nodeId, to: record.observationId, provenance: origin, ...noAuthority });
    }
  }
  for (const { record, kind, count } of supported) if (kind === "relations") {
    const p = record.payload, origin = origins.get(record.observationId);
    if (record.projectId !== projectId || !origin) continue;
    for (let i = 0; i < count; i++) {
      const from = entities.get(p.fromObservationIds[i] + "\0" + p.fromKeys[i]);
      const to = entities.get(p.toObservationIds[i] + "\0" + p.toKeys[i]);
      if (!from || !to) { addIssue(record.observationId + ":" + p.keys[i], "SURFACE_ENDPOINT_UNAVAILABLE"); continue; }
      if (from.observationHash !== p.fromObservationHashes[i] || to.observationHash !== p.toObservationHashes[i]
        || [from, to].some(node => node.projectId !== projectId || node.mapKey !== p.mapKey || node.mapRevision !== p.mapRevision)) {
        addIssue(record.observationId + ":" + p.keys[i], "SURFACE_ENDPOINT_BASIS_MISMATCH"); continue;
      }
      const rule = domains[p.types[i]];
      if (!rule || !rule[0].includes(from.kind) || !rule[1].includes(to.kind)) {
        addIssue(record.observationId + ":" + p.keys[i], "SURFACE_RELATION_DOMAIN_RANGE"); continue;
      }
      const added = {
        edgeId: id({ projectId, observationId: record.observationId, observationHash: record.observationHash,
          key: p.keys[i], from: from.nodeId, to: to.nodeId, type: p.types[i] }),
        type: p.types[i], from: from.nodeId, to: to.nodeId,
        claimBasis: p.bases[i], statement: p.excerpts[i], claimReference: reference(p, i),
        provenance: { ...origin, layer: "product-surface", observationId: record.observationId, observationHash: record.observationHash },
        interpretation: "Explicit source-backed relation claim; not causal, execution or policy proof.", ...noAuthority,
      };
      edges.push(added);
      if (p.types[i] === "COMPARES_RECORDED_OUTPUT") added.recordedTextComparison = {
        state: from.statement === to.statement ? "recorded-texts-equal" : "recorded-texts-differ",
        sourceVerification: "not-inspected", semanticAgreement: false, runtimeBehaviorProven: false,
      };
      sources.push({ path: p.paths[i], digest: p.sourceDigests[i], nodeId: added.edgeId, origin });
    }
  }
  return { nodes, edges, sources, issues, coverage: {
    state: "declared-evidence-only", batches, entityCount: nodes.length,
    relationCount: edges.filter(edge => edge.type !== "SURFACE_FACT_FROM_OBSERVATION").length,
    issueCount: issues.length, issues: issues.slice(0, 64), omittedIssues: Math.max(0, issues.length - 64),
    unmappedMeaning: "Missing mapping is unknown coverage, not dead code.", runtimeVerified: false, canonPromoted: false,
  } };
}
export function bindSurfaceExecutionSources({ projectId, nodes, relation }) {
  const added = [], edges = [], sources = [];
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  const files = new Map(), structural = new Map(), temporal = new Map(), fallback = new Map();
  const key = (...parts) => JSON.stringify(parts);
  function index(map, address, node) {
    if (!map.has(address)) map.set(address, { nodes: [], ids: new Set() });
    const entry = map.get(address);
    if (!entry.ids.has(node.nodeId)) { entry.ids.add(node.nodeId); entry.nodes.push(node); }
  }
  for (const node of nodes) {
    if (["FileRevision", "FileRevisionReference"].includes(node.kind) && node.path && node.digest) {
      index(files, key(node.path, node.digest), node);
    }
    if (node.kind === "SymbolRevisionReference" && node.origin?.layer === "surface-code" && node.identityAmbiguous !== true) {
      index(structural, key(node.path, node.digest, node.name), node);
      index(structural, key(node.path, node.digest, node.name, node.line), node);
    }
    if (node.kind === "SymbolRevision") {
      const file = byId.get(node.fileRevisionId);
      if (file?.kind === "FileRevision" && file.path === node.path) {
        index(temporal, key(node.path, file.digest, node.name), node);
        index(temporal, key(node.path, file.digest, node.name, node.line), node);
      }
    }
  }
  for (const node of nodes) {
    if (node.origin?.layer !== "product-surface" || !node.executionSource) continue;
    const ref = node.executionSource;
    const fileKey = key(ref.path, ref.digest);
    let target = null;
    if (ref.symbol) {
      const symbolKey = ref.line ? key(ref.path, ref.digest, ref.symbol, ref.line) : key(ref.path, ref.digest, ref.symbol);
      const parsed = structural.get(symbolKey)?.nodes || [];
      const retained = temporal.get(symbolKey)?.nodes || [];
      if (parsed.length === 1) target = parsed[0];
      else if (parsed.length === 0 && retained.length === 1) target = retained[0];
    }
    const fileCandidates = files.get(fileKey)?.nodes || [];
    if (!target && fileCandidates.length === 1) target = fileCandidates[0];
    if (!target) {
      if (!fallback.has(fileKey)) {
        const nodeId = "surface-source-" + observationDigest({ projectId, path: ref.path, digest: ref.digest }).slice(0, 24);
        const sourceNode = {
          nodeId, kind: "FileRevisionReference", projectId, path: ref.path, digest: ref.digest, revisionId: nodeId,
          sourceReference: { path: ref.path, digest: ref.digest }, origin: { layer: "product-surface-source" },
          views: ["work", "product"], integrity: "verified-reference", freshness: "unavailable", reviewState: "source-reference-only", ...noAuthority,
        };
        fallback.set(fileKey, sourceNode);
        added.push(sourceNode);
        sources.push({ path: ref.path, digest: ref.digest, nodeId, origin: node.origin });
      }
      target = fallback.get(fileKey);
    }
    const exactSymbol = ["SymbolRevision", "SymbolRevisionReference"].includes(target.kind);
    node.executionBinding = {
      state: exactSymbol ? "exact-symbol-in-retained-world" : "file-reference-only",
      nodeId: target.nodeId, requestedSymbol: ref.symbol || null,
    };
    edges.push(relation(exactSymbol ? "HANDLED_BY_EXACT_SOURCE" : "CITES_EXECUTION_SOURCE", node.nodeId, target.nodeId, node.origin, {
      interpretation: "Declared mapping to exact source evidence, not execution proof.",
    }));
  }
  return { nodes: added, edges, sources };
}
export function inspectSurfaceClaimSources({ root, nodes, edges = [], maxBytes = 64 * 1024 * 1024 }) {
  const cache = new Map();
  let bytesRead = 0, omitted = 0;
  function inspect(ref, statement) {
    const key = ref.path;
    let observed = cache.get(key);
    if (!cache.has(key)) {
      try {
        if (bytesRead >= maxBytes) {
          throw Object.assign(new Error("Selected source-byte observation bound."), { code: "SURFACE_SOURCE_TOTAL_BYTE_BOUND" });
        }
        const bytes = readSourceBytes(root, key, maxBytes - bytesRead);
        bytesRead += bytes.length;
        observed = { digest: sourceDigest(bytes),
          lines: new TextDecoder("utf-8", { fatal: true }).decode(bytes).split(/\r?\n/) };
      } catch (error) {
        observed = { reasonCode: error.code === "SOURCE_BYTE_LIMIT"
          ? "SURFACE_SOURCE_TOTAL_BYTE_BOUND" : error.code || "SOURCE_INVALID_UTF8" };
      }
      cache.set(key, observed);
    }
    if (observed.reasonCode) {
      if (observed.reasonCode === "SURFACE_SOURCE_TOTAL_BYTE_BOUND") omitted++;
      return { state: observed.reasonCode === "SURFACE_SOURCE_TOTAL_BYTE_BOUND" ? "not-inspected" : "unavailable",
        reasonCode: observed.reasonCode };
    }
    if (observed.digest !== ref.digest) return { state: "historical-or-unavailable-source",
      currentDigest: observed.digest, reasonCode: "CITED_REVISION_NOT_CURRENT" };
    if ((ref.endLine || ref.line || 1) > observed.lines.length) {
      return { state: "unavailable", reasonCode: "SURFACE_SOURCE_RANGE_UNAVAILABLE" };
    }
    const quote = observed.lines.slice((ref.startLine || ref.line || 1) - 1, ref.endLine || ref.line || 1).join("\n").slice(0, 2048);
    return { state: statement && quote !== statement ? "cited-range-differs-from-claim" : "exact-current-source-bytes",
      digest: ref.digest, quote, ...(statement && quote !== statement ? { reasonCode: "SURFACE_QUOTE_MISMATCH" } : {}),
      runtimeVerified: false };
  }
  for (const node of nodes) if (node.origin?.layer === "product-surface") {
    if (node.claimReference) node.claimEvidence = inspect(node.claimReference, node.statement);
    if (node.executionSource) node.executionEvidence = inspect(node.executionSource, null);
  }
  for (const edge of edges) if (edge.provenance?.layer === "product-surface" && edge.claimReference) {
    edge.claimEvidence = inspect(edge.claimReference, edge.statement);
  }
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  for (const edge of edges) if (edge.recordedTextComparison) {
    const a = byId.get(edge.from), b = byId.get(edge.to);
    edge.recordedTextComparison = { ...edge.recordedTextComparison,
      sourceVerification: [a, b].every(node => node?.claimEvidence?.state === "exact-current-source-bytes")
        ? "both-exact-current-quoted-ranges" : "source-evidence-partial" };
  }
  return { scope: "selected-claim-and-execution-references", bytesRead, pathsInspected: cache.size,
    omittedReferences: omitted, totalByteBound: maxBytes,
    meaning: "Source-byte/range checks, not runtime verification or accepted meaning." };
}

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readGraphProject, safeGraphFile } from "./discovery-index.mjs";
import { relativeProjectArtifact } from "./project-storage-format.mjs";
import { collectGraphExplorerInventory } from "./project-graph.mjs";
import { LocalJsonWorldModelStoreAdapter } from "./world-model-store.mjs";
import { inspectGraphLineage, diffGraphLineage } from "./graph-lineage.mjs";
import { renderGraphExplorer } from "./graph-explorer-html.mjs";

const MAX_ORIGINAL = 64 * 1024, MAX_ORIGINAL_TOTAL = 256 * 1024;
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const fail = code => { throw Object.assign(new Error(code), { code }); };
const reason = error => /^[A-Z][A-Z0-9_]{0,95}$/.test(error?.code || "") ? error.code : "GRAPH_EXPLORER_UNAVAILABLE";
export const explorerReferenceKey = reference => JSON.stringify([reference?.path || null, reference?.digest || null]);

function readOnlyLocalAdapter(Base, owner, directory) {
  const adapter = new Base(owner);
  for (const method of ["pointerLocation", "snapshotLocation"]) {
    const original = adapter[method].bind(adapter);
    adapter[method] = (...args) => safeGraphFile(owner.projectRoot, path.relative(owner.projectRoot, original(...args)).replaceAll("\\", "/"));
  }
  const list = adapter.listSnapshotIds.bind(adapter);
  adapter.listSnapshotIds = () => { safeGraphFile(owner.projectRoot, relativeProjectArtifact(owner.storage, directory, "snapshots")); return list(); };
  adapter.writePointer = adapter.writeSnapshot = () => fail("GRAPH_EXPLORER_READ_ONLY");
  return adapter;
}

function boundedBytes(file, maximum) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) return null;
    const bytes = Buffer.alloc(maximum + 1); let count = 0;
    while (count < bytes.length) {
      const read = fs.readSync(fd, bytes, count, bytes.length - count, count);
      if (!read) break; count += read;
    }
    return count > maximum ? null : bytes.subarray(0, count);
  } finally { fs.closeSync(fd); }
}

function exactOriginal(root, reference, remaining) {
  if (!reference?.path || !/^[a-f0-9]{64}$/.test(reference.digest || "")) return { status: "unavailable", reasonCode: "EXACT_REFERENCE_NOT_RETAINED" };
  try {
    const file = safeGraphFile(root, reference.path), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_ORIGINAL || stat.size > remaining) return { status: "omitted", reasonCode: "ORIGINAL_BYTE_BOUND", bytes: stat.size };
    // JSON records already passed their typed layer's reader before query
    // emitted this exact reference. Digest equality binds this read to it.
    const raw = boundedBytes(file, Math.min(remaining, MAX_ORIGINAL));
    if (!raw) return { status: "omitted", reasonCode: "ORIGINAL_BYTE_BOUND" };
    const digest = sha(raw);
    if (digest !== reference.digest) return { status: "unavailable", reasonCode: "EXACT_REVISION_NOT_ON_DISK", expectedDigest: reference.digest, currentDigest: digest };
    return { status: "verified-exact-bytes", bytes: raw.length, digest,
      text: new TextDecoder("utf-8", { fatal: true }).decode(raw) };
  } catch (error) { return { status: "unavailable", reasonCode: reason(error) }; }
}

// UI-private projection. No Session selection, initialization or refresh occurs.
export async function buildGraphExplorerSnapshot({ root = ".", query = "", anchorIds = [], paths = [], layer = "project", history = false, share = false } = {}) {
  if (typeof share !== "boolean") fail("GRAPH_EXPLORER_INVALID_SHARE_OPTION");
  if (!["project", "code"].includes(layer)) fail("GRAPH_EXPLORER_INVALID_LAYER");
  const started = performance.now(), owner = readGraphProject(root), projectRoot = owner.projectRoot;
  const adapterOwner = { projectRoot, storage: owner.storage };
  const worldAdapter = readOnlyLocalAdapter(LocalJsonWorldModelStoreAdapter, adapterOwner, "world-model");
  const queryStarted = performance.now();
  const inventory = await collectGraphExplorerInventory({ root: projectRoot, query, anchorIds, paths, layer, storeAdapter: worldAdapter });
  const { structural, detailSelection = inventory, codeSelection, ...navigation } = inventory;
  const selected = new Map((detailSelection?.nodes || []).map(node => [node.nodeId, node]));
  const graph = { ...navigation, query: detailSelection.query,
    nodes: inventory.nodes.map(node => {
      if (selected.has(node.nodeId)) return { ...selected.get(node.nodeId), detailCoverage: "selected-detail" };
      // Recorded pending/unknown/conditions remain visible even outside the
      // focused exact-original/comparison bundle. This is not a raw-file copy.
      return { ...node,
        detailCoverage: "metadata-only", detailReasonCode: "DETAIL_NOT_INCLUDED_FOR_THIS_SELECTION" };
    }), contextLineage: detailSelection?.contextLineage || null,
    initialNodeId: layer === "code" ? null : detailSelection.query.anchorIds.find(id => selected.has(id)) || detailSelection?.nodes[0]?.nodeId || null,
    detailSelection: { anchorIds: detailSelection.query.anchorIds, paths: detailSelection.query.paths,
      unmatchedAnchorIds: detailSelection.unmatchedAnchorIds, truncated: detailSelection.truncated,
      omittedMatchCount: detailSelection.omittedMatchCount, basis: navigation.basis },
    detailScope: "Bounded exact comparisons/originals for the export selection; missing detail is not proof of no change." };
  const queryMs = performance.now() - queryStarted;
  if (owner.project && graph.basis?.projectId && graph.basis.projectId !== owner.project.projectId) fail("GRAPH_EXPLORER_PROJECT_MISMATCH");
  // The temporal and structural graphs keep their own exact identities.
  // Both come from the same verified snapshot; no path-based joins are added.
  const sourceAnchor = query || graph.nodes.find(node => node.kind === "FileRevision" && node.sourceCurrentness?.freshness === "current-source-bytes")?.path;
  let codeGraph = { status: "unavailable", nodes: [], edges: [], reasonCode: "SEMANTIC_GRAPH_NOT_BUILT", fallback: "original-source" };
  const codeStarted = performance.now();
  if (structural?.graph) {
      const code = structural.graph, current = structural.freshness.domains.code.status === "current";
      codeGraph = { status: current ? "current" : "non-current-retained", worldModelId: structural.worldModelId,
        ...(!current ? { fallback: "original-source", reasonCode: "WORLD_CODE_EVIDENCE_NOT_CURRENT" } : {}),
        semanticGraphId: code.semanticGraphId, freshness: structural.freshness, layer: "structural-code-evidence", sourceAnchor,
        // Same verified Project's existing exact comparisons, not a code-ID or
        // path-only graph join. The UI binds each pair by source path + digest.
        contextLineage: graph.contextLineage,
        nodes: code.nodes.map(node => ({ ...node, nodeId: node.id, revisionId: code.semanticGraphId,
          currentTraversalEligible: current, freshness: current ? "snapshot-evidence" : "domain-not-current",
          sourceReference: node.path && (node.digest || node.fileDigest) ? { path: node.path, digest: node.digest || node.fileDigest } : null })),
        edges: code.edges.map(edge => ({ ...edge, edgeId: edge.id, sourceReference: edge.evidence, currentTraversalEligible: current,
          freshness: current ? "snapshot-evidence" : "domain-not-current" })), omittedEdgeCount: 0, truncated: false };
  }
  codeGraph.focusSelection = codeSelection || { requestedIds: [], resolvedIds: [], unmatchedIds: [] };
  codeGraph.initialNodeId = codeSelection?.resolvedIds[0] || null;
  const codeQueryMs = performance.now() - codeStarted;
  const originals = {}, unavailable = [], seen = new Set(); let originalBytes = 0, originalReadCount = 0;
  // Metadata is complete over verified available layers. Original text remains
  // a separately bounded focused bundle, not an all-originals export promise.
  const codeReferences = new Map(), needle = String(query || "").trim().toLocaleLowerCase();
  const focusedCodeReferences = new Set((codeSelection?.sourceBindings || []).map(explorerReferenceKey));
  for (const node of codeGraph.nodes) if (node.sourceReference?.path && node.sourceReference.digest) {
    const key = explorerReferenceKey(node.sourceReference), match = focusedCodeReferences.has(key) || Boolean(needle && [node.path, node.name, node.qualifiedName, node.id]
      .some(value => typeof value === "string" && value.toLocaleLowerCase().includes(needle)));
    const existing = codeReferences.get(key);
    if (!existing || match && !existing.match) codeReferences.set(key, { node, match });
  }
  // Literal query matches are read first, not an eligibility gate. Every exact
  // reference remains represented, with text omissions governed only by the
  // existing byte budget rather than the former 40-code-node result cutoff.
  const rankedReferences = [...codeReferences.values()].sort((a, b) => Number(b.match) - Number(a.match)
    || explorerReferenceKey(a.node.sourceReference).localeCompare(explorerReferenceKey(b.node.sourceReference))).map(entry => entry.node);
  for (const item of [...(detailSelection?.nodes || []), ...(detailSelection?.edges || []), ...rankedReferences]) {
    if (item.projectId && item.projectId !== owner.project?.projectId) fail("GRAPH_EXPLORER_PROJECT_MISMATCH");
    const reference = item.sourceReference || item.provenance, key = explorerReferenceKey(reference);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!reference?.path || !reference.digest) continue;
    const original = exactOriginal(projectRoot, reference, MAX_ORIGINAL_TOTAL - originalBytes);
    originals[key] = { reference, ...original }; originalReadCount += 1;
    if (original.status === "verified-exact-bytes") originalBytes += original.bytes;
  }
  let retainedHistory = { status: "not-requested", entries: [], diff: null };
  if (history && owner.project) {
    try {
      const lineage = inspectGraphLineage({ root: projectRoot, limit: 3, storeAdapter: worldAdapter });
      if (lineage.projectId !== owner.project.projectId) fail("GRAPH_EXPLORER_PROJECT_MISMATCH");
      const entries = lineage.segment.entries;
      const current = entries.find(entry => entry.worldModelId === lineage.currentWorldModelId);
      const parent = entries.find(entry => current?.parentSourceSnapshotIds.includes(entry.sourceSnapshotId));
      const pair = current && parent ? [parent, current] : entries.slice(0, 2);
      const diff = pair.length === 2 ? diffGraphLineage({ root: projectRoot,
        fromWorldModelId: pair[0].worldModelId, toWorldModelId: pair[1].worldModelId, limit: 40, storeAdapter: worldAdapter }) : null;
      retainedHistory = { status: "retained", lineage, entries, diff,
        comparison: parent ? "retained-parent-to-current" : "exact-retained-pair-not-chronological-inference" };
    } catch (error) { retainedHistory = { status: "unavailable", entries: [], diff: null, reasonCode: reason(error) }; }
  }
  if (!owner.project) unavailable.push("PROJECT_GRAPH_NOT_INITIALIZED");
  // These are generated viewer hints, not original evidence. Do not recursively
  // redact raw bodies, hashes, historical references or canonical graph records.
  if (share) for (const node of graph.nodes) if (node.originalExpansion?.arguments?.project_root) {
    const { project_root, ...argumentsWithoutRoot } = node.originalExpansion.arguments;
    node.originalExpansion = { ...node.originalExpansion, arguments: argumentsWithoutRoot, requiresExplicitProjectRoot: true };
  }
  return {
    kind: "GraphExplorerSnapshot", schemaVersion: 1, authorityPlane: "P4-derived-view", runtimeAuthority: false,
    generatedAt: new Date().toISOString(), project: owner.project ? { projectId: owner.project.projectId, ...(!share ? { root: projectRoot } : {}) } : null,
    metadataPolicy: { mode: share ? "share-generated-metadata" : "local", anonymized: false,
      omitted: share ? ["project.root", "regenerate.argv", "nodes.originalExpansion.arguments.project_root"] : [],
      notice: "Original evidence, source text, historical records and identifiers are retained and may contain sensitive paths or content. Review before sharing; this is not anonymization." },
    focus: { kind: layer, nativeSessionSelectionClaimed: false }, initialLayer: layer, graph, codeGraph, originals, history: retainedHistory, unavailable,
    regenerate: { ...(!share ? { argv: [process.execPath, path.resolve(import.meta.dirname, "../lode.mjs"), "graph-explorer", projectRoot] } : { requiresExplicitLocalPaths: true }),
      shell: process.platform === "win32" ? "powershell" : "posix", scope: "Explicitly generate another create-only report; never executed by this file." },
    bounds: { maxProjectNodes: null, maxProjectEdges: null, maxCodeNodes: null, maxCodeEdges: null,
      metadata: "No node/edge count cutoff; source-reader and platform resource failures remain disclosed.",
      maxOriginalBytes: MAX_ORIGINAL, maxOriginalTotalBytes: MAX_ORIGINAL_TOTAL },
    metrics: { queryMs, codeQueryMs, exportMs: performance.now() - started, originalReferenceCount: originalReadCount, originalBytes,
      queryInventoryReads: "not-measured-by-this-view; output-node-limit-is-not-an-inventory-read-limit" },
    interpretation: "A generated local evidence snapshot, not a live view, Session binding, recovery direction or action approval.",
  };
}

export async function exportGraphExplorer({ root = ".", query = "", anchorIds = [], paths = [], layer = "project", history = false, share = false, output = null } = {}) {
  // Validate explicit output before doing potentially expensive reads. Only the
  // newly requested report is writable; no canonical/runtime directory is used.
  let file = output ? path.resolve(output) : null;
  const protect = value => { if (value.split(/[\\/]/).some(part => [".head", ".lode", ".git"].includes(part.toLowerCase()))) fail("GRAPH_EXPLORER_PROTECTED_OUTPUT"); };
  if (file) {
    protect(file);
    let ancestor = path.dirname(file);
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    const resolved = fs.realpathSync.native(ancestor); protect(resolved);
    file = path.resolve(resolved, path.relative(ancestor, file));
  }
  if (file && fs.existsSync(file)) fail("GRAPH_EXPLORER_OUTPUT_EXISTS");
  const snapshot = await buildGraphExplorerSnapshot({ root, query, anchorIds, paths, layer, history, share }), html = renderGraphExplorer(snapshot);
  const bytes = Buffer.byteLength(html);
  if (!file) file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lode-graph-explorer-")), "index.html");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { status: "created", file, bytes, projectId: snapshot.project?.projectId || null,
    metadataPolicy: snapshot.metadataPolicy,
    advisories: [{ code: "OFFLINE_REPORT_RESOURCE_NOTICE", bytes,
      message: "Large offline reports can take substantial browser memory and time. No metadata was removed to reduce HTML size; exact-original text has separate disclosed byte bounds." }],
    nodes: snapshot.graph.nodes.length, edges: snapshot.graph.edges.length, coverage: snapshot.graph.coverage,
    metrics: snapshot.metrics, generatedAt: snapshot.generatedAt, snapshotAuthority: "P4-derived-view", ordinaryWorkBlocked: false };
}

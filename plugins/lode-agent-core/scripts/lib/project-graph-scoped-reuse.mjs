import fs from "node:fs";
import { formatForVerifiedOwner, relativeProjectArtifact } from "./project-storage-format.mjs";
import { canonicalGraphJson, projectGraphDigest, readGraphProject, readGraphRecord, safeGraphFile,
  projectGraphIndexPath, projectGraphRecordDirectories } from "./discovery-index.mjs";
import { sessionWorkPath } from "./session-work-evidence-original.mjs";

// Process-local optimization of an already typed/byte-verified discovery, not
// a new record store. Cold, broad, World and custom-store queries keep the
// original-backed path. Caller projections cannot seed or alter this cache.
const cache = new Map();
const supported = (options, query) => query.anchorIds.length > 0 && !query.query && !query.paths.length
  && !options.storeAdapter && !options.worldModelId && !options.graphProjectionAdapter;
const keyFor = (root, query) => projectGraphDigest({ root, query });
const singletons = [".head/context/product-model.json", ".head/world-model/current.json",
  ".head/sessions/current.json", ".head/project-direction/current.json"];

// Membership is navigation only. Inspect names/types (including symlinks),
// not unrelated Session bodies. Add/delete/rename invalidates warm reuse.
// Non-JSON layout matters to historical onboarding readers as well.
function membership(root, storage) {
  const layout = [];
  function visit(relative, depth = 0) {
    if (depth > 8 || layout.length >= 10000) throw new Error("scoped membership limit");
    const file = safeGraphFile(root, relative);
    if (!fs.existsSync(file)) { layout.push([relative, "absent"]); return; }
    if (!fs.lstatSync(file).isDirectory()) throw new Error("invalid membership directory");
    layout.push([relative, "directory"]);
    for (const entry of fs.readdirSync(file, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (layout.length >= 10000) throw new Error("scoped membership limit");
      const child = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error("symlink membership");
      if (entry.isDirectory()) visit(child, depth + 1);
      else layout.push([child, entry.isFile() ? "file" : "other"]);
    }
  }
  for (const directory of [...projectGraphRecordDirectories(storage),
    relativeProjectArtifact(storage, "onboarding/historical-boundaries"), relativeProjectArtifact(storage, "onboarding/historical-continuity")]) visit(directory);
  for (const relative of singletons.map(value => relativeProjectArtifact(storage, value.slice(6)))) layout.push([relative, fs.existsSync(safeGraphFile(root, relative)) ? "present" : "absent"]);
  return projectGraphDigest(layout);
}

function dependencyLayoutMatches(root, layout) {
  for (const expected of layout) {
    const file = safeGraphFile(root, expected.path);
    let type = "absent";
    if (fs.existsSync(file)) { const stat = fs.lstatSync(file); type = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other"; }
    if (type !== expected.type) return false;
  }
  return true;
}
function rawProofDigest(root, relative) {
  const file = safeGraphFile(root, relative), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error("proof input limit");
  const bytes = fs.readFileSync(file);
  if (bytes.length > 16 * 1024 * 1024) throw new Error("proof input limit");
  return projectGraphDigest(bytes);
}

function previousMatches(previous, entry) {
  if (!previous) return true;
  return [entry.result, entry.scopedResult].some(result => previous.resultId === result.resultId
    && canonicalGraphJson({ ...previous, reuse: null }) === canonicalGraphJson({ ...result, reuse: null }));
}

// Cold typed nodes, not caller projections, establish this narrow scope. Bounds
// other than depth retain their real defaults/key; every anchor must be returned.
function exactWorkScope(query, result, inventory, nodes) {
  if (query.depth !== 0 || result.nodes.length !== query.anchorIds.length
    || query.anchorIds.some(id => !result.nodes.some(node => node.nodeId === id))) return null;
  const entries = new Map(inventory.entries.map(entry => [entry.path, entry]));
  const work = new Map(), byId = new Map(), ids = new Set(), ambiguous = new Set();
  for (const entry of inventory.entries) {
    const selector = sessionWorkPath(entry.path);
    if (!selector) continue;
    if (ids.has(selector.evidenceId)) ambiguous.add(selector.evidenceId);
    ids.add(selector.evidenceId);
  }
  for (const node of nodes) {
    if (node.kind !== "Evidence" || node.subtype !== "SessionWorkEvidence" || node.origin?.layer !== "sessionWork") continue;
    const selector = sessionWorkPath(node.origin.path), entry = entries.get(node.origin.path);
    if (!selector || selector.evidenceId !== node.nodeId || !entry || entry.sha256 !== node.origin.digest
      || node.sourceReference?.path !== entry.path || node.sourceReference?.digest !== entry.sha256
      || selector.sessionId && selector.sessionId !== node.sessionId || node.projectedReferences?.length
      || ambiguous.has(node.nodeId) || work.has(entry.path)) continue;
    work.set(entry.path, node);
    byId.set(node.nodeId, node);
  }
  const anchors = query.anchorIds.map(id => byId.get(id));
  return anchors.some(node => !node) ? null : { work, anchors };
}

function workProofPaths(query, result, inventory, nodes, requiredIds, paths) {
  const scope = exactWorkScope(query, result, inventory, nodes);
  if (!scope) return paths;
  const keep = new Set(), removable = new Set(scope.work.keys());
  const workDependencies = inventory.readerDependencies?.sessionWork;
  const layout = new Set((workDependencies?.layout || []).map(entry => entry.path));
  let uncertain = false;
  for (const entry of inventory.entries) {
    if (!sessionWorkPath(entry.path)) keep.add(entry.path);
    else if (!scope.work.has(entry.path)) { keep.add(entry.path); uncertain = true; }
  }
  for (const [layer, dependencies] of Object.entries(inventory.readerDependencies || {})) {
    if (layer !== "sessionWork") for (const entry of dependencies.entries) keep.add(entry.path);
  }
  // Owner/default and other-layer proof is never subtracted. The old first-hop
  // endpoint origins stay protected; owner provenance must not fan back out to
  // every sibling work body merely because it was in the old second edge pass.
  for (const node of nodes) if (requiredIds.has(node.nodeId)) {
    for (const relative of [node.origin?.path, node.sourceReference?.path, node.sourceCurrentness?.path]) if (relative) keep.add(relative);
  }
  for (const entry of workDependencies?.entries || []) {
    if (uncertain || entry.path === relativeProjectArtifact(inventory.storage, "project.json")
      || new RegExp(`^\\${formatForVerifiedOwner(inventory.storage).directory}/sessions(?:/by-id/session-[a-fA-F0-9-]{36})?/current\\.json$`).test(entry.path)) keep.add(entry.path);
    else if (!sessionWorkPath(entry.path)) removable.add(entry.path);
  }
  const anchorIds = new Set(query.anchorIds), anchorPaths = new Set(scope.anchors.map(node => node.origin.path));
  for (const node of scope.work.values()) {
    const content = node.workContent;
    const selectors = [content.workLink?.root, content.workLink?.predecessor, content.executionObservation?.target].filter(Boolean);
    // Test selectors even when no edge currently exists: a bad root or digest
    // can suppress an incoming edge whose later repair must invalidate reuse.
    if (!requiredIds.has(node.nodeId) && !selectors.some(selector => anchorIds.has(selector.evidenceId))
      && !content.references.some(ref => anchorPaths.has(ref.path))) continue;
    keep.add(node.origin.path);
    const owner = sessionWorkPath(node.origin.path);
    const dependencies = [...selectors.map(selector => `${owner.directory}/${selector.evidenceId}.json`), ...content.references.map(ref => ref.path)];
    for (const relative of dependencies) {
      if (!paths.has(relative) && !layout.has(relative)) return paths;
      keep.add(relative);
    }
  }
  const narrowed = new Set(paths);
  for (const relative of removable) if (!keep.has(relative)) narrowed.delete(relative);
  return narrowed;
}

export function beginScopedDiscovery(options, normalized) {
  if (!supported(options, normalized)) return null;
  try {
    const { projectRoot: root, storage } = readGraphProject(options.root || ".");
    if (fs.existsSync(safeGraphFile(root, relativeProjectArtifact(storage, "world-model/current.json")))) return null;
    return membership(root, storage);
  } catch { return null; }
}

export function rememberScopedDiscovery({ options, normalized, inventory, result, nodes, edges, world, sourceCurrentness, initialMembership }) {
  if (!supported(options, normalized) || world || inventory.entries.some(entry => entry.path === relativeProjectArtifact(inventory.storage, "world-model/current.json"))
    || !inventory.complete || inventory.unavailable.length
    || result.unmatchedAnchorIds.length || !result.nodes.length) return;
  // Exact local anchors only: no ranked discovery over unread bodies, and no
  // World/adapter result/currentness assertions from an unobserved snapshot.
  try {
    const root = inventory.projectRoot, index = readGraphRecord(root, projectGraphIndexPath(inventory.storage));
    if (index.document.kind !== "ProjectGraphRecordIndex" || index.document.projectId !== inventory.project.projectId
      || index.document.rootDigest !== projectGraphDigest(root) || index.document.recordsDigest !== inventory.recordsDigest
      || canonicalGraphJson(index.document.entries) !== canonicalGraphJson(inventory.entries)
      || canonicalGraphJson(index.document.readerDependencies) !== canonicalGraphJson(inventory.readerDependencies)) return;
    const selected = new Set(result.nodes.map(node => node.nodeId));
    // Include boundary endpoints even when maxNodes/maxEdges cuts them out.
    // Their state and relationship producers are hidden semantic dependencies.
    const requiredIds = new Set(selected);
    for (const edge of edges) if (selected.has(edge.from) || selected.has(edge.to)) {
      requiredIds.add(edge.from); requiredIds.add(edge.to);
    }
    // Failure projections can depend on source inputs not exposed as normal
    // sourceCurrentness facts. Do not pretend this proof covers those readers.
    if (nodes.some(node => requiredIds.has(node.nodeId) && node.kind === "SourceCollectionFailure")) return;
    const paths = new Set();
    for (const node of nodes) if (requiredIds.has(node.nodeId) && node.origin?.path) paths.add(node.origin.path);
    for (const edge of edges) if (requiredIds.has(edge.from) || requiredIds.has(edge.to)) {
      if (edge.provenance?.path) paths.add(edge.provenance.path);
    }
    // Typed layer readers have global uniqueness, review and lineage inputs.
    // Reverify all of those, rather than just the returned candidate/receipt.
    // Only unrelated mutable Session current-state bodies may be skipped.
    for (const entry of inventory.entries) if (!new RegExp(`^\\${formatForVerifiedOwner(inventory.storage).directory}/sessions/by-id/session-[a-fA-F0-9-]{36}/current\\.json$`).test(entry.path)
      || paths.has(entry.path)) paths.add(entry.path);
    for (const dependencies of Object.values(inventory.readerDependencies || {})) {
      if (!dependencies.complete || dependencies.unavailable.length) return;
      for (const entry of dependencies.entries) paths.add(entry.path);
    }
    const entries = new Map([...inventory.entries, ...Object.values(inventory.readerDependencies || {})
      .flatMap(dependencies => dependencies.entries)].map(entry => [entry.path, entry]));
    if ([...paths].some(relative => !entries.has(relative))) return;
    const proof = [...workProofPaths(normalized, result, inventory, nodes, requiredIds, paths)].sort().map(relative => entries.get(relative));
    const selectedSourcePaths = new Set(nodes.filter(node => requiredIds.has(node.nodeId))
      .flatMap(node => [node.sourceCurrentness?.path, node.sourceReference?.path]).filter(relative => relative && !relative.startsWith(`${formatForVerifiedOwner(inventory.storage).directory}/`)));
    const sources = sourceCurrentness.filter(source => selectedSourcePaths.has(source.path));
    const retained = structuredClone(result);
    const scopedPayload = { ...retained, basis: { ...retained.basis,
      verificationScope: "selected-originals-and-semantic-dependencies", recordsDigestScope: "retained-discovery-inventory",
      layerDigestScope: "retained-discovery-layer-status",
      sourceCurrentnessDigest: projectGraphDigest(sources), sourceCurrentnessScope: "selected-and-boundary-source-bytes",
      indexDigest: index.digest, proofDigest: projectGraphDigest(proof) },
      integrity: { ...retained.integrity, verifiedLayers: [], retainedVerifiedLayers: retained.integrity.verifiedLayers,
        verifiedRecordPaths: proof.slice(0, 256).map(entry => entry.path), verifiedRecordCount: proof.length,
        omittedVerifiedRecordPathCount: Math.max(0, proof.length - 256), scope: "selected-originals-and-semantic-dependencies" },
      freshness: { ...retained.freshness, scope: "selected-originals-and-dependencies-current-bytes; unrelated-bodies-not-reverified" },
      coverage: { ...retained.coverage, verifiedNodeCount: retained.nodes.length,
        retainedDiscoveryNodeCount: retained.coverage.verifiedNodeCount,
        layers: retained.coverage.layers.map(layer => ({ ...layer, status: "retained-discovery-basis" })),
        membership: "current-names-and-types", unrelatedRecordBytesReverified: false,
        relationScope: "retained-discovery-relations-with-original-producers-reverified",
        broadQueriesUseFullDiscovery: true },
      sourceFallback: { ...retained.sourceFallback, needed: true,
        reasonCodes: [...new Set([...retained.sourceFallback.reasonCodes, "PROJECT_GRAPH_SCOPED_VERIFICATION"])],
        action: "Read affected originals before relying on current effects; use a new or broad query to rediscover unrelated changes. Excluded inputs and retained discovery diagnostics are historical, not a fresh whole-inventory validation." },
      reuse: { status: "scoped-originals-reused", semanticSufficiency: "HEAD-owned", wholeProjectCurrent: false } };
    delete scopedPayload.resultId; delete scopedPayload.resultHash;
    const resultHash = projectGraphDigest(scopedPayload);
    const scopedResult = { ...scopedPayload, resultId: `project-graph-result-${resultHash.slice(0, 24)}`, resultHash };
    const projectRead = readGraphRecord(root, relativeProjectArtifact(inventory.storage, "project.json"));
    if (canonicalGraphJson(projectRead.document) !== canonicalGraphJson(inventory.project)) return;
    const projectDigest = projectRead.digest;
    const membershipDigest = membership(root, inventory.storage);
    if (!initialMembership || membershipDigest !== initialMembership) return;
    const workLayout = inventory.readerDependencies?.sessionWork?.layout || [];
    if (!dependencyLayoutMatches(root, workLayout) || proof.some(entry => rawProofDigest(root, entry.path) !== entry.sha256)) return;
    const entry = { projectId: inventory.project.projectId, projectDigest, indexDigest: index.digest,
      membershipDigest, proof, sources, workLayout, result: retained, scopedResult };
    // Do not prime from a mixed sequence if the index changed during proof assembly.
    if (readGraphRecord(root, projectGraphIndexPath(inventory.storage)).digest !== index.digest) return;
    if (cache.size >= 16) cache.delete(cache.keys().next().value);
    cache.set(keyFor(root, normalized), entry);
  } catch { /* Missing/stale index or unsupported proof is a normal fallback. */ }
}

export function reuseScopedDiscovery(options, normalized) {
  if (!supported(options, normalized) || !cache.size) return null;
  let key;
  try {
    const { projectRoot: root, project, storage } = readGraphProject(options.root || ".");
    key = keyFor(root, normalized);
    const entry = cache.get(key);
    if (!entry || !project || project.projectId !== entry.projectId || !previousMatches(options.previousResult, entry)) return null;
    if (readGraphRecord(root, relativeProjectArtifact(storage, "project.json")).digest !== entry.projectDigest
      || readGraphRecord(root, projectGraphIndexPath(storage)).digest !== entry.indexDigest
      || membership(root, storage) !== entry.membershipDigest || !dependencyLayoutMatches(root, entry.workLayout || [])) throw new Error("navigation basis changed");
    for (const proof of entry.proof) if (rawProofDigest(root, proof.path) !== proof.sha256) throw new Error("original bytes changed");
    for (const source of entry.sources) {
      let digest = null;
      try {
        const file = safeGraphFile(root, source.path), stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error("source limit");
        digest = projectGraphDigest(fs.readFileSync(file));
      } catch { /* Absence is compared with the original observed absence. */ }
      if (digest !== source.currentDigest) throw new Error("selected source changed");
    }
    return structuredClone(entry.scopedResult);
  } catch { if (key) cache.delete(key); return null; }
}

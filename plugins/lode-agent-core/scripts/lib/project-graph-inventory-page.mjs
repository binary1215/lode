// Request-local byte observations. These rows never enter a typed graph layer,
// Explorer, authority store, or success cache. A cursor is only an untrusted seek.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readGraphProject, safeGraphFile, projectGraphRecordDirectories,
  projectGraphSingletonPaths, projectGraphExactSelector, projectGraphDigest } from "./discovery-index.mjs";
import { formatForVerifiedOwner } from "./project-storage-format.mjs";
import { publicToolName } from "./lode-artifact-composition.mjs";
import { formatMcpToolContent } from "./cli-presentation.mjs";

// Existing inventory byte/record/depth bounds; a metadata page does not raise
// them. 512 KiB bounds BOTH MCP text and structured JSON, not Capsule tokens.
const MAX_ENTRIES = 10000, MAX_BYTES = 128 * 1024 * 1024, MAX_FILE = 16 * 1024 * 1024;
const MAX_ROWS = 512, MAX_ENVELOPE = 512 * 1024, MAX_CURSOR = 4096, MAX_DEPTH = 8;
const authority = { plane: "P4-derived-view", persistence: "none", instructionAuthority: false,
  promotionAuthority: false, recoveryAuthority: false, executionAuthority: false, ordinaryWorkBlocked: false };
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const compare = (a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
const within = (value, parent) => value === parent || value.startsWith(parent + "/");
const witness = stat => stat ? [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String) : null;
const stamp = file => { try { return witness(fs.lstatSync(file, { bigint: true })); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const relativePath = value => typeof value === "string" && value.length > 0 && value.length <= 512
  && !/[\\\u0000-\u001f\u007f]/u.test(value) && !path.posix.isAbsolute(value)
  && value.split("/").every(part => part && part !== "." && part !== ".." && !part.includes(":"));
const eligible = relative => relative.endsWith(".json")
  && (!/\/sessions\/by-id\//.test(relative) || /\/current\.json$/.test(relative) || projectGraphExactSelector(relative)?.layer === "sessionWork")
  && (!/\/sessions\/work-evidence\//.test(relative) || projectGraphExactSelector(relative)?.layer === "sessionWork")
  && (!/\/sessions\/runs\//.test(relative) || /\/run\.json$/.test(relative));

function exactRead(root, relative, storage) {
  const selector = projectGraphExactSelector(relative);
  if (selector?.layer === "lineage") return { supported: true, tool: publicToolName("head_lineage_artifact"),
    arguments: { project_root: root, artifact_id: selector.recordId },
    scope: "Retained artifact verifier also inspects selected Session, managed manifest and managed-file digests; currentness, parent existence and execution permission are not proved." };
  if (selector) return { supported: true, tool: publicToolName("head_project_graph"),
    arguments: { project_root: root, paths: [relative], details: true },
    scope: selector.layer === "direction" ? "Historical direction verifier; currentness unknown. No public whole historical original expansion reader."
      : "Original Work evidence and declared owner/dependencies are reverified." };
  return { supported: false, reasonCode: "TYPED_LAYER_DEPENDENCIES_NOT_INSPECTED", path: relative,
    scope: "Bytes alone do not validate a record kind, review state, relations or currentness. Existing typed layer readers may need broader dependencies." };
}

export function readProjectGraphInventoryPage(options, normalized) {
  if (options.inventoryPage !== true) fail("INVALID_PROJECT_GRAPH_INVENTORY_PAGE");
  const owner = readGraphProject(options.root || ".");
  if (!owner.project) fail("PROJECT_GRAPH_NOT_INITIALIZED");
  const { projectRoot: root, project, storage } = owner;
  const roots = projectGraphRecordDirectories(storage), singles = projectGraphSingletonPaths(storage);
  const allowed = relative => roots.some(parent => within(relative, parent)) || singles.includes(relative);
  const requested = options.inventoryPaths ?? [...roots, ...singles];
  if (!Array.isArray(requested) || requested.length === 0 || requested.length > 32
    || requested.some(relative => !relativePath(relative) || !allowed(relative))) fail("INVALID_PROJECT_GRAPH_INVENTORY_SCOPE");
  // Explicit deep scopes precede ancestors. Earlier scopes are skipped on later
  // ancestors so an exact scope and its parent never reread the same bodies.
  const scopes = [...new Set(requested)].sort((a, b) => b.split("/").length - a.split("/").length || compare(a, b));
  const binding = projectGraphDigest({ projectId: project.projectId, root, directory: formatForVerifiedOwner(storage).directory,
    query: normalized, worldModelId: options.worldModelId || "", scopes });
  let cursor = null;
  if (options.inventoryCursor != null) {
    const raw = options.inventoryCursor;
    if (typeof raw !== "string" || !raw || raw.length > MAX_CURSOR || !/^[A-Za-z0-9_-]+$/.test(raw)) fail("INVALID_PROJECT_GRAPH_INVENTORY_CURSOR");
    try { cursor = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")); } catch { fail("INVALID_PROJECT_GRAPH_INVENTORY_CURSOR"); }
    const c = cursor;
    if (c?.v !== 1 || c.binding !== binding || Object.keys(c).sort().join() !== "binding,frontier,v"
      || !Number.isInteger(c.frontier?.scope) || c.frontier.scope < 0 || c.frontier.scope >= scopes.length
      || !relativePath(c.frontier?.path) || !within(c.frontier.path, scopes[c.frontier.scope])
      || !["file", "subtree"].includes(c.frontier.kind) || Object.keys(c.frontier).sort().join() !== "kind,parent,path,scope,stat"
      || [c.frontier.stat, c.frontier.parent].some(w => w !== null && (!Array.isArray(w) || w.length !== 5 || w.some(n => typeof n !== "string" || !/^\d{1,30}$/.test(n))))) fail("INVALID_PROJECT_GRAPH_INVENTORY_CURSOR");
  }
  const counters = { metadataEntries: 0, directoryOpenAttempts: 0, directoryOpens: 0, directoryReads: 0, directoryCloses: 0,
    metadataUtf8Bytes: 0, attemptedBodies: 0, attemptedBytes: 0, inspectedBytes: 0, rows: 0, failures: 0 };
  const page = { kind: "ProjectGraphDiscoveryProjection", projectId: project.projectId, ...authority, nodes: [], edges: [],
    inventoryPage: { kind: "untyped-owned-byte-observations", scopes, rows: [], counters,
      limits: { metadataEntries: MAX_ENTRIES, metadataOverflowProbeEntries: 1, directoryOpens: MAX_ENTRIES, directoryReads: MAX_ENTRIES * 2 + 1,
        metadataUtf8Bytes: MAX_BYTES, attemptedBytes: MAX_BYTES, perFileBytes: MAX_FILE, rows: MAX_ROWS, depth: MAX_DEPTH, mcpEnvelopeUtf8Bytes: MAX_ENVELOPE },
      costScope: "Inventory traversal and body attempts only; fresh Project/storage ownership checks precede these counters.",
      ordering: "UTF-8 byte order, directory subtree before next lexical sibling; name enumeration may repeat on later requests, prior bodies do not.",
      coverage: { status: "in-progress", startAfter: cursor?.frontier ?? null, examinedThrough: null,
        exhaustedObservedRange: false, remainingCount: null, previousPageCurrentness: "not-certified", earlierInsertions: "unknown",
        semanticFilters: "not-applied-to-untyped-inventory", typedValidity: "not-inspected", globalMembership: "unknown", uninspectedSubtreeCount: 0 },
      next: null, narrowing: [], warnings: [] } };
  const out = page.inventoryPage;
  const argumentsFor = token => ({ project_root: root, ...Object.fromEntries(Object.entries({ query: normalized.query, view: normalized.view,
    anchor_ids: normalized.anchorIds, paths: normalized.paths, depth: normalized.depth, max_nodes: normalized.maxNodes,
    max_edges: normalized.maxEdges, details: normalized.details, include_candidates: normalized.includeCandidates,
    ...(options.worldModelId ? { world_model_id: options.worldModelId } : {}) })), inventory_page: true, inventory_paths: scopes,
    ...(token ? { inventory_cursor: token } : {}) });
  const nextFor = frontier => ({ tool: publicToolName("head_project_graph"),
    arguments: argumentsFor(Buffer.from(JSON.stringify({ v: 1, binding, frontier })).toString("base64url")) });
  const envelopeBytes = value => Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: formatMcpToolContent("head_project_graph", value) }], structuredContent: value }));
  // Reserve the complete continuation + largest bounded diagnostic/counters,
  // before touching a body. This is a fitting check, not a semantic exclusion.
  const fits = row => {
    const probe = structuredClone(page); probe.inventoryPage.rows.push(row);
    probe.inventoryPage.next = { tool: publicToolName("head_project_graph"), arguments: { ...argumentsFor("x".repeat(MAX_CURSOR)) } };
    probe.inventoryPage.narrowing = Array.from({ length: 8 }, () => ({ tool: publicToolName("head_project_graph"), arguments: { project_root: root, inventory_page: true, inventory_paths: ["x".repeat(512)] } }));
    probe.inventoryPage.warnings = [{ reasonCode: "PROJECT_GRAPH_INVENTORY_METADATA_BOUND", path: "x".repeat(512) }];
    probe.inventoryPage.coverage.examinedThrough = { scope: 31, path: "x".repeat(512), kind: "subtree", stat: Array(5).fill("9".repeat(30)), parent: Array(5).fill("9".repeat(30)) };
    for (const key of Object.keys(probe.inventoryPage.counters)) probe.inventoryPage.counters[key] = Number.MAX_SAFE_INTEGER;
    probe.inventoryPage.coverage.status = "exhausted-observed-range";
    return envelopeBytes(probe) <= MAX_ENVELOPE;
  };
  let frontier = cursor?.frontier ?? null, stop = false, bounded = false;
  const leafPath = relative => { const parent = path.posix.dirname(relative); safeGraphFile(root, parent); return path.join(root, ...relative.split("/")); };
  if (cursor) {
    try {
      const file = leafPath(cursor.frontier.path);
      if (!same(stamp(file), cursor.frontier.stat) || !same(stamp(path.dirname(file)), cursor.frontier.parent)) throw new Error("changed");
    } catch {
      out.coverage.status = "changed-scope"; out.warnings.push({ reasonCode: "PROJECT_GRAPH_INVENTORY_FRONTIER_CHANGED", path: cursor.frontier.path });
      out.narrowing.push({ tool: publicToolName("head_project_graph"), arguments: { project_root: root, inventory_page: true, inventory_paths: [scopes[cursor.frontier.scope]] } });
      return page;
    }
  }
  const mark = (relative, kind, scope) => {
    try {
      const file = leafPath(relative);
      frontier = { scope, path: relative, kind, stat: stamp(file), parent: stamp(path.dirname(file)) };
      out.coverage.examinedThrough = frontier;
    } catch {
      // A failed witness is not permission to continue across an unknown range.
      // Preserve rows already observed and offer a concrete scope, not a loop.
      bounded = stop = true; out.coverage.status = "changed-scope";
      out.warnings.push({ reasonCode: "PROJECT_GRAPH_INVENTORY_FRONTIER_UNAVAILABLE", path: relative });
      out.narrowing = [{ tool: publicToolName("head_project_graph"), arguments: { project_root: root, inventory_page: true, inventory_paths: [scopes[scope]] } }];
    }
  };
  const metadataBound = (relative, observed = []) => {
    bounded = stop = true; out.coverage.status = "metadata-bound";
    out.warnings.push({ reasonCode: "PROJECT_GRAPH_INVENTORY_METADATA_BOUND", path: relative });
    out.narrowing = observed.filter(entry => relativePath(entry.path) && allowed(entry.path)).slice(0, 8).map(entry => ({
      tool: publicToolName("head_project_graph"), arguments: { project_root: root, inventory_page: true, inventory_paths: [entry.path] } }));
  };
  const rowFor = relative => ({ path: relative, byteObservation: "uninspected", digest: null, inspectedBytes: 0,
    typedValidity: "not-inspected", currentness: "not-inspected", exactRead: exactRead(root, relative, storage) });
  const appendFailure = (relative, code, scope, kind = "file") => {
    const row = { ...rowFor(relative), byteObservation: "unavailable", reasonCode: code,
      ...(kind === "subtree" ? { subtreeMembership: "not-inspected" } : {}) };
    if (out.rows.length >= MAX_ROWS || !fits(row)) { stop = true; return; }
    if (kind === "subtree") out.coverage.uninspectedSubtreeCount++;
    out.rows.push(row); counters.rows++; counters.failures++; mark(relative, kind, scope);
  };
  const observe = (relative, scope) => {
    const row = rowFor(relative);
    if (out.rows.length >= MAX_ROWS || !fits({ ...row, byteObservation: "inspected", digest: "f".repeat(64), inspectedBytes: MAX_FILE, reasonCode: "PROJECT_GRAPH_INVENTORY_FILE_CHANGED" })) { stop = true; return; }
    let fd, bytes = 0;
    try {
      const file = safeGraphFile(root, relative), before = fs.lstatSync(file, { bigint: true });
      if (!before.isFile()) fail("PROJECT_GRAPH_INVENTORY_NOT_FILE");
      const size = Number(before.size);
      if (size > MAX_FILE) fail("PROJECT_GRAPH_INVENTORY_FILE_BOUND");
      if (counters.attemptedBytes + size > MAX_BYTES) { stop = true; return; }
      counters.attemptedBodies++; fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      if (!same(witness(before), witness(fs.fstatSync(fd, { bigint: true })))) fail("PROJECT_GRAPH_INVENTORY_FILE_CHANGED");
      const digest = crypto.createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024);
      while (bytes < size) {
        const length = Math.min(buffer.length, size - bytes);
        if (counters.attemptedBytes + length > MAX_BYTES) fail("PROJECT_GRAPH_INVENTORY_BYTE_BOUND");
        counters.attemptedBytes += length;
        const read = fs.readSync(fd, buffer, 0, length, bytes); counters.inspectedBytes += read;
        if (!read) fail("PROJECT_GRAPH_INVENTORY_FILE_CHANGED");
        bytes += read; digest.update(buffer.subarray(0, read));
      }
      if (!same(witness(before), witness(fs.fstatSync(fd, { bigint: true }))) || !same(witness(before), stamp(file))) fail("PROJECT_GRAPH_INVENTORY_FILE_CHANGED");
      row.byteObservation = "inspected"; row.digest = digest.digest("hex"); row.inspectedBytes = bytes;
    } catch (error) { row.byteObservation = "unavailable"; row.reasonCode = error.code || "PROJECT_GRAPH_INVENTORY_READ_FAILED"; row.inspectedBytes = bytes; counters.failures++; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
    out.rows.push(row); counters.rows++; mark(relative, "file", scope);
  };
  const visit = (relative, scope, depth = 0) => {
    if (stop) return;
    if (scopes.slice(0, scope).some(previous => within(relative, previous))) return;
    const c = cursor?.frontier;
    if (c && scope === c.scope && relative === c.path) return;
    let stat, file;
    try { file = leafPath(relative); stat = fs.lstatSync(file); }
    catch (error) { if (error.code === "ENOENT") { mark(relative, "file", scope); return; } appendFailure(relative, error.code || "PROJECT_GRAPH_INVENTORY_METADATA_UNAVAILABLE", scope); return; }
    if (c && scope === c.scope && !within(c.path, relative)
      && compare(relative + (stat.isDirectory() ? "/" : ""), c.path + (c.kind === "subtree" ? "/" : "")) < 0) return;
    if (stat.isSymbolicLink()) { appendFailure(relative, "PROJECT_GRAPH_SYMLINK_PATH", scope); return; }
    if (!stat.isDirectory()) { if (eligible(relative)) observe(relative, scope); else mark(relative, "file", scope); return; }
    if (depth > MAX_DEPTH) { metadataBound(relative, [{ path: relative }]); return; }
    // Returning before a fresh directory prevents unseen metadata diagnostics
    // from stranding a body row outside the complete response envelope.
    if (out.rows.length && frontier) { stop = true; return; }
    let dir, entries = [], complete = false;
    try {
      if (counters.directoryOpenAttempts >= MAX_ENTRIES) { metadataBound(relative, [{ path: relative }]); return; }
      safeGraphFile(root, relative); counters.directoryOpenAttempts++; dir = fs.opendirSync(file, { encoding: "buffer" }); counters.directoryOpens++;
      while (counters.directoryReads < MAX_ENTRIES * 2 + 1) {
        counters.directoryReads++;
        const entry = dir.readSync();
        if (!entry) { complete = true; break; }
        counters.metadataEntries++;
        let name;
        try { name = new TextDecoder("utf-8", { fatal: true }).decode(entry.name); }
        catch { metadataBound(relative, entries); return; }
        const child = `${relative}/${name}`, bytes = Buffer.byteLength(JSON.stringify({ path: child, directory: entry.isDirectory() }));
        counters.metadataUtf8Bytes += bytes;
        if (!relativePath(child) || counters.metadataEntries > MAX_ENTRIES || counters.metadataUtf8Bytes > MAX_BYTES) { metadataBound(relative, entries); return; }
        entries.push({ path: child, directory: entry.isDirectory() });
      }
      if (!complete) { metadataBound(relative, entries); return; }
    } catch (error) { appendFailure(relative, error.code || "PROJECT_GRAPH_INVENTORY_DIRECTORY_UNAVAILABLE", scope, "subtree"); return; }
    finally { if (dir) { dir.closeSync(); counters.directoryCloses++; } }
    entries.sort((a, b) => compare(a.path + (a.directory ? "/" : ""), b.path + (b.directory ? "/" : "")));
    for (const entry of entries) { visit(entry.path, scope, depth + 1); if (stop) return; }
    mark(relative, "subtree", scope);
  };
  for (let scope = cursor?.frontier.scope ?? 0; scope < scopes.length && !stop; scope++) visit(scopes[scope], scope);
  if (!bounded && stop && frontier) { out.coverage.status = "partial"; out.next = nextFor(frontier); }
  else if (!stop) { out.coverage.status = "exhausted-observed-range"; out.coverage.exhaustedObservedRange = true; }
  else if (!bounded) { out.coverage.status = "uninspected-bound"; }
  if (out.next && out.next.arguments.inventory_cursor === options.inventoryCursor) fail("PROJECT_GRAPH_INVENTORY_NONPROGRESS");
  if (envelopeBytes(page) > MAX_ENVELOPE) fail("PROJECT_GRAPH_INVENTORY_ENVELOPE_BOUND");
  return page;
}

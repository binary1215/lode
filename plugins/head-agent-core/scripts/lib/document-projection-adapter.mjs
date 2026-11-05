import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { familyFormatForOriginal, formatForVerifiedOwner } from "./project-storage-format.mjs";
import { verifyTemporalProvenanceGraph } from "./temporal-provenance.mjs";

export const DOCUMENT_PROJECTION_ADAPTER_VERSION = "0.1.0";
export const MARKDOWN_PROJECTION_VERSION = "0.1.0";
export const DOCUMENT_PROJECTION_CONTRACT = "replaceable-rebuildable-derived-human-document-projection";

const MAX_DOCUMENTS = 4096;
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const ROWS_PER_DOCUMENT = 500;
const REQUIRED_METHODS = [
  "describe",
  "readPointer",
  "readProjection",
  "writePointer",
  "writeProjection",
  "listProjectionIds",
  "readPublishedDocuments",
  "publishDocuments",
];

const fail = (message, code = "DOCUMENT_PROJECTION_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(compare).map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function documentProjectionCanonicalJson(value) {
  return JSON.stringify(canonical(value));
}

const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const clone = (value) => JSON.parse(JSON.stringify(value));
const byteLength = (value) => Buffer.byteLength(value, "utf8");

function projectionId(value) {
  if (typeof value !== "string" || !/^document-projection-[a-f0-9]{24}$/.test(value)) {
    fail("DocumentProjection id is invalid.", "INVALID_DOCUMENT_PROJECTION_ID");
  }
  return value;
}

function candidateSetId(value) {
  if (typeof value !== "string" || !/^document-change-candidate-set-[a-f0-9]{24}$/.test(value)) {
    fail("DocumentChangeCandidateSet id is invalid.", "INVALID_DOCUMENT_CHANGE_CANDIDATE_SET_ID");
  }
  return value;
}

function safeRelativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("/")
    || value.split("/").some((part) => !part || part === "." || part === "..")
    || !value.endsWith(".md")) {
    fail("Document projection paths must be safe relative Markdown paths.", "INVALID_DOCUMENT_PROJECTION_PATH");
  }
  return value;
}

function parseDocument(file, label) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { fail(`${label} is invalid JSON: ${error.message}`, "INVALID_DOCUMENT_PROJECTION_DOCUMENT"); }
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function descriptor(adapterKind, { remote, durable }) {
  return {
    contract: DOCUMENT_PROJECTION_CONTRACT,
    adapterKind,
    adapterVersion: DOCUMENT_PROJECTION_ADAPTER_VERSION,
    formats: ["markdown"],
    authority: "derived-human-view-only",
    rebuildable: true,
    uniqueAuthority: false,
    instructionAuthority: false,
    promotionAuthority: false,
    publishedViewIsCanon: false,
    inboundEdits: "document-change-candidates-only",
    remote,
    durable,
  };
}

export function assertDocumentProjectionAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") fail("A DocumentProjectionAdapter object is required.", "INVALID_DOCUMENT_PROJECTION_ADAPTER");
  if (adapter.adapterVersion !== DOCUMENT_PROJECTION_ADAPTER_VERSION) {
    fail(`DocumentProjectionAdapter version must be ${DOCUMENT_PROJECTION_ADAPTER_VERSION}.`, "INCOMPATIBLE_DOCUMENT_PROJECTION_ADAPTER");
  }
  for (const method of REQUIRED_METHODS) if (typeof adapter[method] !== "function") {
    fail(`DocumentProjectionAdapter is missing ${method}().`, "INVALID_DOCUMENT_PROJECTION_ADAPTER");
  }
  const value = adapter.describe();
  if (!value || value.contract !== DOCUMENT_PROJECTION_CONTRACT
    || typeof value.adapterKind !== "string" || !value.adapterKind.trim()
    || value.adapterVersion !== DOCUMENT_PROJECTION_ADAPTER_VERSION
    || documentProjectionCanonicalJson(value.formats) !== documentProjectionCanonicalJson(["markdown"])) {
    fail("DocumentProjectionAdapter descriptor is invalid.", "INVALID_DOCUMENT_PROJECTION_ADAPTER");
  }
  if (value.authority !== "derived-human-view-only" || value.rebuildable !== true || value.uniqueAuthority !== false
    || value.instructionAuthority !== false || value.promotionAuthority !== false || value.publishedViewIsCanon !== false
    || value.inboundEdits !== "document-change-candidates-only") {
    fail("DocumentProjectionAdapter cannot claim canon, instruction, promotion, or unique authority.", "INVALID_DOCUMENT_PROJECTION_AUTHORITY");
  }
  if (typeof value.remote !== "boolean" || typeof value.durable !== "boolean") {
    fail("DocumentProjectionAdapter must disclose remote and durable behavior.", "INVALID_DOCUMENT_PROJECTION_ADAPTER");
  }
  return adapter;
}

function markdown(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "\\|")
    .replaceAll("\r\n", "<br>")
    .replaceAll("\r", "<br>")
    .replaceAll("\n", "<br>");
}

function slug(value) {
  const base = String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
  return `${base.slice(0, 48)}-${digest(String(value)).slice(0, 8)}`;
}

function nodeAnchor(nodeId) {
  return `node-${digest(nodeId).slice(0, 24)}`;
}

function nodeLabel(node) {
  const candidates = [node.name, node.title, node.statement, node.relativePath, node.path, node.key, node.logicalEntityId, node.nodeId];
  return String(candidates.find((value) => typeof value === "string" && value.trim()) || node.nodeId);
}

function chunks(values, size = ROWS_PER_DOCUMENT) {
  const output = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output.length ? output : [[]];
}

function document(relativePath, title, content) {
  safeRelativePath(relativePath);
  const normalized = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replace(/\n*$/, "\n");
  const bytes = byteLength(normalized);
  if (bytes > MAX_DOCUMENT_BYTES) fail(`Rendered Markdown document exceeds ${MAX_DOCUMENT_BYTES} bytes: ${relativePath}`, "DOCUMENT_PROJECTION_LIMIT_EXCEEDED");
  return { relativePath, title, content: normalized, contentHash: digest(normalized), byteLength: bytes };
}

function groupBy(values, keyFor) {
  const groups = new Map();
  for (const value of values) {
    const key = keyFor(value);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(value);
  }
  return groups;
}

export function buildMarkdownDocumentProjection(graph, storage = undefined) {
  verifyTemporalProvenanceGraph(graph);
  const nodes = [...graph.nodes].sort((left, right) => compare(left.kind, right.kind) || compare(left.nodeId, right.nodeId));
  const edges = [...graph.edges].sort((left, right) => compare(left.type, right.type) || compare(left.edgeId, right.edgeId));
  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
  const relationTypesByNode = new Map(nodes.map((node) => [node.nodeId, new Set()]));
  for (const edge of edges) {
    relationTypesByNode.get(edge.from)?.add(edge.type);
    relationTypesByNode.get(edge.to)?.add(edge.type);
  }

  const nodeGroups = groupBy(nodes, (node) => node.kind);
  const edgeGroups = groupBy(edges, (edge) => edge.type);
  const nodeLocations = new Map();
  const nodePages = [];
  for (const kind of [...nodeGroups.keys()].sort(compare)) {
    const parts = chunks(nodeGroups.get(kind));
    for (let index = 0; index < parts.length; index += 1) {
      const relativePath = `nodes/${slug(kind)}-${String(index + 1).padStart(3, "0")}.md`;
      for (const node of parts[index]) nodeLocations.set(node.nodeId, { relativePath, anchor: nodeAnchor(node.nodeId) });
      nodePages.push({ kind, index, count: parts.length, relativePath, nodes: parts[index] });
    }
  }

  const relationPages = [];
  for (const type of [...edgeGroups.keys()].sort(compare)) {
    const parts = chunks(edgeGroups.get(type));
    for (let index = 0; index < parts.length; index += 1) {
      relationPages.push({
        type,
        index,
        count: parts.length,
        relativePath: `relations/${slug(type)}-${String(index + 1).padStart(3, "0")}.md`,
        edges: parts[index],
      });
    }
  }

  const output = [];
  const indexLines = [
    formatForVerifiedOwner(storage).dialect === "lode" ? "# Lode Agent derived knowledge graph" : "# HEAD Agent derived knowledge graph",
    "",
    "> This is a deterministic, rebuildable projection of a verified GraphSnapshot. It is not project canon, an instruction source, or promotion authority.",
    "",
    `- Project: \`${markdown(graph.projectId)}\``,
    `- GraphSnapshot: \`${markdown(graph.graphSnapshotId)}\``,
    `- SourceSnapshot: \`${markdown(graph.sourceSnapshotId)}\``,
    `- Nodes: ${nodes.length}`,
    `- Edges: ${edges.length}`,
    "",
    "## Node kinds",
    "",
    "| Kind | Count | Pages |",
    "| --- | ---: | --- |",
  ];
  for (const kind of [...nodeGroups.keys()].sort(compare)) {
    const pages = nodePages.filter((page) => page.kind === kind);
    indexLines.push(`| ${markdown(kind)} | ${nodeGroups.get(kind).length} | ${pages.map((page, index) => `[${index + 1}](${page.relativePath})`).join(", ")} |`);
  }
  indexLines.push("", "## Relation types", "", "| Relation | Count | Pages |", "| --- | ---: | --- |");
  for (const type of [...edgeGroups.keys()].sort(compare)) {
    const pages = relationPages.filter((page) => page.type === type);
    indexLines.push(`| ${markdown(type)} | ${edgeGroups.get(type).length} | ${pages.map((page, index) => `[${index + 1}](${page.relativePath})`).join(", ")} |`);
  }
  output.push(document("index.md", formatForVerifiedOwner(storage).dialect === "lode" ? "Lode Agent derived knowledge graph" : "HEAD Agent derived knowledge graph", indexLines.join("\n")));

  for (const page of nodePages) {
    const lines = [
      `# ${markdown(page.kind)} nodes${page.count > 1 ? ` — page ${page.index + 1} of ${page.count}` : ""}`,
      "",
      `[Back to index](../index.md)`,
      "",
      "> Derived evidence-only view. Editing this published file does not change Product Canon or the GraphSnapshot.",
      "",
      "| Node | Label | Authority | Freshness | Origin | Evidence | Relations |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    ];
    for (const node of page.nodes) {
      const relations = [...(relationTypesByNode.get(node.nodeId) || [])].sort(compare);
      lines.push(`<a id="${nodeAnchor(node.nodeId)}"></a>| \`${markdown(node.nodeId)}\` | ${markdown(nodeLabel(node))} | ${markdown(node.authorityClass)} | ${markdown(node.freshness)} | ${markdown(node.origin)} | ${markdown((node.evidenceIds || []).join(", "))} | ${markdown(relations.join(", "))} |`);
    }
    output.push(document(page.relativePath, `${page.kind} nodes`, lines.join("\n")));
  }

  for (const page of relationPages) {
    const lines = [
      `# ${markdown(page.type)} relations${page.count > 1 ? ` — page ${page.index + 1} of ${page.count}` : ""}`,
      "",
      `[Back to index](../index.md)`,
      "",
      "> Canonical edge directions are preserved. Human-readable inverse wording does not create another semantic edge.",
      "",
      "| Edge | From | To | Authority | Freshness | Origin | Evidence | Confidence |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ];
    for (const edge of page.edges) {
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      const fromLocation = nodeLocations.get(edge.from);
      const toLocation = nodeLocations.get(edge.to);
      const fromLink = fromLocation ? `[${markdown(nodeLabel(from))}](../${fromLocation.relativePath}#${fromLocation.anchor})` : `\`${markdown(edge.from)}\``;
      const toLink = toLocation ? `[${markdown(nodeLabel(to))}](../${toLocation.relativePath}#${toLocation.anchor})` : `\`${markdown(edge.to)}\``;
      lines.push(`| \`${markdown(edge.edgeId)}\` | ${fromLink} | ${toLink} | ${markdown(edge.authorityClass)} | ${markdown(edge.freshness)} | ${markdown(edge.origin)} | ${markdown((edge.evidenceIds || []).join(", "))} | ${edge.confidence == null ? "" : markdown(edge.confidence)} |`);
    }
    output.push(document(page.relativePath, `${page.type} relations`, lines.join("\n")));
  }

  output.sort((left, right) => compare(left.relativePath, right.relativePath));
  const totalBytes = output.reduce((sum, item) => sum + item.byteLength, 0);
  if (output.length > MAX_DOCUMENTS || totalBytes > MAX_TOTAL_BYTES) {
    fail("Rendered Markdown projection exceeds the bounded document or byte limit.", "DOCUMENT_PROJECTION_LIMIT_EXCEEDED");
  }
  const payload = {
    schemaVersion: 1,
    kind: "DocumentProjection",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-document-projection"), version: DOCUMENT_PROJECTION_ADAPTER_VERSION },
    renderer: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-markdown"), version: MARKDOWN_PROJECTION_VERSION },
    projectId: graph.projectId,
    graphSnapshotId: graph.graphSnapshotId,
    graphSnapshotHash: graph.graphSnapshotHash,
    sourceSnapshotId: graph.sourceSnapshotId,
    format: "markdown",
    documents: output,
    summary: {
      documentCount: output.length,
      totalBytes,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      nodeKindCount: nodeGroups.size,
      relationTypeCount: edgeGroups.size,
    },
    authority: "derived-human-view-only",
    rebuildable: true,
    uniqueAuthority: false,
    instructionAuthority: false,
    promotionAuthority: false,
    inboundEdits: "document-change-candidates-only",
  };
  const documentProjectionHash = digest(documentProjectionCanonicalJson(payload));
  return { ...payload, documentProjectionId: `document-projection-${documentProjectionHash.slice(0, 24)}`, documentProjectionHash };
}

export function verifyDocumentProjection(value, expectedGraph = null, storage = undefined) {
  if (!value || value.kind !== "DocumentProjection" || value.schemaVersion !== 1
    || !familyFormatForOriginal("head-agent-core-document-projection", value, storage)
    || value.protocol?.version !== DOCUMENT_PROJECTION_ADAPTER_VERSION
    || value.renderer?.name !== familyFormatForOriginal("head-agent-core-document-projection", value, storage)?.protocol("head-agent-core-markdown") || value.renderer?.version !== MARKDOWN_PROJECTION_VERSION
    || value.format !== "markdown" || typeof value.projectId !== "string" || !value.projectId
    || !/^graph-snapshot-[a-f0-9]{24}$/.test(value.graphSnapshotId || "")
    || !/^[a-f0-9]{64}$/.test(value.graphSnapshotHash || "")
    || !/^source-snapshot-[a-f0-9]{24}$/.test(value.sourceSnapshotId || "")
    || value.authority !== "derived-human-view-only" || value.rebuildable !== true || value.uniqueAuthority !== false
    || value.instructionAuthority !== false || value.promotionAuthority !== false
    || value.inboundEdits !== "document-change-candidates-only"
    || !Array.isArray(value.documents) || value.documents.length < 1 || value.documents.length > MAX_DOCUMENTS) {
    fail("DocumentProjection is invalid.", "INVALID_DOCUMENT_PROJECTION");
  }
  const paths = new Set();
  let totalBytes = 0;
  let previous = "";
  for (const item of value.documents) {
    safeRelativePath(item?.relativePath);
    if (paths.has(item.relativePath) || (previous && compare(previous, item.relativePath) >= 0)
      || typeof item.title !== "string" || !item.title
      || typeof item.content !== "string" || item.content.includes("\r") || !item.content.endsWith("\n")
      || item.contentHash !== digest(item.content) || item.byteLength !== byteLength(item.content)
      || item.byteLength > MAX_DOCUMENT_BYTES) {
      fail("DocumentProjection contains invalid, unsorted, duplicate, or digest-mismatched documents.", "DOCUMENT_PROJECTION_DIGEST_MISMATCH");
    }
    paths.add(item.relativePath);
    previous = item.relativePath;
    totalBytes += item.byteLength;
  }
  if (totalBytes > MAX_TOTAL_BYTES || value.summary?.documentCount !== value.documents.length
    || value.summary?.totalBytes !== totalBytes) {
    fail("DocumentProjection summary is invalid.", "DOCUMENT_PROJECTION_DIGEST_MISMATCH");
  }
  const payload = { ...value };
  delete payload.documentProjectionId;
  delete payload.documentProjectionHash;
  const expectedHash = digest(documentProjectionCanonicalJson(payload));
  if (value.documentProjectionHash !== expectedHash
    || value.documentProjectionId !== `document-projection-${expectedHash.slice(0, 24)}`) {
    fail("DocumentProjection digest verification failed.", "DOCUMENT_PROJECTION_DIGEST_MISMATCH");
  }
  if (expectedGraph && (value.projectId !== expectedGraph.projectId || value.graphSnapshotId !== expectedGraph.graphSnapshotId
    || value.graphSnapshotHash !== expectedGraph.graphSnapshotHash || value.sourceSnapshotId !== expectedGraph.sourceSnapshotId)) {
    fail("DocumentProjection does not match the expected GraphSnapshot.", "DOCUMENT_PROJECTION_STALE");
  }
  return value;
}

function pointerFor(projection, storage) {
  const payload = {
    schemaVersion: 1,
    kind: "DocumentProjectionPointer",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-document-projection"), version: DOCUMENT_PROJECTION_ADAPTER_VERSION },
    projectId: projection.projectId,
    documentProjectionId: projection.documentProjectionId,
    documentProjectionHash: projection.documentProjectionHash,
    graphSnapshotId: projection.graphSnapshotId,
    graphSnapshotHash: projection.graphSnapshotHash,
    sourceSnapshotId: projection.sourceSnapshotId,
    format: "markdown",
    authority: "derived-human-view-only",
    rebuildable: true,
    uniqueAuthority: false,
    instructionAuthority: false,
    promotionAuthority: false,
  };
  const pointerHash = digest(documentProjectionCanonicalJson(payload));
  return { ...payload, pointerId: `document-projection-pointer-${pointerHash.slice(0, 24)}`, pointerHash };
}

export function verifyDocumentProjectionPointer(value, expectedProjection = null, storage = undefined) {
  if (!value || value.kind !== "DocumentProjectionPointer" || value.schemaVersion !== 1
    || !familyFormatForOriginal("head-agent-core-document-projection", value, storage)
    || value.protocol?.version !== DOCUMENT_PROJECTION_ADAPTER_VERSION
    || typeof value.projectId !== "string" || !value.projectId
    || !/^document-projection-[a-f0-9]{24}$/.test(value.documentProjectionId || "")
    || !/^[a-f0-9]{64}$/.test(value.documentProjectionHash || "")
    || !/^graph-snapshot-[a-f0-9]{24}$/.test(value.graphSnapshotId || "")
    || !/^[a-f0-9]{64}$/.test(value.graphSnapshotHash || "")
    || !/^source-snapshot-[a-f0-9]{24}$/.test(value.sourceSnapshotId || "")
    || value.format !== "markdown" || value.authority !== "derived-human-view-only"
    || value.rebuildable !== true || value.uniqueAuthority !== false
    || value.instructionAuthority !== false || value.promotionAuthority !== false) {
    fail("Document projection pointer is invalid.", "INVALID_DOCUMENT_PROJECTION_POINTER");
  }
  const payload = { ...value };
  delete payload.pointerId;
  delete payload.pointerHash;
  const expectedHash = digest(documentProjectionCanonicalJson(payload));
  if (value.pointerHash !== expectedHash || value.pointerId !== `document-projection-pointer-${expectedHash.slice(0, 24)}`) {
    fail("Document projection pointer digest verification failed.", "DOCUMENT_PROJECTION_POINTER_DIGEST_MISMATCH");
  }
  if (expectedProjection && (value.protocol.name !== expectedProjection.protocol?.name
    || value.documentProjectionId !== expectedProjection.documentProjectionId
    || value.documentProjectionHash !== expectedProjection.documentProjectionHash
    || value.graphSnapshotId !== expectedProjection.graphSnapshotId || value.graphSnapshotHash !== expectedProjection.graphSnapshotHash
    || value.sourceSnapshotId !== expectedProjection.sourceSnapshotId || value.projectId !== expectedProjection.projectId)) {
    fail("Document projection pointer does not match the projection.", "DOCUMENT_PROJECTION_POINTER_MISMATCH");
  }
  return value;
}

function publishedDrift(projection, actualDocuments) {
  const expected = new Map(projection.documents.map((item) => [item.relativePath, item]));
  const actual = new Map(actualDocuments.map((item) => [item.relativePath, item]));
  const paths = [...new Set([...expected.keys(), ...actual.keys()])].sort(compare);
  return paths.flatMap((relativePath) => {
    const base = expected.get(relativePath) || null;
    const proposed = actual.get(relativePath) || null;
    if (base?.contentHash === proposed?.contentHash) return [];
    return [{
      relativePath,
      changeType: !base ? "added" : !proposed ? "removed" : "modified",
      baseContentHash: base?.contentHash || null,
      proposedContentHash: proposed?.contentHash || null,
      baseByteLength: base?.byteLength || 0,
      proposedByteLength: proposed?.byteLength || 0,
    }];
  });
}

export class LocalMarkdownProjectionAdapter {
  constructor({ projectRoot, storage }) {
    if (typeof projectRoot !== "string" || !projectRoot.trim()) fail("Local Markdown projection requires projectRoot.", "DOCUMENT_PROJECTION_ROOT_REQUIRED");
    this.projectRoot = path.resolve(projectRoot);
    this.storage = storage;
    this.adapterVersion = DOCUMENT_PROJECTION_ADAPTER_VERSION;
  }

  describe() {
    return descriptor("local-markdown", { remote: false, durable: true });
  }

  pointerLocation() {
    return path.join(this.projectRoot, formatForVerifiedOwner(this.storage).directory, "document-projection", "markdown", "current.json");
  }

  projectionLocation(id) {
    return path.join(this.projectRoot, formatForVerifiedOwner(this.storage).directory, "document-projection", "markdown", "snapshots", `${projectionId(id)}.json`);
  }

  publishedRoot() {
    return path.join(this.projectRoot, formatForVerifiedOwner(this.storage).directory, "generated", "knowledge");
  }

  publishedLocation(relativePath) {
    const safe = safeRelativePath(relativePath);
    const root = this.publishedRoot();
    const resolved = path.resolve(root, ...safe.split("/"));
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) fail("Published document path escaped its root.", "INVALID_DOCUMENT_PROJECTION_PATH");
    return resolved;
  }

  readPointer() {
    const location = this.pointerLocation();
    return fs.existsSync(location) ? { location, document: parseDocument(location, "Document projection pointer") } : null;
  }

  readProjection(id) {
    const location = this.projectionLocation(id);
    return fs.existsSync(location) ? { location, document: parseDocument(location, "DocumentProjection") } : null;
  }

  writeProjection(id, value) {
    const location = this.projectionLocation(id);
    if (fs.existsSync(location)) return { location, created: false, document: parseDocument(location, "DocumentProjection") };
    atomicWrite(location, json(value));
    return { location, created: true, document: value };
  }

  writePointer(value) {
    const location = this.pointerLocation();
    atomicWrite(location, json(value));
    return { location, document: value };
  }

  listProjectionIds() {
    const directory = path.join(this.projectRoot, formatForVerifiedOwner(this.storage).directory, "document-projection", "markdown", "snapshots");
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^document-projection-[a-f0-9]{24}\.json$/.test(entry.name))
      .map((entry) => entry.name.slice(0, -5)).sort(compare);
  }

  readPublishedDocuments() {
    const root = this.publishedRoot();
    if (!fs.existsSync(root)) return [];
    const documents = [];
    const visit = (directory, prefix = "") => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => compare(left.name, right.name))) {
        if (entry.isSymbolicLink()) fail("Published Markdown view cannot contain symlinks.", "INVALID_PUBLISHED_DOCUMENT_VIEW");
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const location = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(location, relativePath);
        else if (entry.isFile() && entry.name.endsWith(".md")) {
          safeRelativePath(relativePath);
          const content = fs.readFileSync(location, "utf8");
          const bytes = byteLength(content);
          if (bytes > MAX_DOCUMENT_BYTES) fail(`Published document exceeds ${MAX_DOCUMENT_BYTES} bytes: ${relativePath}`, "DOCUMENT_PROJECTION_LIMIT_EXCEEDED");
          documents.push({ relativePath, content, contentHash: digest(content), byteLength: bytes, location });
        }
      }
    };
    visit(root);
    documents.sort((left, right) => compare(left.relativePath, right.relativePath));
    if (documents.length > MAX_DOCUMENTS || documents.reduce((sum, item) => sum + item.byteLength, 0) > MAX_TOTAL_BYTES) {
      fail("Published Markdown view exceeds bounded document or byte limits.", "DOCUMENT_PROJECTION_LIMIT_EXCEEDED");
    }
    return documents;
  }

  publishDocuments(documents, { removeRelativePaths = [] } = {}) {
    const expected = new Set(documents.map((item) => safeRelativePath(item.relativePath)));
    for (const item of documents) atomicWrite(this.publishedLocation(item.relativePath), item.content);
    for (const relativePath of [...new Set(removeRelativePaths)].sort(compare)) {
      if (expected.has(relativePath)) continue;
      const location = this.publishedLocation(relativePath);
      if (fs.existsSync(location)) fs.unlinkSync(location);
    }
    return this.readPublishedDocuments();
  }
}

export class InMemoryMarkdownProjectionAdapter {
  constructor({ adapterKind = "in-memory-markdown" } = {}) {
    this.adapterVersion = DOCUMENT_PROJECTION_ADAPTER_VERSION;
    this.adapterKind = adapterKind;
    this.pointer = null;
    this.projections = new Map();
    this.published = new Map();
  }

  describe() { return descriptor(this.adapterKind, { remote: false, durable: false }); }
  readPointer() { return this.pointer ? { location: "memory://document-projection/current", document: clone(this.pointer) } : null; }
  readProjection(id) {
    projectionId(id);
    const value = this.projections.get(id);
    return value ? { location: `memory://document-projection/snapshots/${id}`, document: clone(value) } : null;
  }
  writeProjection(id, value) {
    projectionId(id);
    const created = !this.projections.has(id);
    if (created) this.projections.set(id, clone(value));
    return { location: `memory://document-projection/snapshots/${id}`, created, document: clone(this.projections.get(id)) };
  }
  writePointer(value) {
    this.pointer = clone(value);
    return { location: "memory://document-projection/current", document: clone(value) };
  }
  listProjectionIds() { return [...this.projections.keys()].sort(compare); }
  readPublishedDocuments() {
    return [...this.published.entries()].sort(([left], [right]) => compare(left, right)).map(([relativePath, content]) => ({
      relativePath, content, contentHash: digest(content), byteLength: byteLength(content), location: `memory://published/${relativePath}`,
    }));
  }
  publishDocuments(documents, { removeRelativePaths = [] } = {}) {
    for (const item of documents) this.published.set(safeRelativePath(item.relativePath), item.content);
    for (const relativePath of removeRelativePaths) this.published.delete(safeRelativePath(relativePath));
    return this.readPublishedDocuments();
  }
}

export function createDocumentProjectionAdapter({ projectRoot, storage, adapter = null } = {}) {
  return assertDocumentProjectionAdapter(adapter || new LocalMarkdownProjectionAdapter({ projectRoot, storage }));
}

function loadCurrentProjection(selected, storage) {
  const pointerEntry = selected.readPointer();
  if (!pointerEntry) return { pointerEntry: null, pointer: null, projectionEntry: null, projection: null };
  const pointer = verifyDocumentProjectionPointer(pointerEntry.document, null, storage);
  const projectionEntry = selected.readProjection(pointer.documentProjectionId);
  if (!projectionEntry) fail("Document projection pointer references a missing projection.", "DOCUMENT_PROJECTION_MISSING");
  const projection = verifyDocumentProjection(projectionEntry.document, null, storage);
  verifyDocumentProjectionPointer(pointer, projection, storage);
  return { pointerEntry, pointer, projectionEntry, projection };
}

export function materializeMarkdownProjection({ projectRoot, storage, graph, adapter = null } = {}) {
  verifyTemporalProvenanceGraph(graph);
  const selected = createDocumentProjectionAdapter({ projectRoot, storage, adapter });
  const next = buildMarkdownDocumentProjection(graph, storage);
  const current = loadCurrentProjection(selected, storage);
  const actualBefore = selected.readPublishedDocuments();
  if (!current.projection && actualBefore.length) {
    fail("Unmanaged Markdown files already exist in the published view.", "DOCUMENT_PROJECTION_UNMANAGED_CONTENT");
  }
  if (current.projection) {
    const drift = publishedDrift(current.projection, actualBefore);
    if (drift.length) fail("Published Markdown contains unreviewed edits; capture DocumentChangeCandidates before rebuilding.", "DOCUMENT_PROJECTION_UNREVIEWED_DRIFT");
  }

  return persistMarkdownProjection({ selected, graph, next, current }, storage);
}

function persistMarkdownProjection({ selected, graph, next, current }, storage) {

  const existing = selected.readProjection(next.documentProjectionId);
  let projectionEntry;
  if (existing) {
    const verified = verifyDocumentProjection(existing.document, graph, storage);
    if (documentProjectionCanonicalJson(verified) !== documentProjectionCanonicalJson(next)) {
      fail("Document projection adapter returned conflicting content for the same projection id.", "DOCUMENT_PROJECTION_CONFLICT");
    }
    projectionEntry = existing;
  } else {
    projectionEntry = selected.writeProjection(next.documentProjectionId, clone(next));
    verifyDocumentProjection(projectionEntry.document, graph, storage);
    if (documentProjectionCanonicalJson(projectionEntry.document) !== documentProjectionCanonicalJson(next)) {
      fail("Document projection adapter changed the projection during materialization.", "DOCUMENT_PROJECTION_WRITE_MISMATCH");
    }
  }

  const removeRelativePaths = current.projection?.documents.map((item) => item.relativePath)
    .filter((relativePath) => !next.documents.some((item) => item.relativePath === relativePath)) || [];
  const published = selected.publishDocuments(clone(next.documents), { removeRelativePaths });
  const driftAfter = publishedDrift(next, published);
  if (driftAfter.length) fail("Document projection adapter changed published Markdown content.", "DOCUMENT_PROJECTION_PUBLISH_MISMATCH");
  const pointer = pointerFor(next, storage);
  const pointerEntry = selected.writePointer(clone(pointer));
  verifyDocumentProjectionPointer(pointerEntry.document, next, storage);
  if (documentProjectionCanonicalJson(pointerEntry.document) !== documentProjectionCanonicalJson(pointer)) {
    fail("Document projection adapter changed the pointer during materialization.", "DOCUMENT_PROJECTION_WRITE_MISMATCH");
  }
  return {
    status: current.projection?.documentProjectionId === next.documentProjectionId ? "unchanged" : "projected",
    projection: next,
    pointer,
    projectionLocation: projectionEntry.location,
    pointerLocation: pointerEntry.location,
    publishedLocations: published.map((item) => ({ relativePath: item.relativePath, location: item.location })),
    adapter: selected.describe(),
  };
}

export function inspectMarkdownProjection({ projectRoot, storage, graph, adapter = null } = {}) {
  verifyTemporalProvenanceGraph(graph);
  const selected = createDocumentProjectionAdapter({ projectRoot, storage, adapter });
  const current = loadCurrentProjection(selected, storage);
  const actual = selected.readPublishedDocuments();
  if (!current.projection) return {
    status: actual.length ? "unmanaged" : "not-materialized",
    graphSnapshotId: graph.graphSnapshotId,
    candidateRequired: actual.length > 0,
    drift: actual.map((item) => ({ relativePath: item.relativePath, changeType: "added", baseContentHash: null, proposedContentHash: item.contentHash })),
    adapter: selected.describe(),
  };
  const stale = current.projection.projectId !== graph.projectId || current.projection.graphSnapshotId !== graph.graphSnapshotId
    || current.projection.graphSnapshotHash !== graph.graphSnapshotHash || current.projection.sourceSnapshotId !== graph.sourceSnapshotId;
  if (!stale) {
    const expected = buildMarkdownDocumentProjection(graph, storage);
    if (documentProjectionCanonicalJson(current.projection) !== documentProjectionCanonicalJson(expected)) {
      fail("Stored DocumentProjection differs from the deterministic Markdown reference.", "DOCUMENT_PROJECTION_SEMANTIC_MISMATCH");
    }
  }
  const drift = publishedDrift(current.projection, actual);
  return {
    status: drift.length ? "modified" : stale ? "stale" : "current",
    graphFreshness: stale ? "stale" : "current",
    graphSnapshotId: graph.graphSnapshotId,
    projectedGraphSnapshotId: current.projection.graphSnapshotId,
    documentProjectionId: current.projection.documentProjectionId,
    pointer: current.pointer,
    pointerLocation: current.pointerEntry.location,
    projectionLocation: current.projectionEntry.location,
    publishedLocations: actual.map((item) => ({ relativePath: item.relativePath, location: item.location })),
    candidateRequired: drift.length > 0,
    drift,
    adapter: selected.describe(),
  };
}

function candidateDocument(projectRoot, id, storage) {
  return path.join(path.resolve(projectRoot), formatForVerifiedOwner(storage).directory, "document-changes", "candidate-sets", `${candidateSetId(id)}.json`);
}

export function verifyDocumentChangeCandidateSet(value, storage = undefined) {
  if (!value || value.kind !== "DocumentChangeCandidateSet" || value.schemaVersion !== 1
    || !familyFormatForOriginal("head-agent-core-document-change-candidates", value, storage)
    || value.protocol?.version !== DOCUMENT_PROJECTION_ADAPTER_VERSION
    || typeof value.projectId !== "string" || !value.projectId
    || !/^document-projection-[a-f0-9]{24}$/.test(value.documentProjectionId || "")
    || !/^[a-f0-9]{64}$/.test(value.documentProjectionHash || "")
    || !/^graph-snapshot-[a-f0-9]{24}$/.test(value.graphSnapshotId || "")
    || !/^[a-f0-9]{64}$/.test(value.graphSnapshotHash || "")
    || !/^source-snapshot-[a-f0-9]{24}$/.test(value.sourceSnapshotId || "")
    || !Array.isArray(value.candidates) || value.candidates.length < 1 || value.candidates.length > MAX_DOCUMENTS
    || value.authority !== "unreviewed-candidate" || value.instructionAuthority !== false || value.promotionAuthority !== false
    || value.requiresReviewDecision !== true) {
    fail("DocumentChangeCandidateSet is invalid.", "INVALID_DOCUMENT_CHANGE_CANDIDATE_SET");
  }
  let previous = "";
  const ids = new Set();
  for (const candidate of value.candidates) {
    safeRelativePath(candidate?.relativePath);
    if (previous && compare(previous, candidate.relativePath) >= 0
      || candidate.schemaVersion !== 1 || candidate.kind !== "DocumentChangeCandidate"
      || !["added", "modified", "removed"].includes(candidate.changeType)
      || !/^document-change-candidate-[a-f0-9]{24}$/.test(candidate.candidateId || "")
      || ids.has(candidate.candidateId)
      || candidate.documentProjectionId !== value.documentProjectionId || candidate.graphSnapshotId !== value.graphSnapshotId
      || candidate.authority !== "unreviewed-candidate" || candidate.instructionAuthority !== false || candidate.promotionAuthority !== false
      || (candidate.baseContentHash !== null && !/^[a-f0-9]{64}$/.test(candidate.baseContentHash || ""))
      || (candidate.proposedContentHash !== null && !/^[a-f0-9]{64}$/.test(candidate.proposedContentHash || ""))
      || (candidate.baseContent !== null && (typeof candidate.baseContent !== "string" || byteLength(candidate.baseContent) > MAX_DOCUMENT_BYTES))
      || (candidate.proposedContent !== null && (typeof candidate.proposedContent !== "string" || byteLength(candidate.proposedContent) > MAX_DOCUMENT_BYTES))
      || (candidate.baseContent !== null && digest(candidate.baseContent) !== candidate.baseContentHash)
      || (candidate.proposedContent !== null && digest(candidate.proposedContent) !== candidate.proposedContentHash)
      || (candidate.changeType === "added" && (candidate.baseContent !== null || candidate.baseContentHash !== null || candidate.proposedContent === null))
      || (candidate.changeType === "removed" && (candidate.proposedContent !== null || candidate.proposedContentHash !== null || candidate.baseContent === null))
      || (candidate.changeType === "modified" && (candidate.baseContent === null || candidate.proposedContent === null))) {
      fail("DocumentChangeCandidateSet contains invalid candidates.", "DOCUMENT_CHANGE_CANDIDATE_DIGEST_MISMATCH");
    }
    const candidatePayload = { ...candidate };
    delete candidatePayload.candidateId;
    const candidateHash = digest(documentProjectionCanonicalJson(candidatePayload));
    if (candidate.candidateId !== `document-change-candidate-${candidateHash.slice(0, 24)}`) {
      fail("DocumentChangeCandidate identity is invalid.", "DOCUMENT_CHANGE_CANDIDATE_DIGEST_MISMATCH");
    }
    ids.add(candidate.candidateId);
    previous = candidate.relativePath;
  }
  const payload = { ...value };
  delete payload.candidateSetId;
  delete payload.candidateSetHash;
  const expectedHash = digest(documentProjectionCanonicalJson(payload));
  if (value.candidateSetHash !== expectedHash || value.candidateSetId !== `document-change-candidate-set-${expectedHash.slice(0, 24)}`) {
    fail("DocumentChangeCandidateSet digest verification failed.", "DOCUMENT_CHANGE_CANDIDATE_SET_DIGEST_MISMATCH");
  }
  return value;
}

export function captureDocumentChangeCandidates({ projectRoot, storage, graph, adapter = null, persist = true } = {}) {
  verifyTemporalProvenanceGraph(graph);
  const selected = createDocumentProjectionAdapter({ projectRoot, storage, adapter });
  const current = loadCurrentProjection(selected, storage);
  if (!current.projection) fail("A verified base DocumentProjection is required before capturing edits.", "DOCUMENT_PROJECTION_NOT_MATERIALIZED");
  if (current.projection.graphSnapshotId !== graph.graphSnapshotId || current.projection.graphSnapshotHash !== graph.graphSnapshotHash) {
    fail("Document edits cannot be captured against a stale GraphSnapshot.", "DOCUMENT_PROJECTION_STALE");
  }
  const expectedProjection = buildMarkdownDocumentProjection(graph, storage);
  if (documentProjectionCanonicalJson(current.projection) !== documentProjectionCanonicalJson(expectedProjection)) {
    fail("Document edits cannot be captured against a semantically divergent projection.", "DOCUMENT_PROJECTION_SEMANTIC_MISMATCH");
  }
  const expected = new Map(current.projection.documents.map((item) => [item.relativePath, item]));
  const actualDocuments = selected.readPublishedDocuments();
  const actual = new Map(actualDocuments.map((item) => [item.relativePath, item]));
  const drift = publishedDrift(current.projection, actualDocuments);
  if (!drift.length) return { status: "no-changes", candidateSet: null, adapter: selected.describe() };
  const candidates = drift.map((item) => {
    const base = expected.get(item.relativePath) || null;
    const proposed = actual.get(item.relativePath) || null;
    const candidatePayload = {
      schemaVersion: 1,
      kind: "DocumentChangeCandidate",
      documentProjectionId: current.projection.documentProjectionId,
      graphSnapshotId: graph.graphSnapshotId,
      relativePath: item.relativePath,
      changeType: item.changeType,
      baseContentHash: base?.contentHash || null,
      proposedContentHash: proposed?.contentHash || null,
      baseContent: base?.content || null,
      proposedContent: proposed?.content || null,
      authority: "unreviewed-candidate",
      instructionAuthority: false,
      promotionAuthority: false,
    };
    const candidateHash = digest(documentProjectionCanonicalJson(candidatePayload));
    return { ...candidatePayload, candidateId: `document-change-candidate-${candidateHash.slice(0, 24)}` };
  });
  const payload = {
    schemaVersion: 1,
    kind: "DocumentChangeCandidateSet",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-document-change-candidates"), version: DOCUMENT_PROJECTION_ADAPTER_VERSION },
    projectId: graph.projectId,
    documentProjectionId: current.projection.documentProjectionId,
    documentProjectionHash: current.projection.documentProjectionHash,
    graphSnapshotId: graph.graphSnapshotId,
    graphSnapshotHash: graph.graphSnapshotHash,
    sourceSnapshotId: graph.sourceSnapshotId,
    candidates,
    authority: "unreviewed-candidate",
    instructionAuthority: false,
    promotionAuthority: false,
    requiresReviewDecision: true,
  };
  const candidateSetHash = digest(documentProjectionCanonicalJson(payload));
  const candidateSet = verifyDocumentChangeCandidateSet({
    ...payload,
    candidateSetId: `document-change-candidate-set-${candidateSetHash.slice(0, 24)}`,
    candidateSetHash,
  }, storage);
  let file = null;
  if (persist) {
    file = candidateDocument(projectRoot, candidateSet.candidateSetId, storage);
    if (fs.existsSync(file)) {
      const existing = verifyDocumentChangeCandidateSet(parseDocument(file, "DocumentChangeCandidateSet"), storage);
      if (documentProjectionCanonicalJson(existing) !== documentProjectionCanonicalJson(candidateSet)) {
        fail("Stored DocumentChangeCandidateSet conflicts with the same identity.", "DOCUMENT_CHANGE_CANDIDATE_SET_CONFLICT");
      }
    } else atomicWrite(file, json(candidateSet));
  }
  return { status: persist ? "captured" : "preview", candidateSet, file, adapter: selected.describe() };
}

export function readDocumentChangeCandidateSet({ projectRoot, storage, id } = {}) {
  const file = candidateDocument(projectRoot, id, storage);
  if (!fs.existsSync(file)) fail(`DocumentChangeCandidateSet is missing: ${id}`, "DOCUMENT_CHANGE_CANDIDATE_SET_NOT_FOUND");
  return { status: "verified", file, candidateSet: verifyDocumentChangeCandidateSet(parseDocument(file, "DocumentChangeCandidateSet"), storage) };
}

export function verifyDocumentChangeCandidateSetAgainstPublished({ projectRoot, storage, candidateSet, adapter = null } = {}) {
  const verified = verifyDocumentChangeCandidateSet(candidateSet, storage);
  const selected = createDocumentProjectionAdapter({ projectRoot, storage, adapter });
  const current = loadCurrentProjection(selected, storage);
  if (!current.projection
    || current.projection.documentProjectionId !== verified.documentProjectionId
    || current.projection.documentProjectionHash !== verified.documentProjectionHash
    || current.projection.graphSnapshotId !== verified.graphSnapshotId
    || current.projection.graphSnapshotHash !== verified.graphSnapshotHash) {
    fail("DocumentChangeCandidateSet no longer matches the current published projection base.", "DOCUMENT_CHANGE_CANDIDATE_BASE_DRIFT");
  }
  const expected = new Map(current.projection.documents.map((item) => [item.relativePath, item]));
  const actualDocuments = selected.readPublishedDocuments();
  const actual = new Map(actualDocuments.map((item) => [item.relativePath, item]));
  const drift = publishedDrift(current.projection, actualDocuments);
  const derived = drift.map((item) => ({
    relativePath: item.relativePath,
    changeType: item.changeType,
    baseContentHash: expected.get(item.relativePath)?.contentHash || null,
    proposedContentHash: actual.get(item.relativePath)?.contentHash || null,
    baseContent: expected.get(item.relativePath)?.content || null,
    proposedContent: actual.get(item.relativePath)?.content || null,
  }));
  const recorded = verified.candidates.map((candidate) => ({
    relativePath: candidate.relativePath,
    changeType: candidate.changeType,
    baseContentHash: candidate.baseContentHash,
    proposedContentHash: candidate.proposedContentHash,
    baseContent: candidate.baseContent,
    proposedContent: candidate.proposedContent,
  }));
  if (documentProjectionCanonicalJson(derived) !== documentProjectionCanonicalJson(recorded)) {
    fail("Published Markdown changed after DocumentChangeCandidateSet capture.", "DOCUMENT_CHANGE_CANDIDATE_PUBLISHED_DRIFT");
  }
  return { status: "verified", candidateSet: verified, projection: current.projection, publishedDocuments: actualDocuments, adapter: selected.describe() };
}

export function materializeReviewedMarkdownProjection({ projectRoot, storage, graph, candidateSet, reviewDecision, adapter = null } = {}) {
  verifyTemporalProvenanceGraph(graph);
  const verified = verifyDocumentChangeCandidateSet(candidateSet, storage);
  if (!reviewDecision || reviewDecision.kind !== "ReviewDecision"
    || reviewDecision.decisionScope !== "document-to-product-canon"
    || reviewDecision.candidateSetId !== verified.candidateSetId
    || reviewDecision.candidateSetHash !== verified.candidateSetHash
    || reviewDecision.authority !== "explicit-user-document-change-review"
    || reviewDecision.instructionAuthority !== true
    || !Array.isArray(reviewDecision.acceptedCandidateIds)
    || !Array.isArray(reviewDecision.rejectedCandidateIds)) {
    fail("A verified explicit document-change ReviewDecision is required to reconcile published Markdown.", "DOCUMENT_CHANGE_REVIEW_REQUIRED");
  }
  const known = verified.candidates.map((candidate) => candidate.candidateId).sort(compare);
  const partition = [...reviewDecision.acceptedCandidateIds, ...reviewDecision.rejectedCandidateIds].sort(compare);
  if (documentProjectionCanonicalJson(known) !== documentProjectionCanonicalJson(partition)
    || new Set(partition).size !== partition.length) {
    fail("Document-change ReviewDecision does not partition the candidate set.", "DOCUMENT_CHANGE_REVIEW_SELECTION_MISMATCH");
  }
  return { ...resumeReviewedMarkdownProjection({ projectRoot, storage, graph, adapter,
    baseProjectionId: verified.documentProjectionId, candidateSet: verified }),
    reviewDecisionId: reviewDecision.reviewDecisionId, candidateSetId: verified.candidateSetId };
}

// Internal application primitive. The caller verifies the durable ReviewDecision.
// Both original and target contents already live in immutable artifacts.
export function resumeReviewedMarkdownProjection({ projectRoot, storage, graph, adapter = null, baseProjectionId, candidateSet = null }) {
  const selected = createDocumentProjectionAdapter({ projectRoot, storage, adapter });
  const current = loadCurrentProjection(selected, storage);
  const baseEntry = selected.readProjection(baseProjectionId);
  if (!baseEntry) fail("Reviewed document base is missing.", "DOCUMENT_PROJECTION_MISSING");
  const base = verifyDocumentProjection(baseEntry.document, null, storage);
  const next = buildMarkdownDocumentProjection(graph, storage);
  if (current.projection && ![base.documentProjectionId, next.documentProjectionId].includes(current.projection.documentProjectionId)) {
    fail("A later document pointer must be preserved.", "DOCUMENT_CHANGE_CANDIDATE_BASE_DRIFT");
  }
  const preimage = new Map(base.documents.map((item) => [item.relativePath, item.content]));
  if (candidateSet) {
    verifyDocumentChangeCandidateSet(candidateSet, storage);
    if (candidateSet.documentProjectionId !== base.documentProjectionId || candidateSet.documentProjectionHash !== base.documentProjectionHash) {
      fail("Candidate document base differs.", "DOCUMENT_CHANGE_CANDIDATE_BASE_DRIFT");
    }
    for (const item of candidateSet.candidates) {
      if (item.proposedContent === null) preimage.delete(item.relativePath);
      else preimage.set(item.relativePath, item.proposedContent);
    }
  }
  const target = new Map(next.documents.map((item) => [item.relativePath, item.content]));
  const check = () => {
    const actual = new Map(selected.readPublishedDocuments().map((item) => [item.relativePath, item.content]));
    for (const name of new Set([...preimage.keys(), ...target.keys(), ...actual.keys()])) {
      if (actual.get(name) !== preimage.get(name) && actual.get(name) !== target.get(name)) {
        fail(`Later document edits must be preserved: ${name}`, "DOCUMENT_CHANGE_CANDIDATE_PUBLISHED_DRIFT");
      }
    }
    if (documentProjectionCanonicalJson(selected.readPointer()?.document || null) !== documentProjectionCanonicalJson(current.pointer)) {
      fail("Document pointer changed during application.", "DOCUMENT_CHANGE_CANDIDATE_BASE_DRIFT");
    }
    return actual;
  };
  check();
  const stored = selected.writeProjection(next.documentProjectionId, clone(next));
  verifyDocumentProjection(stored.document, graph, storage);
  if (documentProjectionCanonicalJson(stored.document) !== documentProjectionCanonicalJson(next)) fail("Target projection differs.", "DOCUMENT_PROJECTION_CONFLICT");
  for (const item of next.documents) {
    if (check().get(item.relativePath) !== item.content) selected.publishDocuments([clone(item)]);
  }
  for (const name of preimage.keys()) {
    if (!target.has(name) && check().has(name)) selected.publishDocuments([], { removeRelativePaths: [name] });
  }
  const published = selected.readPublishedDocuments();
  if (publishedDrift(next, published).length) fail("Document publication is incomplete.", "DOCUMENT_PROJECTION_PUBLISH_MISMATCH");
  check();
  const pointer = pointerFor(next, storage);
  if (current.pointer?.documentProjectionId !== next.documentProjectionId) {
    const written = selected.writePointer(clone(pointer));
    verifyDocumentProjectionPointer(written.document, next, storage);
  }
  return { status: "projected", projection: next, pointer, adapter: selected.describe() };
}

export function verifyDocumentProjectionAdapterConformance({ projectRoot, storage, graph, referenceAdapter, candidateAdapter } = {}) {
  verifyTemporalProvenanceGraph(graph);
  const reference = createDocumentProjectionAdapter({ projectRoot, storage, adapter: referenceAdapter });
  const candidate = createDocumentProjectionAdapter({ projectRoot, storage, adapter: candidateAdapter });
  const referenceResult = materializeMarkdownProjection({ projectRoot, storage, graph, adapter: reference });
  const candidateResult = materializeMarkdownProjection({ projectRoot, storage, graph, adapter: candidate });
  if (documentProjectionCanonicalJson(referenceResult.projection) !== documentProjectionCanonicalJson(candidateResult.projection)
    || documentProjectionCanonicalJson(reference.readPublishedDocuments().map(({ relativePath, contentHash, byteLength: bytes }) => ({ relativePath, contentHash, byteLength: bytes })))
      !== documentProjectionCanonicalJson(candidate.readPublishedDocuments().map(({ relativePath, contentHash, byteLength: bytes }) => ({ relativePath, contentHash, byteLength: bytes })))) {
    fail("Document projection adapters produced different semantic Markdown output.", "DOCUMENT_PROJECTION_CONFORMANCE_MISMATCH");
  }
  const payload = {
    schemaVersion: 1,
    kind: "DocumentProjectionConformanceReport",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-document-projection-conformance"), version: DOCUMENT_PROJECTION_ADAPTER_VERSION },
    graphSnapshotId: graph.graphSnapshotId,
    graphSnapshotHash: graph.graphSnapshotHash,
    documentProjectionId: referenceResult.projection.documentProjectionId,
    documentProjectionHash: referenceResult.projection.documentProjectionHash,
    referenceAdapter: reference.describe(),
    candidateAdapter: candidate.describe(),
    semanticIdentity: "adapter-neutral",
    authority: "derived-verification-evidence-only",
    instructionAuthority: false,
    promotionAuthority: false,
  };
  const conformanceReportHash = digest(documentProjectionCanonicalJson(payload));
  return { ...payload, conformanceReportId: `document-projection-conformance-${conformanceReportHash.slice(0, 24)}`, conformanceReportHash };
}

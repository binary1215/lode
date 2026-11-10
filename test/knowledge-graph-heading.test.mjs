import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256Hex as digest } from "../scripts/lib/core/digest.mjs";
import {
  InMemoryMarkdownProjectionAdapter,
  KNOWLEDGE_GRAPH_INDEX_HEADING,
  buildMarkdownDocumentProjection,
  captureDocumentChangeCandidates,
  documentProjectionCanonicalJson,
  inspectMarkdownProjection,
  materializeMarkdownProjection,
} from "../scripts/lib/document-projection-adapter.mjs";
import { initializeProject, inspectProject } from "../scripts/lib/lode-core.mjs";
import { buildTemporalProvenanceGraph } from "../scripts/lib/temporal-provenance.mjs";

// User decision of 2026-11-10: the derived knowledge-graph index is headed
// "LODE Agent derived knowledge graph" in every dialect. Projections stored with
// the heading an earlier version used are still recognised, reported as stale and
// replaced by the next materialization.

const EARLIER = { lode: "Lode Agent derived knowledge graph", head: "HEAD Agent derived knowledge graph" };

function fixture(t, dialect) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `lode-heading-${dialect}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let storage;
  if (dialect === "lode") {
    initializeProject({ root, pluginRoot: path.resolve(import.meta.dirname, ".."), runtimes: ["codex"] });
    storage = inspectProject(root).storage;
    assert.equal(storage.dialect, "lode");
  }
  const files = [
    { path: "src/a.mjs", digest: digest("a"), language: "javascript", classification: "source", symbols: [{ name: "a", kind: "function", line: 1 }] },
  ];
  const graph = buildTemporalProvenanceGraph({ projectId: storage?.projectId || "project-heading-legacy", files, ...(storage ? { storage } : {}) });
  return { root, storage, graph };
}

const rehash = (document, idField, hashField, prefix) => {
  const payload = { ...document };
  delete payload[idField];
  delete payload[hashField];
  const hash = digest(documentProjectionCanonicalJson(payload));
  return { ...payload, [idField]: `${prefix}-${hash.slice(0, 24)}`, [hashField]: hash };
};

// A projection and pointer as an earlier version stored them: identical apart
// from the index heading.
function seedEarlierProjection({ root, storage, graph }, heading) {
  const reference = new InMemoryMarkdownProjectionAdapter({ adapterKind: "reference-memory-markdown" });
  const current = materializeMarkdownProjection({ projectRoot: root, storage, graph, adapter: reference });
  const documents = current.projection.documents.map((item) => {
    if (item.relativePath !== "index.md") return item;
    assert.ok(item.content.startsWith(`# ${KNOWLEDGE_GRAPH_INDEX_HEADING}\n`));
    const content = `# ${heading}${item.content.slice(`# ${KNOWLEDGE_GRAPH_INDEX_HEADING}`.length)}`;
    return { ...item, title: heading, content, contentHash: digest(content), byteLength: Buffer.byteLength(content) };
  });
  const totalBytes = documents.reduce((sum, item) => sum + item.byteLength, 0);
  const earlier = rehash(
    { ...current.projection, documents, summary: { ...current.projection.summary, totalBytes } },
    "documentProjectionId",
    "documentProjectionHash",
    "document-projection",
  );
  const pointer = rehash(
    { ...current.pointer, documentProjectionId: earlier.documentProjectionId, documentProjectionHash: earlier.documentProjectionHash },
    "pointerId",
    "pointerHash",
    "document-projection-pointer",
  );
  const adapter = new InMemoryMarkdownProjectionAdapter({ adapterKind: "earlier-memory-markdown" });
  adapter.projections.set(earlier.documentProjectionId, structuredClone(earlier));
  for (const item of earlier.documents) adapter.published.set(item.relativePath, item.content);
  adapter.pointer = structuredClone(pointer);
  return { adapter, earlier, current: current.projection };
}

for (const dialect of ["lode", "head"]) {
  test(`${dialect}: the index is headed "LODE Agent derived knowledge graph"`, (t) => {
    const { storage, graph } = fixture(t, dialect);
    const index = buildMarkdownDocumentProjection(graph, storage).documents.find((item) => item.relativePath === "index.md");
    assert.equal(KNOWLEDGE_GRAPH_INDEX_HEADING, "LODE Agent derived knowledge graph");
    assert.equal(index.title, KNOWLEDGE_GRAPH_INDEX_HEADING);
    assert.ok(index.content.startsWith(`# ${KNOWLEDGE_GRAPH_INDEX_HEADING}\n`));
  });

  test(`${dialect}: a projection stored with the earlier heading is stale, still accepts edits, and is replaced on rebuild`, (t) => {
    const context = fixture(t, dialect);
    const { root, storage, graph } = context;
    const { adapter, earlier, current } = seedEarlierProjection(context, EARLIER[dialect]);
    assert.notEqual(earlier.documentProjectionId, current.documentProjectionId);

    const inspected = inspectMarkdownProjection({ projectRoot: root, storage, graph, adapter });
    assert.equal(inspected.status, "stale");
    assert.equal(inspected.staleReason, "earlier-index-heading");
    assert.equal(inspected.graphFreshness, "current");
    assert.equal(inspected.documentProjectionId, earlier.documentProjectionId);

    // A user edit on the earlier rendering is still captured against it.
    const original = adapter.published.get("index.md");
    adapter.published.set("index.md", `${original}\nUser note.\n`);
    assert.equal(inspectMarkdownProjection({ projectRoot: root, storage, graph, adapter }).status, "modified");
    const captured = captureDocumentChangeCandidates({ projectRoot: root, storage, graph, adapter, persist: false });
    assert.equal(captured.candidateSet.documentProjectionId, earlier.documentProjectionId);
    assert.deepEqual(
      captured.candidateSet.candidates.map((item) => item.relativePath),
      ["index.md"],
    );
    assert.throws(() => materializeMarkdownProjection({ projectRoot: root, storage, graph, adapter }), { code: "DOCUMENT_PROJECTION_UNREVIEWED_DRIFT" });
    adapter.published.set("index.md", original);

    // The next materialization overwrites the earlier heading.
    const rebuilt = materializeMarkdownProjection({ projectRoot: root, storage, graph, adapter });
    assert.equal(rebuilt.status, "projected");
    assert.equal(documentProjectionCanonicalJson(rebuilt.projection), documentProjectionCanonicalJson(current));
    assert.ok(adapter.published.get("index.md").startsWith(`# ${KNOWLEDGE_GRAPH_INDEX_HEADING}\n`));
    const after = inspectMarkdownProjection({ projectRoot: root, storage, graph, adapter });
    assert.equal(after.status, "current");
    assert.equal(Object.hasOwn(after, "staleReason"), false);
  });

  test(`${dialect}: any other heading is still a semantic mismatch`, (t) => {
    const context = fixture(t, dialect);
    const other = dialect === "lode" ? EARLIER.head : EARLIER.lode;
    for (const heading of [other, "Edited derived knowledge graph"]) {
      const { adapter } = seedEarlierProjection(context, heading);
      for (const run of [
        () => inspectMarkdownProjection({ projectRoot: context.root, storage: context.storage, graph: context.graph, adapter }),
        () => captureDocumentChangeCandidates({ projectRoot: context.root, storage: context.storage, graph: context.graph, adapter, persist: false }),
      ])
        assert.throws(run, { code: "DOCUMENT_PROJECTION_SEMANTIC_MISMATCH" }, heading);
    }
  });
}

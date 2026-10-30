# DocumentProjectionAdapter and deterministic Markdown projection

Status: active alpha contract

Protocol versions:

- `DocumentProjectionAdapter`: `0.1.0`
- deterministic Markdown renderer: `0.1.0`
- `DocumentChangeCandidateSet`: `0.1.0`
- `PostRefreshProjectionPolicy` and receipt: `0.1.0`
- document-change review and application: `0.1.0`

## Purpose and authority boundary

`DocumentProjectionAdapter` turns one verified temporal `GraphSnapshot` into a deterministic human-facing view. The source direction remains:

```text
User-owned Product Canon + observed code + verified lineage
  -> rebuildable GraphSnapshot
  -> verified DocumentProjection
  -> published Markdown view
```

The projection and every published Markdown file are `derived-human-view-only`. They are rebuildable, are not unique authority, and have neither instruction nor promotion authority. A document does not become Product Canon because a person edits it, a provider hosts it, or an agent reads it. Physical paths, adapter names, and future Obsidian vault or Notion page identifiers remain outside `DocumentProjection` semantic identity.

## Active adapter contract

Every adapter must implement:

- `describe()`;
- `readPointer()` / `writePointer()`;
- `readProjection(id)` / `writeProjection(id, projection)`;
- `listProjectionIds()`;
- `readPublishedDocuments()`;
- `publishDocuments(documents, options)`.

Its descriptor must declare:

```text
authority: derived-human-view-only
rebuildable: true
uniqueAuthority: false
instructionAuthority: false
promotionAuthority: false
publishedViewIsCanon: false
inboundEdits: document-change-candidates-only
```

The core rejects missing methods, incompatible versions, authority claims, altered immutable projections, changed rendered bytes, digest-invalid pointers, unsafe relative paths, symlinks in the published tree, and bounded-size violations.

## Deterministic Markdown model

The reference renderer verifies the input `GraphSnapshot`, sorts nodes and edges canonically, and produces:

- `index.md`, containing the exact Project, SourceSnapshot, and GraphSnapshot identities plus node/relation summaries;
- chunked `nodes/*.md` pages grouped by semantic node kind;
- chunked `relations/*.md` pages grouped by canonical relation type;
- deterministic node anchors and links from relation endpoints back to their node pages;
- an explicit warning that the view is derived and non-authoritative.

Every output document records its relative path, title, exact UTF-8 content, SHA-256 content digest, and byte length inside an immutable `DocumentProjection`. The content-derived projection identity includes the renderer protocol, GraphSnapshot identity, all rendered content, summary, and authority flags. It excludes the adapter kind and physical location. Rendering is bounded to 500 rows per page, 4,096 documents, 1 MiB per document, and 64 MiB total.

The local adapter stores:

```text
.lode/document-projection/markdown/current.json
.lode/document-projection/markdown/snapshots/document-projection-<digest>.json
.lode/generated/knowledge/index.md
.lode/generated/knowledge/nodes/*.md
.lode/generated/knowledge/relations/*.md
```

The snapshot and pointer are verification artifacts. `.lode/generated/knowledge/` is the replaceable human working view. The pointer advances only after the immutable projection and every published document verify successfully.

## Explicit and policy-driven generation

Markdown generation remains explicitly available:

```text
node scripts/lode.mjs world-docs-build <project>
node scripts/lode.mjs world-docs-status <project>
```

`world-docs-build` requires a current, digest-verified World Model. `world-docs-status` separately reports World Model freshness, GraphSnapshot binding, immutable projection verification, and published-view drift. Important states are:

- `not-materialized`: no pointer or published Markdown exists;
- `unmanaged`: Markdown exists without a verified base projection;
- `current`: projection, published bytes, and current graph agree;
- `stale`: the projection belongs to a different GraphSnapshot;
- `source-stale`: the projection matches the stored graph but the working project changed since indexing;
- `modified`: the published view differs from its immutable base projection.

Missing output can be regenerated. Digest mismatch, semantic divergence, unsafe paths, or adapter authority escalation fail closed. A newer verified graph may replace a clean published view, but the core never overwrites a modified view.

The effective post-refresh policy defaults to `manual`. An explicit user-selected `automatic` policy may invoke the same deterministic materialization only after incremental refresh has verified and advanced the World Model. The policy inspects the base view before refresh, captures current edits as immutable candidates, and records a separate content-derived outcome afterward. Invalid policy or projection state cannot stop or rewrite observed-state refresh. See [`post-refresh-projection.md`](post-refresh-projection.md).

## Inbound edits are candidates

When the published Markdown differs from its immutable base, regeneration fails with `DOCUMENT_PROJECTION_UNREVIEWED_DRIFT`. The user can explicitly capture the differences:

```text
node scripts/lode.mjs world-docs-capture <project>
node scripts/lode.mjs world-docs-candidates <project> --candidate-set <document-change-candidate-set-id>
```

Capture creates an immutable, content-derived `DocumentChangeCandidateSet` under `.lode/document-changes/candidate-sets/`. Each added, modified, or removed path records the exact base/proposed content and digests, source projection, GraphSnapshot, and false instruction/promotion flags. Capture itself does not change Product Canon, the graph, source code, or an execution artifact. A separate scoped ReviewDecision can reject the set or accept it only alongside a complete explicit Product Model; see [`document-change-review.md`](document-change-review.md). Typed MCP may explicitly build the deterministic Markdown projection through `lode_markdown_projection_build`, and read-only MCP tools inspect projection, candidate, review, and application status. MCP still cannot capture inbound edits, review document-change candidates, or apply a document decision.

## Conformance and deferred work

`LocalMarkdownProjectionAdapter` is the durable reference implementation. `InMemoryMarkdownProjectionAdapter` is the non-durable conformance implementation. `verifyDocumentProjectionAdapterConformance` proves identical content-derived projection identity and published content digests across both adapters.

The following remain deferred:

- projection of document artifacts and their later review receipts into a subsequent GraphSnapshot;
- `ObsidianVaultProjectionAdapter` and `NotionProjectionAdapter`;
- bidirectional synchronization or conflict resolution;
- treating generated pages as Context Compiler input.

Future adapters must preserve this renderer's semantic identities or declare a separately versioned format/renderer contract. Provider page IDs, vault roots, timestamps, and transport diagnostics cannot enter core projection identity.

## Path bases and existing Projects

Project-internal references use validated Project-root-relative `/` paths. Generated
Markdown `relativePath` starts at the published root; each href starts at its
containing document. A `../` document link does not permit `..` in a durable selector.

Runtime `project_root`, stored `projectRoot`, installation `pluginRoot` and root-derived
identities remain bound to the verified absolute root and actual Session owner. New
Projects use `.lode/`; existing `.head/` records and exact selectors stay unchanged.
These are existing path contracts, not workspace relocation or automatic repair.


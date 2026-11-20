// Short result shapes of the main read tools, returned by lode_tools_discover
// for an exact name so a read chain can name its take without guessing.
// test/tools-read-chain.test.mjs checks each shape against real answers.
import { resolveOperation } from "./lode-operation-contract.mjs";

const SHAPES = Object.freeze({
  lode_product_graph_query: Object.freeze({
    rows: "rows",
    rowFields: Object.freeze({
      always: Object.freeze(["depth", "kind", "text"]),
      nodeRows: Object.freeze(["id", "nodeType", "changedSinceBaseline", "confirmation"]),
      sometimes: Object.freeze(["score", "exact", "matchedTerms", "edge", "onPath", "group", "hint", "detail", "marker"]),
    }),
    rowKinds: Object.freeze(["text", "node", "group", "more"]),
    fieldValues: Object.freeze({
      changedSinceBaseline: Object.freeze(["changed", "added", "reachChanged", "unchanged"]),
      confirmation: Object.freeze(["neverChecked", "changedSinceCheck", "textChanged", "otherReader"]),
    }),
    header: "header",
    title: "title",
    paging: Object.freeze({ total: "page.total", remaining: "page.remaining", next: "page.nextMcpArguments" }),
    build: Object.freeze({ builtAt: "builtAt", buildSha256: "buildSha256", freshness: "freshness.text" }),
    notes:
      "nodeType and changedSinceBaseline are on rows whose id is a graph node (not @ starts); changedSinceBaseline only when the build was compared with a baseline; confirmation only when the node is in one of the listed confirmation lists.",
  }),
  lode_project_graph: Object.freeze({
    rows: "nodes",
    otherLists: Object.freeze({ edges: "edges" }),
    rowFields: Object.freeze({
      always: Object.freeze(["nodeId", "kind", "views", "reviewState", "freshness", "integrity", "sourceReference", "excerpt"]),
      edges: Object.freeze(["edgeId", "type", "from", "to", "endpointStates", "provenance"]),
    }),
    paging: Object.freeze({ truncated: "truncated", omitted: "omittedMatchCount", coverage: "coverage.state" }),
    notes: "Bounded by max_nodes and max_edges; inventory_page with inventory_cursor pages the inventory view.",
  }),
  lode_session_work_read: Object.freeze({
    rows: "records",
    otherLists: Object.freeze({ todos: "todoContext.items" }),
    rowFields: Object.freeze({
      always: Object.freeze(["evidenceId", "evidenceDigest", "sessionId", "recordedAt", "content", "references"]),
      content: Object.freeze(["summary", "judgments", "observedWork", "pending", "unknowns", "suggestedFollowUp", "workTopics"]),
    }),
    paging: Object.freeze({ next: "nextAfterEvidenceId", argument: "after_evidence_id", omitted: "omissions" }),
    notes: "Use take content fields with pick; nextAfterEvidenceId is passed as after_evidence_id (a chain does not follow it on its own).",
  }),
});

export function resultShapeFor(name) {
  return SHAPES[resolveOperation(name)?.semanticName ?? name] ?? null;
}

export const RESULT_SHAPE_TOOLS = Object.freeze(Object.keys(SHAPES));

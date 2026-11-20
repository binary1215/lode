// Short result shapes of the main read tools, returned by lode_tools_discover
// for an exact name so a read chain can name its take without guessing.
// `chain` declares how a tool says "no answer", "more pages" and "cut"; only a
// tool with that declaration can be an inner call of lode_tools_read_chain.
// test/tools-read-chain.test.mjs holds every declaration against real answers.
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
      confirmationComparison: Object.freeze(["compared", "not-read", "absent"]),
    }),
    header: "header",
    title: "title",
    paging: Object.freeze({ total: "page.total", remaining: "page.remaining", next: "page.nextMcpArguments" }),
    build: Object.freeze({ builtAt: "builtAt", buildSha256: "buildSha256", freshness: "freshness.text", confirmationComparison: "confirmationComparison" }),
    notes:
      "nodeType and changedSinceBaseline are on rows whose id is a graph node (not @ starts); changedSinceBaseline only when the build was compared with a baseline. confirmation names the confirmation lists that name the node (a 뜻 line of a 기능, or a document row from or to it). Only when confirmationComparison is compared does an absent confirmation mean either still current or nothing to check: the build keeps only a count of current ones. buildSha256 names every build file and the baseline the answer read.",
    chain: Object.freeze({
      rows: "rows",
      answered: Object.freeze({ field: "status", in: Object.freeze(["answered"]) }),
      refused: Object.freeze({ field: "status", in: Object.freeze(["refused"]) }),
      basisChanged: Object.freeze({ field: "status", in: Object.freeze(["basis-changed"]) }),
      code: Object.freeze(["code"]),
      message: Object.freeze(["message", "text"]),
      pages: Object.freeze({ next: "page.nextMcpArguments", remaining: "page.remaining" }),
      // Every way an answer says rows or content are missing from itself.
      signals: Object.freeze([
        Object.freeze({ name: "page.remaining", field: "page.remaining", gt: 0, handledBy: "pages" }),
        Object.freeze({ name: "rows[].kind=more", rows: "rows", field: "kind", eq: "more", except: Object.freeze({ field: "hint", contains: "--cursor" }) }),
        Object.freeze({ name: "rows[].detail.before.status", rows: "rows", field: "detail.before.status", in: Object.freeze(["partial", "unavailable"]) }),
        Object.freeze({ name: "rows[].detail.after.status", rows: "rows", field: "detail.after.status", in: Object.freeze(["partial", "unavailable"]) }),
      ]),
      identity: "buildSha256",
      // What an impact answer states about the comparison itself (verified or partial), given in the basis entry.
      stated: Object.freeze({ impact: "impact.status", impactReasons: "impact.compatibility.reasons" }),
    }),
  }),
  lode_project_graph: Object.freeze({
    rows: "nodes",
    otherLists: Object.freeze({ edges: "edges" }),
    rowFields: Object.freeze({
      always: Object.freeze(["nodeId", "kind", "views", "reviewState", "freshness", "integrity", "sourceReference", "excerpt"]),
      edges: Object.freeze(["edgeId", "type", "from", "to", "endpointStates", "provenance"]),
    }),
    paging: Object.freeze({ truncated: "truncated", omitted: "omittedMatchCount", coverage: "coverage.state" }),
    modes: Object.freeze({
      inventory: Object.freeze({
        when: "inventory_page: true",
        rows: "inventoryPage.rows",
        rowFields: Object.freeze(["path", "byteObservation", "exactRead"]),
        next: "inventoryPage.next",
        coverage: "inventoryPage.coverage.status",
        chain: "not an inner call of lode_tools_read_chain",
      }),
    }),
    notes:
      "Bounded by max_nodes and max_edges: truncated and omittedMatchCount say what was left out. status source-fallback is no graph answer. With inventory_page true the rows are in inventoryPage.rows and the next call in inventoryPage.next.",
    chain: Object.freeze({
      rows: "nodes",
      answered: Object.freeze({ field: "status", in: Object.freeze(["available"]) }),
      code: Object.freeze(["sourceFallback.reasonCodes.0", "integrity.excluded.0.reasonCode", "status"]),
      message: Object.freeze(["sourceFallback.action", "status"]),
      // Every way an answer says rows or content are missing from itself. The
      // coverage state is partial by design, so a chain over this tool never
      // says everything was seen.
      signals: Object.freeze([
        Object.freeze({ name: "truncated", field: "truncated", eq: true }),
        Object.freeze({ name: "omittedMatchCount", field: "omittedMatchCount", gt: 0 }),
        Object.freeze({ name: "boundary.items", field: "boundary.items", nonEmpty: true }),
        Object.freeze({ name: "boundary.omittedCount", field: "boundary.omittedCount", gt: 0 }),
        Object.freeze({ name: "unmatchedAnchorIds", field: "unmatchedAnchorIds", nonEmpty: true }),
        Object.freeze({ name: "integrity.excluded", field: "integrity.excluded", nonEmpty: true }),
        Object.freeze({ name: "coverage.state", field: "coverage.state", in: Object.freeze(["partial", "unavailable"]) }),
        Object.freeze({ name: "coverage.inventoryBoundReached", field: "coverage.inventoryBoundReached", eq: true }),
        Object.freeze({ name: "sourceFallback.needed", field: "sourceFallback.needed", eq: true }),
        Object.freeze({ name: "sourceFallback.excludedInputs", field: "sourceFallback.excludedInputs", nonEmpty: true }),
        Object.freeze({ name: "nodes[].contentPartial", rows: "nodes", field: "contentPartial", eq: true }),
      ]),
      // What it says about its own coverage, given once per tool in the basis entry.
      stated: Object.freeze({
        coverage: "coverage.state",
        sourceFallbackNeeded: "sourceFallback.needed",
        excluded: "integrity.excluded",
        reasonCodes: "sourceFallback.reasonCodes",
      }),
      refusedArguments: Object.freeze(["inventory_page", "inventory_paths", "inventory_cursor"]),
    }),
  }),
  lode_session_work_read: Object.freeze({
    rows: "records",
    otherLists: Object.freeze({ todos: "todoContext.items" }),
    rowFields: Object.freeze({
      always: Object.freeze(["evidenceId", "evidenceDigest", "sessionId", "recordedAt", "content", "references"]),
      content: Object.freeze(["summary", "judgments", "observedWork", "pending", "unknowns", "suggestedFollowUp", "workTopics"]),
    }),
    paging: Object.freeze({ next: "nextAfterEvidenceId", argument: "after_evidence_id", omitted: "omissions" }),
    notes:
      "Session-bound: not an inner call of lode_tools_read_chain. nextAfterEvidenceId is passed as after_evidence_id; omissions counts what was not inspected or did not fit.",
  }),
});

export function resultShapeFor(name) {
  const shape = SHAPES[resolveOperation(name)?.semanticName ?? name];
  if (!shape) return null;
  const { chain: _chain, ...shown } = shape;
  return { ...shown, chainable: Boolean(shape.chain) };
}

// The completeness declaration a read chain uses for an inner call, or null.
export function chainCompletenessFor(name) {
  return SHAPES[resolveOperation(name)?.semanticName ?? name]?.chain ?? null;
}

export const RESULT_SHAPE_TOOLS = Object.freeze(Object.keys(SHAPES));

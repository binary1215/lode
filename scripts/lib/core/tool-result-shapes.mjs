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
      sometimes: Object.freeze([
        "score",
        "exact",
        "matchedTerms",
        "edge",
        "onPath",
        "group",
        "hint",
        "detail",
        "marker",
        "missing",
        "continues",
        "repeats",
        "via",
        "역할",
        "judgement",
        "boundary",
        "role",
        "notExpanded",
        "step",
        "relation",
        "evidence",
        "entryStops",
        "machine",
        "lostCalls",
        "lostCallsIn",
        "mayBeThis",
      ]),
    }),
    rowKinds: Object.freeze(["text", "node", "group", "more"]),
    fieldValues: Object.freeze({
      changedSinceBaseline: Object.freeze(["changed", "added", "reachChanged", "unchanged"]),
      confirmation: Object.freeze(["neverChecked", "changedSinceCheck", "textChanged", "otherReader"]),
      confirmationComparison: Object.freeze(["compared", "partial", "not-read", "absent"]),
      baselineComparison: Object.freeze(["compared", "baseline-moved", "no-baseline", "absent"]),
      // missing (on a row, or on the answer for its title): kind, the site that wrote it, and the
      // fields it knows (left, shown, total, present, read, check, list, with, code, rows). rowCap counts
      // hidden node rows and has left only when that count is every hidden node row.
      missingKinds: Object.freeze(["cut", "rowCap", "connectionsCut", "notChecked", "notCompared", "recordLimit", "recordUnread"]),
      continues: Object.freeze(["nextPage"]),
      repeats: Object.freeze(["earlierPage"]),
      via: Object.freeze(["처리", "입구"]),
      역할: Object.freeze(["처리", "입구"]),
      role: Object.freeze(["처리", "입구"]),
      notExpanded: Object.freeze(["otherFunction", "expandedAbove"]),
      relation: Object.freeze(["calls", "shows"]),
    }),
    header: "header",
    title: "title",
    paging: Object.freeze({ total: "page.total", remaining: "page.remaining", next: "page.nextMcpArguments" }),
    build: Object.freeze({
      builtAt: "builtAt",
      buildSha256: "buildSha256",
      freshness: "freshness.text",
      confirmationComparison: "confirmationComparison",
      baselineComparison: "baselineComparison",
    }),
    notes:
      "nodeType and changedSinceBaseline are on rows whose id is a graph node (not @ starts); changedSinceBaseline only when the build was compared with a baseline. confirmation names the confirmation lists that name the node (a 뜻 line of a 기능, or a document row from or to it). Only when confirmationComparison is compared does an absent confirmation mean either still current or nothing to check: the build keeps only a count of current ones; partial means the build read only the first confirmation records by name. baselineComparison baseline-moved means the baseline was moved after the build. A row a later page repeats from an earlier page carries repeats: earlierPage. A reach row says through which role of a 기능→코드 edge its node is reached (via: 처리 or 입구; on a reach <code> answer, via 입구 means only through 입구); a 기능→코드 child row carries 역할. A row of an edge written by hand carries judgement: true; a row that says where reach stopped at a boundary (경계에서 멈춤) or what a crossed boundary would add carries boundary {from, to, 설명}. A reach or node answer of a 기능 with 입구 carries entryStops on its stop row (the nodes where the walk from 입구 stopped, each another 기능's 처리 코드, with those 기능). A reach answer (on its last page) or a node answer of a 기능 whose reached code holds unresolved calls that could be product code carries lostCalls {count, nodes: [{id, count, callees: [{callee, line}]}]} on its count row and lostCallsIn (the node ID) on each node row under it; a tree code row's unresolved calls come as a text row carrying lostCalls {count, byReason, callees}. On a code node with no resolved caller, an up, reach or node answer (and an impact row) may carry mayBeThis {count, bare?: {count, places: [{path, line, callee}]}, member?: {count, places, sameName}}: unresolved bare calls of the declaration's name and, for a member, calls of its name on a receiver of unknown type with how many declarations share the name; a possibility only. A 기능→화면요소 child row carries evidence (its 근거) and, when the machine found it from a run or the code rather than a document row, machine: true; its text then says 기계가 찾음 with the 근거 instead of a document position. A tree answer's role heading carries role; a node it names but does not expand carries notExpanded (otherFunction: another 기능's 처리 코드; expandedAbove). A user answer's step heading carries step (its number); a 기능 row carries relation (calls or shows) and, for shows, evidence (근거 of the 기능→화면요소 edge: 문서, 실행 …, 코드 …). changes takes the run lists runsCurrent and runsStale (run records, apart from the baseline); a 기능 whose newest run no longer holds carries {실행: 실행 뒤 코드가 바뀜} in its line. buildSha256 names every build file and the baseline the answer read.",
    chain: Object.freeze({
      rows: "rows",
      answered: Object.freeze({ field: "status", in: Object.freeze(["answered"]) }),
      refused: Object.freeze({ field: "status", in: Object.freeze(["refused"]) }),
      basisChanged: Object.freeze({ field: "status", in: Object.freeze(["basis-changed"]) }),
      code: Object.freeze(["code"]),
      message: Object.freeze(["message", "text"]),
      pages: Object.freeze({ next: "page.nextMcpArguments", remaining: "page.remaining" }),
      // A page continuation row (continues: nextPage) is a marker, not a row.
      pageMarker: Object.freeze({ field: "continues", eq: "nextPage" }),
      // A later page marks the rows it repeats from an earlier page (its root,
      // headings, the group line its first item continues).
      pageRepeats: Object.freeze({ field: "repeats", eq: "earlierPage" }),
      // The tool's own item count for the paged list.
      items: "page.total",
      // The ways an answer says rows or content are missing from itself. The
      // walk marks every cut and "not checked / not compared" it writes in
      // prose (rows[].missing, and missing on the answer for its title).
      signals: Object.freeze([
        Object.freeze({ name: "page.remaining", field: "page.remaining", gt: 0, handledBy: "pages" }),
        Object.freeze({ name: "missing", field: "missing", nonEmpty: true }),
        Object.freeze({ name: "rows[].missing", rows: "rows", field: "missing", nonEmpty: true }),
        Object.freeze({ name: "rows[].detail.before.status", rows: "rows", field: "detail.before.status", in: Object.freeze(["partial", "unavailable"]) }),
        Object.freeze({ name: "rows[].detail.after.status", rows: "rows", field: "detail.after.status", in: Object.freeze(["partial", "unavailable"]) }),
        Object.freeze({ name: "confirmationComparison", field: "confirmationComparison", ne: "compared" }),
        Object.freeze({ name: "baselineComparison", field: "baselineComparison", ne: "compared" }),
        Object.freeze({ name: "impact.status", field: "impact.status", in: Object.freeze(["unavailable", "partial"]) }),
      ]),
      identity: "buildSha256",
      // What the answer states about its own basis, given once per tool in the
      // basis entry (only what an answer carries).
      stated: Object.freeze({
        confirmationComparison: "confirmationComparison",
        baselineComparison: "baselineComparison",
        impact: "impact.status",
        impactReasons: "impact.compatibility.reasons",
      }),
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
      // source-fallback is an answer with no graph match: its own signals say why.
      answered: Object.freeze({ field: "status", in: Object.freeze(["available", "source-fallback"]) }),
      code: Object.freeze(["sourceFallback.reasonCodes.0", "integrity.excluded.0.reasonCode", "status"]),
      message: Object.freeze(["sourceFallback.action", "status"]),
      // Ways an answer says rows or content are missing from itself (not
      // exhaustive). The coverage state is partial by design, so a chain over
      // this tool always has reasons in knownMissing.
      signals: Object.freeze([
        Object.freeze({ name: "status=source-fallback", field: "status", eq: "source-fallback" }),
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
        Object.freeze({ name: "nodes[].directionContentCoverage.partial", rows: "nodes", field: "directionContentCoverage.partial", eq: true }),
        Object.freeze({ name: "nodes[].workContentCoverage.partial", rows: "nodes", field: "workContentCoverage.partial", eq: true }),
        Object.freeze({
          name: "summary.directionReferences[].contentCoverage.partial",
          rows: "summary.directionReferences",
          field: "contentCoverage.partial",
          eq: true,
        }),
        Object.freeze({ name: "boundary.omittedAnchorCount", field: "boundary.omittedAnchorCount", gt: 0 }),
        Object.freeze({ name: "integrity.omittedVerifiedRecordPathCount", field: "integrity.omittedVerifiedRecordPathCount", gt: 0 }),
        Object.freeze({ name: "coverage.layers[].status", rows: "coverage.layers", field: "status", in: Object.freeze(["absent", "unavailable", "partial"]) }),
      ]),
      // What it says about its own coverage, given once per tool in the basis entry.
      stated: Object.freeze({
        coverage: "coverage.state",
        sourceFallbackNeeded: "sourceFallback.needed",
        excluded: "integrity.excluded",
        reasonCodes: "sourceFallback.reasonCodes",
        status: "status",
        unmatchedAnchorIds: "unmatchedAnchorIds",
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

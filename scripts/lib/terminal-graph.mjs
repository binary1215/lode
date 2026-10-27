// Presentation only: consumes the already selected graph/A explanation. No
// readers, traversal, state, model calls, color or effect controls belong here.
import { organizeSelectedWorkBodies, workBodyTuples } from "./session-work-body-organization.mjs";
export function terminalColumns(value) {
  const width = Number(value ?? process.stdout.columns ?? process.env.COLUMNS ?? 88);
  return Number.isFinite(width) ? Math.max(16, Math.min(240, Math.floor(width))) : 88;
}

export function inertTerminalText(value) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu,
    c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).replaceAll("\t", "    ");
}
const inline = value => inertTerminalText(value).replaceAll("\n", "\\n");
// Opaque identifiers may have long kind prefixes. Show the trailing body,
// marking the abbreviation, without interpreting or changing the exact ID.
const revisionPreview = value => {
  const text = String(value);
  return inline(text.length > 16 ? `…${text.slice(-16)}` : text);
};
const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function cellWidth(grapheme) {
  // Conservative fallback, not a terminal/font measurement. Never truncate
  // evidence. Combining sequences stay together; CJK/emoji get two columns.
  if (/^\p{Mark}+$/u.test(grapheme)) return 0;
  return /[\p{Extended_Pictographic}\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff01-\uff60\uffe0-\uffe6]/u.test(grapheme) ? 2 : 1;
}
function wrap(text, columns, prefix = "", continuation = prefix) {
  const result = [], parts = [...segments.segment(text)].map(item => item.segment);
  let start = 0, lead = prefix;
  do {
    let end = start, used = lead.length, space = -1;
    while (end < parts.length && (used + cellWidth(parts[end]) <= columns || end === start)) {
      used += cellWidth(parts[end]); if (/^\s+$/u.test(parts[end])) space = end + 1; end++;
    }
    if (end < parts.length && space > start) end = space;
    result.push(lead + parts.slice(start, end).join("")); start = end; lead = continuation;
  } while (start < parts.length);
  return result;
}
export function terminalBlock(label, value, columns = terminalColumns()) {
  return [...wrap(inline(label), columns, "", "  "), ...inertTerminalText(value).split("\n").flatMap(line => wrap(line, columns, "  | "))].join("\n") + "\n";
}

const canonFields = ["name", "statement", "description", "status", "parentFeatureGroupKeys", "featureGroupKeys", "capabilityKeys", "governedBy", "appliesTo"];
const canonValue = value => value == null ? "Not present" : Array.isArray(value)
  ? value.map(item => typeof item === "string" ? item : `${item.kind}: ${item.key}`).join("; ") || "(none)" : value === "" ? "(empty)" : String(value);

export function formatTerminalGraph(value, { columns, diagnostics = false } = {}) {
  if (value?.kind !== "ProjectGraphDiscoveryProjection" || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) return null;
  const width = terminalColumns(columns), out = [], refs = new Map(), sessions = new Map();
  const row = text => out.push(...wrap(inline(text), width, "", "  "));
  const block = (label, text) => { if (text != null) out.push(terminalBlock(label, text, width).slice(0, -1)); };
  const list = (label, items) => { if (Array.isArray(items)) for (const item of items) block(label, typeof item === "string" ? item : JSON.stringify(item)); };
  const gap = item => {
    if (!item) return;
    const code = item.reasonCode || "SOURCE_UNAVAILABLE";
    const explanations = {
      ENOENT: "Path not found in this read; deletion or rename is not established.",
      EACCES: "Read permission denied; no alternate read bypass was used.",
      EPERM: "The local operation was denied; no alternate read bypass was used.",
      SOURCE_BYTE_BOUND: "Exact source exceeds the byte bound; no truncated original was compared.",
      SOURCE_READ_DRIFT: "Source changed during the read; retry the same exact selection when stable.",
      LOCAL_GIT_READ_BUDGET_REACHED: "Local history command budget exhausted; narrow the selected paths or anchors and retry.",
      LOCAL_GIT_READ_TIMEOUT: "Local Git read timed out; retry or inspect the exact original locally.",
      LOCAL_GIT_OUTPUT_BYTE_BOUND: "Local Git output exceeded its byte bound; no partial blob was compared.",
      LOCAL_GIT_UNAVAILABLE: "Local Git could not be started; retained historical bytes were not verified.",
      LOCAL_GIT_NOT_A_REPOSITORY: "This folder was not recognized as a Git repository; no local historical bytes were supplied.",
      LOCAL_GIT_COMMAND_FAILED: "Local Git could not supply the requested evidence; absence is not established.",
      RETAINED_SOURCE_SNAPSHOT_LOOKUP_BUDGET_REACHED: "Retained snapshot lookup exhausted its inspection budget; the requested pair may remain outside it.",
      REQUESTED_RETAINED_SOURCE_SNAPSHOT_NOT_FOUND: "No verified match in the retained local inventory; historical absence is not established.",
      WORLD_MODEL_SNAPSHOT_MISSING: "The recorded exact World snapshot is missing locally; no different snapshot was substituted.",
      EXACT_HISTORICAL_BYTES_NOT_RETAINED_IN_BOUNDED_HISTORY: "Exact historical bytes were not found in the bounded local history; older evidence may exist elsewhere.",
    };
    block("Evidence gap", [code, item.path, explanations[code], item.uninspectedSnapshotCount ? `${item.uninspectedSnapshotCount} snapshots not inspected` : null].filter(Boolean).join("; "));
  };
  for (const [i, node] of value.nodes.entries()) if (node?.nodeId) refs.set(node.nodeId, [...(refs.get(node.nodeId) || []), `[${i + 1}]`]);
  const ref = id => refs.get(id)?.length === 1 ? refs.get(id)[0] : `${refs.has(id) ? "ambiguous" : "outside selection"}: ${inline(id)}`;
  const sessionRef = id => {
    if (!id) return "owner unknown";
    if (!sessions.has(id)) sessions.set(id, `S${sessions.size + 1}`);
    return sessions.get(id);
  };
  const typedWork = node => node?.kind === "Evidence" && node.subtype === "SessionWorkEvidence" && node.origin?.layer === "sessionWork";
  for (const node of value.nodes) sessionRef(node?.sessionId || node?.ownerSessionId);
  row(`Selected connections: ${value.nodes.length} records, ${value.edges.length} directed edges`);
  if (value.status) row(`Graph observation: ${inline(value.status)}`);
  if (value.query?.query) block("Question", value.query.query);
  if (value.basis?.projectId) block("Project", value.basis.projectId);
  if (!value.edges.length) row("No selected edges; this does not prove absence.");
  for (const [i, edge] of value.edges.entries()) {
    row(`e${i + 1}  ${ref(edge?.from)} --${inline(edge?.type || edge?.kind || "unknown relation")}--> ${ref(edge?.to)}`);
    if (edge?.historical || edge?.status || edge?.state || edge?.reviewState || edge?.freshness) row(`  edge state: ${[edge.historical ? "historical" : null, edge.status, edge.state, edge.reviewState, edge.freshness].filter(Boolean).map(inline).join("; ")}`);
    for (const state of edge?.endpointStates || []) if (!refs.has(state.nodeId))
      block(`Outside endpoint ${inline(state.nodeId)}`, [state.reviewState, state.freshness, state.revisionId].filter(Boolean).join("; "));
  }
  const workGroups = organizeSelectedWorkBodies(workBodyTuples(value.nodes, { projectId: value.basis?.projectId, bodyKey: "workContent" })
    .filter((_, index) => typedWork(value.nodes[index])));
  if (workGroups.groups.length) row("Declared historical work groups; navigation only, not current tasks or activity.");
  for (const [index, group] of workGroups.groups.entries()) {
    row(`Work group G${index + 1}: ${sessionRef(group.sessionId)}; ${group.rootKind} root ${group.rootBodyIndex === null ? "outside selection (exact reference in diagnostics)" : `[${group.rootBodyIndex + 1}]`}`);
    row(`  Members: ${group.recordIndices.map(i => `[${i + 1}]`).join(", ")}; bodies appear once below.`);
  }
  // Index every returned record, without merging by title/path/layer or inventing a tree.
  for (const [i, node] of value.nodes.entries()) {
    row(""); row(`[${i + 1}] ${inline(node?.kind || "Unrecognized record")} ${inline(node?.name || node?.title || node?.path || "")}`);
    if (!node || typeof node !== "object") { block("Unrecognized record", JSON.stringify(node)); continue; }
    const states = [node.origin?.layer ? `layer ${inline(node.origin.layer)}` : null, node.historical ? "historical" : null, node.status, node.state, node.disposition, node.applicationStatus, node.snapshotState, node.sourceCurrentness, node.reviewState, node.freshness,
      node.contentPartial || node.workContentCoverage?.partial || node.directionContentCoverage?.partial ? "partial text" : null].filter(item => typeof item === "string" && item.length);
    if (states.length) row(`  ${states.map(inline).join("; ")}`);
    if (node.projectId && node.projectId !== value.basis?.projectId) block("Record Project", node.projectId);
    const session = node.sessionId || node.ownerSessionId;
    if (session) row(`  Logical Session ${sessionRef(session)}`);
    if (node.revisionId) row(`  Revision ${revisionPreview(node.revisionId)} (short identifier; exact value in structured data)`);
    if (node.workContent && typedWork(node)) {
      row("  Agent-authored work evidence; not a captured user message.");
      block("Recorded work", node.workContent.summary);
      list("Authored topic (navigation only)", node.workContent.workTopics);
      list("Observed work", node.workContent.observedWork);
      list("Pending", node.workContent.pending); list("Unknown", node.workContent.unknowns);
      list("Suggested follow-up (historical; not permission)", node.workContent.suggestedFollowUp);
      if (node.workContent.executionObservation) {
        block("Historical execution observation (not live activity or success)", node.workContent.executionObservation.state);
        if (node.workContent.executionObservation.target) block("Exact observed target", ref(node.workContent.executionObservation.target.evidenceId));
      }
      for (const judgment of node.workContent.judgments || []) {
        block("Recorded judgment", judgment.assessment); block("Recorded reason (not proven cause)", judgment.reason); list("Alternative", judgment.alternatives);
      }
      for (const [index, todo] of (node.workContent.todos || []).entries()) {
        block(`Recorded Todo ${index}`, `${todo.todoId} [${todo.status}; ${todo.origin}] — historical declaration`);
        block("Task", todo.task);
        for (const key of ["nextAction", "reason", "progress", "priority", "prior", "resolves", "relatedEvidence"]) if (Object.hasOwn(todo, key)) {
          block(key, typeof todo[key] === "string" ? todo[key] : JSON.stringify(todo[key]));
        }
      }
      if (node.workContent.todos?.length) block("Todo provenance", "Prior/reference currentness and unseen successors are unknown here; no current-state or completion inference.");
    }
    if (node.workContent && !typedWork(node)) block("Unverified work-shaped fields (not agent-authored evidence)", JSON.stringify(node.workContent, null, 2));
    for (const excerpt of node.workContentExcerpts || []) {
      const location = `${excerpt.field}${excerpt.index == null ? "" : `[${excerpt.index}]`}${excerpt.subfield ? `.${excerpt.subfield}` : ""}${excerpt.alternativeIndex == null ? "" : `[${excerpt.alternativeIndex}]`}`
        + (excerpt.field === "todos" ? ` · ${excerpt.todoId} [${excerpt.status}; ${excerpt.origin}]` : "");
      block(`Partial original ${location}: characters ${excerpt.start}-${excerpt.end} of ${excerpt.totalCharacters}`, excerpt.text);
    }
    for (const reference of node.referenceEvidence || []) {
      block("Historical reference (not reconstructed content)", [reference.path, reference.kind, reference.status, reference.currentness, reference.reasonCode,
        reference.historicalContentAvailable === false ? "historical content unavailable" : null,
        reference.contentReconstructed === false ? "content not reconstructed" : null].filter(Boolean).join("; "));
    }
    if (node.reasonCode) block("Record evidence gap", node.reasonCode);
    const typedDirection = node.kind === "ProjectDirection" && node.origin?.layer === "direction";
    if (node.directionEvidence && typedDirection) {
      row("  Caller-conveyed direction; not a transcript capture.");
      block("Recorded goal", node.directionEvidence.goal); list("Constraint", node.directionEvidence.constraints);
      list("Recorded decision", node.directionEvidence.decisions); list("Cancelled action (not proof of rollback)", node.directionEvidence.cancelledActions);
    }
    if (node.directionEvidence && !typedDirection) block("Unverified direction-shaped fields (not user direction)", JSON.stringify(node.directionEvidence, null, 2));
    if (node.activeRunId) block("Retained Run reference (not live execution)", ref(node.activeRunId));
    if (node.pendingReview) block("Recorded pending review", ref(node.pendingReview));
    for (const field of ["statement", "description", "rationale", "assessment", "outcome", "purpose"])
      if (typeof node[field] === "string" && node[field]) block(field, node[field]);
    if (!node.workContent && !node.directionEvidence && node.excerpt) block("Selected excerpt", node.excerpt);
    const originalPath = node.sourceReference?.path || node.origin?.path;
    if (typeof originalPath === "string" && !/^\.(?:head|lode)\//u.test(originalPath)) block("Original reference", originalPath);
    // Reuse the existing exact-anchor command, never turn an ordinal into an
    // identity or print untrusted strings as executable shell syntax.
    if (typeof node.nodeId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(node.nodeId)) {
      const world = value.basis?.worldModelId;
      block(`Read [${i + 1}] details (replace <project> with this Project folder)`,
        `lode-agent graph-query "<project>" --anchors "${node.nodeId}" --depth 0 --details${/^world-model-[a-f0-9]{24}$/u.test(world || "") ? ` --world-model "${world}"` : ""}`);
    } else if (node.nodeId) block("Exact anchor for graph-query --anchors (quote for your shell)", node.nodeId);
  }
  const context = value.contextLineage;
  if (context) {
    for (const event of context.events || []) {
      row(`Recorded context ${ref(event.nodeId)}; ${[event.reviewState, event.freshness].filter(Boolean).map(inline).join("; ")}`);
      const knownRole = event.sourceRole === "HEAD-authored-P3-work-evidence-not-user-transcript";
      const workAlreadyShown = refs.get(event.nodeId)?.length === 1 && value.nodes.some(node => node?.nodeId === event.nodeId && node.workContent && typedWork(node));
      if (!knownRole || !workAlreadyShown) block("Recorded source role", knownRole
        ? "Agent-authored work evidence; not a captured user transcript"
        : event.sourceRole || "Unknown source role; not authority");
      list("Context cancelled action (not proof of rollback)", event.cancelledActions);
      if (event.missingLink) block("Context evidence gap", event.missingLink);
      if (event.contentPartial || event.titlePartial) row("  Partial context excerpt; inspect the original for more.");
    }
    for (const file of context.files || []) {
      row(""); block("Recorded code context", file.path);
      if (file.currentObservation) {
        block("Current source observation", file.currentObservation.explanation);
        gap({ path: file.path, reasonCode: file.currentObservation.reasonCode });
      }
      for (const candidate of file.renameEvidence?.candidates || []) block("Historical rename candidate (not confirmed continuity)",
        `${candidate.path}; current path, logical identity and cause remain unverified.`);
      if (file.renameEvidence) block("Historical move lookup scope", file.renameEvidence.status === "observed-most-recent-path-change-only"
        ? "Only the most recent recorded path change was checked; other moves remain unknown."
        : "Lookup is partial, unavailable or lacks an exact historical source basis; no absence or continuity established.");
      for (const pair of file.comparisons || []) {
        row(`  ${inline(pair.status)}; file bytes ${inline(pair.fileBytes || "unknown")}; ${inline(pair.scope)}`);
        if (pair.currentMatchesRecordedAfter === false) block("Version gap", `${pair.labels?.after || (pair.scope === "recorded-changeset-snapshot-pair" ? "Recorded after" : "Compared version")} differs from current; later changes remain separate.`);
        if (pair.retainedOriginal) {
          const original = pair.retainedOriginal;
          block("Exact cited historical source (current path unavailable; not an after-version)", original.text);
          block("Historical source location", original.path);
          if (original.omittedLines || original.textTruncated) row(`  Partial historical excerpt: ${original.omittedLines} omitted lines; text truncated ${Boolean(original.textTruncated)}.`);
        }
        for (const symbol of pair.symbols || []) block("Declaration observation (not behavior equivalence)", `${symbol.after?.qualifiedName || symbol.before?.qualifiedName}: ${symbol.observation}${symbol.locationChanged ? "; line location moved" : ""}`);
        if (pair.diff?.changed) {
          const regions = pair.diff.regions?.length ? pair.diff.regions : [{ before: pair.diff.before, after: pair.diff.after }];
          for (const [index, region] of regions.entries()) for (const side of ["before", "after"]) {
            const excerpt = region[side]; if (!excerpt) continue;
            const label = pair.labels?.[side] || (side === "before" ? "Recorded/cited source" : pair.scope === "recorded-changeset-snapshot-pair" ? "Recorded after (not necessarily current)" : "Observed current source");
            block(`${label} - region ${index + 1}/${regions.length}, line ${excerpt.startLine}`, excerpt.text);
            if (excerpt.omittedLines || excerpt.textTruncated) row(`  Partial excerpt: ${excerpt.omittedLines || 0} omitted lines; text truncated ${Boolean(excerpt.textTruncated)}.`);
            for (const omitted of excerpt.omittedRanges || []) row(`  Not shown: lines ${omitted.startLine}-${omitted.endLine}.`);
          }
          if (pair.diff.coverage?.omittedRegionCount) row(`  ${pair.diff.coverage.omittedRegionCount} further changed regions not shown; exact originals remain separate.`);
        }
        const pairGaps = [pair.reasonCode ? { reasonCode: pair.reasonCode } : null, pair.gap, ...(pair.gaps || [])].filter(Boolean);
        for (const item of [...new Map(pairGaps.map(item => [JSON.stringify([item.reasonCode, item.path, item.expectedDigest]), item])).values()]) gap(item);
      }
      block("Unrecorded intervals", file.unrecordedIntervals);
    }
    for (const reason of context.recordedReasons || []) block("Recorded reason (not proven change cause)", reason.reason || reason.rationale || reason.assessment);
    for (const delta of context.canonChanges || []) {
      row(""); row(`Recorded Canon comparison: ${inline(delta.status)}`);
      block("Recorded review reason", delta.rationale);
      for (const change of delta.changes || []) {
        row(`  ${inline(change.field)} / ${inline(change.key)}`);
        for (const field of canonFields) if (JSON.stringify(change.before?.[field]) !== JSON.stringify(change.after?.[field])) {
          block(`${field} - Before`, canonValue(change.before?.[field])); block(`${field} - After`, canonValue(change.after?.[field]));
        }
      }
      if (delta.omittedChangeCount) row(`  ${delta.omittedChangeCount} further changes not included.`);
    }
    if (context.status === "unavailable") block("Context unavailable; independent work continues", context.reasonCode || "Unknown reason");
    for (const item of context.gaps || []) gap(item);
  }
  row(""); row(`Selection: ${inline(value.coverage?.state || value.status || "coverage unknown")}; not proof of completeness or absence.`);
  if (value.truncated || value.coverage?.inventoryBoundReached || value.omittedMatchCount) row(`Partial bounds: truncated ${Boolean(value.truncated)}; inventory bound ${Boolean(value.coverage?.inventoryBoundReached)}; omitted matches ${value.omittedMatchCount || 0}.`);
  for (const layer of value.coverage?.layers || []) if (!["verified", "current"].includes(layer.status)) row(`  ${inline(layer.layer)}: ${inline(layer.status)}${layer.reasonCode ? `; ${inline(layer.reasonCode)}` : ""}`);
  if (value.sourceFallback?.needed) {
    row("Source follow-up needed for this selection; not a new approval gate.");
    block("Source follow-up", value.sourceFallback.action);
    list("Source gap", value.sourceFallback.reasonCodes);
  }
  for (const [key, state] of Object.entries(value.authority || {})) if (state !== false)
    block(`Returned authority condition: ${key} (not a new permission)`, JSON.stringify(state));
  if (value.unmatchedAnchorIds?.length) list("Anchor not found in selected evidence", value.unmatchedAnchorIds);
  row("Links/text differences do not prove cause, completion or current approval.");
  row("Exact IDs, basis and unknown fields remain in structured data; CLI: --json or --diagnostics.");
  if (diagnostics) block("Exact result diagnostics (display only)", JSON.stringify(value, null, 2));
  return out.join("\n") + "\n";
}

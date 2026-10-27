import assert from "node:assert/strict";
import test from "node:test";
import { publicToolName } from "../scripts/lib/lode-artifact-composition.mjs";
import { inertTerminalText } from "../scripts/lib/terminal-graph.mjs";

test("Session list presents existing purpose and stored pointers without live-state inference", () => {
  const value = { projectId: "project-A", defaultSessionId: "session-A", sessions: [
    { sessionId: "session-A", purpose: "Investigate reservation expiry; local only", default: true,
      state: { latestCheckpoint: "checkpoint-A", activeRunId: "run-A", pendingReview: "review-A", extra: { untouched: false } } },
    { sessionId: "session-B", purpose: "Independent documentation", default: false, state: { latestCheckpoint: null } },
  ], unknown: [] };
  const before = JSON.stringify(value), cli = formatCliResult("session-list", value), mcp = formatMcpToolContent("head_session_list", value);
  assert.equal(cli, mcp); assert.equal(JSON.stringify(value), before);
  for (const text of ["Investigate reservation expiry; local only", "Independent documentation", "checkpoint-A", "review-A", "untouched", "unknown"]) assert.ok(cli.includes(text));
  assert.match(cli, /not freshly verified execution or completion/);
  assert.ok(!/verified successful|all work completed|live running/i.test(cli));
});
import path from "node:path";
import { spawnSync } from "node:child_process";
import { catalogTools as tools, dispatch } from "../scripts/mcp-server.mjs";
import {
  formatCliResult,
  formatChangeSetStatus,
  formatConformanceFinding,
  formatConformanceQueue,
  formatConversationRecovery,
  formatFeatureMappingStatus,
  formatMcpToolContent,
  formatOnboardingGuide,
  formatPendingReview,
  formatProjectBootstrap,
  formatProjectStatus,
  formatReviewOutcome,
  formatSessionRestore,
  formatSessionWorkContext,
} from "../scripts/lib/cli-presentation.mjs";

function repeatedWorkFixture() {
  const common = { projectId: "project-owner", sessionId: "session-owner", kind: "Evidence", subtype: "SessionWorkEvidence",
    schemaVersion: 1, protocol: { name: "synthetic-work", version: "1" },
    authorityBoundary: { planeId: "P3", instructionAuthority: false, recoveryAuthority: false } };
  return { status: "work_context_partial", records: [0, 1].map(index => ({ ...structuredClone(common),
    evidenceId: `evidence-${index}`, evidenceDigest: `digest-${index}`, recordedAt: `time-${index}`,
    content: { summary: `Body ${index}`, references: [{ path: "same.txt", digest: `declared-${index}` }],
      pending: [`Not completed ${index}`], unknowns: [`Unknown ${index}`] },
    references: [{ path: "same.txt", digest: `verified-${index}`, status: index ? "changed" : "matching-current-bytes" }] })),
    coverage: { originals: 9, inspected: 2, included: 2, selection: "historical hints; no completeness claim" },
    omissions: { uninspected: 7, byBudget: 0 }, expansion: "Read exact original only when useful", common };
}
function presentedRecord(text, index) {
  const heading = i => { const offset = text.indexOf(`\nRecord[${i}]:\n`); return offset < 0 ? -1 : offset + 1; };
  const start = heading(index), next = heading(index + 1);
  const envelope = text.indexOf("Additional original fields at workContext:\n", start);
  assert.ok(start >= 0); const ends = [next, envelope].filter(offset => offset >= 0);
  return text.slice(start, ends.length ? Math.min(...ends) : undefined);
}
test("common work fields preserve exact collection membership, all values and separate reference roles", () => {
  const value = repeatedWorkFixture(), before = JSON.stringify(value), text = formatSessionWorkContext(value);
  assert.ok(text.includes(`Common stored fields for Record[0], Record[1]:\n${JSON.stringify(value.common, null, 2)}\n`));
  assert.match(text, /Session work group/);
  for (const index of [0, 1]) assert.equal(text.split(`\nRecord[${index}]:\n`).length - 1, 1);
  for (const [index, record] of value.records.entries()) {
    const part = presentedRecord(text, index);
    for (const key of Object.keys(value.common)) assert.ok(!part.includes(`"${key}":`) && !part.includes(`${key}:`), key);
    for (const key of ["evidenceId", "evidenceDigest", "recordedAt"]) assert.ok(part.includes(JSON.stringify(record[key])));
    for (const refs of [record.content.references, record.references]) assert.ok(part.includes(JSON.stringify({ references: refs }, null, 2).slice(2, -2)));
    assert.ok(part.includes(`Body ${index}`)); assert.ok(part.includes(`Not completed ${index}`)); assert.ok(part.includes(`Unknown ${index}`));
  }
  for (const key of ["coverage", "omissions", "expansion"]) assert.ok(text.includes(JSON.stringify({ [key]: value[key] }, null, 2).slice(2, -2)));
  assert.equal(JSON.stringify(value), before); assert.equal(text, formatCliResult("session-work-read", value));
  assert.equal(text, formatMcpToolContent("head_session_work_read", value));
});
test("mixed missing null empty and unsupported work owners stay individual without filling absent fields", () => {
  for (const key of ["projectId", "sessionId"]) for (const raw of [undefined, null, "", false, 0, "other-owner"]) {
    const value = repeatedWorkFixture(); if (raw === undefined) delete value.records[1][key]; else value.records[1][key] = raw;
    const before = JSON.stringify(value), text = formatSessionWorkContext(value); assert.ok(!text.includes("Common stored fields for"));
    assert.ok(presentedRecord(text, 0).includes(`${key}: ${JSON.stringify(value.records[0][key])}`));
    if (raw === undefined) assert.ok(!presentedRecord(text, 1).includes(`${key}:`));
    else assert.ok(presentedRecord(text, 1).includes(`${key}: ${JSON.stringify(raw)}`));
    assert.equal(JSON.stringify(value), before);
  }
  for (const raw of [null, false, 0, "", [], {}, { kind: "Other", content: {} }]) {
    const value = repeatedWorkFixture(); value.records[1] = raw; assert.ok(!formatSessionWorkContext(value).includes("Common stored fields for"));
  }
  for (const raw of [null, false, 0, "", []]) {
    const value = repeatedWorkFixture(); value.records[1].content = raw; const text = formatSessionWorkContext(value);
    assert.ok(!text.includes("Common stored fields for")); assert.ok(presentedRecord(text, 1).includes(`content: ${JSON.stringify(raw)}`));
  }
});
test("different missing inherited or differently typed metadata cannot disappear into common values", () => {
  for (const [key, raw] of [["schemaVersion", "1"], ["protocol", { version: "1", name: "synthetic-work" }],
    ["authorityBoundary", { planeId: "P4", instructionAuthority: false, recoveryAuthority: false }]]) for (const missing of [false, true]) {
    const value = repeatedWorkFixture(); if (missing) delete value.records[1][key]; else value.records[1][key] = raw;
    const expected = { ...value.common }; delete expected[key]; const text = formatSessionWorkContext(value);
    assert.ok(text.includes(`Common stored fields for Record[0], Record[1]:\n${JSON.stringify(expected, null, 2)}`));
    assert.ok(presentedRecord(text, 0).includes(JSON.stringify({ [key]: value.records[0][key] }, null, 2).slice(2, -2)));
    if (missing) assert.ok(!presentedRecord(text, 1).includes(`"${key}":`));
    else assert.ok(presentedRecord(text, 1).includes(JSON.stringify({ [key]: raw }, null, 2).slice(2, -2)));
  }
  for (const raw of [null, false, 0, "", [], {}]) {
    const value = repeatedWorkFixture(); value.records.forEach(row => { row.protocol = structuredClone(raw); });
    assert.ok(formatSessionWorkContext(value).includes(JSON.stringify({ ...value.common, protocol: raw }, null, 2)));
  }
  const value = repeatedWorkFixture(), inherited = value.records[1].protocol; delete value.records[1].protocol;
  Object.setPrototypeOf(value.records[1], { protocol: inherited });
  assert.ok(!formatSessionWorkContext(value).split("Record[0]:\n")[0].includes('"protocol":'));
});
test("relative labels preserve literal fences whitespace array indices and unknown parent collisions", () => {
  const value = repeatedWorkFixture(), literal = "  가🙂\r\n\tDo not deploy.\n`````text\nRecord[9]:\nkeep  spaces  \n";
  for (const [index, row] of value.records.entries()) {
    row.content.summary = literal + index;
    row.content.judgments = [{ assessment: "Not approved", reason: literal, alternatives: [null, false, 0, "", [], {}], "reason.future": { sessionId: null } }];
    row.content.future = { projectId: 0, "content.summary": false, values: [null, false, 0, "", [], {}] };
    row.future = { sessionId: "Not the record owner", content: { summary: "Unknown parent" } };
  }
  const before = JSON.stringify(value), text = formatSessionWorkContext(value), fence = "`".repeat(6);
  for (const [index, row] of value.records.entries()) {
    assert.ok(text.includes(`content.summary (original text):\n${fence}text\n${literal}${index}\n${fence}\n`));
    assert.ok(text.includes(`content.judgments[0].reason (original text):\n${fence}text\n${literal}${fence}\n`));
    row.content.judgments[0].alternatives.forEach((raw, i) => assert.ok(text.includes(`content.judgments[0].alternatives[${i}]: ${JSON.stringify(raw)}`)));
    for (const unknown of [row.content.future, row.future]) assert.ok(text.includes(JSON.stringify({ future: unknown }, null, 2).slice(2, -2)));
  }
  assert.equal(JSON.stringify(value), before); assert.ok(!text.includes("records[0].content.summary"));
  assert.ok(text.includes('"sessionId": "Not the record owner"'));
});
test("graph common membership names only supported work nodes at original indices, never navigation", () => {
  const fixture = repeatedWorkFixture(), work = fixture.records.map(({ content, ...row }, index) => ({ ...row, nodeId: `work-${index}`, workContent: content,
    origin: { layer: "sessionWork" }, workContentCoverage: { partial: true, unknown: false },
    workContentExcerpts: [{ field: "summary", text: `Excerpt ${index}`, index: 0, start: 0, end: 9, totalCharacters: 20 }] }));
  const graph = { kind: "ProjectGraphDiscoveryProjection", nodes: [{ nodeId: "nav", kind: "Session", sessionId: "nav-owner", excerpt: "Navigation only" },
    work[0], { nodeId: "reference", kind: "Reference", future: null }, work[1]], edges: [], coverage: { state: "partial", hint: "not proof" } };
  const before = JSON.stringify(graph), text = formatMcpToolContent("head_project_graph", graph);
  assert.equal(text, formatCliResult("graph-query", graph));
  assert.ok(text.includes("Logical Session")); assert.ok(text.includes("Navigation only"));
  // One-based terminal references retain the original indices; they are not
  // flattened to only the work-node subset.
  for (let i = 0; i < 4; i++) assert.equal(text.split(`\n[${i + 1}] `).length - 1, 1);
  assert.ok(text.includes("partial text")); assert.ok(text.includes("Partial original summary[0]"));
  const terminal = formatCliResult("graph-query", graph, { diagnostics: true });
  assert.ok(terminal.includes("Selected connections")); assert.ok(terminal.includes('"hint": "not proof"')); assert.equal(JSON.stringify(graph), before);
  for (const change of [node => { delete node.projectId; }, node => { node.sessionId = null; }, node => { node.kind = "Other"; }, node => { node.workContent = null; }]) {
    const ambiguous = structuredClone(graph); change(ambiguous.nodes[3]); const output = formatMcpToolContent("head_project_graph", ambiguous);
    assert.equal(output, formatCliResult("graph-query", ambiguous));
    assert.ok(!output.includes("Common stored fields for")); assert.ok(output.includes("Logical Session")); assert.ok(output.includes("Navigation only"));
  }
});

test("unresolved Session cards preserve current cancellation without claiming recovery or diagnostics", () => {
  const value = { status: "session_selection_unresolved", sessionId: null,
    currentProjectDirection: { input: { goal: "Inspect local source", constraints: ["Do not publish"], decisions: [], cancelledActions: ["deploy"] } },
    nextHeadAction: "Continue independent work; only dependent work needs a verified selected Session." };
  for (const command of ["status", "doctor", "conversation-enter", "session-restore", "init", "resume", "run-start", "compact-status"]) {
    const text = formatCliResult(command, value);
    assert.match(text, /independent work can continue/u);
    assert.match(text, /Constraint: Do not publish/u);
    assert.match(text, /Cancelled action: deploy/u);
    assert.doesNotMatch(text, /Lode is ready|recovered the current direction|unverified checkpoint|Open reviews: 0|drift: 0|restart: not required/u);
  }
  assert.equal(formatMcpToolContent("head_run_start", value), JSON.stringify(value), "unformatted MCP tools retain their JSON contract");
  assert.match(formatSessionRestore(value), /unavailable \(not inspected\)/u);
  assert.match(formatProjectBootstrap(value), /independent work can continue/u);
});

const authority = {
  advisoryOnly: true,
  writesRecoveryDirection: false,
  consumesContinuation: false,
  attachesProvider: false,
};

test("real CLI help renders direct default and state-aware ordinary Host delegation", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const cli = path.join(root, "scripts/head.mjs");
  function invoke(args) {
    const command = process.execPath, fullArgs = [cli, ...args];
    const record = { command, args: fullArgs, cwd: root, parentPid: process.pid, ports: [] };
    console.log(JSON.stringify({ event: "planned", ...record }));
    const child = spawnSync(command, fullArgs, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
    console.log(JSON.stringify({ event: "closed", ...record, pid: child.pid, exitCode: child.status, signal: child.signal }));
    assert.ifError(child.error); assert.equal(child.status, 0, child.stderr); assert.equal(child.stderr, "");
    return child.stdout;
  }
  for (const command of ["help", "help-all"]) {
    const output = invoke([command]);
    assert.match(output, /Work directly by default/u);
    assert.match(output, /available Host tools.*Lode integrate/u);
    assert.match(output, /continue directly or sequentially/u);
    assert.doesNotMatch(output, /optional managed operations|worker-prepare|worker-wave-create/u);
    assert.match(output, /inspect uncertain work before replacement/u);
    assert.doesNotMatch(output, /Choose (?:A|B|C)|Enter (?:an? )?(?:authorization|registry|job) ID/u);
  }
  const machine = JSON.parse(invoke(["help", "--json"]));
  assert.equal(machine.executionMeans.default, "lode-direct");
  assert.equal(machine.executionMeans.requiresUserSelection, false);
  assert.equal(machine.laneRecommendationRequired, false);
});

test("MCP discovery discloses every operation effect without granting approval", async () => {
  for (const tool of tools) assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", tool.name);
  for (const name of ["head_graph_lineage_status", "head_graph_lineage_trace", "head_graph_lineage_diff", "head_conversation_enter"]) {
    assert.equal(tools.find((tool) => tool.name === publicToolName(name)).annotations.readOnlyHint, true);
  }
  for (const name of ["head_onboarding_review", "head_compact_prepare", "head_compact_verify", "head_compact_continue"]) {
    assert.equal(tools.find((tool) => tool.name === publicToolName(name)).annotations.readOnlyHint, false);
  }
  const response = await dispatch({ jsonrpc: "2.0", id: "effects", method: "tools/list" });
  assert(response.result.tools.length < tools.length);
  assert(response.result.tools.some(tool => tool.name === "lode_tools_discover"));
});

function projectExperience({ recoveryState = "no-current-checkpoint", recoveryAttention = false, productState = "not_activated" } = {}) {
  return {
    status: "core_ready",
    projectAction: "initialized",
    readiness: {
      core: { state: "ready" },
      product: { state: productState },
      context: { state: "curated-only" },
      recovery: {
        state: recoveryState,
        userDecisionRequired: false,
        headActionRequired: recoveryAttention,
        recoveryDependentWorkBlocked: recoveryAttention,
        ordinaryWorkBlocked: false,
        reasonCode: recoveryAttention ? "SESSION_RESTORE_POINTER_DRIFT" : null,
        authority,
      },
    },
    attention: {
      status: recoveryAttention ? "attention" : "clear",
      userDecisionRequired: false,
      headActionRequired: recoveryAttention,
      items: recoveryAttention ? [{ owner: "HEAD", summary: "Inspect recovery evidence; ordinary work remains available when it does not depend on that checkpoint." }] : [],
    },
    presentation: { mode: recoveryAttention ? "exception" : "quiet" },
    runtime: { activePackageVersion: "fixture-version" },
    drift: [],
    nextAction: {
      id: "work_directly",
      summary: "The constitutional Core is ready.",
      entrypoint: { cli: "head-agent status fixture", mcpTool: "head_project_status" },
    },
  };
}

test("optional Product work is a notice rather than an immediate conversation gate", () => {
  const value = projectExperience({ productState: "review_required" });
  value.attention = {
    status: "notice",
    userDecisionRequired: false,
    headActionRequired: false,
    items: [{ owner: "user", actionability: "when-product-governance-is-in-scope", summary: "Product review is available." }],
  };
  value.presentation = { mode: "notice" };
  const output = formatProjectStatus(value);
  assert.match(output, /ordinary work continues/u);
  assert.match(output, /optional item/u);
  assert.doesNotMatch(output, /User decision: required/u);
});

test("ordinary project status leads with the task and hides implementation details", () => {
  const output = formatProjectStatus(projectExperience());
  assert.match(output, /Lode is ready — continue the task/u);
  assert.doesNotMatch(output, /Recovery:|Product knowledge:|fixture-version|Command:|MCP:/u);

  const doctor = formatProjectStatus(projectExperience(), { doctor: true });
  assert.match(doctor, /fixture-version/u);
  assert.match(doctor, /Command:|MCP:/u);
});

test("quiet and notice readiness disclose preserved Host configuration and modified projections without a work gate", () => {
  for (const mode of ["quiet", "notice", "normal"]) {
    const value = projectExperience(); value.presentation = { mode };
    value.project = { integrations: { claude: { status: "manual", mcpProjection: ".lode/generated/claude.mcp.json", instructionProjection: ".lode/generated/lode-instructions.md" }, codex: { status: "managed", path: "AGENTS.md" } } };
    value.drift = [{ path: "AGENTS.md", reason: "modified" }];
    const before = JSON.stringify(value);
    for (const text of [formatProjectStatus(value), formatProjectBootstrap(value)]) {
      assert(text.includes("Automatic connection was not verified")); assert(text.includes(".lode/generated/claude.mcp.json"));
      assert(text.includes("AGENTS.md (modified)")); assert(text.includes("ordinary work continues"));
      assert(!text.includes("run doctor before continuing")); assert(!text.includes("Host connected"));
    }
    assert.equal(JSON.stringify(value), before);
  }
  const value = projectExperience(); value.project = { integrations: { codex: { status: "managed", path: "AGENTS.md" } } };
  assert(!formatProjectStatus(value).includes("Automatic connection"));
});

test("World and document CLI summaries bound human output while preserving the raw result and exact read routes", () => {
  const world = { status: "stale", snapshot: { worldModelId: "world-model-A", summary: { fileCount: 9000, symbolCount: 30000 }, files: Array(500).fill({ text: "do-not-dump-original".repeat(100) }), temporalProvenanceGraph: { graphSnapshotId: "graph-A", nodes: Array(500).fill({ text: "do-not-dump-original" }) } },
    changes: { added: Array.from({ length: 100 }, (_, i) => `src/new-${i}.mjs`), changed: ["src/action.mjs"], removed: [], productModelChanged: true } };
  const before = JSON.stringify(world), text = formatCliResult("world-status", world);
  assert(text.length < 2200); assert(text.includes("World: stale")); assert(text.includes("fileCount: 9000")); assert(text.includes("94 more in --json")); assert(text.includes('lode-agent world-status "<project>" --json'));
  assert(!text.includes("do-not-dump-original")); assert.equal(JSON.stringify(world), before);
  const docs = { status: "projected", worldModelStatus: "current", worldModelId: "world-A", projection: { projection: { documentProjectionId: "docs-A", documents: Array(500).fill({ content: "do-not-dump-original" }), summary: { documentCount: 500 } }, publishedLocations: Array.from({ length: 500 }, (_, i) => ({ relativePath: `knowledge/${i}.md` })) } };
  const built = formatCliResult("world-docs-build", docs); assert(built.length < 2200); assert(built.includes("documentCount: 500")); assert(built.includes("497 more in --json")); assert(!built.includes("do-not-dump-original"));
  assert(built.includes("do not repeat a mutation solely to inspect details"));
  const current = formatCliResult("world-docs-status", { status: "source-stale", worldModelStatus: "stale", projection: { status: "current", candidateRequired: true, drift: [{ relativePath: "knowledge/policy.md", changeType: "modified" }] } });
  assert(current.includes("source-stale")); assert(current.includes("knowledge/policy.md (modified)")); assert(current.includes("independent work continues"));
  const receipt = { status: "verified", receipt: { refreshReceiptId: "refresh-receipt-abc" } };
  assert(formatCliResult("world-refresh-read", receipt).includes('--receipt "refresh-receipt-abc" --json'));
});

test("World refresh summary reads actual nested receipt changes and separate blocked or failed document outcomes", () => {
  // Return nesting/statuses from refreshWorldModelLocked/completePostRefreshProjection,
  // not the top-level inspectWorldModel.changes or a fabricated reasonCode field.
  const candidateSetId = "document-change-candidate-set-" + "a".repeat(24);
  for (const [status, reasonCode, candidate] of [
    ["blocked-edited-view", "DOCUMENT_CHANGE_CANDIDATES_REQUIRE_REVIEW", candidateSetId],
    ["failed", "DOCUMENT_PROJECTION_PUBLISH_MISMATCH", null],
  ]) {
    const value = { status: "refreshed", receiptFile: "synthetic/refresh-receipt.json",
      worldModel: { worldModelId: "world-model-" + "b".repeat(24), sourceSnapshotId: "source-snapshot-" + "c".repeat(24), graphSnapshotId: "graph-snapshot-" + "d".repeat(24) },
      receipt: { kind: "IncrementalRefreshReceipt", status: "refreshed", refreshReceiptId: "incremental-refresh-receipt-" + "e".repeat(24),
        observedChanges: { added: Array.from({ length: 100 }, (_, i) => `src/added-${i}.mjs`), changed: ["src/action.mjs"], removed: ["src/old.mjs"] } },
      postRefreshProjection: { status, receiptFile: "synthetic/post-refresh-receipt.json", receipt: { kind: "PostRefreshProjectionReceipt",
        postRefreshProjectionReceiptId: "post-refresh-projection-receipt-" + "f".repeat(24), outcome: {
          status, reasonCode, documentProjectionId: null, documentProjectionHash: null, candidateSetId: candidate, candidateSetHash: candidate ? "a".repeat(64) : null,
        } } },
    };
    const before = JSON.stringify(value), output = formatCliResult("world-refresh", value);
    assert(output.includes("World: refreshed.")); assert(output.includes("Recorded refresh source added")); assert(output.includes("src/added-0.mjs")); assert(output.includes("94 more in --json"));
    assert(output.includes("src/action.mjs")); assert(output.includes("src/old.mjs")); assert(output.includes(reasonCode)); assert(output.includes(status));
    assert(output.includes("World refresh remains recorded")); assert(output.length < 3000);
    if (candidate) {
      assert(output.includes(candidateSetId));
      assert(output.includes(`lode-agent world-docs-candidates "<project>" --candidate-set "${candidateSetId}" --json`));
      assert(output.includes("independent work continues"));
    } else assert(!output.includes("world-docs-candidates"));
    assert(!output.includes("World: failed")); assert(!output.includes("World: blocked")); assert.equal(JSON.stringify(value), before);
    const historical = formatCliResult("world-refresh-read", { status: "verified", receipt: value.receipt });
    assert(historical.includes("Recorded refresh source changed")); assert(historical.includes("src/action.mjs"));
  }
});

test("bootstrap and restore keep the original task and authority boundary visible", () => {
  const bootstrap = formatProjectBootstrap(projectExperience());
  assert.match(bootstrap, /Continue the user's original task in this conversation/u);
  assert.match(bootstrap, /User decision: none/u);

  const restored = formatSessionRestore({
    checkpoint: {
      checkpointId: "checkpoint-secret-id",
      purpose: "Preserve the approved migration direction",
      currentPosition: "Implementation verified",
      nextExpectedResult: "Publish the bounded result",
      openReviewIds: ["review-secret-id"],
    },
  });
  assert.match(restored, /newer real user request takes priority/u);
  assert.match(restored, /this read changed no checkpoint or authority/u);
  assert.doesNotMatch(restored, /checkpoint-secret-id|review-secret-id/u);

  const attention = formatProjectStatus(projectExperience({
    recoveryState: "attention-required",
    recoveryAttention: true,
  }));
  assert.match(attention, /User decision: none for ordinary work/u);
  assert.match(attention, /ordinary work remains available when it does not depend on that checkpoint/u);
  assert.doesNotMatch(attention, /User decision: attention required/u);
});

test("decision cards present bounded choices without mechanically choosing or exposing IDs", () => {
  const onboarding = formatOnboardingGuide({
    status: "awaiting_review",
    review: {
      candidateCount: 2,
      returnedCandidateCount: 1,
      truncated: true,
      unknownCount: 1,
      candidates: [{ key: "candidate-secret-id", name: "Request processing", productKind: "Capability" }],
    },
  });
  assert.match(onboarding, /Options: accept all, accept a selection, revise, or reject/u);
  assert.match(onboarding, /Core supplies no automatic disposition/u);
  assert.match(onboarding, /more candidates require inspection before a complete accept-all review/u);
  assert.doesNotMatch(onboarding, /candidate-secret-id/u);

  const mapping = formatFeatureMappingStatus({
    status: "awaiting_review",
    candidateSet: { candidates: [{ candidateId: "mapping-secret-id" }] },
  });
  assert.match(mapping, /evidence-linked mapping proposal/u);
  assert.match(mapping, /Recommendation: none is generated mechanically/u);
  assert.doesNotMatch(mapping, /mapping-secret-id/u);
});

test("Feature mapping presentation follows typed fresh, stale, recovery, and Run readiness", () => {
  const candidateSet = { candidates: [{ candidateId: "mapping-secret-id", explanation: "Exact implementation evidence." }] };
  const fresh = formatFeatureMappingStatus({
    status: "awaiting_review",
    candidateSet,
    reviewRecovery: null,
    reviewReadiness: { evidenceStatus: "current", acceptanceAvailable: true, explicitRejectionAvailable: true, runConflict: false },
  });
  assert.match(fresh, /Options: accept all, accept a selection, or reject/u);

  const stale = formatFeatureMappingStatus({
    status: "awaiting_review",
    candidateSet,
    reviewRecovery: null,
    reviewReadiness: { evidenceStatus: "stale", acceptanceAvailable: false, explicitRejectionAvailable: true, runConflict: false },
  });
  assert.match(stale, /Acceptance is unavailable/u);
  assert.match(stale, /reject this exact outdated set/u);
  assert.doesNotMatch(stale, /Options: accept/u);

  const recovery = formatFeatureMappingStatus({
    status: "awaiting_review",
    candidateSet,
    reviewRecovery: { status: "pointer-update-pending", reviewDecisionId: "review-secret-id", requiresNewUserDecision: false },
    reviewReadiness: { acceptanceAvailable: false, explicitRejectionAvailable: false, runConflict: false,
      nextAction: "Retry the unchanged saved ReviewDecision to finish its pending state update; no new user decision is needed." },
  });
  assert.match(recovery, /decision is already saved/u);
  assert.match(recovery, /User decision: none/u);
  assert.doesNotMatch(recovery, /Options: accept/u);
  assert.doesNotMatch(recovery, /review-secret-id/u);

  const runConflict = formatFeatureMappingStatus({
    status: "awaiting_review",
    candidateSet,
    reviewRecovery: null,
    reviewReadiness: { acceptanceAvailable: false, explicitRejectionAvailable: false, runConflict: true,
      nextAction: "Finish the existing Run or its pending review before changing the mapping review state." },
  });
  assert.match(runConflict, /waiting for the current Run boundary/u);
  assert.match(runConflict, /User decision: none/u);
  assert.doesNotMatch(runConflict, /Options: accept/u);

  for (const value of [
    { status: "awaiting_review", candidateSet, reviewRecovery: null,
      reviewReadiness: { evidenceStatus: "current", acceptanceAvailable: true, explicitRejectionAvailable: true, runConflict: false } },
    { status: "awaiting_review", candidateSet, reviewRecovery: null,
      reviewReadiness: { evidenceStatus: "stale", acceptanceAvailable: false, explicitRejectionAvailable: true, runConflict: false } },
    { status: "awaiting_review", candidateSet,
      reviewRecovery: { status: "pointer-update-pending", requiresNewUserDecision: false },
      reviewReadiness: { acceptanceAvailable: false, explicitRejectionAvailable: false, runConflict: false } },
    { status: "awaiting_review", candidateSet, reviewRecovery: null,
      reviewReadiness: { acceptanceAvailable: false, explicitRejectionAvailable: false, runConflict: true } },
  ]) {
    assert.equal(formatCliResult("feature-mapping-status", value), formatMcpToolContent("head_feature_mapping_status", value));
  }
});

test("Change impact presentation avoids repeat approval and keeps stale rejection optional", () => {
  const candidateSet = { candidates: [{ candidateId: "impact-secret-id" }] };
  const recovery = {
    status: "awaiting_review",
    candidateSet,
    reviewRecovery: { status: "pointer-update-pending", reviewDecisionId: "review-secret-id", requiresNewUserDecision: false },
    reviewReadiness: { acceptanceAvailable: false, explicitRejectionAvailable: false, runConflict: false,
      nextAction: "Retry the unchanged saved ReviewDecision to finish its pending state update; no new user decision is needed." },
  };
  const recoveryOutput = formatChangeSetStatus(recovery);
  assert.match(recoveryOutput, /decision is already saved/u);
  assert.match(recoveryOutput, /User decision: none/u);
  assert.doesNotMatch(recoveryOutput, /Options: accept/u);
  assert.doesNotMatch(recoveryOutput, /review-secret-id|impact-secret-id/u);

  const stale = {
    status: "awaiting_review",
    candidateSet,
    reviewRecovery: null,
    reviewReadiness: { evidenceStatus: "stale", acceptanceAvailable: false, explicitRejectionAvailable: true, runConflict: false },
  };
  const staleOutput = formatChangeSetStatus(stale);
  assert.match(staleOutput, /Acceptance is unavailable/u);
  assert.match(staleOutput, /Available action: explicitly reject/u);
  assert.doesNotMatch(staleOutput, /Options: accept/u);
  assert.equal(formatCliResult("change-set-status", recovery), formatMcpToolContent("head_change_set_status", recovery));
});

test("Run and conformance projections never promote evidence into approval or a global gate", () => {
  const pending = formatPendingReview({
    review: {
      wholePlan: { objective: "Complete one bounded migration" },
      resultPacket: { summary: "Worker reported success", evidence: ["fixture"] },
      reviewProtocol: { allowedDispositions: ["accept", "revise"] },
    },
  });
  assert.match(pending, /Worker or ResultPacket completion is not acceptance/u);

  const queue = formatConformanceQueue({
    totalMatches: 1,
    findings: [{ status: "open", claim: { summary: "Possible policy drift" } }],
  });
  assert.match(queue, /Ordinary work is not blocked/u);
  assert.match(queue, /evidence, not a violation or decision/u);

  const finding = formatConformanceFinding({
    finding: { claim: { summary: "Possible policy drift", riskHint: "low" }, evidenceAnchors: ["anchor"] },
    resolutions: [],
  });
  assert.match(finding, /neither blocks ordinary work nor authorizes a fix/u);

  const outcome = formatReviewOutcome({
    reviewDecision: { disposition: "accept-all" },
    authorityEffect: "explicit-product-canon-transition",
  });
  assert.match(outcome, /Product Canon changed: yes, through the scoped ReviewDecision/u);
  assert.match(outcome, /semantic correctness remains subject to the user's decision/u);
});

function conversationContextFixture({ restored = false, mode = "quiet" } = {}) {
  const currentProjectDirection = { input: {
    goal: "Inspect the generation comparison reason, local write position and remaining cancellation boundary.",
    constraints: ["Local synthetic investigation only; do not publish or change a service."],
    decisions: ["Keep the investigation local, despite the earlier deployment plan."],
    cancelledActions: ["Publish or deploy this synthetic local result"],
  } };
  const checkpoint = {
    checkpointId: "checkpoint-private-id",
    purpose: "Retained purpose " + "p".repeat(270) + "; local rewrite cancelled; inspect only.",
    approvedDecisions: ["Retained decision " + "d".repeat(270) + "; do not contact the network."],
    currentPosition: "Retained position " + "c".repeat(270) + "; prior upload cancelled.",
    nextExpectedResult: "Retained next plan " + "n".repeat(270) + "; explanation only, not permission to deploy.",
    openReviewIds: ["review-private-id"],
  };
  const contents = [
    { summary: "Generation comparison", judgments: [{ reason: "An earlier request can arrive later; elapsed TTL alone does not order responses." }] },
    { summary: "Clock alternative", judgments: [{ alternatives: ["Client-clock order is unreliable if clocks move or disagree."] }] },
    { summary: "Local change", observedWork: ["Enabled the generation check immediately before the synthetic cache write; TTL remains 60. No service was changed."] },
    { summary: "Remaining boundary", pending: ["Cancellation racing with a write still needs local investigation."], unknowns: ["Actual Host/model behavior is unverified."] },
  ];
  return {
    status: restored ? "conversation_direction_restored" : "conversation_ready",
    presentation: { mode }, attention: { items: [] },
    projectStatus: { currentProjectDirection },
    ...(restored ? { restore: { status: "session_restored_from_artifacts", checkpoint,
      projection: { currentProjectDirection, checkpoint,
        currentExecution: { status: "verified", sessionPointer: {} } } } } : {}),
    workContext: { status: "work_context_available", sessionId: "selected-session",
      sessionPurpose: "Current selected Session purpose: investigate locally without deployment.",
      records: contents.map((content, i) => ({ evidenceId: `retained-${i}`, evidenceDigest: `digest-${i}`, recordedAt: "2026-10-18T00:00:00Z",
        selectionRole: "recent", content, references: [{ path: "src/cache-policy.json", digest: `source-${i}`,
          status: i < 2 ? "changed" : "matching-current-bytes" }] })),
      coverage: { originals: 4, included: 4 }, omissions: { uninspected: 0 }, nextAfterEvidenceId: null },
  };
}

function assertConversationLiterals(text, entry) {
  const input = entry.projectStatus.currentProjectDirection.input;
  for (const literal of [input.goal, ...input.constraints, ...input.decisions, ...input.cancelledActions,
    entry.workContext.sessionPurpose]) assert(text.includes(literal), literal);
  if (entry.restore) {
    const checkpoint = entry.restore.checkpoint;
    for (const literal of [checkpoint.purpose, ...checkpoint.approvedDecisions, checkpoint.currentPosition, checkpoint.nextExpectedResult]) {
      assert(text.includes(literal), literal);
    }
    assert.match(text, /historical context, not current execution or permission/u);
    assert.match(text, /Historical approval and next plans grant no current effect or replay permission/u);
  }
  assert(text.endsWith(formatSessionWorkContext(entry.workContext)), "Existing full P3 body/coverage/diagnosis remains unchanged");
  assert(text.indexOf(input.cancelledActions[0]) < text.indexOf("Selected Session work evidence"));
}

test("conversation context keeps current meaning and full fitting historical bodies in quiet, notice and normal text", () => {
  for (const restored of [false, true]) for (const mode of ["quiet", "notice", "exception"]) {
    const entry = conversationContextFixture({ restored, mode });
    const before = JSON.stringify(entry);
    const cli = formatCliResult("conversation-enter", entry);
    assert.equal(cli, formatMcpToolContent("head_conversation_enter", entry));
    assertConversationLiterals(cli, entry);
    assert.equal(JSON.stringify(entry), before, "Formatting must not change structured input");
    assert.doesNotMatch(cli, /Please approve|Which Session|Run this command|content omitted/u);
  }
});

test("conversation context preserves lifecycle wrapper outcomes without losing supplied context", () => {
  for (const [status, diagnostic] of [
    ["host_lifecycle_unavailable", "Host compaction hooks are unavailable"],
    ["compaction_lifecycle_prepared", "one-time continuation internally"],
    ["provider_compaction_outcome_uncertain", "will not be replayed automatically"],
    ["conversation_direction_restored_without_transport_continuation", "Transport continuation was unavailable"],
    ["compaction_lifecycle_continued", "duplicate Host delivery cannot apply it twice"],
    ["compaction_lifecycle_already_continued", "duplicate Host delivery cannot apply it twice"],
    ["provider_compaction_failed", "only that epoch was closed"],
    ["provider_compaction_failure_already_recorded", "only that epoch was closed"],
    ["compaction_lifecycle_superseded", "newer real user turn superseded"],
    ["head_direction_required", "user is not asked to fill a schema"],
  ]) {
    const entry = conversationContextFixture({ restored: true });
    const wrapper = { status, conversationEntry: entry };
    const before = JSON.stringify(wrapper);
    const text = formatCliResult("compaction-lifecycle-step", wrapper);
    assert.equal(text, formatMcpToolContent("head_compaction_lifecycle_step", wrapper));
    assert(text.includes(diagnostic), status);
    assertConversationLiterals(text, entry);
    assert.equal(JSON.stringify(wrapper), before);
  }
});

test("conversation context distinguishes unavailable, never recorded, explicit empty and uninspected direction", () => {
  const unavailable = conversationContextFixture({ restored: true });
  unavailable.projectStatus = { currentProjectDirection: null, currentProjectDirectionAvailability: { status: "unavailable" } };
  const unavailableText = formatConversationRecovery(unavailable);
  assert.match(unavailableText, /unavailable, not empty/u);
  assert.match(unavailableText, /only direction-dependent effects/u);
  assert(!unavailableText.includes(unavailable.restore.projection.currentProjectDirection.input.goal), "Diagnosed null must not fall back to another view's stale content");
  assert(unavailableText.includes(unavailable.restore.checkpoint.currentPosition), "Valid selected checkpoint is independent of unavailable common direction");
  assert(unavailableText.endsWith(formatSessionWorkContext(unavailable.workContext)));

  const base = { status: "conversation_ready", presentation: { mode: "quiet" } };
  assert.match(formatConversationRecovery({ ...base, projectStatus: { currentProjectDirection: null } }), /not recorded \(not an approved empty direction\)/u);
  assert.match(formatConversationRecovery({ ...base, projectStatus: { currentProjectDirection: {
    input: { goal: "", constraints: [], decisions: [], cancelledActions: [] },
  } } }), /explicitly recorded empty goal and lists/u);
  assert.equal(formatConversationRecovery(base), "Lode is ready — continue the task.\n", "No-content entry stays one line with no empty forms or new follow-up");
  for (const metadata of [undefined, null, [], "unavailable"]) {
    const value = conversationContextFixture();
    value.projectStatus.currentProjectDirectionAvailability = metadata;
    assertConversationLiterals(formatConversationRecovery(value), value);
  }
  const explicitNull = conversationContextFixture({ restored: true });
  explicitNull.restore.projection.currentProjectDirection = null;
  assert.match(formatConversationRecovery(explicitNull), /not recorded \(not an approved empty direction\)/u);
  assert(!formatConversationRecovery(explicitNull).includes(explicitNull.projectStatus.currentProjectDirection.input.goal));
});

test("conversation context keeps a valid zero-P3 Session purpose but never backfills excluded context", () => {
  for (const status of ["work_context_not_recorded", "work_context_partial", "work_context_available"]) {
    const entry = { status: "conversation_ready", presentation: { mode: "quiet" },
      workContext: { status, sessionId: "selected", sessionPurpose: "Local inspection only; no checkpoint exists.", records: [], coverage: { originals: 0 } } };
    const text = formatConversationRecovery(entry);
    assert(text.includes(entry.workContext.sessionPurpose));
    if (status === "work_context_not_recorded") assert.doesNotMatch(text, /Selected Session work evidence/u);
    assert.doesNotMatch(text, /Latest retained Session checkpoint|Historical next/u);
  }
  for (const status of ["work_context_basis_changed", "work_context_unavailable"]) {
    const entry = { status: "recovery_attention_required", reasonCode: "CONVERSATION_ENTRY_BASIS_CHANGED",
      workContext: { status, sessionPurpose: "STALE SELECTED PURPOSE", records: [] },
      projectStatus: { state: { purpose: "DEFAULT PURPOSE MUST NOT LEAK" } } };
    // The existing P3 formatter contract is unchanged; only the new selected
    // purpose block must not mislabel an excluded shell as current P2.
    assert.doesNotMatch(formatConversationRecovery(entry), /Selected Session purpose: STALE|DEFAULT PURPOSE MUST NOT LEAK/u);
  }
  const changed = { status: "recovery_attention_required", reasonCode: "CONVERSATION_ENTRY_BASIS_CHANGED",
    currentProjectDirection: { input: { goal: "New current goal", constraints: [], decisions: [], cancelledActions: ["deploy"] } },
    sessionId: null, workContext: { status: "work_context_basis_changed", records: [] } };
  assert.match(formatConversationRecovery(changed), /New current goal/u);
  assert.match(formatConversationRecovery(changed), /Cancelled action: deploy/u);
  assert.doesNotMatch(formatConversationRecovery(changed), /Selected Session purpose:|Latest retained Session checkpoint/u);
});

test("conversation context keeps actual explicit-null empty Core quiet to one line without hiding meaningful siblings", () => {
  // Source-grounded default initialization: the direction property exists and
  // is null, unlike the separate uninspected/missing-property fixture above.
  const entry = { status: "conversation_ready", recoveryState: "no-current-checkpoint",
    presentation: { mode: "quiet" }, projectStatus: { currentProjectDirection: null },
    workContext: { status: "work_context_not_recorded", sessionId: "default-session", sessionPurpose: null,
      records: [], coverage: { originals: 0, inspected: 0, valid: 0, unavailable: 0, included: 0 },
      omissions: { byBudget: 0, uninspected: 0 } } };
  const before = JSON.stringify(entry);
  assert.equal(formatConversationRecovery(entry), "Lode is ready — continue the task.\n");
  assert.equal(formatCliResult("conversation-enter", entry), formatMcpToolContent("head_conversation_enter", entry));
  assert.equal(JSON.stringify(entry), before);

  const named = structuredClone(entry);
  named.workContext.sessionPurpose = "Current local inspection purpose";
  assert.match(formatConversationRecovery(named), /not recorded \(not an approved empty direction\)/u);
  assert.match(formatConversationRecovery(named), /Selected Session purpose: Current local inspection purpose/u);
  assert.doesNotMatch(formatConversationRecovery(named), /Selected Session work evidence/u);

  const recordedEmpty = structuredClone(entry);
  recordedEmpty.projectStatus.currentProjectDirection = { input: { goal: "", constraints: [], decisions: [], cancelledActions: [] } };
  assert.match(formatConversationRecovery(recordedEmpty), /explicitly recorded empty goal and lists/u);
  const unavailable = structuredClone(entry);
  unavailable.projectStatus.currentProjectDirectionAvailability = { status: "unavailable" };
  assert.match(formatConversationRecovery(unavailable), /unavailable, not empty/u);

  const notice = structuredClone(entry);
  notice.presentation.mode = "notice";
  assert.match(formatConversationRecovery(notice), /not recorded \(not an approved empty direction\)/u);
  const withP3 = structuredClone(entry);
  withP3.workContext.status = "work_context_available";
  withP3.workContext.records = [{ evidenceId: "past-work", content: { summary: "Historical work, not permission" } }];
  withP3.workContext.coverage.originals = 1;
  assert.match(formatConversationRecovery(withP3), /not recorded \(not an approved empty direction\)/u);
  assert.match(formatConversationRecovery(withP3), /Historical work, not permission/u);
});

test("conversation context leaves genuine execution conflicts distinct from historical checkpoint meaning", () => {
  for (const status of ["verified", "incomplete", "conflict"]) {
    const entry = conversationContextFixture({ restored: true });
    entry.restore.projection.currentExecution = { status, sessionPointer: { activeRunId: "active-run",
      pendingReview: { runId: "pending-run", wholePlanId: "whole-plan", resultPacketId: "result" },
      requiredPlanAction: { kind: "revise", disposition: "revise", wholePlanId: "whole-plan", reviewDecisionId: "review" } } };
    const text = formatConversationRecovery(entry);
    assertConversationLiterals(text, entry);
    assert(text.includes(`Canonical execution observation (${status})`));
    assert.match(text, /active-run|pending-run/u);
    assert.match(text, /requiredPlanAction/u);
  }
  const corrupt = { status: "recovery_attention_required", reasonCode: "INVALID_RECOVERY_CHECKPOINT",
    restore: { status: "restore_failed", checkpoint: { purpose: "UNVERIFIED CHECKPOINT BODY" } } };
  assert.doesNotMatch(formatConversationRecovery(corrupt), /UNVERIFIED CHECKPOINT BODY|Latest retained Session checkpoint/u);
  assert.match(formatConversationRecovery(corrupt), /Ordinary independent work remains available/u);
});

test("conversation context direct restore shares full meaning without exposing private IDs", () => {
  const entry = conversationContextFixture({ restored: true });
  const before = JSON.stringify(entry.restore);
  const text = formatSessionRestore(entry.restore);
  assert.equal(text, formatCliResult("session-restore", entry.restore));
  assert.equal(text, formatMcpToolContent("head_session_restore", entry.restore));
  const checkpoint = entry.restore.checkpoint;
  for (const field of [checkpoint.purpose, ...checkpoint.approvedDecisions, checkpoint.currentPosition, checkpoint.nextExpectedResult]) assert(text.includes(field));
  assert(text.includes(entry.restore.projection.currentProjectDirection.input.cancelledActions[0]));
  assert.match(text, /Historical approval and next plans grant no current effect/u);
  assert.doesNotMatch(text, /checkpoint-private-id|review-private-id/u);
  assert.equal(JSON.stringify(entry.restore), before);

  const unavailable = { ...entry.restore, currentProjectDirection: null,
    currentProjectDirectionAvailability: { status: "unavailable" } };
  const unavailableText = formatSessionRestore(unavailable);
  assert.match(unavailableText, /unavailable, not empty/u);
  assert(unavailableText.includes(checkpoint.currentPosition));
  assert(!unavailableText.includes(entry.restore.projection.currentProjectDirection.input.goal));

  const failedText = formatSessionRestore({ status: "restore_failed", checkpoint });
  assert.match(failedText, /No verified Session checkpoint was supplied/u);
  assert.doesNotMatch(failedText, /Lode recovered|Lode verified|Open reviews:|Latest retained Session checkpoint/u);
  assert(!failedText.includes(checkpoint.purpose));
});

test("conversation context preserves long multilingual content and whitespace without inventing a text cap", () => {
  const entry = conversationContextFixture({ restored: true });
  const goal = "로컬 검토 근거\n  들여쓰기와   공백을 유지한다.\n".repeat(1200) + "끝의 취소: 배포하지 않는다.";
  entry.projectStatus.currentProjectDirection.input.goal = goal;
  const text = formatConversationRecovery(entry);
  assert(text.includes(goal));
  assertConversationLiterals(text, entry);
});

test("work bodies preserve exact literals and object-local unknown residuals without payload duplication", () => {
  const content = { summary: "BODY_ONLY_ONCE", judgments: [{ assessment: "Inspect only", reason: "A reason\n  ```code```\nwith spaces  ",
    alternatives: ["Other choice", null, false, 0, []], future: { reason: null, summary: false, values: [0, [], {}] } }],
    observedWork: ["Local change only"], pending: ["Pending cancellation/write ordering"], unknowns: ["Unverified external result"],
    suggestedFollowUp: [], future: { judgments: null, pending: false } };
  const value = { status: "work_context_partial", projectId: "project", sessionId: "session-A",
    records: [{ evidenceId: "a", sessionId: "session-A", content, future: { content: 0 }, savedActivity: {}, workContentCoverage: {} },
      { evidenceId: "b", sessionId: "session-B", content: { summary: "Second owner body", unknowns: false }, future: null }],
    coverage: { originals: 2, included: 2 }, omissions: { uninspected: 0 }, nextAfterEvidenceId: null, future: { records: [] } };
  const before = JSON.stringify(value), text = formatSessionWorkContext(value);
  assert.equal(JSON.stringify(value), before);
  assert.equal(text.split("BODY_ONLY_ONCE").length - 1, 1);
  const first = text.slice(text.indexOf("Record[0]:"), text.indexOf("Record[1]:"));
  const second = text.slice(text.indexOf("Record[1]:"), text.indexOf("Additional original fields at workContext:"));
  assert(first.includes(content.judgments[0].reason));
  assert(first.indexOf("Inspect only") < first.indexOf(content.judgments[0].reason));
  assert(first.indexOf(content.judgments[0].reason) < first.indexOf("Other choice"));
  assert(first.includes("savedActivity: {}")); assert(first.includes("workContentCoverage: {}"));
  assert(first.includes('"reason": null')); assert(first.includes('"summary": false'));
  assert(first.includes('"content": 0')); assert(second.includes('"future": null'));
  assert(second.includes('"unknowns": false'));
  assert(!first.includes("Second owner body")); assert(!second.includes("BODY_ONLY_ONCE"));
  assert(text.includes('"nextAfterEvidenceId": null')); assert(text.includes('"records": []'));
  for (const raw of [null, false, 0, "", [], {}]) {
    const mixed = { status: "work_context_partial", records: [{ content: raw }] };
    const output = formatSessionWorkContext(mixed);
    assert(output.includes(JSON.stringify(raw)), `Unexpected body shape must survive: ${JSON.stringify(raw)}`);
  }
  for (const raw of [false, 0, "", [], {}]) assert(formatSessionWorkContext(raw).includes(JSON.stringify(raw)));
});

const workRoleLabels = [
  "Saved judgments and reasons",
  "Alternatives considered in this saved judgment",
  "Recorded changes and results",
  "Recorded remaining work",
  "Recorded uncertainty",
  "Historical suggestions; not execution permission",
];

function explainedContent(index = 0) {
  return {
    summary: `Local result ${index}; not deployed.`,
    judgments: [{ assessment: `Inspect only ${index}`, reason: `Earlier reason ${index}: TTL does not order requests.\n  취소 조건은 유지한다.`,
      alternatives: [`Rejected clock order ${index}; clocks can move.`], future: { accepted: false } }],
    observedWork: [`Local generation check ${index}; no service changed.`],
    pending: [`Cancellation/write race ${index} remains unverified.`],
    unknowns: [`Actual Host behavior ${index} is unknown.`],
    suggestedFollowUp: [`Earlier suggestion ${index}: deploy after approval; not permission now.`],
    future: { pending: false, values: [null, 0, [], {}] },
  };
}

function expectedOriginalText(at, value) {
  return `${at} (original text):\n\`\`\`text\n${value}${value.endsWith("\n") ? "" : "\n"}\`\`\`\n`;
}

function expectedExplainedBody(content, location = "content", explain = true) {
  const label = index => explain ? `${workRoleLabels[index]}:\n` : "";
  return expectedOriginalText(`${location}.summary`, content.summary)
    + label(0) + expectedOriginalText(`${location}.judgments[0].assessment`, content.judgments[0].assessment)
    + expectedOriginalText(`${location}.judgments[0].reason`, content.judgments[0].reason)
    + label(1) + expectedOriginalText(`${location}.judgments[0].alternatives[0]`, content.judgments[0].alternatives[0])
    + `Additional original fields at ${location}.judgments[0]:\n${JSON.stringify({ future: content.judgments[0].future }, null, 2)}\n`
    + ["observedWork", "pending", "unknowns", "suggestedFollowUp"].map((key, index) =>
      label(index + 2) + expectedOriginalText(`${location}.${key}[0]`, content[key][0])).join("")
    + `Additional original fields at ${location}:\n${JSON.stringify({ future: content.future }, null, 2)}\n`;
}

test("Session-only work role labels preserve exact single and multi-record bodies, owner and uncertainty", () => {
  for (const count of [1, 2]) {
    const value = repeatedWorkFixture();
    value.records = value.records.slice(0, count);
    value.records.forEach((row, index) => { row.content = explainedContent(index); });
    const before = structuredClone(value), serialized = Buffer.from(JSON.stringify(value));
    const text = formatSessionWorkContext(value);
    for (const [index, row] of value.records.entries()) {
      const body = expectedExplainedBody(row.content), record = presentedRecord(text, index);
      assert.ok(record.includes(body), "Every original path, literal, field order and residual stays contiguous under its record");
      assert.equal(Buffer.byteLength(record.slice(record.indexOf(body), record.indexOf(body) + body.length)), Buffer.byteLength(body));
      for (const label of workRoleLabels) assert.equal(record.split(`${label}:\n`).length - 1, 1, label);
      for (const literal of [row.content.summary, row.content.judgments[0].reason, row.content.pending[0], row.content.suggestedFollowUp[0]]) {
        assert.equal(text.split(literal).length - 1, 1, "Labels must not duplicate original bodies");
      }
    }
    for (const label of workRoleLabels) assert.equal(text.split(`${label}:\n`).length - 1, count);
    assert.equal(text, formatCliResult("session-work-read", value));
    assert.equal(text, formatMcpToolContent("head_session_work_read", value));
    assert.deepEqual(value, before); assert.deepEqual(Buffer.from(JSON.stringify(value)), serialized);
    assert.match(text, /P3, not current direction or permission/u);
    assert.doesNotMatch(text, /Task completed|currently executing|approved to deploy/u);
  }
});

test("empty missing and unsupported role fields keep originals without explanatory placeholders", () => {
  for (const raw of [undefined, null, false, 0, "", [], {}]) {
    const content = { summary: "Do not infer absence from an unsupported body." };
    for (const key of ["judgments", "observedWork", "pending", "unknowns", "suggestedFollowUp"]) {
      if (raw !== undefined) content[key] = structuredClone(raw);
    }
    const value = { status: "work_context_partial", records: [{ evidenceId: "unsupported", content }] };
    const before = structuredClone(value), text = formatSessionWorkContext(value);
    for (const label of workRoleLabels) assert.ok(!text.includes(`${label}:\n`), `${label}: ${JSON.stringify(raw)}`);
    if (raw !== undefined) for (const key of ["judgments", "observedWork", "pending", "unknowns", "suggestedFollowUp"]) {
      assert.ok(text.includes(Array.isArray(raw) ? `content.${key}: []` : `"${key}": ${JSON.stringify(raw)}`));
    }
    assert.deepEqual(value, before);
  }
  for (const alternatives of [undefined, null, false, 0, "", [], {}]) {
    const judgment = { reason: "A saved reason is not current approval." };
    if (alternatives !== undefined) judgment.alternatives = structuredClone(alternatives);
    const text = formatSessionWorkContext({ status: "work_context_partial", records: [{ content: { judgments: [judgment] } }] });
    assert.match(text, /Saved judgments and reasons:\n/u);
    assert.ok(!text.includes("Alternatives considered in this saved judgment:\n"));
    if (alternatives !== undefined) assert.ok(text.includes(Array.isArray(alternatives)
      ? "content.judgments[0].alternatives: []" : `"alternatives": ${JSON.stringify(alternatives)}`));
  }
});

test("graph work text retains unlabeled originals for single and grouped bodies in compact and detailed views", () => {
  for (const count of [1, 2]) for (const details of [false, true]) {
    const content = Array.from({ length: count }, (_, index) => explainedContent(index));
    const graph = { kind: "ProjectGraphDiscoveryProjection", query: { details }, basis: { projectId: "project-owner" },
      nodes: content.map((workContent, index) => ({ nodeId: `graph-work-${index}`, projectId: "project-owner", sessionId: "session-owner",
        kind: "Evidence", subtype: "SessionWorkEvidence", origin: { layer: "sessionWork" }, instructionAuthority: false, promotionAuthority: false,
        recoveryAuthority: false, executionAuthority: false, ordinaryWorkBlocked: false, workContent })),
      edges: [], coverage: { state: "partial", omitted: 7 }, future: { unknown: true } };
    const before = structuredClone(graph), text = formatMcpToolContent("head_project_graph", graph);
    const terminal = formatCliResult("graph-query", graph, { diagnostics: true });
    assert.ok(terminal.includes("Selected connections")); assert.ok(terminal.includes('"unknown": true'));
    for (const label of workRoleLabels) assert.ok(!text.includes(`${label}:\n`), "Session labels must not leak into graph presentation");
    assert.equal(text, formatCliResult("graph-query", graph));
    assert.ok(text.includes("Recorded work")); assert.ok(text.includes("Recorded judgment"));
    const visible = text.split("\n").map(line => line.replace(/^  \| /u, "")).join("").replace(/\s+/gu, "");
    for (const body of content) {
      const messages = [body.summary, ...body.observedWork, ...body.pending, ...body.unknowns, ...body.suggestedFollowUp,
        ...body.judgments.flatMap(judgment => [judgment.assessment, judgment.reason, ...judgment.alternatives])];
      for (const message of messages) assert(visible.includes(inertTerminalText(message).replace(/\s+/gu, "")), message);
    }
    // Full literal/unknown content remains in the unmodified result and the
    // explicit diagnostics; default graph text uses the shared inert view.
    assert.ok(terminal.includes('"omitted": 7')); assert.ok(terminal.includes('"unknown": true'));
    assert.deepEqual(graph, before);
  }
});

test("conversation labels keep current cancellation ahead of reasons, pending and related historical source", () => {
  const entry = conversationContextFixture();
  entry.workContext.records[0].content = explainedContent(0);
  entry.relatedNativeWorkContext = { sources: [{ relation: "parent", workContext: {
    status: "work_context_available", projectId: "project-owner", sessionId: "parent-session", sessionPurpose: "Parent purpose is historical, not selected direction.",
    records: [{ evidenceId: "parent-evidence", projectId: "project-owner", sessionId: "parent-session", content: explainedContent(9) }],
    coverage: { originals: 1, included: 1 }, omissions: { uninspected: 0 } } }] };
  const before = structuredClone(entry), text = formatConversationRecovery(entry);
  const cancellation = entry.projectStatus.currentProjectDirection.input.cancelledActions[0];
  assert.ok(text.indexOf(cancellation) < text.indexOf("Saved judgments and reasons:\n"));
  assert.ok(text.indexOf("Saved judgments and reasons:\n") < text.indexOf(entry.workContext.records[0].content.pending[0]));
  const related = text.indexOf("Related historical P3 from observed native ancestry — not this child's direction, approval or copied fork-cutoff history:");
  assert.ok(related > text.indexOf(entry.workContext.records[0].content.pending[0]));
  assert.ok(text.indexOf('Related source "parent-session" (parent; selected when observed; reference records read later):', related) > related);
  assert.ok(text.indexOf("Historical input, delivery and model use are unknown.", related) > related);
  assert.ok(text.indexOf("Earlier reason 9:", related) > related);
  assert.ok(text.indexOf("Historical suggestions; not execution permission:\n", related) > related);
  assert.match(text, /Cancellation\/write race 9 remains unverified/u);
  assert.equal(text, formatCliResult("conversation-enter", entry));
  assert.equal(text, formatMcpToolContent("head_conversation_enter", entry));
  assert.deepEqual(entry, before);
});

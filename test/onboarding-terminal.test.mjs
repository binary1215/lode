import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { formatCliResult, formatCliError, formatProjectStatus } from "../scripts/lib/cli-presentation.mjs";
import { formatTerminalGraph, inertTerminalText, terminalBlock } from "../scripts/lib/terminal-graph.mjs";
import { initializeOrResumeProject } from "../scripts/lib/project-bootstrap.mjs";
import { queryProjectGraph } from "../scripts/lib/project-graph.mjs";
import { buildCodexMarketplaceSnapshot } from "../scripts/lib/codex-marketplace.mjs";
import { buildClaudeMarketplaceSnapshot } from "../scripts/lib/claude-marketplace.mjs";
import { fixture, snapshot, pluginRoot } from "./helpers/session-work-linkage-fixture.mjs";

const attack = "\u001b]52;c;c3Bvb2Y=\u0007\u001b]8;;https://example.invalid\u001b\\\u001b[2J\r\b\u009b31m\u202e\nSTATUS: SUCCESS";
const noControls = text => assert(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u.test(text));
function graph() {
  return { kind: "ProjectGraphDiscoveryProjection", basis: { projectId: "project-A" }, query: { details: true }, status: "partial", coverage: { state: "partial" },
    nodes: [
      { nodeId: "a", kind: "Evidence", subtype: "SessionWorkEvidence", sessionId: "session-A", historical: true, reviewState: "unreviewed", freshness: "historical", origin: { layer: "sessionWork" },
        workContent: { summary: "Only proposed; no outcome", pending: ["Independent review"], unknowns: ["No runtime PASS"], suggestedFollowUp: ["Review locally before changes"], executionObservation: { state: "ended" }, judgments: [{ assessment: "Local only", reason: "Do not deploy", alternatives: ["Read existing source"] }] } },
      { nodeId: "b", kind: "FileRevision", name: "같은 경로", path: "src/action.mjs", revisionId: "revision-before", origin: { layer: "world" } },
      { nodeId: "c", kind: "FileRevision", name: "같은 경로", projectId: "project-B", path: "src/action.mjs", revisionId: "revision-after", origin: { layer: "source" } },
      { nodeId: "d", kind: "ProjectDirection", historical: true, origin: { layer: "direction" }, directionEvidence: { goal: "Local investigation", constraints: ["Preserve evidence"], decisions: [], cancelledActions: ["Do not deploy"] } },
    ],
    edges: [{ from: "a", to: "b", type: "CITES" }, { from: "a", to: "b", type: "CITES" }, { from: "b", to: "a", type: "RELATED" },
      { from: "a", to: "a", type: "SELF" }, { from: "c", to: "b", type: "RELATED" }, { from: "d", to: "b", type: "RELATED" },
      { from: "a", to: "missing", type: "CITES", endpointStates: [{ nodeId: "missing", reviewState: "rejected", freshness: "unavailable" }] }],
    future: { doNotLose: "unknown-original-field" } };
}

test("terminal uses every selected directed edge without tree inference, path merging or hiding negative states", () => {
  const value = graph(), before = JSON.stringify(value), output = formatCliResult("graph-query", value);
  assert(output.indexOf("e1") < output.indexOf("[1] Evidence"));
  for (const term of ["e1  [1] --CITES--> [2]", "e2  [1] --CITES--> [2]", "e3  [2] --RELATED--> [1]", "e4  [1] --SELF--> [1]", "e5  [3] --RELATED--> [2]", "e6  [4] --RELATED--> [2]", "outside selection: missing", "rejected", "unreviewed", "historical", "Do not deploy", "No runtime PASS", "revision-before", "revision-after", "project-B"]) assert(output.includes(term), term);
  assert(output.includes("Agent-authored")); assert(output.includes("Caller-conveyed"));
  assert(output.includes("Review locally before changes")); assert(output.includes("not live activity or success")); assert(output.includes("Independent review"));
  assert(!output.includes('"future"')); assert(formatTerminalGraph(value, { diagnostics: true }).includes("unknown-original-field"));
  assert.equal(JSON.stringify(value), before);
  value.nodes[0].origin.layer = "world";
  const untyped = formatCliResult("graph-query", value);
  assert(untyped.includes("Unverified work-shaped fields")); assert(!untyped.includes("Agent-authored work evidence;"));
});

test("all graph labels, originals, reasons, diffs and errors are inert and cannot forge outer status rows", () => {
  const value = graph(); value.query.query = attack; value.basis.projectId = attack; value.nodes[1].path = attack; value.nodes[1].revisionId = attack;
  value.nodes[0].workContent.summary = attack; value.nodes[0].workContent.judgments[0].reason = attack; value.edges[0].type = attack;
  value.nodes[0].workContent.workTopics = [attack];
  value.nodes[0].workContentExcerpts = [{ field: attack, index: 1, start: 0, end: 1, totalCharacters: 2, text: attack }];
  value.nodes[0].referenceEvidence = [{ path: attack, status: "missing", reasonCode: attack, historicalContentAvailable: false, contentReconstructed: false }];
  value.sourceFallback = { needed: true, action: attack, reasonCodes: [attack] };
  value.contextLineage = { files: [{ path: attack, unrecordedIntervals: attack, comparisons: [{ status: "observed", scope: "exact-cited-pair", symbols: [],
    diff: { changed: true, before: { startLine: 1, text: attack }, after: { startLine: 1, text: "한글e\u0301🙂\n  keep indentation  \n" } } }] }],
    recordedReasons: [{ reason: attack }], canonChanges: [], gaps: [{ reasonCode: attack }] };
  const before = JSON.stringify(value);
  for (const output of [formatCliResult("graph-query", value), formatCliResult("graph-query", value, { columns: 24, diagnostics: true }), formatCliError({ message: attack, code: attack })]) {
    noControls(output); assert(!/^STATUS: SUCCESS$/mu.test(output)); assert(output.includes("\\u001b"));
  }
  assert.equal(JSON.stringify(value), before);
  assert.equal(terminalBlock("Original", "first\n  code  \n", 88), "Original\n  | first\n  |   code  \n  | \n");
});

test("default terminal restores partial topics, historical reference gaps and owner/root navigation without inventing authority", () => {
  const value = graph(), node = value.nodes[0];
  node.evidenceDigest = "digest-A"; node.contentPartial = true;
  node.workContent.workTopics = ["Only a navigation label"];
  node.workContent.workLink = { root: { evidenceId: "unreturned-root", evidenceDigest: "exact-root-digest" } };
  node.workContentExcerpts = [{ field: "workTopics", index: 2, start: 5, end: 20, totalCharacters: 40, text: "Partial label X" }];
  node.referenceEvidence = [{ path: "src/removed.mjs", kind: "source", status: "missing", currentness: "missing", reasonCode: "ENOENT",
    historicalContentAvailable: false, contentReconstructed: false }];
  value.sourceFallback = { needed: true, action: "Read an independent current original", reasonCodes: ["PROJECT_GRAPH_COMPACT_CONTENT_PARTIAL"] };
  value.authority = { instructionAuthority: false, ordinaryWorkBlocked: false };
  const before = JSON.stringify(value), text = formatTerminalGraph(value);
  for (const term of ["partial text", "Only a navigation label", "Partial original workTopics[2]: characters 5-20 of 40", "Partial label X", "src/removed.mjs",
    "missing", "ENOENT", "historical content unavailable", "content not reconstructed", "declared root outside selection", "Members: [1]", "Read an independent current original",
    "not a new approval gate", "not current tasks or activity", "No runtime PASS", "Do not deploy"]) assert(text.includes(term), term);
  assert(!text.includes("exact-root-digest"));
  const diagnostic = formatTerminalGraph(value, { diagnostics: true, columns: 240 });
  assert(diagnostic.includes("exact-root-digest")); assert(diagnostic.includes('"historicalContentAvailable": false'));
  assert.equal(text.split(node.workContent.summary).length - 1, 1);
  assert.equal(JSON.stringify(value), before);
});

test("narrow no-color text preserves Korean paths, graphemes and all body text instead of truncating evidence", () => {
  const body = "가나다라마바사아자차카타파하🙂e\u0301", output = terminalBlock("Original", body, 16);
  assert(!output.includes("…")); assert.equal(output.split("\n").slice(1, -1).map(line => line.slice(4)).join(""), body);
  assert(!/\n  \| \p{Mark}/u.test(output)); noControls(output);
  assert.equal(inertTerminalText("\r\b\u001b\u009b\t"), "\\u000d\\u0008\\u001b\\u009b    ");
  const empty = formatCliResult("graph-query", { kind: "ProjectGraphDiscoveryProjection", nodes: [], edges: [], status: "not_initialized" }, { columns: 16 });
  assert(empty.includes("No selected")); assert(!empty.includes("must initialize"));
});

test("cited A/B roles and recorded after remain distinct when later current bytes differ", () => {
  const value = graph(); value.contextLineage = { files: [{ path: "src/action.mjs", comparisons: [{ scope: "explicit-work-chain-citation-pair-not-request-boundary",
    status: "observed", currentMatchesRecordedAfter: false, labels: { before: "Cited version A", after: "Cited version B - not necessarily current" }, symbols: [],
    diff: { changed: true, before: { startLine: 1, text: "prior" }, after: { startLine: 1, text: "cited" } } }] }] };
  const cited = formatTerminalGraph(value, { columns: 120 });
  assert(cited.includes("Cited version B - not necessarily current differs from current")); assert(!cited.includes("Recorded after"));
  const pair = value.contextLineage.files[0].comparisons[0]; delete pair.labels; pair.scope = "recorded-changeset-snapshot-pair";
  assert(formatTerminalGraph(value, { columns: 120 }).includes("Recorded after differs from current"));
});

test("terminal keeps separate changed regions, exact detail anchors and actionable unavailable reasons", () => {
  const value = graph(); value.basis.worldModelId = "world-model-" + "a".repeat(24);
  value.contextLineage = { files: [{ path: "src/action.mjs", currentObservation: { reasonCode: "SOURCE_BYTE_BOUND", explanation: "Current source bytes are unavailable." }, comparisons: [{ status: "unknown", reasonCode: "EXACT_SOURCE_PAIR_UNAVAILABLE",
    gaps: [{ path: "src/action.mjs", reasonCode: "EACCES" }, { reasonCode: "LOCAL_GIT_READ_BUDGET_REACHED" }],
    diff: { changed: true, before: { startLine: 7, text: "old early" }, after: { startLine: 7, text: "new early" }, regions: [
      { before: { startLine: 7, text: "old early" }, after: { startLine: 7, text: "new early" } },
      { before: { startLine: 997, text: "old late" }, after: { startLine: 997, text: "new late", omittedLines: 10, omittedRanges: [{ startLine: 1000, endLine: 1009 }] } },
    ], coverage: { omittedRegionCount: 3 } } }] }], gaps: [{ reasonCode: "RETAINED_SOURCE_SNAPSHOT_LOOKUP_BUDGET_REACHED", uninspectedSnapshotCount: 40 }] };
  const before = JSON.stringify(value), text = formatTerminalGraph(value, { columns: 240 });
  for (const term of ["region 2/2, line 997", "new late", "lines 1000-1009", "3 further changed regions", "Read [1] details", '--anchors "a" --depth 0 --details', '--world-model "world-model-',
    "SOURCE_BYTE_BOUND", "Exact source exceeds the byte bound", "Read permission denied", "narrow the selected paths or anchors", "40 snapshots not inspected", "the requested pair may remain outside it"]) assert(text.includes(term), term);
  assert.equal(JSON.stringify(value), before);
  value.nodes[0].nodeId = 'untrusted\"; echo bad';
  const unsafe = formatTerminalGraph(value, { columns: 240 });
  assert(!unsafe.includes('--anchors "untrusted')); assert(unsafe.includes("quote for your shell"));
});

function cli(t, args, cwd, env, redirect = null, entry = "scripts/lode.mjs") {
  const full = [path.join(pluginRoot, entry), ...args];
  t.diagnostic(JSON.stringify({ event: "planned-child", command: process.execPath, args: full, parent: process.pid, cwd, ports: [] }));
  const fd = redirect ? fs.openSync(redirect, "wx") : null;
  let result;
  try { result = spawnSync(process.execPath, full, { cwd, env: { ...process.env, ...env }, windowsHide: true, shell: false,
    encoding: "utf8", timeout: 20000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", fd ?? "pipe", "pipe"] }); }
  finally { if (fd !== null) fs.closeSync(fd); }
  t.diagnostic(JSON.stringify({ event: "closed-child", pid: result.pid, parent: process.pid, status: result.status, signal: result.signal, ports: [] }));
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  return redirect ? fs.readFileSync(redirect, "utf8") : result.stdout;
}
test("actual CLI stdout, redirect, diagnostics and raw JSON consume the same Run-free World-free reader without writes", async t => {
  const f = fixture(t); f.save({ summary: "Research connection only; local evidence", pending: ["Review before any deployment"], unknowns: ["No completed runtime outcome"],
    judgments: [{ assessment: "Proposal only", reason: "Do not deploy\nSTATUS: SUCCESS" }] });
  const before = snapshot(f.root), args = ["graph-query", f.root, "--query", "Research connection", "--details"], env = { NO_COLOR: "1", COLUMNS: "88" };
  const expected = await queryProjectGraph({ root: f.root, query: "Research connection", details: true, depth: 1 });
  const wide = cli(t, args, f.root, env), redirected = cli(t, args, f.root, { ...env, COLUMNS: "24" }, path.join(f.base, "stdout.txt"));
  const diagnostics = cli(t, [...args, "--diagnostics"], f.root, env), raw = cli(t, [...args, "--json"], f.root, env), machine = JSON.parse(raw);
  assert.deepEqual(machine.nodes, expected.nodes); assert.deepEqual(machine.edges, expected.edges); assert.deepEqual(machine.contextLineage, expected.contextLineage);
  assert(wide.includes("Research connection only")); assert(wide.includes("Review before any deployment"));
  assert(diagnostics.includes("Exact result diagnostics")); assert(!/^STATUS: SUCCESS$/mu.test(wide)); noControls(wide); noControls(redirected);
  assert.deepEqual(snapshot(f.root), before);
  if (process.env.LODE_R6_EVIDENCE) for (const [name, text] of [["actual-cli-wide.txt", wide], ["actual-cli-redirect-24.txt", redirected], ["actual-cli-diagnostics.txt", diagnostics], ["actual-cli-raw.json", raw]])
    fs.writeFileSync(path.join(process.env.LODE_R6_EVIDENCE, name), text, { flag: "wx" });
});

test("bootstrap reuses selected runtime and preserved instructions while package identity does not imply Host loading", async t => {
  const f = fixture(t), original = fs.readFileSync(path.join(f.root, "AGENTS.md"));
  const first = await initializeOrResumeProject({ root: f.root, pluginRoot, instructionIntegration: "preserve" });
  const second = await initializeOrResumeProject({ root: f.root, pluginRoot });
  assert.equal(first.project.projectId, second.project.projectId); assert.equal(first.runtime.loadedPackageScope, "executing-cli-or-library-not-host-tool-inventory");
  assert.equal(second.runtime.hostLoadObservation, "not-observed-by-project-package-inspection"); assert(fs.readFileSync(path.join(f.root, "AGENTS.md")).equals(original));
  assert.equal(second.nextAction.id, "work_directly");
  const output = formatProjectStatus(second, { doctor: true }); assert(output.includes("Executing CLI/library package"));
  assert(output.includes("not observed")); assert(!output.includes("Host restart: not required"));
  const selectedRoot = path.join(f.base, "selected-client"); fs.mkdirSync(selectedRoot);
  fs.writeFileSync(path.join(selectedRoot, "AGENTS.md"), original);
  const selected = await initializeOrResumeProject({ root: selectedRoot, pluginRoot, runtimes: ["codex"], instructionIntegration: "preserve" });
  assert.deepEqual(selected.project.runtimes, ["codex"]); assert(!fs.existsSync(path.join(selectedRoot, "CLAUDE.md")));
  assert(!fs.existsSync(path.join(selectedRoot, "opencode.json"))); assert(!fs.existsSync(path.join(selectedRoot, ".mcp.json")));
  assert(fs.readFileSync(path.join(selectedRoot, "AGENTS.md")).equals(original));
});

test("common distribution install reuses synthetic files and project identity with native acquisition explicitly off", t => {
  const f = fixture(t), selectedRoot = path.join(f.base, "new-project"), installRoot = path.join(f.base, "user-data"), binDirectory = path.join(f.base, "bin");
  fs.mkdirSync(selectedRoot); const original = "# Existing user instructions\nKeep my scope.\n";
  fs.writeFileSync(path.join(selectedRoot, "AGENTS.md"), original);
  const args = ["install", "--source", pluginRoot, "--install-root", installRoot, "--bin-dir", binDirectory, "--native", "off", "--project", selectedRoot, "--runtime", "codex"];
  const first = JSON.parse(cli(t, args, f.base, {}, null, "scripts/distribution.mjs"));
  const second = JSON.parse(cli(t, args, f.base, {}, null, "scripts/distribution.mjs"));
  assert.equal(first.releaseId, second.releaseId); assert.equal(first.project.project.projectId, second.project.project.projectId);
  assert.equal(first.project.sessionId, second.project.sessionId); assert.equal(second.project.nextAction.id, "work_directly");
  assert.equal(second.project.runtime.hostLoadObservation, "not-observed-by-project-package-inspection");
  assert.equal(second.native.status, "javascript-fallback"); assert.equal(fs.readFileSync(path.join(selectedRoot, "AGENTS.md"), "utf8"), original);
  assert(!fs.existsSync(path.join(selectedRoot, "CLAUDE.md"))); assert(!fs.existsSync(path.join(selectedRoot, "opencode.json")));
});

test("four actual marketplace packages load the terminal module and ship agent-led entry instructions offline", async t => {
  const f = fixture(t), value = graph();
  for (const [client, build] of [["codex", buildCodexMarketplaceSnapshot], ["claude", buildClaudeMarketplaceSnapshot]]) for (const name of ["lode-agent-plugin", "head-agent-plugin"]) {
    const outputRoot = path.join(f.base, `${client}-${name}`), built = build({ sourceRoot: pluginRoot, outputRoot, name, repository: "local", commit: "local" });
    const root = path.join(outputRoot, "plugins", built.pluginName), installed = await import(pathToFileURL(path.join(root, "scripts/lib/cli-presentation.mjs")));
    assert(installed.formatCliResult("graph-query", value).includes("Selected connections"));
    const skill = fs.readFileSync(path.join(root, "skills", built.pluginName, "SKILL.md"), "utf8");
    assert.match(skill, /For an authorized installation\/update request, perform the selected client's\s+available official procedure and verify its result/);
    assert(skill.includes("../../README.md#install")); assert(fs.existsSync(path.join(root, "README.md")));
    assert(skill.includes("Host loading"));
  }
});

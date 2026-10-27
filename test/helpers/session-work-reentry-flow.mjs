import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inspectProject } from "../../scripts/lib/lode-core.mjs";
import { withSessionRoute } from "../../scripts/lib/session-routing.mjs";
import { readProjectDirection, readProjectDirectionRevision, updateProjectDirection } from "../../scripts/lib/project-direction.mjs";
import { recordSessionWorkEvidence } from "../../scripts/lib/session-work-context.mjs";
import { createSourceObservation, retainSourceObservation } from "../../scripts/lib/source-observation.mjs";
import { queryProjectGraph } from "../../scripts/lib/project-graph.mjs";
import { enterConversationRecovery } from "../../scripts/lib/compaction-lifecycle.mjs";
import { inspectRecoveryCheckpointBasis, syncRecoveryCheckpoint, readRecoveryCheckpoint } from "../../scripts/lib/compaction-recovery.mjs";

const [phase, root, sessionId] = process.argv.slice(2);
assert(["first", "resume"].includes(phase));
assert.match(path.basename(path.dirname(root)), /^head-work-linkage-/u);
const relative = "src/format.mjs", sourceFile = path.join(root, relative);
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const exact = record => ({ evidenceId: record.evidence.evidenceId, evidenceDigest: record.evidence.evidenceDigest });
const original = file => ({ file: path.relative(root, file).replaceAll("\\", "/"), digest: sha(fs.readFileSync(file)),
  mode: fs.statSync(file).mode, mtimeMs: fs.statSync(file).mtimeMs });
const retain = (owner, bytes) => retainSourceObservation(root, createSourceObservation({ version: 1, projectId: owner.project.projectId,
  kind: "source", query: [{ path: relative, symbol: "" }], sources: [{ path: relative, digest: sha(bytes), base64: bytes.toString("base64") }],
  profile: {}, observedAt: new Date().toISOString(), response: null, envelopeHash: null }, owner.storage), owner.storage);
const sourceRef = bytes => ({ kind: "source", path: relative, digest: sha(bytes) });
const checkpoint = position => syncRecoveryCheckpoint({ root,
  expectedRecoveryBasisId: inspectRecoveryCheckpointBasis({ root }).basis.basisId,
  purpose: "Normalize labels and format lists using only this synthetic source",
  approvedDecisions: ["Trim individual labels before joining a list"], currentPosition: position,
  nextExpectedResult: position === "Label formatting done; formatList remains" ? "Complete formatList using formatLabel" : "Report the verified local result" });
const todo = { todoId: "todo-finish-list-format", task: "Complete formatList using formatLabel", origin: "user-directed", nextAction: "Finish only src/format.mjs" };

const output = await withSessionRoute(root, sessionId, async () => {
  const owner = inspectProject(root);
  assert.equal(owner.state.sessionId, sessionId);
  if (phase === "first") {
    const direction = updateProjectDirection({ root, input: { goal: "Normalize labels and format lists locally", constraints: [],
      decisions: ["Trim individual labels before joining a list"], cancelledActions: [] } }).direction;
    const directionFile = path.join(root, owner.storage.directory, "project-direction/revisions", `${direction.directionId}.json`);
    const decisionRef = { kind: "artifact", path: path.relative(root, directionFile).replaceAll("\\", "/"), digest: sha(fs.readFileSync(directionFile)) };
    const initial = fs.readFileSync(sourceFile); retain(owner, initial);
    const first = recordSessionWorkEvidence({ root, input: { summary: "Use one label formatter for list output", references: [decisionRef, sourceRef(initial)],
      judgments: [{ assessment: "Reuse formatLabel", reason: "Keep one normalization rule", alternatives: ["Repeat trimming inside formatList"] }],
      todos: [{ ...todo, status: "pending" }], suggestedFollowUp: ["Deployment was only an unapproved suggestion"] } });
    const changed = initial.toString().replace("return String(value);", "return String(value).trim();");
    assert.notEqual(changed, initial.toString()); fs.writeFileSync(sourceFile, changed);
    const actual = await import(pathToFileURL(sourceFile).href); assert.equal(actual.formatLabel(" a "), "a");
    const after = fs.readFileSync(sourceFile); retain(owner, after);
    const partial = recordSessionWorkEvidence({ root, input: { summary: "Label formatting implemented; list formatting remains", references: [decisionRef, sourceRef(after)],
      workLink: { root: exact(first), predecessor: exact(first) }, pending: [todo.task],
      todos: [{ ...todo, status: "partial", progress: "formatLabel trims; formatList is not finished", prior: exact(first) }] } });
    const saved = checkpoint("Label formatting done; formatList remains"); assert.equal(saved.outcome, "created");
    const graph = await queryProjectGraph({ root, anchorIds: [first.evidence.evidenceId, partial.evidence.evidenceId], paths: [relative], details: true, depth: 2 });
    const pair = graph.contextLineage.files.find(file => file.path === relative).comparisons.find(pair => pair.before?.digest === sha(initial) && pair.after?.digest === sha(after));
    assert(pair?.diff.changed); assert(pair.diff.regions.length > 0);
    assert(graph.edges.some(edge => edge.type === "CITES_ARTIFACT" && edge.from === first.evidence.evidenceId && edge.to === direction.directionId));
    return { phase, directionId: direction.directionId, checkpointId: saved.checkpoint.checkpointId,
      workIds: [first.evidence.evidenceId, partial.evidence.evidenceId], firstDigest: sha(initial), partialDigest: sha(after),
      diff: pair.diff, originals: [directionFile, first.file, partial.file].map(original) };
  }
  const entered = enterConversationRecovery({ root });
  assert.equal(entered.workContext.sessionId, sessionId);
  const current = readProjectDirection({ root });
  assert(current.input.cancelledActions.includes("deploy"));
  assert.equal(entered.projectStatus.currentProjectDirection.directionId, current.directionId);
  const work = entered.workContext.records, partial = work.find(record => record.content.todos?.some(item => item.todoId === todo.todoId && item.status === "partial"));
  assert(partial); assert(partial.content.pending.includes(todo.task));
  const decisionRef = partial.content.references.find(reference => reference.kind === "artifact");
  const decisionId = path.basename(decisionRef.path, ".json");
  const oldDirection = readProjectDirectionRevision({ root, directionId: decisionId });
  assert(oldDirection.input.decisions.includes("Trim individual labels before joining a list"));
  assert.notEqual(oldDirection.directionId, current.directionId);
  const saved = readRecoveryCheckpoint({ root, checkpointId: inspectProject(root).state.latestCheckpoint }).checkpoint;
  assert.equal(saved.nextExpectedResult, todo.task);
  const before = fs.readFileSync(sourceFile);
  const graph = await queryProjectGraph({ root, anchorIds: [partial.evidenceId], paths: [relative], details: true, depth: 2 });
  assert(graph.contextLineage.files.find(file => file.path === relative).comparisons.some(pair => pair.diff?.changed && pair.diff.regions.length > 0));
  const finished = before.toString().replace('return values.join(",");', 'return values.map(formatLabel).join(",");');
  assert.notEqual(finished, before.toString()); fs.writeFileSync(sourceFile, finished);
  const actual = await import(pathToFileURL(sourceFile).href); assert.equal(actual.formatList([" a ", " b "]), "a,b");
  const after = fs.readFileSync(sourceFile); retain(owner, after);
  const completed = recordSessionWorkEvidence({ root, input: { summary: "Verified normalized list output in the fresh consumer process", references: [decisionRef, sourceRef(after)],
    workLink: { root: partial.content.workLink.root, predecessor: { evidenceId: partial.evidenceId, evidenceDigest: partial.evidenceDigest } },
    todos: [{ ...todo, status: "completed", progress: "Actual formatList returned a,b", prior: { evidenceId: partial.evidenceId, evidenceDigest: partial.evidenceDigest } }] } });
  const done = checkpoint("Both local functions verified"); assert.equal(done.outcome, "created");
  assert.equal(readProjectDirection({ root }).directionId, current.directionId);
  return { phase, recoveredCheckpointId: saved.checkpointId, checkpointId: done.checkpoint.checkpointId,
    recoveredWorkId: partial.evidenceId, completedWorkId: completed.evidence.evidenceId,
    recoveredDecisionId: oldDirection.directionId, currentDirectionId: current.directionId,
    currentCancellation: current.input.cancelledActions, beforeDigest: sha(before), afterDigest: sha(after), observedResult: actual.formatList([" a ", " b "]) };
});
process.stdout.write(JSON.stringify({ ...output, process: { pid: process.pid, parentPid: process.ppid, command: process.execPath,
  args: process.argv.slice(1), cwd: process.cwd(), ports: [], actualProviderInvoked: false, actualHostRestartProven: false } }) + "\n");

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject } from "../scripts/lib/lode-core.mjs";
import { createLodeSession, withSessionRoute, sessionStatePath } from "../scripts/lib/session-routing.mjs";
import { recordSessionWorkEvidence, readSessionWorkContext } from "../scripts/lib/session-work-context.mjs";
import { verifySessionWorkEvidenceOwner } from "../scripts/lib/session-work-evidence-original.mjs";
import { queryProjectGraph, indexProjectGraph } from "../scripts/lib/project-graph.mjs";
import { withProjectMutation } from "../scripts/lib/project-mutation-lock.mjs";
import { runCommand } from "../scripts/lode.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";
import { formatCliResult } from "../scripts/lib/cli-presentation.mjs";
import { sha, encoded, exact, link, citation } from "./helpers/session-work-linkage-fixture.mjs";
import { assertTerminalGraphPresentation } from "./helpers/terminal-graph-assertions.mjs";

// Portable public-API synthetic cases. No subprocess, installed Host, provider,
// model, external database or machine-local .agent-work dependency.
const pluginRoot = path.resolve(import.meta.dirname, "..");
const needle = "GenerationReasonNeedle";
const sourcePath = "src/cache-policy.json";
const isWork = node => node.kind === "Evidence" && node.subtype === "SessionWorkEvidence";
const work = result => result.nodes.filter(isWork);
const relative = (f, file) => path.relative(f.root, file).replaceAll("\\", "/");
const nodeFor = (result, saved) => work(result).find(node => node.nodeId === saved.evidence.evidenceId);
function assertJsonMember(text, name, value) {
  if (value !== undefined) assert.ok(text.includes(JSON.stringify({ [name]: value }, null, 2).slice(2, -2)), `Missing original ${name}`);
}
function assertHistoricalPresentation(text, result, node) {
  if (text.startsWith("Selected connections:")) return assertTerminalGraphPresentation(text, result);
  const index = result.nodes.indexOf(node), start = text.indexOf(`Node[${index}]:\n`);
  assert.ok(start >= 0, `Missing Node[${index}]`);
  const ends = [text.indexOf(`Node[${index + 1}]:\n`, start), text.indexOf("Edge[0]:\n", start)].filter(offset => offset >= 0);
  const section = text.slice(start, ends.length ? Math.min(...ends) : undefined);
  for (const name of ["nodeId", "projectId", "sessionId"]) {
    if (node[name] !== undefined) assert.ok(section.includes(`${name}: ${JSON.stringify(node[name])}`), `Missing owner/identity ${name}`);
  }
  for (const judgment of node.workContent.judgments) {
    for (const text of [judgment.assessment, judgment.reason, ...judgment.alternatives]) assert.ok(section.includes(text), `Missing original judgment: ${text}`);
  }
  for (const text of [...node.workContent.pending, ...node.workContent.unknowns]) assert.ok(section.includes(text), `Missing original unresolved work: ${text}`);
  for (const name of ["evidenceDigest", "referenceEvidence", "originalExpansion"]) assertJsonMember(section, name, node[name]);
  const { partial, ...coverage } = node.workContentCoverage;
  assert.ok(section.includes(`workContentCoverage.partial: ${JSON.stringify(partial)}`));
  for (const [name, value] of Object.entries(coverage)) assertJsonMember(section, name, value);
  for (const name of ["coverage", "sourceFallback"]) assertJsonMember(text, name, result[name]);
}

function fixture(t) {
  const temporaryRoot = process.env.LODE_AGENT_TEST_TMP || process.env.HEAD_AGENT_TEST_TMP || os.tmpdir();
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const parent = fs.realpathSync(temporaryRoot);
  const base = fs.realpathSync(fs.mkdtempSync(path.join(parent, "head-source-reference-")));
  const root = path.join(base, "project"); fs.mkdirSync(root);
  const initialized = initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  assert.equal(initialized.storage.projectRoot, fs.realpathSync(root));
  assert.equal(initialized.storage.projectId, initialized.project.projectId);
  const managementRoot = path.join(root, initialized.storage.directory);
  const session = createLodeSession({ root, purpose: "Local historical source-reference investigation; no external effects" });
  t.after(() => {
    assert.equal(path.dirname(base), parent);
    assert.ok(path.basename(base).startsWith("head-source-reference-"));
    assert.equal(fs.realpathSync(base), base);
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { base, root, managementRoot, projectId: initialized.project.projectId, storage: initialized.storage, session,
    save(input, sessionId = session.sessionId) {
      return withSessionRoute(root, sessionId, () => recordSessionWorkEvidence({ root, input }));
    },
    read(saved) {
      return withSessionRoute(root, saved.evidence.sessionId, () => readSessionWorkContext({ root,
        evidenceIds: [saved.evidence.evidenceId], maxRecords: 1, maxCharacters: 524288 }));
    },
  };
}
function target(f, name = sourcePath, bytes = "version 11") {
  const file = path.join(f.root, name); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return { file, reference: { path: name, digest: sha(fs.readFileSync(file)), kind: "source" } };
}
const saveReason = (f, references, extra = {}) => f.save({ summary: "Retained judgment", judgments: [{
  assessment: "Compare generation numbers", reason: `${needle}: compare request-start with response-arrival, not elapsed client time`,
  alternatives: ["Client-clock TTL cannot establish ordering"] }], pending: ["Local write-before-check follow-up remains"],
  unknowns: ["Cancellation and external effects are not established by this historical note"], references, ...extra });
const request = (f, options = {}) => ({ root: f.root, view: "work", paths: [sourcePath], query: needle, depth: 0, ...options });

// Include symlink metadata without following a synthetic escape target. This
// snapshot is the query-write invariant, not an atomic filesystem observation.
function snapshot(base) {
  const rootStat = fs.lstatSync(base);
  const result = { "": { directory: true, mode: rootStat.mode, mtimeMs: rootStat.mtimeMs } };
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name), stat = fs.lstatSync(file), key = path.relative(base, file);
      if (stat.isSymbolicLink()) result[key] = { link: fs.readlinkSync(file), mode: stat.mode, mtimeMs: stat.mtimeMs };
      else if (stat.isDirectory()) { result[key] = { directory: true, mode: stat.mode, mtimeMs: stat.mtimeMs }; walk(file); }
      else result[key] = { digest: sha(fs.readFileSync(file)), bytes: stat.size, mode: stat.mode, mtimeMs: stat.mtimeMs };
    }
  }
  walk(base); return result;
}
function withoutWrites(action) {
  const restore = [], attempts = [];
  const rejected = name => { attempts.push(name); throw new Error("Graph read attempted " + name); };
  const block = (object, name, asynchronous = false) => {
    const original = object[name]; if (typeof original !== "function") return;
    restore.push(() => { object[name] = original; });
    object[name] = asynchronous ? async () => rejected(name) : () => rejected(name);
  };
  const writable = flags => typeof flags === "number"
    ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND))
    : /[wa+]/u.test(flags || "");
  for (const [object, name] of [[fs, "openSync"], [fs, "open"], [fs.promises, "open"]]) {
    const original = object[name]; restore.push(() => { object[name] = original; });
    object[name] = function (file, flags, ...args) {
      if (writable(flags)) return rejected(name);
      return original.call(this, file, flags, ...args);
    };
  }
  for (const name of ["writeFileSync", "appendFileSync", "writeSync", "mkdirSync", "renameSync", "unlinkSync", "rmSync", "rmdirSync", "truncateSync", "ftruncateSync", "chmodSync", "fchmodSync", "utimesSync", "linkSync", "symlinkSync", "createWriteStream",
    "writeFile", "appendFile", "write", "mkdir", "rename", "unlink", "rm", "rmdir", "truncate", "ftruncate", "chmod", "fchmod", "utimes", "link", "symlink"]) block(fs, name);
  for (const name of ["writeFile", "appendFile", "mkdir", "rename", "unlink", "rm", "rmdir", "truncate", "chmod", "utimes", "link", "symlink"]) block(fs.promises, name, true);
  const finish = () => {
    for (const undo of restore.reverse()) undo();
    assert.deepEqual(attempts, [], "Caught writes must not be hidden by a successful fallback");
  };
  let result;
  try { result = action(); }
  catch (error) { finish(); throw error; }
  if (result && typeof result.then === "function") return Promise.resolve(result).finally(finish);
  finish(); return result;
}
async function readOnly(f, options) {
  const before = snapshot(f.base), result = await withoutWrites(() => queryProjectGraph(options));
  assert.deepEqual(snapshot(f.base), before, "A query must not persist, repair index or change P2/Session selection");
  return result;
}
function original(result, f, saved) {
  const node = nodeFor(result, saved); assert.ok(node, `Missing exact work original ${saved.evidence.evidenceId}`);
  assert.equal(node.origin.layer, "sessionWork"); assert.equal(node.origin.path, relative(f, saved.file));
  assert.equal(node.sourceReference.path, relative(f, saved.file));
  assert.equal(node.sourceReference.digest, sha(fs.readFileSync(saved.file)));
  assert.equal(node.evidenceDigest, saved.evidence.evidenceDigest); assert.equal(node.sessionId, saved.evidence.sessionId);
  assert.deepEqual(node.workContent, saved.evidence.content); assert.equal(node.workContentCoverage.partial, false);
  assert.equal(node.freshness, "intact-historical-work-evidence");
  for (const value of [result.authority, node]) for (const field of ["instructionAuthority", "promotionAuthority", "recoveryAuthority", "executionAuthority"]) assert.equal(value[field], false);
  assert.equal(result.authority.ordinaryWorkBlocked, false);
  return node;
}
function referenceFact(node, ref, expected) {
  const fact = node.referenceEvidence.find(value => value.path === ref.path && value.kind === ref.kind && value.digest === ref.digest);
  assert.ok(fact, "Missing distinct canonical reference fact");
  assert.equal(fact.contentReconstructed, false);
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(fact[key], value, key);
  return fact;
}
function rewriteOriginal(saved, mutate) {
  const value = JSON.parse(fs.readFileSync(saved.file, "utf8")); mutate(value);
  const { evidenceDigest, ...payload } = value;
  fs.writeFileSync(saved.file, JSON.stringify({ ...payload, evidenceDigest: sha(encoded(payload)) }, null, 2) + "\n");
}

test("C1 explicit source path plus body query preserves exact original provenance, slash normalization and path OR", async t => {
  const f = fixture(t), source = target(f), saved = saveReason(f, [source.reference]);
  for (const paths of [[sourcePath], [sourcePath.replaceAll("/", "\\")], ["not-recorded.txt", sourcePath], [relative(f, saved.file)]]) {
    const value = await readOnly(f, request(f, { paths })), node = original(value, f, saved);
    assert.equal(value.query.maxNodes, 8); assert.equal(value.query.maxEdges, 12);
    referenceFact(node, source.reference, { status: "matching-current-bytes", currentness: "current", currentDigest: source.reference.digest, historicalContentAvailable: true });
    assert.notEqual(node.sourceReference.path, sourcePath);
  }
  const differentCase = await readOnly(f, request(f, { paths: ["SRC/cache-policy.json"] }));
  assert.equal(nodeFor(differentCase, saved), undefined, "Logical paths are not case-folded even on case-insensitive filesystems");
});

test("C1 current, same-size/mtime changed, missing and reappeared targets retain historical name eligibility and diagnostics", async t => {
  const f = fixture(t), source = target(f), saved = saveReason(f, [source.reference]);
  const initialBytes = fs.readFileSync(source.file), stat = fs.statSync(source.file);
  const stages = [
    { state: "current", status: "matching-current-bytes", reason: undefined, bytes: initialBytes },
    { state: "changed", status: "unavailable", reason: "SESSION_WORK_REFERENCE_CHANGED", bytes: Buffer.from("version 22") },
    { state: "missing", status: "unavailable", reason: "ENOENT", bytes: null },
    { state: "current", status: "matching-current-bytes", reason: undefined, bytes: initialBytes },
  ];
  for (const stage of stages) {
    if (stage.bytes === null) fs.unlinkSync(source.file);
    else { fs.writeFileSync(source.file, stage.bytes); fs.utimesSync(source.file, stat.atime, stat.mtime); }
    const result = await readOnly(f, request(f)), node = original(result, f, saved);
    const fact = referenceFact(node, source.reference, { status: stage.status, currentness: stage.state,
      currentDigest: stage.bytes === null ? null : sha(stage.bytes), historicalContentAvailable: stage.state === "current" });
    assert.equal(fact.reasonCode, stage.reason);
    assert.deepEqual(node.workContent.pending, ["Local write-before-check follow-up remains"]);
    if (stage.reason) assert.ok(result.integrity.excluded.some(item => item.reasonCode === stage.reason && item.path === relative(f, saved.file)));
  }
});

for (const mode of ["oversized", "nonfile"]) test(`C1 ${mode} target remains a historical name without relaxing existing reference read bounds`, async t => {
  const f = fixture(t), source = target(f), saved = saveReason(f, [source.reference]);
  if (mode === "oversized") fs.writeFileSync(source.file, Buffer.alloc(16 * 1024 * 1024 + 1, 65));
  else { fs.unlinkSync(source.file); fs.mkdirSync(source.file); }
  const result = await readOnly(f, request(f)), node = original(result, f, saved);
  referenceFact(node, source.reference, { status: "unavailable", currentness: "unavailable", currentDigest: null,
    reasonCode: "SESSION_WORK_REFERENCE_UNAVAILABLE", historicalContentAvailable: false });
  const before = snapshot(f.base), exactRead = await withoutWrites(() => f.read(saved));
  assert.equal(exactRead.records.length, 1);
  assert.equal(exactRead.records[0].references[0].status, "unavailable");
  assert.equal(exactRead.records[0].references[0].reasonCode, "SESSION_WORK_REFERENCE_UNAVAILABLE");
  assert.equal(Object.hasOwn(exactRead.records[0].references[0], "excerpt"), false);
  assert.deepEqual(snapshot(f.base), before);
});

for (const code of ["EACCES", "EPERM", "EIO", null]) test(`C1 injected ${code || "generic"} target failure is diagnostic, not a status allowlist or global work gate`, async t => {
  const f = fixture(t), source = target(f), saved = saveReason(f, [source.reference]), read = fs.readFileSync;
  const before = snapshot(f.base); let attempts = 0, result;
  fs.readFileSync = function (file, ...args) {
    if (path.resolve(String(file)) === source.file) { attempts++; throw Object.assign(new Error("Synthetic unavailable reference"), code ? { code } : {}); }
    return read.call(this, file, ...args);
  };
  try { result = await withoutWrites(() => queryProjectGraph(request(f, { previousResult: { resultId: "not-a-retained-fault-result" } }))); }
  finally { fs.readFileSync = read; }
  assert.ok(attempts > 0, "Fault must reach the existing target reader");
  const node = original(result, f, saved);
  referenceFact(node, source.reference, { status: "unavailable", currentness: "unavailable", currentDigest: null,
    reasonCode: code || "INVALID_REFERENCE", historicalContentAvailable: false });
  assert.deepEqual(snapshot(f.base), before);
  t.diagnostic("Injected filesystem failure verifies reason mapping only, not real OS ACL behavior");
});

test("C1 artifact-only references never acquire source-name eligibility; dual and mixed references use per-ref OR", async t => {
  const f = fixture(t), projectId = f.projectId;
  const source = target(f, sourcePath, JSON.stringify({ projectId, label: "Same physical bytes" }));
  const artifact = { ...source.reference, kind: "artifact" }, only = saveReason(f, [artifact], { summary: "Artifact-only judgment" });
  const dual = saveReason(f, [artifact, source.reference], { summary: "Two explicitly different kinds" });
  const second = target(f, "src/second.txt"), mixed = saveReason(f, [artifact, second.reference], { summary: "Artifact first, independent source second" });
  let result = await readOnly(f, request(f));
  assert.equal(nodeFor(result, only), undefined); assert.equal(nodeFor(result, mixed), undefined);
  const dualNode = original(result, f, dual);
  assert.deepEqual(dualNode.referenceEvidence.map(ref => ref.kind), ["artifact", "source"]);
  referenceFact(dualNode, artifact, { status: "intact-retained-original", currentness: "current", currentDigest: artifact.digest });
  referenceFact(dualNode, source.reference, { status: "matching-current-bytes", currentness: "current", currentDigest: source.reference.digest });
  original(await readOnly(f, request(f, { paths: [relative(f, only.file)] })), f, only);
  result = await readOnly(f, request(f, { paths: [sourcePath, second.reference.path] }));
  original(result, f, dual); original(result, f, mixed); assert.equal(nodeFor(result, only), undefined);
  fs.unlinkSync(source.file);
  result = await readOnly(f, request(f));
  assert.equal(nodeFor(result, only), undefined);
  referenceFact(original(result, f, dual), source.reference, { currentness: "missing", reasonCode: "ENOENT" });
  const mixedResult = await readOnly(f, request(f, { paths: [sourcePath, second.reference.path] }));
  referenceFact(original(mixedResult, f, mixed), second.reference, { currentness: "current" });
});

test("C1 observed symlink escape excludes only that new association, retaining old origin and another healthy source OR", async t => {
  const f = fixture(t), source = target(f), healthy = target(f, "src/healthy.txt");
  const saved = saveReason(f, [source.reference]), mixed = saveReason(f, [source.reference, healthy.reference], { summary: "Mixed source associations" });
  const outside = path.join(f.base, "outside-project.txt"); fs.writeFileSync(outside, "Synthetic outside bytes"); fs.unlinkSync(source.file);
  try { fs.symlinkSync(outside, source.file, "file"); }
  catch (error) { if (["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes(error.code)) { t.skip(`Actual symlink fixture unavailable: ${error.code}; physical escape behavior unverified`); return; } throw error; }
  const rejected = await readOnly(f, request(f));
  assert.equal(nodeFor(rejected, saved), undefined); assert.equal(nodeFor(rejected, mixed), undefined);
  const oldOrigin = original(await readOnly(f, request(f, { paths: [relative(f, saved.file)] })), f, saved);
  referenceFact(oldOrigin, source.reference, { reasonCode: "SESSION_PATH_ESCAPE", status: "unavailable", currentness: "unavailable" });
  const result = await readOnly(f, request(f, { paths: [sourcePath, healthy.reference.path] }));
  const node = original(result, f, mixed);
  referenceFact(node, source.reference, { reasonCode: "SESSION_PATH_ESCAPE" });
  referenceFact(node, healthy.reference, { currentness: "current" });
});

for (const mode of ["digest", "content", "foreign-record-owner", "lexical-reference", "filename"]) test(`C1 ${mode} original rejection cannot be bypassed by historical name association`, async t => {
  const f = fixture(t), source = target(f), bad = saveReason(f, [source.reference], { summary: "Will be rejected" });
  const good = saveReason(f, [source.reference], { summary: "Independent intact judgment" });
  let rejectedPath = relative(f, bad.file);
  if (mode === "digest") { const value = JSON.parse(fs.readFileSync(bad.file)); value.evidenceDigest = "0".repeat(64); fs.writeFileSync(bad.file, JSON.stringify(value)); }
  else if (mode === "filename") { const moved = path.join(path.dirname(bad.file), "work-evidence-" + "f".repeat(24) + ".json"); fs.renameSync(bad.file, moved); rejectedPath = relative(f, moved); }
  else rewriteOriginal(bad, value => {
    if (mode === "content") value.content.summary = "Tampered canonical content";
    else if (mode === "foreign-record-owner") value.sessionId = "session-00000000-0000-0000-0000-000000000000";
    else value.content.references[0].path = "../outside.txt";
  });
  const result = await readOnly(f, request(f));
  original(result, f, good); assert.equal(nodeFor(result, bad), undefined);
  const reasonCode = mode === "lexical-reference" ? "SESSION_WORK_REFERENCE_ESCAPE" : "SESSION_WORK_EVIDENCE_INTEGRITY";
  assert.ok(result.integrity.excluded.some(item => item.path === rejectedPath && item.reasonCode === reasonCode), "Original rejection must remain local and diagnostic");
});

test("C1 invalid named owner does not adopt another Session's source association or block independent work", async t => {
  const f = fixture(t), source = target(f), bad = saveReason(f, [source.reference]);
  const other = createLodeSession({ root: f.root, purpose: "Another independent source investigation" });
  const good = f.save({ summary: `${needle} for another owner`, references: [source.reference] }, other.sessionId);
  const ownerFile = withSessionRoute(f.root, f.session.sessionId, () => sessionStatePath(f.root));
  const owner = JSON.parse(fs.readFileSync(ownerFile)); owner.projectId = "head-" + "0".repeat(20); fs.writeFileSync(ownerFile, JSON.stringify(owner));
  const result = await readOnly(f, request(f));
  assert.equal(nodeFor(result, bad), undefined); assert.equal(original(result, f, good).sessionId, other.sessionId);
  assert.ok(result.integrity.excluded.some(item => item.path === relative(f, bad.file) && item.reasonCode === "HEAD_SESSION_IDENTITY_MISMATCH"));
});

test("C1 lexical source paths remain writer errors before any original is admitted", t => {
  const f = fixture(t), digest = sha("not saved"), before = snapshot(f.base);
  for (const name of ["../outside.txt", "src/../outside.txt", "./src/file.txt", "C:/outside.txt", "/outside.txt", "C:outside.txt", "\\\\server\\share\\outside.txt", "src//file.txt", "src/./file.txt", "src\\..\\outside.txt"]) {
    assert.throws(() => f.save({ summary: "Invalid reference", references: [{ path: name, digest, kind: "source" }] }), { code: "SESSION_WORK_REFERENCE_ESCAPE" });
  }
  assert.deepEqual(snapshot(f.base), before, "Lexical rejection precedes any original/index publication");
});

test("C1 same source in different tasks and Sessions remains distinct; explicit citation keeps actual target owner", async t => {
  const f = fixture(t), source = target(f), first = saveReason(f, [source.reference]);
  const other = createLodeSession({ root: f.root, purpose: "Different task, same logical file" });
  const second = f.save({ summary: `${needle} independent task`, references: [source.reference] }, other.sessionId);
  const citing = saveReason(f, [source.reference, citation(f, second)], { summary: "Explicit cross-Session citation, not shared lineage", workLink: link(first) });
  const initial = await readOnly(f, request(f));
  for (const saved of [first, second, citing]) original(initial, f, saved);
  assert.notEqual(first.evidence.evidenceId, second.evidence.evidenceId);
  const returned = nodeFor(initial, citing).workContent.workLink.root;
  assert.deepEqual(returned, exact(first));
  const connected = await readOnly(f, { root: f.root, view: "work", anchorIds: [nodeFor(initial, citing).nodeId], depth: 1 });
  original(connected, f, second); assert.equal(nodeFor(connected, second).sessionId, other.sessionId);
  assert.ok(connected.edges.some(edge => edge.type === "CITES_WORK_EVIDENCE" && edge.from === citing.evidence.evidenceId && edge.to === second.evidence.evidenceId));
  assert.ok(connected.edges.some(edge => edge.type === "DECLARES_WORK_ROOT" && edge.from === citing.evidence.evidenceId && edge.to === returned.evidenceId));
  assert.ok(!connected.edges.some(edge => edge.type === "DECLARES_WORK_ROOT" && edge.from === citing.evidence.evidenceId && edge.to === second.evidence.evidenceId));
});

test("C1 source-name eligibility does not add that name to query-only search text or defeat exact-anchor precedence", async t => {
  const f = fixture(t), source = target(f, "src/OnlyHistoricalAssociation987.txt"), saved = saveReason(f, [source.reference]);
  const queryOnly = await readOnly(f, { root: f.root, view: "work", query: source.reference.path, depth: 0 });
  assert.equal(nodeFor(queryOnly, saved), undefined, "A reference filename is not added to the work's lexical domain text");
  const before = await readOnly(f, { root: f.root, view: "work", query: needle, depth: 0 });
  original(await readOnly(f, request(f, { paths: [source.reference.path] })), f, saved);
  const after = await readOnly(f, { root: f.root, view: "work", query: needle, depth: 0 });
  assert.deepEqual(after.nodes, before.nodes);
  original(await readOnly(f, { root: f.root, view: "work", anchorIds: [saved.evidence.evidenceId],
    query: "UnmatchedQuery987", paths: ["not-this-path.txt"], depth: 0 }), f, saved);
  const forged = structuredClone(before);
  forged.nodes[0].referenceEvidence = [{ ...source.reference, path: "forged.txt" }];
  const refused = await readOnly(f, request(f, { paths: ["forged.txt"], previousResult: forged }));
  assert.equal(nodeFor(refused, saved), undefined, "Caller projection is not canonical reference authority");
});

for (const mode of ["old", "absent", "partial"]) test(`C1 ${mode} index preserves source-original discovery without read-time repair or World activation`, async t => {
  const f = fixture(t), source = target(f), saved = saveReason(f, [source.reference]), file = path.join(f.managementRoot, "graph-discovery/index.json");
  if (mode === "absent") fs.unlinkSync(file);
  else {
    const index = JSON.parse(fs.readFileSync(file));
    if (mode === "old") { delete index.readerDependencies.sessionWork; delete index.sessionWorkNavigation; index.entries = index.entries.filter(entry => !entry.path.includes("/work-evidence/")); }
    else { index.complete = false; index.entries = []; }
    fs.writeFileSync(file, JSON.stringify(index));
  }
  const result = await readOnly(f, request(f)); original(result, f, saved);
  assert.notEqual(result.reuse.status, "scoped-originals-reused");
  assert.equal(fs.existsSync(path.join(f.managementRoot, "world-model/current.json")), false);
});

test("C1 actual returned detail anchors retain currentness through warm reads, reference mutation and restoration", async t => {
  const f = fixture(t), source = target(f), saved = saveReason(f, [source.reference]);
  const found = original(await readOnly(f, request(f)), f, saved), detail = found.detail;
  assert.deepEqual(detail.anchorIds, [found.nodeId]); assert.equal(detail.depth, 0);
  indexProjectGraph({ root: f.root });
  const options = { root: f.root, ...detail, previousResult: { resultId: "not-a-retained-detail-prime" } };
  const cold = await readOnly(f, options), warm = await readOnly(f, { ...options, previousResult: cold });
  assert.equal(warm.reuse.status, "same-basis-result-reused");
  referenceFact(original(warm, f, saved), source.reference, { currentness: "current" });
  fs.writeFileSync(source.file, "version 22");
  const changed = await readOnly(f, { ...options, previousResult: warm });
  assert.notEqual(changed.reuse.status, warm.reuse.status);
  referenceFact(original(changed, f, saved), source.reference, { currentness: "changed", reasonCode: "SESSION_WORK_REFERENCE_CHANGED" });
  fs.writeFileSync(source.file, "version 11");
  referenceFact(original(await readOnly(f, request(f)), f, saved), source.reference, { currentness: "current" });
});

test("C1 Core, runCommand CLI and direct/read-router MCP preserve historical body, owner and missing-source diagnostics without native resolution", async t => {
  const f = fixture(t), source = target(f), saved = saveReason(f, [source.reference]); fs.unlinkSync(source.file);
  const before = snapshot(f.base); let resolverCalls = 0;
  await withoutWrites(async () => {
    const core = await queryProjectGraph(request(f)), expected = original(core, f, saved);
    const cli = await runCommand(["graph-query", f.root, "--paths", sourcePath, "--query", needle, "--view", "work", "--depth", "0"]);
    const cliNode = original(cli, f, saved);
    assert.deepEqual(cliNode.referenceEvidence, expected.referenceEvidence);
    assertHistoricalPresentation(formatCliResult("graph-query", cli), cli, cliNode);
    // These exact old names deliberately retain the existing legacy alias input
    // coverage; the new exact-expansion case below uses the canonical vocabulary.
    for (const routed of [false, true]) {
      const args = { project_root: f.root, paths: [sourcePath], query: needle, view: "work", depth: 0 };
      const response = await dispatch({ jsonrpc: "2.0", id: "source-reference-consumer", method: "tools/call", params: {
        name: routed ? "head_tools_read" : "head_project_graph",
        arguments: routed ? { name: "head_project_graph", arguments: args } : args,
      } }, { resolveSessionContext() { resolverCalls++; throw new Error("Project graph must not request native binding"); } });
      assert.equal(response.error, undefined, JSON.stringify(response)); assert.notEqual(response.result?.isError, true, JSON.stringify(response));
      const result = response.result.structuredContent;
      const node = original(result, f, saved);
      assertHistoricalPresentation(response.result.content[0].text, result, node);
      assert.deepEqual(node.workContent, expected.workContent); assert.deepEqual(node.referenceEvidence, expected.referenceEvidence);
      referenceFact(node, source.reference, { reasonCode: "ENOENT", currentness: "missing" });
    }
  });
  assert.equal(resolverCalls, 0); assert.deepEqual(snapshot(f.base), before);
});

test("C1 private predicate is source-backed pure association, separate from lexical text and scoring", () => {
  const source = fs.readFileSync(path.join(pluginRoot, "scripts/lib/project-graph.mjs"), "utf8");
  const predicate = source.match(/function matchesExplicitPaths\(node, paths\)\s*\{([\s\S]*?)\n\}/u)?.[1];
  assert.ok(predicate, "Keep the helper private; no test export or new API is required");
  assert.match(predicate, /nodePaths\(node\)/u); assert.match(predicate, /referenceEvidence/u);
  assert.match(predicate, /isWorkNode\(node\)/u); assert.match(predicate, /["']sessionWork["']/u);
  assert.match(predicate, /ref\.kind\s*===\s*["']source["']/u);
  assert.match(predicate, /ref\.reasonCode\s*!==\s*["']SESSION_PATH_ESCAPE["']/u);
  assert.doesNotMatch(predicate, /\b(?:fs|fsp)\s*\.|\b(?:readFile|readFileSync|stat|statSync|lstat|lstatSync|realpath|realpathSync|open|openSync|fetch)\s*\(/u,
    "Zero additional predicate target I/O is a source contract, not zero whole-query I/O");
  assert.doesNotMatch(predicate, /ref\.(?:status|currentness|currentDigest)|matching-current-bytes|SESSION_WORK_REFERENCE_CHANGED|\bEACCES\b|\bEPERM\b/u,
    "Source association must not become a reference-status allowlist");
  const text = source.slice(source.indexOf("function searchText("), source.indexOf("function rankedMatches("));
  assert.doesNotMatch(text, /referenceEvidence|matchesExplicitPaths/u);
  const ranking = source.slice(source.indexOf("function rankedMatches("), source.indexOf("function viewTraversal("));
  assert.match(ranking, /nodePaths\(entry\.node\)\.some/u, "Existing exact-path score still uses original node paths");
});

test("Lode exact path expansion retains its actual Project and Session from another cwd", { concurrency: false }, async t => {
  const f = fixture(t), other = fixture(t), source = target(f), otherSource = target(other);
  const saved = saveReason(f, [source.reference]), otherSaved = saveReason(other, [otherSource.reference]);
  assert.notEqual(f.projectId, other.projectId);
  assert.notEqual(saved.evidence.evidenceId, otherSaved.evidence.evidenceId);
  const found = original(await readOnly(f, request(f)), f, saved);
  const expansion = found.originalExpansion;
  assert.equal(expansion.tool, "lode_session_work_read");
  assert.equal(expansion.arguments.project_root, fs.realpathSync(f.root));
  assert.equal(expansion.arguments.session_id, f.session.sessionId);
  assert.deepEqual(expansion.arguments.evidence_ids, [saved.evidence.evidenceId]);
  const before = snapshot(f.base), otherBefore = snapshot(other.base), previousCwd = process.cwd();
  try {
    process.chdir(other.root);
    await withoutWrites(async () => {
      const detail = original(await queryProjectGraph({ root: expansion.arguments.project_root, ...found.detail }), f, saved);
      assert.deepEqual(detail.workContent, found.workContent);
      const response = await dispatch({ jsonrpc: "2.0", id: "lode-other-cwd-expansion", method: "tools/call", params: {
        name: expansion.tool, arguments: expansion.arguments,
      } }, { resolveSessionContext() { throw new Error("Exact owner expansion must not require native binding"); } });
      assert.equal(response.error, undefined, JSON.stringify(response));
      assert.notEqual(response.result?.isError, true, JSON.stringify(response));
      const records = response.result.structuredContent.records;
      assert.equal(records.length, 1);
      assert.equal(records[0].projectId, f.projectId);
      assert.equal(records[0].sessionId, f.session.sessionId);
      assert.equal(records[0].evidenceId, saved.evidence.evidenceId);
      assert.equal(records[0].evidenceDigest, saved.evidence.evidenceDigest);
      assert.deepEqual(records[0].content, saved.evidence.content);
    });
  } finally { process.chdir(previousCwd); }
  assert.deepEqual(snapshot(f.base), before);
  assert.deepEqual(snapshot(other.base), otherBefore);
});

test("Lode path compatibility preserves literal legacy absolute owner bytes instead of using cwd", { concurrency: false }, async t => {
  const f = fixture(t), previousCwd = process.cwd();
  // A manually authored legacy-schema object, not a rebranded fresh Project and
  // not evidence that a beta43 producer or an installed Host was executed.
  const project = { schemaVersion: 1, projectId: `head-${sha(f.root).slice(0, 20)}`, projectRoot: f.root };
  const state = { schemaVersion: 1, projectId: project.projectId, sessionId: f.session.sessionId };
  const projectBytes = Buffer.from(JSON.stringify(project)), stateBytes = Buffer.from(JSON.stringify(state));
  const beforeProject = Buffer.from(projectBytes), beforeState = Buffer.from(stateBytes), before = snapshot(f.base);
  try {
    process.chdir(f.base);
    await withoutWrites(() => {
      const owner = verifySessionWorkEvidenceOwner({ root: f.root, projectBytes, stateBytes });
      assert.equal(owner.root, f.root); assert.equal(owner.projectId, project.projectId);
      assert.equal(owner.sessionId, state.sessionId);
      assert.throws(() => verifySessionWorkEvidenceOwner({ root: f.base, projectBytes, stateBytes }), { code: "HEAD_SESSION_IDENTITY_MISMATCH" });
    });
  } finally { process.chdir(previousCwd); }
  assert.deepEqual(projectBytes, beforeProject); assert.deepEqual(stateBytes, beforeState);
  assert.deepEqual(snapshot(f.base), before);
});

test("Lode source writer normalizes Windows separators on exact original retry under an existing writer lock", t => {
  const f = fixture(t), source = target(f), saved = saveReason(f, [source.reference]);
  withProjectMutation({ root: f.root, scope: "session-recovery" }, () => {
    const before = snapshot(f.base);
    const repeated = withoutWrites(() => saveReason(f, [{ ...source.reference, path: source.reference.path.replaceAll("/", "\\") }]));
    assert.equal(repeated.evidence.evidenceId, saved.evidence.evidenceId);
    assert.equal(repeated.evidence.evidenceDigest, saved.evidence.evidenceDigest);
    assert.deepEqual(repeated.evidence.content.references, [source.reference]);
    assert.deepEqual(snapshot(f.base), before);
  });
  t.diagnostic("This is exact original-record retry under an existing writer lock; public lock acquisition/release retains its P5 filesystem effects");
  t.diagnostic("Lexical separator/drive coverage is not a claim about another platform or a physical junction race");
});

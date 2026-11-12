import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, pluginRoot, snapshot, sha, link } from "./helpers/session-work-linkage-fixture.mjs";
import { createSourceObservation, retainSourceObservation, sourceBundleKey, retainSourceFailure, readSourceObservationOriginal } from "../scripts/lib/world/source-observation.mjs";
import { beginSnapshotCollection, finishSnapshotCollection } from "../scripts/lib/world/snapshot-reference-lifetime.mjs";
import { preparePythonObservation, preparePythonDeclarations } from "../scripts/lib/world/python-source-collector.mjs";
import { prepareSourceContext } from "../scripts/lib/world/source-context-workflow.mjs";
import { exportProjectBundle, inspectProjectBundle, importProjectBundle } from "../scripts/lib/storage/project-portability.mjs";
import { verifyPortableSourceEligibility, parsePortableSourceJson } from "../scripts/lib/storage/portable-source-originals.mjs";
import { validatePortableManifestFormat } from "../scripts/lib/storage/portable-project-format.mjs";
import { createContextSourceReader } from "../scripts/lib/session/context-source-reader.mjs";
import { resolveProjectStorage } from "../scripts/lib/storage/project-storage-format.mjs";
import { inspectProject } from "../scripts/lib/session/lode-core.mjs";
import { createRecoveryCheckpoint } from "../scripts/lib/session/compaction-recovery.mjs";
import { updateProjectDirection, readProjectDirection } from "../scripts/lib/session/project-direction.mjs";
import { withSessionRoute } from "../scripts/lib/session/session-routing.mjs";
import { buildGraphExplorerSnapshot } from "../scripts/lib/world/graph-explorer.mjs";
import { runCommand } from "../scripts/lode.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";

const relative = "src/action.mjs", oldText = "export function f(){ return 'allow'; }\r\n// 한글😀\r\n", newText = oldText.replace("allow", "block");
const write = (root, relative, bytes) => { fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); fs.writeFileSync(path.join(root, relative), bytes); };
function observe(f, text = oldText, mutate = null) {
  write(f.root, relative, text);
  const evidence = { version: 1, projectId: f.storage.projectId, kind: "source", query: [{ path: relative, symbol: "" }],
    sources: [{ path: relative, digest: sha(text), base64: Buffer.from(text).toString("base64") }], profile: {},
    observedAt: "2026-01-01T00:00:00Z", response: null, envelopeHash: null };
  mutate?.(evidence);
  const bundle = createSourceObservation(evidence, f.storage);
  const key = retainSourceObservation(f.root, bundle, f.storage);
  return { key, bundle, raw: fs.readFileSync(path.join(f.root, ".lode/observations/source-bundles", key + ".json")) };
}
function journey(f) {
  const a = observe(f), first = f.save({ summary: "Inspect exact action", judgments: [{ assessment: "Change f", reason: "Keep unrelated behavior", alternatives: ["Full rewrite rejected"] }], references: [{ kind: "source", path: relative, digest: sha(oldText) }] });
  const b = observe(f, newText), second = f.save({ summary: "Observed source change; external delivery unknown", workLink: link(first), references: [{ kind: "source", path: relative, digest: sha(newText) }] });
  return { a, b, first, second };
}
const exportTo = (f, name, extra = {}) => f.route(() => exportProjectBundle({ root: f.root, destination: path.join(f.base, name), ...extra }));
function reseal(root, mutate) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json")));
  mutate(manifest);
  const raw = Buffer.from(JSON.stringify(manifest, null, 2) + "\n"), digest = sha(raw);
  fs.writeFileSync(path.join(root, "manifest.json"), raw);
  fs.writeFileSync(path.join(root, "export-intent.json"), JSON.stringify({ schemaVersion: 1, kind: "ProjectBundleExportIntent", bundleId: "project-bundle-" + digest.slice(0, 24), manifestSha256: digest }));
  return manifest;
}
function pairOf(value) { return value.contextLineage.files.find(file => file.path === relative)?.comparisons.find(pair => pair.before?.digest === sha(oldText) && pair.after?.digest === sha(newText)); }
async function consumers(root, f, j) {
  const before = snapshot(root);
  const query = await runCommand(["graph-query", root, "--paths", relative, "--details"]);
  assert.equal(pairOf(query)?.diff.changed, true, JSON.stringify(query.contextLineage));
  assert(query.contextLineage.recordedReasons.some(row => row.reason === "Keep unrelated behavior"));
  const mcp = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lode_project_graph", arguments: { project_root: root, paths: [relative], details: true, depth: 3 } } });
  assert(!mcp.error && !mcp.result.isError, JSON.stringify(mcp));
  assert.equal(pairOf(mcp.result.structuredContent)?.diff.changed, true);
  const explorer = await buildGraphExplorerSnapshot({ root, paths: [relative], anchorIds: [j.first.evidence.evidenceId, j.second.evidence.evidenceId] });
  assert.equal(pairOf(explorer.graph)?.diff.changed, true);
  assert(explorer.graph.edges.some(edge => edge.type === "FOLLOWS_WORK_EVIDENCE" && edge.from === j.second.evidence.evidenceId));
  assert.deepEqual(snapshot(root), before);
}

for (const mode of ["fresh", "existing"]) test(`retained source connected journey: ${mode} import, resume, entry, re-export, next target, CLI/MCP/Explorer`, async t => {
  const f = fixture(t), j = journey(f);
  updateProjectDirection({ root: f.root, input: { goal: "Retain source rationale", cancelledActions: ["Do not deploy"] } });
  f.route(() => createRecoveryCheckpoint({ root: f.root, purpose: "Continue exact source inspection", currentPosition: "Synthetic edit observed", nextExpectedResult: "Verify diff", approvedDecisions: [] }));
  const sourceBefore = snapshot(f.root), notices = [];
  const exported = exportTo(f, "bundle", { onExportScope(scope) { notices.push(scope); assert(!fs.existsSync(path.join(f.base, "bundle"))); } });
  assert.equal(notices[0].sourceMode, "selected-retained-sources");
  const inspected = inspectProjectBundle({ bundleRoot: exported.bundleRoot });
  assert.equal(inspected.manifest.schemaVersion, 2);
  assert(inspected.manifest.sourceTransfer.references.every(ref => ref.status === "included-verified-retained-original"));
  for (const original of [j.a, j.b]) assert.deepEqual(fs.readFileSync(path.join(exported.bundleRoot, "objects", sha(original.raw) + ".bin")), original.raw);
  const root = path.join(f.base, "target");
  if (mode === "existing") {
    fs.cpSync(f.root, root, { recursive: true });
    fs.rmSync(path.join(root, ".lode/sessions/by-id", f.session.sessionId), { recursive: true });
    fs.rmSync(path.join(root, ".lode/observations/source-bundles"), { recursive: true });
    await runCommand(["resume", root]);
  } else fs.mkdirSync(root);
  if (mode === "fresh") write(root, "AGENTS.md", "Current target instructions\n");
  const targetAgents = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
  const imported = await dispatch({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lode_project_bundle_import", arguments: { target_root: root, bundle_root: exported.bundleRoot, expected_bundle_id: exported.bundleId } } });
  assert(!imported.error && !imported.result.isError, JSON.stringify(imported));
  fs.rmSync(path.join(root, "src"), { recursive: true, force: true });
  const resumed = await runCommand(["resume", root, "--session", f.session.sessionId]);
  assert.equal(resumed.project.sessionId, f.session.sessionId);
  const entry = await runCommand(["conversation-enter", root, "--session", f.session.sessionId]);
  assert(!entry.isError);
  assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), targetAgents);
  await consumers(root, f, j);
  const direction = readProjectDirection({ root });
  updateProjectDirection({ root, expectedDirectionId: direction.directionId, input: { goal: "Destination continuation", cancelledActions: ["Still no deployment"] } });
  const reexported = await runCommand(["project-export", root, "--session", f.session.sessionId, "--destination", path.join(f.base, "again")]);
  const next = path.join(f.base, "next"); fs.mkdirSync(next);
  importProjectBundle({ root: next, bundleRoot: reexported.bundleRoot, pluginRoot });
  await consumers(next, f, j);
  assert.deepEqual(readProjectDirection({ root: next }).input.cancelledActions, ["Still no deployment"]);
  assert.deepEqual(snapshot(f.root), sourceBefore);
});

test("verified transfer bindings bypass unrelated inventory and byte-budget pressure without global reindex", async t => {
  const f = fixture(t), j = journey(f), exported = exportTo(f, "bundle"), root = path.join(f.base, "target"); fs.mkdirSync(root);
  importProjectBundle({ root, bundleRoot: exported.bundleRoot, pluginRoot });
  const dir = path.join(root, ".lode/observations/source-bundles");
  for (let i = 0; i < 520; i++) fs.writeFileSync(path.join(dir, sha(String(i)) + ".json"), "not a selected original");
  const owner = withSessionRoute(root, f.session.sessionId, () => inspectProject(root)), reader = createContextSourceReader(root, owner.project.projectId, { storage: owner.storage, project: owner.project, sourceOwners: [f.session.sessionId] });
  const original = await reader.read(relative, sha(oldText));
  assert.equal(original.digest, sha(oldText));
  assert.equal(original.basis.transfer.status, "verified-imported-exact-original");
  assert.equal(reader.diagnostics().retainedSourceBundles.inspectedDirectoryEntries, 0);
  assert.equal(reader.diagnostics().localGitCommands, 0);
  await consumers(root, f, j);
  const again = withSessionRoute(root, f.session.sessionId, () => exportProjectBundle({ root, destination: path.join(f.base, "again") }));
  assert(inspectProjectBundle({ bundleRoot: again.bundleRoot }).manifest.sourceTransfer.references.every(ref => ref.status === "included-verified-retained-original"));
});

test("explicit CLI/MCP refs-only preserves ordinary recovery and discloses source gaps", async t => {
  const f = fixture(t); journey(f);
  const cli = await runCommand(["project-export", f.root, "--session", f.session.sessionId, "--destination", path.join(f.base, "cli"), "--sources", "refs-only"]);
  const mcp = await dispatch({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "lode_project_bundle_export", arguments: { project_root: f.root, session_id: f.session.sessionId, destination: path.join(f.base, "mcp"), source_mode: "refs-only" } } });
  assert.equal(cli.bundleId, mcp.result.structuredContent.bundleId);
  const bundle = inspectProjectBundle({ bundleRoot: cli.bundleRoot });
  assert(bundle.manifest.sourceTransfer.references.every(ref => ref.status === "not-requested-body-transfer"));
  assert(!bundle.manifest.files.some(entry => entry.path.includes("/source-bundles/")));
  const root = path.join(f.base, "target"); fs.mkdirSync(root);
  importProjectBundle({ root, bundleRoot: cli.bundleRoot, pluginRoot });
  assert.equal((await runCommand(["resume", root, "--session", f.session.sessionId])).readiness.core.state, "ready");
  assert(!pairOf(await runCommand(["graph-query", root, "--paths", relative, "--details"]))?.diff);
});

for (const where of ["wrapper", "evidence", "source", "query", "profile", "response"]) test(`export eligibility excludes ${where} extras without rewriting ordinary originals`, t => {
  const f = fixture(t);
  const obs = observe(f, oldText, e => {
    if (where === "evidence") e.extra = "UNSELECTED_BODY_SENTINEL";
    if (where === "source") e.sources[0].extra = "UNSELECTED_BODY_SENTINEL";
    if (where === "query") e.query[0].extra = "UNSELECTED_BODY_SENTINEL";
    if (where === "profile") e.profile.extra = "UNSELECTED_BODY_SENTINEL";
    if (where === "response") e.response = Buffer.from(JSON.stringify({ extra: "UNSELECTED_BODY_SENTINEL" })).toString("base64");
  });
  if (where === "wrapper") { obs.bundle.extra = "UNSELECTED_BODY_SENTINEL"; fs.writeFileSync(path.join(f.root, ".lode/observations/source-bundles", obs.key + ".json"), JSON.stringify(obs.bundle)); }
  f.save({ summary: "Selected source only", references: [{ kind: "source", path: relative, digest: sha(oldText) }] });
  const before = snapshot(f.root), result = exportTo(f, "bundle"), inspected = inspectProjectBundle({ bundleRoot: result.bundleRoot });
  assert.equal(inspected.manifest.sourceTransfer.references[0].status, "excluded-export-eligibility");
  assert.equal(inspected.manifest.sourceTransfer.references[0].proof, "not-certified");
  assert(!Object.keys(snapshot(result.bundleRoot)).some(file => fs.readFileSync(path.join(result.bundleRoot, file)).includes("UNSELECTED_BODY_SENTINEL")));
  assert.deepEqual(snapshot(f.root), before);
  const root = path.join(f.base, "target"); fs.mkdirSync(root);
  assert.equal(importProjectBundle({ root, bundleRoot: result.bundleRoot, pluginRoot }).status, "imported");
});

test("normal structured producer kinds retain exact response/profile originals and reject hidden response/profile fields", async t => {
  for (const kind of ["source", "outgoing-calls", "declarations", "selected-source"]) {
    const f = fixture(t);
    write(f.root, "module.py", "def target():\n    return 1\n\ndef caller():\n    target()\n");
    const result = await prepareSourceContext({ root: f.root, task: "Inspect bounded synthetic source", needs: [{ kind, path: "module.py", ...(kind === "outgoing-calls" || kind === "selected-source" ? { symbol: "caller" } : {}) }], retain: true,
      onProcess(event) { process.stderr.write(JSON.stringify({ sourceProcess: event }) + "\n"); } });
    assert.equal(result.status, "observed", JSON.stringify(result.results));
    const key = result.results[0].bundleKey, original = JSON.parse(fs.readFileSync(path.join(f.root, ".lode/observations/source-bundles", key + ".json")));
    assert.equal(verifyPortableSourceEligibility(f.root, f.storage.projectId, original, { storage: f.storage, key }).evidenceKind, kind);
    f.save({ summary: "Exact producer source citation", references: [{ kind: "source", path: "module.py", digest: original.evidence.sources[0].digest }] });
    const exported = exportTo(f, "producer-bundle");
    const manifest = inspectProjectBundle({ bundleRoot: exported.bundleRoot }).manifest;
    assert.equal(manifest.sourceTransfer.references[0].evidenceKind, kind);
    const target = path.join(f.base, "producer-target"); fs.mkdirSync(target);
    importProjectBundle({ root: target, bundleRoot: exported.bundleRoot, pluginRoot });
    const owner = withSessionRoute(target, f.session.sessionId, () => inspectProject(target));
    const reader = createContextSourceReader(target, owner.project.projectId, { storage: owner.storage, project: owner.project, sourceOwners: [f.session.sessionId] });
    const read = await reader.read("module.py", original.evidence.sources[0].digest);
    assert.equal(read.text, Buffer.from(original.evidence.sources[0].base64, "base64").toString("utf8"));
    assert.equal(read.basis.bundleKey, key);
    if (kind !== "source") {
      for (const extra of ["response", "profile", "response-duplicate"]) {
        const e = structuredClone(original.evidence);
        if (extra === "profile") e.profile.extra = "UNSELECTED_BODY_SENTINEL";
        else if (extra === "response-duplicate") {
          const raw = Buffer.from(e.response, "base64").toString("utf8");
          e.response = Buffer.from('{"profile":{"privateBody":"REVIEW_SHADOW_CONTENT"},' + raw.trimStart().slice(1)).toString("base64");
        }
        else { const response = JSON.parse(Buffer.from(e.response, "base64")); response.extra = "UNSELECTED_BODY_SENTINEL"; e.response = Buffer.from(JSON.stringify(response)).toString("base64"); }
        const raw = Buffer.from(e.response, "base64"), response = { raw, result: JSON.parse(raw) };
        e.envelopeHash = e.version === 2 ? preparePythonDeclarations({ query: e.query, sources: e.sources, response, profile: e.profile }).evidenceHash
          : preparePythonObservation({ projectId: e.projectId, query: e.query, sources: e.sources, response, profile: e.profile }).envelope.envelopeHash;
        const changed = createSourceObservation(e, f.storage);
        assert.throws(() => verifyPortableSourceEligibility(f.root, f.storage.projectId, changed, { storage: f.storage }), { code: extra === "response-duplicate" ? "SOURCE_EXPORT_DUPLICATE_JSON_KEY" : "SOURCE_EXPORT_UNVERIFIED_FIELDS" });
      }
    }
  }
});

test("raw JSON key scan decodes escaped equivalence at every depth without interpreting string values", () => {
  const key = String.raw`"\u0061"`;
  for (const text of ['{"a":1,"a":2}', '{"a":1,' + key + ':2}', '{"x":[{"y":{"a":1,' + key + ':2}}]}', String.raw`{"a":1,"\u0061":2}`, String.raw`{"😀":1,"\ud83d\ude00":2}`, String.raw`{"/":1,"\/":2}`])
    assert.throws(() => parsePortableSourceJson(Buffer.from(text)), { code: "SOURCE_EXPORT_DUPLICATE_JSON_KEY" });
  for (const text of ['{"a":1,"nested":{"a":2}}', JSON.stringify({ source: '{"a":1,"a":2}', escaped: '\\"{,}', unicode: "한글😀" }), String.raw`{"a":1,"\\u0061":2}`])
    assert.deepEqual(parsePortableSourceJson(Buffer.from(text)), JSON.parse(text));
  const deep = "[".repeat(20_000) + '{"a":1}' + "]".repeat(20_000);
  assert.doesNotThrow(() => parsePortableSourceJson(Buffer.from(deep)));
});

for (const mode of ["top", "top-escaped", "profile-escaped", "nested-source", "nested-source-escaped", "nested-array-query", "nested-profile"]) test(`raw ${mode} duplicate excludes shadowed bytes and preserves ordinary read compatibility`, t => {
  const f = fixture(t), original = observe(f, oldText, e => {
    if (mode === "nested-profile") e.profile = { reader: "exact-utf8-source-1", implementation: { worker: sha("w"), normalizer: sha("n"), envelope: sha("e"), observation: sha("o") } };
  });
  const file = path.join(f.root, ".lode/observations/source-bundles", original.key + ".json");
  let raw = fs.readFileSync(file, "utf8");
  if (mode === "top" || mode === "top-escaped") {
    if (mode === "top-escaped") raw = raw.replace('"evidence":', String.raw`"\u0065vidence":`);
    raw = '{"evidence":{"privateBody":"REVIEW_SHADOW_CONTENT"},' + raw.slice(1);
  } else if (mode === "profile-escaped") raw = raw.replace('"profile":', String.raw`"profile":{"privateBody":"REVIEW_SHADOW_CONTENT"},"prof\u0069le":`);
  else if (mode.startsWith("nested-source")) raw = raw.replace('"base64":', (mode === "nested-source-escaped" ? String.raw`"b\u0061se64"` : '"base64"') + ':"REVIEW_SHADOW_CONTENT","base64":');
  else if (mode === "nested-array-query") raw = raw.replace('"path":', '"path":"REVIEW_SHADOW_CONTENT","path":');
  else raw = raw.replace('"worker":', '"worker":"REVIEW_SHADOW_CONTENT","worker":');
  fs.writeFileSync(file, raw);
  f.save({ summary: "Only selected exact source body", references: [{ kind: "source", path: relative, digest: sha(oldText) }] });
  assert.equal(readSourceObservationOriginal(f.root, f.storage.projectId, original.key, { storage: f.storage, requireCurrent: false }).bundle.evidence.sources[0].digest, sha(oldText));
  const before = snapshot(f.root), exported = exportTo(f, "bundle"), manifest = inspectProjectBundle({ bundleRoot: exported.bundleRoot }).manifest;
  assert.equal(manifest.sourceTransfer.references[0].status, "excluded-export-eligibility");
  assert.equal(manifest.sourceTransfer.references[0].reasonCode, "SOURCE_EXPORT_DUPLICATE_JSON_KEY");
  for (const name of fs.readdirSync(path.join(exported.bundleRoot, "objects"))) assert(!fs.readFileSync(path.join(exported.bundleRoot, "objects", name)).includes("REVIEW_SHADOW_CONTENT"));
  assert.deepEqual(snapshot(f.root), before);
});

test("strict inspect rejects a resealed included duplicate-key raw source before import writes", t => {
  const f = fixture(t), original = observe(f);
  f.save({ summary: "Exact source", references: [{ kind: "source", path: relative, digest: sha(oldText) }] });
  const exported = exportTo(f, "bundle");
  const duplicate = Buffer.from('{"evidence":{"private":"REVIEW_SHADOW_CONTENT"},' + original.raw.toString("utf8").slice(1));
  const digest = sha(duplicate);
  fs.writeFileSync(path.join(exported.bundleRoot, "objects", digest + ".bin"), duplicate);
  reseal(exported.bundleRoot, manifest => {
    const ref = manifest.sourceTransfer.references[0]; ref.rawSha256 = digest; ref.rawBundleBytes = duplicate.length;
    const entry = manifest.files.find(entry => entry.path.endsWith("/source-bundles/" + original.key + ".json")); entry.sha256 = digest; entry.bytes = duplicate.length;
    manifest.coverage.retainedSourceOriginals = manifest.sourceTransfer;
  });
  assert.throws(() => inspectProjectBundle({ bundleRoot: exported.bundleRoot }), { code: "SOURCE_EXPORT_DUPLICATE_JSON_KEY" });
  const root = path.join(f.base, "target"); fs.mkdirSync(root); const before = snapshot(root);
  assert.throws(() => importProjectBundle({ root, bundleRoot: exported.bundleRoot, pluginRoot }), { code: "SOURCE_EXPORT_DUPLICATE_JSON_KEY" });
  assert.deepEqual(snapshot(root), before);
});

test("normal raw JSON BOM, whitespace, CRLF and Unicode formatting are retained exactly", t => {
  const f = fixture(t), original = observe(f), file = path.join(f.root, ".lode/observations/source-bundles", original.key + ".json");
  const padded = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(" \r\n" + JSON.stringify(original.bundle, null, 2).replaceAll("\n", "\r\n") + "\r\n ")]);
  fs.writeFileSync(file, padded);
  f.save({ summary: "Preserve formatted raw original", references: [{ kind: "source", path: relative, digest: sha(oldText) }] });
  const before = snapshot(f.root), exported = exportTo(f, "bundle"), inspected = inspectProjectBundle({ bundleRoot: exported.bundleRoot });
  assert.equal(inspected.manifest.sourceTransfer.references[0].rawSha256, sha(padded));
  assert.deepEqual(fs.readFileSync(path.join(exported.bundleRoot, "objects", sha(padded) + ".bin")), padded);
  const root = path.join(f.base, "target"); fs.mkdirSync(root); importProjectBundle({ root, bundleRoot: exported.bundleRoot, pluginRoot });
  assert.deepEqual(fs.readFileSync(path.join(root, ".lode/observations/source-bundles", original.key + ".json")), padded);
  assert.deepEqual(snapshot(f.root), before);
});

for (const tamper of ["capability", "schema", "source-digest", "work-owner", "raw-hash", "unbound-object"]) test(`resealed transport cannot bypass ${tamper} validation`, t => {
  const f = fixture(t); journey(f); const exported = exportTo(f, "bundle");
  reseal(exported.bundleRoot, manifest => {
    if (tamper === "capability") manifest.requiredCapabilities = ["unknown-source-privilege"];
    if (tamper === "schema") manifest.schemaVersion = 99;
    if (tamper === "source-digest") manifest.sourceTransfer.references[0].digest = sha("foreign revision");
    if (tamper === "work-owner") manifest.sourceTransfer.references[0].workEvidence[0].evidenceDigest = sha("other work");
    if (tamper === "raw-hash") manifest.sourceTransfer.references[0].rawSha256 = sha("other raw");
    if (tamper === "unbound-object") {
      const raw = Buffer.from("{}"), digest = sha(raw); fs.writeFileSync(path.join(exported.bundleRoot, "objects", digest + ".bin"), raw);
      manifest.files.push({ path: ".lode/observations/source-bundles/" + digest + ".json", bytes: raw.length, sha256: digest });
    }
  });
  const root = path.join(f.base, "target"); fs.mkdirSync(root); const before = snapshot(root);
  assert.throws(() => importProjectBundle({ root, bundleRoot: exported.bundleRoot, pluginRoot }));
  assert.deepEqual(snapshot(root), before);
});

test("fixed included manifest conflicts rather than dropping a different raw wrapper; exact interrupted retry converges", async t => {
  const f = fixture(t), j = journey(f), bundle = exportTo(f, "bundle"), root = path.join(f.base, "target"); fs.mkdirSync(root);
  assert.throws(() => importProjectBundle({ root, bundleRoot: bundle.bundleRoot, pluginRoot, onPublication(kind, name) { if (name.includes("/source-bundles/")) throw Error("interrupt after immutable source"); } }), /interrupt/);
  const interrupted = snapshot(root);
  assert(Object.keys(interrupted).some(file => file.includes("source-bundles")));
  assert.equal(importProjectBundle({ root, bundleRoot: bundle.bundleRoot, pluginRoot }).status, "imported");
  const conflicting = path.join(root, ".lode/observations/source-bundles", j.a.key + ".json");
  fs.writeFileSync(conflicting, JSON.stringify(j.a.bundle, null, 2));
  const before = snapshot(root);
  assert.throws(() => importProjectBundle({ root, bundleRoot: bundle.bundleRoot, pluginRoot }), { code: "PROJECT_COPY_SOURCE_CHANGED" });
  assert.deepEqual(snapshot(root), before);
  const query = await runCommand(["graph-query", root, "--paths", relative, "--details"]);
  assert(!pairOf(query)?.diff);
  const reexported = withSessionRoute(root, f.session.sessionId, () => exportProjectBundle({ root, destination: path.join(f.base, "conflicted-reexport") }));
  const ref = inspectProjectBundle({ bundleRoot: reexported.bundleRoot }).manifest.sourceTransfer.references.find(ref => ref.digest === sha(oldText));
  assert.equal(ref.status, "excluded-export-eligibility");
  assert.equal(ref.reasonCode, "SOURCE_EXPORT_IDENTITY_MISMATCH");
});

test("v1 metadata-only bundles stay readable, new source schemas cannot be downgraded, partial sources stay nonblocking", async t => {
  const f = fixture(t); write(f.root, "missing.py", "not retained"); f.save({ summary: "Missing source body", references: [{ kind: "source", path: "missing.py", digest: sha("not retained") }] });
  const bundle = exportTo(f, "bundle");
  const original = inspectProjectBundle({ bundleRoot: bundle.bundleRoot });
  assert.equal(original.manifest.sourceTransfer.references[0].status, "retained-original-unavailable");
  const legacy = reseal(bundle.bundleRoot, manifest => { manifest.schemaVersion = 1; delete manifest.requiredCapabilities; delete manifest.sourceTransfer; delete manifest.coverage.retainedSourceOriginals; delete manifest.coverage.exactDiffPortability; });
  validatePortableManifestFormat(legacy);
  const inspected = inspectProjectBundle({ bundleRoot: bundle.bundleRoot });
  assert.equal(inspected.coverage.retainedSourceOriginals.status, "not-recorded-not-certified");
  const root = path.join(f.base, "target"); fs.mkdirSync(root);
  importProjectBundle({ root, bundleRoot: bundle.bundleRoot, pluginRoot });
  assert.equal((await runCommand(["resume", root, "--session", f.session.sessionId])).readiness.core.state, "ready");
});

for (const mode of ["multi-source", "multi-query", "invalid-utf8", "failure-only", "oversized-raw", "permission-denied", "hardlink"]) test(`unavailable ${mode} original retains precise partial coverage without an alternate collection`, async t => {
  const f = fixture(t), original = observe(f);
  const saved = f.save({ summary: "Only the exact selected source is requested", references: [{ kind: "source", path: relative, digest: sha(oldText) }] });
  const file = path.join(f.root, ".lode/observations/source-bundles", original.key + ".json");
  if (mode === "multi-source" || mode === "multi-query" || mode === "invalid-utf8") {
    const bad = structuredClone(original.bundle);
    if (mode === "multi-source") bad.evidence.sources.push({ ...bad.evidence.sources[0], path: "private.py", base64: Buffer.from("UNSELECTED_PRIVATE").toString("base64") });
    if (mode === "multi-query") bad.evidence.query.push({ path: "private.py", symbol: "" });
    if (mode === "invalid-utf8") { const bytes = Buffer.from([0xff]); bad.evidence.sources[0].base64 = bytes.toString("base64"); bad.evidence.sources[0].digest = sha(bytes); }
    fs.writeFileSync(file, JSON.stringify(bad));
  }
  if (mode === "failure-only") {
    fs.unlinkSync(file);
    retainSourceFailure(f.root, { projectId: f.storage.projectId, query: original.bundle.evidence.query, sources: original.bundle.evidence.sources,
      profile: {}, response: null, status: "unavailable", code: "SOURCE_LANGUAGE_UNSUPPORTED" }, f.storage);
  }
  if (mode === "oversized-raw") fs.appendFileSync(file, " ".repeat(16 * 1024 * 1024));
  if (mode === "hardlink") fs.linkSync(file, path.join(f.base, "other-hardlink.json"));
  const sourceBefore = snapshot(f.root), open = fs.openSync;
  if (mode === "permission-denied") fs.openSync = function (name, ...args) { if (String(name) === file) throw Object.assign(Error("synthetic denied"), { code: "EACCES" }); return open.call(this, name, ...args); };
  let exported;
  try { exported = exportTo(f, "bundle"); } finally { fs.openSync = open; }
  const inspected = inspectProjectBundle({ bundleRoot: exported.bundleRoot }), ref = inspected.manifest.sourceTransfer.references[0];
  assert.notEqual(ref.status, "included-verified-retained-original");
  assert.equal(ref.proof, "not-certified");
  assert.equal(inspected.manifest.sourceTransfer.gitLookup, "not-looked-up-not-included");
  if (mode === "permission-denied") assert.equal(ref.reasonCode, "EACCES");
  if (mode === "oversized-raw") assert.equal(ref.reasonCode, "RETAINED_SOURCE_BUNDLE_BYTE_BUDGET_REACHED");
  assert(!inspected.manifest.files.some(entry => entry.path.includes("source-bundles")));
  const target = path.join(f.base, "target"); fs.mkdirSync(target);
  importProjectBundle({ root: target, bundleRoot: exported.bundleRoot, pluginRoot });
  assert.equal((await runCommand(["resume", target, "--session", f.session.sessionId])).readiness.core.state, "ready");
  assert.deepEqual(snapshot(f.root), sourceBefore);
  assert.equal(saved.evidence.content.references[0].digest, sha(oldText));
});

test("BOM/CRLF/Unicode bytes remain exact through historical transfer", async t => {
  const f = fixture(t), text = "\ufeff" + oldText, obs = observe(f, text);
  f.save({ summary: "Exact BOM source", references: [{ kind: "source", path: relative, digest: sha(text) }] });
  const bundle = exportTo(f, "bundle"), root = path.join(f.base, "target"); fs.mkdirSync(root);
  importProjectBundle({ root, bundleRoot: bundle.bundleRoot, pluginRoot });
  const owner = withSessionRoute(root, f.session.sessionId, () => inspectProject(root));
  const reader = createContextSourceReader(root, owner.project.projectId, { storage: owner.storage, project: owner.project, sourceOwners: [f.session.sessionId] });
  const source = await reader.read(relative, sha(text));
  assert.equal(source.text, text); assert.equal(source.digest, sha(text));
  assert.equal(source.basis.bundleKey, obs.key);
});

test("duplicate identical citations do not add a new export gate or duplicate evidence identity", t => {
  const f = fixture(t); observe(f);
  const ref = { kind: "source", path: relative, digest: sha(oldText) };
  f.save({ summary: "Repeated exact reference", references: [ref, ref] });
  const exported = exportTo(f, "bundle"), manifest = inspectProjectBundle({ bundleRoot: exported.bundleRoot }).manifest;
  assert.equal(manifest.sourceTransfer.references.length, 1);
  assert.equal(manifest.sourceTransfer.references[0].workEvidence.length, 1);
  assert.equal(manifest.sourceTransfer.references[0].status, "included-verified-retained-original");
});

test("export/import lifetime protects originals and releases owned participants on success and failure", { skip: process.platform === "darwin" ? "Physical GC collection lease unsupported on macOS; portable original transfer and read-only checks remain covered." : false }, async t => {
  const f = fixture(t); journey(f);
  const attempt = beginSnapshotCollection({ root: f.root }); assert.equal(attempt.status, "active");
  const controller = new AbortController();
  assert.throws(() => exportTo(f, "interrupted", { signal: controller.signal, onObject() { assert.equal(beginSnapshotCollection({ root: f.root }).status, "yielded"); controller.abort(); } }), { code: "PROJECT_PORTABILITY_CANCELLED" });
  finishSnapshotCollection(attempt);
  const exported = exportTo(f, "bundle", { onObject() { assert.equal(beginSnapshotCollection({ root: f.root }).status, "yielded"); } });
  assert.deepEqual(fs.readdirSync(path.join(f.root, ".lode/.snapshot-gc/participants")), []);
  for (const mode of ["fresh", "existing"]) {
    const root = path.join(f.base, mode);
    if (mode === "fresh") fs.mkdirSync(root);
    else { fs.cpSync(f.root, root, { recursive: true }); fs.rmSync(path.join(root, ".lode/sessions/by-id", f.session.sessionId), { recursive: true }); await runCommand(["resume", root]); }
    let checked = false;
    importProjectBundle({ root, bundleRoot: exported.bundleRoot, pluginRoot, onPublication(kind) {
      if (mode === "existing" || kind === "project") {
        if (mode === "fresh") assert.throws(() => beginSnapshotCollection({ root }), { code: "PROJECT_RELOCATION_PENDING" });
        else assert.equal(beginSnapshotCollection({ root }).status, "yielded");
        checked = true;
      }
    } });
    assert(checked); assert.deepEqual(fs.readdirSync(path.join(root, ".lode/.snapshot-gc/participants")), []);
  }
});

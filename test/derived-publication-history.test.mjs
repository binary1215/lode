import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { archiveCodexCapturedPhysicalSource } from "../scripts/lib/codex-captured-physical-source.mjs";
import { prepareProjectNativeHistory } from "../scripts/lib/project-native-derivation.mjs";
import { classifyDerivedPublicationHistory } from "../scripts/lib/derived-publication-history.mjs";
import { derivedJson as json, derivedHash as hash } from "../scripts/lib/claude-derived-encoder.mjs";
import { claudeNativeProjectName } from "../scripts/lib/claude-native-history.mjs";
import { syntheticNativeDatabase, nativeProfile } from "./helpers/native-portability-fixture.mjs";
import { readCodexProjectCatalog } from "../scripts/lib/codex-project-catalog.mjs";
import { exportPortableProjectEvidence, inspectPortableProjectEvidence } from "../scripts/lib/portable-project-evidence.mjs";
import { operatePortableProjectNative } from "../scripts/lib/portable-project-native.mjs";
import { nativeRoot } from "../scripts/lib/provider-native-history-host.mjs";

const id = "01900000-0000-7000-8000-000000009831", other = "01900000-0000-7000-8000-000000009832";
const evidence = raw => ({ raw, bytes: raw.length, sha256: hash(raw) });
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lode-history-proof-")), owner = fs.lstatSync(base), real = fs.realpathSync(base);
  t.after(() => { const now = fs.lstatSync(base); assert.ok(now.isDirectory() && !now.isSymbolicLink() && now.dev === owner.dev && now.ino === owner.ino);
    assert.equal(fs.realpathSync(base), real); fs.rmSync(base, { recursive: true }); });
  const source = path.join(base, "source"), project = path.join(base, "project"); fs.mkdirSync(source); fs.mkdirSync(project);
  const frames = [
    { type: "session_meta", payload: { id, session_id: id, cli_version: nativeProfile.engineVersion, history_mode: "paginated" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "synthetic" } },
    { type: "event_msg", payload: { type: "item_completed", thread_id: id, turn_id: "synthetic", item: { type: "UserMessage", id: "u", content: [{ type: "text", text: "Synthetic preserved input" }] } } },
    { type: "event_msg", payload: { type: "item_completed", thread_id: id, turn_id: "synthetic", item: { type: "AgentMessage", id: "a", phase: "final_answer", content: [{ type: "Text", text: "Synthetic preserved answer" }] } } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "synthetic" } },
  ];
  const raw = Buffer.concat(frames.map((frame, ordinal) => Buffer.from(JSON.stringify({ ordinal, ...frame }) + "\n")));
  const captured = archiveCodexCapturedPhysicalSource({ directory: source, threadId: id, rolloutId: id, originals: [{ threadId: id, rolloutId: id, raw, sha256: hash(raw) }] });
  return { base, source, project, captured };
}
function recordFor(artifact, { receipt = false } = {}) {
  const manifest = evidence(fs.readFileSync(path.join(artifact.directory, "manifest.json"))), intent = evidence(fs.readFileSync(path.join(artifact.directory, "intent.json")));
  const op = { derivationDigest: manifest.sha256, targetNativeId: artifact.manifest.target.nativeId,
    home: { path: "C:/synthetic/native-home", dev: "1", ino: "2" }, project: artifact.manifest.input.targetRoot,
    relative: "projects/" + claudeNativeProjectName(artifact.manifest.target.cwd) + "/" + artifact.manifest.target.nativeId + ".jsonl",
    client: { version: "2.1.317", executableDigest: "a".repeat(64), hostEvidence: "synthetic-only" } };
  const document = { schemaVersion: 1, kind: receipt ? "ClaudeDerivedPublicationReceipt" : "ClaudeDerivedPublicationAttempt", authorityPlane: "P5", operation: op,
    ...(receipt ? { targetObservation: { state: "matches" }, filesWritten: 1, sourceOriginalsPreserved: true, sharedMetadataWritten: false } : { automaticReplayAllowed: false }),
    grantsRecoveryAuthority: false, restoresExecutionPermission: false };
  const relativePath = "native/derived/claude/" + artifact.manifest.derivationId + "/effects/"
    + hash(json({ derivationDigest: manifest.sha256, homePath: op.home.path, relative: op.relative })).slice(0, 24)
    + "/" + (receipt ? "publication-receipt.json" : "publication-attempt.json");
  return { document, record: evidence(json(document)), manifest, intent, relativePath,
    sourceDigest: artifact.manifest.source.nativePayloadDigest, threadId: id };
}
const classify = value => classifyDerivedPublicationHistory(value);

test("historical target classification binds exact original metadata for each supported profile without granting replay", t => {
  const f = fixture(t);
  for (const converter of ["codex-claude-physical-v1", "codex-claude-physical-v2", "codex-claude-physical-v3", "codex-claude-physical-hybrid-v1", "codex-claude-physical-hybrid-v2", "codex-claude-physical-hybrid-v3", "codex-claude-physical-hybrid-v4"]) {
    const artifact = prepareProjectNativeHistory({ bundleRoot: f.source, root: f.project, threadIds: [id], converter });
    for (const receipt of [false, true]) {
      const data = recordFor(artifact, { receipt }), result = classify(data);
      assert.equal(result.nativeId, artifact.manifest.target.nativeId, converter + ": " + result.reason);
      assert.equal(result.interpretation, "qualified-historical-target-id-not-authority");
      assert.equal(Object.hasOwn(result, "automaticReplayAllowed"), false);
    }
  }
});

test("malformed or uncorrelated historical records stay opaque, while changed original bytes remain primary", t => {
  const f = fixture(t), artifact = prepareProjectNativeHistory({ bundleRoot: f.source, root: f.project, threadIds: [id] });
  const data = recordFor(artifact);
  for (const modify of [
    d => { d.schemaVersion = 999; }, d => { delete d.operation.derivationDigest; },
    d => { d.operation.derivationDigest = "b".repeat(64); }, d => { d.operation.targetNativeId = other; },
    d => { d.operation.relative = "projects/other/" + d.operation.targetNativeId + ".jsonl"; },
    d => { d.operation.project.ino = "999"; }, d => { d.operation.home.path += "-other"; },
    d => { d.grantsRecoveryAuthority = true; }, d => { d.unknown = "not an instruction"; },
  ]) {
    const d = structuredClone(data.document); modify(d);
    assert.equal(classify({ ...data, record: evidence(json(d)) }).nativeId, null);
  }
  assert.equal(classify({ ...data, manifest: null }).nativeId, null);
  assert.equal(classify({ ...data, intent: null }).nativeId, null);
  assert.equal(classify({ ...data, relativePath: data.relativePath + ".partial" }).nativeId, null);
  assert.equal(classify({ ...data, record: evidence(Buffer.from([255, 0])) }).nativeId, null);
  const unknown = JSON.parse(data.manifest.raw); unknown.input.converter = "unknown-future-profile";
  assert.equal(classify({ ...data, manifest: evidence(json(unknown)) }).nativeId, null);
  for (const field of ["record", "manifest", "intent"]) {
    const altered = { ...data[field], raw: Buffer.concat([data[field].raw, Buffer.from(" ")]) };
    assert.throws(() => classify({ ...data, [field]: altered }), { code: "DERIVED_HISTORY_ORIGINAL_DIGEST_MISMATCH" });
  }
});

test("portable publication consumes malformed and partial source history as uncertainty but permits proven different targets", async t => {
  for (const mode of ["schema", "target", "partial", "different", "same", "missing-proof", "legacy-skipped", "denied"]) await t.test(mode, async t => {
    const f = fixture(t), archive = path.join(f.base, "archive"), profile = path.join(f.base, "native"), appdata = path.join(f.base, "appdata");
    for (const root of [archive, profile, appdata]) fs.mkdirSync(root);
    const historicalProject = ["different", "missing-proof", "legacy-skipped", "denied"].includes(mode) ? path.join(f.base, "other-project") : f.project;
    if (historicalProject !== f.project) fs.mkdirSync(historicalProject);
    const artifact = prepareProjectNativeHistory({ bundleRoot: f.source, root: historicalProject, threadIds: [id], converter: "codex-claude-physical-hybrid-v4" });
    const data = recordFor(artifact);
    if (mode === "schema") { data.document.schemaVersion = 999; delete data.document.operation.derivationDigest; data.document.operation.targetNativeId = other; }
    if (mode === "target") data.document.operation.targetNativeId = other;
    const relative = data.relativePath + (["partial", "legacy-skipped"].includes(mode) ? ".partial" : "");
    fs.mkdirSync(path.dirname(path.join(f.source, relative)), { recursive: true }); fs.writeFileSync(path.join(f.source, relative), json(data.document));
    if (mode === "missing-proof") for (const name of ["manifest.json", "intent.json"]) fs.unlinkSync(path.join(artifact.directory, name));
    const database = syntheticNativeDatabase(t, "state_5.sqlite", path.join(f.base, "catalog.sqlite")); let catalog;
    try { database.row("projects", { id: "synthetic", name: "Synthetic Project", metadata: "{}" });
      database.row("threads", { id, project_id: "synthetic", cwd: f.project, source: "cli", archived: 0n }); catalog = readCodexProjectCatalog(database.db, "synthetic"); }
    finally { database.close(); }
    const catalogFile = path.join(f.base, "catalog.json"); fs.writeFileSync(catalogFile, json(catalog));
    const exported = exportPortableProjectEvidence({ directory: archive, catalogFile, expectedCatalogDigest: hash(fs.readFileSync(catalogFile)),
      physicalSources: [{ threadId: id, directory: f.source, expectedPayloadDigest: f.captured.payloadDigest }], assertCurrentAuthority: () => {} });
    if (mode === "partial") {
      const inspected = inspectPortableProjectEvidence({ directory: archive, archiveId: exported.archiveId, expectedArchiveDigest: exported.archiveDigest });
      const entry = inspected.sources[0].history.entries.find(entry => entry.path.endsWith(".partial")); assert.ok(entry);
      assert.ok(fs.readFileSync(path.join(archive, "objects", entry.original.sha256 + ".bin")).equals(json(data.document)));
      assert.equal(inspected.sources[0].history.unqualifiedOperationalEntries.length, 1);
    }
    let archiveId = exported.archiveId, archiveDigest = exported.archiveDigest;
    if (mode === "legacy-skipped") {
      const old = JSON.parse(fs.readFileSync(path.join(archive, "archives", archiveId + ".json")));
      const history = old.sources[0].history;
      delete history.classificationProfile; delete history.unqualifiedOperationalEntries;
      history.entries = history.entries.filter(entry => !entry.path.endsWith(".partial")); history.skippedUnknownEntries = 1;
      const raw = json(old); archiveDigest = hash(raw); archiveId = "project-evidence-" + archiveDigest.slice(0, 24);
      fs.writeFileSync(path.join(archive, "archives", archiveId + ".json"), raw, { flag: "wx" }); // Synthetic old archive, never an edited original.
      assert.equal(inspectPortableProjectEvidence({ directory: archive, archiveId, expectedArchiveDigest: archiveDigest }).sources[0].history.skippedUnknownEntries, 1);
    }
    const args = { directory: archive, archiveId, expectedArchiveDigest: archiveDigest,
      threadIds: [id], root: f.project, nativeHome: profile, converter: "codex-claude-physical-hybrid-v4", assertCurrentAuthority: () => {} };
    const previous = process.env.LOCALAPPDATA; process.env.LOCALAPPDATA = appdata;
    try {
      const admitted = await operatePortableProjectNative({ ...args, action: "admit-portable-targets" }); assert.equal(admitted.pendingThreadIds.length, 0);
      const host = { provider: "claude", version: async () => "2.1.317", executableDigest: hash(Buffer.from("synthetic-only")), evidenceKind: "synthetic-only" };
      if (mode === "denied") {
        const originalOpen = fs.openSync, failure = Object.assign(new Error("Synthetic known history access denied"), { code: "EACCES" });
        const targets = new Set([archive, nativeRoot(archive)].flatMap(root => {
          const file = path.join(root, "objects", hash(json(data.document)) + ".bin"); return [file, path.toNamespacedPath(file)];
        }).map(value => path.resolve(value).toLowerCase()));
        let denied = false, laterReads = 0;
        fs.openSync = function (file, ...args) { if (denied) laterReads++;
          if (typeof file === "string" && targets.has(path.resolve(file).toLowerCase())) { denied = true; throw failure; }
          return originalOpen.call(this, file, ...args); };
        try { await assert.rejects(operatePortableProjectNative({ ...args, action: "publish-portable-project", host }), error => error === failure); }
        finally { fs.openSync = originalOpen; }
        assert.equal(denied, true); assert.equal(laterReads, 0); assert.deepEqual(fs.readdirSync(profile), []); return;
      }
      const result = await operatePortableProjectNative({ ...args, action: "publish-portable-project",
        host });
      assert.equal(result.results[0].result.filesWritten, mode === "different" ? 1 : 0);
      assert.equal(result.pendingThreadIds.length, mode === "different" ? 0 : 1);
    } finally { if (previous === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous; }
  });
});

import { relativeProjectArtifact } from "../scripts/lib/project-storage-format.mjs";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { recordSessionWorkEvidence, readSessionWorkContext, readSessionWorkEvidenceOwner, normalizeSessionWorkEvidence } from "../scripts/lib/session-work-context.mjs";
import { createSessionWorkReadContext, inspectSessionWorkReference, readSessionWorkFileObservation } from "../scripts/lib/session-work-evidence-original.mjs";
import { refreshProjectGraphIndex } from "../scripts/lib/discovery-index.mjs";
import { fixture, exact, link, citation, snapshot, sha, encoded } from "./helpers/session-work-linkage-fixture.mjs";

// Independent public-reader synthetic regressions. No legacy all-history
// accounting helper, subprocess, installed Host, provider or model fixture.
const ids = value => value.records.map(record => record.evidenceId);
const found = (value, saved) => value.records.find(record => record.evidenceId === saved.evidence.evidenceId);
const sameFile = (a, b) => typeof a === "string" && path.resolve(a) === path.resolve(b);
const indexFile = f => path.join(f.root, relativeProjectArtifact(f.storage, "graph-discovery", "index.json"));

test("ABC: oversized originals retain exact short reasons and pending fields without replacing canonical content", t => {
  const f = fixture(t, "Recover exact saved reasoning under current direction");
  const earlier = saveAt(f, { summary: "Earlier explicitly linked decision", judgments: [
    { assessment: "Reuse the formatter", reason: "Keep one normalization rule", alternatives: ["Duplicate it"] }] }, 0);
  const large = saveAt(f, { summary: "S".repeat(12000), observedWork: ["O".repeat(14000)],
    judgments: [{ assessment: "A".repeat(14000) + " TailConditionMarker: do not deploy", reason: "ShortReasonMarker", alternatives: ["RecordedAlternative"] }],
    pending: ["ShortPendingMarker"], unknowns: ["ShortUnknownMarker"], suggestedFollowUp: ["SuggestionIsNotPermission"],
    workLink: { root: exact(earlier), predecessor: exact(earlier) } }, 1);
  const before = snapshot(f.base), value = f.read();
  account(value);
  assert.equal(value.status, "work_context_partial");
  const excerpt = value.recordExcerpts.find(row => row.source.evidenceId === large.evidence.evidenceId);
  assert(excerpt); assert.equal(excerpt.partial, true); assert.equal(excerpt.content, undefined);
  assert.equal(excerpt.source.evidenceDigest, large.evidence.evidenceDigest);
  const returned = JSON.stringify(excerpt.fields);
  for (const marker of ["ShortReasonMarker", "RecordedAlternative", "ShortPendingMarker", "ShortUnknownMarker", "SuggestionIsNotPermission"]) assert(returned.includes(marker), marker);
  assert(excerpt.fields.some(field => field.group?.path[1] === "judgments"));
  assert.equal(returned.includes("TailConditionMarker"), false); assert.equal(excerpt.coverage.conditionsMayBeOmitted, true);
  assert(excerpt.coverage.fields.some(field => field.partialItems || field.omittedItems));
  for (const field of excerpt.fields) {
    const original = field.path.reduce((item, key) => item[key], large.evidence);
    assert.deepEqual(field.value, field.range ? original.slice(field.range.start, field.range.end) : original);
    if (field.range) assert.equal(field.range.unit, "utf16-code-units");
  }
  assert(value.records.some(record => record.evidenceId === earlier.evidence.evidenceId));
  const exactRead = f.read({ evidenceIds: [large.evidence.evidenceId], maxRecords: 1, maxCharacters: 512 * 1024 });
  assert.deepEqual(exactRead.records[0].content, large.evidence.content); assert.equal(exactRead.recordExcerpts, undefined);
  const tiny = f.read({ maxCharacters: 2 });
  assert.deepEqual(tiny.records, []); assert.equal(tiny.recordExcerpts?.length || 0, 0);
  assert.equal(tiny.coverage.usedCharacters, 2); assert.equal(tiny.status, "work_context_partial");
  assert.equal(tiny.ordinaryWorkBlocked, false); assert.deepEqual(snapshot(f.base), before);
  t.diagnostic(JSON.stringify({ scope: "ABC public default and exact reader", fullIds: ids(value), source: excerpt.source,
    usedCharacters: value.coverage.usedCharacters, maxCharacters: value.coverage.maxCharacters, coverage: excerpt.coverage,
    exactOriginalPreserved: true, minimumBudgetZeroAdmission: true }));
});

test("ABC: Unicode excerpts count emitted JSON and keep exact grapheme-safe UTF16 ranges", t => {
  const f = fixture(t), text = '한😀e\u0301\\"\u0001'.repeat(2200);
  const saved = f.save({ summary: text, observedWork: ["😀e\u0301".repeat(1000)],
    judgments: [{ assessment: "Actual recorded assessment", reason: "UnicodeReasonMarker", alternatives: ["Alternative"] }],
    pending: ["UnicodePendingMarker"], unknowns: ["A condition may remain outside the excerpt"] });
  const before = snapshot(f.base);
  for (const maxCharacters of [2, 1500, 4999, 5000, 5001, 32768]) {
    const value = f.read({ maxCharacters }); account(value);
    for (const excerpt of value.recordExcerpts || []) {
      assert.equal(excerpt.source.evidenceId, saved.evidence.evidenceId);
      assert.equal(excerpt.source.evidenceDigest, saved.evidence.evidenceDigest);
      assert.equal(excerpt.coverage.conditionsMayBeOmitted, true);
      for (const field of excerpt.fields) {
        const original = field.path.reduce((item, key) => item[key], saved.evidence);
        if (!field.range) { assert.deepEqual(field.value, original); continue; }
        assert.equal(field.range.unit, "utf16-code-units"); assert.equal(field.range.total, original.length);
        assert.equal(field.value, original.slice(field.range.start, field.range.end));
        assert(field.value.isWellFormed());
        const ends = new Set([...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(original)].map(part => part.index + part.segment.length));
        assert(ends.has(field.range.end));
      }
    }
    if (maxCharacters >= 4999) {
      assert(JSON.stringify(value.recordExcerpts).includes("UnicodeReasonMarker"));
      assert(JSON.stringify(value.recordExcerpts).includes("UnicodePendingMarker"));
      assert(Buffer.byteLength(JSON.stringify(value.recordExcerpts)) > JSON.stringify(value.recordExcerpts).length);
    }
    t.diagnostic(JSON.stringify({ scope: "ABC UTF16 collection JSON, not UTF8 or tokens", maxCharacters,
      usedCharacters: value.coverage.usedCharacters, full: value.records.length, excerpts: value.recordExcerpts?.length || 0 }));
  }
  assert.deepEqual(snapshot(f.base), before);
});
function navigation(f) {
  const index = JSON.parse(fs.readFileSync(indexFile(f)));
  assert.equal(index.sessionWorkNavigation?.version, 1);
  assert.ok(Array.isArray(index.sessionWorkNavigation.rows));
  return index;
}
function prepareLegacyFullScan(f) {
  const index = JSON.parse(fs.readFileSync(indexFile(f)));
  delete index.sessionWorkNavigation;
  fs.writeFileSync(indexFile(f), JSON.stringify(index)); // Fixture setup outside read snapshots.
}
function editNavigation(f, edit) {
  const index = navigation(f); edit(index);
  fs.writeFileSync(indexFile(f), JSON.stringify(index)); // Explicit historical-metadata fault/legacy fixture, not a writer claim.
}
function account(value, { exactRequest = false, page = false, fullScan = false } = {}) {
  assert.equal(value.coverage.inspected, value.coverage.valid + value.coverage.unavailable);
  assert.ok(value.coverage.included <= value.coverage.valid);
  assert.equal(value.coverage.included, value.records.length);
  assert.equal(new Set(ids(value)).size, value.records.length);
  const delivered = value.recordExcerpts?.length ? JSON.stringify({ records: value.records, recordExcerpts: value.recordExcerpts }) : JSON.stringify(value.records);
  assert.equal(value.coverage.usedCharacters, delivered.length);
  assert.ok(value.records.length <= value.coverage.maxRecords);
  assert.ok(delivered.length <= value.coverage.maxCharacters);
  assert.ok(value.records.length + (value.recordExcerpts?.length || 0) <= value.coverage.maxRecords);
  assert.equal(value.omissions.omittedIdCount + value.omissions.evidenceIds.length, value.omissions.byBudget);
  assert.equal(value.omissions.unavailableDetailCount + value.unavailable.length, value.coverage.unavailable);
  if (exactRequest) {
    assert.equal(value.coverage.originals, null); assert.equal(value.omissions.uninspected, null);
    assert.equal(value.nextAfterEvidenceId, null);
    assert.equal(value.coverage.selection, "newest-recorded-first-within-requested-exact-ids; Session inventory not enumerated; no global completeness or semantic sufficiency claim");
  } else {
    assert.equal(typeof value.coverage.originals, "number");
    if (!page) {
      assert.equal(value.omissions.uninspected, value.coverage.originals - value.coverage.inspected);
      if (fullScan) {
        assert.equal(value.coverage.inspected, value.coverage.originals);
        assert.equal(value.omissions.uninspected, 0);
      }
      assert.ok(value.omissions.byBudget <= value.coverage.valid - value.coverage.included);
    }
  }
  if (page || exactRequest) assert.equal(value.coverage.valid, value.coverage.included + value.omissions.byBudget);
  for (const flag of ["persisted", "recoveryAuthority", "instructionAuthority", "promotionAuthority", "executionReplayAllowed", "ordinaryWorkBlocked"]) assert.equal(value[flag], false);
}
function saveAt(f, input, seconds) {
  const RealDate = globalThis.Date, time = Date.parse("2026-01-01T00:00:00Z") + seconds * 1000;
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [time])); }
    static now() { return time; }
  };
  try { return f.route(() => recordSessionWorkEvidence({ root: f.root, input })); }
  finally { globalThis.Date = RealDate; }
}
function rawReads(file, callback) {
  const read = fs.readFileSync; let count = 0;
  fs.readFileSync = (candidate, ...args) => {
    if (sameFile(candidate, file)) count++;
    return read(candidate, ...args);
  };
  try { return { value: callback(), reads: count }; } finally { fs.readFileSync = read; }
}
// Observe a fresh use only after every known S original has actually had its
// first raw read. Faults target scan/body/endpoint phases, not a v4 read ordinal.
function afterScanReads(originals, observe, callback) {
  const read = fs.readFileSync, known = new Set(originals.map(saved => path.resolve(saved.file))), scanned = new Set();
  fs.readFileSync = (file, ...args) => {
    const key = typeof file === "string" ? path.resolve(file) : null;
    const postScan = known.has(key) && scanned.size === known.size && scanned.has(key);
    observe({ file, postScan, when: "before" });
    const bytes = read(file, ...args);
    if (known.has(key)) scanned.add(key);
    observe({ file, postScan, when: "after", bytes });
    return bytes;
  };
  try { return callback(); } finally { fs.readFileSync = read; }
}
function immutableRead(f, options = {}, readProjection = () => f.read(options)) {
  const before = snapshot(f.base), restored = [], writes = [];
  const trap = (object, name, label = name) => {
    restored.push([object, name, object[name]]);
    object[name] = () => { writes.push(label); throw new Error("Read attempted " + label); };
  };
  for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "unlinkSync", "renameSync", "linkSync", "rmSync", "copyFileSync", "truncateSync"]) trap(fs, name);
  for (const name of ["writeFile", "appendFile", "mkdir", "unlink", "rename", "link", "rm", "copyFile", "truncate"]) {
    trap(fs, name, "callback." + name); trap(fsp, name, "promises." + name);
  }
  let value;
  try { value = readProjection(); } finally { for (const [object, name, method] of restored.reverse()) object[name] = method; }
  assert.deepEqual(writes, []); assert.deepEqual(snapshot(f.base), before); return value;
}

test("R1: eight public originals share one 256KiB generic-reference read per request and observe the next request's changed bytes", t => {
  const f = fixture(t), file = path.join(f.root, "shared-reference.txt"), bytes = Buffer.alloc(256 * 1024, 120);
  fs.writeFileSync(file, bytes);
  const ref = { path: "shared-reference.txt", digest: sha(bytes), kind: "source" }, saved = [];
  for (let i = 0; i < 8; i++) saved.push(f.save({ summary: "Shared reference record " + i, references: [ref] }));
  const before = snapshot(f.base);
  for (const options of [{}, { evidenceIds: saved.map(item => item.evidence.evidenceId), maxRecords: 8 }]) {
    const measured = rawReads(file, () => f.read(options));
    assert.equal(measured.reads, 1);
    assert.equal(measured.value.records.length, 8);
    assert.ok(measured.value.records.every(record => record.references[0].status === "matching-current-bytes"));
    account(measured.value, { exactRequest: options.evidenceIds !== undefined });
  }
  assert.deepEqual(snapshot(f.base), before);
  fs.writeFileSync(file, Buffer.alloc(256 * 1024, 121));
  const changed = rawReads(file, () => f.read({ evidenceIds: saved.map(item => item.evidence.evidenceId), maxRecords: 8 }));
  assert.equal(changed.reads, 1);
  assert.ok(changed.value.records.every(record => record.references[0].reasonCode === "SESSION_WORK_REFERENCE_CHANGED"));
  account(changed.value, { exactRequest: true });
});

test("R1: cached raw bytes do not cache source/artifact, digest or Project verdicts", t => {
  const f = fixture(t), anchor = f.save({ summary: "Public owner anchor" });
  const owner = readSessionWorkEvidenceOwner({ root: f.root, sessionId: f.session.sessionId });
  const file = path.join(f.root, "foreign-reference.json");
  const foreign = JSON.stringify({ projectId: "head-" + "0".repeat(20), sessionId: anchor.evidence.sessionId });
  fs.writeFileSync(file, foreign);
  const ref = { path: "foreign-reference.json", digest: sha(foreign), kind: "source" };
  const measured = rawReads(file, () => {
    const context = createSessionWorkReadContext(f.root);
    return [
      inspectSessionWorkReference(owner, ref, { context }),
      inspectSessionWorkReference(owner, { ...ref, kind: "artifact" }, { context }),
      inspectSessionWorkReference(owner, { ...ref, digest: "f".repeat(64) }, { context }),
      inspectSessionWorkReference(owner, ref, { context }),
    ];
  });
  assert.equal(measured.reads, 1);
  assert.equal(measured.value[0].status, "matching-current-bytes");
  assert.equal(measured.value[1].reasonCode, "SESSION_WORK_REFERENCE_PROJECT_MISMATCH");
  assert.equal(measured.value[2].reasonCode, "SESSION_WORK_REFERENCE_CHANGED");
  assert.equal(measured.value[3].status, "matching-current-bytes");
  t.diagnostic("Shared inspector verdict test complements the public reader I/O fixture; it is not a separate public API claim.");
});

test("R1 unit: a request-only small bound cannot poison a larger read or bypass a later smaller bound and independent digest verdict", t => {
  const f = fixture(t), owner = readSessionWorkEvidenceOwner({ root: f.root, sessionId: f.session.sessionId });
  const relative = "bound-only-reference.json", file = path.join(f.root, relative);
  const bytes = Buffer.from(JSON.stringify({ projectId: f.session.projectId, payload: "x".repeat(512) }));
  fs.writeFileSync(file, bytes);
  const before = snapshot(f.base), measured = rawReads(file, () => {
    const context = createSessionWorkReadContext(f.root);
    assert.throws(() => context.read(relative, 16), error => error.code === "SESSION_WORK_REFERENCE_UNAVAILABLE" && error.requestBoundOnly === true);
    const large = context.read(relative, bytes.length);
    assert.deepEqual(large, bytes);
    assert.throws(() => context.read(relative, 16), { code: "SESSION_WORK_REFERENCE_UNAVAILABLE" });
    const again = context.read(relative, bytes.length);
    assert.deepEqual(again, large); assert.notStrictEqual(again, large);
    large.fill(0);
    assert.deepEqual(context.read(relative, bytes.length), bytes, "Caller mutation cannot poison a retained observation or its byte digest");
    const ref = { path: relative, digest: sha(bytes), kind: "source" };
    const rejected = inspectSessionWorkReference(owner, { ...ref, digest: "0".repeat(64) }, { context });
    const accepted = inspectSessionWorkReference(owner, ref, { context });
    const artifact = inspectSessionWorkReference(owner, { ...ref, kind: "artifact" }, { context });
    return { rejected, accepted, artifact };
  });
  assert.equal(measured.reads, 1, "Only the first permitted raw read reaches the filesystem");
  assert.equal(measured.value.rejected.reasonCode, "SESSION_WORK_REFERENCE_CHANGED");
  assert.equal(measured.value.accepted.status, "matching-current-bytes");
  assert.equal(measured.value.artifact.status, "intact-retained-original");
  assert.deepEqual(snapshot(f.base), before);
  t.diagnostic("Shared raw-byte context/inspector unit; not a new public reader option or admission policy.");
});

test("R1: public originals sharing one path keep different retained digests and source/artifact statuses independent", t => {
  const f = fixture(t), file = path.join(f.root, "mixed-reference.json");
  const firstBytes = JSON.stringify({ projectId: f.session.projectId, value: "version-11" });
  const nextBytes = JSON.stringify({ projectId: f.session.projectId, value: "version-22" });
  fs.writeFileSync(file, firstBytes);
  const refs = bytes => ["source", "artifact"].map(kind => ({ path: "mixed-reference.json", digest: sha(bytes), kind }));
  const first = f.save({ summary: "Old retained file digest", references: refs(firstBytes) });
  fs.writeFileSync(file, nextBytes);
  const next = f.save({ summary: "New retained file digest", references: refs(nextBytes) });
  const before = snapshot(f.base), measured = rawReads(file, () => f.read());
  assert.equal(measured.reads, 1);
  assert.deepEqual(found(measured.value, next).references.map(ref => ref.status), ["matching-current-bytes", "intact-retained-original"]);
  assert.ok(found(measured.value, first).references.every(ref => ref.reasonCode === "SESSION_WORK_REFERENCE_CHANGED"));
  account(measured.value); assert.deepEqual(snapshot(f.base), before);
});

test("R2: exact one/many/deduplicated/empty/missing/invalid ID sets never enumerate the work directory, including EACCES", t => {
  const f = fixture(t), first = f.save({ summary: "Exact first" }), second = f.save({ summary: "Exact second" });
  const missing = "work-evidence-" + "0".repeat(24), directory = path.dirname(first.file);
  const requests = [
    { evidenceIds: [first.evidence.evidenceId], maxRecords: 1 },
    { evidenceIds: [first.evidence.evidenceId, second.evidence.evidenceId] },
    { evidenceIds: [first.evidence.evidenceId, first.evidence.evidenceId] },
    { evidenceIds: [] }, { evidenceIds: [missing] }, { evidenceIds: ["invalid-work-id"] },
  ];
  const before = snapshot(f.base), readdir = fs.readdirSync; let enumerations = 0;
  fs.readdirSync = (file, ...args) => {
    if (sameFile(file, directory)) { enumerations++; throw Object.assign(new Error("Unrelated inventory denial"), { code: "EACCES" }); }
    return readdir(file, ...args);
  };
  try {
    for (const request of requests) {
      const value = f.read(request); account(value, { exactRequest: true });
      assert.equal(value.coverage.inspected, new Set(request.evidenceIds).size);
      const expected = request.evidenceIds.includes(first.evidence.evidenceId) ? [first.evidence.evidenceId] : [];
      if (request.evidenceIds.includes(second.evidence.evidenceId)) expected.unshift(second.evidence.evidenceId);
      assert.deepEqual(ids(value), expected);
    }
    assert.throws(() => f.read({ evidenceIds: [], afterEvidenceId: missing }), { code: "INVALID_SESSION_WORK_EVIDENCE" });
    assert.throws(() => f.read({ evidenceIds: Array(513).fill(missing) }), { code: "INVALID_SESSION_WORK_EVIDENCE" });
  } finally { fs.readdirSync = readdir; }
  assert.equal(enumerations, 0); assert.deepEqual(snapshot(f.base), before);
});

test("R3: an unrelated old observation does not trigger whether the explicitly cited old reason and recent X are restored", t => {
  const f = fixture(t);
  const reason = saveAt(f, { judgments: [{ assessment: "Use B", reason: "OLD EXACT REASON: retain provenance", alternatives: ["Rebuild A"] }] }, 0);
  for (let i = 0; i < 10; i++) saveAt(f, { summary: "Unrelated intermediate record " + i }, 10 + i);
  const recent = saveAt(f, { summary: "Recent observed result", pending: ["X remains"], references: [citation(f, reason)] }, 100);
  const before = f.read({ maxRecords: 4 });
  assert.ok(found(before, reason)); assert.deepEqual(found(before, recent).content.pending, ["X remains"]);
  saveAt(f, { summary: "Unrelated far-old observation", executionObservation: { state: "unknown" } }, -100);
  const after = f.read({ maxRecords: 4 });
  assert.deepEqual(ids(after), ids(before));
  assert.deepEqual(after.records.map(record => record.selectionRole), before.records.map(record => record.selectionRole));
  assert.deepEqual(found(after, reason).content, reason.evidence.content);
  assert.deepEqual(found(after, recent).content.pending, ["X remains"]);
  account(before); account(after);
});

test("R3: verified proof-only producer counts as valid without a body-budget omission", t => {
  const f = fixture(t), target = saveAt(f, { summary: "Displayed target", pending: ["X"], executionObservation: { state: "running" } }, 100);
  const producer = saveAt(f, { executionObservation: { state: "ended", target: exact(target) } }, 0);
  const before = snapshot(f.base), value = f.read({ maxRecords: 1 });
  assert.deepEqual(ids(value), [target.evidence.evidenceId]);
  assert.equal(value.coverage.valid, 2); assert.equal(value.coverage.included, 1);
  assert.equal(value.omissions.byBudget, 0); assert.deepEqual(value.omissions.evidenceIds, []);
  assert.deepEqual(found(value, target).savedActivity.states, ["ended"]);
  assert.equal(found(value, target).savedActivity.qualifierCount, 1);
  assert.equal(found(value, producer), undefined);
  assert.equal(value.organization.scope, "inspected-originals-only");
  account(value); assert.deepEqual(snapshot(f.base), before);
});

test("R3: an actually offered oversized root is one real budget omission while recent X survives", t => {
  const f = fixture(t), root = saveAt(f, { summary: "Oversized root " + "r".repeat(18000) }, 0);
  const recent = saveAt(f, { summary: "Small recent result", pending: ["X"], workLink: link(root) }, 100);
  const value = f.read({ maxRecords: 2, maxCharacters: 6000 });
  assert.deepEqual(ids(value), [recent.evidence.evidenceId]); assert.deepEqual(found(value, recent).content.pending, ["X"]);
  assert.equal(value.coverage.valid, 2); assert.equal(value.omissions.byBudget, 1);
  assert.deepEqual(value.omissions.evidenceIds, [root.evidence.evidenceId]);
  account(value);
});

test("R3: forged and stale S producers do not invent states or authenticated qualifier-loss counts", t => {
  const f = fixture(t), target = saveAt(f, { summary: "Target", executionObservation: { state: "running" } }, 100);
  saveAt(f, { executionObservation: { state: "ended", target: exact(target) } }, 0);
  const { evidenceDigest, ...payload } = target.evidence;
  payload.recordedAt = "2026-01-01T00:02:00.000Z";
  target.evidence = { ...payload, evidenceDigest: sha(encoded(payload)) };
  assert.notEqual(target.evidence.evidenceDigest, evidenceDigest);
  fs.writeFileSync(target.file, JSON.stringify(target.evidence, null, 2) + "\n");
  saveAt(f, { executionObservation: { state: "paused", target: exact(target) } }, 1);
  const forged = saveAt(f, { summary: "Canonical invalid producer", executionObservation: { state: "ended", target: exact(target) } }, 2);
  const document = JSON.parse(fs.readFileSync(forged.file, "utf8"));
  document.content.summary = "Tampered but plausible metadata";
  fs.writeFileSync(forged.file, JSON.stringify(document));
  const value = f.read({ maxRecords: 1 }), activity = found(value, target).savedActivity;
  assert.deepEqual(activity.states, ["paused"]); assert.equal(activity.qualifierCount, 1);
  assert.equal(activity.unavailableQualifierCount, 0);
  assert.equal(value.unavailable.filter(item => item.evidenceId === forged.evidence.evidenceId).length, 1);
  assert.deepEqual(ids(value), [target.evidence.evidenceId]); account(value);
});

test("R3: a producer's unrelated bad link/ref and its own incoming producer are not recursive recovery obligations", t => {
  const f = fixture(t), unrelatedRoot = saveAt(f, { summary: "Unrelated root" }, -20);
  const file = path.join(f.root, "unrelated-producer-reference.txt"); fs.writeFileSync(file, "Original source");
  const target = saveAt(f, { summary: "Displayed target", pending: ["X"], executionObservation: { state: "running" } }, 100);
  const producer = saveAt(f, { workLink: link(unrelatedRoot), executionObservation: { state: "ended", target: exact(target) },
    references: [{ path: "unrelated-producer-reference.txt", digest: sha(fs.readFileSync(file)), kind: "source" }] }, 0);
  const irrelevant = saveAt(f, { executionObservation: { state: "unknown", target: exact(producer) } }, -10);
  fs.unlinkSync(unrelatedRoot.file); fs.unlinkSync(file);
  const read = fs.readFileSync, counts = { root: 0, reference: 0, irrelevant: 0 };
  fs.readFileSync = (candidate, ...args) => {
    if (sameFile(candidate, unrelatedRoot.file)) counts.root++;
    if (sameFile(candidate, file)) counts.reference++;
    if (sameFile(candidate, irrelevant.file)) counts.irrelevant++;
    return read(candidate, ...args);
  };
  let value; try { value = f.read({ maxRecords: 1 }); } finally { fs.readFileSync = read; }
  assert.deepEqual(found(value, target).savedActivity.states, ["ended"]);
  assert.equal(found(value, target).savedActivity.qualifierCount, 1);
  assert.equal(counts.root, 0); assert.equal(counts.reference, 0);
  assert.equal(counts.irrelevant, 0, "A hinted producer-of-producer is not recursively inspected for this target");
  assert.equal(value.coverage.inspected, 2); assert.equal(value.coverage.valid, 2);
  assert.equal(value.omissions.uninspected, 1);
  assert.equal(value.coverage.unavailable, 0); assert.equal(value.omissions.byBudget, 0);
  assert.equal(value.organization.roots, 0); account(value);
});

test("R3: a late proof-only body promotion drift removes its old qualifier once and continues to a fitting fallback", t => {
  const f = fixture(t), fallback = saveAt(f, { summary: "Independent fitting fallback" }, -10);
  const target = saveAt(f, { summary: "Displayed target", pending: ["X"], executionObservation: { state: "running" } }, 100);
  const producer = saveAt(f, { executionObservation: { state: "ended", target: exact(target) } }, 0);
  prepareLegacyFullScan(f); // This regression specifically observes the S-to-fresh-body boundary.
  let injected = false, failedProducerFreshRead = false;
  const value = afterScanReads([fallback, target, producer], ({ file, postScan, when }) => {
    if (postScan && when === "before" && sameFile(file, target.file) && !injected) {
      injected = true; fs.writeFileSync(producer.file, "{}");
    }
    if (postScan && when === "before" && sameFile(file, producer.file) && injected) failedProducerFreshRead = true;
  }, () => f.read({ maxRecords: 2 }));
  assert.equal(injected, true); assert.equal(failedProducerFreshRead, true, "The failed producer is actually observed again as a body candidate");
  assert.deepEqual(ids(value), [target.evidence.evidenceId, fallback.evidence.evidenceId]);
  const activity = found(value, target).savedActivity;
  assert.deepEqual(activity.states, []); assert.equal(activity.qualifierCount, 0);
  assert.equal(activity.unavailableQualifierCount, 1);
  assert.equal(value.unavailable.filter(item => item.evidenceId === producer.evidence.evidenceId).length, 1);
  assert.equal(value.coverage.unavailable, 1); assert.equal(value.omissions.byBudget, 0);
  account(value);
});

test("single S: an unobserved post-scan change to a non-body incoming producer remains only the historical S observation", t => {
  const f = fixture(t), target = saveAt(f, { summary: "Displayed historical target", pending: ["X"], executionObservation: { state: "running" } }, 100);
  const producer = saveAt(f, { executionObservation: { state: "ended", target: exact(target) } }, 0);
  prepareLegacyFullScan(f); // Preserve the legacy single-S observation contract; B known incoming is tested separately.
  let injected = false, producerReadAfterS = false;
  const value = afterScanReads([target, producer], ({ file, postScan, when }) => {
    if (!postScan || when !== "before") return;
    if (sameFile(file, target.file) && !injected) { injected = true; fs.writeFileSync(producer.file, "{}"); }
    if (sameFile(file, producer.file)) producerReadAfterS = true;
  }, () => f.read({ maxRecords: 1 }));
  assert.equal(injected, true); assert.equal(producerReadAfterS, false);
  assert.deepEqual(ids(value), [target.evidence.evidenceId]);
  const activity = found(value, target).savedActivity;
  assert.deepEqual(activity.states, ["ended"]); assert.equal(activity.qualifierCount, 1);
  assert.equal(activity.unavailableQualifierCount, 0); assert.equal(activity.coverage, "verified-scan");
  assert.equal(activity.currentState, undefined); assert.equal(value.organization.liveState, "not-observed");
  assert.deepEqual(found(value, target).content.pending, ["X"]);
  assert.equal(value.coverage.valid, 2); assert.equal(value.coverage.unavailable, 0);
  assert.equal(value.omissions.byBudget, 0); assert.equal(value.status, "work_context_partial"); account(value);
  const next = f.read({ maxRecords: 1 });
  assert.deepEqual(found(next, target).savedActivity.states, []);
  assert.equal(found(next, target).savedActivity.unavailableQualifierCount, 0, "The next request rejects this producer initially, not as a lost verified qualifier");
  assert.equal(next.coverage.unavailable, 1); account(next);
});

test("single S: an initially invalid discovered endpoint cannot reactivate when restored before fresh body and endpoint selection", t => {
  const f = fixture(t), root = saveAt(f, { summary: "Initially failed exact root" }, 0);
  const source = saveAt(f, { summary: "Intact selected source", pending: ["X"], workLink: link(root) }, 100);
  const originalBytes = fs.readFileSync(root.file); fs.writeFileSync(root.file, "{}");
  prepareLegacyFullScan(f);
  let restored = false;
  const value = afterScanReads([root, source], ({ file, postScan, when }) => {
    if (postScan && when === "before" && sameFile(file, source.file) && !restored) {
      restored = true; fs.writeFileSync(root.file, originalBytes);
    }
  }, () => f.read({ maxRecords: 4 }));
  assert.equal(restored, true); assert.deepEqual(ids(value), [source.evidence.evidenceId]);
  assert.equal(value.coverage.originals, 2); assert.equal(value.coverage.valid, 1);
  assert.equal(value.coverage.unavailable, 1); assert.equal(value.omissions.byBudget, 0);
  assert.equal(value.unavailable.filter(item => item.evidenceId === root.evidence.evidenceId).length, 1);
  assert.ok(found(value, source).savedActivity.relations.every(relation => relation.status === "unavailable"));
  assert.deepEqual(found(value, source).content.pending, ["X"]); account(value);
  const next = f.read({ maxRecords: 4 });
  assert.ok(found(next, root)); assert.equal(next.coverage.valid, 2); assert.equal(next.coverage.unavailable, 0); account(next);
});

test("single S: a bare-impossible seed does not prepare its root or cited body before a smaller fitting result", t => {
  const f = fixture(t), root = saveAt(f, { summary: "Root not needed by fitting source" }, 1);
  const reason = saveAt(f, { summary: "Reason not needed by fitting source" }, 2);
  const small = saveAt(f, { summary: "SMALL FITTING evidence", pending: ["X"] }, 20);
  const giant = saveAt(f, { summary: "g".repeat(5000), workLink: link(root), references: [citation(f, reason)] }, 100);
  prepareLegacyFullScan(f); // Mandatory S-only reads in this legacy fixture are deliberately retained.
  const before = snapshot(f.base), read = fs.readFileSync, counts = { root: 0, reason: 0 };
  fs.readFileSync = (file, ...args) => {
    if (sameFile(file, root.file)) counts.root++;
    if (sameFile(file, reason.file)) counts.reason++;
    return read(file, ...args);
  };
  let value; try { value = f.read({ maxRecords: 1, maxCharacters: 1500 }); } finally { fs.readFileSync = read; }
  assert.deepEqual(ids(value), [small.evidence.evidenceId]);
  assert.equal(found(value, giant), undefined);
  assert.equal(counts.root, 1, "Only its mandatory S observation, no fresh endpoint/body preparation for the impossible seed");
  assert.equal(counts.reason, 1, "Only its mandatory S observation, no cited-body or generic enrichment for the impossible seed");
  assert.equal(value.coverage.valid, 4); assert.equal(value.omissions.byBudget, 1);
  assert.deepEqual(value.omissions.evidenceIds, [giant.evidence.evidenceId]);
  account(value); assert.deepEqual(snapshot(f.base), before);
});

test("single S: late predecessor proof-to-body failure grows an exact-bound overlay and still reaches the fitting fallback", t => {
  const f = fixture(t), root = saveAt(f, { summary: "LARGE ROOT " + "r".repeat(5000) }, 1);
  const predecessor = saveAt(f, { summary: "Intermediate predecessor", workLink: link(root) }, 50);
  const fallback = saveAt(f, { summary: "SMALL FALLBACK retains an unresolved X", pending: ["Fallback X"] }, 10);
  const seed = saveAt(f, { summary: "Initially fitting selected source", workLink: link(root, predecessor) }, 100);
  prepareLegacyFullScan(f);
  const calibration = f.read({ maxRecords: 1 });
  assert.deepEqual(ids(calibration), [seed.evidence.evidenceId]);
  const maxCharacters = JSON.stringify(calibration.records).length;
  assert.ok(maxCharacters < JSON.stringify([root.evidence]).length);
  let endpointObserved = false, failedPromotionObserved = false;
  const value = afterScanReads([root, predecessor, fallback, seed], ({ file, postScan, when }) => {
    if (!postScan || !sameFile(file, predecessor.file)) return;
    if (when === "before" && endpointObserved) failedPromotionObserved = true;
    if (when === "after" && !endpointObserved) {
      endpointObserved = true;
      // Keep canonical JSON/payload intact but change the exact bytes that the
      // earlier direct endpoint proof observed; fresh body promotion must fail.
      fs.appendFileSync(predecessor.file, " ");
    }
  }, () => f.read({ maxRecords: 2, maxCharacters }));
  assert.equal(endpointObserved, true); assert.equal(failedPromotionObserved, true);
  assert.deepEqual(ids(value), [fallback.evidence.evidenceId]);
  assert.deepEqual(found(value, fallback).content.pending, ["Fallback X"]);
  assert.equal(value.coverage.unavailable, 1);
  assert.equal(value.unavailable.filter(item => item.evidenceId === predecessor.evidence.evidenceId).length, 1);
  assert.deepEqual(new Set(value.omissions.evidenceIds), new Set([root.evidence.evidenceId, seed.evidence.evidenceId]));
  assert.ok(!value.omissions.evidenceIds.includes(predecessor.evidence.evidenceId));
  account(value);
  t.diagnostic(`Exact enriched seed tuple bound ${maxCharacters}; this is the reusable 1533-character v4 probe shape, recalibrated for the candidate, not a performance result.`);
});

test("D-membership race: a restored exact endpoint may be proof-only but cannot become an undiscovered response body or inflate original counts", t => {
  const f = fixture(t), target = saveAt(f, { summary: "Exact target outside this enumeration" }, 0);
  const source = saveAt(f, { summary: "Only discovered source", pending: ["X"], workLink: link(target), references: [citation(f, target)] }, 100);
  const full = snapshot(f.base), directory = path.dirname(source.file);
  // This separately owned temporary directory is outside the fixture base and
  // outside every Project/Session discovery path. Only the exact owned T moves.
  const parking = fs.mkdtempSync(path.join(path.dirname(f.base), "restoration-owned-parking-"));
  const parked = path.join(parking, "target.json"), rename = fs.renameSync;
  t.after(() => {
    if (fs.existsSync(parked) && fs.existsSync(path.dirname(target.file)) && !fs.existsSync(target.file)) rename(parked, target.file);
    assert.ok(path.basename(parking).startsWith("restoration-owned-parking-"));
    fs.rmSync(parking, { recursive: true, force: true });
  });
  rename(target.file, parked);
  const readdir = fs.readdirSync, mutations = [], originals = []; let restored = false;
  const replace = (name, method) => { originals.push([name, fs[name]]); fs[name] = method; };
  for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "unlinkSync", "renameSync", "linkSync"]) replace(name, (...args) => {
    mutations.push(name); throw new Error("Reader attempted " + name);
  });
  fs.readdirSync = (candidate, ...args) => {
    const names = readdir(candidate, ...args);
    if (sameFile(candidate, directory) && !restored) {
      assert.ok(!names.includes(path.basename(target.file)));
      rename(parked, target.file); restored = true; // Test injection, not a reader mutation.
    }
    return names;
  };
  let value; try { value = f.read({ maxRecords: 4 }); }
  finally { fs.readdirSync = readdir; for (const [name, method] of originals.reverse()) fs[name] = method; }
  assert.equal(restored, true); assert.deepEqual(mutations, []);
  assert.deepEqual(ids(value), [source.evidence.evidenceId]);
  assert.equal(value.coverage.originals, 1); assert.equal(value.coverage.inspected, 1);
  assert.equal(value.coverage.valid, 1); assert.equal(value.coverage.unavailable, 0);
  assert.equal(value.coverage.included, 1); assert.equal(value.omissions.byBudget, 0);
  assert.ok(!value.unavailable.some(item => item.evidenceId === target.evidence.evidenceId));
  if (value.organization) assert.equal(value.organization.scope, "inspected-originals-only");
  account(value); assert.deepEqual(snapshot(f.base), full);
  const next = f.read({ maxRecords: 4 });
  assert.ok(found(next, target)); assert.ok(found(next, source));
  assert.equal(next.coverage.originals, 2); account(next);
});

test("R1/R3: later failed work proof overrides an earlier successful reference observation within the same response", t => {
  const f = fixture(t), root = saveAt(f, { summary: "Large unrelated root " + "r".repeat(14000) }, -10);
  const a = saveAt(f, { summary: "Large citation A " + "a".repeat(14000) }, 0);
  const b = saveAt(f, { summary: "Large citation B " + "b".repeat(14000) }, 1);
  const c = saveAt(f, { summary: "Large citation C " + "c".repeat(14000) }, 2);
  const target = saveAt(f, { summary: "Late typed proof target" }, 80);
  const fitting = saveAt(f, { summary: "Independent fitting result" }, 90);
  const source = saveAt(f, { summary: "Latest intact source", pending: ["X"], workLink: link(root),
    references: [a, b, c, target].map(saved => citation(f, saved)) }, 100);
  prepareLegacyFullScan(f); // Retain the accepted full-S late typed-proof override timing.
  let injected = false, laterTargetRead = false;
  const value = afterScanReads([root, a, b, c, target, fitting, source], ({ file, postScan, when }) => {
    if (!postScan || !sameFile(file, target.file)) return;
    if (when === "before" && injected) laterTargetRead = true;
    if (when === "after" && !injected) { injected = true; fs.writeFileSync(target.file, "{}"); }
  }, () => f.read({ maxRecords: 4, maxCharacters: 6000 }));
  assert.equal(injected, true); assert.equal(laterTargetRead, true, "A later typed/body proof observes failure after the earlier generic reference bytes");
  assert.ok(found(value, source)); assert.ok(found(value, fitting)); assert.equal(found(value, target), undefined);
  const ref = found(value, source).references.find(item => item.path.endsWith(target.evidence.evidenceId + ".json"));
  assert.equal(ref.status, "unavailable"); assert.equal(ref.contentReconstructed, false);
  assert.equal(value.unavailable.filter(item => item.evidenceId === target.evidence.evidenceId).length, 1);
  assert.deepEqual(found(value, source).content.pending, ["X"]); account(value);
});

test("R3: corrupt, oversized and enriched-overflow candidates do not hide an older fitting body", t => {
  const f = fixture(t), fitting = saveAt(f, { summary: "Older fitting record", pending: ["X"] }, 0);
  const file = path.join(f.root, "enrichment-source.txt"); fs.writeFileSync(file, "Retained source");
  const ref = { path: "enrichment-source.txt", digest: sha(fs.readFileSync(file)), kind: "source" };
  const referenced = saveAt(f, { summary: "Enriched candidate", references: Array.from({ length: 12 }, () => ({ ...ref })) }, 90);
  const oversized = saveAt(f, { summary: "Oversized newest " + "q".repeat(18000) }, 100);
  const corrupt = saveAt(f, { summary: "Conclusive JSON failure" }, 110); fs.writeFileSync(corrupt.file, "{");
  const maxCharacters = JSON.stringify([{ ...referenced.evidence, references: [] }]).length + 128;
  const before = snapshot(f.base), measured = rawReads(file, () => f.read({ maxRecords: 2, maxCharacters }));
  assert.deepEqual(ids(measured.value), [fitting.evidence.evidenceId]);
  assert.equal(measured.reads, 1, "The final enriched admission, not a bare-body estimate, rejects this candidate");
  assert.equal(measured.value.coverage.unavailable, 1);
  assert.equal(measured.value.omissions.byBudget, 2);
  assert.deepEqual(new Set(measured.value.omissions.evidenceIds), new Set([referenced.evidence.evidenceId, oversized.evidence.evidenceId]));
  account(measured.value); assert.deepEqual(snapshot(f.base), before);
});

test("R3/R2: one default canonical scan crosses 511/512/513/514 lexical boundaries while explicit pages retain numeric inventory and cursors", t => {
  const f = fixture(t), inputs = Array.from({ length: 514 }, (_, index) => ({ summary: "Lexical restoration boundary " + index }))
    .map(input => ({ input, evidenceId: "work-evidence-" + sha(encoded({ projectId: f.session.projectId,
      sessionId: f.session.sessionId, content: normalizeSessionWorkEvidence(input) })).slice(0, 24) }))
    .sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
  for (let index = 0; index < inputs.length; index++) {
    const saved = saveAt(f, inputs[index].input, index);
    assert.equal(saved.evidence.evidenceId, inputs[index].evidenceId);
    if (index < 510) continue;
    prepareLegacyFullScan(f); // Explicit no-hint full-D boundary, not a requirement on normal B hints.
    const value = f.read();
    assert.deepEqual(ids(value), inputs.slice(index - 7, index + 1).reverse().map(item => item.evidenceId));
    assert.equal(value.coverage.originals, index + 1);
    assert.equal(value.coverage.inspected, index + 1); assert.equal(value.coverage.valid, index + 1);
    assert.equal(value.omissions.uninspected, 0); assert.equal(value.status, "work_context_partial");
    assert.equal(value.omissions.byBudget, 0); assert.equal(value.nextAfterEvidenceId, null);
    account(value);
  }
  const before = snapshot(f.base), first = f.read({ afterEvidenceId: inputs[0].evidenceId });
  assert.equal(first.coverage.originals, 514); assert.equal(first.coverage.inspected, 512);
  assert.equal(first.omissions.uninspected, 1); assert.equal(first.nextAfterEvidenceId, inputs[512].evidenceId);
  assert.deepEqual(ids(first), inputs.slice(505, 513).reverse().map(item => item.evidenceId));
  account(first, { page: true });
  const last = f.read({ afterEvidenceId: first.nextAfterEvidenceId });
  assert.equal(last.coverage.originals, 514); assert.equal(last.coverage.inspected, 1);
  assert.equal(last.nextAfterEvidenceId, null); assert.deepEqual(ids(last), [inputs[513].evidenceId]);
  account(last, { page: true }); assert.deepEqual(snapshot(f.base), before);
});

test("B hints: public writer rows are header-only and a normal 40-record default reports only its eight current body inspections", t => {
  const f = fixture(t), saved = [];
  for (let i = 0; i < 40; i++) saved.push(f.save({ summary: "Hinted independent history " + i, pending: ["X-" + i] }));
  const index = navigation(f);
  for (const row of index.sessionWorkNavigation.rows) {
    assert.deepEqual(Object.keys(row).sort(), ["observationTargetId", "ownerSessionId", "path", "rawDigest", "recordedAt"]);
    assert.equal(row.ownerSessionId, f.session.sessionId); assert.equal(row.observationTargetId, null);
    assert.equal(index.entries.find(entry => entry.path === row.path)?.sha256, row.rawDigest);
    const original = saved.find(item => path.relative(f.root, item.file).replaceAll("\\", "/") === row.path);
    assert.ok(original); assert.equal(row.rawDigest, sha(fs.readFileSync(original.file))); assert.equal(row.recordedAt, original.evidence.recordedAt);
  }
  assert.equal(index.sessionWorkNavigation.rows.length, 40);
  const value = immutableRead(f);
  assert.deepEqual(ids(value), saved.slice(-8).reverse().map(item => item.evidence.evidenceId));
  assert.equal(value.coverage.originals, 40); assert.equal(value.coverage.inspected, 8); assert.equal(value.coverage.valid, 8);
  assert.equal(value.coverage.unavailable, 0); assert.equal(value.coverage.included, 8);
  assert.equal(value.omissions.uninspected, 32); assert.equal(value.omissions.byBudget, 0);
  assert.deepEqual(value.omissions.evidenceIds, []); assert.equal(value.status, "work_context_partial"); account(value);
});

for (const mode of ["absent", "old", "legacy-version", "legacy-target", "duplicate-row"]) test(`B legacy ${mode}: prepare full-D input before snapshots; no read-side repair`, t => {
  const f = fixture(t), saved = Array.from({ length: 10 }, (_, i) => f.save({ summary: "Legacy original " + i }));
  if (mode === "absent") fs.unlinkSync(indexFile(f));
  else if (mode === "old") prepareLegacyFullScan(f);
  else editNavigation(f, index => {
    if (mode === "legacy-version") index.sessionWorkNavigation.version = 0;
    if (mode === "legacy-target") for (const row of index.sessionWorkNavigation.rows) delete row.observationTargetId;
    if (mode === "duplicate-row") index.sessionWorkNavigation.rows.push({ ...index.sessionWorkNavigation.rows[0] });
  });
  const value = immutableRead(f);
  assert.deepEqual(ids(value), saved.slice(-8).reverse().map(item => item.evidence.evidenceId));
  assert.equal(value.coverage.originals, 10); assert.equal(value.coverage.inspected, 10); assert.equal(value.coverage.valid, 10);
  assert.equal(value.omissions.uninspected, 0); assert.equal(value.omissions.byBudget, 0); account(value, { fullScan: true });
});

for (const field of ["missing-row", "missing-target"]) test(`B U ${field}: a latest unknown joins old hints in this same read`, t => {
  const f = fixture(t);
  for (let i = 0; i < 12; i++) f.save({ summary: "Known historical prefix " + i });
  const latest = f.save({ summary: "New useful result", pending: ["NEW X must join now"] }), latestPath = path.relative(f.root, latest.file).replaceAll("\\", "/");
  editNavigation(f, index => {
    if (field === "missing-row") index.sessionWorkNavigation.rows = index.sessionWorkNavigation.rows.filter(row => row.path !== latestPath);
    else delete index.sessionWorkNavigation.rows.find(row => row.path === latestPath).observationTargetId;
  });
  const value = immutableRead(f);
  assert.equal(value.records[0].evidenceId, latest.evidence.evidenceId); assert.deepEqual(value.records[0].content.pending, ["NEW X must join now"]);
  assert.equal(value.coverage.originals, 13); assert.equal(value.coverage.inspected, 8); assert.equal(value.coverage.valid, 8);
  assert.equal(value.omissions.uninspected, 5); assert.equal(value.omissions.byBudget, 0); account(value);
});

test("B deferred publication: primary survives, exact retry does not repair hints, and the unindexed latest original joins immediately", t => {
  const f = fixture(t);
  for (let i = 0; i < 12; i++) f.save({ summary: "Indexed prefix " + i });
  const input = { summary: "Primary success before derived index failure", pending: ["UNINDEXED X"] }, rename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (sameFile(target, indexFile(f))) throw Object.assign(new Error("Synthetic index publication failure"), { code: "EIO" });
    return rename(source, target);
  };
  let latest; try { latest = f.save(input); } finally { fs.renameSync = rename; }
  assert.equal(latest.writes, 1); assert.equal(latest.graphIndex.status, "deferred"); assert.equal(latest.graphIndex.ordinaryWorkBlocked, false);
  const before = snapshot(f.base), read = fs.readFileSync; let indexReads = 0;
  fs.readFileSync = (file, ...args) => {
    if (sameFile(file, indexFile(f))) { indexReads++; throw new Error("Exact retry must not inspect/repair the index"); }
    return read(file, ...args);
  };
  let retry; try { retry = f.save(input); } finally { fs.readFileSync = read; }
  assert.equal(retry.writes, 0); assert.equal(indexReads, 0); assert.deepEqual(retry.evidence, latest.evidence); assert.deepEqual(snapshot(f.base), before);
  const value = immutableRead(f);
  assert.equal(value.records[0].evidenceId, latest.evidence.evidenceId); assert.deepEqual(value.records[0].content.pending, ["UNINDEXED X"]);
  assert.equal(value.coverage.originals, 13); assert.equal(value.coverage.inspected, 8); assert.equal(value.omissions.uninspected, 5); account(value);
});

test("B linked history restores a fitting 6073-character reason/root and recent X without an unrelated predecessor-lineage audit", t => {
  const f = fixture(t), reasonText = "R".repeat(6073);
  const root = saveAt(f, { judgments: [{ assessment: "Retain exact provenance", reason: reasonText, alternatives: ["Rebuild"] }] }, 0), middle = [];
  let predecessor = root;
  for (let i = 1; i <= 10; i++) { predecessor = saveAt(f, { summary: "Intermediate linked observation " + i, workLink: link(root, predecessor) }, i); middle.push(predecessor); }
  const latest = saveAt(f, { summary: "Recent actual result", pending: ["X remains"], unknowns: ["External effect unverified"], workLink: link(root, predecessor), references: [citation(f, root)] }, 100);
  const read = fs.readFileSync, unwanted = new Set(middle.slice(0, -1).map(saved => path.resolve(saved.file))); let ancestorReads = 0;
  const value = immutableRead(f, { maxRecords: 2 }, () => {
    fs.readFileSync = (file, ...args) => { if (typeof file === "string" && unwanted.has(path.resolve(file))) ancestorReads++; return read(file, ...args); };
    try { return f.read({ maxRecords: 2 }); } finally { fs.readFileSync = read; }
  });
  assert.equal(ancestorReads, 0, "Unobserved ancestors are not traversed just to audit a normal public-writer chain");
  assert.deepEqual(ids(value), [latest.evidence.evidenceId, root.evidence.evidenceId]);
  assert.equal(found(value, root).content.judgments[0].reason, reasonText); assert.deepEqual(found(value, latest).content.pending, ["X remains"]);
  assert.deepEqual(found(value, latest).content.unknowns, ["External effect unverified"]); assert.equal(found(value, latest).references[0].status, "intact-retained-original");
  assert.equal(value.coverage.inspected, 3); assert.equal(value.coverage.valid, 3); assert.equal(value.omissions.uninspected, 9);
  assert.equal(value.omissions.byBudget, 0); assert.equal(found(value, latest).savedActivity.coverage, "not-inspected"); account(value);
});

test("B all 65 known incoming observations are current proofs, with bounded details but no unrelated producer recursion", t => {
  const f = fixture(t), root = saveAt(f, { summary: "Unrelated producer root" }, -1000), file = path.join(f.root, "unrelated-incoming.txt");
  fs.writeFileSync(file, "Unrelated producer reference");
  const target = saveAt(f, { summary: "Latest selected target", pending: ["X"], executionObservation: { state: "running" } }, 1000), producers = [];
  for (let i = 0; i < 65; i++) producers.push(saveAt(f, { occurrenceKey: "known-incoming-" + i,
    executionObservation: { state: ["running", "paused", "ended", "unknown"][i % 4], target: exact(target) },
    ...(i === 0 ? { workLink: link(root), references: [{ path: "unrelated-incoming.txt", digest: sha(fs.readFileSync(file)), kind: "source" }] } : {}) }, i));
  const recursive = saveAt(f, { executionObservation: { state: "unknown", target: exact(producers[0]) } }, -500);
  for (let i = 0; i < 10; i++) saveAt(f, { summary: "Untouched unrelated archive " + i }, -200 - i);
  fs.unlinkSync(root.file); fs.unlinkSync(file);
  const read = fs.readFileSync, counts = { root: 0, reference: 0, recursive: 0 };
  const value = immutableRead(f, { maxRecords: 1 }, () => {
    fs.readFileSync = (candidate, ...args) => {
      if (sameFile(candidate, root.file)) counts.root++; if (sameFile(candidate, file)) counts.reference++;
      if (sameFile(candidate, recursive.file)) counts.recursive++; return read(candidate, ...args);
    };
    try { return f.read({ maxRecords: 1 }); } finally { fs.readFileSync = read; }
  });
  const activity = found(value, target).savedActivity;
  assert.deepEqual(activity.states, ["running", "paused", "ended", "unknown"]);
  assert.equal(activity.qualifierCount, 65); assert.equal(activity.qualifiers.length, 1); assert.equal(activity.omittedQualifierCount, 64);
  assert.equal(activity.unavailableQualifierCount, 0); assert.equal(activity.coverage, "not-inspected");
  assert.equal(activity.currentState, undefined); assert.equal(activity.conflict, undefined); assert.equal(value.organization.liveState, "not-observed");
  assert.deepEqual(counts, { root: 0, reference: 0, recursive: 0 }); assert.equal(value.organization.roots, 0);
  assert.equal(value.coverage.originals, 77); assert.equal(value.coverage.inspected, 66); assert.equal(value.coverage.valid, 66);
  assert.equal(value.omissions.uninspected, 11); assert.equal(value.omissions.byBudget, 0); assert.deepEqual(ids(value), [target.evidence.evidenceId]); account(value);
});

for (const contradiction of ["recordedAt", "rawBytes", "observationTargetId"]) test(`B observed ${contradiction} hint mismatch falls back within fixed D without rejecting a healthy original`, t => {
  const f = fixture(t), target = saveAt(f, { summary: "Exact observation target" }, 0), history = [];
  for (let i = 1; i <= 8; i++) history.push(saveAt(f, { summary: "Other healthy result " + i }, i));
  const candidate = saveAt(f, { summary: "Historically newest candidate", pending: ["X"], executionObservation: { state: "ended", target: exact(target) } }, 100);
  if (contradiction === "rawBytes") {
    // Synthetic external envelope replacement: same valid content-bound ID,
    // current payload digest, but a different actual rank from the old hint.
    const { evidenceDigest, ...payload } = candidate.evidence; payload.recordedAt = "2025-12-31T23:59:00.000Z";
    candidate.evidence = { ...payload, evidenceDigest: sha(encoded(payload)) };
    assert.notEqual(candidate.evidence.evidenceDigest, evidenceDigest);
    fs.writeFileSync(candidate.file, JSON.stringify(candidate.evidence, null, 2) + "\n");
  } else editNavigation(f, index => {
    const row = index.sessionWorkNavigation.rows.find(row => row.path.endsWith(candidate.evidence.evidenceId + ".json"));
    if (contradiction === "recordedAt") row.recordedAt = "2026-01-01T00:02:00.000Z";
    else row.observationTargetId = null;
  });
  const value = immutableRead(f, { maxRecords: 1 });
  assert.deepEqual(ids(value), [(contradiction === "rawBytes" ? history.at(-1) : candidate).evidence.evidenceId]);
  assert.equal(value.coverage.originals, 10); assert.equal(value.coverage.inspected, 10); assert.equal(value.coverage.valid, 10);
  assert.equal(value.coverage.unavailable, 0); assert.deepEqual(value.unavailable, []); assert.equal(value.omissions.byBudget, 0);
  account(value, { fullScan: true });
});

for (const repaired of ["invalid-original", "unowned-originals"]) test(`B unknown ${repaired} is revalidated after same-path repair, not cached as a permanent negative`, t => {
  const f = fixture(t);
  for (let i = 0; i < 9; i++) saveAt(f, { summary: "Known older result " + i }, i);
  const latest = saveAt(f, { summary: "Repaired latest original", pending: ["REPAIRED X"] }, 100);
  const ownerFile = path.join(f.root, relativeProjectArtifact(f.storage, "sessions", "by-id"), f.session.sessionId, "current.json");
  const repairedFile = repaired === "invalid-original" ? latest.file : ownerFile, originalBytes = fs.readFileSync(repairedFile);
  if (repaired === "invalid-original") fs.writeFileSync(repairedFile, "{}");
  else { const state = JSON.parse(originalBytes); state.projectId = "head-" + "0".repeat(20); fs.writeFileSync(repairedFile, JSON.stringify(state)); }
  // Full-Project publication does not select this deliberately damaged Session.
  // Keep the normal request route/identity gate intact for the repaired read.
  refreshProjectGraphIndex({ root: f.root }); // Legitimate setup publication, not a reader repair.
  const published = JSON.parse(fs.readFileSync(indexFile(f)));
  assert.ok(!(published.sessionWorkNavigation?.rows || []).some(row => row.path.endsWith(latest.evidence.evidenceId + ".json")));
  fs.writeFileSync(repairedFile, originalBytes);
  const value = immutableRead(f);
  assert.equal(value.records[0].evidenceId, latest.evidence.evidenceId); assert.deepEqual(value.records[0].content.pending, ["REPAIRED X"]);
  assert.equal(value.sessionId, f.session.sessionId); assert.equal(value.coverage.unavailable, 0); assert.deepEqual(value.unavailable, []);
  assert.equal(value.coverage.inspected, repaired === "invalid-original" ? 8 : 10);
  assert.equal(value.omissions.byBudget, 0); account(value);
});

test("B fault boundary: an unobserved plausible false-null hint can hide an old producer, without claiming global current activity", t => {
  const f = fixture(t), target = saveAt(f, { summary: "Latest target", pending: ["X"], executionObservation: { state: "running" } }, 1000);
  const producer = saveAt(f, { executionObservation: { state: "ended", target: exact(target) } }, 0);
  for (let i = 0; i < 10; i++) saveAt(f, { summary: "Unrelated historical record " + i }, -100 - i);
  editNavigation(f, index => { index.sessionWorkNavigation.rows.find(row => row.path.endsWith(producer.evidence.evidenceId + ".json")).observationTargetId = null; });
  const hinted = immutableRead(f, { maxRecords: 1 }), activity = found(hinted, target).savedActivity;
  assert.deepEqual(ids(hinted), [target.evidence.evidenceId]); assert.deepEqual(activity.states, []); assert.equal(activity.qualifierCount, 0);
  assert.equal(activity.coverage, "not-inspected"); assert.equal(hinted.organization.scope, "inspected-originals-only");
  assert.equal(hinted.coverage.inspected, 1); assert.equal(hinted.omissions.uninspected, 11); assert.equal(hinted.status, "work_context_partial"); account(hinted);
  prepareLegacyFullScan(f); // Separate same-original full-D witness, outside both immutable read snapshots.
  const full = immutableRead(f, { maxRecords: 1 });
  assert.deepEqual(ids(full), ids(hinted)); assert.deepEqual(found(full, target).savedActivity.states, ["ended"]);
  assert.equal(found(full, target).savedActivity.qualifierCount, 1); account(full, { fullScan: true });
  t.diagnostic("Deliberately false but plausible archive metadata is an accepted unobserved limitation, not hinted/full-scan semantic equivalence or live-state evidence.");
});

test("B incoming proof later failing body promotion removes its historical state once and admits a fitting fallback", t => {
  const f = fixture(t), target = saveAt(f, { summary: "Selected target", pending: ["X"], executionObservation: { state: "running" } }, 100);
  const producer = saveAt(f, { executionObservation: { state: "ended", target: exact(target) } }, 0);
  const fallback = saveAt(f, { summary: "Fitting independent fallback" }, -10), read = fs.readFileSync;
  let incomingObserved = false, lateBodyRead = false;
  fs.readFileSync = (file, ...args) => {
    if (sameFile(file, producer.file) && incomingObserved) lateBodyRead = true;
    const bytes = read(file, ...args);
    if (sameFile(file, producer.file) && !incomingObserved) { incomingObserved = true; fs.writeFileSync(producer.file, "{}"); }
    return bytes;
  };
  let value; try { value = f.read({ maxRecords: 2 }); } finally { fs.readFileSync = read; }
  assert.equal(incomingObserved, true); assert.equal(lateBodyRead, true);
  assert.deepEqual(ids(value), [target.evidence.evidenceId, fallback.evidence.evidenceId]);
  const activity = found(value, target).savedActivity;
  assert.deepEqual(activity.states, []); assert.equal(activity.qualifierCount, 0); assert.equal(activity.unavailableQualifierCount, 1);
  assert.equal(value.unavailable.filter(item => item.evidenceId === producer.evidence.evidenceId).length, 1);
  assert.equal(value.coverage.unavailable, 1); assert.equal(value.omissions.byBudget, 0); account(value);
});

test("B selected owner drift still discards mixed work context instead of adopting hint authority", t => {
  const f = fixture(t), selected = f.save({ summary: "Work before owner drift", pending: ["X"] });
  const ownerFile = path.join(f.root, relativeProjectArtifact(f.storage, "sessions", "by-id"), f.session.sessionId, "current.json"), read = fs.readFileSync;
  let changed = false;
  fs.readFileSync = (file, ...args) => {
    const bytes = read(file, ...args);
    if (sameFile(file, selected.file) && !changed) {
      changed = true; const state = JSON.parse(read(ownerFile)); state.purpose = "Changed current purpose"; fs.writeFileSync(ownerFile, JSON.stringify(state));
    }
    return bytes;
  };
  let value; try { value = f.read(); } finally { fs.readFileSync = read; }
  assert.equal(changed, true); assert.equal(value.status, "work_context_basis_changed");
  assert.deepEqual(value.records, []); assert.equal(value.omissions.basisChanged, true); assert.equal(value.ordinaryWorkBlocked, false);
});

test("B changed discovery type is an unknown current failure, not an empty archive or an uninspected healthy hint", t => {
  const f = fixture(t), bad = saveAt(f, { summary: "Now a directory, not a work file" }, 0);
  for (let i = 1; i <= 10; i++) saveAt(f, { summary: "Untouched hinted tail " + i }, i);
  const latest = saveAt(f, { summary: "Intact latest result", pending: ["X"] }, 100);
  fs.unlinkSync(bad.file); fs.mkdirSync(bad.file);
  const value = immutableRead(f, { maxRecords: 1 });
  assert.deepEqual(ids(value), [latest.evidence.evidenceId]); assert.deepEqual(found(value, latest).content.pending, ["X"]);
  assert.equal(value.coverage.originals, 12); assert.equal(value.coverage.inspected, 2); assert.equal(value.coverage.valid, 1);
  assert.equal(value.coverage.unavailable, 1); assert.equal(value.omissions.uninspected, 10); assert.equal(value.omissions.byBudget, 0);
  assert.equal(value.unavailable.filter(item => item.evidenceId === bad.evidence.evidenceId).length, 1); account(value);
});

for (const ownObservation of [true, false]) test(`B observed producer failure stays sticky across healthy-hint fallback even after the failed file is restored (target own observation ${ownObservation})`, t => {
  const f = fixture(t), target = saveAt(f, { summary: "Selected target before fallback", pending: ["X"],
    ...(ownObservation ? { executionObservation: { state: "running" } } : {}) }, 1000);
  const producer = saveAt(f, { executionObservation: { state: "ended", target: exact(target) } }, 20);
  const healthy = saveAt(f, { summary: "Healthy candidate remains usable", pending: ["Independent pending"] }, 10);
  const producerBytes = fs.readFileSync(producer.file), { evidenceDigest, ...payload } = healthy.evidence;
  payload.recordedAt = "2026-01-01T00:00:15.000Z";
  healthy.evidence = { ...payload, evidenceDigest: sha(encoded(payload)) };
  assert.notEqual(healthy.evidence.evidenceDigest, evidenceDigest);
  fs.writeFileSync(healthy.file, JSON.stringify(healthy.evidence, null, 2) + "\n"); // Healthy external header drift contradicts only its historical hint.
  const read = fs.readFileSync; let producerReads = 0, restored = false, healthyAfterFailure = false;
  fs.readFileSync = (file, ...args) => {
    const bytes = read(file, ...args);
    if (sameFile(file, producer.file)) {
      producerReads++;
      if (producerReads === 1) {
        // Incoming self/owner/exact-target verification consumes these intact
        // returned bytes. The later body role must perform its own fresh read.
        assert.deepEqual(bytes, producerBytes); fs.writeFileSync(producer.file, "{}");
      } else if (producerReads === 2) {
        assert.equal(bytes.toString("utf8"), "{}");
        fs.writeFileSync(producer.file, producerBytes); restored = true;
        // Return the actually failed observation, not the newly restored bytes.
      }
    }
    if (sameFile(file, healthy.file) && producerReads === 2 && restored) healthyAfterFailure = true;
    return bytes;
  };
  let value; try { value = f.read({ maxRecords: 3 }); } finally { fs.readFileSync = read; }
  assert.equal(restored, true); assert.equal(healthyAfterFailure, true, "Healthy hint contradiction is observed after the producer's failed body observation");
  assert.equal(producerReads, 2, "The fixed-D fallback cannot reread and rehabilitate an already failed producer");
  assert.deepEqual(fs.readFileSync(producer.file), producerBytes);
  assert.deepEqual(ids(value), [target.evidence.evidenceId, healthy.evidence.evidenceId]); assert.equal(found(value, producer), undefined);
  assert.equal(found(value, healthy).evidenceDigest, healthy.evidence.evidenceDigest);
  const activity = found(value, target).savedActivity;
  assert.ok(activity, "Authenticated incoming qualifier loss must retain an overlay even on a plain target");
  assert.deepEqual(activity.states, []); assert.equal(activity.qualifierCount, 0); assert.equal(activity.qualifiers.length, 0);
  assert.equal(activity.unavailableQualifierCount, 1); assert.equal(activity.coverage, "partial");
  assert.deepEqual(found(value, target).content.pending, ["X"]);
  assert.equal(found(value, target).content.executionObservation?.state, ownObservation ? "running" : undefined);
  assert.equal(value.coverage.originals, 3); assert.equal(value.coverage.inspected, 3); assert.equal(value.coverage.valid, 2);
  assert.equal(value.coverage.unavailable, 1); assert.equal(value.coverage.included, 2);
  assert.equal(value.unavailable.filter(item => item.evidenceId === producer.evidence.evidenceId).length, 1);
  assert.equal(value.unavailable.length, 1); assert.equal(value.omissions.uninspected, 0); assert.equal(value.omissions.byBudget, 0);
  account(value, { fullScan: true });
});


test("F1 same owned byte observation hashes once; caller buffers, smaller bounds and new requests remain independent", t => {
  const f = fixture(t), relative = "f1-observed-source.txt", file = path.join(f.root, relative);
  const bytes = Buffer.from("F1 exact observed source ".repeat(256)); fs.writeFileSync(file, bytes);
  const owner = readSessionWorkEvidenceOwner({ root: f.root, sessionId: f.session.sessionId });
  const ref = { path: relative, kind: "source", digest: sha(bytes) }, context = createSessionWorkReadContext(f.root);
  const createHash = crypto.createHash; let matchingHashes = 0;
  crypto.createHash = function(...args) {
    const hash = createHash.apply(this, args), update = hash.update;
    hash.update = function(value, ...options) { if (Buffer.isBuffer(value) && value.equals(bytes)) matchingHashes++;
      return update.call(this, value, ...options); }; return hash;
  };
  try {
    assert.equal(inspectSessionWorkReference(owner, ref, { context }).status, "matching-current-bytes");
    const observed = readSessionWorkFileObservation(f.root, relative, bytes.length, context, { preflight: false });
    assert.equal(observed.digest, ref.digest); assert.deepEqual(observed.bytes, bytes);
    assert.equal(matchingHashes, 1, "Pure SHA calculation reuses exactly the retained observation, not a typed verdict");
    observed.bytes.fill(0); const caller = context.read(relative, bytes.length); caller.fill(1);
    assert.deepEqual(readSessionWorkFileObservation(f.root, relative, bytes.length, context).bytes, bytes);
    assert.equal(matchingHashes, 1);
    assert.throws(() => readSessionWorkFileObservation(f.root, relative, 8, context), { code: "SESSION_WORK_REFERENCE_UNAVAILABLE" });
    const changed = Buffer.alloc(bytes.length, 99); fs.writeFileSync(file, changed);
    assert.equal(readSessionWorkFileObservation(f.root, relative, bytes.length, context).digest, ref.digest,
      "Existing request observation remains sequential, not a fresh filesystem snapshot");
    const next = inspectSessionWorkReference(owner, ref, { context: createSessionWorkReadContext(f.root) });
    assert.equal(next.reasonCode, "SESSION_WORK_REFERENCE_CHANGED");
  } finally { crypto.createHash = createHash; }
});

test("F1 unknown or overridden contexts never supply a trusted digest memo", t => {
  const f = fixture(t), relative = "f1-custom-source.txt", bytes = Buffer.from("Original custom observation");
  fs.writeFileSync(path.join(f.root, relative), bytes);
  const owner = readSessionWorkEvidenceOwner({ root: f.root, sessionId: f.session.sessionId });
  const ref = { path: relative, kind: "source", digest: sha(bytes) };
  const context = createSessionWorkReadContext(f.root); context.read = () => Buffer.alloc(bytes.length, 0);
  assert.equal(inspectSessionWorkReference(owner, ref, { context }).reasonCode, "SESSION_WORK_REFERENCE_CHANGED");
  const custom = { read: () => Buffer.alloc(bytes.length, 1), digest: ref.digest };
  assert.notEqual(readSessionWorkFileObservation(f.root, relative, bytes.length, custom).digest, ref.digest);
});

test("F1 retention overflow still performs and hashes each fresh fallback observation", t => {
  const f = fixture(t), large = Buffer.alloc(16 * 1024 * 1024, 114), largeFile = path.join(f.root, "retained-0.bin");
  fs.writeFileSync(largeFile, large);
  const context = createSessionWorkReadContext(f.root);
  for (let i = 0; i < 8; i++) {
    const relative = "retained-" + i + ".bin";
    if (i) fs.linkSync(largeFile, path.join(f.root, relative));
    assert.equal(context.read(relative, large.length).length, large.length);
  }
  const relative = "overflow-reference.txt", file = path.join(f.root, relative), first = Buffer.from("fallback-before");
  fs.writeFileSync(file, first);
  const measured = rawReads(file, () => {
    const old = readSessionWorkFileObservation(f.root, relative, 1024, context);
    fs.writeFileSync(file, "fallback--after");
    const current = readSessionWorkFileObservation(f.root, relative, 1024, context, { preflight: false });
    assert.equal(old.digest, sha(first)); assert.notEqual(current.digest, old.digest);
    assert.equal(current.bytes.toString(), "fallback--after");
  });
  assert.equal(measured.reads, 2, "128MiB retention is not a new read gate or a cache-based currentness shortcut");
});

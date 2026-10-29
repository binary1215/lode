import { relativeProjectArtifact } from "../scripts/lib/project-storage-format.mjs";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { createHeadSession, sessionStatePath, withSessionRoute } from "../scripts/lib/session-routing.mjs";
import { enterConversationRecovery } from "../scripts/lib/compaction-lifecycle.mjs";
import { normalizeSessionWorkEvidence, recordSessionWorkEvidence, readSessionWorkContext } from "../scripts/lib/session-work-context.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
  ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, canonical(v[key])])) : v;
const encoded = (v) => JSON.stringify(canonical(v));
function project(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "head-recent-selection-")));
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, storage };
}
function atTime(time, callback) {
  const RealDate = globalThis.Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [time])); }
    static now() { return time; }
  };
  try { return callback(); } finally { globalThis.Date = RealDate; }
}
function save(root, input, index = 0) {
  return atTime(Date.parse("2026-01-01T00:00:00Z") + index * 1000,
    () => recordSessionWorkEvidence({ root, input }));
}
function snapshot(root) {
  const result = {};
  function visit(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) visit(file);
      else {
        const stat = fs.statSync(file);
        result[path.relative(root, file)] = [sha(fs.readFileSync(file)), stat.size, stat.mode, stat.mtimeMs];
      }
    }
  }
  visit(root);
  return result;
}
function accounting(value) {
  assert.equal(value.coverage.inspected, value.coverage.valid + value.coverage.unavailable);
  if (value.coverage.selection.includes("recent-results-with-bounded-explicit-citations-and-declared-roots")) {
    assert.ok(value.coverage.included <= value.coverage.valid);
    assert.ok(value.omissions.byBudget <= value.coverage.valid - value.coverage.included);
    assert.equal(value.omissions.uninspected, value.coverage.originals - value.coverage.inspected);
  } else assert.equal(value.coverage.valid, value.coverage.included + value.omissions.byBudget);
  assert.equal(value.coverage.usedCharacters, JSON.stringify(value.records).length);
  assert.equal(value.omissions.unavailableDetailCount, value.coverage.unavailable - value.unavailable.length);
  assert.equal(value.omissions.omittedIdCount, value.omissions.byBudget - value.omissions.evidenceIds.length);
  assert.ok(value.records.length <= value.coverage.maxRecords);
  assert.ok(JSON.stringify(value.records).length <= value.coverage.maxCharacters);
}

function navigationCases(root, storage) {
  const file = path.join(root, relativeProjectArtifact(storage, "graph-discovery", "index.json"));
  const raw = fs.readFileSync(file, "utf8"), legacy = JSON.parse(raw);
  assert.equal(legacy.sessionWorkNavigation?.version, 1);
  delete legacy.sessionWorkNavigation;
  return { restore() { fs.writeFileSync(file, raw); }, variants: ["hinted", "legacy", "missing"].map(mode => ({ mode, prepare() {
    if (mode === "missing") fs.unlinkSync(file);
    else fs.writeFileSync(file, mode === "hinted" ? raw : JSON.stringify(legacy));
  } })) };
}

test("global recent selection crosses 511/512/513/514 lexical boundaries; explicit pages and exact IDs retain their contracts", async (t) => {
  const { root, storage } = project(t), inspected = inspectProject(root);
  const inputs = Array.from({ length: 514 }, (_, i) => ({ summary: `Boundary evidence ${i}` }))
    .map((input) => ({ input, id: "work-evidence-" + sha(encoded({ projectId: inspected.project.projectId,
      sessionId: inspected.state.sessionId, content: normalizeSessionWorkEvidence(input) })).slice(0, 24) }))
    .sort((a, b) => a.id.localeCompare(b.id));
  for (let i = 0; i < inputs.length; i += 1) {
    assert.equal(save(root, inputs[i].input, i).evidence.evidenceId, inputs[i].id);
    if (i < 510) continue;
    const navigation = navigationCases(root, storage);
    for (const variant of navigation.variants) {
    variant.prepare();
    const before = snapshot(root), value = readSessionWorkContext({ root });
    const expected = inputs.slice(Math.max(0, i - 7), i + 1).reverse().map(({ id }) => id);
    assert.deepEqual(value.records.map((record) => record.evidenceId), expected, `size ${i + 1}`);
    const inspected = variant.mode === "hinted" ? 8 : i + 1;
    assert.equal(value.coverage.originals, i + 1);
    assert.equal(value.coverage.inspected, inspected);
    assert.equal(value.coverage.valid, inspected);
    assert.equal(value.coverage.unavailable, 0);
    assert.equal(value.omissions.uninspected, i + 1 - inspected);
    assert.match(value.coverage.selection, variant.mode === "hinted" ? /historical navigation hints/ : /all discovered originals canonically inspected once/);
    assert.equal(value.status, "work_context_partial"); // Verified history is larger than delivered bodies.
    assert.equal(value.nextAfterEvidenceId, null);
    assert.equal(value.omissions.byBudget, 0);
    assert.deepEqual(value.omissions.evidenceIds, []);
    accounting(value);
    const entry = (await enterConversationRecovery({ root }));
    assert.deepEqual(entry.workContext.records.map((record) => record.evidenceId), expected);
    assert.equal(entry.workContext.ordinaryWorkBlocked, false);
    assert.deepEqual(snapshot(root), before);
    }
    navigation.restore();
  }
  const before = snapshot(root);
  const page = readSessionWorkContext({ root, afterEvidenceId: inputs[0].id });
  assert.equal(page.coverage.inspected, 512);
  assert.equal(page.omissions.uninspected, 1);
  assert.equal(page.nextAfterEvidenceId, inputs[512].id);
  assert.deepEqual(page.records.map((record) => record.evidenceId), inputs.slice(505, 513).reverse().map(({ id }) => id));
  accounting(page);
  const lastPage = readSessionWorkContext({ root, afterEvidenceId: page.nextAfterEvidenceId });
  assert.deepEqual(lastPage.records.map((record) => record.evidenceId), [inputs[513].id]);
  assert.equal(lastPage.nextAfterEvidenceId, null);
  const exact = readSessionWorkContext({ root, evidenceIds: [inputs[0].id, inputs[513].id, inputs[0].id] });
  assert.equal(exact.coverage.inspected, 2);
  assert.equal(exact.coverage.originals, null);
  assert.equal(exact.omissions.uninspected, null);
  assert.deepEqual(exact.records.map((record) => record.evidenceId), [inputs[513].id, inputs[0].id]);
  accounting(exact);
  assert.deepEqual(snapshot(root), before);
});

test("timestamp ties use stable evidence IDs; exact retry retains the original recording time and bytes", (t) => {
  const { root, storage } = project(t), saved = ["a", "b", "c"].map((summary) => save(root, { summary }));
  const before = snapshot(root), retry = save(root, { summary: "b" }, 9000);
  assert.equal(retry.status, "session_work_evidence_reused");
  assert.equal(retry.writes, 0);
  assert.equal(retry.evidence.recordedAt, saved[1].evidence.recordedAt);
  const value = readSessionWorkContext({ root });
  assert.deepEqual(value.records.map((record) => record.evidenceId), saved.map(({ evidence }) => evidence.evidenceId).sort());
  accounting(value);
  assert.deepEqual(snapshot(root), before);
});

test("early/late/newest corrupt originals are isolated with bounded default samples and truthful totals", async (t) => {
  const { root, storage } = project(t), saved = Array.from({ length: 42 }, (_, i) => save(root, { summary: `Corruption ${i}` }, i));
  const sorted = [...saved].sort((a, b) => a.evidence.evidenceId.localeCompare(b.evidence.evidenceId));
  const intact = sorted.filter((record) => record !== saved.at(-1)).slice(20, 22);
  const bad = sorted.filter((record) => !intact.includes(record));
  for (const record of bad) fs.writeFileSync(record.file, "{\"tampered\":true}");
  const before = snapshot(root), value = readSessionWorkContext({ root });
  assert.equal(value.status, "work_context_partial");
  assert.equal(value.coverage.inspected, 42);
  assert.equal(value.coverage.unavailable, 40);
  assert.equal(value.coverage.valid, 2);
  assert.equal(value.unavailable.length, 32);
  assert.equal(value.omissions.unavailableDetailCount, 8);
  assert.deepEqual(value.records.map((record) => record.evidenceId).sort(), intact.map(({ evidence }) => evidence.evidenceId).sort());
  accounting(value);
  const exact = readSessionWorkContext({ root, evidenceIds: bad.map(({ evidence }) => evidence.evidenceId) });
  assert.equal(exact.unavailable.length, 40); // existing <=512 exact details are preserved
  assert.equal(exact.omissions.unavailableDetailCount, 0);
  accounting(exact);
  const entry = (await enterConversationRecovery({ root }));
  assert.equal(entry.ordinaryWorkBlocked, false);
  assert.equal(entry.workContext.coverage.unavailable, 40);
  assert.deepEqual(snapshot(root), before);
});

for (const change of ["timestamp", "disappear", "corrupt"]) {
  test(`fallback candidate ${change} between scan and reread is unavailable once, without suppressing older evidence`, (t) => {
    const { root, storage } = project(t), older = save(root, { summary: "Intact older" }), newest = save(root, { summary: "Newest" }, 1);
    // The canonical fallback still scans then rereads. Historical navigation
    // reads each selected original directly; it does not promise an atomic scan.
    navigationCases(root, storage).variants.find(variant => variant.mode === "legacy").prepare();
    const read = fs.readFileSync;
    let changed = false;
    fs.readFileSync = (file, ...args) => {
      const bytes = read(file, ...args);
      if (file === newest.file && !changed) {
        changed = true;
        if (change === "disappear") fs.unlinkSync(file);
        else if (change === "corrupt") fs.writeFileSync(file, "{}");
        else {
          const { evidenceDigest, ...payload } = newest.evidence;
          payload.recordedAt = "2026-01-02T00:00:00.000Z";
          fs.writeFileSync(file, JSON.stringify({ ...payload, evidenceDigest: sha(encoded(payload)) }));
        }
      }
      return bytes;
    };
    let value;
    try { value = readSessionWorkContext({ root }); } finally { fs.readFileSync = read; }
    assert.equal(changed, true);
    assert.equal(value.coverage.inspected, 2);
    assert.equal(value.coverage.unavailable, 1);
    assert.equal(value.unavailable.length, 1);
    assert.equal(value.unavailable[0].reasonCode, change === "timestamp" ? "SESSION_WORK_OBSERVATION_CHANGED"
      : change === "disappear" ? "ENOENT" : "INVALID_SESSION_WORK_EVIDENCE");
    assert.deepEqual(value.records.map((record) => record.evidenceId), [older.evidence.evidenceId]);
    accounting(value);
  });
}

for (const change of ["timestamp", "disappear", "corrupt"]) {
  test(`hinted candidate ${change} before canonical read uses current bytes, not historical proof`, (t) => {
    const { root, storage } = project(t), older = save(root, { summary: "Intact older" }), newest = save(root, { summary: "Newest" }, 1);
    const read = fs.readFileSync;
    let changed = false;
    fs.readFileSync = (file, ...args) => {
      if (file === newest.file && !changed) {
        changed = true;
        if (change === "disappear") fs.unlinkSync(file);
        else if (change === "corrupt") fs.writeFileSync(file, "{}");
        else {
          const { evidenceDigest, ...payload } = newest.evidence;
          payload.recordedAt = "2026-01-02T00:00:00.000Z";
          fs.writeFileSync(file, JSON.stringify({ ...payload, evidenceDigest: sha(encoded(payload)) }));
        }
      }
      return read(file, ...args);
    };
    let value;
    try { value = readSessionWorkContext({ root }); } finally { fs.readFileSync = read; }
    assert.equal(changed, true);
    assert.equal(value.coverage.inspected, 2);
    if (change === "timestamp") {
      // A valid current original contradicts an old hint, not its own digest.
      assert.equal(value.coverage.unavailable, 0);
      assert.equal(value.records[0].recordedAt, "2026-01-02T00:00:00.000Z");
      assert.deepEqual(value.records.map(record => record.evidenceId), [newest.evidence.evidenceId, older.evidence.evidenceId]);
      assert.match(value.coverage.selection, /all discovered originals canonically inspected once/);
    } else {
      assert.equal(value.coverage.unavailable, 1);
      assert.equal(value.unavailable.length, 1);
      assert.equal(value.unavailable[0].reasonCode, change === "disappear" ? "ENOENT" : "INVALID_SESSION_WORK_EVIDENCE");
      assert.deepEqual(value.records.map(record => record.evidenceId), [older.evidence.evidenceId]);
    }
    accounting(value);
  });
}

test("full output and bare-size exclusions avoid reference reads; enriched overflow still considers older fitting work", (t) => {
  const { root, storage } = project(t), body = Buffer.alloc(1024 * 1024, 120), source = path.join(root, "retained-source.txt");
  fs.writeFileSync(source, body);
  const ref = { path: "retained-source.txt", digest: sha(body), kind: "source" };
  const older = save(root, { summary: "Small older" });
  const referenced = save(root, { summary: "Referenced candidate", references: [ref] }, 1);
  const big = save(root, { summary: "Large newest " + "x".repeat(12000), references: [ref] }, 2);
  const before = snapshot(root), read = fs.readFileSync;
  let referenceReads = 0;
  fs.readFileSync = (file, ...args) => { if (file === source) referenceReads += 1; return read(file, ...args); };
  try {
    const tiny = readSessionWorkContext({ root, maxCharacters: 2 });
    assert.equal(referenceReads, 0);
    assert.equal(tiny.records.length, 0);
    assert.equal(tiny.omissions.byBudget, 3);
    accounting(tiny);
    const bare = JSON.stringify([{ ...referenced.evidence, references: [] }]).length;
    const selected = readSessionWorkContext({ root, maxCharacters: bare + 1 });
    assert.equal(referenceReads, 1); // big skipped before enrichment, referenced fails after enrichment
    assert.deepEqual(selected.records.map((record) => record.evidenceId), [older.evidence.evidenceId]);
    assert.equal(selected.omissions.byBudget, 2);
    accounting(selected);
    referenceReads = 0;
    const full = readSessionWorkContext({ root, maxRecords: 1 });
    assert.equal(referenceReads, 1); // no enrichment of the older reference after maxRecords is filled
    assert.deepEqual(full.records.map((record) => record.evidenceId), [big.evidence.evidenceId]);
    assert.equal(full.records[0].references[0].status, "matching-current-bytes");
    accounting(full);
  } finally { fs.readFileSync = read; }
  assert.deepEqual(snapshot(root), before);
});

test("selected Session isolation and P2 basis changes remain enforced during global selection", async (t) => {
  const { root, storage } = project(t), a = createHeadSession({ root, purpose: "A only" }), b = createHeadSession({ root, purpose: "B only" });
  let saved;
  withSessionRoute(root, a.sessionId, () => { saved = save(root, { summary: "Only A" }); });
  const before = snapshot(root);
  withSessionRoute(root, b.sessionId, () => {
    assert.equal(readSessionWorkContext({ root }).status, "work_context_not_recorded");
    const exact = readSessionWorkContext({ root, evidenceIds: [saved.evidence.evidenceId] });
    assert.equal(exact.unavailable[0].reasonCode, "ENOENT");
  });
  (await withSessionRoute(root, a.sessionId, async () => {
    assert.equal((await enterConversationRecovery({ root })).workContext.records[0].evidenceId, saved.evidence.evidenceId);
    assert.equal(readSessionWorkContext({ root, expectedSessionId: b.sessionId }).status, "work_context_basis_changed");
    assert.equal(readSessionWorkContext({ root, expectedCheckpointId: "missing" }).status, "work_context_basis_changed");
  }));
  assert.deepEqual(snapshot(root), before);
  withSessionRoute(root, a.sessionId, () => {
    const read = fs.readFileSync, file = sessionStatePath(root);
    let changed = false;
    fs.readFileSync = (name, ...args) => {
      const bytes = read(name, ...args);
      if (name === saved.file && !changed) {
        changed = true;
        const state = JSON.parse(read(file, "utf8"));
        fs.writeFileSync(file, JSON.stringify({ ...state, purpose: "Changed P2 basis" }));
      }
      return bytes;
    };
    let value;
    try { value = readSessionWorkContext({ root }); } finally { fs.readFileSync = read; }
    assert.equal(changed, true);
    assert.equal(value.status, "work_context_basis_changed");
    assert.deepEqual(value.records, []);
  });
});

test("enumeration is sequential, and originals published after it are discovered on the next read", (t) => {
  const { root, storage } = project(t), older = save(root, { summary: "Before enumeration" });
  const readdir = fs.readdirSync;
  let newest;
  fs.readdirSync = (dir, ...args) => {
    const names = readdir(dir, ...args);
    if (path.basename(dir) === "work-evidence" && !newest) newest = save(root, { summary: "After enumeration" }, 1);
    return names;
  };
  let value;
  try { value = readSessionWorkContext({ root }); } finally { fs.readdirSync = readdir; }
  assert.equal(value.coverage.inspected, 1);
  assert.deepEqual(value.records.map((record) => record.evidenceId), [older.evidence.evidenceId]);
  assert.equal(readSessionWorkContext({ root }).records[0].evidenceId, newest.evidence.evidenceId);
});

test("existing bound/cursor validation and exact missing-ID details are unchanged", (t) => {
  const { root, storage } = project(t), missing = "work-evidence-" + "0".repeat(24);
  for (const input of [{ maxRecords: 0 }, { maxRecords: 513 }, { maxCharacters: 1 }, { maxCharacters: 512 * 1024 + 1 },
    { afterEvidenceId: "" }, { afterEvidenceId: "start" }, { evidenceIds: [], afterEvidenceId: missing },
    { evidenceIds: Array(513).fill(missing) }]) {
    assert.throws(() => readSessionWorkContext({ root, ...input }), { code: "INVALID_SESSION_WORK_EVIDENCE" });
  }
  const exact = readSessionWorkContext({ root, evidenceIds: [missing] });
  assert.equal(exact.unavailable[0].reasonCode, "ENOENT");
  accounting(exact);
});

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeProject, inspectProject } from "../../scripts/lib/head-core.mjs";
import { createHeadSession, withSessionRoute } from "../../scripts/lib/session/session-routing.mjs";
import { recordSessionWorkEvidence, readSessionWorkContext } from "../../scripts/lib/session/session-work-context.mjs";

// Synthetic local originals only. No native provider, model, or process fixture.
export const pluginRoot = path.resolve(import.meta.dirname, "../..");
export const sha = value => crypto.createHash("sha256").update(value).digest("hex");
export const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const encoded = value => JSON.stringify(canonical(value));
export const exact = saved => ({ evidenceId: saved.evidence.evidenceId, evidenceDigest: saved.evidence.evidenceDigest });
export const link = (root, predecessor = root) => ({ root: exact(root), predecessor: exact(predecessor) });
export function snapshot(base) {
  const files = {};
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else {
        const stat = fs.lstatSync(file);
        files[path.relative(base, file)] = { digest: sha(fs.readFileSync(file)), size: stat.size, mode: stat.mode, mtimeMs: stat.mtimeMs };
      }
    }
  };
  walk(base);
  return files;
}
export function fixture(t, purpose = "Synthetic local investigation; no external effects") {
  const temporaryRoot = process.env.HEAD_AGENT_TEST_TMP || os.tmpdir();
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const base = fs.realpathSync(fs.mkdtempSync(path.join(temporaryRoot, "head-work-linkage-")));
  const root = path.join(base, "project"), operational = path.join(base, "host");
  fs.mkdirSync(root);
  initializeProject({ root, pluginRoot, runtimes: ["codex", "claude", "opencode"] });
  const owner = inspectProject(root), layout = owner.storage;
  assert.equal(layout.projectRoot, fs.realpathSync(root));
  assert.equal(layout.projectId, owner.project.projectId);
  assert.equal(layout.dialect, "lode");
  assert.equal(layout.directory, ".lode");
  assert.equal(layout.projectFile, path.join(root, ".lode", "project.json"));
  assert.equal(fs.existsSync(path.join(root, ".head", "project.json")), false);
  const session = createHeadSession({ root, purpose });
  if (process.env.HEAD_AGENT_KEEP_TEST_TMP !== "1") t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  let occurrence = 0;
  const route = callback => withSessionRoute(root, session.sessionId, callback);
  return { base, root, owner, layout, storage: layout, operational, session, route,
    save(input) {
      const RealDate = globalThis.Date, time = Date.parse("2026-01-01T00:00:00Z") + occurrence++ * 1000;
      globalThis.Date = class extends RealDate {
        constructor(...args) { super(...(args.length ? args : [time])); }
        static now() { return time; }
      };
      try { return route(() => recordSessionWorkEvidence({ root, input })); }
      finally { globalThis.Date = RealDate; }
    },
    read(options = {}) { return route(() => readSessionWorkContext({ root, ...options })); },
  };
}
export function citation(f, saved) {
  return { path: path.relative(f.root, saved.file).replaceAll("\\", "/"), digest: sha(fs.readFileSync(saved.file)), kind: "artifact" };
}
export function representative(f) {
  const root = f.save({ summary: "INITIAL ANCHOR: inspect the synthetic cache" });
  const judgment = f.save({ judgments: [{ assessment: "Use path B", reason: "EXACT REASON: A loses retained provenance", alternatives: ["Alternative A: rebuild everything"] }] });
  for (let i = 0; i < 10; i += 1) f.save({ summary: `Unrelated historical tail ${i}` });
  const running = f.save({ summary: "Earlier running note", workLink: link(root), executionObservation: { state: "running" } });
  const ended = f.save({ summary: "LATEST RESULT: bounded attempt observed ended", pending: ["X remains"], unknowns: ["External effect remains unverified"],
    workLink: link(root, running), executionObservation: { state: "ended", target: exact(running) }, references: [citation(f, judgment)] });
  return { root, judgment, running, ended };
}
export function accounting(value, maxRecords = value.coverage.maxRecords, maxCharacters = value.coverage.maxCharacters) {
  assert.ok(value.records.length <= maxRecords);
  assert.ok(JSON.stringify(value.records).length <= maxCharacters);
  assert.equal(value.coverage.usedCharacters, JSON.stringify(value.records).length);
  assert.equal(value.coverage.inspected, value.coverage.valid + value.coverage.unavailable);
  if (value.coverage.selection.includes("recent-results-with-bounded-explicit-citations-and-declared-roots")) {
    assert.ok(value.coverage.included <= value.coverage.valid);
    assert.ok(value.omissions.byBudget <= value.coverage.valid - value.coverage.included);
    assert.equal(value.omissions.uninspected, value.coverage.originals - value.coverage.inspected);
    assert.equal(value.coverage.inspected, value.coverage.originals);
  } else assert.equal(value.coverage.valid, value.coverage.included + value.omissions.byBudget);
  assert.equal(value.coverage.included, value.records.length);
  assert.equal(new Set(value.records.map(record => record.evidenceId)).size, value.records.length);
}
export const recordFor = (value, saved) => value.records.find(record => record.evidenceId === saved.evidence.evidenceId);

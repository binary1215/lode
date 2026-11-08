import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureWorkerSourceBasis } from "../scripts/lib/worker-source-basis.mjs";
import { buildWorkerPatchCandidate, captureWorkerWriteBasis } from "../scripts/lib/worker-patch-basis.mjs";
import { composeWorkerPatchCandidates } from "../scripts/lib/worker-patch-composition.mjs";
import { observeWorkerIntegrationReadBasis, readWorkerIntegrationBasis } from "../scripts/lib/worker-integration-basis.mjs";

console.log(
  JSON.stringify({
    event: "owned-worker-integration-basis-test",
    pid: process.pid,
    parentPid: process.ppid,
    command: process.execPath,
    args: process.argv.slice(1),
    cwd: process.cwd(),
    ports: [],
    actualProviderInvoked: false,
  }),
);

function fixture(t) {
  const parent = fs.realpathSync(process.env.HEAD_AGENT_TEST_TMP || os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, "head-integration-basis-"));
  fs.writeFileSync(path.join(root, "a.txt"), "original A");
  fs.writeFileSync(path.join(root, "b.txt"), "dependency B");
  fs.mkdirSync(path.join(root, ".head"));
  fs.writeFileSync(path.join(root, ".head", "p2-sentinel.json"), '{"unchanged":true}\n');
  fs.mkdirSync(path.join(root, ".lode"));
  fs.writeFileSync(path.join(root, ".lode", "p2-sentinel.json"), '{"unchanged":true}\n');
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.match(path.basename(root), /^head-integration-basis-/);
    for (const file of ["a.txt", "b.txt"])
      if (fs.statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile()) fs.chmodSync(path.join(root, file), 0o600);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const sourceBasis = captureWorkerSourceBasis({ root, paths: ["a.txt", "b.txt"], maxBytes: 4096 });
  const dependency = {
    memberIndex: 0,
    authorizationId: `execution-authorization-${"a".repeat(24)}`,
    authorizationHash: "b".repeat(64),
    sourceBasis,
    maxBytes: 4096,
  };
  const basis = captureWorkerWriteBasis({ root, paths: ["a.txt"], maxBytes: 4096 });
  const candidate = buildWorkerPatchCandidate({
    basis,
    maxBytes: 4096,
    changes: [{ path: "a.txt", after: { mode: basis[0].mode, contentBase64: Buffer.from("expected A").toString("base64") } }],
  });
  const patches = composeWorkerPatchCandidates({ candidates: [candidate], maxBytes: 8192 }).patches;
  const observe = (options = {}) => observeWorkerIntegrationReadBasis({ root, dependencies: [dependency], patches, ...options });
  return { root, dependency, patches, observe };
}

const entry = (view, relative) => view.dependencies.find((item) => item.path === relative);

test("selected source and integration effects remain distinct read-only evidence", (t) => {
  const f = fixture(t);
  const before = f.observe();
  assert.equal(before.status, "stable-observation");
  assert.equal(before.lineageVerified, false);
  assert.equal(before.headReassessmentRequired, false);
  assert.equal(before.requiresWholeResultVerification, true);
  assert.equal(entry(before, "a.txt").status, "original-basis-present");
  assert.equal(entry(before, "b.txt").status, "original-basis-present");
  assert.deepEqual(f.observe(), before);
  fs.writeFileSync(path.join(f.root, "a.txt"), "expected A");
  const after = f.observe();
  assert.equal(entry(after, "a.txt").status, "integration-postimage-present");
  assert.equal(after.appliedByThisOperation, false);
  assert.equal(after.semanticVerification, "not-assessed");
  assert.equal(after.reviewDecisionCreated, false);
  assert.equal(after.mutatesCanon, false);
  assert.equal(after.observation.atomicSnapshot, false);
  assert.equal(after.observation.detectsABA, false);
  assert.notEqual(after.observedBasisDigest, before.observedBasisDigest);
  assert.notEqual(after.basisDigest, before.basisDigest);
  assert.equal(fs.readFileSync(path.join(f.root, ".head/p2-sentinel.json"), "utf8"), '{"unchanged":true}\n');
  assert.deepEqual(fs.readdirSync(path.join(f.root, ".head")), ["p2-sentinel.json"]);
  assert.equal(fs.readFileSync(path.join(f.root, ".lode/p2-sentinel.json"), "utf8"), '{"unchanged":true}\n');
  assert.deepEqual(fs.readdirSync(path.join(f.root, ".lode")), ["p2-sentinel.json"]);
  assert.ok(!JSON.stringify(after).includes("contentBase64"));
});

test("external read-dependency drift and deletion are advisory reassessment, not permanent gates", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "b.txt"), "fresh external dependency");
  const drift = f.observe();
  assert.equal(drift.status, "stable-observation");
  assert.equal(entry(drift, "b.txt").status, "external-dependency-drift");
  assert.equal(drift.headReassessmentRequired, true);
  assert.equal(drift.allDependenciesObservable, true);
  fs.unlinkSync(path.join(f.root, "b.txt"));
  assert.equal(entry(f.observe(), "b.txt").status, "absent");
  fs.writeFileSync(path.join(f.root, "b.txt"), "dependency B");
  assert.equal(f.observe().headReassessmentRequired, false);
});

test("different original member bases are retained without creating ownership reservations", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "b.txt"), "newer B");
  const second = {
    ...f.dependency,
    memberIndex: 1,
    authorizationId: `execution-authorization-${"c".repeat(24)}`,
    sourceBasis: captureWorkerSourceBasis({ root: f.root, paths: ["b.txt"], maxBytes: 4096 }),
  };
  const observed = f.observe({ dependencies: [f.dependency, second] });
  assert.equal(entry(observed, "b.txt").status, "external-dependency-drift");
  assert.deepEqual(entry(observed, "b.txt").matchesOriginalMemberIndices, [1]);
  const absentBasis = captureWorkerWriteBasis({ root: f.root, paths: ["unused"], maxBytes: 4096 });
  const noop = buildWorkerPatchCandidate({ basis: absentBasis, changes: [], maxBytes: 4096 });
  const newBasis = captureWorkerWriteBasis({ root: f.root, paths: ["unused/new.txt"], maxBytes: 4096 });
  const creation = buildWorkerPatchCandidate({
    basis: newBasis,
    maxBytes: 4096,
    changes: [{ path: "unused/new.txt", after: { mode: 0o666, contentBase64: Buffer.from("new").toString("base64") } }],
  });
  const composed = composeWorkerPatchCandidates({ candidates: [noop, creation], maxBytes: 4096 });
  const view = f.observe({ dependencies: [f.dependency, second], patches: composed.patches });
  assert.equal(
    view.dependencies.some((item) => item.path === "unused"),
    false,
  );
  assert.equal(entry(view, "unused/new.txt").status, "integration-preimage-present");
  assert.equal(fs.existsSync(path.join(f.root, "unused")), false);
});

test("unsafe, oversized and directory replacements remain bounded unobservable evidence", (t) => {
  const f = fixture(t);
  fs.linkSync(path.join(f.root, "b.txt"), path.join(f.root, "alias.txt"));
  assert.equal(entry(f.observe(), "b.txt").status, "unverifiable");
  fs.unlinkSync(path.join(f.root, "alias.txt"));
  fs.writeFileSync(path.join(f.root, "b.txt"), "x".repeat(4097));
  assert.equal(f.observe().allDependenciesObservable, false);
  fs.unlinkSync(path.join(f.root, "b.txt"));
  fs.mkdirSync(path.join(f.root, "b.txt"));
  assert.equal(entry(f.observe(), "b.txt").status, "unverifiable");
});

test("effect mode drift is visible while read-only spelling aliases add no ownership gate", (t) => {
  const f = fixture(t);
  fs.chmodSync(path.join(f.root, "a.txt"), 0o444);
  const drift = f.observe();
  assert.equal(entry(drift, "a.txt").status, "external-dependency-drift");
  assert.equal(entry(drift, "a.txt").expectedPreimagePresent, false);
  fs.chmodSync(path.join(f.root, "a.txt"), f.patches[0].before.mode);
  if (process.platform === "win32") {
    const alias = {
      ...f.dependency,
      memberIndex: 1,
      authorizationId: `execution-authorization-${"d".repeat(24)}`,
      sourceBasis: captureWorkerSourceBasis({ root: f.root, paths: ["A.txt"], maxBytes: 4096 }),
    };
    const observed = f.observe({ dependencies: [f.dependency, alias] });
    assert.equal(observed.status, "stable-observation");
    assert.equal(entry(observed, "a.txt").status, "original-basis-present");
    assert.deepEqual(
      entry(observed, "a.txt").originals.map((item) => item.sourcePath),
      ["a.txt", "A.txt"],
    );
  }
});

test("repeat observation detects changed bytes and same-byte inode replacement", (t) => {
  for (const mutation of ["bytes", "identity"]) {
    const f = fixture(t);
    const originalOpen = fs.openSync;
    let captures = 0;
    fs.openSync = function (file, ...args) {
      if (file === path.join(f.root, "a.txt") && ++captures === 2) {
        if (mutation === "bytes") fs.writeFileSync(path.join(f.root, "b.txt"), "changed between passes");
        else {
          fs.renameSync(path.join(f.root, "b.txt"), path.join(f.root, "retained-b.txt"));
          fs.writeFileSync(path.join(f.root, "b.txt"), "dependency B");
        }
      }
      return originalOpen.call(this, file, ...args);
    };
    let result;
    try {
      result = f.observe();
    } finally {
      fs.openSync = originalOpen;
    }
    assert.equal(result.status, "observation-conflict");
    assert.equal(entry(result, "b.txt").status, "conflict");
    assert.equal(result.headReassessmentRequired, true);
  }
});

test("unrelated namespace change is not a whole-project reservation", (t) => {
  const f = fixture(t);
  const originalOpen = fs.openSync;
  let changed = false;
  fs.openSync = function (file, ...args) {
    if (!changed && file === path.join(f.root, "a.txt")) {
      changed = true;
      fs.writeFileSync(path.join(f.root, "unrelated.txt"), "not a selected dependency");
    }
    return originalOpen.call(this, file, ...args);
  };
  let observed;
  try {
    observed = f.observe();
  } finally {
    fs.openSync = originalOpen;
  }
  assert.equal(observed.status, "stable-observation");
  assert.equal(observed.headReassessmentRequired, false);
});

test("unbounded input, duplicate member, forged bytes and missing stored intent fail without writes", (t) => {
  const f = fixture(t);
  for (const maxBytes of [undefined, NaN, Infinity, -1]) {
    assert.throws(() => f.observe({ dependencies: [{ ...f.dependency, maxBytes }] }), { code: "WORKER_INTEGRATION_BASIS_INVALID" });
  }
  assert.throws(() => f.observe({ dependencies: [f.dependency, f.dependency] }), { code: "WORKER_INTEGRATION_BASIS_INVALID" });
  const tampered = structuredClone(f.dependency);
  tampered.sourceBasis[0].contentBase64 = Buffer.from("forged").toString("base64");
  assert.throws(() => f.observe({ dependencies: [tampered] }), { code: "INVALID_WORKER_SOURCE_BASIS" });
  assert.throws(() => readWorkerIntegrationBasis({ root: f.root, integrationId: `worker-integration-${"e".repeat(24)}--${"f".repeat(24)}` }), {
    code: "ENOENT",
  });
  assert.throws(() => readWorkerIntegrationBasis({ root: f.root, integrationId: `worker-integration-${"e".repeat(24)}` }), {
    code: "WORKER_PATCH_INTEGRATION_CONFLICT",
  });
  assert.deepEqual(fs.readdirSync(path.join(f.root, ".head")), ["p2-sentinel.json"]);
  assert.equal(fs.readFileSync(path.join(f.root, ".lode/p2-sentinel.json"), "utf8"), '{"unchanged":true}\n');
  assert.deepEqual(fs.readdirSync(path.join(f.root, ".lode")), ["p2-sentinel.json"]);
});

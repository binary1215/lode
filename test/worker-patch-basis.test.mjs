import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  captureWorkerWriteBasis,
  verifyWorkerWriteBasis,
  buildWorkerPatchCandidate,
  verifyWorkerPatchCandidate,
  inspectWorkerPatchCandidate,
} from "../scripts/lib/worker-patch-basis.mjs";

console.log(
  JSON.stringify({
    event: "owned-worker-patch-test",
    pid: process.pid,
    parentPid: process.ppid,
    command: process.execPath,
    args: process.argv.slice(1),
    cwd: process.cwd(),
    ports: [],
    actualProviderInvoked: false,
  }),
);
const content = (value) => Buffer.from(value).toString("base64");
function fixture(t) {
  const parent = fs.realpathSync(process.env.HEAD_AGENT_TEST_TMP || os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, "head-patch-basis-"));
  fs.writeFileSync(path.join(root, "a.txt"), "dirty initial A\r\n");
  fs.writeFileSync(path.join(root, "b.txt"), "untracked B");
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.match(path.basename(root), /^head-patch-basis-/);
    for (const file of ["a.txt", "b.txt"]) if (fs.existsSync(path.join(root, file))) fs.chmodSync(path.join(root, file), 0o600);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const basis = captureWorkerWriteBasis({ root, paths: ["a.txt", "b.txt", "new/file.txt"], maxBytes: 4096 });
  return { root, basis, mode: basis[0].mode };
}

test("write basis retains file type/mode/bytes and missing targets without mutating them", (t) => {
  const f = fixture(t);
  assert.equal(f.basis[0].kind, "file");
  assert.equal(f.basis[0].contentBase64, content("dirty initial A\r\n"));
  assert.equal(f.basis[1].contentBase64, content("untracked B"));
  assert.deepEqual(f.basis[2], { path: "new/file.txt", kind: "absent" });
  verifyWorkerWriteBasis(f.basis, 4096);
  assert.equal(fs.existsSync(path.join(f.root, "new")), false);
});

test("partial pre/post reconciliation is per path and never implies whole execution success", (t) => {
  const f = fixture(t);
  const candidate = buildWorkerPatchCandidate({
    basis: f.basis,
    maxBytes: 4096,
    changes: [
      { path: "a.txt", after: { mode: f.mode, contentBase64: content("after A") } },
      { path: "b.txt", after: { mode: f.basis[1].mode, contentBase64: content("after B") } },
    ],
  });
  verifyWorkerPatchCandidate(candidate);
  const inspect = () => inspectWorkerPatchCandidate({ root: f.root, candidate });
  assert.deepEqual(
    inspect().paths.map((p) => p.status),
    ["preimage-present", "preimage-present"],
  );
  fs.writeFileSync(path.join(f.root, "a.txt"), "after A");
  assert.deepEqual(
    inspect().paths.map((p) => p.status),
    ["postimage-present", "preimage-present"],
  );
  fs.writeFileSync(path.join(f.root, "b.txt"), "after B");
  assert.equal(inspect().allPostimagesPresent, true);
  assert.equal(inspect().appliedByThisOperation, false);
  assert.equal(inspect().semanticVerification, "not-assessed");
  fs.writeFileSync(path.join(f.root, "a.txt"), "user edited after application");
  assert.deepEqual(
    inspect().paths.map((p) => p.status),
    ["conflict", "postimage-present"],
  );
  assert.equal(fs.readFileSync(path.join(f.root, "a.txt"), "utf8"), "user edited after application");
});

test("creation, deletion and rename-shaped candidates preserve destination conflicts", (t) => {
  const f = fixture(t);
  const candidate = buildWorkerPatchCandidate({
    basis: f.basis,
    maxBytes: 4096,
    changes: [
      { path: "a.txt", after: null },
      { path: "new/file.txt", after: { mode: f.mode, contentBase64: f.basis[0].contentBase64 } },
    ],
  });
  fs.mkdirSync(path.join(f.root, "new"));
  fs.writeFileSync(path.join(f.root, "new/file.txt"), "user won the destination");
  const state = inspectWorkerPatchCandidate({ root: f.root, candidate });
  assert.deepEqual(
    state.paths.map((p) => p.status),
    ["preimage-present", "conflict"],
  );
  fs.unlinkSync(path.join(f.root, "new/file.txt"));
  fs.mkdirSync(path.join(f.root, "new/file.txt"));
  assert.equal(inspectWorkerPatchCandidate({ root: f.root, candidate }).paths[1].reason, "unverifiable-target");
  assert.equal(fs.readFileSync(path.join(f.root, "a.txt"), "utf8"), "dirty initial A\r\n");
});

test("unowned paths, altered basis/digest, oversized postimages and aliases fail", (t) => {
  const f = fixture(t);
  const changes = [{ path: "a.txt", after: { mode: f.mode, contentBase64: content("after") } }];
  assert.throws(() => buildWorkerPatchCandidate({ basis: f.basis, maxBytes: 4096, changes: [{ ...changes[0], path: "outside.txt" }] }), {
    code: "WORKER_PATCH_CONFLICT",
  });
  const candidate = buildWorkerPatchCandidate({ basis: f.basis, maxBytes: 4096, changes });
  const tampered = structuredClone(candidate);
  tampered.patches[0].before.kind = "absent";
  assert.throws(() => verifyWorkerPatchCandidate(tampered), { code: "WORKER_PATCH_CONFLICT" });
  assert.throws(
    () =>
      buildWorkerPatchCandidate({
        basis: f.basis,
        maxBytes: 4096,
        changes: [{ path: "a.txt", after: { mode: f.mode, contentBase64: content("x".repeat(4097)) } }],
      }),
    { code: "WORKER_PATCH_CONFLICT" },
  );
  if (process.platform === "win32") {
    assert.throws(() => captureWorkerWriteBasis({ root: f.root, paths: ["a.txt", "A.txt"], maxBytes: 4096 }), { code: "WORKER_PATCH_CONFLICT" });
    assert.throws(() => captureWorkerWriteBasis({ root: f.root, paths: ["NUL.txt"], maxBytes: 4096 }), { code: "WORKER_PATCH_CONFLICT" });
  }
});

test("mode drift and hardlinked replacement are not accepted as unchanged bytes", (t) => {
  const f = fixture(t);
  const candidate = buildWorkerPatchCandidate({ basis: f.basis, maxBytes: 4096, changes: [{ path: "a.txt", after: null }] });
  const file = path.join(f.root, "a.txt");
  fs.chmodSync(file, 0o444);
  assert.equal(inspectWorkerPatchCandidate({ root: f.root, candidate }).paths[0].status, "conflict");
  fs.chmodSync(file, f.mode);
  fs.linkSync(file, path.join(f.root, "alias.txt"));
  assert.equal(inspectWorkerPatchCandidate({ root: f.root, candidate }).paths[0].reason, "unverifiable-target");
});

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { buildWorkerPatchCandidate } from "../scripts/lib/worker/worker-patch-basis.mjs";
import { composeWorkerPatchCandidates } from "../scripts/lib/worker/worker-patch-composition.mjs";

console.log(
  JSON.stringify({
    event: "owned-worker-composition-test",
    pid: process.pid,
    parentPid: process.ppid,
    command: process.execPath,
    args: process.argv.slice(1),
    cwd: process.cwd(),
    ports: [],
    actualProviderInvoked: false,
  }),
);
function candidate(relative, before, after) {
  const bytes = before === null ? null : Buffer.from(before);
  const basis = [
    bytes === null
      ? { path: relative, kind: "absent" }
      : {
          path: relative,
          kind: "file",
          mode: 0o644,
          digest: crypto.createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.length,
          contentBase64: bytes.toString("base64"),
        },
  ];
  return buildWorkerPatchCandidate({
    basis,
    changes: [{ path: relative, after: after === null ? null : { mode: 0o644, contentBase64: Buffer.from(after).toString("base64") } }],
    maxBytes: 4096,
  });
}
const compose = (candidates) => composeWorkerPatchCandidates({ candidates, maxBytes: 8192 });

test("disjoint worker effects compose without implying authority or semantic success", () => {
  const a = candidate("a.txt", "a", "aa");
  const b = candidate("b.txt", null, "bb");
  const result = compose([b, a]);
  assert.equal(result.status, "compatible-file-effects");
  assert.deepEqual(
    result.patches.map((patch) => patch.memberIndices),
    [[1], [0]],
  );
  assert.equal(result.applied, false);
  assert.equal(result.lineageVerified, false);
  assert.equal(result.currentBasisVerified, false);
  assert.equal(result.recoveryAuthority, false);
  assert.equal(result.semanticVerification, "not-assessed");
  result.patches[0].before.contentBase64 = "tamper";
  assert.notEqual(result.patches[0].before.contentBase64, a.patches[0].before.contentBase64);
});

test("identical effects coalesce without dropping either candidate provenance", () => {
  const a = candidate("a.txt", "a", "aa");
  const result = compose([a, structuredClone(a)]);
  assert.equal(result.patches.length, 1);
  assert.deepEqual(result.patches[0].memberIndices, [0, 1]);
  assert.deepEqual(result.candidateHashes, [a.candidateHash, a.candidateHash]);
  assert.equal(result.bytes, 3);
});

test("different write bases, divergent edits and deletion versus edit remain conflicts", () => {
  for (const [a, b, reason] of [
    [candidate("a", null, "x"), candidate("a", "", "x"), "different-preimages"],
    [candidate("a", "old", "x"), candidate("a", "old", "y"), "different-postimages"],
    [candidate("a", "old", null), candidate("a", "old", "y"), "different-postimages"],
  ]) {
    const result = compose([a, b]);
    assert.equal(result.status, "conflict");
    assert.equal(result.conflicts[0].reason, reason);
    assert.equal(result.patches.length, 0);
  }
});

test("unchanged ancestor ownership is not a reservation but real ancestor effects conflict", () => {
  const result = compose([candidate("new", null, null), candidate("new/file.txt", null, "x")]);
  assert.equal(result.status, "compatible-file-effects");
  assert.equal(result.patches.length, 1);
  const conflict = compose([candidate("new", null, "file"), candidate("new/file.txt", null, "x")]);
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.conflicts[0].reason, "ancestor-overlap");
});

test("unchanged ownership is not a contradictory edit but remains a preimage claim", () => {
  assert.equal(compose([candidate("a", "old", "old"), candidate("a", "old", "new")]).status, "compatible-file-effects");
  const diagnostic = compose([candidate("a", "other", "other"), candidate("a", "old", "new")]);
  assert.equal(diagnostic.status, "compatible-file-effects");
  assert.equal(diagnostic.basisDiagnostics.length, 1);
  const noops = compose([candidate("a", "earlier", "earlier"), candidate("a", "later", "later")]);
  assert.equal(noops.status, "compatible-file-effects");
  assert.equal(noops.patches.length, 0);
  assert.equal(noops.basisDiagnostics.length, 1);
});

test("malformed candidates and exceeded pre/post byte budget do not produce a partial plan", () => {
  const a = candidate("a", "old", "new");
  assert.throws(() => composeWorkerPatchCandidates({ candidates: [a], maxBytes: 5 }), { code: "WORKER_PATCH_COMPOSITION_INVALID" });
  assert.throws(() => composeWorkerPatchCandidates({ candidates: [a], maxBytes: Infinity }), { code: "WORKER_PATCH_COMPOSITION_INVALID" });
  const tampered = structuredClone(a);
  tampered.patches[0].after.mode = 0o755;
  assert.throws(() => compose([tampered]), { code: "WORKER_PATCH_CONFLICT" });
});

test("cross-member Windows aliases cannot silently become a shared path", { skip: process.platform !== "win32" }, () => {
  const result = compose([candidate("a", "old", "new"), candidate("A", "old", "new")]);
  assert.equal(result.status, "conflict");
  assert.equal(result.conflicts[0].reason, "path-alias");
});

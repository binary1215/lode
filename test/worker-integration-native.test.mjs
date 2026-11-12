import { relativeProjectArtifact } from "../scripts/lib/storage/project-storage-format.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { workerIntegrationFixture } from "./helpers/worker-integration-fixture.mjs";
import {
  applyWorkerPatchIntegration,
  readWorkerPatchApplication,
  reconcileWorkerPatchIntegration,
} from "../scripts/lib/worker/worker-integration-application.mjs";
import { prepareWorkerIntegrationResult, publishWorkerIntegrationResult } from "../scripts/lib/worker/worker-integration-result.mjs";
import { inspectProject } from "../scripts/lib/head-core.mjs";
import {
  invokeWorkerFileEffect,
  prepareWorkerFileEffectInvocation,
  invokePreparedWorkerFileEffect,
} from "../scripts/lib/runtime/runtime-worker-file-effect.mjs";

const nativeRoot = process.env.HEAD_AGENT_FILE_EFFECT_FIXTURE_ROOT;
const skip = process.platform !== "win32" || !nativeRoot ? "Windows native image-effect fixture not supplied; no provider test" : false;
console.log(
  JSON.stringify({
    event: "owned-worker-integration-native-test",
    pid: process.pid,
    parentPid: process.ppid,
    command: process.execPath,
    args: process.argv.slice(1),
    cwd: process.cwd(),
    ports: [],
    actualProviderInvoked: false,
  }),
);
const input = (f) => ({ root: f.root, integrationId: f.integrationId });
const pointers = (f) => [fs.readFileSync(f.sessionFile), fs.readFileSync(f.runFile)];
function nativeHost(t) {
  const spawned = new Set();
  const exited = new Set();
  t.after(() => {
    assert.deepEqual([...spawned].sort(), [...exited].sort());
    for (const pid of spawned) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });
  return {
    nativeOptions: { pluginRoot: nativeRoot },
    onProcess: (event) => {
      console.log(JSON.stringify({ event: "owned-integration-native-effect", ...event }));
      if (event.type === "spawn") spawned.add(event.pid);
      if (event.type === "exit" && event.cleanupVerified) exited.add(event.pid);
    },
  };
}

test("actual native edit/create/delete/mode effects connect to one whole result without approval or P2 integration", { skip }, async (t) => {
  const f = await workerIntegrationFixture(t, {
    workers: [
      { path: "a-edit.txt", before: "before", after: "after" },
      { path: "b-empty.txt", before: null, after: "", afterMode: 0o666 },
      { path: "c-delete.txt", before: "remove", remove: true },
      { path: "d-mode.txt", before: "mode", after: "mode", afterMode: 0o444 },
    ],
  });
  const host = nativeHost(t);
  const before = pointers(f);
  const applied = await applyWorkerPatchIntegration(input(f), host);
  assert.equal(applied.status, "applied");
  assert.equal(applied.effectResults.length, 4);
  assert.equal(applied.outstanding, false);
  assert.deepEqual(pointers(f), before);
  assert.equal(fs.readFileSync(path.join(f.root, "a-edit.txt"), "utf8"), "after");
  assert.equal(fs.statSync(path.join(f.root, "b-empty.txt")).size, 0);
  assert.equal(fs.existsSync(path.join(f.root, "c-delete.txt")), false);
  assert.equal(fs.statSync(path.join(f.root, "d-mode.txt")).mode & 0o777, 0o444);
  const replay = await applyWorkerPatchIntegration(input(f), host);
  assert.deepEqual(replay.effectResults, applied.effectResults);
  const verification = await prepareWorkerIntegrationResult({
    ...input(f),
    basisDigest: f.readBasis().basisDigest,
    outcome: "Verified combined synthetic filesystem effects",
    evidence: [{ kind: "synthetic-native-files", paths: applied.effectResults.map((effect) => effect.path) }],
    verification: [{ check: "read exact resulting bytes, absence and mode", status: "passed" }],
    unknowns: ["Worker records are schema fixtures; no actual provider was invoked"],
  });
  const published = await publishWorkerIntegrationResult({ ...input(f), verificationId: verification.verification.verificationId });
  assert.equal(published.resultPacket.evidence[0].memberProvenance.length, 4);
  assert.equal(inspectProject(f.root).state.pendingReview.resultPacketId, published.resultPacket.resultPacketId);
  assert.equal(inspectProject(f.root).state.lastReviewDecisionId, null);
  assert.equal(fs.readdirSync(path.join(f.root, relativeProjectArtifact(f.storage, "lineage", "result-packets"))).length, 1);
});

test("native completion before P3 receipt crash reconciles without reapplying or overwriting later user edits", { skip }, async (t) => {
  const f = await workerIntegrationFixture(t, {
    workers: [
      { path: "a-edit.txt", before: "before A", after: "worker A" },
      { path: "b-edit.txt", before: "before B", after: "worker B" },
    ],
  });
  const host = nativeHost(t);
  const originalLink = fs.linkSync;
  let crashed = false;
  fs.linkSync = (source, target) => {
    if (
      !crashed &&
      String(target).startsWith(path.join(f.root, relativeProjectArtifact(f.storage, "runtime", "worker-integrations"))) &&
      /\.effect-0(?:\.[^.]+)*\.receipt\.json$/.test(String(target))
    ) {
      crashed = true;
      throw Object.assign(new Error("Synthetic post-effect P3 publication crash"), { code: "EIO" });
    }
    return originalLink(source, target);
  };
  try {
    await assert.rejects(applyWorkerPatchIntegration(input(f), host), { code: "EIO" });
  } finally {
    fs.linkSync = originalLink;
  }
  assert.equal(crashed, true);
  assert.equal(fs.readFileSync(path.join(f.root, "a-edit.txt"), "utf8"), "worker A");
  assert.equal(fs.readFileSync(path.join(f.root, "b-edit.txt"), "utf8"), "before B");
  fs.writeFileSync(path.join(f.root, "a-edit.txt"), "user A");
  const before = pointers(f);
  const recovered = await reconcileWorkerPatchIntegration(input(f), host);
  assert.equal(recovered.effectResults[0].status, "applied", "historical effect completion, not current source ownership");
  assert.equal(recovered.allEffectsCompleted, false);
  assert.equal(readWorkerPatchApplication(input(f)).currentBasis.headReassessmentRequired, true);
  assert.equal((await applyWorkerPatchIntegration({ ...input(f), basisDigest: f.readBasis().basisDigest }, host)).allEffectsCompleted, true);
  assert.equal(fs.readFileSync(path.join(f.root, "a-edit.txt"), "utf8"), "user A");
  assert.equal(fs.readFileSync(path.join(f.root, "b-edit.txt"), "utf8"), "worker B");
  assert.deepEqual(pointers(f), before);
});

test("a later exact native completion preserves the initial unknown receipt and adds one reconciled observation", { skip }, async (t) => {
  const f = await workerIntegrationFixture(t, { workers: [{ path: "edit.txt", before: "before", after: "after" }] });
  const native = nativeHost(t);
  const before = pointers(f);
  let lost = false;
  const host = {
    ...native,
    fileEffect: async (request, options) => {
      const result = await invokeWorkerFileEffect(request, options);
      if (request.operation === "image-apply" && !lost) {
        lost = true;
        throw Object.assign(new Error("Synthetic lost return after actual native completion"), { code: "SYNTHETIC_RETURN_LOSS" });
      }
      return result;
    },
  };
  const interrupted = await applyWorkerPatchIntegration(input(f), host);
  assert.equal(interrupted.effectResults[0].status, "unknown");
  assert.equal(fs.readFileSync(path.join(f.root, "edit.txt"), "utf8"), "after");
  const original = interrupted.effectResults[0].receipt;
  const recovered = await reconcileWorkerPatchIntegration(input(f), native);
  assert.equal(recovered.allEffectsCompleted, true);
  assert.notEqual(recovered.effectResults[0].receipt.recordId, original.recordId);
  assert.equal(recovered.effectResults[0].receipt.previousReceiptId, original.recordId);
  const directory = path.join(f.root, relativeProjectArtifact(f.storage, "runtime", "worker-integrations"));
  const retained = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")));
  assert.deepEqual(
    retained.find((value) => value.recordId === original.recordId),
    original,
  );
  const count = retained.length;
  assert.equal((await reconcileWorkerPatchIntegration(input(f), native)).allEffectsCompleted, true);
  assert.equal(fs.readdirSync(directory).filter((name) => name.endsWith(".json")).length, count);
  assert.deepEqual(pointers(f), before);
});

test("verified native no-write retries the same integration with one linked attempt after restoring the preimage", { skip }, async (t) => {
  const f = await workerIntegrationFixture(t, { workers: [{ path: "edit.txt", before: "before", after: "after" }] });
  const native = nativeHost(t);
  const before = pointers(f);
  let changed = false;
  const host = {
    ...native,
    fileEffect: async (request, options) => {
      if (request.operation === "image-apply" && !changed) {
        changed = true;
        fs.writeFileSync(path.join(f.root, "edit.txt"), "concurrent");
      }
      return invokeWorkerFileEffect(request, options);
    },
  };
  const stopped = await applyWorkerPatchIntegration(input(f), host);
  assert.equal(stopped.effectResults[0].status, "not-started");
  const claimId = stopped.claim.recordId;
  fs.writeFileSync(path.join(f.root, "edit.txt"), "before");
  assert.equal((await applyWorkerPatchIntegration(input(f), native)).effectResults[0].status, "not-started");
  const resumed = await applyWorkerPatchIntegration({ ...input(f), basisDigest: f.readBasis().basisDigest, retryKnownNoWrite: true }, native);
  assert.equal(resumed.allEffectsCompleted, true);
  assert.equal(resumed.claim.recordId, claimId);
  assert.equal(resumed.effectResults[0].attempts.length, 2);
  assert.notEqual(resumed.effectResults[0].receipt.nativeIntentId, stopped.effectResults[0].receipt.nativeIntentId);
  assert.equal(fs.readFileSync(path.join(f.root, "edit.txt"), "utf8"), "after");
  assert.deepEqual(pointers(f), before);
});

test("an exact initial nonpublication proof permits an explicit linked attempt without erasing history or changing the native intent", { skip }, async (t) => {
  const f = await workerIntegrationFixture(t, { workers: [{ path: "nested/edit.txt", before: "before", after: "after" }] });
  const native = nativeHost(t);
  const before = pointers(f);
  const ancestor = path.join(f.root, "nested");
  const displaced = path.join(f.root, "nested-held-for-native-test");
  let interrupted = false;
  let nativeInvocations = 0;
  const host = {
    ...native,
    prepareFileEffect: prepareWorkerFileEffectInvocation,
    invokePreparedFileEffect: async (capability) => {
      nativeInvocations += 1;
      if (interrupted) return invokePreparedWorkerFileEffect(capability);
      interrupted = true;
      // Core has already published the exact request binding and started P3
      // record. Move only this fixture-owned ancestor, then invoke the genuine
      // native transport. No synthetic response or proof is supplied.
      const directory = path.join(f.root, relativeProjectArtifact(f.storage, "runtime", "worker-integrations"));
      assert.equal(fs.readdirSync(directory).filter((name) => /\.started\.json$/.test(name)).length, 1);
      fs.renameSync(ancestor, displaced);
      try {
        return await invokePreparedWorkerFileEffect(capability);
      } finally {
        fs.renameSync(displaced, ancestor);
      }
    },
  };
  const stopped = await applyWorkerPatchIntegration(input(f), host);
  const initial = stopped.effectResults[0];
  assert.equal(initial.status, "not-started");
  assert.equal(initial.receipt.terminalProof.provenance, "verified-native-child");
  assert.equal(initial.receipt.terminalProof.nativeResponse.result.intentPublication, "not-attempted");
  assert.equal(initial.receipt.terminalProof.ownedChildClosed, true);
  assert.equal(Object.hasOwn(initial.receipt.terminalProof.nativeResponse, "requestId"), false);
  assert.equal(fs.readFileSync(path.join(ancestor, "edit.txt"), "utf8"), "before");
  const retainedReceipt = initial.receipt;
  const retainedAttempt = initial.started;
  const noAutomaticRetry = await applyWorkerPatchIntegration(input(f), host);
  assert.equal(noAutomaticRetry.effectResults[0].attempts.length, 1);
  assert.equal(nativeInvocations, 1);
  const resumed = await applyWorkerPatchIntegration({ ...input(f), basisDigest: f.readBasis().basisDigest, retryKnownNoWrite: true }, host);
  assert.equal(resumed.allEffectsCompleted, true);
  assert.equal(resumed.claim.recordId, stopped.claim.recordId);
  assert.equal(nativeInvocations, 2);
  const result = resumed.effectResults[0];
  assert.equal(result.attempts.length, 2);
  assert.equal(result.started.operation, "image-apply");
  assert.equal(result.started.retryBasisKind, "not-published");
  assert.equal(result.started.previousAttemptId, retainedAttempt.recordId);
  assert.equal(result.receipt.nativeIntentId, retainedReceipt.nativeIntentId);
  assert.notEqual(result.started.preDispatchBinding.requestIdDigest, retainedAttempt.preDispatchBinding.requestIdDigest);
  const records = fs
    .readdirSync(path.join(f.root, relativeProjectArtifact(f.storage, "runtime", "worker-integrations")))
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(f.root, relativeProjectArtifact(f.storage, "runtime", "worker-integrations"), name), "utf8")));
  assert.deepEqual(
    records.find((record) => record.recordId === retainedReceipt.recordId),
    retainedReceipt,
  );
  assert.deepEqual(
    records.find((record) => record.recordId === retainedAttempt.recordId),
    retainedAttempt,
  );
  assert.equal(fs.readFileSync(path.join(ancestor, "edit.txt"), "utf8"), "after");
  assert.deepEqual(pointers(f), before);
  const preparedResult = await prepareWorkerIntegrationResult({
    ...input(f),
    basisDigest: f.readBasis().basisDigest,
    outcome: "Verified explicit retry of an initially unpublished synthetic effect",
    evidence: [{ kind: "synthetic-native-retry", attempts: 2 }],
    verification: [{ check: "exact postimage and preserved initial failure evidence", status: "passed" }],
    unknowns: ["No actual provider invocation; worker inputs are schema fixtures"],
  });
  const published = await publishWorkerIntegrationResult({ ...input(f), verificationId: preparedResult.verification.verificationId });
  const publishedAttempts = published.resultPacket.evidence[0].effectEvidence.effects[0].attempts;
  assert.deepEqual(
    publishedAttempts.map((attempt) => attempt.started),
    [retainedAttempt, result.started].map((record) => ({ recordId: record.recordId, recordHash: record.recordHash })),
  );
  assert.deepEqual(
    publishedAttempts.map((attempt) => attempt.receipt),
    [retainedReceipt, result.receipt].map((record) => ({ recordId: record.recordId, recordHash: record.recordHash })),
  );
  assert.deepEqual(
    publishedAttempts.map((attempt) => attempt.status),
    ["not-started", "applied"],
  );
  assert.equal(inspectProject(f.root).state.pendingReview.resultPacketId, published.resultPacket.resultPacketId);
  assert.equal(inspectProject(f.root).state.lastReviewDecisionId, null);
  assert.equal(fs.readdirSync(path.join(f.root, relativeProjectArtifact(f.storage, "lineage", "result-packets"))).length, 1);
});

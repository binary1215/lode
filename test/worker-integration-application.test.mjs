import { relativeProjectArtifact } from "../scripts/lib/storage/project-storage-format.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { createProcessSupervisorManifest } from "../scripts/lib/runtime/runtime-process-supervisor.mjs";
import { RUNTIME_OPERATIONAL_STATE_ENV } from "../scripts/lib/runtime/runtime-execution-lease.mjs";
import {
  invokeWorkerFileEffect,
  prepareWorkerFileEffectInvocation,
  invokePreparedWorkerFileEffect,
  workerFileEffectNativeIntentId,
} from "../scripts/lib/runtime/runtime-worker-file-effect.mjs";
import { integrationDigest as hash, integrationJson as canonicalJson } from "../scripts/lib/worker/worker-integration-store.mjs";
import { workerIntegrationFixture } from "./helpers/worker-integration-fixture.mjs";
import { finishRun, getPendingReviewContext, reviewRun, startRun } from "../scripts/lib/runtime/run-lineage.mjs";
import { createHeadSession, withSessionRoute } from "../scripts/lib/session/session-routing.mjs";
import {
  applyWorkerPatchIntegration,
  readWorkerPatchApplication,
  readOutstandingWorkerEffects,
  reconcileWorkerPatchIntegration,
  settleIncompleteWorkerPatchIntegration,
  workerEffectPathsOverlap,
} from "../scripts/lib/worker/worker-integration-application.mjs";

console.log(
  JSON.stringify({
    event: "owned-worker-integration-application-test",
    pid: process.pid,
    parentPid: process.ppid,
    command: process.execPath,
    args: process.argv.slice(1),
    cwd: process.cwd(),
    ports: [],
    actualProviderInvoked: false,
  }),
);

const bytes = (root, relative) => fs.readFileSync(path.join(root, relative), "utf8");
const appInput = (f) => ({ root: f.root, integrationId: f.integrationId, storage: f.storage });
const current = (f) => readWorkerPatchApplication(appInput(f));
const evidenceFile = (f, suffix) => path.join(f.root, relativeProjectArtifact(f.storage, "runtime", "worker-integrations"), `${f.integrationId}${suffix}`);

function rewriteSyntheticEvidence(file, change) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  change(value);
  const { recordId: _id, recordHash: _hash, ...body } = value;
  const recordHash = hash(canonicalJson(body));
  fs.writeFileSync(file, JSON.stringify({ ...body, recordHash, recordId: `worker-effect-${recordHash.slice(0, 24)}` }));
}

// This trusted, in-process Host seam models bounded native responses. It does
// not execute a provider, native helper, shell, process or filesystem sandbox.
function syntheticHost({ unsupported = [], apply, inspect, preflight } = {}) {
  const calls = [];
  const host = {
    fileEffect: async (request, options) => {
      const item = { operation: request.operation, path: request.payload.path || request.payload.effect?.path, payload: structuredClone(request.payload) };
      calls.push(item);
      if (request.operation === "image-preflight") {
        await preflight?.(request, calls);
        return unsupported.includes(item.path)
          ? { status: "error", error: { code: "UNSUPPORTED_SYNTHETIC_EFFECT" } }
          : {
              status: "ok",
              result: {
                status: "supported",
                rootIdentity: "synthetic-root",
                ancestorIdentities: item.path.split("/").map((_segment, index) => (index ? `synthetic-ancestor-${index}` : "synthetic-root")),
              },
            };
      }
      if (request.operation === "image-inspect")
        return inspect
          ? inspect(request, options, calls)
          : { status: "ok", result: { completionRecorded: false, status: "unknown", intentId: "synthetic-native-intent" } };
      assert.ok(["image-apply", "image-retry"].includes(request.operation));
      const number = calls.filter((call) => ["image-apply", "image-retry"].includes(call.operation)).length;
      const nativeIntentId = number === 1 ? "synthetic-native-intent" : `synthetic-native-intent-${number}`;
      const closed = () => options.onProcess({ type: "exit", cleanupVerified: true });
      if (apply) {
        const handled = await apply(request, { ...options, closed, nativeIntentId }, calls);
        if (handled !== undefined) return handled;
      }
      const effect = request.payload.effect;
      const file = path.join(effect.root, effect.path);
      const exists = fs.existsSync(file);
      if (
        (effect.before.kind === "absent" && exists) ||
        (effect.before.kind === "file" && (!exists || fs.readFileSync(file).toString("base64") !== effect.before.content))
      ) {
        closed();
        return { status: "error", result: { status: "not-started", intentId: nativeIntentId }, error: { code: "PREIMAGE_CONFLICT" } };
      }
      if (effect.after.kind === "absent") fs.unlinkSync(file);
      else fs.writeFileSync(file, Buffer.from(effect.after.content, "base64"));
      closed();
      return { status: "ok", result: { status: "effect-observed", intentId: nativeIntentId } };
    },
  };
  return { host, calls, writes: () => calls.filter((call) => ["image-apply", "image-retry"].includes(call.operation)) };
}

// Exercise the actual bounded transport/parser/close proof with an in-memory
// child and a verified dummy binary. This is NOT native or provider execution.
function preparedSyntheticHost(f, { first = "not-attempted", failures = 1, afterPrepare, transformResult } = {}) {
  const pluginRoot = path.join(f.container, "prepared-transport-fixture");
  const target = process.platform === "win32" ? "windows-x64" : `${process.platform}-${process.arch}`;
  const directory = path.join(pluginRoot, "dist", target);
  fs.mkdirSync(directory, { recursive: true });
  const binaryFile = path.join(directory, process.platform === "win32" ? "lode-agent-supervisor.exe" : "lode-agent-supervisor");
  fs.writeFileSync(binaryFile, "Synthetic verified transport binary; never executed", { flag: "wx", mode: 0o755 });
  const manifest = createProcessSupervisorManifest({ platform: process.platform, arch: process.arch, binaryFile, manifestDirectory: directory });
  fs.writeFileSync(path.join(directory, "SUPERVISOR-MANIFEST.json"), JSON.stringify(manifest), { flag: "wx" });
  const calls = [],
    children = [],
    prepared = [];
  const imageHash = (value) => hash(JSON.stringify(value));
  let effects = 0;
  const spawnImplementation = () => {
    const child = new EventEmitter();
    child.pid = 99_999_998; // Synthetic marker, never an OS ownership claim.
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.closed = false;
    child.close = (code = 0, signal = null) => {
      if (child.closed) return;
      child.closed = true;
      queueMicrotask(() => child.emit("close", code, signal));
    };
    child.kill = (signal) => {
      child.close(null, signal);
      return true;
    };
    const chunks = [];
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
      final(callback) {
        callback();
        queueMicrotask(() => {
          const input = Buffer.concat(chunks),
            request = JSON.parse(input);
          calls.push(request);
          const effect = request.payload.effect;
          const base = {
            protocolVersion: "0.1.0",
            requestId: request.requestId,
            operation: request.operation,
            payloadDigest: hash(JSON.stringify(request.payload)),
            requestDigest: hash(input),
            status: "ok",
            authorityEffect: "none",
          };
          let response;
          if (request.operation === "image-preflight")
            response = {
              ...base,
              result: {
                status: "supported",
                reason: "existing-parent-local-ntfs",
                operation:
                  effect.before.kind === "absent"
                    ? "create"
                    : effect.after.kind === "absent"
                      ? "delete"
                      : effect.before.content === effect.after.content
                        ? "mode"
                        : "edit",
                modeSemantics: "windows-readonly-attribute-only",
                metadataCAS: false,
                multiFileAtomic: false,
                rootIdentity: "synthetic-root",
                ancestorIdentities: effect.path.split("/").map((_segment, index) => (index ? `synthetic-ancestor-${index}` : "synthetic-root")),
              },
            };
          else if (request.operation === "image-inspect")
            response = {
              ...base,
              result: {
                intentId: workerFileEffectNativeIntentId(effect),
                status: first === "partial" ? "unknown" : "preimage-observed",
                startedRecorded: false,
                noWriteRecorded: first !== "partial",
                completionRecorded: false,
                retryBasisAvailable: first !== "partial",
                appliedByThisRead: false,
                ...(first === "partial" ? {} : { currentImageDigest: imageHash(effect.before) }),
              },
            };
          else {
            effects++;
            const intentId = workerFileEffectNativeIntentId(
              request.operation === "image-retry" ? { ...effect, previousIntentId: workerFileEffectNativeIntentId(effect) } : effect,
            );
            const outcome = {
              intentId,
              beforeImageDigest: imageHash(effect.before),
              afterImageDigest: imageHash(effect.after),
              dataFlushed: false,
              metadataCAS: false,
              multiFileAtomic: false,
            };
            if (effects <= failures)
              response = {
                ...base,
                status: "error",
                error: { code: "FILE_EFFECT_IO_ERROR" },
                result: {
                  ...outcome,
                  status: first === "partial" ? "incomplete-or-conflict" : "not-started",
                  ...(first === "not-attempted" || first === "truncated" ? { intentPublication: "not-attempted" } : {}),
                },
              };
            else {
              const file = path.join(effect.root, effect.path);
              assert.equal(fs.existsSync(file), effect.before.kind !== "absent");
              if (effect.before.kind === "file") assert.equal(fs.readFileSync(file).toString("base64"), effect.before.content);
              if (effect.after.kind === "absent") fs.unlinkSync(file);
              else fs.writeFileSync(file, Buffer.from(effect.after.content, "base64"));
              response = {
                ...base,
                result: {
                  ...outcome,
                  status: "effect-observed",
                  currentImageDigest: imageHash(effect.after),
                  dataFlushed: effect.after.kind === "file" && (effect.before.kind === "absent" || effect.before.content !== effect.after.content),
                },
              };
            }
          }
          const serialized = JSON.stringify(response);
          child.stdout.end(first === "truncated" && effects === 1 && request.operation === "image-apply" ? serialized.slice(0, -2) : serialized);
          child.close(response.status === "ok" ? 0 : 2);
        });
      },
    });
    children.push(child);
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  const options = (supplied) => ({ ...supplied, pluginRoot, spawnImplementation, trustedHostFixture: true });
  const host = {
    trustedHostFixture: true,
    fileEffect: (request, supplied) => invokeWorkerFileEffect(request, options(supplied)),
    prepareFileEffect: async (request, supplied) => {
      const handle = prepareWorkerFileEffectInvocation(request, options(supplied));
      prepared.push({ request, supplied, handle });
      await afterPrepare?.({ request, handle, binaryFile, prepared });
      return handle;
    },
    invokePreparedFileEffect: async (handle) => {
      if (first === "owner-unverified") throw Object.assign(new Error("Synthetic owner loss before terminal proof"), { code: "SYNTHETIC_UNKNOWN_OWNER" });
      const result = await invokePreparedWorkerFileEffect(handle);
      return transformResult ? transformResult(result, { prepared, options, host }) : result;
    },
  };
  return { host, calls, children, prepared, binaryFile, writes: () => calls.filter((call) => ["image-apply", "image-retry"].includes(call.operation)) };
}

function protectedSnapshot(f) {
  const { root, storage } = f;
  const files = {};
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file).replaceAll("\\", "/");
      if (relative === relativeProjectArtifact(storage, "runtime", "worker-integrations") || relative === relativeProjectArtifact(storage, ".operations"))
        continue;
      if (entry.isDirectory()) walk(file);
      else files[relative] = fs.readFileSync(file).toString("base64");
    }
  }
  walk(path.join(root, storage.directory));
  assert.ok(Object.hasOwn(files, relativeProjectArtifact(storage, "project.json")), "Protected snapshot must contain the selected Project original");
  return files;
}

test("application preflights every effect, keeps P1/P2 unchanged and exact replay performs no effect", async (t) => {
  const f = await workerIntegrationFixture(t, {
    workers: [
      { path: "a.txt", after: "new A" },
      { path: "b.txt", after: "new B" },
    ],
  });
  const before = protectedSnapshot(f);
  const native = syntheticHost();
  const applied = await applyWorkerPatchIntegration(appInput(f), native.host);
  assert.equal(applied.status, "applied");
  assert.equal(applied.allEffectsCompleted, true);
  assert.equal(applied.outstanding, false);
  assert.equal(applied.semanticVerification, "not-assessed");
  for (const field of ["instructionAuthority", "promotionAuthority", "recoveryAuthority", "reviewDecisionCreated", "mutatesCanon"])
    assert.equal(applied[field], false);
  const firstEffect = native.calls.findIndex((call) => call.operation === "image-apply");
  assert.equal(native.calls.slice(0, firstEffect).filter((call) => call.operation === "image-preflight").length, 2);
  assert.deepEqual(
    native.writes().map((call) => call.path),
    ["a.txt", "b.txt"],
  );
  assert.equal(bytes(f.root, "a.txt"), "new A");
  assert.equal(bytes(f.root, "b.txt"), "new B");
  assert.deepEqual(protectedSnapshot(f), before);
  const callCount = native.calls.length;
  const replay = await applyWorkerPatchIntegration(appInput(f), native.host);
  assert.equal(replay.claim.recordId, applied.claim.recordId);
  assert.deepEqual(replay.effectResults, applied.effectResults);
  assert.equal(native.calls.length, callCount);
  assert.deepEqual(protectedSnapshot(f), before);
});

test("unsupported final effect prevents all writes and creates no durable reservation", async (t) => {
  const f = await workerIntegrationFixture(t, {
    workers: [
      { path: "a.txt", after: "new A" },
      { path: "b.txt", after: "new B" },
    ],
  });
  const originals = [bytes(f.root, "a.txt"), bytes(f.root, "b.txt")];
  const native = syntheticHost({ unsupported: ["b.txt"] });
  const result = await applyWorkerPatchIntegration(appInput(f), native.host);
  assert.equal(result.action, "unsupported-file-effects");
  assert.equal(result.claim, null);
  assert.equal(result.outstanding, false);
  assert.deepEqual(native.writes(), []);
  assert.equal(native.calls.filter((call) => call.operation === "image-preflight").length, 2);
  assert.deepEqual([bytes(f.root, "a.txt"), bytes(f.root, "b.txt")], originals);
  assert.equal(fs.existsSync(evidenceFile(f, ".effect-claim.json")), false);
});

test("basis changes during awaited preflight require HEAD reassessment before the first claim", async (t) => {
  const f = await workerIntegrationFixture(t, { workers: [{ path: "a.txt", after: "new A" }] });
  const native = syntheticHost({ preflight: () => fs.writeFileSync(path.join(f.root, "a.txt"), "concurrent change") });
  const result = await applyWorkerPatchIntegration(appInput(f), native.host);
  assert.equal(result.action, "refresh-lode-assessment");
  assert.equal(result.claim, null);
  assert.deepEqual(native.writes(), []);
  assert.equal(bytes(f.root, "a.txt"), "concurrent change");
  assert.equal(fs.existsSync(evidenceFile(f, ".effect-claim.json")), false);
});

test("partial application never overwrites a user's later edit when the remaining effect conflicts", async (t) => {
  const f = await workerIntegrationFixture(t, {
    workers: [
      { path: "a.txt", after: "new A" },
      { path: "b.txt", after: "new B" },
    ],
  });
  const native = syntheticHost({
    apply: (request) => {
      if (request.payload.effect.path === "b.txt") fs.writeFileSync(path.join(f.root, "b.txt"), "external B");
    },
  });
  const partial = await applyWorkerPatchIntegration(appInput(f), native.host);
  assert.equal(partial.status, "incomplete");
  assert.equal(partial.allEffectsCompleted, false);
  assert.equal(partial.outstanding, true);
  assert.deepEqual(
    partial.effectResults.map((result) => result.status),
    ["applied", "not-started"],
  );
  fs.writeFileSync(path.join(f.root, "a.txt"), "user's later A");
  const fresh = current(f);
  const replay = await applyWorkerPatchIntegration({ ...appInput(f), basisDigest: fresh.currentBasis.basisDigest }, native.host);
  assert.equal(replay.action, "reconcile-started-effect");
  assert.equal(native.writes().length, 2);
  assert.equal(bytes(f.root, "a.txt"), "user's later A");
  assert.equal(bytes(f.root, "b.txt"), "external B");
  const reconciled = await reconcileWorkerPatchIntegration(appInput(f), native.host);
  assert.equal(reconciled.allEffectsCompleted, false);
  assert.equal(bytes(f.root, "a.txt"), "user's later A");
  assert.equal(native.writes().length, 2);
});

test("unknown receipt and lost P5 journal never license another application", async (t) => {
  const f = await workerIntegrationFixture(t, { workers: [{ path: "a.txt", after: "new A" }] });
  const native = syntheticHost({
    apply: (_request, options) => {
      options.closed();
      throw Object.assign(new Error("Modeled lost transport response"), { code: "SYNTHETIC_TRANSPORT_LOSS" });
    },
  });
  const initial = await applyWorkerPatchIntegration(appInput(f), native.host);
  assert.equal(initial.effectResults[0].status, "unknown");
  assert.equal(initial.effectResults[0].receipt.ownerQuiescent, true);
  const journal = native.writes()[0].payload.journal;
  assert.ok(path.relative(f.container, journal) && !path.relative(f.container, journal).startsWith(".."));
  fs.renameSync(journal, `${journal}.retired-by-test`);
  const observed = await reconcileWorkerPatchIntegration(appInput(f), native.host);
  assert.equal(observed.action, "host-effect-evidence-unavailable");
  const replay = await applyWorkerPatchIntegration(appInput(f), native.host);
  assert.equal(replay.action, "reconcile-started-effect");
  assert.equal(replay.effectResults[0].status, "unknown");
  assert.equal(native.writes().length, 1);
  assert.equal(fs.existsSync(journal), false);
  const explicit = await applyWorkerPatchIntegration({ ...appInput(f), retryKnownNoWrite: true }, native.host);
  assert.equal(explicit.action, "reconcile-started-effect");
  assert.equal(native.writes().length, 1);
});

test("an unquiescent unknown cannot be settled by caller assertion or current postimage", async (t) => {
  const f = await workerIntegrationFixture(t, { workers: [{ path: "a.txt", after: "new A" }] });
  const native = syntheticHost({
    apply: (request) => {
      fs.writeFileSync(path.join(f.root, "a.txt"), Buffer.from(request.payload.effect.after.content, "base64"));
      throw Object.assign(new Error("Owner status unverified"), { code: "SYNTHETIC_UNKNOWN_OWNER" });
    },
  });
  const initial = await applyWorkerPatchIntegration(appInput(f), native.host);
  assert.equal(initial.effectResults[0].status, "unknown");
  assert.equal(initial.effectResults[0].receipt.ownerQuiescent, false);
  assert.equal(initial.currentBasis.dependencies[0].expectedPostimagePresent, true);
  const result = await settleIncompleteWorkerPatchIntegration({
    ...appInput(f),
    basisDigest: initial.currentBasis.basisDigest,
    reason: "Caller believes it finished",
    ownerQuiescent: true,
  });
  assert.equal(result.action, "prove-effect-owner-quiescence");
  assert.equal(result.settlement, null);
  assert.equal(result.allEffectsCompleted, false);
  assert.equal(result.outstanding, true);
  assert.equal(fs.existsSync(evidenceFile(f, ".settled-incomplete.json")), false);
});

test("quiescent incomplete handoff closes only the reservation without making success or review", async (t) => {
  const f = await workerIntegrationFixture(t, { workers: [{ path: "a.txt", after: "new A" }] });
  const native = syntheticHost({
    apply: (_request, options) => {
      options.closed();
      throw Object.assign(new Error("Unknown effect"), { code: "SYNTHETIC_UNKNOWN" });
    },
  });
  const before = protectedSnapshot(f);
  const initial = await applyWorkerPatchIntegration(appInput(f), native.host);
  const settlementInput = {
    ...appInput(f),
    basisDigest: initial.currentBasis.basisDigest,
    reason: "HEAD inspected current source and abandoned this incomplete attempt.",
  };
  const settled = await settleIncompleteWorkerPatchIntegration(settlementInput);
  assert.equal(settled.status, "incomplete");
  assert.equal(settled.allEffectsCompleted, false);
  assert.equal(settled.outstanding, false);
  assert.equal(settled.effectResults[0].status, "unknown");
  assert.ok(settled.settlement);
  const replay = await applyWorkerPatchIntegration(appInput(f), native.host);
  assert.equal(replay.settlement.recordId, settled.settlement.recordId);
  assert.equal((await settleIncompleteWorkerPatchIntegration(settlementInput)).settlement.recordId, settled.settlement.recordId);
  assert.equal(native.writes().length, 1);
  assert.deepEqual(protectedSnapshot(f), before);
  await assert.rejects(
    settleIncompleteWorkerPatchIntegration({
      ...appInput(f),
      basisDigest: initial.currentBasis.basisDigest,
      reason: "Divergent settlement must not replace prior evidence.",
    }),
    { code: "WORKER_INTEGRATION_APPLICATION_CONFLICT" },
  );
});

test("stale basis is an internal HEAD reassessment, not an additional user approval", async (t) => {
  const f = await workerIntegrationFixture(t, {
    workers: [
      { path: "a.txt", after: "new A" },
      { path: "b.txt", after: null },
    ],
  });
  const oldBasis = current(f).currentBasis.basisDigest;
  fs.writeFileSync(path.join(f.root, "b.txt"), "fresh dependency");
  const native = syntheticHost();
  const old = await applyWorkerPatchIntegration({ ...appInput(f), basisDigest: oldBasis }, native.host);
  assert.equal(old.action, "refresh-lode-assessment");
  assert.equal(old.claim, null);
  const missing = await applyWorkerPatchIntegration(appInput(f), native.host);
  assert.equal(missing.action, "lode-reassess-current-basis");
  assert.equal(missing.userActionRequired, undefined);
  assert.deepEqual(native.calls, []);
  const accepted = await applyWorkerPatchIntegration({ ...appInput(f), basisDigest: current(f).currentBasis.basisDigest }, native.host);
  assert.equal(accepted.status, "applied");
  assert.deepEqual(
    accepted.claim.effects.map((effect) => effect.path),
    ["a.txt"],
  );
  assert.equal(bytes(f.root, "b.txt"), "fresh dependency");
  assert.equal(accepted.reviewDecisionCreated, false);
});

test("historical application evidence survives Session drift while a new application fails current lineage", async (t) => {
  const f = await workerIntegrationFixture(t, { workers: [{ path: "a.txt", after: "new A" }] });
  const native = syntheticHost();
  await applyWorkerPatchIntegration(appInput(f), native.host);
  const session = JSON.parse(fs.readFileSync(f.sessionFile, "utf8"));
  fs.writeFileSync(f.sessionFile, JSON.stringify({ ...session, sessionId: "session-11111111-2222-4333-8444-555555555555" }));
  const before = protectedSnapshot(f);
  assert.equal(current(f).status, "applied");
  await assert.rejects(applyWorkerPatchIntegration(appInput(f), native.host), { code: "RUNTIME_INVOCATION_FENCE_MISMATCH" });
  assert.deepEqual(protectedSnapshot(f), before);
  assert.equal(native.writes().length, 1);
});

test("claim and receipt tampering is not reinterpreted as a retryable operational failure", async (t) => {
  const f = await workerIntegrationFixture(t, { workers: [{ path: "a.txt", after: "new A" }] });
  const native = syntheticHost();
  await applyWorkerPatchIntegration(appInput(f), native.host);
  for (const suffix of [".effect-claim.json", ".effect-0.receipt.json"]) {
    const file = evidenceFile(f, suffix);
    const original = fs.readFileSync(file);
    const value = JSON.parse(original);
    fs.writeFileSync(file, JSON.stringify({ ...value, recoveryAuthority: true }));
    try {
      assert.throws(() => current(f), { code: "WORKER_INTEGRATION_APPLICATION_CONFLICT" });
      await assert.rejects(applyWorkerPatchIntegration(appInput(f), native.host), { code: "WORKER_INTEGRATION_APPLICATION_CONFLICT" });
      assert.equal(native.writes().length, 1);
    } finally {
      fs.writeFileSync(file, original);
    }
  }
});

test("effect overlap is exact/ancestor bounded and retains platform case semantics", () => {
  assert.equal(workerEffectPathsOverlap("a.txt", "a.txt"), true);
  assert.equal(workerEffectPathsOverlap("folder", "folder/a.txt"), true);
  assert.equal(workerEffectPathsOverlap("folder/a.txt", "folder"), true);
  assert.equal(workerEffectPathsOverlap("folder-a", "folder/b.txt"), false);
  assert.equal(workerEffectPathsOverlap("a.txt", "b.txt"), false);
  assert.equal(workerEffectPathsOverlap("A.txt", "a.txt"), process.platform === "win32");
});

function nextRun(f, replaceSession = false) {
  finishRun({
    root: f.root,
    outcome: "Synthetic integration attempt remains incomplete; preserve its unknown effect.",
    evidence: [
      { uri: relativeProjectArtifact(f.storage, "runtime", "worker-integrations"), digest: f.intent.integrationHash, summary: "Durable incomplete attempt" },
    ],
    verification: [{ check: "Synthetic fixture setup", status: "passed", evidence: "Unknown is not success" }],
    unknowns: ["Effect ownership is unresolved"],
  });
  reviewRun({
    root: f.root,
    reviewContextId: getPendingReviewContext({ root: f.root }).review.reviewContextId,
    disposition: "accept",
    rationale: "Accept this diagnostic record, not successful effect completion.",
    nextActions: ["Reconcile outstanding effects"],
  });
  if (replaceSession) {
    // Use the supported independent logical Session route. Rewriting only the
    // default state's owner would leave foreign last-reviewed pointers and is
    // invalid P2, not a valid replacement Session. Old effect evidence remains.
    const replacement = createHeadSession({ root: f.root, purpose: "Replacement caller" });
    return withSessionRoute(f.root, replacement.sessionId, () => startRun({ root: f.root, executionContractId: f.contract.executionContractId })).run;
  }
  return startRun({ root: f.root, executionContractId: f.contract.executionContractId }).run;
}

test("outstanding unknown paths block overlap across Run/Session changes but not unrelated effects", async (t) => {
  for (const replaceSession of [false, true]) {
    await t.test(replaceSession ? "replacement Session" : "later Run", async (subtest) => {
      const f = await workerIntegrationFixture(subtest, { workers: [{ path: "a.txt", after: "new A" }], readDependencies: ["read-only.txt"] });
      const unknownHost = syntheticHost({
        apply: (_request, options) => {
          options.closed();
          throw Object.assign(new Error("Unknown native effect"), { code: "SYNTHETIC_UNKNOWN" });
        },
      });
      const unknown = await applyWorkerPatchIntegration(appInput(f), unknownHost.host);
      const journal = unknownHost.writes()[0].payload.journal;
      fs.renameSync(journal, `${journal}.retired-by-test`);
      const next = nextRun(f, replaceSession);
      assert.notEqual(next.runId, unknown.intent.lineage.runId);
      await withSessionRoute(f.root, next.sessionId, async () => {
        const overlapping = await f.addIntegration({ workers: [{ path: "a.txt", after: "alternative A" }] });
        const overlapInput = { root: f.root, integrationId: overlapping.integrationId, storage: f.storage };
        const collisions = readOutstandingWorkerEffects(overlapInput);
        assert.equal(collisions.hasConflicts, true);
        assert.equal(collisions.conflicts[0].integrationId, f.integrationId);
        assert.equal(collisions.conflicts[0].runId, f.run.runId);
        const native = syntheticHost();
        const protectedBefore = protectedSnapshot(f);
        const blocked = await applyWorkerPatchIntegration(overlapInput, native.host);
        assert.equal(blocked.action, "reconcile-overlapping-effects");
        assert.deepEqual(native.calls, []);
        assert.deepEqual(protectedSnapshot(f), protectedBefore);
        assert.equal(fs.existsSync(journal), false);
        // A dependency read by the old worker is not a claimed write path.
        const unrelated = await f.addIntegration({ workers: [{ path: "read-only.txt", after: "new independent value" }] });
        const unrelatedInput = { root: f.root, integrationId: unrelated.integrationId, storage: f.storage };
        assert.equal(readOutstandingWorkerEffects(unrelatedInput).hasConflicts, false);
        assert.equal((await applyWorkerPatchIntegration(unrelatedInput, native.host)).status, "applied");
        assert.equal(current(f).effectResults[0].status, "unknown");
        assert.equal(current(f).outstanding, true);
      });
    });
  }
});

test("quiescent incomplete settlement permits a new inspected integration without retrying the old one", async (t) => {
  const f = await workerIntegrationFixture(t, { workers: [{ path: "a.txt", after: "new A" }] });
  const native = syntheticHost({
    apply: (_request, options) => {
      options.closed();
      throw Object.assign(new Error("Unknown native effect"), { code: "SYNTHETIC_UNKNOWN" });
    },
  });
  await applyWorkerPatchIntegration(appInput(f), native.host);
  fs.writeFileSync(path.join(f.root, "a.txt"), "HEAD inspected fresh bytes");
  const settled = await settleIncompleteWorkerPatchIntegration({
    ...appInput(f),
    basisDigest: current(f).currentBasis.basisDigest,
    reason: "Known quiescent owner; keep unknown history and use a fresh inspected basis.",
  });
  assert.equal(settled.outstanding, false);
  const next = await f.addIntegration({ workers: [{ path: "a.txt", after: "fresh result" }] });
  const nextInput = { root: f.root, integrationId: next.integrationId, storage: f.storage };
  assert.notEqual(next.integrationId, f.integrationId);
  assert.equal(readOutstandingWorkerEffects(nextInput).hasConflicts, false);
  assert.equal((await applyWorkerPatchIntegration(nextInput, syntheticHost().host)).status, "applied");
  assert.equal(bytes(f.root, "a.txt"), "fresh result");
  assert.equal(current(f).effectResults[0].status, "unknown");
  assert.equal(native.writes().length, 1);
});

test("no-op ownership makes no path reservation or native call", async (t) => {
  const f = await workerIntegrationFixture(t);
  const before = protectedSnapshot(f);
  const native = syntheticHost();
  const noop = await applyWorkerPatchIntegration(appInput(f), native.host);
  assert.equal(noop.status, "applied");
  assert.deepEqual(noop.claim.effects, []);
  assert.deepEqual(native.calls, []);
  assert.equal(fs.existsSync(path.join(f.operational, "worker-integrations")), false);
  assert.deepEqual(protectedSnapshot(f), before);
  const next = await f.addIntegration({ workers: [{ path: "a.txt", after: "independent A" }] });
  assert.equal(readOutstandingWorkerEffects({ root: f.root, integrationId: next.integrationId, storage: f.storage }).hasConflicts, false);
});

test("a damaged claim for independently verified disjoint paths does not become a whole-project gate", async (t) => {
  const f = await workerIntegrationFixture(t, { workers: [{ path: "a.txt", after: "new A" }] });
  const native = syntheticHost({
    apply: (_request, options) => {
      options.closed();
      throw Object.assign(new Error("Unknown native effect"), { code: "SYNTHETIC_UNKNOWN" });
    },
  });
  await applyWorkerPatchIntegration(appInput(f), native.host);
  const next = await f.addIntegration({ workers: [{ path: "b.txt", after: "independent B" }] });
  const file = evidenceFile(f, ".effect-claim.json");
  const original = fs.readFileSync(file);
  fs.writeFileSync(file, "{ malformed claim bytes retained for diagnosis");
  try {
    const nextInput = { root: f.root, integrationId: next.integrationId, storage: f.storage };
    assert.equal(readOutstandingWorkerEffects(nextInput).hasConflicts, false);
    assert.equal((await applyWorkerPatchIntegration(nextInput, syntheticHost().host)).status, "applied");
    assert.throws(() => current(f));
  } finally {
    fs.writeFileSync(file, original);
  }
});

test("a postimage without receipt stays unknown until exact retained native completion is reconciled", async (t) => {
  const f = await workerIntegrationFixture(t, { workers: [{ path: "a.txt", after: "new A" }] });
  const native = syntheticHost();
  await applyWorkerPatchIntegration(appInput(f), native.host);
  // Model the publication gap after the native effect finished, without
  // deleting the claim/attempt that forbids executing the effect again.
  fs.unlinkSync(evidenceFile(f, ".effect-0.receipt.json"));
  const before = protectedSnapshot(f);
  assert.equal(current(f).effectResults[0].status, "unknown");
  assert.equal(current(f).allEffectsCompleted, false);
  assert.equal(current(f).currentBasis.dependencies[0].expectedPostimagePresent, true);
  const unchanged = await reconcileWorkerPatchIntegration(appInput(f), native.host);
  assert.equal(unchanged.effectResults[0].status, "unknown");
  assert.equal(native.writes().length, 1);
  const completedNative = syntheticHost({
    inspect: () => ({
      status: "ok",
      result: {
        status: "effect-observed",
        completionRecorded: true,
        intentId: "synthetic-native-intent",
      },
    }),
  });
  const recovered = await reconcileWorkerPatchIntegration(appInput(f), completedNative.host);
  assert.equal(recovered.status, "applied");
  assert.equal(recovered.effectResults[0].receipt.nativeIntentId, "synthetic-native-intent");
  assert.deepEqual(completedNative.writes(), []);
  assert.deepEqual(protectedSnapshot(f), before);
});

test("competing application callers converge under one effect claim and independent P5 lock", async (t) => {
  const f = await workerIntegrationFixture(t, { workers: [{ path: "a.txt", after: "new A" }] });
  const native = syntheticHost({ preflight: () => new Promise((resolve) => setTimeout(resolve, 5)) });
  const before = protectedSnapshot(f);
  const [left, right] = await Promise.all([applyWorkerPatchIntegration(appInput(f), native.host), applyWorkerPatchIntegration(appInput(f), native.host)]);
  assert.equal(left.status, "applied");
  assert.equal(right.status, "applied");
  assert.equal(left.claim.recordId, right.claim.recordId);
  assert.equal(native.writes().length, 1);
  assert.deepEqual(protectedSnapshot(f), before);
  assert.deepEqual(fs.readdirSync(path.join(f.root, relativeProjectArtifact(f.storage, ".operations"))), []);
});

test("Session changes during awaited capability probing reject before publishing a claim", async (t) => {
  const f = await workerIntegrationFixture(t, { workers: [{ path: "a.txt", after: "new A" }] });
  const native = syntheticHost({
    preflight: () => {
      const session = JSON.parse(fs.readFileSync(f.sessionFile, "utf8"));
      fs.writeFileSync(f.sessionFile, JSON.stringify({ ...session, sessionId: "session-11111111-2222-4333-8444-555555555555" }));
    },
  });
  const before = bytes(f.root, "a.txt");
  await assert.rejects(applyWorkerPatchIntegration(appInput(f), native.host), { code: "RUNTIME_INVOCATION_FENCE_MISMATCH" });
  assert.equal(bytes(f.root, "a.txt"), before);
  assert.deepEqual(native.writes(), []);
  assert.equal(fs.existsSync(evidenceFile(f, ".effect-claim.json")), false);
});

function knownNoWriteHost({ failures = 1, retainPriorOnSecond = false, inspectionPatch = {} } = {}) {
  let count = 0;
  let lastNativeIntent = null;
  let completion = false;
  const native = syntheticHost({
    apply: (_request, options) => {
      count += 1;
      if (!(retainPriorOnSecond && count === 2)) lastNativeIntent = options.nativeIntentId;
      if (count > failures) return undefined;
      options.closed();
      return { status: "error", result: { status: "not-started", intentId: lastNativeIntent }, error: { code: "SYNTHETIC_KNOWN_NO_WRITE" } };
    },
    inspect: () => ({
      status: "ok",
      result: completion
        ? {
            status: "effect-observed",
            intentId: lastNativeIntent,
            completionRecorded: true,
            noWriteRecorded: false,
            retryBasisAvailable: false,
            appliedByThisRead: false,
          }
        : {
            status: "preimage-observed",
            intentId: lastNativeIntent,
            noWriteRecorded: true,
            retryBasisAvailable: true,
            completionRecorded: false,
            appliedByThisRead: false,
            ...inspectionPatch,
          },
    }),
  });
  return {
    ...native,
    completeInspection: () => {
      completion = true;
    },
  };
}

test("known no-write retries retain the same claim and create an exact linked attempt only on request", async (t) => {
  const f = await workerIntegrationFixture(t, { workers: [{ path: "a.txt", after: "new A" }] });
  const native = knownNoWriteHost();
  const initial = await applyWorkerPatchIntegration(appInput(f), native.host);
  assert.equal(initial.effectResults[0].status, "not-started");
  const originalReceipt = fs.readFileSync(evidenceFile(f, ".effect-0.receipt.json"));
  assert.equal((await applyWorkerPatchIntegration(appInput(f), native.host)).action, "reconcile-started-effect");
  assert.equal(native.writes().length, 1);
  const retried = await applyWorkerPatchIntegration({ ...appInput(f), retryKnownNoWrite: true }, native.host);
  assert.equal(retried.status, "applied");
  assert.equal(retried.claim.recordId, initial.claim.recordId);
  const attempts = retried.effectResults[0].attempts;
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].started.previousAttemptId, attempts[0].started.recordId);
  assert.equal(attempts[1].started.previousNativeIntentId, attempts[0].receipt.nativeIntentId);
  assert.equal(native.writes()[1].operation, "image-retry");
  // Native retry accepts the previous exact effect and creates its linked
  // successor internally; the first previous effect has no predecessor.
  assert.equal(native.writes()[1].payload.effect.previousIntentId, undefined);
  assert.deepEqual(fs.readFileSync(evidenceFile(f, ".effect-0.receipt.json")), originalReceipt);
  assert.equal(bytes(f.root, "a.txt"), "new A");
});

test("retry inspection must prove exact native no-write, preimage and quiescent predecessor", async (t) => {
  for (const inspectionPatch of [
    { noWriteRecorded: false },
    { status: "external-drift" },
    { intentId: "another-native-intent" },
    { completionRecorded: true },
  ]) {
    await t.test(Object.keys(inspectionPatch)[0], async (subtest) => {
      const f = await workerIntegrationFixture(subtest, { workers: [{ path: "a.txt", after: "new A" }] });
      const native = knownNoWriteHost({ inspectionPatch });
      await applyWorkerPatchIntegration(appInput(f), native.host);
      const before = bytes(f.root, "a.txt");
      const result = await applyWorkerPatchIntegration({ ...appInput(f), retryKnownNoWrite: true }, native.host);
      assert.equal(result.allEffectsCompleted, false);
      assert.equal(result.effectResults[0].attempts.length, 1);
      assert.equal(native.writes().length, 1);
      assert.equal(bytes(f.root, "a.txt"), before);
    });
  }
});

test("successive known-no-write attempts preserve native lineage including pre-intent retry refusal", async (t) => {
  for (const retainPriorOnSecond of [false, true]) {
    await t.test(retainPriorOnSecond ? "native retry creates no new intent" : "native retry has its own no-write intent", async (subtest) => {
      const f = await workerIntegrationFixture(subtest, { workers: [{ path: "a.txt", after: "new A" }] });
      const native = knownNoWriteHost({ failures: 2, retainPriorOnSecond });
      await applyWorkerPatchIntegration(appInput(f), native.host);
      const second = await applyWorkerPatchIntegration({ ...appInput(f), retryKnownNoWrite: true }, native.host);
      assert.equal(second.effectResults[0].status, "not-started");
      const third = await applyWorkerPatchIntegration({ ...appInput(f), retryKnownNoWrite: true }, native.host);
      assert.equal(third.status, "applied");
      assert.equal(third.effectResults[0].attempts.length, 3);
      const attempts = third.effectResults[0].attempts;
      assert.equal(attempts[2].started.previousAttemptId, attempts[1].started.recordId);
      assert.equal(attempts[2].started.previousNativeIntentId, attempts[1].receipt.nativeIntentId);
      const inspections = native.calls.filter((call) => call.operation === "image-inspect");
      assert.equal(inspections.length, 2);
      assert.equal(inspections[1].payload.effect.previousIntentId, retainPriorOnSecond ? undefined : attempts[0].receipt.nativeIntentId);
      assert.equal(native.writes().length, 3);
    });
  }
});

test("a linked retry's receipt gap is reconciled against that retry's exact native predecessor", async (t) => {
  const f = await workerIntegrationFixture(t, { workers: [{ path: "a.txt", after: "new A" }] });
  const native = knownNoWriteHost();
  await applyWorkerPatchIntegration(appInput(f), native.host);
  const retried = await applyWorkerPatchIntegration({ ...appInput(f), retryKnownNoWrite: true }, native.host);
  assert.equal(retried.status, "applied");
  fs.unlinkSync(evidenceFile(f, ".effect-0.attempt-1.receipt.json"));
  assert.equal(current(f).effectResults[0].status, "unknown");
  native.completeInspection();
  const recovered = await reconcileWorkerPatchIntegration(appInput(f), native.host);
  assert.equal(recovered.status, "applied");
  const inspection = native.calls.filter((call) => call.operation === "image-inspect").at(-1);
  assert.equal(inspection.payload.effect.previousIntentId, retried.effectResults[0].attempts[0].receipt.nativeIntentId);
  assert.equal(recovered.effectResults[0].receipt.nativeIntentId, retried.effectResults[0].receipt.nativeIntentId);
  assert.equal(native.writes().length, 2);
});

test("late exact native completion adds evidence without rewriting an original unknown receipt", async (t) => {
  const f = await workerIntegrationFixture(t, { workers: [{ path: "a.txt", after: "new A" }] });
  const native = syntheticHost({
    apply: (request, options) => {
      fs.writeFileSync(path.join(f.root, "a.txt"), Buffer.from(request.payload.effect.after.content, "base64"));
      options.closed();
      return { status: "error", result: { status: "unknown", intentId: options.nativeIntentId }, error: { code: "SYNTHETIC_ACK_LOSS" } };
    },
  });
  const initial = await applyWorkerPatchIntegration(appInput(f), native.host);
  const originalReceipt = fs.readFileSync(evidenceFile(f, ".effect-0.receipt.json"));
  assert.equal(initial.effectResults[0].status, "unknown");
  assert.equal(initial.allEffectsCompleted, false);
  const wrongEffect = syntheticHost({
    inspect: () => ({
      status: "ok",
      result: {
        completionRecorded: true,
        status: "effect-observed",
        intentId: "different-native-intent",
      },
    }),
  });
  await assert.rejects(reconcileWorkerPatchIntegration(appInput(f), wrongEffect.host), { code: "WORKER_INTEGRATION_APPLICATION_CONFLICT" });
  assert.equal(fs.existsSync(evidenceFile(f, ".effect-0.reconciled.receipt.json")), false);
  fs.writeFileSync(path.join(f.root, "a.txt"), "user's later edit");
  const protectedBefore = protectedSnapshot(f);
  const completed = syntheticHost({
    inspect: () => ({
      status: "ok",
      result: {
        completionRecorded: true,
        status: "postimage-observed",
        intentId: initial.effectResults[0].receipt.nativeIntentId,
      },
    }),
  });
  const recovered = await reconcileWorkerPatchIntegration(appInput(f), completed.host);
  assert.equal(recovered.status, "applied");
  assert.equal(recovered.currentBasis.headReassessmentRequired, true);
  const attempt = recovered.effectResults[0].attempts[0];
  assert.equal(attempt.initialReceipt.recordId, initial.effectResults[0].receipt.recordId);
  assert.equal(attempt.initialReceipt.status, "unknown");
  assert.equal(attempt.reconciliationReceipt.previousReceiptId, attempt.initialReceipt.recordId);
  assert.equal(attempt.reconciliationReceipt.nativeCompletionRecorded, true);
  assert.equal(attempt.receipt.status, "applied");
  assert.deepEqual(fs.readFileSync(evidenceFile(f, ".effect-0.receipt.json")), originalReceipt);
  assert.equal(bytes(f.root, "a.txt"), "user's later edit");
  assert.deepEqual(protectedSnapshot(f), protectedBefore);
  const calls = completed.calls.length;
  const replay = await reconcileWorkerPatchIntegration(appInput(f), completed.host);
  assert.equal(replay.effectResults[0].receipt.recordId, attempt.receipt.recordId);
  assert.equal(completed.calls.length, calls);
  assert.deepEqual(completed.writes(), []);
  const reconciledFile = evidenceFile(f, ".effect-0.reconciled.receipt.json");
  const original = fs.readFileSync(reconciledFile);
  fs.writeFileSync(reconciledFile, JSON.stringify({ ...JSON.parse(original), recoveryAuthority: true }));
  try {
    assert.throws(() => current(f), { code: "WORKER_INTEGRATION_APPLICATION_CONFLICT" });
  } finally {
    fs.writeFileSync(reconciledFile, original);
  }
});

test("dependency drift between effects pauses only remaining work until fresh HEAD reassessment", async (t) => {
  const f = await workerIntegrationFixture(t, {
    workers: [
      { path: "a.txt", after: "new A" },
      { path: "b.txt", after: "new B" },
    ],
    readDependencies: ["config.txt"],
  });
  const before = protectedSnapshot(f);
  const native = syntheticHost({
    apply: (request) => {
      if (request.payload.effect.path === "a.txt") fs.writeFileSync(path.join(f.root, "config.txt"), "changed during first effect");
    },
  });
  const partial = await applyWorkerPatchIntegration(appInput(f), native.host);
  assert.equal(partial.action, "refresh-lode-assessment");
  assert.deepEqual(
    partial.effectResults.map((effect) => effect.status),
    ["applied", "not-attempted"],
  );
  assert.deepEqual(
    native.writes().map((call) => call.path),
    ["a.txt"],
  );
  assert.equal(partial.currentBasis.headReassessmentRequired, true);
  const assessed = await applyWorkerPatchIntegration({ ...appInput(f), basisDigest: partial.currentBasis.basisDigest }, native.host);
  assert.equal(assessed.status, "applied");
  assert.deepEqual(
    native.writes().map((call) => call.path),
    ["a.txt", "b.txt"],
  );
  assert.equal(bytes(f.root, "config.txt"), "changed during first effect");
  assert.deepEqual(protectedSnapshot(f), before);
});

test("prepared not-published proof permits explicit same-intent reoffers with immutable P3 history", async (t) => {
  const f = await workerIntegrationFixture(t, { workers: [{ path: "a.txt", after: "new A" }] });
  const protectedBefore = protectedSnapshot(f);
  const native = preparedSyntheticHost(f, { failures: 2 });
  const first = await applyWorkerPatchIntegration(appInput(f), native.host);
  assert.equal(first.effectResults[0].status, "not-started", JSON.stringify(first));
  const original = first.effectResults[0].receipt;
  assert.equal(original.terminalProof.provenance, "trusted-host-fixture");
  assert.equal(original.terminalProof.ownedChildClosed, true);
  assert.equal(original.terminalProof.nativeResponse.result.intentPublication, "not-attempted");
  const originalBytes = fs.readFileSync(evidenceFile(f, ".effect-0.receipt.json"));
  assert.equal((await applyWorkerPatchIntegration(appInput(f), native.host)).action, "reconcile-started-effect");
  await reconcileWorkerPatchIntegration(appInput(f), native.host);
  assert.equal(native.writes().length, 1);
  const second = await applyWorkerPatchIntegration({ ...appInput(f), retryKnownNoWrite: true }, native.host);
  assert.equal(second.effectResults[0].status, "not-started");
  const secondBytes = fs.readFileSync(evidenceFile(f, ".effect-0.attempt-1.receipt.json"));
  const third = await applyWorkerPatchIntegration({ ...appInput(f), retryKnownNoWrite: true }, native.host);
  assert.equal(third.status, "applied", JSON.stringify(third));
  const attempts = third.effectResults[0].attempts;
  assert.equal(attempts.length, 3);
  assert.deepEqual(
    attempts.map((item) => item.started.retryBasisKind),
    [null, "not-published", "not-published"],
  );
  assert.deepEqual(
    native.writes().map((item) => item.operation),
    ["image-apply", "image-apply", "image-apply"],
  );
  assert.equal(new Set(native.writes().map((item) => canonicalJson(item.payload))).size, 1);
  assert.equal(new Set(native.writes().map((item) => item.requestId)).size, 3);
  assert.equal(new Set(attempts.map((item) => item.started.preDispatchBinding.expectedNativeIntentId)).size, 1);
  assert.equal(new Set(attempts.map((item) => item.receipt.nativeIntentId)).size, 1);
  for (let i = 1; i < attempts.length; i++) {
    assert.equal(attempts[i].started.previousAttemptId, attempts[i - 1].started.recordId);
    assert.equal(attempts[i].started.previousNativeIntentId, null);
    assert.equal(attempts[i].started.retryInspection, null);
  }
  assert.deepEqual(fs.readFileSync(evidenceFile(f, ".effect-0.receipt.json")), originalBytes);
  assert.deepEqual(fs.readFileSync(evidenceFile(f, ".effect-0.attempt-1.receipt.json")), secondBytes);
  assert.equal(bytes(f.root, "a.txt"), "new A");
  assert.deepEqual(protectedSnapshot(f), protectedBefore);
  assert.ok(native.children.every((child) => child.closed));
});

test("prepared durable native no-write still follows image-retry rather than initial reoffer", async (t) => {
  const f = await workerIntegrationFixture(t, { workers: [{ path: "a.txt", after: "new A" }] });
  const native = preparedSyntheticHost(f, { first: "published" });
  await applyWorkerPatchIntegration(appInput(f), native.host);
  const applied = await applyWorkerPatchIntegration({ ...appInput(f), retryKnownNoWrite: true }, native.host);
  assert.equal(applied.status, "applied", JSON.stringify(applied));
  assert.deepEqual(
    native.writes().map((item) => item.operation),
    ["image-apply", "image-retry"],
  );
  assert.equal(applied.effectResults[0].started.retryBasisKind, "native-no-write");
  assert.equal(applied.effectResults[0].started.retryInspection.noWriteRecorded, true);
  assert.notEqual(applied.effectResults[0].receipt.nativeIntentId, applied.effectResults[0].attempts[0].receipt.nativeIntentId);
});

test("prepared incomplete, truncated, or unowned outcomes never become retry-safe", async (t) => {
  for (const first of ["partial", "truncated", "owner-unverified"])
    await t.test(first, async (t) => {
      const f = await workerIntegrationFixture(t, { workers: [{ path: "a.txt", after: "new A" }] });
      const original = bytes(f.root, "a.txt");
      const native = preparedSyntheticHost(f, { first });
      const result = await applyWorkerPatchIntegration(appInput(f), native.host);
      assert.equal(result.effectResults[0].status, "unknown");
      if (first !== "partial") assert.equal(result.effectResults[0].receipt.terminalProof, null);
      const effectCount = native.writes().length;
      const replay = await applyWorkerPatchIntegration({ ...appInput(f), retryKnownNoWrite: true }, native.host);
      assert.equal(replay.action, "reconcile-started-effect");
      assert.equal(native.writes().length, effectCount);
      assert.equal(replay.effectResults[0].attempts.length, 1);
      assert.equal(bytes(f.root, "a.txt"), original);
      assert.ok(native.children.every((child) => child.closed));
    });
});

test("prepared not-published proof cannot recreate a lost P5 journal or overwrite user bytes", async (t) => {
  for (const change of ["journal-loss", "user-edit"])
    await t.test(change, async (t) => {
      const f = await workerIntegrationFixture(t, { workers: [{ path: "a.txt", after: "new A" }] });
      const native = preparedSyntheticHost(f);
      await applyWorkerPatchIntegration(appInput(f), native.host);
      const journal = native.writes()[0].payload.journal;
      if (change === "journal-loss") fs.renameSync(journal, `${journal}.retired-by-test`);
      else fs.writeFileSync(path.join(f.root, "a.txt"), "later user edit");
      const basisDigest = current(f).currentBasis.basisDigest;
      const result = await applyWorkerPatchIntegration({ ...appInput(f), basisDigest, retryKnownNoWrite: true }, native.host);
      assert.equal(result.action, change === "journal-loss" ? "host-effect-evidence-unavailable" : "retry-basis-unavailable");
      assert.equal(native.writes().length, 1);
      assert.equal(result.effectResults[0].attempts.length, 1);
      if (change === "journal-loss") assert.equal(fs.existsSync(journal), false);
      else assert.equal(bytes(f.root, "a.txt"), "later user edit");
    });
});

test("prepared retry rechecks source after preparation before another started attempt", async (t) => {
  const f = await workerIntegrationFixture(t, { workers: [{ path: "a.txt", after: "new A" }] });
  const native = preparedSyntheticHost(f, {
    afterPrepare: ({ prepared }) => {
      if (prepared.length === 2) fs.writeFileSync(path.join(f.root, "a.txt"), "edit during preparation");
    },
  });
  await applyWorkerPatchIntegration(appInput(f), native.host);
  const result = await applyWorkerPatchIntegration({ ...appInput(f), retryKnownNoWrite: true }, native.host);
  assert.equal(result.action, "refresh-lode-assessment");
  assert.equal(result.effectResults[0].attempts.length, 1);
  assert.equal(native.writes().length, 1);
  assert.equal(fs.existsSync(evidenceFile(f, ".effect-0.attempt-1.started.json")), false);
  assert.equal(bytes(f.root, "a.txt"), "edit during preparation");
});

test("prepared not-published retry cannot switch to an already-created journal under another operational root", async (t) => {
  const f = await workerIntegrationFixture(t, { workers: [{ path: "a.txt", after: "new A" }] });
  const native = preparedSyntheticHost(f);
  const first = await applyWorkerPatchIntegration(appInput(f), native.host);
  const originalRoot = process.env[RUNTIME_OPERATIONAL_STATE_ENV];
  const replacement = path.join(f.container, "replacement-operational");
  const replacementJournal = path.join(replacement, path.relative(originalRoot, native.writes()[0].payload.journal));
  fs.mkdirSync(replacementJournal, { recursive: true });
  const originalBytes = fs.readFileSync(evidenceFile(f, ".effect-0.receipt.json"));
  process.env[RUNTIME_OPERATIONAL_STATE_ENV] = replacement;
  try {
    const replay = await applyWorkerPatchIntegration({ ...appInput(f), retryKnownNoWrite: true }, native.host);
    assert.equal(replay.action, "host-effect-evidence-unavailable");
    assert.equal(replay.reason, "effect-journal-binding-changed");
    assert.equal(replay.effectResults[0].attempts.length, 1);
    assert.equal(replay.claim.recordId, first.claim.recordId);
    assert.equal(native.writes().length, 1);
    assert.deepEqual(fs.readdirSync(replacementJournal), []);
    assert.deepEqual(fs.readFileSync(evidenceFile(f, ".effect-0.receipt.json")), originalBytes);
  } finally {
    process.env[RUNTIME_OPERATIONAL_STATE_ENV] = originalRoot;
  }
});

test("prepared valid but mismatched request or journal binding is rejected before dispatch", async (t) => {
  for (const mismatch of ["request-id", "journal"])
    await t.test(mismatch, async (t) => {
      const f = await workerIntegrationFixture(t, { workers: [{ path: "a.txt", after: "new A" }] });
      const protectedBefore = protectedSnapshot(f);
      const native = preparedSyntheticHost(f);
      const prepare = native.host.prepareFileEffect;
      native.host.prepareFileEffect = (request, options) =>
        prepare(
          mismatch === "request-id"
            ? { ...request, requestId: "another-claim-bound-request" }
            : { ...request, payload: { ...request.payload, journal: path.join(f.operational, "other-journal") } },
          options,
        );
      await assert.rejects(
        applyWorkerPatchIntegration(appInput(f), native.host),
        mismatch === "request-id" ? { code: "INVALID_WORKER_FILE_EFFECT_RESPONSE" } : { code: "WORKER_INTEGRATION_APPLICATION_CONFLICT" },
      );
      assert.equal(current(f).effectResults[0].attempts.length, 0);
      assert.equal(native.writes().length, 0);
      assert.deepEqual(protectedSnapshot(f), protectedBefore);
    });
});

test("prepared request, binary, and owned-close mismatches cannot grant retry rights", async (t) => {
  for (const corruption of ["request", "binary", "owned-close", "claim-target"])
    await t.test(corruption, async (t) => {
      const f = await workerIntegrationFixture(t, { workers: [{ path: "a.txt", after: "new A" }] });
      const native = preparedSyntheticHost(f, {
        transformResult: (result) => {
          const altered = structuredClone(result);
          if (corruption === "request") altered.response.requestId = "another-request";
          if (corruption === "binary") altered.terminalProof.binding.binaryIdentity.binarySha256 = "f".repeat(64);
          if (corruption === "owned-close") altered.terminalProof.ownedChildClosed = false;
          if (corruption === "claim-target") altered.terminalProof.binding.canonicalEffectDigest = "e".repeat(64);
          return altered;
        },
      });
      const result = await applyWorkerPatchIntegration(appInput(f), native.host);
      assert.equal(result.effectResults[0].status, "unknown");
      assert.equal(result.effectResults[0].receipt.terminalProof, null);
      assert.equal((await applyWorkerPatchIntegration({ ...appInput(f), retryKnownNoWrite: true }, native.host)).action, "reconcile-started-effect");
      assert.equal(native.writes().length, 1);
    });
});

test("prepared binary change after binding starts no child and leaves non-retryable evidence", async (t) => {
  const f = await workerIntegrationFixture(t, { workers: [{ path: "a.txt", after: "new A" }] });
  const native = preparedSyntheticHost(f, { afterPrepare: ({ binaryFile }) => fs.appendFileSync(binaryFile, "changed") });
  const result = await applyWorkerPatchIntegration(appInput(f), native.host);
  assert.equal(result.effectResults[0].status, "unknown");
  assert.equal(result.effectResults[0].receipt.ownerQuiescent, false);
  assert.equal(native.writes().length, 0);
  assert.equal((await applyWorkerPatchIntegration({ ...appInput(f), retryKnownNoWrite: true }, native.host)).action, "reconcile-started-effect");
  assert.equal(native.writes().length, 0);
});

test("prepared proof cannot replace an earlier unknown or survive nested proof tamper", async (t) => {
  const f = await workerIntegrationFixture(t, { workers: [{ path: "a.txt", after: "new A" }] });
  const unproved = syntheticHost({
    apply: (_request, options) => {
      options.closed();
      throw new Error("unknown first attempt");
    },
  });
  await applyWorkerPatchIntegration(appInput(f), unproved.host);
  const original = fs.readFileSync(evidenceFile(f, ".effect-0.receipt.json"));
  const native = preparedSyntheticHost(f);
  const unknown = await applyWorkerPatchIntegration({ ...appInput(f), retryKnownNoWrite: true }, native.host);
  assert.equal(unknown.action, "reconcile-started-effect");
  assert.equal(native.writes().length, 0);
  assert.deepEqual(fs.readFileSync(evidenceFile(f, ".effect-0.receipt.json")), original);
  const other = await f.addIntegration({ workers: [{ path: "b.txt", after: "new B" }] });
  const otherInput = { root: f.root, integrationId: other.integrationId, storage: f.storage };
  const fresh = await applyWorkerPatchIntegration(otherInput, native.host);
  rewriteSyntheticEvidence(evidenceFile(f, ".effect-0.receipt.json"), (receipt) => {
    receipt.terminalProof = fresh.effectResults[0].receipt.terminalProof;
  });
  assert.throws(() => current(f), /Terminal evidence lacks its pre-dispatch binding/);
  fs.writeFileSync(evidenceFile(f, ".effect-0.receipt.json"), original);
  const otherReceiptFile = path.join(
    f.root,
    relativeProjectArtifact(f.storage, "runtime", "worker-integrations"),
    `${other.integrationId}.effect-0.receipt.json`,
  );
  rewriteSyntheticEvidence(otherReceiptFile, (receipt) => {
    receipt.terminalProof.nativeResponse.result.intentPublication = "published";
  });
  assert.throws(() => readWorkerPatchApplication(otherInput), { code: "INVALID_WORKER_FILE_EFFECT_RESPONSE" });
});

test("unobservable read-only dependency is not an eternal reservation on a quiescent effect", async (t) => {
  const f = await workerIntegrationFixture(t, { workers: [{ path: "a.txt", after: "new A" }], readDependencies: ["config.txt"] });
  const native = syntheticHost({
    apply: (_request, options) => {
      options.closed();
      throw Object.assign(new Error("Unknown effect"), { code: "SYNTHETIC_UNKNOWN" });
    },
  });
  await applyWorkerPatchIntegration(appInput(f), native.host);
  fs.linkSync(path.join(f.root, "config.txt"), path.join(f.root, "config-alias.txt"));
  const observed = current(f);
  assert.equal(observed.currentBasis.allDependenciesObservable, false);
  assert.equal(observed.currentBasis.dependencies.find((item) => item.path === "config.txt").observed.kind, "unverifiable");
  const settled = await settleIncompleteWorkerPatchIntegration({
    ...appInput(f),
    basisDigest: observed.currentBasis.basisDigest,
    reason: "Exact effect owner is quiescent and target inspected; unrelated read dependency needs separate investigation.",
  });
  assert.equal(settled.status, "incomplete");
  assert.equal(settled.outstanding, false);
  assert.equal(settled.effectResults[0].status, "unknown");
  assert.equal(native.writes().length, 1);
});

import { relativeProjectArtifact } from "../scripts/lib/project-storage-format.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { workerIntegrationFixture } from "./helpers/worker-integration-fixture.mjs";
import { inspectProject } from "../scripts/lib/head-core.mjs";
import { createResultPacket, readLineageArtifact } from "../scripts/lib/execution-lineage.mjs";
import { getPendingReviewContext, reviewRun, startRun } from "../scripts/lib/run-lineage.mjs";
import { createRecoveryCheckpoint } from "../scripts/lib/compaction-recovery.mjs";
import {
  applyWorkerPatchIntegration,
  readWorkerPatchApplication,
  reconcileWorkerPatchIntegration,
  settleIncompleteWorkerPatchIntegration,
} from "../scripts/lib/worker-integration-application.mjs";
import { prepareWorkerIntegrationResult, publishWorkerIntegrationResult, readWorkerIntegrationResult } from "../scripts/lib/worker-integration-result.mjs";
import { integrationDigest, integrationJson } from "../scripts/lib/worker-integration-store.mjs";
import { artifactAuthorityBoundary } from "../scripts/lib/authority-plane-contract.mjs";

console.log(
  JSON.stringify({
    event: "owned-worker-integration-result-test",
    pid: process.pid,
    parentPid: process.ppid,
    command: process.execPath,
    args: process.argv.slice(1),
    cwd: process.cwd(),
    ports: [],
    actualProviderInvoked: false,
  }),
);

const headReport = {
  outcome: " HEAD verified the combined synthetic result ",
  evidence: [{ check: "all selected sources inspected", scope: "fixture-only" }],
  verification: [{ check: "whole result", status: "passed", actualProviderInvoked: false }],
  planDelta: "",
  impactRadius: ["fixture"],
  unknowns: ["Real provider and native file effects are not exercised by this fixture"],
};
const input = (f) => ({ root: f.root, integrationId: f.integrationId, storage: f.storage });
const reportInput = (f, extra = {}) => ({ ...input(f), basisDigest: f.readBasis().basisDigest, ...headReport, ...extra });
const receiptFile = (f) =>
  path.join(f.root, relativeProjectArtifact(f.storage, "runtime", "worker-integrations"), `${f.integrationId}--result-application.json`);
const verificationFile = (f, id) => path.join(f.root, relativeProjectArtifact(f.storage, "runtime", "worker-integrations"), `${f.integrationId}--${id}.json`);
function p2(f) {
  return { session: fs.readFileSync(f.sessionFile, "utf8"), run: fs.readFileSync(f.runFile, "utf8") };
}
function files(root) {
  const result = {};
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else result[path.relative(root, file)] = fs.readFileSync(file).toString("base64");
    }
  }
  walk(root);
  return result;
}
async function prepared(t, options) {
  const f = await workerIntegrationFixture(t, options);
  assert.equal((await applyWorkerPatchIntegration({ ...input(f), basisDigest: f.readBasis().basisDigest })).status, "applied");
  const result = await prepareWorkerIntegrationResult(reportInput(f));
  return { ...f, verification: result.verification, publication: { ...input(f), verificationId: result.verification.verificationId } };
}
function accept(root) {
  return reviewRun({
    root,
    reviewContextId: getPendingReviewContext({ root }).review.reviewContextId,
    disposition: "accept",
    rationale: "Explicit synthetic HEAD review",
    nextActions: ["Continue the accepted direction"],
  });
}

test("one whole packet retains two members and waits for explicit Fresh Lode review and P2 checkpoint", async (t) => {
  const f = await workerIntegrationFixture(t);
  assert.equal(f.intent.composition.patches.length, 0);
  const unchanged = p2(f);
  await assert.rejects(prepareWorkerIntegrationResult(reportInput(f)), { code: "WORKER_INTEGRATION_EFFECTS_INCOMPLETE" });
  assert.deepEqual(p2(f), unchanged, "no-op still needs explicit application, not implicit finish");
  assert.equal((await applyWorkerPatchIntegration({ ...input(f), basisDigest: f.readBasis().basisDigest })).status, "applied");
  const prepared = await prepareWorkerIntegrationResult(reportInput(f));
  assert.equal(prepared.verification.authorityBoundary.planeId, "P3");
  assert.deepEqual(p2(f), unchanged);
  const packet = prepared.verification.wholeResultPacket;
  assert.equal(packet.evidence[0].memberProvenance.length, 2);
  assert.deepEqual(
    packet.evidence[0].memberProvenance.map((member) => member.authorizationId),
    f.members.map((member) => member.authorizationId),
  );
  assert.ok(packet.evidence[0].memberProvenance.every((member) => member.actualProviderInvoked === false));
  assert.equal(Object.hasOwn(packet.evidence[0], "authorizationId"), false, "no representative worker impersonation");
  assert.equal(packet.outcome, headReport.outcome.trim());
  const published = await publishWorkerIntegrationResult({ ...input(f), verificationId: prepared.verification.verificationId });
  assert.equal(published.status, "published");
  assert.equal(published.resultPacket.resultPacketId, packet.resultPacketId);
  assert.equal(published.application.authorityBoundary.planeId, "P3");
  assert.equal(published.application.freshLodeReviewRequired, true);
  assert.equal(inspectProject(f.root).state.lastReviewDecisionId, null);
  assert.equal(inspectProject(f.root).state.pendingReview.runId, f.run.runId);
  assert.equal(fs.readdirSync(path.join(f.root, relativeProjectArtifact(f.storage, "lineage", "result-packets"))).length, 1);
  assert.equal(fs.existsSync(path.join(f.root, relativeProjectArtifact(f.storage, "lineage", "review-decisions"))), false);
  const frozen = files(f.root);
  assert.equal(readWorkerIntegrationResult(input(f)).status, "published");
  assert.equal((await publishWorkerIntegrationResult({ ...input(f), verificationId: prepared.verification.verificationId })).status, "already-published");
  assert.deepEqual(files(f.root), frozen);
  accept(f.root);
  assert.equal(inspectProject(f.root).state.lastReviewedRunId, f.run.runId);
  createRecoveryCheckpoint({
    root: f.root,
    purpose: "Explicit HEAD integration",
    approvedDecisions: [],
    currentPosition: "Reviewed the whole result",
    nextExpectedResult: "Proceed with current direction",
    openReviewIds: [],
  });
  assert.equal(readWorkerIntegrationResult(input(f)).application.applicationId, published.application.applicationId);
});

test("stale dependency assessment requests fresh Lode verification without permanently reserving publication", async (t) => {
  const f = await prepared(t, { readDependencies: ["settings.txt"] });
  const before = p2(f);
  fs.writeFileSync(path.join(f.root, "settings.txt"), "new relevant settings\n");
  assert.equal(f.readBasis().headReassessmentRequired, true);
  await assert.rejects(publishWorkerIntegrationResult(f.publication), { code: "WORKER_INTEGRATION_REVERIFICATION_REQUIRED" });
  assert.deepEqual(p2(f), before);
  const next = await prepareWorkerIntegrationResult(reportInput(f, { outcome: "HEAD reassessed updated dependency" }));
  assert.notEqual(next.verification.verificationId, f.verification.verificationId);
  assert.equal(readWorkerIntegrationResult(f.publication).verification.verificationId, f.verification.verificationId);
  assert.equal((await publishWorkerIntegrationResult({ ...input(f), verificationId: next.verification.verificationId })).status, "published");
  await assert.rejects(publishWorkerIntegrationResult(f.publication), { code: "WORKER_INTEGRATION_RESULT_CONFLICT" });
});

test("repeated exact verification is create-only and failure evidence is not promoted to semantic success", async (t) => {
  const f = await prepared(t);
  const before = files(f.root);
  assert.equal((await prepareWorkerIntegrationResult(reportInput(f))).status, "existing");
  assert.deepEqual(files(f.root), before);
  for (const extra of [{ evidence: [] }, { verification: [] }, { outcome: " " }, { basisDigest: "0".repeat(64) }]) {
    await assert.rejects(prepareWorkerIntegrationResult(reportInput(f, extra)));
    assert.deepEqual(files(f.root), before);
  }
  const assessment = await prepareWorkerIntegrationResult(
    reportInput(f, { outcome: "Combined check failed; needs revision", verification: [{ status: "failed" }] }),
  );
  const published = await publishWorkerIntegrationResult({ ...input(f), verificationId: assessment.verification.verificationId });
  assert.deepEqual(published.resultPacket.verification[0].checks, [{ status: "failed" }]);
  assert.equal(published.resultPacket.reviewDecisionCreated, false);
  assert.equal(inspectProject(f.root).state.pendingReview.resultPacketId, published.resultPacket.resultPacketId);
});

test("incomplete or outstanding file effects cannot finish a Run", async (t) => {
  const f = await prepared(t);
  const before = p2(f);
  for (const change of [{ status: "incomplete", allEffectsCompleted: false }, { outstanding: true }, { status: "applying" }]) {
    await assert.rejects(publishWorkerIntegrationResult(f.publication, { readApplication: (args) => ({ ...readWorkerPatchApplication(args), ...change }) }), {
      code: "WORKER_INTEGRATION_EFFECTS_INCOMPLETE",
    });
    assert.deepEqual(p2(f), before);
  }
});

async function failPublication(f) {
  const link = fs.linkSync;
  let injected = false;
  fs.linkSync = (source, target) => {
    if (target === receiptFile(f)) {
      injected = true;
      throw Object.assign(new Error("Synthetic receipt crash"), { code: "EIO" });
    }
    return link(source, target);
  };
  try {
    await assert.rejects(publishWorkerIntegrationResult(f.publication), { code: "EIO" });
  } finally {
    fs.linkSync = link;
  }
  assert.equal(injected, true);
}

test("publication-receipt crash recovers the exact pending packet despite later source drift", async (t) => {
  const f = await prepared(t);
  await failPublication(f);
  assert.equal(inspectProject(f.root).state.pendingReview.resultPacketId, f.verification.wholeResultPacket.resultPacketId);
  fs.writeFileSync(path.join(f.root, "a.txt"), "later evidence is not a re-execution authorization\n");
  const currentP2 = p2(f);
  const recovered = await publishWorkerIntegrationResult(f.publication, {
    readApplication: () => {
      throw new Error("must not reapply or gate a frozen transition");
    },
  });
  assert.equal(recovered.resultPacket.resultPacketId, f.verification.wholeResultPacket.resultPacketId);
  assert.deepEqual(p2(f), currentP2);
  assert.equal(fs.readdirSync(path.join(f.root, relativeProjectArtifact(f.storage, "lineage", "result-packets"))).length, 1);
});

test("missing receipt never lets delayed A finish later B even when it reuses the same contract", async (t) => {
  const f = await prepared(t);
  await failPublication(f);
  accept(f.root);
  const next = startRun({ root: f.root, executionContractId: f.contract.executionContractId }).run;
  const before = files(f.root);
  await assert.rejects(publishWorkerIntegrationResult(f.publication), { code: "WORKER_INTEGRATION_RESULT_CONFLICT" });
  assert.deepEqual(files(f.root), before);
  assert.equal(inspectProject(f.root).state.activeRunId, next.runId);
});

test("existing receipt is historical across later Run, Session, source and managed projection drift", async (t) => {
  const f = await prepared(t);
  const published = await publishWorkerIntegrationResult(f.publication);
  accept(f.root);
  startRun({ root: f.root, executionContractId: f.contract.executionContractId });
  const state = JSON.parse(fs.readFileSync(f.sessionFile));
  fs.writeFileSync(f.sessionFile, JSON.stringify({ ...state, sessionId: "session-00000000-0000-4000-8000-000000000001" }));
  fs.appendFileSync(path.join(f.root, "a.txt"), "source drift");
  fs.appendFileSync(path.join(f.root, "AGENTS.md"), "\nSynthetic managed projection drift\n");
  const before = files(f.root);
  const history = readWorkerIntegrationResult(input(f));
  assert.equal(history.application.applicationId, published.application.applicationId);
  assert.equal((await publishWorkerIntegrationResult(f.publication)).status, "already-published");
  assert.deepEqual(files(f.root), before);
});

function freshPublicationRetry(publication) {
  const moduleUrl = new URL("../scripts/lib/worker-integration-result.mjs", import.meta.url).href;
  const cwd = path.resolve(import.meta.dirname, "..");
  const code = `import { publishWorkerIntegrationResult } from ${JSON.stringify(moduleUrl)};
    const result = await publishWorkerIntegrationResult(${JSON.stringify(publication)}, {
      readApplication: () => { throw new Error("frozen transition must not reobserve or replay effects"); }
    });
    console.log(JSON.stringify(result));`;
  console.log(
    JSON.stringify({
      event: "owned-worker-result-retry-launch",
      parentPid: process.pid,
      command: process.execPath,
      args: ["--input-type=module", "--eval", "exact worker result publication retry"],
      cwd,
      ports: [],
    }),
  );
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", code], { cwd, encoding: "utf8", windowsHide: true, timeout: 60_000 });
  console.log(
    JSON.stringify({ event: "owned-worker-result-retry-exit", pid: child.pid, parentPid: process.pid, status: child.status, signal: child.signal, ports: [] }),
  );
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  return JSON.parse(child.stdout.trim());
}

// The final Run freezes the exact packet, then no-clobber artifact publication,
// then the Session update. There is no preparatory Run publication anymore.
for (const boundary of ["run", "artifact", "session"]) {
  test(`partial finish recovers one exact whole packet after ${boundary} write`, async (t) => {
    const f = await prepared(t);
    const rename = fs.renameSync,
      link = fs.linkSync;
    let injected = false;
    fs.renameSync = (source, target) => {
      let match = boundary === "session" && target === f.sessionFile;
      if (boundary === "run" && target === f.runFile) {
        const run = JSON.parse(fs.readFileSync(source));
        match = run.sessionTransition?.kind === "finish" && run.status === "awaiting_review";
      }
      if (!injected && match) {
        injected = true;
        rename(source, target);
        throw Object.assign(new Error("Synthetic finish crash"), { code: "EIO" });
      }
      return rename(source, target);
    };
    fs.linkSync = (source, target) => {
      const match = boundary === "artifact" && path.basename(path.dirname(target)) === "result-packets";
      if (!injected && match) {
        injected = true;
        link(source, target);
        throw Object.assign(new Error("Synthetic artifact crash"), { code: "EIO" });
      }
      return link(source, target);
    };
    try {
      if (boundary === "session") {
        const committed = await publishWorkerIntegrationResult(f.publication);
        assert.equal(committed.canonicalCommit, "committed");
        assert.equal(committed.executionReplayAllowed, false);
      } else await assert.rejects(publishWorkerIntegrationResult(f.publication), { code: "EIO" });
    } finally {
      fs.renameSync = rename;
      fs.linkSync = link;
    }
    assert.equal(injected, true);
    const packetFile = path.join(
      f.root,
      relativeProjectArtifact(f.storage, "lineage", "result-packets"),
      `${f.verification.wholeResultPacket.resultPacketId}.json`,
    );
    assert.equal(JSON.parse(fs.readFileSync(f.runFile)).resultPacketId, f.verification.wholeResultPacket.resultPacketId);
    assert.equal(fs.existsSync(packetFile), boundary !== "run", "the frozen Run precedes the exact artifact publication");
    assert.equal(inspectProject(f.root).state.pendingReview?.runId ?? null, boundary === "session" ? f.run.runId : null);
    assert.equal(
      fs.existsSync(receiptFile(f)),
      boundary === "session",
      "exact committed Session publication can acknowledge storage despite staging cleanup failure",
    );
    const beforeRead = files(f.root);
    inspectProject(f.root);
    assert.deepEqual(files(f.root), beforeRead, "inspection does not repair an interrupted publication");
    fs.writeFileSync(path.join(f.root, "b.txt"), "new observation after exact finish was frozen");
    const retry = freshPublicationRetry(f.publication);
    assert.equal(retry.resultPacket.resultPacketId, f.verification.wholeResultPacket.resultPacketId);
    assert.deepEqual(retry.resultPacket, f.verification.wholeResultPacket, "fresh process preserves the frozen assessment and unknowns");
    assert.equal(inspectProject(f.root).state.pendingReview.runId, f.run.runId);
    assert.equal(inspectProject(f.root).state.lastReviewDecisionId, null);
    assert.equal(fs.readFileSync(path.join(f.root, "b.txt"), "utf8"), "new observation after exact finish was frozen");
    assert.equal(fs.readdirSync(path.join(f.root, relativeProjectArtifact(f.storage, "lineage", "result-packets"))).length, 1);
    const completed = files(f.root);
    assert.equal((await publishWorkerIntegrationResult(f.publication)).status, "already-published");
    assert.deepEqual(files(f.root), completed, "completed retry cannot apply or publish twice");
  });
}

test("source and current target are checked again after an awaited application observation", async (t) => {
  for (const changed of ["source", "session"]) {
    const f = await prepared(t);
    const before = p2(f);
    await assert.rejects(
      publishWorkerIntegrationResult(f.publication, {
        readApplication: async (args) => {
          const view = readWorkerPatchApplication(args);
          if (changed === "source") fs.writeFileSync(path.join(f.root, "a.txt"), "raced dependency");
          else fs.writeFileSync(f.sessionFile, JSON.stringify({ ...JSON.parse(before.session), activeRunId: "run-1-abcdef" }));
          return view;
        },
      }),
    );
    assert.equal(fs.readFileSync(f.runFile, "utf8"), before.run);
    assert.equal(fs.existsSync(receiptFile(f)), false);
  }
});

test("tampered verification or stored canonical result is rejected without changing P2", async (t) => {
  const f = await prepared(t);
  const file = verificationFile(f, f.verification.verificationId);
  const original = fs.readFileSync(file);
  fs.writeFileSync(file, JSON.stringify({ ...f.verification, recoveryAuthority: true }));
  const before = p2(f);
  assert.throws(() => readWorkerIntegrationResult(f.publication), { code: "WORKER_INTEGRATION_RESULT_CONFLICT" });
  await assert.rejects(publishWorkerIntegrationResult(f.publication), { code: "WORKER_INTEGRATION_RESULT_CONFLICT" });
  assert.deepEqual(p2(f), before);
  fs.writeFileSync(file, original);
  const published = await publishWorkerIntegrationResult(f.publication);
  const stored = readLineageArtifact({ root: f.root, artifactId: published.resultPacket.resultPacketId });
  fs.writeFileSync(stored.file, JSON.stringify({ ...stored.artifact, outcome: "tampered outcome" }));
  const after = p2(f);
  assert.throws(() => readWorkerIntegrationResult(input(f)), { code: "LINEAGE_DIGEST_MISMATCH" });
  assert.deepEqual(p2(f), after);
});

test("an existing corrupt target packet is rejected before preparing a P2 finish transition", async (t) => {
  const f = await prepared(t);
  const packet = f.verification.wholeResultPacket;
  createResultPacket({ root: f.root, ...packet });
  const stored = readLineageArtifact({ root: f.root, artifactId: packet.resultPacketId });
  fs.writeFileSync(stored.file, JSON.stringify({ ...packet, outcome: "tamper before initial publication" }));
  const before = p2(f);
  await assert.rejects(publishWorkerIntegrationResult(f.publication), { code: "LINEAGE_DIGEST_MISMATCH" });
  assert.deepEqual(p2(f), before);
  assert.equal(JSON.parse(before.run).sessionTransition.kind, "start", "corrupt result cannot replace the existing exact start transition with finish");
  assert.equal(fs.existsSync(receiptFile(f)), false);
});

test("rehashing a receipt cannot substitute an unrelated Fresh Lode review reference", async (t) => {
  const f = await prepared(t);
  const published = await publishWorkerIntegrationResult(f.publication);
  const { applicationId: ignoredId, applicationHash: ignoredHash, ...payload } = published.application;
  payload.reviewContextHash = "a".repeat(64);
  payload.reviewContextId = `fresh-head-review-${"a".repeat(24)}`;
  const applicationHash = integrationDigest(integrationJson(payload));
  fs.writeFileSync(
    receiptFile(f),
    JSON.stringify({ ...payload, applicationHash, applicationId: `worker-integration-result-application-${applicationHash.slice(0, 24)}` }),
  );
  const before = files(f.root);
  assert.throws(() => readWorkerIntegrationResult(input(f)), { code: "WORKER_INTEGRATION_RESULT_CONFLICT" });
  await assert.rejects(publishWorkerIntegrationResult(f.publication), { code: "WORKER_INTEGRATION_RESULT_CONFLICT" });
  assert.deepEqual(files(f.root), before);
});

// Trusted in-process synthetic Host responses only; no native/model/process is
// invoked. The actual native bridge has separate connected integration tests.
async function partialFixture(t, { ownerQuiescent = true, failure = "not-started", readDependencies = [], complete = false } = {}) {
  const f = await workerIntegrationFixture(t, {
    readDependencies,
    workers: [
      { path: "a.txt", after: "applied A" },
      { path: "b.txt", after: "unapplied B" },
      { path: "c.txt", after: "unattempted C" },
    ],
  });
  const calls = [];
  const host = {
    fileEffect: async (request, options) => {
      const effect = request.payload.effect;
      calls.push({ operation: request.operation, path: effect.path });
      if (request.operation === "image-preflight")
        return {
          status: "ok",
          result: { status: "supported", rootIdentity: "synthetic-root", ancestorIdentities: effect.path.split("/").map(() => "synthetic-root") },
        };
      assert.equal(request.operation, "image-apply");
      if (complete || effect.path === "a.txt") {
        fs.writeFileSync(path.join(f.root, effect.path), Buffer.from(effect.after.content, "base64"));
        options.onProcess({ type: "exit", cleanupVerified: true });
        return { status: "ok", result: { status: "effect-observed", intentId: "synthetic-native-A" } };
      }
      assert.equal(effect.path, "b.txt");
      if (ownerQuiescent) options.onProcess({ type: "exit", cleanupVerified: true });
      return { status: "error", result: { status: failure, intentId: "synthetic-native-B" }, error: { code: "SYNTHETIC_FAILURE" } };
    },
  };
  const partial = await applyWorkerPatchIntegration({ ...input(f), basisDigest: f.readBasis().basisDigest }, host);
  assert.equal(partial.status, complete ? "applied" : "incomplete");
  assert.deepEqual(
    partial.effectResults.map((item) => item.status),
    complete ? ["applied", "applied", "applied"] : ["applied", ownerQuiescent && failure === "not-started" ? "not-started" : "unknown", "not-attempted"],
  );
  const settle = () =>
    settleIncompleteWorkerPatchIntegration({
      ...input(f),
      basisDigest: f.readBasis().basisDigest,
      reason: "Lode reports the partial result; no effects will be retried.",
    });
  const failedReport = (extra) =>
    reportInput(f, {
      outcome: "Partial integration failed; A applied, B not confirmed, C unattempted",
      verification: [
        { check: "combined result", status: "failed" },
        { check: "remaining effects", status: "skipped" },
      ],
      ...extra,
    });
  return { ...f, partial, calls, settle, failedReport };
}

test("settled partial effects publish one honest failed whole result with exact attempt and settlement provenance", async (t) => {
  const f = await partialFixture(t);
  const before = p2(f);
  await assert.rejects(prepareWorkerIntegrationResult(f.failedReport()), { code: "WORKER_INTEGRATION_EFFECTS_INCOMPLETE" });
  const settled = await f.settle();
  assert.equal(settled.outstanding, false);
  assert.equal(settled.allEffectsCompleted, false);
  const { verification } = await prepareWorkerIntegrationResult(f.failedReport());
  assert.deepEqual(p2(f), before);
  assert.equal(verification.effectDisposition, "settled-incomplete");
  assert.equal(verification.effectEvidence.settlement.recordId, settled.settlement.recordId);
  assert.equal(verification.effectEvidence.settlement.recordHash, settled.settlement.recordHash);
  assert.deepEqual(
    verification.effectEvidence.effects.map((effect) => effect.status),
    ["applied", "not-started", "not-attempted"],
  );
  assert.equal(verification.effectEvidence.effects[2].attempts.length, 0, "unattempted effect does not need a fabricated receipt");
  assert.equal(verification.effectEvidence.effects[0].attempts[0].receipt.recordId, settled.effectResults[0].receipt.recordId);
  assert.equal(
    verification.effectEvidence.effects[0].attempts[0].initialReceipt.recordHash,
    settled.effectResults[0].initialReceipt?.recordHash || settled.effectResults[0].attempts[0].initialReceipt.recordHash,
  );
  const calls = f.calls.length;
  const published = await publishWorkerIntegrationResult({ ...input(f), verificationId: verification.verificationId });
  assert.equal(f.calls.length, calls);
  assert.equal(published.resultPacket.evidence[0].effectDisposition, "settled-incomplete");
  assert.deepEqual(published.resultPacket.verification[0].checks, f.failedReport().verification);
  assert.equal(inspectProject(f.root).state.lastReviewDecisionId, null);
  assert.equal(fs.readFileSync(path.join(f.root, "a.txt"), "utf8"), "applied A");
  assert.equal(fs.readFileSync(path.join(f.root, "b.txt"), "utf8"), "original b.txt\n");
  assert.equal(fs.readdirSync(path.join(f.root, relativeProjectArtifact(f.storage, "lineage", "result-packets"))).length, 1);
});

function assertWholeAttemptHistory(packet, application) {
  const reference = (record) => {
    if (!record) return null;
    const { recordId, recordHash, ...payload } = record;
    assert.equal(recordHash, integrationDigest(integrationJson(payload)), "the reference binds the entire stored payload");
    return { recordId, recordHash };
  };
  const evidence = packet.evidence[0].effectEvidence;
  assert.deepEqual(evidence.claim, reference(application.claim));
  assert.deepEqual(
    evidence.effects,
    application.effectResults.map((effect) => ({
      index: effect.index,
      path: effect.path,
      status: effect.status,
      attempts: effect.attempts.map((attempt) => ({
        attemptNumber: attempt.attemptNumber,
        status: attempt.status,
        started: reference(attempt.started),
        receipt: reference(attempt.receipt),
        ownerQuiescent: attempt.receipt?.ownerQuiescent ?? false,
        nativeStatus: attempt.receipt?.nativeStatus ?? null,
        initialReceipt: reference(attempt.initialReceipt),
        reconciliationReceipt: reference(attempt.reconciliationReceipt),
      })),
    })),
  );
}

test("settled-incomplete whole result retains original failed receipts across linked no-write retries", async (t) => {
  const f = await partialFixture(t);
  const prior = f.partial.effectResults[1];
  const originalFile = path.join(f.root, relativeProjectArtifact(f.storage, "runtime", "worker-integrations"), `${f.integrationId}.effect-1.receipt.json`);
  const originalBytes = fs.readFileSync(originalFile);
  const before = p2(f);
  const checkpoint = inspectProject(f.root).state.latestCheckpoint;
  const calls = [];
  const host = {
    fileEffect: async (request, options) => {
      calls.push(request.operation);
      assert.equal(request.payload.effect.path, "b.txt");
      if (request.operation === "image-inspect")
        return {
          status: "ok",
          result: {
            status: "preimage-observed",
            intentId: prior.receipt.nativeIntentId,
            noWriteRecorded: true,
            retryBasisAvailable: true,
            completionRecorded: false,
            appliedByThisRead: false,
          },
        };
      assert.equal(request.operation, "image-retry");
      options.onProcess({ type: "exit", cleanupVerified: true });
      return { status: "error", result: { status: "not-started", intentId: "synthetic-native-B-retry" }, error: { code: "SYNTHETIC_RETRY_NO_WRITE" } };
    },
  };
  const retry = await applyWorkerPatchIntegration({ ...input(f), basisDigest: f.readBasis().basisDigest, retryKnownNoWrite: true }, host);
  assert.deepEqual(calls, ["image-inspect", "image-retry"]);
  assert.equal(retry.effectResults[1].attempts.length, 2);
  assert.equal(retry.effectResults[1].attempts[1].started.retryBasisKind, "native-no-write");
  assert.equal(retry.effectResults[1].attempts[1].started.previousAttemptId, prior.started.recordId);
  const settled = await f.settle();
  const { verification } = await prepareWorkerIntegrationResult(f.failedReport());
  assert.deepEqual(p2(f), before);
  assertWholeAttemptHistory(verification.wholeResultPacket, settled);
  const published = await publishWorkerIntegrationResult({ ...input(f), verificationId: verification.verificationId });
  assertWholeAttemptHistory(published.resultPacket, settled);
  assert.equal(published.resultPacket.evidence[0].effectDisposition, "settled-incomplete");
  assert.deepEqual(
    published.resultPacket.evidence[0].effectEvidence.effects[1].attempts.map((attempt) => attempt.status),
    ["not-started", "not-started"],
  );
  assert.equal(published.resultPacket.evidence[0].effectEvidence.effects[1].attempts[0].initialReceipt.recordHash, prior.receipt.recordHash);
  assert.deepEqual(fs.readFileSync(originalFile), originalBytes);
  assert.deepEqual(readWorkerIntegrationResult(input(f)).resultPacket, published.resultPacket);
  assert.equal(inspectProject(f.root).state.lastReviewDecisionId, null);
  assert.equal(inspectProject(f.root).state.latestCheckpoint, checkpoint);
  assert.equal(published.resultPacket.reviewDecisionCreated, false);
  assert.equal(published.resultPacket.recoveryAuthority, false);
  assert.equal(calls.length, 2, "result preparation, publication and history cannot retry file effects");
});

test("complete whole result retains an original unknown receipt and its exact reconciliation without semantic promotion", async (t) => {
  const f = await workerIntegrationFixture(t, {
    workers: [
      { path: "a.txt", after: "new A" },
      { path: "b.txt", after: null },
    ],
  });
  const before = p2(f);
  const checkpoint = inspectProject(f.root).state.latestCheckpoint;
  const calls = [];
  const host = {
    fileEffect: async (request, options) => {
      calls.push(request.operation);
      const effect = request.payload.effect;
      if (request.operation === "image-preflight")
        return { status: "ok", result: { status: "supported", rootIdentity: "synthetic-root", ancestorIdentities: ["synthetic-root"] } };
      if (request.operation === "image-inspect")
        return {
          status: "ok",
          result: { status: "effect-observed", intentId: "synthetic-native-ack-loss", completionRecorded: true, appliedByThisRead: false },
        };
      assert.equal(request.operation, "image-apply");
      fs.writeFileSync(path.join(f.root, effect.path), Buffer.from(effect.after.content, "base64"));
      options.onProcess({ type: "exit", cleanupVerified: true });
      return { status: "error", result: { status: "unknown", intentId: "synthetic-native-ack-loss" }, error: { code: "SYNTHETIC_ACK_LOSS" } };
    },
  };
  const original = await applyWorkerPatchIntegration({ ...input(f), basisDigest: f.readBasis().basisDigest }, host);
  const originalReceipt = original.effectResults[0].receipt;
  assert.equal(originalReceipt.status, "unknown");
  const originalFile = path.join(f.root, relativeProjectArtifact(f.storage, "runtime", "worker-integrations"), `${f.integrationId}.effect-0.receipt.json`);
  const originalBytes = fs.readFileSync(originalFile);
  await assert.rejects(prepareWorkerIntegrationResult(reportInput(f)), { code: "WORKER_INTEGRATION_EFFECTS_INCOMPLETE" });
  const reconciled = await reconcileWorkerPatchIntegration(input(f), host);
  assert.equal(reconciled.status, "applied");
  const attempt = reconciled.effectResults[0].attempts[0];
  assert.equal(attempt.initialReceipt.status, "unknown");
  assert.equal(attempt.reconciliationReceipt.previousReceiptId, originalReceipt.recordId);
  assert.equal(attempt.reconciliationReceipt.nativeCompletionRecorded, true);
  const { verification } = await prepareWorkerIntegrationResult(
    reportInput(f, {
      outcome: "Effects completed, but HEAD cannot verify semantic correctness",
      verification: [{ check: "semantic result", status: "unknown" }],
    }),
  );
  assert.deepEqual(p2(f), before);
  assertWholeAttemptHistory(verification.wholeResultPacket, reconciled);
  const published = await publishWorkerIntegrationResult({ ...input(f), verificationId: verification.verificationId });
  assertWholeAttemptHistory(published.resultPacket, reconciled);
  assert.equal(published.resultPacket.evidence[0].effectDisposition, "complete");
  assert.deepEqual(published.resultPacket.verification[0].checks, [{ check: "semantic result", status: "unknown" }]);
  const projected = published.resultPacket.evidence[0].effectEvidence.effects[0].attempts[0];
  assert.equal(projected.initialReceipt.recordHash, originalReceipt.recordHash);
  assert.equal(projected.receipt.recordId, attempt.reconciliationReceipt.recordId);
  assert.notEqual(projected.receipt.recordId, projected.initialReceipt.recordId);
  assert.deepEqual(fs.readFileSync(originalFile), originalBytes);
  assert.deepEqual(readWorkerIntegrationResult(input(f)).resultPacket, published.resultPacket);
  assert.equal(inspectProject(f.root).state.lastReviewDecisionId, null);
  assert.equal(inspectProject(f.root).state.latestCheckpoint, checkpoint);
  assert.equal(published.resultPacket.reviewDecisionCreated, false);
  assert.equal(published.resultPacket.recoveryAuthority, false);
  assert.deepEqual(calls, ["image-preflight", "image-apply", "image-inspect"]);
});

test("settlement basis and current HEAD basis remain separate and unobservable read dependencies are explicit unknowns", async (t) => {
  const f = await partialFixture(t, { readDependencies: ["settings.txt"] });
  // Stable, bounded unobservable read evidence is not an unsafe impact target.
  fs.writeFileSync(path.join(f.root, "settings.txt"), "x".repeat(1024 * 1024 + 1));
  assert.equal(f.readBasis().allDependenciesObservable, false);
  const settled = await f.settle();
  assert.ok(settled.settlement);
  const first = await prepareWorkerIntegrationResult(f.failedReport());
  assert.ok(first.verification.wholeResultPacket.unknowns.some((value) => value.includes("settings.txt") && value.includes("unobservable")));
  assert.ok(first.verification.dependencyObservations.some((entry) => entry.path === "settings.txt" && entry.observed.kind === "unverifiable"));
  fs.writeFileSync(path.join(f.root, "settings.txt"), "later ordinary edit reobserved\n");
  await assert.rejects(publishWorkerIntegrationResult({ ...input(f), verificationId: first.verification.verificationId }), {
    code: "WORKER_INTEGRATION_REVERIFICATION_REQUIRED",
  });
  const next = await prepareWorkerIntegrationResult(f.failedReport({ outcome: "HEAD reassessed the partial failure against the new dependency" }));
  assert.notEqual(next.verification.basisDigest, settled.settlement.basisDigest);
  assert.equal(next.verification.effectEvidence.settlement.basisDigest, settled.settlement.basisDigest);
  assert.equal(next.verification.effectEvidence.settlement.recordId, first.verification.effectEvidence.settlement.recordId);
  assert.equal((await publishWorkerIntegrationResult({ ...input(f), verificationId: next.verification.verificationId })).status, "published");
});

test("unknown owner and a forged settlement cannot manufacture a settled whole result", async (t) => {
  const f = await partialFixture(t, { ownerQuiescent: false, failure: "unknown" });
  assert.equal((await f.settle()).action, "prove-effect-owner-quiescence");
  const before = p2(f);
  await assert.rejects(prepareWorkerIntegrationResult(f.failedReport()), { code: "WORKER_INTEGRATION_EFFECTS_INCOMPLETE" });
  const payload = {
    kind: "WorkerIntegrationIncompleteSettlement",
    protocolVersion: "0.1.0",
    authorityBoundary: artifactAuthorityBoundary("WorkerIntegrationIncompleteSettlement"),
    integrationId: f.integrationId,
    claimId: f.partial.claim.recordId,
    receiptIds: f.partial.effectResults.map((effect) => effect.receipt?.recordId || null),
    basisDigest: f.readBasis().basisDigest,
    reason: "Forged settlement despite unquiescent owner",
    instructionAuthority: false,
    promotionAuthority: false,
    recoveryAuthority: false,
    reviewDecisionCreated: false,
    mutatesCanon: false,
  };
  const recordHash = integrationDigest(integrationJson(payload));
  fs.writeFileSync(
    path.join(f.root, relativeProjectArtifact(f.storage, "runtime", "worker-integrations"), `${f.integrationId}.settled-incomplete.json`),
    JSON.stringify({ ...payload, recordHash, recordId: `worker-effect-${recordHash.slice(0, 24)}` }),
  );
  await assert.rejects(prepareWorkerIntegrationResult(f.failedReport()), { code: "WORKER_INTEGRATION_APPLICATION_CONFLICT" });
  assert.deepEqual(p2(f), before);
});

test("quiescent unknown effect remains unknown and caller cannot choose its disposition", async (t) => {
  const f = await partialFixture(t, { failure: "unknown" });
  await f.settle();
  await assert.rejects(prepareWorkerIntegrationResult(f.failedReport({ effectDisposition: "complete" })), { code: "WORKER_INTEGRATION_RESULT_CONFLICT" });
  const { verification } = await prepareWorkerIntegrationResult(f.failedReport());
  assert.equal(verification.effectDisposition, "settled-incomplete");
  assert.equal(verification.effectEvidence.effects[1].status, "unknown");
  const published = await publishWorkerIntegrationResult({ ...input(f), verificationId: verification.verificationId });
  assert.equal(published.resultPacket.evidence[0].effectEvidence.effects[1].status, "unknown");
});

test("settled incomplete finish recovers only its frozen packet after publication receipt failure", async (t) => {
  const f = await partialFixture(t);
  await f.settle();
  const { verification } = await prepareWorkerIntegrationResult(f.failedReport());
  const prepared = { ...f, verification, publication: { ...input(f), verificationId: verification.verificationId } };
  await failPublication(prepared);
  const calls = f.calls.length;
  fs.writeFileSync(path.join(f.root, "a.txt"), "user edit after frozen failed finish\n");
  const before = p2(f);
  const recovered = await publishWorkerIntegrationResult(prepared.publication, {
    readApplication: () => {
      throw new Error("exact failed finish retry must not reapply");
    },
  });
  assert.equal(recovered.resultPacket.resultPacketId, verification.wholeResultPacket.resultPacketId);
  assert.equal(recovered.verification.effectDisposition, "settled-incomplete");
  assert.equal(f.calls.length, calls);
  assert.deepEqual(p2(f), before);
  assert.equal(fs.readdirSync(path.join(f.root, relativeProjectArtifact(f.storage, "lineage", "result-packets"))).length, 1);
});

test("settled failure reporting still refuses an unobservable impact target", async (t) => {
  const f = await partialFixture(t);
  await f.settle();
  fs.linkSync(path.join(f.root, "a.txt"), path.join(f.root, "unsafe-impact-alias.txt"));
  const before = p2(f);
  assert.equal(f.readBasis().dependencies.find((entry) => entry.path === "a.txt").observed.kind, "unverifiable");
  await assert.rejects(prepareWorkerIntegrationResult(f.failedReport()), { code: "WORKER_INTEGRATION_REVERIFICATION_REQUIRED" });
  assert.deepEqual(p2(f), before);
  assert.equal(fs.existsSync(receiptFile(f)), false);
});

test("rehashing verification cannot falsify machine observations while keeping a genuine basis digest", async (t) => {
  const f = await prepared(t, { readDependencies: ["settings.txt"] });
  fs.writeFileSync(path.join(f.root, "settings.txt"), "x".repeat(1024 * 1024 + 1));
  const original = (await prepareWorkerIntegrationResult(reportInput(f))).verification;
  for (const change of ["observations", "observed-digest"]) {
    const forged = structuredClone(original);
    if (change === "observations") {
      forged.dependencyObservations = forged.dependencyObservations.filter((entry) => entry.path !== "settings.txt");
      forged.basisObservation.allDependenciesObservable = true;
      forged.wholeResultPacket.evidence[0].dependencyObservations = forged.dependencyObservations;
      forged.wholeResultPacket.evidence[0].basisObservation = forged.basisObservation;
      forged.wholeResultPacket.unknowns = [...forged.headReport.unknowns];
    } else forged.observedBasisDigest = "f".repeat(64);
    const { resultPacketId: ignoredPacketId, artifactHash: ignoredPacketHash, ...packetPayload } = forged.wholeResultPacket;
    const artifactHash = integrationDigest(integrationJson(packetPayload));
    forged.wholeResultPacket = { ...packetPayload, artifactHash, resultPacketId: `result-packet-${artifactHash.slice(0, 24)}` };
    const { verificationId: ignoredId, verificationHash: ignoredHash, ...payload } = forged;
    const verificationHash = integrationDigest(integrationJson(payload));
    const verificationId = `worker-integration-verification-${verificationHash.slice(0, 24)}`;
    fs.writeFileSync(verificationFile(f, verificationId), JSON.stringify({ ...payload, verificationId, verificationHash }), { flag: "wx" });
    const before = p2(f);
    await assert.rejects(publishWorkerIntegrationResult({ ...input(f), verificationId }), { code: "WORKER_INTEGRATION_REVERIFICATION_REQUIRED" });
    assert.deepEqual(p2(f), before);
    assert.equal(fs.existsSync(receiptFile(f)), false);
  }
});

test("complete no-op effects allow unknown read evidence without turning ownership into a new gate", async (t) => {
  const f = await prepared(t);
  fs.writeFileSync(path.join(f.root, "a.txt"), "x".repeat(1024 * 1024 + 1));
  const first = (await prepareWorkerIntegrationResult(reportInput(f, { verification: [{ status: "unknown" }] }))).verification;
  assert.equal(first.effectDisposition, "complete");
  assert.equal(first.basisObservation.allDependenciesObservable, false);
  const unknown = first.dependencyObservations.find((entry) => entry.path === "a.txt");
  assert.equal(unknown.isEffectTarget, false);
  assert.equal(unknown.observed.kind, "unverifiable");
  assert.equal(Object.hasOwn(unknown.observed, "digest"), false, "do not invent a current unknown-content digest");
  assert.ok(unknown.originals.length > 0 && unknown.originals.every((original) => /^[a-f0-9]{64}$/.test(original.digest)));
  assert.ok(first.wholeResultPacket.unknowns.some((value) => value.includes("a.txt") && value.includes(unknown.observed.code)));
  const before = p2(f);
  fs.writeFileSync(path.join(f.root, "a.txt"), "observable replacement\n");
  await assert.rejects(publishWorkerIntegrationResult({ ...input(f), verificationId: first.verificationId }), {
    code: "WORKER_INTEGRATION_REVERIFICATION_REQUIRED",
  });
  const second = (await prepareWorkerIntegrationResult(reportInput(f))).verification;
  fs.writeFileSync(path.join(f.root, "a.txt"), "another known replacement\n");
  await assert.rejects(publishWorkerIntegrationResult({ ...input(f), verificationId: second.verificationId }), {
    code: "WORKER_INTEGRATION_REVERIFICATION_REQUIRED",
  });
  assert.deepEqual(p2(f), before);
  const last = (await prepareWorkerIntegrationResult(reportInput(f, { verification: [{ status: "failed" }] }))).verification;
  const published = await publishWorkerIntegrationResult({ ...input(f), verificationId: last.verificationId });
  assert.deepEqual(published.resultPacket.verification[0].checks, [{ status: "failed" }]);
});

test("complete file effects report read-only unknowns but do not waive impact-target observability", async (t) => {
  const f = await partialFixture(t, { complete: true, readDependencies: ["settings.txt"] });
  fs.writeFileSync(path.join(f.root, "settings.txt"), "x".repeat(1024 * 1024 + 1));
  const { verification } = await prepareWorkerIntegrationResult(f.failedReport({ verification: [{ status: "unknown" }] }));
  assert.equal(verification.effectDisposition, "complete");
  assert.equal(verification.effectEvidence.settlement, null);
  assert.equal(verification.basisObservation.allDependenciesObservable, false);
  assert.ok(verification.wholeResultPacket.unknowns.some((value) => value.includes("settings.txt")));
  fs.linkSync(path.join(f.root, "a.txt"), path.join(f.root, "impact-alias.txt"));
  const before = p2(f);
  await assert.rejects(publishWorkerIntegrationResult({ ...input(f), verificationId: verification.verificationId }), {
    code: "WORKER_INTEGRATION_REVERIFICATION_REQUIRED",
  });
  await assert.rejects(prepareWorkerIntegrationResult(f.failedReport()), { code: "WORKER_INTEGRATION_REVERIFICATION_REQUIRED" });
  assert.deepEqual(p2(f), before);
});

test("normalized read or no-op aliases cannot reclassify an actual effect target as read-only", async (t) => {
  const alias = process.platform === "win32" ? "A.TXT" : "a.txt";
  const f = await workerIntegrationFixture(t, {
    workers: [
      { path: "a.txt", after: "applied A" },
      { path: alias, after: null },
    ],
  });
  const host = {
    fileEffect: async (request, options) => {
      const effect = request.payload.effect;
      if (request.operation === "image-preflight")
        return { status: "ok", result: { status: "supported", rootIdentity: "synthetic-root", ancestorIdentities: ["synthetic-root"] } };
      fs.writeFileSync(path.join(f.root, effect.path), Buffer.from(effect.after.content, "base64"));
      options.onProcess({ type: "exit", cleanupVerified: true });
      return { status: "ok", result: { status: "effect-observed", intentId: "synthetic-alias-effect" } };
    },
  };
  assert.equal((await applyWorkerPatchIntegration(input(f), host)).status, "applied");
  const joined = f.readBasis().dependencies.find((entry) => entry.path === "a.txt");
  assert.equal(joined.originals.length, 2);
  assert.ok(joined.expectedEffect);
  fs.writeFileSync(path.join(f.root, alias), "x".repeat(1024 * 1024 + 1));
  const before = p2(f);
  await assert.rejects(prepareWorkerIntegrationResult(reportInput(f)), { code: "WORKER_INTEGRATION_REVERIFICATION_REQUIRED" });
  assert.deepEqual(p2(f), before);
});

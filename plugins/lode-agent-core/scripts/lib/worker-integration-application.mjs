import { workerSourcePathParts } from "./worker-source-basis.mjs";
import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";
const lineageFormat = record => familyFormatForOriginal({ sessionIdentity: true }, record);
import fs from "node:fs";
import path from "node:path";
import { artifactAuthorityBoundary, verifyArtifactAuthorityBoundary } from "./authority-plane-contract.mjs";
import { readLineageArtifact } from "./execution-lineage.mjs";
import { readWorkerPatchIntegration, requireCurrentWorkerPatchIntegration } from "./worker-patch-integration.mjs";
import { readWorkerIntegrationBasis } from "./worker-integration-basis.mjs";
import { invokeWorkerFileEffect, prepareWorkerFileEffectInvocation, invokePreparedWorkerFileEffect,
  verifyWorkerFileEffectBinding, verifyWorkerFileEffectTerminalProof } from "./runtime-worker-file-effect.mjs";
import { resolveRuntimeOperationalStateRoot } from "./runtime-execution-lease.mjs";
import { withProjectMutationAsync } from "./project-mutation-lock.mjs";
import { integrationDigest as digest, integrationJson as json, workerIntegrationDirectory, readIntegrationBytes, publishIntegrationJson } from "./worker-integration-store.mjs";

const flags = { instructionAuthority: false, promotionAuthority: false, recoveryAuthority: false, reviewDecisionCreated: false, mutatesCanon: false };
const fail = message => { throw Object.assign(new Error(message), { code: "WORKER_INTEGRATION_APPLICATION_CONFLICT" }); };
const same = (a, b) => json(a) === json(b);
const claimSuffix = ".effect-claim.json";
const key = relative => process.platform === "win32" ? relative.toLowerCase() : relative;
const image = value => value.kind === "absent" ? { kind: "absent" } : { kind: "file", content: value.contentBase64, mode: value.mode };

function requireCurrentEffectAuthority(root, integrationId, storage) {
  const intent = requireCurrentWorkerPatchIntegration({ root, integrationId, storage });
  // An empty proposal creates no file effect. Keep that observation usable
  // under read-only authority instead of adding a write gate to a no-op result.
  if (intent.composition.patches.length === 0) return intent;
  const contract = readLineageArtifact({ root, artifactId: intent.lineage.executionContractId }).artifact;
  // The worker may only have permission to propose. HEAD's exact current Run
  // contract, never candidate metadata or its consumed lease, owns this effect.
  if (contract.kind !== "ExecutionContract" || contract.wholePlanId !== intent.lineage.wholePlanId
    || contract.capsuleId !== intent.lineage.contextCapsuleId
    || !contract.allowedActions?.includes("project.write") || contract.forbiddenActions?.includes("project.write")) {
    fail("The exact current ExecutionContract must allow project.write before HEAD applies worker patches.");
  }
  return intent;
}

export function workerEffectPathsOverlap(left, right) {
  const a = key(left), b = key(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
function identify(kind, data) {
  const payload = { kind, protocolVersion: "0.1.0", authorityBoundary: artifactAuthorityBoundary(kind), ...data, ...flags };
  const recordHash = digest(json(payload));
  return { ...payload, recordId: `worker-effect-${recordHash.slice(0, 24)}`, recordHash };
}
function verify(value, kind) {
  if (!value || value.kind !== kind || value.protocolVersion !== "0.1.0") fail("Unexpected integration application evidence.");
  verifyArtifactAuthorityBoundary(kind, value.authorityBoundary);
  const { recordId, recordHash, ...payload } = value;
  if (recordHash !== digest(json(payload)) || recordId !== `worker-effect-${recordHash.slice(0, 24)}`
    || !same(Object.fromEntries(Object.keys(flags).map(name => [name, value[name]])), flags)) fail("Integration application evidence differs from its digest or authority.");
  return value;
}
function fileFor(root, intent, suffix) { return path.join(workerIntegrationDirectory(root, false, lineageFormat(intent.lineage)), `${intent.integrationId}${suffix}`); }
function optional(file, kind) {
  try { return verify(JSON.parse(readIntegrationBytes(file)), kind); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function nativeEffect(root, patch, binding, storage) {
  workerSourcePathParts(patch.before.path, storage);
  return { root: fs.realpathSync(root), rootIdentity: binding.rootIdentity, ancestorIdentities: binding.ancestorIdentities,
    path: patch.before.path, before: image(patch.before), after: image(patch.after), maxBytes: (patch.before.bytes || 0) + (patch.after.bytes || 0) };
}
function attemptEffect(root, intent, effect, previousIntentId = null) {
  const value = nativeEffect(root, intent.composition.patches[effect.index], effect.binding, lineageFormat(intent.lineage));
  return previousIntentId ? { ...value, previousIntentId } : value;
}
function attemptSuffix(index, attemptNumber, phase) {
  return `.effect-${index}${attemptNumber ? `.attempt-${attemptNumber}` : ""}.${phase}.json`;
}
function attemptRequestId(intent, claim, effect, attemptNumber) {
  return `worker-effect-${digest(json({ integrationId: intent.integrationId, claimId: claim.recordId,
    index: effect.index, attemptNumber, inputDigest: effect.inputDigest }))}`;
}
function terminalResponse(proof, binding, effect) {
  verifyWorkerFileEffectTerminalProof(proof, { expectedBinding: binding, effect, requireLive: false });
  return proof.nativeResponse;
}
function knownNotPublished(current) {
  const { started, receipt } = current;
  if (receipt?.status !== "not-started" || receipt.ownerQuiescent !== true || started?.operation !== "image-apply"
    || !started.preDispatchBinding || !receipt.terminalProof) return false;
  // readEffect has already verified this exact persisted request/response pair.
  const response = receipt.terminalProof.nativeResponse;
  return response.status === "error" && response.result?.status === "not-started"
    && response.result.intentPublication === "not-attempted"
    && response.result.intentId === started.preDispatchBinding.expectedNativeIntentId
    && response.result.intentId === receipt.nativeIntentId;
}
function readClaim(root, intent) {
  const claim = optional(fileFor(root, intent, claimSuffix), "WorkerIntegrationEffectClaim");
  if (!claim) return null;
  if (claim.integrationId !== intent.integrationId || claim.integrationHash !== intent.integrationHash || !same(claim.lineage, intent.lineage)
    || !Array.isArray(claim.effects) || claim.effects.length !== intent.composition.patches.length) fail("Effect claim differs from its integration.");
  claim.effects.forEach((effect, index) => {
    const patch = intent.composition.patches[index];
    if (effect.index !== index || effect.path !== patch.before.path
      || !effect.binding || typeof effect.binding.rootIdentity !== "string" || !effect.binding.rootIdentity
      || !Array.isArray(effect.binding.ancestorIdentities) || effect.binding.ancestorIdentities.length !== effect.path.split("/").length
      || effect.binding.ancestorIdentities.some(value => typeof value !== "string" || !value)
      || effect.binding.ancestorIdentities[0] !== effect.binding.rootIdentity
      || effect.inputDigest !== digest(json(nativeEffect(root, patch, effect.binding)))) fail("Effect claim input differs from its exact candidate.");
  });
  return claim;
}
function readEffect(root, intent, claim, effect, directoryEntries = fs.readdirSync(workerIntegrationDirectory(root, false, lineageFormat(intent.lineage)))) {
  // Sequence is an immutable linked history, not a mutable latest pointer.
  // Enumerate final names too: a missing middle attempt cannot hide later work.
  const prefix = `${intent.integrationId}.effect-${effect.index}.attempt-`;
  const numbers = new Set([0]);
  for (const name of directoryEntries) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    const match = /^([1-9][0-9]*)\.(started|receipt|reconciled\.receipt)\.json$/.exec(name.slice(prefix.length));
    const number = Number(match?.[1]);
    if (!match || !Number.isSafeInteger(number)) fail("Invalid linked effect attempt name.");
    numbers.add(number);
  }
  const attempts = [];
  for (const [position, attemptNumber] of [...numbers].sort((a, b) => a - b).entries()) {
    if (position !== attemptNumber) fail("Linked effect attempt history has a gap.");
    const started = optional(fileFor(root, intent, attemptSuffix(effect.index, attemptNumber, "started")), "WorkerIntegrationEffectAttempt");
    const initialReceipt = optional(fileFor(root, intent, attemptSuffix(effect.index, attemptNumber, "receipt")), "WorkerIntegrationEffectReceipt");
    const reconciliationReceipt = optional(fileFor(root, intent, attemptSuffix(effect.index, attemptNumber, "reconciled.receipt")), "WorkerIntegrationEffectReceipt");
    if (!started && !initialReceipt && !reconciliationReceipt && attemptNumber === 0 && numbers.size === 1) break;
    if (!started) fail("Effect receipt or retry lacks its durable attempt.");
    const previous = attempts.at(-1);
    for (const value of [started, initialReceipt, reconciliationReceipt].filter(Boolean)) {
      if (value.claimId !== claim.recordId || value.integrationId !== intent.integrationId
        || value.index !== effect.index || value.inputDigest !== effect.inputDigest
        || value.attemptNumber !== attemptNumber) fail("Effect evidence has another exact target.");
    }
    // Old native-no-write records remain readable, but absence of the new
    // pre-dispatch/terminal pair can never gain not-published retry rights.
    const retryBasisKind = Object.hasOwn(started, "retryBasisKind") ? started.retryBasisKind : previous ? "native-no-write" : null;
    if (previous ? !["native-no-write", "not-published"].includes(retryBasisKind) : retryBasisKind !== null) fail("Invalid effect retry basis kind.");
    const nativeRetry = retryBasisKind === "native-no-write";
    if (started.previousAttemptId !== (previous?.started.recordId || null)
      || started.operation !== (nativeRetry ? "image-retry" : "image-apply")
      || started.previousNativeIntentId !== (nativeRetry ? previous?.receipt?.nativeIntentId || null : null)
      || started.nativeInputDigest !== digest(json(attemptEffect(root, intent, effect, started.previousNativeIntentId)))) fail("Effect attempt differs from its exact linked input.");
    if (previous && (previous.status !== "not-started" || previous.receipt.ownerQuiescent !== true
      || !previous.receipt.nativeIntentId || (nativeRetry ? !knownNoWriteInspection(started.retryInspection, previous.receipt.nativeIntentId)
        : !knownNotPublished(previous)))) fail("Effect retry lacks a verified predecessor.");
    if (!nativeRetry && started.retryInspection !== null) fail("An unoffered effect cannot claim a native journal retry basis.");
    const requestEffect = attemptEffect(root, intent, effect, nativeRetry ? previous.nativePreviousIntentId : null);
    if (started.preDispatchBinding) verifyWorkerFileEffectBinding(started.preDispatchBinding, {
      operation: started.operation, effect: requestEffect,
      requestId: attemptRequestId(intent, claim, effect, attemptNumber) });
    for (const receipt of [initialReceipt, reconciliationReceipt].filter(Boolean)) {
      if (receipt.attemptId !== started.recordId || !["applied", "not-started", "unknown"].includes(receipt.status)
        || typeof receipt.ownerQuiescent !== "boolean") fail("Invalid terminal effect evidence.");
      if (receipt.status === "applied" && (!receipt.ownerQuiescent || receipt.nativeStatus !== "effect-observed")) fail("Unknown effect cannot become applied.");
      if (receipt.status === "not-started" && (!receipt.ownerQuiescent || receipt.nativeStatus !== "not-started")) fail("Effect retry cannot infer a known no-write outcome.");
      if (receipt.terminalProof) {
        if (!started.preDispatchBinding || receipt.reconciliation === true) fail("Terminal evidence lacks its pre-dispatch binding.");
        const response = terminalResponse(receipt.terminalProof, started.preDispatchBinding, requestEffect);
        const expectedStatus = response.status === "ok" && response.result?.status === "effect-observed" ? "applied"
          : response.result?.status === "not-started" ? "not-started" : "unknown";
        if (receipt.ownerQuiescent !== true || receipt.nativeStatus !== response.result?.status
          || receipt.status !== expectedStatus || receipt.nativeIntentId !== (response.result?.intentId || null)
          || receipt.errorCode !== (response.error?.code || null)) fail("Effect receipt differs from its exact native terminal evidence.");
      }
    }
    if (reconciliationReceipt && (!initialReceipt || initialReceipt.status !== "unknown"
      || reconciliationReceipt.previousReceiptId !== initialReceipt.recordId || reconciliationReceipt.reconciliation !== true
      || reconciliationReceipt.nativeCompletionRecorded !== true || reconciliationReceipt.status !== "applied"
      || !reconciliationReceipt.nativeIntentId
      || initialReceipt.nativeIntentId && initialReceipt.nativeIntentId !== reconciliationReceipt.nativeIntentId)) fail("Reconciled completion lacks its exact original unknown receipt.");
    const receipt = reconciliationReceipt || initialReceipt;
    // Retry may fail its native recheck before creating a new native intent.
    // Preserve that prior identity rather than inventing an uncreated journal.
    const nativePreviousIntentId = nativeRetry && receipt?.nativeIntentId === started.previousNativeIntentId
      ? previous.nativePreviousIntentId : started.previousNativeIntentId;
    if (nativeRetry && receipt?.status === "applied" && receipt.nativeIntentId === started.previousNativeIntentId) fail("Native retry success must identify a new native effect.");
    attempts.push({ attemptNumber, started, initialReceipt, reconciliationReceipt, receipt, nativePreviousIntentId,
      status: receipt?.status || "unknown" });
  }
  const latest = attempts.at(-1);
  return { index: effect.index, path: effect.path, attempts, started: latest?.started || null,
    receipt: latest?.receipt || null, nativePreviousIntentId: latest?.nativePreviousIntentId || null,
    status: latest?.status || "not-attempted" };
}
function knownNoWriteInspection(value, nativeIntentId) {
  return !!value && value.intentId === nativeIntentId && value.noWriteRecorded === true
    && value.retryBasisAvailable === true && value.completionRecorded === false
    && value.status === "preimage-observed" && value.appliedByThisRead === false;
}
function settlement(root, intent, claim, results) {
  const value = optional(fileFor(root, intent, ".settled-incomplete.json"), "WorkerIntegrationIncompleteSettlement");
  if (value && (value.integrationId !== intent.integrationId || value.claimId !== claim.recordId
    || !same(value.receiptIds, results.map(result => result.receipt?.recordId || null))
    || results.some(result => result.started && result.receipt?.ownerQuiescent !== true))) fail("Incomplete settlement lacks exact quiescent effects.");
  return value;
}

// P4 historical read: no provider, native process, status mutation, or P2 write.
function readApplicationEvidence({ root, integrationId, storage }, directoryEntries) {
  const { intent } = readWorkerPatchIntegration({ root, integrationId, storage });
  const claim = readClaim(root, intent);
  const names = directoryEntries || fs.readdirSync(workerIntegrationDirectory(root, false, lineageFormat(intent.lineage)));
  const effectResults = claim ? claim.effects.map(effect => readEffect(root, intent, claim, effect, names)) : [];
  const settled = claim && settlement(root, intent, claim, effectResults);
  const allEffectsCompleted = !!claim && effectResults.every(result => result.status === "applied");
  return { intent, claim, effectResults, settlement: settled || null, allEffectsCompleted,
    status: allEffectsCompleted ? "applied" : settled ? "incomplete" : !claim ? "not-started"
      : effectResults.some(result => result.started) ? "incomplete" : "applying",
    outstanding: !!claim && !allEffectsCompleted && !settled, semanticVerification: "not-assessed", ...flags };
}
export function readWorkerPatchApplicationEvidence({ root = ".", integrationId, storage } = {}) {
  return readApplicationEvidence({ root, integrationId, storage });
}
export function readWorkerPatchApplication({ root = ".", integrationId, storage } = {}) {
  const view = readWorkerPatchApplicationEvidence({ root, integrationId, storage });
  const currentBasis = readWorkerIntegrationBasis({ root, integrationId, storage });
  const unavailable = currentBasis.dependencies.filter(entry => entry.changedDuringObservation || entry.observed.kind === "unverifiable")
    .map(entry => ({ path: entry.path, role: entry.expectedEffect ? "effect-target" : "read-dependency",
      reason: entry.changedDuringObservation ? "changed-during-observation" : entry.observed.code || "unverifiable" }));
  const unresolved = view.effectResults.filter(effect => effect.started && effect.status !== "applied");
  const terminal = view.allEffectsCompleted || Boolean(view.settlement);
  const action = terminal ? "assess-whole-result" : unresolved.length ? "reconcile-started-effects"
    : unavailable.length ? "inspect-selected-dependencies" : currentBasis.headReassessmentRequired ? "reassess-current-basis" : "inspect-retained-integration";
  return { ...view, currentBasis, guidance: {
    affectedOperation: "this-integration-automatic-application", ordinaryWorkBlocked: false, userActionRequired: false,
    automaticApplicationBlocked: !terminal && (unresolved.length > 0 || unavailable.length > 0),
    action, unavailable, unresolvedEffectPaths: unresolved.map(effect => effect.path),
    nextStep: terminal ? "HEAD assesses the whole result and remaining uncertainty; applied effects are not replayed."
      : unresolved.length ? "Reconcile exact started effects and owner quiescence first; do not replay or bypass unknown effects through direct work."
        : unavailable.length ? "HEAD inspects the named dependency and current evidence. A fresh digest alone cannot make unreadable evidence usable. Preserve the original result; unrelated work can continue."
          : currentBasis.headReassessmentRequired ? "HEAD reassesses the current evidence without replaying effects or overwriting user changes; no routine user approval is added."
            : "Inspect the retained integration and current files. This status does not select application or a maintenance mutation and grants no permission.",
    persisted: false, grantsPermission: false, recoveryAuthority: false,
  } };
}

// A Run/Session change cannot erase an earlier possible file effect. Only actual
// patch paths (not read dependencies or no-op ownership) participate. This is
// an on-demand projection over durable P3, not a second authoritative registry.
export function readOutstandingWorkerEffects({ root = ".", integrationId, storage } = {}) {
  const { intent } = readWorkerPatchIntegration({ root, integrationId, storage });
  const conflicts = [];
  const names = fs.readdirSync(workerIntegrationDirectory(root, false, lineageFormat(intent.lineage)));
  for (const name of names) {
    if (!/^worker-integration-[a-f0-9]{24}--[a-f0-9]{24}\.effect-claim\.json$/.test(name)) continue;
    const priorId = name.slice(0, -claimSuffix.length);
    if (priorId === integrationId) continue;
    const { intent: prior } = readWorkerPatchIntegration({ root, integrationId: priorId, storage });
    if (prior.lineage.projectId !== intent.lineage.projectId || prior.lineage.projectRootDigest !== intent.lineage.projectRootDigest) fail("Durable effect claim scope cannot be verified.");
    // A damaged claim for an unrelated exact stored integration must not make
    // unrelated ordinary paths unusable. Only the immutable intent owns scope.
    const overlap = prior.composition.patches.filter(patch => intent.composition.patches.some(current => workerEffectPathsOverlap(patch.before.path, current.before.path)));
    if (!overlap.length) continue;
    const previous = readApplicationEvidence({ root, integrationId: priorId, storage }, names);
    if (previous.outstanding) conflicts.push({ integrationId: priorId, claimId: previous.claim.recordId,
      paths: overlap.map(patch => patch.before.path), status: previous.status, runId: prior.lineage.runId });
  }
  return { conflicts, hasConflicts: conflicts.length > 0, authorityEffect: "none", ...flags };
}
function journalDirectory(root, intent, claim, create) {
  let directory = resolveRuntimeOperationalStateRoot({ projectRoot: fs.realpathSync(root), storage: lineageFormat(intent.lineage), create });
  for (const segment of ["worker-integrations", intent.lineage.projectId, claim.recordId]) {
    directory = path.join(directory, segment);
    if (create) { try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; } }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) fail("Unsafe effect journal directory.");
  }
  return directory;
}
function hostTools(host) {
  // Trusted in-process Host/testing composition, never CLI/MCP JSON fields.
  const customPrepared = host.prepareFileEffect !== undefined || host.invokePreparedFileEffect !== undefined;
  if (customPrepared && (typeof host.prepareFileEffect !== "function" || typeof host.invokePreparedFileEffect !== "function")) fail("Prepared file effects need an exact prepare/invoke pair.");
  const prepared = customPrepared || !host.fileEffect;
  return { invoke: host.fileEffect || invokeWorkerFileEffect,
    prepare: prepared ? host.prepareFileEffect || prepareWorkerFileEffectInvocation : null,
    invokePrepared: prepared ? host.invokePreparedFileEffect || invokePreparedWorkerFileEffect : null,
    fixtureProof: host.trustedHostFixture === true, options: host.nativeOptions || {}, onProcess: host.onProcess || (() => {}) };
}
function saveReceipt(root, intent, claim, effect, attempt, data, phase = "receipt") {
  const receipt = identify("WorkerIntegrationEffectReceipt", { integrationId: intent.integrationId, claimId: claim.recordId,
    index: effect.index, inputDigest: effect.inputDigest, attemptNumber: attempt.attemptNumber, attemptId: attempt.recordId, ...data });
  publishIntegrationJson(fileFor(root, intent, attemptSuffix(effect.index, attempt.attemptNumber, phase)), receipt);
  return receipt;
}
function unchangedSelectedBasis(before, after, completedPath = null) {
  if (!after.observationStable || !after.allDependenciesObservable || before.dependencies.length !== after.dependencies.length) return false;
  return before.dependencies.every((previous, index) => {
    const current = after.dependencies[index];
    if (previous.path !== current.path) return false;
    if (completedPath !== null && key(current.path) === key(completedPath)) return current.expectedPostimagePresent;
    return same(previous.observed, current.observed) && same(previous.identities, current.identities)
      && previous.changedDuringObservation === current.changedDuringObservation;
  });
}

// Explicit HEAD application. Tests belong outside this short effect/metadata
// lock. Native capability checks cover ALL effects before the first claim/write.
export async function applyWorkerPatchIntegration(input = {}, host = {}) {
  const view = await applyWorkerPatchIntegrationInternal(input, host);
  if (!view.action) return view;
  const nextSteps = {
    "inspect-unverifiable-basis": view.guidance.nextStep,
    "reconcile-overlapping-effects": "HEAD reconciles the overlapping prior effects first. Preserve all outcomes and do not bypass their uncertainty through another execution path.",
    "refresh-head-assessment": "HEAD rereads the current basis and reassesses the proposal before applying remaining effects; preserve completed effects and user edits.",
    "head-reassess-current-basis": "HEAD assesses the current evidence and supplies its current basis only if this proposal remains valid; no routine user approval is added.",
    "unsupported-file-effects": "The native backend cannot apply the listed effects. HEAD inspects those paths and chooses a supported approach within existing authority; unrelated work can continue.",
  };
  return { ...view, guidance: { ...view.guidance, action: view.action, automaticApplicationBlocked: true,
    nextStep: nextSteps[view.action] || "HEAD inspects the exact effect history, current basis and owned process state before any retry. Missing or unknown effect evidence is not permission to replay or overwrite." } };
}

async function applyWorkerPatchIntegrationInternal({ root = ".", integrationId, basisDigest, retryKnownNoWrite = false, storage } = {}, host = {}) {
  if (typeof retryKnownNoWrite !== "boolean") fail("Known-no-write retry must be an explicit boolean choice.");
  return withProjectMutationAsync({ root, scope: "session-recovery" }, async () => {
    const intent = requireCurrentWorkerPatchIntegration({ root, integrationId, storage });
    let view = readWorkerPatchApplication({ root, integrationId, storage });
    if (view.allEffectsCompleted || view.settlement) return view;
    requireCurrentEffectAuthority(root, integrationId, storage);
    const collisions = readOutstandingWorkerEffects({ root, integrationId, storage });
    if (collisions.hasConflicts) return { ...view, action: "reconcile-overlapping-effects", collisions };
    if (!view.currentBasis.observationStable || !view.currentBasis.allDependenciesObservable) return { ...view, action: "inspect-unverifiable-basis" };
    if (basisDigest !== undefined && basisDigest !== view.currentBasis.basisDigest) return { ...view, action: "refresh-head-assessment" };
    if (view.currentBasis.headReassessmentRequired && basisDigest !== view.currentBasis.basisDigest) return { ...view, action: "head-reassess-current-basis" };
    const { invoke, prepare, invokePrepared, fixtureProof, options, onProcess } = hostTools(host);
    let claim = view.claim;
    if (!claim) {
      const effects = [];
      const unsupported = [];
      for (const [index, patch] of intent.composition.patches.entries()) {
        const discovery = nativeEffect(root, patch, { rootIdentity: "", ancestorIdentities: [] }, lineageFormat(intent.lineage));
        // Preflight does not write a journal, so it may use the future parent.
        const preflight = await invoke({ operation: "image-preflight", payload: { effect: discovery,
          journal: resolveRuntimeOperationalStateRoot({ projectRoot: fs.realpathSync(root), storage: lineageFormat(intent.lineage), create: false }) } }, { ...options, onProcess });
        if (preflight.status !== "ok" || preflight.result.status !== "supported") {
          unsupported.push({ path: patch.before.path, code: preflight.error?.code || preflight.result.reason }); continue;
        }
        const binding = { rootIdentity: preflight.result.rootIdentity, ancestorIdentities: preflight.result.ancestorIdentities };
        const effect = nativeEffect(root, patch, binding, lineageFormat(intent.lineage));
        effects.push({ index, path: patch.before.path, binding, inputDigest: digest(json(effect)) });
      }
      if (unsupported.length) return { ...view, action: "unsupported-file-effects", unsupported };
      // Awaited preflight may have allowed source/pointer changes. Recheck both
      // before publishing a durable claim; native repeats exact path preimages.
      requireCurrentEffectAuthority(root, integrationId, storage);
      if (readWorkerIntegrationBasis({ root, integrationId, storage }).basisDigest !== view.currentBasis.basisDigest) return { ...readWorkerPatchApplication({ root, integrationId, storage }), action: "refresh-head-assessment" };
      claim = identify("WorkerIntegrationEffectClaim", { integrationId, integrationHash: intent.integrationHash,
        lineage: intent.lineage, preparedBasisDigest: view.currentBasis.basisDigest, effects });
      publishIntegrationJson(fileFor(root, intent, claimSuffix), claim);
    }
    if (!claim.effects.length) return readWorkerPatchApplication({ root, integrationId, storage });
    // Check durable attempted effects BEFORE recreating any Host directories.
    // Missing P5 is not permission to rerun a durable started effect.
    const unresolved = claim.effects.map(effect => readEffect(root, intent, claim, effect))
      .filter(result => result.started && result.receipt?.status !== "applied");
    if (unresolved.some(result => !retryKnownNoWrite || result.status !== "not-started"
      || result.receipt.ownerQuiescent !== true || !result.receipt.nativeIntentId)) {
      return { ...readWorkerPatchApplication({ root, integrationId, storage }), action: "reconcile-started-effect" };
    }
    let journal;
    try { journal = journalDirectory(root, intent, claim, unresolved.length === 0); }
    catch (error) { if (error.code === "ENOENT") return { ...readWorkerPatchApplication({ root, integrationId, storage }), action: "host-effect-evidence-unavailable" }; throw error; }
    let acceptedBasis = view.currentBasis;
    for (const effect of claim.effects) {
      const current = readEffect(root, intent, claim, effect);
      if (current.receipt?.status === "applied") continue;
      requireCurrentEffectAuthority(root, integrationId, storage);
      const beforeEffect = readWorkerIntegrationBasis({ root, integrationId, storage });
      if (!unchangedSelectedBasis(acceptedBasis, beforeEffect)) return { ...readWorkerPatchApplication({ root, integrationId, storage }), action: "refresh-head-assessment" };
      acceptedBasis = beforeEffect;
      let retryInspection = null;
      const retryBasisKind = current.started ? knownNotPublished(current) ? "not-published" : "native-no-write" : null;
      const nativeRetry = retryBasisKind === "native-no-write";
      const requestEffect = attemptEffect(root, intent, effect, nativeRetry ? current.nativePreviousIntentId : null);
      if (current.started) {
        // The caller opts into one new attempt; status/reconcile never retries.
        // Quiescence comes from the prior effect owner, not this inspection's
        // exit, a matching preimage, or merely an absent P5 journal.
        if (!retryKnownNoWrite || current.status !== "not-started" || current.receipt.ownerQuiescent !== true) {
          return { ...readWorkerPatchApplication({ root, integrationId, storage }), action: "reconcile-started-effect" };
        }
        if (retryBasisKind === "not-published") {
          // A prior exact terminal proves only that invocation did not offer an
          // intent. A fresh current preimage is still mandatory. Re-offering
          // keeps the same journal and CREATE_NEW collision protection.
          const selected = beforeEffect.dependencies.find(dependency => key(dependency.path) === key(effect.path));
          if (!prepare || !selected?.expectedPreimagePresent) return { ...readWorkerPatchApplication({ root, integrationId, storage }), action: "retry-basis-unavailable" };
          if (current.started.preDispatchBinding.payloadDigest !== digest(JSON.stringify({ effect: requestEffect, journal }))) {
            return { ...readWorkerPatchApplication({ root, integrationId, storage }), action: "host-effect-evidence-unavailable", reason: "effect-journal-binding-changed" };
          }
        } else {
          const response = await invoke({ operation: "image-inspect", payload: { effect: requestEffect, journal } }, { ...options, onProcess });
          if (response.status !== "ok" || !knownNoWriteInspection(response.result, current.receipt.nativeIntentId)) {
            return { ...readWorkerPatchApplication({ root, integrationId, storage }), action: "retry-basis-unavailable", retryObservation: response };
          }
          retryInspection = response.result;
        }
        requireCurrentEffectAuthority(root, integrationId, storage);
        if (readWorkerIntegrationBasis({ root, integrationId, storage }).basisDigest !== beforeEffect.basisDigest) {
          return { ...readWorkerPatchApplication({ root, integrationId, storage }), action: "refresh-head-assessment" };
        }
        if (!same(readClaim(root, intent), claim) || !same(readEffect(root, intent, claim, effect), current)) fail("Effect retry evidence changed during inspection.");
      }
      const attemptNumber = current.attempts.length;
      const previousNativeIntentId = nativeRetry ? current.receipt.nativeIntentId : null;
      const operation = nativeRetry ? "image-retry" : "image-apply";
      let ownerQuiescent = false;
      const processObserver = event => { if (event.type === "exit" && event.cleanupVerified === true) ownerQuiescent = true; onProcess(event); };
      const request = { operation, payload: { effect: requestEffect, journal } };
      let prepared = null;
      if (prepare) {
        const requestId = attemptRequestId(intent, claim, effect, attemptNumber);
        prepared = await prepare({ ...request, requestId }, { ...options, onProcess: processObserver });
        verifyWorkerFileEffectBinding(prepared?.binding, { operation, effect: requestEffect, requestId });
        if (prepared.binding.payloadDigest !== digest(JSON.stringify(request.payload))) fail("Prepared dispatch differs from its exact effect journal.");
        // Preparation itself starts no child. A failed/changed preparation may
        // resume the same claim without inventing a started effect or receipt.
        requireCurrentEffectAuthority(root, integrationId, storage);
        if (readWorkerIntegrationBasis({ root, integrationId, storage }).basisDigest !== beforeEffect.basisDigest) {
          return { ...readWorkerPatchApplication({ root, integrationId, storage }), action: "refresh-head-assessment" };
        }
        if (!same(readClaim(root, intent), claim) || !same(readEffect(root, intent, claim, effect), current)) fail("Effect evidence changed before prepared dispatch.");
      }
      // No asynchronous work remains between this exact authority check and
      // publication/dispatch. A pre-dispatch denial must not become an unknown
      // native effect or consume the operation's retry history.
      requireCurrentEffectAuthority(root, integrationId, storage);
      const attempt = identify("WorkerIntegrationEffectAttempt", { integrationId, claimId: claim.recordId,
        index: effect.index, inputDigest: effect.inputDigest, attemptNumber,
        operation, previousAttemptId: current.started?.recordId || null, retryBasisKind,
        previousNativeIntentId, nativeInputDigest: digest(json(attemptEffect(root, intent, effect, previousNativeIntentId))), retryInspection,
        preDispatchBinding: prepared?.binding || null });
      publishIntegrationJson(fileFor(root, intent, attemptSuffix(effect.index, attemptNumber, "started")), attempt);
      let response;
      let terminalProof = null;
      try {
        if (prepared) {
          const result = await invokePrepared(prepared);
          response = result.response;
          verifyWorkerFileEffectTerminalProof(result.terminalProof, { expectedBinding: attempt.preDispatchBinding,
            expectedResponse: response, effect: requestEffect, requireLive: !fixtureProof });
          if (result.terminalProof.provenance !== "verified-native-child" && !(fixtureProof && result.terminalProof.provenance === "trusted-host-fixture")) fail("Native terminal proof has an unaccepted Host provenance.");
          terminalProof = result.terminalProof;
          ownerQuiescent = true;
        } else response = await invoke(request, { ...options, onProcess: processObserver });
      } catch (error) {
        saveReceipt(root, intent, claim, effect, attempt, { status: "unknown", ownerQuiescent,
          nativeStatus: "transport-unknown", nativeIntentId: null, errorCode: String(error.code || "TRANSPORT_ERROR"), terminalProof: null });
        return { ...readWorkerPatchApplication({ root, integrationId, storage }), action: "inspect-incomplete-effects" };
      }
      const status = response.status === "ok" && response.result?.status === "effect-observed" && ownerQuiescent ? "applied"
        : response.result?.status === "not-started" && ownerQuiescent ? "not-started" : "unknown";
      saveReceipt(root, intent, claim, effect, attempt, { status, ownerQuiescent, nativeStatus: response.result?.status || "unknown",
        nativeIntentId: response.result?.intentId || null, errorCode: response.error?.code || null, terminalProof });
      if (status !== "applied") return { ...readWorkerPatchApplication({ root, integrationId, storage }), action: "inspect-incomplete-effects" };
      const afterEffect = readWorkerIntegrationBasis({ root, integrationId, storage });
      if (!unchangedSelectedBasis(acceptedBasis, afterEffect, effect.path)) return { ...readWorkerPatchApplication({ root, integrationId, storage }), action: "refresh-head-assessment" };
      // Only this verified exact postimage advances the accepted observation;
      // awaited provider/native work cannot silently accept other dependencies.
      acceptedBasis = afterEffect;
    }
    return readWorkerPatchApplication({ root, integrationId, storage });
  });
}

// Reconciliation observes retained phases only. A postimage alone never creates
// a success receipt. Crash recovery can add a receipt only for exact native
// completion (no future source writes in that code path), not just same bytes.
export async function reconcileWorkerPatchIntegration({ root = ".", integrationId, storage } = {}, host = {}) {
  return withProjectMutationAsync({ root, scope: "session-recovery" }, async () => {
    const view = readWorkerPatchApplication({ root, integrationId, storage });
    if (!view.claim || view.settlement) return view;
    const { invoke, options, onProcess } = hostTools(host);
    let journal;
    try { journal = journalDirectory(root, view.intent, view.claim, false); }
    catch (error) { if (error.code === "ENOENT") return { ...view, action: "host-effect-evidence-unavailable" }; throw error; }
    const observations = [];
    for (const effect of view.claim.effects) {
      const current = readEffect(root, view.intent, view.claim, effect);
      if (!current.started || current.receipt && current.receipt.status !== "unknown") continue;
      const response = await invoke({ operation: "image-inspect", payload: { effect: attemptEffect(root, view.intent, effect, current.nativePreviousIntentId), journal } }, { ...options, onProcess });
      observations.push({ index: effect.index, response });
      if (response.status === "ok" && response.result.completionRecorded === true) {
        if (current.receipt?.nativeIntentId && current.receipt.nativeIntentId !== response.result.intentId) fail("Native completion names another attempted effect.");
        const reconciled = current.receipt ? { reconciliation: true, previousReceiptId: current.receipt.recordId, nativeCompletionRecorded: true } : {};
        saveReceipt(root, view.intent, view.claim, effect, current.started,
          { status: "applied", ownerQuiescent: true, nativeStatus: "effect-observed", nativeIntentId: response.result.intentId, errorCode: null, ...reconciled },
          current.receipt ? "reconciled.receipt" : "receipt");
      }
    }
    return { ...readWorkerPatchApplication({ root, integrationId, storage }), observations };
  });
}

export function validateWorkerIntegrationSettlementReason(reason) {
  if (typeof reason !== "string" || !reason.trim() || reason.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(reason)) fail("Incomplete handoff needs a bounded explanation, not executable instructions.");
}

// An explicit HEAD handoff may close a quiescent incomplete attempt. It cannot
// call it success, retry its uncertain effects, or erase history. A later fresh
// integration can use a new inspected basis without an eternal path reservation.
export async function settleIncompleteWorkerPatchIntegration({ root = ".", integrationId, basisDigest, reason, storage } = {}) {
  validateWorkerIntegrationSettlementReason(reason);
  return withProjectMutationAsync({ root, scope: "session-recovery" }, async () => {
    const view = readWorkerPatchApplication({ root, integrationId, storage });
    if (view.settlement) {
      if (view.settlement.reason !== reason || view.settlement.basisDigest !== basisDigest) fail("Incomplete handoff retry differs from its recorded explanation or basis.");
      return view;
    }
    if (!view.claim || view.allEffectsCompleted) fail("Only an incomplete claimed integration can be settled incomplete.");
    if (view.effectResults.some(result => result.started && result.receipt?.ownerQuiescent !== true)) return { ...view, action: "prove-effect-owner-quiescence" };
    const effectsObservable = view.currentBasis.dependencies.filter(dependency => dependency.expectedEffect)
      .every(dependency => !dependency.changedDuringObservation && dependency.observed.kind !== "unverifiable");
    if (!effectsObservable || view.currentBasis.basisDigest !== basisDigest) return { ...view, action: "inspect-current-basis" };
    const value = identify("WorkerIntegrationIncompleteSettlement", { integrationId, claimId: view.claim.recordId,
      receiptIds: view.effectResults.map(result => result.receipt?.recordId || null), basisDigest, reason });
    publishIntegrationJson(fileFor(root, view.intent, ".settled-incomplete.json"), value);
    return readWorkerPatchApplication({ root, integrationId, storage });
  });
}

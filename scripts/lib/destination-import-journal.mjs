import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { atomicCreateArtifact } from "./artifact-storage.mjs";
import { copiedProjectFile } from "./project-copy-evidence.mjs";
import { nativeRoot, pinNativeRoot, nativeRaw, nativeCheck, nativeSeparate } from "./provider-native-history-host.mjs";
import { derivedHash as hash, derivedJson as json, derivedFail as fail } from "./claude-derived-encoder.mjs";

const leases = new WeakMap();
const nativeWrites = new WeakMap();
const identity = root => { const stat = fs.lstatSync(root, { bigint: true }); return { path: root, dev: String(stat.dev), ino: String(stat.ino) }; };
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const id = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
const checkedObject = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && equal(Object.keys(value).sort(), keys.sort());
function authority(signal, guard, action, target = null, operation = null) {
  if (typeof guard !== "function") fail("DESTINATION_IMPORT_CURRENT_SCOPE_REQUIRED");
  nativeCheck(signal, () => guard({ action, authorityPlane: "P5", target, operation }));
}
function context({ journalRoot, hostId, nativeHome, projectRoot, provider, signal, assertCurrentAuthority, operation = null }, action) {
  const targetRequest = { hostId, nativeHome, projectRoot, provider }, operationScope = operation === null ? null : structuredClone(operation);
  authority(signal, assertCurrentAuthority, action, targetRequest, operationScope);
  if (typeof hostId !== "string" || !hostId.trim() || !["claude", "codex", "opencode"].includes(provider)) fail("DESTINATION_IMPORT_TARGET_INVALID");
  const root = nativeRoot(journalRoot), home = nativeRoot(nativeHome), project = nativeRoot(projectRoot);
  nativeSeparate(root, home); nativeSeparate(root, project);
  const rootPin = pinNativeRoot(root), homePin = pinNativeRoot(home), projectPin = pinNativeRoot(project);
  const store = identity(root), target = { hostId, provider, home: identity(home), project: identity(project) };
  // A profile recreated at the same address must not select a fresh journal key.
  const targetKey = hash(json({ hostId, provider, homePath: home, projectPath: project }));
  let stopped = null;
  const check = () => {
    if (stopped) throw stopped;
    try {
      authority(signal, assertCurrentAuthority, action, targetRequest, operationScope); rootPin.verify(); homePin.verify(); projectPin.verify();
      if (!equal(identity(root), store) || !equal(identity(home), target.home) || !equal(identity(project), target.project)) fail("DESTINATION_IMPORT_ROOT_CHANGED");
    } catch (error) { stopped = error; throw error; }
  };
  check(); return { root, store, target, targetKey, check, signal, stopped: () => stopped };
}
function file(context, relative) { context.check(); return copiedProjectFile(context.root, relative); }
function exists(context, relative) { return Boolean(fs.lstatSync(file(context, relative), { throwIfNoEntry: false })); }
function read(context, relative) {
  const raw = nativeRaw(context.root, relative, context.signal, context.check);
  return { raw: raw.raw, digest: raw.entry.sha256, document: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw.raw)) };
}
function create(context, relative, document) {
  const name = file(context, relative); fs.mkdirSync(path.dirname(name), { recursive: true }); context.check();
  atomicCreateArtifact(name, json(document));
}
const paths = key => ({ anchor: "targets/" + key + "/target.json", header: "journals/" + key + "/journal.json", claims: "targets/" + key + "/claims/", attempts: "journals/" + key + "/effects/" });
function unknown(reason, extra = {}) {
  return { status: "destination-history-unknown", authorityPlane: "P5", reasonCode: reason, automaticRetryAllowed: false,
    targetPublicationAllowed: false, nativeEffectAttempted: false, priorAttemptsAbsentProven: false,
    grantsRecoveryAuthority: false, restoresExecutionPermission: false, ...extra };
}

// This is a separate first-adoption effect under the current user's exact target
// request, never a consequence of read/status, missing files or a source packet.
// Host code owns journalRoot/hostId. Do not populate them from archive hints.
export function admitDestinationImportTarget(options) {
  const ctx = context(options, "admit-new-destination-target"), names = paths(ctx.targetKey);
  if (options.receipt) return unknown("DESTINATION_EXISTING_RECEIPT_REQUIRES_RESUME", { targetKey: ctx.targetKey });
  const hasAnchor = exists(ctx, names.anchor), hasHeader = exists(ctx, names.header);
  if (hasAnchor || hasHeader) return unknown("DESTINATION_TARGET_ALREADY_RECORDED_USE_EXACT_RECEIPT", { targetKey: ctx.targetKey });
  const targetId = crypto.randomUUID(), header = { schemaVersion: 1, kind: "DestinationImportJournalHeader", authorityPlane: "P5", targetId,
    targetKey: ctx.targetKey, store: ctx.store, target: ctx.target, priorAttemptsAbsentProven: false,
    scope: "current-explicit-target-admission-not-global-history-proof", grantsRecoveryAuthority: false, restoresExecutionPermission: false };
  const headerDigest = hash(json(header)), anchor = { schemaVersion: 1, kind: "DestinationImportTargetAnchor", authorityPlane: "P5",
    targetId, targetKey: ctx.targetKey, journalHeaderDigest: headerDigest, store: ctx.store, target: ctx.target };
  let anchorCreated = false;
  try {
    create(ctx, names.anchor, anchor); anchorCreated = true;
    create(ctx, names.header, header);
    const receipt = { schemaVersion: 1, kind: "DestinationImportTargetReceipt", authorityPlane: "P5", targetId, targetKey: ctx.targetKey,
      anchorDigest: hash(json(anchor)), journalHeaderDigest: headerDigest, store: ctx.store, target: ctx.target,
      grantsRecoveryAuthority: false, restoresExecutionPermission: false };
    openDestinationImportTarget({ ...options, receipt }, "admit-new-destination-target");
    return { status: "destination-target-admitted", receipt, priorAttemptsAbsentProven: false,
      meaning: "new current admission; not evidence that no earlier imports ever occurred", nativeEffectAttempted: false, authorityPlane: "P5" };
  } catch (error) {
    if (error.code === "EEXIST" && !anchorCreated) return unknown("DESTINATION_TARGET_ADMISSION_RACED", { targetKey: ctx.targetKey });
    error.destinationImportObservation = { status: "destination-target-admission-unconfirmed", targetKey: ctx.targetKey,
      anchorCreated, nativeEffectAttempted: false, automaticRetryAllowed: false, additionalFilesystemObservationAfterFailure: false };
    throw error;
  }
}

export function openDestinationImportTarget(options, action = "read-destination-target") {
  let ctx;
  try { ctx = context(options, action); }
  catch (error) {
    error.destinationImportObservation = { status: "destination-target-basis-unavailable", nativeEffectAttempted: false,
      priorAttemptsAbsentProven: false, automaticRetryAllowed: false, additionalFilesystemObservationAfterFailure: false };
    throw error;
  }
  const { receipt } = options, names = paths(ctx.targetKey);
  if (!receipt || receipt.schemaVersion !== 1 || receipt.kind !== "DestinationImportTargetReceipt" || receipt.authorityPlane !== "P5"
    || !id(receipt.targetId) || receipt.targetKey !== ctx.targetKey || !digest(receipt.anchorDigest) || !digest(receipt.journalHeaderDigest)
    || !equal(receipt.store, ctx.store) || !equal(receipt.target, ctx.target)
    || receipt.grantsRecoveryAuthority !== false || receipt.restoresExecutionPermission !== false) fail("DESTINATION_TARGET_RECEIPT_BASIS_CHANGED");
  const verify = () => {
    ctx.check();
    if (!exists(ctx, names.anchor) || !exists(ctx, names.header)) fail("DESTINATION_TARGET_JOURNAL_MISSING_UNKNOWN");
    const anchor = read(ctx, names.anchor), header = read(ctx, names.header);
    if (anchor.digest !== receipt.anchorDigest || header.digest !== receipt.journalHeaderDigest
      || anchor.document.kind !== "DestinationImportTargetAnchor" || header.document.kind !== "DestinationImportJournalHeader"
      || anchor.document.targetId !== receipt.targetId || header.document.targetId !== receipt.targetId
      || anchor.document.journalHeaderDigest !== receipt.journalHeaderDigest) fail("DESTINATION_TARGET_JOURNAL_CHANGED");
  };
  verify(); return { ...ctx, receipt, paths: names, verify };
}

// Host-local discovery only. Reconstruct an existing receipt against current
// physical roots; missing or partial records never perform first admission.
export function readLocalDestinationImportTargetReceipt(options) {
  const ctx = context(options, "read-destination-target"), names = paths(ctx.targetKey);
  const hasAnchor = exists(ctx, names.anchor), hasHeader = exists(ctx, names.header);
  if (!hasAnchor || !hasHeader) return unknown(hasAnchor || hasHeader ? "DESTINATION_TARGET_JOURNAL_MISSING_UNKNOWN" : "DESTINATION_TARGET_NOT_ADMITTED", { targetKey: ctx.targetKey });
  const anchor = read(ctx, names.anchor), header = read(ctx, names.header), value = header.document;
  if (value.schemaVersion !== 1 || value.kind !== "DestinationImportJournalHeader" || value.authorityPlane !== "P5"
    || value.targetKey !== ctx.targetKey || !id(value.targetId) || !equal(value.store, ctx.store) || !equal(value.target, ctx.target)
    || value.grantsRecoveryAuthority !== false || value.restoresExecutionPermission !== false
    || anchor.document.kind !== "DestinationImportTargetAnchor" || anchor.document.authorityPlane !== "P5" || anchor.document.schemaVersion !== 1
    || anchor.document.targetKey !== ctx.targetKey || anchor.document.targetId !== value.targetId
    || !equal(anchor.document.store, ctx.store) || !equal(anchor.document.target, ctx.target) || anchor.document.journalHeaderDigest !== header.digest) fail("DESTINATION_TARGET_JOURNAL_CHANGED");
  const receipt = { schemaVersion: 1, kind: "DestinationImportTargetReceipt", authorityPlane: "P5", targetId: value.targetId, targetKey: ctx.targetKey,
    anchorDigest: anchor.digest, journalHeaderDigest: header.digest, store: ctx.store, target: ctx.target,
    grantsRecoveryAuthority: false, restoresExecutionPermission: false };
  openDestinationImportTarget({ ...options, receipt });
  return { status: "destination-existing-target-observed", receipt, nativeEffectAttempted: false, authorityPlane: "P5", priorAttemptsAbsentProven: false };
}

function operationKey(operation) {
  if (!checkedObject(operation, ["provider", "sourceDigest", "projectionDigest", "nativeId", "relativeFile"])
    || !["claude", "codex", "opencode"].includes(operation.provider) || !digest(operation.sourceDigest) || !digest(operation.projectionDigest)
    || !id(operation.nativeId) || typeof operation.relativeFile !== "string") fail("DESTINATION_IMPORT_OPERATION_INVALID");
  // File path safety is also checked against the current selected home below.
  return hash(json({ provider: operation.provider, nativeId: operation.nativeId, relativeFile: operation.relativeFile }));
}
function effect(context, operation) {
  const effectKey = operationKey(operation);
  if (operation.provider !== context.target.provider) fail("DESTINATION_IMPORT_OPERATION_TARGET_MISMATCH");
  copiedProjectFile(context.target.home.path, operation.relativeFile);
  const profileKey = hash(json({ hostId: context.target.hostId, provider: context.target.provider, homePath: context.target.home.path }));
  return { key: effectKey, claim: "claims/" + profileKey + "/" + operation.nativeId + ".json", attempt: context.paths.attempts + effectKey + "/attempt.json",
    result: context.paths.attempts + effectKey + "/result.json" };
}
function attemptReceipt(context, names, operation, attemptDigest) {
  return { kind: "DestinationImportAttemptReceipt", authorityPlane: "P5", targetId: context.receipt.targetId, effectKey: names.key,
    operationDigest: hash(json(operation)), attemptDigest, grantsRecoveryAuthority: false, restoresExecutionPermission: false };
}
function resultReceipt(context, names, operation, attemptDigest, resultDigest) {
  return { kind: "DestinationImportResultReceipt", authorityPlane: "P5", targetId: context.receipt.targetId, effectKey: names.key,
    operationDigest: hash(json(operation)), attemptDigest, resultDigest, grantsRecoveryAuthority: false, restoresExecutionPermission: false };
}
function validateObservation(observed) {
  if (!observed || typeof observed !== "object" || Array.isArray(observed)
    || Object.keys(observed).some(key => !["state", "sha256", "bytes", "prefixVerified"].includes(key))
    || !["matches", "continued", "diverged", "absent", "unobserved"].includes(observed.state)
    || observed.sha256 != null && !digest(observed.sha256) || observed.bytes !== undefined && (!Number.isSafeInteger(observed.bytes) || observed.bytes < 0)
    || observed.prefixVerified !== undefined && typeof observed.prefixVerified !== "boolean") fail("DESTINATION_IMPORT_OBSERVATION_INVALID");
}
function record(context, names, operation, knownAttempt = null, knownResult = null) {
  context.verify();
  if (knownAttempt && (knownAttempt.kind !== "DestinationImportAttemptReceipt" || knownAttempt.targetId !== context.receipt.targetId
    || knownAttempt.effectKey !== names.key || knownAttempt.operationDigest !== hash(json(operation)) || !digest(knownAttempt.attemptDigest)))
    fail("DESTINATION_IMPORT_KNOWN_ATTEMPT_SCOPE_CHANGED");
  if (knownResult && (knownResult.kind !== "DestinationImportResultReceipt" || knownResult.authorityPlane !== "P5"
    || knownResult.targetId !== context.receipt.targetId || knownResult.effectKey !== names.key
    || knownResult.operationDigest !== hash(json(operation)) || !digest(knownResult.attemptDigest) || !digest(knownResult.resultDigest)
    || knownResult.grantsRecoveryAuthority !== false || knownResult.restoresExecutionPermission !== false))
    fail("DESTINATION_IMPORT_KNOWN_RESULT_SCOPE_CHANGED");
  const hasClaim = exists(context, names.claim), hasAttempt = exists(context, names.attempt), hasResult = exists(context, names.result);
  if (!hasClaim && !hasAttempt && !hasResult) return knownResult ? unknown("DESTINATION_KNOWN_RESULT_RECORDS_LOST") : knownAttempt ? unknown("DESTINATION_KNOWN_ATTEMPT_RECORDS_LOST")
    : { status: "no-current-effect-records-observed", priorAttemptsAbsentProven: false, nativeEffectAttempted: false };
  const claim = hasClaim ? read(context, names.claim) : null;
  if (claim) {
    const value = claim.document;
    if (!checkedObject(value, ["schemaVersion", "kind", "authorityPlane", "targetId", "attemptId", "attemptDigest", "operation"])
      || value.schemaVersion !== 1 || value.kind !== "DestinationImportEffectClaim" || value.authorityPlane !== "P5"
      || !id(value.targetId) || !id(value.attemptId) || !digest(value.attemptDigest)) fail("DESTINATION_IMPORT_EFFECT_TAMPER");
    operationKey(value.operation);
    if (value.targetId !== context.receipt.targetId) return unknown("DESTINATION_NATIVE_ID_CLAIMED_BY_OTHER_TARGET");
  }
  if (!hasClaim || !hasAttempt) return unknown("DESTINATION_EFFECT_RECORD_LOST_OR_PARTIAL");
  const attempt = read(context, names.attempt);
  if (knownAttempt && attempt.digest !== knownAttempt.attemptDigest) fail("DESTINATION_IMPORT_EFFECT_TAMPER");
  if (knownResult && attempt.digest !== knownResult.attemptDigest) fail("DESTINATION_IMPORT_EFFECT_TAMPER");
  if (!checkedObject(attempt.document, ["schemaVersion", "kind", "authorityPlane", "attemptId", "targetId", "operation", "automaticRetryAllowed", "grantsRecoveryAuthority", "restoresExecutionPermission"])
    || attempt.document.schemaVersion !== 1 || attempt.document.authorityPlane !== "P5"
    || !id(attempt.document.attemptId) || attempt.document.automaticRetryAllowed !== false
    || attempt.document.grantsRecoveryAuthority !== false || attempt.document.restoresExecutionPermission !== false
    || claim.document.kind !== "DestinationImportEffectClaim" || attempt.document.kind !== "DestinationImportAttempt"
    || claim.document.targetId !== context.receipt.targetId || attempt.document.targetId !== context.receipt.targetId
    || !equal(claim.document.operation, attempt.document.operation)
    || claim.document.attemptDigest !== attempt.digest || claim.document.attemptId !== attempt.document.attemptId)
    fail("DESTINATION_IMPORT_EFFECT_TAMPER");
  if (!equal(attempt.document.operation, operation)) fail("DESTINATION_IMPORT_OPERATION_CONFLICT");
  if (!hasResult) return unknown(knownResult ? "DESTINATION_KNOWN_RESULT_RECORDS_LOST" : "DESTINATION_EFFECT_RESERVED_OUTCOME_UNKNOWN", { effectKey: names.key, attemptReceipt: attemptReceipt(context, names, operation, attempt.digest) });
  const result = read(context, names.result);
  if (knownResult && result.digest !== knownResult.resultDigest) fail("DESTINATION_IMPORT_EFFECT_TAMPER");
  if (!checkedObject(result.document, ["schemaVersion", "kind", "authorityPlane", "targetId", "operation", "attemptId", "attemptDigest", "observation",
      "semanticTaskCompletionClaimed", "grantsRecoveryAuthority", "restoresExecutionPermission"])
    || result.document.schemaVersion !== 1 || result.document.authorityPlane !== "P5"
    || result.document.semanticTaskCompletionClaimed !== false || result.document.grantsRecoveryAuthority !== false || result.document.restoresExecutionPermission !== false
    || result.document.kind !== "DestinationImportResult" || result.document.targetId !== context.receipt.targetId
    || result.document.attemptDigest !== attempt.digest || result.document.attemptId !== attempt.document.attemptId
    || !equal(result.document.operation, operation)) fail("DESTINATION_IMPORT_EFFECT_TAMPER");
  validateObservation(result.document.observation);
  return { status: "destination-result-recorded", authorityPlane: "P5", effectKey: names.key, result: result.document,
    attemptReceipt: attemptReceipt(context, names, operation, attempt.digest),
    resultReceipt: resultReceipt(context, names, operation, attempt.digest, result.digest),
    recordedResultIntegrity: knownResult ? "matches-retained-result-receipt" : "current-file-observed-without-retained-result-receipt",
    currentNativeTargetObserved: false, semanticTaskCompletionClaimed: false,
    automaticRetryAllowed: false, targetPublicationAllowed: false, nativeEffectAttempted: false, priorAttemptsAbsentProven: false };
}

export function readDestinationImportEffect(options) {
  const ctx = openDestinationImportTarget(options), names = effect(ctx, options.operation);
  return record(ctx, names, options.operation, options.knownAttempt, options.knownResult);
}

export function reserveDestinationImportEffect(options) {
  const ctx = openDestinationImportTarget(options, "reserve-destination-effect"), operation = structuredClone(options.operation), names = effect(ctx, operation);
  const previous = record(ctx, names, operation, options.knownAttempt, options.knownResult);
  if (previous.status !== "no-current-effect-records-observed") return previous;
  // A source packet can carry known attempts but can never erase them or grant
  // permission. Unmatched/partial history is not automatically a new target.
  if (options.historicalDisposition !== "current-explicit-new-target-intent")
    return unknown("DESTINATION_IMPORT_HISTORICAL_TARGET_DISPOSITION_REQUIRED");
  if (!options.historyAssessment || options.historyAssessment.sameTargetAttemptObserved !== false || options.historyAssessment.unresolvedAttemptObserved !== false
    || !digest(options.historyAssessment.evidenceDigest)) return unknown("DESTINATION_IMPORT_HISTORICAL_ATTEMPT_UNRESOLVED");
  let sourceClaim = null;
  if (options.sourceConversationKey !== undefined) {
    if (!digest(options.sourceConversationKey) || !Array.isArray(options.alternativeNativeIds)
      || options.alternativeNativeIds.some(value => !id(value))) fail("DESTINATION_SOURCE_CONVERSATION_SCOPE_INVALID");
    for (const alternativeId of options.alternativeNativeIds.filter(value => value !== operation.nativeId)) {
      const alternative = effect(ctx, { ...operation, nativeId: alternativeId });
      if (!exists(ctx, alternative.claim)) continue;
      const claim = read(ctx, alternative.claim).document;
      if (claim.kind !== "DestinationImportEffectClaim" || claim.targetId !== ctx.receipt.targetId || !claim.operation
        || claim.operation.nativeId !== alternativeId || claim.operation.sourceDigest !== operation.sourceDigest) fail("DESTINATION_IMPORT_EFFECT_TAMPER");
      operationKey(claim.operation);
      return unknown("DESTINATION_ALTERNATE_PROFILE_ATTEMPT_OBSERVED", { alternativeNativeId: alternativeId });
    }
    const relative = "source-conversations/" + ctx.targetKey + "/" + options.sourceConversationKey + ".json";
    if (exists(ctx, relative)) {
      const claim = read(ctx, relative).document;
      if (claim.schemaVersion !== 1 || claim.kind !== "DestinationSourceConversationClaim" || claim.authorityPlane !== "P5" || claim.targetId !== ctx.receipt.targetId
        || claim.sourceConversationKey !== options.sourceConversationKey || !claim.operation || claim.grantsRecoveryAuthority !== false || claim.restoresExecutionPermission !== false) fail("DESTINATION_IMPORT_EFFECT_TAMPER");
      operationKey(claim.operation);
      return unknown(equal(claim.operation, operation) ? "DESTINATION_SOURCE_CLAIM_WITHOUT_EFFECT_UNKNOWN" : "DESTINATION_SOURCE_ALREADY_RESERVED_FOR_OTHER_PROJECTION");
    }
    const claim = { schemaVersion: 1, kind: "DestinationSourceConversationClaim", authorityPlane: "P5", targetId: ctx.receipt.targetId,
      sourceConversationKey: options.sourceConversationKey, operation, grantsRecoveryAuthority: false, restoresExecutionPermission: false };
    try { create(ctx, relative, claim); }
    catch (error) { if (error.code === "EEXIST") return unknown("DESTINATION_SOURCE_CONVERSATION_RESERVATION_RACED"); throw error; }
    sourceClaim = { relative, digest: hash(json(claim)) };
  }
  const attempt = { schemaVersion: 1, kind: "DestinationImportAttempt", authorityPlane: "P5", attemptId: crypto.randomUUID(),
    targetId: ctx.receipt.targetId, operation, automaticRetryAllowed: false, grantsRecoveryAuthority: false, restoresExecutionPermission: false };
  const attemptDigest = hash(json(attempt)), claim = { schemaVersion: 1, kind: "DestinationImportEffectClaim", authorityPlane: "P5",
    targetId: ctx.receipt.targetId, attemptId: attempt.attemptId, attemptDigest, operation };
  let claimCreated = false;
  try {
    ctx.verify(); create(ctx, names.claim, claim); claimCreated = true;
    create(ctx, names.attempt, attempt);
    const lease = Object.freeze({ kind: "DestinationImportLease", effectKey: names.key });
    leases.set(lease, { options: { ...options, operation, receipt: structuredClone(options.receipt) }, names, operation, attempt, attemptDigest,
      claimDigest: hash(json(claim)), consumed: false, sourceClaim });
    return { status: "destination-effect-reserved", authorityPlane: "P5", lease, effectKey: names.key,
      attemptReceipt: attemptReceipt(ctx, names, operation, attemptDigest),
      automaticRetryAllowed: false, nativeEffectAttempted: false, priorAttemptsAbsentProven: false };
  } catch (error) {
    if (error.code === "EEXIST" && !claimCreated) return unknown("DESTINATION_EFFECT_RESERVATION_RACED", { effectKey: names.key });
    error.destinationImportObservation = { status: "destination-effect-reservation-unconfirmed", effectKey: names.key,
      claimCreated, nativeEffectAttempted: false, automaticRetryAllowed: false, additionalFilesystemObservationAfterFailure: false };
    throw error;
  }
}

// Only the already-consumed journal lease can issue this in-process capability.
// A serialized handle, receipt or archived instruction cannot authorize a file.
export function consumeDestinationNativeWriteCapability(capability, { nativeHome, projectRoot, operation }) {
  const active = nativeWrites.get(capability); nativeWrites.delete(capability);
  if (!active || !active.open) fail("DESTINATION_NATIVE_WRITE_CAPABILITY_UNAVAILABLE");
  active.check();
  if (nativeHome !== active.target.home.path || projectRoot !== active.target.project.path || !equal(operation, active.operation)) fail("DESTINATION_NATIVE_WRITE_SCOPE_CHANGED");
  return { check: () => { if (!active.open) fail("DESTINATION_NATIVE_WRITE_CAPABILITY_CLOSED"); active.check(); } };
}

// The trusted adapter supplies a bounded effect and independent observation.
// No string command, prompt, code, provider handle or saved artifact is executed.
// The journal records operational evidence, not semantic success or P2 approval.
export async function executeDestinationImportEffect({ lease, execute, observe }) {
  const active = leases.get(lease);
  if (!active || active.consumed) fail("DESTINATION_IMPORT_LEASE_NOT_AVAILABLE");
  if (typeof execute !== "function" || typeof observe !== "function") fail("DESTINATION_IMPORT_HOST_CAPABILITY_REQUIRED");
  active.consumed = true;
  const { names, operation, attempt, attemptDigest } = active;
  let context;
  let entered = false;
  try {
    context = openDestinationImportTarget(active.options, "execute-destination-effect");
    const exactAttempt = () => {
      context.verify();
      if (read(context, names.attempt).digest !== attemptDigest || read(context, names.claim).digest !== active.claimDigest)
        fail("DESTINATION_IMPORT_EFFECT_TAMPER");
      if (active.sourceClaim && read(context, active.sourceClaim.relative).digest !== active.sourceClaim.digest) fail("DESTINATION_IMPORT_EFFECT_TAMPER");
    };
    context.verify();
    const before = record(context, names, operation);
    if (before.status !== "destination-history-unknown" || before.reasonCode !== "DESTINATION_EFFECT_RESERVED_OUTCOME_UNKNOWN") fail("DESTINATION_IMPORT_EFFECT_BASIS_CHANGED");
    exactAttempt(); context.check(); entered = true;
    const nativeWriteCapability = Object.freeze({ kind: "DestinationNativeWriteCapability" });
    const writeScope = { open: true, target: context.target, operation, check: () => { context.check(); exactAttempt(); } };
    nativeWrites.set(nativeWriteCapability, writeScope);
    try { await execute({ check: context.check, nativeWriteCapability }); }
    finally { writeScope.open = false; nativeWrites.delete(nativeWriteCapability); }
    context.check(); exactAttempt();
    const observation = await observe({ check: context.check });
    context.check(); exactAttempt();
    const observed = JSON.parse(JSON.stringify(observation));
    validateObservation(observed);
    const result = { schemaVersion: 1, kind: "DestinationImportResult", authorityPlane: "P5", targetId: context.receipt.targetId,
      operation, attemptId: attempt.attemptId, attemptDigest, observation: observed,
      semanticTaskCompletionClaimed: false, grantsRecoveryAuthority: false, restoresExecutionPermission: false };
    create(context, names.result, result);
    return { status: "destination-result-recorded", authorityPlane: "P5", effectKey: names.key, result,
      attemptReceipt: attemptReceipt(context, names, operation, attemptDigest),
      resultReceipt: resultReceipt(context, names, operation, attemptDigest, hash(json(result))),
      recordedResultIntegrity: "created-with-retained-result-receipt", currentNativeTargetObserved: observed.state !== "unobserved",
      nativeEffectAttempted: true, automaticRetryAllowed: false, semanticTaskCompletionClaimed: false };
  } catch (error) {
    error.destinationImportObservation = { status: "destination-effect-outcome-unknown", effectKey: names.key, nativeEffectAttempted: entered,
      automaticRetryAllowed: false, rollbackAttempted: false, additionalFilesystemObservationAfterFailure: false };
    throw error;
  }
}

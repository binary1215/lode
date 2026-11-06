import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { atomicCreateArtifact } from "./artifact-storage.mjs";
import { copiedProjectFile } from "./project-copy-evidence.mjs";
import { claudeNativeProjectName } from "./claude-native-history.mjs";
import { nativeRoot, pinNativeRoot, nativeSeparate, nativeRaw, nativeCheck, nativeOutcome } from "./provider-native-history-host.mjs";
import { CLAUDE_DERIVED_FORMAT as format, derivedHash as hash, derivedJson as json, derivedFail as fail } from "./claude-derived-encoder.mjs";
import { compareClaudeDerivedReader } from "./claude-derived-reader-coverage.mjs";
import { CODEX_HYBRID_CONVERTER, CODEX_HYBRID_PROFILES } from "./codex-claude-hybrid.mjs";
import { physicalDerivationAlternatives } from "./project-native-derivation.mjs";
import { readDestinationImportEffect, reserveDestinationImportEffect, executeDestinationImportEffect, consumeDestinationNativeWriteCapability } from "./destination-import-journal.mjs";

const regular = (root, relative) => {
  const file = copiedProjectFile(root, relative), stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) fail("DERIVED_TARGET_UNSAFE");
  return { file, stat };
};
function rootIdentity(root) {
  const stat = fs.lstatSync(root, { bigint: true });
  return { path: root, dev: String(stat.dev), ino: String(stat.ino) };
}
function targetContext({ artifact, nativeHome, root, signal, assertCurrentAuthority }) {
  nativeCheck(signal, () => { const value = assertCurrentAuthority(); if (value === false) fail("NATIVE_HISTORY_AUTHORITY_DENIED"); return value; });
  const home = nativeRoot(nativeHome), project = nativeRoot(root), hp = pinNativeRoot(home), pp = pinNativeRoot(project);
  const expected = artifact.manifest.input.targetRoot;
  if (!isDeepStrictEqual(rootIdentity(project), expected)) fail("DERIVED_TARGET_PROJECT_ROOT_CHANGED");
  nativeSeparate(home, artifact.bundleRoot);
  const relative = "projects/" + claudeNativeProjectName(project) + "/" + artifact.manifest.target.nativeId + ".jsonl";
  const homeIdentity = rootIdentity(home);
  let stoppedFailure = null;
  const recheckArtifact = () => {
    if (stoppedFailure) throw stoppedFailure;
    try { artifact.recheck(); } catch (error) { stoppedFailure = error; throw error; }
  };
  const check = () => {
    if (stoppedFailure) throw stoppedFailure;
    try {
    nativeCheck(signal, () => { const value = assertCurrentAuthority(); if (value === false) fail("NATIVE_HISTORY_AUTHORITY_DENIED"); return value; }); artifact.check(); hp.verify(); pp.verify();
    if (!isDeepStrictEqual(rootIdentity(home), homeIdentity) || !isDeepStrictEqual(rootIdentity(project), expected)) fail("DERIVED_TARGET_ROOT_CHANGED");
    regular(home, relative);
    } catch (error) { stoppedFailure = error; throw error; }
  };
  check();
  return { home, project, relative, check, recheckArtifact, homeIdentity, stoppedFailure: () => stoppedFailure };
}
function mustStop(context, error, signal) {
  return context.stoppedFailure() === error || signal?.aborted || error?.name === "AbortError"
    || ["EPERM", "EACCES", "ABORT_ERR", "NATIVE_HISTORY_OPERATION_CANCELLED", "NATIVE_HISTORY_AUTHORITY_DENIED",
      "DERIVED_ARTIFACT_TAMPER", "DERIVED_SOURCE_PAYLOAD_CHANGED"].includes(error?.code);
}
function retainNativeFailure(error, artifact, extra) {
  error.derivedNativeOperationResult = { ...outcome(artifact, extra), kind: "ClaudeDerivedNativeOperationPartialOutcome",
    primaryFailure: { code: error.code || error.name }, additionalObservationAfterFailure: false,
    automaticReplayAllowed: false, rollbackAttempted: false };
}
function observeTarget(artifact, context, signal) {
  context.check(); const named = regular(context.home, context.relative);
  if (!named.stat) return { state: "absent", file: named.file, transcriptBytes: 0 };
  const raw = nativeRaw(context.home, context.relative, signal, context.check).raw;
  if (raw.length < artifact.raw.length || !raw.subarray(0, artifact.raw.length).equals(artifact.raw))
    return { state: "diverged", file: named.file, transcriptBytes: raw.length, targetSha256: hash(raw) };
  const tail = raw.subarray(artifact.raw.length);
  if (tail.length) {
    if (tail.at(-1) !== 10) return { state: "continued-partial-append", file: named.file, transcriptBytes: raw.length, prefixVerified: true };
    try { for (const line of new TextDecoder("utf-8", { fatal: true }).decode(tail).trimEnd().split(/\r?\n/u)) if (line) JSON.parse(line); }
    catch { return { state: "continued-invalid-append", file: named.file, transcriptBytes: raw.length, prefixVerified: true }; }
  }
  return { state: tail.length ? "continued" : "matches", file: named.file, transcriptBytes: raw.length, targetSha256: hash(raw),
    prefixVerified: true, appendedBytes: tail.length, identity: { dev: named.stat.dev, ino: named.stat.ino }, raw };
}
function duplicateScope(artifact, context) {
  context.check();
  const projects = copiedProjectFile(context.home, "projects"), stat = fs.lstatSync(projects, { throwIfNoEntry: false });
  if (!stat) return { status: "complete-at-observation", examinedDirectories: 0, globalUniquenessProven: false };
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("DERIVED_PROJECTS_DIRECTORY_UNSAFE");
  let examinedDirectories = 0;
  for (const dir of fs.readdirSync(projects, { withFileTypes: true })) {
    context.check();
    if (dir.isSymbolicLink()) fail("DERIVED_DUPLICATE_SCOPE_UNQUALIFIED");
    if (!dir.isDirectory()) continue;
    examinedDirectories++;
    const relative = "projects/" + dir.name + "/" + artifact.manifest.target.nativeId + ".jsonl";
    if (relative === context.relative) continue;
    // Metadata for this exact new ID only. No other conversation body/preview,
    // account, settings, session index or private Desktop store is read.
    if (fs.lstatSync(copiedProjectFile(context.home, relative), { throwIfNoEntry: false })) fail("DERIVED_OTHER_PROJECT_ID_CONFLICT");
  }
  return { status: "complete-at-observation", examinedDirectories, globalUniquenessProven: false,
    concurrencyGuarantee: "not-a-writer-lease; final exact absent-name create is authoritative for collision" };
}
function visible(observation) { const { raw, ...rest } = observation; return rest; }
function outcome(artifact, extra) {
  return { ...nativeOutcome("claude"), derivationId: artifact.manifest.derivationId, derivationDigest: artifact.digest,
    targetNativeId: artifact.manifest.target.nativeId, sourceOriginalsPreserved: true, sourceOriginalsPreservedScope: "selected-native-originals-not-overwritten; not-verification-of-other-workspace-bodies", sharedNativeMetadataWritten: false,
    existingWritersStopped: false, desktopVisibility: "not-observed", modelContextUse: "not-tested", ...extra };
}
async function qualify(artifact, context, host) {
  if (!host || host.provider !== "claude" || typeof host.version !== "function") fail("DERIVED_CLAUDE_HOST_REQUIRED");
  const version = await host.version({ home: context.home, cwd: context.project }); context.check();
  context.recheckArtifact();
  if (version !== format.cliVersion) fail("DERIVED_CLAUDE_VERSION_UNQUALIFIED");
  return { version, executableDigest: host.executableDigest || null, hostEvidence: host.evidenceKind };
}

function alternateProfileFile(artifact, context) {
  for (const alternative of physicalDerivationAlternatives(artifact.manifest.input)) {
    if (alternative.nativeId === artifact.manifest.target.nativeId) continue;
    const relative = "projects/" + claudeNativeProjectName(context.project) + "/" + alternative.nativeId + ".jsonl";
    context.check(); if (regular(context.home, relative).stat) return alternative;
  }
  return null;
}
function publishNewDerivedFile({ artifact, context, signal, publishFile, writeScope = null }) {
  const check = () => { writeScope?.check(); context.check(); };
  check(); duplicateScope(artifact, context);
  if (alternateProfileFile(artifact, context)) fail("DERIVED_ALTERNATE_PROFILE_NATIVE_ALREADY_PRESENT");
  if (observeTarget(artifact, context, signal).state !== "absent") fail("DERIVED_TARGET_CREATED_DURING_PUBLICATION");
  const file = copiedProjectFile(context.home, context.relative);
  fs.mkdirSync(path.dirname(file), { recursive: true }); check(); context.recheckArtifact(); check();
  const expected = artifact.manifest.files.find(entry => entry.file === "conversation.jsonl");
  if (!expected || artifact.raw.length !== expected.bytes || hash(artifact.raw) !== expected.sha256) fail("DERIVED_ARTIFACT_TAMPER");
  publishFile(file, artifact.raw);
}

// Target-PC journal consumer. The current trusted Host supplies target scope
// and derives history assessment from verified originals/current user intent.
// Ordinary JSON flags, a portable archive and old P5 records cannot supply it.
export async function publishClaudeDerivedWithDestinationJournal({ artifact, nativeHome, root, host, destinationHost,
  signal, assertCurrentAuthority, publishFile = atomicCreateArtifact }) {
  if (typeof assertCurrentAuthority !== "function" || typeof destinationHost?.currentImportScope !== "function") fail("DESTINATION_IMPORT_CURRENT_HOST_REQUIRED");
  if (!artifact.manifest.publicationReady) return outcome(artifact, { status: "native-derived-representation-incomplete", filesWritten: 0 });
  const context = targetContext({ artifact, nativeHome, root, signal, assertCurrentAuthority });
  const alternate = alternateProfileFile(artifact, context);
  if (alternate) return outcome(artifact, { status: "native-derived-alternate-profile-already-present", alternativeNativeId: alternate.nativeId, filesWritten: 0 });
  const client = await qualify(artifact, context, host); context.recheckArtifact();
  const operation = { provider: "claude", sourceDigest: artifact.manifest.source.nativePayloadDigest,
    projectionDigest: artifact.digest, nativeId: artifact.manifest.target.nativeId, relativeFile: context.relative };
  const selectedScope = await destinationHost.currentImportScope({ provider: "claude", nativeHome: context.home, projectRoot: context.project,
    operation: structuredClone(operation), sourceBinding: structuredClone(artifact.manifest.source),
    alternativeNativeIds: physicalDerivationAlternatives(artifact.manifest.input).map(row => row.nativeId) });
  context.check(); context.recheckArtifact();
  if (!selectedScope || selectedScope.nativeHome !== context.home || selectedScope.projectRoot !== context.project || selectedScope.provider !== "claude"
    || typeof selectedScope.assertCurrentAuthority !== "function") fail("DESTINATION_IMPORT_CURRENT_HOST_SCOPE_CHANGED");
  const scopeCheck = () => { context.check(); nativeCheck(signal, () => selectedScope.assertCurrentAuthority({ action: "publish-derived-destination-journal", operation: structuredClone(operation) })); };
  const journalOptions = { ...selectedScope, operation, signal,
    ...(physicalDerivationAlternatives(artifact.manifest.input).length ? {
      sourceConversationKey: hash(json({ source: artifact.manifest.input.source, selection: artifact.manifest.input.selection })),
      alternativeNativeIds: physicalDerivationAlternatives(artifact.manifest.input).map(row => row.nativeId),
    } : {}),
    assertCurrentAuthority: request => { context.check(); return selectedScope.assertCurrentAuthority(request); } };
  const previous = readDestinationImportEffect(journalOptions); scopeCheck();
  const before = observeTarget(artifact, context, signal);
  if (before.state !== "absent" || previous.status !== "no-current-effect-records-observed")
    return outcome(artifact, { status: before.state === "diverged" ? "native-derived-target-conflict" : "native-derived-destination-no-new-effect",
      client, destinationJournal: previous, targetObservation: visible(before), currentNativeTargetObserved: true,
      filesWritten: 0, publicationOwnership: "not-inferred-from-bytes" });
  const reserved = reserveDestinationImportEffect(journalOptions);
  if (reserved.status !== "destination-effect-reserved") {
    // Saved operational result remains historical. Read the actual target now
    // before describing a present prefix, and never replay an uncertain effect.
    scopeCheck(); const observed = observeTarget(artifact, context, signal);
    return outcome(artifact, { status: "native-derived-destination-no-new-effect", client, destinationJournal: reserved,
      targetObservation: visible(observed), currentNativeTargetObserved: true, filesWritten: 0, publicationOwnership: "not-inferred-from-bytes" });
  }
  let filesWritten = 0;
  const recorded = await executeDestinationImportEffect({ lease: reserved.lease,
    execute: ({ check, nativeWriteCapability }) => {
      check(); scopeCheck();
      const writeScope = consumeDestinationNativeWriteCapability(nativeWriteCapability, { nativeHome: context.home, projectRoot: context.project, operation });
      publishNewDerivedFile({ artifact, context, signal, publishFile, writeScope }); filesWritten = 1;
    },
    observe: ({ check }) => {
      check(); scopeCheck(); const observed = observeTarget(artifact, context, signal);
      return { state: ["matches", "continued", "diverged", "absent"].includes(observed.state) ? observed.state : "unobserved",
        ...(observed.targetSha256 ? { sha256: observed.targetSha256 } : {}), bytes: observed.transcriptBytes, prefixVerified: observed.prefixVerified === true };
    } });
  return outcome(artifact, { status: "native-derived-destination-result-recorded", client, destinationJournal: recorded,
    filesWritten, semanticTaskCompletionClaimed: false, automaticOpen: false, automaticModelSend: false });
}

// Different from same-platform restore: one complete new-ID JSONL is exposed
// by atomic no-clobber link. Never change that adapter's stopped-writer guard.
export async function publishClaudeDerived({ artifact, nativeHome, root, host, signal, assertCurrentAuthority = () => {},
  publishFile = atomicCreateArtifact, destinationHost = null }) {
  if (CODEX_HYBRID_PROFILES.includes(artifact.manifest.input.converter))
    return publishClaudeDerivedWithDestinationJournal({ artifact, nativeHome, root, host, signal, assertCurrentAuthority, publishFile, destinationHost });
  if (!artifact.manifest.publicationReady) return outcome(artifact, { status: "native-derived-representation-incomplete", filesWritten: 0 });
  const context = targetContext({ artifact, nativeHome, root, signal, assertCurrentAuthority });
  const client = await qualify(artifact, context, host), duplicates = duplicateScope(artifact, context);
  let observed = observeTarget(artifact, context, signal);
  const result = (status, extra = {}) => outcome(artifact, { status, client, duplicateObservation: duplicates,
    targetObservation: visible(observed), filesWritten: 0, ...extra });
  const operation = { derivationDigest: artifact.digest, targetNativeId: artifact.manifest.target.nativeId,
    home: context.homeIdentity, project: artifact.manifest.input.targetRoot, relative: context.relative, client };
  // A changed executable or recreated profile at the same address must not
  // erase an earlier uncertain attempt by selecting a different journal key.
  const effectKey = { derivationDigest: artifact.digest, homePath: context.home, relative: context.relative };
  const effectRelative = "effects/" + hash(json(effectKey)).slice(0, 24);
  const effectRoot = copiedProjectFile(artifact.directory, effectRelative);
  const attemptFile = copiedProjectFile(artifact.directory, effectRelative + "/publication-attempt.json");
  const attempt = { schemaVersion: 1, kind: "ClaudeDerivedPublicationAttempt", authorityPlane: "P5", operation,
    automaticReplayAllowed: false, grantsRecoveryAuthority: false, restoresExecutionPermission: false };
  if (fs.existsSync(attemptFile) && !nativeRaw(effectRoot, "publication-attempt.json", signal, context.check).raw.equals(json(attempt)))
    fail("DERIVED_PUBLICATION_ATTEMPT_MISMATCH");
  if (observed.state === "diverged") return result("native-derived-target-conflict");
  if (observed.state !== "absent") return result(observed.state === "matches" ? "native-derived-target-observed-exact" : "native-derived-target-continued",
    { nativeProfilePublished: ["matches", "continued"].includes(observed.state), publicationOwnership: "not-inferred-from-bytes", initialPrefixVerified: true });
  fs.mkdirSync(effectRoot, { recursive: true }); copiedProjectFile(artifact.directory, path.relative(artifact.directory, effectRoot).split(path.sep).join("/"));
  context.check();
  try { atomicCreateArtifact(attemptFile, json(attempt)); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const previous = nativeRaw(effectRoot, "publication-attempt.json", signal, context.check).raw;
    if (!previous.equals(json(attempt))) fail("DERIVED_PUBLICATION_ATTEMPT_MISMATCH");
    observed = observeTarget(artifact, context, signal);
    return result(observed.state === "absent" ? "native-derived-publication-uncertain" : observed.state === "diverged"
      ? "native-derived-target-conflict" : "native-derived-target-observed-after-attempt",
    { reason: "An earlier effect may have started; observe exact target, never replay an absent or uncertain publication.", attemptFile });
  }
  let filesWritten = 0;
  try {
    publishNewDerivedFile({ artifact, context, signal, publishFile }); filesWritten = 1;
    observed = observeTarget(artifact, context, signal);
    if (!["matches", "continued"].includes(observed.state)) fail("DERIVED_TARGET_CHANGED_AFTER_PUBLICATION");
    const receipt = { schemaVersion: 1, kind: "ClaudeDerivedPublicationReceipt", authorityPlane: "P5", operation,
      targetObservation: visible(observed), filesWritten, sourceOriginalsPreserved: true,
      sharedMetadataWritten: false, grantsRecoveryAuthority: false, restoresExecutionPermission: false };
    context.check(); atomicCreateArtifact(copiedProjectFile(effectRoot, "publication-receipt.json"), json(receipt));
    return result("native-derived-transcript-published", { nativeProfilePublished: true, filesWritten,
      initialPrefixVerified: true, publicationReceipt: copiedProjectFile(effectRoot, "publication-receipt.json"),
      officialContinuation: { executableVersion: client.version, arguments: ["--desktop", "--resume", artifact.manifest.target.nativeId],
        cwd: context.project, nativeHome: context.home, automaticOpen: false, automaticModelSend: false,
        status: "exact-target-readback-required-before-separate-authorized-official-open" } });
  } catch (error) {
    if (mustStop(context, error, signal)) {
      retainNativeFailure(error, artifact, { status: "native-derived-publication-uncertain", filesWritten,
        phase: "publication", attemptFile, observationBeforeAttempt: visible(observed),
        targetObservation: { state: "unobserved-after-failure" } });
      throw error;
    }
    let readback;
    try { readback = visible(observeTarget(artifact, context, signal)); }
    catch (failure) { readback = { state: "unobserved", primaryReadFailure: failure.code || failure.name }; }
    // No rollback, overwrite, delete, retry or settings/index repair, even if
    // publication succeeded and only the local receipt subsequently failed.
    return result("native-derived-publication-uncertain", { filesWritten, primaryFailure: { code: error.code || error.name },
      targetObservation: readback, attemptFile, automaticReplayAllowed: false });
  }
}

export async function verifyClaudeDerived({ artifact, nativeHome, root, host, signal, assertCurrentAuthority = () => {} }) {
  const context = targetContext({ artifact, nativeHome, root, signal, assertCurrentAuthority });
  let observationBeforeFailure = null;
  try {
  const client = await qualify(artifact, context, host), duplicates = duplicateScope(artifact, context);
  const before = observeTarget(artifact, context, signal);
  observationBeforeFailure = visible(before);
  if (!["matches", "continued"].includes(before.state)) return outcome(artifact, { status: "native-derived-target-not-readable", targetObservation: visible(before), client });
  if (typeof host.readDerivedClaude !== "function") return outcome(artifact, { status: "native-derived-reader-unavailable",
    initialPrefixVerified: true, targetObservation: visible(before), client, reasonCode: "DERIVED_QUALIFIED_SDK_READER_UNAVAILABLE" });
  const rawRows = new TextDecoder("utf-8", { fatal: true }).decode(before.raw).trimEnd().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  const digestObservation = CODEX_HYBRID_PROFILES.includes(artifact.manifest.input.converter);
  const result = await host.readDerivedClaude({ home: context.home, cwd: context.project, nativeId: artifact.manifest.target.nativeId,
    maximumMessages: rawRows.length + 1, ...(digestObservation ? { digestObservation: true } : {}) }); context.check();
  context.recheckArtifact();
  const after = observeTarget(artifact, context, signal);
  if (after.targetSha256 !== before.targetSha256) fail("DERIVED_TARGET_CHANGED_DURING_READER");
  if (result.sdkVersion !== format.sdkVersion || !Array.isArray(result.messages)) fail("DERIVED_READER_OBSERVATION_INVALID");
  if (digestObservation && result.observationProfile !== "claude-sdk-message-digest-v1") fail("DERIVED_READER_OBSERVATION_INVALID");
  const expected = artifact.rows, nativeMessages = rawRows.filter(row => ["user", "assistant"].includes(row.type)), returned = result.messages;
  const coverage = compareClaudeDerivedReader({ nativeMessages, returned, nativeId: artifact.manifest.target.nativeId,
    prefixCount: expected.length, exactSessionObserved: result.sessionInfo?.sessionId === artifact.manifest.target.nativeId, digestObservation });
  const { missing, mismatches, rawCoverageComplete: complete } = coverage;
  const sourceRepresentationComplete = artifact.manifest.publicationReady;
  return outcome(artifact, { status: complete && sourceRepresentationComplete ? "native-derived-official-reader-prefix-verified"
    : complete ? "native-derived-official-reader-emitted-subset-only"
      : coverage.readerProjectionCoverageComplete && sourceRepresentationComplete ? "native-derived-official-reader-observed-with-declared-omissions"
        : "native-derived-official-reader-partial",
    client, sdkVersion: result.sdkVersion, exactSelectedSessionObserved: result.sessionInfo?.sessionId === artifact.manifest.target.nativeId,
    duplicateObservation: duplicates, initialPrefixVerified: true, rawCoverageComplete: complete,
    coverageBasis: "current emitted native transcript, not every original source item",
    emittedNativeCoverageComplete: complete, sourceRepresentationComplete,
    derivedPrefixCoverageComplete: coverage.derivedPrefixCoverageComplete, readerProjectionCoverageComplete: coverage.readerProjectionCoverageComplete,
    declaredReaderOmissionCount: coverage.declaredReaderOmissions.length, declaredReaderOmissions: coverage.declaredReaderOmissions.slice(0, 64),
    omittedDeclaredReaderOmissions: Math.max(0, coverage.declaredReaderOmissions.length - 64),
    unexplainedMissingCount: coverage.unexplainedMissing.length, unexplainedMissing: coverage.unexplainedMissing.slice(0, 64),
    omittedUnexplainedMissing: Math.max(0, coverage.unexplainedMissing.length - 64), readerOmissionProfile: coverage.omissionProfile,
    blockingSourceDiagnosticCount: artifact.diagnostics.filter(row => row.blocksPublication).length,
    expectedPrefixMessages: expected.length, rawNativeConversationMessages: nativeMessages.length, returnedMessages: returned.length,
    missingMessages: missing.slice(0, 64), omittedMissingMessages: Math.max(0, missing.length - 64),
    mismatchCount: mismatches.length, mismatches: mismatches.slice(0, 64), appendedReturnedMessages: Math.max(0, returned.length - expected.length),
    targetObservation: visible(after), sourceItemMappings: artifact.mapping.length,
    originalSourceRolesAndToolBlocksVerified: complete && sourceRepresentationComplete && !digestObservation,
    ...(digestObservation ? { sourceRepresentationProfile: artifact.manifest.input.converter, sdkObservationProfile: result.observationProfile,
      hybridSourceRecordCoverageVerified: complete && sourceRepresentationComplete,
      authoredBodyRoleOrderVerified: complete && artifact.hybridCoverage?.authored.completeAuthoredMessageCoverage === true,
      originalToolRecordsAllNativeBlocksClaimed: false } : {}), desktopVisibility: "not-observed", modelContextUse: "not-tested" });
  } catch (error) {
    retainNativeFailure(error, artifact, { status: "native-derived-verification-unconfirmed", phase: "verification", filesWritten: 0,
      observationBeforeFailure, targetObservation: { state: "unobserved-after-failure" } });
    throw error;
  }
}

function settledNativeTail(raw, nativeId) {
  const records = new TextDecoder("utf-8", { fatal: true }).decode(raw).trimEnd().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
  const pending = new Set(); let last = null;
  for (const row of records) {
    if (!["user", "assistant"].includes(row.type)) continue;
    if (row.sessionId !== nativeId || row.message?.role !== row.type) return false;
    last = row;
    for (const block of Array.isArray(row.message.content) ? row.message.content : []) {
      if (block.type === "tool_use") {
        if (!block.id || pending.has(block.id)) return false;
        pending.add(block.id);
      }
      if (block.type === "tool_result") {
        if (!pending.has(block.tool_use_id)) return false;
        pending.delete(block.tool_use_id);
      }
    }
  }
  // Explicit protocol termination is distinct from semantic task completion.
  // A streaming/null/unknown or paused/tool turn cannot authorize this open.
  // https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons
  return last?.type === "assistant" && ["end_turn", "stop_sequence", "max_tokens", "refusal", "model_context_window_exceeded"].includes(last.message.stop_reason)
    && pending.size === 0 && !last.message.content?.some?.(block => block.type === "tool_use");
}

// An optional trusted Host effect capability, not the generic native process
// runner. Its Job/group cleanup must never kill an intended Desktop handoff.
// Absence is a concrete local limitation; it does not block derive/publish/read.
export async function openClaudeDerived({ artifact, nativeHome, root, host, signal, assertCurrentAuthority = () => {} }) {
  const context = targetContext({ artifact, nativeHome, root, signal, assertCurrentAuthority });
  const client = await qualify(artifact, context, host), duplicates = duplicateScope(artifact, context);
  let observed = observeTarget(artifact, context, signal);
  const result = (status, extra = {}) => outcome(artifact, { status, client, targetObservation: visible(observed), duplicateObservation: duplicates,
    nativeProfilePublishedThisCall: false, modelTurnStarted: null, modelAutoSendRequested: false, desktopVisibility: "not-observed", ...extra });
  if (!artifact.manifest.publicationReady || !artifact.manifest.openSafety.structurallySettled)
    return result("native-derived-open-pending-or-unsupported-source");
  if (!["matches", "continued"].includes(observed.state)) return result("native-derived-open-target-not-ready");
  if (!settledNativeTail(observed.raw, artifact.manifest.target.nativeId)) return result("native-derived-open-pending-native-work");
  if (typeof host.openDerivedDesktop !== "function") return result("native-derived-desktop-launcher-unqualified", {
    reasonCode: "DERIVED_DESKTOP_HANDOFF_LIFETIME_UNQUALIFIED",
    reason: "The default native runner owns and cleans its whole process tree. That is not a qualified external GUI handoff lifetime.",
    officialAlternative: { method: "Desktop local /resume", exactNativeId: artifact.manifest.target.nativeId,
      projectRoot: context.project, nativeHome: context.home, profileConsumptionVerified: false, actualDisplayVerified: false },
    launcherInvoked: false,
  });
  const operation = { derivationDigest: artifact.digest, targetNativeId: artifact.manifest.target.nativeId,
    home: context.homeIdentity, project: artifact.manifest.input.targetRoot, client,
    argv: ["--desktop", "--resume", artifact.manifest.target.nativeId], shell: false, promptAccepted: false };
  const key = { artifact: artifact.digest, homePath: context.home, relative: context.relative };
  const effectRoot = copiedProjectFile(artifact.directory, "effects/open-" + hash(json(key)).slice(0, 24));
  context.check(); fs.mkdirSync(effectRoot, { recursive: true });
  const attemptFile = copiedProjectFile(effectRoot, "desktop-open-attempt.json");
  const attempt = { schemaVersion: 1, kind: "ClaudeDerivedDesktopOpenAttempt", authorityPlane: "P5", operation,
    automaticReplayAllowed: false, grantsRecoveryAuthority: false, restoresExecutionPermission: false };
  context.recheckArtifact(); context.check();
  try { atomicCreateArtifact(attemptFile, json(attempt)); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!nativeRaw(effectRoot, "desktop-open-attempt.json", signal, context.check).raw.equals(json(attempt))) fail("DERIVED_OPEN_ATTEMPT_MISMATCH");
    return result("native-derived-open-already-attempted", { launcherInvoked: false, automaticReplayAllowed: false,
      reason: "Read exact target and GUI observations; an attempt or prior return is not opening success.", attemptFile });
  }
  try {
    context.recheckArtifact(); context.check();
    const now = observeTarget(artifact, context, signal);
    if (now.targetSha256 !== observed.targetSha256 || !settledNativeTail(now.raw, artifact.manifest.target.nativeId)) fail("DERIVED_TARGET_CHANGED_BEFORE_OPEN");
    // Only the trusted Host receives this finite operation. A bundle/tool JSON
    // cannot supply callbacks, shell text, provider prompts or arbitrary argv.
    const returned = await host.openDerivedDesktop({ nativeId: artifact.manifest.target.nativeId, cwd: context.project,
      home: context.home, args: operation.argv, shell: false, signal, assertCurrentAuthority: context.check });
    context.recheckArtifact(); context.check(); observed = observeTarget(artifact, context, signal);
    const receipt = { schemaVersion: 1, kind: "ClaudeDerivedDesktopOpenReturn", authorityPlane: "P5", operation,
      launcherExitCode: Number.isInteger(returned?.exitCode) ? returned.exitCode : null,
      launcherObservation: typeof returned?.status === "string" ? returned.status.slice(0, 128) : "returned-without-observation", targetObservation: visible(observed),
      desktopVisibility: "not-observed", modelContextUse: "not-tested", grantsRecoveryAuthority: false, restoresExecutionPermission: false };
    atomicCreateArtifact(copiedProjectFile(effectRoot, "desktop-open-return.json"), json(receipt));
    return result("native-derived-desktop-handoff-returned", { hostCapabilityInvoked: true, launcherInvoked: null, launcherExitCode: receipt.launcherExitCode,
      attemptFile, automaticReplayAllowed: false, actualDesktopSampleDisplayVerified: false,
      launcherObservation: receipt.launcherObservation });
  } catch (error) {
    if (mustStop(context, error, signal)) {
      retainNativeFailure(error, artifact, { status: "native-derived-desktop-handoff-uncertain", phase: "open",
        hostCapabilityInvoked: true, launcherInvoked: null, attemptFile, observationBeforeFailure: visible(observed),
        targetObservation: { state: "unobserved-after-failure" } });
      throw error;
    }
    return result("native-derived-desktop-handoff-uncertain", { hostCapabilityInvoked: true, launcherInvoked: null, automaticReplayAllowed: false,
      primaryFailure: { code: error.code || error.name }, attemptFile,
      reason: "Do not retry an unknown official open; independently inspect the exact sample and current GUI." });
  }
}

import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import { atomicCreateArtifact } from "./artifact-storage.mjs";
import { claudeNativeProjectName } from "./claude-native-history.mjs";
import { copiedProjectFile } from "./project-copy-evidence.mjs";
import { nativeRoot, nativeRaw, nativeCheck } from "./provider-native-history-host.mjs";
import { openDestinationImportTarget } from "./destination-import-journal.mjs";
import { verifySelectedCodexStateEvidence } from "./codex-native-state-evidence.mjs";
import { capturedCodexDisplayMetadata } from "./codex-display-metadata.mjs";
import { derivedHash as hash, derivedJson as json, derivedFail as fail } from "./claude-derived-encoder.mjs";

const titleCapabilities = new WeakMap();
export function consumeClaudeTitleCapability(capability, binding) {
  const expected = titleCapabilities.get(capability);
  if (!expected || !equal(expected, binding)) fail("TITLE_ONE_USE_CAPABILITY_REQUIRED");
  titleCapabilities.delete(capability);
}
export function observeClaudeTitleFile(home, relativeFile, check = () => {}) {
  const read = nativeRaw(nativeRoot(home), relativeFile, null, check);
  const stat = fs.lstatSync(copiedProjectFile(nativeRoot(home), relativeFile), { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || read.raw.at(-1) !== 10) fail("TITLE_TARGET_UNSAFE");
  const rows = read.raw.toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line));
  const titles = rows.filter(row => row.type === "custom-title");
  const messages = rows.filter(row => ["user", "assistant"].includes(row.type));
  return { raw: read.raw, identity: { dev: String(stat.dev), ino: String(stat.ino) },
    title: titles.at(-1)?.customTitle ?? null, messageDigest: hash(json(messages)), messageCount: messages.length };
}

// Artifact must be the result of the existing exact-source reproducing inspector.
// This proposal is private P3 evidence; current Host authority is still required.
export function proposeClaudeDerivedTitle({ artifact, nativeHome, relativeFile }) {
  artifact.recheck();
  const state = verifySelectedCodexStateEvidence(artifact.selected.native.selectionBinding?.evidence, [artifact.manifest.input.selection.threadId])[0];
  const metadata = capturedCodexDisplayMetadata(state, state.id);
  if (metadata.basis !== "captured-selected-state-name") return null;
  const before = observeClaudeTitleFile(nativeHome, relativeFile, artifact.check);
  if (!before.raw.subarray(0, artifact.raw.length).equals(artifact.raw)) fail("TITLE_IMPORTED_PREFIX_CHANGED");
  return { schemaVersion: 1, kind: "ClaudeDerivedTitleCorrectionPlan", authorityPlane: "P3",
    namingPolicy: metadata.namingPolicy, nativeId: artifact.manifest.target.nativeId, sourceId: state.id,
    sourceDigest: artifact.manifest.source.nativePayloadDigest, derivationDigest: artifact.digest,
    nativeHome: nativeRoot(nativeHome), projectRoot: artifact.manifest.target.cwd, relativeFile,
    desiredTitle: metadata.title, desiredTitleSha256: hash(metadata.title),
    expectedTitleSha256: hash(json(before.title)), importedBytes: artifact.raw.length, importedSha256: hash(artifact.raw),
    fileIdentity: before.identity, expectedMessageDigest: before.messageDigest, expectedMessageCount: before.messageCount,
    grantsRecoveryAuthority: false, restoresExecutionPermission: false, modelCalled: false };
}

export function checkClaudeTitlePlan(plan) {
  if (plan?.kind !== "ClaudeDerivedTitleCorrectionPlan" || plan.schemaVersion !== 1 || plan.authorityPlane !== "P3"
    || plan.relativeFile !== "projects/" + claudeNativeProjectName(plan.projectRoot) + "/" + plan.nativeId + ".jsonl"
    || plan.namingPolicy !== "captured-display-name-v1" || !/^[a-f0-9-]{36}$/u.test(plan.nativeId || "")
    || !/^[a-f0-9-]{36}$/u.test(plan.sourceId || "") || typeof plan.desiredTitle !== "string" || !plan.desiredTitle.trim()
    || plan.desiredTitle !== plan.desiredTitle.trim() || hash(plan.desiredTitle) !== plan.desiredTitleSha256
    || ![plan.sourceDigest, plan.derivationDigest, plan.expectedTitleSha256, plan.importedSha256, plan.expectedMessageDigest].every(v => /^[a-f0-9]{64}$/u.test(v || ""))
    || !Number.isSafeInteger(plan.importedBytes) || plan.importedBytes < 1 || !Number.isSafeInteger(plan.expectedMessageCount)
    || plan.grantsRecoveryAuthority !== false || plan.restoresExecutionPermission !== false || plan.modelCalled !== false) fail("TITLE_PLAN_INVALID");
}

export function checkClaudeTitleBasis(plan, current, { checkTitle = true } = {}) {
  checkClaudeTitlePlan(plan);
  if (!equal(current.identity, plan.fileIdentity) || current.raw.length < plan.importedBytes
    || hash(current.raw.subarray(0, plan.importedBytes)) !== plan.importedSha256) fail("TITLE_IMPORTED_PREFIX_CHANGED");
  if (current.messageDigest !== plan.expectedMessageDigest || current.messageCount !== plan.expectedMessageCount) fail("TITLE_MESSAGES_CHANGED");
  if (checkTitle && hash(json(current.title)) !== plan.expectedTitleSha256) fail("TITLE_BASELINE_CHANGED");
}

export function checkClaudeTitleAppend(plan, before, after) {
  if (!after.raw.subarray(0, before.raw.length).equals(before.raw)) fail("TITLE_PRECALL_PREFIX_CHANGED");
  const suffix = after.raw.subarray(before.raw.length);
  const records = new TextDecoder("utf-8", { fatal: true }).decode(suffix).trimEnd().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const titles = records.filter(row => row.type === "custom-title");
  // SDK has no compare-and-swap against non-cooperating writers. Detect visible
  // title races instead of presenting a competing append as a clean success.
  if (titles.length !== 1 || titles[0].customTitle !== plan.desiredTitle || titles[0].sessionId !== plan.nativeId)
    fail("TITLE_CONCURRENT_TITLE_UNCERTAIN");
}

// Destination-global P5 command journal. Copies of plans/archives cannot reset
// the at-most-once attempt. A missing durable result is uncertain, never replayed.
export async function correctClaudeDerivedTitle({ artifact, plan, planFile, planSha256, destinationScope, host, assertCurrentAuthority, signal }) {
  if (typeof assertCurrentAuthority !== "function") fail("TITLE_CURRENT_AUTHORITY_REQUIRED");
  plan = structuredClone(plan);
  checkClaudeTitlePlan(plan);
  artifact.recheck();
  const state = verifySelectedCodexStateEvidence(artifact.selected.native.selectionBinding?.evidence, [plan.sourceId])[0];
  if (artifact.manifest.target.nativeId !== plan.nativeId || artifact.manifest.target.cwd !== plan.projectRoot
    || artifact.digest !== plan.derivationDigest || artifact.manifest.source.nativePayloadDigest !== plan.sourceDigest
    || artifact.raw.length !== plan.importedBytes || hash(artifact.raw) !== plan.importedSha256
    || capturedCodexDisplayMetadata(state, plan.sourceId).basis !== "captured-selected-state-name"
    || capturedCodexDisplayMetadata(state, plan.sourceId).title !== plan.desiredTitle) fail("TITLE_SOURCE_BINDING_CHANGED");
  const ctx = openDestinationImportTarget(destinationScope);
  const check = () => { nativeCheck(signal, assertCurrentAuthority); artifact.check(); ctx.verify(); };
  check();
  if (nativeRoot(plan.nativeHome) !== ctx.target.home.path || nativeRoot(plan.projectRoot) !== ctx.target.project.path
    || ctx.target.provider !== "claude") fail("TITLE_CURRENT_TARGET_CHANGED");
  const planRaw = fs.readFileSync(planFile);
  if (hash(planRaw) !== planSha256 || !equal(JSON.parse(planRaw), plan)) fail("TITLE_PLAN_CHANGED");
  const key = hash(json({ nativeId: plan.nativeId, namingPolicy: plan.namingPolicy }));
  const rel = "title-commands/" + ctx.targetKey + "/" + key;
  const attemptFile = copiedProjectFile(ctx.root, rel + "/attempt.json"), resultFile = copiedProjectFile(ctx.root, rel + "/result.json");
  const command = { schemaVersion: 1, kind: "ClaudeTitleCommand", authorityPlane: "P5", targetId: ctx.receipt.targetId,
    nativeId: plan.nativeId, sourceId: plan.sourceId, sourceDigest: plan.sourceDigest, derivationDigest: plan.derivationDigest,
    desiredTitleSha256: plan.desiredTitleSha256, namingPolicy: plan.namingPolicy,
    importedSha256: plan.importedSha256, importedBytes: plan.importedBytes, expectedTitleSha256: plan.expectedTitleSha256,
    fileIdentity: plan.fileIdentity, expectedMessageDigest: plan.expectedMessageDigest,
    automaticReplayAllowed: false, grantsRecoveryAuthority: false, restoresExecutionPermission: false };
  const observe = () => observeClaudeTitleFile(plan.nativeHome, plan.relativeFile, check);
  let before = observe(); checkClaudeTitleBasis(plan, before, { checkTitle: false });
  const expectedResult = { kind: "ClaudeTitleCommandResult", authorityPlane: "P5", commandSha256: hash(json(command)),
    nativeId: plan.nativeId, desiredTitleSha256: plan.desiredTitleSha256, appendOnlyVerified: true,
    messageDigest: before.messageDigest, modelCalled: false, grantsRecoveryAuthority: false, restoresExecutionPermission: false };
  if (!fs.existsSync(attemptFile) && fs.existsSync(resultFile)) fail("TITLE_JOURNAL_INCOMPLETE");
  if (fs.existsSync(attemptFile)) {
    if (!equal(JSON.parse(nativeRaw(ctx.root, rel + "/attempt.json", signal, check).raw), command)) fail("TITLE_COMMAND_CONFLICT");
    if (!fs.existsSync(resultFile)) return { status: "title-outcome-uncertain", nativeEffectAttempted: false, automaticReplayAllowed: false,
      currentTitleMatchesDesired: before.title === plan.desiredTitle };
    if (!equal(JSON.parse(nativeRaw(ctx.root, rel + "/result.json", signal, check).raw), expectedResult)) fail("TITLE_RESULT_CHANGED");
    if (before.title !== plan.desiredTitle) fail("TITLE_COMPLETED_STATE_DRIFT");
    return { ...expectedResult, status: "title-completed-replay", nativeEffectAttempted: false };
  }
  if (before.title === plan.desiredTitle) return { status: "title-already-current-observed", nativeEffectAttempted: false, priorAttemptOwnershipClaimed: false };
  checkClaudeTitleBasis(plan, before);
  if (typeof host?.correctDerivedClaudeTitle !== "function") fail("TITLE_OFFICIAL_HOST_UNAVAILABLE");
  // Authority denial precedes the durable attempt and is never bypassed.
  check(); fs.mkdirSync(path.dirname(attemptFile), { recursive: true }); check();
  atomicCreateArtifact(attemptFile, json(command)); check();
  before = observe(); checkClaudeTitleBasis(plan, before);
  const capability = Object.freeze({});
  titleCapabilities.set(capability, { home: plan.nativeHome, cwd: plan.projectRoot, planFile, planSha256 });
  let result;
  try { result = await host.correctDerivedClaudeTitle({ home: plan.nativeHome, cwd: plan.projectRoot, planFile, planSha256, capability }); }
  finally { titleCapabilities.delete(capability); }
  check(); const after = observe();
  checkClaudeTitleBasis(plan, after, { checkTitle: false });
  checkClaudeTitleAppend(plan, before, after);
  if (!after.raw.subarray(0, before.raw.length).equals(before.raw) || after.title !== plan.desiredTitle
    || result?.nativeId !== plan.nativeId || result?.sdkTitleMatches !== true || result?.appendOnlyVerified !== true
    || result?.messageDigest !== after.messageDigest || result?.modelCalled !== false) fail("TITLE_POSTCONDITION_UNCERTAIN");
  artifact.recheck(); check(); atomicCreateArtifact(resultFile, json(expectedResult));
  return { ...expectedResult, status: "title-corrected", nativeEffectAttempted: true, appendedBytes: after.raw.length - before.raw.length };
}

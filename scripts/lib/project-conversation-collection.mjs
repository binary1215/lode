import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import { atomicCreateArtifact } from "./artifact-storage.mjs";
import { copiedProjectFile, copyOriginal } from "./project-copy-evidence.mjs";
import { inspectCodexNativePayload } from "./codex-native-payload.mjs";
import { inspectCodexCapturedPhysicalSource } from "./codex-captured-physical-source.mjs";
import { verifyCodexProjectCatalog } from "./codex-project-catalog.mjs";
import { verifySelectedCodexStateEvidence } from "./codex-native-state-evidence.mjs";
import { decodeSqliteCell } from "./native-sqlite-values.mjs";
import { nativeRoot, pinNativeRoot, nativeSeparate, nativeCheck, nativeRaw } from "./provider-native-history-host.mjs";
import { deriveProjectNativeHistory, inspectProjectNativeDerivation } from "./project-native-derivation.mjs";
import { publishClaudeDerived, verifyClaudeDerived } from "./claude-derived-publication.mjs";
import { derivedHash as hash, derivedJson as json, derivedFail as fail } from "./claude-derived-encoder.mjs";
import { parseCodexSourceJson } from "./codex-source-json.mjs";

const collectionPattern = /^conversation-collection-[a-f0-9]{24}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
// Integrity/identity/authority failures must never enter this allowlist.
const rowUnsupported = code => code === "CODEX_SOURCE_NUMERIC_PRECISION_UNQUALIFIED";
const idFor = manifest => "conversation-collection-" + hash(json(manifest)).slice(0, 24);
const relativeFor = id => { if (!collectionPattern.test(id || "")) fail("COLLECTION_ID_INVALID"); return "collections/" + id + "/manifest.json"; };

function context(directory, signal, authority) {
  nativeCheck(signal, () => { const value = authority(); if (value === false) fail("NATIVE_HISTORY_AUTHORITY_DENIED"); return value; });
  const root = nativeRoot(directory), pin = pinNativeRoot(root);
  const check = () => { nativeCheck(signal, () => { const value = authority(); if (value === false) fail("NATIVE_HISTORY_AUTHORITY_DENIED"); return value; }); pin.verify(); };
  check(); return { root, check };
}
function exact(root, relative, bytes, check) {
  check(); const file = copiedProjectFile(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true }); copiedProjectFile(root, relative); check();
  try { atomicCreateArtifact(file, bytes); } catch (error) { if (error.code !== "EEXIST") throw error; }
  if (!nativeRaw(root, relative, null, check).raw.equals(bytes)) fail("COLLECTION_CREATE_CONFLICT");
}
function mappingsFor(workspaceMappings) {
  if (!Array.isArray(workspaceMappings)) fail("COLLECTION_CURRENT_WORKSPACE_MAPPING_REQUIRED");
  const mappings = new Map();
  for (const mapping of workspaceMappings) {
    // Source is a lookup key, never an instruction to read that workspace.
    if (!mapping || !equal(Object.keys(mapping).sort(), ["sourceRoot", "targetRoot"])
      || typeof mapping.sourceRoot !== "string" || !(path.win32.isAbsolute(mapping.sourceRoot) || path.posix.isAbsolute(mapping.sourceRoot))
      || mappings.has(mapping.sourceRoot)) fail("COLLECTION_WORKSPACE_MAPPING_INVALID");
    const target = nativeRoot(mapping.targetRoot), pin = pinNativeRoot(target);
    // Conversation grouping copies no worktree files and merges no P2 owners.
    // Explicitly shared target workspaces are valid; code-copy merge protections
    // belong to the separate workspace transfer operation.
    mappings.set(mapping.sourceRoot, { root: target, pin });
  }
  return mappings;
}
export { mappingsFor as projectConversationWorkspaceMappings };
function oneThreadPayload(payload, threadId) {
  // No catalog is copied into a one-row capsule: that would falsely claim
  // that the smaller roster was a complete source Project observation.
  const { projectCatalog, ...body } = payload;
  const stateIndex = body.stateEvidence.columns.indexOf("id");
  const stateEvidence = { ...body.stateEvidence, rows: body.stateEvidence.rows.filter(row => decodeSqliteCell(row[stateIndex]) === threadId) };
  const historical = verifySelectedCodexStateEvidence(stateEvidence, [threadId])[0];
  const history = { ...body.history, threadIds: [threadId], tables: body.history.tables.map(table => {
    const index = table.columns.indexOf("thread_id");
    if (index < 0) fail("COLLECTION_HISTORY_TABLE_SCOPE_INVALID");
    return { ...table, rows: table.rows.filter(row => decodeSqliteCell(row[index]) === threadId) };
  }) };
  return { ...body, threadIds: [threadId], stateEvidence, history,
    files: body.files.filter(file => file.threadId === threadId),
    coverage: body.coverage.filter(row => row.threadId === threadId).map(row => ({ ...row,
      parentClosure: historical.attached_thread_parent_id == null || historical.attached_thread_parent_id === threadId ? "selected-or-none" : "not-selected" })) };
}
function rowSource(root, relative, expected, check, signal) {
  const directory = copiedProjectFile(root, relative), inspected = expected.kind === "captured-physical"
    ? inspectCodexCapturedPhysicalSource({ directory, expectedPayloadId: expected.payloadId, signal, assertCurrentAuthority: check })
    : inspectCodexNativePayload({ directory, expectedPayloadId: expected.payloadId, signal });
  check();
  if (inspected.payloadDigest !== expected.payloadDigest || inspected.payload.threadIds.length !== 1
    || inspected.payload.threadIds[0] !== expected.threadId || Object.hasOwn(inspected.payload, "projectCatalog")) fail("COLLECTION_ROW_SOURCE_MISMATCH");
  return inspected;
}
function capturedSourceMetadata(ref) {
  // A read never follows an archived path. These are recorded manifest bytes,
  // not fresh physical/semantic verification or a self-contained body archive.
  if (ref?.kind !== "captured-physical-reference" || ref.bodiesIncluded !== false
    || !digestPattern.test(ref.payloadDigest || "") || ref.payloadId !== "physical-history-" + ref.payloadDigest.slice(0, 24)
    || typeof ref.manifestBase64 !== "string") fail("COLLECTION_ROW_SOURCE_MISMATCH");
  const raw = Buffer.from(ref.manifestBase64, "base64");
  if (raw.toString("base64") !== ref.manifestBase64 || hash(raw) !== ref.payloadDigest) fail("COLLECTION_ROW_SOURCE_MISMATCH");
  const payload = parseCodexSourceJson(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  if (payload.schemaVersion !== 1 || payload.kind !== "CodexCapturedPhysicalHistory" || payload.authorityPlane !== "P3"
    || !equal(payload.threadIds, [ref.threadId]) || !Array.isArray(payload.files) || !payload.files.length
    || payload.grantsRecoveryAuthority !== false || payload.restoresExecutionPermission !== false
    || payload.canonicalDatabaseRowsClaimed !== false || payload.modelContextEquivalent !== false || payload.globalInventoryComplete !== false)
    fail("COLLECTION_ROW_SOURCE_MISMATCH");
  const binding = payload.selectionBinding;
  if (binding?.status === "captured-state-path-verified" && (binding.stableNativeThreadId !== ref.threadId
    || binding.physicalRolloutId !== payload.selectedRolloutId || binding.queryReplayVerified !== false
    || !payload.files.some(file => file.rolloutId === payload.selectedRolloutId && file.sha256 === binding.selectedPrefixDigest)))
    fail("COLLECTION_ROW_SOURCE_MISMATCH");
  return { payload, selectionBinding: binding };
}
const summary = inspected => ({ status: "project-conversation-collection", authorityPlane: "P4",
  collectionId: inspected.id, collectionDigest: inspected.digest, collectionRoot: inspected.root,
  sourceProjectId: inspected.manifest.catalog.projectId, observedConversationCount: inspected.manifest.catalog.threadIds.length,
  capturedConversationCount: inspected.manifest.rows.filter(row => row.source).length,
  uncapturedConversationIds: inspected.manifest.catalog.threadIds.filter(id => !inspected.manifest.rows.some(row => row.threadId === id && row.source)),
  physicalBodiesIncluded: inspected.manifest.schemaVersion === 2 ? false : true,
  physicalVerificationScope: inspected.manifest.schemaVersion === 2 ? "recorded-manifest-metadata-only; current-original-store-scope-required" : "embedded-source-validation",
  sourceAssociationScope: inspected.manifest.schemaVersion === 2 ? "captured-catalog-and-separate-physical-capture; not-one-snapshot-or-current-native-inventory" : "captured-native-payload",
  rows: inspected.manifest.rows.map(row => ({ threadId: row.threadId, sourceRoot: row.sourceRoot, targetRoot: row.targetRoot,
    status: row.status, reasonCode: row.reasonCode ?? null, source: row.source, derivation: row.derivation ?? null,
    ...(row.retainedDerivation ? { retainedDerivation: row.retainedDerivation } : {}) })),
  nativeProfilePublished: false, workspaceFilesCopied: false, optionalLodeDataIncluded: false,
    observationScope: "archive-only", desktopVisibility: "not-observed", modelContextUse: "not-tested", sourceOriginalsPreserved: true,
  grantsRecoveryAuthority: false, restoresExecutionPermission: false, establishesLogicalSessionOwnership: false });

// P3 collection of independent conversations. Row identity excludes the global
// roster/digest: the exact same row capsule + target pin reuses its old native
// ID after another conversation is added, removed or updated. No transcript
// concatenation, automatic open, native profile write, or P2 integration.
export function deriveProjectConversationCollection({ bundleRoot, collectionRoot, workspaceMappings = [],
  signal, assertCurrentAuthority = () => {} }) {
  const source = context(bundleRoot, signal, assertCurrentAuthority), target = context(collectionRoot, signal, assertCurrentAuthority);
  nativeSeparate(source.root, target.root);
  const current = () => { source.check(); target.check(); };
  const native = inspectCodexNativePayload({ directory: source.root, signal }), payload = native.payload;
  if (!payload.projectCatalog) fail("COLLECTION_VERIFIED_PROJECT_CATALOG_REQUIRED");
  const catalog = verifyCodexProjectCatalog(payload.projectCatalog), members = new Map(catalog.records.map(record => [record.id, record]));
  const mappings = mappingsFor(workspaceMappings), rows = [];
  for (const threadId of payload.threadIds) {
    current(); const body = oneThreadPayload(payload, threadId), raw = json(body), digest = hash(raw), payloadId = "native-history-" + digest.slice(0, 24);
    const relative = "sources/" + payloadId, directory = copiedProjectFile(target.root, relative);
    const file = body.files[0], sourceObject = { ...file, path: "objects/" + file.sha256 + ".bin" };
    exact(target.root, relative + "/capture-intent.json", json({ schemaVersion: 1, kind: "NativeHistoryCaptureIntent", payloadId, payloadDigest: digest }), current);
    fs.mkdirSync(copiedProjectFile(target.root, relative + "/objects"), { recursive: true }); current();
    // This archive copy is the selected already-verified immutable original,
    // never a source-embedded live path, attachment or workspace traversal.
    copyOriginal(source.root, directory, sourceObject, { signal, assertCurrentAuthority: current });
    exact(target.root, relative + "/manifest.json", raw, current);
    const ref = { relative, threadId, payloadId, payloadDigest: digest }, member = members.get(threadId);
    rowSource(target.root, relative, ref, current, signal);
    const mapping = mappings.get(member.cwd);
    const row = { threadId, sourceRoot: member.cwd, targetRoot: mapping?.root ?? null, source: ref };
    if (!mapping) { rows.push({ ...row, status: "workspace-mapping-needed", reasonCode: "COLLECTION_CURRENT_WORKSPACE_MAPPING_REQUIRED" }); continue; }
    mapping.pin.verify();
    try {
      const derived = deriveProjectNativeHistory({ bundleRoot: directory, root: mapping.root, threadIds: [threadId], signal, assertCurrentAuthority: current });
      rows.push({ ...row, status: derived.publicationReady ? "ready" : "representation-incomplete",
        derivation: { id: derived.derivationId, digest: derived.derivationDigest, nativeId: derived.target.nativeId } });
    } catch (error) {
      current(); mapping.pin.verify();
      // Cancellation, permission, integrity and filesystem failures remain the
      // primary failure; only a known representation limitation is row-local.
      if (!rowUnsupported(error.code)) throw error;
      rows.push({ ...row, status: "source-representation-unsupported", reasonCode: error.code });
    }
  }
  current();
  if (nativeRaw(source.root, "manifest.json", signal, current).entry.sha256 !== native.payloadDigest) fail("COLLECTION_SOURCE_CHANGED");
  const manifest = { schemaVersion: 1, kind: "CodexProjectConversationCollection", authorityPlane: "P3",
    source: { payloadId: native.payloadId, payloadDigest: native.payloadDigest }, catalog: payload.projectCatalog, rows,
    sourceOriginalsPreserved: true, workspaceFilesCopied: false, optionalLodeDataIncluded: false,
    grantsRecoveryAuthority: false, restoresExecutionPermission: false, establishesLogicalSessionOwnership: false };
  const id = idFor(manifest); exact(target.root, relativeFor(id), json(manifest), current);
  return summary(inspectProjectConversationCollection({ collectionRoot: target.root, collectionId: id,
    expectedCollectionDigest: hash(json(manifest)), signal, assertCurrentAuthority }));
}

export function inspectProjectConversationCollection({ collectionRoot, collectionId, expectedCollectionDigest = null,
  signal, assertCurrentAuthority = () => {} }) {
  const { root, check } = context(collectionRoot, signal, assertCurrentAuthority), entry = nativeRaw(root, relativeFor(collectionId), signal, check);
  if (expectedCollectionDigest !== null && entry.entry.sha256 !== expectedCollectionDigest) fail("COLLECTION_DIGEST_MISMATCH");
  const manifest = JSON.parse(entry.raw.toString("utf8")), m = manifest;
  const capturedFamily = m?.schemaVersion === 2;
  const sourceValid = capturedFamily ? m.source?.kind === "captured-project-catalog"
    && digestPattern.test(m.source.originalFileDigest || "") && m.source.extractedCatalogDigest === hash(json(m.catalog))
    && ["standalone-catalog", "catalog-from-native-manifest"].includes(m.source.inputFormat)
    && m.source.originalCatalogFileIncluded === false && m.source.queryReplayVerified === false && m.source.snapshotAcrossSourcesClaimed === false
    && m.source.physicalBodiesIncluded === false
    && m.source.physicalVerificationScope === "recorded-manifest-metadata-only; current-source-scope-required-for-full-validation"
    : digestPattern.test(m.source?.payloadDigest || "") && m.source?.payloadId === "native-history-" + m.source.payloadDigest.slice(0, 24);
  if (![1, 2].includes(m?.schemaVersion) || m.kind !== "CodexProjectConversationCollection" || m.authorityPlane !== "P3"
    || collectionId !== idFor(m) || !sourceValid
    || !Array.isArray(m.rows) || new Set(m.rows.map(row => row.threadId)).size !== m.rows.length
    || m.sourceOriginalsPreserved !== true || m.workspaceFilesCopied !== false || m.optionalLodeDataIncluded !== false
    || m.grantsRecoveryAuthority !== false || m.restoresExecutionPermission !== false || m.establishesLogicalSessionOwnership !== false)
    fail("COLLECTION_MANIFEST_INVALID");
  const catalog = verifyCodexProjectCatalog(m.catalog), members = new Map(catalog.records.map(row => [row.id, row]));
  for (const row of m.rows) {
    check();
    if (!members.has(row.threadId) || row.sourceRoot !== members.get(row.threadId).cwd) fail("COLLECTION_ROW_INVALID");
    if (row.targetRoot !== null && (typeof row.targetRoot !== "string" || !path.isAbsolute(row.targetRoot))) fail("COLLECTION_ROW_INVALID");
    if (capturedFamily && row.source === null) {
      if (row.status !== "source-not-supplied" || row.reasonCode !== "CAPTURED_PROJECT_SOURCE_NOT_SUPPLIED" || row.derivation
        || row.membershipBasis !== "stable-native-id-match-to-supplied-catalog; source-cutoffs-may-differ") fail("COLLECTION_ROW_INVALID");
      continue;
    }
    if (!row.source || row.source.threadId !== row.threadId
      || !capturedFamily && row.source.relative !== "sources/" + row.source.payloadId
      || !["ready", "representation-incomplete", "source-representation-unsupported", "workspace-mapping-needed", ...(capturedFamily ? ["association-proposed", "retained-derivation-reference-needed"] : [])].includes(row.status)
      || capturedFamily && (row.source.kind !== "captured-physical-reference" || row.source.relative !== undefined || row.membershipBasis !== "stable-native-id-match-to-supplied-catalog; source-cutoffs-may-differ"))
      fail("COLLECTION_ROW_INVALID");
    const native = capturedFamily ? capturedSourceMetadata(row.source) : rowSource(root, row.source.relative, row.source, check, signal);
    const state = capturedFamily ? native.selectionBinding?.status === "captured-state-path-verified"
      ? verifySelectedCodexStateEvidence(native.selectionBinding.evidence, [row.threadId])[0] : null
      : verifySelectedCodexStateEvidence(native.payload.stateEvidence, [row.threadId])[0];
    const bound = state && equal(Object.fromEntries(m.catalog.membershipEvidence.columns.map(key => [key, state[key]])), members.get(row.threadId));
    if (capturedFamily && !bound) {
      if (row.status !== "association-proposed" || row.reasonCode !== "CAPTURED_PROJECT_ASSOCIATION_UNPROVED" || row.derivation) fail("COLLECTION_ASSOCIATION_UNPROVED");
      continue;
    }
    if (!bound) fail("COLLECTION_MEMBERSHIP_MISMATCH");
    if (capturedFamily && row.status === "retained-derivation-reference-needed") {
      const prior = row.retainedDerivation;
      if (row.reasonCode !== "CAPTURED_PROJECT_RETAINED_DERIVATION_REQUIRES_REUSE" || row.derivation
        || !/^derived-claude-[a-f0-9]{24}$/u.test(prior?.id || "") || !digestPattern.test(prior?.digest || "")
        || typeof prior?.directoryHint !== "string" || !path.isAbsolute(prior.directoryHint)
        || !/^\d+$/u.test(prior?.storeIdentity?.dev || "") || !/^\d+$/u.test(prior?.storeIdentity?.ino || "")
        || typeof prior?.publicationReady !== "boolean" || !/^[a-f0-9-]{36}$/u.test(prior?.nativeId || "")) fail("COLLECTION_ROW_INVALID");
      continue;
    }
    if (row.derivation) {
      if (capturedFamily) fail("COLLECTION_EXTERNAL_SOURCE_CANNOT_HAVE_LOCAL_DERIVATION");
      const artifact = inspectProjectNativeDerivation({ bundleRoot: native.directory, derivationId: row.derivation.id,
        expectedDerivationDigest: row.derivation.digest, signal, assertCurrentAuthority: check });
      if (artifact.manifest.input.selection.threadId !== row.threadId || artifact.manifest.target.nativeId !== row.derivation.nativeId
        || artifact.manifest.target.cwd !== row.targetRoot || (artifact.manifest.publicationReady ? "ready" : "representation-incomplete") !== row.status)
        fail("COLLECTION_DERIVATION_MISMATCH");
    } else if (row.status === "workspace-mapping-needed") {
      if (row.targetRoot !== null || row.reasonCode !== "COLLECTION_CURRENT_WORKSPACE_MAPPING_REQUIRED") fail("COLLECTION_ROW_INVALID");
    } else if (row.status !== "source-representation-unsupported" || !rowUnsupported(row.reasonCode)
      || typeof row.targetRoot !== "string" || !path.isAbsolute(row.targetRoot)) fail("COLLECTION_ROW_INVALID");
  }
  check(); return { root, check, id: collectionId, digest: entry.entry.sha256, manifest };
}

export function readProjectConversationCollection(options) { return summary(inspectProjectConversationCollection(options)); }

// Each row retains the existing publication attempt journal. A partial batch
// never rolls back another row or replays an uncertain effect. Current caller
// mappings, not a stored source/target path, authorize the chosen destinations.
export async function operateProjectConversationCollection({ action, collectionRoot, collectionId, expectedCollectionDigest,
  workspaceMappings = [], retainedDerivationSources = [], nativeHome, host, destinationHost = null, signal, assertCurrentAuthority = () => {} }) {
  if (!["publish-project", "verify-project"].includes(action)) fail("COLLECTION_ACTION_INVALID");
  if (!digestPattern.test(expectedCollectionDigest || "")) fail("COLLECTION_EXPECTED_DIGEST_REQUIRED");
  const inspected = inspectProjectConversationCollection({ collectionRoot, collectionId, expectedCollectionDigest, signal, assertCurrentAuthority });
  const mappings = mappingsFor(workspaceMappings), results = [];
  if (!Array.isArray(retainedDerivationSources) || new Set(retainedDerivationSources.map(source => source?.threadId)).size !== retainedDerivationSources.length)
    fail("COLLECTION_RETAINED_SOURCE_SCOPE_INVALID");
  const retained = new Map();
  for (const source of retainedDerivationSources) {
    const row = inspected.manifest.rows.find(row => row.threadId === source?.threadId);
    if (!row?.retainedDerivation || Object.keys(source).some(key => !["threadId", "directory", "expectedDerivationDigest"].includes(key))
      || source.expectedDerivationDigest !== row.retainedDerivation.digest || typeof source.directory !== "string" || !path.isAbsolute(source.directory))
      fail("COLLECTION_RETAINED_SOURCE_SCOPE_INVALID");
    retained.set(source.threadId, source);
  }
  // Reject an unintended workspace before any native-profile effect.
  for (const row of inspected.manifest.rows.filter(row => row.derivation || row.retainedDerivation && retained.has(row.threadId))) {
    const mapping = mappings.get(row.sourceRoot);
    if (!mapping || mapping.root !== row.targetRoot) fail("COLLECTION_CURRENT_WORKSPACE_MAPPING_MISMATCH");
  }
  let activeRow = null, activeIndex = 0;
  try { for (const [index, row] of inspected.manifest.rows.entries()) {
    activeIndex = index; activeRow = null;
    inspected.check();
    const existingSource = retained.get(row.threadId), derivation = row.derivation ?? (existingSource ? row.retainedDerivation : null);
    const eligible = row.status === "ready" || existingSource && row.status === "retained-derivation-reference-needed";
    if (!derivation || !eligible) { results.push({ threadId: row.threadId, status: row.status, nativeEffectAttempted: false }); continue; }
    activeRow = { threadId: row.threadId, targetNativeId: derivation.nativeId,
      derivationId: derivation.id, phase: "artifact-verification", status: "native-operation-outcome-not-returned" };
    const mapping = mappings.get(row.sourceRoot); mapping.pin.verify();
    let sourcePin = null;
    const current = () => { inspected.check(); mapping.pin.verify(); sourcePin?.verify();
      if (nativeRaw(inspected.root, relativeFor(collectionId), signal, inspected.check).entry.sha256 !== inspected.digest) fail("COLLECTION_CHANGED"); };
    current();
    if (existingSource && !fs.lstatSync(existingSource.directory, { throwIfNoEntry: false })) {
      results.push({ threadId: row.threadId, status: "retained-source-unavailable", reasonCode: "COLLECTION_RETAINED_SOURCE_UNAVAILABLE", nativeEffectAttempted: false });
      activeRow = null; continue;
    }
    const sourceDirectory = existingSource ? nativeRoot(existingSource.directory) : copiedProjectFile(inspected.root, row.source.relative);
    sourcePin = pinNativeRoot(sourceDirectory);
    if (existingSource) {
      const stat = fs.lstatSync(sourceDirectory, { bigint: true });
      if (String(stat.dev) !== row.retainedDerivation.storeIdentity.dev || String(stat.ino) !== row.retainedDerivation.storeIdentity.ino)
        fail("COLLECTION_RETAINED_PUBLICATION_STORE_CHANGED");
    }
    const artifact = inspectProjectNativeDerivation({ bundleRoot: sourceDirectory,
      derivationId: derivation.id, expectedDerivationDigest: derivation.digest, signal, assertCurrentAuthority: current });
    if (artifact.manifest.input.selection.threadId !== row.threadId || artifact.manifest.target.cwd !== mapping.root
      || artifact.manifest.source.nativePayloadDigest !== row.source.payloadDigest || artifact.manifest.target.nativeId !== derivation.nativeId)
      fail("COLLECTION_RETAINED_DERIVATION_MISMATCH");
    activeRow.phase = "native-operation-entered";
    const result = await (action === "publish-project" ? publishClaudeDerived : verifyClaudeDerived)({ artifact, nativeHome,
      root: mapping.root, host, destinationHost, signal, assertCurrentAuthority: current });
    results.push({ threadId: row.threadId, ...result });
    activeRow = null;
  } } catch (error) {
    // No filesystem read/write, authority retry, cleanup or rollback follows a
    // denial. Preserve the primary error plus observations already in memory.
    if (activeRow && error.derivedNativeOperationResult) results.push({ threadId: activeRow.threadId, ...error.derivedNativeOperationResult });
    error.partialResults = results;
    error.collectionOperationResult = { schemaVersion: 1, kind: "ProjectConversationCollectionPartialOutcome", authorityPlane: "P5",
      status: "failed-with-retained-observations", primaryFailure: { code: error.code || "COLLECTION_OPERATION_FAILED" },
      collectionId, collectionDigest: expectedCollectionDigest, action, results,
      activeRow, unvisitedThreadIds: inspected.manifest.rows.slice(activeIndex + (activeRow ? 1 : 0)).map(row => row.threadId),
      automaticReplayAllowed: false, rollbackAttempted: false, additionalObservationAfterFailure: false,
      grantsRecoveryAuthority: false, restoresExecutionPermission: false };
    throw error;
  }
  const { nativeProfilePublished, ...archiveSummary } = summary(inspected);
  const totalRows = results.length, skippedRows = results.filter(row => row.nativeEffectAttempted === false).length;
  const prefixObservedRows = results.filter(row => row.targetObservation?.prefixVerified === true
    && ["matches", "continued"].includes(row.targetObservation?.state)).length;
  const uncertainRows = results.filter(row => ["native-derived-publication-uncertain", "native-derived-target-observed-after-attempt"].includes(row.status)).length;
  const readerObservedRows = results.filter(row => row.sdkVersion).length;
  const readerCompleteRows = results.filter(row => row.sourceRepresentationComplete === true
    && row.derivedPrefixCoverageComplete === true && row.readerProjectionCoverageComplete === true).length;
  const observedStatus = count => count === totalRows && totalRows > 0 ? "all-observed" : count > 0 ? "partial-observed" : "none-observed";
  return { ...archiveSummary, status: "project-conversation-operation-observed", authorityPlane: "P5", action, results,
    observationScope: "per-conversation-native-operations",
    nativePublication: { status: observedStatus(prefixObservedRows), totalRows, prefixObservedRows,
      skippedRows, uncertainRows, unconfirmedRows: totalRows - prefixObservedRows, scope: "native-transcript-prefix-only-not-GUI-or-model" },
    officialReader: { status: action !== "verify-project" ? "not-requested" : observedStatus(readerCompleteRows),
      totalRows, observedRows: readerObservedRows, completeRows: readerCompleteRows,
      scope: "source-representation-and-derived-prefix-and-declared-reader-projection" },
    automaticReplayAllowed: false, taskCompletionJudged: false,
    completionJudgment: "inspect each row; publication, official reader, Desktop visibility and model use are separate observations" };
}

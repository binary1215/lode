import fs from "node:fs";
import { verifyCodexHistoryAddresses } from "./codex-history-addresses.mjs";
import { verifyCodexZstdPrefixObservation } from "./codex-zstd-prefix.mjs";
import { isHistoryBytes, historyEquals, historyMetadataText, readHistoryRaw, createHistoryArtifact } from "./native-history-bytes.mjs";
import path from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import { atomicCreateArtifact } from "./artifact-storage.mjs";
import { copiedProjectFile, inspectCopiedProjectFile, copyOriginal } from "./project-copy-evidence.mjs";
import { nativeRoot, pinNativeRoot, nativeRaw, nativeCheck, nativeSeparate } from "./provider-native-history-host.mjs";
import { readCapturedProjectCatalogFile } from "./captured-project-collection.mjs";
import { verifyCodexProjectCatalog } from "./codex-project-catalog.mjs";
import { inspectCodexCapturedPhysicalSource, verifyCodexCapturedPhysicalEvidence, encodeCodexObservedLivePhysicalSources } from "./codex-captured-physical-source.mjs";
import { readCodexLiveProjectSource, verifyCodexLiveProjectObservation, releaseCodexLiveProjectObservation } from "./codex-live-project-source.mjs";
import { verifySelectedCodexStateEvidence } from "./codex-native-state-evidence.mjs";
import { verifySelectedCodexHistory } from "./codex-native-portability.mjs";
import { capturePortableWorkspaces, verifyPortableWorkspaceEvidence } from "./portable-workspace-evidence.mjs";
import { inspectProjectBundle } from "./project-portability.mjs";
import { parseCodexSourceJson } from "./codex-source-json.mjs";
import { derivedHash as hash, derivedJson as json, derivedFail as fail } from "./claude-derived-encoder.mjs";

const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const reference = entry => ({ sha256: entry.sha256, bytes: entry.bytes });
function context(directory, signal, authority) {
  nativeCheck(signal, authority);
  const root = nativeRoot(directory), pin = pinNativeRoot(root);
  return { root, check() { nativeCheck(signal, authority); pin.verify(); } };
}
function exact(root, relative, raw, check) {
  check(); const file = copiedProjectFile(root, relative);
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) {
    fs.mkdirSync(path.dirname(file), { recursive: true }); check();
    try { createHistoryArtifact(file, raw, check); } catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  if (!historyEquals(readHistoryRaw(root, relative, null, check).raw, raw)) fail("PORTABLE_EVIDENCE_CREATE_CONFLICT");
}
const historyNames = new Set(["publication-attempt.json", "publication-receipt.json", "desktop-open-attempt.json", "desktop-open-return.json"]);

// A bounded observation of known source-store namespaces, not an atomic history
// snapshot. Never reinterpret missing/partial/unrecognized history as fresh.
function captureHistory(source, queue, signal) {
  source.check(); const base = "native/derived/claude", file = copiedProjectFile(source.root, base), stat = fs.lstatSync(file, { throwIfNoEntry: false });
  const observation = { scope: "selected-captured-source-store-known-derivative-and-effect-files", entries: [],
    classificationProfile: "known-operational-namespaces-v2",
    coverage: "bounded-observation-not-complete-or-atomic", noPriorAttemptsProven: false, skippedUnknownEntries: 0,
    inferredTargetDeviceIdentity: false, grantsExecutionAuthority: false };
  if (!stat) return { ...observation, status: "no-history-directory-observed-not-proof-of-no-attempt" };
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("PORTABLE_EVIDENCE_HISTORY_PATH_UNSAFE");
  const preserveUnqualifiedOperationalEntry = (relative, entry) => {
    source.check();
    if (entry.isSymbolicLink()) fail("PORTABLE_EVIDENCE_HISTORY_PATH_UNSAFE");
    const metadata = { path: relative, entryKind: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other",
      interpretation: "unqualified-operational-namespace-entry; occurrence-or-outcome-not-inferred", rawOriginalPreserved: false };
    if (entry.isFile()) {
      observation.entries.push({ path: relative, kind: "historical-P5-observation-not-new-authority",
        recordKind: "unqualified-operational-namespace-entry", original: queue(source, relative) });
      metadata.rawOriginalPreserved = true;
    }
    (observation.unqualifiedOperationalEntries ??= []).push(metadata);
  };
  for (const child of fs.readdirSync(file, { withFileTypes: true })) {
    source.check();
    if (!/^derived-claude-[a-f0-9]{24}$/u.test(child.name)) { observation.skippedUnknownEntries++; continue; }
    if (!child.isDirectory() || child.isSymbolicLink()) fail("PORTABLE_EVIDENCE_HISTORY_PATH_UNSAFE");
    const relative = base + "/" + child.name;
    for (const name of ["intent.json", "manifest.json", "conversation.jsonl", "mapping.json", "diagnostics.json"]) {
      source.check();
      if (fs.lstatSync(copiedProjectFile(source.root, relative + "/" + name), { throwIfNoEntry: false }))
        observation.entries.push({ path: relative + "/" + name, kind: ["intent.json", "manifest.json"].includes(name) ? "derivative-identity-original" : "derivative-payload-original", original: queue(source, relative + "/" + name) });
    }
    const effects = relative + "/effects", effectPath = copiedProjectFile(source.root, effects), effectStat = fs.lstatSync(effectPath, { throwIfNoEntry: false });
    if (!effectStat) continue;
    if (!effectStat.isDirectory() || effectStat.isSymbolicLink()) fail("PORTABLE_EVIDENCE_HISTORY_PATH_UNSAFE");
    for (const folder of fs.readdirSync(effectPath, { withFileTypes: true })) {
      source.check();
      if (!/^(?:open-)?[a-f0-9]{24}$/u.test(folder.name)) {
        observation.skippedUnknownEntries++; preserveUnqualifiedOperationalEntry(effects + "/" + folder.name, folder); continue;
      }
      if (!folder.isDirectory() || folder.isSymbolicLink()) fail("PORTABLE_EVIDENCE_HISTORY_PATH_UNSAFE");
      const effect = effects + "/" + folder.name;
      for (const entry of fs.readdirSync(copiedProjectFile(source.root, effect), { withFileTypes: true })) {
        source.check();
        if (!historyNames.has(entry.name)) {
          observation.skippedUnknownEntries++; preserveUnqualifiedOperationalEntry(effect + "/" + entry.name, entry); continue;
        }
        if (!entry.isFile() || entry.isSymbolicLink()) fail("PORTABLE_EVIDENCE_HISTORY_PATH_UNSAFE");
        const relativeFile = effect + "/" + entry.name;
        const raw = nativeRaw(source.root, relativeFile, signal, source.check);
        let recordKind = null;
        try { recordKind = parseCodexSourceJson(new TextDecoder("utf-8", { fatal: true }).decode(raw.raw)).kind ?? null; }
        catch (error) { if (error.code === "CODEX_SOURCE_NUMERIC_PRECISION_UNQUALIFIED") recordKind = "numeric-representation-unqualified"; else recordKind = "unparsed-original"; }
        observation.entries.push({ path: relativeFile, kind: "historical-P5-observation-not-new-authority", recordKind,
          original: queue(source, relativeFile, raw.entry) });
      }
    }
  }
  return { ...observation, status: observation.entries.length ? "history-observed-originals-preserved" : "no-known-records-observed-not-proof-of-no-attempt" };
}

// Export only P3 bytes. No destination journal choice, native import, source
// extraction, default Session selection, app startup or publication capability.
export function exportPortableProjectEvidence({ directory, catalogFile, expectedCatalogDigest, physicalSources = [], lodeBundles = [],
  workspaceSources = [], liveObservation = null, signal, assertCurrentAuthority = () => {} }) {
  const target = context(directory, signal, assertCurrentAuthority);
  if (liveObservation !== null && (catalogFile !== undefined || expectedCatalogDigest !== undefined || physicalSources.length)) fail("PORTABLE_EVIDENCE_MIXED_LIVE_SOURCE_BASIS");
  const batch = liveObservation === null ? null : encodeCodexObservedLivePhysicalSources({ observation: liveObservation, check: target.check });
  const observed = batch?.observed ?? null;
  const catalogSource = observed ? { catalog: observed.catalog, verified: verifyCodexProjectCatalog(observed.catalog),
    recheck: () => { target.check(); verifyCodexLiveProjectObservation(liveObservation); } }
    : readCapturedProjectCatalogFile({ catalogFile, expectedCatalogDigest, signal, assertCurrentAuthority: target.check });
  if (observed) { nativeSeparate(observed.sourceRoot, target.root); expectedCatalogDigest = hash(json(observed.catalog)); }
  const members = new Set(catalogSource.verified.records.map(row => row.id));
  if (!Array.isArray(physicalSources) || new Set(physicalSources.map(scope => scope?.threadId)).size !== physicalSources.length || !Array.isArray(lodeBundles)) fail("PORTABLE_EVIDENCE_SCOPE_INVALID");
  const copies = [], sources = [], lode = [], logical = new Set(), validators = [];
  const queue = (source, relativeFile, observed = null) => {
    source.check();
    const entry = observed ?? inspectCopiedProjectFile(source.root, relativeFile, { signal, assertCurrentAuthority: source.check });
    copies.push({ source, entry: { ...entry, path: relativeFile } }); return reference(entry);
  };
  const queueBytes = value => {
    target.check(); const raw = isHistoryBytes(value) ? value : Buffer.from(value), entry = { sha256: hash(raw), bytes: raw.length };
    copies.push({ raw, entry }); return entry;
  };
  let liveCapture = null;
  if (observed) {
    const rows = observed.conversations.map(row => {
      const encoded = batch.encoded.get(row.threadId);
      if (encoded) {
        for (const original of encoded.originals) queueBytes(original.raw);
        sources.push({ threadId: row.threadId, provider: "codex", kind: "captured-physical-originals", manifest: queueBytes(encoded.manifestRaw), intent: queueBytes(encoded.intentRaw),
          historicalStoreObservation: { status: "no-executable-capture-store-created", identityScope: "capture-host-only-not-a-target-device-ID" },
          history: { scope: "live-source-operational-attempt-history-not-collected", entries: [], status: "operational-history-not-observed-not-proof-of-no-attempt",
            coverage: "bounded-observation-not-complete-or-atomic", noPriorAttemptsProven: false, grantsExecutionAuthority: false } });
      }
      return { threadId: row.threadId, rolloutId: row.rolloutId ?? null, status: row.status, reasonCode: row.reasonCode ?? null,
        selectedState: queueBytes(json(row.selectedStateEvidence)), history: row.history ? queueBytes(json(row.history)) : null,
        lineage: row.lineage ?? null, historyCoverage: row.historyCoverage ?? null, stateHeaderAgreement: row.stateHeaderAgreement ?? null,
        primarySourceFailure: row.primarySourceFailure ?? null, sourceFileObservation: row.sourceFileObservation ?? null,
        originals: row.originals.map(original => ({ threadId: original.threadId, rolloutId: original.rolloutId, original: queueBytes(original.raw),
          ...(original.encoding ? { sourceEncoding: original.encoding, compressionEvidence: original.compressionEvidence } : {}) })),
        incompleteTail: row.incompleteTail ? queueBytes(row.incompleteTail.raw) : null,
        nativePublicationReady: false, semanticHistoryEquivalent: false };
    });
    liveCapture = { schemaVersion: 1, kind: "PortableLiveCodexProjectObservation", authorityPlane: "P3", sourceProjectId: observed.sourceProjectId,
      sourceProjectNamespace: observed.sourceProjectNamespace, appMembershipVerifiedByCore: false, selectionIsPermission: false,
      catalogSerialization: "generated-catalog-value-encoding-not-original-file-bytes", sourceCoverage: observed.sourceCoverage, snapshots: observed.snapshots,
      namespaceEvidence: observed.evidence, currentAfterSnapshotRelease: observed.currentAfterSnapshotRelease, rows,
      cleanup: liveObservation.cleanup, executableSourceStoreCreated: false, nativePublicationAttempted: false,
      grantsRecoveryAuthority: false, restoresExecutionPermission: false };
  }
  for (const scope of physicalSources) {
    if (!scope || Object.keys(scope).some(key => !["threadId", "directory", "expectedPayloadDigest"].includes(key))
      || !members.has(scope.threadId) || !digest(scope.expectedPayloadDigest)) fail("PORTABLE_EVIDENCE_SCOPE_INVALID");
    const source = context(scope.directory, signal, target.check); nativeSeparate(source.root, target.root);
    const captured = inspectCodexCapturedPhysicalSource({ directory: source.root, signal, assertCurrentAuthority: source.check });
    if (captured.payloadDigest !== scope.expectedPayloadDigest || !equal(captured.payload.threadIds, [scope.threadId])) fail("PORTABLE_EVIDENCE_SOURCE_CHANGED");
    const manifest = queue(source, "manifest.json"), intent = queue(source, "capture-intent.json");
    if (manifest.sha256 !== scope.expectedPayloadDigest) fail("PORTABLE_EVIDENCE_SOURCE_CHANGED");
    validators.push(() => { source.check(); if (inspectCodexCapturedPhysicalSource({ directory: source.root, signal, assertCurrentAuthority: source.check }).payloadDigest !== scope.expectedPayloadDigest) fail("PORTABLE_EVIDENCE_SOURCE_CHANGED"); });
    for (const file of captured.payload.files) queue(source, "objects/" + file.sha256 + ".bin", file);
    const history = captureHistory(source, queue, signal);
    const stat = fs.lstatSync(source.root, { bigint: true });
    sources.push({ threadId: scope.threadId, provider: "codex", kind: "captured-physical-originals", manifest, intent,
      historicalStoreObservation: { dev: String(stat.dev), ino: String(stat.ino), identityScope: "capture-host-only-not-a-target-device-ID" }, history });
  }
  for (const scope of lodeBundles) {
    if (!scope || Object.keys(scope).some(key => !["bundleRoot", "expectedBundleId", "expectedManifestDigest", "threadIds"].includes(key))
      || !Array.isArray(scope.threadIds) || new Set(scope.threadIds).size !== scope.threadIds.length || scope.threadIds.some(id => !members.has(id))
      || !digest(scope.expectedManifestDigest)) fail("PORTABLE_EVIDENCE_LODE_SCOPE_INVALID");
    const source = context(scope.bundleRoot, signal, target.check); nativeSeparate(source.root, target.root);
    const inspected = inspectProjectBundle({ bundleRoot: source.root, expectedBundleId: scope.expectedBundleId, signal });
    if (inspected.manifestSha256 !== scope.expectedManifestDigest) fail("PORTABLE_EVIDENCE_LODE_SOURCE_CHANGED");
    const owner = inspected.manifest.projectId + ":" + inspected.manifest.selectedSessionId;
    if (logical.has(owner)) fail("PORTABLE_EVIDENCE_DUPLICATE_LOGICAL_SESSION"); logical.add(owner);
    const manifest = queue(source, "manifest.json"), intent = queue(source, "export-intent.json");
    if (manifest.sha256 !== scope.expectedManifestDigest) fail("PORTABLE_EVIDENCE_LODE_SOURCE_CHANGED");
    validators.push(() => { source.check(); if (inspectProjectBundle({ bundleRoot: source.root, expectedBundleId: scope.expectedBundleId, signal }).manifestSha256 !== scope.expectedManifestDigest) fail("PORTABLE_EVIDENCE_LODE_SOURCE_CHANGED"); });
    for (const file of inspected.manifest.files) queue(source, "objects/" + file.sha256 + ".bin", file);
    const handoff = inspected.handoff.status === "verified-generated-handoff" ? queue(source, inspected.manifest.handoff.path) : null;
    lode.push({ bundleId: inspected.bundleId, manifest, intent, projectId: inspected.manifest.projectId,
      selectedSessionId: inspected.manifest.selectedSessionId, threadIds: scope.threadIds, handoff,
      handoffStatus: inspected.handoff.status, selection: "explicit-existing-exported-session-only", ownershipEstablished: false,
      semanticValidation: "common-bundle-verified-at-export; portable-byte-reproduction; import-must-revalidate" });
  }
  const workspaceEvidence = capturePortableWorkspaces({ catalog: catalogSource.catalog, workspaceSources, queue, addValidator: verify => validators.push(verify),
    check: target.check, signal });
  const manifest = { schemaVersion: 1, kind: "PortableCapturedProjectEvidence", authorityPlane: "P3", catalog: catalogSource.catalog,
    capturedCatalogFileDigest: expectedCatalogDigest, catalogPreservation: "extracted-selected-project-catalog-values-not-full-native-manifest-bytes", sources, lodeBundles: lode,
    ...(liveCapture ? { liveCapture } : {}),
    ...(workspaceEvidence.length ? { workspaceEvidence } : {}),
    missingSourceIds: [...members].filter(id => !sources.some(source => source.threadId === id)),
    sourceSnapshotClaim: "separate-captured-evidence-not-current-or-atomic-native-inventory", physicalBodiesIncluded: true,
    executableSourceStoreCreated: false, targetJournalSelected: false, nativePublicationAttempted: false,
    imported: false, allLogicalSessionsIncluded: false, logicalOwnersMerged: false,
    grantsRecoveryAuthority: false, restoresExecutionPermission: false };
  const raw = json(manifest), archiveDigest = hash(raw), archiveId = "project-evidence-" + archiveDigest.slice(0, 24);
  let copiedObjectCount = 0, manifestPublicationAttempted = false, manifestCommitConfirmed = false;
  try {
    target.check(); fs.mkdirSync(copiedProjectFile(target.root, "objects"), { recursive: true }); target.check();
    for (const copy of copies) {
      if (copy.raw) { exact(target.root, "objects/" + copy.entry.sha256 + ".bin", copy.raw, target.check); copiedObjectCount++; continue; }
      copy.source.check();
      copyOriginal(copy.source.root, target.root, copy.entry, { signal, assertCurrentAuthority: copy.source.check }); copiedObjectCount++;
    }
    catalogSource.recheck();
    for (const verify of validators) verify();
    // Revalidate exact observed files before committing the archive manifest.
    // Concurrent new history is not included or claimed absent.
    for (const copy of copies) {
      if (copy.raw) continue;
      copy.source.check(); const current = inspectCopiedProjectFile(copy.source.root, copy.entry.path, { signal, assertCurrentAuthority: copy.source.check });
      if (current.sha256 !== copy.entry.sha256 || current.bytes !== copy.entry.bytes) fail("PORTABLE_EVIDENCE_SOURCE_CHANGED");
    }
    verifyArchiveManifest({ manifest, archiveId, archiveDigest, object: archiveObjectReader(target.root, signal, target.check),
      verifyObject: archiveObjectMetadata(target.root, signal, target.check), check: target.check });
    manifestPublicationAttempted = true;
    exact(target.root, "archives/" + archiveId + ".json", raw, target.check);
    manifestCommitConfirmed = true;
    return readPortableProjectEvidence({ directory: target.root, archiveId, expectedArchiveDigest: archiveDigest, signal, assertCurrentAuthority });
  } catch (error) {
    error.portableEvidenceObservation = { archiveId, archiveDigest, copiedObjectCount, manifestPublicationAttempted, manifestCommitConfirmed,
      manifestPublicationOutcome: manifestCommitConfirmed ? "committed-but-final-verification-failed" : manifestPublicationAttempted ? "unknown-after-publication-entered" : "not-attempted",
      status: "incomplete-primary-failure-preserved", knownHistoryCannotBeAssumedAbsent: true, rollbackAttempted: false,
      additionalFilesystemObservationAfterFailure: false, nativePublicationAttempted: false,
      retryScope: "explicit-current-scope-read-or-create-only-same-bytes; never-native-effect-replay" };
    throw error;
  }
}

// Current Host supplies source scope and synchronization-file permission. Once
// the read/cleanup finishes, only retained bytes enter the create-only archive.
// No database/native executable clone, native target or P2 artifact is made.
export async function exportCodexLiveProjectEvidence({ directory, lodeBundles = [], workspaceSources = [], signal, assertCurrentAuthority, ...sourceOptions }) {
  if (typeof assertCurrentAuthority !== "function") fail("CODEX_LIVE_SOURCE_CURRENT_SCOPE_REQUIRED");
  const observation = await readCodexLiveProjectSource({ ...sourceOptions, signal, assertCurrentAuthority });
  if (observation.status !== "live-project-source-observed") return observation;
  let failure = null;
  try { return exportPortableProjectEvidence({ directory, lodeBundles, workspaceSources, liveObservation: observation, signal, assertCurrentAuthority }); }
  catch (error) { failure = error; throw error; }
  finally { try { releaseCodexLiveProjectObservation(observation); } catch (cleanup) { if (failure) failure.captureCleanup = { code: cleanup.code }; else throw cleanup; } }
}

export function inspectPortableProjectEvidence({ directory, archiveId, expectedArchiveDigest = null, workspaceSourceRoots = null, workspaceObjectSelection = "all-evidence", signal, assertCurrentAuthority = () => {} }) {
  if (!/^project-evidence-[a-f0-9]{24}$/u.test(archiveId || "")) fail("PORTABLE_EVIDENCE_ID_INVALID");
  const archive = context(directory, signal, assertCurrentAuthority);
  const header = nativeRaw(archive.root, "archives/" + archiveId + ".json", signal, archive.check), manifest = parseCodexSourceJson(new TextDecoder("utf-8", { fatal: true }).decode(header.raw));
  if (expectedArchiveDigest !== null && header.entry.sha256 !== expectedArchiveDigest) fail("PORTABLE_EVIDENCE_DIGEST_MISMATCH");
  const verified = verifyArchiveManifest({ manifest, archiveId, archiveDigest: header.entry.sha256,
    object: archiveObjectReader(archive.root, signal, archive.check), verifyObject: archiveObjectMetadata(archive.root, signal, archive.check), workspaceSourceRoots, workspaceObjectSelection, check: archive.check });
  const allWorkspaces = manifest.workspaceEvidence ?? [], verifiedWorkspaces = allWorkspaces.filter(group => workspaceSourceRoots === null || workspaceSourceRoots.includes(group.sourceRoot));
  const allObjects = new Set(allWorkspaces.flatMap(group => group.entries.filter(entry => entry.original).map(entry => entry.original.sha256)));
  const verifiedObjects = new Set(verifiedWorkspaces.flatMap(group => group.entries.filter(entry => entry.original && (workspaceObjectSelection === "all-evidence" || entry.status === "captured")).map(entry => entry.original.sha256)));
  const fullyVerified = group => group.entries.filter(entry => entry.original).every(entry => verifiedObjects.has(entry.original.sha256));
  return { ...verified, directory: archive.root, archiveId, archiveDigest: header.entry.sha256, authorityPlane: "P4",
    workspaceObjectCoverage: { mode: workspaceSourceRoots === null ? "all-captured-workspaces" : workspaceSourceRoots.length ? "selected-workspaces" : "metadata-only",
      objectSelection: workspaceObjectSelection,
      verifiedSourceRoots: verifiedWorkspaces.filter(fullyVerified).map(group => group.sourceRoot),
      partiallyVerifiedSourceRoots: verifiedWorkspaces.filter(group => !fullyVerified(group) && group.entries.some(entry => entry.original && verifiedObjects.has(entry.original.sha256))).map(group => group.sourceRoot),
      unverifiedSourceRoots: allWorkspaces.filter(group => !verifiedWorkspaces.includes(group) || !fullyVerified(group)).map(group => group.sourceRoot),
      verifiedObjectCount: verifiedObjects.size, unverifiedObjectCount: [...allObjects].filter(digest => !verifiedObjects.has(digest)).length,
      unverifiedObjectIntegrity: "not-observed-by-this-operation", resolvesPriorFailures: false } };
}

function archiveObjectReader(root, signal, check) {
  return entry => {
    // Empty raw originals are valid evidence; JSON/physical codecs impose their
    // own shape requirements separately. Do not discard interrupted journals.
    if (!digest(entry?.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) fail("PORTABLE_EVIDENCE_OBJECT_INVALID");
    const read = readHistoryRaw(root, "objects/" + entry.sha256 + ".bin", signal, check);
    if (read.entry.sha256 !== entry.sha256 || read.entry.bytes !== entry.bytes) fail("PORTABLE_EVIDENCE_OBJECT_CHANGED"); return read.raw;
  };
}

function archiveObjectMetadata(root, signal, check) {
  return entry => {
    if (!digest(entry?.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) fail("PORTABLE_EVIDENCE_OBJECT_INVALID");
    const observed = inspectCopiedProjectFile(root, "objects/" + entry.sha256 + ".bin", { signal, assertCurrentAuthority: check });
    if (observed.sha256 !== entry.sha256 || observed.bytes !== entry.bytes) fail("PORTABLE_EVIDENCE_OBJECT_CHANGED");
    return observed;
  };
}

function verifyArchiveManifest({ manifest, archiveId, archiveDigest, object, verifyObject, workspaceSourceRoots = null, workspaceObjectSelection = "all-evidence", check }) {
  check();
  if (archiveId !== "project-evidence-" + archiveDigest.slice(0, 24) || manifest.schemaVersion !== 1 || manifest.kind !== "PortableCapturedProjectEvidence"
    || manifest.authorityPlane !== "P3" || manifest.physicalBodiesIncluded !== true || !Array.isArray(manifest.sources) || !Array.isArray(manifest.lodeBundles)
    || !digest(manifest.capturedCatalogFileDigest) || manifest.catalogPreservation !== "extracted-selected-project-catalog-values-not-full-native-manifest-bytes"
    || manifest.sourceSnapshotClaim !== "separate-captured-evidence-not-current-or-atomic-native-inventory"
    || ["executableSourceStoreCreated", "targetJournalSelected", "nativePublicationAttempted", "imported", "allLogicalSessionsIncluded", "logicalOwnersMerged", "grantsRecoveryAuthority", "restoresExecutionPermission"].some(key => manifest[key] !== false)) fail("PORTABLE_EVIDENCE_MANIFEST_INVALID");
  const catalog = verifyCodexProjectCatalog(manifest.catalog), members = new Set(catalog.records.map(row => row.id));
  const seen = new Set(), sources = [];
  for (const source of manifest.sources) {
    if (!members.has(source.threadId) || seen.has(source.threadId) || source.provider !== "codex" || source.kind !== "captured-physical-originals") fail("PORTABLE_EVIDENCE_SOURCE_INVALID");
    seen.add(source.threadId);
    const native = verifyCodexCapturedPhysicalEvidence({ manifestRaw: object(source.manifest), captureIntentRaw: object(source.intent), readObject: object, check });
    if (!equal(native.payload.threadIds, [source.threadId]) || !Array.isArray(source.history?.entries) || source.history.noPriorAttemptsProven !== false
      || source.history.coverage !== "bounded-observation-not-complete-or-atomic" || source.history.grantsExecutionAuthority !== false) fail("PORTABLE_EVIDENCE_SOURCE_INVALID");
    for (const entry of source.history.entries) object(entry.original); // raw history bytes, never execute or follow their target paths
    sources.push({ ...source, native });
  }
  if (!equal(manifest.missingSourceIds, [...members].filter(id => !seen.has(id)))) fail("PORTABLE_EVIDENCE_SOURCE_INVALID");
  if (workspaceSourceRoots !== null && (!Array.isArray(workspaceSourceRoots) || workspaceSourceRoots.some(root => typeof root !== "string"))) fail("PORTABLE_WORKSPACE_VERIFICATION_SCOPE_INVALID");
  if (!["all-evidence", "restore-captured-only"].includes(workspaceObjectSelection)) fail("PORTABLE_WORKSPACE_VERIFICATION_SCOPE_INVALID");
  if (manifest.workspaceEvidence !== undefined) verifyPortableWorkspaceEvidence(manifest.workspaceEvidence, verifyObject, manifest.catalog, workspaceSourceRoots, workspaceObjectSelection);
  if (manifest.liveCapture !== undefined) {
    const capture = manifest.liveCapture;
    if (manifest.catalog.kind === "CodexExplicitConversationCatalog" && (capture.sourceProjectNamespace !== "caller-project-reference-not-native-membership"
      || capture.appMembershipVerifiedByCore !== false || capture.selectionIsPermission !== false)) fail("PORTABLE_LIVE_CAPTURE_INVALID");
    if (capture.schemaVersion !== 1 || capture.kind !== "PortableLiveCodexProjectObservation" || capture.authorityPlane !== "P3"
      || capture.sourceProjectId !== manifest.catalog.projectId || capture.currentAfterSnapshotRelease !== "not-observed"
      || capture.catalogSerialization !== "generated-catalog-value-encoding-not-original-file-bytes"
      || capture.snapshots?.globalAtomicSnapshotClaimed !== false || capture.cleanup !== "reader-connections-closed-before-owned-guard-release"
      || ["executableSourceStoreCreated", "nativePublicationAttempted", "grantsRecoveryAuthority", "restoresExecutionPermission"].some(key => capture[key] !== false)
      || !Array.isArray(capture.rows) || new Set(capture.rows.map(row => row.threadId)).size !== capture.rows.length) fail("PORTABLE_LIVE_CAPTURE_INVALID");
    for (const row of capture.rows) {
      if (!members.has(row.threadId) || !["selected-source-unavailable", "selected-live-originals-observed"].includes(row.status)
        || row.nativePublicationReady !== false || row.semanticHistoryEquivalent !== false || !Array.isArray(row.originals)
        || row.historyCoverage && row.historyCoverage.canonicalRowContentsEquivalent !== false) fail("PORTABLE_LIVE_CAPTURE_ROW_INVALID");
      const selectedState = verifySelectedCodexStateEvidence(parseCodexSourceJson(object(row.selectedState).toString("utf8")), [row.threadId])[0];
      if (row.history) {
        const history = parseCodexSourceJson(historyMetadataText(object(row.history)));
        if (!equal(history.threadIds, [row.rolloutId])) fail("PORTABLE_LIVE_CAPTURE_ROW_INVALID");
        if (history.authorityPlane !== "P3" || history.grantsRecoveryAuthority !== false || history.nativeWriteAuthorized !== false) fail("PORTABLE_LIVE_CAPTURE_ROW_INVALID");
        if (history.kind === "CodexSelectedHistoryAddressEvidence") verifyCodexHistoryAddresses(history);
        else verifySelectedCodexHistory(history);
      }
      const originals = row.originals.map(original => ({ ...original, raw: object(original.original) }));
      for (const original of originals) {
        if (Object.hasOwn(original, "sourceEncoding") || Object.hasOwn(original, "compressionEvidence")) {
          if (original.sourceEncoding !== "zstd-decoded-selected-prefix") fail("PORTABLE_LIVE_CAPTURE_ENCODING_INVALID");
          verifyCodexZstdPrefixObservation(original.compressionEvidence, { bytes: original.original.bytes, sha256: original.original.sha256 });
        }
      }
      if (row.stateHeaderAgreement !== undefined && row.stateHeaderAgreement !== null) {
        const leaf = originals.find(original => original.rolloutId === row.rolloutId), end = leaf?.raw.indexOf(10) ?? -1;
        if (end < 0) fail("PORTABLE_LIVE_CAPTURE_ROW_INVALID");
        const header = parseCodexSourceJson(leaf.raw.subarray(0, end).toString("utf8")).payload;
        if (!equal(row.stateHeaderAgreement, { cliVersion: selectedState.cli_version === header.cli_version,
          historyMode: selectedState.history_mode === header.history_mode, recordedValuesPreserved: true })) fail("PORTABLE_LIVE_CAPTURE_ROW_INVALID");
      }
      if (row.incompleteTail && object(row.incompleteTail).includes(10)) fail("PORTABLE_LIVE_CAPTURE_TAIL_INVALID");
      const source = sources.find(source => source.threadId === row.threadId);
      const ordered = files => files.sort((a, b) => a.rolloutId.localeCompare(b.rolloutId));
      if (source && (!equal(ordered(source.native.payload.files.map(file => ({ rolloutId: file.rolloutId, threadId: file.threadId, sha256: file.sha256, bytes: file.bytes, sourceEncoding: file.sourceEncoding ?? null }))),
        ordered(row.originals.map(original => ({ rolloutId: original.rolloutId, threadId: original.threadId, ...original.original, sourceEncoding: original.sourceEncoding ?? null }))))
        || row.status !== "selected-live-originals-observed" || row.lineage?.status !== "physical-lineage-ranges-verified")) fail("PORTABLE_LIVE_CAPTURE_ROW_INVALID");
      if (row.status === "selected-source-unavailable" && (!row.reasonCode || originals.length || source)) fail("PORTABLE_LIVE_CAPTURE_ROW_INVALID");
    }
    if (capture.sourceCoverage?.selectedConversations !== capture.rows.length
      || capture.sourceCoverage.rawRetainedConversations !== capture.rows.filter(row => row.originals.length > 0).length
      || capture.sourceCoverage.unavailableConversations !== capture.rows.filter(row => row.status === "selected-source-unavailable").length
      || capture.sourceCoverage.semanticHistoryEquivalent !== false || capture.sourceCoverage.completeNativeInventoryClaimed !== false) fail("PORTABLE_LIVE_CAPTURE_INVALID");
  }
  const owners = new Set();
  for (const bundle of manifest.lodeBundles) {
    const raw = object(bundle.manifest), original = parseCodexSourceJson(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    const intent = parseCodexSourceJson(new TextDecoder("utf-8", { fatal: true }).decode(object(bundle.intent)));
    if (original.kind !== "PortableProjectBundle" || original.projectId !== bundle.projectId || original.selectedSessionId !== bundle.selectedSessionId
      || typeof bundle.projectId !== "string" || !bundle.projectId || typeof bundle.selectedSessionId !== "string" || !bundle.selectedSessionId
      || intent.kind !== "ProjectBundleExportIntent" || intent.schemaVersion !== 1
      || bundle.bundleId !== "project-bundle-" + hash(raw).slice(0, 24) || intent.bundleId !== bundle.bundleId || intent.manifestSha256 !== hash(raw)
      || !Array.isArray(original.files) || !Array.isArray(bundle.threadIds) || bundle.threadIds.some(id => !members.has(id)) || bundle.ownershipEstablished !== false)
      fail("PORTABLE_EVIDENCE_LODE_INVALID");
    const owner = bundle.projectId + ":" + bundle.selectedSessionId;
    if (owners.has(owner)) fail("PORTABLE_EVIDENCE_DUPLICATE_LOGICAL_SESSION"); owners.add(owner);
    for (const file of original.files) object(file);
    if (bundle.handoff) object(bundle.handoff);
  }
  check(); return { manifest, sources };
}

export function readPortableProjectEvidence(options) {
  if (options.workspaceSourceRoots != null || options.workspaceObjectSelection !== undefined && options.workspaceObjectSelection !== "all-evidence") fail("PORTABLE_EVIDENCE_FULL_READ_SCOPE_REQUIRED");
  const inspected = inspectPortableProjectEvidence(options);
  return { status: "portable-project-evidence-verified", authorityPlane: "P4", directory: inspected.directory, archiveId: inspected.archiveId,
    archiveDigest: inspected.archiveDigest, sourceProjectId: inspected.manifest.catalog.projectId,
    sourceProjectNamespace: inspected.manifest.catalog.kind === "CodexExplicitConversationCatalog" ? "caller-project-reference-not-native-membership" : "codex-native-project",
    appMembershipVerifiedByCore: false, selectionIsPermission: false, physicalBodiesIncluded: true,
    sources: inspected.sources.map(source => ({ threadId: source.threadId, payloadId: source.native.payloadId, payloadDigest: source.native.payloadDigest,
      physicalSegmentCount: source.native.proof.segments.length, selectionBindingStatus: source.native.selectionBinding?.status ?? "association-proposed",
      operationHistoryStatus: source.history.status, observedHistoricalFiles: source.history.entries.length,
      unparsedHistoricalRecords: source.history.entries.filter(entry => ["unparsed-original", "numeric-representation-unqualified"].includes(entry.recordKind)).length,
      historicalOutcome: "not-inferred-from-raw-records", noPriorAttemptsProven: false })),
    missingSourceIds: inspected.manifest.missingSourceIds, selectedLogicalSessions: inspected.manifest.lodeBundles.map(bundle => ({ projectId: bundle.projectId, selectedSessionId: bundle.selectedSessionId, bundleId: bundle.bundleId })),
    ...(inspected.manifest.liveCapture ? { liveSource: { sourceCoverage: inspected.manifest.liveCapture.sourceCoverage,
      currentAfterSnapshotRelease: "not-observed", rows: inspected.manifest.liveCapture.rows.map(row => ({ threadId: row.threadId, rolloutId: row.rolloutId,
        status: row.status, reasonCode: row.reasonCode, lineage: row.lineage, historyCoverage: row.historyCoverage, stateHeaderAgreement: row.stateHeaderAgreement ?? null,
        primarySourceFailure: row.primarySourceFailure ?? null, sourceFileObservation: row.sourceFileObservation ?? null,
        incompleteTailBytes: row.incompleteTail?.bytes ?? 0,
        representation: inspected.sources.some(source => source.threadId === row.threadId) ? "captured-physical-source" : "partial-live-evidence-only",
        nativePublicationReady: false, semanticHistoryEquivalent: false })) } } : {}),
    workspaceEvidence: (inspected.manifest.workspaceEvidence ?? []).map(group => ({ workspaceId: group.workspaceId, sourceRoot: group.sourceRoot,
      credentialCoverage: group.credentialCoverage,
      capturedFiles: group.entries.filter(entry => entry.status === "captured").length,
      excludedPaths: group.entries.filter(entry => entry.status === "excluded").map(entry => ({ path: entry.path, reason: entry.reason })),
      evidenceOnlyPaths: group.entries.filter(entry => entry.status === "evidence-only").map(entry => ({ path: entry.path, reason: entry.reason })),
      unavailablePaths: group.entries.filter(entry => entry.status === "unavailable").map(entry => ({ path: entry.path, reason: entry.reason })),
      fullRepositoryInventoryClaimed: false, sourcePermissionsImported: false })),
    workspaceObjectCoverage: inspected.workspaceObjectCoverage,
    requiresOriginalSourceStoreForByteVerification: false, executableSourceStoreCreated: false, targetJournalSelected: false, nativePublicationAttempted: false,
    imported: false, allLogicalSessionsIncluded: false, logicalOwnersMerged: false, grantsRecoveryAuthority: false, restoresExecutionPermission: false };
}

// Restore only an explicitly selected common Session bundle as P3 staging.
// This is not Project import, Session selection or a native/executable store.
export function materializePortableProjectSessionBundle({ directory, archiveId, expectedArchiveDigest, bundleId, outputDirectory,
  signal, assertCurrentAuthority = () => {} }) {
  if (!digest(expectedArchiveDigest)) fail("PORTABLE_EVIDENCE_EXPECTED_DIGEST_REQUIRED");
  const archive = inspectPortableProjectEvidence({ directory, archiveId, expectedArchiveDigest, workspaceSourceRoots: [], signal, assertCurrentAuthority });
  const selected = archive.manifest.lodeBundles.find(bundle => bundle.bundleId === bundleId);
  if (!selected) fail("PORTABLE_EVIDENCE_EXACT_SESSION_BUNDLE_REQUIRED");
  const source = context(archive.directory, signal, assertCurrentAuthority), target = context(outputDirectory, signal, source.check);
  nativeSeparate(source.root, target.root);
  const object = ref => { const entry = nativeRaw(source.root, "objects/" + ref.sha256 + ".bin", signal, target.check);
    if (entry.entry.sha256 !== ref.sha256 || entry.entry.bytes !== ref.bytes) fail("PORTABLE_EVIDENCE_OBJECT_CHANGED"); return entry.raw; };
  let copiedObjectCount = 0, manifestPublicationAttempted = false, manifestCommitConfirmed = false;
  try {
  const manifestRaw = object(selected.manifest), manifest = parseCodexSourceJson(new TextDecoder("utf-8", { fatal: true }).decode(manifestRaw));
  const intent = object(selected.intent);
  target.check(); fs.mkdirSync(copiedProjectFile(target.root, "objects"), { recursive: true });
  for (const entry of manifest.files) { copyOriginal(source.root, target.root, { ...entry, path: "objects/" + entry.sha256 + ".bin" }, { signal, assertCurrentAuthority: target.check }); copiedObjectCount++; }
  if (selected.handoff) {
    if (typeof manifest.handoff?.path !== "string") fail("PORTABLE_EVIDENCE_LODE_INVALID");
    exact(target.root, manifest.handoff.path, object(selected.handoff), target.check);
  }
  exact(target.root, "export-intent.json", intent, target.check);
  manifestPublicationAttempted = true;
  exact(target.root, "manifest.json", manifestRaw, target.check);
  manifestCommitConfirmed = true;
  const verified = inspectProjectBundle({ bundleRoot: target.root, expectedBundleId: bundleId, signal });
  target.check();
  if (verified.manifestSha256 !== selected.manifest.sha256 || verified.manifest.projectId !== selected.projectId || verified.manifest.selectedSessionId !== selected.selectedSessionId)
    fail("PORTABLE_EVIDENCE_LODE_INVALID");
  return { status: "portable-selected-session-bundle-staged", authorityPlane: "P3", bundleRoot: target.root, bundleId,
    manifestDigest: verified.manifestSha256, projectId: selected.projectId, selectedSessionId: selected.selectedSessionId,
    imported: false, selectedCurrentSession: false, nativeSourceStoreCreated: false, targetJournalSelected: false,
    grantsRecoveryAuthority: false, restoresExecutionPermission: false,
    nextImport: { tool: "lode_project_bundle_import", arguments: { bundle_root: target.root, expected_bundle_id: bundleId },
      requiresCurrentUserScope: true, executed: false } };
  } catch (error) {
    error.portableEvidenceObservation = { archiveId, archiveDigest: expectedArchiveDigest, bundleId, outputDirectory: target.root,
      phase: "selected-common-session-stage", copiedObjectCount, manifestPublicationAttempted, manifestCommitConfirmed,
      manifestPublicationOutcome: manifestCommitConfirmed ? "committed-but-final-verification-failed" : manifestPublicationAttempted ? "unknown-after-publication-entered" : "not-attempted",
      status: "incomplete-primary-failure-preserved", imported: false, selectedCurrentSession: false, nativePublicationAttempted: false,
      rollbackAttempted: false, additionalFilesystemObservationAfterFailure: false, grantsRecoveryAuthority: false, restoresExecutionPermission: false };
    throw error;
  }
}

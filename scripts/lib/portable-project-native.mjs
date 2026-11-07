import { inspectPortableProjectEvidence } from "./portable-project-evidence.mjs";
import { verifyCodexProjectCatalog } from "./codex-project-catalog.mjs";
import { projectConversationWorkspaceMappings } from "./project-conversation-collection.mjs";
import { preparePortableProjectNativeHistory, locatePortableProjectNativeDerivation, projectNativeDerivationSummary } from "./project-native-derivation.mjs";
import { publishClaudeDerivedWithDestinationJournal, verifyClaudeDerived } from "./claude-derived-publication.mjs";
import { nativeRoot, pinNativeRoot, nativeCheck, nativeRaw } from "./provider-native-history-host.mjs";
import { derivedFail as fail, derivedHash as hash, derivedJson as json } from "./claude-derived-encoder.mjs";
import { createLocalDestinationImportHost } from "./local-destination-import-host.mjs";
import { classifyDerivedPublicationHistory } from "./derived-publication-history.mjs";

// One archive, separate native conversations. Missing originals/mappings stay
// row-local. A primary source/permission/effect error stops further observations
// and retains completed rows plus the active/unknown and unvisited scope.
export async function operatePortableProjectNative({ action, directory, archiveId, expectedArchiveDigest, threadIds,
  root, workspaceMappings = [], nativeHome, host = null, destinationHost = null, signal, assertCurrentAuthority, converter }) {
  if (!["read-portable-project", "derive-portable-project", "admit-portable-targets", "publish-portable-project", "verify-portable-project"].includes(action)
    || typeof assertCurrentAuthority !== "function" || !/^[a-f0-9]{64}$/u.test(expectedArchiveDigest || "")) fail("PORTABLE_PROJECT_NATIVE_CURRENT_SCOPE_REQUIRED");
  const check = () => nativeCheck(signal, assertCurrentAuthority);
  check(); const archive = inspectPortableProjectEvidence({ directory, archiveId, expectedArchiveDigest, workspaceSourceRoots: [], signal, assertCurrentAuthority: check });
  if (!destinationHost && ["admit-portable-targets", "publish-portable-project"].includes(action)) destinationHost = createLocalDestinationImportHost({ nativeHome, signal,
    assertCurrentAuthority: request => { check(); return assertCurrentAuthority(request); },
    authorizeTargetAdmission: action === "admit-portable-targets" ? request => assertCurrentAuthority(request) : null,
    sourceHistoryFor: async request => {
      check(); const current = inspectPortableProjectEvidence({ directory, archiveId, expectedArchiveDigest, workspaceSourceRoots: [], signal, assertCurrentAuthority: check });
      const source = current.sources.find(row => row.native.payloadDigest === request.operation.sourceDigest);
      if (!source) fail("DESTINATION_LOCAL_VERIFIED_HISTORY_REQUIRED");
      const evidenceCache = new Map();
      const originalEvidence = entry => {
        if (!entry) return null;
        if (!evidenceCache.has(entry.path)) {
          const original = nativeRaw(current.directory, "objects/" + entry.original.sha256 + ".bin", signal, check);
          if (original.entry.sha256 !== entry.original.sha256 || original.entry.bytes !== entry.original.bytes) fail("DERIVED_SOURCE_PAYLOAD_CHANGED");
          evidenceCache.set(entry.path, { raw: original.raw, sha256: original.entry.sha256, bytes: original.entry.bytes });
        }
        return evidenceCache.get(entry.path);
      };
      const records = source.history.entries.filter(entry => entry.kind === "historical-P5-observation-not-new-authority").map(entry => {
        const prefix = /^(native\/derived\/claude\/derived-claude-[a-f0-9]{24})\/effects\//u.exec(entry.path)?.[1];
        if (!prefix || !/\/(?:publication-attempt|publication-receipt)\.json$/u.test(entry.path)) return {
          sha256: entry.original.sha256, bytes: entry.original.bytes, nativeId: null,
          interpretation: "unqualified-operational-original-not-authority" };
        const identity = name => source.history.entries.find(item => item.kind === "derivative-identity-original" && item.path === prefix + "/" + name);
        return classifyDerivedPublicationHistory({ record: originalEvidence(entry), manifest: originalEvidence(identity("manifest.json")),
          intent: originalEvidence(identity("intent.json")), sourceDigest: source.native.payloadDigest, threadId: source.threadId, relativePath: entry.path });
      });
      for (const entry of source.history.unqualifiedOperationalEntries ?? []) if (entry.rawOriginalPreserved !== true) records.push({
        sha256: hash(json(entry)), digestBasis: "verified-archive-operational-namespace-metadata", nativeId: null,
        interpretation: "unqualified-operational-namespace-entry; occurrence-or-outcome-not-inferred" });
      if (source.history.skippedUnknownEntries > 0 && source.history.classificationProfile !== "known-operational-namespaces-v2") records.push({
        sha256: hash(json(source.history)), digestBasis: "verified-archive-history-coverage-metadata", nativeId: null,
        interpretation: "legacy-unclassified-history-coverage; not-proof-that-an-effect-occurred" });
      return { sourceVerified: true, sourceDigest: source.native.payloadDigest,
        evidenceDigest: hash(json({ archiveDigest: current.archiveDigest, threadId: source.threadId, history: source.history })),
        records };
    } });
  const catalog = verifyCodexProjectCatalog(archive.manifest.catalog), selectedIds = threadIds ?? archive.manifest.catalog.threadIds;
  if (!Array.isArray(selectedIds) || !selectedIds.length || new Set(selectedIds).size !== selectedIds.length
    || selectedIds.some(id => !archive.manifest.catalog.threadIds.includes(id))) fail("PORTABLE_PROJECT_NATIVE_SELECTION_INVALID");
  const mappings = projectConversationWorkspaceMappings(workspaceMappings);
  const sharedRoot = root === undefined ? null : nativeRoot(root), sharedPin = sharedRoot ? pinNativeRoot(sharedRoot) : null;
  if (sharedRoot && workspaceMappings.length) fail("PORTABLE_PROJECT_NATIVE_AMBIGUOUS_TARGET_MAPPING");
  const results = []; let activeRow = null;
  try {
    for (const threadId of selectedIds) {
      check(); sharedPin?.verify(); activeRow = { threadId };
      const member = catalog.records.find(row => row.id === threadId), source = archive.sources.find(row => row.threadId === threadId);
      const sourceEvidence = archive.manifest.liveCapture?.rows.find(row => row.threadId === threadId);
      const sourceCoverage = sourceEvidence ? { status: sourceEvidence.status, reasonCode: sourceEvidence.reasonCode,
        incompleteTailBytes: sourceEvidence.incompleteTail?.bytes ?? 0, historyCoverage: sourceEvidence.historyCoverage,
        semanticHistoryEquivalent: false } : { semanticHistoryEquivalent: false, currentSourceObserved: false };
      if (!source) { results.push({ threadId, status: "source-evidence-partial", sourceCoverage, nativeEffectAttempted: false }); activeRow = null; continue; }
      const mapping = sharedRoot ? { root: sharedRoot, pin: sharedPin } : mappings.get(member.cwd);
      if (!mapping) { results.push({ threadId, status: "target-workspace-unselected", sourceRoot: member.cwd, sourceCoverage, nativeEffectAttempted: false }); activeRow = null; continue; }
      mapping.pin.verify(); const targetRoot = mapping.root;
      if (action === "admit-portable-targets") {
        if (typeof destinationHost?.admitTarget !== "function") fail("DESTINATION_LOCAL_CURRENT_TARGET_ADMISSION_REQUIRED");
        const result = await destinationHost.admitTarget({ projectRoot: targetRoot });
        results.push({ threadId, status: result.status, sourceCoverage, targetRoot, result, nativeEffectAttempted: false }); activeRow = null; continue;
      }
      const args = { directory, archiveId, expectedArchiveDigest, threadId, root: targetRoot, signal, assertCurrentAuthority: check, ...(converter ? { converter } : {}) };
      let artifact;
      if (["derive-portable-project", "publish-portable-project"].includes(action)) {
        artifact = await preparePortableProjectNativeHistory(args); check(); mapping.pin.verify();
      } else artifact = await locatePortableProjectNativeDerivation(args);
      if (!artifact) { results.push({ threadId, status: "representation-not-prepared", sourceCoverage, nativeEffectAttempted: false }); activeRow = null; continue; }
      let result = projectNativeDerivationSummary(artifact);
      if (action === "publish-portable-project" && artifact.manifest.publicationReady) {
        if (typeof destinationHost?.currentImportScope !== "function") result = { ...result, status: "destination-operational-host-unavailable",
          reasonCode: "DESTINATION_IMPORT_CURRENT_HOST_REQUIRED", nativeEffectAttempted: false };
        else result = await publishClaudeDerivedWithDestinationJournal({ artifact, nativeHome, root: targetRoot, host, destinationHost, signal, assertCurrentAuthority: check });
      } else if (action === "verify-portable-project") {
        result = await verifyClaudeDerived({ artifact, nativeHome, root: targetRoot, host, signal, assertCurrentAuthority: check });
      }
      results.push({ threadId, status: result.status, sourceCoverage, targetRoot, derivationId: artifact.manifest.derivationId,
        derivationDigest: artifact.digest, targetNativeId: artifact.manifest.target.nativeId, result }); activeRow = null;
    }
  } catch (error) {
    error.collectionOperationResult = { kind: "ProjectConversationCollectionPartialOutcome", authorityPlane: ["read-portable-project", "derive-portable-project"].includes(action) ? "P4" : "P5", action, archiveId, expectedArchiveDigest,
      results, activeRow, unvisitedThreadIds: selectedIds.slice(results.length + (activeRow ? 1 : 0)),
      activeDestinationObservation: error.destinationImportObservation ?? null, primaryFailure: { code: error.code || error.name },
      automaticReplayAllowed: false, rollbackAttempted: false, additionalFilesystemObservationAfterFailure: false,
      grantsRecoveryAuthority: false, restoresExecutionPermission: false };
    throw error;
  }
  return { status: "portable-project-native-observation", authorityPlane: action === "read-portable-project" || action === "derive-portable-project" ? "P4" : "P5",
    action, archiveId, archiveDigest: archive.archiveDigest, selectedThreadIds: selectedIds, results,
    workspaceObjectCoverage: archive.workspaceObjectCoverage,
    pendingThreadIds: results.filter(row => {
      if (!row.result) return true;
      if (action === "admit-portable-targets") return !["destination-target-admitted", "destination-existing-target-observed"].includes(row.status);
      if (["read-portable-project", "derive-portable-project"].includes(action)) return row.result.publicationReady !== true;
      if (action === "verify-portable-project") return row.result.emittedNativeCoverageComplete !== true || row.result.sourceRepresentationComplete !== true;
      if (row.result.destinationJournal?.status !== "destination-result-recorded") return true;
      const observed = row.result.targetObservation ?? row.result.destinationJournal.result?.observation;
      return !["matches", "continued"].includes(observed?.state) || observed.prefixVerified !== true;
    }).map(row => row.threadId),
    remainingSourceUncertainties: results.filter(row => row.sourceCoverage.incompleteTailBytes > 0).map(row => ({ threadId: row.threadId,
      reasonCode: "INCOMPLETE_SOURCE_TAIL_PRESERVED_NOT_INTERPRETED", bytes: row.sourceCoverage.incompleteTailBytes, blocksPrefixPublication: false })),
    allLogicalOwnersMerged: false, codeWorktreesCopied: false, commonSessionImported: false, nativeGuiObserved: false,
    modelTurnStarted: false, completeNativeMigration: false, semanticSufficiencyClaimed: false,
    grantsRecoveryAuthority: false, restoresExecutionPermission: false };
}

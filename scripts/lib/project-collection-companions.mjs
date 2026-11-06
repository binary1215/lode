import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import { inspectCodexNativePayload } from "./codex-native-payload.mjs";
import { verifyCodexProjectCatalog } from "./codex-project-catalog.mjs";
import { prepareProjectWorkspaceTransfer, applyProjectWorkspaceTransfer } from "./project-workspace-transfer.mjs";
import { inspectProjectBundle } from "./project-portability.mjs";
import { readProjectConversationCollection } from "./project-conversation-collection.mjs";
import { readCapturedProjectCatalogFile } from "./captured-project-collection.mjs";
import { atomicCreateArtifact } from "./artifact-storage.mjs";
import { copiedProjectFile, inspectCopiedProjectFile, copyOriginal } from "./project-copy-evidence.mjs";
import { nativeRoot, pinNativeRoot, nativeRaw, nativeCheck, nativeSeparate } from "./provider-native-history-host.mjs";
import { derivedHash as hash, derivedJson as json, derivedFail as fail } from "./claude-derived-encoder.mjs";

// These optional companions do not initialize/import a Lode Project or open a
// provider. Exact current caller scopes remain separate from captured paths.
export function transferProjectCollectionWorkspaces({ action, bundleRoot, workspaceTransfers,
  catalogFile, expectedCatalogDigest,
  signal, assertCurrentAuthority = () => {} }) {
  if (!["prepare-workspaces", "copy-workspaces"].includes(action) || !Array.isArray(workspaceTransfers)) fail("COLLECTION_WORKSPACE_SCOPE_INVALID");
  const check = () => nativeCheck(signal, () => { const value = assertCurrentAuthority(); if (value === false) fail("NATIVE_HISTORY_AUTHORITY_DENIED"); return value; }); check();
  let sourceRoots, catalogSource = null;
  if (catalogFile !== undefined || expectedCatalogDigest !== undefined) {
    catalogSource = readCapturedProjectCatalogFile({ catalogFile, expectedCatalogDigest, signal, assertCurrentAuthority: check });
    sourceRoots = new Set(catalogSource.verified.records.map(row => row.cwd));
  } else {
    const source = inspectCodexNativePayload({ directory: nativeRoot(bundleRoot), signal });
    if (!source.payload.projectCatalog) fail("COLLECTION_VERIFIED_PROJECT_CATALOG_REQUIRED");
    const members = verifyCodexProjectCatalog(source.payload.projectCatalog).records, selected = new Set(source.payload.threadIds);
    sourceRoots = new Set(members.filter(row => selected.has(row.id)).map(row => row.cwd));
  }
  const seen = new Set(), prepared = [], destinations = new Set();
  for (const transfer of workspaceTransfers) {
    check();
    if (!transfer || !sourceRoots.has(transfer.sourceRoot) || seen.has(transfer.sourceRoot)
      || Object.keys(transfer).some(key => !["sourceRoot", "targetRoot", "paths", "mode", "plan", "expectedPlanDigest"].includes(key))) fail("COLLECTION_WORKSPACE_SCOPE_INVALID");
    seen.add(transfer.sourceRoot);
    const value = prepareProjectWorkspaceTransfer({ ...transfer, signal, assertCurrentAuthority: check });
    const target = value.plan.target.path;
    const key = process.platform === "win32" ? target.toLowerCase() : target;
    if (destinations.has(key)) fail("COLLECTION_WORKTREES_CANNOT_BE_FLATTENED");
    destinations.add(key);
    if (action === "copy-workspaces" && (!transfer.plan || transfer.expectedPlanDigest !== hash(Buffer.from(JSON.stringify(transfer.plan)))
      || transfer.plan.source?.path !== value.plan.source.path || transfer.plan.target?.path !== value.plan.target.path
      || transfer.plan.mode !== value.plan.mode || !equal(transfer.plan.selectedPaths, value.plan.selectedPaths)
      || !equal(transfer.plan.source, value.plan.source) || !equal(transfer.plan.target.parent, value.plan.target.parent)
      || !equal(transfer.plan.entries.map(({ targetState, ...entry }) => entry), value.plan.entries.map(({ targetState, ...entry }) => entry))))
      fail("WORKSPACE_TRANSFER_PLAN_INVALID");
    prepared.push({ transfer, value });
  }
  // All source scopes and expected plans are checked before the first copy.
  // A primary failure carries already-observed workspace outcomes; no rollback.
  const results = [];
  catalogSource?.recheck();
  for (const { transfer, value } of prepared) {
    check();
    if (action === "prepare-workspaces") results.push({ sourceRoot: transfer.sourceRoot, targetRoot: transfer.targetRoot, ...value });
    else try {
      results.push({ sourceRoot: transfer.sourceRoot, targetRoot: transfer.targetRoot,
        ...applyProjectWorkspaceTransfer({ plan: transfer.plan, expectedPlanDigest: transfer.expectedPlanDigest,
          sourceRoot: transfer.sourceRoot, targetRoot: transfer.targetRoot, signal, assertCurrentAuthority: check }) });
    } catch (error) { error.completedWorkspaceTransfers = results; throw error; }
  }
  return { status: action === "prepare-workspaces" ? "project-workspaces-prepared" : "project-workspaces-observed",
    authorityPlane: action === "prepare-workspaces" ? "P4" : "P5", results, requestedWorkspaceCount: workspaceTransfers.length,
    unselectedSourceWorkspaces: [...sourceRoots].filter(root => !seen.has(root)),
    allProjectFilesClaimed: false, runnableProjectVerified: false, nativeProfilesWritten: false,
    grantsRecoveryAuthority: false, restoresExecutionPermission: false };
}

function exact(root, relative, bytes, check) {
  check(); const file = copiedProjectFile(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true }); copiedProjectFile(root, relative); check();
  try { atomicCreateArtifact(file, bytes); } catch (error) { if (error.code !== "EEXIST") throw error; }
  if (!nativeRaw(root, relative, null, check).raw.equals(bytes)) fail("COLLECTION_COMPANION_CONFLICT");
}

// Archive existing verified common bundles, independently routed by their own
// canonical Project/Session identities. This is not import, owner assignment,
// checkpoint integration, or permission to execute retained instructions.
export function attachProjectCollectionLode({ collectionRoot, collectionId, expectedCollectionDigest, lodeBundles,
  signal, assertCurrentAuthority = () => {} }) {
  if (!/^[a-f0-9]{64}$/u.test(expectedCollectionDigest || "") || !Array.isArray(lodeBundles)) fail("COLLECTION_LODE_SCOPE_INVALID");
  const collection = readProjectConversationCollection({ collectionRoot, collectionId, expectedCollectionDigest, signal, assertCurrentAuthority });
  const root = nativeRoot(collectionRoot), pin = pinNativeRoot(root), check = () => { nativeCheck(signal, () => {
    const value = assertCurrentAuthority(); if (value === false) fail("NATIVE_HISTORY_AUTHORITY_DENIED"); return value;
  }); pin.verify(); };
  const members = new Set(collection.rows.map(row => row.threadId)), identities = new Set();
  const prepared = lodeBundles.map(scope => {
    check();
    if (!scope || Object.keys(scope).some(key => !["bundleRoot", "expectedBundleId", "expectedManifestDigest", "threadIds"].includes(key))
      || !Array.isArray(scope.threadIds) || new Set(scope.threadIds).size !== scope.threadIds.length
      || scope.threadIds.some(id => !members.has(id)) || !/^[a-f0-9]{64}$/u.test(scope.expectedManifestDigest || "")) fail("COLLECTION_LODE_SCOPE_INVALID");
    const sourceRoot = nativeRoot(scope.bundleRoot); nativeSeparate(root, sourceRoot);
    const sourcePin = pinNativeRoot(sourceRoot), inspected = inspectProjectBundle({ bundleRoot: sourceRoot, expectedBundleId: scope.expectedBundleId, signal });
    if (inspected.manifestSha256 !== scope.expectedManifestDigest) fail("COLLECTION_LODE_BUNDLE_CHANGED");
    const identity = inspected.manifest.projectId + ":" + inspected.manifest.selectedSessionId;
    if (identities.has(identity)) fail("COLLECTION_LODE_DUPLICATE_SESSION_REVISION"); identities.add(identity);
    return { scope, sourceRoot, sourcePin, inspected };
  });
  const bundles = [];
  for (const { scope, sourceRoot, sourcePin, inspected } of prepared) {
    const current = () => { check(); sourcePin.verify(); };
    const relative = "lode-bundles/" + inspected.bundleId, directory = copiedProjectFile(root, relative);
    exact(root, relative + "/export-intent.json", nativeRaw(sourceRoot, "export-intent.json", signal, current).raw, current);
    fs.mkdirSync(copiedProjectFile(root, relative + "/objects"), { recursive: true }); current();
    for (const file of inspected.manifest.files) copyOriginal(sourceRoot, directory, { ...file, path: "objects/" + file.sha256 + ".bin" }, { signal, assertCurrentAuthority: current });
    let handoffStatus = "not-included";
    if (inspected.manifest.handoff && inspected.handoff.status === "verified-generated-handoff") {
      const name = inspected.manifest.handoff.path, file = inspectCopiedProjectFile(sourceRoot, name, { signal, assertCurrentAuthority: current });
      fs.mkdirSync(path.dirname(copiedProjectFile(directory, name)), { recursive: true });
      copyOriginal(sourceRoot, directory, file, { targetRelative: name, signal, assertCurrentAuthority: current });
      handoffStatus = "verified-generated-handoff-copied";
    } else if (inspected.manifest.handoff) handoffStatus = inspected.handoff.status;
    const manifest = nativeRaw(sourceRoot, "manifest.json", signal, current);
    if (manifest.entry.sha256 !== scope.expectedManifestDigest) fail("COLLECTION_LODE_BUNDLE_CHANGED");
    exact(root, relative + "/manifest.json", manifest.raw, current);
    const copied = inspectProjectBundle({ bundleRoot: directory, expectedBundleId: inspected.bundleId, signal });
    if (copied.manifestSha256 !== scope.expectedManifestDigest) fail("COLLECTION_LODE_BUNDLE_CHANGED");
    bundles.push({ relative, bundleId: inspected.bundleId, manifestDigest: inspected.manifestSha256,
      projectId: copied.manifest.projectId, selectedSessionId: copied.manifest.selectedSessionId, threadIds: scope.threadIds,
      mappingOrigin: "current-caller-association-evidence-not-native-or-logical-owner-assignment", handoffStatus,
      coverage: copied.coverage, imported: false });
  }
  // Re-read before the only association record; attachments never edit the
  // immutable collection, either original Project, or any P2 recovery field.
  readProjectConversationCollection({ collectionRoot: root, collectionId, expectedCollectionDigest, signal, assertCurrentAuthority: check });
  const evidence = { schemaVersion: 1, kind: "ProjectCollectionLodeAttachment", authorityPlane: "P3", collectionId,
    collectionDigest: expectedCollectionDigest, bundles, scope: "only-explicitly-supplied-exported-logical-sessions",
    allLogicalSessionsIncluded: false, logicalOwnersMerged: false, imported: false,
    grantsRecoveryAuthority: false, restoresExecutionPermission: false };
  const digest = hash(json(evidence)), id = "collection-lode-" + digest.slice(0, 24);
  exact(root, "companions/" + id + ".json", json(evidence), check);
  const nextActions = bundles.map(bundle => {
    const targetCandidates = [...new Set(collection.rows.filter(row => bundle.threadIds.includes(row.threadId)).map(row => row.targetRoot).filter(Boolean))];
    return { bundleId: bundle.bundleId, selectedSessionId: bundle.selectedSessionId, targetCandidates,
      import: { tool: "lode_project_bundle_import", arguments: { bundle_root: copiedProjectFile(root, bundle.relative),
        expected_bundle_id: bundle.bundleId, ...(targetCandidates.length === 1 ? { target_root: targetCandidates[0] } : {}) },
        requiresCurrentUserScope: true, executed: false },
      afterImport: { tool: "lode_conversation_enter", sessionId: bundle.selectedSessionId,
        selectedSessionOnly: true, nativeBindingTransferred: false, executed: false },
      recoveryStatus: "archived-not-imported-or-recovered" };
  });
  return { status: "project-collection-lode-archived", authorityPlane: "P4", attachmentId: id, attachmentDigest: digest,
    attachmentFile: copiedProjectFile(root, "companions/" + id + ".json"), evidence, nextActions, persisted: true };
}

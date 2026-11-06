import fs from "node:fs";
import path from "node:path";
import { atomicCreateArtifact } from "./artifact-storage.mjs";
import { copiedProjectFile } from "./project-copy-evidence.mjs";
import { nativeRoot, pinNativeRoot, nativeRaw, nativeCheck } from "./provider-native-history-host.mjs";
import { parseCodexSourceJson } from "./codex-source-json.mjs";
import { verifyCodexProjectCatalog } from "./codex-project-catalog.mjs";
import { verifySelectedCodexStateEvidence } from "./codex-native-state-evidence.mjs";
import { inspectCodexCapturedPhysicalSource } from "./codex-captured-physical-source.mjs";
import { deriveProjectNativeHistory, inspectProjectNativeDerivation } from "./project-native-derivation.mjs";
import { projectConversationWorkspaceMappings } from "./project-conversation-collection.mjs";
import { derivedHash as hash, derivedJson as json, derivedFail as fail } from "./claude-derived-encoder.mjs";
import { isDeepStrictEqual as equal } from "node:util";

function exact(root, relative, raw, check) {
  check(); const file = copiedProjectFile(root, relative);
  if (fs.lstatSync(file, { throwIfNoEntry: false })) {
    if (!nativeRaw(root, relative, null, check).raw.equals(raw)) fail("COLLECTION_CREATE_CONFLICT");
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true }); copiedProjectFile(root, relative); check();
  try { atomicCreateArtifact(file, raw); } catch (error) { if (error.code !== "EEXIST") throw error; }
  if (!nativeRaw(root, relative, null, check).raw.equals(raw)) fail("COLLECTION_CREATE_CONFLICT");
}
function retainedDerivation(captured, mapping, check, signal, converter) {
  const relative = "native/derived/claude", root = copiedProjectFile(captured.directory, relative), stat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("CAPTURED_PRIOR_DERIVATION_STORE_UNSAFE");
  const target = fs.lstatSync(mapping.root, { bigint: true }), found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    check();
    if (!/^derived-claude-[a-f0-9]{24}$/u.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) fail("CAPTURED_PRIOR_DERIVATION_STORE_UNQUALIFIED");
    const manifest = nativeRaw(captured.directory, relative + "/" + entry.name + "/manifest.json", signal, check);
    const header = parseCodexSourceJson(manifest.raw.toString("utf8"));
    if (converter !== undefined && header.input?.converter !== converter) continue;
    if (header.input?.targetRoot?.path !== mapping.root || header.input?.targetRoot?.dev !== String(target.dev) || header.input?.targetRoot?.ino !== String(target.ino)) continue;
    const artifact = inspectProjectNativeDerivation({ bundleRoot: captured.directory, derivationId: entry.name,
      expectedDerivationDigest: manifest.entry.sha256, signal, assertCurrentAuthority: check });
    const store = fs.lstatSync(captured.directory, { bigint: true });
    found.push({ id: artifact.manifest.derivationId, digest: artifact.digest, nativeId: artifact.manifest.target.nativeId,
      directoryHint: captured.directory, storeIdentity: { dev: String(store.dev), ino: String(store.ino) },
      publicationReady: artifact.manifest.publicationReady });
  }
  if (found.length > 1) fail("CAPTURED_PRIOR_DERIVATION_AMBIGUOUS");
  return found[0] ?? null;
}

// Explicit supplied capture metadata, never a live native query or model-authored
// inference of Project membership. Embedded-native-manifest mode inspects only
// this catalog layer, not every body/object in the old native payload.
export function readCapturedProjectCatalogFile({ catalogFile, expectedCatalogDigest, signal, assertCurrentAuthority = () => {} }) {
  nativeCheck(signal, assertCurrentAuthority);
  if (typeof catalogFile !== "string" || !path.isAbsolute(catalogFile) || !/^[a-f0-9]{64}$/u.test(expectedCatalogDigest || "")) fail("CAPTURED_CATALOG_EXACT_FILE_REQUIRED");
  const sourceRoot = nativeRoot(path.dirname(catalogFile)), sourcePin = pinNativeRoot(sourceRoot);
  const check = () => { nativeCheck(signal, assertCurrentAuthority); sourcePin.verify(); };
  const source = nativeRaw(sourceRoot, path.basename(catalogFile), signal, check);
  if (source.entry.sha256 !== expectedCatalogDigest) fail("CAPTURED_CATALOG_FILE_CHANGED");
  const document = parseCodexSourceJson(new TextDecoder("utf-8", { fatal: true }).decode(source.raw));
  const inputFormat = ["CodexProjectCatalog", "CodexExplicitConversationCatalog"].includes(document.kind) ? "standalone-catalog" : document.kind === "CodexNativeHistoryPayload" ? "catalog-from-native-manifest" : null;
  if (!inputFormat) fail("CAPTURED_CATALOG_FORMAT_UNQUALIFIED");
  const catalog = inputFormat === "standalone-catalog" ? document : document.projectCatalog;
  const verified = verifyCodexProjectCatalog(catalog);
  return { catalog, verified, inputFormat, check, recheck: () => {
    check(); if (nativeRaw(sourceRoot, path.basename(catalogFile), signal, check).entry.sha256 !== expectedCatalogDigest) fail("CAPTURED_CATALOG_FILE_CHANGED");
  } };
}

export function assembleCapturedProjectCollection({ catalogFile, expectedCatalogDigest, collectionRoot,
  physicalSources = [], workspaceMappings = [], signal, assertCurrentAuthority = () => {}, converter }) {
  const source = readCapturedProjectCatalogFile({ catalogFile, expectedCatalogDigest, signal, assertCurrentAuthority });
  const root = nativeRoot(collectionRoot), pin = pinNativeRoot(root), check = () => { source.check(); pin.verify(); };
  const { catalog, verified, inputFormat } = source, members = new Map(verified.records.map(member => [member.id, member]));
  if (!Array.isArray(physicalSources) || new Set(physicalSources.map(source => source?.threadId)).size !== physicalSources.length)
    fail("CAPTURED_PROJECT_SOURCE_SELECTION_INVALID");
  const selected = new Map();
  for (const source of physicalSources) {
    if (!source || Object.keys(source).some(key => !["threadId", "directory", "expectedPayloadDigest"].includes(key))
      || !members.has(source.threadId) || !/^[a-f0-9]{64}$/u.test(source.expectedPayloadDigest || "")) fail("CAPTURED_PROJECT_SOURCE_SELECTION_INVALID");
    selected.set(source.threadId, source);
  }
  const mappings = projectConversationWorkspaceMappings(workspaceMappings), rows = [];
  for (const member of verified.records) {
    check(); const selectedSource = selected.get(member.id), mapping = mappings.get(member.cwd);
    const row = { threadId: member.id, sourceRoot: member.cwd, targetRoot: mapping?.root ?? null,
      membershipBasis: "stable-native-id-match-to-supplied-catalog; source-cutoffs-may-differ" };
    if (!selectedSource) { rows.push({ ...row, source: null, status: "source-not-supplied", reasonCode: "CAPTURED_PROJECT_SOURCE_NOT_SUPPLIED" }); continue; }
    const originalRoot = nativeRoot(selectedSource.directory), originalPin = pinNativeRoot(originalRoot);
    const current = () => { check(); originalPin.verify(); mapping?.pin.verify(); };
    const captured = inspectCodexCapturedPhysicalSource({ directory: originalRoot, signal, assertCurrentAuthority: current });
    if (captured.payloadDigest !== selectedSource.expectedPayloadDigest || captured.payload.threadIds[0] !== member.id) fail("CAPTURED_PROJECT_SOURCE_IDENTITY_MISMATCH");
    // Never clone an executable source store. Even a source with no attempt yet
    // could be published immediately after assembly: all operations must share
    // its original intent and P5 journal, not mint independent local leases.
    const originalManifest = nativeRaw(originalRoot, "manifest.json", signal, current);
    if (originalManifest.entry.sha256 !== selectedSource.expectedPayloadDigest) fail("CAPTURED_PROJECT_SOURCE_IDENTITY_MISMATCH");
    const ref = { kind: "captured-physical-reference", threadId: member.id, payloadId: captured.payloadId,
      payloadDigest: captured.payloadDigest, manifestBase64: originalManifest.raw.toString("base64"), bodiesIncluded: false };
    const boundState = captured.selectionBinding?.status === "captured-state-path-verified"
      ? verifySelectedCodexStateEvidence(captured.selectionBinding.evidence, [member.id])[0] : null;
    const bound = boundState && equal(Object.fromEntries(catalog.membershipEvidence.columns.map(key => [key, boundState[key]])), member);
    if (!bound) { rows.push({ ...row, source: ref, status: "association-proposed", reasonCode: "CAPTURED_PROJECT_ASSOCIATION_UNPROVED" }); continue; }
    if (!mapping) { rows.push({ ...row, source: ref, status: "workspace-mapping-needed", reasonCode: "COLLECTION_CURRENT_WORKSPACE_MAPPING_REQUIRED" }); continue; }
    try {
      let prior = retainedDerivation(captured, mapping, current, signal, converter);
      if (!prior) {
        deriveProjectNativeHistory({ bundleRoot: originalRoot, root: mapping.root, threadIds: [member.id], signal, assertCurrentAuthority: current, ...(converter ? { converter } : {}) });
        prior = retainedDerivation(captured, mapping, current, signal, converter);
      }
      if (!prior) fail("CAPTURED_PRIOR_DERIVATION_NOT_OBSERVED");
      rows.push({ ...row, source: ref, status: "retained-derivation-reference-needed",
        reasonCode: "CAPTURED_PROJECT_RETAINED_DERIVATION_REQUIRES_REUSE", retainedDerivation: prior });
    } catch (error) {
      if (error.code !== "CODEX_SOURCE_NUMERIC_PRECISION_UNQUALIFIED") throw error;
      rows.push({ ...row, source: ref, status: "source-representation-unsupported", reasonCode: error.code });
    }
  }
  check(); source.recheck();
  const manifest = { schemaVersion: 2, kind: "CodexProjectConversationCollection", authorityPlane: "P3",
    source: { kind: "captured-project-catalog", originalFileDigest: expectedCatalogDigest, inputFormat,
      extractedCatalogDigest: hash(json(catalog)), originalCatalogFileIncluded: false,
      queryReplayVerified: false, snapshotAcrossSourcesClaimed: false, physicalBodiesIncluded: false,
      physicalVerificationScope: "recorded-manifest-metadata-only; current-source-scope-required-for-full-validation" }, catalog, rows,
    sourceOriginalsPreserved: true, workspaceFilesCopied: false, optionalLodeDataIncluded: false,
    grantsRecoveryAuthority: false, restoresExecutionPermission: false, establishesLogicalSessionOwnership: false };
  const raw = json(manifest), digest = hash(raw), id = "conversation-collection-" + digest.slice(0, 24);
  exact(root, "collections/" + id + "/manifest.json", raw, check);
  return { collectionRoot: root, collectionId: id, collectionDigest: digest, authorityPlane: "P3" };
}

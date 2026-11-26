import { SnapshotBackendReclamation } from "./snapshot-backend-reclamation.mjs";
import { hydrateSnapshotEntry } from "./snapshot-domain-bundles.mjs";
import { readSourceObservationOriginal, readSourceFailure } from "./source-observation.mjs";
import { verifyObservationTypeDescriptor, verifyObservationRecord, verifyDerivedObservationRecord, observationDigest } from "./observation-contract.mjs";
import { verifyObservationCollectionReceipt } from "./observation-store.mjs";
import fs from "node:fs";
import path from "node:path";
import { inspectProject } from "../session/lode-core.mjs";
import { safeSnapshotPath, readSnapshotFile } from "./snapshot-storage-codec.mjs";
import { verifyWorldModelPointerOriginal, verifyWorldModelSnapshotOriginal } from "./world-model.mjs";
import { verifyTemporalProvenanceGraph } from "./temporal-provenance.mjs";
import { verifyGraphProjectionPointer } from "./graph-projection-adapter.mjs";
import { normalizeProductModelDocument } from "./product-model.mjs";
import { readContextCapsule } from "../session/context-compiler.mjs";
import { readChangeSet, readVcsEvidence, readChangeImpactCandidateSet, readChangeImpactReviewDecision, verifyChangeSetStatePointer } from "./change-set.mjs";
import { readLineageArtifact } from "../runtime/execution-lineage.mjs";
import { readRecoveryCheckpoint } from "../session/compaction-recovery.mjs";
import { verifySessionRecord, verifyOnboardingState, verifyStorageSelection } from "../session/onboarding-contract.mjs";
import { verifyIncrementalRefreshRequest, verifyIncrementalRefreshReceipt, verifyIncrementalRefreshPointer } from "./incremental-refresh.mjs";
import {
  verifyPostRefreshProjectionPolicy,
  verifyPostRefreshProjectionReceipt,
  verifyPolicyPointer,
  verifyReceiptPointer,
} from "./post-refresh-projection.mjs";
import { withSessionRoute } from "../session/session-routing.mjs";
import { readSessionWorkEvidenceOwner } from "../session/session-work-context.mjs";
import { sessionWorkPath, readSessionWorkEvidenceOriginalFile } from "../session/session-work-evidence-original.mjs";
import { verifyRetainedRunOriginal } from "../runtime/run-lineage.mjs";
import { sha256Hex as hash } from "../core/digest.mjs";
import { classifyProductGraphPath, verifyProductGraphCanonFile, PRODUCT_GRAPH_DIRECTORY } from "../storage/product-graph-store.mjs";
import { failCode as failure } from "../core/errors.mjs";
import {
  ancestryIdsOf,
  currentRecordPaths,
  isCurrentPointerRoot,
  isHistoryRoot,
  namedRecordIds,
  resolveSnapshotRetentionPolicy,
  selectRetainedSnapshotIds,
  SNAPSHOT_RETENTION_RELATIVE,
} from "./snapshot-retention-policy.mjs";
import { judgeMissingReference, readRetentionReleases, RETENTION_RELEASE_DIRECTORY } from "./snapshot-retention-releases.mjs";
import { inspectStorageReaderCompatibility } from "./snapshot-storage-compatibility.mjs";

const ids = (encoded) => [...new Set(encoded.match(/\b(?:world-model|graph-snapshot|source-snapshot)-[a-f0-9]{24}\b/g) || [])];
const target = /^(world-model|graph-projection)\/snapshots\/((?:world-model|graph-snapshot)-[a-f0-9]{24})\.json(?:\.gz)?$/;
// Encoded reference-summary bound, not total V8 RSS or a Context budget.
export const SNAPSHOT_GC_SUMMARY_BYTES = 64 * 1024 * 1024;
export const snapshotFileIdentity = (stat) => ({
  dev: String(stat.dev),
  ino: String(stat.ino),
  size: String(stat.size),
  mtime: String(stat.mtimeNs ?? stat.mtimeMs),
  ctime: String(stat.ctimeNs ?? stat.ctimeMs),
  birthtime: String(stat.birthtimeNs ?? stat.birthtimeMs),
});
export const sameSnapshotFileIdentity = (left, right) => Object.keys(left).every((key) => left[key] === right[key]);

// This is a closed reader/path registry, not "valid JSON means no references".
// Unknown families preserve the entire candidate set. Positive opaque IDs may
// retain extra files, but string absence alone never certifies deletion.
export function verifyRoot(relative, document, owner) {
  const { root, projectId, storage, inspected } = owner;
  const id = path.basename(relative, ".json");
  if (document?.schemaVersion !== undefined && document.schemaVersion !== 1 && !(relative === "context/product-model.json" && document.schemaVersion === 2))
    failure("UNSUPPORTED_GC_ROOT_SCHEMA");
  if (document?.projectId && document.projectId !== projectId) failure("GC_ROOT_PROJECT_MISMATCH");
  if (/^observations\/source-bundles\/[a-f0-9]{64}\.json$/.test(relative)) {
    const key = path.basename(relative, ".json");
    if (
      document.failure
        ? Object.keys(document).length !== 1 || document.failure.version !== 1
        : JSON.stringify(Object.keys(document).sort()) !== JSON.stringify(["descriptor", "evidence", "observation"]) ||
          ![1, 2].includes(document.evidence?.version)
    )
      failure("UNSUPPORTED_GC_SOURCE_SCHEMA");
    if (document.failure) readSourceFailure(root, projectId, key, storage);
    else readSourceObservationOriginal(root, projectId, key, { storage, requireCurrent: false });
    return;
  }
  if (/^observations\/(?:descriptors|records\/by-source-key|derived|receipts)\/[^/]+\.json$/.test(relative)) {
    if (!relative.endsWith(".json")) failure("INVALID_GC_OBSERVATION_ROOT");
    const getDescriptor = () => {
      if (!/^observation-type-[a-f0-9]{24}$/.test(document.descriptorId || "")) failure("UNKNOWN_OBSERVATION_DESCRIPTOR");
      const file = safeSnapshotPath(root, path.join(root, storage.directory, "observations/descriptors", document.descriptorId + ".json")),
        stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) failure("OBSERVATION_STORE_LIMIT");
      const descriptor = JSON.parse(fs.readFileSync(file, "utf8"));
      verifyObservationTypeDescriptor(descriptor, storage);
      if (descriptor.descriptorId !== document.descriptorId) failure("UNKNOWN_OBSERVATION_DESCRIPTOR");
      return descriptor;
    };
    owner.observationIds ??= new Map();
    owner.observationReceipts ??= new Map();
    owner.observationInputs ??= [];
    if (relative.startsWith("observations/descriptors/")) {
      verifyObservationTypeDescriptor(document, storage);
      if (id !== document.descriptorId) failure("INVALID_GC_OBSERVATION_ROOT");
    } else if (relative.startsWith("observations/records/by-source-key/")) {
      verifyObservationRecord(document, getDescriptor(), projectId, storage);
      const source = document.source,
        replay = observationDigest({
          adapterKey: source.adapterKey,
          adapterVersion: source.adapterVersion,
          sourceScopeDigest: source.sourceScopeDigest,
          sourceEventKeyDigest: source.sourceEventKeyDigest,
        });
      if (id !== replay && id !== source.sourceEventKeyDigest) failure("INVALID_GC_OBSERVATION_ROOT");
      if (owner.observationIds.has(document.observationId)) failure("DUPLICATE_OBSERVATION_RECORD");
      owner.observationIds.set(document.observationId, {
        observationHash: document.observationHash,
        descriptorId: document.descriptorId,
        protocol: document.protocol.name,
      });
    } else if (relative.startsWith("observations/derived/")) {
      verifyDerivedObservationRecord(document, getDescriptor(), projectId, storage);
      if (id !== document.derivedObservationId) failure("INVALID_GC_OBSERVATION_ROOT");
      for (const input of document.inputObservations) owner.observationInputs.push({ id: input.observationId, hash: input.observationHash });
    } else {
      verifyObservationCollectionReceipt(document, projectId, storage);
      if (id !== document.receiptId) failure("INVALID_GC_OBSERVATION_ROOT");
      if (owner.observationReceipts.has(document.observationId)) failure("DUPLICATE_OBSERVATION_RECEIPT");
      owner.observationReceipts.set(document.observationId, {
        observationHash: document.observationHash,
        descriptorId: document.descriptorId,
        protocol: document.protocol.name,
      });
    }
    return;
  }
  if (relative === "project.json") {
    if (JSON.stringify(document) !== JSON.stringify(inspected.project)) failure("GC_PROJECT_ROOT_DRIFT");
  } else if (relative === "context/product-model.json") normalizeProductModelDocument(document, storage);
  else if (relative === "context/knowledge.json") {
    if (document.schemaVersion !== 1 || ["evidence", "claims", "decisions", "unknowns"].some((key) => !Array.isArray(document[key])))
      failure("INVALID_GC_KNOWLEDGE_ROOT");
  } else if (relative === "world-model/current.json") verifyWorldModelPointerOriginal(document, projectId);
  else if (relative === "graph-projection/current.json") verifyGraphProjectionPointer(document, null, storage);
  else if (relative === "sessions/current.json") {
    if (document.schemaVersion !== 1 || document.sessionId !== inspected.state.sessionId || JSON.stringify(document) !== JSON.stringify(inspected.state))
      failure("INVALID_GC_SESSION_ROOT");
  } else if (/^sessions\/by-id\/session-[a-f0-9-]{36}\/current\.json$/.test(relative)) {
    const sessionId = relative.split("/")[2];
    const state = withSessionRoute(root, sessionId, () => inspectProject(root).state);
    if (JSON.stringify(state) !== JSON.stringify(document)) failure("GC_SESSION_POINTER_DRIFT");
  } else if (sessionWorkPath(storage.directory + "/" + relative)) {
    const selection = sessionWorkPath(storage.directory + "/" + relative);
    const workOwner = readSessionWorkEvidenceOwner({ root, sessionId: selection.sessionId || inspected.state.sessionId, storage });
    readSessionWorkEvidenceOriginalFile(workOwner, selection.evidenceId);
  } else if (/^sessions\/runs\/run-[0-9]+-[a-f0-9]{6}\/run\.json$/.test(relative)) {
    if (document.runId !== relative.split("/")[2]) failure("GC_RUN_PATH_IDENTITY_MISMATCH");
    verifyRetainedRunOriginal({ root, run: document, storage });
  } else if (/^sessions\/records\/session-[a-f0-9-]{36}\.json$/.test(relative)) verifySessionRecord(document, { projectId, storage });
  else if (relative === "onboarding/current.json") verifyOnboardingState(document, { projectId, storage });
  else if (/^onboarding\/storage-selections\/onboarding-storage-[a-f0-9]{24}\.json$/.test(relative)) verifyStorageSelection(document, projectId, storage);
  else if (/^context\/capsules\/capsule-[a-f0-9]{24}\.json$/.test(relative)) readContextCapsule({ root, capsuleId: id });
  else if (/^change-sets\/records\/change-set-[a-f0-9]{24}\.json$/.test(relative)) readChangeSet({ root, changeSetId: id });
  else if (/^change-sets\/vcs-evidence\/vcs-evidence-[a-f0-9]{24}\.json$/.test(relative)) readVcsEvidence({ root, vcsEvidenceId: id });
  else if (relative === "change-sets/current.json")
    withSessionRoute(root, document.sessionId, () =>
      verifyChangeSetStatePointer(document, { ...inspected.project, sessionId: inspectProject(root).state.sessionId }, storage),
    );
  else if (/^change-sets\/impact-candidate-sets\/change-impact-candidates-[a-f0-9]{24}\.json$/.test(relative))
    readChangeImpactCandidateSet({ root, candidateSetId: id });
  else if (/^change-sets\/impact-review-decisions\/change-impact-review-decision-[a-f0-9]{24}\.json$/.test(relative))
    readChangeImpactReviewDecision({ root, reviewDecisionId: id });
  else if (
    /^lineage\/(?:whole-plans|execution-contracts|result-packets|review-decisions)\/(?:whole-plan|execution-contract|result-packet|review-decision)-[a-f0-9]{24}\.json$/.test(
      relative,
    )
  )
    readLineageArtifact({ root, artifactId: id });
  else if (/^sessions\/(?:by-id\/session-[a-f0-9-]{36}\/)?ledger\/checkpoint-[a-f0-9]{24}\.json$/.test(relative)) {
    const sessionId = relative.startsWith("sessions/by-id/") ? relative.split("/")[2] : inspected.state.sessionId;
    withSessionRoute(root, sessionId, () => readRecoveryCheckpoint({ root, checkpointId: id, historical: true, storage }));
  } else if (/^refresh\/requests\/(?:incremental-)?refresh-request-[a-f0-9]{24}\.json$/.test(relative)) verifyIncrementalRefreshRequest(document, storage);
  else if (/^refresh\/receipts\/(?:incremental-)?refresh-receipt-[a-f0-9]{24}\.json$/.test(relative)) verifyIncrementalRefreshReceipt(document, storage);
  else if (relative === "document-projection/post-refresh/current-policy.json") verifyPolicyPointer(document, storage);
  else if (relative === "document-projection/post-refresh/current.json") verifyReceiptPointer(document, storage);
  else if (/^document-projection\/post-refresh\/policies\/post-refresh-projection-policy-[a-f0-9]{24}\.json$/.test(relative))
    verifyPostRefreshProjectionPolicy(document, storage);
  else if (/^document-projection\/post-refresh\/receipts\/post-refresh-projection-receipt-[a-f0-9]{24}\.json$/.test(relative))
    verifyPostRefreshProjectionReceipt(document, storage);
  else if (relative === "refresh/current.json") verifyIncrementalRefreshPointer(document, storage);
  else if (relative === "generated/manifest.json") {
    if (document.schemaVersion !== 1 || !Array.isArray(document.managed)) failure("INVALID_GC_GENERATED_MANIFEST");
  } else if (relative === "generated/claude.mcp.json") {
    if (!document.mcpServers || typeof document.mcpServers !== "object") failure("INVALID_GC_GENERATED_CONFIG");
  } else if (relative === "generated/opencode.json") {
    if (!document.mcp || !Array.isArray(document.instructions)) failure("INVALID_GC_GENERATED_CONFIG");
  } else failure("UNSUPPORTED_GC_REFERENCE_ROOT");
}

// bookkeeping: the fields only a retention window or a release record needs
// (lineage ids and the record ids a current pointer names). Left out otherwise,
// so the reference summary costs what it cost before retention existed.
export function referenceSummary(document, { bookkeeping = true } = {}) {
  const encoded = JSON.stringify(document),
    requiredWorldHashes = new Set(),
    pins = [];
  const pending = [document];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    for (const field of ["repositoryWorldModel", "worldModelHash"]) if (/^[a-f0-9]{64}$/.test(value[field] || "")) requiredWorldHashes.add(value[field]);
    if (typeof value.path === "string" && typeof (value.sha256 || value.digest) === "string")
      pins.push({ path: value.path, byteLength: value.byteLength ?? null, sha256: value.sha256 || value.digest });
    pending.push(...Object.values(value).filter((child) => child && typeof child === "object"));
  }
  return {
    references: ids(encoded),
    ...(bookkeeping ? { ancestryIds: ancestryIdsOf(document), namedRecordIds: namedRecordIds(document) } : {}),
    digestReferences: [...new Set(encoded.match(/[a-f0-9]{64}/g) || [])],
    requiredWorldHashes: [...requiredWorldHashes],
    pins,
  };
}

// The folders storage GC knows how to read. Anything else is an issue, except
// a folder inside the product graph folder, which is the user's own.
const SUPPORTED_GC_DIRECTORY =
  /^(?:graph-discovery|context(?:\/capsules)?|generated|world-model(?:\/snapshots)?|graph-projection(?:\/snapshots)?|sessions(?:\/(?:records|ledger|work-evidence|runs(?:\/run-[0-9]+-[a-f0-9]{6})?|by-id(?:\/session-[a-f0-9-]{36}(?:\/(?:work-evidence|ledger))?)?))?|onboarding(?:\/storage-selections)?|roles|instructions|lineage(?:\/(?:whole-plans|execution-contracts|result-packets|review-decisions))?|change-sets(?:\/(?:records|vcs-evidence|impact-candidate-sets|impact-review-decisions))?|refresh(?:\/(?:requests|receipts|retention-releases))?|document-projection(?:\/post-refresh(?:\/(?:policies|receipts))?)?|observations(?:\/(?:source-bundles|descriptors|records(?:\/by-source-key)?|derived|receipts))?|context\/product-graph(?:\/(?:유저플로우 기획서|화면설계서|승인|확인|실행 기록|build))?)$/;

// What storage GC does with one path of the store (relative to the store
// directory). The apply's inventory and the dry run both ask this, so a file
// the apply keeps silently is never an issue in the preview, and the reverse.
//   directories: "walk", "skip" (coordination and mailbox folders), "operations",
//     "backend" (git snapshot store, bundle store), "user-kept" (a folder of the
//     user's own in the product graph folder), "unsupported";
//   files: "snapshot", "json-root", "text-root", "canon" (product graph Canon,
//     a text root), "ignore" (caches, generated product graph output, release
//     records, read on their own), "user-kept", "unsupported".
export function classifyGcStorePath(relative, { directory }) {
  const name = String(relative || "").replaceAll("\\", "/");
  const nfc = name.normalize("NFC");
  if (directory) {
    if (!name) return "walk";
    if (name === ".snapshot-gc" || name === "messaging") return "skip";
    if (name === ".operations") return "operations";
    if (name === "snapshot-objects.git" || name === "snapshot-bundles") return "backend";
    if (SUPPORTED_GC_DIRECTORY.test(nfc)) return "walk";
    if (nfc.startsWith(PRODUCT_GRAPH_DIRECTORY + "/")) return "user-kept";
    return "unsupported";
  }
  if (
    name === "graph-discovery/index.json" ||
    name === "refresh/file-stat-cache.json" ||
    name === "refresh/input-generation.json" ||
    name === SNAPSHOT_RETENTION_RELATIVE ||
    name.startsWith("refresh/.watch-arm-") ||
    name.startsWith(RETENTION_RELEASE_DIRECTORY + "/")
  )
    return "ignore";
  if (nfc.startsWith(PRODUCT_GRAPH_DIRECTORY + "/")) {
    const target = classifyProductGraphPath(nfc.slice(PRODUCT_GRAPH_DIRECTORY.length + 1));
    if (target?.role === "build") return "ignore";
    return target?.canon ? "canon" : "user-kept";
  }
  if (target.test(name)) return "snapshot";
  if (name.endsWith(".json")) return "json-root";
  if (name === ".gitignore" || /^(?:instructions\/project|generated\/(?:head|lode)-instructions|roles\/(?:head|lode|developer|coder|reviewer))\.md$/.test(name))
    return "text-root";
  return "unsupported";
}

function newInventory({ root, storage, owner, maxSummaryBytes, checkContinue, bookkeeping }) {
  const inventory = {
    bookkeeping,
    root,
    storage,
    owner,
    base: path.join(root, storage.directory),
    maxSummaryBytes,
    checkContinue,
    entries: [],
    snapshots: [],
    roots: [],
    issues: [],
    productGraphKept: [],
    storedBytes: 0,
    decodedBytes: 0,
    summaryBytes: 0,
    scannedEntries: 0,
    omittedIssues: 0,
  };
  inventory.issue = (relative, reasonCode) => {
    if (inventory.issues.length < 200) inventory.issues.push({ path: relative, reasonCode });
    else inventory.omittedIssues += 1;
  };
  return inventory;
}

// One walk over the store, shared by the apply (which yields to the event loop
// at every file) and the windowed dry run (which runs it straight through).
// It yields once after each file it read.
function* inventoryWalk(inventory, relative = "") {
  const { root, base, storage, owner, issue } = inventory;
  inventory.checkContinue();
  if (++inventory.scannedEntries > 50_000) failure("GC_INVENTORY_INCOMPLETE");
  const file = safeSnapshotPath(root, path.join(base, relative)),
    stat = fs.lstatSync(file);
  // Release records (and a staging leftover of one) are checked by their own
  // reader, which knows the hard-link pair an interrupted create can leave.
  if (!stat.isDirectory() && !stat.isSymbolicLink() && relative.startsWith(RETENTION_RELEASE_DIRECTORY + "/")) {
    inventory.storedBytes += stat.size;
    return;
  }
  if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) failure("UNSAFE_GC_STORAGE_ENTRY");
  if (stat.isDirectory()) {
    const kind = classifyGcStorePath(relative, { directory: true });
    if (kind === "skip" || kind === "backend") return;
    if (kind === "operations") {
      if (fs.readdirSync(file).length) issue(relative, "ACTIVE_OR_UNKNOWN_WRITER");
      return;
    }
    // The product graph folder is written by hand: a folder Lode does not
    // recognise there is the user's own. Kept, never walked or deleted, and
    // not an issue. Links never reach here (rejected above).
    if (kind === "user-kept") {
      inventory.productGraphKept.push({ path: storage.directory + "/" + relative, kind: "folder" });
      return;
    }
    if (kind === "unsupported") {
      issue(relative, "UNSUPPORTED_GC_STORAGE_DIRECTORY");
      return;
    }
    for (const name of fs.readdirSync(file).sort()) yield* inventoryWalk(inventory, relative ? relative + "/" + name : name);
    return;
  }
  if (
    (relative.startsWith("observations/source-bundles/") && stat.size > 16 * 1024 * 1024) ||
    (/^observations\/(?:descriptors|records|derived|receipts)\//.test(relative) && stat.size > 1024 * 1024)
  )
    failure("OBSERVATION_STORE_LIMIT");
  if ((inventory.storedBytes += stat.size) > 1024 ** 3) failure("GC_INVENTORY_INCOMPLETE");
  // Caches, generated product graph output and release records are not roots.
  // Product graph Canon files are read as verified text roots, so a snapshot id
  // written in a document still retains that snapshot. A name Lode does not
  // recognise there is the user's own: kept, not read, not a root, not an issue.
  const kind = classifyGcStorePath(relative, { directory: false });
  if (kind === "ignore") return;
  if (kind === "user-kept") {
    inventory.productGraphKept.push({ path: storage.directory + "/" + relative, kind: "file" });
    return;
  }
  const productGraphPath = kind === "canon" ? relative.slice(PRODUCT_GRAPH_DIRECTORY.length + 1).normalize("NFC") : null;
  const productGraphTarget = kind === "canon" ? { canon: true } : null;
  const exact = fs.lstatSync(file, { bigint: true }),
    before = snapshotFileIdentity(exact),
    match = target.exec(relative);
  if (match && (exact.ino < 1n || exact.dev < 0n)) failure("GC_FILESYSTEM_IDENTITY_UNAVAILABLE");
  if (!file.endsWith(".json.gz") && stat.size > 512 * 1024 * 1024) failure("SNAPSHOT_STORAGE_LIMIT");
  let accounted = 0;
  const read = match
    ? readSnapshotFile(file, {
        decodedBytes: 512 * 1024 * 1024,
        onDecodedBytes: (length) => {
          accounted = length;
        },
      })
    : { bytes: fs.readFileSync(file) };
  inventory.decodedBytes += accounted || read.bytes.length;
  if (!sameSnapshotFileIdentity(before, snapshotFileIdentity(fs.lstatSync(file, { bigint: true })))) failure("GC_INVENTORY_DRIFT");
  let document = read.document;
  if (!match) {
    if (productGraphTarget?.canon) {
      try {
        verifyProductGraphCanonFile(productGraphPath, read.bytes, { projectId: owner.projectId });
      } catch (error) {
        issue(storage.directory + "/" + relative, error.code || "GC_ORIGINAL_VERIFICATION_FAILED");
        return;
      }
      document = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
    } else if (kind === "json-root") document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes));
    else if (kind === "text-root") document = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
    else {
      issue(relative, "UNSUPPORTED_GC_REFERENCE_ROOT");
      return;
    }
  }
  const entry = {
    file,
    path: storage.directory + "/" + relative,
    relative,
    bytes: read.bytes.length,
    sha256: hash(read.bytes),
    identity: before,
    ...(inventory.bookkeeping && match ? { mtimeMs: stat.mtimeMs } : {}),
  };
  let retainedRow = null;
  try {
    if (match) {
      const hydrated = hydrateSnapshotEntry({ root, storage, entry: { document } });
      document = hydrated.document;
      const summary = referenceSummary(document, inventory);
      const original = match[2].startsWith("world-model-")
        ? verifyWorldModelSnapshotOriginal({ document, worldModelId: match[2], storage })
        : verifyTemporalProvenanceGraph(document);
      if (original.projectId !== owner.projectId || (original.worldModelId || original.graphSnapshotId) !== match[2]) failure("GC_SNAPSHOT_IDENTITY_MISMATCH");
      const graph = original.temporalProvenanceGraph;
      retainedRow = {
        ...entry,
        ...summary,
        dependencies: hydrated.snapshotStorage?.dependencies || [],
        id: match[2],
        identityIds: [match[2], original.sourceSnapshotId, graph?.sourceSnapshotId, graph?.graphSnapshotId].filter(Boolean),
        worldModelHash: original.worldModelHash || null,
        graphSnapshotHash: original.graphSnapshotHash || graph?.graphSnapshotHash || null,
      };
    } else {
      const summary = referenceSummary(document, inventory);
      if (typeof document !== "string") verifyRoot(relative, document, owner);
      retainedRow = { ...entry, ...summary };
    }
  } catch (error) {
    issue(entry.path, error.code || "GC_ORIGINAL_VERIFICATION_FAILED");
  }
  const nextSummaryBytes = inventory.summaryBytes + Buffer.byteLength(JSON.stringify(retainedRow || entry));
  if (nextSummaryBytes > inventory.maxSummaryBytes) failure("GC_REFERENCE_SUMMARY_LIMIT");
  inventory.summaryBytes = nextSummaryBytes;
  inventory.entries.push(entry);
  if (retainedRow) {
    if (match) inventory.snapshots.push(retainedRow);
    else inventory.roots.push(retainedRow);
  }
  // The decoded body and buffer do not enter the retained inventory.
  yield;
}

function checkObservationLineage(owner) {
  for (const [id, record] of owner.observationIds || [])
    if (JSON.stringify(record) !== JSON.stringify(owner.observationReceipts?.get(id))) failure("OBSERVATION_RECEIPT_MISSING");
  for (const [id, record] of owner.observationReceipts || [])
    if (JSON.stringify(record) !== JSON.stringify(owner.observationIds?.get(id))) failure("INVALID_OBSERVATION_RECEIPT_LINEAGE");
  for (const input of owner.observationInputs || [])
    if (owner.observationIds?.get(input.id)?.observationHash !== input.hash) failure("DERIVED_OBSERVATION_INPUT_MISMATCH");
}

// The rule each candidate goes under: "unreferenced" when no root and no other
// snapshot names it, "outside-retention-window" when something in history
// still names it and only the window releases it.
function releaseRules(candidates, snapshots, roots, windowed) {
  const named = new Set();
  for (const root of roots) for (const id of root.references || []) named.add(id);
  for (const row of snapshots) {
    const own = new Set(row.identityIds || []);
    for (const id of row.references || []) if (!own.has(id)) named.add(id);
  }
  return new Map(
    candidates.map((row) => [row.path, windowed && (row.identityIds || [row.id]).some((id) => named.has(id)) ? "outside-retention-window" : "unreferenced"]),
  );
}

const physicalPathKey = (value) => (process.platform === "win32" ? value.toLowerCase() : value);

// Which snapshots stay, from the inventoried rows and roots and the retention
// decision. The apply and the windowed dry run both call this, so a preview
// names exactly what the apply deletes from the rows it can see. `deferred`
// lets the dry run, which does not open the git snapshot store or the bundle
// store, leave an id or a byte pin that may live there unjudged instead of
// calling it missing.
export function selectRetainedClosure({
  snapshots,
  roots,
  decision,
  files = [],
  objects = new Map(),
  domains = new Map(),
  issue,
  deferred = null,
  released = new Map(),
}) {
  const byId = new Map(),
    byHash = new Map(),
    byPath = new Map(files.map((row) => [physicalPathKey(row.path), row])),
    seenIds = new Set();
  for (const row of snapshots) {
    if (seenIds.has(row.id)) issue(row.path, "SNAPSHOT_REPRESENTATION_CONFLICT");
    seenIds.add(row.id);
    for (const id of row.identityIds) {
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(row);
    }
    for (const digest of [row.worldModelHash, row.graphSnapshotHash].filter(Boolean)) {
      if (!byHash.has(digest)) byHash.set(digest, []);
      byHash.get(digest).push(row);
    }
  }
  const retained = new Set(),
    queue = [],
    pinnedOids = new Set(),
    pinnedPaths = new Set();
  const retain = (row) => {
    if (!retained.has(row.path)) {
      retained.add(row.path);
      queue.push(row);
    }
  };
  // A reference that history makes to an id a verified release record names is
  // released, not missing. History is an older refresh receipt or request or a
  // post-refresh receipt (not the ones the current pointers name), or a stored
  // snapshot's own lineage ids (its parents). A World named by hash is released
  // only when the record carries that hash. Any other missing reference, from a
  // current pointer, a pin record or a snapshot's own content, stays an issue.
  const protectedPaths = decision.protectedPaths || currentRecordPaths(roots);
  const releasedReferences = [];
  const missing = (summary, id, reasonCode, digest = null) => {
    // A release record names only snapshots the apply unlinked, so such an id
    // is judged even where the preview cannot see a backend; any other id that
    // may live in an unopened backend is left to the apply.
    // A record whose snapshot is still stored (an unlink that failed after the
    // record was written) does not count: that snapshot is present.
    const listed = released.get(id);
    const release = listed && !byId.has(listed.snapshotId) ? listed : null;
    if (!release && deferred?.id(id)) return;
    const rootPath = summary.relative || summary.path;
    const verdict = judgeMissingReference({
      release,
      digest,
      fromRoot: !summary.id,
      current: !summary.id && (isCurrentPointerRoot(rootPath) || protectedPaths.has(rootPath)),
      lineage: !summary.id && (summary.ancestryIds || []).includes(id),
      history: summary.id ? (summary.ancestryIds || []).includes(id) : isHistoryRoot(summary.relative || summary.path, protectedPaths),
    });
    if (verdict === "missing") issue(summary.path, reasonCode);
    else releasedReferences.push({ kind: verdict, path: summary.path, id, releasedAt: release.releasedAt, releaseId: release.releaseId, record: release.path });
  };
  const windowed = !decision.preserveAllHistory;
  const selected = (id) =>
    !windowed ||
    decision.keepIds.has(id) ||
    (byId.get(id) || []).some((row) => decision.keepIds.has(row.id) || (row.identityIds || []).some((item) => decision.keepIds.has(item)));
  function follow(summary) {
    const ancestry = new Set(summary.ancestryIds || []);
    const history = isHistoryRoot(summary.relative || summary.path, decision.protectedPaths);
    for (const id of summary.references || []) {
      // Under a window a parent link only orders history: a parent is released
      // with the rest of its window. A parent a current pointer names is hard
      // and is followed like any other reference.
      if (windowed && ancestry.has(id) && !decision.hardIds.has(id)) continue;
      const matches = byId.get(id);
      if (windowed && !selected(id)) {
        if (!matches?.length && decision.hardIds.has(id) && !history) missing(summary, id, "RETAINED_SNAPSHOT_REFERENCE_UNAVAILABLE");
        continue;
      }
      if (!matches?.length) missing(summary, id, "RETAINED_SNAPSHOT_REFERENCE_UNAVAILABLE");
      else matches.forEach(retain);
    }
    const pinContents = !windowed || !summary.id || selected(summary.id) || (summary.identityIds || []).some((id) => selected(id)) || (!history && !summary.id);
    if (pinContents)
      for (const digest of summary.digestReferences || []) {
        // A record outside history that names a snapshot by its hash keeps it.
        if (!windowed || !history) (byHash.get(digest) || []).forEach(retain);
        else for (const row of byHash.get(digest) || []) if (selected(row.id)) retain(row);
        if (objects.has(digest)) pinnedOids.add(digest);
        for (const row of domains.values()) if (row.rawSha256 === digest) pinnedPaths.add(row.path);
      }
    for (const digest of summary.requiredWorldHashes || []) {
      const id = "world-model-" + digest.slice(0, 24);
      const matches = (byId.get(id) || []).filter((row) => row.worldModelHash === digest);
      if (windowed && !selected(id)) {
        if (!matches.length && decision.hardIds.has(id)) missing(summary, id, "RETAINED_WORLD_HASH_UNAVAILABLE", digest);
        continue;
      }
      if (!matches.length) missing(summary, id, "RETAINED_WORLD_HASH_UNAVAILABLE", digest);
      else matches.forEach(retain);
    }
    for (const pin of summary.pins || []) {
      if (!/\/(?:(?:world-model|graph-projection)\/snapshots\/|snapshot-bundles\/|snapshot-objects\.git\/|observations\/source-bundles\/)/i.test(pin.path))
        continue;
      const row = byPath.get(physicalPathKey(pin.path));
      if (!row && deferred?.path(pin.path)) continue;
      if (!row || (pin.byteLength !== null && row.bytes !== pin.byteLength) || row.sha256 !== pin.sha256)
        issue(summary.path, "HISTORICAL_BYTE_REFERENCE_UNAVAILABLE");
      if (row) {
        pinnedPaths.add(row.path);
        const snapshot = snapshots.find((item) => item.path === row.path);
        if (snapshot && (!windowed || selected(snapshot.id))) retain(snapshot);
      }
    }
  }
  for (const summary of roots) {
    if (windowed && isHistoryRoot(summary.relative || summary.path, decision.protectedPaths)) continue;
    follow(summary);
  }
  if (windowed) for (const row of snapshots) if (selected(row.id)) retain(row);
  for (let index = 0; index < queue.length; index += 1) follow(queue[index]);
  return { retained, pinnedOids, pinnedPaths, releasedReferences };
}

// The windowed dry run: the apply's own walk, root readers and selection,
// without opening the git snapshot store or the bundle store and without
// writing. Rows that live in those stores are not seen here; an id or a pin
// that may live there is left to the apply instead of being called missing.
export function observeSnapshotRetentionClosure({ root, retention = null, gitStoreNamesSnapshot = () => false, deferredBackends = [] } = {}) {
  const inspected = inspectProject(root, { sessionScope: "default" }),
    storage = inspected.storage;
  if (!storage?.projectFile || !inspected.project || !inspected.state) failure("GC_PROJECT_UNAVAILABLE");
  root = inspected.project.projectRoot;
  const owner = { root, projectId: inspected.project.projectId, storage, inspected };
  const releases = readRetentionReleases({ root, storage, projectId: owner.projectId });
  const retentionPolicy = resolveSnapshotRetentionPolicy({ root, storage, override: retention });
  const inventory = newInventory({
    root,
    storage,
    owner,
    maxSummaryBytes: SNAPSHOT_GC_SUMMARY_BYTES,
    checkContinue: () => {},
    bookkeeping: !retentionPolicy.preserveAllHistory || releases.records.length > 0 || releases.problems.length > 0,
  });
  try {
    for (const step of inventoryWalk(inventory)) void step;
    checkObservationLineage(owner);
  } catch (error) {
    inventory.issue(storage.directory, error.code || "GC_INVENTORY_UNREADABLE");
  }
  for (const problem of releases.problems) inventory.issue(problem.path, problem.reasonCode);
  // The apply refuses a store whose pointers need a newer reader; so does the
  // preview. (Filesystem qualification and an active collection are checked
  // only by the apply; the preview says so.)
  try {
    const compatibility = inspectStorageReaderCompatibility({
      root,
      storage,
      verifyWorldPointer: (pointer) => verifyWorldModelPointerOriginal(pointer, owner.projectId),
      verifyGraphPointer: (pointer) => verifyGraphProjectionPointer(pointer, null, storage),
    });
    const mismatch = compatibility.layers.find((layer) => ["STORAGE_VERSION_MISMATCH", "INVALID_READER_REQUIREMENTS"].includes(layer.reasonCode));
    if (mismatch) inventory.issue(storage.directory, mismatch.reasonCode);
  } catch (error) {
    if (error.code === "STORAGE_VERSION_MISMATCH") inventory.issue(storage.directory, error.code);
  }
  const decision = selectRetainedSnapshotIds({ snapshots: inventory.snapshots, roots: inventory.roots, policy: retentionPolicy });
  const backendPrefixes = deferredBackends.map((item) => item.replaceAll("\\", "/") + "/");
  const { retained, releasedReferences } = selectRetainedClosure({
    snapshots: inventory.snapshots,
    roots: inventory.roots,
    decision,
    files: inventory.entries,
    issue: inventory.issue,
    released: releases.released,
    deferred: {
      id: (id) => (/^(?:world-model|graph-snapshot)-[a-f0-9]{24}$/.test(id) ? gitStoreNamesSnapshot(id) : deferredBackends.length > 0),
      path: (pinPath) => backendPrefixes.some((prefix) => String(pinPath).replaceAll("\\", "/").startsWith(prefix)),
    },
  });
  const candidates = inventory.issues.length ? [] : inventory.snapshots.filter((row) => !retained.has(row.path));
  return {
    snapshots: inventory.snapshots,
    retained,
    issues: inventory.issues,
    omittedIssues: inventory.omittedIssues,
    candidates,
    releaseRules: releaseRules(
      inventory.snapshots.filter((row) => !retained.has(row.path)),
      inventory.snapshots,
      inventory.roots,
      !decision.preserveAllHistory,
    ),
    retentionPolicy,
    decision,
    releasedReferences,
    releaseRecords: releases.records,
  };
}

export async function buildSnapshotDeletionClosure({
  root,
  maxSummaryBytes = SNAPSHOT_GC_SUMMARY_BYTES,
  shouldContinue = () => true,
  signal,
  onProcess,
  deadline,
  collectionAttempt,
  retention = null,
} = {}) {
  if (!Number.isSafeInteger(maxSummaryBytes) || maxSummaryBytes < 1 || maxSummaryBytes > SNAPSHOT_GC_SUMMARY_BYTES) failure("INVALID_GC_SUMMARY_BOUND");
  const inspected = inspectProject(root, { sessionScope: "default" }),
    storage = inspected.storage;
  if (!storage?.projectFile || !inspected.project || !inspected.state) failure("GC_PROJECT_UNAVAILABLE");
  root = inspected.project.projectRoot;
  const owner = { root, projectId: inspected.project.projectId, storage, inspected };
  const mixed = new SnapshotBackendReclamation({ root, storage, signal, onProcess, deadline, shouldContinue, collectionAttempt });
  let interrupted = false;
  const checkContinue = () => {
    if (deadline != null && Date.now() >= deadline) failure("SNAPSHOT_GIT_TIMEOUT");
    if (!shouldContinue()) {
      interrupted = true;
      failure("SNAPSHOT_COLLECTION_INVALIDATED");
    }
  };
  const releases = readRetentionReleases({ root, storage, projectId: owner.projectId });
  const retentionPolicy = resolveSnapshotRetentionPolicy({ root, storage, override: retention });
  const inventory = newInventory({
    root,
    storage,
    owner,
    maxSummaryBytes,
    checkContinue,
    bookkeeping: !retentionPolicy.preserveAllHistory || releases.records.length > 0 || releases.problems.length > 0,
  });
  const { entries, snapshots, roots, issue } = inventory;
  try {
    await mixed.inventoryDomains();
    // Yield between files so a same-process ordinary operation can cancel this scan.
    for (const step of inventoryWalk(inventory)) {
      void step;
      await new Promise((resolve) => setImmediate(resolve));
      checkContinue();
    }
    checkObservationLineage(owner);
    for await (const row of mixed.inventoryGit()) {
      checkContinue();
      const document = row.document;
      const original = row.id.startsWith("world-model-")
        ? verifyWorldModelSnapshotOriginal({ document, worldModelId: row.id, storage })
        : verifyTemporalProvenanceGraph(document);
      if (original.projectId !== owner.projectId) failure("GC_SNAPSHOT_IDENTITY_MISMATCH");
      const graph = original.temporalProvenanceGraph,
        { document: unused, ...physical } = row;
      const summary = referenceSummary(original, inventory),
        retainedRow = {
          ...physical,
          ...summary,
          identityIds: [row.id, original.sourceSnapshotId, graph?.sourceSnapshotId, graph?.graphSnapshotId].filter(Boolean),
          worldModelHash: original.worldModelHash || null,
          graphSnapshotHash: original.graphSnapshotHash || graph?.graphSnapshotHash || null,
        };
      inventory.summaryBytes += Buffer.byteLength(JSON.stringify(retainedRow));
      if (inventory.summaryBytes > maxSummaryBytes) failure("GC_REFERENCE_SUMMARY_LIMIT");
      snapshots.push(retainedRow);
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (inventory.storedBytes + mixed.storedBytes > 1024 ** 3 || inventory.scannedEntries + mixed.entryCount > 50000) failure("GC_INVENTORY_INCOMPLETE");
    const extraSummary = Buffer.byteLength(JSON.stringify({ objects: [...mixed.objects.values()], domains: [...mixed.domains.values()] }));
    inventory.summaryBytes += extraSummary;
    if (inventory.summaryBytes > maxSummaryBytes) failure("GC_REFERENCE_SUMMARY_LIMIT");
  } catch (error) {
    issue(storage.directory, error.code || "GC_INVENTORY_UNREADABLE");
  }
  for (const problem of releases.problems) issue(problem.path, problem.reasonCode);
  const decision = selectRetainedSnapshotIds({ snapshots, roots, policy: retentionPolicy });
  const { retained, pinnedOids, pinnedPaths, releasedReferences } = selectRetainedClosure({
    snapshots,
    roots,
    decision,
    files: [...entries, ...mixed.files.values()],
    objects: mixed.objects,
    domains: mixed.domains,
    issue,
    released: releases.released,
  });
  try {
    for (const oid of [...pinnedOids])
      if (mixed.objects.get(oid)?.type === "tree") {
        const listing = (await mixed.store.invoke(["ls-tree", oid], mixed.context, { maxBytes: 4096 })).toString("ascii").trim().split("\n");
        if (listing.length !== 2) failure("UNSUPPORTED_GC_GIT_TREE");
        for (const line of listing) {
          const match = /^100644 blob ([a-f0-9]{64})\t(?:metadata.json|snapshot.json)$/.exec(line);
          if (!match || !mixed.objects.has(match[1])) failure("UNSUPPORTED_GC_GIT_TREE");
          pinnedOids.add(match[1]);
        }
      }
  } catch (error) {
    issue(storage.directory, error.code || "INVALID_GC_GIT_PIN");
  }
  const { issues } = inventory;
  const candidates = issues.length ? [] : snapshots.filter((row) => !retained.has(row.path));
  return {
    owner,
    entries,
    snapshots,
    retained,
    interrupted,
    decodedBytes: inventory.decodedBytes + mixed.decodedBytes,
    summaryBytes: inventory.summaryBytes,
    maxSummaryBytes,
    mixed,
    pinnedOids,
    pinnedPaths,
    candidates,
    releaseRules: releaseRules(candidates, snapshots, roots, !decision.preserveAllHistory),
    releasedReferences,
    releaseRecords: releases.records,
    releaseStaging: releases.staging,
    // The inventoried roots (reference summaries only), for diagnostics and tests.
    roots,
    issues,
    omittedIssues: inventory.omittedIssues,
    // Files and folders in the product graph folder that Lode does not
    // recognise: the user's own, kept and named, never deleted.
    productGraphKept: inventory.productGraphKept.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    certified: issues.length === 0,
    retentionPolicy,
    backend: "typed-local-file-git-domain-source",
    basisDigest: hash(JSON.stringify([...entries, ...mixed.files.values()].map(({ path, sha256 }) => ({ path, sha256 })))),
  };
}

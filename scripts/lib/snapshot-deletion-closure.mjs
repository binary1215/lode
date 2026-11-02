import { SnapshotBackendReclamation } from "./snapshot-backend-reclamation.mjs";
import { hydrateSnapshotEntry } from "./snapshot-domain-bundles.mjs";
import { readSourceObservationOriginal, readSourceFailure } from "./source-observation.mjs";
import { verifyObservationTypeDescriptor, verifyObservationRecord, verifyDerivedObservationRecord, observationDigest } from "./observation-contract.mjs";
import { verifyObservationCollectionReceipt } from "./observation-store.mjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { inspectProject } from "./lode-core.mjs";
import { safeSnapshotPath, readSnapshotFile } from "./snapshot-storage-codec.mjs";
import { verifyWorldModelPointerOriginal, verifyWorldModelSnapshotOriginal } from "./world-model.mjs";
import { verifyTemporalProvenanceGraph } from "./temporal-provenance.mjs";
import { verifyGraphProjectionPointer } from "./graph-projection-adapter.mjs";
import { normalizeProductModelDocument } from "./product-model.mjs";
import { readContextCapsule } from "./context-compiler.mjs";
import { readChangeSet, readVcsEvidence, readChangeImpactCandidateSet, readChangeImpactReviewDecision, verifyChangeSetStatePointer } from "./change-set.mjs";
import { readLineageArtifact } from "./execution-lineage.mjs";
import { readRecoveryCheckpoint } from "./compaction-recovery.mjs";
import { verifySessionRecord, verifyOnboardingState, verifyStorageSelection } from "./onboarding-contract.mjs";
import { verifyIncrementalRefreshRequest, verifyIncrementalRefreshReceipt, verifyIncrementalRefreshPointer } from "./incremental-refresh.mjs";
import { withSessionRoute } from "./session-routing.mjs";
import { readSessionWorkEvidenceOwner } from "./session-work-context.mjs";
import { sessionWorkPath, readSessionWorkEvidenceOriginalFile } from "./session-work-evidence-original.mjs";
import { verifyRetainedRunOriginal } from "./run-lineage.mjs";

const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const ids = value => [...new Set(JSON.stringify(value).match(/\b(?:world-model|graph-snapshot|source-snapshot)-[a-f0-9]{24}\b/g) || [])];
const target = /^(world-model|graph-projection)\/snapshots\/((?:world-model|graph-snapshot)-[a-f0-9]{24})\.json(?:\.gz)?$/;
const failure = code => { throw Object.assign(new Error(code), { code }); };
// Encoded reference-summary bound, not total V8 RSS or a Context budget.
export const SNAPSHOT_GC_SUMMARY_BYTES = 64 * 1024 * 1024;
export const snapshotFileIdentity = stat => ({ dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size),
  mtime: String(stat.mtimeNs ?? stat.mtimeMs), ctime: String(stat.ctimeNs ?? stat.ctimeMs), birthtime: String(stat.birthtimeNs ?? stat.birthtimeMs) });
export const sameSnapshotFileIdentity = (left, right) => Object.keys(left).every(key => left[key] === right[key]);

// This is a closed reader/path registry, not "valid JSON means no references".
// Unknown families preserve the entire candidate set. Positive opaque IDs may
// retain extra files, but string absence alone never certifies deletion.
function verifyRoot(relative, document, owner) {
  const { root, projectId, storage, inspected } = owner;
  const id = path.basename(relative, ".json");
  if (document?.schemaVersion !== undefined && document.schemaVersion !== 1
    && !(relative === "context/product-model.json" && document.schemaVersion === 2)) failure("UNSUPPORTED_GC_ROOT_SCHEMA");
  if (document?.projectId && document.projectId !== projectId) failure("GC_ROOT_PROJECT_MISMATCH");
  if (/^observations\/source-bundles\/[a-f0-9]{64}\.json$/.test(relative)) {
    const key=path.basename(relative,".json");
    if(document.failure ? Object.keys(document).length!==1||document.failure.version!==1 : JSON.stringify(Object.keys(document).sort())!==JSON.stringify(["descriptor","evidence","observation"])||![1,2].includes(document.evidence?.version))failure("UNSUPPORTED_GC_SOURCE_SCHEMA");
    if(document.failure)readSourceFailure(root,projectId,key,storage);else readSourceObservationOriginal(root,projectId,key,{storage,requireCurrent:false});
    return;
  }
  if (/^observations\/(?:descriptors|records\/by-source-key|derived|receipts)\/[^/]+\.json$/.test(relative)) {
    if(!relative.endsWith(".json"))failure("INVALID_GC_OBSERVATION_ROOT");
    const getDescriptor=()=>{
      if(!/^observation-type-[a-f0-9]{24}$/.test(document.descriptorId||""))failure("UNKNOWN_OBSERVATION_DESCRIPTOR");
      const file=safeSnapshotPath(root,path.join(root,storage.directory,"observations/descriptors",document.descriptorId+".json")),stat=fs.lstatSync(file);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>1024*1024)failure("OBSERVATION_STORE_LIMIT");
      const descriptor=JSON.parse(fs.readFileSync(file,"utf8"));verifyObservationTypeDescriptor(descriptor,storage);
      if(descriptor.descriptorId!==document.descriptorId)failure("UNKNOWN_OBSERVATION_DESCRIPTOR");return descriptor;
    };
    owner.observationIds??=new Map();owner.observationReceipts??=new Map();owner.observationInputs??=[];
    if(relative.startsWith("observations/descriptors/")){
      verifyObservationTypeDescriptor(document,storage);if(id!==document.descriptorId)failure("INVALID_GC_OBSERVATION_ROOT");
    }else if(relative.startsWith("observations/records/by-source-key/")){
      verifyObservationRecord(document,getDescriptor(),projectId,storage);
      const source=document.source,replay=observationDigest({adapterKey:source.adapterKey,adapterVersion:source.adapterVersion,sourceScopeDigest:source.sourceScopeDigest,sourceEventKeyDigest:source.sourceEventKeyDigest});
      if(id!==replay&&id!==source.sourceEventKeyDigest)failure("INVALID_GC_OBSERVATION_ROOT");
      if(owner.observationIds.has(document.observationId))failure("DUPLICATE_OBSERVATION_RECORD");
      owner.observationIds.set(document.observationId,{observationHash:document.observationHash,descriptorId:document.descriptorId,protocol:document.protocol.name});
    }else if(relative.startsWith("observations/derived/")){
      verifyDerivedObservationRecord(document,getDescriptor(),projectId,storage);if(id!==document.derivedObservationId)failure("INVALID_GC_OBSERVATION_ROOT");
      for(const input of document.inputObservations)owner.observationInputs.push({id:input.observationId,hash:input.observationHash});
    }else{
      verifyObservationCollectionReceipt(document,projectId,storage);if(id!==document.receiptId)failure("INVALID_GC_OBSERVATION_ROOT");
      if(owner.observationReceipts.has(document.observationId))failure("DUPLICATE_OBSERVATION_RECEIPT");
      owner.observationReceipts.set(document.observationId,{observationHash:document.observationHash,descriptorId:document.descriptorId,protocol:document.protocol.name});
    }
    return;
  }
  if (relative === "project.json") {
    if (JSON.stringify(document) !== JSON.stringify(inspected.project)) failure("GC_PROJECT_ROOT_DRIFT");
  } else if (relative === "context/product-model.json") normalizeProductModelDocument(document, storage);
  else if (relative === "context/knowledge.json") {
    if (document.schemaVersion !== 1 || ["evidence", "claims", "decisions", "unknowns"].some(key => !Array.isArray(document[key]))) failure("INVALID_GC_KNOWLEDGE_ROOT");
  } else if (relative === "world-model/current.json") verifyWorldModelPointerOriginal(document, projectId);
  else if (relative === "graph-projection/current.json") verifyGraphProjectionPointer(document, null, storage);
  else if (relative === "sessions/current.json") {
    if (document.schemaVersion !== 1 || document.sessionId !== inspected.state.sessionId
      || JSON.stringify(document) !== JSON.stringify(inspected.state)) failure("INVALID_GC_SESSION_ROOT");
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
  else if (relative === "change-sets/current.json") withSessionRoute(root, document.sessionId, () => verifyChangeSetStatePointer(document, { ...inspected.project, sessionId: inspectProject(root).state.sessionId }, storage));
  else if (/^change-sets\/impact-candidate-sets\/change-impact-candidates-[a-f0-9]{24}\.json$/.test(relative)) readChangeImpactCandidateSet({ root, candidateSetId: id });
  else if (/^change-sets\/impact-review-decisions\/change-impact-review-decision-[a-f0-9]{24}\.json$/.test(relative)) readChangeImpactReviewDecision({ root, reviewDecisionId: id });
  else if (/^lineage\/(?:whole-plans|execution-contracts|result-packets|review-decisions)\/(?:whole-plan|execution-contract|result-packet|review-decision)-[a-f0-9]{24}\.json$/.test(relative)) readLineageArtifact({ root, artifactId: id });
  else if (/^sessions\/(?:by-id\/session-[a-f0-9-]{36}\/)?ledger\/checkpoint-[a-f0-9]{24}\.json$/.test(relative)) {
    const sessionId = relative.startsWith("sessions/by-id/") ? relative.split("/")[2] : inspected.state.sessionId;
    withSessionRoute(root, sessionId, () => readRecoveryCheckpoint({ root, checkpointId: id, historical: true, storage }));
  }
  else if (/^refresh\/requests\/refresh-request-[a-f0-9]{24}\.json$/.test(relative)) verifyIncrementalRefreshRequest(document, storage);
  else if (/^refresh\/receipts\/refresh-receipt-[a-f0-9]{24}\.json$/.test(relative)) verifyIncrementalRefreshReceipt(document, storage);
  else if (relative === "refresh/current.json") verifyIncrementalRefreshPointer(document, storage);
  else if (relative === "generated/manifest.json") {
    if (document.schemaVersion !== 1 || !Array.isArray(document.managed)) failure("INVALID_GC_GENERATED_MANIFEST");
  } else if (relative === "generated/claude.mcp.json") {
    if (!document.mcpServers || typeof document.mcpServers !== "object") failure("INVALID_GC_GENERATED_CONFIG");
  } else if (relative === "generated/opencode.json") {
    if (!document.mcp || !Array.isArray(document.instructions)) failure("INVALID_GC_GENERATED_CONFIG");
  } else failure("UNSUPPORTED_GC_REFERENCE_ROOT");
}

function referenceSummary(document) {
  const encoded = JSON.stringify(document), requiredWorldHashes = new Set(), pins = [];
  const pending = [document];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    for (const field of ["repositoryWorldModel", "worldModelHash"]) if (/^[a-f0-9]{64}$/.test(value[field] || "")) requiredWorldHashes.add(value[field]);
    if (typeof value.path === "string" && typeof (value.sha256 || value.digest) === "string") pins.push({ path: value.path, byteLength: value.byteLength ?? null, sha256: value.sha256 || value.digest });
    pending.push(...Object.values(value).filter(child => child && typeof child === "object"));
  }
  return { references: ids(document), digestReferences: [...new Set(encoded.match(/[a-f0-9]{64}/g) || [])], requiredWorldHashes: [...requiredWorldHashes], pins };
}

export async function buildSnapshotDeletionClosure({ root, maxSummaryBytes = SNAPSHOT_GC_SUMMARY_BYTES, shouldContinue = () => true, signal, onProcess, deadline, collectionAttempt } = {}) {
  if (!Number.isSafeInteger(maxSummaryBytes) || maxSummaryBytes < 1 || maxSummaryBytes > SNAPSHOT_GC_SUMMARY_BYTES) failure("INVALID_GC_SUMMARY_BOUND");
  const inspected = inspectProject(root, { sessionScope: "default" }), storage = inspected.storage;
  if (!storage?.projectFile || !inspected.project || !inspected.state) failure("GC_PROJECT_UNAVAILABLE");
  root = inspected.project.projectRoot;
  const owner = { root, projectId: inspected.project.projectId, storage, inspected };
  const mixed=new SnapshotBackendReclamation({root,storage,signal,onProcess,deadline,shouldContinue,collectionAttempt});
  const base = path.join(root, storage.directory), entries = [], snapshots = [], roots = [], issues = [];
  let storedBytes = 0, decodedBytes = 0, summaryBytes = 0, scannedEntries = 0, omittedIssues = 0, interrupted = false;
  const issue = (relative, reasonCode) => { if (issues.length < 200) issues.push({ path: relative, reasonCode }); else omittedIssues += 1; };
  const checkContinue = () => { if(deadline&&Date.now()>=deadline)failure("SNAPSHOT_GIT_TIMEOUT"); if (!shouldContinue()) { interrupted = true; failure("SNAPSHOT_COLLECTION_INVALIDATED"); } };
  async function walk(relative = "") {
    checkContinue();
    if (++scannedEntries > 50_000) failure("GC_INVENTORY_INCOMPLETE");
    const file = safeSnapshotPath(root, path.join(base, relative)), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) failure("UNSAFE_GC_STORAGE_ENTRY");
    if (stat.isDirectory()) {
      if (relative === ".snapshot-gc") return;
      if (relative === ".operations") { if (fs.readdirSync(file).length) issue(relative, "ACTIVE_OR_UNKNOWN_WRITER"); return; }
      if (relative === "messaging") return;
      if (relative === "snapshot-objects.git" || relative === "snapshot-bundles" || relative === "observations/source-bundles") { if(relative!=="observations/source-bundles")return; }
      if (relative && !/^(?:graph-discovery|context(?:\/capsules)?|generated|world-model(?:\/snapshots)?|graph-projection(?:\/snapshots)?|sessions(?:\/(?:records|ledger|work-evidence|runs(?:\/run-[0-9]+-[a-f0-9]{6})?|by-id(?:\/session-[a-f0-9-]{36}(?:\/(?:work-evidence|ledger))?)?))?|onboarding(?:\/storage-selections)?|roles|instructions|lineage(?:\/(?:whole-plans|execution-contracts|result-packets|review-decisions))?|change-sets(?:\/(?:records|vcs-evidence|impact-candidate-sets|impact-review-decisions))?|refresh(?:\/(?:requests|receipts))?|observations(?:\/(?:source-bundles|descriptors|records(?:\/by-source-key)?|derived|receipts))?)$/.test(relative)) { issue(relative, "UNSUPPORTED_GC_STORAGE_DIRECTORY"); return; }
      for (const name of fs.readdirSync(file).sort()) await walk(relative ? relative + "/" + name : name);
      return;
    }
    if(relative.startsWith("observations/source-bundles/")&&stat.size>16*1024*1024||/^observations\/(?:descriptors|records|derived|receipts)\//.test(relative)&&stat.size>1024*1024)failure("OBSERVATION_STORE_LIMIT");
    if ((storedBytes += stat.size) > 1024 ** 3) failure("GC_INVENTORY_INCOMPLETE");
    if (relative === "graph-discovery/index.json") return;
    const exact = fs.lstatSync(file, { bigint: true }), before = snapshotFileIdentity(exact), match = target.exec(relative);
    if (match && (exact.ino < 1n || exact.dev < 0n)) failure("GC_FILESYSTEM_IDENTITY_UNAVAILABLE");
    if (!file.endsWith(".json.gz") && stat.size > 512 * 1024 * 1024) failure("SNAPSHOT_STORAGE_LIMIT");
    let accounted = 0;
    const read = match ? readSnapshotFile(file, { decodedBytes: 512 * 1024 * 1024, onDecodedBytes: length => { accounted = length; } }) : { bytes: fs.readFileSync(file) };
    decodedBytes += accounted || read.bytes.length;
    if (!sameSnapshotFileIdentity(before, snapshotFileIdentity(fs.lstatSync(file, { bigint: true })))) failure("GC_INVENTORY_DRIFT");
    let document = read.document;
    if (!match) {
      if (relative.endsWith(".json")) document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes));
      else if (relative === ".gitignore" || /^(?:instructions\/project|generated\/(?:head|lode)-instructions|roles\/(?:head|lode|developer|coder|reviewer))\.md$/.test(relative)) document = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
      else { issue(relative, "UNSUPPORTED_GC_REFERENCE_ROOT"); return; }
    }
    const entry = { file, path: storage.directory + "/" + relative, relative, bytes: read.bytes.length, sha256: hash(read.bytes), identity: before };
    const summary = referenceSummary(document);
    let retainedRow = null;
    try {
      if (match) {
        const hydrated=hydrateSnapshotEntry({root,storage,entry:{document}});
        document=hydrated.document; const summary=referenceSummary(document);
        const original = match[2].startsWith("world-model-") ? verifyWorldModelSnapshotOriginal({ document, worldModelId: match[2], storage }) : verifyTemporalProvenanceGraph(document);
        if (original.projectId !== owner.projectId || (original.worldModelId || original.graphSnapshotId) !== match[2]) failure("GC_SNAPSHOT_IDENTITY_MISMATCH");
        const graph = original.temporalProvenanceGraph;
        retainedRow = { ...entry, ...summary, dependencies:hydrated.snapshotStorage?.dependencies||[], id: match[2], identityIds: [match[2], original.sourceSnapshotId, graph?.sourceSnapshotId, graph?.graphSnapshotId].filter(Boolean),
          worldModelHash: original.worldModelHash || null, graphSnapshotHash: original.graphSnapshotHash || graph?.graphSnapshotHash || null };
      } else {
        if (typeof document !== "string") verifyRoot(relative, document, owner);
        retainedRow = { ...entry, ...summary };
      }
    } catch (error) { issue(entry.path, error.code || "GC_ORIGINAL_VERIFICATION_FAILED"); }
    const nextSummaryBytes = summaryBytes + Buffer.byteLength(JSON.stringify(retainedRow || entry));
    if (nextSummaryBytes > maxSummaryBytes) failure("GC_REFERENCE_SUMMARY_LIMIT");
    summaryBytes = nextSummaryBytes;
    entries.push(entry);
    if (retainedRow) { if (match) snapshots.push(retainedRow); else roots.push(retainedRow); }
    // The decoded body and buffer do not enter the retained inventory. Yield
    // between files so a same-process ordinary operation can cancel this scan.
    await new Promise(resolve => setImmediate(resolve));
    checkContinue();
  }
  try {
    await mixed.inventoryDomains();
    await walk();
    for(const [id,record] of owner.observationIds||[])if(JSON.stringify(record)!==JSON.stringify(owner.observationReceipts?.get(id)))failure("OBSERVATION_RECEIPT_MISSING");
    for(const [id,record] of owner.observationReceipts||[])if(JSON.stringify(record)!==JSON.stringify(owner.observationIds?.get(id)))failure("INVALID_OBSERVATION_RECEIPT_LINEAGE");
    for(const input of owner.observationInputs||[])if(owner.observationIds?.get(input.id)?.observationHash!==input.hash)failure("DERIVED_OBSERVATION_INPUT_MISMATCH");
    for await(const row of mixed.inventoryGit()) {
      checkContinue(); const document=row.document;
      const original=row.id.startsWith("world-model-")?verifyWorldModelSnapshotOriginal({document,worldModelId:row.id,storage}):verifyTemporalProvenanceGraph(document);
      if(original.projectId!==owner.projectId)failure("GC_SNAPSHOT_IDENTITY_MISMATCH");
      const graph=original.temporalProvenanceGraph, {document:unused,...physical}=row;
      const summary=referenceSummary(original), retainedRow={...physical,...summary,identityIds:[row.id,original.sourceSnapshotId,graph?.sourceSnapshotId,graph?.graphSnapshotId].filter(Boolean),worldModelHash:original.worldModelHash||null,graphSnapshotHash:original.graphSnapshotHash||graph?.graphSnapshotHash||null};
      summaryBytes+=Buffer.byteLength(JSON.stringify(retainedRow));if(summaryBytes>maxSummaryBytes)failure("GC_REFERENCE_SUMMARY_LIMIT"); snapshots.push(retainedRow);
      await new Promise(resolve=>setImmediate(resolve));
    }
    if(storedBytes+mixed.storedBytes>1024**3||scannedEntries+mixed.entryCount>50000)failure("GC_INVENTORY_INCOMPLETE");
    const extraSummary=Buffer.byteLength(JSON.stringify({objects:[...mixed.objects.values()],domains:[...mixed.domains.values()]}));summaryBytes+=extraSummary;if(summaryBytes>maxSummaryBytes)failure("GC_REFERENCE_SUMMARY_LIMIT");
  } catch (error) { issue(storage.directory, error.code || "GC_INVENTORY_UNREADABLE"); }
  const physicalPathKey = value => process.platform === "win32" ? value.toLowerCase() : value;
  const byId = new Map(), byHash = new Map(), byPath = new Map([...entries,...mixed.files.values()].map(row => [physicalPathKey(row.path), row])), seenIds = new Set();
  for (const row of snapshots) {
    if (seenIds.has(row.id)) issue(row.path, "SNAPSHOT_REPRESENTATION_CONFLICT"); seenIds.add(row.id);
    for (const id of row.identityIds) { if (!byId.has(id)) byId.set(id, []); byId.get(id).push(row); }
    for (const digest of [row.worldModelHash, row.graphSnapshotHash].filter(Boolean)) { if (!byHash.has(digest)) byHash.set(digest, []); byHash.get(digest).push(row); }
  }
  const retained = new Set(), queue = [], pinnedOids=new Set(),pinnedPaths=new Set();
  const retain = row => { if (!retained.has(row.path)) { retained.add(row.path); queue.push(row); } };
  function follow(summary) {
    for (const id of summary.references) {
      const matches = byId.get(id);
      if (!matches?.length) issue(summary.path, "RETAINED_SNAPSHOT_REFERENCE_UNAVAILABLE"); else matches.forEach(retain);
    }
    for (const digest of summary.digestReferences) { (byHash.get(digest) || []).forEach(retain);if(mixed.objects.has(digest))pinnedOids.add(digest);for(const row of mixed.domains.values())if(row.rawSha256===digest)pinnedPaths.add(row.path); }
    for (const digest of summary.requiredWorldHashes) {
      const matches = (byId.get("world-model-" + digest.slice(0, 24)) || []).filter(row => row.worldModelHash === digest);
      if (!matches.length) issue(summary.path, "RETAINED_WORLD_HASH_UNAVAILABLE"); else matches.forEach(retain);
    }
    for (const pin of summary.pins) {
      if (!/\/(?:(?:world-model|graph-projection)\/snapshots\/|snapshot-bundles\/|snapshot-objects\.git\/|observations\/source-bundles\/)/i.test(pin.path)) continue;
      const row = byPath.get(physicalPathKey(pin.path));
      if (!row || pin.byteLength !== null && row.bytes !== pin.byteLength || row.sha256 !== pin.sha256) issue(summary.path, "HISTORICAL_BYTE_REFERENCE_UNAVAILABLE");
      if (row) { pinnedPaths.add(row.path); const snapshot=snapshots.find(item=>item.path===row.path);if(snapshot)retain(snapshot); }
    }
  }
  for (const summary of roots) follow(summary);
  for (let index = 0; index < queue.length; index += 1) follow(queue[index]);
  try {for(const oid of [...pinnedOids])if(mixed.objects.get(oid)?.type==="tree"){const listing=(await mixed.store.invoke(["ls-tree",oid],mixed.context,{maxBytes:4096})).toString("ascii").trim().split("\n");if(listing.length!==2)failure("UNSUPPORTED_GC_GIT_TREE");for(const line of listing){const match=/^100644 blob ([a-f0-9]{64})\t(?:metadata.json|snapshot.json)$/.exec(line);if(!match||!mixed.objects.has(match[1]))failure("UNSUPPORTED_GC_GIT_TREE");pinnedOids.add(match[1]);}}}catch(error){issue(storage.directory,error.code||"INVALID_GC_GIT_PIN");}
  return { owner, entries, snapshots, retained, interrupted, decodedBytes:decodedBytes+mixed.decodedBytes, summaryBytes, maxSummaryBytes, mixed,pinnedOids,pinnedPaths,
    candidates: issues.length ? [] : snapshots.filter(row => !retained.has(row.path)), issues, omittedIssues, certified: issues.length === 0,
    backend: "typed-local-file-git-domain-source", basisDigest: hash(JSON.stringify([...entries,...mixed.files.values()].map(({ path, sha256 }) => ({ path, sha256 })))) };
}

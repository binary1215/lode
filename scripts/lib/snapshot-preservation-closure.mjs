import { readSourceObservationOriginal, readSourceFailure } from "./source-observation.mjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { inspectProject } from "./head-core.mjs";
import { safeSnapshotPath } from "./snapshot-storage-codec.mjs";
import { createLocalReadOnlyWorldModelStoreAdapter } from "./world-model-store.mjs";
import { LocalJsonGraphProjectionAdapter } from "./graph-projection-adapter.mjs";
import { readWorldModelSnapshot } from "./world-model.mjs";
import { verifyTemporalProvenanceGraph } from "./temporal-provenance.mjs";
import { CONTEXT_COMPILER_VERSION, readContextCapsule } from "./context-compiler.mjs";
import { readLineageArtifact } from "./execution-lineage.mjs";
import { readChangeSet } from "./change-set.mjs";
import { CHANGE_SET_DIRECTORY } from "./change-set-projection.mjs";
import { SNAPSHOT_GC_UNCOVERED_WRITERS } from "./snapshot-gc.mjs";
const hash = b => crypto.createHash("sha256").update(b).digest("hex");
// This projection proves only observed typed dependencies. It never authorizes
// deletion, owns no lifetime lease, and never turns unknown input into absence.
export async function inspectSnapshotPreservationClosure({ root = "." } = {}) {
  const inspected = inspectProject(root), storage = inspected.storage, project = inspected.project;
  if (!project) throw Object.assign(new Error("Project is not initialized."), { code: "NOT_INITIALIZED" });
  root = project.projectRoot;
  const semantic = new Map(), pins = new Map(), issues = [], roots = [], queue = [], visited = new Set(), sourceParents = new Set(), observedSourceSnapshots = new Set();
  const world = createLocalReadOnlyWorldModelStoreAdapter({ projectRoot: root, storage });
  const graph = new LocalJsonGraphProjectionAdapter({ projectRoot: root, storage });
  const issue = (subject, reasonCode) => issues.push({ subject, reasonCode, disposition: "retain" });
  const addSemantic = (kind, id, reason) => {
    const key=kind+":"+id;if(!semantic.has(key))semantic.set(key,{kind,id,reasons:[]});
    const row=semantic.get(key);if(!row.reasons.includes(reason))row.reasons.push(reason);
  };
  const enqueue = (kind,id,reason) => { if (!id) return;addSemantic(kind,id,reason);queue.push({kind,id,reason}); };
  function pinFile(file, kind, reason, verifiedOriginal = null) {
    safeSnapshotPath(root,file);const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.nlink!==1||stat.size>512*1024*1024)throw Object.assign(new Error("Pin file is not bounded regular bytes."),{code:"UNSAFE_SNAPSHOT_PATH"});
    const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
    let bytes;
    try { const opened=fs.fstatSync(fd);
      if(opened.dev!==stat.dev||opened.ino!==stat.ino||opened.size!==stat.size||opened.nlink!==1)throw Object.assign(new Error("Pin changed before read."),{code:"SNAPSHOT_STORAGE_DRIFT"});
      bytes=fs.readFileSync(fd);const after=fs.fstatSync(fd);
      if(bytes.length!==opened.size||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs)throw Object.assign(new Error("Pin changed during read."),{code:"SNAPSHOT_STORAGE_DRIFT"});
    } finally {fs.closeSync(fd);}
    const relative=path.relative(root,file).replaceAll("\\","/");
    const row={kind,address:relative,byteLength:bytes.length,sha256:hash(bytes),reason,disposition:"retain"};
    if (verifiedOriginal && (verifiedOriginal.relativePath !== relative || verifiedOriginal.sha256 !== row.sha256 || verifiedOriginal.byteLength !== row.byteLength)) {
      issue(relative,"VERIFIED_SOURCE_BYTE_PIN_MISMATCH");
      pins.set(relative,{...row,kind:"unverified-preserved-source-bundle"});return null;
    }
    const previous=pins.get(relative);if(previous&&(previous.sha256!==row.sha256||previous.byteLength!==row.byteLength)) { issue(relative,"OBSERVED_BYTE_PIN_DRIFT"); return; }
    pins.set(relative,row);
    return row;
  }
  function rootsIn(relative, pattern, read) {
    const directory=safeSnapshotPath(root,path.join(root,storage.directory,relative));
    if(!fs.existsSync(directory))return;
    const entries=fs.readdirSync(directory,{withFileTypes:true});
    if(entries.length>4096)issue(relative,"ROOT_INVENTORY_PARTIAL");
    for(const entry of entries.slice(0,4096)) {
      const file=safeSnapshotPath(root,path.join(directory,entry.name)),match=pattern.exec(entry.name);
      if(!entry.isFile()||!match){issue(path.relative(root,file),"UNKNOWN_OR_INTERMEDIATE_REFERENCE_ROOT");continue;}
      try { pinFile(file,"retained-typed-root",relative); const document=read(match[1]);pinFile(file,"retained-typed-root",relative);roots.push({kind:document.kind,id:match[1],path:path.relative(root,file).replaceAll("\\","/")});typed(document,match[1]); }
      catch(error){issue(entry.name,error.code||"REFERENCE_ROOT_UNREADABLE");}
    }
  }
  function typed(document, ownerId) {
    if (document.schemaVersion !== 1 || document.kind === "ContextCapsule" && document.compiler?.version !== CONTEXT_COMPILER_VERSION) { issue(ownerId, "UNKNOWN_TYPED_ROOT_SCHEMA"); return; }
    if(document.kind==="ContextCapsule") {
      const digest=document.snapshot?.sourceDigests?.repositoryWorldModel;
      if(digest) {
        if(!/^[a-f0-9]{64}$/.test(digest))issue(ownerId,"INVALID_TYPED_WORLD_HASH");
        else enqueue("world-model","world-model-"+digest.slice(0,24),ownerId);
      }
      for(const item of document.repositoryContext||[]) {
        if(item.worldModelId)enqueue("world-model",item.worldModelId,ownerId);
        addSemantic("source-version",JSON.stringify({path:item.path,digest:item.digest}),ownerId);
      }
    } else if(document.kind==="ChangeSet") {
      for(const endpoint of [document.before,document.after]) {
        if(endpoint.worldModelId)enqueue("world-model",endpoint.worldModelId,ownerId);
        else issue(ownerId,"LEGACY_WORLD_ADDRESS_NOT_RECORDED");
        enqueue("graph-snapshot",endpoint.graphSnapshotId,ownerId);
        addSemantic("source-snapshot",endpoint.sourceSnapshotId,ownerId);
      }
      for(const id of document.parentChangeSetIds)enqueue("change-set",id,ownerId);
      enqueue("lineage",document.reviewDecisionId,ownerId);enqueue("lineage",document.resultPacketId,ownerId);
    } else {
      for(const field of ["wholePlanId","executionContractId","resultPacketId","reviewDecisionId"])if(document[field]&&document[field]!==ownerId)enqueue("lineage",document[field],ownerId);
      if(document.capsuleId)enqueue("capsule",document.capsuleId,ownerId);
      for(const link of document.lineage||[]) {
        if(/^capsule-/.test(link.targetId))enqueue("capsule",link.targetId,ownerId);
        else if(/^(?:whole-plan|execution-contract|result-packet|review-decision)-/.test(link.targetId))enqueue("lineage",link.targetId,ownerId);
        else issue(ownerId,"UNKNOWN_TYPED_LINEAGE_TARGET");
      }
    }
  }
  rootsIn("context/capsules",/^(capsule-[a-f0-9]{24})\.json$/,id=>readContextCapsule({root,capsuleId:id}).capsule);
  const changeDirectory=CHANGE_SET_DIRECTORY.split("/").slice(1).join("/");
  rootsIn(changeDirectory,/^(change-set-[a-f0-9]{24})\.json$/,id=>readChangeSet({root,changeSetId:id}).changeSet);
  for(const directory of ["whole-plans","execution-contracts","result-packets","review-decisions"])rootsIn("lineage/"+directory,/^((?:whole-plan|execution-contract|result-packet|review-decision)-[a-f0-9]{24})\.json$/,id=>readLineageArtifact({root,artifactId:id}).artifact);
  try {const pointer=world.readPointer();if(pointer){pinFile(pointer.location,"world-pointer","current-and-previous");enqueue("world-model",pointer.document.worldModelId,"current-pointer");enqueue("world-model",pointer.document.previousWorldModelId,"previous-pointer");}}
  catch(error){issue("world-pointer",error.code||"POINTER_UNAVAILABLE");}
  for(let i=0;i<queue.length;i++) {
    if(visited.size>=4096){issue("closure","TYPED_CLOSURE_PARTIAL");break;}
    const row=queue[i],key=row.kind+":"+row.id;if(visited.has(key))continue;visited.add(key);
    try {
      if(row.kind==="world-model") {
        const stored=await readWorldModelSnapshot({root,worldModelId:row.id,storeAdapter:world}),snapshot=stored.snapshot;
        const entry=await world.readSnapshot(row.id);
        if(entry.location)pinFile(entry.location,"snapshot-representation",row.id);
        else pins.set("git:"+row.id,{...entry.snapshotStorage,kind:"git-object-pin",snapshotId:row.id,disposition:"retain"});
        for(const ref of entry.snapshotStorage?.dependencies||[])pinFile(path.join(root,ref.address),"snapshot-domain-bundle",row.id);
        const temporal=snapshot.temporalProvenanceGraph;
        enqueue("graph-snapshot",temporal.graphSnapshotId,row.id);addSemantic("source-snapshot",temporal.sourceSnapshotId,row.id);observedSourceSnapshots.add(temporal.sourceSnapshotId);
        for(const file of snapshot.files)addSemantic("source-version",JSON.stringify({path:file.path,digest:file.digest}),row.id);
        for(const id of temporal.parentSourceSnapshotIds) { addSemantic("source-snapshot",id,"parent-of:"+row.id); sourceParents.add(id); }
      } else if(row.kind==="graph-snapshot") {
        const entry=await graph.readSnapshot(row.id);if(!entry)throw Object.assign(new Error("Graph snapshot unavailable."),{code:"GRAPH_PROJECTION_SNAPSHOT_MISSING"});
        const document=verifyTemporalProvenanceGraph(entry.document);
        if(document.projectId!==project.projectId)throw Object.assign(new Error("Graph Project mismatch."),{code:"PROJECT_IDENTITY_MISMATCH"});
        if(entry.location)pinFile(entry.location,"snapshot-representation",row.id);
        else pins.set("git:"+row.id,{...entry.snapshotStorage,kind:"git-object-pin",snapshotId:row.id,disposition:"retain"});
        for(const ref of entry.snapshotStorage?.dependencies||[])pinFile(path.join(root,ref.address),"snapshot-domain-bundle",row.id);
        addSemantic("source-snapshot",document.sourceSnapshotId,row.id);observedSourceSnapshots.add(document.sourceSnapshotId);
      } else {
        const read=row.kind==="capsule"?readContextCapsule({root,capsuleId:row.id}):row.kind==="change-set"?readChangeSet({root,changeSetId:row.id}):readLineageArtifact({root,artifactId:row.id});
        pinFile(read.file,"retained-typed-root",row.reason);typed(read.capsule||read.changeSet||read.artifact,row.id);
      }
    } catch(error){issue(row.id,error.code||"TYPED_REFERENCE_UNAVAILABLE");}
  }
  for(const id of sourceParents)if(!observedSourceSnapshots.has(id))issue(id,"SOURCE_PARENT_PHYSICAL_ADDRESS_NOT_RECORDED");
  // File metadata is a semantic digest reference, not retention of source bytes.
  // No automatic history/network lookup or guessed replacement is performed.
  const retainedSources = new Map();
  const sourceDirectory = safeSnapshotPath(root, path.join(root,storage.directory,"observations/source-bundles"));
  if(fs.existsSync(sourceDirectory)) {
    const entries = fs.readdirSync(sourceDirectory,{withFileTypes:true});
    if(entries.length>4096)issue("source-bundles","SOURCE_BUNDLE_INVENTORY_PARTIAL");
    for(const entry of entries.slice(0,4096)) {
      const match = /^([a-f0-9]{64})\.json$/.exec(entry.name);
      if(!entry.isFile()||!match){issue(entry.name,"UNKNOWN_OR_INTERMEDIATE_SOURCE_BUNDLE");continue;}
      try {
        const file=path.join(sourceDirectory,entry.name);
        const parsed=JSON.parse(fs.readFileSync(file,"utf8"));
        if(parsed.failure){readSourceFailure(root,project.projectId,match[1],storage);pinFile(file,"exact-source-failure-original",match[1]);continue;}
        const { bundle, original }=readSourceObservationOriginal(root,project.projectId,match[1],{storage,requireCurrent:false});
        const pin=pinFile(file,"exact-source-bundle",match[1],original);
        if(!pin)continue;
        for(const source of bundle.evidence.sources)retainedSources.set(JSON.stringify({path:source.path,digest:source.digest}),path.relative(root,file).replaceAll("\\","/"));
      } catch(error){issue(entry.name,error.code||"SOURCE_BUNDLE_UNAVAILABLE");}
    }
  }
  const sourceVersions=[...semantic.values()].filter(row=>row.kind==="source-version");
  for(const source of sourceVersions) {
    source.exactBundleAddress=retainedSources.get(source.id)||null;
    if(!source.exactBundleAddress)issue(source.id,"SOURCE_BYTE_RETENTION_NOT_CERTIFIED");
  }
  return {kind:"SnapshotPreservationClosure",schemaVersion:1,authorityPlane:"P4",persisted:false,projectId:project.projectId,
    status:issues.length?"partial-preserved":"observed-typed-closure",roots,semanticReferences:[...semantic.values()],bytePins:[...pins.values()],issues,
    coverage:{typedRootKinds:["ContextCapsule","ChangeSet","WholePlanSnapshot","ExecutionContract","ResultPacket","ReviewDecision"],otherRootSchemas:"not-certified-retained",writerLifetime:"not-locked-not-certified",readConsistency:"observed-sequence-not-atomic",sourceBytes:"exact-validated-bundles-where-present-otherwise-partial"},
    applyAvailable:false,deletedCount:0,refDeletionCount:0,ordinaryWorkBlocked:false,recoveryAuthority:false,instructionAuthority:false,
    uncoveredWriters:SNAPSHOT_GC_UNCOVERED_WRITERS};
}

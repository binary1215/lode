import { createSourceObservation, retainSourceObservation, readSourceObservation } from "../scripts/lib/source-observation.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { LocalJsonWorldModelStoreAdapter } from "../scripts/lib/world-model-store.mjs";
import { LocalJsonGraphProjectionAdapter } from "../scripts/lib/graph-projection-adapter.mjs";
import { buildWorldModel, readWorldModelForDiscovery, readWorldModelSnapshot } from "../scripts/lib/world-model.mjs";
import { buildGraphExplorerSnapshot } from "../scripts/lib/graph-explorer.mjs";
import { compileContext, readContextCapsule } from "../scripts/lib/context-compiler.mjs";
import { queryProjectGraph } from "../scripts/lib/project-graph.mjs";
import { runCommand } from "../scripts/lode.mjs";
import { inspectSnapshotPreservationClosure } from "../scripts/lib/snapshot-preservation-closure.mjs";
import { ensureProjectStorageIgnore, GENERATED_STORAGE_IGNORE_RULES, RETAINED_STORAGE_IGNORE_RULES, ensureOwnedSnapshotStoreIgnore } from "../scripts/lib/project-storage-ignore.mjs";
import { GitSnapshotStore, snapshotGitProcessStatus } from "../scripts/lib/git-snapshot-store.mjs";
import zlib from "node:zlib";
import { dispatch } from "../scripts/mcp-server.mjs";
import { hydrateSnapshotComposition } from "../scripts/lib/snapshot-domain-bundles.mjs";
import { canonicalGraphJson } from "../scripts/lib/discovery-index.mjs";
import { readSnapshotFile } from "../scripts/lib/snapshot-storage-codec.mjs";
import { verifyTemporalProvenanceGraph, buildTemporalProvenanceGraph } from "../scripts/lib/temporal-provenance.mjs";
import { stabilizeTemporalRelationIdentities, temporalRelationIdentity } from "../scripts/lib/temporal-relation-identity.mjs";
const pluginRoot=path.resolve(import.meta.dirname,"..");
const product={schemaVersion:1,featureGroups:[{key:"editing",name:"Editing",description:"Edit a document."}],capabilities:[],features:[],requirements:[],constraints:[],decisions:[]};
function fixture(t,options={}) {
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"lode 묶음 공백-")));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 initializeProject({root,pluginRoot,runtimes:["codex"]});const storage=inspectProject(root).storage;
 const canon=path.join(root,storage.directory,"context/product-model.json");fs.writeFileSync(canon,JSON.stringify(product)+"\n");
 fs.writeFileSync(path.join(root,"module.py"),"def compute_value():\n    return 1\n");
 return {root,storage,canon,world:new LocalJsonWorldModelStoreAdapter({projectRoot:root,storage,snapshotLayout:"domain-bundles-v1",...options}),
 graph:new LocalJsonGraphProjectionAdapter({projectRoot:root,storage,snapshotLayout:"domain-bundles-v1",...options})};
}
const hash=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
const edgeKey=e=>[e.type,e.from,e.to,e.origin].join(":");
test("domain bundles connect actual writer and default World Compiler Graph Explorer CLI MCP readers",async t=>{
 const f=fixture(t);const first=await buildWorldModel({root:f.root,storeAdapter:f.world,graphProjectionAdapter:f.graph});
 const original=await fs.promises.readFile(first.file);const raw=readSnapshotFile(first.file).document;
 assert.equal(raw.kind,"SnapshotComposition");assert.equal(first.snapshot.temporalProvenanceGraph.protocol.version,"0.16.0");
 const current=await readWorldModelForDiscovery({root:f.root});assert.deepEqual(current.snapshot,first.snapshot);
 const context=await compileContext({root:f.root,task:"inspect compute_value",budget:32768,persist:false});assert.equal(context.status,"preview");
 assert((await queryProjectGraph({root:f.root,query:"compute_value",maxNodes:32,maxEdges:64})).nodes.length);
 assert(await buildGraphExplorerSnapshot({root:f.root,query:"compute_value",history:true}));
 assert.equal((await runCommand(["world-status",f.root])).status,"current");
 const mcp=await dispatch({method:"tools/call",params:{name:"head_world_model",arguments:{project_root:f.root}}});assert.equal(mcp.error,undefined);
 assert.equal(JSON.parse(mcp.result.content[0].text).status,"current");
 const same=await buildWorldModel({root:f.root,storeAdapter:f.world,graphProjectionAdapter:f.graph});assert.equal(same.snapshot.worldModelId,first.snapshot.worldModelId);
 const changed={...product,decisions:[{key:"decision:review-style",statement:"Keep reviews concise.",description:"Review style",status:"active"}]};fs.writeFileSync(f.canon,JSON.stringify(changed)+"\n");
 const second=await buildWorldModel({root:f.root,storeAdapter:f.world,graphProjectionAdapter:f.graph});
 assert.notEqual(second.snapshot.worldModelId,first.snapshot.worldModelId);
 const secondRaw=readSnapshotFile(second.file).document;
 const firstDeps=(await f.world.readSnapshot(first.snapshot.worldModelId)).snapshotStorage.dependencies;
 const secondDeps=(await f.world.readSnapshot(second.snapshot.worldModelId)).snapshotStorage.dependencies;
 assert.deepEqual(secondDeps.find(d=>d.domain==="graph-code"),firstDeps.find(d=>d.domain==="graph-code"));
 assert.deepEqual(secondRaw.code,raw.code,"decision-only changes reuse exactly the same code bundle");
 const firstGraph=first.snapshot.temporalProvenanceGraph,secondGraph=second.snapshot.temporalProvenanceGraph;
 const before=new Map(firstGraph.edges.map(e=>[edgeKey(e),e]));
 const codeKinds=new Set(["File","FileRevision","Symbol","SymbolRevision","Test","TestRevision"]);
 const codeIds=new Set(secondGraph.nodes.filter(n=>codeKinds.has(n.kind)).map(n=>n.nodeId));
 let stable=0;for(const edge of secondGraph.edges){const old=before.get(edgeKey(edge));if(old&&codeIds.has(edge.from)&&codeIds.has(edge.to)) {assert.equal(edge.edgeId,old.edgeId);assert.equal(edge.logicalRelationId,old.logicalRelationId);stable++;}}
 assert(stable>0);assert(fs.readFileSync(first.file).equals(original));
 assert.deepEqual((await readWorldModelSnapshot({root:f.root,worldModelId:first.snapshot.worldModelId})).snapshot,first.snapshot);
 assert.equal(second.snapshot.productModel.decisions[0].key,"decision:review-style");
 assert.equal(second.sourceDiagnostics.codeAnalysis.reused,true);
 const dependencies=(await f.world.readSnapshot(first.snapshot.worldModelId)).snapshotStorage.dependencies;
 assert(dependencies.length<=3);const pin=dependencies.find(d=>d.domain==="world-code"),file=path.join(f.root,pin.address),saved=fs.readFileSync(file);
 fs.unlinkSync(file);await assert.rejects(()=>readWorldModelSnapshot({root:f.root,worldModelId:first.snapshot.worldModelId}),{code:"ENOENT"});fs.writeFileSync(file,saved);
 fs.writeFileSync(file,Buffer.from("broken"));await assert.rejects(()=>readWorldModelSnapshot({root:f.root,worldModelId:first.snapshot.worldModelId}),{code:"INVALID_SNAPSHOT_BUNDLE_ENCODING"});fs.writeFileSync(file,saved);
 assert.equal((await readWorldModelSnapshot({root:f.root,worldModelId:first.snapshot.worldModelId})).snapshot.worldModelId,first.snapshot.worldModelId);
});
test("relation logical identity preserves evidence revisions, continuity and exact snapshot targets",()=>{
 const projectId="identity-project";const graph=buildTemporalProvenanceGraph({projectId,files:[]});
 const stable=stabilizeTemporalRelationIdentities(graph);verifyTemporalProvenanceGraph(stable);verifyTemporalProvenanceGraph(graph);
 const nodes=new Map([{nodeId:"a",kind:"File"},{nodeId:"b",kind:"FileRevision",logicalEntityId:"b-logical"}].map(n=>[n.nodeId,n]));
 const edge={type:"TEST",from:"a",to:"b",sourceSnapshotId:"snapshot-a",authorityClass:"derived",origin:"code",producer:"fixture",producerVersion:"0.16.0",evidenceIds:["evidence-a"],confidence:0.8};
 const basis={projectId,nodes,logicalLineageState:{}};
 const first=temporalRelationIdentity(edge,basis),otherObservation=temporalRelationIdentity({...edge,sourceSnapshotId:"snapshot-b"},basis);
 assert.deepEqual(first,otherObservation);
 const changed=temporalRelationIdentity({...edge,evidenceIds:["evidence-b"],confidence:0.9},basis);assert.equal(changed.logicalRelationId,first.logicalRelationId);assert.notEqual(changed.contentRevisionId,first.contentRevisionId);
 const recreated=temporalRelationIdentity(edge,{...basis,logicalLineageState:{continuityGenerationByLogicalEntityId:{"b-logical":1}}});assert.notEqual(recreated.logicalRelationId,first.logicalRelationId);
 assert.notEqual(temporalRelationIdentity({...edge,to:"snapshot-b"},basis).logicalRelationId,temporalRelationIdentity({...edge,to:"snapshot-a"},basis).logicalRelationId);
 assert.notEqual(temporalRelationIdentity(edge,{...basis,projectId:"another"}).logicalRelationId,first.logicalRelationId);
 assert.notEqual(temporalRelationIdentity(edge,{...basis,relationAnalysisBasis:{analyzer:"new"}}).logicalRelationId,first.logicalRelationId);
 const sessions=new Map([...nodes,["session-a",{nodeId:"session-a",kind:"Session"}],["session-b",{nodeId:"session-b",kind:"Session"}]]);
 assert.notEqual(temporalRelationIdentity({...edge,from:"session-a"},{...basis,nodes:sessions}).logicalRelationId,temporalRelationIdentity({...edge,from:"session-b"},{...basis,nodes:sessions}).logicalRelationId);
});


test("typed closure follows durable Capsule references and preserves missing/unknown stages without deletion",async t=>{
 const f=fixture(t);const first=await buildWorldModel({root:f.root,storeAdapter:f.world,graphProjectionAdapter:f.graph});
 const capsule=await compileContext({root:f.root,task:"inspect compute_value",budget:32768,persist:true});
 fs.writeFileSync(path.join(f.root,"module.py"),"def compute_value():\n    return 2\n");
 const second=await buildWorldModel({root:f.root,storeAdapter:f.world,graphProjectionAdapter:f.graph,parentSourceSnapshotIds:[first.snapshot.temporalProvenanceGraph.sourceSnapshotId]});
 const closure=await inspectSnapshotPreservationClosure({root:f.root});
 assert(!closure.issues.some(i=>i.subject===first.snapshot.temporalProvenanceGraph.sourceSnapshotId&&/SOURCE_PARENT/.test(i.reasonCode)),"already observed exact parent must not create an unnecessary coverage gap");
 assert(closure.roots.some(r=>r.id===capsule.capsule.capsuleId));
 assert(closure.semanticReferences.some(r=>r.id===first.snapshot.worldModelId&&r.reasons.includes(capsule.capsule.capsuleId)));
 assert(closure.semanticReferences.some(r=>r.id===second.snapshot.worldModelId));
 assert(closure.bytePins.some(p=>p.kind==="snapshot-domain-bundle"));assert.equal(closure.deletedCount,0);assert.equal(closure.refDeletionCount,0);
 assert.equal(closure.ordinaryWorkBlocked,false);assert.equal(closure.coverage.writerLifetime,"not-locked-not-certified");
 const stage=path.join(f.root,f.storage.directory,"context/capsules/unpublished.tmp");fs.writeFileSync(stage,"not a reference yet");
 const incomplete=await inspectSnapshotPreservationClosure({root:f.root});assert(incomplete.issues.some(i=>i.reasonCode==="UNKNOWN_OR_INTERMEDIATE_REFERENCE_ROOT"));assert(fs.existsSync(stage));
 fs.unlinkSync(first.file);const missing=await inspectSnapshotPreservationClosure({root:f.root});assert(missing.issues.some(i=>i.subject===first.snapshot.worldModelId));assert.equal(missing.deletedCount,0);
});
test("native zstd domain bundles reconstruct current and historical World without changing the gzip default",async t=>{
 if(typeof zlib.zstdCompressSync!=="function")return t.skip("runtime has no native zstd; no installation attempted");
 const f=fixture(t,{bundleEncoding:"zstd"});const first=await buildWorldModel({root:f.root,storeAdapter:f.world,graphProjectionAdapter:f.graph});
 assert(first.file.endsWith(".json.gz"),"composition encoding remains the explicit gzip default");
 const read=await f.world.readSnapshot(first.snapshot.worldModelId);assert(read.snapshotStorage.dependencies.every(d=>d.encoding==="zstd"));
 assert.deepEqual((await readWorldModelForDiscovery({root:f.root})).snapshot,first.snapshot);
 fs.writeFileSync(path.join(f.root,"module.py"),"def compute_value():\n    return 3\n");
 const second=await buildWorldModel({root:f.root,storeAdapter:f.world,graphProjectionAdapter:f.graph});assert.notEqual(second.snapshot.codeAnalysisInputBasis,first.snapshot.codeAnalysisInputBasis);assert.equal(second.sourceDiagnostics.codeAnalysis.reused,false);
 assert.deepEqual((await readWorldModelSnapshot({root:f.root,worldModelId:first.snapshot.worldModelId})).snapshot,first.snapshot);
});
test("private Git optionality, Windows lock retry and owned ignore preserve user policy",async t=>{
 const f=fixture(t),events=[];
 const missingCommand=path.join(f.root,"missing Git executable.exe");
 const ordinary=new LocalJsonWorldModelStoreAdapter({projectRoot:f.root,storage:f.storage,gitOptions:{gitCommand:missingCommand,onProcess:e=>events.push(e)}});
 const baseline=await buildWorldModel({root:f.root,storeAdapter:ordinary});assert.equal(events.length,0);assert(baseline.file.endsWith(".gz"));
 const unavailable=new GitSnapshotStore({projectRoot:f.root,storage:f.storage,gitCommand:missingCommand,onProcess:e=>events.push(e)});
 await assert.rejects(()=>unavailable.write(baseline.snapshot.worldModelId,baseline.snapshot),{code:"SNAPSHOT_GIT_EXECUTABLE_UNAVAILABLE"});
 assert.deepEqual(snapshotGitProcessStatus(),[]);
 const store=new GitSnapshotStore({projectRoot:f.root,storage:f.storage,onProcess:e=>events.push(e)});
 await store.ensure(store.context());
 const ignore=path.join(store.directory,".gitignore");assert.match(fs.readFileSync(ignore,"utf8"),/not disposable cache/);
 const user=path.join(f.root,".gitignore"),userText="!keep-this.txt\n";fs.writeFileSync(user,userText);
 const owned=path.join(path.dirname(store.directory),"snapshot-objects.git.00000000-0000-0000-0000-000000000000.staging");fs.mkdirSync(owned);
 assert.equal(ensureOwnedSnapshotStoreIgnore({root:f.root,storage:f.storage,directory:owned}).reasonCode,"USER_IGNORE_RULES_TAKE_PRECEDENCE");assert(!fs.existsSync(path.join(owned,".gitignore")));assert.equal(fs.readFileSync(user,"utf8"),userText);
 const lock=path.join(store.directory,store.ref(baseline.snapshot.worldModelId)+".lock");fs.mkdirSync(path.dirname(lock),{recursive:true});fs.writeFileSync(lock,"synthetic owned lock");
 await assert.rejects(()=>store.write(baseline.snapshot.worldModelId,baseline.snapshot));assert.equal(fs.readFileSync(lock,"utf8"),"synthetic owned lock");
 fs.unlinkSync(lock);const retained=await store.write(baseline.snapshot.worldModelId,baseline.snapshot);assert.equal(retained.document.worldModelId,baseline.snapshot.worldModelId);
 const missingReader=new GitSnapshotStore({projectRoot:f.root,storage:f.storage,gitCommand:missingCommand});await assert.rejects(()=>missingReader.read(baseline.snapshot.worldModelId),{code:"SNAPSHOT_GIT_EXECUTABLE_UNAVAILABLE"});
 assert.equal((await ordinary.readSnapshot(baseline.snapshot.worldModelId)).document.worldModelId,baseline.snapshot.worldModelId,"file-backed history remains available without Git");
 assert.deepEqual(snapshotGitProcessStatus(),[]);assert.equal(events.filter(e=>e.event==="started"&&e.pid).length,events.filter(e=>e.event==="closed"&&e.pid).length);
});

test("domain composition rejects foreign scope, bad addresses, tamper and reconstruction inflation",async t=>{
 const f=fixture(t),built=await buildWorldModel({root:f.root,storeAdapter:f.world,graphProjectionAdapter:f.graph});
 const original=readSnapshotFile(built.file).document;
 for(const [label,mutate,code] of [
  ["Project",m=>{m.projectId="foreign";},"INVALID_SNAPSHOT_COMPOSITION"],
  ["schema",m=>{m.schemaVersion=99;},"UNSUPPORTED_SNAPSHOT_COMPOSITION"],
  ["producer",m=>{m.producer.version="other";},"UNSUPPORTED_SNAPSHOT_COMPOSITION"],
  ["address",m=>{m.graph.address="../outside.json.gz";},"INVALID_SNAPSHOT_BUNDLE_ADDRESS"],
  ["bundle Project",m=>{m.graph.projectId="foreign";},"INVALID_SNAPSHOT_BUNDLE_REFERENCE"],
  ["bundle schema",m=>{m.graph.schemaVersion=99;},"INVALID_SNAPSHOT_BUNDLE_REFERENCE"],
  ["depth/type",m=>{m.graph.domain="world-code";},"SNAPSHOT_BUNDLE_TYPE_MISMATCH"],
  ["basis",m=>{m.body.analysisBasis.semanticGraphVersion="changed";},"SNAPSHOT_BUNDLE_BASIS_MISMATCH"],
  ["root tamper",m=>{m.body.productModel.decisions.push({key:"injected",statement:"not authorized"});},"SNAPSHOT_COMPOSITION_DIGEST_MISMATCH"],
  ["inflate",m=>{m.reconstructedByteLength=513*1024*1024;},"INVALID_SNAPSHOT_COMPOSITION"]
 ]) {
  const changed=structuredClone(original);mutate(changed);
  assert.throws(()=>hydrateSnapshotComposition({root:f.root,storage:f.storage,document:changed}),{code},label);
 }
 assert.deepEqual((await readWorldModelForDiscovery({root:f.root})).snapshot,built.snapshot);
});
test("actual delete/recreate continuity is not merged with an old stable relation",async t=>{
 const f=fixture(t);const first=await buildWorldModel({root:f.root,storeAdapter:f.world,graphProjectionAdapter:f.graph});
 const fileNode=first.snapshot.temporalProvenanceGraph.nodes.find(n=>n.kind==="File"&&n.path==="module.py");
 const oldEdge=first.snapshot.temporalProvenanceGraph.edges.find(e=>e.type==="HAS_REVISION"&&e.from===fileNode.nodeId);assert(oldEdge);
 fs.unlinkSync(path.join(f.root,"module.py"));await buildWorldModel({root:f.root,storeAdapter:f.world,graphProjectionAdapter:f.graph});
 fs.writeFileSync(path.join(f.root,"module.py"),"def compute_value():\n    return 1\n");
 const recreated=await buildWorldModel({root:f.root,storeAdapter:f.world,graphProjectionAdapter:f.graph});
 const newEdge=recreated.snapshot.temporalProvenanceGraph.edges.find(e=>e.type==="HAS_REVISION"&&e.from===fileNode.nodeId);assert(newEdge);
 assert.notEqual(newEdge.logicalRelationId,oldEdge.logicalRelationId);assert.notEqual(newEdge.contentRevisionId,oldEdge.contentRevisionId);
 assert.equal((await readWorldModelSnapshot({root:f.root,worldModelId:first.snapshot.worldModelId})).snapshot.temporalProvenanceGraph.edges.find(e=>e.edgeId===oldEdge.edgeId).logicalRelationId,oldEdge.logicalRelationId);
});

test("typed preservation keeps future Capsules opaque without changing ordinary Capsule readers",async t=>{
 const f=fixture(t);await buildWorldModel({root:f.root,storeAdapter:f.world,graphProjectionAdapter:f.graph});
 const compiled=await compileContext({root:f.root,task:"inspect compute_value",budget:32768,persist:true});
 const future=structuredClone(compiled.capsule);delete future.capsuleId;delete future.capsuleHash;
 future.schemaVersion=99;future.compiler.version="future-uninterpreted";
 const digest=hash(canonicalGraphJson(future));future.capsuleId="capsule-"+digest.slice(0,24);future.capsuleHash=digest;
 const file=path.join(path.dirname(compiled.file),future.capsuleId+".json"),raw=Buffer.from(JSON.stringify(future)+"\n");fs.writeFileSync(file,raw);
 assert.equal(readContextCapsule({root:f.root,capsuleId:future.capsuleId}).capsule.capsuleId,future.capsuleId,"existing read contract is not gated by this diagnostic");
 const closure=await inspectSnapshotPreservationClosure({root:f.root});
 assert(closure.issues.some(i=>i.subject===future.capsuleId&&i.reasonCode==="UNKNOWN_TYPED_ROOT_SCHEMA"));
 assert(!closure.semanticReferences.some(r=>r.reasons.includes(future.capsuleId)));assert(fs.readFileSync(file).equals(raw));assert.equal(closure.deletedCount,0);
});
test("composition metadata is counted before aggregate domain reconstruction",async t=>{
 const f=fixture(t),built=await buildWorldModel({root:f.root,storeAdapter:f.world,graphProjectionAdapter:f.graph});
 const manifest=readSnapshotFile(built.file).document;
 const read=hydrateSnapshotComposition({root:f.root,storage:f.storage,document:manifest});
 assert.equal(read.metrics.decodedBytes,Buffer.byteLength(JSON.stringify(manifest),"utf8")+1+read.dependencies.reduce((sum,ref)=>sum+ref.byteLength,0));
 assert.deepEqual(read.document,built.snapshot);
});
test("new decision supersession and cancellation stay current while exact old Worlds retain their original policy",async t=>{
 const f=fixture(t);const snapshots=[];
 for(const decisions of [[{key:"policy",statement:"Review evidence",description:"Synthetic user input",status:"active"}],[{key:"policy",statement:"Review evidence",description:"Synthetic user input",status:"superseded"}],[]]) {
  fs.writeFileSync(f.canon,JSON.stringify({...product,decisions})+"\n");
  snapshots.push((await buildWorldModel({root:f.root,storeAdapter:f.world,graphProjectionAdapter:f.graph})).snapshot);
 }
 assert.equal((await readWorldModelForDiscovery({root:f.root})).snapshot.productModel.decisions.length,0);
 assert.equal((await readWorldModelSnapshot({root:f.root,worldModelId:snapshots[0].worldModelId})).snapshot.productModel.decisions[0].status,"active");
 assert.equal((await readWorldModelSnapshot({root:f.root,worldModelId:snapshots[1].worldModelId})).snapshot.productModel.decisions[0].status,"superseded");
});

test("private Git cannot read planted global config or execute a planted reference transaction hook",async t=>{
 const f=fixture(t),snapshot=(await buildWorldModel({root:f.root,persist:false})).snapshot;
 const store=new GitSnapshotStore({projectRoot:f.root,storage:f.storage});await store.ensure(store.context());
 fs.writeFileSync(path.join(store.directory,"disabled-global-config"),"this is intentionally invalid Git configuration\n");
 fs.mkdirSync(path.join(store.directory,"disabled-hooks"));
 fs.writeFileSync(path.join(store.directory,"disabled-hooks/reference-transaction"),"#!/bin/sh\nexit 99\n");
 const result=await store.write(snapshot.worldModelId,snapshot);
 assert.equal(result.document.worldModelId,snapshot.worldModelId);assert.deepEqual(snapshotGitProcessStatus(),[]);
});

test("exact source pin binds the verifier buffer and rejects a deterministic invalid-valid-invalid ABA",async t=>{
 const f=fixture(t);await buildWorldModel({root:f.root,storeAdapter:f.world,graphProjectionAdapter:f.graph});
 const source=fs.readFileSync(path.join(f.root,"module.py"));
 const bundle=createSourceObservation({version:1,kind:"source",projectId:f.storage.projectId,query:[{path:"module.py",symbol:""}],sources:[{path:"module.py",digest:hash(source),base64:source.toString("base64")}],profile:{},observedAt:"2026-10-28T00:00:00.000Z"},f.storage);
 const key=retainSourceObservation(f.root,bundle,f.storage),file=path.join(f.root,f.storage.directory,"observations/source-bundles",key+".json"),valid=fs.readFileSync(file),bad=Buffer.from(valid);bad[0]=33;
 assert((await inspectSnapshotPreservationClosure({root:f.root})).semanticReferences.some(e=>e.kind==="source-version"&&e.exactBundleAddress?.endsWith(key+".json")));
 fs.writeFileSync(file,bad);const open=fs.openSync,close=fs.closeSync,write=fs.writeFileSync;let swapping=false,swappedFd=null,swaps=0;
 const replace=bytes=>{swapping=true;try{write(file,bytes);}finally{swapping=false;}};
 fs.openSync=function(value,...args){if(!swapping&&typeof value==="string"&&path.resolve(value)===file&&new Error().stack.includes("readSourceBytes")){replace(valid);const fd=open.call(this,value,...args);swappedFd=fd;swaps++;return fd;}return open.call(this,value,...args);};
 fs.closeSync=function(fd){const result=close.call(this,fd);if(fd===swappedFd){swappedFd=null;replace(bad);}return result;};
 let closure;try{closure=await inspectSnapshotPreservationClosure({root:f.root});}finally{fs.openSync=open;fs.closeSync=close;}
 try {
  assert.equal(swaps,1);assert.throws(()=>readSourceObservation(f.root,f.storage.projectId,key,{storage:f.storage,requireCurrent:false}),{code:"SOURCE_BUNDLE_JSON_INVALID"});
  assert(!closure.semanticReferences.some(e=>e.kind==="source-version"&&e.exactBundleAddress?.endsWith(key+".json")));
  assert(!closure.bytePins.some(e=>e.kind==="exact-source-bundle"&&e.address.endsWith(key+".json")));
  assert(closure.issues.some(i=>i.reasonCode==="VERIFIED_SOURCE_BYTE_PIN_MISMATCH"));assert.equal(closure.status,"partial-preserved");assert.equal(closure.deletedCount,0);
 } finally {fs.writeFileSync(file,valid);}
});

test("generated ignore respects disjoint exceptions and exact managed upgrade without Git",async t=>{
 for(const exception of ["!docs/", "!/docs/", "!.gitkeep", "# comment\r\n\\!docs/\r\n"]){
  const f=fixture(t),file=path.join(f.root,f.storage.directory,".gitignore");fs.unlinkSync(file);fs.writeFileSync(path.join(f.root,".gitignore"),exception+"\r\n");
  const r=ensureProjectStorageIgnore({root:f.root,storage:f.storage});assert.equal(r.status,"created",exception);assert(r.rules.included.includes("/graph-discovery/index.json"));if(exception.startsWith("!/docs/"))for(const rule of RETAINED_STORAGE_IGNORE_RULES)assert(r.rules.included.includes(rule));
 }
 for(const suffix of ["\n","\r\n"]){const f=fixture(t),file=path.join(f.root,f.storage.directory,".gitignore");const legacy=["# BEGIN Lode generated disposable storage rules","/graph-discovery/index.json", "/.operations/", "/.snapshot-gc/", "/refresh/writer.lock/", "/refresh/writer.lock.*.staging/","# END Lode generated disposable storage rules",""] .join(suffix);fs.writeFileSync(file,legacy);assert.equal(ensureProjectStorageIgnore({root:f.root,storage:f.storage}).status,"updated");assert.match(fs.readFileSync(file,"utf8"),/Retained history, not disposable cache/);}
 for(const text of ["# user policy\n", "# BEGIN Lode generated disposable storage rules\n# user addition\n", "!snapshot-bundles/**\n"]){const f=fixture(t),file=path.join(f.root,f.storage.directory,".gitignore");fs.writeFileSync(file,text);assert.equal(ensureProjectStorageIgnore({root:f.root,storage:f.storage}).status,"preserved");assert.equal(fs.readFileSync(file,"utf8"),text);}
 for(const exception of ["!.lode/**", "!**/snapshots/**", "!snap*"]){const f=fixture(t),file=path.join(f.root,f.storage.directory,".gitignore");fs.unlinkSync(file);fs.writeFileSync(path.join(f.root,".gitignore"),exception+"\n");const r=ensureProjectStorageIgnore({root:f.root,storage:f.storage});assert(r.rules.skipped.length>0);assert(!r.rules.included.includes("/world-model/snapshots/"));}
});

test("reader requirements are pointer-bound and status uses zero-write bounded reads",async t=>{
 const {inspectProjectExperience}=await import("../scripts/lib/project-bootstrap.mjs");const {formatProjectStatus}=await import("../scripts/lib/cli-presentation.mjs");
 const f=fixture(t),built=await buildWorldModel({root:f.root});const worldPointer=path.join(f.root,f.storage.directory,"world-model/current.json"),graphPointer=path.join(f.root,f.storage.directory,"graph-projection/current.json");
 const originalWorld=fs.readFileSync(worldPointer),originalGraph=fs.readFileSync(graphPointer);const wp=JSON.parse(originalWorld),gp=JSON.parse(originalGraph);assert.equal(wp.readerRequirements.layout,"chunked-code-v3");assert.equal(wp.readerRequirements.snapshotId,built.snapshot.worldModelId);assert.equal(gp.readerRequirements.snapshotId,gp.graphSnapshotId);
 const open=fs.openSync;fs.openSync=function(file,...args){if(String(file).includes(path.sep+"snapshot-bundles"+path.sep)||String(file).includes(path.sep+"snapshots"+path.sep))assert.fail("status hydrated World/Graph");return open.call(this,file,...args);};let status;try{status=await inspectProjectExperience({root:f.root});}finally{fs.openSync=open;}
 assert(status.readiness.storage.layers.every(l=>l.state==="declared-supported"));assert.equal(status.ordinaryWorkBlocked,false);assert(fs.readFileSync(worldPointer).equals(originalWorld));assert(fs.readFileSync(graphPointer).equals(originalGraph));
 delete wp.readerRequirements;fs.writeFileSync(worldPointer,JSON.stringify(wp));status=await runCommand(["status",f.root]);assert.equal(status.readiness.storage.layers[0].state,"not-inspected");assert.match(formatProjectStatus(status),/Core work continues/);assert.equal(status.ordinaryWorkBlocked,false);assert.equal(status.userDecisionRequired,false);
 wp.readerRequirements={version:1,snapshotId:wp.worldModelId,layout:"future-layout"};fs.writeFileSync(worldPointer,JSON.stringify(wp));const mcp=await dispatch({method:"tools/call",params:{name:"head_project_status",arguments:{project_root:f.root}}});assert.equal(mcp.error,undefined);const displayed=mcp.result.structuredContent;assert.match(mcp.result.content[0].text,/unsupported/);assert.equal(displayed.readiness.storage.layers[0].state,"unsupported");assert.match(formatProjectStatus(displayed),/unsupported/);
 wp.readerRequirements.snapshotId="world-model-"+"f".repeat(24);fs.writeFileSync(worldPointer,JSON.stringify(wp));status=await inspectProjectExperience({root:f.root});assert.equal(status.readiness.storage.layers[0].reasonCode,"INVALID_READER_REQUIREMENTS");
 fs.writeFileSync(worldPointer,originalWorld);fs.writeFileSync(graphPointer,originalGraph);const {buildSnapshotDeletionClosure}=await import("../scripts/lib/snapshot-deletion-closure.mjs");const closure=await buildSnapshotDeletionClosure({root:f.root});assert.equal(closure.certified,true,JSON.stringify(closure.issues));
});

test("physical storage reports separate byte scopes without treating observation as deletion evidence",async t=>{
 const {inspectSnapshotGarbageCollection}=await import("../scripts/lib/snapshot-gc.mjs");const {inspectPhysicalStorage}=await import("../scripts/lib/snapshot-storage-accounting.mjs");
 const f=fixture(t);await buildWorldModel({root:f.root});const snapshotDir=path.join(f.root,f.storage.directory,"snapshot-bundles"),unknown=path.join(snapshotDir,"unknown-sidecar.bin");fs.writeFileSync(unknown,Buffer.alloc(123));
 const before=fs.readdirSync(snapshotDir).sort(),result=inspectSnapshotGarbageCollection({root:f.root});const physical=result.physicalStorage;assert(physical.backends.domainBundles.observedFileBytes>=123);assert(physical.observedFileBytes>result.storedBytes);assert.equal(physical.deletionAuthority,false);assert.equal(result.reclaimableBytes,0);assert.equal(result.storedBytes,physical.backends.snapshotFiles.observedFileBytes);assert.deepEqual(fs.readdirSync(snapshotDir).sort(),before);assert.equal(fs.statSync(unknown).size,123);
 const coordination=path.join(f.root,f.storage.directory,".operations");fs.mkdirSync(coordination,{recursive:true});fs.writeFileSync(path.join(coordination,"synthetic-unknown-writer"),Buffer.alloc(64));const active=inspectSnapshotGarbageCollection({root:f.root});assert.equal(active.physicalStorage.coverage.complete,false);assert(active.physicalStorage.coverage.issues.some(x=>x.reasonCode==="TRANSIENT_COORDINATION_EXCLUDED"));assert.equal(active.ordinaryWorkBlocked,false);
 const limited=inspectPhysicalStorage({root:f.root,storage:f.storage,maxEntries:2});assert.equal(limited.coverage.complete,false);assert(limited.coverage.issues.some(x=>x.reasonCode==="PHYSICAL_OBSERVATION_LIMIT"));
});

test("bounded pointer inspection rejects descriptor growth before unbounded allocation",async t=>{
 const {inspectStorageReaderCompatibility}=await import("../scripts/lib/snapshot-storage-compatibility.mjs");const f=fixture(t);const directory=path.join(f.root,f.storage.directory,"world-model");fs.mkdirSync(directory,{recursive:true});const file=path.join(directory,"current.json");fs.writeFileSync(file,JSON.stringify({worldModelId:"world-model-"+"1".repeat(24)}));
 const open=fs.openSync,read=fs.readSync;let targetFd=null,readBytes=0,injected=false;
 fs.openSync=function(name,...args){const fd=open.call(this,name,...args);if(!injected&&typeof name==="string"&&path.resolve(name)===file){injected=true;targetFd=fd;fs.appendFileSync(file,Buffer.alloc(512*1024,32));}return fd;};fs.readSync=function(fd,...args){const size=read.call(this,fd,...args);if(fd===targetFd)readBytes+=size;return size;};let result;try{result=inspectStorageReaderCompatibility({root:f.root,storage:f.storage,verifyWorldPointer:()=>{},verifyGraphPointer:()=>{}});}finally{fs.openSync=open;fs.readSync=read;}
 assert.equal(result.layers[0].state,"unavailable");assert.equal(result.layers[0].reasonCode,"STORAGE_POINTER_CHANGED");assert.equal(readBytes,0);assert.equal(result.ordinaryWorkBlocked,false);
});

test("managed ignore upgrade preserves a user edit made while staging",async t=>{
 const f=fixture(t),file=path.join(f.root,f.storage.directory,".gitignore"),legacy=["# BEGIN Lode generated disposable storage rules","/graph-discovery/index.json", "/.operations/", "/.snapshot-gc/", "/refresh/writer.lock/", "/refresh/writer.lock.*.staging/","# END Lode generated disposable storage rules",""] .join("\n");fs.writeFileSync(file,legacy);
 const write=fs.writeFileSync;let injected=false;fs.writeFileSync=function(name,...args){const result=write.call(this,name,...args);if(!injected&&typeof name==="number"){injected=true;write(file,legacy+"# concurrent user edit\n");}return result;};let result;try{result=ensureProjectStorageIgnore({root:f.root,storage:f.storage});}finally{fs.writeFileSync=write;}
 assert(injected);assert.equal(result.reasonCode,"USER_IGNORE_CHANGED_CONCURRENTLY");assert.equal(fs.readFileSync(file,"utf8"),legacy+"# concurrent user edit\n");assert.equal(result.ordinaryWorkBlocked,false);
});

test("chunked code connects v3 writer to actual World Compiler Graph Explorer CLI and MCP readers",async t=>{
 const f=fixture(t,{snapshotLayout:"chunked-code-v3"});for(let i=0;i<18;i++)fs.writeFileSync(path.join(f.root,"unit"+i+".mjs"),"export function value"+i+"(x) { return x + "+i+"; }\n");
 const first=await buildWorldModel({root:f.root,storeAdapter:f.world,graphProjectionAdapter:f.graph}),rootBytes=fs.readFileSync(first.file),root=readSnapshotFile(first.file).document;
 assert.equal(root.schemaVersion,3);assert.equal(root.producer.version,"0.3.0");
 const entry=await f.world.readSnapshot(first.snapshot.worldModelId);assert.deepEqual(entry.document,first.snapshot);
 const graphEntry=await f.graph.readSnapshot(first.snapshot.temporalProvenanceGraph.graphSnapshotId);assert(graphEntry.snapshotStorage.dependencies.every(ref=>entry.snapshotStorage.dependencies.some(other=>other.address===ref.address)),"World and Graph share all exact graph bucket leaves and index");assert(entry.snapshotStorage.dependencies.length>8);const pinned=entry.snapshotStorage.dependencies.map(ref=>({ref,bytes:fs.readFileSync(path.join(f.root,ref.address))}));
 assert.deepEqual((await readWorldModelForDiscovery({root:f.root})).snapshot,first.snapshot);assert.equal((await runCommand(["world-status",f.root])).status,"current");
 const status=await runCommand(["status",f.root]);assert(status.readiness.storage.layers.every(layer=>layer.state==="declared-supported"));
 assert.equal((await compileContext({root:f.root,task:"inspect compute_value",budget:32768,persist:false})).status,"preview");assert((await queryProjectGraph({root:f.root,query:"compute_value",maxNodes:32,maxEdges:64})).nodes.length);
 assert(await buildGraphExplorerSnapshot({root:f.root,query:"compute_value",history:true}));
 const mcp=await dispatch({method:"tools/call",params:{name:"head_world_model",arguments:{project_root:f.root}}});assert.equal(mcp.error,undefined);assert.equal(mcp.result.structuredContent.status,"current");
 const v2=new LocalJsonWorldModelStoreAdapter({projectRoot:f.root,storage:f.storage,snapshotLayout:"shared-domains-v2"});await v2.writeSnapshot(first.snapshot.worldModelId,first.snapshot);assert(fs.readFileSync(first.file).equals(rootBytes),"same ID is never converted in place");
 fs.writeFileSync(path.join(f.root,"module.py"),"def compute_value():\n    return 2\n");const second=await buildWorldModel({root:f.root,storeAdapter:f.world,graphProjectionAdapter:f.graph});const next=await f.world.readSnapshot(second.snapshot.worldModelId);assert(pinned.filter(old=>next.snapshotStorage.dependencies.some(ref=>ref.address===old.ref.address)).length>8);
 for(const old of pinned)assert(fs.readFileSync(path.join(f.root,old.ref.address)).equals(old.bytes));assert(fs.readFileSync(first.file).equals(rootBytes));assert.deepEqual((await readWorldModelSnapshot({root:f.root,worldModelId:first.snapshot.worldModelId})).snapshot,first.snapshot);
 const {diffGraphLineage}=await import("../scripts/lib/graph-lineage.mjs");const args={root:f.root,fromWorldModelId:first.snapshot.worldModelId,toWorldModelId:second.snapshot.worldModelId,scopePaths:["module.py"],limit:1};const diff=await diffGraphLineage(args);assert.equal(diff.scope.verification,"full-endpoint-snapshots");assert.deepEqual((await runCommand(["graph-lineage-diff",f.root,"--from",args.fromWorldModelId,"--to",args.toWorldModelId,"--path","module.py","--limit","1"])).changes,diff.changes);
});

test("chunk index preserves duplicates and unknown row fields and rejects malformed reconstruction order",async()=>{
 const {splitWorldCodeChunks,joinWorldCodeChunks}=await import("../scripts/lib/snapshot-code-chunks.mjs");const data={files:[{path:"a",unknown:{"한글":"✓"}},{path:"a",unknown:{"한글":"✓"}}],semanticGraph:{nodes:[{id:"n",path:"a",extra:[1,2]}],edges:[{from:"n",id:"e"},{from:"n",id:"e"}],unknown:"kept"},extra:{scope:"same"}};
 const values=new Map();let n=0;const put=(domain,payload)=>{const ref={domain,address:"leaf"+(n++)};values.set(ref.address,payload);return ref;};const encoded=splitWorldCodeChunks(data,put);const get=ref=>values.get(ref.address);assert.deepEqual(joinWorldCodeChunks(encoded,get),data);
 for(const change of [i=>{i.lists.files.order[0]=64;},i=>{i.chunks[0].counts.files=-1;},i=>{i.chunks.push(i.chunks[0]);},i=>{i.lists.files.order.pop();},i=>{i.lists.files.family="graph.nodes";},i=>{i.chunks[0].counts.semanticNodes+=1;},i=>{i.lists.files.extra=true;}]){const invalid=structuredClone(encoded);change(invalid);assert.throws(()=>joinWorldCodeChunks(invalid,get),{code:"INVALID_SNAPSHOT_CODE_CHUNKS"});}
});

test("v3 missing corrupt and cross-project leaves fail exact historical read instead of substituting current",async t=>{
 const f=fixture(t,{snapshotLayout:"chunked-code-v3"}),built=await buildWorldModel({root:f.root,storeAdapter:f.world,graphProjectionAdapter:f.graph}),entry=await f.world.readSnapshot(built.snapshot.worldModelId),ref=entry.snapshotStorage.dependencies.find(ref=>ref.domain==="code-bucket-chunk"),file=path.join(f.root,ref.address),original=fs.readFileSync(file);
 try{fs.unlinkSync(file);await assert.rejects(()=>f.world.readSnapshot(built.snapshot.worldModelId),{code:"ENOENT"});fs.writeFileSync(file,Buffer.from("corrupt"));await assert.rejects(()=>f.world.readSnapshot(built.snapshot.worldModelId),{code:"INVALID_SNAPSHOT_BUNDLE_ENCODING"});}finally{fs.writeFileSync(file,original);}
 const raw=readSnapshotFile(built.file).document,foreign=structuredClone(raw);foreign.code.projectId="foreign";assert.throws(()=>hydrateSnapshotComposition({root:f.root,storage:f.storage,document:foreign}),{code:"INVALID_SNAPSHOT_BUNDLE_REFERENCE"});assert.deepEqual((await f.world.readSnapshot(built.snapshot.worldModelId)).document,built.snapshot);
});

test("physical bundle and root reads bound concurrent descriptor growth and preserve permission errors",async t=>{
 const {readBoundedSnapshotDescriptor}=await import("../scripts/lib/snapshot-storage-codec.mjs");const f=fixture(t,{snapshotLayout:"chunked-code-v3"});const built=await buildWorldModel({root:f.root,storeAdapter:f.world,graphProjectionAdapter:f.graph}),entry=await f.world.readSnapshot(built.snapshot.worldModelId),ref=entry.snapshotStorage.dependencies.find(r=>r.domain==="code-bucket-chunk");
 for(const file of [built.file,path.join(f.root,ref.address)]){
  const original=fs.readFileSync(file),open=fs.openSync,read=fs.readSync;let target=null,injected=false,consumed=0;
  fs.openSync=function(name,...args){const fd=open.call(this,name,...args);if(typeof name==="string"&&path.resolve(name)===file&&!injected)target=fd;return fd;};fs.readSync=function(fd,...args){if(fd===target&&!injected){injected=true;fs.appendFileSync(file,Buffer.alloc(512*1024,32));}const n=read.call(this,fd,...args);if(fd===target)consumed+=n;return n;};try{await assert.rejects(()=>f.world.readSnapshot(built.snapshot.worldModelId),{code:"SNAPSHOT_STORAGE_DRIFT"});assert(consumed<=original.length+1);}finally{fs.openSync=open;fs.readSync=read;fs.writeFileSync(file,original);}
 }
 const small=path.join(f.root,"short.bin");fs.writeFileSync(small,"ab");const fd=fs.openSync(small,"r");try{assert.throws(()=>readBoundedSnapshotDescriptor(fd,4,8),{code:"SNAPSHOT_STORAGE_DRIFT"});}finally{fs.closeSync(fd);}
 const read=fs.readSync;fs.readSync=()=>{throw Object.assign(new Error("synthetic read denied"),{code:"EACCES"});};try{assert.throws(()=>readSnapshotFile(built.file),{code:"EACCES"});}finally{fs.readSync=read;}
 assert.deepEqual((await f.world.readSnapshot(built.snapshot.worldModelId)).document,built.snapshot);
});

test("coalesced bucket families cannot hide missing rows or reuse another group's leaf",async()=>{
 const {splitWorldCodeChunks,joinWorldCodeChunks,splitGraphCodeChunks,joinGraphCodeChunks}=await import("../scripts/lib/snapshot-code-chunks.mjs");
 for(const count of[0,1,65,130]){const values=new Map();let id=0;const put=(domain,payload)=>{const ref={domain,address:"leaf-"+(id++)};values.set(ref.address,payload);return ref;};const original={files:Array.from({length:count},(_,i)=>({path:i%2?"É/"+i:"é/"+i,unknown:[i,{note:"kept"}]})),semanticGraph:{nodes:Array.from({length:count},(_,i)=>({id:"n"+i,path:i%2?"É/"+i:"é/"+i})),edges:Array.from({length:count},(_,i)=>({id:"e"+i,from:"n"+i,to:"n"+i})),unknown:"unchanged"}};const encoded=splitWorldCodeChunks(original,put);assert.deepEqual(joinWorldCodeChunks(encoded,ref=>values.get(ref.address)),original);if(!count)continue;
 const ref=encoded.chunks[0].ref,valid=values.get(ref.address),missing=structuredClone(valid);delete missing.lists.semanticNodes;values.set(ref.address,missing);assert.throws(()=>joinWorldCodeChunks(encoded,r=>values.get(r.address)),{code:"INVALID_SNAPSHOT_CODE_CHUNKS"});values.set(ref.address,valid);
 const wrong=structuredClone(valid);wrong.lists.files.push({path:"extra"});values.set(ref.address,wrong);assert.throws(()=>joinWorldCodeChunks(encoded,r=>values.get(r.address)),{code:"INVALID_SNAPSHOT_CODE_CHUNKS"});values.set(ref.address,valid);
 if(encoded.chunks.length>1){const dup=structuredClone(encoded);dup.chunks[1].ref=dup.chunks[0].ref;assert.throws(()=>joinWorldCodeChunks(dup,r=>values.get(r.address)),{code:"INVALID_SNAPSHOT_CODE_CHUNKS"});}
 const graph={nodes:[{sourceBound:true,body:{nodeId:"n1",path:"same"}}],edges:[]};const g=splitGraphCodeChunks(graph,put);const graphLeaf=values.get(g.chunks[0].ref.address);values.set(g.chunks[0].ref.address,valid);assert.throws(()=>joinGraphCodeChunks(g,r=>values.get(r.address)),{code:"INVALID_SNAPSHOT_CODE_CHUNKS"});values.set(g.chunks[0].ref.address,graphLeaf);assert.deepEqual(joinGraphCodeChunks(g,r=>values.get(r.address)),graph);
 }
});

test("omitted layout defaults to v3 through actual CLI MCP writers while exact older IDs are never converted",async t=>{
 const f=fixture(t),whole=new LocalJsonWorldModelStoreAdapter({projectRoot:f.root,storage:f.storage,snapshotLayout:"whole"}),wholeGraph=new LocalJsonGraphProjectionAdapter({projectRoot:f.root,storage:f.storage,snapshotLayout:"whole"});const old=await buildWorldModel({root:f.root,storeAdapter:whole,graphProjectionAdapter:wholeGraph}),oldBytes=fs.readFileSync(old.file);
 const unchanged=await runCommand(["world-index",f.root]);assert.equal(unchanged.snapshot.worldModelId,old.snapshot.worldModelId);assert(fs.readFileSync(old.file).equals(oldBytes));assert.notEqual(readSnapshotFile(old.file).document.kind,"SnapshotComposition");
 fs.writeFileSync(path.join(f.root,"module.py"),"def compute_value():\n    return 13\n");const next=await runCommand(["world-index",f.root]);assert.equal(readSnapshotFile(next.file).document.schemaVersion,3);const req=JSON.parse(fs.readFileSync(path.join(f.root,f.storage.directory,"world-model/current.json")));assert.equal(req.readerRequirements.layout,"chunked-code-v3");
 const mcpRoot=fs.mkdtempSync(path.join(os.tmpdir(),"lode-mcp-default-"));t.after(()=>fs.rmSync(mcpRoot,{recursive:true,force:true}));fs.writeFileSync(path.join(mcpRoot,"module.py"),"def mcp_value():\n    return 17\n");const created=await dispatch({method:"tools/call",params:{name:"head_project_initialize_or_resume",arguments:{project_root:mcpRoot,profile:"product",runtimes:["codex"],mode:"existing",storage:{mode:"local"},brief:{schemaVersion:1,featureGroups:[{key:"editing",name:"Editing",description:"Edit a document."}],capabilities:[],features:[],requirements:[],constraints:[],decisions:[]}}}});assert.equal(created.error,undefined,JSON.stringify(created));
 const mcp=await dispatch({method:"tools/call",params:{name:"head_world_model",arguments:{project_root:mcpRoot}}});assert.equal(mcp.error,undefined,JSON.stringify(mcp));const result=mcp.result.structuredContent||JSON.parse(mcp.result.content[0].text);assert.equal(result.status,"current");const pointer=JSON.parse(fs.readFileSync(path.join(mcpRoot,".lode/world-model/current.json")));assert.equal(readSnapshotFile(new LocalJsonWorldModelStoreAdapter({projectRoot:mcpRoot,storage:inspectProject(mcpRoot).storage}).snapshotLocation(pointer.worldModelId)).document.schemaVersion,3);
 assert(fs.readFileSync(old.file).equals(oldBytes));
});

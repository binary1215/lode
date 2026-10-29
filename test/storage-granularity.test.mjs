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
import { ensureOwnedSnapshotStoreIgnore } from "../scripts/lib/project-storage-ignore.mjs";
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
  ["schema",m=>{m.schemaVersion=99;},"INVALID_SNAPSHOT_COMPOSITION"],
  ["producer",m=>{m.producer.version="other";},"INVALID_SNAPSHOT_COMPOSITION"],
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

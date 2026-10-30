import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import test from "node:test";
import { initializeProject, inspectProject, convergeProjectInstallation } from "../scripts/lib/head-core.mjs";
import { seedLegacyProject } from "./helpers/legacy-project-fixture.mjs";
import { GitSnapshotStore, snapshotGitProcessStatus } from "../scripts/lib/git-snapshot-store.mjs";
import { buildGraphExplorerSnapshot } from "../scripts/lib/graph-explorer.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";
import { LocalJsonWorldModelStoreAdapter } from "../scripts/lib/world-model-store.mjs";
import { LocalJsonGraphProjectionAdapter } from "../scripts/lib/graph-projection-adapter.mjs";
import { buildWorldModel, readWorldModelForDiscovery, inspectWorldModel } from "../scripts/lib/world-model.mjs";
import { refreshWorldModel } from "../scripts/lib/incremental-refresh.mjs";
import { queryProjectGraph } from "../scripts/lib/project-graph.mjs";
import { readGraphRecord } from "../scripts/lib/discovery-index.mjs";
import { verifyHistoricalInventoryEntries } from "../scripts/lib/historical-artifact-boundary-store.mjs";
import { decodeSnapshotBytes, readSnapshotFile } from "../scripts/lib/snapshot-storage-codec.mjs";
import { ensureProjectStorageIgnore, ensureOwnedSnapshotStoreIgnore, GENERATED_STORAGE_IGNORE_RULES } from "../scripts/lib/project-storage-ignore.mjs";
import { inspectSnapshotGarbageCollection } from "../scripts/lib/snapshot-gc.mjs";
import { compileContext } from "../scripts/lib/context-compiler.mjs";
import { diffGraphLineage } from "../scripts/lib/graph-lineage.mjs";
import { runCommand } from "../scripts/lode.mjs";
import { spawn } from "node:child_process";
import { createSnapshotBatchDecoder } from "../scripts/lib/git-snapshot-batch.mjs";
const pluginRoot=path.resolve(import.meta.dirname,"..");
const digest=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
function fixture(t,legacy=false){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"lode-snapshot-storage-")));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 if(legacy)seedLegacyProject(root,pluginRoot);else initializeProject({root,pluginRoot,runtimes:["codex"]});
 const storage=inspectProject(root).storage;return {root,storage,world:new LocalJsonWorldModelStoreAdapter({projectRoot:root,storage}),graph:new LocalJsonGraphProjectionAdapter({projectRoot:root,storage})};}
const product={schemaVersion:1,featureGroups:[{key:"editing",name:"Editing",description:"Edit a document."}],capabilities:[],features:[],requirements:[],constraints:[],decisions:[]};
function source(f,text="def compute_value():\n    return 1\n"){fs.writeFileSync(path.join(f.root,"module.py"),text);fs.writeFileSync(path.join(f.root,f.storage.directory,"context/product-model.json"),JSON.stringify(product)+"\n");}
const wid=n=>"world-model-"+String(n).padStart(24,"0");
test("local prepared traversal detaches aliases and revalidates each request without a new gate",async t=>{
 const f=fixture(t);source(f);const built=await buildWorldModel({root:f.root});
 const {queryTemporalProvenanceGraph}=await import('../scripts/lib/temporal-provenance.mjs');
 const {buildPreparedTraversalRequest}=await import('../scripts/lib/graph-projection-adapter.mjs');
 const graph=built.snapshot.temporalProvenanceGraph,result=queryTemporalProvenanceGraph(graph,{query:'compute_value',depth:1});
 const request=buildPreparedTraversalRequest({graph,result,storage:f.storage}),external=structuredClone(graph);
 t.mock.method(f.graph,'readSnapshot',async()=>({document:external}));
 const first=await f.graph.queryPrepared(request);assert(first.verificationId);assert(!Object.isFrozen(external));assert(!Object.isFrozen(external.nodes));
 external.unusedFunction=()=>{};assert.equal((await f.graph.queryPrepared(request)).verificationId,first.verificationId);
 delete external.unusedFunction;external.nodes[0].unknownExtension='mutated after prior request';
 await assert.rejects(f.graph.queryPrepared(request),{code:'TEMPORAL_GRAPH_DIGEST_MISMATCH'});
 t.mock.method(f.graph,'readSnapshot',async()=>{throw Object.assign(new Error('synthetic denied'),{code:'EACCES'})});
 await assert.rejects(f.graph.queryPrepared(request),{code:'EACCES'});
 await assert.rejects(f.graph.queryPrepared({...request,verified:true}),{code:'INVALID_PREPARED_TRAVERSAL_REQUEST'});
});
test("new compact gzip and untouched legacy JSON share existing World/Graph adapters in both storage families",async t=>{
 for(const legacy of [false,true])await t.test(legacy?"head":"lode",async t=>{const f=fixture(t,legacy);source(f);
 const built=await buildWorldModel({root:f.root}),id=built.snapshot.worldModelId,graphId=built.snapshot.temporalProvenanceGraph.graphSnapshotId;
 assert(f.world.snapshotLocation(id).endsWith(".json.gz"));assert(f.graph.snapshotLocation(graphId).endsWith(".json.gz"));
 assert.deepEqual((await f.world.readSnapshot(id)).document,built.snapshot);assert.deepEqual((await f.graph.readSnapshot(graphId)).document,built.snapshot.temporalProvenanceGraph);
 const gzip=f.world.snapshotLocation(id),raw=gzip.slice(0,-3),pretty=JSON.stringify(built.snapshot,null,2)+"\n";
 fs.writeFileSync(raw,pretty,{flag:"wx"});fs.unlinkSync(gzip);const before=fs.readFileSync(raw);
 assert.equal((await buildWorldModel({root:f.root})).snapshot.worldModelId,id);assert(fs.readFileSync(raw).equals(before));assert.deepEqual((await f.world.listSnapshotIds()),[id]);
 source(f,"def compute_value():\n    return 2\n");const refreshed=await refreshWorldModel({root:f.root});assert.equal(refreshed.status,"refreshed");
 const current=(await readWorldModelForDiscovery({root:f.root}));assert.notEqual(current.snapshot.worldModelId,id);assert.equal((await readWorldModelForDiscovery({root:f.root,worldModelId:id})).snapshot.worldModelHash,built.snapshot.worldModelHash);
 assert(f.world.snapshotLocation(current.snapshot.worldModelId).endsWith(".gz"));assert(fs.readFileSync(raw).equals(before));
 assert.equal((await refreshWorldModel({root:f.root})).status,"unchanged");
 const result=await queryProjectGraph({root:f.root,query:"compute_value",maxNodes:32,maxEdges:64});assert(result.nodes.length,JSON.stringify(result));assert.equal(result.authority.recoveryAuthority,false);
 });});
test("gzip decoding is bounded and rejects corrupt, truncated and conflicting representations",async t=>{
 const f=fixture(t),id=wid(1),doc={kind:"SyntheticSnapshot",worldModelId:id,payload:"synthetic ".repeat(100)};
 const written=(await f.world.writeSnapshot(id,doc));assert(written.created);assert.deepEqual(readSnapshotFile(written.location).document,doc);
 const bytes=fs.readFileSync(written.location);
 assert.throws(()=>decodeSnapshotBytes(bytes,{compressed:true,decodedBytes:32}),/bound/);
 assert.throws(()=>decodeSnapshotBytes(bytes,{compressed:true,compressedBytes:1}),/bound/);
 for(const bad of [bytes.subarray(0,bytes.length-4),Buffer.from("invalid gzip")])assert.throws(()=>decodeSnapshotBytes(bad,{compressed:true}));
 const relative=path.relative(f.root,written.location).replaceAll("\\","/");const record=readGraphRecord(f.root,relative);assert.equal(record.digest,digest(bytes));assert.deepEqual(record.document,doc);
 const raw=written.location.slice(0,-3);fs.writeFileSync(raw,JSON.stringify(doc));(await assert.rejects(async ()=>(await f.world.readSnapshot(id)),{code:"SNAPSHOT_REPRESENTATION_CONFLICT"}));
});
test("snapshot publication failure keeps the old pointer and removes only its own stage",async t=>{
 const f=fixture(t),id=wid(1);(await f.world.writeSnapshot(id,{worldModelId:id}));f.world.writePointer({worldModelId:id});const pointer=fs.readFileSync(f.world.pointerLocation());
 t.mock.method(fs,"linkSync",()=>{throw Object.assign(new Error("Synthetic publication failure"),{code:"EIO"});});
 (await assert.rejects(async ()=>(await f.world.writeSnapshot(wid(2),{worldModelId:wid(2)})),/Synthetic publication/));
 assert(fs.readFileSync(f.world.pointerLocation()).equals(pointer));assert.deepEqual((await f.world.listSnapshotIds()),[id]);
 assert(!fs.readdirSync(path.dirname(f.world.snapshotLocation(id))).some(name=>name.endsWith(".tmp")));
});
test("historical inventory pins exact JSON or gzip bytes without rewriting either path",async t=>{
 const f=fixture(t),id=wid(3);const stored=(await f.world.writeSnapshot(id,{worldModelId:id,text:"bounded original"}));
 const entries=[];for(const [directory,role,prefix] of [["candidate-sets","historical-candidate-set","onboarding-candidates"],["review-decisions","historical-review","onboarding-review-decision"],["product-model-revisions","historical-product-revision","product-model"]]){
 const artifactId=prefix+"-"+"a".repeat(24),relative=f.storage.directory+"/onboarding/"+directory+"/"+artifactId+".json",file=path.join(f.root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,"{}\n");const bytes=fs.readFileSync(file);
 entries.push({path:relative,role,artifactId,protocolFamily:"synthetic",protocolVersion:"0.1.0",byteLength:bytes.length,sha256:digest(bytes),interpretationMode:"opaque-historical"});}
 const bytes=fs.readFileSync(stored.location);entries.push({path:path.relative(f.root,stored.location).replaceAll("\\","/"),role:"legacy-world-embedding-reference",artifactId:id,protocolFamily:"synthetic",protocolVersion:"0.1.0",byteLength:bytes.length,sha256:digest(bytes),interpretationMode:"opaque-historical"});entries.sort((a,b)=>a.path.localeCompare(b.path,"en"));
 assert.equal(verifyHistoricalInventoryEntries(entries,{projectRoot:f.root,projectId:f.storage.projectId,storage:f.storage}),entries);
 fs.writeFileSync(stored.location,zlib.gzipSync(JSON.stringify({worldModelId:id,text:"changed original"})));
 assert.throws(()=>verifyHistoricalInventoryEntries(entries,{projectRoot:f.root,storage:f.storage}),{code:"HISTORICAL_BOUNDARY_INTEGRITY_DRIFT"});
});

test("init and resume preserve existing storage ignore files and tracked content",t=>{
 for(const legacy of [false,true]){
 const f=fixture(t,legacy);
 if(legacy){fs.writeFileSync(path.join(f.root,"CLAUDE.md"),"User-owned instructions\n");fs.writeFileSync(path.join(f.root,".mcp.json"),"{}\n");}
 const ignore=path.join(f.root,f.storage.directory,".gitignore");
 if(fs.existsSync(ignore))fs.unlinkSync(ignore);
 const user=Buffer.from("# 사용자 규칙\r\n/user-cache/\r\n");fs.writeFileSync(ignore,user);
 const tracked=path.join(f.root,f.storage.directory,"graph-discovery/index.json");
 if(!fs.existsSync(tracked)){fs.mkdirSync(path.dirname(tracked),{recursive:true});fs.writeFileSync(tracked,"{}\n");}
 const before=fs.readFileSync(tracked).toString("hex");
 const originalManifest=fs.readFileSync(path.join(f.root,f.storage.directory,"generated/manifest.json"));
 const first=ensureProjectStorageIgnore({root:f.root,storage:f.storage});assert.equal(first.status,"preserved");const combined=fs.readFileSync(ignore);
 assert(combined.equals(user));
 for(const rule of GENERATED_STORAGE_IGNORE_RULES)assert(!combined.toString().includes(rule.pattern));
 const second=convergeProjectInstallation({root:f.root,pluginRoot});assert.equal(second.generatedIgnore.status,"preserved");assert(fs.readFileSync(ignore).equals(combined));
 assert.equal(fs.readFileSync(tracked).toString("hex"),before);assert(fs.readFileSync(path.join(f.root,f.storage.directory,"generated/manifest.json")).equals(originalManifest));
 assert.equal(inspectProject(f.root).status,"ready");
 }
});

const tree=root=>fs.readdirSync(root,{recursive:true}).filter(relative=>fs.statSync(path.join(root,relative)).isFile()).sort().map(relative=>[relative,digest(fs.readFileSync(path.join(root,relative)))]);
test("storage inspection traces retained history and reports unreferenced bytes but never claims safe deletion",async t=>{
 const f=fixture(t);source(f);const first=await buildWorldModel({root:f.root});
 const capsule=(await compileContext({root:f.root,task:"Inspect compute_value",budget:32768,persist:true}));assert.equal(capsule.status,"compiled");
 source(f,"def compute_value():\n    return 2\n");const second=await refreshWorldModel({root:f.root});assert.equal(second.status,"refreshed");
 const currentId=(await readWorldModelForDiscovery({root:f.root})).snapshot.worldModelId;
 source(f,"def compute_value():\n    return 3\n");const orphan=await buildWorldModel({root:f.root,persist:false});(await f.world.writeSnapshot(orphan.snapshot.worldModelId,orphan.snapshot));(await f.graph.writeSnapshot(orphan.snapshot.temporalProvenanceGraph.graphSnapshotId,orphan.snapshot.temporalProvenanceGraph));
 source(f,"def compute_value():\n    return 2\n");const before=tree(f.root);
 const report=inspectSnapshotGarbageCollection({root:f.root});assert.equal(report.status,"gc_dry_run");assert.equal(report.deletedCount,0);assert.equal(report.applyAvailable,false);assert(report.observedUnreferencedBytes>0);
 assert(report.snapshots.some(row=>row.id===first.snapshot.worldModelId&&row.reasonCode==="RETAINED_REFERENCE_CLOSURE"));
 assert(report.snapshots.some(row=>row.id===currentId&&row.reasonCode==="RETAINED_REFERENCE_CLOSURE"));
 assert(report.snapshots.some(row=>row.id===orphan.snapshot.worldModelId&&!row.observedReference));
 assert.deepEqual(report.uncoveredWriters,[]);assert.deepEqual(tree(f.root),before);
 const requested=await runCommand(["storage-gc",f.root,"--apply"]);assert.equal(requested.status,"gc_preserved");assert.equal(requested.code,"SNAPSHOT_GC_REFERENCE_COVERAGE_INCOMPLETE");assert.equal(requested.reclaimedBytes,0);assert.deepEqual(tree(f.root),before);
 const difference=(await diffGraphLineage({root:f.root,fromWorldModelId:first.snapshot.worldModelId,toWorldModelId:currentId}));assert(difference);assert.equal((await readWorldModelForDiscovery({root:f.root,worldModelId:first.snapshot.worldModelId})).snapshot.worldModelHash,first.snapshot.worldModelHash);
 fs.writeFileSync(path.join(f.root,f.storage.directory,"unknown-reference.json"),JSON.stringify({schemaVersion:999,worldModelId:orphan.snapshot.worldModelId}));
 const unknown=inspectSnapshotGarbageCollection({root:f.root,apply:true});assert(unknown.coverage.issues.some(issue=>issue.reasonCode==="UNKNOWN_REFERENCE_SCHEMA"));assert.equal(unknown.deletedCount,0);
});
test("same-input index and refresh observations preserve IDs or disclose actual provenance differences",async t=>{
 const f=fixture(t);source(f);const first=await buildWorldModel({root:f.root}),noOp=await buildWorldModel({root:f.root});assert.equal(first.snapshot.worldModelId,noOp.snapshot.worldModelId);
 assert.equal((await refreshWorldModel({root:f.root})).status,"unchanged");
 source(f,"def compute_value():\n    return 4\n");await refreshWorldModel({root:f.root});
 const before=(await readWorldModelForDiscovery({root:f.root})).snapshot;
 const index=await buildWorldModel({root:f.root});const refresh=await refreshWorldModel({root:f.root});const repeat=await buildWorldModel({root:f.root});
 assert.equal(refresh.status,"unchanged");assert.equal(index.snapshot.worldModelId,repeat.snapshot.worldModelId);
 t.diagnostic(JSON.stringify({scenario:"controlled alternating index/refresh",before:before.worldModelId,index:index.snapshot.worldModelId,repeat:repeat.snapshot.worldModelId,refresh:refresh.status,
 priorParents:before.temporalProvenanceGraph.parentSourceSnapshotIds,indexParents:index.snapshot.temporalProvenanceGraph.parentSourceSnapshotIds,interpretation:"Identity differences retain their actual parent/provenance inputs; no ID components were removed."}));
});
test("semantic snapshot tampering is rejected through existing typed readers without current substitution",async t=>{
 const f=fixture(t);source(f);const first=await buildWorldModel({root:f.root}),file=f.world.snapshotLocation(first.snapshot.worldModelId);
 const changed={...first.snapshot,worldModelHash:"0".repeat(64)};fs.writeFileSync(file,zlib.gzipSync(JSON.stringify(changed)));
 (await assert.rejects(async ()=>(await readWorldModelForDiscovery({root:f.root}))));(await assert.rejects(async ()=>(await readWorldModelForDiscovery({root:f.root,worldModelId:first.snapshot.worldModelId}))));
});

test("a conflicting physical file appearing at publication cannot advance the pointer or be hidden",async t=>{
 const f=fixture(t),id=wid(9),old=wid(8);(await f.world.writeSnapshot(old,{worldModelId:old}));f.world.writePointer({worldModelId:old});const pointer=fs.readFileSync(f.world.pointerLocation());
 const original=fs.linkSync;let raced=false;
 t.mock.method(fs,"linkSync",function(from,to){const out=original.call(this,from,to);if(String(to).endsWith(id+".json.gz")){raced=true;fs.writeFileSync(String(to).slice(0,-3),JSON.stringify({worldModelId:id}));}return out;});
 (await assert.rejects(async ()=>(await f.world.writeSnapshot(id,{worldModelId:id})),{code:"SNAPSHOT_REPRESENTATION_CONFLICT"}));assert(raced);assert(fs.readFileSync(f.world.pointerLocation()).equals(pointer));
 (await assert.rejects(async ()=>(await f.world.readSnapshot(id)),{code:"SNAPSHOT_REPRESENTATION_CONFLICT"}));
});
test("optional ignore problems preserve ordinary readiness and gzip readers preserve original error semantics",async t=>{
 const f=fixture(t),ignore=path.join(f.root,f.storage.directory,".gitignore");assert(fs.existsSync(ignore));
 fs.writeFileSync(ignore,Buffer.from([255,254,0]));const before=fs.readFileSync(ignore);const result=convergeProjectInstallation({root:f.root,pluginRoot});assert.equal(result.generatedIgnore.status,"preserved");assert(fs.readFileSync(ignore).equals(before));assert.equal(inspectProject(f.root).status,"ready");
 const other=fixture(t),untouched=tree(other.root);const mismatch=ensureProjectStorageIgnore({root:other.root,storage:f.storage});assert.equal(mismatch.reasonCode,"PROJECT_IDENTITY_MISMATCH");assert.deepEqual(tree(other.root),untouched);
 const id=wid(7),entry=(await f.world.writeSnapshot(id,{worldModelId:id}));fs.writeFileSync(entry.location,"{invalid gzip");(await assert.rejects(async ()=>(await f.world.readSnapshot(id)),{code:"INVALID_WORLD_MODEL_STORE_DOCUMENT"}));
});

test("generated ignore never overrides explicit user negations in storage or Project rules",t=>{
 for(const where of ["storage","project"]){const f=fixture(t),file=path.join(f.root,f.storage.directory,".gitignore");fs.unlinkSync(file);
 const target=where==="storage"?file:path.join(f.root,".gitignore"),bytes=Buffer.from("!/**/graph-discovery/index.json\n");fs.writeFileSync(target,bytes);
 const result=ensureProjectStorageIgnore({root:f.root,storage:f.storage});assert.equal(result.reasonCode,where==="storage"?"EXISTING_STORAGE_IGNORE":"USER_IGNORE_RULES_TAKE_PRECEDENCE");assert(fs.readFileSync(target).equals(bytes));if(where==="project")assert(!fs.existsSync(file));assert.equal(inspectProject(f.root).status,"ready");}
});

test("scoped ignore exceptions match Git's oracle and preserve tracking, private stores and policy races",async t=>{
 const f=fixture(t),rootIgnore=path.join(f.root,".gitignore"),file=path.join(f.root,f.storage.directory,".gitignore");
 async function git(args){
  t.diagnostic(JSON.stringify({event:"planned-ignore-oracle",command:"git",args,cwd:f.root,parent:process.pid,ports:[]}));
  return await new Promise((resolve,reject)=>{const child=spawn("git",args,{cwd:f.root,shell:false,windowsHide:true,stdio:["ignore","pipe","pipe"]});let stdout="",stderr="";
   const timer=setTimeout(()=>child.kill(),15000);child.once("spawn",()=>t.diagnostic(JSON.stringify({event:"started-ignore-oracle",pid:child.pid,parent:process.pid,ports:[]})));
   child.stdout.on("data",b=>stdout+=b);child.stderr.on("data",b=>stderr+=b);child.once("error",e=>{clearTimeout(timer);reject(e)});
   child.once("close",code=>{clearTimeout(timer);t.diagnostic(JSON.stringify({event:"closed-ignore-oracle",pid:child.pid,code,ports:[]}));resolve({code,stdout,stderr})});});
 }
 assert.equal((await git(["init","-q"])).code,0);
 const transient=f.storage.directory+"/graph-discovery/index.json",docs="docs/keep.tmp";
 fs.mkdirSync(path.join(f.root,"docs"));fs.writeFileSync(path.join(f.root,docs),"user document");
 const cases=[
  ["*.tmp\n!/docs/keep.tmp\n",true], ["!docs/keep.tmp\n",true], ["\\!literal\n",true], ["  !literal\n",true],
  ["\ufeff!docs/keep.tmp\r\n",true], ["!/.lode/graph-discovery/index.json\n",true,false], ["!**/graph-discovery/index.json\n",false],
  ["!/.lode/graph-discovery   \n",true,false], ["!/docs/keep.tmp   \n",true],
  ["!keep-this.txt\n",true], ["!docs/\n",false], ["/.lode/\n!/docs/keep.tmp\n",true],
 ];
 for(const [text,created,indexIncluded=true] of cases){fs.unlinkSync(file);fs.writeFileSync(rootIgnore,text);const before=await git(["check-ignore","--no-index","-v",docs]),beforeIndex=await git(["check-ignore","--no-index","-v",transient]);
  const result=ensureProjectStorageIgnore({root:f.root,storage:f.storage});assert.equal(result.status,created?"created":"preserved",text);assert.equal(fs.readFileSync(rootIgnore,"utf8"),text);
  const after=await git(["check-ignore","--no-index","-v",docs]);assert.deepEqual(after,before,text);
  const transientResult=await git(["check-ignore","--no-index","-v",transient]);if(created&&indexIncluded)assert.match(transientResult.stdout,/graph-discovery\/index.json|\.lode\//);else assert.deepEqual(transientResult,beforeIndex,text);
  if(!fs.existsSync(file))fs.writeFileSync(file,"# synthetic reset only\n");
 }
 for(const policy of ["!.gitkeep\n","!keep-this.txt\n"]){
  fs.unlinkSync(file);fs.writeFileSync(rootIgnore,policy);
  const keep=f.storage.directory+"/.operations/.gitkeep";fs.mkdirSync(path.dirname(path.join(f.root,keep)),{recursive:true});fs.writeFileSync(path.join(f.root,keep),"user keep\n");
  const before=await git(["check-ignore","--no-index","-v",keep]);
  const partial=ensureProjectStorageIgnore({root:f.root,storage:f.storage});
  assert.equal(partial.status,"created");assert.deepEqual(partial.rules.included,["/graph-discovery/index.json"]);
  assert.equal(partial.rules.skipped.length,GENERATED_STORAGE_IGNORE_RULES.length-1);
  assert.deepEqual(await git(["check-ignore","--no-index","-v",keep]),before);
  assert.equal(fs.readFileSync(rootIgnore,"utf8"),policy);
  assert.equal((await git(["check-ignore","--no-index",transient])).code,0);
 }
 fs.unlinkSync(file);fs.writeFileSync(rootIgnore,"!/docs/keep.tmp\n");assert.equal(ensureProjectStorageIgnore({root:f.root,storage:f.storage}).status,"created");
 const tracked=path.join(f.root,transient);fs.mkdirSync(path.dirname(tracked),{recursive:true});fs.writeFileSync(tracked,"retained tracked bytes\n");
 assert.equal((await git(["add","-f","--",transient])).code,0);assert.equal((await git(["check-ignore","--",transient])).code,1);assert.equal(fs.readFileSync(tracked,"utf8"),"retained tracked bytes\n");
 const owned=path.join(f.root,f.storage.directory,"snapshot-objects.git");fs.mkdirSync(owned);assert.equal(ensureOwnedSnapshotStoreIgnore({root:f.root,storage:f.storage,directory:owned}).status,"created");
 assert.match((await git(["check-ignore","--no-index","-v",f.storage.directory+"/snapshot-objects.git/objects/example"])).stdout,/snapshot-objects.git\/\.gitignore/);
 fs.unlinkSync(file);const original=fs.readFileSync;let reads=0;
 t.mock.method(fs,"readFileSync",function(target,...args){const bytes=original.call(this,target,...args);if(String(target)===rootIgnore&&++reads===1)fs.writeFileSync(rootIgnore,"!/.lode/graph-discovery/index.json\n");return bytes;});
 const raced=ensureProjectStorageIgnore({root:f.root,storage:f.storage});assert.equal(raced.status,"preserved");assert.equal(raced.reasonCode,"USER_IGNORE_CHANGED_CONCURRENTLY");assert(!fs.existsSync(file));assert.equal(inspectProject(f.root).status,"ready");
});

test("CLI distinguishes successful inspection from unavailable requested apply and keeps the useful zero-deletion report",async t=>{
 const f=fixture(t),script=path.join(pluginRoot,"scripts/lode.mjs");fs.writeFileSync(path.join(f.root,f.storage.directory,"future.json"),JSON.stringify({schemaVersion:999,kind:"FutureRoot"}));const before=tree(f.root);
 const invoke=apply=>new Promise((resolve,reject)=>{
   const args=[script,"storage-gc",f.root,...(apply?["--apply"]:[]),"--json"];
   t.diagnostic(JSON.stringify({event:"planned-storage-cli",command:process.execPath,args,cwd:f.root,parent:process.pid,ports:[]}));
   const child=spawn(process.execPath,args,{cwd:f.root,shell:false,windowsHide:true,stdio:["ignore","pipe","pipe"]});
   let stdout="",stderr="";const timer=setTimeout(()=>child.kill(),30_000);
   child.once("spawn",()=>t.diagnostic(JSON.stringify({event:"started-storage-cli",pid:child.pid,parent:process.pid,ports:[]})));
   child.stdout.on("data",chunk=>{stdout+=chunk;});child.stderr.on("data",chunk=>{stderr+=chunk;});
   child.once("error",error=>{clearTimeout(timer);reject(error);});
   child.once("close",(code,signal)=>{clearTimeout(timer);t.diagnostic(JSON.stringify({event:"closed-storage-cli",pid:child.pid,code,signal,ports:[]}));resolve({code,signal,stdout,stderr});});
 });
 const dry=await invoke(false);assert.equal(dry.code,0,dry.stderr);assert.equal(JSON.parse(dry.stdout).status,"gc_dry_run");
 const apply=await invoke(true);assert.equal(apply.code,1,apply.stderr);assert.equal(apply.signal,null);assert.equal(apply.stderr,"","normal cleanup output stays quiet; process details require diagnostics");
 const report=JSON.parse(apply.stdout);assert.equal(report.code,"SNAPSHOT_GC_REFERENCE_COVERAGE_INCOMPLETE");assert.equal(report.deletedCount,0);assert.equal(report.reclaimedBytes,0);assert.equal(report.applyPerformed,false);assert(report.coverage.issues.length);assert.deepEqual(tree(f.root),before);
});

test("review F1: existing user ignore is never opened for append and an intervening create wins",t=>{
 const f=fixture(t),file=path.join(f.root,f.storage.directory,".gitignore"),user=Buffer.from("# user-owned rules\n/user-cache/\n");fs.writeFileSync(file,user);
 const open=fs.openSync;let appendAttempts=0;
 t.mock.method(fs,"openSync",function(target,flags,...args){if(typeof target==="string"&&path.resolve(target)===path.resolve(file)&&typeof flags==="number"&&(flags&fs.constants.O_APPEND)){appendAttempts++;const fd=open(file,fs.constants.O_WRONLY|fs.constants.O_APPEND);try{fs.writeFileSync(fd,"!/graph-discovery/index.json\n");}finally{fs.closeSync(fd);}}return open.call(this,target,flags,...args);});
 const first=ensureProjectStorageIgnore({root:f.root,storage:f.storage});assert.equal(first.status,"preserved");assert.equal(appendAttempts,0);assert(fs.readFileSync(file).equals(user));t.mock.restoreAll();
 fs.unlinkSync(file);const link=fs.linkSync,intervening=Buffer.from("!/graph-discovery/index.json\n");let created=false;
 t.mock.method(fs,"linkSync",function(from,to){if(path.resolve(String(to))===path.resolve(file)){fs.writeFileSync(to,intervening,{flag:"wx"});created=true;}return link.call(this,from,to);});
 const raced=ensureProjectStorageIgnore({root:f.root,storage:f.storage});assert(created);assert.equal(raced.status,"preserved");assert(fs.readFileSync(file).equals(intervening));assert.equal(inspectProject(f.root).status,"ready");
});
test("review F2: adapter parser codes survive retained and EEXIST reuse without hiding operational errors",async t=>{
 for(const [family,Adapter,prefix,field,errorCode] of [["World",LocalJsonWorldModelStoreAdapter,"world-model","worldModelId","INVALID_WORLD_MODEL_STORE_DOCUMENT"],["Graph",LocalJsonGraphProjectionAdapter,"graph-snapshot","graphSnapshotId","INVALID_GRAPH_PROJECTION_DOCUMENT"]]){
 const f=fixture(t),adapter=new Adapter({projectRoot:f.root,storage:f.storage}),id=n=>prefix+"-"+String(n).padStart(24,"0"),valid=id(20);
 (await adapter.writeSnapshot(valid,{[field]:valid}));adapter.writePointer({[field]:valid});const pointer=fs.readFileSync(adapter.pointerLocation());
 const malformed=id(21),raw=adapter.snapshotLocation(malformed).replace(/\.gz$/,"");fs.writeFileSync(raw,"{ invalid retained JSON\n");const original=fs.readFileSync(raw);
 (await assert.rejects(async ()=>(await adapter.readSnapshot(malformed)),{code:errorCode},family+" read"));(await assert.rejects(async ()=>(await adapter.writeSnapshot(malformed,{})),{code:errorCode},family+" same-ID reuse"));assert(fs.readFileSync(raw).equals(original));
 const collision=id(22),link=fs.linkSync;let collided=false;
 t.mock.method(fs,"linkSync",function(from,to){if(String(to).endsWith(collision+".json.gz")){collided=true;fs.writeFileSync(to,zlib.gzipSync("{ malformed concurrent snapshot\n"),{flag:"wx"});throw Object.assign(new Error("Synthetic existing destination"),{code:"EEXIST"});}return link.call(this,from,to);});
 (await assert.rejects(async ()=>(await adapter.writeSnapshot(collision,{[field]:collision})),{code:errorCode},family+" EEXIST parser"));assert(collided);const racedBytes=fs.readFileSync(adapter.snapshotLocation(collision));t.mock.restoreAll();
 t.mock.method(fs,"linkSync",()=>{throw Object.assign(new Error("Synthetic I/O failure"),{code:"EIO"});});(await assert.rejects(async ()=>(await adapter.writeSnapshot(id(23),{[field]:id(23)})),{code:"EIO"}));t.mock.restoreAll();
 const bounded=id(24),entry=(await adapter.writeSnapshot(bounded,{[field]:bounded})),lstat=fs.lstatSync;
 t.mock.method(fs,"lstatSync",function(target,...args){const stat=lstat.call(this,target,...args);if(path.resolve(String(target))===path.resolve(entry.location)&&stat)return new Proxy(stat,{get(object,key,receiver){return key==="size"?256*1024*1024+1:Reflect.get(object,key,receiver);}});return stat;});
 (await assert.rejects(async ()=>(await adapter.writeSnapshot(bounded,{})),{code:"SNAPSHOT_STORAGE_LIMIT"},family+" stored bound"));(await assert.rejects(async ()=>(await adapter.readSnapshot(bounded)),{code:"SNAPSHOT_STORAGE_LIMIT"},family+" read bound"));t.mock.restoreAll();
 fs.writeFileSync(entry.location.slice(0,-3),"{}");(await assert.rejects(async ()=>(await adapter.writeSnapshot(bounded,{})),{code:"SNAPSHOT_REPRESENTATION_CONFLICT"}));
 assert(fs.readFileSync(adapter.pointerLocation()).equals(pointer));assert(fs.readFileSync(raw).equals(original));assert(fs.readFileSync(adapter.snapshotLocation(collision)).equals(racedBytes));
 }
});


test("private Git candidate connects default World Context Graph lineage Explorer CLI and MCP reads", async t => {
 const f=fixture(t); source(f);
 const events=[]; const gitOptions={onProcess:event=>events.push(event)};
 const world=new LocalJsonWorldModelStoreAdapter({projectRoot:f.root,storage:f.storage,snapshotEncoding:"git",gitOptions});
 const graph=new LocalJsonGraphProjectionAdapter({projectRoot:f.root,storage:f.storage,snapshotEncoding:"git",gitOptions});
 const built=await buildWorldModel({root:f.root,storeAdapter:world,graphProjectionAdapter:graph});
 assert.equal(built.file,null);assert.equal(built.snapshotStorage.kind,"local-git-object");assert.equal(built.graphProjection.snapshotLocation,null);
 assert(fs.existsSync(built.pointerFile));assert(fs.existsSync(built.graphProjection.pointerLocation));
 const before=tree(f.root);
 const current=await readWorldModelForDiscovery({root:f.root});
 assert.equal(current.snapshot.worldModelId,built.snapshot.worldModelId);assert.equal(current.file,null);assert.equal(current.snapshotStorage.kind,"local-git-object");
 const context=await compileContext({root:f.root,task:"inspect compute_value",budget:32768,persist:false});assert.equal(context.status,"preview");
 const queried=await queryProjectGraph({root:f.root,query:"compute_value",maxNodes:32,maxEdges:64});assert(queried.nodes.length);
 const explorer=await buildGraphExplorerSnapshot({root:f.root,query:"compute_value",history:true});assert(explorer);
 const cli=await runCommand(["world-status",f.root]);assert.equal(cli.status,"current");
 const mcp=await dispatch({method:"tools/call",params:{name:"head_world_model",arguments:{project_root:f.root}}});assert(mcp);assert.equal(mcp.error,undefined);assert.equal(JSON.parse(mcp.result.content[0].text).status,"current");
 assert.deepEqual(tree(f.root),before);
 const store=new GitSnapshotStore({projectRoot:f.root,storage:f.storage});
 assert.deepEqual(await store.list("world-model"),[built.snapshot.worldModelId]);
 assert.equal(await store.read(wid(999)),null);
 const fresh=await store.read(built.snapshot.worldModelId);assert.equal(fresh.snapshotStorage.rawSha256,digest(Buffer.from(JSON.stringify(built.snapshot)+"\n")));
 assert.equal((await inspectWorldModel({root:f.root})).status,"current");
 fs.mkdirSync(path.join(store.directory,"objects/pack"),{recursive:true});
 const privateTemporary=path.join(store.directory,"objects/pack/synthetic-physical-only.tmp");fs.writeFileSync(privateTemporary,"physical storage activity, not product evidence");
 assert.equal((await inspectWorldModel({root:f.root})).status,"current");fs.unlinkSync(privateTemporary);
 source(f,"def compute_value():\n    return 99\n");assert.equal((await inspectWorldModel({root:f.root})).status,"stale");
 assert.deepEqual(snapshotGitProcessStatus(),[]);
 assert(events.some(e=>e.event==="started"));assert.equal(events.filter(e=>e.event==="started").length,events.filter(e=>e.event==="closed").length);
 t.diagnostic(JSON.stringify({gitChildren:events.filter(e=>e.event==="started").length,allClosed:true,backend:"explicit-candidate; default writer remains gzip"}));
});


test("private Git store rejects forged identity, corrupt object and cancelled work without publishing refs", async t => {
 const f=fixture(t);source(f);const world=(await buildWorldModel({root:f.root,persist:false})).snapshot;
 const events=[],store=new GitSnapshotStore({projectRoot:f.root,storage:f.storage,onProcess:e=>events.push(e)});
 await assert.rejects(()=>store.write(world.worldModelId,{...world,projectId:"wrong-project"}),{code:"SNAPSHOT_GIT_IDENTITY_MISMATCH"});
 const [first,second]=await Promise.all([store.write(world.worldModelId,world),store.write(world.worldModelId,world)]);
 assert.equal(first.snapshotStorage.objectId,second.snapshotStorage.objectId);
 await assert.rejects(()=>store.write(world.worldModelId,{...world,unexpected:"conflict"}),{code:"SNAPSHOT_GIT_IMMUTABLE_CONFLICT"});
 const realResolve=store.resolve.bind(store);store.resolve=async()=>first.snapshotStorage.objectId;
 await assert.rejects(()=>store.read(world.worldModelId),{code:"SNAPSHOT_GIT_OBJECT_TYPE_MISMATCH"});store.resolve=realResolve;
 const owner=path.join(store.directory,"lode-owner.json"),ownerBytes=fs.readFileSync(owner);
 fs.writeFileSync(owner,JSON.stringify({...store.owner,projectId:"wrong-project"}));
 await assert.rejects(()=>store.read(world.worldModelId),{code:"SNAPSHOT_GIT_OWNER_MISMATCH"});fs.writeFileSync(owner,ownerBytes);
 const object=path.join(store.directory,"objects",first.snapshotStorage.objectId.slice(0,2),first.snapshotStorage.objectId.slice(2)),bytes=fs.readFileSync(object);
 const objectMode=fs.statSync(object).mode;fs.chmodSync(object,0o600);
 try { fs.writeFileSync(object,Buffer.from("corrupt synthetic loose object"));
 await assert.rejects(()=>store.read(world.worldModelId),{code:"SNAPSHOT_GIT_COMMAND_FAILED"}); }
 finally { fs.writeFileSync(object,bytes);fs.chmodSync(object,objectMode); }
 assert.equal((await store.read(world.worldModelId)).snapshotStorage.rawSha256,first.snapshotStorage.rawSha256);
 const controller=new AbortController();controller.abort();const cancelled=new GitSnapshotStore({projectRoot:f.root,storage:f.storage,signal:controller.signal});
 await assert.rejects(()=>cancelled.read(world.worldModelId),{code:"SNAPSHOT_GIT_CANCELLED"});
 const activeController=new AbortController(),cancelEvents=[];
 const activeCancelled=new GitSnapshotStore({projectRoot:f.root,storage:f.storage,signal:activeController.signal,onProcess:e=>{cancelEvents.push(e);if(e.event==="started")activeController.abort();}});
 await assert.rejects(()=>activeCancelled.read(world.worldModelId),{code:"SNAPSHOT_GIT_CANCELLED"});
 assert.equal(cancelEvents.filter(e=>e.event==="started").length,1);assert.equal(cancelEvents.filter(e=>e.event==="closed").length,1);
 assert.deepEqual(snapshotGitProcessStatus(),[]);assert.equal(events.filter(e=>e.event==="started").length,events.filter(e=>e.event==="closed").length);
 assert.deepEqual(await store.list("world-model"),[world.worldModelId]);
});


test("private Git batch framing checks exact OID, type, size, binary bytes, EOF and metadata-dependent bounds", () => {
 const blob = Buffer.from([0,10,255,4]), meta = Buffer.from('{"bytes":4}');
 const oid = (type, bytes) => digest(Buffer.concat([Buffer.from(type + ' ' + bytes.length + '\0'), bytes]));
 const frame = (type, bytes) => Buffer.concat([Buffer.from(oid(type,bytes)+' '+type+' '+bytes.length+'\n'), bytes, Buffer.from('\n')]);
 const first = frame('blob',meta), second = frame('blob',blob), all = Buffer.concat([first,second]);
 for(const step of [1,7,64,all.length]){
  let bound=null;const decoder=createSnapshotBatchDecoder([{oid:oid('blob',meta),type:'blob',maximum:64,onObject:bytes=>{bound=JSON.parse(bytes).bytes}}, {oid:oid('blob',blob),type:'blob',maximum:()=>bound}]);
  for(let i=0;i<all.length;i+=step)decoder.push(all.subarray(i,i+step));assert.deepEqual(decoder.finish(),[meta,blob]);
  assert.throws(()=>decoder.push(Buffer.from('x')),{code:'SNAPSHOT_GIT_BATCH_INVALID'});
 }
 const request={oid:oid('blob',blob),type:'blob',maximum:blob.length};
 // The digest must describe returned bytes even if a stream producer reuses
 // its input buffer between body delivery and the terminating newline.
 const borrowed=Buffer.from(second.subarray(0,-1)), owned=createSnapshotBatchDecoder([request]);
 owned.push(borrowed);borrowed[borrowed.length-1]^=1;owned.push(Buffer.from('\n'));
 assert.deepEqual(owned.finish(),[blob]);
 for(const [bytes,code] of [
  [Buffer.from(request.oid+' tree '+blob.length+'\n'),'SNAPSHOT_GIT_OBJECT_TYPE_MISMATCH'],
  [Buffer.from(request.oid+' blob 999999\n'),'SNAPSHOT_STORAGE_LIMIT'],
  [Buffer.from(request.oid+' missing\n'),'SNAPSHOT_GIT_COMMAND_FAILED'],
  [Buffer.from('e'.repeat(64)+' blob 4\n'),'SNAPSHOT_GIT_BATCH_INVALID'],
  [Buffer.concat([Buffer.from(request.oid+' blob 4\n'),Buffer.from([0,10,255,5]),Buffer.from('\n')]),'SNAPSHOT_GIT_OBJECT_DIGEST_MISMATCH'],
  [Buffer.concat([second.subarray(0,-1),Buffer.from('x')]),'SNAPSHOT_GIT_BATCH_INVALID'],
  [Buffer.concat([second,Buffer.from('extra')]),'SNAPSHOT_GIT_BATCH_INVALID'],
 ]){const decoder=createSnapshotBatchDecoder([request]);assert.throws(()=>decoder.push(bytes),{code});}
 const high=Buffer.from(second);high[0]|=128;assert.throws(()=>createSnapshotBatchDecoder([request]).push(high),{code:'SNAPSHOT_GIT_BATCH_INVALID'});
 for(const cut of [0,10,second.length-1]){const decoder=createSnapshotBatchDecoder([request]);decoder.push(second.subarray(0,cut));assert.throws(()=>decoder.finish(),{code:'SNAPSHOT_GIT_BATCH_TRUNCATED'});}
});

test("private Git batch reads use four reaped children and preserve raw bytes, failure and cancellation boundaries",async t=>{
 const f=fixture(t),events=[],store=new GitSnapshotStore({projectRoot:f.root,storage:f.storage,onProcess:event=>events.push(event)});
 const id=wid(42),document={worldModelId:id,projectId:f.storage.projectId,body:'synthetic binary protocol source '.repeat(120)};
 const written=await store.write(id,document);events.length=0;
 const read=await store.read(id);assert.deepEqual(read.document,document);assert.equal(read.snapshotStorage.rawSha256,written.snapshotStorage.rawSha256);
 assert.equal(events.filter(e=>e.event==='started').length,4);assert.equal(events.filter(e=>e.event==='closed').length,4);
 await assert.rejects(store.object(read.snapshotStorage.objectId,'tree',4096,store.context()),{code:'SNAPSHOT_GIT_OBJECT_TYPE_MISMATCH'});
 await assert.rejects(store.object(read.snapshotStorage.objectId,'blob',1,store.context()),{code:'SNAPSHOT_STORAGE_LIMIT'});
 await assert.rejects(store.object('f'.repeat(64),'blob',4096,store.context()),error=>error.code==='SNAPSHOT_GIT_COMMAND_FAILED'&&error.gitMissingObject===true);
 const controller=new AbortController(),cancelEvents=[];
 const cancelled=new GitSnapshotStore({projectRoot:f.root,storage:f.storage,signal:controller.signal,onProcess:e=>{cancelEvents.push(e);if(e.event==='started')controller.abort()}});
 await assert.rejects(cancelled.read(id),{code:'SNAPSHOT_GIT_CANCELLED'});
 assert.equal(cancelEvents.filter(e=>e.event==='started').length,1);assert.equal(cancelEvents.filter(e=>e.event==='closed').length,1);
 await assert.rejects(store.object(read.snapshotStorage.objectId,'blob',4096,{deadline:Date.now()-1}),{code:'SNAPSHOT_GIT_TIMEOUT'});
 assert.deepEqual(snapshotGitProcessStatus(),[]);assert.equal(events.filter(e=>e.event==='started').length,events.filter(e=>e.event==='closed').length);
 assert.deepEqual((await store.read(id)).document,document);
});

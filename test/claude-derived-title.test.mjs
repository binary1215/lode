import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { capturedCodexDisplayMetadata } from "../scripts/lib/codex-display-metadata.mjs";
import { consumeClaudeTitleCapability, correctClaudeDerivedTitle, proposeClaudeDerivedTitle, observeClaudeTitleFile } from "../scripts/lib/claude-derived-title.mjs";
import { codexNativePortabilityProfile } from "../scripts/lib/codex-native-portability.mjs";
import { claudeNativeProjectName } from "../scripts/lib/claude-native-history.mjs";
import { admitDestinationImportTarget } from "../scripts/lib/destination-import-journal.mjs";
import { derivedHash as hash, derivedJson as json } from "../scripts/lib/claude-derived-encoder.mjs";
const line = v => Buffer.from(JSON.stringify(v) + "\n");
const id = "01900000-0000-7000-8000-000000006250", sourceId = "01900000-0000-7000-8000-000000006251";
test("display name wins, long Korean names and duplicate names are not arbitrarily shortened; prompt is never fallback", () => {
 const name="긴 한국어 이름".repeat(30), a=capturedCodexDisplayMetadata({name:" "+name+" ",title:"SYNTHETIC_CREDENTIAL_NOT_TITLE"},sourceId);
 assert.equal(a.title,name);assert.equal(a.sourceNameTrimmedForDisplay,true);
 assert.equal(capturedCodexDisplayMetadata({name},id).title,name);
 for(const state of [{title:"SYNTHETIC_SECRET"},{name:"   ",title:"SYNTHETIC_SECRET"},{}]) {
  const m=capturedCodexDisplayMetadata(state,sourceId);assert.equal(m.title,"Codex conversation · "+sourceId);assert.ok(!JSON.stringify(m).includes("SYNTHETIC_SECRET"));
 }
});
function fixture(t) {
 const base=fs.mkdtempSync(path.join(os.tmpdir(),"lode-title-test-"));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const home=path.join(base,"home"),root=path.join(base,"project"),journalRoot=path.join(base,"journal");
 for(const p of [home,root,journalRoot])fs.mkdirSync(p);
 const relativeFile="projects/"+claudeNativeProjectName(root)+"/"+id+".jsonl",file=path.join(home,relativeFile);fs.mkdirSync(path.dirname(file),{recursive:true});
 const raw=line({type:"user",sessionId:id,uuid:"u1",message:{role:"user",content:"SYNTHETIC ORIGINAL"}});fs.writeFileSync(file,Buffer.concat([raw,line({type:"custom-title",customTitle:"old title",sessionId:id})]));
 const columns=codexNativePortabilityProfile().databases.find(d=>d.file==="state_5.sqlite").tables.find(t=>t.name==="threads").columns.map(c=>c.name).filter(c=>!["creator_user_id","creator_account_id"].includes(c));
 const evidence={schemaVersion:1,kind:"SelectedCodexStateEvidence",authorityPlane:"P3",columns,omittedFields:["creator_user_id","creator_account_id"],
  targetPolicyAuthority:false,grantsRecoveryAuthority:false,rows:[columns.map(c=>["id","name"].includes(c)?{type:"text",value:c==="id"?sourceId:"합성 원본 이름",utf8:Buffer.from(c==="id"?sourceId:"합성 원본 이름").toString("base64")}:{type:"null"})]};
 const artifact={raw,digest:"d".repeat(64),manifest:{target:{nativeId:id,cwd:root},input:{selection:{threadId:sourceId}},source:{nativePayloadDigest:"a".repeat(64)}},
 selected:{native:{selectionBinding:{evidence}}},recheck(){},check(){}};
 const plan=proposeClaudeDerivedTitle({artifact,nativeHome:home,relativeFile}),planFile=path.join(base,"plan.json");fs.writeFileSync(planFile,json(plan));
 const scope={journalRoot,hostId:"synthetic-host",nativeHome:home,projectRoot:root,provider:"claude",assertCurrentAuthority:()=>{}};
 scope.receipt=admitDestinationImportTarget(scope).receipt;
 let writes=0;
 const host={async correctDerivedClaudeTitle({capability, ...binding}){consumeClaudeTitleCapability(capability,binding);writes++;fs.appendFileSync(file,line({type:"custom-title",sessionId:id,customTitle:plan.desiredTitle}));
 const after=observeClaudeTitleFile(home,relativeFile);return {nativeId:id,sdkTitleMatches:true,appendOnlyVerified:true,messageDigest:after.messageDigest,modelCalled:false};}};
 return {base,file,home,root,plan,artifact,host,scope,relativeFile,writes:()=>writes,args:{artifact,plan,planFile,planSha256:hash(json(plan)),destinationScope:scope,host,assertCurrentAuthority:()=>{}}};
}
test("title-only append, full prefix preserved, durable replay calls official Host only once",async t=>{
 const f=fixture(t),before=fs.readFileSync(f.file),r=await correctClaudeDerivedTitle(f.args);
 assert.equal(r.status,"title-corrected");assert.ok(fs.readFileSync(f.file).subarray(0,before.length).equals(before));
 assert.equal((await correctClaudeDerivedTitle(f.args)).status,"title-completed-replay");assert.equal(f.writes(),1);
});
test("uncertain SDK outcome is never replayed, even if rename already appended",async t=>{
 const f=fixture(t),host={async correctDerivedClaudeTitle(binding){await f.host.correctDerivedClaudeTitle(binding);throw Object.assign(Error("synthetic timeout"),{code:"TIMEOUT"});}};
 await assert.rejects(correctClaudeDerivedTitle({...f.args,host}),{code:"TIMEOUT"});
 const r=await correctClaudeDerivedTitle(f.args);assert.equal(r.status,"title-outcome-uncertain");assert.equal(r.currentTitleMatchesDesired,true);assert.equal(f.writes(),1);
});
test("concurrent commands create one attempt; no racing duplicate mutation",async t=>{
 const f=fixture(t);const r=await Promise.allSettled([correctClaudeDerivedTitle(f.args),correctClaudeDerivedTitle(f.args)]);
 assert.equal(f.writes(),1);assert.ok(r.some(x=>x.status==="fulfilled"&&x.value.status==="title-corrected"));
});
test("ordinary metadata appends do not create UX gates; changed title and user body do",async t=>{
 const f=fixture(t);fs.appendFileSync(f.file,line({type:"atis-latch",value:true}));
 assert.equal((await correctClaudeDerivedTitle(f.args)).status,"title-corrected");
 const g=fixture(t);fs.appendFileSync(g.file,line({type:"custom-title",sessionId:id,customTitle:"user changed title"}));
 await assert.rejects(correctClaudeDerivedTitle(g.args),{code:"TITLE_BASELINE_CHANGED"});assert.equal(g.writes(),0);
 const h=fixture(t);fs.appendFileSync(h.file,line({type:"user",sessionId:id,message:{role:"user",content:"new turn"}}));
 await assert.rejects(correctClaudeDerivedTitle(h.args),{code:"TITLE_MESSAGES_CHANGED"});assert.equal(h.writes(),0);
});
test("denial, wrong native target, changed source and imported prefix cannot write",async t=>{
 const f=fixture(t);await assert.rejects(correctClaudeDerivedTitle({...f.args,assertCurrentAuthority:()=>false}),{code:"NATIVE_HISTORY_AUTHORITY_DENIED"});assert.equal(f.writes(),0);
 const g=fixture(t);g.artifact.manifest.target.nativeId=sourceId;await assert.rejects(correctClaudeDerivedTitle(g.args),{code:"TITLE_SOURCE_BINDING_CHANGED"});assert.equal(g.writes(),0);
 const h=fixture(t);const b=fs.readFileSync(h.file);b[0]=32;fs.writeFileSync(h.file,b);await assert.rejects(correctClaudeDerivedTitle(h.args));assert.equal(h.writes(),0);
});
test("divergent retry and edited result retain failure; no fresh write",async t=>{
 const f=fixture(t);await correctClaudeDerivedTitle(f.args);
 const p={...f.plan,desiredTitle:"different",desiredTitleSha256:hash("different")};f.artifact.selected.native.selectionBinding.evidence.rows[0][f.artifact.selected.native.selectionBinding.evidence.columns.indexOf("name")]={type:"text",value:"different",utf8:Buffer.from("different").toString("base64")};
 const pfile=path.join(f.base,"different.json");fs.writeFileSync(pfile,json(p));
 await assert.rejects(correctClaudeDerivedTitle({...f.args,plan:p,planFile:pfile,planSha256:hash(json(p))}),{code:"TITLE_COMMAND_CONFLICT"});assert.equal(f.writes(),1);
});

test("copied plan cannot reset destination attempt; tampered receipt and forged capability cannot authorize another write", async t => {
 const f=fixture(t);await correctClaudeDerivedTitle(f.args);
 const copy=path.join(f.base,"copied-plan.json");fs.copyFileSync(f.args.planFile,copy);
 assert.equal((await correctClaudeDerivedTitle({...f.args,planFile:copy})).status,"title-completed-replay");
 assert.throws(()=>consumeClaudeTitleCapability({},{}),{code:"TITLE_ONE_USE_CAPABILITY_REQUIRED"});
 const key=hash(json({nativeId:id,namingPolicy:f.plan.namingPolicy})),result=path.join(f.scope.journalRoot,"title-commands",f.scope.receipt.targetKey,key,"result.json");
 const receipt=JSON.parse(fs.readFileSync(result));receipt.messageDigest="f".repeat(64);fs.writeFileSync(result,json(receipt));
 await assert.rejects(correctClaudeDerivedTitle(f.args),{code:"TITLE_RESULT_CHANGED"});assert.equal(f.writes(),1);
});
test("missing captured display name proposes no correction and leaves the destination untouched", t => {
 const f=fixture(t),e=f.artifact.selected.native.selectionBinding.evidence;
 e.rows[0][e.columns.indexOf("name")]={type:"null"};
 const before=fs.readFileSync(f.file);
 assert.equal(proposeClaudeDerivedTitle({artifact:f.artifact,nativeHome:f.home,relativeFile:f.relativeFile}),null);
 assert.ok(fs.readFileSync(f.file).equals(before));assert.equal(f.writes(),0);
});

test("orphan result without an attempt fails before any native effect", async t => {
 const f=fixture(t),key=hash(json({nativeId:id,namingPolicy:f.plan.namingPolicy}));
 const file=path.join(f.scope.journalRoot,"title-commands",f.scope.receipt.targetKey,key,"result.json");
 fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,json({kind:"orphan"}));
 await assert.rejects(correctClaudeDerivedTitle(f.args),{code:"TITLE_JOURNAL_INCOMPLETE"});
 assert.equal(f.writes(),0);assert.equal(fs.existsSync(path.join(path.dirname(file),"attempt.json")),false);
});
test("competing title append during SDK effect is uncertain and never replayed as success", async t => {
 const f=fixture(t),host={async correctDerivedClaudeTitle(binding){
  fs.appendFileSync(f.file,line({type:"custom-title",sessionId:id,customTitle:"another writer"}));
  return f.host.correctDerivedClaudeTitle(binding);
 }};
 await assert.rejects(correctClaudeDerivedTitle({...f.args,host}),{code:"TITLE_CONCURRENT_TITLE_UNCERTAIN"});
 assert.equal((await correctClaudeDerivedTitle(f.args)).status,"title-outcome-uncertain");assert.equal(f.writes(),1);
});

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {initializeProject,inspectProject} from '../scripts/lib/head-core.mjs';
import {createHeadSession,withSessionRoute} from '../scripts/lib/session-routing.mjs';
import {recordSessionWorkEvidence,readSessionWorkContext} from '../scripts/lib/session-work-context.mjs';
import {updateProjectDirection} from '../scripts/lib/project-direction.mjs';
import {createSessionHostAdapter} from '../scripts/lib/session-host-adapter.mjs';
import {sessionStartContext} from '../scripts/session-host-hook.mjs';
import {runCommand} from '../scripts/head.mjs';
import {dispatch} from '../scripts/mcp-server.mjs';
import {formatCliResult,formatMcpToolContent} from '../scripts/lib/cli-presentation.mjs';

const directionView = value => value ? Object.fromEntries(["directionId", "directionHash", "input"].filter(key => value[key] !== undefined).map(key => [key, value[key]])) : null;

// Test-only decoding of the explicit common block, not a runtime text parser.
function assertCommonRecords(text,records){
 const first=records[0],object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
 const eligible=records.length>=2&&records.every(record=>object(record)&&['projectId','sessionId','kind','subtype','content'].every(key=>Object.hasOwn(record,key))
  &&record.kind==='Evidence'&&record.subtype==='SessionWorkEvidence'&&object(record.content)
  &&['projectId','sessionId'].every(key=>typeof record[key]==='string'&&record[key].length>0&&record[key]===first[key]));
 const expected=eligible?Object.fromEntries(['projectId','sessionId','kind','subtype','schemaVersion','protocol','authorityBoundary']
  .filter(key=>Object.hasOwn(first,key)&&records.every(record=>Object.hasOwn(record,key)&&typeof record[key]===typeof first[key]&&JSON.stringify(record[key])===JSON.stringify(first[key])))
  .map(key=>[key,first[key]])):{};
 const blocks=[...text.matchAll(/^Common stored fields for (.+):\n/gmu)];
 assert.equal(blocks.length,Object.keys(expected).length?1:0);
 if(blocks.length){
  const block=blocks[0];assert.equal(block[1],records.map((_,index)=>`Record[${index}]`).join(', '));
  const firstRecord=text.indexOf('\nRecord[0]:\n');assert.ok(block.index<firstRecord);
  // Decode only the common JSON object, not the following P4 group headings.
  const jsonStart=block.index+block[0].length,jsonEnd=text.indexOf('\n}\n',jsonStart)+2;
  assert.ok(jsonEnd>jsonStart&&jsonEnd<firstRecord);
  assert.deepEqual(JSON.parse(text.slice(jsonStart,jsonEnd)),expected);
 }
 return expected;
}
function assertWorkPresentation(text,value){
 assert.match(text,/Recorded Session work \(historical P3\)|Selected Session work evidence \(P3, not current direction or permission\)/u);
 const common=assertCommonRecords(text,value.records);
 for(const key of ['status','projectId','sessionId'])if(value[key]!==undefined)assert.ok(text.includes(`${key}: ${JSON.stringify(value[key])}`),key);
 for(const key of ['coverage','omissions','nextAfterEvidenceId']){
  if(value[key]!==undefined)assert.ok(text.includes(JSON.stringify({[key]:value[key]},null,2).slice(2,-2)),`Missing original ${key}`);
 }
 for(const [index,record]of value.records.entries()){
  const start=text.indexOf(`\nRecord[${index}]:\n`),ends=[text.indexOf(`\nRecord[${index+1}]:\n`,start),text.indexOf('Additional original fields at workContext:\n',start)].filter(offset=>offset>=0);
  assert.ok(start>=0,`Missing Record[${index}]`);const section=text.slice(start,ends.length?Math.min(...ends):undefined);
  const ownerStart=text.lastIndexOf('Session work group (',start),rootStart=text.lastIndexOf('Declared historical work root:',start);
  assert.ok(ownerStart>=0&&rootStart>ownerStart&&rootStart<start);
  assert.ok(text.slice(ownerStart,rootStart).includes(JSON.stringify(record.sessionId)));
  const rootLine=text.slice(rootStart,text.indexOf('\n',rootStart));
  const root=record.content.workLink?.root||{evidenceId:record.evidenceId,evidenceDigest:record.evidenceDigest};
  assert.ok(rootLine.includes(root.evidenceId)&&rootLine.includes(root.evidenceDigest));
  assert.equal([...text.matchAll(new RegExp(`^Record\\[${index}\\]:$`,'gmu'))].length,1);
  assert.ok(section.includes(`evidenceId: ${JSON.stringify(record.evidenceId)}`));
  for(const key of ['projectId','sessionId','kind','subtype'])if(Object.hasOwn(record,key)){
   const line=`${key}: ${JSON.stringify(record[key])}`;
   assert.equal(section.split('\n').includes(line),!Object.hasOwn(common,key),`Record[${index}] ${key} must be local or exact common, not inherited from the envelope`);
  }
  assert.ok(section.includes(record.content.summary),`Missing original summary for ${record.evidenceId}`);
 }
 assert.equal(text.includes(`\nRecord[${value.records.length}]:\n`),false);
}

const pluginRoot=path.resolve(import.meta.dirname,'..');
function fixture(t){
 const parent=process.env.HEAD_AGENT_TEST_TMP||os.tmpdir();fs.mkdirSync(parent,{recursive:true});
 const base=fs.realpathSync(fs.mkdtempSync(path.join(parent,'head-usefulness-surface-'))),root=path.join(base,'project'),operational=path.join(base,'host');
 fs.mkdirSync(root);initializeProject({root,pluginRoot,runtimes:['codex','claude','opencode']});
 const layout=inspectProject(root).storage;
 const selected=createHeadSession({root,purpose:'Explain the synthetic cache behavior; no deployment or external calls.'});
 if(process.env.HEAD_AGENT_KEEP_TEST_TMP!=='1')t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 return{base,root,layout,operational,selected,route:fn=>withSessionRoute(root,selected.sessionId,fn)};
}
function snapshot(root){
 return fs.readdirSync(root,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>{
  const file=path.join(e.parentPath,e.name),stat=fs.statSync(file);
  return[path.relative(root,file),crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),stat.size,stat.mtimeMs,stat.mode];
 }).sort(([a],[b])=>a.localeCompare(b));
}
async function call(root,name,args={},routed=false){
 const response=await dispatch({jsonrpc:'2.0',id:'synthetic-usefulness',method:'tools/call',params:{name:routed?'head_tools_call':name,
  arguments:routed?{name,arguments:{project_root:root,...args}}:{project_root:root,...args}}});
 assert.equal(response.error,undefined,JSON.stringify(response));assert.equal(response.result?.isError,undefined,JSON.stringify(response));
 const value=response.result.structuredContent;
 // The human-readable body is not a JSON transport; Core/structured remain
 // the unchanged machine contract and returned scope stays visible in text.
 if(name==='head_session_work_read'){
  const text=response.result.content[0].text;assert.equal(text,formatMcpToolContent(name,value));
  assertWorkPresentation(text,value);
 }
 return value;
}
// Fixture-only compatibility variants; reads must never repair either index.
function navigationCases(root,layout){
 const file=path.join(root,layout.directory,'graph-discovery/index.json'),raw=fs.readFileSync(file,'utf8'),legacy=JSON.parse(raw);
 assert.equal(legacy.sessionWorkNavigation?.version,1);delete legacy.sessionWorkNavigation;
 return ['hinted','legacy','missing'].map(mode=>({mode,prepare(){
  if(mode==='missing')fs.unlinkSync(file);else fs.writeFileSync(file,mode==='hinted'?raw:JSON.stringify(legacy));
 }}));
}
test('generated instructions lead with the original outcome and preserve only necessary working boundaries',t=>{
 const f=fixture(t),text=fs.readFileSync(path.join(f.root,f.layout.directory,'generated/lode-instructions.md'),'utf8');
 assert.match(text,/understand the user's work.*finish the whole outcome/);
 assert.match(text,/Keep the user's original task as the active objective/);
 assert.match(text,/Work directly by default/);assert.match(text,/current request bounds action/);
 assert.match(text,/common constraints\/cancellations.*selected Session's P2/);
 assert.match(text,/Preserve completed contributions and user edits/);
 assert.match(text,/No per-turn save or mandatory sync\/Run\/Capsule; no duplicate administrative approval ritual/);
 assert.match(text,/Never infer a disposition from keyword matching, silence, or a default/);
 assert.match(text,/reuse sufficient verified supplied context for the exact Project and selected Session/);
 assert.match(text,/Obtain missing current context through read-only conversation-entry once/);
 assert.match(text,/do not repeat init\/resume\/status\/list\/graph merely to confirm unchanged supplied material/);
 assert.match(text,/distinguish mechanical coverage from semantic sufficiency/);
 assert.match(text,/Use existing progressive references only when their detail is relevant/);
 assert.match(text,/Capability does not grant authorization/);
});
test('CLI and direct/router MCP explain supplied Session work without changing originals or writing',async t=>{
 const f=fixture(t);
 updateProjectDirection({root:f.root,input:{goal:'Investigate locally only',cancelledActions:['deployment']}});
 f.route(()=>recordSessionWorkEvidence({root:f.root,input:{summary:'Local ordering check; no external effect verified.',
  judgments:[{assessment:'Retain a generation check',reason:'A TTL alone did not exclude a late request.',alternatives:['TTL-only was rejected.']}],
  observedWork:['The local pre-write check is implemented.'],pending:['Cancellation racing with a write still needs investigation.'],
  unknowns:['Actual Host behavior is unverified.'],suggestedFollowUp:['Investigate the local race; this is not deployment permission.']}}));
 const before=snapshot(f.base),expected=f.route(()=>readSessionWorkContext({root:f.root}));
 const cli=await runCommand(['conversation-enter',f.root,'--session',f.selected.sessionId]);
 assert.deepEqual(cli.workContext,expected);
 const text=formatCliResult('conversation-enter',cli);
 assertWorkPresentation(text,expected);
 for(const label of ['Saved judgments and reasons:','Alternatives considered in this saved judgment:',
  'Recorded changes and results:','Recorded remaining work:','Recorded uncertainty:',
  'Historical suggestions; not execution permission:'])assert.ok(text.includes(label),label);
 for(const literal of ['A TTL alone did not exclude a late request.','TTL-only was rejected.',
  'The local pre-write check is implemented.','Cancellation racing with a write still needs investigation.',
  'Actual Host behavior is unverified.','Investigate the local race; this is not deployment permission.'])
  assert.equal(text.split(literal).length-1,1,`Original body retained once: ${literal}`);
 assert.ok(text.indexOf('deployment')<text.indexOf('Recorded Session work (historical P3)'));
 for(const routed of[false,true]){
  const response=await dispatch({jsonrpc:'2.0',id:'session-explanation',method:'tools/call',params:{
   name:routed?'head_tools_call':'head_conversation_enter',arguments:routed?
    {name:'head_conversation_enter',arguments:{project_root:f.root,session_id:f.selected.sessionId}}:
    {project_root:f.root,session_id:f.selected.sessionId}}});
  assert.equal(response.result?.isError,undefined,JSON.stringify(response));
  assert.deepEqual(response.result.structuredContent,cli);
  assert.equal(response.result.content[0].text,text);
 }
 assert.deepEqual(snapshot(f.base),before,'Entry and formatting add no persistence, lock or binding writes.');
});
test('default selected work coverage crosses CLI and direct/router MCP without extra calls or writes',async t=>{
 const f=fixture(t);for(let i=0;i<10;i++)f.route(()=>recordSessionWorkEvidence({root:f.root,input:{summary:`Synthetic observation ${i}`,occurrenceKey:`useful-${i}`}}));
 let selectedBodies;
 for(const variant of navigationCases(f.root,f.layout)){
 variant.prepare();const before=snapshot(f.base),expected=f.route(()=>readSessionWorkContext({root:f.root}));
 const inspected=variant.mode==='hinted'?8:10;
 assert.equal(expected.status,'work_context_partial');assert.equal(expected.coverage.originals,10);
 assert.equal(expected.nextAfterEvidenceId,null);assert.equal(expected.coverage.inspected,inspected);
 assert.equal(expected.coverage.valid,inspected);assert.equal(expected.coverage.unavailable,0);
 assert.equal(expected.coverage.included,8);assert.equal(expected.records.length,8);
 // Historical hints are not current valid originals or failed body admissions.
 assert.equal(expected.omissions.uninspected,10-inspected);assert.equal(expected.omissions.byBudget,0);
 assert.deepEqual(expected.omissions.evidenceIds,[]);assert.equal(expected.omissions.omittedIdCount,0);
 assert.equal(expected.omissions.unavailableDetailCount,0);
 if(variant.mode==='hinted'){
  assert.match(expected.coverage.selection,/historical|hint/i);assert.match(expected.coverage.selection,/inspected/i);
 }else assert.match(expected.coverage.selection,/all discovered originals canonically inspected once.*partial body delivery.*not live state or semantic sufficiency/);
 const bodies=expected.records.map(record=>({evidenceId:record.evidenceId,evidenceDigest:record.evidenceDigest,content:record.content}));
 if(selectedBodies)assert.deepEqual(bodies,selectedBodies);else selectedBodies=bodies;
 assert.match(expected.expansion,/Read exact evidenceIds.*when useful.*does not require a full audit or repeating default entry/);
 const cli=await runCommand(['session-work-read',f.root,'--session',f.selected.sessionId]);assert.deepEqual(cli,expected);
 const presentation=formatCliResult('session-work-read',cli);assertWorkPresentation(presentation,expected);
 for(const routed of[false,true]){
  const actual=await call(f.root,'head_session_work_read',{session_id:f.selected.sessionId},routed);assert.deepEqual(actual,expected);
  const entry=await call(f.root,'head_conversation_enter',{session_id:f.selected.sessionId},routed);
  assert.deepEqual(entry.workContext,expected);assert.equal(entry.ordinaryWorkBlocked,false);
 }
 assert.deepEqual(snapshot(f.base),before);
 }
});
for(const runtime of['codex','claude'])test(`${runtime} healthy startup is useful without a mandatory follow-up or selection write`,t=>{
 const f=fixture(t),environment={HEAD_AGENT_OPERATIONAL_STATE_ROOT:f.operational};
 updateProjectDirection({root:f.root,input:{goal:'Explain only',constraints:['No external effects'],cancelledActions:['deployment']}});
 const host=createSessionHostAdapter({runtime,nativeSessionId:'synthetic-surface',environment});assert.equal(host.select({root:f.root,sessionId:f.selected.sessionId,expectedRevision:0}).retained,true);
 const entry=host.enter({root:f.root}),before=snapshot(f.base);
 const output=sessionStartContext({runtime,environment,event:{hook_event_name:'SessionStart',source:'compact',session_id:'synthetic-surface',cwd:f.root}});
 const text=output.hookSpecificOutput.additionalContext,value=JSON.parse(text);
 assert.ok(text.length<=(runtime==="codex"?32768:10000));assert.equal(value.sessionPurpose,entry.workContext.sessionPurpose);
 assert.deepEqual(value.currentProjectDirection,directionView(entry.projectStatus.currentProjectDirection));
 assert.deepEqual(value.route,{session_id:f.selected.sessionId});assert.equal(value.requiredSourceExpansion,undefined);
 assert.equal(value.persisted,false);assert.equal(value.ordinaryWorkBlocked,false);assert.equal(value.userDecisionRequired,false);
 assert.equal(value.sessionRecovery,null);assert.deepEqual(snapshot(f.base),before);
});
for(const runtime of['codex','claude'])test(`${runtime} lost linkage keeps independent current work visible without guessing or repair`,t=>{
 const f=fixture(t),environment={HEAD_AGENT_OPERATIONAL_STATE_ROOT:f.operational};
 updateProjectDirection({root:f.root,input:{goal:'Explain only',cancelledActions:['deployment']}});
 const host=createSessionHostAdapter({runtime,nativeSessionId:'synthetic-lost-linkage',environment});
 assert.equal(host.select({root:f.root,sessionId:f.selected.sessionId,expectedRevision:0}).retained,true);
 const binding=fs.readdirSync(f.operational,{recursive:true}).find(file=>file.endsWith('binding.json'));
 assert.ok(binding);fs.unlinkSync(path.join(f.operational,binding));
 const before=snapshot(f.base),entry=host.enter({root:f.root});
 assert.equal(entry.status,'session_selection_unresolved');
 const hook=sessionStartContext({runtime,environment,event:{hook_event_name:'SessionStart',source:'resume',session_id:'synthetic-lost-linkage',cwd:f.root}});
 const text=hook.hookSpecificOutput.additionalContext,value=JSON.parse(text);
 assert.ok(text.length<=(runtime==="codex"?32768:10000));assert.equal(value.status,'session_selection_unresolved');
 assert.equal(value.logicalSessionId,null);assert.equal(value.sessionPurpose,null);assert.equal(value.route,null);
 assert.ok(JSON.stringify(value.currentProjectDirection).includes('deployment'));
 assert.equal(value.userDecisionRequired,false);assert.equal(value.ordinaryWorkBlocked,false);assert.equal(value.persisted,false);
 assert.deepEqual(snapshot(f.base),before);
});

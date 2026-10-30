import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
const sourceRoot=path.resolve(import.meta.dirname,'..');
const {initializeOrResumeProject,inspectProjectExperience}=await import(pathToFileURL(sourceRoot+'/scripts/lib/project-bootstrap.mjs').href);
const {formatProjectBootstrap,formatProjectStatus}=await import('../scripts/lib/cli-presentation.mjs');
const {dispatch}=await import('../scripts/mcp-server.mjs');
const {inspectProject,convergeProjectInstallation}=await import(pathToFileURL(sourceRoot+'/scripts/lib/lode-core.mjs').href);
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const bytes=root=>fs.readdirSync(root,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>{
 const file=path.join(e.parentPath,e.name);return[path.relative(root,file),fs.readFileSync(file).toString('base64')];
}).sort(([a],[b])=>a.localeCompare(b));
function fixture(t) {
 const parent=fs.realpathSync(os.tmpdir()),root=fs.mkdtempSync(path.join(parent,'lode-opencode-reconnect-'));
 t.after(()=>{assert.equal(path.dirname(root),parent);assert(path.basename(root).startsWith('lode-opencode-reconnect-'));fs.rmSync(root,{recursive:true,force:true});});
 const project=path.join(root,'project'),nextPlugin=path.join(root,'new-pc-plugin');
 fs.mkdirSync(project);fs.mkdirSync(path.join(nextPlugin,'scripts'),{recursive:true});
 fs.copyFileSync(path.join(sourceRoot,'package.json'),path.join(nextPlugin,'package.json'),fs.constants.COPYFILE_EXCL);
 fs.writeFileSync(path.join(nextPlugin,'scripts/mcp-server.mjs'),'// Synthetic path-only fixture; not executed.\n',{flag:'wx'});
 return {root,project,nextPlugin};
}
test('same canonical Project root reconnects a changed installation root without changing Project or Session',async t=>{
 const {project,nextPlugin}=fixture(t);
 await initializeOrResumeProject({root:project,pluginRoot:sourceRoot,profile:'core',runtimes:['opencode']});
 const before=inspectProject(project),directory=before.storage.directory;
 const projectBytes=fs.readFileSync(path.join(project,directory,'project.json'));
 const sessionBytes=fs.readFileSync(path.join(project,directory,'sessions/current.json'));
 const oldCommand=read(path.join(project,'opencode.json')).mcp.lode.command;
 await initializeOrResumeProject({root:project,pluginRoot:nextPlugin,profile:'core'});
 const after=inspectProject(project),config=read(path.join(project,'opencode.json'));
 assert.equal(after.project.projectId,before.project.projectId);assert.equal(after.state.sessionId,before.state.sessionId);
 assert.deepEqual(after.project.runtimes,before.project.runtimes);
 assert.deepEqual(fs.readFileSync(path.join(project,directory,'project.json')),projectBytes);
 assert.deepEqual(fs.readFileSync(path.join(project,directory,'sessions/current.json')),sessionBytes);
 assert.deepEqual(config.mcp.lode.command,['node','{env:LODE_PLUGIN_ROOT}/scripts/mcp-server.mjs']);
 assert.deepEqual(config.mcp.lode.command,oldCommand);
 assert.equal(after.installation.pluginRoot,fs.realpathSync(nextPlugin));
 assert.notEqual(after.installation.pluginRoot,before.installation.pluginRoot);
 t.diagnostic(JSON.stringify({case:'plugin-root-only',projectIdentityPreserved:true,sessionBytesPreserved:true,hostLoaded:false}));
});
test('project-owned OpenCode configuration stays byte-identical while the generated suggestion reconnects',async t=>{
 const {project,nextPlugin}=fixture(t),file=path.join(project,'opencode.json');
 const original='{"mcp":{"custom":{"type":"local","command":["custom-engine"],"enabled":false}}}\n';
 fs.writeFileSync(file,original,{flag:'wx'});
 await initializeOrResumeProject({root:project,pluginRoot:sourceRoot,profile:'core',runtimes:['opencode']});
 const before=inspectProject(project);
 await initializeOrResumeProject({root:project,pluginRoot:nextPlugin,profile:'core'});
 assert.equal(fs.readFileSync(file,'utf8'),original);
 const generated=read(path.join(project,before.storage.directory,'generated/opencode.json'));
 assert.deepEqual(generated.mcp.lode.command,['node','{env:LODE_PLUGIN_ROOT}/scripts/mcp-server.mjs']);
 const after=inspectProject(project);
 assert.equal(after.project.projectId,before.project.projectId);assert.equal(after.state.sessionId,before.state.sessionId);
 t.diagnostic(JSON.stringify({case:'project-owned-config',originalPreserved:true,generatedReconnected:true,hostLoaded:false}));
});

test('OpenCode local connection observations reach bootstrap, status and MCP without taking over user settings',async t=>{
 const {project,nextPlugin}=fixture(t),file=path.join(project,'opencode.json');
 const unrelated={model:'user/model',permission:{edit:'ask'},mcp:{custom:{type:'local',command:['custom-engine'],enabled:false}}};
 fs.writeFileSync(file,JSON.stringify(unrelated)+'\n');
 const initialized=await initializeOrResumeProject({root:project,pluginRoot:sourceRoot,profile:'core',runtimes:['opencode']});
 assert.equal(initialized.readiness.core.state,'ready');assert.equal(initialized.opencodeConnection.instructions.status,'missing');assert.equal(initialized.opencodeConnection.mcp.status,'missing');
 assert.match(formatProjectBootstrap(initialized),/OpenCode local configuration: instructions missing; MCP missing/);
 const before=inspectProject(project),id=before.project.projectId,session=before.state.sessionId;
 const canon=fs.readFileSync(path.join(project,before.storage.directory,'project.json'));
 const expected=read(path.join(project,before.storage.directory,'generated/opencode.json'));
 const direct={type:'local',command:['node',path.join(sourceRoot,'scripts/mcp-server.mjs')],enabled:true};
 const variableTools={type:'local',command:['node','{env:TOOLS_HOME}/tools-server.mjs'],enabled:true};
 for(const [label,patch,instructions,mcp] of [
  ['unrelated',{},'missing','missing'], ['instructions-only',{instructions:expected.instructions},'configured','missing'],
  ['unrelated-variable',{mcp:{tools:variableTools}},'missing','missing'],
  ['valid-with-unrelated-variable',{mcp:{lode:direct,tools:variableTools}},'missing','configured'],
  ['custom-exact-alias',{mcp:{localLode:direct,tools:variableTools}},'missing','configured'],
  ['MCP-only',{mcp:{...unrelated.mcp,lode:direct}},'missing','configured'],
  ['both',{instructions:[...expected.instructions,expected.instructions[0]],mcp:{...unrelated.mcp,lode:direct}},'configured','configured'],
  ['legacy-alias',{instructions:expected.instructions,mcp:{head:direct}},'configured','configured'],
  ['absolute-instructions',{instructions:expected.instructions.map(p=>path.join(project,p)),mcp:{lode:direct}},'configured','configured'],
  ['bad-instructions',{instructions:false,mcp:{lode:direct}},'unknown','configured'],
  ['bad-MCP',{instructions:expected.instructions,mcp:[]},'configured','unknown'],
  ['disabled',{mcp:{lode:{...direct,enabled:false}}},'missing','disabled'],
  ['conflict',{mcp:{lode:{type:'local',command:['different-engine']}}},'missing','conflicting'],
  ['duplicate-alias',{mcp:{lode:direct,head:direct}},'missing','multiple-entries'],
  ['portable-placeholder',{mcp:expected.mcp},'missing','unknown'],
  ['other-placeholder',{mcp:{lode:{type:'local',command:['node','{env:OTHER_PLUGIN_ROOT}/scripts/mcp-server.mjs']}}},'missing','unknown'],
  ['unresolved-root',{mcp:{lode:{type:'local',command:['node',path.join(nextPlugin,'scripts/mcp-server.mjs')]}}},'missing','conflicting'],
  ['JSONC-string','{ // user comment\n "model": "user/model"\n}','unknown','unknown'],
 ]){
  const text=typeof patch==='string'?patch:JSON.stringify({...unrelated,...patch})+'\n';fs.writeFileSync(file,text);
  const value=await inspectProjectExperience({root:project}),connection=value.opencodeConnection;
  assert.equal(connection.instructions.status,instructions,label);assert.equal(connection.mcp.status,mcp,label);
  assert(!connection.mcp.entries?.some(entry=>entry.key==='tools'),label);
  assert.equal(connection.hostLoaded,'unknown');assert.equal(connection.ordinaryWorkBlocked,false);
  if(['unrelated-variable','valid-with-unrelated-variable','custom-exact-alias','other-placeholder'].includes(label)){
   const routed=await dispatch({method:'tools/call',params:{name:'head_project_status',arguments:{project_root:project}}});
   assert.equal(routed.error,undefined);assert.equal(routed.result.structuredContent.opencodeConnection.mcp.status,mcp,label);
   assert.match(routed.result.content[0].text,new RegExp('MCP '+mcp.replace('-','\\-')),label);
  }
  assert.equal(value.readiness.core.state,'ready');assert.equal(value.project.projectId,id);assert.equal(value.state.sessionId,session);
  assert.equal(fs.readFileSync(file,'utf8'),text);assert.equal(fs.readFileSync(path.join(project,before.storage.directory,'project.json')).equals(canon),true);
  assert.match(formatProjectStatus(value),/Actual Host loading was not verified; ordinary work continues/);
 }
 fs.writeFileSync(file,JSON.stringify(unrelated)+'\n');
 const context=expected.instructions;fs.writeFileSync(path.join(project,'AGENTS.md'),`For Lode work, read \`${context[0]}\` and \`${context[1]}\`.\n`);
 const agentsBefore=fs.readFileSync(path.join(project,'AGENTS.md'));
 const linked=await inspectProjectExperience({root:project});assert.equal(linked.opencodeConnection.instructions.status,'configured');assert.equal(linked.opencodeConnection.instructions.via,'explicit-AGENTS.md-link');
 const resumed=await initializeOrResumeProject({root:project,pluginRoot:nextPlugin,profile:'core'});
 assert.equal(resumed.opencodeConnection.instructions.status,'configured');assert.equal(resumed.opencodeConnection.mcp.status,'missing');
 assert(fs.readFileSync(path.join(project,'AGENTS.md')).equals(agentsBefore));assert.equal(fs.readFileSync(file,'utf8'),JSON.stringify(unrelated)+'\n');
 const response=await dispatch({method:'tools/call',params:{name:'head_project_status',arguments:{project_root:project}}});
 assert.equal(response.error,undefined);assert.match(response.result.content[0].text,/OpenCode local configuration: instructions configured; MCP missing/);
 fs.writeFileSync(path.join(project,'opencode.jsonc'),'// user JSONC alternative\n{}\n');
 const jsonc=await inspectProjectExperience({root:project});assert.equal(jsonc.opencodeConnection.reasonCode,'JSONC_CONFIG_NOT_INTERPRETED');assert.equal(jsonc.readiness.core.state,'ready');
 fs.unlinkSync(path.join(project,'opencode.jsonc'));
 const original=fs.readSync,configStat=fs.statSync(file);let changed=false;
 t.mock.method(fs,'readSync',function(fd,...args){const n=original.call(this,fd,...args),stat=fs.fstatSync(fd);if(!changed&&stat.dev===configStat.dev&&stat.ino===configStat.ino){changed=true;fs.appendFileSync(file,' ');}return n;});
 const raced=await inspectProjectExperience({root:project});assert(changed);assert.equal(raced.opencodeConnection.reasonCode,'CONFIG_CHANGED_CONCURRENTLY');assert.equal(raced.readiness.core.state,'ready');
 t.mock.restoreAll();fs.writeFileSync(file,JSON.stringify({...unrelated,mcp:{lode:{...direct,command:['node',path.join(nextPlugin,'scripts/mcp-server.mjs')]}}}));
 const open=fs.openSync;
 t.mock.method(fs,'openSync',function(target,...args){if(String(target)===file)throw Object.assign(new Error('synthetic read denied'),{code:'EACCES'});return open.call(this,target,...args);});
 const unreadable=await inspectProjectExperience({root:project});assert.equal(unreadable.opencodeConnection.reasonCode,'EACCES');assert.equal(unreadable.readiness.core.state,'ready');
 t.mock.restoreAll();t.mock.method(fs,'openSync',function(target,...args){if(String(target)===path.join(project,'AGENTS.md'))throw Object.assign(new Error('synthetic instruction read denied'),{code:'EACCES'});return open.call(this,target,...args);});
 const partial=await inspectProjectExperience({root:project});assert.equal(partial.opencodeConnection.instructions.status,'unknown');assert.equal(partial.opencodeConnection.mcp.status,'configured');assert.equal(partial.readiness.core.state,'ready');
});

test('existing JSONC-only OpenCode settings stay manual without a competing generated root config',async t=>{
 const {project}=fixture(t),file=path.join(project,'opencode.jsonc'),original='// Keep user comments\n{"model":"user/model"}\n';
 fs.writeFileSync(file,original);const result=await initializeOrResumeProject({root:project,pluginRoot:sourceRoot,profile:'core',runtimes:['opencode']});
 assert.equal(result.readiness.core.state,'ready');assert.equal(result.project.integrations.opencode.status,'manual');
 assert.equal(result.opencodeConnection.reasonCode,'JSONC_CONFIG_NOT_INTERPRETED');assert.equal(fs.readFileSync(file,'utf8'),original);assert(!fs.existsSync(path.join(project,'opencode.json')));
});
test('copied Project remains unavailable to implicit readers; explicit resume relocates and reconnects its installation',async t=>{
 const {root,project,nextPlugin}=fixture(t);
 await initializeOrResumeProject({root:project,pluginRoot:sourceRoot,profile:'core',runtimes:['opencode']});
 const moved=path.join(root,'other-pc-project');
 fs.cpSync(project,moved,{recursive:true,errorOnExist:true,force:false});
 const sourceBefore=bytes(project),movedBefore=bytes(moved);
 const original=inspectProject(project),oldProject=fs.readFileSync(path.join(project,original.storage.directory,'project.json'),'utf8');
 assert.equal(inspectProject(moved).status,'not_initialized');
 assert.throws(()=>convergeProjectInstallation({root:moved,pluginRoot:nextPlugin}),{code:'NOT_INITIALIZED'});
 const resumed=await initializeOrResumeProject({root:moved,pluginRoot:nextPlugin,profile:'core'}),current=inspectProject(moved);
 assert.equal(resumed.projectLocation.status,'relocated');assert.equal(current.status,'ready');
 assert.equal(current.project.projectId,original.project.projectId);assert.equal(current.state.sessionId,original.state.sessionId);
 assert.equal(current.project.projectRoot,fs.realpathSync(moved));assert.equal(current.installation.pluginRoot,fs.realpathSync(nextPlugin));
 assert.deepEqual(read(path.join(moved,'opencode.json')).mcp.lode.command,['node','{env:LODE_PLUGIN_ROOT}/scripts/mcp-server.mjs']);
 const history=path.join(moved,current.storage.directory,'project-location/history',`${resumed.projectLocation.historicalProjectDigest}.json`);
 assert.equal(fs.readFileSync(history,'utf8'),oldProject);
 const changed=new Set([`${original.storage.directory}/project.json`,`${original.storage.directory}/generated/manifest.json`,`${original.storage.directory}/generated/opencode.json`,'opencode.json']);
 const after=new Map(bytes(moved));for(const [relative,content]of movedBefore)if(!changed.has(relative.replaceAll('\\','/')))assert.equal(after.get(relative),content,relative);
 assert.deepEqual(bytes(project),sourceBefore);
 t.diagnostic(JSON.stringify({case:'explicit-project-root-move',implicitInspection:'not_initialized',implicitConvergenceCode:'NOT_INITIALIZED',projectAndSessionPreserved:true,sourceUnchanged:true,historicalOriginalPreserved:true,installationReconnected:true,hostLoaded:false}));
});


test('review regression: OpenCode config resolves a managed launch after host environment substitution', async t => {
 const {project}=fixture(t);
 await initializeOrResumeProject({root:project,pluginRoot:sourceRoot,profile:'core',runtimes:['opencode']});
 const {default:plugin}=await import('../scripts/opencode-plugin.mjs');
 const hooks=await plugin.server({client:{},project:{id:'host-project'},directory:project});
 t.after(()=>hooks.dispose());
 const file=path.join(project,'opencode.json'),original=fs.readFileSync(file,'utf8');
 // OpenCode v1.19.0 substitutes env references before JSON parsing and plugin.config.
 const parsed=()=>JSON.parse(original.replace(/\{env:LODE_PLUGIN_ROOT\}/g,''));
 const config=parsed();await hooks.config(config);
 assert.deepEqual(config.mcp.lode.command,['node',path.join(sourceRoot,'scripts/mcp-server.mjs')]);
 assert.equal(fs.readFileSync(file,'utf8'),original,'Resolution must stay in memory.');
 const unrelated={mcp:{custom:{type:'local',command:['node','/scripts/mcp-server.mjs']}}};
 const before=structuredClone(unrelated);await hooks.config(unrelated);assert.deepEqual(unrelated,before);
 const wrongSlot={mcp:{other:parsed().mcp.lode}},wrongSlotBefore=structuredClone(wrongSlot);
 await hooks.config(wrongSlot);assert.deepEqual(wrongSlot,wrongSlotBefore,'A managed file does not own another merged server slot.');
 const envOverride=parsed();envOverride.mcp.lode.command[1]='/other-install/scripts/mcp-server.mjs';
 const envOverrideBefore=structuredClone(envOverride);await hooks.config(envOverride);assert.deepEqual(envOverride,envOverrideBefore);
 fs.writeFileSync(file,original+'\nuser-edit');
 const changed=parsed(),changedBefore=structuredClone(changed);await hooks.config(changed);
 assert.deepEqual(changed,changedBefore,'A user-modified config must not be repaired as managed.');
 fs.writeFileSync(file,original);
 const manifestFile=path.join(project,'.lode/generated/manifest.json'),manifest=read(manifestFile);
 fs.writeFileSync(manifestFile,JSON.stringify({...manifest,pluginRoot:path.join(project,'another-package')}));
 const stale=parsed(),staleBefore=structuredClone(stale);await hooks.config(stale);assert.deepEqual(stale,staleBefore);
 fs.writeFileSync(manifestFile,JSON.stringify({...manifest,packageVersion:'wrong-package-version'}));
 const wrongVersion=parsed(),wrongVersionBefore=structuredClone(wrongVersion);await hooks.config(wrongVersion);assert.deepEqual(wrongVersion,wrongVersionBefore);
 fs.writeFileSync(manifestFile,JSON.stringify(manifest));
 const projectFile=path.join(project,'.lode/project.json'),projectBytes=fs.readFileSync(projectFile,'utf8');
 const projectRecord=JSON.parse(projectBytes);projectRecord.integrations.opencode.status='manual';
 fs.writeFileSync(projectFile,JSON.stringify(projectRecord));
 const manual=parsed(),manualBefore=structuredClone(manual);await hooks.config(manual);assert.deepEqual(manual,manualBefore);
});

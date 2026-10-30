import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {initializeProject,inspectProject} from '../scripts/lib/head-core.mjs';

const pluginRoot=path.resolve(import.meta.dirname,'..');
function project(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'head-agreement-guidance-')));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return root;
}
const runtimes=['claude','codex','opencode'];
function assertConditionalEntryGuidance(instructions){
 const entry=instructions.split('\n').find(line=>line.startsWith('- On entry, compaction or provider replacement,'));
 assert.ok(entry,'generated consumers receive the entry decision, not just Skill wording');
 assert.match(entry,/reuse sufficient verified supplied context/);
 assert.match(entry,/exact Project and selected Session/);
 assert.match(entry,/current common constraints\/cancellations/);
 assert.match(entry,/missing current context.*read-only conversation-entry once/);
 assert.match(entry,/do not repeat init\/resume\/status\/list\/graph merely to confirm/);
 assert.match(entry,/first adoption, explicit selection\/resume or needed installation convergence/);
 assert.match(entry,/preserving native selection and lifecycle observation/);
 assert.match(entry,/no checkpoint means ordinary work continues/);
 assert.match(entry,/Missing direction or selection pauses only dependent work/);
 assert.match(instructions,/new information through bounded project graph discovery or sufficient same-basis reuse/);
 assert.match(instructions,/Recheck affected current sources and effect authority before acting/);
 assert.doesNotMatch(entry,/use the read-only conversation-entry projection automatically/);
 // Exercise the generated consumer, including preserved manual-integration paths.
 // These assertions prove delivered guidance, not model behavior or Host inheritance.
 assert.match(instructions,/keep a completed plan source idle or obtain a supported preservation fork/);
 assert.match(instructions,/detailed inspection is not automatically the next planning context/);
 assert.match(instructions,/Integration may inspect material originals/);
 assert.match(instructions,/Form the next plan from integrated results, new facts, changed assumptions, reasons, remaining dependencies and next actions/);
 assert.match(instructions,/under current user conditions\/cancellations/);
 assert.match(instructions,/Small direct work needs no extra fork, save, ID or approval/);
}
// These are source/consumer contracts, not a natural-language decision engine
// or evidence that a live model follows the guidance or avoids duplicate calls.
test('agreement and conditional entry guidance reach generated consumers without execution or review transitions',t=>{
 const root=project(t),result=initializeProject({root,pluginRoot,runtimes});
 const layout=inspectProject(root).storage;
 assert.equal(result.status,'ready');
 const generated=fs.readFileSync(path.join(root,layout.directory,'generated/lode-instructions.md'),'utf8');
 for(const target of ['AGENTS.md','CLAUDE.md'])assert.equal(fs.readFileSync(path.join(root,target),'utf8'),generated);
 const opencode=JSON.parse(fs.readFileSync(path.join(root,'opencode.json'),'utf8'));
 assert.ok(opencode.instructions.includes(`${layout.directory}/generated/lode-instructions.md`));
  assertConditionalEntryGuidance(generated);
 assert.match(generated,/no duplicate administrative approval ritual/);
 assert.doesNotMatch(generated,/mandatory sync\/Run\/Capsule\/approval/);
 assert.match(generated,/current user decision for a new or changed protected target/);
 const inspected=inspectProject(root);assert.equal(inspected.status,'ready');
 assert.equal(inspected.project.runtimes.join(','),'claude,codex,opencode');
 for(const field of ['activeRunId','activeExecutionContractId','pendingReview','latestCheckpoint'])assert.equal(inspected.state[field],null);
});

test('agreement guidance preserves existing user instructions and exposes only the existing manual integration alternative',t=>{
 const root=project(t),originals={'AGENTS.md':'# User instructions\nKeep the user-owned scope.\n','CLAUDE.md':'# User instructions\nNo deployment.\n','opencode.json':'{"userOwned":true}\n'};
 for(const [name,bytes] of Object.entries(originals))fs.writeFileSync(path.join(root,name),bytes);
 const result=initializeProject({root,pluginRoot,runtimes});
 const layout=inspectProject(root).storage;
 assert.equal(result.status,'ready_with_manual_integration');
 for(const [name,bytes] of Object.entries(originals))assert.equal(fs.readFileSync(path.join(root,name),'utf8'),bytes);
 const inspected=inspectProject(root);
 for(const runtime of runtimes)assert.equal(inspected.project.integrations[runtime].status,'manual');
 const alternative=fs.readFileSync(path.join(root,layout.directory,'generated/lode-instructions.md'),'utf8');
  assertConditionalEntryGuidance(alternative);
 assert.match(alternative,/Reuse concrete user agreement/);
 assert.match(alternative,/Saving grants no execution permission/);
});

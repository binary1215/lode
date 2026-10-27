import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { initializeProject, inspectProject } from "../scripts/lib/lode-core.mjs";
import { createHeadSession, createSessionCallContext, sessionSelectionUnresolved } from "../scripts/lib/session-routing.mjs";
import { startupProjection, MAX_CONTEXT_CHARACTERS } from "../scripts/lib/session-host-context-projection.mjs";
import { createSessionHostAdapter } from "../scripts/lib/session-host-adapter.mjs";
import { createNativeSessionHostBridge } from "../scripts/lib/session-native-host.mjs";
import { createSessionHostRequestRegistry, SESSION_HOST_REQUEST_HELPER, claudeNativeHookMatchers } from "../scripts/lib/session-host-request.mjs";
import { resolveOperation } from "../scripts/lib/lode-operation-contract.mjs";
import { sessionCallRequiresBinding } from "../scripts/lib/session-routing.mjs";
import { dispatch, catalogTools } from "../scripts/mcp-server.mjs";
import { sessionStartContext } from "../scripts/session-host-hook.mjs";

// head_* request inputs below deliberately exercise compatibility dispatch;
// generated catalog and Hook assertions use the canonical Lode vocabulary.
const pluginRoot = path.resolve(import.meta.dirname, "..");
function fixture(t, initialize = true) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "head-native-session-")));
  const root = path.join(base, "project"), operational = path.join(base, "host"); fs.mkdirSync(root);
  let storage = null;
  if (initialize) {
    initializeProject({ root, pluginRoot, runtimes: ["codex"] });
    storage = inspectProject(root).storage;
    assert.equal(storage.directory, ".lode");
    assert.equal(fs.existsSync(path.resolve(root, ".lode/project.json")), true);
    assert.equal(fs.existsSync(path.resolve(root, ".head/project.json")), false);
  }
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  // These cases isolate routing/selection. Default child policy is covered by
  // subagent-write-guard tests; explicit off preserves the routing scenario.
  const environment = { HEAD_AGENT_OPERATIONAL_STATE_ROOT: operational, LODE_SUBAGENT_WRITE_GUARD: "off" };
  const bridge = () => createNativeSessionHostBridge({ runtime: "codex", environment });
  const host = (nativeSessionId) => createSessionHostAdapter({ runtime: "codex", nativeSessionId, environment });
  return { root, storage, operational, environment, bridge, host };
}
function snapshot(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true }).filter(p=>fs.statSync(path.join(root,p)).isFile())
    .sort().map(p=>[p,fs.readFileSync(path.join(root,p),"utf8")]);
}
function request(root, name, args = {}, caller = "native-A", routed = false) {
  return { jsonrpc:"2.0", id:"synthetic-local-request", method:"tools/call", params:{
    ...(caller === undefined || caller === null ? {} : { _meta:{threadId:caller} }),
    name:routed ? "head_tools_call" : name,
    arguments:routed ? { name, arguments:{project_root:root,...args} } : {project_root:root,...args},
  } };
}
const invoke = (bridge, req, options = {}) => dispatch(req, { nativeSessionBridge:bridge, ...options });
const claudeRequest = (root,name,args={},id="tool-local",routed=false) => {
  const req=request(root,name,args,null,routed);req.params._meta={"claudecode/toolUseId":id};return req;
};
const hookRequest = (wire,nativeSessionId="native-claude-root",agentId="") => ({
  id:"native-hook",method:"tools/call",params:{name:SESSION_HOST_REQUEST_HELPER,arguments:{
    native_session_id:nativeSessionId,native_agent_id:agentId,tool_use_id:wire.params._meta["claudecode/toolUseId"],
    outer_tool_name:"mcp__lode__"+wire.params.name,original_arguments:JSON.stringify(wire.params.arguments),
  }},
});
async function claudeCall(bridge,wire,nativeSessionId="native-claude-root",agentId="") {
  assert.equal((await invoke(bridge,hookRequest(wire,nativeSessionId,agentId))).result.isError,undefined);
  return invoke(bridge,wire);
}

test("synthetic Claude changed native ID never falls through to default or another chat; explicit recovery stays usable", async t => {
  const { root, environment, operational } = fixture(t);
  const native = createNativeSessionHostBridge({ runtime: "claude", environment });
  t.after(() => native.dispose());
  const a = createHeadSession({ root, purpose: "Old chat A" }).sessionId;
  const b = createHeadSession({ root, purpose: "Simultaneous chat B" }).sessionId;
  await claudeCall(native, claudeRequest(root, "head_project_initialize_or_resume", { session_id: a }, "old-a-init"), "old-a");
  await claudeCall(native, claudeRequest(root, "head_project_initialize_or_resume", { session_id: b }, "old-b-init"), "old-b");
  const before = snapshot(root).concat(snapshot(operational));
  const output = sessionStartContext({ runtime: "claude", environment,
    event: { hook_event_name: "SessionStart", source: "clear", cwd: root, session_id: "new-a", old_session_id: "old-a" } });
  assert.equal(JSON.parse(output.hookSpecificOutput.additionalContext).logicalSessionId, null,
    "An unverified old_session_id field is not a continuity contract.");
  const unresolved = await claudeCall(native, claudeRequest(root, "head_conversation_enter", {}, "new-a-enter"), "new-a");
  assert.equal(unresolved.result.structuredContent.status, "session_selection_unresolved");
  assert.equal(unresolved.result.structuredContent.ordinaryWorkBlocked, false);
  const explicit = await claudeCall(native, claudeRequest(root, "head_conversation_enter", { session_id: a }, "new-a-explicit"), "new-a");
  assert.equal(explicit.result.structuredContent.workContext.sessionId, a);
  const child = await claudeCall(native, claudeRequest(root, "head_conversation_enter", {}, "old-a-child"), "old-a", "new-child");
  assert.equal(child.result.structuredContent.status, "session_selection_unresolved");
  assert.equal((await claudeCall(native, claudeRequest(root, "head_conversation_enter", {}, "old-b-enter"), "old-b")).result.structuredContent.workContext.sessionId, b);
  assert.equal((await claudeCall(native, claudeRequest(root, "head_project_direction_read", {}, "new-a-project"), "new-a")).error, undefined,
    "Independent Project reads have no new Session gate.");
  assert.deepEqual(snapshot(root).concat(snapshot(operational)), before, "Reads create no migration/binding/P2 writes.");
  await claudeCall(native, claudeRequest(root, "head_project_initialize_or_resume", { session_id: a }, "new-a-resume"), "new-a");
  assert.equal((await claudeCall(native, claudeRequest(root, "head_conversation_enter", {}, "new-a-after-resume"), "new-a")).result.structuredContent.workContext.sessionId, a);
  const fresh = await claudeCall(native, claudeRequest(root, "head_project_initialize_or_resume", {}, "fresh-init-default"), "fresh-chat");
  assert.equal(fresh.result.structuredContent.project.sessionId, inspectProject(root).state.sessionId,
    "An explicit initialize/resume still may select the verified default.");
});

test("Claude pending/lost/corrupt bindings stay unresolved while exact reads and Project work survive", async t => {
  const { root, environment, operational } = fixture(t), target = createHeadSession({ root, purpose: "Exact retained evidence" }).sessionId;
  const native = createNativeSessionHostBridge({ runtime: "claude", environment });
  t.after(() => native.dispose());
  for (const status of ["pending", "lost", "corrupt"]) {
    const caller = "claude-" + status;
    const host = createSessionHostAdapter({ runtime: "claude", nativeSessionId: caller, environment });
    if (status === "pending") host.prepareSelection({ root, sessionId: target });
    else {
      host.select({ root, sessionId: target, expectedRevision: 0 });
      if (status === "lost") host.lose({ root, expectedRevision: 1 });
      else {
        const digest = host.read({ root }).bindingDigest;
        const file = fs.readdirSync(operational, { recursive: true }).map(relative => path.join(operational, relative))
          .find(file => file.endsWith("binding.json") && JSON.parse(fs.readFileSync(file, "utf8")).bindingDigest === digest);
        fs.writeFileSync(file, "{corrupt synthetic binding");
      }
    }
    const before = snapshot(root).concat(snapshot(operational));
    const read = await claudeCall(native, claudeRequest(root, "head_conversation_enter", {}, status + "-entry"), caller);
    assert.equal(read.result.structuredContent.status, "session_selection_unresolved", status);
    const exact = await claudeCall(native, claudeRequest(root, "head_conversation_enter", { session_id: target }, status + "-exact"), caller);
    assert.equal(exact.result.structuredContent.workContext.sessionId, target, status);
    assert.equal((await claudeCall(native, claudeRequest(root, "head_project_direction_read", {}, status + "-project"), caller)).error, undefined);
    assert.deepEqual(snapshot(root).concat(snapshot(operational)), before);
  }
});

test("init/resume selects; later automatic entry preserves Session without read writes", async t => {
  const { root, storage, operational, bridge, host } = fixture(t), native = bridge();
  const target = createHeadSession({root,purpose:"Selected investigation"}).sessionId;
  const selected = await invoke(native, request(root,"head_project_initialize_or_resume",{session_id:target,profile:"core"}));
  assert.equal(selected.result.structuredContent.project.sessionId,target);
  assert.equal(selected.result._meta.headSessionBinding.retained,true);
  assert.equal(host("native-A").read({root}).sessionId,target);
  const before = snapshot(root).concat(snapshot(operational));
  for(const b of [native,bridge()]) {
    const entered = await invoke(b,request(root,"head_conversation_enter"));
    assert.equal(entered.result.structuredContent.workContext.sessionId,target);
  }
  assert.deepEqual(snapshot(root).concat(snapshot(operational)),before);
});

test("R1 one-off read, foreign-session record, checkpoint, integration and create-only are not selection", async t => {
  const { root, storage, operational, bridge, host } = fixture(t), native = bridge();
  const a = createHeadSession({root,purpose:"A"}).sessionId, b = createHeadSession({root,purpose:"B"}).sessionId;
  await invoke(native,request(root,"head_project_initialize_or_resume",{session_id:a}));
  const before = snapshot(operational);
  assert.equal((await invoke(native,request(root,"head_conversation_enter",{session_id:b}))).result.structuredContent.workContext.sessionId,b);
  const saved = await invoke(native,request(root,"head_session_work_record",{session_id:b,evidence:{unknowns:["Only B evidence"]}}));
  assert.equal(saved.result.isError,undefined);
  await invoke(native,request(root,"head_checkpoint_sync",{session_id:b})); // invalid request does not select
  await invoke(native,request(root,"head_worker_integration_status",{session_id:b}));
  const created = await invoke(native,request(root,"head_session_create",{purpose:"Created, not selected"}));
  assert.ok(created.result.structuredContent.sessionId);
  assert.deepEqual(snapshot(operational),before);
  assert.equal(host("native-A").read({root}).sessionId,a);
});

test("same process concurrent callers, router and explicit sharing/separation remain request-local", async t => {
  const { root, storage, bridge, host } = fixture(t), native = bridge();
  const a=createHeadSession({root,purpose:"A"}).sessionId,b=createHeadSession({root,purpose:"B"}).sessionId;
  const results=await Promise.all([
    invoke(native,request(root,"head_project_initialize_or_resume",{session_id:a},"native-A",true)),
    invoke(native,request(root,"head_project_initialize_or_resume",{session_id:b},"native-B")),
  ]);
  assert.equal(results[0].result.structuredContent.project.sessionId,a);
  assert.equal(results[1].result.structuredContent.project.sessionId,b);
  await invoke(native,request(root,"head_project_initialize_or_resume",{session_id:a},"native-B"));
  assert.equal(host("native-A").read({root}).sessionId,a);
  assert.equal(host("native-B").read({root}).sessionId,a);
  await invoke(native,request(root,"head_project_initialize_or_resume",{session_id:b},"native-B"));
  assert.equal((await invoke(native,request(root,"head_conversation_enter",{},"native-A"))).result.structuredContent.workContext.sessionId,a);
  assert.equal((await invoke(native,request(root,"head_conversation_enter",{},"native-B"))).result.structuredContent.workContext.sessionId,b);
});

test("new caller default is unchanged; reads create no Host linkage; first init retains default", async t => {
  const { root, storage, operational, bridge, host }=fixture(t),native=bridge();
  const defaultId=inspectProject(root).state.sessionId;
  assert.equal((await invoke(native,request(root,"head_conversation_enter"))).result.structuredContent.workContext.sessionId,defaultId);
  assert.equal(fs.existsSync(operational),false);
  await invoke(native,request(root,"head_project_initialize_or_resume"));
  assert.equal(host("native-A").read({root}).status,"default");
});

test("new Project initializer registers only its successfully returned identity", async t => {
  const { root, storage, bridge, host }=fixture(t,false),native=bridge();
  const result=await invoke(native,request(root,"head_project_initialize_or_resume",{runtimes:["codex"]}));
  assert.equal(result.result.structuredContent.projectAction,"initialized");
  assert.equal(host("native-A").read({root}).sessionId,result.result.structuredContent.project.sessionId);
});

test("missing/malformed native metadata never uses last caller; legacy and embedding remain separate", async t => {
  const { root, storage, operational, bridge }=fixture(t),native=bridge();
  const a=createHeadSession({root,purpose:"A"}).sessionId,b=createHeadSession({root,purpose:"B"}).sessionId;
  await invoke(native,request(root,"head_project_initialize_or_resume",{session_id:a}));
  const before=snapshot(operational);
  for(const caller of [null,""]) {
    assert.equal((await invoke(native,request(root,"head_conversation_enter",{},caller))).result.structuredContent.status,"session_selection_unresolved");
    assert.equal((await invoke(native,request(root,"head_conversation_enter",{session_id:b},caller))).result.structuredContent.workContext.sessionId,b);
    assert.equal((await invoke(native,request(root,"head_project_direction_read",{},caller))).result.content[0].text,"null");
  }
  const legacy=await invoke(bridge(),request(root,"head_conversation_enter",{},null));
  assert.equal(legacy.result.structuredContent.workContext.sessionId,inspectProject(root).state.sessionId);
  const context=createSessionCallContext();context.select(root,b);
  const embedded=await invoke(native,request(root,"head_conversation_enter"),{sessionContext:context});
  assert.equal(embedded.result.structuredContent.workContext.sessionId,b);
  assert.deepEqual(snapshot(operational),before);
});

test("tool argument metadata does not supply or override wire caller; invalid preflight leaves binding intact", async t => {
  const { root, storage, operational, bridge }=fixture(t),native=bridge();
  const a=createHeadSession({root,purpose:"A"}).sessionId;
  await invoke(native,request(root,"head_project_initialize_or_resume",{session_id:a}));
  const before=snapshot(operational);
  const result=await invoke(native,request(root,"head_conversation_enter",{_meta:{threadId:"native-B"}}));
  assert.equal(result.result.structuredContent.workContext.sessionId,a);
  for(const args of [{profile:"invalid"},{session_id:null},{session_id:"bad-id"}]) await invoke(native,request(root,"head_project_initialize_or_resume",args));
  assert.deepEqual(snapshot(operational),before);
});

test("known lost/pending/deleted binding scopes only dependent work, not valid explicit reads", async t => {
  const { root, storage, operational, bridge, host }=fixture(t),native=bridge();
  const a=createHeadSession({root,purpose:"A"}).sessionId;
  await invoke(native,request(root,"head_project_initialize_or_resume",{session_id:a}));
  const owner=host("native-A");owner.lose({root,expectedRevision:owner.read({root}).revision});
  assert.equal((await invoke(native,request(root,"head_conversation_enter"))).result.structuredContent.status,"session_selection_unresolved");
  assert.equal((await invoke(native,request(root,"head_conversation_enter",{session_id:a}))).result.structuredContent.workContext.sessionId,a);
  const bindingFile=fs.readdirSync(operational,{recursive:true}).find(f=>f.endsWith("binding.json"));fs.unlinkSync(path.join(operational,bindingFile));
  assert.equal((await invoke(bridge(),request(root,"head_conversation_enter"))).result.structuredContent.status,"session_selection_unresolved");
  assert.equal((await invoke(native,request(root,"head_project_direction_read"))).result.content[0].text,"null");
});

test("P5 settlement handles reverse completion and proven pre-effect failure without overwriting newer choice", t => {
  const { root, storage, host }=fixture(t),owner=host("native-A");
  const a=createHeadSession({root,purpose:"A"}).sessionId,b=createHeadSession({root,purpose:"B"}).sessionId;
  owner.select({root,sessionId:"",expectedRevision:0});
  let first=owner.prepareSelection({root,sessionId:a}),second=owner.prepareSelection({root,sessionId:b});
  owner.settleSelection({ticket:second.ticket,outcome:"succeeded"});
  assert.equal(owner.settleSelection({ticket:first.ticket,outcome:"succeeded"}).status,"host_selection_superseded");
  assert.equal(owner.read({root}).sessionId,b);
  first=owner.prepareSelection({root,sessionId:a});second=owner.prepareSelection({root,sessionId:b});
  owner.settleSelection({ticket:second.ticket,outcome:"not-started"});
  owner.settleSelection({ticket:first.ticket,outcome:"succeeded"});
  assert.equal(owner.read({root}).sessionId,a);
  first=owner.prepareSelection({root,sessionId:b});second=owner.prepareSelection({root,sessionId:a});
  owner.settleSelection({ticket:first.ticket,outcome:"succeeded"});
  owner.settleSelection({ticket:second.ticket,outcome:"not-started"});
  assert.equal(owner.read({root}).sessionId,b);
  assert.equal(owner.read({root}).status,"bound");
});

test("uncertain/cancel outcome is not inferred successful; restart and exact settlement retry are bounded", t => {
  const { root, storage,host }=fixture(t),owner=host("native-A"),a=createHeadSession({root,purpose:"A"}).sessionId;
  const prepared=owner.prepareSelection({root,sessionId:a});
  const result=owner.settleSelection({ticket:prepared.ticket,outcome:"uncertain"});
  assert.equal(owner.settleSelection({ticket:prepared.ticket,outcome:"uncertain"}),result);
  assert.throws(()=>owner.settleSelection({ticket:prepared.ticket,outcome:"succeeded"}),{code:"SESSION_HOST_SETTLEMENT_CONFLICT"});
  assert.equal(host("native-A").enter({root}).status,"session_selection_unresolved");
});

test("pending preparation or final storage failure preserves original Core success and never reruns it", async t => {
  for(const failingPublication of [1,2]) {
    const {root,storage,bridge,host}=fixture(t),native=bridge();
    const a=createHeadSession({root,purpose:"A"}).sessionId,b=createHeadSession({root,purpose:"B"}).sessionId;
    await invoke(native,request(root,"head_project_initialize_or_resume",{session_id:a}));
    const rename=fs.renameSync;let publications=0;
    fs.renameSync=(source,target)=>{if(target.endsWith("binding.json")&&++publications===failingPublication)throw Object.assign(new Error("injected P5 failure"),{code:"EIO"});return rename(source,target);};
    let result, handlerCalls=0;
    try { result=await native.dispatch(request(root,"head_project_initialize_or_resume",{session_id:b}),
      (wire,routing)=>{handlerCalls++;return dispatch(wire,routing);}); } finally {fs.renameSync=rename;}
    assert.equal(handlerCalls,1,"Optional persistence never repeats the Core operation.");
    assert.equal(result.result.isError,undefined);
    assert.equal(result.result.structuredContent.project.sessionId,b);
    assert.equal(result.result._meta.headSessionBinding.retained,false);
    assert.equal(result.result._meta.headSessionBinding.executionReplayAllowed,false);
    assert.equal((await invoke(native,request(root,"head_conversation_enter"))).result.structuredContent.status,"session_selection_unresolved");
    if(failingPublication===2)assert.equal(host("native-A").read({root}).status,"pending");
    const repair=await invoke(native,request(root,"head_project_initialize_or_resume",{session_id:b}));
    assert.equal(repair.result._meta.headSessionBinding.retained,true);
  }
});

test("proven failure before a first selection preserves verified default rather than a loss gate", t => {
  const {root,storage,host}=fixture(t),owner=host("first-selection"),defaultId=inspectProject(root).state.sessionId;
  const other=createHeadSession({root,purpose:"Not selected"}).sessionId;
  const pending=owner.prepareSelection({root,sessionId:other});
  owner.settleSelection({ticket:pending.ticket,outcome:"not-started"});
  assert.equal(owner.read({root}).status,"default");
  assert.equal(owner.enter({root}).workContext.sessionId,defaultId);
});

test("A failure followed by B failure restores the actual prior choice, not an uncertain predecessor", t => {
  const {root,storage,host}=fixture(t),owner=host("failed-intents"),defaultId=inspectProject(root).state.sessionId;
  owner.select({root,sessionId:"",expectedRevision:0});
  const a=createHeadSession({root,purpose:"A"}).sessionId,b=createHeadSession({root,purpose:"B"}).sessionId;
  const first=owner.prepareSelection({root,sessionId:a}),second=owner.prepareSelection({root,sessionId:b});
  owner.settleSelection({ticket:first.ticket,outcome:"not-started"});
  owner.settleSelection({ticket:second.ticket,outcome:"not-started"});
  assert.equal(owner.read({root}).sessionId,defaultId);
  assert.equal(owner.enter({root}).workContext.sessionId,defaultId);
});

test("transport composition is opt-in by actual initialize clientInfo; arguments cannot activate native mode", async t => {
  const {root,storage,environment}=fixture(t),bridge=createNativeSessionHostBridge({environment});
  await invoke(bridge,{id:1,method:"initialize",params:{clientInfo:{name:"other-client",version:"0.0.0"}}});
  assert.equal(bridge.describe().runtime,null);
  await invoke(bridge,request(root,"head_conversation_enter",{},"synthetic-native-id"));
  assert.equal(bridge.describe().runtime,null);
  await invoke(bridge,{id:2,method:"initialize",params:{clientInfo:{name:"codex-mcp-client",version:"0.162.0-alpha.17.2"}}});
  assert.equal(bridge.describe().runtime,"codex");
});

test("success of a worker/checkpoint/result operation cannot become an unrelated selection declaration", async t => {
  const {root,storage,operational,bridge}=fixture(t),native=bridge();
  const a=createHeadSession({root,purpose:"A"}).sessionId,b=createHeadSession({root,purpose:"B"}).sessionId;
  await invoke(native,request(root,"head_project_initialize_or_resume",{session_id:a}));
  const before=snapshot(operational);
  for(const name of ["head_worker_integration","head_checkpoint_sync","head_run_finish","head_session_work_record","head_session_create"]){
    const response={id:1,result:{structuredContent:{status:"succeeded",project:{projectId:inspectProject(root).project.projectId,sessionId:b},projectAction:"resumed"}}};
    const result=await native.dispatch(request(root,name,{session_id:b}),async()=>response);
    assert.equal(result,response);
    assert.equal(result.result._meta,undefined);
  }
  assert.deepEqual(snapshot(operational),before);
});

test("three owned proven failures can restore exact initial default, but no uncertain ancestor is guessed", t => {
  const {root,storage,host}=fixture(t),owner=host("three-failures"),defaultId=inspectProject(root).state.sessionId;
  const ids=["A","B","C"].map(purpose=>createHeadSession({root,purpose}).sessionId);
  const tickets=ids.map(sessionId=>owner.prepareSelection({root,sessionId}).ticket);
  for(const ticket of tickets)owner.settleSelection({ticket,outcome:"not-started"});
  assert.equal(owner.enter({root}).workContext.sessionId,defaultId);
  const first=owner.prepareSelection({root,sessionId:ids[0]}),second=owner.prepareSelection({root,sessionId:ids[1]});
  owner.settleSelection({ticket:first.ticket,outcome:"uncertain"});
  owner.settleSelection({ticket:second.ticket,outcome:"not-started"});
  assert.equal(host("three-failures").enter({root}).status,"session_selection_unresolved");
});

test("C1-F1 failed first P5 mkdir is process-known loss, not absent default; explicit repair needs no new tool", async t => {
  const {root,storage,operational,bridge}=fixture(t),native=bridge(),target=createHeadSession({root,purpose:"First actual selection"}).sessionId;
  const mkdir=fs.mkdirSync;let injected=0,handlerCalls=0;
  fs.mkdirSync=(dir,...args)=>{if(path.resolve(String(dir)).startsWith(path.resolve(operational))&&injected++===0)throw Object.assign(new Error("First P5 mkdir failed"),{code:"EIO"});return mkdir(dir,...args);};
  let selected;try{selected=await native.dispatch(request(root,"head_project_initialize_or_resume",{session_id:target}),
    (wire,routing)=>{handlerCalls++;return dispatch(wire,routing);});}finally{fs.mkdirSync=mkdir;}
  assert.equal(handlerCalls,1);
  assert.equal(selected.result.structuredContent.project.sessionId,target);
  assert.equal(selected.result._meta.headSessionBinding.retained,false);
  assert.equal(fs.existsSync(operational),false);
  const next=await invoke(native,request(root,"head_conversation_enter"));
  assert.equal(next.result.structuredContent.status,"session_selection_unresolved");
  assert.equal((await invoke(native,request(root,"head_conversation_enter",{session_id:target}))).result.structuredContent.workContext.sessionId,target);
  assert.equal((await invoke(native,request(root,"head_project_direction_read"))).result.content[0].text,"null");
  const repaired=await invoke(native,request(root,"head_project_initialize_or_resume",{session_id:target}));
  assert.equal(repaired.result._meta.headSessionBinding.retained,true);
  assert.equal((await invoke(native,request(root,"head_conversation_enter"))).result.structuredContent.workContext.sessionId,target);
});

test("C1-F2 pure runtime/readiness refusal preserves absent/default and prior bound choice", async t => {
  for(const bound of [false,true]) for(const scenario of ["invalid-runtime","different-runtime","readiness"]){
    const {root,storage,operational,bridge,host}=fixture(t),native=bridge();
    const prior=bound?createHeadSession({root,purpose:"Prior"}).sessionId:inspectProject(root).state.sessionId;
    const target=createHeadSession({root,purpose:"Rejected selection"}).sessionId;
    if(bound)await invoke(native,request(root,"head_project_initialize_or_resume",{session_id:prior}));
    const before=snapshot(operational);
    const file=path.join(root,storage.directory,"generated/lode-instructions.md"),bytes=fs.readFileSync(file);
    const args={session_id:target};
    if(scenario==="invalid-runtime")args.runtimes=["definitely-invalid-runtime"];
    if(scenario==="different-runtime")args.runtimes=["claude"];
    if(scenario==="readiness")fs.appendFileSync(file,"\nSynthetic managed drift\n");
    const result=await invoke(native,request(root,"head_project_initialize_or_resume",args));
    assert.ok(result.error || result.result?.isError,scenario);
    assert.deepEqual(snapshot(operational),before,scenario+" must fail before any P5 pending publication");
    if(scenario==="readiness")fs.writeFileSync(file,bytes);
    assert.equal(host("native-A").read({root}).status,bound?"bound":"absent");
    const next=await invoke(native,request(root,"head_conversation_enter"));
    assert.equal(next.result.structuredContent.workContext.sessionId,prior,scenario);
  }
});

test("selection basis observed before execution cannot overwrite a newer concurrent choice", async t => {
  const {root,storage,bridge,host}=fixture(t),native=bridge();
  const a=createHeadSession({root,purpose:"A"}).sessionId,b=createHeadSession({root,purpose:"B"}).sessionId;
  await invoke(native,request(root,"head_project_initialize_or_resume",{session_id:a}));
  const result=await native.dispatch(request(root,"head_project_initialize_or_resume"),async(wire,routing)=>{
    const context=await routing.resolveSessionContext(wire);
    assert.equal(context.read(root).sessionId,a);
    const other=host("native-A");other.select({root,sessionId:b,expectedRevision:other.read({root}).revision});
    routing.onValidatedSessionSelection({root,sessionId:a});
    return {result:{structuredContent:{projectAction:"resumed",project:{projectId:inspectProject(root).project.projectId,sessionId:a}}}};
  });
  assert.equal(result.result.structuredContent.project.sessionId,a,"Current frozen route is preserved.");
  assert.equal(host("native-A").read({root}).sessionId,b,"Older observed selection must not overwrite the new choice.");
  assert.equal((await invoke(native,request(root,"head_conversation_enter"))).result.structuredContent.workContext.sessionId,b);
});

test("new-Project initializer completion cannot replace a later retained caller selection", async t => {
  const {root,storage,bridge,host}=fixture(t,false),native=bridge();let newer;
  const result=await native.dispatch(request(root,"head_project_initialize_or_resume",{runtimes:["codex"]}),async(wire,routing)=>{
    const original=await dispatch(wire,routing);
    newer=createHeadSession({root,purpose:"Newer choice before first acknowledgement"}).sessionId;
    host("native-A").select({root,sessionId:newer,expectedRevision:0});
    return original;
  });
  assert.equal(result.result.structuredContent.projectAction,"initialized");
  assert.equal(host("native-A").read({root}).sessionId,newer);
  assert.equal((await invoke(native,request(root,"head_conversation_enter"))).result.structuredContent.workContext.sessionId,newer);
});

test("Claude exact native Hook correlation routes root/child and outer routers without Canon caller identity", async t => {
  const {root,storage,operational,environment}=fixture(t),native=createNativeSessionHostBridge({runtime:"claude",environment});
  const a=createHeadSession({root,purpose:"Root"}).sessionId,b=createHeadSession({root,purpose:"Child"}).sessionId;
  await Promise.all([
    claudeCall(native,claudeRequest(root,"head_project_initialize_or_resume",{session_id:a},"root-init")),
    claudeCall(native,claudeRequest(root,"head_project_initialize_or_resume",{session_id:b},"child-init"),"native-claude-root","native-child"),
  ]);
  await claudeCall(native,claudeRequest(root,"head_session_work_record",{evidence:{unknowns:["Root evidence"]}},"root-save",true));
  const child=await claudeCall(native,claudeRequest(root,"head_conversation_enter",{},"child-read"),"native-claude-root","native-child");
  assert.equal(child.result.structuredContent.workContext.sessionId,b);
  const rootResult=await claudeCall(native,claudeRequest(root,"head_session_work_read",{},"root-read",true));
  assert.equal(rootResult.result.structuredContent.sessionId,a);
  assert.equal(rootResult.result.structuredContent.records[0].content.unknowns[0],"Root evidence");
  assert.equal(native.requestStatus().pending,0);
  assert.equal(JSON.stringify(snapshot(path.join(root,storage.directory))).includes("native-claude-root"),false);
  assert.equal(JSON.stringify(snapshot(operational)).includes("native-claude-root"),false);
});

test("cold Claude missing preparation cannot silently select default; explicit and independent calls remain usable", async t => {
  const {root,storage,environment}=fixture(t),native=createNativeSessionHostBridge({environment});
  await invoke(native,{id:1,method:"initialize",params:{clientInfo:{name:"claude-code",version:"2.1.289"}}});
  const target=createHeadSession({root,purpose:"Explicit"}).sessionId;
  assert.equal((await invoke(native,claudeRequest(root,"head_conversation_enter"))).result.structuredContent.status,"session_selection_unresolved");
  assert.equal((await invoke(native,claudeRequest(root,"head_conversation_enter",{session_id:target}))).result.structuredContent.workContext.sessionId,target);
  assert.equal((await invoke(native,claudeRequest(root,"head_project_direction_read"))).result.content[0].text,"null");
});

test("unavailable Claude linkage is not a new-Project initialization gate or a claimed automatic binding", async t => {
  const {root,storage,environment}=fixture(t,false),native=createNativeSessionHostBridge({runtime:"claude",environment});
  const result=await invoke(native,claudeRequest(root,"head_project_initialize_or_resume",{runtimes:["codex"]}));
  assert.equal(result.result.structuredContent.projectAction,"initialized");
  assert.equal(result.result._meta.headSessionBinding.retained,false);
  assert.equal((await invoke(native,claudeRequest(root,"head_conversation_enter",{},"later"))).result.structuredContent.status,"session_selection_unresolved");
});

test("model direct helper/router/nested fake metadata and unexpanded templates cannot mint claims", async t => {
  const {root,storage,environment}=fixture(t),native=createNativeSessionHostBridge({runtime:"claude",environment});
  const wire=claudeRequest(root,"head_conversation_enter"),helper=hookRequest(wire);
  helper.params._meta={"claudecode/toolUseId":"model-helper"};
  assert.equal((await invoke(native,helper)).result.isError,true);
  const routed=claudeRequest(root,SESSION_HOST_REQUEST_HELPER,hookRequest(wire).params.arguments,"model-router",true);
  assert.equal((await invoke(native,routed)).result.isError,true);
  const unexpanded=hookRequest(wire);unexpanded.params.arguments.native_session_id="${session_id}";
  assert.equal((await invoke(native,unexpanded)).result.isError,true);
  const extra=hookRequest(wire);extra.params.arguments._meta={native_session_id:"forged"};
  assert.equal((await invoke(native,extra)).result.isError,true);
  assert.equal(native.requestStatus().pending,0);
});

test("Claude verifies raw outer args before unwrap; failed correlation does not invalidate explicit Core routing", async t => {
  const {root,storage,environment}=fixture(t),native=createNativeSessionHostBridge({runtime:"claude",environment});
  const target=createHeadSession({root,purpose:"Selected"}).sessionId;
  await claudeCall(native,claudeRequest(root,"head_project_initialize_or_resume",{session_id:target},"select"));
  const wire=claudeRequest(root,"head_session_work_read",{},"tamper",true);
  await invoke(native,hookRequest(wire));wire.params.arguments.arguments.max_records=2;
  assert.equal((await invoke(native,wire)).result.structuredContent.status,"session_selection_unresolved");
  wire.params.arguments.arguments.session_id=target;
  assert.equal((await invoke(native,wire)).result.structuredContent.sessionId,target);
});

test("independent router helper is immediate no-op with zero registry, Session/P5 or graph reads", async t => {
  const {root,storage,operational,environment}=fixture(t),native=createNativeSessionHostBridge({runtime:"claude",environment});
  const wire=claudeRequest(root,"head_project_direction_read",{},"independent",true);
  const read=fs.readFileSync;let forbidden=0;
  fs.readFileSync=(file,...args)=>{
    const value=String(file).replaceAll("\\","/");
    if(value.startsWith(operational.replaceAll("\\","/"))||value.includes(`/${storage.directory}/sessions/`)||value.includes(`/${storage.directory}/world/`)){forbidden++;throw new Error("Unexpected optional routing read");}
    return read(file,...args);
  };
  try{
    assert.equal((await invoke(native,hookRequest(wire))).result.content[0].text,"{}");
      assert.equal((await invoke(native,wire)).result.content[0].text,"null");
  }finally{fs.readFileSync=read;}
  assert.equal(forbidden,0);assert.equal(native.requestStatus().pending,0);assert.equal(fs.existsSync(operational),false);
});

test("registry exact/active/divergent/expiry/capacity/dispose is bounded P5, never another request's effect", () => {
  let time=0;const registry=createSessionHostRequestRegistry({now:()=>time,ttlMs:10,maxPending:2});
  const input={key:"one",caller:{runtime:"claude",nativeSessionId:"native",agentId:null},name:"head_conversation_enter",arguments:{project_root:"synthetic"}};
  registry.prepare(input);registry.prepare(input);assert.equal(registry.describe().pending,1);
  const first=registry.claim(input);
  assert.throws(()=>registry.claim(input),{code:"HOST_REQUEST_CORRELATION_MISSING"});
  assert.throws(()=>registry.prepare({...input,caller:{...input.caller,agentId:"other"}}),{code:"HOST_REQUEST_ALREADY_ACTIVE"});
  assert.equal(first.caller.agentId,null,"Other request cannot replace the live caller.");
  time=20;assert.equal(registry.describe().active,1);first.release();first.release();
  assert.throws(()=>registry.prepare(input),{code:"HOST_REQUEST_ALREADY_CONSUMED"});
  registry.prepare({...input,key:"two"});registry.prepare({...input,key:"three"});
  assert.throws(()=>registry.prepare({...input,key:"four"}),{code:"HOST_REQUEST_CAPACITY"});
  assert.throws(()=>registry.prepare({...input,key:"two",arguments:{project_root:"different"}}),{code:"HOST_REQUEST_DIVERGENT"});
  assert.throws(()=>registry.claim({...input,key:"two"}),{code:"HOST_REQUEST_CORRELATION_MISSING"});
  time=31;assert.equal(registry.describe().pending,0);assert.equal(registry.describe().spent,0);
  registry.dispose();assert.equal(registry.describe().disposed,true);
  assert.throws(()=>registry.prepare(input),{code:"HOST_REQUEST_REGISTRY_DISPOSED"});
});

test("Claude matcher derives Session and effectful coverage from the catalog, excluding helper and other servers", () => {
  const hooks=JSON.parse(fs.readFileSync(path.join(pluginRoot,"hooks/claude.json"),"utf8"));
  assert.deepEqual(hooks.hooks.PreToolUse.map(group=>group.matcher),claudeNativeHookMatchers(catalogTools));
  for(const tool of catalogTools){
    const expected=sessionCallRequiresBinding(tool.name)||["lode_tools_call","lode_tools_read"].includes(tool.name)||tool.annotations?.readOnlyHint!==true;
    for(const spelling of [tool.name,resolveOperation(tool.name).legacyName]){
      assert.equal(new RegExp(hooks.hooks.PreToolUse[0].matcher).test("mcp__lode__"+spelling),expected,spelling);
      assert.equal(new RegExp(hooks.hooks.PreToolUse[1].matcher).test("mcp__plugin_lode-agent-core_lode__"+spelling),expected,spelling);
    }
    for(const prefix of ["mcp__head_core__","mcp__lode_core__","mcp__plugin_lode-agent-core_lode_core__","mcp__plugin_head-agent-core_head_core__"]){
      assert.equal(hooks.hooks.PreToolUse.some(h=>new RegExp(h.matcher).test(prefix+tool.name)),false);
    }
    assert.equal(hooks.hooks.PreToolUse.some(h=>new RegExp(h.matcher).test("mcp__other__"+tool.name)),false);
  }
  for(const prefix of ["mcp__lode__","mcp__plugin_lode-agent-core_lode__"]){
    for(const helper of [SESSION_HOST_REQUEST_HELPER,"lode_session_host_request_prepare"]){
      assert.equal(hooks.hooks.PreToolUse.some(h=>new RegExp(h.matcher).test(prefix+helper)),false);
    }
  }
  assert.equal(/permissionDecision|updatedInput/.test(JSON.stringify(hooks)),false);
});

test("Claude observed native marker cannot degrade to legacy/default when the next metadata is missing", async t => {
  const {root,storage,environment,operational}=fixture(t),native=createNativeSessionHostBridge({environment});
  await invoke(native,{id:1,method:"initialize",params:{clientInfo:{name:"claude-code",version:"synthetic"},protocolVersion:"2024-11-05",capabilities:{}}});
  const before=snapshot(root);
  assert.equal((await invoke(native,claudeRequest(root,"head_conversation_enter"))).result.structuredContent.status,"session_selection_unresolved");
  const missing=request(root,"head_conversation_enter",{},null);
  assert.equal((await invoke(native,missing)).result.structuredContent.status,"session_selection_unresolved");
  const sid=inspectProject(root).state.sessionId;
  assert.equal((await invoke(native,request(root,"head_conversation_enter",{session_id:sid},null))).result.structuredContent.workContext.sessionId,sid);
  assert.equal((await invoke(native,request(root,"head_project_direction_read",{},null))).result.content[0].text,"null");
  assert.deepEqual(snapshot(root),before);assert.equal(fs.existsSync(operational),false);
});

test("canonical routers deny both private-helper aliases before native correlation or any project and P5 access", async t => {
  const { root, operational, environment } = fixture(t, false), base = path.dirname(root);
  const rawSnapshot = () => {
    const entries = [];
    const walk = file => {
      const stat = fs.lstatSync(file), type = stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "link" : "file";
      entries.push({ path: file, type, mode: stat.mode, mtimeMs: stat.mtimeMs,
        ...(type === "file" ? { bytes: fs.readFileSync(file).toString("base64") } : {}) });
      if (type === "directory") for (const name of fs.readdirSync(file).sort()) walk(path.join(file, name));
    };
    walk(base); return entries;
  };
  const before = rawSnapshot(), registryCalls = { prepare: 0, claim: 0, describe: 0 };
  const registry = Object.fromEntries(Object.keys(registryCalls).map(name => [name, () => {
    registryCalls[name] += 1; assert.fail(`Private router target reached registry ${name}`);
  }]));
  registry.dispose = () => {};
  const native = createNativeSessionHostBridge({ runtime: "claude", environment, requestRegistry: registry });
  let handlerCalls = 0, metadataReads = 0;
  const nativeBridge = { dispatch: (wire, handler) => native.dispatch(wire, (original, routing) => {
    handlerCalls += 1; return handler(original, routing);
  }) };
  const originals = [], fsAttempts = [];
  const inside = value => {
    const file = value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : value;
    if (typeof file !== "string") return false;
    const relative = path.relative(base, path.resolve(file));
    return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const destinations = new Set(["rename", "copyFile", "cp", "link", "symlink"]);
  const guard = (object, name) => {
    const original = object[name]; if (typeof original !== "function") return;
    originals.push([object, name, original]);
    object[name] = (...args) => {
      if (inside(args[0]) || destinations.has(name.replace(/Sync$/, "")) && inside(args[1])) {
        fsAttempts.push({ method: name, source: String(args[0]), destination: destinations.has(name.replace(/Sync$/, "")) ? String(args[1]) : null });
        assert.fail(`Private router target attempted scoped filesystem ${name}`);
      }
      return original.apply(object, args);
    };
  };
  for (const name of ["readFile", "readdir", "stat", "lstat", "realpath", "access", "readlink", "writeFile", "appendFile", "mkdir", "rename", "unlink", "rm", "rmdir", "truncate", "chmod", "utimes", "copyFile", "cp", "link", "symlink", "chown", "lchown", "lutimes", "mkdtemp", "open"]) {
    guard(fs, name); guard(fs, `${name}Sync`); guard(fs.promises, name);
  }
  for (const name of ["existsSync", "createReadStream", "createWriteStream"]) guard(fs, name);
  syncBuiltinESMExports();
  try {
    for (const router of ["lode_tools_read", "lode_tools_call"]) {
      for (const helper of ["head_session_host_request_prepare", "lode_session_host_request_prepare"]) {
        const wire = { jsonrpc: "2.0", id: `${router}--${helper}`, method: "tools/call", params: {
          name: router, arguments: { name: helper, arguments: {
            native_session_id: "synthetic-native-private-router", native_agent_id: "", tool_use_id: "synthetic-private-router-tool",
            outer_tool_name: "mcp__lode__lode_conversation_enter", original_arguments: JSON.stringify({ project_root: root }),
          } },
        } };
        Object.defineProperty(wire.params, "_meta", { enumerable: true, get() {
          metadataReads += 1; return { "claudecode/toolUseId": "synthetic-private-router-tool" };
        } });
        const rawBefore = JSON.stringify(wire); metadataReads = 0;
        const result = await dispatch(wire, { nativeSessionBridge: nativeBridge });
        assert.deepEqual(result, { jsonrpc: "2.0", id: wire.id, result: {
          content: [{ type: "text", text: "Native Host request correlation unavailable (NATIVE_HOOK_DIRECT_INGRESS_REQUIRED)." }], isError: true,
        } });
        assert.equal(Object.hasOwn(result, "error"), false, "No generic JSON-RPC -32000 fallback");
        assert.equal(metadataReads, 0); assert.equal(handlerCalls, 0);
        assert.deepEqual(registryCalls, { prepare: 0, claim: 0, describe: 0 });
        assert.equal(JSON.stringify(wire), rawBefore, "Full outer request and exact nested arguments remain untouched");
      }
    }
  } finally {
    for (const [object, name, original] of originals.reverse()) object[name] = original;
    syncBuiltinESMExports(); native.dispose();
  }
  assert.deepEqual(fsAttempts, []); assert.deepEqual(rawSnapshot(), before);
  assert.equal(fs.existsSync(operational), false);
});

// P3 supplies an executable existing read, never an eager list or a new selector.
test("P3 unresolved entry has owner-verified lazy discovery; startup enumerates no Sessions even with a large inventory", async t => {
  const { root, operational, environment } = fixture(t);
  const a = createHeadSession({ root, purpose: "Related title does not prove the same task" }).sessionId;
  const b = createHeadSession({ root, purpose: "Related title does not prove the same task" }).sessionId;
  const directory = path.join(root, ".lode/sessions/by-id");
  for (let i = 0; i < 1024; i++) fs.mkdirSync(path.join(directory, "uninspected-" + i));
  const before = snapshot(root).concat(snapshot(operational));
  const native = createNativeSessionHostBridge({ runtime: "claude", environment });
  t.after(() => native.dispose());
  const original = fs.readdirSync; let enumeration = 0;
  fs.readdirSync = (directory, ...args) => {
    const rel = path.relative(root, String(directory)).replaceAll("\\", "/");
    if (rel === ".lode/sessions" || rel.startsWith(".lode/sessions/")) enumeration++;
    return original(directory, ...args);
  };
  let value;
  try {
    value = (await claudeCall(native, claudeRequest(root, "head_conversation_enter", {}, "p3-unselected"), "new-unbound-chat")).result.structuredContent;
    assert.equal(value.status, "session_selection_unresolved");
    assert.equal(value.sessionId, null); assert.equal(value.ordinaryWorkBlocked, false);
    assert.equal(value.sessionDiscovery.status, "not_queried");
    assert.deepEqual(value.sessionDiscovery.call, { name: "lode_session_list", arguments: { project_root: root } });
    assert.equal(value.sessionDiscovery.automatic, false); assert.equal(value.sessionDiscovery.selectsSession, false);
    assert.equal(value.candidates, undefined, "No unseen candidates or reasons are invented.");
    for (const runtime of ["claude", "codex", "opencode"]) {
      const text = startupProjection(value, root, runtime), view = JSON.parse(text);
      assert(text.length <= MAX_CONTEXT_CHARACTERS[runtime]);
      assert.deepEqual(view.sessionDiscovery, value.sessionDiscovery);
      assert.equal(view.logicalSessionId, null); assert.equal(view.route, null);
      assert.match(view.coreGuidance, /Continue the current user task/u);
      assert.equal(view.expansion, "", "No duplicate discovery prose in the protected envelope.");
    }
    const hook = sessionStartContext({ runtime: "claude", environment,
      event: { hook_event_name: "SessionStart", source: "clear", cwd: root, session_id: "new-no-clear-witness" } });
    assert.equal(JSON.parse(hook.hookSpecificOutput.additionalContext).sessionDiscovery.status, "not_queried");
    assert.equal(enumeration, 0, "Returning a 16-row list would still enumerate all names; do not call it here.");
  } finally { fs.readdirSync = original; }
  assert.deepEqual(snapshot(root).concat(snapshot(operational)), before);
  // Follow only on demand, through the exact returned public call. It remains
  // a read-only preview and does not resolve, select or persist a binding.
  const call = value.sessionDiscovery.call;
  const listed = await claudeCall(native, claudeRequest(root, call.name, { ...call.arguments, max_sessions: 3 }, "p3-demand-list"), "new-unbound-chat");
  assert.equal(listed.error, undefined); assert.equal(listed.result.isError, undefined);
  assert.equal(listed.result.structuredContent.projectId, value.projectId);
  const again = await claudeCall(native, claudeRequest(root, "head_conversation_enter", {}, "p3-still-unselected"), "new-unbound-chat");
  assert.equal(again.result.structuredContent.sessionId, null);
  assert.deepEqual(snapshot(root).concat(snapshot(operational)), before);
  const explicit = await claudeCall(native, claudeRequest(root, "head_conversation_enter", { session_id: a }, "p3-explicit-read"), "new-unbound-chat");
  assert.equal(explicit.result.structuredContent.workContext.sessionId, a);
  assert.notEqual(a, b);
});

test("P3 no named candidates is not approved emptiness; damaged/foreign Project owner supplies no same-Project hint", t => {
  const { root } = fixture(t);
  const value = sessionSelectionUnresolved(root, { includeProjectFacts: true });
  assert.equal(value.sessionDiscovery.status, "not_queried");
  assert.equal(value.sessionId, null); assert.equal(value.candidates, undefined);
  assert.equal(value.recoveryAuthority, false); assert.equal(value.executionReplayAllowed, false);
  const ownerFile = path.join(root, ".lode/project.json"), bytes = fs.readFileSync(ownerFile), owner = JSON.parse(bytes);
  try {
    for (const invalid of ["{bad owner", JSON.stringify({ ...owner, projectRoot: path.dirname(root) })]) {
      fs.writeFileSync(ownerFile, invalid);
      assert.throws(() => sessionSelectionUnresolved(root), error =>
        ["NOT_INITIALIZED", "INVALID_SESSION_CANON", "PROJECT_IDENTITY_MISMATCH"].includes(error.code));
    }
  } finally { fs.writeFileSync(ownerFile, bytes); }
});

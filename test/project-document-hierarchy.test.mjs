import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeProject } from "../scripts/lib/lode-core.mjs";
import { createHeadSession, withSessionRoute } from "../scripts/lib/session-routing.mjs";
import { recordSessionWorkEvidence } from "../scripts/lib/session-work-context.mjs";
import { projectDocumentStore, workDocumentStore } from "../scripts/lib/work-document-store.mjs";
import { readProjectDocumentBasis, renderProjectDocumentPage } from "../scripts/lib/project-document-hierarchy.mjs";
import { createNotionWorkDocumentAdapter, documentDestinationIdentity } from "../scripts/lib/work-document-destinations.mjs";
import { configureWorkDocuments, prepareWorkDocuments } from "../scripts/lib/work-document-publication.mjs";
import { prepareProjectDocuments, publishProjectDocuments, projectDocumentStatus } from "../scripts/lib/project-document-publication.mjs";
import { recordSessionWorkAndProjectDocuments } from "../scripts/lib/session-work-document-workflow.mjs";
import { createDocumentEffectWriter } from "../scripts/lib/work-document-effect-writer.mjs";
import { workDocumentHash } from "../scripts/lib/work-document-source.mjs";
import { createSourceObservation, retainSourceObservation } from "../scripts/lib/source-observation.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";
import { runCommand } from "../scripts/lode.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
function fixture(t) {
  const area = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lode-project-docs-")));
  const root = path.join(area, "same-name"), vault = path.join(area, "vault"); fs.mkdirSync(root); fs.mkdirSync(vault);
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const a = createHeadSession({ root, purpose: "Synthetic wording evidence" }).sessionId;
  const b = createHeadSession({ root, purpose: "Another synthetic task, not inherited direction" }).sessionId;
  t.after(() => { assert.ok(area.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)); fs.rmSync(area, { recursive: true, force: true }); });
  const store = projectDocumentStore({ root, sessionId: a });
  const canon = path.join(root, store.owner.storage.directory, "context", "product-model.json");
  const model = { schemaVersion: 1,
    featureGroups: [{ key: "g1", name: "계정", description: "계정 사용 흐름", parentFeatureGroupKeys: [] },
      { key: "g2", name: "보안", parentFeatureGroupKeys: ["g1"] },
      { key: "g3", name: "공유 구성", parentFeatureGroupKeys: ["g1", "g2"] }],
    features: [{ key: "fa", name: "로그인", description: "입력한 계정으로 로그인합니다.", featureGroupKeys: ["g1", "g3"], capabilityKeys: [], governedBy: [{ kind: "Decision", key: "d1" }] },
      { key: "fb", name: "만료 안내", featureGroupKeys: ["g2"], capabilityKeys: [], governedBy: [{ kind: "Decision", key: "d1" }] },
      { key: "orphan", name: "소속 미확인 기능", featureGroupKeys: [], capabilityKeys: [], governedBy: [] }],
    capabilities: [], requirements: [], constraints: [], decisions: [{ key: "d1", statement: "네트워크 재시도는 사용자가 선택합니다.", status: "active" }] };
  const write = () => fs.writeFileSync(canon, JSON.stringify(model, null, 2) + "\n"); write();
  const save = (sessionId, summary) => withSessionRoute(root, sessionId, () => recordSessionWorkEvidence({ root, input: {
    summary, observedWork: ["합성 원문을 읽어 설명했습니다."], pending: ["모바일 검증과 외부 배포는 실행하지 않았습니다."],
    judgments: [{ assessment: "자동 네트워크 재시도를 추가하지 않음", reason: "중복 요청 가능성을 남겨둡니다.", alternatives: ["명시적 재시도"] }],
    unknowns: ["이 기록은 사용자 승인 원문이 아닙니다."],
  } })).evidence;
  return { area, root, vault, a, b, store, canon, model, write, save };
}
const select = (record, featureKeys = []) => ({ sessionId: record.sessionId, evidenceId: record.evidenceId, evidenceDigest: record.evidenceDigest, featureKeys });

test("actual Canon DAG, shared decision and multi-feature Session remain linked once; both audiences retain facts and uncertainty", t => {
  const f = fixture(t), first = f.save(f.a, "로그인·만료 안내를 함께 검토했습니다."), second = f.save(f.b, "계정 이름과 무관한 미분류 분석입니다.");
  const work = [select(first, ["fa"]), select(first, ["fb"]), select(second, ["unknown-feature"])];
  const basis = readProjectDocumentBasis({ root: f.root, sessionId: f.a, projectTitle: "같은 이름", workEvidence: work,
    narratives: [{ kind: "Feature", key: "fa", sourceKeys: ["Feature:fa", `work:${first.sessionId}/${first.evidenceId}`],
      purpose: "계정으로 로그인하는 흐름을 설명합니다.", useFlow: "계정을 입력한 뒤 로그인합니다.", currentBehavior: "관찰한 설명 범위입니다. 모바일 검증·배포는 미실행입니다." }] });
  const find = (kind, key) => basis.nodes.find(n => n.kind === kind && n.key === key);
  assert.equal(find("FeatureGroup", "g3").parents.length, 2);
  assert.equal(find("Feature", "fa").parents.length, 2);
  assert.equal(basis.nodes.filter(n => n.kind === "Decision" && n.key === "d1").length, 1);
  assert.equal(find("Decision", "d1").related.length, 2);
  assert.equal(basis.nodes.filter(n => n.kind === "Work").length, 2, "same original/digest coalesces reading links, not Canon");
  assert.equal(find("Session", f.a).related.length, 2);
  const workNode = find("Work", `${first.sessionId}/${first.evidenceId}`);
  assert.equal(workNode.related.length, 2);
  assert.ok(find("unclassified", "unclassified").children.includes(find("Feature", "orphan").id));
  const unclassified = find("Work", `${second.sessionId}/${second.evidenceId}`);
  assert.deepEqual(unclassified.data.unresolvedFeatureKeys, ["unknown-feature"]);
  assert.ok(find("unclassified", "unclassified").children.includes(unclassified.id));
  for (const audience of ["human", "agent"]) {
    const view = renderProjectDocumentPage(basis, { nodeId: workNode.id, audience });
    assert.match(view.markdown, /모바일 검증과 외부 배포는 실행하지 않았습니다/);
    assert.match(view.markdown, /중복 요청 가능성을 남겨둡니다/);
    assert.match(view.markdown, /사용자 승인 원문이 아닙니다/);
    const featureView = renderProjectDocumentPage(basis, { nodeId: find("Feature", "fa").id, audience });
    assert.match(featureView.markdown, /계정을 입력한 뒤 로그인합니다/);
    assert.match(featureView.markdown, /모바일 검증·배포는 미실행입니다/);
    for (const page of basis.nodes) for (const match of renderProjectDocumentPage(basis, { nodeId: page.id, audience }).markdown.matchAll(/lode-doc:(human|agent):([a-f0-9]{64})/g)) {
      assert.ok(basis.nodes.some(node => node.id === match[2]), "every generated navigation target exists");
    }
  }
  const human = renderProjectDocumentPage(basis, { nodeId: find("Feature", "fa").id, audience: "human" }).markdown;
  assert.doesNotMatch(human.slice(0, 300), /HEAD|Canon|constraints|Logical page:/);
  assert.equal(basis.authority.recoveryAuthority, false);
});

test("renaming does not change logical page identity; current ownership changes remain actual Canon relationships", t => {
  const f = fixture(t), before = readProjectDocumentBasis({ root: f.root, sessionId: f.a });
  f.model.features[0].name = "새 로그인 이름"; f.model.features[0].featureGroupKeys = ["g2"]; f.write();
  const after = readProjectDocumentBasis({ root: f.root, sessionId: f.a });
  const old = before.nodes.find(n => n.kind === "Feature" && n.key === "fa"), fresh = after.nodes.find(n => n.kind === "Feature" && n.key === "fa");
  assert.equal(old.id, fresh.id); assert.notEqual(before.basisId, after.basisId);
  assert.equal(fresh.title, "새 로그인 이름"); assert.equal(fresh.parents.length, 1);
  assert.equal(after.nodes.find(n => n.id === fresh.parents[0]).key, "g2");
  assert.notEqual(renderProjectDocumentPage(before, { nodeId: old.id }).viewId, renderProjectDocumentPage(after, { nodeId: fresh.id }).viewId);
});

test("actual absence allows unclassified work; malformed Canon and permission denial preserve primary failure", t => {
  const f = fixture(t), record = f.save(f.a, "설명만 작성한 결과도 유효합니다.");
  const options = { root: f.root, sessionId: f.a, workEvidence: [select(record, ["fa"])] };
  fs.unlinkSync(f.canon);
  const absent = readProjectDocumentBasis(options);
  assert.equal(absent.productCanon.status, "missing-empty-default");
  assert.equal(absent.nodes.filter(n => n.kind === "Feature").length, 0);
  assert.equal(absent.nodes.find(n => n.kind === "Work").data.unresolvedFeatureKeys[0], "fa");
  fs.writeFileSync(f.canon, "{ malformed Canon");
  assert.throws(() => readProjectDocumentBasis(options), { code: "INVALID_PRODUCT_MODEL_JSON" });
  f.write(); const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", function (file, ...args) {
    if (String(file) === f.canon) throw Object.assign(new Error("Synthetic permission refusal"), { code: "EACCES" });
    return read.call(this, file, ...args);
  });
  assert.throws(() => readProjectDocumentBasis(options), { code: "EACCES" });
});

test("Project P5 is shared across logical Sessions; task stores and Session direction remain separate", t => {
  const f = fixture(t), a = projectDocumentStore({ root: f.root, sessionId: f.a }), b = projectDocumentStore({ root: f.root, sessionId: f.b });
  const aState = fs.readFileSync(path.join(f.root, a.caller.statePath)), bState = fs.readFileSync(path.join(f.root, b.caller.statePath));
  assert.equal(a.file("receipt.json"), b.file("receipt.json"));
  a.write(["receipt.json"], { links: ["A"] }); assert.deepEqual(b.read("receipt.json"), { links: ["A"] });
  const envelope = JSON.parse(fs.readFileSync(a.file("receipt.json")));
  assert.equal(envelope.authorityPlane, "P5"); assert.equal(envelope.sessionId, null); assert.equal(envelope.executionReplayAllowed, false);
  const taskA = workDocumentStore({ root: f.root, sessionId: f.a }), taskB = workDocumentStore({ root: f.root, sessionId: f.b });
  taskA.write(["selection.json"], { owner: "A" }); assert.equal(taskB.read("selection.json"), null);
  assert.deepEqual(fs.readFileSync(path.join(f.root, a.caller.statePath)), aState);
  assert.deepEqual(fs.readFileSync(path.join(f.root, b.caller.statePath)), bState);
});

test("destination aliases share actual resource identity; child Notion scope keeps exact parent and one publication budget", async t => {
  const f = fixture(t), parent = "10000000-0000-4000-8000-000000000001", container = "10000000-0000-4000-8000-000000000002", page = "10000000-0000-4000-8000-000000000003";
  assert.equal(documentDestinationIdentity({ kind: "obsidian", id: "alpha", vaultRoot: f.vault }), documentDestinationIdentity({ kind: "obsidian", id: "beta", vaultRoot: path.join(f.vault, ".") }));
  assert.equal(documentDestinationIdentity({ kind: "notion", parentPageId: parent }), documentDestinationIdentity({ kind: "notion", parentPageId: parent.replaceAll("-", "") }));
  let calls = 0;
  const request = async call => { calls++; const url = new URL(call.url), id = url.pathname.split("/")[3];
    return { status: 200, body: url.pathname.endsWith("/markdown")
      ? { object: "page_markdown", id, markdown: "Synthetic body", truncated: false, unknown_block_ids: [] }
      : { object: "page", id, parent: { page_id: id === container ? parent : container } } };
  };
  const adapter = createNotionWorkDocumentAdapter({ parentPageId: parent, request, requestBudget: 3 }), child = adapter.scoped(container);
  adapter.beginPublication(); await adapter.read(container); child.beginPublication();
  await assert.rejects(child.read(page), { code: "WORK_DOCUMENT_TRANSPORT_BUDGET" });
  assert.equal(calls, 3, "child begin cannot reset the shared transport budget");
  adapter.beginPublication();
  await assert.rejects(adapter.read(page), { code: "WORK_DOCUMENT_REMOTE_DRIFT" });
  assert.throws(() => createNotionWorkDocumentAdapter({ parentPageId: parent, request, _sharedBudget: { used: -100, deadline: Infinity } }));
});

const connect = (f, sessionId=f.a, id="docs", projectDocuments=true) => configureWorkDocuments({root:f.root,sessionId,
  targets:[{id,kind:"obsidian",vaultRoot:f.vault,automatic:false,todoIds:[],projectDocuments}]});
async function finish(f, prepared, sessionId=f.a, targetId="docs", extra={}) {
  for(let i=0;i<400;i++) {
    const result=await publishProjectDocuments({root:f.root,sessionId,projectionId:prepared.projectionId,targetIds:[targetId],...extra});
    if(result.status==="published")return result;
    assert.equal(result.status,"continuation-required",JSON.stringify(result));
  }
  assert.fail("Bounded continuation made no terminal progress");
}
function vaultFiles(directory) {
  return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?vaultFiles(path.join(directory,entry.name)):[path.join(directory,entry.name)]);
}
test("project scope is explicit; real vault navigation, rich reading, notes and same-basis replay remain separate",async t=>{
  const f=fixture(t), record=f.save(f.a,"로그인 동작을 설명했습니다.");
  const pair=await prepareWorkDocuments({root:f.root,sessionId:f.a,title:"로그인 근거",taskEvidenceId:record.evidenceId,evidenceIds:[record.evidenceId]});
  connect(f,f.a,"docs",false);
  const prepared=await prepareProjectDocuments({root:f.root,sessionId:f.a,projectTitle:"같은 제품",workEvidence:[select(record,["fa"])],
    readings:[{sessionId:f.a,projectionId:pair.projectionId}]});
  const denied=await publishProjectDocuments({root:f.root,sessionId:f.a,projectionId:prepared.projectionId,targetIds:["docs"]});
  assert.equal(denied.destinations[0].status,"project-scope-not-connected");assert.deepEqual(fs.readdirSync(f.vault),[]);
  const current=workDocumentStore({root:f.root,sessionId:f.a}).read("configuration.json");
  configureWorkDocuments({root:f.root,sessionId:f.a,expectedConfigurationDigest:current.configurationDigest,
    targets:[{id:"docs",kind:"obsidian",vaultRoot:f.vault,automatic:false,todoIds:[],projectDocuments:true}]});
  await finish(f,prepared);
  const files=vaultFiles(f.vault), project=projectDocumentStatus({root:f.root,sessionId:f.a}).destinations[0].current;
  assert.ok(files.length>20);assert.equal(project.remoteCAS,false);
  for(const file of files)for(const match of fs.readFileSync(file,"utf8").matchAll(/\]\(([^)]+\.md)\)/g)) {
    assert.ok(fs.existsSync(path.resolve(path.dirname(file),decodeURIComponent(match[1]))),"real relative link exists: "+file+" -> "+match[1]);
  }
  assert.ok(files.some(file=>fs.readFileSync(file,"utf8").includes("정확한 변경 전후 비교는 선택하지 않았습니다")));
  const notes=files.find(file=>path.basename(file)==="Notes.md");fs.appendFileSync(notes,"\nUser personal notes\n");
  const before=new Map(files.map(file=>[file,fs.readFileSync(file)])); await finish(f,prepared);
  assert.equal(vaultFiles(f.vault).length,files.length,"same-basis publish creates no new artifacts");
  for(const [file,bytes]of before)assert.deepEqual(fs.readFileSync(file),bytes);
});

test("shared canonical destination retains A/B contributions; rename keeps page IDs and history and removed membership",async t=>{
  const f=fixture(t), a=f.save(f.a,"A 기록"), b=f.save(f.b,"B 기록");connect(f);connect(f,f.b,"alias");
  const first=await prepareProjectDocuments({root:f.root,sessionId:f.a,workEvidence:[select(a,["fa"])]});await finish(f,first);
  const second=await prepareProjectDocuments({root:f.root,sessionId:f.b,workEvidence:[select(b,["fb"])]});await finish(f,second,f.b,"alias");
  const sa=projectDocumentStatus({root:f.root,sessionId:f.a}).destinations[0].current;
  const sb=projectDocumentStatus({root:f.root,sessionId:f.b}).destinations[0].current;
  assert.equal(sa.homeId,sb.homeId);assert.equal(sa.projectionId,sb.projectionId);
  f.model.features[0].name="새 로그인";f.model.features[0].featureGroupKeys=["g2"];f.write();
  const third=await prepareProjectDocuments({root:f.root,sessionId:f.a,workEvidence:[select(a,["fa"])]});
  const inProgress=await publishProjectDocuments({root:f.root,sessionId:f.a,projectionId:third.projectionId,targetIds:["docs"]});
  assert.equal(inProgress.status,"continuation-required");
  const pendingHome=vaultFiles(f.vault).find(file=>path.basename(file)==="Start.md");
  assert.match(fs.readFileSync(pendingHome,"utf8"),/^# 문서 갱신 중/);
  assert.equal(projectDocumentStatus({root:f.root,sessionId:f.a}).destinations[0].current.projectionId,second.projectionId);
  await finish(f,third);
  assert.doesNotMatch(fs.readFileSync(pendingHome,"utf8"),/^# 문서 갱신 중/);
  const files=vaultFiles(f.vault), content=files.map(file=>fs.readFileSync(file,"utf8"));
  assert.ok(content.some(body=>body.includes("B 기록")),"unselected B is retained");
  assert.ok(files.some(file=>path.basename(file).startsWith("history-")));
  assert.equal(projectDocumentStatus({root:f.root,sessionId:f.a}).destinations[0].current.homeId,sa.homeId);
  const stable=readProjectDocumentBasis({root:f.root,sessionId:f.a}).nodes.find(n=>n.kind==="Feature"&&n.key==="fa").id;
  assert.equal(files.filter(file=>path.basename(file)===stable+".md").length,2,"one stable Feature page per audience");
  const feature=fs.readFileSync(files.find(file=>file.endsWith(path.sep+"human"+path.sep+stable+".md")),"utf8");
  assert.match(feature,/새 로그인/);assert.doesNotMatch(feature,/lode-doc:/);
  const currentGroupIds=readProjectDocumentBasis({root:f.root,sessionId:f.a}).nodes.filter(node=>node.kind==="FeatureGroup"&&node.key!=="g2").map(node=>node.id);
  for(const id of currentGroupIds)assert.ok(!feature.includes(id+".md"),"removed memberships are absent from the current Feature page");
  const beforeUnknown=projectDocumentStatus({root:f.root,sessionId:f.a}).destinations[0].current;
  const bOwner=projectDocumentStore({root:f.root,sessionId:f.b}).caller,bPath=path.join(f.root,bOwner.workDirectory,b.evidenceId+".json"),read=fs.readFileSync;
  t.mock.method(fs,"readFileSync",function(file,...args){if(path.resolve(String(file))===path.resolve(bPath))throw Object.assign(new Error("Synthetic prior contributor denied"),{code:"EACCES"});return read.call(this,file,...args);});
  await assert.rejects(prepareProjectDocuments({root:f.root,sessionId:f.a,workEvidence:[select(a,["fa"])]}),error=>Boolean(error.code&&error.primaryReasonCode));
  assert.deepEqual(projectDocumentStatus({root:f.root,sessionId:f.a}).destinations[0].current,beforeUnknown);
});

test("same-title Projects share one parent and vault without sharing homes, nodes or updates",async t=>{
  const a=fixture(t),b=fixture(t),fake=notionFixture();b.vault=a.vault;
  for(const f of [a,b])configureWorkDocuments({root:f.root,sessionId:f.a,targets:[
    {id:"docs",kind:"obsidian",vaultRoot:f.vault,automatic:false,todoIds:[],projectDocuments:true},
    {id:"notion",kind:"notion",parentPageId:fake.parent,tokenEnvironment:"LODE_SYNTHETIC_UNUSED",automatic:false,todoIds:[],projectDocuments:true}]});
  const pa=await prepareProjectDocuments({root:a.root,sessionId:a.a,projectTitle:"Same title"});
  const pb=await prepareProjectDocuments({root:b.root,sessionId:b.a,projectTitle:"Same title"});
  for(const [f,p]of [[a,pa],[b,pb]]){await finish(f,p);await finish(f,p,f.a,"notion",{adapters:{notion:fake.adapter}});}
  const aHome=projectDocumentStatus({root:a.root,sessionId:a.a}).destinations.find(item=>item.id==="notion").current.homeId;
  const bHome=projectDocumentStatus({root:b.root,sessionId:b.a}).destinations.find(item=>item.id==="notion").current.homeId;
  assert.notEqual(aHome,bHome);assert.equal([...fake.pages.values()].filter(page=>page.parent.page_id===fake.parent).length,2);
  const oldB=fake.pages.get(bHome).markdown;
  a.model.features[0].description="Only Project A changed";a.write();
  const next=await prepareProjectDocuments({root:a.root,sessionId:a.a,projectTitle:"Same title"});await finish(a,next,a.a,"notion",{adapters:{notion:fake.adapter}});
  assert.equal(fake.pages.get(bHome).markdown,oldB);
  assert.ok(fs.existsSync(path.join(a.vault,"Lode",pa.projectId,"ProjectDocuments","Start.md")));
  assert.ok(fs.existsSync(path.join(a.vault,"Lode",pb.projectId,"ProjectDocuments","Start.md")));
});

test("more than 65 pages progress without prefix restart; stale basis and remote edit preserve prior current",async t=>{
  const f=fixture(t);connect(f);
  for(let i=0;i<35;i++)f.model.features.push({key:"extra"+i,name:"항목 "+i,featureGroupKeys:["g1"],capabilityKeys:[],governedBy:[]});
  f.write();const prepared=await prepareProjectDocuments({root:f.root,sessionId:f.a});assert.ok(prepared.pageCount>65);
  const initial=await publishProjectDocuments({root:f.root,sessionId:f.a,projectionId:prepared.projectionId,targetIds:["docs"]});
  assert.equal(initial.status,"continuation-required");
  f.model.features[0].name="새 제목";f.write();
  const stale=await publishProjectDocuments({root:f.root,sessionId:f.a,projectionId:prepared.projectionId,targetIds:["docs"]});
  assert.equal(stale.destinations[0].reasonCode,"PROJECT_DOCUMENT_SOURCE_CHANGED");
  const fresh=await prepareProjectDocuments({root:f.root,sessionId:f.a});await finish(f,fresh);
  const before=projectDocumentStatus({root:f.root,sessionId:f.a}).destinations[0].current;
  const home=vaultFiles(f.vault).find(file=>path.basename(file)==="Start.md");fs.appendFileSync(home,"\nUser edit\n");
  const edited=await publishProjectDocuments({root:f.root,sessionId:f.a,projectionId:fresh.projectionId,targetIds:["docs"]});
  assert.equal(edited.destinations[0].reasonCode,"WORK_DOCUMENT_REMOTE_DRIFT");
  assert.deepEqual(projectDocumentStatus({root:f.root,sessionId:f.a}).destinations[0].current,before);
});

test("automatic project publication follows a saved analysis without Todo or flat task pages; retained narrative does not rebind new Canon",async t=>{
  const f=fixture(t);
  configureWorkDocuments({root:f.root,sessionId:f.a,targets:[{id:"docs",kind:"obsidian",vaultRoot:f.vault,automatic:true,todoIds:[],projectDocuments:true}]});
  const saved=await withSessionRoute(f.root,f.a,()=>recordSessionWorkAndProjectDocuments({root:f.root,input:{summary:"분석만 수행했고 배포는 실행하지 않았습니다."},
    documentSelection:{featureKeys:["fa"]}}));
  assert.equal(saved.status,"session_work_evidence_recorded");assert.equal(saved.documentProjection.projectDocuments.status,"continuation-required");
  const follow=saved.documentProjection.projectDocuments.followUp;await finish(f,{projectionId:follow.projectionId});
  assert.equal(vaultFiles(f.vault).filter(file=>path.basename(file)==="Start.md").length,1,"new project scope does not make flat task roots");
  const first=await prepareProjectDocuments({root:f.root,sessionId:f.a,narratives:[{kind:"Feature",key:"fa",sourceKeys:["Feature:fa"],currentBehavior:"로그인 설명 원문을 읽었습니다."}]});
  await finish(f,first);f.model.features[0].description="이전과 달라진 원문";f.write();
  const next=await prepareProjectDocuments({root:f.root,sessionId:f.a});await finish(f,next);
  const docs=vaultFiles(f.vault).filter(file=>!path.basename(file).startsWith("history-")).map(file=>fs.readFileSync(file,"utf8"));
  assert.ok(docs.some(body=>body.includes("이전에 선택한 원문")&&body.includes("로그인 설명 원문을 읽었습니다")));
});

test("damaged optional publication configuration cannot hide or fail an already saved P3 result",async t=>{
  const f=fixture(t);connect(f);
  const taskStore=workDocumentStore({root:f.root,sessionId:f.a});
  fs.writeFileSync(taskStore.file("configuration.json"),"{ broken optional operational record");
  const result=await withSessionRoute(f.root,f.a,()=>recordSessionWorkAndProjectDocuments({root:f.root,input:{summary:"Saved independently of optional publication"}}));
  assert.equal(result.status,"session_work_evidence_recorded");assert.equal(result.documentProjection.originalWorkSaved,true);
  assert.equal(result.documentProjection.reasonCode,"WORK_DOCUMENT_RECORD_TAMPER");assert.equal(result.documentProjection.ordinaryWorkBlocked,false);
  assert.deepEqual(fs.readdirSync(f.vault),[]);
});

function notionFixture() {
  const parent="10000000-0000-4000-8000-000000000001",pages=new Map(),calls=[],fault={};let sequence=10;
  const request=async call=>{
    const url=new URL(call.url);calls.push({method:call.method,url:call.url,body:call.body});
    if (call.method==="POST") {
      if (fault.reject) return {status:403,body:{object:"error",status:403,code:"restricted_resource",message:"Synthetic bounded refusal"}};
      const id="10000000-0000-4000-8000-"+String(sequence++).padStart(12,"0"), page={id,parent:{page_id:call.body.parent.page_id},markdown:call.body.markdown};
      pages.set(id,page);
      if (fault.lose) {fault.lose=false;throw Object.assign(new Error("Synthetic response loss"),{code:"ECONNRESET"});}
      return {status:200,body:page};
    }
    if (url.pathname.includes("/blocks/")) {
      const id=url.pathname.split("/")[3],children=[...pages.values()].filter(page=>page.parent.page_id===id);
      const offset=Number(url.searchParams.get("start_cursor")||0),chunk=children.slice(offset,offset+100);
      return {status:200,body:{results:chunk.map(page=>({id:page.id,type:"child_page"})),has_more:offset+100<children.length,next_cursor:String(offset+100)}};
    }
    if (url.pathname.includes("/async_tasks/")) return {status:200,body:{id:"task_fixture",status:fault.taskStatus||"running",
      ...(fault.taskStatus==="succeeded"?{result:{object:"page_markdown",id:fault.taskPageId}}:{})}};
    const match=/\/pages\/([^/]+)(\/markdown)?$/.exec(url.pathname),page=pages.get(match?.[1]);
    if (!page)return {status:404,body:{object:"error"}};
    if (call.method==="PATCH") {
      if (fault.rejectPatch) return {status:403,body:{object:"error",status:403,code:"restricted_resource",message:"Synthetic progress marker refusal"}};
      const {old_str,new_str}=call.body.update_content.content_updates[0];
      assert.equal(page.markdown.split(old_str).length,2);page.markdown=page.markdown.replace(old_str,new_str);
      if (fault.losePatch) {fault.losePatch=false;throw Object.assign(new Error("Lost update"),{code:"ECONNRESET"});}
      if (fault.asyncPatch) {fault.asyncPatch=false;fault.taskPageId=page.id;return {status:202,body:{id:"task_fixture",status:"queued",poll_after_seconds:1}};}
    }
    return {status:200,body:match[2]?{object:"page_markdown",id:page.id,markdown:page.markdown,truncated:false,unknown_block_ids:[]}:page};
  };
  return {parent,pages,calls,fault,adapter:createNotionWorkDocumentAdapter({parentPageId:parent,request}),request};
}
test("actual Notion parent scopes, lost root create after rename, exact refusal retry and no foreign retry effects",async t=>{
  const f=fixture(t),fake=notionFixture();
  configureWorkDocuments({root:f.root,sessionId:f.a,targets:[{id:"notion",kind:"notion",parentPageId:fake.parent,tokenEnvironment:"LODE_SYNTHETIC_UNUSED",automatic:false,todoIds:[],projectDocuments:true}]});
  const first=await prepareProjectDocuments({root:f.root,sessionId:f.a,projectTitle:"Old name"});
  fake.fault.lose=true;
  const lost=await publishProjectDocuments({root:f.root,sessionId:f.a,projectionId:first.projectionId,targetIds:["notion"],adapters:{notion:fake.adapter}});
  assert.equal(lost.destinations[0].reasonCode,"ECONNRESET");
  const fresh=await prepareProjectDocuments({root:f.root,sessionId:f.a,projectTitle:"New name"});
  await finish(f,fresh,f.a,"notion",{adapters:{notion:fake.adapter}});
  const roots=[...fake.pages.values()].filter(page=>page.parent.page_id===fake.parent);
  assert.equal(roots.length,1,"renaming cannot replay the unresolved old create");
  assert.match(roots[0].markdown,/New name/);
  for(const page of fake.pages.values())for(const link of page.markdown.matchAll(/https:\/\/www\.notion\.so\/([a-f0-9]{32})/g)) {
    assert.ok([...fake.pages.keys()].some(id=>id.replaceAll("-","")===link[1]));
  }
  const before=fake.calls.length;
  const invalid=await publishProjectDocuments({root:f.root,sessionId:f.a,projectionId:fresh.projectionId,targetIds:["notion"],adapters:{notion:fake.adapter},
    retryRejectedWrites:[{targetId:"notion",attemptId:"a".repeat(64)}]});
  assert.equal(invalid.destinations[0].reasonCode,"WORK_DOCUMENT_RETRY_SCOPE_CHANGED");assert.equal(fake.calls.length,before);
  const another=fixture(t),refusal=notionFixture();refusal.fault.reject=true;
  configureWorkDocuments({root:another.root,sessionId:another.a,targets:[{id:"notion",kind:"notion",parentPageId:refusal.parent,tokenEnvironment:"LODE_SYNTHETIC_UNUSED",automatic:false,todoIds:[],projectDocuments:true}]});
  const p=await prepareProjectDocuments({root:another.root,sessionId:another.a});
  const options={root:another.root,sessionId:another.a,projectionId:p.projectionId,targetIds:["notion"],adapters:{notion:refusal.adapter}};
  const rejected=await publishProjectDocuments(options);assert.equal(rejected.destinations[0].status,"request-rejected-no-write");
  refusal.fault.reject=false;const posts=refusal.calls.filter(call=>call.method==="POST").length;
  const again=await publishProjectDocuments(options);assert.equal(again.destinations[0].status,"request-rejected-no-write");
  assert.equal(refusal.calls.filter(call=>call.method==="POST").length,posts);
  const retried=await publishProjectDocuments({...options,retryRejectedWrites:[rejected.destinations[0].retry]});
  assert.equal(retried.status,"continuation-required");await finish(another,p,another.a,"notion",{adapters:{notion:refusal.adapter}});
});

test("Project async updates require terminal success even when the new body is visible; failed task cannot publish or replay",async t=>{
  for(const disposition of ["succeeded","failed"])await t.test(disposition,async t=>{
    let clock=Date.now();t.mock.method(Date,"now",()=>clock);
    const f=fixture(t),fake=notionFixture();
    configureWorkDocuments({root:f.root,sessionId:f.a,targets:[{id:"notion",kind:"notion",parentPageId:fake.parent,tokenEnvironment:"LODE_SYNTHETIC_UNUSED",automatic:false,todoIds:[],projectDocuments:true}]});
    const prepared=await prepareProjectDocuments({root:f.root,sessionId:f.a}),options={root:f.root,sessionId:f.a,projectionId:prepared.projectionId,targetIds:["notion"],adapters:{notion:fake.adapter}};
    let allocated;
    for(let i=0;i<30;i++){allocated=await publishProjectDocuments(options);if(allocated.destinations[0].phase==="render")break;assert.equal(allocated.status,"continuation-required");}
    assert.equal(allocated.destinations[0].phase,"render");fake.fault.asyncPatch=true;
    const pending=await publishProjectDocuments(options);assert.equal(pending.destinations[0].reasonCode,"WORK_DOCUMENT_ASYNC_PENDING");
    clock+=2000;
    const still=await publishProjectDocuments(options);assert.equal(still.destinations[0].reasonCode,"WORK_DOCUMENT_ASYNC_PENDING");
    assert.equal(projectDocumentStatus({root:f.root,sessionId:f.a}).destinations[0].current,null);
    fake.fault.taskStatus=disposition;clock+=2000;
    if(disposition==="succeeded")await finish(f,prepared,f.a,"notion",{adapters:{notion:fake.adapter}});
    else {
      const failed=await publishProjectDocuments(options);assert.equal(failed.destinations[0].reasonCode,"WORK_DOCUMENT_ASYNC_FAILED");
      const again=await publishProjectDocuments(options);assert.equal(again.destinations[0].reasonCode,"WORK_DOCUMENT_ASYNC_FAILED");
      assert.equal(projectDocumentStatus({root:f.root,sessionId:f.a}).destinations[0].current,null);
    }
    assert.equal(fake.calls.filter(call=>call.method==="PATCH"&&new URL(call.url).pathname==="/v1/pages/"+fake.fault.taskPageId+"/markdown").length,1);
  });
});

test("successor progress marker refusal stops child changes and cannot auto-retry or replace the prior current receipt",async t=>{
  const f=fixture(t),fake=notionFixture();
  configureWorkDocuments({root:f.root,sessionId:f.a,targets:[{id:"notion",kind:"notion",parentPageId:fake.parent,tokenEnvironment:"LODE_SYNTHETIC_UNUSED",automatic:false,todoIds:[],projectDocuments:true}]});
  const first=await prepareProjectDocuments({root:f.root,sessionId:f.a});await finish(f,first,f.a,"notion",{adapters:{notion:fake.adapter}});
  const old=projectDocumentStatus({root:f.root,sessionId:f.a}).destinations[0].current;
  f.model.features[0].name="Successor title";f.write();
  const next=await prepareProjectDocuments({root:f.root,sessionId:f.a}),options={root:f.root,sessionId:f.a,projectionId:next.projectionId,targetIds:["notion"],adapters:{notion:fake.adapter}};
  fake.fault.rejectPatch=true;const start=fake.calls.length,refused=await publishProjectDocuments(options);
  assert.equal(refused.destinations[0].status,"request-rejected-no-write");
  const writes=fake.calls.slice(start).filter(call=>call.method!=="GET");
  assert.equal(writes.length,1);assert.equal(new URL(writes[0].url).pathname,"/v1/pages/"+old.homeId+"/markdown");
  assert.deepEqual(projectDocumentStatus({root:f.root,sessionId:f.a}).destinations[0].current,old);
  fake.fault.rejectPatch=false;const before=fake.calls.length,notRetried=await publishProjectDocuments(options);
  assert.equal(notRetried.destinations[0].status,"request-rejected-no-write");
  assert.equal(fake.calls.slice(before).filter(call=>call.method!=="GET").length,0);
  const allowed=await publishProjectDocuments({...options,retryRejectedWrites:[refused.destinations[0].retry]});
  assert.equal(allowed.status,"continuation-required");assert.match(fake.pages.get(old.homeId).markdown,/^# 문서 갱신 중/);
  await finish(f,next,f.a,"notion",{adapters:{notion:fake.adapter}});
  assert.doesNotMatch(fake.pages.get(old.homeId).markdown,/^# 문서 갱신 중/);
});

test("unknown creation beyond 65 siblings reaches candidate evidence without claiming current uniqueness or another POST",async t=>{
  const f=fixture(t),fake=notionFixture(),store=projectDocumentStore({root:f.root,sessionId:f.a});
  for(let i=0;i<70;i++)fake.pages.set("10000000-0000-4000-8000-"+String(100+i).padStart(12,"0"),
    {id:"10000000-0000-4000-8000-"+String(100+i).padStart(12,"0"),parent:{page_id:fake.parent},markdown:"Other "+i});
  const writer=createDocumentEffectWriter({store,adapter:fake.adapter,key:"synthetic-search",target:{id:"notion"},configurationDigest:"a".repeat(64),
    prepared:{projectionId:"b".repeat(64)},previous:null});
  fake.fault.lose=true;await assert.rejects(writer.create("page","Start.md","Exact title","Exact body"),{code:"ECONNRESET"});
  let candidate;
  for(let i=0;i<12;i++) {
    fake.adapter.beginPublication();
    try {await writer.create("page","Start.md","Exact title","Exact body");assert.fail("Paged observations must not create a binding");}
    catch(error){
      if(error.code==="WORK_DOCUMENT_CREATE_CANDIDATE_UNCONFIRMED"){candidate=error;break;}
      assert.equal(error.code,"WORK_DOCUMENT_CREATE_UNKNOWN");
    }
  }
  assert.ok(candidate?.candidateObservations.some(value=>value.status==="exact-body-at-last-read"));
  assert.equal(candidate.primaryReasonCode,"WORK_DOCUMENT_CREATE_UNKNOWN");
  assert.equal(fake.calls.filter(call=>call.method==="POST").length,1);
  const first=[...fake.pages.values()][0];first.markdown="Exact body";
  fake.adapter.beginPublication();
  await assert.rejects(writer.create("page","Start.md","Exact title","Exact body"),{code:"WORK_DOCUMENT_CREATE_CANDIDATE_UNCONFIRMED"});
  assert.equal(fs.existsSync(store.file("recovered")),false);
});

test("paged prefix body drift and changed/deleted prior candidates never establish binding across restart or new basis",async t=>{
  for(const mode of ["prefix-new-match","old-match-changed","old-match-deleted"])await t.test(mode,async t=>{
    const f=fixture(t),fake=notionFixture(),store=projectDocumentStore({root:f.root,sessionId:f.a});
    for(let i=0;i<12;i++) {
      const id="10000000-0000-4000-8000-"+String(100+i).padStart(12,"0");
      fake.pages.set(id,{id,parent:{page_id:fake.parent},markdown:i===0&&mode!=="prefix-new-match"?"Exact body":"Other "+i});
    }
    const make=projectionId=>createDocumentEffectWriter({store,adapter:fake.adapter,key:"same-owned-attempt",target:{id:"canonical-destination"},
      configurationDigest:"a".repeat(64),prepared:{projectionId},previous:null});
    let writer=make("b".repeat(64));fake.fault.lose=true;
    await assert.rejects(writer.create("same","Start.md","Original title","Exact body"),{code:"ECONNRESET"});
    fake.adapter.beginPublication();await assert.rejects(writer.create("same","Start.md","Original title","Exact body"),{code:"WORK_DOCUMENT_CREATE_UNKNOWN"});
    const first=[...fake.pages.values()][0];
    if(mode==="prefix-new-match")first.markdown="Exact body";
    else if(mode==="old-match-changed")first.markdown="Changed content";
    else fake.pages.delete(first.id);
    writer=make("c".repeat(64));fake.adapter.beginPublication();
    let observed;
    for(let i=0;i<4;i++) {
      try {await writer.create("same","Start.md","Original title","Exact body");assert.fail("Must not recover from paged observations");}
      catch(error){if(error.code==="WORK_DOCUMENT_CREATE_CANDIDATE_UNCONFIRMED"){observed=error;break;}assert.equal(error.code,"WORK_DOCUMENT_CREATE_UNKNOWN");}
      fake.adapter.beginPublication();
    }
    assert.ok(observed);assert.equal(fake.calls.filter(call=>call.method==="POST").length,1);
    assert.equal(fs.existsSync(store.file("recovered")),false);
    if(mode!=="prefix-new-match")assert.ok(observed.candidateObservations.some(row=>row.id===first.id&&row.status!=="exact-body-at-last-read"));
    // Even a now-small listing or a lost replaceable search cache cannot erase
    // the immutable fact that this attempt required different-time slices.
    for(const page of [...fake.pages.values()])if(page.id!==observed.candidateObservations.find(row=>row.status==="exact-body-at-last-read")?.id)fake.pages.delete(page.id);
    for(const file of fs.readdirSync(store.file("search")))fs.unlinkSync(store.file("search",file));
    fake.adapter.beginPublication();
    await assert.rejects(make("d".repeat(64)).create("same","Start.md","Original title","Exact body"),{code:"WORK_DOCUMENT_CREATE_CANDIDATE_UNCONFIRMED"});
  });
});

test("typed MCP and CLI share Project identity; real retained before/after reading is navigable without Product inference",async t=>{
  const f=fixture(t),owner=f.store.caller;connect(f);
  const retain=(text)=>{const bytes=Buffer.from(text);fs.writeFileSync(path.join(f.root,"login.mjs"),bytes);
    const digest=workDocumentHash(bytes);retainSourceObservation(f.root,createSourceObservation({version:1,projectId:owner.projectId,kind:"source",
      query:[{path:"login.mjs",symbol:""}],sources:[{path:"login.mjs",digest,base64:bytes.toString("base64")}],profile:{},observedAt:"2026-01-01T00:00:00Z",response:null,envelopeHash:null},owner.storage),owner.storage);
    return withSessionRoute(f.root,f.a,()=>recordSessionWorkEvidence({root:f.root,input:{summary:"Exact source quotation, not implementation proof",
      references:[{kind:"source",path:"login.mjs",digest}]}})).evidence;};
  const before=retain("export function login() { return false; }\n");
  const after=retain("export function login() { return true; }\n");
  const pair=await prepareWorkDocuments({root:f.root,sessionId:f.a,title:"Actual before/after",taskEvidenceId:before.evidenceId,evidenceIds:[before.evidenceId],
    related:[{sessionId:f.a,evidenceId:after.evidenceId,evidenceDigest:after.evidenceDigest}],
    diffs:[{before:{evidenceId:before.evidenceId,referenceIndex:0},after:{evidenceId:after.evidenceId,referenceIndex:0}}],
    excerpts:[{evidenceId:after.evidenceId,referenceIndex:0,startLine:1,endLine:1}]});
  const response=await dispatch({jsonrpc:"2.0",id:"hierarchy",method:"tools/call",params:{name:"lode_project_document_prepare",arguments:{
    project_root:f.root,session_id:f.a,work_evidence:[select(before,["fa"]),select(after,["fa"])],readings:[{sessionId:f.a,projectionId:pair.projectionId}]}}});
  assert.equal(response.result.isError,undefined,JSON.stringify(response));
  const prepared=response.result.structuredContent;assert.ok(prepared?.projectionId,JSON.stringify(response.result).slice(0,300));
  await finish(f,prepared);
  const cli=await withSessionRoute(f.root,f.a,()=>runCommand(["project-document-status",f.root]));
  assert.equal(cli.projectId,owner.projectId);
  const bodies=vaultFiles(f.vault).filter(file=>!path.basename(file).startsWith("history-")).map(file=>fs.readFileSync(file,"utf8"));
  assert.ok(bodies.some(body=>body.includes("return false")&&body.includes("return true")&&body.includes("바이트 비교는 승인")));
  for (const body of bodies)assert.doesNotMatch(body,/undefined/);
  const detail=bodies.find(body=>body.includes("원문 선택 근거")&&body.includes("return false"));
  assert.ok(detail);assert.match(detail,/상세 읽기에서 선택한 작업 원문/);
  assert.doesNotMatch(detail,/제품 모델에서 확인한 연결/);
  assert.match(detail,/프로젝트 게시 상태/);assert.match(detail,/문서끼리 갱신 시점이 다를 수 있습니다/);
  if (process.env.LODE_PROJECT_DOCUMENT_QA_OUTPUT) {
    const output=process.env.LODE_PROJECT_DOCUMENT_QA_OUTPUT;fs.mkdirSync(output);
    const manifest=[];
    for(const file of vaultFiles(f.vault)) {
      const relative=path.relative(f.vault,file),target=path.join(output,relative),bytes=fs.readFileSync(file);
      fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes,{flag:"wx"});
      manifest.push({path:relative.replaceAll(path.sep,"/"),bytes:bytes.length,sha256:workDocumentHash(bytes)});
    }
    fs.writeFileSync(path.join(output,"manifest.json"),JSON.stringify({scope:"synthetic real vault generation; no live Notion or app GUI claim",projectId:owner.projectId,files:manifest},null,2)+"\n",{flag:"wx"});
  }
});

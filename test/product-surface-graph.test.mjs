import test from "node:test";import assert from "node:assert/strict";import fs from "node:fs";import path from "node:path";
import {surfaceFixture,populateSurface,mapBasis,entityRows,relationRows,publicSurfaceIngest,sha,batch}from"./helpers/product-surface-fixture.mjs";
import {queryProjectGraph,collectGraphExplorerInventory}from"../scripts/lib/project-graph.mjs";
import {runCommand}from"../scripts/lode.mjs";import {dispatch}from"../scripts/mcp-server.mjs";
import {buildWorldModel}from"../scripts/lib/world-model.mjs";
import {buildGraphExplorerSnapshot}from"../scripts/lib/graph-explorer.mjs";
import {loadObservationArtifacts}from"../scripts/lib/observation-store.mjs";
const tree=root=>{const rows=[];const walk=dir=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isDirectory())walk(file);else if(e.isFile())rows.push([path.relative(root,file),sha(fs.readFileSync(file))]);}};walk(root);return rows.sort();};
test("public surface batches connect actual graph CLI MCP without Product onboarding or World",async t=>{const f=surfaceFixture(t),saved=await populateSurface(f);const before=tree(f.root);const q=await runCommand(["graph-query",f.root,"--query","Write a note","--depth","4","--max-nodes","100","--max-edges","200","--details"]);const activity=q.nodes.find(n=>n.kind==="UserActivity"&&n.key==="write");assert(activity,JSON.stringify(q));assert(q.nodes.some(n=>n.kind==="ExecutionEntrypoint"));assert(q.edges.some(e=>e.type==="ELEMENT_INVOKES_ENTRYPOINT"));assert.equal(q.authority.ordinaryWorkBlocked,false);assert.equal(activity.claimBasis,"authored");assert.equal(activity.claimEvidence.state,"exact-current-source-bytes");assert(q.coverage.productSurfaces);assert(q.coverage.productSurfaces.batches.every(b=>b.state==="declared-batches-present"));assert(q.nodes.filter(n=>n.kind==="ExecutionEntrypoint").every(n=>n.executionBinding.state==="file-reference-only"));
 const result=await dispatch({method:"tools/call",params:{name:"lode_project_graph",arguments:{project_root:f.root,anchor_ids:[activity.nodeId],depth:4,max_nodes:100,max_edges:200,details:true}}});assert.equal(result.error,undefined);assert(result.result.structuredContent.nodes.some(n=>n.kind==="ExecutionEntrypoint"));assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,f.storage.directory,"context/product-model.json"))).features.length,0);assert.deepEqual(tree(f.root),before);
 const repeat=await populateSurface(f);assert.equal(repeat.entities.status,"existing");assert.deepEqual(tree(f.root),before);});
test("misaligned batch, wrong endpoint hash and open batches remain explicit coverage",async t=>{const f=surfaceFixture(t),common=mapBasis(f);const rows=entityRows(f),input=batch("entities",rows,common);input.payload.names.pop();const {ingestStructuredObservation}=await import("../scripts/lib/observation-adapter.mjs");const {profile,payload}=input;const malformed=await ingestStructuredObservation({root:f.root,binding:{adapterKey:"lode.structured-host-observation",adapterVersion:"0.1.0",sourceScopeDigest:common.mapRevision,credentialReferenceNames:[]},descriptor:profile,input:{subject:{type:"example.product-surface",key:"note-actions"},form:"snapshot",temporalScope:{observedAt:"2026-11-05T12:00:00.000Z",start:null,end:null},sourceEventKeyDigest:sha("bad"),sourceEvidenceDigest:sha("bad"),coverage:{state:"partial",basis:"bounded-source-enumeration",queryDigest:common.mapRevision,examinedCount:rows.length,sourceReportedTotal:null,omittedCount:null,cursorStartDigest:null,cursorEndDigest:null},payload}});
 const good=await publicSurfaceIngest(f,"entities",rows,{...common,batchCount:0});const r=relationRows(f,good.observation);r[0].toObservationHashes="f".repeat(64);r.push({...r[1],keys:"dangling",toKeys:"missing"});await publicSurfaceIngest(f,"relations",r,common);const q=await queryProjectGraph({root:f.root,query:"Write",depth:4,maxNodes:100,maxEdges:200,details:true});assert(q.coverage.productSurfaces.issues.some(i=>i.reasonCode==="INVALID_SURFACE_BATCH"));assert(q.coverage.productSurfaces.issues.some(i=>i.reasonCode==="SURFACE_ENDPOINT_BASIS_MISMATCH"));assert(q.coverage.productSurfaces.issues.some(i=>i.reasonCode==="SURFACE_ENDPOINT_UNAVAILABLE"));assert(q.coverage.productSurfaces.batches.some(b=>b.state==="open-batch-set"));assert.equal(q.authority.ordinaryWorkBlocked,false);});
test("source claims retain exact revisions across same-length edits and malformed UTF8",async t=>{const f=surfaceFixture(t);await populateSurface(f);let q=await queryProjectGraph({root:f.root,query:"Write a note",depth:0,details:true});const id=q.nodes.find(n=>n.kind==="UserActivity").nodeId;const file=path.join(f.root,"flows.md"),old=fs.statSync(file),bytes=fs.readFileSync(file);fs.writeFileSync(file,Buffer.from(bytes.toString().replace("Write","Alter")));fs.utimesSync(file,old.atime,old.mtime);q=await queryProjectGraph({root:f.root,anchorIds:[id],depth:0,details:true});assert.equal(q.nodes[0].claimEvidence.state,"historical-or-unavailable-source");fs.writeFileSync(file,Buffer.from([0xff,0xfe]));q=await queryProjectGraph({root:f.root,anchorIds:[id],depth:0,details:true});assert.equal(q.nodes[0].claimEvidence.state,"unavailable");fs.unlinkSync(file);q=await queryProjectGraph({root:f.root,anchorIds:[id],depth:0,details:true});assert.equal(q.nodes[0].claimEvidence.state,"unavailable");});

test("surface entrypoints use exact verified structural calls without creating Canon or shared-purpose edges",async t=>{
 const f=surfaceFixture(t);await populateSurface(f);await buildWorldModel({root:f.root});const before=tree(f.root);const all=await collectGraphExplorerInventory({root:f.root,query:"Write a note"});
 const write=all.nodes.find(n=>n.kind==="UserActivity"&&n.key==="write"),read=all.nodes.find(n=>n.kind==="UserActivity"&&n.key==="read");assert(write&&read);assert.notEqual(write.nodeId,read.nodeId);
 const save=all.nodes.find(n=>n.kind==="ExecutionEntrypoint"&&n.key==="save-entry"),reader=all.nodes.find(n=>n.kind==="ExecutionEntrypoint"&&n.key==="read-entry");assert.equal(save.executionBinding.state,"exact-symbol-in-retained-world");assert.equal(reader.executionBinding.state,"exact-symbol-in-retained-world");
 const helper=all.nodes.find(n=>n.origin?.layer==="surface-code"&&n.name==="formatText"),codeSave=all.nodes.find(n=>n.nodeId===save.executionBinding.nodeId),codeRead=all.nodes.find(n=>n.nodeId===reader.executionBinding.nodeId);assert(helper&&codeSave&&codeRead,JSON.stringify(all.coverage));assert(all.edges.some(e=>e.type==="CALLS"&&e.from===codeSave.nodeId&&e.to===helper.nodeId));assert(all.edges.some(e=>e.type==="CALLS"&&e.from===codeRead.nodeId&&e.to===helper.nodeId));assert(!all.edges.some(e=>e.from===write.nodeId&&e.to===read.nodeId));assert.equal(helper.origin.semanticGraphId,all.coverage.productSurfaces.structural.semanticGraphId);
 const html=await buildGraphExplorerSnapshot({root:f.root,query:"Write a note",history:true});assert(html.graph.nodes.some(n=>n.nodeId===write.nodeId));assert(html.graph.nodes.some(n=>n.nodeId===helper.nodeId));assert.deepEqual(tree(f.root),before);
});

test("descriptor spoofing, duplicate row keys and omitted map sources do not acquire graph meaning",async t=>{
 const f=surfaceFixture(t),common=mapBasis(f),rows=entityRows(f),{profile,payload}=batch("entities",rows,common);const {ingestStructuredObservation}=await import("../scripts/lib/observation-adapter.mjs");
 const base={root:f.root,binding:{adapterKey:"lode.structured-host-observation",adapterVersion:"0.1.0",sourceScopeDigest:common.mapRevision,credentialReferenceNames:[]},input:{subject:{type:"example.product-surface",key:"note-actions"},form:"snapshot",temporalScope:{observedAt:"2026-11-05T12:00:00.000Z",start:null,end:null},sourceEventKeyDigest:sha("spoof"),sourceEvidenceDigest:sha("spoof"),coverage:{state:"partial",basis:"bounded-source-enumeration",queryDigest:common.mapRevision,examinedCount:rows.length,sourceReportedTotal:null,omittedCount:null,cursorStartDigest:null,cursorEndDigest:null},payload}};
 await ingestStructuredObservation({...base,descriptor:{...profile,typeVersion:"2.0.0"}});
 await publicSurfaceIngest(f,"entities",[rows[0],{...rows[1],keys:rows[0].keys}],common);
 await publicSurfaceIngest(f,"entities",[{...rows[0],paths:"missing.md",sourceDigests:"a".repeat(64)}],common);
 const q=await queryProjectGraph({root:f.root,query:"Write",details:true});const reasons=q.coverage.productSurfaces.issues.map(i=>i.reasonCode);assert(reasons.includes("UNSUPPORTED_SURFACE_PROFILE"));assert(reasons.includes("INVALID_SURFACE_BATCH"));assert(reasons.includes("SURFACE_ROW_OUTSIDE_MAP_BASIS"));assert(!q.nodes.some(n=>n.kind==="UserActivity"));
});
test("same anchor query rechecks changed source and relation evidence without mtime trust",async t=>{
 const f=surfaceFixture(t);await populateSurface(f);const seed=await queryProjectGraph({root:f.root,query:"Write a note",depth:0,details:true});const anchor=seed.nodes.find(n=>n.kind==="UserActivity").nodeId;const args={root:f.root,anchorIds:[anchor],depth:4,maxNodes:100,maxEdges:200,details:true};
 const first=await queryProjectGraph(args);assert(first.edges.some(e=>e.claimEvidence?.state==="exact-current-source-bytes"));const repeated=await queryProjectGraph(args);assert(repeated.nodes.some(n=>n.claimEvidence?.state==="exact-current-source-bytes"));
 const file=path.join(f.root,"flows.md"),stat=fs.statSync(file);fs.writeFileSync(file,fs.readFileSync(file,"utf8").replace("Save button","Fake button"));fs.utimesSync(file,stat.atime,stat.mtime);const changed=await queryProjectGraph(args);
 assert(changed.nodes.filter(n=>n.claimBasis).every(n=>n.claimEvidence.state!=="exact-current-source-bytes"));assert(changed.edges.filter(e=>e.claimReference).every(e=>e.claimEvidence.state!=="exact-current-source-bytes"));
 const {inspectSurfaceClaimSources}=await import("../scripts/lib/product-surface-graph.mjs");const bounded=structuredClone(first.nodes.filter(n=>n.claimBasis));const observed=inspectSurfaceClaimSources({root:f.root,nodes:bounded,maxBytes:2});assert.equal(observed.bytesRead,0);assert(bounded.every(n=>n.claimEvidence.state==="not-inspected"));
});
test("recorded work and exact cited-versus-current diff remain connected after a source edit",async t=>{
 const f=surfaceFixture(t);await populateSurface(f);await buildWorldModel({root:f.root});const codeFile=path.join(f.root,"app.mjs"),old=fs.readFileSync(codeFile),oldDigest=sha(old);
 const {createSourceObservation,retainSourceObservation}=await import("../scripts/lib/source-observation.mjs");const bundle=createSourceObservation({version:1,kind:"source",projectId:f.projectId,query:[{path:"app.mjs",symbol:""}],sources:[{path:"app.mjs",digest:oldDigest,base64:old.toString("base64")}],profile:{},observedAt:"2026-11-05T12:00:00.000Z",response:null,envelopeHash:null},f.storage);retainSourceObservation(f.root,bundle,f.storage);
 const {recordSessionWorkEvidence}=await import("../scripts/lib/session-work-context.mjs");const work=recordSessionWorkEvidence({root:f.root,input:{summary:"Inspect the save response",judgments:[{assessment:"Keep the output clear",reason:"Users need to see whether the note was saved",alternatives:["Keep the original wording"]}],references:[{kind:"source",path:"app.mjs",digest:oldDigest}]}});
 fs.writeFileSync(codeFile,old.toString().replace("Saved note.","Saved note v2."));await buildWorldModel({root:f.root});const before=tree(f.root);const q=await queryProjectGraph({root:f.root,query:"Write a note",paths:["app.mjs"],depth:4,maxNodes:120,maxEdges:240,details:true});const section=q.contextLineage.files.find(f=>f.path==="app.mjs");assert(section);const pair=section.comparisons.find(p=>p.scope==="cited-revision-versus-observed-current-bytes"&&p.before?.digest===oldDigest);assert(pair,JSON.stringify(section));assert.equal(pair.after.digest,sha(fs.readFileSync(codeFile)));assert(q.nodes.some(n=>n.nodeId===work.evidence.evidenceId));assert.deepEqual(tree(f.root),before);
});
test("bundled activity reader follows actual directions, reverse helper impact and bounded UI rows",async t=>{
 const {explorerDom}=await import("./helpers/graph-explorer-dom-fixture.mjs");const f=surfaceFixture(t);await populateSurface(f);await buildWorldModel({root:f.root});
 const savedWork=await dispatch({method:"tools/call",params:{name:"lode_session_work_record",arguments:{project_root:f.root,evidence:{summary:"Check note saving behavior",references:[{kind:"source",path:"app.mjs",digest:sha(fs.readFileSync(path.join(f.root,"app.mjs")))}]}}}});assert.equal(savedWork.error,undefined);
 const report=await buildGraphExplorerSnapshot({root:f.root,query:"Write a note",history:true});
 const ui=explorerDom(report);await ui.settle();const write=report.graph.nodes.find(n=>n.kind==="UserActivity"&&n.key==="write"),helper=report.graph.nodes.find(n=>n.origin?.layer==="surface-code"&&n.name==="formatText");
 const choose=id=>{ui.ids.get("search").value=id;ui.event(ui.ids.get("search"),"input");const row=ui.ids.get("records").querySelectorAll("[data-record-entry]").find(e=>e.getAttribute("data-record-entry")===id);assert(row);ui.event(row);};
 choose(write.nodeId);ui.event(ui.ids.get("surface-forward"));await ui.settle();assert.match(ui.ids.get("surface-path-body").textContent,/Save note command/);assert.match(ui.ids.get("surface-path-body").textContent,/formatText/);assert(!ui.ids.get("surface-path-body").textContent.includes("Read note command"));
 choose(helper.nodeId);ui.event(ui.ids.get("surface-reverse"));await ui.settle();assert.match(ui.ids.get("surface-path-body").textContent,/Write a note/);assert.match(ui.ids.get("surface-path-body").textContent,/Read a note/);assert(ui.ids.get("surface-path-body").children.length<=21);assert.match(ui.ids.get("surface-path-basis").textContent,/Follow recorded connections/);assert.match(ui.ids.get("surface-path-body").textContent,/Notes screen/);assert.match(ui.ids.get("surface-path-body").textContent,/CLI output/);
 ui.event(ui.ids.get("surface-work"));await ui.settle();assert.match(ui.ids.get("surface-path-body").textContent,/Check note saving behavior/);
});

test("directional reader handles 12000 cyclic and parallel edges with bounded batches and cancellation",async()=>{
 const vm=await import("node:vm");const source=fs.readFileSync(new URL("../scripts/graph-explorer/product-surface-paths.js",import.meta.url),"utf8");const engine=vm.runInNewContext(source+";explorerSurfacePaths");
 const owner="surface-scale",root={nodeId:"root",kind:"ExecutionEntrypoint",name:"Root",projectId:owner,origin:{layer:"product-surface"},freshness:"snapshot-evidence"};const nodes=[root],edges=[];for(let i=0;i<12000;i++){nodes.push({nodeId:"code-"+i,kind:"SymbolRevisionReference",name:"Unit "+i,projectId:owner,origin:{layer:"surface-code"},freshness:"snapshot-evidence"});edges.push({edgeId:"e-"+i,type:i?"CALLS":"HANDLED_BY_EXACT_SOURCE",from:i?"code-"+(i-1):"root",to:"code-"+i});}edges.push({edgeId:"cycle",type:"CALLS",from:"code-11999",to:"code-1"},{edgeId:"parallel",type:"CALLS",from:"code-0",to:"code-1"});
 const graph={nodes,edges,basis:{projectId:owner}},index=engine.create({project:{projectId:owner}},graph),state=index.begin(root);let total=0,batches=0,yields=0;while(!state.complete){const page=await index.next(state,{maxWork:512,yieldWork:async()=>{yields++;}});assert(page.rows.length<=512);total+=page.rows.length;if(++batches>1000)assert.fail("Traversal did not terminate");}assert.equal(total,12002);assert.equal(state.seenNodes.size,12001);assert(yields>0);assert(state.queue.every(n=>!n.via),"No O(depth²) retained full paths");
 const cancelled=index.begin(root);let stop=false;const page=await index.next(cancelled,{cancelled:()=>stop,yieldWork:async()=>{stop=true;}});assert.equal(page.cancelled,true);assert.equal(page.complete,false);
});

test("activity export retains exact historical work comparisons without lexical overlap", async t => {
  const { explorerDom, visibleText } = await import("./helpers/graph-explorer-dom-fixture.mjs");
  const { createSourceObservation, retainSourceObservation } = await import("../scripts/lib/source-observation.mjs");
  const f = surfaceFixture(t);
  await populateSurface(f);
  const codeFile = path.join(f.root, "app.mjs"), old = fs.readFileSync(codeFile), oldDigest = sha(old);
  const bundle = createSourceObservation({ version: 1, kind: "source", projectId: f.projectId,
    query: [{ path: "app.mjs", symbol: "" }],
    sources: [{ path: "app.mjs", digest: oldDigest, base64: old.toString("base64") }],
    profile: {}, observedAt: "2026-11-05T12:00:00.000Z", response: null, envelopeHash: null }, f.storage);
  retainSourceObservation(f.root, bundle, f.storage);
  const saved = await dispatch({ method: "tools/call", params: { name: "lode_session_work_record", arguments: {
    project_root: f.root, evidence: { summary: "Unrelated wording with exact source citation",
      references: [{ kind: "source", path: "app.mjs", digest: oldDigest }] },
  } } });
  assert.equal(saved.error, undefined);
  fs.writeFileSync(codeFile, old.toString().replace("Saved note.", "Saved note v2."));
  await buildWorldModel({ root: f.root });
  const before = tree(f.root);
  const report = await buildGraphExplorerSnapshot({ root: f.root, query: "Write a note", paths: ["app.mjs"] });
  const activity = report.graph.nodes.find(node => node.kind === "UserActivity" && node.key === "write");
  assert.equal(report.graph.initialNodeId, activity.nodeId);
  const pair = report.graph.contextLineage.files.find(file => file.path === "app.mjs").comparisons
    .find(pair => pair.before?.digest === oldDigest && pair.scope === "cited-revision-versus-observed-current-bytes");
  assert(pair, "Exact citation must reach the exported comparison bundle");
  assert.equal(pair.after.digest, sha(fs.readFileSync(codeFile)));
  const work = report.graph.nodes.find(node => node.workContent?.summary === "Unrelated wording with exact source citation");
  assert.equal(work.detailCoverage, "selected-detail");
  const ui = explorerDom(report);
  await ui.settle();
  const entrypoint = report.graph.nodes.find(node => node.kind === "ExecutionEntrypoint" && node.key === "save-entry");
  assert.equal(entrypoint.claimEvidence.state, "exact-current-source-bytes");
  assert.equal(entrypoint.executionEvidence.state, "historical-or-unavailable-source");
  ui.ids.get("search").value = entrypoint.nodeId; ui.event("search", "input");
  const codeClaim = ui.ids.get("records").querySelectorAll("[data-record-entry]")
    .find(row => row.getAttribute("data-record-entry") === entrypoint.nodeId);
  ui.event(codeClaim); await ui.settle();
  assert.match(visibleText(ui.ids.get("selection-cards")), /Code: Current source not confirmed/);
  assert.match(visibleText(ui.ids.get("selection-cards")), /Symbol not confirmed/);
  ui.ids.get("search").value = work.nodeId; ui.event("search", "input");
  const entry = ui.ids.get("records").querySelectorAll("[data-record-entry]")
    .find(row => row.getAttribute("data-record-entry") === work.nodeId);
  ui.event(entry); await ui.settle();
  const button = ui.ids.get("comparison-files").children.find(row => row.textContent.includes("app.mjs"));
  assert(button);
  // File selectors are list items containing the actual comparison button.
  const findButton = node => node.tagName === "button" ? node : node.children.map(findButton).find(Boolean);
  ui.event(findButton(button)); await ui.settle();
  assert(!ui.ids.get("context-lineage-body").textContent.includes("No exact source comparison for these selected references."));
  assert.match(ui.ids.get("context-lineage-body").textContent, /Saved note v2/);
  const exactPair = ui.ids.get("context-lineage-body").querySelectorAll("[data-reading-pair]").find(item => item.getAttribute("data-comparison-before") === oldDigest);
  assert(exactPair); exactPair.open = true;
  assert.match(visibleText(ui.ids.get("context-lineage-body")), /Source changed/);
  assert.doesNotMatch(visibleText(ui.ids.get("context-lineage-body")), /declaration-bytes-changed|declaration-bytes-unchanged/);
  assert.match(ui.ids.get("context-lineage-body").textContent, /declaration-bytes-changed/);
  assert(!/changed region 0\/0/i.test(ui.ids.get("comparison-position").textContent));
  assert.deepEqual(tree(f.root), before);
});

test("source quote beyond EOF is unavailable even when the recorded excerpt is empty", async t => {
  const f = surfaceFixture(t);
  const { inspectSurfaceClaimSources } = await import("../scripts/lib/product-surface-graph.mjs");
  const nodes = [{ nodeId: "out-of-range", origin: { layer: "product-surface" }, claimReference: { path: "flows.md",
    digest: sha(fs.readFileSync(path.join(f.root, "flows.md"))), line: 999, endLine: 999 }, statement: "" }];
  inspectSurfaceClaimSources({ root: f.root, nodes });
  assert.equal(nodes[0].claimEvidence.state, "unavailable");
  assert.equal(nodes[0].claimEvidence.reasonCode, "SURFACE_SOURCE_RANGE_UNAVAILABLE");
});

test("large activity routes keep DOM bounded, reach the last page, cancel and retain narrow map history", async t => {
  const { explorerDom, visibleText } = await import("./helpers/graph-explorer-dom-fixture.mjs");
  const count = 12000, projectId = "synthetic-surface-scale";
  const root = { nodeId: "entry", kind: "ExecutionEntrypoint", name: "Generate output", projectId,
    claimBasis: "declared", claimEvidence: { state: "exact-current-source-bytes" },
    origin: { layer: "product-surface" }, views: ["work", "product"], freshness: "current-source-bytes" };
  const nodes = [root], edges = [];
  for (let i = 0; i < count; i++) {
    nodes.push({ nodeId: "output-" + i, kind: "SurfaceElement", name: "Output " + i, projectId,
      claimBasis: "unknown", origin: { layer: "product-surface" }, views: ["work"], freshness: "current-source-bytes" });
    edges.push({ edgeId: "result-" + i, type: "ENTRYPOINT_RETURNS_ELEMENT", from: root.nodeId, to: "output-" + i });
  }
  const snapshot = { kind: "GraphExplorerSnapshot", generatedAt: "2026-11-05T12:00:00.000Z", project: { projectId },
    graph: { nodes, edges, initialNodeId: root.nodeId, basis: { projectId },
      coverage: { state: "partial", productSurfaces: { entityCount: nodes.length } }, contextLineage: null },
    codeGraph: { nodes: [], edges: [], status: "unavailable" }, originals: {}, history: { status: "not-requested", entries: [] } };
  const original = JSON.stringify(snapshot), ui = explorerDom(snapshot, { narrow: true });
  await ui.settle();
  assert.equal(ui.ids.get("reading-tools").open, false);
  assert.equal(ui.ids.get("snapshot-meta").open, false);
  ui.event("surface-reverse"); await ui.settle();
  let batches = 1;
  while (!ui.ids.get("surface-more").disabled) {
    ui.event("surface-more"); await ui.settle();
    assert(ui.ids.get("surface-path-body").children.length <= 21);
    assert(++batches < 100);
  }
  assert.match(ui.ids.get("surface-path-state").textContent, /12000 links/);
  const liveElements = node => 1 + node.children.reduce((count, child) => count + liveElements(child), 0);
  assert(liveElements(ui.document.body) < 3000, "A page renders 20 rows; no all-node live DOM");
  for (let page = 1; page < 600; page++) ui.event("surface-next");
  assert.match(ui.ids.get("surface-path-body").textContent, /Output 11999/);
  const lastRow = ui.ids.get("surface-path-body").children.find(row => row.textContent.startsWith("Output 11999"));
  const disclosure = lastRow.children.find(child => child.tagName === "details");
  if (disclosure) assert.equal(disclosure.open, false);
  assert.match(visibleText(lastRow), /Uncertain/); assert.doesNotMatch(visibleText(lastRow), /Unreviewed claim|Not reviewed/);
  const onMap = lastRow.children.find(child => child.getAttribute("data-surface-map") === "output-11999");
  const selection = ui.ids.get("selection-count").textContent;
  ui.event(onMap); await ui.settle();
  assert.equal(ui.stats.focused, "output-11999");
  assert.match(ui.ids.get("selection-count").textContent, /2 selected/);
  ui.event("back"); await ui.settle();
  assert.equal(ui.ids.get("selection-count").textContent, selection);
  assert.match(ui.ids.get("surface-path-body").textContent, /Output 11999/);
  ui.event("surface-forward"); ui.event("cancel-work"); await ui.settle();
  assert.match(ui.ids.get("surface-path-state").textContent, /Cancelled/);
  assert.equal(JSON.stringify(snapshot), original);
  t.diagnostic(JSON.stringify({ scope: "Synthetic bundled DOM double, not actual GUI timing", nodes: nodes.length,
    edges: edges.length, batches, initialMs: ui.initialMs, createdElements: ui.stats.created }));
});

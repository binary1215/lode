import assert from 'node:assert/strict';import test from 'node:test';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {initializeProject,inspectProject} from '../scripts/lib/lode-core.mjs';
import {buildWorldModel,readWorldModelSnapshot} from '../scripts/lib/world-model.mjs';
import {LocalJsonWorldModelStoreAdapter} from '../scripts/lib/world-model-store.mjs';
import {LocalJsonGraphProjectionAdapter} from '../scripts/lib/graph-projection-adapter.mjs';
import {diffGraphLineage} from '../scripts/lib/graph-lineage.mjs';
import {runCommand} from '../scripts/lode.mjs';
import {dispatch} from '../scripts/mcp-server.mjs';
import {readSnapshotFile} from '../scripts/lib/snapshot-storage-codec.mjs';
import {refreshWorldModel} from '../scripts/lib/incremental-refresh.mjs';
import {buildSemanticGraph} from '../scripts/lib/semantic-graph.mjs';
import {createRepositoryScanReferenceAdapter} from '../scripts/lib/repository-scan.mjs';
import {InMemorySourceRelationEvidenceAdapter} from '../scripts/lib/source-relation-evidence.mjs';
function fixture(t){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'lode-chunk-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));initializeProject({root,pluginRoot:path.resolve(import.meta.dirname,'..'),runtimes:['codex']});const storage=inspectProject(root).storage;return{root,storage,world:new LocalJsonWorldModelStoreAdapter({projectRoot:root,storage,snapshotLayout:'domain-bundles-v1'}),graph:new LocalJsonGraphProjectionAdapter({projectRoot:root,storage,snapshotLayout:'domain-bundles-v1'})};}
test('existing domain World Graph readers connect exact scoped CLI MCP paging',async t=>{const f=fixture(t);for(let i=0;i<36;i++)fs.writeFileSync(path.join(f.root,'unit'+i+'.mjs'),Array.from({length:8},(_,j)=>'export function value'+j+'(){ return '+j+'; }').join('\n')+'\n');const first=await buildWorldModel({root:f.root,storeAdapter:f.world,graphProjectionAdapter:f.graph});assert.equal(readSnapshotFile(first.file).document.kind,'SnapshotComposition');assert.deepEqual((await readWorldModelSnapshot({root:f.root,worldModelId:first.snapshot.worldModelId})).snapshot,first.snapshot);
fs.writeFileSync(path.join(f.root,'unit0.mjs'),'export function changed(){ return 42; }\n');const second=await buildWorldModel({root:f.root,storeAdapter:f.world,graphProjectionAdapter:f.graph});const args={root:f.root,fromWorldModelId:first.snapshot.worldModelId,toWorldModelId:second.snapshot.worldModelId,scopePaths:['unit0.mjs'],limit:1};let page=await diffGraphLineage(args),merged={};const expected=await diffGraphLineage({...args,limit:500});for(let n=0;n<100;n++){for(const[k,v]of Object.entries(page.changes)){merged[k]??=[];merged[k].push(...v.items);}if(!page.page.nextCursor)break;if(n===0){fs.writeFileSync(path.join(f.root,'unit1.mjs'),'export function newer(){}\n');await buildWorldModel({root:f.root,storeAdapter:f.world,graphProjectionAdapter:f.graph});}page=await diffGraphLineage({...args,cursor:page.page.nextCursor});if(n===99)assert.fail('pagination did not terminate');}for(const[k,v]of Object.entries(expected.changes))assert.deepEqual(merged[k],v.items);assert.equal(expected.scope.verification,'full-endpoint-snapshots');assert.equal(expected.scope.globalChangeCounts,'not-computed');const one=await diffGraphLineage(args);for(const value of [null,[],7,{basis:null,ends:{}}])await assert.rejects(diffGraphLineage({...args,cursor:Buffer.from(JSON.stringify(value)).toString("base64url")}),{code:"INVALID_GRAPH_LINEAGE_CURSOR"});if(one.page.nextCursor)await assert.rejects(diffGraphLineage({...args,scopePaths:['unit1.mjs'],cursor:one.page.nextCursor}),{code:'INVALID_GRAPH_LINEAGE_CURSOR'});const cli=await runCommand(['graph-lineage-diff',f.root,'--from',args.fromWorldModelId,'--to',args.toWorldModelId,'--path','unit0.mjs','--limit','1']);assert.deepEqual(cli.changes,one.changes);const mcp=await dispatch({method:'tools/call',params:{name:'head_graph_lineage_diff',arguments:{project_root:f.root,from_world_model_id:args.fromWorldModelId,to_world_model_id:args.toWorldModelId,scope_paths:['unit0.mjs'],limit:1}}});assert.equal(mcp.error,undefined);assert.deepEqual(JSON.parse(mcp.result.content[0].text).changes,one.changes);});

test('invalid exact scopes fail before full endpoint IO without changing ordinary routing',async t=>{const f=fixture(t),args={root:f.root,fromWorldModelId:'world-model-'+('a'.repeat(24)),toWorldModelId:'world-model-'+('b'.repeat(24))};for(const path of ['a'+String.fromCharCode(92)+'b','a'+String.fromCharCode(0)+'b','../escape','C:/absolute'])await assert.rejects(diffGraphLineage({...args,scopePaths:[path]}),{code:'INVALID_GRAPH_LINEAGE_SCOPE'});await assert.rejects(diffGraphLineage({...args,scopePaths:['valid.mjs']}),{code:'WORLD_MODEL_SNAPSHOT_MISSING'});});

test('whole index and refresh preserve omitted ancestry without duplicate immutable snapshots', async t => {
  const f = fixture(t), source = path.join(f.root, 'value.mjs');
  fs.writeFileSync(source, 'export const value = 1;\n');
  const first = await buildWorldModel({ root: f.root }), bytes = fs.readFileSync(first.file);
  const again = await buildWorldModel({ root: f.root });
  assert.equal(again.status, 'unchanged'); assert.equal(again.snapshot.worldModelId, first.snapshot.worldModelId);
  assert.equal(again.sourceDiagnostics.compute.analyzedFileCount, 0);
  assert.equal(again.sourceDiagnostics.codeAnalysis.reused, true);
  const unchanged = await refreshWorldModel({ root: f.root });
  assert.equal(unchanged.status, 'unchanged'); assert(fs.existsSync(unchanged.receiptFile), 'No-op refresh still records its receipt');
  fs.writeFileSync(source, 'export const value = 2;\n');
  const changed = await refreshWorldModel({ root: f.root });
  const refreshed = (await readWorldModelSnapshot({ root: f.root, worldModelId: changed.worldModel.worldModelId })).snapshot;
  assert.deepEqual(refreshed.temporalProvenanceGraph.parentSourceSnapshotIds, [first.snapshot.temporalProvenanceGraph.sourceSnapshotId]);
  const snapshotDir = path.join(f.root, f.storage.directory, 'world-model/snapshots');
  const graphDir = path.join(f.root, f.storage.directory, 'graph-projection/snapshots');
  const ids = fs.readdirSync(snapshotDir).sort(), graphIds = fs.readdirSync(graphDir).sort();
  const afterRefresh = await buildWorldModel({ root: f.root });
  assert.equal(afterRefresh.snapshot.worldModelId, refreshed.worldModelId);
  assert.equal(afterRefresh.snapshot.temporalProvenanceGraph.graphSnapshotId, refreshed.temporalProvenanceGraph.graphSnapshotId);
  const cliAfterRefresh = await runCommand(['world-index', f.root]);
  assert.equal(cliAfterRefresh.snapshot.worldModelId, refreshed.worldModelId, 'The actual CLI preserves omission too');
  assert.deepEqual(fs.readdirSync(snapshotDir).sort(), ids); assert.deepEqual(fs.readdirSync(graphDir).sort(), graphIds);
  const cleared = await buildWorldModel({ root: f.root, parentSourceSnapshotIds: [], revisionParentIds: {} });
  assert.deepEqual(cleared.snapshot.temporalProvenanceGraph.parentSourceSnapshotIds, []);
  assert.notEqual(cleared.snapshot.worldModelId, refreshed.worldModelId, 'Explicit empty ancestry is not omission');
  const parents = [first.snapshot.temporalProvenanceGraph.sourceSnapshotId, refreshed.temporalProvenanceGraph.sourceSnapshotId].sort();
  const merged = await buildWorldModel({ root: f.root, parentSourceSnapshotIds: parents, revisionParentIds: {} });
  assert.deepEqual(merged.snapshot.temporalProvenanceGraph.parentSourceSnapshotIds, parents);
  assert.deepEqual(fs.readFileSync(first.file), bytes);
});

function fixtureCanon(f, statement) {
  const file = path.join(f.root, f.storage.directory, 'context/product-model.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, featureGroups: [], capabilities: [], features: [], requirements: [], constraints: [],
    decisions: [{ key: 'D1', statement, status: 'active' }] }));
}

test('domain-only changes reuse verified code facts while explicit adapters and current evidence validation remain active', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'stable.mjs'), 'export function stable() { return 1; }\n');
  fixtureCanon(f, 'Initial condition');
  const ast = new InMemorySourceRelationEvidenceAdapter({ analyzer: { name: 'synthetic-ast', version: '1', method: 'ast' }, relations: [] });
  const first = await buildWorldModel({ root: f.root, sourceRelationEvidenceAdapter: ast });
  fixtureCanon(f, 'Changed condition');
  const next = await buildWorldModel({ root: f.root, sourceRelationEvidenceAdapter: ast });
  assert.equal(next.sourceDiagnostics.compute.analyzedFileCount, 0); assert.equal(next.sourceDiagnostics.compute.reusedFileCount, 1);
  assert.equal(next.sourceDiagnostics.codeAnalysis.reused, true); assert.deepEqual(next.snapshot.semanticGraph, first.snapshot.semanticGraph);
  assert.notEqual(next.snapshot.productModel.productModelId, first.snapshot.productModel.productModelId);
  assert.notEqual(next.snapshot.worldModelId, first.snapshot.worldModelId);
  const explicit = createRepositoryScanReferenceAdapter(), execute = explicit.execute.bind(explicit); let calls = 0;
  explicit.execute = (...args) => { calls++; return execute(...args); };
  await buildWorldModel({ root: f.root, sourceRelationEvidenceAdapter: ast, computeAdapter: explicit });
  assert(calls > 0, 'An explicit backend is not bypassed by scan reuse');
  const corrupt = { collect(input) { const value = ast.collect(input); value.analyzer.version = 'tampered'; return value; } };
  await assert.rejects(buildWorldModel({ root: f.root, sourceRelationEvidenceAdapter: corrupt }), { code: 'SOURCE_RELATION_EVIDENCE_DIGEST_MISMATCH' });
});

test('same size and mtime changes plus new removed and renamed import targets match the full semantic oracle', async t => {
  const f = fixture(t), source = path.join(f.root, 'entry.mjs'), helper = path.join(f.root, 'helper.mjs');
  fs.writeFileSync(source, "import { helper } from './helper.mjs';\nexport const value = 1;\n");
  await buildWorldModel({ root: f.root });
  const before = fs.statSync(source);
  fs.writeFileSync(source, "import { helper } from './helper.mjs';\nexport const value = 2;\n");
  fs.utimesSync(source, before.atime, before.mtime);
  const changed = await buildWorldModel({ root: f.root });
  assert.equal(changed.sourceDiagnostics.compute.analyzedFileCount, 1); assert.equal(changed.sourceDiagnostics.codeAnalysis.reused, false);
  const oracle = async () => {
    const result = await buildWorldModel({ root: f.root });
    assert.deepEqual(result.snapshot.semanticGraph, buildSemanticGraph({ storage: f.storage, files: result.snapshot.files }));
    return result;
  };
  fs.writeFileSync(helper, 'export const helper = true;\n');
  const added = await oracle(); assert.equal(added.sourceDiagnostics.codeAnalysis.reused, false);
  assert.equal(added.sourceDiagnostics.compute.reusedFileCount, 1); assert.equal(added.sourceDiagnostics.compute.analyzedFileCount, 1);
  fs.renameSync(helper, path.join(f.root, 'renamed.mjs'));
  assert.equal((await oracle()).sourceDiagnostics.codeAnalysis.reused, false);
  fs.unlinkSync(path.join(f.root, 'renamed.mjs'));
  assert.equal((await oracle()).sourceDiagnostics.codeAnalysis.reused, false);
});

test('an unchanged-code optimization cannot turn a concurrent Canon change into no-op success', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'stable.mjs'), 'export const stable = true;\n'); fixtureCanon(f, 'Initial condition');
  const ast = new InMemorySourceRelationEvidenceAdapter({ analyzer: { name: 'synthetic-ast', version: '1', method: 'ast' }, relations: [] });
  const first = await buildWorldModel({ root: f.root, sourceRelationEvidenceAdapter: ast });
  const pointer = fs.readFileSync(first.pointerFile);
  const racing = { collect(input) { const evidence = ast.collect(input); fixtureCanon(f, 'Concurrent condition'); return evidence; } };
  await assert.rejects(buildWorldModel({ root: f.root, sourceRelationEvidenceAdapter: racing }), { code: 'WORLD_MODEL_CANON_BASIS_CONFLICT' });
  assert.deepEqual(fs.readFileSync(first.pointerFile), pointer);
});

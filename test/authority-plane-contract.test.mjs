import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  artifactAuthorityBoundary,
  assertNoAuthorityAmplification,
  assertProjectionDidNotMutateCanon,
  assertReceiptProjectedOnlyInChild,
  authorityPlaneContract,
  verifyArtifactAuthorityBoundary,
} from "../scripts/lib/authority-plane-contract.mjs";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { ActivatedArcadeDbGraphProjectionAdapter, InMemoryGraphProjectionAdapter, LocalJsonGraphProjectionAdapter, materializeGraphProjection } from "../scripts/lib/graph-projection-adapter.mjs";
import { withProjectMutation } from "../scripts/lib/project-mutation-lock.mjs";
import { buildWorldModel } from "../scripts/lib/world-model.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");

function temporaryProject() {
  const parent = process.env.HEAD_AGENT_TEST_TMP || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, "head-authority-plane-test-"));
}

test("freezes the five semantic authority planes separately from Distribution and Host", () => {
  const first = authorityPlaneContract();
  const second = authorityPlaneContract();
  assert.equal(first.contractId, second.contractId);
  assert.equal(first.contractHash, second.contractHash);
  assert.deepEqual(Object.keys(first.semanticPlanes), ["P1", "P2", "P3", "P4", "P5"]);
  assert.deepEqual(Object.keys(first.architecturalPlanes), ["Distribution", "Host"]);
  assert.equal(artifactAuthorityBoundary("ReviewDecision").planeId, "P1");
  assert.equal(artifactAuthorityBoundary("ProductCanonFeature").planeId, "P1");
  assert.equal(artifactAuthorityBoundary("FeatureCandidate").planeId, "P3");
  assert.equal(artifactAuthorityBoundary("SessionRunCheckpoint").planeId, "P2");
  assert.equal(artifactAuthorityBoundary("ResultPacket").planeId, "P3");
  assert.equal(artifactAuthorityBoundary("RunResultIntegrationRequest").planeId, "P3");
  assert.equal(artifactAuthorityBoundary("RunResultIntegrationReceipt").planeId, "P3");
  assert.equal(artifactAuthorityBoundary("BoundedWorkerDispatch").planeId, "P3");
  assert.equal(artifactAuthorityBoundary("BoundedWorkerWave").planeId, "P3");
  assert.equal(artifactAuthorityBoundary("BoundedWorkerWaveSeal").planeId, "P3");
  assert.equal(artifactAuthorityBoundary("BoundedWorkerWaveAbandonment").planeId, "P3");
  assert.equal(artifactAuthorityBoundary("ObservationTypeDescriptor").planeId, "P3");
  assert.equal(artifactAuthorityBoundary("ObservationRecord").planeId, "P3");
  assert.equal(artifactAuthorityBoundary("DerivedObservationRecord").planeId, "P3");
  assert.equal(artifactAuthorityBoundary("ObservationCollectionReceipt").planeId, "P3");
  assert.equal(artifactAuthorityBoundary("ConformanceFindingCandidate").planeId, "P3");
  assert.equal(artifactAuthorityBoundary("ConformanceDispositionReceipt").planeId, "P3");
  assert.equal(artifactAuthorityBoundary("ConformanceResolutionCandidate").planeId, "P3");
  assert.equal(artifactAuthorityBoundary("GraphSnapshot").planeId, "P4");
  assert.equal(artifactAuthorityBoundary("SessionRestoreProjection").planeId, "P4");
  assert.equal(artifactAuthorityBoundary("WorkerWaveStatusProjection").planeId, "P4");
  assert.equal(artifactAuthorityBoundary("WorkerWaveResultProjection").planeId, "P4");
  assert.equal(artifactAuthorityBoundary("ObservationStatusProjection").planeId, "P4");
  assert.equal(artifactAuthorityBoundary("ObservationSourceDiscoveryProjection").planeId, "P4");
  assert.equal(artifactAuthorityBoundary("ObservationPreparationProjection").planeId, "P4");
  assert.equal(artifactAuthorityBoundary("ConformancePreparationProjection").planeId, "P4");
  assert.equal(artifactAuthorityBoundary("ConformanceQueueProjection").planeId, "P4");
  assert.equal(artifactAuthorityBoundary("ConformanceTriggerBatchProjection").planeId, "P4");
  assert.equal(artifactAuthorityBoundary("ConformanceFindingGraphProjection").planeId, "P4");
  assert.equal(artifactAuthorityBoundary("CoordinationInbox").planeId, "P5");
  assert.equal(artifactAuthorityBoundary("ContinuationOutcome").planeId, "P5");
  assert.equal(artifactAuthorityBoundary("BoundedWorkerWaitOutcome").planeId, "P5");
  assert.equal(artifactAuthorityBoundary("BoundedWorkerWaveWaitOutcome").planeId, "P5");
  assert.equal(artifactAuthorityBoundary("ObservationSourceBinding").planeId, "P5");
  assert.equal(artifactAuthorityBoundary("ConformanceTriggerBinding").planeId, "P5");
  verifyArtifactAuthorityBoundary("GraphSnapshot", artifactAuthorityBoundary("GraphSnapshot"));
  verifyArtifactAuthorityBoundary("ResultPacket", { ...artifactAuthorityBoundary("ResultPacket"), contractVersion: "0.1.0" });
});

test("rejects upward authority amplification and projection mutation without explicit review", () => {
  assert.throws(() => assertNoAuthorityAmplification({ sourceKind: "GraphSnapshot", targetKind: "ProductCanon" }), {
    code: "AUTHORITY_AMPLIFICATION_REJECTED",
  });
  const reviewed = assertNoAuthorityAmplification({
    sourceKind: "CandidateSet",
    targetKind: "ProductCanon",
    reviewDecision: {
      kind: "ReviewDecision",
      reviewDecisionId: `review-decision-${"a".repeat(24)}`,
      promotionAuthority: true,
      authorityBoundary: artifactAuthorityBoundary("ReviewDecision"),
    },
    effect: "apply-exact-reviewed-product-model",
  });
  assert.equal(reviewed.reviewDecisionRequired, true);
  assert.throws(() => assertNoAuthorityAmplification({ sourceKind: "ResultPacket", targetKind: "SessionRunCheckpoint" }), {
    code: "RECOVERY_AUTHORITY_AMPLIFICATION_REJECTED",
  });
  assert.throws(() => assertNoAuthorityAmplification({ sourceKind: "GraphSnapshot", targetKind: "SessionRunCheckpoint" }), {
    code: "RECOVERY_AUTHORITY_AMPLIFICATION_REJECTED",
  });
  assert.throws(() => assertNoAuthorityAmplification({ sourceKind: "ProviderSessionReference", targetKind: "SessionRunCheckpoint" }), {
    code: "RECOVERY_AUTHORITY_AMPLIFICATION_REJECTED",
  });
  assert.throws(() => assertProjectionDidNotMutateCanon({ beforeBytes: Buffer.from("canon-a"), afterBytes: Buffer.from("canon-b") }), {
    code: "GRAPH_PROJECTION_AUTHORITY_AMPLIFICATION",
  });
});

test("forbids receipt self-reference and requires a later child projection", () => {
  const proof = {
    receiptId: "receipt-1",
    namedGraphSnapshotId: "graph-snapshot-parent",
    namedGraphReceiptIds: [],
    namedSourceSnapshotId: "source-snapshot-parent",
    childGraphSnapshotId: "graph-snapshot-child",
    childParentSourceSnapshotIds: ["source-snapshot-parent"],
    childGraphReceiptIds: ["receipt-1"],
  };
  assert.equal(assertReceiptProjectedOnlyInChild(proof), true);
  assert.throws(() => assertReceiptProjectedOnlyInChild({ ...proof, namedGraphReceiptIds: ["receipt-1"] }), {
    code: "GRAPH_SNAPSHOT_RECEIPT_SELF_REFERENCE",
  });
  assert.throws(() => assertReceiptProjectedOnlyInChild({ ...proof, childGraphReceiptIds: [] }), {
    code: "GRAPH_SNAPSHOT_RECEIPT_CHILD_REQUIRED",
  });
});

test("Canon basis drift refuses publication without restoring another writer bytes", async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "service.mjs"), "export const ready = true;\n");
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const layout = inspectProject(root).storage;
  const canonFile = path.join(root, layout.directory, "context", "product-model.json");
  const replacement = Buffer.from("projection attempted to replace Product Canon\n");
  const adapter = new InMemoryGraphProjectionAdapter({ adapterKind: "canon-mutating-projection-test" });
  const writeSnapshot = adapter.writeSnapshot.bind(adapter);
  adapter.writeSnapshot = (graphSnapshotId, document) => {
    fs.writeFileSync(canonFile, replacement);
    return writeSnapshot(graphSnapshotId, document);
  };
  await assert.rejects(((buildWorldModel({ root, graphProjectionAdapter: adapter }))), {
    code: "WORLD_MODEL_CANON_BASIS_CONFLICT",
  });
  assert.deepEqual(fs.readFileSync(canonFile), replacement);
  assert.equal(adapter.readPointer(), null);
  assert.equal(fs.existsSync(path.join(root, layout.directory, "world-model", "current.json")), false);
});


test("World publication rechecks Canon after async preparation and keeps primary failures", async (t) => {
  for (const scenario of ["approved-writer", "prepare-EIO", "read-EACCES", "Canon-read-interleaving", "commit-EACCES", "pointer-drift", "publish-EIO"]) {
    await t.test(scenario, async (st) => {
      const root = temporaryProject(); st.after(() => fs.rmSync(root, { recursive: true, force: true }));
      initializeProject({ root, pluginRoot, runtimes: ["codex"] });
      const storage = inspectProject(root).storage;
      const canonFile = path.join(root, storage.directory, "context", "product-model.json");
      const before = fs.readFileSync(canonFile), replacement = Buffer.concat([before, Buffer.from("\n")]);
      const graph = new InMemoryGraphProjectionAdapter({ adapterKind: "canon-publication-test" });
      const writeSnapshot = graph.writeSnapshot.bind(graph), writePointer = graph.writePointer.bind(graph);
      let prepared = false, published = 0;
      graph.writeSnapshot = (id, document) => {
        const result = writeSnapshot(id, document); prepared = true;
        if (scenario === "approved-writer") queueMicrotask(() => withProjectMutation({ root, storage, scope: "session-recovery" }, () => fs.writeFileSync(canonFile, replacement)));
        if (scenario === "prepare-EIO") { fs.writeFileSync(canonFile, replacement); throw Object.assign(new Error("prepare I/O"), { code: "EIO" }); }
        if (scenario === "pointer-drift") {
          const pointer = path.join(root, storage.directory, "world-model", "current.json");
          fs.mkdirSync(path.dirname(pointer), { recursive: true }); fs.writeFileSync(pointer, JSON.stringify({ externallyChanged: true }));
        }
        return result;
      };
      graph.writePointer = (...args) => { published++; if (scenario === "publish-EIO") throw Object.assign(new Error("publish I/O"), { code: "EIO" }); return writePointer(...args); };
      const read = fs.readFileSync; let canonReads = 0;
      if (["read-EACCES", "Canon-read-interleaving", "commit-EACCES"].includes(scenario)) fs.readFileSync = function (file, ...args) {
        if (path.resolve(String(file)) === path.resolve(canonFile)) {
          canonReads++;
          if (scenario === "read-EACCES" || scenario === "commit-EACCES" && prepared) throw Object.assign(new Error("Canon denied"), { code: "EACCES" });
          if (scenario === "Canon-read-interleaving" && canonReads === 1) { const bytes = read.call(this, file, ...args); fs.writeFileSync(canonFile, replacement); return bytes; }
        }
        return read.call(this, file, ...args);
      };
      let error; try { await buildWorldModel({ root, graphProjectionAdapter: graph }); } catch (caught) { error = caught; } finally { fs.readFileSync = read; }
      assert(error);
      assert.equal(error.code, ["approved-writer", "Canon-read-interleaving"].includes(scenario) ? "WORLD_MODEL_CANON_BASIS_CONFLICT" : scenario === "pointer-drift" ? "REFRESH_POINTER_CONFLICT" : ["read-EACCES", "commit-EACCES"].includes(scenario) ? "EACCES" : "EIO");
      assert.equal(published, scenario === "publish-EIO" ? 1 : 0);
      assert.deepEqual(fs.readFileSync(canonFile), ["approved-writer", "prepare-EIO", "Canon-read-interleaving"].includes(scenario) ? replacement : before);
      assert.equal(graph.readPointer(), null);
      if (scenario !== "pointer-drift") assert.equal(fs.existsSync(path.join(root, storage.directory, "world-model", "current.json")), false);
      if (scenario === "prepare-EIO") assert.equal(error.canonBasisDiagnostic.code, "WORLD_MODEL_CANON_BASIS_CONFLICT");
    });
  }
});


test("built-in Activated Graph remote publication stays outside Canon commit and preserves partial failure", async t => {
 for (const scenario of ["success", "unavailable-before-observation", "remote-pointer-EIO", "Canon-interleaving"]) await t.test(scenario, async st => {
  const root=temporaryProject();st.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  initializeProject({root,pluginRoot,runtimes:["codex"]});const storage=inspectProject(root).storage;
  const lock=path.join(root,storage.directory,".operations/session-recovery.lock"),canon=path.join(root,storage.directory,"context/product-model.json");
  const original=fs.readFileSync(canon),replacement=Buffer.concat([original,Buffer.from("\n")]);
  const remote=new InMemoryGraphProjectionAdapter({adapterKind:"instrumented-remote"});
  const trace=[];let writes=0;
  for(const method of ["readPointer","readSnapshot","writeSnapshot","writePointer"]){const real=remote[method].bind(remote);remote[method]=(...args)=>{
   assert.equal(fs.existsSync(lock),false,method+" ran under Canon commit lock");trace.push(method);
   if(method==="readPointer"&&scenario==="unavailable-before-observation")throw Object.assign(new Error("synthetic unavailable"),{code:"ARCADEDB_TRANSPORT_UNAVAILABLE"});
   if(method==="writeSnapshot"&&scenario==="Canon-interleaving")queueMicrotask(()=>withProjectMutation({root,storage,scope:"session-recovery"},()=>fs.writeFileSync(canon,replacement)));
   if(method==="writePointer"){writes++;if(scenario==="remote-pointer-EIO")throw Object.assign(new Error("synthetic remote I/O"),{code:"EIO"});}
   return real(...args);
  };}
  const adapter=new ActivatedArcadeDbGraphProjectionAdapter({projectRoot:root,storage,storageSelection:{projectId:storage.projectId},remoteAdapter:remote});
  let result,error;try{result=await buildWorldModel({root,graphProjectionAdapter:adapter});}catch(caught){error=caught;}
  const local=adapter.local.readPointer(),worldFile=path.join(root,storage.directory,"world-model/current.json");
  if(scenario==="Canon-interleaving"){assert.equal(error?.code,"WORLD_MODEL_CANON_BASIS_CONFLICT");assert.equal(local,null);assert.equal(fs.existsSync(worldFile),false);assert.equal(writes,0);assert.deepEqual(fs.readFileSync(canon),replacement);}
  else if(scenario==="remote-pointer-EIO"){assert.equal(error?.code,"EIO");assert.equal(error.graphPublication.remote,"failed-or-uncertain");assert.equal(error.worldPublication.world,"published");assert(local);assert(fs.existsSync(worldFile));assert.equal(remote.readPointer(),null);assert.deepEqual(fs.readFileSync(canon),original);}
  else {assert.equal(error,undefined);assert(local);assert(fs.existsSync(worldFile));assert.equal(result.graphProjection.remotePublication,scenario==="success"?"published":"unavailable-local-fallback");assert.equal(writes,scenario==="success"?1:0);}
  assert.equal(fs.existsSync(lock),false);assert(trace.length);
 });
});


test("post-remote local drift refuses direct materialize and World success without stale mirror receipts", async t => {
 for(const viaWorld of [false,true])await t.test(viaWorld?"World sibling":"direct materialize",async st=>{
  const root=temporaryProject();st.after(()=>fs.rmSync(root,{recursive:true,force:true}));initializeProject({root,pluginRoot,runtimes:["codex"]});
  const storage=inspectProject(root).storage,source=path.join(root,"service.mjs"),beforeText="export const value = 1;\n";fs.writeFileSync(source,beforeText);
  const a=(await buildWorldModel({root,persist:false})).snapshot.temporalProvenanceGraph;fs.writeFileSync(source,"export const value = 2;\n");
  const b=(await buildWorldModel({root,persist:false})).snapshot.temporalProvenanceGraph;fs.writeFileSync(source,beforeText);assert.notEqual(a.graphSnapshotId,b.graphSnapshotId);
  const canon=path.join(root,storage.directory,"context/product-model.json"),session=path.join(root,storage.directory,"sessions/current.json"),originalCanon=fs.readFileSync(canon),originalSession=fs.readFileSync(session);
  const remote=new InMemoryGraphProjectionAdapter({adapterKind:"interleaved-remote"}),real=remote.writePointer.bind(remote);let receiptStage=0;
  remote.takeCompletedIncrementalSync=()=>{receiptStage++;return null;};
  remote.writePointer=async document=>{const result=real(document);await materializeGraphProjection({projectRoot:root,storage,graph:b,adapter:new LocalJsonGraphProjectionAdapter({projectRoot:root,storage})});return result;};
  const adapter=new ActivatedArcadeDbGraphProjectionAdapter({projectRoot:root,storage,storageSelection:{projectId:storage.projectId},remoteAdapter:remote});
  let error;try{if(viaWorld)await buildWorldModel({root,graphProjectionAdapter:adapter});else await materializeGraphProjection({projectRoot:root,storage,graph:a,adapter});}catch(caught){error=caught;}
  assert.equal(error?.code,"GRAPH_PROJECTION_PUBLICATION_CONFLICT");assert.equal(error.graphPublication.local,"superseded");assert.equal(error.graphPublication.remote,"published-at-prior-basis");
  assert.equal(adapter.local.readPointer().document.graphSnapshotId,b.graphSnapshotId);assert.notEqual(remote.readPointer().document.graphSnapshotId,b.graphSnapshotId);assert.equal(receiptStage,0);
  assert.deepEqual(fs.readFileSync(canon),originalCanon);assert.deepEqual(fs.readFileSync(session),originalSession);
  if(viaWorld){assert.equal(error.worldPublication.world,"published");assert.equal(error.worldPublication.graphLocal,"published-then-superseded");const current=JSON.parse(fs.readFileSync(path.join(root,storage.directory,"world-model/current.json"),"utf8"));assert.equal(current.worldModelId,error.worldPublication.worldModelId);}
 });
});

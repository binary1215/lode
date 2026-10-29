import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { initializeProject, inspectProject } from "../scripts/lib/lode-core.mjs";
import { inspectReleaseObservations, observeReleaseState, loadReleaseObservationProjection } from "../scripts/lib/release-observation.mjs";
import { buildWorldModel, inspectWorldModel, inspectWorldDomainFreshness } from "../scripts/lib/world-model.mjs";
import { dispatch as dispatchMcp } from "../scripts/mcp-server.mjs";
import { runCommand } from "../scripts/lode.mjs";
import { buildTemporalProvenanceGraph, verifyTemporalProvenanceGraph } from "../scripts/lib/temporal-provenance.mjs";
import { ConformanceTriggerRegistry } from "../scripts/lib/conformance-trigger-adapter.mjs";
import { queryProjectGraph } from "../scripts/lib/project-graph.mjs";
import { createWholePlanSnapshot } from "../scripts/lib/execution-lineage.mjs";
import { verifyChangeSet, verifyVcsEvidence } from "../scripts/lib/change-set-projection.mjs";
import { formatForVerifiedOwner } from "../scripts/lib/project-storage-format.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testParent = process.env.LODE_AGENT_TEST_TMP || process.env.HEAD_AGENT_TEST_TMP || os.tmpdir();
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;

function reidentifyGraph(graph) {
  const payload = { ...graph }; delete payload.graphSnapshotId; delete payload.graphSnapshotHash;
  const hash = sha(JSON.stringify(canonical(payload)));
  return { ...payload, graphSnapshotId: `graph-snapshot-${hash.slice(0, 24)}`, graphSnapshotHash: hash };
}

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function fixture() {
  fs.mkdirSync(testParent, { recursive: true });
  const root = fs.mkdtempSync(path.join(testParent, "head-agent-release-observation-"));
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage, layout = formatForVerifiedOwner(storage);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "feature.mjs"), "export const releaseObservation = true;\n");
  git(root, ["init"]);
  git(root, ["config", "user.name", "HEAD Test"]);
  git(root, ["config", "user.email", "head@example.invalid"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial release observation fixture"]);
  return { root, storage, layout };
}

async function cleanupFixture(root) {
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: process.platform === "win32" ? 20 : 0, retryDelay: 100 });
}

function deployment(commit, suffix, overrides = {}) {
  return {
    environmentKey: "production",
    status: "succeeded",
    commit,
    observedAt: "2026-09-01T00:00:00.000Z",
    sourceEventKeyDigest: sha(`event:${suffix}`),
    deploymentEvidenceDigest: sha(`deployment:${suffix}`),
    approved: true,
    approvalEvidenceDigest: sha(`approval:${suffix}`),
    changeSetId: null,
    vcsEvidenceId: null,
    ...overrides,
  };
}

function identified(payload, prefix, idField, hashField) {
  const hash = sha(JSON.stringify(canonical(payload)));
  return { ...payload, [idField]: `${prefix}-${hash.slice(0, 24)}`, [hashField]: hash };
}

// Synthetic stored evidence, not a Product review or a required ordinary-work flow.
function storedPair(root, commitObservation) {
  const inspected = inspectProject(root);
  const layout = formatForVerifiedOwner(inspected.storage);
  const changePayload = { changeKind: "modified", entityKind: "File", logicalEntityId: "synthetic-file", beforeRevisionId: "before", afterRevisionId: "after" };
  const change = { ...changePayload, changeId: `change-record-${sha(JSON.stringify(canonical(changePayload))).slice(0, 24)}` };
  const changeSet = identified({ schemaVersion: 1, kind: "ChangeSet", protocol: { name: layout.protocol("head-agent-core-change-set"), version: "0.2.0" },
    projectId: inspected.project.projectId, sessionId: inspected.state.sessionId, resultPacketId: `result-packet-${"1".repeat(24)}`,
    reviewDecisionId: `review-decision-${"2".repeat(24)}`, reviewDisposition: "accept", authority: "reviewed-execution-change-lineage",
    instructionAuthority: false, promotionAuthority: false, changes: [change], parentChangeSetIds: [],
    before: { graphSnapshotId: `graph-snapshot-${"3".repeat(24)}`, sourceSnapshotId: `source-snapshot-${"4".repeat(24)}` },
    after: { graphSnapshotId: `graph-snapshot-${"5".repeat(24)}`, sourceSnapshotId: `source-snapshot-${"6".repeat(24)}` },
  }, "change-set", "changeSetId", "changeSetHash");
  const vcs = identified({ schemaVersion: 1, kind: "VcsEvidence", protocol: { name: layout.protocol("head-agent-core-vcs-evidence"), version: "0.1.0" },
    projectId: inspected.project.projectId, sessionId: inspected.state.sessionId, changeSetId: changeSet.changeSetId, changeSetHash: changeSet.changeSetHash,
    vcsKind: "git", attachmentMethod: "explicit-commit-selection", rationale: "Synthetic explicit commit evidence.",
    gitHistory: { historyId: `git-history-${"7".repeat(24)}`, historyHash: "8".repeat(64), coverage: "all-reachable-commits" },
    commitObservations: [commitObservation], authority: "optional-derived-vcs-evidence", trustBoundary: "evidence-not-instruction",
    instructionAuthority: false, promotionAuthority: false,
  }, "vcs-evidence", "vcsEvidenceId", "vcsEvidenceHash");
  verifyChangeSet(changeSet, inspected.project.projectId); verifyVcsEvidence(vcs, changeSet, inspected.project.projectId);
  for (const [directory, id, document] of [["records", changeSet.changeSetId, changeSet], ["vcs-evidence", vcs.vcsEvidenceId, vcs]]) {
    const dir = path.join(root, layout.directory, "change-sets", directory); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify(document, null, 2)}\n`);
  }
  return { changeSetId: changeSet.changeSetId, vcsEvidenceId: vcs.vcsEvidenceId };
}

function diskSnapshot(root) {
  const entries = [];
  function walk(relative) {
    const target = path.join(root, relative), stat = fs.lstatSync(target);
    entries.push({ path: relative, mode: stat.mode, mtimeMs: stat.mtimeMs, type: stat.isDirectory() ? "directory" : "file",
      ...(stat.isFile() ? { bytes: fs.readFileSync(target).toString("base64") } : {}) });
    if (stat.isDirectory()) for (const name of fs.readdirSync(target).sort()) walk(path.join(relative, name));
  }
  walk(""); return entries;
}

async function withoutWrites(root, action) {
  const before = diskSnapshot(root), originals = [];
  const within = (value) => {
    const file = value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : value;
    return typeof file === "string" && (path.resolve(file) === path.resolve(root) || path.resolve(file).startsWith(`${path.resolve(root)}${path.sep}`));
  };
  const mutators = ["writeFile", "appendFile", "mkdir", "rename", "unlink", "rm", "rmdir", "truncate", "chmod", "utimes", "copyFile", "cp", "link", "symlink", "lchown", "chown", "lutimes", "mkdtemp", "write", "writev", "ftruncate", "fchmod", "fchown", "futimes"];
  const destinations = new Set(["rename", "copyFile", "cp", "link", "symlink"]);
  function install(object, name, isOpen = false) {
    const original = object[name]; if (typeof original !== "function") return;
    originals.push([object, name, original]);
    object[name] = (...args) => {
      const flags = args[1] ?? "r";
      const writable = !isOpen || (typeof flags === "number" ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) : /[wa+]/.test(String(flags)));
      if (writable) assert.equal(within(args[0]) || destinations.has(name.replace(/Sync$/, "")) && within(args[1])
        || typeof args[0] === "number" || Boolean(args[0] && typeof args[0] === "object" && typeof args[0].fd === "number"), false, `Unexpected ${name} under read-only fixture`);
      return original.apply(object, args);
    };
  }
  for (const name of mutators) { install(fs, name); install(fs, `${name}Sync`); install(fs.promises, name); }
  for (const name of ["open", "openSync", "createWriteStream"]) install(fs, name, name !== "createWriteStream");
  install(fs.promises, "open", true); syncBuiltinESMExports();
  try { return await action(); }
  finally { for (const [object, name, original] of originals.reverse()) object[name] = original; syncBuiltinESMExports(); assert.deepEqual(diskSnapshot(root), before); }
}

test("records Git refs and an approved successful deployment as P3 release evidence without authority amplification", async (t) => {
  const { root, layout } = fixture();
  t.after(() => cleanupFixture(root));
  const commit = git(root, ["rev-parse", "HEAD"]);
  const productCanonFile = path.join(root, layout.directory, "context", "product-model.json");
  const sessionPointerFile = path.join(root, layout.directory, "sessions", "current.json");
  const canonBefore = fs.readFileSync(productCanonFile, "utf8");
  const sessionBefore = fs.readFileSync(sessionPointerFile, "utf8");

  const gitOnly = await buildWorldModel({ root, persist: true });
  assert.equal(gitOnly.snapshot.temporalProvenanceGraph.nodes.some((node) => node.kind === "DeploymentResultObservation" || node.kind === "ReleaseObservation"), false);

  const observed = await observeReleaseState({ root, input: deployment(commit, "success") });
  assert.equal(observed.status, "release_observed");
  assert.equal(observed.release.commit, commit);
  assert.equal(observed.branchStates.some((item) => item.ref.startsWith("refs/heads/")), true);
  assert.equal(observed.authority.productCanonMutated, false);
  assert.equal(fs.readFileSync(productCanonFile, "utf8"), canonBefore);
  assert.equal(fs.readFileSync(sessionPointerFile, "utf8"), sessionBefore);

  const projection = inspectReleaseObservations({ root }).projection;
  assert.equal(projection.commonObservationContract.role, "domain-specialization-with-exact-git-and-approved-deployment-lineage");
  assert.equal(projection.commonObservationContract.genericReplacement, false);
  assert.equal(projection.releases.length, 1);
  assert.equal(projection.deploymentResults.length, 1);
  const graph = (await inspectWorldModel({ root })).snapshot.temporalProvenanceGraph;
  assert.equal(graph.nodes.some((node) => node.kind === "ReleaseObservation" && node.nodeId === observed.release.releaseObservationId), true);
  assert.equal(graph.edges.some((edge) => edge.type === "EVIDENCED_BY" && edge.from === observed.release.releaseObservationId), true);
  assert.equal(graph.edges.some((edge) => edge.type === "AT_REVISION" && edge.from === observed.release.releaseObservationId), true);
  assert.equal(graph.edges.some((edge) => edge.type === "OBSERVED_ON" && edge.from === observed.release.releaseObservationId), true);
  const tamperedGraph = structuredClone(graph);
  tamperedGraph.nodes.find((node) => node.kind === "DeploymentResultObservation").status = "failed";
  assert.throws(() => verifyTemporalProvenanceGraph(reidentifyGraph(tamperedGraph)), (error) => error.code === "RELEASE_OBSERVATION_TEMPORAL_RELATION_MISSING");

  const replay = await observeReleaseState({ root, input: deployment(commit, "success") });
  assert.equal(replay.release.releaseObservationId, observed.release.releaseObservationId);
  assert.equal(inspectReleaseObservations({ root }).projection.releases.length, 1);
  assert.equal((await runCommand(["release-status", root])).projection.releases.length, 1);
});

test("fails closed for unapproved, failed, stale-ref, and divergent deployment results", async (t) => {
  const { root } = fixture();
  t.after(() => cleanupFixture(root));
  const firstCommit = git(root, ["rev-parse", "HEAD"]);
  fs.appendFileSync(path.join(root, "src", "feature.mjs"), "export const second = true;\n");
  git(root, ["add", "src/feature.mjs"]);
  git(root, ["commit", "-m", "advance product branch"]);
  const headCommit = git(root, ["rev-parse", "HEAD"]);
  await buildWorldModel({ root, persist: true });

  const stale = await observeReleaseState({ root, input: deployment(firstCommit, "stale") });
  assert.equal(stale.status, "awaiting_matching_product_ref");
  assert.equal(stale.release, null);
  const failed = await observeReleaseState({ root, input: deployment(headCommit, "failed", { status: "failed" }) });
  assert.equal(failed.status, "not_release_eligible");
  assert.equal(failed.release, null);
  const unapproved = await observeReleaseState({ root, input: deployment(headCommit, "unapproved", { approved: false, approvalEvidenceDigest: null }) });
  assert.equal(unapproved.status, "not_release_eligible");
  assert.equal(unapproved.release, null);

  const beforeDivergence = inspectReleaseObservations({ root }).projection;
  await assert.rejects(() => observeReleaseState({ root, input: deployment(headCommit, "failed", { status: "cancelled" }) }), (error) => {
    assert.equal(error.constructor, Error);
    assert.equal(error.code, "DIVERGENT_DEPLOYMENT_RESULT_REPLAY");
    assert.equal(error.message, "Deployment source event was replayed with divergent content."); return true;
  });
  const afterDivergence = inspectReleaseObservations({ root }).projection;
  assert.deepEqual(afterDivergence.deploymentResults, beforeDivergence.deploymentResults);
  assert.deepEqual(afterDivergence.releases, beforeDivergence.releases);
  assert.equal(inspectReleaseObservations({ root }).projection.releases.length, 0);
});

test("release writer retains the optional current-source readers and durable prefixes on late failure", async (t) => {
  const { root } = fixture(); t.after(() => cleanupFixture(root));
  const commit = git(root, ["rev-parse", "HEAD"]);
  const first = await observeReleaseState({ root, input: deployment(commit, "pair-seed") });
  const pair = storedPair(root, first.branchStates[0].commitObservation);
  const paired = await observeReleaseState({ root, input: deployment(commit, "pair-success", pair) });
  assert.equal(paired.status, "release_observed");
  assert.equal(paired.release.changeSetId, pair.changeSetId);
  assert.equal(paired.release.vcsEvidenceId, pair.vcsEvidenceId);
  const graph = (await inspectWorldModel({ root })).snapshot.temporalProvenanceGraph;
  assert.ok(graph.edges.some(edge => edge.type === "DEPLOYS" && edge.from === paired.release.releaseObservationId));
  const before = inspectReleaseObservations({ root }).projection;
  const missing = `change-set-${"a".repeat(24)}`;
  await assert.rejects(observeReleaseState({ root, input: deployment(commit, "missing-pair", { changeSetId: missing, vcsEvidenceId: `vcs-evidence-${"b".repeat(24)}` }) }), error => {
    assert.equal(error.constructor, Error); assert.equal(error.code, "CHANGE_SET_NOT_FOUND");
    assert.equal(error.message, `ChangeSet not found: ${missing}`); return true;
  });
  const after = inspectReleaseObservations({ root }).projection;
  assert.equal(after.deploymentResults.length, before.deploymentResults.length + 1);
  assert.deepEqual(after.releases, before.releases);
});

test("after-World failure propagates its exact error after all three release records without a final describe", async (t) => {
  const { root, layout } = fixture(); t.after(() => cleanupFixture(root));
  const input = deployment(git(root, ["rev-parse", "HEAD"]), "after-world-failure");
  const sentinel = Object.assign(new Error("Synthetic after-World release read failure."), { code: "TEST_AFTER_WORLD" });
  const original = fs.readFileSync;
  let describes = 0, reads = 0, caught;
  const adapter = { adapterVersion: "0.1.0", describe() { describes++; return { authority: "observed-evidence-only", providerNeutral: true, persistsProviderIdentity: false }; }, readResult() { reads++; return input; } };
  fs.readFileSync = (file, ...args) => {
    if (typeof file === "string" && file.startsWith(path.join(root, layout.directory, "release-observations/releases")) && file.endsWith(".json")) throw sentinel;
    return original(file, ...args);
  };
  try { await observeReleaseState({ root, adapter }); }
  catch (error) { caught = error; }
  finally { fs.readFileSync = original; }
  assert.equal(caught, sentinel); assert.equal(describes, 1); assert.equal(reads, 1);
  const projection = inspectReleaseObservations({ root }).projection;
  assert.ok(projection.branchStates.length); assert.equal(projection.deploymentResults.length, 1); assert.equal(projection.releases.length, 1);
});

test("stored releases reach World, temporal, exact Conformance and lazy Project Graph consumers without management writes", async (t) => {
  const { root, storage, layout } = fixture(); t.after(() => cleanupFixture(root));
  const observed = await observeReleaseState({ root, input: deployment(git(root, ["rev-parse", "HEAD"]), "consumers") });
  const projectId = inspectProject(root).project.projectId;
  const projection = loadReleaseObservationProjection({ projectRoot: root, projectId, storage });
  const plan = createWholePlanSnapshot({ root, objective: "Independent ordinary work", plan: ["Read the synthetic source"] }).artifact;
  await withoutWrites(root, async () => {
    const world = await buildWorldModel({ root, persist: false });
    assert.ok(world.snapshot.temporalProvenanceGraph.nodes.some(node => node.nodeId === observed.release.releaseObservationId));
    const temporal = buildTemporalProvenanceGraph({ projectId, storage, files: [], releaseObservationProjection: projection });
    assert.ok(temporal.edges.some(edge => edge.type === "AT_REVISION" && edge.from === observed.release.releaseObservationId));
    assert.ok(temporal.edges.some(edge => edge.type === "EVIDENCED_BY" && edge.from === observed.release.releaseObservationId));
    assert.ok(temporal.edges.some(edge => edge.type === "OBSERVED_ON" && edge.from === observed.release.releaseObservationId));
    const registry = new ConformanceTriggerRegistry();
    const binding = registry.register({ root, sourceKey: "release-exact", triggerKinds: ["release-observation"], mode: "opportunistic" });
    const trigger = { kind: "release-observation", artifactId: observed.release.releaseObservationId, artifactHash: observed.release.releaseObservationHash };
    assert.equal((await registry.enqueue({ root, sourceId: binding.sourceId, trigger })).status, "queued");
    assert.equal((await registry.enqueue({ root, sourceId: binding.sourceId, trigger })).status, "existing");
    const noHash = (await registry.enqueue({ root, sourceId: binding.sourceId, trigger: { kind: trigger.kind, artifactId: trigger.artifactId } }));
    assert.equal(noHash.trigger.artifactHash, trigger.artifactHash);
    for (const [overrides, code, message] of [[{ artifactId: `release-observation-${"f".repeat(24)}` }, "CONFORMANCE_TRIGGER_ARTIFACT_NOT_FOUND", "Conformance release trigger artifact is missing."],
      [{ artifactHash: "0".repeat(64) }, "CONFORMANCE_TRIGGER_ARTIFACT_DRIFT", "Conformance trigger artifact digest changed."]]) {
      (await assert.rejects(async () => (await registry.enqueue({ root, sourceId: binding.sourceId, trigger: { ...trigger, ...overrides } })), error => {
        assert.equal(error.constructor, Error); assert.equal(error.code, code); assert.equal(error.message, message); return true;
      }));
    }
    const result = await queryProjectGraph({ root, anchorIds: [trigger.artifactId], depth: 1, limit: 64 });
    assert.ok(result.coverage.layers.some(layer => layer.layer === "releases" && layer.status === "verified"));
    assert.ok(result.nodes.some(node => node.nodeId === trigger.artifactId && node.reviewState === "observed-evidence"));
    assert.ok(result.nodes.some(node => node.nodeId === observed.deploymentResult.deploymentResultObservationId));
    assert.ok(result.edges.some(edge => edge.type === "OBSERVES_DEPLOYMENT" && edge.from === trigger.artifactId && edge.to === observed.deploymentResult.deploymentResultObservationId));
    for (const field of ["instructionAuthority", "promotionAuthority", "recoveryAuthority", "executionAuthority", "ordinaryWorkBlocked"]) assert.equal(result.authority[field], false);
  });
  const originalRead = fs.readFileSync, originalList = fs.readdirSync;
  const releaseDir = path.join(root, layout.directory, "release-observations");
  const deny = (file) => typeof file === "string" && (file === releaseDir || file.startsWith(`${releaseDir}${path.sep}`));
  fs.readFileSync = (file, ...args) => { assert.equal(deny(file), false, "supplied projection must not read release originals"); return originalRead(file, ...args); };
  fs.readdirSync = (file, ...args) => { assert.equal(deny(file), false, "supplied projection must not enumerate release originals"); return originalList(file, ...args); };
  try { await buildWorldModel({ root, persist: false, releaseObservationProjectionInput: projection }); }
  finally { fs.readFileSync = originalRead; fs.readdirSync = originalList; }
  const branch = structuredClone(projection.branchStates[0]);
  delete branch.branchStateObservationId; delete branch.branchStateObservationHash; branch.referencesDigest = sha("new-observed-ref-set");
  const added = identified(branch, "branch-state-observation", "branchStateObservationId", "branchStateObservationHash");
  fs.writeFileSync(path.join(root, layout.directory, "release-observations/branch-states", `${added.branchStateObservationId}.json`), JSON.stringify(added));
  await withoutWrites(root, async () => {
    const domains = (await inspectWorldDomainFreshness({ root }));
    assert.equal(domains.freshness.domains.git.status, "stale"); assert.equal(domains.freshness.domains.code.status, "current");
  });
  const releaseFile = path.join(root, layout.directory, "release-observations/releases", `${observed.release.releaseObservationId}.json`);
  fs.writeFileSync(releaseFile, "{invalid-json");
  await withoutWrites(root, async () => {
    const result = await queryProjectGraph({ root, anchorIds: [plan.wholePlanId], depth: 1 });
    assert.ok(result.coverage.layers.some(layer => layer.layer === "releases" && layer.status === "excluded"));
    assert.ok(result.nodes.some(node => node.nodeId === plan.wholePlanId));
  });
});

test("keeps host provenance at the adapter boundary and requires explicit MCP observation confirmation", async (t) => {
  const { root } = fixture();
  t.after(() => cleanupFixture(root));
  const commit = git(root, ["rev-parse", "HEAD"]);
  const input = deployment(commit, "mcp");
  const denied = await dispatchMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "head_release_observe", arguments: {
    project_root: root, environment_key: input.environmentKey, status: input.status, commit: input.commit, observed_at: input.observedAt,
    source_event_key_digest: input.sourceEventKeyDigest, deployment_evidence_digest: input.deploymentEvidenceDigest, approved: input.approved,
    approval_evidence_digest: input.approvalEvidenceDigest, change_set_id: null, vcs_evidence_id: null, confirm_host_observation: false,
  } } });
  assert.match(denied.error.message, /host deployment observer/);
  assert.equal(inspectReleaseObservations({ root }).projection.deploymentResults.length, 0);
});

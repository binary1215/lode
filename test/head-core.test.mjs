import { readFixtureSnapshot, writeFixtureSnapshot } from "./helpers/snapshot-storage-fixture.mjs";
import assert from "node:assert/strict";
import { arcadeDbGraphReservedSchemaFor } from "../scripts/lib/graph-projection-adapter.mjs";
import { arcadeDbRequiredKeysFor } from "../scripts/lib/arcadedb-schema-contract.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { initializeProject, convergeProjectInstallation, inspectProject, inspectRuntimeAdapters } from "../scripts/lib/head-core.mjs";
import { coreEntryGuidance } from "../scripts/lib/lode-entry-guidance.mjs";
import { ARTIFACT_COMPOSITION, publicToolName } from "../scripts/lib/lode-artifact-composition.mjs";
import { formatForVerifiedOwner } from "../scripts/lib/project-storage-format.mjs";
import { createRecoveryCheckpoint } from "../scripts/lib/compaction-recovery.mjs";
import { compileContext, readContextCapsule } from "../scripts/lib/context-compiler.mjs";
import {
  buildComputeRequest,
  executeComputeOperation,
  JsReferenceComputeAdapter,
  validateComputeResponse,
  verifyComputeAdapterConformance,
} from "../scripts/lib/compute-adapter.mjs";
import {
  buildRepositoryScanInput,
  createRepositoryScanReferenceAdapter,
  REPOSITORY_SCAN_OPERATION,
  REPOSITORY_SCAN_SEMANTIC_PRODUCER,
  executeIncrementalRepositoryScan,
  scanRepositoryReference,
  validateRepositoryScanResult,
} from "../scripts/lib/repository-scan.mjs";
import {
  createWorkerHealthReferenceAdapter,
  defaultGoWorkerManifestPath,
  GoWorkerComputeAdapter,
  resolveVerifiedGoWorker,
  validateGoWorkerManifest,
  WORKER_HEALTH_INPUT,
  WORKER_HEALTH_OPERATION,
  WORKER_HEALTH_SEMANTIC_PRODUCER,
} from "../scripts/lib/go-worker-adapter.mjs";
import {
  buildFreshHeadReview,
  createExecutionContract,
  createNextWholePlanSnapshot,
  createResultPacket,
  createReviewDecision,
  createWholePlanSnapshot,
  readLineageArtifact,
} from "../scripts/lib/execution-lineage.mjs";
import { finishRun, getPendingReviewContext, reviewRun, startRun } from "../scripts/lib/run-lineage.mjs";
import { WORLD_MODEL_STATUS_PROJECTION_MAX_BYTES, buildWorldModel, buildWorldModelStatusProjection, captureWorldMarkdownChanges, inspectWorldGraphProjection, inspectWorldMarkdownProjection, inspectWorldModel, inspectWorldModelStatus, materializeWorldMarkdownProjection, queryWorldHistory, queryWorldModel, queryWorldRuntimeState, queryWorldTemporalGraph, readWorldDocumentChangeCandidateSet, readWorldModel } from "../scripts/lib/world-model.mjs";
import { buildTemporalProvenanceGraph, deduplicateTemporalEdgesInPlace, queryTemporalProvenanceGraph, verifyTemporalProvenanceGraph } from "../scripts/lib/temporal-provenance.mjs";
import { InMemorySourceRelationEvidenceAdapter, buildSourceRelationEvidenceSet, verifySourceRelationEvidenceSet } from "../scripts/lib/source-relation-evidence.mjs";
import { ActivatedArcadeDbGraphProjectionAdapter, ArcadeDbGraphProjectionAdapter, GRAPH_PROJECTION_ADAPTER_VERSION, InMemoryGraphProjectionAdapter, LocalJsonGraphProjectionAdapter, buildGraphProjectionPointer, buildPreparedTraversalRequest, createActivatedArcadeDbGraphProjectionAdapter, inspectArcadeDbGraphProjectionActivation, inspectArcadeDbGraphTopologyActivation, inspectArcadeDbIncrementalSyncReceipt, materializeGraphProjection, queryGraphProjection, verifyGraphProjectionAdapterConformance } from "../scripts/lib/graph-projection-adapter.mjs";
import { buildPreparedTraversalCostEvidence, verifyPreparedTraversalCostEvidence } from "../scripts/lib/prepared-traversal-benchmark.mjs";
import { activateArcadeDbGraphProjection, inspectArcadeDbGraphProjectionStatus } from "../scripts/lib/graphdb-projection-activation.mjs";
import { inspectOnboarding, readOnboardingCandidateSet, startOnboarding } from "../scripts/lib/onboarding.mjs";
import { DOCUMENT_PROJECTION_ADAPTER_VERSION, InMemoryMarkdownProjectionAdapter, LocalMarkdownProjectionAdapter, buildMarkdownDocumentProjection, inspectMarkdownProjection, materializeMarkdownProjection, verifyDocumentProjectionAdapterConformance } from "../scripts/lib/document-projection-adapter.mjs";
import { normalizeProductModelDocument } from "../scripts/lib/product-model.mjs";
import { WORLD_MODEL_STORE_ADAPTER_VERSION } from "../scripts/lib/world-model-store.mjs";
import { GIT_HISTORY_ADAPTER_VERSION, GitCliHistoryAdapter } from "../scripts/lib/git-history.mjs";
import { RUNTIME_STATE_ADAPTER_VERSION, RuntimeStateFileAdapter } from "../scripts/lib/runtime-state.mjs";
import {
  ProjectionOnlyAgentRuntimeAdapter,
  buildRuntimeAdapterComposition,
  buildRuntimeAdapterContractMatrix,
  verifyRuntimeAdapterComposition,
  verifyRuntimeAdapterContractMatrix,
} from "../scripts/lib/runtime-adapter.mjs";
import { WORLD_MODEL_STATUS_MCP_MAX_BYTES, dispatch as dispatchMcp, catalogTools as mcpTools } from "../scripts/mcp-server.mjs";
import { buildRepositorySourceScope } from "../scripts/lib/repository-source-scope.mjs";
import { runCommand } from "../scripts/head.mjs";
import { inspectIncrementalRefresh, inspectPostRefreshProjectionStatus, readIncrementalRefreshReceipt, readPostRefreshProjectionReceipt, refreshWorldModel, verifyIncrementalRefreshReceipt, verifyIncrementalRefreshRequest } from "../scripts/lib/incremental-refresh.mjs";
import {
  buildRefreshTriggerBatch,
  createFileSystemRefreshWatcher,
  DebouncedRefreshTriggerQueue,
  inspectRefreshTriggers,
  processRefreshTriggerBatch,
  readRefreshTriggerDelivery,
  verifyRefreshTriggerBatch,
  verifyRefreshTriggerDelivery,
} from "../scripts/lib/refresh-trigger.mjs";
import { withRefreshWriterLease } from "../scripts/lib/refresh-writer-lease.mjs";
import { inspectPostRefreshProjectionPolicy } from "../scripts/lib/post-refresh-projection.mjs";
import { initializeOrResumeProject, inspectProjectExperience } from "../scripts/lib/project-bootstrap.mjs";
import {
  applyDocumentChangeReview,
  inspectDocumentChangeReviewStatus,
  readDocumentChangeApplicationReceipt,
  readDocumentChangeReviewDecision,
  reviewDocumentChanges,
} from "../scripts/lib/document-change-review.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const pluginVersion = JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"), "utf8")).version;

const clone = (value) => JSON.parse(JSON.stringify(value));

function canonicalTestValue(value) {
  if (Array.isArray(value)) return value.map(canonicalTestValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalTestValue(value[key])]));
  return value;
}

function reidentify(document, { prefix, idKey, hashKey }) {
  const payload = clone(document);
  delete payload[idKey];
  delete payload[hashKey];
  const hash = crypto.createHash("sha256").update(JSON.stringify(canonicalTestValue(payload))).digest("hex");
  return { ...payload, [idKey]: `${prefix}-${hash.slice(0, 24)}`, [hashKey]: hash };
}

class MemoryWorldModelStoreAdapter {
  constructor() {
    this.adapterVersion = WORLD_MODEL_STORE_ADAPTER_VERSION;
    this.pointer = null;
    this.snapshots = new Map();
  }

  describe() {
    return {
      contract: "replaceable-rebuildable-materialized-view",
      adapterKind: "test-memory",
      adapterVersion: this.adapterVersion,
      authority: "derived-evidence-only",
      rebuildable: true,
      uniqueAuthority: false,
      remote: false,
      durable: false,
    };
  }

  readPointer() {
    return this.pointer ? { location: "memory://current", document: clone(this.pointer) } : null;
  }

  readSnapshot(worldModelId) {
    const document = this.snapshots.get(worldModelId);
    return document ? { location: `memory://snapshots/${worldModelId}`, document: clone(document) } : null;
  }

  writePointer(document) {
    this.pointer = clone(document);
    return { location: "memory://current", document: clone(document) };
  }

  writeSnapshot(worldModelId, document) {
    const created = !this.snapshots.has(worldModelId);
    if (created) this.snapshots.set(worldModelId, clone(document));
    return { location: `memory://snapshots/${worldModelId}`, created, document: clone(this.snapshots.get(worldModelId)) };
  }

  listSnapshotIds() {
    return [...this.snapshots.keys()].sort();
  }
}

class MemoryGitHistoryAdapter {
  constructor({ adapterKind, commits, authority = "derived-evidence-only", rebuildable = true, uniqueAuthority = false }) {
    this.adapterVersion = GIT_HISTORY_ADAPTER_VERSION;
    this.adapterKind = adapterKind;
    this.commits = clone(commits);
    this.authority = authority;
    this.rebuildable = rebuildable;
    this.uniqueAuthority = uniqueAuthority;
  }

  describe() {
    return {
      adapterKind: this.adapterKind,
      adapterVersion: this.adapterVersion,
      authority: this.authority,
      rebuildable: this.rebuildable,
      uniqueAuthority: this.uniqueAuthority,
      remote: false,
    };
  }

  readHistory() {
    return { status: "available", coverage: "all-reachable-commits", reasonCode: "", commits: clone(this.commits) };
  }
}

class MemoryRuntimeStateAdapter {
  constructor({ adapterKind, exported, authority = "derived-evidence-only", rebuildable = true, uniqueAuthority = false, readOnly = true }) {
    this.adapterVersion = RUNTIME_STATE_ADAPTER_VERSION;
    this.adapterKind = adapterKind;
    this.exported = clone(exported);
    this.authority = authority;
    this.rebuildable = rebuildable;
    this.uniqueAuthority = uniqueAuthority;
    this.readOnly = readOnly;
  }

  describe() {
    return {
      adapterKind: this.adapterKind,
      adapterVersion: this.adapterVersion,
      authority: this.authority,
      rebuildable: this.rebuildable,
      uniqueAuthority: this.uniqueAuthority,
      readOnly: this.readOnly,
      remote: false,
    };
  }

  readState() {
    return { status: "available", coverage: "point-in-time-host-export", reasonCode: "", export: clone(this.exported) };
  }
}

function temporaryProject() {
  const parent = process.env.HEAD_AGENT_TEST_TMP || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  return fs.mkdtempSync(path.join(parent, "head-agent-core-test-"));
}

async function semanticCapabilityProposal(root, relativePath, suffix = "current") {
  const world = (await inspectWorldModel({ root }));
  assert.equal(world.status, "current");
  const file = world.snapshot.files.find((item) => item.path === relativePath);
  assert.ok(file);
  const symbol = file.symbols[0];
  return {
    schemaVersion: 1,
    sourceSnapshotId: world.snapshot.temporalProvenanceGraph.sourceSnapshotId,
    candidates: [{
      productKind: "Capability",
      proposedEntity: { key: `capability:${suffix}`, name: `Capability ${suffix}`, description: "Fresh HEAD semantic proposal fixture." },
      evidence: [{
        path: relativePath,
        line: symbol?.line || 1,
        contentDigest: file.digest,
        ...(symbol ? { symbol: { name: symbol.name, kind: symbol.kind, line: symbol.line } } : {}),
      }],
      explanation: "Fresh HEAD proposes product meaning; Core verifies only current evidence and review gates.",
      confidence: 0.8,
    }],
  };
}

function directoryFileDigests(root) {
  const files = {};
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files[path.relative(root, absolute).replaceAll("\\", "/")] = crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
    }
  };
  visit(root);
  return files;
}

function hasOwnKeyDeep(value, key) {
  if (Array.isArray(value)) return value.some((item) => hasOwnKeyDeep(item, key));
  if (!value || typeof value !== "object") return false;
  return Object.prototype.hasOwnProperty.call(value, key)
    || Object.values(value).some((item) => hasOwnKeyDeep(item, key));
}

test("host-a: Claude instruction and MCP ownership are independent in every presence combination", t => {
  for (const instructionPresent of [false, true]) for (const mcpPresent of [false, true]) {
    const root = temporaryProject(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const instruction = "User-owned Korean 지침 😀\r\n", mcp = '{"mcpServers":{"user-owned":{"command":"unused"}}}\n';
    if (instructionPresent) fs.writeFileSync(path.join(root, "CLAUDE.md"), instruction);
    if (mcpPresent) fs.writeFileSync(path.join(root, ".mcp.json"), mcp);
    const result = initializeProject({ root, pluginRoot, runtimes: ["claude"] }), current = inspectProject(root);
    assert.equal(current.status, "ready"); assert.equal(result.integrations.claude.instruction.status, instructionPresent ? "manual" : "managed");
    assert.equal(result.integrations.claude.mcp.status, mcpPresent ? "manual" : "managed");
    assert.equal(fs.existsSync(path.join(root, "AGENTS.md")), false); assert.equal(fs.existsSync(path.join(root, "opencode.json")), false);
    if (instructionPresent) assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), instruction);
    else assert(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8").includes(coreEntryGuidance()));
    if (mcpPresent) assert.equal(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"), mcp);
    else assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"))).mcpServers.lode.command, "node");
    const manifest = JSON.parse(fs.readFileSync(path.join(root, current.storage.directory, "generated/manifest.json")));
    assert.equal(manifest.managed.some(item => item.path === "CLAUDE.md"), !instructionPresent);
    assert.equal(manifest.managed.some(item => item.path === ".mcp.json"), !mcpPresent);
  }
});

test("host-a: explicit resume supplies an absent legacy manual part without adopting existing user files", async t => {
  const root = temporaryProject(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "User owns this file\n"); fs.writeFileSync(path.join(root, ".mcp.json"), "{}\n");
  initializeProject({ root, pluginRoot, runtimes: ["claude"] });
  const initial = inspectProject(root), projectFile = path.join(root, initial.storage.directory, "project.json"), manifestFile = path.join(root, initial.storage.directory, "generated/manifest.json");
  const project = JSON.parse(fs.readFileSync(projectFile)); project.integrations.claude = { status: "manual", reason: "Legacy combined ownership", instructionProjection: ".lode/generated/lode-instructions.md", mcpProjection: ".lode/generated/claude.mcp.json" };
  fs.writeFileSync(projectFile, JSON.stringify(project, null, 2) + "\n");
  const manifest = JSON.parse(fs.readFileSync(manifestFile)); manifest.managed.find(row => row.path === ".lode/project.json").sha256 = crypto.createHash("sha256").update(fs.readFileSync(projectFile)).digest("hex");
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n"); fs.unlinkSync(path.join(root, ".mcp.json"));
  const sessionFile = path.join(root, initial.storage.directory, "sessions/current.json"), sessionBytes = fs.readFileSync(sessionFile);
  assert.equal(inspectProject(root).status, "ready");
  const result = await initializeOrResumeProject({ root, pluginRoot, profile: "core", instructionIntegration: "preserve" });
  assert.equal(inspectProject(root).status, "ready"); assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), "User owns this file\n");
  assert.equal(inspectProject(root).project.integrations.claude.instruction.status, "manual"); assert.equal(inspectProject(root).project.integrations.claude.mcp.status, "managed");
  assert.equal(result.installationAction, "converged"); assert.equal(result.coreGuidance, coreEntryGuidance()); assert.deepEqual(fs.readFileSync(sessionFile), sessionBytes);
  assert.equal(convergeProjectInstallation({ root, pluginRoot }).status, "current");
});

test("host-a: explicit standalone MCP entry returns shared guidance with manual instructions preserved", async t => {
  const root = temporaryProject(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "User-owned standalone context\n");
  const { dispatch } = await import("../scripts/mcp-server.mjs");
  const response = await dispatch({ jsonrpc: "2.0", id: "standalone-entry-guidance", method: "tools/call", params: {
    name: "lode_project_initialize_or_resume", arguments: { project_root: root, profile: "core", runtimes: ["claude"], instruction_integration: "preserve" } } });
  assert.equal(response.error, undefined, JSON.stringify(response)); assert.equal(response.result?.isError, undefined, JSON.stringify(response));
  assert.equal(response.result.structuredContent.coreGuidance, coreEntryGuidance());
  assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), "User-owned standalone context\n"); assert(fs.existsSync(path.join(root, ".mcp.json")));
  assert.equal(response.result.structuredContent.instructionIntegration.hostConsumption, "not-verified");
});

test("host-a: missing owned projections stay drift errors and a create race preserves the intervening user file", t => {
  const root = temporaryProject(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initializeProject({ root, pluginRoot, runtimes: ["claude"] }); fs.unlinkSync(path.join(root, ".mcp.json"));
  assert.throws(() => convergeProjectInstallation({ root, pluginRoot }), /Managed project files must be drift-free/);
  assert.equal(fs.existsSync(path.join(root, ".mcp.json")), false);
  const other = temporaryProject(); t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  fs.writeFileSync(path.join(other, "CLAUDE.md"), "User owns instructions\n"); fs.writeFileSync(path.join(other, ".mcp.json"), "{}\n");
  initializeProject({ root: other, pluginRoot, runtimes: ["claude"] }); fs.unlinkSync(path.join(other, ".mcp.json"));
  const before = directoryFileDigests(other), link = fs.linkSync;
  fs.linkSync = (source, target) => { if (target === path.join(other, ".mcp.json")) fs.writeFileSync(target, "User race winner\n"); return link(source, target); };
  try { assert.throws(() => convergeProjectInstallation({ root: other, pluginRoot }), error => error.code === "EEXIST"); }
  finally { fs.linkSync = link; }
  assert.equal(fs.readFileSync(path.join(other, ".mcp.json"), "utf8"), "User race winner\n");
  const after = directoryFileDigests(other); delete after[".mcp.json"]; assert.deepEqual(after, before);
});

test("host-a: failed manifest publication rolls back only owned new projections and prior metadata bytes", t => {
  const root = temporaryProject(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "User-owned instructions\n"); fs.writeFileSync(path.join(root, ".mcp.json"), "{}\n");
  initializeProject({ root, pluginRoot, runtimes: ["claude"] }); fs.unlinkSync(path.join(root, ".mcp.json"));
  const before = directoryFileDigests(root), target = path.join(root, ".lode/generated/manifest.json"), rename = fs.renameSync;
  let injected = false;
  fs.renameSync = (source, file) => { if (file === target && !injected) { injected = true; throw Object.assign(new Error("Synthetic publication failure"), { code: "EIO" }); } return rename(source, file); };
  try { assert.throws(() => convergeProjectInstallation({ root, pluginRoot }), error => error.code === "EIO"); }
  finally { fs.renameSync = rename; }
  assert.equal(injected, true); assert.deepEqual(directoryFileDigests(root), before); assert.equal(inspectProject(root).status, "ready");
});

test("initializes Claude, Codex, and OpenCode projections and verifies managed canon", (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = initializeProject({ root, pluginRoot, runtimes: ["claude", "codex", "opencode"] });
  const layout = inspectProject(root).storage;
  assert.equal(result.status, "ready");
  assert.ok(fs.existsSync(path.join(root, "CLAUDE.md")));
  assert.ok(fs.existsSync(path.join(root, ".mcp.json")));
  assert.ok(fs.existsSync(path.join(root, "AGENTS.md")));
  assert.ok(fs.existsSync(path.join(root, "opencode.json")));
  const generatedInstructions = fs.readFileSync(path.join(root, layout.directory, "generated", "lode-instructions.md"), "utf8");
  assert.match(generatedInstructions, /Keep the user's original task as the active objective/u);
  assert.match(generatedInstructions, /Do not initialize an unrelated repository/u);
  assert.match(generatedInstructions, /Never infer a disposition from keyword matching, silence, or a default/u);
  assert.match(generatedInstructions, /distinguish mechanical coverage from semantic sufficiency/u);
  const claudeMcp = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
  assert.deepEqual(Object.keys(claudeMcp.mcpServers), ["lode"]);
  assert.equal(claudeMcp.mcpServers.lode.command, "node");
  assert.equal(claudeMcp.mcpServers.lode.args[0], path.join(fs.realpathSync(pluginRoot), "scripts", "mcp-server.mjs"));
  assert.equal(claudeMcp.mcpServers.lode.cwd, fs.realpathSync(pluginRoot));
  const opencode = JSON.parse(fs.readFileSync(path.join(root, "opencode.json"), "utf8"));
  assert.deepEqual(Object.keys(opencode.mcp), ["lode"]);
  assert.deepEqual(opencode.mcp.lode.command, ["node", "{env:LODE_PLUGIN_ROOT}/scripts/mcp-server.mjs"]);
  const inspected = inspectProject(root);
  assert.equal(inspected.status, "ready");
  assert.equal(inspected.project.runtimes.join(","), "claude,codex,opencode");
});

test("defaults to the constitutional core without activating Product or Graph governance", async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "index.mjs"), "export const ready = true;\n");

  const absent = (await inspectProjectExperience({ root }));
  assert.equal(absent.status, "not_initialized");
  assert.equal(absent.nextAction.id, "initialize_core");
  assert.equal(absent.readiness.context.state, "blocked");
  assert.deepEqual(absent.readiness.recovery, {
    state: "unavailable-until-core-ready",
    currentCheckpoint: false,
    restorable: false,
    userDecisionRequired: false,
    headActionRequired: false,
    recoveryDependentWorkBlocked: false,
    ordinaryWorkBlocked: false,
    blockedOperations: [],
    authority: {
      advisoryOnly: true,
      writesRecoveryDirection: false,
      consumesContinuation: false,
      attachesProvider: false,
    },
  });
  assert.equal(absent.runtime.activePackageVersion, pluginVersion);
  assert.equal(absent.authority.mutatesProject, false);

  const first = await initializeOrResumeProject({ root, pluginRoot, runtimes: ["codex"] });
  const layout = inspectProject(root).storage;
  assert.equal(first.status, "core_ready");
  assert.equal(first.profile, "core");
  assert.equal(first.profileSemantics, "operation-choice-not-persisted-project-mode");
  assert.equal(first.productGovernanceActivated, false);
  assert.equal(first.onboardingAction, "not-activated");
  assert.deepEqual(first.readiness, {
    core: { state: "ready", managedProjectionDriftCount: 0 },
    product: { state: "not_activated", governanceActivated: false, onboardingStatus: "initialized" },
    context: {
      state: "curated-only",
      repositoryEvidence: "requires-explicit-product-world",
      worldModelId: null,
      entrypoint: {
        cli: `${ARTIFACT_COMPOSITION.identity}-agent context-prepare <project> --task <exact-task>`,
        mcpTool: publicToolName("head_context_prepare"),
      },
    },
    recovery: {
      state: "no-current-checkpoint",
      currentCheckpoint: false,
      restorable: false,
      userDecisionRequired: false,
      headActionRequired: false,
      recoveryDependentWorkBlocked: false,
      ordinaryWorkBlocked: false,
      blockedOperations: [],
      authority: {
        advisoryOnly: true,
        writesRecoveryDirection: false,
        consumesContinuation: false,
        attachesProvider: false,
      },
    },
  });
  assert.equal(first.nextAction.id, "work_directly");
  assert.equal(first.nextAction.entrypoint.cli, null);
  assert.equal(first.nextAction.entrypoint.mcpTool, null);
  assert.equal(Object.hasOwn(first.nextAction.entrypoint, "alternative"), false);
  assert.equal(first.capabilities.find((item) => item.id === "product-governance").availability, "available-not-activated");
  assert.equal(first.capabilities.find((item) => item.id === "context-compiler").availability, "requires-explicit-product-world");
  assert.equal(first.runtime.activePackageVersion, pluginVersion);
  assert.equal(first.runtime.loadedPackageVersion, pluginVersion);
  assert.equal(first.runtime.configuredPackageVersion, pluginVersion);
  assert.equal(first.runtime.configuredRootMatchesLoaded, true);
  assert.equal(first.runtime.state, "current");
  assert.equal(first.runtime.restartRequired, false);
  assert.equal(first.runtime.providerSessionIdentityPersisted, false);
  assert.equal(first.attention.status, "clear");
  assert.equal(first.presentation.mode, "quiet");
  assert.equal(first.authority.activatesCapabilities, false);
  assert.equal(first.authority.grantsAuthorization, false);
  assert.equal(first.onboarding.status, "initialized");
  assert.equal(first.onboarding.candidateSetId, null);
  assert.equal(first.onboarding.sourceSnapshotId, null);
  assert.equal(fs.existsSync(path.join(root, layout.directory, "project.json")), true);
  assert.equal(fs.existsSync(path.join(root, layout.directory, "sessions", "current.json")), true);

  const onboardingBeforeResume = fs.readFileSync(path.join(root, layout.directory, "onboarding", "current.json"), "utf8");
  const resumed = await initializeOrResumeProject({ root, pluginRoot, runtimes: ["codex"] });
  assert.equal(resumed.status, "core_ready");
  assert.equal(resumed.project.projectId, first.project.projectId);
  assert.equal(resumed.project.sessionId, first.project.sessionId);
  assert.equal(fs.readFileSync(path.join(root, layout.directory, "onboarding", "current.json"), "utf8"), onboardingBeforeResume);

  const projected = (await inspectProjectExperience({ root }));
  assert.equal(projected.status, "core_ready");
  assert.equal(projected.state.sessionId, first.project.sessionId);
  assert.equal(projected.capabilities.find((item) => item.id === "bounded-workers").availability, "requires-session-or-run-authorization");
  assert.equal(fs.readFileSync(path.join(root, layout.directory, "onboarding", "current.json"), "utf8"), onboardingBeforeResume);
  assert.equal((await runCommand(["status", root])).status, "core_ready");
  const mcpStatus = await dispatchMcp({
    jsonrpc: "2.0",
    id: "project-experience-status",
    method: "tools/call",
    params: { name: "head_project_status", arguments: { project_root: root } },
  });
  assert.equal(mcpStatus.result.structuredContent.status, "core_ready");
  assert.deepEqual(mcpStatus.result.structuredContent.readiness, projected.readiness);
  assert.deepEqual(mcpStatus.result.structuredContent.nextAction.entrypoint, first.nextAction.entrypoint);
  assert.equal(Buffer.byteLength(JSON.stringify(mcpStatus.result.structuredContent), "utf8") < 64 * 1024, true);
  assert.match(mcpStatus.result.content[0].text, /Lode is ready — continue the task/u);
  assert.equal(mcpStatus.result.content[0].text.trimStart().startsWith("{"), false);
  const mcpContract = await dispatchMcp({
    jsonrpc: "2.0",
    id: "active-package-contract",
    method: "tools/call",
    params: { name: "head_core_contract", arguments: {} },
  });
  assert.equal(mcpContract.result.structuredContent.runtime.activePackageVersion, pluginVersion);
  assert.equal(mcpContract.result.structuredContent.runtime.providerSessionIdentityPersisted, false);

  const humanStatus = spawnSync(process.execPath, [path.join(pluginRoot, "scripts", "head.mjs"), "status", root], { encoding: "utf8", windowsHide: true });
  assert.equal(humanStatus.status, 0, humanStatus.stderr);
  assert.match(humanStatus.stdout, /Lode is ready — continue the task/u);
  assert.doesNotMatch(humanStatus.stdout, /Project:|Product knowledge:|Context:|Recovery:/u);
  assert.equal(humanStatus.stdout.includes(`Active package: ${pluginVersion}`), false);
  assert.equal(humanStatus.stdout.trimStart().startsWith("{"), false);

  const humanDoctor = spawnSync(process.execPath, [path.join(pluginRoot, "scripts", "head.mjs"), "doctor", root], { encoding: "utf8", windowsHide: true });
  assert.equal(humanDoctor.status, 0, humanDoctor.stderr);
  assert.equal(humanDoctor.stdout.includes(`Executing CLI/library package: ${pluginVersion}`), true);
  assert.equal(humanDoctor.stdout.includes(`Configured package: ${pluginVersion}`), true);
  assert.match(humanDoctor.stdout, /Host tools\/loading: not observed/u);
  assert.doesNotMatch(humanDoctor.stdout, /Host restart: not required/u);
  assert.match(humanDoctor.stdout, /Next: Continue the user's original task\./u);
  assert.doesNotMatch(humanDoctor.stdout, /^(?:Command|MCP):/mu);

  const jsonStatus = spawnSync(process.execPath, [path.join(pluginRoot, "scripts", "head.mjs"), "status", root, "--json"], { encoding: "utf8", windowsHide: true });
  assert.equal(jsonStatus.status, 0, jsonStatus.stderr);
  assert.equal(JSON.parse(jsonStatus.stdout).runtime.activePackageVersion, pluginVersion);

  const humanHelp = spawnSync(process.execPath, [path.join(pluginRoot, "scripts", "head.mjs"), "help"], { encoding: "utf8", windowsHide: true });
  assert.equal(humanHelp.status, 0, humanHelp.stderr);
  assert.match(humanHelp.stdout, /Core-first by default/u);
  assert.match(humanHelp.stdout, /describe the task in ordinary language/u);
  assert.doesNotMatch(humanHelp.stdout, /head context-prepare/u);
  assert.match(humanHelp.stdout, /Read needed files directly/u);
  assert.equal(humanHelp.stdout.trimStart().startsWith("{"), false);

  const jsonHelp = spawnSync(process.execPath, [path.join(pluginRoot, "scripts", "head.mjs"), "help", "--json"], { encoding: "utf8", windowsHide: true });
  assert.equal(jsonHelp.status, 0, jsonHelp.stderr);
  assert.equal(JSON.parse(jsonHelp.stdout).surface, "light-default");
  assert.equal(JSON.parse(jsonHelp.stdout).contextPreparationRequired, false);
  assert.equal((await runCommand(["help-all"])).commands.some((command) => command.includes("context-prepare")), true);

  const humanFailure = spawnSync(process.execPath, [path.join(pluginRoot, "scripts", "head.mjs"), "not-a-command", root], { encoding: "utf8", windowsHide: true });
  assert.notEqual(humanFailure.status, 0);
  assert.match(humanFailure.stdout, /Lode could not complete that step/u);
  assert.equal(humanFailure.stdout.trimStart().startsWith("{"), false);

  const jsonFailure = spawnSync(process.execPath, [path.join(pluginRoot, "scripts", "head.mjs"), "not-a-command", root, "--json"], { encoding: "utf8", windowsHide: true });
  assert.notEqual(jsonFailure.status, 0);
  assert.equal(JSON.parse(jsonFailure.stdout).code, "HEAD_CLI_ERROR");
});

test("reports loaded versus configured package state without blocking ordinary work", async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await initializeOrResumeProject({ root, pluginRoot, runtimes: ["codex"] });
  const layout = inspectProject(root).storage;
  const manifestFile = path.join(root, layout.directory, "generated", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const generatedInstructionsFile = path.join(root, layout.directory, "generated", "lode-instructions.md");
  const currentInstructions = fs.readFileSync(generatedInstructionsFile, "utf8");
  const oldInstructions = "# Old managed instructions\n";
  fs.writeFileSync(generatedInstructionsFile, oldInstructions);
  const oldInstructionDigest = crypto.createHash("sha256").update(oldInstructions).digest("hex");
  const oldManaged = manifest.managed.map((item) => item.path === `${layout.directory}/generated/lode-instructions.md`
    ? { ...item, sha256: oldInstructionDigest }
    : item);
  fs.writeFileSync(manifestFile, `${JSON.stringify({ ...manifest, packageVersion: "0.0.0-fixture", managed: oldManaged }, null, 2)}\n`);
  assert.equal(inspectProject(root).status, "ready");

  const outdated = (await inspectProjectExperience({ root }));
  assert.equal(outdated.runtime.loadedPackageVersion, pluginVersion);
  assert.equal(outdated.runtime.configuredPackageVersion, "0.0.0-fixture");
  assert.equal(outdated.runtime.state, "project-integration-outdated");
  assert.equal(outdated.runtime.restartRequired, true);
  assert.deepEqual(outdated.runtime.reloadSequence, ["converge-project-integration", "restart-host"]);
  assert.equal(outdated.attention.items.some((item) => item.id === "plugin-integration-update"), true);
  assert.equal(outdated.attention.ordinaryWorkBlocked, false);

  const converged = await initializeOrResumeProject({ root, pluginRoot, runtimes: ["codex"] });
  assert.equal(converged.installationAction, "converged");
  assert.equal(converged.runtime.state, "current");
  assert.equal(converged.runtime.restartRequired, false);
  assert.equal(fs.readFileSync(generatedInstructionsFile, "utf8"), currentInstructions);
});

test("requires an explicit product profile before applying onboarding input", async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(
    async () => (await initializeOrResumeProject({ root, pluginRoot, onboarding: { mode: "existing" } })),
    { code: "PROJECT_BOOTSTRAP_PROFILE_REQUIRED" },
  );
  assert.equal(fs.existsSync(path.join(root, ".head")), false);
  assert.equal(fs.existsSync(path.join(root, ".lode")), false);
});

test("rejects invalid source scope before project initialization mutates the target", async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "index.mjs"), "export const ready = true;\n");

  await assert.rejects(
    async () => (await initializeOrResumeProject({
      root,
      pluginRoot,
      runtimes: ["codex"],
      profile: "product",
      onboarding: {
        mode: "existing",
        sourceScope: { includeRoots: ["."], excludeRoots: [] },
      },
    })),
    { code: "INVALID_REPOSITORY_SOURCE_SCOPE_PATH" },
  );
  assert.equal(fs.existsSync(path.join(root, ".head")), false);
  assert.equal(fs.existsSync(path.join(root, ".lode")), false);
});

test("resume requires a fresh semantic reproposal for stale non-authoritative onboarding candidates", async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "routing.py"), "def route_request():\n    return True\n");
  const discovery = await initializeOrResumeProject({ root, pluginRoot, runtimes: ["codex"], profile: "product", onboarding: { mode: "existing" } });
  assert.equal(discovery.status, "product_evidence_required");
  const invalidProposal = (await semanticCapabilityProposal(root, "src/routing.py", "invalid"));
  invalidProposal.candidates[0].confidence = Number.NaN;
  await assert.rejects(
    async () => (await initializeOrResumeProject({
      root,
      pluginRoot,
      runtimes: ["codex"],
      profile: "product",
      onboarding: { mode: "existing", semanticProposal: invalidProposal },
    })),
    { code: "INVALID_ONBOARDING_CONFIDENCE" },
  );
  const coercedProposal = (await semanticCapabilityProposal(root, "src/routing.py", "coerced"));
  coercedProposal.candidates[0].confidence = "0.8";
  await assert.rejects(
    async () => (await initializeOrResumeProject({
      root,
      pluginRoot,
      runtimes: ["codex"],
      profile: "product",
      onboarding: { mode: "existing", semanticProposal: coercedProposal },
    })),
    { code: "INVALID_ONBOARDING_CONFIDENCE" },
  );
  const first = await initializeOrResumeProject({
    root,
    pluginRoot,
    runtimes: ["codex"],
    profile: "product",
    onboarding: { mode: "existing", semanticProposal: (await semanticCapabilityProposal(root, "src/routing.py", "routing")) },
  });
  assert.equal(first.status, "product_review_required");
  assert.equal(first.nextAction.id, "review_product_candidates");
  assert.equal(first.onboarding.status, "awaiting_review");
  assert.equal(first.attention.userDecisionRequired, false);
  assert.equal(first.attention.status, "notice");
  assert.equal(first.attention.counts.availableUserDecision, 1);
  assert.equal(first.presentation.mode, "notice");
  assert.equal(first.attention.ordinaryWorkBlocked, false);
  assert.deepEqual(first.attention.blockedOperations, ["product-canon-promotion"]);
  const firstSetId = first.onboarding.candidateSetId;
  const firstSourceSnapshotId = first.onboarding.sourceSnapshotId;
  fs.writeFileSync(path.join(root, "src", "policy.py"), "def apply_policy():\n    return True\n");

  const blocked = await initializeOrResumeProject({ root, pluginRoot, runtimes: ["codex"], profile: "product" });
  assert.equal(blocked.project.projectId, first.project.projectId);
  assert.equal(blocked.project.sessionId, first.project.sessionId);
  assert.equal(blocked.onboardingAction, "fresh-head-semantic-reproposal-required");
  assert.equal(blocked.inputDisposition, "semantic-proposal-required");
  assert.equal(blocked.onboarding.candidateSetId, firstSetId);
  const resumed = await initializeOrResumeProject({
    root,
    pluginRoot,
    runtimes: ["codex"],
    profile: "product",
    onboarding: { semanticProposal: (await semanticCapabilityProposal(root, "src/policy.py", "policy")) },
  });
  assert.equal(resumed.onboardingAction, "refreshed-stale-candidates");
  assert.equal(resumed.previousCandidateSetId, firstSetId);
  assert.notEqual(resumed.onboarding.candidateSetId, firstSetId);
  assert.notEqual(resumed.onboarding.sourceSnapshotId, firstSourceSnapshotId);
  const successor = readOnboardingCandidateSet({ root, candidateSetId: resumed.onboarding.candidateSetId }).candidateSet;
  assert.deepEqual(successor.parentCandidateSetIds, [firstSetId]);
  assert.equal((await inspectOnboarding({ root })).state.stateRevision, first.onboarding.stateRevision + 1);

  fs.rmSync(path.join(root, "src", "policy.py"));
  const returnBlocked = await initializeOrResumeProject({ root, pluginRoot, runtimes: ["codex"], profile: "product" });
  assert.equal(returnBlocked.onboardingAction, "fresh-head-semantic-reproposal-required");
  const returnedToFirstSource = await initializeOrResumeProject({
    root,
    pluginRoot,
    runtimes: ["codex"],
    profile: "product",
    onboarding: { semanticProposal: (await semanticCapabilityProposal(root, "src/routing.py", "routing-returned")) },
  });
  assert.equal(returnedToFirstSource.onboardingAction, "refreshed-stale-candidates");
  assert.equal(returnedToFirstSource.previousCandidateSetId, successor.candidateSetId);
  const returnedWorld = (await readWorldModel({ root })).snapshot;
  const candidateNodeCount = returnedWorld.temporalProvenanceGraph.nodes.filter((node) => node.kind === "OnboardingProductCandidate").length;
  assert.equal(returnedWorld.temporalProvenanceGraph.summary.onboardingCandidateCount, candidateNodeCount);
});

test("defines deterministic provider-neutral runtime contracts while every control operation stays disabled", async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initializeProject({ root, pluginRoot, runtimes: ["opencode", "claude", "codex"] });
  const first = await inspectRuntimeAdapters(root);
  const repeated = await inspectRuntimeAdapters(root);
  assert.deepEqual(first, repeated);
  assert.ok([
    "bounded-non-session-protocol-and-project-binding-verified",
    "bounded-non-session-protocol-and-project-binding-partial",
  ].includes(first.status));
  assert.equal(first.composition.activationBoundary.runtimeControlEnabled, false);
  assert.equal(first.composition.activationBoundary.machineInterfacesVerified, false);
  assert.deepEqual(first.composition.selectedRuntimes, ["claude", "codex", "opencode"]);
  verifyRuntimeAdapterComposition(first.composition);
  verifyRuntimeAdapterContractMatrix(first.contractMatrix);
  assert.deepEqual(buildRuntimeAdapterContractMatrix(), first.contractMatrix);
  assert.deepEqual(
    buildRuntimeAdapterComposition({ platform: process.platform, runtimes: ["opencode", "claude", "codex"] }),
    first.composition,
  );
  assert.equal(first.machineInterfaces.status, "read-only-machine-discovery");
  assert.equal(first.machineInterfaces.composition.activationBoundary.machineInterfaceDiscoveryValidated, true);
  assert.equal(first.machineInterfaces.composition.activationBoundary.actualPlatformExecutionValidated, false);
  assert.equal(first.machineInterfaces.composition.activationBoundary.runtimeControlEnabled, false);
  assert.equal(first.machineInterfaces.composition.discoverySummary.rawPathsExposed, false);
  assert.equal(first.versionEvidence.activationBoundary.actualRuntimeControlValidated, false);
  assert.equal(first.versionEvidence.activationBoundary.runtimeControlEnabled, false);
  assert.equal(first.versionEvidence.activationBoundary.providerSessionCreated, false);
  assert.equal(first.versionEvidence.summary.rawPathsExposed, false);
  assert.equal(first.versionEvidence.summary.rawOutputExposed, false);
  assert.equal(first.protocolEvidence.activationBoundary.actualProviderSessionControlValidated, false);
  assert.equal(first.protocolEvidence.activationBoundary.runtimeControlEnabled, false);
  assert.equal(first.protocolEvidence.activationBoundary.providerSessionCreated, false);
  assert.equal(first.protocolEvidence.summary.rawPathsExposed, false);
  assert.equal(first.protocolEvidence.summary.rawOutputExposed, false);
  assert.equal(first.protocolEvidence.summary.rawCommandsExposed, false);
  assert.equal(first.projectBinding.bindingBoundary.lodeProjectIdentityCanonical, true);
  assert.equal(first.projectBinding.bindingBoundary.lodeSessionIdentityCanonical, true);
  assert.equal(first.projectBinding.bindingBoundary.providerSessionIdentityCanonical, false);
  assert.equal(first.projectBinding.bindingBoundary.actualProviderSessionBindingValidated, false);
  assert.equal(first.projectBinding.bindingBoundary.runtimeControlEnabled, false);
  const codex = new ProjectionOnlyAgentRuntimeAdapter({ runtime: "codex" });
  for (const operation of ["start", "resume", "stream", "interrupt", "close"]) {
    assert.throws(() => codex[operation](), { code: "RUNTIME_ADAPTER_CONTROL_NOT_ENABLED" });
  }
  assert.equal(hasOwnKeyDeep(first, "providerSessionId"), false);
  assert.equal(hasOwnKeyDeep(first, "executablePath"), false);
  assert.equal(hasOwnKeyDeep(first, "stdout"), false);
  assert.equal(hasOwnKeyDeep(first, "stderr"), false);
  assert.equal(hasOwnKeyDeep(first, "projectRoot"), false);
  assert.deepEqual(await runCommand(["runtime-adapters", root]), first);
  assert.ok(mcpTools.some((tool) => tool.name === "lode_runtime_adapters"));
  const mcp = await dispatchMcp({
    jsonrpc: "2.0",
    id: 91,
    method: "tools/call",
    params: { name: "head_runtime_adapters", arguments: { project_root: root } },
  });
  assert.deepEqual(mcp.result.structuredContent, first);
});

test("preserves existing host files and emits manual projections", (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "AGENTS.md"), "project owned\n");
  const result = initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const layout = inspectProject(root).storage;
  assert.equal(result.status, "ready_with_manual_integration");
  assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), "project owned\n");
  assert.ok(fs.existsSync(path.join(root, layout.directory, "generated", "lode-instructions.md")));
});

test("preserves existing Claude host files and emits generated instruction and MCP projections", (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "project owned\n");
  fs.writeFileSync(path.join(root, ".mcp.json"), "{\"mcpServers\":{}}\n");
  const result = initializeProject({ root, pluginRoot, runtimes: ["claude"] });
  const layout = inspectProject(root).storage;
  assert.equal(result.status, "ready_with_manual_integration");
  assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), "project owned\n");
  assert.equal(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"), "{\"mcpServers\":{}}\n");
  assert.ok(fs.existsSync(path.join(root, layout.directory, "generated", "lode-instructions.md")));
  assert.ok(fs.existsSync(path.join(root, layout.directory, "generated", "claude.mcp.json")));
});

test("binds a Run to an Execution Contract, Result Packet, and ReviewDecision", async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const layout = inspectProject(root).storage;
  assert.throws(() => startRun({ root }), { code: "EXECUTION_CONTRACT_REQUIRED" });
  const compiled = (await compileContext({ root, task: "Produce a verified plugin", budget: 32_768, persist: true }));
  const plan = createWholePlanSnapshot({
    root,
    objective: "Produce a verified plugin without losing whole-plan authority",
    plan: [{ id: "implement", outcome: "Bounded implementation" }, { id: "verify", outcome: "Evidence-backed verification" }],
    invariants: ["The user owns material decisions"],
  });
  const contract = createExecutionContract({
    root,
    wholePlanId: plan.artifact.wholePlanId,
    capsuleId: compiled.capsule.capsuleId,
    scope: "Produce one verified plugin result",
    acceptanceCriteria: ["Tests pass", "Result includes direct evidence"],
    forbiddenActions: ["Deploy without user authority"],
  });
  assert.equal(contract.artifact.contextAcceptance.authority, "Lode");
  assert.equal(Object.hasOwn(contract.artifact.contextAcceptance, "evidenceNeedSetDigest"), false);
  assert.equal(Object.hasOwn(contract.artifact.contextAcceptance, "coverageProofDigest"), false);
  assert.equal(contract.artifact.contextAcceptance.semanticJudgmentSource, "Lode-not-context-compiler");
  const started = startRun({ root, executionContractId: contract.artifact.executionContractId });
  assert.match(started.run.runId, /^run-/);
  assert.equal(started.run.executionContractId, contract.artifact.executionContractId);
  const checkpoint = createRecoveryCheckpoint({
    root,
    purpose: "Core implemented",
    approvedDecisions: [],
    currentPosition: "Core implemented",
    nextExpectedResult: "Verify",
  });
  assert.equal(checkpoint.checkpoint.runPointer.runId, started.run.runId);
  assert.equal(checkpoint.checkpoint.runPointer.executionContractId, contract.artifact.executionContractId);
  assert.throws(
    () => finishRun({ root, outcome: "Unproven result", evidence: [], verification: [] }),
    { code: "INVALID_LINEAGE_INPUT" },
  );
  assert.equal(inspectProject(root).state.activeRunId, started.run.runId);
  const knowledgeFile = path.join(root, layout.directory, "context", "knowledge.json");
  const knowledgeBefore = fs.readFileSync(knowledgeFile, "utf8");
  const finished = finishRun({
    root,
    outcome: "Plugin verified",
    evidence: [{ uri: "test/head-core.test.mjs", digest: "run-test", summary: "Run lineage lifecycle coverage" }],
    planDelta: "No direction change",
    impactRadius: ["Run state", "Execution Lineage"],
    verification: [{ check: "test suite", status: "passed" }],
    unknowns: [],
    knowledgeProposals: [{ kind: "Claim", statement: "Run review gates preserve whole-plan control.", evidenceRefs: ["run-test"] }],
  });
  assert.equal(finished.run.runId, started.run.runId);
  assert.equal(finished.run.status, "awaiting_review");
  assert.equal(inspectProject(root).state.mode, "review");
  assert.throws(
    () => startRun({ root, executionContractId: contract.artifact.executionContractId }),
    { code: "RUN_REVIEW_REQUIRED" },
  );
  const reviewContext = getPendingReviewContext({ root });
  assert.equal(reviewContext.review.excludedContext.includes("executor-transcript"), true);
  assert.equal(reviewContext.review.contextReference.capsuleId, compiled.capsule.capsuleId);
  assert.equal(reviewContext.review.resultPacket.knowledgeProposals[0].instructionAuthority, false);
  assert.throws(
    () => reviewRun({ root, reviewContextId: "fresh-head-review-000000000000000000000000", disposition: "accept", rationale: "stale" }),
    { code: "STALE_FRESH_HEAD_REVIEW" },
  );
  const reviewed = reviewRun({
    root,
    reviewContextId: reviewContext.review.reviewContextId,
    disposition: "accept",
    rationale: "The Result Packet satisfies both acceptance criteria.",
    nextActions: ["Return to Session mode"],
    knowledgeProposalRecommendations: [{
      proposalId: finished.resultPacket.knowledgeProposals[0].proposalId,
      recommendation: "recommend-promotion",
      rationale: "The claim is directly supported by the verified lifecycle test.",
    }],
  });
  assert.equal(reviewed.run.reviewDisposition, "accept");
  assert.equal(reviewed.reviewDecision.knowledgeProposalRecommendations[0].authorityEffect, "none-until-separate-authorized-promotion");
  assert.equal(fs.readFileSync(knowledgeFile, "utf8"), knowledgeBefore);
  const inspected = inspectProject(root);
  assert.equal(inspected.state.mode, "session");
  assert.equal(inspected.state.activeRunId, null);
  assert.equal(inspected.state.pendingReview, null);
  assert.equal(inspected.state.lastReviewDecisionId, reviewed.reviewDecision.reviewDecisionId);
});

test("requires a review-linked next WholePlanSnapshot after revise", async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const firstCapsule = (await compileContext({ root, task: "Execute the first plan generation", budget: 32_768, persist: true }));
  const firstPlan = createWholePlanSnapshot({
    root,
    objective: "Preserve the objective while refining the execution plan",
    plan: [{ id: "first", outcome: "Discover the required revision" }],
    invariants: ["The objective is inherited across plan generations"],
  });
  const firstContract = createExecutionContract({
    root,
    wholePlanId: firstPlan.artifact.wholePlanId,
    capsuleId: firstCapsule.capsule.capsuleId,
    scope: "Produce the first bounded result",
    acceptanceCriteria: ["Return evidence"],
  });
  startRun({ root, executionContractId: firstContract.artifact.executionContractId });
  finishRun({
    root,
    outcome: "A plan revision is needed",
    evidence: [{ uri: "test/head-core.test.mjs", digest: "revision", summary: "Revision lifecycle coverage" }],
    verification: [{ check: "review precondition", status: "passed" }],
  });
  const reviewContext = getPendingReviewContext({ root });
  const reviewed = reviewRun({
    root,
    reviewContextId: reviewContext.review.reviewContextId,
    disposition: "revise",
    rationale: "The whole objective is valid but the plan needs another generation.",
    nextActions: ["Create the next WholePlanSnapshot"],
  });
  assert.equal(reviewed.state.requiredPlanAction.kind, "next-whole-plan");
  assert.throws(
    () => startRun({ root, executionContractId: firstContract.artifact.executionContractId }),
    { code: "NEXT_WHOLE_PLAN_REQUIRED" },
  );

  const nextPlan = createNextWholePlanSnapshot({
    root,
    reviewDecisionId: reviewed.reviewDecision.reviewDecisionId,
    plan: [{ id: "revised", outcome: "Execute the evidence-driven revision" }],
  });
  assert.equal(nextPlan.artifact.generation, 1);
  assert.equal(nextPlan.artifact.objective, firstPlan.artifact.objective);
  assert.deepEqual(nextPlan.artifact.lineage.map((link) => link.relation), ["refines", "responds-to"]);
  const nextCapsule = (await compileContext({ root, task: "Execute the revised plan generation", budget: 32_768, persist: true }));
  const nextContract = createExecutionContract({
    root,
    wholePlanId: nextPlan.artifact.wholePlanId,
    capsuleId: nextCapsule.capsule.capsuleId,
    scope: "Produce the revised bounded result",
    acceptanceCriteria: ["Follow the revised plan generation"],
  });
  const nextRun = startRun({ root, executionContractId: nextContract.artifact.executionContractId });
  assert.equal(nextRun.run.wholePlanId, nextPlan.artifact.wholePlanId);
  assert.equal(nextRun.state.requiredPlanAction, null);
});

test("blocks another Run when review requires user-owned direction", async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initializeProject({ root, pluginRoot, runtimes: ["opencode"] });
  const capsule = (await compileContext({ root, task: "Reach a material direction boundary", budget: 32_768, persist: true }));
  const plan = createWholePlanSnapshot({ root, objective: "Keep material direction with the user", plan: "Stop at escalation" });
  const contract = createExecutionContract({
    root,
    wholePlanId: plan.artifact.wholePlanId,
    capsuleId: capsule.capsule.capsuleId,
    scope: "Report the material decision boundary",
    acceptanceCriteria: ["Escalate instead of choosing for the user"],
  });
  startRun({ root, executionContractId: contract.artifact.executionContractId });
  finishRun({
    root,
    outcome: "A material user choice is required",
    evidence: [{ uri: "test/head-core.test.mjs", digest: "escalation", summary: "User authority boundary coverage" }],
    verification: [{ check: "authority boundary", status: "passed" }],
  });
  const context = getPendingReviewContext({ root });
  const reviewed = reviewRun({
    root,
    reviewContextId: context.review.reviewContextId,
    disposition: "escalate",
    rationale: "The missing choice changes material product direction.",
    nextActions: ["Request explicit user direction"],
  });
  assert.equal(reviewed.state.requiredPlanAction.kind, "user-direction");
  assert.throws(
    () => startRun({ root, executionContractId: contract.artifact.executionContractId }),
    { code: "USER_DIRECTION_REQUIRED" },
  );
});

test("detects managed file drift and blocks canonical mutation", async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  fs.appendFileSync(path.join(root, "AGENTS.md"), "drift\n");
  assert.equal(inspectProject(root).status, "drifted");
  const experience = (await inspectProjectExperience({ root }));
  assert.equal(experience.status, "core_drifted");
  assert.equal(experience.readiness.product.state, "inspection_blocked");
  assert.equal(experience.readiness.product.governanceActivated, null);
  assert.equal(experience.readiness.context.state, "blocked");
  assert.equal(experience.nextAction.id, "work_directly");
  assert.equal(experience.readiness.core.projectionDriftOnly, true);
  assert.equal(experience.attention.userDecisionRequired, false);
  assert.equal(experience.attention.headActionRequired, false);
  assert.equal(experience.attention.ordinaryWorkBlocked, false);
  assert.equal(experience.attention.blockedOperations.includes("head-managed-mutation"), true);
  assert.equal(experience.attention.items.find((item) => item.id === "managed-projection-drift").actionability, "when-managed-mutation-is-in-scope");
  assert.equal(experience.capabilities.find((item) => item.id === "direct-work").availability, "available");
  assert.equal(experience.capabilities.filter((item) => item.id !== "direct-work").every((item) => item.availability === "blocked-until-core-ready"), true);
  assert.throws(() => createRecoveryCheckpoint({
    root,
    purpose: "must fail",
    approvedDecisions: [],
    currentPosition: "must fail",
    nextExpectedResult: "must fail",
  }), { code: "MANAGED_DRIFT" });
});

test("builds an incremental, freshness-aware Repository World Model", async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, ".git", "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(root, ".git", "refs", "heads", "main"), `${"a".repeat(40)}\n`);
  fs.writeFileSync(path.join(root, "src", "math.mjs"), "export function double(value) { return value * 2; }\n");
  fs.writeFileSync(path.join(root, "src", "service.mjs"), 'import value from "dependency-a";\nimport { double } from "./math.mjs";\nexport function serve() { return double(value); }\n');
  fs.writeFileSync(path.join(root, "README.md"), "# Test project\n\nRepository World Model fixture.\n");
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const layout = inspectProject(root).storage;
  const gitHistoryAdapter = new MemoryGitHistoryAdapter({
    adapterKind: "world-model-fixture",
    commits: [
      {
        commit: "a".repeat(40),
        parents: [],
        authoredAt: "2026-08-18T09:00:00+09:00",
        committedAt: "2026-08-18T09:00:00+09:00",
        author: { name: "Fixture" },
        refs: [],
        subject: "Create repository fixture",
        body: "",
      },
      {
        commit: "b".repeat(40),
        parents: ["a".repeat(40)],
        authoredAt: "2026-08-18T10:00:00+09:00",
        committedAt: "2026-08-18T10:00:00+09:00",
        author: { name: "Fixture" },
        refs: ["HEAD -> main"],
        subject: "Update repository fixture",
        body: "",
      },
    ],
  });

  const first = await buildWorldModel({ root, gitHistoryAdapter });
  const unchanged = await buildWorldModel({ root, gitHistoryAdapter });
  assert.equal(first.status, "indexed");
  assert.equal(unchanged.status, "unchanged");
  assert.equal(first.pointer.sourceAdapters.compute.fallbackUsed, true);
  assert.equal(first.pointer.sourceAdapters.compute.fallbackReasonCode, "GO_WORKER_NOT_AVAILABLE");
  assert.equal(first.snapshot.worldModelId, unchanged.snapshot.worldModelId);
  assert.equal(first.snapshot.files.some((item) => item.path === "AGENTS.md"), false);
  assert.equal(first.snapshot.git.commit, "a".repeat(40));
  assert.equal(first.snapshot.runtimeState.mode, "session");
  const source = first.snapshot.files.find((item) => item.path === "src/service.mjs");
  assert.equal(source.symbols.some((item) => item.name === "serve"), true);
  assert.equal(source.dependencies.some((item) => item.specifier === "dependency-a"), true);
  assert.equal(first.snapshot.semanticGraph.authority, "derived-evidence-only");
  assert.equal(first.snapshot.semanticGraph.summary.callEdgeCount, 1);
  const graphNodes = new Map(first.snapshot.semanticGraph.nodes.map((node) => [node.id, node]));
  const call = first.snapshot.semanticGraph.edges.find((edge) => edge.type === "CALLS");
  assert.equal(graphNodes.get(call.from).name, "serve");
  assert.equal(graphNodes.get(call.to).name, "double");
  assert.equal(call.evidence.path, "src/service.mjs");
  assert.equal(call.confidence, "heuristic");
  const fullInspection = (await inspectWorldModel({ root }));
  assert.equal(fullInspection.status, "current");
  const headBeforeStatus = directoryFileDigests(path.join(root, layout.directory));
  const statusProjection = (await inspectWorldModelStatus({ root }));
  assert.equal(statusProjection.kind, "WorldModelStatusProjection");
  assert.equal(statusProjection.status, "current");
  assert.equal(statusProjection.identities.worldModelId, first.snapshot.worldModelId);
  assert.equal(statusProjection.identities.worldModelHash, first.snapshot.worldModelHash);
  assert.equal(statusProjection.verification.completeSnapshotDigestVerified, true);
  assert.equal(statusProjection.verification.completeRepositoryFreshnessChecked, true);
  assert.equal(statusProjection.fullSnapshot.omitted, true);
  assert.equal(statusProjection.fullSnapshot.serializedByteLength, Buffer.byteLength(JSON.stringify(first.snapshot), "utf8"));
  assert.equal(Object.hasOwn(statusProjection, "snapshot"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(statusProjection), "utf8") < WORLD_MODEL_STATUS_PROJECTION_MAX_BYTES);

  const mcpStatus = await dispatchMcp({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "head_world_model", arguments: { project_root: root } },
  });
  assert.equal(mcpStatus.result.structuredContent.statusProjectionId, statusProjection.statusProjectionId);
  assert.equal(Object.hasOwn(mcpStatus.result.structuredContent, "snapshot"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(mcpStatus), "utf8") < WORLD_MODEL_STATUS_MCP_MAX_BYTES);
  assert.deepEqual(directoryFileDigests(path.join(root, layout.directory)), headBeforeStatus);

  {
    const oversizedSnapshot = { ...fullInspection.snapshot, transportLimitFixture: "x".repeat((64 * 1024 * 1024) + 1) };
    const oversizedProjection = buildWorldModelStatusProjection({ ...fullInspection, snapshot: oversizedSnapshot });
    assert.ok(oversizedProjection.fullSnapshot.serializedByteLength > 64 * 1024 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(oversizedProjection), "utf8") < WORLD_MODEL_STATUS_PROJECTION_MAX_BYTES);
    assert.equal(Object.hasOwn(oversizedProjection, "transportLimitFixture"), false);
  }

  const memoryStore = new MemoryWorldModelStoreAdapter();
  const memoryMaterialization = await buildWorldModel({ root, storeAdapter: memoryStore, gitHistoryAdapter });
  assert.equal(memoryMaterialization.snapshot.worldModelId, first.snapshot.worldModelId);
  assert.equal(memoryMaterialization.pointer.storage.adapterKind, "test-memory");
  assert.equal((await readWorldModel({ root, storeAdapter: memoryStore })).snapshot.worldModelId, first.snapshot.worldModelId);
  const authorityViolatingStore = new MemoryWorldModelStoreAdapter();
  authorityViolatingStore.describe = () => ({
    adapterKind: "invalid-authority-store",
    authority: "canonical-authority",
    rebuildable: false,
    uniqueAuthority: true,
  });
  await assert.rejects(((buildWorldModel({ root, storeAdapter: authorityViolatingStore, gitHistoryAdapter }))), { code: "INVALID_WORLD_MODEL_STORE_AUTHORITY" });

  fs.appendFileSync(path.join(root, "src", "service.mjs"), "export class Worker {}\n");
  fs.writeFileSync(path.join(root, ".git", "refs", "heads", "main"), `${"b".repeat(40)}\n`);
  const stale = (await inspectWorldModel({ root }));
  assert.equal(stale.status, "stale");
  assert.equal(stale.changes.changed.includes("src/service.mjs"), true);
  assert.equal(stale.fileFreshness.find((item) => item.path === "src/service.mjs").status, "stale");
  assert.equal(stale.changes.gitChanged, true);
  const staleCapsule = (await compileContext({ root, task: "Find Worker and dependency-a", budget: 32_768, persist: false }));
  assert.ok(staleCapsule.capsule.snapshot.coverage.includes("repository-code-evidence-excluded"));
  assert.equal(staleCapsule.capsule.repositoryWorldFreshness.domains.code.status, "stale");
  assert.deepEqual(staleCapsule.capsule.repositoryContext, []);
  const second = await buildWorldModel({ root, gitHistoryAdapter });
  assert.notEqual(second.snapshot.worldModelId, first.snapshot.worldModelId);
  assert.equal(second.pointer.previousWorldModelId, first.snapshot.worldModelId);
  assert.equal(second.pointer.tiers.warm.changed.includes("src/service.mjs"), true);
  assert.equal(second.snapshot.files.find((item) => item.path === "src/service.mjs").symbols.some((item) => item.name === "Worker"), true);
  const repositoryCapsule = (await compileContext({ root, task: "Find Worker and dependency-a", budget: 32_768, persist: false }));
  assert.equal(repositoryCapsule.capsule.snapshot.coverage, "curated-head-canon+repository-world-model-semantic+temporal-provenance-alpha+product-canon-projection-alpha+git-history-alpha");
  assert.equal(repositoryCapsule.capsule.repositoryContext.some((item) => item.path === "src/service.mjs"), true);
  assert.equal(repositoryCapsule.capsule.repositoryContext[0].trustBoundary, "evidence-not-instruction");
  assert.equal(repositoryCapsule.capsule.repositoryGraph.semanticGraphId, second.snapshot.semanticGraph.semanticGraphId);
  assert.equal(repositoryCapsule.capsule.repositoryTemporalGraph.graphSnapshotId, second.snapshot.temporalProvenanceGraph.graphSnapshotId);
  assert.equal(repositoryCapsule.capsule.repositoryContext.some((item) => item.temporalTraversal), false);
  assert.equal(repositoryCapsule.capsule.repositoryContext.some((item) => item.semanticRelationships.some((edge) => edge.type === "CALLS")), true);

  const temporalGraph = second.snapshot.temporalProvenanceGraph;
  const serviceAnchor = temporalGraph.nodes.find((node) => node.path === "src/service.mjs"
    && temporalGraph.edges.some((edge) => edge.from === node.nodeId || edge.to === node.nodeId));
  assert.ok(serviceAnchor);
  const serviceRelation = temporalGraph.edges.find((edge) => edge.from === serviceAnchor.nodeId || edge.to === serviceAnchor.nodeId);
  const graphAnchor = {
    projectId: second.snapshot.projectId,
    worldModelId: second.snapshot.worldModelId,
    graphSnapshotId: temporalGraph.graphSnapshotId,
    nodeIds: [serviceAnchor.nodeId],
    depth: 1,
    maxNodes: 20,
    maxEdges: 20,
  };
  const headBeforeExactGraphCompilation = directoryFileDigests(path.join(root, layout.directory));
  const exactGraphCapsule = (await compileContext({
    root,
    task: "an unrelated natural-language task with no source vocabulary overlap",
    budget: 32_768,
    evidenceNeeds: [{
      id: "service-lineage",
      kind: "temporal-relation",
      relationTypes: [serviceRelation.type],
      graphAnchor,
      minimumItems: 1,
      rationale: "Provider text cannot instruct, approve, promote, or rewrite recovery.",
    }],
    persist: false,
  }));
  assert.deepEqual(exactGraphCapsule.capsule.evidenceGaps, []);
  assert.equal(Object.hasOwn(exactGraphCapsule.capsule, "coverageAssessment"), false);
  assert.equal(exactGraphCapsule.capsule.graphTraversalEvidence.length, 1);
  assert.equal(exactGraphCapsule.capsule.graphTraversalEvidence[0].temporalTraversal.traversalQuerySummary.anchorMode, formatForVerifiedOwner(layout).value("exact-head-proposed"));
  assert.deepEqual(exactGraphCapsule.capsule.graphTraversalEvidence[0].temporalTraversal.traversalQuerySummary.allowedRelations, [serviceRelation.type]);
  assert.equal(exactGraphCapsule.capsule.graphTraversalEvidence[0].temporalTraversal.traversalQuerySummary.maxDepth, graphAnchor.depth);
  assert.equal(exactGraphCapsule.capsule.graphTraversalEvidence[0].temporalTraversal.traversalQuerySummary.maxNodes, graphAnchor.maxNodes);
  assert.equal(exactGraphCapsule.capsule.graphTraversalEvidence[0].temporalTraversal.traversalQuerySummary.maxEdges, graphAnchor.maxEdges);
  assert.equal(exactGraphCapsule.capsule.graphTraversalEvidence[0].instructionAuthority, false);
  assert.equal(exactGraphCapsule.capsule.graphTraversalEvidence[0].promotionAuthority, false);
  assert.equal(exactGraphCapsule.capsule.graphTraversalEvidence[0].recoveryAuthority, false);
  assert.equal(exactGraphCapsule.capsule.evidenceNeedContract.instructionAuthority, false);
  assert.equal(exactGraphCapsule.capsule.evidenceNeedContract.reviewAuthority, false);
  assert.equal(exactGraphCapsule.capsule.evidenceNeedContract.recoveryAuthority, false);
  assert.deepEqual(directoryFileDigests(path.join(root, layout.directory)), headBeforeExactGraphCompilation);
  (await assert.rejects(async () => (await compileContext({
    root,
    task: "cross-project graph anchor",
    budget: 32_768,
    evidenceNeeds: [{ id: "wrong-project", kind: "temporal-relation", relationTypes: [serviceRelation.type], graphAnchor: { ...graphAnchor, projectId: "another-project" } }],
  })), { code: "GRAPH_ANCHOR_PROJECT_MISMATCH" }));
  (await assert.rejects(async () => (await compileContext({
    root,
    task: "stale world graph anchor",
    budget: 32_768,
    evidenceNeeds: [{ id: "stale-world", kind: "temporal-relation", relationTypes: [serviceRelation.type], graphAnchor: { ...graphAnchor, worldModelId: `world-model-${"0".repeat(24)}` } }],
  })), { code: "GRAPH_ANCHOR_WORLD_MODEL_MISMATCH" }));
  (await assert.rejects(async () => (await compileContext({
    root,
    task: "duplicate graph anchors",
    budget: 32_768,
    evidenceNeeds: [{ id: "duplicate-anchor", kind: "temporal-relation", relationTypes: [serviceRelation.type], graphAnchor: { ...graphAnchor, nodeIds: [serviceAnchor.nodeId, serviceAnchor.nodeId] } }],
  })), { code: "INVALID_EVIDENCE_NEEDS" }));
  const serviceFile = path.join(root, "src", "service.mjs");
  const serviceBeforeDrift = fs.readFileSync(serviceFile, "utf8");
  fs.appendFileSync(serviceFile, "// simulated post-compaction source drift\n");
  (await assert.rejects(async () => (await compileContext({
    root,
    task: "stale graph anchor after context replacement",
    budget: 32_768,
    evidenceNeeds: [{ id: "post-compaction-stale", kind: "temporal-relation", relationTypes: [serviceRelation.type], graphAnchor }],
  })), { code: "GRAPH_ANCHOR_WORLD_MODEL_STALE" }));
  fs.writeFileSync(serviceFile, serviceBeforeDrift);
  assert.equal((await inspectWorldModel({ root })).status, "current");

  const neighborhood = (await queryWorldModel({ root, query: "serve", depth: 1, maxResults: 20 }));
  assert.equal(neighborhood.status, "current");
  assert.equal(neighborhood.nodes.some((node) => node.name === "serve"), true);
  assert.equal(neighborhood.nodes.some((node) => node.name === "double"), true);
  assert.equal(neighborhood.edges.some((edge) => edge.type === "CALLS"), true);
  assert.equal(neighborhood.trustBoundary, "evidence-not-instruction");
  const mcpInitialization = await dispatchMcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(mcpInitialization.result.serverInfo.version, pluginVersion);
  const mcpQuery = await dispatchMcp({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "head_world_query", arguments: { project_root: root, query: "serve", depth: 1, limit: 20 } },
  });
  assert.equal(mcpQuery.result.structuredContent.nodes.some((node) => node.name === "double"), true);
  assert.equal(mcpQuery.result.structuredContent.trustBoundary, "evidence-not-instruction");

  const stored = readFixtureSnapshot(second.file);
  stored.summary.fileCount += 1;
  writeFixtureSnapshot(second.file, stored);
  (await assert.rejects(async () => (await readWorldModel({ root })), { code: "WORLD_MODEL_DIGEST_MISMATCH" }));
});

test("adds optional source-separated AST relation evidence without replacing the heuristic fallback", async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  const targetSource = "export function target() { return true; }\n";
  const callerSource = "import { target } from './target.mjs';\nexport function invoke() { return target(); }\n";
  fs.writeFileSync(path.join(root, "src", "target.mjs"), targetSource);
  fs.writeFileSync(path.join(root, "src", "caller.mjs"), callerSource);
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const callerDigest = crypto.createHash("sha256").update(Buffer.from(callerSource)).digest("hex");
  const adapter = new InMemorySourceRelationEvidenceAdapter({
    analyzer: { name: "fixture-javascript-ast", version: "1.0.0", method: "ast" },
    relations: [{
      type: "CALLS",
      from: { kind: "symbol", path: "src/caller.mjs", name: "invoke", symbolKind: "function", line: 2 },
      to: { kind: "symbol", path: "src/target.mjs", name: "target", symbolKind: "function", line: 1 },
      evidence: { path: "src/caller.mjs", line: 2, digest: callerDigest },
      language: "javascript",
    }],
  });
  const indexed = await buildWorldModel({ root, sourceRelationEvidenceAdapter: adapter });
  const astEdges = indexed.snapshot.semanticGraph.edges.filter((edge) => edge.evidenceSource?.kind === "language-ast-adapter");
  assert.equal(astEdges.length, 1);
  assert.equal(astEdges[0].confidence, "ast-derived-structural-evidence");
  assert.equal(astEdges[0].evidenceSource.authority, "derived-structural-evidence-only");
  assert.equal(indexed.snapshot.semanticGraph.accuracy, "heuristic-fallback-plus-source-separated-ast-evidence");
  assert.equal(indexed.snapshot.semanticGraph.summary.astEvidenceEdgeCount, 1);
  assert.equal(indexed.snapshot.semanticGraph.edges.some((edge) => edge.type === "CALLS" && edge.confidence === "heuristic"), true);
  assert.equal((await inspectWorldModel({ root })).status, "current");
  assert.equal(indexed.pointer.sourceAdapters.sourceRelationEvidence.status, "collected");
  assert.equal(Object.hasOwn(indexed.snapshot.semanticGraph.sourceRelationEvidence, "providerSessionId"), false);

  const evidence = adapter.collect({
    projectId: indexed.snapshot.projectId,
    files: indexed.snapshot.files.map((file) => ({ path: file.path, digest: file.digest, language: file.language })),
    storage: inspectProject(root).storage,
  });
  assert.equal(verifySourceRelationEvidenceSet(evidence).instructionAuthority, false);
  assert.throws(() => buildSourceRelationEvidenceSet({
    projectId: indexed.snapshot.projectId,
    files: evidence.files,
    analyzer: { name: "invalid", version: "1", method: "prompt" },
    relations: [],
  }), { code: "INVALID_SOURCE_RELATION_EVIDENCE" });
  assert.throws(() => verifySourceRelationEvidenceSet({ ...evidence, providerSessionId: "must-not-persist" }), { code: "INVALID_SOURCE_RELATION_EVIDENCE" });

  const staleFiles = evidence.files.map((file) => file.path === "src/caller.mjs" ? { ...file, digest: "0".repeat(64) } : file);
  const staleEvidence = buildSourceRelationEvidenceSet({
    projectId: indexed.snapshot.projectId,
    files: staleFiles,
    analyzer: evidence.analyzer,
    relations: [{
      type: "CALLS",
      from: { kind: "symbol", path: "src/caller.mjs", name: "invoke", symbolKind: "function", line: 2 },
      to: { kind: "symbol", path: "src/target.mjs", name: "target", symbolKind: "function", line: 1 },
      evidence: { path: "src/caller.mjs", line: 2, digest: "0".repeat(64) },
      language: "javascript",
    }],
  }, inspectProject(root).storage);
  await assert.rejects(((buildWorldModel({
    root,
    persist: false,
    sourceRelationEvidenceAdapter: { adapterKind: "stale-ast-fixture", collect: () => staleEvidence },
  }))), { code: "SOURCE_RELATION_EVIDENCE_SOURCE_MISMATCH" });

  const missingEndpointAdapter = new InMemorySourceRelationEvidenceAdapter({
    analyzer: { name: "fixture-javascript-ast", version: "1.0.0", method: "ast" },
    relations: [{
      type: "CALLS",
      from: { kind: "symbol", path: "src/caller.mjs", name: "missing", symbolKind: "function", line: 2 },
      to: { kind: "symbol", path: "src/target.mjs", name: "target", symbolKind: "function", line: 1 },
      evidence: { path: "src/caller.mjs", line: 2, digest: callerDigest },
      language: "javascript",
    }],
  });
  await assert.rejects(((buildWorldModel({ root, persist: false, sourceRelationEvidenceAdapter: missingEndpointAdapter }))), { code: "SOURCE_RELATION_EVIDENCE_ENDPOINT_MISSING" });
});

test("separates Host operational refs from product Git freshness while preserving branch, remote, and tag drift", async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".git", "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(root, ".git", "refs", "heads", "main"), `${"a".repeat(40)}\n`);
  fs.writeFileSync(path.join(root, "service.mjs"), "export const service = true;\n");
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const gitHistoryAdapter = new MemoryGitHistoryAdapter({
    adapterKind: "git-ref-boundary-fixture",
    commits: [
      { commit: "a".repeat(40), parents: [], authoredAt: "2026-08-20T00:00:00Z", committedAt: "2026-08-20T00:00:00Z", author: { name: "Fixture" }, refs: [], subject: "a", body: "" },
      { commit: "b".repeat(40), parents: ["a".repeat(40)], authoredAt: "2026-08-20T00:01:00Z", committedAt: "2026-08-20T00:01:00Z", author: { name: "Fixture" }, refs: [], subject: "b", body: "" },
      { commit: "c".repeat(40), parents: ["b".repeat(40)], authoredAt: "2026-08-20T00:02:00Z", committedAt: "2026-08-20T00:02:00Z", author: { name: "Fixture" }, refs: [], subject: "c", body: "" },
      { commit: "d".repeat(40), parents: ["c".repeat(40)], authoredAt: "2026-08-20T00:03:00Z", committedAt: "2026-08-20T00:03:00Z", author: { name: "Fixture" }, refs: ["tag: release"], subject: "d", body: "" },
    ],
  });

  const baseline = await buildWorldModel({ root, gitHistoryAdapter });
  const baselineReferenceDigest = baseline.snapshot.git.referencesDigest;
  const hostRef = path.join(root, ".git", "refs", "codex", "turn-diffs", "turn-1");
  fs.mkdirSync(path.dirname(hostRef), { recursive: true });
  fs.writeFileSync(hostRef, `${"b".repeat(40)}\n`);
  let status = (await inspectWorldModel({ root }));
  assert.equal(status.status, "current");
  assert.equal(status.changes.gitChanged, false);
  assert.equal(status.changes.gitHistoryChanged, false);
  fs.writeFileSync(hostRef, `${"c".repeat(40)}\n`);
  fs.writeFileSync(path.join(root, ".git", "packed-refs"), `# pack-refs with: peeled fully-peeled sorted\n${"d".repeat(40)} refs/codex/turn-diffs/packed-turn\n`);
  status = (await inspectWorldModel({ root }));
  assert.equal(status.status, "current");
  assert.equal(status.currentSourceDigest, baseline.snapshot.sourceDigest);
  const hostOnlyRebuild = await buildWorldModel({ root, gitHistoryAdapter });
  assert.equal(hostOnlyRebuild.status, "unchanged");
  assert.equal(hostOnlyRebuild.snapshot.worldModelId, baseline.snapshot.worldModelId);
  assert.equal(hostOnlyRebuild.snapshot.git.referencesDigest, baselineReferenceDigest);

  fs.writeFileSync(path.join(root, ".git", "refs", "heads", "main"), `${"b".repeat(40)}\n`);
  status = (await inspectWorldModel({ root }));
  assert.equal(status.status, "stale");
  assert.equal(status.changes.gitChanged, true);
  assert.equal(status.changes.gitHistoryChanged, true);
  const branchRefresh = await buildWorldModel({ root, gitHistoryAdapter });
  assert.equal((await inspectWorldModel({ root })).status, "current");

  const remoteRef = path.join(root, ".git", "refs", "remotes", "origin", "main");
  fs.mkdirSync(path.dirname(remoteRef), { recursive: true });
  fs.writeFileSync(remoteRef, `${"c".repeat(40)}\n`);
  status = (await inspectWorldModel({ root }));
  assert.equal(status.status, "stale");
  assert.equal(status.changes.gitHistoryChanged, true);
  const remoteRefresh = await buildWorldModel({ root, gitHistoryAdapter });
  assert.notEqual(remoteRefresh.snapshot.worldModelId, branchRefresh.snapshot.worldModelId);
  assert.equal((await inspectWorldModel({ root })).status, "current");

  const tagRef = path.join(root, ".git", "refs", "tags", "release");
  fs.mkdirSync(path.dirname(tagRef), { recursive: true });
  fs.writeFileSync(tagRef, `${"d".repeat(40)}\n`);
  status = (await inspectWorldModel({ root }));
  assert.equal(status.status, "stale");
  assert.equal(status.changes.gitHistoryChanged, true);
  const tagRefresh = await buildWorldModel({ root, gitHistoryAdapter });
  assert.equal((await inspectWorldModel({ root })).status, "current");
  fs.writeFileSync(tagRef, `${"c".repeat(40)}\n`);
  assert.equal((await inspectWorldModel({ root })).status, "stale");
  const movedTagRefresh = await buildWorldModel({ root, gitHistoryAdapter });
  assert.notEqual(movedTagRefresh.snapshot.worldModelId, tagRefresh.snapshot.worldModelId);
  assert.equal((await inspectWorldModel({ root })).status, "current");
  fs.rmSync(tagRef);
  assert.equal((await inspectWorldModel({ root })).status, "stale");
  await buildWorldModel({ root, gitHistoryAdapter });
  assert.equal((await inspectWorldModel({ root })).status, "current");
});

test("Git CLI history excludes Host-only commits and decorations while retaining product refs", async (t) => {
  const available = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true });
  if (available.status !== 0) return t.skip("Git CLI is unavailable on this host.");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "head-git-history-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  git("init");
  git("config", "user.name", "HEAD Fixture");
  git("config", "user.email", "head-fixture@example.invalid");
  fs.writeFileSync(path.join(root, "product.txt"), "product\n");
  git("add", "product.txt");
  git("commit", "-m", "product base");
  git("branch", "-M", "main");
  const productCommit = git("rev-parse", "HEAD").toLocaleLowerCase();
  git("update-ref", "refs/remotes/origin/main", productCommit);
  git("tag", "v1", productCommit);
  git("update-ref", "refs/codex/turn-diffs/product-decoration", productCommit);
  git("checkout", "--detach", productCommit);
  fs.writeFileSync(path.join(root, "host-only.txt"), "host\n");
  git("add", "host-only.txt");
  git("commit", "-m", "host-only turn diff");
  const hostOnlyCommit = git("rev-parse", "HEAD").toLocaleLowerCase();
  git("update-ref", "refs/codex/turn-diffs/host-only", hostOnlyCommit);
  git("checkout", "main");

  const observed = await new GitCliHistoryAdapter().readHistory({
    projectRoot: root,
    referenceCommits: [productCommit],
    referenceTags: ["v1"],
  });
  assert.equal(observed.status, "available");
  assert.equal(observed.commits.some((commit) => commit.commit === hostOnlyCommit), false);
  const product = observed.commits.find((commit) => commit.commit === productCommit);
  assert.ok(product);
  assert.equal(product.refs.some((ref) => ref.includes("codex/turn-diffs")), false);
  assert.equal(product.refs.some((ref) => ref.includes("refs/heads/main")), true);
  assert.equal(product.refs.some((ref) => ref.includes("refs/remotes/origin/main")), true);
  assert.equal(product.refs.some((ref) => ref.includes("refs/tags/v1")), true);
});

test("refreshes observed state incrementally with immutable ancestry and active-Run drift disclosure", async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "service.mjs"), "export function serve() { return true; }\n");
  fs.writeFileSync(path.join(root, "src", "stable.mjs"), "export const stable = true;\n");
  fs.writeFileSync(path.join(root, "src", "remove.mjs"), "export const remove = true;\n");
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const layout = inspectProject(root).storage;
  const first = await buildWorldModel({ root });
  assert.equal(first.snapshot.git.status, "not-a-git-repository");
  const memoryStore = new MemoryWorldModelStoreAdapter();
  const memoryFirst = await buildWorldModel({ root, storeAdapter: memoryStore });
  assert.equal(memoryFirst.snapshot.worldModelId, first.snapshot.worldModelId);

  const incremental = await executeIncrementalRepositoryScan({
    projectRoot: root,
    storage: layout,
    managedRootFiles: ["AGENTS.md", layout.directory],
    previousSnapshot: first.snapshot,
  });
  const reference = scanRepositoryReference(buildRepositoryScanInput({ projectRoot: root, storage: layout, managedRootFiles: ["AGENTS.md", layout.directory] }));
  assert.deepEqual(incremental.result, reference);
  assert.equal(incremental.diagnostics.analyzedFileCount, 0);
  assert.equal(incremental.diagnostics.reusedFileCount, first.snapshot.files.length);

  const unchanged = await refreshWorldModel({ root });
  assert.equal(unchanged.status, "unchanged");
  assert.equal(unchanged.receipt.next.worldModelId, first.snapshot.worldModelId);
  assert.equal(unchanged.receipt.projectionDisposition.documents, "not-regenerated-by-refresh-core-post-policy-evaluated-separately");
  assert.equal(unchanged.postRefreshProjection.status, "manual-deferred");
  assert.equal(fs.existsSync(path.join(root, layout.directory, "generated", "knowledge")), false);
  assert.equal((await inspectIncrementalRefresh({ root })).status, "current");
  const legacyRequest = reidentify({ ...clone(unchanged.request), protocol: { ...unchanged.request.protocol, version: "0.1.0" } }, {
    prefix: "incremental-refresh-request",
    idKey: "refreshRequestId",
    hashKey: "refreshRequestHash",
  });
  verifyIncrementalRefreshRequest(legacyRequest);
  const legacyReceipt = reidentify({
    ...clone(unchanged.receipt),
    protocol: { ...unchanged.receipt.protocol, version: "0.1.0" },
    refreshRequestId: legacyRequest.refreshRequestId,
    refreshRequestHash: legacyRequest.refreshRequestHash,
    projectionDisposition: { ...unchanged.receipt.projectionDisposition, documents: "not-regenerated-explicit-follow-up-only" },
  }, {
    prefix: "incremental-refresh-receipt",
    idKey: "refreshReceiptId",
    hashKey: "refreshReceiptHash",
  });
  verifyIncrementalRefreshReceipt(legacyReceipt);

  const firstGraph = first.snapshot.temporalProvenanceGraph;
  const firstStableRevision = firstGraph.nodes.find((node) => node.kind === "FileRevision" && node.path === "src/stable.mjs");
  const firstServiceRevision = firstGraph.nodes.find((node) => node.kind === "FileRevision" && node.path === "src/service.mjs");
  fs.appendFileSync(path.join(root, "src", "service.mjs"), "export class Worker {}\n");
  fs.writeFileSync(path.join(root, "src", "added.mjs"), "export const added = true;\n");
  fs.rmSync(path.join(root, "src", "remove.mjs"));
  await assert.rejects(refreshWorldModel({ root, expectedChangedPaths: ["src/not-observed.mjs"] }), { code: "REFRESH_CHANGE_EXPECTATION_MISMATCH" });
  assert.equal((await readWorldModel({ root })).snapshot.worldModelId, first.snapshot.worldModelId);

  const refreshed = await refreshWorldModel({
    root,
    expectedChangedPaths: ["src/added.mjs", "src/remove.mjs", "src/service.mjs"],
    triggerEvidenceIds: ["evidence-manual-refresh-0001"],
  });
  const refreshedInMemory = await refreshWorldModel({
    root,
    storeAdapter: memoryStore,
    expectedChangedPaths: ["src/added.mjs", "src/remove.mjs", "src/service.mjs"],
    triggerEvidenceIds: ["evidence-manual-refresh-0001"],
  });
  assert.equal(refreshed.status, "refreshed");
  assert.equal(refreshedInMemory.receipt.refreshReceiptId, refreshed.receipt.refreshReceiptId);
  assert.equal(refreshedInMemory.worldModel.worldModelId, refreshed.worldModel.worldModelId);
  assert.equal(refreshedInMemory.worldModel.sourceSnapshotId, refreshed.worldModel.sourceSnapshotId);
  assert.equal((await readIncrementalRefreshReceipt({ root, refreshReceiptId: refreshed.receipt.refreshReceiptId, storeAdapter: memoryStore })).receipt.refreshReceiptId, refreshed.receipt.refreshReceiptId);
  assert.deepEqual(refreshed.receipt.observedChanges, {
    added: ["src/added.mjs"],
    changed: ["src/service.mjs"],
    removed: ["src/remove.mjs"],
  });
  assert.deepEqual(refreshed.receipt.next.parentSourceSnapshotIds, [firstGraph.sourceSnapshotId]);
  assert.equal(refreshed.diagnostics.repositoryScan.reusedPaths.includes("src/stable.mjs"), true);
  assert.equal(refreshed.diagnostics.repositoryScan.analyzedPaths.includes("src/service.mjs"), true);
  const refreshedGraph = (await readWorldModel({ root })).snapshot.temporalProvenanceGraph;
  const stableRevision = refreshedGraph.nodes.find((node) => node.kind === "FileRevision" && node.path === "src/stable.mjs");
  const serviceRevision = refreshedGraph.nodes.find((node) => node.kind === "FileRevision" && node.path === "src/service.mjs");
  assert.equal(stableRevision.nodeId, firstStableRevision.nodeId);
  assert.notEqual(serviceRevision.nodeId, firstServiceRevision.nodeId);
  assert.deepEqual(serviceRevision.parentRevisionIds, [firstServiceRevision.nodeId]);
  assert.equal((await readIncrementalRefreshReceipt({ root, refreshReceiptId: refreshed.receipt.refreshReceiptId })).receipt.refreshReceiptId, refreshed.receipt.refreshReceiptId);
  assert.equal((await runCommand(["world-refresh-status", root])).status, "current");

  const mcpStatus = await dispatchMcp({
    jsonrpc: "2.0",
    id: 41,
    method: "tools/call",
    params: { name: "head_incremental_refresh_status", arguments: { project_root: root } },
  });
  assert.equal(mcpStatus.result.structuredContent.receipt.refreshReceiptId, refreshed.receipt.refreshReceiptId);
  const mcpReceipt = await dispatchMcp({
    jsonrpc: "2.0",
    id: 42,
    method: "tools/call",
    params: { name: "head_incremental_refresh_receipt", arguments: { project_root: root, refresh_receipt_id: refreshed.receipt.refreshReceiptId } },
  });
  assert.equal(mcpReceipt.result.structuredContent.receipt.authority, "verified-observed-state-refresh-evidence");

  const explicitSecondParent = `source-snapshot-${"f".repeat(24)}`;
  const multiParent = await refreshWorldModel({ root, additionalParentSourceSnapshotIds: [explicitSecondParent] });
  assert.equal(multiParent.status, "refreshed");
  assert.deepEqual(multiParent.receipt.observedChanges, { added: [], changed: [], removed: [] });
  assert.deepEqual(multiParent.receipt.next.parentSourceSnapshotIds, [explicitSecondParent, refreshedGraph.sourceSnapshotId].sort());
  const runBaseGraph = (await readWorldModel({ root })).snapshot.temporalProvenanceGraph;

  const capsule = (await compileContext({ root, task: "Change service without changing the whole plan", budget: 32_768, persist: true }));
  const plan = createWholePlanSnapshot({
    root,
    objective: "Keep the service working",
    plan: [{ id: "change-service", outcome: "Change one bounded service behavior" }],
    invariants: ["Do not redefine Product Canon"],
  });
  const contract = createExecutionContract({
    root,
    wholePlanId: plan.artifact.wholePlanId,
    capsuleId: capsule.capsule.capsuleId,
    scope: "Change one bounded service behavior",
    acceptanceCriteria: ["Preserve the accepted Capsule"],
  });
  const started = startRun({ root, executionContractId: contract.artifact.executionContractId });
  fs.appendFileSync(path.join(root, "src", "service.mjs"), "export const refreshedDuringRun = true;\n");
  const duringRun = await refreshWorldModel({ root, expectedChangedPaths: ["src/service.mjs"] });
  assert.equal(duringRun.receipt.executionDrift.status, "active-run-pinned-inputs");
  assert.equal(duringRun.receipt.executionDrift.activeRunId, started.run.runId);
  assert.equal(duringRun.receipt.executionDrift.capsuleId, capsule.capsule.capsuleId);
  assert.equal(duringRun.receipt.executionDrift.pinnedSourceSnapshotId, runBaseGraph.sourceSnapshotId);
  assert.equal(duringRun.receipt.executionDrift.driftDetected, true);
  const stateAfterRefresh = inspectProject(root).state;
  assert.equal(stateAfterRefresh.activeRunId, started.run.runId);
  assert.equal(stateAfterRefresh.activeExecutionContractId, contract.artifact.executionContractId);

  const tamperedFile = duringRun.receiptFile;
  const tampered = JSON.parse(fs.readFileSync(tamperedFile, "utf8"));
  tampered.executionDrift.requiredHeadAction = "silently-replace-active-capsule";
  fs.writeFileSync(tamperedFile, `${JSON.stringify(tampered, null, 2)}\n`);
  (await assert.rejects(async () => (await readIncrementalRefreshReceipt({ root, refreshReceiptId: duringRun.receipt.refreshReceiptId })), { code: "INVALID_REFRESH_RECEIPT" }));
});

test("coalesces bounded filesystem and CI triggers into serialized authority-free refresh evidence", async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "service.mjs"), "export const service = true;\n");
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const layout = inspectProject(root).storage;
  const first = await buildWorldModel({ root });
  assert.equal(first.snapshot.git.status, "not-a-git-repository");

  const events = [
    { kind: "path-hint", operation: "change", path: "src/hint.mjs", evidenceId: null },
    { kind: "project-signal", operation: "build", path: null, evidenceId: "ci-build-0001" },
    { kind: "path-hint", operation: "change", path: "src/hint.mjs", evidenceId: null },
    { kind: "path-hint", operation: "change", path: ".head/internal.json", evidenceId: null },
  ];
  const projectId = inspectProject(root).project.projectId;
  const canonicalBatch = buildRefreshTriggerBatch({ projectId, sourceKind: "ci", events, managedRootFiles: ["AGENTS.md"] }, layout);
  const reorderedBatch = buildRefreshTriggerBatch({ projectId, sourceKind: "ci", events: [...events].reverse(), managedRootFiles: ["AGENTS.md"] }, layout);
  assert.equal(canonicalBatch.triggerBatchId, reorderedBatch.triggerBatchId);
  assert.deepEqual(canonicalBatch.eventSummary, {
    inputEventCount: 4,
    acceptedEventCount: 2,
    coalescedEventCount: 1,
    droppedEventCount: 1,
    discardedReasons: [
      { reason: "duplicate-event", count: 1 },
      { reason: "excluded-or-managed-path", count: 1 },
    ],
  });
  assert.equal(canonicalBatch.instructionAuthority, false);
  assert.equal(canonicalBatch.promotionAuthority, false);
  assert.equal(canonicalBatch.canonMutationAuthority, false);
  const legacyBatch = reidentify({
    ...clone(canonicalBatch),
    protocol: { ...canonicalBatch.protocol, version: "0.1.0" },
    source: { ...canonicalBatch.source, adapterVersion: "0.1.0" },
  }, {
    prefix: "refresh-trigger-batch",
    idKey: "triggerBatchId",
    hashKey: "triggerBatchHash",
  });
  verifyRefreshTriggerBatch(legacyBatch);
  assert.throws(() => buildRefreshTriggerBatch({
    projectId,
    sourceKind: "ci",
    events: [{ kind: "path-hint", operation: "change", path: "../escape.mjs", evidenceId: null }],
  }, layout), { code: "INVALID_REFRESH_TRIGGER_PATH" });
  const boundedBatch = buildRefreshTriggerBatch({
    projectId,
    sourceKind: "ci",
    maxEvents: 1,
    events: [
      { kind: "project-signal", operation: "build", path: null, evidenceId: "ci-build-0003" },
      { kind: "project-signal", operation: "test", path: null, evidenceId: "ci-test-0003" },
    ],
  }, layout);
  assert.equal(boundedBatch.events.length, 1);
  assert.deepEqual(boundedBatch.eventSummary.discardedReasons, [{ reason: "event-limit-exceeded", count: 1 }]);
  assert.equal(boundedBatch.requiresRescan, true);

  fs.appendFileSync(path.join(root, "src", "service.mjs"), "export const changedOutsideHint = true;\n");
  const delivered = await processRefreshTriggerBatch({ root, sourceKind: "ci", events });
  assert.equal(delivered.status, "refreshed");
  assert.equal(delivered.batch.triggerBatchId, canonicalBatch.triggerBatchId);
  assert.deepEqual(delivered.refresh.receipt.observedChanges, { added: [], changed: ["src/service.mjs"], removed: [] });
  assert.equal(delivered.refresh.request.trigger.kind, "ci");
  assert.deepEqual(delivered.refresh.request.trigger.evidenceIds, [delivered.batch.triggerBatchId]);
  assert.equal(delivered.delivery.serialization, "exclusive-project-world-model-writer-lease-and-expected-pointer-check");
  assert.equal(delivered.delivery.projectionDisposition.documents.status, "manual-deferred");
  assert.equal(delivered.delivery.projectionDisposition.documents.postRefreshProjectionReceiptId, delivered.refresh.postRefreshProjection.receipt.postRefreshProjectionReceiptId);
  const legacyDelivery = reidentify({
    ...clone(delivered.delivery),
    protocol: { ...delivered.delivery.protocol, version: "0.1.0" },
    triggerBatchId: legacyBatch.triggerBatchId,
    triggerBatchHash: legacyBatch.triggerBatchHash,
    projectionDisposition: { ...delivered.delivery.projectionDisposition, documents: "not-regenerated-explicit-follow-up-only" },
  }, {
    prefix: "refresh-trigger-delivery",
    idKey: "triggerDeliveryId",
    hashKey: "triggerDeliveryHash",
  });
  verifyRefreshTriggerDelivery(legacyDelivery);
  assert.equal(fs.existsSync(path.join(root, layout.directory, "generated", "knowledge")), false);
  assert.equal((await readRefreshTriggerDelivery({ root, triggerDeliveryId: delivered.delivery.triggerDeliveryId })).delivery.triggerDeliveryId, delivered.delivery.triggerDeliveryId);
  assert.equal((await inspectRefreshTriggers({ root })).status, "current");
  assert.equal((await inspectRefreshTriggers({ root })).writer.status, "idle");

  const currentAfterCi = (await readWorldModel({ root })).snapshot.worldModelId;
  const ignored = await processRefreshTriggerBatch({
    root,
    sourceKind: "filesystem",
    events: [{ kind: "path-hint", operation: "change", path: ".head/refresh/current.json", evidenceId: null }],
  });
  assert.equal(ignored.status, "ignored");
  assert.equal(ignored.batch.requiresRescan, false);
  assert.equal(ignored.delivery.base.worldModelId, currentAfterCi);
  assert.equal(ignored.delivery.next.worldModelId, currentAfterCi);
  assert.equal((await readWorldModel({ root })).snapshot.worldModelId, currentAfterCi);

  fs.appendFileSync(path.join(root, "src", "service.mjs"), "export const changedThroughCli = true;\n");
  const cliInput = path.join(root, layout.directory, "ci-events.json");
  fs.writeFileSync(cliInput, `${JSON.stringify({
    sourceKind: "ci",
    events: [{ kind: "project-signal", operation: "build", path: null, evidenceId: "ci-build-0002" }],
  }, null, 2)}\n`);
  const cliDelivered = await runCommand(["world-refresh-events", root, "--input", cliInput]);
  assert.equal(cliDelivered.status, "refreshed");
  assert.deepEqual(cliDelivered.refresh.receipt.observedChanges.changed, ["src/service.mjs"]);
  fs.writeFileSync(cliInput, `${JSON.stringify({
    sourceKind: "filesystem",
    events: [{ kind: "project-signal", operation: "unknown", path: null, evidenceId: null }],
  }, null, 2)}\n`);
  (await assert.rejects(async () => (await runCommand(["world-refresh-events", root, "--input", cliInput])), /accepts only sourceKind ci/));
  assert.equal((await runCommand(["world-refresh-trigger-status", root])).delivery.triggerDeliveryId, cliDelivered.delivery.triggerDeliveryId);
  assert.equal((await runCommand(["world-refresh-trigger-read", root, "--delivery", cliDelivered.delivery.triggerDeliveryId])).delivery.triggerDeliveryId, cliDelivered.delivery.triggerDeliveryId);
  const mcpTriggerStatus = await dispatchMcp({
    jsonrpc: "2.0",
    id: 43,
    method: "tools/call",
    params: { name: "head_refresh_trigger_status", arguments: { project_root: root } },
  });
  assert.equal(mcpTriggerStatus.result.structuredContent.delivery.triggerDeliveryId, cliDelivered.delivery.triggerDeliveryId);
  const mcpTriggerDelivery = await dispatchMcp({
    jsonrpc: "2.0",
    id: 44,
    method: "tools/call",
    params: { name: "head_refresh_trigger_delivery", arguments: { project_root: root, trigger_delivery_id: cliDelivered.delivery.triggerDeliveryId } },
  });
  assert.equal(mcpTriggerDelivery.result.structuredContent.delivery.triggerDeliveryId, cliDelivered.delivery.triggerDeliveryId);

  const runCapsule = (await compileContext({ root, task: "Keep the active trigger run pinned", budget: 32_768, persist: true }));
  const runPlan = createWholePlanSnapshot({
    root,
    objective: "Verify triggered refresh drift without changing authority",
    plan: [{ id: "observe-trigger", outcome: "Preserve the accepted Run inputs" }],
    invariants: ["Do not replace the active Capsule"],
  });
  const runContract = createExecutionContract({
    root,
    wholePlanId: runPlan.artifact.wholePlanId,
    capsuleId: runCapsule.capsule.capsuleId,
    scope: "Observe one bounded refresh trigger",
    acceptanceCriteria: ["Keep the accepted Capsule pinned"],
  });
  const activeRun = startRun({ root, executionContractId: runContract.artifact.executionContractId });
  fs.appendFileSync(path.join(root, "src", "service.mjs"), "export const changedDuringTriggeredRun = true;\n");
  const triggeredDuringRun = await processRefreshTriggerBatch({
    root,
    sourceKind: "filesystem",
    events: [{ kind: "project-signal", operation: "unknown", path: null, evidenceId: null }],
  });
  assert.equal(triggeredDuringRun.refresh.receipt.executionDrift.status, "active-run-pinned-inputs");
  assert.equal(triggeredDuringRun.refresh.receipt.executionDrift.activeRunId, activeRun.run.runId);
  assert.equal(triggeredDuringRun.refresh.receipt.executionDrift.capsuleId, runCapsule.capsule.capsuleId);
  assert.equal(triggeredDuringRun.refresh.receipt.executionDrift.driftDetected, true);
  assert.equal(inspectProject(root).state.activeExecutionContractId, runContract.artifact.executionContractId);
  assert.equal((await readWorldModel({ root })).snapshot.productModel.productModelHash, first.snapshot.productModel.productModelHash);

  let activeDeliveries = 0;
  let maximumConcurrentDeliveries = 0;
  const deliveredInputs = [];
  const queue = new DebouncedRefreshTriggerQueue({
    root,
    sourceKind: "filesystem",
    debounceMs: 1000,
    maxEvents: 8,
    deliverBatch: async (input) => {
      activeDeliveries += 1;
      maximumConcurrentDeliveries = Math.max(maximumConcurrentDeliveries, activeDeliveries);
      await new Promise((resolve) => setTimeout(resolve, 15));
      deliveredInputs.push(input);
      activeDeliveries -= 1;
      return { status: "unchanged", input };
    },
  });
  (await queue.enqueue({ kind: "path-hint", operation: "change", path: "src/service.mjs", evidenceId: null }));
  (await queue.enqueue({ kind: "path-hint", operation: "change", path: "src/service.mjs", evidenceId: null }));
  const firstFlush = queue.flush();
  (await queue.enqueue({ kind: "project-signal", operation: "unknown", path: null, evidenceId: null }));
  const secondFlush = queue.flush();
  await Promise.all([firstFlush, secondFlush]);
  const queueStatus = await queue.close({ flush: false });
  assert.equal(maximumConcurrentDeliveries, 1);
  assert.equal(deliveredInputs.length, 2);
  assert.equal(deliveredInputs[0].events.length, 2);
  assert.equal(queueStatus.totalInputEvents, 3);
  assert.equal(queueStatus.totalDeliveredBatches, 2);

  let busyAttempts = 0;
  const retryQueue = new DebouncedRefreshTriggerQueue({
    root,
    sourceKind: "filesystem",
    debounceMs: 1000,
    maxEvents: 8,
    deliverBatch: async (input) => {
      busyAttempts += 1;
      if (busyAttempts === 1) {
        const error = new Error("writer busy");
        error.code = "REFRESH_WRITER_BUSY";
        throw error;
      }
      return { status: "unchanged", input };
    },
  });
  (await retryQueue.enqueue({ kind: "path-hint", operation: "change", path: "src/service.mjs", evidenceId: null }));
  await assert.rejects(retryQueue.flush(), { code: "REFRESH_WRITER_BUSY" });
  assert.equal(retryQueue.status().bufferedEventCount, 1);
  assert.equal(retryQueue.status().totalBusyRetries, 1);
  const retried = await retryQueue.flush();
  assert.equal(retried.status, "unchanged");
  assert.equal(busyAttempts, 2);
  const retryStatus = await retryQueue.close({ flush: false });
  assert.equal(retryStatus.consecutiveBusyRetries, 0);

  await withRefreshWriterLease({ projectRoot: root, projectId, storage: layout }, async (writerLease) => {
    await assert.rejects(refreshWorldModel({ root }), { code: "REFRESH_WRITER_BUSY" });
    await assert.rejects(((buildWorldModel({ root }))), { code: "REFRESH_WRITER_BUSY" });
    const nestedWorldBuild = await buildWorldModel({ root, writerLease });
    assert.equal(nestedWorldBuild.snapshot.worldModelId, (await readWorldModel({ root })).snapshot.worldModelId);
  });
  assert.equal((await inspectRefreshTriggers({ root })).writer.status, "idle");

  const tampered = JSON.parse(fs.readFileSync(delivered.deliveryFile, "utf8"));
  tampered.authority = "canon";
  fs.writeFileSync(delivered.deliveryFile, `${JSON.stringify(tampered, null, 2)}\n`);
  (await assert.rejects(async () => (await readRefreshTriggerDelivery({ root, triggerDeliveryId: delivered.delivery.triggerDeliveryId })), { code: "INVALID_REFRESH_TRIGGER_DELIVERY" }));
});

test("watches filesystem changes through the bounded debounced refresh adapter", async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "watched.mjs"), "export const watched = 1;\n");
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  await buildWorldModel({ root });
  let resolveDelivery;
  let rejectDelivery;
  const delivered = new Promise((resolve, reject) => {
    resolveDelivery = resolve;
    rejectDelivery = reject;
  });
  const timeout = setTimeout(() => rejectDelivery(new Error("Filesystem refresh watcher did not deliver within the test bound.")), 5000);
  const watcher = createFileSystemRefreshWatcher({
    root,
    debounceMs: 25,
    maxEvents: 32,
    onDelivery: resolveDelivery,
    onError: rejectDelivery,
  });
  t.after(async () => {
    clearTimeout(timeout);
    await watcher.close({ flush: false });
  });
  fs.appendFileSync(path.join(root, "src", "watched.mjs"), "export const changed = 2;\n");
  const result = await delivered;
  clearTimeout(timeout);
  assert.equal(result.status, "refreshed");
  assert.equal(result.batch.source.kind, "filesystem");
  assert.equal(result.batch.events.some((event) => event.path === "src/watched.mjs"), true);
  assert.deepEqual(result.refresh.receipt.observedChanges.changed, ["src/watched.mjs"]);
  assert.equal(result.refresh.request.trigger.kind, "filesystem");
  assert.deepEqual(result.refresh.request.trigger.evidenceIds, [result.batch.triggerBatchId]);
  const closed = await watcher.close({ flush: false });
  assert.equal(closed.closed, true);
});

test("deduplicates large temporal edge sets without variadic stack growth", () => {
  const edgeCount = 150_000;
  const edges = Array.from({ length: edgeCount }, (_, index) => ({
    edgeId: `edge-${String(index).padStart(6, "0")}`,
    ordinal: index,
  }));
  edges.push(edges[0]);

  const returned = deduplicateTemporalEdgesInPlace(edges);
  assert.equal(returned, edges);
  assert.equal(edges.length, edgeCount);
  assert.equal(edges[0].ordinal, 0);
  assert.equal(edges.at(-1).ordinal, edgeCount - 1);
  assert.throws(
    () => deduplicateTemporalEdgesInPlace([
      { edgeId: "collision", value: 1 },
      { edgeId: "collision", value: 2 },
    ]),
    { code: "TEMPORAL_EDGE_IDENTITY_COLLISION" },
  );
});

test("builds deterministic Git-independent temporal provenance with multiple parents", async (t) => {
  const sourceFiles = [
    {
      path: "src/service.mjs",
      digest: "a".repeat(64),
      language: "javascript",
      classification: "source",
      symbols: [{ name: "serve", kind: "function", line: 1 }],
    },
    {
      path: "test/service.test.mjs",
      digest: "b".repeat(64),
      language: "javascript",
      classification: "test",
      symbols: [{ name: "checksService", kind: "function", line: 2 }],
    },
  ];
  const first = buildTemporalProvenanceGraph({ projectId: "project-temporal-test", files: sourceFiles });
  const reordered = buildTemporalProvenanceGraph({ projectId: "project-temporal-test", files: [...sourceFiles].reverse() });
  assert.equal(first.graphSnapshotId, reordered.graphSnapshotId);
  assert.equal(first.summary.testRevisionCount, 1);
  assert.equal(first.nodes.every((node) => node.instructionAuthority === false && node.promotionAuthority === false), true);
  assert.equal(first.edges.every((edge) => edge.sourceSnapshotId === first.sourceSnapshotId), true);

  const firstFile = first.nodes.find((node) => node.kind === "File" && node.path === "src/service.mjs");
  const firstFileRevision = first.nodes.find((node) => node.kind === "FileRevision" && node.path === "src/service.mjs");
  const firstSymbol = first.nodes.find((node) => node.kind === "Symbol" && node.name === "serve");
  const firstSymbolRevision = first.nodes.find((node) => node.kind === "SymbolRevision" && node.name === "serve");
  const changedFiles = clone(sourceFiles);
  changedFiles[0].digest = "c".repeat(64);
  changedFiles[0].symbols[0].line = 8;
  const changed = buildTemporalProvenanceGraph({
    projectId: "project-temporal-test",
    files: changedFiles,
    parentSourceSnapshotIds: [first.sourceSnapshotId, `source-snapshot-${"f".repeat(24)}`, first.sourceSnapshotId],
    revisionParentIds: {
      [firstFile.nodeId]: [firstFileRevision.nodeId],
      [firstSymbol.nodeId]: [firstSymbolRevision.nodeId],
    },
  });
  assert.deepEqual(changed.parentSourceSnapshotIds, [first.sourceSnapshotId, `source-snapshot-${"f".repeat(24)}`].sort());
  assert.equal(changed.summary.sourceParentCount, 2);
  assert.equal(changed.summary.revisionParentCount, 2);
  assert.equal(changed.nodes.find((node) => node.kind === "File" && node.path === "src/service.mjs").nodeId, firstFile.nodeId);
  assert.notEqual(changed.nodes.find((node) => node.kind === "FileRevision" && node.path === "src/service.mjs").nodeId, firstFileRevision.nodeId);
  assert.equal(changed.nodes.find((node) => node.kind === "Symbol" && node.name === "serve").nodeId, firstSymbol.nodeId);
  assert.notEqual(changed.nodes.find((node) => node.kind === "SymbolRevision" && node.name === "serve").nodeId, firstSymbolRevision.nodeId);
  assert.equal(changed.edges.filter((edge) => edge.type === "PARENT_OF").length, 4);

  const queryA = queryTemporalProvenanceGraph(changed, {
    query: "src/service.mjs",
    relations: ["CURRENT_REVISION", "HAS_REVISION", "DECLARES"],
    depth: 2,
    maxNodes: 20,
    maxEdges: 40,
  });
  const queryB = queryTemporalProvenanceGraph(changed, {
    query: "src/service.mjs",
    relations: ["DECLARES", "HAS_REVISION", "CURRENT_REVISION"],
    depth: 2,
    maxNodes: 20,
    maxEdges: 40,
  });
  assert.equal(queryA.queryId, queryB.queryId);
  assert.equal(queryA.resultId, queryB.resultId);
  assert.equal(queryA.edges.every((edge) => ["CURRENT_REVISION", "HAS_REVISION", "DECLARES"].includes(edge.type)), true);
  assert.equal(queryA.traversalQuery.includeUnreviewedCandidates, false);
  const changedFile = changed.nodes.find((node) => node.kind === "File" && node.path === "src/service.mjs");
  const exact = queryTemporalProvenanceGraph(changed, {
    anchorIds: [changedFile.nodeId],
    expectedGraphSnapshotId: changed.graphSnapshotId,
    relations: ["CURRENT_REVISION", "HAS_REVISION", "DECLARES"],
    depth: 2,
    maxNodes: 20,
    maxEdges: 40,
  });
  assert.equal(exact.traversalQuery.anchorMode, "exact-head-proposed");
  assert.equal(exact.traversalQuery.normalizedQuery, "");
  assert.equal(exact.inclusion.find((item) => item.nodeId === changedFile.nodeId).reason, "exact-head-anchor");
  assert.throws(() => queryTemporalProvenanceGraph(changed, {
    query: "service",
    anchorIds: [changedFile.nodeId],
    expectedGraphSnapshotId: changed.graphSnapshotId,
  }), { code: "AMBIGUOUS_TEMPORAL_ANCHOR_MODE" });
  assert.throws(() => queryTemporalProvenanceGraph(changed, {
    anchorIds: [changedFile.nodeId],
    expectedGraphSnapshotId: first.graphSnapshotId,
  }), { code: "TEMPORAL_GRAPH_SNAPSHOT_MISMATCH" });
  assert.throws(() => queryTemporalProvenanceGraph(changed, {
    anchorIds: ["missing-exact-node"],
    expectedGraphSnapshotId: changed.graphSnapshotId,
  }), { code: "TEMPORAL_EXACT_ANCHOR_NOT_FOUND" });
  const wideLexicalGraph = buildTemporalProvenanceGraph({
    projectId: "project-wide-lexical-traversal",
    files: Array.from({ length: 40 }, (_, index) => ({
      path: `wide/component-${String(index).padStart(2, "0")}.mjs`,
      digest: crypto.createHash("sha256").update(`wide-${index}`).digest("hex"),
      language: "javascript",
      classification: "source",
      symbols: [],
    })),
  });
  const wideLexicalResult = queryTemporalProvenanceGraph(wideLexicalGraph, { query: "wide/component", depth: 0, maxNodes: 100, maxEdges: 0 });
  assert.equal(wideLexicalResult.traversalQuery.anchorMode, "lexical-discovery");
  assert.equal(wideLexicalResult.traversalQuery.anchorIds.length, 80);
  assert.doesNotThrow(() => buildPreparedTraversalRequest({ graph: wideLexicalGraph, result: wideLexicalResult }));
  const tampered = clone(changed);
  tampered.nodes.find((node) => node.kind === "File").path = "tampered.mjs";
  assert.throws(() => verifyTemporalProvenanceGraph(tampered), { code: "TEMPORAL_GRAPH_DIGEST_MISMATCH" });

  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "service.mjs"), "export function serve() { return true; }\n");
  fs.writeFileSync(path.join(root, "test", "service.test.mjs"), "export function checksService() { return true; }\n");
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const layout = inspectProject(root).storage;
  const indexed = await buildWorldModel({ root, parentSourceSnapshotIds: [first.sourceSnapshotId, `source-snapshot-${"e".repeat(24)}`] });
  assert.equal(indexed.snapshot.git.status, "not-a-git-repository");
  assert.equal(indexed.snapshot.temporalProvenanceGraph.summary.sourceParentCount, 2);
  const repeated = await buildWorldModel({ root, persist: false, parentSourceSnapshotIds: [first.sourceSnapshotId, `source-snapshot-${"e".repeat(24)}`] });
  assert.equal(repeated.snapshot.temporalProvenanceGraph.graphSnapshotId, indexed.snapshot.temporalProvenanceGraph.graphSnapshotId);
  const temporalQuery = (await queryWorldTemporalGraph({ root, query: "service.mjs", relations: ["HAS_REVISION", "CURRENT_REVISION"], depth: 1 }));
  assert.equal(temporalQuery.status, "current");
  assert.equal(temporalQuery.nodes.some((node) => node.kind === "FileRevision"), true);
  const mcpTemporal = await dispatchMcp({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "head_temporal_graph", arguments: { project_root: root, query: "service.mjs", depth: 1, node_limit: 30, edge_limit: 50 } },
  });
  assert.equal(mcpTemporal.result.structuredContent.graphSnapshotId, indexed.snapshot.temporalProvenanceGraph.graphSnapshotId);
  const indexedFile = indexed.snapshot.temporalProvenanceGraph.nodes.find((node) => node.kind === "File" && node.path === "src/service.mjs");
  const mcpExactTemporal = await dispatchMcp({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "head_temporal_graph", arguments: {
      project_root: root,
      exact_anchor_ids: [indexedFile.nodeId],
      expected_graph_snapshot_id: indexed.snapshot.temporalProvenanceGraph.graphSnapshotId,
      relation_types: ["HAS_REVISION", "CURRENT_REVISION"],
      depth: 1,
      node_limit: 30,
      edge_limit: 50,
    } },
  });
  assert.equal(mcpExactTemporal.result.structuredContent.traversalQuery.anchorMode, formatForVerifiedOwner(layout).value("exact-head-proposed"));
  const cliExactTemporal = (await runCommand([
    "world-temporal", root,
    "--anchor-ids", indexedFile.nodeId,
    "--graph-snapshot", indexed.snapshot.temporalProvenanceGraph.graphSnapshotId,
    "--relations", "HAS_REVISION,CURRENT_REVISION",
    "--depth", "1",
    "--limit", "30",
    "--edge-limit", "50",
  ]));
  assert.equal(cliExactTemporal.resultId, mcpExactTemporal.result.structuredContent.resultId);
});

test("materializes and queries temporal graphs through an authority-free replaceable adapter", async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "service.mjs"), "export function serve() { return true; }\n");
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const layout = inspectProject(root).storage;

  const memory = new InMemoryGraphProjectionAdapter({ adapterKind: "conformance-memory" });
  const indexed = await buildWorldModel({ root, graphProjectionAdapter: memory });
  const graph = indexed.snapshot.temporalProvenanceGraph;
  assert.equal(indexed.sourceAdapters.graphProjection.adapterKind, "conformance-memory");
  assert.equal(indexed.sourceAdapters.graphProjection.adapterVersion, GRAPH_PROJECTION_ADAPTER_VERSION);
  assert.equal(indexed.graphProjection.pointer.graphSnapshotId, graph.graphSnapshotId);
  assert.equal((await inspectWorldGraphProjection({ root, graphProjectionAdapter: memory })).status, "current");
  assert.equal((await inspectWorldGraphProjection({ root })).status, "not-materialized");

  const queryInput = { query: "service.mjs", relations: ["HAS_REVISION", "CURRENT_REVISION"], depth: 1, maxNodes: 30, maxEdges: 50 };
  const reference = queryTemporalProvenanceGraph(graph, queryInput);
  const throughMemory = (await queryWorldTemporalGraph({ root, graphProjectionAdapter: memory, ...queryInput }));
  const throughEmbeddedFallback = (await queryWorldTemporalGraph({ root, ...queryInput }));
  assert.equal(throughMemory.resultId, reference.resultId);
  assert.equal(throughMemory.resultHash, reference.resultHash);
  assert.equal(throughMemory.graphProjection.fallbackUsed, false);
  assert.equal(throughMemory.graphProjection.executionMode, "prepared-graph-projection-adapter");
  assert.equal(throughMemory.graphProjection.preparedTraversal.verificationMode, "memory-snapshot-reference");
  assert.equal(throughEmbeddedFallback.resultId, reference.resultId);
  assert.equal(throughEmbeddedFallback.graphProjection.fallbackUsed, true);
  assert.equal(throughEmbeddedFallback.graphProjection.fallbackReasonCode, "GRAPH_PROJECTION_NOT_MATERIALIZED");

  const capsuleThroughMemory = (await compileContext({ root, task: "Inspect service implementation", budget: 32_768, persist: false, graphProjectionAdapter: memory }));
  const capsuleThroughFallback = (await compileContext({ root, task: "Inspect service implementation", budget: 32_768, persist: false }));
  assert.equal(capsuleThroughMemory.capsule.capsuleId, capsuleThroughFallback.capsule.capsuleId);

  const conformance = (await verifyGraphProjectionAdapterConformance({
    projectRoot: root,
    storage: layout,
    graph,
    referenceAdapter: new LocalJsonGraphProjectionAdapter({ projectRoot: root, storage: layout }),
    candidateAdapter: new InMemoryGraphProjectionAdapter({ adapterKind: "conformance-candidate" }),
    queries: [{ name: "service-neighborhood", query: queryInput }],
  }));
  assert.match(conformance.conformanceReportId, /^graph-projection-conformance-[a-f0-9]{24}$/);
  assert.equal(conformance.cases[0].resultId, reference.resultId);
  assert.equal(conformance.semanticIdentity, "adapter-neutral");

  const authorityViolating = new InMemoryGraphProjectionAdapter({ adapterKind: "invalid-authority" });
  authorityViolating.describe = () => ({
    contract: "replaceable-rebuildable-derived-graph-projection",
    adapterKind: "invalid-authority",
    adapterVersion: GRAPH_PROJECTION_ADAPTER_VERSION,
    authority: "project-canon",
    rebuildable: false,
    uniqueAuthority: true,
    instructionAuthority: true,
    promotionAuthority: true,
    remote: false,
    durable: false,
  });
  await assert.rejects(((buildWorldModel({ root, graphProjectionAdapter: authorityViolating }))), { code: "INVALID_GRAPH_PROJECTION_AUTHORITY" });


  const mismatching = new InMemoryGraphProjectionAdapter({ adapterKind: "mismatching-query" });
  (await materializeGraphProjection({ projectRoot: root, storage: layout, graph, adapter: mismatching }));
  const mismatchingDescribe = mismatching.describe.bind(mismatching);
  mismatching.describe = () => {
    const { preparedTraversalProtocolVersion, preparedTraversalMode, ...legacy } = mismatchingDescribe();
    return legacy;
  };
  const originalQuery = mismatching.query.bind(mismatching);
  mismatching.query = async (graphSnapshotId, options) => {
    const result = await originalQuery(graphSnapshotId, options);
    return { ...result, truncated: !result.truncated };
  };
  (await assert.rejects(async () => (await queryGraphProjection({ projectRoot: root, storage: layout, graph, adapter: mismatching, query: queryInput })), { code: "GRAPH_PROJECTION_QUERY_MISMATCH" }));

  const preparedTampering = new InMemoryGraphProjectionAdapter({ adapterKind: "tampered-prepared-verification" });
  (await materializeGraphProjection({ projectRoot: root, storage: layout, graph, adapter: preparedTampering }));
  const originalPreparedQuery = preparedTampering.queryPrepared.bind(preparedTampering);
  preparedTampering.queryPrepared = async (request) => {
    const verification = await originalPreparedQuery(request);
    return { ...verification, nodeCount: verification.nodeCount + 1 };
  };
  (await assert.rejects(
    async () => (await queryGraphProjection({ projectRoot: root, storage: layout, graph, adapter: preparedTampering, query: queryInput })),
    { code: "PREPARED_TRAVERSAL_VERIFICATION_DIGEST_MISMATCH" },
  ));

  const tampered = new InMemoryGraphProjectionAdapter({ adapterKind: "tampered-snapshot" });
  (await materializeGraphProjection({ projectRoot: root, storage: layout, graph, adapter: tampered }));
  tampered.snapshots.get(graph.graphSnapshotId).summary.nodeCount += 1;
  (await assert.rejects(async () => (await inspectWorldGraphProjection({ root, graphProjectionAdapter: tampered })), { code: "TEMPORAL_GRAPH_DIGEST_MISMATCH" }));

  const mutating = new InMemoryGraphProjectionAdapter({ adapterKind: "mutating-write" });
  const writeSnapshot = mutating.writeSnapshot.bind(mutating);
  mutating.writeSnapshot = (graphSnapshotId, document) => {
    document.summary.nodeCount += 1;
    return writeSnapshot(graphSnapshotId, document);
  };
  (await assert.rejects(async () => (await materializeGraphProjection({ projectRoot: root, storage: layout, graph, adapter: mutating })), { code: "TEMPORAL_GRAPH_DIGEST_MISMATCH" }));
  verifyTemporalProvenanceGraph(graph);

  fs.appendFileSync(path.join(root, "src", "service.mjs"), "export class Worker {}\n");
  const rebuilt = await buildWorldModel({ root });
  assert.notEqual(rebuilt.snapshot.temporalProvenanceGraph.graphSnapshotId, graph.graphSnapshotId);
  (await assert.rejects(async () => (await queryWorldTemporalGraph({ root, graphProjectionAdapter: memory, ...queryInput })), { code: "GRAPH_PROJECTION_STALE" }));
  assert.equal((await inspectWorldGraphProjection({ root })).status, "current");
  assert.equal((await runCommand(["world-graph-status", root])).status, "current");

  const mcpStatus = await dispatchMcp({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "head_graph_projection_status", arguments: { project_root: root } },
  });
  assert.equal(mcpStatus.result.structuredContent.status, "current");
  assert.equal(mcpStatus.result.structuredContent.authority, "rebuildable-derived-projection-not-project-canon");
});

test("prepared traversal benchmark matches the reviewed fixture and rejects a different query", () => {
  const runBenchmark = (extra = []) => {
    const args = [path.join(pluginRoot, "scripts", "benchmark-prepared-traversal.mjs"), "--iterations", "3", ...extra];
    console.log(JSON.stringify({ event: "owned-benchmark-planned", parentPid: process.pid, command: [process.execPath, ...args], cwd: pluginRoot, ports: [] }));
    const execution = spawnSync(process.execPath, args, { cwd: pluginRoot, encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
    console.log(JSON.stringify({ event: "owned-benchmark-closed", pid: execution.pid, parentPid: process.pid, exitCode: execution.status, signal: execution.signal, ports: [] }));
    assert.ifError(execution.error);
    return execution;
  };
  const execution = runBenchmark();
  assert.equal(execution.status, 0, execution.stderr);
  const report = JSON.parse(execution.stdout);
  const expected = JSON.parse(fs.readFileSync(path.join(pluginRoot, "benchmarks", "prepared-traversal-v1", "expected.json"), "utf8"));
  for (const [key, value] of Object.entries(report.semanticIdentity)) assert.equal(value, expected[key], key);
  const cost = report.deterministicCost;
  assert.deepEqual([cost.nodeCount, cost.edgeCount, cost.expansionNodeCount, cost.expansionEdgeCount], [274, 480, 6, 7]);
  assert.deepEqual(cost.components, { identityEnvelopeBytes: 667, graphManifestBytes: 282, boundedExpansionBytes: 20024, graphSnapshotBytes: 437802, fullTopologyRecordsBytes: 430794 });
  for (const key of ["preparedQueryBytes", "fullReloadBaselineBytes", "savedBytes", "reductionBasisPoints"]) assert.equal(cost[key], expected[key], key);
  assert.equal(report.authorityEffect, "none");
  assert.equal(report.diagnostics.timingSemantic, false);
  assert.equal(report.diagnostics.pointerReadOptimization.pointerReadCalls, 3);
  assert.equal(report.diagnostics.clientReceiptOptimization.locallyBuiltRequestReuseCount, 3);
  assert.deepEqual(report.safety, {
    queryPhaseReadOnly: true, persistentWrites: false, credentialsPersisted: false,
    fullSnapshotReads: 0, fullTopologyReads: 0, distinctValidReceiptReplayRejected: true, liveEnvironmentValidated: false,
  });
  const changed = runBenchmark(["--query", "src/component-001.mjs"]);
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /BENCHMARK_FIXTURE_IDENTITY_DRIFT/);
});

test("records deterministic prepared traversal cost without making latency semantic", () => {
  const graph = buildTemporalProvenanceGraph({
    projectId: "project-prepared-cost-test",
    files: Array.from({ length: 12 }, (_, index) => ({
      path: `src/cost-${index}.mjs`,
      digest: crypto.createHash("sha256").update(`cost-${index}`).digest("hex"),
      language: "javascript",
      classification: "source",
      symbols: [{ name: `cost${index}`, kind: "function", line: 1 }],
    })),
  });
  const query = { query: graph.nodes.find((node) => node.kind === "File").nodeId, depth: 1, maxNodes: 30, maxEdges: 50 };
  const result = queryTemporalProvenanceGraph(graph, query);
  const request = buildPreparedTraversalRequest({ graph, result });
  const first = buildPreparedTraversalCostEvidence({ graph, request });
  const repeated = buildPreparedTraversalCostEvidence({ graph, request });
  assert.deepEqual(first, repeated);
  assert.equal(first.savedBytes > 0, true);
  assert.equal(first.preparedQueryBytes < first.fullReloadBaselineBytes, true);
  assert.equal(first.semanticIdentityEffect, "none");
  assert.equal(JSON.stringify(first).includes("elapsed"), false);
  assert.equal(JSON.stringify(first).includes("latency"), false);
  verifyPreparedTraversalCostEvidence(first, { graph, request });
  assert.throws(
    () => verifyPreparedTraversalCostEvidence({ ...first, savedBytes: first.savedBytes + 1 }),
    { code: "INVALID_PREPARED_TRAVERSAL_COST_EVIDENCE" },
  );
  assert.throws(
    () => verifyPreparedTraversalCostEvidence({ ...first, protocol: { ...first.protocol, unexpected: true } }),
    { code: "INVALID_PREPARED_TRAVERSAL_COST_EVIDENCE" },
  );
});

class MockArcadeDbTransport {
  constructor({ failureCode = "", traversalFault = "", failCheckpointAfter = -1, storage = null } = {}) {
    this.storage = storage;
    this.failureCode = failureCode;
    this.traversalFault = traversalFault;
    this.failCheckpointAfter = failCheckpointAfter;
    this.checkpointFailureUsed = false;
    this.successfulCheckpointWrites = 0;
    this.snapshots = new Map();
    this.pointers = new Map();
    this.topologies = new Map();
    this.syncManifests = new Map();
    this.syncCheckpoints = new Map();
    this.appliedSyncBatchIds = [];
    this.resetCounters();
  }

  resetCounters() {
    this.readPointerCount = 0;
    this.readSnapshotCount = 0;
    this.readTopologyCount = 0;
    this.readTopologyManifestCount = 0;
    this.queryTopologyCount = 0;
  }

  describe() {
    return { protocol: "arcadedb-http-json", credentialsPersisted: false };
  }

  check() {
    if (!this.failureCode) return;
    const error = new Error("mock transport failure");
    error.code = this.failureCode;
    throw error;
  }

  ensureSchema() { this.check(); }
  ensureTopologySchema() { this.check(); }
  ensureSyncSchema() { this.check(); }
  ready() { this.check(); return true; }
  databaseExists() { this.check(); return true; }
  createDatabase() { this.check(); return true; }
  dropDatabase() { this.check(); return true; }
  readSchemaTypes() { this.check(); return arcadeDbGraphReservedSchemaFor(this.storage).map((type) => ({ name: type.name, type: type.type,
    properties: Object.entries(type.properties).map(([name, type]) => ({ name, type })),
    indexes: [{ properties: [...arcadeDbRequiredKeysFor(this.storage)[type.name]], unique: true }] })); }
  readPointer(projectId) { this.check(); this.readPointerCount += 1; return this.pointers.get(projectId) ?? null; }
  readSnapshot(projectId, id) { this.check(); this.readSnapshotCount += 1; return this.snapshots.get(`${projectId}:${id}`) ?? null; }
  writePointer(projectId, pointerJson) { this.check(); this.pointers.set(projectId, pointerJson); }
  writePointerCompareAndSwap(projectId, expectedPointerJson, pointerJson) {
    this.check();
    const current = this.pointers.get(projectId) ?? null;
    if (current !== expectedPointerJson) return false;
    this.pointers.set(projectId, pointerJson);
    return true;
  }
  writeSnapshot(projectId, id, documentJson) {
    this.check();
    const key = `${projectId}:${id}`;
    const created = !this.snapshots.has(key);
    if (created) this.snapshots.set(key, documentJson);
    return created;
  }
  listSnapshotIds(projectId) {
    this.check();
    return [...this.snapshots.keys()].filter((key) => key.startsWith(`${projectId}:`)).map((key) => key.slice(projectId.length + 1)).sort();
  }
  readTopology(projectId, graphSnapshotId) {
    this.check();
    this.readTopologyCount += 1;
    const value = this.topologies.get(`${projectId}:${graphSnapshotId}`);
    return value == null ? null : JSON.parse(JSON.stringify(value));
  }
  readTopologyManifest(projectId, graphSnapshotId) {
    this.check();
    this.readTopologyManifestCount += 1;
    const value = this.topologies.get(`${projectId}:${graphSnapshotId}`)?.topologyJson ?? null;
    if (value == null || this.traversalFault !== "manifest") return value;
    const tampered = JSON.parse(value);
    tampered.nodeCount += 1;
    return JSON.stringify(tampered);
  }
  readSyncManifest(projectId, syncId) {
    this.check();
    return this.syncManifests.get(`${projectId}:${syncId}`) ?? null;
  }
  writeSyncManifest(projectId, syncId, syncJson) {
    this.check();
    const key = `${projectId}:${syncId}`;
    const existing = this.syncManifests.get(key);
    if (existing != null && existing !== syncJson) throw Object.assign(new Error("sync manifest conflict"), { code: "ARCADEDB_INCREMENTAL_SYNC_MANIFEST_CONFLICT" });
    this.syncManifests.set(key, syncJson);
    return existing == null;
  }
  readSyncCheckpoints(projectId, syncId) {
    this.check();
    const prefix = `${projectId}:${syncId}:`;
    return [...this.syncCheckpoints.entries()].filter(([key]) => key.startsWith(prefix)).map(([, value]) => value).sort();
  }
  writeSyncCheckpoint(projectId, syncId, batchId, checkpointJson) {
    this.check();
    if (!this.checkpointFailureUsed && this.failCheckpointAfter >= 0
      && this.successfulCheckpointWrites >= this.failCheckpointAfter) {
      this.checkpointFailureUsed = true;
      throw Object.assign(new Error("mock checkpoint transport interruption"), { code: "ARCADEDB_TRANSPORT_UNAVAILABLE" });
    }
    const key = `${projectId}:${syncId}:${batchId}`;
    const existing = this.syncCheckpoints.get(key);
    if (existing != null && existing !== checkpointJson) throw Object.assign(new Error("sync checkpoint conflict"), { code: "ARCADEDB_INCREMENTAL_SYNC_CHECKPOINT_CONFLICT" });
    this.syncCheckpoints.set(key, checkpointJson);
    if (existing == null) this.successfulCheckpointWrites += 1;
    return existing == null;
  }
  applySyncBatch(projectId, manifest, batch) {
    this.check();
    const targetKey = `${projectId}:${manifest.targetGraphSnapshotId}`;
    const target = this.topologies.get(targetKey) || { topologyJson: null, nodeJsons: [], edgeJsons: [] };
    const base = manifest.baseGraphSnapshotId == null
      ? { nodeJsons: [], edgeJsons: [] }
      : this.topologies.get(`${projectId}:${manifest.baseGraphSnapshotId}`) || { nodeJsons: [], edgeJsons: [] };
    const field = batch.recordKind === "node" ? "nodeJsons" : "edgeJsons";
    const idField = batch.recordKind === "node" ? "nodeId" : "edgeId";
    const baseById = new Map(base[field].map((value) => {
      const record = JSON.parse(value);
      return [record[idField], record];
    }));
    const targetById = new Map(target[field].map((value) => {
      const record = JSON.parse(value);
      return [record[idField], record];
    }));
    for (const record of batch.records) {
      const sourceId = batch.recordKind === "node" ? record.sourceNodeId : record.sourceEdgeId;
      const source = baseById.get(sourceId || record[idField]);
      const value = batch.operation === "carry-forward"
        ? source
        : batch.operation === "rebase"
          ? { ...source, [idField]: record[idField], sourceSnapshotId: manifest.sourceSnapshotId }
          : record;
      if (!value) throw Object.assign(new Error("missing carry-forward source"), { code: "ARCADEDB_INCREMENTAL_SYNC_BASE_MISSING" });
      targetById.set(record[idField], JSON.parse(JSON.stringify(value)));
    }
    target[field] = [...targetById.values()].sort((left, right) => left[idField].localeCompare(right[idField])).map((value) => JSON.stringify(value));
    this.topologies.set(targetKey, target);
    this.appliedSyncBatchIds.push(batch.batchId);
    return true;
  }
  readSyncBatchRecords(projectId, graphSnapshotId, batch) {
    this.check();
    const topology = this.topologies.get(`${projectId}:${graphSnapshotId}`) || { nodeJsons: [], edgeJsons: [] };
    const field = batch.recordKind === "node" ? "nodeJsons" : "edgeJsons";
    const idField = batch.recordKind === "node" ? "nodeId" : "edgeId";
    const requested = new Set(batch.records.map((record) => record[idField]));
    return topology[field].filter((value) => requested.has(JSON.parse(value)[idField]));
  }
  writeTopology(projectId, graphSnapshotId, graph, topology) {
    this.check();
    const key = `${projectId}:${graphSnapshotId}`;
    const existing = this.topologies.get(key);
    if (!existing) this.topologies.set(key, {
      topologyJson: JSON.stringify(topology),
      nodeJsons: graph.nodes.map((node) => JSON.stringify(node)),
      edgeJsons: graph.edges.map((edge) => JSON.stringify(edge)),
    });
    else if (existing.topologyJson == null) existing.topologyJson = JSON.stringify(topology);
  }
  queryTopology(projectId, graphSnapshotId, { anchorIds, maxDepth, maxRecords }) {
    this.check();
    this.queryTopologyCount += 1;
    const topology = this.topologies.get(`${projectId}:${graphSnapshotId}`);
    const nodes = (topology?.nodeJsons || []).map((value) => JSON.parse(value));
    const edges = (topology?.edgeJsons || []).map((value) => JSON.parse(value));
    const nodesById = new Map(nodes.map((node) => [node.nodeId, node]));
    const visitedNodes = new Set(anchorIds);
    const visitedEdges = new Set();
    const records = anchorIds.map((nodeId) => ({
      recordType: formatForVerifiedOwner(this.storage).kind("HeadAgentGraphNode"),
      nodeJson: JSON.stringify(nodesById.get(nodeId)),
      edgeJson: null,
      recordDepth: 0,
    }));
    let frontier = new Set(anchorIds);
    for (let level = 0; level < maxDepth && frontier.size; level += 1) {
      const next = new Set();
      for (const edge of edges) {
        if ((!frontier.has(edge.from) && !frontier.has(edge.to)) || visitedEdges.has(edge.edgeId)) continue;
        visitedEdges.add(edge.edgeId);
        records.push({
          recordType: formatForVerifiedOwner(this.storage).kind("HeadAgentGraphEdge"),
          nodeJson: null,
          edgeJson: JSON.stringify(edge),
          recordDepth: (level * 2) + 1,
        });
        for (const nodeId of [edge.from, edge.to]) if (!visitedNodes.has(nodeId)) next.add(nodeId);
      }
      for (const node of nodes) {
        if (!next.has(node.nodeId)) continue;
        visitedNodes.add(node.nodeId);
        records.push({
          recordType: formatForVerifiedOwner(this.storage).kind("HeadAgentGraphNode"),
          nodeJson: JSON.stringify(node),
          edgeJson: null,
          recordDepth: (level + 1) * 2,
        });
      }
      frontier = next;
    }
    if (this.traversalFault === "missing") records.pop();
    if (this.traversalFault === "forged" && records.length) {
      const forged = { ...records[0], nodeJson: JSON.stringify({ ...JSON.parse(records[0].nodeJson), nodeId: "forged-node" }) };
      records[0] = forged;
    }
    return {
      protocolVersion: "0.1.0",
      graphSnapshotId,
      anchorIds: [...anchorIds],
      maxDepth,
      maxRecords,
      truncated: this.traversalFault === "truncated" || records.length > maxRecords,
      records: records.slice(0, maxRecords),
    };
  }
}

test("activates an ArcadeDB projection only after adapter-neutral conformance and keeps local recovery", async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "service.mjs"), "export function serve() { return true; }\n");
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  const onboarding = await startOnboarding({
    root,
    mode: "existing",
    storage: {
      mode: "graphdb",
      endpoint: "https://graph.example.test",
      database: "head_agent",
      secretReferenceNames: { username: "HEAD_GRAPHDB_USERNAME", password: "HEAD_GRAPHDB_PASSWORD" },
    },
  });
  assert.equal(onboarding.storageSelection.graphdb.capabilityStatus, "pending-unverified-adapter");
  assert.equal((await runCommand(["help"])).commands.includes("lode-agent world-graph-remote-activate <project>"), false);
  assert.equal((await runCommand(["help"])).surface, "light-default");
  assert.equal((await runCommand(["help"])).laneRecommendationRequired, false);
  assert.equal((await runCommand(["help-all"])).commands.includes("lode-agent world-graph-remote-activate <project>"), true);
  assert.equal((await runCommand(["help-all"])).surface, "ordinary-complete");
  assert.equal(mcpTools.some((tool) => tool.name === "lode_graphdb_projection_status"), true);
  assert.equal(mcpTools.some((tool) => tool.name === "lode_graphdb_database_initialize"), true);
  assert.equal(mcpTools.some((tool) => tool.name === "lode_graphdb_projection_activate"), true);
  assert.equal(inspectArcadeDbGraphProjectionActivation({ projectRoot: root, storage }).status, "pending-activation");

  const transport = new MockArcadeDbTransport({ storage });
  const preActivationGraph = (await inspectWorldModel({ root })).snapshot.temporalProvenanceGraph;
  transport.topologies.set(`${onboarding.storageSelection.projectId}:${preActivationGraph.graphSnapshotId}`, {
    topologyJson: null,
    nodeJsons: [JSON.stringify(preActivationGraph.nodes[0])],
    edgeJsons: [],
  });
  const initializeWithoutConfirmation = await dispatchMcp({
    jsonrpc: "2.0",
    id: "graphdb-initialize-rejected",
    method: "tools/call",
    params: { name: "head_graphdb_database_initialize", arguments: { project_root: root } },
  }, { graphDbTransport: transport });
  assert.match(initializeWithoutConfirmation.error.message, /explicit user confirmation/i);

  const initializedResponse = await dispatchMcp({
    jsonrpc: "2.0",
    id: "graphdb-initialize",
    method: "tools/call",
    params: {
      name: "head_graphdb_database_initialize",
      arguments: { project_root: root, confirm_initialize: true },
    },
  }, { graphDbTransport: transport });
  assert.equal(initializedResponse.error, undefined);
  assert.equal(initializedResponse.result.structuredContent.status, "compatible-ready-for-activation");
  assert.equal(initializedResponse.result.structuredContent.action, "reused-compatible-database");

  const activateWithoutConfirmation = await dispatchMcp({
    jsonrpc: "2.0",
    id: "graphdb-activate-rejected",
    method: "tools/call",
    params: { name: "head_graphdb_projection_activate", arguments: { project_root: root } },
  }, { graphDbTransport: transport });
  assert.match(activateWithoutConfirmation.error.message, /explicit user confirmation/i);

  const partialBefore = JSON.stringify([...transport.topologies]);
  const partialResponse = await dispatchMcp({
    jsonrpc: "2.0", id: "graphdb-partial-unknown", method: "tools/call",
    params: { name: "head_graphdb_projection_activate", arguments: { project_root: root, confirm_remote_write: true } },
  }, { graphDbTransport: transport });
  assert.match(partialResponse.error.message, /incremental-snapshot-sync/i);
  assert.equal(JSON.stringify([...transport.topologies]), partialBefore, "partial effects must not be replayed");
  // Separate clean fixture path; production must not silently clear remote data.
  transport.topologies.delete(`${onboarding.storageSelection.projectId}:${preActivationGraph.graphSnapshotId}`);
  const activatedResponse = await dispatchMcp({
    jsonrpc: "2.0",
    id: "graphdb-activate",
    method: "tools/call",
    params: {
      name: "head_graphdb_projection_activate",
      arguments: { project_root: root, confirm_remote_write: true },
    },
  }, { graphDbTransport: transport });
  assert.equal(activatedResponse.error, undefined);
  const activated = activatedResponse.result.structuredContent;
  assert.equal(activated.status, "verified-active");
  assert.equal(activated.credentialsPersisted, false);
  assert.equal(activated.conformanceReport.semanticIdentity, "adapter-neutral");
  assert.equal(activated.conformanceReport.cases.length, 2);
  assert.equal(activated.conformanceReport.candidateAdapter.traversalMode, "server-expanded-client-canonicalized");
  assert.equal(activated.traversalMode, "server-expanded-client-canonicalized");
  assert.equal(activated.topology.traversalMode, "verified-topology-client-reference");
  assert.equal(activated.topology.nodeCount > 0, true);
  assert.equal(activated.topology.edgeCount >= 0, true);
  assert.equal(activated.incrementalSync.batchCount > 0, true);
  assert.equal(activated.incrementalSync.appliedBatchCount, activated.incrementalSync.batchCount);
  assert.equal(activated.incrementalSync.atomicPointerTransitionVerified, true);
  assert.equal(activated.incrementalSync.localMirrorVerified, true);
  assert.equal(JSON.stringify(activated).includes("HEAD_GRAPHDB_PASSWORD"), false);

  const interruptedTransport = new MockArcadeDbTransport({ storage, failCheckpointAfter: 1 });
  const interruptedAdapter = new ArcadeDbGraphProjectionAdapter({ storage,
    storageSelection: onboarding.storageSelection,
    transport: interruptedTransport,
    topologyRequired: true,
    incrementalSyncRequired: true,
  });
  (await assert.rejects(
    async () => (await interruptedAdapter.writeSnapshot(preActivationGraph.graphSnapshotId, preActivationGraph)),
    { code: "ARCADEDB_WRITE_OUTCOME_UNKNOWN" },
  ));
  assert.equal(interruptedTransport.readPointer(onboarding.storageSelection.projectId), null);
  const resumedAdapter = new ArcadeDbGraphProjectionAdapter({ storage,
    storageSelection: onboarding.storageSelection,
    transport: interruptedTransport,
    topologyRequired: true,
    incrementalSyncRequired: true,
  });
  (await resumedAdapter.writeSnapshot(preActivationGraph.graphSnapshotId, preActivationGraph));
  await resumedAdapter.writePointer(buildGraphProjectionPointer(preActivationGraph, inspectProject(root).storage));
  const resumedSync = resumedAdapter.takeCompletedIncrementalSync();
  assert.equal(resumedSync.syncState.resumedBatchCount >= 1, true);
  assert.equal(resumedSync.syncState.appliedBatchCount + resumedSync.syncState.resumedBatchCount, resumedSync.manifest.batchCount);

  const conflictTransport = new MockArcadeDbTransport({ storage });
  const conflictAdapter = new ArcadeDbGraphProjectionAdapter({ storage,
    storageSelection: onboarding.storageSelection,
    transport: conflictTransport,
    topologyRequired: true,
    incrementalSyncRequired: true,
  });
  (await conflictAdapter.writeSnapshot(preActivationGraph.graphSnapshotId, preActivationGraph));
  const externallyAdvancedPointer = buildGraphProjectionPointer(preActivationGraph, inspectProject(root).storage);
  conflictTransport.pointers.set(onboarding.storageSelection.projectId, JSON.stringify(externallyAdvancedPointer));
  await assert.rejects(
    () => conflictAdapter.writePointer(externallyAdvancedPointer),
    { code: "ARCADEDB_INCREMENTAL_SYNC_POINTER_CONFLICT" },
  );
  assert.equal(conflictTransport.readPointer(onboarding.storageSelection.projectId), JSON.stringify(externallyAdvancedPointer));

  const conflictingPartialTransport = new MockArcadeDbTransport({ storage });
  const conflictingNode = JSON.parse(JSON.stringify(preActivationGraph.nodes[0]));
  conflictingNode.freshness = "stale";
  conflictingPartialTransport.topologies.set(`${onboarding.storageSelection.projectId}:${preActivationGraph.graphSnapshotId}`, {
    topologyJson: null,
    nodeJsons: [JSON.stringify(conflictingNode)],
    edgeJsons: [],
  });
  const conflictingPartialAdapter = new ArcadeDbGraphProjectionAdapter({ storage,
    storageSelection: onboarding.storageSelection,
    transport: conflictingPartialTransport,
  });
  assert.throws(() => conflictingPartialAdapter.materializeTopology(preActivationGraph), { code: "ARCADEDB_GRAPH_TOPOLOGY_CONTENT_MISMATCH" });

  const configured = createActivatedArcadeDbGraphProjectionAdapter({ projectRoot: root, storage, transport });
  assert.ok(configured instanceof ActivatedArcadeDbGraphProjectionAdapter);
  const remoteStatus = (await inspectArcadeDbGraphProjectionStatus({ root, transport }));
  assert.equal(remoteStatus.status, "verified-active-current");
  assert.equal(remoteStatus.projection.adapter.adapterKind, "activated-arcadedb-with-local-mirror");
  assert.equal(remoteStatus.projection.adapter.fallbackUsed, false);
  assert.equal(remoteStatus.projection.adapter.topologyMode, "snapshot-scoped-vertex-edge-verified");
  assert.equal(remoteStatus.projection.adapter.traversalMode, "server-expanded-client-canonicalized");
  assert.equal(remoteStatus.traversalMode, "server-expanded-client-canonicalized");
  assert.equal(remoteStatus.topology.status, "verified-active");
  assert.equal(remoteStatus.incrementalSync.status, "verified-current");

  const graph = (await inspectWorldModel({ root })).snapshot.temporalProvenanceGraph;
  const query = { query: graph.nodes[0].nodeId, depth: 1, maxNodes: 50, maxEdges: 100 };
  const expected = queryTemporalProvenanceGraph(graph, query);
  transport.resetCounters();
  const remote = (await queryWorldTemporalGraph({ root, graphProjectionAdapter: configured, ...query }));
  assert.equal(remote.resultId, expected.resultId);
  assert.equal(remote.resultHash, expected.resultHash);
  assert.equal(remote.graphProjection.executionMode, "prepared-graph-projection-adapter");
  assert.equal(remote.graphProjection.preparedTraversal.verificationMode, "arcadedb-manifest-bounded-expansion");
  assert.equal(transport.readSnapshotCount, 0);
  assert.equal(transport.readPointerCount, 1);
  assert.equal(transport.readTopologyCount, 0);
  assert.equal(transport.readTopologyManifestCount, 1);
  assert.equal(transport.queryTopologyCount, 1);

  transport.readPreparedTraversalBatchCount = 0;
  transport.readPreparedTraversalBatch = function readPreparedTraversalBatch(projectId, graphSnapshotId, options) {
    this.readPreparedTraversalBatchCount += 1;
    return {
      topologyJson: this.readTopologyManifest(projectId, graphSnapshotId),
      traversal: this.queryTopology(projectId, graphSnapshotId, options),
    };
  };
  transport.resetCounters();
  const batchedRemote = (await queryWorldTemporalGraph({ root, graphProjectionAdapter: configured, ...query }));
  assert.equal(batchedRemote.resultId, expected.resultId);
  assert.equal(batchedRemote.resultHash, expected.resultHash);
  assert.equal(transport.readPreparedTraversalBatchCount, 1);
  assert.equal(batchedRemote.graphProjection.preparedTraversal.verificationMode, "arcadedb-manifest-bounded-expansion");

  for (const [traversalFault, code] of [
    ["missing", "ARCADEDB_SERVER_TRAVERSAL_COVERAGE_MISMATCH"],
    ["forged", "ARCADEDB_SERVER_TRAVERSAL_RESPONSE_MISMATCH"],
    ["truncated", "ARCADEDB_SERVER_TRAVERSAL_TRUNCATED"],
    ["manifest", "ARCADEDB_GRAPH_TOPOLOGY_DIGEST_MISMATCH"],
  ]) {
    const faultyTransport = new MockArcadeDbTransport({ storage, traversalFault });
    faultyTransport.snapshots = new Map(transport.snapshots);
    faultyTransport.pointers = new Map(transport.pointers);
    faultyTransport.topologies = new Map(transport.topologies);
    const faulty = createActivatedArcadeDbGraphProjectionAdapter({ projectRoot: root, storage, transport: faultyTransport });
    (await assert.rejects(async () => (await queryWorldTemporalGraph({ root, graphProjectionAdapter: faulty, ...query })), { code }));
  }

  const legacyClientMode = new ArcadeDbGraphProjectionAdapter({ storage,
    storageSelection: onboarding.storageSelection,
    transport,
    topologyRequired: true,
  });
  assert.equal(legacyClientMode.describe().traversalMode, "verified-topology-client-reference");
  assert.equal((await legacyClientMode.query(graph.graphSnapshotId, query)).resultId, expected.resultId);

  const repeated = (await activateArcadeDbGraphProjection({ root, transport }));
  assert.equal(repeated.topology.activationId, activated.topology.activationId);
  assert.equal(repeated.incrementalSync.batchCount, 0);
  assert.equal(repeated.incrementalSync.pointerAdvanced, false);

  const topologyKey = `${activated.projectId}:${graph.graphSnapshotId}`;
  const exactTopology = transport.topologies.get(topologyKey);
  transport.topologies.set(topologyKey, { ...exactTopology, nodeJsons: exactTopology.nodeJsons.slice(1) });
  (await assert.rejects(async () => (await inspectArcadeDbGraphProjectionStatus({ root, transport })), { code: "ARCADEDB_GRAPH_TOPOLOGY_CONTENT_MISMATCH" }));
  transport.topologies.set(topologyKey, exactTopology);

  const topologyReceipt = inspectArcadeDbGraphTopologyActivation({ projectRoot: root, storage, graph });
  const exactTopologyActivation = JSON.parse(fs.readFileSync(topologyReceipt.activationFile, "utf8"));
  fs.writeFileSync(topologyReceipt.activationFile, JSON.stringify({ ...exactTopologyActivation, nodeCount: exactTopologyActivation.nodeCount + 1 }));
  assert.throws(() => inspectArcadeDbGraphTopologyActivation({ projectRoot: root, storage, graph }), { code: "ARCADEDB_TOPOLOGY_ACTIVATION_DIGEST_MISMATCH" });
  fs.writeFileSync(topologyReceipt.activationFile, JSON.stringify(exactTopologyActivation));

  const unavailable = new ActivatedArcadeDbGraphProjectionAdapter({
    projectRoot: root, storage,
    storageSelection: onboarding.storageSelection,
    remoteAdapter: new ArcadeDbGraphProjectionAdapter({ storage,
      storageSelection: onboarding.storageSelection,
      transport: new MockArcadeDbTransport({ storage, failureCode: "ARCADEDB_TRANSPORT_UNAVAILABLE" }),
    }),
  });
  const fallback = (await queryWorldTemporalGraph({ root, graphProjectionAdapter: unavailable, ...query }));
  assert.equal(fallback.resultId, expected.resultId);
  assert.equal(fallback.graphProjection.adapter.fallbackUsed, true);
  assert.equal(fallback.graphProjection.adapter.fallbackReasonCode, "ARCADEDB_TRANSPORT_UNAVAILABLE");

  const rejected = new ActivatedArcadeDbGraphProjectionAdapter({
    projectRoot: root, storage,
    storageSelection: onboarding.storageSelection,
    remoteAdapter: new ArcadeDbGraphProjectionAdapter({ storage,
      storageSelection: onboarding.storageSelection,
      transport: new MockArcadeDbTransport({ storage, failureCode: "ARCADEDB_AUTHENTICATION_FAILED" }),
    }),
  });
  (await assert.rejects(async () => (await inspectWorldGraphProjection({ root, graphProjectionAdapter: rejected })), { code: "ARCADEDB_AUTHENTICATION_FAILED" }));

  fs.writeFileSync(path.join(root, "src", "topology-refresh.mjs"), "export const topologyRefresh = true;\n");
  const advancingAdapter = createActivatedArcadeDbGraphProjectionAdapter({ projectRoot: root, storage, transport });
  const advanced = await buildWorldModel({ root, graphProjectionAdapter: advancingAdapter });
  const advancedGraph = advanced.snapshot.temporalProvenanceGraph;
  const advancedTopology = inspectArcadeDbGraphTopologyActivation({ projectRoot: root, storage, graph: advancedGraph });
  assert.equal(advancedTopology.status, "verified-active");
  assert.equal(advancedTopology.activation.graphSnapshotId, advancedGraph.graphSnapshotId);
  assert.equal(transport.topologies.has(`${activated.projectId}:${advancedGraph.graphSnapshotId}`), true);
  assert.equal((await inspectArcadeDbGraphProjectionStatus({ root, transport })).status, "verified-active-current");
  const advancedSync = inspectArcadeDbIncrementalSyncReceipt({ projectRoot: root, storage, graph: advancedGraph });
  assert.equal(advancedSync.status, "verified-current");
  const advancedManifest = JSON.parse(transport.syncManifests.get(`${activated.projectId}:${advancedSync.receipt.syncId}`));
  assert.equal(advancedManifest.nodeDelta.carried.count + advancedManifest.nodeDelta.rebased.count > 0, true);
  assert.equal(advancedManifest.edgeDelta.carried.count + advancedManifest.edgeDelta.rebased.count > 0, true);
  assert.equal(advancedManifest.nodeDelta.added.count + advancedManifest.nodeDelta.changed.count < advancedGraph.nodes.length, true);

  const receipt = inspectArcadeDbGraphProjectionActivation({ projectRoot: root, storage });
  const conformance = JSON.parse(fs.readFileSync(receipt.conformanceFile, "utf8"));
  const tamperedConformance = JSON.parse(JSON.stringify(conformance));
  tamperedConformance.cases[0].resultHash = "0".repeat(64);
  fs.writeFileSync(receipt.conformanceFile, JSON.stringify(tamperedConformance));
  assert.throws(() => inspectArcadeDbGraphProjectionActivation({ projectRoot: root, storage }), { code: "GRAPH_PROJECTION_CONFORMANCE_DIGEST_MISMATCH" });
  fs.writeFileSync(receipt.conformanceFile, JSON.stringify(conformance));
  const tampered = JSON.parse(fs.readFileSync(receipt.activationFile, "utf8"));
  tampered.activationStatus = "authority";
  fs.writeFileSync(receipt.activationFile, JSON.stringify(tampered));
  assert.throws(() => inspectArcadeDbGraphProjectionActivation({ projectRoot: root, storage }), { code: "ARCADEDB_ACTIVATION_DIGEST_MISMATCH" });
});

test("renders deterministic Markdown projections and captures edits as non-authoritative candidates", async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "service.mjs"), "export function serve() { return true; }\n");
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const layout = inspectProject(root).storage;
  const indexed = await buildWorldModel({ root });
  const graph = indexed.snapshot.temporalProvenanceGraph;

  const rendered = buildMarkdownDocumentProjection(graph, layout);
  assert.match(rendered.documentProjectionId, /^document-projection-[a-f0-9]{24}$/);
  assert.equal(rendered.authority, "derived-human-view-only");
  assert.equal(rendered.instructionAuthority, false);
  assert.equal(rendered.promotionAuthority, false);
  assert.equal(rendered.documents.some((item) => item.relativePath === "index.md"), true);
  assert.equal(rendered.documents.some((item) => item.content.includes("not project canon")), true);

  const memory = new InMemoryMarkdownProjectionAdapter({ adapterKind: "conformance-memory-markdown" });
  const throughMemory = (await materializeWorldMarkdownProjection({ root, documentProjectionAdapter: memory }));
  assert.equal(throughMemory.projection.adapter.adapterVersion, DOCUMENT_PROJECTION_ADAPTER_VERSION);
  assert.equal(throughMemory.documentProjectionId, rendered.documentProjectionId);
  assert.equal((await inspectWorldMarkdownProjection({ root, documentProjectionAdapter: memory })).status, "current");
  assert.equal((await inspectWorldMarkdownProjection({ root })).status, "not-materialized");

  const conformance = verifyDocumentProjectionAdapterConformance({
    projectRoot: root,
    storage: layout,
    graph,
    referenceAdapter: new LocalMarkdownProjectionAdapter({ projectRoot: root, storage: layout }),
    candidateAdapter: new InMemoryMarkdownProjectionAdapter({ adapterKind: "candidate-memory-markdown" }),
  });
  assert.match(conformance.conformanceReportId, /^document-projection-conformance-[a-f0-9]{24}$/);
  assert.equal(conformance.documentProjectionId, rendered.documentProjectionId);
  assert.equal(conformance.semanticIdentity, "adapter-neutral");
  assert.equal((await inspectWorldMarkdownProjection({ root })).status, "current");
  assert.equal((await runCommand(["world-docs-status", root])).status, "current");
  assert.equal((await runCommand(["world-docs-build", root])).documentProjectionId, rendered.documentProjectionId);

  const mcpBuild = await dispatchMcp({
    jsonrpc: "2.0",
    id: 60,
    method: "tools/call",
    params: { name: "head_markdown_projection_build", arguments: { project_root: root } },
  });
  assert.equal(mcpBuild.result.structuredContent.documentProjectionId, rendered.documentProjectionId);
  assert.equal(mcpBuild.result.structuredContent.publishedPageCount, rendered.documents.length);

  const mcpStatus = await dispatchMcp({
    jsonrpc: "2.0",
    id: 61,
    method: "tools/call",
    params: { name: "head_markdown_projection_status", arguments: { project_root: root } },
  });
  assert.equal(mcpStatus.result.structuredContent.status, "current");
  assert.equal(mcpStatus.result.structuredContent.authority, "rebuildable-derived-human-view-not-project-canon");

  const authorityViolating = new InMemoryMarkdownProjectionAdapter({ adapterKind: "invalid-document-authority" });
  authorityViolating.describe = () => ({
    contract: "replaceable-rebuildable-derived-human-document-projection",
    adapterKind: "invalid-document-authority",
    adapterVersion: DOCUMENT_PROJECTION_ADAPTER_VERSION,
    formats: ["markdown"],
    authority: "project-canon",
    rebuildable: false,
    uniqueAuthority: true,
    instructionAuthority: true,
    promotionAuthority: true,
    publishedViewIsCanon: true,
    inboundEdits: "automatic-canon-mutation",
    remote: false,
    durable: false,
  });
  assert.throws(() => materializeMarkdownProjection({ projectRoot: root, storage: layout, graph, adapter: authorityViolating }), { code: "INVALID_DOCUMENT_PROJECTION_AUTHORITY" });

  const tampered = new InMemoryMarkdownProjectionAdapter({ adapterKind: "tampered-document-projection" });
  const tamperedResult = materializeMarkdownProjection({ projectRoot: root, storage: layout, graph, adapter: tampered });
  tampered.projections.get(tamperedResult.projection.documentProjectionId).summary.documentCount += 1;
  assert.throws(() => inspectMarkdownProjection({ projectRoot: root, storage: layout, graph, adapter: tampered }), { code: "DOCUMENT_PROJECTION_DIGEST_MISMATCH" });

  const mutating = new InMemoryMarkdownProjectionAdapter({ adapterKind: "mutating-publisher" });
  const originalPublish = mutating.publishDocuments.bind(mutating);
  mutating.publishDocuments = (documents, options) => {
    documents[0].content += "mutated\n";
    return originalPublish(documents, options);
  };
  assert.throws(() => materializeMarkdownProjection({ projectRoot: root, storage: layout, graph, adapter: mutating }), { code: "DOCUMENT_PROJECTION_PUBLISH_MISMATCH" });
  assert.equal(buildMarkdownDocumentProjection(graph, layout).documentProjectionId, rendered.documentProjectionId);

  const indexFile = path.join(root, layout.directory, "generated", "knowledge", "index.md");
  fs.appendFileSync(indexFile, "\nUser-proposed documentation change.\n");
  const removedDocument = rendered.documents.find((item) => item.relativePath.startsWith("nodes/"));
  fs.unlinkSync(path.join(root, layout.directory, "generated", "knowledge", ...removedDocument.relativePath.split("/")));
  fs.mkdirSync(path.join(root, layout.directory, "generated", "knowledge", "notes"), { recursive: true });
  fs.writeFileSync(path.join(root, layout.directory, "generated", "knowledge", "notes", "proposal.md"), "# Proposed note\n");
  const modified = (await inspectWorldMarkdownProjection({ root }));
  assert.equal(modified.status, "modified");
  assert.equal(modified.projection.candidateRequired, true);
  assert.deepEqual([...new Set(modified.projection.drift.map((item) => item.changeType))].sort(), ["added", "modified", "removed"]);
  (await assert.rejects(async () => (await materializeWorldMarkdownProjection({ root })), { code: "DOCUMENT_PROJECTION_UNREVIEWED_DRIFT" }));

  const captured = (await captureWorldMarkdownChanges({ root, persist: true }));
  assert.equal(captured.status, "captured");
  assert.match(captured.candidateSet.candidateSetId, /^document-change-candidate-set-[a-f0-9]{24}$/);
  assert.deepEqual([...new Set(captured.candidateSet.candidates.map((item) => item.changeType))].sort(), ["added", "modified", "removed"]);
  assert.equal(captured.candidateSet.requiresReviewDecision, true);
  assert.equal(captured.candidateSet.instructionAuthority, false);
  assert.equal(captured.candidateSet.promotionAuthority, false);
  assert.equal((await captureWorldMarkdownChanges({ root, persist: true })).candidateSet.candidateSetId, captured.candidateSet.candidateSetId);
  assert.equal(readWorldDocumentChangeCandidateSet({ root, candidateSetId: captured.candidateSet.candidateSetId }).candidateSet.candidateSetId, captured.candidateSet.candidateSetId);
  assert.equal((await runCommand(["world-docs-candidates", root, "--candidate-set", captured.candidateSet.candidateSetId])).candidateSet.candidateSetId, captured.candidateSet.candidateSetId);

  const mcpCandidate = await dispatchMcp({
    jsonrpc: "2.0",
    id: 62,
    method: "tools/call",
    params: { name: "head_document_change_candidates", arguments: { project_root: root, candidate_set_id: captured.candidateSet.candidateSetId } },
  });
  assert.equal(mcpCandidate.result.structuredContent.candidateSet.candidateSetId, captured.candidateSet.candidateSetId);

  const tamperedCandidateSet = clone(captured.candidateSet);
  tamperedCandidateSet.candidates[0].proposedContentHash = "f".repeat(64);
  fs.writeFileSync(captured.file, `${JSON.stringify(tamperedCandidateSet, null, 2)}\n`);
  assert.throws(() => readWorldDocumentChangeCandidateSet({ root, candidateSetId: captured.candidateSet.candidateSetId }), { code: "DOCUMENT_CHANGE_CANDIDATE_DIGEST_MISMATCH" });
  fs.writeFileSync(captured.file, `${JSON.stringify(captured.candidateSet, null, 2)}\n`);

  fs.writeFileSync(indexFile, rendered.documents.find((item) => item.relativePath === "index.md").content);
  fs.writeFileSync(path.join(root, layout.directory, "generated", "knowledge", ...removedDocument.relativePath.split("/")), removedDocument.content);
  fs.unlinkSync(path.join(root, layout.directory, "generated", "knowledge", "notes", "proposal.md"));
  assert.equal((await inspectWorldMarkdownProjection({ root })).status, "current");
  fs.appendFileSync(path.join(root, "src", "service.mjs"), "export class Worker {}\n");
  await buildWorldModel({ root });
  assert.equal((await inspectWorldMarkdownProjection({ root })).status, "stale");
});

test("promotes document edits only through explicit structured Product Canon review and reconciles rejected views", async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "service.mjs"), "export function serve() { return true; }\n");
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const layout = inspectProject(root).storage;
  const indexed = await buildWorldModel({ root });
  assert.equal(indexed.snapshot.git.status, "not-a-git-repository");
  const initialCanon = fs.readFileSync(path.join(root, layout.directory, "context", "product-model.json"), "utf8");
  const rendered = (await materializeWorldMarkdownProjection({ root }));
  const indexFile = path.join(root, layout.directory, "generated", "knowledge", "index.md");
  fs.appendFileSync(indexFile, "\nProposal: add an auditable document review feature.\n");
  const captured = (await captureWorldMarkdownChanges({ root, persist: true }));
  const resultingProductModel = {
    schemaVersion: 1,
    featureGroups: [{ key: "knowledge", name: "Knowledge projections", description: "Human-facing graph projections.", parentFeatureGroupKeys: [] }],
    capabilities: [{ key: "review-docs", name: "Review document changes", description: "Review document edits before Canon mutation." }],
    features: [{
      key: "document-change-review",
      name: "Document change review",
      description: "Turns explicitly reviewed document proposals into structured Product Canon.",
      featureGroupKeys: ["knowledge"],
      capabilityKeys: ["review-docs"],
      governedBy: [],
    }],
    requirements: [],
    constraints: [],
    decisions: [],
  };

  const reviewed = await reviewDocumentChanges({
    root,
    candidateSetId: captured.candidateSet.candidateSetId,
    disposition: "accept-all",
    resultingProductModel,
    rationale: "The user explicitly maps this proposal to a complete typed Product Model.",
    apply: false,
  });
  assert.equal(reviewed.status, "reviewed-awaiting-application");
  assert.equal(reviewed.reviewDecision.instructionAuthority, true);
  assert.equal(reviewed.reviewDecision.promotionAuthority, true);
  assert.equal(fs.readFileSync(path.join(root, layout.directory, "context", "product-model.json"), "utf8"), initialCanon);
  assert.equal((await inspectDocumentChangeReviewStatus({ root, candidateSetId: captured.candidateSet.candidateSetId })).status, "reviewed-awaiting-application");
  assert.equal(readDocumentChangeReviewDecision({ root, reviewDecisionId: reviewed.reviewDecision.reviewDecisionId }).resultingProductModelRevision.productModelId, reviewed.reviewDecision.resultingProductModelId);
  assert.equal((await runCommand(["world-docs-review-status", root, "--candidate-set", captured.candidateSet.candidateSetId])).status, "reviewed-awaiting-application");
  assert.equal((await runCommand(["world-docs-review-read", root, "--review", reviewed.reviewDecision.reviewDecisionId])).reviewDecision.reviewDecisionId, reviewed.reviewDecision.reviewDecisionId);
  const mcpReviewStatus = await dispatchMcp({
    jsonrpc: "2.0",
    id: 63,
    method: "tools/call",
    params: { name: "head_document_change_review_status", arguments: { project_root: root, candidate_set_id: captured.candidateSet.candidateSetId } },
  });
  assert.equal(mcpReviewStatus.result.structuredContent.status, "reviewed-awaiting-application");
  const mcpReview = await dispatchMcp({
    jsonrpc: "2.0",
    id: 64,
    method: "tools/call",
    params: { name: "head_document_change_review", arguments: { project_root: root, review_decision_id: reviewed.reviewDecision.reviewDecisionId } },
  });
  assert.equal(mcpReview.result.structuredContent.reviewDecision.reviewDecisionId, reviewed.reviewDecision.reviewDecisionId);

  const canonFile = path.join(root, layout.directory, "context", "product-model.json");
  const canonBeforeFaults = fs.readFileSync(canonFile, "utf8");
  const canonTemporary = `${canonFile}.tmp-${process.pid}`;
  const preexistingTemporary = "preexisting temporary owned by another operation\n";
  fs.writeFileSync(canonTemporary, preexistingTemporary, { flag: "wx" });
  // Another operation's old staging name neither blocks a unique new stage nor
  // permits cleanup of that unrelated file.
  assert.equal(fs.readFileSync(canonTemporary, "utf8"), preexistingTemporary);
  assert.equal(fs.readFileSync(canonFile, "utf8"), canonBeforeFaults);

  const realOpen = fs.openSync;
  const realWrite = fs.writeFileSync;
  let ownedDescriptor = null;
  let ownedTemporary = null;
  let partialWriteInjected = false;
  try {
    fs.openSync = function (file, flags) {
      const descriptor = realOpen.apply(this, arguments);
      if (path.dirname(path.resolve(String(file))) === path.dirname(canonFile)
        && path.basename(String(file)).startsWith(".product-model.json.") && flags === "wx") {
        ownedDescriptor = descriptor;
        ownedTemporary = String(file);
      }
      return descriptor;
    };
    fs.writeFileSync = function (file, data, options) {
      if (!partialWriteInjected && ownedDescriptor != null && file === ownedDescriptor) {
        partialWriteInjected = true;
        realWrite.call(fs, file, String(data).slice(0, 9), options);
        throw Object.assign(new Error("Injected partial Canon temporary-file write"), { code: "EIO" });
      }
      return realWrite.apply(this, arguments);
    };
    await assert.rejects(
      () => applyDocumentChangeReview({ root, reviewDecisionId: reviewed.reviewDecision.reviewDecisionId }),
      (error) => error.code === "EIO",
    );
  } finally {
    fs.openSync = realOpen;
    fs.writeFileSync = realWrite;
  }
  assert.equal(partialWriteInjected, true);
  assert.equal(fs.existsSync(ownedTemporary), false);
  assert.equal(fs.readFileSync(canonTemporary, "utf8"), preexistingTemporary);
  assert.equal(fs.readFileSync(canonFile, "utf8"), canonBeforeFaults);
  assert.equal((await inspectDocumentChangeReviewStatus({ root, candidateSetId: captured.candidateSet.candidateSetId })).status, "reviewed-awaiting-application");

  const applied = await applyDocumentChangeReview({ root, reviewDecisionId: reviewed.reviewDecision.reviewDecisionId });
  assert.equal(applied.status, "applied");
  assert.equal(fs.readFileSync(canonTemporary, "utf8"), preexistingTemporary);
  fs.unlinkSync(canonTemporary);
  assert.equal(applied.applicationReceipt.canonChanged, true);
  assert.equal(applied.applicationReceipt.canonMutation, "exact-user-reviewed-product-model");
  assert.equal(applied.applicationReceipt.activeRunMutation, "none");
  assert.equal(applied.worldModel.productModel.productModelId, reviewed.reviewDecision.resultingProductModelId);
  assert.equal(applied.worldModel.temporalProvenanceGraph.parentSourceSnapshotIds.includes(indexed.snapshot.temporalProvenanceGraph.sourceSnapshotId), true);
  assert.equal((await inspectWorldModel({ root })).status, "current");
  assert.equal((await inspectWorldMarkdownProjection({ root })).status, "current");
  assert.equal(applied.auditWorldModel.temporalProvenanceGraph.documentChangeProjection.applicationReceiptIds.includes(applied.applicationReceipt.applicationReceiptId), true);
  assert.equal(applied.auditWorldModel.temporalProvenanceGraph.nodes.some((node) => node.kind === "DocumentChangeReviewDecision" && node.nodeId === reviewed.reviewDecision.reviewDecisionId), true);
  assert.equal(applied.auditWorldModel.temporalProvenanceGraph.nodes.some((node) => node.kind === "DocumentChangeApplication" && node.nodeId === applied.applicationReceipt.applicationReceiptId), true);
  const hiddenDocumentCandidate = (await queryWorldTemporalGraph({
    root,
    query: captured.candidateSet.candidates[0].candidateId,
    freshness: ["historical"],
  }));
  assert.equal(hiddenDocumentCandidate.nodes.some((node) => node.kind === "DocumentChangeCandidate"), false);
  const visibleDocumentCandidate = (await queryWorldTemporalGraph({
    root,
    query: captured.candidateSet.candidates[0].candidateId,
    freshness: ["historical"],
    includeUnreviewedCandidates: true,
  }));
  assert.equal(visibleDocumentCandidate.nodes.some((node) => node.kind === "DocumentChangeCandidate"), true);
  const currentDocumentGraph = (await inspectWorldModel({ root })).snapshot.temporalProvenanceGraph;
  (await assert.rejects(async () => (await queryWorldTemporalGraph({
    root,
    anchorIds: [captured.candidateSet.candidates[0].candidateId],
    expectedGraphSnapshotId: currentDocumentGraph.graphSnapshotId,
    freshness: ["historical"],
    depth: 0,
  })), { code: "TEMPORAL_EXACT_ANCHOR_INELIGIBLE" }));
  const exactVisibleDocumentCandidate = (await queryWorldTemporalGraph({
    root,
    anchorIds: [captured.candidateSet.candidates[0].candidateId],
    expectedGraphSnapshotId: currentDocumentGraph.graphSnapshotId,
    freshness: ["historical"],
    includeUnreviewedCandidates: true,
    depth: 0,
  }));
  assert.equal(exactVisibleDocumentCandidate.nodes.some((node) => node.kind === "DocumentChangeCandidate"), true);
  assert.equal((await inspectDocumentChangeReviewStatus({ root, candidateSetId: captured.candidateSet.candidateSetId })).status, "applied");
  assert.equal(readDocumentChangeApplicationReceipt({ root, applicationReceiptId: applied.applicationReceipt.applicationReceiptId }).applicationReceipt.reviewDecisionId, reviewed.reviewDecision.reviewDecisionId);
  assert.equal((await runCommand(["world-docs-application-read", root, "--application", applied.applicationReceipt.applicationReceiptId])).applicationReceipt.applicationReceiptId, applied.applicationReceipt.applicationReceiptId);
  const mcpApplication = await dispatchMcp({
    jsonrpc: "2.0",
    id: 65,
    method: "tools/call",
    params: { name: "head_document_change_application", arguments: { project_root: root, application_receipt_id: applied.applicationReceipt.applicationReceiptId } },
  });
  assert.equal(mcpApplication.result.structuredContent.applicationReceipt.applicationReceiptId, applied.applicationReceipt.applicationReceiptId);
  assert.equal((await applyDocumentChangeReview({ root, reviewDecisionId: reviewed.reviewDecision.reviewDecisionId })).status, "already-applied");

  const appliedCanon = fs.readFileSync(path.join(root, layout.directory, "context", "product-model.json"), "utf8");
  fs.appendFileSync(indexFile, "\nProposal that the user rejects.\n");
  const rejectedCandidateSet = (await captureWorldMarkdownChanges({ root, persist: true })).candidateSet;
  const rejectionInput = path.join(root, layout.directory, "document-change-rejection-input.json");
  fs.writeFileSync(rejectionInput, `${JSON.stringify({
    candidateSetId: rejectedCandidateSet.candidateSetId,
    disposition: "reject",
    rationale: "The edit does not describe an intended Product Canon change.",
  }, null, 2)}\n`);
  const rejected = await runCommand(["world-docs-review", root, "--input", rejectionInput]);
  assert.equal(rejected.status, "rejected-and-reconciled");
  assert.equal(rejected.reviewDecision.promotionAuthority, false);
  assert.equal(rejected.applicationReceipt.canonChanged, false);
  assert.equal(rejected.applicationReceipt.canonMutation, "none");
  assert.equal(fs.readFileSync(path.join(root, layout.directory, "context", "product-model.json"), "utf8"), appliedCanon);
  assert.equal((await inspectWorldMarkdownProjection({ root })).status, "current");
  assert.equal((await inspectDocumentChangeReviewStatus({ root, candidateSetId: rejectedCandidateSet.candidateSetId })).status, "rejected-and-reconciled");

  fs.appendFileSync(indexFile, "\nA later proposal.\n");
  const staleCandidateSet = (await captureWorldMarkdownChanges({ root, persist: true })).candidateSet;
  fs.appendFileSync(indexFile, "\nChanged after capture.\n");
  await assert.rejects(() => reviewDocumentChanges({
    root,
    candidateSetId: staleCandidateSet.candidateSetId,
    disposition: "reject",
    rationale: "This must fail because the published proposal changed after capture.",
  }), { code: "DOCUMENT_CHANGE_CANDIDATE_PUBLISHED_DRIFT" });

  const reviewFile = path.join(root, layout.directory, "document-changes", "review-decisions", `${reviewed.reviewDecision.reviewDecisionId}.json`);
  const reviewDocument = JSON.parse(fs.readFileSync(reviewFile, "utf8"));
  const tamperedReview = clone(reviewDocument);
  tamperedReview.rationale = "tampered";
  fs.writeFileSync(reviewFile, `${JSON.stringify(tamperedReview, null, 2)}\n`);
  assert.throws(() => readDocumentChangeReviewDecision({ root, reviewDecisionId: reviewed.reviewDecision.reviewDecisionId }), { code: "DOCUMENT_CHANGE_REVIEW_DIGEST_MISMATCH" });
  fs.writeFileSync(reviewFile, `${JSON.stringify(reviewDocument, null, 2)}\n`);

  const applicationFile = path.join(root, layout.directory, "document-changes", "applications", `${applied.applicationReceipt.applicationReceiptId}.json`);
  const applicationDocument = JSON.parse(fs.readFileSync(applicationFile, "utf8"));
  const tamperedApplication = clone(applicationDocument);
  tamperedApplication.applicationReceiptHash = "f".repeat(64);
  fs.writeFileSync(applicationFile, `${JSON.stringify(tamperedApplication, null, 2)}\n`);
  assert.throws(() => readDocumentChangeApplicationReceipt({ root, applicationReceiptId: applied.applicationReceipt.applicationReceiptId }), { code: "DOCUMENT_CHANGE_APPLICATION_DIGEST_MISMATCH" });
  fs.writeFileSync(applicationFile, `${JSON.stringify(applicationDocument, null, 2)}\n`);
});

test("applies explicit post-refresh Markdown policy without overwriting edited projections or changing authority", async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "service.mjs"), "export function serve() { return true; }\n");
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const layout = inspectProject(root).storage;
  const indexed = await buildWorldModel({ root });
  assert.equal(indexed.snapshot.git.status, "not-a-git-repository");
  const productCanonBefore = fs.readFileSync(path.join(root, layout.directory, "context", "product-model.json"), "utf8");

  const implicit = inspectPostRefreshProjectionPolicy({ root });
  assert.equal(implicit.status, "implicit-default");
  assert.equal(implicit.policy.mode, "manual");
  const manual = await refreshWorldModel({ root });
  assert.equal(manual.postRefreshProjection.status, "manual-deferred");
  assert.equal(fs.existsSync(path.join(root, layout.directory, "generated", "knowledge")), false);

  const policyInput = path.join(root, layout.directory, "automatic-markdown-policy.json");
  fs.writeFileSync(policyInput, `${JSON.stringify({ mode: "automatic" }, null, 2)}\n`);
  const configured = (await runCommand(["world-docs-policy-set", root, "--input", policyInput]));
  assert.equal(configured.policy.mode, "automatic");
  assert.equal(configured.policy.selection, "explicit-user-selection");
  assert.equal((await runCommand(["world-docs-policy-status", root])).policy.policyId, configured.policy.policyId);

  fs.appendFileSync(path.join(root, "src", "service.mjs"), "export const refreshed = true;\n");
  const projected = await refreshWorldModel({ root, expectedChangedPaths: ["src/service.mjs"] });
  assert.equal(projected.status, "refreshed");
  assert.equal(projected.postRefreshProjection.status, "projected");
  assert.equal(projected.postRefreshProjection.receipt.policy.policyId, configured.policy.policyId);
  assert.equal(projected.postRefreshProjection.receipt.canonMutation, "none");
  assert.equal(projected.postRefreshProjection.receipt.activeRunMutation, "none");
  assert.equal((await inspectWorldMarkdownProjection({ root })).status, "current");
  const projectedRead = (await readPostRefreshProjectionReceipt({
    root,
    postRefreshProjectionReceiptId: projected.postRefreshProjection.receipt.postRefreshProjectionReceiptId,
  }));
  assert.equal(projectedRead.refresh.receipt.refreshReceiptId, projected.receipt.refreshReceiptId);
  assert.equal(projectedRead.projection.graphSnapshotId, projected.receipt.next.graphSnapshotId);
  assert.equal((await runCommand(["world-docs-refresh-status", root])).status, "projected");
  assert.equal((await runCommand(["world-docs-refresh-read", root, "--receipt", projected.postRefreshProjection.receipt.postRefreshProjectionReceiptId])).receipt.postRefreshProjectionReceiptId, projected.postRefreshProjection.receipt.postRefreshProjectionReceiptId);

  const mcpStatus = await dispatchMcp({
    jsonrpc: "2.0",
    id: 63,
    method: "tools/call",
    params: { name: "head_post_refresh_projection_status", arguments: { project_root: root } },
  });
  assert.equal(mcpStatus.result.structuredContent.status, "projected");
  const mcpReceipt = await dispatchMcp({
    jsonrpc: "2.0",
    id: 64,
    method: "tools/call",
    params: {
      name: "head_post_refresh_projection_receipt",
      arguments: {
        project_root: root,
        post_refresh_projection_receipt_id: projected.postRefreshProjection.receipt.postRefreshProjectionReceiptId,
      },
    },
  });
  assert.equal(mcpReceipt.result.structuredContent.receipt.refresh.refreshReceiptId, projected.receipt.refreshReceiptId);

  const indexFile = path.join(root, layout.directory, "generated", "knowledge", "index.md");
  const projectedIndex = fs.readFileSync(indexFile, "utf8");
  const editedIndex = `${projectedIndex}\nUser-authored projection proposal.\n`;
  fs.writeFileSync(indexFile, editedIndex);
  fs.appendFileSync(path.join(root, "src", "service.mjs"), "export const changedAgain = true;\n");
  const blocked = await refreshWorldModel({ root, expectedChangedPaths: ["src/service.mjs"] });
  assert.equal(blocked.status, "refreshed");
  assert.equal(blocked.postRefreshProjection.status, "blocked-edited-view");
  assert.equal(blocked.postRefreshProjection.receipt.outcome.candidateSetId !== null, true);
  assert.equal(fs.readFileSync(indexFile, "utf8"), editedIndex);
  assert.equal((await inspectWorldMarkdownProjection({ root })).status, "modified");
  const blockedRead = (await readPostRefreshProjectionReceipt({
    root,
    postRefreshProjectionReceiptId: blocked.postRefreshProjection.receipt.postRefreshProjectionReceiptId,
  }));
  assert.equal(blockedRead.candidateSet.requiresReviewDecision, true);
  assert.equal(blockedRead.candidateSet.instructionAuthority, false);
  assert.equal(blockedRead.candidateSet.promotionAuthority, false);

  fs.writeFileSync(indexFile, projectedIndex);
  const recovered = await refreshWorldModel({ root });
  assert.equal(recovered.status, "unchanged");
  assert.equal(recovered.postRefreshProjection.status, "projected");
  assert.equal((await inspectWorldMarkdownProjection({ root })).status, "current");
  assert.equal(fs.readFileSync(path.join(root, layout.directory, "context", "product-model.json"), "utf8"), productCanonBefore);
  assert.equal((await inspectPostRefreshProjectionStatus({ root })).receipt.canonMutation, "none");

  fs.appendFileSync(path.join(root, "src", "service.mjs"), "export const triggeredProjection = true;\n");
  const triggered = await processRefreshTriggerBatch({
    root,
    sourceKind: "ci",
    events: [{ kind: "project-signal", operation: "build", path: null, evidenceId: "ci-post-refresh-projection-0001" }],
  });
  assert.equal(triggered.delivery.projectionDisposition.documents.status, "projected");
  const triggeredRead = (await readRefreshTriggerDelivery({ root, triggerDeliveryId: triggered.delivery.triggerDeliveryId }));
  assert.equal(triggeredRead.postRefreshProjection.receipt.refresh.refreshReceiptId, triggered.refresh.receipt.refreshReceiptId);
  assert.equal((await inspectWorldMarkdownProjection({ root })).status, "current");

  const storedPolicy = fs.readFileSync(configured.policyFile, "utf8");
  const tamperedPolicy = JSON.parse(storedPolicy);
  tamperedPolicy.safeguards.editedDocuments = "overwrite-silently";
  fs.writeFileSync(configured.policyFile, `${JSON.stringify(tamperedPolicy, null, 2)}\n`);
  fs.appendFileSync(path.join(root, "src", "service.mjs"), "export const policyFailureStillRefreshes = true;\n");
  const failedPolicy = await refreshWorldModel({ root, expectedChangedPaths: ["src/service.mjs"] });
  assert.equal(failedPolicy.status, "refreshed");
  assert.equal(failedPolicy.postRefreshProjection.status, "failed");
  assert.equal(failedPolicy.postRefreshProjection.receipt.policy, null);
  assert.equal((await inspectPostRefreshProjectionStatus({ root })).policy.status, "invalid");
  assert.equal((await inspectWorldMarkdownProjection({ root })).status, "stale");
  fs.writeFileSync(configured.policyFile, storedPolicy);
  const policyRecovered = await refreshWorldModel({ root });
  assert.equal(policyRecovered.status, "unchanged");
  assert.equal(policyRecovered.postRefreshProjection.status, "projected");
  assert.equal((await inspectWorldMarkdownProjection({ root })).status, "current");

  const tamperedFile = policyRecovered.postRefreshProjection.receiptFile;
  const tampered = JSON.parse(fs.readFileSync(tamperedFile, "utf8"));
  tampered.outcome.reasonCode = "SILENTLY_PROMOTE_DOCUMENT_EDIT";
  fs.writeFileSync(tamperedFile, `${JSON.stringify(tampered, null, 2)}\n`);
  (await assert.rejects(async () => (await readPostRefreshProjectionReceipt({ root, postRefreshProjectionReceiptId: policyRecovered.postRefreshProjection.receipt.postRefreshProjectionReceiptId })), { code: "POST_REFRESH_PROJECTION_RECEIPT_DIGEST_MISMATCH" }));
});

test("projects user-owned product canon into immutable temporal revisions and bounded context", async (t) => {
  const productDocument = {
    schemaVersion: 1,
    featureGroups: [{ key: "messaging", name: "Messaging", description: "User communication features" }],
    capabilities: [{ key: "deliver-message", name: "Deliver a message" }],
    features: [{
      key: "message-send",
      name: "Message delivery",
      description: "Send one user-authored message",
      featureGroupKeys: ["messaging"],
      capabilityKeys: ["deliver-message"],
      governedBy: [
        { kind: "Requirement", key: "message-persists" },
        { kind: "Constraint", key: "retain-input" },
        { kind: "Decision", key: "inline-payment" },
      ],
    }],
    requirements: [{ key: "message-persists", statement: "A submitted message is persisted before streaming begins." }],
    constraints: [{ key: "retain-input", statement: "A payment interruption must not discard the chat input." }],
    decisions: [{ key: "inline-payment", statement: "Keep credit purchase inside the chat flow.", status: "active" }],
  };
  const productModel = normalizeProductModelDocument(productDocument);
  const first = buildTemporalProvenanceGraph({
    projectId: "project-product-test",
    files: [],
    productModel,
    productEvidenceId: `evidence-${"a".repeat(24)}`,
  });
  assert.equal(first.summary.featureGroupCount, 1);
  assert.equal(first.summary.capabilityCount, 1);
  assert.equal(first.summary.featureCount, 1);
  assert.equal(first.summary.productRevisionCount, 6);
  assert.equal(first.nodes.filter((node) => node.authorityClass === "canon-projected").every((node) => node.instructionAuthority === false), true);
  const feature = first.nodes.find((node) => node.kind === "Feature");
  const featureRevision = first.nodes.find((node) => node.kind === "FeatureRevision");
  assert.ok(first.edges.some((edge) => edge.type === "REALIZES" && edge.from === feature.nodeId));
  assert.equal(first.edges.filter((edge) => edge.type === "GOVERNED_BY").length, 3);

  const renamedDocument = clone(productDocument);
  renamedDocument.features[0].name = "Send message";
  const renamed = buildTemporalProvenanceGraph({
    projectId: "project-product-test",
    files: [],
    productModel: normalizeProductModelDocument(renamedDocument),
    productEvidenceId: `evidence-${"b".repeat(24)}`,
    parentSourceSnapshotIds: [first.sourceSnapshotId],
    revisionParentIds: { [feature.nodeId]: [featureRevision.nodeId] },
  });
  assert.equal(renamed.nodes.find((node) => node.kind === "Feature").nodeId, feature.nodeId);
  assert.notEqual(renamed.nodes.find((node) => node.kind === "FeatureRevision").nodeId, featureRevision.nodeId);
  assert.ok(renamed.edges.some((edge) => edge.type === "PARENT_OF" && edge.from === featureRevision.nodeId));

  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const layout = inspectProject(root).storage;
  const productFile = path.join(root, layout.directory, "context", "product-model.json");
  assert.ok(fs.existsSync(productFile));
  fs.writeFileSync(productFile, `${JSON.stringify(productDocument, null, 2)}\n`);
  const indexed = await buildWorldModel({ root });
  const ownedProductModel = normalizeProductModelDocument(productDocument, layout);
  assert.equal(indexed.snapshot.productModel.productModelId, ownedProductModel.productModelId);
  assert.equal(indexed.snapshot.summary.featureCount, 1);
  assert.equal(indexed.snapshot.temporalProvenanceGraph.summary.productRevisionCount, 6);
  const query = (await queryWorldTemporalGraph({
    root,
    query: "Message delivery",
    relations: ["CONTAINS", "REALIZES", "GOVERNED_BY", "HAS_REVISION", "CURRENT_REVISION"],
    depth: 2,
  }));
  assert.ok(query.nodes.some((node) => node.kind === "FeatureRevision" && node.semantic.name === "Message delivery"));
  assert.ok(query.edges.some((edge) => edge.type === "REALIZES"));
  const capsule = (await compileContext({ root, task: "Change Message delivery without discarding chat input", budget: 32_768, persist: false }));
  assert.equal(capsule.capsule.productContext.length, 1, JSON.stringify(capsule.capsule.selection));
  assert.equal(capsule.capsule.productContext[0].productModelId, ownedProductModel.productModelId);
  assert.equal(capsule.capsule.productContext[0].instructionAuthority, false);

  const reordered = clone(productDocument);
  reordered.features[0].governedBy.reverse();
  fs.writeFileSync(productFile, JSON.stringify(reordered));
  assert.equal((await inspectWorldModel({ root })).status, "current");
  const changed = clone(productDocument);
  changed.features[0].description = "Changed product meaning";
  fs.writeFileSync(productFile, JSON.stringify(changed));
  const stale = (await inspectWorldModel({ root }));
  assert.equal(stale.status, "stale");
  assert.equal(stale.changes.productModelChanged, true);

  const invalid = clone(productDocument);
  invalid.features[0].capabilityKeys = ["unknown-capability"];
  assert.throws(() => normalizeProductModelDocument(invalid), { code: "UNKNOWN_PRODUCT_REFERENCE" });
});

test("enforces a deterministic authority-free ComputeAdapter and WorkerProtocol baseline", async () => {
  const operation = "repository.scan-manifest.v1";
  const producer = { name: "repository-scan", version: "0.1.0" };
  const operationHandler = (input) => ({
    files: [...input.files].sort((left, right) => left.path.localeCompare(right.path)),
    summary: { fileCount: input.files.length },
    instructionAuthority: false,
    promotionAuthority: false,
  });
  const reference = new JsReferenceComputeAdapter({ operations: { [operation]: operationHandler } });
  const candidate = new JsReferenceComputeAdapter({
    name: "javascript-conformance-candidate",
    operations: {
      [operation]: (input) => ({
        promotionAuthority: false,
        summary: { fileCount: input.files.length },
        instructionAuthority: false,
        files: [...input.files].sort((left, right) => left.path.localeCompare(right.path)),
      }),
    },
  });
  const input = {
    files: [
      { path: "z.mjs", digest: "b".repeat(64) },
      { path: "a.mjs", digest: "a".repeat(64) },
    ],
  };
  const first = await executeComputeOperation({ adapter: reference, operation, input, semanticProducer: producer });
  const repeated = await executeComputeOperation({ adapter: reference, operation, input: clone(input), semanticProducer: producer });
  assert.equal(first.request.requestId, repeated.request.requestId);
  assert.equal(first.response.resultDigest, repeated.response.resultDigest);
  assert.deepEqual(first.result.files.map((file) => file.path), ["a.mjs", "z.mjs"]);
  assert.equal(first.response.authorityEffect, "none");

  const report = await verifyComputeAdapterConformance({
    referenceAdapter: reference,
    candidateAdapter: candidate,
    fixtures: [{ name: "unordered-files", operation, input, semanticProducer: producer }],
  });
  assert.match(report.conformanceReportId, /^compute-conformance-[a-f0-9]{24}$/);
  assert.equal(report.fixtures[0].resultDigest, first.response.resultDigest);

  const tampered = clone(first.response);
  tampered.result.files[0].digest = "f".repeat(64);
  assert.throws(() => validateComputeResponse(first.request, tampered), { code: "COMPUTE_RESULT_MISMATCH" });
  const request = buildComputeRequest({ operation, input, semanticProducer: producer });
  const authorityEscalating = new JsReferenceComputeAdapter({
    operations: { [operation]: () => ({ instructionAuthority: true }) },
  });
  await assert.rejects(
    executeComputeOperation({ adapter: authorityEscalating, operation, input, semanticProducer: producer }),
    (error) => error.code === "COMPUTE_OPERATION_FAILED"
      && error.details.errors.some((item) => item.code === "COMPUTE_AUTHORITY_ESCALATION"),
  );
  const unsupported = new JsReferenceComputeAdapter({ operations: {} });
  await assert.rejects(
    executeComputeOperation({ adapter: unsupported, operation, input, semanticProducer: producer }),
    { code: "UNSUPPORTED_COMPUTE_OPERATION" },
  );
  assert.throws(
    () => buildComputeRequest({ operation, input, semanticProducer: producer, limits: { maxInputBytes: 2 } }),
    { code: "COMPUTE_INPUT_LIMIT" },
  );
  const slow = new JsReferenceComputeAdapter({
    operations: {
      [operation]: (_input, { signal }) => new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({ cancelled: true }), { once: true });
      }),
    },
  });
  await assert.rejects(
    executeComputeOperation({ adapter: slow, operation, input, semanticProducer: producer, limits: { timeoutMs: 10 } }),
    { code: "COMPUTE_TIMEOUT" },
  );
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    executeComputeOperation({ adapter: reference, operation, input, semanticProducer: producer, signal: cancelled.signal }),
    { code: "COMPUTE_CANCELLED" },
  );
  assert.equal(request.inputDigest, first.request.inputDigest);
});

test("routes deterministic repository scan v1 through a replaceable compute adapter", async (t) => {
  const corpus = path.join(pluginRoot, "benchmarks", "repository-scan-v1", "basic");
  const input = buildRepositoryScanInput({ projectRoot: corpus });
  const expected = JSON.parse(fs.readFileSync(path.join(pluginRoot, "benchmarks", "repository-scan-v1", "expected.json"), "utf8"));
  const first = scanRepositoryReference(input);
  const repeated = scanRepositoryReference(clone(input));
  assert.equal(first.scanId, repeated.scanId);
  assert.equal(first.scanHash, repeated.scanHash);
  assert.equal(first.scanId, expected.scanId);
  const legacyV03 = clone(first);
  legacyV03.protocol.version = "0.3.0";
  legacyV03.sourceAnalysisVersion = "0.2.0";
  for (const file of legacyV03.files) {
    file.symbols = [...new Map(file.symbols
      .map(({ name, kind, line }) => ({ name, kind, line }))
      .map((symbol) => [`${symbol.line}|${symbol.kind}|${symbol.name}`, symbol])).values()];
    file.semanticFacts.calls = file.semanticFacts.calls.map(({ callee, line }) => ({ callee, line }));
  }
  legacyV03.summary.symbolCount = legacyV03.files.reduce((count, file) => count + file.symbols.length, 0);
  const identifiedLegacyV03 = reidentify(legacyV03, {
    prefix: "repository-scan",
    idKey: "scanId",
    hashKey: "scanHash",
  });
  assert.doesNotThrow(() => validateRepositoryScanResult(identifiedLegacyV03));
  assert.equal(first.summary.fileCount, 10);
  const duplicateSymbols = first.files.find((file) => file.path === "fixtures/duplicate-symbols.mjs").symbols;
  assert.equal(duplicateSymbols.length, 2);
  assert.equal(duplicateSymbols.every((symbol) => symbol.identityAmbiguous === true), true);
  assert.equal(JSON.stringify(first).includes(corpus), false);
  assert.equal(first.files.every((file) => !path.isAbsolute(file.path) && file.instructionAuthority == null), true);
  assert.equal(first.files.find((file) => file.path === "src/main.mjs").semanticFacts.calls.some((call) => call.callee === "double"), true);

  const reference = createRepositoryScanReferenceAdapter();
  const candidate = new JsReferenceComputeAdapter({
    name: "repository-scan-candidate",
    operations: {
      [REPOSITORY_SCAN_OPERATION]: (candidateInput, { limits }) => scanRepositoryReference(candidateInput, { limits }),
    },
  });
  const report = await verifyComputeAdapterConformance({
    referenceAdapter: reference,
    candidateAdapter: candidate,
    fixtures: [{
      name: "repository-scan-basic",
      operation: REPOSITORY_SCAN_OPERATION,
      input,
      semanticProducer: REPOSITORY_SCAN_SEMANTIC_PRODUCER,
    }],
  });
  assert.match(report.fixtures[0].resultDigest, /^[a-f0-9]{64}$/);

  const tampered = clone(first);
  tampered.files[0].digest = "f".repeat(64);
  assert.throws(() => validateRepositoryScanResult(tampered), { code: "REPOSITORY_SCAN_DIGEST_MISMATCH" });
  assert.throws(() => scanRepositoryReference(input, { limits: { maxFiles: 1 } }), { code: "REPOSITORY_SCAN_FILE_LIMIT" });
  assert.throws(() => scanRepositoryReference(input, { limits: { maxTotalBytes: 1 } }), { code: "REPOSITORY_SCAN_TOTAL_BYTES_LIMIT" });
  assert.equal(scanRepositoryReference(input, { limits: { maxFileBytes: 1 } }).summary.fileCount, 0);

  const technicalRoot = temporaryProject();
  t.after(() => fs.rmSync(technicalRoot, { recursive: true, force: true }));
  for (const relative of ["src", ".uv-python/lib", ".uv-cache/archive", ".pytest_cache/state", ".generated-evidence/evidence", ".github", ".custom-source"]) fs.mkdirSync(path.join(technicalRoot, relative), { recursive: true });
  fs.writeFileSync(path.join(technicalRoot, "src", "app.py"), "value = 1\n");
  fs.writeFileSync(path.join(technicalRoot, ".uv-python", "lib", "runtime.py"), "value = 1\n");
  fs.writeFileSync(path.join(technicalRoot, ".uv-cache", "archive", "runtime.py"), "value = 1\n");
  fs.writeFileSync(path.join(technicalRoot, ".pytest_cache", "state", "cache.py"), "value = 1\n");
  fs.writeFileSync(path.join(technicalRoot, ".generated-evidence", "evidence", "copy.py"), "value = 1\n");
  fs.writeFileSync(path.join(technicalRoot, ".github", "workflow.yml"), "name: fixture\n");
  fs.writeFileSync(path.join(technicalRoot, ".custom-source", "module.py"), "value = 2\n");
  const unscopedScan = scanRepositoryReference(buildRepositoryScanInput({ projectRoot: technicalRoot }));
  assert.deepEqual(unscopedScan.files.map((file) => file.path), [".custom-source/module.py", ".generated-evidence/evidence/copy.py", ".github/workflow.yml", "src/app.py"]);
  const technicalScan = scanRepositoryReference(buildRepositoryScanInput({
    projectRoot: technicalRoot,
    sourceScope: buildRepositorySourceScope({ excludeRoots: [".generated-evidence"] }),
  }));
  assert.deepEqual(technicalScan.files.map((file) => file.path), [".custom-source/module.py", ".github/workflow.yml", "src/app.py"]);
  assert.equal(technicalScan.skipped.excludedDirectory, 3);
  assert.equal(technicalScan.skipped.outsideSourceScope, 1);

  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(corpus, root, { recursive: true });
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const referenceWorld = await buildWorldModel({ root, persist: false, computeAdapter: reference });
  const candidateWorld = await buildWorldModel({ root, persist: false, computeAdapter: candidate });
  assert.match(referenceWorld.snapshot.repositoryScan.scanId, /^repository-scan-[a-f0-9]{24}$/);
  assert.equal(referenceWorld.snapshot.repositoryScan.scanId, candidateWorld.snapshot.repositoryScan.scanId);
  assert.equal(referenceWorld.snapshot.worldModelId, candidateWorld.snapshot.worldModelId);
  assert.equal(referenceWorld.snapshot.semanticGraph.semanticGraphId, candidateWorld.snapshot.semanticGraph.semanticGraphId);
  assert.equal(referenceWorld.snapshot.semanticGraph.summary.callEdgeCount >= 2, true);
  assert.notEqual(referenceWorld.sourceDiagnostics.compute.adapterName, candidateWorld.sourceDiagnostics.compute.adapterName);
});

test("verifies Go worker distribution identity and discloses safe JavaScript fallback", async (t) => {
  const fixtureRoot = process.env.HEAD_AGENT_GO_WORKER_FIXTURE_ROOT;
  if (!fixtureRoot) {
    t.skip("HEAD_AGENT_GO_WORKER_FIXTURE_ROOT is required only for the dedicated native distribution verification lane");
    return;
  }
  const resolved = resolveVerifiedGoWorker({ pluginRoot: fixtureRoot });
  assert.match(resolved.manifest.manifestId, /^go-worker-manifest-[a-f0-9]{24}$/);
  assert.equal(resolved.workerRelativePath, "dist/windows-x64/lode-agent-worker.exe");

  const absentRoot = temporaryProject();
  t.after(() => fs.rmSync(absentRoot, { recursive: true, force: true }));
  assert.throws(() => resolveVerifiedGoWorker({ pluginRoot: absentRoot }), { code: "GO_WORKER_NOT_AVAILABLE" });
  const absentAdapter = new GoWorkerComputeAdapter({ pluginRoot: absentRoot });
  const absent = await executeComputeOperation({
    adapter: absentAdapter,
    operation: WORKER_HEALTH_OPERATION,
    input: WORKER_HEALTH_INPUT,
    semanticProducer: WORKER_HEALTH_SEMANTIC_PRODUCER,
  });
  assert.equal(absent.diagnostics.backend, "javascript-reference");
  assert.equal(absent.diagnostics.fallbackUsed, true);
  assert.equal(absent.diagnostics.fallbackReasonCode, "GO_WORKER_NOT_AVAILABLE");

  const corruptRoot = temporaryProject();
  t.after(() => fs.rmSync(corruptRoot, { recursive: true, force: true }));
  fs.cpSync(fixtureRoot, corruptRoot, { recursive: true });
  const corruptManifestFile = defaultGoWorkerManifestPath({ pluginRoot: corruptRoot });
  const corruptManifest = JSON.parse(fs.readFileSync(corruptManifestFile, "utf8"));
  const corruptBinary = path.join(path.dirname(corruptManifestFile), corruptManifest.binary.relativePath);
  fs.appendFileSync(corruptBinary, "tamper");
  assert.throws(() => resolveVerifiedGoWorker({ pluginRoot: corruptRoot }), { code: "GO_WORKER_BINARY_DIGEST_MISMATCH" });
  const corruptAdapter = new GoWorkerComputeAdapter({ pluginRoot: corruptRoot });
  const recovered = await executeComputeOperation({
    adapter: corruptAdapter,
    operation: WORKER_HEALTH_OPERATION,
    input: WORKER_HEALTH_INPUT,
    semanticProducer: WORKER_HEALTH_SEMANTIC_PRODUCER,
  });
  assert.equal(recovered.diagnostics.fallbackUsed, true);
  assert.equal(recovered.diagnostics.fallbackReasonCode, "GO_WORKER_BINARY_DIGEST_MISMATCH");
  const unsafeManifest = clone(corruptManifest);
  unsafeManifest.binary.relativePath = "../escape.exe";
  assert.throws(() => validateGoWorkerManifest(unsafeManifest), { code: "INVALID_GO_WORKER_MANIFEST" });

  const conformance = await verifyComputeAdapterConformance({
    referenceAdapter: createWorkerHealthReferenceAdapter(),
    candidateAdapter: absentAdapter,
    fixtures: [{
      name: "worker-health-fallback",
      operation: WORKER_HEALTH_OPERATION,
      input: WORKER_HEALTH_INPUT,
      semanticProducer: WORKER_HEALTH_SEMANTIC_PRODUCER,
    }],
  });
  assert.match(conformance.conformanceReportId, /^compute-conformance-[a-f0-9]{24}$/);
});

test("materializes adapter-neutral Git decision evidence without promoting commit messages", async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  fs.mkdirSync(path.join(root, ".git", "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(root, ".git", "refs", "heads", "main"), `${"d".repeat(40)}\n`);
  const commits = [
    {
      commit: "c".repeat(40),
      parents: [],
      authoredAt: "2026-08-16T10:00:00+09:00",
      committedAt: "2026-08-16T10:05:00+09:00",
      author: { name: "Architect" },
      refs: ["tag: v0.1"],
      subject: "Centralize authentication policy",
      body: "Keep session expiry under project policy instead of runtime defaults.",
    },
    {
      commit: "d".repeat(40),
      parents: ["c".repeat(40)],
      authoredAt: "2026-08-17T11:00:00+09:00",
      committedAt: "2026-08-17T11:05:00+09:00",
      author: { name: "Developer" },
      refs: ["HEAD -> main"],
      subject: "Document context compilation",
      body: "Explain evidence boundaries for runtime adapters.",
    },
  ];
  const firstAdapter = new MemoryGitHistoryAdapter({ adapterKind: "memory-a", commits });
  const secondAdapter = new MemoryGitHistoryAdapter({ adapterKind: "memory-b", commits: [...commits].reverse() });
  const first = await buildWorldModel({ root, persist: false, gitHistoryAdapter: firstAdapter });
  const second = await buildWorldModel({ root, persist: false, gitHistoryAdapter: secondAdapter });
  assert.equal(first.snapshot.worldModelId, second.snapshot.worldModelId);
  assert.equal(first.snapshot.gitDecisionHistory.historyId, second.snapshot.gitDecisionHistory.historyId);
  assert.equal(first.snapshot.gitDecisionHistory.coverage, "all-reachable-commits");
  assert.equal(first.snapshot.gitDecisionHistory.summary.commitCount, 2);
  assert.equal(first.snapshot.gitDecisionHistory.commits[0].commit, "d".repeat(40));
  assert.equal(first.snapshot.gitDecisionHistory.commits[0].trustBoundary, "evidence-not-instruction");

  const invalidAdapter = new MemoryGitHistoryAdapter({
    adapterKind: "authority-violating-history",
    commits,
    authority: "project-canon",
    rebuildable: false,
    uniqueAuthority: true,
  });
  await assert.rejects(((buildWorldModel({ root, persist: false, gitHistoryAdapter: invalidAdapter }))), { code: "INVALID_GIT_HISTORY_AUTHORITY" });

  const persisted = await buildWorldModel({ root, gitHistoryAdapter: firstAdapter });
  assert.equal(persisted.sourceAdapters.gitHistory.adapterKind, "memory-a");
  assert.equal((await inspectWorldModel({ root })).status, "current");
  const history = (await queryWorldHistory({ root, query: "authentication", limit: 10 }));
  assert.equal(history.commits.length, 1);
  assert.equal(history.commits[0].subject, "Centralize authentication policy");
  assert.equal(history.trustBoundary, "evidence-not-instruction");

  const capsule = (await compileContext({ root, task: "Why was authentication policy centralized?", budget: 32_768, persist: false }));
  assert.equal(capsule.capsule.snapshot.coverage, "curated-head-canon+repository-world-model-semantic+temporal-provenance-alpha+product-canon-projection-alpha+git-history-alpha");
  assert.equal(capsule.capsule.gitDecisionEvidence.some((item) => item.commit === "c".repeat(40)), true);
  assert.equal(capsule.capsule.gitDecisionEvidence[0].instructionAuthority, false);
  assert.equal(capsule.capsule.repositoryHistory.interpretation, "commit-messages-are-decision-evidence-not-promoted-decisions");

  const mcpHistory = await dispatchMcp({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "head_git_history", arguments: { project_root: root, query: "authentication", limit: 10 } },
  });
  assert.equal(mcpHistory.result.structuredContent.commits.length, 1);
  assert.equal(mcpHistory.result.structuredContent.commits[0].evidence.instructionAuthority, false);
});

test("indexes adapter-neutral external runtime observations without granting control authority", async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initializeProject({ root, pluginRoot, runtimes: ["codex", "opencode"] });
  const layout = inspectProject(root).storage;
  const exported = {
    schemaVersion: 1,
    kind: "HeadRuntimeStateExport",
    observedAt: "2026-08-18T12:00:00Z",
    observations: [
      {
        runtime: "codex",
        kind: "session",
        state: "active",
        externalId: "provider-session-sensitive-123",
        workspaceRoot: root,
        pid: 1234,
        parentPid: 1000,
        providerVersion: "26.814",
        commandDigest: "a".repeat(64),
        capabilities: ["resume", "inspect"],
      },
      {
        runtime: "opencode",
        kind: "worker",
        state: "idle",
        externalId: "worker-456",
        workspaceRoot: path.join(root, "other-worktree"),
        providerVersion: "1.0",
        capabilities: ["inspect"],
      },
    ],
  };
  const memoryA = new MemoryRuntimeStateAdapter({ adapterKind: "runtime-memory-a", exported });
  const memoryB = new MemoryRuntimeStateAdapter({ adapterKind: "runtime-memory-b", exported: { ...exported, observations: [...exported.observations].reverse() } });
  const first = await buildWorldModel({ root, persist: false, runtimeStateAdapter: memoryA });
  const second = await buildWorldModel({ root, persist: false, runtimeStateAdapter: memoryB });
  assert.equal(first.snapshot.worldModelId, second.snapshot.worldModelId);
  assert.equal(first.snapshot.externalRuntimeState.runtimeStateId, second.snapshot.externalRuntimeState.runtimeStateId);
  assert.equal(first.snapshot.externalRuntimeState.summary.observationCount, 2);
  assert.equal(first.snapshot.externalRuntimeState.observations.every((item) => item.instructionAuthority === false && item.controlAuthority === false), true);
  assert.equal(JSON.stringify(first.snapshot).includes("provider-session-sensitive-123"), false);

  const invalidAdapter = new MemoryRuntimeStateAdapter({
    adapterKind: "runtime-authority-violator",
    exported,
    authority: "runtime-control-authority",
    rebuildable: false,
    uniqueAuthority: true,
    readOnly: false,
  });
  await assert.rejects(((buildWorldModel({ root, persist: false, runtimeStateAdapter: invalidAdapter }))), { code: "INVALID_RUNTIME_STATE_AUTHORITY" });

  const inputDirectory = path.join(root, layout.directory, "world-model", "inputs");
  const inputFile = path.join(inputDirectory, "runtime-state.json");
  fs.mkdirSync(inputDirectory, { recursive: true });
  fs.writeFileSync(inputFile, `${JSON.stringify(exported, null, 2)}\n`);
  const persisted = await buildWorldModel({ root, runtimeStateAdapter: new RuntimeStateFileAdapter({ file: inputFile }) });
  assert.equal(persisted.sourceAdapters.runtimeState.adapterKind, "runtime-state-file");
  assert.equal(persisted.snapshot.coverage.externalRuntimeState, "point-in-time-host-export");
  assert.equal((await inspectWorldModel({ root })).status, "current");

  const queried = (await queryWorldRuntimeState({ root, runtime: "codex", state: "active", limit: 10 }));
  assert.equal(queried.observations.length, 1);
  assert.equal(queried.observations[0].runtime, "codex");
  assert.equal(queried.observations[0].workspace.binding, "project-root");
  assert.equal(queried.controlAuthority, false);

  const capsule = (await compileContext({ root, task: "Inspect the active codex runtime session", budget: 32_768, persist: false }));
  assert.equal(capsule.capsule.snapshot.coverage, "curated-head-canon+repository-world-model-semantic-alpha+temporal-provenance-alpha+product-canon-projection-alpha+external-runtime-state-alpha");
  assert.equal(capsule.capsule.runtimeStateEvidence.length, 1);
  assert.equal(capsule.capsule.runtimeStateEvidence[0].controlAuthority, false);
  assert.equal(capsule.capsule.repositoryRuntimeState.interpretation, "runtime-observations-are-evidence-not-control-authority");

  const mcpRuntime = await dispatchMcp({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "head_runtime_state", arguments: { project_root: root, runtime: "codex", state: "active", limit: 10 } },
  });
  assert.equal(mcpRuntime.result.structuredContent.observations.length, 1);
  assert.equal(mcpRuntime.result.structuredContent.controlAuthority, false);

  const changedExport = clone(exported);
  changedExport.observedAt = "2026-08-18T12:05:00Z";
  changedExport.observations[0].state = "idle";
  fs.writeFileSync(inputFile, `${JSON.stringify(changedExport, null, 2)}\n`);
  const stale = (await inspectWorldModel({ root }));
  assert.equal(stale.status, "stale");
  assert.equal(stale.changes.externalRuntimeStateChanged, true);
  (await assert.rejects(async () => (await queryWorldRuntimeState({ root })), { code: "WORLD_MODEL_STALE" }));
  const staleCapsule = (await compileContext({ root, task: "Inspect the codex runtime session", budget: 32_768, persist: false }));
  assert.deepEqual(staleCapsule.capsule.runtimeStateEvidence, []);
  assert.equal(staleCapsule.capsule.repositoryRuntimeState, null);
  const rebuilt = await buildWorldModel({ root, runtimeStateAdapter: new RuntimeStateFileAdapter({ file: inputFile }) });
  assert.equal(rebuilt.pointer.tiers.warm.externalRuntimeStateChanged, true);
  assert.equal((await queryWorldRuntimeState({ root, runtime: "codex" })).observations[0].state, "idle");

  const invalidExport = clone(changedExport);
  invalidExport.observations[0].transcript = "must never enter the World Model";
  fs.writeFileSync(inputFile, `${JSON.stringify(invalidExport, null, 2)}\n`);
  await assert.rejects(
    ((buildWorldModel({ root, persist: false, runtimeStateAdapter: new RuntimeStateFileAdapter({ file: inputFile }) }))),
    { code: "INVALID_RUNTIME_STATE_EXPORT" },
  );
});

test("compiles a reproducible HEAD-guided Context Capsule without lexical eligibility gates", async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const layout = inspectProject(root).storage;
  const knowledgeFile = path.join(root, layout.directory, "context", "knowledge.json");
  const knowledge = JSON.parse(fs.readFileSync(knowledgeFile, "utf8"));
  knowledge.evidence.push({ id: "evidence-auth-ttl", sourceKind: "source", uri: "src/auth/session.ts:44", digest: "abc123", summary: "Session TTL is read from the active policy." });
  knowledge.claims.push({ id: "claim-session-ttl", statement: "Session TTL is controlled by the active authentication policy.", status: "active", importance: 4, tags: ["auth", "session", "ttl"], evidenceIds: ["evidence-auth-ttl"] });
  knowledge.claims.push({ id: "claim-frontend-color", statement: "The login button uses the blue palette.", status: "active", importance: 1, tags: ["frontend", "color"] });
  knowledge.decisions.push({ id: "decision-auth-policy", title: "Centralize authentication expiry", decision: "Authentication expiry remains policy-owned.", reason: "Avoid runtime-specific TTL drift.", constraints: ["Executors must not hardcode TTL."], importance: 5, tags: ["auth", "ttl"], evidenceIds: ["evidence-auth-ttl"] });
  fs.writeFileSync(knowledgeFile, `${JSON.stringify(knowledge, null, 2)}\n`);

  const first = (await compileContext({ root, task: "Why is the auth session TTL policy-owned?", budget: 32_768, persist: false }));
  const second = (await compileContext({ root, task: "Why is the auth session TTL policy-owned?", budget: 32_768, persist: false }));
  assert.equal(first.capsule.capsuleId, second.capsule.capsuleId);
  assert.equal(first.capsule.compiler.historyRelevance, "DECISIONS");
  assert.deepEqual(first.capsule.selection.includedIds.includes("claim-session-ttl"), true);
  assert.deepEqual(first.capsule.selection.includedIds.includes("decision-auth-policy"), true);
  assert.deepEqual(first.capsule.selection.includedIds.includes("claim-frontend-color"), true);
  assert.equal(first.capsule.selection.excluded.some((item) => item.reason === "low-relevance"), false);
  assert.equal(first.capsule.claims[0].evidence[0].instructionAuthority, false);
});

test("persists and digest-verifies a Context Capsule", async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initializeProject({ root, pluginRoot, runtimes: ["opencode"] });
  const compiled = (await compileContext({ root, task: "Inspect current project context", budget: 32_768, persist: true }));
  const verified = readContextCapsule({ root, capsuleId: compiled.capsule.capsuleId });
  assert.equal(verified.status, "verified");
  assert.equal(verified.capsule.snapshot.coverage, "curated-head-canon-only");
  assert.deepEqual(verified.capsule.selection.includedIds.includes("unknown-repository-index"), true);
});

test("records a deterministic whole-plan execution lineage", async (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const compiled = (await compileContext({ root, task: "Implement the first execution lineage contract", budget: 32_768, persist: true }));
  const planInput = {
    root,
    objective: "Preserve whole-plan authority across bounded execution",
    plan: [{ id: "lineage-contract", outcome: "Freeze verifiable lineage artifacts" }],
    invariants: ["Project canon outranks derived artifacts", "Provider sessions are replaceable"],
    sources: [{ uri: ".head/instructions/project.md", role: "verified-project-direction" }],
  };
  const firstPlan = createWholePlanSnapshot(planInput);
  const samePlan = createWholePlanSnapshot({ ...planInput, persist: false });
  assert.equal(firstPlan.artifact.wholePlanId, samePlan.artifact.wholePlanId);

  const contract = createExecutionContract({
    root,
    wholePlanId: firstPlan.artifact.wholePlanId,
    capsuleId: compiled.capsule.capsuleId,
    scope: "Implement content-derived lineage contracts without automatic worker launch",
    acceptanceCriteria: ["Every artifact is digest-verifiable", "Every child records typed parent links"],
    constraints: ["Do not treat provider session state as canon"],
    allowedActions: ["Write plugin source and tests"],
    forbiddenActions: ["Deploy or activate a remote runtime"],
  });
  const result = createResultPacket({
    root,
    executionContractId: contract.artifact.executionContractId,
    outcome: "Lineage contract builders implemented",
    evidence: [{ uri: "test/head-core.test.mjs", digest: "test-evidence", summary: "End-to-end lineage contract test" }],
    planDelta: "No change to the approved whole-plan direction",
    impactRadius: ["lineage artifact contract", "plugin documentation"],
    verification: [{ check: "node test suite", status: "passed" }],
    unknowns: ["Automatic Run binding remains deferred"],
  });
  const conflictingPlan = createWholePlanSnapshot({
    root,
    objective: "A different whole-plan objective",
    plan: "Do not accept a result from another plan",
  });
  const freshReview = buildFreshHeadReview({
    root,
    wholePlanId: firstPlan.artifact.wholePlanId,
    resultPacketId: result.artifact.resultPacketId,
    sessionId: "session-test",
    runId: "run-test",
  });
  assert.throws(
    () => createReviewDecision({
      root,
      wholePlanId: conflictingPlan.artifact.wholePlanId,
      resultPacketId: result.artifact.resultPacketId,
      reviewContext: freshReview.review,
      disposition: "accept",
      rationale: "This mismatch must fail.",
    }),
    { code: "LINEAGE_CONFLICT" },
  );
  const review = createReviewDecision({
    root,
    wholePlanId: firstPlan.artifact.wholePlanId,
    resultPacketId: result.artifact.resultPacketId,
    reviewContext: freshReview.review,
    disposition: "accept",
    rationale: "The result satisfies the bounded contract without changing authority boundaries.",
    nextActions: ["Connect accepted contracts to Run state in a later milestone"],
  });

  assert.equal(readLineageArtifact({ root, artifactId: contract.artifact.executionContractId }).status, "verified");
  assert.equal(readLineageArtifact({ root, artifactId: result.artifact.resultPacketId }).artifact.evidence[0].instructionAuthority, false);
  assert.equal(readLineageArtifact({ root, artifactId: review.artifact.reviewDecisionId }).artifact.disposition, "accept");
  assert.deepEqual(review.artifact.lineage.map((item) => item.relation), ["reviews-against", "reviews-result", "reviewed-through"]);
});

test("rejects a tampered execution lineage artifact", (t) => {
  const root = temporaryProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initializeProject({ root, pluginRoot, runtimes: ["opencode"] });
  const plan = createWholePlanSnapshot({ root, objective: "Keep the whole plan stable", plan: "Build and verify lineage" });
  const stored = JSON.parse(fs.readFileSync(plan.file, "utf8"));
  stored.objective = "Tampered objective";
  fs.writeFileSync(plan.file, `${JSON.stringify(stored, null, 2)}\n`);
  assert.throws(
    () => readLineageArtifact({ root, artifactId: plan.artifact.wholePlanId }),
    { code: "LINEAGE_DIGEST_MISMATCH" },
  );
});

#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatch } from "./mcp-server.mjs";
import { publicToolName } from "./lib/lode-artifact-composition.mjs";

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "head-agent-conversation-"));
const projectRoot = path.join(temporaryRoot, "sample-project");
const graphProjectRoot = path.join(temporaryRoot, "graph-project");
const coreProjectRoot = path.join(temporaryRoot, "core-project");
const defaultToolNames = new Set();
const discoveredTools = new Map();
const routedToolNames = new Set();

async function directToolResponse(name, args) {
  name = publicToolName(name);
  const response = await dispatch({
    jsonrpc: "2.0",
    id: `${name}-${Date.now()}`,
    method: "tools/call",
    params: { name, arguments: args },
  });
  if (response.error) throw new Error(`${name}: ${response.error.message}`);
  return response.result;
}

async function discoverTool(name) {
  name = publicToolName(name);
  if (!discoveredTools.has(name)) {
    const discovery = (await directToolResponse("head_tools_discover", { name })).structuredContent;
    assert.equal(discovery.persisted, false);
    assert.equal(discovery.grantsAuthorization, false);
    assert.equal(discovery.total, 1);
    assert.equal(discovery.tools[0].name, name);
    assert.equal(discovery.tools[0].invokeWith,
      publicToolName(discovery.tools[0].annotations.readOnlyHint === true ? "head_tools_read" : "head_tools_call"));
    discoveredTools.set(name, discovery.tools[0]);
  }
  return discoveredTools.get(name);
}

async function toolResponse(name, args) {
  name = publicToolName(name);
  if (defaultToolNames.has(name)) return directToolResponse(name, args);
  const discovered = await discoverTool(name);
  routedToolNames.add(name);
  return directToolResponse(discovered.invokeWith, { name, arguments: args });
}

async function tool(name, args) {
  return (await toolResponse(name, args)).structuredContent;
}

try {
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "request-service.mjs"), [
    "export function acceptRequest() { return 'accepted'; }",
    "export function validateRequest() { return 'valid'; }",
    "export function publishReceipt() { return acceptRequest(); }",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(projectRoot, "README.md"), "# Request processing\n\nAccept, validate, and acknowledge user requests.\n");

  const listed = await dispatch({ jsonrpc: "2.0", id: "tools", method: "tools/list", params: {} });
  for (const entry of listed.result.tools) defaultToolNames.add(entry.name);
  for (const name of ["head_tools_discover", "head_tools_read", "head_tools_call", "head_project_initialize_or_resume"].map(publicToolName)) {
    assert(defaultToolNames.has(name), `Missing default MCP entry: ${name}`);
  }
  for (const name of [
    "head_onboarding_guide",
    "head_project_initialize_or_resume",
    "head_onboarding_review",
    "head_markdown_projection_build",
    "head_graphdb_connection_preflight",
    "head_graphdb_database_initialize",
    "head_graphdb_projection_activate",
  ].map(publicToolName)) {
    if (!defaultToolNames.has(name)) await discoverTool(name);
  }
  assert.equal(defaultToolNames.has(publicToolName("head_onboarding_guide")), false);
  assert.equal(fs.existsSync(path.join(projectRoot, ".head")), false);
  assert.equal(fs.existsSync(path.join(projectRoot, ".lode")), false);
  const graphDbActivateTool = await discoverTool("head_graphdb_projection_activate");
  assert.deepEqual(graphDbActivateTool.inputSchema.required, ["project_root", "confirm_remote_write"]);
  assert.equal(graphDbActivateTool.inputSchema.additionalProperties, false);
  assert.equal(Object.keys(graphDbActivateTool.inputSchema.properties).some((key) => /password|username|credential|token/i.test(key)), false);

  fs.mkdirSync(coreProjectRoot, { recursive: true });
  fs.writeFileSync(path.join(coreProjectRoot, "core.mjs"), "export const coordinated = true;\n");
  const coreInitializationResponse = await toolResponse("head_project_initialize_or_resume", {
    project_root: coreProjectRoot,
    runtimes: ["codex"],
  });
  const coreInitialized = coreInitializationResponse.structuredContent;
  assert.equal(coreInitialized.status, "core_ready");
  assert.equal(coreInitialized.profile, "core");
  assert.equal(coreInitialized.productGovernanceActivated, false);
  assert.equal(coreInitialized.onboardingAction, "not-activated");
  assert.equal(coreInitialized.onboarding.candidateSetId, null);
  assert.equal(coreInitialized.nextAction.id, "work_directly");
  assert.equal(coreInitialized.readiness.recovery.state, "no-current-checkpoint");
  assert.equal(coreInitialized.readiness.recovery.authority.writesRecoveryDirection, false);
  assert.match(coreInitializationResponse.content[0].text, /Continue the user's original task in this conversation/u);
  assert.doesNotMatch(coreInitializationResponse.content[0].text, /MCP:|Command:|candidateSetId|sessionId/u);
  assert.equal(coreInitialized.capabilities.find((item) => item.id === "product-governance").availability, "available-not-activated");
  const coreStatus = await tool("head_project_status", { project_root: coreProjectRoot });
  assert.equal(coreStatus.status, "core_ready");
  assert.equal(coreStatus.readiness.product.state, "not_activated");
  assert.equal(coreStatus.authority.mutatesProject, false);
  assert.equal(coreStatus.authority.activatesCapabilities, false);
  assert.equal(coreStatus.readiness.recovery.authority.consumesContinuation, false);

  fs.mkdirSync(graphProjectRoot, { recursive: true });
  fs.writeFileSync(path.join(graphProjectRoot, "service.mjs"), "export function serve() { return true; }\n");
  await tool("head_project_initialize_or_resume", {
    project_root: graphProjectRoot,
    profile: "product",
    runtimes: ["codex"],
    mode: "existing",
    source_scope: { include_roots: [], exclude_roots: [] },
    storage: {
      mode: "graphdb",
      endpoint: "https://fixture-target.invalid",
      database: "fixture-target-database",
      username_secret_reference: "HEAD_FIXTURE_GRAPHDB_USERNAME_MISSING",
      password_secret_reference: "HEAD_FIXTURE_GRAPHDB_PASSWORD_MISSING",
    },
  });
  const graphDbPreflight = await tool("head_graphdb_connection_preflight", { project_root: graphProjectRoot });
  assert.equal(graphDbPreflight.status, "credential-references-unavailable");
  assert.equal(graphDbPreflight.allReferencesPresent, false);
  assert.equal(graphDbPreflight.hostRestartMayBeRequired, true);
  assert.equal(graphDbPreflight.references.username.name, "HEAD_FIXTURE_GRAPHDB_USERNAME_MISSING");
  assert.equal(graphDbPreflight.references.username.present, false);
  assert.equal(graphDbPreflight.references.password.present, false);
  assert.equal(graphDbPreflight.credentialValuesReturned, false);
  assert.equal(graphDbPreflight.targetValuesReturned, false);
  assert.equal(graphDbPreflight.networkRequestPerformed, false);
  assert.equal(JSON.stringify(graphDbPreflight).includes("fixture-target.invalid"), false);
  assert.equal(JSON.stringify(graphDbPreflight).includes("fixture-target-database"), false);
  await assert.rejects(() => tool("head_graphdb_projection_activate", {
    project_root: graphProjectRoot,
    confirm_remote_write: false,
  }), /explicit user confirmation/u);
  const fixtureUsernameReference = "HEAD_FIXTURE_GRAPHDB_USERNAME_MISSING";
  const fixturePasswordReference = "HEAD_FIXTURE_GRAPHDB_PASSWORD_MISSING";
  const previousFixtureUsername = process.env[fixtureUsernameReference];
  const previousFixturePassword = process.env[fixturePasswordReference];
  try {
    process.env[fixtureUsernameReference] = "fixture-username-value-not-a-secret";
    process.env[fixturePasswordReference] = "fixture-password-value-not-a-secret";
    const availablePreflight = await tool("head_graphdb_connection_preflight", { project_root: graphProjectRoot });
    assert.equal(availablePreflight.status, "credential-references-available");
    assert.equal(availablePreflight.allReferencesPresent, true);
    assert.equal(availablePreflight.hostRestartMayBeRequired, false);
    assert.equal(availablePreflight.references.username.present, true);
    assert.equal(availablePreflight.references.password.present, true);
    assert.equal(availablePreflight.networkRequestPerformed, false);
    assert.equal(JSON.stringify(availablePreflight).includes("fixture-username-value-not-a-secret"), false);
    assert.equal(JSON.stringify(availablePreflight).includes("fixture-password-value-not-a-secret"), false);
  } finally {
    if (previousFixtureUsername == null) delete process.env[fixtureUsernameReference];
    else process.env[fixtureUsernameReference] = previousFixtureUsername;
    if (previousFixturePassword == null) delete process.env[fixturePasswordReference];
    else process.env[fixturePasswordReference] = previousFixturePassword;
  }

  const before = await tool("head_onboarding_guide", { project_root: projectRoot });
  assert.equal(before.status, "not_initialized");
  assert.equal(before.nextAction, "initialize_or_resume");

  const initialized = await tool("head_project_initialize_or_resume", {
    project_root: projectRoot,
    profile: "product",
    runtimes: ["claude", "codex", "opencode"],
    mode: "existing",
    source_scope: { include_roots: [], exclude_roots: [] },
    storage: { mode: "local" },
  });
  assert.equal(initialized.status, "product_evidence_required");
  assert.equal(initialized.nextAction.id, "provide_product_evidence");
  assert.equal(initialized.onboarding.candidateCount, 0);

  const evidenceGuide = await tool("head_onboarding_guide", { project_root: projectRoot });
  assert.equal(evidenceGuide.status, "awaiting_evidence");
  assert.deepEqual(evidenceGuide.materialChoicesRequired, ["fresh_head_semantic_proposal_or_user_brief"]);

  const proposed = await tool("head_project_initialize_or_resume", {
    project_root: projectRoot,
    profile: "product",
    semantic_proposal: {
      schemaVersion: 1,
      sourceSnapshotId: initialized.onboarding.sourceSnapshotId,
      candidates: [{
        productKind: "Capability",
        proposedEntity: {
          key: "capability:request-processing",
          name: "Request processing",
          description: "Accept current user requests and produce acknowledgements.",
        },
        evidence: [{ path: "request-service.mjs", line: 1 }],
        explanation: "Fresh HEAD interpreted current behavior; Core binds the current digest and keeps this proposal non-authoritative.",
        confidence: 0.8,
      }],
    },
  });
  assert.equal(proposed.status, "product_review_required");
  assert.equal(proposed.nextAction.id, "review_product_candidates");
  assert.equal(proposed.onboarding.candidateCount, 1);

  const reviewGuide = await tool("head_onboarding_guide", { project_root: projectRoot, candidate_limit: 200 });
  assert.equal(reviewGuide.status, "awaiting_review");
  assert.equal(reviewGuide.nextAction, "review_candidates");
  assert.equal(reviewGuide.review.truncated, false);
  assert.equal(reviewGuide.review.candidates.every((candidate) => candidate.authority === "candidate-only-until-explicit-review"), true);
  const reviewGuideResponse = await toolResponse("head_onboarding_guide", { project_root: projectRoot, candidate_limit: 200 });
  assert.match(reviewGuideResponse.content[0].text, /Core supplies no automatic disposition/u);
  assert.match(reviewGuideResponse.content[0].text, /Reply in natural language/u);
  assert.doesNotMatch(reviewGuideResponse.content[0].text, /candidateSetId|candidate-/u);

  const revised = await tool("head_onboarding_review", {
    project_root: projectRoot,
    candidate_set_id: reviewGuide.review.candidateSetId,
    disposition: "revise",
    added_entities: [{
      kind: "Capability",
      entity: {
        key: "capability:reviewed-continuity",
        name: "Reviewed continuity",
        description: "Preserve explicit successor review lineage.",
      },
    }],
    rationale: "Add one user-authored concept through the required two-review path.",
  });
  assert.equal(revised.status, "onboarding_revision_awaiting_review");
  assert.equal(revised.state.latestReviewDecisionId, revised.reviewDecision.reviewDecisionId);

  const successorGuide = await tool("head_onboarding_guide", { project_root: projectRoot, candidate_limit: 200 });
  assert.equal(successorGuide.status, "awaiting_review");
  assert.notEqual(successorGuide.review.candidateSetId, reviewGuide.review.candidateSetId);

  const reviewed = await tool("head_onboarding_review", {
    project_root: projectRoot,
    candidate_set_id: successorGuide.review.candidateSetId,
    disposition: "accept-all",
    rationale: "Fixture reviewer inspected every candidate in the immutable successor batch.",
  });
  assert.equal(reviewed.status, "onboarding_ready");
  assert.equal(reviewed.authorityEffect, "explicit-product-canon-transition");
  assert.notEqual(reviewed.state.latestReviewDecisionId, revised.reviewDecision.reviewDecisionId);

  const documents = await tool("head_markdown_projection_build", { project_root: projectRoot });
  assert.equal(documents.status, "projected");
  assert.equal(documents.authority, "rebuildable-derived-human-view-not-project-canon");

  const contextTask = "Locate request acceptance and validation evidence";
  const preparation = await tool("head_context_prepare", {
    project_root: projectRoot,
    task: contextTask,
    budget: 32_768,
  });
  assert.equal(preparation.status, "prepared");
  assert.equal(preparation.preparation.status, "ready_for_head_semantic_assessment");
  assert.equal(preparation.preparation.task, contextTask);
  assert(preparation.preparation.selectedContext.repositoryFiles.length > 0);
  assert.equal(preparation.preparation.authority.selectsEvidenceNeeds, false);
  assert.equal(preparation.preparation.authority.writesRecoveryDirection, false);

  const context = await tool("head_context_preview", {
    project_root: projectRoot,
    task: contextTask,
    budget: 32_768,
  });
  assert.equal(context.status, "preview");
  assert.match(context.capsule.capsuleId, /^capsule-[a-f0-9]{24}$/);
  assert.equal(context.capsule.trustBoundary.temporalProvenance, "rebuildable-derived-evidence-not-project-canon");

  const ready = await tool("head_onboarding_guide", { project_root: projectRoot });
  assert.equal(ready.status, "ready");
  assert.equal(ready.nextAction, "ready");
  assert.equal(ready.readiness.world, "current");
  assert.equal(ready.readiness.graph, "current");
  assert.equal(ready.readiness.documents, "current");
  assert.equal(ready.readiness.documentProjectionId, documents.documentProjectionId);

  const resumed = await tool("head_project_initialize_or_resume", {
    project_root: projectRoot,
    profile: "product",
    runtimes: ["claude", "codex", "opencode"],
  });
  assert.equal(resumed.project.projectId, initialized.project.projectId);
  assert.equal(resumed.project.sessionId, initialized.project.sessionId);
  assert.equal(resumed.onboardingAction, "already-ready");

  process.stdout.write(`${JSON.stringify({
    status: "conversational_onboarding_verified",
    constitutionalCoreDefaultVerified: true,
    projectIdentityPreserved: true,
    sessionIdentityPreserved: true,
    explicitReviewRequired: true,
    worldGraphContextDocumentsReady: true,
    optionalGraphDbConversationOperationsDiscoverable: true,
    defaultToolCount: defaultToolNames.size,
    advancedToolsDiscovered: [...discoveredTools.keys()].sort(),
    advancedToolsRouted: [...routedToolNames].sort(),
    discoveryGrantsAuthorization: false,
    unconfirmedGraphDbActivationRejected: true,
    graphDbCredentialPreflightNetworkRequests: 0,
    graphDbTargetValuesReturnedByPreflight: false,
    graphDbCredentialValuesAcceptedByTools: false,
    graphDbRequired: false,
    gitRequired: false,
    credentialValuesPersisted: false,
  }, null, 2)}\n`);
} finally {
  const resolvedTemporaryRoot = path.resolve(temporaryRoot);
  if (resolvedTemporaryRoot.startsWith(path.resolve(os.tmpdir()) + path.sep)
    && path.basename(resolvedTemporaryRoot).startsWith("head-agent-conversation-")) {
    fs.rmSync(resolvedTemporaryRoot, { recursive: true, force: true });
  }
}

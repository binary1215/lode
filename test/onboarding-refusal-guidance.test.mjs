import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { initializeProject, inspectProject } from "../scripts/lib/head-core.mjs";
import { inspectOnboarding, reviewOnboarding, startOnboarding } from "../scripts/lib/session/onboarding.mjs";
import { onboardingCanonicalJson, onboardingDigest } from "../scripts/lib/session/onboarding-contract.mjs";
import { verifyOnboardingCandidateSetForProjection } from "../scripts/lib/session/onboarding-projection.mjs";
import { readProductModelCanon } from "../scripts/lib/world/product-model.mjs";
import { buildWorldModel } from "../scripts/lib/world/world-model.mjs";
import { dispatch } from "../scripts/mcp-server.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const MIGRATOR_DOCUMENT = "docs/onboarding-migrator.md";

function identified(document, idField, hashField, prefix) {
  const payload = structuredClone(document);
  delete payload[idField];
  delete payload[hashField];
  const hash = onboardingDigest(onboardingCanonicalJson(payload));
  return { ...payload, [idField]: `${prefix}-${hash.slice(0, 24)}`, [hashField]: hash };
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// Replaces the current candidate set with `rewrite(payload)` and points the onboarding state at it.
function rebindCurrentCandidateSet(root, storage, candidateSet, rewrite, stateRewrite = () => {}) {
  const directory = path.join(root, storage.directory, "onboarding", "candidate-sets");
  const replacement = identified(rewrite(structuredClone(candidateSet)), "candidateSetId", "candidateSetHash", "onboarding-candidates");
  writeJson(path.join(directory, `${replacement.candidateSetId}.json`), replacement);
  fs.unlinkSync(path.join(directory, `${candidateSet.candidateSetId}.json`));
  const stateFile = path.join(root, storage.directory, "onboarding", "current.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  delete state.pointerHash;
  state.candidateSetId = replacement.candidateSetId;
  stateRewrite(state);
  writeJson(stateFile, { ...state, pointerHash: onboardingDigest(onboardingCanonicalJson(state)) });
  return replacement;
}

async function pendingOnboarding(t, description = "Deliver messages reliably.") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lode-onboarding-refusal-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "README.md"), "# Delivery\n");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "delivery.mjs"), "export const deliver = (value) => value;\n");
  initializeProject({ root, pluginRoot, runtimes: ["codex"] });
  const storage = inspectProject(root).storage;
  const started = await startOnboarding({
    root,
    mode: "new",
    brief: { schemaVersion: 1, name: "Delivery", summary: "Deliver.", capabilities: [{ key: "delivery", name: "Delivery", description }] },
  });
  assert.equal(started.status, "awaiting_onboarding_review");
  return { root, storage, candidateSet: started.candidateSet };
}

function cli(...args) {
  const result = spawnSync(process.execPath, [path.join(pluginRoot, "scripts", "lode.mjs"), ...args], { encoding: "utf8", windowsHide: true });
  // The human presentation wraps long reasons into "|"-prefixed lines; join them back.
  return { status: result.status, text: `${result.stdout}${result.stderr}`.replace(/\s*\|\s*/g, " ").replace(/\s+/g, " ") };
}

async function mcp(name, args) {
  const response = await dispatch({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "lode_tools_call", arguments: { name, arguments: args } },
  });
  return response.error ? { message: response.error.message, reasonCode: response.error.data?.reasonCode } : { result: response.result };
}

test("an onboarding candidate set of an unread protocol names both versions and the migration document", async (t) => {
  const { root, storage, candidateSet } = await pendingOnboarding(t);
  const legacy = rebindCurrentCandidateSet(root, storage, candidateSet, (payload) => {
    payload.protocol.version = "0.3.0";
    return payload;
  });
  const expected = (text) => {
    assert.match(text, /candidate protocol 0\.3\.0/);
    assert.match(text, /reads only candidate protocol 0\.4\.0/);
    assert.ok(text.includes(MIGRATOR_DOCUMENT), text);
    assert.match(text, /Lode does not run it/);
  };
  for (const args of [
    ["onboarding-status", root],
    ["onboarding-candidates", root, "--candidate-set", legacy.candidateSetId],
  ]) {
    const result = cli(...args);
    assert.equal(result.status, 1, result.text);
    expected(result.text);
    assert.match(result.text, /INVALID_ONBOARDING_PROJECTION_CANDIDATE_SET/);
    assert.ok(result.text.includes(legacy.candidateSetId));
  }
  const viaMcp = await mcp("lode_onboarding_status", { project_root: root });
  assert.equal(viaMcp.reasonCode, "INVALID_ONBOARDING_PROJECTION_CANDIDATE_SET");
  expected(viaMcp.message);
  // A World build meets the same record outside a committed historical boundary.
  const world = cli("world-index", root);
  assert.equal(world.status, 1, world.text);
  assert.match(world.text, /HISTORICAL_BOUNDARY_COVERAGE_DRIFT/);
  expected(world.text);
});

test("other candidate-set defects keep their own wording and name the first invalid field", async (t) => {
  const { root, storage, candidateSet } = await pendingOnboarding(t);
  const current = JSON.parse(fs.readFileSync(path.join(root, storage.directory, "onboarding", "candidate-sets", `${candidateSet.candidateSetId}.json`), "utf8"));
  const broken = identified({ ...current, inputMode: "sideways" }, "candidateSetId", "candidateSetHash", "onboarding-candidates");
  assert.throws(
    () => verifyOnboardingCandidateSetForProjection(broken, "", storage),
    (error) =>
      error.code === "INVALID_ONBOARDING_PROJECTION_CANDIDATE_SET" &&
      error.message === "Onboarding candidate set fields or authority are invalid (first invalid field: inputMode).",
  );
  const promoted = identified({ ...current, promotionAuthority: true }, "candidateSetId", "candidateSetHash", "onboarding-candidates");
  assert.throws(
    () => verifyOnboardingCandidateSetForProjection(promoted, "", storage),
    (error) => error.code === "INVALID_ONBOARDING_PROJECTION_CANDIDATE_SET" && /first invalid field: promotionAuthority/.test(error.message),
  );
  assert.equal(verifyOnboardingCandidateSetForProjection(current, "", storage).candidateSetId, candidateSet.candidateSetId);
});

test("ONBOARDING_PRODUCT_CANON_CONFLICT names the entry and points to document change review", async (t) => {
  // An older Project whose current candidate set was proposed against a Canon that already holds
  // Capability "delivery" with other content. Current Core binds new candidate sets only to an empty
  // Canon, so the state is constructed from the records of a fresh onboarding.
  const { root, storage, candidateSet } = await pendingOnboarding(t);
  writeJson(path.join(root, storage.directory, "context", "product-model.json"), {
    schemaVersion: 1,
    featureGroups: [],
    capabilities: [{ key: "delivery", name: "Delivery", description: "Deliver a message." }],
    features: [],
    requirements: [],
    constraints: [],
    decisions: [],
  });
  const canon = readProductModelCanon({ storage, projectRoot: root }).model;
  const built = await buildWorldModel({ root });
  const sourceSnapshotId = built.snapshot.temporalProvenanceGraph.sourceSnapshotId;
  const rebound = rebindCurrentCandidateSet(
    root,
    storage,
    candidateSet,
    (payload) => ({
      ...payload,
      productModelId: canon.productModelId,
      sourceSnapshotId,
      candidates: payload.candidates.map((candidate) =>
        identified({ ...candidate, sourceSnapshotId }, "candidateId", "candidateHash", "onboarding-candidate"),
      ),
    }),
    (state) => Object.assign(state, { productModelId: canon.productModelId, previousProductModelId: canon.productModelId, sourceSnapshotId, worldModelId: built.snapshot.worldModelId }),
  );
  await buildWorldModel({ root });
  assert.equal((await inspectOnboarding({ root })).status, "awaiting_review");
  const expected = (text) => {
    assert.match(text, /Product Canon already has Capability "delivery" with different content/);
    assert.match(text, /document change review \(world-docs-capture, then world-docs-review\), not through onboarding review/);
  };
  const input = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lode-onboarding-review-input-")), "review.json");
  t.after(() => fs.rmSync(path.dirname(input), { recursive: true, force: true }));
  writeJson(input, { candidateSetId: rebound.candidateSetId, disposition: "accept-all", rationale: "Adopt." });
  const viaCli = cli("onboarding-review", root, "--input", input);
  assert.equal(viaCli.status, 1, viaCli.text);
  assert.match(viaCli.text, /ONBOARDING_PRODUCT_CANON_CONFLICT/);
  expected(viaCli.text);
  const viaMcp = await mcp("lode_onboarding_review", {
    project_root: root,
    candidate_set_id: rebound.candidateSetId,
    disposition: "accept-all",
    rationale: "Adopt.",
  });
  assert.equal(viaMcp.reasonCode, "ONBOARDING_PRODUCT_CANON_CONFLICT");
  expected(viaMcp.message);
  await assert.rejects(
    reviewOnboarding({ root, candidateSetId: rebound.candidateSetId, disposition: "accept-all", rationale: "Adopt." }),
    { code: "ONBOARDING_PRODUCT_CANON_CONFLICT" },
  );
  assert.equal(readProductModelCanon({ storage, projectRoot: root }).model.productModelId, canon.productModelId, "Canon unchanged");
});

test("the onboarding skill and both onboarding documents carry the same guidance", () => {
  const read = (relative) => fs.readFileSync(path.join(pluginRoot, relative), "utf8").replace(/\s+/g, " ");
  const skill = read("skills/lode-agent-onboarding/SKILL.md");
  assert.match(skill, /`ONBOARDING_PRODUCT_CANON_CONFLICT`, the refusal names the existing entry \(kind and key\)/);
  assert.match(skill, /document change review \(`world-docs-capture`, then `world-docs-review`\), not through onboarding review/);
  assert.match(skill, /names the version found, the version read, and `docs\/onboarding-migrator\.md`/);
  assert.match(skill, /do not run the migrator/);
  for (const relative of ["docs/onboarding.md", "docs/ko/onboarding.md"]) {
    const document = read(relative);
    assert.match(document, /`ONBOARDING_PRODUCT_CANON_CONFLICT`/, relative);
    assert.match(document, /`world-docs-capture`/, relative);
    assert.match(document, /`world-docs-review`/, relative);
    assert.match(document, /\(document-change-review\.md\)/, relative);
    assert.match(document, /\(`0\.4\.0`\)/, relative);
  }
});

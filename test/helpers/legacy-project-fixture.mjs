import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { inspectProject } from "../../scripts/lib/head-core.mjs";
import { initialOnboardingDocuments } from "../../scripts/lib/session/onboarding-contract.mjs";
import { emptyProductModelDocument, normalizeProductModelDocument } from "../../scripts/lib/world/product-model.mjs";

// Synthetic legacy contract seed only; genuine old-producer interoperability is verified separately.
export function seedLegacyProject(root, pluginRoot) {
  root = fs.realpathSync(root);
  const createdAt = "2026-09-22T00:00:00.000Z";
  const project = { schemaVersion: 1, projectId: `head-${crypto.createHash("sha256").update(root).digest("hex").slice(0, 20)}`,
    projectRoot: root, createdAt, runtimes: ["claude", "codex", "opencode"], integrations: {},
    authority: { head: "ordinary investigation, strategy, integration, and completion judgment",
      user: "material product, policy, architecture, cost, workflow, and consequential external actions" } };
  const sessionState = { schemaVersion: 1, sessionId: `session-${crypto.randomUUID()}`, mode: "session",
    currentWholePlanId: null, activeRunId: null, activeExecutionContractId: null, lastResultPacketId: null,
    pendingReview: null, lastReviewDecisionId: null, requiredPlanAction: null, latestCheckpoint: null, updatedAt: createdAt };
  const product = emptyProductModelDocument();
  const onboarding = initialOnboardingDocuments({ project, sessionState,
    productModelId: normalizeProductModelDocument(product).productModelId, updatedAt: createdAt });
  const records = new Map([
    [".head/project.json", project], [".head/sessions/current.json", sessionState],
    [".head/context/knowledge.json", { schemaVersion: 1, evidence: [], claims: [], decisions: [], unknowns: [] }],
    [".head/context/product-model.json", product], [".head/onboarding/current.json", onboarding.state],
    [`.head/sessions/records/${onboarding.sessionRecord.sessionId}.json`, onboarding.sessionRecord],
    [`.head/onboarding/storage-selections/${onboarding.storageSelection.storageSelectionId}.json`, onboarding.storageSelection],
  ]);
  for (const [relative, value] of records) {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  }
  fs.mkdirSync(path.join(root, ".head/instructions"), { recursive: true });
  fs.writeFileSync(path.join(root, ".head/instructions/project.md"), "# Project-specific HEAD context\n\nRecord project identity, canonical sources, repository boundaries, and fixed constraints here.\n", { flag: "wx" });
  const immutable = [...records.keys()].filter(relative => relative === ".head/project.json"
    || relative.startsWith(".head/sessions/records/") || relative.startsWith(".head/onboarding/storage-selections/"));
  const manifest = { schemaVersion: 1, generatedAt: createdAt, pluginRoot,
    packageVersion: JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"))).version,
    managed: immutable.map(relative => ({ path: relative, sha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(root, relative))).digest("hex") })) };
  fs.mkdirSync(path.join(root, ".head/generated"), { recursive: true });
  fs.writeFileSync(path.join(root, ".head/generated/manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  const inspected = inspectProject(root); assert.equal(inspected.status, "ready");
  assert.equal(inspected.storage.directory, ".head");
  return { project };
}

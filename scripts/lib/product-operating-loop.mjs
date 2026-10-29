import { formatForVerifiedOwner, relativeProjectArtifact } from "./project-storage-format.mjs";
import fs from "node:fs";
import path from "node:path";
import { atomicCreateArtifact } from "./artifact-storage.mjs";
import { inspectProject, SCHEMA_VERSION } from "./lode-core.mjs";
import { readChangeSet } from "./change-set.mjs";
import { readLineageArtifact } from "./execution-lineage.mjs";
import { readProductModelCanon } from "./product-model.mjs";
import { loadObservationArtifacts } from "./observation-store.mjs";
import { withProjectMutationAsync } from "./project-mutation-lock.mjs";
import {
  PRODUCT_OPERATING_LOOP_VERSION,
  PRODUCT_HYPOTHESIS_VERSION,
  productOperatingCanonicalJson,
  productOperatingDigest,
  verifyProductSignal,
  verifyProductHypothesis,
  verifyProductFeatureCandidate,
  verifyProductInitiativeCandidate,
  verifyProductInitiativeReviewDecision,
  verifyReviewedProductInitiative,
  verifyOutcomeObservation,
  verifyProductOperatingProjectionInput,
  loadProductOperatingProjection,
  PRODUCT_SIGNAL_DIRECTORY,
  PRODUCT_HYPOTHESIS_DIRECTORY,
  PRODUCT_INITIATIVE_CANDIDATE_DIRECTORY,
  PRODUCT_INITIATIVE_REVIEW_DIRECTORY,
  REVIEWED_PRODUCT_INITIATIVE_DIRECTORY,
  PRODUCT_FEATURE_CANDIDATE_DIRECTORY,
  OUTCOME_OBSERVATION_DIRECTORY,
  DIRECTORIES,
  LIMITS,
  fail,
  requiredText,
  sortedIds,
  safeDirectory,
  artifact,
  initiativeSeed,
  verifyReviewDecisionCandidateLineage,
  buildReviewedInitiative,
} from "./product-operating-projection.mjs";
export {
  PRODUCT_OPERATING_LOOP_VERSION,
  PRODUCT_HYPOTHESIS_VERSION,
  productOperatingCanonicalJson,
  productOperatingDigest,
  verifyProductSignal,
  verifyProductHypothesis,
  verifyProductFeatureCandidate,
  verifyProductInitiativeCandidate,
  verifyProductInitiativeReviewDecision,
  verifyReviewedProductInitiative,
  verifyOutcomeObservation,
  verifyProductOperatingProjectionInput,
  loadProductOperatingProjection,
} from "./product-operating-projection.mjs";

const projectionReadCache = new Map();
const worldSummaryReadCache = new Map();
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function cacheRoot(root) { return path.resolve(root); }

function invalidateProductOperatingReadCache(root = ".") {
  const key = cacheRoot(root);
  projectionReadCache.delete(key);
  worldSummaryReadCache.delete(key);
}

function optionalText(value, label) {
  if (value == null) return "";
  if (typeof value !== "string") fail(`${label} must be a string.`, "INVALID_PRODUCT_OPERATING_INPUT");
  return value.trim();
}

function stableKey(value, label) {
  const normalized = requiredText(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) fail(`${label} is not a stable key.`, "INVALID_PRODUCT_OPERATING_KEY");
  return normalized;
}

function readyProject(root, action) {
  const inspected = inspectProject(root);
  if (inspected.status !== "ready") fail(`Project must be ready for ${action}; current status: ${inspected.status}.`, "PROJECT_NOT_READY");
  return inspected;
}

function atomicCreate(file, content) {
  try { atomicCreateArtifact(file, content); return true; }
  catch (error) { if (error.code === "EEXIST") return false; throw error; }
}

function readImmutableDocument(file, id) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`Product operating artifact is unsafe: ${id}`, "INVALID_PRODUCT_OPERATING_ARTIFACT");
  if (stat.size > LIMITS.maxArtifactBytes) fail("Product operating artifacts exceed their byte bound.", "PRODUCT_OPERATING_LIMIT");
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { fail(`Product operating artifact is invalid JSON: ${error.message}`, "INVALID_PRODUCT_OPERATING_ARTIFACT"); }
}

function prepareImmutableWrites(projectRoot, writes, storage = null) {
  const prepared = writes.map(({ relative, id, document }) => {
    const directory = safeDirectory(projectRoot, relativeProjectArtifact(storage, ...relative.split("/").slice(1)));
    const content = json(document);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > LIMITS.maxArtifactBytes) fail("Product operating artifact exceeds its byte bound.", "PRODUCT_OPERATING_LIMIT");
    return { relative, id, document, directory, file: path.join(directory, `${id}.json`), content, bytes, existing: false };
  });
  const uniqueFiles = new Map();
  for (const item of prepared) {
    const prior = uniqueFiles.get(item.file);
    if (prior && productOperatingCanonicalJson(prior.document) !== productOperatingCanonicalJson(item.document)) fail(`Immutable identity collision: ${item.id}`, "PRODUCT_OPERATING_IMMUTABLE_COLLISION");
    if (!prior) uniqueFiles.set(item.file, item);
  }
  const byDirectory = new Map();
  for (const item of uniqueFiles.values()) {
    if (!byDirectory.has(item.directory)) byDirectory.set(item.directory, []);
    byDirectory.get(item.directory).push(item);
  }
  for (const [directory, additions] of byDirectory) {
    const entries = fs.existsSync(directory)
      ? fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.name.endsWith(".json"))
      : [];
    if (entries.length > LIMITS.maxArtifacts) fail("Product operating artifact count exceeds its bound.", "PRODUCT_OPERATING_LIMIT");
    let totalBytes = 0;
    const existingNames = new Set();
    for (const entry of entries) {
      const existingFile = path.join(directory, entry.name);
      const stat = fs.lstatSync(existingFile);
      if (stat.isSymbolicLink() || !stat.isFile()) fail("Product operating artifact is unsafe.", "INVALID_PRODUCT_OPERATING_ARTIFACT");
      if (stat.size > LIMITS.maxArtifactBytes) fail("Product operating artifacts exceed their byte bound.", "PRODUCT_OPERATING_LIMIT");
      totalBytes += stat.size;
      if (totalBytes > LIMITS.maxTotalBytes) fail("Product operating artifacts exceed their byte bound.", "PRODUCT_OPERATING_LIMIT");
      existingNames.add(entry.name);
    }
    const newItems = [];
    for (const item of additions) {
      if (existingNames.has(path.basename(item.file))) {
        const existing = readImmutableDocument(item.file, item.id);
        if (productOperatingCanonicalJson(existing) !== productOperatingCanonicalJson(item.document)) fail(`Immutable identity collision: ${item.id}`, "PRODUCT_OPERATING_IMMUTABLE_COLLISION");
        item.existing = true;
      } else newItems.push(item);
    }
    if (entries.length + newItems.length > LIMITS.maxArtifacts) fail("Product operating artifact count exceeds its bound.", "PRODUCT_OPERATING_LIMIT");
    if (totalBytes + newItems.reduce((sum, item) => sum + item.bytes, 0) > LIMITS.maxTotalBytes) fail("Product operating artifacts exceed their byte bound.", "PRODUCT_OPERATING_LIMIT");
  }
  return prepared;
}

function persistPreparedImmutable(projectRoot, prepared) {
  if (prepared.existing) return { status: "existing", file: prepared.file };
  if (!atomicCreate(prepared.file, prepared.content)) {
    const existing = readImmutableDocument(prepared.file, prepared.id);
    if (productOperatingCanonicalJson(existing) !== productOperatingCanonicalJson(prepared.document)) fail(`Immutable identity collision: ${prepared.id}`, "PRODUCT_OPERATING_IMMUTABLE_COLLISION");
    return { status: "existing", file: prepared.file };
  }
  invalidateProductOperatingReadCache(projectRoot);
  return { status: "recorded", file: prepared.file };
}

function persistImmutable(projectRoot, relative, id, document, storage = null) {
  return persistPreparedImmutable(projectRoot, prepareImmutableWrites(projectRoot, [{ relative, id, document }], storage)[0]);
}

function statToken(file) {
  const stat = fs.statSync(file, { bigint: true });
  return `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function productOperatingReadFingerprint(projectRoot, storage = null) {
  const entries = [];
  for (const [kind, relative] of Object.entries(DIRECTORIES)) {
    const directory = safeDirectory(projectRoot, relativeProjectArtifact(storage, ...relative.split("/").slice(1)));
    if (!fs.existsSync(directory)) { entries.push(`${kind}:absent`); continue; }
    const files = fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name).sort();
    entries.push(`${kind}:${files.map((name) => `${name}:${statToken(path.join(directory, name))}`).join("|")}`);
  }
  return productOperatingDigest(entries.join("\n"));
}

function readProductOperatingProjection(inspected, { fresh = false } = {}) {
  const key = cacheRoot(inspected.project.projectRoot);
  const fingerprint = productOperatingReadFingerprint(inspected.project.projectRoot, inspected.storage);
  const cached = projectionReadCache.get(key);
  if (!fresh && cached?.projectId === inspected.project.projectId && cached.fingerprint === fingerprint) {
    return { projection: cached.projection, verification: { mode: "cached-verified-snapshot", cacheKey: `${cached.projection.projectionInputId}:${fingerprint}`, writeInvalidates: true } };
  }
  const projection = loadProductOperatingProjection({ projectRoot: inspected.project.projectRoot, projectId: inspected.project.projectId, storage: inspected.storage });
  projectionReadCache.set(key, { projectId: inspected.project.projectId, fingerprint, projection });
  return { projection, verification: { mode: "fresh-full-verification", cacheKey: `${projection.projectionInputId}:${fingerprint}`, writeInvalidates: true } };
}

async function readWorldSummary(inspected, { fresh = false } = {}) {
  const key = cacheRoot(inspected.project.projectRoot);
  const pointerFile = path.join(inspected.project.projectRoot, formatForVerifiedOwner(inspected.storage).directory, "world-model", "current.json");
  if (!fs.existsSync(pointerFile)) {
    worldSummaryReadCache.delete(key);
    return { summary: null, verification: { mode: "not-built", cacheKey: null, writeInvalidates: true } };
  }
  const pointerRaw = fs.readFileSync(pointerFile, "utf8");
  let pointer;
  try { pointer = JSON.parse(pointerRaw); } catch { fail("World Model pointer is invalid JSON.", "INVALID_WORLD_MODEL_POINTER"); }
  const cached = worldSummaryReadCache.get(key);
  if (!fresh && cached?.pointerRaw === pointerRaw) {
    return { summary: cached.summary, verification: { mode: "cached-verified-snapshot", cacheKey: `${cached.summary.worldModelId}:${cached.summary.worldModelHash}`, writeInvalidates: true } };
  }
  const { readWorldModel } = await import("./world-model.mjs");
  const world = (await readWorldModel({ root: inspected.project.projectRoot })).snapshot;
  if (pointer.worldModelId !== world.worldModelId || pointer.worldModelHash !== world.worldModelHash) fail("World Model pointer changed during continuity read.", "WORLD_MODEL_POINTER_MISMATCH");
  const summary = {
    worldModelId: world.worldModelId,
    worldModelHash: world.worldModelHash,
    graphSnapshotId: world.temporalProvenanceGraph?.graphSnapshotId || null,
    graphSnapshotHash: world.temporalProvenanceGraph?.graphSnapshotHash || null,
    sourceSnapshotId: world.temporalProvenanceGraph?.sourceSnapshotId || null,
  };
  worldSummaryReadCache.set(key, { pointerRaw, summary });
  return { summary, verification: { mode: "fresh-full-verification", cacheKey: `${summary.worldModelId}:${summary.worldModelHash}`, writeInvalidates: true } };
}

function findById(projectRoot, relative, id, prefix, validator, projectId, storage = null) {
  if (!new RegExp(`^${prefix}-[a-f0-9]{24}$`).test(id || "")) fail(`Invalid ${prefix} identity.`, "INVALID_PRODUCT_OPERATING_ID");
  const file = path.join(safeDirectory(projectRoot, relativeProjectArtifact(storage, ...relative.split("/").slice(1))), `${id}.json`);
  if (!fs.existsSync(file)) fail(`Product operating artifact not found: ${id}`, "PRODUCT_OPERATING_ARTIFACT_NOT_FOUND");
  return { file, artifact: validator(JSON.parse(fs.readFileSync(file, "utf8")), projectId, formatForVerifiedOwner(storage)) };
}

async function projectProductOperatingGraph(inspected) {
  const projection = loadProductOperatingProjection({ projectRoot: inspected.project.projectRoot, projectId: inspected.project.projectId, storage: inspected.storage });
  const { buildWorldModel } = await import("./world-model.mjs");
  const built = await buildWorldModel({ root: inspected.project.projectRoot, persist: true, productOperatingProjectionInput: projection });
  return { projectionInputId: projection.projectionInputId, worldModelId: built.snapshot.worldModelId, graphSnapshotId: built.snapshot.temporalProvenanceGraph.graphSnapshotId };
}

// Call only after every primary publication has returned successfully. A failed
// derived update neither erases that record nor schedules/replays any effect.
async function projectCommittedProductOperatingGraph(inspected) {
  try { return await projectProductOperatingGraph(inspected); }
  catch (error) {
    const reasonCode = typeof error?.code === "string" && /^[A-Z][A-Z0-9_:-]{0,127}$/.test(error.code)
      ? error.code : "PRODUCT_OPERATING_PROJECTION_FAILED";
    return { status: "deferred", reasonCode, ordinaryWorkBlocked: false };
  }
}

async function recordProductSignalUnlocked({ root = ".", statement, observedAt = new Date().toISOString(), evidenceIds = [], source = "" } = {}) {
  const inspected = readyProject(root, "a ProductSignal is recorded");
  const payload = { schemaVersion: SCHEMA_VERSION, kind: "ProductSignal", protocol: { name: formatForVerifiedOwner(inspected.storage).protocol("head-agent-core-product-operating-loop"), version: PRODUCT_OPERATING_LOOP_VERSION }, projectId: inspected.project.projectId, statement: requiredText(statement, "ProductSignal statement"), observedAt: new Date(observedAt).toISOString(), source: optionalText(source, "ProductSignal source"), evidenceIds: sortedIds(evidenceIds, "ProductSignal evidenceIds"), epistemicClass: "observed-fact", authority: "non-authoritative-observation", instructionAuthority: false, promotionAuthority: false };
  const signal = verifyProductSignal(artifact(payload, "product-signal", "signalId", "signalHash"), inspected.project.projectId, inspected.storage);
  const persisted = persistImmutable(inspected.project.projectRoot, PRODUCT_SIGNAL_DIRECTORY, signal.signalId, signal, inspected.storage);
  return { ...persisted, signal, productGraph: await projectCommittedProductOperatingGraph(inspected) };
}

async function recordProductHypothesisUnlocked({ root = ".", statement, signalIds = [], observationIds = [], rationale = "" } = {}) {
  const inspected = readyProject(root, "a ProductHypothesis is recorded");
  const ids = sortedIds(signalIds, "ProductHypothesis signalIds");
  const exactObservationIds = sortedIds(observationIds, "ProductHypothesis observationIds");
  if (!ids.length && !exactObservationIds.length) fail("ProductHypothesis requires at least one ProductSignal or exact Observation.", "PRODUCT_HYPOTHESIS_EVIDENCE_REQUIRED");
  for (const id of ids) findById(inspected.project.projectRoot, PRODUCT_SIGNAL_DIRECTORY, id, "product-signal", verifyProductSignal, inspected.project.projectId, inspected.storage);
  if (exactObservationIds.length) {
    const observationArtifacts = loadObservationArtifacts({ projectRoot: inspected.project.projectRoot, projectId: inspected.project.projectId, storage: inspected.storage });
    const knownObservationIds = new Set([
      ...observationArtifacts.observations.map((item) => item.observationId),
      ...observationArtifacts.derivedObservations.map((item) => item.derivedObservationId),
    ]);
    for (const id of exactObservationIds) if (!knownObservationIds.has(id)) fail(`ProductHypothesis Observation not found: ${id}`, "UNKNOWN_OBSERVATION");
  }
  const payload = { schemaVersion: SCHEMA_VERSION, kind: "ProductHypothesis", protocol: { name: formatForVerifiedOwner(inspected.storage).protocol("head-agent-core-product-operating-loop"), version: PRODUCT_HYPOTHESIS_VERSION }, projectId: inspected.project.projectId, statement: requiredText(statement, "ProductHypothesis statement"), rationale: optionalText(rationale, "ProductHypothesis rationale"), signalIds: ids, observationIds: exactObservationIds, referenceSemantics: "neutral", epistemicClass: "hypothesis", authority: "non-authoritative-hypothesis", instructionAuthority: false, promotionAuthority: false };
  const hypothesis = verifyProductHypothesis(artifact(payload, "product-hypothesis", "hypothesisId", "hypothesisHash"), inspected.project.projectId, inspected.storage);
  const persisted = persistImmutable(inspected.project.projectRoot, PRODUCT_HYPOTHESIS_DIRECTORY, hypothesis.hypothesisId, hypothesis, inspected.storage);
  return { ...persisted, hypothesis, productGraph: await projectCommittedProductOperatingGraph(inspected) };
}

function resolveFeature(projectRoot, projectId, featureResolution, initiativeCandidateSeed, storage = null) {
  if (!featureResolution || !["existing-feature", "candidate", "gap"].includes(featureResolution.kind)) fail("featureResolution.kind is required.", "INVALID_FEATURE_RESOLUTION");
  if (featureResolution.kind === "gap") return { resolution: { kind: "gap", reason: requiredText(featureResolution.reason, "Feature gap reason") }, featureCandidate: null };
  if (featureResolution.kind === "existing-feature") {
    const featureKey = stableKey(featureResolution.featureKey, "Existing Feature key");
    const product = readProductModelCanon({ projectRoot, storage }).model;
    const feature = product.features.find((item) => item.key === featureKey);
    if (!feature) fail(`Existing Product Canon Feature not found: ${featureKey}`, "PRODUCT_FEATURE_NOT_FOUND");
    return { resolution: { kind: "existing-feature", featureKey, productModelId: product.productModelId }, featureCandidate: null };
  }
  const feature = featureResolution.feature;
  if (!feature || typeof feature !== "object") fail("Feature candidate body is required.", "INVALID_FEATURE_RESOLUTION");
  const normalized = { key: stableKey(feature.key, "Feature candidate key"), name: requiredText(feature.name, "Feature candidate name"), description: optionalText(feature.description, "Feature candidate description"), capabilityKeys: sortedIds(feature.capabilityKeys || [], "Feature candidate capabilityKeys") };
  const payload = { schemaVersion: SCHEMA_VERSION, kind: "ProductFeatureCandidate", protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-product-operating-loop"), version: PRODUCT_OPERATING_LOOP_VERSION }, projectId, initiativeCandidateSeed, feature: normalized, epistemicClass: "inferred-meaning", authority: "candidate-not-product-canon", instructionAuthority: false, promotionAuthority: false };
  return { resolution: { kind: "candidate", pendingFeature: normalized }, featureCandidatePayload: payload };
}

function materializeFeatureSelection(projectRoot, projectId, candidate, featureResolution, storage = null) {
  const resolved = resolveFeature(projectRoot, projectId, featureResolution, initiativeSeed(candidate), storage);
  if (!resolved.featureCandidatePayload) return { resolution: resolved.resolution, featureCandidate: null };
  const featureCandidate = verifyProductFeatureCandidate(artifact(resolved.featureCandidatePayload, "product-feature-candidate", "featureCandidateId", "featureCandidateHash"), projectId, formatForVerifiedOwner(storage));
  return { resolution: { kind: "candidate", featureCandidateId: featureCandidate.featureCandidateId }, featureCandidate };
}

function selectedFeatureForReview(projectRoot, projectId, candidate, disposition, featureResolution, storage = null) {
  if (disposition === "reject") {
    if (featureResolution != null) fail("A rejected Product Initiative cannot resolve a Feature.", "REJECTED_PRODUCT_INITIATIVE_FEATURE_RESOLUTION");
    return { resolution: null, featureCandidate: null };
  }
  if (candidate.featureResolution != null) {
    if (featureResolution != null) fail("Review cannot replace the candidate's frozen Feature resolution.", "PRODUCT_INITIATIVE_FEATURE_RESOLUTION_ALREADY_FROZEN");
    const featureCandidate = candidate.featureResolution.kind === "candidate"
      ? findById(projectRoot, PRODUCT_FEATURE_CANDIDATE_DIRECTORY, candidate.featureResolution.featureCandidateId, "product-feature-candidate", verifyProductFeatureCandidate, projectId, storage).artifact
      : null;
    return { resolution: candidate.featureResolution, featureCandidate };
  }
  if (featureResolution == null) fail("Accepted Product Initiative review requires existing Feature, Feature candidate, or honest gap resolution.", "PRODUCT_INITIATIVE_REVIEW_FEATURE_RESOLUTION_REQUIRED");
  return materializeFeatureSelection(projectRoot, projectId, candidate, featureResolution, storage);
}

function replayFeatureSelection(projectRoot, projectId, candidate, disposition, featureResolution, persistedResolution, persistedFeatureCandidate = null, storage = null) {
  if (disposition === "reject") {
    if (featureResolution != null || persistedResolution !== null) fail("Product Initiative candidate already has a different ReviewDecision.", "PRODUCT_INITIATIVE_ALREADY_REVIEWED");
    return { resolution: null, featureCandidate: null };
  }
  if (candidate.featureResolution != null) {
    if (featureResolution != null || productOperatingCanonicalJson(candidate.featureResolution) !== productOperatingCanonicalJson(persistedResolution)) fail("Product Initiative candidate already has a different ReviewDecision.", "PRODUCT_INITIATIVE_ALREADY_REVIEWED");
    const featureCandidate = persistedResolution.kind === "candidate"
      ? findById(projectRoot, PRODUCT_FEATURE_CANDIDATE_DIRECTORY, persistedResolution.featureCandidateId, "product-feature-candidate", verifyProductFeatureCandidate, projectId, storage).artifact
      : null;
    return { resolution: persistedResolution, featureCandidate };
  }
  if (featureResolution == null) fail("Product Initiative candidate already has a different ReviewDecision.", "PRODUCT_INITIATIVE_ALREADY_REVIEWED");
  if (featureResolution.kind === "existing-feature") {
    const featureKey = stableKey(featureResolution.featureKey, "Existing Feature key");
    if (persistedResolution?.kind !== "existing-feature" || persistedResolution.featureKey !== featureKey) fail("Product Initiative candidate already has a different ReviewDecision.", "PRODUCT_INITIATIVE_ALREADY_REVIEWED");
    return { resolution: persistedResolution, featureCandidate: null };
  }
  if (featureResolution.kind === "gap") {
    const resolution = { kind: "gap", reason: requiredText(featureResolution.reason, "Feature gap reason") };
    if (productOperatingCanonicalJson(resolution) !== productOperatingCanonicalJson(persistedResolution)) fail("Product Initiative candidate already has a different ReviewDecision.", "PRODUCT_INITIATIVE_ALREADY_REVIEWED");
    return { resolution: persistedResolution, featureCandidate: null };
  }
  if (featureResolution.kind !== "candidate" || persistedResolution?.kind !== "candidate" || !persistedFeatureCandidate) fail("Product Initiative candidate already has a different ReviewDecision.", "PRODUCT_INITIATIVE_ALREADY_REVIEWED");
  const feature = featureResolution.feature;
  if (!feature || typeof feature !== "object") fail("Product Initiative candidate already has a different ReviewDecision.", "PRODUCT_INITIATIVE_ALREADY_REVIEWED");
  const normalized = { key: stableKey(feature.key, "Feature candidate key"), name: requiredText(feature.name, "Feature candidate name"), description: optionalText(feature.description, "Feature candidate description"), capabilityKeys: sortedIds(feature.capabilityKeys || [], "Feature candidate capabilityKeys") };
  if (persistedResolution.featureCandidateId !== persistedFeatureCandidate.featureCandidateId || productOperatingCanonicalJson(normalized) !== productOperatingCanonicalJson(persistedFeatureCandidate.feature)) fail("Product Initiative candidate already has a different ReviewDecision.", "PRODUCT_INITIATIVE_ALREADY_REVIEWED");
  return { resolution: persistedResolution, featureCandidate: persistedFeatureCandidate };
}

async function proposeProductInitiativeUnlocked({ root = ".", title, description = "", reasoning = "", hypothesisIds = [], featureResolution = null } = {}) {
  const inspected = readyProject(root, "a ProductInitiativeCandidate is proposed");
  const ids = sortedIds(hypothesisIds, "ProductInitiativeCandidate hypothesisIds");
  for (const id of ids) findById(inspected.project.projectRoot, PRODUCT_HYPOTHESIS_DIRECTORY, id, "product-hypothesis", verifyProductHypothesis, inspected.project.projectId, inspected.storage);
  const normalizedTitle = requiredText(title, "ProductInitiativeCandidate title");
  const normalizedDescription = optionalText(description, "ProductInitiativeCandidate description");
  const normalizedReasoning = optionalText(reasoning, "ProductInitiativeCandidate reasoning");
  if (!ids.length && !normalizedReasoning) fail("ProductInitiativeCandidate requires ProductHypothesis identities or explicit inline reasoning.", "PRODUCT_INITIATIVE_REASONING_REQUIRED");
  const seed = productOperatingDigest(productOperatingCanonicalJson({ projectId: inspected.project.projectId, title: normalizedTitle, description: normalizedDescription, hypothesisIds: ids, reasoning: normalizedReasoning }));
  const resolved = featureResolution == null ? { resolution: null, featureCandidatePayload: null } : resolveFeature(inspected.project.projectRoot, inspected.project.projectId, featureResolution, seed, inspected.storage);
  let featureCandidate = null;
  let resolution = resolved.resolution;
  if (resolved.featureCandidatePayload) {
    featureCandidate = verifyProductFeatureCandidate(artifact(resolved.featureCandidatePayload, "product-feature-candidate", "featureCandidateId", "featureCandidateHash"), inspected.project.projectId, inspected.storage);
    resolution = { kind: "candidate", featureCandidateId: featureCandidate.featureCandidateId };
  }
  const payload = { schemaVersion: SCHEMA_VERSION, kind: "ProductInitiativeCandidate", protocol: { name: formatForVerifiedOwner(inspected.storage).protocol("head-agent-core-product-operating-loop"), version: PRODUCT_OPERATING_LOOP_VERSION }, projectId: inspected.project.projectId, title: normalizedTitle, description: normalizedDescription, reasoning: normalizedReasoning, hypothesisIds: ids, featureResolution: resolution, epistemicClass: "inferred-meaning", authority: "candidate-not-approved-decision", instructionAuthority: false, promotionAuthority: false };
  const initiativeCandidate = verifyProductInitiativeCandidate(artifact(payload, "product-initiative-candidate", "initiativeCandidateId", "initiativeCandidateHash"), inspected.project.projectId, inspected.storage);
  const writes = [
    ...(featureCandidate ? [{ relative: PRODUCT_FEATURE_CANDIDATE_DIRECTORY, id: featureCandidate.featureCandidateId, document: featureCandidate }] : []),
    { relative: PRODUCT_INITIATIVE_CANDIDATE_DIRECTORY, id: initiativeCandidate.initiativeCandidateId, document: initiativeCandidate },
  ];
  const prepared = prepareImmutableWrites(inspected.project.projectRoot, writes, inspected.storage);
  for (const item of prepared.slice(0, -1)) persistPreparedImmutable(inspected.project.projectRoot, item);
  const persisted = persistPreparedImmutable(inspected.project.projectRoot, prepared.at(-1));
  return { ...persisted, initiativeCandidate, featureCandidate, productGraph: await projectCommittedProductOperatingGraph(inspected) };
}

async function reviewProductInitiativeUnlocked({ root = ".", initiativeCandidateId, disposition, rationale, featureResolution = null } = {}) {
  const inspected = readyProject(root, "a Product Initiative is reviewed");
  const candidate = findById(inspected.project.projectRoot, PRODUCT_INITIATIVE_CANDIDATE_DIRECTORY, initiativeCandidateId, "product-initiative-candidate", verifyProductInitiativeCandidate, inspected.project.projectId, inspected.storage).artifact;
  if (!["accept", "reject"].includes(disposition)) fail("Product Initiative review disposition must be accept or reject.", "INVALID_PRODUCT_INITIATIVE_REVIEW");
  const normalizedRationale = requiredText(rationale, "Product Initiative review rationale");
  const current = loadProductOperatingProjection({ projectRoot: inspected.project.projectRoot, projectId: inspected.project.projectId, storage: inspected.storage });
  const existingReview = current.initiativeReviews.find((review) => review.initiativeCandidateId === initiativeCandidateId) || null;
  if (existingReview) {
    if (existingReview.disposition !== disposition || existingReview.rationale !== normalizedRationale) fail("Product Initiative candidate already has a different ReviewDecision.", "PRODUCT_INITIATIVE_ALREADY_REVIEWED");
    const existingReviewed = current.reviewedInitiatives.find((item) => item.reviewDecisionId === existingReview.reviewDecisionId) || null;
    verifyReviewDecisionCandidateLineage(existingReview, candidate);
    const persistedResolution = disposition === "reject" ? null : existingReview.featureResolution || existingReviewed?.featureResolution || candidate.featureResolution || null;
    if (disposition === "accept" && !persistedResolution) fail("Stored Product Initiative review has no exact Feature selection; preserve the unresolved original.", "PRODUCT_INITIATIVE_REVIEW_RECOVERY_UNAVAILABLE");
    const persistedFeatureCandidate = existingReview.featureCandidate || current.featureCandidates.find((item) => item.featureCandidateId === persistedResolution?.featureCandidateId) || null;
    const selected = replayFeatureSelection(inspected.project.projectRoot, inspected.project.projectId, candidate, disposition, featureResolution, persistedResolution, persistedFeatureCandidate, inspected.storage);
    return { status: disposition === "accept" ? "initiative_accepted" : "initiative_rejected", persistenceStatus: "existing", reviewDecision: existingReview, reviewedInitiative: existingReviewed, featureCandidate: selected.featureCandidate, productCanonMutated: false, productGraph: await projectCommittedProductOperatingGraph(inspected) };
  }
  const selected = selectedFeatureForReview(inspected.project.projectRoot, inspected.project.projectId, candidate, disposition, featureResolution, inspected.storage);
  const payload = { schemaVersion: SCHEMA_VERSION, kind: "ReviewDecision", protocol: { name: formatForVerifiedOwner(inspected.storage).protocol("head-agent-core-product-initiative-review"), version: PRODUCT_OPERATING_LOOP_VERSION }, projectId: inspected.project.projectId, sessionId: inspected.state.sessionId, decisionScope: "product-initiative", initiativeCandidateId, initiativeCandidateHash: candidate.initiativeCandidateHash, disposition, rationale: normalizedRationale, featureResolution: selected.resolution, featureCandidate: selected.featureCandidate, authority: "explicit-user-product-initiative-review", instructionAuthority: true, promotionAuthority: disposition === "accept" };
  const reviewDecision = verifyProductInitiativeReviewDecision(artifact(payload, "product-initiative-review", "reviewDecisionId", "reviewDecisionHash"), inspected.project.projectId, inspected.storage);
  verifyReviewDecisionCandidateLineage(reviewDecision, candidate);
  const reviewedInitiative = disposition === "accept" ? buildReviewedInitiative(candidate, reviewDecision, inspected.storage) : null;
  const writes = [
    { relative: PRODUCT_INITIATIVE_REVIEW_DIRECTORY, id: reviewDecision.reviewDecisionId, document: reviewDecision },
  ];
  const prepared = prepareImmutableWrites(inspected.project.projectRoot, writes, inspected.storage);
  for (const item of prepared) persistPreparedImmutable(inspected.project.projectRoot, item);
  return { status: disposition === "accept" ? "initiative_accepted" : "initiative_rejected", persistenceStatus: "recorded", reviewDecision, reviewedInitiative, featureCandidate: selected.featureCandidate, productCanonMutated: false, productGraph: await projectCommittedProductOperatingGraph(inspected) };
}

async function observeProductOutcomeUnlocked({ root = ".", changeSetId, statement, epistemicClass = "observed-fact", evidenceIds = [], initiativeId = "" } = {}) {
  const inspected = readyProject(root, "an OutcomeObservation is recorded");
  const changeSet = readChangeSet({ root: inspected.project.projectRoot, changeSetId }).changeSet;
  const result = readLineageArtifact({ root: inspected.project.projectRoot, artifactId: changeSet.resultPacketId }).artifact;
  const review = readLineageArtifact({ root: inspected.project.projectRoot, artifactId: changeSet.reviewDecisionId }).artifact;
  if (result.kind !== "ResultPacket" || review.kind !== "ReviewDecision" || review.disposition !== "accept" || review.resultPacketId !== result.resultPacketId) fail("OutcomeObservation requires accepted execution lineage.", "OUTCOME_EXECUTION_LINEAGE_REQUIRED");
  if (!["observed-fact", "derived-projection"].includes(epistemicClass)) fail("OutcomeObservation epistemicClass must be observed-fact or derived-projection.", "INVALID_OUTCOME_EPISTEMIC_CLASS");
  if (initiativeId && !loadProductOperatingProjection({ projectRoot: inspected.project.projectRoot, projectId: inspected.project.projectId, storage: inspected.storage }).reviewedInitiatives.some((item) => item.initiativeId === initiativeId)) fail("Reviewed Product Initiative not found.", "UNKNOWN_REVIEWED_PRODUCT_INITIATIVE");
  const payload = { schemaVersion: SCHEMA_VERSION, kind: "OutcomeObservation", protocol: { name: formatForVerifiedOwner(inspected.storage).protocol("head-agent-core-product-operating-loop"), version: PRODUCT_OPERATING_LOOP_VERSION }, projectId: inspected.project.projectId, initiativeId: initiativeId || null, changeSetId: changeSet.changeSetId, resultPacketId: result.resultPacketId, executionReviewDecisionId: review.reviewDecisionId, statement: requiredText(statement, "OutcomeObservation statement"), evidenceIds: sortedIds(evidenceIds, "OutcomeObservation evidenceIds"), epistemicClass, authority: "non-authoritative-outcome-evidence", instructionAuthority: false, promotionAuthority: false };
  const outcomeObservation = verifyOutcomeObservation(artifact(payload, "outcome-observation", "outcomeObservationId", "outcomeObservationHash"), inspected.project.projectId, inspected.storage);
  const persisted = persistImmutable(inspected.project.projectRoot, OUTCOME_OBSERVATION_DIRECTORY, outcomeObservation.outcomeObservationId, outcomeObservation, inspected.storage);
  return { ...persisted, outcomeObservation, featureStatusMutated: false, successJudgmentRecorded: false, productGraph: await projectCommittedProductOperatingGraph(inspected) };
}

async function serializedProductMutation(options, action, operation) {
  const requested = options && typeof options === "object" ? options : {};
  const inspected = readyProject(requested.root || ".", action);
  return (await withProjectMutationAsync(
    { root: inspected.project.projectRoot, scope: "product-operating-write" },
    () => operation({ ...requested, root: inspected.project.projectRoot }),
  ));
}

export async function recordProductSignal(options = {}) {
  return (await serializedProductMutation(options, "a ProductSignal is recorded", recordProductSignalUnlocked));
}

export async function recordProductHypothesis(options = {}) {
  return (await serializedProductMutation(options, "a ProductHypothesis is recorded", recordProductHypothesisUnlocked));
}

export async function proposeProductInitiative(options = {}) {
  return (await serializedProductMutation(options, "a ProductInitiativeCandidate is proposed", proposeProductInitiativeUnlocked));
}

export async function reviewProductInitiative(options = {}) {
  return (await serializedProductMutation(options, "a Product Initiative is reviewed", reviewProductInitiativeUnlocked));
}

export async function observeProductOutcome(options = {}) {
  return (await serializedProductMutation(options, "an OutcomeObservation is recorded", observeProductOutcomeUnlocked));
}

export function inspectProductOperatingLoop({ root = ".", fresh = false } = {}) {
  const inspected = readyProject(root, "Product Operating Loop inspection");
  const read = readProductOperatingProjection(inspected, { fresh });
  const projection = read.projection;
  const artifactCount = Object.keys(DIRECTORIES).reduce((count, key) => count + projection[key].length, 0);
  return { status: artifactCount ? "active" : "not_started", projectId: inspected.project.projectId, sessionId: inspected.state.sessionId, projection, readVerification: read.verification, defaultPath: "ephemeral-note-then-persist-only-at-handoff-audit-product-state-or-cross-run-boundaries", authority: { observations: "evidence-only", hypotheses: "non-authoritative", initiativeCandidates: "candidate", reviewedInitiatives: "explicit-user-reviewed-but-not-product-canon", featureCandidates: "candidate-until-separate-product-canon-review", outcomes: "evidence-only", graph: "derived-projection" } };
}

export async function buildHeadContinuitySnapshot({ root = ".", fresh = false } = {}) {
  const inspected = readyProject(root, "HEAD continuity is read");
  const productRead = readProductOperatingProjection(inspected, { fresh });
  const projection = productRead.projection;
  let worldRead;
  try {
    worldRead = await readWorldSummary(inspected, { fresh });
  } catch { worldRead = { summary: null, verification: { mode: "unavailable", cacheKey: null, writeInvalidates: true } }; }
  const snapshot = {
    schemaVersion: SCHEMA_VERSION, kind: formatForVerifiedOwner(inspected.storage).kind("HEADContinuitySnapshot"), protocol: { name: formatForVerifiedOwner(inspected.storage).protocol("head-agent-core-head-continuity"), version: PRODUCT_OPERATING_LOOP_VERSION },
    projectId: inspected.project.projectId, sessionId: inspected.state.sessionId, sessionMode: inspected.state.mode,
    activeRunId: inspected.state.activeRunId || null, currentWholePlanId: inspected.state.currentWholePlanId || null,
    activeExecutionContractId: inspected.state.activeExecutionContractId || null, lastResultPacketId: inspected.state.lastResultPacketId || null,
    lastReviewDecisionId: inspected.state.lastReviewDecisionId || null, latestCheckpointId: inspected.state.latestCheckpoint || null,
    productModelId: readProductModelCanon({ projectRoot: inspected.project.projectRoot, storage: inspected.storage }).model.productModelId,
    worldModel: worldRead.summary,
    productOperatingProjectionId: projection.projectionInputId,
    productSignalIds: projection.signals.map((item) => item.signalId),
    productHypothesisIds: projection.hypotheses.map((item) => item.hypothesisId),
    reviewedProductInitiativeIds: projection.reviewedInitiatives.map((item) => item.initiativeId),
    outcomeObservationIds: projection.outcomeObservations.map((item) => item.outcomeObservationId),
    authority: "on-demand-derived-reference-view", persisted: false, recoveryAuthority: false, instructionAuthority: false, promotionAuthority: false,
    recoveryCanon: `${relativeProjectArtifact(inspected.storage, "sessions", "current.json")} and Session/Run checkpoints`, objectiveRewrite: false,
  };
  const snapshotHash = productOperatingDigest(productOperatingCanonicalJson(snapshot));
  return { status: "derived", snapshot: { ...snapshot, snapshotId: `${formatForVerifiedOwner(inspected.storage).value("head-continuity")}-${snapshotHash.slice(0, 24)}`, snapshotHash }, readVerification: { productOperating: productRead.verification, worldModel: worldRead.verification } };
}

// Canonical public name and historical name share one implementation.
export { buildHeadContinuitySnapshot as buildLodeContinuitySnapshot };

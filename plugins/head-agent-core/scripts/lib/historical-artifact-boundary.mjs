import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { defaultSessionStatePath, sessionStatePath } from "./session-routing.mjs";
import { inspectProject } from "./lode-core.mjs";
import {
  ONBOARDING_STATE_PROTOCOL_VERSION,
  onboardingCanonicalJson,
  verifyOnboardingState,
} from "./onboarding-contract.mjs";
import { verifyProductModelRevisionForProjection } from "./onboarding-projection.mjs";
import { readProductModelCanon } from "./product-model.mjs";
import { inspectRecoveryCheckpointBasis, readRecoveryCheckpoint } from "./compaction-recovery.mjs";
import { withProjectMutation } from "./project-mutation-lock.mjs";
import {
  HISTORICAL_BOUNDARY_PROTOCOL_VERSION,
  historicalBoundaryCanonicalJson,
  historicalBoundaryDigest,
  historicalBoundaryStorageFiles,
  historicalIntegrityBasis,
  readHistoricalBoundaryApplication,
  verifyHistoricalArtifactBoundary,
  verifyHistoricalBoundaryCommit,
  verifyHistoricalBoundaryReceipt,
  verifyHistoricalInventoryEntries,
} from "./historical-artifact-boundary-store.mjs";

import { formatForVerifiedOwner, familyFormatForOriginal, relativeProjectArtifact } from "./project-storage-format.mjs";

const verifiedInventories = new WeakSet();
const MAX_BASIS_FILES = 16;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function fail(message, code = "HISTORICAL_BOUNDARY_APPLICATION_ERROR") {
  throw Object.assign(new Error(message), { code });
}

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { fail(`${label} is invalid JSON: ${error.message}`, "INVALID_HISTORICAL_BOUNDARY_BASIS"); }
}

function relativePath(root, file) {
  return path.relative(root, file).replaceAll("\\", "/");
}

function fileBasis(projectRoot, relative, id = null) {
  const file = path.join(projectRoot, ...relative.split("/"));
  if (!fs.existsSync(file) || !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) {
    fail(`Required application-basis file is unavailable: ${relative}`, "HISTORICAL_BOUNDARY_BASIS_UNREADABLE");
  }
  const bytes = fs.readFileSync(file);
  return { path: relative, id, byteLength: bytes.byteLength, sha256: historicalBoundaryDigest(bytes) };
}

function verifyReferencedP2(projectRoot, state, storage) {
  const before = inspectRecoveryCheckpointBasis({ root: projectRoot }).basis;
  const files = [];
  if (state.latestCheckpoint) {
    const verified = readRecoveryCheckpoint({ root: projectRoot, checkpointId: state.latestCheckpoint });
    const relative = relativePath(projectRoot, verified.file);
    const checkpoint = readJson(verified.file, "Current recovery checkpoint");
    if (historicalBoundaryCanonicalJson(checkpoint) !== historicalBoundaryCanonicalJson(verified.checkpoint)) {
      fail("Current checkpoint bytes changed after current verification.", "HISTORICAL_BOUNDARY_P2_UNREADABLE");
    }
    files.push(fileBasis(projectRoot, relative, state.latestCheckpoint));
  }
  const runIds = [...new Set([state.activeRunId, state.pendingReview?.runId, state.lastReviewedRunId].filter(Boolean))];
  for (const runId of runIds) {
    const relative = relativeProjectArtifact(storage, "sessions", "runs", runId, "run.json");
    files.push(fileBasis(projectRoot, relative, runId));
  }
  if (files.length > MAX_BASIS_FILES) fail("Current P2 basis exceeds its bound.", "HISTORICAL_BOUNDARY_LIMIT");
  const after = inspectRecoveryCheckpointBasis({ root: projectRoot }).basis;
  if (before.basisId !== after.basisId || before.basisHash !== after.basisHash) {
    fail("Current P2 changed while its application basis was captured.", "HISTORICAL_BOUNDARY_P2_UNREADABLE");
  }
  return {
    semanticBasisId: after.basisId,
    semanticBasisHash: after.basisHash,
    files: files.sort((a, b) => a.path.localeCompare(b.path, "en")),
  };
}

function verifyHistoricalRevisionInterpretations(entries, projectRoot, storage) {
  for (const entry of entries.filter((item) => item.role === "historical-product-revision")) {
    const file = path.join(projectRoot, ...entry.path.split("/"));
    const document = readJson(file, "Historical Product Model revision");
    if (document.productModelId !== entry.artifactId) {
      fail("Historical Product revision identity does not match its inventory entry.", "HISTORICAL_BOUNDARY_REVISION_INTERPRETATION_MISMATCH");
    }
    let interpretationMode = "opaque-legacy-revision";
    try {
      verifyProductModelRevisionForProjection(document, storage);
      interpretationMode = "current-typed-with-historical-provenance";
    } catch {
      // The external validator owns legacy semantic parsing. Current Core owns
      // only the independent typed-versus-opaque interpretation boundary.
    }
    if (entry.interpretationMode !== interpretationMode) {
      fail("Historical Product revision interpretation was not independently derived by current Core.", "HISTORICAL_BOUNDARY_REVISION_INTERPRETATION_MISMATCH");
    }
  }
}

export function captureHistoricalBoundaryApplicationBasis({ root = "." } = {}) {
  const inspected = inspectProject(root);
  if (inspected.status !== "ready") fail("Project and Session must be independently current-readable.", "HISTORICAL_BOUNDARY_P2_UNREADABLE");
  const projectRoot = inspected.project.projectRoot;
  // Product onboarding is Project-scoped and retains its original review
  // Session. A routed Session owns only its own current recovery/effect basis.
  const onboardingOwner = inspectProject(projectRoot, { sessionScope: "default" });
  if (onboardingOwner.status !== "ready" || onboardingOwner.project.projectId !== inspected.project.projectId) {
    fail("Common onboarding Session identity must be independently readable.", "HISTORICAL_BOUNDARY_P2_UNREADABLE");
  }
  const stateFile = path.join(projectRoot, relativeProjectArtifact(inspected.storage, "onboarding", "current.json"));
  if (!fs.existsSync(stateFile)) fail("Onboarding state is missing.", "HISTORICAL_BOUNDARY_STATE_UNSUPPORTED");
  const onboardingState = verifyOnboardingState(readJson(stateFile, "Onboarding state"), {
    projectId: inspected.project.projectId,
    sessionId: onboardingOwner.state.sessionId,
    storage: inspected.storage,
  });
  if (onboardingState.protocol?.version !== ONBOARDING_STATE_PROTOCOL_VERSION || onboardingState.phase !== "ready") {
    fail("The first migration slice supports only current ready onboarding state.", "HISTORICAL_BOUNDARY_STATE_UNSUPPORTED");
  }
  const canon = readProductModelCanon({ projectRoot, storage: inspected.storage });
  if (canon.status !== "present") fail("A real current Product Canon is required.", "HISTORICAL_BOUNDARY_CANON_MISSING");
  if (canon.model.productModelId !== onboardingState.productModelId) fail("Current Canon and onboarding state do not agree.", "HISTORICAL_BOUNDARY_CANON_DRIFT");
  const revisionRelative = relativeProjectArtifact(inspected.storage, "onboarding", "product-model-revisions", `${onboardingState.productModelId}.json`);
  const revisionFile = path.join(projectRoot, ...revisionRelative.split("/"));
  const revision = verifyProductModelRevisionForProjection(readJson(revisionFile, "Current Product Model revision"), inspected.storage);
  if (revision.productModelId !== canon.model.productModelId || revision.productModelHash !== canon.model.productModelHash) {
    fail("Current Canon revision is not independently readable.", "HISTORICAL_BOUNDARY_CURRENT_CANON_REVISION_UNSUPPORTED");
  }
  const projectFile = fileBasis(projectRoot, relativeProjectArtifact(inspected.storage, "project.json"), inspected.project.projectId);
  const sessionFile = fileBasis(projectRoot, path.relative(projectRoot, sessionStatePath(projectRoot, inspected.storage)).split(path.sep).join("/"), inspected.state.sessionId);
  const stateBasis = fileBasis(projectRoot, relativeProjectArtifact(inspected.storage, "onboarding", "current.json"), onboardingState.pointerHash);
  const canonBasis = fileBasis(projectRoot, canon.relativePath, canon.model.productModelId);
  const referencedP2 = verifyReferencedP2(projectRoot, inspected.state, inspected.storage);
  return {
    projectRoot,
    storage: inspected.storage,
    projectId: inspected.project.projectId,
    sessionId: inspected.state.sessionId,
    onboardingState,
    canon: { productModelId: canon.model.productModelId, productModelHash: canon.model.productModelHash, ...canonBasis },
    appliedAtBasis: {
      project: projectFile,
      session: sessionFile,
      ...(onboardingOwner.state.sessionId !== inspected.state.sessionId ? {
        onboardingSession: fileBasis(projectRoot, relativePath(projectRoot, defaultSessionStatePath(projectRoot, inspected.storage)), onboardingOwner.state.sessionId),
      } : {}),
      onboardingState: {
        ...stateBasis,
        candidateSetId: onboardingState.candidateSetId,
        latestReviewDecisionId: onboardingState.latestReviewDecisionId,
        productModelId: onboardingState.productModelId,
      },
      canon: canonBasis,
      referencedP2,
    },
  };
}

export function createVerifiedHistoricalInventoryCapability({ root = ".", projectId, entries, validation, storage } = {}) {
  const projectRoot = fs.realpathSync(path.resolve(root));
  if (!validation || validation.status !== "complete-ready-verified" || validation.instructionAuthority !== false
    || validation.promotionAuthority !== false || !Array.isArray(validation.supportedCandidateVersions)
    || !/^onboarding-candidates-[a-f0-9]{24}$/.test(validation.historicalReadyCandidateSetId || "")
    || !/^onboarding-review-decision-[a-f0-9]{24}$/.test(validation.historicalReadyReviewDecisionId || "")
    || !/^product-model-[a-f0-9]{24}$/.test(validation.historicalResultingProductModelId || "")
    || validation.supportedCandidateVersions.some((version) => !["0.1.0", "0.2.0", "0.3.0"].includes(version))) {
    fail("External historical validation is incomplete.", "HISTORICAL_BOUNDARY_EXTERNAL_VALIDATION_REQUIRED");
  }
  verifyHistoricalInventoryEntries(entries, { projectRoot, projectId, verifyBytes: true, storage });
  verifyHistoricalRevisionInterpretations(entries, projectRoot, storage);
  const basis = captureHistoricalBoundaryApplicationBasis({ root: projectRoot });
  if (basis.projectId !== projectId) fail("Historical inventory belongs to another Project.", "HISTORICAL_BOUNDARY_PROJECT_MISMATCH");
  const capability = deepFreeze({
    projectRoot,
    projectId,
    entries: structuredClone(entries),
    validation: structuredClone(validation),
    appliedAtBasis: structuredClone(basis.appliedAtBasis),
  });
  verifiedInventories.add(capability);
  return capability;
}

function documentIdentity(payload, idField, hashField, prefix) {
  const hash = historicalBoundaryDigest(historicalBoundaryCanonicalJson(payload));
  return { ...payload, [idField]: `${prefix}-${hash.slice(0, 24)}`, [hashField]: hash };
}

function buildBoundary({ projectId, entries, appliedAtBasis, validatedHistoricalApproval, storage }) {
  const inventoryHash = historicalBoundaryDigest(historicalBoundaryCanonicalJson({ projectId, entries }));
  const payload = {
    schemaVersion: 1,
    kind: "HistoricalArtifactBoundary",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-historical-artifact-boundary"), version: HISTORICAL_BOUNDARY_PROTOCOL_VERSION },
    projectId,
    inventoryHash,
    entries,
    validatedHistoricalApproval,
    appliedAtBasis,
    authorityClass: "evidence",
    instructionAuthority: false,
    promotionAuthority: false,
  };
  const boundaryHash = historicalBoundaryDigest(historicalBoundaryCanonicalJson(payload));
  return { ...payload, boundaryId: `historical-boundary-${inventoryHash.slice(0, 24)}`, boundaryHash };
}

function buildReceipt(boundary) {
  return documentIdentity({
    schemaVersion: 1,
    kind: "HistoricalBoundaryApplicationReceipt",
    protocol: { name: familyFormatForOriginal("head-agent-core-historical-artifact-boundary", boundary).protocol("head-agent-core-historical-boundary-application"), version: HISTORICAL_BOUNDARY_PROTOCOL_VERSION },
    projectId: boundary.projectId,
    boundaryId: boundary.boundaryId,
    boundaryHash: boundary.boundaryHash,
    inventoryHash: boundary.inventoryHash,
    appliedAtBasisHash: historicalBoundaryDigest(historicalBoundaryCanonicalJson(boundary.appliedAtBasis)),
    authorityClass: "evidence",
    instructionAuthority: false,
    promotionAuthority: false,
  }, "receiptId", "receiptHash", "historical-boundary-receipt");
}

function buildCommit(boundary, receipt) {
  return documentIdentity({
    schemaVersion: 1,
    kind: "HistoricalBoundaryCommitMarker",
    protocol: { name: familyFormatForOriginal("head-agent-core-historical-artifact-boundary", boundary).protocol("head-agent-core-historical-boundary-commit"), version: HISTORICAL_BOUNDARY_PROTOCOL_VERSION },
    projectId: boundary.projectId,
    boundaryId: boundary.boundaryId,
    boundaryHash: boundary.boundaryHash,
    receiptId: receipt.receiptId,
    receiptHash: receipt.receiptHash,
    inventoryHash: boundary.inventoryHash,
    historicalIntegrityBasisHash: historicalBoundaryDigest(historicalBoundaryCanonicalJson(historicalIntegrityBasis(boundary, receipt))),
    authorityClass: "evidence",
    instructionAuthority: false,
    promotionAuthority: false,
  }, "commitId", "commitHash", "historical-boundary-commit");
}

function exactJsonWrite(file, document) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = `${JSON.stringify(document, null, 2)}\n`;
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, "utf8") !== content) fail(`Create-only historical artifact conflicts: ${relativePath(path.dirname(file), file)}`, "HISTORICAL_BOUNDARY_DIVERGENT_REPLAY");
    return false;
  }
  fs.writeFileSync(file, content, { flag: "wx" });
  return true;
}

function assertInventoryMatchesReadyState(capability, basis) {
  if (capability.projectRoot !== basis.projectRoot || capability.projectId !== basis.projectId) fail("Historical inventory belongs to another Project.", "HISTORICAL_BOUNDARY_PROJECT_MISMATCH");
  const candidateIds = capability.entries.filter((entry) => entry.role === "historical-candidate-set").map((entry) => entry.artifactId);
  const reviewIds = capability.entries.filter((entry) => entry.role === "historical-review").map((entry) => entry.artifactId);
  if (!candidateIds.includes(capability.validation.historicalReadyCandidateSetId)
    || !reviewIds.includes(capability.validation.historicalReadyReviewDecisionId)) {
    fail("Historical inventory does not cover its externally verified ready approval.", "HISTORICAL_BOUNDARY_INCOMPLETE");
  }
  const historicalResult = capability.entries.find((entry) => entry.role === "historical-product-revision"
    && entry.artifactId === capability.validation.historicalResultingProductModelId);
  if (!historicalResult || historicalResult.interpretationMode !== "current-typed-with-historical-provenance") {
    fail("Historical resulting Canon revision is not independently current-readable.", "HISTORICAL_BOUNDARY_CURRENT_CANON_REVISION_UNSUPPORTED");
  }
  if (basis.onboardingState.candidateSetId === capability.validation.historicalReadyCandidateSetId
    && basis.onboardingState.latestReviewDecisionId !== capability.validation.historicalReadyReviewDecisionId) {
    fail("Live legacy ready pointer does not match the verified terminal review.", "HISTORICAL_BOUNDARY_INCOMPLETE");
  }
}

export function applyHistoricalArtifactBoundary({ root = ".", verifiedInventory, hostMode } = {}) {
  if (hostMode !== "explicit-one-shot") fail("Historical boundary apply requires explicit one-shot Host mode.", "HISTORICAL_BOUNDARY_HOST_MODE_REQUIRED");
  if (!verifiedInventories.has(verifiedInventory)) fail("Serialized or unverified historical inventory cannot be applied.", "HISTORICAL_BOUNDARY_CAPABILITY_REQUIRED");
  return withProjectMutation({ root, scope: "historical-boundary" }, () => {
    const inspected = inspectProject(root);
    if (inspected.status !== "ready") fail("Project and Session must be independently current-readable.", "HISTORICAL_BOUNDARY_P2_UNREADABLE");
    const projectRoot = inspected.project.projectRoot;
    if (verifiedInventory.projectRoot !== projectRoot || verifiedInventory.projectId !== inspected.project.projectId) {
      fail("Historical inventory belongs to another Project.", "HISTORICAL_BOUNDARY_PROJECT_MISMATCH");
    }
    verifyHistoricalInventoryEntries(verifiedInventory.entries, { projectRoot, projectId: inspected.project.projectId, verifyBytes: true, storage: inspected.storage });
    const inventoryHash = historicalBoundaryDigest(historicalBoundaryCanonicalJson({
      projectId: inspected.project.projectId,
      entries: verifiedInventory.entries,
    }));
    const existing = readHistoricalBoundaryApplication({ root: projectRoot, projectId: inspected.project.projectId, allowAbsent: true, verifyBytes: true, storage: inspected.storage });
    // A committed boundary is governed by historicalIntegrityBasis, not by the
    // one-time appliedAtBasis. Normal current Canon/Session/P2 evolution must
    // therefore make an exact retry read-only rather than look like drift.
    if (existing?.commit) {
      if (existing.boundary.inventoryHash !== inventoryHash
        || historicalBoundaryCanonicalJson(existing.boundary.entries) !== historicalBoundaryCanonicalJson(verifiedInventory.entries)) {
        fail("A different historical inventory is already committed.", "HISTORICAL_BOUNDARY_DIVERGENT_REPLAY");
      }
      return { status: "already-applied", writes: 0, boundary: existing.boundary, receipt: existing.receipt, commit: existing.commit, coverage: existing.coverage };
    }
    verifyHistoricalRevisionInterpretations(verifiedInventory.entries, projectRoot, inspected.storage);
    const basis = captureHistoricalBoundaryApplicationBasis({ root });
    if (historicalBoundaryCanonicalJson(verifiedInventory.appliedAtBasis) !== historicalBoundaryCanonicalJson(basis.appliedAtBasis)) {
      fail(existing ? "Incomplete historical boundary basis drifted before final commit."
        : "Historical migration preflight basis changed before first application.",
      existing ? "INCOMPLETE_HISTORICAL_BOUNDARY_BASIS_DRIFT" : "HISTORICAL_BOUNDARY_PREFLIGHT_BASIS_DRIFT");
    }
    assertInventoryMatchesReadyState(verifiedInventory, basis);
    const candidate = buildBoundary({
      projectId: basis.projectId,
      storage: inspected.storage,
      entries: [...verifiedInventory.entries],
      appliedAtBasis: basis.appliedAtBasis,
      validatedHistoricalApproval: {
        candidateSetId: verifiedInventory.validation.historicalReadyCandidateSetId,
        reviewDecisionId: verifiedInventory.validation.historicalReadyReviewDecisionId,
        resultingProductModelId: verifiedInventory.validation.historicalResultingProductModelId,
      },
    });
    if (existing && (existing.boundary.inventoryHash !== candidate.inventoryHash
      || historicalBoundaryCanonicalJson(existing.boundary.appliedAtBasis) !== historicalBoundaryCanonicalJson(basis.appliedAtBasis))) {
      fail("Incomplete historical boundary basis drifted before final commit.", "INCOMPLETE_HISTORICAL_BOUNDARY_BASIS_DRIFT");
    }
    const boundary = existing?.boundary || candidate;
    const receipt = existing?.receipt || buildReceipt(boundary);
    const commit = buildCommit(boundary, receipt);
    verifyHistoricalArtifactBoundary(boundary, { projectRoot: basis.projectRoot, projectId: basis.projectId, verifyBytes: true, storage: inspected.storage });
    verifyHistoricalBoundaryReceipt(receipt, boundary);
    verifyHistoricalBoundaryCommit(commit, boundary, receipt);
    const files = historicalBoundaryStorageFiles(basis.projectRoot, boundary.boundaryId, inspected.storage);
    let writes = 0;
    writes += Number(exactJsonWrite(files.boundary, boundary));
    writes += Number(exactJsonWrite(files.receipt, receipt));
    writes += Number(exactJsonWrite(files.commit, commit));
    return { status: "applied", writes, boundary, receipt, commit, coverage: readHistoricalBoundaryApplication({ root: basis.projectRoot, projectId: basis.projectId, requireCommitted: true, storage: inspected.storage }).coverage };
  });
}

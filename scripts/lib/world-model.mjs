import { stabilizeTemporalRelationIdentities } from "./temporal-relation-identity.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { inspectProject, SCHEMA_VERSION } from "./lode-core.mjs";
import {
  buildGitDecisionHistory,
  classifyGitReference,
  GIT_DECISION_HISTORY_VERSION,
  GIT_HISTORY_ADAPTER_VERSION,
  queryGitDecisionHistory,
  verifyGitDecisionHistory,
} from "./git-history.mjs";
import { buildSemanticGraph, querySemanticGraph, SEMANTIC_GRAPH_VERSION, verifySemanticGraph } from "./semantic-graph.mjs";
import { collectSourceRelationEvidence, SOURCE_RELATION_EVIDENCE_VERSION } from "./source-relation-evidence.mjs";
import { normalizeProductModelDocument, productModelDocument, PRODUCT_MODEL_RELATIVE_PATH, PRODUCT_MODEL_VERSION, readProductModelCanon } from "./product-model.mjs";
import { withProjectMutation } from "./project-mutation-lock.mjs";
import { loadOnboardingGraphProjection, ONBOARDING_GRAPH_PROJECTION_VERSION } from "./onboarding-projection.mjs";
import { loadProductPolicyGraphProjection, PRODUCT_POLICY_GRAPH_PROJECTION_VERSION } from "./product-policy-projection.mjs";
import { FEATURE_MAPPING_VERSION, loadFeatureMappingProjection } from "./feature-mapping-projection.mjs";
import {
  CHANGE_SET_PROJECTION_VERSION,
  CHANGE_SET_VERSION,
  loadChangeSetProjection,
  VCS_EVIDENCE_VERSION,
} from "./change-set-projection.mjs";
import { DOCUMENT_CHANGE_GRAPH_PROJECTION_VERSION, loadDocumentChangeProjection } from "./document-change-projection.mjs";
import { loadProductOperatingProjection, PRODUCT_OPERATING_LOOP_VERSION } from "./product-operating-projection.mjs";
import { loadReleaseObservationProjection, RELEASE_OBSERVATION_VERSION } from "./release-observation-projection.mjs";
import { loadObservationProjection } from "./observation-projection.mjs";
import { OBSERVATION_PROTOCOL_VERSION } from "./observation-contract.mjs";
import {
  buildRepositoryScanInput,
  createRepositoryScanComputeAdapter,
  executeRepositoryScan,
  inspectRepositoryScanFreshness,
  inspectRepositoryScanForWorld,
  managedRootFilesForProject,
  REPOSITORY_SCAN_DEFAULTS,
  REPOSITORY_SCAN_EXCLUDED_DIRECTORIES,
  REPOSITORY_SCAN_VERSION,
  scanRepositoryReference,
  validateRepositoryScanExecution,
  validateRepositoryScanResult,
} from "./repository-scan.mjs";
import { buildRepositorySourceScope, readRepositorySourceScope } from "./repository-source-scope.mjs";
import {
  buildTemporalProvenanceGraph,
  currentTemporalLogicalEntityIds,
  deriveIncrementalLogicalLineageState,
  filterLogicalLineageStateForCurrentTemporalEntities,
  filterRevisionParentsForCurrentTemporalEntities,
  TEMPORAL_PROVENANCE_VERSION,
  ownWorldSnapshotForTemporalScope,
  verifyTemporalProvenanceGraph,
} from "./temporal-provenance.mjs";
import {
  buildExternalRuntimeState,
  EXTERNAL_RUNTIME_STATE_VERSION,
  queryExternalRuntimeState,
  RUNTIME_STATE_ADAPTER_VERSION,
  runtimeStateAdapterFromDescriptor,
  verifyExternalRuntimeState,
} from "./runtime-state.mjs";
import {
  createWorldModelStoreAdapter,
  WORLD_MODEL_STORAGE_CONTRACT,
} from "./world-model-store.mjs";
import {
  createGraphProjectionAdapter,
  GRAPH_PROJECTION_ADAPTER_VERSION,
  inspectGraphProjection,
  materializeGraphProjection,
  prepareGraphProjection,
  publishPreparedGraphProjection,
  completePreparedGraphProjection,
  queryGraphProjection,
  verifyGraphProjectionPointer,
} from "./graph-projection-adapter.mjs";
import {
  captureDocumentChangeCandidates,
  inspectMarkdownProjection,
  materializeMarkdownProjection,
  readDocumentChangeCandidateSet,
} from "./document-projection-adapter.mjs";
import { withRefreshWriterLease } from "./refresh-writer-lease.mjs";
import { readGraphProject, safeGraphFile } from "./discovery-index.mjs";
import { SOURCE_ANALYSIS_VERSION } from "./source-analysis.mjs";
import { withSessionRoute } from "./session-routing.mjs";
import { ARTIFACT_COMPOSITION, publicToolName } from "./lode-artifact-composition.mjs";
import { familyFormatForOriginal, formatForVerifiedOwner, relativeProjectArtifact, projectOwnsRecordedRoot } from "./project-storage-format.mjs";

export const WORLD_MODEL_VERSION = "0.19.0";
export const WORLD_MODEL_STORE = WORLD_MODEL_STORAGE_CONTRACT;
export const WORLD_MODEL_STATUS_PROJECTION_VERSION = "0.1.0";
export const WORLD_MODEL_STATUS_PROJECTION_MAX_BYTES = 512 * 1024;

const WORLD_MODEL_STATUS_SAMPLE_LIMIT = 20;
const verifiedSnapshotByteLengths = new WeakMap();
const OBSERVATION_WORLD_ERROR_PREFIXES = ["OBSERVATION_", "INVALID_OBSERVATION", "UNKNOWN_OBSERVATION"];

const fail = (message, code = "WORLD_MODEL_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

async function readRecoverableTemporalGraphProjection({ projectRoot, projectId, adapter = null, expectedPointer = null, storage = null } = {}) {
  const selected = createGraphProjectionAdapter({ storage, projectRoot, adapter });
  const pointerEntry = await selected.readPointer();
  if (!pointerEntry) return null;
  const pointer = verifyGraphProjectionPointer(pointerEntry.document);
  if (pointer.projectId !== projectId) fail("Graph projection recovery belongs to a different Project.", "GRAPH_PROJECTION_PROJECT_MISMATCH");
  const snapshotEntry = (await selected.readSnapshot(pointer.graphSnapshotId));
  if (!snapshotEntry) return null;
  const graph = verifyTemporalProvenanceGraph(snapshotEntry.document);
  verifyGraphProjectionPointer(pointer, graph);
  const expected = expectedPointer?.sourceAdapters?.graphProjection || null;
  if (expected && (expected.graphSnapshotId !== graph.graphSnapshotId
    || expected.graphSnapshotHash !== graph.graphSnapshotHash
    || expected.pointerId !== pointer.pointerId)) return null;
  return graph;
}

function projectionProvesEarlierWorld({ productPolicyProjection, featureMappingProjection, changeSetProjection, documentChangeProjection } = {}) {
  return (productPolicyProjection?.candidates?.length || 0) > 0
    || (featureMappingProjection?.candidateSets?.length || 0) > 0
    || (changeSetProjection?.changeSets?.length || 0) > 0
    || (changeSetProjection?.candidateSets?.length || 0) > 0
    || (documentChangeProjection?.candidateSets?.length || 0) > 0;
}

function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

function loadObservationProjectionForWorld({ projectRoot, projectId, storage = null }) {
  try {
    return { projection: loadObservationProjection({ storage, projectRoot, projectId }), status: "projected", reasonCode: "" };
  } catch (error) {
    const reasonCode = String(error?.code || "");
    if (!OBSERVATION_WORLD_ERROR_PREFIXES.some((prefix) => reasonCode.startsWith(prefix))) throw error;
    return {
      projection: loadObservationProjection({ storage, projectRoot, projectId, artifacts: { descriptors: [], observations: [], derivedObservations: [], receipts: [] } }),
      status: "unavailable",
      reasonCode,
    };
  }
}

// A byte change proves basis drift, not which actor wrote Canon. Never restore it.
function canonBytes(projectRoot, storage) {
  const file = path.resolve(projectRoot, ...relativeProjectArtifact(storage, "context", "product-model.json").split("/"));
  try { return fs.readFileSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function assertCanonBasis(projectRoot, storage, expected) {
  const actual = canonBytes(projectRoot, storage);
  if (actual === null ? expected !== null : expected === null || !actual.equals(expected)) {
    fail("Product Canon changed while preparing the derived World/Graph view; preserve Canon and rebuild from its current basis.", "WORLD_MODEL_CANON_BASIS_CONFLICT");
  }
}

function noteCanonBasisError(error, projectRoot, storage, expected) {
  try { assertCanonBasis(projectRoot, storage, expected); }
  catch (secondary) {
    // Preserve the original permission, identity, or I/O failure as primary.
    error.canonBasisDiagnostic = { code: secondary.code || "CANON_BASIS_CHECK_FAILED" };
  }
  return error;
}

function readyProject(root) {
  const inspected = inspectProject(root);
  if (inspected.status !== "ready") {
    fail(`Project must be ready to build a World Model; current status: ${inspected.status}.`, "PROJECT_NOT_READY");
  }
  return inspected;
}

function productReferenceKind(ref) {
  if (ref.startsWith("refs/heads/")) return "branch";
  if (ref.startsWith("refs/remotes/")) return "remote";
  if (ref.startsWith("refs/tags/")) return "tag";
  return "";
}

function referenceRecord(ref, content, peeled = "") {
  const value = String(content || "").trim();
  if (/^[a-f0-9]{40,64}$/i.test(value)) return {
    ref,
    kind: productReferenceKind(ref),
    targetType: "direct",
    target: value.toLocaleLowerCase(),
    peeled: /^[a-f0-9]{40,64}$/i.test(peeled) ? peeled.toLocaleLowerCase() : "",
    commit: value.toLocaleLowerCase(),
  };
  if (!value.startsWith("ref: ")) return null;
  const target = value.slice(5).trim().replaceAll("\\", "/");
  if (classifyGitReference(target) === "invalid") return null;
  return {
    ref,
    kind: productReferenceKind(ref),
    targetType: "symbolic",
    target,
    peeled: "",
    commit: "",
  };
}

function gitReferenceState(gitPath) {
  const packedReferences = new Map();
  const productReferences = new Map();
  const packedRefs = path.join(gitPath, "packed-refs");
  if (fs.existsSync(packedRefs) && fs.statSync(packedRefs).isFile()) {
    let previousRef = "";
    for (const line of fs.readFileSync(packedRefs, "utf8").split(/\r?\n/)) {
      const direct = line.match(/^([a-f0-9]{40,64})\s+(refs\/\S+)$/i);
      if (direct && classifyGitReference(direct[2]) !== "invalid") {
        previousRef = direct[2];
        const record = referenceRecord(previousRef, direct[1]);
        packedReferences.set(previousRef, record);
        if (classifyGitReference(previousRef) === "product") productReferences.set(previousRef, record);
        continue;
      }
      const peeled = line.match(/^\^([a-f0-9]{40,64})$/i);
      if (peeled && previousRef) {
        const current = packedReferences.get(previousRef);
        const record = referenceRecord(previousRef, current?.target || "", peeled[1]);
        packedReferences.set(previousRef, record);
        if (classifyGitReference(previousRef) === "product") productReferences.set(previousRef, record);
        continue;
      }
      previousRef = "";
    }
  }
  const refsRoot = path.join(gitPath, "refs");
  const stack = fs.existsSync(refsRoot) ? [refsRoot] : [];
  while (stack.length) {
    const directory = stack.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const ref = path.relative(gitPath, absolute).replaceAll("\\", "/");
      if (classifyGitReference(ref) !== "product") continue;
      const content = fs.readFileSync(absolute, "utf8");
      const record = referenceRecord(ref, content) || {
        ref,
        kind: productReferenceKind(ref),
        targetType: "invalid",
        target: "",
        peeled: "",
        commit: "",
        invalidContentDigest: digest(content),
      };
      productReferences.set(ref, record);
    }
  }
  const references = [...productReferences.values()].sort((left, right) => left.ref.localeCompare(right.ref));
  return {
    referencesDigest: digest(canonicalJson(references)),
    references,
    tagNames: references.filter((item) => item.kind === "tag").map((item) => item.ref.slice("refs/tags/".length)).sort(),
    packedReferences,
  };
}

function looseReferenceRecord(gitPath, ref) {
  if (classifyGitReference(ref) === "invalid") return null;
  const file = path.join(gitPath, ...ref.split("/"));
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) return null;
  return referenceRecord(ref, fs.readFileSync(file, "utf8"));
}

function resolvedReferenceCommit(gitPath, references, packedReferences, ref, visited = new Set()) {
  if (!ref || visited.has(ref)) return "";
  visited.add(ref);
  const record = references.get(ref) || looseReferenceRecord(gitPath, ref) || packedReferences.get(ref);
  if (!record) return "";
  if (record.targetType === "symbolic") return resolvedReferenceCommit(gitPath, references, packedReferences, record.target, visited);
  return record.kind === "tag" && record.peeled ? record.peeled : record.target;
}

function gitHeadState(root) {
  const gitPath = path.join(root, ".git");
  if (!fs.existsSync(gitPath)) return { status: "not-a-git-repository", ref: "", commit: "", referencesDigest: "" };
  if (!fs.statSync(gitPath).isDirectory()) return { status: "external-gitdir-not-followed", ref: "", commit: "", referencesDigest: "" };
  const referenceState = gitReferenceState(gitPath);
  const { referencesDigest, references, tagNames, packedReferences } = referenceState;
  const referencesByName = new Map(references.map((item) => [item.ref, item]));
  const referencedCommits = () => [...new Set(references
    .filter((item) => item.kind === "branch" || item.kind === "remote")
    .map((item) => resolvedReferenceCommit(gitPath, referencesByName, packedReferences, item.ref))
    .filter(Boolean))].sort();
  const headFile = path.join(gitPath, "HEAD");
  if (!fs.existsSync(headFile)) return { status: "head-missing", ref: "", commit: "", referencesDigest, references, referenceCommits: referencedCommits(), referenceTags: tagNames };
  const head = fs.readFileSync(headFile, "utf8").trim();
  if (!head.startsWith("ref: ")) return {
    status: /^[a-f0-9]{40,64}$/i.test(head) ? "detached-head" : "invalid-head",
    ref: "",
    commit: /^[a-f0-9]{40,64}$/i.test(head) ? head.toLowerCase() : "",
    referencesDigest,
    references,
    referenceCommits: [...new Set([...referencedCommits(), ...(/^[a-f0-9]{40,64}$/i.test(head) ? [head.toLowerCase()] : [])])].sort(),
    referenceTags: tagNames,
  };
  const ref = head.slice(5).trim().replaceAll("\\", "/");
  if (classifyGitReference(ref) === "invalid") return { status: "invalid-ref", ref, commit: "", referencesDigest, references, referenceCommits: referencedCommits(), referenceTags: tagNames };
  const commit = resolvedReferenceCommit(gitPath, referencesByName, packedReferences, ref);
  return {
    status: commit ? "head-and-local-refs" : "unresolved-ref",
    ref,
    commit,
    referencesDigest,
    references,
    referenceCommits: [...new Set([...referencedCommits(), ...(commit ? [commit] : [])])].sort(),
    referenceTags: tagNames,
  };
}

function runtimeStateFor(state) {
  return canonical({
    sessionId: state.sessionId || "",
    mode: state.mode || "session",
    currentWholePlanId: state.currentWholePlanId || null,
    activeRunId: state.activeRunId || null,
    activeExecutionContractId: state.activeExecutionContractId || null,
    lastResultPacketId: state.lastResultPacketId || null,
    pendingReview: state.pendingReview || null,
    lastReviewDecisionId: state.lastReviewDecisionId || null,
    requiredPlanAction: state.requiredPlanAction || null,
    latestCheckpoint: state.latestCheckpoint || null,
  });
}

function verifiedSnapshot(snapshot, expectedId = "", storage = null) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) fail("World Model snapshot is invalid.", "INVALID_WORLD_MODEL");
  const recordedHash = snapshot.worldModelHash;
  const recordedId = snapshot.worldModelId;
  const payload = { ...snapshot };
  delete payload.worldModelId;
  delete payload.worldModelHash;
  const canonicalPayload = canonicalJson(payload);
  const actualHash = digest(canonicalPayload);
  if (recordedHash !== actualHash || recordedId !== `world-model-${actualHash.slice(0, 24)}` || (expectedId && recordedId !== expectedId)) {
    fail("World Model snapshot digest verification failed.", "WORLD_MODEL_DIGEST_MISMATCH");
  }
  const format = familyFormatForOriginal("head-agent-core-world-model", snapshot, storage);
  if (!format) fail("World Model snapshot protocol is unsupported.", "INVALID_WORLD_MODEL");
  if (snapshot.repositoryScan) validateRepositoryScanResult({
    schemaVersion: 1,
    kind: "RepositoryScanResult",
    ...snapshot.repositoryScan,
    files: snapshot.files,
    skipped: snapshot.skipped,
  }, { storage: format });
  if (snapshot.semanticGraph) verifySemanticGraph(snapshot.semanticGraph);
  if (snapshot.productModel) {
    const normalizedProductModel = normalizeProductModelDocument(productModelDocument(snapshot.productModel), format);
    if (normalizedProductModel.productModelId !== snapshot.productModel.productModelId
      || normalizedProductModel.productModelHash !== snapshot.productModel.productModelHash) {
      fail("World Model product canon projection is invalid.", "PRODUCT_MODEL_IDENTITY_MISMATCH");
    }
  }
  if (snapshot.temporalProvenanceGraph) verifyTemporalProvenanceGraph(snapshot.temporalProvenanceGraph);
  if (snapshot.temporalProvenanceGraph?.protocol?.version === "0.16.0"
    && canonicalJson(snapshot.temporalProvenanceGraph.relationAnalysisBasis) !== canonicalJson(relationBasisFor(snapshot))) fail("World relation analysis basis differs from its verified code basis.", "WORLD_MODEL_ANALYSIS_BASIS_MISMATCH");
  if (new Set(["0.11.0", "0.12.0", "0.13.0", "0.14.0", "0.15.0", "0.16.0", "0.17.0", "0.18.0", WORLD_MODEL_VERSION]).has(snapshot.protocol?.version)) {
    const projection = snapshot.onboardingProjection;
    const graphProjection = snapshot.temporalProvenanceGraph?.onboardingProjection;
    if (!projection || projection.authority !== "derived-projection-manifest-not-project-canon"
      || projection.instructionAuthority !== false || projection.promotionAuthority !== false
      || projection.projectionInputId !== graphProjection?.projectionInputId
      || projection.projectionInputHash !== graphProjection?.projectionInputHash
      || canonicalJson(projection.candidateSetIds) !== canonicalJson(graphProjection?.candidateSetIds)
      || canonicalJson(projection.reviewDecisionIds) !== canonicalJson(graphProjection?.reviewDecisionIds)
      || canonicalJson(projection.productModelRevisionIds) !== canonicalJson(graphProjection?.productModelRevisionIds)) {
      fail("World Model onboarding projection and temporal graph disagree.", "ONBOARDING_TEMPORAL_IDENTITY_MISMATCH");
    }
    if (["0.18.0", WORLD_MODEL_VERSION].includes(snapshot.protocol?.version)) {
      const policyProjection = snapshot.productPolicyProjection;
      const graphPolicyProjection = snapshot.temporalProvenanceGraph?.productPolicyProjection;
      if (!policyProjection || policyProjection.authority !== "derived-projection-manifest-not-project-canon"
        || policyProjection.instructionAuthority !== false || policyProjection.promotionAuthority !== false || policyProjection.recoveryAuthority !== false
        || policyProjection.projectionInputId !== graphPolicyProjection?.projectionInputId
        || policyProjection.projectionInputHash !== graphPolicyProjection?.projectionInputHash
        || canonicalJson(policyProjection.candidateIds) !== canonicalJson(graphPolicyProjection?.candidateIds)
        || canonicalJson(policyProjection.reviewDecisionIds) !== canonicalJson(graphPolicyProjection?.reviewDecisionIds)) {
        fail("World Model Product Policy projection and temporal graph disagree.", "PRODUCT_POLICY_TEMPORAL_IDENTITY_MISMATCH");
      }
    }
    const mappingProjection = snapshot.featureMappingProjection;
    const graphMappingProjection = snapshot.temporalProvenanceGraph?.featureMappingProjection;
    if (!mappingProjection || mappingProjection.authority !== "derived-projection-manifest-not-project-canon"
      || mappingProjection.instructionAuthority !== false || mappingProjection.promotionAuthority !== false
      || mappingProjection.projectionInputId !== graphMappingProjection?.projectionInputId
      || mappingProjection.projectionInputHash !== graphMappingProjection?.projectionInputHash
      || canonicalJson(mappingProjection.candidateSetIds) !== canonicalJson(graphMappingProjection?.candidateSetIds)
      || canonicalJson(mappingProjection.reviewDecisionIds) !== canonicalJson(graphMappingProjection?.reviewDecisionIds)) {
      fail("World Model Feature mapping projection and temporal graph disagree.", "FEATURE_MAPPING_TEMPORAL_IDENTITY_MISMATCH");
    }
    const changeProjection = snapshot.changeSetProjection;
    const graphChangeProjection = snapshot.temporalProvenanceGraph?.changeSetProjection;
    if (!changeProjection || changeProjection.authority !== "derived-projection-manifest-not-change-lineage-authority"
      || changeProjection.instructionAuthority !== false || changeProjection.promotionAuthority !== false
      || changeProjection.projectionInputId !== graphChangeProjection?.projectionInputId
      || changeProjection.projectionInputHash !== graphChangeProjection?.projectionInputHash
      || canonicalJson(changeProjection.changeSetIds) !== canonicalJson(graphChangeProjection?.changeSetIds)
      || canonicalJson(changeProjection.candidateSetIds) !== canonicalJson(graphChangeProjection?.candidateSetIds)
      || canonicalJson(changeProjection.reviewDecisionIds) !== canonicalJson(graphChangeProjection?.reviewDecisionIds)
      || canonicalJson(changeProjection.vcsEvidenceIds) !== canonicalJson(graphChangeProjection?.vcsEvidenceIds)) {
      fail("World Model ChangeSet projection and temporal graph disagree.", "CHANGE_SET_TEMPORAL_IDENTITY_MISMATCH");
    }
    const documentChangeProjection = snapshot.documentChangeProjection;
    const graphDocumentChangeProjection = snapshot.temporalProvenanceGraph?.documentChangeProjection;
    if (!documentChangeProjection || documentChangeProjection.authority !== "derived-projection-manifest-not-document-authority"
      || documentChangeProjection.instructionAuthority !== false || documentChangeProjection.promotionAuthority !== false
      || documentChangeProjection.projectionInputId !== graphDocumentChangeProjection?.projectionInputId
      || documentChangeProjection.projectionInputHash !== graphDocumentChangeProjection?.projectionInputHash
      || canonicalJson(documentChangeProjection.candidateSetIds) !== canonicalJson(graphDocumentChangeProjection?.candidateSetIds)
      || canonicalJson(documentChangeProjection.reviewDecisionIds) !== canonicalJson(graphDocumentChangeProjection?.reviewDecisionIds)
      || canonicalJson(documentChangeProjection.productModelRevisionIds) !== canonicalJson(graphDocumentChangeProjection?.productModelRevisionIds)
      || canonicalJson(documentChangeProjection.applicationReceiptIds) !== canonicalJson(graphDocumentChangeProjection?.applicationReceiptIds)) {
      fail("World Model document-change projection and temporal graph disagree.", "DOCUMENT_CHANGE_TEMPORAL_IDENTITY_MISMATCH");
    }
    const operatingProjection = snapshot.productOperatingProjection;
    const graphOperatingProjection = snapshot.temporalProvenanceGraph?.productOperatingProjection;
    if (!operatingProjection || operatingProjection.authority !== "derived-product-graph-manifest-not-product-or-execution-canon"
      || operatingProjection.instructionAuthority !== false || operatingProjection.promotionAuthority !== false
      || operatingProjection.projectionInputId !== graphOperatingProjection?.projectionInputId
      || operatingProjection.projectionInputHash !== graphOperatingProjection?.projectionInputHash
      || canonicalJson(operatingProjection.signalIds) !== canonicalJson(graphOperatingProjection?.signalIds)
      || canonicalJson(operatingProjection.hypothesisIds) !== canonicalJson(graphOperatingProjection?.hypothesisIds)
      || canonicalJson(operatingProjection.initiativeCandidateIds) !== canonicalJson(graphOperatingProjection?.initiativeCandidateIds)
      || canonicalJson(operatingProjection.reviewDecisionIds) !== canonicalJson(graphOperatingProjection?.reviewDecisionIds)
      || canonicalJson(operatingProjection.reviewedInitiativeIds) !== canonicalJson(graphOperatingProjection?.reviewedInitiativeIds)
      || canonicalJson(operatingProjection.featureCandidateIds) !== canonicalJson(graphOperatingProjection?.featureCandidateIds)
      || canonicalJson(operatingProjection.outcomeObservationIds) !== canonicalJson(graphOperatingProjection?.outcomeObservationIds)) {
      fail("World Model product-operating projection and temporal graph disagree.", "PRODUCT_OPERATING_TEMPORAL_IDENTITY_MISMATCH");
    }
    if (new Set(["0.15.0", "0.16.0", "0.17.0", "0.18.0", WORLD_MODEL_VERSION]).has(snapshot.protocol?.version)) {
      const releaseProjection = snapshot.releaseObservationProjection;
      const graphReleaseProjection = snapshot.temporalProvenanceGraph?.releaseObservationProjection;
      if (!releaseProjection || releaseProjection.authority !== "derived-projection-manifest-not-release-authority"
        || releaseProjection.instructionAuthority !== false || releaseProjection.promotionAuthority !== false
        || releaseProjection.projectionInputId !== graphReleaseProjection?.projectionInputId
        || releaseProjection.projectionInputHash !== graphReleaseProjection?.projectionInputHash
        || canonicalJson(releaseProjection.branchStateObservationIds) !== canonicalJson(graphReleaseProjection?.branchStateObservationIds)
        || canonicalJson(releaseProjection.deploymentResultObservationIds) !== canonicalJson(graphReleaseProjection?.deploymentResultObservationIds)
        || canonicalJson(releaseProjection.releaseObservationIds) !== canonicalJson(graphReleaseProjection?.releaseObservationIds)) {
        fail("World Model release-observation projection and temporal graph disagree.", "RELEASE_OBSERVATION_TEMPORAL_IDENTITY_MISMATCH");
      }
    }
    if (new Set(["0.16.0", "0.17.0", "0.18.0", WORLD_MODEL_VERSION]).has(snapshot.protocol?.version)) {
      const observationProjection = snapshot.observationProjection;
      const graphObservationProjection = snapshot.temporalProvenanceGraph?.observationProjection;
      if (!observationProjection || observationProjection.authority !== "derived-projection-manifest-not-observation-or-product-authority"
        || observationProjection.instructionAuthority !== false || observationProjection.promotionAuthority !== false || observationProjection.recoveryAuthority !== false
        || !["projected", "unavailable"].includes(observationProjection.status)
        || observationProjection.status === "projected" && observationProjection.reasonCode !== ""
        || observationProjection.status === "unavailable" && (typeof observationProjection.reasonCode !== "string" || !observationProjection.reasonCode)
        || observationProjection.projectionId !== graphObservationProjection?.projectionId
        || observationProjection.projectionHash !== graphObservationProjection?.projectionHash
        || canonicalJson(observationProjection.descriptorIds) !== canonicalJson(graphObservationProjection?.descriptorIds)
        || canonicalJson(observationProjection.observationIds) !== canonicalJson(graphObservationProjection?.observationIds)
        || canonicalJson(observationProjection.derivedObservationIds) !== canonicalJson(graphObservationProjection?.derivedObservationIds)
        || canonicalJson(observationProjection.receiptIds) !== canonicalJson(graphObservationProjection?.receiptIds)) {
        fail("World Model Observation projection and temporal graph disagree.", "OBSERVATION_TEMPORAL_IDENTITY_MISMATCH");
      }
    }
  }
  if (snapshot.productModel && snapshot.temporalProvenanceGraph
    && (snapshot.productModel.productModelId !== snapshot.temporalProvenanceGraph.productModelId
      || snapshot.productModel.productModelHash !== snapshot.temporalProvenanceGraph.productModelHash)) {
    fail("World Model product canon and temporal graph disagree.", "PRODUCT_TEMPORAL_IDENTITY_MISMATCH");
  }
  if (snapshot.gitDecisionHistory) verifyGitDecisionHistory(snapshot.gitDecisionHistory);
  if (snapshot.externalRuntimeState) verifyExternalRuntimeState(snapshot.externalRuntimeState);
  if (snapshot.protocol?.version === WORLD_MODEL_VERSION
    && (!snapshot.analysisBasis || canonicalJson(snapshot.domainBases) !== canonicalJson(domainBasesFor(snapshot)))) {
    fail("World Model domain bases disagree with retained evidence.", "WORLD_DOMAIN_BASIS_MISMATCH");
  }
  const identityBytes = Buffer.byteLength(`,"worldModelHash":${JSON.stringify(recordedHash)},"worldModelId":${JSON.stringify(recordedId)}`, "utf8");
  verifiedSnapshotByteLengths.set(snapshot, Buffer.byteLength(canonicalPayload, "utf8") + identityBytes);
  return snapshot;
}

function changesBetween(previous, current) {
  const before = new Map((previous?.files || []).map((item) => [item.path, item.digest]));
  const after = new Map(current.files.map((item) => [item.path, item.digest]));
  return {
    added: [...after.keys()].filter((file) => !before.has(file)).sort(),
    changed: [...after.keys()].filter((file) => before.has(file) && before.get(file) !== after.get(file)).sort(),
    removed: [...before.keys()].filter((file) => !after.has(file)).sort(),
  };
}

const REVISION_KINDS = new Set([
  "FileRevision", "SymbolRevision", "TestRevision", "FeatureGroupRevision",
  "CapabilityRevision", "FeatureRevision", "RequirementRevision", "ConstraintRevision", "DecisionRevision",
  "PolicyRevision",
]);

function revisionSemantic(node, nodes) {
  const base = { kind: node.kind, logicalEntityId: node.logicalEntityId };
  if (node.kind === "FileRevision") return {
    ...base,
    digest: node.digest,
    language: node.language,
    classification: node.classification,
  };
  if (node.kind === "SymbolRevision") return {
    ...base,
    path: node.path,
    name: node.name,
    symbolKind: node.symbolKind,
    occurrence: node.occurrence,
    line: node.line,
    endLine: node.endLine,
    scopePath: node.scopePath,
    qualifiedName: node.qualifiedName,
    signature: node.signature,
    identityAmbiguous: node.identityAmbiguous,
    fileDigest: nodes.get(node.fileRevisionId)?.digest || "",
  };
  if (node.kind === "TestRevision") return {
    ...base,
    path: node.path,
    fileDigest: nodes.get(node.fileRevisionId)?.digest || "",
  };
  return { ...base, key: node.key, semantic: node.semantic };
}

export function deriveIncrementalRevisionParents({ previousGraph, candidateGraph } = {}) {
  verifyTemporalProvenanceGraph(previousGraph);
  verifyTemporalProvenanceGraph(candidateGraph);
  if (previousGraph.projectId !== candidateGraph.projectId) fail("Refresh graphs do not belong to the same project.", "REFRESH_GRAPH_SCOPE_MISMATCH");
  const previousNodes = new Map(previousGraph.nodes.map((node) => [node.nodeId, node]));
  const candidateNodes = new Map(candidateGraph.nodes.map((node) => [node.nodeId, node]));
  const previousRevisions = new Map(previousGraph.nodes
    .filter((node) => REVISION_KINDS.has(node.kind) && node.logicalEntityId)
    .map((node) => [node.logicalEntityId, node]));
  const parents = {};
  for (const candidate of candidateGraph.nodes.filter((node) => REVISION_KINDS.has(node.kind) && node.logicalEntityId)) {
    const previous = previousRevisions.get(candidate.logicalEntityId);
    if (!previous || previous.kind !== candidate.kind) continue;
    if (candidate.kind === "SymbolRevision" && (candidate.identityAmbiguous || previous.identityAmbiguous)) continue;
    const unchanged = canonicalJson(revisionSemantic(previous, previousNodes)) === canonicalJson(revisionSemantic(candidate, candidateNodes));
    parents[candidate.logicalEntityId] = unchanged ? [...previous.parentRevisionIds] : [previous.nodeId];
  }
  return Object.fromEntries(Object.entries(parents).sort(([left], [right]) => left.localeCompare(right)));
}

function indexerState() {
  return {
    worldModelVersion: WORLD_MODEL_VERSION,
    repositoryScanVersion: REPOSITORY_SCAN_VERSION,
    sourceAnalysisVersion: SOURCE_ANALYSIS_VERSION,
    semanticGraphVersion: SEMANTIC_GRAPH_VERSION,
    productModelVersion: PRODUCT_MODEL_VERSION,
    onboardingGraphProjectionVersion: ONBOARDING_GRAPH_PROJECTION_VERSION,
    productPolicyGraphProjectionVersion: PRODUCT_POLICY_GRAPH_PROJECTION_VERSION,
    featureMappingVersion: FEATURE_MAPPING_VERSION,
    changeSetVersion: CHANGE_SET_VERSION,
    changeSetProjectionVersion: CHANGE_SET_PROJECTION_VERSION,
    documentChangeGraphProjectionVersion: DOCUMENT_CHANGE_GRAPH_PROJECTION_VERSION,
    productOperatingLoopVersion: PRODUCT_OPERATING_LOOP_VERSION,
    observationProtocolVersion: OBSERVATION_PROTOCOL_VERSION,
    releaseObservationVersion: RELEASE_OBSERVATION_VERSION,
    vcsEvidenceVersion: VCS_EVIDENCE_VERSION,
    temporalProvenanceVersion: TEMPORAL_PROVENANCE_VERSION,
    graphProjectionAdapterVersion: GRAPH_PROJECTION_ADAPTER_VERSION,
    gitDecisionHistoryVersion: GIT_DECISION_HISTORY_VERSION,
    gitHistoryAdapterVersion: GIT_HISTORY_ADAPTER_VERSION,
    externalRuntimeStateVersion: EXTERNAL_RUNTIME_STATE_VERSION,
    runtimeStateAdapterVersion: RUNTIME_STATE_ADAPTER_VERSION,
    sourceRelationEvidenceVersion: SOURCE_RELATION_EVIDENCE_VERSION,
  };
}

function sourceDigestFor(files, sourceScope, productModel, onboardingProjection, productPolicyProjection, featureMappingProjection, changeSetProjection, documentChangeProjection, observationIntegration, productOperatingProjection, releaseObservationProjection, git, runtimeState, externalRuntimeState, indexer, sourceRelationEvidenceHash = null, parentSourceSnapshotIds = [], revisionParentIds = {}, logicalLineageState = {}) {
  const observationProjection = observationIntegration.projection;
  return digest(canonicalJson({
    files,
    sourceScope: { sourceScopeId: sourceScope.sourceScopeId, sourceScopeHash: sourceScope.sourceScopeHash },
    productModel: { productModelId: productModel.productModelId, productModelHash: productModel.productModelHash },
    onboardingProjection: {
      projectionInputId: onboardingProjection.projectionInputId,
      projectionInputHash: onboardingProjection.projectionInputHash,
    },
    productPolicyProjection: {
      projectionInputId: productPolicyProjection.projectionInputId,
      projectionInputHash: productPolicyProjection.projectionInputHash,
    },
    featureMappingProjection: {
      projectionInputId: featureMappingProjection.projectionInputId,
      projectionInputHash: featureMappingProjection.projectionInputHash,
    },
    changeSetProjection: {
      projectionInputId: changeSetProjection.projectionInputId,
      projectionInputHash: changeSetProjection.projectionInputHash,
    },
    documentChangeProjection: {
      projectionInputId: documentChangeProjection.projectionInputId,
      projectionInputHash: documentChangeProjection.projectionInputHash,
    },
    observationProjection: {
      projectionId: observationProjection.projectionId,
      projectionHash: observationProjection.projectionHash,
      status: observationIntegration.status,
      reasonCode: observationIntegration.reasonCode,
    },
    productOperatingProjection: {
      projectionInputId: productOperatingProjection.projectionInputId,
      projectionInputHash: productOperatingProjection.projectionInputHash,
    },
    releaseObservationProjection: {
      projectionInputId: releaseObservationProjection.projectionInputId,
      projectionInputHash: releaseObservationProjection.projectionInputHash,
    },
    git,
    runtimeState,
    externalRuntimeState: externalRuntimeState.runtimeStateHash,
    sourceRelationEvidenceHash,
    indexer,
    temporalParents: { parentSourceSnapshotIds, revisionParentIds, logicalLineageState },
  }));
}

const WORLD_DOMAINS = Object.freeze(["code", "product", "git", "runtime", "observations"]);
const projectionBasis = (value) => value?.projectionInputHash || null;
function codeAnalysisBasis(semanticGraph) {
  return {
    repositoryScanVersion: REPOSITORY_SCAN_VERSION,
    sourceAnalysisVersion: SOURCE_ANALYSIS_VERSION,
    semanticGraphVersion: SEMANTIC_GRAPH_VERSION,
    sourceRelationEvidenceVersion: SOURCE_RELATION_EVIDENCE_VERSION,
    sourceRelationAnalyzer: semanticGraph?.sourceRelationEvidence?.analyzer || null,
    sourceRelationEvidenceHash: semanticGraph?.sourceRelationEvidence?.evidenceSetHash || null,
  };
}
function relationBasisFor(snapshot) {
  const { sourceRelationEvidenceHash, ...analysisBasis } = snapshot.analysisBasis || {};
  return { analysisBasis, rules: snapshot.rules, sourceScope: snapshot.repositoryScan?.sourceScope || null };
}
function domainBasesFor(snapshot, domains = WORLD_DOMAINS) {
  const bases = {
    code: () => digest(canonicalJson({
      files: snapshot.files.map(({ path, digest, language, classification }) => ({ path, digest, language, classification })),
      sourceScope: snapshot.repositoryScan?.sourceScope || null,
      analysisBasis: snapshot.analysisBasis || null,
      rules: snapshot.rules,
    })),
    product: () => digest(canonicalJson({
      productModel: snapshot.productModel?.productModelHash || null,
      projections: [snapshot.onboardingProjection, snapshot.productPolicyProjection, snapshot.featureMappingProjection,
        snapshot.changeSetProjection, snapshot.documentChangeProjection].map(projectionBasis),
    })),
    git: () => digest(canonicalJson({ git: snapshot.git, release: projectionBasis(snapshot.releaseObservationProjection) })),
    runtime: () => digest(canonicalJson({ capturedSession: snapshot.runtimeState, external: snapshot.externalRuntimeState?.runtimeStateHash || null })),
    observations: () => digest(canonicalJson({ observation: snapshot.observationProjection?.projectionHash || null,
      status: snapshot.observationProjection?.status, reason: snapshot.observationProjection?.reasonCode,
      operating: projectionBasis(snapshot.productOperatingProjection) })),
  };
  return Object.fromEntries(domains.map(domain => [domain, bases[domain]()]));
}

// A scoped read validates retained bytes first, then ONLY the requested live
// domains. Unrelated invalid Product/runtime records are not a code gate.
// These are P4 observations, never a refreshed snapshot or P2 recovery source.
export async function inspectWorldDomainFreshness({ root = ".", domains = WORLD_DOMAINS,
  worldModelId = "", storeAdapter = null, runtimeStateAdapter = null, temporalVerificationScope = null } = {}) {
  if (!Array.isArray(domains) || !domains.length || domains.some(domain => !WORLD_DOMAINS.includes(domain))) {
    fail("World freshness domains are invalid.", "INVALID_WORLD_FRESHNESS_DOMAINS");
  }
  const stored = (await readWorldModelForDiscovery({ root, worldModelId, storeAdapter, temporalVerificationScope }));
  const snapshot = stored.snapshot, projectRoot = stored.storage.projectRoot;
  const { project, storage } = readGraphProject(projectRoot);
  const result = {};
  for (const domain of [...new Set(domains)]) {
    try {
      if (!snapshot.domainBases?.[domain] || !snapshot.analysisBasis) {
        result[domain] = { status: "unknown", reasonCode: "WORLD_DOMAIN_BASIS_UNRECORDED", fallback: "original-source" };
        continue;
      }
      let current = { ...snapshot };
      if (domain === "code") {
        const sourceScope = readRepositorySourceScope({ storage, projectRoot }).sourceScope;
        const scan = inspectRepositoryScanFreshness({ storage, projectRoot, sourceScope,
          managedRootFiles: managedRootFilesForProject(project, storage), storedFiles: snapshot.files });
        current = { ...current, files: scan.files, analysisBasis: codeAnalysisBasis(snapshot.semanticGraph),
          repositoryScan: { ...snapshot.repositoryScan, sourceScope },
          rules: { ...snapshot.rules, sourceScope, maxFileBytes: REPOSITORY_SCAN_DEFAULTS.maxFileBytes,
            maxFiles: REPOSITORY_SCAN_DEFAULTS.maxFiles, maxTotalBytes: REPOSITORY_SCAN_DEFAULTS.maxTotalBytes,
            maxSymbolsPerFile: REPOSITORY_SCAN_DEFAULTS.maxSymbolsPerFile,
            excludedDirectories: REPOSITORY_SCAN_EXCLUDED_DIRECTORIES, managedRootProjectionsExcluded: managedRootFilesForProject(project, storage) } };
      } else if (domain === "product") {
        const model = readProductModelCanon({ storage, projectRoot }).model;
        const input = { projectRoot, storage, projectId: project.projectId, currentProductModelId: model.productModelId };
        current = { ...current, productModel: model,
          onboardingProjection: loadOnboardingGraphProjection(input), productPolicyProjection: loadProductPolicyGraphProjection(input),
          featureMappingProjection: loadFeatureMappingProjection(input), changeSetProjection: loadChangeSetProjection(input),
          documentChangeProjection: loadDocumentChangeProjection(input) };
      } else if (domain === "git") {
        current = { ...current, git: gitHeadState(projectRoot),
          releaseObservationProjection: loadReleaseObservationProjection({ storage, projectRoot, projectId: project.projectId }) };
      } else if (domain === "observations") {
        const observation = loadObservationProjectionForWorld({ storage, projectRoot, projectId: project.projectId });
        current = { ...current, observationProjection: { ...observation.projection, status: observation.status, reasonCode: observation.reasonCode },
          productOperatingProjection: loadProductOperatingProjection({ storage, projectRoot, projectId: project.projectId }) };
        if (observation.status === "unavailable") {
          result[domain] = { status: "unavailable", reasonCode: observation.reasonCode, fallback: "original-source" };
          continue;
        }
      } else if (domain === "runtime") {
        // World captured one Session. Selecting another Session does not
        // transfer the captured observation's owner or rewrite its identity.
        const captured = withSessionRoute(projectRoot, snapshot.runtimeState.sessionId, () => readyProject(projectRoot));
        const selected = runtimeStateAdapter || runtimeStateAdapterFromDescriptor(stored.pointer?.sourceAdapters?.runtimeState);
        current = { ...current, runtimeState: runtimeStateFor(captured.state),
          externalRuntimeState: buildExternalRuntimeState({ storage, projectRoot, adapter: selected }).runtimeState };
      }
      const currentBasis = domainBasesFor(current, [domain])[domain];
      result[domain] = { status: currentBasis === snapshot.domainBases[domain] ? "current" : "stale",
        storedBasis: snapshot.domainBases[domain], currentBasis,
        ...(domain === "runtime" ? { capturedSessionId: snapshot.runtimeState.sessionId } : {}) };
    } catch (error) {
      result[domain] = { status: "unavailable", reasonCode: error.code || "WORLD_DOMAIN_READER_UNAVAILABLE", fallback: "original-source" };
    }
  }
  return { ...stored, status: Object.values(result).every(item => item.status === "current") ? "current" : "partial",
    freshness: { domains: result, scope: "requested-domains-only", fullWorldCurrentClaim: false },
    authority: "derived-observation-only", instructionAuthority: false, promotionAuthority: false, recoveryAuthority: false };
}

const CODE_NODE_KINDS = new Set(["File", "FileRevision", "Symbol", "SymbolRevision", "Test", "TestRevision", "RevisionReference"]);
const NEUTRAL_NODE_KINDS = new Set(["Repository", "SourceSnapshot", "SourceSnapshotReference"]);
const PRODUCT_NODE_KINDS = new Set(["FeatureGroup", "FeatureGroupRevision", "Capability", "CapabilityRevision", "Feature", "FeatureRevision",
  "Requirement", "RequirementRevision", "Constraint", "ConstraintRevision", "Decision", "DecisionRevision", "Policy", "PolicyRevision",
  "OnboardingCandidateSet", "OnboardingProductCandidate", "OnboardingEvidence", "OnboardingUnknown", "OnboardingReviewDecision",
  "ProductConceptReference", "ProductModelRevision", "FeatureMappingCandidateSet", "FeatureMappingCandidate", "FeatureMappingEvidence",
  "FeatureMappingUnknown", "FeatureMappingReviewDecision", "ReviewedRelationship", "MappingEndpointReference", "ChangeSet", "ChangeRevisionReference",
  "ChangeImpactCandidateSet", "ChangeImpactCandidate", "ChangeImpactUnknown", "ChangeImpactReviewDecision", "ReviewedImpact", "ChangeProductReference",
  "DocumentChangeCandidateSet", "DocumentChangeCandidate", "DocumentChangeReviewDecision", "DocumentChangeApplication", "DocumentProductModelRevision",
  "DocumentProjectionReference", "ProductModelRevisionReference", "ProductPolicyCandidate", "ProductPolicyEvidence", "ProductPolicyReviewDecision",
  "HistoricalOnboardingCandidateReference"]);
const OBSERVATION_NODE_KINDS = new Set(["ProductSignal", "ProductHypothesis", "ProductInitiativeCandidate", "ProductInitiativeReviewDecision",
  "ReviewedProductInitiative", "ProductFeatureCandidate", "ProductFeatureReference", "OutcomeObservation", "ObservationTypeDescriptor",
  "ObservationCollectionReceipt", "ObservationRecord", "DerivedObservationRecord"]);
const GIT_NODE_KINDS = new Set(["VcsEvidence", "GitCommit", "BranchStateObservation", "DeploymentResultObservation", "ReleaseObservation"]);
function worldNodeDomains(node) {
  if (CODE_NODE_KINDS.has(node.kind)) return ["code"];
  if (NEUTRAL_NODE_KINDS.has(node.kind)) return [];
  if (PRODUCT_NODE_KINDS.has(node.kind)) return ["product"];
  if (OBSERVATION_NODE_KINDS.has(node.kind)) return ["observations"];
  if (GIT_NODE_KINDS.has(node.kind)) return ["git"];
  if (node.kind === "ExecutionLineageReference") return ["runtime"];
  return ["unknown"];
}
const CODE_PRODUCT_RELATIONS = new Set(["REALIZES", "IMPLEMENTS", "VERIFIED_BY", "IMPACTS"]);
const GIT_RELATIONS = new Set(["AT_REVISION", "OBSERVED_ON", "DEPLOYS"]);
const NEUTRAL_RELATIONS = new Set(["CONTAINS", "GOVERNED_BY", "HAS_REVISION", "CURRENT_REVISION", "PARENT_OF", "DECLARES", "REFERENCES",
    "PROPOSES_FROM", "PROPOSES_TO", "SUPPORTED_BY", "REVIEWED_BY", "ACCEPTED_BY", "REJECTED_BY", "PROMOTED_FROM",
    "PRODUCES", "CHANGES", "SUPERSEDES", "MATERIALIZED_AS", "OBSERVES", "EVIDENCED_BY", "CONFORMS_TO", "DERIVED_FROM", "HISTORICALLY_FOLLOWS"]);
function worldRelationDomains(edge) {
  if (CODE_PRODUCT_RELATIONS.has(edge.type)) return ["code", "product"];
  if (GIT_RELATIONS.has(edge.type)) return ["git"];
  if (NEUTRAL_RELATIONS.has(edge.type)) return [];
  return ["unknown"];
}
// Mask the original graph BEFORE traversal. Never manufacture a new snapshot
// identity for a filtered graph, and never let a stale bridge expand a query.
export function buildWorldTraversalEligibility(snapshot, domainFreshness) {
  const graph = snapshot.temporalProvenanceGraph;
  verifyTemporalProvenanceGraph(graph);
  const nodeDomains = new Map(graph.nodes.map(node => [node.nodeId, worldNodeDomains(node)]));
  const eligible = (record, required) => required.every(domain => domain !== "unknown")
    && (record.freshness !== "current" || required.every(domain => domainFreshness?.[domain]?.status === "current"));
  const nodeIds = graph.nodes.filter(node => eligible(node, nodeDomains.get(node.nodeId))).map(node => node.nodeId);
  const allowed = new Set(nodeIds);
  const edgeIds = graph.edges.filter(edge => allowed.has(edge.from) && allowed.has(edge.to)
    && eligible(edge, [...new Set([...nodeDomains.get(edge.from), ...nodeDomains.get(edge.to), ...worldRelationDomains(edge)])])).map(edge => edge.edgeId);
  return { graphSnapshotId: graph.graphSnapshotId, graphSnapshotHash: graph.graphSnapshotHash,
    nodeIds, edgeIds, domains: domainFreshness, authority: "read-only-domain-eligibility-not-graph-snapshot" };
}

export async function readWorldModel({ root = ".", storeAdapter = null } = {}) {
  const inspected = readyProject(root);
  const storage = inspected.storage;
  const projectRoot = inspected.project.projectRoot;
  const adapter = createWorldModelStoreAdapter({ storage, projectRoot, adapter: storeAdapter });
  const pointerEntry = adapter.readPointer();
  if (!pointerEntry) fail("Repository World Model has not been built.", "WORLD_MODEL_NOT_BUILT");
  const pointer = pointerEntry.document;
  verifyWorldModelPointerOriginal(pointer, inspected.project.projectId);
  const snapshotEntry = (await adapter.readSnapshot(pointer.worldModelId));
  if (!snapshotEntry) fail("World Model snapshot is missing.", "WORLD_MODEL_SNAPSHOT_MISSING");
  const snapshot = verifyWorldModelSnapshotOriginal({ document: snapshotEntry.document, worldModelId: pointer.worldModelId, storage });
  if (snapshot.projectId !== inspected.project.projectId || !projectOwnsRecordedRoot(storage, snapshot.projectRoot)) fail("World snapshot belongs to another Project/root.", "WORLD_MODEL_IDENTITY_MISMATCH");
  if (snapshot.worldModelHash !== pointer.worldModelHash) fail("World Model pointer hash does not match its snapshot.", "WORLD_MODEL_POINTER_MISMATCH");
  return {
    storage,
    status: "verified",
    pointerFile: pointerEntry.location,
    file: snapshotEntry.location,
    ...(snapshotEntry.snapshotStorage ? { snapshotStorage: snapshotEntry.snapshotStorage } : {}),
    pointer,
    snapshot,
    storeAdapter: adapter.describe(),
  };
}

export async function readWorldModelSnapshot({ root = ".", worldModelId, storeAdapter = null } = {}) {
  const inspected = readyProject(root);
  const storage = inspected.storage;
  if (!/^world-model-[a-f0-9]{24}$/.test(worldModelId || "")) fail("World Model snapshot id is invalid.", "INVALID_WORLD_MODEL_ID");
  const adapter = createWorldModelStoreAdapter({ storage, projectRoot: inspected.project.projectRoot, adapter: storeAdapter });
  const snapshotEntry = (await adapter.readSnapshot(worldModelId));
  if (!snapshotEntry) fail(`World Model snapshot is missing: ${worldModelId}`, "WORLD_MODEL_SNAPSHOT_MISSING");
  const snapshot = verifyWorldModelSnapshotOriginal({ document: snapshotEntry.document, worldModelId, storage });
  if (snapshot.projectId !== inspected.project.projectId || !projectOwnsRecordedRoot(storage, snapshot.projectRoot)) fail("World snapshot belongs to another Project/root.", "WORLD_MODEL_IDENTITY_MISMATCH");
  return {
    status: "verified",
    file: snapshotEntry.location,
    ...(snapshotEntry.snapshotStorage ? { snapshotStorage: snapshotEntry.snapshotStorage } : {}),
    snapshot,
    storage,
    storeAdapter: adapter.describe(),
  };
}

// Ordinary discovery verifies the retained bytes without making generated
// installation drift or whole-repository freshness a prerequisite. Current
// mutations and reproducible Capsule consumers keep their existing checks.
export async function readWorldModelForDiscovery({ root = ".", worldModelId = "", storeAdapter = null, temporalVerificationScope = null } = {}) {
  const { projectRoot, project, storage } = readGraphProject(root);
  if (!project) fail("Lode Agent Core is not initialized.", "NOT_INITIALIZED");
  if (worldModelId && !/^world-model-[a-f0-9]{24}$/.test(worldModelId)) fail("World Model snapshot id is invalid.", "INVALID_WORLD_MODEL_ID");
  const adapter = createWorldModelStoreAdapter({ storage, projectRoot, adapter: storeAdapter });
  if (!storeAdapter) safeGraphFile(projectRoot, relativeProjectArtifact(storage, "world-model", "current.json"));
  let pointer = null;
  try { pointer = adapter.readPointer()?.document || null; }
  catch (error) { if (!worldModelId) throw error; }
  if (pointer && (pointer.projectId !== project.projectId || pointer.schemaVersion !== SCHEMA_VERSION
    || pointer.kind !== "WorldModelPointer" || !/^world-model-[a-f0-9]{24}$/.test(pointer.worldModelId || ""))) {
    if (!worldModelId) fail("World Model pointer identity is invalid.", "WORLD_MODEL_POINTER_MISMATCH");
    pointer = null;
  }
  const selectedId = worldModelId || pointer?.worldModelId;
  if (!selectedId) fail("Repository World Model has not been built.", "WORLD_MODEL_NOT_BUILT");
  if (!storeAdapter) safeGraphFile(projectRoot, path.relative(projectRoot, adapter.snapshotLocation(selectedId)).replaceAll("\\", "/"));
  const pendingEntry = adapter.readSnapshot(selectedId);
  const ownEntry = entry => !entry || temporalVerificationScope === null ? entry
    : { ...entry, document: ownWorldSnapshotForTemporalScope(temporalVerificationScope, entry.document) };
  // A synchronous adapter's returned value exists now: detach its aliases
  // before yielding. A Promise value is not observed until it resolves.
  const entry = pendingEntry && typeof pendingEntry.then === "function"
    ? ownEntry(await pendingEntry) : ownEntry(pendingEntry);
  if (!entry) fail("World Model snapshot is missing.", "WORLD_MODEL_SNAPSHOT_MISSING");
  const document = entry.document;
  const snapshot = verifiedSnapshot(document, selectedId, storage);
  if (snapshot.projectId !== project.projectId || !projectOwnsRecordedRoot(storage, snapshot.projectRoot)) fail("World snapshot belongs to another Project/root.", "WORLD_MODEL_IDENTITY_MISMATCH");
  if (!worldModelId && pointer.worldModelHash !== snapshot.worldModelHash) fail("World pointer hash differs from retained bytes.", "WORLD_MODEL_POINTER_MISMATCH");
  return { snapshot, pointer, storage, file: entry.location, ...(entry.snapshotStorage ? { snapshotStorage: entry.snapshotStorage } : {}), historical: !pointer || selectedId !== pointer.worldModelId };
}

export async function findWorldModelSnapshot({ root = ".", graphSnapshotId = "", sourceSnapshotId = "", storeAdapter = null } = {}) {
  const inspected = readyProject(root);
  const storage = inspected.storage;
  if (!graphSnapshotId && !sourceSnapshotId) fail("A GraphSnapshot or SourceSnapshot identity is required.", "WORLD_MODEL_SNAPSHOT_QUERY_REQUIRED");
  const adapter = createWorldModelStoreAdapter({ storage, projectRoot: inspected.project.projectRoot, adapter: storeAdapter });
  const matches = [];
  for (const worldModelId of (await adapter.listSnapshotIds())) {
    const snapshot = (await readWorldModelSnapshot({ root: inspected.project.projectRoot, worldModelId, storeAdapter: adapter })).snapshot;
    if (graphSnapshotId && snapshot.temporalProvenanceGraph?.graphSnapshotId !== graphSnapshotId) continue;
    if (sourceSnapshotId && snapshot.temporalProvenanceGraph?.sourceSnapshotId !== sourceSnapshotId) continue;
    matches.push(snapshot);
  }
  matches.sort((left, right) => left.worldModelId.localeCompare(right.worldModelId));
  if (!matches.length) fail("No verified World Model snapshot matches the requested temporal identity.", "WORLD_MODEL_SNAPSHOT_NOT_FOUND");
  return { status: "verified", matches };
}

export async function inspectWorldModel({ root = ".", storeAdapter = null, runtimeStateAdapter = null } = {}) {
  const stored = (await readWorldModel({ root, storeAdapter }));
  const inspected = readyProject(root);
  const storage = inspected.storage;
  const sourceScopeState = readRepositorySourceScope({ storage, projectRoot: inspected.project.projectRoot });
  const sourceScope = sourceScopeState.sourceScope;
  const storedSourceScope = stored.snapshot.repositoryScan?.sourceScope || buildRepositorySourceScope({ storage });
  const sourceScopeChanged = sourceScope.sourceScopeId !== storedSourceScope.sourceScopeId;
  const { freshness, scan } = inspectRepositoryScanForWorld({ storage,
    projectRoot: inspected.project.projectRoot,
    managedRootFiles: managedRootFilesForProject(inspected.project, storage),
    sourceScope,
  }, { schemaVersion: 1, kind: "RepositoryScanResult", ...stored.snapshot.repositoryScan,
    files: stored.snapshot.files, skipped: stored.snapshot.skipped }, { sourceScopeChanged });
  const productCanon = readProductModelCanon({ storage, projectRoot: inspected.project.projectRoot });
  const onboardingProjection = loadOnboardingGraphProjection({ storage,
    projectRoot: inspected.project.projectRoot,
    projectId: inspected.project.projectId,
    currentProductModelId: productCanon.model.productModelId,
  });
  const productPolicyProjection = loadProductPolicyGraphProjection({ storage,
    projectRoot: inspected.project.projectRoot,
    projectId: inspected.project.projectId,
    currentProductModelId: productCanon.model.productModelId,
  });
  const featureMappingProjection = loadFeatureMappingProjection({ storage,
    projectRoot: inspected.project.projectRoot,
    projectId: inspected.project.projectId,
    currentProductModelId: productCanon.model.productModelId,
  });
  const changeSetProjection = loadChangeSetProjection({ storage,
    projectRoot: inspected.project.projectRoot,
    projectId: inspected.project.projectId,
  });
  const documentChangeProjection = loadDocumentChangeProjection({ storage,
    projectRoot: inspected.project.projectRoot,
    projectId: inspected.project.projectId,
  });
  const observationIntegration = loadObservationProjectionForWorld({ storage,
    projectRoot: inspected.project.projectRoot,
    projectId: inspected.project.projectId,
  });
  const observationProjection = observationIntegration.projection;
  const productOperatingProjection = loadProductOperatingProjection({ storage,
    projectRoot: inspected.project.projectRoot,
    projectId: inspected.project.projectId,
  });
  const releaseObservationProjection = loadReleaseObservationProjection({ storage,
    projectRoot: inspected.project.projectRoot,
    projectId: inspected.project.projectId,
  });
  const git = gitHeadState(inspected.project.projectRoot);
  const runtimeState = withSessionRoute(inspected.project.projectRoot, stored.snapshot.runtimeState.sessionId,
    () => runtimeStateFor(readyProject(inspected.project.projectRoot).state));
  const selectedRuntimeAdapter = runtimeStateAdapter || runtimeStateAdapterFromDescriptor(stored.pointer.sourceAdapters?.runtimeState);
  const externalRuntimeResult = buildExternalRuntimeState({ storage, projectRoot: inspected.project.projectRoot, adapter: selectedRuntimeAdapter });
  const externalRuntimeState = externalRuntimeResult.runtimeState;
  const currentSourceDigest = sourceDigestFor(
    scan.files,
    sourceScope,
    productCanon.model,
    onboardingProjection,
    productPolicyProjection,
    featureMappingProjection,
    changeSetProjection,
    documentChangeProjection,
    observationIntegration,
    productOperatingProjection,
    releaseObservationProjection,
    git,
    runtimeState,
    externalRuntimeState,
    indexerState(),
    stored.snapshot.semanticGraph?.sourceRelationEvidence?.evidenceSetHash || null,
    stored.snapshot.temporalProvenanceGraph?.parentSourceSnapshotIds || [],
    stored.snapshot.temporalProvenanceGraph?.revisionParentIds || {},
    stored.snapshot.temporalProvenanceGraph?.logicalLineageState || {},
  );
  const current = { files: scan.files };
  const currentByPath = new Map(scan.files.map((item) => [item.path, item.digest]));
  const storedByPath = new Map(stored.snapshot.files.map((item) => [item.path, item.digest]));
  const fileFreshness = stored.snapshot.files.map((item) => ({
    path: item.path,
    status: !currentByPath.has(item.path)
      ? "removed"
      : currentByPath.get(item.path) === item.digest
        ? "active"
        : "stale",
  }));
  for (const item of scan.files) if (!storedByPath.has(item.path)) fileFreshness.push({ path: item.path, status: "unindexed" });
  fileFreshness.sort((left, right) => left.path.localeCompare(right.path));
  const fileChanges = changesBetween(stored.snapshot, current);
  const productModelChanged = productCanon.model.productModelHash !== stored.snapshot.productModel?.productModelHash;
  const onboardingProjectionChanged = onboardingProjection.projectionInputHash !== stored.snapshot.onboardingProjection?.projectionInputHash;
  const productPolicyProjectionChanged = productPolicyProjection.projectionInputHash !== stored.snapshot.productPolicyProjection?.projectionInputHash;
  const featureMappingProjectionChanged = featureMappingProjection.projectionInputHash !== stored.snapshot.featureMappingProjection?.projectionInputHash;
  const changeSetProjectionChanged = changeSetProjection.projectionInputHash !== stored.snapshot.changeSetProjection?.projectionInputHash;
  const documentChangeProjectionChanged = documentChangeProjection.projectionInputHash !== stored.snapshot.documentChangeProjection?.projectionInputHash;
  const observationProjectionChanged = observationProjection.projectionHash !== stored.snapshot.observationProjection?.projectionHash
    || observationIntegration.status !== stored.snapshot.observationProjection?.status
    || observationIntegration.reasonCode !== stored.snapshot.observationProjection?.reasonCode;
  const productOperatingProjectionChanged = productOperatingProjection.projectionInputHash !== stored.snapshot.productOperatingProjection?.projectionInputHash;
  const releaseObservationProjectionChanged = releaseObservationProjection.projectionInputHash !== stored.snapshot.releaseObservationProjection?.projectionInputHash;
  const domainSnapshot = { ...stored.snapshot, files: scan.files, analysisBasis: codeAnalysisBasis(stored.snapshot.semanticGraph),
    repositoryScan: { ...stored.snapshot.repositoryScan, sourceScope }, rules: { ...stored.snapshot.rules, sourceScope },
    productModel: productCanon.model, onboardingProjection, productPolicyProjection, featureMappingProjection, changeSetProjection,
    documentChangeProjection, observationProjection: { ...observationProjection, status: observationIntegration.status, reasonCode: observationIntegration.reasonCode },
    productOperatingProjection, releaseObservationProjection, git, runtimeState, externalRuntimeState };
  const domainBases = domainBasesFor(domainSnapshot);
  const domainFreshness = Object.fromEntries(WORLD_DOMAINS.map(domain => [domain, stored.snapshot.domainBases?.[domain]
    ? { status: domainBases[domain] === stored.snapshot.domainBases[domain] ? "current" : "stale",
      storedBasis: stored.snapshot.domainBases[domain], currentBasis: domainBases[domain] }
    : { status: "unknown", reasonCode: "WORLD_DOMAIN_BASIS_UNRECORDED", fallback: "original-source" }]));
  return {
    ...stored,
    status: currentSourceDigest === stored.snapshot.sourceDigest ? "current" : "stale",
    currentSourceDigest,
    freshness: { domains: domainFreshness, scope: "full-world-aggregate-and-domains" },
    selectedSessionState: runtimeStateFor(inspected.state),
    capturedRuntimeSessionId: stored.snapshot.runtimeState.sessionId,
    changes: {
      ...fileChanges,
      sourceScopeChanged,
      gitChanged: canonicalJson(git) !== canonicalJson(stored.snapshot.git),
      gitHistoryChanged: git.referencesDigest !== stored.snapshot.git?.referencesDigest,
      runtimeStateChanged: canonicalJson(runtimeState) !== canonicalJson(stored.snapshot.runtimeState),
      externalRuntimeStateChanged: externalRuntimeState.runtimeStateHash !== stored.snapshot.externalRuntimeState?.runtimeStateHash,
      productModelChanged,
      onboardingProjectionChanged,
      productPolicyProjectionChanged,
      featureMappingProjectionChanged,
      changeSetProjectionChanged,
      documentChangeProjectionChanged,
      observationProjectionChanged,
      productOperatingProjectionChanged,
      releaseObservationProjectionChanged,
      temporalProvenanceChanged: sourceScopeChanged || fileChanges.added.length > 0 || fileChanges.changed.length > 0 || fileChanges.removed.length > 0
        || productModelChanged || onboardingProjectionChanged || productPolicyProjectionChanged || featureMappingProjectionChanged || changeSetProjectionChanged || documentChangeProjectionChanged || observationProjectionChanged || productOperatingProjectionChanged || releaseObservationProjectionChanged,
    },
    fileFreshness,
    sourceAdapters: { runtimeState: externalRuntimeResult.adapter },
    sourceDiagnostics: { runtimeState: externalRuntimeResult.diagnostics },
  };
}

function boundedPathSummary(items, limit) {
  const values = [...new Set((Array.isArray(items) ? items : []).filter((item) => typeof item === "string"))]
    .sort((left, right) => left.localeCompare(right));
  return {
    count: values.length,
    sample: values.slice(0, limit),
    omittedCount: Math.max(0, values.length - limit),
  };
}

function snapshotSerializedByteLength(snapshot) {
  const verifiedLength = verifiedSnapshotByteLengths.get(snapshot);
  return Number.isSafeInteger(verifiedLength)
    ? verifiedLength
    : Buffer.byteLength(JSON.stringify(snapshot), "utf8");
}

export function buildWorldModelStatusProjection(inspection, { sampleLimit = WORLD_MODEL_STATUS_SAMPLE_LIMIT } = {}) {
  if (!inspection?.snapshot || !inspection?.pointer || !new Set(["current", "stale"]).has(inspection.status)) {
    fail("A verified World Model inspection is required for status projection.", "INVALID_WORLD_MODEL_STATUS_INPUT");
  }
  if (!Number.isInteger(sampleLimit) || sampleLimit < 0 || sampleLimit > WORLD_MODEL_STATUS_SAMPLE_LIMIT) {
    fail(`World Model status sample limit must be between 0 and ${WORLD_MODEL_STATUS_SAMPLE_LIMIT}.`, "INVALID_WORLD_MODEL_STATUS_SAMPLE_LIMIT");
  }

  const snapshot = inspection.snapshot;
  const freshnessCounts = { active: 0, stale: 0, removed: 0, unindexed: 0 };
  const nonActiveFiles = [];
  for (const item of inspection.fileFreshness || []) {
    if (Object.hasOwn(freshnessCounts, item.status)) freshnessCounts[item.status] += 1;
    if (item.status !== "active") nonActiveFiles.push({ path: item.path, status: item.status });
  }
  nonActiveFiles.sort((left, right) => left.path.localeCompare(right.path) || left.status.localeCompare(right.status));

  const changeFlags = Object.fromEntries(Object.entries(inspection.changes || {})
    .filter(([, value]) => typeof value === "boolean")
    .sort(([left], [right]) => left.localeCompare(right)));
  const counts = Object.fromEntries(Object.entries(snapshot.summary || {})
    .filter(([, value]) => Number.isSafeInteger(value) && value >= 0)
    .sort(([left], [right]) => left.localeCompare(right)));
  const skippedCounts = Object.fromEntries(Object.entries(snapshot.skipped || {})
    .filter(([, value]) => Number.isSafeInteger(value) && value >= 0)
    .sort(([left], [right]) => left.localeCompare(right)));
  const storage = inspection.storeAdapter || {};
  const temporalGraph = snapshot.temporalProvenanceGraph || {};

  const payload = {
    schemaVersion: 1,
    kind: "WorldModelStatusProjection",
    protocol: { name: (familyFormatForOriginal("head-agent-core-world-model", inspection.snapshot) || formatForVerifiedOwner(inspection.storage)).protocol("head-agent-core-world-model-status"), version: WORLD_MODEL_STATUS_PROJECTION_VERSION },
    status: inspection.status,
    verification: {
      completeSnapshotDigestVerified: true,
      completeSnapshotStructureVerified: true,
      completeRepositoryFreshnessChecked: true,
    },
    authority: "derived-read-only-status-projection",
    authorityPlane: "P4-derived-relation-view",
    instructionAuthority: false,
    promotionAuthority: false,
    mutationAuthority: false,
    identities: {
      projectId: snapshot.projectId,
      worldModelId: snapshot.worldModelId,
      worldModelHash: snapshot.worldModelHash,
      storedSourceDigest: snapshot.sourceDigest,
      currentSourceDigest: inspection.currentSourceDigest,
      sourceSnapshotId: temporalGraph.sourceSnapshotId || snapshot.summary?.sourceSnapshotId || null,
      graphSnapshotId: temporalGraph.graphSnapshotId || null,
      graphSnapshotHash: temporalGraph.graphSnapshotHash || null,
      semanticGraphId: snapshot.semanticGraph?.semanticGraphId || null,
      semanticGraphHash: snapshot.semanticGraph?.semanticGraphHash || null,
      productModelId: snapshot.productModel?.productModelId || null,
      productModelHash: snapshot.productModel?.productModelHash || null,
    },
    counts,
    freshness: {
      domains: inspection.freshness?.domains || {},
      files: {
        counts: freshnessCounts,
        nonActiveSample: nonActiveFiles.slice(0, sampleLimit),
        omittedNonActiveCount: Math.max(0, nonActiveFiles.length - sampleLimit),
      },
      changes: {
        added: boundedPathSummary(inspection.changes?.added, sampleLimit),
        changed: boundedPathSummary(inspection.changes?.changed, sampleLimit),
        removed: boundedPathSummary(inspection.changes?.removed, sampleLimit),
        flags: changeFlags,
      },
    },
    skipped: {
      counts: skippedCounts,
      totalCount: Object.values(skippedCounts).reduce((total, count) => total + count, 0),
    },
    observations: {
      status: snapshot.observationProjection?.status || "not-projected",
      reasonCode: snapshot.observationProjection?.reasonCode || "",
      descriptorCount: snapshot.observationProjection?.descriptorIds?.length || 0,
      observationCount: snapshot.observationProjection?.observationIds?.length || 0,
      derivedObservationCount: snapshot.observationProjection?.derivedObservationIds?.length || 0,
      effect: "observation-graph-layer-only",
    },
    storage: {
      contract: storage.contract || null,
      adapterKind: storage.adapterKind || null,
      adapterVersion: storage.adapterVersion || null,
      authority: storage.authority || null,
      rebuildable: storage.rebuildable === true,
      uniqueAuthority: storage.uniqueAuthority === true,
      remote: storage.remote === true,
      durable: storage.durable === true,
    },
    fullSnapshot: {
      omitted: true,
      serializedByteLength: snapshotSerializedByteLength(snapshot),
      worldModelId: snapshot.worldModelId,
      worldModelHash: snapshot.worldModelHash,
      localInspectionCommand: `${ARTIFACT_COMPOSITION.identity === "lode" ? "lode-agent" : "head-agent"} world-status <project>`,
      boundedDetailTools: ["head_world_query", "head_temporal_graph", "head_git_history", "head_runtime_state"].map(publicToolName),
    },
  };
  const statusProjectionHash = digest(canonicalJson(payload));
  const projection = {
    ...payload,
    statusProjectionId: `world-model-status-${statusProjectionHash.slice(0, 24)}`,
    statusProjectionHash,
  };
  const byteLength = Buffer.byteLength(JSON.stringify(projection), "utf8");
  if (byteLength > WORLD_MODEL_STATUS_PROJECTION_MAX_BYTES) {
    fail(`World Model status projection exceeds ${WORLD_MODEL_STATUS_PROJECTION_MAX_BYTES} bytes.`, "WORLD_MODEL_STATUS_PROJECTION_TOO_LARGE");
  }
  return projection;
}

export async function inspectWorldModelStatus({ root = ".", storeAdapter = null, runtimeStateAdapter = null } = {}) {
  return buildWorldModelStatusProjection((await inspectWorldModel({ root, storeAdapter, runtimeStateAdapter })));
}

async function buildWorldModelLocked({
  root = ".",
  persist = true,
  storeAdapter = null,
  graphProjectionAdapter = null,
  gitHistoryAdapter = null,
  runtimeStateAdapter = null,
  sourceRelationEvidenceAdapter = null,
  computeAdapter = null,
  onboardingProjectionInput = null,
  productPolicyProjectionInput = null,
  featureMappingProjectionInput = null,
  changeSetProjectionInput = null,
  documentChangeProjectionInput = null,
  observationProjectionInput = null,
  productOperatingProjectionInput = null,
  releaseObservationProjectionInput = null,
  parentSourceSnapshotIds = [],
  revisionParentIds = {},
  logicalLineageState = null,
  filterRevisionParentsToCurrentEntities = false,
  repositoryScanExecution = null,
  expectedWorldModelId = "",
  expectedCurrentWorldModelId = "",
  writerLease = null,
} = {}) {
  if (filterRevisionParentsToCurrentEntities && persist) {
    fail("Current-entity revision-parent filtering is available only for non-persisted refresh previews.", "REVISION_PARENT_FILTER_PREVIEW_ONLY");
  }
  const inspected = readyProject(root);
  const storage = inspected.storage;
  const project = inspected.project;
  const worldStoreAdapter = createWorldModelStoreAdapter({ storage, projectRoot: project.projectRoot, adapter: storeAdapter });
  const initialPointerEntry = worldStoreAdapter.readPointer();
  const initialPointerBasis = canonicalJson(initialPointerEntry?.document || null);
  if (expectedCurrentWorldModelId && initialPointerEntry?.document?.worldModelId !== expectedCurrentWorldModelId) {
    fail("World Model current pointer changed before refresh preparation.", "REFRESH_POINTER_CONFLICT");
  }
  const managedRootFiles = managedRootFilesForProject(project, storage);
  const sourceScope = readRepositorySourceScope({ storage, projectRoot: project.projectRoot }).sourceScope;
  const selectedRepositoryScanExecution = repositoryScanExecution
    ? validateRepositoryScanExecution(repositoryScanExecution, { projectRoot: project.projectRoot, managedRootFiles, sourceScope, storage })
    : await executeRepositoryScan({ storage,
      adapter: computeAdapter || createRepositoryScanComputeAdapter({ storage }),
      projectRoot: project.projectRoot,
      managedRootFiles,
      sourceScope,
    });
  const scan = validateRepositoryScanResult(selectedRepositoryScanExecution.result, { storage });
  const productCanon = readProductModelCanon({ storage, projectRoot: project.projectRoot });
  const productCanonBasis = canonBytes(project.projectRoot, storage);
  if ((productCanonBasis === null ? null : digest(productCanonBasis)) !== productCanon.sourceDigest) {
    fail("Product Canon changed while its snapshot input was read.", "WORLD_MODEL_CANON_BASIS_CONFLICT");
  }
  let previousTemporalGraph = null;
  let previousWorldSnapshot = null;
  let previousTemporalStateUnavailable = false;
  let previousWorldReadCode = "";
  if (logicalLineageState == null) {
    try {
      previousWorldSnapshot = (await readWorldModel({ root: project.projectRoot, storeAdapter: worldStoreAdapter })).snapshot;
      previousTemporalGraph = previousWorldSnapshot.temporalProvenanceGraph;
    } catch (error) {
      if (!new Set(["WORLD_MODEL_NOT_BUILT", "WORLD_MODEL_SNAPSHOT_MISSING"]).has(error.code)) throw error;
      previousWorldReadCode = error.code;
      const failedWorldPointer = worldStoreAdapter.readPointer()?.document || null;
      previousTemporalGraph = (await readRecoverableTemporalGraphProjection({ storage,
        projectRoot: project.projectRoot,
        projectId: project.projectId,
        adapter: graphProjectionAdapter,
        expectedPointer: failedWorldPointer,
      }));
      if (error.code === "WORLD_MODEL_SNAPSHOT_MISSING") {
        if (!previousTemporalGraph) {
          const previousId = failedWorldPointer?.previousWorldModelId || "";
          const previousEntry = /^world-model-[a-f0-9]{24}$/.test(previousId) ? (await worldStoreAdapter.readSnapshot(previousId)) : null;
          if (previousEntry) previousTemporalGraph = verifiedSnapshot(previousEntry.document, previousId, storage).temporalProvenanceGraph;
          previousTemporalStateUnavailable = true;
        }
      }
    }
  }
  const onboardingProjection = onboardingProjectionInput || loadOnboardingGraphProjection({ storage,
    projectRoot: project.projectRoot,
    projectId: project.projectId,
    currentProductModelId: productCanon.model.productModelId,
  });
  const productPolicyProjection = productPolicyProjectionInput || loadProductPolicyGraphProjection({ storage,
    projectRoot: project.projectRoot,
    projectId: project.projectId,
    currentProductModelId: productCanon.model.productModelId,
  });
  const featureMappingProjection = featureMappingProjectionInput || loadFeatureMappingProjection({ storage,
    projectRoot: project.projectRoot,
    projectId: project.projectId,
    currentProductModelId: productCanon.model.productModelId,
  });
  const changeSetProjection = changeSetProjectionInput || loadChangeSetProjection({ storage,
    projectRoot: project.projectRoot,
    projectId: project.projectId,
  });
  const documentChangeProjection = documentChangeProjectionInput || loadDocumentChangeProjection({ storage,
    projectRoot: project.projectRoot,
    projectId: project.projectId,
  });
  if (logicalLineageState == null && previousWorldReadCode === "WORLD_MODEL_NOT_BUILT" && !previousTemporalGraph
    && ((await worldStoreAdapter.listSnapshotIds()).length > 0 || projectionProvesEarlierWorld({
      productPolicyProjection,
      featureMappingProjection,
      changeSetProjection,
      documentChangeProjection,
    }))) previousTemporalStateUnavailable = true;
  const observationIntegration = observationProjectionInput
    ? { projection: observationProjectionInput, status: "projected", reasonCode: "" }
    : loadObservationProjectionForWorld({ storage, projectRoot: project.projectRoot, projectId: project.projectId });
  const observationProjection = observationIntegration.projection;
  const productOperatingProjection = productOperatingProjectionInput || loadProductOperatingProjection({ storage,
    projectRoot: project.projectRoot,
    projectId: project.projectId,
  });
  const releaseObservationProjection = releaseObservationProjectionInput || loadReleaseObservationProjection({ storage,
    projectRoot: project.projectRoot,
    projectId: project.projectId,
  });
  const git = gitHeadState(project.projectRoot);
  const runtimeState = runtimeStateFor(inspected.state);
  const indexer = indexerState();
  const externalRuntimeResult = buildExternalRuntimeState({ storage, projectRoot: project.projectRoot, adapter: runtimeStateAdapter });
  const externalRuntimeState = externalRuntimeResult.runtimeState;
  const sourceRelationResult = await collectSourceRelationEvidence({ storage,
    projectId: project.projectId,
    projectRoot: project.projectRoot,
    files: scan.files.map((file) => ({ path: file.path, digest: file.digest, language: file.language })),
    adapter: sourceRelationEvidenceAdapter,
  });
  const snapshotRules = {
      maxFileBytes: REPOSITORY_SCAN_DEFAULTS.maxFileBytes,
      maxFiles: REPOSITORY_SCAN_DEFAULTS.maxFiles,
      maxTotalBytes: REPOSITORY_SCAN_DEFAULTS.maxTotalBytes,
      maxSymbolsPerFile: REPOSITORY_SCAN_DEFAULTS.maxSymbolsPerFile,
      excludedDirectories: REPOSITORY_SCAN_EXCLUDED_DIRECTORIES,
      managedRootProjectionsExcluded: managedRootFilesForProject(project, storage),
      sourceScope,
    };
  const domainBundleCandidate = worldStoreAdapter.describe().snapshotLayout === "domain-bundles-v1";
  // Include every scanner fact and relation input consumed by semantic analysis,
  // not only mtime/size/digest. A verified previous result is request-local reuse.
  const codeAnalysisInputBasis = domainBundleCandidate ? digest(canonicalJson({
    projectId: project.projectId, files: scan.files, sourceScope,
    analysisBasis: codeAnalysisBasis({ sourceRelationEvidence: sourceRelationResult.evidence }),
    sourceRelationEvidence: sourceRelationResult.evidence,
    rules: { defaults: REPOSITORY_SCAN_DEFAULTS, excludedDirectories: REPOSITORY_SCAN_EXCLUDED_DIRECTORIES,
      managedRootFiles, dialect: formatForVerifiedOwner(storage).dialect },
  })) : null;
  const codeAnalysisReused = domainBundleCandidate && previousWorldSnapshot?.codeAnalysisInputBasis === codeAnalysisInputBasis;
  const semanticGraph = codeAnalysisReused ? previousWorldSnapshot.semanticGraph
    : buildSemanticGraph({ storage, files: scan.files, sourceRelationEvidence: sourceRelationResult.evidence });
  const selectedRevisionParentIds = filterRevisionParentsToCurrentEntities
    ? filterRevisionParentsForCurrentTemporalEntities({
      projectId: project.projectId,
      files: scan.files,
      productModel: productCanon.model,
      revisionParentIds,
    })
    : revisionParentIds;
  const selectedLogicalLineageState = logicalLineageState == null
    ? deriveIncrementalLogicalLineageState({
      previousGraph: previousTemporalGraph,
      currentLogicalEntityIds: currentTemporalLogicalEntityIds({ projectId: project.projectId, files: scan.files, productModel: productCanon.model }),
      previousStateUnavailable: previousTemporalStateUnavailable,
    })
    : filterRevisionParentsToCurrentEntities
      ? filterLogicalLineageStateForCurrentTemporalEntities({
        projectId: project.projectId,
        files: scan.files,
        productModel: productCanon.model,
        logicalLineageState,
      })
      : logicalLineageState;
  let temporalProvenanceGraph = buildTemporalProvenanceGraph({ storage,
    projectId: project.projectId,
    files: scan.files,
    productModel: productCanon.model,
    productEvidenceId: productCanon.evidenceId,
    onboardingProjection,
    productPolicyProjection,
    featureMappingProjection,
    changeSetProjection,
    documentChangeProjection,
    observationProjection,
    productOperatingProjection,
    releaseObservationProjection,
    parentSourceSnapshotIds,
    revisionParentIds: selectedRevisionParentIds,
    logicalLineageState: selectedLogicalLineageState,
  });
  if (worldStoreAdapter.describe().snapshotLayout === "domain-bundles-v1") {
    temporalProvenanceGraph = stabilizeTemporalRelationIdentities(temporalProvenanceGraph, { relationAnalysisBasis: relationBasisFor({ analysisBasis: codeAnalysisBasis(semanticGraph), rules: snapshotRules, repositoryScan: { sourceScope } }) });
    verifyTemporalProvenanceGraph(temporalProvenanceGraph);
  }
  const sourceDigest = sourceDigestFor(
    scan.files,
    sourceScope,
    productCanon.model,
    onboardingProjection,
    productPolicyProjection,
    featureMappingProjection,
    changeSetProjection,
    documentChangeProjection,
    observationIntegration,
    productOperatingProjection,
    releaseObservationProjection,
    git,
    runtimeState,
    externalRuntimeState,
    indexer,
    sourceRelationResult.evidence?.evidenceSetHash || null,
    temporalProvenanceGraph.parentSourceSnapshotIds,
    temporalProvenanceGraph.revisionParentIds,
    temporalProvenanceGraph.logicalLineageState,
  );
  const gitHistoryResult = await buildGitDecisionHistory({ storage,
    projectRoot: project.projectRoot,
    adapter: gitHistoryAdapter,
    referenceCommits: git.referenceCommits || [],
    referenceTags: git.referenceTags || [],
  });
  const gitDecisionHistory = gitHistoryResult.history;
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    kind: "RepositoryWorldModel",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-world-model"), version: WORLD_MODEL_VERSION },
    storageContract: WORLD_MODEL_STORAGE_CONTRACT,
    projectId: project.projectId,
    projectRoot: project.projectRoot,
    sourceDigest,
    indexer,
    rules: snapshotRules,
    coverage: {
      files: "supported-text-files-within-rules",
      repositoryScan: "compute-adapter-validated-relative-path-digest-and-source-facts",
      symbols: "heuristic-javascript-typescript-python-markdown-with-content-derived-identities",
      dependencies: "heuristic-module-resolution-and-package-manifests",
      semanticGraph: sourceRelationResult.evidence
        ? "heuristic-fallback-plus-source-separated-language-ast-import-call-evidence"
        : "heuristic-file-symbol-import-call-graph-with-evidence-locations",
      temporalProvenanceGraph: "content-addressed-file-symbol-test-revisions-with-multiple-parent-dag",
      productModel: "user-owned-feature-capability-requirement-constraint-decision-policy-canon-projected-into-temporal-graph",
      onboardingProjection: "immutable-candidates-evidence-unknowns-reviews-and-product-model-revision-receipts-projected-without-authority-escalation",
      productPolicyProjection: "immutable-policy-candidates-explicit-review-decisions-exact-product-model-revisions-and-evidence-traces-projected-without-authority-escalation",
      featureMappingProjection: "immutable-feature-mapping-candidates-and-explicit-review-decisions-with-separate-reviewed-relationship-promotion",
      changeSetProjection: "reviewed-provider-neutral-changesets-with-review-gated-feature-impact-and-optional-vcs-evidence-relations",
      documentChangeProjection: "immutable-document-edit-candidates-reviews-product-revisions-and-application-receipts-projected-as-non-authoritative-audit-lineage",
      observationProjection: "provider-neutral-observation-descriptors-records-receipts-and-derived-lineage-as-p3-evidence-and-p4-graph",
      productOperatingProjection: "epistemically-typed-signals-hypotheses-human-reviewed-initiatives-feature-links-and-outcome-observations-as-derived-product-graph",
      releaseObservationProjection: "provider-neutral-git-ref-deployment-result-and-release-observations-as-p3-evidence-and-p4-graph",
      gitHistory: gitDecisionHistory.coverage,
      runtimeState: formatForVerifiedOwner(storage).value("canonical-head-lifecycle-state"),
      externalRuntimeState: externalRuntimeState.coverage,
    },
    git,
    gitDecisionHistory,
    runtimeState,
    externalRuntimeState,
    productModel: productCanon.model,
    productModelSource: { status: productCanon.status, relativePath: productCanon.relativePath, evidenceId: productCanon.evidenceId },
    onboardingProjection: {
      projectionInputId: onboardingProjection.projectionInputId,
      projectionInputHash: onboardingProjection.projectionInputHash,
      candidateSetIds: onboardingProjection.candidateSets.map((item) => item.candidateSetId),
      reviewDecisionIds: onboardingProjection.reviewDecisions.map((item) => item.reviewDecisionId),
      productModelRevisionIds: onboardingProjection.productModelRevisions.map((item) => item.productModelId),
      authority: "derived-projection-manifest-not-project-canon",
      instructionAuthority: false,
      promotionAuthority: false,
    },
    productPolicyProjection: {
      projectionInputId: productPolicyProjection.projectionInputId,
      projectionInputHash: productPolicyProjection.projectionInputHash,
      candidateIds: productPolicyProjection.candidates.map((entry) => entry.candidate.candidateId),
      reviewDecisionIds: productPolicyProjection.reviewDecisions.map((review) => review.reviewDecisionId),
      authority: "derived-projection-manifest-not-project-canon",
      instructionAuthority: false,
      promotionAuthority: false,
      recoveryAuthority: false,
    },
    featureMappingProjection: {
      projectionInputId: featureMappingProjection.projectionInputId,
      projectionInputHash: featureMappingProjection.projectionInputHash,
      candidateSetIds: featureMappingProjection.candidateSets.map((item) => item.candidateSetId),
      reviewDecisionIds: featureMappingProjection.reviewDecisions.map((item) => item.reviewDecisionId),
      authority: "derived-projection-manifest-not-project-canon",
      instructionAuthority: false,
      promotionAuthority: false,
    },
    changeSetProjection: {
      projectionInputId: changeSetProjection.projectionInputId,
      projectionInputHash: changeSetProjection.projectionInputHash,
      changeSetIds: changeSetProjection.changeSets.map((item) => item.changeSetId),
      candidateSetIds: changeSetProjection.candidateSets.map((item) => item.candidateSetId),
      reviewDecisionIds: changeSetProjection.reviewDecisions.map((item) => item.reviewDecisionId),
      vcsEvidenceIds: changeSetProjection.vcsEvidence.map((item) => item.vcsEvidenceId),
      authority: "derived-projection-manifest-not-change-lineage-authority",
      instructionAuthority: false,
      promotionAuthority: false,
    },
    documentChangeProjection: {
      projectionInputId: documentChangeProjection.projectionInputId,
      projectionInputHash: documentChangeProjection.projectionInputHash,
      candidateSetIds: documentChangeProjection.candidateSets.map((item) => item.candidateSetId),
      reviewDecisionIds: documentChangeProjection.reviewDecisions.map((item) => item.reviewDecisionId),
      productModelRevisionIds: documentChangeProjection.productModelRevisions.map((item) => `document-product-model-revision-${item.revisionHash.slice(0, 24)}`),
      applicationReceiptIds: documentChangeProjection.applicationReceipts.map((item) => item.applicationReceiptId),
      authority: "derived-projection-manifest-not-document-authority",
      instructionAuthority: false,
      promotionAuthority: false,
    },
    observationProjection: {
      status: observationIntegration.status,
      reasonCode: observationIntegration.reasonCode,
      projectionId: observationProjection.projectionId,
      projectionHash: observationProjection.projectionHash,
      descriptorIds: observationProjection.descriptorIds,
      observationIds: observationProjection.observationIds,
      derivedObservationIds: observationProjection.derivedObservationIds,
      receiptIds: observationProjection.receiptIds,
      authority: "derived-projection-manifest-not-observation-or-product-authority",
      instructionAuthority: false,
      promotionAuthority: false,
      recoveryAuthority: false,
    },
    productOperatingProjection: {
      projectionInputId: productOperatingProjection.projectionInputId,
      projectionInputHash: productOperatingProjection.projectionInputHash,
      signalIds: productOperatingProjection.signals.map((item) => item.signalId),
      hypothesisIds: productOperatingProjection.hypotheses.map((item) => item.hypothesisId),
      initiativeCandidateIds: productOperatingProjection.initiativeCandidates.map((item) => item.initiativeCandidateId),
      reviewDecisionIds: productOperatingProjection.initiativeReviews.map((item) => item.reviewDecisionId),
      reviewedInitiativeIds: productOperatingProjection.reviewedInitiatives.map((item) => item.initiativeId),
      featureCandidateIds: productOperatingProjection.featureCandidates.map((item) => item.featureCandidateId),
      outcomeObservationIds: productOperatingProjection.outcomeObservations.map((item) => item.outcomeObservationId),
      authority: "derived-product-graph-manifest-not-product-or-execution-canon",
      instructionAuthority: false,
      promotionAuthority: false,
    },
    releaseObservationProjection: {
      projectionInputId: releaseObservationProjection.projectionInputId,
      projectionInputHash: releaseObservationProjection.projectionInputHash,
      branchStateObservationIds: releaseObservationProjection.branchStates.map((item) => item.branchStateObservationId),
      deploymentResultObservationIds: releaseObservationProjection.deploymentResults.map((item) => item.deploymentResultObservationId),
      releaseObservationIds: releaseObservationProjection.releases.map((item) => item.releaseObservationId),
      authority: "derived-projection-manifest-not-release-authority",
      instructionAuthority: false,
      promotionAuthority: false,
    },
    repositoryScan: {
      scanId: scan.scanId,
      scanHash: scan.scanHash,
      protocol: scan.protocol,
      sourceAnalysisVersion: scan.sourceAnalysisVersion,
      authority: scan.authority,
      instructionAuthority: false,
      promotionAuthority: false,
      sourceScope: scan.sourceScope,
      summary: scan.summary,
    },
    files: scan.files,
    semanticGraph,
    temporalProvenanceGraph,
    skipped: scan.skipped,
    summary: {
      fileCount: scan.files.length,
      symbolCount: scan.files.reduce((count, item) => count + item.symbols.length, 0),
      dependencyCount: scan.files.reduce((count, item) => count + item.dependencies.length, 0),
      semanticNodeCount: semanticGraph.summary.nodeCount,
      semanticEdgeCount: semanticGraph.summary.edgeCount,
      callEdgeCount: semanticGraph.summary.callEdgeCount,
      temporalNodeCount: temporalProvenanceGraph.summary.nodeCount,
      temporalEdgeCount: temporalProvenanceGraph.summary.edgeCount,
      sourceSnapshotId: temporalProvenanceGraph.sourceSnapshotId,
      featureGroupCount: temporalProvenanceGraph.summary.featureGroupCount,
      capabilityCount: temporalProvenanceGraph.summary.capabilityCount,
      featureCount: temporalProvenanceGraph.summary.featureCount,
      requirementCount: temporalProvenanceGraph.summary.requirementCount,
      constraintCount: temporalProvenanceGraph.summary.constraintCount,
      decisionCount: temporalProvenanceGraph.summary.decisionCount,
      onboardingCandidateSetCount: temporalProvenanceGraph.summary.onboardingCandidateSetCount,
      onboardingCandidateCount: temporalProvenanceGraph.summary.onboardingCandidateCount,
      onboardingEvidenceCount: temporalProvenanceGraph.summary.onboardingEvidenceCount,
      onboardingUnknownCount: temporalProvenanceGraph.summary.onboardingUnknownCount,
      onboardingReviewDecisionCount: temporalProvenanceGraph.summary.onboardingReviewDecisionCount,
      onboardingAcceptedCandidateCount: temporalProvenanceGraph.summary.onboardingAcceptedCandidateCount,
      onboardingRejectedCandidateCount: temporalProvenanceGraph.summary.onboardingRejectedCandidateCount,
      productModelRevisionReceiptCount: temporalProvenanceGraph.summary.productModelRevisionReceiptCount,
      featureMappingCandidateSetCount: temporalProvenanceGraph.summary.featureMappingCandidateSetCount,
      featureMappingCandidateCount: temporalProvenanceGraph.summary.featureMappingCandidateCount,
      featureMappingReviewDecisionCount: temporalProvenanceGraph.summary.featureMappingReviewDecisionCount,
      reviewedRelationshipCount: temporalProvenanceGraph.summary.reviewedRelationshipCount,
      changeSetCount: temporalProvenanceGraph.summary.changeSetCount,
      changeRecordCount: temporalProvenanceGraph.summary.changeRecordCount,
      changeImpactCandidateCount: temporalProvenanceGraph.summary.changeImpactCandidateCount,
      changeImpactReviewDecisionCount: temporalProvenanceGraph.summary.changeImpactReviewDecisionCount,
      reviewedImpactCount: temporalProvenanceGraph.summary.reviewedImpactCount,
      documentChangeCandidateSetCount: temporalProvenanceGraph.summary.documentChangeCandidateSetCount,
      documentChangeCandidateCount: temporalProvenanceGraph.summary.documentChangeCandidateCount,
      documentChangeReviewDecisionCount: temporalProvenanceGraph.summary.documentChangeReviewDecisionCount,
      documentChangeProductModelRevisionCount: temporalProvenanceGraph.summary.documentChangeProductModelRevisionCount,
      documentChangeApplicationCount: temporalProvenanceGraph.summary.documentChangeApplicationCount,
      gitCommitCount: gitDecisionHistory.summary.commitCount,
      runtimeObservationCount: externalRuntimeState.summary.observationCount,
    },
  };
  if (domainBundleCandidate) payload.codeAnalysisInputBasis = codeAnalysisInputBasis;
  payload.analysisBasis = codeAnalysisBasis(semanticGraph);
  payload.domainBases = domainBasesFor(payload);
  const worldModelHash = digest(canonicalJson(payload));
  const worldModelId = `world-model-${worldModelHash.slice(0, 24)}`;
  const snapshot = { ...payload, worldModelId, worldModelHash };
  if (!persist) return {
    status: "preview",
    snapshot,
    sourceAdapters: { compute: selectedRepositoryScanExecution.diagnostics, sourceRelationEvidence: sourceRelationResult.diagnostics, ...(domainBundleCandidate ? { codeAnalysis: { reused: codeAnalysisReused, inputBasis: codeAnalysisInputBasis } } : {}) },
    sourceDiagnostics: { compute: selectedRepositoryScanExecution.diagnostics, sourceRelationEvidence: sourceRelationResult.diagnostics, ...(domainBundleCandidate ? { codeAnalysis: { reused: codeAnalysisReused, inputBasis: codeAnalysisInputBasis } } : {}) },
  };

  if (expectedWorldModelId && worldModelId !== expectedWorldModelId) {
    fail("World Model changed after refresh preview; current pointer was not advanced.", "REFRESH_PREVIEW_DRIFT");
  }

  const adapter = worldStoreAdapter;
  let previous = null;
  let previousPointer = null;
  const currentPointerEntry = adapter.readPointer();
  if (expectedCurrentWorldModelId && currentPointerEntry?.document?.worldModelId !== expectedCurrentWorldModelId) {
    fail("World Model current pointer changed during refresh.", "REFRESH_POINTER_CONFLICT");
  }
  if (currentPointerEntry) {
    try {
      const current = (await readWorldModel({ root: project.projectRoot, storeAdapter: adapter }));
      previous = current.snapshot;
      previousPointer = current.pointer;
    } catch (error) {
      // Only an explicitly requested rebuild may replace this missing P4 view.
      // readWorldModel already verified the pointer's Project/type/hash identity;
      // no prior snapshot content or canonical authority is inferred from it.
      if (error.code !== "WORLD_MODEL_SNAPSHOT_MISSING") throw error;
    }
  }
  const existingSnapshot = (await adapter.readSnapshot(worldModelId));
  let snapshotEntry;
  if (existingSnapshot) {
    verifiedSnapshot(existingSnapshot.document, worldModelId);
    snapshotEntry = existingSnapshot;
  } else {
    snapshotEntry = (await adapter.writeSnapshot(worldModelId, snapshot));
  }
  verifiedSnapshot(snapshotEntry.document, worldModelId);
  let preparedGraph;
  try {
    preparedGraph = await prepareGraphProjection({ storage, projectRoot: project.projectRoot, graph: temporalProvenanceGraph, adapter: graphProjectionAdapter });
  } catch (error) { throw noteCanonBasisError(error, project.projectRoot, storage, productCanonBasis); }
  const graphProjection = { adapter: { ...preparedGraph.selected.describe(), ...(typeof preparedGraph.selected.diagnostics === "function" ? preparedGraph.selected.diagnostics() : {}) }, pointer: preparedGraph.pointer };
  const changed = !previous || previous.worldModelId !== worldModelId;
  const fileChanges = changed ? changesBetween(previous, snapshot) : { added: [], changed: [], removed: [] };
  const changes = {
    ...fileChanges,
    gitChanged: changed && canonicalJson(previous?.git || null) !== canonicalJson(snapshot.git),
    gitHistoryChanged: changed && previous?.gitDecisionHistory?.historyHash !== snapshot.gitDecisionHistory.historyHash,
    runtimeStateChanged: changed && canonicalJson(previous?.runtimeState || null) !== canonicalJson(snapshot.runtimeState),
    externalRuntimeStateChanged: changed && previous?.externalRuntimeState?.runtimeStateHash !== snapshot.externalRuntimeState.runtimeStateHash,
    productModelChanged: changed && previous?.productModel?.productModelHash !== snapshot.productModel.productModelHash,
    onboardingProjectionChanged: changed && previous?.onboardingProjection?.projectionInputHash !== snapshot.onboardingProjection.projectionInputHash,
    productPolicyProjectionChanged: changed && previous?.productPolicyProjection?.projectionInputHash !== snapshot.productPolicyProjection.projectionInputHash,
    featureMappingProjectionChanged: changed && previous?.featureMappingProjection?.projectionInputHash !== snapshot.featureMappingProjection.projectionInputHash,
    changeSetProjectionChanged: changed && previous?.changeSetProjection?.projectionInputHash !== snapshot.changeSetProjection.projectionInputHash,
    observationProjectionChanged: changed && previous?.observationProjection?.projectionHash !== snapshot.observationProjection.projectionHash,
    productOperatingProjectionChanged: changed && previous?.productOperatingProjection?.projectionInputHash !== snapshot.productOperatingProjection.projectionInputHash,
    releaseObservationProjectionChanged: changed && previous?.releaseObservationProjection?.projectionInputHash !== snapshot.releaseObservationProjection.projectionInputHash,
    temporalProvenanceChanged: changed && previous?.temporalProvenanceGraph?.graphSnapshotHash !== snapshot.temporalProvenanceGraph.graphSnapshotHash,
  };
  const pointer = {
    schemaVersion: SCHEMA_VERSION,
    kind: "WorldModelPointer",
    projectId: project.projectId,
    storage: adapter.describe(),
    worldModelId,
    worldModelHash,
    previousWorldModelId: changed ? previous?.worldModelId || null : previousPointer?.previousWorldModelId || null,
    sourceAdapters: {
      compute: {
        backend: selectedRepositoryScanExecution.diagnostics.backend,
        adapterName: selectedRepositoryScanExecution.diagnostics.adapterName,
        executionMode: selectedRepositoryScanExecution.diagnostics.executionMode,
        requestId: selectedRepositoryScanExecution.request.requestId,
        resultDigest: selectedRepositoryScanExecution.response.resultDigest,
        fallbackUsed: selectedRepositoryScanExecution.diagnostics.fallbackUsed || false,
        fallbackReasonCode: selectedRepositoryScanExecution.diagnostics.fallbackReasonCode || "",
        workerRelativePath: selectedRepositoryScanExecution.diagnostics.workerRelativePath || "",
        workerSha256: selectedRepositoryScanExecution.diagnostics.workerSha256 || "",
      },
      runtimeState: externalRuntimeResult.adapter,
      sourceRelationEvidence: sourceRelationResult.diagnostics,
      graphProjection: {
        ...graphProjection.adapter,
        pointerId: graphProjection.pointer.pointerId,
        graphSnapshotId: graphProjection.pointer.graphSnapshotId,
        graphSnapshotHash: graphProjection.pointer.graphSnapshotHash,
      },
    },
    tiers: {
      hot: worldModelId,
      warm: changes,
      cold: "adapter-retained-snapshots",
      coldSnapshotCount: (await adapter.listSnapshotIds()).length,
    },
  };
  let pointerEntry;
  let publishedGraph;
  let graphPointerAttempted = false, worldPointerAttempted = false;
  try {
    withProjectMutation({ root: project.projectRoot, storage, scope: "session-recovery" }, () => {
      const currentOwner = readyProject(project.projectRoot);
      if (currentOwner.project.projectId !== project.projectId) fail("World publication Project identity changed.", "WORLD_MODEL_IDENTITY_MISMATCH");
      assertCanonBasis(project.projectRoot, storage, productCanonBasis);
      if (canonicalJson(adapter.readPointer()?.document || null) !== initialPointerBasis) {
        fail("World Model current pointer changed during preparation.", "REFRESH_POINTER_CONFLICT");
      }
      graphPointerAttempted = true;
      publishedGraph = publishPreparedGraphProjection(preparedGraph);
      assertCanonBasis(project.projectRoot, storage, productCanonBasis);
      worldPointerAttempted = true;
      pointerEntry = adapter.writePointer(pointer);
      if (pointerEntry && typeof pointerEntry.then === "function") fail("Current pointer publication must be synchronous within the short Canon commit scope.", "WORLD_MODEL_STORE_WRITE_MISMATCH");
      if (canonicalJson(pointerEntry.document) !== canonicalJson(pointer)) {
        fail("World Model store adapter changed the pointer during persistence.", "WORLD_MODEL_STORE_WRITE_MISMATCH");
      }
      assertCanonBasis(project.projectRoot, storage, productCanonBasis);
    });
  } catch (error) {
    if (graphPointerAttempted) {
      error.worldPublication = { world: worldPointerAttempted ? "failed-or-uncertain" : "not-attempted", graphLocal: publishedGraph ? "published" : "failed-or-uncertain", worldModelId };
      error.message += ` Local Graph publication: ${error.worldPublication.graphLocal}; World pointer publication: ${error.worldPublication.world}. Current pointers were not rolled back.`;
    }
    throw noteCanonBasisError(error, project.projectRoot, storage, productCanonBasis);
  }
  try {
    assertCanonBasis(project.projectRoot, storage, productCanonBasis);
    publishedGraph = await completePreparedGraphProjection(preparedGraph, publishedGraph);
    assertCanonBasis(project.projectRoot, storage, productCanonBasis);
    if (canonicalJson(adapter.readPointer()?.document || null) !== canonicalJson(pointer)) {
      fail("World current changed while external projection was completing; preserve the newer current.", "REFRESH_POINTER_CONFLICT");
    }
  } catch (error) {
    error.worldPublication = { world: "published", graphLocal: error.graphPublication?.local === "superseded" ? "published-then-superseded" : "published", worldModelId };
    error.message += ` Local World pointer was published (${worldModelId}); local Graph publication: ${error.worldPublication.graphLocal}; dependent projection did not complete against the same current basis. Current pointers were not rolled back.`;
    throw noteCanonBasisError(error, project.projectRoot, storage, productCanonBasis);
  }
  return {
    status: changed ? "indexed" : "unchanged",
    pointerFile: pointerEntry.location,
    file: snapshotEntry.location,
    ...(snapshotEntry.snapshotStorage ? { snapshotStorage: snapshotEntry.snapshotStorage } : {}),
    pointer,
    snapshot,
    storeAdapter: adapter.describe(),
    graphProjection: publishedGraph,
    sourceAdapters: {
      compute: pointer.sourceAdapters.compute,
      gitHistory: gitHistoryResult.adapter,
      runtimeState: externalRuntimeResult.adapter,
      graphProjection: pointer.sourceAdapters.graphProjection,
      sourceRelationEvidence: pointer.sourceAdapters.sourceRelationEvidence,
    },
    sourceDiagnostics: {
      compute: selectedRepositoryScanExecution.diagnostics,
      gitHistory: gitHistoryResult.diagnostics,
      runtimeState: externalRuntimeResult.diagnostics,
      sourceRelationEvidence: sourceRelationResult.diagnostics,
      ...(domainBundleCandidate ? { codeAnalysis: { reused: codeAnalysisReused, inputBasis: codeAnalysisInputBasis } } : {}),
    },
  };
}

export async function buildWorldModel(options = {}) {
  const persist = options.persist ?? true;
  if (!persist) return (await buildWorldModelLocked(options));
  const inspected = readyProject(options.root ?? ".");
  const storage = inspected.storage;
  return (await withRefreshWriterLease({ storage,
    projectRoot: inspected.project.projectRoot,
    projectId: inspected.project.projectId,
    lease: options.writerLease || null,
  }, async (writerLease) => (await buildWorldModelLocked({ ...options, writerLease }))));
}

export async function queryWorldModel({ root = ".", query, depth = 1, maxResults = 100, storeAdapter = null } = {}) {
  const inspected = (await inspectWorldDomainFreshness({ root, storeAdapter, domains: ["code"] }));
  if (inspected.freshness.domains.code.status !== "current") return {
    status: inspected.freshness.domains.code.status, worldModelId: inspected.snapshot.worldModelId,
    freshness: inspected.freshness, nodes: [], edges: [], fallback: "original-source",
    reasonCode: "WORLD_CODE_EVIDENCE_NOT_CURRENT", instructionAuthority: false,
  };
  if (!inspected.snapshot.semanticGraph) fail("Repository World Model has no semantic graph.", "SEMANTIC_GRAPH_NOT_BUILT");
  return {
    status: "current",
    freshness: inspected.freshness,
    worldModelId: inspected.snapshot.worldModelId,
    ...querySemanticGraph(inspected.snapshot.semanticGraph, { query, depth, maxResults }),
  };
}

export async function queryWorldTemporalGraph({
  root = ".",
  query = null,
  anchorIds = null,
  expectedGraphSnapshotId = null,
  kinds = null,
  relations = null,
  authorityClasses = ["canon-projected", "reviewed", "derived", "heuristic", "runtime-observed"],
  freshness = ["current"],
  minConfidence = 0,
  includeUnreviewedCandidates = false,
  depth = 1,
  maxNodes = 100,
  maxEdges = 200,
  storeAdapter = null,
  graphProjectionAdapter = null,
} = {}) {
  const inspected = (await inspectWorldDomainFreshness({ root, storeAdapter }));
  if (!inspected.snapshot.temporalProvenanceGraph) fail("Repository World Model has no temporal provenance graph.", "TEMPORAL_PROVENANCE_NOT_BUILT");
  const graph = inspected.snapshot.temporalProvenanceGraph;
  const eligibility = buildWorldTraversalEligibility(inspected.snapshot, inspected.freshness.domains);
  const needsMask = eligibility.nodeIds.length !== graph.nodes.length || eligibility.edgeIds.length !== graph.edges.length;
  const projected = (await queryGraphProjection({
    storage: inspected.storage,
    projectRoot: inspected.storage.projectRoot,
    graph: inspected.snapshot.temporalProvenanceGraph,
    adapter: graphProjectionAdapter,
    query: {
      query,
      anchorIds,
      expectedGraphSnapshotId,
      kinds,
      relations,
      authorityClasses,
      freshness,
      minConfidence,
      includeUnreviewedCandidates,
      depth,
      maxNodes,
      maxEdges,
      ...(needsMask ? { eligibility } : {}),
    },
  }));
  return {
    status: inspected.status === "current" ? "current" : "domain-scoped",
    freshness: inspected.freshness,
    worldModelId: inspected.snapshot.worldModelId,
    ...projected.result,
    graphProjection: projected.diagnostics,
  };
}

export async function inspectWorldGraphProjection({ root = ".", storeAdapter = null, graphProjectionAdapter = null } = {}) {
  const inspected = (await inspectWorldModel({ root, storeAdapter }));
  const projection = (await inspectGraphProjection({
    storage: inspected.storage,
    projectRoot: inspected.storage.projectRoot,
    graph: inspected.snapshot.temporalProvenanceGraph,
    adapter: graphProjectionAdapter,
  }));
  return {
    status: projection.status,
    worldModelStatus: inspected.status,
    worldModelId: inspected.snapshot.worldModelId,
    graphSnapshotId: inspected.snapshot.temporalProvenanceGraph.graphSnapshotId,
    projection,
    authority: "rebuildable-derived-projection-not-project-canon",
  };
}

export async function materializeWorldMarkdownProjection({ root = ".", storeAdapter = null, documentProjectionAdapter = null } = {}) {
  const inspected = (await inspectWorldModel({ root, storeAdapter }));
  if (inspected.status !== "current") fail("Repository World Model is stale and cannot regenerate document projections.", "WORLD_MODEL_STALE");
  const materialized = materializeMarkdownProjection({
    storage: inspected.storage,
    projectRoot: inspected.storage.projectRoot,
    graph: inspected.snapshot.temporalProvenanceGraph,
    adapter: documentProjectionAdapter,
  });
  return {
    status: materialized.status,
    worldModelStatus: inspected.status,
    worldModelId: inspected.snapshot.worldModelId,
    graphSnapshotId: inspected.snapshot.temporalProvenanceGraph.graphSnapshotId,
    documentProjectionId: materialized.projection.documentProjectionId,
    projection: materialized,
    authority: "rebuildable-derived-human-view-not-project-canon",
  };
}

export async function inspectWorldMarkdownProjection({ root = ".", storeAdapter = null, documentProjectionAdapter = null } = {}) {
  const inspected = (await inspectWorldModel({ root, storeAdapter }));
  const projection = inspectMarkdownProjection({
    storage: inspected.storage,
    projectRoot: inspected.storage.projectRoot,
    graph: inspected.snapshot.temporalProvenanceGraph,
    adapter: documentProjectionAdapter,
  });
  const documentOnlyDriftKeys = new Set(["documentChangeProjectionChanged", "temporalProvenanceChanged"]);
  const hasNonDocumentDrift = Object.entries(inspected.changes || {}).some(([key, value]) => !documentOnlyDriftKeys.has(key)
    && (Array.isArray(value) ? value.length > 0 : value === true));
  const status = inspected.status !== "current" && hasNonDocumentDrift && projection.status === "current" ? "source-stale" : projection.status;
  return {
    status,
    worldModelStatus: inspected.status,
    worldModelId: inspected.snapshot.worldModelId,
    graphSnapshotId: inspected.snapshot.temporalProvenanceGraph.graphSnapshotId,
    projection,
    authority: "rebuildable-derived-human-view-not-project-canon",
  };
}

export async function captureWorldMarkdownChanges({ root = ".", storeAdapter = null, documentProjectionAdapter = null, persist = true } = {}) {
  const inspected = (await inspectWorldModel({ root, storeAdapter }));
  const documentOnlyDriftKeys = new Set(["documentChangeProjectionChanged", "temporalProvenanceChanged"]);
  const nonDocumentDrift = Object.entries(inspected.changes || {}).some(([key, value]) => !documentOnlyDriftKeys.has(key)
    && (Array.isArray(value) ? value.length > 0 : value === true));
  if (inspected.status !== "current" && (!inspected.changes?.documentChangeProjectionChanged || nonDocumentDrift)) {
    fail("Repository World Model has non-document drift and cannot anchor document change candidates.", "WORLD_MODEL_STALE");
  }
  const captured = captureDocumentChangeCandidates({
    storage: inspected.storage,
    projectRoot: inspected.storage.projectRoot,
    graph: inspected.snapshot.temporalProvenanceGraph,
    adapter: documentProjectionAdapter,
    persist,
  });
  return {
    status: captured.status,
    worldModelId: inspected.snapshot.worldModelId,
    graphSnapshotId: inspected.snapshot.temporalProvenanceGraph.graphSnapshotId,
    ...captured,
    authority: "unreviewed-document-change-candidates-not-project-canon",
  };
}

export function readWorldDocumentChangeCandidateSet({ root = ".", candidateSetId: id } = {}) {
  const inspected = readyProject(root);
  const storage = inspected.storage;
  return readDocumentChangeCandidateSet({ storage, projectRoot: inspected.project.projectRoot, id });
}

export async function queryWorldHistory({ root = ".", query = "", limit = 50, storeAdapter = null } = {}) {
  const inspected = (await inspectWorldDomainFreshness({ root, storeAdapter, domains: ["git"] }));
  if (inspected.freshness.domains.git.status !== "current") fail("Captured Git evidence is not current; unrelated code/runtime domains are not a gate.", "WORLD_MODEL_STALE");
  if (!inspected.snapshot.gitDecisionHistory) fail("Repository World Model has no Git decision history.", "GIT_DECISION_HISTORY_NOT_BUILT");
  return {
    status: "current",
    freshness: inspected.freshness,
    worldModelId: inspected.snapshot.worldModelId,
    ...queryGitDecisionHistory(inspected.snapshot.gitDecisionHistory, { query, limit }),
  };
}

export async function queryWorldRuntimeState({ root = ".", query = "", runtime = "", state = "", kind = "", limit = 50, storeAdapter = null, runtimeStateAdapter = null } = {}) {
  const inspected = (await inspectWorldDomainFreshness({ root, storeAdapter, runtimeStateAdapter, domains: ["runtime"] }));
  if (inspected.freshness.domains.runtime.status !== "current") fail("Captured runtime evidence is not current; unrelated code/Product domains are not a gate.", "WORLD_MODEL_STALE");
  if (!inspected.snapshot.externalRuntimeState) fail("Repository World Model has no external runtime state.", "EXTERNAL_RUNTIME_STATE_NOT_BUILT");
  return {
    status: "current",
    freshness: inspected.freshness,
    worldModelId: inspected.snapshot.worldModelId,
    ...queryExternalRuntimeState(inspected.snapshot.externalRuntimeState, { query, runtime, state, kind, limit }),
  };
}

// Shared pure original verification for bounded maintenance readers.
export function verifyWorldModelPointerOriginal(pointer, projectId) {
  if (pointer.schemaVersion !== SCHEMA_VERSION || pointer.kind !== "WorldModelPointer"
    || pointer.projectId !== projectId || !/^world-model-[a-f0-9]{24}$/.test(pointer.worldModelId || "")
    || (pointer.previousWorldModelId != null && !/^world-model-[a-f0-9]{24}$/.test(pointer.previousWorldModelId || ""))
    || (pointer.previousWorldModelId && pointer.previousWorldModelId === pointer.worldModelId)) {
    fail("World Model pointer does not match this project.", "WORLD_MODEL_IDENTITY_MISMATCH");
  }
  if (!/^[a-f0-9]{64}$/.test(pointer.worldModelHash || "") || pointer.worldModelId !== `world-model-${pointer.worldModelHash.slice(0, 24)}`) {
    fail("World Model pointer hash does not match its identity.", "WORLD_MODEL_POINTER_MISMATCH");
  }
  return pointer;
}
export function verifyWorldModelSnapshotOriginal({ document, worldModelId, storage }) {
  const snapshot = verifiedSnapshot(document, worldModelId, storage);
  if (snapshot.projectId !== storage.projectId || !projectOwnsRecordedRoot(storage, snapshot.projectRoot)) fail("World snapshot belongs to another Project/root.", "WORLD_MODEL_IDENTITY_MISMATCH");
  return snapshot;
}

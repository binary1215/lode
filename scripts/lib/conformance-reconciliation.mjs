import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { inspectProject, SCHEMA_VERSION } from "./lode-core.mjs";
import { formatForVerifiedOwner, relativeProjectArtifact } from "./project-storage-format.mjs";
import { publicToolName } from "./lode-artifact-composition.mjs";
import { artifactAuthorityBoundary } from "./authority-plane-contract.mjs";
import { readProductModelCanon } from "./product-model.mjs";
import { inspectWorldModel } from "./world-model.mjs";
import { readChangeSet } from "./change-set.mjs";
import { readObservation } from "./observation-store.mjs";
import { withProjectMutation, withProjectMutationAsync } from "./project-mutation-lock.mjs";
import {
  CONFORMANCE_PROTOCOL_VERSION,
  HEAD_CONFORMANCE_MAINTENANCE_AUTHORITY,
  USER_CONFORMANCE_DISPOSITION_AUTHORITY,
  conformanceCanonicalJson,
  conformanceDigest,
  createConformanceDispositionReceipt,
  createConformanceFindingCandidate,
  createConformanceResolutionCandidate,
  normalizeConformanceEvidenceAnchor,
  normalizeCanonAnchor,
  verifyConformanceDispositionReceipt,
  verifyConformanceFindingCandidate,
  verifyConformanceResolutionCandidate,
} from "./conformance-contract.mjs";

const directories = (storage) => ({
  findings: relativeProjectArtifact(storage, "conformance", "findings"),
  dispositions: relativeProjectArtifact(storage, "conformance", "dispositions"),
  resolutions: relativeProjectArtifact(storage, "conformance", "resolutions"),
});
const MAX_PAGE = 64;
const MAX_SOURCE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_EXCERPT_BYTES = 512 * 1024;
const fail = (message, code = "CONFORMANCE_RECONCILIATION_ERROR") => { const error = new Error(message); error.code = code; throw error; };
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function readyProject(root, action) {
  const inspected = inspectProject(root);
  if (inspected.status !== "ready") fail(`Project must be ready for ${action}; current status: ${inspected.status}.`, "PROJECT_NOT_READY");
  return inspected;
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function persistImmutable(projectRoot, relativeDirectory, id, document, label) {
  const file = path.join(projectRoot, ...relativeDirectory.split("/"), `${id}.json`);
  if (fs.existsSync(file)) {
    let existing;
    try { existing = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) { fail(`${label} is invalid JSON: ${error.message}`, "INVALID_CONFORMANCE_ARTIFACT"); }
    if (conformanceCanonicalJson(existing) !== conformanceCanonicalJson(document)) fail(`${label} immutable identity collision.`, "CONFORMANCE_IMMUTABLE_COLLISION");
    return { status: "existing", file };
  }
  atomicWrite(file, json(document));
  return { status: "recorded", file };
}

function readDirectory(projectRoot, relativeDirectory, label) {
  const directory = path.join(projectRoot, ...relativeDirectory.split("/"));
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((a, b) => a.name.localeCompare(b.name)).map((entry) => {
      try { return JSON.parse(fs.readFileSync(path.join(directory, entry.name), "utf8")); }
      catch (error) { fail(`${label} is invalid JSON: ${entry.name}: ${error.message}`, "INVALID_CONFORMANCE_ARTIFACT"); }
    });
}

function productEntities(model) {
  const groups = [
    ["FeatureGroup", model.featureGroups], ["Capability", model.capabilities], ["Feature", model.features], ["Policy", model.policies || []],
    ["Requirement", model.requirements], ["Constraint", model.constraints], ["Decision", model.decisions],
  ];
  return groups.flatMap(([kind, values]) => values.map((value) => ({ kind, key: value.key, text: value.name || value.statement, status: value.status || "active" })))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
}

function findProductEntity(model, anchor) {
  const map = { FeatureGroup: model.featureGroups, Capability: model.capabilities, Feature: model.features, Requirement: model.requirements, Constraint: model.constraints, Decision: model.decisions, Policy: model.policies || [] };
  return map[anchor.entityKind]?.find((item) => item.key === anchor.entityKey) || null;
}

async function worldState(projectRoot) {
  try {
    const inspection = (await inspectWorldModel({ root: projectRoot }));
    const snapshot = inspection.snapshot;
    return {
      status: inspection.status,
      snapshot,
      baseline: inspection.status === "current" ? {
        worldModelId: snapshot.worldModelId,
        worldModelHash: snapshot.worldModelHash,
        sourceSnapshotId: snapshot.temporalProvenanceGraph.sourceSnapshotId,
        graphSnapshotId: snapshot.temporalProvenanceGraph.graphSnapshotId,
      } : null,
    };
  } catch (error) {
    if (new Set(["WORLD_MODEL_NOT_BUILT", "WORLD_MODEL_SNAPSHOT_MISSING"]).has(error.code)) return { status: "unavailable", snapshot: null, baseline: null };
    throw error;
  }
}

async function currentBaseline(projectRoot, storage) {
  const canon = readProductModelCanon({ projectRoot, storage });
  const world = (await worldState(projectRoot));
  return {
    canon,
    world,
    baseline: {
      productModelId: canon.model.productModelId,
      productModelHash: canon.model.productModelHash,
      worldModelId: world.baseline?.worldModelId || null,
      worldModelHash: world.baseline?.worldModelHash || null,
      sourceSnapshotId: world.baseline?.sourceSnapshotId || null,
      graphSnapshotId: world.baseline?.graphSnapshotId || null,
    },
  };
}

function normalizedRelativePath(projectRoot, value) {
  if (typeof value !== "string" || !value.trim() || path.isAbsolute(value)) fail("Conformance source path must be project-relative.", "CONFORMANCE_SOURCE_PATH_INVALID");
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.split("/").some((part) => !part || part === "." || part === "..")) fail("Conformance source path escapes or ambiguously addresses the project.", "CONFORMANCE_SOURCE_PATH_INVALID");
  const target = path.resolve(projectRoot, ...normalized.split("/"));
  const relative = path.relative(projectRoot, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail("Conformance source path escapes the project.", "CONFORMANCE_SOURCE_PATH_INVALID");
  let current = projectRoot;
  for (const part of normalized.split("/")) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail("Conformance source path traverses a symbolic link.", "CONFORMANCE_SOURCE_PATH_INVALID");
  }
  return { normalized, target };
}

function inspectSourceAnchor(projectRoot, anchor) {
  const { normalized, target } = normalizedRelativePath(projectRoot, anchor.path);
  if (!fs.existsSync(target)) fail(`Conformance source is missing: ${normalized}`, "CONFORMANCE_SOURCE_DRIFT");
  const stat = fs.statSync(target);
  if (!stat.isFile()) fail("Conformance source must be a regular file.", "CONFORMANCE_SOURCE_UNSAFE");
  if (stat.size > MAX_SOURCE_FILE_BYTES) fail("Direct Conformance source hashing is bounded to 64 MiB; use an exact current World or ChangeSet anchor for larger files. Ordinary work remains available.", "CONFORMANCE_SOURCE_TOO_LARGE");
  const hash = crypto.createHash("sha256");
  const selected = [];
  let selectedBytes = 0;
  let line = 1;
  let currentLine = [];
  const fd = fs.openSync(target, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!read) break;
      const chunk = buffer.subarray(0, read);
      hash.update(chunk);
      if (anchor.startLine !== null) for (const byte of chunk) {
        if (byte === 0x0a) {
          if (line >= anchor.startLine && line <= anchor.endLine) {
            if (currentLine.at(-1) === 0x0d) currentLine.pop();
            selectedBytes += currentLine.length + (selected.length ? 1 : 0);
            if (selectedBytes > MAX_EXCERPT_BYTES) fail("Conformance source excerpt exceeds its safety bound.", "CONFORMANCE_SOURCE_UNSAFE");
            selected.push(Buffer.from(currentLine));
          }
          currentLine = [];
          line += 1;
        } else if (line >= anchor.startLine && line <= anchor.endLine) currentLine.push(byte);
      }
    }
    if (anchor.startLine !== null && line >= anchor.startLine && line <= anchor.endLine) {
      if (currentLine.at(-1) === 0x0d) currentLine.pop();
      selectedBytes += currentLine.length + (selected.length ? 1 : 0);
      if (selectedBytes > MAX_EXCERPT_BYTES) fail("Conformance source excerpt exceeds its safety bound.", "CONFORMANCE_SOURCE_UNSAFE");
      selected.push(Buffer.from(currentLine));
    }
  } finally { fs.closeSync(fd); }
  if (hash.digest("hex") !== anchor.fileDigest) fail(`Conformance source digest changed: ${normalized}`, "CONFORMANCE_SOURCE_DRIFT");
  if (anchor.startLine !== null) {
    if (anchor.endLine > line || !selected.length) fail("Conformance source line range is outside the current file.", "CONFORMANCE_SOURCE_DRIFT");
    const excerptDigest = conformanceDigest(Buffer.concat(selected.flatMap((item, index) => index ? [Buffer.from("\n"), item] : [item])));
    if (excerptDigest !== anchor.excerptDigest) fail(`Conformance source excerpt changed: ${normalized}`, "CONFORMANCE_SOURCE_DRIFT");
  }
  return normalized;
}

function verifyEvidenceAnchors({ projectRoot, projectId, baseline, world, anchors }) {
  const normalizedAnchors = anchors.map(normalizeConformanceEvidenceAnchor);
  const disclosures = new Set();
  if (!normalizedAnchors.some((anchor) => anchor.kind === "graph")) disclosures.add(world.status === "current" ? "graph-not-used" : "graph-unavailable");
  for (const anchor of normalizedAnchors) {
    if (anchor.kind === "source") {
      const normalized = inspectSourceAnchor(projectRoot, anchor);
      disclosures.add("direct-source-anchor-used");
      if (anchor.revisionId || anchor.symbolId) {
        if (!world.baseline || conformanceCanonicalJson(baseline) !== conformanceCanonicalJson({ productModelId: baseline.productModelId, productModelHash: baseline.productModelHash, ...world.baseline })) fail("World-backed source identities require the exact current World baseline.", "CONFORMANCE_BASELINE_DRIFT");
        const nodes = new Map(world.snapshot.temporalProvenanceGraph.nodes.map((node) => [node.nodeId, node]));
        const revision = anchor.revisionId ? nodes.get(anchor.revisionId) : null;
        const symbol = anchor.symbolId ? nodes.get(anchor.symbolId) : null;
        if (anchor.revisionId && (!revision || revision.kind !== "FileRevision" || revision.path !== normalized)) fail(`Conformance FileRevision does not identify the anchored source: ${anchor.revisionId}`, "CONFORMANCE_EVIDENCE_NOT_FOUND");
        if (anchor.symbolId && (!symbol || !new Set(["Symbol", "SymbolRevision"]).has(symbol.kind) || symbol.path !== normalized)) fail(`Conformance Symbol identity does not identify the anchored source: ${anchor.symbolId}`, "CONFORMANCE_EVIDENCE_NOT_FOUND");
      }
    } else if (anchor.kind === "change") {
      const changeSet = readChangeSet({ root: projectRoot, changeSetId: anchor.changeSetId }).changeSet;
      if (changeSet.projectId !== projectId || changeSet.changeSetHash !== anchor.changeSetHash || !changeSet.changes.some((change) => change.changeId === anchor.changeId)) fail("Conformance ChangeSet anchor is stale or invalid.", "CONFORMANCE_EVIDENCE_NOT_FOUND");
    } else if (anchor.kind === "observation") {
      const selected = readObservation({ root: projectRoot, observationId: anchor.observationId }).observation;
      const selectedHash = selected.observationHash || selected.derivedObservationHash;
      if (selectedHash !== anchor.observationHash) fail("Conformance Observation anchor is stale or invalid.", "CONFORMANCE_EVIDENCE_NOT_FOUND");
      if (selected.coverage.state !== "complete") disclosures.add("observation-coverage-partial");
      if (selected.coverage.state === "unknown") disclosures.add("evidence-coverage-unknown");
    } else if (anchor.kind === "graph") {
      if (!world.baseline || baseline.graphSnapshotId !== world.baseline.graphSnapshotId || anchor.graphSnapshotId !== world.baseline.graphSnapshotId) fail("Conformance Graph anchor is stale or unavailable.", "CONFORMANCE_BASELINE_DRIFT");
      if (!world.snapshot.temporalProvenanceGraph.nodes.some((node) => node.nodeId === anchor.nodeId)) fail("Conformance Graph node is missing.", "CONFORMANCE_EVIDENCE_NOT_FOUND");
    }
  }
  return [...disclosures].sort();
}

function readArtifacts(projectRoot, projectId, storage) {
  const DIRECTORIES = directories(storage);
  const findings = readDirectory(projectRoot, DIRECTORIES.findings, "Conformance Finding").map((item) => verifyConformanceFindingCandidate(item, projectId, storage)).sort((a, b) => a.findingId.localeCompare(b.findingId));
  const findingMap = new Map(findings.map((item) => [item.findingId, item]));
  const dispositions = readDirectory(projectRoot, DIRECTORIES.dispositions, "Conformance disposition").map((item) => {
    const finding = findingMap.get(item.findingId);
    if (!finding) fail("Conformance disposition references a missing Finding.", "CONFORMANCE_FINDING_NOT_FOUND");
    return verifyConformanceDispositionReceipt(item, finding, projectId, storage);
  }).sort((a, b) => a.dispositionId.localeCompare(b.dispositionId));
  const resolutions = readDirectory(projectRoot, DIRECTORIES.resolutions, "Conformance resolution").map((item) => {
    const finding = findingMap.get(item.findingId);
    if (!finding) fail("Conformance resolution references a missing Finding.", "CONFORMANCE_FINDING_NOT_FOUND");
    return verifyConformanceResolutionCandidate(item, finding, projectId, storage);
  }).sort((a, b) => a.resolutionId.localeCompare(b.resolutionId));
  const resolutionMap = new Map(resolutions.map((item) => [item.resolutionId, item]));
  const dispositionMap = new Map(dispositions.map((item) => [item.dispositionId, item]));
  const byFinding = new Map(findings.map((item) => [item.findingId, []]));
  for (const disposition of dispositions) {
    if (disposition.previousDispositionId) {
      const previous = dispositionMap.get(disposition.previousDispositionId);
      if (!previous || previous.dispositionHash !== disposition.previousDispositionHash || previous.findingId !== disposition.findingId) fail("Conformance disposition chain is invalid.", "INVALID_CONFORMANCE_DISPOSITION_CHAIN");
      if (disposition.authority === formatForVerifiedOwner(storage).value(HEAD_CONFORMANCE_MAINTENANCE_AUTHORITY) && previous.authority !== formatForVerifiedOwner(storage).value(HEAD_CONFORMANCE_MAINTENANCE_AUTHORITY)) fail("HEAD maintenance cannot supersede a user disposition.", "INVALID_CONFORMANCE_DISPOSITION_CHAIN");
    }
    if (disposition.resolutionId) {
      const resolution = resolutionMap.get(disposition.resolutionId);
      if (!resolution || resolution.resolutionHash !== disposition.resolutionHash || resolution.findingId !== disposition.findingId || resolution.assessment !== "appears-resolved") fail("Accepted Conformance resolution is invalid.", "INVALID_CONFORMANCE_RESOLUTION_LINEAGE");
    }
    byFinding.get(disposition.findingId).push(disposition);
  }
  const tails = new Map();
  for (const finding of findings) {
    const values = byFinding.get(finding.findingId);
    if (!values.length) { tails.set(finding.findingId, null); continue; }
    const referenced = new Set(values.map((item) => item.previousDispositionId).filter(Boolean));
    const roots = values.filter((item) => item.previousDispositionId === null);
    const tail = values.filter((item) => !referenced.has(item.dispositionId));
    if (roots.length !== 1 || tail.length !== 1 || new Set(values.map((item) => item.previousDispositionId || "root")).size !== values.length) fail("Conformance disposition chain branches or is incomplete.", "INVALID_CONFORMANCE_DISPOSITION_CHAIN");
    tails.set(finding.findingId, tail[0]);
  }
  return { findings, findingsById: findingMap, dispositions, resolutions, tails };
}

function findingCurrency(projectRoot, current, finding) {
  if (finding.baseline.productModelId !== current.baseline.productModelId || finding.baseline.productModelHash !== current.baseline.productModelHash) return { state: "needs-recheck", reasonCode: "product-model-changed" };
  if (finding.baseline.worldModelId && (!current.world.baseline || finding.baseline.worldModelId !== current.baseline.worldModelId || finding.baseline.worldModelHash !== current.baseline.worldModelHash || finding.baseline.sourceSnapshotId !== current.baseline.sourceSnapshotId || finding.baseline.graphSnapshotId !== current.baseline.graphSnapshotId)) return { state: "needs-recheck", reasonCode: "world-baseline-changed" };
  try {
    verifyEvidenceAnchors({ projectRoot, projectId: finding.projectId, baseline: finding.baseline, world: current.world, anchors: finding.evidenceAnchors });
    return { state: "current", reasonCode: null };
  } catch (error) {
    if (error.code === "CONFORMANCE_SOURCE_TOO_LARGE") return { state: "needs-recheck", reasonCode: "direct-source-anchor-exceeds-current-bound" };
    if (new Set(["CONFORMANCE_SOURCE_DRIFT", "CONFORMANCE_EVIDENCE_NOT_FOUND", "CONFORMANCE_BASELINE_DRIFT"]).has(error.code)) return { state: "needs-recheck", reasonCode: error.code.toLowerCase() };
    throw error;
  }
}

function queueStatus({ tail, resolutions, currency }) {
  if (tail?.disposition === "dismiss") return "closed-dismissed";
  if (tail?.disposition === "accept-resolution") return "closed-resolved";
  if (currency.state === "needs-recheck") return "needs-recheck";
  if (tail?.disposition === "defer") return "deferred";
  if (tail?.disposition === "acknowledge") return "acknowledged";
  if (tail && new Set(["request-code-fix", "request-canon-revision"]).has(tail.disposition)) return "action-requested";
  if (resolutions.some((item) => item.assessment === "appears-resolved")) return "resolution-proposed";
  return "open";
}

function findingGraphProjection(finding, dispositions, resolutions) {
  const canonNodeId = `conformance-canon-ref-${conformanceDigest(conformanceCanonicalJson({ productModelId: finding.baseline.productModelId, ...finding.canonAnchor })).slice(0, 24)}`;
  const evidenceNodes = finding.evidenceAnchors.map((anchor) => {
    const hash = conformanceDigest(conformanceCanonicalJson(anchor));
    return { nodeId: `conformance-evidence-ref-${hash.slice(0, 24)}`, kind: "ConformanceEvidenceReference", anchorKind: anchor.kind, anchor, semanticAuthority: false };
  });
  const nodes = [
    { nodeId: finding.findingId, kind: "ConformanceFindingCandidate", findingHash: finding.findingHash, claimKind: finding.claim.kind, riskHint: finding.claim.riskHint, candidateSpace: true, contextEligibility: "excluded-unless-exactly-requested", semanticAuthority: false },
    { nodeId: canonNodeId, kind: "ProductCanonEntityReference", productModelId: finding.baseline.productModelId, ...finding.canonAnchor, semanticAuthority: false },
    ...evidenceNodes,
    ...dispositions.map((item) => ({ nodeId: item.dispositionId, kind: "ConformanceDispositionReceipt", dispositionHash: item.dispositionHash, disposition: item.disposition, semanticAuthority: false })),
    ...resolutions.map((item) => ({ nodeId: item.resolutionId, kind: "ConformanceResolutionCandidate", resolutionHash: item.resolutionHash, assessment: item.assessment, candidateSpace: true, semanticAuthority: false })),
  ].sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  const relation = (type, from, to, evidenceIds) => {
    const payload = { type, from, to, evidenceIds: [...evidenceIds].sort(), authority: "derived-candidate-audit-relation", instructionAuthority: false, promotionAuthority: false };
    const edgeHash = conformanceDigest(conformanceCanonicalJson(payload));
    return { edgeId: `conformance-edge-${edgeHash.slice(0, 24)}`, ...payload, edgeHash };
  };
  const edges = [
    relation("CHECKS_AGAINST", finding.findingId, canonNodeId, [finding.findingId]),
    ...evidenceNodes.map((node) => relation("EVIDENCED_BY", finding.findingId, node.nodeId, [finding.findingId])),
    ...dispositions.map((item) => relation("DISPOSITIONED_BY", finding.findingId, item.dispositionId, [finding.findingId, item.dispositionId])),
    ...resolutions.map((item) => relation("REASSESSED_BY", finding.findingId, item.resolutionId, [finding.findingId, item.resolutionId])),
  ].sort((a, b) => a.edgeId.localeCompare(b.edgeId));
  const payload = { schemaVersion: SCHEMA_VERSION, kind: "ConformanceFindingGraphProjection", projectId: finding.projectId, findingId: finding.findingId, nodes, edges, graphPolicy: { candidateSpaceHiddenByDefault: true, automaticVerdictRelations: false, allowedRelations: ["CHECKS_AGAINST", "EVIDENCED_BY", "DISPOSITIONED_BY", "REASSESSED_BY"] }, authority: "rebuildable-conformance-audit-view", authorityBoundary: artifactAuthorityBoundary("ConformanceFindingGraphProjection"), instructionAuthority: false, promotionAuthority: false, recoveryAuthority: false };
  const projectionHash = conformanceDigest(conformanceCanonicalJson(payload));
  return { ...payload, projectionId: `conformance-finding-graph-${projectionHash.slice(0, 24)}`, projectionHash };
}

export async function prepareConformanceAssessment({ root = ".", limit = 32, projectionId = "", cursor = "" } = {}) {
  const inspected = readyProject(root, "Conformance preparation");
  const current = (await currentBaseline(inspected.project.projectRoot, inspected.storage));
  const entities = productEntities(current.canon.model);
  const boundedLimit = Number(limit);
  if (!Number.isInteger(boundedLimit) || boundedLimit < 1 || boundedLimit > MAX_PAGE) fail(`Conformance preparation limit must be between 1 and ${MAX_PAGE}.`, "INVALID_CONFORMANCE_PAGE_LIMIT");
  const identityPayload = { projectId: inspected.project.projectId, sessionId: inspected.state.sessionId, baseline: current.baseline, entityKeys: entities.map((item) => `${item.kind}:${item.key}`) };
  const currentProjectionId = `conformance-preparation-${conformanceDigest(conformanceCanonicalJson(identityPayload)).slice(0, 24)}`;
  let start = 0;
  let resynchronized = false;
  if (projectionId || cursor) {
    if (!projectionId || !cursor) fail("Conformance preparation cursor and projectionId must be supplied together.", "INVALID_CONFORMANCE_CURSOR");
    const index = entities.findIndex((item) => `${item.kind}:${item.key}` === cursor);
    if (projectionId !== currentProjectionId || index < 0) resynchronized = true;
    else start = index + 1;
  }
  const page = entities.slice(start, start + boundedLimit);
  const remaining = Math.max(0, entities.length - start - page.length);
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: "ConformancePreparationProjection",
    protocol: { name: formatForVerifiedOwner(inspected.storage).protocol("head-agent-core-conformance-reconciliation"), version: CONFORMANCE_PROTOCOL_VERSION },
    projectId: inspected.project.projectId,
    sessionId: inspected.state.sessionId,
    projectionId: currentProjectionId,
    baseline: current.baseline,
    productCanon: { status: current.canon.status, entityCount: entities.length, entities: page, omitted: remaining },
    world: { status: current.world.status, exactGraphAnchorsAvailable: current.world.status === "current" },
    nextCursor: remaining ? { projectionId: currentProjectionId, cursor: `${page.at(-1).kind}:${page.at(-1).key}` } : null,
    resynchronization: { occurred: resynchronized, reason: resynchronized ? "stale-or-missing-read-only-cursor" : null, restartedAtFirstPage: resynchronized },
    workflow: { semanticAssessmentOwner: formatForVerifiedOwner(inspected.storage).value("provider-head"), coreRole: "exact-anchor-validation-only", userStructuredInputRequired: false, ordinaryWorkBlocked: false, graphRequired: false },
    authority: "non-persisted-conformance-preparation-view",
    authorityBoundary: artifactAuthorityBoundary("ConformancePreparationProjection"),
    instructionAuthority: false,
    promotionAuthority: false,
    recoveryAuthority: false,
  };
}

function assertCurrentBaseline(expected, current) {
  if (conformanceCanonicalJson(expected) !== conformanceCanonicalJson(current.baseline)) fail(`Conformance baseline changed; rerun ${publicToolName("head_conformance_prepare")} and retry the read-only semantic assessment. Ordinary work remains available.`, "CONFORMANCE_BASELINE_DRIFT");
}

export async function proposeConformanceFindings({ root = ".", baseline, findings } = {}) {
  const inspected = readyProject(root, "Conformance proposal");
  if (!Array.isArray(findings) || findings.length < 1 || findings.length > 64) fail("Conformance proposal requires one through 64 candidates.", "INVALID_CONFORMANCE_FINDING_COUNT");
  const current = (await currentBaseline(inspected.project.projectRoot, inspected.storage));
  assertCurrentBaseline(baseline, current);
  if (!productEntities(current.canon.model).length) fail("Conformance assessment requires an existing Product Canon, but ordinary HEAD work remains available.", "CONFORMANCE_PRODUCT_CANON_UNAVAILABLE");
  const existingArtifacts = readArtifacts(inspected.project.projectRoot, inspected.project.projectId, inspected.storage);
  const existingByFingerprint = new Map(existingArtifacts.findings.map((item) => [item.fingerprintId, item]));
  const candidates = findings.map((input) => {
    const entity = findProductEntity(current.canon.model, input.canonAnchor);
    if (!entity) fail("Conformance proposal references an unknown current Product Canon entity.", "CONFORMANCE_CANON_ANCHOR_NOT_FOUND");
    const computedDisclosures = verifyEvidenceAnchors({ projectRoot: inspected.project.projectRoot, projectId: inspected.project.projectId, baseline, world: current.world, anchors: input.evidenceAnchors });
    return createConformanceFindingCandidate({ projectId: inspected.project.projectId, sessionId: inspected.state.sessionId, baseline, canonAnchor: input.canonAnchor, evidenceAnchors: input.evidenceAnchors, claim: input.claim, disclosures: computedDisclosures }, inspected.storage);
  });
  const uniqueByFingerprint = new Map();
  for (const item of candidates) {
    if (!uniqueByFingerprint.has(item.fingerprintId)) uniqueByFingerprint.set(item.fingerprintId, existingByFingerprint.get(item.fingerprintId) || item);
  }
  const unique = [...uniqueByFingerprint.values()];
  const persisted = unique.map((finding) => ({ finding, ...persistImmutable(inspected.project.projectRoot, directories(inspected.storage).findings, finding.findingId, finding, "Conformance Finding") }));
  return {
    status: persisted.every((item) => item.status === "existing") ? "existing" : "recorded",
    outcome: unique.some((item) => item.disclosures.length) ? "accepted-with-disclosure" : "accepted",
    findings: persisted.map(({ finding, status }) => ({ findingId: finding.findingId, findingHash: finding.findingHash, status, disclosures: finding.disclosures })),
    convergedInBatchDuplicateCount: candidates.length - unique.length,
    ordinaryWorkBlocked: false,
    authority: { findings: "P3-candidate-evidence", productCanonMutated: false, reviewDecisionCreated: false, recoveryDirectionMutated: false },
  };
}

export function readConformanceFinding({ root = ".", findingId } = {}) {
  const inspected = readyProject(root, "Conformance Finding inspection");
  const artifacts = readArtifacts(inspected.project.projectRoot, inspected.project.projectId, inspected.storage);
  const finding = artifacts.findingsById.get(findingId);
  if (!finding) fail(`Conformance Finding not found: ${findingId}`, "CONFORMANCE_FINDING_NOT_FOUND");
  const dispositions = artifacts.dispositions.filter((item) => item.findingId === findingId);
  const resolutions = artifacts.resolutions.filter((item) => item.findingId === findingId);
  const tail = artifacts.tails.get(findingId);
  return { status: "verified", finding, dispositions, resolutions, latestDisposition: tail ? { ...tail, actor: tail.authority === formatForVerifiedOwner(inspected.storage).value(HEAD_CONFORMANCE_MAINTENANCE_AUTHORITY) ? formatForVerifiedOwner(inspected.storage).roleField : "user" } : null, graphProjection: findingGraphProjection(finding, dispositions, resolutions) };
}

export async function inspectConformanceQueue({ root = ".", status = "all", riskHint = "", limit = 25, projectionId = "", cursor = "", canonAnchor = null } = {}) {
  const inspected = readyProject(root, "Conformance queue inspection");
  const selectedCanon = canonAnchor === null ? null : normalizeCanonAnchor(canonAnchor);
  if (!new Set(["all", "open", "acknowledged", "deferred", "action-requested", "needs-recheck", "resolution-proposed", "closed-dismissed", "closed-resolved"]).has(status)) fail("Conformance queue status filter is invalid.", "INVALID_CONFORMANCE_QUEUE_FILTER");
  if (riskHint && !new Set(["unknown", "low", "medium", "high"]).has(riskHint)) fail("Conformance queue risk filter is invalid.", "INVALID_CONFORMANCE_QUEUE_FILTER");
  const boundedLimit = Number(limit);
  if (!Number.isInteger(boundedLimit) || boundedLimit < 1 || boundedLimit > MAX_PAGE) fail(`Conformance queue limit must be between 1 and ${MAX_PAGE}.`, "INVALID_CONFORMANCE_PAGE_LIMIT");
  const artifacts = readArtifacts(inspected.project.projectRoot, inspected.project.projectId, inspected.storage);
  const current = (await currentBaseline(inspected.project.projectRoot, inspected.storage));
  const selectedFindings = artifacts.findings.filter((finding) => !selectedCanon || (finding.canonAnchor.entityKind === selectedCanon.entityKind && finding.canonAnchor.entityKey === selectedCanon.entityKey));
  const rows = selectedFindings.map((finding) => {
    const tail = artifacts.tails.get(finding.findingId);
    const resolutions = artifacts.resolutions.filter((item) => item.findingId === finding.findingId);
    const currency = findingCurrency(inspected.project.projectRoot, current, finding);
    return { findingId: finding.findingId, findingHash: finding.findingHash, canonAnchor: finding.canonAnchor, claim: { kind: finding.claim.kind, summary: finding.claim.summary, riskHint: finding.claim.riskHint }, disclosures: finding.disclosures, status: queueStatus({ tail, resolutions, currency }), currency, latestDisposition: tail ? { dispositionId: tail.dispositionId, disposition: tail.disposition, deferUntil: tail.deferUntil, authority: tail.authority, actor: tail.authority === formatForVerifiedOwner(inspected.storage).value(HEAD_CONFORMANCE_MAINTENANCE_AUTHORITY) ? formatForVerifiedOwner(inspected.storage).roleField : "user" } : null, resolutionCandidateCount: resolutions.length, authority: "P4-derived-queue-row" };
  }).filter((row) => (status === "all" || row.status === status) && (!riskHint || row.claim.riskHint === riskHint)).sort((a, b) => a.findingId.localeCompare(b.findingId));
  const projectionPayload = { projectId: inspected.project.projectId, sessionId: inspected.state.sessionId, baseline: current.baseline, ...(selectedCanon ? { canonAnchor: selectedCanon } : {}), findingStates: rows.map((row) => [row.findingId, row.status, row.currency.state, row.latestDisposition?.dispositionId || null, row.resolutionCandidateCount]) };
  const currentProjectionId = `conformance-queue-${conformanceDigest(conformanceCanonicalJson(projectionPayload)).slice(0, 24)}`;
  let start = 0;
  let resynchronized = false;
  if (projectionId || cursor) {
    if (!projectionId || !cursor) fail("Conformance queue cursor and projectionId must be supplied together.", "INVALID_CONFORMANCE_CURSOR");
    const index = rows.findIndex((item) => item.findingId === cursor);
    if (projectionId !== currentProjectionId || index < 0) resynchronized = true;
    else start = index + 1;
  }
  const page = rows.slice(start, start + boundedLimit);
  const remaining = Math.max(0, rows.length - start - page.length);
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: "ConformanceQueueProjection",
    protocol: { name: formatForVerifiedOwner(inspected.storage).protocol("head-agent-core-conformance-reconciliation"), version: CONFORMANCE_PROTOCOL_VERSION },
    projectId: inspected.project.projectId,
    sessionId: inspected.state.sessionId,
    projectionId: currentProjectionId,
    filters: { status, riskHint, ...(selectedCanon ? { canonAnchor: selectedCanon } : {}) },
    totalMatches: rows.length,
    findings: page,
    omitted: remaining,
    nextCursor: remaining ? { projectionId: currentProjectionId, cursor: page.at(-1).findingId } : null,
    resynchronization: { occurred: resynchronized, reason: resynchronized ? "stale-or-missing-read-only-cursor" : null, restartedAtFirstPage: resynchronized },
    authority: "rebuildable-conformance-queue-view",
    authorityBoundary: artifactAuthorityBoundary("ConformanceQueueProjection"),
    instructionAuthority: false,
    promotionAuthority: false,
    recoveryAuthority: false,
    ordinaryWorkBlocked: false,
  };
}

export async function recordConformanceDisposition(options = {}) {
  return (await withProjectMutationAsync({ root: options.root ?? ".", scope: "conformance-disposition" }, async () => (await recordConformanceDispositionLocked(options))));
}

async function recordConformanceDispositionLocked({ root = ".", findingId, disposition, rationale, deferUntil = null, resolutionId = null, confirmUserDisposition = false, actor = "user" } = {}) {
  if (!["user", "head", "lode"].includes(actor)) fail("Conformance disposition actor is invalid.", "INVALID_CONFORMANCE_DISPOSITION");
  if (actor === "user" && confirmUserDisposition !== true) fail("User disposition requires explicit user confirmation; HEAD may acknowledge/defer honestly as maintenance.", "CONFORMANCE_USER_CONFIRMATION_REQUIRED");
  if (actor !== "user" && (confirmUserDisposition !== false || !["acknowledge", "defer"].includes(disposition) || resolutionId !== null)) fail("HEAD maintenance is acknowledge/defer only and must not claim user confirmation.", "CONFORMANCE_HEAD_MAINTENANCE_ONLY");
  const inspected = readyProject(root, "Conformance disposition");
  const authority = actor !== "user" ? formatForVerifiedOwner(inspected.storage).value(HEAD_CONFORMANCE_MAINTENANCE_AUTHORITY) : USER_CONFORMANCE_DISPOSITION_AUTHORITY;
  const artifacts = readArtifacts(inspected.project.projectRoot, inspected.project.projectId, inspected.storage);
  const finding = artifacts.findingsById.get(findingId);
  if (!finding) fail(`Conformance Finding not found: ${findingId}`, "CONFORMANCE_FINDING_NOT_FOUND");
  const resolution = resolutionId ? artifacts.resolutions.find((item) => item.resolutionId === resolutionId && item.findingId === findingId) || null : null;
  if (resolutionId && !resolution) fail("Conformance resolution candidate is missing.", "CONFORMANCE_RESOLUTION_NOT_FOUND");
  const normalizedDeferUntil = deferUntil == null ? null : Number.isNaN(Date.parse(deferUntil)) ? fail("Conformance defer-until time is invalid.", "INVALID_CONFORMANCE_DISPOSITION") : new Date(deferUntil).toISOString();
  const previous = artifacts.tails.get(findingId);
  if (previous && previous.authority === authority && previous.disposition === disposition && previous.rationale === String(rationale || "").trim() && previous.deferUntil === normalizedDeferUntil && previous.resolutionId === (resolution?.resolutionId || null)) return { status: "existing", disposition: previous, ordinaryWorkBlocked: false };
  if (resolution) {
    const current = (await currentBaseline(inspected.project.projectRoot, inspected.storage));
    if (resolution.assessment !== "appears-resolved" || conformanceCanonicalJson(resolution.baseline) !== conformanceCanonicalJson(current.baseline)) fail("Conformance resolution is not an exact current appears-resolved candidate.", "CONFORMANCE_RESOLUTION_STALE");
    try {
      verifyEvidenceAnchors({ projectRoot: inspected.project.projectRoot, projectId: inspected.project.projectId, baseline: resolution.baseline, world: current.world, anchors: resolution.evidenceAnchors });
    } catch (error) {
      if (new Set(["CONFORMANCE_SOURCE_DRIFT", "CONFORMANCE_SOURCE_TOO_LARGE", "CONFORMANCE_EVIDENCE_NOT_FOUND", "CONFORMANCE_BASELINE_DRIFT"]).has(error.code)) fail("Conformance resolution evidence changed; ask HEAD to reassess the exact current evidence before accepting it. Ordinary work remains available.", "CONFORMANCE_RESOLUTION_STALE");
      throw error;
    }
  }
  const receipt = createConformanceDispositionReceipt({ projectId: inspected.project.projectId, sessionId: inspected.state.sessionId, finding, disposition, rationale, deferUntil, previousDisposition: previous, resolution, actor }, inspected.storage);
  const persisted = persistImmutable(inspected.project.projectRoot, directories(inspected.storage).dispositions, receipt.dispositionId, receipt, "Conformance disposition");
  return { ...persisted, disposition: receipt, ordinaryWorkBlocked: false, authority: { disposition: "P3-exact-finding-evidence", executionAuthorized: false, productCanonMutated: false, recoveryDirectionMutated: false } };
}

export async function proposeConformanceResolution({ root = ".", findingId, baseline, evidenceAnchors, assessment, rationale } = {}) {
  const inspected = readyProject(root, "Conformance resolution proposal");
  const artifacts = readArtifacts(inspected.project.projectRoot, inspected.project.projectId, inspected.storage);
  const finding = artifacts.findingsById.get(findingId);
  if (!finding) fail(`Conformance Finding not found: ${findingId}`, "CONFORMANCE_FINDING_NOT_FOUND");
  const current = (await currentBaseline(inspected.project.projectRoot, inspected.storage));
  assertCurrentBaseline(baseline, current);
  const disclosures = verifyEvidenceAnchors({ projectRoot: inspected.project.projectRoot, projectId: inspected.project.projectId, baseline, world: current.world, anchors: evidenceAnchors });
  const resolution = createConformanceResolutionCandidate({ projectId: inspected.project.projectId, sessionId: inspected.state.sessionId, finding, baseline, evidenceAnchors, assessment, rationale, disclosures }, inspected.storage);
  const persisted = persistImmutable(inspected.project.projectRoot, directories(inspected.storage).resolutions, resolution.resolutionId, resolution, "Conformance resolution");
  return { ...persisted, resolution, ordinaryWorkBlocked: false, authority: { resolution: "P3-candidate-evidence", findingClosed: false, productCanonMutated: false, recoveryDirectionMutated: false } };
}

export function conformanceSourceDigest(root, relativePath) {
  const inspected = readyProject(root, "Conformance source digest inspection");
  const { normalized, target } = normalizedRelativePath(inspected.project.projectRoot, relativePath);
  const stat = fs.statSync(target);
  if (!stat.isFile()) fail("Conformance source must be a regular file.", "CONFORMANCE_SOURCE_UNSAFE");
  if (stat.size > MAX_SOURCE_FILE_BYTES) fail("Direct Conformance source hashing is bounded to 64 MiB; use an exact current World or ChangeSet anchor for larger files. Ordinary work remains available.", "CONFORMANCE_SOURCE_TOO_LARGE");
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(target, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally { fs.closeSync(descriptor); }
  return { path: normalized, fileDigest: hash.digest("hex") };
}

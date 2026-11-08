import fs from "node:fs";
import { verifyImportedDefaultRun } from "./session-imported-run-proof.mjs";
import { verifyRunTransitionOriginal } from "./run-source-verification.mjs";
import path from "node:path";
import { copiedProjectFile, inspectCopiedProjectFile } from "./project-copy-evidence.mjs";
import { inspectProjectDirectionOriginalFiles, verifyProjectDirectionOriginal } from "./project-direction.mjs";
import { validateKnowledge, verifyContextCapsuleOriginal } from "./context-compiler.mjs";
import { normalizeProductModelDocument } from "./product-model.mjs";
import { verifyRecoveryCheckpointOriginal } from "./compaction-recovery.mjs";
import { lineageArtifactRelativePath, verifyLineageArtifactOriginal } from "./execution-lineage.mjs";
import { sha256Hex } from "./core/digest.mjs";
import { failCode as fail } from "./core/errors.mjs";

// Shared source-data verifier. It neither selects a Core owner nor resolves an
// historical root on disk. read/has/list address an already chosen source.
export function verifySelectedProjectOriginals({ directory, project, selectedSessionPath, selectedSessionId = null, read, has, list, verifyRunOwner = null }) {
  if (![".lode", ".head"].includes(directory)) fail("PROJECT_COPY_PATH_INVALID");
  const format = { dialect: directory === ".lode" ? "lode" : "head", directory };
  const directionPath = directory + "/project-direction/current.json";
  if (has(directionPath)) {
    const pointer = read(directionPath);
    if (typeof pointer.directionId !== "string" || !/^direction-[a-f0-9]{24}$/.test(pointer.directionId)) fail("INVALID_PROJECT_DIRECTION");
    verifyProjectDirectionOriginal(read(directory + "/project-direction/revisions/" + pointer.directionId + ".json"), project);
  } else if (list(directory + "/project-direction/revisions").some((name) => /^direction-.*\.json$/.test(name))) fail("PROJECT_DIRECTION_UNAVAILABLE");
  validateKnowledge(read(directory + "/context/knowledge.json"));
  normalizeProductModelDocument(read(directory + "/context/product-model.json"), format);
  const sessionRelative = selectedSessionPath;
  if (
    typeof sessionRelative !== "string" ||
    !(
      sessionRelative === directory + "/sessions/current.json" ||
      new RegExp("^\\" + directory + "/sessions/by-id/session-[a-fA-F0-9-]{36}/current\\.json$").test(sessionRelative)
    )
  )
    fail("INVALID_SESSION_CANON");
  const state = read(sessionRelative);
  if (
    state?.schemaVersion !== 1 ||
    typeof state.sessionId !== "string" ||
    !/^session-[a-fA-F0-9-]{36}$/.test(state.sessionId) ||
    (state.projectId && state.projectId !== project.projectId) ||
    (selectedSessionId && state.sessionId !== selectedSessionId)
  )
    fail("INVALID_SESSION_CANON");
  const queue = [],
    seen = new Set();
  const enqueue = (id) => {
    if (id != null) {
      if (typeof id !== "string") fail("PROJECT_COPY_REFERENCE_INVALID");
      queue.push(id);
    }
  };
  const references = (object) => {
    if (!object || typeof object !== "object") return;
    for (const key of [
      "currentWholePlanId",
      "wholePlanId",
      "activeExecutionContractId",
      "executionContractId",
      "lastResultPacketId",
      "resultPacketId",
      "lastReviewDecisionId",
      "reviewDecisionId",
      "capsuleId",
      "previousCheckpointId",
      "activeRunId",
      "runId",
      "lastReviewedRunId",
    ])
      enqueue(object[key]);
    for (const link of object.lineage || []) {
      // Fresh HEAD review context is a non-persisted P4 projection. Its exact
      // reference remains in ReviewDecision; it is not a missing P3 original.
      if (link.relation === "reviewed-through" && /^fresh-(?:head|lode)-review-[a-f0-9]{24}$/.test(link.targetId)) continue;
      enqueue(link.targetId);
    }
    if (object.sessionPointer) references(object.sessionPointer);
    if (object.runPointer) references(object.runPointer);
    if (object.pendingReview) references(object.pendingReview);
  };
  references(state);
  enqueue(state.latestCheckpoint);
  while (queue.length) {
    const id = queue.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    let document;
    if (/^run-[0-9]+-[a-f0-9]{6}$/.test(id)) {
      document = read(directory + "/sessions/runs/" + id + "/run.json");
      if (
        document.schemaVersion !== 1 ||
        document.runId !== id ||
        document.projectId !== project.projectId ||
        !["active", "awaiting_review", "reviewed"].includes(document.status) ||
        (document.sessionId && document.sessionId !== state.sessionId)
      )
        fail("COMPACTION_RUN_POINTER_MISMATCH");
      if (
        document.sessionId == null &&
        selectedSessionPath !== directory + "/sessions/current.json" &&
        (!verifyRunOwner || verifyRunOwner(id, document) !== true)
      )
        fail("RUN_SESSION_MISMATCH");
      verifyRunTransitionOriginal({
        inspected: { project, state },
        run: document,
        requireArtifact(_root, artifactId, kind) {
          const artifact = read(lineageArtifactRelativePath(artifactId, directory));
          verifyLineageArtifactOriginal({
            artifact,
            artifactId,
            projectId: project.projectId,
            storage: format,
          });
          if (artifact.kind !== kind) fail("RUN_LINEAGE_KIND_MISMATCH");
          return artifact;
        },
        readContextCapsule({ capsuleId }) {
          const capsule = read(directory + "/context/capsules/" + capsuleId + ".json");
          verifyContextCapsuleOriginal({ capsule, capsuleId, projectId: project.projectId });
          return { capsule };
        },
      });
    } else if (/^checkpoint-[a-f0-9]{24}$/.test(id)) {
      document = read(directory + "/sessions/ledger/" + id + ".json");
      verifyRecoveryCheckpointOriginal({
        checkpoint: document,
        projectId: project.projectId,
        sessionId: state.sessionId,
        expectedCheckpointId: id,
        storage: format,
      });
    } else if (/^capsule-[a-f0-9]{24}$/.test(id)) {
      document = read(directory + "/context/capsules/" + id + ".json");
      verifyContextCapsuleOriginal({
        capsule: document,
        capsuleId: id,
        projectId: project.projectId,
      });
    } else {
      let artifactPath;
      try {
        artifactPath = lineageArtifactRelativePath(id, directory);
      } catch (error) {
        error.referenceId = id;
        throw error;
      }
      document = read(artifactPath);
      verifyLineageArtifactOriginal({
        artifact: document,
        artifactId: id,
        projectId: project.projectId,
        storage: format,
      });
    }
    references(document);
  }
  return {
    status: "source-originals-verified",
    sessionId: state.sessionId,
    ordinaryCoreRestored: false,
    grantsOwnership: false,
  };
}

// Physical source wrapper: no synthetic registered storage owner or alias.
export function inspectCopiedProjectCanon({ root, directory, project, selectedSession } = {}) {
  const originals = new Map(),
    runOwnerOriginals = new Set();
  let runOwnerGlobalMetadata = false;
  const read = (relative) => {
    const observed = inspectCopiedProjectFile(root, relative),
      bytes = fs.readFileSync(copiedProjectFile(root, relative));
    if (sha256Hex(bytes) !== observed.sha256) fail("PROJECT_COPY_SOURCE_CHANGED");
    const after = inspectCopiedProjectFile(root, relative);
    if (after.sha256 !== observed.sha256 || after.bytes !== bytes.length) fail("PROJECT_COPY_SOURCE_CHANGED");
    const document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    originals.set(relative, observed);
    return document;
  };
  // Retain the existing trace/lost-pointer diagnostics, including tmp records.
  inspectProjectDirectionOriginalFiles({ root, directory, project });
  const selectedSessionPath = selectedSession?.stateFile
    ? path.relative(root, selectedSession.stateFile).replaceAll("\\", "/")
    : directory + "/sessions/current.json";
  const result = verifySelectedProjectOriginals({
    directory,
    project,
    selectedSessionPath,
    selectedSessionId: selectedSession?.sessionId,
    read,
    verifyRunOwner(runId, run) {
      const relative = directory + "/sessions/runs/" + runId + "/run.json";
      const raw = fs.readFileSync(copiedProjectFile(root, relative));
      return verifyImportedDefaultRun({
        root,
        directory,
        project,
        sessionId: selectedSession?.sessionId,
        runFile: copiedProjectFile(root, relative),
        runBytes: raw,
        run,
        onOriginal(relative, bytes, document) {
          originals.set(relative, {
            path: relative,
            bytes: bytes.length,
            sha256: sha256Hex(bytes),
          });
          runOwnerOriginals.add(relative);
          if (
            document?.kind === "VerifiedProjectCopyAdmission" ||
            (document?.kind === "PortableProjectAdmission" && document.selectedSessionId !== selectedSession?.sessionId)
          )
            runOwnerGlobalMetadata = true;
        },
      });
    },
    has: (relative) => fs.existsSync(copiedProjectFile(root, relative)),
    list: (relative) => {
      const file = copiedProjectFile(root, relative);
      return fs.existsSync(file) ? fs.readdirSync(file) : [];
    },
  });
  return {
    ...result,
    originals: [...originals.values()],
    runOwnerOriginals: [...runOwnerOriginals],
    runOwnerGlobalMetadata,
  };
}

export function verifyProjectMetadataOriginal(project, directory) {
  if (![".lode", ".head"].includes(directory)) fail("PROJECT_COPY_PATH_INVALID");
  const dialect = directory === ".lode" ? "lode" : "head";
  if (
    project?.schemaVersion !== 1 ||
    typeof project.projectId !== "string" ||
    !new RegExp(`^${dialect}-[a-f0-9]{20}$`).test(project.projectId || "") ||
    typeof project.authority?.[dialect] !== "string" ||
    typeof project.authority?.user !== "string" ||
    typeof project.createdAt !== "string" ||
    !Number.isFinite(Date.parse(project.createdAt)) ||
    !Array.isArray(project.runtimes) ||
    !project.runtimes.length ||
    !project.runtimes.every((value) => ["codex", "claude", "opencode"].includes(value)) ||
    !project.integrations ||
    typeof project.integrations !== "object" ||
    Array.isArray(project.integrations)
  )
    fail("INVALID_CANON");
  return project;
}

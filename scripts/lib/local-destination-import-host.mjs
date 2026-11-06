import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { atomicCreateArtifact } from "./artifact-storage.mjs";
import { nativeRoot, nativeCheck, nativeRaw, nativeSeparate } from "./provider-native-history-host.mjs";
import { admitDestinationImportTarget, readLocalDestinationImportTargetReceipt } from "./destination-import-journal.mjs";
import { derivedHash as hash, derivedJson as json, derivedFail as fail } from "./claude-derived-encoder.mjs";
import { copiedProjectFile } from "./project-copy-evidence.mjs";

const localRoot = () => process.platform === "win32" ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData/Local"), "Lode/native-imports")
  : path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"), "lode/native-imports");
const identity = root => { const stat = fs.lstatSync(root, { bigint: true }); return { path: root, dev: String(stat.dev), ino: String(stat.ino) }; };

// Storage identity is Host configuration, never an archive/tool argument. This
// adapter discovers/resumes only existing targets. First admission is a separate
// explicit current Host effect; read/status/publish never bootstrap a journal.
export function createLocalDestinationImportHost({ storageRoot = localRoot(), nativeHome, signal, assertCurrentAuthority, sourceHistoryFor,
  authorizeTargetAdmission = null } = {}) {
  if (typeof assertCurrentAuthority !== "function" || typeof sourceHistoryFor !== "function" || !path.isAbsolute(storageRoot || "")) fail("DESTINATION_LOCAL_CURRENT_HOST_REQUIRED");
  const check = request => nativeCheck(signal, () => assertCurrentAuthority(request));
  function hostState(admit = false) {
    check({ action: admit ? "admit-local-import-host" : "read-local-import-host", authorityPlane: "P5", storageRoot });
    if (!fs.lstatSync(storageRoot, { throwIfNoEntry: false })) {
      if (!admit) fail("DESTINATION_LOCAL_HOST_NOT_ADMITTED");
      fs.mkdirSync(storageRoot, { recursive: true });
    }
    const root = nativeRoot(storageRoot), store = identity(root), file = path.join(root, "host.json");
    if (!fs.lstatSync(file, { throwIfNoEntry: false })) {
      if (!admit || fs.readdirSync(root).length) fail("DESTINATION_LOCAL_HOST_IDENTITY_MISSING_UNKNOWN");
      check({ action: "admit-local-import-host", authorityPlane: "P5", storageRoot });
      atomicCreateArtifact(file, json({ schemaVersion: 1, kind: "LocalDestinationImportHost", authorityPlane: "P5", hostId: crypto.randomUUID(), store,
        grantsRecoveryAuthority: false, restoresExecutionPermission: false }));
    }
    const document = JSON.parse(nativeRaw(root, "host.json", signal, () => check({ action: "read-local-import-host", authorityPlane: "P5", storageRoot })).raw.toString("utf8"));
    if (document.schemaVersion !== 1 || document.kind !== "LocalDestinationImportHost" || document.authorityPlane !== "P5"
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(document.hostId || "") || !equal(document.store, store)
      || document.grantsRecoveryAuthority !== false || document.restoresExecutionPermission !== false) fail("DESTINATION_LOCAL_HOST_IDENTITY_CHANGED");
    return { root, document };
  }
  function targetOptions(projectRoot, state) {
    return { journalRoot: state.root, hostId: state.document.hostId, nativeHome: nativeRoot(nativeHome), projectRoot: nativeRoot(projectRoot), provider: "claude", signal,
      assertCurrentAuthority: request => check(request) };
  }
  return {
    authorityPlane: "P5",
    async admitTarget({ projectRoot }) {
      if (typeof authorizeTargetAdmission !== "function") fail("DESTINATION_LOCAL_CURRENT_TARGET_ADMISSION_REQUIRED");
      nativeCheck(signal, () => authorizeTargetAdmission({ provider: "claude", nativeHome, projectRoot, storageRoot, action: "admit-new-destination-target" }));
      const home = nativeRoot(nativeHome), project = nativeRoot(projectRoot); nativeSeparate(path.resolve(storageRoot), home); nativeSeparate(path.resolve(storageRoot), project);
      const state = hostState(true), options = targetOptions(projectRoot, state), existing = readLocalDestinationImportTargetReceipt(options);
      if (existing.status === "destination-existing-target-observed") return existing;
      if (existing.reasonCode !== "DESTINATION_TARGET_NOT_ADMITTED") return existing;
      return admitDestinationImportTarget(options);
    },
    async currentMetadataScope({ projectRoot, nativeHome: requestedHome }) {
      check({ action: "read-current-destination-metadata-scope", authorityPlane: "P5", projectRoot });
      const state = hostState(), options = targetOptions(projectRoot, state);
      if (nativeRoot(requestedHome) !== options.nativeHome) fail("DESTINATION_LOCAL_CURRENT_SCOPE_CHANGED");
      const target = readLocalDestinationImportTargetReceipt(options);
      if (!target.receipt) fail(target.reasonCode);
      return { ...options, receipt: target.receipt };
    },
    async currentImportScope(request) {
      check({ action: "read-current-destination-import-scope", authorityPlane: "P5", nativeHome, projectRoot: request.projectRoot });
      const state = hostState(), options = targetOptions(request.projectRoot, state);
      if (request.nativeHome !== options.nativeHome || request.provider !== "claude") fail("DESTINATION_LOCAL_CURRENT_SCOPE_CHANGED");
      const target = readLocalDestinationImportTargetReceipt(options);
      if (!target.receipt) throw Object.assign(new Error(target.reasonCode), { code: target.reasonCode, destinationImportObservation: target });
      const history = await sourceHistoryFor(request); check({ action: "read-current-destination-source-history", authorityPlane: "P5", operation: request.operation });
      if (!history || history.sourceDigest !== request.operation.sourceDigest || !/^[a-f0-9]{64}$/u.test(history.evidenceDigest || "")
        || !Array.isArray(history.records) || history.sourceVerified !== true) fail("DESTINATION_LOCAL_VERIFIED_HISTORY_REQUIRED");
      // A different exact native-file identity is a different bounded effect.
      // Same-ID or opaque attempts cannot be classified as another PC by path
      // or inode guesses. Retain that uncertainty for this effect only.
      const alternatives = request.alternativeNativeIds ?? [];
      if (!Array.isArray(alternatives) || alternatives.some(id => !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(id))) fail("DESTINATION_LOCAL_CURRENT_SCOPE_CHANGED");
      const unresolvedNow = history.records.some(record => !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(record?.nativeId || "")
        || record.nativeId === request.operation.nativeId || alternatives.includes(record.nativeId));
      const retainedPath = "uncertainty/" + target.receipt.targetKey + "/" + request.operation.nativeId + ".json";
      const currentStore = () => {
        check({ action: "observe-destination-history-uncertainty", authorityPlane: "P5", operation: request.operation });
        if (!equal(identity(nativeRoot(state.root)), state.document.store)) fail("DESTINATION_LOCAL_HOST_IDENTITY_CHANGED");
      };
      currentStore(); const retainedFile = copiedProjectFile(state.root, retainedPath);
      let retained = Boolean(fs.lstatSync(retainedFile, { throwIfNoEntry: false }));
      if (unresolvedNow && !retained) {
        const observation = { schemaVersion: 1, kind: "DestinationPriorHistoryUncertainty", authorityPlane: "P5", targetId: target.receipt.targetId,
          nativeId: request.operation.nativeId, sourceDigest: request.operation.sourceDigest, historyEvidenceDigest: history.evidenceDigest,
          automaticReplayAllowed: false, grantsRecoveryAuthority: false, restoresExecutionPermission: false };
        currentStore(); fs.mkdirSync(path.dirname(retainedFile), { recursive: true }); currentStore(); copiedProjectFile(state.root, retainedPath);
        try { atomicCreateArtifact(retainedFile, json(observation)); }
        catch (error) { if (error.code !== "EEXIST") throw error; }
        retained = true;
      }
      if (retained) {
        const prior = JSON.parse(nativeRaw(state.root, retainedPath, signal, currentStore).raw.toString("utf8"));
        if (prior.schemaVersion !== 1 || prior.kind !== "DestinationPriorHistoryUncertainty" || prior.authorityPlane !== "P5"
          || prior.targetId !== target.receipt.targetId || prior.nativeId !== request.operation.nativeId || prior.sourceDigest !== request.operation.sourceDigest
          || !/^[a-f0-9]{64}$/u.test(prior.historyEvidenceDigest || "") || prior.automaticReplayAllowed !== false
          || prior.grantsRecoveryAuthority !== false || prior.restoresExecutionPermission !== false) fail("DESTINATION_LOCAL_HISTORY_UNCERTAINTY_CHANGED");
      }
      return { ...options, receipt: target.receipt, historicalDisposition: "current-explicit-new-target-intent",
        historyAssessment: { sameTargetAttemptObserved: false, unresolvedAttemptObserved: retained || unresolvedNow,
          evidenceDigest: hash(json({ sourceDigest: history.sourceDigest, evidenceDigest: history.evidenceDigest, records: history.records })) } };
    },
  };
}

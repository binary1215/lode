import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";
const lineageFormat = record => familyFormatForOriginal({ sessionIdentity: true }, record);
import fs from "node:fs";
import path from "node:path";
import { captureWorkerWriteBasis, verifyWorkerWriteBasis } from "./worker-patch-basis.mjs";
import { verifyWorkerSourceBasis, workerSourcePathParts } from "./worker-source-basis.mjs";
import { readRuntimeInvocationRecord } from "./runtime-invocation-record.mjs";
import { readWorkerPatchIntegration } from "./worker-patch-integration.mjs";
import { integrationDigest as digest, integrationJson as json } from "./worker-integration-store.mjs";

const fail = message => { throw Object.assign(new Error(message), { code: "WORKER_INTEGRATION_BASIS_INVALID" }); };
const key = value => process.platform === "win32" ? value.toLowerCase() : value;
const flags = { appliedByThisOperation: false, instructionAuthority: false, promotionAuthority: false,
  recoveryAuthority: false, reviewDecisionCreated: false, mutatesCanon: false };
const knownObservationErrors = new Set(["WORKER_PATCH_CONFLICT", "INVALID_WORKER_SOURCE_BASIS", "WORKER_SOURCE_BASIS_DRIFT",
  "ENOENT", "ENOTDIR", "EISDIR", "EACCES", "EPERM", "EBUSY", "ELOOP"]);
const compact = item => item.kind === "absent" ? { kind: "absent" }
  : { kind: "file", digest: item.digest, bytes: item.bytes, mode: item.mode };
const sameImage = (observed, image) => observed.kind === image.kind && (observed.kind === "absent"
  || observed.digest === image.digest && observed.bytes === image.bytes && observed.mode === image.mode);

function finiteBound(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail("Integration observation requires a finite byte bound.");
  return value;
}

function observedIdentity(root, relative, storage) {
  const result = [];
  const parts = workerSourcePathParts(relative, storage);
  let cursor = path.resolve(root);
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) cursor = path.join(cursor, parts[index]);
    const stat = fs.lstatSync(cursor, { throwIfNoEntry: false });
    if (!stat) {
      result.push({ part: index, kind: "absent" });
      break;
    }
    if (stat.isSymbolicLink() || index < parts.length - 1 && !stat.isDirectory()
      || index === parts.length - 1 && (!stat.isFile() || stat.nlink !== 1)) {
      throw Object.assign(new Error("Unsafe selected dependency path."), { code: "WORKER_PATCH_CONFLICT" });
    }
    const identity = { part: index, kind: stat.isDirectory() ? "directory" : "file", dev: stat.dev, ino: stat.ino, mode: stat.mode };
    // Directory namespace timestamps include unrelated files; they are not a
    // reservation over every sibling. Bind directory identity, not such noise.
    if (stat.isFile()) Object.assign(identity, { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
    result.push(identity);
  }
  return result;
}

function observePath(root, selected, maxBytes, storage) {
  try {
    const identityBefore = observedIdentity(root, selected.path, storage);
    const [image] = captureWorkerWriteBasis({ root, paths: [selected.path], maxBytes, storage });
    const identityAfter = observedIdentity(root, selected.path, storage);
    return { path: selected.path, image: compact(image), identities: identityAfter,
      changedDuringCapture: json(identityBefore) !== json(identityAfter) };
  } catch (error) {
    if (!knownObservationErrors.has(error.code)) throw error;
    return { path: selected.path, image: { kind: "unverifiable", code: error.code }, identities: null,
      changedDuringCapture: error.code === "WORKER_SOURCE_BASIS_DRIFT" };
  }
}

function prepareSelection(dependencies, patches, storage) {
  if (!Array.isArray(dependencies) || !dependencies.length || !Array.isArray(patches)) fail("Integration basis needs bounded member dependencies and effects.");
  const selected = new Map();
  let maxBytes = 0;
  const members = new Set();
  for (const dependency of dependencies) {
    if (!Number.isSafeInteger(dependency.memberIndex) || dependency.memberIndex < 0 || members.has(dependency.memberIndex)
      || !/^execution-authorization-[a-f0-9]{24}$/.test(dependency.authorizationId || "")
      || !/^[a-f0-9]{64}$/.test(dependency.authorizationHash || "")) fail("Invalid dependency member provenance.");
    members.add(dependency.memberIndex);
    finiteBound(dependency.maxBytes);
    verifyWorkerSourceBasis(dependency.sourceBasis, dependency.maxBytes, storage);
    maxBytes = finiteBound(maxBytes + dependency.maxBytes);
    for (const source of dependency.sourceBasis) {
      const identity = key(source.path);
      const entry = selected.get(identity) || { path: source.path, originals: [], effect: null, maxBytes: 0 };
      // Read aliases preserve their supplied spelling as provenance; they do
      // not reserve or conflict over a write path. Actual effect overlap was
      // checked by the verified composition, not by this observation helper.
      entry.originals.push({ memberIndex: dependency.memberIndex, sourcePath: source.path, digest: source.digest, bytes: source.bytes });
      entry.maxBytes = Math.max(entry.maxBytes, dependency.maxBytes);
      selected.set(identity, entry);
    }
  }
  let effectBytes = 0;
  for (const patch of patches) {
    if (!patch?.before || !patch?.after || patch.before.path !== patch.after.path
      || !Array.isArray(patch.memberIndices) || !patch.memberIndices.length
      || new Set(patch.memberIndices).size !== patch.memberIndices.length || patch.memberIndices.some(index => !members.has(index))) fail("Invalid effect provenance.");
    const bound = finiteBound((patch.before.bytes || 0) + (patch.after.bytes || 0));
    verifyWorkerWriteBasis([patch.before], bound, storage);
    verifyWorkerWriteBasis([patch.after], bound, storage);
    effectBytes = finiteBound(effectBytes + bound);
    const identity = key(patch.before.path);
    const entry = selected.get(identity) || { path: patch.before.path, originals: [], effect: null, maxBytes: 0 };
    if (entry.effect) fail("Duplicate or aliased integration effects.");
    entry.path = patch.before.path;
    entry.effect = { before: compact(patch.before), after: compact(patch.after), memberIndices: [...patch.memberIndices] };
    entry.maxBytes = Math.max(entry.maxBytes, bound);
    selected.set(identity, entry);
  }
  // Each pass is explicitly bounded by the member input allocations plus exact
  // effect image sizes, rather than an implicit unbounded current-file read.
  maxBytes = finiteBound(maxBytes + effectBytes);
  return { maxBytes, selected: [...selected.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
}

// Low-level read-only observation. Supplied labels are provenance *claims* until
// the public reader below binds them to verified stored invocation records.
// This helper does not reserve no-op ownership or decide semantic sufficiency.
export function observeWorkerIntegrationReadBasis({ root, dependencies, patches, storage }) {
  const { selected, maxBytes } = prepareSelection(dependencies, patches, storage);
  const pass = () => {
    let remaining = maxBytes;
    return selected.map(entry => {
      const observed = observePath(root, entry, Math.min(entry.maxBytes, remaining), storage);
      remaining -= observed.image.bytes || 0;
      return observed;
    });
  };
  const first = pass();
  const second = pass();
  const entries = selected.map((entry, index) => {
    const observed = second[index].image;
    const changedDuringObservation = first[index].changedDuringCapture || second[index].changedDuringCapture || json(first[index]) !== json(second[index]);
    const matchesOriginalMemberIndices = observed.kind === "file" ? entry.originals.filter(original => original.digest === observed.digest && original.bytes === observed.bytes).map(original => original.memberIndex) : [];
    const expectedPostimagePresent = entry.effect !== null && sameImage(observed, entry.effect.after);
    const expectedPreimagePresent = entry.effect !== null && sameImage(observed, entry.effect.before);
    const allOriginalsPresent = entry.originals.length > 0 && matchesOriginalMemberIndices.length === entry.originals.length;
    const status = changedDuringObservation ? "conflict" : observed.kind === "unverifiable" ? "unverifiable"
      : expectedPostimagePresent ? "integration-postimage-present" : allOriginalsPresent && (!entry.effect || expectedPreimagePresent) ? "original-basis-present"
        : expectedPreimagePresent && !entry.originals.length ? "integration-preimage-present" : observed.kind === "absent" ? "absent" : "external-dependency-drift";
    return { path: entry.path, originals: entry.originals, expectedEffect: entry.effect, observed,
      identities: second[index].identities, status, matchesOriginalMemberIndices, expectedPostimagePresent, expectedPreimagePresent,
      changedDuringObservation };
  });
  const observation = { passes: 2, maxBytesPerPass: maxBytes, atomicSnapshot: false, metadataCAS: false, detectsABA: false };
  const observationStable = entries.every(entry => !entry.changedDuringObservation);
  const observedBasisDigest = digest(json({ observation, entries: entries.map(({ path, observed, identities, changedDuringObservation }) => ({ path, observed, identities, changedDuringObservation })) }));
  const projection = { kind: "WorkerIntegrationReadBasisProjection", protocolVersion: "0.1.0", dependencies: entries,
    status: observationStable ? "stable-observation" : "observation-conflict", observationStable,
    allDependenciesObservable: entries.every(entry => entry.observed.kind !== "unverifiable"),
    headReassessmentRequired: entries.some(entry => ["external-dependency-drift", "absent", "unverifiable", "conflict"].includes(entry.status)),
    requiresWholeResultVerification: true, observedBasisDigest, observation, lineageVerified: false,
    semanticVerification: "not-assessed", ...flags };
  return { ...projection, basisDigest: digest(json(projection)) };
}

function memberDependencies(root, intent) {
  return intent.members.map((member, memberIndex) => {
    const { authorization, receipt } = readRuntimeInvocationRecord({ root, authorizationId: member.authorizationId, storage: lineageFormat(intent.lineage) });
    if (authorization.authorizationHash !== member.authorizationHash || receipt.receiptId !== member.lifecycleReceiptId
      || authorization.executionInput.digest !== member.inputDigest || !authorization.workerInput) fail("Dependency provenance differs from integration member.");
    return { memberIndex, authorizationId: member.authorizationId, authorizationHash: member.authorizationHash,
      sourceBasis: authorization.workerInput.sourceBasis, maxBytes: authorization.limits.maxInputBytes };
  });
}

// Historical intent identity remains readable across current-source drift. This
// projection reports that drift for HEAD/whole-result verification; it does not
// require the source to remain forever equal to a worker's original selection.
export function readWorkerIntegrationBasis({ root = ".", integrationId, storage } = {}) {
  const { intent } = readWorkerPatchIntegration({ root, integrationId, storage });
  const dependencies = memberDependencies(root, intent);
  const observed = observeWorkerIntegrationReadBasis({ root, dependencies, patches: intent.composition.patches, storage: lineageFormat(intent.lineage) });
  const { intent: after } = readWorkerPatchIntegration({ root, integrationId, storage });
  if (json(intent) !== json(after) || json(dependencies) !== json(memberDependencies(root, after))) fail("Stored integration basis changed during observation.");
  const { basisDigest: ignored, ...view } = observed;
  const projection = { ...view, integrationId: intent.integrationId, integrationHash: intent.integrationHash,
    lineage: intent.lineage, lineageVerified: true };
  return { ...projection, basisDigest: digest(json(projection)) };
}

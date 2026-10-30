import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";
const sessionIdOf = record => {
  const format = familyFormatForOriginal({ sessionIdentity: true }, record);
  return format ? record?.[format.sessionIdField] : undefined;
};
const originalFormat = record => familyFormatForOriginal({ kind: record?.kind }, record);
const lineageFormat = record => familyFormatForOriginal({ sessionIdentity: true }, record);
import fs from "node:fs";
import path from "node:path";
import { artifactAuthorityBoundary, verifyArtifactAuthorityBoundary } from "./authority-plane-contract.mjs";
import { inspectProject } from "./lode-core.mjs";
import { readContextCapsule } from "./context-compiler.mjs";
import { readLineageArtifact } from "./execution-lineage.mjs";
import { readBoundedWorkerDispatch } from "./bounded-worker-dispatch.mjs";
import { readBoundedWorkerPatch } from "./bounded-worker-job.mjs";
import { readRuntimeInvocationRecord } from "./runtime-invocation-record.mjs";
import { prepareRuntimeInvocationExecution, verifyRuntimeInvocationCurrentLineage } from "./runtime-invocation-lifecycle.mjs";
import { workerMemberKey } from "./worker-member-registry.mjs";
import { verifyWorkerPatchCandidate } from "./worker-patch-basis.mjs";
import { buildWorkerPatchProposalCandidate, isWorkerPatchProposalMode } from "./worker-patch-proposal.mjs";
import { composeWorkerPatchCandidates } from "./worker-patch-composition.mjs";
import { withProjectMutation } from "./project-mutation-lock.mjs";
import { integrationDigest as digest, integrationJson as json, workerIntegrationDirectory, readIntegrationBytes, publishIntegrationJson } from "./worker-integration-store.mjs";

const fail = message => { throw Object.assign(new Error(message), { code: "WORKER_PATCH_INTEGRATION_CONFLICT" }); };
const flags = { instructionAuthority: false, promotionAuthority: false, recoveryAuthority: false, reviewDecisionCreated: false, mutatesCanon: false };
const same = (a, b) => json(a) === json(b);
function fields(value, names) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !same(Object.keys(value).sort(), [...names].sort())) fail("Invalid worker integration fields.");
}
function identity(payload) {
  const integrationHash = digest(json(payload));
  return { ...payload, integrationId: `${membershipPrefix(payload.members.map(member => member.authorizationId))}${integrationHash.slice(0, 24)}`, integrationHash };
}
const membershipPrefix = authorizationIds => `worker-integration-${digest(json([...authorizationIds].sort())).slice(0, 24)}--`;
function binding(authorization) {
  if (authorization.scope.kind !== "run") fail("Combined worker integration belongs to an exact durable Run.");
  return { projectId: authorization.projectId, projectRootDigest: authorization.projectRootDigest,
    [originalFormat(authorization).sessionIdField]: sessionIdOf(authorization), runId: authorization.scope.runId,
    wholePlanId: authorization.scope.wholePlanId, executionContractId: authorization.scope.executionContractId,
    contextCapsuleId: authorization.scope.contextCapsuleId };
}
function integrationFile(root, integrationId, create = false, storage) {
  if (!/^worker-integration-[a-f0-9]{24}--[a-f0-9]{24}$/.test(integrationId || "")) fail("Invalid worker integration identity.");
  return path.join(workerIntegrationDirectory(root, create, storage), `${integrationId}.json`);
}
function recordMember(root, authorizationId, candidate) {
  const { dispatch, authorization } = readBoundedWorkerDispatch({ root, authorizationId });
  const record = readRuntimeInvocationRecord({ root, authorizationId, storage: originalFormat(authorization) });
  verifyWorkerPatchCandidate(candidate, originalFormat(authorization));
  const writeBound = authorization.protocolVersion === "0.6.0" && authorization.workerInput?.writeBasis
    && same(candidate.basis, authorization.workerInput.writeBasis)
    && authorization.requiredAllowedActions.includes("project.write");
  // A read-only proposal is data, not delegated write authority. Its candidate
  // is reconstructed from the exact receipt-bound result rather than accepted
  // merely because an owner supplied a structurally valid patch.
  const proposalBound = authorization.protocolVersion === "0.7.0"
    && isWorkerPatchProposalMode(authorization.workerInput?.executionBoundary?.mode)
    && authorization.workspaceMode === "read-only"
    && authorization.requiredAllowedActions.includes("project.read")
    && !authorization.requiredAllowedActions.includes("project.write")
    && record.receipt.inputDigestObserved === authorization.executionInput.digest
    && record.receipt.executionLeaseConsumptionId === record.draft.executionLeaseConsumptionId
    && record.receipt.providerBoundary.structuredResultObserved === true
    && record.receipt.providerBoundary.structuredResultDigest === digest(json(record.draft.providerResult))
    && same(candidate, buildWorkerPatchProposalCandidate({ authorization, structuredResult: record.draft.providerResult }));
  if ((!writeBound && !proposalBound)
    || record.receipt.status !== "completed" || record.receipt.exitCode !== 0
    || record.receipt.processBoundary.descendantTreeOwnershipValidated !== true
    || record.authorization.authorizationHash !== authorization.authorizationHash) fail("Integration member is not a completed exact write-bound worker or read-only patch proposal.");
  return { authorization, record, member: {
    authorizationId, authorizationHash: authorization.authorizationHash,
    inputDigest: authorization.executionInput.digest, memberKey: workerMemberKey(authorization),
    dispatchId: dispatch.dispatchId, dispatchHash: dispatch.dispatchHash,
    lifecycleReceiptId: record.receipt.receiptId, draftId: record.draft.draftId,
    executionLeaseConsumptionId: record.draft.executionLeaseConsumptionId,
    executionLeaseReleaseId: record.draft.executionLeaseReleaseId,
    actualProviderInvoked: record.receipt.providerBoundary.actualProviderInvoked, candidate,
  } };
}

// Structural proof only; stored references are checked separately below. The
// content bound is caller admission, never part of an effect/replay identity.
export function verifyWorkerPatchIntegrationIntent(intent) {
  fields(intent, ["kind", "protocolVersion", "authorityBoundary", "lineage", "members", "composition", ...Object.keys(flags), "integrationId", "integrationHash"]);
  verifyArtifactAuthorityBoundary("WorkerPatchIntegrationIntent", intent.authorityBoundary);
  if (!Array.isArray(intent.members) || !intent.members.length || intent.members.some(member => !member || typeof member !== "object")) fail("Worker integration has invalid members.");
  const { integrationId, integrationHash, ...payload } = intent;
  if (intent.kind !== "WorkerPatchIntegrationIntent" || intent.protocolVersion !== "0.1.0"
    || !same(Object.fromEntries(Object.keys(flags).map(key => [key, intent[key]])), flags)
    || !same(identity(payload), intent)) fail("Worker integration identity or authority differs.");
  const format = lineageFormat(intent.lineage);
  if (!format) fail("Invalid worker integration fields.");
  fields(intent.lineage, ["projectId", "projectRootDigest", format.sessionIdField, "runId", "wholePlanId", "executionContractId", "contextCapsuleId"]);
  const seen = new Set();
  for (const [index, member] of intent.members.entries()) {
    fields(member, ["authorizationId", "authorizationHash", "inputDigest", "memberKey", "dispatchId", "dispatchHash", "lifecycleReceiptId", "draftId", "executionLeaseConsumptionId", "executionLeaseReleaseId", "actualProviderInvoked", "candidate"]);
    if (!/^execution-authorization-[a-f0-9]{24}$/.test(member.authorizationId || "")
      || index && intent.members[index - 1].authorizationId >= member.authorizationId
      || typeof member.actualProviderInvoked !== "boolean" || seen.has(member.memberKey)) fail("Duplicate, unordered, or invalid integration member.");
    seen.add(member.memberKey);
    verifyWorkerPatchCandidate(member.candidate, lineageFormat(intent.lineage));
  }
  const composition = composeWorkerPatchCandidates({ candidates: intent.members.map(member => member.candidate), maxBytes: Number.MAX_SAFE_INTEGER });
  if (composition.status !== "compatible-file-effects" || !same(composition, intent.composition)) fail("Combined patch conflicts or differs from member provenance.");
  return intent;
}

function verifyStoredReferences(root, intent) {
  const project = inspectProject(root);
  if (project.status === "not_initialized" || project.project.projectId !== intent.lineage.projectId
    || digest(fs.realpathSync(project.project.projectRoot)) !== intent.lineage.projectRootDigest) fail("Worker integration belongs to another Project.");
  const records = intent.members.map(member => {
    const current = recordMember(root, member.authorizationId, member.candidate);
    if (!same(current.member, member) || !same(binding(current.authorization), intent.lineage)) fail("Worker integration provenance differs from its exact stored records.");
    return current;
  });
  const contract = readLineageArtifact({ root, artifactId: intent.lineage.executionContractId }).artifact;
  const plan = readLineageArtifact({ root, artifactId: intent.lineage.wholePlanId }).artifact;
  const capsule = readContextCapsule({ root, capsuleId: intent.lineage.contextCapsuleId }).capsule;
  if (contract.kind !== "ExecutionContract" || plan.kind !== "WholePlanSnapshot"
    || contract.wholePlanId !== plan.wholePlanId || contract.capsuleId !== capsule.capsuleId) fail("Worker integration immutable lineage differs.");
  return records;
}

// Historical P3 reading needs no live Host paths, current sources, same Session
// or provider connection. Existing readers still verify the selected Session
// record; this is not a damaged/missing-Session bypass. No read writes a checkpoint.
export function readWorkerPatchIntegration({ root = ".", integrationId, storage } = {}) {
  const intent = verifyWorkerPatchIntegrationIntent(JSON.parse(readIntegrationBytes(integrationFile(root, integrationId, false, storage))));
  if (intent.integrationId !== integrationId) fail("Worker integration filename differs.");
  verifyStoredReferences(root, intent);
  return { status: "verified", intent, applied: false, semanticVerification: "not-assessed", ...flags };
}

export function requireCurrentWorkerPatchIntegration({ root = ".", integrationId, storage } = {}) {
  const { intent } = readWorkerPatchIntegration({ root, integrationId, storage });
  for (const { authorization } of verifyStoredReferences(root, intent)) verifyRuntimeInvocationCurrentLineage({ root, authorization });
  return intent;
}

export function validateWorkerPatchIntegrationPrepareInput({ authorizationIds, maxBytes } = {}) {
  if (!Array.isArray(authorizationIds) || !authorizationIds.length || new Set(authorizationIds).size !== authorizationIds.length
    || authorizationIds.some(id => !/^execution-authorization-[a-f0-9]{24}$/.test(id || ""))
    || !Number.isSafeInteger(maxBytes) || maxBytes < 0) fail("Integration requires distinct worker identities and a finite byte bound.");
}

// Explicit HEAD preparation is the only point where Host-frozen patches become
// durable combined P3 evidence. It does not reserve paths, apply files, mark the
// task sufficient, complete a Run, or author recovery direction.
export function prepareWorkerPatchIntegration({ root = ".", authorizationIds, maxBytes, storage } = {}, inspection = {}) {
  validateWorkerPatchIntegrationPrepareInput({ authorizationIds, maxBytes });
  return withProjectMutation({ root, scope: "session-recovery" }, () => {
    // Resolve already-published exact membership before touching P5. Cache
    // retirement cannot force another collection or execution. This is an
    // on-demand local evidence lookup, not a new persisted alias/index artifact.
    const orderedIds = [...authorizationIds].sort();
    let directory = null;
    try { directory = workerIntegrationDirectory(root, false, storage); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const matches = [];
    for (const name of directory ? fs.readdirSync(directory) : []) {
      if (!name.startsWith(membershipPrefix(orderedIds)) || !/^worker-integration-[a-f0-9]{24}--[a-f0-9]{24}\.json$/.test(name)) continue;
      const candidate = JSON.parse(readIntegrationBytes(path.join(directory, name)));
      if (same(candidate.members?.map(member => member.authorizationId), orderedIds)) matches.push(name.slice(0, -5));
    }
    if (matches.length > 1) fail("Exact worker membership has divergent integration evidence.");
    if (matches.length) {
      const intent = requireCurrentWorkerPatchIntegration({ root, integrationId: matches[0], storage });
      if (intent.composition.bytes > maxBytes) fail("Stored integration exceeds the requested content byte budget.");
      return { status: "existing", intent, persisted: true, applied: false, semanticVerification: "not-assessed", ...flags };
    }
    const records = orderedIds.map(authorizationId => {
      const frozen = readBoundedWorkerPatch({ root, authorizationId }, inspection);
      const current = recordMember(root, authorizationId, frozen.candidate);
      if (frozen.authorizationHash !== current.member.authorizationHash || frozen.inputDigest !== current.member.inputDigest
        || frozen.lifecycleReceiptId !== current.member.lifecycleReceiptId || frozen.actualProviderInvoked !== current.member.actualProviderInvoked) fail("Frozen worker patch provenance differs.");
      verifyRuntimeInvocationCurrentLineage({ root, authorization: current.authorization });
      return current;
    });
    const lineage = binding(records[0].authorization);
    if (records.some(record => !same(binding(record.authorization), lineage))
      || new Set(records.map(record => record.member.memberKey)).size !== records.length) fail("Workers do not share exact Run lineage or repeat a member.");
    const composition = composeWorkerPatchCandidates({ candidates: records.map(record => record.member.candidate), maxBytes });
    if (composition.status === "conflict") return { status: "conflict", composition, persisted: false, ...flags };
    const intent = verifyWorkerPatchIntegrationIntent(identity({ kind: "WorkerPatchIntegrationIntent", protocolVersion: "0.1.0",
      authorityBoundary: artifactAuthorityBoundary("WorkerPatchIntegrationIntent"), lineage,
      members: records.map(record => record.member), composition, ...flags }));
    const file = integrationFile(root, intent.integrationId, true, lineageFormat(intent.lineage));
    if (fs.existsSync(file)) return { ...readWorkerPatchIntegration({ root, integrationId: intent.integrationId, storage: lineageFormat(intent.lineage) }), status: "existing", persisted: true };
    // Initial capture is current. Later application must instead revalidate
    // dependencies and exact native journal state, not demand old preimages.
    for (const { authorization } of records) prepareRuntimeInvocationExecution({ root, authorization });
    publishIntegrationJson(file, intent);
    return { status: "prepared", intent, persisted: true, applied: false, semanticVerification: "not-assessed", ...flags };
  });
}

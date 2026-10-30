import { publicToolName } from "./lode-artifact-composition.mjs";
import { prepareWorkerPatchIntegration, validateWorkerPatchIntegrationPrepareInput } from "./worker-patch-integration.mjs";
import { readWorkerPatchApplication, readOutstandingWorkerEffects, applyWorkerPatchIntegration,
  reconcileWorkerPatchIntegration, settleIncompleteWorkerPatchIntegration, validateWorkerIntegrationSettlementReason } from "./worker-integration-application.mjs";
import { prepareWorkerIntegrationResult, publishWorkerIntegrationResult, readWorkerIntegrationResult } from "./worker-integration-result.mjs";

const fail = message => { throw Object.assign(new Error(message), { code: "WORKER_INTEGRATION_INPUT_INVALID" }); };
const integrationPattern = /^worker-integration-[a-f0-9]{24}--[a-f0-9]{24}$/;
const verificationPattern = /^worker-integration-verification-[a-f0-9]{24}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const actions = {
  prepare: { required: ["authorizationIds", "maxBytes"], optional: [] },
  apply: { required: ["integrationId"], optional: ["basisDigest", "retryKnownNoWrite"] },
  reconcile: { required: ["integrationId"], optional: [] },
  "settle-incomplete": { required: ["integrationId", "basisDigest", "reason"], optional: [] },
  "prepare-result": { required: ["integrationId", "basisDigest", "outcome", "evidence", "verification"], optional: ["planDelta", "impactRadius", "unknowns"] },
  "publish-result": { required: ["integrationId", "verificationId"], optional: [] },
};

function fields(input, required, optional) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("Worker integration input must be an object.");
  const allowed = new Set([...required, ...optional]);
  const unexpected = Object.keys(input).filter(key => !allowed.has(key));
  if (unexpected.length) fail(`Unsupported worker integration fields: ${unexpected.sort().join(", ")}.`);
  const missing = required.filter(key => input[key] === undefined);
  if (missing.length) fail(`Worker integration requires: ${missing.join(", ")}.`);
}
function identities(input) {
  if (input.integrationId !== undefined && (typeof input.integrationId !== "string" || !integrationPattern.test(input.integrationId))) fail("Invalid worker integration identity.");
  if (input.verificationId !== undefined && (typeof input.verificationId !== "string" || !verificationPattern.test(input.verificationId))) fail("Invalid worker integration verification identity.");
  if (input.basisDigest !== undefined && (typeof input.basisDigest !== "string" || !digestPattern.test(input.basisDigest))) fail("Invalid worker integration basis digest.");
}

export function validateWorkerIntegrationRequest(request) {
  const shape = typeof request?.action === "string" && Object.hasOwn(actions, request.action) ? actions[request.action] : null;
  if (!shape) fail("Unknown worker integration action.");
  fields(request, ["action", ...shape.required], shape.optional);
  identities(request);
  if (request.retryKnownNoWrite !== undefined && typeof request.retryKnownNoWrite !== "boolean") fail("retryKnownNoWrite must be a boolean.");
  if (request.action === "prepare") validateWorkerPatchIntegrationPrepareInput(request);
  if (request.action === "settle-incomplete") validateWorkerIntegrationSettlementReason(request.reason);
  return request;
}

// One thin public composition for CLI and MCP. The request is evidence/HEAD
// input only: no executable, transport, native selection, Host hook, or approval.
export async function operateWorkerIntegration(request, { root = ".", onProcess, storage } = {}) {
  validateWorkerIntegrationRequest(request);
  const { action, ...input } = request;
  const result = await (action === "prepare" ? prepareWorkerPatchIntegration({ ...input, root, storage }, { onProcess })
    : action === "apply" ? applyWorkerPatchIntegration({ ...input, root, storage }, { onProcess })
      : action === "reconcile" ? reconcileWorkerPatchIntegration({ ...input, root, storage }, { onProcess })
        : action === "settle-incomplete" ? settleIncompleteWorkerPatchIntegration({ ...input, root, storage })
          : action === "prepare-result" ? prepareWorkerIntegrationResult({ ...input, root, storage })
            : publishWorkerIntegrationResult({ ...input, root, storage }));
  if (!result.intent) return result;
  const { intent, ...view } = result;
  return { ...view, integration: summary(intent) };
}

const withoutContent = ({ contentBase64, ...metadata }) => metadata;
function summary(intent) {
  return {
    integrationId: intent.integrationId, integrationHash: intent.integrationHash, lineage: intent.lineage,
    members: intent.members.map(({ candidate, ...member }) => ({ ...member, candidateId: candidate.candidateId, candidateHash: candidate.candidateHash })),
    composition: { status: intent.composition.status, bytes: intent.composition.bytes,
      candidateHashes: intent.composition.candidateHashes, conflicts: intent.composition.conflicts,
      basisDiagnostics: intent.composition.basisDiagnostics,
      patches: intent.composition.patches.map(patch => ({ ...patch, before: withoutContent(patch.before), after: withoutContent(patch.after) })) },
  };
}

function resultSummary(result) {
  const verification = result.verification;
  const packet = result.resultPacket || verification?.wholeResultPacket;
  return { status: result.status, application: result.application,
    verification: verification ? {
      verificationId: verification.verificationId, verificationHash: verification.verificationHash,
      basisDigest: verification.basisDigest, observedBasisDigest: verification.observedBasisDigest,
      outcome: verification.headReport.outcome.slice(0, 500), outcomeTruncated: verification.headReport.outcome.length > 500,
      evidenceCount: verification.headReport.evidence.length, verificationCount: verification.headReport.verification.length,
      unknownCount: verification.headReport.unknowns.length,
    } : null,
    resultPacket: packet ? { resultPacketId: packet.resultPacketId, artifactHash: packet.artifactHash,
      published: Boolean(result.resultPacket),
      read: result.resultPacket ? { tool: publicToolName("head_lineage_artifact"), artifactId: packet.resultPacketId } : null } : null,
  };
}
function applicationSummary(application) {
  return { ...application, effectResults: application.effectResults.map(({ attempts, ...effect }) => ({ ...effect,
    attemptCount: attempts?.length ?? (effect.started ? 1 : 0) })) };
}

export function validateWorkerIntegrationStatusRequest(request) {
  fields(request, ["integrationId"], ["verificationId"]);
  identities(request);
  return request;
}

// On-demand P4 status. Verification remains in the existing Core readers;
// omit duplicate intents and raw patch contents, not evidence identities.
export function inspectWorkerIntegration(request, { root = ".", storage } = {}) {
  validateWorkerIntegrationStatusRequest(request);
  const { intent, ...application } = readWorkerPatchApplication({ root, integrationId: request.integrationId, storage });
  const outstandingEffects = readOutstandingWorkerEffects({ root, integrationId: request.integrationId, storage });
  const result = readWorkerIntegrationResult({ root, ...request, storage });
  return { integration: summary(intent), application: applicationSummary(application), outstandingEffects, result: resultSummary(result),
    authorityEffect: "none", instructionAuthority: false, promotionAuthority: false, recoveryAuthority: false,
    reviewDecisionCreated: false, mutatesCanon: false };
}

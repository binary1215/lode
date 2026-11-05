import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { formatForVerifiedOwner, familyFormatForOriginal, resolveProjectStorage } from "./project-storage-format.mjs";
import { safeSessionPath } from "./session-paths.mjs";
import { readLineageArtifact } from "./execution-lineage.mjs";
import { readContextCapsule } from "./context-compiler.mjs";
import { readProjectDirectionRevision } from "./project-direction.mjs";
import { MAX_REFERENCE_BYTES } from "./session-work-evidence-original.mjs";
import { runtimeInvocationInputFromOriginals, verifyRuntimeInvocationAuthorization,
  verifyRuntimeInvocationLifecycleReceipt } from "./runtime-invocation-lifecycle.mjs";

const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const code = error => /^[A-Z][A-Z0-9_]{0,95}$/u.test(error?.code || "") ? error.code : "PREPARED_INPUT_ORIGINAL_UNAVAILABLE";
const fail = reason => { throw Object.assign(new Error(reason), { code: reason }); };
const sessionOf = record => record?.[familyFormatForOriginal({ sessionIdentity: true }, record)?.sessionIdField];
const failureState = reason => reason === "ENOENT" || /NOT_FOUND$/u.test(reason) ? "missing-original"
  : reason === "PREPARED_INPUT_ORIGINAL_BOUND" ? "bounded-original"
    : /MISMATCH|INTEGRITY|DIGEST|INVALID|UNSAFE|ESCAPE|CHANGED/u.test(reason) ? "integrity-unavailable" : "unavailable";

function original(root, relative, kind, id, read, originals) {
  const reference = { kind, id, path: relative };
  try {
    const file = safeSessionPath(root, relative), stat = fs.lstatSync(file);
    if (!stat.isFile()) fail("PREPARED_INPUT_INVALID_ORIGINAL");
    if (stat.size > MAX_REFERENCE_BYTES) fail("PREPARED_INPUT_ORIGINAL_BOUND");
    const value = read();
    const bytes = fs.readFileSync(safeSessionPath(root, relative));
    if (bytes.length > MAX_REFERENCE_BYTES) fail("PREPARED_INPUT_ORIGINAL_BOUND");
    if (JSON.stringify(canonical(JSON.parse(bytes))) !== JSON.stringify(canonical(value))) fail("PREPARED_INPUT_ORIGINAL_CHANGED_DURING_READ");
    originals.push({ ...reference, status: "verified", bytes: bytes.length, digest: hash(bytes) });
    return value;
  } catch (error) {
    const reasonCode = code(error);
    originals.push({ ...reference, status: failureState(reasonCode), reasonCode });
    return null;
  }
}

function runtimeObservation(root, directory, authorization) {
  const relative = `${directory}/runtime/invocations/${authorization.authorizationId}/receipt.json`, references = [];
  // Absence of a runtime record says nothing about whether a provider saw a
  // historical input. It never authorizes replay or invents a delivery event.
  try { fs.lstatSync(safeSessionPath(root, relative)); }
  catch (error) { return { status: error.code === "ENOENT" ? "not-recorded" : "unavailable", modelUse: "unknown", reasonCode: code(error) }; }
  const receipt = original(root, relative, "RuntimeInvocationLifecycleReceipt", authorization.authorizationId,
    () => verifyRuntimeInvocationLifecycleReceipt(JSON.parse(fs.readFileSync(safeSessionPath(root, relative)))), references);
  if (!receipt) return { status: "unavailable", modelUse: "unknown", references };
  references[0].id = receipt.receiptId;
  if (receipt.authorizationId !== authorization.authorizationId || receipt.projectId !== authorization.projectId
    || sessionOf(receipt) !== sessionOf(authorization) || receipt.runtime !== authorization.runtime
    || receipt.scopeKind !== authorization.scope.kind || receipt.runId !== authorization.scope.runId
    || receipt.executionContractId !== authorization.scope.executionContractId) {
    return { status: "unavailable", reasonCode: "PREPARED_INPUT_RECEIPT_OWNER_MISMATCH", modelUse: "unknown", references };
  }
  return { status: receipt.providerBoundary.mode === "actual-provider" ? "recorded-runtime-observation" : "synthetic-runtime-observation",
    receiptId: receipt.receiptId, receiptStatus: receipt.status, providerMode: receipt.providerBoundary.mode,
    observedInputDigest: receipt.inputDigestObserved, matchesAuthorizedDigest: receipt.inputDigestObserved === authorization.executionInput.digest,
    interpretation: "Recorded runtime digest observation only; delivery to a model, attention and use are not established by it or a returned result.", modelUse: "unknown", references };
}

// Applied only by explicit CLI/MCP read/status consumers. The canonical readers
// used by dispatch, execution and result application remain unchanged.
export function withPreparedRuntimeInputView({ root = ".", value } = {}) {
  const authorization = value.authorization;
  const view = { kind: "PreparedRuntimeInputProjection", authorityPlane: "P4", persisted: false,
    instructionAuthority: false, recoveryAuthority: false, executionAuthorization: false, modelUse: "unknown",
    status: "unavailable", originals: [],
    interpretation: "Historical Core canonical prepared input, not a user transcript, complete Host/model prompt or current permission. Later records and current cancellation are not retroactively inserted. Existing execution and recovery checks remain authoritative." };
  try {
    const verified = verifyRuntimeInvocationAuthorization(authorization), storage = resolveProjectStorage(root), directory = formatForVerifiedOwner(storage).directory;
    const base = fs.realpathSync(path.resolve(root));
    const owner = JSON.parse(fs.readFileSync(safeSessionPath(base, directory, "project.json")));
    if (owner.projectId !== verified.projectId || owner.projectRoot !== base) fail("PREPARED_INPUT_PROJECT_MISMATCH");
    view.authorizationId = verified.authorizationId;
    view.expectedInput = { ...verified.executionInput };
    view.delivery = runtimeObservation(base, directory, verified);
    const selected = original(base, `${directory}/runtime/execution-authorizations/${verified.authorizationId}.json`,
      "ExecutionAuthorization", verified.authorizationId, () => verified, view.originals);
    let plan = null, contract = null, capsule = null, direction = null;
    const lineage = (id, kind, folder) => original(base, `${directory}/lineage/${folder}/${id}.json`, kind, id, () => {
      const record = readLineageArtifact({ root: base, artifactId: id }).artifact;
      // Existing plans/contracts are Project-scoped. Do not invent a missing
      // Session owner or turn historical inspection into a new execution gate.
      const declaredSession = sessionOf(record);
      if (record.kind !== kind || record.projectId !== verified.projectId
        || declaredSession !== undefined && declaredSession !== sessionOf(verified)) fail("PREPARED_INPUT_LINEAGE_OWNER_MISMATCH");
      return record;
    }, view.originals);
    if (verified.scope.kind === "run") {
      plan = lineage(verified.scope.wholePlanId, "WholePlanSnapshot", "whole-plans");
      contract = lineage(verified.scope.executionContractId, "ExecutionContract", "execution-contracts");
    }
    if (verified.scope.contextCapsuleId) capsule = original(base,
      `${directory}/context/capsules/${verified.scope.contextCapsuleId}.json`, "ContextCapsule", verified.scope.contextCapsuleId,
      () => readContextCapsule({ root: base, capsuleId: verified.scope.contextCapsuleId }).capsule, view.originals);
    if (verified.currentProjectDirectionId) direction = original(base,
      `${directory}/project-direction/revisions/${verified.currentProjectDirectionId}.json`, "ProjectDirection", verified.currentProjectDirectionId,
      () => readProjectDirectionRevision({ root: base, directionId: verified.currentProjectDirectionId, storage }), view.originals);
    const unavailable = view.originals.filter(reference => reference.status !== "verified");
    if (unavailable.length || !selected) {
      view.status = unavailable.some(reference => reference.status === "integrity-unavailable") ? "integrity-unavailable"
        : unavailable.some(reference => reference.status === "missing-original") ? "missing-original" : unavailable[0]?.status || "unavailable";
    } else {
      if (contract && (contract.wholePlanId !== plan.wholePlanId || contract.capsuleId !== capsule?.capsuleId)) fail("PREPARED_INPUT_LINEAGE_MISMATCH");
      const input = runtimeInvocationInputFromOriginals({ authorization: verified, plan, contract, capsule, direction });
      if (!input) { view.status = "selected-refs-only"; view.reasonCode = "PREPARED_INPUT_REQUEST_NOT_RETAINED"; }
      else if (input.length !== verified.executionInput.bytes || hash(input) !== verified.executionInput.digest) {
        view.status = "selected-refs-only"; view.reasonCode = "PREPARED_INPUT_RECONSTRUCTION_MISMATCH";
      } else {
        view.status = "verified-prepared-input";
        view.inputProof = { bytes: input.length, digest: hash(input), canonicalSerializationMatched: true };
        let end = Math.min(2048, input.length);
        while (end > 0 && (input[end] & 0xc0) === 0x80) end--;
        view.excerpt = { text: input.subarray(0, end).toString("utf8"), startByte: 0, endByte: end, totalBytes: input.length, omittedBytes: input.length - end };
      }
    }
  } catch (error) { view.status = failureState(code(error)); view.reasonCode = code(error); }
  return { ...value, preparedInput: view };
}

import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";
const sessionIdOf = record => {
  const format = familyFormatForOriginal({ sessionIdentity: true }, record);
  return format ? record?.[format.sessionIdField] : undefined;
};
const originalFormat = record => familyFormatForOriginal({ kind: record?.kind }, record);
import { writeRuntimeInvocationArtifactExclusive } from "./runtime-invocation-storage.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  readRuntimeInvocationAuthorization,
  verifyRuntimeEventEnvelope,
  verifyRuntimeInvocationAuthorization,
  verifyRuntimeInvocationLifecycleReceipt,
  verifyRuntimeResultPacketDraft,
} from "./runtime-invocation-lifecycle.mjs";

const fail = (message, code = "RUNTIME_INVOCATION_RECORD_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(compareText).map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

const canonicalJson = (value) => JSON.stringify(canonicalValue(value));
const prettyJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function validateAuthorizationId(authorizationId) {
  if (!/^execution-authorization-[a-f0-9]{24}$/.test(authorizationId || "")) {
    fail("Runtime invocation authorization id is invalid.", "INVALID_RUNTIME_INVOCATION_AUTHORIZATION_ID");
  }
  return authorizationId;
}

export { validateAuthorizationId as validateRuntimeInvocationRecordIdentity };

export function runtimeInvocationRecordDirectory(projectRoot, authorizationId, storage = undefined) {
  validateAuthorizationId(authorizationId);
  return path.join(projectRoot, formatForVerifiedOwner(storage).directory, "runtime", "invocations", authorizationId);
}

export { writeRuntimeInvocationArtifactExclusive } from "./runtime-invocation-storage.mjs";

function verifyRecordLineage({ authorization, receipt, draft, events }) {
  const verifiedAuthorization = verifyRuntimeInvocationAuthorization(authorization);
  const verifiedReceipt = verifyRuntimeInvocationLifecycleReceipt(receipt);
  const verifiedDraft = verifyRuntimeResultPacketDraft(draft, { authorization: verifiedAuthorization });
  const result = verifiedDraft.providerResult;
  const resultJson = result === null ? "" : canonicalJson(result);
  const verifiedEvents = events.map((event) => verifyRuntimeEventEnvelope(event));
  const eventIds = verifiedEvents.map((event) => event.eventId).sort(compareText);
  const eventSequences = verifiedEvents.map((event) => event.sequence);
  if (verifiedReceipt.authorizationId !== verifiedAuthorization.authorizationId
    || verifiedReceipt.projectId !== verifiedAuthorization.projectId
    || sessionIdOf(verifiedReceipt) !== sessionIdOf(verifiedAuthorization)
    || verifiedReceipt.runtime !== verifiedAuthorization.runtime
    || verifiedReceipt.scopeKind !== verifiedAuthorization.scope.kind
    || verifiedReceipt.runId !== verifiedAuthorization.scope.runId
    || verifiedReceipt.executionContractId !== verifiedAuthorization.scope.executionContractId
    || verifiedDraft.authorizationId !== verifiedAuthorization.authorizationId
    || verifiedDraft.lifecycleReceiptId !== verifiedReceipt.receiptId
    || verifiedDraft.executionLeaseConsumptionId !== verifiedReceipt.executionLeaseConsumptionId
    || verifiedDraft.scopeKind !== verifiedAuthorization.scope.kind
    || verifiedDraft.runId !== verifiedAuthorization.scope.runId
    || verifiedDraft.executionContractId !== verifiedAuthorization.scope.executionContractId
    || verifiedReceipt.providerBoundary.structuredResultObserved !== (result !== null)
    || verifiedReceipt.providerBoundary.structuredResultDigest !== (result === null ? "" : crypto.createHash("sha256").update(resultJson).digest("hex"))
    || verifiedReceipt.providerBoundary.structuredResultBytes !== Buffer.byteLength(resultJson)
    || verifiedAuthorization.protocolVersion === "0.7.0" && verifiedReceipt.status === "completed" && result === null
    || canonicalJson(eventIds) !== canonicalJson(verifiedReceipt.eventIds)
    || canonicalJson(verifiedDraft.evidence[0].eventIds) !== canonicalJson(verifiedReceipt.eventIds)
    || verifiedEvents.some((event) => event.authorizationId !== verifiedAuthorization.authorizationId
      || event.runtime !== verifiedAuthorization.runtime)
    || new Set(eventSequences).size !== eventSequences.length) {
    fail("Runtime invocation record lineage is inconsistent.", "RUNTIME_INVOCATION_RECORD_CONFLICT");
  }
  return { authorization: verifiedAuthorization, receipt: verifiedReceipt, draft: verifiedDraft, events: verifiedEvents };
}

function verifyRecordDirectory(projectRoot, authorizationId, storage) {
  const directory = runtimeInvocationRecordDirectory(projectRoot, authorizationId, storage);
  if (!fs.existsSync(directory)) fail("Runtime invocation result is not recorded.", "RUNTIME_INVOCATION_RESULT_NOT_FOUND");
  const stat = fs.lstatSync(directory);
  const resolvedDirectory = fs.realpathSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !isWithin(projectRoot, resolvedDirectory)) {
    fail("Runtime invocation record path is unsafe.", "UNSAFE_RUNTIME_INVOCATION_RECORD");
  }
  return resolvedDirectory;
}

export function persistRuntimeInvocationRecord({ projectRoot, authorization, events, receipt, draft, storage }) {
  const preparedRoot = fs.realpathSync(path.resolve(projectRoot));
  const verified = verifyRecordLineage({ authorization, receipt, draft, events });
  const directory = runtimeInvocationRecordDirectory(preparedRoot, verified.authorization.authorizationId, storage ?? originalFormat(verified.authorization));
  if (fs.existsSync(directory)) fail("Runtime invocation record already exists.", "RUNTIME_INVOCATION_RECORD_EXISTS");
  const base = path.dirname(directory);
  fs.mkdirSync(base, { recursive: true });
  const baseStat = fs.lstatSync(base);
  const resolvedBase = fs.realpathSync(base);
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink() || !isWithin(preparedRoot, resolvedBase)) {
    fail("Runtime invocation record base is unsafe.", "UNSAFE_RUNTIME_INVOCATION_RECORD");
  }
  const temporary = path.join(base, `.${verified.authorization.authorizationId}.${crypto.randomUUID()}.tmp`);
  fs.mkdirSync(temporary, { recursive: false });
  try {
    for (const event of [...verified.events].sort((left, right) => left.sequence - right.sequence)) {
      writeRuntimeInvocationArtifactExclusive(
        path.join(temporary, `event-${String(event.sequence).padStart(6, "0")}-${event.eventId}.json`),
        prettyJson(event),
      );
    }
    writeRuntimeInvocationArtifactExclusive(path.join(temporary, "receipt.json"), prettyJson(verified.receipt));
    writeRuntimeInvocationArtifactExclusive(path.join(temporary, "draft.json"), prettyJson(verified.draft));
    fs.renameSync(temporary, directory);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true });
  }
  return {
    recorded: true,
    eventCount: verified.events.length,
    receiptId: verified.receipt.receiptId,
    draftId: verified.draft.draftId,
  };
}

export function readRuntimeInvocationRecord({ root = ".", authorizationId, storage } = {}) {
  validateAuthorizationId(authorizationId);
  const projectRoot = fs.realpathSync(path.resolve(root));
  const directory = verifyRecordDirectory(projectRoot, authorizationId, storage);
  const authorization = readRuntimeInvocationAuthorization({ root: projectRoot, authorizationId }).authorization;
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, "receipt.json"), "utf8"));
  const draft = JSON.parse(fs.readFileSync(path.join(directory, "draft.json"), "utf8"));
  const events = fs.readdirSync(directory)
    .filter((item) => /^event-[0-9]{6}-runtime-event-[a-f0-9]{24}\.json$/.test(item))
    .sort(compareText)
    .map((item) => JSON.parse(fs.readFileSync(path.join(directory, item), "utf8")));
  const verified = verifyRecordLineage({ authorization, receipt, draft, events });
  return {
    status: "verified",
    projectRoot,
    directory,
    storage,
    authorizationId,
    ...verified,
  };
}

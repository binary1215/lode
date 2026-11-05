import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";
const sessionIdOf = record => {
  const format = familyFormatForOriginal({ sessionIdentity: true }, record);
  return format ? record?.[format.sessionIdField] : undefined;
};
const originalFormat = record => familyFormatForOriginal({ kind: record?.kind }, record);
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { inspectProject } from "./lode-core.mjs";
import { readBoundedWorkerDispatch } from "./bounded-worker-dispatch.mjs";
import {
  createRuntimePreConsumeGateCapability,
  inspectRuntimeExecutionLease,
} from "./runtime-execution-lease.mjs";
import { readRuntimeInvocationAuthorization } from "./runtime-invocation-lifecycle.mjs";
import { readRuntimeInvocationResult } from "./runtime-run-result-application.mjs";

export const WORKER_ADMISSION_VERSION = "0.1.0";

const DOMAIN_ID = /^worker-admission-domain-[a-f0-9]{24}$/;
const INSTANCE_ID = /^worker-admission-instance-[a-f0-9]{24}$/;
const HASH = /^[a-f0-9]{64}$/;
const REQUEST_ID = /^worker-admission-request-[a-f0-9]{24}$/;
const MODES = new Set(["attached", "detached"]);
const TERMINAL_STATES = new Set(["cancelled", "expired", "released"]);
const EVENT_TYPES = new Set(["queued", "resumed", "reserved", "start-committed", "cancelled", "expired", "released", "unknown-blocking"]);
const hostState = new WeakMap();

const fail = (message, code = "WORKER_ADMISSION_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort(compareText).map((key) => [key, canonical(value[key])]))
    : value;
const canonicalJson = (value) => JSON.stringify(canonical(value));
const pretty = (value) => `${JSON.stringify(value, null, 2)}\n`;
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const identity = (prefix, payload) => `${prefix}-${digest(canonicalJson(payload)).slice(0, 24)}`;

function exactFields(value, fields, label, code = "INVALID_WORKER_ADMISSION_ARTIFACT") {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...fields].sort())) {
    fail(`${label} fields are invalid.`, code);
  }
}

function readJson(file, label, code = "INVALID_WORKER_ADMISSION_ARTIFACT") {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { fail(`${label} is not valid JSON: ${error.message}`, code); }
}

function writeExclusive(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, pretty(value), { encoding: "utf8", flag: "wx" });
}

function normalizeRoot(value, label, { create = false } = {}) {
  if (typeof value !== "string" || !path.isAbsolute(value)) fail(`${label} must be an absolute path.`, "INVALID_WORKER_ADMISSION_ROOT");
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) fail(`${label} cannot be a filesystem root.`, "INVALID_WORKER_ADMISSION_ROOT");
  if (create) fs.mkdirSync(resolved, { recursive: true });
  if (!fs.existsSync(resolved)) fail(`${label} does not exist.`, "WORKER_ADMISSION_DOMAIN_UNAVAILABLE");
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} is unsafe.`, "INVALID_WORKER_ADMISSION_ROOT");
  return fs.realpathSync(resolved);
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function verifySafeDirectoryChain(root, directory, label, { create = false } = {}) {
  const expectedRoot = fs.realpathSync(root);
  const target = path.resolve(directory);
  if (!isWithin(expectedRoot, target)) fail(`${label} escapes its configured Host root.`, "WORKER_ADMISSION_PATH_ESCAPE");
  const relative = path.relative(expectedRoot, target);
  let cursor = expectedRoot;
  for (const segment of relative ? relative.split(path.sep) : []) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) {
      if (!create) fail(`${label} is missing.`, "WORKER_ADMISSION_DOMAIN_UNAVAILABLE");
      fs.mkdirSync(cursor, { recursive: false });
    }
    const stat = fs.lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} contains an unsafe directory.`, "WORKER_ADMISSION_PATH_ESCAPE");
    const actual = fs.realpathSync(cursor);
    if (!isWithin(expectedRoot, actual)) fail(`${label} resolves outside its configured Host root.`, "WORKER_ADMISSION_PATH_ESCAPE");
  }
  return target;
}

function verifyStorageTopology({ operational, expectation, paths }, { createBases = false } = {}) {
  verifySafeDirectoryChain(operational, paths.operationalBase, "Worker admission operational storage", { create: createBases });
  verifySafeDirectoryChain(expectation, paths.expectationBase, "Worker admission expectation storage", { create: createBases });
  for (const [root, directory, label] of [
    [operational, path.dirname(paths.domain), "Worker admission operational domains"],
    [expectation, path.dirname(paths.expectation), "Worker admission expectation domains"],
  ]) {
    verifySafeDirectoryChain(root, directory, label, { create: createBases });
  }
  for (const [root, directory, label] of [
    [operational, paths.domain, "Worker admission domain"],
    [operational, path.join(paths.domain, "events"), "Worker admission event storage"],
    [expectation, paths.expectation, "Worker admission expectation"],
    [expectation, path.join(paths.expectation, "event-commits"), "Worker admission event commits"],
  ]) {
    if (fs.existsSync(directory)) verifySafeDirectoryChain(root, directory, label);
  }
}

function validateRootSeparation(operationalStateRoot, hostExpectationRoot, projectRoot = null) {
  if (operationalStateRoot === hostExpectationRoot
    || isWithin(operationalStateRoot, hostExpectationRoot)
    || isWithin(hostExpectationRoot, operationalStateRoot)) {
    fail("Worker admission operational and expectation roots must be separate.", "WORKER_ADMISSION_ROOT_CONFLICT");
  }
  if (projectRoot) {
    const project = fs.realpathSync(path.resolve(projectRoot));
    for (const root of [operationalStateRoot, hostExpectationRoot]) {
      if (isWithin(project, root) || isWithin(root, project)) {
        fail("Worker admission Host state must remain outside the project.", "WORKER_ADMISSION_PROJECT_ROOT_CONFLICT");
      }
    }
  }
}

function normalizePolicy(value) {
  exactFields(value, ["globalLimit", "perKeyLimit", "default", "maxQueued", "maxWaitMs"], "Worker admission policy", "INVALID_WORKER_ADMISSION_POLICY");
  const policy = {
    globalLimit: Number(value.globalLimit),
    perKeyLimit: Number(value.perKeyLimit),
    default: String(value.default || ""),
    maxQueued: Number(value.maxQueued),
    maxWaitMs: Number(value.maxWaitMs),
  };
  if (!Number.isSafeInteger(policy.globalLimit) || policy.globalLimit < 1 || policy.globalLimit > 64
    || !Number.isSafeInteger(policy.perKeyLimit) || policy.perKeyLimit < 1 || policy.perKeyLimit > policy.globalLimit
    || policy.default !== "hold-for-host-confirmation"
    || !Number.isSafeInteger(policy.maxQueued) || policy.maxQueued < 1 || policy.maxQueued > 1024
    || !Number.isSafeInteger(policy.maxWaitMs) || policy.maxWaitMs < 1_000 || policy.maxWaitMs > 86_400_000) {
    fail("Worker admission policy is outside its bounded Host contract.", "INVALID_WORKER_ADMISSION_POLICY");
  }
  return Object.freeze(policy);
}

function domainPaths(operationalStateRoot, hostExpectationRoot, domainId) {
  if (!DOMAIN_ID.test(domainId || "")) fail("Worker admission domain id is invalid.", "INVALID_WORKER_ADMISSION_DOMAIN_ID");
  const operationalBase = path.join(operationalStateRoot, "worker-admission");
  const expectationBase = path.join(hostExpectationRoot, "worker-admission");
  return {
    operationalBase,
    expectationBase,
    domain: path.join(operationalBase, "domains", domainId),
    stagingBase: path.join(operationalBase, "staging"),
    expectation: path.join(expectationBase, "domains", domainId),
    provisionLock: path.join(expectationBase, "provision.lock"),
  };
}

function lockIdentity(stat) {
  return Object.freeze({ device: String(stat.dev), inode: String(stat.ino) });
}

function sameLockIdentity(left, right) {
  return left.device === right.device && left.inode === right.inode;
}

function lockOwnerDocument(token) {
  const payload = {
    schemaVersion: 1,
    kind: "WorkerAdmissionDirectoryLockOwner",
    protocolVersion: WORKER_ADMISSION_VERSION,
    token,
    authority: "host-operational-lock-only",
    recoveryAuthority: false,
    instructionAuthority: false,
    reviewAuthority: false,
    promotionAuthority: false,
    mutatesCanon: false,
  };
  return { ...payload, ownerHash: digest(canonicalJson(payload)) };
}

function acquireDirectoryLock(directory, code = "WORKER_ADMISSION_DOMAIN_BUSY") {
  try { fs.mkdirSync(directory); }
  catch (error) {
    if (error.code === "EEXIST") fail("Worker admission domain is busy or has an unresolved Host lock.", code);
    throw error;
  }
  const ownerFile = path.join(directory, "owner.json");
  const owner = lockOwnerDocument(crypto.randomBytes(32).toString("hex"));
  try {
    writeExclusive(ownerFile, owner);
  } catch (error) {
    try { fs.rmdirSync(directory); } catch {}
    throw error;
  }
  const acquiredDirectoryIdentity = lockIdentity(fs.lstatSync(directory, { bigint: true }));
  const acquiredOwnerIdentity = lockIdentity(fs.lstatSync(ownerFile, { bigint: true }));
  let open = true;
  const assertOwned = () => {
    let directoryStat;
    let ownerStat;
    try {
      directoryStat = fs.lstatSync(directory, { bigint: true });
      ownerStat = fs.lstatSync(ownerFile, { bigint: true });
    } catch {
      fail("Worker admission lock ownership is missing.", "WORKER_ADMISSION_LOCK_OWNERSHIP_LOST");
    }
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
      || !ownerStat.isFile() || ownerStat.isSymbolicLink()
      || !sameLockIdentity(acquiredDirectoryIdentity, lockIdentity(directoryStat))
      || !sameLockIdentity(acquiredOwnerIdentity, lockIdentity(ownerStat))
      || canonicalJson(readJson(ownerFile, "Worker admission lock owner", "WORKER_ADMISSION_LOCK_OWNERSHIP_LOST")) !== canonicalJson(owner)) {
      fail("Worker admission lock is owned by another acquisition.", "WORKER_ADMISSION_LOCK_OWNERSHIP_LOST");
    }
  };
  const release = () => {
    if (!open) return;
    assertOwned();
    fs.unlinkSync(ownerFile);
    let directoryStat;
    try { directoryStat = fs.lstatSync(directory, { bigint: true }); }
    catch { fail("Worker admission lock changed during release.", "WORKER_ADMISSION_LOCK_OWNERSHIP_LOST"); }
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
      || !sameLockIdentity(acquiredDirectoryIdentity, lockIdentity(directoryStat))) {
      fail("Worker admission lock changed during release.", "WORKER_ADMISSION_LOCK_OWNERSHIP_LOST");
    }
    fs.rmdirSync(directory);
    open = false;
  };
  return Object.freeze({ assertOwned, release });
}

function metadataDocument({ domainId, instanceId, policy }) {
  const payload = {
    schemaVersion: 1,
    kind: "WorkerAdmissionDomainMetadata",
    protocolVersion: WORKER_ADMISSION_VERSION,
    domainId,
    domainInstanceId: instanceId,
    policy,
    policyHash: digest(canonicalJson(policy)),
    restartPolicy: "hold-for-host-confirmation",
    authority: "host-operational-capacity-only",
    recoveryAuthority: false,
    instructionAuthority: false,
    reviewAuthority: false,
    promotionAuthority: false,
    mutatesCanon: false,
  };
  return { ...payload, metadataHash: digest(canonicalJson(payload)) };
}

function verifyMetadata(value) {
  exactFields(value, [
    "schemaVersion", "kind", "protocolVersion", "domainId", "domainInstanceId", "policy", "policyHash",
    "restartPolicy", "authority", "recoveryAuthority", "instructionAuthority", "reviewAuthority",
    "promotionAuthority", "mutatesCanon", "metadataHash",
  ], "Worker admission metadata");
  const payload = { ...value };
  delete payload.metadataHash;
  const policy = normalizePolicy(value.policy);
  if (value.schemaVersion !== 1 || value.kind !== "WorkerAdmissionDomainMetadata"
    || value.protocolVersion !== WORKER_ADMISSION_VERSION || !DOMAIN_ID.test(value.domainId || "")
    || !INSTANCE_ID.test(value.domainInstanceId || "") || value.policyHash !== digest(canonicalJson(policy))
    || value.restartPolicy !== "hold-for-host-confirmation" || value.authority !== "host-operational-capacity-only"
    || value.recoveryAuthority !== false || value.instructionAuthority !== false || value.reviewAuthority !== false
    || value.promotionAuthority !== false || value.mutatesCanon !== false
    || value.metadataHash !== digest(canonicalJson(payload))) {
    fail("Worker admission metadata is invalid.", "INVALID_WORKER_ADMISSION_METADATA");
  }
  return { ...value, policy };
}

function genesisDocument(metadata) {
  const payload = {
    schemaVersion: 1,
    kind: "WorkerAdmissionGenesis",
    protocolVersion: WORKER_ADMISSION_VERSION,
    domainId: metadata.domainId,
    domainInstanceId: metadata.domainInstanceId,
    metadataHash: metadata.metadataHash,
    sequence: 0,
    previousEventHash: null,
    authority: "host-operational-capacity-only",
    recoveryAuthority: false,
    mutatesCanon: false,
  };
  return { ...payload, genesisHash: digest(canonicalJson(payload)) };
}

function verifyGenesis(value, metadata) {
  exactFields(value, ["schemaVersion", "kind", "protocolVersion", "domainId", "domainInstanceId", "metadataHash", "sequence", "previousEventHash", "authority", "recoveryAuthority", "mutatesCanon", "genesisHash"], "Worker admission genesis");
  const expected = genesisDocument(metadata);
  if (canonicalJson(value) !== canonicalJson(expected)) fail("Worker admission genesis does not match metadata.", "WORKER_ADMISSION_GENESIS_CONFLICT");
  return value;
}

function expectationIntent(metadata) {
  const payload = {
    schemaVersion: 1,
    kind: "WorkerAdmissionProvisionIntent",
    protocolVersion: WORKER_ADMISSION_VERSION,
    domainId: metadata.domainId,
    domainInstanceId: metadata.domainInstanceId,
    metadataHash: metadata.metadataHash,
    policyHash: metadata.policyHash,
    authority: "host-expectation-only",
    recoveryAuthority: false,
    mutatesCanon: false,
  };
  return { ...payload, intentHash: digest(canonicalJson(payload)) };
}

function provisionCommit(metadata, genesis, intent) {
  const payload = {
    schemaVersion: 1,
    kind: "WorkerAdmissionProvisionCommit",
    protocolVersion: WORKER_ADMISSION_VERSION,
    domainId: metadata.domainId,
    domainInstanceId: metadata.domainInstanceId,
    metadataHash: metadata.metadataHash,
    genesisHash: genesis.genesisHash,
    intentHash: intent.intentHash,
    authority: "host-expectation-only",
    recoveryAuthority: false,
    mutatesCanon: false,
  };
  return { ...payload, commitHash: digest(canonicalJson(payload)) };
}

function journalHeadDocument(metadata, sequence, eventHash) {
  const payload = {
    schemaVersion: 1,
    kind: "WorkerAdmissionJournalHead",
    protocolVersion: WORKER_ADMISSION_VERSION,
    domainId: metadata.domainId,
    domainInstanceId: metadata.domainInstanceId,
    metadataHash: metadata.metadataHash,
    sequence,
    eventHash,
    authority: "host-expectation-loss-detection-only",
    recoveryAuthority: false,
    instructionAuthority: false,
    reviewAuthority: false,
    promotionAuthority: false,
    mutatesCanon: false,
  };
  return { ...payload, headHash: digest(canonicalJson(payload)) };
}

function verifyJournalHead(value, metadata) {
  exactFields(value, [
    "schemaVersion", "kind", "protocolVersion", "domainId", "domainInstanceId", "metadataHash",
    "sequence", "eventHash", "authority", "recoveryAuthority", "instructionAuthority",
    "reviewAuthority", "promotionAuthority", "mutatesCanon", "headHash",
  ], "Worker admission journal head");
  const payload = { ...value };
  delete payload.headHash;
  if (value.schemaVersion !== 1 || value.kind !== "WorkerAdmissionJournalHead"
    || value.protocolVersion !== WORKER_ADMISSION_VERSION || value.domainId !== metadata.domainId
    || value.domainInstanceId !== metadata.domainInstanceId || value.metadataHash !== metadata.metadataHash
    || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || !HASH.test(value.eventHash || "")
    || value.authority !== "host-expectation-loss-detection-only" || value.recoveryAuthority !== false
    || value.instructionAuthority !== false || value.reviewAuthority !== false
    || value.promotionAuthority !== false || value.mutatesCanon !== false
    || value.headHash !== digest(canonicalJson(payload))) {
    fail("Worker admission journal head is invalid.", "WORKER_ADMISSION_JOURNAL_UNAVAILABLE");
  }
  return value;
}

function verifyProvisionArtifacts(paths, expectedInstanceId, expectedMetadataHash) {
  const files = {
    metadata: path.join(paths.domain, "metadata.json"),
    genesis: path.join(paths.domain, "genesis.json"),
    intent: path.join(paths.expectation, "provision-intent.json"),
    commit: path.join(paths.expectation, "provision-commit.json"),
    head: path.join(paths.expectation, "journal-head.json"),
  };
  if (Object.values(files).some((file) => !fs.existsSync(file))) {
    fail("Worker admission provisioning is partial or lost.", "WORKER_ADMISSION_DOMAIN_UNAVAILABLE");
  }
  for (const [label, directory] of [["operational domain", paths.domain], ["Host expectation", paths.expectation]]) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`Worker admission ${label} directory is unsafe.`, "WORKER_ADMISSION_DOMAIN_UNAVAILABLE");
  }
  for (const file of Object.values(files)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("Worker admission provisioning artifact is unsafe.", "WORKER_ADMISSION_DOMAIN_UNAVAILABLE");
  }
  const metadata = verifyMetadata(readJson(files.metadata, "Worker admission metadata"));
  if (metadata.domainInstanceId !== expectedInstanceId || metadata.metadataHash !== expectedMetadataHash) {
    fail("Worker admission domain identity does not match Host expectation.", "WORKER_ADMISSION_DOMAIN_IDENTITY_CONFLICT");
  }
  const genesis = verifyGenesis(readJson(files.genesis, "Worker admission genesis"), metadata);
  verifyJournalHead(readJson(files.head, "Worker admission journal head"), metadata);
  const intent = expectationIntent(metadata);
  const storedIntent = readJson(files.intent, "Worker admission provision intent");
  if (canonicalJson(storedIntent) !== canonicalJson(intent)) fail("Worker admission provision intent conflicts with metadata.", "WORKER_ADMISSION_PROVISION_CONFLICT");
  const commit = provisionCommit(metadata, genesis, intent);
  const storedCommit = readJson(files.commit, "Worker admission provision commit");
  if (canonicalJson(storedCommit) !== canonicalJson(commit)) fail("Worker admission provision commit conflicts with metadata.", "WORKER_ADMISSION_PROVISION_CONFLICT");
  return { metadata, genesis, intent, commit };
}

export function provisionWorkerAdmissionDomain({
  operationalStateRoot,
  hostExpectationRoot,
  newAdmissionDomainId,
  policy,
} = {}) {
  const operational = normalizeRoot(operationalStateRoot, "Worker admission operational root", { create: true });
  const expectation = normalizeRoot(hostExpectationRoot, "Worker admission expectation root", { create: true });
  validateRootSeparation(operational, expectation);
  const selectedPolicy = normalizePolicy(policy);
  const paths = domainPaths(operational, expectation, newAdmissionDomainId);
  verifyStorageTopology({ operational, expectation, paths }, { createBases: true });
  const provisionLock = acquireDirectoryLock(paths.provisionLock, "WORKER_ADMISSION_PROVISION_BUSY");
  let staging = null;
  try {
    if (fs.existsSync(paths.domain) || fs.existsSync(paths.expectation)) {
      fail("Worker admission domain ids are create-only and cannot be reprovisioned.", "WORKER_ADMISSION_DOMAIN_ALREADY_EXISTS");
    }
    const instanceId = `worker-admission-instance-${crypto.randomBytes(12).toString("hex")}`;
    const metadata = metadataDocument({ domainId: newAdmissionDomainId, instanceId, policy: selectedPolicy });
    const genesis = genesisDocument(metadata);
    const intent = expectationIntent(metadata);
    verifyStorageTopology({ operational, expectation, paths }, { createBases: true });
    fs.mkdirSync(paths.expectation, { recursive: false });
    verifySafeDirectoryChain(expectation, paths.expectation, "Worker admission expectation");
    writeExclusive(path.join(paths.expectation, "provision-intent.json"), intent);
    verifySafeDirectoryChain(operational, paths.stagingBase, "Worker admission staging storage", { create: true });
    staging = path.join(paths.stagingBase, `${newAdmissionDomainId}.${instanceId}`);
    fs.mkdirSync(staging, { recursive: false });
    verifySafeDirectoryChain(operational, staging, "Worker admission staging domain");
    writeExclusive(path.join(staging, "metadata.json"), metadata);
    writeExclusive(path.join(staging, "genesis.json"), genesis);
    fs.mkdirSync(path.join(staging, "events"));
    fs.renameSync(staging, paths.domain);
    staging = null;
    verifyStorageTopology({ operational, expectation, paths });
    writeExclusive(path.join(paths.expectation, "journal-head.json"), journalHeadDocument(metadata, 0, genesis.genesisHash));
    const commit = provisionCommit(metadata, genesis, intent);
    writeExclusive(path.join(paths.expectation, "provision-commit.json"), commit);
    return {
      status: "worker_admission_domain_provisioned",
      admissionDomainId: metadata.domainId,
      domainInstanceId: metadata.domainInstanceId,
      metadataHash: metadata.metadataHash,
      policyHash: metadata.policyHash,
    };
  } finally {
    if (staging && fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    provisionLock.release();
  }
}

function requireHost(host) {
  const state = hostState.get(host);
  if (!state) fail("Worker admission requires an opened Host capability.", "INVALID_WORKER_ADMISSION_HOST");
  return state;
}

export function openWorkerAdmissionHost({
  operationalStateRoot,
  hostExpectationRoot,
  admissionDomainId,
  expectedDomainInstanceId,
  expectedMetadataHash,
  preStartValidate = null,
} = {}) {
  const operational = normalizeRoot(operationalStateRoot, "Worker admission operational root");
  const expectation = normalizeRoot(hostExpectationRoot, "Worker admission expectation root");
  validateRootSeparation(operational, expectation);
  if (!INSTANCE_ID.test(expectedDomainInstanceId || "") || !HASH.test(expectedMetadataHash || "")) {
    fail("Worker admission expected identity is invalid.", "INVALID_WORKER_ADMISSION_EXPECTATION");
  }
  if (preStartValidate !== null && typeof preStartValidate !== "function") {
    fail("Worker admission pre-start validator must be a Host function.", "INVALID_WORKER_ADMISSION_VALIDATOR");
  }
  const paths = domainPaths(operational, expectation, admissionDomainId);
  verifyStorageTopology({ operational, expectation, paths });
  const verified = verifyProvisionArtifacts(paths, expectedDomainInstanceId, expectedMetadataHash);
  const openedState = { operational, expectation, paths, ...verified, preStartValidate };
  readJournal(openedState);
  const host = Object.freeze(Object.create(null));
  hostState.set(host, openedState);
  return host;
}

function eventFile(paths, sequence) {
  return path.join(paths.domain, "events", `${String(sequence).padStart(10, "0")}.json`);
}

function markerFile(paths, sequence) {
  return path.join(paths.expectation, "event-commits", `${String(sequence).padStart(10, "0")}.json`);
}

function eventDocument(state, previousHash, sequence, input) {
  const payload = {
    schemaVersion: 1,
    kind: "WorkerAdmissionEvent",
    protocolVersion: WORKER_ADMISSION_VERSION,
    domainId: state.metadata.domainId,
    domainInstanceId: state.metadata.domainInstanceId,
    policyHash: state.metadata.policyHash,
    sequence,
    previousEventHash: previousHash,
    eventType: input.eventType,
    requestId: input.requestId,
    authorizationId: input.authorizationId,
    dispatchId: input.dispatchId,
    capacityKey: input.capacityKey,
    generation: input.generation,
    ownerFenceDigest: input.ownerFenceDigest ?? null,
    details: input.details || {},
    authority: "host-operational-capacity-evidence-only",
    recoveryAuthority: false,
    instructionAuthority: false,
    reviewAuthority: false,
    promotionAuthority: false,
    mutatesCanon: false,
  };
  return { ...payload, eventHash: digest(canonicalJson(payload)) };
}

function verifyEvent(event, state, previousHash, expectedSequence) {
  exactFields(event, [
    "schemaVersion", "kind", "protocolVersion", "domainId", "domainInstanceId", "policyHash", "sequence",
    "previousEventHash", "eventType", "requestId", "authorizationId", "dispatchId", "capacityKey", "generation",
    "ownerFenceDigest", "details", "authority", "recoveryAuthority", "instructionAuthority", "reviewAuthority",
    "promotionAuthority", "mutatesCanon", "eventHash",
  ], "Worker admission event");
  const payload = { ...event };
  delete payload.eventHash;
  if (event.schemaVersion !== 1 || event.kind !== "WorkerAdmissionEvent" || event.protocolVersion !== WORKER_ADMISSION_VERSION
    || event.domainId !== state.metadata.domainId || event.domainInstanceId !== state.metadata.domainInstanceId
    || event.policyHash !== state.metadata.policyHash || event.sequence !== expectedSequence
    || event.previousEventHash !== previousHash || !EVENT_TYPES.has(event.eventType) || !REQUEST_ID.test(event.requestId || "")
    || !/^execution-authorization-[a-f0-9]{24}$/.test(event.authorizationId || "")
    || !/^bounded-worker-dispatch-[a-f0-9]{24}$/.test(event.dispatchId || "")
    || typeof event.capacityKey !== "string" || !event.capacityKey || Buffer.byteLength(event.capacityKey) > 384
    || !Number.isSafeInteger(event.generation) || event.generation < 1
    || event.ownerFenceDigest !== null && !HASH.test(event.ownerFenceDigest)
    || !event.details || typeof event.details !== "object" || Array.isArray(event.details)
    || event.authority !== "host-operational-capacity-evidence-only" || event.recoveryAuthority !== false
    || event.instructionAuthority !== false || event.reviewAuthority !== false || event.promotionAuthority !== false
    || event.mutatesCanon !== false || event.eventHash !== digest(canonicalJson(payload))) {
    fail("Worker admission event is invalid.", "INVALID_WORKER_ADMISSION_EVENT");
  }
  return event;
}

function markerDocument(state, event) {
  const payload = {
    schemaVersion: 1,
    kind: "WorkerAdmissionEventCommit",
    protocolVersion: WORKER_ADMISSION_VERSION,
    domainId: state.metadata.domainId,
    domainInstanceId: state.metadata.domainInstanceId,
    sequence: event.sequence,
    eventHash: event.eventHash,
    authority: "host-expectation-only",
    recoveryAuthority: false,
    mutatesCanon: false,
  };
  return { ...payload, markerHash: digest(canonicalJson(payload)) };
}

function updateJournalHead(state, sequence, eventHash) {
  const file = path.join(state.paths.expectation, "journal-head.json");
  let stat;
  try { stat = fs.lstatSync(file); }
  catch { fail("Worker admission journal head is missing.", "WORKER_ADMISSION_JOURNAL_UNAVAILABLE"); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail("Worker admission journal head is unsafe.", "WORKER_ADMISSION_JOURNAL_UNAVAILABLE");
  fs.writeFileSync(file, pretty(journalHeadDocument(state.metadata, sequence, eventHash)), { encoding: "utf8", flag: "w" });
}

function readJournal(state) {
  verifyStorageTopology(state);
  verifyProvisionArtifacts(state.paths, state.metadata.domainInstanceId, state.metadata.metadataHash);
  const eventDirectory = path.join(state.paths.domain, "events");
  const markerDirectory = path.join(state.paths.expectation, "event-commits");
  let eventNames;
  let markerNames;
  try {
    const allEvents = fs.existsSync(eventDirectory) ? fs.readdirSync(eventDirectory) : [];
    const allMarkers = fs.existsSync(markerDirectory) ? fs.readdirSync(markerDirectory) : [];
    if (allEvents.some((name) => !/^\d{10}\.json$/.test(name)) || allMarkers.some((name) => !/^\d{10}\.json$/.test(name))) {
      fail("Worker admission journal contains an unexpected entry.", "WORKER_ADMISSION_JOURNAL_UNAVAILABLE");
    }
    eventNames = allEvents.sort();
    markerNames = allMarkers.sort();
  } catch {
    fail("Worker admission journal storage is missing or unsafe.", "WORKER_ADMISSION_JOURNAL_UNAVAILABLE");
  }
  if (canonicalJson(eventNames) !== canonicalJson(markerNames)) {
    fail("Worker admission journal and expectation commits are incomplete.", "WORKER_ADMISSION_JOURNAL_UNAVAILABLE");
  }
  const events = [];
  let previousHash = state.genesis.genesisHash;
  for (let index = 0; index < eventNames.length; index += 1) {
    const sequence = index + 1;
    const expectedName = `${String(sequence).padStart(10, "0")}.json`;
    if (eventNames[index] !== expectedName) fail("Worker admission journal sequence is discontinuous.", "WORKER_ADMISSION_JOURNAL_UNAVAILABLE");
    const eventPath = path.join(eventDirectory, expectedName);
    const markerPath = path.join(markerDirectory, expectedName);
    const eventStat = fs.lstatSync(eventPath);
    const markerStat = fs.lstatSync(markerPath);
    if (!eventStat.isFile() || eventStat.isSymbolicLink() || !markerStat.isFile() || markerStat.isSymbolicLink()) {
      fail("Worker admission journal contains an unsafe entry.", "WORKER_ADMISSION_JOURNAL_UNAVAILABLE");
    }
    const event = verifyEvent(readJson(eventPath, "Worker admission event"), state, previousHash, sequence);
    const marker = readJson(markerPath, "Worker admission event commit");
    if (canonicalJson(marker) !== canonicalJson(markerDocument(state, event))) {
      fail("Worker admission event commit does not match its event.", "WORKER_ADMISSION_JOURNAL_UNAVAILABLE");
    }
    events.push(event);
    previousHash = event.eventHash;
  }
  const head = verifyJournalHead(readJson(path.join(state.paths.expectation, "journal-head.json"), "Worker admission journal head"), state.metadata);
  if (head.sequence !== events.length || head.eventHash !== previousHash) {
    fail("Worker admission journal tail does not match the Host expectation head.", "WORKER_ADMISSION_JOURNAL_UNAVAILABLE");
  }
  return { events, lastHash: previousHash };
}

function refreshJournalLocked(state, journal) {
  const current = readJournal(state);
  if (current.events.length !== journal.events.length || current.lastHash !== journal.lastHash) {
    fail("Worker admission journal changed during a locked operation.", "WORKER_ADMISSION_JOURNAL_UNAVAILABLE");
  }
  journal.events = current.events;
  journal.lastHash = current.lastHash;
  return journal;
}

function appendEventLocked(state, journal, input) {
  refreshJournalLocked(state, journal);
  const sequence = journal.events.length + 1;
  const event = eventDocument(state, journal.lastHash, sequence, input);
  writeExclusive(eventFile(state.paths, sequence), event);
  writeExclusive(markerFile(state.paths, sequence), markerDocument(state, event));
  updateJournalHead(state, sequence, event.eventHash);
  journal.events.push(event);
  journal.lastHash = event.eventHash;
  return event;
}

async function withDomainLock(state, operation) {
  verifyStorageTopology(state);
  const lock = path.join(state.paths.domain, "domain.lock");
  let lockLease;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try { lockLease = acquireDirectoryLock(lock); break; }
    catch (error) {
      if (error.code !== "WORKER_ADMISSION_DOMAIN_BUSY") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (!lockLease) fail("Worker admission domain lock did not become available.", "WORKER_ADMISSION_DOMAIN_BUSY");
  const assertLockOwned = () => {
    verifyStorageTopology(state);
    verifySafeDirectoryChain(state.operational, lock, "Worker admission domain lock");
    lockLease.assertOwned();
  };
  let operationError = null;
  try {
    const journal = readJournal(state);
    return await operation(journal, assertLockOwned);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      assertLockOwned();
      lockLease.release();
    } catch (cleanupError) {
      if (!operationError) throw cleanupError;
    }
  }
}

function capacityKey(authorization) {
  const model = authorization.runtimeSelection?.model || "unspecified";
  return `runtime/${authorization.runtime}/model/${model}`;
}

function currentTarget(root, authorizationId, dispatchId) {
  const inspected = inspectProject(root);
  if (inspected.status !== "ready") fail("Worker admission requires a ready Project.", "WORKER_ADMISSION_PROJECT_NOT_READY");
  const { authorization } = readRuntimeInvocationAuthorization({ root: inspected.project.projectRoot, authorizationId });
  const { dispatch } = readBoundedWorkerDispatch({ root: inspected.project.projectRoot, authorizationId });
  if (dispatch.dispatchId !== dispatchId
    || authorization.projectId !== inspected.project.projectId || sessionIdOf(authorization) !== inspected.state.sessionId
    || (authorization.scope.kind === "run"
      ? authorization.scope.runId !== inspected.state.activeRunId || authorization.scope.executionContractId !== inspected.state.activeExecutionContractId
      : authorization.scope.kind !== "session" || inspected.state.mode !== "session" || inspected.state.activeRunId || inspected.state.activeExecutionContractId || inspected.state.pendingReview)
    || dispatch.authorizationHash !== authorization.authorizationHash) {
    fail("Worker admission target no longer matches the current dispatch lineage.", "WORKER_ADMISSION_LINEAGE_CONFLICT");
  }
  return { inspected, authorization, dispatch };
}

function reduceJournal(events) {
  const requests = new Map();
  for (const event of events) {
    const previous = requests.get(event.requestId) || null;
    if (previous && (event.authorizationId !== previous.authorizationId || event.dispatchId !== previous.dispatchId
      || event.capacityKey !== previous.capacityKey)) {
      fail("Worker admission event changed immutable request identity.", "WORKER_ADMISSION_EVENT_TRANSITION_CONFLICT");
    }
    const sameGeneration = previous && event.generation === previous.generation;
    const nextGeneration = previous && event.generation === previous.generation + 1;
    const transitionValid = !previous
      ? event.eventType === "queued" && event.generation === 1 && event.ownerFenceDigest === null
      : event.eventType === "resumed"
        ? new Set(["queued", "resumed", "reserved"]).has(previous.state) && nextGeneration && event.ownerFenceDigest === null
        : event.eventType === "reserved"
          ? new Set(["queued", "resumed"]).has(previous.state) && sameGeneration && HASH.test(event.ownerFenceDigest || "")
          : event.eventType === "start-committed"
            ? previous.state === "reserved" && sameGeneration && event.ownerFenceDigest === previous.ownerFenceDigest
            : event.eventType === "released"
              ? new Set(["reserved", "start-committed"]).has(previous.state) && sameGeneration && event.ownerFenceDigest === previous.ownerFenceDigest
              : event.eventType === "cancelled"
                ? new Set(["queued", "resumed", "reserved"]).has(previous.state) && sameGeneration
                  && event.ownerFenceDigest === previous.ownerFenceDigest
                : event.eventType === "expired"
                  ? new Set(["queued", "resumed", "reserved"]).has(previous.state) && sameGeneration
                    && event.ownerFenceDigest === previous.ownerFenceDigest
                  : event.eventType === "unknown-blocking"
                    ? new Set(["reserved", "start-committed"]).has(previous.state) && sameGeneration
                      && event.ownerFenceDigest === previous.ownerFenceDigest
                    : false;
    if (!transitionValid) fail("Worker admission event transition is invalid.", "WORKER_ADMISSION_EVENT_TRANSITION_CONFLICT");
    if (new Set(["queued", "resumed"]).has(event.eventType)) {
      exactFields(event.details, ["mode", "deadlineAt"], "Worker admission queue event", "WORKER_ADMISSION_EVENT_TRANSITION_CONFLICT");
      if (!MODES.has(event.details.mode) || Number.isNaN(Date.parse(event.details.deadlineAt))) fail("Worker admission queue event details are invalid.", "WORKER_ADMISSION_EVENT_TRANSITION_CONFLICT");
    } else if (event.eventType === "reserved") {
      exactFields(event.details, ["reserved"], "Worker admission reservation event", "WORKER_ADMISSION_EVENT_TRANSITION_CONFLICT");
      if (event.details.reserved !== true) fail("Worker admission reservation event is invalid.", "WORKER_ADMISSION_EVENT_TRANSITION_CONFLICT");
    } else if (event.eventType === "start-committed") {
      exactFields(event.details, ["consumptionId", "consumptionHash"], "Worker admission start event", "WORKER_ADMISSION_EVENT_TRANSITION_CONFLICT");
      if (!/^runtime-execution-consumption-[a-f0-9]{24}$/.test(event.details.consumptionId || "") || !HASH.test(event.details.consumptionHash || "")) fail("Worker admission start evidence is invalid.", "WORKER_ADMISSION_EVENT_TRANSITION_CONFLICT");
    } else {
      exactFields(event.details, ["outcomeCode"], "Worker admission terminal event", "WORKER_ADMISSION_EVENT_TRANSITION_CONFLICT");
      if (typeof event.details.outcomeCode !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(event.details.outcomeCode)) fail("Worker admission terminal outcome is invalid.", "WORKER_ADMISSION_EVENT_TRANSITION_CONFLICT");
    }
    const next = {
      requestId: event.requestId,
      authorizationId: event.authorizationId,
      dispatchId: event.dispatchId,
      capacityKey: event.capacityKey,
      generation: event.generation,
      state: event.eventType,
      ownerFenceDigest: event.ownerFenceDigest,
      queuedSequence: previous?.queuedSequence || event.sequence,
      deadlineAt: previous?.deadlineAt || event.details.deadlineAt || null,
      mode: previous?.mode || event.details.mode || null,
      consumptionId: previous?.consumptionId || event.details.consumptionId || null,
      outcomeCode: event.details.outcomeCode ?? previous?.outcomeCode ?? null,
      lastSequence: event.sequence,
    };
    requests.set(event.requestId, next);
  }
  return requests;
}

function activeRequest(request) {
  return new Set(["reserved", "start-committed", "unknown-blocking"]).has(request.state);
}

function queuedRequest(request) {
  return request.state === "queued" || request.state === "resumed";
}

function inspectAdmissionLease(target) {
  return inspectRuntimeExecutionLease({
    projectRoot: target.inspected.project.projectRoot,
    storage: target.inspected.storage,
    projectId: target.authorization.projectId,
    authorizationId: target.authorization.authorizationId,
  });
}

function requireAvailableAdmissionLease(target) {
  const lease = inspectAdmissionLease(target);
  if (lease.singleUseConsumed) {
    fail("Worker admission cannot accept an authorization that is already consumed.", "WORKER_ADMISSION_AUTHORIZATION_ALREADY_CONSUMED");
  }
  if (lease.status !== "available") {
    fail("Worker admission requires an available runtime execution lease.", "WORKER_ADMISSION_AUTHORIZATION_UNAVAILABLE");
  }
  return lease;
}

function requireUnconsumedAdmissionLease(target) {
  const lease = inspectAdmissionLease(target);
  if (lease.singleUseConsumed) {
    fail("Worker admission authorization was consumed before admission committed its start.", "WORKER_ADMISSION_AUTHORIZATION_ALREADY_CONSUMED");
  }
  return lease;
}

function expireQueuedLocked(state, journal, requests, now = Date.now()) {
  for (const request of requests.values()) {
    if (queuedRequest(request) && (!request.deadlineAt || Date.parse(request.deadlineAt) <= now)) {
      appendEventLocked(state, journal, { ...request, eventType: "expired", details: { outcomeCode: "max-wait-exceeded" } });
    }
  }
  return reduceJournal(journal.events);
}

function appendQueuedTerminalIfExact(state, journal, { requestId, generation, eventType, outcomeCode }) {
  const request = reduceJournal(journal.events).get(requestId);
  if (!request || !queuedRequest(request) || request.generation !== generation || request.ownerFenceDigest !== null) return false;
  appendEventLocked(state, journal, { ...request, eventType, details: { outcomeCode } });
  return true;
}

function appendReservedCancellationIfExact(state, journal, { requestId, generation, ownerFenceDigest, outcomeCode }) {
  const request = reduceJournal(journal.events).get(requestId);
  if (!request || request.state !== "reserved" || request.generation !== generation
    || request.ownerFenceDigest !== ownerFenceDigest) return false;
  appendEventLocked(state, journal, { ...request, eventType: "cancelled", details: { outcomeCode } });
  return true;
}

function requireRequestLeaseAvailable(state, journal, request, target) {
  let lease;
  try {
    lease = requireAvailableAdmissionLease(target);
  } catch (error) {
    if (request.state === "reserved") {
      appendEventLocked(state, journal, {
        ...request,
        eventType: "unknown-blocking",
        details: { outcomeCode: "reserved-restart-cleanup-unproven" },
      });
      fail("Reserved admission cannot resume without definitive process-cleanup evidence.", "WORKER_ADMISSION_UNKNOWN_BLOCKING");
    }
    appendQueuedTerminalIfExact(state, journal, {
      requestId: request.requestId,
      generation: request.generation,
      eventType: "cancelled",
      outcomeCode: error.code === "WORKER_ADMISSION_AUTHORIZATION_ALREADY_CONSUMED"
        ? "authorization-already-consumed" : "authorization-lease-unavailable",
    });
    throw error;
  }
  return lease;
}

function verifyValidatorResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !new Set(["current", "cancelled", "superseded", "unavailable"]).has(value.status)
    || Object.keys(value).some((key) => !new Set(["status", "resume"]).has(key))
    || value.resume !== undefined && typeof value.resume !== "boolean") {
    fail("Worker admission Host validator returned an invalid bounded result.", "INVALID_WORKER_ADMISSION_VALIDATION");
  }
  return { status: value.status, resume: value.resume === true };
}

async function hostValidate(state, context) {
  if (!state.preStartValidate) return { status: "unavailable", resume: false };
  return verifyValidatorResult(await state.preStartValidate(Object.freeze({ ...context })));
}

function requestIdentity(state, authorizationId, dispatchId) {
  return identity("worker-admission-request", {
    domainId: state.metadata.domainId,
    domainInstanceId: state.metadata.domainInstanceId,
    authorizationId,
    dispatchId,
  });
}

function publicReservation(state, request, gate, finalize) {
  return Object.freeze({
    admissionDomainId: state.metadata.domainId,
    domainInstanceId: state.metadata.domainInstanceId,
    requestId: request.requestId,
    authorizationId: request.authorizationId,
    dispatchId: request.dispatchId,
    capacityKey: request.capacityKey,
    generation: request.generation,
    ownerFenceDigest: request.ownerFenceDigest,
    preConsumeGate: gate,
    finalize,
  });
}

function requireDefinitiveExecutionCleanup(root, authorizationId, storage) {
  let result;
  try {
    result = readRuntimeInvocationResult({ root, authorizationId, storage });
  } catch (error) {
    if (error.code === "RUNTIME_INVOCATION_RESULT_NOT_FOUND") {
      fail("Consumed admission capacity requires a verified runtime result.", "WORKER_ADMISSION_RELEASE_EVIDENCE_MISSING");
    }
    throw error;
  }
  const boundary = result.receipt.processBoundary;
  const exactChildOnlySettled = boundary.noDescendantFixture === true
    && boundary.exactChildStarted === boundary.exactChildExitObserved;
  const ownedProviderTreeSettled = boundary.noDescendantFixture === false
    && boundary.providerChildStarted === true
    && boundary.providerChildExitObserved === true
    && boundary.treeCleanupVerified === true
    && boundary.descendantTreeOwnershipValidated === true;
  if (!exactChildOnlySettled && !ownedProviderTreeSettled) {
    fail("Runtime descendant cleanup is not definitively verified.", "WORKER_ADMISSION_RELEASE_EVIDENCE_MISSING");
  }
  return result;
}

export async function enqueueWorkerAdmission({ host, root = ".", authorizationId, dispatchId, mode = "attached", signal = null } = {}) {
  const state = requireHost(host);
  if (!MODES.has(mode)) fail("Worker admission mode is invalid.", "INVALID_WORKER_ADMISSION_MODE");
  if (signal !== null && (typeof signal !== "object" || typeof signal.aborted !== "boolean")) fail("Worker admission signal is invalid.", "INVALID_WORKER_ADMISSION_SIGNAL");
  const target = currentTarget(root, authorizationId, dispatchId);
  validateRootSeparation(state.operational, state.expectation, target.inspected.project.projectRoot);
  const key = capacityKey(target.authorization);
  const requestId = requestIdentity(state, authorizationId, dispatchId);
  const startedAt = Date.now();
  let generation = 1;

  await withDomainLock(state, async (journal, assertLockOwned) => {
    const requests = expireQueuedLocked(state, journal, reduceJournal(journal.events));
    let existing = requests.get(requestId);
    if (existing) {
      if (existing.authorizationId !== authorizationId || existing.dispatchId !== dispatchId || existing.capacityKey !== key) {
        fail("Worker admission request identity conflicts with existing history.", "WORKER_ADMISSION_REQUEST_CONFLICT");
      }
      if (TERMINAL_STATES.has(existing.state) || existing.state === "start-committed" || existing.state === "unknown-blocking") {
        fail("Worker admission request cannot be replayed after a terminal or consumed state.", "WORKER_ADMISSION_REQUEST_REPLAY_REJECTED");
      }
      requireRequestLeaseAvailable(state, journal, existing, target);
      const validation = await hostValidate(state, { phase: "resume", root: target.inspected.project.projectRoot, authorizationId, dispatchId, requestId, generation: existing.generation });
      assertLockOwned();
      refreshJournalLocked(state, journal);
      const refreshedRequests = expireQueuedLocked(state, journal, reduceJournal(journal.events));
      existing = refreshedRequests.get(requestId);
      if (existing?.state === "expired") {
        fail("Worker admission expired during Host resume validation.", "WORKER_ADMISSION_EXPIRED");
      }
      if (!validation.resume || validation.status !== "current") {
        fail("Restarted admission remains held until explicit Host validation.", "WORKER_ADMISSION_RESUME_CONFIRMATION_REQUIRED");
      }
      if (!existing || !new Set(["queued", "resumed", "reserved"]).has(existing.state)) {
        fail("Worker admission request changed during Host resume validation.", "WORKER_ADMISSION_STALE_REQUEST");
      }
      const resumedTarget = currentTarget(root, authorizationId, dispatchId);
      if (resumedTarget.authorization.authorizationHash !== target.authorization.authorizationHash
        || resumedTarget.dispatch.dispatchHash !== target.dispatch.dispatchHash) {
        fail("Worker admission target changed during Host resume validation.", "WORKER_ADMISSION_LINEAGE_CONFLICT");
      }
      requireRequestLeaseAvailable(state, journal, existing, resumedTarget);
      if (!existing.deadlineAt || Date.parse(existing.deadlineAt) <= Date.now()) {
        appendEventLocked(state, journal, {
          ...existing,
          eventType: "expired",
          details: { outcomeCode: "max-wait-exceeded" },
        });
        fail("Worker admission expired before Host resume could open a new generation.", "WORKER_ADMISSION_EXPIRED");
      }
      generation = existing.generation + 1;
      appendEventLocked(state, journal, {
        eventType: "resumed", requestId, authorizationId, dispatchId, capacityKey: key, generation,
        details: { mode, deadlineAt: existing.deadlineAt },
      });
      return;
    }
    requireAvailableAdmissionLease(target);
    if ([...requests.values()].filter(queuedRequest).length >= state.metadata.policy.maxQueued) {
      fail("Worker admission queue capacity is exceeded.", "WORKER_ADMISSION_QUEUE_CAPACITY_EXCEEDED");
    }
    appendEventLocked(state, journal, {
      eventType: "queued", requestId, authorizationId, dispatchId, capacityKey: key, generation,
      details: { mode, deadlineAt: new Date(startedAt + state.metadata.policy.maxWaitMs).toISOString() },
    });
  });

  let reserved;
  while (!reserved) {
    if (signal?.aborted) {
      await withDomainLock(state, async (journal) => {
        appendQueuedTerminalIfExact(state, journal, {
          requestId, generation, eventType: "cancelled", outcomeCode: "attached-signal-aborted",
        });
      });
      fail("Worker admission was cancelled before lease consumption.", "WORKER_ADMISSION_CANCELLED");
    }
    if (Date.now() - startedAt >= state.metadata.policy.maxWaitMs) {
      await withDomainLock(state, async (journal) => {
        appendQueuedTerminalIfExact(state, journal, {
          requestId, generation, eventType: "expired", outcomeCode: "max-wait-exceeded",
        });
      });
      fail("Worker admission expired before reservation.", "WORKER_ADMISSION_EXPIRED");
    }
    reserved = await withDomainLock(state, async (journal, assertLockOwned) => {
      let requests = expireQueuedLocked(state, journal, reduceJournal(journal.events));
      let request = requests.get(requestId);
      if (request?.state === "expired" && request.generation === generation) {
        fail("Worker admission expired before reservation.", "WORKER_ADMISSION_EXPIRED");
      }
      if (!request || !queuedRequest(request) || request.generation !== generation) {
        fail("Worker admission queue state changed unexpectedly.", "WORKER_ADMISSION_STALE_REQUEST");
      }
      try {
        let current = currentTarget(root, authorizationId, dispatchId);
        if (current.authorization.authorizationHash !== target.authorization.authorizationHash) {
          fail("Worker admission authorization changed while queued.", "WORKER_ADMISSION_LINEAGE_CONFLICT");
        }
        requireRequestLeaseAvailable(state, journal, request, current);
        if (mode === "detached") {
          const validation = await hostValidate(state, { phase: "queued", root: current.inspected.project.projectRoot, authorizationId, dispatchId, requestId, generation });
          assertLockOwned();
          refreshJournalLocked(state, journal);
          requests = expireQueuedLocked(state, journal, reduceJournal(journal.events));
          request = requests.get(requestId);
          if (request?.state === "expired" && request.generation === generation) {
            fail("Worker admission expired during queued Host validation.", "WORKER_ADMISSION_EXPIRED");
          }
          if (!request || !queuedRequest(request) || request.generation !== generation) {
            fail("Worker admission queue changed during Host validation.", "WORKER_ADMISSION_STALE_REQUEST");
          }
          if (validation.status !== "current") {
            if (validation.status === "unavailable") return null;
            appendEventLocked(state, journal, { ...request, eventType: "cancelled", details: { outcomeCode: `host-${validation.status}` } });
            fail("Detached worker admission was cancelled by Host validation.", "WORKER_ADMISSION_CANCELLED");
          }
          current = currentTarget(root, authorizationId, dispatchId);
          if (current.authorization.authorizationHash !== target.authorization.authorizationHash
            || current.dispatch.dispatchHash !== target.dispatch.dispatchHash) {
            fail("Worker admission target changed during queued Host validation.", "WORKER_ADMISSION_LINEAGE_CONFLICT");
          }
          requireRequestLeaseAvailable(state, journal, request, current);
        }
      } catch (error) {
        try {
          assertLockOwned();
          appendQueuedTerminalIfExact(state, journal, {
            requestId, generation, eventType: "cancelled", outcomeCode: "queue-validation-failed",
          });
        } catch {}
        throw error;
      }
      const all = [...requests.values()];
      const active = all.filter(activeRequest);
      const keyActive = active.filter((item) => item.capacityKey === key);
      if (active.length >= state.metadata.policy.globalLimit || keyActive.length >= state.metadata.policy.perKeyLimit) return null;
      const eligible = all.filter(queuedRequest).sort((left, right) => left.queuedSequence - right.queuedSequence || compareText(left.requestId, right.requestId));
      const keyHeads = new Map();
      for (const item of eligible) if (!keyHeads.has(item.capacityKey)) keyHeads.set(item.capacityKey, item);
      const selected = [...keyHeads.values()]
        .filter((item) => active.filter((activeItem) => activeItem.capacityKey === item.capacityKey).length < state.metadata.policy.perKeyLimit)
        .sort((left, right) => left.queuedSequence - right.queuedSequence || compareText(left.requestId, right.requestId))[0];
      if (!selected || selected.requestId !== requestId) return null;
      const ownerFenceDigest = digest(canonicalJson({ requestId, generation, authorizationHash: target.authorization.authorizationHash, dispatchHash: target.dispatch.dispatchHash }));
      appendEventLocked(state, journal, { ...request, eventType: "reserved", ownerFenceDigest, details: { reserved: true } });
      return { ...request, state: "reserved", ownerFenceDigest };
    });
    if (!reserved) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const preConsumeGate = createRuntimePreConsumeGateCapability(async ({ authorization, owner, commitConsumption }) => {
    if (authorization.authorizationId !== authorizationId) fail("Admission capability targets another authorization.", "WORKER_ADMISSION_AUTHORIZATION_CONFLICT");
    // Lease owner fences and admission fences are deliberately distinct.
    if (owner.ownerFenceDigest === reserved.ownerFenceDigest) fail("Admission fence cannot replace runtime owner fence.", "WORKER_ADMISSION_FENCE_ALIAS_REJECTED");
    await withDomainLock(state, async (journal, assertLockOwned) => {
      let request = reduceJournal(journal.events).get(requestId);
      if (!request || request.state !== "reserved" || request.generation !== generation
        || request.ownerFenceDigest !== reserved.ownerFenceDigest || request.authorizationId !== authorizationId
        || request.dispatchId !== dispatchId) {
        fail("Worker admission reservation is stale or tampered.", "WORKER_ADMISSION_RESERVATION_CONFLICT");
      }
      try {
        const initial = currentTarget(root, authorizationId, dispatchId);
        requireUnconsumedAdmissionLease(initial);
        if (signal?.aborted) fail("Worker admission was cancelled before lease consumption.", "WORKER_ADMISSION_CANCELLED");
        const validation = state.preStartValidate
          ? await hostValidate(state, { phase: "pre-consume", root: path.resolve(root), authorizationId, dispatchId, requestId, generation })
          : { status: mode === "attached" ? "current" : "unavailable", resume: false };
        assertLockOwned();
        if (signal?.aborted) fail("Worker admission was cancelled before lease consumption.", "WORKER_ADMISSION_CANCELLED");
        if (validation.status !== "current") {
          fail("Worker admission final Host validation did not prove the request current.", validation.status === "unavailable" ? "WORKER_ADMISSION_VALIDATION_UNAVAILABLE" : "WORKER_ADMISSION_CANCELLED");
        }
        refreshJournalLocked(state, journal);
        request = reduceJournal(journal.events).get(requestId);
        if (!request || request.state !== "reserved" || request.generation !== generation
          || request.ownerFenceDigest !== reserved.ownerFenceDigest || request.authorizationId !== authorizationId
          || request.dispatchId !== dispatchId) {
          fail("Worker admission reservation changed during final Host validation.", "WORKER_ADMISSION_RESERVATION_CONFLICT");
        }
        const current = currentTarget(root, authorizationId, dispatchId);
        if (current.authorization.authorizationHash !== target.authorization.authorizationHash
          || current.dispatch.dispatchHash !== target.dispatch.dispatchHash) {
          fail("Worker admission target changed during final Host validation.", "WORKER_ADMISSION_LINEAGE_CONFLICT");
        }
        requireUnconsumedAdmissionLease(current);
      } catch (error) {
        const outcomeCode = error.code === "WORKER_ADMISSION_CANCELLED"
          ? "attached-signal-aborted" : "pre-consume-validation-failed";
        try {
          assertLockOwned();
          appendReservedCancellationIfExact(state, journal, {
            requestId, generation, ownerFenceDigest: reserved.ownerFenceDigest, outcomeCode,
          });
        } catch {}
        throw error;
      }
      const consumption = commitConsumption();
      try {
        appendEventLocked(state, journal, {
          ...request,
          eventType: "start-committed",
          details: { consumptionId: consumption.consumptionId, consumptionHash: consumption.consumptionHash },
        });
      } catch (error) {
        const uncertain = new Error("Lease consumption committed but admission start evidence is incomplete.");
        uncertain.code = "WORKER_ADMISSION_START_COMMIT_UNCERTAIN";
        uncertain.cause = error;
        throw uncertain;
      }
    });
  });

  const finalize = async ({ outcomeCode = "settled" } = {}) => {
    if (typeof outcomeCode !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(outcomeCode)) fail("Worker admission finalize outcome is invalid.", "INVALID_WORKER_ADMISSION_OUTCOME");
    return withDomainLock(state, async (journal) => {
      const request = reduceJournal(journal.events).get(requestId);
      if (!request || request.generation !== generation || request.ownerFenceDigest !== reserved.ownerFenceDigest) {
        fail("Worker admission finalize is stale.", "WORKER_ADMISSION_STALE_FINALIZE");
      }
      if (request.state === "released") {
        if (request.outcomeCode !== outcomeCode) fail("Worker admission finalize replay diverged.", "WORKER_ADMISSION_FINALIZE_CONFLICT");
        return { status: "existing", requestId, outcomeCode };
      }
      if (request.state === "cancelled" || request.state === "expired") {
        return { status: "existing-terminal", requestId, outcomeCode: request.outcomeCode };
      }
      if (!new Set(["reserved", "start-committed"]).has(request.state)) fail("Worker admission cannot finalize from its current state.", "WORKER_ADMISSION_STALE_FINALIZE");
      const lease = inspectRuntimeExecutionLease({ projectRoot: path.resolve(root), projectId: target.authorization.projectId, authorizationId, storage: target.inspected.storage });
      if (request.state === "start-committed" && lease.status !== "consumed-released") {
        fail("Consumed admission capacity cannot be released without definitive lease cleanup evidence.", "WORKER_ADMISSION_RELEASE_EVIDENCE_MISSING");
      }
      if (request.state === "start-committed") {
        requireDefinitiveExecutionCleanup(path.resolve(root), authorizationId, originalFormat(target.authorization));
      }
      if (request.state === "reserved" && lease.singleUseConsumed) {
        fail("Admission start evidence is missing for a consumed authorization.", "WORKER_ADMISSION_JOURNAL_UNAVAILABLE");
      }
      appendEventLocked(state, journal, { ...request, eventType: "released", details: { outcomeCode } });
      return { status: "released", requestId, outcomeCode };
    });
  };

  return publicReservation(state, reserved, preConsumeGate, finalize);
}

function publicAdmissionState(request) {
  if (!request) return "not-requested";
  if (request.state === "queued" || request.state === "resumed") return "queued";
  if (request.state === "reserved" || request.state === "start-committed") return "capacity-reserved";
  return request.state;
}

function readExecutionEvidence({ root, projectId, authorizationId, storage }) {
  let lease;
  try {
    lease = inspectRuntimeExecutionLease({ projectRoot: root, projectId, authorizationId, storage });
  } catch (error) {
    return {
      availability: "unavailable",
      leaseStatus: "unknown",
      authorizationConsumed: null,
      supervisorStartObserved: "unavailable",
      providerStartObserved: "unavailable",
      terminalEvidence: "unknown",
      diagnosticCode: error.code || "WORKER_ADMISSION_EXECUTION_EVIDENCE_UNAVAILABLE",
    };
  }
  let result = null;
  try {
    result = readRuntimeInvocationResult({ root, authorizationId, storage });
  } catch (error) {
    if (error.code !== "RUNTIME_INVOCATION_RESULT_NOT_FOUND") {
      return {
        availability: "unavailable",
        leaseStatus: lease.status,
        authorizationConsumed: lease.singleUseConsumed,
        supervisorStartObserved: "unavailable",
        providerStartObserved: "unavailable",
        terminalEvidence: "unknown",
        diagnosticCode: error.code || "WORKER_ADMISSION_EXECUTION_EVIDENCE_UNAVAILABLE",
      };
    }
  }
  if (result) {
    return {
      availability: "available",
      leaseStatus: lease.status,
      authorizationConsumed: lease.singleUseConsumed,
      supervisorStartObserved: result.receipt.processBoundary.exactChildStarted ? "yes" : "no",
      providerStartObserved: result.receipt.processBoundary.providerChildStarted ? "yes" : "no",
      terminalEvidence: "runtime-result",
      diagnosticCode: null,
    };
  }
  return {
    availability: "available",
    leaseStatus: lease.status,
    authorizationConsumed: lease.singleUseConsumed,
    supervisorStartObserved: "unknown",
    providerStartObserved: "unknown",
    terminalEvidence: lease.release?.lifecycleReceiptId ? "lifecycle-receipt" : "none",
    diagnosticCode: null,
  };
}

export function readWorkerAdmissionProjection({ host, root = ".", authorizationId } = {}) {
  const state = requireHost(host);
  try {
    const target = currentTarget(root, authorizationId, readBoundedWorkerDispatch({ root, authorizationId }).dispatch.dispatchId);
    validateRootSeparation(state.operational, state.expectation, target.inspected.project.projectRoot);
    const journal = readJournal(state);
    const request = [...reduceJournal(journal.events).values()].find((item) => item.authorizationId === authorizationId) || null;
    const executionEvidence = readExecutionEvidence({
      root: target.inspected.project.projectRoot,
      projectId: target.authorization.projectId,
      storage: target.inspected.storage,
      authorizationId,
    });
    return {
      schemaVersion: 1,
      kind: "WorkerAdmissionStatusProjection",
      protocolVersion: WORKER_ADMISSION_VERSION,
      availability: "available",
      admissionDomainId: state.metadata.domainId,
      domainInstanceId: state.metadata.domainInstanceId,
      policyHash: state.metadata.policyHash,
      authorizationId,
      dispatchId: target.dispatch.dispatchId,
      requestId: request?.requestId || null,
      capacityKey: request?.capacityKey || capacityKey(target.authorization),
      generation: request?.generation || null,
      state: publicAdmissionState(request),
      leaseStatus: executionEvidence.leaseStatus,
      authorizationConsumed: executionEvidence.authorizationConsumed,
      executionEvidence,
      resultAuthority: false,
      persisted: false,
      recoveryAuthority: false,
      instructionAuthority: false,
      reviewAuthority: false,
      promotionAuthority: false,
      mutatesCanon: false,
    };
  } catch (error) {
    if (!new Set([
      "WORKER_ADMISSION_DOMAIN_UNAVAILABLE", "WORKER_ADMISSION_DOMAIN_IDENTITY_CONFLICT",
      "WORKER_ADMISSION_PROVISION_CONFLICT", "WORKER_ADMISSION_GENESIS_CONFLICT",
      "WORKER_ADMISSION_JOURNAL_UNAVAILABLE", "WORKER_ADMISSION_EVENT_TRANSITION_CONFLICT",
      "WORKER_ADMISSION_PATH_ESCAPE",
      "INVALID_WORKER_ADMISSION_ARTIFACT", "INVALID_WORKER_ADMISSION_EVENT", "INVALID_WORKER_ADMISSION_METADATA",
    ]).has(error.code)) throw error;
    return {
      schemaVersion: 1,
      kind: "WorkerAdmissionStatusProjection",
      protocolVersion: WORKER_ADMISSION_VERSION,
      availability: "unavailable",
      admissionDomainId: state.metadata.domainId,
      domainInstanceId: state.metadata.domainInstanceId,
      policyHash: state.metadata.policyHash,
      authorizationId,
      dispatchId: null,
      requestId: null,
      capacityKey: null,
      generation: null,
      state: "unknown-blocking",
      leaseStatus: "unknown",
      authorizationConsumed: null,
      executionEvidence: {
        availability: "unavailable",
        leaseStatus: "unknown",
        authorizationConsumed: null,
        supervisorStartObserved: "unavailable",
        providerStartObserved: "unavailable",
        terminalEvidence: "unknown",
        diagnosticCode: error.code,
      },
      resultAuthority: false,
      persisted: false,
      recoveryAuthority: false,
      instructionAuthority: false,
      reviewAuthority: false,
      promotionAuthority: false,
      mutatesCanon: false,
      diagnosticCode: error.code,
    };
  }
}

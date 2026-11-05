import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LSP_HOST_LIMITS,
  LSP_HOST_NORMALIZER_VERSION,
  LSP_HOST_REAL_LIMITS,
  LSP_HOST_REAL_NORMALIZER_VERSION,
  LSP_HOST_REAL_PROFILE_KIND,
  LspFrameParser,
  admittedRealDocumentFromUri,
  boundedFixtureCallRanges,
  boundedFixtureFunctionIdentity,
  boundedFixtureModuleRoute,
  canonicalJson,
  createPendingTable,
  createSnapshotDescriptor,
  encodeLspMessage,
  protocolError,
  relationSemanticDigest,
  relativePathFromUri,
  sha256,
  serializePinnedTlsWindowsFixtureUri,
  snapshotUri,
  terminalResult,
  validateRange,
  verifyOwnershipBinding,
} from "./lsp-host-protocol.mjs";
import { spawnSupervisedProcess } from "./runtime-process-supervisor.mjs";

const moduleFile = fileURLToPath(import.meta.url);
const REAL_PACKAGE_TRUST = Object.freeze({
  "typescript-language-server": Object.freeze({
    version: "5.3.0",
    url: "https://registry.npmjs.org/typescript-language-server/-/typescript-language-server-5.3.0.tgz",
    sri: "sha512-5puofxZHgFdAYtfNpmwCAvgtaYgg8wrUnH30m7Ze3QuguId5RNRadKASpOpyDxTyUdAF51FjhTdjntLw/EuWcQ==",
    archiveSha256: "398cacc17fff2108652e7b4050e3182008d17063246b3fea7dcf5fae2ce1560e",
    treeDigest: "801d0d901680ddc77afb3b0189b0efc46a8c7efbf19ce194ee4ea723481f92f6",
    regularFileCount: 5,
    unpackedSize: 2335451,
    entrypoint: Object.freeze({ path: "lib/cli.mjs", sha256: "86ef128358dcd71d0c684d786d7751ee09fbbbbb2a521482b160007b8228be2e" }),
  }),
  typescript: Object.freeze({
    version: "6.0.3",
    url: "https://registry.npmjs.org/typescript/-/typescript-6.0.3.tgz",
    sri: "sha512-y2TvuxSZPDyQakkFRPZHKFm+KKVqIisdg9/CZwm9ftvKXLP8NRWj38/ODjNbr43SsoXqNuAisEf1GdCxqWcdBw==",
    archiveSha256: "33cd0ee1beaa8c9e9d15a9da836c62ddea4c34a42d7c2d349dbc80d94165d22a",
    treeDigest: "b8d6ee2fb3839af771131c5d5261aabdbb16d54d1bb08112589c09537edf11cf",
    regularFileCount: 140,
    unpackedSize: 24346827,
    entrypoint: Object.freeze({ path: "lib/tsserver.js", sha256: "e3ccfeec65ec5c470b8ffc5611878a31182650c7e8a062c38a719f83b523edcb" }),
  }),
});
const ALLOWED_SCENARIOS = new Set([
  "barrel", "direct", "false-positive", "wrong-position", "prepare-null", "prepare-empty",
  "hierarchy-null", "hierarchy-empty", "notifications", "notification-flood", "frame-oversize",
  "server-requests", "unknown-server-request", "unknown-notification", "fragmented", "bad-header",
  "invalid-json", "unknown-id", "duplicate-id", "late-response", "timeout", "cancel", "crash",
  "ambiguous", "external-uri", "invalid-range", "grandchild", "reordered", "emoji-crlf",
  "slow-work", "slow-shutdown", "stderr-limit", "external-abort", "grandchild-cancel",
  "grandchild-flood", "delete-self", "wrong-caller-document", "invalid-show-message",
]);

function safeOwnedRoot(qaRoot, ownedRoot) {
  const root = fs.realpathSync(path.resolve(qaRoot));
  const candidate = path.resolve(ownedRoot);
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw protocolError("invalid-input", "Owned LSP temporary root escaped or equaled its QA root.");
  }
  return { root, candidate };
}

function removeOwnedRoot(qaRoot, ownedRoot) {
  const { candidate } = safeOwnedRoot(qaRoot, ownedRoot);
  if (fs.existsSync(candidate)) fs.rmSync(candidate, { recursive: true, force: false });
}

function profileProvenance(profile) {
  if (!profile) return null;
  if (profile.kind !== "head-lsp-fake-v1" || !ALLOWED_SCENARIOS.has(profile.scenario || "barrel")
    || !path.isAbsolute(profile.serverFile || "") || !/^[a-f0-9]{64}$/.test(profile.serverDigest || "")) {
    throw protocolError("unsupported-profile", "Only a reviewed, exact fake LSP profile is supported by E1A-P.");
  }
  const stat = fs.lstatSync(profile.serverFile, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink() || sha256(fs.readFileSync(profile.serverFile)) !== profile.serverDigest) {
    throw protocolError("profile-drift", "Fake LSP profile bytes do not match the admitted digest.");
  }
  const nodeFile = fs.realpathSync(process.execPath);
  const nodeBytes = fs.readFileSync(nodeFile);
  return {
    kind: profile.kind,
    scenario: profile.scenario || "barrel",
    serverFile: fs.realpathSync(profile.serverFile),
    serverDigest: profile.serverDigest,
    nodeFile,
    nodeVersion: process.version,
    nodeDigest: sha256(nodeBytes),
    producerDigest: sha256(canonicalJson({
      kind: profile.kind,
      serverDigest: profile.serverDigest,
      nodeDigest: sha256(nodeBytes),
      nodeVersion: process.version,
    })),
  };
}

function baseProvenance(collectionId, descriptor, producerDigest = null) {
  return {
    collectionId,
    projectId: descriptor?.projectId ?? null,
    generationDigest: descriptor?.generationDigest ?? null,
    snapshotManifestDigest: descriptor?.snapshotManifestDigest ?? null,
    producerDigest,
  };
}

function terminalFromError(error, provenance, cleanup, fallbackStage = "launch") {
  const contaminated = new Set([
    "mapping-mismatch", "project-mismatch", "generation-mismatch", "manifest-mismatch", "producer-mismatch",
    "uri-outside-snapshot", "invalid-range", "source-drift", "config-drift", "profile-drift",
  ]);
  const reason = error?.code && [
    "invalid-input", "launch-failed", "request-timeout", "cancelled", "frame-oversize", "stdout-limit",
    "stderr-limit", "frame-limit", "notification-limit", "invalid-framing", "invalid-json", "invalid-message",
    "unsupported-server-request", "unsupported-server-notification", "unknown-response-id", "duplicate-response-id",
    "late-response", "ambiguous-prepared-item", "invalid-prepare-result", "invalid-hierarchy-result",
    "process-crash", "cleanup-failed", "limit-exceeded", "mapping-mismatch", "project-mismatch",
    "generation-mismatch", "manifest-mismatch", "producer-mismatch", "uri-outside-snapshot", "invalid-range",
    "source-drift", "config-drift", "profile-drift",
  ].includes(error.code) ? error.code : "launch-failed";
  const failureStage = error?.details?.stage || fallbackStage;
  return terminalResult({
    status: contaminated.has(reason) ? "contaminated" : "failed",
    reason,
    stage: "closed",
    failureStage,
    provenance,
    cleanup,
  });
}

function writeImmutableSnapshot(root, descriptor, collectionId) {
  const manifest = [];
  for (const document of descriptor.documents) {
    const file = path.join(root, ...document.path.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, document.text, { encoding: "utf8", flag: "wx" });
    try { fs.chmodSync(file, 0o444); } catch {}
    manifest.push({ ...document, uri: snapshotUri(collectionId, document.path), file });
  }
  return manifest;
}

function assertSnapshotUnchanged(documents) {
  for (const document of documents) {
    let bytes;
    try { bytes = fs.readFileSync(document.file); }
    catch {
      throw protocolError(document.path === "tsconfig.json" ? "config-drift" : "source-drift", "Owned LSP snapshot disappeared during collection.", { stage: "closing" });
    }
    if (bytes.length !== document.bytes || sha256(bytes) !== document.digest) {
      throw protocolError(document.path === "tsconfig.json" ? "config-drift" : "source-drift", "Owned LSP snapshot changed during collection.", { stage: "closing" });
    }
  }
}

async function waitForClose(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

async function waitForChildCleanup(childExit, child, timeoutMs = LSP_HOST_LIMITS.gracefulCleanupMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      finish({ code: null, signal: "SIGTERM" });
    }, timeoutMs);
    childExit.then(finish);
  });
}

export async function collectOutgoingCallEvidence({
  projectId,
  generationDigest,
  sources,
  profile = null,
  supervisorSelection = null,
  qaRoot,
  signal = null,
  onProcessEvent = () => {},
} = {}) {
  const collectionStartedAt = Date.now();
  const collectionId = `lsp-${crypto.randomUUID()}`;
  if (!profile) return terminalResult({ status: "not-configured", reason: "no-profile", stage: "discovery", provenance: { collectionId } });
  let descriptor;
  let producer;
  try {
    descriptor = createSnapshotDescriptor({ projectId, generationDigest, sources });
    producer = profileProvenance(profile);
  } catch (error) {
    const status = error.code === "unsupported-profile" ? "unsupported" : error.code === "profile-drift" ? "contaminated" : "failed";
    return terminalResult({ status, reason: error.code || "invalid-input", stage: "discovery", failureStage: "discovery", provenance: baseProvenance(collectionId, descriptor, producer?.producerDigest) });
  }
  const provenance = baseProvenance(collectionId, descriptor, producer.producerDigest);
  if (!supervisorSelection) return terminalResult({ status: "unsupported", reason: "unsupported-profile", stage: "discovery", provenance });
  if (typeof qaRoot !== "string" || !path.isAbsolute(qaRoot) || !fs.existsSync(qaRoot)) {
    return terminalFromError(protocolError("invalid-input", "An existing absolute QA root is required."), provenance, {}, "discovery");
  }

  let ownedRoot = null;
  let snapshotDocuments = [];
  let supervised;
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let outerFailure = null;
  let forced = false;
  let softTimer;
  let forceTimer;
  let abortHandler;
  let result;
  let supervision = null;
  let cleanup = { attempted: false, verified: false, forced: false };
  try {
    ownedRoot = fs.mkdtempSync(path.join(fs.realpathSync(qaRoot), "lsp-host-"));
    safeOwnedRoot(qaRoot, ownedRoot);
    const controlFile = path.join(ownedRoot, "supervisor-control.jsonl");
    const cancelFile = path.join(ownedRoot, "cancel.json");
    const snapshotRoot = path.join(ownedRoot, "snapshot");
    fs.mkdirSync(snapshotRoot, { recursive: false });
    snapshotDocuments = writeImmutableSnapshot(snapshotRoot, descriptor, collectionId);
    const request = {
      schemaVersion: 1,
      expectedBinding: provenance,
      binding: provenance,
      profile: producer,
      scenario: producer.scenario,
      deadlines: {
        workEpochMs: collectionStartedAt + LSP_HOST_LIMITS.workBudgetMs,
        closingEpochMs: collectionStartedAt + LSP_HOST_LIMITS.workBudgetMs + LSP_HOST_LIMITS.gracefulCleanupMs,
        totalEpochMs: collectionStartedAt + LSP_HOST_LIMITS.totalTimeoutMs,
      },
      cancelFile,
      documents: snapshotDocuments.map(({ path: relativePath, languageId, text, bytes, digest, uri }) => ({ relativePath, languageId, text, bytes, digest, uri })),
    };
    supervised = spawnSupervisedProcess({
      selection: supervisorSelection,
      executablePath: process.execPath,
      args: [moduleFile, "--bridge", "--cancel-file", cancelFile],
      cwd: path.dirname(moduleFile),
      providerEnvironment: {
        SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || "",
        PATH: process.env.PATH || "",
      },
      input: Buffer.from(canonicalJson(request), "utf8"),
      controlFile,
      terminationGraceMs: LSP_HOST_LIMITS.gracefulCleanupMs,
      onControlEvent: (event) => {
        if (event.type === "provider.started") onProcessEvent({ type: "spawn", pid: event.providerPid, parentPid: supervised?.child.pid || process.pid, command: "node lsp-host-bridge --bridge", cwd: path.dirname(moduleFile), ports: "none" });
        if (event.type === "provider.exited") onProcessEvent({ type: "exit", pid: event.providerPid, parentPid: supervised?.child.pid || process.pid, exitCode: event.exitCode, signal: "none" });
      },
    });
    onProcessEvent({ type: "spawn", pid: supervised.child.pid, parentPid: process.pid, command: path.basename(supervisorSelection.binaryPath), cwd: path.dirname(supervisorSelection.binaryPath), ports: "none" });
    const requestCancel = () => {
      if (!fs.existsSync(cancelFile)) {
        try { fs.writeFileSync(cancelFile, canonicalJson({ collectionId, requestedAt: Date.now() }), { encoding: "utf8", flag: "wx" }); } catch {}
      }
    };
    const stop = (reason, force = false) => {
      outerFailure ||= protocolError(reason, `LSP Host ${reason}.`, { stage: "closing" });
      if (force) forced = true;
      supervised.terminate(force);
    };
    softTimer = setTimeout(() => stop("request-timeout", false), Math.max(1, request.deadlines.closingEpochMs - Date.now()));
    forceTimer = setTimeout(() => stop("request-timeout", true), Math.max(1, request.deadlines.totalEpochMs - Date.now()));
    softTimer.unref?.();
    forceTimer.unref?.();
    if (signal) {
      if (signal.aborted) requestCancel();
      else { abortHandler = requestCancel; signal.addEventListener("abort", abortHandler, { once: true }); }
    }
    supervised.child.stdout.on("data", (chunk) => {
      if (outerFailure) return;
      if (stdout.length + chunk.length > LSP_HOST_LIMITS.maxStdoutBytes) { stop("stdout-limit", false); return; }
      stdout = Buffer.concat([stdout, chunk]);
    });
    supervised.child.stderr.on("data", (chunk) => {
      if (outerFailure) return;
      if (stderr.length + chunk.length > LSP_HOST_LIMITS.maxStderrBytes) { stop("stderr-limit", false); return; }
      stderr = Buffer.concat([stderr, chunk]);
    });
    const closed = await waitForClose(supervised.child);
    onProcessEvent({ type: "exit", pid: supervised.child.pid, parentPid: process.pid, exitCode: closed.code, signal: closed.signal || "none" });
    clearTimeout(softTimer);
    clearTimeout(forceTimer);
    if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
    supervision = supervised.finalize({ exactSupervisorExitObserved: true, terminationRequested: Boolean(outerFailure) });
    cleanup = { attempted: true, verified: supervision.treeCleanupVerified, forced };
    assertSnapshotUnchanged(snapshotDocuments);
    let finalProducer;
    try { finalProducer = profileProvenance(profile); }
    catch { throw protocolError("producer-mismatch", "Fake LSP producer disappeared or changed before result publication.", { stage: "closing" }); }
    if (finalProducer.producerDigest !== producer.producerDigest) throw protocolError("producer-mismatch", "Fake LSP producer changed before result publication.", { stage: "closing" });
    if (outerFailure) result = terminalFromError(outerFailure, provenance, cleanup);
    else if (!supervision.ownershipEstablished || !supervision.treeCleanupVerified) result = terminalFromError(protocolError("cleanup-failed", "Owned LSP process tree cleanup was not verified.", { stage: "closing" }), provenance, cleanup);
    else if (closed.code !== 0) result = terminalFromError(protocolError("process-crash", `LSP bridge exited ${closed.code}: ${stderr.toString("utf8").slice(0, 512)}`, { stage: "launch" }), provenance, cleanup);
    const lines = stdout.toString("utf8").split(/\r?\n/).filter(Boolean);
    if (!result) {
      if (lines.length !== 1) result = terminalFromError(protocolError("invalid-message", "LSP bridge did not emit exactly one result envelope.", { stage: "closing" }), provenance, cleanup);
      else {
        try { result = JSON.parse(lines[0]); }
        catch { result = terminalFromError(protocolError("invalid-json", "LSP bridge result is invalid JSON.", { stage: "closing" }), provenance, cleanup); }
      }
    }
    if (result.provenance) {
      const expectedResultProvenance = { ...provenance, publishedCandidateCount: result.provenance.publishedCandidateCount ?? 0 };
      if (canonicalJson(result.provenance) !== canonicalJson(expectedResultProvenance)) result = terminalFromError(protocolError("mapping-mismatch", "LSP bridge result mapping does not match its Host-owned collection.", { stage: "closing" }), provenance, cleanup);
    }
    result = Object.freeze({ ...result, cleanup, transport: { supervisorManifestDigest: supervision.supervisorManifestDigest, ownershipEstablished: supervision.ownershipEstablished, treeCleanupVerified: supervision.treeCleanupVerified } });
  } catch (error) {
    let catchForced = false;
    if (supervised?.child && supervised.child.exitCode === null && supervised.child.signalCode === null) {
      supervised.terminate(true);
      catchForced = true;
      try { await waitForClose(supervised.child); } catch {}
    }
    if (supervised && !supervision) {
      try { supervision = supervised.finalize({ exactSupervisorExitObserved: true, terminationRequested: catchForced || Boolean(outerFailure) }); } catch {}
    }
    cleanup = {
      attempted: Boolean(supervised),
      verified: supervision?.treeCleanupVerified === true,
      forced: forced || catchForced,
    };
    result = terminalFromError(error, provenance, cleanup, error?.details?.stage || "launch");
  } finally {
    clearTimeout(softTimer);
    clearTimeout(forceTimer);
    if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
    if (ownedRoot) {
      try { removeOwnedRoot(qaRoot, ownedRoot); }
      catch (error) { result = terminalFromError(protocolError("cleanup-failed", `Owned LSP temporary root cleanup failed: ${error.message}`, { stage: "closing" }), provenance, { attempted: true, verified: false, forced }, "closing"); }
    }
  }
  if (supervision && !result.transport) {
    result = Object.freeze({ ...result, transport: { supervisorManifestDigest: supervision.supervisorManifestDigest, ownershipEstablished: supervision.ownershipEstablished, treeCleanupVerified: supervision.treeCleanupVerified } });
  }
  return result;
}

const REAL_RESULT_GATE = Object.freeze({
  realSupport: false,
  generalProjectSupport: false,
  e1bEligible: false,
  isolationLevel: "observational-synthetic-fixture-only",
  authority: "ephemeral-host-evidence-only",
});
function realResult({ fixtureId, status, stage, reason, cleanup = {}, observation = {}, execution = {} }) {
  return Object.freeze({
    evidenceKind: "lsp-real-rq-observation",
    fixtureId,
    status,
    stage,
    reason,
    cleanup,
    publishedCandidateCount: 0,
    ...observation,
    executionProvenance: execution,
    ...REAL_RESULT_GATE,
  });
}

function verifiedRegularFile(file, expectedDigest, expectedSize = null) {
  if (!path.isAbsolute(file)) throw protocolError("unsupported-profile", "Real profile file path must be absolute.");
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink() || expectedSize !== null && stat.size !== expectedSize
    || !/^[a-f0-9]{64}$/.test(expectedDigest || "") || sha256(fs.readFileSync(file)) !== expectedDigest) {
    throw protocolError("profile-drift", "Real profile file bytes or identity changed.");
  }
  return fs.realpathSync.native(file);
}

function verifyNoUnlistedPackageEntries(root, filePaths) {
  const allowedFiles = new Set(filePaths);
  const allowedDirectories = new Set();
  for (const relativePath of filePaths) {
    const parts = relativePath.split("/");
    for (let index = 1; index < parts.length; index += 1) allowedDirectories.add(parts.slice(0, index).join("/"));
  }
  const observedFiles = [];
  const visit = (directory, relativeDirectory = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const nativePath = path.join(directory, entry.name);
      const stat = fs.lstatSync(nativePath);
      if (stat.isSymbolicLink()) throw protocolError("profile-drift", "Real package contains a reparse-backed entry.");
      if (stat.isDirectory()) {
        if (!allowedDirectories.has(relativePath)) throw protocolError("profile-drift", "Real package contains an unlisted directory.");
        visit(nativePath, relativePath);
      } else if (stat.isFile()) observedFiles.push(relativePath);
      else throw protocolError("profile-drift", "Real package contains a non-regular entry.");
    }
  };
  visit(root);
  const expected = [...allowedFiles].sort();
  const observed = observedFiles.sort();
  if (canonicalJson(observed) !== canonicalJson(expected)) throw protocolError("profile-drift", "Real package contains missing or unlisted files.");
}

function verifyRealPackage(packageProfile, expectedName) {
  const trust = REAL_PACKAGE_TRUST[expectedName];
  if (!trust || !packageProfile || packageProfile.name !== expectedName || packageProfile.version !== trust.version
    || packageProfile.url !== trust.url || packageProfile.sri !== trust.sri || packageProfile.archiveSha256 !== trust.archiveSha256
    || packageProfile.treeDigest !== trust.treeDigest || packageProfile.regularFileCount !== trust.regularFileCount
    || packageProfile.unpackedSize !== trust.unpackedSize || !Array.isArray(packageProfile.files)
    || packageProfile.files.length !== trust.regularFileCount || !path.isAbsolute(packageProfile.root || "")) {
    throw protocolError("unsupported-profile", "Real package profile does not match the pinned identity.");
  }
  const rootStat = fs.lstatSync(packageProfile.root, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw protocolError("profile-drift", "Real package root is missing or reparse-backed.");
  const root = fs.realpathSync.native(packageProfile.root);
  const seen = new Set();
  let total = 0;
  for (const record of packageProfile.files) {
    if (!record || typeof record.path !== "string" || record.path.includes("\\") || record.path.startsWith("/")
      || record.path.split("/").some((segment) => !segment || segment === "." || segment === "..")
      || seen.has(record.path) || !Number.isSafeInteger(record.size) || record.size < 0) {
      throw protocolError("unsupported-profile", "Real package manifest contains an invalid file record.");
    }
    seen.add(record.path);
    const file = path.resolve(root, ...record.path.split("/"));
    const relative = path.relative(root, file);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw protocolError("profile-drift", "Real package file escaped its root.");
    }
    verifiedRegularFile(file, record.sha256, record.size);
    total += record.size;
  }
  verifyNoUnlistedPackageEntries(root, packageProfile.files.map((record) => record.path));
  if (total !== trust.unpackedSize || sha256(JSON.stringify(packageProfile.files)) !== trust.treeDigest) {
    throw protocolError("profile-drift", "Real package tree digest changed.");
  }
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (packageJson.name !== expectedName || packageJson.version !== trust.version) throw protocolError("profile-drift", "Real package.json identity changed.");
  return { ...packageProfile, root };
}

function verifyRealProfileManifest(manifestFile) {
  if (typeof manifestFile !== "string" || !path.isAbsolute(manifestFile)) throw protocolError("unsupported-profile", "Real profile manifest path is invalid.");
  const manifestStat = fs.lstatSync(manifestFile, { throwIfNoEntry: false });
  if (!manifestStat?.isFile() || manifestStat.isSymbolicLink() || manifestStat.size < 1 || manifestStat.size > 1024 * 1024) {
    throw protocolError("unsupported-profile", "Real profile manifest is missing or exceeds its byte bound.");
  }
  const manifestBytes = fs.readFileSync(manifestFile);
  const manifestPath = verifiedRegularFile(manifestFile, sha256(manifestBytes), manifestStat.size);
  let profile;
  try { profile = JSON.parse(manifestBytes.toString("utf8")); }
  catch { throw protocolError("unsupported-profile", "Real profile manifest is not valid JSON."); }
  const rqIdentity = profile.kind === LSP_HOST_REAL_PROFILE_KIND && profile.normalizerVersion === LSP_HOST_REAL_NORMALIZER_VERSION
    && profile.profileVersion === undefined && profile.direction === undefined;
  if (profile.schemaVersion !== 1 || !rqIdentity) {
    throw protocolError("unsupported-profile", "Real profile manifest does not match the pinned contract.");
  }
  if (profile.node?.version !== "v24.18.0" || profile.node?.sha256 !== "9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de"
    || profile.node?.size !== 92534088) {
    throw protocolError("unsupported-profile", "Real profile manifest does not match the pinned toolchain contract.");
  }
  const nodePath = verifiedRegularFile(profile.node.path, profile.node.sha256, profile.node.size);
  const tls = verifyRealPackage(profile.packages?.["typescript-language-server"], "typescript-language-server");
  const typescript = verifyRealPackage(profile.packages?.typescript, "typescript");
  const tlsCli = verifiedRegularFile(profile.entrypoints?.tlsCli?.path, profile.entrypoints?.tlsCli?.sha256);
  const tsserver = verifiedRegularFile(profile.entrypoints?.tsserver?.path, profile.entrypoints?.tsserver?.sha256);
  if (tlsCli !== fs.realpathSync.native(path.join(tls.root, "lib", "cli.mjs"))
    || tsserver !== fs.realpathSync.native(path.join(typescript.root, "lib", "tsserver.js"))
    || profile.entrypoints?.tlsCli?.sha256 !== REAL_PACKAGE_TRUST["typescript-language-server"].entrypoint.sha256
    || profile.entrypoints?.tsserver?.sha256 !== REAL_PACKAGE_TRUST.typescript.entrypoint.sha256) {
    throw protocolError("profile-drift", "Real profile entrypoint escaped its pinned package root.");
  }
  const tlsPackageJson = JSON.parse(fs.readFileSync(path.join(tls.root, "package.json"), "utf8"));
  if (tlsPackageJson.bin?.["typescript-language-server"] !== "lib/cli.mjs") throw protocolError("profile-drift", "Real TLS bin entry changed.");
  const semanticProfile = {
    kind: profile.kind,
    normalizerVersion: profile.normalizerVersion,
    tls: { name: tls.name, version: tls.version, treeDigest: tls.treeDigest },
    typescript: { name: typescript.name, version: typescript.version, treeDigest: typescript.treeDigest },
  };
  return Object.freeze({
    manifestFile: manifestPath,
    manifestDigest: sha256(manifestBytes),
    node: { ...profile.node, path: nodePath },
    tls,
    typescript,
    tlsCli,
    tsserver,
    normalizerVersion: profile.normalizerVersion,
    kind: profile.kind,
    profileVersion: null,
    direction: null,
    semanticProfile,
    semanticProfileDigest: sha256(canonicalJson(semanticProfile)),
  });
}

function readDescriptorBytes(fd, size) {
  if (!Number.isSafeInteger(size) || size < 0) throw protocolError("invalid-input", "Real snapshot size is invalid.");
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < bytes.length) {
    const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (read < 1) throw protocolError("source-drift", "Real snapshot handle ended early.");
    offset += read;
  }
  return bytes;
}

function assertNoReparseDirectory(directory) {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw protocolError("unsupported-profile", "Real snapshot directory is missing or reparse-backed.");
  return fs.realpathSync.native(directory);
}

function createRealAdmission(snapshotRoot, descriptor) {
  const root = assertNoReparseDirectory(snapshotRoot);
  assertNoReparseDirectory(path.dirname(root));
  const documents = [];
  try {
    for (const document of descriptor.documents) {
      const file = path.join(root, document.path);
      const parent = path.dirname(file);
      const parentRelative = path.relative(root, parent);
      if (parentRelative === ".." || parentRelative.startsWith(`..${path.sep}`) || path.isAbsolute(parentRelative)) {
        throw protocolError("invalid-input", "Real snapshot document parent escaped its owned root.");
      }
      fs.mkdirSync(parent, { recursive: true });
      let checked = root;
      for (const segment of parentRelative.split(path.sep).filter(Boolean)) {
        checked = path.join(checked, segment);
        assertNoReparseDirectory(checked);
      }
      const write = fs.openSync(file, "wx", 0o444);
      try {
        fs.writeFileSync(write, document.text, "utf8");
        fs.fsyncSync(write);
      } finally { fs.closeSync(write); }
      const lstat = fs.lstatSync(file);
      if (!lstat.isFile() || lstat.isSymbolicLink()) throw protocolError("unsupported-profile", "Real snapshot file is not regular and non-reparse.");
      const nativeRealPath = fs.realpathSync.native(file);
      const pinnedServerUri = serializePinnedTlsWindowsFixtureUri(nativeRealPath);
      const nodeClientUri = pathToFileURL(nativeRealPath).href;
      const handle = fs.openSync(nativeRealPath, "r");
      let owned = true;
      try {
        const handleStat = fs.fstatSync(handle, { bigint: true });
        const pathStat = fs.statSync(nativeRealPath, { bigint: true });
        if (handleStat.dev === 0n || handleStat.ino === 0n || handleStat.dev !== pathStat.dev || handleStat.ino !== pathStat.ino
          || handleStat.size !== pathStat.size || handleStat.size !== BigInt(document.bytes)) {
          throw protocolError("unsupported-profile", "Real snapshot file identity is unavailable or inconsistent.");
        }
        const handleDigest = sha256(readDescriptorBytes(handle, document.bytes));
        const pathDigest = sha256(fs.readFileSync(nativeRealPath));
        if (handleDigest !== document.digest || pathDigest !== document.digest) {
          throw protocolError(document.path === "tsconfig.json" ? "config-drift" : "source-drift", "Real snapshot bytes changed before admission.");
        }
        documents.push({
          relativePath: document.path,
          languageId: document.languageId,
          text: document.text,
          bytes: document.bytes,
          digest: document.digest,
          file: nativeRealPath,
          handle,
          nativeRealPathDigest: sha256(nativeRealPath),
          observedFileIdentity: { dev: handleStat.dev.toString(), ino: handleStat.ino.toString(), size: handleStat.size.toString() },
          allowedUris: [pinnedServerUri, nodeClientUri],
          pinnedServerUri,
          nodeClientUri,
        });
        owned = false;
      } finally {
        if (owned) { try { fs.closeSync(handle); } catch {} }
      }
    }
  } catch (error) {
    for (const document of documents) { try { fs.closeSync(document.handle); } catch {} }
    throw error;
  }
  const admissionPayload = documents.map(({ relativePath, languageId, digest, bytes, nativeRealPathDigest, observedFileIdentity, allowedUris }) => ({ relativePath, languageId, digest, bytes, nativeRealPathDigest, observedFileIdentity, allowedUris }));
  return { root, documents, admissionManifestDigest: sha256(canonicalJson(admissionPayload)) };
}

function verifyRealAdmission(admission, stage = "closing") {
  for (const document of admission.documents) {
    let handleStat;
    let pathStat;
    let nativeRealPath;
    try {
      handleStat = fs.fstatSync(document.handle, { bigint: true });
      pathStat = fs.statSync(document.file, { bigint: true });
      nativeRealPath = fs.realpathSync.native(document.file);
    } catch {
      throw protocolError(document.relativePath === "tsconfig.json" ? "config-drift" : "source-drift", "Real snapshot binding disappeared.", { stage });
    }
    const expected = document.observedFileIdentity;
    if (handleStat.dev.toString() !== expected.dev || handleStat.ino.toString() !== expected.ino || handleStat.size.toString() !== expected.size
      || pathStat.dev.toString() !== expected.dev || pathStat.ino.toString() !== expected.ino || pathStat.size.toString() !== expected.size
      || nativeRealPath !== document.file || sha256(readDescriptorBytes(document.handle, document.bytes)) !== document.digest
      || sha256(fs.readFileSync(document.file)) !== document.digest) {
      throw protocolError(document.relativePath === "tsconfig.json" ? "config-drift" : "source-drift", "Real snapshot binding changed.", { stage });
    }
  }
}

function closeRealAdmission(admission) {
  for (const document of admission?.documents || []) { try { fs.closeSync(document.handle); } catch {} }
}

function validateRealItem(item, documents) {
  if (!item || typeof item !== "object" || typeof item.name !== "string" || item.name.length < 1 || item.name.length > 1024
    || !Number.isSafeInteger(item.kind) || item.kind < 1 || item.kind > 26) {
    throw protocolError("invalid-hierarchy-result", "Real call hierarchy item is invalid.");
  }
  const document = admittedRealDocumentFromUri(item.uri, documents);
  const range = validateRange(document.text, item.range);
  const selection = validateRange(document.text, item.selectionRange);
  if (selection.start < range.start || selection.end > range.end) throw protocolError("invalid-range", "Real call hierarchy selection escaped its item range.");
  return { document, relativePath: document.relativePath };
}

function normalizeRealOutgoing(preparedItem, outgoing, documents) {
  const caller = validateRealItem(preparedItem, documents);
  if (!Array.isArray(outgoing) || outgoing.length > 256) throw protocolError("invalid-hierarchy-result", "Real outgoing result is not a bounded array.");
  const normalized = [];
  let rawFromRangeCount = 0;
  let uniqueFromRangeCount = 0;
  for (const relation of outgoing) {
    if (!relation || typeof relation !== "object" || !Array.isArray(relation.fromRanges) || relation.fromRanges.length < 1 || relation.fromRanges.length > 256) {
      throw protocolError("invalid-hierarchy-result", "Real outgoing relation is invalid.");
    }
    const target = validateRealItem(relation.to, documents);
    rawFromRangeCount += relation.fromRanges.length;
    const validatedRanges = relation.fromRanges.map((range) => {
      validateRange(caller.document.text, range);
      return range;
    }).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right), "en"));
    const seenRanges = new Set();
    const fromRanges = validatedRanges.filter((range) => {
      const key = `${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
      if (seenRanges.has(key)) return false;
      seenRanges.add(key);
      return true;
    });
    uniqueFromRangeCount += fromRanges.length;
    normalized.push({
      from: { path: caller.relativePath, name: preparedItem.name, kind: preparedItem.kind, range: preparedItem.range, selectionRange: preparedItem.selectionRange },
      to: { path: target.relativePath, name: relation.to.name, kind: relation.to.kind, range: relation.to.range, selectionRange: relation.to.selectionRange },
      fromRanges,
    });
  }
  return {
    normalizedRelations: normalized.sort((left, right) => canonicalJson(left) < canonicalJson(right) ? -1 : canonicalJson(left) > canonicalJson(right) ? 1 : 0),
    rangeCounts: {
      rawFromRangeCount,
      uniqueFromRangeCount,
      duplicateFromRangeCount: rawFromRangeCount - uniqueFromRangeCount,
    },
  };
}

function verifyBridgeRealDocuments(documents, stage) {
  for (const document of documents) {
    let stat;
    let real;
    try { stat = fs.statSync(document.file, { bigint: true }); real = fs.realpathSync.native(document.file); }
    catch { throw protocolError(document.relativePath === "tsconfig.json" ? "config-drift" : "source-drift", "Real bridge snapshot disappeared.", { stage }); }
    if (stat.dev.toString() !== document.observedFileIdentity.dev || stat.ino.toString() !== document.observedFileIdentity.ino
      || stat.size.toString() !== document.observedFileIdentity.size || real !== document.file
      || sha256(fs.readFileSync(document.file)) !== document.digest) {
      throw protocolError(document.relativePath === "tsconfig.json" ? "config-drift" : "source-drift", "Real bridge snapshot changed.", { stage });
    }
  }
}

function realServerRequestReply(message) {
  if (message?.method === "workspace/configuration" && Array.isArray(message.params?.items)
    && message.params.items.length <= LSP_HOST_REAL_LIMITS.maxConfigurationItems) {
    const result = message.params.items.map(() => null);
    return { response: { jsonrpc: "2.0", id: message.id, result }, unsupported: false, sideEffect: "none" };
  }
  if (message?.method === "workspace/applyEdit") {
    return { response: { jsonrpc: "2.0", id: message.id, result: { applied: false, failureReason: "HEAD real LSP fixture is read-only" } }, unsupported: false, sideEffect: "denied" };
  }
  if (message?.method === "window/workDoneProgress/create") {
    return { response: { jsonrpc: "2.0", id: message.id, result: null }, unsupported: false, sideEffect: "none" };
  }
  return { response: { jsonrpc: "2.0", id: message?.id, error: { code: -32601, message: "Method not supported" } }, unsupported: true, sideEffect: "none" };
}

function verifyExternalCancellationControl(request) {
  const enabled = request?.fault?.type === "cancel-during-prepare";
  const control = request?.externalCancellation;
  if (!enabled) {
    if (control !== null && control !== undefined) throw protocolError("mapping-mismatch", "Unexpected external cancellation control was supplied.", { stage: "launch" });
    return null;
  }
  const runtimeRoot = path.resolve(request.runtimeRoot || "");
  if (!control || !path.isAbsolute(control.readyFile || "") || !path.isAbsolute(control.signalFile || "")
    || path.dirname(path.resolve(control.readyFile)) !== runtimeRoot || path.dirname(path.resolve(control.signalFile)) !== runtimeRoot
    || path.basename(control.readyFile) !== "prepare-ready.json" || path.basename(control.signalFile) !== "external-cancel.json"
    || control.readyFile === control.signalFile || !Number.isSafeInteger(control.signalBytes) || control.signalBytes < 1 || control.signalBytes > 4096
    || !/^[a-f0-9]{64}$/.test(control.signalDigest || "") || fs.existsSync(control.readyFile) || fs.existsSync(control.signalFile)) {
    throw protocolError("mapping-mismatch", "External cancellation control is not an empty bounded runtime channel.", { stage: "launch" });
  }
  return control;
}

async function runRealBridge(request) {
  const profile = verifyRealProfileManifest(request?.profileManifestFile);
  if (request?.profileKind !== profile.kind) throw protocolError("mapping-mismatch", "Real profile kind changed across the Host boundary.", { stage: "launch" });
  const documents = request?.documents;
  const expectedDocumentCount = 4;
  if (!Array.isArray(documents) || documents.length !== expectedDocumentCount || !request?.prepare || !request?.deadlines
    || request.profileManifestDigest !== profile.manifestDigest || request.semanticProfileDigest !== profile.semanticProfileDigest) {
    throw protocolError("mapping-mismatch", "Real bridge input does not match its verified profile and admission.", { stage: "launch" });
  }
  verifyRealAdmissionRequestShape(documents, request.admissionManifestDigest);
  verifyBridgeRealDocuments(documents, "launch");
  const runtimeRoot = request.runtimeRoot;
  assertNoReparseDirectory(runtimeRoot);
  verifyExternalCancellationControl(request);
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  const environment = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    ComSpec: path.join(systemRoot, "System32", "cmd.exe"),
    PATH: `${path.dirname(profile.node.path)};${path.join(systemRoot, "System32")}`,
    TEMP: path.join(runtimeRoot, "temp"), TMP: path.join(runtimeRoot, "tmp"), HOME: path.join(runtimeRoot, "home"),
    USERPROFILE: path.join(runtimeRoot, "user"), APPDATA: path.join(runtimeRoot, "appdata"), LOCALAPPDATA: path.join(runtimeRoot, "localappdata"),
  };
  for (const directory of Object.values(environment).filter((value) => value.startsWith(`${runtimeRoot}${path.sep}`))) fs.mkdirSync(directory, { recursive: false });
  const argv = [profile.tlsCli, "--stdio", "--log-level", "3"];
  const child = spawn(profile.node.path, argv, { cwd: request.snapshotRoot, env: environment, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const parser = new LspFrameParser(LSP_HOST_REAL_LIMITS);
  const serverParser = new LspFrameParser(LSP_HOST_REAL_LIMITS);
  const pending = createPendingTable({ collectionId: request.collectionId, admissionManifestDigest: request.admissionManifestDigest, profileManifestDigest: profile.manifestDigest });
  const waiters = new Map();
  const transcript = [];
  let outboundWire = Buffer.alloc(0);
  let inboundWire = Buffer.alloc(0);
  let serverWire = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let stage = "initialize";
  let notificationCount = 0;
  let firstFailure = null;
  let childClosed = false;
  let cancelPoll = null;
  const heldProxyMessages = [];
  const proxyEvents = [];
  const proxyEvent = (type, fields = {}) => {
    if (proxyEvents.length >= LSP_HOST_REAL_LIMITS.maxFrames) throw protocolError("frame-limit", "Real LSP proxy evidence exceeded its bound.", { stage });
    proxyEvents.push({ type, observedAtEpochMs: Date.now(), ...fields });
  };
  const childExit = new Promise((resolve) => child.once("close", (code, signal) => {
    childClosed = true;
    if (waiters.size > 0) {
      firstFailure ||= protocolError("process-crash", "Pinned real LSP exited with requests outstanding.", { stage });
      for (const waiter of waiters.values()) waiter.reject(firstFailure);
      waiters.clear();
    }
    resolve({ code, signal });
  }));
  const send = (message) => {
    if (childClosed || child.stdin.destroyed) throw protocolError("process-crash", "Real LSP transport is closed.", { stage });
    transcript.push({ direction: "out", message });
    const frame = encodeLspMessage(message, LSP_HOST_REAL_LIMITS);
    if (outboundWire.length + frame.length > LSP_HOST_REAL_LIMITS.maxRawEvidenceWireBytes) throw protocolError("limit-exceeded", "Real LSP outbound raw evidence exceeded its bound.", { stage });
    outboundWire = Buffer.concat([outboundWire, frame]);
    child.stdin.write(frame);
  };
  const requestWithDeadline = (method, params, requestStage) => {
    const remaining = Math.min(LSP_HOST_REAL_LIMITS.requestTimeoutMs, request.deadlines.workEpochMs - Date.now());
    if (remaining <= 0) return Promise.reject(protocolError("request-timeout", `Real LSP ${requestStage} exhausted its deadline.`, { stage: requestStage }));
    const id = pending.issue(method);
    send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(id); reject(protocolError("request-timeout", `Real LSP ${requestStage} timed out.`, { stage: requestStage })); }, remaining);
      waiters.set(id, { method, resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      if (request.fault?.type === "kill-during-prepare" && requestStage === "prepare") setTimeout(() => { try { child.kill("SIGTERM"); } catch {} }, 10).unref?.();
      if (request.fault?.type === "cancel-during-prepare" && requestStage === "prepare") {
        const control = request.externalCancellation;
        const readyBytes = Buffer.from(canonicalJson({ collectionId: request.collectionId, id, method }), "utf8");
        fs.writeFileSync(control.readyFile, readyBytes, { flag: "wx" });
        proxyEvent("external-cancel-ready", { requestId: id, method, readyDigest: sha256(readyBytes) });
        cancelPoll = setInterval(() => {
          if (!fs.existsSync(control.signalFile)) return;
          try {
            const signalStat = fs.lstatSync(control.signalFile);
            if (!signalStat.isFile() || signalStat.isSymbolicLink() || signalStat.size !== control.signalBytes) {
              throw protocolError("mapping-mismatch", "External cancellation signal is not a bounded regular file.", { stage: requestStage });
            }
            const signal = fs.readFileSync(control.signalFile);
            if (signal.length !== control.signalBytes || sha256(signal) !== control.signalDigest) {
              throw protocolError("mapping-mismatch", "External cancellation signal bytes changed.", { stage: requestStage });
            }
            proxyEvent("external-cancel-observed", { requestId: id, method, signalDigest: control.signalDigest });
            send({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } });
            const waiter = waiters.get(id);
            waiters.delete(id);
            waiter?.reject(protocolError("cancelled", "Real LSP prepare was cancelled by external Host input.", { stage: requestStage }));
          } catch (error) {
            firstFailure ||= error;
            const waiter = waiters.get(id);
            waiters.delete(id);
            waiter?.reject(error);
          } finally {
            clearInterval(cancelPoll);
            cancelPoll = null;
          }
        }, 5);
        cancelPoll.unref?.();
      }
    });
  };
  const replyToServerRequest = (message) => {
    const reply = realServerRequestReply(message);
    send(reply.response);
    if (reply.unsupported) throw protocolError("unsupported-server-request", "Real LSP requested an unsupported Host operation.", { stage });
  };
  const allowedNotifications = new Set(["window/logMessage", "window/showMessage", "$/progress", "$/typescriptVersion", "textDocument/publishDiagnostics", "telemetry/event"]);
  const handle = (message) => {
    validateMessageBase(message);
    transcript.push({ direction: "in", message });
    if ("method" in message && "id" in message) return replyToServerRequest(message);
    if ("method" in message) {
      if (++notificationCount > LSP_HOST_REAL_LIMITS.maxNotifications) throw protocolError("notification-limit", "Real LSP notification count exceeded its bound.", { stage });
      if (!allowedNotifications.has(message.method)) throw protocolError("unsupported-server-notification", "Real LSP emitted an unsupported notification.", { stage });
      return;
    }
    const waiter = waiters.get(message.id);
    if (waiter?.method === "textDocument/prepareCallHierarchy" && prepareResponseBody === null) prepareResponseBody = structuredClone(message);
    if (waiter?.method === "callHierarchy/outgoingCalls" && outgoingResponseBody === null) outgoingResponseBody = structuredClone(message);
    const entry = pending.consume(message, { collectionId: request.collectionId, admissionManifestDigest: request.admissionManifestDigest, profileManifestDigest: profile.manifestDigest });
    if (!waiter || waiter.method !== entry.method) throw protocolError("late-response", "Real LSP response has no active waiter.", { stage });
    waiters.delete(message.id);
    if ("error" in message) waiter.reject(protocolError("invalid-message", `Real LSP request ${entry.method} failed.`, { stage }));
    else waiter.resolve(message.result);
  };
  const deliverProxyMessage = (message) => {
    const frame = encodeLspMessage(message, LSP_HOST_REAL_LIMITS);
    if (inboundWire.length + frame.length > LSP_HOST_REAL_LIMITS.maxRawEvidenceWireBytes) throw protocolError("limit-exceeded", "Real LSP proxied inbound evidence exceeded its bound.", { stage });
    inboundWire = Buffer.concat([inboundWire, frame]);
    proxyEvent("bridge-received", { requestId: Object.hasOwn(message, "id") ? message.id : null, method: message.method || null, bytes: frame.length });
    for (const delivered of parser.feed(frame)) handle(delivered);
  };
  const routeServerMessage = (message) => {
    const frame = encodeLspMessage(message, LSP_HOST_REAL_LIMITS);
    proxyEvent("server-frame-observed", { requestId: Object.hasOwn(message, "id") ? message.id : null, method: message.method || null, bytes: frame.length });
    const waiter = !Object.hasOwn(message, "method") ? waiters.get(message.id) : null;
    if (waiter?.method === "textDocument/prepareCallHierarchy" && prepareResponseBody === null) prepareResponseBody = structuredClone(message);
    if (waiter?.method === "callHierarchy/outgoingCalls" && outgoingResponseBody === null) outgoingResponseBody = structuredClone(message);
    const holdPrepare = ["cancel-during-prepare", "delay-prepare-response"].includes(request.fault?.type)
      && waiter?.method === "textDocument/prepareCallHierarchy";
    if (holdPrepare) {
      heldProxyMessages.push({ message: structuredClone(message), frame });
      proxyEvent("proxy-held", { requestId: message.id, method: waiter.method, bytes: frame.length, reason: request.fault.type });
      return;
    }
    deliverProxyMessage(message);
  };
  child.stdout.on("data", (chunk) => { if (!firstFailure) { try {
    if (serverWire.length + chunk.length > LSP_HOST_REAL_LIMITS.maxRawEvidenceWireBytes) throw protocolError("limit-exceeded", "Real LSP original server evidence exceeded its bound.", { stage });
    serverWire = Buffer.concat([serverWire, chunk]);
    for (const message of serverParser.feed(chunk)) routeServerMessage(message);
  } catch (error) { firstFailure ||= error; for (const waiter of waiters.values()) waiter.reject(error); waiters.clear(); } } });
  child.stderr.on("data", (chunk) => { if (!firstFailure) { stderr = Buffer.concat([stderr, chunk]); if (stderr.length > LSP_HOST_REAL_LIMITS.maxStderrBytes) { firstFailure = protocolError("stderr-limit", "Real LSP stderr exceeded its bound.", { stage }); for (const waiter of waiters.values()) waiter.reject(firstFailure); waiters.clear(); } } });
  child.stdin.on("error", (error) => { firstFailure ||= protocolError("process-crash", `Real LSP stdin failed: ${error.message}`, { stage }); });
  let preparedItem = null;
  let rawOutgoing = [];
  let rawOutgoingOriginal = null;
  let prepareResponseBody = null;
  let outgoingResponseBody = null;
  let normalizedRelations = [];
  let rangeCounts = { rawFromRangeCount: 0, uniqueFromRangeCount: 0, duplicateFromRangeCount: 0 };
  let failure = null;
  try {
    const rootUri = request.rootUris.nodeClientUri;
    const initialized = await requestWithDeadline("initialize", {
      processId: process.pid,
      clientInfo: { name: "head-agent-core-lsp-rq-fixture", version: "0.1.0" },
      locale: "en",
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: "head-lsp-rq-fixture" }],
      capabilities: {
        workspace: { applyEdit: false, configuration: true, workspaceFolders: true },
        textDocument: { synchronization: { dynamicRegistration: false, didSave: false, willSave: false, willSaveWaitUntil: false }, callHierarchy: { dynamicRegistration: false } },
        general: { positionEncodings: ["utf-16"] },
      },
      initializationOptions: {
        disableAutomaticTypingAcquisition: true, plugins: [], maxTsServerMemory: 512, locale: "en",
        tsserver: { path: profile.tsserver, useSyntaxServer: "never", logVerbosity: "off", trace: "off" },
      },
    }, "initialize");
    if (initialized?.capabilities?.callHierarchyProvider !== true) throw protocolError("unsupported-profile", "Pinned real server did not advertise call hierarchy support.", { stage });
    send({ jsonrpc: "2.0", method: "initialized", params: {} });
    stage = "open";
    for (const document of documents.filter((item) => item.languageId === "typescript")) {
      send({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: document.nodeClientUri, languageId: document.languageId, version: 1, text: document.text } } });
    }
    const prepareDocument = documents.find((item) => item.relativePath === request.prepare.path);
    if (!prepareDocument || prepareDocument.languageId !== "typescript") throw protocolError("mapping-mismatch", "Real prepare path is not an admitted source.", { stage: "prepare" });
    stage = "prepare";
    const prepared = await requestWithDeadline("textDocument/prepareCallHierarchy", { textDocument: { uri: prepareDocument.nodeClientUri }, position: request.prepare.position }, "prepare");
    if (!Array.isArray(prepared) || prepared.length !== 1) throw protocolError("invalid-prepare-result", "Real prepare result is not one exact item.", { stage });
    preparedItem = prepared[0];
    validateRealItem(preparedItem, documents);
    if (request.fault?.type === "delete-before-outgoing") {
      const target = documents.find((item) => item.relativePath === (request.fault.relativePath || "target.ts"));
      fs.unlinkSync(target.file);
    }
    verifyBridgeRealDocuments(documents, "hierarchy");
    stage = "hierarchy";
    const outgoing = await requestWithDeadline("callHierarchy/outgoingCalls", { item: preparedItem }, "hierarchy");
    rawOutgoingOriginal = structuredClone(outgoing);
    rawOutgoing = outgoing === null ? [] : outgoing;
    if (!Array.isArray(rawOutgoing)) throw protocolError("invalid-hierarchy-result", "Real outgoing result is not an array or null.", { stage });
    if (request.replayTransform === "add-admitted-self" && rawOutgoing.length > 0) rawOutgoing = [...rawOutgoing, { to: preparedItem, fromRanges: [preparedItem.selectionRange] }];
    ({ normalizedRelations, rangeCounts } = normalizeRealOutgoing(preparedItem, rawOutgoing, documents));
  } catch (error) { failure = firstFailure || error; }
  stage = "closing";
  if (heldProxyMessages.length > 0) {
    for (const held of heldProxyMessages) proxyEvent("proxy-dropped", { requestId: held.message.id, bytes: held.frame.length, reason: failure?.code || firstFailure?.code || "closing" });
    heldProxyMessages.length = 0;
  }
  clearInterval(cancelPoll);
  cancelPoll = null;
  for (const id of pending.outstanding()) { try { send({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } }); } catch {} }
  for (const document of documents.filter((item) => item.languageId === "typescript")) { try { send({ jsonrpc: "2.0", method: "textDocument/didClose", params: { textDocument: { uri: document.nodeClientUri } } }); } catch {} }
  if (!childClosed && !firstFailure) {
    try { await requestWithDeadline("shutdown", null, "closing"); } catch (error) { failure ||= error; }
    try { send({ jsonrpc: "2.0", method: "exit", params: null }); child.stdin.end(); } catch {}
  } else if (!childClosed) { try { child.stdin.end(); child.kill("SIGTERM"); } catch {} }
  const closed = await waitForChildCleanup(childExit, child, LSP_HOST_REAL_LIMITS.gracefulCleanupMs);
  try { parser.end(); } catch (error) { failure ||= error; }
  try { serverParser.end(); } catch (error) { failure ||= error; }
  failure ||= firstFailure;
  try { verifyBridgeRealDocuments(documents, "closing"); }
  catch (error) { failure ||= error; }
  const rawTranscriptDigest = sha256(canonicalJson(transcript));
  const rawOutgoingDigest = sha256(canonicalJson(rawOutgoingOriginal));
  const transformedOutgoingDigest = sha256(canonicalJson(rawOutgoing));
  const rawWireDigest = sha256(canonicalJson({ outbound: sha256(outboundWire), server: sha256(serverWire), bridgeInbound: sha256(inboundWire) }));
  const rawEvidence = {
    schemaVersion: 1,
    kind: "lsp-real-rq-raw-evidence",
    completeness: failure || closed.code !== 0 ? "partial" : "complete",
    outboundWire: { encoding: "base64", bytes: outboundWire.length, sha256: sha256(outboundWire), body: outboundWire.toString("base64") },
    inboundWire: { encoding: "base64", bytes: inboundWire.length, sha256: sha256(inboundWire), body: inboundWire.toString("base64") },
    serverOutboundWire: { encoding: "base64", bytes: serverWire.length, sha256: sha256(serverWire), body: serverWire.toString("base64") },
    transportProxy: {
      kind: "bounded-in-process-framed-pipe-proxy",
      originalDirection: "server-to-bridge",
      events: proxyEvents,
      heldMessageCount: proxyEvents.filter((event) => event.type === "proxy-held").length,
      droppedMessageCount: proxyEvents.filter((event) => event.type === "proxy-dropped").length,
      heldMessageCountAtPublication: heldProxyMessages.length,
    },
    rawWireDigest,
    transcript: { representation: "decoded-json-messages", sha256: rawTranscriptDigest, body: transcript },
    prepareResponse: prepareResponseBody === null ? null : { representation: "decoded-json-message", sha256: sha256(canonicalJson(prepareResponseBody)), body: prepareResponseBody },
    outgoingOriginalResponse: outgoingResponseBody === null ? null : { representation: "decoded-json-message", sha256: sha256(canonicalJson(outgoingResponseBody)), body: outgoingResponseBody },
    outgoingOriginalResult: { representation: "decoded-json-result", sha256: rawOutgoingDigest, body: rawOutgoingOriginal },
    outgoingTransformedResult: {
      representation: "decoded-json-result",
      sha256: transformedOutgoingDigest,
      body: rawOutgoing,
      transformId: request.replayTransform || null,
      transformVersion: request.replayTransform ? "lsp-real-rq-replay-v1" : null,
    },
  };
  const rawEvidenceDigest = sha256(canonicalJson(rawEvidence));
  const snapshotObservationDigest = sha256(canonicalJson({
    sources: documents.filter((item) => item.languageId === "typescript").map((item) => ({ path: item.relativePath, digest: item.digest })),
    configDigest: documents.find((item) => item.relativePath === "tsconfig.json")?.digest,
  }));
  const normalizedObservationDigest = sha256(canonicalJson({ snapshotObservationDigest, semanticProfileDigest: profile.semanticProfileDigest, normalizerVersion: profile.normalizerVersion, normalizedRelations }));
  const execution = {
    adapterDigest: sha256(fs.readFileSync(moduleFile)),
    profileManifestDigest: profile.manifestDigest,
    admissionManifestDigest: request.admissionManifestDigest,
    nodeDigest: profile.node.sha256,
    argv,
    envKeys: Object.keys(environment).sort(),
    envValueDigest: sha256(canonicalJson(environment)),
    pid: child.pid,
    parentPid: process.pid,
    command: [profile.node.path, ...argv].join(" "),
    cwd: request.snapshotRoot,
    ports: "none",
    rawTranscriptDigest,
    rawOutgoingDigest,
    transformedOutgoingDigest,
    rawWireDigest,
    rawEvidenceDigest,
    replayTransform: request.replayTransform || null,
    stderrDigest: sha256(stderr),
  };
  if (failure || closed.code !== 0) {
    const error = failure || protocolError("process-crash", "Pinned real LSP exited unexpectedly.", { stage });
    return realResult({ fixtureId: request.fixtureId, profileKind: profile.kind, status: ["source-drift", "config-drift", "profile-drift", "uri-outside-snapshot", "mapping-mismatch"].includes(error.code) ? "contaminated" : "failed", stage: "closed", reason: error.code || "launch-failed", cleanup: { attempted: true, verified: childClosed || closed.signal === "SIGTERM", forced: closed.signal === "SIGTERM" }, observation: { rawTranscriptDigest, rawOutgoingDigest, rawWireDigest, rawEvidence, rawEvidenceDigest, rangeCounts }, execution });
  }
  return realResult({
    fixtureId: request.fixtureId,
    profileKind: profile.kind,
    status: "completed",
    stage: "closed",
    reason: normalizedRelations.length > 0 ? "observed" : "empty",
    cleanup: { attempted: true, verified: true, forced: false },
    observation: { snapshotObservationDigest, rawTranscriptDigest, rawOutgoingDigest, transformedOutgoingDigest, rawWireDigest, rawEvidence, rawEvidenceDigest, rawOutgoingCount: Array.isArray(rawOutgoingOriginal) ? rawOutgoingOriginal.length : null, transformedOutgoingCount: rawOutgoing.length, rangeCounts, normalizedRelations, normalizedObservationDigest, semanticProfileDigest: profile.semanticProfileDigest },
    execution,
  });
}

function verifyRealAdmissionRequestShape(documents, admissionManifestDigest) {
  if (!/^[a-f0-9]{64}$/.test(admissionManifestDigest || "") || documents.some((document) => !document || typeof document.relativePath !== "string"
    || !Array.isArray(document.allowedUris) || document.allowedUris.length !== 2 || !document.allowedUris.includes(document.pinnedServerUri)
    || !document.allowedUris.includes(document.nodeClientUri) || !document.observedFileIdentity)) {
    throw protocolError("mapping-mismatch", "Real admission manifest shape is invalid.");
  }
  const payload = documents.map(({ relativePath, languageId, digest, bytes, nativeRealPathDigest, observedFileIdentity, allowedUris }) => ({ relativePath, languageId, digest, bytes, nativeRealPathDigest, observedFileIdentity, allowedUris }));
  if (sha256(canonicalJson(payload)) !== admissionManifestDigest) throw protocolError("mapping-mismatch", "Real admission manifest digest changed.");
}

async function collectRealOutgoingCallObservation({
  fixtureId,
  projectId,
  generationDigest,
  sources,
  tsconfigText,
  prepare,
  profileManifestFile,
  supervisorSelection,
  qaRoot,
  fault = null,
  replayTransform = null,
  onProcessEvent = () => {},
} = {}) {
  const collectionId = `lsp-real-${crypto.randomUUID()}`;
  const startedAt = Date.now();
  if (!profileManifestFile) return realResult({ fixtureId, status: "blocked", stage: "discovery", reason: "no-profile" });
  let descriptor;
  let profile;
  try {
    profile = verifyRealProfileManifest(profileManifestFile);
    if (typeof fixtureId !== "string" || !/^U0[1-7]$/.test(fixtureId)) throw protocolError("invalid-input", "Real fixture ID is invalid for the selected profile kind.");
    descriptor = createSnapshotDescriptor({ projectId, generationDigest, sources, tsconfigText });
    const expectedPaths = ["target.ts", "barrel.ts", "caller.ts", "tsconfig.json"];
    if (canonicalJson(descriptor.documents.map((item) => item.path)) !== canonicalJson(expectedPaths)) throw protocolError("invalid-input", "Real fixture source paths are not exact for the selected profile kind.");
    if (!supervisorSelection || typeof qaRoot !== "string" || !path.isAbsolute(qaRoot) || !fs.existsSync(qaRoot)) throw protocolError("unsupported-profile", "Real fixture requires a verified supervisor and existing QA root.");
  } catch (error) {
    return realResult({
      fixtureId,
      profileKind: profile?.kind,
      status: ["profile-drift", "source-drift", "config-drift"].includes(error.code) ? "contaminated" : "blocked",
      stage: "discovery",
      reason: error.code || "invalid-input",
    });
  }
  let ownedRoot;
  let admission;
  let supervised;
  let supervision;
  let result;
  let outerFailure = null;
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let softTimer;
  let forceTimer;
  let externalCancelTimer;
  let externalCancellationHostEvidence = null;
  let forced = false;
  let catchForced = false;
  try {
    ownedRoot = fs.mkdtempSync(path.join(fs.realpathSync(qaRoot), "lsp-real-"));
    safeOwnedRoot(qaRoot, ownedRoot);
    const snapshotRoot = path.join(ownedRoot, "snapshot");
    const runtimeRoot = path.join(ownedRoot, "runtime");
    fs.mkdirSync(snapshotRoot, { recursive: false });
    fs.mkdirSync(runtimeRoot, { recursive: false });
    admission = createRealAdmission(snapshotRoot, descriptor);
    verifyRealAdmission(admission, "launch");
    const rootNative = fs.realpathSync.native(snapshotRoot);
    const rootUris = { pinnedServerUri: serializePinnedTlsWindowsFixtureUri(rootNative), nodeClientUri: pathToFileURL(rootNative).href };
    const documents = admission.documents.map(({ handle, ...document }) => document);
    const externalCancellation = fault?.type === "cancel-during-prepare" ? (() => {
      const signalBytes = Buffer.from(canonicalJson({ collectionId, action: "cancel-prepare" }), "utf8");
      return {
        readyFile: path.join(runtimeRoot, "prepare-ready.json"),
        signalFile: path.join(runtimeRoot, "external-cancel.json"),
        signalBytes: signalBytes.length,
        signalDigest: sha256(signalBytes),
        signalBodyBase64: signalBytes.toString("base64"),
      };
    })() : null;
    const request = {
      schemaVersion: 1,
      fixtureId,
      collectionId,
      binding: { projectId, generationDigest, snapshotManifestDigest: descriptor.snapshotManifestDigest },
      profileManifestFile: profile.manifestFile,
      profileKind: profile.kind,
      profileManifestDigest: profile.manifestDigest,
      semanticProfileDigest: profile.semanticProfileDigest,
      admissionManifestDigest: admission.admissionManifestDigest,
      snapshotRoot: admission.root,
      runtimeRoot,
      rootUris,
      documents,
      prepare,
      fault,
      externalCancellation,
      replayTransform,
      deadlines: { workEpochMs: startedAt + LSP_HOST_REAL_LIMITS.workBudgetMs, closingEpochMs: startedAt + LSP_HOST_REAL_LIMITS.workBudgetMs + LSP_HOST_REAL_LIMITS.gracefulCleanupMs, totalEpochMs: startedAt + LSP_HOST_REAL_LIMITS.totalTimeoutMs },
    };
    const controlFile = path.join(ownedRoot, "supervisor-control.jsonl");
    supervised = spawnSupervisedProcess({
      selection: supervisorSelection,
      executablePath: process.execPath,
      args: [moduleFile, "--real-bridge"],
      cwd: path.dirname(moduleFile),
      providerEnvironment: { SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || "", PATH: process.env.PATH || "" },
      input: Buffer.from(canonicalJson(request), "utf8"),
      controlFile,
      terminationGraceMs: LSP_HOST_REAL_LIMITS.gracefulCleanupMs,
      onControlEvent: (event) => {
        if (event.type === "provider.started") onProcessEvent({ type: "spawn", pid: event.providerPid, parentPid: supervised?.child.pid || process.pid, command: "node lsp-host-bridge --real-bridge", cwd: path.dirname(moduleFile), ports: "none" });
        if (event.type === "provider.exited") onProcessEvent({ type: "exit", pid: event.providerPid, parentPid: supervised?.child.pid || process.pid, exitCode: event.exitCode, signal: "none" });
      },
    });
    onProcessEvent({ type: "spawn", pid: supervised.child.pid, parentPid: process.pid, command: path.basename(supervisorSelection.binaryPath), cwd: path.dirname(supervisorSelection.binaryPath), ports: "none" });
    if (externalCancellation) {
      externalCancelTimer = setInterval(() => {
        if (!fs.existsSync(externalCancellation.readyFile) || fs.existsSync(externalCancellation.signalFile)) return;
        try {
          const readyBytes = fs.readFileSync(externalCancellation.readyFile);
          const signalBytes = Buffer.from(externalCancellation.signalBodyBase64, "base64");
          fs.writeFileSync(externalCancellation.signalFile, signalBytes, { flag: "wx" });
          externalCancellationHostEvidence = {
            kind: "external-host-cancellation-signal",
            readyDigest: sha256(readyBytes),
            signalDigest: sha256(signalBytes),
            signalBytes: signalBytes.length,
            writtenAtEpochMs: Date.now(),
          };
          clearInterval(externalCancelTimer);
          externalCancelTimer = null;
        } catch (error) {
          outerFailure ||= protocolError("mapping-mismatch", `External cancellation publication failed: ${error.message}`, { stage: "prepare" });
          clearInterval(externalCancelTimer);
          externalCancelTimer = null;
          supervised.terminate(false);
        }
      }, 5);
      externalCancelTimer.unref?.();
    }
    const stop = (reason, force = false) => { outerFailure ||= protocolError(reason, `Real LSP Host ${reason}.`, { stage: "closing" }); forced ||= force; supervised.terminate(force); };
    softTimer = setTimeout(() => stop("request-timeout", false), Math.max(1, request.deadlines.closingEpochMs - Date.now()));
    forceTimer = setTimeout(() => stop("request-timeout", true), Math.max(1, request.deadlines.totalEpochMs - Date.now()));
    supervised.child.stdout.on("data", (chunk) => { if (!outerFailure) { if (stdout.length + chunk.length > LSP_HOST_REAL_LIMITS.maxStdoutBytes) stop("stdout-limit"); else stdout = Buffer.concat([stdout, chunk]); } });
    supervised.child.stderr.on("data", (chunk) => { if (!outerFailure) { if (stderr.length + chunk.length > LSP_HOST_REAL_LIMITS.maxStderrBytes) stop("stderr-limit"); else stderr = Buffer.concat([stderr, chunk]); } });
    const closed = await waitForClose(supervised.child);
    onProcessEvent({ type: "exit", pid: supervised.child.pid, parentPid: process.pid, exitCode: closed.code, signal: closed.signal || "none" });
    clearTimeout(softTimer); clearTimeout(forceTimer);
    supervision = supervised.finalize({ exactSupervisorExitObserved: true, terminationRequested: Boolean(outerFailure) });
    const lines = stdout.toString("utf8").split(/\r?\n/).filter(Boolean);
    if (lines.length !== 1) throw protocolError("invalid-message", "Real bridge did not emit exactly one result envelope.", { stage: "closing" });
    result = JSON.parse(lines[0]);
    verifyRealAdmission(admission, "closing");
    const finalProfile = verifyRealProfileManifest(profileManifestFile);
    if (finalProfile.manifestDigest !== profile.manifestDigest || finalProfile.semanticProfileDigest !== profile.semanticProfileDigest) throw protocolError("profile-drift", "Real profile changed before publication.", { stage: "closing" });
    if (outerFailure) throw outerFailure;
    if (!supervision.ownershipEstablished || !supervision.treeCleanupVerified) throw protocolError("cleanup-failed", "Real LSP process tree cleanup was not verified.", { stage: "closing" });
    if (closed.code !== 0) throw protocolError("process-crash", `Real bridge exited ${closed.code}: ${stderr.toString("utf8").slice(0, 512)}`, { stage: "launch" });
    result = Object.freeze({
      ...result,
      cleanup: { attempted: true, verified: true, forced },
      transport: { supervisorManifestDigest: supervision.supervisorManifestDigest, ownershipEstablished: supervision.ownershipEstablished, treeCleanupVerified: supervision.treeCleanupVerified, externalCancellationHostEvidence },
    });
  } catch (error) {
    if (supervised?.child && supervised.child.exitCode === null && supervised.child.signalCode === null) { catchForced = true; supervised.terminate(true); try { await waitForClose(supervised.child); } catch {} }
    if (supervised && !supervision) { try { supervision = supervised.finalize({ exactSupervisorExitObserved: true, terminationRequested: true }); } catch {} }
    const failureFields = {
      status: ["source-drift", "config-drift", "profile-drift", "mapping-mismatch"].includes(error.code) ? "contaminated" : "failed",
      stage: "closed",
      reason: error.code || "launch-failed",
      cleanup: { attempted: Boolean(supervised), verified: supervision?.treeCleanupVerified === true, forced: forced || catchForced },
      publishedCandidateCount: 0,
      ...REAL_RESULT_GATE,
    };
    const expectedEvidenceKind = "lsp-real-rq-observation";
    result = result?.evidenceKind === expectedEvidenceKind
      ? Object.freeze({ ...result, ...failureFields, transport: { supervisorManifestDigest: supervision?.supervisorManifestDigest || null, ownershipEstablished: supervision?.ownershipEstablished === true, treeCleanupVerified: supervision?.treeCleanupVerified === true, externalCancellationHostEvidence } })
      : realResult({ fixtureId, profileKind: profile?.kind, ...failureFields });
  } finally {
    clearTimeout(softTimer); clearTimeout(forceTimer); clearInterval(externalCancelTimer);
    closeRealAdmission(admission);
    if (ownedRoot) { try { removeOwnedRoot(qaRoot, ownedRoot); } catch {
      result = realResult({ fixtureId, status: "failed", stage: "closed", reason: "cleanup-failed", cleanup: { attempted: true, verified: false, forced: true } });
    } }
  }
  return result;
}

function positionOf(text, needle) {
  const offset = text.indexOf(needle);
  if (offset < 0) throw protocolError("invalid-input", `Fixture marker ${needle} is missing.`);
  const before = text.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length - 1, character: lines.at(-1).replace(/\r$/, "").length };
}

function validateMessageBase(message) {
  if (message.jsonrpc !== "2.0") throw protocolError("invalid-message", "LSP message lacks jsonrpc 2.0.");
}

function validateItem(item, documents, collectionId, expected = null) {
  if (!item || typeof item !== "object" || typeof item.name !== "string" || typeof item.kind !== "number") throw protocolError("invalid-hierarchy-result", "Call hierarchy item is invalid.");
  const allowed = new Set(documents.map((document) => document.relativePath));
  const relativePath = relativePathFromUri(item.uri, collectionId, allowed);
  const document = documents.find((candidate) => candidate.relativePath === relativePath);
  const itemRange = validateRange(document.text, item.range);
  const selectionRange = validateRange(document.text, item.selectionRange);
  if (selectionRange.start < itemRange.start || selectionRange.end > itemRange.end) throw protocolError("invalid-range", "Call hierarchy selectionRange escaped its symbol range.");
  if (expected && (item.name !== expected.name || item.kind !== 12 || item.uri !== document.uri
    || expected.uri && item.uri !== expected.uri
    || canonicalJson(item.range) !== canonicalJson(expected.range)
    || canonicalJson(item.selectionRange) !== canonicalJson(expected.selectionRange))) {
    throw protocolError("mapping-mismatch", "Call hierarchy item does not match the requested fixture declaration.");
  }
  return { relativePath, document };
}

async function runBridge(request) {
  const binding = request?.binding;
  const documents = request?.documents;
  verifyOwnershipBinding(request?.expectedBinding, binding);
  const cancelArg = process.argv.indexOf("--cancel-file");
  if (!Array.isArray(documents) || documents.length !== 4 || !path.isAbsolute(request?.cancelFile || "")
    || cancelArg < 0 || process.argv[cancelArg + 1] !== request.cancelFile
    || !request.deadlines || ![request.deadlines.workEpochMs, request.deadlines.closingEpochMs, request.deadlines.totalEpochMs].every(Number.isSafeInteger)
    || request.deadlines.workEpochMs > request.deadlines.closingEpochMs || request.deadlines.closingEpochMs > request.deadlines.totalEpochMs
    || canonicalJson(request.profile?.producerDigest) !== canonicalJson(binding.producerDigest)) {
    throw protocolError("mapping-mismatch", "Bridge input ownership or deadline mapping is invalid.", { stage: "launch" });
  }
  if (request.profile.serverDigest !== sha256(fs.readFileSync(request.profile.serverFile)) || request.profile.nodeDigest !== sha256(fs.readFileSync(process.execPath))) {
    throw protocolError("producer-mismatch", "Bridge producer changed after Host admission.", { stage: "launch" });
  }
  for (const document of documents) {
    if (Buffer.byteLength(document.text, "utf8") !== document.bytes || sha256(Buffer.from(document.text, "utf8")) !== document.digest) {
      throw protocolError(document.relativePath === "tsconfig.json" ? "config-drift" : "source-drift", "Bridge snapshot bytes changed.", { stage: "launch" });
    }
  }
  const child = spawn(process.execPath, [request.profile.serverFile, request.scenario], {
    cwd: path.dirname(request.profile.serverFile),
    env: { SystemRoot: process.env.SystemRoot || process.env.SYSTEMROOT || "", PATH: process.env.PATH || "", LANG: "C" },
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const parser = new LspFrameParser();
  const pending = createPendingTable(binding);
  const waiters = new Map();
  const opened = [];
  const transcript = [];
  const fixtureOwnedProcesses = [{ pid: child.pid, parentPid: process.pid, observedAt: new Date().toISOString(), command: "node lsp-host-fake-server", cwd: path.dirname(request.profile.serverFile), ports: "none" }];
  let stage = "initialize";
  let notificationCount = 0;
  let stderrBytes = 0;
  let firstAsyncFailure = null;
  let fatalTransport = false;
  let childClosed = false;

  const settleOutstanding = (error, fatal = false) => {
    firstAsyncFailure ||= error;
    fatalTransport ||= fatal;
    for (const waiter of waiters.values()) waiter.reject(firstAsyncFailure);
    waiters.clear();
  };
  const send = (message) => {
    if (childClosed || child.stdin.destroyed) throw protocolError("process-crash", "LSP transport is closed.", { stage });
    transcript.push({ direction: "out", method: message.method || null, id: message.id ?? null });
    child.stdin.write(encodeLspMessage(message));
  };
  const requestWithDeadline = (method, params, requestStage, deadlineEpochMs) => {
    if (fatalTransport) return Promise.reject(firstAsyncFailure);
    const remaining = Math.min(LSP_HOST_LIMITS.requestTimeoutMs, deadlineEpochMs - Date.now());
    if (remaining <= 0) return Promise.reject(protocolError("request-timeout", `LSP ${requestStage} exhausted its shared deadline.`, { stage: requestStage }));
    const id = pending.issue(method);
    send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(protocolError("request-timeout", `LSP ${requestStage} request timed out.`, { stage: requestStage }));
      }, remaining);
      waiters.set(id, {
        method,
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
  };
  const serverRequestResponse = (message) => {
    const id = message.id;
    if (message.method === "workspace/configuration") {
      if (!Array.isArray(message.params?.items) || message.params.items.length > LSP_HOST_LIMITS.maxConfigurationItems) throw protocolError("limit-exceeded", "workspace/configuration exceeded its item bound.", { stage });
      send({ jsonrpc: "2.0", id, result: message.params.items.map(() => null) });
    } else if (message.method === "workspace/applyEdit") {
      send({ jsonrpc: "2.0", id, result: { applied: false, failureReason: "HEAD LSP Host profile is read-only" } });
    } else if (message.method === "window/workDoneProgress/create") {
      const token = message.params?.token;
      if (!(typeof token === "string" || typeof token === "number") || String(token).length > 256) throw protocolError("invalid-message", "Progress token is invalid.", { stage });
      send({ jsonrpc: "2.0", id, result: null });
    } else if (message.method === "window/showMessageRequest") {
      const params = message.params;
      const actions = params?.actions;
      if (!params || !Number.isSafeInteger(params.type) || params.type < 1 || params.type > 4
        || typeof params.message !== "string" || params.message.length > 4096
        || actions !== undefined && (!Array.isArray(actions) || actions.length > 16
          || actions.some((item) => !item || typeof item !== "object" || typeof item.title !== "string" || item.title.length < 1 || item.title.length > 256))) {
        throw protocolError("invalid-message", "showMessageRequest is invalid.", { stage });
      }
      send({ jsonrpc: "2.0", id, result: null });
    } else {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not supported" } });
      throw protocolError("unsupported-server-request", "LSP server requested an unsupported Host operation.", { stage });
    }
  };
  const allowedNotifications = new Set(["window/logMessage", "window/showMessage", "$/progress", "textDocument/publishDiagnostics", "_typescript.version", "telemetry/event"]);
  const requestFailureStage = (method) => method === "textDocument/prepareCallHierarchy" ? "prepare"
    : method === "callHierarchy/outgoingCalls" ? "hierarchy"
      : method === "initialize" ? "initialize"
        : null;
  const handle = (message) => {
    validateMessageBase(message);
    transcript.push({ direction: "in", method: message.method || null, id: message.id ?? null });
    if ("method" in message && "id" in message) return serverRequestResponse(message);
    if ("method" in message) {
      notificationCount += 1;
      if (notificationCount > LSP_HOST_LIMITS.maxNotifications) throw protocolError("notification-limit", "LSP notification count exceeded its bound.", { stage });
      if (!allowedNotifications.has(message.method)) throw protocolError("unsupported-server-notification", "LSP server emitted an unsupported notification.", { stage });
      if (message.method === "telemetry/event" && Number.isSafeInteger(message.params?.headTestDescendantPid) && message.params.headTestDescendantPid > 0) {
        fixtureOwnedProcesses.push({ pid: message.params.headTestDescendantPid, parentPid: child.pid, observedAt: new Date().toISOString(), command: "node lsp-host-child", cwd: path.dirname(request.profile.serverFile), ports: "none" });
      }
      return;
    }
    const entry = pending.consume(message, binding);
    const waiter = waiters.get(message.id);
    if (!waiter) throw protocolError("late-response", "LSP response arrived after its bounded waiter closed.", { stage });
    if (waiter.method !== entry.method) throw protocolError("mapping-mismatch", "Bridge pending table diverged from the response waiter.", { stage });
    waiters.delete(message.id);
    if ("error" in message) waiter.reject(protocolError("invalid-message", `LSP request ${entry.method} failed.`, { stage }));
    else waiter.resolve(message.result);
  };
  child.stdout.on("data", (chunk) => {
    if (fatalTransport) return;
    try { for (const message of parser.feed(chunk)) handle(message); }
    catch (error) { settleOutstanding(Object.assign(error, { details: { ...error.details, stage: error.details?.stage || requestFailureStage(error.details?.method) || stage } }), true); child.stdout.pause(); }
  });
  child.stderr.on("data", (chunk) => {
    if (fatalTransport) return;
    stderrBytes += chunk.length;
    if (stderrBytes > LSP_HOST_LIMITS.maxStderrBytes) {
      settleOutstanding(protocolError("stderr-limit", "LSP stderr exceeded its bound.", { stage }), true);
      child.stderr.destroy();
    }
  });
  child.stdin.on("error", (error) => settleOutstanding(protocolError("process-crash", `LSP stdin failed: ${error.message}`, { stage }), true));
  const childExit = new Promise((resolve) => child.once("close", (code, signal) => {
    childClosed = true;
    if (waiters.size > 0) settleOutstanding(protocolError("process-crash", "Fake LSP server exited with outstanding requests.", { stage }), true);
    resolve({ code, signal });
  }));
  const cancelPoll = setInterval(() => {
    if (!firstAsyncFailure && fs.existsSync(request.cancelFile)) settleOutstanding(protocolError("cancelled", "LSP collection was cancelled by its Host owner.", { stage }), false);
  }, 10);
  cancelPoll.unref?.();

  let candidates = [];
  let reason = "empty";
  let failure = null;
  const caller = documents.find((item) => item.relativePath === "caller.ts");
  const barrelDocument = documents.find((item) => item.relativePath === "barrel.ts");
  const targetDocument = documents.find((item) => item.relativePath === "target.ts");
  const callerIdentity = caller ? boundedFixtureFunctionIdentity(caller.text, "caller") : null;
  const targetIdentity = targetDocument ? boundedFixtureFunctionIdentity(targetDocument.text, "target") : null;
  try {
    const initialized = await requestWithDeadline("initialize", { processId: process.pid, rootUri: null, capabilities: {} }, "initialize", request.deadlines.workEpochMs);
    if (!initialized || typeof initialized !== "object") throw protocolError("invalid-message", "LSP initialize result is invalid.", { stage });
    send({ jsonrpc: "2.0", method: "initialized", params: {} });
    stage = "open";
    for (const document of documents.filter((item) => item.languageId === "typescript")) {
      send({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: document.uri, languageId: document.languageId, version: 1, text: document.text } } });
      opened.push(document);
    }
    if (!caller || !callerIdentity) { reason = "no-prepared-item"; }
    else {
      stage = "prepare";
      const prepared = await requestWithDeadline("textDocument/prepareCallHierarchy", { textDocument: { uri: caller.uri }, position: callerIdentity.selectionRange.start }, "prepare", request.deadlines.workEpochMs);
      if (prepared === null || Array.isArray(prepared) && prepared.length === 0) reason = "no-prepared-item";
      else {
        if (!Array.isArray(prepared)) throw protocolError("invalid-prepare-result", "prepareCallHierarchy did not return an array or null.", { stage });
        if (prepared.length !== 1) throw protocolError("ambiguous-prepared-item", "prepareCallHierarchy returned more than one item.", { stage });
        const preparedCaller = validateItem(prepared[0], documents, binding.collectionId, { ...callerIdentity, uri: caller.uri });
        if (preparedCaller.relativePath !== "caller.ts") throw protocolError("mapping-mismatch", "Prepared item changed the fixture caller document.", { stage });
        stage = "hierarchy";
        const outgoing = await requestWithDeadline("callHierarchy/outgoingCalls", { item: prepared[0] }, "hierarchy", request.deadlines.workEpochMs);
        if (outgoing === null || Array.isArray(outgoing) && outgoing.length === 0) reason = "empty";
        else {
          if (!Array.isArray(outgoing) || outgoing.length > 256) throw protocolError("invalid-hierarchy-result", "outgoingCalls did not return a bounded array or null.", { stage });
          if (!targetIdentity) throw protocolError("mapping-mismatch", "Outgoing target fixture declaration is missing.", { stage });
          const route = boundedFixtureModuleRoute(caller.text, barrelDocument?.text || "");
          const allowedRanges = route ? boundedFixtureCallRanges(caller.text, callerIdentity, "target") : [];
          const allowedKeys = new Set(allowedRanges.map(canonicalJson));
          const observedKeys = new Set();
          for (const relation of outgoing) {
            if (!relation || !Array.isArray(relation.fromRanges) || relation.fromRanges.length < 1 || relation.fromRanges.length > 256) throw protocolError("invalid-hierarchy-result", "Outgoing call relation is invalid.", { stage });
            const target = validateItem(relation.to, documents, binding.collectionId, targetIdentity);
            if (target.relativePath !== "target.ts") throw protocolError("mapping-mismatch", "Outgoing relation changed the fixture target document.", { stage });
            for (const fromRange of relation.fromRanges) {
              validateRange(caller.text, fromRange);
              const key = canonicalJson(fromRange);
              if (!allowedKeys.has(key)) throw protocolError("mapping-mismatch", "Outgoing callsite does not match an actual fixture call expression.", { stage });
              observedKeys.add(key);
              const candidate = { direction: "outgoing", caller: { path: "caller.ts", range: fromRange }, target: { path: "target.ts", range: relation.to.selectionRange, name: relation.to.name } };
              candidates.push({ ...candidate, semanticDigest: relationSemanticDigest({
                projectId: binding.projectId, generationDigest: binding.generationDigest, snapshotManifestDigest: binding.snapshotManifestDigest,
                producerDigest: binding.producerDigest, direction: candidate.direction, callerPath: candidate.caller.path,
                callerRange: candidate.caller.range, targetPath: candidate.target.path, targetRange: candidate.target.range,
              }) });
            }
          }
          if (observedKeys.size !== allowedKeys.size || [...allowedKeys].some((key) => !observedKeys.has(key))) throw protocolError("invalid-hierarchy-result", "Outgoing result omitted an admitted fixture callsite.", { stage });
          candidates = [...new Map(candidates.map((candidate) => [candidate.semanticDigest, candidate])).values()]
            .sort((left, right) => left.semanticDigest < right.semanticDigest ? -1 : left.semanticDigest > right.semanticDigest ? 1 : 0);
          reason = candidates.length > 0 ? "candidates" : "empty";
        }
      }
    }
  } catch (error) {
    failure = firstAsyncFailure || error;
  }

  const originalFailure = failure || firstAsyncFailure;
  stage = "closing";
  if (originalFailure) {
    for (const id of pending.outstanding()) { try { send({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } }); } catch {} }
  }
  for (const document of opened) { try { send({ jsonrpc: "2.0", method: "textDocument/didClose", params: { textDocument: { uri: document.uri } } }); } catch {} }
  if (fatalTransport && !childClosed) {
    try { child.stdin.end(); child.kill("SIGTERM"); } catch {}
  } else if (!childClosed) {
    const closingDeadline = Math.min(request.deadlines.closingEpochMs, Date.now() + LSP_HOST_LIMITS.gracefulCleanupMs);
    try { await requestWithDeadline("shutdown", null, "closing", closingDeadline); }
    catch (error) { failure ||= originalFailure || firstAsyncFailure || error; }
    try { send({ jsonrpc: "2.0", method: "exit", params: null }); child.stdin.end(); } catch {}
  }
  const closed = await waitForChildCleanup(childExit, child, Math.max(1, Math.min(LSP_HOST_LIMITS.gracefulCleanupMs, request.deadlines.totalEpochMs - Date.now())));
  clearInterval(cancelPoll);
  try { parser.end(); } catch (error) { failure ||= originalFailure || firstAsyncFailure || Object.assign(error, { details: { ...error.details, stage: error.details?.stage || stage } }); }
  failure ||= originalFailure || firstAsyncFailure;
  if (closed.code !== 0 && !failure) failure = protocolError("process-crash", "Fake LSP server exited unexpectedly.", { stage });
  if (failure) return Object.freeze({
    ...terminalFromError(failure, binding, { attempted: true, verified: childClosed || closed.signal === "SIGTERM", forced: closed.signal === "SIGTERM" }, failure.details?.stage || stage),
    fixtureTransport: { ownedPids: fixtureOwnedProcesses.map((item) => item.pid), ownedProcesses: fixtureOwnedProcesses, transcript },
  });
  return Object.freeze({
    ...terminalResult({ status: "completed", reason, stage: "closed", provenance: binding, candidates, cleanup: { attempted: true, verified: true, forced: false } }),
    fixtureTransport: { ownedPids: fixtureOwnedProcesses.map((item) => item.pid), ownedProcesses: fixtureOwnedProcesses, transcript },
  });
}

async function readStdinBounded() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > 4 * 1024 * 1024) throw protocolError("limit-exceeded", "Bridge input exceeded its transport bound.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile && ["--bridge", "--real-bridge"].includes(process.argv[2])) {
  try {
    const request = await readStdinBounded();
    const result = process.argv[2] === "--real-bridge" ? await runRealBridge(request) : await runBridge(request);
    process.stdout.write(`${canonicalJson(result)}\n`);
  } catch (error) {
    const fallback = terminalFromError(error, {}, { attempted: true, verified: false, forced: false }, error?.details?.stage || "launch");
    process.stdout.write(`${canonicalJson(fallback)}\n`);
  }
}

export const __private = Object.freeze({
  ALLOWED_SCENARIOS,
  collectRealOutgoingCallObservation,
  normalizeRealOutgoing,
  realServerRequestReply,
  runBridge,
  runRealBridge,
  safeOwnedRoot,
  profileProvenance,
  verifyRealProfileManifest,
});

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectId = "project-release-reader-fixture";
const directories = [".head/release-observations/branch-states", ".head/release-observations/deployment-results", ".head/release-observations/releases"];
const ownedRoots = new Set();
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const canonicalJson = value => JSON.stringify(canonical(value));
const clone = value => structuredClone(value);
function identify(document, prefix, idField, hashField) {
  const payload = { ...document }; delete payload[idField]; delete payload[hashField];
  const hash = sha(canonicalJson(payload));
  return { ...payload, [idField]: `${prefix}-${hash.slice(0, 24)}`, [hashField]: hash };
}
const branchIdentity = value => identify(value, "branch-state-observation", "branchStateObservationId", "branchStateObservationHash");
const deploymentIdentity = value => identify(value, "deployment-result-observation", "deploymentResultObservationId", "deploymentResultObservationHash");
const releaseIdentity = value => identify(value, "release-observation", "releaseObservationId", "releaseObservationHash");
const projectionIdentity = value => identify(value, "release-observation-projection", "projectionInputId", "projectionInputHash");

export function readerDocuments() {
  const commit = "a".repeat(40);
  const commitObservation = identify({ schemaVersion: 1, kind: "GitCommitObservation",
    protocol: { name: "head-agent-core-git-commit-observation", version: "0.1.0" }, vcsKind: "git", objectId: commit,
    parents: [], authoredAt: "2026-09-01T00:00:00.000Z", committedAt: "2026-09-01T00:00:00.000Z",
    author: { name: "Reader fixture" }, authorEmailDigest: sha("reader@example.invalid"), refs: ["refs/heads/main"],
    subject: "Stored reader fixture", body: "", evidence: { sourceKind: "git-commit-object", uri: `git:${commit}`, digest: commit, instructionAuthority: false },
    authority: "derived-vcs-observation", trustBoundary: "evidence-not-instruction", instructionAuthority: false, promotionAuthority: false,
  }, "git-commit-observation", "gitCommitObservationId", "gitCommitObservationHash");
  const flags = { epistemicClass: "observed-fact", instructionAuthority: false, promotionAuthority: false, mutatesCanon: false, recoveryAuthority: false };
  const branch = branchIdentity({ schemaVersion: 1, kind: "BranchStateObservation", protocol: { name: "head-agent-core-release-observation", version: "0.1.0" },
    projectId, vcsKind: "git", ref: "refs/heads/main", refKind: "branch", commit, referencesDigest: sha("refs"), commitObservation,
    ...flags, authority: "non-authoritative-branch-state-observation" });
  const deployment = deploymentIdentity({ schemaVersion: 1, kind: "DeploymentResultObservation", protocol: { name: "head-agent-core-release-observation", version: "0.1.0" },
    projectId, environmentKey: "production", status: "succeeded", commit, observedAt: "2026-09-01T00:00:00.000Z",
    sourceEventKeyDigest: sha("source-event"), deploymentEvidenceDigest: sha("deployment"), approved: true, approvalEvidenceDigest: sha("approval"),
    changeSetId: `change-set-${"1".repeat(24)}`, vcsEvidenceId: `vcs-evidence-${"2".repeat(24)}`,
    ...flags, authority: "non-authoritative-deployment-result-observation" });
  const release = releaseIdentity({ schemaVersion: 1, kind: "ReleaseObservation", protocol: { name: "head-agent-core-release-observation", version: "0.1.0" },
    projectId, environmentKey: deployment.environmentKey, commit, deploymentResultObservationId: deployment.deploymentResultObservationId,
    branchStateObservationIds: [branch.branchStateObservationId], changeSetId: deployment.changeSetId, vcsEvidenceId: deployment.vcsEvidenceId,
    ...flags, authority: "non-authoritative-release-observation" });
  return { branch, deployment, release };
}

function projection(documents = readerDocuments()) {
  return projectionIdentity({ schemaVersion: 1, kind: "ReleaseObservationProjectionInput",
    protocol: { name: "head-agent-core-release-observation-projection", version: "0.1.0" }, projectId,
    commonObservationContract: { protocol: { name: "head-agent-core-observation", version: "0.1.0" },
      role: "domain-specialization-with-exact-git-and-approved-deployment-lineage", genericReplacement: false, semanticAuthority: false },
    branchStates: [documents.branch], deploymentResults: [documents.deployment], releases: [documents.release],
    authority: "derived-projection-input-not-release-authority", instructionAuthority: false, promotionAuthority: false });
}
const json = value => `${JSON.stringify(value, null, 2)}\n`;
function normalFiles(documents = readerDocuments()) {
  return [documents.branch, documents.deployment, documents.release].map((document, index) => ({
    path: `${directories[index]}/${index === 0 ? "z" : "a"}.json`, content: json(document),
  }));
}
function errorExpected(code, message, name = "Error") { return { name, code, message }; }
function pureCase(id, method, input, expected = null) { return { id, files: [], pure: true, method, input, expected }; }

export function readerScenarios() {
  const documents = readerDocuments(), base = projection(documents);
  const loader = (id, files, expected = null, extra = {}) => ({ id, files, expected, ...extra });
  const pureProjection = (id, edit, expected) => { const input = clone(base); edit(input); return pureCase(id, "verifyReleaseObservationProjectionInput", projectionIdentity(input), expected); };
  const releaseLineage = message => errorExpected("INVALID_RELEASE_OBSERVATION_LINEAGE", message);
  const cases = [
    loader("R1-missing-directories", []),
    loader("R1-empty-directories", [], null, { directories }),
    loader("R2-normal-sorted-records", [...normalFiles(), { path: `${directories[0]}/a.json`, content: json(branchIdentity({ ...documents.branch, ref: "refs/heads/secondary" })) }]),
    loader("R2-historical-no-current-source-reread", [...normalFiles(),
      { path: ".head/change-sets/records/corrupt.json", content: "not a current ChangeSet" },
      { path: ".head/sessions/current.json", content: "not current Session JSON" }, { path: ".git/HEAD", content: "not current Git" },
      { path: "src/deleted-source.txt", content: "current source differs" }]),
    loader("R3-ineligible-stored-deployments", [
      ...normalFiles().slice(0, 1),
      ...[{ status: "failed" }, { approved: false, approvalEvidenceDigest: null }, { commit: "b".repeat(40) }].map((edit, index) => ({
        path: `${directories[1]}/${index}.json`, content: json(deploymentIdentity({ ...documents.deployment, ...edit, sourceEventKeyDigest: sha(`ineligible:${index}`) })),
      })),
    ]),
    loader("R3-identical-event-stored-once", normalFiles()),
    loader("R4-deleted-deployment", normalFiles().filter((_, index) => index !== 1), releaseLineage("ReleaseObservation deployment lineage is invalid.")),
    loader("R4-deleted-branch", normalFiles().filter((_, index) => index !== 0), releaseLineage("ReleaseObservation branch lineage is invalid.")),
    loader("R4-corrupt-json", [{ path: `${directories[0]}/broken.json`, content: "{broken" }], { name: "SyntaxError" }),
    loader("R4-record-digest-tamper", normalFiles({ ...documents, branch: { ...documents.branch, ref: "refs/heads/tampered" } }), errorExpected("RELEASE_OBSERVATION_DIGEST_MISMATCH", "BranchStateObservation digest verification failed.")),
    loader("R4-record-owner-tamper", normalFiles({ ...documents, branch: branchIdentity({ ...documents.branch, projectId: "another-project" }) }), errorExpected("INVALID_BRANCH_STATE_OBSERVATION", "BranchStateObservation fields or authority are invalid.")),
    { ...pureCase("R5-valid-return-identity", "all", { ...clone(documents), projection: clone(base) }), validIdentity: true },
    pureCase("R5-null-native-TypeError", "verifyBranchStateObservation", null, { name: "TypeError" }),
    pureCase("R5-digest-before-owner", "verifyBranchStateObservation", { ...documents.branch, projectId: "another-project" }, errorExpected("RELEASE_OBSERVATION_DIGEST_MISMATCH", "BranchStateObservation digest verification failed.")),
    pureCase("R5-stable-key-native-code", "verifyDeploymentResultObservation", deploymentIdentity({ ...documents.deployment, environmentKey: "bad key" }), errorExpected("INVALID_RELEASE_OBSERVATION_INPUT", "Deployment environmentKey is not a stable key.")),
    pureCase("R5-duplicate-before-projection-digest", "verifyReleaseObservationProjectionInput", { ...clone(base), branchStates: [documents.branch, documents.branch], projectionInputHash: "0".repeat(64) }, errorExpected("DUPLICATE_BRANCH_STATE_OBSERVATION", "Duplicate BranchStateObservation.")),
    pureProjection("R6-duplicate-deployment", p => p.deploymentResults.push(clone(p.deploymentResults[0])), errorExpected("DUPLICATE_DEPLOYMENT_RESULT_OBSERVATION", "Duplicate DeploymentResultObservation.")),
    pureProjection("R6-divergent-source-event", p => p.deploymentResults.push(deploymentIdentity({ ...p.deploymentResults[0], status: "cancelled" })), errorExpected("DIVERGENT_DEPLOYMENT_RESULT_REPLAY", "Deployment source event has divergent persisted observations.")),
    pureProjection("R6-duplicate-release", p => p.releases.push(clone(p.releases[0])), errorExpected("DUPLICATE_RELEASE_OBSERVATION", "Duplicate ReleaseObservation.")),
    pureProjection("R6-ineligible-deployment-lineage", p => {
      p.deploymentResults[0] = deploymentIdentity({ ...p.deploymentResults[0], status: "failed", approved: false, approvalEvidenceDigest: null });
      p.releases[0] = releaseIdentity({ ...p.releases[0], deploymentResultObservationId: p.deploymentResults[0].deploymentResultObservationId });
    }, releaseLineage("ReleaseObservation deployment lineage is invalid.")),
    pureProjection("R6-branch-commit-lineage", p => {
      p.releases[0] = releaseIdentity({ ...p.releases[0], commit: "b".repeat(40) });
      p.deploymentResults[0] = deploymentIdentity({ ...p.deploymentResults[0], commit: "b".repeat(40) });
      p.releases[0] = releaseIdentity({ ...p.releases[0], deploymentResultObservationId: p.deploymentResults[0].deploymentResultObservationId });
    }, releaseLineage("ReleaseObservation branch lineage is invalid.")),
    pureCase("R6-projection-digest-only", "verifyReleaseObservationProjectionInput", { ...clone(base), projectionInputHash: "0".repeat(64) }, errorExpected("RELEASE_OBSERVATION_PROJECTION_DIGEST_MISMATCH", "Release observation projection digest verification failed.")),
    loader("R7-symlink-ancestor", [], errorExpected("RELEASE_OBSERVATION_SYMLINK_PATH", "Release observation path traverses a symlink."), { symlink: "ancestor" }),
    loader("R7-json-directory", [], errorExpected("RELEASE_OBSERVATION_LIMIT", "BranchStateObservation artifact is unsafe or too large."), { directories: [`${directories[0]}/unsafe.json`] }),
    loader("R7-json-file-symlink", [], errorExpected("RELEASE_OBSERVATION_LIMIT", "BranchStateObservation artifact is unsafe or too large."), { symlink: "file" }),
    loader("R7-count-bound", Array.from({ length: 1025 }, (_, index) => ({ path: `${directories[0]}/${String(index).padStart(4, "0")}.json`, content: "{}" })), errorExpected("RELEASE_OBSERVATION_LIMIT", "BranchStateObservation count exceeds the configured limit.")),
    loader("R7-artifact-byte-bound", [{ path: `${directories[0]}/large.json`, content: " ".repeat(1024 * 1024 + 1) }], errorExpected("RELEASE_OBSERVATION_LIMIT", "BranchStateObservation artifact is unsafe or too large.")),
    loader("R7-directory-byte-bound", Array.from({ length: 33 }, (_, index) => ({ path: `${directories[0]}/${String(index).padStart(2, "0")}.json`, content: "{}" + " ".repeat(1024 * 1024 - 2) })), errorExpected("RELEASE_OBSERVATION_LIMIT", "BranchStateObservation total bytes exceed the configured limit.")),
  ];
  return cases;
}

export function createOwnedFixtureRoot(root) {
  assert(path.isAbsolute(root), "fixture root must be absolute");
  assert.notEqual(path.parse(root).root, root, "fixture root must not be a volume root");
  fs.mkdirSync(root); // Existing directories are deliberately refused.
  ownedRoots.add(root);
}
export function cleanupOwnedFixtureRoot(root) {
  assert(ownedRoots.has(root), "fixture root ownership is required");
  fs.rmSync(root, { recursive: true, force: true }); ownedRoots.delete(root);
}
export function restoreReaderSeed(root, scenario) {
  assert(ownedRoots.has(root), "fixture root ownership is required");
  fs.rmSync(root, { recursive: true }); fs.mkdirSync(root);
  const safe = relative => {
    const full = path.resolve(root, relative), fromRoot = path.relative(root, full);
    assert(fromRoot && fromRoot !== ".." && !fromRoot.startsWith(`..${path.sep}`) && !path.isAbsolute(fromRoot));
    return full;
  };
  for (const relative of scenario.directories || []) fs.mkdirSync(safe(relative), { recursive: true });
  for (const file of scenario.files) { const full = safe(file.path); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, file.content); }
  if (scenario.symlink) {
    fs.mkdirSync(path.join(root, ".head"), { recursive: true });
    const target = path.join(root, "symlink-target");
    if (scenario.symlink === "ancestor") {
      fs.mkdirSync(target); fs.symlinkSync(target, path.join(root, ".head", "release-observations"), process.platform === "win32" ? "junction" : "dir");
    } else {
      fs.writeFileSync(target, "{}"); fs.mkdirSync(path.join(root, directories[0]), { recursive: true });
      fs.symlinkSync(target, path.join(root, directories[0], "unsafe.json"), "file");
    }
  }
}

export function readerSnapshot(root) {
  const rootStat = fs.lstatSync(root);
  const entries = [{ path: "", kind: "directory", mode: rootStat.mode, mtimeMs: rootStat.mtimeMs }];
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const full = path.join(directory, name), stat = fs.lstatSync(full), relative = path.relative(root, full).split(path.sep).join("/");
      const metadata = { mode: stat.mode, mtimeMs: stat.mtimeMs };
      if (stat.isSymbolicLink()) entries.push({ path: relative, kind: "symlink", target: fs.readlinkSync(full), ...metadata });
      else if (stat.isDirectory()) { entries.push({ path: relative, kind: "directory", ...metadata }); visit(full); }
      else { const bytes = fs.readFileSync(full); entries.push({ path: relative, kind: "file", size: bytes.length, sha256: sha(bytes), ...metadata }); }
    }
  }
  visit(root);
  // Recreating the same fixture changes timestamps between arms. Raw timestamps
  // remain in entries and are checked exactly before/after within each arm.
  const stableEntries = entries.map(({ mtimeMs, ...entry }) => entry);
  return { entries, digest: sha(canonicalJson(stableEntries)) };
}

export function readerComparisonView(outcome) {
  const view = clone(outcome);
  for (const snapshot of [view.filesystem.before, view.filesystem.after]) {
    snapshot.entries = snapshot.entries.map(({ mtimeMs, ...entry }) => entry);
  }
  return view;
}

function withReadGuard(root, pure, action) {
  const reads = [], writes = [], restores = [];
  const pathname = value => typeof value === "string" || Buffer.isBuffer(value) ? String(value) : value instanceof URL ? fileURLToPath(value) : null;
  const scoped = args => args.some(value => { const p = pathname(value); if (!p) return false; const relative = path.relative(root, path.resolve(p)); return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); });
  const install = (object, name, replacement) => { if (typeof object[name] !== "function") return; const original = object[name]; object[name] = replacement(original); restores.push(() => { object[name] = original; }); };
  const mutationNames = ["mkdir", "mkdtemp", "writeFile", "appendFile", "rename", "unlink", "rm", "rmdir", "truncate", "ftruncate", "chmod", "lchmod", "fchmod", "chown", "lchown", "fchown", "utimes", "lutimes", "futimes", "link", "symlink", "copyFile", "cp", "write", "writev"];
  const denied = (name, args) => { writes.push({ operation: name, args: args.filter(a => typeof a === "string" || typeof a === "number") }); throw Object.assign(new Error(`Reader attempted filesystem mutation: ${name}`), { code: "READER_TEST_WRITE_ATTEMPT" }); };
  try {
    for (const name of mutationNames) {
      for (const suffix of ["", "Sync"]) install(fs, name + suffix, original => function (...args) { if (pure || scoped(args) || typeof args[0] === "number") return denied(name + suffix, args); return original.apply(this, args); });
      install(fs.promises, name, original => async function (...args) { if (pure || scoped(args)) return denied(`promises.${name}`, args); return original.apply(this, args); });
    }
    for (const name of ["existsSync", "readFileSync", "readdirSync", "lstatSync", "statSync", "realpathSync", "accessSync", "readlinkSync", "openSync", "open", "createWriteStream"]) {
      install(fs, name, original => function (...args) {
        if (pure) throw Object.assign(new Error(`Pure verifier attempted filesystem access: ${name}`), { code: "READER_TEST_PURE_FS_ACCESS" });
        if (scoped(args)) reads.push({ operation: name, path: pathname(args[0]) });
        if (name === "createWriteStream" || (name.startsWith("open") && args[1] !== "r" && args[1] !== "rs" && args[1] !== 0)) return denied(name, args);
        return original.apply(this, args);
      });
    }
    for (const name of ["readFile", "readdir", "lstat", "stat", "realpath", "access", "readlink", "open"]) install(fs.promises, name, original => async function (...args) {
      if (pure) throw Object.assign(new Error(`Pure verifier attempted filesystem access: promises.${name}`), { code: "READER_TEST_PURE_FS_ACCESS" });
      if (scoped(args)) reads.push({ operation: `promises.${name}`, path: pathname(args[0]) });
      if (name === "open" && args[1] !== "r" && args[1] !== "rs" && args[1] !== 0) return denied(`promises.${name}`, args);
      return original.apply(this, args);
    });
    return { value: action(), reads, writes };
  } catch (error) { return { error, reads, writes }; }
  finally { for (const restore of restores.reverse()) restore(); }
}

function rawError(error) {
  return { constructor: error.constructor.name, name: error.name, hasOwnCode: Object.hasOwn(error, "code"), code: Object.hasOwn(error, "code") ? error.code : null, message: error.message };
}

export function captureReaderScenario(api, root, scenario) {
  const before = readerSnapshot(root), input = clone(scenario.input), originalInput = clone(input);
  const captured = withReadGuard(root, scenario.pure, () => {
    if (!scenario.pure) return api.loadReleaseObservationProjection({ projectRoot: root, projectId });
    if (scenario.method === "all") {
      const values = [api.verifyBranchStateObservation(input.branch, projectId), api.verifyDeploymentResultObservation(input.deployment, projectId), api.verifyReleaseObservation(input.release, projectId), api.verifyReleaseObservationProjectionInput(input.projection)];
      return { values, sameInputObjects: values.map((value, index) => value === [input.branch, input.deployment, input.release, input.projection][index]) };
    }
    const value = api[scenario.method](input, projectId);
    return { value, sameInputObject: value === input };
  });
  const after = readerSnapshot(root);
  const error = captured.error ? rawError(captured.error) : null;
  const outcome = { id: scenario.id, status: "completed", result: captured.value ?? null, error,
    ...(scenario.pure ? { inputBefore: originalInput, inputAfter: input } : {}),
    filesystem: { before, after, reads: captured.reads, attemptedWrites: captured.writes } };
  try {
    assert.deepEqual(after, before, `${scenario.id}: all fixture paths/bytes/modes/raw mtimes must remain unchanged`);
    assert.deepEqual(input, originalInput, `${scenario.id}: verifier input changed`);
    assert.deepEqual(captured.writes, [], `${scenario.id}: attempted writes are forbidden`);
    if (scenario.expected) {
      assert(error, `${scenario.id}: expected an error`);
      for (const [field, value] of Object.entries(scenario.expected)) assert.equal(error[field], value, `${scenario.id}: ${field}`);
    } else assert.equal(error, null, `${scenario.id}: unexpected error ${JSON.stringify(error)}`);
    if (scenario.validIdentity) assert.deepEqual(captured.value.sameInputObjects, [true, true, true, true]);
    for (const read of captured.reads.filter(item => item.operation === "readFileSync")) {
      assert(directories.some(directory => read.path.startsWith(path.join(root, directory) + path.sep)), `${scenario.id}: current source reopened: ${read.path}`);
    }
  } catch (assertion) { assertion.readerOutcome = outcome; throw assertion; }
  return outcome;
}

export function isSymlinkCapabilityError(error, scenario) {
  return Boolean(scenario.symlink && ["EPERM", "EACCES", "ENOTSUP", "ENOSYS"].includes(error.code));
}

export const publicReleaseNames = ["BRANCH_STATE_OBSERVATION_DIRECTORY", "DEPLOYMENT_RESULT_OBSERVATION_DIRECTORY", "RELEASE_OBSERVATION_DIRECTORY", "RELEASE_OBSERVATION_VERSION", "StructuredDeploymentResultAdapter", "assertDeploymentResultAdapter", "inspectReleaseObservations", "loadReleaseObservationProjection", "observeReleaseState", "releaseObservationCanonicalJson", "releaseObservationDigest", "verifyBranchStateObservation", "verifyDeploymentResultObservation", "verifyReleaseObservation", "verifyReleaseObservationProjectionInput"].sort();

// Register for any explicit test-list position, not for helper-only imports.
if (process.argv.slice(1).some(argument => path.resolve(argument) === fileURLToPath(import.meta.url))) {
  const api = await import("../scripts/lib/distribution/release-observation.mjs");
  test("release observation facade preserves its exact fifteen public exports", () => assert.deepEqual(Object.keys(api).sort(), publicReleaseNames));
  for (const scenario of readerScenarios()) test(`stored release reader: ${scenario.id}`, { concurrency: false }, t => {
    const root = path.join(process.env.HEAD_AGENT_TEST_TMP || os.tmpdir(), `head-release-projection-${crypto.randomUUID()}`);
    createOwnedFixtureRoot(root);
    try {
      try { restoreReaderSeed(root, scenario); } catch (error) { if (isSymlinkCapabilityError(error, scenario)) { t.skip(`Physical symlink unavailable: ${error.code}: ${error.message}`); return; } throw error; }
      captureReaderScenario(api, root, scenario);
    } finally { cleanupOwnedFixtureRoot(root); }
  });
}

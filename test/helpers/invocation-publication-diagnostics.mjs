// Test-only observation around the synchronous synthetic fixture publisher.
// Never imported by Core, never retries, never reads artifact contents or env.
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { persistRuntimeInvocationRecord, runtimeInvocationRecordDirectory } from "../../scripts/lib/runtime/runtime-invocation-record.mjs";

const fixtures = new Set();
const activePublications = new Set();
const MAX_ENTRIES = 16;
const MAX_ACTIVE = 8;
const MAX_BYTES = 24 * 1024;
let fixtureSequence = 0;
let publicationSequence = 0;
const now = () => new Date().toISOString();
const errorCode = error => /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code || "") ? error.code : "UNCLASSIFIED";
const identity = stat => ({ device: String(stat.dev), inode: String(stat.ino), mode: Number(stat.mode & 0o7777n).toString(8),
  links: String(stat.nlink), size: String(stat.size), modifiedNs: String(stat.mtimeNs), changedNs: String(stat.ctimeNs) });
const type = stat => stat.isSymbolicLink() ? "symbolic-link" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
const within = (root, file) => { const relative = path.relative(root, file); return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const safeEntry = name => /^(?:draft|receipt)\.json$/.test(name)
  || /^event-\d{6}-runtime-event-[a-f0-9]{24}\.json$/.test(name)
  || /^\.?execution-authorization-[a-f0-9]{24}(?:\.[a-f0-9-]{36}\.tmp)?$/.test(name) ? name : "<other>";

function inspectPath(scope, file) {
  if (!within(scope.root, file)) return { inspection: "outside-synthetic-fixture-not-inspected" };
  const relativePath = path.relative(scope.root, file).split(path.sep).join("/") || ".";
  const result = { relativePath, observedAt: now() };
  try {
    // Do not traverse a substituted root or a symlink/junction ancestor. These
    // are sequential diagnostic observations, not atomic path/security proof.
    const rootStat = fs.lstatSync(scope.root, { bigint: true });
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || String(rootStat.dev) !== scope.identity.device
      || String(rootStat.ino) !== scope.identity.inode) return { ...result, inspection: "fixture-root-changed-not-inspected" };
    let current = scope.root;
    const segments = path.relative(scope.root, file).split(path.sep).filter(Boolean);
    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment);
      const stat = fs.lstatSync(current, { bigint: true });
      if (index < segments.length - 1 && (!stat.isDirectory() || stat.isSymbolicLink())) {
        return { ...result, inspection: "ancestor-not-plain-directory", ancestor: segments.slice(0, index + 1).join("/") };
      }
    }
    const stat = fs.lstatSync(file, { bigint: true });
    Object.assign(result, { exists: true, type: type(stat), identity: identity(stat) });
    if (stat.isSymbolicLink()) return { ...result, inspection: "link-target-not-inspected" };
    result.access = {};
    for (const [key, flag] of [["read", fs.constants.R_OK], ["write", fs.constants.W_OK], ["execute", fs.constants.X_OK]]) {
      try { fs.accessSync(file, flag); result.access[key] = "allowed"; }
      catch (error) { result.access[key] = errorCode(error); }
    }
    if (stat.isDirectory()) {
      const directory = fs.opendirSync(file);
      try {
        result.entries = [];
        for (let index = 0; index <= MAX_ENTRIES; index += 1) {
          const entry = directory.readSync();
          if (!entry) break;
          if (index === MAX_ENTRIES) { result.entriesTruncated = true; break; }
          result.entries.push({ name: safeEntry(entry.name), type: type(entry) });
        }
      } finally { directory.closeSync(); }
    }
    return { ...result, inspection: "observed" };
  } catch (error) {
    return { ...result, exists: error?.code === "ENOENT" ? false : null, inspection: "unavailable", errorCode: errorCode(error) };
  }
}

function emitFailure(scope, operation, source, destination, error) {
  const diagnostic = {
    event: "test-fixture-invocation-publication-failure", schemaVersion: 1, observedAt: now(),
    error: { code: errorCode(error), syscall: error?.syscall === "rename" ? "rename" : "not-reported",
      errno: Number.isSafeInteger(error?.errno) ? error.errno : null },
    process: { pid: process.pid, parentPid: process.ppid, startedAt: new Date(performance.timeOrigin).toISOString(),
      uptimeMs: Math.round(process.uptime() * 1000), ports: [], externalProcessesInspected: false },
    fixture: { fixtureId: scope.fixtureId, startedAt: scope.startedAt },
    operation: { ...operation, elapsedMs: Math.max(0, performance.now() - operation.startedMonotonicMs) },
    concurrency: {
      scope: "this-process-registered-synthetic-fixtures-only", externalWriters: "not-observed",
      activeFixtureCount: fixtures.size, activePublicationCount: activePublications.size,
      sameTargetPublicationCount: [...activePublications].filter(item => item.destination === destination).length,
      fixtures: [...fixtures].slice(0, MAX_ACTIVE).map(item => ({ fixtureId: item.fixtureId, startedAt: item.startedAt })),
      publications: [...activePublications].slice(0, MAX_ACTIVE).map(item => item.operation),
      truncated: fixtures.size > MAX_ACTIVE || activePublications.size > MAX_ACTIVE,
    },
    paths: { temporary: inspectPath(scope, source), destination: inspectPath(scope, destination), parent: inspectPath(scope, path.dirname(destination)) },
    limitations: ["sequential-not-atomic", "metadata-and-access-not-effective-Windows-ACL-proof", "inode-may-be-platform-limited", "no-file-content-env-or-process-command-collection"],
  };
  let serialized = JSON.stringify(diagnostic);
  if (Buffer.byteLength(serialized) > MAX_BYTES) {
    for (const value of Object.values(diagnostic.paths)) { delete value.entries; value.entriesOmittedForByteBound = true; }
    diagnostic.concurrency.fixtures = []; diagnostic.concurrency.publications = []; diagnostic.concurrency.truncated = true;
    serialized = JSON.stringify(diagnostic);
  }
  if (Buffer.byteLength(serialized) <= MAX_BYTES) scope.sink(serialized);
}

export function createFixturePublicationDiagnostics(container, { sink = line => fs.writeSync(2, `${line}\n`) } = {}) {
  const root = path.resolve(container);
  if (!/^head-worker-integration-[A-Za-z0-9_-]+$/.test(path.basename(root))) throw new Error("Diagnostics require a synthetic integration fixture root");
  const rootStat = fs.lstatSync(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.realpathSync(root) !== root) throw new Error("Diagnostics require a canonical plain fixture directory");
  const scope = { root, identity: identity(rootStat), fixtureId: ++fixtureSequence, startedAt: now(), sink };
  fixtures.add(scope);
  return {
    close() { fixtures.delete(scope); },
    publish(record, { generation, workerIndex } = {}) {
      const destination = runtimeInvocationRecordDirectory(record.projectRoot, record.authorization.authorizationId, record.storage);
      // This helper cannot be used to inspect a different project or parent.
      if (record.projectRoot !== path.join(root, "project")) throw new Error("Diagnostics require the fixture's exact project");
      const operation = { sequence: ++publicationSequence, fixtureId: scope.fixtureId, generation, workerIndex,
        startedAt: now(), startedMonotonicMs: performance.now(), renameAttempts: 0 };
      const active = { destination, operation };
      const rename = fs.renameSync;
      activePublications.add(active);
      fs.renameSync = function (source, target) {
        const exact = typeof source === "string" && target === destination && path.dirname(source) === path.dirname(destination)
          && path.basename(source).startsWith(`.${record.authorization.authorizationId}.`) && /\.[a-f0-9-]{36}\.tmp$/.test(source);
        if (!exact) return Reflect.apply(rename, this, arguments);
        operation.renameAttempts += 1;
        try { return Reflect.apply(rename, this, arguments); }
        catch (error) {
          // Observe BEFORE Core's existing finally removes the staging directory.
          // Diagnostics/sinks are best effort and cannot replace the same error.
          try { emitFailure(scope, operation, source, target, error); } catch {}
          throw error;
        }
      };
      try { return persistRuntimeInvocationRecord(record); }
      finally { fs.renameSync = rename; activePublications.delete(active); }
    },
  };
}

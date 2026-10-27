// P5 carrier continuity only. No P2 direction, new logical Session, approval,
// task replay or last/recent-caller search can be supplied by this cache.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { resolveProjectStorage, formatForVerifiedOwner } from "./project-storage-format.mjs";
import { resolveRuntimeOperationalStateRoot } from "./runtime-execution-lease.mjs";
import { safeSessionPath } from "./session-paths.mjs";
import { withLocalMutation, withProjectMutation } from "./project-mutation-lock.mjs";
import { atomicWriteArtifact } from "./artifact-storage.mjs";
import { createSessionHostAdapter } from "./session-host-adapter.mjs";

// Finite slots and the existing transient correlation window. Expiry never
// supplies a continuity proof; a pending exact old clear is still required.
const SLOTS = 64, MAX_BYTES = 128 * 1024, MAX_HINT_BYTES = 8192, TTL_MS = 600_000;
const sha = value => crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const id = value => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const fail = () => { throw Object.assign(new Error("Optional clear continuity is unavailable."), { code: "NATIVE_CLEAR_HANDOFF_UNAVAILABLE" }); };
const fields = (value, names) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const instanceKey = value => [value.platform, value.environment, value.pid, value.birth];
const validInstance = value => value && ["linux", "win32"].includes(value.platform) && digest(value.environment)
  && Number.isSafeInteger(value.pid) && value.pid > 0 && value.pid <= 0xffffffff
  && typeof value.birth === "string" && (value.platform === "win32" ? /^windows-filetime-\d{1,30}$/ : /^\d{1,30}$/).test(value.birth);
const mapping = value => ["bound", "default"].includes(value?.status) && /^session-[a-f0-9-]{36}$/iu.test(value.sessionId || "")
  && Number.isSafeInteger(value.revision) && value.revision > 0 && digest(value.bindingDigest);
const mappingRef = value => ({ status: value.status, sessionId: value.sessionId, revision: value.revision, bindingDigest: value.bindingDigest });
const result = status => ({ status, authorityPlane: "P5", recoveryAuthority: false, instructionAuthority: false,
  executionReplayAllowed: false, ordinaryWorkBlocked: false });

function location(root, caller, instance, environment, create) {
  const base = fs.realpathSync(path.resolve(root)), storage = resolveProjectStorage(base);
  const projectFile = safeSessionPath(base, formatForVerifiedOwner(storage).directory, "project.json");
  const stat = fs.lstatSync(projectFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) fail();
  const project = JSON.parse(fs.readFileSync(projectFile, "utf8"));
  if (project.schemaVersion !== 1 || project.projectRoot !== base
    || !new RegExp(`^${formatForVerifiedOwner(storage).projectPrefix}[a-f0-9]{20}$`).test(project.projectId || "")) fail();
  const owner = { projectId: project.projectId, rootDigest: sha(base), runtime: caller.runtime, agentId: caller.agentId || null };
  const operational = resolveRuntimeOperationalStateRoot({ projectRoot: base, storage, environment, create });
  if (!fs.existsSync(operational)) return null;
  const parts = ["native-clear-handoffs", sha(owner)]; let directory = operational;
  for (let index = 0; index < parts.length; index++) {
    directory = safeSessionPath(operational, ...parts.slice(0, index + 1));
    if (!fs.existsSync(directory)) { if (!create) return null; fs.mkdirSync(directory); }
    const entry = fs.lstatSync(directory); if (!entry.isDirectory() || entry.isSymbolicLink()) fail();
  }
  return { root: base, owner, directory, file: safeSessionPath(directory, "hints.json"),
    lock: safeSessionPath(directory, "writer.lock") };
}

function validateHint(hint, loc) {
  const { hintDigest, ...body } = hint;
  if (Buffer.byteLength(JSON.stringify(hint)) > MAX_HINT_BYTES) fail();
  if (!fields(hint, ["kind", "version", "owner", "instance", "oldNativeId", "oldMapping", "endRow", "createdAt", "expiresAt", "state", "hintDigest"])
    || hint.kind !== "NativeClearHandoffHint" || hint.version !== 1 || !same(hint.owner, loc.owner)
    || !fields(hint.instance, ["platform", "environment", "pid", "birth"]) || !validInstance(hint.instance)
    || !id(hint.oldNativeId) || !fields(hint.oldMapping, ["status", "sessionId", "revision", "bindingDigest"]) || !mapping(hint.oldMapping)
    || !fields(hint.endRow, ["key", "sequence", "observationDigest"]) || !digest(hint.endRow.key) || !digest(hint.endRow.observationDigest)
    || !Number.isSafeInteger(hint.endRow.sequence) || hint.endRow.sequence < 1
    || !Number.isSafeInteger(hint.createdAt) || !Number.isSafeInteger(hint.expiresAt) || hint.expiresAt !== hint.createdAt + TTL_MS
    || !["pending", "consumed", "ambiguous"].includes(hint.state) || !digest(hintDigest) || sha(body) !== hintDigest) fail();
  return hint;
}
function readHints(loc) {
  let stat;
  try { stat = fs.lstatSync(loc.file); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) fail();
  const cache = JSON.parse(fs.readFileSync(loc.file, "utf8")), { cacheDigest, ...body } = cache;
  if (!fields(cache, ["kind", "version", "owner", "rows", "cacheDigest"]) || cache.kind !== "NativeClearHandoffCache"
    || cache.version !== 1 || !same(cache.owner, loc.owner) || !Array.isArray(cache.rows) || cache.rows.length > SLOTS
    || !digest(cacheDigest) || sha(body) !== cacheDigest) fail();
  cache.rows.forEach(hint => validateHint(hint, loc));
  if (new Set(cache.rows.map(hint => JSON.stringify(instanceKey(hint.instance)))).size !== cache.rows.length) fail();
  return cache.rows;
}
function writeHint(loc, body, check) {
  check(); const hint = { ...body, hintDigest: sha(body) }; validateHint(hint, loc);
  const rows = readHints(loc).filter(row => row.expiresAt > Date.now() && !same(instanceKey(row.instance), instanceKey(body.instance)));
  rows.push(hint); if (rows.length > SLOTS) fail();
  const cache = { kind: "NativeClearHandoffCache", version: 1, owner: loc.owner, rows };
  const bytes = JSON.stringify({ ...cache, cacheDigest: sha(cache) }) + "\n";
  if (Buffer.byteLength(bytes) > MAX_BYTES) fail();
  safeSessionPath(loc.directory, path.basename(loc.file)); check(); atomicWriteArtifact(loc.file, bytes);
}
const withoutDigest = hint => { const { hintDigest, ...body } = hint; return body; };
const clearRow = (store, root, caller, instance) => store.read({ root, caller })?.rows.find(row => row.observation.kind === "event"
  && row.observation.event === "SessionEnd" && row.observation.reason === "clear"
  && same(instanceKey(row.observation.instance || {}), instanceKey(instance)));

export function reconcileNativeClearHandoff({ root, caller, observation, store, environment = process.env, deadlineAt } = {}) {
  if (caller?.runtime !== "claude" || !id(caller.nativeSessionId) || caller.agentId != null && !id(caller.agentId)
    || !validInstance(observation?.instance) || !Number.isSafeInteger(deadlineAt)) return result("unsupported");
  const ending = observation.event === "SessionEnd" && observation.reason === "clear";
  const starting = observation.event === "SessionStart" && observation.source === "clear";
  if (!ending && !starting) return result("unsupported");
  const check = () => { if (Date.now() >= deadlineAt) fail(); };
  try {
    check();
    const loc = location(root, caller, observation.instance, environment, ending);
    if (!loc) return result("no-clear-witness");
    return withLocalMutation({ directory: loc.lock, timeoutMs: 0 }, () => {
      check(); const prior = readHints(loc).find(hint => same(instanceKey(hint.instance), instanceKey(observation.instance))),
        instance = Object.fromEntries(["platform", "environment", "pid", "birth"].map(key => [key, observation.instance[key]]));
      if (ending) {
        const adapter = createSessionHostAdapter({ ...caller, environment, deadlineAt }), old = adapter.read({ root: loc.root });
        const row = clearRow(store, loc.root, caller, observation.instance);
        if (!mapping(old) || !row) return result("no-bound-clear-witness");
        // Replay cannot renew the lifetime of a previously retained end row.
        const createdAt = Date.parse(row.receivedAt);
        if (!Number.isSafeInteger(createdAt) || createdAt > Date.now() || Date.now() >= createdAt + TTL_MS) return result("expired-clear-witness");
        const body = { kind: "NativeClearHandoffHint", version: 1, owner: loc.owner, instance,
          oldNativeId: caller.nativeSessionId, oldMapping: mappingRef(old), endRow: { key: row.key, sequence: row.sequence, observationDigest: sha(row.observation) },
          createdAt, expiresAt: 0, state: "pending" };
        body.expiresAt = body.createdAt + TTL_MS;
        if (prior && Date.now() < prior.expiresAt) {
          if (!same(instanceKey(prior.instance), instanceKey(instance))) return result("slot-occupied");
          if (prior.oldNativeId === body.oldNativeId && same(prior.oldMapping, body.oldMapping) && same(prior.endRow, body.endRow)) return result("clear-replay");
          if (prior.state !== "consumed") {
            writeHint(loc, { ...withoutDigest(prior), state: "ambiguous" }, check); return result("ambiguous-clear");
          }
        }
        writeHint(loc, body, check); return result("clear-witness-retained");
      }
      if (!prior || prior.state !== "pending" || Date.now() >= prior.expiresAt || prior.createdAt > Date.now()
        || !same(instanceKey(prior.instance), instanceKey(instance))) return result("no-pending-clear-witness");
      const starts = store.read({ root: loc.root, caller });
      // This is a bounded observation snapshot, not a complete event history.
      // Replaced/evicted rows cannot prove which start was first. An unknown
      // first witness also cannot be assigned to this or another OS instance
      // retroactively by a later replay that happens to obtain a witness.
      if (!starts || starts.omitted || starts.sequence !== starts.rows.length) return result("clear-order-unconfirmed");
      const start = starts.rows.filter(row => row.observation.event === "SessionStart" && row.observation.source === "clear"
        && (!row.observation.instance || same(instanceKey(row.observation.instance), instanceKey(instance))))
        .sort((a, b) => a.sequence - b.sequence)[0];
      // A received start preceding (or indistinguishable from) the retained end
      // cannot acquire continuity from a later end or reordered event replay.
      if (!start?.observation.instance || !(Date.parse(start.receivedAt) > prior.createdAt)) return result("clear-order-unconfirmed");
      // Consume before binding. A partial P5 commit never becomes an automatic
      // retry or permission to repeat a task/tool effect.
      writeHint(loc, { ...withoutDigest(prior), state: "consumed" }, check);
      if (prior.oldNativeId === caller.nativeSessionId) return result("same-caller-no-handoff");
      const oldCaller = { runtime: "claude", nativeSessionId: prior.oldNativeId, agentId: caller.agentId || null };
      const oldAdapter = createSessionHostAdapter({ ...oldCaller, environment, deadlineAt });
      const nextAdapter = createSessionHostAdapter({ ...caller, environment, deadlineAt });
      // Revalidate the old source and empty new caller inside the SAME existing
      // Project binding CAS lock. No explicit selection can race between them.
      return withProjectMutation({ root: loc.root, scope: "host-session-binding", timeoutMs: Math.max(0, deadlineAt - Date.now()) }, () => {
        check();
        const old = oldAdapter.read({ root: loc.root }), next = nextAdapter.read({ root: loc.root });
        if (!mapping(old) || !same(mappingRef(old), prior.oldMapping) || next.status !== "absent" || next.revision !== 0) return result("selection-basis-changed");
        const row = clearRow(store, loc.root, oldCaller, prior.instance);
        if (!row || row.key !== prior.endRow.key || row.sequence !== prior.endRow.sequence || sha(row.observation) !== prior.endRow.observationDigest) return result("clear-source-changed");
        check();
        const selected = nextAdapter.select({ root: loc.root, sessionId: old.sessionId, expectedRevision: 0 });
        return result(selected.retained ? "same-session-link-retained" : "linkage-unconfirmed");
      });
    });
  } catch { return result("handoff-unavailable"); }
}

import fs from "node:fs";
import path from "node:path";
import { formatForVerifiedOwner, assertProjectStorageUnchanged } from "./project-storage-format.mjs";
import { atomicCreateArtifact } from "./artifact-storage.mjs";
import { safeSnapshotPath } from "./snapshot-storage-codec.mjs";
import { withProjectMutation } from "./project-mutation-lock.mjs";

// No canonical records or historical snapshots. These exact paths are either
// regenerated inventory or host-local transient coordination, never authority.
export const GENERATED_STORAGE_IGNORE_RULES = Object.freeze([
  Object.freeze({ pattern: "/graph-discovery/index.json", reason: "Rebuilt from current verified original records." }),
  Object.freeze({ pattern: "/.operations/", reason: "Transient scoped process locks, not portable Project state." }),
  Object.freeze({ pattern: "/.snapshot-gc/", reason: "Transient local snapshot participants and collector attempts, not recovery direction." }),
  Object.freeze({ pattern: "/refresh/writer.lock/", reason: "Active host-local refresh lease, not a retained snapshot." }),
  Object.freeze({ pattern: "/refresh/writer.lock.*.staging/", reason: "Unpublished nonce-owned refresh lease staging." }),
]);
const BEGIN = "# BEGIN Lode generated disposable storage rules", END = "# END Lode generated disposable storage rules";

// This is a conservative disjointness proof, not a second Git pattern engine.
// Only a rooted literal prefix can prove an exception unrelated. Basename,
// escaped and wildcard prefixes remain unknown and preserve the user's policy.
function exceptionMayReach(pattern, targets) {
  const body = pattern.replace(/ +$/, "").replace(/\/$/, ""), marker = body.search(/[*?\[\]\\]/);
  const literal = marker < 0 ? body : body.slice(0, marker);
  if (!body.startsWith("/") && !literal.includes("/")) return true;
  const prefix = literal.replace(/^\//, "").toLowerCase();
  return targets.some(target => {
    const common = Math.min(prefix.length, target.length);
    return prefix.slice(0, common) === target.toLowerCase().slice(0, common);
  });
}

function readIgnorePolicy(root, file, targets) {
  safeSnapshotPath(root, file);
  const before = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!before) return { file, bytes: null };
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 1024 * 1024) {
    throw Object.assign(new Error("User ignore cannot be safely inspected."), { code: "USER_IGNORE_UNAVAILABLE" });
  }
  const bytes = fs.readFileSync(file), after = fs.lstatSync(file);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
    || bytes.length !== before.size) throw Object.assign(new Error("User ignore changed during inspection."), { code: "USER_IGNORE_CHANGED_CONCURRENTLY" });
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.includes("\0")) throw Object.assign(new Error("User ignore contains NUL."), { code: "USER_IGNORE_UNAVAILABLE" });
  for (const line of text.split(/\r?\n/)) {
    // Git recognizes ! only in column zero. Escaped ! and indented text are
    // literal patterns, not exceptions. Retaining spaces is conservative.
    if (line.startsWith("!") && exceptionMayReach(line.slice(1), targets)) {
      throw Object.assign(new Error("User exception may reach generated paths."), { code: "USER_IGNORE_RULES_TAKE_PRECEDENCE" });
    }
  }
  return { file, bytes, dev: after.dev, ino: after.ino };
}

function assertIgnorePoliciesUnchanged(policies) {
  for (const policy of policies) {
    const stat = fs.lstatSync(policy.file, { throwIfNoEntry: false });
    if (policy.bytes === null ? Boolean(stat) : !stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || stat.dev !== policy.dev || stat.ino !== policy.ino || stat.size !== policy.bytes.length
      || !fs.readFileSync(policy.file).equals(policy.bytes)) {
      throw Object.assign(new Error("User ignore changed before publication."), { code: "USER_IGNORE_CHANGED_CONCURRENTLY" });
    }
  }
}

export function ensureProjectStorageIgnore({ root, storage }) {
  const file = path.join(root, formatForVerifiedOwner(storage).directory, ".gitignore");
  try {
    if (fs.realpathSync(root) !== storage?.projectRoot) throw Object.assign(new Error("Ignore Project root mismatch."), { code: "PROJECT_IDENTITY_MISMATCH" });
    assertProjectStorageUnchanged(storage);
    return withProjectMutation({ root, storage, scope: "storage-ignore", timeoutMs: 0 }, () => {
      safeSnapshotPath(root, file);
      const directory = formatForVerifiedOwner(storage).directory;
      const targets = GENERATED_STORAGE_IGNORE_RULES.map(rule => directory + rule.pattern.split(/[*?\[]/, 1)[0]);
      const policy = readIgnorePolicy(root, path.join(root, ".gitignore"), targets);
      // An existing file belongs to its editor, including generated files edited
      // later. Never append: a concurrent user exception must keep its ordering.
      if (fs.lstatSync(file, { throwIfNoEntry: false })) return { status: "preserved", reasonCode: "EXISTING_STORAGE_IGNORE", ordinaryWorkBlocked: false };
      const block = [BEGIN, ...GENERATED_STORAGE_IGNORE_RULES.map(rule => rule.pattern), END, ""].join("\n");
      assertProjectStorageUnchanged(storage);
      assertIgnorePoliciesUnchanged([policy]);
      try { atomicCreateArtifact(file, block); }
      catch (error) { if (error.code === "EEXIST") return { status: "preserved", reasonCode: "USER_IGNORE_CREATED_CONCURRENTLY", ordinaryWorkBlocked: false }; throw error; }
      return { status: "created", path: path.relative(root, file).replaceAll("\\", "/"), ordinaryWorkBlocked: false };
    });
  } catch (error) { return { status: "preserved", reasonCode: error.code || "USER_IGNORE_UNAVAILABLE", ordinaryWorkBlocked: false }; }
}

// Retained private snapshots are recovery material, not disposable cache.
// This create-only nested policy never changes parent/user rules or tracking.
export function ensureOwnedSnapshotStoreIgnore({ root, storage, directory }) {
  try {
    assertProjectStorageUnchanged(storage);
    const parent = path.join(root, formatForVerifiedOwner(storage).directory);
    if (path.dirname(directory) !== parent || !/^snapshot-objects\.git(?:\.[a-f0-9-]{36}\.staging)?$/.test(path.basename(directory))) return { status: "preserved", reasonCode: "NOT_OWNED_SNAPSHOT_AREA" };
    const policies = [root, parent].map(base => readIgnorePolicy(root, path.join(base, ".gitignore"), [path.relative(base, directory).replaceAll("\\", "/") + "/"]));
    const file = safeSnapshotPath(root, path.join(directory, ".gitignore"));
    if (fs.existsSync(file)) return { status: "preserved", reasonCode: "EXISTING_OWNED_IGNORE" };
    assertIgnorePoliciesUnchanged(policies);
    try { atomicCreateArtifact(file, "# Retained local snapshot objects; not disposable cache.\n*\n!.gitignore\n"); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    return { status: "created", trackingChanged: false };
  } catch (error) { return { status: "preserved", reasonCode: error.code || "USER_IGNORE_UNAVAILABLE" }; }
}

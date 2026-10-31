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
  Object.freeze({ pattern: "/messaging/", reason: "Live same-project conversation mailbox, not canon or recovery state." }),
  Object.freeze({ pattern: "/.snapshot-gc/", reason: "Transient local snapshot participants and collector attempts, not recovery direction." }),
  Object.freeze({ pattern: "/refresh/writer.lock/", reason: "Active host-local refresh lease, not a retained snapshot." }),
  Object.freeze({ pattern: "/refresh/writer.lock.*.staging/", reason: "Unpublished nonce-owned refresh lease staging." }),
]);
const BEGIN = "# BEGIN Lode generated disposable storage rules", END = "# END Lode generated disposable storage rules";

// This is a conservative disjointness proof, not a second Git pattern engine.
// Only a rooted literal prefix can prove an exception unrelated. Basename,
// escaped and wildcard prefixes remain unknown and preserve the user's policy.
function exceptionMayReach(pattern, targets, exactFile = false) {
  const body = pattern.replace(/ +$/, "").replace(/\/$/, ""), marker = body.search(/[*?\[\]\\]/);
  const literal = marker < 0 ? body : body.slice(0, marker);
  if (!body.startsWith("/") && !literal.includes("/")) {
    // An exact basename cannot match a differently named exact file or any
    // of its known parents. Directory rules also affect unknown descendants.
    if (exactFile && marker < 0 && !pattern.endsWith("/")) {
      return targets.some(target => target.toLowerCase().split("/").includes(body.toLowerCase()));
    }
    return true;
  }
  const prefix = literal.replace(/^\//, "").toLowerCase();
  return targets.some(target => {
    const common = Math.min(prefix.length, target.length);
    return prefix.slice(0, common) === target.toLowerCase().slice(0, common);
  });
}

function readIgnorePolicy(root, file, targets, collectExceptions = false) {
  safeSnapshotPath(root, file);
  const before = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!before) return { file, bytes: null, exceptions: [] };
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 1024 * 1024) {
    throw Object.assign(new Error("User ignore cannot be safely inspected."), { code: "USER_IGNORE_UNAVAILABLE" });
  }
  const bytes = fs.readFileSync(file), after = fs.lstatSync(file);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
    || bytes.length !== before.size) throw Object.assign(new Error("User ignore changed during inspection."), { code: "USER_IGNORE_CHANGED_CONCURRENTLY" });
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.includes("\0")) throw Object.assign(new Error("User ignore contains NUL."), { code: "USER_IGNORE_UNAVAILABLE" });
  const exceptions = [];
  for (const line of text.split(/\r?\n/)) {
    // Git recognizes ! only in column zero. Escaped ! and indented text are
    // literal patterns, not exceptions. Retaining spaces is conservative.
    if (line.startsWith("!")) exceptions.push(line.slice(1));
    if (!collectExceptions && line.startsWith("!") && exceptionMayReach(line.slice(1), targets)) {
      throw Object.assign(new Error("User exception may reach generated paths."), { code: "USER_IGNORE_RULES_TAKE_PRECEDENCE" });
    }
  }
  return { file, bytes, dev: after.dev, ino: after.ino, exceptions };
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

function exceptionUnignoresMessaging(pattern) {
  const body = String(pattern || "").replace(/\/$/, "");
  if (body === "*" || body === "**" || body === "/*") return true;
  return body.toLowerCase().includes("messaging");
}

// Existing projects already have a gitignore, and the create-only helper must
// not rewrite it. Appending one rule keeps every earlier line and skips the
// append when a user exception would un-ignore the mailbox.
export function appendMessagingIgnoreIfSafe({ root, directory }) {
  const file = path.join(root, directory, ".gitignore");
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return { status: "absent" };
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) return { status: "preserved", reasonCode: "USER_IGNORE_UNAVAILABLE" };
  const before = fs.readFileSync(file);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(before); }
  catch { return { status: "preserved", reasonCode: "USER_IGNORE_UNAVAILABLE" }; }
  if (text.includes("\0") || text.split(/\r?\n/).includes("/messaging/")) return { status: "present" };
  const own = text.split(/\r?\n/).filter(line => line.startsWith("!")).map(line => line.slice(1));
  let rootExceptions = [];
  try { rootExceptions = readIgnorePolicy(root, path.join(root, ".gitignore"), [], true).exceptions; }
  catch { return { status: "preserved", reasonCode: "USER_IGNORE_UNAVAILABLE" }; }
  if ([...own, ...rootExceptions].some(exceptionUnignoresMessaging)) return { status: "preserved", reasonCode: "USER_IGNORE_RULES_TAKE_PRECEDENCE" };
  if (!fs.readFileSync(file).equals(before)) return { status: "preserved", reasonCode: "USER_IGNORE_CHANGED_CONCURRENTLY" };
  fs.appendFileSync(file, `${text.endsWith("\n") ? "" : "\n"}/messaging/\n`);
  return { status: "appended" };
}

export function ensureProjectStorageIgnore({ root, storage }) {
  const file = path.join(root, formatForVerifiedOwner(storage).directory, ".gitignore");
  try {
    if (fs.realpathSync(root) !== storage?.projectRoot) throw Object.assign(new Error("Ignore Project root mismatch."), { code: "PROJECT_IDENTITY_MISMATCH" });
    assertProjectStorageUnchanged(storage);
    return withProjectMutation({ root, storage, scope: "storage-ignore", timeoutMs: 0 }, () => {
      safeSnapshotPath(root, file);
      const directory = formatForVerifiedOwner(storage).directory;
      const policy = readIgnorePolicy(root, path.join(root, ".gitignore"), [], true);
      // An existing file belongs to its editor, including generated files edited
      // later. Never append: a concurrent user exception must keep its ordering.
      if (fs.lstatSync(file, { throwIfNoEntry: false })) return { status: "preserved", reasonCode: "EXISTING_STORAGE_IGNORE", ordinaryWorkBlocked: false };
      const included = [], skipped = [];
      for (const rule of GENERATED_STORAGE_IGNORE_RULES) {
        const target = directory + rule.pattern.split(/[*?\[]/, 1)[0];
        const exactFile = !rule.pattern.endsWith("/") && !/[*?\[\]\\]/.test(rule.pattern);
        if (policy.exceptions.some(pattern => exceptionMayReach(pattern, [target], exactFile))) {
          skipped.push({ pattern: rule.pattern, reasonCode: "USER_IGNORE_RULES_TAKE_PRECEDENCE" });
        } else included.push(rule.pattern);
      }
      if (!included.length) return { status: "preserved", reasonCode: "USER_IGNORE_RULES_TAKE_PRECEDENCE", rules: { included, skipped }, ordinaryWorkBlocked: false };
      const block = [BEGIN, ...included, END, ""].join("\n");
      assertProjectStorageUnchanged(storage);
      assertIgnorePoliciesUnchanged([policy]);
      try { atomicCreateArtifact(file, block); }
      catch (error) { if (error.code === "EEXIST") return { status: "preserved", reasonCode: "USER_IGNORE_CREATED_CONCURRENTLY", ordinaryWorkBlocked: false }; throw error; }
      return { status: "created", path: path.relative(root, file).replaceAll("\\", "/"), rules: { included, skipped }, ordinaryWorkBlocked: false };
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

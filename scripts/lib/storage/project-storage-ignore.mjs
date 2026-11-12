import { conversationMailboxStorage } from "../session/conversation-mailbox-storage.mjs";
import { resolveProjectStorage } from "./project-storage-format.mjs";
import { spawnSync } from "node:child_process";
import { absoluteSystemExecutable } from "../session/native-session-process.mjs";
import fs from "node:fs";
import path from "node:path";
import { formatForVerifiedOwner, assertProjectStorageUnchanged } from "./project-storage-format.mjs";
import { atomicCreateArtifact, atomicWriteArtifact } from "../core/fs-atomic.mjs";
import { safeSnapshotPath } from "../world/snapshot-storage-codec.mjs";
import { withProjectMutation } from "./project-mutation-lock.mjs";
import { escapesRootByPrefix } from "../core/path-safety.mjs";

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
// Retained, exact local storage is excluded from new accidental tracking, not
// discarded. Canonical records and pointers remain outside this list.
export const RETAINED_STORAGE_IGNORE_RULES = Object.freeze([
  "/world-model/snapshots/",
  "/graph-projection/snapshots/",
  "/snapshot-bundles/",
  "/snapshot-objects.git/",
]);
const HISTORY_BEGIN = "# BEGIN Lode retained local snapshot history rules";
const HISTORY_END = "# END Lode retained local snapshot history rules";
const BEGIN = "# BEGIN Lode generated disposable storage rules",
  END = "# END Lode generated disposable storage rules";

// This is a conservative disjointness proof, not a second Git pattern engine.
// Literal basenames can prove disjointness for an exact file and its parents,
// including a directory exception. Unknown directory descendants stay unknown.
function exceptionMayReach(pattern, targets, exactFile = false) {
  const body = pattern.replace(/ +$/, "").replace(/\/$/, ""),
    marker = body.search(/[*?\[\]\\]/);
  const literal = marker < 0 ? body : body.slice(0, marker);
  // Directory rules are published in the descendant .lode/.gitignore. Git will
  // not re-include a file whose parent directory is excluded there, so a root
  // exception such as !.gitkeep, !docs/, or !snapshots cannot expose snapshot
  // storage. Omitting the directory rule is what leaves it untracked.
  if (!exactFile) return false;
  if (!body.startsWith("/") && !literal.includes("/")) {
    if (marker < 0) {
      return targets.some((target) => target.toLowerCase().split("/").includes(body.toLowerCase()));
    }
    return true;
  }
  const prefix = literal.replace(/^\//, "").toLowerCase();
  return targets.some((target) => {
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
  const bytes = fs.readFileSync(file),
    after = fs.lstatSync(file);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size)
    throw Object.assign(new Error("User ignore changed during inspection."), { code: "USER_IGNORE_CHANGED_CONCURRENTLY" });
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.includes("\0")) throw Object.assign(new Error("User ignore contains NUL."), { code: "USER_IGNORE_UNAVAILABLE" });
  const exceptions = [];
  for (const line of text.split(/\r?\n/)) {
    // Git recognizes ! only in column zero. Escaped ! and indented text are
    // literal patterns, not exceptions. Retaining spaces is conservative.
    if (line.startsWith("!")) exceptions.push(line.slice(1));
    const explicitPrefix = line.startsWith("!") && /^!?\/?[^*?\[\]\\]+\/\*\*$/.test(line) ? line.slice(1).replace(/^\//, "").slice(0, -2) : null;
    if (
      !collectExceptions &&
      line.startsWith("!") &&
      ((explicitPrefix && targets.some((target) => target.startsWith(explicitPrefix))) || exceptionMayReach(line.slice(1), targets))
    ) {
      throw Object.assign(new Error("User exception may reach generated paths."), { code: "USER_IGNORE_RULES_TAKE_PRECEDENCE" });
    }
  }
  return { file, bytes, dev: after.dev, ino: after.ino, exceptions };
}

function assertIgnorePoliciesUnchanged(policies) {
  for (const policy of policies) {
    const stat = fs.lstatSync(policy.file, { throwIfNoEntry: false });
    if (
      policy.bytes === null
        ? Boolean(stat)
        : !stat?.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1 ||
          stat.dev !== policy.dev ||
          stat.ino !== policy.ino ||
          stat.size !== policy.bytes.length ||
          !fs.readFileSync(policy.file).equals(policy.bytes)
    ) {
      throw Object.assign(new Error("User ignore changed before publication."), { code: "USER_IGNORE_CHANGED_CONCURRENTLY" });
    }
  }
}

// The tracked storage gitignore is create-only. A mailbox hides its own files,
// including this ignore file, so an existing project gains no untracked path.
const MESSAGING_IGNORE = "# Live conversation mailbox, not canon.\n*\n";
const PREVIOUS_MESSAGING_IGNORE = "# Live conversation mailbox, not canon.\n*\n!.gitignore\n";

function gitTracksFile(root, file) {
  try {
    const relative = path.relative(root, file).replaceAll("\\", "/");
    if (!relative || relative.startsWith("..")) return "unknown";
    const git = absoluteSystemExecutable("git") || absoluteSystemExecutable("git.exe");
    if (!git) return "unknown";
    const result = spawnSync(git, ["-C", root, "ls-files", "-z", "--", relative], {
      encoding: "utf8",
      timeout: 2000,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result?.status !== 0 || result.error || result.signal) return "unknown";
    return result.stdout ? "tracked" : "untracked";
  } catch {
    return "unknown";
  }
}

export function ensureMessagingDirectoryIgnore({ root, directory, mailboxStorage = null }) {
  const storage = resolveProjectStorage(root);
  if (!storage || storage.directory !== directory) return { status: "preserved", reasonCode: "CONVERSATION_PATH_ESCAPE" };
  const io = mailboxStorage || conversationMailboxStorage(storage);
  const messaging = path.join(root, directory, "messaging");
  const file = path.join(messaging, ".gitignore");
  try {
    io.assertCurrent();
    const dirStat = io.lstatSync(messaging);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return { status: "preserved", reasonCode: "MESSAGING_DIR_UNAVAILABLE" };
    const relative = path.relative(fs.realpathSync(root), fs.realpathSync(messaging));
    if (escapesRootByPrefix(relative)) return { status: "preserved", reasonCode: "CONVERSATION_PATH_ESCAPE" };
    const existing = io.lstatSync(file, { throwIfNoEntry: false });
    if (existing?.isSymbolicLink()) return { status: "preserved", reasonCode: "USER_IGNORE_UNAVAILABLE" };
    if (existing?.isFile()) {
      const current = io.readFileSync(file, "utf8");
      if (current === MESSAGING_IGNORE) return { status: "preserved", reasonCode: "EXISTING_MESSAGING_IGNORE" };
      if (current !== PREVIOUS_MESSAGING_IGNORE) return { status: "preserved", reasonCode: "EXISTING_MESSAGING_IGNORE" };
      const tracking = gitTracksFile(root, file);
      if (tracking !== "untracked")
        return { status: "preserved", reasonCode: tracking === "tracked" ? "TRACKED_MESSAGING_IGNORE" : "MESSAGING_IGNORE_TRACKING_UNKNOWN" };
      io.atomicWrite(file, MESSAGING_IGNORE, {
        beforePublish: () => {
          if (io.readFileSync(file, "utf8") !== current || gitTracksFile(root, file) !== "untracked")
            throw Object.assign(new Error("Messaging ignore changed."), { code: "USER_IGNORE_CHANGED_CONCURRENTLY" });
        },
      });
      return { status: "updated", trackingChanged: false };
    }
    io.atomicCreate(file, MESSAGING_IGNORE);
    return { status: "created", trackingChanged: false };
  } catch (error) {
    if (error?.code === "EEXIST") return { status: "preserved", reasonCode: "EXISTING_MESSAGING_IGNORE" };
    return { status: "preserved", reasonCode: error?.code || "USER_IGNORE_UNAVAILABLE" };
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
      const policy = readIgnorePolicy(root, path.join(root, ".gitignore"), [], true);
      const existing = readIgnorePolicy(root, file, [], true);
      // Only the entire exact legacy-generated body identifies an upgrade. A
      // marker inside a user file, extra comment or reordered rule grants none.
      const legacy = [
        BEGIN,
        "/graph-discovery/index.json",
        "/.operations/",
        "/.snapshot-gc/",
        "/refresh/writer.lock/",
        "/refresh/writer.lock.*.staging/",
        END,
        "",
      ].join("\n");
      if (existing.bytes !== null && ![legacy, legacy.replaceAll("\n", "\r\n")].some((text) => existing.bytes.equals(Buffer.from(text)))) {
        return { status: "preserved", reasonCode: "EXISTING_STORAGE_IGNORE", ordinaryWorkBlocked: false };
      }
      const included = [],
        skipped = [];
      for (const rule of [...GENERATED_STORAGE_IGNORE_RULES, ...RETAINED_STORAGE_IGNORE_RULES.map((pattern) => ({ pattern }))]) {
        const target = directory + rule.pattern.split(/[*?\[]/, 1)[0];
        const exactFile = !rule.pattern.endsWith("/") && !/[*?\[\]\\]/.test(rule.pattern);
        const explicitStorageChoice = policy.exceptions.some((pattern) => pattern.replace(/^\//, "") === directory + "/**");
        if (explicitStorageChoice || policy.exceptions.some((pattern) => exceptionMayReach(pattern, [target], exactFile))) {
          skipped.push({ pattern: rule.pattern, reasonCode: "USER_IGNORE_RULES_TAKE_PRECEDENCE" });
        } else included.push(rule.pattern);
      }
      if (!included.length)
        return { status: "preserved", reasonCode: "USER_IGNORE_RULES_TAKE_PRECEDENCE", rules: { included, skipped }, ordinaryWorkBlocked: false };
      const disposable = included.filter((pattern) => !RETAINED_STORAGE_IGNORE_RULES.includes(pattern));
      const retained = included.filter((pattern) => RETAINED_STORAGE_IGNORE_RULES.includes(pattern));
      const block = [
        BEGIN,
        ...disposable,
        END,
        ...(retained.length
          ? [HISTORY_BEGIN, "# Retained history, not disposable cache. Existing tracked files are unchanged.", ...retained, HISTORY_END]
          : []),
        "",
      ].join("\n");
      assertProjectStorageUnchanged(storage);
      assertIgnorePoliciesUnchanged([policy, existing]);
      try {
        if (existing.bytes !== null) atomicWriteArtifact(file, block, { beforePublish: () => assertIgnorePoliciesUnchanged([policy, existing]) });
        else atomicCreateArtifact(file, block);
      } catch (error) {
        if (error.code === "EEXIST") return { status: "preserved", reasonCode: "USER_IGNORE_CREATED_CONCURRENTLY", ordinaryWorkBlocked: false };
        throw error;
      }
      return {
        status: existing.bytes === null ? "created" : "updated",
        path: path.relative(root, file).replaceAll("\\", "/"),
        rules: { included, skipped },
        ordinaryWorkBlocked: false,
      };
    });
  } catch (error) {
    return { status: "preserved", reasonCode: error.code || "USER_IGNORE_UNAVAILABLE", ordinaryWorkBlocked: false };
  }
}

// Retained private snapshots are recovery material, not disposable cache.
// This create-only nested policy never changes parent/user rules or tracking.
export function ensureOwnedSnapshotStoreIgnore({ root, storage, directory }) {
  try {
    assertProjectStorageUnchanged(storage);
    const parent = path.join(root, formatForVerifiedOwner(storage).directory);
    if (path.dirname(directory) !== parent || !/^snapshot-objects\.git(?:\.[a-f0-9-]{36}\.staging)?$/.test(path.basename(directory)))
      return { status: "preserved", reasonCode: "NOT_OWNED_SNAPSHOT_AREA" };
    const policies = [root, parent].map((base) =>
      readIgnorePolicy(root, path.join(base, ".gitignore"), [path.relative(base, directory).replaceAll("\\", "/") + "/"]),
    );
    const file = safeSnapshotPath(root, path.join(directory, ".gitignore"));
    if (fs.existsSync(file)) return { status: "preserved", reasonCode: "EXISTING_OWNED_IGNORE" };
    assertIgnorePoliciesUnchanged(policies);
    try {
      atomicCreateArtifact(file, "# Retained local snapshot objects; not disposable cache.\n*\n!.gitignore\n");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    return { status: "created", trackingChanged: false };
  } catch (error) {
    return { status: "preserved", reasonCode: error.code || "USER_IGNORE_UNAVAILABLE" };
  }
}

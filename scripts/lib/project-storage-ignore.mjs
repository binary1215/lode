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
  Object.freeze({ pattern: "/refresh/writer.lock/", reason: "Active host-local refresh lease, not a retained snapshot." }),
  Object.freeze({ pattern: "/refresh/writer.lock.*.staging/", reason: "Unpublished nonce-owned refresh lease staging." }),
]);
const BEGIN = "# BEGIN Lode generated disposable storage rules", END = "# END Lode generated disposable storage rules";
export function ensureProjectStorageIgnore({ root, storage }) {
  const file = path.join(root, formatForVerifiedOwner(storage).directory, ".gitignore");
  try {
    if (fs.realpathSync(root) !== storage?.projectRoot) throw Object.assign(new Error("Ignore Project root mismatch."), { code: "PROJECT_IDENTITY_MISMATCH" });
    assertProjectStorageUnchanged(storage);
    return withProjectMutation({ root, storage, scope: "storage-ignore", timeoutMs: 0 }, () => {
      safeSnapshotPath(root, file);
      const rootIgnore = path.join(root, ".gitignore"), rootStat = fs.lstatSync(rootIgnore, { throwIfNoEntry: false });
      if (rootStat) {
        if (!rootStat.isFile() || rootStat.isSymbolicLink() || rootStat.size > 1024 * 1024) return { status: "preserved", reasonCode: "USER_IGNORE_UNAVAILABLE", ordinaryWorkBlocked: false };
        if (/^\s*!/m.test(new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(rootIgnore)))) return { status: "preserved", reasonCode: "USER_IGNORE_RULES_TAKE_PRECEDENCE", ordinaryWorkBlocked: false };
      }
      // An existing file belongs to its editor, including generated files edited
      // later. Never append: a concurrent user exception must keep its ordering.
      if (fs.lstatSync(file, { throwIfNoEntry: false })) return { status: "preserved", reasonCode: "EXISTING_STORAGE_IGNORE", ordinaryWorkBlocked: false };
      const block = [BEGIN, ...GENERATED_STORAGE_IGNORE_RULES.map(rule => rule.pattern), END, ""].join("\n");
      assertProjectStorageUnchanged(storage);
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
    for (const file of [path.join(root, ".gitignore"), path.join(parent, ".gitignore")]) {
      safeSnapshotPath(root, file);
      if (!fs.existsSync(file)) continue;
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) return { status: "preserved", reasonCode: "USER_IGNORE_UNAVAILABLE" };
      if (/^\s*!/m.test(new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file)))) return { status: "preserved", reasonCode: "USER_IGNORE_RULES_TAKE_PRECEDENCE" };
    }
    const file = safeSnapshotPath(root, path.join(directory, ".gitignore"));
    if (fs.existsSync(file)) return { status: "preserved", reasonCode: "EXISTING_OWNED_IGNORE" };
    try { atomicCreateArtifact(file, "# Retained local snapshot objects; not disposable cache.\n*\n!.gitignore\n"); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    return { status: "created", trackingChanged: false };
  } catch (error) { return { status: "preserved", reasonCode: error.code || "USER_IGNORE_UNAVAILABLE" }; }
}

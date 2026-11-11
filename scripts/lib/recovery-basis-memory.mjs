import fs from "node:fs";
import path from "node:path";

// 4-D (user decision 4-2 (a)): the recovery basis id this server last handed a
// verified caller, per (caller, Project root, logical Session), so the caller
// can omit `expected_recovery_basis_id` on `lode_checkpoint_sync`. In memory
// only: no file, lock or cache; it dies with the server process. A held value is
// used exactly as if the caller had passed it, so the existing conflict check is
// unchanged. Bounded by size only: a held basis that is no longer current
// conflicts on use, and one that is still current stays valid, so age adds
// nothing to correctness.
export function createRecoveryBasisMemory({ maxEntries = 1024 } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error("Invalid recovery basis memory bounds.");
  const entries = new Map();
  const canonicalRoot = (root) => {
    try {
      return fs.realpathSync(path.resolve(root));
    } catch {
      return path.resolve(root);
    }
  };
  const keyOf = (callerKey, root, sessionId) => JSON.stringify([callerKey, canonicalRoot(root), sessionId]);
  return Object.freeze({
    // A view bound to one verified caller; another caller's values are unreachable.
    forCaller(callerKey) {
      if (typeof callerKey !== "string" || !callerKey) throw new Error("A verified caller key is required.");
      return Object.freeze({
        held(root, sessionId) {
          return entries.get(keyOf(callerKey, root, sessionId))?.basisId ?? null;
        },
        hold(root, sessionId, basisId) {
          if (typeof sessionId !== "string" || typeof basisId !== "string") return;
          const key = keyOf(callerKey, root, sessionId);
          entries.delete(key);
          entries.set(key, { basisId });
          while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
        },
        drop(root, sessionId) {
          entries.delete(keyOf(callerKey, root, sessionId));
        },
      });
    },
    describe() {
      return { entries: entries.size, maxEntries, persisted: false, authorityPlane: "P5", recoveryAuthority: false };
    },
    clear() {
      entries.clear();
    },
  });
}

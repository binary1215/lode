import { withSnapshotReferences, withSnapshotReferencesAsync } from "../world/snapshot-reference-lifetime.mjs";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolveProjectStorage, formatForVerifiedOwner, assertProjectStorageUnchanged } from "./project-storage-format.mjs";
import {
  context,
  WAIT_MS,
  fail,
  safeDirectory,
  retryLockRead,
  attempt,
  release,
  cleanInterruptedStaging,
  nestedOwner,
  withLocalMutation,
} from "./local-mutation-lock.mjs";

// The lock primitives live in local-mutation-lock.mjs, below the snapshot
// reference lifetime that uses them; existing importers keep this path.
export { withLocalMutation, withLocalMutationAsync } from "./local-mutation-lock.mjs";

function lockFor(root, scope, storage) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(scope)) fail("Invalid mutation scope.", "INVALID_PROJECT_MUTATION_SCOPE");
  const canonicalRoot = fs.realpathSync(path.resolve(root));
  const headRoot = path.join(canonicalRoot, formatForVerifiedOwner(storage).directory);
  if (!fs.existsSync(headRoot)) fail("Lode Agent Core is not initialized.", "NOT_INITIALIZED");
  retryLockRead(() => safeDirectory(headRoot));
  return path.join(headRoot, ".operations", `${scope}.lock`);
}

function withProjectMutationUncoordinated({ root = ".", scope, storage, timeoutMs }, operation) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(scope)) fail("Invalid mutation scope.", "INVALID_PROJECT_MUTATION_SCOPE");
  storage ??= resolveProjectStorage(root);
  const recheck = () => {
    if (storage?.projectFile) assertProjectStorageUnchanged(storage);
  };
  recheck();
  return withLocalMutation({ directory: lockFor(root, scope, storage), timeoutMs }, () => {
    recheck();
    return operation();
  });
}

async function withProjectMutationAsyncUncoordinated({ root = ".", scope, storage }, operation) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(scope)) fail("Invalid mutation scope.", "INVALID_PROJECT_MUTATION_SCOPE");
  storage ??= resolveProjectStorage(root);
  const recheck = () => {
    if (storage?.projectFile) assertProjectStorageUnchanged(storage);
  };
  recheck();
  const directory = lockFor(root, scope, storage);
  if (nestedOwner(directory)) return operation();
  cleanInterruptedStaging(directory);
  const deadline = Date.now() + WAIT_MS;
  let owner;
  while (!(owner = attempt(directory))) {
    if (Date.now() >= deadline) fail(`The ${scope} operation is busy; retry this operation shortly.`);
    await delay(10);
  }
  try {
    recheck();
    const active = new Map(context.getStore() || []);
    active.set(directory, owner);
    return await context.run(active, operation);
  } finally {
    release(owner);
  }
}

function prepareProjectMutation(options) {
  const { root = ".", scope } = options;
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(scope)) fail("Invalid mutation scope.", "INVALID_PROJECT_MUTATION_SCOPE");
  const storage = options.storage ?? resolveProjectStorage(root);
  const directory = lockFor(root, scope, storage);
  // Preserve the existing pure namespace/input errors before registering the
  // additional snapshot lifetime. A damaged lock path is never contention.
  for (const file of [path.dirname(directory), directory])
    retryLockRead(() => {
      const stat = fs.lstatSync(file, { throwIfNoEntry: false });
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) fail("Unsafe mutation lock path.", "INVALID_PROJECT_MUTATION_LOCK");
    });
  return { ...options, root, storage };
}

export function withProjectMutation(options = {}, ...rest) {
  const prepared = prepareProjectMutation(options);
  return withSnapshotReferences({ root: prepared.root, storage: prepared.storage }, () => withProjectMutationUncoordinated(prepared, ...rest));
}

export async function withProjectMutationAsync(options = {}, ...rest) {
  const prepared = prepareProjectMutation(options);
  return withSnapshotReferencesAsync({ root: prepared.root, storage: prepared.storage }, () => withProjectMutationAsyncUncoordinated(prepared, ...rest));
}

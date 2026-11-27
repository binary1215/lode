import fs from "node:fs";
import path from "node:path";

// Shared operational parents (for example <root>/runtime-claude-proposals and its
// per-Project folder, or the lease release's per-Project folder and its root) are
// created and removed by every worker of a Project. Which folders are shared is
// decided by position, never by an error: in a creation chain every level but
// the last (the worker's own folder) is shared; the lease release passes only
// its two shared parents here and keeps its own folder's rule itself.

const onWindows = process.platform === "win32";
const windowsInUse = (error) => onWindows && (error?.code === "EPERM" || error?.code === "EBUSY");

// The lost-race rule as released in beta.139, for anything that is not a shared
// parent past its safety check (for example the worker's own lease folder):
// gone, not empty or reappeared is a sibling's work; on Windows EPERM and EBUSY
// count only when the folder is gone afterwards.
export function isLostOperationalFolderRace(error, folder) {
  return error?.code === "ENOENT" || error?.code === "ENOTEMPTY" || error?.code === "EEXIST" || (windowsInUse(error) && !fs.existsSync(folder));
}

const pause = new Int32Array(new SharedArrayBuffer(4));
// A shared parent that another worker is still deleting can stay in that state
// for a while: creation waits between attempts, within a fixed total bound.
export const OPERATIONAL_FOLDER_RETRY_STEP_MS = 10;
export const OPERATIONAL_FOLDER_RETRY_TOTAL_MS = 2000;

// Creates each folder of `chain` (each one inside the previous one; the last is
// the worker's own folder), one level at a time: a level is checked (a real
// directory at its canonical path, not a link) before the next one is created,
// so nothing is ever created through a link or a file. A level that exists and
// fails the check is refused at once. Creation is retried, within the bound,
// only when a shared parent of the failing level was removed under the worker:
// a level before the failing one, or the failing level's own parent, is missing
// at that moment.
export function createOperationalFolders(chain, { unsafe }) {
  const started = Date.now();
  for (;;) {
    let failing = -1;
    try {
      for (const [index, folder] of chain.entries()) {
        failing = index;
        try {
          fs.mkdirSync(folder, { mode: 0o700 });
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
        const stat = fs.lstatSync(folder);
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(folder) !== folder) unsafe();
      }
      return;
    } catch (error) {
      // ENOENT is never a plain permission error: a level, or a parent of it,
      // vanished under the worker (it may already be back when looked at again).
      // EPERM/EBUSY on Windows retry when a shared parent of the failing level is
      // missing at that moment, or when the failing level itself does not exist:
      // a level that another worker is still deleting reports EPERM to mkdir and
      // cannot be told from a plain permission error, so that case keeps the
      // bound. An EPERM/EBUSY for a level that exists fails at once.
      const removed = chain.slice(0, Math.max(failing, 0)).some((folder) => !fs.existsSync(folder));
      const retry =
        failing >= 0 &&
        (error?.code === "ENOENT" || (windowsInUse(error) && (removed || !fs.existsSync(path.dirname(chain[failing])) || !fs.existsSync(chain[failing]))));
      if (retry && Date.now() - started < OPERATIONAL_FOLDER_RETRY_TOTAL_MS) {
        Atomics.wait(pause, 0, 0, OPERATIONAL_FOLDER_RETRY_STEP_MS);
        continue;
      }
      throw error;
    }
  }
}

// Removes the shared parents, deepest first, while they are empty. Before the
// safety check the released rule applies. Past it, a shared parent that is gone,
// not empty or reappeared is left as it is, and so (on Windows) is one that
// reports EPERM or EBUSY: another worker is creating in it, using it or deleting
// it, whether or not it exists a moment later. `check(resolved)` adds a caller's
// own safety rule (for example "inside the operational root, not the root");
// `exactPath: false` keeps a caller whose released check never compared the
// canonical path with the given one (the lease release) as it was.
export function removeEmptyOperationalParents(parents, { unsafe, check = () => true, exactPath = true }) {
  for (const folder of parents) {
    let stat, resolved;
    try {
      if (!fs.existsSync(folder)) break;
      stat = fs.lstatSync(folder);
      resolved = fs.realpathSync(folder);
    } catch (error) {
      if (isLostOperationalFolderRace(error, folder)) break;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (exactPath && resolved !== folder) || !check(resolved)) unsafe();
    try {
      if (fs.readdirSync(folder).length) break;
      fs.rmdirSync(folder);
    } catch (error) {
      if (isLostOperationalFolderRace(error, folder) || windowsInUse(error)) break;
      throw error;
    }
  }
}

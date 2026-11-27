import fs from "node:fs";

// Shared operational parents (for example <root>/runtime-claude-proposals and its
// per-Project folder) are created and removed by every worker of a Project.
// Another worker may remove an empty parent, or create a member in it, between
// one worker's steps. Losing that race is not an error. On Windows a folder that
// another process is deleting reports EPERM or EBUSY; only a folder that is gone
// afterwards counts as the lost race. Everything else stays strict.
export function isLostOperationalFolderRace(error, folder) {
  return (
    error?.code === "ENOENT" ||
    error?.code === "ENOTEMPTY" ||
    error?.code === "EEXIST" ||
    (process.platform === "win32" && (error?.code === "EPERM" || error?.code === "EBUSY") && !fs.existsSync(folder))
  );
}

// Creates each folder of `chain` (each one inside the previous one; the last is
// the worker's own folder), one level at a time: a level is checked (a real
// directory at its canonical path, not a link) before the next one is created,
// so nothing is ever created through a link or a file. A level that exists and
// fails the check is refused at once. A parent removed under the worker by
// another worker's cleanup (a level of the chain missing at that moment) makes
// the whole chain be created again.
export function createOperationalFolders(chain, { unsafe }) {
  for (let attempt = 0; ; attempt++) {
    try {
      for (const folder of chain) {
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
      const raceCode = error?.code === "ENOENT" || (process.platform === "win32" && (error?.code === "EPERM" || error?.code === "EBUSY"));
      if (attempt < 32 && raceCode && chain.some((folder) => !fs.existsSync(folder))) continue;
      throw error;
    }
  }
}

// Removes the shared parents, deepest first, while they are empty. A parent that
// is gone, not empty or busy being deleted is another worker's business.
export function removeEmptyOperationalParents(parents, { unsafe }) {
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
    if (!stat.isDirectory() || stat.isSymbolicLink() || resolved !== folder) unsafe();
    try {
      if (fs.readdirSync(folder).length) break;
      fs.rmdirSync(folder);
    } catch (error) {
      if (isLostOperationalFolderRace(error, folder)) break;
      throw error;
    }
  }
}

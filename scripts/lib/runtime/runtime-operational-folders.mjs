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
// the worker's own folder) and checks each is a real directory at its canonical
// path. A parent removed under it by another worker's cleanup is created again.
export function createOperationalFolders(chain, { unsafe }) {
  for (let attempt = 0; ; attempt++) {
    try {
      for (const folder of chain) {
        try {
          fs.mkdirSync(folder, { mode: 0o700 });
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
      }
      for (const folder of chain) {
        const stat = fs.lstatSync(folder);
        if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(folder) !== folder) unsafe();
      }
      return;
    } catch (error) {
      const lost = error?.code === "ENOENT" || (process.platform === "win32" && (error?.code === "EPERM" || error?.code === "EBUSY"));
      if (attempt < 32 && lost) continue;
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

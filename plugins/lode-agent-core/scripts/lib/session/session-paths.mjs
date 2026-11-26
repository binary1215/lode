import fs from "node:fs";
import path from "node:path";
import { formatForVerifiedOwner } from "../storage/project-storage-format.mjs";
import { fail } from "../core/errors.mjs";
import { escapesRoot } from "../core/path-safety.mjs";

// Effect-free path confinement shared by Session routing and common direction.
export function safeSessionPath(root, ...parts) {
  const base = fs.realpathSync(path.resolve(root || "."));
  const file = path.resolve(base, ...parts);
  const relative = path.relative(base, file);
  if (escapesRoot(relative)) fail("Session path escapes Project root.", "SESSION_PATH_ESCAPE");
  let current = base;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail("Session path traverses a symlink.", "SESSION_PATH_ESCAPE");
  }
  return file;
}

export function defaultSessionStatePath(root, storage) {
  return safeSessionPath(root, formatForVerifiedOwner(storage).directory, "sessions", "current.json");
}

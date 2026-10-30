import fs from "node:fs";
import path from "node:path";
import { formatForVerifiedOwner } from "./project-storage-format.mjs";

const fail = (message, code) => { throw Object.assign(new Error(message), { code }); };

// Effect-free path confinement shared by Session routing and common direction.
export function safeSessionPath(root, ...parts) {
  const base = fs.realpathSync(path.resolve(root || "."));
  const file = path.resolve(base, ...parts);
  const relative = path.relative(base, file);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail("Session path escapes Project root.", "SESSION_PATH_ESCAPE");
  let current = base;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail("Session path traverses a symlink.", "SESSION_PATH_ESCAPE");
  }
  return file;
}

export function defaultSessionStatePath(root, storage) { return safeSessionPath(root, formatForVerifiedOwner(storage).directory, "sessions", "current.json"); }

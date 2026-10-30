import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const fail = message => { throw Object.assign(new Error(message), { code: "WORKER_INTEGRATION_STORAGE_CONFLICT" }); };
export const integrationDigest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const integrationJson = value => JSON.stringify(canonical(value));

// No arbitrary caller path: integration evidence lives beneath the exact project.
// These checks are tamper observations, not an OS security sandbox or atomic CAS.
export function workerIntegrationDirectory(root, create = false, storage) {
  let directory = fs.realpathSync(root);
  for (const part of [formatForVerifiedOwner(storage).directory, "runtime", "worker-integrations"]) {
    directory = path.join(directory, part);
    if (create) {
      try { fs.mkdirSync(directory, { mode: 0o700 }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) fail("Unsafe worker integration directory.");
  }
  return directory;
}

function safeStat(file) {
  // NTFS file identities can exceed Number's exact integer range. Rounding
  // can make a retained prior pending file appear to be a second owned alias.
  let stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) fail("Worker integration evidence is not a regular file.");
  if (stat.nlink === 1n) return stat;
  // A crash after link publication and before unlink leaves this exact alias.
  // Reading it does not delete anything or manufacture publication authority.
  if (stat.nlink !== 2n) fail("Unexpected worker integration hardlink.");
  try {
    const stem = `${path.basename(file)}.pending`;
    const aliases = fs.readdirSync(path.dirname(file)).filter(name => name === stem
      || name.startsWith(`${stem}--`) && /^[a-f0-9-]{36}$/.test(name.slice(stem.length + 2)))
      .map(name => fs.lstatSync(path.join(path.dirname(file), name), { bigint: true }))
      .filter(candidate => candidate.dev === stat.dev && candidate.ino === stat.ino);
    if (aliases.length !== 1) {
      const current = fs.lstatSync(file, { bigint: true });
      if (aliases.length === 0 && current.isFile() && !current.isSymbolicLink() && current.nlink === 1n
        && current.ino === stat.ino && current.dev === stat.dev) return current;
      fail("Worker integration publication alias is not unique.");
    }
    const pending = aliases[0];
    if (!pending.isFile() || pending.isSymbolicLink() || pending.nlink !== 2n
      || pending.dev !== stat.dev || pending.ino !== stat.ino) fail("Worker integration publication alias differs.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) fail("Worker integration publication changed.");
  }
  return stat;
}

export function readIntegrationBytes(file) {
  const before = safeStat(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) fail("Worker integration evidence changed during open.");
    const bytes = fs.readFileSync(fd);
    const after = safeStat(file);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== BigInt(bytes.length)
      || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) fail("Worker integration evidence changed during read.");
    return bytes;
  } finally { fs.closeSync(fd); }
}

// File contents are flushed before create-only publication. This supplies a
// process-crash barrier, not a filesystem-independent power-loss guarantee.
// An interrupted complete pending write can converge. A partial one is retained
// unchanged while a fresh staging file publishes the same final evidence. No
// file effect has started before its final intent exists. Caller holds the
// session-recovery lock; these pending files are never execution claims.
export function publishIntegrationJson(file, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (fs.existsSync(file)) {
    if (!readIntegrationBytes(file).equals(bytes)) fail("Worker integration publication diverged.");
    return false;
  }
  let pending = `${file}.pending`;
  let fd;
  try {
    fd = fs.openSync(pending, "wx", 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const stat = fs.lstatSync(pending, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) fail("Interrupted integration evidence path is unsafe.");
    if (readIntegrationBytes(pending).equals(bytes)) fd = fs.openSync(pending, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
    else {
      pending = `${file}.pending--${crypto.randomUUID()}`;
      fd = fs.openSync(pending, "wx", 0o600);
      fs.writeFileSync(fd, bytes);
    }
    const opened = fs.fstatSync(fd, { bigint: true });
    const observed = fs.lstatSync(pending, { bigint: true });
    if (!opened.isFile() || opened.dev !== observed.dev || opened.ino !== observed.ino
      || observed.isSymbolicLink() || opened.nlink !== 1n || !readIntegrationBytes(pending).equals(bytes)) fail("Pending integration changed while reopening.");
    fs.fsyncSync(fd);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  try { fs.linkSync(pending, file); }
  catch (error) {
    if (error.code !== "EEXIST" || !readIntegrationBytes(file).equals(bytes)) throw error;
  }
  // A changed pending path must never make this function report that another
  // document was durably published. Do not clean a divergent/unowned alias.
  if (!readIntegrationBytes(file).equals(bytes)) fail("Worker integration changed during publication.");
  const published = fs.lstatSync(file, { bigint: true });
  const staged = fs.lstatSync(pending, { bigint: true });
  if (published.dev !== staged.dev || published.ino !== staged.ino) fail("Worker integration staging ownership changed.");
  fs.unlinkSync(pending);
  return true;
}

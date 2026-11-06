import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const fail = (code, message = code) => {
  throw Object.assign(new Error(message), { code });
};
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

// Data-file paths only. Historical absolute roots inside a record are never
// resolved through this function. Reject Windows alternate streams on every
// platform so an imported inventory cannot name another view of the same file.
export function assertCopiedProjectRelativePath(relative) {
  if (
    typeof relative !== "string" ||
    !relative ||
    path.isAbsolute(relative) ||
    relative
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[\\:<>"|?*\u0000-\u001f]/.test(part) ||
          /[. ]$/.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    fail("PROJECT_COPY_PATH_INVALID");
}

export function copiedProjectFile(root, relative) {
  assertCopiedProjectRelativePath(relative);
  const base = fs.realpathSync(root);
  let file = base;
  for (const part of relative.split("/")) {
    file = path.join(file, part);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) fail("PROJECT_COPY_UNSAFE_PATH");
  }
  return file;
}

function sameFile(before, after) {
  return (
    after?.isFile() &&
    after.nlink === 1n &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

function checkCopyAuthority(check) {
  if (check == null) return;
  if (typeof check !== "function") fail("PROJECT_COPY_AUTHORITY_CHECK_INVALID");
  const result = check();
  if (result && typeof result.then === "function") {
    Promise.resolve(result).catch(() => {});
    fail("PROJECT_COPY_SYNCHRONOUS_AUTHORITY_REQUIRED");
  }
}

// Streaming raw-byte observation. No decoder, canonicalization, alias or
// Project selection is involved, including for unknown optional record types.
export function inspectCopiedProjectFile(
  root,
  relative,
  { signal, onChunk = null, assertCurrentAuthority = null } = {},
) {
  if (signal?.aborted) fail("PROJECT_COPY_CANCELLED");
  checkCopyAuthority(assertCurrentAuthority);
  const file = copiedProjectFile(root, relative);
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(Number.MAX_SAFE_INTEGER))
    fail("PROJECT_COPY_UNSAFE_FILE");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!sameFile(before, fs.fstatSync(fd, { bigint: true }))) fail("PROJECT_COPY_SOURCE_CHANGED");
    const hash = crypto.createHash("sha256"),
      chunk = Buffer.alloc(64 * 1024);
    let bytes = 0;
    while (true) {
      if (signal?.aborted) fail("PROJECT_COPY_CANCELLED");
      checkCopyAuthority(assertCurrentAuthority);
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      bytes += count;
      if (BigInt(bytes) > before.size) fail("PROJECT_COPY_SOURCE_CHANGED");
      hash.update(chunk.subarray(0, count));
      onChunk?.(chunk.subarray(0, count), bytes - count);
    }
    if (
      BigInt(bytes) !== before.size ||
      !sameFile(before, fs.fstatSync(fd, { bigint: true })) ||
      !sameFile(before, fs.lstatSync(file, { bigint: true }))
    )
      fail("PROJECT_COPY_SOURCE_CHANGED");
    checkCopyAuthority(assertCurrentAuthority);
    return { path: relative, bytes, sha256: hash.digest("hex") };
  } finally {
    fs.closeSync(fd);
  }
}

function excluded(relative) {
  const local = relative.split("/").slice(1).join("/");
  return (
    /^(?:\.operations|\.snapshot-gc|messaging)(?:\/|$)/.test(local) ||
    /^refresh\/writer\.lock(?:\.|\/|$)/.test(local) ||
    /^runtime\/execution-leases\/[^/]+\/owner\.lock(?:\/|$)/.test(local)
  );
}

export function inspectCopiedProjectFiles({ root, directory, signal } = {}) {
  if (![".head", ".lode"].includes(directory)) fail("PROJECT_COPY_PATH_INVALID");
  const files = [],
    excludedPaths = [];
  const visit = (relative) => {
    if (signal?.aborted) fail("PROJECT_COPY_CANCELLED");
    if (excluded(relative)) {
      excludedPaths.push(relative);
      return;
    }
    const file = copiedProjectFile(root, relative),
      stat = fs.lstatSync(file);
    if (stat.isDirectory()) {
      const entries = fs.opendirSync(file);
      try {
        for (let entry; (entry = entries.readSync()); ) visit(`${relative}/${entry.name}`);
      } finally {
        entries.closeSync();
      }
    } else files.push(inspectCopiedProjectFile(root, relative, { signal }));
  };
  visit(directory);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    files,
    excludedPaths: excludedPaths.sort(),
    integrity: "raw-byte-inventory-only",
    grantsOwnership: false,
  };
}

export function verifyCopiedProjectFile(root, entry, options = {}) {
  if (
    !entry ||
    typeof entry.path !== "string" ||
    !Number.isSafeInteger(entry.bytes) ||
    entry.bytes < 0 ||
    typeof entry.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(entry.sha256)
  )
    fail("PROJECT_COPY_INVENTORY_INVALID");
  const current = inspectCopiedProjectFile(root, entry.path, options);
  if (current.bytes !== entry.bytes || current.sha256 !== entry.sha256)
    fail("PROJECT_COPY_SOURCE_CHANGED");
  return current;
}

export function copiedEvidenceDigest(inventory) {
  return digest(JSON.stringify(inventory));
}

// Manifest syntax/physical aliases are rejected before any repair/publication.
// This observes paths only; it does not reinterpret missing generated files as
// missing Canon or grant permission to overwrite a user-owned integration.
export function validateCopiedManagedPaths({ root, directory, manifest } = {}) {
  if (
    ![".lode", ".head"].includes(directory) ||
    manifest?.schemaVersion !== 1 ||
    !Array.isArray(manifest.managed)
  )
    fail("PROJECT_REPAIR_MANIFEST_INVALID");
  const names = new Set(),
    physical = new Set();
  for (const entry of manifest.managed) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      (!entry.path.startsWith(directory + "/") &&
        !["AGENTS.md", "CLAUDE.md", ".mcp.json", "opencode.json"].includes(entry.path))
    )
      fail("PROJECT_REPAIR_MANIFEST_INVALID");
    const file = copiedProjectFile(root, entry.path),
      key = entry.path.toLowerCase();
    if (names.has(key)) fail("PROJECT_COPY_PATH_ALIAS");
    names.add(key);
    const stat = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
    if (!stat) continue;
    if (!stat.isFile() || stat.nlink !== 1n) fail("PROJECT_COPY_UNSAFE_FILE");
    const identity = stat.dev + ":" + stat.ino;
    if (physical.has(identity)) fail("PROJECT_COPY_PATH_ALIAS");
    physical.add(identity);
  }
  return manifest;
}

export function readCopiedProjectExcerpt(root, entry, { offset = 0, maxBytes = 65536, signal, assertCurrentAuthority } = {}) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 512 * 1024 * 1024
  )
    fail("PROJECT_COPY_EXCERPT_INVALID");
  if (!entry || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256))
    fail("PROJECT_COPY_INVENTORY_INVALID");
  const chunks = [];
  const observed = inspectCopiedProjectFile(root, entry.path, {
    signal, assertCurrentAuthority,
    onChunk(bytes, start) {
      const from = Math.max(offset, start),
        to = Math.min(offset + maxBytes, start + bytes.length);
      if (to > from) chunks.push(Buffer.from(bytes.subarray(from - start, to - start)));
    },
  });
  if (observed.sha256 !== entry.sha256 || observed.bytes !== entry.bytes)
    fail("PROJECT_COPY_SOURCE_CHANGED");
  return {
    bytes: Buffer.concat(chunks),
    totalBytes: observed.bytes,
    offset,
    rawSha256: observed.sha256,
  };
}

const checkCopySignal = (signal) => {
  if (signal?.aborted) fail("PROJECT_PORTABILITY_CANCELLED");
};
export function copyOriginal(
  sourceRoot,
  bundleRoot,
  entry,
  {
    signal,
    onObject,
    onTemporary = null,
    sourceRelative = entry.path,
    targetRelative = "objects/" + entry.sha256 + ".bin",
    stagingDirectory = null,
    assertCurrentAuthority = null,
  } = {},
) {
  if (onTemporary !== null && typeof onTemporary !== "function") fail("PROJECT_COPY_TEMPORARY_OBSERVER_INVALID");
  const check = () => {
    checkCopySignal(signal);
    checkCopyAuthority(assertCurrentAuthority);
  };
  check();
  const relative = targetRelative,
    target = copiedProjectFile(bundleRoot, relative),
    sourceEntry = { ...entry, path: sourceRelative };
  if (fs.existsSync(target)) {
    verifyCopiedProjectFile(
      bundleRoot,
      { ...entry, path: relative },
      { signal, assertCurrentAuthority },
    );
    return;
  }
  verifyCopiedProjectFile(sourceRoot, sourceEntry, { signal, assertCurrentAuthority });
  const source = copiedProjectFile(sourceRoot, sourceRelative),
    before = fs.lstatSync(source, { bigint: true });
  const stageParent = stagingDirectory ?? path.posix.dirname(relative);
  const tmpRelative =
      (stageParent === "." || stageParent === "" ? "" : stageParent + "/") +
      "." +
      entry.sha256 +
      "-" +
      crypto.randomUUID() +
      ".part",
    temporary = copiedProjectFile(bundleRoot, tmpRelative);
  const input = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)),
    hash = crypto.createHash("sha256");
  let bytes = 0,
    closed = false,
    output = null;
  try {
    check();
    output = fs.openSync(temporary, "wx");
    if (onTemporary !== null) {
      const owned = fs.fstatSync(output, { bigint: true });
      onTemporary({ path: tmpRelative, dev: String(owned.dev), ino: String(owned.ino),
        birthtimeNs: String(owned.birthtimeNs), nlink: String(owned.nlink) });
    }
    const opened = fs.fstatSync(input, { bigint: true });
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1n)
      fail("PROJECT_COPY_SOURCE_CHANGED");
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      check();
      const n = fs.readSync(input, buffer, 0, buffer.length, null);
      if (!n) break;
      bytes += n;
      if (bytes > entry.bytes) fail("PROJECT_COPY_SOURCE_CHANGED");
      hash.update(buffer.subarray(0, n));
      let offset = 0;
      while (offset < n) {
        check();
        const written = fs.writeSync(output, buffer, offset, n - offset);
        if (written < 1) fail("PROJECT_BUNDLE_WRITE_FAILED");
        offset += written;
      }
    }
    fs.fsyncSync(output);
    fs.closeSync(output);
    closed = true;
    if (bytes !== entry.bytes || hash.digest("hex") !== entry.sha256)
      fail("PROJECT_COPY_SOURCE_CHANGED");
    verifyCopiedProjectFile(sourceRoot, sourceEntry, { signal, assertCurrentAuthority });
    // link is no-clobber on every supported OS; remove only our private stage.
    check();
    try {
      fs.linkSync(temporary, target);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      verifyCopiedProjectFile(bundleRoot, { ...entry, path: relative });
    }
    try { fs.unlinkSync(temporary); }
    catch (error) {
      // A caller may clean only its proved private stage, never bypass an
      // explicit refusal of this same cleanup effect by retrying elsewhere.
      error.copyStageUnlinkDenied = ["EACCES", "EPERM"].includes(error.code);
      throw error;
    }
    onObject?.(entry.path);
  } catch (error) {
    error.incompleteObject = tmpRelative;
    throw error;
  } finally {
    fs.closeSync(input);
    if (!closed && output !== null) fs.closeSync(output);
  }
}

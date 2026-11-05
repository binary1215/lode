import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";
const sessionIdOf = record => {
  const format = familyFormatForOriginal({ sessionIdentity: true }, record);
  return format ? record?.[format.sessionIdField] : undefined;
};
const originalFormat = record => familyFormatForOriginal({ kind: record?.kind }, record);
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Host-local bounded provider output. This is not a transcript in project Canon,
// an authorization, a lease release, or proof that the owner has exited.
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const fail = (message) => { throw Object.assign(new Error(message), { code: "INVALID_RUNTIME_OUTPUT_SPOOL" }); };
function directoryFor(operationalRoot, authorization, create) {
  if (!new RegExp(`^${originalFormat(authorization)?.projectPrefix || "head-"}[a-f0-9]{20}$`).test(authorization.projectId || "")
    || !/^execution-authorization-[a-f0-9]{24}$/.test(authorization.authorizationId || "")
    || !/^[a-f0-9]{64}$/.test(authorization.authorizationHash || "")) fail("Spool requires exact authorization identity.");
  const root = fs.realpathSync(operationalRoot);
  let directory = root;
  for (const segment of ["runtime-output", authorization.projectId, authorization.authorizationId]) {
    directory = path.join(directory, segment);
    if (create) { try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; } }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) fail("Unsafe spool directory.");
  }
  return directory;
}
function exclusiveJson(file, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  const staging = `${file}.pending`;
  const fd = fs.openSync(staging, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.linkSync(staging, file);
  fs.unlinkSync(staging);
}
function safeFileStat(file, limit, publicationAlias) {
  let stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) fail("Unsafe or oversized spool file.");
  if (stat.nlink === 1) return stat;
  if (!publicationAlias || stat.nlink !== 2) fail("Unexpected spool hardlink.");
  // Publication may have committed just before a crash or pending-unlink EIO.
  // Recognize only our exact second name, without unlinking a live writer's file.
  try {
    const pending = fs.lstatSync(`${file}.pending`);
    if (!pending.isFile() || pending.isSymbolicLink() || pending.nlink !== 2
      || pending.ino !== stat.ino || pending.dev !== stat.dev || pending.size !== stat.size) fail("Spool publication alias differs.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    stat = fs.lstatSync(file); // The publishing writer may just have unlinked it.
    if (stat.nlink !== 1 || !stat.isFile() || stat.isSymbolicLink() || stat.size > limit) fail("Spool publication changed unsafely.");
  }
  return stat;
}
function readBounded(file, limit, publicationAlias = false) {
  const stat = safeFileStat(file, limit, publicationAlias);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const actual = fs.fstatSync(fd);
    if (!actual.isFile() || actual.ino !== stat.ino || actual.dev !== stat.dev || actual.size > limit) fail("Spool file changed while opening.");
    const bytes = Buffer.alloc(actual.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) fail("Spool read ended early.");
      offset += count;
    }
    const final = safeFileStat(file, limit, publicationAlias);
    if (final.ino !== actual.ino || final.dev !== actual.dev || final.size !== actual.size) fail("Spool file changed while reading.");
    return bytes;
  } finally { fs.closeSync(fd); }
}
function limitsFor(authorization) {
  const { maxStdoutBytes, maxStderrBytes } = authorization.limits || {};
  if (!Number.isSafeInteger(maxStdoutBytes) || maxStdoutBytes < 1 || maxStdoutBytes > 16 * 1024 * 1024
    || !Number.isSafeInteger(maxStderrBytes) || maxStderrBytes < 1 || maxStderrBytes > 2 * 1024 * 1024) fail("Invalid spool bounds.");
  return { stdout: maxStdoutBytes, stderr: maxStderrBytes };
}

export function openRuntimeOutputSpool({ operationalRoot, authorization, callerFenceDigest, supervisorManifestDigest, providerMode }) {
  const limits = limitsFor(authorization);
  const directory = directoryFor(operationalRoot, authorization, true);
  const header = { kind: "RuntimeOutputSpool", protocolVersion: "0.1.0", authorizationId: authorization.authorizationId,
    authorizationHash: authorization.authorizationHash, inputDigest: authorization.executionInput.digest,
    callerFenceDigest, supervisorManifestDigest, providerMode, limits, authority: "host-operational-evidence-only" };
  exclusiveJson(path.join(directory, "header.json"), header);
  const streams = {};
  let closed = false;
  try {
    for (const name of ["stdout", "stderr"]) streams[name] = { fd: fs.openSync(path.join(directory, `${name}.bin`), "wx", 0o600),
      bytes: 0, hash: crypto.createHash("sha256"), truncated: false };
  } catch (error) {
    for (const stream of Object.values(streams)) fs.closeSync(stream.fd);
    throw error;
  }
  return {
    append(name, chunk) {
      const stream = streams[name];
      if (closed || !stream || !Buffer.isBuffer(chunk)) fail("Invalid spool write.");
      const remaining = limits[name] - stream.bytes;
      const retained = chunk.subarray(0, remaining);
      let offset = 0;
      while (offset < retained.length) {
        const count = fs.writeSync(stream.fd, retained, offset, retained.length - offset);
        if (!count) fail("Spool write made no progress.");
        offset += count;
      }
      fs.fsyncSync(stream.fd); // Persist before interpreting any model event.
      stream.hash.update(retained);
      stream.bytes += retained.length;
      stream.truncated ||= chunk.length > retained.length;
      return !stream.truncated;
    },
    complete(result) {
      if (closed) fail("Output spool is closed.");
      const summary = Object.fromEntries(Object.entries(streams).map(([name, stream]) => [name,
        { bytes: stream.bytes, digest: stream.hash.copy().digest("hex"), truncated: stream.truncated }]));
      const payload = { headerDigest: digest(Buffer.from(JSON.stringify(header))), streams: summary, result,
        ownerExitRequired: true, recoveryAuthority: false };
      const payloadBytes = Buffer.from(JSON.stringify(payload));
      if (payloadBytes.length > limits.stdout * 2 + 1024 * 1024) fail("Spool terminal exceeds bound.");
      exclusiveJson(path.join(directory, "terminal.json"), { ...payload, terminalDigest: digest(payloadBytes) });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const stream of Object.values(streams)) fs.closeSync(stream.fd);
    },
  };
}

export function readRuntimeOutputSpool({ operationalRoot, authorization }) {
  const limits = limitsFor(authorization);
  const directory = directoryFor(operationalRoot, authorization, false);
  const headerFile = path.join(directory, "header.json");
  if (!fs.existsSync(headerFile)) return { status: "unpublished", header: null, outputs: null, terminal: null, recoveryAuthority: false };
  const headerBytes = readBounded(headerFile, 64 * 1024, true);
  const header = JSON.parse(headerBytes);
  if (header.kind !== "RuntimeOutputSpool" || header.protocolVersion !== "0.1.0"
    || header.authorizationId !== authorization.authorizationId || header.authorizationHash !== authorization.authorizationHash
    || header.inputDigest !== authorization.executionInput.digest
    || header.limits.stdout !== limits.stdout || header.limits.stderr !== limits.stderr
    || header.authority !== "host-operational-evidence-only") fail("Spool authorization binding differs.");
  const outputs = {};
  const present = {};
  for (const name of ["stdout", "stderr"]) {
    const file = path.join(directory, `${name}.bin`);
    present[name] = fs.existsSync(file);
    outputs[name] = present[name] ? readBounded(file, limits[name]) : Buffer.alloc(0);
  }
  const file = path.join(directory, "terminal.json");
  if (!fs.existsSync(file)) return { status: "incomplete", header, outputs, terminal: null, recoveryAuthority: false };
  const terminal = JSON.parse(readBounded(file, limits.stdout * 2 + 1024 * 1024, true));
  const { terminalDigest, ...payload } = terminal;
  if (terminalDigest !== digest(Buffer.from(JSON.stringify(payload))) || terminal.headerDigest !== digest(headerBytes)
    || terminal.ownerExitRequired !== true || terminal.recoveryAuthority !== false) fail("Spool terminal is invalid.");
  for (const name of ["stdout", "stderr"]) {
    const stream = terminal.streams?.[name];
    if (!present[name] || !stream || stream.bytes !== outputs[name].length || stream.digest !== digest(outputs[name]) || typeof stream.truncated !== "boolean") fail("Spool bytes do not match terminal.");
  }
  return { status: "terminal-recorded", header, outputs, terminal, recoveryAuthority: false };
}

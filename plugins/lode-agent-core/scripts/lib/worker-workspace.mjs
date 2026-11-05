import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { captureWorkerSourceBasis, verifyWorkerSourceBasis, workerSourcePathParts } from "./worker-source-basis.mjs";
import { verifyWorkerWriteBasis, buildWorkerPatchCandidate } from "./worker-patch-basis.mjs";

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = (message, code = "WORKER_WORKSPACE_CONFLICT") => { throw Object.assign(new Error(message), { code }); };
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return !relative || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const key = value => process.platform === "win32" ? value.toLowerCase() : value;
const basisDigest = basis => hash(JSON.stringify(basis.map(({ path, digest, bytes }) => ({ path, digest, bytes }))));

export function verifyWorkerExecutionBoundary(boundary, sourceBasis, workspaceMode, writeBasis = null, maxBytes = 0, storage = undefined) {
  const hasWriteBasis = Object.hasOwn(boundary || {}, "writeBasisDigest");
  const fields = ["mode", "workspaceBindingDigest", "executionRootDigest", "sourceBasisDigest", "policyDigest", "ownedPaths", ...(hasWriteBasis ? ["writeBasisDigest"] : [])].sort();
  if (!boundary || JSON.stringify(Object.keys(boundary).sort()) !== JSON.stringify(fields)
    || boundary.mode !== "selected-snapshot" || !Array.isArray(boundary.ownedPaths)
    || boundary.ownedPaths.length > 256 || ["workspaceBindingDigest", "executionRootDigest", "sourceBasisDigest", "policyDigest"].some(field => !/^[a-f0-9]{64}$/.test(boundary[field]))) fail("Invalid worker execution boundary.");
  safePaths(boundary.ownedPaths, storage);
  if (JSON.stringify([...boundary.ownedPaths].sort()) !== JSON.stringify(boundary.ownedPaths)
    || boundary.sourceBasisDigest !== basisDigest(sourceBasis)
    || !hasWriteBasis && boundary.ownedPaths.some(relative => !sourceBasis.some(source => source.path === relative))
    || workspaceMode !== "workspace-write" && boundary.ownedPaths.length) fail("Worker ownership exceeds its selected basis or write mode.");
  if (hasWriteBasis) {
    verifyWorkerWriteBasis(writeBasis, maxBytes, storage);
    if (hash(JSON.stringify(writeBasis)) !== boundary.writeBasisDigest
      || JSON.stringify(writeBasis.map(entry => entry.path)) !== JSON.stringify(boundary.ownedPaths)) fail("Worker write preimages differ from the exact ownership binding.");
    for (const entry of writeBasis) {
      const source = sourceBasis.find(source => source.path === entry.path);
      if (entry.kind === "absent" ? source !== undefined
        : !source || source.digest !== entry.digest || source.bytes !== entry.bytes) fail("Selected read bytes and write preimage disagree.");
    }
  } else if (writeBasis !== null) fail("An older boundary cannot acquire write preimages.");
  return boundary;
}

// This freezes intended boundaries; it is not proof the provider enforces them.
export function workerExecutionBoundary({ binding, policy, sourceBasis, ownedPaths = [], writeBasis = null, storage }) {
  verifyWorkerWorkspace({ binding, sourceBasis, storage });
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) fail("Worker policy must be Host supplied.");
  const boundary = { mode: "selected-snapshot", workspaceBindingDigest: binding.bindingDigest,
    executionRootDigest: binding.executionRootDigest, sourceBasisDigest: binding.sourceBasisDigest,
    policyDigest: hash(JSON.stringify(policy)), ownedPaths: [...ownedPaths].sort(),
    ...(writeBasis !== null ? { writeBasisDigest: hash(JSON.stringify(writeBasis)) } : {}) };
  return verifyWorkerExecutionBoundary(boundary, sourceBasis, ownedPaths.length ? "workspace-write" : "read-only", writeBasis, binding.maxBytes, storage);
}

function safePaths(paths, storage) {
  const identities = new Set();
  for (const relative of paths) {
    const parts = workerSourcePathParts(relative, storage);
    // Device names and wildcard spellings are not distinct Windows files.
    if (process.platform === "win32" && parts.some(part => /[<>"|?*]/u.test(part)
      || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part))) fail("Workspace path has a Windows alias.");
    if (identities.has(key(relative))) fail("Workspace paths alias one another.");
    identities.add(key(relative));
  }
  for (const relative of identities) {
    const parts = relative.split("/");
    for (let i = 1; i < parts.length; i++) if (identities.has(parts.slice(0, i).join("/"))) fail("Workspace file conflicts with a parent directory.");
  }
}

function canonicalDirectory(directory) {
  const resolved = path.resolve(directory);
  let cursor = path.parse(resolved).root;
  for (const part of path.relative(cursor, resolved).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("Workspace directory traverses a link.");
  }
  return fs.realpathSync(resolved);
}

function verifyBinding(binding, storage) {
  const { bindingDigest, ...payload } = binding;
  if (hash(JSON.stringify(payload)) !== bindingDigest || binding.kind !== "WorkerWorkspaceBinding"
    || !["0.1.0", "0.2.0"].includes(binding.protocolVersion) || binding.sandboxEnforced !== false || binding.recoveryAuthority !== false
    || !Number.isSafeInteger(binding.maxBytes) || binding.maxBytes < 0
    || !Array.isArray(binding.sourcePaths)) fail("Invalid selected workspace binding.");
  safePaths(binding.sourcePaths, storage);
  const root = canonicalDirectory(binding.executionRoot);
  // Native file IDs can exceed Number's exact integer range (notably NTFS).
  // Preserve the existing exact-root check without rounding distinct roots.
  const stat = fs.statSync(root, { bigint: true });
  if (root !== binding.executionRoot || hash(root) !== binding.executionRootDigest
    || String(stat.dev) !== binding.rootDevice || String(stat.ino) !== binding.rootInode
    || inside(binding.canonicalRoot, root) || inside(root, binding.canonicalRoot)) fail("Selected workspace root changed or overlaps Canon.");
  return root;
}

function enumerate(root, expectedPaths, storage) {
  const paths = [];
  const expectedFiles = new Set(expectedPaths);
  const expectedDirectories = new Set();
  for (const relative of expectedPaths) {
    const parts = relative.split("/");
    for (let i = 1; i < parts.length; i++) expectedDirectories.add(parts.slice(0, i).join("/"));
  }
  function visit(directory, prefix = "") {
    // Inspect every entry, including unexpected hidden files. This is not the
    // repository scanner: a selected snapshot must not hide extra inputs.
    const entries = fs.opendirSync(directory);
    try { for (let entry; (entry = entries.readSync()) !== null;) {
      const relative = prefix + entry.name;
      workerSourcePathParts(relative, storage);
      if (entry.isSymbolicLink()) fail("Workspace contains a link.");
      if (entry.isDirectory()) {
        if (!expectedDirectories.has(relative)) fail("Workspace contains an unselected directory.");
        visit(path.join(directory, entry.name), `${relative}/`);
      } else if (entry.isFile()) {
        if (!expectedFiles.has(relative)) fail("Workspace contains an unselected file.");
        paths.push(relative);
      } else fail("Workspace contains a non-regular source.");
    } } finally { entries.closeSync(); }
  }
  visit(root);
  safePaths(paths, storage);
  return paths.sort();
}

// Host-only P5 preparation. This creates selected byte copies, NOT another HEAD
// Project and NOT a sandbox. A provider adapter must separately enforce policy.
// The returned roots/digests are for pre-execution binding, not user authority.
export function prepareWorkerWorkspace({ projectRoot, workspaceRoot, sourceBasis, maxBytes, storage }) {
  verifyWorkerSourceBasis(sourceBasis, maxBytes, storage);
  const sourcePaths = sourceBasis.map(item => item.path);
  safePaths(sourcePaths, storage);
  const canonicalRoot = fs.realpathSync(projectRoot);
  const requested = path.resolve(workspaceRoot);
  const parent = canonicalDirectory(path.dirname(requested));
  const executionRoot = path.join(parent, path.basename(requested));
  if (inside(canonicalRoot, executionRoot) || inside(executionRoot, canonicalRoot)) fail("Selected workspace must be separate from the canonical Project.");
  // Existing destinations are never adopted, cleaned, or overwritten. An
  // interrupted materialization remains incomplete and is not auto-replayed.
  fs.mkdirSync(executionRoot, { mode: 0o700 });
  for (const source of sourceBasis) {
    const parts = workerSourcePathParts(source.path, storage);
    let directory = executionRoot;
    for (const part of parts.slice(0, -1)) {
      directory = path.join(directory, part);
      try { fs.mkdirSync(directory, { mode: 0o700 }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail("Workspace parent changed during preparation.");
    }
    const fd = fs.openSync(path.join(directory, parts.at(-1)), "wx", 0o600);
    try { fs.writeFileSync(fd, Buffer.from(source.contentBase64, "base64")); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  }
  const stat = fs.statSync(executionRoot, { bigint: true });
  const payload = { kind: "WorkerWorkspaceBinding", protocolVersion: "0.2.0", canonicalRoot,
    executionRoot, executionRootDigest: hash(executionRoot), rootDevice: String(stat.dev), rootInode: String(stat.ino),
    sourceBasisDigest: basisDigest(sourceBasis), sourcePaths, maxBytes,
    physicalModes: sourcePaths.map(relative => ({ path: relative, mode: fs.statSync(path.join(executionRoot, relative)).mode & 0o777 })),
    sandboxEnforced: false, recoveryAuthority: false };
  const binding = { ...payload, bindingDigest: hash(JSON.stringify(payload)) };
  verifyWorkerWorkspace({ binding, sourceBasis, storage });
  return binding;
}

// Called by the trusted owner after its runner settles. Physical preparation
// permissions are not source semantics. Existing file modes remain the frozen
// preimage mode; a requested chmod requires an explicit separate patch proposal.
export function collectWorkerWorkspacePatch({ binding, sourceBasis, writeBasis, storage }) {
  verifyWorkerSourceBasis(sourceBasis, binding.maxBytes, storage);
  verifyWorkerWriteBasis(writeBasis, binding.maxBytes, storage);
  const root = verifyBinding(binding, storage);
  if (basisDigest(sourceBasis) !== binding.sourceBasisDigest || !Array.isArray(binding.physicalModes)
    || JSON.stringify(binding.physicalModes.map(entry => entry.path)) !== JSON.stringify(binding.sourcePaths)) fail("Workspace has no exact physical-mode preparation basis.");
  const owned = new Set(writeBasis.map(entry => entry.path));
  const expectedPaths = [...new Set([...binding.sourcePaths, ...owned])].sort();
  safePaths(expectedPaths, storage);
  const observedPaths = enumerate(root, expectedPaths, storage);
  const observations = new Map();
  const identities = new Map();
  const identity = relative => {
    const stat = fs.lstatSync(path.join(root, relative), { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) fail("Workspace file identity changed during collection.");
    return [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeNs, stat.ctimeNs].map(String).join(":");
  };
  let remaining = binding.maxBytes;
  for (const relative of observedPaths) {
    const before = identity(relative);
    const [source] = captureWorkerSourceBasis({ root, paths: [relative], maxBytes: remaining, storage });
    remaining -= source.bytes;
    const mode = fs.statSync(path.join(root, relative)).mode & 0o777;
    if (identity(relative) !== before) fail("Workspace file changed during collection.");
    identities.set(relative, before);
    const physical = binding.physicalModes.find(entry => entry.path === relative);
    if (physical && physical.mode !== mode) fail("Physical mode changed; provide an explicit source-mode patch rather than inferring it from Host permissions.", "WORKER_PATCH_MODE_PROPOSAL_REQUIRED");
    observations.set(relative, { ...source, mode });
  }
  for (const source of sourceBasis) {
    if (owned.has(source.path)) continue;
    const observed = observations.get(source.path);
    if (!observed || observed.digest !== source.digest || observed.bytes !== source.bytes) fail("Worker changed an unowned selected input.", "WORKER_PATCH_OUTSIDE_OWNERSHIP");
  }
  const changes = writeBasis.map(entry => {
    const observed = observations.get(entry.path);
    return { path: entry.path, after: observed ? { contentBase64: observed.contentBase64,
      mode: entry.kind === "file" ? entry.mode : observed.mode } : null };
  });
  const candidate = buildWorkerPatchCandidate({ basis: writeBasis, changes, maxBytes: binding.maxBytes, storage });
  // Observe a stable collection interval, not an atomic filesystem snapshot.
  // The producer must already be settled. Recheck previously captured bytes and
  // identities as well as additions/deletions; never retry provider execution.
  if (verifyBinding(binding, storage) !== root || JSON.stringify(enumerate(root, expectedPaths, storage)) !== JSON.stringify(observedPaths)) fail("Workspace namespace changed during collection.");
  for (const relative of observedPaths) {
    if (identity(relative) !== identities.get(relative)) fail("Workspace file identity changed during collection.");
    const [current] = captureWorkerSourceBasis({ root, paths: [relative], maxBytes: binding.maxBytes, storage });
    const observed = observations.get(relative);
    if (current.digest !== observed.digest || current.bytes !== observed.bytes
      || identity(relative) !== identities.get(relative)) fail("Workspace bytes changed during collection.");
  }
  if (verifyBinding(binding, storage) !== root || JSON.stringify(enumerate(root, expectedPaths, storage)) !== JSON.stringify(observedPaths)) fail("Workspace namespace changed during final validation.");
  for (const relative of observedPaths) if (identity(relative) !== identities.get(relative)) fail("Workspace file changed during final validation.");
  return candidate;
}

export function verifyWorkerWorkspace({ binding, sourceBasis, storage }) {
  verifyWorkerSourceBasis(sourceBasis, binding.maxBytes, storage);
  const root = verifyBinding(binding, storage);
  if (basisDigest(sourceBasis) !== binding.sourceBasisDigest
    || JSON.stringify(sourceBasis.map(item => item.path)) !== JSON.stringify(binding.sourcePaths)) fail("Workspace basis differs from its retained source selection.");
  const observedPaths = enumerate(root, binding.sourcePaths, storage);
  if (JSON.stringify(observedPaths) !== JSON.stringify(binding.sourcePaths)) fail("Workspace contains missing or extra sources.");
  const observed = captureWorkerSourceBasis({ root, paths: observedPaths, maxBytes: binding.maxBytes, storage });
  if (basisDigest(observed) !== binding.sourceBasisDigest) fail("Workspace source bytes changed.");
  return { executionRoot: root, bindingDigest: binding.bindingDigest, sourceBasisDigest: binding.sourceBasisDigest,
    sandboxEnforced: false, recoveryAuthority: false };
}

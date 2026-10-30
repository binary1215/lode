import { withSnapshotReferencesAsync } from "./snapshot-reference-lifetime.mjs";
import { ensureOwnedSnapshotStoreIgnore } from "./project-storage-ignore.mjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { formatForVerifiedOwner } from "./project-storage-format.mjs";
import { assertProjectStorageUnchanged } from "./project-storage-format.mjs";
import { safeSnapshotPath, decodeSnapshotBytes, SNAPSHOT_STORAGE_LIMITS } from "./snapshot-storage-codec.mjs";
import { atomicCreateArtifact } from "./artifact-storage.mjs";
import { withProjectMutationAsync } from "./project-mutation-lock.mjs";
import { createSnapshotBatchDecoder } from "./git-snapshot-batch.mjs";

// Git uses NUL on Windows and /dev/null elsewhere.
const gitNull = process.platform === "win32" ? "NUL" : "/dev/null";
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const fail = (code, message = code) => { throw Object.assign(new Error(message), { code }); };
const ID = /^(world-model|graph-snapshot)-[a-f0-9]{24}$/;
const OID = /^[a-f0-9]{64}$/;
const MAX = SNAPSHOT_STORAGE_LIMITS.decodedBytes;
const localProcesses = new Map();
export function snapshotGitProcessStatus() { return [...localProcesses.values()].map(value => ({ ...value })); }

// Every invocation is an owned, bounded, shell-free local Git child. No filters,
// hooks, lazy fetch, inherited Git configuration or user repository are used.
async function command(store, args, { input = null, maxBytes = MAX, deadline, signal, consume = null } = {}) {
  if (signal?.aborted) fail("SNAPSHOT_GIT_CANCELLED");
  const remaining = deadline - Date.now();
  if (remaining <= 0) fail("SNAPSHOT_GIT_TIMEOUT");
  const environment = {};
  for (const name of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "COMSPEC", "PATHEXT"]) if (process.env[name]) environment[name] = process.env[name];
  Object.assign(environment, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: gitNull, GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" });
  const argv = ["--no-pager", "--no-replace-objects", ...(args[0] === "init" ? [] : ["--git-dir=" + store.directory]),
    "-c", "core.hooksPath=" + gitNull, "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "protocol.allow=never", ...args];
  return new Promise((resolve, reject) => {
    const startedAt = new Date().toISOString();
    try { store.onProcess?.({ event: "planned", parentPid: process.pid, command: store.gitCommand, args: argv, cwd: store.root, ports: [], startedAt }); } catch { /* optional observer */ }
    if (signal?.aborted) { reject(Object.assign(new Error("Snapshot Git operation cancelled before launch."), { code: "SNAPSHOT_GIT_CANCELLED" })); return; }
    const child = spawn(store.gitCommand, argv, { cwd: store.root, env: environment, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const evidence = { pid: child.pid || null, parentPid: process.pid, command: store.gitCommand, args: argv, cwd: store.root, ports: [], startedAt };
    if (child.pid) localProcesses.set(child.pid, evidence);
    let failure = null, size = 0, stderrBytes = 0; const chunks = [], errors = [];
    let escalation;
    const stop = code => { if (!failure) failure = Object.assign(new Error(code), { code }); child.kill("SIGTERM"); escalation ??= setTimeout(() => child.kill("SIGKILL"), 250); };
    const timer = setTimeout(() => stop("SNAPSHOT_GIT_TIMEOUT"), remaining);
    const cancelled = () => stop("SNAPSHOT_GIT_CANCELLED"); signal?.addEventListener("abort", cancelled, { once: true });
    child.stdout.on("data", bytes => {
      size += bytes.length; if (failure) return;
      if (consume) { try { consume(bytes); } catch (error) { failure = error; stop(error.code || "SNAPSHOT_GIT_BATCH_INVALID"); return; } }
      if (size > maxBytes) stop("SNAPSHOT_GIT_OUTPUT_LIMIT"); else if (!consume) chunks.push(bytes);
    });
    child.stderr.on("data", bytes => { stderrBytes += bytes.length; if (stderrBytes <= 8192) errors.push(bytes); });
    child.on("error", error => { failure ??= error.code === "ENOENT" ? Object.assign(new Error("The selected local Git executable is unavailable."), { code: "SNAPSHOT_GIT_EXECUTABLE_UNAVAILABLE", cause: error }) : error; });
    child.stdin.on("error", error => { if (error.code !== "EPIPE") failure ??= error; });
    child.once("close", (code, processSignal) => {
      clearTimeout(timer); clearTimeout(escalation); signal?.removeEventListener("abort", cancelled);
      if (child.pid) localProcesses.delete(child.pid);
      try { store.onProcess?.({ event: "closed", ...evidence, exitCode: code, signal: processSignal, outputBytes: size, failureCode: failure?.code || null }); } catch { /* child already reaped */ }
      if (failure) reject(failure); else resolve({ code, stdout: Buffer.concat(chunks), stderr: Buffer.concat(errors).toString("utf8") });
    });
    if (signal?.aborted) cancelled();
    try { store.onProcess?.({ event: "started", ...evidence }); } catch { /* observation must not orphan the owned child */ }
    child.stdin.end(input);
  });
}

export class GitSnapshotStore {
  constructor({ projectRoot, storage, gitCommand = "git", timeoutMs = 30000, signal = null, onProcess = null } = {}) {
    if (!storage?.projectId || !storage.projectFile) fail("SNAPSHOT_GIT_OWNER_REQUIRED");
    this.root = fs.realpathSync(projectRoot); this.storage = storage; this.gitCommand = gitCommand; this.signal = signal; this.onProcess = onProcess;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) fail("INVALID_SNAPSHOT_GIT_DEADLINE");
    this.timeoutMs = timeoutMs;
    this.directory = safeSnapshotPath(this.root, path.join(this.root, formatForVerifiedOwner(storage).directory, "snapshot-objects.git"));
    this.owner = { schemaVersion: 1, kind: "LocalDerivedSnapshotStore", projectId: storage.projectId, rootDigest: hash(this.root), dialect: formatForVerifiedOwner(storage).dialect, objectFormat: "sha256", authority: "derived-evidence-only" };
    this.storeId = "snapshot-store-" + hash(JSON.stringify(this.owner)).slice(0, 24);
  }
  context() { assertProjectStorageUnchanged(this.storage); return { deadline: Date.now() + this.timeoutMs, signal: this.signal }; }
  checkOwner(deadline = Infinity) {
    if (Date.now() >= deadline) fail("SNAPSHOT_GIT_TIMEOUT");
    assertProjectStorageUnchanged(this.storage); safeSnapshotPath(this.root, this.directory);
    if (!fs.existsSync(this.directory)) return false;
    const ownerFile = safeSnapshotPath(this.root, path.join(this.directory, "lode-owner.json"));
    const stat = fs.lstatSync(ownerFile); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) fail("SNAPSHOT_GIT_OWNER_MISMATCH");
    let actual; try { actual = JSON.parse(fs.readFileSync(ownerFile, "utf8")); } catch (error) { if (error.code) throw error; fail("SNAPSHOT_GIT_OWNER_MISMATCH"); }
    if (JSON.stringify(actual) !== JSON.stringify(this.owner)) fail("SNAPSHOT_GIT_OWNER_MISMATCH");
    const configFile = safeSnapshotPath(this.root, path.join(this.directory, "config"));
    const configStat = fs.lstatSync(configFile);
    if (!configStat.isFile() || configStat.nlink !== 1 || configStat.size > 16384) fail("SNAPSHOT_GIT_CONFIG_REJECTED");
    let section = "";
    for (const raw of fs.readFileSync(configFile, "utf8").split(/\r?\n/)) {
      const line = raw.trim(); if (!line || line.startsWith("#") || line.startsWith(";")) continue;
      const header = /^\[([a-z]+)\]$/i.exec(line);
      if (header) { section = header[1].toLowerCase(); if (!["core", "extensions"].includes(section)) fail("SNAPSHOT_GIT_CONFIG_REJECTED"); continue; }
      const entry = /^([a-z]+)\s*=\s*([a-z0-9]+)$/i.exec(line);
      const allowed = section === "core" ? { repositoryformatversion: ["1"], bare: ["true"], filemode: ["true", "false"], symlinks: ["true", "false"], ignorecase: ["true", "false"], precomposeunicode: ["true", "false"], logallrefupdates: ["false"], hidedotfiles: ["dotgitonly"] } : { objectformat: ["sha256"] };
      if (!entry || !allowed[entry[1].toLowerCase()]?.includes(entry[2].toLowerCase())) fail("SNAPSHOT_GIT_CONFIG_REJECTED");
    }
    for (const relative of ["objects/info/alternates", "objects/info/http-alternates", "shallow"]) if (fs.existsSync(safeSnapshotPath(this.root, path.join(this.directory, relative)))) fail("SNAPSHOT_GIT_EXTERNAL_OBJECTS_REJECTED");
    // Reject links in the private object/ref namespaces before Git opens them.
    let visited = 0;
    const inspect = directory => { if (!fs.existsSync(directory)) return; for (const entry of fs.readdirSync(directory)) { if (Date.now() >= deadline) fail("SNAPSHOT_GIT_TIMEOUT"); if (++visited > 200000) fail("SNAPSHOT_GIT_INVENTORY_LIMIT"); const file = safeSnapshotPath(this.root, path.join(directory, entry)); let stat; try { stat=fs.lstatSync(file); } catch(error) { const relative=path.relative(this.directory,file).replaceAll("\\","/"); if(error.code==="ENOENT"&&/^(?:objects\/(?:[a-f0-9]{2}\/[a-f0-9]{62}|pack\/pack-[a-f0-9]{64}\.(?:pack|idx))|refs\/lode-snapshots\/(?:world-model|graph-snapshot)-[a-f0-9]{24}(?:\.lock)?)$/.test(relative))continue;throw error; } if (stat.isDirectory()) inspect(file); else if (!stat.isFile() || stat.nlink !== 1) fail("UNSAFE_SNAPSHOT_PATH"); } };
    inspect(path.join(this.directory, "objects")); inspect(path.join(this.directory, "refs"));
    for (const name of ["config", "HEAD", "packed-refs"]) safeSnapshotPath(this.root, path.join(this.directory, name));
    return true;
  }
  async invoke(args, context, options = {}) { const result = await command(this, args, { ...context, ...options }); if (result.code !== 0) { const error=Object.assign(new Error("Private snapshot Git command failed: "+args[0]),{code:"SNAPSHOT_GIT_COMMAND_FAILED",gitStderr:result.stderr,gitAction:args[0]});throw error; } return result.stdout; }
  async ensure(context) {
    return withProjectMutationAsync({ root: this.root, storage: this.storage, scope: "snapshot-store-init" }, async () => {
      if (this.checkOwner(context.deadline)) return;
      const staging = this.directory + "." + crypto.randomUUID() + ".staging";
      safeSnapshotPath(this.root, staging);
      try {
        await this.invoke(["init", "--bare", "--object-format=sha256", "--template=", staging], context, { maxBytes: 8192 });
        this.ignorePolicy = ensureOwnedSnapshotStoreIgnore({ root: this.root, storage: this.storage, directory: staging });
        atomicCreateArtifact(path.join(staging, "lode-owner.json"), JSON.stringify(this.owner) + "\n");
        fs.renameSync(staging, this.directory);
      } finally { if (fs.existsSync(staging)) { safeSnapshotPath(this.root, staging); fs.rmSync(staging, { recursive: true }); } }
      this.checkOwner(context.deadline);
    });
  }
  ref(id) { if (!ID.test(id || "")) fail("INVALID_SNAPSHOT_GIT_ID"); return "refs/lode-snapshots/" + id; }
  async resolve(id, context) {
    const result = await command(this, ["show-ref", "--verify", "--hash", this.ref(id)], { ...context, maxBytes: 8192 });
    if (result.code === 1 || result.code === 128 && !result.stdout.length && /not a valid ref/.test(result.stderr)) return null;
    if (result.code !== 0) fail("SNAPSHOT_GIT_REF_FAILED");
    const oid = result.stdout.toString("ascii").trim(); if (!OID.test(oid)) fail("SNAPSHOT_GIT_OBJECT_ID_INVALID"); return oid;
  }
  async object(oid, type, maximum, context) {
    return (await this.#objects([{ oid, type, maximum }], context, maximum))[0];
  }
  async #objects(requests, context, maximum) {
    const decoder = createSnapshotBatchDecoder(requests);
    await this.invoke(["cat-file", "--batch"], context, { input: requests.map(item => item.oid).join("\n") + "\n",
      maxBytes: maximum + 256 * requests.length, consume: decoder.push });
    return decoder.finish();
  }
  async read(id, context = this.context()) {
    this.ref(id); if (!this.checkOwner(context.deadline)) return null;
    const treeOid = await this.resolve(id, context); if (!treeOid) return null;
    const packBasis=()=>{const directory=path.join(this.directory,"objects","pack");return fs.existsSync(directory)?fs.readdirSync(directory).sort().map(name=>{
      try {const s=fs.lstatSync(path.join(directory,name),{bigint:true});return name+":"+s.ino+":"+s.size+":"+s.ctimeNs;}
      catch(error){if(error.code==="ENOENT"&&/^pack-[a-f0-9]{64}\.(?:pack|idx)$/.test(name))return name+":missing";throw error;}
    }).join("|"):"";};
    const before=packBasis();
    try { return await this.readExactTree(id,treeOid,context); }
    catch(error) {
      // Read-only, bounded reacquisition of the original chosen address. Never
      // select current again, retry effects, or hide permission/digest failure.
      const text=error.gitStderr||"";
      if(error.code!=="SNAPSHOT_GIT_COMMAND_FAILED"||context.signal?.aborted||Date.now()>=context.deadline||/permission|access is denied|not permitted|corrupt|mismatch/i.test(text)||(!error.gitMissingObject&&!/could not get object info|could not read|cannot be accessed|no such file|not a valid object name/i.test(text))||before===packBasis())throw error;
      this.checkOwner(context.deadline);
      try {return await this.readExactTree(id,treeOid,context);}catch(next){next.initialReadFailure={code:error.code,action:error.gitAction};throw next;}
    }
  }
  async readExactTree(id,treeOid,context) {
    await this.object(treeOid, "tree", 4096, context);
    const listing = (await this.invoke(["ls-tree", treeOid], context, { maxBytes: 4096 })).toString("utf8").trim().split("\n");
    const entries = listing.map(line => /^(100644) blob ([a-f0-9]{64})\t(metadata.json|snapshot.json)$/.exec(line));
    if (entries.length !== 2 || entries.some(entry => !entry) || new Set(entries.map(entry => entry[3])).size !== 2) fail("SNAPSHOT_GIT_TREE_INVALID");
    const byName = Object.fromEntries(entries.map(entry => [entry[3], entry[2]]));
    let metadata;
    const objects = await this.#objects([
      { oid: byName["metadata.json"], type: "blob", maximum: 4096, onObject: raw => {
        metadata = decodeSnapshotBytes(raw, { decodedBytes: 4096 });
        if (metadata.schemaVersion !== 1 || metadata.storeId !== this.storeId || metadata.projectId !== this.storage.projectId || metadata.snapshotId !== id || metadata.encoding !== "utf8-json" || metadata.objectFormat !== "sha256" || metadata.objectId !== byName["snapshot.json"] || !/^[a-f0-9]{64}$/.test(metadata.rawSha256 || "") || !Number.isSafeInteger(metadata.byteLength) || metadata.byteLength < 1 || metadata.byteLength > MAX) fail("SNAPSHOT_GIT_METADATA_MISMATCH");
      } },
      { oid: byName["snapshot.json"], type: "blob", maximum: () => metadata.byteLength },
    ], context, 4096 + MAX);
    const bytes = objects[1];
    if (bytes.length !== metadata.byteLength || hash(bytes) !== metadata.rawSha256) fail("SNAPSHOT_GIT_RAW_DIGEST_MISMATCH");
    const document = decodeSnapshotBytes(bytes);
    if (document.projectId !== this.storage.projectId || (document.worldModelId || document.graphSnapshotId) !== id) fail("SNAPSHOT_GIT_IDENTITY_MISMATCH");
    this.checkOwner(context.deadline);
    return { location: null, document, snapshotStorage: { kind: "local-git-object", storeId: this.storeId, objectFormat: "sha256", treeObjectId: treeOid, objectId: metadata.objectId, encoding: metadata.encoding, byteLength: metadata.byteLength, rawSha256: metadata.rawSha256 } };
  }
  async write(id, document) {
    return withSnapshotReferencesAsync({root:this.root,storage:this.storage},()=>this.writeUnderLifetime(id,document));
  }
  async writeUnderLifetime(id, document) {
    const context = this.context(); this.ref(id);
    if (document.projectId !== this.storage.projectId || (document.worldModelId || document.graphSnapshotId) !== id) fail("SNAPSHOT_GIT_IDENTITY_MISMATCH");
    const bytes = Buffer.from(JSON.stringify(document) + "\n"); if (bytes.length > MAX) fail("SNAPSHOT_STORAGE_LIMIT");
    await this.ensure(context);
    const existing = await this.read(id, context);
    if (existing) { if (hash(Buffer.from(JSON.stringify(existing.document) + "\n")) !== hash(bytes)) fail("SNAPSHOT_GIT_IMMUTABLE_CONFLICT"); return { ...existing, created: false }; }
    const objectId = (await this.invoke(["hash-object", "-w", "--stdin"], context, { input: bytes, maxBytes: 128 })).toString("ascii").trim();
    if (!OID.test(objectId)) fail("SNAPSHOT_GIT_OBJECT_ID_INVALID");
    const metadata = { schemaVersion: 1, projectId: this.storage.projectId, storeId: this.storeId, snapshotId: id, objectFormat: "sha256", objectId, encoding: "utf8-json", byteLength: bytes.length, rawSha256: hash(bytes) };
    const metadataOid = (await this.invoke(["hash-object", "-w", "--stdin"], context, { input: JSON.stringify(metadata) + "\n", maxBytes: 128 })).toString("ascii").trim();
    if (!OID.test(metadataOid)) fail("SNAPSHOT_GIT_OBJECT_ID_INVALID");
    const tree = (await this.invoke(["mktree"], context, { input: "100644 blob " + metadataOid + "\tmetadata.json\n100644 blob " + objectId + "\tsnapshot.json\n", maxBytes: 128 })).toString("ascii").trim();
    if (!OID.test(tree)) fail("SNAPSHOT_GIT_OBJECT_ID_INVALID");
    const update = await command(this, ["update-ref", this.ref(id), tree, "0".repeat(64)], { ...context, maxBytes: 8192 });
    if (update.code !== 0) { const winner = await this.read(id, context); if (winner && winner.snapshotStorage.rawSha256 === metadata.rawSha256) return { ...winner, created: false }; fail("SNAPSHOT_GIT_IMMUTABLE_CONFLICT"); }
    return { ...await this.read(id, context), created: true };
  }
  async list(prefix) {
    const context = this.context(); if (!this.checkOwner(context.deadline)) return [];
    if (!["world-model", "graph-snapshot"].includes(prefix)) fail("INVALID_SNAPSHOT_GIT_ID");
    const bytes = await this.invoke(["for-each-ref", "--format=%(refname)", "refs/lode-snapshots/" + prefix + "-*"], context, { maxBytes: 16 * 1024 * 1024 });
    return bytes.toString("ascii").trim().split("\n").filter(Boolean).map(ref => ref.slice("refs/lode-snapshots/".length)).filter(id => ID.test(id) && id.startsWith(prefix + "-")).sort();
  }
}

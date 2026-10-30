import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { safeGraphFile } from "./discovery-index.mjs";
import { DEFAULT_SCAN, MAX_REFERENCE_BYTES } from "./session-work-evidence-original.mjs";
import { relativeProjectArtifact } from "./project-storage-format.mjs";
import { readSourceObservation } from "./source-observation.mjs";
import { resolveLocalGitRepository, LOCAL_GIT_DISCOVERY_ARGS, localGitReadEnvironment } from "./local-git-repository.mjs";

const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
// Preserve a valid BOM too: sha(UTF-8 text) must still identify the raw bytes.
const decode = bytes => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);

function pointerDeclaration(bytes, text) {
  if (bytes.length >= 1024 || !text.endsWith("\n") || text.includes("\r")) return null;
  const lines = text.slice(0, -1).split("\n"), entries = lines.map(line => /^([a-z0-9.-]+) ([^\r\n]+)$/.exec(line));
  if (entries.some(entry => !entry) || entries[0]?.[1] !== "version" || !["https://git-lfs.github.com/spec/v1", "https://hawser.github.com/spec/v1"].includes(entries[0][2])) return null;
  const keys = entries.slice(1).map(entry => entry[1]);
  if (new Set(entries.map(entry => entry[1])).size !== entries.length || keys.some((key, i) => i && keys[i - 1] >= key)) return null;
  const values = Object.fromEntries(entries.map(entry => [entry[1], entry[2]]));
  if (!/^sha256:[a-f0-9]{64}$/.test(values.oid || "") || !/^(?:0|[1-9][0-9]*)$/.test(values.size || "")) return null;
  return { algorithm: "sha256", oid: values.oid.slice(7), byteLength: Number.isSafeInteger(Number(values.size)) ? Number(values.size) : null,
    declaredByteLength: values.size, pointerVersion: values.version,
    extensionKeys: keys.filter(key => !["oid", "size"].includes(key)) };
}

function sourceVersion(bytes, projectId, relative, basis) {
  const digest = sha(bytes); let text;
  try { text = decode(bytes); if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) text = undefined; } catch { /* Opaque bytes remain bytes, not an empty text diff. */ }
  const declaration = text === undefined ? null : pointerDeclaration(bytes, text);
  const asset = declaration || text === undefined ? { kind: declaration ? "git-lfs-pointer" : "opaque-file", rawDigest: digest, rawByteLength: bytes.length,
    rawDigestVerified: true, ...(declaration ? { declaration, tracking: "not-inspected" } : {}), remote: { status: "not-checked", verified: false },
    payloadComparison: "not-performed; pointer bytes do not prove payload availability or behavior" } : null;
  return { projectId, path: relative, digest, ...(text !== undefined ? { text } : {}), ...(asset ? { asset } : {}), basis };
}

function currentBytes(root, relative, maximum = MAX_REFERENCE_BYTES) {
  const file = safeGraphFile(root, relative), fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw Object.assign(new Error("Not a regular source file"), { code: "SOURCE_NOT_REGULAR" });
    if (stat.size > maximum) throw Object.assign(new Error("Source byte bound"), { code: "SOURCE_BYTE_BOUND" });
    const bytes = Buffer.alloc(Math.min(stat.size + 1, maximum + 1)); let count = 0;
    while (count < bytes.length) { const n = fs.readSync(fd, bytes, count, bytes.length - count, count); if (!n) break; count += n; }
    // A growing source is unavailable, never an exact truncated version.
    if (count > stat.size || count > maximum || fs.fstatSync(fd).size !== count) throw Object.assign(new Error("Source changed while reading"), { code: "SOURCE_READ_DRIFT" });
    return bytes.subarray(0, count);
  } finally { fs.closeSync(fd); }
}

function git(root, args, maximum = MAX_REFERENCE_BYTES) {
  return new Promise(resolve => {
    const chunks = [], diagnostics = []; let total = 0, diagnosticBytes = 0, reasonCode = null, child;
    const env = localGitReadEnvironment();
    try { child = spawn("git", ["--no-optional-locks", "--literal-pathspecs", ...args], { cwd: root, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env }); }
    catch { resolve({ bytes: null, reasonCode: "LOCAL_GIT_UNAVAILABLE" }); return; }
    const timer = setTimeout(() => { reasonCode ||= "LOCAL_GIT_READ_TIMEOUT"; child.kill(); }, 1500);
    child.stdout.on("data", chunk => { total += chunk.length; if (total > maximum) { reasonCode ||= "LOCAL_GIT_OUTPUT_BYTE_BOUND"; child.kill(); } else chunks.push(chunk); });
    child.stderr.on("data", chunk => { diagnosticBytes += chunk.length; if (diagnosticBytes <= 4096) diagnostics.push(chunk); });
    child.on("error", () => { reasonCode ||= "LOCAL_GIT_UNAVAILABLE"; });
    child.once("close", code => {
      clearTimeout(timer);
      // Only a bounded, complete, C-locale discovery diagnostic classifies
      // ordinary non-Git folders. Permission/corrupt .git/other errors remain
      // command failures; stderr itself is never exposed as source evidence.
      const diagnostic = diagnosticBytes <= 4096 ? Buffer.concat(diagnostics).toString("utf8") : "";
      const notRepository = args[0] === "rev-parse" && code === 128 && /^(?:fatal: not a git repository \(or any of the parent directories\): \.git\r?\n?|fatal: not a git repository \(or any parent up to mount point [^\r\n]+\)\r?\nStopping at filesystem boundary \(GIT_DISCOVERY_ACROSS_FILESYSTEM not set\)\.\r?\n?)$/u.test(diagnostic);
      resolve(reasonCode || code !== 0 ? { bytes: null, reasonCode: reasonCode || (notRepository ? "LOCAL_GIT_NOT_A_REPOSITORY" : "LOCAL_GIT_COMMAND_FAILED") }
        : { bytes: Buffer.concat(chunks), reasonCode: null });
    });
  });
}

// Per-request only. Git is an optional byte supplier, never a work/Run oracle.
export function createContextSourceReader(root, projectId, { storage = null, bundleHints = [] } = {}) {
  const retained = new Map(), histories = new Map(); let prefix, gitCalls = 0, lastCommandReason = null, prefixReason = null, repository, repositoryLookup, objectFormat, metadataFailureCause = null;
  const bundles = new Map(); let bundleKeys, inventoryReason = null, inventoryPartial = false, inspectedEntries = 0, bundleBytes = 0;
  function bundleVersion(key, relative, expectedDigest, maxBytes = MAX_REFERENCE_BYTES, countBudget = false) {
    const file = safeGraphFile(root, `${relativeProjectArtifact(storage, "observations", "source-bundles")}/${key}.json`);
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink()) throw Object.assign(new Error("Not a regular bundle"), { code: "SOURCE_NOT_REGULAR_FILE" });
    if (before.size > MAX_REFERENCE_BYTES || countBudget && bundleBytes + before.size > MAX_REFERENCE_BYTES) throw Object.assign(new Error("Source bundle byte budget"), { code: "RETAINED_SOURCE_BUNDLE_BYTE_BUDGET_REACHED" });
    if (countBudget) bundleBytes += before.size;
    const bundle = readSourceObservation(root, projectId, key, { requireCurrent: false, storage });
    const after = fs.lstatSync(file);
    if (countBudget) bundleBytes += Math.max(0, after.size - before.size);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.isSymbolicLink()) {
      throw Object.assign(new Error("Bundle changed during lookup"), { code: "SOURCE_DRIFT" });
    }
    const source = bundle.evidence.sources[0];
    bundles.set(key, { source: { path: source.path, digest: source.digest } });
    if (source.path !== relative || source.digest !== expectedDigest) return null;
    const bytes = Buffer.from(source.base64, "base64");
    if (bytes.length > maxBytes) throw Object.assign(new Error("Source byte bound"), { code: "SOURCE_BYTE_BOUND" });
    return sourceVersion(bytes, projectId, relative, {
      kind: "retained-source-observation", bundleKey: key, observationId: bundle.observation.observationId,
      observationHash: bundle.observation.observationHash, commitAttribution: "byte-location-only-not-Run-or-decision-cause" });
  }
  function retainedBundleVersion(relative, expectedDigest) {
    const errors = []; let omittedErrors = 0, inspected = 0, byteBound = false;
    const note = (key, reasonCode) => { if (errors.length < 8) errors.push({ bundleKey: key, reasonCode }); else omittedErrors++; };
    const hints = [...new Set(bundleHints.filter(key => typeof key === "string" && /^[a-f0-9]{64}$/.test(key)))];
    // Recorded addresses are read before opening an unrelated directory inventory.
    for (const key of hints.slice(0, DEFAULT_SCAN)) {
      const known = bundles.get(key);
      if (known?.source && (known.source.path !== relative || known.source.digest !== expectedDigest)) continue;
      if (known?.reasonCode) continue;
      try { const version = bundleVersion(key, relative, expectedDigest, MAX_REFERENCE_BYTES, true); if (version) return { version }; }
      catch (error) {
        if (error.code === "RETAINED_SOURCE_BUNDLE_BYTE_BUDGET_REACHED") { byteBound = true; break; }
        bundles.set(key, { reasonCode: error.code || "RETAINED_SOURCE_BUNDLE_UNAVAILABLE" });
      }
    }
    if (!bundleKeys) {
      bundleKeys = hints.slice(0, DEFAULT_SCAN); inventoryPartial = hints.length > DEFAULT_SCAN;
      let directory;
      try {
        directory = fs.opendirSync(safeGraphFile(root, relativeProjectArtifact(storage, "observations", "source-bundles")));
        let entry;
        while (inspectedEntries < DEFAULT_SCAN && (entry = directory.readSync())) {
          inspectedEntries++;
          if (/^[a-f0-9]{64}\.json$/.test(entry.name) && !bundleKeys.includes(entry.name.slice(0, -5))) {
            if (bundleKeys.length === DEFAULT_SCAN) { inventoryPartial = true; break; }
            bundleKeys.push(entry.name.slice(0, -5));
          }
        }
        inventoryPartial ||= inspectedEntries === DEFAULT_SCAN && directory.readSync() !== null;
      } catch (error) { inventoryReason = error.code || "RETAINED_SOURCE_BUNDLE_DIRECTORY_UNAVAILABLE"; }
      finally { directory?.closeSync(); }
    }
    for (const key of bundleKeys) {
      // Keep only small lookup facts for nonmatching bundles. A later exact
      // requested version is reread through the verifier, not a body cache.
      const known = bundles.get(key);
      if (known?.source && known.source.path === relative && known.source.digest === expectedDigest) bundles.delete(key);
      if (!bundles.has(key)) {
        try {
          const version = bundleVersion(key, relative, expectedDigest, MAX_REFERENCE_BYTES, true);
          if (version) return { version };
        } catch (error) {
          if (error.code === "RETAINED_SOURCE_BUNDLE_BYTE_BUDGET_REACHED") { byteBound = true; break; }
          bundles.set(key, { reasonCode: error.code || "RETAINED_SOURCE_BUNDLE_UNAVAILABLE" });
        }
      }
      inspected++;
      const entry = bundles.get(key);
      if (entry.reasonCode) { note(key, entry.reasonCode); continue; }
    }
    return { lookup: { reasonCode: byteBound ? "RETAINED_SOURCE_BUNDLE_BYTE_BUDGET_REACHED"
      : inventoryPartial ? "RETAINED_SOURCE_BUNDLE_LOOKUP_BUDGET_REACHED"
        : inventoryReason || (errors.length ? "RETAINED_SOURCE_BUNDLE_LOOKUP_INCOMPLETE" : "EXACT_RETAINED_SOURCE_BUNDLE_NOT_FOUND"),
      inspectedBundleCount: inspected, inspectedDirectoryEntries: inspectedEntries, maxDirectoryEntries: DEFAULT_SCAN,
      maxBundleBytes: MAX_REFERENCE_BYTES, preflightBundleBytes: bundleBytes,
      preflightByteBudget: MAX_REFERENCE_BYTES, byteBudgetKind: "file-size-preflight-not-atomic-read-limit",
      inventoryPartial, absenceEstablished: false, errors, omittedErrorCount: omittedErrors } };
  }
  const command = async (args, maximum = MAX_REFERENCE_BYTES) => {
    if (gitCalls >= 24) { lastCommandReason = "LOCAL_GIT_READ_BUDGET_REACHED"; return null; }
    try { repository?.assertCurrent(); }
    catch (error) { lastCommandReason = error.code || "LOCAL_GIT_MAPPING_DRIFT"; return null; }
    gitCalls++; const result = await git(root, args, maximum); lastCommandReason = result.reasonCode;
    try { repository?.assertCurrent(); }
    catch (error) { lastCommandReason = error.code || "LOCAL_GIT_MAPPING_DRIFT"; return null; }
    return result.bytes;
  };
  const repositoryForRead = () => repositoryLookup ||= (async () => {
    try {
      const resolved = resolveLocalGitRepository(root, { allowParent: true });
      if (resolved.status !== "available") { prefixReason = resolved.reasonCode; prefix = null; return null; }
      repository = resolved;
      const bytes = await command(LOCAL_GIT_DISCOVERY_ARGS, 32 * 1024);
      if (!bytes) { prefixReason = lastCommandReason; prefix = null; repository = null; return null; }
      objectFormat = repository.matchesDiscovery(bytes); prefix = repository.prefix;
      return repository;
    } catch (error) { metadataFailureCause = error.code || null; prefixReason = error.code === "ENOENT" ? "LOCAL_GIT_METADATA_UNAVAILABLE" : error.code || "LOCAL_GIT_METADATA_UNAVAILABLE"; prefix = null; repository = null; return null; }
  })();
  async function describeAsset(version, current = null) {
    if (!version.asset) return version;
    const resolved = await repositoryForRead(), asset = version.asset;
    if (resolved && asset.rawDigestVerified && version.text !== undefined) asset.gitBlob = { oid: crypto.createHash(objectFormat).update(`blob ${asset.rawByteLength}\0`).update(Buffer.from(version.text)).digest("hex"),
      objectFormat, scope: "computed-for-pointer-bytes; object-presence-not-checked" };
    // Binary bodies are deliberately not retained to manufacture an OID from
    // an empty string. Only a complete pointer text can supply the raw bytes.
    if (version.text === undefined) delete asset.gitBlob;
    if (asset.declaration) {
      const declared = asset.declaration;
      asset.localPayload = { status: "unknown", scope: "current-default-local-lfs-cache-only; custom-storage-not-inspected", verified: false };
      if (!resolved) asset.localPayload.reasonCode = prefixReason;
      else try {
        resolved.assertCurrent();
        const file = safeGraphFile(resolved.commonDir, `lfs/objects/${declared.oid.slice(0, 2)}/${declared.oid.slice(2, 4)}/${declared.oid}`);
        const stat = fs.lstatSync(file, { throwIfNoEntry: false });
        asset.localPayload = { ...asset.localPayload, status: !stat ? "absent-at-default-path" : !stat.isFile() || stat.isSymbolicLink() ? "unavailable" : declared.byteLength !== null && stat.size !== declared.byteLength ? "size-mismatch" : "present-unverified",
          ...(stat?.isFile() ? { observedBytes: stat.size } : {}) };
        resolved.assertCurrent();
      } catch (error) { asset.localPayload.reasonCode = error.code || "LOCAL_LFS_PAYLOAD_UNAVAILABLE"; asset.localPayload.status = "unavailable"; }
      if (current?.asset?.rawDigestVerified && current.asset.kind === "opaque-file") asset.currentWorkingPayload = {
        status: declared.byteLength === null ? "declared-size-not-exactly-representable" : current.digest === declared.oid && current.asset.rawByteLength === declared.byteLength ? "verified-exact-current-bytes" : "digest-or-size-mismatch",
        digest: current.digest, byteLength: current.asset.rawByteLength, scope: "requested-working-file-only; not-historical-cache-or-remote-proof" };
    }
    return version;
  }
  return {
    async read(relative, expectedDigest = null, { maxBytes = MAX_REFERENCE_BYTES, bundleKey = null } = {}) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_REFERENCE_BYTES) return { status: "unavailable", path: relative, reasonCode: "SOURCE_BYTE_BOUND" };
      const cacheKey = JSON.stringify(bundleKey !== null ? [relative, expectedDigest, maxBytes, bundleKey]
        : maxBytes === MAX_REFERENCE_BYTES ? [relative, expectedDigest] : [relative, expectedDigest, maxBytes]);
      if (retained.has(cacheKey)) return retained.get(cacheKey);
      if (bundleKey !== null) {
        try {
          if (/^(?:\.git|\.head|\.lode)(?:\/|$)/i.test(relative)) throw Object.assign(new Error("Not repository source"), { code: "SOURCE_PATH_NOT_CODE" });
          safeGraphFile(root, relative);
          if (typeof bundleKey !== "string" || !/^[a-f0-9]{64}$/.test(bundleKey)) throw Object.assign(new Error("Invalid bundle key"), { code: "SOURCE_BUNDLE_KEY_INVALID" });
          if (!/^[a-f0-9]{64}$/.test(expectedDigest || "")) throw Object.assign(new Error("Exact source digest required"), { code: "EXACT_SOURCE_DIGEST_REQUIRED" });
          const version = bundleVersion(bundleKey, relative, expectedDigest, maxBytes);
          if (!version) throw Object.assign(new Error("Bundle source differs from the exact reference"), { code: "SOURCE_BUNDLE_REFERENCE_MISMATCH" });
          await describeAsset(version); retained.set(cacheKey, version); return version;
        } catch (error) { return { status: "unavailable", path: relative, expectedDigest, bundleKey, reasonCode: error.code || "RETAINED_SOURCE_BUNDLE_UNAVAILABLE" }; }
      }
      let current = null, currentReason = null;
      try {
        if (/^(?:\.git|\.head|\.lode)(?:\/|$)/i.test(relative)) throw Object.assign(new Error("Not repository source"), { code: "SOURCE_PATH_NOT_CODE" });
        safeGraphFile(root, relative);
        const bytes = currentBytes(root, relative, maxBytes), digest = sha(bytes);
        current = sourceVersion(bytes, projectId, relative, { kind: "current-disk-bytes", commitAttribution: "not-determined" });
        if (!expectedDigest || digest === expectedDigest) { await describeAsset(current); retained.set(cacheKey, current); return current; }
      } catch (error) {
        currentReason = error.code || "SOURCE_UNAVAILABLE";
        if (currentReason === "SOURCE_BYTE_BOUND") {
          try {
            const stat = fs.lstatSync(safeGraphFile(root, relative));
            if (stat.isFile() && !stat.isSymbolicLink()) current = { projectId, path: relative, digest: null,
              basis: { kind: "current-file-metadata-only", commitAttribution: "not-determined" },
              asset: { kind: "opaque-or-large-file", rawByteLength: stat.size, rawDigestVerified: false,
                reasonCode: "SOURCE_BYTE_BOUND", remote: { status: "not-checked", verified: false }, payloadComparison: "not-performed" } };
            if (!expectedDigest && current) { retained.set(cacheKey, current); return current; }
          } catch { /* Preserve the primary read failure, never bypass access. */ }
        }
      }
      // A rejected path/encoding is not permission to obtain it via Git.
      if (currentReason && !["ENOENT", "SOURCE_READ_DRIFT", "SOURCE_BYTE_BOUND"].includes(currentReason)) return { status: "unavailable", path: relative, expectedDigest, reasonCode: currentReason };
      if (!expectedDigest || !/^[a-f0-9]{64}$/.test(expectedDigest)) return { status: "unavailable", path: relative, reasonCode: currentReason || "EXACT_SOURCE_DIGEST_REQUIRED" };
      try { safeGraphFile(root, relative); } catch (error) { return { status: "unavailable", path: relative, reasonCode: error.code }; }
      const historical = retainedBundleVersion(relative, expectedDigest);
      if (historical.version) {
        if ((historical.version.asset?.rawByteLength ?? Buffer.byteLength(historical.version.text)) > maxBytes) return { status: "unavailable", path: relative, expectedDigest, reasonCode: "SOURCE_BYTE_BOUND" };
        await describeAsset(historical.version, current); retained.set(cacheKey, historical.version); return historical.version;
      }
      const unavailable = reasonCode => ({ status: "unavailable", path: relative, expectedDigest, reasonCode, retainedSourceLookup: historical.lookup });
      if (prefix === undefined) await repositoryForRead();
      if (prefix === null) return unavailable(prefixReason || "HISTORICAL_BYTES_NOT_AVAILABLE_LOCALLY");
      if (!histories.has(relative)) {
        const history = await command(["log", "-n", "16", "--no-show-signature", "--no-patch", "--no-decorate", "--no-notes", "--format=%H", "--", relative]);
        histories.set(relative, { commits: history ? decode(history).trim().split(/\s+/).filter(id => /^[a-f0-9]{40,64}$/.test(id)) : [], reasonCode: lastCommandReason });
      }
      let historyReason = histories.get(relative).reasonCode;
      for (const commit of histories.get(relative).commits) {
        const bytes = await command(["cat-file", "blob", `${commit}:${prefix}${relative}`], maxBytes);
        if (!bytes) historyReason = lastCommandReason;
        if (!bytes || sha(bytes) !== expectedDigest) continue;
        const version = sourceVersion(bytes, projectId, relative, { kind: "local-git-exact-blob", commit,
          commitAttribution: "byte-location-only-not-Run-or-decision-cause" });
        await describeAsset(version, current);
        retained.set(cacheKey, version); return version;
      }
      return unavailable(historyReason || "EXACT_HISTORICAL_BYTES_NOT_RETAINED_IN_BOUNDED_HISTORY");
    },
    async renameCandidates(relative, expectedDigest) {
      // Optional, after exact-source reads: never spend their budget first.
      // R100 is Git's exact-byte move observation, not canonical identity.
      const version = retained.get(JSON.stringify([relative, expectedDigest]));
      const commit = histories.get(relative)?.commits[0];
      if (version?.basis.kind !== "local-git-exact-blob" || !commit) return { candidates: [], status: "exact-cited-source-required" };
      const bytes = await command(["diff-tree", "--root", "--no-commit-id", "--name-status", "-z", "-r", "-M100%", "--no-ext-diff", "--no-textconv", commit]);
      if (!bytes) return { candidates: [], status: "bounded-local-rename-evidence-unavailable", reasonCode: lastCommandReason };
      const candidates = [];
      try {
        const fields = decode(bytes).split("\0");
        for (let i = 0; i < fields.length && fields[i];) {
          const status = fields[i++], from = fields[i++], to = /^R\d+$/.test(status) ? fields[i++] : null;
          if (status !== "R100" || from !== `${prefix}${relative}` || !to?.startsWith(prefix)) continue;
          const candidatePath = to.slice(prefix.length);
          if (/^(?:\.git|\.head|\.lode)(?:\/|$)/i.test(candidatePath)) continue;
          safeGraphFile(root, candidatePath);
          const original = await command(["cat-file", "blob", `${commit}:${to}`]);
          if (!original || sha(original) !== expectedDigest) continue;
          candidates.push({ path: candidatePath, commit, digest: expectedDigest, evidence: "local-git-R100-and-exact-cited-digest",
            interpretation: "Historical rename candidate only; current path, logical identity and cause are not established." });
        }
      } catch { return { candidates: [], status: "local-rename-evidence-unavailable" }; }
      return { candidates, status: gitCalls >= 24 ? "partial-local-git-budget" : "observed-most-recent-path-change-only", renameEstablished: false };
    },
    diagnostics() { return { localGitCommands: gitCalls, maxLocalGitCommands: 24, maxPathHistoryCommits: 16, maxSourceBytes: MAX_REFERENCE_BYTES,
      ...(metadataFailureCause ? { gitMetadataFailureCause: metadataFailureCause } : {}),
      retainedSourceBundles: { inspected: bundles.size, inspectedDirectoryEntries: inspectedEntries, inventoryPartial, preflightBytes: bundleBytes,
        maxDirectoryEntries: DEFAULT_SCAN, maxBundleBytes: MAX_REFERENCE_BYTES, preflightByteBudget: MAX_REFERENCE_BYTES,
        byteBudgetKind: "file-size-preflight-not-atomic-read-limit" },
      writes: false, sourceScope: "requested-files-only", interpretation: "No ancestry, rename, Run ownership or rationale inferred from a commit." }; },
  };
}

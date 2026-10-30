import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  buildComputeRequest,
  completeComputeResult,
  DEFAULT_COMPUTE_LIMITS,
  executeComputeOperation,
  JsReferenceComputeAdapter,
  normalizeComputeLimits,
  validateComputeRequest,
  validateComputeResponse,
} from "./compute-adapter.mjs";
import {
  classifySourcePath,
  analyzeSourceFile,
  languageForSource,
  SOURCE_ANALYSIS_VERSION,
} from "./source-analysis.mjs";
import { GoWorkerComputeAdapter } from "./go-worker-adapter.mjs";
import { familyFormatForOriginal, formatForVerifiedOwner } from "./project-storage-format.mjs";
import {
  buildRepositorySourceScope,
  pathWithinRepositorySourceScope,
  verifyRepositorySourceScope,
} from "./repository-source-scope.mjs";

export const REPOSITORY_SCAN_VERSION = "0.5.1";
export const REPOSITORY_SCAN_OPERATION = "repository.scan.v1";
export const REPOSITORY_SCAN_SEMANTIC_PRODUCER = Object.freeze({
  name: "head-agent-core-repository-scan",
  version: REPOSITORY_SCAN_VERSION,
});
export const REPOSITORY_SCAN_DEFAULTS = Object.freeze({
  maxFiles: DEFAULT_COMPUTE_LIMITS.maxFiles,
  maxFileBytes: DEFAULT_COMPUTE_LIMITS.maxFileBytes,
  maxTotalBytes: DEFAULT_COMPUTE_LIMITS.maxTotalBytes,
  maxSymbolsPerFile: 200,
});

export const REPOSITORY_SCAN_EXCLUDED_DIRECTORIES = Object.freeze([
  ".agent-work", ".cache", ".git", ".head", ".hg", ".mypy_cache", ".next", ".nox", ".nuxt",
  ".pytest_cache", ".ruff_cache", ".svn", ".tox", ".uv-cache", ".uv-python", ".venv",
  "__pycache__", "build", "coverage", "dist", "node_modules", "out", "target",
  "vendor", "venv",
].sort());
const EXCLUDED_DIRECTORIES = new Set(REPOSITORY_SCAN_EXCLUDED_DIRECTORIES);
const TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".html", ".java",
  ".js", ".jsx", ".json", ".kt", ".kts", ".md", ".mjs", ".mts", ".php", ".ps1",
  ".py", ".rb", ".rs", ".sh", ".sql", ".svelte", ".toml", ".ts", ".tsx", ".txt",
  ".vue", ".xml", ".yaml", ".yml",
]);
const CLASSIFICATIONS = new Set(["configuration", "documentation", "source", "test"]);
const SOURCE_LANGUAGES = new Set([
  "c", "cc", "cpp", "csharp", "css", "dockerfile", "go", "h", "hpp", "html",
  "java", "javascript", "json", "kotlin", "markdown", "php", "powershell", "python",
  "ruby", "rust", "shell", "sql", "svelte", "toml", "txt", "typescript",
  "vue", "xml", "yaml",
]);
const SYMBOL_KINDS = new Set(["binding", "class", "function", "heading"]);
const DEPENDENCY_KINDS = new Set(["dependencies", "devDependencies", "module", "optionalDependencies", "peerDependencies"]);
const LEGACY_SKIPPED_FIELDS = Object.freeze(["excludedDirectory", "managedProjection", "unsupportedType", "tooLarge", "symlink"]);
const SKIPPED_FIELDS = Object.freeze([...LEGACY_SKIPPED_FIELDS, "outsideSourceScope"]);

const fail = (message, code = "REPOSITORY_SCAN_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertFields(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`, "INVALID_REPOSITORY_SCAN_SCHEMA");
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) fail(`${label} contains unsupported fields: ${unexpected.sort().join(", ")}`, "INVALID_REPOSITORY_SCAN_SCHEMA");
}

function relativePath(value, label) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) fail(`${label} is not a normalized relative path.`, "INVALID_REPOSITORY_SCAN_PATH");
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === "." || normalized === ".." || normalized.startsWith("../")) fail(`${label} escapes the project root.`, "INVALID_REPOSITORY_SCAN_PATH");
  return value;
}

function normalizeManagedRootFiles(values) {
  if (!Array.isArray(values)) fail("managedRootFiles must be an array.", "INVALID_REPOSITORY_SCAN_INPUT");
  const normalized = values.map((value, index) => relativePath(value, `managedRootFiles[${index}]`));
  if (new Set(normalized).size !== normalized.length) fail("managedRootFiles contains duplicates.", "INVALID_REPOSITORY_SCAN_INPUT");
  return normalized.sort(compareText);
}

export function managedRootFilesForProject(project, storage = project?.storage) {
  const values = [];
  if (formatForVerifiedOwner(storage).dialect === "lode") values.push(".lode");
  if (project?.integrations?.codex?.status === "managed") values.push("AGENTS.md");
  if (project?.integrations?.opencode?.status === "managed") values.push("opencode.json");
  return values.sort(compareText);
}

export function buildRepositoryScanInput({ projectRoot, managedRootFiles = [], storage, sourceScope = buildRepositorySourceScope({ storage }) } = {}) {
  if (typeof projectRoot !== "string" || !projectRoot.trim() || projectRoot.includes("\0")) fail("projectRoot is required.", "INVALID_REPOSITORY_SCAN_INPUT");
  return {
    schemaVersion: 1,
    kind: "RepositoryScanInput",
    projectRoot: path.resolve(projectRoot),
    managedRootFiles: normalizeManagedRootFiles(managedRootFiles),
    sourceScope: verifyRepositorySourceScope(sourceScope, { storage }),
  };
}

export function validateRepositoryScanInput(input) {
  assertFields(input, ["schemaVersion", "kind", "projectRoot", "managedRootFiles", "sourceScope"], "Repository scan input");
  const rebuilt = buildRepositoryScanInput(input);
  if (canonicalJson(rebuilt) !== canonicalJson(input)) fail("Repository scan input is not canonical.", "INVALID_REPOSITORY_SCAN_INPUT");
  return input;
}

function normalizePath(root, file) {
  return path.relative(root, file).replaceAll("\\", "/");
}

function scanFormat(input) {
  return familyFormatForOriginal("head-agent-core-repository-source-scope", input.sourceScope);
}

function semanticProducerFor(storage) {
  return { name: formatForVerifiedOwner(storage).protocol("head-agent-core-repository-scan"), version: REPOSITORY_SCAN_VERSION };
}

function excludesManagedRootDirectory(relative, input) {
  if (scanFormat(input)?.dialect !== "lode" || !input.managedRootFiles.includes(".lode")) return false;
  if (relative === ".lode") return true;
  // A Windows directory can retain another spelling while the verified root
  // token resolves to it. Case folding only identifies a possible alias: it
  // never proves ownership on a case-sensitive Windows directory.
  if (process.platform !== "win32" || relative.toLowerCase() !== ".lode") return false;
  const candidate = fs.lstatSync(path.join(input.projectRoot, relative), { bigint: true });
  let selected;
  try { selected = fs.lstatSync(path.join(input.projectRoot, ".lode"), { bigint: true }); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  return candidate.isDirectory() && selected.isDirectory()
    && candidate.ino !== 0n && selected.ino !== 0n && candidate.dev !== 0n && selected.dev !== 0n
    && candidate.ino === selected.ino && candidate.dev === selected.dev;
}

function sameObservedFile(previous, metadata) {
  return previous && ["digest", "bytes", "classification", "language"].every(field => previous[field] === metadata[field]);
}

function sourceFileRecord(metadata, raw, base, previous = null) {
  return { ...metadata, freshness: "active",
    ...(previous ? { symbols: previous.symbols, dependencies: previous.dependencies, semanticFacts: previous.semanticFacts }
      : analyzeSourceFile(raw.toString("utf8"), metadata.language, base, { maxSymbols: REPOSITORY_SCAN_DEFAULTS.maxSymbolsPerFile })),
  };
}

function scanResultPayload(input, files, skipped, totalBytes) {
  return {
    schemaVersion: 1, kind: "RepositoryScanResult", protocol: semanticProducerFor(scanFormat(input)),
    sourceAnalysisVersion: SOURCE_ANALYSIS_VERSION, authority: "derived-evidence-only", instructionAuthority: false,
    promotionAuthority: false, sourceScope: input.sourceScope, files, skipped,
    summary: { fileCount: files.length, totalBytes,
      symbolCount: files.reduce((n, file) => n + file.symbols.length, 0),
      dependencyCount: files.reduce((n, file) => n + file.dependencies.length, 0),
      bindingCount: files.reduce((n, file) => n + file.semanticFacts.bindings.length, 0),
      callCount: files.reduce((n, file) => n + file.semanticFacts.calls.length, 0) },
  };
}

function scanPayload(input, limits, { previousResult = null, reuseDiagnostics = null } = {}) {
  validateRepositoryScanInput(input);
  const normalizedLimits = normalizeComputeLimits(limits);
  const root = input.projectRoot;
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail("Repository scan root is not a directory.", "REPOSITORY_SCAN_ROOT_INVALID");
  // The only reuse caller validates its persisted snapshot before entering here.
  const previousFiles = new Map((previousResult?.files || []).map((file) => [file.path, file]));
  const previousAnalysisReusable = previousResult?.protocol?.version === REPOSITORY_SCAN_VERSION
    && previousResult?.sourceAnalysisVersion === SOURCE_ANALYSIS_VERSION;
  const managed = new Set(input.managedRootFiles);
  const files = [];
  const skipped = Object.fromEntries(SKIPPED_FIELDS.map((field) => [field, 0]));
  let totalBytes = 0;
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = normalizePath(root, absolute);
      if (entry.isSymbolicLink()) { skipped.symlink += 1; continue; }
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase()) || excludesManagedRootDirectory(relative, input)) skipped.excludedDirectory += 1;
        else if (!pathWithinRepositorySourceScope(relative, input.sourceScope, { directory: true })) skipped.outsideSourceScope += 1;
        else stack.push(absolute);
        continue;
      }
      if (!entry.isFile()) { skipped.unsupportedType += 1; continue; }
      if (!pathWithinRepositorySourceScope(relative, input.sourceScope)) { skipped.outsideSourceScope += 1; continue; }
      if (managed.has(relative)) { skipped.managedProjection += 1; continue; }
      const base = entry.name;
      const extension = path.extname(base).toLowerCase();
      if (!TEXT_EXTENSIONS.has(extension) && base !== "Dockerfile") { skipped.unsupportedType += 1; continue; }
      const stat = fs.statSync(absolute);
      if (stat.size > normalizedLimits.maxFileBytes) { skipped.tooLarge += 1; continue; }
      const raw = fs.readFileSync(absolute);
      if (raw.length > normalizedLimits.maxFileBytes) { skipped.tooLarge += 1; continue; }
      if (files.length >= normalizedLimits.maxFiles) fail(`Repository scan exceeds ${normalizedLimits.maxFiles} files.`, "REPOSITORY_SCAN_FILE_LIMIT");
      if (totalBytes + raw.length > normalizedLimits.maxTotalBytes) fail(`Repository scan exceeds ${normalizedLimits.maxTotalBytes} total bytes.`, "REPOSITORY_SCAN_TOTAL_BYTES_LIMIT");
      const language = languageForSource(extension, base);
      const classification = classifySourcePath(relative, extension);
      const contentDigest = digest(raw);
      const previous = previousFiles.get(relative);
      const metadata = { path: relative, digest: contentDigest, bytes: raw.length, classification, language };
      const reusable = previousAnalysisReusable && sameObservedFile(previous, metadata);
      files.push(sourceFileRecord(metadata, raw, base, reusable ? previous : null));
      if (reuseDiagnostics) (reusable ? reuseDiagnostics.reusedPaths : reuseDiagnostics.analyzedPaths).push(relative);
      totalBytes += raw.length;
    }
  }
  files.sort((left, right) => compareText(left.path, right.path));
  if (reuseDiagnostics) {
    const currentPaths = new Set(files.map((file) => file.path));
    reuseDiagnostics.reusedPaths.sort(compareText);
    reuseDiagnostics.analyzedPaths.sort(compareText);
    reuseDiagnostics.removedPaths.push(...[...previousFiles.keys()].filter((file) => !currentPaths.has(file)).sort(compareText));
  }
  return scanResultPayload(input, files, skipped, totalBytes);
}

function withIdentity(payload) {
  const scanHash = digest(canonicalJson(payload));
  return { ...payload, scanId: `repository-scan-${scanHash.slice(0, 24)}`, scanHash };
}

export function scanRepositoryReference(input, { limits = DEFAULT_COMPUTE_LIMITS } = {}) {
  const result = withIdentity(scanPayload(input, limits));
  return validateRepositoryScanResult(result);
}

function inspectFreshness({ projectRoot, managedRootFiles = [], storage, sourceScope = buildRepositorySourceScope({ storage }), storedFiles = [], limits = {} } = {}, consume = null) {
  const input = buildRepositoryScanInput({ projectRoot, managedRootFiles, sourceScope, storage });
  const normalizedLimits = normalizeComputeLimits(limits);
  if (!Array.isArray(storedFiles)) fail("storedFiles must be an array.", "INVALID_REPOSITORY_SCAN_INPUT");
  const managed = new Set(input.managedRootFiles);
  const files = [];
  const skipped = Object.fromEntries(SKIPPED_FIELDS.map(field => [field, 0]));
  let totalBytes = 0;
  const stack = [input.projectRoot];
  while (stack.length) {
    const directory = stack.pop();
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = normalizePath(input.projectRoot, absolute);
      if (entry.isSymbolicLink()) { skipped.symlink += 1; continue; }
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase()) || excludesManagedRootDirectory(relative, input)) skipped.excludedDirectory += 1;
        else if (!pathWithinRepositorySourceScope(relative, input.sourceScope, { directory: true })) skipped.outsideSourceScope += 1;
        else stack.push(absolute);
        continue;
      }
      if (!entry.isFile()) { skipped.unsupportedType += 1; continue; }
      if (!pathWithinRepositorySourceScope(relative, input.sourceScope)) { skipped.outsideSourceScope += 1; continue; }
      if (managed.has(relative)) { skipped.managedProjection += 1; continue; }
      const extension = path.extname(entry.name).toLowerCase();
      if (!TEXT_EXTENSIONS.has(extension) && entry.name !== "Dockerfile") { skipped.unsupportedType += 1; continue; }
      const stat = fs.statSync(absolute);
      if (stat.size > normalizedLimits.maxFileBytes) { skipped.tooLarge += 1; continue; }
      const raw = fs.readFileSync(absolute);
      if (raw.length > normalizedLimits.maxFileBytes) { skipped.tooLarge += 1; continue; }
      if (files.length >= normalizedLimits.maxFiles) fail(`Repository scan exceeds ${normalizedLimits.maxFiles} files.`, "REPOSITORY_SCAN_FILE_LIMIT");
      if (totalBytes + raw.length > normalizedLimits.maxTotalBytes) fail(`Repository scan exceeds ${normalizedLimits.maxTotalBytes} total bytes.`, "REPOSITORY_SCAN_TOTAL_BYTES_LIMIT");
      files.push({
        path: relative,
        digest: digest(raw),
        bytes: raw.length,
        classification: classifySourcePath(relative, extension),
        language: languageForSource(extension, entry.name),
      });
      consume?.file(files.at(-1), raw, entry.name);
      totalBytes += raw.length;
    }
  }
  files.sort((left, right) => compareText(left.path, right.path));
  const before = new Map(storedFiles.map((file) => [file.path, file]));
  const after = new Map(files.map((file) => [file.path, file]));
  const added = [...after.keys()].filter((file) => !before.has(file)).sort(compareText);
  const removed = [...before.keys()].filter((file) => !after.has(file)).sort(compareText);
  const changed = [...after.keys()].filter((file) => {
    const previous = before.get(file);
    const current = after.get(file);
    return previous && ["digest", "bytes", "classification", "language"].some((field) => previous[field] !== current[field]);
  }).sort(compareText);
  const freshness = {
    status: added.length || changed.length || removed.length ? "changed" : "unchanged",
    sourceScope: input.sourceScope,
    files,
    changes: { added, changed, removed },
  };
  return consume ? consume.finish(freshness, { input, limits: normalizedLimits, skipped, totalBytes }) : freshness;
}

export function inspectRepositoryScanFreshness(options = {}) {
  return inspectFreshness(options);
}

// Private World consumer: the observation and its exact bytes never escape a
// synchronous call. Public freshness remains metadata-only and does no analysis.
export function inspectRepositoryScanForWorld(options, previousResult, { sourceScopeChanged = false } = {}) {
  const reusableProducer = previousResult.protocol.version === REPOSITORY_SCAN_VERSION
    && previousResult.sourceAnalysisVersion === SOURCE_ANALYSIS_VERSION;
  if (!reusableProducer) {
    // A producer transition cannot reuse old analysis. Keep ordinary freshness
    // cheap rather than retaining all source buffers for a possible rebuild.
    const freshness = inspectFreshness({ ...options, storedFiles: previousResult.files });
    const scan = freshness.status === "unchanged" && !sourceScopeChanged ? { files: previousResult.files }
      : scanRepositoryReference(buildRepositoryScanInput(options), { limits: options.limits });
    return { freshness, scan };
  }
  const previousFiles = new Map(previousResult.files.map(file => [file.path, file]));
  const observed = [];
  return inspectFreshness({ ...options, storedFiles: previousResult.files }, {
    file(metadata, raw, base) {
      const previous = previousFiles.get(metadata.path);
      const reusable = reusableProducer && sameObservedFile(previous, metadata);
      // Consume changed bytes synchronously from this exact observation. Keeping
      // every changed raw buffer until the full walk ends can retain the entire
      // repository in addition to its analysis. Unchanged files do no new work.
      observed.push(reusable ? { metadata, reusable: true }
        : { metadata, record: sourceFileRecord(metadata, raw, base) });
    },
    finish(freshness, { input, skipped, totalBytes }) {
      if (freshness.status === "unchanged" && !sourceScopeChanged) return { freshness, scan: { files: previousResult.files } };
      // This is a persisted/untrusted reuse boundary, not an identity flag.
      const ownedPrevious = validateRepositoryScanResult(canonical(previousResult));
      const ownedFiles = new Map(ownedPrevious.files.map(file => [file.path, file]));
      if (observed.some(({ metadata, reusable }) => reusable && !sameObservedFile(ownedFiles.get(metadata.path), metadata))) {
        // Mutable input changed its exact basis during observation. It cannot
        // donate analysis; recompute through the existing safe reference path.
        return { freshness, scan: scanRepositoryReference(input, { limits: options.limits }) };
      }
      const files = observed.map(({ metadata, reusable, record }) => reusable
        ? sourceFileRecord(metadata, null, null, ownedFiles.get(metadata.path)) : record)
        .sort((a, b) => compareText(a.path, b.path));
      const scan = validateRepositoryScanResult(withIdentity(scanResultPayload(input, files, skipped, totalBytes)));
      return { freshness, scan };
    },
  });
}

function resultFromWorldModelSnapshot(snapshot) {
  return {
    schemaVersion: 1,
    kind: "RepositoryScanResult",
    ...snapshot.repositoryScan,
    files: snapshot.files,
    skipped: snapshot.skipped,
  };
}

function changesBetweenScans(previous, current) {
  const before = new Map(previous.files.map((file) => [file.path, file.digest]));
  const after = new Map(current.files.map((file) => [file.path, file.digest]));
  return {
    added: [...after.keys()].filter((file) => !before.has(file)).sort(compareText),
    changed: [...after.keys()].filter((file) => before.has(file) && before.get(file) !== after.get(file)).sort(compareText),
    removed: [...before.keys()].filter((file) => !after.has(file)).sort(compareText),
  };
}

export function repositoryScanResultFromWorldModel(snapshot) {
  if (!snapshot?.repositoryScan || !Array.isArray(snapshot.files) || !snapshot.skipped) {
    fail("World Model snapshot does not contain a repository scan.", "REPOSITORY_SCAN_SNAPSHOT_MISSING");
  }
  // Normalize once at the untrusted mutable input boundary. Internal scanning
  // owns this copy rather than relying on validation of a caller's live object.
  return validateRepositoryScanResult(canonical(resultFromWorldModelSnapshot(snapshot)));
}

export function validateRepositoryScanExecution(execution, { projectRoot, managedRootFiles = [], storage, sourceScope = buildRepositorySourceScope({ storage }) } = {}) {
  if (!execution || typeof execution !== "object" || Array.isArray(execution)) fail("Repository scan execution is required.", "INVALID_REPOSITORY_SCAN_EXECUTION");
  const expectedInput = buildRepositoryScanInput({ projectRoot, managedRootFiles, sourceScope, storage });
  validateComputeRequest(execution.request);
  validateComputeResponse(execution.request, execution.response);
  if (execution.request.operation !== REPOSITORY_SCAN_OPERATION
    || canonicalJson(execution.request.semanticProducer) !== canonicalJson(semanticProducerFor(scanFormat(expectedInput)))
    || canonicalJson(execution.request.input) !== canonicalJson(expectedInput)
    || execution.response.status !== "ok"
    || canonicalJson(execution.response.result) !== canonicalJson(execution.result)) {
    fail("Repository scan execution does not match the requested project scan.", "INVALID_REPOSITORY_SCAN_EXECUTION");
  }
  validateRepositoryScanResult(execution.result);
  return execution;
}

export async function executeIncrementalRepositoryScan({ projectRoot, managedRootFiles = [], storage, sourceScope = buildRepositorySourceScope({ storage }), previousSnapshot, limits = {} } = {}) {
  const previousResult = repositoryScanResultFromWorldModel(previousSnapshot);
  const input = buildRepositoryScanInput({ projectRoot, managedRootFiles, sourceScope, storage });
  let request = buildComputeRequest({
    operation: REPOSITORY_SCAN_OPERATION,
    input,
    semanticProducer: semanticProducerFor(scanFormat(input)),
    storage,
    limits,
  });
  const reuse = { reusedPaths: [], analyzedPaths: [], removedPaths: [] };
  const result = withIdentity(scanPayload(input, request.limits, {
    previousResult,
    reuseDiagnostics: reuse,
  }));
  const completed = completeComputeResult(request, result, { limits });
  request = completed.request;
  const response = completed.response;
  // A local constructor supplies this exact frozen result; external execution
  // validation remains mandatory at validateRepositoryScanExecution's boundary.
  validateRepositoryScanResult(response.result);
  const changes = changesBetweenScans(previousResult, result);
  return {
    request,
    response,
    result: response.result,
    diagnostics: {
      backend: "javascript-reference",
      adapterName: "repository-scan-incremental-reference",
      executionMode: "in-process-incremental-reuse",
      fallbackUsed: false,
      fallbackReasonCode: "",
      workerRelativePath: "",
      workerSha256: "",
      ...completed.diagnostics,
      reusedFileCount: reuse.reusedPaths.length,
      analyzedFileCount: reuse.analyzedPaths.length,
      removedFileCount: reuse.removedPaths.length,
      reusedPaths: reuse.reusedPaths,
      analyzedPaths: reuse.analyzedPaths,
      removedPaths: reuse.removedPaths,
      changes,
    },
  };
}

function assertOrderedUnique(values, identity, label) {
  const identities = values.map(identity);
  if (new Set(identities).size !== identities.length || canonicalJson([...identities].sort(compareText)) !== canonicalJson(identities)) fail(`${label} is not sorted and unique.`, "INVALID_REPOSITORY_SCAN_RESULT");
}

function assertOrdered(values, comparator, label) {
  for (let index = 1; index < values.length; index += 1) {
    if (comparator(values[index - 1], values[index]) > 0) fail(`${label} is not canonically ordered.`, "INVALID_REPOSITORY_SCAN_RESULT");
  }
}

function validateLineRecord(record, fields, label) {
  assertFields(record, fields, label);
  if (!Number.isInteger(record.line) || record.line < 1) fail(`${label}.line is invalid.`, "INVALID_REPOSITORY_SCAN_RESULT");
}

export function validateRepositoryScanResult(result) {
  const format = familyFormatForOriginal("head-agent-core-repository-scan", result);
  // 0.5.0 has the same declaration schema; only scan eligibility changed.
  const currentProtocol = [REPOSITORY_SCAN_VERSION, "0.5.0"].includes(result?.protocol?.version);
  const scopedProtocol = currentProtocol || new Set(["0.3.0", "0.4.0"]).has(result?.protocol?.version);
  const legacyProtocol = new Set(["0.2.0", "0.3.0", "0.4.0"]).has(result?.protocol?.version);
  assertFields(result, ["schemaVersion", "kind", "protocol", "sourceAnalysisVersion", "authority", "instructionAuthority", "promotionAuthority", ...(scopedProtocol ? ["sourceScope"] : []), "files", "skipped", "summary", "scanId", "scanHash"], "Repository scan result");
  if (result.schemaVersion !== 1 || result.kind !== "RepositoryScanResult"
    || !format || (!currentProtocol && !legacyProtocol)
    || (currentProtocol ? !["0.3.0", SOURCE_ANALYSIS_VERSION].includes(result.sourceAnalysisVersion) : !["0.1.0", "0.2.0"].includes(result.sourceAnalysisVersion))
    || result.authority !== "derived-evidence-only"
    || result.instructionAuthority !== false || result.promotionAuthority !== false || !Array.isArray(result.files)) {
    fail("Repository scan result contract is invalid.", "INVALID_REPOSITORY_SCAN_RESULT");
  }
  if (scopedProtocol) verifyRepositorySourceScope(result.sourceScope, { storage: format });
  assertOrderedUnique(result.files, (file) => file.path, "Repository scan files");
  for (const [index, file] of result.files.entries()) {
    const label = `files[${index}]`;
    assertFields(file, ["path", "digest", "freshness", "bytes", "classification", "language", "symbols", "dependencies", "semanticFacts"], label);
    relativePath(file.path, `${label}.path`);
    if (!/^[a-f0-9]{64}$/.test(file.digest) || file.freshness !== "active" || !Number.isInteger(file.bytes) || file.bytes < 0
      || !CLASSIFICATIONS.has(file.classification) || !SOURCE_LANGUAGES.has(file.language)) fail(`${label} metadata is invalid.`, "INVALID_REPOSITORY_SCAN_RESULT");
    if (!Array.isArray(file.symbols) || !Array.isArray(file.dependencies)) fail(`${label} analysis arrays are invalid.`, "INVALID_REPOSITORY_SCAN_RESULT");
    for (const [symbolIndex, symbol] of file.symbols.entries()) {
      validateLineRecord(symbol, currentProtocol
        ? ["name", "kind", "line", "endLine", "scopePath", "qualifiedName", "signature", "identityAmbiguous"]
        : ["name", "kind", "line"], `${label}.symbols[${symbolIndex}]`);
      if (typeof symbol.name !== "string" || !symbol.name || !SYMBOL_KINDS.has(symbol.kind)
        || (currentProtocol && (!Number.isInteger(symbol.endLine) || symbol.endLine < symbol.line
          || typeof symbol.scopePath !== "string" || typeof symbol.qualifiedName !== "string" || !symbol.qualifiedName
          || typeof symbol.signature !== "string" || !symbol.signature || typeof symbol.identityAmbiguous !== "boolean"))) {
        fail(`${label} symbol is invalid.`, "INVALID_REPOSITORY_SCAN_RESULT");
      }
    }
    assertOrdered(file.symbols, (left, right) => left.line - right.line || compareText(left.name, right.name), `${label}.symbols`);
    const declarationsByLocation = new Map();
    for (const symbol of file.symbols) {
      const key = `${symbol.line}|${symbol.kind}|${symbol.name}`;
      if (!declarationsByLocation.has(key)) declarationsByLocation.set(key, []);
      declarationsByLocation.get(key).push(symbol);
    }
    if ([...declarationsByLocation.values()].some((declarations) => declarations.length > 1
      && (!currentProtocol || declarations.some((symbol) => symbol.identityAmbiguous !== true)))) {
      fail(`${label}.symbols contains unmarked duplicate declarations.`, "INVALID_REPOSITORY_SCAN_RESULT");
    }
    for (const [dependencyIndex, dependency] of file.dependencies.entries()) {
      validateLineRecord(dependency, ["specifier", "kind", "line"], `${label}.dependencies[${dependencyIndex}]`);
      if (typeof dependency.specifier !== "string" || !dependency.specifier || !DEPENDENCY_KINDS.has(dependency.kind)) fail(`${label} dependency is invalid.`, "INVALID_REPOSITORY_SCAN_RESULT");
    }
    assertOrdered(file.dependencies, (left, right) => compareText(left.kind, right.kind) || compareText(left.specifier, right.specifier) || left.line - right.line, `${label}.dependencies`);
    if (new Set(file.dependencies.map((dependency) => `${dependency.kind}|${dependency.specifier}`)).size !== file.dependencies.length) fail(`${label}.dependencies contains duplicates.`, "INVALID_REPOSITORY_SCAN_RESULT");
    assertFields(file.semanticFacts, ["bindings", "calls"], `${label}.semanticFacts`);
    if (!Array.isArray(file.semanticFacts.bindings) || !Array.isArray(file.semanticFacts.calls)) fail(`${label} semantic facts are invalid.`, "INVALID_REPOSITORY_SCAN_RESULT");
    for (const [bindingIndex, binding] of file.semanticFacts.bindings.entries()) {
      assertFields(binding, ["local", "imported", "specifier", "namespace"], `${label}.semanticFacts.bindings[${bindingIndex}]`);
      if (![binding.local, binding.imported, binding.specifier].every((value) => typeof value === "string" && value) || typeof binding.namespace !== "boolean") fail(`${label} binding is invalid.`, "INVALID_REPOSITORY_SCAN_RESULT");
    }
    assertOrdered(file.semanticFacts.bindings, (left, right) => compareText(left.local, right.local) || compareText(left.specifier, right.specifier) || compareText(left.imported, right.imported), `${label}.semanticFacts.bindings`);
    for (const [callIndex, call] of file.semanticFacts.calls.entries()) {
      validateLineRecord(call, currentProtocol ? ["callee", "line", "callerQualifiedName", "callerIdentityAmbiguous"] : ["callee", "line"], `${label}.semanticFacts.calls[${callIndex}]`);
      if (typeof call.callee !== "string" || !call.callee
        || (currentProtocol && ((call.callerQualifiedName !== null && (typeof call.callerQualifiedName !== "string" || !call.callerQualifiedName))
          || typeof call.callerIdentityAmbiguous !== "boolean"))) fail(`${label} call is invalid.`, "INVALID_REPOSITORY_SCAN_RESULT");
    }
    assertOrdered(file.semanticFacts.calls, (left, right) => left.line - right.line || compareText(left.callee, right.callee), `${label}.semanticFacts.calls`);
  }
  const skippedFields = scopedProtocol ? SKIPPED_FIELDS : LEGACY_SKIPPED_FIELDS;
  assertFields(result.skipped, skippedFields, "Repository scan skipped counts");
  if (skippedFields.some((field) => !Number.isInteger(result.skipped[field]) || result.skipped[field] < 0)) fail("Repository scan skipped counts are invalid.", "INVALID_REPOSITORY_SCAN_RESULT");
  assertFields(result.summary, ["fileCount", "totalBytes", "symbolCount", "dependencyCount", "bindingCount", "callCount"], "Repository scan summary");
  const expectedSummary = {
    fileCount: result.files.length,
    totalBytes: result.files.reduce((sum, file) => sum + file.bytes, 0),
    symbolCount: result.files.reduce((sum, file) => sum + file.symbols.length, 0),
    dependencyCount: result.files.reduce((sum, file) => sum + file.dependencies.length, 0),
    bindingCount: result.files.reduce((sum, file) => sum + file.semanticFacts.bindings.length, 0),
    callCount: result.files.reduce((sum, file) => sum + file.semanticFacts.calls.length, 0),
  };
  if (canonicalJson(result.summary) !== canonicalJson(expectedSummary)) fail("Repository scan summary does not match files.", "REPOSITORY_SCAN_SUMMARY_MISMATCH");
  const payload = { ...result };
  delete payload.scanId;
  delete payload.scanHash;
  const scanHash = digest(canonicalJson(payload));
  if (result.scanHash !== scanHash || result.scanId !== `repository-scan-${scanHash.slice(0, 24)}`) fail("Repository scan digest verification failed.", "REPOSITORY_SCAN_DIGEST_MISMATCH");
  return result;
}

export function createRepositoryScanReferenceAdapter() {
  return new JsReferenceComputeAdapter({
    name: "repository-scan-javascript-reference",
    operations: {
      [REPOSITORY_SCAN_OPERATION]: (input, { limits }) => scanRepositoryReference(input, { limits }),
    },
  });
}

export function createRepositoryScanComputeAdapter({ pluginRoot = path.resolve(import.meta.dirname, "../.."), storage } = {}) {
  return new GoWorkerComputeAdapter({
    pluginRoot,
    storage,
    fallbackAdapter: createRepositoryScanReferenceAdapter(),
  });
}

export async function executeRepositoryScan({ storage, adapter = createRepositoryScanComputeAdapter({ storage }), projectRoot, managedRootFiles = [], sourceScope = buildRepositorySourceScope({ storage }), limits = {} } = {}) {
  const input = buildRepositoryScanInput({ projectRoot, managedRootFiles, sourceScope, storage });
  const execution = await executeComputeOperation({
    adapter,
    operation: REPOSITORY_SCAN_OPERATION,
    input,
    semanticProducer: semanticProducerFor(scanFormat(input)),
    storage,
    limits,
  });
  validateRepositoryScanResult(execution.result);
  return execution;
}

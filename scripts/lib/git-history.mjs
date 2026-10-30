import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { familyFormatForOriginal, formatForVerifiedOwner } from "./project-storage-format.mjs";
import { resolveLocalGitRepository, LOCAL_GIT_DISCOVERY_ARGS, localGitReadEnvironment } from "./local-git-repository.mjs";

export const GIT_HISTORY_ADAPTER_VERSION = "0.2.0";
export const GIT_DECISION_HISTORY_VERSION = "0.2.0";

export const HOST_OPERATIONAL_GIT_REF_PREFIXES = Object.freeze([
  "refs/codex/turn-diffs",
]);

const MAX_HISTORY_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const REQUIRED_METHODS = ["describe", "readHistory"];
const READABLE_GIT_HISTORY_ADAPTER_VERSIONS = new Set(["0.1.0", GIT_HISTORY_ADAPTER_VERSION]);

const fail = (message, code = "GIT_HISTORY_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

function normalizedGitReference(value) {
  const ref = String(value || "").trim().replaceAll("\\", "/");
  if (!ref.startsWith("refs/") || ref.length > 1024 || /[\x00-\x20\x7f]/.test(ref)) return "";
  if (["~", "^", ":", "?", "*", "["].some((character) => ref.includes(character))) return "";
  if (ref.includes("..") || ref.includes("@{") || ref.includes("//") || ref.endsWith("/") || ref.endsWith(".")) return "";
  if (ref.split("/").some((part) => !part || part === "." || part === ".." || part.endsWith(".lock"))) return "";
  return ref;
}

export function classifyGitReference(value) {
  const ref = normalizedGitReference(value);
  if (!ref) return "invalid";
  if (HOST_OPERATIONAL_GIT_REF_PREFIXES.some((prefix) => ref === prefix || ref.startsWith(`${prefix}/`))) {
    return "host-operational";
  }
  if (/^refs\/(?:heads|remotes|tags)\//.test(ref)) return "product";
  return "unsupported";
}

function isLegacyShortHostDecoration(value) {
  const normalized = String(value || "").trim().replaceAll("\\", "/");
  return normalized === "codex/turn-diffs" || normalized.startsWith("codex/turn-diffs/");
}

function normalizedGitDecoration(value) {
  const decoration = String(value || "").trim();
  if (!decoration) return "";
  if (decoration === "HEAD") return decoration;
  if (decoration.startsWith("tag: ")) {
    const target = decoration.slice(5).trim();
    if (target.startsWith("refs/")) return classifyGitReference(target) === "product" && target.startsWith("refs/tags/") ? `tag: ${target}` : "";
    return isLegacyShortHostDecoration(target) ? "" : decoration;
  }
  const arrow = decoration.indexOf(" -> ");
  if (arrow >= 0) {
    const left = decoration.slice(0, arrow).trim();
    const right = decoration.slice(arrow + 4).trim();
    const allowed = (part) => part === "HEAD"
      || (part.startsWith("refs/") ? classifyGitReference(part) === "product" : !isLegacyShortHostDecoration(part));
    return allowed(left) && allowed(right) ? decoration : "";
  }
  if (decoration.startsWith("refs/")) return classifyGitReference(decoration) === "product" ? decoration : "";
  return isLegacyShortHostDecoration(decoration) ? "" : decoration;
}

export function filterGitDecorations(values) {
  return [...new Set((values || []).map(normalizedGitDecoration).filter(Boolean))].sort();
}

function tagNameFromDecoration(value) {
  if (!String(value).startsWith("tag: ")) return "";
  const target = String(value).slice(5);
  return target.startsWith("refs/tags/") ? target.slice("refs/tags/".length) : target;
}

function stableReason(result) {
  if (result.timedOut) return "git-history-timeout";
  if (result.outputLimited) return "git-history-output-limit";
  if (result.error?.code === "ENOENT") return "git-command-not-found";
  if (result.error) return "git-command-unavailable";
  return "git-history-command-failed";
}

function runProcess(command, args, { cwd, timeoutMs, maxBufferBytes }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: localGitReadEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ status: null, stdout: "", error, timedOut: false, outputLimited: false });
      return;
    }
    const stdout = [];
    let stdoutBytes = 0;
    let outputLimited = false;
    let timedOut = false;
    let processError = null;
    let settled = false;
    const stop = () => {
      if (!child.killed) child.kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBufferBytes) {
        outputLimited = true;
        stop();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", () => {});
    child.once("error", (error) => { processError = error; });
    child.once("close", (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        error: processError,
        timedOut,
        outputLimited,
        childPid: child.pid || null,
      });
    });
  });
}

export function parseGitLog(stdout) {
  const values = String(stdout || "").split("\0");
  const commits = [];
  for (let index = 0; index + 7 < values.length; index += 8) {
    const commit = values[index].trim();
    if (!commit) continue;
    const message = values[index + 7].replace(/^\r?\n/, "").trim();
    const [subject = "", ...bodyLines] = message.split(/\r?\n/);
    commits.push({
      commit,
      parents: values[index + 1].trim().split(/\s+/).filter(Boolean),
      authoredAt: values[index + 2].trim(),
      committedAt: values[index + 3].trim(),
      author: { name: values[index + 4].trim() },
      authorEmailDigest: digest(values[index + 5].trim().toLocaleLowerCase()),
      refs: filterGitDecorations(values[index + 6].split(",")),
      subject: subject.trim(),
      body: bodyLines.join("\n").trim(),
    });
  }
  return commits;
}

function reachableCommits(commits, referenceCommits) {
  if (!referenceCommits.length) return commits;
  const byId = new Map(commits.map((commit) => [commit.commit, commit]));
  for (const commit of referenceCommits) if (!byId.has(commit)) {
    fail(`Git history input does not contain current reference commit ${commit}.`, "GIT_HISTORY_REFERENCE_MISMATCH");
  }
  const reachable = new Set();
  const stack = [...referenceCommits];
  while (stack.length) {
    const commit = stack.pop();
    if (reachable.has(commit)) continue;
    reachable.add(commit);
    for (const parent of byId.get(commit)?.parents || []) {
      if (!byId.has(parent)) fail(`Git history input is missing parent commit ${parent}.`, "GIT_HISTORY_PARENT_MISSING");
      stack.push(parent);
    }
  }
  return commits.filter((commit) => reachable.has(commit.commit));
}

function normalizeCommit(value) {
  if (!value || typeof value !== "object") fail("Git history commit must be an object.", "INVALID_GIT_HISTORY_COMMIT");
  const commit = String(value.commit || "").toLocaleLowerCase();
  if (!/^[a-f0-9]{40,64}$/.test(commit)) fail("Git history commit id is invalid.", "INVALID_GIT_HISTORY_COMMIT");
  const parents = [...new Set((value.parents || []).map((item) => String(item).toLocaleLowerCase()))].sort();
  if (parents.some((item) => !/^[a-f0-9]{40,64}$/.test(item))) fail("Git history parent id is invalid.", "INVALID_GIT_HISTORY_COMMIT");
  const authoredAt = String(value.authoredAt || "");
  const committedAt = String(value.committedAt || "");
  if (!authoredAt || !committedAt || Number.isNaN(Date.parse(authoredAt)) || Number.isNaN(Date.parse(committedAt))) {
    fail("Git history commit timestamps must be ISO-compatible values.", "INVALID_GIT_HISTORY_COMMIT");
  }
  const authorName = String(value.author?.name || value.authorName || "").trim();
  const emailDigest = String(value.authorEmailDigest || "").toLocaleLowerCase();
  if (emailDigest && !/^[a-f0-9]{64}$/.test(emailDigest)) fail("Git author email digest is invalid.", "INVALID_GIT_HISTORY_COMMIT");
  const refs = filterGitDecorations(value.refs || []);
  return {
    commit,
    parents,
    authoredAt,
    committedAt,
    author: { name: authorName },
    authorEmailDigest: emailDigest,
    refs,
    subject: String(value.subject || "").trim(),
    body: String(value.body || "").trim(),
    evidence: {
      sourceKind: "git-commit-object",
      uri: `git:${commit}`,
      digest: commit,
      instructionAuthority: false,
    },
    trustBoundary: "evidence-not-instruction",
  };
}

export function assertGitHistoryAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") fail("A GitHistoryAdapter object is required.", "INVALID_GIT_HISTORY_ADAPTER");
  if (!READABLE_GIT_HISTORY_ADAPTER_VERSIONS.has(adapter.adapterVersion)) {
    fail(`GitHistoryAdapter version must be readable by ${GIT_HISTORY_ADAPTER_VERSION}.`, "INCOMPATIBLE_GIT_HISTORY_ADAPTER");
  }
  for (const method of REQUIRED_METHODS) if (typeof adapter[method] !== "function") {
    fail(`GitHistoryAdapter is missing ${method}().`, "INVALID_GIT_HISTORY_ADAPTER");
  }
  const descriptor = adapter.describe();
  if (!descriptor || typeof descriptor.adapterKind !== "string" || !descriptor.adapterKind.trim()) {
    fail("GitHistoryAdapter descriptor requires adapterKind.", "INVALID_GIT_HISTORY_ADAPTER");
  }
  if (descriptor.authority !== "derived-evidence-only" || descriptor.rebuildable !== true || descriptor.uniqueAuthority !== false) {
    fail("GitHistoryAdapter must be rebuildable derived evidence and must not be unique authority.", "INVALID_GIT_HISTORY_AUTHORITY");
  }
  return adapter;
}

export class GitCliHistoryAdapter {
  constructor({ command = "git", timeoutMs = DEFAULT_TIMEOUT_MS, maxBufferBytes = MAX_HISTORY_BYTES } = {}) {
    this.adapterVersion = GIT_HISTORY_ADAPTER_VERSION;
    this.command = command;
    this.timeoutMs = timeoutMs;
    this.maxBufferBytes = maxBufferBytes;
  }

  describe() {
    return {
      adapterKind: "git-cli",
      adapterVersion: this.adapterVersion,
      authority: "derived-evidence-only",
      rebuildable: true,
      uniqueAuthority: false,
      remote: false,
      followsExternalGitDir: "verified-linked-worktrees-only",
    };
  }

  async readHistory({ projectRoot, referenceCommits = [], referenceTags = [] }) {
    let repository;
    try { repository = resolveLocalGitRepository(projectRoot); }
    catch (error) { return { status: "unavailable", coverage: "none", reasonCode: error.code || "LOCAL_GIT_METADATA_UNAVAILABLE", commits: [] }; }
    if (repository.status !== "available") return {
      status: "not-a-git-repository",
      coverage: "none",
      reasonCode: "git-directory-absent",
      commits: [],
    };
    const roots = [...new Set(referenceCommits.map((item) => String(item).toLocaleLowerCase()))].sort();
    const includeTags = referenceTags.length > 0;
    if (!roots.length && !includeTags) return {
      status: "empty",
      coverage: "empty-repository",
      reasonCode: "",
      commits: [],
    };
    const processOptions = { cwd: projectRoot, timeoutMs: this.timeoutMs, maxBufferBytes: this.maxBufferBytes };
    const discovery = await runProcess(this.command, ["--no-optional-locks", ...LOCAL_GIT_DISCOVERY_ARGS], processOptions);
    if (discovery.error || discovery.status !== 0) return { status: "unavailable", coverage: "none", reasonCode: stableReason(discovery), commits: [] };
    try { repository.matchesDiscovery(Buffer.from(discovery.stdout)); }
    catch (error) { return { status: "unavailable", coverage: "none", reasonCode: error.code || "LOCAL_GIT_DISCOVERY_MISMATCH", commits: [] }; }
    const result = await runProcess(this.command, [
      "-C", projectRoot,
      "-c", "i18n.logOutputEncoding=UTF-8",
      "--no-pager",
      "log", "--topo-order", "--date-order", "--no-show-signature", "--decorate=full",
      "--decorate-refs-exclude=refs/codex/turn-diffs/**",
      "--format=%H%x00%P%x00%aI%x00%cI%x00%an%x00%ae%x00%D%x00%B%x00",
      ...roots,
      ...(includeTags ? ["--tags"] : []),
    ], processOptions);
    try { repository.assertCurrent(); }
    catch (error) { return { status: "unavailable", coverage: "none", reasonCode: error.code || "LOCAL_GIT_MAPPING_DRIFT", commits: [] }; }
    if (result.error || result.status !== 0) return {
      status: "unavailable",
      coverage: "none",
      reasonCode: stableReason(result),
      commits: [],
      diagnostics: { exitStatus: Number.isInteger(result.status) ? result.status : null, childPid: result.childPid || null },
    };
    return {
      status: "available",
      coverage: "all-reachable-commits",
      reasonCode: "",
      commits: parseGitLog(result.stdout),
      diagnostics: { exitStatus: 0, childPid: result.childPid || null },
    };
  }
}

export class GitLogFileHistoryAdapter {
  constructor({ file, maxBytes = MAX_HISTORY_BYTES } = {}) {
    this.adapterVersion = GIT_HISTORY_ADAPTER_VERSION;
    this.file = typeof file === "string" ? path.resolve(file) : "";
    this.maxBytes = maxBytes;
  }

  describe() {
    return {
      adapterKind: "git-log-file",
      adapterVersion: this.adapterVersion,
      authority: "derived-evidence-only",
      rebuildable: true,
      uniqueAuthority: false,
      remote: false,
      followsExternalGitDir: false,
    };
  }

  readHistory() {
    if (!this.file) fail("Git log file adapter requires a file.", "GIT_LOG_FILE_REQUIRED");
    if (!fs.existsSync(this.file)) fail("Git log input file does not exist.", "GIT_LOG_FILE_NOT_FOUND");
    const stat = fs.lstatSync(this.file);
    if (stat.isSymbolicLink() || !stat.isFile()) fail("Git log input must be a regular non-symlink file.", "INVALID_GIT_LOG_FILE");
    if (stat.size > this.maxBytes) fail("Git log input exceeds the configured byte limit.", "GIT_HISTORY_OUTPUT_LIMIT");
    const content = fs.readFileSync(this.file, "utf8");
    return {
      status: "available",
      coverage: "all-reachable-commits",
      reasonCode: "",
      commits: parseGitLog(content),
      diagnostics: { inputKind: "host-exported-git-log", bytes: stat.size },
    };
  }
}

export function createGitHistoryAdapter(adapter = null) {
  return assertGitHistoryAdapter(adapter || new GitCliHistoryAdapter());
}

export async function buildGitDecisionHistory({ projectRoot, adapter = null, referenceCommits = [], referenceTags = [], storage = null } = {}) {
  const selected = createGitHistoryAdapter(adapter);
  const references = [...new Set(referenceCommits.map((item) => String(item).toLocaleLowerCase()))].sort();
  if (references.some((item) => !/^[a-f0-9]{40,64}$/.test(item))) fail("Git history reference commit is invalid.", "INVALID_GIT_HISTORY_REFERENCE");
  const tags = [...new Set(referenceTags.map((item) => String(item).trim()).filter(Boolean))].sort();
  const observed = await selected.readHistory({ projectRoot, referenceCommits: references, referenceTags: tags });
  const allowedStatuses = new Set(["available", "empty", "unavailable", "not-a-git-repository"]);
  const status = String(observed?.status || "unavailable");
  if (!allowedStatuses.has(status)) fail("GitHistoryAdapter returned an invalid status.", "INVALID_GIT_HISTORY_ADAPTER_OUTPUT");
  const normalized = (observed?.commits || []).map(normalizeCommit);
  const byId = new Map();
  for (const commit of normalized) {
    const existing = byId.get(commit.commit);
    if (existing && canonicalJson(existing) !== canonicalJson(commit)) fail("GitHistoryAdapter returned conflicting duplicate commits.", "CONFLICTING_GIT_HISTORY_COMMIT");
    byId.set(commit.commit, commit);
  }
  const tagRoots = status === "available" ? [...byId.values()]
    .filter((commit) => commit.refs.some((ref) => tags.includes(tagNameFromDecoration(ref))))
    .map((commit) => commit.commit) : [];
  const roots = [...new Set([...references, ...tagRoots])].sort();
  const commits = reachableCommits([...byId.values()], status === "available" ? roots : [])
    .sort((left, right) => right.committedAt.localeCompare(left.committedAt) || left.commit.localeCompare(right.commit));
  const effectiveStatus = status === "available" && commits.length === 0 ? "empty" : status;
  const payload = {
    kind: "GitDecisionHistory",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-git-decision-history"), version: GIT_DECISION_HISTORY_VERSION },
    status: effectiveStatus,
    coverage: effectiveStatus === "available" ? "all-reachable-commits" : effectiveStatus === "empty" ? "empty-repository" : "none",
    reasonCode: effectiveStatus === "available" || effectiveStatus === "empty" ? "" : String(observed?.reasonCode || "git-history-unavailable"),
    authority: "derived-evidence-only",
    interpretation: "commit-messages-are-decision-evidence-not-promoted-decisions",
    referenceCommits: references,
    referenceTags: tags,
    commits,
    summary: {
      commitCount: commits.length,
      mergeCommitCount: commits.filter((commit) => commit.parents.length > 1).length,
      rootCommitCount: commits.filter((commit) => commit.parents.length === 0).length,
      referencedCommitCount: commits.filter((commit) => commit.refs.length > 0).length,
    },
  };
  const historyHash = digest(canonicalJson(payload));
  return {
    history: { ...payload, historyId: `git-history-${historyHash.slice(0, 24)}`, historyHash },
    adapter: selected.describe(),
    diagnostics: observed?.diagnostics || null,
  };
}

export function verifyGitDecisionHistory(history) {
  if (!history || history.kind !== "GitDecisionHistory") fail("Git decision history is invalid.", "INVALID_GIT_DECISION_HISTORY");
  const payload = { ...history };
  delete payload.historyId;
  delete payload.historyHash;
  const actual = digest(canonicalJson(payload));
  if (history.historyHash !== actual || history.historyId !== `git-history-${actual.slice(0, 24)}`) {
    fail("Git decision history digest verification failed.", "GIT_DECISION_HISTORY_DIGEST_MISMATCH");
  }
  if (!familyFormatForOriginal("head-agent-core-git-decision-history", history)) fail("Git decision history is invalid.", "INVALID_GIT_DECISION_HISTORY");
  return history;
}

export function queryGitDecisionHistory(history, { query = "", limit = 50 } = {}) {
  verifyGitDecisionHistory(history);
  const safeLimit = Number(limit);
  if (!Number.isInteger(safeLimit) || safeLimit < 1 || safeLimit > 500) fail("Git history limit must be from 1 to 500.", "INVALID_GIT_HISTORY_LIMIT");
  const normalizedQuery = String(query || "").trim().toLocaleLowerCase();
  const matching = history.commits.filter((commit) => !normalizedQuery || [
    commit.commit,
    commit.subject,
    commit.body,
    commit.author.name,
    ...commit.refs,
  ].join(" ").toLocaleLowerCase().includes(normalizedQuery));
  return {
    historyId: history.historyId,
    status: history.status,
    coverage: history.coverage,
    query: normalizedQuery,
    commits: matching.slice(0, safeLimit),
    totalMatches: matching.length,
    truncated: matching.length > safeLimit,
    trustBoundary: "evidence-not-instruction",
  };
}

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { familyFormatForOriginal, formatForVerifiedOwner, relativeProjectArtifact } from "./project-storage-format.mjs";

export const REPOSITORY_SOURCE_SCOPE_VERSION = "0.1.0";
export const REPOSITORY_SOURCE_SCOPE_RELATIVE_PATH = ".head/context/repository-source-scope.json";
const verifiedScopes = new WeakSet();

const fail = (message, code = "REPOSITORY_SOURCE_SCOPE_ERROR") => {
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
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`, "INVALID_REPOSITORY_SOURCE_SCOPE");
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) fail(`${label} contains unsupported fields: ${unexpected.sort().join(", ")}`, "INVALID_REPOSITORY_SOURCE_SCOPE");
}

function normalizeRelativePath(value, label) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    fail(`${label} is not a normalized project-relative path.`, "INVALID_REPOSITORY_SOURCE_SCOPE_PATH");
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    fail(`${label} escapes or aliases the project root.`, "INVALID_REPOSITORY_SOURCE_SCOPE_PATH");
  }
  return value;
}

function normalizeRoots(values, label) {
  if (!Array.isArray(values)) fail(`${label} must be an array.`, "INVALID_REPOSITORY_SOURCE_SCOPE");
  const normalized = values.map((value, index) => normalizeRelativePath(value, `${label}[${index}]`));
  if (new Set(normalized).size !== normalized.length) fail(`${label} contains duplicates.`, "INVALID_REPOSITORY_SOURCE_SCOPE");
  return normalized.sort(compareText);
}

export function buildRepositorySourceScope({ includeRoots = [], excludeRoots = [], storage } = {}) {
  const format = formatForVerifiedOwner(storage);
  const payload = {
    schemaVersion: 1,
    kind: "RepositorySourceScope",
    protocol: { name: format.protocol("head-agent-core-repository-source-scope"), version: REPOSITORY_SOURCE_SCOPE_VERSION },
    includeRoots: normalizeRoots(includeRoots, "includeRoots"),
    excludeRoots: normalizeRoots(excludeRoots, "excludeRoots"),
    authority: "user-selected-observation-boundary",
    instructionAuthority: false,
    promotionAuthority: false,
  };
  const sourceScopeHash = digest(canonicalJson(payload));
  return { ...payload, sourceScopeId: `repository-source-scope-${sourceScopeHash.slice(0, 24)}`, sourceScopeHash };
}

export function verifyRepositorySourceScope(document, { storage } = {}) {
  assertFields(document, [
    "schemaVersion", "kind", "protocol", "includeRoots", "excludeRoots", "authority",
    "instructionAuthority", "promotionAuthority", "sourceScopeId", "sourceScopeHash",
  ], "Repository source scope");
  const format = familyFormatForOriginal("head-agent-core-repository-source-scope", document, storage);
  const rebuilt = buildRepositorySourceScope({ includeRoots: document.includeRoots, excludeRoots: document.excludeRoots, storage: format });
  if (!format || canonicalJson(rebuilt) !== canonicalJson(document)) fail("Repository source scope digest verification failed.", "REPOSITORY_SOURCE_SCOPE_DIGEST_MISMATCH");
  verifiedScopes.add(document);
  return document;
}

export function pathWithinRepositorySourceScope(relativePath, sourceScope, { directory = false } = {}) {
  const scope = verifiedScopes.has(sourceScope) ? sourceScope : verifyRepositorySourceScope(sourceScope);
  const relative = normalizeRelativePath(relativePath, "relativePath");
  const inside = (root) => relative === root || relative.startsWith(`${root}/`);
  if (scope.excludeRoots.some(inside)) return false;
  if (scope.includeRoots.length === 0 || scope.includeRoots.some(inside)) return true;
  return directory && scope.includeRoots.some((root) => root.startsWith(`${relative}/`));
}

export function readRepositorySourceScope({ projectRoot, storage } = {}) {
  if (typeof projectRoot !== "string" || !projectRoot.trim()) fail("projectRoot is required.", "INVALID_REPOSITORY_SOURCE_SCOPE");
  const file = path.join(path.resolve(projectRoot), relativeProjectArtifact(storage, "context", "repository-source-scope.json"));
  if (!fs.existsSync(file)) return { status: "default", file: null, sourceScope: buildRepositorySourceScope({ storage }) };
  let document;
  try { document = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { fail(`Repository source scope is invalid JSON: ${error.message}`, "INVALID_REPOSITORY_SOURCE_SCOPE"); }
  return { status: "configured", file, sourceScope: verifyRepositorySourceScope(document, { storage }) };
}

export function writeRepositorySourceScope({ projectRoot, selection = {}, storage } = {}) {
  if (typeof projectRoot !== "string" || !projectRoot.trim()) fail("projectRoot is required.", "INVALID_REPOSITORY_SOURCE_SCOPE");
  assertFields(selection, ["includeRoots", "excludeRoots"], "Repository source scope selection");
  const sourceScope = buildRepositorySourceScope({ ...selection, storage });
  const file = path.join(path.resolve(projectRoot), relativeProjectArtifact(storage, "context", "repository-source-scope.json"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(sourceScope, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return { status: "configured", file, sourceScope };
}

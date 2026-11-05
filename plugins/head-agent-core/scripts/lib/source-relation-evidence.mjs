import { formatForVerifiedOwner, familyFormatForOriginal } from "./project-storage-format.mjs";
import crypto from "node:crypto";

export const SOURCE_RELATION_EVIDENCE_VERSION = "1.0.0";

const RELATION_TYPES = new Set(["IMPORTS", "CALLS"]);
const ENDPOINT_KINDS = new Set(["file", "symbol", "external"]);

const fail = (message, code = "SOURCE_RELATION_EVIDENCE_ERROR") => {
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

function assertFields(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`, "INVALID_SOURCE_RELATION_EVIDENCE");
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) fail(`${label} contains unsupported fields: ${unexpected.sort().join(", ")}.`, "INVALID_SOURCE_RELATION_EVIDENCE");
}

function validatePath(value, label) {
  if (typeof value !== "string" || !value || value.length > 512 || value.includes("\\") || value.startsWith("/") || value.split("/").some((part) => !part || part === "." || part === "..")) {
    fail(`${label} must be a normalized project-relative path.`, "INVALID_SOURCE_RELATION_EVIDENCE");
  }
  return value;
}

function normalizeEndpoint(value, label) {
  assertFields(value, ["kind", "path", "name", "symbolKind", "line", "specifier"], label);
  if (!ENDPOINT_KINDS.has(value.kind)) fail(`${label}.kind is unsupported.`, "INVALID_SOURCE_RELATION_EVIDENCE");
  if (value.kind === "external") {
    if (typeof value.specifier !== "string" || !value.specifier || value.specifier.length > 512
      || value.path != null || value.name != null || value.symbolKind != null || value.line != null) {
      fail(`${label} external endpoint is invalid.`, "INVALID_SOURCE_RELATION_EVIDENCE");
    }
    return { kind: "external", specifier: value.specifier };
  }
  const endpoint = { kind: value.kind, path: validatePath(value.path, `${label}.path`) };
  if (value.kind === "file") {
    if (value.name != null || value.symbolKind != null || value.line != null || value.specifier != null) fail(`${label} file endpoint is invalid.`, "INVALID_SOURCE_RELATION_EVIDENCE");
    return endpoint;
  }
  if (typeof value.name !== "string" || !value.name || value.name.length > 256
    || typeof value.symbolKind !== "string" || !value.symbolKind || value.symbolKind.length > 64
    || !Number.isInteger(value.line) || value.line < 1 || value.line > 10_000_000 || value.specifier != null) {
    fail(`${label} symbol endpoint is invalid.`, "INVALID_SOURCE_RELATION_EVIDENCE");
  }
  return { ...endpoint, name: value.name, symbolKind: value.symbolKind, line: value.line };
}

function normalizeManifest(files) {
  if (!Array.isArray(files) || files.length > 200_000) fail("Source relation file manifest is invalid.", "INVALID_SOURCE_RELATION_EVIDENCE");
  const normalized = files.map((file, index) => {
    assertFields(file, ["path", "digest", "language"], `files[${index}]`);
    if (!/^[a-f0-9]{64}$/.test(file.digest || "") || typeof file.language !== "string" || !file.language || file.language.length > 64) {
      fail(`files[${index}] is invalid.`, "INVALID_SOURCE_RELATION_EVIDENCE");
    }
    return { path: validatePath(file.path, `files[${index}].path`), digest: file.digest, language: file.language };
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(normalized.map((file) => file.path)).size !== normalized.length) fail("Source relation file manifest contains duplicate paths.", "INVALID_SOURCE_RELATION_EVIDENCE");
  return normalized;
}

export function buildSourceRelationEvidenceSet({ projectId, files, analyzer, relations } = {}, storage = null) {
  if (typeof projectId !== "string" || !projectId || projectId.length > 256) fail("Source relation evidence Project is invalid.", "INVALID_SOURCE_RELATION_EVIDENCE");
  const normalizedFiles = normalizeManifest(files);
  assertFields(analyzer, ["name", "version", "method"], "analyzer");
  if (typeof analyzer.name !== "string" || !analyzer.name || analyzer.name.length > 128
    || typeof analyzer.version !== "string" || !analyzer.version || analyzer.version.length > 64
    || analyzer.method !== "ast") fail("Source relation analyzer must identify a bounded AST implementation.", "INVALID_SOURCE_RELATION_EVIDENCE");
  if (!Array.isArray(relations) || relations.length > 100_000) fail("Source relation evidence relations are invalid.", "INVALID_SOURCE_RELATION_EVIDENCE");
  const filesByPath = new Map(normalizedFiles.map((file) => [file.path, file]));
  const normalizedRelations = relations.map((relation, index) => {
    assertFields(relation, ["type", "from", "to", "evidence", "language"], `relations[${index}]`);
    if (!RELATION_TYPES.has(relation.type) || typeof relation.language !== "string" || !relation.language || relation.language.length > 64) fail(`relations[${index}] is invalid.`, "INVALID_SOURCE_RELATION_EVIDENCE");
    assertFields(relation.evidence, ["path", "line", "digest"], `relations[${index}].evidence`);
    const evidencePath = validatePath(relation.evidence.path, `relations[${index}].evidence.path`);
    const file = filesByPath.get(evidencePath);
    if (!file || relation.evidence.digest !== file.digest || !Number.isInteger(relation.evidence.line) || relation.evidence.line < 1 || relation.evidence.line > 10_000_000) {
      fail(`relations[${index}] does not bind to the current file manifest.`, "SOURCE_RELATION_EVIDENCE_SOURCE_MISMATCH");
    }
    const payload = {
      type: relation.type,
      from: normalizeEndpoint(relation.from, `relations[${index}].from`),
      to: normalizeEndpoint(relation.to, `relations[${index}].to`),
      evidence: { path: evidencePath, line: relation.evidence.line, digest: relation.evidence.digest },
      language: relation.language,
      confidence: "ast-derived-structural-evidence",
    };
    return { ...payload, relationId: `source-relation-${digest(canonicalJson(payload)).slice(0, 24)}` };
  }).sort((left, right) => left.relationId.localeCompare(right.relationId));
  if (new Set(normalizedRelations.map((relation) => relation.relationId)).size !== normalizedRelations.length) fail("Source relation evidence contains duplicate relations.", "INVALID_SOURCE_RELATION_EVIDENCE");
  const payload = {
    schemaVersion: 1,
    kind: "SourceRelationEvidenceSet",
    protocol: { name: formatForVerifiedOwner(storage).protocol("head-agent-core-source-relation-evidence"), version: SOURCE_RELATION_EVIDENCE_VERSION },
    projectId,
    analyzer: { name: analyzer.name, version: analyzer.version, method: "ast" },
    files: normalizedFiles,
    relations: normalizedRelations,
    authority: "derived-structural-evidence-only",
    instructionAuthority: false,
    promotionAuthority: false,
    recoveryAuthority: false,
  };
  const evidenceSetHash = digest(canonicalJson(payload));
  return { ...payload, evidenceSetId: `source-relation-evidence-${evidenceSetHash.slice(0, 24)}`, evidenceSetHash };
}

export function verifySourceRelationEvidenceSet(document, { projectId = null, files = null, storage } = {}) {
  assertFields(document, [
    "schemaVersion", "kind", "protocol", "projectId", "analyzer", "files", "relations", "authority",
    "instructionAuthority", "promotionAuthority", "recoveryAuthority", "evidenceSetId", "evidenceSetHash",
  ], "Source relation evidence set");
  const format = familyFormatForOriginal("head-agent-core-source-relation-evidence", document, storage);
  if (!format) fail("Source relation evidence identity or canonical form is invalid.", "SOURCE_RELATION_EVIDENCE_DIGEST_MISMATCH");
  const rebuilt = buildSourceRelationEvidenceSet({
    projectId: document.projectId,
    files: document.files,
    analyzer: document.analyzer,
    relations: document.relations.map(({ type, from, to, evidence, language }) => ({ type, from, to, evidence, language })),
  }, format);
  if (canonicalJson(rebuilt) !== canonicalJson(document)) fail("Source relation evidence identity or canonical form is invalid.", "SOURCE_RELATION_EVIDENCE_DIGEST_MISMATCH");
  if (projectId != null && document.projectId !== projectId) fail("Source relation evidence belongs to another Project.", "SOURCE_RELATION_EVIDENCE_PROJECT_MISMATCH");
  if (files != null && canonicalJson(document.files) !== canonicalJson(normalizeManifest(files))) fail("Source relation evidence file manifest is stale.", "SOURCE_RELATION_EVIDENCE_SOURCE_MISMATCH");
  return document;
}

export async function collectSourceRelationEvidence({ projectId, projectRoot, files, adapter = null, storage } = {}) {
  if (!adapter) return { evidence: null, diagnostics: { status: "not-configured", fallback: "heuristic-source-analysis-retained" } };
  if (typeof adapter.collect !== "function") fail("SourceRelationEvidenceAdapter must implement collect().", "INVALID_SOURCE_RELATION_EVIDENCE_ADAPTER");
  const manifest = normalizeManifest(files);
  const document = await adapter.collect({ projectId, projectRoot, files: manifest, storage });
  const evidence = verifySourceRelationEvidenceSet(document, { projectId, files: manifest, storage });
  return {
    evidence,
    diagnostics: {
      status: "collected",
      adapterKind: String(adapter.adapterKind || "provider-neutral-source-relation-adapter"),
      evidenceSetId: evidence.evidenceSetId,
      analyzer: evidence.analyzer,
      relationCount: evidence.relations.length,
      authority: evidence.authority,
    },
  };
}

export class InMemorySourceRelationEvidenceAdapter {
  constructor({ analyzer, relations, adapterKind = "in-memory-ast-fixture" } = {}) {
    this.analyzer = analyzer;
    this.relations = relations;
    this.adapterKind = adapterKind;
  }

  collect({ projectId, files, storage }) {
    return buildSourceRelationEvidenceSet({ projectId, files, analyzer: this.analyzer, relations: this.relations }, storage);
  }
}

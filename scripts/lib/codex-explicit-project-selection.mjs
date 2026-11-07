import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { nativeRoot, nativeRaw, nativeCheck, pinNativeRoot } from "./provider-native-history-host.mjs";
import { parseCodexSourceJson } from "./codex-source-json.mjs";

const fail = code => { throw Object.assign(new Error(code), { code }); };
export const explicitSelectionHash = value => crypto.createHash("sha256").update(value).digest("hex");
const shape = (value, fields) => value && typeof value === "object" && !Array.isArray(value)
  && equal(Object.keys(value).sort(), fields.slice().sort());
const id = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
const text = value => typeof value === "string" && value.length > 0 && value.trim() === value;
const identity = value => shape(value, ["path", "dev", "ino"]) && text(value.path)
  && /^\d+$/u.test(value.dev) && /^\d+$/u.test(value.ino);

// Compare spellings only; this grants no access or identity. The live loader
// checks the caller's actual roots and the opened source inode separately.
export function codexSourcePathKey(value, platform = process.platform) {
  if (typeof value !== "string") return null;
  const style = platform === "win32" ? path.win32 : path.posix;
  if (!style.isAbsolute(value)) return null;
  if (platform !== "win32") return style.resolve(value);
  const normalized = value.replaceAll("/", "\\");
  if (/^\\\\\.\\/u.test(normalized)
    || /^\\\\\?\\/u.test(normalized) && !/^\\\\\?\\(?:[A-Za-z]:\\|UNC\\[^\\]+\\[^\\]+\\)/u.test(normalized)) return null;
  return style.toNamespacedPath(style.resolve(value)).toLowerCase();
}

export function verifyCodexExplicitSelectionDocument(value) {
  if (!shape(value, ["schemaVersion", "kind", "authorityPlane", "projectReference", "sourcePlatform", "sourceHome", "projectRoot", "members", "observedAt",
    "selectionOrigin", "nullFileIdentityMeaning", "claimsHostAuthentication", "appMembershipVerifiedByCore", "grantsRecoveryAuthority", "restoresExecutionPermission"])
    || value.schemaVersion !== 1 || value.kind !== "CodexExplicitProjectSelection" || value.authorityPlane !== "P3"
    || value.sourcePlatform !== "win32" || !identity(value.sourceHome) || !identity(value.projectRoot)
    || codexSourcePathKey(value.sourceHome.path, value.sourcePlatform) === null || codexSourcePathKey(value.projectRoot.path, value.sourcePlatform) === null
    || !shape(value.projectReference, ["namespace", "id", "name"]) || value.projectReference.namespace !== "codex-app-project"
    || !text(value.projectReference.id) || !text(value.projectReference.name) || typeof value.observedAt !== "string" || !Number.isFinite(Date.parse(value.observedAt))
    || value.selectionOrigin !== "current-caller-exact-conversation-selection"
    || value.nullFileIdentityMeaning !== "observed-absent-requires-new-observation-if-present"
    || ["claimsHostAuthentication", "appMembershipVerifiedByCore", "grantsRecoveryAuthority", "restoresExecutionPermission"].some(key => value[key] !== false)
    || !Array.isArray(value.members) || !value.members.length) fail("CODEX_EXPLICIT_SELECTION_INVALID");
  const seen = new Set();
  for (const member of value.members) {
    if (!shape(member, ["id", "nativeProjectId", "cwd", "rolloutPath", "fileIdentity"])
      || !id(member.id) || seen.has(member.id) || member.nativeProjectId !== null && !text(member.nativeProjectId)
      || typeof member.cwd !== "string" || typeof member.rolloutPath !== "string"
      || member.fileIdentity !== null && (!shape(member.fileIdentity, ["dev", "ino"]) || !/^\d+$/u.test(member.fileIdentity.dev) || !/^\d+$/u.test(member.fileIdentity.ino)))
      fail("CODEX_EXPLICIT_SELECTION_INVALID");
    seen.add(member.id);
    if (codexSourcePathKey(member.cwd, value.sourcePlatform) !== codexSourcePathKey(value.projectRoot.path, value.sourcePlatform))
      fail("CODEX_EXPLICIT_SELECTION_WORKSPACE_SCOPE_MISMATCH");
  }
  return value;
}

export function decodeCodexExplicitSelectionEvidence(evidence) {
  if (!shape(evidence, ["bytes", "sha256", "base64"]) || !Number.isSafeInteger(evidence.bytes) || evidence.bytes < 1
    || !/^[a-f0-9]{64}$/u.test(evidence.sha256) || typeof evidence.base64 !== "string") fail("CODEX_EXPLICIT_SELECTION_EVIDENCE_INVALID");
  const raw = Buffer.from(evidence.base64, "base64");
  if (raw.length !== evidence.bytes || raw.toString("base64") !== evidence.base64 || explicitSelectionHash(raw) !== evidence.sha256)
    fail("CODEX_EXPLICIT_SELECTION_EVIDENCE_INVALID");
  return verifyCodexExplicitSelectionDocument(parseCodexSourceJson(new TextDecoder("utf-8", { fatal: true }).decode(raw)));
}

// The file is a selector and P3 observation, never Host authentication, current
// app membership, permission or P2 direction. Current caller authority and
// explicit home/root arguments remain independent from its contents.
export function readCodexExplicitProjectSelection({ file, expectedDigest, home, projectRoot, projectId, signal, assertCurrentAuthority }) {
  if (typeof assertCurrentAuthority !== "function" || !path.isAbsolute(file || "") || !path.isAbsolute(home || "")
    || !path.isAbsolute(projectRoot || "") || !/^[a-f0-9]{64}$/u.test(expectedDigest || "")) fail("CODEX_EXPLICIT_SELECTION_CURRENT_SCOPE_REQUIRED");
  const check = () => nativeCheck(signal, assertCurrentAuthority); check();
  const source = nativeRoot(path.dirname(file)), read = nativeRaw(source, path.basename(file), signal, check);
  if (read.entry.sha256 !== expectedDigest) fail("CODEX_EXPLICIT_SELECTION_DIGEST_CHANGED");
  const evidence = { bytes: read.raw.length, sha256: read.entry.sha256, base64: read.raw.toString("base64") };
  const document = decodeCodexExplicitSelectionEvidence(evidence);
  if (document.projectReference.id !== projectId || document.sourcePlatform !== process.platform
    || codexSourcePathKey(document.sourceHome.path) !== codexSourcePathKey(home)
    || codexSourcePathKey(document.projectRoot.path) !== codexSourcePathKey(projectRoot)) fail("CODEX_EXPLICIT_SELECTION_SCOPE_MISMATCH");
  nativeCheck(signal, () => assertCurrentAuthority({ action: "read-explicit-codex-project-selection", authorityPlane: "P3",
    projectReference: structuredClone(document.projectReference), home, projectRoot, selectedThreadIds: document.members.map(row => row.id), evidenceIsPermission: false }));
  const roots = [[home, document.sourceHome], [projectRoot, document.projectRoot]].map(([requested, expected]) => {
    check(); const actual = nativeRoot(requested), stat = fs.lstatSync(actual, { bigint: true });
    if (String(stat.dev) !== expected.dev || String(stat.ino) !== expected.ino) fail("CODEX_EXPLICIT_SELECTION_ROOT_IDENTITY_CHANGED");
    return pinNativeRoot(actual);
  });
  for (const member of document.members) {
    check(); const actual = nativeRoot(member.cwd), stat = fs.lstatSync(actual, { bigint: true });
    if (String(stat.dev) !== document.projectRoot.dev || String(stat.ino) !== document.projectRoot.ino) fail("CODEX_EXPLICIT_SELECTION_WORKSPACE_SCOPE_MISMATCH");
  }
  return { document, evidence, check() {
    check(); for (const root of roots) root.verify();
    if (nativeRaw(source, path.basename(file), signal, check).entry.sha256 !== expectedDigest) fail("CODEX_EXPLICIT_SELECTION_DIGEST_CHANGED");
  } };
}

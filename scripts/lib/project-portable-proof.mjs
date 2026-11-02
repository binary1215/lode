import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { copiedProjectFile } from "./project-copy-evidence.mjs";

export const PORTABLE_PROJECT_LOCATION_KIND = "portable-project-copy";
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const fail = () => {
  throw Object.assign(new Error("Portable Project location proof is invalid."), {
    code: "PROJECT_PORTABLE_ADMISSION_INVALID",
  });
};
const sha = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const shape = (value, fields) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === fields.slice().sort().join(",");
const invariant = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const { projectRoot, location, ...rest } = value;
  return JSON.stringify(rest);
};

export function verifyPortableProjectLocation(
  root,
  directory,
  project,
  verifySourceLocation,
  readOriginal = null,
) {
  const originalBytes = (relative) => {
    if (readOriginal) return readOriginal(relative);
    const file = copiedProjectFile(root, relative),
      stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1) fail();
    return fs.readFileSync(file);
  };
  const exact = (relative, digest) => {
    const bytes = originalBytes(relative);
    if (hash(bytes) !== digest) fail();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  };
  const location = project?.location;
  if (location?.kind !== PORTABLE_PROJECT_LOCATION_KIND || !sha(location.admissionDigest)) fail();
  const receipt = exact(
    directory + "/project-location/portable/" + location.admissionDigest + ".json",
    location.admissionDigest,
  );
  if (
    !shape(receipt, [
      "schemaVersion",
      "kind",
      "authorityPlane",
      "projectId",
      "directory",
      "targetRoot",
      "sourceProjectDigest",
      "bundleManifestDigest",
      "selectedSessionId",
      "origin",
      "inventory",
      "grantsExecutionAuthorization",
    ]) ||
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "PortableProjectAdmission" ||
    receipt.authorityPlane !== "P3" ||
    receipt.projectId !== project.projectId ||
    receipt.directory !== directory ||
    typeof receipt.targetRoot !== "string" ||
    !(path.posix.isAbsolute(receipt.targetRoot) || path.win32.isAbsolute(receipt.targetRoot)) ||
    !sha(receipt.sourceProjectDigest) ||
    !sha(receipt.bundleManifestDigest) ||
    receipt.grantsExecutionAuthorization !== false ||
    typeof receipt.selectedSessionId !== "string" ||
    !/^session-[a-fA-F0-9-]{36}$/.test(receipt.selectedSessionId) ||
    !shape(receipt.inventory, ["files", "excludedPaths", "integrity", "grantsOwnership"]) ||
    !Array.isArray(receipt.inventory.files) ||
    !Array.isArray(receipt.inventory.excludedPaths) ||
    receipt.inventory.excludedPaths.length ||
    receipt.inventory.integrity !== "raw-byte-inventory-only" ||
    receipt.inventory.grantsOwnership !== false
  )
    fail();
  const names = new Set();
  for (const entry of receipt.inventory.files) {
    if (
      !shape(entry, ["path", "bytes", "sha256"]) ||
      typeof entry.path !== "string" ||
      !entry.path.startsWith(directory + "/") ||
      names.has(entry.path.toLowerCase()) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      !sha(entry.sha256) ||
      entry.path
        .split("/")
        .some((part) => !part || part === "." || part === ".." || /[\\:\u0000-\u001f]/.test(part))
    )
      fail();
    names.add(entry.path.toLowerCase());
  }
  const source = exact(
    directory + "/project-location/history/" + receipt.sourceProjectDigest + ".json",
    receipt.sourceProjectDigest,
  );
  if (source.projectId !== project.projectId || invariant(source) !== invariant(project)) fail();
  const manifest = exact(
    directory + "/project-location/portable-bundles/" + receipt.bundleManifestDigest + ".json",
    receipt.bundleManifestDigest,
  );
  if (
    manifest.kind !== "PortableProjectBundle" ||
    manifest.projectId !== project.projectId ||
    manifest.sourceProjectDigest !== receipt.sourceProjectDigest ||
    manifest.selectedSessionId !== receipt.selectedSessionId ||
    JSON.stringify(manifest.files) !== JSON.stringify(receipt.inventory.files)
  )
    fail();
  const sourceProof = verifySourceLocation(source);
  if (receipt.origin !== (sourceProof.origin || "origin-verified")) fail();
  const roots = [],
    seen = new Set();
  let current = project;
  while (true) {
    const link = current?.location;
    if (
      invariant(current) !== invariant(project) ||
      !shape(link, ["kind", "admissionDigest", "previousProjectDigest"]) ||
      link.kind !== PORTABLE_PROJECT_LOCATION_KIND ||
      link.admissionDigest !== location.admissionDigest ||
      !sha(link.previousProjectDigest) ||
      seen.has(link.previousProjectDigest) ||
      typeof current.projectRoot !== "string" ||
      !(path.posix.isAbsolute(current.projectRoot) || path.win32.isAbsolute(current.projectRoot))
    )
      fail();
    seen.add(link.previousProjectDigest);
    roots.push(current.projectRoot);
    if (link.previousProjectDigest === receipt.sourceProjectDigest) {
      if (current.projectRoot !== receipt.targetRoot) fail();
      break;
    }
    current = exact(
      directory + "/project-location/history/" + link.previousProjectDigest + ".json",
      link.previousProjectDigest,
    );
  }
  return {
    origin: receipt.origin,
    identityRoot: sourceProof.identityRoot,
    roots: [...new Set([...roots, ...sourceProof.roots])],
    digest: hash(
      JSON.stringify({ project, admissionDigest: location.admissionDigest, history: [...seen] }),
    ),
    locationKind: PORTABLE_PROJECT_LOCATION_KIND,
    copyAdmission: receipt,
    copyAdmissionDigest: location.admissionDigest,
  };
}

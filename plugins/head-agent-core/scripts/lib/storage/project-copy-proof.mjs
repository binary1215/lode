import fs from "node:fs";
import path from "node:path";
import { copiedProjectFile } from "./project-copy-evidence.mjs";
import { sha256Hex as hash } from "../core/digest.mjs";

export const COPIED_PROJECT_LOCATION_KIND = "verified-project-copy";
const fail = () => {
  throw Object.assign(new Error("The selected copied Project's exact admission or history is invalid."), { code: "PROJECT_COPY_ADMISSION_INVALID" });
};
const sha = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const shape = (value, keys) =>
  value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const invariant = (value) => {
  const { projectRoot, location, ...rest } = value;
  return JSON.stringify(rest);
};

function exactJson(root, relative, expected, readOriginal = null) {
  let bytes;
  if (readOriginal) bytes = readOriginal(relative);
  else {
    const file = copiedProjectFile(root, relative),
      stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1) fail();
    bytes = fs.readFileSync(file);
  }
  if (hash(bytes) !== expected) fail();
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

// This is provenance for one user-selected copy, not an origin certificate.
// It admits no old root wholesale and does not verify optional World meaning.
export function verifyCopiedProjectLocation(root, directory, project, inspectOriginalOrigin, readOriginal = null) {
  const exact = (relative, expected) => exactJson(root, relative, expected, readOriginal);
  const location = project?.location;
  if (location?.kind !== COPIED_PROJECT_LOCATION_KIND || !sha(location.admissionDigest)) fail();
  const admission = exact(`${directory}/project-location/copies/${location.admissionDigest}.json`, location.admissionDigest);
  if (
    !shape(admission, [
      "schemaVersion",
      "kind",
      "projectId",
      "directory",
      "acceptedRoot",
      "origin",
      "sourceProjectDigest",
      "sourceManifestDigest",
      "inventory",
    ]) ||
    admission.schemaVersion !== 1 ||
    admission.kind !== "VerifiedProjectCopyAdmission" ||
    admission.origin !== "initial-origin-unverified" ||
    admission.projectId !== project.projectId ||
    admission.directory !== directory ||
    typeof admission.acceptedRoot !== "string" ||
    !(path.posix.isAbsolute(admission.acceptedRoot) || path.win32.isAbsolute(admission.acceptedRoot)) ||
    !sha(admission.sourceProjectDigest) ||
    !sha(admission.sourceManifestDigest) ||
    !shape(admission.inventory, ["files", "excludedPaths", "integrity", "grantsOwnership"]) ||
    admission.inventory.integrity !== "raw-byte-inventory-only" ||
    admission.inventory.grantsOwnership !== false ||
    !Array.isArray(admission.inventory.files) ||
    !Array.isArray(admission.inventory.excludedPaths)
  )
    fail();
  const paths = new Set();
  for (const entry of admission.inventory.files) {
    if (
      !shape(entry, ["path", "bytes", "sha256"]) ||
      typeof entry.path !== "string" ||
      !entry.path.startsWith(`${directory}/`) ||
      paths.has(entry.path) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      !sha(entry.sha256)
    )
      fail();
    // Validate syntax independently of present optional data. A missing/corrupt
    // optional original limits its own reader, not ordinary Core selection.
    if (entry.path.split("/").some((part) => !part || part === "." || part === ".." || /[\\:\u0000-\u001f]/.test(part))) fail();
    paths.add(entry.path);
  }
  if (
    admission.inventory.excludedPaths.some(
      (value) =>
        typeof value !== "string" ||
        !value.startsWith(`${directory}/`) ||
        value.split("/").some((part) => !part || part === "." || part === ".." || /[\\:\u0000-\u001f]/.test(part)),
    )
  )
    fail();
  const source = exact(`${directory}/project-location/history/${admission.sourceProjectDigest}.json`, admission.sourceProjectDigest);
  const manifest = exact(`${directory}/project-location/copy-originals/${admission.sourceManifestDigest}.json`, admission.sourceManifestDigest);
  if (
    source.projectId !== project.projectId ||
    invariant(source) !== invariant(project) ||
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.managed) ||
    !manifest.managed.some((entry) => entry.path === `${directory}/project.json` && entry.sha256 === admission.sourceProjectDigest) ||
    inspectOriginalOrigin(root, directory, source).status !== "initial-origin-unverified"
  )
    fail();
  const seen = new Set(),
    roots = [];
  let current = project;
  while (true) {
    const link = current?.location;
    if (
      !current ||
      current.projectId !== project.projectId ||
      invariant(current) !== invariant(project) ||
      typeof current.projectRoot !== "string" ||
      !(path.posix.isAbsolute(current.projectRoot) || path.win32.isAbsolute(current.projectRoot)) ||
      !shape(link, ["kind", "admissionDigest", "previousProjectDigest"]) ||
      link.kind !== COPIED_PROJECT_LOCATION_KIND ||
      link.admissionDigest !== location.admissionDigest ||
      !sha(link.previousProjectDigest) ||
      seen.has(link.previousProjectDigest)
    )
      fail();
    seen.add(link.previousProjectDigest);
    roots.push(current.projectRoot);
    if (link.previousProjectDigest === admission.sourceProjectDigest) {
      if (current.projectRoot !== admission.acceptedRoot) fail();
      break;
    }
    current = exact(`${directory}/project-location/history/${link.previousProjectDigest}.json`, link.previousProjectDigest);
  }
  return {
    origin: admission.origin,
    identityRoot: null,
    locationKind: COPIED_PROJECT_LOCATION_KIND,
    roots: [...new Set(roots)],
    digest: hash(JSON.stringify({ project, admissionDigest: location.admissionDigest, history: [...seen] })),
    copyAdmission: admission,
    copyAdmissionDigest: location.admissionDigest,
  };
}

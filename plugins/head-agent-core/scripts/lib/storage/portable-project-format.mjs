import { failCode as portableFail } from "../core/errors.mjs";
// Transport format only. Historical proofs reuse this validator without
// recursively inspecting a Project or granting source/recovery authority.
export const PORTABLE_SOURCE_CAPABILITY = "portable-selected-retained-sources-v1";
export const PORTABLE_SOURCE_KINDS = Object.freeze(["source", "outgoing-calls", "declarations", "selected-source"]);
export const digestValid = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const closedPortable = (value, fields) =>
  value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => fields.includes(key));
export const portableReferenceKey = (relative, digest) => JSON.stringify([relative, digest]);
const safeSourcePath = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 512 &&
  !/^(?:\.git|\.head|\.lode)(?:\/|$)/i.test(value) &&
  !/^[A-Za-z]:|^\//.test(value) &&
  !value.split("/").some((part) => !part || part === "." || part === ".." || /[\\:\x00-\x1f]/.test(part));
const statuses = ["included-verified-retained-original", "not-requested-body-transfer", "retained-original-unavailable", "excluded-export-eligibility"];

export function validatePortableManifestFormat(manifest) {
  if (
    !manifest ||
    manifest.kind !== "PortableProjectBundle" ||
    ![1, 2].includes(manifest.schemaVersion) ||
    manifest.authorityPlane !== "P3" ||
    ![".head", ".lode"].includes(manifest.directory) ||
    typeof manifest.projectId !== "string" ||
    !/^session-[a-fA-F0-9-]{36}$/.test(manifest.selectedSessionId || "") ||
    !Array.isArray(manifest.files) ||
    manifest.restoresExecutionPermission !== false ||
    manifest.transfersNativeBinding !== false
  )
    portableFail("PROJECT_BUNDLE_MANIFEST_INVALID");
  if (manifest.schemaVersion === 1) {
    if (manifest.requiredCapabilities !== undefined || manifest.sourceTransfer !== undefined) portableFail("PROJECT_BUNDLE_CAPABILITY_MISMATCH");
    return manifest;
  }
  if (JSON.stringify(manifest.requiredCapabilities) !== JSON.stringify([PORTABLE_SOURCE_CAPABILITY])) portableFail("PROJECT_BUNDLE_CAPABILITY_MISMATCH");
  const transfer = manifest.sourceTransfer;
  if (
    !closedPortable(transfer, ["schemaVersion", "mode", "gitLookup", "supportedKinds", "references", "lookupCoverage"]) ||
    transfer.schemaVersion !== 1 ||
    !["selected-retained-sources", "refs-only"].includes(transfer.mode) ||
    transfer.gitLookup !== "not-looked-up-not-included" ||
    JSON.stringify(transfer.supportedKinds) !== JSON.stringify(PORTABLE_SOURCE_KINDS) ||
    !Array.isArray(transfer.references) ||
    !closedPortable(transfer.lookupCoverage, ["inspectedEntries", "preflightBytes", "partial", "reasonCode"]) ||
    !Number.isSafeInteger(transfer.lookupCoverage.inspectedEntries) ||
    transfer.lookupCoverage.inspectedEntries < 0 ||
    !Number.isSafeInteger(transfer.lookupCoverage.preflightBytes) ||
    transfer.lookupCoverage.preflightBytes < 0 ||
    typeof transfer.lookupCoverage.partial !== "boolean" ||
    !(transfer.lookupCoverage.reasonCode === null || /^[A-Z][A-Z0-9_]{0,95}$/.test(transfer.lookupCoverage.reasonCode || ""))
  )
    portableFail("PROJECT_BUNDLE_SOURCE_TRANSFER_INVALID");
  if (JSON.stringify(manifest.coverage?.retainedSourceOriginals) !== JSON.stringify(transfer)) portableFail("PROJECT_BUNDLE_SOURCE_COVERAGE_MISMATCH");
  const seen = new Set();
  for (const ref of transfer.references) {
    const key = portableReferenceKey(ref?.path, ref?.digest);
    if (
      !closedPortable(ref, [
        "path",
        "digest",
        "workEvidence",
        "status",
        "reasonCode",
        "sourceBytes",
        "rawBundleBytes",
        "bundleKey",
        "rawSha256",
        "observationId",
        "observationHash",
        "evidenceKind",
        "proof",
      ]) ||
      !safeSourcePath(ref.path) ||
      !digestValid(ref.digest) ||
      seen.has(key) ||
      !statuses.includes(ref.status) ||
      !Array.isArray(ref.workEvidence) ||
      !ref.workEvidence.length ||
      !(ref.reasonCode === null || /^[A-Z][A-Z0-9_]{0,95}$/.test(ref.reasonCode || "")) ||
      ![ref.sourceBytes, ref.rawBundleBytes].every((n) => n === null || (Number.isSafeInteger(n) && n >= 0))
    )
      portableFail("PROJECT_BUNDLE_SOURCE_TRANSFER_INVALID");
    seen.add(key);
    const workSeen = new Set();
    for (const work of ref.workEvidence) {
      if (
        !closedPortable(work, ["evidenceId", "evidenceDigest"]) ||
        !/^work-evidence-[a-f0-9]{24}$/.test(work.evidenceId || "") ||
        !digestValid(work.evidenceDigest) ||
        workSeen.has(work.evidenceId)
      )
        portableFail("PROJECT_BUNDLE_SOURCE_TRANSFER_INVALID");
      workSeen.add(work.evidenceId);
    }
    if (ref.status === "included-verified-retained-original") {
      if (
        transfer.mode !== "selected-retained-sources" ||
        ref.reasonCode !== null ||
        !digestValid(ref.bundleKey) ||
        !digestValid(ref.rawSha256) ||
        !digestValid(ref.observationHash) ||
        !/^observation-[a-f0-9]{24}$/.test(ref.observationId || "") ||
        !PORTABLE_SOURCE_KINDS.includes(ref.evidenceKind) ||
        ref.sourceBytes === null ||
        ref.rawBundleBytes === null ||
        ref.proof !== "raw-and-semantic-identities-verified-no-producer-truth-claim"
      )
        portableFail("PROJECT_BUNDLE_SOURCE_TRANSFER_INVALID");
      const entry = manifest.files.find((file) => file.path === manifest.directory + "/observations/source-bundles/" + ref.bundleKey + ".json");
      if (!entry || entry.sha256 !== ref.rawSha256 || entry.bytes !== ref.rawBundleBytes) portableFail("PROJECT_BUNDLE_SOURCE_TRANSFER_INVALID");
    } else if (
      ref.proof !== "not-certified" ||
      ["bundleKey", "rawSha256", "observationId", "observationHash", "evidenceKind"].some((key) => Object.hasOwn(ref, key)) ||
      (transfer.mode === "refs-only" && ref.status !== "not-requested-body-transfer")
    )
      portableFail("PROJECT_BUNDLE_SOURCE_TRANSFER_INVALID");
  }
  return manifest;
}

// The roots are already verified exact selected Session originals. No lexical
// path extraction, transcript inference, or traversal into other Sessions.
export function selectedPortableSourceReferences(records) {
  const refs = new Map();
  for (const record of records)
    for (const ref of record.content.references.filter((ref) => ref.kind === "source")) {
      const key = portableReferenceKey(ref.path, ref.digest);
      if (!refs.has(key)) refs.set(key, { path: ref.path, digest: ref.digest, workEvidence: [] });
      if (!refs.get(key).workEvidence.some((work) => work.evidenceId === record.evidenceId))
        refs.get(key).workEvidence.push({ evidenceId: record.evidenceId, evidenceDigest: record.evidenceDigest });
    }
  return [...refs.values()]
    .sort((a, b) => portableReferenceKey(a.path, a.digest).localeCompare(portableReferenceKey(b.path, b.digest), "en"))
    .map((ref) => ({ ...ref, workEvidence: ref.workEvidence.sort((a, b) => a.evidenceId.localeCompare(b.evidenceId, "en")) }));
}

export function verifyPortableSourceReferenceClosure(manifest, records) {
  validatePortableManifestFormat(manifest);
  if (manifest.schemaVersion === 1) return;
  const expected = selectedPortableSourceReferences(records);
  const actual = manifest.sourceTransfer.references.map(({ path, digest, workEvidence }) => ({ path, digest, workEvidence }));
  if (JSON.stringify(expected) !== JSON.stringify(actual)) portableFail("PROJECT_BUNDLE_SOURCE_REFERENCE_MISMATCH");
}

export { portableFail };

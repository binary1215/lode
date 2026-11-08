import fs from "node:fs";
import path from "node:path";
import { safeSnapshotPath } from "./snapshot-storage-codec.mjs";
import { comparePublicationVersions } from "./semantic-version.mjs";
import { failCode as fail } from "./core/errors.mjs";

const installedVersion = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
export const STORAGE_READER_VERSION = Object.freeze({
  installed: installedVersion,
  readsLayouts: ["whole", "domain-bundles-v1", "shared-domains-v2", "chunked-code-v3"],
  minimumWriterUnderstood: "0.3.0-beta.75",
});

// Physical reader capabilities only. A declared-supported hint is neither an
// integrity check nor evidence that the snapshot is current or semantically fit.
export function snapshotReaderRequirements(entry) {
  if (!entry?.document) return null;
  const layout = entry.snapshotStorage?.layout || "whole";
  if (!["whole", "domain-bundles-v1", "shared-domains-v2", "chunked-code-v3"].includes(layout)) return null;
  return {
    version: 1,
    snapshotId: entry.document.worldModelId || entry.document.graphSnapshotId,
    minimumReader: STORAGE_READER_VERSION.minimumWriterUnderstood,
    writer: installedVersion,
    layout,
    ...(layout === "whole"
      ? {}
      : {
          composition: {
            kind: "SnapshotComposition",
            schemaVersion: layout === "chunked-code-v3" ? 3 : layout === "shared-domains-v2" ? 2 : 1,
            producer: { name: "lode-domain-bundle", version: layout === "chunked-code-v3" ? "0.3.0" : layout === "shared-domains-v2" ? "0.2.0" : "0.1.0" },
          },
        }),
  };
}
function readPointer(root, file) {
  safeSnapshotPath(root, file);
  const before = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 256 * 1024) fail("STORAGE_POINTER_UNAVAILABLE");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.size > 256 * 1024
    )
      fail("STORAGE_POINTER_CHANGED");
    // The descriptor may grow after fstat. Never let readFileSync allocate from
    // its later size: consume at most the observed length plus one sentinel.
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const n = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!n) break;
      length += n;
    }
    const raw = buffer.subarray(0, length),
      after = fs.fstatSync(fd),
      named = fs.lstatSync(file);
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.nlink !== 1 ||
      raw.length !== before.size ||
      [after, named].some(
        (stat) =>
          stat.dev !== opened.dev || stat.ino !== opened.ino || stat.size !== opened.size || stat.mtimeMs !== opened.mtimeMs || stat.ctimeMs !== opened.ctimeMs,
      )
    )
      fail("STORAGE_POINTER_CHANGED");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } finally {
    fs.closeSync(fd);
  }
}
export function inspectStorageReaderCompatibility({ root, storage, verifyWorldPointer, verifyGraphPointer }) {
  const layers = [];
  for (const [layer, directory, field, verify] of [
    ["world", "world-model", "worldModelId", verifyWorldPointer],
    ["graph", "graph-projection", "graphSnapshotId", verifyGraphPointer],
  ]) {
    try {
      const pointer = readPointer(root, path.join(root, storage.directory, directory, "current.json"));
      if (!pointer) {
        layers.push({ layer, state: "absent" });
        continue;
      }
      verify(pointer);
      const requirements = pointer.readerRequirements;
      if (requirements === undefined) {
        layers.push({ layer, state: "not-inspected", snapshotId: pointer[field], reasonCode: "READER_REQUIREMENTS_NOT_RECORDED" });
        continue;
      }
      if (!requirements || requirements.version !== 1 || requirements.snapshotId !== pointer[field] || typeof requirements.layout !== "string")
        fail("INVALID_READER_REQUIREMENTS");
      let supported = requirements.layout === "whole" && requirements.composition === undefined;
      if (["domain-bundles-v1", "shared-domains-v2", "chunked-code-v3"].includes(requirements.layout)) {
        const c = requirements.composition,
          chunked = requirements.layout === "chunked-code-v3",
          flat = requirements.layout === "shared-domains-v2";
        if (
          !c ||
          typeof c !== "object" ||
          !Number.isInteger(c.schemaVersion) ||
          typeof c.producer?.name !== "string" ||
          typeof c.producer?.version !== "string"
        )
          fail("INVALID_READER_REQUIREMENTS");
        supported =
          c.kind === "SnapshotComposition" &&
          c.schemaVersion === (chunked ? 3 : flat ? 2 : 1) &&
          c.producer.name === "lode-domain-bundle" &&
          c.producer.version === (chunked ? "0.3.0" : flat ? "0.2.0" : "0.1.0");
      }
      const requiredVersion = requirements.minimumReader ?? null;
      let versionSupported = false;
      try {
        versionSupported = typeof requiredVersion === "string" && comparePublicationVersions(installedVersion, requiredVersion) >= 0;
      } catch {
        /* A malformed declaration is not permission to write this storage. */
      }
      supported = supported && versionSupported;
      layers.push({
        layer,
        state: supported ? "declared-supported" : "unsupported",
        snapshotId: pointer[field],
        requirements,
        installedVersion,
        ...(requiredVersion ? { requiredVersion } : {}),
        ...(supported
          ? {}
          : {
              reasonCode: "STORAGE_VERSION_MISMATCH",
              message: `Storage layout ${requirements.layout} needs Lode ${requiredVersion || "a newer reader"} or newer. This installation is ${installedVersion}. No files were changed.`,
            }),
      });
    } catch (error) {
      layers.push({ layer, state: "unavailable", reasonCode: error.code || "INVALID_STORAGE_POINTER" });
    }
  }
  return {
    kind: "SnapshotReaderCompatibilityProjection",
    authorityPlane: "P4",
    persisted: false,
    scope: "bounded-local-pointer-declarations-only",
    snapshotIntegrity: "not-inspected",
    freshness: "not-inspected",
    layers,
    ordinaryWorkBlocked: false,
    nextAction:
      "Read only the needed World/Graph with a reader supporting the declared layout/schema/producer. An absent hint is unknown; no setup or refresh is required for ordinary work.",
  };
}

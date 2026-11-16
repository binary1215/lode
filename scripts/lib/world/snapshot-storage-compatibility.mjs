import fs from "node:fs";
import path from "node:path";
import { safeSnapshotPath } from "./snapshot-storage-codec.mjs";
import { comparePublicationVersions } from "../core/semantic-version.mjs";
import { atomicWriteText } from "../core/fs-atomic.mjs";
import { failCode as fail } from "../core/errors.mjs";

const installedVersion = JSON.parse(fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version;
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
function compositionSupported(requirements) {
  if (!requirements || requirements.version !== 1 || typeof requirements.layout !== "string") return false;
  if (requirements.layout === "whole") return requirements.composition === undefined;
  if (!["domain-bundles-v1", "shared-domains-v2", "chunked-code-v3"].includes(requirements.layout)) return false;
  const composition = requirements.composition;
  const chunked = requirements.layout === "chunked-code-v3";
  const flat = requirements.layout === "shared-domains-v2";
  return Boolean(
    composition &&
    typeof composition === "object" &&
    composition.kind === "SnapshotComposition" &&
    composition.schemaVersion === (chunked ? 3 : flat ? 2 : 1) &&
    composition.producer?.name === "lode-domain-bundle" &&
    composition.producer?.version === (chunked ? "0.3.0" : flat ? "0.2.0" : "0.1.0"),
  );
}

// Beta.75 through the writer that recorded layout and composition but not yet
// minimumReader/writer. The layout is one this reader already verifies; the
// missing fields are pointer metadata, not a newer snapshot body.
export function legacyReaderDeclaration(requirements) {
  return Boolean(
    requirements &&
    typeof requirements === "object" &&
    !Array.isArray(requirements) &&
    !Object.hasOwn(requirements, "minimumReader") &&
    !Object.hasOwn(requirements, "writer") &&
    compositionSupported(requirements),
  );
}

function mismatchMessage({ layout, requiredVersion }) {
  const named = typeof requiredVersion === "string" && requiredVersion.length > 0;
  let relation = "This is a version mismatch, not corrupted storage.";
  if (named) {
    try {
      if (comparePublicationVersions(installedVersion, requiredVersion) < 0)
        relation = "This installation is older than the store (a downgrade). This is a version mismatch, not corrupted storage.";
    } catch {
      relation = "The declared reader version is not usable. This is a version mismatch, not corrupted storage.";
    }
  } else relation = "The pointer does not name a usable minimum reader. This is a version mismatch, not corrupted storage.";
  const need = named ? `Lode ${requiredVersion} or newer` : `a reader that understands layout ${layout}`;
  return `Storage layout ${layout} needs ${need}. This installation is ${installedVersion}. ${relation} No files were changed. Recovery: upgrade Lode to a version that can read this layout, or run world-index with that Lode to rebuild the world index from project sources. Rebuilding does not rewrite snapshot bytes this installation cannot read.`;
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
      if (["domain-bundles-v1", "shared-domains-v2", "chunked-code-v3"].includes(requirements.layout)) {
        const composition = requirements.composition;
        if (
          !composition ||
          typeof composition !== "object" ||
          !Number.isInteger(composition.schemaVersion) ||
          typeof composition.producer?.name !== "string" ||
          typeof composition.producer?.version !== "string"
        )
          fail("INVALID_READER_REQUIREMENTS");
      } else if (requirements.layout !== "whole") {
        /* Unknown layouts stay unsupported below. */
      }
      const legacy = legacyReaderDeclaration(requirements);
      const requiredVersion = Object.hasOwn(requirements, "minimumReader") ? requirements.minimumReader : null;
      let versionSupported = false;
      if (!legacy && typeof requiredVersion === "string") {
        try {
          versionSupported = comparePublicationVersions(installedVersion, requiredVersion) >= 0;
        } catch {
          /* A malformed declaration is not permission to write this storage. */
        }
      }
      const supported = (legacy || versionSupported) && compositionSupported(requirements);
      layers.push({
        layer,
        state: supported ? "declared-supported" : "unsupported",
        snapshotId: pointer[field],
        requirements,
        installedVersion,
        ...(legacy ? { legacyDeclaration: true } : {}),
        ...(requiredVersion ? { requiredVersion } : {}),
        ...(supported
          ? {}
          : {
              reasonCode: "STORAGE_VERSION_MISMATCH",
              message: mismatchMessage({ layout: requirements.layout, requiredVersion: typeof requiredVersion === "string" ? requiredVersion : null }),
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
      "Read only the needed World/Graph with a reader supporting the declared layout/schema/producer. An absent hint is unknown; no setup or refresh is required for ordinary work. A layout this reader already understands with no minimumReader is upgraded in place by the next refresh (storage GC reads it as it is and does not rewrite it); snapshot bytes stay put.",
  };
}

// Records minimumReader and writer on a beta.75-shaped pointer. Snapshot files,
// record ids, hashes and source texts are not opened or rewritten.
export async function upgradeLegacyReaderPointers({ root, storage }) {
  const { verifyWorldModelPointerOriginal } = await import("./world-model.mjs");
  const { replaceGraphPointerReaderRequirements, verifyGraphProjectionPointer } = await import("./graph-projection-adapter.mjs");
  const upgraded = [];
  // Graph first: its pointer id covers readerRequirements and therefore changes,
  // and the world pointer names that id for projection recovery.
  let graphPointerIds = null;
  for (const [layer, directory, idField, hashField] of [
    ["graph", "graph-projection", "graphSnapshotId", "graphSnapshotHash"],
    ["world", "world-model", "worldModelId", "worldModelHash"],
  ]) {
    const file = path.join(root, storage.directory, directory, "current.json");
    const pointer = readPointer(root, file);
    if (!pointer || !legacyReaderDeclaration(pointer.readerRequirements) || pointer.readerRequirements.snapshotId !== pointer[idField]) continue;
    if (layer === "world") verifyWorldModelPointerOriginal(pointer, storage.projectId);
    else verifyGraphProjectionPointer(pointer, null, storage);
    const readerRequirements = {
      ...pointer.readerRequirements,
      minimumReader: STORAGE_READER_VERSION.minimumWriterUnderstood,
      writer: installedVersion,
    };
    const next =
      layer === "graph"
        ? replaceGraphPointerReaderRequirements({ ...pointer, readerRequirements: pointer.readerRequirements }, readerRequirements, storage)
        : { ...pointer, readerRequirements };
    if (layer === "graph" && next.pointerId !== pointer.pointerId) graphPointerIds = { from: pointer.pointerId, to: next.pointerId };
    const linked = layer === "world" ? pointer.sourceAdapters?.graphProjection : null;
    if (linked && graphPointerIds && linked.pointerId === graphPointerIds.from)
      next.sourceAdapters = { ...pointer.sourceAdapters, graphProjection: { ...linked, pointerId: graphPointerIds.to } };
    if (next[idField] !== pointer[idField] || next[hashField] !== pointer[hashField]) fail("STORAGE_POINTER_CHANGED");
    atomicWriteText(file, JSON.stringify(next));
    const written = readPointer(root, file);
    if (layer === "world") verifyWorldModelPointerOriginal(written, storage.projectId);
    else verifyGraphProjectionPointer(written, null, storage);
    if (written[idField] !== pointer[idField] || written[hashField] !== pointer[hashField] || !written.readerRequirements.minimumReader)
      fail("STORAGE_POINTER_CHANGED");
    upgraded.push(layer);
  }
  // The World pointer names the Graph pointer id it was published with. When
  // that id is not the current Graph pointer's (an upgrade that stopped
  // between the two writes, or a Graph pointer upgraded by an earlier run) and
  // the Graph snapshot id and hash still agree, the link is repaired; otherwise
  // it is left for the reader to report.
  const worldFile = path.join(root, storage.directory, "world-model", "current.json");
  const graphFile = path.join(root, storage.directory, "graph-projection", "current.json");
  const world = readPointer(root, worldFile),
    graph = readPointer(root, graphFile);
  const linked = world?.sourceAdapters?.graphProjection;
  if (
    linked &&
    graph?.pointerId &&
    linked.pointerId !== graph.pointerId &&
    linked.graphSnapshotId === graph.graphSnapshotId &&
    linked.graphSnapshotHash === graph.graphSnapshotHash
  ) {
    verifyWorldModelPointerOriginal(world, storage.projectId);
    verifyGraphProjectionPointer(graph, null, storage);
    const next = { ...world, sourceAdapters: { ...world.sourceAdapters, graphProjection: { ...linked, pointerId: graph.pointerId } } };
    atomicWriteText(worldFile, JSON.stringify(next));
    const written = readPointer(root, worldFile);
    verifyWorldModelPointerOriginal(written, storage.projectId);
    if (
      written.worldModelId !== world.worldModelId ||
      written.worldModelHash !== world.worldModelHash ||
      written.sourceAdapters?.graphProjection?.pointerId !== graph.pointerId
    )
      fail("STORAGE_POINTER_CHANGED");
    upgraded.push("world-graph-link");
  }
  return { upgraded };
}

import { resolveProjectStorage } from "../../scripts/lib/project-storage-format.mjs";
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { hydrateSnapshotEntry } from "../../scripts/lib/snapshot-domain-bundles.mjs";
import { LocalJsonWorldModelStoreAdapter } from "../../scripts/lib/world-model-store.mjs";
import { LocalJsonGraphProjectionAdapter } from "../../scripts/lib/graph-projection-adapter.mjs";
import { readSnapshotFile } from "../../scripts/lib/snapshot-storage-codec.mjs";
// Test-only physical addressing. Semantic tamper tests read the logical body,
// then write a whole document with the same compression to test its verifier.
// Physical composition/part tamper tests read raw bytes directly instead.
export const worldSnapshotFile = (root, id) => new LocalJsonWorldModelStoreAdapter({ projectRoot: root, storage: resolveProjectStorage(root) }).snapshotLocation(id);
export const graphSnapshotFile = (root, id) => new LocalJsonGraphProjectionAdapter({ projectRoot: root, storage: resolveProjectStorage(root) }).snapshotLocation(id);
export const readFixtureSnapshot = file => {
  const document = readSnapshotFile(file).document;
  if (document.kind !== "SnapshotComposition") return document;
  const root = path.resolve(path.dirname(file), "../../..");
  return hydrateSnapshotEntry({ root, storage: resolveProjectStorage(root), entry: { location: file, document } }).document;
};
export const writeFixtureSnapshot = (file, document) => fs.writeFileSync(file, file.endsWith('.gz') ? zlib.gzipSync(JSON.stringify(document)) : JSON.stringify(document));

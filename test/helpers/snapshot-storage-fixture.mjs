import { resolveProjectStorage } from "../../scripts/lib/project-storage-format.mjs";
import fs from "node:fs";
import zlib from "node:zlib";
import { LocalJsonWorldModelStoreAdapter } from "../../scripts/lib/world-model-store.mjs";
import { LocalJsonGraphProjectionAdapter } from "../../scripts/lib/graph-projection-adapter.mjs";
import { readSnapshotFile } from "../../scripts/lib/snapshot-storage-codec.mjs";
// Test-only physical addressing. Tamper tests change logical document content,
// then encode the actual format so they still exercise semantic verification.
export const worldSnapshotFile = (root, id) => new LocalJsonWorldModelStoreAdapter({ projectRoot: root, storage: resolveProjectStorage(root) }).snapshotLocation(id);
export const graphSnapshotFile = (root, id) => new LocalJsonGraphProjectionAdapter({ projectRoot: root, storage: resolveProjectStorage(root) }).snapshotLocation(id);
export const readFixtureSnapshot = file => readSnapshotFile(file).document;
export const writeFixtureSnapshot = (file, document) => fs.writeFileSync(file, file.endsWith('.gz') ? zlib.gzipSync(JSON.stringify(document)) : JSON.stringify(document));

import { DOMAIN_BUNDLE_LAYOUT, createSnapshotComposition, hydrateSnapshotEntry } from "./snapshot-domain-bundles.mjs";
import { GitSnapshotStore } from "./git-snapshot-store.mjs";
import { storedSnapshotLocation, readSnapshotFile, writeStoredSnapshot, listStoredSnapshotIds } from "./snapshot-storage-codec.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { formatForVerifiedOwner } from "./project-storage-format.mjs";

export const WORLD_MODEL_STORE_ADAPTER_VERSION = "0.1.0";
export const WORLD_MODEL_STORAGE_CONTRACT = "replaceable-rebuildable-materialized-view";

const REQUIRED_METHODS = [
  "describe",
  "readPointer",
  "readSnapshot",
  "writePointer",
  "writeSnapshot",
  "listSnapshotIds",
];

const fail = (message, code = "WORLD_MODEL_STORE_ERROR") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function snapshotId(value) {
  if (typeof value !== "string" || !/^world-model-[a-f0-9]{24}$/.test(value)) {
    fail("World Model snapshot id is invalid.", "INVALID_WORLD_MODEL_ID");
  }
  return value;
}

function parseDocument(file, label) {
  try { return file.endsWith(".json.gz") ? readSnapshotFile(file).document : JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    // Corrupt encoding is a document error; operational failures keep their code.
    if (file.endsWith(".json.gz") && error.code && error.code !== "INVALID_SNAPSHOT_ENCODING") throw error;
    fail(`${label} is invalid JSON: ${error.message}`, "INVALID_WORLD_MODEL_STORE_DOCUMENT");
  }
}

export function assertWorldModelStoreAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") fail("A WorldModelStoreAdapter object is required.", "INVALID_WORLD_MODEL_STORE_ADAPTER");
  if (adapter.adapterVersion !== WORLD_MODEL_STORE_ADAPTER_VERSION) {
    fail(`WorldModelStoreAdapter version must be ${WORLD_MODEL_STORE_ADAPTER_VERSION}.`, "INCOMPATIBLE_WORLD_MODEL_STORE_ADAPTER");
  }
  for (const method of REQUIRED_METHODS) if (typeof adapter[method] !== "function") {
    fail(`WorldModelStoreAdapter is missing ${method}().`, "INVALID_WORLD_MODEL_STORE_ADAPTER");
  }
  const descriptor = adapter.describe();
  if (!descriptor || typeof descriptor.adapterKind !== "string" || !descriptor.adapterKind.trim()) {
    fail("WorldModelStoreAdapter descriptor requires adapterKind.", "INVALID_WORLD_MODEL_STORE_ADAPTER");
  }
  if (descriptor.authority !== "derived-evidence-only") {
    fail("WorldModelStoreAdapter must declare derived-evidence-only authority.", "INVALID_WORLD_MODEL_STORE_AUTHORITY");
  }
  if (descriptor.rebuildable !== true || descriptor.uniqueAuthority !== false) {
    fail("WorldModelStoreAdapter must be rebuildable and must not be unique authority.", "INVALID_WORLD_MODEL_STORE_AUTHORITY");
  }
  return adapter;
}

export class LocalJsonWorldModelStoreAdapter {
  constructor({ projectRoot, storage = null, snapshotEncoding = "gzip", snapshotLayout = "whole", bundleEncoding = "gzip", gitOptions = {} }) {
    if (typeof projectRoot !== "string" || !projectRoot.trim()) fail("Local JSON adapter requires projectRoot.", "WORLD_MODEL_STORE_ROOT_REQUIRED");
    this.projectRoot = path.resolve(projectRoot);
    this.storage = storage;
    if (!["whole", DOMAIN_BUNDLE_LAYOUT].includes(snapshotLayout)) fail("Unknown snapshot layout.", "INVALID_SNAPSHOT_LAYOUT");
    this.snapshotLayout = snapshotLayout; this.bundleEncoding = bundleEncoding;
    this.snapshotEncoding = snapshotEncoding;
    this.gitOptions = gitOptions;
    this.gitStore = () => new GitSnapshotStore({ projectRoot: this.projectRoot, storage: this.storage, ...this.gitOptions });
    this.adapterVersion = WORLD_MODEL_STORE_ADAPTER_VERSION;
  }

  describe() {
    return {
      contract: WORLD_MODEL_STORAGE_CONTRACT,
      adapterKind: this.snapshotEncoding === "git" ? "local-git-snapshot-candidate" : "local-json",
      adapterVersion: this.adapterVersion,
      authority: "derived-evidence-only",
      rebuildable: true,
      uniqueAuthority: false,
      ...(this.snapshotLayout !== "whole" ? { snapshotLayout: this.snapshotLayout } : {}),
      remote: false,
      durable: true,
    };
  }

  pointerLocation() {
    return path.join(this.projectRoot, formatForVerifiedOwner(this.storage).directory, "world-model", "current.json");
  }

  snapshotLocation(worldModelId) {
    return storedSnapshotLocation(this.projectRoot, path.join(this.projectRoot, formatForVerifiedOwner(this.storage).directory, "world-model", "snapshots", `${snapshotId(worldModelId)}.json`), this.snapshotEncoding === "git" ? "gzip" : this.snapshotEncoding);
  }

  readPointer() {
    const location = this.pointerLocation();
    if (!fs.existsSync(location)) return null;
    return { location, document: parseDocument(location, "World Model pointer") };
  }

  async readSnapshot(worldModelId) {
    const location = this.snapshotLocation(worldModelId);
    const entry = fs.existsSync(location) ? { location, document: parseDocument(location, "World Model snapshot") }
      : this.storage?.projectFile ? await this.gitStore().read(worldModelId) : null;
    return hydrateSnapshotEntry({ root: this.projectRoot, storage: this.storage, entry });
  }

  async writeSnapshot(worldModelId, document) {
    const existing = await this.readSnapshot(worldModelId);
    if (existing) return { ...existing, created: false };
    if (this.snapshotLayout === DOMAIN_BUNDLE_LAYOUT) document = createSnapshotComposition({ root: this.projectRoot, storage: this.storage, document, encoding: this.bundleEncoding }).document;
    if (this.snapshotEncoding === "git") {
      return hydrateSnapshotEntry({ root: this.projectRoot, storage: this.storage, entry: await this.gitStore().write(worldModelId, document) });
    }
    const written = writeStoredSnapshot({ root: this.projectRoot, jsonFile: path.join(this.projectRoot, formatForVerifiedOwner(this.storage).directory, "world-model", "snapshots", `${snapshotId(worldModelId)}.json`), document, encoding: this.snapshotEncoding, readDocument: file => parseDocument(file, "World Model snapshot") });
    return hydrateSnapshotEntry({ root: this.projectRoot, storage: this.storage, entry: written });
  }

  writePointer(document) {
    const location = this.pointerLocation();
    atomicWrite(location, json(document));
    return { location, document };
  }

  async listSnapshotIds() {
    const directory = path.join(this.projectRoot, formatForVerifiedOwner(this.storage).directory, "world-model", "snapshots");
    return [...new Set([...listStoredSnapshotIds(this.projectRoot, directory, "world-model"), ...(this.storage?.projectFile ? await this.gitStore().list("world-model") : [])])].sort();
  }
}

export function createWorldModelStoreAdapter({ projectRoot, adapter = null, storage = null } = {}) {
  return assertWorldModelStoreAdapter(adapter || new LocalJsonWorldModelStoreAdapter({ projectRoot, storage }));
}

// Local-only discovery never selects configured external storage or creates a store.
export function createLocalReadOnlyWorldModelStoreAdapter(options = {}) {
  const adapter = new LocalJsonWorldModelStoreAdapter(options);
  adapter.writePointer = adapter.writeSnapshot = () => fail("Historical discovery is read only.", "WORLD_MODEL_STORE_READ_ONLY");
  return adapter;
}

#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeProject } from "./lib/head-core.mjs";
import { startOnboarding } from "./lib/onboarding.mjs";
import { arcadeDbGraphReservedSchemaFor } from "./lib/graph-projection-adapter.mjs";
import { arcadeDbRequiredKeysFor } from "./lib/arcadedb-schema-contract.mjs";
import { formatForVerifiedOwner } from "./lib/project-storage-format.mjs";
import {
  initializeArcadeDbDatabase,
  inspectArcadeDbDatabaseCompatibility,
  verifyArcadeDbDatabaseCompatibilityAudit,
  verifyArcadeDbDatabaseLifecycleReceipt,
} from "./lib/arcadedb-database-lifecycle.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.join(pluginRoot, `.test-tmp-arcadedb-database-lifecycle-${process.pid}`);

class FixtureTransport {
  constructor() {
    this.exists = false;
    this.types = [];
    this.actions = [];
  }

  ready() { return true; }
  databaseExists() { return this.exists; }
  readSchemaTypes() { return structuredClone(this.types); }
  createDatabase() { this.actions.push("create"); this.exists = true; this.types = []; return true; }
  dropDatabase() { this.actions.push("drop"); this.exists = false; this.types = []; return true; }
}

function write(relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

try {
  fs.rmSync(root, { recursive: true, force: true });
  write("src/service.mjs", "export function captureImage() { return true; }\n");
  const initialized = initializeProject({ root, pluginRoot, runtimes: ["codex", "opencode"] });
  const storage = initialized.storage;
  const format = formatForVerifiedOwner(initialized.storage);
  const reservedSchema = arcadeDbGraphReservedSchemaFor(initialized.storage);
  const requiredKeys = arcadeDbRequiredKeysFor(initialized.storage);
  await startOnboarding({
    root,
    mode: "existing",
    storage: {
      mode: "graphdb",
      endpoint: "https://fixture.invalid",
      database: "fixturedb",
      secretReferenceNames: { username: "HEAD_GRAPHDB_USERNAME", password: "HEAD_GRAPHDB_PASSWORD" },
    },
  });

  const transport = new FixtureTransport();
  const missing = verifyArcadeDbDatabaseCompatibilityAudit(inspectArcadeDbDatabaseCompatibility({ root, transport, storage }));
  assert.equal(missing.status, "database-missing");
  assert.equal(missing.canActivateWithoutReset, false);
  assert.equal(JSON.stringify(missing).includes("fixturedb"), false);
  assert.equal(JSON.stringify(missing).includes("fixture.invalid"), false);

  const created = initializeArcadeDbDatabase({ root, transport, storage });
  verifyArcadeDbDatabaseLifecycleReceipt(created.receipt);
  assert.equal(created.action, "created-missing-database");
  assert.deepEqual(transport.actions, ["create"]);
  assert.equal(created.after.status, "compatible-empty-reserved-schema");

  transport.types = [{ name: "UnrelatedProductData", type: "document", properties: [] }];
  const shared = inspectArcadeDbDatabaseCompatibility({ root, transport, storage });
  assert.equal(shared.status, "compatible-empty-reserved-schema");
  assert.equal(shared.unrelatedTypeCount, 1);

  transport.types.push({ name: format.kind("HeadAgentGraphNode"), type: "vertex", properties: [{ name: "projectId", type: "STRING" }], indexes: [] });
  const partial = inspectArcadeDbDatabaseCompatibility({ root, transport, storage });
  assert.equal(partial.status, "compatible-partial-reserved-schema");
  assert.equal(partial.conflicts.length, 0);

  transport.types[1] = { name: format.kind("HeadAgentGraphNode"), type: "document", properties: [] };
  const incompatible = inspectArcadeDbDatabaseCompatibility({ root, transport, storage });
  assert.equal(incompatible.status, "incompatible-reserved-schema");
  assert.equal(incompatible.resetEligible, true);
  assert.throws(
    () => initializeArcadeDbDatabase({ root, transport, storage }),
    (error) => error.code === "ARCADEDB_DATABASE_RESET_CONFIRMATION_REQUIRED",
  );
  assert.throws(
    () => initializeArcadeDbDatabase({ root, transport, storage, resetIncompatible: true, confirmDatabase: "wrong" }),
    (error) => error.code === "ARCADEDB_DATABASE_RESET_TARGET_MISMATCH",
  );
  const reset = initializeArcadeDbDatabase({ root, transport, storage, resetIncompatible: true, confirmDatabase: "fixturedb" });
  assert.equal(reset.action, "reset-incompatible-database");
  assert.deepEqual(transport.actions, ["create", "drop", "create"]);
  assert.equal(reset.after.status, "compatible-empty-reserved-schema");
  assert.equal(JSON.stringify(reset).includes("fixturedb"), false);

  transport.types = reservedSchema.map((type) => ({ name: type.name, type: type.type,
    properties: Object.entries(type.properties).map(([name, type]) => ({ name, type })), indexes: [] }));
  const noIndexes = inspectArcadeDbDatabaseCompatibility({ root, transport, storage });
  assert.equal(noIndexes.status, "compatible-partial-reserved-schema");
  assert.equal(noIndexes.canActivateNow, false);
  assert.equal(noIndexes.missingIndexCount, 9);
  for (const type of transport.types) type.indexes = [{ properties: [...requiredKeys[type.name]], unique: true }];
  const complete = inspectArcadeDbDatabaseCompatibility({ root, transport, storage });
  assert.equal(complete.canActivateNow, true);
  assert.notEqual(complete.auditHash, noIndexes.auditHash);
  transport.types[0].indexes.push({ properties: ["projectId"], unique: true, status: "ONLINE" });
  const extraA = inspectArcadeDbDatabaseCompatibility({ root, transport, storage });
  transport.types[0].indexes[1].properties = ["graphSnapshotId"];
  const extraB = inspectArcadeDbDatabaseCompatibility({ root, transport, storage });
  assert.equal(extraA.status, "incompatible-reserved-schema");
  assert.equal(extraB.status, "incompatible-reserved-schema");
  assert.notEqual(extraA.auditHash, extraB.auditHash);
  transport.types[0].indexes.reverse();
  assert.equal(inspectArcadeDbDatabaseCompatibility({ root, transport, storage }).auditHash, extraB.auditHash);
  transport.types[0].indexes = [{ properties: [...requiredKeys[transport.types[0].name]], unique: true }];
  transport.types[0].properties[0].min = 1;
  const minA = inspectArcadeDbDatabaseCompatibility({ root, transport, storage });
  transport.types[0].properties[0].min = 2;
  assert.notEqual(inspectArcadeDbDatabaseCompatibility({ root, transport, storage }).auditHash, minA.auditHash);
  delete transport.types[0].properties[0].min;
  transport.types[0].indexes[0].unique = false;
  const nonUnique = inspectArcadeDbDatabaseCompatibility({ root, transport, storage });
  assert.equal(nonUnique.status, "incompatible-reserved-schema");
  assert.notEqual(nonUnique.auditHash, complete.auditHash);
  delete transport.types[0].indexes;
  const unknown = inspectArcadeDbDatabaseCompatibility({ root, transport, storage });
  assert.equal(unknown.status, "unverifiable-reserved-schema");
  assert.equal(unknown.resetEligible, false);
  assert.throws(() => initializeArcadeDbDatabase({ root, transport, storage, resetIncompatible: true, confirmDatabase: "fixturedb" }), { code: "ARCADEDB_SCHEMA_UNVERIFIED" });
  assert.deepEqual(transport.actions, ["create", "drop", "create"], "inspection performs no DDL");

  process.stdout.write(`${JSON.stringify({
    status: "arcadedb_database_lifecycle_verified",
    scenarios: ["missing-create", "unrelated-data-coexistence", "partial-compatible", "reserved-name-conflict", "exact-target-reset", "missing-unique-index", "nonunique-conflict", "unknown-not-reset", "index-bound-audit"],
    credentialsPersisted: false,
    targetValuePersisted: false,
    authorityEffect: "none",
  }, null, 2)}\n`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

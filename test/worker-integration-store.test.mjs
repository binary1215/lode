import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { workerIntegrationDirectory, publishIntegrationJson, readIntegrationBytes } from "../scripts/lib/worker/worker-integration-store.mjs";

function fixture(t) {
  const parent = fs.realpathSync(process.env.HEAD_AGENT_TEST_TMP || os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, "worker-integration-store-"));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.match(path.basename(root), /^worker-integration-store-/);
    fs.rmSync(root, { recursive: true });
  });
  return root;
}

test("create-only integration publication converges without rewriting or broad authority", (t) => {
  const directory = workerIntegrationDirectory(fixture(t), true);
  const file = path.join(directory, "evidence.json");
  const value = { evidence: "synthetic", applied: false };
  assert.equal(publishIntegrationJson(file, value), true);
  const before = fs.statSync(file);
  assert.equal(publishIntegrationJson(file, value), false);
  assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
  assert.deepEqual(JSON.parse(readIntegrationBytes(file)), value);
  assert.throws(() => publishIntegrationJson(file, { evidence: "different" }), { code: "WORKER_INTEGRATION_STORAGE_CONFLICT" });
});

test("complete or partial pending publication recovers without changing earlier pending bytes", (t) => {
  const directory = workerIntegrationDirectory(fixture(t), true);
  const file = path.join(directory, "evidence.json");
  const value = { evidence: "pending" };
  fs.writeFileSync(`${file}.pending`, `${JSON.stringify(value)}\n`);
  assert.equal(publishIntegrationJson(file, value), true);
  const other = path.join(directory, "partial.json");
  fs.writeFileSync(`${other}.pending`, '{"partial"');
  assert.equal(publishIntegrationJson(other, value), true);
  assert.deepEqual(JSON.parse(readIntegrationBytes(other)), value);
  assert.equal(fs.readFileSync(`${other}.pending`, "utf8"), '{"partial"');
});

test("crash after fresh recovery link preserves a recognized readable alias", (t) => {
  const directory = workerIntegrationDirectory(fixture(t), true);
  const file = path.join(directory, "evidence.json");
  fs.writeFileSync(`${file}.pending`, "partial prior write");
  const unlink = fs.unlinkSync;
  fs.unlinkSync = (target) => {
    if (String(target).startsWith(`${file}.pending--`)) throw Object.assign(new Error("fixture unlink crash"), { code: "EIO" });
    return unlink(target);
  };
  const value = { evidence: "recover-link" };
  try {
    assert.throws(() => publishIntegrationJson(file, value), { code: "EIO" });
  } finally {
    fs.unlinkSync = unlink;
  }
  assert.deepEqual(JSON.parse(readIntegrationBytes(file)), value);
  assert.equal(publishIntegrationJson(file, value), false);
  assert.equal(fs.readFileSync(`${file}.pending`, "utf8"), "partial prior write");
});

test("exact interrupted publication alias is readable; arbitrary hardlink is not", (t) => {
  const directory = workerIntegrationDirectory(fixture(t), true);
  const file = path.join(directory, "evidence.json");
  const bytes = '{"evidence":"historical"}\n';
  fs.writeFileSync(`${file}.pending`, bytes);
  fs.linkSync(`${file}.pending`, file);
  assert.equal(readIntegrationBytes(file).toString(), bytes);
  assert.equal(publishIntegrationJson(file, JSON.parse(bytes)), false);
  assert.equal(fs.existsSync(`${file}.pending`), true, "read/reuse never cleans someone else's pending name");
  fs.renameSync(`${file}.pending`, `${file}.unrecognized`);
  assert.throws(() => readIntegrationBytes(file), { code: "WORKER_INTEGRATION_STORAGE_CONFLICT" });
});

test("flushing failure publishes nothing and complete bytes remain recoverable", (t) => {
  const directory = workerIntegrationDirectory(fixture(t), true);
  const file = path.join(directory, "evidence.json");
  const value = { evidence: "flush-boundary" };
  const fsync = fs.fsyncSync;
  fs.fsyncSync = () => {
    throw Object.assign(new Error("fixture flush failure"), { code: "EIO" });
  };
  try {
    assert.throws(() => publishIntegrationJson(file, value), { code: "EIO" });
  } finally {
    fs.fsyncSync = fsync;
  }
  assert.equal(fs.existsSync(file), false);
  assert.equal(publishIntegrationJson(file, value), true);
});

test("distinct 64-bit file identities do not collide with a retained prior pending file", (t) => {
  const directory = workerIntegrationDirectory(fixture(t), true);
  const file = path.join(directory, "evidence.json"),
    oldPending = `${file}.pending`;
  const pending = `${file}.pending--00000000-0000-0000-0000-000000000000`;
  const bytes = '{"evidence":"exact-current-publication"}\n';
  fs.writeFileSync(oldPending, "retained interrupted earlier receipt");
  fs.writeFileSync(pending, bytes);
  fs.linkSync(pending, file);
  const lstat = fs.lstatSync;
  assert.notEqual(lstat(oldPending, { bigint: true }).ino, lstat(pending, { bigint: true }).ino);
  // Deterministic Number precision-loss counterexample, independent of the
  // filesystem's currently assigned inode values. Exact bigint stats are real.
  fs.lstatSync = function (target, options) {
    const stat = lstat.call(this, target, options);
    if (!options?.bigint && [file, oldPending, pending].includes(target)) stat.ino = 2 ** 60;
    return stat;
  };
  try {
    assert.equal(readIntegrationBytes(file).toString(), bytes);
  } finally {
    fs.lstatSync = lstat;
  }
  assert.equal(fs.readFileSync(oldPending, "utf8"), "retained interrupted earlier receipt");
  assert.equal(fs.existsSync(pending), true, "Read-only recovery does not clean either pending record");
});

test("pending replacement between comparison and reopen cannot publish different bytes as success", (t) => {
  const directory = workerIntegrationDirectory(fixture(t), true);
  const file = path.join(directory, "evidence.json");
  const value = { evidence: "expected" };
  fs.writeFileSync(`${file}.pending`, `${JSON.stringify(value)}\n`);
  const open = fs.openSync;
  let replaced = false;
  fs.openSync = (target, flags, ...args) => {
    if (!replaced && target === `${file}.pending` && flags === (fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0))) {
      replaced = true;
      fs.writeFileSync(target, '{"evidence":"external"}\n');
    }
    return open(target, flags, ...args);
  };
  try {
    assert.throws(() => publishIntegrationJson(file, value), { code: "WORKER_INTEGRATION_STORAGE_CONFLICT" });
  } finally {
    fs.openSync = open;
  }
  assert.equal(replaced, true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(`${file}.pending`, "utf8"), '{"evidence":"external"}\n');
});

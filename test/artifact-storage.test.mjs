import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { atomicWriteArtifact, atomicCreateArtifact } from "../scripts/lib/artifact-storage.mjs";

function fixture(t, prefix = "head-C-atomic-") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith(prefix));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
test("atomic publication preserves the existing winner on exclusive retry and cleans failed staging", (t) => {
  const root = fixture(t, "head-storage-");
  const file = path.join(root, "record.json");
  atomicCreateArtifact(file, "original");
  assert.throws(() => atomicCreateArtifact(file, "divergent"), { code: "EEXIST" });
  assert.equal(fs.readFileSync(file, "utf8"), "original");
  assert.deepEqual(fs.readdirSync(root), ["record.json"]);
  atomicWriteArtifact(file, "next");
  assert.equal(fs.readFileSync(file, "utf8"), "next");
  const blocked = path.join(root, "directory");
  fs.mkdirSync(blocked);
  assert.throws(() => atomicWriteArtifact(blocked, "must not publish"));
  assert.deepEqual(fs.readdirSync(root).sort(), ["directory", "record.json"]);
});

test("Windows rename retry is finite and never overwrites a changed target", { skip: process.platform !== "win32" }, (t) => {
  const root = fixture(t, "head-storage-retry-");
  const file = path.join(root, "record.json"),
    rename = fs.renameSync,
    lstat = fs.lstatSync;
  const denied = () => Object.assign(new Error("temporary sharing denial"), { code: "EPERM" });
  fs.writeFileSync(file, "original");
  try {
    let calls = 0;
    fs.renameSync = (...args) => {
      if (++calls === 1) throw denied();
      return rename(...args);
    };
    atomicWriteArtifact(file, "next");
    assert.equal(calls, 2);
    assert.equal(fs.readFileSync(file, "utf8"), "next");
    calls = 0;
    fs.renameSync = () => {
      calls += 1;
      throw denied();
    };
    assert.throws(() => atomicWriteArtifact(file, "unpublished"), { code: "EPERM" });
    assert.equal(calls, 5);
    assert.equal(fs.readFileSync(file, "utf8"), "next");
    calls = 0;
    fs.renameSync = () => {
      calls += 1;
      fs.writeFileSync(file, "concurrent user edit");
      throw denied();
    };
    assert.throws(() => atomicWriteArtifact(file, "must not overwrite"), { code: "EPERM" });
    assert.equal(calls, 1);
    assert.equal(fs.readFileSync(file, "utf8"), "concurrent user edit");
    assert.deepEqual(fs.readdirSync(root), ["record.json"]);
    calls = 0;
    let inspectionBlocked = false;
    fs.lstatSync = (target, ...args) => {
      if (inspectionBlocked && target === file) throw Object.assign(new Error("cannot inspect target"), { code: "EACCES" });
      return lstat(target, ...args);
    };
    fs.renameSync = () => {
      calls += 1;
      inspectionBlocked = true;
      throw denied();
    };
    assert.throws(
      () => atomicWriteArtifact(file, "unknown comparison cannot retry"),
      (error) => error.code === "EPERM" && error.retryInspection.code === "EACCES",
    );
    assert.equal(calls, 1);
    assert.equal(fs.readFileSync(file, "utf8"), "concurrent user edit");
    fs.lstatSync = lstat;
    assert.deepEqual(fs.readdirSync(root), ["record.json"]);
    calls = 0;
    fs.renameSync = (source) => {
      calls += 1;
      fs.writeFileSync(source, "changed staging");
      throw denied();
    };
    assert.throws(
      () => atomicWriteArtifact(file, "must remain unpublished"),
      (error) => error.code === "EPERM" && error.stagingCleanup.code === "ARTIFACT_STAGING_CHANGED",
    );
    assert.equal(calls, 1);
    assert.equal(fs.readFileSync(file, "utf8"), "concurrent user edit");
    const preserved = fs.readdirSync(root).find((name) => name.endsWith(".tmp"));
    assert.equal(fs.readFileSync(path.join(root, preserved), "utf8"), "changed staging");
  } finally {
    fs.renameSync = rename;
    fs.lstatSync = lstat;
  }
});

test("failed partial write cleans the staging inode owned before writing", (t) => {
  const directory = fixture(t),
    destination = path.join(directory, "record.json");
  const write = fs.writeFileSync;
  fs.writeFileSync = (target, content, options) => {
    if (typeof target === "number") {
      write(target, String(content).slice(0, 4), options);
      throw Object.assign(new Error("Partial write failure"), { code: "EIO" });
    }
    return write(target, content, options);
  };
  try {
    assert.throws(() => atomicCreateArtifact(destination, "complete original"), { code: "EIO" });
  } finally {
    fs.writeFileSync = write;
  }
  assert.deepEqual(fs.readdirSync(directory), []);
});
test("a replaced staging file is preserved because its inode is not owned", (t) => {
  const directory = fixture(t),
    destination = path.join(directory, "record.json");
  const write = fs.writeFileSync,
    open = fs.openSync;
  let temporary;
  fs.openSync = (file, ...args) => {
    if (String(file).endsWith(".tmp")) temporary = file;
    return open(file, ...args);
  };
  fs.writeFileSync = (target, content, options) => {
    if (typeof target === "number") {
      write(target, "partial", options);
      fs.renameSync(temporary, path.join(directory, "held-owned-partial"));
      write(temporary, "replacement owned by someone else");
      throw Object.assign(new Error("Write failure after replacement"), { code: "EIO" });
    }
    return write(target, content, options);
  };
  try {
    assert.throws(
      () => atomicCreateArtifact(destination, "complete original"),
      (error) => error.code === "EIO" && error.stagingCleanup?.code === "ARTIFACT_STAGING_CHANGED",
    );
  } finally {
    fs.writeFileSync = write;
    fs.openSync = open;
  }
  assert.equal(fs.readFileSync(temporary, "utf8"), "replacement owned by someone else");
  assert.equal(fs.existsSync(destination), false);
});
test("failed publication preserves the original destination and removes only its owned stage", (t) => {
  const directory = fixture(t),
    destination = path.join(directory, "record.json");
  fs.writeFileSync(destination, "original");
  const rename = fs.renameSync;
  fs.renameSync = () => {
    throw Object.assign(new Error("Publication failure"), { code: "EIO" });
  };
  try {
    assert.throws(() => atomicWriteArtifact(destination, "new record"), { code: "EIO" });
  } finally {
    fs.renameSync = rename;
  }
  assert.deepEqual(fs.readdirSync(directory), ["record.json"]);
  assert.equal(fs.readFileSync(destination, "utf8"), "original");
});

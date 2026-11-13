import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withProjectMutation, withProjectMutationAsync } from "../scripts/lib/storage/project-mutation-lock.mjs";
import { formatForVerifiedOwner } from "../scripts/lib/storage/project-storage-format.mjs";
import { withLocalMutation, withLocalMutationAsync, mutationCleanupFailure } from "../scripts/lib/storage/local-mutation-lock.mjs";

// Synthetic fault injection exercises the outcome contract, not the unknown
// Windows cause. All paths and retained owners belong to this temporary fixture.
for (const mode of ["local-sync", "local-async", "project-sync", "project-async"]) {
  for (const site of ["unlink-before", "unlink-after", "rmdir"]) {
    test(`${mode} preserves one operation and classifies ${site} cleanup failure`, async (t) => {
      const { root, directory } = fixture(t);
      const run = (operation) =>
        mode === "local-sync"
          ? withLocalMutation({ directory, timeoutMs: 0 }, operation)
          : mode === "local-async"
            ? withLocalMutationAsync({ directory, timeoutMs: 0 }, operation)
            : runners[mode === "project-sync" ? "sync" : "async"](root, operation);
      const originalUnlink = fs.unlinkSync;
      const originalRmdir = fs.rmdirSync;
      let effects = 0,
        cleanups = 0;
      let ownerFile;
      t.mock.method(fs, "unlinkSync", (file, ...args) => {
        if (path.dirname(String(file)) !== directory) return originalUnlink(file, ...args);
        ownerFile = file;
        cleanups += 1;
        if (site === "unlink-after") originalUnlink(file, ...args);
        if (site !== "rmdir") throw Object.assign(new Error("fixture owner unlink"), { code: "UNKNOWN" });
        return originalUnlink(file, ...args);
      });
      t.mock.method(fs, "rmdirSync", (entry, ...args) => {
        if (entry === directory && site === "rmdir") throw Object.assign(new Error("fixture shell cleanup"), { code: "UNKNOWN" });
        return originalRmdir(entry, ...args);
      });
      let observed;
      await assert.rejects(
        async () =>
          run(() => {
            effects += 1;
            return { secretBody: "never-serialize", claim: { token: "private-token" } };
          }),
        (error) => {
          observed = error;
          return error.code === "LOCAL_MUTATION_CLEANUP_FAILED";
        },
      );
      assert.equal(effects, 1);
      assert.equal(observed.operationReturned, true);
      assert.equal(observed.cleanup.ownerReleased, site !== "unlink-before");
      assert.equal(mutationCleanupFailure(observed).operationReturned, true);
      assert.equal(mutationCleanupFailure(observed).result.secretBody, "never-serialize");
      assert.doesNotMatch(JSON.stringify(observed), /never-serialize|private-token/);
      assert.equal(cleanups, site === "unlink-before" ? 3 : 1);
      if (site === "unlink-before") {
        assert.ok(fs.existsSync(ownerFile));
        await assert.rejects(async () => withLocalMutation({ directory, timeoutMs: 0 }, () => effects++), { code: "PROJECT_MUTATION_BUSY" });
        assert.equal(effects, 1);
      }
      t.mock.restoreAll();
    });
  }
  for (const thrown of ["primitive", Object.freeze(new Error("frozen original"))]) {
    test(`${mode} cleanup never masks ${typeof thrown} original throw`, async (t) => {
      const { root, directory } = fixture(t);
      const originalUnlink = fs.unlinkSync;
      t.mock.method(fs, "unlinkSync", (file, ...args) => {
        if (path.dirname(String(file)) === directory) throw Object.assign(new Error("fixture cleanup"), { code: "UNKNOWN" });
        return originalUnlink(file, ...args);
      });
      const run = (operation) =>
        mode === "local-sync"
          ? withLocalMutation({ directory }, operation)
          : mode === "local-async"
            ? withLocalMutationAsync({ directory }, operation)
            : runners[mode === "project-sync" ? "sync" : "async"](root, operation);
      let effects = 0;
      try {
        await run(() => {
          effects++;
          throw thrown;
        });
        assert.fail("expected original throw");
      } catch (error) {
        assert.equal(error, thrown);
      }
      assert.equal(effects, 1);
      t.mock.restoreAll();
    });
  }
}

const host = crypto.createHash("sha256").update(os.hostname()).digest("hex").slice(0, 16);
const deadPid = 99999999;
const nameFor = (pid, ownerHost = host) => `owner-${ownerHost}-${pid}-${"a".repeat(32)}.json`;

function fixture(t, layout = { dialect: "head", directory: ".head" }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "head-lock-read-")));
  const parent = path.join(root, layout.directory, ".operations");
  fs.mkdirSync(parent, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, parent, directory: path.join(parent, "session-recovery.lock") };
}

const runners = {
  sync: (root, operation, storage) => withProjectMutation({ root, scope: "session-recovery", storage }, operation),
  async: (root, operation, storage) => withProjectMutationAsync({ root, scope: "session-recovery", storage }, operation),
};

test("pre-operation stale recovery remains fail-closed on unlink failure", (t) => {
  const { directory } = fixture(t);
  fs.mkdirSync(directory);
  const file = path.join(directory, nameFor(deadPid));
  fs.writeFileSync(file, "owned synthetic stale fixture");
  const originalKill = process.kill;
  t.mock.method(process, "kill", (pid, ...args) => {
    if (pid === deadPid) throw Object.assign(new Error("fixture process absent"), { code: "ESRCH" });
    return originalKill(pid, ...args);
  });
  const originalUnlink = fs.unlinkSync;
  const denied = Object.assign(new Error("fixture recovery unlink"), { code: "UNKNOWN" });
  t.mock.method(fs, "unlinkSync", (entry, ...args) => {
    if (entry === file) throw denied;
    return originalUnlink(entry, ...args);
  });
  let effects = 0;
  assert.throws(
    () => withLocalMutation({ directory, timeoutMs: 0 }, () => effects++),
    (error) => error === denied,
  );
  assert.equal(effects, 0);
  assert.equal(mutationCleanupFailure(denied), null);
  assert.ok(fs.existsSync(file));
  t.mock.restoreAll();
});

test("transient exact-owner cleanup retry returns the original value without repeating operation", (t) => {
  const { directory } = fixture(t);
  const originalUnlink = fs.unlinkSync;
  let cleanups = 0,
    effects = 0;
  t.mock.method(fs, "unlinkSync", (entry, ...args) => {
    if (path.dirname(String(entry)) === directory && ++cleanups === 1) throw Object.assign(new Error("fixture transient cleanup"), { code: "UNKNOWN" });
    return originalUnlink(entry, ...args);
  });
  const value = Object.freeze({ fixture: true });
  assert.equal(
    withLocalMutation({ directory }, () => {
      effects++;
      return value;
    }),
    value,
  );
  assert.equal(effects, 1);
  assert.equal(cleanups, 2);
  assert.equal(fs.existsSync(directory), false);
  t.mock.restoreAll();
});

for (const mode of ["replaced-owner", "unreadable-namespace"]) {
  test(`completed operation cleanup preserves ${mode}`, (t) => {
    const { root, directory } = fixture(t);
    let ownerFile, replacement;
    let effects = 0;
    const originalStat = fs.lstatSync;
    const originalUnlink = fs.unlinkSync;
    let removals = 0;
    t.mock.method(fs, "unlinkSync", (entry, ...args) => {
      if (path.dirname(String(entry)) === directory) removals++;
      return originalUnlink(entry, ...args);
    });
    assert.throws(
      () =>
        withLocalMutation({ directory, timeoutMs: 0 }, () => {
          effects++;
          ownerFile = path.join(directory, fs.readdirSync(directory)[0]);
          if (mode === "replaced-owner") {
            // Keep the old inode alive so the synthetic replacement cannot reuse it.
            fs.renameSync(ownerFile, path.join(root, "original-owner"));
            fs.writeFileSync(ownerFile, "replacement fixture owner");
            replacement = fs.readFileSync(ownerFile, "utf8");
          } else {
            t.mock.method(fs, "lstatSync", (entry, ...args) => {
              if (entry === path.dirname(directory)) throw Object.assign(new Error("fixture namespace read denied"), { code: "EACCES" });
              return originalStat(entry, ...args);
            });
          }
          return "completed fixture";
        }),
      { code: "LOCAL_MUTATION_CLEANUP_FAILED" },
    );
    assert.equal(effects, 1);
    assert.equal(removals, 0);
    t.mock.restoreAll();
    assert.ok(fs.existsSync(ownerFile));
    if (replacement) assert.equal(fs.readFileSync(ownerFile, "utf8"), replacement);
  });
}

// Fault injection proves the read/error contract, not an actual Windows ACL or
// the unproven OS cause of the original real 8-process enumeration failure.
for (const [mode, run] of Object.entries(runners)) {
  for (const code of ["EPERM", "EACCES"]) {
    for (const site of ["parent", "lock", "staging"]) {
      for (const sustained of [false, true]) {
        test(`${mode} ${site} enumeration ${code}: ${sustained ? "sustained denial" : "transient read"}`, async (t) => {
          const { root, parent, directory } = fixture(t);
          let target = parent;
          if (site === "lock") {
            target = directory;
            fs.mkdirSync(target);
          }
          if (site === "staging") {
            target = path.join(parent, `.session-recovery.lock-${nameFor(deadPid)}.staging`);
            fs.mkdirSync(target);
            fs.writeFileSync(path.join(target, nameFor(deadPid)), "dead fixture owner");
          }
          const originalRead = fs.readdirSync;
          const originalKill = process.kill;
          let reads = 0;
          let effects = 0;
          const denied = Object.assign(new Error("injected initial lock read denial"), { code, syscall: "scandir", path: target, cause: "fixture" });
          fs.readdirSync = (entry, ...args) => {
            if (entry === target && (sustained || reads === 0)) {
              reads += 1;
              // Later errors intentionally differ: preserve the original.
              if (reads === 1) throw denied;
              throw Object.assign(new Error("later injected denial"), { code });
            }
            if (entry === target) reads += 1;
            return originalRead(entry, ...args);
          };
          process.kill = (pid, ...args) => {
            if (pid === deadPid) throw Object.assign(new Error("dead fixture PID"), { code: "ESRCH" });
            return originalKill(pid, ...args);
          };
          try {
            if (sustained) {
              await assert.rejects(
                async () => run(root, () => ++effects),
                (error) => error === denied && error.code === code && error.cause === "fixture",
              );
              assert.equal(reads, 6, "Read retries must be finite, not a busy-loop until success.");
              assert.equal(effects, 0);
            } else {
              assert.equal(await run(root, () => ++effects), 1);
              assert.equal(effects, 1);
              assert.ok(reads >= 2);
              assert.deepEqual(originalRead(parent), []);
            }
          } finally {
            fs.readdirSync = originalRead;
            process.kill = originalKill;
          }
        });
      }
    }

    test(`${mode} path validation repeats after ${code} and rejects an unsafe replacement`, async (t) => {
      const { root, directory } = fixture(t);
      fs.mkdirSync(directory);
      const originalRead = fs.readdirSync;
      const originalStat = fs.lstatSync;
      let denied = false;
      let effects = 0;
      fs.readdirSync = (entry, ...args) => {
        if (entry === directory && !denied) {
          denied = true;
          throw Object.assign(new Error("injected read contention"), { code });
        }
        return originalRead(entry, ...args);
      };
      fs.lstatSync = (entry, ...args) =>
        entry === directory && denied ? { isDirectory: () => false, isSymbolicLink: () => false } : originalStat(entry, ...args);
      try {
        await assert.rejects(async () => run(root, () => ++effects), { code: "INVALID_PROJECT_MUTATION_LOCK" });
        assert.equal(effects, 0);
      } finally {
        fs.readdirSync = originalRead;
        fs.lstatSync = originalStat;
      }
    });

    test(`${mode} ${code} thrown after effect is never retried`, async (t) => {
      const { root, parent } = fixture(t);
      const error = Object.assign(new Error("effect already happened"), { code });
      let effects = 0;
      await assert.rejects(
        async () =>
          run(root, () => {
            effects += 1;
            throw error;
          }),
        (observed) => observed === error,
      );
      assert.equal(effects, 1);
      assert.deepEqual(fs.readdirSync(parent), []);
    });
  }

  test(`${mode} unsafe paths and unexpected entries fail without invoking effect`, async (t) => {
    for (const layout of [
      { dialect: "head", directory: ".head" },
      { dialect: "lode", directory: ".lode" },
    ]) {
      for (const site of ["head", "parent", "lock", "entry"]) {
        const { root, parent, directory } = fixture(t, layout);
        if (site === "head") {
          fs.rmdirSync(parent);
          fs.rmdirSync(path.dirname(parent));
          fs.writeFileSync(path.dirname(parent), "unsafe");
        }
        if (site === "parent") {
          fs.rmdirSync(parent);
          fs.writeFileSync(parent, "unsafe");
        }
        if (site === "lock") fs.writeFileSync(directory, "unsafe");
        if (site === "entry") {
          fs.mkdirSync(directory);
          fs.writeFileSync(path.join(directory, "unexpected"), "must survive");
        }
        let effects = 0;
        // This lower path test already owns its format; damaged storage must not
        // be reselected through the separate Project marker boundary.
        await assert.rejects(async () => run(root, () => ++effects, formatForVerifiedOwner(layout)), { code: "INVALID_PROJECT_MUTATION_LOCK" });
        assert.equal(effects, 0);
        if (site === "entry") assert.equal(fs.readFileSync(path.join(directory, "unexpected"), "utf8"), "must survive");
      }
    }
  });

  test(`${mode} live, foreign and EPERM-liveness owners cannot be reclaimed`, async (t) => {
    for (const kind of ["live", "foreign", "permission-unknown"]) {
      const { root, directory } = fixture(t);
      fs.mkdirSync(directory);
      const file = path.join(directory, nameFor(kind === "live" ? process.pid : deadPid, kind === "foreign" ? "f".repeat(16) : host));
      fs.writeFileSync(file, "owner must survive");
      const originalNow = Date.now;
      const originalKill = process.kill;
      let clock = 0;
      let effects = 0;
      // Advance only the existing busy deadline, without changing production
      // timeouts or the separate read retry count.
      Date.now = () => (clock += 11_000);
      process.kill = (pid, ...args) => {
        if (pid === deadPid) throw Object.assign(new Error("cannot establish absence"), { code: "EPERM" });
        return originalKill(pid, ...args);
      };
      try {
        await assert.rejects(async () => run(root, () => ++effects), { code: "PROJECT_MUTATION_BUSY" });
        assert.equal(effects, 0);
        assert.equal(fs.readFileSync(file, "utf8"), "owner must survive");
      } finally {
        Date.now = originalNow;
        process.kill = originalKill;
      }
    }
  });
}

test("sync/async nesting reuses exact ownership and unrelated sync calls cannot deadlock an async owner", async (t) => {
  const { root, parent } = fixture(t);
  assert.equal(
    withProjectMutation({ root, scope: "session-recovery" }, () => withProjectMutation({ root, scope: "session-recovery" }, () => "sync nested")),
    "sync nested",
  );
  assert.equal(
    await withProjectMutationAsync({ root, scope: "session-recovery" }, async () => {
      assert.equal(
        withProjectMutation({ root, scope: "session-recovery" }, () => "mixed nested"),
        "mixed nested",
      );
      return withProjectMutationAsync({ root, scope: "session-recovery" }, async () => "async nested");
    }),
    "async nested",
  );
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const owner = withProjectMutationAsync({ root, scope: "session-recovery" }, () => pending);
  try {
    assert.throws(() => withProjectMutation({ root, scope: "session-recovery" }, () => assert.fail("must not run")), { code: "PROJECT_MUTATION_BUSY" });
  } finally {
    finish();
    await owner;
  }
  assert.deepEqual(fs.readdirSync(parent), []);
});

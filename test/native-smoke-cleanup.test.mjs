import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createNativeSmokeCleanup } from "../scripts/lib/native-smoke-cleanup.mjs";

const file = fileURLToPath(import.meta.url);
const cwd = path.resolve(path.dirname(file), "..");
const mode = process.argv[2];
function log(value) {
  process.stderr.write(`${JSON.stringify({ ...value, cwd, ports: [] })}\n`);
}
function exists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
function launch(args, options = {}) {
  log({ event: "child-prepare", parent: process.pid, command: [process.execPath, ...args] });
  const child = spawn(process.execPath, args, { cwd, shell: false, windowsHide: true, ...options });
  log({ event: "child-start", pid: child.pid, parent: process.pid, command: [process.execPath, ...args] });
  child.once("close", (code, signal) => log({ event: "child-end", pid: child.pid, code, signal }));
  return child;
}
async function finishOwnedFixture(cleanups, primaryError) {
  const errors = [];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(
      primaryError ? [primaryError, ...errors] : errors,
      "Owned fixture cleanup failed.",
      primaryError ? { cause: primaryError } : undefined,
    );
  if (primaryError) throw primaryError;
}

if (mode === "--fixture-leaf") {
  // This process deliberately survives TERM after its original parent exits.
  process.on("SIGTERM", () => {});
  log({ event: "fixture-leaf", pid: process.pid, parent: process.ppid, command: process.argv });
  process.send({ leafPid: process.pid });
  process.disconnect();
  setInterval(() => {}, 1_000);
} else if (mode === "--fixture-parent") {
  const leaf = launch([file, "--fixture-leaf"], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  leaf.once("message", ({ leafPid }) => {
    process.stdout.write(`${JSON.stringify({ rootPid: process.pid, leafPid })}\n`);
    if (process.argv[3] === "parent-exits") process.exit(0);
  });
  setInterval(() => {}, 1_000);
} else if (mode === "--fixture-driver") {
  const scenario = process.argv[3];
  const child = launch([file, "--fixture-parent", scenario], { detached: true, stdio: ["ignore", "pipe", "inherit"] });
  const cleanup = createNativeSmokeCleanup(child, { cwd, graceMs: 80 });
  process.stdout.write(`${JSON.stringify({ event: "owned", rootPid: child.pid })}\n`);
  let finish;
  let reject;
  const result = new Promise((resolve, fail) => {
    finish = resolve;
    reject = fail;
  });
  let started = false;
  const stop = () => {
    if (started) return;
    started = true;
    const first = cleanup.stop();
    assert.equal(first, cleanup.stop(), "Concurrent cleanup must share one operation.");
    first.then(finish, reject);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const safety = setTimeout(stop, 10_000);
  let timeout;
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (!output.includes("\n")) return;
    const owned = JSON.parse(output.trim());
    const ready = () => {
      process.stdout.write(`${JSON.stringify({ event: "ready", driverPid: process.pid, ...owned, parentAlreadyExited: child.exitCode !== null })}\n`);
      if (scenario === "timeout") timeout = setTimeout(stop, 80);
    };
    if (scenario === "parent-exits" && child.exitCode === null) child.once("exit", ready);
    else ready();
  });
  child.once("error", reject);
  try {
    await result;
    assert.equal(cleanup.isAlive(), false);
    process.stdout.write(`${JSON.stringify({ event: "cleaned", groupGone: true })}\n`);
  } finally {
    clearTimeout(safety);
    clearTimeout(timeout);
    await cleanup.stop();
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
} else {
  test("fixture cleanup reaches independent owners after probe or signal errors and retains the primary failure", async () => {
    for (const operation of ["group probe", "group signal"]) {
      const primary = new Error("Original fixture assertion.");
      const denied = Object.assign(new Error(`${operation} EPERM`), { code: "EPERM" });
      const visited = [];
      await assert.rejects(
        finishOwnedFixture(
          [
            () => {
              visited.push("driver TERM");
            },
            () => {
              visited.push(operation);
              throw denied;
            },
            () => {
              visited.push("driver close");
            },
            () => {
              visited.push("sentinel stop");
            },
          ],
          primary,
        ),
        (error) => {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.cause, primary);
          assert.deepEqual(error.errors, [primary, denied]);
          return true;
        },
      );
      assert.deepEqual(visited, ["driver TERM", operation, "driver close", "sentinel stop"]);
    }
    const denied = Object.assign(new Error("signal EPERM"), { code: "EPERM" });
    await assert.rejects(
      finishOwnedFixture([
        () => {
          throw denied;
        },
      ]),
      (error) => {
        assert.deepEqual(error.errors, [denied]);
        return true;
      },
    );
    const primary = new Error("Original failure without cleanup errors.");
    await assert.rejects(finishOwnedFixture([() => {}], primary), (error) => error === primary);
  });

  test("native smoke preserves uncertainty until a Darwin group is reaped and never masks denied signals", async () => {
    // Inject OS primitives only: no real process or signal targets are created.
    const pid = 12345;
    const denied = () => Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    const missing = () => Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    const child = { pid, exitCode: null, signalCode: null };
    const signals = [];
    let termSent = false;
    let inconclusiveProbes = 0;
    const reaped = createNativeSmokeCleanup(child, {
      cwd,
      platform: "darwin",
      graceMs: 100,
      kill(target, signal) {
        assert.equal(target, -pid);
        if (signal === 0) {
          if (!termSent) return;
          if (inconclusiveProbes++ === 0) throw denied();
          throw missing();
        }
        signals.push(signal);
        termSent = true;
      },
    });
    await reaped.stop();
    assert.deepEqual(signals, ["SIGTERM"]);
    assert.equal(reaped.isAlive(), false, "Only ESRCH may establish that the group is gone.");

    for (const deniedSignal of ["SIGTERM", "SIGKILL"]) {
      const observed = [];
      const forbidden = createNativeSmokeCleanup(child, {
        cwd,
        platform: "darwin",
        graceMs: 0,
        killWaitMs: 0,
        kill(target, signal) {
          assert.equal(target, -pid);
          if (signal === 0) throw denied();
          observed.push(signal);
          if (signal === deniedSignal) throw denied();
        },
      });
      await assert.rejects(forbidden.stop(), { code: "EPERM" });
      assert.deepEqual(observed, deniedSignal === "SIGTERM" ? ["SIGTERM"] : ["SIGTERM", "SIGKILL"]);
      assert.equal(forbidden.isAlive(), true, "Denied or inconclusive cleanup must not claim success.");
    }

    const stuckSignals = [];
    const stuck = createNativeSmokeCleanup(child, {
      cwd,
      platform: "darwin",
      graceMs: 0,
      killWaitMs: 0,
      kill(target, signal) {
        assert.equal(target, -pid);
        if (signal === 0) throw denied();
        stuckSignals.push(signal);
      },
    });
    await assert.rejects(stuck.stop(), /Owned process group remains/u);
    assert.deepEqual(stuckSignals, ["SIGTERM", "SIGKILL"]);
    assert.equal(stuck.isAlive(), true, "Persistent EPERM must end in bounded failure, not success.");
  });

  test("native smoke cleanup is idempotent for an already completed child", async () => {
    log({ event: "test-owner", pid: process.pid, parent: process.ppid, command: process.argv });
    const child = launch(["-e", ""], { detached: process.platform !== "win32", stdio: "ignore" });
    const cleanup = createNativeSmokeCleanup(child, { cwd });
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    const first = cleanup.stop();
    assert.equal(first, cleanup.stop());
    await first;
    assert.equal(cleanup.isAlive(), false);
  });

  test("native smoke cleanup converges repeated stop requests for a running child", async () => {
    const child = launch(["-e", "setInterval(() => {}, 1000)"], { detached: process.platform !== "win32", stdio: "ignore" });
    const cleanup = createNativeSmokeCleanup(child, { cwd, graceMs: 80 });
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    try {
      const first = cleanup.stop();
      assert.equal(first, cleanup.stop());
      await first;
      await exited;
      assert.equal(cleanup.isAlive(), false);
    } finally {
      try {
        await cleanup.stop();
      } finally {
        // This single-process fixture owns no descendants. If an OS sandbox
        // denies taskkill, do not leave the intentionally running fixture alive.
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await Promise.race([exited, delay(500)]);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
      }
    }
  });

  for (const scenario of ["timeout", "interrupt", "parent-exits"]) {
    test(
      `native smoke ${scenario} cleans a TERM-ignoring descendant after parent exit`,
      { skip: process.platform === "win32" ? "POSIX-only process-group contract (Linux/macOS CI)" : false, timeout: 20_000 },
      async () => {
        log({ event: "test-owner", pid: process.pid, parent: process.ppid, command: process.argv });
        // A same-executable process outside the owned group must remain untouched.
        const sentinel = launch(["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
        const sentinelCleanup = createNativeSmokeCleanup(sentinel, { cwd, graceMs: 80 });
        const driver = launch([file, "--fixture-driver", scenario], { stdio: ["ignore", "pipe", "inherit"] });
        let owned;
        let groupCleanup;
        let buffer = "";
        let cleaned = false;
        let ready;
        const readiness = new Promise((resolve) => {
          ready = resolve;
        });
        driver.stdout.on("data", (chunk) => {
          buffer += chunk;
          let boundary;
          while ((boundary = buffer.indexOf("\n")) >= 0) {
            const line = JSON.parse(buffer.slice(0, boundary));
            buffer = buffer.slice(boundary + 1);
            if (line.event === "owned") groupCleanup = createNativeSmokeCleanup({ pid: line.rootPid }, { cwd, graceMs: 80 });
            if (line.event === "ready") {
              owned = line;
              ready();
            }
            if (line.event === "cleaned") cleaned = line.groupGone;
          }
        });
        const exited = new Promise((resolve, reject) => {
          driver.once("error", reject);
          driver.once("close", (code, signal) => resolve({ code, signal }));
        });
        let safety;
        let primaryError;
        try {
          await Promise.race([
            readiness,
            exited.then(() => {
              throw new Error("Driver exited before fixture readiness.");
            }),
            new Promise((_, reject) => {
              safety = setTimeout(() => reject(new Error("Fixture readiness timeout.")), 5_000);
            }),
          ]);
          clearTimeout(safety);
          assert.equal(owned.driverPid, driver.pid);
          if (scenario === "parent-exits") assert.equal(owned.parentAlreadyExited, true);
          if (scenario !== "timeout") driver.kill(scenario === "interrupt" ? "SIGINT" : "SIGTERM");
          assert.deepEqual(await exited, { code: 0, signal: null });
          assert.equal(cleaned, true);
          assert.equal(exists(owned.rootPid), false);
          assert.equal(exists(owned.leafPid), false);
          assert.equal(exists(-owned.rootPid), false);
          assert.equal(sentinelCleanup.isAlive(), true, "An unrelated same-name process must remain alive.");
        } catch (error) {
          primaryError = error;
        } finally {
          clearTimeout(safety);
          await finishOwnedFixture(
            [
              async () => {
                if (driver.exitCode === null && driver.signalCode === null) driver.kill("SIGTERM");
                await Promise.race([exited, delay(1_000)]);
              },
              async () => {
                // This group was captured from the owned driver before failure.
                // Reuse the production conservative probe; an EPERM must not
                // prevent cleaning the independent driver and sentinel below.
                if (groupCleanup) {
                  if (!cleaned) await groupCleanup.stop();
                  assert.equal(groupCleanup.isAlive(), false, "Fixture process group must be gone after failure too.");
                }
              },
              async () => {
                if (driver.exitCode === null && driver.signalCode === null) driver.kill("SIGKILL");
                await Promise.race([
                  exited,
                  delay(1_000).then(() => {
                    throw new Error("Owned fixture driver did not close.");
                  }),
                ]);
              },
              async () => {
                await sentinelCleanup.stop();
                assert.equal(sentinelCleanup.isAlive(), false);
              },
            ],
            primaryError,
          );
        }
      },
    );
  }
}

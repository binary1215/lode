import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { finishCodexAppServerFixture, waitForFixturePidsAbsent } from "./helpers/codex-app-server-fixture-cleanup.mjs";

function directory(t) {
  const dir = fs.mkdtempSync(path.join(process.env.LODE_AGENT_TEST_TMP || process.env.HEAD_AGENT_TEST_TMP || os.tmpdir(), "head-fixture-cleanup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const journal = [{ event: "process-closed", supervision: { treeCleanupVerified: true } }];

test("fixture PID observation waits for delayed ESRCH without replacing global probes", async () => {
  let time = 0;
  const probes = [];
  assert.equal(
    await waitForFixturePidsAbsent([41, 42], {
      probe: (pid) => {
        probes.push(pid);
        return time >= (pid === 41 ? 10 : 30);
      },
      now: () => time,
      pause: async (milliseconds) => {
        time += milliseconds;
      },
    }),
    true,
  );
  assert.equal(time, 30);
  assert.deepEqual([...new Set(probes)], [41, 42]);
});

test("permanently present fixture PIDs share one bounded grace and never become absent", async () => {
  let time = 0;
  const probes = [];
  assert.equal(
    await waitForFixturePidsAbsent([41, 42, 43], {
      probe: (pid) => {
        probes.push(pid);
        return false;
      },
      now: () => time,
      pause: async (milliseconds) => {
        time += milliseconds;
      },
    }),
    false,
  );
  assert.equal(time, 1000, "One shared bound, not one grace per PID");
  assert.deepEqual([...new Set(probes)], [41, 42, 43]);
});

test("fixture observation preserves EPERM rather than treating it as ESRCH", async () => {
  const original = Object.assign(new Error("denied"), { code: "EPERM" });
  let waited = false;
  await assert.rejects(
    waitForFixturePidsAbsent([41], {
      probe: () => {
        throw original;
      },
      now: () => 0,
      pause: async () => {
        waited = true;
      },
    }),
    (cause) => cause === original,
  );
  assert.equal(waited, false);
});

test("teardown cannot rewrite uncertain runtime evidence after its absence checks", async (t) => {
  const dir = directory(t);
  const raw = Object.freeze([{ event: "process-closed", supervision: Object.freeze({ treeCleanupVerified: false }) }]);
  const transport = {
    close: async () => {
      throw Object.assign(new Error("uncertain"), { code: "CODEX_RPC_CLEANUP_UNCERTAIN" });
    },
    inspect: () => ({ closed: true }),
  };
  await finishCodexAppServerFixture({
    transport,
    owner: {},
    journal: raw,
    dir,
    allowUncleanClose: true,
    verify: () => assert.equal(raw[0].supervision.treeCleanupVerified, false),
  });
  assert.equal(raw[0].supervision.treeCleanupVerified, false);
  assert.equal(fs.existsSync(dir), false);
});

for (const code of ["CODEX_RPC_UNCLEAN_EXIT", "CODEX_RPC_CLEANUP_UNCERTAIN", "OTHER_CLOSE_FAILURE"]) {
  test(`strict fixture close preserves ${code} even with confirmed cleanup`, async (t) => {
    const dir = directory(t);
    const original = Object.assign(new Error(code), { code });
    const transport = {
      close: async () => {
        throw original;
      },
      inspect: () => ({ closed: true, started: true }),
    };
    await assert.rejects(finishCodexAppServerFixture({ transport, owner: {}, journal, dir }), (cause) => cause === original);
    assert.equal(fs.existsSync(dir), false, "original failure cannot skip finally cleanup");
  });
}

test("close and verification failures both survive protective cleanup", async (t) => {
  const priorError = new Error("body assertion failed"),
    closeError = new Error("close failed"),
    verificationError = new Error("verification failed");
  const dir = directory(t);
  const transport = {
    close: async () => {
      throw closeError;
    },
    inspect: () => ({ closed: true }),
  };
  await assert.rejects(
    finishCodexAppServerFixture({
      transport,
      journal,
      dir,
      priorError,
      verify: () => {
        throw verificationError;
      },
    }),
    (cause) => cause instanceof AggregateError && cause.errors[0] === priorError && cause.errors[1] === closeError && cause.errors[2] === verificationError,
  );
  assert.equal(fs.existsSync(dir), false);
});

test("known exact provider PID is checked when process-closed journal is missing", async (t) => {
  const dir = directory(t);
  const transport = { close: async () => {}, inspect: () => ({ closed: true }) };
  // This test runner is deliberately live. inspect.closed prevents any stop,
  // and the helper may only observe this PID, never signal it for termination.
  await assert.rejects(
    finishCodexAppServerFixture({ transport, owner: { state: { providerPid: process.pid } }, journal: [], dir, verify: () => {} }),
    /owned fixture PID .* must be absent/,
  );
  assert.equal(fs.existsSync(dir), true, "retain control evidence while a known PID remains");
});

test("protective stop failure cannot replace the original close error", async (t) => {
  const original = new Error("original close error"),
    stopError = new Error("protective stop error");
  const dir = directory(t);
  const transport = {
    close: async () => {
      throw original;
    },
    inspect: () => ({ closed: false }),
  };
  const owner = {
    child: { exitCode: null, signalCode: null },
    terminate: () => {
      throw stopError;
    },
  };
  await assert.rejects(
    finishCodexAppServerFixture({ transport, owner, journal: [], dir, verify: () => {} }),
    (cause) => cause instanceof AggregateError && cause.errors.includes(original) && cause.errors.includes(stopError),
  );
});

test("a body error and a permanently present owned PID both survive bounded observation", async (t) => {
  const priorError = new Error("body assertion failed"),
    dir = directory(t);
  const transport = { close: async () => {}, inspect: () => ({ closed: true }) };
  await assert.rejects(
    finishCodexAppServerFixture({ transport, owner: { state: { providerPid: process.pid } }, journal: [], dir, priorError, verify: () => {} }),
    (cause) =>
      cause instanceof AggregateError &&
      cause.errors[0] === priorError &&
      cause.errors.some((error) => /owned fixture PID .* must be absent/.test(error.message)),
  );
  assert.equal(fs.existsSync(dir), true);
});

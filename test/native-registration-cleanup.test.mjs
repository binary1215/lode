import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import {
  syntheticNativeCapture,
  nativeProfile,
} from "./helpers/native-portability-fixture.mjs";
import { prepareCodexNativeOffline } from "../scripts/lib/codex-native-offline.mjs";
for (const [name, settings, expected] of [
  ["delayed EOF gets grace after flush", { flushDelay: 650, exitDelay: 100 }, null],
  [
    "slow graceful exit gets the supervisor grace budget",
    { flushDelay: 0, exitDelay: 900 },
    null,
  ],
  ["spontaneous exit7 remains a failure", { exitCode: 7 }, "NATIVE_CODEX_RPC_UNCLEAN_EXIT"],
  ["EOF rejection is preserved", { eofReject: true }, "NATIVE_CODEX_RPC_EOF_FAILED"],
  [
    "missing EOF and close stay bounded and uncertain",
    { neverFlush: true, neverClose: true },
    "NATIVE_CODEX_RPC_CLEANUP_UNCERTAIN",
  ],
  [
    "EOF deadline survives verified owned termination",
    { neverFlush: true },
    "NATIVE_CODEX_RPC_EOF_TIMEOUT",
  ],
  [
    "forced shutdown never becomes success",
    { exitDelay: 10000 },
    "NATIVE_CODEX_RPC_FORCED_SHUTDOWN",
  ],
  [
    "exit0 without cleanup proof stays uncertain",
    { cleanupUnverified: true },
    "NATIVE_CODEX_RPC_CLEANUP_UNCERTAIN",
  ],
  ["malformed protocol remains primary", { malformed: true }, "SyntaxError"],
])
  test(name, async (t) => {
    if (process.platform !== "win32" || process.arch !== "x64")
      return t.skip("Measured witness profile is Windows x64.");
    const { f, home, executable, payload } = await syntheticNativeCapture(t),
      cwd = path.join(f.base, "cleanup-root");
    fs.mkdirSync(cwd);
    const offline = await prepareCodexNativeOffline({
      home,
      executable,
      probe: async () => ({ status: "observed", rows: [] }),
      versionProbe: async () => ({ status: "verified", version: nativeProfile.engineVersion }),
    });
    const owner = new URL("../scripts/lib/codex-native-registration-rpc.mjs", import.meta.url);
    owner.search = "fixture=" + name;
    const fake = new URL(
        "./helpers/native-registration-supervisor-fixture.mjs",
        import.meta.url,
      ),
      symbol = Symbol.for("lode-test-native-close");
    const ctx = { ...settings, timers: [], frames: [], terminations: [], closed: false };
    assert.equal(globalThis[symbol], undefined);
    globalThis[symbol] = ctx;
    const hook = registerHooks({
      resolve(specifier, context, next) {
        if (
          context.parentURL === owner.href &&
          specifier === "./runtime-process-supervisor.mjs"
        )
          return { url: fake.href, shortCircuit: true };
        return next(specifier, context);
      },
    });
    const events = [];
    let rpc;
    try {
      const { openCodexNativeRegistrationRpc } = await import(owner.href);
      const open = () =>
        openCodexNativeRegistrationRpc({
          witness: offline.witness,
          cwd,
          environment: { CODEX_HOME: home },
          supervisorSelection: { manifest: { manifestHash: "a".repeat(64) } },
          controlFile: path.join(f.base, "unused-control"),
          nativeThreads: payload.files.map((file) => ({
            threadId: file.threadId,
            path: file.path,
          })),
          onEvent: (event) => events.push(event),
        });
      if (settings.malformed) {
        await assert.rejects(open(), SyntaxError);
        assert.equal(ctx.frames.filter((frame) => frame.method === "initialize").length, 1);
        return;
      }
      rpc = await open();
      const started = Date.now();
      if (expected) await assert.rejects(rpc.close(), { code: expected });
      else {
        const result = await rpc.close();
        assert.equal(result.exitCode, 0);
        assert.equal(result.forced, false);
        assert.equal(ctx.terminations.length, 0);
        assert(Date.now() >= ctx.flushedAt + (settings.exitDelay ?? 0));
      }
      assert(Date.now() - started < 12000, "cleanup must have a finite deadline");
      if (settings.neverClose)
        assert.deepEqual(
          ctx.terminations.map((item) => item.force),
          [false, true],
        );
      if (settings.exitCode === 7) assert.equal(ctx.terminations.length, 0);
    } finally {
      for (const timer of ctx.timers) clearTimeout(timer);
      hook.deregister();
      delete globalThis[symbol];
    }
  });

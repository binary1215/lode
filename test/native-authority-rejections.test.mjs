import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./helpers/session-work-linkage-fixture.mjs";
import {
  syntheticNativeCapture,
  syntheticNativeDatabase,
  nativeProfile,
} from "./helpers/native-portability-fixture.mjs";
import { requestNativeRegistration } from "../scripts/lib/native-registration-journal.mjs";
import { prepareCodexNativeOffline } from "../scripts/lib/codex-native-offline.mjs";
import { publishCodexNativeHistory } from "../scripts/lib/codex-native-publication.mjs";
import { registerCodexNativeHistory } from "../scripts/lib/codex-native-registration.mjs";
const denied = async () => {
  throw Object.assign(Error("Synthetic rejected asynchronous authority callback"), {
    code: "SYNTHETIC_ASYNC_DENIAL",
  });
};
const settled = () => new Promise((resolve) => setImmediate(resolve));
test("journal rejects asynchronous authority without delivery, artifacts or an unhandled rejection", async (t) => {
  const f = fixture(t),
    operationRoot = path.join(f.base, "async-journal");
  fs.mkdirSync(operationRoot);
  let deliveries = 0;
  const input = {
    provider: "codex",
    profileId: "synthetic",
    payloadDigest: "a".repeat(64),
    targetHomeDigest: "b".repeat(64),
    nativeThreadId: "synthetic-exact",
    targetPathDigest: "c".repeat(64),
    currentPolicyDigest: "d".repeat(64),
    runtimeRootsDigest: "e".repeat(64),
  };
  await assert.rejects(
    requestNativeRegistration({
      operationRoot,
      input,
      readStatus: async ({ inputDigest }) => ({ inputDigest, state: "absent" }),
      register: async () => {
        deliveries++;
      },
      assertCurrentAuthority: denied,
    }),
    { code: "NATIVE_REGISTRATION_SYNCHRONOUS_AUTHORITY_REQUIRED" },
  );
  await settled();
  assert.equal(deliveries, 0);
  assert.deepEqual(fs.readdirSync(operationRoot), []);
});
test("native publication and metadata registration drain rejected authority promises before effects", async (t) => {
  if (process.platform !== "win32" || process.arch !== "x64")
    return t.skip("Measured native filesystem profile is Windows x64.");
  const { f, executable, destination } = await syntheticNativeCapture(t),
    home = path.join(f.base, "async-target"),
    cwd = path.join(f.base, "async-current-workspace");
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  for (const file of ["state_5.sqlite", "thread_history_1.sqlite"])
    syntheticNativeDatabase(t, file, path.join(home, file)).close();
  const offline = await prepareCodexNativeOffline({
    home,
    executable,
    probe: async () => ({ status: "observed", rows: [] }),
    versionProbe: async () => ({ status: "verified", version: nativeProfile.engineVersion }),
  });
  const before = new Map(
    ["state_5.sqlite", "thread_history_1.sqlite"].map((name) => [
      name,
      fs.readFileSync(path.join(home, name)),
    ]),
  );
  await assert.rejects(
    publishCodexNativeHistory({
      witness: offline.witness,
      directory: destination,
      assertCurrentAuthority: denied,
    }),
    { code: "NATIVE_CODEX_SYNCHRONOUS_AUTHORITY_REQUIRED" },
  );
  await settled();
  for (const [name, raw] of before) assert(fs.readFileSync(path.join(home, name)).equals(raw));
  assert(!fs.existsSync(path.join(home, ".lode-native-portability")));
  await publishCodexNativeHistory({ witness: offline.witness, directory: destination });
  const names = fs.readdirSync(path.join(home, ".lode-native-portability")).sort();
  let processes = 0;
  await assert.rejects(
    registerCodexNativeHistory({
      witness: offline.witness,
      directory: destination,
      cwd,
      environment: { CODEX_HOME: home, HOME: home, USERPROFILE: home },
      supervisorSelection: { simulationOnly: true },
      controlFile: path.join(f.base, "never-created-control"),
      onProcess() {
        processes++;
      },
      assertCurrentAuthority: denied,
    }),
    { code: "NATIVE_CODEX_SYNCHRONOUS_AUTHORITY_REQUIRED" },
  );
  await settled();
  assert.equal(processes, 0);
  assert.deepEqual(fs.readdirSync(path.join(home, ".lode-native-portability")).sort(), names);
});

test("journal preparation digest binds exact evidence without changing its stable at-most-once identity", async (t) => {
  const f = fixture(t),
    operationRoot = path.join(f.base, "prepared-journal");
  fs.mkdirSync(operationRoot);
  let deliveries = 0;
  const base = {
    provider: "codex",
    profileId: "synthetic",
    payloadDigest: "a".repeat(64),
    targetHomeDigest: "b".repeat(64),
    nativeThreadId: "same-exact-thread",
    targetPathDigest: "c".repeat(64),
    currentPolicyDigest: "d".repeat(64),
    runtimeRootsDigest: "e".repeat(64),
  };
  const callbacks = {
    operationRoot,
    readStatus: async ({ inputDigest }) => ({ inputDigest, state: "absent" }),
    register: async () => {
      deliveries++;
      throw Object.assign(Error("Synthetic response unavailable"), {
        code: "SYNTHETIC_UNKNOWN",
      });
    },
  };
  for (const preparationDigest of [null, "", "x".repeat(64), "a", {}, undefined])
    await assert.rejects(
      requestNativeRegistration({ ...callbacks, input: { ...base, preparationDigest } }),
      { code: "NATIVE_REGISTRATION_INPUT_INVALID" },
    );
  assert.equal(deliveries, 0);
  assert.deepEqual(fs.readdirSync(operationRoot), []);
  const input = { ...base, preparationDigest: "f".repeat(64) };
  assert.equal(
    (await requestNativeRegistration({ ...callbacks, input })).status,
    "native-registration-uncertain",
  );
  for (const altered of [
    { ...input, preparationDigest: "0".repeat(64) },
    base,
    { ...input, currentPolicyDigest: "0".repeat(64) },
    { ...input, runtimeRootsDigest: "0".repeat(64) },
  ])
    await assert.rejects(requestNativeRegistration({ ...callbacks, input: altered }), {
      code: "NATIVE_REGISTRATION_JOURNAL_INVALID",
    });
  assert.equal(
    (await requestNativeRegistration({ ...callbacks, input })).status,
    "native-registration-uncertain",
  );
  assert.equal(deliveries, 1);
});

test("journal preserves primary and cleanup failure codes without exposing error prose", async (t) => {
  const f = fixture(t),
    operationRoot = path.join(f.base, "cleanup-codes");
  fs.mkdirSync(operationRoot);
  const input = {
    provider: "codex",
    profileId: "synthetic",
    payloadDigest: "a".repeat(64),
    targetHomeDigest: "b".repeat(64),
    nativeThreadId: "codes-only",
    targetPathDigest: "c".repeat(64),
    currentPolicyDigest: "d".repeat(64),
    runtimeRootsDigest: "e".repeat(64),
  };
  const result = await requestNativeRegistration({
    operationRoot,
    input,
    readStatus: async ({ inputDigest }) => ({ inputDigest, state: "absent" }),
    register: async () => {
      throw Object.assign(Error("SYNTHETIC_PRIVATE_PROSE_NOT_FOR_RESULTS"), {
        code: "SYNTHETIC_PRIMARY_FAILURE",
        nativeCleanupFailure: "NATIVE_CODEX_RPC_CLEANUP_UNCERTAIN",
      });
    },
  });
  assert.equal(result.status, "native-registration-uncertain");
  assert.deepEqual(result.primaryFailure, {
    code: "SYNTHETIC_PRIMARY_FAILURE",
    cleanupFailure: "NATIVE_CODEX_RPC_CLEANUP_UNCERTAIN",
  });
  assert(!JSON.stringify(result).includes("SYNTHETIC_PRIVATE_PROSE_NOT_FOR_RESULTS"));
});

import fs from "node:fs";
import path from "node:path";
import { types } from "node:util";
import { copiedProjectFile } from "../storage/project-copy-evidence.mjs";
import { readSnapshotFile } from "../world/snapshot-storage-codec.mjs";
import { atomicCreateArtifact } from "../core/fs-atomic.mjs";
import { sha256Hex as hash } from "../core/digest.mjs";
import { failCode as fail } from "../core/errors.mjs";
const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const fields = [
  "provider",
  "profileId",
  "payloadDigest",
  "targetHomeDigest",
  "nativeThreadId",
  "targetPathDigest",
  "currentPolicyDigest",
  "runtimeRootsDigest",
];
function snapshot(input) {
  if (!input || typeof input !== "object" || types.isProxy(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)))
    fail("NATIVE_REGISTRATION_INPUT_INVALID");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const suppliedFields = Object.hasOwn(descriptors, "preparationDigest") ? [...fields, "preparationDigest"] : fields;
  if (
    Reflect.ownKeys(descriptors).length !== suppliedFields.length ||
    suppliedFields.some((key) => !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], "value"))
  )
    fail("NATIVE_REGISTRATION_INPUT_INVALID");
  const value = Object.fromEntries(suppliedFields.map((key) => [key, descriptors[key].value]));
  if (
    !["codex", "claude", "opencode"].includes(value.provider) ||
    suppliedFields.some((key) => typeof value[key] !== "string" || !value[key] || value[key].length > 512) ||
    suppliedFields.filter((key) => key.endsWith("Digest")).some((key) => !/^[a-f0-9]{64}$/.test(value[key]))
  )
    fail("NATIVE_REGISTRATION_INPUT_INVALID");
  return Object.freeze(value);
}
function read(root, relative) {
  const file = copiedProjectFile(root, relative),
    stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536) fail("NATIVE_REGISTRATION_JOURNAL_INVALID");
  return readSnapshotFile(file, { decodedBytes: 65536 }).document;
}
function checkAuthority(assertCurrentAuthority) {
  const result = assertCurrentAuthority();
  if (result && typeof result.then === "function") {
    Promise.resolve(result).catch(() => {});
    fail("NATIVE_REGISTRATION_SYNCHRONOUS_AUTHORITY_REQUIRED");
  }
}
function observation(value, inputDigest) {
  if (
    !value ||
    value.inputDigest !== inputDigest ||
    !["absent", "matches", "diverged", "unknown"].includes(value.state) ||
    (value.state === "matches" && (typeof value.evidenceDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.evidenceDigest)))
  )
    fail("NATIVE_REGISTRATION_OBSERVATION_INVALID");
  return value;
}
function attempt(root, relative, input, inputDigest) {
  const file = copiedProjectFile(root, relative);
  if (!fs.existsSync(file)) return null;
  const value = read(root, relative),
    expected = {
      schemaVersion: 1,
      kind: "NativeRegistrationAttempt",
      authorityPlane: "P5",
      input,
      inputDigest,
      automaticReplayAllowed: false,
      grantsRecoveryAuthority: false,
      restoresExecutionPermission: false,
    };
  if (JSON.stringify(value) !== JSON.stringify(expected)) fail("NATIVE_REGISTRATION_JOURNAL_INVALID");
  return value;
}

function verifyResult(root, relative, inputDigest) {
  const stored = read(root, relative),
    { resultDigest, ...payload } = stored;
  if (
    stored.schemaVersion !== 1 ||
    stored.kind !== "NativeRegistrationResult" ||
    stored.authorityPlane !== "P5" ||
    stored.inputDigest !== inputDigest ||
    stored.automaticReplayAllowed !== false ||
    stored.grantsRecoveryAuthority !== false ||
    stored.restoresExecutionPermission !== false ||
    typeof stored.evidenceDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(stored.evidenceDigest) ||
    hash(json(payload)) !== resultDigest
  )
    fail("NATIVE_REGISTRATION_JOURNAL_INVALID");
  return stored;
}

function identity(operationRoot, input) {
  const selected = snapshot(input),
    inputDigest = hash(json(selected)),
    operationId =
      "native-registration-" +
      hash(
        json(
          Object.fromEntries(
            ["provider", "profileId", "payloadDigest", "targetHomeDigest", "nativeThreadId", "targetPathDigest"].map((key) => [key, selected[key]]),
          ),
        ),
      ).slice(0, 24);
  const root = fs.realpathSync(path.resolve(operationRoot)),
    attemptPath = operationId + ".attempt.json",
    resultPath = operationId + ".result.json";
  return { selected, inputDigest, operationId, root, attemptPath, resultPath };
}

// Read-only operational evidence. It neither retries delivery nor grants a
// registered thread execution/continuation or recovery authority.
export function inspectNativeRegistration({ operationRoot, input } = {}) {
  const { selected, inputDigest, operationId, root, attemptPath, resultPath } = identity(operationRoot, input);
  const existing = attempt(root, attemptPath, selected, inputDigest);
  const hasResult = fs.existsSync(copiedProjectFile(root, resultPath));
  if (hasResult && !existing) fail("NATIVE_REGISTRATION_JOURNAL_INVALID");
  const result = hasResult ? verifyResult(root, resultPath, inputDigest) : null;
  return {
    operationId,
    inputDigest,
    status: result ? "verified" : existing ? "uncertain" : "not-started",
    evidenceDigest: result?.evidenceDigest || null,
    authorityPlane: "P4",
    automaticReplayAllowed: false,
    grantsRecoveryAuthority: false,
    restoresExecutionPermission: false,
  };
}

// Trusted Host callbacks perform exact SDK/identity/policy/history verification;
// no JSON, transcript or saved status can supply functions or execution rights.
// The journal is operational at-most-once delivery, not approval or P2 direction.
export async function requestNativeRegistration({ operationRoot, input, readStatus, register, assertCurrentAuthority = () => {} } = {}) {
  if (typeof readStatus !== "function" || typeof register !== "function" || typeof assertCurrentAuthority !== "function")
    fail("NATIVE_REGISTRATION_HOST_REQUIRED");
  const { selected, inputDigest, operationId, root, attemptPath, resultPath } = identity(operationRoot, input);
  let existing = attempt(root, attemptPath, selected, inputDigest);
  const reconcileStored = () => {
    if (fs.existsSync(copiedProjectFile(root, resultPath))) {
      existing ??= attempt(root, attemptPath, selected, inputDigest);
      if (!existing) fail("NATIVE_REGISTRATION_JOURNAL_INVALID");
      verifyResult(root, resultPath, inputDigest);
    }
  };
  reconcileStored();
  const observe = async () => {
    try {
      return observation(await readStatus({ input: selected, inputDigest }), inputDigest);
    } catch (error) {
      error.nativeRegistrationOutcome = {
        state: "read-unavailable",
        automaticReplayAllowed: false,
      };
      throw error;
    }
  };
  const observed = await observe();
  existing ??= attempt(root, attemptPath, selected, inputDigest);
  reconcileStored();
  const summary = {
    operationId,
    inputDigest,
    authorityPlane: "P5",
    automaticReplayAllowed: false,
    grantsRecoveryAuthority: false,
    restoresExecutionPermission: false,
  };
  const finish = (value) => {
    if (existing || fs.existsSync(copiedProjectFile(root, attemptPath))) {
      checkAuthority(assertCurrentAuthority);
      const payload = {
        schemaVersion: 1,
        kind: "NativeRegistrationResult",
        authorityPlane: "P5",
        inputDigest,
        evidenceDigest: value.evidenceDigest,
        automaticReplayAllowed: false,
        grantsRecoveryAuthority: false,
        restoresExecutionPermission: false,
      };
      const receipt = { ...payload, resultDigest: hash(json(payload)) };
      const file = copiedProjectFile(root, resultPath);
      if (fs.existsSync(file)) {
        verifyResult(root, resultPath, inputDigest);
      } else
        try {
          atomicCreateArtifact(file, json(receipt));
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          verifyResult(root, resultPath, inputDigest);
        }
    }
    return {
      ...summary,
      status: "native-registration-verified",
      persisted: Boolean(existing || fs.existsSync(copiedProjectFile(root, attemptPath))),
    };
  };
  if (observed.state === "matches") return finish(observed);
  if (existing)
    return {
      ...summary,
      status: "native-registration-uncertain",
      currentObservation: observed.state,
      persisted: true,
    };
  if (observed.state !== "absent")
    return {
      ...summary,
      status: observed.state === "diverged" ? "native-registration-target-diverged" : "native-registration-unknown",
      persisted: false,
    };
  checkAuthority(assertCurrentAuthority);
  const intent = {
    schemaVersion: 1,
    kind: "NativeRegistrationAttempt",
    authorityPlane: "P5",
    input: selected,
    inputDigest,
    automaticReplayAllowed: false,
    grantsRecoveryAuthority: false,
    restoresExecutionPermission: false,
  };
  try {
    atomicCreateArtifact(copiedProjectFile(root, attemptPath), json(intent));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    attempt(root, attemptPath, selected, inputDigest);
    return {
      ...summary,
      status: "native-registration-uncertain",
      currentObservation: "concurrent-attempt",
      persisted: true,
    };
  }
  try {
    checkAuthority(assertCurrentAuthority);
    await register({ input: selected, inputDigest, requestId: operationId });
  } catch (error) {
    return {
      ...summary,
      status: "native-registration-uncertain",
      primaryFailure: {
        code: error.code || "NATIVE_REGISTRATION_DELIVERY_FAILED",
        ...(error.nativeCleanupFailure ? { cleanupFailure: error.nativeCleanupFailure } : {}),
      },
      persisted: true,
    };
  }
  const verified = await observe();
  return verified.state === "matches"
    ? finish(verified)
    : {
        ...summary,
        status: "native-registration-uncertain",
        currentObservation: verified.state,
        persisted: true,
      };
}

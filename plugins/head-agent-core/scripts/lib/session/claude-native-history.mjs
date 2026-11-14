import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { atomicCreateArtifact } from "../core/fs-atomic.mjs";
import { copiedProjectFile } from "../storage/project-copy-evidence.mjs";
import { captureProviderNativeHistory } from "./provider-native-history-payload.mjs";
import { inspectClaudeHistoryOriginal, decodeClaudeHistoryRecords } from "./provider-native-history-format.mjs";
import { requestNativeRegistration } from "../distribution/native-registration-journal.mjs";
import {
  nativeCheck,
  nativeFail,
  nativeHash,
  nativeJson,
  nativeRoot,
  pinNativeRoot,
  nativeRaw,
  nativeObject,
  nativeSeparate,
  nativeOutcome,
} from "./provider-native-history-host.mjs";

export function claudeNativeProjectName(root) {
  const name = root.replace(/[^A-Za-z0-9]/gu, "-");
  // Official long-path suffix is not guessed. This limits only this native
  // adapter; raw/Handoff reads remain available.
  if (!name || name.length > 200) nativeFail("NATIVE_CLAUDE_LONG_PROJECT_PATH_UNQUALIFIED");
  return name;
}
function safePlan(home, project, native, signal, check) {
  const folder = claudeNativeProjectName(project),
    rows = [],
    targets = new Set();
  for (const entry of native.payload.files) {
    let relative;
    if (entry.role === "conversation") relative = folder + "/" + entry.nativeId + ".jsonl";
    else {
      const segments = entry.path.split("/"),
        index = segments.indexOf(entry.nativeId);
      if (index < 0 || index > 1 || segments.length <= index + 1) nativeFail("NATIVE_CLAUDE_COMPANION_SCOPE_UNSUPPORTED");
      relative = folder + "/" + segments.slice(index).join("/");
    }
    const targetKey = process.platform === "win32" ? relative.toLowerCase() : relative;
    if (targets.has(targetKey)) nativeFail("NATIVE_CLAUDE_TARGET_PATH_COLLISION");
    targets.add(targetKey);
    const raw = nativeObject(native, entry, signal, check);
    if (entry.role === "conversation") inspectClaudeHistoryOriginal(raw, entry.nativeId);
    copiedProjectFile(home, "projects/" + relative);
    rows.push({ entry, relative, raw });
  }
  for (const key of targets)
    for (let slash = key.indexOf("/"); slash >= 0; slash = key.indexOf("/", slash + 1))
      if (targets.has(key.slice(0, slash))) nativeFail("NATIVE_CLAUDE_TARGET_PATH_COLLISION");
  return rows;
}
function duplicates(home, plan, signal, check) {
  const projects = copiedProjectFile(home, "projects");
  if (!fs.existsSync(projects)) return;
  for (const dir of fs.readdirSync(projects, { withFileTypes: true })) {
    if (dir.isSymbolicLink()) nativeFail("NATIVE_CLAUDE_DUPLICATE_SCOPE_UNQUALIFIED");
    if (!dir.isDirectory()) continue;
    for (const row of plan.filter((row) => row.entry.role === "conversation")) {
      const relative = dir.name + "/" + row.entry.nativeId + ".jsonl";
      if (relative === row.relative || !fs.existsSync(copiedProjectFile(projects, relative))) continue;
      nativeRaw(projects, relative, signal, check); // reject an unsafe duplicate
      nativeFail("NATIVE_CLAUDE_OTHER_PROJECT_ID_CONFLICT");
    }
  }
}
export async function operateClaudeNativeHistory({
  action,
  selected,
  nativeHome,
  root,
  threadIds,
  companionPaths = [],
  host,
  signal,
  assertCurrentAuthority = () => {},
  captureDirectory,
  attach,
}) {
  const roots = [];
  const check = () => {
    nativeCheck(signal, assertCurrentAuthority);
    for (const item of roots) item.verify();
  };
  check();
  const home = nativeRoot(nativeHome),
    project = nativeRoot(root);
  roots.push(pinNativeRoot(home), pinNativeRoot(project));
  nativeSeparate(home, nativeRoot(selected.bundleRoot));
  const folder = claudeNativeProjectName(project);
  const version = await host.version({ home, cwd: project });
  check();
  if (version !== "2.1.223") nativeFail("NATIVE_CLAUDE_VERSION_UNQUALIFIED");
  const base = { clientEvidence: host.evidenceKind, clientVersion: version, clientExecutableDigest: host.executableDigest ?? null };
  if (action === "capture") {
    if (
      !Array.isArray(threadIds) ||
      !threadIds.length ||
      new Set(threadIds).size !== threadIds.length ||
      threadIds.some((id) => !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(id))
    )
      nativeFail("NATIVE_CLAUDE_SELECTION_INVALID");
    if (!Array.isArray(companionPaths)) nativeFail("NATIVE_CLAUDE_COMPANION_SCOPE_UNSUPPORTED");
    const source = nativeRoot(copiedProjectFile(home, "projects"));
    const files = threadIds.map((id) => ({ nativeId: id, role: "conversation", path: folder + "/" + id + ".jsonl" }));
    for (const relative of companionPaths) {
      const id = typeof relative === "string" ? relative.split("/")[0] : null;
      if (!threadIds.includes(id) || !relative.includes("/")) nativeFail("NATIVE_CLAUDE_COMPANION_SCOPE_UNSUPPORTED");
      files.push({ nativeId: id, role: "companion", path: folder + "/" + relative });
    }
    for (const entry of files) {
      const original = nativeRaw(source, entry.path, signal, check);
      if (entry.role === "conversation") inspectClaudeHistoryOriginal(original.raw, entry.nativeId);
    }
    check();
    const captured = captureProviderNativeHistory({
      provider: "claude",
      sourceDirectory: source,
      nativeIds: threadIds,
      files,
      reportedClientVersion: version,
      destination: captureDirectory(),
      signal,
      assertCurrentAuthority: check,
    });
    return {
      ...attach(captured.directory),
      ...base,
      nativeClientVisibility: "not-observed",
      companionSelection: companionPaths.length,
      sourceCutoff: "stable-exact-selected-files; no claim that a live source session has ended",
    };
  }
  if (threadIds !== undefined || companionPaths.length) nativeFail("PROJECT_NATIVE_SELECTION_IS_IN_PAYLOAD");
  const native = selected.native,
    plan = safePlan(home, project, native, signal, check);
  const observe = () => {
    check();
    duplicates(home, plan, signal, check);
    let matches = 0;
    for (const row of plan) {
      const relative = "projects/" + row.relative,
        file = copiedProjectFile(home, relative);
      if (!fs.existsSync(file)) continue;
      const actual = nativeRaw(home, relative, signal, check);
      if (actual.entry.sha256 !== row.entry.sha256 || actual.entry.bytes !== row.entry.bytes) return { state: "diverged" };
      matches++;
    }
    return {
      state: matches === plan.length ? "matches" : matches ? "unknown" : "absent",
      evidenceDigest: nativeHash(nativeJson(plan.map((row) => ({ path: row.relative, sha256: row.entry.sha256, bytes: row.entry.bytes })))),
    };
  };
  if (action === "register") {
    const original = observe();
    if (original.state !== "matches") return nativeOutcome("claude", { ...base, status: "native-history-not-restored", rawRestorationVerified: false });
    if (typeof host.readClaude !== "function")
      return nativeOutcome("claude", {
        ...base,
        status: "native-history-reader-unavailable",
        rawRestorationVerified: true,
        sdkHistoryVisibility: "not-observed",
        reasonCode: "NATIVE_CLAUDE_SDK_READER_UNAVAILABLE",
      });
    const result = await host.readClaude({ home, cwd: project, nativeIds: native.payload.nativeIds });
    check();
    if (!Array.isArray(result.sessions)) nativeFail("NATIVE_CLAUDE_SDK_OBSERVATION_INVALID");
    const observations = [];
    for (const id of native.payload.nativeIds) {
      const found = result.sessions.find((row) => row.sessionId === id);
      if (!found || !Array.isArray(found.messages)) nativeFail("NATIVE_CLAUDE_SDK_SELECTED_ID_NOT_OBSERVED");
      const original = plan.find((row) => row.entry.role === "conversation" && row.entry.nativeId === id);
      const records = decodeClaudeHistoryRecords(original.raw).map((row) => row.record);
      const messages = new Map(records.filter((row) => ["user", "assistant"].includes(row.type)).map((row) => [row.uuid, row]));
      const seen = new Set();
      for (const row of found.messages) {
        const source = messages.get(row.uuid);
        if (!source || seen.has(row.uuid) || !isDeepStrictEqual(source.message, row.message)) nativeFail("NATIVE_CLAUDE_SDK_HISTORY_MISMATCH");
        seen.add(row.uuid);
      }
      if (!seen.size) nativeFail("NATIVE_CLAUDE_SDK_HISTORY_EMPTY");
      observations.push({
        nativeId: id,
        sdkListed: found.listed === true,
        returnedMessagesVerified: seen.size,
        rawMessageCount: messages.size,
        rawCoverageComplete: seen.size === messages.size,
      });
    }
    if (observe().state !== "matches") nativeFail("NATIVE_CLAUDE_TARGET_CHANGED_DURING_READ");
    return nativeOutcome("claude", {
      ...base,
      status: "native-history-reader-observed",
      rawRestorationVerified: true,
      sdkHistoryVisibility: "observed-returned-records-only",
      observations,
      officialNativeOwnershipVerified: false,
    });
  }
  if (action !== "restore") nativeFail("PROJECT_NATIVE_ACTION_INVALID");
  const before = observe();
  if (before.state === "diverged")
    return nativeOutcome("claude", { ...base, status: "native-history-target-conflict", rawRestorationVerified: false, filesWritten: 0 });
  if (before.state === "matches")
    return nativeOutcome("claude", { ...base, status: "native-raw-restoration-verified", rawRestorationVerified: true, filesWritten: 0 });
  const quiet = async () => {
    check();
    const observed = await host.writers({ home, cwd: project });
    check();
    if (observed.status !== "observed" || !Array.isArray(observed.writers) || observed.writers.length) nativeFail("NATIVE_CLAUDE_WRITER_WINDOW_UNAVAILABLE");
  };
  await quiet();
  if (observe().state === "diverged")
    return nativeOutcome("claude", { ...base, status: "native-history-target-conflict", rawRestorationVerified: false, filesWritten: 0 });
  const operationRoot = copiedProjectFile(home, ".lode-native-transfer");
  fs.mkdirSync(operationRoot, { recursive: true });
  copiedProjectFile(home, ".lode-native-transfer");
  let filesWritten = 0;
  const input = {
    provider: "claude",
    profileId: "claude-jsonl-2.1.223",
    payloadDigest: native.payloadDigest,
    targetHomeDigest: nativeHash(home),
    nativeThreadId: native.payloadId,
    targetPathDigest: nativeHash(project),
    currentPolicyDigest: nativeHash("raw-only-no-prompt-no-source-permission"),
    runtimeRootsDigest: nativeHash(project),
  };
  let result;
  try {
    result = await requestNativeRegistration({
      operationRoot,
      input,
      assertCurrentAuthority: check,
      readStatus: async ({ inputDigest }) => ({ ...observe(), inputDigest }),
      register: async () => {
        for (const row of plan) {
          await quiet();
          if (observe().state === "diverged") nativeFail("NATIVE_CLAUDE_TARGET_CHANGED");
          // Reverify source and target at each dependent publication boundary.
          const raw = nativeObject(native, row.entry, signal, check);
          const relative = "projects/" + row.relative,
            file = copiedProjectFile(home, relative);
          if (fs.existsSync(file)) continue;
          fs.mkdirSync(path.dirname(file), { recursive: true });
          copiedProjectFile(home, relative);
          check();
          atomicCreateArtifact(file, raw);
          filesWritten++;
          const readback = nativeRaw(home, relative, signal, check);
          if (readback.entry.sha256 !== row.entry.sha256) nativeFail("NATIVE_CLAUDE_READBACK_MISMATCH");
        }
      },
    });
  } catch (error) {
    return nativeOutcome("claude", {
      ...base,
      status: "native-history-operation-uncertain",
      rawRestorationVerified: false,
      filesWritten,
      primaryFailure: {
        code: error.code || "NATIVE_CLAUDE_OPERATION_FAILED",
        ...(error.nativeCleanupFailure ? { cleanupFailure: error.nativeCleanupFailure } : {}),
      },
      recovery: "Inspect exact target files on a fresh authorized request; do not replay publication.",
    });
  }
  return nativeOutcome("claude", {
    ...base,
    ...result,
    status: result.status === "native-registration-verified" ? "native-raw-restoration-verified" : result.status,
    rawRestorationVerified: result.status === "native-registration-verified",
    filesWritten,
    sdkHistoryVisibility: "not-observed",
  });
}

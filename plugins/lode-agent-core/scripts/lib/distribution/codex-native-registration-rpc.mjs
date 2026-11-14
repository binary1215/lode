import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSupervisedProcess, verifyRuntimeProcessSupervisorHandle } from "../runtime/runtime-process-supervisor.mjs";
import { copiedProjectFile } from "../storage/project-copy-evidence.mjs";
import { codexNativeRegistrationScope, observeCodexNativeRegistrationWriters } from "./codex-native-offline.mjs";
import { sha256Hex as hash } from "../core/digest.mjs";
import { failCode as fail } from "../core/errors.mjs";

const methods = new Set(["config/read", "thread/resume", "thread/read", "thread/turns/list", "thread/items/list", "thread/unsubscribe"]);
const disabled = [
  "apps",
  "plugins",
  "remote_plugin",
  "plugin_discovery_prefetch",
  "daemon_auto_start",
  "auth_elicitation",
  "mcp_oauth_refresh_coordination",
  "api_key_model_discovery",
  "skill_search",
  "skill_mcp_dependency_install",
  "system_proxy_fallback",
  "code_mode_prewarm",
  "memories",
];
const terminationGraceMs = 1500;
async function observeBounded(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(
        (value) => ({ state: "resolved", value }),
        (error) => ({ state: "rejected", error }),
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ state: "timeout" }), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Dedicated finite metadata transport. The worker transport's command/method
// authority is unchanged. There is no turn/start, prompt injection, account,
// model discovery, arbitrary RPC or execution operation in this adapter.
export async function openCodexNativeRegistrationRpc({
  witness,
  supervisorSelection,
  controlFile,
  cwd,
  environment,
  nativeThreads,
  timeoutMs = 60000,
  signal,
  onEvent = () => {},
} = {}) {
  const scope = codexNativeRegistrationScope(witness),
    root = fs.realpathSync(path.resolve(cwd));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) fail("NATIVE_CODEX_RPC_LIMIT_INVALID");
  if (signal?.aborted) fail("NATIVE_CODEX_RPC_CANCELLED");
  if (!environment || fs.realpathSync(environment.CODEX_HOME) !== scope.home) fail("NATIVE_CODEX_RPC_HOME_MISMATCH");
  const allowed = new Set([
    "SystemRoot",
    "WINDIR",
    "PATH",
    "Path",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "CODEX_HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
  ]);
  const env = Object.fromEntries(Object.entries(environment).filter(([key, value]) => allowed.has(key) && typeof value === "string"));
  if (!Array.isArray(nativeThreads) || !nativeThreads.length) fail("NATIVE_CODEX_RPC_THREAD_REQUIRED");
  const targets = new Map();
  for (const entry of nativeThreads) {
    if (
      typeof entry?.threadId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(entry.threadId) ||
      typeof entry.path !== "string" ||
      !/^(?:sessions|archived_sessions)\/.+\.jsonl$/.test(entry.path) ||
      !path.basename(entry.path).endsWith("-" + entry.threadId + ".jsonl") ||
      targets.has(entry.threadId)
    )
      fail("NATIVE_CODEX_RPC_THREAD_REQUIRED");
    targets.set(entry.threadId, copiedProjectFile(scope.home, entry.path));
  }
  const deadlineAt = Date.now() + timeoutMs,
    binding = {
      kind: "native-history-metadata",
      homeDigest: hash(scope.home),
      rootDigest: hash(root),
      nonce: crypto.randomUUID(),
    };
  const record = (event) => {
    try {
      onEvent({
        ...event,
        ports: [],
        windowsHide: true,
        modelCallAttempted: false,
        authorityPlane: "P5",
      });
    } catch {}
  };
  const args = [
    "app-server",
    "--listen",
    "stdio://",
    "--strict-config",
    ...disabled.flatMap((key) => ["--disable", key]),
    "--enable",
    "skip_host_skill_discovery",
  ];
  record({
    event: "planned",
    command: scope.executable,
    args,
    cwd: root,
    parentPid: process.pid,
  });
  const handle = spawnSupervisedProcess({
    selection: supervisorSelection,
    executablePath: scope.executable,
    args,
    cwd: root,
    providerEnvironment: env,
    input: Buffer.alloc(0),
    controlFile,
    terminationGraceMs,
    ownershipBinding: binding,
    interactive: { timeoutMs },
    onControlEvent: (event) => record({ event: "supervision", control: event }),
  });
  const pending = new Map(),
    used = new Set(),
    cursors = new Map();
  let buffer = Buffer.alloc(0),
    bytes = 0,
    stderrBytes = 0,
    failure = null,
    closing = false,
    closed = false,
    closeCode = null,
    nextId = 0;
  let initialized = false;
  let terminationRequested = false;
  const terminate = (force) => {
    terminationRequested = true;
    return handle.terminate(force);
  };
  const exactClose = new Promise((resolve) =>
    handle.child.once("close", (code, processSignal) => {
      closed = true;
      closeCode = code;
      if (!closing)
        stop(
          Object.assign(Error("NATIVE_CODEX_RPC_PROVIDER_LOST"), {
            code: "NATIVE_CODEX_RPC_PROVIDER_LOST",
          }),
        );
      record({
        event: "closed",
        pid: handle.child.pid,
        parentPid: process.pid,
        code,
        signal: processSignal,
      });
      resolve();
    }),
  );
  const stop = (error) => {
    failure ??= error;
    for (const waiter of pending.values()) waiter.reject(failure);
    pending.clear();
    if (!closing)
      close().catch((error) => {
        if (failure) failure.nativeCleanupFailure = error.code || "NATIVE_CODEX_RPC_CLEANUP_UNCERTAIN";
      });
  };
  handle.child.once("error", stop);
  handle.child.stdin.on("error", stop);
  const abort = () => {
    stop(
      Object.assign(Error("NATIVE_CODEX_RPC_CANCELLED"), {
        code: "NATIVE_CODEX_RPC_CANCELLED",
      }),
    );
  };
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    stop(Object.assign(Error("NATIVE_CODEX_RPC_DEADLINE"), { code: "NATIVE_CODEX_RPC_DEADLINE" }));
  }, timeoutMs);
  handle.child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 1024 * 1024) {
      stop(
        Object.assign(Error("NATIVE_CODEX_RPC_STDERR_LIMIT"), {
          code: "NATIVE_CODEX_RPC_STDERR_LIMIT",
        }),
      );
    }
  });
  const write = (frame, beforeWrite = null) => {
    const bytes = Buffer.from(JSON.stringify(frame) + "\n");
    return handle.writeInput(bytes, {
      beforeWrite: () => {
        if (failure) throw failure;
        if (closing || closed) fail("NATIVE_CODEX_RPC_CLOSED");
        beforeWrite?.();
        codexNativeRegistrationScope(witness);
      },
      signal,
      deadlineAt,
    });
  };
  handle.child.stdout.on("data", (chunk) => {
    if (failure || closing) return;
    try {
      bytes += chunk.length;
      if (bytes > 512 * 1024 * 1024) fail("NATIVE_CODEX_RPC_OUTPUT_LIMIT");
      buffer = Buffer.concat([buffer, chunk]);
      let newline;
      while ((newline = buffer.indexOf(10)) !== -1) {
        if (newline < 1 || newline > 64 * 1024 * 1024) fail("NATIVE_CODEX_RPC_FRAME_INVALID");
        const frame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, newline)));
        buffer = buffer.subarray(newline + 1);
        if (!frame || typeof frame !== "object" || Array.isArray(frame)) fail("NATIVE_CODEX_RPC_FRAME_INVALID");
        if (frame.method) {
          // Every server action is denied. Native history and provider notifications
          // cannot gain a filesystem/tool/approval callback through this transport.
          if (frame.id !== undefined)
            write({
              id: frame.id,
              error: {
                code: -32601,
                message: "Native metadata operation does not grant server actions.",
              },
            }).catch(stop);
          continue;
        }
        const waiter = pending.get(String(frame.id));
        if (!waiter || (frame.result === undefined && frame.error === undefined)) fail("NATIVE_CODEX_RPC_RESPONSE_MISMATCH");
        if (frame.error)
          waiter.reject(
            Object.assign(Error("Native SDK request failed"), {
              code: "NATIVE_CODEX_RPC_REMOTE_ERROR",
              rpcCode: frame.error.code,
            }),
          );
        else {
          if (["thread/items/list", "thread/turns/list"].includes(waiter.method)) {
            for (const name of ["nextCursor", "backwardsCursor"]) {
              const cursor = frame.result?.[name];
              if (cursor != null) {
                if (typeof cursor !== "string" || !cursor || cursor.length > 65536) fail("NATIVE_CODEX_RPC_CURSOR_INVALID");
                const key = JSON.stringify([waiter.method, waiter.threadId, waiter.itemsView]);
                const owners = cursors.get(cursor) || new Set();
                owners.add(key);
                cursors.set(cursor, owners);
              }
            }
          }
          waiter.resolve(frame.result);
        }
        pending.delete(String(frame.id));
      }
      if (buffer.length > 64 * 1024 * 1024) fail("NATIVE_CODEX_RPC_FRAME_INVALID");
    } catch (error) {
      stop(error);
    }
  });
  record({ event: "started", pid: handle.child.pid, parentPid: process.pid, cwd: root });

  async function request(method, params, { requestId = null, beforeWrite = null } = {}) {
    if (!(method === "initialize" && !initialized) && !methods.has(method)) fail("NATIVE_CODEX_RPC_METHOD_NOT_ALLOWED");
    if (failure) throw failure;
    if (closing || closed) fail("NATIVE_CODEX_RPC_CLOSED");
    if (method.startsWith("thread/") && (typeof params?.threadId !== "string" || !targets.has(params.threadId))) fail("NATIVE_CODEX_RPC_THREAD_REQUIRED");
    if (
      method === "config/read" &&
      (params.cwd !== root || params.includeLayers !== false || Object.keys(params).some((key) => !["cwd", "includeLayers"].includes(key)))
    )
      fail("NATIVE_CODEX_RPC_PARAMS_MISMATCH");
    if (method === "thread/resume") {
      if (
        Object.keys(params).some(
          (key) =>
            ![
              "threadId",
              "path",
              "cwd",
              "runtimeWorkspaceRoots",
              "model",
              "modelProvider",
              "sandbox",
              "approvalPolicy",
              "approvalsReviewer",
              "config",
              "excludeTurns",
              "serviceTier",
            ].includes(key),
        ) ||
        path.toNamespacedPath(path.resolve(params.path || "")) !== path.toNamespacedPath(targets.get(params.threadId)) ||
        params.cwd !== root ||
        JSON.stringify(params.runtimeWorkspaceRoots) !== JSON.stringify([root]) ||
        params.excludeTurns !== true
      )
        fail("NATIVE_CODEX_RPC_PARAMS_MISMATCH");
      const config = params.config || {};
      if (
        Object.keys(config).some((key) => !["model_reasoning_effort", "mcp_servers"].includes(key)) ||
        (config.mcp_servers && Object.values(config.mcp_servers).some((value) => !value || value.enabled !== false || Object.keys(value).length !== 1))
      )
        fail("NATIVE_CODEX_RPC_PARAMS_MISMATCH");
    }
    if (method === "thread/read" && (params.includeTurns !== false || Object.keys(params).some((key) => !["threadId", "includeTurns"].includes(key))))
      fail("NATIVE_CODEX_RPC_PARAMS_MISMATCH");
    if (
      ["thread/items/list", "thread/turns/list"].includes(method) &&
      (!Number.isInteger(params.limit) ||
        params.limit < 1 ||
        params.limit > 100 ||
        Object.keys(params).some((key) => !["threadId", "limit", "cursor", "itemsView"].includes(key)))
    )
      fail("NATIVE_CODEX_RPC_PARAMS_MISMATCH");
    if (["thread/items/list", "thread/turns/list"].includes(method)) {
      if ((method === "thread/items/list" && Object.hasOwn(params, "itemsView")) || (method === "thread/turns/list" && params.itemsView !== "full"))
        fail("NATIVE_CODEX_RPC_PARAMS_MISMATCH");
      if (params.cursor != null && !cursors.get(params.cursor)?.has(JSON.stringify([method, params.threadId, params.itemsView])))
        fail("NATIVE_CODEX_RPC_CURSOR_INVALID");
    }
    if (method === "thread/unsubscribe" && Object.keys(params).length !== 1) fail("NATIVE_CODEX_RPC_PARAMS_MISMATCH");
    const id = requestId || "native-metadata-" + ++nextId;
    if (typeof id !== "string" || used.has(id)) fail("NATIVE_CODEX_RPC_REQUEST_REPLAYED");
    used.add(id);
    record({
      event: "rpc-request",
      method,
      requestId: id,
      mutation: method === "thread/resume",
    });
    return await new Promise((resolve, reject) => {
      pending.set(id, {
        resolve,
        reject,
        method,
        threadId: params?.threadId,
        itemsView: params?.itemsView,
      });
      const delivery = write({ id, method, params }, beforeWrite);
      delivery.catch((error) => {
        pending.delete(id);
        error.writeAttempted = delivery.writeAttempted;
        reject(error);
      });
    });
  }
  let closePromise = null;
  let providerBirth = null;
  const assertExclusiveWriter = async ({ onProcess } = {}) => {
    if (failure) throw failure;
    if (
      closing ||
      closed ||
      !handle.state.ownershipEstablished ||
      !handle.state.providerStarted ||
      handle.state.providerExitObserved ||
      handle.state.controlInvalid
    )
      fail("NATIVE_CODEX_RPC_WRITER_OWNERSHIP_UNAVAILABLE");
    const owner = verifyRuntimeProcessSupervisorHandle(handle, {
      ownershipBinding: binding,
      executablePathDigest: hash(path.resolve(scope.executable)),
      executionRootDigest: hash(root),
      supervisorManifestDigest: supervisorSelection.manifest.manifestHash,
    });
    const rows = await observeCodexNativeRegistrationWriters(witness, { signal, onProcess });
    for (const row of rows) {
      if (
        row.pid !== handle.state.providerPid ||
        row.parentPid !== owner.pid ||
        !Number.isFinite(Date.parse(row.birth)) ||
        Date.parse(row.birth) < owner.createdAt - 1000 ||
        (providerBirth !== null && providerBirth !== row.birth)
      )
        fail("NATIVE_CODEX_OTHER_WRITER_PRESENT");
      providerBirth = row.birth;
    }
    if (failure || closing || closed || handle.state.providerExitObserved) fail("NATIVE_CODEX_RPC_WRITER_OWNERSHIP_UNAVAILABLE");
    return { status: "only-owned-observed-writers", offlineClaim: false, authorityPlane: "P5" };
  };
  const close = () =>
    (closePromise ??= (async () => {
      closing = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      for (const waiter of pending.values())
        waiter.reject(
          failure ||
            Object.assign(Error("NATIVE_CODEX_RPC_CLOSED"), {
              code: "NATIVE_CODEX_RPC_CLOSED",
            }),
        );
      pending.clear();
      record({ event: "shutdown", phase: "eof-requested" });
      let eofState = "pending";
      const eof = Promise.resolve()
        .then(() => handle.endInput())
        .then(
          () => {
            eofState = "flushed";
            record({ event: "shutdown", phase: "eof-flushed" });
          },
          () => {
            eofState = "rejected";
            record({ event: "shutdown", phase: "eof-rejected" });
          },
        );
      const eofOutcome = await observeBounded(Promise.race([eof, exactClose]), terminationGraceMs);
      if (eofOutcome.state === "timeout") record({ event: "shutdown", phase: "eof-timeout" });
      if (!closed && eofState === "flushed") {
        record({ event: "shutdown", phase: "grace-started", budgetMs: terminationGraceMs });
        await observeBounded(exactClose, terminationGraceMs);
      }
      let forced = false;
      if (!closed) {
        forced = true;
        record({ event: "shutdown", phase: "soft-stop" });
        terminate(false);
        await observeBounded(exactClose, terminationGraceMs);
      }
      if (!closed) {
        forced = true;
        record({ event: "shutdown", phase: "hard-stop" });
        terminate(true);
        await observeBounded(exactClose, terminationGraceMs);
      }
      const cleanup = handle.finalize({
        exactSupervisorExitObserved: closed,
        terminationRequested,
      });
      record({
        event: "shutdown",
        phase: "cleanup-observed",
        exactCloseObserved: closed,
        forced,
        terminationRequested,
        exitCode: closeCode,
        treeCleanupVerified: cleanup.treeCleanupVerified,
        ownershipEstablished: cleanup.ownershipEstablished,
      });
      if (!cleanup.treeCleanupVerified || !cleanup.ownershipEstablished || !cleanup.requestWritten) fail("NATIVE_CODEX_RPC_CLEANUP_UNCERTAIN");
      if (!failure && eofOutcome.state === "timeout") fail("NATIVE_CODEX_RPC_EOF_TIMEOUT");
      if (!failure && eofState === "rejected") fail("NATIVE_CODEX_RPC_EOF_FAILED");
      if (!failure && forced) fail("NATIVE_CODEX_RPC_FORCED_SHUTDOWN");
      if (closeCode !== 0 && !failure) fail("NATIVE_CODEX_RPC_UNCLEAN_EXIT");
      return { cleanup, forced, exitCode: closeCode, modelCallAttempted: false };
    })());
  try {
    verifyRuntimeProcessSupervisorHandle(handle, {
      ownershipBinding: binding,
      executablePathDigest: hash(path.resolve(scope.executable)),
      executionRootDigest: hash(root),
      supervisorManifestDigest: supervisorSelection.manifest.manifestHash,
    });
    await request(
      "initialize",
      {
        clientInfo: { name: "lode_native_history_metadata", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      },
      { initialize: true },
    );
    initialized = true;
    await write({ method: "initialized" });
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      error.nativeCleanupFailure = cleanup.code;
    }
    throw error;
  }
  return Object.freeze({
    request,
    assertExclusiveWriter,
    close,
    scope: { home: scope.home, engineVersion: scope.engineVersion, cwd: root },
    inspect: () => ({
      closed,
      failureCode: failure?.code || null,
      modelCallAttempted: false,
      requestCount: used.size,
      stderrBytes,
    }),
  });
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveVerifiedProcessSupervisor, spawnSupervisedProcess } from "./runtime-process-supervisor.mjs";
import { assertConversationTarget } from "./conversation-mailbox-storage.mjs";

const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
async function bounded(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(
        (value) => ({ value }),
        (error) => ({ error }),
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timeout: true }), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Optional P5 transport only. Uses the existing native tree supervisor; there
// is no worker authorization, managed Run, P2 direction or new daemon here.
export function openConversationCodexProxy({
  executablePath,
  args,
  root,
  environment,
  pluginRoot,
  supervisorSelection = null,
  timeoutMs,
  signal,
  assertTarget,
}) {
  const selection = supervisorSelection || resolveVerifiedProcessSupervisor({ pluginRoot });
  const cwd = fs.realpathSync(root),
    temporaryRoot = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryRoot, "lode-conversation-proxy-"));
  const owner = fs.lstatSync(directory, { bigint: true }),
    controlFile = path.join(directory, "control.jsonl");
  const permitted = new Set([
    "PATH",
    "Path",
    "HOME",
    "USERPROFILE",
    "CODEX_HOME",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
  ]);
  const providerEnvironment = Object.fromEntries(Object.entries(environment).filter(([key, value]) => permitted.has(key) && typeof value === "string"));
  let handle;
  const removeOwnControl = () => {
    const current = fs.lstatSync(directory, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || !same(current, owner) || path.dirname(directory) !== temporaryRoot)
      fail("CONVERSATION_PROXY_CLEANUP_CHANGED");
    for (const name of fs.readdirSync(directory)) {
      if (name !== "control.jsonl") fail("CONVERSATION_PROXY_CLEANUP_CHANGED");
      const file = path.join(directory, name),
        stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("CONVERSATION_PROXY_CLEANUP_CHANGED");
      fs.unlinkSync(file);
    }
    fs.rmdirSync(directory);
  };
  try {
    handle = spawnSupervisedProcess({
      selection,
      executablePath,
      args,
      cwd,
      providerEnvironment,
      input: Buffer.alloc(0),
      controlFile,
      terminationGraceMs: 1500,
      interactive: { timeoutMs },
      ownershipBinding: { kind: "same-project-conversation-proxy", projectRoot: cwd, operation: path.basename(directory) },
    });
  } catch (error) {
    try {
      removeOwnControl();
    } catch (cleanup) {
      error.proxyCleanup = { code: cleanup.code };
    }
    throw error;
  }
  let exited = false,
    stderrBytes = 0,
    inputFailure = null;
  const closed = new Promise((resolve) => {
    handle.child.once("close", () => {
      exited = true;
      resolve();
    });
  });
  handle.child.once("error", (error) => {
    inputFailure = error;
  });
  handle.child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 1024 * 1024) {
      inputFailure = Object.assign(Error("CONVERSATION_PROXY_OUTPUT_LIMIT"), { code: "CONVERSATION_PROXY_OUTPUT_LIMIT" });
      handle.terminate(false);
    }
  });
  return {
    child: {
      stdout: handle.child.stdout,
      stdin: {
        write(line, done) {
          if (inputFailure) {
            done(inputFailure);
            return;
          }
          handle.writeInput(Buffer.from(line), { signal, beforeWrite: () => assertConversationTarget(assertTarget) }).then(() => done(), done);
        },
      },
    },
    async close() {
      let terminationRequested = false,
        primary;
      const eof = await bounded(handle.endInput(), 1500);
      if (eof.error || eof.timeout) primary = eof.error?.code || "CONVERSATION_PROXY_EOF_TIMEOUT";
      if (!exited) await bounded(closed, 1500);
      for (const force of [false, true]) {
        if (exited) break;
        terminationRequested = true;
        handle.terminate(force);
        await bounded(closed, 1500);
      }
      primary ||= inputFailure?.code;
      const supervision = handle.finalize({ exactSupervisorExitObserved: exited, terminationRequested });
      if (!exited || !supervision.ownershipEstablished || !supervision.treeCleanupVerified) primary ||= "CONVERSATION_PROXY_CLEANUP_UNVERIFIED";
      // EOF/forced cleanup is operational evidence, never model reception.
      if (exited && supervision.treeCleanupVerified) {
        try {
          removeOwnControl();
        } catch (error) {
          primary ||= error.code || "CONVERSATION_PROXY_CLEANUP_UNVERIFIED";
        }
      }
      return { verified: !primary, code: primary ?? null, supervision, providerError: inputFailure?.code ?? null };
    },
  };
}

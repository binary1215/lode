import { EventEmitter } from "node:events";
// Exact-parent test hook only: no OS process, account or model is invoked.
export function spawnSupervisedProcess(options) {
  const ctx = globalThis[Symbol.for("lode-test-native-close")];
  if (!ctx) throw Error("Missing fixture");
  ctx.options = options;
  const child = new EventEmitter();
  child.pid = 123456;
  child.stdin = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const state = {
    ownershipEstablished: true,
    providerStarted: true,
    providerExitObserved: false,
    providerPid: 123457,
    controlInvalid: false,
  };
  const schedule = (fn, delay) => {
    const timer = setTimeout(fn, delay);
    ctx.timers.push(timer);
  };
  const finish = (code) => {
    if (ctx.closed) return;
    ctx.closed = true;
    state.providerExitObserved = true;
    child.emit("close", code, null);
  };
  return {
    child,
    state,
    writeInput(raw, { beforeWrite } = {}) {
      beforeWrite?.();
      const frame = JSON.parse(raw);
      ctx.frames.push(frame);
      if (frame.id)
        queueMicrotask(() => {
          if (ctx.malformed) child.stdout.emit("data", Buffer.from("not-json\n"));
          else
            child.stdout.emit(
              "data",
              Buffer.from(JSON.stringify({ id: frame.id, result: {} }) + "\n"),
            );
        });
      const result = Promise.resolve();
      result.writeAttempted = true;
      return result;
    },
    endInput() {
      ctx.eofAt = Date.now();
      if (ctx.neverFlush) return new Promise(() => {});
      return new Promise((resolve, reject) =>
        schedule(() => {
          ctx.flushedAt = Date.now();
          if (ctx.eofReject) {
            reject(Object.assign(Error("Synthetic EOF failure"), { code: "EPIPE" }));
            return;
          }
          resolve();
          if (!ctx.neverClose) schedule(() => finish(ctx.exitCode ?? 0), ctx.exitDelay ?? 0);
        }, ctx.flushDelay ?? 0),
      );
    },
    terminate(force) {
      ctx.terminations.push({ force, at: Date.now() });
      if (!ctx.neverClose) finish(1);
    },
    finalize() {
      return {
        treeCleanupVerified: ctx.closed && !ctx.cleanupUnverified,
        ownershipEstablished: true,
        requestWritten: true,
      };
    },
  };
}
export function verifyRuntimeProcessSupervisorHandle() {
  return { pid: 123456, createdAt: Date.now() - 1000 };
}

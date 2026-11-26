import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Whether a process has ended: gone, or a zombie that Node has not reaped yet.
export function processEnded(pid) {
  if (process.platform === "win32") {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error.code === "ESRCH";
    }
  }
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
    } catch {
      return true;
    }
  }
  const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  return state.status !== 0 || state.stdout.trim() === "" || state.stdout.trim().startsWith("Z");
}

// What CPU load does to the owned close, made deterministic: once a protocol
// fixture writes fixture-input-ended into `directory`, hold this event loop
// from the check phase until the supervisor process has ended by itself and at
// least minimumMs passed. The next loop turn runs timers before it polls I/O,
// so the expired EOF-phase timer sends its stop before the close can be
// observed. No timer is shortened and no product seam is used.
export function holdLoopAfterInputEnded({ directory, supervisorPid, minimumMs, timeoutMs = 20000 }) {
  const marker = path.join(directory, "fixture-input-ended");
  const state = { held: false, endedBeforeHold: null, endedDuringHold: null };
  const poll = setInterval(() => {
    if (!fs.existsSync(marker)) return;
    clearInterval(poll);
    setImmediate(() => {
      const pid = supervisorPid();
      const start = performance.now();
      const pause = new Int32Array(new SharedArrayBuffer(4));
      state.held = true;
      state.endedBeforeHold = processEnded(pid);
      while (performance.now() - start < timeoutMs && (!processEnded(pid) || performance.now() - start < minimumMs)) Atomics.wait(pause, 0, 0, 5);
      state.endedDuringHold = processEnded(pid);
    });
  }, 5);
  return { state, stop: () => clearInterval(poll) };
}

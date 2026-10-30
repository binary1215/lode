import crypto from "node:crypto";
import path from "node:path";
import {
  buildRuntimeInvocationLifecycleReceipt,
  normalizeRuntimeEvent,
} from "./runtime-invocation-lifecycle.mjs";
import { spawnSupervisedProcess } from "./runtime-process-supervisor.mjs";
import { openRuntimeOutputSpool } from "./runtime-output-spool.mjs";

const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(compareText).map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

const canonicalJson = (value) => JSON.stringify(canonicalValue(value));

function structuredResultExposesRoot(result, roots) {
  if (!result) return false;
  const content = canonicalJson(result).toLowerCase();
  return roots.filter(Boolean).some((root) => {
    const resolved = path.resolve(root).toLowerCase();
    return content.includes(resolved) || content.includes(JSON.stringify(resolved).slice(1, -1))
      || content.includes(resolved.replaceAll("\\", "/"));
  });
}

function terminateExactTree(supervised, state, reason) {
  if (!state.childStarted || state.childExitObserved || state.terminationRequested) return;
  state.terminationRequested = true;
  if (reason === "timeout") state.timedOut = true;
  if (reason === "cancel") state.cancelled = true;
  if (reason === "output-limit") state.outputLimited = true;
  if (reason === "invalid-event") state.invalidEvent = true;
  supervised.terminate(false);
}

export async function runSupervisedRuntimeOneShot({
  runtime,
  executablePath,
  args,
  projectRoot,
  executionRoot = projectRoot,
  providerEnvironment,
  authorization,
  input,
  consumption,
  callerFenceDigest,
  signal,
  spawnImplementation,
  onProcessEvent,
  providerMode,
  sensitiveRoots,
  supervisorSelection,
  supervisorControlFile,
  commandLabel,
  spawnFailureCode,
  classifyProviderDiagnostics,
  extractStructuredResult,
  completionEventTypes,
  operationalStateRoot,
  onNeverStarted = () => {},
}) {
  if (authorization.runtime !== runtime) {
    const error = new Error("Runtime one-shot authorization does not match its provider adapter.");
    error.code = "RUNTIME_ONE_SHOT_AUTHORIZATION_MISMATCH";
    throw error;
  }
  const completionTypes = new Set(completionEventTypes);
  const state = {
    childStarted: false,
    childExitObserved: false,
    terminationRequested: false,
    timedOut: false,
    cancelled: false,
    outputLimited: false,
    invalidEvent: false,
  };
  let child;
  let supervised;
  let timer;
  let forceTimer;
  let abortHandler;
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let lineBuffer = "";
  let inputDigestObserved = digest(Buffer.alloc(0));
  let providerResult = null;
  const events = [];
  const providerDiagnosticCodes = new Set();
  const ownershipNonce = crypto.randomBytes(32).toString("hex");
  const spool = authorization.workerInput ? openRuntimeOutputSpool({ operationalRoot: operationalStateRoot,
    authorization, callerFenceDigest, supervisorManifestDigest: supervisorSelection.manifest.manifestHash, providerMode }) : null;
  let streamError = null;
  let startupError = null;
  let receipt;

  try { receipt = await new Promise((resolve, reject) => {
    let settled = false;
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
      reject(error);
    };
    try {
      supervised = spawnSupervisedProcess({
        selection: supervisorSelection,
        executablePath,
        args,
        cwd: executionRoot,
        providerEnvironment,
        input,
        controlFile: supervisorControlFile,
        terminationGraceMs: authorization.limits.terminationGraceMs,
        spawnImplementation: (...args) => {
          try { return spawnImplementation(...args); }
          catch (error) { onNeverStarted(spawnFailureCode); throw error; }
        },
        onControlEvent: (event) => {
          if (event.type === "provider.started") {
            inputDigestObserved = digest(input);
            onProcessEvent({ type: "spawn", pid: event.providerPid, parentPid: child?.pid || process.pid, command: commandLabel, cwd: executionRoot, ports: "none" });
          } else if (event.type === "provider.exited") {
            onProcessEvent({ type: "exit", pid: event.providerPid, parentPid: child?.pid || process.pid, exitCode: event.exitCode, signal: "none" });
          }
        },
      });
      child = supervised.child;
    } catch (error) {
      rejectOnce(Object.assign(new Error(`${commandLabel} could not start: ${error.message}`), { code: spawnFailureCode }));
      return;
    }
    let childFenceDigest = digest(`${callerFenceDigest}\nnot-started\n${ownershipNonce}`);
    const terminate = (reason) => {
      const before = state.terminationRequested;
      terminateExactTree(supervised, state, reason);
      if (!before && state.terminationRequested) {
        forceTimer = setTimeout(() => {
          if (!state.childExitObserved) supervised.terminate(true);
        }, authorization.limits.terminationGraceMs);
        forceTimer.unref();
      }
    };
    const consumeLine = (line) => {
      if (!line.trim()) return;
      if (events.length >= authorization.limits.maxEvents) {
        terminate("output-limit");
        return;
      }
      try {
        const record = JSON.parse(line);
        const envelope = normalizeRuntimeEvent({ authorization, sequence: events.length, line });
        events.push(envelope);
        for (const code of classifyProviderDiagnostics({ record })) providerDiagnosticCodes.add(code);
        const result = extractStructuredResult(record, { scopeKind: authorization.scope.kind });
        if (result && structuredResultExposesRoot(result, sensitiveRoots)) {
          providerDiagnosticCodes.add(`${runtime}.sensitive-root-exposure`);
          terminate("invalid-event");
        } else if (result) providerResult = result;
      } catch (error) {
        const diagnosticCode = error?.code === "RUNTIME_EVENT_LIMIT" ? `${runtime}.event-count-limit`
          : error?.code === "RUNTIME_EVENT_OUTPUT_LIMIT" ? `${runtime}.event-byte-limit`
            : error?.code === "INVALID_RUNTIME_EVENT_JSON" || error instanceof SyntaxError ? `${runtime}.invalid-json-event`
              : `${runtime}.invalid-event-unclassified`;
        providerDiagnosticCodes.add(diagnosticCode);
        terminate("invalid-event");
      }
    };
    timer = setTimeout(() => terminate("timeout"), authorization.limits.timeoutMs);
    if (signal) {
      if (signal.aborted) terminate(signal.reason?.code === "CODEX_WORKER_POLICY_TIMEOUT" ? "timeout" : "cancel");
      else {
        abortHandler = () => terminate(signal.reason?.code === "CODEX_WORKER_POLICY_TIMEOUT" ? "timeout" : "cancel");
        signal.addEventListener("abort", abortHandler, { once: true });
      }
    }
    child.once("spawn", () => {
      state.childStarted = true;
      childFenceDigest = digest(`${callerFenceDigest}\n${child.pid}\n${ownershipNonce}`);
      onProcessEvent({ type: "spawn", pid: child.pid, parentPid: process.pid, command: "head-agent process-supervisor", cwd: executionRoot, ports: "none" });
    });
    child.once("error", (error) => {
      startupError = Object.assign(new Error(`${commandLabel} child failed: ${error.message}`), { code: spawnFailureCode });
      // Wait for close before releasing ownership. Error after a start is not
      // evidence of non-start and still requires exact-tree cleanup.
      if (state.childStarted) terminate("invalid-event");
    });
    child.stdin.on("error", () => {
      inputDigestObserved = digest(Buffer.alloc(0));
    });
    child.stdout.on("data", (chunk) => {
      if (streamError) return;
      if (state.outputLimited) return;
      stdout = Buffer.concat([stdout, chunk]);
      try { if (spool && !spool.append("stdout", chunk)) { terminate("output-limit"); return; } }
      catch (error) { streamError = error; terminate("invalid-event"); return; }
      if (stdout.length > authorization.limits.maxStdoutBytes) {
        terminate("output-limit");
        return;
      }
      lineBuffer += chunk.toString("utf8");
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() || "";
      for (const line of lines) consumeLine(line);
    });
    child.stderr.on("data", (chunk) => {
      if (streamError) return;
      if (state.outputLimited) return;
      stderr = Buffer.concat([stderr, chunk]);
      try { if (spool && !spool.append("stderr", chunk)) { terminate("output-limit"); return; } }
      catch (error) { streamError = error; terminate("invalid-event"); return; }
      if (stderr.length > authorization.limits.maxStderrBytes) terminate("output-limit");
    });
    child.once("close", (code, childSignal) => {
      if (settled) return;
      settled = true;
      state.childExitObserved = true;
      if (lineBuffer.trim()) consumeLine(lineBuffer);
      onProcessEvent({ type: "exit", pid: child.pid, parentPid: process.pid, exitCode: Number.isInteger(code) ? code : null, signal: childSignal || "none" });
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
      if (startupError || streamError) {
        try {
          if (startupError && !state.childStarted && child.pid == null) onNeverStarted(spawnFailureCode);
        } catch (error) { reject(error); return; }
        reject(streamError || startupError);
        return;
      }
      const supervision = supervised.finalize({
        exactSupervisorExitObserved: state.childExitObserved,
        terminationRequested: state.terminationRequested,
      });
      if (supervision.controlInvalid) providerDiagnosticCodes.add(`${runtime}.supervisor-control-invalid`);
      if (!supervision.providerChildExitObserved && supervision.providerPid) {
        onProcessEvent({ type: "exit", pid: supervision.providerPid, parentPid: child.pid, exitCode: null, signal: state.terminationRequested ? "terminated-tree" : "unknown" });
      }
      const sessionCreated = events.some((item) => item.providerSessionReferenceDigests.length > 0);
      const completionObserved = events.some((item) => completionTypes.has(item.eventType));
      const providerOutputComplete = providerResult !== null && sessionCreated && completionObserved
        && inputDigestObserved === authorization.executionInput.digest && supervision.requestWritten;
      const status = state.cancelled ? "cancelled" : state.timedOut ? "timed-out" : state.outputLimited ? "output-limited"
        : state.invalidEvent || supervision.controlInvalid ? "invalid-event"
          : code === 0 && providerOutputComplete && supervision.ownershipEstablished && supervision.treeCleanupVerified ? "completed" : "failed";
      if (state.invalidEvent && ![...providerDiagnosticCodes].some((item) => item.startsWith(`${runtime}.`) && /(?:event|sensitive-root|supervisor)/.test(item))) {
        providerDiagnosticCodes.add(`${runtime}.invalid-event-unclassified`);
      }
      for (const diagnosticCode of classifyProviderDiagnostics({
        stderr: stderr.toString("utf8"),
        exitCode: Number.isInteger(code) ? code : null,
        structuredResultObserved: providerResult !== null,
        eventTypes: events.map((item) => item.eventType),
      })) providerDiagnosticCodes.add(diagnosticCode);
      const receiptDocument = buildRuntimeInvocationLifecycleReceipt({
        authorization,
        events: events.sort((left, right) => compareText(left.eventId, right.eventId)),
        status,
        exitCode: Number.isInteger(code) ? code : null,
        signal: childSignal || "",
        stdoutBytes: stdout.length,
        stderrBytes: stderr.length,
        stdoutDigest: digest(stdout),
        stderrDigest: digest(stderr),
        callerFenceDigest,
        childFenceDigest,
        childStarted: state.childStarted,
        childExitObserved: state.childExitObserved,
        terminationRequested: state.terminationRequested,
        projectFenceValidated: true,
        inputDigestObserved,
        noDescendantFixture: false,
        descendantTreeOwnershipValidated: supervision.ownershipEstablished && supervision.treeCleanupVerified
          && state.childStarted && state.childExitObserved,
        supervision,
        consumption,
        providerMode,
        providerSessionCreated: sessionCreated,
        providerDiagnosticCodes: [...providerDiagnosticCodes],
        structuredResult: providerResult,
      });
      const result = { receipt: receiptDocument, events, providerResult };
      try { spool?.complete(result); } catch (error) { reject(error); return; }
      resolve(result);
    });
  }); } finally { spool?.close(); }
  return receipt;
}

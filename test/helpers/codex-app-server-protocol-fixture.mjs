// Model-free local NDJSON subprocess; only installed protocol fields go on wire.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
const scenario = process.argv[2] || "normal";
if (scenario === "hold-after-eof-ignore-term") process.on("SIGTERM", () => {});
const lines = readline.createInterface({ input: process.stdin });
const timers = new Set();
let initialized = false;
let handshaken = false;
let denied = null;
let clientCalls = 0;
let nativeChild = null;
let nativeResponse = null;
let nativeFinal = null;
let nativeGoal = { objective: "Synthetic parent goal" };
const retained = () => ({ id: "cutoff", status: "completed", itemsView: "full",
  items: [{ type: "agentMessage", id: "past", text: "Synthetic public context" }] });
const write = frame => process.stdout.write(`${JSON.stringify(frame)}\n`);
const result = (id, value) => write({ id, result: value });
const thread = (id, preview = "") => ({ id, preview, cliVersion: "synthetic", createdAt: 1, updatedAt: 1,
  cwd: process.cwd(), ephemeral: true, modelProvider: "synthetic", model: "합성🙂", projectId: null,
  sessionId: "synthetic-session", source: "appServer", status: { type: "idle" }, turns: [] });
const fork = () => ({ thread: { ...thread("child"), forkedFromId: "source" }, cwd: process.cwd(),
  model: "synthetic", modelProvider: "synthetic", approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "readOnly", networkAccess: false } });
const itemParams = { threadId: "source", turnId: "historical", itemId: "denied-item", startedAtMs: 1 };
const after = (ms, action) => { const timer = setTimeout(() => { timers.delete(timer); action(); }, ms); timers.add(timer); };
lines.on("line", line => {
  const frame = JSON.parse(line);
  if (!frame.method) { denied = frame; return; }
  if (frame.method === "initialize") {
    if (initialized) process.exitCode = 7;
    initialized = true;
    if (scenario === "init-error") return write({ id: frame.id, error: { code: -32000, message: "synthetic initialization rejected" } });
    return result(frame.id, { codexHome: process.cwd(), platformFamily: process.platform === "win32" ? "windows" : "unix", platformOs: process.platform, userAgent: "synthetic/no-model" });
  }
  if (frame.method === "initialized") { handshaken = initialized; return; }
  if (!handshaken) { process.exitCode = 9; return; }
  clientCalls++;
  // Independent source-faithful negative oracle. The older native-composition
  // scenario below is only an abstract Host ownership/result simulation.
  // Do not import the production checker here: it must not test itself.
  if (scenario.startsWith("installed-native")) {
    const reject = message => write({ id: frame.id, error: { code: -32600, message } });
    const p = frame.params;
    const paginated = scenario.includes("paginated");
    const goalsEnabled = !scenario.includes("goals-disabled");
    if (frame.method === "thread/fork") {
      if (p.permissions != null && p.sandbox != null) return reject("`permissions` cannot be combined with `sandbox`");
      if (p.lastTurnId != null && p.beforeTurnId != null) return reject("`beforeTurnId` cannot be combined with `lastTurnId`");
      if (p.ephemeral && p.deferGoalContinuation) return reject("`deferGoalContinuation` cannot be combined with `ephemeral`");
      if (paginated && p.ephemeral && !p.excludeTurns) return reject("ephemeral paginated thread/fork requires `excludeTurns: true`");
      nativeChild = { ...thread("child"), ephemeral: p.ephemeral === true, forkedFromId: "source", turns: p.excludeTurns ? [] : [retained()] };
      return result(frame.id, { ...fork(), thread: nativeChild });
    }
    if (["thread/goal/get", "thread/goal/clear"].includes(frame.method)) {
      if (!goalsEnabled) return reject("goals feature is disabled");
      if (p.threadId === "child" && nativeChild?.ephemeral) return reject("ephemeral thread does not support goals: child");
      return result(frame.id, frame.method === "thread/goal/get" ? { goal: null } : { cleared: false });
    }
    if (frame.method === "thread/read") {
      if (p.threadId === "child" && nativeChild?.ephemeral && p.includeTurns) return reject("ephemeral threads do not support includeTurns");
      return result(frame.id, { thread: p.threadId === "source"
        ? { ...thread("source"), ephemeral: false, historyMode: paginated ? "paginated" : "legacy", turns: p.includeTurns ? [retained()] : [] }
        : { ...nativeChild, turns: p.includeTurns ? [retained()] : [] } });
    }
    return reject("unsupported installed-native fixture method");
  }
  if (scenario.startsWith("native-composition")) {
    if (frame.method === "thread/read") return result(frame.id, { thread: frame.params.threadId === "source"
      ? { ...thread("source"), historyMode: "legacy", turns: [{ ...retained(),
        ...(scenario === "native-composition-stale" ? { items: [] } : {}) }, { ...retained(), id: "later" }] }
      : { ...nativeChild, turns: [retained(), ...(nativeFinal ? [nativeFinal] : [])] } });
    if (frame.method === "thread/goal/get") return result(frame.id, { goal: frame.params.threadId === "source" ? { objective: "Synthetic parent goal" } : nativeGoal });
    if (frame.method === "thread/fork") {
      if (scenario === "native-composition-lost-fork") { lines.close(); process.stdin.destroy(); return; }
      nativeChild = { ...thread("child"), model: frame.params.model, modelProvider: frame.params.modelProvider,
        forkedFromId: "source", turns: [retained()] };
      nativeResponse = { thread: nativeChild, model: frame.params.model, modelProvider: frame.params.modelProvider,
        cwd: process.cwd(), runtimeWorkspaceRoots: [process.cwd()], approvalPolicy: "never", approvalsReviewer: "user",
        sandbox: { type: "readOnly", networkAccess: false }, instructionSources: [],
        activePermissionProfile: { id: scenario === "native-composition-policy-drift" ? "wrong-profile" : frame.params.permissions, extends: null } };
      return result(frame.id, nativeResponse);
    }
    if (frame.method === "thread/goal/clear") { nativeGoal = null; return result(frame.id, { cleared: true }); }
    if (frame.method === "turn/start") {
      result(frame.id, { turn: { id: "worker-turn", status: "inProgress", items: [] } });
      nativeFinal = { id: "worker-turn", status: "completed", itemsView: "full", items: [{ type: "agentMessage", id: "answer", phase: "final_answer",
        text: JSON.stringify({ schemaVersion: 1, kind: "RuntimeStructuredResult", protocolVersion: "0.1.0", outcome: "Bounded synthetic result",
          evidence: ["Model-free Host composition"], planDelta: "", impactRadius: [], verification: ["Synthetic transport only"], unknowns: [] }) }] };
      return write({ method: "turn/completed", params: { threadId: "child", turn: nativeFinal } });
    }
    return write({ id: frame.id, error: { code: -32601, message: "unsupported synthetic composition method" } });
  }
  if (scenario === "malformed") return process.stdout.write("{not-json}\n");
  if (scenario === "invalid-utf8") return process.stdout.write(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d, 0x0a]));
  if (scenario === "partial") { process.stdout.write('{"id":'); process.stdin.destroy(); lines.close(); return; }
  if (scenario === "overlong") return process.stdout.write("x".repeat(4097));
  if (scenario === "stderr-limit") return process.stderr.write("x".repeat(4097));
  if (scenario === "unknown-response") return result("unknown-request", {});
  if (scenario === "duplicate") { result(frame.id, {}); result(frame.id, {}); return; }
  if (scenario === "hang" || scenario === "ignore-eof") return;
  if (scenario === "lost-fork" && frame.method === "thread/fork") { process.stdin.destroy(); lines.close(); return; }
  if (scenario === "late-fork" && frame.method === "thread/fork") return after(2000, () => result(frame.id, fork()));
  if (scenario === "approval" && frame.method === "thread/read") {
    // The server request deliberately uses the outstanding client's ID. Its
    // method discriminator must prevent accidental client-promise resolution.
    write({ id: frame.id, method: "item/commandExecution/requestApproval", params: itemParams });
    return after(50, () => result(frame.id, { thread: thread("source", JSON.stringify(denied)) }));
  }
  if (scenario.startsWith("deny-") && frame.method === "thread/read") {
    const methods = ["item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput", "mcpServer/elicitation/request", "item/tool/call", "account/chatgptAuthTokens/refresh", "attestation/generate", "execCommandApproval", "applyPatchApproval", "unknown/server/action"];
    const params = [itemParams, { ...itemParams, cwd: process.cwd(), permissions: {} },
      { threadId: "source", turnId: "historical", itemId: "denied-item", isBlocking: true, questions: [] },
      { serverName: "synthetic", threadId: "source", mode: "openai/form", message: "denied synthetic request", requestedSchema: {} },
      { threadId: "source", turnId: "historical", callId: "synthetic-call", tool: "synthetic", arguments: {} },
      { reason: "unauthorized" }, {},
      { callId: "synthetic-call", conversationId: "source", command: [], cwd: process.cwd(), parsedCmd: [] },
      { callId: "synthetic-call", conversationId: "source", fileChanges: {} }, {}];
    const index = Number(scenario.slice(5));
    write({ id: 99, method: methods[index], params: params[index] });
    return after(40, () => result(frame.id, { thread: thread("source", JSON.stringify(denied)) }));
  }
  if (scenario === "duplicate-server") {
    write({ id: 99, method: "attestation/generate", params: {} });
    write({ id: 99, method: "attestation/generate", params: {} }); return;
  }
  if (scenario === "notifications" || scenario === "notification-limit") {
    if (frame.method === "thread/fork") {
      result(frame.id, fork());
      for (let n = 0; n < (scenario === "notification-limit" ? 9 : 1); n++) write({ method: "thread/status/changed", params: { threadId: "source", status: { type: "idle" } } });
      write({ method: "turn/completed", params: { threadId: "child", turn: { id: "turn", status: "completed", items: [] } } });
      return;
    }
  }
  if (frame.method === "thread/fork") return result(frame.id, fork());
  if (frame.method === "thread/goal/clear") return result(frame.id, { cleared: true });
  if (frame.method === "thread/goal/get") return result(frame.id, { goal: null });
  if (frame.method === "account/read") return result(frame.id, { account: null, requiresOpenaiAuth: false });
  if (frame.method === "model/list") return result(frame.id, { data: [], nextCursor: null });
  if (frame.method === "thread/read") {
    if (scenario === "nonzero-after-read") process.exitCode = 7;
    const bytes = Buffer.from(`${JSON.stringify({ id: frame.id, result: { thread: thread(frame.params.threadId) } })}\n`);
    if (scenario === "split-utf8") { for (const byte of bytes) process.stdout.write(Buffer.from([byte])); return; }
    return process.stdout.write(bytes);
  }
  write({ id: frame.id, error: { code: -32601, message: "unsupported fixture method" } });
});
lines.on("close", () => {
  for (const timer of timers) clearTimeout(timer);
  if (scenario === "hold-after-eof" || scenario === "hold-after-eof-ignore-term") {
    write({ method: "fixture/eof-observed", params: {} });
    setInterval(() => {}, 1000);
  }
  if (scenario === "ignore-eof") setInterval(() => {}, 1000);
  // Mark in the working directory that input ended, then exit by itself with 0
  // after a short while (test/helpers/late-close.mjs drives the late close).
  if (scenario === "exit-after-eof-delayed") {
    fs.writeFileSync(path.join(process.cwd(), "fixture-input-ended"), String(process.pid));
    setTimeout(() => {}, 400);
  }
});

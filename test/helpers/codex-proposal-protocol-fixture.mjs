// Fixed model-free provider fixture. No tool, account, network or model calls.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { buildCodexFreshProposalPolicyPlan } from "../../scripts/lib/runtime-codex-proposal-policy.mjs";
const scenario = process.argv[2] || "normal";
const policy = buildCodexFreshProposalPolicyPlan({ executablePath: fs.realpathSync(process.execPath), codexHome: process.env.CODEX_HOME, evidenceMode: "protocol-fixture" });
if (scenario === "environment-check") {
  if (["NODE_OPTIONS", "OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_CONFIG", "CODEX_RS_LOG"].some(key => process.env[key] !== undefined)
    || process.env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED !== "1") process.exit(12);
}
if (scenario.startsWith("features-")) {
  if (scenario === "features-hang") setInterval(() => {}, 1000);
  else {
    const output = Object.keys(policy.startupConfig.features).map(name => `${name}\texperimental\t${scenario === "features-enabled" && name === "plugins" ? "true" : "false"}`).join("\n") + "\n";
    process.stderr.write("synthetic preflight stderr\n");
    process.stdout.write(output, () => process.exit(0));
  }
}
const lines = readline.createInterface({ input: process.stdin });
const write = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const reply = (id, result) => write({ id, result });
let threadId = "synthetic-fresh-proposal-thread";
let turnId = "synthetic-fresh-proposal-turn";
const prefixMode = scenario.startsWith("prefix-");
let seedResponse = null, seedTurn = null, legacySeedTurn = null;
let initialized = false;
let started = false;
let pendingTurn = null;
let completed = false;
let overlapTimer = null;
function emitTurn(turn, eventThreadId = threadId, seed = false) {
  const name = scenario.replace(/^prefix-/, "");
  const fault = seed ? name.startsWith("seed-") ? name.slice(5) : "" : name.startsWith("seed-") ? "" : name;
  if (fault === "missing-result") turn.items = turn.items.filter(item => item.type !== "agentMessage");
  write({ method: "turn/started", params: { threadId: eventThreadId,
    turn: { id: turn.id, status: "inProgress", items: [], itemsView: "notLoaded" } } });
  for (const item of turn.items) {
    if (fault === "summary-without-direct" && item.type === "agentMessage") continue;
    write({ method: "item/started", params: { threadId: eventThreadId, turnId: turn.id, item } });
    write({ method: "item/completed", params: { threadId: eventThreadId, turnId: turn.id, item } });
  }
  const last = turn.items.findLast(item => item.type === "agentMessage");
  const unloaded = fault === "not-loaded-result" || !last || turn.status !== "completed";
  const terminal = { method: "turn/completed", params: { threadId: eventThreadId,
    turn: { ...turn, itemsView: unloaded ? "notLoaded" : "summary", items: unloaded ? [] : [structuredClone(last)] } } };
  if (fault === "summary-drift") terminal.params.turn.items[0].text += "drift";
  if (fault === "terminal-failed") { terminal.params.turn.status = "failed"; terminal.params.turn.itemsView = "notLoaded"; terminal.params.turn.items = []; }
  write(terminal);
  return terminal;
}
function complete(frame) {
  let input;
  try { input = JSON.parse(frame.params.input[0].text); } catch { input = {}; }
  // Assert what crossed the subprocess wire, not just the builder's return.
  // Every input declaring the Core Session contract must carry its fixed schema,
  // including lower-level transport fixtures that reuse that input.
  const sessionContract = input.returnContract?.kind === "SessionResultDraft";
  if (sessionContract) {
    const contract = input.returnContract, properties = frame.params.outputSchema?.properties;
    if (contract.fixedFields?.planDelta !== "" || !Array.isArray(contract.fixedFields?.impactRadius) || contract.fixedFields.impactRadius.length !== 0
      || !contract.scopeInstruction.includes("fixed values, not examples")
      || JSON.stringify(properties?.planDelta?.enum) !== '[""]'
      || properties?.impactRadius?.type !== "array" || properties.impactRadius.maxItems !== 0) {
      throw new Error("Session contract was not delivered on the exact proposal wire");
    }
  }
  const proposalBasisDigest = input.boundedWorker?.executionBoundary?.proposalBasisDigest || "0".repeat(64);
  const before = input.boundedWorker?.proposalBasis?.[0];
  // Fixed synthetic invoice peer, not a semantic engine or caller-supplied
  // reply. These implementations live only in excluded test helpers and are
  // never inserted into the worker input or selected workspace.
  const invoice = {
    "invoice-subtotal-v1": "export function subtotalCents(lines) { let sum = 0; for (const line of lines) sum += line.unitCents * line.quantity; return sum; }\n",
    "invoice-tax-v1": "export function taxCents(subtotalCents, basisPoints) { return Math.floor(subtotalCents * basisPoints / 10000 + 0.5); }\n",
  }[input.boundedWorker?.taskKey];
  const result = { schemaVersion: 1, kind: "RuntimeStructuredResult", protocolVersion: "0.2.0",
    outcome: "Synthetic fresh proposal only", evidence: ["Model-free subprocess protocol fixture",
      ...(sessionContract ? ["Session fixed output contract observed on wire"] : [])], planDelta: "", impactRadius: [],
    verification: ["No task effects performed"], unknowns: [], patchProposal: { proposalBasisDigest,
      changes: before ? [{ path: input.boundedWorker?.taskKey === "fixture-invoice-out-of-scope" ? "src/outside.mjs" : before.path,
        after: { contentBase64: Buffer.from(scenario === "encoded-sensitive-result" ? `${threadId}\n${process.cwd()}\n` : invoice || "synthetic proposed bytes\n").toString("base64"), mode: before.mode ?? 438 } }] : [] } };
  const terminal = emitTurn({ id: ["wrong-event-turn", "prefix-wrong-event-turn"].includes(scenario) ? "other-turn" : turnId,
    status: scenario === "prefix-child-failed" ? "failed" : "completed", error: null, itemsView: "full",
    items: [{ type: "reasoning", id: "synthetic-reasoning", summary: [], content: [] },
      { type: "agentMessage", id: "synthetic-proposal-result", text: JSON.stringify(result), phase: "final_answer" }] },
    ["wrong-event-thread", "prefix-wrong-event-thread"].includes(scenario) ? "unowned-thread" : threadId);
  completed = true;
  if (["duplicate-completion", "prefix-duplicate-completion"].includes(scenario)) write(terminal);
  if (["trailing-effect", "prefix-trailing-effect"].includes(scenario)) write({ method: "item/started", params: { threadId, turnId, item: { type: "commandExecution", id: "forbidden-after-terminal" } } });
}
lines.on("close", () => {
  if (overlapTimer) clearInterval(overlapTimer);
  if (scenario === "trailing-partial" && completed) process.stdout.write('{"id":');
});
lines.on("line", line => {
  const frame = JSON.parse(line);
  if (!frame.method) {
    if (pendingTurn) {
      if (frame.result?.decision !== "cancel") { process.exitCode = 8; lines.close(); return; }
      const saved = pendingTurn; pendingTurn = null; complete(saved);
    }
    return;
  }
  if (frame.method === "initialize") return reply(frame.id, { codexHome: process.env.CODEX_HOME,
    platformFamily: process.platform === "win32" ? "windows" : "unix", platformOs: process.platform, userAgent: "synthetic/no-model" });
  if (frame.method === "initialized") { initialized = true; return; }
  if (!initialized) { process.exitCode = 9; lines.close(); return; }
  if (frame.method === "config/read") {
    const config = structuredClone(policy.startupConfig);
    if (prefixMode) config.show_raw_agent_reasoning = scenario === "prefix-raw-config-drift";
    if (scenario === "enabled-mcp") config.mcp_servers.unapproved = { enabled: true };
    return reply(frame.id, { config, origins: {}, layers: null });
  }
  if (frame.method === "skills/list") return reply(frame.id, { data: [{ cwd: process.cwd(), errors: [],
    skills: scenario === "enabled-skill" ? [{ path: process.cwd() + "/SKILL.md", enabled: true }] : [] }] });
  if (frame.method === "account/read") return reply(frame.id, { account: { type: "chatgpt", email: null, planType: "unknown" }, requiresOpenaiAuth: true });
  if (frame.method === "model/list") return reply(frame.id, { data: ["catalog-incomplete", "model-unavailable"].includes(scenario) ? [] : [{ id: policy.wireModel, model: policy.wireModel, hidden: false,
    inputModalities: ["text"], availabilityNux: null }], nextCursor: scenario === "catalog-incomplete" ? "synthetic-next-page" : null });
  if (prefixMode && frame.method === "thread/read") {
    if (frame.params.threadId !== "synthetic-fresh-proposal-thread" || !seedTurn) throw new Error("source-only read required");
    // Independent, source-faithful legacy projection for this fixed seed:
    // empty reasoning/text are filtered, adjacent reasoning is merged, raw
    // content is omitted, and all surviving items get new item-N identities.
    const turns = [{ ...structuredClone(seedTurn), items: [
      { ...structuredClone(seedTurn.items[0]), id: "item-1" },
      { type: "reasoning", id: "item-2", summary: ["seed context", "second piece"], content: [] },
      { ...structuredClone(seedTurn.items.at(-1)), id: "item-3" },
    ] }];
    if (scenario === "prefix-stored-reordered") [turns[0].items[1], turns[0].items[2]] = [turns[0].items[2], turns[0].items[1]];
    if (scenario === "prefix-stored-duplicate") turns[0].items.push(structuredClone(turns[0].items.at(-1)));
    if (scenario === "prefix-stored-missing") turns[0].items.splice(1, 1);
    if (scenario === "prefix-stored-extra") turns[0].items.push({ type: "agentMessage", id: "item-4", text: "extra", phase: "commentary" });
    if (scenario === "prefix-stored-tool") turns[0].items.push({ type: "dynamicToolCall", id: "item-4" });
    if (scenario === "prefix-stored-input-drift") turns[0].items[0].content[0].text += "drift";
    if (scenario === "prefix-stored-reasoning-drift") turns[0].items[1].summary.reverse();
    if (scenario === "prefix-stored-agent-field-drift") turns[0].items[2].phase = "commentary";
    if (scenario === "prefix-source-summary-read") { turns[0].itemsView = "summary"; turns[0].items = turns[0].items.filter(item => item.type === "agentMessage"); }
    if (scenario === "prefix-history-drift") turns[0].items[0].text = "changed";
    legacySeedTurn = structuredClone(turns[0]);
    return reply(frame.id, { thread: { ...seedResponse.thread, turns } });
  }
  if (prefixMode && frame.method === "thread/fork") {
    if (frame.params.ephemeral !== true || frame.params.deferGoalContinuation || frame.params.lastTurnId !== turnId
      || frame.params.threadId !== threadId || !seedTurn || frame.params.path) throw new Error("invalid controlled fork");
    if (scenario === "prefix-lost-fork") { lines.close(); process.stdin.destroy(); return; }
    const sourceId = threadId;
    threadId = "synthetic-prefix-child"; turnId = "synthetic-prefix-child-turn";
    return reply(frame.id, { ...seedResponse, thread: { ...seedResponse.thread, id: threadId, ephemeral: true,
      path: null, forkedFromId: sourceId, turns: [legacySeedTurn] } });
  }
  if (frame.method === "thread/start") {
    if (started) { process.exitCode = 10; lines.close(); return; }
    started = true;
    if (scenario === "lost-start") { lines.close(); process.stdin.destroy(); return; }
    if (scenario === "early-notification") write({ method: "thread/started", params: { thread: { id: "unowned-notification-thread" } } });
    const params = frame.params;
    const thread = { id: threadId, sessionId: "synthetic-proposal-session", preview: "", cliVersion: "synthetic",
      createdAt: 1, updatedAt: 1, cwd: process.cwd(), ephemeral: true, model: params.model, modelProvider: params.modelProvider,
      source: "appServer", status: { type: "idle" }, turns: [], forkedFromId: null, parentThreadId: null, path: null };
    const response = { thread, cwd: process.cwd(), runtimeWorkspaceRoots: [], model: params.model, modelProvider: params.modelProvider,
      approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "readOnly", networkAccess: false }, instructionSources: [] };
    if (prefixMode) {
      if (params.ephemeral !== false || params.historyMode !== "legacy" || JSON.stringify(params.dynamicTools) !== "[]") throw new Error("source recipe mismatch");
      thread.ephemeral = false; thread.historyMode = "legacy"; seedResponse = structuredClone(response);
    }
    if (scenario === "wrong-model") response.model = "other-model";
    if (scenario === "wrong-root") response.cwd = process.cwd() + "/other";
    if (scenario === "wrong-policy") response.approvalPolicy = "on-request";
    if (scenario === "inherited-thread") thread.forkedFromId = "existing-source";
    return reply(frame.id, response);
  }
  if (frame.method === "turn/start") {
    if (!started || frame.params.threadId !== threadId) { process.exitCode = 11; lines.close(); return; }
    if (scenario === "lost-turn") { lines.close(); process.stdin.destroy(); return; }
    if (scenario === "hang-turn") return;
    reply(frame.id, { turn: { id: turnId, status: "inProgress", items: scenario === "start-effect-item"
      ? [{ type: "commandExecution", id: "forbidden-in-start-response" }] : [] } });
    if (prefixMode && threadId === "synthetic-fresh-proposal-thread") {
      seedTurn = { id: turnId, status: "completed", itemsView: "full", items: [
        { type: "userMessage", id: "live-seed-user-uuid", clientId: null, content: structuredClone(frame.params.input) },
        { type: "reasoning", id: "seed-reasoning-empty", summary: [], content: [] },
        { type: "reasoning", id: "seed-reasoning", summary: ["seed context", ""], content: ["raw omitted from legacy"] },
        { type: "agentMessage", id: "seed-empty-agent", text: "", phase: "commentary" },
        { type: "reasoning", id: "seed-reasoning-2", summary: ["second piece"], content: [] },
        { type: "agentMessage", id: "seed-ack", text: JSON.stringify({ seed: "HEAD_NATIVE_PREFIX_SEED_READY" }),
          phase: "final_answer", memoryCitation: null, delivery: null, questions: null }] };
      if (scenario === "prefix-source-tools") seedTurn.items.push({ type: "dynamicToolCall", id: "unapproved-tool" });
      emitTurn(seedTurn, threadId, true); return;
    }
    // Fixed test-only fault: keep one owned turn pending until public cancellation.
    // This is not a Host wire option and the helper is excluded from distribution.
    let taskKey;
    try { taskKey = JSON.parse(frame.params.input[0].text).boundedWorker?.taskKey; } catch {}
    if (scenario === "normal" && taskKey === "fixture-hold-until-cancel") {
      process.stderr.write(JSON.stringify({ fixtureEvent: "held-turn-started", pid: process.pid, parentPid: process.ppid, ports: [] }) + "\n");
      return;
    }
    if (scenario === "normal" && /^fixture-overlap-(left|right)$/.test(taskKey || "")) {
      // Fixed synthetic-only barrier in this fixture's disposable home. The
      // production policy/transport gets no timer, concurrency or fault option.
      const observe = phase => process.stderr.write(JSON.stringify({ fixtureEvent: `overlap-turn-${phase}`,
        taskKey, pid: process.pid, parentPid: process.ppid, threadId, turnId,
        monotonicNs: process.hrtime.bigint().toString(), wallTimeMs: Date.now(), ports: [] }) + "\n");
      observe("start");
      const expires = Date.now() + 20000;
      overlapTimer = setInterval(() => {
        if (fs.existsSync(path.join(process.env.CODEX_HOME, "fixture-overlap.release"))) {
          clearInterval(overlapTimer); overlapTimer = null; observe("end"); complete(frame);
        } else if (Date.now() > expires) {
          clearInterval(overlapTimer); overlapTimer = null; process.exitCode = 23; lines.close(); process.stdin.destroy();
        }
      }, 20);
      return;
    }
    if (scenario === "approval") {
      pendingTurn = frame;
      write({ id: "synthetic-denied-action", method: "item/commandExecution/requestApproval",
        params: { threadId, turnId, itemId: "denied-command" } });
      return;
    }
    complete(frame); return;
  }
  write({ id: frame.id, error: { code: -32601, message: "Unsupported model-free fixture method" } });
});

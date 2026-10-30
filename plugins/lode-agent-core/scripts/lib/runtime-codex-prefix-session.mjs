import crypto from "node:crypto";
import { verifyCodexNativePrefixPolicyPlan, codexNativePrefixSeedThreadParams, codexNativePrefixSeedTurnParams,
  codexNativePrefixForkParams, CODEX_NATIVE_PREFIX_SEED_REPLY } from "./runtime-codex-prefix-policy.mjs";
import { codexFreshProposalTurnParams, assertCodexFreshProposalInstructionSources } from "./runtime-codex-proposal-policy.mjs";
import { assertCodexProposalCompletion } from "./runtime-codex-turn-evidence.mjs";
import { assertCodexControlledLegacyPrefix } from "./runtime-codex-legacy-prefix.mjs";

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const json = value => JSON.stringify(canonical(value));
const same = (a, b) => json(a) === json(b);
const copy = value => structuredClone(value);
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const text = value => typeof value === "string" && value.length > 0;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const allowedItems = new Set(["userMessage", "agentMessage", "reasoning"]);

// Concrete P5 protocol state, not a source-provenance boolean from a caller.
// The only source admitted here is the exact thread created by this connection.
// No arbitrary thread/path, goal API, resume, or child history read is exposed.
export function createCodexNativePrefixSession({ policy, executionRoot, inputDigest, resultSchema }) {
  const fixed = verifyCodexNativePrefixPolicyPlan(policy);
  if (!resultSchema || typeof resultSchema !== "object" || Array.isArray(resultSchema) || resultSchema.type !== "object") fail("CODEX_NATIVE_PREFIX_SCHEMA_REQUIRED");
  const outputSchema = copy(resultSchema);
  let sourceId = null, sourceTurnId = null, childId = null, childTurnId = null;
  let sourceComplete = false, childComplete = false, prefix = null;
  const slots = new Set();
  const items = { source: new Map(), child: new Map() };
  const sourceParams = codexNativePrefixSeedThreadParams({ policy: fixed, executionRoot });
  const inspect = () => ({ sourceId, sourceTurnId, childId, childTurnId, sourceComplete, childComplete,
    prefixObserved: prefix !== null, childHistoryReadback: false, childGoalReadback: false });
  const params = (method, input) => {
    if (method === "thread/start") return sourceParams;
    if (method === "thread/read") return { threadId: sourceId, includeTurns: true };
    if (method === "thread/fork") return codexNativePrefixForkParams({ policy: fixed, executionRoot, sourceThreadId: sourceId, lastTurnId: sourceTurnId });
    if (method === "turn/start") return childId
      ? codexFreshProposalTurnParams({ policy: fixed.recipe, threadId: childId, input, outputSchema })
      : codexNativePrefixSeedTurnParams({ policy: fixed, threadId: sourceId });
    fail("CODEX_NATIVE_PREFIX_METHOD_FORBIDDEN");
  };
  const reserve = (method, supplied) => {
    const slot = method === "turn/start" ? `${method}:${childId ? "child" : "source"}` : method;
    if (slots.has(slot)) fail("CODEX_NATIVE_PREFIX_REPLAY");
    if (method === "thread/start" && sourceId || method === "thread/read" && (!sourceComplete || childId)
      || method === "thread/fork" && (!prefix || !sourceComplete || childId)
      || method === "turn/start" && (!sourceId || (childId ? childComplete : sourceComplete))) fail("CODEX_NATIVE_PREFIX_SEQUENCE");
    const input = supplied?.input?.[0]?.text;
    if (method === "turn/start" && childId && (typeof input !== "string" || digest(input) !== inputDigest)) fail("CODEX_NATIVE_PREFIX_INPUT_DRIFT");
    if (!same(supplied, params(method, input))) fail("CODEX_NATIVE_PREFIX_PARAMS_MISMATCH");
    slots.add(slot);
  };
  const verifyThread = (response, ephemeral) => {
    const thread = response?.thread;
    if (!text(thread?.id) || thread.status?.type !== "idle" || thread.ephemeral !== ephemeral
      || thread.historyMode !== "legacy" || response.model !== fixed.wireModel || response.modelProvider !== fixed.wireModelProvider
      || thread.model != null && thread.model !== fixed.wireModel || thread.modelProvider !== fixed.wireModelProvider
      || response.cwd !== executionRoot || thread.cwd !== executionRoot || !same(response.runtimeWorkspaceRoots, [])
      || response.approvalPolicy !== "never" || response.approvalsReviewer !== "user"
      || response.sandbox?.type !== "readOnly" || response.sandbox.networkAccess !== false) fail("CODEX_NATIVE_PREFIX_THREAD_MISMATCH");
    assertCodexFreshProposalInstructionSources({ policy: fixed.recipe, instructionSources: response.instructionSources });
    return thread;
  };
  const response = (method, value) => {
    if (method === "thread/start") {
      const thread = verifyThread(value, false);
      if (sourceId || thread.forkedFromId != null || thread.parentThreadId != null || !Array.isArray(thread.turns) || thread.turns.length) fail("CODEX_NATIVE_PREFIX_SOURCE_NOT_FRESH");
      sourceId = thread.id;
    } else if (method === "turn/start") {
      const turn = value?.turn;
      if (!text(turn?.id) || turn.error != null || !["inProgress", "completed"].includes(turn.status)
        || !Array.isArray(turn.items) || turn.items.some(item => !allowedItems.has(item?.type))) fail("CODEX_NATIVE_PREFIX_TURN_MISMATCH");
      if (childId) { if (turn.id === sourceTurnId) fail("CODEX_NATIVE_PREFIX_TURN_MISMATCH"); childTurnId = turn.id; }
      else sourceTurnId = turn.id;
    } else if (method === "thread/read") {
      const thread = value?.thread, turns = thread?.turns;
      if (thread?.id !== sourceId || thread.ephemeral !== false || thread.historyMode !== "legacy" || thread.status?.type !== "idle"
        || !Array.isArray(turns) || turns.length !== 1 || turns[0].id !== sourceTurnId || turns[0].status !== "completed"
        || turns[0].error != null || turns[0].itemsView && turns[0].itemsView !== "full"
        || !Array.isArray(turns[0].items) || turns[0].items.some(item => !allowedItems.has(item?.type))) fail("CODEX_NATIVE_PREFIX_SOURCE_HISTORY_MISMATCH");
      assertCodexControlledLegacyPrefix({ liveItems: [...items.source.values()], storedItems: turns[0].items,
        seedInput: codexNativePrefixSeedTurnParams({ policy: fixed, threadId: sourceId }).input[0].text });
      prefix = copy(turns);
    } else if (method === "thread/fork") {
      const thread = verifyThread(value, true);
      if (thread.id === sourceId || thread.forkedFromId !== sourceId || thread.parentThreadId != null
        || !same(thread.turns, prefix)) fail("CODEX_NATIVE_PREFIX_FORK_HISTORY_MISMATCH");
      childId = thread.id;
    } else fail("CODEX_NATIVE_PREFIX_METHOD_FORBIDDEN");
  };
  const notification = frame => {
    const which = childId ? "child" : "source", id = childId || sourceId, turnId = childId ? childTurnId : sourceTurnId;
    const turnEvent = ["turn/started", "turn/completed"].includes(frame.method), itemEvent = frame.method?.startsWith("item/");
    if (/commandExecution|fileChange|mcpToolCall|dynamicToolCall|webSearch|imageGeneration|collabAgent/u.test(frame.method || "")
      || frame.params?.item && !allowedItems.has(frame.params.item.type)) fail("CODEX_NATIVE_PREFIX_EFFECT_REJECTED");
    if (turnEvent || itemEvent) {
      if (!turnId || frame.params?.threadId !== id || (turnEvent ? frame.params.turn?.id : frame.params.turnId) !== turnId
        || (childId ? childComplete : sourceComplete)) fail("CODEX_NATIVE_PREFIX_UNEXPECTED_CONTINUATION");
    }
    const collect = item => {
      if (!allowedItems.has(item?.type) || !text(item.id)) fail("CODEX_NATIVE_PREFIX_EFFECT_REJECTED");
      const prior = items[which].get(item.id);
      if (prior && (which === "source" || !same(prior, item))) fail("CODEX_NATIVE_PREFIX_ITEM_DRIFT");
      items[which].set(item.id, copy(item));
    };
    if (frame.method === "item/completed") collect(frame.params.item);
    if (frame.method === "turn/completed") {
      const turn = frame.params.turn;
      assertCodexProposalCompletion(turn, items[which]);
      if (!childId) {
        const answers = [...items.source.values()].filter(item => item.type === "agentMessage" && item.text !== "" && item.phase !== "commentary");
        let answer;
        try { answer = JSON.parse(answers[0]?.text); } catch { fail("CODEX_NATIVE_PREFIX_SEED_ACK_MISMATCH"); }
        if (answers.length !== 1 || !same(answer, { seed: CODEX_NATIVE_PREFIX_SEED_REPLY })) fail("CODEX_NATIVE_PREFIX_SEED_ACK_MISMATCH");
        sourceComplete = true;
      } else childComplete = true;
    }
  };
  return Object.freeze({ params: (method, input) => copy(params(method, input)), reserve, response, notification, inspect });
}

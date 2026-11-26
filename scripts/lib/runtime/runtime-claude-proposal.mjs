import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildRuntimeInvocationCallerFence,
  buildRuntimeResultPacketDraft,
  prepareRuntimeInvocationExecution,
  verifyRuntimeInvocationAuthorization,
  verifyRuntimeStructuredResult,
} from "./runtime-invocation-lifecycle.mjs";
import {
  createRuntimePreConsumeGateCapability,
  recordRuntimeInvocationStartFailure,
  verifyRuntimeExecutionLeaseOwnership,
  withRuntimeExecutionLease,
} from "./runtime-execution-lease.mjs";
import { persistRuntimeInvocationRecord } from "./runtime-invocation-record.mjs";
import { resolveVerifiedProcessSupervisor, verifyProcessSupervisorManifest } from "./runtime-process-supervisor.mjs";
import { runSupervisedRuntimeOneShot } from "./runtime-supervised-one-shot.mjs";
import { classifyClaudeProviderDiagnostics } from "./runtime-claude-print.mjs";
import { buildCodexProposalResultSchema, assertCodexFreshProposalResultBoundary } from "./runtime-codex-proposal.mjs";
import {
  assertClaudeFreshProposalPolicy,
  claudeFreshProposalArguments,
  claudeFreshProposalEnvironment,
  verifyClaudeFreshProposalPolicyPlan,
} from "./runtime-claude-proposal-policy.mjs";
import { sha256Hex as hash } from "../core/digest.mjs";
import { failCode as fail } from "../core/errors.mjs";

const pluginRoot = path.resolve(import.meta.dirname, "..", "..", "..");
// Model-free stand-in for `claude --print`. It runs only under a
// protocol-fixture policy (the current Node executable) and can never produce
// an actual-provider receipt; neither the script nor its scenario is input.
const PROPOSAL_FIXTURE = fileURLToPath(new URL("../../../test/helpers/claude-proposal-protocol-fixture.mjs", import.meta.url));
const json = (value) => JSON.stringify(value);

function operationalDirectory(operationalRoot, authorization) {
  const parents = [path.join(operationalRoot, "runtime-claude-proposals")];
  parents.push(path.join(parents[0], authorization.projectId));
  const directory = path.join(parents[1], authorization.authorizationId);
  for (const item of [...parents, directory]) {
    try {
      fs.mkdirSync(item, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stat = fs.lstatSync(item);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(item) !== item) fail("CLAUDE_FRESH_PROPOSAL_UNSAFE_OPERATIONAL_PATH");
  }
  const controlFile = path.join(directory, "supervisor-control.jsonl");
  return {
    controlFile,
    cleanup() {
      if (fs.realpathSync(directory) !== directory) fail("CLAUDE_FRESH_PROPOSAL_UNSAFE_OPERATIONAL_PATH");
      const expected = fs.existsSync(controlFile) ? ["supervisor-control.jsonl"] : [];
      if (json(fs.readdirSync(directory).sort()) !== json(expected)) fail("CLAUDE_FRESH_PROPOSAL_UNEXPECTED_OPERATIONAL_FILE");
      if (fs.existsSync(controlFile)) {
        const stat = fs.lstatSync(controlFile);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("CLAUDE_FRESH_PROPOSAL_UNSAFE_OPERATIONAL_PATH");
        fs.unlinkSync(controlFile);
      }
      fs.rmdirSync(directory);
      for (const parent of [...parents].reverse()) {
        if (fs.readdirSync(parent).length) break;
        if (fs.realpathSync(parent) !== parent || fs.lstatSync(parent).isSymbolicLink()) fail("CLAUDE_FRESH_PROPOSAL_UNSAFE_OPERATIONAL_PATH");
        fs.rmdirSync(parent);
      }
    },
  };
}

const sameList = (value, expected) => Array.isArray(value) && json(value) === json(expected);

// Reads one stream-json record. The init record must show the recipe in effect:
// only the structured output tool, no MCP server, no skill or command. Any
// other tool call is an effect request and stops the run. Only a schema-valid
// structured_output that stays inside the proposal basis becomes a result.
export function createClaudeProposalStreamReader({ authorization, forbidden }) {
  const codes = new Set();
  const reject = (code, message) => {
    codes.add(code);
    throw Object.assign(new Error(message), { code: "CLAUDE_FRESH_PROPOSAL_RECIPE_NOT_IN_EFFECT" });
  };
  const extract = (record) => {
    if (record?.type === "system" && record.subtype === "init") {
      if (
        !sameList(record.tools, ["StructuredOutput"]) ||
        !sameList(record.mcp_servers, []) ||
        (record.skills !== undefined && !sameList(record.skills, [])) ||
        (record.slash_commands !== undefined && !sameList(record.slash_commands, []))
      )
        reject("claude.recipe-not-in-effect", "The Claude worker started with tools, servers or skills outside its recipe.");
      return null;
    }
    if (record?.type === "assistant") {
      const content = Array.isArray(record.message?.content) ? record.message.content : [];
      if (content.some((block) => block?.type === "tool_use" && block.name !== "StructuredOutput"))
        reject("claude.effect-tool-rejected", "The Claude worker requested a tool outside its recipe.");
      return null;
    }
    if (record?.type !== "result" || record.is_error === true || record.structured_output === undefined) return null;
    try {
      const result = verifyRuntimeStructuredResult(record.structured_output, { scopeKind: authorization.scope.kind, authorization });
      if (result?.protocolVersion !== "0.2.0") fail("CLAUDE_FRESH_PROPOSAL_RESULT_VERSION");
      assertCodexFreshProposalResultBoundary(result, forbidden);
      return result;
    } catch {
      codes.add("claude.proposal-result-rejected");
      return null;
    }
  };
  const classify = (options) => {
    const found = new Set(classifyClaudeProviderDiagnostics(options));
    const record = options?.record;
    // A provider refusal retried by the CLI shows only as retry events.
    if (record?.type === "system" && record.subtype === "api_retry" && (record.error_status === 429 || record.error === "rate_limit"))
      found.add("claude.rate-limit");
    if (!record) for (const code of codes) found.add(code);
    return [...found].sort();
  };
  return { extract, classify, codes };
}

export async function executeClaudeFreshProposalInvocation({
  root = ".",
  authorization,
  policy,
  workspaceBinding,
  supervisorSelection = null,
  environment = null,
  signal = null,
  onProcessEvent = () => {},
  spawnImplementation = spawn,
  persist = true,
  verifyWorkspace,
} = {}) {
  const verified = verifyRuntimeInvocationAuthorization(authorization);
  const fixed = verifyClaudeFreshProposalPolicyPlan(policy);
  const actual = fixed.evidenceMode === "actual-provider";
  const assertCurrent = () => {
    if (signal?.aborted) fail("CLAUDE_FRESH_PROPOSAL_CANCELLED");
    return assertClaudeFreshProposalPolicy({ root, authorization: verified, policy: fixed, workspaceBinding, verifyWorkspace });
  };
  const checked = assertCurrent();
  const prepared = prepareRuntimeInvocationExecution({ root, authorization: verified });
  const inputBytes = Buffer.from(prepared.input);
  if (
    !Buffer.from(checked.input).equals(inputBytes) ||
    !Buffer.from(inputBytes.toString("utf8")).equals(inputBytes) ||
    inputBytes.length !== verified.executionInput.bytes ||
    hash(inputBytes) !== verified.executionInput.digest ||
    checked.inputDigest !== verified.executionInput.digest
  )
    fail("CLAUDE_FRESH_PROPOSAL_INPUT_DRIFT");
  const resultSchema = buildCodexProposalResultSchema(verified.scope.kind);
  const providerArgs = claudeFreshProposalArguments({ policy: fixed, resultSchema });
  const providerEnvironment = claudeFreshProposalEnvironment({ policy: fixed, environment: environment ?? process.env });
  const selection = supervisorSelection || resolveVerifiedProcessSupervisor({ pluginRoot });
  verifyProcessSupervisorManifest(selection.manifest);
  const callerFenceDigest = buildRuntimeInvocationCallerFence(prepared.projectRoot, verified.authorizationId);
  const providerMode = actual ? "actual-claude" : "claude-protocol-fixture";
  const preConsumeGate = createRuntimePreConsumeGateCapability(({ commitConsumption }) => {
    assertCurrent();
    commitConsumption();
  });
  const leased = await withRuntimeExecutionLease(
    { projectRoot: prepared.projectRoot, authorization: verified, ownerFenceDigest: callerFenceDigest },
    async ({ lease, consumption, operationalStateRoot }) => {
      verifyRuntimeExecutionLeaseOwnership({ projectRoot: prepared.projectRoot, authorization: verified, operationalStateRoot, lease, consumption });
      const forbidden = [prepared.projectRoot, checked.executionRoot, operationalStateRoot, ...Object.values(fixed.providerProfile)];
      const reader = createClaudeProposalStreamReader({ authorization: verified, forbidden });
      let files;
      try {
        files = operationalDirectory(operationalStateRoot, verified);
        // The one-shot process exits by itself after its result. It is stopped
        // only on timeout, cancellation or an output/event limit, exactly as the
        // attached Claude adapter; a stopped provider never yields success.
        return await runSupervisedRuntimeOneShot({
          runtime: "claude",
          executablePath: fixed.executablePath,
          args: actual ? providerArgs : [PROPOSAL_FIXTURE, ...providerArgs],
          projectRoot: prepared.projectRoot,
          executionRoot: checked.executionRoot,
          providerEnvironment,
          authorization: verified,
          input: prepared.input,
          consumption,
          callerFenceDigest,
          signal,
          spawnImplementation,
          onProcessEvent,
          providerMode,
          sensitiveRoots: forbidden,
          supervisorSelection: selection,
          supervisorControlFile: files.controlFile,
          commandLabel: "claude --print (fresh proposal)",
          spawnFailureCode: "CLAUDE_FRESH_PROPOSAL_SPAWN_FAILED",
          classifyProviderDiagnostics: reader.classify,
          extractStructuredResult: reader.extract,
          completionEventTypes: ["result"],
          operationalStateRoot,
          onNeverStarted: (errorCode) =>
            recordRuntimeInvocationStartFailure({ projectRoot: prepared.projectRoot, authorization: verified, lease, consumption, errorCode }),
        });
      } finally {
        files?.cleanup();
      }
    },
    { preConsumeGate },
  );
  const draft = buildRuntimeResultPacketDraft({
    authorization: verified,
    receipt: leased.result.receipt,
    leaseRelease: leased.release,
    providerResult: leased.result.providerResult,
  });
  const record = persist
    ? persistRuntimeInvocationRecord({
        projectRoot: prepared.projectRoot,
        authorization: verified,
        events: leased.result.events,
        receipt: leased.result.receipt,
        draft,
      })
    : { recorded: false, eventCount: leased.result.events.length, receiptId: leased.result.receipt.receiptId, draftId: draft.draftId };
  return {
    status: leased.result.receipt.status === "completed" ? "provider_invocation_completed" : "provider_invocation_finished_with_evidence",
    authorizationId: verified.authorizationId,
    scopeKind: verified.scope.kind,
    runtime: "claude",
    providerMode,
    actualProviderInvoked: leased.result.receipt.providerBoundary.actualProviderInvoked,
    descendantTreeOwnershipValidated: leased.result.receipt.processBoundary.descendantTreeOwnershipValidated,
    receipt: leased.result.receipt,
    draft,
    executionLease: { consumption: leased.consumption, release: leased.release },
    record,
  };
}

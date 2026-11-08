import {
  prepareCodexRegistrationGroup,
  persistCodexRegistrationGroup,
  assertCodexRegistrationGroupCurrent,
  assertCodexRegistrationMetadata,
  codexRegistrationInitialMetadataDigest,
  codexRegistrationMetadataDigest,
  recordCodexRegistrationMember,
  readCodexRegistrationMember,
} from "./codex-native-registration-group.mjs";
import {
  CODEX_NATIVE_TARGET_CHOICE_COLUMNS,
  observeCodexNativeTargetChoices,
  verifyCodexNativeTargetChoices,
  backupCodexNativeTargetChoices,
} from "./codex-native-target-choices.mjs";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nativeSqlitePath } from "./codex-native-backup.mjs";
import { codexNativeRegistrationScope, assertCodexNativeOffline } from "./codex-native-offline.mjs";
import { inspectCodexNativePayload } from "./codex-native-payload.mjs";
import { inspectCodexNativeDatabase, readSelectedCodexHistory } from "./codex-native-portability.mjs";
import { copiedProjectFile, inspectCopiedProjectFile } from "./project-copy-evidence.mjs";
import { decodeSqliteCell, readTypedSqliteRows } from "./native-sqlite-values.mjs";
import { codexNativeApiExpectation, readCodexNativeApiHistory } from "./codex-native-api-evidence.mjs";
import { requestNativeRegistration, inspectNativeRegistration } from "./native-registration-journal.mjs";
import { openCodexNativeRegistrationRpc } from "./codex-native-registration-rpc.mjs";
import { createHasher, sha256Hex as hash, sha256Json as digest } from "./core/digest.mjs";
import { failCode as fail } from "./core/errors.mjs";

const samePath = (left, right) => nativeSqlitePath(path.resolve(left)) === nativeSqlitePath(path.resolve(right));
const canonical = (rows) => rows.map((row) => JSON.stringify(row)).sort();

// Registration may append an SDK context/projection record. Original raw bytes
// remain an exact prefix, and existing visible turns/items remain exact typed
// rows. A new user/model turn is divergence, not a retry of the import.
function verifyPublishedOriginals(inspected, home, basis, signal) {
  for (const entry of inspected.payload.files) {
    const sha = createHasher("sha256");
    let remaining = entry.bytes;
    const observed = inspectCopiedProjectFile(home, entry.path, {
      signal,
      onChunk(chunk) {
        const prefix = chunk.subarray(0, remaining);
        sha.update(prefix);
        remaining -= prefix.length;
      },
    });
    if (remaining || observed.bytes < entry.bytes || sha.digest("hex") !== entry.sha256) fail("NATIVE_CODEX_REGISTER_RAW_DIVERGED");
  }
  const db = new DatabaseSync(nativeSqlitePath(copiedProjectFile(home, "thread_history_1.sqlite")), { readOnly: true });
  try {
    const actual = readSelectedCodexHistory(db, {
      ...basis,
      threadIds: inspected.payload.threadIds,
    });
    for (const expected of inspected.payload.history.tables) {
      const table = actual.tables.find((value) => value.name === expected.name);
      if (expected.name !== "thread_history_projection_state") {
        if (JSON.stringify(canonical(table.rows)) !== JSON.stringify(canonical(expected.rows))) fail("NATIVE_CODEX_REGISTER_HISTORY_DIVERGED");
        continue;
      }
      const record = (row) => Object.fromEntries(expected.columns.map((key, index) => [key, decodeSqliteCell(row[index])]));
      const byId = new Map(table.rows.map(record).map((row) => [row.thread_id, row]));
      if (byId.size !== expected.rows.length) fail("NATIVE_CODEX_REGISTER_HISTORY_DIVERGED");
      for (const row of expected.rows.map(record)) {
        const current = byId.get(row.thread_id);
        for (const key of expected.columns) {
          if (key === "next_rollout_byte_offset" || key === "next_rollout_ordinal") {
            if (current?.[key] < row[key]) fail("NATIVE_CODEX_REGISTER_HISTORY_DIVERGED");
          } else if (current?.[key] !== row[key]) fail("NATIVE_CODEX_REGISTER_HISTORY_DIVERGED");
        }
      }
    }
  } finally {
    db.close();
  }
}

function targetMetadata(home, basis, entry) {
  const db = new DatabaseSync(nativeSqlitePath(copiedProjectFile(home, "state_5.sqlite")), {
    readOnly: true,
  });
  try {
    inspectCodexNativeDatabase(db, { ...basis, file: "state_5.sqlite" });
    // No account columns or source row is read/applied. Existing target choices
    // are never overwritten merely because a new global default is available.
    const rows = readTypedSqliteRows(db, "threads", CODEX_NATIVE_TARGET_CHOICE_COLUMNS, {
      where: 'WHERE "id" = ?',
      parameters: [entry.threadId],
    });
    if (rows.length > 1) fail("NATIVE_CODEX_TARGET_THREAD_BINDING_DIVERGED");
    const record = rows[0] ? Object.fromEntries(CODEX_NATIVE_TARGET_CHOICE_COLUMNS.map((key, index) => [key, decodeSqliteCell(rows[0][index])])) : null;
    const row = record ? { id: record.id, rollout_path: record.rollout_path, protectedOriginals: rows[0] } : null;
    if (row && (!row.rollout_path || !samePath(row.rollout_path, copiedProjectFile(home, entry.path)))) fail("NATIVE_CODEX_TARGET_THREAD_BINDING_DIVERGED");
    return row || null;
  } finally {
    db.close();
  }
}

export function selectCodexNativeRegistrationPolicy(config) {
  const selected = {
    model: config?.model,
    modelProvider: config?.model_provider,
    approvalPolicy: config?.approval_policy,
    sandbox: config?.sandbox_mode,
    reasoningEffort: config?.model_reasoning_effort,
    // This pinned SDK resolves an explicit null tier to its "default" tier.
    // Send that concrete current default so source history cannot supply one.
    serviceTier: config?.service_tier ?? "default",
    approvalsReviewer: config?.approvals_reviewer ?? "user",
  };
  if (
    [selected.model, selected.modelProvider, selected.reasoningEffort].some((value) => typeof value !== "string" || !value) ||
    !["never", "on-request", "on-failure", "untrusted"].includes(selected.approvalPolicy) ||
    !["read-only", "workspace-write", "danger-full-access"].includes(selected.sandbox) ||
    (selected.serviceTier !== null && typeof selected.serviceTier !== "string")
  )
    fail("NATIVE_CODEX_CURRENT_POLICY_UNRESOLVED");
  // The pinned SDK's measured path-resume did not reproduce workspace-write
  // effective sandbox settings, even with default options. Preserve the
  // native originals without issuing an unqualified policy-changing resume.
  if (selected.sandbox === "workspace-write") fail("NATIVE_CODEX_WORKSPACE_POLICY_PROFILE_UNVERIFIED");
  if (!["user", "auto_review", "guardian_subagent"].includes(selected.approvalsReviewer)) fail("NATIVE_CODEX_CURRENT_POLICY_UNRESOLVED");
  selected.expectedSandbox = selected.sandbox === "read-only" ? { type: "readOnly", networkAccess: false } : { type: "dangerFullAccess" };
  return selected;
}

export function verifyCodexNativeRegistrationPolicy(resumed, policy, threadId, root) {
  const rootsEqual = (left, right) =>
    Array.isArray(left) && left.length === right.length && left.every((value, index) => typeof value === "string" && samePath(value, right[index]));
  if ((resumed?.serviceTier ?? null) !== policy.serviceTier) {
    const label = (value) => (value == null ? "none" : ["auto", "default", "standard", "fast", "flex", "priority"].includes(value) ? value : "unrecognized");
    fail("NATIVE_CODEX_EFFECTIVE_POLICY_MISMATCH_serviceTier_" + label(policy.serviceTier) + "_to_" + label(resumed?.serviceTier));
  }
  const checks = {
    identity: resumed?.thread?.id === threadId,
    threadCwd: typeof resumed?.thread?.cwd === "string" && samePath(resumed.thread.cwd, root),
    cwd: typeof resumed?.cwd === "string" && samePath(resumed.cwd, root),
    runtimeRoots: rootsEqual(resumed?.runtimeWorkspaceRoots, [root]),
    serviceTier: (resumed?.serviceTier ?? null) === policy.serviceTier,
    approvalsReviewer: resumed?.approvalsReviewer === policy.approvalsReviewer,
    model: resumed?.model === policy.model,
    modelProvider: resumed?.modelProvider === policy.modelProvider,
    approvalPolicy: resumed?.approvalPolicy === policy.approvalPolicy,
    reasoningEffort: resumed?.reasoningEffort === policy.reasoningEffort,
  };
  for (const [field, matched] of Object.entries(checks)) if (!matched) fail("NATIVE_CODEX_EFFECTIVE_POLICY_MISMATCH_" + field);
  const actual = resumed.sandbox,
    expected = policy.expectedSandbox;
  if (!actual || Object.keys(actual).some((key) => !Object.hasOwn(expected, key))) fail("NATIVE_CODEX_EFFECTIVE_POLICY_MISMATCH_sandbox_shape");
  for (const key of Object.keys(expected)) {
    if (key === "writableRoots") {
      if (!rootsEqual(actual[key], expected[key]))
        fail(
          "NATIVE_CODEX_EFFECTIVE_POLICY_MISMATCH_sandbox_writableRoots_" +
            expected[key].length +
            "_to_" +
            (Array.isArray(actual[key]) ? actual[key].length : "invalid"),
        );
    } else if (actual[key] !== expected[key]) fail("NATIVE_CODEX_EFFECTIVE_POLICY_MISMATCH_sandbox_" + key);
  }
  // The legacy sandbox view cannot prove a named permission profile. Preserve
  // the returned evidence and stop this native action rather than flattening
  // or silently changing that profile. Ordinary Core work remains available.
  if ((resumed.activePermissionProfile ?? null) !== null) fail("NATIVE_CODEX_NAMED_PERMISSION_PROFILE_UNVERIFIED");
  const local = resumed.thread.environments?.filter((entry) => entry.environmentId === "local");
  if (local?.length !== 1 || !samePath(local[0].cwd, root) || !rootsEqual(local[0].runtimeWorkspaceRoots, [root]))
    fail("NATIVE_CODEX_EFFECTIVE_POLICY_MISMATCH_localEnvironment");
}

// This identity describes current target configuration sources, not a claim
// that a home file alone resolves every managed SDK policy layer. The SDK
// resolves and checks effective policy inside the journaled lifecycle. No
// configuration values, secrets or historical source settings are persisted.
function currentConfigurationBasis(home, root, environment) {
  const files = [
    [home, "config.toml"],
    [root, ".codex/config.toml"],
  ].map(([base, relative]) => {
    const file = copiedProjectFile(base, relative);
    const observed = fs.existsSync(file) ? inspectCopiedProjectFile(base, relative) : null;
    return { pathDigest: hash(file), sha256: observed?.sha256 || null };
  });
  return digest({
    files,
    root,
    metadataProfile: "finite-no-model-v1",
    environmentHomes: ["HOME", "USERPROFILE", "CODEX_HOME", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"].map((key) => [
      key,
      environment?.[key] ?? null,
    ]),
  });
}

// The whole SDK lifecycle (including initialize's implicit discovery writes)
// is one journaled delivery. Unknown initialization is never replayed. A saved
// verified view plus current raw/typed originals supports read reconciliation;
// a newly discovered state row alone cannot establish SDK/policy verification.
export async function registerCodexNativeHistory({
  witness,
  directory,
  expectedPayloadId = null,
  cwd,
  environment,
  supervisorSelection,
  controlFile,
  timeoutMs = 60000,
  signal,
  onEvent,
  onProcess,
  assertCurrentAuthority = () => {},
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) fail("NATIVE_CODEX_RPC_LIMIT_INVALID");
  const deadlineAt = Date.now() + timeoutMs;
  const authority = () => {
    if (signal?.aborted) fail("NATIVE_CODEX_REGISTRATION_CANCELLED");
    if (Date.now() >= deadlineAt) fail("NATIVE_CODEX_REGISTRATION_DEADLINE");
    const checked = assertCurrentAuthority();
    if (checked && typeof checked.then === "function") {
      Promise.resolve(checked).catch(() => {});
      fail("NATIVE_CODEX_SYNCHRONOUS_AUTHORITY_REQUIRED");
    }
  };
  const inspected = inspectCodexNativePayload({ directory, expectedPayloadId, signal });
  if (!inspected.mechanicalOriginalsReady)
    return {
      status: "native-originals-partial",
      persisted: false,
      ordinaryCoreBlocked: false,
      continuationReady: false,
    };
  const scope = codexNativeRegistrationScope(witness),
    home = scope.home,
    root = fs.realpathSync(path.resolve(cwd)),
    basis = {
      engineVersion: scope.engineVersion,
      platform: process.platform,
      architecture: process.arch,
    };
  const inside = (base, file) => {
    const relative = path.relative(base, file);
    return !relative || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
  };
  if (inside(home, inspected.directory) || inside(inspected.directory, home)) fail("NATIVE_CODEX_SOURCE_TARGET_OVERLAP");
  const expectations = new Map(inspected.payload.threadIds.map((id) => [id, codexNativeApiExpectation(inspected.payload.history, id)]));
  verifyPublishedOriginals(inspected, home, basis, signal);
  const initialMetadata = new Map(inspected.payload.files.map((entry) => [entry.threadId, targetMetadata(home, basis, entry)]));
  let expectedMetadata;
  const readMetadataSet = () => new Map(inspected.payload.files.map((file) => [file.threadId, targetMetadata(home, basis, file)]));
  const assertMetadataSet = (expected) => {
    const observed = readMetadataSet();
    if (!(expected instanceof Map)) return assertCodexRegistrationMetadata(group, observed, expected);
    for (const [id, row] of expected) if (JSON.stringify(observed.get(id)) !== JSON.stringify(row)) fail("NATIVE_CODEX_REGISTRATION_TARGET_APPEARED");
  };
  const choiceOptions = { signal, deadlineAt, assertCurrentAuthority: authority };
  const unrelatedChoices = observeCodexNativeTargetChoices({
    home,
    basis,
    selectedThreadIds: inspected.payload.threadIds,
    ...choiceOptions,
  });
  const policyBasisDigest = currentConfigurationBasis(home, root, environment);
  const operationRoot = copiedProjectFile(home, ".lode-native-portability");
  authority();
  fs.mkdirSync(operationRoot, { recursive: true });
  const operationRootOriginal = fs.lstatSync(copiedProjectFile(home, ".lode-native-portability"), { bigint: true });
  const assertOperationRoot = () => {
    const current = fs.lstatSync(copiedProjectFile(home, ".lode-native-portability"), {
      bigint: true,
    });
    if (!current.isDirectory() || current.dev !== operationRootOriginal.dev || current.ino !== operationRootOriginal.ino)
      fail("NATIVE_CODEX_REGISTRATION_OPERATION_ROOT_CHANGED");
  };
  const group = prepareCodexRegistrationGroup({
    operationRoot,
    identity: {
      provider: "codex",
      profileId: inspected.payload.profileId,
      payloadDigest: inspected.payloadDigest,
      targetHomeDigest: hash(home),
    },
    selection: inspected.payload.files.map((file) => ({
      threadId: file.threadId,
      targetPathDigest: hash(copiedProjectFile(home, file.path)),
    })),
    metadata: initialMetadata,
  });
  const memberInput = (entry) => ({
    provider: "codex",
    profileId: inspected.payload.profileId,
    payloadDigest: inspected.payloadDigest,
    targetHomeDigest: hash(home),
    nativeThreadId: entry.threadId,
    targetPathDigest: hash(copiedProjectFile(home, entry.path)),
    currentPolicyDigest: policyBasisDigest,
    runtimeRootsDigest: digest([root]),
    preparationDigest: group.groupDigest,
  });
  let lastProgressDigest = null,
    prefixOpen = true;
  const savedProgress = new Map();
  // Reconstruct only a journal-verified prefix. A standalone snapshot never
  // completes an uncertain SDK attempt or permits a new delivery.
  for (const [index, file] of inspected.payload.files.entries()) {
    const saved = inspectNativeRegistration({ operationRoot, input: memberInput(file) });
    if (saved.status !== "verified") {
      prefixOpen = false;
      continue;
    }
    if (!prefixOpen) fail("NATIVE_CODEX_REGISTRATION_GROUP_NONCONTIGUOUS");
    const progress = readCodexRegistrationMember(group, {
      index,
      operationId: saved.operationId,
      inputDigest: saved.inputDigest,
      previousProgressDigest: lastProgressDigest,
      evidenceDigest: saved.evidenceDigest,
    });
    savedProgress.set(index, progress);
    expectedMetadata = progress.selectedMetadata;
    lastProgressDigest = progress.progressDigest;
  }
  const results = [];
  let freshLifecycleCount = 0;
  let explicitResumeRequestedThisCall = false;
  let sdkLifecycleRequestedThisCall = false;
  const localBeforeBackups = [];
  for (const [index, entry] of inspected.payload.files.entries()) {
    const verifyCurrentOriginals = () => {
      authority();
      assertOperationRoot();
      assertCodexRegistrationGroupCurrent(group);
      codexNativeRegistrationScope(witness);
      const current = inspectCodexNativePayload({
        directory,
        expectedPayloadId: inspected.payloadId,
        signal,
      });
      if (current.payloadDigest !== inspected.payloadDigest) fail("NATIVE_CODEX_PAYLOAD_IDENTITY_MISMATCH");
      if (currentConfigurationBasis(home, root, environment) !== policyBasisDigest) fail("NATIVE_CODEX_CURRENT_CONFIGURATION_CHANGED");
      verifyPublishedOriginals(inspected, home, basis, signal);
      verifyCodexNativeTargetChoices(unrelatedChoices, choiceOptions);
    };
    const input = memberInput(entry);
    let completedEvidence = null;
    const readStatus = async ({ inputDigest }) => {
      verifyCurrentOriginals();
      const saved = inspectNativeRegistration({ operationRoot, input });
      const evidenceDigest = completedEvidence?.evidenceDigest || (saved.status === "verified" ? savedProgress.get(index)?.evidenceDigest : null);
      if (evidenceDigest && targetMetadata(home, basis, entry)) return { inputDigest, state: "matches", evidenceDigest };
      return { inputDigest, state: "absent" };
    };
    const existing = inspectNativeRegistration({ operationRoot, input });
    if (existing.status === "not-started") {
      await assertCodexNativeOffline(witness, { signal, onProcess });
      verifyCurrentOriginals();
      assertMetadataSet(expectedMetadata);
      // A verified local backup is preparation, not SDK delivery. Failed
      // preparation leaves no SDK attempt, so the exact request can safely
      // prepare again. Existing uncertain attempts are never cleared/replayed.
      const beforeBackup = await backupCodexNativeTargetChoices(unrelatedChoices, {
        operationRoot,
        operationId: existing.operationId,
        ...choiceOptions,
      });
      localBeforeBackups.push({
        path: beforeBackup.path,
        sha256: beforeBackup.sha256,
        bytes: beforeBackup.bytes,
        scope: beforeBackup.scope,
      });
      await assertCodexNativeOffline(witness, { signal, onProcess });
      verifyCurrentOriginals();
      assertMetadataSet(expectedMetadata);
      persistCodexRegistrationGroup(group);
    }
    const result = await requestNativeRegistration({
      operationRoot,
      input,
      readStatus,
      assertCurrentAuthority: verifyCurrentOriginals,
      register: async ({ requestId, inputDigest }) => {
        verifyCurrentOriginals();
        await assertCodexNativeOffline(witness, { signal, onProcess });
        verifyCurrentOriginals();
        const previous = codexRegistrationInitialMetadataDigest(group, entry.threadId);
        assertMetadataSet(expectedMetadata);
        sdkLifecycleRequestedThisCall = true;
        const rpc = await openCodexNativeRegistrationRpc({
          witness,
          supervisorSelection,
          controlFile: controlFile + "." + entry.threadId,
          cwd: root,
          environment,
          nativeThreads: inspected.payload.files.map((file) => ({
            threadId: file.threadId,
            path: file.path,
          })),
          timeoutMs,
          signal,
          onEvent,
        });
        freshLifecycleCount++;
        let primary = null,
          evidence = null,
          ownClosureMetadata = null;
        try {
          await rpc.assertExclusiveWriter({ onProcess });
          const response = await rpc.request("config/read", {
            cwd: root,
            includeLayers: false,
          });
          verifyCurrentOriginals();
          if (!previous) {
            const policy = selectCodexNativeRegistrationPolicy(response?.config);
            const mcpDisabled = Object.fromEntries(Object.keys(response.config.mcp_servers || {}).map((key) => [key, { enabled: false }]));
            await rpc.assertExclusiveWriter({ onProcess });
            verifyCurrentOriginals();
            explicitResumeRequestedThisCall = true;
            const resumed = await rpc.request(
              "thread/resume",
              {
                threadId: entry.threadId,
                path: copiedProjectFile(home, entry.path),
                cwd: root,
                runtimeWorkspaceRoots: [root],
                model: policy.model,
                modelProvider: policy.modelProvider,
                approvalPolicy: policy.approvalPolicy,
                approvalsReviewer: policy.approvalsReviewer,
                sandbox: policy.sandbox,
                serviceTier: policy.serviceTier,
                config: {
                  model_reasoning_effort: policy.reasoningEffort,
                  mcp_servers: mcpDisabled,
                },
                excludeTurns: true,
              },
              { requestId, beforeWrite: verifyCurrentOriginals },
            );
            verifyCodexNativeRegistrationPolicy(resumed, policy, entry.threadId, root);
          } else if (codexRegistrationMetadataDigest(targetMetadata(home, basis, entry)) !== previous) {
            fail("NATIVE_CODEX_EXISTING_TARGET_METADATA_CHANGED");
          }
          const metadata = await rpc.request("thread/read", {
            threadId: entry.threadId,
            includeTurns: false,
          });
          if (metadata?.thread?.id !== entry.threadId || !samePath(metadata.thread.path, copiedProjectFile(home, entry.path)))
            fail("NATIVE_CODEX_TARGET_THREAD_BINDING_DIVERGED");
          evidence = await readCodexNativeApiHistory(rpc, expectations.get(entry.threadId));
          await rpc.assertExclusiveWriter({ onProcess });
          verifyCurrentOriginals();
          if (previous && codexRegistrationMetadataDigest(targetMetadata(home, basis, entry)) !== previous)
            fail("NATIVE_CODEX_EXISTING_TARGET_METADATA_CHANGED");
          await rpc.request("thread/unsubscribe", { threadId: entry.threadId });
          await rpc.assertExclusiveWriter({ onProcess });
          ownClosureMetadata = readMetadataSet();
        } catch (error) {
          primary = error;
          throw error;
        } finally {
          try {
            await rpc.close();
          } catch (error) {
            if (primary) primary.nativeCleanupFailure = error.code;
            else throw error;
          }
        }
        // Only a fully read-verified AND cleaned-up lifecycle may be durable
        // completion. SDK startup, a state row or an uncertain response cannot.
        verifyCurrentOriginals();
        verifyCodexNativeTargetChoices(unrelatedChoices, choiceOptions);
        assertMetadataSet(ownClosureMetadata);
        const progress = recordCodexRegistrationMember(group, {
          index,
          operationId: requestId,
          inputDigest,
          previousProgressDigest: lastProgressDigest,
          metadata: ownClosureMetadata,
          apiEvidenceDigest: evidence.evidenceDigest,
        });
        expectedMetadata = progress.selectedMetadata;
        lastProgressDigest = progress.progressDigest;
        completedEvidence = progress;
      },
    });
    results.push({
      threadId: entry.threadId,
      ...result,
      verificationFreshness: completedEvidence
        ? "fresh-sdk-view"
        : result.status === "native-registration-verified"
          ? "saved-sdk-view-and-current-originals"
          : "no-completed-sdk-view",
    });
    if (result.status !== "native-registration-verified") break;
  }
  return {
    status:
      results.length === inspected.payload.threadIds.length && results.every((result) => result.status === "native-registration-verified")
        ? "native-registered-read-verified"
        : "native-registration-incomplete",
    results,
    payloadId: inspected.payloadId,
    nativeRegistration: "version-scoped-sdk-metadata",
    sdkLifecycleRequestedThisCall,
    localBeforeBackups,
    explicitResumeRequestedThisCall,
    sdkMayHaveChangedMetadataThisCall: sdkLifecycleRequestedThisCall,
    targetChoicePreservation: "preexisting-protected-fields-checked; new-discovery/cache-fields-are-distinct",
    continuationReady: false,
    currentInstructionBinding: "not-verified",
    ordinaryCoreBlocked: false,
    authorityPlane: "P5",
    grantsRecoveryAuthority: false,
    restoresExecutionPermission: false,
    modelCallAttempted: false,
    automaticReplayAllowed: false,
  };
}

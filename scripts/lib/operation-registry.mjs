// One operation registry for the MCP server (scripts/mcp-server.mjs) and the CLI
// (scripts/lode.mjs). Each entry is one operation:
//   name   the internal operation name (resolveOperation(name).semanticName);
//   tool   the MCP tool definition, listed by allTools at its original position;
//   mcp    args(arguments, context) -> the implementation's argument list;
//   cli    command, the option names it reads, and args(context) -> argument list;
//   impl   lazy loader of the scripts/lib implementation.
// Both surfaces call impl()(...args). Surface-specific defaults stay explicit in
// each args function (for example CLI numbers arrive as text). Operations not yet
// listed here keep their original MCP/CLI dispatch branches.
// test/dispatch-recordings.test.mjs pins the call each surface makes.
import { resolveOperation } from "./lode-operation-contract.mjs";
import { sessionWorkEvidenceSchema } from "./tool-schemas.mjs";

const waitTimeout = (options) => (options["wait-timeout-ms"] == null ? 0 : Number(options["wait-timeout-ms"]));

function onlyFields(input, allowed, label) {
  const permitted = new Set(allowed);
  const unexpected = Object.keys(input).filter((key) => !permitted.has(key));
  if (unexpected.length) throw new Error(`${label} contains unsupported fields: ${unexpected.sort().join(", ")}`);
  return input;
}

export const OPERATIONS = Object.freeze([
  {
    name: "head_bounded_worker_job_status",
    tool: {
      name: "head_bounded_worker_job_status",
      description: "Read the same immutable bounded worker job after frontend loss. This does not relaunch, repair P2, or infer success from a spool alone.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: {
            type: "string",
            minLength: 1,
          },
          authorization_id: {
            type: "string",
            pattern: "^execution-authorization-[a-f0-9]{24}$",
          },
        },
        required: ["project_root", "authorization_id"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    mcp: {
      args: (args, { onProcess, workerJobSupervisor }) => [
        { root: args.project_root, authorizationId: args.authorization_id },
        { onProcess, inspectorSelection: workerJobSupervisor },
      ],
    },
    cli: {
      command: "worker-job-status",
      flags: ["authorization"],
      args: ({ root, options, onProcess, workerJobSupervisor }) => [
        { root, authorizationId: options.authorization },
        { onProcess, inspectorSelection: workerJobSupervisor },
      ],
    },
    impl: () => import("./bounded-worker-job.mjs").then((module) => module.readBoundedWorkerJob),
  },
  {
    name: "head_bounded_worker_job_reconcile",
    tool: {
      name: "head_bounded_worker_job_reconcile",
      description:
        "Reconcile an exited worker against exact cleanup, durable lease and bounded provider output. Restore only missing matching P3 invocation evidence; never infer a release, relaunch, apply a result, or change P2.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: {
            type: "string",
            minLength: 1,
          },
          authorization_id: {
            type: "string",
            pattern: "^execution-authorization-[a-f0-9]{24}$",
          },
        },
        required: ["project_root", "authorization_id"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    mcp: {
      args: (args, { onProcess, workerJobSupervisor }) => [
        { root: args.project_root, authorizationId: args.authorization_id },
        { onProcess, inspectorSelection: workerJobSupervisor },
      ],
    },
    cli: {
      command: "worker-job-reconcile",
      flags: ["authorization"],
      args: ({ root, options, onProcess, workerJobSupervisor }) => [
        { root, authorizationId: options.authorization },
        { onProcess, inspectorSelection: workerJobSupervisor },
      ],
    },
    impl: () => import("./bounded-worker-job.mjs").then((module) => module.reconcileBoundedWorkerJob),
  },
  {
    name: "head_bounded_worker_cancel",
    tool: {
      name: "head_bounded_worker_cancel",
      description:
        "Request cancellation of one exact owned bounded job. A request is not proof of cleanup; inspect until terminal and owner exit are verified. No arbitrary PID or path is accepted.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: {
            type: "string",
            minLength: 1,
          },
          authorization_id: {
            type: "string",
            pattern: "^execution-authorization-[a-f0-9]{24}$",
          },
        },
        required: ["project_root", "authorization_id"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    mcp: {
      args: (args, { onProcess, workerJobSupervisor }) => [
        { root: args.project_root, authorizationId: args.authorization_id },
        { onProcess, inspectorSelection: workerJobSupervisor },
      ],
    },
    cli: {
      command: "worker-cancel",
      flags: ["authorization"],
      args: ({ root, options, onProcess, workerJobSupervisor }) => [
        { root, authorizationId: options.authorization },
        { onProcess, inspectorSelection: workerJobSupervisor },
      ],
    },
    impl: () => import("./bounded-worker-job.mjs").then((module) => module.cancelBoundedWorkerJob),
  },
  {
    name: "head_bounded_worker_job_patch",
    tool: {
      name: "head_bounded_worker_job_patch",
      description:
        "Read exact owner-frozen workspace patch evidence bound to native terminal output and invocation lineage. This never applies edits, approves them or changes P2; later child edits cannot replace the frozen candidate.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: {
            type: "string",
            minLength: 1,
          },
          authorization_id: {
            type: "string",
            pattern: "^execution-authorization-[a-f0-9]{24}$",
          },
        },
        required: ["project_root", "authorization_id"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    mcp: {
      args: (args, { onProcess, workerJobSupervisor }) => [
        { root: args.project_root, authorizationId: args.authorization_id },
        { onProcess, inspectorSelection: workerJobSupervisor },
      ],
    },
    cli: {
      command: "worker-job-patch",
      flags: ["authorization"],
      args: ({ root, options, onProcess, workerJobSupervisor }) => [
        { root, authorizationId: options.authorization },
        { onProcess, inspectorSelection: workerJobSupervisor },
      ],
    },
    impl: () => import("./bounded-worker-job.mjs").then((module) => module.readBoundedWorkerPatch),
  },
  {
    name: "head_bounded_worker_reconcile",
    tool: {
      name: "head_bounded_worker_reconcile",
      description:
        "Recover a current logical worker's exact frozen authorization after interrupted publication, without recapturing changed or missing source files. This repairs only missing lookup records; it never launches, retries, grants new authority, or changes P2 recovery direction.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          task_key: { type: "string", pattern: "^[a-z][a-z0-9-]{0,95}$" },
        },
        required: ["project_root", "task_key"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root, taskKey: args.task_key }] },
    cli: { command: "worker-reconcile", flags: ["task-key"], args: ({ root, options }) => [{ root, taskKey: options["task-key"] }] },
    impl: () => import("./runtime-invocation-lifecycle.mjs").then((module) => module.reconcileWorkerMember),
  },
  {
    name: "head_bounded_worker_dispatch",
    tool: {
      name: "head_bounded_worker_dispatch",
      description:
        "Create or verify one P3 non-HEAD worker ownership record bound to an exact current Run or idle Session ExecutionAuthorization. Execute via CLI worker-execute; for Session pass --input with the exact sessionRequest. This cannot change WholePlan, recovery direction, or review state.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          authorization_id: { type: "string", pattern: "^execution-authorization-[a-f0-9]{24}$" },
          role: { type: "string", enum: ["developer", "coder", "reviewer"] },
        },
        required: ["project_root", "authorization_id", "role"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root, authorizationId: args.authorization_id, role: args.role }] },
    cli: {
      command: "worker-dispatch",
      flags: ["authorization", "role"],
      args: ({ root, options }) => [{ root, authorizationId: options.authorization, role: options.role }],
    },
    impl: () => import("./bounded-worker-dispatch.mjs").then((module) => module.createBoundedWorkerDispatch),
  },
  {
    name: "head_bounded_worker_wait",
    tool: {
      name: "head_bounded_worker_wait",
      description:
        "Boundedly observe one worker's operational P5 lease/result state. Session results are evidence for HEAD consumption, without Run application or a review gate. The returned cursor is non-persisted and cannot create a ReviewDecision or recovery direction.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          authorization_id: { type: "string", pattern: "^execution-authorization-[a-f0-9]{24}$" },
          wait_timeout_ms: { type: "integer", minimum: 0, maximum: 600000, default: 0 },
        },
        required: ["project_root", "authorization_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root, authorizationId: args.authorization_id, timeoutMs: args.wait_timeout_ms ?? 0 }] },
    cli: {
      command: "worker-wait",
      flags: ["authorization", "wait-timeout-ms"],
      args: ({ root, options }) => [{ root, authorizationId: options.authorization, timeoutMs: waitTimeout(options) }],
    },
    impl: () => import("./bounded-worker-dispatch.mjs").then((module) => module.waitForBoundedWorkerDispatch),
  },
  {
    name: "head_bounded_worker_apply_result",
    tool: {
      name: "head_bounded_worker_apply_result",
      description:
        "Run-only: map one completed, actual-provider, native-supervised bounded-worker draft into the canonical ResultPacket and Fresh HEAD review context. This does not create a ReviewDecision or integrate checkpoint direction.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          authorization_id: { type: "string", pattern: "^execution-authorization-[a-f0-9]{24}$" },
        },
        required: ["project_root", "authorization_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root, authorizationId: args.authorization_id }] },
    cli: { command: "worker-apply", flags: ["authorization"], args: ({ root, options }) => [{ root, authorizationId: options.authorization }] },
    impl: () => import("./bounded-worker-dispatch.mjs").then((module) => module.applyBoundedWorkerDispatchResult),
  },
  {
    name: "head_bounded_worker_wave_create",
    tool: {
      name: "head_bounded_worker_wave_create",
      description:
        "Create one P3 grouping over 2-64 already-created bounded worker dispatches sharing the exact current Project/HEAD Session/Run/WholePlan/ExecutionContract/ContextCapsule lineage. It creates no authorization and widens no member scope.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          authorization_ids: {
            type: "array",
            minItems: 2,
            maxItems: 64,
            uniqueItems: true,
            items: { type: "string", pattern: "^execution-authorization-[a-f0-9]{24}$" },
          },
        },
        required: ["project_root", "authorization_ids"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root, authorizationIds: args.authorization_ids }] },
    cli: {
      command: "worker-wave-create",
      flags: ["input"],
      args: ({ root, options, inputJson }) => {
        const input = onlyFields(inputJson(options, "Bounded worker wave"), ["authorizationIds"], "Bounded worker wave");
        return [{ root, authorizationIds: input.authorizationIds }];
      },
    },
    impl: () => import("./bounded-worker-wave.mjs").then((module) => module.createBoundedWorkerWave),
  },
  {
    name: "head_bounded_worker_wave_read",
    tool: {
      name: "head_bounded_worker_wave_read",
      description:
        "Read and reverify one P3 worker wave, every member dispatch, current P2 lineage, and any create-only seal or abandonment evidence. This read cannot seal the wave.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          wave_id: { type: "string", pattern: "^bounded-worker-wave-[a-f0-9]{24}$" },
        },
        required: ["project_root", "wave_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root, waveId: args.wave_id }] },
    cli: { command: "worker-wave-read", flags: ["wave"], args: ({ root, options }) => [{ root, waveId: options.wave }] },
    impl: () => import("./bounded-worker-wave.mjs").then((module) => module.readBoundedWorkerWave),
  },
  {
    name: "head_bounded_worker_wave_seal",
    tool: {
      name: "head_bounded_worker_wave_seal",
      description:
        "Create one P3 wave seal only after every independent member authorization has verified at-most-once lease consumption. A seal is not completion, review, or checkpoint integration.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          wave_id: { type: "string", pattern: "^bounded-worker-wave-[a-f0-9]{24}$" },
        },
        required: ["project_root", "wave_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root, waveId: args.wave_id }] },
    cli: { command: "worker-wave-seal", flags: ["wave"], args: ({ root, options }) => [{ root, waveId: options.wave }] },
    impl: () => import("./bounded-worker-wave.mjs").then((module) => module.sealBoundedWorkerWave),
  },
  {
    name: "head_bounded_worker_wave_status",
    tool: {
      name: "head_bounded_worker_wave_status",
      description:
        "Return one non-persisted P4 requested/started/returned/waiting/succeeded/failed projection. Status is observational and cannot create a seal, ReviewDecision, or recovery direction.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          wave_id: { type: "string", pattern: "^bounded-worker-wave-[a-f0-9]{24}$" },
        },
        required: ["project_root", "wave_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root, waveId: args.wave_id }] },
    cli: { command: "worker-wave-status", flags: ["wave"], args: ({ root, options }) => [{ root, waveId: options.wave }] },
    impl: () => import("./bounded-worker-wave.mjs").then((module) => module.readBoundedWorkerWaveStatus),
  },
  {
    name: "head_bounded_worker_wave_results",
    tool: {
      name: "head_bounded_worker_wave_results",
      description:
        "Read one non-persisted P4 aggregate of member result references after an explicit verified wave seal. It never applies ResultPackets or creates Fresh HEAD review.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          wave_id: { type: "string", pattern: "^bounded-worker-wave-[a-f0-9]{24}$" },
        },
        required: ["project_root", "wave_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root, waveId: args.wave_id }] },
    cli: { command: "worker-wave-results", flags: ["wave"], args: ({ root, options }) => [{ root, waveId: options.wave }] },
    impl: () => import("./bounded-worker-wave.mjs").then((module) => module.readBoundedWorkerWaveResults),
  },
  {
    name: "head_bounded_worker_wave_wait",
    tool: {
      name: "head_bounded_worker_wave_wait",
      description:
        "Boundedly observe one sealed wave as a non-persisted P5 outcome. Open or abandoned waves fail closed, and completion requires every member to succeed.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          wave_id: { type: "string", pattern: "^bounded-worker-wave-[a-f0-9]{24}$" },
          wait_timeout_ms: { type: "integer", minimum: 0, maximum: 600000, default: 0 },
        },
        required: ["project_root", "wave_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root, waveId: args.wave_id, timeoutMs: args.wait_timeout_ms ?? 0 }] },
    cli: {
      command: "worker-wave-wait",
      flags: ["wait-timeout-ms", "wave"],
      args: ({ root, options }) => [{ root, waveId: options.wave, timeoutMs: waitTimeout(options) }],
    },
    impl: () => import("./bounded-worker-wave.mjs").then((module) => module.waitForBoundedWorkerWave),
  },
  {
    name: "head_bounded_worker_wave_abandon",
    tool: {
      name: "head_bounded_worker_wave_abandon",
      description:
        "Create one P3 non-success abandoned handoff for an unsealed wave using a bounded reason code and non-authoritative sanitized summary. This cannot create review or recovery direction.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          wave_id: { type: "string", pattern: "^bounded-worker-wave-[a-f0-9]{24}$" },
          reason_code: { type: "string", enum: ["partial-launch", "lineage-drift", "operator-stop", "unrecoverable-member", "other"] },
          reason_summary: { type: "string", maxLength: 256, default: "" },
        },
        required: ["project_root", "wave_id", "reason_code"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root, waveId: args.wave_id, reasonCode: args.reason_code, reasonSummary: args.reason_summary || "" }] },
    cli: {
      command: "worker-wave-abandon",
      flags: ["input"],
      args: ({ root, options, inputJson }) => {
        const input = onlyFields(
          inputJson(options, "Bounded worker wave abandonment"),
          ["waveId", "reasonCode", "reasonSummary"],
          "Bounded worker wave abandonment",
        );
        return [{ root, waveId: input.waveId, reasonCode: input.reasonCode, reasonSummary: input.reasonSummary || "" }];
      },
    },
    impl: () => import("./bounded-worker-wave.mjs").then((module) => module.abandonBoundedWorkerWave),
  },
  {
    name: "head_checkpoint_basis",
    tool: {
      name: "head_checkpoint_basis",
      description:
        "Read one non-persisted exact Project/Session/Run/plan/contract/Capsule/review and transition basis before HEAD derives recovery direction. This is P4 comparison evidence and writes no P2 direction.",
      inputSchema: {
        type: "object",
        properties: { project_root: { type: "string", minLength: 1 } },
        required: ["project_root"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root }] },
    cli: { command: "checkpoint-basis", flags: [], args: ({ root }) => [{ root }] },
    impl: () => import("./compaction-recovery.mjs").then((module) => module.inspectRecoveryCheckpointBasis),
  },
  {
    name: "head_checkpoint_diagnose",
    tool: {
      name: "head_checkpoint_diagnose",
      description:
        "Read a bounded P4 checkpoint diagnosis: current pointer, artifact-restore verification, mechanical sync availability, and the next HEAD action. It performs no write, repair, approval, or semantic-freshness judgment.",
      inputSchema: {
        type: "object",
        properties: { project_root: { type: "string", minLength: 1 } },
        required: ["project_root"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root }] },
    cli: { command: "checkpoint-diagnose", flags: [], args: ({ root }) => [{ root }] },
    impl: () => import("./recovery-checkpoint-diagnosis.mjs").then((module) => module.inspectRecoveryCheckpointDiagnosis),
  },
  {
    name: "head_checkpoint_sync",
    tool: {
      name: "head_checkpoint_sync",
      description:
        "Publish or reuse one canonical P2 recovery checkpoint only when the exact read-only basis is current. Identical retries converge; stale direction conflicts; incomplete Run or open compaction transitions defer only this sync.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          expected_recovery_basis_id: { type: "string", pattern: "^recovery-basis-[a-f0-9]{24}$" },
          purpose: { type: "string", minLength: 1 },
          approved_decisions: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
          current_position: { type: "string", minLength: 1 },
          next_expected_result: { type: "string", minLength: 1 },
          open_review_ids: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
          work_evidence: sessionWorkEvidenceSchema,
        },
        required: ["project_root", "expected_recovery_basis_id", "purpose", "approved_decisions", "current_position", "next_expected_result"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    mcp: {
      args: (args) => [
        {
          root: args.project_root,
          expectedRecoveryBasisId: args.expected_recovery_basis_id,
          purpose: args.purpose,
          approvedDecisions: args.approved_decisions,
          currentPosition: args.current_position,
          nextExpectedResult: args.next_expected_result,
          openReviewIds: args.open_review_ids || [],
          ...(args.work_evidence !== undefined ? { workEvidence: args.work_evidence } : {}),
        },
      ],
    },
    cli: {
      command: "checkpoint-sync",
      flags: ["input"],
      args: ({ root, options, inputJson }) => [{ ...inputJson(options, "Recovery checkpoint sync"), root }],
    },
    impl: () => import("./compaction-recovery.mjs").then((module) => module.syncRecoveryCheckpoint),
  },
  {
    name: "head_compact_prepare",
    tool: {
      name: "head_compact_prepare",
      description:
        "Create the canonical Session/Run recovery checkpoint and one bounded compaction epoch. This does not invoke a provider or treat a provider summary as recovery authority.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          runtime: { type: "string", enum: ["manual", "claude", "codex", "opencode"], default: "manual" },
          user_turn_id_at_prepare: { type: "integer", minimum: 0 },
          purpose: { type: "string", minLength: 1 },
          approved_decisions: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
          current_position: { type: "string", minLength: 1 },
          next_expected_result: { type: "string", minLength: 1 },
          open_review_ids: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
        },
        required: ["project_root", "user_turn_id_at_prepare", "purpose", "approved_decisions", "current_position", "next_expected_result"],
        additionalProperties: false,
      },
    },
    mcp: {
      args: (args) => [
        {
          root: args.project_root,
          runtime: args.runtime || "manual",
          userTurnIdAtPrepare: args.user_turn_id_at_prepare,
          purpose: args.purpose,
          approvedDecisions: args.approved_decisions,
          currentPosition: args.current_position,
          nextExpectedResult: args.next_expected_result,
          openReviewIds: args.open_review_ids || [],
        },
      ],
    },
    cli: { command: "compact-prepare", flags: ["input"], args: ({ root, options, inputJson }) => [{ ...inputJson(options, "Compaction prepare"), root }] },
    impl: () => import("./compaction-recovery.mjs").then((module) => module.prepareCompaction),
  },
  {
    name: "head_compact_verify",
    tool: {
      name: "head_compact_verify",
      description:
        "Verify provider compaction against the exact canonical checkpoint. Provider transcripts, summaries, session identities, and HEADContinuitySnapshot are rejected as recovery sources.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          epoch_id: { type: "string", pattern: "^compaction-epoch-[a-f0-9-]{36}$" },
          checkpoint_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
          current_user_turn_id: { type: "integer", minimum: 0 },
          provider_compacted: { type: "boolean" },
          recovery_source: { type: "string", enum: ["canonical-checkpoint"] },
        },
        required: ["project_root", "epoch_id", "checkpoint_digest", "current_user_turn_id", "provider_compacted"],
        additionalProperties: false,
      },
    },
    mcp: {
      args: (args) => [
        {
          root: args.project_root,
          epochId: args.epoch_id,
          checkpointDigest: args.checkpoint_digest,
          currentUserTurnId: args.current_user_turn_id,
          providerCompacted: args.provider_compacted,
          recoverySource: args.recovery_source || "canonical-checkpoint",
        },
      ],
    },
    cli: { command: "compact-verify", flags: ["input"], args: ({ root, options, inputJson }) => [{ ...inputJson(options, "Compaction verification"), root }] },
    impl: () => import("./compaction-recovery.mjs").then((module) => module.verifyCompaction),
  },
  {
    name: "head_compact_continue",
    tool: {
      name: "head_compact_continue",
      description:
        "Consume a verified compaction continuation token at most once and return the checkpoint-bound continuation instruction. A newer real user turn supersedes it.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          epoch_id: { type: "string", pattern: "^compaction-epoch-[a-f0-9-]{36}$" },
          continuation_token: { type: "string", minLength: 32 },
          current_user_turn_id: { type: "integer", minimum: 0 },
        },
        required: ["project_root", "epoch_id", "continuation_token", "current_user_turn_id"],
        additionalProperties: false,
      },
    },
    mcp: {
      args: (args) => [
        { root: args.project_root, epochId: args.epoch_id, continuationToken: args.continuation_token, currentUserTurnId: args.current_user_turn_id },
      ],
    },
    cli: {
      command: "compact-continue",
      flags: ["input"],
      args: ({ root, options, inputJson }) => [{ ...inputJson(options, "Compaction continuation"), root }],
    },
    impl: () => import("./compaction-recovery.mjs").then((module) => module.continueCompaction),
  },
  {
    name: "head_compact_status",
    tool: {
      name: "head_compact_status",
      description: "Read the current compaction epoch and digest-verified Session/Run checkpoint without disclosing the continuation token.",
      inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 } }, required: ["project_root"], additionalProperties: false },
    },
    mcp: { args: (args) => [{ root: args.project_root }] },
    cli: { command: "compact-status", flags: [], args: ({ root }) => [{ root }] },
    impl: () => import("./compaction-recovery.mjs").then((module) => module.inspectCompaction),
  },
  {
    name: "head_compact_abort",
    tool: {
      name: "head_compact_abort",
      description: "Abort one open compaction epoch without changing its canonical Session/Run checkpoint or Product Canon.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          epoch_id: { type: "string", pattern: "^compaction-epoch-[a-f0-9-]{36}$" },
          reason: { type: "string", minLength: 1 },
        },
        required: ["project_root", "epoch_id", "reason"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root, epochId: args.epoch_id, reason: args.reason }] },
    cli: { command: "compact-abort", flags: ["input"], args: ({ root, options, inputJson }) => [{ ...inputJson(options, "Compaction abort"), root }] },
    impl: () => import("./compaction-recovery.mjs").then((module) => module.abortCompaction),
  },
  {
    name: "head_graph_lineage_status",
    tool: {
      name: "head_graph_lineage_status",
      description:
        "Read one bounded page of retained content-addressed World/Graph lineage as a non-persisted P4 hot/warm/cold projection. It creates no artifacts and never blocks ordinary work.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          cursor: { type: "string", pattern: "^world-model-[a-f0-9]{24}$" },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
        },
        required: ["project_root"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root, cursor: args.cursor || "", limit: args.limit ?? 25 }] },
    cli: {
      command: "graph-lineage-status",
      flags: ["cursor", "limit"],
      args: ({ root, options }) => [{ root, cursor: options.cursor || "", limit: options.limit == null ? 25 : Number(options.limit) }],
    },
    impl: () => import("./graph-lineage.mjs").then((module) => module.inspectGraphLineage),
  },
  {
    name: "head_graph_lineage_trace",
    tool: {
      name: "head_graph_lineage_trace",
      description:
        "Trace an exact or discovery-selected Graph anchor in a verified current or retained snapshot, with a bounded read-only execution-lineage overlay. Discovery does not prove relevance and completion does not imply integration.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          world_model_id: { type: "string", pattern: "^world-model-[a-f0-9]{24}$" },
          anchor_id: { type: "string", minLength: 1, maxLength: 256 },
          query: { type: "string", minLength: 1 },
          depth: { type: "integer", minimum: 0, maximum: 3, default: 2 },
          node_limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
          edge_limit: { type: "integer", minimum: 0, maximum: 1000, default: 200 },
          include_execution: { type: "boolean", default: true },
        },
        required: ["project_root"],
        oneOf: [{ required: ["anchor_id"] }, { required: ["query"] }],
        additionalProperties: false,
      },
    },
    mcp: {
      args: (args) => [
        {
          root: args.project_root,
          worldModelId: args.world_model_id || "",
          anchorId: args.anchor_id || "",
          query: args.query || "",
          depth: args.depth ?? 2,
          maxNodes: args.node_limit ?? 100,
          maxEdges: args.edge_limit ?? 200,
          includeExecution: args.include_execution ?? true,
        },
      ],
    },
    cli: {
      command: "graph-lineage-trace",
      flags: ["anchor", "depth", "edge-limit", "include-execution", "limit", "query", "world"],
      args: ({ root, options }) => [
        {
          root,
          worldModelId: options.world || "",
          anchorId: options.anchor || "",
          query: options.query || "",
          depth: options.depth == null ? 2 : Number(options.depth),
          maxNodes: options.limit == null ? 100 : Number(options.limit),
          maxEdges: options["edge-limit"] == null ? 200 : Number(options["edge-limit"]),
          includeExecution: options["include-execution"] !== "false",
        },
      ],
    },
    impl: () => import("./graph-lineage.mjs").then((module) => module.traceGraphLineage),
  },
  {
    name: "head_graph_lineage_diff",
    tool: {
      name: "head_graph_lineage_diff",
      description:
        "Compare two exact retained World/Graph snapshots as a bounded P4 view. Exact-content possible moves are evidence only and never automatic semantic identity.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          from_world_model_id: { type: "string", pattern: "^world-model-[a-f0-9]{24}$" },
          to_world_model_id: { type: "string", pattern: "^world-model-[a-f0-9]{24}$" },
          limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
          scope_paths: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 500 },
          cursor: { type: "string", maxLength: 131072 },
        },
        required: ["project_root", "from_world_model_id", "to_world_model_id"],
        additionalProperties: false,
      },
    },
    mcp: {
      args: (args) => [
        {
          root: args.project_root,
          fromWorldModelId: args.from_world_model_id,
          toWorldModelId: args.to_world_model_id,
          limit: args.limit ?? 100,
          scopePaths: args.scope_paths ?? null,
          cursor: args.cursor || "",
        },
      ],
    },
    cli: {
      command: "graph-lineage-diff",
      flags: ["cursor", "from", "limit", "path", "to"],
      args: ({ root, options }) => [
        {
          root,
          fromWorldModelId: options.from,
          toWorldModelId: options.to,
          limit: options.limit == null ? 100 : Number(options.limit),
          scopePaths: options.path ? [options.path] : null,
          cursor: options.cursor || "",
        },
      ],
    },
    impl: () => import("./graph-lineage.mjs").then((module) => module.diffGraphLineage),
  },
  {
    name: "head_change_set_status",
    tool: {
      name: "head_change_set_status",
      description:
        "Read and digest-verify the current provider-neutral ChangeSet, Feature impact state, and optional VCS evidence without mutating project state.",
      inputSchema: {
        type: "object",
        properties: { project_root: { type: "string", minLength: 1 } },
        required: ["project_root"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root }] },
    cli: { command: "change-set-status", flags: [], args: ({ root }) => [{ root }] },
    impl: () => import("./change-set.mjs").then((module) => module.inspectChangeSets),
  },
  {
    name: "head_vcs_evidence",
    tool: {
      name: "head_vcs_evidence",
      description:
        "Read and digest-verify one optional VCS evidence attachment and its immutable Git commit observations without treating commits as ChangeSet or project authority.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          vcs_evidence_id: { type: "string", pattern: "^vcs-evidence-[a-f0-9]{24}$" },
        },
        required: ["project_root", "vcs_evidence_id"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root, vcsEvidenceId: args.vcs_evidence_id }] },
    cli: { command: "change-set-vcs-read", flags: ["vcs-evidence"], args: ({ root, options }) => [{ root, vcsEvidenceId: options["vcs-evidence"] }] },
    impl: () => import("./change-set.mjs").then((module) => module.readVcsEvidence),
  },
  {
    name: "head_lineage_artifact",
    tool: {
      name: "head_lineage_artifact",
      description: "Read and digest-verify one persisted Whole-plan Execution Lineage artifact.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          artifact_id: { type: "string", pattern: "^(whole-plan|execution-contract|result-packet|review-decision)-[a-f0-9]{24}$" },
        },
        required: ["project_root", "artifact_id"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root, artifactId: args.artifact_id }] },
    cli: { command: "lineage-read", flags: ["artifact"], args: ({ root, options }) => [{ root, artifactId: options.artifact }] },
    impl: () => import("./execution-lineage.mjs").then((module) => module.readLineageArtifact),
  },
  {
    name: "head_context_capsule",
    tool: {
      name: "head_context_capsule",
      description: "Read and digest-verify one persisted Context Capsule.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          capsule_id: { type: "string", pattern: "^capsule-[a-f0-9]{24}$" },
        },
        required: ["project_root", "capsule_id"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root, capsuleId: args.capsule_id }] },
    cli: { command: "context-read", flags: ["capsule"], args: ({ root, options }) => [{ root, capsuleId: options.capsule }] },
    impl: () => import("./context-compiler.mjs").then((module) => module.readContextCapsule),
  },
  {
    name: "head_pending_review",
    tool: {
      name: "head_pending_review",
      description: "Build the deterministic minimum-sufficient Fresh HEAD view for the Result Packet awaiting review.",
      inputSchema: {
        type: "object",
        properties: { project_root: { type: "string", minLength: 1 } },
        required: ["project_root"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root }] },
    cli: { command: "run-review-context", flags: [], args: ({ root }) => [{ root }] },
    impl: () => import("./run-lineage.mjs").then((module) => module.getPendingReviewContext),
  },
  {
    name: "head_run_integration",
    tool: {
      name: "head_run_integration",
      description: "Read and digest-verify the one-shot Run result integration receipt and its canonical recovery checkpoint.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          review_decision_id: { type: "string", pattern: "^review-decision-[a-f0-9]{24}$" },
        },
        required: ["project_root", "review_decision_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root, reviewDecisionId: args.review_decision_id }] },
    cli: { command: "run-integration-read", flags: ["review"], args: ({ root, options }) => [{ root, reviewDecisionId: options.review }] },
    impl: () => import("./session-recovery.mjs").then((module) => module.readRunResultIntegration),
  },
]);

const byName = new Map(OPERATIONS.map((entry) => [entry.name, entry]));
const byCommand = new Map(OPERATIONS.map((entry) => [entry.cli.command, entry]));

export function registeredOperation(name) {
  return byName.get(resolveOperation(name)?.semanticName ?? name) ?? null;
}

export function registeredCommand(command) {
  return byCommand.get(command) ?? null;
}

// MCP tool definitions for allTools, in the order given.
export function registeredTools(names) {
  return names.map((name) => {
    const entry = byName.get(name);
    if (!entry) throw new Error(`Unknown registered operation: ${name}`);
    return entry.tool;
  });
}

export async function callRegistered(entry, callArguments) {
  const implementation = await entry.impl();
  return await implementation(...callArguments);
}

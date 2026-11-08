// One operation registry for the MCP server (scripts/mcp-server.mjs) and the CLI
// (scripts/lode.mjs). Each entry is one operation:
//   name   the internal operation name (resolveOperation(name).semanticName);
//   tool   the MCP tool definition, listed by allTools at its original position;
//   mcp    args(arguments, context) -> the implementation's argument list, with
//          optional before/after adapters (see callRegistered);
//   cli    command, the option names it reads, args(context) -> argument list,
//          and optional before/after adapters;
//   impl   lazy loader of the scripts/lib implementation.
// Both surfaces call impl()(...args). Surface-specific defaults stay explicit in
// each args function (for example CLI numbers arrive as text). Operations not yet
// listed here keep their original MCP/CLI dispatch branches.
// test/dispatch-recordings.test.mjs pins the call each surface makes.
import { resolveOperation } from "./lode-operation-contract.mjs";
import {
  conformanceBaselineSchema,
  conformanceEvidenceAnchorSchema,
  conformanceFindingInputSchema,
  observationBindingSchema,
  observationCoverageSchema,
  observationDescriptorSchema,
  observationInputSchema,
  sessionWorkEvidenceSchema,
} from "./tool-schemas.mjs";
import {
  compactMarkdownBuild,
  compactReviewResult,
  conformanceBaselineFromMcp,
  conformanceEvidenceAnchorFromMcp,
  conformanceFindingFromMcp,
  featureMappingProposalFromMcp,
  localWorkerInput,
  observationBindingFromMcp,
  observationCoverageFromMcp,
  observationDescriptorFromMcp,
  observationInputFromMcp,
  preparedRuntimeRead,
  productFeatureResolutionFromMcp,
  requireMcpConfirmation,
} from "./dispatch-adapters.mjs";

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
  {
    name: "head_metric_assess",
    tool: {
      name: "head_metric_assess",
      description:
        "Record a bounded P3 ProductHypothesis interpreting one exact metric comparison. Supports/contradicts/inconclusive are hypotheses, not causal findings or Canon changes.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          comparison_observation_id: { type: "string", minLength: 1 },
          assessment: { type: "string", enum: ["supports", "contradicts", "inconclusive"] },
          statement: { type: "string", minLength: 1, maxLength: 4000 },
          rationale: { type: "string", maxLength: 4000 },
        },
        required: ["project_root", "comparison_observation_id", "assessment", "statement"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: {
      args: (args) => [
        {
          root: args.project_root,
          comparisonObservationId: args.comparison_observation_id,
          assessment: args.assessment,
          statement: args.statement,
          rationale: args.rationale || "",
        },
      ],
    },
    cli: { command: "metric-assess", flags: ["input"], args: ({ root, options, inputJson }) => [{ ...inputJson(options, "Metric assessment"), root }] },
    impl: () => import("./measurement-workflow.mjs").then((module) => module.assessMetricComparison),
  },
  {
    name: "head_metric_compare",
    tool: {
      name: "head_metric_compare",
      description:
        "Create an exact P3 derived comparison between two compatible metric observations. The result preserves coverage disclosures and never claims causality.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          baseline_observation_id: { type: "string", minLength: 1 },
          current_observation_id: { type: "string", minLength: 1 },
        },
        required: ["project_root", "baseline_observation_id", "current_observation_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: {
      args: (args) => [{ root: args.project_root, baselineObservationId: args.baseline_observation_id, currentObservationId: args.current_observation_id }],
    },
    cli: { command: "metric-compare", flags: ["input"], args: ({ root, options, inputJson }) => [{ ...inputJson(options, "Metric comparison"), root }] },
    impl: () => import("./measurement-workflow.mjs").then((module) => module.compareMetricObservations),
  },
  {
    name: "head_metric_define",
    tool: {
      name: "head_metric_define",
      description: "Register a provider-neutral P3 metric data shape. This does not change Product Canon, execution authority, or recovery direction.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          metric_key: { type: "string", minLength: 1, maxLength: 128 },
          unit: { type: "string", minLength: 1, maxLength: 64 },
          direction: { type: "string", enum: ["increase", "decrease", "maintain"] },
          type_version: { type: "string", minLength: 1, maxLength: 64, default: "1" },
        },
        required: ["project_root", "metric_key", "unit", "direction"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: {
      args: (args) => [
        { root: args.project_root, metricKey: args.metric_key, unit: args.unit, direction: args.direction, typeVersion: args.type_version || "1" },
      ],
    },
    cli: { command: "metric-define", flags: ["input"], args: ({ root, options, inputJson }) => [{ ...inputJson(options, "Metric definition"), root }] },
    impl: () => import("./measurement-workflow.mjs").then((module) => module.defineMetric),
  },
  {
    name: "head_metric_observe",
    tool: {
      name: "head_metric_observe",
      description:
        "Record one exact P3 metric observation through the common Observation contract. Partial coverage is disclosed and remains usable evidence; it is never upgraded to complete.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          metric_key: { type: "string", minLength: 1, maxLength: 128 },
          type_version: { type: "string", minLength: 1, maxLength: 64 },
          subject_type: { type: "string", minLength: 1, maxLength: 192 },
          subject_key: { type: "string", minLength: 1, maxLength: 192 },
          value: { type: "number" },
          sample_size: { type: "integer", minimum: 0 },
          form: { type: "string", enum: ["snapshot", "aggregate"], default: "snapshot" },
          observed_at: { type: "string", minLength: 1 },
          start: { type: ["string", "null"] },
          end: { type: ["string", "null"] },
          coverage: {
            type: "object",
            properties: {
              state: { type: "string", enum: ["complete", "sampled", "partial", "unknown"] },
              basis: { type: "string", minLength: 1, maxLength: 128 },
              query_digest: { type: ["string", "null"], pattern: "^[a-f0-9]{64}$" },
              examined_count: { type: "integer", minimum: 0 },
              source_reported_total: { type: ["integer", "null"], minimum: 0 },
              omitted_count: { type: ["integer", "null"], minimum: 0 },
              cursor_start_digest: { type: ["string", "null"] },
              cursor_end_digest: { type: ["string", "null"] },
            },
            additionalProperties: false,
          },
          adapter_key: { type: "string", minLength: 1, maxLength: 192 },
          adapter_version: { type: "string", minLength: 1, maxLength: 64 },
          source_scope_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
          source_event_key_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
          source_evidence_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
        },
        required: [
          "project_root",
          "metric_key",
          "subject_type",
          "subject_key",
          "value",
          "source_scope_digest",
          "source_event_key_digest",
          "source_evidence_digest",
        ],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: {
      args: (args) => [
        {
          root: args.project_root,
          metricKey: args.metric_key,
          typeVersion: args.type_version || "",
          subjectType: args.subject_type,
          subjectKey: args.subject_key,
          value: args.value,
          sampleSize: args.sample_size ?? null,
          form: args.form || "snapshot",
          observedAt: args.observed_at ?? null,
          start: args.start ?? null,
          end: args.end ?? null,
          coverage: args.coverage
            ? {
                state: args.coverage.state,
                basis: args.coverage.basis,
                queryDigest: args.coverage.query_digest,
                examinedCount: args.coverage.examined_count,
                sourceReportedTotal: args.coverage.source_reported_total,
                omittedCount: args.coverage.omitted_count,
                cursorStartDigest: args.coverage.cursor_start_digest,
                cursorEndDigest: args.coverage.cursor_end_digest,
              }
            : {},
          adapterKey: args.adapter_key,
          adapterVersion: args.adapter_version,
          sourceScopeDigest: args.source_scope_digest,
          sourceEventKeyDigest: args.source_event_key_digest,
          sourceEvidenceDigest: args.source_evidence_digest,
        },
      ],
    },
    cli: { command: "metric-observe", flags: ["input"], args: ({ root, options, inputJson }) => [{ ...inputJson(options, "Metric observation"), root }] },
    impl: () => import("./measurement-workflow.mjs").then((module) => module.recordMetricObservation),
  },
  {
    name: "head_metric_status",
    tool: {
      name: "head_metric_status",
      description: "Read the nonblocking metric definitions, observation count, and comparison count. This creates no authority or state.",
      inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 } }, required: ["project_root"], additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root }] },
    cli: { command: "metric-status", flags: [], args: ({ root }) => [{ root }] },
    impl: () => import("./measurement-workflow.mjs").then((module) => module.inspectMeasurements),
  },
  {
    name: "head_metric_trace",
    tool: {
      name: "head_metric_trace",
      description:
        "Read one bounded P4 measurement lineage from an exact graph anchor or metric key through the verified prepared-traversal path. This writes no Canon, decision, or recovery state.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          anchor_id: { type: "string", minLength: 1 },
          metric_key: { type: "string", minLength: 1, maxLength: 128 },
          type_version: { type: "string", minLength: 1, maxLength: 64 },
          depth: { type: "integer", minimum: 0, maximum: 3, default: 3 },
          max_nodes: { type: "integer", minimum: 1, maximum: 500, default: 128 },
          max_edges: { type: "integer", minimum: 0, maximum: 1000, default: 256 },
        },
        required: ["project_root"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: {
      args: (args) => [
        {
          root: args.project_root,
          anchorId: args.anchor_id || "",
          metricKey: args.metric_key || "",
          typeVersion: args.type_version || "",
          depth: args.depth ?? 3,
          maxNodes: args.max_nodes ?? 128,
          maxEdges: args.max_edges ?? 256,
        },
      ],
    },
    cli: {
      command: "metric-trace",
      flags: ["anchor", "depth", "metric", "type-version"],
      args: ({ root, options }) => [
        {
          root,
          anchorId: options.anchor || "",
          metricKey: options.metric || "",
          typeVersion: options["type-version"] || "",
          depth: options.depth == null ? 3 : Number(options.depth),
        },
      ],
    },
    impl: () => import("./measurement-workflow.mjs").then((module) => module.traceMeasurementLineage),
  },
  {
    name: "head_delivery_observe",
    tool: {
      name: "head_delivery_observe",
      description:
        "Record one provider-neutral P3 delivery event for an exact environment and target. This adds no deployment action or approval gate; failures do not overwrite prior success, and an optional World revision binding is mechanically verified.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          environment_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
          target_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
          artifact_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$" },
          revision_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$" },
          revision_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
          outcome: { type: "string", enum: ["applied", "failed", "cancelled", "rolled-back"] },
          sequence: { type: "integer", minimum: 0 },
          predecessor_observation_id: { anyOf: [{ type: "string", pattern: "^observation-[a-f0-9]{24}$" }, { type: "null" }] },
          rollback_target_observation_id: { anyOf: [{ type: "string", pattern: "^observation-[a-f0-9]{24}$" }, { type: "null" }] },
          observed_at: { type: "string", format: "date-time" },
          source_scope_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
          source_event_key_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
          source_evidence_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
          adapter_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$" },
          adapter_version: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$" },
          revision_reference: {
            type: "object",
            properties: {
              world_model_id: { type: "string", pattern: "^world-model-[a-f0-9]{24}$" },
              revision_id: { type: "string", pattern: "^file-revision-[a-f0-9]{24}$" },
              source_path: { type: "string", minLength: 1, maxLength: 4096 },
              digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
            },
            required: ["world_model_id", "revision_id", "source_path", "digest"],
            additionalProperties: false,
          },
        },
        required: [
          "project_root",
          "environment_key",
          "target_key",
          "artifact_key",
          "revision_key",
          "revision_digest",
          "outcome",
          "sequence",
          "source_scope_digest",
          "source_event_key_digest",
          "source_evidence_digest",
        ],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    mcp: {
      args: (args) => [
        {
          root: args.project_root,
          environmentKey: args.environment_key,
          targetKey: args.target_key,
          artifactKey: args.artifact_key,
          revisionKey: args.revision_key,
          revisionDigest: args.revision_digest,
          outcome: args.outcome,
          sequence: args.sequence,
          predecessorObservationId: args.predecessor_observation_id ?? null,
          rollbackTargetObservationId: args.rollback_target_observation_id ?? null,
          observedAt: args.observed_at ?? null,
          sourceScopeDigest: args.source_scope_digest,
          sourceEventKeyDigest: args.source_event_key_digest,
          sourceEvidenceDigest: args.source_evidence_digest,
          adapterKey: args.adapter_key,
          adapterVersion: args.adapter_version,
          revisionReference: args.revision_reference
            ? {
                worldModelId: args.revision_reference.world_model_id,
                revisionId: args.revision_reference.revision_id,
                sourcePath: args.revision_reference.source_path,
                digest: args.revision_reference.digest,
              }
            : null,
        },
      ],
    },
    cli: { command: "delivery-observe", flags: ["input"], args: ({ root, options, inputJson }) => [{ ...inputJson(options, "Delivery observation"), root }] },
    impl: () => import("./delivery-observation.mjs").then((module) => module.recordDeliveryObservation),
  },
  {
    name: "head_delivery_status",
    tool: {
      name: "head_delivery_status",
      description:
        "Read a bounded non-persisted P4 current-and-history delivery projection. Explicit sequence and predecessor evidence determine current state; receipt time, failed attempts, and unobserved targets never imply success.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          environment_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
          target_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
          history_limit: { type: "integer", minimum: 1, maximum: 4096, default: 100 },
        },
        required: ["project_root"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: {
      args: (args) => [
        { root: args.project_root, environmentKey: args.environment_key || "", targetKey: args.target_key || "", historyLimit: args.history_limit ?? 100 },
      ],
    },
    cli: {
      command: "delivery-status",
      flags: ["environment", "history-limit", "target"],
      args: ({ root, options }) => [
        {
          root,
          environmentKey: options.environment || "",
          targetKey: options.target || "",
          historyLimit: options["history-limit"] == null ? 100 : Number(options["history-limit"]),
        },
      ],
    },
    impl: () => import("./delivery-observation.mjs").then((module) => module.inspectDeliveryState),
  },
  {
    name: "head_release_status",
    tool: {
      name: "head_release_status",
      description:
        "Read digest-verified P3 BranchState, DeploymentResult, and Release observations. The projection is evidence-only and has no Product Canon, execution, or recovery authority.",
      inputSchema: { type: "object", properties: { project_root: { type: "string", minLength: 1 } }, required: ["project_root"], additionalProperties: false },
    },
    mcp: { args: (args) => [{ root: args.project_root }] },
    cli: { command: "release-status", flags: [], args: ({ root }) => [{ root }] },
    impl: () => import("./release-observation.mjs").then((module) => module.inspectReleaseObservations),
  },
  {
    name: "head_incremental_refresh_receipt",
    tool: {
      name: "head_incremental_refresh_receipt",
      description: "Read and digest-verify one immutable incremental observed-state refresh receipt without advancing a pointer or changing Product Canon.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          refresh_receipt_id: { type: "string", pattern: "^incremental-refresh-receipt-[a-f0-9]{24}$" },
        },
        required: ["project_root", "refresh_receipt_id"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root, refreshReceiptId: args.refresh_receipt_id }] },
    cli: { command: "world-refresh-read", flags: ["receipt"], args: ({ root, options }) => [{ root, refreshReceiptId: options.receipt }] },
    impl: () => import("./incremental-refresh.mjs").then((module) => module.readIncrementalRefreshReceipt),
  },
  {
    name: "head_incremental_refresh_status",
    tool: {
      name: "head_incremental_refresh_status",
      description:
        "Read and digest-verify the latest explicit incremental refresh receipt, World Model binding, freshness, and active-execution drift without triggering refresh or changing authority.",
      inputSchema: {
        type: "object",
        properties: { project_root: { type: "string", minLength: 1 } },
        required: ["project_root"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root }] },
    cli: { command: "world-refresh-status", flags: [], args: ({ root }) => [{ root }] },
    impl: () => import("./incremental-refresh.mjs").then((module) => module.inspectIncrementalRefresh),
  },
  {
    name: "head_refresh_trigger_delivery",
    tool: {
      name: "head_refresh_trigger_delivery",
      description:
        "Read and digest-verify one immutable refresh trigger delivery and its linked incremental refresh evidence without mutating observed state or Product Canon.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          trigger_delivery_id: { type: "string", pattern: "^refresh-trigger-delivery-[a-f0-9]{24}$" },
        },
        required: ["project_root", "trigger_delivery_id"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root, triggerDeliveryId: args.trigger_delivery_id }] },
    cli: { command: "world-refresh-trigger-read", flags: ["delivery"], args: ({ root, options }) => [{ root, triggerDeliveryId: options.delivery }] },
    impl: () => import("./refresh-trigger.mjs").then((module) => module.readRefreshTriggerDelivery),
  },
  {
    name: "head_refresh_trigger_status",
    tool: {
      name: "head_refresh_trigger_status",
      description:
        "Read and digest-verify the latest debounced filesystem or CI trigger batch, serialized delivery receipt, World Model binding, and writer state without starting a watcher or triggering refresh.",
      inputSchema: {
        type: "object",
        properties: { project_root: { type: "string", minLength: 1 } },
        required: ["project_root"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root }] },
    cli: { command: "world-refresh-trigger-status", flags: [], args: ({ root }) => [{ root }] },
    impl: () => import("./refresh-trigger.mjs").then((module) => module.inspectRefreshTriggers),
  },
  {
    name: "head_post_refresh_projection_receipt",
    tool: {
      name: "head_post_refresh_projection_receipt",
      description:
        "Read and digest-verify one immutable post-refresh projection receipt with its linked incremental refresh, policy, DocumentProjection, or document-change candidate evidence.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          post_refresh_projection_receipt_id: { type: "string", pattern: "^post-refresh-projection-receipt-[a-f0-9]{24}$" },
        },
        required: ["project_root", "post_refresh_projection_receipt_id"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root, postRefreshProjectionReceiptId: args.post_refresh_projection_receipt_id }] },
    cli: { command: "world-docs-refresh-read", flags: ["receipt"], args: ({ root, options }) => [{ root, postRefreshProjectionReceiptId: options.receipt }] },
    impl: () => import("./incremental-refresh.mjs").then((module) => module.readPostRefreshProjectionReceipt),
  },
  {
    name: "head_post_refresh_projection_status",
    tool: {
      name: "head_post_refresh_projection_status",
      description:
        "Read the effective manual-or-automatic Markdown projection policy and verify the latest post-refresh outcome without changing policy, documents, Product Canon, or active Run inputs.",
      inputSchema: {
        type: "object",
        properties: { project_root: { type: "string", minLength: 1 } },
        required: ["project_root"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root }] },
    cli: { command: "world-docs-refresh-status", flags: [], args: ({ root }) => [{ root }] },
    impl: () => import("./incremental-refresh.mjs").then((module) => module.inspectPostRefreshProjectionStatus),
  },
  {
    name: "head_observation_read",
    tool: {
      name: "head_observation_read",
      description: "Read one exact digest-verified observed or derived Observation by ID with its descriptor and bounded receipt or derivation lineage.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          observation_id: { type: "string", pattern: "^(?:observation|derived-observation)-[a-f0-9]{24}$" },
        },
        required: ["project_root", "observation_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root, observationId: args.observation_id }] },
    cli: { command: "observation-read", flags: ["observation"], args: ({ root, options }) => [{ root, observationId: options.observation }] },
    impl: () => import("./observation-store.mjs").then((module) => module.readObservation),
  },
  {
    name: "head_observation_query",
    tool: {
      name: "head_observation_query",
      description:
        "Read global retained inventory counts and query a bounded P4 page of current Observation identities by exact type, subject, source, time, and record-kind filters. This is discovery only; it does not select semantic relevance or make records Context-eligible.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          type_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$" },
          subject_type: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$" },
          subject_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$" },
          adapter_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$" },
          observed_after: { type: "string", format: "date-time" },
          observed_before: { type: "string", format: "date-time" },
          record_kind: { type: "string", enum: ["all", "observed", "derived"], default: "all" },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
          projection_id: { type: "string", pattern: "^observation-projection-[a-f0-9]{24}$" },
          cursor: { type: "string", pattern: "^(?:observation|derived-observation)-[a-f0-9]{24}$" },
        },
        required: ["project_root"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: {
      args: (args) => [
        {
          root: args.project_root,
          typeKey: args.type_key || "",
          subjectType: args.subject_type || "",
          subjectKey: args.subject_key || "",
          adapterKey: args.adapter_key || "",
          observedAfter: args.observed_after || "",
          observedBefore: args.observed_before || "",
          recordKind: args.record_kind || "all",
          limit: args.limit ?? 25,
          projectionId: args.projection_id || "",
          cursor: args.cursor || "",
        },
      ],
    },
    cli: {
      command: "observation-query",
      flags: ["adapter-key", "cursor", "limit", "observed-after", "observed-before", "projection", "record-kind", "subject-key", "subject-type", "type-key"],
      args: ({ root, options }) => [
        {
          root,
          typeKey: options["type-key"] || "",
          subjectType: options["subject-type"] || "",
          subjectKey: options["subject-key"] || "",
          adapterKey: options["adapter-key"] || "",
          observedAfter: options["observed-after"] || "",
          observedBefore: options["observed-before"] || "",
          recordKind: options["record-kind"] || "all",
          limit: options.limit == null ? 25 : Number(options.limit),
          projectionId: options.projection || "",
          cursor: options.cursor || "",
        },
      ],
    },
    impl: () => import("./observation-projection.mjs").then((module) => module.queryObservations),
  },
  {
    name: "head_observation_sources",
    tool: {
      name: "head_observation_sources",
      description:
        "Page and exactly filter provider-neutral Host-injected Observation source IDs with bounded descriptor shape and Host-local availability hints. Stale read-only cursors restart at the first page with disclosure; no external source is read.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          type_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$" },
          adapter_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$" },
          availability: { type: "string", enum: ["unknown", "ready", "auth-missing", "rate-limited", "unavailable"] },
          limit: { type: "integer", minimum: 1, maximum: 64 },
          projection_id: { type: "string", pattern: "^observation-source-projection-[a-f0-9]{24}$" },
          cursor: { type: "string", pattern: "^observation-source-[a-f0-9]{24}$" },
        },
        required: ["project_root"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: {
      args: (args, { observationRegistry }) => [
        {
          root: args.project_root,
          registry: observationRegistry,
          typeKey: args.type_key || "",
          adapterKey: args.adapter_key || "",
          availabilityState: args.availability || "",
          limit: args.limit ?? 64,
          projectionId: args.projection_id || "",
          cursor: args.cursor || "",
        },
      ],
    },
    cli: {
      command: "observation-sources",
      flags: ["adapter-key", "availability", "cursor", "limit", "projection", "type-key"],
      args: ({ root, options, observationRegistry }) => [
        {
          root,
          registry: observationRegistry,
          typeKey: options["type-key"] || "",
          adapterKey: options["adapter-key"] || "",
          availabilityState: options.availability || "",
          limit: options.limit == null ? undefined : Number(options.limit),
          projectionId: options.projection || "",
          cursor: options.cursor || "",
        },
      ],
    },
    impl: () => import("./observation-adapter.mjs").then((module) => module.inspectObservationSources),
  },
  {
    name: "head_run_start",
    tool: {
      name: "head_run_start",
      description:
        "Start the existing contract-bound Run transaction. An optional Core request key makes exact retries converge; historical acknowledgments never authorize provider/worker replay. HEAD supplies the key without another prepare call or user form.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          execution_contract_id: { type: "string", pattern: "^execution-contract-[a-f0-9]{24}$" },
          start_request_id: { type: "string", minLength: 1, maxLength: 256 },
        },
        required: ["project_root", "execution_contract_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root, executionContractId: args.execution_contract_id, startRequestId: args.start_request_id }] },
    cli: {
      command: "run-start",
      flags: ["contract", "start-request"],
      args: ({ root, options }) => [{ root, executionContractId: options.contract, startRequestId: options["start-request"] }],
    },
    impl: () => import("./run-lineage.mjs").then((module) => module.startRun),
  },
  {
    name: "head_release_observe",
    tool: {
      name: "head_release_observe",
      description:
        "Record a host-supplied deployment result and current product Git refs as immutable P3 evidence. A ReleaseObservation is created only for an approved successful result whose exact commit is reachable and present on a current product ref; this never approves deployment or changes Product Canon.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          environment_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
          status: { type: "string", enum: ["succeeded", "failed", "cancelled"] },
          commit: { type: "string", pattern: "^[a-fA-F0-9]{40,64}$" },
          observed_at: { type: "string", format: "date-time" },
          source_event_key_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
          deployment_evidence_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
          approved: { type: "boolean" },
          approval_evidence_digest: { anyOf: [{ type: "string", pattern: "^[a-f0-9]{64}$" }, { type: "null" }] },
          change_set_id: { anyOf: [{ type: "string", pattern: "^change-set-[a-f0-9]{24}$" }, { type: "null" }] },
          vcs_evidence_id: { anyOf: [{ type: "string", pattern: "^vcs-evidence-[a-f0-9]{24}$" }, { type: "null" }] },
          confirm_host_observation: { type: "boolean" },
        },
        required: [
          "project_root",
          "environment_key",
          "status",
          "commit",
          "observed_at",
          "source_event_key_digest",
          "deployment_evidence_digest",
          "approved",
          "approval_evidence_digest",
          "change_set_id",
          "vcs_evidence_id",
          "confirm_host_observation",
        ],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    mcp: {
      before: (args) =>
        requireMcpConfirmation(
          args.confirm_host_observation,
          "Release observation requires explicit confirmation that the payload came from a host deployment observer.",
          "RELEASE_HOST_OBSERVATION_CONFIRMATION_REQUIRED",
        ),
      args: (args) => [
        {
          root: args.project_root,
          input: {
            environmentKey: args.environment_key,
            status: args.status,
            commit: args.commit,
            observedAt: args.observed_at,
            sourceEventKeyDigest: args.source_event_key_digest,
            deploymentEvidenceDigest: args.deployment_evidence_digest,
            approved: args.approved,
            approvalEvidenceDigest: args.approval_evidence_digest,
            changeSetId: args.change_set_id,
            vcsEvidenceId: args.vcs_evidence_id,
          },
        },
      ],
    },
    cli: {
      command: "release-observe",
      flags: ["input"],
      args: ({ root, options, inputJson }) => [{ root, input: inputJson(options, "DeploymentResultObservation") }],
    },
    impl: () => import("./release-observation.mjs").then((module) => module.observeReleaseState),
  },
  {
    name: "head_feature_mapping_propose",
    tool: {
      name: "head_feature_mapping_propose",
      description:
        "Normalize one fresh HEAD semantic proposal for exact Product-to-code or Product-to-test mapping candidates. Core verifies current graph endpoints and records only P3 candidates; it does not infer mappings from lexical overlap or create reviewed relationships.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          expected_candidate_set_id: {
            type: "string",
            pattern: "^feature-mapping-candidates-[a-f0-9]{24}$",
            description: "Explicitly replace this exact pending unreviewed batch with fresh evidence; never replaces a durable user decision.",
          },
          semantic_proposal: {
            type: "object",
            properties: {
              schema_version: { const: 1 },
              source_snapshot_id: { type: "string", pattern: "^source-snapshot-[a-f0-9]{24}$" },
              product_model_id: { type: "string", pattern: "^product-model-[a-f0-9]{24}$" },
              candidates: {
                type: "array",
                minItems: 1,
                maxItems: 500,
                items: {
                  type: "object",
                  properties: {
                    relationship_type: { type: "string", enum: ["IMPLEMENTS", "VERIFIED_BY"] },
                    source_node_id: { type: "string", minLength: 1 },
                    product_node_id: { type: "string", minLength: 1 },
                    explanation: { type: "string", minLength: 1, maxLength: 2000 },
                    confidence: { type: "number", minimum: 0, maximum: 1 },
                  },
                  required: ["relationship_type", "source_node_id", "product_node_id", "explanation", "confidence"],
                  additionalProperties: false,
                },
              },
            },
            required: ["schema_version", "source_snapshot_id", "product_model_id", "candidates"],
            additionalProperties: false,
          },
        },
        required: ["project_root", "semantic_proposal"],
        additionalProperties: false,
      },
    },
    mcp: {
      args: (args) => [
        {
          root: args.project_root,
          semanticProposal: featureMappingProposalFromMcp(args.semantic_proposal),
          expectedCandidateSetId: args.expected_candidate_set_id ?? null,
        },
      ],
    },
    cli: {
      command: "feature-mapping-start",
      flags: ["expected-candidate-set", "input"],
      args: ({ root, options, inputJson }) => [
        {
          root,
          semanticProposal: options.input ? inputJson(options, "Feature mapping semantic proposal") : null,
          expectedCandidateSetId: options["expected-candidate-set"] ?? null,
        },
      ],
    },
    impl: () => import("./feature-mapping.mjs").then((module) => module.startFeatureMapping),
  },
  {
    name: "head_feature_mapping_review",
    tool: {
      name: "head_feature_mapping_review",
      description:
        "Record one explicit user-authored ReviewDecision for the exact current Feature mapping candidate set. This requires explicit confirmation; only accepted candidates create separate reviewed relationships, and Product Canon remains unchanged.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          candidate_set_id: { type: "string", pattern: "^feature-mapping-candidates-[a-f0-9]{24}$" },
          disposition: { type: "string", enum: ["accept-all", "accept-selection", "reject"] },
          accepted_candidate_ids: {
            type: "array",
            uniqueItems: true,
            items: { type: "string", pattern: "^feature-mapping-candidate-[a-f0-9]{24}$" },
            default: [],
          },
          rationale: { type: "string", minLength: 1 },
          confirm_user_review: { type: "boolean" },
        },
        required: ["project_root", "candidate_set_id", "disposition", "rationale", "confirm_user_review"],
        additionalProperties: false,
      },
    },
    mcp: {
      before: (args) =>
        requireMcpConfirmation(
          args.confirm_user_review,
          "Feature mapping review requires explicit user confirmation.",
          "FEATURE_MAPPING_REVIEW_CONFIRMATION_REQUIRED",
        ),
      args: (args) => [
        {
          root: args.project_root,
          candidateSetId: args.candidate_set_id,
          disposition: args.disposition,
          acceptedCandidateIds: args.accepted_candidate_ids || [],
          rationale: args.rationale,
        },
      ],
    },
    cli: {
      command: "feature-mapping-review",
      flags: ["input"],
      args: ({ root, options, inputJson }) => [{ ...inputJson(options, "Feature mapping ReviewDecision"), root }],
    },
    impl: () => import("./feature-mapping.mjs").then((module) => module.reviewFeatureMapping),
  },
  {
    name: "head_feature_mapping_status",
    tool: {
      name: "head_feature_mapping_status",
      description:
        "Read and digest-verify the current Feature mapping candidate batch or explicit reviewed relationship decision without creating or promoting mappings.",
      inputSchema: {
        type: "object",
        properties: { project_root: { type: "string", minLength: 1 } },
        required: ["project_root"],
        additionalProperties: false,
      },
    },
    mcp: { args: (args) => [{ root: args.project_root }] },
    cli: { command: "feature-mapping-status", flags: [], args: ({ root }) => [{ root }] },
    impl: () => import("./feature-mapping.mjs").then((module) => module.inspectFeatureMapping),
  },
  {
    name: "head_onboarding_review",
    tool: {
      name: "head_onboarding_review",
      description:
        "Apply one explicit user-authored ReviewDecision to the exact current onboarding candidate set. Accept dispositions may change Product Canon; revise and reject preserve candidate or canon boundaries enforced by Core.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          candidate_set_id: { type: "string", pattern: "^onboarding-candidates-[a-f0-9]{24}$" },
          disposition: { type: "string", enum: ["accept-all", "accept-selection", "revise", "reject"] },
          accepted_candidate_ids: { type: "array", uniqueItems: true, items: { type: "string", pattern: "^onboarding-candidate-[a-f0-9]{24}$" } },
          removed_candidate_ids: { type: "array", uniqueItems: true, items: { type: "string", pattern: "^onboarding-candidate-[a-f0-9]{24}$" } },
          user_edits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                candidate_id: { type: "string", pattern: "^onboarding-candidate-[a-f0-9]{24}$" },
                entity: { type: "object" },
              },
              required: ["candidate_id", "entity"],
              additionalProperties: false,
            },
          },
          added_entities: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["FeatureGroup", "Capability", "Feature", "Requirement", "Constraint", "Decision"] },
                entity: { type: "object" },
              },
              required: ["kind", "entity"],
              additionalProperties: false,
            },
          },
          rationale: { type: "string", minLength: 1 },
        },
        required: ["project_root", "candidate_set_id", "disposition", "rationale"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    mcp: {
      args: (args) => [
        {
          root: args.project_root,
          candidateSetId: args.candidate_set_id,
          disposition: args.disposition,
          acceptedCandidateIds: args.accepted_candidate_ids || [],
          removedCandidateIds: args.removed_candidate_ids || [],
          userEdits: (args.user_edits || []).map((edit) => ({ candidateId: edit.candidate_id, entity: edit.entity })),
          addedEntities: args.added_entities || [],
          rationale: args.rationale,
        },
      ],
      after: (value) => compactReviewResult(value),
    },
    cli: {
      command: "onboarding-review",
      flags: ["input"],
      args: ({ root, options, inputJson }) => [{ ...inputJson(options, "Onboarding ReviewDecision"), root }],
    },
    impl: () => import("./onboarding.mjs").then((module) => module.reviewOnboarding),
  },
  {
    name: "head_markdown_projection_build",
    tool: {
      name: "head_markdown_projection_build",
      description:
        "Build or verify the deterministic local Markdown projection from the current verified GraphSnapshot. The generated view is rebuildable, non-authoritative, and never changes Product Canon.",
      inputSchema: {
        type: "object",
        properties: { project_root: { type: "string", minLength: 1 } },
        required: ["project_root"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: { args: (args) => [{ root: args.project_root }], after: (value) => compactMarkdownBuild(value) },
    cli: { command: "world-docs-build", flags: [], args: ({ root }) => [{ root }] },
    impl: () => import("./world-model.mjs").then((module) => module.materializeWorldMarkdownProjection),
  },
  {
    name: "head_bounded_worker_status",
    tool: {
      name: "head_bounded_worker_status",
      description:
        "Read and verify one P3 bounded worker dispatch without consuming its authorization. The optional historical prepared-input view keeps original references, runtime observations and model-use uncertainty separate; it does not change current execution or recovery authority.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          authorization_id: { type: "string", pattern: "^execution-authorization-[a-f0-9]{24}$" },
        },
        required: ["project_root", "authorization_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: {
      args: (args) => [{ root: args.project_root, authorizationId: args.authorization_id }],
      after: (value, args) => preparedRuntimeRead(args.project_root, value),
    },
    cli: { command: "worker-read", flags: ["authorization"], args: ({ root, options }) => [{ root, authorizationId: options.authorization }] },
    impl: () => import("./bounded-worker-dispatch.mjs").then((module) => module.readBoundedWorkerDispatch),
  },
  {
    name: "head_runtime_invocation_authorization",
    tool: {
      name: "head_runtime_invocation_authorization",
      description:
        "Read and digest-verify one Session- or Run-scoped ExecutionAuthorization. A read-only historical view checks retained original input references and canonical bytes/digest where available; preparation does not prove delivery or model use. No provider invocation or current execution permission.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          authorization_id: { type: "string", pattern: "^execution-authorization-[a-f0-9]{24}$" },
        },
        required: ["project_root", "authorization_id"],
        additionalProperties: false,
      },
    },
    mcp: {
      args: (args) => [{ root: args.project_root, authorizationId: args.authorization_id }],
      after: (value, args) => preparedRuntimeRead(args.project_root, value),
    },
    cli: {
      command: "runtime-invocation-read",
      flags: ["authorization"],
      args: ({ root, options }) => [{ root, authorizationId: options.authorization }],
      after: (value, { root }) => preparedRuntimeRead(root, value),
    },
    impl: () => import("./runtime-invocation-lifecycle.mjs").then((module) => module.readRuntimeInvocationAuthorization),
  },
  {
    name: "head_bounded_worker_prepare",
    tool: {
      name: "head_bounded_worker_prepare",
      description:
        "Optional managed path only, not a prerequisite for ordinary Host delegation. Prepare a bounded read-only patch-proposal worker through the built-in local Host without calling a model. HEAD supplies task, exact model, selected context and source/proposal paths from the conversation; never ask the user to write a module, JSON or IDs. Reuses current Session or active Run authority and an identical preparation. Does not apply patches, create a Run, approve results, inspect an account or start a worker. Host-global instruction selection is explicit input scope, not an enforcement assertion; selected-only is the default.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          task: { type: "string", minLength: 1 },
          model: { type: "string", minLength: 1 },
          task_key: { type: "string", pattern: "^[a-z][a-z0-9-]{0,95}$" },
          role: { type: "string", enum: ["developer", "coder", "reviewer"] },
          outcome: { type: "string", minLength: 1 },
          selected_context: { type: "string" },
          source_paths: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
          proposal_paths: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
          runtime: { type: "string", enum: ["codex", "claude", "opencode"] },
          timeout_ms: { type: "integer", minimum: 1000, maximum: 3600000 },
          instruction_scope: { type: "string", enum: ["selected-only", "host-global"] },
          context_mode: {
            type: "string",
            enum: ["fresh", "native-prefix"],
            description:
              "Default fresh uses one model turn. Explicit native-prefix uses selected_context in a new durable controlled seed and then a fork child (two turns total); not a fork of the current conversation or a stronger code-worker sandbox. HEAD must keep both calls and seed persistence within the existing authorized scope.",
          },
        },
        required: ["project_root", "task", "model"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: {
      args: (args, { workerJobSupervisor, workerPreparationBackend, signal, onProcess }) => [
        localWorkerInput(args),
        { root: args.project_root, supervisorSelection: workerJobSupervisor, protocolFixtureBackend: workerPreparationBackend, signal, onProcess },
      ],
    },
    cli: {
      command: "worker-prepare",
      flags: [
        "context",
        "context-mode",
        "input",
        "instruction-scope",
        "model",
        "outcome",
        "propose",
        "role",
        "runtime",
        "source",
        "task",
        "task-key",
        "timeout-ms",
      ],
      args: ({ root, options, inputJson, workerJobSupervisor, workerPreparationBackend, signal, onProcess }) => {
        const allowed = new Set([
          "input",
          "task",
          "task-key",
          "role",
          "outcome",
          "context",
          "source",
          "propose",
          "model",
          "runtime",
          "timeout-ms",
          "instruction-scope",
          "context-mode",
        ]);
        if (Object.keys(options).some((key) => !allowed.has(key)) || (options.input && Object.keys(options).length > 1))
          throw new Error("Worker preparation accepts one bounded task description, not Host configuration.");
        return [
          options.input
            ? inputJson(options, "Worker preparation")
            : {
                task: options.task,
                taskKey: options["task-key"],
                role: options.role,
                outcome: options.outcome,
                selectedContext: options.context,
                contextMode: options["context-mode"],
                sourcePaths: options.source ? options.source.split(",") : [],
                proposalPaths: options.propose ? options.propose.split(",") : [],
                model: options.model,
                runtime: options.runtime,
                timeoutMs: options["timeout-ms"] == null ? undefined : Number(options["timeout-ms"]),
                instructionScope: options["instruction-scope"],
              },
          { root, supervisorSelection: workerJobSupervisor, protocolFixtureBackend: workerPreparationBackend, signal, onProcess },
        ];
      },
    },
    impl: () => import("./local-worker-host.mjs").then((module) => module.prepareLocalBoundedWorker),
  },
  {
    name: "head_bounded_worker_start",
    tool: {
      name: "head_bounded_worker_start",
      description:
        "Start an optional managed worker, not a general Host spawn. Start a prepared worker by its task key or exact authorization using the built-in local Host and bounded native owner. Embedding Hosts remain supported. Repeated start never relaunches an uncertain job; no runner, environment or enforcement assertion is accepted.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          authorization_id: { type: "string", pattern: "^execution-authorization-[a-f0-9]{24}$" },
          task_key: { type: "string", pattern: "^[a-z][a-z0-9-]{0,95}$" },
          role: { type: "string", enum: ["developer", "coder", "reviewer"] },
        },
        required: ["project_root"],
        oneOf: [
          { required: ["authorization_id"], not: { required: ["task_key"] } },
          { required: ["task_key"], not: { required: ["authorization_id"] } },
        ],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    mcp: {
      args: (args, { workerJobHost, workerJobSupervisor, onProcess }) => [
        { root: args.project_root, ...localWorkerInput(args, true) },
        { host: workerJobHost, supervisorSelection: workerJobSupervisor, onProcess },
      ],
    },
    cli: {
      command: "worker-start",
      flags: ["authorization", "role", "task-key"],
      args: ({ root, options, workerJobHost, workerJobSupervisor, onProcess }) => {
        if (Object.keys(options).some((key) => !["task-key", "authorization", "role"].includes(key)))
          throw new Error("Worker start does not accept Host configuration.");
        return [
          { root, authorizationId: options.authorization, taskKey: options["task-key"], role: options.role },
          { host: workerJobHost, supervisorSelection: workerJobSupervisor, onProcess },
        ];
      },
    },
    impl: () => import("./local-worker-host.mjs").then((module) => module.startLocalBoundedWorker),
  },
  {
    name: "head_product_initiative_propose",
    tool: {
      name: "head_product_initiative_propose",
      description:
        "Propose a Product Initiative from persisted hypotheses or inline reasoning. Feature resolution may be deferred to explicit review; proposal never approves the initiative or mutates Product Canon.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 },
          description: { type: "string" },
          reasoning: { type: "string" },
          hypothesis_ids: { type: "array", uniqueItems: true, items: { type: "string", pattern: "^product-hypothesis-[a-f0-9]{24}$" } },
          feature_resolution: {
            oneOf: [
              {
                type: "object",
                properties: { kind: { const: "existing-feature" }, feature_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" } },
                required: ["kind", "feature_key"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  kind: { const: "candidate" },
                  feature: {
                    type: "object",
                    properties: {
                      key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
                      name: { type: "string", minLength: 1 },
                      description: { type: "string" },
                      capability_keys: { type: "array", uniqueItems: true, items: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" } },
                    },
                    required: ["key", "name"],
                    additionalProperties: false,
                  },
                },
                required: ["kind", "feature"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: { kind: { const: "gap" }, reason: { type: "string", minLength: 1 } },
                required: ["kind", "reason"],
                additionalProperties: false,
              },
            ],
          },
        },
        required: ["project_root", "title"],
        additionalProperties: false,
      },
    },
    mcp: {
      args: (args) => [
        {
          root: args.project_root,
          title: args.title,
          description: args.description || "",
          reasoning: args.reasoning || "",
          hypothesisIds: args.hypothesis_ids || [],
          featureResolution: args.feature_resolution == null ? null : productFeatureResolutionFromMcp(args.feature_resolution),
        },
      ],
    },
    cli: {
      command: "product-initiative-propose",
      flags: ["input"],
      args: ({ root, options, inputJson }) => [{ ...inputJson(options, "ProductInitiativeCandidate"), root }],
    },
    impl: () => import("./product-operating-loop.mjs").then((module) => module.proposeProductInitiative),
  },
  {
    name: "head_product_initiative_review",
    tool: {
      name: "head_product_initiative_review",
      description:
        "Record the user's explicit accept/reject ReviewDecision for one Product Initiative candidate. Acceptance resolves any deferred Feature mapping, creates a separate reviewed Initiative, and never mutates Product Canon.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          initiative_candidate_id: { type: "string", pattern: "^product-initiative-candidate-[a-f0-9]{24}$" },
          disposition: { type: "string", enum: ["accept", "reject"] },
          rationale: { type: "string", minLength: 1 },
          confirm_user_review: { type: "boolean" },
          feature_resolution: {
            oneOf: [
              {
                type: "object",
                properties: { kind: { const: "existing-feature" }, feature_key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" } },
                required: ["kind", "feature_key"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  kind: { const: "candidate" },
                  feature: {
                    type: "object",
                    properties: {
                      key: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
                      name: { type: "string", minLength: 1 },
                      description: { type: "string" },
                      capability_keys: { type: "array", uniqueItems: true, items: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" } },
                    },
                    required: ["key", "name"],
                    additionalProperties: false,
                  },
                },
                required: ["kind", "feature"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: { kind: { const: "gap" }, reason: { type: "string", minLength: 1 } },
                required: ["kind", "reason"],
                additionalProperties: false,
              },
            ],
          },
        },
        required: ["project_root", "initiative_candidate_id", "disposition", "rationale", "confirm_user_review"],
        additionalProperties: false,
      },
    },
    mcp: {
      before: (args) =>
        requireMcpConfirmation(
          args.confirm_user_review,
          "Product Initiative review requires explicit user confirmation.",
          "PRODUCT_INITIATIVE_REVIEW_CONFIRMATION_REQUIRED",
        ),
      args: (args) => [
        {
          root: args.project_root,
          initiativeCandidateId: args.initiative_candidate_id,
          disposition: args.disposition,
          rationale: args.rationale,
          featureResolution: args.feature_resolution == null ? null : productFeatureResolutionFromMcp(args.feature_resolution),
        },
      ],
    },
    cli: {
      command: "product-initiative-review",
      flags: ["input"],
      args: ({ root, options, inputJson }) => [{ ...inputJson(options, "Product Initiative ReviewDecision"), root }],
    },
    impl: () => import("./product-operating-loop.mjs").then((module) => module.reviewProductInitiative),
  },
  {
    name: "head_observation_ingest",
    tool: {
      name: "head_observation_ingest",
      description:
        "Ingest one already constructed bounded CI or Host Observation. The Host adapter owns source access, binding, digests, coverage, and provenance confirmation; this tool does not ask the user to attest to machine evidence.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          binding: observationBindingSchema,
          descriptor: observationDescriptorSchema,
          observation: observationInputSchema,
          confirm_host_observation: { type: "boolean" },
        },
        required: ["project_root", "binding", "descriptor", "observation", "confirm_host_observation"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    mcp: {
      before: (args) =>
        requireMcpConfirmation(
          args.confirm_host_observation,
          "Observation collection requires explicit confirmation that the payload came from the exact Host source binding.",
          "OBSERVATION_HOST_CONFIRMATION_REQUIRED",
        ),
      args: (args) => [
        {
          root: args.project_root,
          binding: observationBindingFromMcp(args.binding),
          descriptor: observationDescriptorFromMcp(args.descriptor),
          input: observationInputFromMcp(args.observation),
        },
      ],
    },
    cli: {
      command: "observation-ingest",
      flags: ["input"],
      args: ({ root, options, inputJson }) => {
        const value = inputJson(options, "Observation collection");
        return [{ root, binding: value.binding, descriptor: value.descriptor, input: value.input }];
      },
    },
    impl: () => import("./observation-adapter.mjs").then((module) => module.ingestStructuredObservation),
  },
  {
    name: "head_observation_derive",
    tool: {
      name: "head_observation_derive",
      description:
        "Record a deterministic P3 derived Observation from exact existing Observation IDs and an algorithm digest. It cannot assert causality or Product success.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          descriptor: observationDescriptorSchema,
          subject: {
            type: "object",
            properties: { type: { type: "string", minLength: 1 }, key: { type: "string", minLength: 1 } },
            required: ["type", "key"],
            additionalProperties: false,
          },
          temporal_scope: observationInputSchema.properties.temporal_scope,
          input_observation_ids: {
            type: "array",
            minItems: 1,
            maxItems: 64,
            uniqueItems: true,
            items: { type: "string", pattern: "^observation-[a-f0-9]{24}$" },
          },
          algorithm: {
            type: "object",
            properties: {
              key: { type: "string", minLength: 1 },
              version: { type: "string", minLength: 1 },
              digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
            },
            required: ["key", "version", "digest"],
            additionalProperties: false,
          },
          coverage: observationCoverageSchema,
          payload: { type: "object" },
          confirm_host_derivation: { type: "boolean" },
        },
        required: [
          "project_root",
          "descriptor",
          "subject",
          "temporal_scope",
          "input_observation_ids",
          "algorithm",
          "coverage",
          "payload",
          "confirm_host_derivation",
        ],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    mcp: {
      before: (args) =>
        requireMcpConfirmation(
          args.confirm_host_derivation,
          "Derived Observation recording requires explicit confirmation that the payload came from the named deterministic algorithm.",
          "OBSERVATION_DERIVATION_CONFIRMATION_REQUIRED",
        ),
      args: (args) => [
        {
          root: args.project_root,
          descriptor: observationDescriptorFromMcp(args.descriptor),
          input: {
            subject: args.subject,
            temporalScope: { observedAt: args.temporal_scope.observed_at, start: args.temporal_scope.start, end: args.temporal_scope.end },
            inputObservationIds: args.input_observation_ids,
            algorithm: args.algorithm,
            coverage: observationCoverageFromMcp(args.coverage),
            payload: args.payload,
          },
        },
      ],
    },
    cli: {
      command: "observation-derive",
      flags: ["input"],
      args: ({ root, options, inputJson }) => {
        const value = inputJson(options, "Derived Observation");
        return [{ root, descriptor: value.descriptor, input: value.input }];
      },
    },
    impl: () => import("./observation-store.mjs").then((module) => module.recordDerivedObservation),
  },
  {
    name: "head_conformance_propose",
    tool: {
      name: "head_conformance_propose",
      description:
        "Record one or more provider-HEAD semantic Conformance candidates only after Core verifies exact current Canon and evidence anchors. Candidates are P3 evidence, never violations, decisions, execution authority, recovery direction, or ordinary-work gates.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          baseline: conformanceBaselineSchema,
          findings: { type: "array", minItems: 1, maxItems: 64, items: conformanceFindingInputSchema },
        },
        required: ["project_root", "baseline", "findings"],
        additionalProperties: false,
      },
    },
    mcp: {
      args: (args) => [
        { root: args.project_root, baseline: conformanceBaselineFromMcp(args.baseline), findings: args.findings.map(conformanceFindingFromMcp) },
      ],
    },
    cli: {
      command: "conformance-propose",
      flags: ["input"],
      args: ({ root, options, inputJson }) => [{ ...inputJson(options, "Conformance provider-Lode proposal"), root }],
    },
    impl: () => import("./conformance-reconciliation.mjs").then((module) => module.proposeConformanceFindings),
  },
  {
    name: "head_conformance_resolution_propose",
    tool: {
      name: "head_conformance_resolution_propose",
      description:
        "Record a provider-HEAD resolution candidate against a fresh exact baseline. It does not close the Finding; only a later explicit exact-finding disposition can do so.",
      inputSchema: {
        type: "object",
        properties: {
          project_root: { type: "string", minLength: 1 },
          finding_id: { type: "string", pattern: "^conformance-finding-[a-f0-9]{24}$" },
          baseline: conformanceBaselineSchema,
          evidence_anchors: { type: "array", minItems: 1, maxItems: 64, items: conformanceEvidenceAnchorSchema },
          assessment: { type: "string", enum: ["appears-resolved", "still-present", "uncertain"] },
          rationale: { type: "string", minLength: 1 },
        },
        required: ["project_root", "finding_id", "baseline", "evidence_anchors", "assessment", "rationale"],
        additionalProperties: false,
      },
    },
    mcp: {
      args: (args) => [
        {
          root: args.project_root,
          findingId: args.finding_id,
          baseline: conformanceBaselineFromMcp(args.baseline),
          evidenceAnchors: args.evidence_anchors.map(conformanceEvidenceAnchorFromMcp),
          assessment: args.assessment,
          rationale: args.rationale,
        },
      ],
    },
    cli: {
      command: "conformance-resolution-propose",
      flags: ["input"],
      args: ({ root, options, inputJson }) => [{ ...inputJson(options, "Conformance provider-Lode resolution"), root }],
    },
    impl: () => import("./conformance-reconciliation.mjs").then((module) => module.proposeConformanceResolution),
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

// Runs one registered operation for one surface ("mcp" or "cli"):
// before(input, context) -> args(input, context) -> impl()(...args) -> after(value, input, context).
// before and after are optional surface adapters (an explicit confirmation, a
// compact MCP result, an added optional view); they never run for the other surface.
export async function callRegistered(entry, surface, input, context = input) {
  const side = entry[surface];
  side.before?.(input, context);
  const callArguments = side.args(input, context);
  const implementation = await entry.impl();
  const value = await implementation(...callArguments);
  return side.after ? await side.after(value, input, context) : value;
}

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

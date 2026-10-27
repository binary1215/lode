# Runtime adapter contracts

## Ordinary Host delegation versus managed runtime

Direct Lode work is the overall default. Ordinary delegation uses tools already
offered by the current Host, a short brief, owned scope and Lode integration;
it does not call managed prepare/execute APIs merely because a worker is useful.
Use supported fresh/direct/sequential work when the Host lacks a capability.
Forked input stays within user scope. Preserve user edits and reconcile unknown
effects before repeating them. Ordinary Host work does not claim managed
isolation, leases, durable reattachment or at-most-once application.

The managed contracts below support useful new durable work and retained work
when recovery, ownership or effect reconciliation needs them. File edits, worker
count and ordinary Host failure alone do not require this path. Keep their authorization, source-basis,
lease and cleanup checks. A risk lane, including Run, does not select a launcher. Host
results are evidence, not Canon approval or P2 recovery direction. Ordinary
results need no additional review click; protected transitions and active Run
contracts keep their existing rules.

## Optional native observations

Codex/Claude packaged lifecycle Hooks now write a bounded Host-local P5
`native-observations` snapshot, separate from selection bindings and canonical
`.lode` records. Existing trusted native `lode_project_status` reads it without
writes and adds one optional `nativeContext` in text and structured output.
The caller is not the queried logical Session's execution. A response-end or
caller-end observation cannot close work, grant approval or authorize replay.
Missing/corrupt/busy optional state is omitted, not a new recovery gate.

Snapshots retain at most 64 slots/64 actual replay IDs in 128 KiB, including at
most two first-observed typed ancestry rows; older events are evicted first so
a missing original mapping cannot silently become a later parent mapping. A per-caller
200 ms bounded writer lock covers merge and atomic publication. Status adds at
most 16 KiB of serialized response increment, including duplicated/escaped text
and structured data; omitted rows are counted. These bounds limit operational
cost, not semantic sufficiency or the existing Capsule/P3 expansion contracts.
No daemon, whole-caller registry, transcript scan or process census is added.

Supported Codex own first metadata (source-shaped against upstream commit
`8c076942cb70fba8e5c4732c23f1faabc4aed484`) can supply explicit fork/parent edges.
Shared-root child membership is not a direct-parent edge. The mapping captured
when an edge is first retained, including no mapping, is not replaced by a later
parent selection. Native `lode_conversation_enter` may show fresh verified
historical source P3 bodies before its final child basis check; parent P2 never
becomes the child's purpose or direction. This unstable format adapter is not a
universal native-history parser or proof of copied fork-cutoff membership.

Claude local Windows/Linux association follows at most eight actual ancestors,
checks exact `<pid>.json` registry entries and OS birth, and probes at most 16
known witnessed instances per status in one bounded batch. Missing registry,
permission, unsupported platform or foreign environment is unknown. Definitive
absence/birth change qualifies only the old hosting instance, not a task or
agent's activity. No witnessed engine is terminated. The Windows helper is
hidden, finite and task-owned; macOS/remote attestation is not implemented.

`scripts/opencode-plugin.mjs` is a dependency-free OpenCode v1.19.0-shaped V1
default `{id, server}` entry. A local `.opencode/plugins/lode-agent.js` shim can
re-export that default; it is not auto-installed or added to user config.
Only a config-proven local command for this packaged `scripts/mcp-server.mjs`
and unambiguous sanitized alias is recognized. Actual event callbacks feed the
same store; actual raw MCP `tool.execute.after` adds the optional status section
to the same output object. It uses the supplied exact-session lookup and at most
one bounded status map (O(A), not an exact-ID API), never a new SDK/client/auth.
Experimental code-mode and OpenCode ancestry/P3 entry remain outside this path.

Marketplace client launch lines remain portable. Inside a loaded Claude plugin,
`${CLAUDE_PLUGIN_ROOT}` is the Host-supplied plugin root. In contrast, explicit
CLI initialization generates a machine-local Claude project configuration using
`node` and a verified local entry; it does not assume that plugin-only variable
exists. For an owned standalone installation with a recorded command address,
the project configuration names its existing launcher with the internal MCP
mode. The launcher verifies ownership, `current.json`, the selected release and
its hashes before executing the ordinary MCP server. The existing installation
marker records the explicitly selected bin directory; no PATH/default-install or
latest-cache search chooses another installation. The address follows future
launches after upgrade or rollback in the same installation root.

Packages without a verified stable launcher, including older markers without a
command address and marketplace caches, keep the selected absolute package MCP
entry and working directory. A moved/deleted installation root does not repair
itself: explicit installation selection and resume/convergence reconnect managed
projections. User-owned configuration stays untouched. Neither pointer changes
nor configuration convergence reload an already running MCP server. This local
Claude projection is not a portable file to copy between machines.

Codex project init writes no MCP path; its plugin `.mcp.json` stays `node` plus
`scripts/mcp-plugin-server.mjs` with `cwd` `.`, and hooks expand `${PLUGIN_ROOT}`.
OpenCode `opencode.json` stays `node` and
`{env:LODE_PLUGIN_ROOT}/scripts/mcp-server.mjs`; its config hook resolves the
placeholder in memory without writing an absolute install or Node path into
that shared file. `.lode/generated/manifest.json` records `pluginRoot` as local
installation identity. Default graph-explorer HTML retains local `project.root`
and `regenerate.argv`; `--share` omits those generated regeneration paths.

The packaged plugin entry serves the same Core as `scripts/mcp-server.mjs`.
Only a verified Claude plugin payload, exact private Hook tool-use correlation,
matching plugin namespace/native caller and trusted Hook cwd matching this
request's canonical Project root can omit creating a new project `.mcp.json`.
The shared child-write guard runs before this optional Project lookup. Existing
manual or managed files are preserved; no server is removed. Source, standalone,
other carriers, missing evidence and invalid provenance retain ordinary
provisioning. ENV values, model arguments, server names or a launch object alone
cannot establish this proof. A later standalone resume can provide an absent
file without asking the user to compose JSON.

This installation context expires with the request. File-ownership metadata is
not a receipt for future Host access, a Session selector, P2 recovery direction
or permission. Package-local checks retain source hashes, exact projected MCP,
entry/module declarations and exact file tree; outer marketplace repository and
commit checks remain separate. Local synthetic stdio tests do not establish
installed Host loading, Hook interpolation or model reception.

With `LODE_SUBAGENT_WRITE_GUARD` unset, only supported exact-correlated
Claude/OpenCode child state writes are protected by default. Codex and unproven
callers stay off by default. Explicit `enforce` preserves the existing broader
known-child policy; `off` disables this optional Host policy and its additional
lookup/correlation cost. An invalid value warns once per changed value without
echoing it, and disables protection rather than blocking ordinary work.
The catalog's effect metadata determines coverage after router unwrap, once per
MCP call, before optional Session-binding diagnostics. Reads, parent/independent
work and ordinary source edits remain available. Unsupported or failed native
evidence is unknown, never a protection success, permission or Session binding.

Local source-shaped tests and owned OS helper tests do not establish installed
Host event delivery, model tool choice, native long-compaction behavior or full
activity coverage. Codex live conversation/turn state uses already exposed Host
tools only when useful; see [runtime composition](../skills/lode-agent-core/references/runtime-composition.md#native-observations-and-current-host-activity).

## Historical prepared input

Existing `lode_runtime_invocation_authorization`, `lode_bounded_worker_status`
and CLI `runtime-invocation-read --authorization <id>` add an optional
`preparedInput` view at their explicit read/status boundary. The shared canonical
authorization/dispatch readers and prepare/execute/apply checks are unchanged.
Failure to load this optional view leaves the primary result usable; selecting
an authorization with an invalid owner or digest still fails as before.

The non-persisted P4 view reads exact retained authorization, plan, contract,
Capsule and captured `ProjectDirection` revision references. It reuses the
canonical serializer and verifies byte count and digest against `executionInput`
before reporting `verified-prepared-input`. Plans/contracts retain their existing
Project scope; no Session owner is invented. Current source or direction is not
substituted for historical originals. Missing/integrity failures, bounded
originals and legacy requests without retained full input remain distinct.
Exact paths/digests and a UTF-8 excerpt of at most 2048 bytes disclose omissions.

Preparation is separate from runtime receipt observations and model use.
Synthetic receipts are labelled as such; even a matching runtime observation
does not prove delivery to a model, attention or use. This is the Core canonical
input, not a complete Host/model prompt. No provider, process, new snapshot,
native-to-authorization inference or P2 write is involved. Later cancellation and
current execution/recovery checks continue to govern effects. Ordinary native
ancestry remains a later-reference read, not reconstructed fork-time input.

## Retained one-shot worker contracts

Managed worker mutations use `node scripts/lode.mjs managed <command> ...`
or `lode_tools_call` with `execution_mode: "managed"` and the discovered original
schema. Lode supplies this route without a user unlock. Raw managed names stay
fenced on ordinary MCP, while the retained `managed-maintenance` CLI and separate
stdio server remain compatible entries. Prepare/start/dispatch/execute/apply,
reconcile, integration and wave mutations keep all authorization, lease, lineage
and effect checks. History/status/wait/result reads and exact owned cancellation
remain ordinary operations. Routing itself grants no authority.

Operating-lane advice `0.2.0` separates `executionLane` from an authorization
decision. Credentials alone do not require Authority; approved external effects
and a one-shot independent second opinion do not alone require a Run. Real
dependent results, consequential/irreversible effects and recovery branches still
select Run. `authorizationStatus` is an assessment, never a permission grant:
existing runtime scope restrictions remain unchanged (Session runtime does not
gain external-write permission from advice).

The existing worker dispatch/execute/read/wait flow accepts an idle Session
ExecutionAuthorization. CLI `managed worker-execute --input <file>` supplies only the
exact `sessionRequest` frozen in that authorization. No Run, WholePlan, contract
or compulsory persisted Capsule is created. Typed MCP dispatch/status/wait use
the same Core identity; managed execution uses its explicit route and original checks.
Maintenance MCP start uses the trusted Host connection described below, not
caller-supplied execution policy. Lode consumes the bounded invocation result
as evidence. `worker-apply` and waves remain Run-only. Requested admission uses
the same Host registry, request/ownership checks, at-most-once lease and cleanup
proof; it is never silently skipped. Passive historical read/wait verifies
identity and integrity without demanding a currently active Run. Creation and
execution still require current scope. Exact legacy Run dispatch replay reuses
its immutable bytes rather than rewriting its protocol.

Runtime-adapter contract `0.1.0` establishes the v0.6 provider-neutral boundary. Runtime-machine-discovery protocol `0.1.0` adds current-host read-only executable discovery, runtime-version-evidence protocol `0.1.0` adds a bounded non-session direct version invocation, runtime-protocol-evidence protocol `0.2.0` observes fixed provider-specific help surfaces and exact one-shot option sets, and runtime-project-binding protocol `0.1.0` binds those observations to canonical Lode project and Session identities. Execution-authorization protocol `0.3.0` adds one envelope with `scope.kind: session | run` and an optional exact `provider/model` selection; execution-lease protocol `0.3.0` separates durable consumption/release evidence from operational owner state; process-supervisor protocol `0.1.0` and manifest `0.3.0` (schema `2`), event-envelope `0.1.0`, structured-result `0.1.0`, lifecycle-receipt `0.6.0`, and ResultPacket-draft `0.5.0` carry scope through the common lifecycle boundary. Claude Code, Codex, and OpenCode one-shot adapters share the same native descendant-tree supervisor and invocation-record core. All three pass deterministic Session/Run authorization, lifecycle, event, result, and provider-specific protocol-fixture conformance. Codex and OpenCode additionally retain completed live Session/Run evidence; Claude Code live model-call conformance is available through the same opt-in verifier but is not claimed until run. Fresh-process Codex-to-OpenCode artifact recovery also passes. Lode supplies only the exact authorized model plus an ephemeral permission/privacy overlay; provider authentication and routing remain provider-owned. Lode neither synthesizes provider packages nor rewrites configured endpoints. Ordinary delegation is Host-owned; optional exact endpoint attachment uses the current Host snapshot. Role mail and export delivery machinery have been removed. Provider-specific execution codecs stay behind the Host adapter boundary; effective OS/tool enforcement requires a trusted connected backend. Herdr-specific socket, pane and TUI integration remains outside Core. Provider resume and general runtime controls remain disabled.

The supervisor manifest declares both process supervision and file-effect entry
points. Its schema `2` / manifest `0.3.0` is distinct from the unchanged supervisor
protocol `0.1.0`. Manifest `0.3.0` also declares the separate `--interactive`
protocol `0.1.0`: a bounded bootstrap line followed by streaming stdio, while
the existing one-shot protocol remains unchanged. This is capability metadata, not execution/write authorization,
Product Canon promotion or P2 recovery authority. `mutatesCanon: false` does not
mean the helper cannot physically write files. Core must bind authorized effects,
and runtime platform/target preflight must still verify support for each operation.

```text
Lode Core
  -> AgentRuntimeAdapter
       -> Claude Code projection-only reference
       -> Codex projection-only reference
       -> OpenCode projection-only reference
  -> PlatformAdapter
       -> Windows contract reference
       -> macOS contract reference
       -> Linux contract reference
  -> WorkspaceHostAdapter
       -> native-process contract reference
       -> optional verified exact-endpoint attachment
            -> injected provider-neutral WorkspaceHostDriver
                 -> host-export attachment-only current snapshot
```

`AgentRuntimeAdapter` fixes the method surface `probe`, `start`, `resume`, `stream`, `interrupt`, and `close`. `PlatformAdapter` fixes platform-owned executable discovery, owned-process start/inspection/termination, paths, permissions, IPC, atomic file operations, and service lifecycle. `WorkspaceHostAdapter` provides optional attachment, current endpoint status, and detachment. An injected driver may support delivery, but the filesystem export bridge is attachment-only: it writes no message queue or delivery receipt and reports `deliverySupported: false`. Ordinary worker messaging remains owned by Host tools.

The reference contract adapters support only static `probe`. Every control method fails with `RUNTIME_ADAPTER_CONTROL_NOT_ENABLED`. A verified Host composition may activate exact optional attachment and detachment; ordinary messaging stays owned by current Host tools. It does not enable AgentRuntime or Platform control. The default contract matrix covers Claude Code, Codex, and OpenCode across Windows, macOS, and Linux, but explicitly records:

- `actualPlatformExecutionValidated: false`;
- `actualRuntimeControlValidated: false`;
- `machineInterfacesVerified: false`;
- `runtimeControlEnabled: false`.

The matrix proves deterministic contract shape and authority boundaries. It does not claim that any runtime is installed, reachable, resumable, or controllable on every listed operating system.

The operational one-shot supervisor has a narrower control surface than the
static `AgentRuntimeAdapter`. `spawnBoundedRuntimeOneShot` returns one random
host-only token once, accepts only `interrupt` or `close` for the exact owned
Claude Code/Codex/OpenCode provider tree, rejects a conflicting second action, and emits a
content-derived `RuntimeOneShotControlReceipt` after native cleanup. The token,
PID, provider session, prompt, and transcript are omitted from that control receipt;
separate selected-input P3 and output-spool P5 retention are described below. `resume` and
`stream` fail closed with `RUNTIME_ADAPTER_CONTROL_NOT_ENABLED`. Deterministic
Windows Job Object fixtures and real already-running Codex/OpenCode clients prove
both actions and descendant cleanup. This does not activate durable provider-
session control or broaden `ExecutionAuthorization`.

Session continuation is narrower still. Core first rebuilds the exact P2
`SessionRestoreProjection`; only afterward may an injected WorkspaceHost adapter
fresh-verify an already-running Lode endpoint. The returned P5
`ContinuationOutcome` is non-persisted and cannot alter the projection. Missing,
stale, or unsupported attachment yields an explicit fresh logical Lode fallback.
This is semantic recovery plus optional conversation continuity, not general
provider `resume` or `stream`.

Compaction lifecycle integration is another optional P5 Host composition. A
`CompactionLifecycleHostAdapter` exposes journaled conversation-entry,
provider-replacement, and pre/post-compaction events bound to the exact Project,
Lode Session, runtime, and trusted user-turn sequence. It retains the raw
continuation token outside project Canon. Core performs read-only artifact entry
restore automatically and restores P2 before verifying or consuming a reported
successful compaction. `failed` aborts only the epoch; `uncertain` is never
replayed automatically. The descriptor forbids provider/session/process/UI
identity and all P1-P4 authority. Without this adapter, ordinary work and
first-turn artifact restore remain available while provider compaction stays
Host-owned.

Worker ownership is represented by P3 `BoundedWorkerDispatch`; durable consumption
and release are evidence, while operational lease ownership/process/wait state
remains P5. One exact `ExecutionAuthorization` is still
consumed at most once by the existing native supervisor. A completed actual-
provider draft can become a ResultPacket only through the existing application
gate, then requires Fresh Lode review and explicit P2 integration. Dispatch and
wait cannot write WholePlan, ReviewDecision, or checkpoint direction.

A provider-neutral `BoundedWorkerWave` optionally groups 2-64 already-created
dispatches for concise launch visibility. It stores no caller handle or provider/
Herdr session topology, creates no authorization, and never shares a lease.
Explicit seal requires verified consumption of every independent authorization;
open-wave aggregate result read and wait fail closed. P4 status/results and P5
wait cannot apply results or perform HF-010 integration. See
[`bounded-worker-wave.md`](bounded-worker-wave.md).

The separate current-host discovery composition uses a read-only `PlatformAdapter` to inspect absolute PATH entries for regular Claude Code, Codex, and OpenCode launcher candidates. It records only runtime name, availability, launcher kind, byte length, symlink/direct-spawn safety, and SHA-256 identities of the discovered and canonical paths. It never returns a raw path, environment value, command, argument, provider session, prompt, transcript, endpoint, credential, or process identity. A read-only `AgentRuntimeAdapter` binds each observation to one selected runtime, while the native-process `WorkspaceHostAdapter` reports only that its discovery boundary is present.

On the current Windows host Claude Code, Codex, and OpenCode candidates are discovered through this boundary. The discovery composition still records:

- `machineInterfaceDiscoveryValidated: true`;
- `actualPlatformExecutionValidated: false`;
- `actualRuntimeControlValidated: false`;
- `runtimeControlEnabled: false`.

The separate version-evidence composition may directly invoke only a discovered native, non-symlink executable with the fixed `--version` argument. The workspace-host boundary uses one exact child process, `shell: false`, ignored stdin, a five-second timeout, 16 KiB stdout/stderr limits, and an OS-minimal environment that does not forward project or GraphDB credentials. It creates no provider session, passes no project content, and stores only a normalized semantic version, output digest, byte counts, exit state, and cleanup facts. Raw paths and raw output are never returned.

The current Windows execution verified the installed Claude Code, Codex, and OpenCode version surfaces. Runtime-version evidence records `actualPlatformExecutionValidated: true` only when every selected runtime completes this exact non-session probe. It continues to record:

- `actualRuntimeControlValidated: false`;
- `runtimeControlEnabled: false`;
- `providerSessionCreated: false`;
- `capabilityDoesNotGrantAuthorization: true`.

The protocol-evidence composition runs fixed help profiles through the same direct-child, no-shell, ignored-stdin, minimal-environment boundary. Claude Code is checked for non-interactive print mode, stream-json, JSON Schema output, non-persisted sessions, permission/tool controls, disabled skills, bounded setting sources, strict MCP isolation, and resume/continue discovery. Codex is checked for non-interactive execution, JSON events, output schema, color control, sandbox selection, Git-check bypass, working-directory binding, ephemeral execution, resume surface, stdio app-server transport, and protocol schema generation. OpenCode is checked for non-interactive `run`, JSON event format, resume/continue surface, ACP, project-directory binding, and headless server discovery. Parser output is reduced to allowlisted signal names, support status, output digests and sizes, and exact-child lifecycle facts. Raw arguments, raw help text, paths, environment, provider session IDs, and PIDs are not returned.

The current Windows execution observes the required non-interactive and machine-protocol surfaces for Claude Code, Codex, and OpenCode. This records `actualProviderProtocolObservationValidated: true`, but `actualProviderSessionControlValidated`, provider-session creation, and runtime control remain false.

`RuntimeProjectBinding` then binds the version and protocol evidence identities to the canonical `.lode/project.json` project ID and the selected logical Lode Session ID (the legacy `current.json` remains default). The physical project root is reduced to a digest and no project content is sent during these probes. This is a capability-reference binding only: it proves which Lode project and Session inspected the installed interfaces, not that a provider session was created or attached to that project.

## Risk-proportional execution authorization

`runtime-invocation-authorize` produces one immutable `ExecutionAuthorization` envelope. A `session` scope requires an idle Lode Session, records the user-request digest and byte count, permits only local reversible `project.read` or `project.write`, forbids canon mutation and external effects, and may reference a ContextCapsule. It does not require WholePlan, ExecutionContract, Run, or Fresh Lode review. A `run` scope requires the exact active Run and its digest-verified `WholePlanSnapshot`, `ExecutionContract`, and persisted `ContextCapsule`; the contract must explicitly include `runtime.invoke` and the selected workspace permission. Both scopes require an enabled runtime and an observed current-host protocol binding. Optional `runtimeSelection.model` must be a bounded `provider/model` identifier and becomes part of the authorization digest, so changing a model requires a new authorization rather than silently following a user-global default. The provider implementation, endpoint, and credential remain operational OpenCode settings rather than Lode presets or semantic graph data.

The envelope records only canonical Lode identities, the selected scope, runtime, optional model selection, workspace mode, exact allowed-action requirements, project-root digest, capability-evidence identities, execution-input digest/byte count, and bounded time/input/output/event limits. Credentials and endpoints remain operational environment inputs and are not added to the authorization or project artifacts. The base `0.3.0` envelope does not retain raw Session requests or reconstructed Run input. Optional retained-worker `0.4.0`–`0.7.0` envelopes instead persist selected context, source bytes and the Session request in `workerInput` as P3 evidence (`rawContentPersisted: true`); `0.5.0` adds workspace binding, `0.6.0` write preimages, and distinct read-only `0.7.0` a proposal basis without worker write authority. This selected evidence is not a raw conversation transcript and cannot author P2 direction. Authorization does not itself start a provider.

## Durable at-most-once execution lease

The execution path first requires the exact digest-verified persisted authorization, then claims an authorization-specific `owner.lock` with an exact PID/token owner only for operational serialization. PID, token, and the owner lock live under a dedicated host-local operational root, never below the project tree. Windows defaults to `%LOCALAPPDATA%\lode-agent-core\operational-state`; Unix-like hosts use `$XDG_STATE_HOME/lode-agent-core` or `~/.local/state/lode-agent-core`. A host may set the absolute `LODE_AGENT_OPERATIONAL_STATE_ROOT` process configuration for isolated installations and tests, but execution requests and project files cannot select it. Root, project-local, project-containing, relative, symlinked, and escaping operational paths fail closed.

Before any child starts, the plugin atomically creates an immutable `RuntimeExecutionLeaseConsumption` receipt below project lineage. That receipt binds the authorization hash, project, Lode Session, scope kind, optional Run/ExecutionContract, runtime, caller-fence digest, claim/consumption deadline, and the explicit boundary `atMostOnce: true` / `replayAllowed: false`. A crash after consumption never makes the authorization reusable; recovery requires a new Lode decision rather than silent replay.

After the exact child exits—or the operation throws—the owner lock and empty authorization/project operational directories are removed, while the shared host-local root remains. An immutable project-lineage `RuntimeExecutionLeaseRelease` records the operation status, optional lifecycle-receipt identity, and exact-owner cleanup. A pre-consumption dead owner can be recovered only when its PID is proven absent. A live or ambiguous owner remains busy even after its hold deadline; the plugin never kills an unknown process. PID, token, and the operational path are excluded from consumption, release, lifecycle, ResultPacket-draft, CLI, and MCP artifacts. Lease inspection discloses only `location: host-local-outside-project` plus boolean privacy facts.

Provider-neutral `RuntimeEventEnvelope` records one JSONL event as its type, class, payload digest, byte count, and hashed operational provider-session references. Raw payloads and transcripts are not stored in these project-lineage envelopes. Bounded raw stdout/stderr may be retained in the separate Host-local P5 output spool for recovery; it is not Canon or recovery direction. `RuntimeInvocationLifecycleReceipt` binds those envelopes and the consumption receipt to exact project, Session, scope, optional Run/contract, caller-fence digest, child-fence digest, exit, timeout/cancellation, and cleanup facts without recording a PID or raw command. Receipt `0.6.0` adds only sorted allowlisted diagnostic codes for provider errors and internal event/supervisor boundaries; raw error text remains ephemeral. `RuntimeResultPacketDraft` `0.5.0` carries those codes as evidence-only Unknowns. Run results still require Fresh Lode review; Session results explicitly do not, unless a later risk transition escalates the work into a Run.

`RuntimeRunResultApplication` protocol `0.1.0` is the narrow provider-neutral bridge from a verified actual-provider Run draft into canonical Execution Lineage. It accepts only a completed exit-zero actual-provider Run whose structured result, exact input, project fence, and native descendant-tree ownership all passed. The bridge maps the bounded provider result into one canonical `ResultPacket`, transitions the exact Run to `awaiting_review`, builds the deterministic Fresh Lode context, and writes a content-derived application receipt beside the invocation record. It is idempotent and can recover only the same ResultPacket after an interrupted receipt write; a divergent or Session-scoped result fails closed. The receipt carries no transcript, provider session identity, PID, path, instruction authority, promotion authority, or Product Canon mutation.

Application validation and Run completion share the session-recovery mutation
lock. Before any missing-receipt recovery writes, the current Project, Session,
Run, plan, contract, and Capsule must match the authorization exactly. An old
result cannot finish a newer Run, even if it reuses the same contract. A complete
historical application receipt remains readable without reopening that Run.
The bridge neither approves the result nor creates a checkpoint; Fresh Lode
review and explicit integration remain separate.

## Bounded provider one-shot composition

`runtime-invocation-execute` accepts a persisted Claude Code, Codex, or OpenCode `ExecutionAuthorization` and dispatches only the provider-specific launch/event codec over the shared authorization, lease, native supervisor, invocation-record, and result-application core. Each adapter rejects capability or project-binding drift before lease consumption and invokes the absolute native executable directly with no shell. Claude Code uses non-interactive `--print`, stream-json events, JSON Schema output, `--no-session-persistence`, no loaded setting sources or slash-command skills, strict empty MCP configuration, and an exact tool allowlist derived from workspace mode. Read-only permits only `Read`, `Glob`, and `Grep`; workspace-write adds `Edit` and `Write` while continuing to deny Bash, web, notebooks, tasks, plugins, and external effects. It never uses `--dangerously-skip-permissions`. Codex uses `codex exec` with JSONL output, ephemeral provider storage, the authorization's exact read-only or workspace-write sandbox, Git-repository independence, project-directory binding, deterministic color control, a host-local JSON Schema, optional authorized model selection, and the exact authorized execution input over stdin. OpenCode uses `opencode run --format json --pure`, exact project-directory binding, optional authorized model selection, a permission projection derived from workspace mode, and the same bounded stdin/result contract. Provider authentication and endpoint selection remain provider-owned. Provider codecs request their own permission/privacy restrictions; this is not a universal proof that settings, plugins or skills are disabled. The selected Codex branch adds `--ignore-user-config` and `--ignore-rules`, but its trusted backend must still establish effective instruction/tool isolation before execution. Provider-specific configuration does not enter Product Canon or graph identity.

The common `RuntimeStructuredResult` carries bounded `outcome`, evidence statements, `planDelta`, `impactRadius`, verification statements, and explicit Unknowns. The Codex wire schema intentionally uses only the portable root-object, required-property, closed-object, scalar, enum, array, and item subset needed to shape the response; it omits a dialect declaration and type-specific length/item constraints. This keeps provider compatibility separate from product semantics. After decoding, the provider-neutral validator still enforces non-empty fields, 64-item list limits, per-field byte limits, the 128 KiB total result limit, and the Session rule that plan delta and impact radius remain empty. A separate per-JSONL-event limit defaults to 2 MiB, is capped by a smaller caller-selected total stdout limit, and remains independently bounded by the 8 MiB default total stdout budget. Raw JSONL and provider messages remain Host-local P5 output-spool data rather than project-lineage transcript artifacts; the provider-neutral invocation-record core stores only content-derived event envelopes, the lifecycle receipt, and a structured ResultPacket draft under the authorization-specific record. Recovery verifies the persisted authorization, runtime, project, Lode Session, scope, receipt, event set, and draft as one lineage before returning it. The draft, receipt, and optional verified Run application are available through `runtime-invocation-result` and the read-only `lode_runtime_invocation_result` MCP tool. `runtime-invocation-apply-run-result` is the single-provider-draft bridge into canonical Run lineage; combined results use [worker integration](worker-context-integration.md) and the same existing Run finish/review boundary. The single-draft bridge derives ResultPacket runtime evidence from the verified authorization and is reusable by a conforming runtime adapter. Absolute project or operational roots in the structured result fail the invocation boundary.

The deterministic lifecycle verifier proves invocation-surface drift rejection before lease consumption, model-selection digest binding, invalid selection rejection, legacy authorization compatibility, portable wire shape, retained semantic bounds, privacy-reduced provider diagnostics, and preservation of provider authority. Claude Code, Codex, and OpenCode protocol fixtures prove fixed arguments, authorized stdin, provider event decoding, immutable recording, CLI/MCP reads, and OS-enforced process-tree cleanup. The separate integrity-verified `lode-agent-supervisor` assigns its provider subtree to a Windows Job Object with kill-on-close or to an isolated POSIX process group; only the native helper manifest digest and bounded cleanup facts enter durable evidence. Actual Codex and OpenCode Runs each created and reread the exact isolated file, preserved the protected fixture, verified native descendant cleanup, applied one canonical ResultPacket, and completed Fresh Lode review. Claude Code has the same live verifier entry point but no live model-call claim is made until its explicit opt-in run completes. A separate recovery E2E completes Codex, starts a fresh process with only the project root and prior Lode authorization ID, reconstructs the canonical Project/Lode Session from artifacts, and completes an OpenCode fixture invocation without Git, GraphDB, or persisted provider-session identity. General provider resume, durable hidden-session restoration, stream, provider-session messaging, and TUI scraping remain unavailable. P2-first optional exact Lode attachment, exact-owned-tree one-shot interrupt/close, and authority-free role coordination use the separate host boundary below.

The tracked lifecycle verifier uses deterministic capability fixtures and fixed Node execution fixtures, not provider model execution. It proves Session and Run scopes for all three runtime identities, provider-specific fixture-mode derivation from the authorization runtime, Session-request drift rejection, model binding, local reversible workspace-write authorization, pre-start consumption, sequential and in-flight replay rejection, tamper detection, release inspection, bounded stdin, JSONL validation, exact-child exit, timeout/caller-cancellation termination, Run contract action enforcement, and scope-correct review requirements. The separate provider-replacement verifier adds a fresh-process, artifact-only Codex-to-OpenCode recovery proof. Optional P2-first exact Lode attachment is active; general provider resume/stream and broader runtime control remain disabled.

## Selected Codex Host connection and optional fork

The selected-workspace Codex connection is locally implemented behind a trusted
Host boundary. `buildCodexWorkerPolicyPlan` declares intent, not enforcement,
and freezes the canonical `provider/model` mapping to `wireModelProvider` and
`wireModel`; the transport cannot silently substitute another model.
`createCodexWorkerPolicyHost` and `bindCodexWorkerPolicyCapability` connect a
function-backed verifier to the exact authorization, input, model, executable,
canonical root and selected execution root. The verifier holds effective policy
through the existing lease, provider execution and cleanup; callback-time checks
run again before consumption. Pre-consumption verification is cancellable and
bounded by the existing authorization timeout/deadline, without a new user cap;
consumed work still waits for its existing cleanup path. A policy echo, digest,
boolean or serialized JSON object is not that capability.

Policy `0.2.0` explicitly scopes these checks to model-visible task data,
model-callable tools and their effects, and additional configured/inherited
instructions. Provider-owned baseline instructions are not a promise of zero
semantic influence. Trusted P5 OS/runtime/provider-authentication operations are
separate actors, not blanket exemptions: the Host must verify their exact
constraints and prevent them from exposing unselected task data or credentials
to the model/tools. Earlier `0.1.0` plans are not silently reinterpreted.

Detached execution uses the fixed Codex runner and an exact hash-bound Host
reconnect module. Provider cwd is the selected root; authorization, lease and
result storage remain bound to the canonical Project. A missing or unverifiable
backend makes this optional mode unavailable, with no silent execution in the
canonical root. Ordinary direct/Session work remains available. Synthetic
contract tests exercise this connection; they do not prove installed sandbox,
tool/instruction/network enforcement, selected reads, exact writes or credential
denial. Actual-model validation of this selected connection remains incomplete.
A 2026-09-23 KST development-host observation reported Windows readiness
`updateRequired`; this is a dated environment observation, not a universal user
gate. The unimplemented installed effective-policy backend and installed API
observation limits are separate from that environment condition. Sandbox setup
alone would not prove them. Earlier live one-shot results described above do not
certify this new path.

`runtime-codex-native-fork.mjs` adds an optional Host-only completed-cutoff fork
composition over the same selected policy, lease, output spool and result path.
It verifies a completed inclusive `lastTurnId` cutoff and the fully hydrated,
settled prefix (earlier failed/interrupted turns are preserved), child
identity/model/root/policy, child-goal suppression and exact turn completion.
The non-null prefix digest is frozen in the policy before authorization and
matched again before consumption; uncertain fork/start is never automatically replayed. Source
IDs, inherited history and RPC journals remain P5 and cannot author P2 direction.
The source conversation is not mutated. A concurrent parent-goal change is
reported as observation/unknown evidence, not an unrelated-parent failure gate.
The trusted Host must verify inherited
instruction/tool treatment; a prefix digest or installed RPC schema is not proof.
Actual mode additionally requires the opaque Host capability created by
`createCodexNativeForkOwnedTransport({ withVerifiedOwnership })`. Its guard supplies
a synchronous factory that the adapter invokes only while the guard/deadline is
live inside the consumed lease. The factory uses the supplied ownership binding
and returns the existing `spawnSupervisedProcess` handle. The adapter verifies
built-in supervisor provenance and exact process/executable/root/manifest binding;
a shared/source process, serialized proof or already-finalized receipt cannot
substitute. The connection is checked before consumption. Completion then
requires exact transport exit and the supervisor's verified final tree-cleanup
evidence. Missing ownership capability remains unavailable before consumption
(`CODEX_NATIVE_FORK_INSTALLED_ENFORCEMENT_UNPROVEN`); an available connection alone
does not prove effective policy or successful execution.

`createCodexAppServerTransport` supplies the concrete P5 stdio connection using
fixed `codex app-server --listen stdio://` arguments and the native interactive
supervisor. The guarded factory is its only actual launch route. It performs the
initialize/initialized handshake, correlates bounded requests/notifications,
denies server-initiated approvals and tool effects, and preserves uncertain
mutation delivery without replay. Close sends EOF first, verifies exact owned
exit/native cleanup, and reports forced or unverified cleanup rather than success.
The separate protocol-fixture constructor cannot issue an actual owned capability.
This transport implementation is **not verified production native fork support**:
the installed effective-policy backend and actual-model isolation/cleanup remain
unverified. Transport tests are not installed Codex enforcement evidence.

`runtime-codex-worker-host.mjs` now supplies the fixed product reconnect entry
`connectCodexWorkerHost` and `createCodexNativeForkJobHost`. Reconnect data is
embedded in the existing P5 job binding; it is not a serialized policy capability,
another authorization, or a new Core artifact. Reconnect rechecks the current
authorization, selected workspace, executable, protocol binding and supervisor.
The model-free backend uses the real owned stdio/supervisor path after lease
consumption, including uncertain-fork cleanup and the existing result route.
Its opaque ownership capability is branded `protocol-fixture` and cannot be used
by an `actual-provider` host. One P5 transcript belongs to the consumed job;
status reads and inert reconnects do not create transcripts.

This closes the product **composition/reconnect** gap, not the installed native
**effective inherited-policy** gap. The fixed entry still rejects actual native
execution before consumption with `CODEX_NATIVE_FORK_INSTALLED_ENFORCEMENT_UNPROVEN`.
No schema/profile echo or supplied JSON enables it. The default public fresh
proposal path is unchanged and does not require native fork or this diagnostic.

The native composition fixture is an **abstract Host-contract simulation**, not
Codex API compatibility proof. Exact 0.153.4 source rejects ephemeral forks with
`deferGoalContinuation`, ephemeral paginated forks returning turns, subsequent
ephemeral history reads, and ephemeral goal access. Disabled goals also make
goal get/clear fail rather than return a null goal. Source-faithful negative
fixtures cover these restrictions separately. `inspectCodexNativeForkCandidate`
reports known API conflicts without issuing a capability; even dedicated native
ownership cannot admit the incompatible current sequence. Removing defer alone
or silently persisting the child is not a fix. A future narrower proposal mode
needs a separately verified inherited-context/tool boundary: empty dynamic tools
on fork restore tools from history, while explicit base instructions override
stored base instructions but do not erase historical messages. These are
optional native-backend limits, not new gates on normal fresh proposals.

`inspectCodexInstalledPolicySnapshot` is an optional read-only developer diagnostic
over retained executable/schema/help files and an optional dated readiness
observation. It spawns nothing, generates no schema, performs no setup, and issues
no capability or authorization. Its result keeps `enforcementAvailable: false`
and distinguishes missing backend, typed-API observation gaps and environment
observations. Tool inventories, permission profiles and instruction/config echoes
are observations, not complete enforcement proof; a different build needs a new
snapshot audit. This is not an ordinary-user step, required form or admission gate.
Users do not supply Host proofs or new JSON approvals. See [worker integration](worker-context-integration.md).

## Controlled native-prefix proposal candidate

`CodexNativePrefixPolicyPlan` defines a separate opt-in
`native-prefix-patch-proposal` mode. It binds the unchanged fresh recipe and
selected seed bytes, not an existing Lode/provider session, caller proof or
arbitrary rollout path. The fixed constructor
`createCodexNativePrefixProposalTransport` creates its own legacy source on the
same owned connection. Goals and model-callable tools are disabled at process
start. One seed turn acknowledges the selected context; its direct terminal items
must match the source history. An ephemeral fork must return that exact prefix,
then exactly one explicit child turn proposes a patch. It never requests deferred
goal continuation, child history or child goal state.

This mode intentionally has **one durable provider seed and two model turns**,
not the fresh mode's single ephemeral turn. Closing the owned process does not
erase seed history. Input disclosure, seed persistence and preparation-call cost
must be within the operator's actual execution scope; fresh authorization cannot
be reinterpreted to permit these extra effects. This is not a privacy-equivalent
optimization or an automatic default. Public preparation defaults to fresh;
explicit `context_mode: "native-prefix"` connects this narrower controlled-seed
recipe and discloses its two-turn/durable-seed effects in `executionPlan`.
Embedding Hosts can compose this typed policy with the existing authorization,
workspace and fixed job APIs.

`executeCodexNativePrefixProposalInvocation` reuses the lease, spool, supervisor
and proposal-result path. Lost mutation responses cannot trigger replay, and
source/fork mismatch or tool effects fail before a result is accepted. Provider
IDs and raw history remain P5; a validated patch proposal is P3 evidence, never
P2 direction, applied changes or review approval. General native policy 0.2 stays
unavailable. Synthetic protocol/job tests and an actual-constructor capture
stopped before spawn cover composition only: **no actual-provider E2E claim** is
made for this mode. It adds no gate to ordinary direct Lode work.

Transport cleanup distinguishes request rejection, EOF delivery and observed
process exit. Its existing P5 close event includes bounded monotonic cleanup
timings; these are diagnostic observations, not a new artifact or admission
requirement. A rejected queued mutation is never written, but this does not
guarantee that its process exits gracefully within the unchanged cleanup budget.
Escalated cleanup remains unclean, even when the owned tree was removed. A result
publication error likewise cannot authorize another worker run: when exact
settled output, lease and owner-exit evidence exist, explicit reconciliation can
publish that same P3 result without creating P2 direction.

Fresh and native proposals use direct `item/completed` evidence to construct
results. A `turn/completed` projection marked `summary` corroborates only its
returned message; `notLoaded` contributes no items. Neither substitutes for full
history or fills in an unobserved result. The native source history read and fork
prefix comparison remain separate full-history checks. Terminal failure, missing
result evidence, mismatched identities and late effects cannot become success.

The native-only legacy comparison follows the pinned source projection, rather
than equating live UUIDs with regenerated `item-N` identities. It binds the exact
seed input, stored sequence, nonempty messages, coalesced reasoning summaries and
agent metadata. Its process-local `show_raw_agent_reasoning=false` override is
checked before seed creation; fresh mode is unchanged. Live v2 flattens agent text
chunks: comparison proves ordered text/metadata equivalence, not unavailable
original chunk boundaries. The subsequent fork must still preserve the exact
stored prefix, including its IDs. Unknown items, extra/missing/reordered content
or changed metadata fail this optional mode without blocking fresh work.

## Fresh patch-proposal backend candidate

`CodexFreshProposalPolicyPlan` `0.1.0` describes a separate, bounded
`fresh-selected-patch-proposal` mode. Its concrete recipe is pinned to the audited
stock Codex `0.153.4` source and exact executable digest, not merely the version
string. It is not a relaxation or automatic replacement of selected-exec policy
`0.2.0`, native fork, or existing write-bound authorization `0.6.0`.

Authorization `0.7.0` retains selected input and a read-only `proposalBasis` with
exact target preimages/absence and no owned write paths. Structured result `0.2.0`
adds a digest-bound `patchProposal`. The model proposes file contents as P3
evidence; it does not apply files or prove that tests ran. Core reconstructs the
candidate for Lode to assess. Combined Run [worker integration](worker-context-integration.md)
requires `project.write` in Lode's exact current Run contract only for non-empty
file application. The single-provider-draft application bridge cannot bypass
that step for a proposal. Session results remain ordinary Lode evidence, without
a compulsory Run. Graph and P2 recovery authority are unchanged.

`buildCodexFreshProposalPolicyPlan` freezes the model mapping, fixed instructions,
startup configuration and selected Codex-home instruction digests. Existing home
instructions are included only within the approved input scope, using their exact
bytes and the provider's first-nonempty precedence; they are not silently dropped
or automatically approved. Changed active instructions require a newly selected
basis. The recipe disables model-callable tools, delegation, hooks, plugins,
skills, MCP and web access, closes inherited registrations explicitly and rejects
unselected instructions or a custom provider endpoint. Provider-owned fixed
authentication/settings network operations remain separate P5 substrate, not
model-callable network access or permission to expose credentials/task data.
This process-scoped recipe does not edit account credentials or saved settings.

`executeCodexFreshProposalInvocation` uses the existing at-most-once lease,
deadline, native supervisor, output spool and invocation/result records. The
concrete transport privately checks the fixed `features list` surface under that
same consumed lease before launching App Server; a caller's callback or proof
cannot substitute. `createCodexFreshProposalTransport` then
checks effective config, the exact-root skill inventory, and read-only ChatGPT
account/exact-model readiness through `account/read` (without token refresh) and
`model/list`, before a fresh, ephemeral `thread/start` and one exact `turn/start`.
Account/model visibility is readiness evidence, not model E2E proof; raw account
data is not persisted into P3. The transport permits no fork,
source-session reuse or general RPC route, denies server action requests, and
keeps uncertain delivery non-replayable. Completion still needs exact owned-tree
cleanup. A configuration echo or caller JSON is not a capability, and the
synthetic transport cannot become an actual-provider connection.

This is a **source-pinned backend candidate**, not verified installed end-to-end
support. The 2026-09-23 development validation had used none of its four approved
model calls; that test allowance is not a product quota. Local contract tests and
fixed-scope reviews do not constitute whole-backend acceptance. Model-free checks
of the pinned installed executable confirmed fixed feature flags and config/skill
readbacks in an isolated synthetic Codex home only; that probe made no account,
thread, turn or model call. The built-in local Host connects preparation and
start through the explicit managed CLI/MCP route; it does not
install or update a runtime cache.
There is no new user JSON form or general Session gate, and failure of this
optional mode never silently launches in the canonical workspace.

`worker-prepare` / `lode_bounded_worker_prepare` accepts Lode-selected task,
model, member, context, source and proposal scope. It discovers the local fixed
Codex backend, uses owned model-free feature/config/skill/version/help probes,
and retains its exact P5 preparation outside the project. Identical preparation
reuses the same authorization. `worker-start --task-key` and the equivalent MCP
field reconnect that Host without an injected module; explicit embedding Hosts
remain supported. Arbitrary executable, runner, environment and enforcement
assertions are not wire inputs. `selected-only` instructions are the default;
`host-global` is explicit input selection, never implied permission to widen a
user's narrower input scope. Account/model readiness is checked only at actual
execution. Preparation does not grant write authority or create a Run. The
explicit managed CLI/stdio MCP paths have model-free native fixture coverage;
stock Codex preparation has no-account/no-thread/no-model observation coverage.

When selected source/preimages change before execution, the same member can be
prepared against the new exact basis without renaming its task or clearing a
cache. Lode may explicitly reselect read-source paths, including a proposal
target that appeared since preparation, while preserving the task, model,
proposal targets, limits and instruction scope. The new exact selection and
bytes are bound to their own preparation; this is not automatic scope expansion.
Prior preparations remain immutable; the existing Core member/lease
transaction alone decides whether a linked successor is safe. A live owner or
consumed outcome without verified never-started evidence cannot be bypassed.
Only the brief P5 publication/recovery step is serialized, not discovery or
execution. After interrupted hardlink publication, recovery removes only the
known staging link with verified identical bytes and inode; unknown links are
preserved and rejected. This is operational recovery, not a user approval gate
or a source of P2 direction.

## Ordinary delegation and optional attachment

Use current Host tasks/messages/progress for ordinary bounded delegation.
There is no Lode role-token, generation, inbox or append-only target chain.
Messages and worker success are evidence, not execution permission or approval.
See [ordinary Host delegation](role-coordination.md).

`VerifiedWorkspaceHostAdapter` optionally attaches an exact current endpoint
within the Project root and logical Lode Session. P2 restoration precedes any
Host inspection; unavailable attachment falls back to the same logical Lode.
The portable `host-export` composition stores one current external snapshot.
`workspace-host-export-mcp.mjs` takes only Host-provided project/caller/export
configuration and process-ownership proof. It supports attachment only, not
delivery request/claim/ack or a worker launcher.

Do not equate historical live role-mail tests with this simplified implementation.
Current source and local fixtures verify endpoint identity, replacement/loss,
fallback and unchanged P2 direction; new actual-provider E2E remains separate.

## Authority and identity boundary

Runtime capability never grants authorization. A future control operation must still be bounded by a valid Session or Run `ExecutionAuthorization`, exact project binding, caller identity, owned-process evidence, resource limits, and cleanup. Only Run scope requires accepted ExecutionContract and ResultPacket/ReviewDecision lineage.

Lode Session and Run IDs remain canonical project identities. Provider session IDs remain P5 operational references and never replace Lode identities or enter core semantic identity. Recovery must work from verified Lode artifacts even when the original provider process and provider session disappear. Probe, event and lifecycle projections omit raw provider session IDs, commands, endpoints, transcripts, credentials, output and live process identity. Retained worker authorizations deliberately preserve selected input and repository-relative source paths as P3 evidence; raw transport/history stays Host-local P5. Neither can become P2 direction.

All descriptors and probes require:

- `instructionAuthority: false`;
- `promotionAuthority: false`;
- `controlAuthority: false`;
- `mutatesCanon: false`;
- `tuiScraping: false` for runtime adapters.

The static contract descriptors additionally require `capabilityAuthority: none`; the operational discovery, version, and protocol-evidence compositions instead declare `authority: operational-observation-only` and `capabilityDoesNotGrantAuthorization: true`. The project binding combines canonical Lode references with operational evidence but has no instruction, promotion, control, or canon-mutation authority.

A static reference descriptor or probe that advertises control, mutation, TUI scraping or a different session-identity rule fails validation instead of being treated as available. Separately connected operational adapters retain their own exact authorization boundaries.

## Inspect the boundary

The CLI command is read-only:

```text
node scripts/lode.mjs runtime-adapters <project>
```

The read-only MCP tool is `lode_runtime_adapters`. Both use the runtimes selected in `.lode/project.json`, return the deterministic three-platform/three-runtime contract matrix, current-host privacy-bounded discovery, bounded version and protocol evidence, and the canonical Lode project/Session capability binding. They may start only the exact short-lived version and fixed-help children described above; they never create, resume, message, interrupt, or close a provider session.

Authorization preparation itself does not execute a provider. Separate CLI operations prepare, inspect, explicitly execute and apply evidence for an idle Session or an active contract-bound Run:

```text
node scripts/lode.mjs runtime-invocation-authorize <project> --input <authorization.json>
node scripts/lode.mjs runtime-invocation-read <project> --authorization <execution-authorization-id>
node scripts/lode.mjs runtime-invocation-lease-status <project> --authorization <execution-authorization-id>
node scripts/lode.mjs runtime-invocation-execute <project> --authorization <execution-authorization-id> --input <execution.json>
node scripts/lode.mjs runtime-invocation-result <project> --authorization <execution-authorization-id>
node scripts/lode.mjs runtime-invocation-apply-run-result <project> --authorization <execution-authorization-id>
```

The input contains `runtime`, `scope`, `workspaceMode`, and optional `limits`. Run scope is `{ "kind": "run" }`. Session scope is `{ "kind": "session", "request": "...", "contextCapsuleId": null }`; the request derives the bounded stdin payload and is retained only when optional retained-worker input is selected. The read-only MCP tools `lode_runtime_invocation_authorization` and `lode_runtime_invocation_lease_status` verify one persisted authorization and its available/claimed/consumed/released state. These read-only tools do not create, consume or release authorization. Optional `lode_bounded_worker_start` delegates execution through its trusted Host connection and the existing lease; no public tool can replay a consumed authorization.

The tracked verifier is:

```text
npm run verify:runtime-adapters
npm run verify:runtime-lifecycle
```

The explicit live verifier is intentionally separate from normal regression because it performs real provider model calls and one isolated workspace write. It requires a built, integrity-verified native supervisor and deliberate opt-in. It defaults to `run-only`, which skips the already conformed Session; `session-and-run` retains the fuller regression path. The mode selects coverage rather than imposing a product-level model-call quota. The legacy `LODE_AGENT_LIVE_CODEX_E2E` names remain accepted for compatibility:

```text
LODE_AGENT_LIVE_RUNTIME_E2E=1 LODE_AGENT_LIVE_RUNTIME=codex LODE_AGENT_LIVE_RUNTIME_E2E_MODE=run-only npm run verify:live-runtime
LODE_AGENT_LIVE_RUNTIME_E2E=1 LODE_AGENT_LIVE_RUNTIME=opencode LODE_AGENT_LIVE_RUNTIME_MODEL=provider/model LODE_AGENT_LIVE_RUNTIME_E2E_MODE=session-and-run npm run verify:live-runtime
LODE_AGENT_LIVE_RUNTIME_E2E=1 LODE_AGENT_LIVE_RUNTIME=claude LODE_AGENT_LIVE_RUNTIME_MODEL=anthropic/model-name LODE_AGENT_LIVE_RUNTIME_E2E_MODE=session-and-run npm run verify:live-runtime
```

Without the environment opt-in it fails before creating a provider invocation. An unsupported optional mode also fails closed. Passing deterministic fixtures or implementing the application bridge does not count as live provider conformance.

The adapter verifier proves deterministic contract identities, Claude Code/Codex/OpenCode coverage, the Windows/macOS/Linux matrix, current-host discovery, version and protocol-evidence schemas, canonical project/Session capability binding, disabled static-adapter control methods, authority-escalation rejection, tamper rejection, and privacy boundaries. The supervisor verifier proves Windows Job Object normal-exit, cancellation, token-fenced bounded interrupt, and token-fenced bounded close cleanup against a real provider fixture with a lingering grandchild; CI compiles and runs the POSIX process-group implementation on Linux and cross-builds every release target. The lifecycle verifier proves both authorization scopes across all three runtimes, Session-request and model binding, Run/contract/Capsule binding, durable single consumption and release, sequential/concurrent replay rejection, bounded events, provider-neutral record recovery, provider-specific protocol-fixture validation, native-supervised protocol extraction, timeout, caller cancellation, scope-correct write policy, and transcript-free result drafting without a live provider. The provider-replacement verifier proves fresh-process artifact recovery across a runtime change. A sandbox that denies child creation yields explicit operational failure rather than being mistaken for runtime absence or successful execution.

## Next activation gate

Read-only path discovery, bounded non-session version invocation, provider-specific protocol/capability observation, canonical Lode identity binding, optional exact-endpoint attachment and exact-owned one-shot interrupt/close are active. Historical live role-message conformance remains development evidence, not a current implementation claim. Before general static-adapter start, provider-session resume/stream or broader process-host control becomes active, the composition must verify:

1. preserve the completed live Codex Session conformance evidence through the externalized operational-state root, exact authorization/lease/caller/project fences, and verified native descendant supervisor;
2. validate the diagnosed large-event fix against evidence-led consequential live Codex Runs, including actual provider input, structured events, isolated file write, ResultPacket evidence, and provider-specific errors through the provider-neutral schemas;
3. preserve the completed live one-shot interrupt/close evidence while adding a distinct resume/stream protocol rather than reusing process termination as session control;
4. actual provider-session binding remaining operational-only;
5. no canon, ReviewDecision, instruction, or promotion authority;
6. failure behavior that preserves Session request identity or Run WholePlan/Capsule/ExecutionContract identity plus evidence lineage.

Point-in-time `RuntimeStateAdapter` exports remain a separate evidence-only facility. They do not satisfy this control activation gate.

## Optional Host capacity admission

Provider-neutral Hosts may place existing bounded-worker dispatches behind the
optional P5 admission contract in [worker-admission.md](worker-admission.md).
The admission capability travels to the runtime lease as a separate branded
internal argument; it is never accepted from execution JSON. Hosts that do not
configure admission retain the exact pre-existing invocation order and public
surfaces.

## Optional proposal execution observation

The trusted in-process Host may pass an opaque
`createCodexProposalExecutionControl` capability as the second argument to the
existing fresh/native-prefix proposal executor. It binds one authorization hash
and an absolute deadline that can only shorten the execution deadline. Its
synchronous `beforeTurn` hook runs before the physical turn write; the Host can
durably debit a separate experiment ledger there. `onTerminal`, `onEvent`, and
`onCleanup` observe evidence, not permission. The same executor retains policy,
configuration, skills, account/model, prefix, result/schema, receipt and P3 lease
checks; the hook does not select an executable or replace that executor.

These hooks are not CLI/MCP JSON fields, shared worker authorization, a default
quota, or P2 recovery state. Diagnostic failures are retained as operational
errors and stop affected execution without throwing into supervisor control/exit
parsing. Exact-owned cleanup runs before optional ledger settlement; storage
failure cannot fabricate a release or successful result. A completed turn and a
verified process exit remain separate observations. Calls without the optional
control retain their existing authorization and execution budgets.

The local fixed-peer experiment may use total/concurrency/time limits of its
own, but those limits and its test-only Lode consumer are not public plugin
policy or a substitute for the durable worker-job integration workflow. Actual
factory availability is not live-provider conformance; local verification must
remain unable to start an actual provider by default.

## Startup guidance and Claude file ownership

Generated Core instructions, supported startup projections and explicit bootstrap
responses share the same minimal task-continuation guidance. Current goals,
cancellations, selected Session recovery, Todo and fitting original reasons take
priority in the existing complete-JSON budget (Claude 10,000; Codex/OpenCode
32,768 UTF-16 characters). The startup `coreGuidance` field is optional; a
`coreGuidanceDelivery` omission marker is included when it fits. An absent field
is no delivery proof. Neither constructed output nor local Hook stdout proves
Host/model reception or compliance. Missing recovery/selection limits dependent
work only; it does not create an inventory scan or a new checkpoint requirement.

Claude `CLAUDE.md` and `.mcp.json` ownership are independent. An existing user
file is preserved, while an absent other file may be managed for the selected
Claude runtime. Legacy combined metadata is still read. Explicit resume may
provide a missing, previously unmanaged part through atomic no-clobber creation
and update the existing managed manifest. An intervening user file wins; a
missing already-managed original remains drift, not permission to regenerate.
Other runtimes and existing user MCP configuration are not adopted or merged.

Without a plugin Hook, explicit initialization/resume still returns `coreGuidance`
in its structured response and preserves the generated instruction projection.
Preserving a user instruction file does not mean the Host imported that generated
projection. Existing explicit preserve/link choices remain; automatic instruction
receipt, persistent delivery state and actual native loading are not inferred.

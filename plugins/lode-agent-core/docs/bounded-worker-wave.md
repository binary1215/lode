# Provider-neutral bounded worker launch waves

`BoundedWorkerWave` adds one concise launch-wave view without turning Lode Core
into a worker launcher, provider-session registry, or Herdr adapter. It groups
already-created and already-verified `BoundedWorkerDispatch` records beneath one
exact active Run lineage.

Use a wave when independent dispatches need durable recovery and effect tracking,
for either useful new work or retained work. Direct Lode and ordinary Host
delegation remain available. File edits, worker count or ordinary failure do not
force a wave; history/status/wait remain ordinary diagnostics.

## Authority and identity

| Artifact | Plane | Meaning |
|---|---|---|
| `BoundedWorkerWave` | P3 | create-only grouping evidence over existing dispatches |
| `BoundedWorkerWaveSeal` | P3 | create-only proof that every member authorization was actually consumed |
| `BoundedWorkerWaveAbandonment` | P3 | explicit non-success handoff for an unsealed partial launch |
| `WorkerWaveStatusProjection`, `WorkerWaveResultProjection` | P4 | non-persisted aggregate views |
| `BoundedWorkerWaveWaitOutcome` | P5 | bounded operational observation only |

Wave creation accepts only 2-64 existing authorization IDs. It creates no
`ExecutionAuthorization`, chooses no role, runtime, model, workspace mode, or
action, and widens no member scope. Every member retains its independent
at-most-once lease. Caller handles, provider session IDs, panes, sockets, TUI
commands, and Herdr identities are outside Core semantic state.

Read, status, result-read and wait verify the stored Project, Run relationships,
plan, contract, Capsule, dispatch and authorization hashes. They remain usable
after Run completion or Session replacement; historical evidence grants no new
execution or application permission. Create, seal and abandon additionally
require the exact current Session and active execution lineage. An unrelated
Session timestamp/checkpoint update is not execution drift. Tamper still fails
the affected read or mutation.

## Lifecycle

```text
existing BoundedWorkerDispatch[]
  -> BoundedWorkerWave(open)
  -> independent worker execution and authorization consumption
  -> explicit BoundedWorkerWaveSeal
  -> WorkerWaveStatusProjection(sealed | completed | failed)
  -> optional BoundedWorkerWaveWaitOutcome
  -> Lode gathers individual evidence while the Run is valid
  -> one combined Run ResultPacket -> Fresh Lode -> ReviewDecision -> P2 integration
```

The read-only status projection never creates a seal. Seal requires verified
lease consumption for every member; dispatch existence or caller assertion is
not start evidence. Aggregate result read and wave wait fail closed before seal.
`completed` means every member returned a successful terminal runtime result.
One fast terminal failure makes the sealed wave `failed`, never `completed`.

Status and wait include non-persisted Lode guidance: whether aggregate reads are
available, whether all start evidence is present, and which started members lack
lease release evidence. This is not proof of process cleanup. Lode can read
individual jobs before sealing; aborting wait or abandoning a wave does not
cancel members. Preserve successful results and inspect/cancel owned unfinished
members separately. CLI/MCP cards expose this distinction without a new user form.

An unsealed partial launch may receive one create-only abandonment record.
Reason codes are fixed and the optional UTF-8 summary is normalized and limited
to 256 bytes. The summary has no instruction, review, promotion, success, or
recovery authority. Seal and abandonment are mutually exclusive; identical
retries converge and divergent retries fail. Both compete for the same
create-only terminal slot, so concurrent seal/abandon attempts cannot produce
two terminal truths.

Wave completion does not apply a ResultPacket, build Fresh Lode review, create a
`ReviewDecision`, or integrate a checkpoint. HF-009 remains independent worker
dispatch and execution ownership. HF-010 remains the later explicit reviewed
result integration path for the Run's single whole result, not each fragment.
For context selection, partial launch and the distinction between single-worker
application and Lode's combined finish, see
[worker context and integration](worker-context-integration.md).

## CLI and typed MCP

```text
lode-agent managed worker-wave-create <project> --input <wave.json>
lode-agent worker-wave-read <project> --wave <bounded-worker-wave-id>
lode-agent managed worker-wave-seal <project> --wave <bounded-worker-wave-id>
lode-agent worker-wave-status <project> --wave <bounded-worker-wave-id>
lode-agent worker-wave-results <project> --wave <bounded-worker-wave-id>
lode-agent worker-wave-wait <project> --wave <bounded-worker-wave-id> [--wait-timeout-ms <0..600000>]
lode-agent managed worker-wave-abandon <project> --input <abandonment.json>
```

Typed MCP uses the same Core functions and identities. Discover a managed
mutation schema and use `lode_tools_call` with `execution_mode: "managed"`, or
the retained separate managed stdio server. The CLI `managed` route also supports
useful new durable work. Routing creates no authorization and preserves exact
lineage, lease and start-evidence checks. Ordinary MCP retains read/status/results/
wait and exact owned cancellation. Status does not automatically launch or seal
members. File edits, worker count and ordinary Host failure do not select this
path or justify replacing the user's installed server.

An embedding Host may optionally pass an opened Worker Admission capability to
wave status. That adds P5 queue/reservation detail only; it never changes the
wave state machine or its `started` evidence. Ordinary CLI/MCP and Core calls
without that capability remain unchanged. See
[worker-admission.md](worker-admission.md).

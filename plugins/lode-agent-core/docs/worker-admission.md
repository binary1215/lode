# Provider-neutral worker admission

Worker admission is an optional P5 Host capacity boundary for already-created
`BoundedWorkerDispatch` records. It does not create an authorization, choose a
model, widen a worker scope, launch a provider session, or decide whether a
result is accepted. A Host that does not configure admission keeps the existing
dispatch, runtime-lease, result, and wave behavior unchanged.

## Durable Host domain

The Host provisions a domain once with
`provisionWorkerAdmissionDomain(...)`, then opens that exact identity with
`openWorkerAdmissionHost(...)`. Operational metadata, an append-only event
journal, and a separate Host-expectation intent/commit chain live outside the
project. The caller must provide the expected domain-instance ID and metadata
hash when opening it. A missing intent, commit, metadata, genesis, event, or
event-commit marker makes that domain unavailable; absence is never interpreted
as an empty queue or free capacity. The same domain ID cannot be reprovisioned.
The expectation tree also keeps a non-authoritative journal head from genesis;
every append advances it under the domain lock. A shorter event-and-marker tail
therefore conflicts with the retained head instead of silently restoring free
capacity.

Provisioning, opening, and every opened-capability use verify each existing directory
prefix without following a symlink or junction and confirm its real path stays
inside the configured Host root. Every journal append refreshes the verified
tail and topology synchronously. A validator return also refreshes them before
any generation, reservation, or lease consumption transition. This prevents an
intermediate path from redirecting P5 state into the project during an awaited
Host check.
Every directory-lock acquisition writes a create-only random owner token and
captures the directory and token-file identities. After an awaited Host check
and before cleanup, the caller must still own those exact objects. A displaced,
missing, or replaced lock is left untouched for explicit Host recovery; stale
cleanup cannot remove a later cooperative caller's lock at the same safe path.
The implementation rechecks the directory identity after removing its own token.
The final identity-check-to-`rmdir` syscall gap is not an arbitrary-filesystem-
mutation guarantee; a Host must not relocate lock paths during cleanup without
placing the domain into explicit recovery.

Policy is immutable and bounded: global concurrency is 1-64, per-capacity-key
concurrency is 1-global, queue depth is 1-1024, and maximum wait is one second
to one day. The capacity key is derived only from the verified authorization:

```text
runtime/<exact-runtime>/model/<exact-provider-model-or-unspecified>
```

FIFO applies within one key. Across keys, the oldest currently eligible key
head is selected, so one saturated model does not reserve capacity belonging to
another key.

## Final consumption boundary

`enqueueWorkerAdmission(...)` records a queue request before it can reserve
capacity. Reservation alone is not execution evidence. The returned
pre-consume capability is a non-serializable, branded Host capability carried
as a separate internal argument through `executeRuntimeInvocation` and the
Claude, Codex, and OpenCode adapters. An identically shaped JSON value is not a
capability.

The runtime lease still owns the authoritative consumption variable. After the
normal runtime owner lock is acquired, the admission gate revalidates exact
Project, Session, Run, WholePlan, ExecutionContract, Capsule, authorization,
dispatch, request generation, and reservation fence under the admission-domain
lock. It receives a revocable one-shot callback from the lease. Only that
callback can write the existing immutable consumption receipt. A cancellation
or stale lineage before the callback leaves consumption at zero and removes the
runtime owner lock.

Because Host validation is asynchronous, the gate performs the exact lineage
and Host-storage check again after the validator returns and immediately before
consumption.
Queue cancellation, timeout, and validator-failure cleanup can terminate only
the calling generation; an older caller cannot mutate a resumed generation.
The original queue deadline is re-applied after queued or resume validation, so
an awaited Host response cannot extend the deadline or create a late reservation.

An authorization that is already consumed cannot create its first queue event.
If an unreserved queued request becomes consumed or otherwise unavailable, the
exact generation is cancelled before it can reserve capacity. A reserved
restart with ambiguous cleanup remains unknown-blocking instead; this preserves
uncertain prior work without letting an ineligible new request leak capacity.

If consumption succeeds but the admission start marker cannot be committed,
the provider operation is not started. The authorization remains consumed, the
normal lease error/release cleanup runs, and the affected admission domain is
reported as unavailable or unknown-blocking. It is never replayed or counted as
free capacity.

Capacity is released only after a verified exact runtime result proves either
definitive no-child execution or observed provider exit plus owned-tree cleanup,
or after a proved pre-consumption failure. A released runtime owner lock alone
is not descendant cleanup evidence. Identical finalization converges;
divergent or stale finalization fails. A restarted queued request remains held
until the Host validator explicitly returns both `current` and `resume`; it
preserves the original deadline and records a new generation. A reserved retry
also requires an available, unconsumed runtime lease plus explicit `current` and
`resume` Host validation. A claimed or consumed lease becomes
`unknown-blocking`; a bare resume assertion cannot release it. Consumed work is
never requeued.

## Status and authority

`readWorkerAdmissionProjection(...)` is a non-persisted operational projection.
It maps internal `resumed` events back to the public `queued` state, maps
reservation/start-marker events to `capacity-reserved`, and
separates them from `executionEvidence`: verified authorization consumption,
supervisor/provider start observation, and terminal evidence. Missing or
damaged execution evidence is shown as unknown or unavailable, never inferred
from reservation state.
`readBoundedWorkerWaveStatus(...)` can optionally attach one admission detail
per member when passed an opened Host capability. Without that capability, its
existing output and behavior are unchanged. Admission loss does not disable
ordinary wave status or P2 recovery; it only makes the optional admission
detail unavailable.

Admission events and projections have no instruction, review, promotion,
Product Canon, completion, or recovery authority. Wave `started` continues to
mean durable authorization consumption or terminal runtime result, never queue
or reservation state. Result flow remains `ResultPacket -> Fresh Lode ->
explicit ReviewDecision -> explicit P2 checkpoint integration`.

There is intentionally no public CLI/MCP surface in this slice. Provisioning,
Host expectation storage, cancellation wiring, and restart validation belong
to a provider-neutral Host adapter. Provider session IDs, process IDs, sockets,
panes, TUI state, and Herdr identities are not persisted in Core semantic
state.

## Verification

```text
node --test test/worker-admission.test.mjs
npm run verify:runtime-lifecycle
```

The targeted test covers exact provisioning/open, intermediate-link rejection,
paired-tail loss and semantic-transition tamper fail-closed, final lineage drift,
generation-fenced cancellation/expiry, throwing detached validation cleanup,
zero-consumption cancellation including the validator window, one-shot callback
revocation, safe available-lease resume and claimed-restart blocking, same-key
FIFO, independent domains and process contention, all three runtime-adapter
guard paths, abort after successful target resolution, optional wave detail,
event-marker failure, and unproven descendant cleanup retention.

# External runtime state evidence

Read [`architecture.md`](architecture.md) and
[`authority-plane-contract.md`](authority-plane-contract.md) before changing
this boundary.

## Scope and authority

`RuntimeStateAdapter` version `0.1.0` imports a point-in-time host observation into the Repository World Model. It is a read-only evidence adapter, not an `AgentRuntimeAdapter`, process controller, session restorer, or authority source.

The separate runtime-control plane has `PlatformAdapter`, `AgentRuntimeAdapter`, and `WorkspaceHostAdapter` references plus privacy-preserving current-host CLI discovery. It records candidate availability and content-derived path identities without exposing raw paths. Distinct bounded probes may execute the fixed non-session version and provider-specific help surfaces and retain only normalized versions, allowlisted capability signals, output digests/sizes, and lifecycle facts. `RuntimeProjectBinding` connects those observations to canonical Lode project and Session identities without passing project content. These artifacts create no provider session and grant no control. See [`runtime-adapters.md`](runtime-adapters.md).

Every adapter must declare:

- `authority: derived-evidence-only`;
- `rebuildable: true`;
- `uniqueAuthority: false`;
- `readOnly: true`.

Observed capabilities describe what a host reported. They never authorize Lode or an executor to start, resume, interrupt, message, fence, or close anything. Lode Session and Run identities remain canonical and distinct from provider session identifiers.

## Host export contract

The active adapter reads a regular non-symlink JSON file no larger than 1 MiB with at most 1,000 observations:

```json
{
  "schemaVersion": 1,
  "kind": "LodeRuntimeStateExport",
  "observedAt": "2026-08-18T12:00:00Z",
  "observations": [
    {
      "runtime": "codex",
      "kind": "session",
      "state": "active",
      "externalId": "provider-session-id",
      "workspaceRoot": "C:\\path\\to\\project",
      "pid": 1234,
      "parentPid": 1000,
      "providerVersion": "example-version",
      "commandDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "endpointDigest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "capabilities": ["inspect", "resume"]
    }
  ]
}
```

Start from [`../assets/runtime-state-export.example.json`](../assets/runtime-state-export.example.json) and replace only the allowlisted observation fields.

Allowed kinds are `workspace`, `session`, `run`, `worker`, `process`, and `service`. Allowed states are `unknown`, `discovered`, `ready`, `active`, `idle`, `blocked`, `completed`, `failed`, and `stopped`.

The schema intentionally rejects arbitrary fields. Raw commands, endpoints, environment variables, prompts, transcripts, tokens, credentials, and free-form metadata must not enter the World Model. `externalId` is converted to a SHA-256 digest. A non-project workspace is represented only by a digest; the canonical project root is represented as `project-root`.

## Commands

Place the host-produced file outside the repository or under the excluded derived-input directory `.lode/world-model/inputs/`, then build and query:

```text
node scripts/lode.mjs world-index <project> --runtime-state <host-exported-json-file>
node scripts/lode.mjs world-status <project>
node scripts/lode.mjs world-runtime <project> --runtime codex --state active --kind session --limit 20
```

The read-only MCP tool is `lode_runtime_state`.

The physical source path and adapter descriptor are recorded only in the mutable World Model pointer so the source can be re-read for freshness checks. They are excluded from the semantic snapshot hash. The normalized observations, timestamp, coverage, and protocol versions determine the content-derived `runtimeStateId` and World Model ID.

Changing the export makes the World Model stale. Runtime queries and Context Compiler runtime candidates then fail closed until `world-index` rebuilds the snapshot. A missing or invalid configured export prevents freshness verification and is not silently treated as current.

## Context Compiler behavior

When the World Model is current, task-relevant observations compete under the normal Capsule budget as `RuntimeStateEvidence`. Explicit runtime, kind, and state words narrow the candidate set. Every record carries:

- `instructionAuthority: false`;
- `controlAuthority: false`;
- `trustBoundary: evidence-not-instruction`;
- evidence and content-derived observation digests.

Stale observations and their metadata are excluded. A Capsule can request expansion through `get_runtime_state`, but that remains a read operation.

## Boundary and deferred controls

`RuntimeStateAdapter` remains observation-only. Claude Code, Codex, and OpenCode
one-shot Session and Run execution, caller fencing, at-most-once leases, and
native descendant ownership are active through the separate Runtime Adapter
contracts; all three have deterministic protocol fixtures, while only Codex and
OpenCode currently retain live model-call evidence. These capabilities do not
widen this import adapter into a control plane.

Provider-session hydration or hidden-session restoration, general resume/stream,
provider-session messaging, and subscription remain deferred optional Runtime
Adapter capabilities. P2-first optional exact Lode attachment and exact-owned
one-shot interrupt/close belong to the separate active host/runtime boundaries,
not this observation adapter.

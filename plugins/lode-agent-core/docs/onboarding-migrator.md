# Standalone legacy onboarding migrator

This document describes a source-repository maintenance tool. The migrator is
not part of the installed Lode Agent Core plugin, its MCP server, marketplace
payloads, native overlays, or normal resume path.

## Supported first slice

The pinned helper recognizes completed onboarding candidate protocols `0.1.0`,
`0.2.0`, and `0.3.0`. It accepts only a current-readable project and Session,
state protocol `0.2.0` in `ready`, a complete historical candidate/review and
Product Model revision chain, a present current Canon, and independently
readable referenced P2 state. State protocol `0.1.0`, pending or interrupted
approval, missing artifacts, and unreadable current Canon/P2 require a separate
recovery design and receive no migration writes.

Product Model revisions are classified by the current verifier, not their age.
A revision that still passes the current contract remains typed P1 Canon
evidence. Only revisions that require retired parsing stay opaque. Historical
candidates and their reviews always stay opaque to current Core.

## Explicit one-shot operation

Run from a reviewed, pinned source checkout:

```powershell
node legacy/onboarding-migrator/bin/head-onboarding-migrate.mjs inspect C:\project
node legacy/onboarding-migrator/bin/head-onboarding-migrate.mjs apply C:\project
```

`inspect` is read-only. `apply` reruns validation in the same process and passes
a non-serializable capability to the generic current boundary publisher. The
only new records are:

- `.head/onboarding/historical-boundaries/<id>/boundary.json`;
- `receipt.json` in that directory;
- final `commit.json`, published last.

All three are P3 evidence with instruction and promotion authority disabled.
The operation does not edit, move, rename, delete, reissue, or reapprove any
candidate, ReviewDecision, revision, Canon, onboarding pointer, Session, Run,
checkpoint, World, or Graph artifact.

An exact retry of a valid committed boundary is read-only even after legitimate
current Canon or Session/P2 evolution. A partial retry may fill only missing
mechanical records while its original application basis is exact. Basis drift
before the final marker, a different inventory, byte tampering, a missing source
artifact, or an unsupported legacy artifact outside the boundary fails closed.

## After migration

Remove the standalone helper from the operational environment. The installed
plugin verifies the committed boundary and original artifact bytes without any
legacy parser. Status, World, Context, and Session recovery remain current-Core
operations. They never recover a historical promotion or ask the user to review
an opaque candidate again.

If product meaning must change, a provider Lode proposes fresh `0.4.0`
candidates through `lode_onboarding_semantic_refresh` or the equivalent CLI
`onboarding-semantic-refresh`. Core verifies exact current evidence, and only a
later explicit user ReviewDecision may change Canon. A P3 continuity receipt
and P4 `HISTORICALLY_FOLLOWS` relation connect history to the fresh candidate
without creating typed ancestry or authority.

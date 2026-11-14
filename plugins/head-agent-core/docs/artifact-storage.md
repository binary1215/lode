# Work artifact storage guide

This is a default organizational guide, not a new storage API or gate. Follow existing project conventions first. Do not create files just to fill folders, initialize Lode for recordkeeping, or turn ordinary Session work into a Run. No mandatory Step registry, manifest, extra approval or automatic GC is introduced.

## Choose the owner first

- Official Lode plans, contracts, ResultPacket, ReviewDecision, Capsule and checkpoints belong in existing CLI/MCP/API typed stores. Use returned IDs and paths; do not hand-author these records or relocate them into work/Step folders. Immutable records and mutable current pointers have different rules.
- Product source, tests and user deliverables stay in their existing project locations.
- Retained work evidence may use `<project>/.agent-work/<work-id>/` when there is no existing convention. Temporary scratch is not retained verification evidence. Do not move, delete or renumber existing artifacts to adopt this guide.

## Names and optional organization

Use any human-readable title. Prefer `YYYYMMDDTHHMMSSZ-<short-kebab-case-slug>` for folders: UTC creation time and a short ASCII lowercase/digit/hyphen slug safe on Windows. Reuse the same work-id for the same continuing purpose across conversations; independent work gets a new ID. On collision, confirm ownership before reusing it or append a short unique suffix. Never overwrite another task.

A work-id is not a Lode sessionId, runId or provider conversation ID. Optionally record only actual relevant Session/Run/contract/result references. Do not invent missing references or use a provider conversation ID as a recovery key.

A single result can live directly in the work folder. Only when stage evidence needs separation, use `steps/01-inspect/`, `steps/02-implement/`, `steps/03-verify/`: at least two digits and a short action slug. Do not renumber completed steps. Stable paths convey neither execution state nor authority; every tool call need not become a Step.

Prefer descriptive filenames: `review.md`, `summary.json`, `scope-check.stdout.log`, `scope-check.stderr.log`. Use `attempt-01/` and `attempt-02/` only for retries needed in comparison or failure analysis. Preserve failed and already referenced evidence rather than overwriting it with success. Working drafts and a work-folder `README.md` may be updated; they are not official immutable records. Preserve existing project filename conventions.

## Examples

Single-result work needs no Step or index:

```text
.agent-work/20260919T154819Z-artifact-storage-guidelines/
  review.md
```

The same work, if later expanded to retain multi-stage verification:

```text
.agent-work/20260919T154819Z-artifact-storage-guidelines/
  review.md
  README.md
  steps/
    01-inspect/
      summary.json
    03-verify/
      attempt-01/
        scope-check.stdout.log
        scope-check.stderr.log
      attempt-02/
        scope-check.stdout.log
        scope-check.stderr.log
```

A missing step number is harmless: do not manufacture files or renumber old paths. Product edits still go to their normal locations.

## Index, handoff and retention

For long-lived or multi-file handoffs, a short index can list purpose, relative links to key files, verified source version, results/unverified scope and known Lode references. Omit unavailable fields; no machine manifest is required. Prefer portable relative links, external paths only when needed, and report the actual key artifact location at handoff.

Clean only unnecessary scratch confirmed to belong to this task. Do not automatically delete shared/referenced evidence, other tasks' files or official Lode records. No new retention period or global GC policy is implied. Process cleanup is separate from evidence retention. Keep credentials out of filenames, logs and indexes.

## Scan and distribution boundary

Retention here is local by default, not automatic recovery after a Git clone,
another PC, or worktree deletion. For another checkout/PC handoff or long-term
retention, use existing approved project delivery/retention locations and check
that the recipient can access them. A reference in an official record does not
itself copy or preserve the target file. This adds no synchronization service
or routine approval step.

JS and Go repository scanners exclude directories named `.agent-work` at root or nested depth, case-insensitively. Unrelated hidden source remains eligible. Stored source scopes are not rewritten and no files are migrated. Explicit include scopes do not override technical exclusions; product files belong in product locations.

Scan producer `0.5.1` distinguishes this eligibility change from `0.5.0`; the declaration schema stays readable. Existing freshness inspection compares eligible files; World indexer identity also detects the version change. Old immutable snapshots remain evidence. Refresh/reconcile with existing operations when current World evidence is needed; do not auto-promote Canon or re-onboard for a derived scan update. Rebuild the native worker for parity; an old worker must not impersonate the new producer.

This repository ignores that directory name in Git and excludes it from distribution enumeration, including nested paths. Other projects retain their own Git and packaging policies; this guide does not edit them automatically. Ignoring does not untrack committed evidence or erase history.

See [Execution Lineage](execution-lineage.md) for actual typed lifecycle contracts.

## Path bases and existing Projects

Project-internal references use validated Project-root-relative `/` paths. Generated
Markdown `relativePath` starts at the published root; each href starts at its
containing document. A `../` document link does not permit `..` in a durable selector.

Runtime `project_root`, stored `projectRoot`, installation `pluginRoot` and root-derived
identities remain bound to the verified absolute root and actual Session owner. New
Projects use `.lode/`; existing `.head/` records and exact selectors stay unchanged.
These are existing path contracts, not workspace relocation or automatic repair.


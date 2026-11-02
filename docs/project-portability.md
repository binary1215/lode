# Move a Project and selected history

Ask Lode: “Continue this Project in this folder,” or “Export the work from this
conversation so I can continue on another computer.” Lode carries the agreed
direction, current shared constraints, selected Session records and their exact
supporting originals. It does not require Product onboarding, a World rebuild,
a Run or a new save/approval ceremony.

## A copied folder

Ordinary `resume` verifies the Project's existing location chain. An older copy
without a provable original location can instead use the explicit
`copied_project: "verified-copy"` initialize/resume choice, after Lode explains
that the first origin remains unverified. This is a choice for that exact copy,
not permission to trust every record carrying its old path or Project ID.

Unchanged admitted originals remain readable. Newly added or changed old-root
records cannot borrow that admission. Old execution authorizations, leases,
provider bindings and current runtime permissions do not transfer. Subsequent
normal checkpoint/Run writes use the current verified owner.

Known text files changed *only* by LF/CRLF conversion may be repaired when the
original recorded digest is reproduced exactly. Lode preserves the observed
before bytes and checks each immediate before/after state. It never removes a
BOM, rewrites historical paths, edits arbitrary JSON or changes hashes to accept
a divergent record. Partial publication is recoverable, not globally atomic.

## A selected portable bundle

The agent supplies arguments; the user does not write JSON or collect IDs.
Advanced CLI equivalents, from the plugin directory:

```sh
node scripts/lode.mjs project-export "<project>" --destination "<new-bundle-folder>" --session "<selected-logical-session>"
node scripts/lode.mjs project-bundle-inspect "<bundle-folder>"
node scripts/lode.mjs project-import "<target-project>" --bundle "<bundle-folder>"
```

Typed equivalents are `lode_project_bundle_export`, `lode_project_bundle_read`
and `lode_project_bundle_import`. The bundle contains exact common direction
and selected P2/Canon/reference originals and work evidence. Other Session
bodies, caches, root integration settings, credentials, live leases and native
bindings are excluded. The repository worktree and attachments are not copied
by this operation. Keep the original project worktree and attachments, or their separately verified
copies, as well as the bundle when those omissions matter.

Some old copy-admission proofs contain other Sessions' path/ID/hash metadata.
The default `provenance_scope: "project-proof-metadata"` includes only original
common proof metadata required for recovery. Other Session bodies remain
excluded. Lode explains this scope before invoking export; CLI and stdio MCP
also emit a scope notice before creating the destination or copying any file.
The raw JSON result and original manifest/proof bytes keep their own roles.
A scope notice is P4 information, not acknowledgement, approval or authority.
No extra approval token, plan, save or binding step is required.

An explicit `provenance_scope: "selected-only"` (CLI `--provenance selected-only`)
omits cross-session proof inventories. Necessary omitted legacy proof is
reported as partial, never rewritten to fabricate admission. Incomplete
provenance limits dependent admission, not inspection of preserved selected
originals or ordinary independent work. Programmatic callers may supply the
optional synchronous `onExportScope` Host callback; its absence does not block
raw API use. The returned `exportScope` is non-persisted and never becomes a
bundle original or a receipt that someone read the notice.

Import never selects a new default Session. Into an existing same Project it
adds only the absent exact selected Session and preserves newer target shared
direction, knowledge and cancellations. Current installation projections are
generated from the destination installation; user integrations and model or
permission settings are preserved. Resume uses the returned exact Session route.
Equal files are reused, missing owned publication steps may converge, and third
states remain conflicts. Import does not replay completed or uncertain effects.

## Optional Codex native history

This is a separate experimental Host adapter, **not a stable Codex import API**.
Common Project/Session recovery remains independent. The first measured profile
is Windows x64, Codex engine `0.166.0-alpha.5.1`, with exact database schema,
migrations and raw-history format checks. A matching version string alone is
insufficient. Common bundle preservation/inspection remains available for unknown native
profiles; native writes are unsupported.

The public operation is `lode_project_native_history`, or:

```sh
node scripts/lode.mjs project-native-history "<bundle>" --action capture --native-home "<source-CODEX_HOME>" --executable "<exact-codex.exe>" --threads "<explicit-native-id,...>"
node scripts/lode.mjs project-native-history "<bundle>" --action read
node scripts/lode.mjs project-native-history "<bundle>" --action restore --native-home "<target-CODEX_HOME>" --executable "<exact-codex.exe>"
node scripts/lode.mjs project-native-history "<bundle>" --action register --native-home "<target-CODEX_HOME>" --executable "<exact-codex.exe>" --runtime-root "<current-workspace>"
```

These are distinct requested effects, not a prerequisite command sequence for
ordinary coding. For data inspection use the existing read-only
`lode_project_bundle_read` with `include_native_history: true`; no SDK starts.
Its common result and an optional native failure are reported separately.

Capture and raw/SQLite restoration require an observed stopped-writer window.
Lode does not stop/restart apps or an existing MCP connection. An ambiguous live
writer makes this native operation unavailable; it does not block Core recovery.
The current interactive app cannot close itself and continue its own operation.
Prepare the transfer there and use the CLI in the requested offline window.

Capture preserves selected raw bytes, exact original names and typed history
rows, including 64-bit integers, BLOB, NULL and unknown JSON fields. SQLite reads
committed WAL; source WAL/SHM and full source databases are not transferred.
Selected historical state excludes account-selector columns, never becomes a
target state row and never selects target policy. Historical absolute paths stay
historical. Fork/history-base, compressed/rotated and archived cases retain their
explicit closure/format limits; preservation does not imply native qualification.

The create-only `native-history.json` companion links one exact common bundle to
the selected native payload. It is P3 transfer evidence, **not proof that a Lode
Session owns those native threads**. Use explicit selection or an independently
verified Host route; never titles or recency. It creates no runtime binding,
checkpoint, ReviewDecision, Canon or execution permission. A missing/partial or
damaged companion is a native failure; the common manifest is unchanged.

Restore publishes only absent exact raw files and missing selected history rows,
after a verified local target-history backup. It never replaces the state DB,
uses `INSERT OR REPLACE`, restores a whole backup over later edits, or changes
target settings. Raw-file publication and the SQLite transaction are separate
boundaries. App startup or a source/target change interrupts dependent work.

A frame beyond the measured decoder limit is still streamed and preserved as
raw bytes. Its final byte length must match the selected cutoff, but the
remaining frame boundaries and dependencies remain unverified. Neither capture
nor rereading promotes that partial data to native publication support. Identity,
permission, malformed-input and cutoff failures retain their primary errors.

## Registration and its actual limits

Registration starts an owned, supervised SDK metadata lifecycle. **SDK startup
can discover files and change native metadata before explicit resume.** It is
therefore journaled before startup, not treated as a read-only connection check.
Before startup, a consistent target state database backup is kept inside the
destination native-home operation directory. Real schema/integrity and protected
existing user-choice fields are checked. This private local database copy can
contain existing account-related bytes; account values are not queried into
transfer records or exported. A failed backup prevents SDK startup. Exact usable
backups are reused, and a new observed database generation is preserved separately.
No whole-database backup is automatically restored over later edits.
Backup preparation and its exact verification finish before the SDK attempt is
recorded. A preparation failure leaves no SDK attempt, so the same request can
retry preparation safely. Once an SDK attempt exists, its uncertainty is never
erased by retrying preparation or changing inputs.
The registration group records the initial selected metadata hashes. A verified
member result binds its actual API view and post-cleanup selected-metadata
snapshot. Resumption reconstructs the completed prefix from those originals;
SDK discovery alone never makes an unfinished member an existing user choice.
Changed user metadata remains a conflict, and a snapshot without a completed
result remains uncertain. These local P5 records confer no Session ownership,
P2 recovery direction or execution permission.

New metadata uses current destination config and runtime roots; existing target
choices are verified without a resume that would overwrite them. Source prompts,
model, account and permissions are never sent as destination overrides. The
transport has no model turn, prompt injection, command/tool execution or account
API method, and denies server action requests. Owned processes close through
EOF, bounded waiting and exact process-tree cleanup; existing MCPs remain alone.
EOF flush is observed before granting the supervisor its graceful shutdown
budget. An unresponsive EOF or final close has a bounded cleanup path and
explicit uncertainty; forced shutdown, spontaneous failure and unverified
cleanup are not promoted to successful registration.

| Measured policy/view | Result in the pinned SDK |
| --- | --- |
| `read-only`, standalone paginated synthetic history | Metadata registration and original API-view equality verified |
| `danger-full-access`, same isolated metadata-only scope | Explicit current settings and original API-view equality verified; no model or command executed |
| `workspace-write`, default and additional-root/network options | Actual sandbox view did not reproduce the selected policy; explicit resume is now refused as unqualified |
| Named permission profiles | Legacy sandbox view cannot establish their full equivalence; no flattening/fallback |
| Actual model continuation | Not tested; `continuationReady: false`, current instruction binding not verified |

Lode never recommends weakening permissions to pass registration. A failed
policy check preserves the incomplete/uncertain outcome. SDK startup may already
have changed metadata, so this is not a “no target writes” claim.

An exact successful retry reuses prior actual SDK verification plus current
raw-prefix/typed originals; its freshness label differs from a fresh SDK view.
An attempt with no durable verified result remains uncertain, even if discovery
created a state row. It does not automatically restart the SDK or resend resume.
Changing policy/root inputs does not create a new attempt around that uncertainty.
Do not delete a journal or change IDs to force replay. Read/diagnose the exact
remaining state and obtain the user's decision for any new consequential action.

Raw/history preservation, SDK metadata registration, current native attachment,
Lode P2 recovery and a model actually using context are different results. Report
which were verified and what remains unknown; do not turn a successful view into
authority or a guarantee of semantic continuity.

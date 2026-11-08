# Move a Project and selected history

Ask Lode: “Continue this Project in this folder,” or “Export the work from this
conversation so I can continue on another computer.” Lode carries the agreed
direction, current shared constraints, selected Session records and their exact
supporting originals. It does not require Product onboarding, a World rebuild,
a Run or a new save/approval ceremony.

## A copied folder

Ordinary `resume` verifies the Project's existing location chain: a copy whose
records prove their original location (its Project ID was derived from the
recorded root, or its location history verifies) is adopted as a relocation on
explicit resume, whether or not the original folder still exists. A status read
alone adopts nothing. An older copy without that proof can instead use the explicit
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

## Retained source originals and exact diffs

Default export includes eligible full-file source originals already retained by Lode
and exactly cited by the selected Session’s work evidence. The agent explains this
scope before export. It copies the existing raw SourceObservation bytes unchanged,
with separate file SHA-256, bundle key and observation identities. This does not
include the current worktree, unrelated Session bodies or a collection from Git.
Known source, outgoing-call and declaration formats receive an additional closed
export check, including duplicate and escaped-equivalent JSON keys at every
object depth and in embedded structural-response frames. Unknown profiles/extra fields stay excluded without changing the
ordinary source reader. A hash identifies bytes; it does not attest producer truth
or the absence of sensitive content in the selected file. Review before sharing.

To carry references without source bodies, ask for references only, or use
`--sources refs-only` / typed `source_mode: "refs-only"`. Missing, unsupported or
unavailable originals remain explicit per-reference coverage in the scope notice,
manifest, Handoff and import result. They do not block ordinary Session recovery.
Source sizes that could not be verified remain unknown. Export does not inspect
local Git to classify missing originals; the existing bounded local Git query
fallback remains available and is reported separately. Git-only source collection
is outside this transfer.

Both a fresh Project and a Session imported into the same existing Project keep
eligible originals in immutable common source storage. Verified admission/Session
receipt mappings let the exact reader find them without scanning unrelated source
bundles. After resume, CLI/MCP/Explorer can compare two retained cited revisions
even when the original PC and worktree are absent. Re-export preserves this link.
Copied and verified originals are reported separately from a successfully queried
diff; missing pairs remain partial rather than an empty successful comparison.

A fixed included-original manifest must import exactly: destination conflicts are
errors/incomplete imports, never successful omission. Existing target work stays
available. Exact interrupted retries reuse equal originals and receipts; divergent
bytes are preserved as conflicts. A references-only alternative is a separate
explicit export and bundle identity.

The source evidence format is unchanged. New portable manifests use schema 2 and
`portable-selected-retained-sources-v1`; admission and historical owner proofs
validate its required capability throughout recovery and re-export. New readers
still accept schema 1 bundles, with source portability marked not recorded/not
certified. Older readers reject schema 2 before import writes. This compatibility
check affects that import, not ordinary work or existing records. No source proof
or coverage view creates P2 direction, approval or execution permission.

## Optional Codex native history

This is a separate experimental Host adapter, **not a stable Codex import API**.
Common Project/Session recovery remains independent. The first measured profile
is Windows x64, Codex engine `0.166.0-alpha.5.1`, with exact database schema,
migrations and raw-history format checks. A matching version string alone is
insufficient. Common bundle preservation/inspection remains available for unknown native
profiles; native writes are unsupported.

The public operation is `lode_project_native_history`, or:

```sh
node scripts/lode.mjs project-native-history "<bundle>" --action capture --provider codex --native-home "<source-CODEX_HOME>" --executable "<exact-codex.exe>" --threads "<explicit-native-id,...>"
node scripts/lode.mjs project-native-history "<bundle>" --action read
node scripts/lode.mjs project-native-history "<bundle>" --action restore --native-home "<target-CODEX_HOME>" --executable "<exact-codex.exe>"
node scripts/lode.mjs project-native-history "<bundle>" --action register --native-home "<target-CODEX_HOME>" --executable "<exact-codex.exe>" --runtime-root "<current-workspace>"
```

Capture requires an explicit `provider` (`codex`, `claude` or `opencode`), supplied
by the agent from the requested source platform or a verified Host route.
Read, restore and register may derive it from the verified companion link;
an explicit provider must match that link. IDs and executable names do not
identify the platform. This local candidate also connects Claude 2.1.223 and
OpenCode 1.19.5 adapters. Isolated official version/history/schema checks are documented below;
ordinary app and model continuation qualification remains incomplete.
Missing executable capability is reported before native-home access or startup.
An unsupported profile limits that native operation; common recovery and Handoff remain usable.
Selected raw files and companions are preserved without redaction. Not collecting
configuration automatically does not prove that the selected content contains no secrets.
Claude structural inspection requires the selected session ID in a message record,
not just a filename or metadata row. Fork ancestors remain byte-preserved; coverage
separately reports other-session messages outside the selected ancestry and missing
message session IDs. This observation does not verify official native ownership.

These are distinct requested effects, not a prerequisite command sequence for
ordinary coding. For data inspection use the existing read-only
`lode_project_bundle_read` with `include_native_history: true`; no SDK starts.
Its common result and an optional native failure are reported separately.

The Codex adapter's capture and raw/SQLite restoration require an observed stopped-writer window.
Lode does not stop/restart apps or an existing MCP connection. An ambiguous live
writer makes this native operation unavailable; it does not block Core recovery.
The current interactive app cannot close itself and continue its own operation.
Prepare the transfer there and use the CLI in the requested offline window.

### Claude and OpenCode local adapters

Ask to move the selected conversation to the same client and restore its history.
The agent resolves the source, target and selection; you do not need to write IDs
or JSON. Advanced CLI/MCP calls reuse the existing surface above. For these two
providers, also supply `--runtime-root <source-or-target-project>` / `runtime_root`
for capture, restore and register. Read still needs only the bundle.
OpenCode source capture is an exception to the data-home arguments: the current
Host must already provide the selected exact-ID export capability. It does not
take a source native-home/executable override or guess the ordinary profile layout.

Claude capture preserves a stable snapshot of the exact selected JSONL; it does
not claim a live source conversation has ended. Optional `--companions` /
`companion_paths` select files below `<native-id>/` in the source project-history
directory. External references are not followed. Restore checks all conflicts and
duplicate selected IDs in other project directories, rechecks the stopped-writer
window, then creates missing files and reads back their bytes. Identical files are
confirmed without rewriting; different files are preserved. The initial observer
supports Windows native `claude.exe`; other writer profiles remain unqualified.
Names longer than the documented 200-character conversion need a qualified
official resolver; this candidate does not invent the hash. Those limits affect
native writes only. Register can use an already installed Agent SDK 0.3.234 to list
and read returned records; missing SDK leaves raw restoration independently usable.
SDK listing is separate from the CLI picker, and neither starts a model turn.

OpenCode source capture consumes exact export bytes from the current Host
capability. Without that capability, capture stays unavailable. Destination
restore now publishes the whole selected batch in one SQLite transaction:
sessions, messages and parts are committed together, with no upsert or
ignore-on-conflict behavior. Historical message/part JSON remains intact.
Original exports and derived inputs have separate digests; source active
permission, model, agent, revert, workspace and compacting values are omitted
from derived Session Info. No prompt loop or historical pending work is run.

The qualified offline adapter currently recognizes the official Windows x64
baseline OpenCode 1.19.5 binary by its bytes and SHA-256. It requires an existing,
explicitly selected isolated layout
`<native-home>/profile/data/opencode/opencode.db`, the exact qualified schema
and migration set, and an existing Project mapping for the current target root.
It never initializes or migrates that database, invents a Project ID, switches
the ordinary profile, or starts the client. Unsupported combinations affect
only this native operation; there is no user JSON or boolean qualification
bypass. Source capture still requires the current Host's exact-ID export.

Before writing, a source-bound validator checks Session Info, User/Assistant
messages, all twelve known Part variants and their nested tool/file structures.
Unknown variants or Session fields that cannot survive the SQL mapping are
rejected with the originals preserved. This is not an execution of the official
Effect decoder. Target location and the official missing-usage/empty-share
normalizations are reported separately. Global IDs, reachable existing parent
ownership/cycles, schema, Project and physical DB identity are checked again
inside the transaction. Message SQL ordering keys must match their body; an
inconsistent result is not silently sorted into a successful comparison.

The default full OpenCode CLI bootstrap remains unavailable
(`NATIVE_OPENCODE_BOOTSTRAP_UNQUALIFIED`). The offline adapter performs direct
qualified DB reads, not `import`, `export`, `session list` or model commands.
Root-only listing, exact selected-ID readback and live app visibility remain
separate. A reader may coexist; a competing writer is reported promptly without
requiring all apps to close. WAL/SHM activity is not a claim of byte-for-byte
file immutability.

Isolated qualification has exercised official Claude Code 2.1.223 version output,
SDK 0.3.234 list/message reads on synthetic JSONL, and the official OpenCode
1.19.5 non-instance `db` command on a fresh synthetic database. No installation
script, global profile, user history or model turn is involved. Those results
do not establish picker visibility, ordinary-profile support or model
continuation. The optional SDK's history reader does not start its bundled
Claude backend.

Both adapters keep create-only operational attempt/result evidence. The evidence
is not atomic with file publication or the SQLite commit: interrupted or partial effects
remain uncertain, with the primary failure and affected scope. A later authorized
request may verify exact current files/IDs without replaying the effect. Conflicts
do not overwrite originals. Verified raw bytes/history, observed lists and
continuation readiness are reported separately; target model/permission readiness
and actual Claude/OpenCode support are not inferred from fixture success.

Codex capture preserves selected raw bytes, exact original names and typed history
rows, including 64-bit integers, BLOB, NULL and unknown JSON fields. SQLite reads
committed WAL; source WAL/SHM and full source databases are not transferred.
Selected historical state excludes account-selector columns, never becomes a
target state row and never selects target policy. Historical absolute paths stay
historical. Fork/history-base, compressed/rotated and archived cases retain their
explicit closure/format limits; preservation does not imply native qualification.

For all providers, the create-only `native-history.json` companion links one exact common bundle to
the selected native payload. It is P3 transfer evidence, **not proof that a Lode
Session owns those native threads**. Use explicit selection or an independently
verified Host route; never titles or recency. It creates no runtime binding,
checkpoint, ReviewDecision, Canon or execution permission. A missing/partial or
damaged companion is a native failure; the common manifest is unchanged.

Codex restore publishes only absent exact raw files and missing selected history rows,
after a verified local target-history backup. It never replaces the state DB,
uses `INSERT OR REPLACE`, restores a whole backup over later edits, or changes
target settings. Raw-file publication and the SQLite transaction are separate
boundaries. App startup or a source/target change interrupts dependent work.

For Codex rollout capture, a frame beyond the measured decoder limit is still streamed and preserved as
raw bytes. Its final byte length must match the selected cutoff, but the
remaining frame boundaries and dependencies remain unverified. Neither capture
nor rereading promotes that partial data to native publication support. Identity,
permission, malformed-input and cutoff failures retain their primary errors.

## Registration and its actual limits

This section describes the pinned Codex SDK metadata registration lifecycle and
its local SQLite backups only. Claude's optional SDK reader and OpenCode's
Host/isolated-profile workflow have the separate effects and limitations above;
the Codex backup, policy-view and registration guarantees do not apply to them.

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

| Measured Codex policy/view | Result in the pinned Codex SDK |
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


## Continue from HANDOFF.md alone

New exports include a readable `HANDOFF.md` whose generated digest and exact
source basis are bound in the initial bundle manifest. It explains the selected
purpose, source conditions and cancellations, recorded choices and reasons,
reported results, unknown effects and pending work. It does not infer that a
saved observation proves completion. Long work fields identify their partial
range and link to the exact raw object inside the bundle.

Say “Read this HANDOFF.md and continue the unfinished work under my current
request.” The file can be read without a Project, database, provider, checkpoint
or new setup. The existing inspection command also accepts its explicit path:

```sh
node scripts/lode.mjs project-bundle-inspect "<HANDOFF.md>"
```

The existing `lode_project_bundle_read` accepts `handoff_file` instead of
`bundle_root` for this standalone read. The agent supplies the argument.
Optional byte paging reports partial output and the next offset; remaining
evidence can be read when needed.

Handoff is quoted P4 context, not a new P2 direction or renewed approval.
Current target constraints, settings and cancellations take precedence.
Reading never follows links, executes commands, changes selection or retries
completed/uncertain effects. Display escaping is not raw-byte preservation:
the linked objects retain the original bytes.

A missing, changed or unsafe Handoff is reported separately from verified
common originals and their import. A changed digest establishes only that the
description differs, not who edited it. Reads never repair it and repeated
export preserves an existing changed file. Manifest/source-basis corruption
still fails common verification. Older bundles have no Handoff and are not
silently rewritten. Native conversation listing, history reading and actual
model continuation remain separate outcomes.

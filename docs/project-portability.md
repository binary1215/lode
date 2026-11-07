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

## Continue a captured Codex conversation in Claude

Ask: “Preserve the selected Codex original and continue a separate copy in Claude.”
The agent resolves the exact source and current target. You do not prepare JSON,
copy IDs or run a four-step checklist. Conversion, native publication, read-only
verification and opening remain distinct effects within the requested outcome.
This is a local implementation candidate, not a general cross-provider support claim.

The existing native-history surface adds `derive`, `publish-derived`,
`verify-derived` and `open-derived`. Same-platform operations retain their guards.
An advanced conversion is:

```sh
node scripts/lode.mjs project-native-history "<verified-Codex-bundle>" --action derive --provider claude --threads "<exact-captured-thread>" --runtime-root "<current-target-project>"
```

Conversion preserves common Project/Session direction, checkpoints, the original
native companion and captured bytes. A separate P3 directory holds the transcript,
exact source mappings, diagnostics and reproducible manifest. Target UUIDs, times,
model marker, zero usage and stop metadata are explicitly synthesized; they are
not observations of a Claude execution. A derivative grants neither native binding,
P2 recovery direction nor execution permission.

Supported user/assistant bodies and single/parallel tool calls preserve role,
IDs, arguments, result/error and order. Canonical and wire tool facts must agree
before coalescing; source tool names are namespaced, never mapped to Bash.
Tool-output instructions remain tool data. Compaction summaries are quoted
historical assistant context. Qualified inline PNG images preserve their bytes;
references without bytes are explicitly quoted as unavailable in this capture,
without following paths or claiming today's filesystem state. Private reasoning
and source system/developer instructions stay in the original only. Unqualified
branch cutoffs, interleaved tools, compressed/unknown forms and missing results
remain diagnosed and unpublished, without a semantic-importance filter.

PNG qualification checks signature, chunk CRCs, header/data ordering, bounded
inflate and scanline framing. This is structural integrity, not proof that a
provider/model can process the image. Damaged bytes remain in the captured
original and block derivative publication; they are not repaired or dropped into
an apparently complete conversation. The earlier codec profiles keep JPEG/GIF/WebP
outside their validation scope; those bytes are retained as unqualified, not missing.
The separate hybrid-v3 profile below qualifies a narrow baseline JPEG format.
Existing qualified inputs retain profile v2. Pinned completion
observations, original line-byte hashing and wire-only outcome preservation use
profile v3. A completion observation ordinal is not a wire call-start ordinal:
the decoder associates only unique exact same-turn calls, arguments and outputs.
Absent wire outcome flags remain absent, with an explicit unknown observation;
text such as `ok` never becomes success evidence. Unsafe numeric rounding is
unqualified rather than silently changing a source argument. Earlier local candidates remain
unchanged and report `DERIVED_CONVERTER_PROFILE_UNQUALIFIED`; a separately requested
new derivative gets a new identity, never an overwritten old conversation.

Native operations bind `derivation_id` and `expected_derivation_digest` to the
exact target root/profile and executable. CLI uses `--derivation` and
`--expected-derivation`; the agent carries these values from verified results.
The derivative checks Claude Code 2.1.317 separately from the old 2.1.223 restore
contract. Optional official SDK0.3.234 reading compares every UUID, role, body,
tool block and order, including appended native messages. Page size is not a
total-history cap. An isolated 174-message rich read passed; actual Desktop/model
qualification remains pending. An absent SDK does not block derive/publication.

After native continuation, `rawCoverageComplete` still describes every raw
user/assistant record. `readerProjectionCoverageComplete` separately allows only
the observed Desktop2.1.317/SDK0.3.234 appended local-command-caveat envelope as a
declared reader omission; `derivedPrefixCoverageComplete` checks the initial
derivative. All omitted UUIDs stay visible and raw coverage stays false. Neither
an arbitrary metadata flag nor similar text excuses missing user/tool messages.
UUID-aligned order/body comparison avoids falsely reporting every subsequent
message as changed after one omission. Reader projection is evidence, not authority.

Publication atomically exposes only one complete absent new-ID JSONL. It does not
write shared indexes/settings/DBs or stop existing Desktop writers. Exact bytes
are observed without rewriting; conflicts, partial appends and unknown attempts
are preserved. A deleted target after an uncertain attempt is not automatically
recreated. No model call, historical tool execution, credential migration, profile
switch, installation or restart occurs.

Opening never implicitly publishes or submits a prompt. The default runner cleans
its entire child tree and is therefore unqualified for external GUI handoff. It
returns `DERIVED_DESKTOP_HANDOFF_LIFETIME_UNQUALIFIED` and an exact-sample official
Desktop local `/resume` alternative. A separately qualified trusted Host capability
can issue only fixed official resume argv, without shell text or a prompt. A callback
or CLI return is not display proof, and setting a profile does not prove an already
running Desktop consumes it. Pending source/native work limits open only. Unknown
open outcomes are never automatically replayed. Independent conversion/inspection
remain usable; do not weaken cleanup or write private Desktop metadata to force
opening. Display, model context use and answer persistence need separate observations.

In the observed Desktop local picker, UUID search found no match while searching
the display title opened the exact sample. Resolve a title/first-prompt hint from
verified source or official reader metadata and confirm the Project and latest
conditions. An exact UUID is identity evidence, not proof of picker searchability.

## Exact Codex project membership during capture

For Codex `capture`, the Host may provide the exact `source_project_id`
(CLI `--source-project`). Without `thread_ids`/`--threads`, capture selects all
rows whose native `threads.project_id` equals that ID, including archived
conversations, child workers and different workspaces. With an explicit thread
selection, every selected row must belong to that project; the result labels
that selection as a subset when appropriate. Names, working-directory paths and
Git remotes never establish membership. HEAD supplies the verified selection;
users need not type IDs or JSON. Other providers and actions reject this argument
before accessing a native profile.

`CodexProjectCatalog` is P3 evidence from the pinned `projects` and `threads`
schema. The selected project header contains only its ID and display name, for the migration index.
The full roster contains only IDs, project membership, cwd, archive/source state
and the attached parent ID. It excludes unselected titles, first messages,
previews, policies, remote URLs, accounts and arbitrary project metadata. Both
queries share one SQLite read snapshot. Full state rows belong only to actually
selected conversations; the payload verifies their roster projection exactly. A catalog can correctly describe an empty project; a history capture
with no conversations reports `NATIVE_CODEX_PROJECT_HAS_NO_THREADS` without
creating a history payload. The catalog claims only native-state snapshot
coverage: Host UI listings, log-only and ephemeral conversations remain
not observed. Existing offline-writer checks remain; capture never stops an app.

This adds project membership evidence to the existing selected-Lode-Session
bundle. It does not copy source-code/worktree files or attachments, enumerate
all logical Lode Sessions, establish native-to-logical Session ownership, or
complete whole-project migration. A converted transcript does not author P2.

`capture-project` on the same native-history surface writes a standalone Codex
Project-history capture at `bundle_root`, using the exact `source_project_id`,
`native_home` and `executable`. It requires no Lode initialization or common
bundle. The existing stopped-writer/profile checks still apply; there is no app
shutdown or automatic provider startup. `derive` can consume a verified standalone
Codex native payload as well as the existing common bundle. Its source binding
contains native identities only, and never invents a canonical Lode Project or
logical Session. This source connection is a building block, not the completed
multi-conversation/file-copy migration UX.

Full-query coverage is a capture-time observation. Later payload inspection
verifies the embedded catalog structure and selected-row membership; it does not
independently repeat the source DB query or certify a rewritten external catalog
as omission-free. Retain the original payload ID/digest and disclose this
verification scope alongside the historical coverage.

## Move a Project as separate conversations

Ask to move the selected Codex Project to Claude, keeping its conversations
separate, and choose whether to reuse the code folder or copy code/docs to new
folders. HEAD carries the exact native Project, observed conversation roster and
current workspace choices. Users do not author IDs, mappings or plan JSON.
Code, native conversations and optional Lode records remain independent scopes.

The existing `project-native-history` CLI / `lode_project_native_history` typed
surface connects the following operations:

1. `capture-project` preserves the verified native Project capture. Existing
   offline/profile checks apply. A running source is reported unavailable; the
   operation never stops the app or MCP to make capture possible.
2. Optional `prepare-workspaces` / `copy-workspaces` use current Host-selected
   repository-owned code/docs paths. HEAD carries the returned plan/digest into
   copy without adding a human approval ritual. The digest is integrity evidence,
   not permission. Reuse copies nothing; copy preserves target edits and reports
   conflicts. Client-private folders, `.git`, `.lode`/`.head`, credentials and
   `.env` files are excluded at every depth without reading their contents.
   `.env.example`, `.env.sample` and `.env.template` remain eligible. An existing
   exact plan supports safe observation of already-copied files. This does not
   install dependencies, certify a runnable program, crawl attachments or claim
   the selected paths were the whole worktree.
3. `derive-project` writes an immutable P3 conversation collection in the
   current caller's `collection_root`. Each conversation has an independent
   one-thread source capsule and Claude derivative. Exact unchanged row inputs
   and target pins reuse their previous derivative/native IDs when the global
   roster changes. No conversations are concatenated. Explicitly chosen shared
   conversation workspaces are allowed without merging code trees or P2 owners.
   Actual code/docs copies still reject flattening distinct worktrees into one
   destination. Missing workspace mappings leave those
   rows pending; unsupported representation remains row-local with originals
   preserved. Permission, identity and integrity failures keep their primary
   failure and do not become a successful unsupported-format fallback.
4. `read-project` is read-only. `publish-project` and `verify-project` require
   the exact collection digest and independently supplied current workspace
   mappings/profile. Each row keeps its original publication journal: continued
   targets are preserved; unknown effects are not retried or rolled back. The
   result distinguishes publication, official reader coverage, Desktop display
   and model use. A collection is not shared execution authorization.
   Batch `nativePublication` and `officialReader` summarize observed rows rather
   than reusing the archive reader's no-write flag. A failure retains its primary
   code plus observed/uncertain rows and unvisited IDs in
   `partialNativeOperation` (CLI JSON or MCP error data). No further source or
   profile observation, retry or rollback is attempted after authority denial.
5. Optional `attach-project-lode` archives already-exported, independently
   verified Lode Session bundles plus explicit association evidence. Their
   canonical Project/Session identities stay separate from native IDs. It does
   not initialize/import a Project, merge owners, integrate checkpoints or claim
   that all logical Sessions were included. Omission is a valid native-only move.
   The attachment is separate evidence; it never rewrites the base collection.
   It returns the existing `lode_project_bundle_import` and exact Session
   `lode_conversation_enter` steps. Execute import only under current migration
   scope, then verify recovered P2 and the current target common constraints.
   Existing import protects newer target cancellations and independent owners;
   an attachment/target suggestion alone grants no effect or Session selection.

CLI equivalents add `--collection-root`, `--collection`, `--expected-collection`,
`--workspace-map`, `--workspace-transfers` and `--lode-bundles`. The latter three
carry Host-authored structured arguments; ordinary users use conversation and
typed MCP. P3 collections and companion bundles are archives, P4 reads are views,
and native publication/file operations are P5. None creates P2 direction.

### Connect separately captured physical history

`capture-physical` consumes explicitly selected, already-captured JSONL prefixes.
HEAD carries the physical rollout ID, stable native thread ID, exclusive byte
bounds and original digests from verified capture evidence. Users do not author
these fields. Only the selected leaf and explicitly supplied `history_base`
ancestor chain are read. Parent futures and siblings are excluded; copied
inherited prefixes occur once. Stable thread, physical rollout and root Session
identities remain distinct. The physical converter uses raw `ItemCompleted`
records and exact same-turn tool call/result associations; it does not invent
canonical DB rows. Unknown/revised/rollback forms retain their originals and
block only that representation's publication.

An optional exact captured selected-state file/digest binds its `rollout_path`
to the actual captured file identity. ID equality alone is an association
proposal. A stale/missing path remains a proposal; permission or digest errors
keep their primary failure. This is recorded capture coherence, not proof of the
producer's authenticity, a current native inventory or one cross-source snapshot.

The physical converter's v2 profile includes an official `custom-title` record
in the newly created complete JSONL. A captured selected-state title is retained
as a bounded display excerpt when present; stable native IDs and a recorded fork
parent distinguish conversations with the same first prompt. Without a captured
title, the label uses native identities instead of an inferred product summary.
The manifest records which parts are quoted or synthesized. This is list metadata,
not a new user message, model instruction or P2. Existing published or continued
conversations are never renamed. Official SDK title/list readback is separate
from actual Desktop display, search and model-use qualification.
An existing physical-v1 derivative is reproduced under its recorded format and
reused with its original native ID and attempt journal; it is not automatically
upgraded into a second conversation just to add a title. Current turn validation
still applies. Conflicting existing profile intents remain a conflict rather
than silently choosing an effect or minting another ID.

`assemble-project` connects a captured Project catalog to those selected physical
archives and current workspace mappings. It keeps missing/unbound rows pending.
It creates or reuses each derivative in its **original captured source store**,
not in a clone with an independent publication journal. The collection contains
catalog and exact source-manifest metadata plus derivative/store references;
**physical bodies are not included**. `read-project` follows no stored source
path and reports only recorded metadata coherence. This reference collection
alone cannot restore a Project on another PC without its original source stores.

For `publish-project` / `verify-project`, HEAD supplies the current exact original
store scopes in `retained_derivation_sources`. Source paths in an archive are
not permission to follow them. Missing scopes or absent stores leave only those
rows pending. Replaced/cloned stores and changed artifacts fail verification;
the original store identity remains pinned through the operation. A standalone
publication after assembly and a concurrent collection request use the same
original attempt journal. Unknown effects are not replayed, and continued
targets are not overwritten. This is local known-store coordination, not global
at-most-once across independently recaptured data, lost journals or machines.

CLI equivalents are `--physical-source-root`, `--physical-rollout`,
`--physical-files`, `--selected-state-evidence`, `--expected-selected-state`,
`--catalog-file`, `--expected-catalog`, `--physical-sources` and
`--retained-derivation-sources`. They carry HEAD/Host-authored current scopes;
ordinary users still describe the move in conversation. Workspace preparation
can use the exact catalog file/digest without a full legacy native payload.

Current limits remain explicit: whole-project capture still uses the existing
verified payload/offline adapter, not a live-source snapshot backend. Opening a
WAL database with `readOnly` alone can create a shared-memory sidecar; it does
not establish a no-source-write live backend. No alternate startup, migration,
scan/repair or launcher path is used to bypass that limit. Captured physical
semantic conversion is source-shaped synthetic qualification, not proof of every
actual Codex fork/rollback/compaction format. Existing exported Lode bundles cover their selected Sessions,
not an automatic complete Session inventory. Synthetic tests and official SDK
readback do not certify new Desktop GUI/model behavior. The unqualified automatic
GUI handoff remains unavailable; a security-policy denial is never bypassed.

### Portable evidence archive

The `portable-project-evidence.mjs` module can export and inspect a P3
archive containing selected physical original bytes, extracted Project catalog
values and explicitly selected existing Lode Session bundle originals. Objects
are content-addressed; selected Session/Project identities remain independent.
Read verifies archive-local objects and physical prefix lineage without accessing
recorded source paths, initializing a Project or importing recovery direction.
The archive deliberately has no executable native-source manifest at its root.
`materializePortableProjectSessionBundle` can recreate one explicitly selected
common Session bundle in a separate P3 staging directory and revalidate it with
the existing typed bundle inspector. It returns the existing import step without
executing it, changing selection or creating a native source/effect store. Only
a separately scoped import and exact Session entry can recover that original P2;
the ordinary import protections for newer target constraints still apply.

Recognized derivative bodies and source-store P5 attempts/receipts are preserved
as exact historical observations with path scope and digest. Collection coverage
is bounded and non-atomic; absent, skipped or unavailable history never proves
that no attempt occurred. Archived target paths are not device identity or
permission. A destination must distinguish a new intended target from a known
uncertain retry rather than treating a package copy as a blank effect journal.
Zero-byte and malformed historical operation files are preserved as unparsed
originals with their exact hashes; byte preservation does not make them valid
JSON or confirmed outcomes. Objects and archive shape are verified before the
create-only archive manifest. A failure during/after that publication retains
copied-object observations and distinguishes an unconfirmed publication from a
confirmed manifest whose final read failed. No rollback or extra filesystem
observation follows a permission failure; later inspection needs current scope.

Use `export-project-evidence`, `read-project-evidence` and `stage-project-session`
on the existing native-history CLI/typed MCP surface. HEAD carries current
sources, archive digest and selected bundle into those steps; users describe
which Project/conversations and optional Session records to preserve. They do
not write descriptor JSON. Portable actions omit provider, native home and
executable arguments and do not invoke available native Host capabilities.
CLI uses `--archive`, `--expected-archive`, `--session-bundle` and
`--output-directory` for exact read/staging scope. Failures retain their original
code plus `partialPortableEvidence` in CLI JSON/MCP error data when partial
archive/staging state was observed. No new Project/Canon/Run/approval ritual is
required for evidence work.

These three actions remain evidence-only. The separate live-source and
target-local publication workflow below connects that evidence to native
delivery without treating the archive itself as an execution capability.

### Codex Project to separate Claude conversations

Describe the outcome: “Move this Codex Project and its conversations to Claude,
preserving the independent conversations and their history.” HEAD carries the
verified Project/physical-source IDs, archive digest and current target mapping.
Users do not author descriptor JSON or initialize a Product/Run/Canon to migrate.
Optional code/docs copying and existing common Session import remain separate
scopes; conversation grouping does not merge code trees, owners or P2 direction.

1. `capture-live-project` reads the selected Codex Project into a portable P3
   archive. It requires `provider: codex`, the explicit current `native_home`,
   `source_project_id`, and the user's agreed `source_sync_files` setting.
   `thread_ids` is an optional subset. Current selected parent paths are automatic.
   For a missing physical dependency, the reader uses only this Project's current
   location metadata and filenames in directly referenced directories, without
   recursion. A unique candidate's header must belong to the current Project
   before any body prefix is read; only the exact inherited cutoff is retained.
   Ambiguity or a location outside that scope remains per-conversation partial,
   including `unresolvedLineageConversations`. `ancestor_files` remains an optional
   exact dependency inventory carried by the currently authorized Host, never
   user-authored JSON or a path followed from transcript text. No whole-history
   scan or silent source-scope expansion is performed.
   On the supported Windows format, independent read-only SQLite snapshots and
   protected existing DB/WAL namespaces retain selected raw prefixes. SQLite
   synchronization sidecars are allowed only under the current agreed scope.
   Missing WAL is unsupported; no WAL is created, ignored, repaired or copied.
   Normal writers may append/checkpoint/truncate. No global instant or writer
   freeze is claimed. Reader connections and the owned hidden guard close before
   the archive can report success.

   Live selection checks the exact schema/migrations, selected typed rows and
   raw addresses; `wholeDatabaseIntegrity` remains `not-observed`. It does not
   run whole-database `quick_check` or `foreign_key_check` as a prerequisite.
   Offline database-integrity inspection retains both checks. Schema, selected
   read, identity, permission and raw-prefix failures remain primary failures.

   A recorded user fork may start a new logical root while inheriting a parent
   prefix. A root change requires the child Session ID to equal its thread ID,
   its explicit fork parent to match the captured parent header, and its fork
   ordinal to match the exact physical base cutoff. Same-thread continuation
   root changes remain invalid. Each segment retains its own root; the selected
   root does not merge logical Session owners or grant execution authority.

   App sidebar Project IDs and native database Project IDs can differ. For an
   exact current-request selection, HEAD may supply `source_selection_file`,
   `expected_source_selection_digest` and the separately authorized
   `source_project_root`, alongside the explicit native home. This is a
   `CodexExplicitProjectSelection` P3 selector, never Host authentication,
   permission, verified app membership or P2 direction. The distinct
   `CodexExplicitConversationCatalog` keeps the app reference and actual native
   `project_id` values, including `null`, without adding same-cwd conversations.
   This route is scoped to one caller-owned source workspace: every selected cwd
   must resolve to that same physical root. Normal/extended Windows spellings
   retain their raw strings while containment and opened identities are checked.
   A null file identity means observed absence, not an unchecked identity; a file
   that subsequently appears stays partial until a new explicit observation,
   including when referenced as another selected conversation's ancestor.
   The caller's current authority remains separate from selector bytes. HEAD
   carries the file and digest; users do not author JSON or bind IDs manually.

   Historical creation versions `0.158.0-alpha.2.1`, `0.159.2`, `0.160.0`,
   `0.163.0-alpha.10.2`, `0.165.0-alpha.1.2` and `0.166.0-alpha.5.1` are qualified
   for the bounded paginated physical parser. Current database and destination
   runtime pins stay exact. Ordinal/base/root/cutoff/hash checks and strict event
   conversion still apply; unknown creation profiles remain preserved partial
   evidence, never publication-ready. `stateHeaderAgreement` records metadata
   disagreement without rewriting either original. Physical range verification
   is not semantic conversion or a claim of model context equivalence.
2. Move the archive. `read-project-evidence` verifies local objects without the
   original PC, database, source paths or native executable. Typed state/history,
   ancestor cutoffs, raw-only complete records, incomplete trailing bytes and
   row-local missing/unsupported originals remain distinguishable. One absent
   conversation does not discard the others. Permission, cancellation, identity
   and hash errors keep their original failure and stop dependent effects.
3. `read-portable-project` is a read-only view. `derive-portable-project` prepares
   separate Claude representations with the shared reproducible codec, reusing
   existing P3 intents and IDs. Both use an exact archive/digest and explicit
   current target workspace mapping or one explicitly shared `runtime_root`.
   Neither starts a native client or writes a native profile. No executable
   source clone or new common Session is materialized.
4. `admit-portable-targets` records the current intended destination once in the
   target-PC Host's own P5 storage. HEAD can perform this setup within an already
   authorized exact target request; it is not another Product review or per-row
   user ceremony. The default Host owns the storage location and host identity,
   not the archive or ordinary caller JSON. Windows uses
   `%LOCALAPPDATA%/Lode/native-imports`; other hosts use their local state directory.
   Status and publication never create a missing Host/target record. Lost,
   replaced, copied or partial records cannot silently become a fresh target.
5. `publish-portable-project` uses the qualified current Claude Host and a
   target-local independent claim/lease for each native conversation. Only the
   active exact lease issues a one-use file-write capability. Publication creates
   an absent complete JSONL without overwriting continued or divergent files,
   changing shared native metadata, stopping an app, opening a GUI or sending a
   model prompt. Repeated/copied requests observe the current target and retained
   result; they do not replay uncertain or already-completed publication.
6. `verify-portable-project` uses the qualified installed SDK to compare the
   current emitted prefix, roles, bodies, UUIDs, order and tools. Mechanical
   agreement is separate from semantic sufficiency, Desktop display and model
   continuation. The latter are not established by a transcript or CLI exit0.

Incomplete trailing source bytes remain in P3 and appear under
`remainingSourceUncertainties`; they are not an automatic prefix-publication
gate. `pendingThreadIds` describes work remaining for the requested action.

Large physical histories use private finite-prefix captures, streamed hashing
and file-backed frame references. They do not inherit the 512MiB whole-JSON
snapshot limit. IO buffers are 1MiB and a decoded JSONL frame remains bounded
at 64MiB; a larger frame is not silently truncated or skipped. Temporary
captures/output spools are released after archive consumption or failure.
Small fragment getters reuse at most a 1MiB private read window per file owner.
Each access checks current authority and root/file identity, and returns a copy.
Full chunk reads and final hashes always reread actual bytes. A failed owner
keeps its original error; a cached window cannot revive it or grant permission.
The record audit walks exact selected JSONL byte ranges in sequence, checking
every frame address/hash and current scope, then freshly hashing each original.
It never merges equal ordinals across physical rollouts or reads a parent future.
The optional JavaScript prepare API returns the final inspected artifact for
immediate use in the same process. Existing derive calls and CLI/MCP still return
only summaries. Consumers recheck all source/artifact bytes and current scope
before effects. A saved summary or another process must inspect again; this
object is neither a durable verification token nor recovery/permission authority.
Live export batches physical packet preparation between full observation
verification before and after the batch. Per-source selection, lineage, digest
and current checks and final archive verification remain; no earlier packet is
returned when a later source or final reconciliation fails. Optional Host
`onProcess` storage observations expose exact temporary ownership for cleanup
after process loss. They are P5 telemetry, never recovery direction or a new
logging prerequisite for ordinary work.

The separate `codex-claude-physical-hybrid-v3` converter supports recorded
settings envelopes without a thread ID only for exact creation versions
`0.148.0-alpha.15` and `0.149.0-alpha.4.3`. It never fills the missing ID or treats
the settings as current instructions. Explicit malformed/foreign IDs, modern
omissions and unknown settings fields keep their existing rejection/diagnostic.
Prior hybrid-v1/v2 artifacts keep their original representation and identity.

For canonical local-image references, the new profile proves exact user text,
recorded wrapper path/number/order, user-origin content kinds, same owner/turn,
adjacent original addresses and a unique exact wire association. A digest index
only finds candidates; every hit is compared against the complete source fields.
Canonical reference fields stay explicitly quoted and the captured inline bytes
stay in the same original user message. No historical path is opened, downloaded
or assumed equal to a current file. Unknown or ambiguous evidence is retained
and diagnosed, never silently replaced with an unavailable-image label.
PNG integrity checks remain unchanged. JPEG support is limited to one baseline
8-bit interleaved scan, one or three components and qualified quantization/Huffman
tables. It reads every entropy-coded coefficient and verifies MCU boundaries,
byte stuffing, fill bits and exact end. Progressive/restart/other unsupported
forms remain unqualified. It does not allocate a raster, re-encode bytes or claim
provider image processing; official SDK and actual screen checks remain separate.
Direct callers of `readCodexLiveProjectSource` release the observation with
`releaseCodexLiveProjectObservation` in `finally`; the combined live export
does this itself. Retain the finished archive for subsequent work.

Hybrid-v6 retains a recorded tool argument string that is not valid JSON as
quoted historical data. It never repairs the input, emits it as a native tool
call or infers the historical outcome. In this v6 read, the strict reader records a blocking
source-addressed diagnostic for that input only; v6's historical view preserves
the call and result originals. Outer JSON, UTF8, digest, identity, permission,
cancellation and numeric-precision errors keep their existing handling.
Hybrid-v1 through v5 preserve their previous representation and error behavior.
V6 also recognizes the exact provider-context envelope described below when
observed in a container created by `0.148.0-alpha.15`; v5 keeps its existing
`0.153.4` boundary. A container creation version does not identify the producer
of every later record. No record-producer version, human attribution or current
instruction authority is inferred from this additional observation.

Hybrid-v5 additionally recognizes the observed Codex `0.153.4` provider context
envelope whose three text parts are attributed, in order, to
`plugins.recommendations`, `agents_md.instructions` and
`environments.environment_context`. Despite its recorded wire `user` role, it
stays only in the unchanged original companion and exact record ledger; it is
not reconstructed as a human message or copied into native instructions. The
outer record fields (only ordinal/type/payload and an optional timestamp string),
version, exact payload/metadata fields and types, and part/kind count and order
must match. Unknown fields or mixed user/private content kinds remain
unqualified. Hybrid-v1 through v4 retain their original output and identity.

Hybrid-v4 adds explicitly versioned historical representations while retaining
hybrid-v1/v2/v3 output and identity. For creation versions `0.148.0-alpha.15`
and `0.149.0-alpha.4.3`, an assistant wire message with a different ID can
corroborate exactly one canonical message only with the same physical owner,
recorded turn, unchanged phase and complete qualified text projection. The
canonical record must immediately precede the wire record in both original
ordinal and byte order; one-to-one use and original order are checked. No
message ID is rewritten or claimed equivalent. Ambiguity is not a match.

Known legacy user transmissions whose canonical relationship cannot be proved
are preserved as explicitly labelled historical provider data, not attributed
as reconstructed user input. A narrow `0.148.0-alpha.15` assistant transmission
with recorded `unknown` content kind can likewise remain an unconfirmed quote
when immediately preceded by an original-only reasoning record. The reasoning
itself is not imported. This is not a rule for arbitrary unknown content kinds,
roles, provenance, fields or encrypted content. Native quotes are historical
assistant data; their labels, inventory and coverage distinguish them from
canonical authored messages, current answers, approval and recovery direction.
Old instruction strings may exist inside these quotes; they are not applied as
current instructions. Complete canonical authored coverage does not establish
the attribution of these additional transmissions.

The observed `personality` and `orchestrator_skills` configuration shapes in
creation versions `0.148.0-alpha.15`, `0.149.0-alpha.4.3` and `0.153.4` stay
original-only. Recorded failed `DynamicToolCall` shapes in `0.148.0-alpha.15`
and `0.163.0-alpha.10.2` are quoted in full as passive history, including
status, success, error and duration. They never become new native tool calls or
successful execution. Unknown fields and unqualified representations remain
diagnosed with their originals preserved.

Same-process inspected artifacts freeze metadata, mapping, rows and callbacks
without evaluating lazy bodies. Publication accepts the original privately
registered inspected object, not a clone, JSON summary or replacement callback.
Rechecks verify current files and detached small Buffer bytes before effects;
this identity check grants no permission. A later process inspects originals
again. Target paths use JSON serialization and official native handoff; running
Desktop registry files are never directly patched to register a conversation.

Live physical intake records `CodexSelectedHistoryAddressEvidence`: exact
selected typed addresses and projection watermarks, not another copy of the
canonical database item bodies. Original bodies come from the verified raw
prefixes; canonical-row/body equivalence remains unclaimed. Offline full
canonical capture is a separate existing path. Physical filenames may end in
`-<physical UUID>.jsonl` or `_<physical UUID>.jsonl`; selected logical state,
header identity, ancestor cutoff bytes/ordinals and digests must still agree.
Historical paginated creation versions `0.148.0-alpha.15`, `0.149.0-alpha.4.3`
and `0.153.4` use the
same explicit format checks; this does not relax the installed SQLite profile.

An explicitly selected `.jsonl.zst` ancestor uses the official Node Zstd stream
adapter with a bounded window and shared operation deadline. It stores only the
requested decoded prefix, verifies its LF/ordinal/cutoff and reconciles the exact
compressed input range observed. P3 records distinguish filesystem-prefetched
input from decoder-consumed bytes and bind their digest/identity to the decoded
prefix. Original compressed files stay unchanged at source; compressed containers
and decoded parent futures are not copied into the archive. The stored prefix is
labelled `zstd-decoded-selected-prefix`, not an original uncompressed file.
Early cutoff does not verify a complete compressed frame/container checksum.
Archive reads verify stored prefix bytes/lineage and the typed encoding record;
they do not claim offline reproduction from a stored compressed container.
Permission, cancellation and decoder errors remain failures, distinct from the
deliberate cutoff. Discovery returns exact compressed names for HEAD to include
in its existing explicit ancestor scope; users need no JSON or file renaming.

Lode's file-backed processing does not make the official Claude SDK a streaming
reader. SDK 0.3.234 loads and reconstructs the selected conversation before
applying offset/limit. Verify the actual emitted output with the pinned reader
in a supervised process, and report its resource/format failure separately.
Small SDK pages, a successful archive or Lode's exact digest are not proof of
SDK success, Desktop display or model continuation.
Unknown prior same-ID or opaque operations stay scoped to that conversation's
native effect. Their first unresolved observation is retained once in the local
P5 store; a later packet that omits that history does not clear it. Old paths and
inode numbers do not prove another PC or reset an attempt. If all evidence is
erased, global exactly-once reconstruction is impossible and is not claimed.

A historical target ID is qualified only against the exact original publication
record, its historical manifest and intent, input digest, captured source and
selected conversation, supported converter, deterministic native ID and stored
operation namespace. A different UUID alone does not establish an unrelated
attempt. Missing proof, unknown schema/profile, malformed content or inconsistent
bindings remain opaque; actual original-byte, permission and identity failures
remain primary errors. This pure classification supplies no lease or retry
permission and does not change the current conversation's source representation.
Unknown or partial entries inside managed P5 namespaces retain original file
bytes where supported and explicit scope metadata. Unclassified entries in old
archives remain coverage uncertainty, never a newly invented executed attempt
or an apparently safe empty history. Ordinary valid transfers need no extra user
form or approval; only the affected uncertain effect remains pending.

The archive and derivative evidence never grant execution permission or P2
recovery. Host storage, journal results and source transcripts do not become
ReviewDecision, Product Canon, current Session selection or task completion.
The current candidate was exercised on three finite captured conversations under
the qualified Claude CLI 2.1.317 / Agent SDK 0.3.234 profile. All 250,631 emitted
messages matched the official reader. The official Desktop local `/resume`
picker and actual conversation display were observed for all three, with exact
native-ID bindings and original prefixes verified unchanged after viewing. No
new model prompt was submitted during this check.

This validates those selected copies and their observed display. Future model
use of the complete migrated context, automatic synchronization of later source
messages, and other client versions remain unverified. New targets still need
their own storage, reader and display observations; a saved result is not a
reason to replay publication or automatically continue a task.

When code/docs are requested, HEAD supplies `workspace_sources` with each current
Project workspace and its approved repository-owned path inventory during live
capture or evidence export. Each workspace remains separate. Binary and empty
files use streamed content-addressed objects; verification does not load whole
code blobs into a Context or apply the native transcript decoder's byte limit.
The selection is explicit and is not a claim that every repository file or build
dependency was included. Missing selected files and every exclusion remain visible.

After moving the same archive, `restore-portable-workspaces` consumes current
`workspace_targets` with `copy` or `reuse`. It never opens an original source-PC
path. New folders can be created under the current target scope; existing
identical files converge without another write. Conflicts leave that workspace
untouched while independent workspaces can proceed. Distinct source roots cannot
silently flatten into one target. `nextConversationMappings` carries the already
agreed restored/reused folders into the conversation steps without another
approval or user-authored ID/JSON ritual.

Recognized Git, credential/environment and private client/user paths plus Host
connection configuration stay excluded, including nested occurrences. Agent
instruction files are retained as passive evidence and are not automatically
activated in the target workspace. Source ACLs, ownership and executable bits
are not imported; available executable-bit facts are evidence only and new files
use current target defaults. This transports the selected code/docs bytes without
claiming a fully configured/runnable environment. Reuse leaves current files and
their permissions alone and does not claim historical version equality.

Named key/credential containers such as `.key`, `.p12`, `.pfx`, `.jks` and
`.keystore` are excluded. Streaming checks of `.pem` and `.asc` reject recognized
private-key headers while preserving ordinary public-certificate data. These
path/format checks are not a secret-free certification: ordinary selected source,
documents and `.env.example` can still contain sensitive content. The selection
stays within the user's agreed repository scope; there is no extra approval form.

Copy cannot target the archive itself or its interior, including recognized
physical aliases. An ancestor target is allowed only when every selected output
and its staging parent remain outside the protected archive. Explicit reuse
writes nothing. Native delivery and reuse do not rehash or require unrelated
workspace blobs; actual copy verifies only the exact captured files it restores.
Passive instruction objects are not copied and do not block that operation.
`workspaceObjectCoverage` reports verified/unverified roots and object counts.
Its `objectSelection` is `restore-captured-only` for copy; roots with unexamined
passive objects appear in `partiallyVerifiedSourceRoots`, not as fully verified.
Unexamined integrity is unknown for that operation and resolves no earlier failure.
The ordinary full archive read continues to verify all declared workspace objects.

`partialWorkspaceRestore` retains the primary error, completed paths, the active
unconfirmed path and unvisited scope on failure. There is no overwrite, rollback,
alternate writer or extra observation after permission denial. Workspace restore
does not import a common Session or regenerate Project/agent integration. Existing
explicit common Session staging/import remains the way to recover original P2.

### Captured conversation display names

Physical-v3, hybrid-v2 and hybrid-v3 derivations use the captured selected-state name as list metadata, trimmed using official SDK semantics. Long and duplicate names remain valid. With no display name, a generic label plus the source ID is used; the first prompt is never a fallback because it can contain sensitive input. Native IDs and recorded fork ancestry remain separate provenance.

Historical physical-v1/v2 and hybrid-v1 retain their original bytes and reproduction rules. A naming upgrade does not republish a delivered conversation under a new ID. Default derivation resumes an existing exact profile; ambiguous multiple profiles require an exact selection.

For an explicitly authorized correction, proposeClaudeDerivedTitle obtains the name from a reproduced artifact and verified typed source evidence. The private P3 plan grants no authority. correctClaudeDerivedTitle requires current Host authority and existing destination admission, using a destination-global P5 create-only journal and one-use SDK capability. Official SDK 0.3.234 renameSession appends title metadata to the same native ID. Imported and full pre-call prefixes, file identity, messages and current title baseline are verified. Ordinary app metadata appends are allowed; changed titles or bodies prevent overwriting another writer. An attempt without a durable result is uncertain and never automatically replayed.

After correction, SDK titles are compared with the captured-name receipt, while bodies still match the immutable original derivation. This starts no model turn and grants no Product, Session/P2, execution or recovery authority.

The SDK has no compare-and-swap against non-cooperating writers. Visible competing title records in the mutation suffix leave the attempt uncertain; they are not reported as a clean success. A result without its attempt is rejected before any native effect.

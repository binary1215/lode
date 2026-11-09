# Work documents in Notion and Obsidian

Ask Lode to document a selected piece of work. A human explanation and an agent
Markdown view share the same exact originals: reasons, alternatives, conditions,
results, unfinished work and unknowns. Neither view becomes user approval,
Product Canon, a checkpoint or a completion decision.

A local preview needs no Product onboarding, World rebuild, export, Run or Todo
adoption. Existing work without Todos can use its exact work original and
explicit work links. Lode supplies structured arguments; users need not write JSON.

Connecting a vault or Notion parent records only the destinations and automatic
task scope the user selected. Connection performs no publication. Notion stores
an explicitly chosen Host environment-variable reference, never a token or ambient
credential discovery. Missing connections never block ordinary work. Real posting
requires current user authorization for the destination and content scope.

## Reading the result

### Browse a Project by product and feature

Ask: “Organize this Project's documentation by product, feature group and
feature, with a human view and an agent view.” Lode copies actual Product Canon
membership, including nested groups and multiple parents. Product here is a
reading root for the existing Project, not an invented Canon entity. Shared
decisions and work link one original from several features; a Session is not
forced under one feature. Unconfirmed associations remain unclassified.

Both audiences use the same facts. Humans see purpose, flow, conditions, results
and useful links; agents also see exact IDs, sources and selected code/diff/graph
evidence. Lode explains exact selected sources; Core never invents prose or
implementation mappings. Explanations retain their original source bindings:
after a Canon change they are historical until Lode deliberately updates them.
Missing code, comparisons or execution evidence stays unknown.

Enable optional projectDocuments scope through the existing connection
conversation; upgrading does not expand a task-only connection. No extra user
JSON, Todo or onboarding step is needed. Automatic Project scope can document
meaningful saved analysis without a Todo. A rich prior selection is kept or
deliberately revised by Lode, never silently shrunk to the last note.

One Project home is shared across Sessions and aliases for the same actual Notion
parent or physical vault. Different Projects with the same title remain separate.
Notion creates an owned Project home under the selected parent, with reader homes
and linked entity pages; every child still checks its exact parent. Obsidian adds
Lode/<Project>/ProjectDocuments/. Existing task documents are not moved or deleted.
Stable page identities survive renames; prior reading bodies remain linked
history, and personal notes are never rewritten.

Large hierarchies continue in bounded publication calls, including beyond the
65th page. Lode follows continuation-required without asking the user to run a
script or resave work. Publication completion requires observing every selected
page and required link. This is **not simultaneous remote CAS**: receipts state
the last verified scope. Source/config changes and user edits preserve prior
current receipts. A successor update first marks the home as in progress, before
changing linked child bodies; readers are told that links may span update times.
Only the fully observed publication clears that notice. Failed or cancelled
updates do not silently present a mixed scope as completed. Unreadable or unselected Sessions cannot silently delete their
known contributions. Malformed or denied Canon reads retain their primary failure.

If a lost-create search spans multiple calls, matching pages remain candidate
observations. Different-time slices cannot establish current global uniqueness.
The attempt retains that limit across restart, source changes and target aliases.
Candidate readback reports changed, missing-at-read or unavailable bodies without
automatically binding a page or repeating POST. Exact provider terminal result
IDs keep their separate validated recovery path. The existing single bounded
parent observation is also not an atomic remote snapshot or authorship proof.

Typed MCP: lode_project_document_prepare, lode_project_document_publish,
lode_project_document_status. CLI: project-document-prepare,
project-document-publish, project-document-status. Lode supplies exact work
references, optional feature reading associations, saved task reading selections
and source-linked narrative. Project delivery records are P5 under
document-projection/project/<Project>/; they never combine Session P2 direction.

A stable Lode-owned start document links the last verified human and agent views,
separate personal notes and the prior published view. “Current” means the last
basis whose two views and required links were read back successfully. It does not
mean all unpublished local changes, task completion, deployment or every source.

Both views preserve important cancellations, missing tests and contradictions.
An author's agreement summary is not an original user utterance. A matching hash
is not semantic freshness; old test success is not a test of today's revision.
Exact before/after bytes permit a bounded comparison; missing bytes are disclosed,
never replaced by an invented diff. Graph relationships support navigation, not
approval, implementation fulfillment or causality.

Selected content and comparisons are readable inside the view. Local paths identify
evidence without promising remote access. No full transcript, provider session
identity or absolute local root is automatically copied. A Session checkpoint may
describe another task and is not automatically exported.

## Updates and retries

The async CLI/MCP `session-work-record` composition first saves the existing
create-only P3 original. An explicitly connected task's uniquely scoped result
then prepares related documents. Later partial, waiting, cancelled and corrected
revisions update the same scope. Native termination, idle, checkpoint save, empty
pending and a bare `completed` label never establish completion. Mixed tasks and
incomplete/conflicting revisions leave publication unconfirmed, preserving the
saved work. No-change retries create no duplicate documents.

The synchronous `recordSessionWorkEvidence` API stays synchronous. Checkpoint sync
and unrelated saves gain no external posting effect. Work without a unique Todo
result can use explicit preparation; Todo adoption is not a new paperwork gate.

An exact result retry reuses its verified evidence/diff/quotation/related/graph
selection. It never silently substitutes a smaller recent-only view. For a new
revision, Lode may supply optional `document_selection` in the same async record
call (CLI `--document-selection`). Its local `recorded` alias resolves to that
saved original; it does not change P3 schema or grant authority. If an existing
rich selection cannot be carried safely without Lode judgment, the response
reports `head-selection-required`, the recorded reopen/cancellation and remote
not-updated state. Lode continues explicit preparation and publication in the same
turn, using the supplied exact prior scope, without asking the user for a form or
re-saving work. Old before/after pairs remain historical unless explicitly
selected for the new record; they are not automatically relabelled as a new change.

A substantive written analysis can publish from its valid P3 result body without
an external-file attachment. A task/status label without result content remains
unconfirmed. This is a content-availability check, not semantic sufficiency,
execution success or approval. Missing source files remain disclosed in both
views with their exact failure codes; available retained bytes are distinguished
from current files. Failed comparisons or quotations stay unknown. Original P3
identity/digest failure rejects the basis, and a source permission denial is not
retried through another reader. Text-only CLI/MCP results preserve publication
status and Lode's bounded preparation/publishing follow-up as well as structured
responses. Document effects are distinguished from original task effects.

Every external effect has a prior durable attempt. Lost creates use the trusted
attempt and bounded selected-parent enumeration with exact body/parent checks.
Missing mappings, copied markers, duplicates, expired tasks and empty/partial
listings do not permit blind POST replay. A matching content copy is not proof of
the original creation event or authorship. Old exact references never bind to a
new same-title page. Known async tasks require terminal success and readback;
missing warnings alone is not success. One destination failure does not erase
another's receipt. Retry posting, never the original task effect.

A normal, matching Notion `403` / `restricted_resource` error on page creation or
exact Markdown update records a rejected write separately from unknown effects.
Its cause is retained: this code can mean a workspace block limit as well as
missing permission. Repair alone does not retry. Within current authorization,
Lode uses the returned exact attempt reference in `retry_rejected_writes`
(CLI input `retryRejectedWrites`) for one explicit same-request successor attempt.
Prior attempts and outcomes remain create-only. Repeated refusal needs its new
reference; repeated clicks cannot launch another successor. Parent, method,
content, configuration, source basis and current managed text must still match.
When sources change, Lode prepares a fresh pair. An identical stable start/notes
creation can retain its rejected-attempt reference under that verified new basis;
this does not reuse an old view, changed write body or stale prepared source.
Users need not write JSON or re-run the original task. This never bypasses a Host
denial, switches accounts or silently retries from the automatic record hook.

HTTP numbers, error wording and caller flags alone prove nothing. Malformed or
mismatched errors, response loss, 5xx, async failure, deadline/size limits and a
failure to persist rejection evidence remain unknown; they cannot authorize a
new write. A retry whose response is lost follows the same readback-only recovery.
The rejection is P5 operational evidence, not permission or a recovery decision.

Each Notion publication/recovery shares 30 seconds and 64 requests; responses are
bounded to 4 MiB during streaming. These are optional transport budgets, not
semantic context limits or ordinary-work gates. Exhaustion preserves unknown
effects. There is no daemon; a subsequent request can continue known pending work.

## Ownership and concurrency

Task-mode Obsidian writes only the configured `Lode/<Project>/<Session>/<task-key>/` area.
Revision files use exclusive create. Personal notes are separate. Managed start
text changes only while exact old text remains. Notion uses one `update_content`
exact-text edit rather than full-page replacement. Unmanaged content is preserved;
edits to generated views produce drift, not silent overwrite or Canon ingestion.

Destination-local coordination holds no Project mutation lock during HTTP.
Read-before/write-after and exact text edits are **not remote CAS**. Arbitrary
concurrent editing is not guaranteed lossless; two destinations are not an atomic
transaction. Receipts state the verified scope and preserve partial/unknown results.

## APIs and evidence

Typed MCP: `lode_work_document_configure`, `lode_work_document_prepare`,
`lode_work_document_publish`, `lode_work_document_status`, discoverable under
`lode_work_`. CLI: matching `work-document-*` commands with request-local Session
routing. Status reads local receipts; it is not a live network freshness probe.

Common basis/views are P4. Configuration, attempts, async progress, receipts and
replaceable current pointers are P5 in existing
`document-projection/work/<Session>/` storage. Logical key, basis, rendered view,
resolved payload and readback digests are distinct. The existing synchronous
GraphSnapshot Markdown adapter and byte-equality contract remain unchanged.

Validation uses synthetic vaults and fake HTTP. Actual Notion normalization,
permissions and service concurrency still require live qualification. Strict
readback differences remain unconfirmed; fake tests do not qualify the live service.

[Existing document adapter](document-projection-adapter.md)

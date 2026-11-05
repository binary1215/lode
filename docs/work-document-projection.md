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
revision, HEAD may supply optional `document_selection` in the same async record
call (CLI `--document-selection`). Its local `recorded` alias resolves to that
saved original; it does not change P3 schema or grant authority. If an existing
rich selection cannot be carried safely without HEAD judgment, the response
reports `head-selection-required`, the recorded reopen/cancellation and remote
not-updated state. HEAD continues explicit preparation and publication in the same
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
status and HEAD's bounded preparation/publishing follow-up as well as structured
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
HEAD uses the returned exact attempt reference in `retry_rejected_writes`
(CLI input `retryRejectedWrites`) for one explicit same-request successor attempt.
Prior attempts and outcomes remain create-only. Repeated refusal needs its new
reference; repeated clicks cannot launch another successor. Parent, method,
content, configuration, source basis and current managed text must still match.
When sources change, HEAD prepares a fresh pair. An identical stable start/notes
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

Obsidian writes only the configured `Lode/<Project>/<Session>/<task-key>/` area.
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

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

## Where documents go

Every publication goes into one readable tree per product, inside `Lode/` in the
vault or under the configured Notion parent:

```
Lode/
└─ <product>/
   ├─ <product>.md
   ├─ 근거/
   ├─ <feature group>/
   │  ├─ <feature group>.md
   │  ├─ 근거/
   │  └─ <feature>/
   │     ├─ <feature>.md
   │     ├─ <task title> 결과 1.md
   │     ├─ <task title> 결과 2.md
   │     └─ 근거/
   ├─ 소속 미확인/
   ├─ 결정과 조건/
   └─ 작업 기록/
```

Each folder has a document named like the folder: the product, feature group or
feature document. Each published result is a new file, `<task title> 결과 N.md`,
written once and never rewritten; a later result links back with 이전 결과. The
agent counterpart of every document sits in the same folder's `근거/` as
`<document name> 근거.md`.

Names: the product is the Project title chosen for Project documentation,
otherwise the Project folder name; groups and features use Product model names.
Characters a file name cannot hold are removed, names stop at 40 characters, and a
short suffix such as `(d403)` is added only when the name is already taken in
that folder, by another Lode document or by a file a person made there. Page
titles already used under the configured Notion parent are never reused either;
inside Lode's own pages only Lode's own names are checked. Vault paths
stay within 180 characters: deeper groups are placed higher and links keep the
hierarchy.

Placement:
- A feature in several groups (or a group with several parents) gets one folder,
  under the parent listed first in the Product model file; the others link to it.
- A result for several features is a file in the first feature's folder and is
  listed in the others.
- A result with no feature, or with a key that is not a Product feature, goes to
  `소속 미확인/`. Prepare and publish report the keys that were not accepted.
- A feature without a group gets a folder directly under the product. Without a
  Product model only the product folder and `소속 미확인/` exist.

Lode chooses the features while preparing: `feature_keys` on
`lode_work_document_prepare` (or `featureKeys` in `document_selection`), picked
from the Product model's features; a feature the user named wins. This is a
reading link only: the Product model is never changed.

A folder's place is fixed when it is first created and recorded per destination
(a feature-to-folder table). When the Product model renames or moves a feature,
its folder and files stay; titles and link text follow the new name, and new
results keep landing in the existing folder.

### What a person reads

A result document has a title, the status and recorded time (UTC), 한 일, 판단과
이유, 남은 일, 확인하지 못한 것 and one closing link line (이전 결과, the feature,
the 근거 document). Human documents carry no identity lines, markers, hashes, IDs,
internal codes, repeated notices or comments. The 근거 document starts with a
`관리 정보` section: the read-only notice, both document identities, Project,
Session and task, result number, evidence, basis digest, previous result and the
renderer and layout versions. Exact sources, comparisons, quotes and graph
evidence follow. Lode never reads `관리 정보` back to decide anything: its own
records stay the source, and readback compares whole documents.

Lists such as a feature's 이 기능의 결과 need no markers. Lode records the last
list text it wrote and replaces it only where that text occurs exactly once. If a
person changed the list, it is kept and reported as `personEdited`, and the
result still publishes. A document still exactly as Lode last wrote it may be
rewritten whole (title, description). Documents are judged by their text, not by
the file: an editor or sync tool that saves through a temporary file changes
nothing. A folder document a person deleted or renamed is reported as
`document-missing-not-recreated` and results still publish; Lode does not
recreate it. Restoring the file (from the vault's trash or by undoing the rename)
brings it back, and Lode updates its lists again once their last text is found.
Files people create inside Lode folders are never touched, and a person's file
at a name Lode was about to create is reported (`WORK_DOCUMENT_NAME_OCCUPIED`),
not overwritten. There are no per-task Start or Notes documents.

### Project documentation

Ask: “Organize this Project's documentation by product, feature group and
feature.” With the optional `projectDocuments` scope, Project publication fills
the product, group and feature documents (descriptions, related decisions,
source-linked narrative), `결정과 조건/` (one document per decision, requirement,
constraint, capability and policy) and `작업 기록/` (the selected work records,
newest first). Product here is a reading root for the existing Project, not an
invented Canon entity. Shared decisions and work link one original from several
features. Explanations keep their source bindings: after a Model change they are
marked as about an earlier original until Lode updates them.

Task readings selected for Project documentation are linked to their published
results. Lode publishes results with `lode_work_document_publish`; automatic
publication does both. Enable `projectDocuments` through the existing connection
conversation; upgrading does not widen a task-only connection. No user JSON, Todo
or onboarding step is added. A rich prior selection is kept or deliberately
revised by Lode, never silently shrunk to the last note.

One tree is shared across Sessions and aliases for the same actual Notion parent
or physical vault. Different Projects with the same title get separate folders.
Large products continue in bounded calls: `continuation-required` is Lode's to
follow, never a user task. While a publication spans several calls, the product
document says that it is being updated until the last call; documents are
otherwise updated in place without history copies, since results are never
rewritten. Completion requires observing every selected document.
This is **not simultaneous remote CAS**: receipts state the last verified scope.
A stale source or configuration is refused, and Canon read failures keep their
primary failure. Unreadable or unselected Sessions never silently delete their
contributions.

### Notion

Notion gets the same tree as pages under the configured parent: product, group,
feature and result pages, with each page's 근거 pages under a `근거` page below
it. Page titles are the vault file names without `.md`, and human pages carry no
identity line. When the outcome of a page creation is unknown, Lode binds a page
only if exactly one page under the exact parent matches both title and body and
is not recorded for another document; otherwise it stops and reports. It never
creates a duplicate. If a lost-create search spans several calls, matches stay
candidate observations without establishing current uniqueness. The first
publication of a new tree can exceed one call's request budget: the result is
`continuation-required`, and publishing the same projection again continues with
completed steps kept.

### Earlier publications

Documents published before this layout (`Lode/<Project>/<Session>/<task-key>/` and
`Lode/<Project>/ProjectDocuments/`) are never moved, renamed, deleted or
re-recorded; their records read as published in the old layout. The next result
of such a task goes into the new tree with 이전 결과 pointing at the old human
document, and the old Start document's Lode list region is replaced once with a
link to the new location. If a person edited that region it is skipped and
reported.

### Meaning

“Current” means the last basis whose documents and required links were read back.
It does not mean all unpublished local changes, task completion, deployment or
every source. Typed MCP: lode_project_document (prepare, publish, status). CLI:
project-document-prepare, project-document-publish, project-document-status.
Delivery records are P5 under document-projection/project/<Project>/; they never
combine Session P2 direction.

Both documents keep important cancellations, missing tests and contradictions.
An author's agreement summary is not an original user utterance. A matching hash
is not semantic freshness; old test success is not a test of today's revision.
Exact before/after bytes permit a bounded comparison in the 근거 document; missing
bytes are disclosed, never replaced by an invented diff. Graph relationships
support navigation, not approval, implementation fulfillment or causality. Local
paths identify evidence without promising remote access. No full transcript,
provider session identity or absolute local root is copied, and a Session
checkpoint is not automatically exported.

## Updates and retries

The async CLI/MCP `session-work-record` composition first saves the existing
create-only P3 original. An explicitly connected task's uniquely scoped result
then prepares related documents. Later partial, waiting, cancelled and corrected
revisions are published as the task's next results. Native termination, idle, checkpoint save, empty
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
reports `lode-selection-required`, the recorded reopen/cancellation and remote
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
Missing mappings, copied pages, duplicates, expired tasks and empty/partial
listings do not permit blind POST replay; a vault file is settled by its exact
name instead (absent: created; Lode's text: bound; other text: kept). A matching content copy is not proof of
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
When sources change, Lode prepares a fresh pair. An identical creation of a tree
document can retain its rejected-attempt reference under that verified new basis;
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

Obsidian writes only inside `Lode/` of the selected vault. New documents use
exclusive create. A Lode document changes only while the text Lode recorded is
still there: the whole document, or exactly one list region. Notion uses one `update_content`
exact-text edit rather than full-page replacement. Unmanaged content is preserved;
edits to generated views produce drift, not silent overwrite or Canon ingestion.

Destination-local coordination holds no Project mutation lock during HTTP.
Read-before/write-after and exact text edits are **not remote CAS**. Arbitrary
concurrent editing is not guaranteed lossless; two destinations are not an atomic
transaction. Receipts state the verified scope and preserve partial/unknown results.

## APIs and evidence

Typed MCP: `lode_work_document` (`configure`/`prepare`/`publish`/`status`), discoverable under
`lode_work_`. CLI: matching `work-document-*` commands with request-local Session
routing. Status reads local receipts; it is not a live network freshness probe.

Common basis/views are P4. Configuration, attempts, async progress, receipts and
replaceable current pointers are P5 in existing
`document-projection/work/<Session>/` storage. Logical key, basis, rendered view,
resolved payload and readback digests are distinct. The tree record (layout version,
feature-to-folder table, file names, last written list text) is P5 under
document-projection/project/<Project>/. The existing synchronous
GraphSnapshot Markdown adapter and byte-equality contract remain unchanged.

Validation uses synthetic vaults and fake HTTP. Actual Notion normalization,
permissions and service concurrency still require live qualification. Strict
readback differences remain unconfirmed; fake tests do not qualify the live service.

[Existing document adapter](document-projection-adapter.md)

# Graph Explorer

Graph Explorer makes a local, read-only picture of existing Lode evidence. Use it
to follow a purpose or recorded judgment to sources, relationships, results and
remaining questions. It is optional: ordinary work and recovery do not depend on it.

## Open a snapshot

Ask Lode: “Create a local graph snapshot for this project.” In a distribution
containing the exporter, the agent can run this from the plugin directory:

```powershell
node scripts/lode.mjs graph-explorer "<project-directory>"
node scripts/lode.mjs graph-explorer "<project-directory>" --query relay --history
node scripts/lode.mjs graph-explorer "<project-directory>" --share
```

Open the returned HTML file in a browser. No server, account, database setup or
Session binding is required. The default output is a newly created operating-system
temporary directory. An optional `--output` selects a new report file; existing
files and canonical/runtime directories cannot be overwritten. Each explicit
generation makes one report, not an automatic stream of artifacts.

The executable belongs to the plugin, but `<project-directory>` is the project
you are working on. Always pass it explicitly. Missing Project, World or source
evidence is disclosed; the exporter does not substitute Lode's code or a demo.

## Follow a recorded decision

Ask for the work or review you want to follow. The same exporter accepts exact
record IDs and source paths, without requiring a Run or another approval:

```powershell
node scripts/lode.mjs graph-explorer "<project-directory>" --anchors "<exact-work-or-review-id>" --paths "src/service.mjs"
node scripts/lode.mjs graph-explorer "<project-directory>" --layer code --anchors "<exact-structural-node-id>"
```

The explicit anchors choose the detail bundle; selected work also supplies its
recorded source citations. All verified available navigation metadata remains
searchable. A comparison lists work citing each exact before/after path and
digest, including unselected work. Read citing work returns to that record
without claiming it caused the change. A document citation links to its verified
original container, not every decision or candidate contained in those bytes.
Source-layer anchors stay in the structural namespace and reopen that layer.
Only verified same-snapshot path+digest bindings select corresponding source
details; no new Project node or cross-layer edge is created. An unavailable
explicit anchor never falls back to selecting an unrelated first record.
Stored parent/revision-producing and review relationships retain their distinct
directions; a producer's revise decision is not the successor's acceptance.

When a detail is absent, Exact detail options shows an exact-anchor regeneration
request, not a command executed by the HTML. The new report re-observes evidence
at a new basis; it is never silently merged into the old snapshot. Missing detail
does not mean no recorded work or no change. Result verification/evidence/impact
and review next actions are readable from included exact originals; they are
recorded claims, not checks re-run by this view or fresh effect permission.
Navigation excerpts and structured originals disclose truncation; raw originals
remain separately bounded and can themselves be omitted.

## Explore the evidence

The Project layer shows recorded purposes, decisions, work and retained lineage.
The Source layer shows the existing code graph’s imports and calls. They retain
their separate original identifiers and basis; matching paths do not create new
relationships. Product and Work are filters over shared evidence, not two databases.

Start with records from search, the map or the list. Click or Enter adds a record
to the selection and changes reading focus; it does not move the camera or unfold
neighbors. Ctrl/Cmd-click, a checkbox or Space toggles membership. Use Clear
selection or Select only focus explicitly. Shift-drag the map background, or turn
on Rectangle select, to add visible records; the list and keyboard can select the
same set. Escape cancels a gesture/calculation without clearing prior selection.

Open direct connections, a double-click on a map title, or Shift+Enter on its map
card opens exactly that record's one-hop adjacency. It does not advance to the
next unseen layer on repeat. Large neighborhoods yield and can be cancelled;
only first-screen positions are prepared, with all other records and relationship
pages still accessible. Existing selection, pins and prior coordinates remain.
This explicit action may center a readable card; ordinary Read keeps the camera.
Newer user pan/zoom input during calculation is preserved on completion.

Expand next boundary adds the next unseen layer from the selected set. Repeating
it advances through the already exposed boundary, rather than repeatedly opening
the same one-hop neighborhood. Optional relationship/kind filters disclose the
scope. New records get positions without moving earlier records, pins, camera or
map mode. Off-screen additions stay accessible through the lists and explicit
center/fit controls. Fold last addition removes only that operation's contribution;
shared, selected, pinned and pre-existing records remain. Back/forward restores
recorded selection, scope, mode and camera stages instead of visiting and expanding
an ID again. Manual pin positions stay stable.

Code neighbors expand horizontally; purpose, product and operational records expand vertically.
These axes are layout guidance, not a new hierarchy or invented relationship.
Previously explored nodes
keep their positions. Drag a card header to pin its screen position, or use `Shift` and
arrow keys on a focused node. Back, forward and the exploration path return to
earlier view stages. These are temporary display choices, not saved product knowledge.
New automatic placements reserve the card rectangle, including
when starting from a disconnected record. Manual dragging can intentionally place
nodes together; expanding another node does not undo your positioning.
The initial record and a starting neighborhood open automatically. Focus selection
explicitly centers the reading focus; off-screen connections remain in the complete
paged list. A direct relationship's **Show on map: endpoint** action moves to that
record at readable card scale, retaining other selections and pinned coordinates.
Back/forward restores the camera step. This explicit action does not expand filters;
an endpoint outside the current scope retains the existing restore guidance.
Explored map explicitly fits exposed records. All evidence shows
the whole exported inventory in a Canvas overview, without creating an SVG
element for every record. Select a point or search any exact ID to focus it.
Search covers every exported record; list and connection pages are display
batches, not export limits. Filtered neighbors, off-screen neighbors and missing
endpoints have separate counts. Start here clears only the temporary journey.
Search highlights matches and narrows the result list; hiding nonmatches is a
separate checkbox. Explicit history, axis and view filters still apply; an
out-of-scope selection is retained and labelled. Show selected scope is an explicit
way back, not a silent opt-in to historical evidence. SVG and Canvas share the same
camera transform for drawing, pointer hits and rectangle selection, including
resized viewports; choosing a Canvas point does not exit the overview.
Node distance is not a relevance score.

When the explored set exceeds readable screen capacity, Explored map uses the
existing Canvas overview for that explored subset instead of creating thousands
of tiny card elements. The status distinguishes it from All evidence, which still
shows the whole inventory. Prior card coordinates and pins are untouched; select
a record and use Focus selection to return to readable cards. This is display
detail, not a record/relationship cap. Bulk placement also yields during crowded
candidate searches, and a cancelled/superseded fit cannot later replace your view.

Current evidence is the default. Include historical / non-current evidence
reveals retained records and exact relationships with their original state.
This switch cannot make them current or authorize an effect.

Expanded cards read recorded observations and suggested follow-ups even when a
work record has no summary. Map cards show an excerpt; reading cards retain the
exported structured content and exact partial-excerpt field/range labels. These
are agent-authored records, not captured user speech or permission. Reference-only
evidence and metadata-only projections have distinct notices. Exact-original
omission or read-failure codes remain separate; a missing summary does not prove
that the original is absent. Snapshot lookup notices match both the lookup method
and the complete recorded World/Source/Graph endpoint, not World ID alone.

Selected records stay together in individually folded reading cards. Open the
record you want to read; selecting another does not open every body or replace
the others. Adding or removing another selection, changing focus/filters,
Back/Forward, and paging away and back preserve unaffected cards' expansion and
scroll state within this HTML. State is isolated by Project, layer and revision;
an item without enough identity starts its own reading state afresh, without
blocking reading. Widen reading area opens a broader reading flow; narrow screens
stack it vertically. Card/record/reference pages are display batches, never a
selection or evidence cap. Read actual directed relationships in each card or the
focused connection list. Exact originals, unknown fields and IDs remain optional
details. Partial/missing/cancelled and unreviewed conditions are retained next to
the expanded content, not discarded when its card is folded. Selecting a historical
Session changes this picture only; the exporter does not infer a native Host
selection or change the Session used for work.

## Follow one Feature across perspectives

Select a verified Feature, FeatureGroup or Capability. The same-Feature panel
switches between **Structure**, **Recorded work**, and **Changes & related impact**
without changing the selection set, focused record, camera, pin coordinates,
independent body disclosures, or file/changed-region navigation. Reading related
work keeps the Feature anchor. These are display perspectives over the same
exported evidence, not new graph edges or another Product model.

Structure uses exact Project/model/kind/key identities, declared memberships,
policies, reviewed IMPLEMENTS mappings and VERIFIED_BY mappings. A test mapping
is not a passing test. A symbol mapping follows its exact declaring-file revision
for related source context; it does not claim the whole file implements the Feature. World projections join a Feature only through their
verified SourceSnapshot's exact Product Model identity; titles and paths do not
join models. Work follows exact mapped-source path+digest citations and declared
work-root/predecessor relationships, retaining branches, parallel edges and
cycles. Shared source citation is related evidence, not implementation cause.
A citation of an entire model does not assert fulfillment of every contained Feature.
Historical pending/unknowns stay distinct from current direction and current Todo.

Changes lists the recorded review's exact before/after model pairs separately.
Choose a pair to read only this entity's changed fields and recorded review reason.
The compared after endpoint is not necessarily today's Canon. The existing code
comparison panel also accepts the Feature's exact mapped-source bindings; a path
without the right digest cannot supply a before/after pair. Pair selection and
reading a perspective do not approve, write or execute anything.

Recorded-work traversal yields between batches and uses the existing Cancel calculation control. Cancelled work is not shown as complete; Read recorded work retries the same evidence without setup or approval.
Relationship lists render 20 rows per page and reach every included relationship; First evidence / Last evidence avoid repeated next-page clicks.
The complete metadata inventory remains searchable. Missing pair/original detail
means the export lacks that detail; it does not prove that the original or change
is absent. Use the existing exact reader/detail options or explicitly regenerate
a focused report. The offline HTML never fetches extra data automatically.

## Content cards and recorded groups

The focus/explored map starts with recorded titles, types, short source excerpts
and compact, wrapping status badges. Historical/no-live-permission, cancellation,
unreviewed, partial and unknown conditions are never hidden by the title/excerpt
line limits; the measured card footprint includes every badge. Selected reading cards show the same compact
evidence before opening their longer bodies. + opens source details and known
memberships; − folds that body without hiding the compact evidence. Map and reading-card disclosure are independent
display preferences, not evidence or authority changes. Read full record opens
that independent reading card. This is existing text, not a generated summary.
Expanded work is labelled as
agent-authored evidence, not a captured user utterance or live completion. Known
pending questions, cancellations, constraints, unreviewed and partial/historical
conditions stay separate from the shortened excerpt. A qualifier anywhere else
in free text may fall outside it: read the selected record and exact original for
the full wording. Missing bodies are disclosed, never invented. Raw metadata
remains an optional detail rather than the required way to understand a card.

Cards group only by verified declared work roots or exact Product/world
FeatureGroup membership in the same source/model basis. Shared Sessions, names,
paths, times and generic containment do not imply membership. Each exact node
has one card even when it belongs to several groups; the reading card lists all
known memberships and their directly recorded members. There is no inferred
transitive membership, new graph edge, primary group or group-editing operation.
Visible/exported member counts differ. Group backgrounds appear for expanded
members only; a background surrounds only actual
visible member rectangles. If a shared member or unrelated card would make an
enclosure misleading, the map uses a title/count and the membership list instead.
Groups are optional layout hints, not hierarchy or authority.

Expanded body text can be selected and scrolled without dragging or zooming the
map. The disclosure button does not select/pin the node; Enter/Space on it retain
native button behavior. Header drag, background
pan, Shift-drag rectangle selection and keyboard controls remain distinct.
Rectangle selection picks a card even when only its corner intersects by a
positive area; the Canvas whole-inventory overview keeps point selection.
Edges retain their real direction, parallel/self relationships and typed lists;
arrows end outside opaque card bounds. Only viewport-relevant cards/edges have
map DOM; off-screen evidence remains reachable in complete paged lists.

Ordinary expansion places new records only. No force simulation or rearrangement
button moves earlier cards. Visible cards use measurements of their displayed
HTML before first placement, including cards placed off-screen. Starting cards
appear first; high-degree direct neighborhoods are measured/placed in yielding,
cancellable batches. The complete inventory/search and ordinary reading remain
available during preparation; a new explicit operation supersedes that work.
Unprepared positions are counted separately from off-screen positions, not
presented as a completed layout. Untouched inventory bodies are not measured.
Pan, focus, normal map zoom and first viewport entry reuse committed geometry.
Opening/folding a map card measures its new bounds and adjusts only that
unpinned card when required, preferring free space within the current view.
Other coordinates, pins and camera remain unchanged; pinned overlap is not
silently undone. The expanded body has an internal scroll area and a full-record
reading action. A cancelled disclosure keeps the prior committed display.
Font/available-width changes update affected measurements and, if needed,
adjust only affected unpinned coordinates in a temporary calculation. Completion
applies the layout together; cancellation preserves its previous geometry and
does not immediately replay the same size calculation. A later actual metric
change can retry. Cancelled sizing or deliberately overlapping pins can leave
overlapping content; the independent reading cards remain available. Camera,
pins and unaffected reading state are retained. Ctrl/Cmd-wheel stays available
to native browser accessibility zoom. The page does not create saved UI state,
fetch fonts or add a server.

Show selected connections searches the current export/layer and explicit filters
using bidirectional adjacency. In each connected component it fixes one selected
reference: the current selected focus in that component, otherwise its first
selected record. It shows the union of shortest connection branches from that
reference to every other selected record in the component, retaining all equal
predecessors and the original edge directions/types. It does not enumerate every
path, find a globally minimal network, or prove cause, directed execution, approval
or completion. Disconnected components remain separate. Longer branches remain
available through normal expansion. Reading focus alone cannot recompute the
reference/result; changed selection or filters label the previous result until
an explicit new calculation. Large calculations yield and can be cancelled; an
unfinished calculation is not a completed result.

Retained history is different from the temporary exploration path and is optional.
The history view contains a bounded retained page and an
exact snapshot comparison when available. A pair of retained IDs is not evidence
of chronological order or causality. Missing history is shown as unavailable;
opening the view never refreshes or creates it.

## What the picture knows

The generation time, snapshot basis, coverage and omissions remain visible. This
is not a live view. Empty results do not prove that no other evidence exists.
Old revisions are not replaced with current files: if the expected digest differs,
the original panel says that the exact revision is unavailable. Stale code keeps
the original-source fallback while other verified records remain available.
The common code-comparison reader can separately recover exact historical bytes
from a verified retained source observation before trying local Git. Project,
path, digest and UTF-8 checks still apply; bounded or missing lookups remain
explicit. Retained before-only text with a missing current file does not prove
deletion, a Run's actions or the cause of a change.

Ordinary graph queries observe current source bytes for returned records and
relationship endpoints; the Explorer inventory observes its complete returned
inventory. Repeated graph verification is reused only for a request-owned,
verified immutable copy, not by trusting file mtimes or a caller's graph hash.
Current source bytes are checked again on subsequent requests.

There is no fixed node/edge count cutoff or arbitrary HTML-size cutoff for the
viewer inventory. The same typed readers verify the available layers; damaged
layers or source-reader resource bounds remain disclosed as incomplete coverage.
Ordinary conversational graph queries keep their existing limits.

The offline HTML stores repeated metadata in a lossless table encoding and
reconstructs the same JSON records when opened. This changes transport size,
not evidence identity, fields, multiplicity or authority. Large reports still
need memory to reconstruct their inventory; an export is not a browser-speed guarantee.
The HTML and export result disclose the exact UTF-8 file size with a nonblocking
resource notice. This warning does not trim records or impose a size gate.

Exact original text remains bounded to 64 KiB per file and 256 KiB in total.
The exporter includes a focused detail bundle for its query, not all original
bodies or every historical comparison. A metadata-only selection says so nearby
and provides a safely quoted command for another create-only report. Missing
detail does not mean no change. Show recorded code changes opens the existing
exact comparison, with added/removed excerpt lines and optional before/after
text. Partial excerpts and recorded-after versus current remain distinct; this
is not a complete file diff or a semantic verdict. Query, original-read and
rendering costs are separate measurements.

The Source layer shares already exported exact comparisons from the same Project.
A code record reaches a comparison only with matching source path and digest,
not a same-path guess or coincident IDs from another graph layer. When included,
Recorded code context in the expanded reading card opens its file context; Show
recorded code changes opens the shared comparison panel. Selection alone leaves
it folded; an intentionally opened panel stays open. File/hunk navigation opens
the requested comparison explicitly. Missing bounded detail remains unavailable
and can require a new query-focused export, never a runtime read from this HTML.

Selected changes and their files can be read together. Only existing, exact-linked
comparison pairs are displayed: recorded snapshot before/after, cited A/B, or a
cited revision versus export-observed current. Selection/click order, matching
paths and timestamps do not create a pair or a request boundary. Each comparison
retains its version/provenance and missing-time, partial or unavailable conditions.
Files without comparisons remain visible. Previous/next file and changed-region
controls move among open comparisons without closing the others or inventing
missing regions. No live file/Git/network reads are made by the HTML.

## Local data and authority

The HTML contains real source snippets and recorded decisions. Treat it like
repository data when sharing it. It uses no runtime fetch, CDN, telemetry, external
image or local server. Untrusted repository text is displayed as text under a
restrictive content security policy. Explicit local read-only adapters avoid a
configured remote graph store.

`--share` omits generated `project.root`, local regeneration executable/Project
arguments, and generated original-expansion `project_root` hints. Exact IDs,
digests, original bodies, historical references and evidence are not redacted.
Those originals may themselves contain absolute paths or confidential content:
review the report before sharing. This option is not anonymization. The ordinary
export retains local metadata and its safely quoted regeneration command.

The picture is a P4 derived view. It cannot approve an action, promote a candidate,
write a checkpoint, restore a Session, replay an effect or change original records.
Recorded completion and historical reviews retain their original meaning.

See [graph-first discovery](graph-discovery.md) and
[temporal provenance](temporal-provenance.md) for the underlying readers.

The [recorded context view](context-lineage.md) also follows selected work records
to cited code/documents and shows bounded exact version comparisons, recorded
reasons and missing evidence. Known original bodies are readable; raw JSON and
unknown fields remain optional diagnostics. This does not make a citation proof
of fulfillment or turn HEAD-authored work into a verbatim user message.

## Compact controls and unavailable current paths

On a narrow screen, the map comes before the folded evidence-display and
selection tools. Their controls and all exported metadata remain available.
Cards replace the former circle labels; glyphs are not squeezed to fit a fixed
caption width. Source/VM tests, including explicitly modeled font/width changes,
do not prove actual browser layout, mobile reading, 200% text, real gestures or
performance. The previously accepted synthetic-reader GUI scope does not prove
this follow-up's new layout, mobile or large-graph behavior; those require
separate actual browser verification.

Additional selection retains an exact comparison pair's open diff, file, changed
region and scroll state; another pair does not inherit them. Layer navigation
uses exact source identity rather than selecting an unrelated first record.
Hidden selections remain named with a restore action. Reading/diff/map jumps
reduce narrow-screen travel without expanding all cards by default.

Initial placement prioritizes the current viewport. The complete metadata and
direct-neighbor inventory remain accessible; explicit expansion and explored-map
placement still reach them. Initial and resized batches yield before atomic
commit, so cancellation or changed font metrics cannot publish partial geometry.
Overview geometry caching and offscreen-edge culling change drawing cost, not
which relationships exist. Source/model tests are not a 60fps or memory claim.

When the current path is not found, an exact cited digest can still locate
bounded historical raw Git bytes locally. The excerpt is separate from an
after-version: it does not manufacture an empty diff or establish a deletion.
Permission, path, encoding and byte-limit failures do not trigger this fallback.
Existing source and Git-command bounds still apply; missing local objects do not
cause a network fetch.

An optional rename candidate uses the most recent recorded path change, Git's
exact-byte move observation and the cited digest. It is historical evidence, not
verified logical continuity, current-path availability, fulfillment or cause.
Content-changing or unrecorded moves are not guessed. Candidate lookup follows
primary source reads and cannot consume their remaining command budget first.

### Follow explicit document links

An exact cited Markdown design document can expose its explicit local inline
links in the recorded-context panel. Read the cited document revision, then a
linked implementation/test excerpt or another included document's references.
Panels keep their open/reading state and navigation does not move the map camera.
Existing exported target records remain selectable; no invented graph edge or
node is added to make a link look like implementation or approval.

Links are extracted only from the exact cited digest through the common source
reader. An unavailable old document stays unavailable instead of using today's
text. Links without a target digest name a **current file at that path**, even if
the source document came from Git; the target's historical version is not proven.
Each reference retains its document digest and line/column. Duplicate versions
share reading but retain each source location; different digests remain distinct.

Navigation is bounded to 32 source reads, 64 links, depth 2, 256 KiB of delivered
source text and 512-character target excerpts. These are optional report resource
bounds, not semantic sufficiency or permission gates. Counts, pending paths,
depth/byte limits and excerpt omissions remain visible. Explicit inline Markdown
links are supported; fenced/indented/inline code, images and ambiguous paths are
not guessed. Resolve links from the document directory inside verified Project
source; root escapes, external/drive/UNC/stream paths, unsafe links and managed
namespaces are rejected locally. No external URL is downloaded, no World refresh
or canonical write is performed, and unrelated work stays available.

### Compact cards and independent comparisons

Cards start with the recorded title. A preview identical to that title is omitted; ordinary current-snapshot labels do not consume a status badge. Necessary historical, partial, unknown and non-current conditions remain visible before opening the body. Expanded empty cards explain the export's missing display text once without claiming the original does not exist.

Select several records to read their cards together. Full bodies and exact comparison pairs are independently collapsed by default; opening one does not close another. Partial-excerpt omissions stay outside the collapsed diff. Changed-region navigation opens the containing comparison before moving focus. Selection, expanded-card state and exact comparison reading state remain display-only and scoped to the same exported identities. This works with file/gzip input independently of the optional Git storage candidate.

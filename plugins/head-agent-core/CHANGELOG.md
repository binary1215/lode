# Changelog

[한국어](CHANGELOG.ko.md)

## Publication policy

Intermediate beta versions are distributed through the Codex and Claude
marketplace branches after successful CI and publication checks. A source commit
or version number alone does not prove publication. Git tags and GitHub Releases
are made only for separately designated releases; missing intermediate tags are
not backfilled. Marketplace publication does not prove local installation or
Host/MCP reload.

## 0.3.0-beta.133 — publication tracked separately

- Added: `lode_tools_read_chain` (CLI: `tools-read-chain <project> --input
  chain.json`), a declarative list of read-only calls run inside the server, so
  several product graph or project graph questions cost one call and only the
  rows asked for come back.
  - Steps: `read` (one call, optionally following the tool's own pages),
    `each` with `read` (one call per earlier row), `where`, `pick`, `sort`,
    `limit`, `unique`, `count`. No expressions, no code, nothing stored.
  - Inner calls can be `lode_product_graph_query` (also as `lode_product_graph`
    with action `query`) and `lode_project_graph` only. Every other tool, every
    write and every router is refused before any call. Each inner call takes
    the `lode_tools_read` route with the caller's own checks, and a chain
    changes nothing a later call may do or is given.
  - The answer counts what it holds (`total`, `returned`, `cut`, and `notSeen`
    for pages, items and calls that were not reached) and lists in
    `knownMissing` every reason something is known to be missing, including
    what the tool itself said (a list cut in the text, a check that was not
    made, a comparison that does not exist). An empty `knownMissing` means
    nothing Lode can detect was missing; it does not prove completeness.
  - A chain never returns rows from two product graph builds: every query
    answer carries `buildSha256`, and a rebuild or a baseline move between two
    inner calls stops the chain with `CHAIN_BUILD_CHANGED` and no rows. This is
    detected after the call, not prevented.
  - Bounds: 12 steps, 40 inner calls, 20 calls of one `each`, 10 pages of one
    `read`, answers from 4 KiB to 64 KiB (16 KiB by default). The answer as
    sent is never over `max_bytes`.
- Changed: product graph answers over MCP are smaller and carry data next to
  their text. Text answers, `graph.json`, `check.json` and `check.txt` are
  unchanged.
  - The structured part of an answer no longer repeats the whole text when its
    rows, header and title give it back exactly; the content text still has
    it.
  - Rows that stand for a node carry `nodeType`, `changedSinceBaseline` and,
    from the four lists the build keeps, `confirmation`. The answer says
    whether the build holds a baseline comparison and a confirmation
    comparison, also when only the first confirmation records were read
    (`partial`) or the baseline was moved after the build (`baseline-moved`),
    so an absent field is not read as "current".
  - Where the text says rows were cut, a list was shortened, or something was
    not checked, compared or read, the row or the answer carries a structured
    mark (`missing`, `continues`). A row a later page repeats from an earlier
    page carries `repeats`, so following pages gives the rows one large call
    gives.
  - `lode_tools_discover` by exact name returns a `resultShape` for
    `lode_product_graph_query` and `lode_project_graph`.
- Fixed: a `down` or `up` answer that reached the 2000-row bound exactly at the
  end of a sub-list ended without saying rows were hidden. It now ends with a
  line saying so.

## 0.3.0-beta.132 — publication tracked separately

- Added: confirmation records for the product graph (확인 기록), which say what
  was actually checked against the code, apart from the baseline.
  - `product-graph-confirm` (MCP: `lode_product_graph` action `confirm`)
    records an agent's check of 뜻 lines or of a document's code-linked rows
    as `agent-checked`; `product-graph-approve` also records the code the
    approved document described as `user-approved`. A record is written once
    under `.lode/context/product-graph/확인/`, is never rewritten or removed
    by Lode, travels with export, import and folder copies like approval
    records, and grants nothing.
  - The build adds a 확인 기록 block after the comparison with the baseline:
    확인한 적 없음, 확인 뒤 코드가 바뀜 (with the nodes and who checked when),
    확인 뒤 글이 바뀜, 다른 방식으로 읽은 때 확인함. Moving the baseline does not
    clear it. `product-graph-query changes --list <status>` pages each list,
    and the Gaps view shows the block.
  - A new record names the records it replaces for its items, so the record
    a confirm or an approval just wrote is the one that counts whatever the
    clocks say. A confirm or approval whose items are already current writes
    nothing and says so.
  - A 기능 line carries a `{뜻: …}` mark only when a check exists and no longer
    holds. With no record, every existing answer is unchanged.
  - Nothing in `확인/` can stop a build, a check, a query, a baseline move or
    an approval: an oversized, unreadable, surplus or non-verifying record is
    an issue that names it and excuses nothing. More than 2000 records are
    read in file-name order up to 2000, and the output says so. Export,
    import, folder-copy adoption and GC still refuse such a store.
  - A query reads no record body (2000 records: about 0.1 s per query). A
    record changed in place without a size change is noticed at the next
    build.
- Added: the Status view shows multi-line reasons, Session purposes, pending
  work and unknowns as headings, lists, code blocks and paragraphs (inline
  Markdown stays as written), opens referred files in a reader with line
  numbers, 80 lines a page, and shows control characters and bidirectional
  marks as `\uXXXX`.
- Fixed: approving a document when the `승인` folder name is stored decomposed
  (as macOS stores it) no longer creates a second folder.
- Fixed: lock cleanup failures (follow-up to 0.3.0-beta.131).
  - When the cleanup of the snapshot reference admission lock failed before
    the caller's operation ran, the caller was told the operation had
    returned and must not be repeated. It is now told the operation did not
    run and is safe to retry, and its registration is withdrawn.
  - A lock entry left by a failed cleanup was held until the process ended.
    The process that made it now removes it at its next attempt on that lock
    (and after 1 and 10 seconds); a retained entry never counts as the
    operation still running.
  - A mail pick-up (prompt or Stop Hook, the OpenCode plugin) whose claim
    step completed but whose lock removal failed hands the claimed mail over
    instead of dropping it; it counts as handed over only after that was
    recorded, so nothing is handed over twice.
  - A snapshot GC attempt or a participant registration left by such a
    failure is cleared by the same process at its next admission or at exit,
    instead of making every later GC yield.

## 0.3.0-beta.131 — publication tracked separately

- Fixed: a lock entry that cannot be removed no longer replaces what the
  operation did.
  - The local lock coordinators keep the operation's own result or its own
    thrown value (frozen errors and non-error throws included). When the
    entry cannot be removed after three attempts (pauses of 10 and 30 ms),
    a completed operation fails with `LOCAL_MUTATION_CLEANUP_FAILED`, which
    says not to repeat it. An empty lock folder left after the entry is
    gone (`EPERM`, `EACCES` or `EBUSY`) is not a failure.
  - Conversation send answers such a failure from the mailbox instead of a
    bare file-system error: `delivered`/`sent` only when the archive holds
    exactly one record handed over under this send's claim and attempt;
    `queued` when the message is back in the queue (a claim never offered
    to the Host is put back when the lock can be taken); otherwise
    `unknown` with the message ID. Nothing is ever handed over again.
  - Before the message is written, the send fails with the step's own error,
    or `CONVERSATION_NOT_SENT` when the step completed; nothing was sent and
    sending again is safe.
  - The pass that hands older queued mail over first stops at such a
    failure and reports it in `earlier`; the new message is not handed over
    in that send.

## 0.3.0-beta.130 — publication tracked separately

- Added: the product graph query finds by relevance, shows what changed in
  the text, and previews a proposal.
  - `find` ranks by matching words (BM25) and still puts exact ID and path
    matches first; everything the old substring search found is still found.
    New filters: `--node-types`, `--related-to <ID>`, `--edge-types`,
    `--basis-states`. Each hit shows the words that matched and the recorded
    edges next to it. The score is lexical: it is not approval, currency or
    cause. The page's search runs when typing pauses.
  - `changes --list content` shows the text before and after for the nodes
    that changed since the baseline. The "before" text is kept at baseline
    time in `build/baseline-content.json`: generated, local, git-ignored, at
    most 2 MiB, whole contents only (up to 16 KiB each) so every text shown
    is checked against the baseline's content hash. It is bound to its
    baseline: after a baseline move the question refuses until the next
    build, and a build writes the file again when it is missing or belongs
    to another baseline.
  - That text goes nowhere else. `check.json`, `check.txt`, the build and
    check replies and the exported Graph Explorer file hold none of it; they
    say how many nodes changed in content and how to ask.
  - `impact` compares three existing builds, read-only: where a proposal
    started, the current state, and the proposal applied to its start. It
    tells equal edits from divergent ones, reports delete-versus-update
    conflicts and references left to deleted UI or code, and says whether
    its basis is verified or partial. No conflict is not approval, and a
    static preview is not runtime evidence.
  - A printed next-page hint repeats the whole question with its filters,
    build folders and a hash of what the page was answered from; a later
    page is refused when that changed (`PRODUCT_GRAPH_QUERY_BASIS_CHANGED`).
    Replies carry the same as arguments in CLI names and, for a Project, in
    MCP names. A content page holds whole items only and the next page
    starts at the first one left out.
- Limits: search is by words, not by meaning; nothing is executed. Builds
  write two more generated files (`baseline-content.json`,
  `build-context.json`) and take about a tenth longer on Lode itself (5.3 s
  against 4.9 s). A baseline taken by an earlier version has no "before"
  text for nodes that already changed; move the baseline to keep it from
  then on, and a baseline read by another analysis version says so. A
  "verified" impact preview needs the three builds made in the same Project,
  which means building at the proposal's starting commit and with the
  proposal applied; the docs give the steps. The persistent parse cache the
  original proposal contained is not included: a cached build could keep a
  call edge a full build drops.

## 0.3.0-beta.129 — publication tracked separately

- Added: snapshot retention for storage GC, off unless you turn it on.
  - With no policy, `storage-gc` keeps exactly what it kept before: every
    World that refresh history names stays. Nothing changes for a project
    that sets nothing.
  - A policy file `<store>/refresh/snapshot-retention.json`
    (`schemaVersion`, `keepCount`, `keepDays`) or `--keep-count` /
    `--keep-days` for one run turns it on. Refresh history then stops
    pinning old Worlds, and a window keeps the newest `keepCount` Worlds by
    write time and everything newer than `keepDays`, whichever keeps more.
    A value that is not a usable number is a usage error; a policy file that
    cannot be used keeps everything and the output says the file is
    unusable.
  - Always kept, window or not: the current World and Graph, the World the
    pointer names as previous, the Worlds of the current refresh receipt,
    every snapshot a Capsule, ChangeSet, lineage record, checkpoint, Session
    record, knowledge decision or product-graph document names, including
    the parents such a record lists, anything named only by a hash, and any
    snapshot without a trustworthy write time (the Git object store).
  - The dry run reports what the apply would delete, under which rule, and
    which checks only the apply makes. The output says whether retention is
    off, from the project file or from this run's options.
  - A windowed apply writes a release record before it deletes anything:
    `<store>/refresh/retention-releases/retention-release-<id>.json` with
    the policy in force, the time, and the released World and Graph ids and
    hashes. Records are never rewritten or reclaimed, and a default apply or
    a dry run writes none.
  - A record that names a snapshot retention released is reported as
    "released by retention on <date>" and does not block storage GC,
    whether it is old refresh history or a record written later. A snapshot
    that is gone and that no valid release record names is still reported as
    missing, and so is the current World whatever a record says. A release
    record that cannot be read excuses nothing and is named in the output.
  - Reading an old refresh receipt whose World was released answers
    `WORLD_MODEL_SNAPSHOT_RELEASED` with the date instead of "missing".
- Limits: the release records live under `refresh/` next to the two
  rebuildable caches; the caches may be deleted, the records may not
  (without them old history looks damaged again, nothing else). An older
  Lode does not know the records and reports released history as missing. A
  copied project folder carries the policy file and the records; its write
  times are the copy's, so the window there is ordered by copy time until
  new Worlds are written. "Newest" is by the snapshot file's first write. A
  moved or re-published World keeps its old time. Not included from the
  original proposal: retention by default, a new chunked write format, and
  predicted revision parents; the first two would change what is stored or
  deleted without anyone choosing it, the third was not proven equal.
  macOS and Linux behaviour is covered by CI only.

## 0.3.0-beta.128 — publication tracked separately

- Fixed: a store whose pointer was written before `minimumReader` existed
  (the beta.80 shape: a layout this reader understands, no `minimumReader`
  or `writer`) is read again instead of `STORAGE_VERSION_MISMATCH`. Refresh
  records `minimumReader` and `writer` on the pointer only, under its writer
  lease, and keeps the World pointer's link to the Graph pointer in step.
  Storage GC reads such a pointer and leaves it as it is. Snapshot files,
  record ids, hashes and source text are not rewritten. The first refresh
  of such a store answers from a shorter comparison (sources, git head,
  product canon) and does not rebuild; the next one compares everything. An
  explicit null, an unusable or a higher `minimumReader` is still a
  mismatch, and the message says it is a version mismatch and not corrupted
  storage, also for a downgrade, and how to recover. Tested against a store
  written by the beta.80 commit.
- Fixed: snapshot GC no longer gives up when walking a large store takes
  more than 30 seconds in total. Each plain Git command keeps its own limit;
  the pack step has none and stops on cancellation. macOS APFS and HFS
  volumes qualify for collection; FAT, network and unknown volumes stay
  preserved. A dry run says when it did not open the typed backends, and it
  still reports a retained World or Graph snapshot that is neither a file
  nor a ref of the Git store. A watcher probe file left behind is not in
  its way.
- Changed: refresh does less for inputs that did not change.
  - When everything a refresh reads is as the published World recorded it,
    refresh answers `unchanged` without rebuilding the World and Graph and
    without writing a snapshot. After an edit, an untouched file keeps its
    verified digest and analysis and is not read again.
  - A file counts as untouched only by a stat (size, modification and change
    time, inode, device) taken before the read that produced its digest and
    confirmed after it. A file saved while a refresh runs is read again by
    the next refresh. A modification time without a sub-second part is not
    trusted until two seconds have passed.
  - The other inputs are recorded as they were before the scan and the build
    read anything: the project store outside snapshots, the local git head
    and refs (also in a linked worktree), the files of the snapshot stores,
    the number of files the scan skips per reason, the selected Session, and
    the analysis and plugin versions. A record saved or a commit made while
    a refresh runs, a new binary or over-size file, a lost snapshot file or
    a plugin upgrade each send the next refresh down the full path.
  - A full refresh that finds nothing changed renews that record. A build
    given its own store, projection, history, runtime state, scan or
    in-memory projection writes none and always takes the full path.
  - A refresh that would publish a World other than the previewed one is
    still refused before any pointer moves (`REFRESH_PREVIEW_DRIFT`).
- Fixed: the filesystem refresh watcher reports `ready` once the operating
  system has delivered an event for its own probe file, because macOS drops
  changes made before the stream listens. The probe has a bounded number of
  attempts and reports `not-armed` when no event arrives.
- Changed: a worker job file whose timestamps move while it is read is
  accepted only when a second read gives the same bytes and the timestamps
  have stopped moving. Changed bytes are still a conflict.
- Limits: the two files under `refresh/` are caches. Deleting them costs one
  full refresh and nothing else. A real edit still builds and stores a new
  snapshot. An unchanged answer now also stats every file of the snapshot
  stores, which costs more on a large store than the first measurements of
  this change. macOS and Linux behaviour is covered by CI only. Several
  states of this change before merge answered `unchanged` for a changed
  input (a file saved during a refresh, a commit in a linked worktree, a
  record saved during a build); they were found in review and fixed.

## 0.3.0-beta.127 — publication tracked separately

- Added: the Graph Explorer opens on where the work stands, shows the
  product graph, and an agent can ask the product graph.
  - One exported file, four views. Status comes first: what the project is
    for (marked as set by the user), Sessions with something to look at
    first, and pending work and unknowns collected across Sessions. Then the
    product graph, its gaps, and the existing map, unchanged, behind its tab
    and a link.
  - Pending work is shown as finished only when a later record of the same
    Session says so for the same item. A Session that ended, a later record
    with nothing pending, or a pass never closes it. A cancelled item has
    its own state. A record whose text arrived only in part says so.
  - The product graph is an indented tree walked one step at a time with
    the path shown: 유저 활동 → 화면요소 → 기능 → 코드 with documents, 기능 by
    kind without them. Estimates are marked on every node and edge they
    touch and never look approved. With no build the view says "없음, 빌드
    필요" and shows no sample.
  - The gaps view shows what `check.txt` says, in its order and numbers.
    "검사 못 함" never looks like "0건".
  - New options: `--view status|product|gaps|map` and `--lang en|ko`
    (default `en`). The product graph words are shown as they are in both
    languages; the map view stays English. A plain click now selects one
    record, Ctrl/Cmd or Shift adds. Light and dark follow the device.
  - `product-graph-query` (CLI) and `lode_product_graph_query` (through
    `lode_tools_call`) answer from the existing build without building:
    overview, one node, one step down or up, the code a 기능, 화면요소, 유저
    활동 or 화면 reaches or the 기능 that reach a file, find, gaps, and
    changes. Every answer starts with whether the build is still the source
    as it is now, how much of the calls resolved, and what changed since the
    baseline. Output is paged and says how much remains. The text is also
    the text board of the page.
- Added: the product graph build compares with a baseline instead of only
  replacing its output.
  - Every node carries a content hash (a declaration by the text of its
    lines, a 기능 by its kind, handling and handlers plus a second hash over
    all code it reaches). Hashes are attributes; IDs do not change. Line
    endings and moving a declaration inside its file change no hash.
  - `build/baseline.json` is taken by the first build. Later builds compare
    with it and do not move it, so building again keeps showing everything
    that changed. Only `product-graph-baseline` moves it; it refuses a build
    that is not the current source and says what the move drops.
  - The comparison uses the original's four words per node, 변화 없음 / 변경
    / 신규 / 사라짐, adds 닿는 코드가 바뀜 for a 기능 whose reached code
    changed, pairs a vanished and a new node with the same content as
    "옮겨졌을 수 있음", and names a changed rules file or reader first.
  - "다시 볼 것" lists the 뜻 lines and document rows that hang on what
    changed. It reports only: no document, 뜻 line or approval is changed,
    and an approved document keeps its approval with a mark.
  - The build still reads all source every time. What is new is the
    comparison, its result and the baseline. All new values live in the
    generated `build/` folder; builds made by 0.3.0-beta.124–126 stay
    readable, and an unknown build shape is answered with
    `PRODUCT_GRAPH_BUILD_UNREADABLE`.
- Limits: a moved or renamed file is 사라짐 plus 신규 with a hint, not one
  identity. A 뜻 line or an approval does not record what it was written
  from, so "look again" is relative to the baseline. A newly added non-code
  entry file is not seen as a stale build until the next build. On Lode
  itself the build takes about 5 seconds and the baseline is 1.7 MB; the
  exported file grows by the size of the product graph (the author measured
  20.7 MB to 23.1 MB). Not checked with a screen reader, and the light
  theme was checked by token contrast, not by eye.

## 0.3.0-beta.126 — publication tracked separately

- Changed: the product graph says what a call is, and resolves the calls a
  scan can resolve without type information. The source scan it shares
  with the World model and the project graph reads imports and members it
  missed before.
  - Imports are read whatever their layout. A JavaScript `import { … }`
    list spread over several lines was not read as bindings at all, and
    neither was a Python `from x import ( … )` list or a backslash
    continuation. On Lode itself that was about 1,500 import names.
  - Members are declarations: methods of a JavaScript or TypeScript class
    (including static, async, generator, getter, setter and `#private`),
    class fields that hold a function, classes written as expressions, an
    anonymous default class, and the function members of an object
    literal bound to a module-level name. A method definition is no longer
    counted as a call, and neither is a TypeScript signature without a
    body.
  - Calls resolved from the text alone: `this.x()` and `self.x()` inside
    the class, a static method on the class, a member of a module-level
    object, and `v.x()` where `v` is a constant created once by `new C()`.
    `new C()` reaches the class and its constructor. A name hidden by a
    parameter or a local variable is not resolved, inheritance is not
    followed, and nothing is resolved because a method name happens to be
    unique.
  - A module-level value that is called, such as
    `const fail = failWith("X")`, is a 코드 node of kind 값, and it refers
    to the calls in its initialiser.
  - Re-exports are followed to the declaration: `export { a, b as c }
    from`, `export * from`, `export { default } from`, and an export list
    that names an import.
  - Calls that cannot be product code are counted apart: members of
    built-in namespaces (`JSON.x`), built-in functions and constructors
    (`String`, `new Map`), and method names that nothing in the product
    defines. The names are a table per language that a project rule can
    extend. A call is counted as built-in only when no spelling in the
    product could define that member; otherwise it stays under "받는 쪽
    타입을 모름".
  - A call to a function held in a parameter or a local variable has a
    reason of its own, and so does a member that may be inherited.
  - The limits block gives three numbers: all calls; calls that cannot be
    product code and calls into modules outside the product; and how many
    of the calls that can be product code resolved. On Lode itself: 65,108
    calls, 20,196 that cannot be product code, 5,753 into outside modules,
    and 27,689 of the remaining 39,159 resolved. Before, the text said
    21,963 of 62,294.
  - With `"처리 코드": "항목"`, the call that performs a registration
    (`registry.register("x", run)`) is not read as the handler; its
    arguments are.
  - The Go worker's copy of the scan has the same import and member rules.
    Source analysis version 0.3.3: stored scans of earlier versions stay
    readable and are analysed again, so the next World build scans every
    file once. No stored format changes.
- Limits: there is still no type information, so 10,413 calls on Lode stay
  under "받는 쪽 타입을 모름" because their method name also exists in the
  product. Not read: members of nested or unbound object literals,
  computed and quoted member names, names created at run time, and a
  TypeScript call with explicit type arguments. Three rare inputs give
  different results in the Go and JavaScript scans and are listed in the
  pull request: a file with more than 10,000 declarations, two same-named
  members on one line, and nested declarations on one line. The shared
  scan takes about 1.5 times as long as before on Lode's repository and
  the product graph build about 1.4 times. Measured on Lode and on
  synthetic class-based code only, not on a real class-based product.

## 0.3.0-beta.125 — publication tracked separately

- Fix: the source scan no longer loses declarations and calls after text it
  misread. It is the scan behind the World model, the project graph and the
  product graph's 코드 layer.
  - Before, a template literal inside another template's `${…}`, or a
    regular expression containing a quote or a backtick, flipped the scan's
    idea of what is a string. Everything up to the next matching quote,
    sometimes hundreds of lines, was skipped. In Lode's own `scripts/`, 207
    of 3,619 top-level functions were not found, in 27 files; now 6 are not,
    and those 6 really are inside strings.
  - JavaScript and TypeScript are now read by one lexer that follows nested
    `${…}`, regular-expression literals and comments. The product graph
    already used it, so the two no longer disagree. Code inside a
    template's `${…}` is read as code. Python is read as before.
  - Generator declarations (`function* name`) are found.
  - Text inside a string, a regular expression or a template that only
    looked like a declaration is no longer reported as one.
  - When the lexer cannot trust its reading of a file (the file ends inside
    a template, a block comment or `${…}`), a character counts as code if
    either the lexer or the earlier quote scan says so, so the rest of the
    file is not dropped.
  - The Go worker's copy of the scan has the same change, and the shared
    corpus has a parity file with CRLF line ends, a non-BMP character and a
    no-break space.
  - Source analysis version 0.3.2. Stored scans of 0.3.1 stay readable and
    are analysed again instead of being reused, so the next World build
    scans every file once. No stored format changes.
- Fix (product graph, since 0.3.0-beta.124): with `"처리 코드": "항목"`, a
  table row containing a template literal with `${…}` made every 기능 of
  that table take the handlers of the whole table. The `${` that opens a
  template expression is no longer counted as a bracket.
- Limits: scanning Lode's own repository takes about 1.2 times as long as
  before. A file read with reduced confidence is listed by the product
  graph but is not marked in the World model's stored scan. On Lode itself
  the product graph now resolves 21,963 of 62,294 calls. The Go change was
  not compiled or run locally; CI builds and tests it and compares its
  output with the JavaScript scan.

## 0.3.0-beta.124 — publication tracked separately

- New: 제품 그래프 (product graph), a second description of a product next to
  the existing Product Model, which is unchanged. It starts from the
  product's user and goes down to the code: 제품코어 → 유저 활동 → 화면 →
  기능 → 코드. Definitions are in `docs/product-graph.md`, use in
  `docs/product-graph-usage.md`.
  - Store: `.lode/context/product-graph/` holds the documents people write
    (제품 정의서, 유저 저니맵, 화면설계서, 유저플로우 기획서, `정책.md`,
    `기능 뜻.md`, `호출 방식 표.json`) and approval records under `승인/`.
    Generated output goes to `build/` and is rebuilt, never carried.
  - 기능 and 코드 are read from the code by script. A 기능 is one entry
    point: a hook, a command, an MCP tool, a CLI command, or a place where
    a UI wires a user's signal to code. UI toolkits are entries of one
    pattern table, so a project adds a toolkit, a tool table or a command
    table with a rule and no change to Lode's code.
  - A tool or CLI rule can take a 기능's 처리 코드 from its own table row
    (`"처리 코드": "항목"`): a function named as a value, a call inside an
    inline function, or a member taken from a dynamic import with a literal
    path. That form of dynamic import is now followed everywhere calls are
    read.
  - The user-side nodes come only from documents. A document counts as 승인
    only while an approval record exists for its current text; a document
    changed after approval is shown as 승인 뒤 바뀜 and is not used as
    approved. The approval digest is taken over the text (one leading BOM
    dropped, line endings as LF, NFC), so another machine's line endings do
    not drop approvals; any visible change does. An approval record is the
    record of the user's word, not a security boundary.
  - `product-graph-check` prints the six consistency checks. Each ends in
    findings, `0건`, or `검사 못 함: <이유>`; a check that could not run
    never prints `0건`. With inputs missing, a short guide says what to
    write and what each input unlocks.
  - Build and check start with one block that says what the graph cannot
    answer: how the code was read, how many calls were resolved, what is
    not extracted, and how many documents are approved. They also list the
    code no 기능 reaches, unresolved calls by reason, 기능 whose 처리 코드
    was not found (with the reason), and wiring that was not taken as a
    기능.
  - Node IDs are name structure and never contain a line number. A build
    never rewrites `기능 뜻.md` or `정책.md`; a line whose 기능 disappeared
    is listed, not removed. Two builds of the same input are byte-identical.
  - Commands: `product-graph-build`, `product-graph-check`,
    `product-graph-approve`; through MCP, the grouped tool
    `lode_product_graph` via `lode_tools_call`. Build and check also work
    on a folder that is not a Lode project and then write only to the given
    output folder.
  - Portable export, import and folder-copy adoption say what they carried
    of this folder and name what they left out. Snapshot GC keeps files it
    does not recognise in this folder and names them; a broken approval
    record or a link there still stops the collection.
- Limits: the code is read by a regex scan with no syntax tree and no type
  information. On Lode itself 19,530 of 55,626 calls resolve to one
  declaration, and the list of unreached code is bounded by that. 데이터,
  외부 연결, DB, 계측 이벤트, navigate and the C4 grouping are not
  extracted. The Graph Explorer does not show this graph yet. JS/TS
  decorators above class methods are not read. The source scan shared with
  the World model misses some declarations after a nested template string
  or a regular expression containing a quote (207 of 3,613 top-level
  functions in Lode's own scripts); that is not fixed here. Not verified on
  macOS or Linux; file symbolic links were not exercised on Windows.

## 0.3.0-beta.123 — publication tracked separately

- Windows: every Hook that touches the private prompt reference
  (UserPromptSubmit, Stop, PreCompact) takes about 0.25 to 0.3 seconds less.
  - The permission helper now starts with a short command line that never
    changes. Its request and its script arrive on standard input instead of
    on the command line. On the measured machine the first child a process
    starts with a long command line takes about 0.25 to 0.3 seconds longer,
    and every Hook is a new process, so every such Hook paid that.
  - Every permission check is the same as before, nothing is remembered from
    one Hook to the next, and a failed check still stores nothing.
  - The helper runs its script only when the text it received ends with the
    script's fixed end marker. A script that arrives cut off is refused
    before any of it is parsed or run, and the operation stores nothing.
    Cutting the shipped script at each of its 7,889 incomplete lengths gave
    the same refusal every time, with no output and nothing created.
  - Measured with the real Hook process on Windows 11, before and after, on
    a quiet machine: Claude Code prompt 0.85-1.17 s to 0.63-0.68 s; Codex
    prompt 0.81-0.94 s to 0.57-0.62 s; Stop with new assistant text
    0.80-1.15 s to 0.56-0.66 s; Stop with unchanged text 0.76-1.06 s to
    0.48-0.50 s; PreCompact 0.78-0.92 s to 0.53-0.57 s. A second set on a
    busier machine was slower on both sides and showed the same difference.
    The number of helper starts per Hook is unchanged, and so is what is
    stored.
  - The Hook times with queued mail in the conversation-messaging document
    were measured again.
- Limits: measured on one Windows 11 machine. Why a long command line costs
  that time there was not established; a machine without that cost is
  expected to gain nothing and lose nothing, which was not measured. macOS
  and Linux do not use the helper. Only the Korean console code page was
  used.

## 0.3.0-beta.122 — publication tracked separately

- Windows: the UserPromptSubmit, Stop and PreCompact Hooks take about half
  as long.
  - Each prompt-reference operation (capturing a prompt, capturing the
    visible assistant text, freezing before compaction) starts the
    permission helper once instead of twice: the store directory, the
    existing file and the new temporary file are checked or created in one
    request. Every check is the same as before, nothing is remembered from
    one Hook to the next, and a failed check still stores nothing.
  - A Claude Code prompt no longer waits for its process lookup before the
    capture starts; the two run at the same time and the stored observation
    is unchanged.
  - Measured with the real Hook process on Windows 11, before and after:
    Claude Code prompt 1.7-2.3 s to 0.9-1.1 s; Codex prompt 1.3-1.7 s to
    0.8-1.1 s; Stop with new assistant text and PreCompact 1.3-1.7 s to
    0.8-1.0 s. Stop with unchanged text stays at about 0.8 s. SubagentStop
    and folders without Lode still start no helper (about 0.15 s). The very
    first operation in a new state folder needs one extra helper call.
- Windows: the private prompt reference now works when the state folder
  path contains non-ASCII characters, for example an account whose profile
  folder has a Hangul or accented name. Before, the permission helper
  received a damaged path, refused it, and no prompt reference was ever
  stored, without any message.
- Correction to 0.3.0-beta.121: the "2.3 to 2.5 seconds" given there for the
  Windows prompt Hook with no mail was measured with a substitute user
  profile, which makes PowerShell start slower. With the real profile it
  was 1.7 to 2.1 seconds.
- Limits: timings were measured on one Windows 11 machine. macOS and Linux
  do not use the helper and were not timed. The non-ASCII fix was checked
  with a state folder under Hangul, accented and emoji directory names on a
  Korean-locale console, not with a real non-ASCII account or another
  console code page.

## 0.3.0-beta.121 — publication tracked separately

- Queued conversation mail no longer waits for the recipient's next prompt.
  - Claude Code and Codex: when the recipient's main session ends a turn, its
    Stop Hook hands over mail queued for its own address and the Host
    continues the same turn with it. `SubagentStop` and subagent Stops never
    take the parent's mail. Claude Code needs version 2.1.163 or later for
    the turn to continue; on an older version the mail is recorded as handed
    over but the turn ends.
  - Lode sets no limit on how many times in a row a turn continues this way.
    Two sessions that keep answering each other keep running until a person
    interrupts them or the Host stops them (Claude Code ends the turn after
    eight Stop-hook continuations in a row).
  - A send that finds the recipient's live channel first hands over that
    recipient's older queued mail, oldest first, then its own message (at
    most 10 older messages and 3 seconds per send). The result reports
    `earlier` with `handed`, `unknown` and `queued` counts.
  - A resumed Claude Code or Codex session registers its own running process,
    so a live send reaches it instead of the process it replaced.
  - OpenCode: the plugin scans the inbox once when its watcher starts and
    delivers a session's queued mail when that session reports idle.
- One hand-over carries only as many messages, oldest first, as fit the
  Host's hook text limit (Claude Code 10,000 characters; Codex 10,000 UTF-8
  bytes, which is about 3,300 Hangul characters). The rest stays queued for
  the next Stop or prompt, and the last line says how many remain. A single
  longer message is still handed over, and the Host then shows a preview and
  a file path.
- The Stop and UserPromptSubmit Hook timeout is 15 seconds instead of 3. Mail
  is claimed only within 6 seconds of the Hook process start; later than
  that it stays queued. On Windows the prompt Hook itself already took 2.3 to
  2.5 seconds with no mail, which the old timeout barely covered.
- A mailbox lock left behind by a stopped Hook no longer makes the next
  pick-up skip its mail once.
- Limits: a live Host continuing a turn from the Stop Hook was checked
  against the Hosts' documentation and source and with the real Hook process,
  not in a live Claude Code or Codex session. Timings were measured on
  Windows only.

## 0.3.0-beta.120 — publication tracked separately

- Published work documents (Obsidian vault, Notion) are laid out for the person
  who reads them.
  - Documents sit in a tree, `Lode/<product>/<feature group>/<feature>/`, with
    one new file per result inside the feature folder. Folder and file names
    are readable titles instead of hashes. Product, group and feature folder
    documents carry the lists; there are no per-task start or notes documents.
  - Human documents no longer contain management lines (identity lines,
    markers, basis hashes, internal ids). That information is in a separate
    evidence document an agent can open, and the human document links to it.
  - `lode_work_document_prepare` accepts `feature_keys`. A feature the user
    named wins; otherwise the agent picks among the Product model's features.
    A result with no known feature goes to `소속 미확인/` and the rejected
    keys are reported.
  - Publications made with the earlier layout are not rewritten or moved. The
    old start document receives one link to the new tree. Renaming or moving a
    feature in the Product model never moves existing folders.
  - A document a person edited is not overwritten: only Lode's own lists in it
    are updated and the edit is reported. A document brought back to exactly
    Lode's text is Lode's again.
- A failed write no longer stops later publications.
  - Obsidian files: a create or update whose outcome is unknown is settled by
    looking at the file. Absent or still the old text: written again. Lode's
    text: adopted. Any other content: treated as the person's file or edit
    and left alone. This replaces "never write again" for vault files only.
  - Notion keeps the rule that the same unverified change is not sent again.
    A page update whose outcome is unknown now holds back only its own
    document, reported as `update-unconfirmed`, while the rest of the
    publication goes on; the next publication that wants a different text for
    that document sends a new change made from the page as it is.
  - Limits: a Notion document whose wanted text never changes again stays
    `update-unconfirmed` and is reported on every publication. A Notion create
    whose outcome cannot be confirmed is reported with its recovery limit and
    has no way out yet. Notion behaviour was exercised against a synthetic
    server only, not against the live service.

## 0.3.0-beta.119 — publication tracked separately

- Managed files whose only difference from the recorded bytes is their line
  endings (for example after a checkout that converted LF to CRLF) are restored
  by explicit resume, also for a Project whose folder moved. Before, such a
  Project read as drifted and a moved one could not be relocated.
  - Read-only status names the step: `core_drifted` with `byteRepair` and the
    next action `resume_line_ending_repair` for a Project that did not move;
    `relocation_available` (`PROJECT_RELOCATION_AVAILABLE`) with
    `projectLocation.byteRepair` for a moved one. Status and conversation
    entry write nothing. The resume result reports what it restored in
    `byteRepair`.
  - When a managed file changed beyond line endings or is missing, nothing is
    repaired, moved or not: resume refuses with `PROJECT_NOT_READY` naming
    those files, and conversation entry for a moved Project answers the same
    code with the next action `review_managed_projection_drift`.
  - Status and conversation entry for a moved Project now answer
    `relocation_available` for every caller, including a Claude Code call that
    no hook prepared. Before, entry answered `NOT_INITIALIZED` there. Mutating
    tools still answer `NOT_INITIALIZED` until resume adopts the new location.
- After onboarding is `ready`, Product Canon changed by a reviewed and applied
  document change or by an accepted Product Policy review keeps the ready
  family in status and conversation entry. Before, any Canon other than the
  onboarding base read as `ONBOARDING_PRODUCT_CANON_DRIFT`.
  - The reviewed changes recorded after the onboarding base must lead, one
    after another, from the base to the Canon on disk, each used exactly once.
    `productCanonLineage` lists the steps; the onboarding pointer is not
    rewritten and no stored record format changed. Reviewed reverts
    (A→B→C→B, A→B→A→B) are recognised.
  - Still drift: a Canon edited by hand (including one restored by hand to an
    earlier reviewed result, or to the base while the reviewed changes end
    elsewhere), a change reviewed but not applied, an accepted Product Policy
    review whose Canon write did not complete, and changes that do not start
    from the base. Records that cannot be read or verified report
    `ONBOARDING_PRODUCT_SUCCESSOR_UNVERIFIABLE`.
  - Limits: a hand edit that writes exactly the latest reviewed result cannot
    be told from the reviewed change. World snapshots are local and untracked,
    so on a fresh clone it is unknown which changes precede the base: Canon
    equal to the base then reads ready as before, and a Project with changes
    recorded before its base whose Canon differs from the base reads as drift.

## 0.3.0-beta.118 — publication tracked separately

- On a case-insensitive filesystem, a root whose directory names differ from
  the recorded Project root only in letter case now reaches that Project (MCP
  `project_root`, CLI root, the `cwd` a Host passes to hooks, the OpenCode
  plugin directory). Before, status offered relocation and other operations
  answered `NOT_INITIALIZED`.
  - The on-disk spelling is looked up only after the Project was not found as
    given, and the request then runs once more with the recorded spelling. A
    Project found as given costs no extra read. Nothing stored is rewritten.
  - A moved Project, and a folder renamed to another letter case after it was
    recorded, are still reported as relocated.
- A new Claude Code conversation in a Project with exactly one Session gets
  that Session's saved direction from one `lode_conversation_enter` call
  (two calls before). No binding is written.
  - The SessionStart Hook still selects nothing; it reports
    `reasonCode: SINGLE_SESSION_ENTRY_AVAILABLE` and names
    `lode_conversation_enter` as the next call. The Skill entry table has a
    row for it. The start context is 52 characters longer.
  - The same applies to a Claude Code call that the PreToolUse hook did not
    prepare.
  - With two or more Sessions, or a binding that is lost, pending, corrupt or
    locally unconfirmed, the result is unchanged: the user chooses. A
    conversation answered without a binding must choose a Session once a
    second Session exists.
- `scripts/audit-metrics.mjs` follows the state each step returns when it
  counts resume calls; `docs/rule-surface-audit.md` is re-measured.

## 0.3.0-beta.117 — publication tracked separately

- On Windows, a Host that hands Lode a project folder with a lower-case drive
  letter now reaches the Project recorded with the upper-case one. This covers
  the Claude Code and Codex hook `cwd` (session start context, prompt, stop and
  compaction observations, Codex fork links), OpenCode's `directory` (context,
  observations, conversation messaging) and the `native_project_root` the
  Claude Code tool hook passes. Nothing stored is rewritten, and a moved
  Project is still reported as relocated.
  - Directory-name case is unchanged, and a folder that is not a Project yet is
    still compared by the spelling it was given.
- New `scripts/audit-metrics.mjs` prints the rule-surface numbers: always-read
  instruction size, prohibition phrases, tool counts, `tools/list` size, and
  the calls for save, resume and delegation. It prints only and sets no limits.
- `docs/rule-surface-audit.md` and `docs/original-head-core-comparison.md` are
  rewritten for the current state. The comparison is against the current
  original repository and records what Lode added and why.

## 0.3.0-beta.116 — publication tracked separately

- On Windows, an MCP `project_root` or CLI root whose drive letter is
  lower-case is the same Project as its upper-case recorded spelling. Before,
  status offered relocation and other operations answered `NOT_INITIALIZED`.
  Nothing stored is rewritten, and a moved Project is still reported as
  relocated.
  - A Project recorded with a lower-case drive letter is still reached only by
    its recorded spelling. Directory-name case and the `cwd` a Host passes to
    hooks are unchanged.
- Added a read-only reason-code audit (`scripts/audit-reason-codes.mjs`,
  `docs/reason-code-audit.md`) with merge candidates for a later decision. No
  behaviour change.
- `scripts/lib` modules now live in layer directories (`core`, `storage`,
  `world`, `session`, `runtime`, `worker`, `distribution`) listed in
  `scripts/lib-layers.json`. `scripts/lib/head-core.mjs` and
  `scripts/lib/lode-artifact-composition.mjs` keep their paths.
  - A test keeps imports from gaining a higher layer or a static cycle, with a
    shrink-only list of today's exceptions (147 static, 30 dynamic). Strict
    layering is not reached yet.
- The Conformance disposition MCP schema accepts `actor: "lode"` (`"head"`
  remains an alias).

## 0.3.0-beta.115 — publication tracked separately

- On MCP, a caller the Host has verified may omit `expected_direction_id` on
  `lode_project_direction_update` once one of its results has shown it the
  current common direction: `lode_project_status`, `lode_conversation_enter`,
  `lode_project_initialize_or_resume`, or its own direction update. The server
  holds that direction id per caller and Project, in memory only.
  - `lode_checkpoint_basis` and a created save show only the direction id, not
    the direction, so they do not set it. A direction conflict drops it, and
    with nothing held an omitted id still means no current direction.
  - Explicit values (including `null`), unverified callers and the CLI are
    unchanged.
- A verified caller's own direction update no longer makes its next id-less
  `lode_checkpoint_sync` conflict, which replaces the 0.3.0-beta.114 behaviour.
  When that update is the only change since a held basis, the server re-arms
  the held basis of each of that caller's Sessions in the Project, in memory
  only. Any other change in between is still a conflict.
- In Claude Code, the `PreToolUse` helper now also prepares caller
  verification for `lode_project_direction_update`. It is best-effort: when
  preparation fails, the call behaves as in earlier versions.

## 0.3.0-beta.114 — publication tracked separately

- On MCP, a caller the Host has verified that enters through
  `lode_conversation_enter` (ready) or `lode_project_initialize_or_resume`
  saves recovery direction with one `lode_checkpoint_sync` and no
  `expected_recovery_basis_id`: the first save after entry no longer needs
  `lode_checkpoint_basis`. The server holds the basis it read for that entry,
  in memory only and never in the result.
  - A `conflict` or `deferred` outcome drops it. The caller's own direction
    update, or a Run or review change, makes the next id-less save conflict;
    read `lode_checkpoint_basis` (or enter again) and derive afresh.
- The held recovery basis no longer expires after one hour; only the size
  bound (1024 entries) remains. A held basis that is no longer current
  conflicts on use.
- Only the native bridge can supply a held basis, one request at a time. A
  `recoveryBasisMemory` option that an embedder passes to `dispatch()` is
  ignored with or without a bridge.

## 0.3.0-beta.113 — publication tracked separately

- On MCP, a caller the Host has verified can save recovery direction with one
  `lode_checkpoint_sync` and no `expected_recovery_basis_id`, after
  `lode_checkpoint_basis` or a `created` sync. The server keeps the basis it
  last handed that caller for the same Project and Session and uses it exactly
  as if it were passed, so the conflict check is unchanged.
  - The held basis is in memory only (up to 1024 entries, one hour each). A
    `conflict` or `deferred` outcome drops it.
  - With nothing held, the call is refused with the new reason code
    `RECOVERY_BASIS_NOT_HELD`, which names `lode_checkpoint_basis`. Nothing is
    written.
- Explicit ids, unverified callers and the CLI behave as before.

## 0.3.0-beta.112 — publication tracked separately

- `docs/mcp-surface.md` now says that a field only another action uses is not
  used by the selected action: most operations ignore it and some refuse it
  (for example `lode_project_bundle`). It also says that the `PreToolUse`
  matchers cover the deprecated names of effectful or Session-bound operations
  only.
- `verify-conversational-onboarding` reports the grouped tool and action it
  called, for example `lode_context (action: prepare)`.
- Tests: a missing Hook correlation now fails with a readable assertion, and
  discovery asserts that `lode_projection` is the only tool listed under more
  than one prefix.

## 0.3.0-beta.111 — publication tracked separately

- Hints in tool results name the grouped tool and its action instead of a
  deprecated name. Structured hints are callable as returned
  (`mcpTool: "lode_onboarding"` with `mcpArguments: { action: "guide" }`;
  `{ tool: "lode_session", arguments: { action: "work_read", … } }`), and prose
  hints read `lode_session (action: work_read)`.
- The doctor `MCP:` line shows the action.
- World status `boundedDetailTools` is now a list of `{ tool, arguments }`
  entries instead of tool-name strings. They name the tool and action; the
  caller still adds `project_root` and the query.
- The deprecated names still work until 0.5.0. Only what hints say changes.
- The `recovery-workflow` Skill reference names the routed
  `lode_project_native_history` operation and its actions, and states that
  Codex takes `runtime_root` only for register. It also restates that
  `lode_checkpoint_diagnose` makes no model call, writes no lock or cache and
  is not a per-turn check.

## 0.3.0-beta.110 — publication tracked separately

- The `conversation-ux` Skill reference is rewritten as procedures: when to
  read it, numbered steps, and what to do on failure. It shrinks from 23,729 to
  11,972 characters, and strong prohibitions ("never", "do not", "must not",
  "cannot") go from 50 to 6. Tool order and arguments are unchanged.
- Product-evidence detail now links to the docs that define it, and silence is
  named as a non-answer for protected decisions.
- The `recovery-workflow` Skill reference is rewritten as procedures. It shrinks
  from 13,014 to 8,907 characters, and strong prohibitions go from 36 to 4. The
  checkpoint, compaction, native-history and handoff procedures are unchanged.
- Detail now links to the Project portability and Session restore docs.
- The `runtime-composition` Skill reference is rewritten as procedures. It
  shrinks from 19,581 to 13,539 characters, and strong prohibitions go from 31
  to 8. Tool order and arguments of the delegation, plan-preservation,
  `wait_threads`, handoff, messaging and managed-execution procedures are
  unchanged. Some examples and "no new ritual" sentences are removed or
  softened.
- The adapter architecture now links to the runtime adapters and architecture
  docs.
- The `project-discovery` Skill reference is rewritten as procedures. It shrinks
  from 12,511 to 10,487 characters, and strong prohibitions go from 21 to 4.
  API detail now links to the graph discovery doc.
- Across these four core Skill references, the text goes from 68,835 to 44,905
  characters and strong prohibitions from 138 to 22.

## 0.3.0-beta.109 — publication tracked separately

- The always-loaded Lode guidance is rewritten as an entry paragraph and six
  behavior statements. This is the text in the generated `lode-instructions.md`
  and in a project's managed `AGENTS.md` / `CLAUDE.md`. It shrinks from 8,381 to
  2,301 characters, and "never" / "do not" go from 13 to 1. Existing Projects
  receive the new text when they converge to this version.
- The entry paragraph is also the MCP server `instructions` and the startup
  `coreGuidance`. It grows from 749 to 822 characters.
- The guidance now says when to open a Run: only for persistent ownership,
  recovery after interruption, tracking effects with unknown outcomes, or
  preventing duplicate integration. Run behavior is unchanged.
- Instructions that apply to one procedure are no longer always loaded. They
  remain in the Skill and its references.

## 0.3.0-beta.108 — publication tracked separately

- MCP discovery and the managed tool list now group the remaining routed
  operations per resource behind an `action`. There are 21 new grouped tools,
  among them `lode_product`, `lode_metric`, `lode_projection`, `lode_compact`
  and `lode_observation`. The listed catalog shrinks from 130 to 50 tools and
  the managed tool list from 133 to 53. The default tool list of 22 is
  unchanged.
- The 101 replaced operation names (and their `head_*` spellings) remain
  callable directly and through the routers until 0.5.0. `docs/mcp-surface.md`
  maps every action to its deprecated name. Some operation results still name
  the next tool by its deprecated name.
- Discovery prefix counts are now the number of tools each prefix returns.
- Docs and Skills name the grouped tool and action.

## 0.3.0-beta.107 — publication tracked separately

- Tests and verification scripts no longer pin the wording of instructions,
  documentation, Skills and tool descriptions. Structural checks remain:
  generated output equals the committed files, links and anchors resolve,
  English and Korean documents have the same structure, and tool names and
  schemas match the operation contract.
- The documentation link and English/Korean structure check now runs in CI.

## 0.3.0-beta.106 — publication tracked separately

- The native Claude Hook helper `lode_session_host_request_prepare` is no longer
  listed in `tools/list` or the catalog, and discovery and the routers do not
  reach it. The default tool list has 22 tools (was 23) and the listed catalog
  130 (was 131). The bundled PreToolUse Hook still calls the helper, and a
  model's direct call is still refused with `NATIVE_HOOK_INGRESS_REQUIRED` or
  `NATIVE_HOOK_DIRECT_INGRESS_REQUIRED`.
- Claude Code calling an unlisted tool from a Hook was confirmed only for
  `UserPromptSubmit` on Claude Code 2.1.317, not for `PreToolUse` or other
  versions. If a Host refuses it, native Session linkage falls back to the
  caller-unavailable path, as on a client without Hooks.

## 0.3.0-beta.105 — publication tracked separately

- MCP discovery groups operations per resource behind an `action` enum, starting
  with `lode_bounded_worker`, `lode_bounded_worker_job` and
  `lode_bounded_worker_wave`. A grouped call is rewritten to its member
  operation before any check, so results, errors and effects are unchanged. The
  default tool list of 23 is unchanged; the listed catalog shrinks from 144 to
  131 tools.
- The replaced names (`lode_bounded_worker_prepare` …
  `lode_bounded_worker_wave_abandon`, and their `head_*` spellings) remain
  callable directly and through the routers until 0.5.0. Discovery lists them as
  `deprecatedAliases` and no longer shows them as tools.
- New `docs/mcp-surface.md` maps every grouped action to its deprecated name;
  `node scripts/generate-mcp-surface-docs.mjs --check` keeps it current.
- The `lode_tools_call` description points to `lode_tools_read`.

## 0.3.0-beta.104 — publication tracked separately

- `.lode` projects head the derived knowledge-graph index "LODE Agent derived
  knowledge graph", the same string `.head` projects write since 0.3.0-beta.102.
- A Markdown projection stored with the earlier heading of its dialect ("Lode
  Agent derived knowledge graph" for `.lode`, "HEAD Agent derived knowledge
  graph" for `.head`) is reported `stale` with `staleReason:
  "earlier-index-heading"` while its graph is unchanged, instead of failing as
  semantically divergent. The next `world-docs-build` rewrites it; stored
  records are not migrated.

## 0.3.0-beta.103 — publication tracked separately

- The detached worker owner's failure line in `stderr.bin` names the failing
  file operation (`syscall`, `path`, `dest`, `errno`) and its stack, so an
  intermittent filesystem error can be located.
- The concurrent presence-rewrite test is bounded to 40 rewrites per process so
  it checks the rename race rather than lock starvation on a slow runner.

## 0.3.0-beta.102 — publication tracked separately

- Source code names wire protocols, record kinds and stored values by their Lode
  spelling; the legacy `head-*` spellings come from inverse tables in
  `compat/head/format.mjs`. Bytes written to disk are unchanged for both the
  `.lode` and the `.head` dialect, and either spelling is accepted when a record
  is read.
- The stored review field `freshHeadReviewRequired`, the canon coverage values
  `curated-head-canon(-only)` and the Todo origin `head-proposed` gain Lode
  spellings (`freshLodeReviewRequired`, `curated-lode-canon(-only)`,
  `lode-proposed`). `.lode` projects write the new spelling, `.head` projects keep
  the old one, and readers accept both. `lode-proposed` is added to the Todo
  origin input enum. Forward compatibility is not kept: a `.lode` project written
  by this version is not fully readable by 0.3.0-beta.101 or older, which rejects
  the new execution-authorization field and reports `lode-proposed` Todos as
  unavailable. `.head` projects are unaffected.
- The derived knowledge-graph document written by `.head` projects is headed
  "LODE Agent derived knowledge graph".

## 0.3.0-beta.101 — publication tracked separately

- Runtime error and guidance messages call the agent Lode instead of HEAD. The
  `.head` project heading "HEAD Agent derived knowledge graph" and the fixed
  Codex proposal instructions are unchanged.
- Reported statuses, actions and guidance values use the Lode name (for example
  `lode-selection-required`, `refresh-lode-assessment` and `Lode-owned`). The
  CLI presentation still accepts the old status spellings.
- The CLI command is `lode-continuity`; `head-continuity` remains an alias.

## 0.3.0-beta.100 — publication tracked separately

- Reason codes no longer spell the old product name: `HEAD_X` is now `X`, and
  the inner `_HEAD_` segment is dropped from nine more codes. For one version,
  MCP `error.data` and CLI JSON failures also carry the old code as
  `legacyReasonCode`. `UNSUPPORTED_GC_GIT_HEAD` (Git HEAD) and the `HEAD_*`
  environment variables are unchanged.
- These values now use the Lode name: compaction status `lode_direction_required`,
  context-workflow next action `lode_assess_semantic_sufficiency`, and context
  workflow and preparation status `ready_for_lode_semantic_assessment`.
- Docs and Skills use the Lode names; the historical comparison marks HEAD as the
  old name. Hook matchers still cover the legacy `head_*` aliases.

## 0.3.0-beta.99 — publication tracked separately

- Make the canonical `lode_*` name the internal operation name. The 147
  operation descriptors live in `scripts/lib/lode-operation-contract.mjs`; tool
  descriptions say "Lode" in the source instead of being rewritten when listed.
  `head_*` names are still accepted as one-way aliases on MCP and the router, and
  `tools/list`, discovery, hooks and the CLI output are unchanged.
- Reduce `compat/head/public-names.mjs` to the one-way legacy alias rule plus the
  environment and discovery-prefix tables. `.head/` project readers are unchanged.

## 0.3.0-beta.98 — publication tracked separately

- Dispatch every CLI command through the operation registry. `scripts/lode.mjs`
  no longer has per-command branches; CLI-only commands are registry entries
  without an MCP tool, and multi-name commands use registry aliases. Help,
  version and error output are unchanged, and no call changes.
- Record the `caller` stand-in and the document prepare/publish commands in the
  dispatch recordings; refuse an implementation call on a handle-only entry
  explicitly.

## 0.3.0-beta.97 — publication tracked separately

- Dispatch every MCP tool through the operation registry, which is now also the
  MCP tool list. The ternary dispatch chain in `mcp-server.mjs` is gone; the
  last 32 MCP operations moved with their adapters, `project_status` and the
  conformance trigger tools as explicit handlers, and the 4 MiB `world_model`
  response cap as a registry field checked at the same point. No behavior change.
- Generate the Claude hook matcher from the operation registry and read the
  declared `project_root` schema from it. CLI command branches remain until the
  next release.

## 0.3.0-beta.96 — publication tracked separately

- Dispatch 44 more operations through the operation registry (111 of 144):
  project direction, onboarding, product policy and operating loop, conformance
  reads, source and context, session recovery reads, world and GraphDB status,
  document change reads, conversation entry, the compaction lifecycle step and
  observation prepare/collect. Host values reach them through the call context
  on the same surface as before; no behavior change.
- Record the host values, the `=== "true"` option branches and the option-built
  CLI inputs in the dispatch recordings with identifiable stand-ins.

## 0.3.0-beta.95 — publication tracked separately

- Let operation registry entries declare per-surface `before`/`after` adapters.
  The explicit MCP confirmations, the compact MCP results and the prepared-input
  view now run through them, in the same order as before, with no behavior change.
- Dispatch run start, release observation, feature mapping, onboarding review,
  Markdown projection build, bounded-worker status/prepare/start, runtime
  authorization read, product initiatives, observation ingest/derive and
  conformance proposals through the registry (67 of 144). The shared adapter
  helpers live in `scripts/lib/dispatch-adapters.mjs`.
- Record each refused MCP confirmation in the dispatch recordings and assert the
  derived-Observation confirmation refusal directly.

## 0.3.0-beta.94 — publication tracked separately

- Dispatch the measurement, delivery, release status, refresh receipt/status and
  observation read/query/sources operations through the operation registry (50
  of 144), with no behavior change on either surface.
- Record numeric edge limits and the `--include-execution false` case in the
  dispatch recordings, and match entry states in the documented-flow check as
  whole tokens of the core Skill's entry table.

## 0.3.0-beta.93 — publication tracked separately

- Dispatch the checkpoint, compaction, graph-lineage, change-set and
  lineage-read operations through the operation registry (32 of 144), with no
  behavior change on either surface.
- Keep the shared session work evidence schema fragments in
  `scripts/lib/tool-schemas.mjs`, used by both the MCP server and the registry.
- Record numeric wait timeouts and an unsupported JSON input field in the
  dispatch recordings, drop the CLI imports the registry made unused, and match
  entry states against the core Skill's entry table in the documented-flow check.

## 0.3.0-beta.92 — publication tracked separately

- Add `scripts/lib/operation-registry.mjs`, one registry that the MCP server and
  the CLI both dispatch through. The bounded-worker job, dispatch and wave
  operations are the first fifteen to use it; every other operation keeps its
  existing branch, and no call or tool definition changes.
- Pin which library call every MCP tool and CLI command makes in
  `test/fixtures/dispatch-recordings.json`, checked by
  `test/dispatch-recordings.test.mjs`.
- Add `scripts/verify-documented-flow.mjs`, which runs the README first-request
  flow through the CLI and MCP on synthetic projects and requires the same
  `status`, `reasonCode` and `nextAction` on both; the docs now name the flow's
  result statuses. CI runs it.

## 0.3.0-beta.91 — publication tracked separately

- Add shared `scripts/lib/core/` helpers for SHA-256 digests, canonical JSON,
  errors and reason codes, atomic writes and path-escape checks, and move the
  duplicated local helpers in `scripts/lib` onto them. Digest bytes, messages,
  codes and file effects are unchanged; a lint test keeps raw `createHash`,
  `renameSync` and local digest helpers out of the library.
- `REASON_CODES` in `scripts/lib/core/errors.mjs` lists the reason codes used as
  `code`/`reasonCode` values or fail/error call arguments; a test keeps it in
  sync with the code.

## 0.3.0-beta.90 — publication tracked separately

- Format every JavaScript source once with Prettier 3.9.10 (`printWidth` 160,
  otherwise defaults). JSON, Markdown, text and test fixtures keep their bytes.
  `.prettierrc`, `.prettierignore` and `.editorconfig` record the style,
  `npm run format` / `format:check` pin the version through npx without a
  dependency, the JavaScript CI job checks formatting, and
  `.git-blame-ignore-revs` hides the formatting commit from blame.
- Add `scripts/compare-test-baseline.mjs`, which diffs the failing-test sets of
  two TAP runs so a branch is judged by new failures against its base rather than
  by the absolute count on machines where some suites always fail.

## 0.3.0-beta.89 — publication tracked separately

- Turn the Lode Skills into an entry procedure. The core Skill opens with a
  table from the entry state (`conversation_ready`, `session_selection_unresolved`,
  `conversation_recovery_unavailable` with `NOT_INITIALIZED` or
  `PROJECT_RELOCATION_*`, MCP `error.data.reasonCode`) to the call to make and
  how to use its result; authority doctrine becomes one-line rules that link
  `docs/lode-constitution.md`. The conversation Skill maps result fields to the
  sentences they produce, and the onboarding Skill lists every `nextAction` value.
- Emit `node <plugin-root>/scripts/lode.mjs …`, the entry point every install
  has, as `nextAction.entrypoint.cli` and in readiness hints; CLI help explains
  the optional `lode-agent` launcher spelling.
- Generate the PreToolUse matchers in `hooks/claude.json` from the tool catalog
  (`scripts/generate-claude-hooks.mjs`, `--check`), verified byte-for-byte by a
  test. The matcher is built from the full catalog, so the Hook now also runs on
  `lode_tools_read` / `lode_tools_call` and the other router and discovery tools.
- Add `docs/glossary.md` (and Korean), open the README with what/why, the two
  installs, the first request and the glossary, and document the required keys
  and formats for `session-create --new-session`, `checkpoint-sync` and
  `session-work-record --input`. Their validation errors name the offending key
  or expected format; reason codes are unchanged.

## 0.3.0-beta.88 — publication tracked separately

- Enforce the declared `project_root` argument of every MCP tool before dispatch.
  A missing, empty or non-string root is refused as `INVALID_TOOL_ARGUMENTS`
  instead of silently meaning the server's current directory or surfacing a Node
  `TypeError`; routed calls are checked after the router's own shape and
  read-only checks. Every other argument rule keeps the operation's own refusal,
  identical on the CLI and MCP paths.
- Keep library reason codes on MCP errors as `error.data.reasonCode`, so an
  agent can branch on the documented code rather than on message text.
- Report a folder holding a Lode Project recorded for another root as an
  existing Project in conversation entry and the SessionStart Hook
  (`PROJECT_RELOCATION_AVAILABLE`/`PROJECT_RELOCATION_PENDING` with the explicit
  resume as next action), matching `status`. Implicit readers still adopt
  nothing. Session work reads on an uninitialized folder fail as
  `NOT_INITIALIZED` rather than a raw legacy-path `ENOENT`.
- Make `lode_session_list` directly callable from the default catalog (23
  tools), since unresolved entry names it as the discovery call. The onboarding
  guide answers `provide_product_evidence` on an initialized Core project
  instead of repeating `initialize_or_resume`. Withheld root-instruction notices
  no longer print `undefined`.
- Document that instruction linking creates a missing CLAUDE.md/AGENTS.md with
  only the link block, and that a copy whose records prove their origin is
  adopted as a relocation on explicit resume.
## 0.3.0-beta.87 — publication tracked separately

- Apply the existing controlled cleanup clock to the two remaining semantic
  clean-close fixture tests. Preserve the real native EOF/exit/tree/PID proof,
  production grace policy and forced/uncertain/nonzero negative tests.
- Add bounded test-only filesystem event and delivery diagnostics without changing
  the actual write, five-second bound, production watcher or success assertions.
  Repeated macOS timeout cause remains unestablished.
- Add Project documentation with linked human and agent views of actual Product,
  nested feature groups and multi-parent feature membership. Keep shared work and
  decisions linked once, unknown membership explicit, and narrative bound to its
  original sources.
- Share destination identity and bounded publication progress across Sessions;
  preserve existing task documents, personal notes, stable pages and reading history.
  Project scope is opt-in and meaningful analysis needs no Todo.
- Continue large hierarchies beyond 65 pages without restarting completed prefixes.
  Retain unknown effects and exact rejected-write retry boundaries. Multi-call lost-
  create searches report candidates, never current global uniqueness or auto-binding.
- Expose the same Project document Core through typed MCP, CLI and Skill.
  Synthetic vault/HTTP tests do not qualify live Notion or local app loading.

- Reuse exact unchanged reading views and their existing history links across
  unrelated publications. Preserve source, direction and pending-repair identity;
  real source changes still create history and user edits remain drift.

- Stabilize the existing post-clean-close cancellation test with its controlled
  cleanup clock, preserving real EOF, exact exit, PID absence and forced-close
  rejection. Production grace policies and failure predicates are unchanged.

## 0.3.0-beta.82 — publication tracked separately

- Prepare human explanations and agent Markdown from the same exact selected work
  originals, preserving reasons, conditions, actual changes and unknowns. Existing
  work needs no Product onboarding, World rebuild, Run or Todo adoption.
- Connect user-selected Notion and Obsidian destinations to scoped task results.
  Keep stable start links, separate personal notes and immutable reading revisions;
  current links describe the last verified publication, not task or deployment success.
- Preserve HEAD's rich evidence, comparison, quotation and related-record selection
  on exact retries. Keep successful original work saves independent of publication
  failures and continue missing selection through the existing CLI/MCP conversation.
- Recover verified synchronous Notion 403 restricted-resource rejections through an
  explicit identical-request successor, retaining prior attempts and causes. Unknown
  effects, lost responses, async failures and failed rejection saves never authorize
  another write. Preserve user edits and keep publication evidence outside P2 direction.
- Validate 206 affected regression tests, nine independent synthetic review groups
  and four documentation/distribution validators. Live Notion and Obsidian GUI
  qualification remain unperformed; the earlier full-suite local timeout remains
  incomplete. CI and marketplace publication results must be checked separately.

## 0.3.0-beta.81 — publication tracked separately

- Quarantine malformed conversation records without rewriting their original
  bytes or blocking neighboring messages. Revalidate and consume each caller
  ticket before enqueue; uncertain sends cannot reuse that consumption.
- Preserve the selected standalone Claude launcher across upgrade/rollback,
  without a new environment-variable setup step. Keep root instruction/config
  creation explicitly optional across CLI, MCP and distribution setup, including
  later opt-in, while retaining independent file-ownership choices.
- Bind hook trust observations to the same exact state entry; unsupported plugin
  identities remain unverified and never block ordinary work. Project-local
  distrust does not imply user/system hooks are disabled.
- Keep readable graph summaries while restoring complete exact raw diff paging.
  Respect explicit storage-tracking choices and declared minimum reader versions.
- Reduce duplicate GC reference calculations and share its existing deadline.
  Referenced history remains retained; zero reclaimed bytes can be successful.
  macOS physical GC remains unsupported, with explicit zero-effect coverage.
- Run the full JavaScript suite on all three CI hosts, isolate synthetic paths
  and Git configuration, and rebuild automatic Go fixtures from current sources.
  Keep externally prepared CI fixtures caller-owned. No live Host/MCP reload is implied.
- These changes correct the audit paths; they do not claim a complete live-app
  review of historical merge 404d662 or general repository-speed improvement.

## 0.3.0-beta.80 — publication tracked separately

- Include eligible exact retained source originals cited by the selected Session
  in the default portable export, with a references-only alternative and explicit
  per-reference omissions. Preserve raw bytes, identities and current target direction.
- Connect fresh and existing same-Project import, resume and re-export to exact
  CLI/MCP/Explorer historical diffs through verified admission/Session receipts.
  Unrelated source-bundle inventory limits do not hide imported exact originals.
- Reject duplicate and escaped-equivalent JSON keys at every raw object depth,
  including structural response frames. Keep normal BOM/whitespace/CRLF/Unicode
  bytes unchanged; fixed included-original conflicts cannot become omission success.
- Validate manifest capabilities through historical ownership proofs. Keep older
  bundles readable with honest source coverage and ordinary source/Git query behavior.
- Targeted synthetic and independent review passed. Physical symlink escape,
  exhaustive filesystem races, actual GUI/native-app continuation and performance
  remain unqualified. Git-only source collection remains separate; no new Git fetch
  or execution/recovery authority is introduced by this transfer.

## 0.3.0-beta.79 — publication tracked separately

- Publish all selected OpenCode sessions, messages and parts in one transaction
  through the qualified offline adapter. Preserve originals and reject global ID
  collisions without upsert, partial publication or automatic uncertain replay.
- Bind the official Windows x64 baseline 1.19.5 binary and the observed isolated
  schema/migration set; preserve existing Project mappings and target settings.
  Validate known message/part fields, existing ancestry and actual SQL ordering.
- Fix independent-review counterexamples for cross-Project parents, existing
  cycles, ordering-key drift, unrepresentable nested Session fields and hidden
  schema objects. Keep read-only clients usable and report writer contention.
- Relevant local tests passed 106/106. A separate independent CLI/MCP test and
  official isolated SQL reads checked 2 sessions, 63 messages and 63 parts; these
  are distinct evidence. Claude version/SDK synthetic reads were also exercised.
  GUI picker, native continuation, real user databases and model calls remain
  unqualified. No ordinary-profile fallback or default CLI bootstrap is enabled.

## 0.3.0-beta.78 — publication tracked separately

- Add a readable, digest-bound HANDOFF to selected Project/Session bundles and
  standalone inspection without provider startup or recovery-authority promotion.
- Connect same-platform Claude raw-history capture/restoration and optional SDK
  reading, with preflight conflicts, exact readback and no replay of uncertain effects.
- Add OpenCode Host-export and isolated import/readback interfaces. Keep the
  default CLI bootstrap unavailable until qualified; no ordinary-profile DB writer.
- Preserve source originals, current target authority and existing Codex behavior.
  Cover companion aliases, whitespace JSONL, exact-case IDs and partial failures.
  Local implementation and independent integration review passed; actual official
  client/SDK app tests, picker visibility and model continuation were excluded.

## 0.3.0-beta.77 — publication tracked separately

- Integrate same-project conversation messaging with read-only discovery,
  Host-registered destination binding and exclusive caller-ticket consumption.
- Keep unconfirmed handoffs unknown without automatic redelivery; reuse the
  existing Go supervisor for owned Codex proxy cleanup. Preserve ordinary
  work, current P1–P5 authority and Project/native-history portability boundaries.
- Preserve user ignore policies and actual pre-beta75 generated history rules.
  Provider protocol fixtures do not claim three-client live acceptance.

## 0.3.0-beta.76 — publication tracked separately

- Move a Project and selected Session using exact original records and reference
  closure. Preserve current destination settings, default selection and newer
  common direction; recover known copy/newline transitions without inventing origin.
- Include recovery-required common proof path/ID/hash metadata by default after
  a pre-export scope notice. Other Session bodies remain excluded; explicit
  `selected-only` retains partial provenance where proof is omitted.
- Add an optional exact-version Codex native-history Host adapter with local
  before-backups, current-policy metadata verification, bounded owned-process
  cleanup and at-most-once partial-group recovery. This is experimental, not a
  stable import API or proof of model continuation/current instruction binding.
- Keep Core P1–P5 and P2 recovery boundaries. Native registration evidence never
  grants a ReviewDecision, Canon promotion, Session ownership or execution permission.

## 0.3.0-beta.75 — publication tracked separately

- Default complete new local World/Graph writes to coalesced `chunked-code-v3`
  (physical schema 3). Retain old whole/v1/v2 originals and reuse unchanged IDs
  without conversion. Index, history, Compiler, Explorer, CLI/MCP and typed GC
  reconstruct and verify the same exact semantic evidence.
- Prioritize storage over latency by explicit user choice: a paired 48-file
  synthetic case cut one-line new bytes by 75.7%, with first generation 28% slower.
  A four-file case used 28% more first-write bytes, took 22% longer initially
  and 23% longer for code refresh. No universal speed or Host/model claim.
- Separate Core readiness from bounded advisory storage-reader requirements and
  distinguish observed physical file bytes from snapshot-only or reclaimable bytes.
  Preserve typed verification, permission failures, cancellation and GC deadlines.
- Upgrade only exact known generated ignore files, preserve user edits and relevant
  exceptions, and add separately labelled retained-history rules without untracking.
  Bound descriptor reads during file growth and reduce temporary relation-hash
  allocations without changing their canonical output.

## 0.3.0-beta.74 — publication tracked separately

- Use the existing controlled cleanup clock for the native queued-write/EOF
  regression. Preserve exact write order, EOF completion, clean native exit and
  process-tree proof without assuming an OS close event arrives within 66 ms.
- Keep production transport/native code and configured cleanup budgets unchanged
  (default 1,000 ms; this fixture uses 200 ms), together with strict forced-exit
  failure classification. Real escalation and EOF-resistant tests retain their
  clocks and assertions.

## 0.3.0-beta.73 — publication tracked separately

- Reorganize the English and Korean READMEs around installation, the first task,
  remaining work, plan updates and recorded before/after evidence. Move advanced
  commands and contracts to their existing specialist documents, preserving links.
- Correct Product-profile examples, Node requirements, Claude plugin/standalone
  launch conditions and current versus historical World/Graph protocol descriptions.
- Clarify shared schema-2 reader compatibility, explicit GC behavior, bounded Host
  references and the limits of synthetic performance evidence.
- Keep runtime behavior and execution fixtures unchanged; verify the relocated
  documentation contracts and translated README destinations.

## 0.3.0-beta.72 — publication tracked separately

- Let native GC termination finish and record its cleanup proof within the
  original collection deadline. Request graceful termination once; the existing
  deadline remains the hard-stop boundary for a stuck supervisor.
- Preserve byte caps, the first failure, post-stop write suppression, and explicit
  cleanup uncertainty. A stalled native process can use the remaining operation
  deadline; missing POSIX cleanup evidence still fails closed.
- Add controlled delayed-proof, stuck-process and ordinary-cancellation regression
  cases, while retaining the strict real native cleanup checks.

## 0.3.0-beta.71 — publication tracked separately

- Reuse exact selected-fragment field/index buckets when calculating partial
  work-context coverage, reducing repeated scans within each render.
- Preserve original content, selected IDs and order, partial ranges, omission
  warnings, and existing presentation/fit callback behavior without new reads,
  persistent caches, runtime artifacts or user workflow gates.
- Focused synthetic comparisons retain identical complete startup output and
  reduce partial-render computation cost. This does not establish improved
  retrieval quality, semantic sufficiency or actual Host/model utilization.

## 0.3.0-beta.70 — publication tracked separately

- Use flat shared code-domain parts for new complete World/Graph snapshots under
  selected Project ownership, preserving semantic IDs and existing whole/Git/v1
  history. Pure lower adapters retain whole-document storage without new setup.
- Report malformed optional World/Graph data as Product integrity attention while
  keeping Core ready. Explicit Product operations retain exact errors and leave
  damaged originals unchanged.
- Separate unchanged file membership from content changes in CLI/MCP/Explorer,
  retaining raw endpoints, counts/pages and visible omitted-example counts.
- Generate only ignore rules disjoint from existing exceptions, preserving user
  files and tracked policy. Batch private Git reads and reuse verified
  request-owned endpoints without a persistent cache or weaker owner checks.
- Balanced local synthetic measurements show smaller decision-only growth and
  faster first queries, with some repeated and small operations remaining slower.
  This is not a universal speedup; P2b and Rust prototypes are not adopted.

Composition schema 2 needs a supporting reader: beta.69 and earlier reject it.
Update every client sharing a store before writing v2. Publication, installation
and active Host/MCP loading remain separate.

## 0.3.0-beta.69 — publication tracked separately

- Explain new World/Graph lineage as content changes and snapshot membership while
  retaining exact raw evidence. Reuse analysis only after source and basis validation;
  unchanged verified World/Graph content can retain its immutable identity.
- Preserve project ignore exceptions and unrelated OpenCode configuration. Show
  local connection readiness without claiming the running Host has loaded it;
  describe existing cleanup outcomes without changing exit codes or policy.
- Connect exact requested Git/LFS assets to source comparisons, terminal output and
  Graph Explorer even when no graph node exists. Keep pointer identity, local cache
  presence and payload verification separate, with no implicit remote fetch.
- Read verified linked worktrees, including external common directories, through
  reciprocal metadata checks. Keep private snapshot storage independent.
- Independent source, synthetic consumer and browser evidence covers this scope.
  Later batch/scoped performance experiments are excluded. Marketplace publication,
  installation and Host/MCP loading remain separate checks.

## 0.3.0-beta.68 — publication tracked separately

- Connect substantial staged work to a completed preserved plan source, useful
  implementation/review contributions, and judgment integration through existing
  ordinary Host tools. Keep small direct work and current authority unchanged.
- Evolve the next plan from integrated results and learned facts instead of
  resetting to the initial plan or inheriting detailed review as the next planner.
- Keep native history observations, reconstructed context, actual Host behavior
  and model-quality evidence distinct. Preserve existing recovery and managed
  execution contracts without new APIs, records or user approval rituals.

## 0.3.0-beta.67 — publication tracked separately

- Add explicit, reference-verified local cleanup for orphan World/Graph files,
  private Git refs and objects, and domain bundles. Retain current/history, exact
  byte pins, recovery records, and successful or failed source originals.
- Keep pure reads zero-write and pointer APIs synchronous. Ordinary publication
  invalidates remaining cleanup effects without adding a user approval ritual.
- Bound replacement packs in isolated storage and recover valid unindexed packs
  only during a new explicit cleanup. Preserve unknown owners, damaged content,
  partial results, and incomplete retention evidence.
- Fix rooted pack-read races and Windows scratch paths; bind ref locks to the
  verified Project, attempt, host and runtime process origin.
- Verified frozen v8 with 84 GC regressions and independent Windows synthetic
  storage/CLI review. Marketplace publication and Host loading remain separate.

## 0.3.0-beta.66 — publication tracked separately

- Preserve revision-anchored Git/World evidence with immutable snapshot storage,
  domain freshness and exact temporal lineage. Keep whole-gzip storage as the default.
- Bound move matching and expose exact path-scoped, paged lineage queries across
  Core, CLI and MCP without turning partial coverage into semantic sufficiency.
- Count completed/cancelled Todo details separately from unresolved work; retain
  branch conflicts, unknown coverage and existing conversation/startup behavior.
- Exclude actual `.lode` directories at every distribution depth while preserving
  local records and ordinary `.lode` names in support code and documents.
- No tag or GitHub Release is created for this intermediate beta. Marketplace
  publication, disk installation and current Host loading are verified separately.

## 0.3.0-beta.65 — publication tracked separately

- Explore one exact Feature through structure, recorded work, and changes/related
  impact views. Preserve selection, pinned positions, camera, independent readers
  and exact source comparisons while paging large evidence inventories.
- Keep historical state, cancellation, uncertainty and partial/omitted Todo
  coverage visible on collapsed cards. Unfamiliar currentness stays readable;
  display grouping cannot create causality, approval or current permission.
- Join Product, World, reviewed code mappings and work citations by exact source
  identity. Symbol-only mappings follow their declaring file revision without
  claiming that the entire file implements a Feature.
- Reuse request-owned verified original bytes and digests across read consumers,
  retaining ownership, freshness and integrity checks. Separate static MCP
  contract metadata from effect orchestration without changing public behavior.
- Focused synthetic tests and independent actual-browser review cover this local
  implementation. Whole-project speed, live Host/model behavior, installation
  and publication remain separate claims. No intermediate release tag is implied.

## 0.3.0-beta.64 — publication tracked separately

- Restore useful work reasons, results and remaining tasks with exact original
  references and bounded excerpts. Current direction, cancellation and uncertainty
  remain distinct from historical evidence; routine entry does not require a save.
- Continue exact graph and historical-record reads without a whole inventory scan.
  Optional raw artifact inventory has explicit byte/entry limits and coverage;
  discovery never promotes evidence into approval or recovery direction.
- Reuse minimal entry guidance and preserve user-owned installation files. Protect
  supported Claude/OpenCode child state writes only with verified call provenance;
  explicit policy settings and ordinary direct work keep their existing semantics.
- Add exact process-witnessed Claude clear continuity and request-scoped packaged
  MCP composition. Missing proof keeps normal explicit recovery and project setup
  available. Owned installed MCP launchers follow verified upgrade/rollback pointers.
- Distinguish ordinary native recovery from the optional managed compaction
  lifecycle. Offer existing Session discovery only when dependent context is
  missing; current common direction keeps its original-read expansion priority.
- Local synthetic consumer and independent source checks are recorded separately
  from actual installed Host/model behavior, CI, marketplace publication and local
  reload. Preserve beta.63 payloads; intermediate release tags are not backfilled.

## 0.3.0-beta.63 — publication tracked separately

- Run the existing checks for every pull request targeting main, regardless of
  changed paths. Preserve push filters, required checks, permissions and
  publication conditions; runtime behavior is unchanged.
- Use a new beta version because publication integrity includes the workflow
  recipe. Preserve existing beta.62 packages and publication safeguards.
  Marketplace publication and local installation remain separately verified.

## 0.3.0-beta.62 — publication tracked separately

- Restore selected Session work and Todo context with exact original references.
  Preserve historical branches, conflicting observations, uncertainty and current
  cancellation without requiring a Run or promoting work evidence to direction.
- Reuse original-file bytes within a read request and use bounded recent-work
  navigation. Keep reference digests, Project ownership and freshness checks;
  missing or changed originals remain visible.
- Present work and Todo fields concisely in CLI, MCP and Graph Explorer, with
  exact source expansion and explicit partial coverage rather than repeated bodies.
- Make new onboarding and policy Product revisions directly citable from
  SessionWork. Verify each revision family and keep identical model contents in
  different Projects separate. Preserve ownerless historical bytes and retries;
  do not infer ownership for direct citation.
- Independent source and focused synthetic consumer checks cover these changes.
  Actual Host/model/GUI behavior, marketplace publication and local installation
  remain separate verification scopes. No release tag is implied.

## 0.3.0-beta.61 — publication tracked separately

- Protect optional prompt-reference storage with Windows owner/SYSTEM-only
  DACLs and a shared, bounded helper budget. Preserve masking, Project scoping,
  POSIX permissions and ordinary work when optional capture is unavailable.
- Keep the child-write guard off by default, apply enabled checks to the exact
  call, select the installed Claude package exactly, and avoid implicit default
  routing when native binding is missing. Portable OpenCode configuration stays
  unchanged; explicit logical Session routing remains available.
- Show supported work observations, follow-ups and exact partial excerpts in
  Graph Explorer cards. Preserve exact lineage endpoints, source comparisons,
  file/hunk navigation and honest missing-original or exhausted-budget notices.
- Keep large maps responsive with cooperative placement and the existing Canvas
  overview of explored evidence. Preserve all exported records/relationships,
  search, pins and explicit Focus back to cards; do not invent graph membership.
- Validate the scoped changes with independent source/browser review and focused
  synthetic checks. Correct obsolete all-SVG assertions and use controlled clocks
  for the cleanup phase boundary without changing runtime grace periods.
  Actual Host/provider behavior, Claude `/clear`, other-PC card causes and
  real-project performance remain unverified. Marketplace publication and local
  installation still require separate confirmation; no release tag is implied.

## 0.3.0-beta.60 — publication tracked separately

- Make Graph Explorer maps title-first, with per-card details and independently
  folded reading cards. Preserve intentional expansion, scroll, selection,
  camera and pins; measure changed card bounds without rearranging the graph.
- Show evidence-backed direct groups without inventing membership or edges.
  Keep source freshness, missing originals and recorded conditions available
  when expanded, including unfamiliar states.
- Connect Source-layer imports/calls to existing exact source comparisons by
  path and digest. Open code context explicitly and retain added/removed lines,
  file/hunk navigation and conservative missing-path/rename explanations.
- Verify the requested UI in a real localhost browser on synthetic reader
  output, alongside focused source tests. This is not proof of actual Host
  use, large-graph browser performance, 200% text or all long-body scrolling.
  Source/PR readiness is not marketplace publication or local installation.

## 0.3.0-beta.59 — publication tracked separately

- Write portable Claude Code, Codex, and OpenCode MCP launch lines. Shared
  `.mcp.json` and `opencode.json` use `node` plus a project-relative script or
  the client placeholder (`${CLAUDE_PLUGIN_ROOT}`, `${PLUGIN_ROOT}`,
  `{env:LODE_PLUGIN_ROOT}`). Absolute Node and install paths stay out of those
  files. Scan tracked files and three-client init output for concrete personal
  home paths, with the marketplace negative fixture allowlisted. Replace the
  personal Windows LSP fixture path. Default graph-explorer HTML remains a
  local report; `--share` still omits generated machine paths.
- Add an optional MCP subagent state-write guard. It is off unless
  `LODE_SUBAGENT_WRITE_GUARD=enforce`. Enforcement rejects non-read-only Lode
  tools from a subagent caller with `SUBAGENT_STATE_WRITE_REJECTED`. Claude
  uses the existing child `agent_id`, Codex uses `_meta.agent_id`,
  `_meta.subagent`, or a `SubagentStart` observation, and OpenCode uses a
  child session `parentID` in the exact pre-execution hook. OpenCode applies the
  same catalog read-only hint and shared policy without cross-call tickets. The
  default stays off, so a subagent can still record canon and checkpoints.
- Restore a bounded, redacted, local user-prompt reference after compaction
  or clear. Claude Code and Codex capture `prompt` on `UserPromptSubmit`,
  freeze it on `PreCompact`, and append it from `SessionStart` `compact` or
  `clear` when it fits. OpenCode captures `message.part.updated`, freezes it
  in `experimental.session.compacting`, and appends it once on the next system
  transform after `session.compacted` or a `clear` `command.executed` event.
  References are scoped by verified Project identity and caller, preserving
  explicit same-Project relocation without leaking between Projects. The text
  is non-authoritative. The checkpoint remains the recovery source.
- Resolve OpenCode's empty env-expanded launch path only from a hash-verified
  managed original bound to the current package. Keep user-owned, edited and
  unrelated commands unchanged. Verify actual selected installation paths
  after synthetic distribution upgrade and rollback, not a releaseId substring.
- This source entry is not publication proof. No intermediate tag or GitHub
  Release is created for this beta.

## 0.3.0-beta.58 — publication tracked separately

- Collapse selection tools on narrow screens and fit graph labels using measured
  extents; retain selection actions, pinned positions and graph authority limits.
- Prefer exact declaration identifiers in graph queries without turning ordinary
  words into semantic intent or excluding documents. Request-local lookup reuse
  preserves freshness and integrity checks; no material speedup was measured.
- Show exact cited historical text when a current file is missing. Display only
  bounded, byte-verified historical rename candidates, never inferred identity,
  causality or a replacement current path. Preserve UTF-8 BOM evidence.
- Correct remaining CLI display labels, add English/Korean security and
  contribution guidance, and include those documents in distribution payloads.
- Consolidate duplicate storage test files and legacy fixture setup, and remove
  redundant discovery-only subprocesses without weakening real process tests.
- Enable GitHub private vulnerability reporting and link its reporting form in
  both security documents; no response SLA or support window is promised.
- Actual browser GUI acceptance and the reported 7.3-second query remain
  unverified.
  Local and synthetic checks do not prove GUI, Host loading or provider behavior.

This source entry is not publication proof. Verify the exact source commit's CI
and each canonical/compatibility marketplace marker separately. No intermediate
tag/GitHub Release, local installation or MCP reload is included.

## 0.3.0-beta.57 — published to Codex and Claude marketplaces

Source: `e77c8e84ba82bbc70764110087d8485b2dbd7973`.
CI [39610882032](https://github.com/binary1215/lode/actions/runs/39610882032)
completed successfully. Canonical and compatibility Codex/Claude marketplace
branches were verified against this source. No GitHub Release or tag was made
for this intermediate beta, under the publication policy above. These are
publication records, not proof that a particular Host has reloaded the package.

- Use the existing controlled cleanup clock before invalid-transport requests
  start automatic shutdown. Keep all named cases and require exact native exit,
  verified tree cleanup and PID absence; do not change production grace periods
  or reinterpret uncertain cleanup as success.
- Carry forward beta.56's graph multi-selection UX. Actual browser GUI acceptance
  remains pending; a successful CI run is not GUI or Host reload evidence.

## 0.3.0-beta.56 — not published

Source: `be9bcacae377babe3aa425172661b5b9d9820847`.
CI [39602422243](https://github.com/binary1215/lode/actions/runs/39602422243)
failed two invalid-transport cleanup tests; marketplace publication was skipped.
The original failure remains recorded separately from the beta.57 repair.

- Keep multiple selected records and exact-linked file comparisons open together.
- Separate reading focus from exposure and camera; add rectangle selection,
  repeatable boundary expansion, contribution folding and real view history.
- Highlight selected connection branches with fixed component references, all
  equal shortest predecessors and original directions; do not infer causality.
- Keep large selections accessible through paging and cancellable calculations.
  These are local read-only presentation changes, not new authority or gates.
- Synthetic UI regressions are not actual browser/GUI acceptance.

## 0.3.0-beta.55 — published

Source: `fe731c88183f021e05c9a1a6e8bb7ac34890cd9c`.
CI [39581040674](https://github.com/binary1215/lode/actions/runs/39581040674)
succeeded; Lode and compatibility Codex/Claude marketplace branches were verified.

- Preserve selected graph context during search while retaining explicit scope.
- Explain verified copied/pending Project locations without adopting them in status.
- Omit generated local metadata with `graph-explorer --share`; retain original
  evidence and disclose exact HTML size without a size gate.
- Correct relocation/CLI guidance, human-facing Lode labels and missing-source
  explanations. These changes do not add a new MCP tool or recovery authority.

## 0.3.0-beta.54 — published

Source: `d0c12fe20ad0759efedb096542ecd7ccf47af2a3`.
CI [39562855184](https://github.com/binary1215/lode/actions/runs/39562855184)
succeeded; Lode and compatibility Codex/Claude marketplace branches were verified.
Preserved immediate Session-loss diagnostics and aligned the explicit-relocation
regression fixture with supported resume behavior.

## 0.3.0-beta.53 — not published

Source: `22d471e18e0ebbe82b8ea07612cc749598ae20c4`.
Added scalable graph navigation, exact context detail and explicit Project-folder
relocation. CI failed two regression tests; marketplace publishers were skipped.
The corrected successor is beta.54, not a replacement of this source history.

## 0.3.0-beta.52

Source: `4883322`. Retained recorded context provenance in shared graph views.

## 0.3.0-beta.51 — not published

Source: `465120c`. Aligned graph presentation and scan signatures. CI failed;
do not interpret this version as a successfully published marketplace release.

## 0.3.0-beta.50 / beta.49

Sources: `3327dfc` / `a2a9b08`. Added compute-output retries up to 512 MiB and
raised the default compute-output budget to 64 MiB, respectively. These entries
describe source changes, not an independent assertion of publication status.

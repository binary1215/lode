# Using the product graph

This page shows how to write the documents, build, check and approve the [product graph](product-graph.md). The node types, IDs and document formats are defined there.

## Write the documents

Put the documents in the Project store under `.lode/context/product-graph/`, one file per document: 제품 정의서, 유저 저니맵 and IA 문서 once each, one 유저플로우 기획서 per 유저 활동 and one 화면설계서 per 화면, named by its ID. Write the policy lines in `정책.md` and one meaning line per 기능 in `기능 뜻.md`. A project-specific entry rule (for example, where the MCP tools are registered) goes in `호출 방식 표.json`.

Documents you write before anyone confirmed them are estimates. Say which kind in the `| 항목 | 내용 |` table: 추정: 코드만 보고 쓴 추정 when written from the code without running the product, or 화면만 보고 쓴 추정 when written from the screens alone. Evidence for a product that was not run is a file and line, never an invented run.

You do not need to write 기능 or 코드: they come from the source tree. Cite 기능 IDs in the 화면요소 table as the build lists them.

## Build

```bash
lode-agent product-graph-build <project>
```

The build reads the documents, the policy and meaning files, the entry rules and the source tree, and writes `graph.json`, `check.json`, `check.txt` and `build-context.json` under `.lode/context/product-graph/build/`; the first time also `baseline.json` and `baseline-content.json` (the baseline's own source text, kept only for `changes --list content`; see below). It writes nothing else: documents, approvals and `product-model.json` stay as they are. Two builds of the same input into the same folder give the same bytes. To read the result one step at a time, see Ask the graph below or open the product graph view of the [Graph Explorer](graph-explorer.md).

## Check

```bash
lode-agent product-graph-check <project>
lode-agent product-graph-check <project> --include-estimates
```

The check is read-only. It prints the six rows of the 정합성 검사 and the lists that follow them, in Korean. By default it uses approved documents only and says how many estimates it left out. With `--include-estimates` it also uses estimates and labels every finding that rests on one, for example `[추정: 코드만 보고 쓴 추정]`.

Through MCP the same operations are the grouped tool `lode_product_graph` with action `build`, `check`, `query`, `sample`, `coverage`, `baseline`, `confirm`, `runs_add` or `approve`, routed through `lode_tools_call` (or `lode_tools_read` for the read-only check, query, sample and coverage). They are not on the default tool list.

## Approve

Approval records that the user read one document as it is now and accepts it as the product description. The check text lists every document that is not 승인 with its approval digest (`승인할 digest …` on its line), and the structured result carries it as `approvalDigest` in `documents.list`. Show the user that content, then record the decision with the same digest:

```json
{ "document": "화면설계서/CHT-01.md", "expectedSha256": "<digest from the check result>", "rationale": "Read with the user on the screen." }
```

```bash
lode-agent product-graph-approve <project> --input approval.json
```

If the document changed after the digest was taken, the approval is refused. Editing an approved document makes it an estimate again, listed as 승인 뒤 바뀜. The digest is taken over the text (see the definitions page), so a line-ending or BOM change by another editor does not drop an approval. On MCP the call needs `confirm_user_review: true`, and a subagent cannot record it.

**What an approval record is.** It is the record of the user's word, not a security boundary. Whoever can write files in the Project store can create one. The MCP path asks for the confirmation flag and is closed to subagent callers; the CLI path is the user's own hand. The audit trail is the version-control history of the `승인/` folder.

## Reading the result

- **0건** means the check compared at least one pair and found nothing.
- **검사 못 함: <reason>** means the check could not run, and says why: a missing document (제품 정의서가 없다), documents that exist but are not approved yet, a document that does not hold what the check needs, or a link this version does not extract (navigate 연결을 뽑지 않음). It never means "nothing wrong".
- **뽑지 않음** next to a node type (now only 계측 이벤트) means this version does not extract that type. It is not a count of zero. The counts of 데이터, 외부 연결 and DB are numbers, each with what it covers: environment variable names and data a 바깥 rule names, outside connections a 바깥 rule names, and tables and columns made by `CREATE TABLE` in code strings and `.sql` files.
- 제품코어 against 정책 is always left to a reader: the check prints both side by side.
- **처음 쓸 때 — 빠진 입력** appears only when a document the checks need is missing or not yet approved: each line names the input, the checks and lists it unlocks, and the next step. The checks below it still end in 검사 못 함 with the same reason.
- **이 그래프가 답하지 못하는 것** comes first. Read it before the findings: it says how much of the code was resolved, what is not extracted, what the UI scan cannot see, that nothing was run, and which documents this run used.
- **어느 기능에서도 닿지 않는 코드** lists declarations no 기능 reaches through resolved references, most-affected files first. With few resolved calls, many entries are expected; an entry is a question for a reader (a missing 기능, or dead code), not a verdict.
- **하나로 정하지 못한 호출** gives one count per reason and what would settle it; the limits block puts the calls in three numbers: all, those that cannot be product code or go to modules outside the product, and of the rest how many resolved. **코드로 읽지 않은 파일** counts what was not looked at, so a gap in coverage is visible.
- **사라진 기능의 뜻** lists 뜻 lines whose 기능 is gone, usually after a rename: move the line to the new ID by hand. A build never edits `기능 뜻.md`.
- **경로로 실행으로 읽은 곳** lists every place read as running or loading a file by its path (framework-invoked). It is read from text: read the sites and correct a wrong one with a rule. Paths that fit several files are counted, not linked.
- **규칙이 가리키는 코드가 없음** and **규칙이 낡음 — …** are rule issues: an 입구, 대상 or 선언 that is not a 코드 node, a 파일 that is not scanned code, 글 on no code line, or a 빼는 연결 that removes nothing. They are listed and never stop a build.
- **분기를 정하지 못함**, **이름 없는 바깥 호출** and **읽기·쓰기를 정하지 못함** say where the 분기 and 바깥 reading stopped: a branch that could not be delimited (that 기능 passes the whole function), outside calls no rule names, by module and file, and named data whose api is in neither the read nor the write list.
- **문서에만 있음(실행·코드 근거 없음)**, **실행·코드에만 있음(문서에 없음)**, **이어지지 않은 화면요소** and **실행 뒤 코드가 바뀜** compare the documents' 기능→화면요소 rows with the evidence (see Run records below). 이어지지 않은 화면요소 lists a row that should show a result and is tied to no 기능: one with a quoted phrase no run or code matched, or with neither a phrase, a 보여 주는 기능 nor a 조작하면 실행되는 기능. A row that only operates a 기능 (a button) shows no result and is not listed; the heading counts how many were left out. A machine edge is not an approval and changes no document. Wherever an answer shows a 기능→화면요소 edge (`down`, `up`, the page tree), a machine-found edge reads "← 기계가 찾음 (근거: 실행 R…; 코드 file:line)" instead of a document position, and a document edge that also has machine evidence adds "(근거: 문서; …)"; the row data carries `evidence` and `machine`.

## Ask the graph

```bash
lode-agent product-graph-query <project>                      # overview: the first block and the starts
lode-agent product-graph-query <project> node cli:sync
lode-agent product-graph-query <project> down cli:sync [--depth 2]
lode-agent product-graph-query <project> up cli:sync
lode-agent product-graph-query <project> reach cli:sync       # code a 기능 reaches
lode-agent product-graph-query <project> reach src/store.mjs  # 기능 that reach a file or a 코드 node
lode-agent product-graph-query <project> tree cli:sync        # everything a 기능 reaches, as one tree per role
lode-agent product-graph-query <project> user UA-CHT-01       # a 유저 활동's steps and the 기능 behind them
lode-agent product-graph-query <project> find store
lode-agent product-graph-query <project> gaps [--list unreachedCode]
lode-agent product-graph-query <project> changes [--list reviewAgain]
lode-agent product-graph-query <source-root> overview --build <folder>   # a stand-alone output folder
```

The query reads the existing build and never builds, checks, approves or writes. Every answer starts with three lines: when `graph.json` was written and whether the build is still the source as it is now (빌드 뒤 바뀐 것 없음, 빌드가 낡음: …, or 소스가 바뀌었는지 알 수 없음), how many calls that can be product code were resolved, and what changed since the baseline. Then the path line and the indented tree, in the build's words. Answers are paged (`--limit`, default 50, and `--cursor`); an answer with more says how many remain and the command for the next page. `down` and the starts `@기능`, `@기능/<kind>`, `@화면`, `@유저 활동`, `@파일` and `@바뀐 것` go one step at a time; a node already on the path is marked 위에 있음. `reach` follows resolved call, callback and framework-invoked references from both the 처리 and the 입구 code, the same closure the check uses for 어느 기능에서도 닿지 않는 코드: it stops at a 경계 and does not enter another 기능's 처리 코드 from 입구. In `reach <기능>`, code reached through 입구 is marked "— 입구로 닿음"; in `reach <code>`, a 기능 that reaches it only through 입구 is marked "— 입구로만 닿음". A 기능's child rows carry their 역할, marked "(입구)" for entry code. A boundary prints "경계에서 멈춤: <설명> → <대상>" under the node where reach stops, and `reach <code>` behind a boundary adds "경계를 넘으면 닿는 기능 N개 (…)". An edge written by hand is marked "(판단)".

`tree <기능>` prints one indented tree per role, 처리 first, with the boundaries and each code line's read, write and 외부 연결. A node already expanded is marked "— 위에서 펼침", and another 기능's 처리 코드 "— <기능>의 처리 코드라 펼치지 않음". `user <유저 활동>` gives the activity's steps in order, each with its 화면요소, the "부르는 기능", the "결과를 보여 주는 기능" with its 근거, and each 기능's "처리 코드". Both are paged like every answer (a continuation row, and rows a later page repeats, are marked); a tree past 2000 rows says so and points to `down <ID>`.

`--json` gives the structured form. The text is the same as the viewer's "Show as text" for the same question. With no build the answer is `PRODUCT_GRAPH_NOT_BUILT` with the build command; an unknown ID is `PRODUCT_GRAPH_NODE_NOT_FOUND` with the nearest matches.

Through MCP the same question is the grouped tool `lode_product_graph` with action `query` (`lode_product_graph_query`). The graph helps when you need which code a user action reaches, what reaches a file, or where the gaps are; it is a scan without types and never a prerequisite of ordinary work.

The structured answer (`--json`, MCP `structuredContent`) carries the rows as data. A row that stands for a graph node also carries `nodeType` (the node's type), `changedSinceBaseline` (`changed`, `added`, `reachChanged` or `unchanged`; only when the build was compared with a baseline) and `confirmation` (the confirmation lists that name the node: `neverChecked`, `changedSinceCheck`, `textChanged`, `otherReader`). A 뜻 line names its 기능 and a document row names both of its ends, so screens and screen elements carry it too. Every answer says `baselineComparison` (`compared`, `baseline-moved` when the baseline was moved after the build so the comparison is with the earlier one, `no-baseline` or `absent`) and `confirmationComparison`: `compared`, `partial` (the build read only the first confirmation records by name; every list and `confirmation` comes from those), `not-read` (a stand-alone build reads no confirmation records) or `absent` (a build made before confirmation records existed). A row a later page repeats from an earlier page (its root, a heading, the group line its first item continues) carries `repeats: "earlierPage"`; its text is unchanged. Only when `confirmationComparison` is `compared` does an absent `confirmation` mean either still current or nothing to check: the build keeps only a count of current ones. The starts (`@…`) carry none of these. Some rows carry more: a reach row says through which role it is reached (`via`: `처리` or `입구`; on `reach <code>`, `입구` means only through 입구); a 기능→코드 child row carries `역할`; a row of an edge written by hand carries `judgement: true`; a row that says where reach stopped at a boundary, or what crossing it would add, carries `boundary` (`from`, `to`, `설명`); a tree's role heading carries `role`, and a node it names without expanding carries `notExpanded` (`otherFunction` or `expandedAbove`); a `user` answer's step heading carries `step`, and a 기능 row carries `relation` (`calls` or `shows`) and, for `shows`, `evidence` (the edge's 근거). The answer also carries `buildSha256`, which names what it was read from (the bytes of `graph.json` and `check.json` of every build it read, and the baseline; nothing is stored). Through MCP, the `structuredContent` of `lode_product_graph_query`, `_check`, `_build` and `_baseline` leaves out the whole `text` when the structured part gives it back exactly (a before/after item of `changes --list content` from its `rows[].detail`, check from its result); the content text the tool returns still starts with it, and the CLI keeps it in `--json`. An answer without rows keeps `text`: no build, an unreadable build and a refusal (their sentence is also in `message`), and a basis change (whose sentence is only in `text`).

Reach follows resolved calls only. Where the reached code holds unresolved calls that could be product code, `reach` and a 기능's node answer say how many and which nodes hold the most ("이 길에서 못 푼 호출 N곳 …", data in `lostCalls` and `lostCallsIn`), and `tree` names them under each code row. A declaration with no resolved caller names the unresolved calls that may be it: bare calls of its name and, for a method, calls of its name on a receiver of unknown type with how many declarations share that name ("이 선언일 수 있는 못 푼 호출 N곳", data in `mayBeThis`): a possibility, never an edge.

## Several questions in one call

`lode_tools_read_chain` (CLI `tools-read-chain <project> --input chain.json`) asks several questions in one call and returns only the rows asked for, counted; see [MCP tool surface](mcp-surface.md#read-chain) for the steps, bounds and statuses. It is read-only, grants nothing and writes nothing. It helps when many answers would each be read only to pick a few lines out of them; for a single question, or when every line of the answers has to be read anyway, ask the questions directly. Its inner calls are product graph questions and `lode_project_graph`. Read `knownMissing` for what Lode knows is missing; an empty list does not prove the rows are all there is.

The review list, then who points at each item, counted:

```json
{
  "project_root": "<project>",
  "steps": [
    { "id": "todo", "read": { "name": "lode_product_graph_query", "arguments": { "question": "changes", "list": "reviewAgain" } }, "pages": 3 },
    { "id": "nodes", "from": "todo", "where": { "field": "kind", "eq": "node" } },
    { "id": "one", "from": "nodes", "unique": { "by": "id" } },
    { "id": "callers", "each": { "from": "one", "value": "id" },
      "read": { "name": "lode_product_graph_query", "arguments": { "question": "up", "id": { "$item": true } } } },
    { "id": "pointing", "from": "callers", "where": { "all": [{ "field": "kind", "eq": "node" }, { "field": "depth", "gte": 1 }] } },
    { "id": "busy", "from": "pointing", "count": { "by": "item" } },
    { "id": "top", "from": "busy", "sort": { "by": "count", "order": "desc" } }
  ],
  "return": [{ "from": "top", "limit": 10 }]
}
```

Find, keep the code nodes that changed since the baseline, and read the first two:

```json
{
  "project_root": "<project>",
  "steps": [
    { "id": "found", "read": { "name": "lode_product_graph_query", "arguments": { "question": "find", "text": "save" } } },
    { "id": "code", "from": "found", "where": { "all": [{ "field": "nodeType", "eq": "코드" }, { "field": "changedSinceBaseline", "ne": "unchanged" }] } },
    { "id": "two", "from": "code", "limit": 2 },
    { "id": "nodes", "each": { "from": "two", "value": "id" },
      "read": { "name": "lode_product_graph_query", "arguments": { "question": "node", "id": { "$item": true } } } }
  ],
  "return": [{ "from": "nodes" }]
}
```

A chain never returns rows from two builds. It detects a change after each call rather than preventing it: when the build or the baseline changes between two calls, the chain stops with `CHAIN_BUILD_CHANGED` and returns no rows. Ask again once the build is as you want it.

## Changes since the baseline

Every build hashes what it read: each 코드 node's text (a file's whole text, a declaration's line range), each 기능's kind, handling and 처리 코드 (and a second hash over the code it reaches), each document node's stated fields, and every source file it read (`inputs.sourceFiles`). Text is compared after dropping a BOM and turning CR LF and CR into LF, so another checkout's line endings change nothing, and moving a declaration inside its file without changing its text keeps its hash. A declaration is hashed without the blank lines at the end of its range, so appending code after the last declaration of a file changes only the file and the new declaration. A file with lone CR line endings hashes like its LF copy as a whole, but the shared scan reads it as one line, so its declarations' ranges and hashes differ from those of an LF copy. These hashes live only in the generated `build/` folder; IDs do not change. The reader is compared by the generator, its graph version and the source analysis version; the Lode version is recorded for information only, so an upgrade that reads code the same way is not a change.

The first build takes itself as the baseline (`build/baseline.json`) and says "기준 없음 — 이번 빌드를 기준으로 삼았다". Later builds compare with it and never move it, so building again keeps showing everything that changed since the baseline. `check.txt` and `check.json` (`changes`) give, right after the limits: when the baseline was set and what moved since (source files, documents, the rules file, the reader); per node type 변화 없음 as a count and 변경, 신규, 사라짐 by ID; 기능 whose own content is the same but whose reached code changed (닿는 코드가 바뀜) with the changed nodes; new and gone links; pairs that may have moved (same type, name and content); what changed where the source did not; and **다시 볼 것**: 뜻 lines and document rows (화면요소→기능, 기능→화면요소, 화면→코드) that point at something changed, with the document's state. An approved document among them is marked "승인된 문서가 가리키는 것이 기준 뒤 바뀜"; its approval stays, because whether its text is still right is a person's judgment. The build changes no document, 뜻 line or approval. Machine 기능→화면요소 edges are never in 다시 볼 것.

### After updating to reader version 2

The update that added 입구, framework-invoked paths, functions used as values, 데이터·외부 연결·DB and 분기 reads code another way (`PRODUCT_GRAPH_VERSION` 1 → 2). The first build after it compares with a baseline read the old way, and keeps what the new reading caused apart from what really changed:

- A 기능 whose reach differs only in nodes that all lie in files whose text equals the baseline's is counted under "읽는 방식이 달라져 닿는 범위가 달라진 기능 N개" and is left out of 닿는 코드가 바뀜 and 다시 볼 것.
- New 데이터, 외부 연결 and DB nodes are counted as "읽는 방식이 달라져 새로 생긴 노드", not as 신규.
- A 기능 that reaches code in a file that really changed is listed as before.
- Confirmation records show "다른 방식으로 읽은 때 확인함" until they are confirmed again.

After reviewing that list, run `product-graph-baseline` to take a baseline read the new way. `호출 방식 표.json` gains the optional keys 입구, 분기, 손으로 적는 연결, 바깥 and 빼는 연결; a table without them reads as before, and unknown keys are still refused. The new user-owned folder `실행 기록/` is optional: without it there is simply no run evidence.

```bash
lode-agent product-graph-baseline <project>
```

Moving the baseline is the only way it moves. It takes the existing build, refuses with `PRODUCT_GRAPH_BUILD_STALE` when that build is not the source as it is now, and says how many changed items and 다시 볼 것 items leave the list. It writes `build/baseline-content.json` (the new baseline's source text) and then `build/baseline.json`, and nothing else. Deleting `build/` loses only that list and the before/after display. Whether a build is still the source as it is now is checked against every file it read and against code files that are new; a new file that is not code (a hook JSON or a plugin manifest, for example) is seen only by the next build. If a build finds a node in a file whose text equals the baseline's but whose hash or lines differ under the same reader, it stops with `PRODUCT_GRAPH_NOT_REPRODUCIBLE` and writes nothing.

### After updating to source analysis 0.3.4

Source analysis 0.3.4 reads a JavaScript or TypeScript function's body after its parameter list closes, so a function with a `{` in a default or a destructured parameter gets its real range, and the calls in its body belong to it. Reach grows, and some code IDs change:

- A function nested in such a function now carries its container's name (`file#inner` becomes `file#outer.inner`). Against a baseline read the old way, such a node is counted under "읽는 방식이 달라져 이름이 바뀐 코드 N개" and left out of 신규 and 사라짐; `changes.readerChanged.renamed` lists the pairs. Other new code in a file whose text is the baseline's (arrow bindings the new reading finds) is counted with "읽는 방식이 달라져 새로 생긴 노드", not as 신규.
- A rule (`입구`, `대상`, `선언`) or a 화면→코드 row that names the old ID no longer resolves, and Lode does not resolve it silently. Its issue line names the declarations in that file with the same last name segment as a possibility ("같은 이름의 선언: `file#outer.inner` — 이름이 바뀌었을 수 있음"), since Lode cannot tell a renamed function from a mistyped ID. Edit the rule or the row to the new ID.
- An entry named only because a dispatcher's range used to end on its first line can go: the walk from the dispatcher now reaches the steps after it.
- Confirmation records show "다른 방식으로 읽은 때 확인함" until they are confirmed again. A 화면→코드 row edited to a new ID has no record under its own key: when exactly one record of the old reading names the same document, row type and screen with an old ID that no longer resolves, in the same file and with the same last name segment, the row shows as "다른 방식으로 읽은 때 확인함" with that old ID, marked as a match by name (`matchedByName`); with several such records it stays 확인한 적 없음 and lists them (`renamedCandidates`). Such a match never counts as checked, and nothing is written.
- A stored repository scan read by 0.3.3 is still read, and its files are scanned again.

After reviewing the list, run `product-graph-baseline` as above.

### After updating to graph version 3

Graph version 3 resolves Python calls through a module imported by name (`from pkg import mod`, then `mod.f()`), so the reach of Python products grows. Against a baseline read by version 2:

- Reach that differs only in files whose text is the baseline's is counted under "읽는 방식이 달라져 닿는 범위가 달라진 기능", never as 닿는 코드가 바뀜 or 다시 볼 것.
- Confirmation records show "다른 방식으로 읽은 때 확인함" until they are confirmed again; nothing is rewritten.
- A build that now leaves out a data-like folder the baseline read, or reads one the baseline did not, says so on its own line, "읽는 범위가 달라짐: …"; the nodes that leave or come only because of it are not 신규 or 사라짐.

After reviewing the list, run `product-graph-baseline` as above.

## Confirmation records

"다시 볼 것" is relative to the baseline: moving the baseline clears it although nobody looked, and a 뜻 line written after a change that predates the baseline is never flagged. Confirmation records say what was actually checked, apart from the baseline. Each record, `.lode/context/product-graph/확인/product-graph-check-<id>.json`, names the 뜻 lines (by 기능 ID and the hash of the line's text) or document rows (화면요소→기능, 기능→화면요소, 화면→코드, with the document's text digest) that were checked, and for every node they point to its content hash (and, for a 기능, the hash of all code it reaches) at that moment, with the way the code was read. It is written once and never rewritten or removed by Lode; it travels with export, import and folder copies like approval records, and GC keeps it. Like approval records too, export, import, folder-copy adoption and snapshot GC stop when a record in `확인/` does not verify, and transfer stops when there are more than 2000 records, although a build only lists such records as issues and goes on.

```
lode-agent product-graph-confirm <project> --input confirm.json
```

with `{"features": ["<기능 ID>"], "documents": ["화면설계서/MAIN-01.md"], "rationale": "what was re-read"}` (MCP: `lode_product_graph` action `confirm`). Use it only after re-reading the code each line describes: it records an agent's check (`agent-checked`), not the user's approval, and grants nothing. A document name confirms every code-linked row of that document whose target is in the graph (a row naming something missing is a gap, not code to check). It reads the existing build and refuses with `PRODUCT_GRAPH_BUILD_STALE` when the build is not the source as it is now (the source, a document or the rules changed, or the code would now be read another way; an approval since the build does not count), with `PRODUCT_GRAPH_CHECK_TARGET_MISSING` when a 기능 has no 뜻 line in the graph or a document has no such rows, and with `PRODUCT_GRAPH_CHECK_LIMIT` when its records would take the folder past 2000 records; a refusal writes nothing. A command writes as many records as its items need (each at most 500 items and 256 KiB) and says how many (`records`, `recordsWritten`). Items whose current record is already of the same kind (an agent check, or a user approval) with the same text and code basis, read the same way, are not written again: such a command answers `unchanged`. Ids are stored exactly as the graph has them, also when a file name is stored decomposed. Records are read apart from the documents: in file-name order, the first 2000 records of at most 256 KiB each; a record over that size, one that cannot be read, and every record past the count is listed with its file and counts for nothing, and the block says how many were not read. A build, a check, reading the build, an approval or a baseline move never fails because of them. A `확인/` folder that cannot be listed is such an issue too. Past the count, the first 100 names are listed and the rest counted. A `확인/` or `승인/` folder whose name is stored decomposed is used as it is; when both spellings exist, new records go to the composed (NFC) one and the build reads both. When writing stops part way (a full disk, for example), the reply names the records written and those not written (`status: "partial"`, `notWritten`); a confirm that wrote nothing fails with `PRODUCT_GRAPH_CHECK_WRITE_FAILED`, and a `확인` that is not a folder is refused with `PRODUCT_GRAPH_CHECK_FOLDER_INVALID`. `product-graph-approve` also writes a record (`user-approved`) for the approved document's rows from the current build; when the build is not current, or the record cannot be written, it approves the text as before and says the code basis was not recorded (`codeBasis.status: "not-recorded"` with the reason); nothing in that step can stop the approval. Approving the same document again with nothing changed writes no new record (`codeBasis.status: "unchanged"`).

The build reads the records (in a Project; a stand-alone run reads none and says so) and adds, after the comparison with the baseline, **확인 기록**: per checkable item, its current record decides. A new record names, for each of its items, every record that is current for it, including records tied with each other (`supersedes`), so the record a confirm or an approval just wrote is the one that counts, whatever the clocks say; between records that do not replace one another, the later time (compared as an instant) decides, then the record id. For a 기능 with two 뜻 rows, the checked row is the last, the one the graph shows. The statuses are: 확인한 적 없음 (never checked), 확인 뒤 코드가 바뀜 (a node it pointed to changed, is gone or its reached code changed, with which and who checked when), 확인 뒤 글이 바뀜 (the 뜻 line or the document's text changed), 다른 방식으로 읽은 때 확인함 (checked when the code was read another way; look again), or still current (counted, not listed). Agent checks and user approvals are named apart (에이전트 확인, 사용자 승인) wherever an item is listed. A record that does not verify (shape, content address, another Project) is listed with its file under 읽지 못한 확인 기록 and counts for nothing. Moving the baseline changes none of this. A record written, changed or removed after the build is not in `check.json` until the next build; reading the build compares the records' names and sizes (it reads no record, so a change in place that keeps the size is noticed at the next build) and says so next to its freshness. `product-graph-query <project> changes` shows the block, and `--list neverChecked`, `changedSinceCheck`, `textChanged`, `otherReader` or `issues` lists one status; a 기능 whose 뜻 line was checked and the check no longer holds (확인 뒤 코드가 바뀜, 확인 뒤 뜻 줄이 바뀜, 다른 방식으로 읽은 때 확인함) carries `{뜻: …}` on its node line, in every answer and in the product graph tree of the page. A line nobody checked carries no mark; it is listed in the block only. The Gaps view of the Graph Explorer shows the same block with each item linked to its node.

## Comparing another directory without touching it

Build and check also run on a directory that is not a Lode Project. Give every location explicitly; nothing is written into the analysed directory, and approvals are not read, so every document is an estimate:

```bash
lode-agent product-graph-build <source-root> --documents <folder> --rules <entry-rules.json> --out <folder> --include-estimates
lode-agent product-graph-check <source-root> --documents <folder> --rules <entry-rules.json> --include-estimates
```

The documents folder uses the same layout as the store folder. The rule file may hold an empty rule list. `--out` may not be the documents folder (or inside it) or the source root; in the folder you name, the three output files are replaced on each build.

## A rule for a command table

When a product registers its commands as rows of a table, a project rule can take each command's 처리 코드 from its own row. For a table like this:

```javascript
export const COMMANDS = [
  { command: "save", handler: saveFile },
  { command: "export", load: () => import("./export.mjs").then((m) => m.runExport) },
];
```

write the rule in `호출 방식 표.json`:

```json
{ "종류": "cli", "판단": true, "파일": ["src/commands.mjs"], "패턴": "command: \"([a-z-]+)\"", "처리 코드": "항목" }
```

`cli:save` then has `saveFile` as its 처리 코드 and `cli:export` has `runExport`. Make the pattern match the row's own key, not a mention of a command elsewhere; a 기능 found in more than one row is listed so you can tighten it.

## A global name the table does not know

A call to a runtime global the built-in table does not list (a host's own global, for example) is counted as having no declaration. Add the name in `호출 방식 표.json`, under `"내장 이름"`, by language:

```json
{ "schemaVersion": 1, "kind": "LodeProductGraphEntryRules", "rules": [], "내장 이름": { "javascript": { "함수": ["hostLog"], "네임스페이스": ["host"] } } }
```

`hostLog(x)` is then a built-in function and `host.run(x)` a built-in namespace member, in every file that does not declare, import or bind that name.

## A large source tree

A build counts only the files it would read (code, UI-binding candidates, hook, command and cli configuration, `.sql`, files a rule names) against its limit of 50,000. When a tree holds more, folders of at least 2,000 files of which under 10% would be read are left out as data-like and the build goes on; the limits block, `check.json`, the overview and `gaps` name each, with the code files in it that were not read. Under the limit nothing is left out, and such folders are only suggested for `source.제외`. To read a folder that was left out, name it under `source.포함`; `source.제외` still wins for the same path:

```json
{ "schemaVersion": 1, "kind": "LodeProductGraphEntryRules", "rules": [], "source": { "제외": ["recordings"], "포함": ["data/tools"] } }
```

When the files to read still pass the limit, the build fails with `PRODUCT_GRAPH_SOURCE_TOO_LARGE` and says how many files it would read, the ten heaviest top-level folders and that `source.제외` leaves a folder out. The numbers are judgement.

## Entry code, branches and connections the scan cannot see

All of these go in `호출 방식 표.json` and are marked 판단; the definitions page says exactly how each is read. A rule issue (규칙이 가리키는 코드가 없음, 규칙이 낡음 — …) is listed in the check and never stops a build.

When every MCP tool call passes one dispatcher before its handler, name it as 입구 so the dispatcher counts as reached by each tool 기능 without making each tool reach every other handler:

```json
{ "종류": "tool", "판단": true, "입구": ["src/server.mjs#dispatch"] }
```

A rule with only 종류 like this one gives 입구 to every 기능 of that kind; a rule with 파일 and 패턴 gives it to the 기능 it produces. Adding 입구 changes what each of those 기능 is stated to pass through, so after the next build every one of them is listed as 변경 (and as 닿는 코드가 바뀜 where its reach grew) against the baseline, and their 확인 records show 확인 뒤 코드가 바뀜 until they are checked again; `product-graph-baseline` takes the new state as the baseline once you have read the list.

When one function handles several commands in branches, `"분기": true` on its pattern rule gives each 기능 only its own branch's lines:

```json
{ "종류": "cli", "판단": true, "파일": ["src/cli.mjs"], "패턴": "case \"([a-z-]+)\":", "분기": true }
```

When the code reaches something in a way the scan does not see (a framework that calls a handler by configuration, for example), write the connection by hand, or mark where reach should stop:

```json
{
  "schemaVersion": 1,
  "kind": "LodeProductGraphEntryRules",
  "rules": [],
  "손으로 적는 연결": [
    { "판단": true, "종류": "framework-invoked", "파일": "src/app.mjs", "글": "registerJobs(", "대상": ["src/jobs.mjs#runJobs"], "설명": "the scheduler calls runJobs" },
    { "판단": true, "종류": "경계", "파일": "src/plugins.mjs", "글": "loadPlugin(", "대상": ["src/plugin-host.mjs"], "설명": "third-party plugins" }
  ],
  "바깥": [
    { "판단": true, "이름": "settings", "종류": "데이터", "닿는 곳": [{ "모듈": "fs", "파일": ["src/settings.mjs"] }], "설명": "the settings file" },
    { "판단": true, "이름": "billing-api", "종류": "외부 연결", "닿는 곳": [{ "모듈": "https", "선언": ["src/billing.mjs#charge"] }] }
  ]
}
```

Outside calls that no 바깥 rule names are listed under 이름 없는 바깥 호출 by module and file, so you can see which to name. A call two rules claim is a rule issue unless exactly one narrows it by 줄 or 선언.

## Check a sample of edges

```bash
lode-agent product-graph-sample <project> [--seed n] [--count k] [--types call,callback]
```

The sample reads the existing build and picks `k` edges (default 30, at most 500), spread over the edge types present, for a person to check against the source. Each edge shows both ends with file and line range, where it was read and its evidence. It prints the seed; without one, the seed is derived from the build, so the same build gives the same sample. It stores nothing and gives no verdict: read the source and report wrong edges. MCP: `lode_product_graph` action `sample` (`lode_product_graph_sample`).

## Run records

Lode runs nothing. When the project has run a 기능 (a test, a script, a person at the terminal), hand Lode what was run and what came back:

```json
{ "runs": [{ "기능": "cli:sync", "실행": "lode-agent sync ./demo", "상태": "ok", "출력": "<the raw output>", "종료": 0 }], "rationale": "why these runs were made" }
```

```bash
lode-agent product-graph-runs-add <project> --input runs.json
```

(MCP: `lode_product_graph` action `runs_add`.) Each run gets the 기능's content and reach hash from the present build and the way code is read, so a run made on older code never becomes evidence for today's code. Records go to `.lode/context/product-graph/실행 기록/product-graph-run-<id>.json`, content-addressed and split by size; Lode never edits or deletes them. Refusals mirror confirm and write nothing: `PRODUCT_GRAPH_BUILD_STALE` when the build is not the source as it is now, `PRODUCT_GRAPH_RUN_TARGET_MISSING` when a 기능 is not in the graph, and `PRODUCT_GRAPH_RUN_LIMIT` past 2,000 records, for a record over 256 KiB, or for an output over 16 KiB (refused, not cut). Runs are shown as `R<record short id>-<n>`.

**The output is stored as you give it.** Lode does not look for secrets in it, and a portable export carries it. Remove secrets before you hand an output over.

The next build uses current runs as evidence for 기능→화면요소 edges: a phrase quoted in backticks in a 화면요소 row's 한 줄 cell that appears in a run's output. Code string literals are evidence too (see the definitions page). Each edge says its 근거 ("문서", "실행 <ids>", "코드 <file>:<line>"). To remove a wrong machine edge, add a judged rule:

```json
{ "빼는 연결": [{ "판단": true, "기능": "cli:sync", "화면요소": "CLI-01#2", "이유": "the phrase also appears in the help text" }] }
```

Machine edges are evidence, not approval: they never change a document, an approval or a confirmation record and are never in 다시 볼 것. A run whose 기능 changed since is listed as 실행 뒤 코드가 바뀜 and gives no edge; record it again on the current code. A newer run with the same 기능 and 실행 label replaces the older. `changes --list runsCurrent` and `--list runsStale` list the runs, and a 기능 with a stale run carries `{실행: 실행 뒤 코드가 바뀜}` on its node line. Reading the build notes next to its freshness when run records changed since the build ("실행 기록이 빌드 뒤 바뀜 — 다시 빌드하면 연결에 반영된다").

## Compare a 기능's reach with a real run

```bash
NODE_V8_COVERAGE=<folder> <run the project so it does that one 기능>
lode-agent product-graph-coverage <project> --feature cli:sync --v8 <folder>
```

The comparison is read-only and stores nothing; Lode runs nothing, the project runs. It lists "실행됐는데 닿는 범위 밖" (code that ran outside the reach: a path the graph misses) and "닿는다고 했는데 돌지 않음" (reach that did not run, untaken branches and error paths included). 입구 code is inside the reach. Code that ran behind a stop of the walk from 입구 (another 기능's 처리 코드) is listed apart, under "실행됐는데 입구에서 멈춘 곳 뒤에 있음", so a stop is not mistaken for a missing edge. A file changed since the run is skipped and named under "실행한 파일이 지금 소스와 다름". When nothing could be compared, both lists say "비교하지 않음 — <reason>", never 0. Only V8 coverage JSON is read. V8 coverage carries no source text, so "the same source" is judged by script length and by the file not having changed after the coverage file was written. The script's own whole-file range (its top level, run whenever the module is loaded) is not counted; a function that starts on the file's first line is. MCP: `lode_product_graph` action `coverage` (`lode_product_graph_coverage`).


## Find a flow, inspect its changes, preview a proposal

Start with a question rather than an ID:

```bash
lode-agent product-graph-query <project> find "메모를 저장할 때 오류"
lode-agent product-graph-query <project> find "saveNote" --node-types 기능 --related-to P1 --edge-types 정책→기능
lode-agent product-graph-query <project> changes --list content
lode-agent product-graph-query <project> impact --proposal-base-build <starting-build> --candidate-build <proposed-build>
```

**Find** uses a BM25 word index built for the graph being asked (nothing is kept between graphs or between questions), with exact ID/path matches first and deterministic ties. Type, recorded-basis status and edge-neighbourhood filters apply before ranking and paging. `--edge-types` restricts the neighbourhood of `--related-to` only. A `--related-to` ID that is not in the graph is refused (`PRODUCT_GRAPH_NODE_NOT_FOUND`), not answered with nothing. Code identifiers are split and Korean character bigrams help with inflected text; this is word matching, not semantic judgment, and similar wording never creates a connection, approval or currentness. Recorded adjacent edges are listed for the results on the shown page. The page's search uses the same code.

**Content changes.** `check.json`, `check.txt`, the build and check replies (CLI and MCP) and the Graph Explorer export (local and `--share`) say which nodes' content changed and whether a "before" is kept, never the text itself. The text is shown only by the question `changes --list content`, and it is product source text: the "before" from the retained file, the "after" from the source as it is now, only where it still matches this build. Each side is bounded to 16 KiB; a page holds whole items up to 256 KiB and the next page starts at the first item left out; a cut side says how many bytes it left out. In the structured reply each text is in `rows[].detail` only. A page opened from a build shows the command, not the text. The list belongs to the baseline it was compared with: after `product-graph-baseline`, or for a build made before retained content existed, the question is refused with `PRODUCT_GRAPH_BUILD_STALE` and no text until the next build.

- Code content is the normalised source range (BOM dropped, line ends LF; not raw-byte equality; a scanner line range, not an AST body). Every other node's content is exactly the fields its content hash covers, so the shown text hashes to the recorded hash. A 기능's position and one-line meaning are not part of it: a line shift above an entry point is not a content change.
- The "before" text lives in `build/baseline-content.json` next to `build/baseline.json`: generated, local, git-ignored with the rest of `build/`, at most 2 MiB of file bytes (a reader refuses a file over 4 MiB). Only whole contents are kept, smallest first, up to 16 KiB each, so every "before" shown is checked against the baseline's content hash; a content larger than that, or past the budget, has no entry and shows as "not kept". It is bound to the baseline file's bytes and to the way code is read (generator, graph version, source analysis), not to the installed Lode version, so an update that reads code the same way keeps it. An entry edited by hand does not match and is not shown. The file is derived: when it is missing, belongs to another baseline (for example a move that stopped between its two writes) or cannot be read, the next build writes it again from that build's sources, only for nodes whose content is still the baseline's, and says so in `changes.content.retainedFile`. When the baseline was taken by a version that read code another way, nothing is written and the result says to run `product-graph-baseline`. Removing the file only loses the before/after display; the comparison itself is unchanged. Portable export/import and the Graph Explorer export do not carry it; a folder copy carries `build/` as it is.

**Impact** reads three existing builds and changes nothing: the state a proposal started from, the current state, and the proposal applied to its start. It tells equal final edits from divergent edits, concurrent policy changes and references left to deleted UI or code, and reports counted relations, provenance and delete-versus-update conflicts. A conflict-free result is not product approval and a static preview is not runtime evidence. It is "verified" only when the three builds come from the same Project (each build writes `build/build-context.json`: the Project, a hash of the source root and the way code is read) or, for stand-alone builds, the same source root, read code the same way and use the same rule table. A Project build next to a stand-alone `--out` build, or builds of different stand-alone roots (another worktree), are "partial" and say why; so is omitting the starting build (then the recorded baseline hashes are used). A given build folder that cannot be read is refused with its reason.

To get three different states that compare as verified, build them in the Project itself and keep a copy of `build/` after each. Nothing in these steps discards anything they did not create; they need a clean tree to start from: `git status --porcelain` must print nothing (commit or stash your own work first; `build/` is git-ignored and does not count). For a proposal given as a patch made against its starting commit:

```bash
git status --porcelain                           # must print nothing
git switch --detach <commit-the-proposal-started-from>
lode-agent product-graph-build <project>
cp -r <project>/.lode/context/product-graph/build <somewhere>/start
git apply <proposal.patch>
lode-agent product-graph-build <project>
cp -r <project>/.lode/context/product-graph/build <somewhere>/proposal
git apply -R <proposal.patch>                    # undoes exactly what git apply did
git switch -                                     # back to the branch you were on
lode-agent product-graph-build <project>         # build/ is the current state again
lode-agent product-graph-query <project> impact --proposal-base-build <somewhere>/start --candidate-build <somewhere>/proposal
```

`git apply -R` reverses exactly what `git apply` did and stops with an error if the tree is not in that state; nothing else is touched. For a proposal given as a branch based on its starting commit:

```bash
git status --porcelain                           # must print nothing
git switch --detach <commit-the-proposal-started-from>
lode-agent product-graph-build <project>
cp -r <project>/.lode/context/product-graph/build <somewhere>/start
git switch --detach <proposal-branch>
lode-agent product-graph-build <project>
cp -r <project>/.lode/context/product-graph/build <somewhere>/proposal
git switch <the-branch-you-were-on>
lode-agent product-graph-build <project>         # build/ is the current state again
lode-agent product-graph-query <project> impact --proposal-base-build <somewhere>/start --candidate-build <somewhere>/proposal
```

The proposal is applied only to a temporary checkout of its starting point, never to the current state; the preview is what applying it now would meet. Building at another commit moves nothing: the baseline stays, and builds never move it.

**Paging.** A printed next-page hint repeats the question exactly: its filters, `--limit`, `--depth`, the build folders and `--expected-basis-sha256`, the hash of what the page was answered from (the build files, the comparison and the question). If any of that has changed, the next page is refused (`PRODUCT_GRAPH_QUERY_BASIS_CHANGED`) instead of mixing pages; ask again from the start. The reply carries the same as `page.nextArguments` (Core/CLI option names, with where the build is) and, for a Project, `page.nextMcpArguments` (the MCP tool argument names): send them as they are. A cursor typed by hand without the basis is answered as before.

Every build derives everything from the sources again; there is no parse cache.

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

The build reads the documents, the policy and meaning files, the entry rules and the source tree, and writes `graph.json`, `check.json` and `check.txt` under `.lode/context/product-graph/build/`, and `baseline.json` the first time (see Changes since the baseline below). It writes nothing else: documents, approvals and `product-model.json` stay as they are. Two builds of the same input into the same folder give the same bytes. To read the result one step at a time, see Ask the graph below or open the product graph view of the [Graph Explorer](graph-explorer.md).

## Check

```bash
lode-agent product-graph-check <project>
lode-agent product-graph-check <project> --include-estimates
```

The check is read-only. It prints the six rows of the 정합성 검사 and the lists that follow them, in Korean. By default it uses approved documents only and says how many estimates it left out. With `--include-estimates` it also uses estimates and labels every finding that rests on one, for example `[추정: 코드만 보고 쓴 추정]`.

Through MCP the same operations are the grouped tool `lode_product_graph` with action `build`, `check`, `query`, `baseline` or `approve`, routed through `lode_tools_call` (or `lode_tools_read` for the read-only check and query). They are not on the default tool list.

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
- **뽑지 않음** next to a node type (데이터, 외부 연결, DB, 계측 이벤트) means this version does not extract that type. It is not a count of zero.
- 제품코어 against 정책 is always left to a reader: the check prints both side by side.
- **처음 쓸 때 — 빠진 입력** appears only when a document the checks need is missing or not yet approved: each line names the input, the checks and lists it unlocks, and the next step. The checks below it still end in 검사 못 함 with the same reason.
- **이 그래프가 답하지 못하는 것** comes first. Read it before the findings: it says how much of the code was resolved, what is not extracted, what the UI scan cannot see, that nothing was run, and which documents this run used.
- **어느 기능에서도 닿지 않는 코드** lists declarations no 기능 reaches through resolved references, most-affected files first. With few resolved calls, many entries are expected; an entry is a question for a reader (a missing 기능, or dead code), not a verdict.
- **하나로 정하지 못한 호출** gives one count per reason and what would settle it; the limits block puts the calls in three numbers: all, those that cannot be product code or go to modules outside the product, and of the rest how many resolved. **코드로 읽지 않은 파일** counts what was not looked at, so a gap in coverage is visible.
- **사라진 기능의 뜻** lists 뜻 lines whose 기능 is gone, usually after a rename: move the line to the new ID by hand. A build never edits `기능 뜻.md`.

## Ask the graph

```bash
lode-agent product-graph-query <project>                      # overview: the first block and the starts
lode-agent product-graph-query <project> node cli:sync
lode-agent product-graph-query <project> down cli:sync [--depth 2]
lode-agent product-graph-query <project> up cli:sync
lode-agent product-graph-query <project> reach cli:sync       # code a 기능 reaches
lode-agent product-graph-query <project> reach src/store.mjs  # 기능 that reach a file or a 코드 node
lode-agent product-graph-query <project> find store
lode-agent product-graph-query <project> gaps [--list unreachedCode]
lode-agent product-graph-query <project> changes [--list reviewAgain]
lode-agent product-graph-query <source-root> overview --build <folder>   # a stand-alone output folder
```

The query reads the existing build and never builds, checks, approves or writes. Every answer starts with three lines: when `graph.json` was written and whether the build is still the source as it is now (빌드 뒤 바뀐 것 없음, 빌드가 낡음: …, or 소스가 바뀌었는지 알 수 없음), how many calls that can be product code were resolved, and what changed since the baseline. Then the path line and the indented tree, in the build's words. Answers are paged (`--limit`, default 50, and `--cursor`); an answer with more says how many remain and the command for the next page. `down` and the starts `@기능`, `@기능/<kind>`, `@화면`, `@유저 활동`, `@파일` and `@바뀐 것` go one step at a time; a node already on the path is marked 위에 있음. `reach` follows resolved call and callback references only, the same closure the check uses for 어느 기능에서도 닿지 않는 코드. `--json` gives the structured form. The text is the same as the viewer's "Show as text" for the same question. With no build the answer is `PRODUCT_GRAPH_NOT_BUILT` with the build command; an unknown ID is `PRODUCT_GRAPH_NODE_NOT_FOUND` with the nearest matches.

Through MCP the same question is the grouped tool `lode_product_graph` with action `query` (`lode_product_graph_query`). The graph helps when you need which code a user action reaches, what reaches a file, or where the gaps are; it is a scan without types and never a prerequisite of ordinary work.

## Changes since the baseline

Every build hashes what it read: each 코드 node's text (a file's whole text, a declaration's line range), each 기능's kind, handling and 처리 코드 (and a second hash over the code it reaches), each document node's stated fields, and every source file it read (`inputs.sourceFiles`). Text is compared after dropping a BOM and turning CR LF and CR into LF, so another checkout's line endings change nothing, and moving a declaration inside its file without changing its text keeps its hash. A declaration is hashed without the blank lines at the end of its range, so appending code after the last declaration of a file changes only the file and the new declaration. A file with lone CR line endings hashes like its LF copy as a whole, but the shared scan reads it as one line, so its declarations' ranges and hashes differ from those of an LF copy. These hashes live only in the generated `build/` folder; IDs do not change. The reader is compared by the generator, its graph version and the source analysis version; the Lode version is recorded for information only, so an upgrade that reads code the same way is not a change.

The first build takes itself as the baseline (`build/baseline.json`) and says "기준 없음 — 이번 빌드를 기준으로 삼았다". Later builds compare with it and never move it, so building again keeps showing everything that changed since the baseline. `check.txt` and `check.json` (`changes`) give, right after the limits: when the baseline was set and what moved since (source files, documents, the rules file, the reader); per node type 변화 없음 as a count and 변경, 신규, 사라짐 by ID; 기능 whose own content is the same but whose reached code changed (닿는 코드가 바뀜) with the changed nodes; new and gone links; pairs that may have moved (same type, name and content); what changed where the source did not; and **다시 볼 것**: 뜻 lines and document rows (화면요소→기능, 기능→화면요소, 화면→코드) that point at something changed, with the document's state. An approved document among them is marked "승인된 문서가 가리키는 것이 기준 뒤 바뀜"; its approval stays, because whether its text is still right is a person's judgment. The build changes no document, 뜻 line or approval.

```bash
lode-agent product-graph-baseline <project>
```

Moving the baseline is the only way it moves. It takes the existing build, refuses with `PRODUCT_GRAPH_BUILD_STALE` when that build is not the source as it is now, and says how many changed items and 다시 볼 것 items leave the list. Deleting `build/` loses only that list. Whether a build is still the source as it is now is checked against every file it read and against code files that are new; a new file that is not code (a hook JSON or a plugin manifest, for example) is seen only by the next build. If a build finds a node in a file whose text equals the baseline's but whose hash or lines differ under the same reader, it stops with `PRODUCT_GRAPH_NOT_REPRODUCIBLE` and writes nothing.

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

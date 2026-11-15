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

The build reads the documents, the policy and meaning files, the entry rules and the source tree, and writes `graph.json`, `check.json` and `check.txt` under `.lode/context/product-graph/build/`. It writes nothing else: documents, approvals and `product-model.json` stay as they are. Two builds of the same input give the same bytes.

## Check

```bash
lode-agent product-graph-check <project>
lode-agent product-graph-check <project> --include-estimates
```

The check is read-only. It prints the six rows of the 정합성 검사 and the lists that follow them, in Korean. By default it uses approved documents only and says how many estimates it left out. With `--include-estimates` it also uses estimates and labels every finding that rests on one, for example `[추정: 코드만 보고 쓴 추정]`.

Through MCP the same operations are the grouped tool `lode_product_graph` with action `build`, `check` or `approve`, routed through `lode_tools_call` (or `lode_tools_read` for the check). They are not on the default tool list.

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
- **하나로 정하지 못한 호출** gives one count per reason and what would settle it. **코드로 읽지 않은 파일** counts what was not looked at, so a gap in coverage is visible.
- **사라진 기능의 뜻** lists 뜻 lines whose 기능 is gone, usually after a rename: move the line to the new ID by hand. A build never edits `기능 뜻.md`.

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

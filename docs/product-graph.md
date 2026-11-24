# Product graph (제품 그래프)

The product graph records what a user does with a product and what the system does in response, as typed nodes and named edges, and shows where the two do not meet. Lode uses the model of the original project, [head-agent-core](https://github.com/Won6314/head-agent-core) (`graph/build/02a-graph-definitions.md`), without changes: its 13 node types, its rules for what counts as one node, its 정합성 검사, and its Korean words. The user decided this on 2026-11-15. This page describes Lode's implementation in its own words; the original page remains the source of the model.

**Not the Product Model.** This product graph is separate from the [Product Model canon](product-model.md) in `context/product-model.json`, which it never reads or changes. The [Product Operating Loop](product-operating-loop.md) page and the `productGraph` result field use the words "Product Graph" for a projection of the Product Model; that wording names a different thing and is not this graph. Renaming it is not part of this work.

How to write the documents, build, check and approve is in [Using the product graph](product-graph-usage.md).

## Node types

Node type names are used exactly as written below, in every language.

| Node type | What one node is | Comes from |
| --- | --- | --- |
| 제품코어 | What the product is, who it is for, what it gives and how it presents itself; one per product | 제품 정의서 |
| 유저저니 | The stages in which a user finds, uses, leaves and returns to the product | 유저 저니맵 |
| IA | The list of screens, their groups and the menus reachable from everywhere | IA 문서 |
| 유저 활동 | One thing the user sees as a single task, with its steps | 유저플로우 기획서 (one per activity) |
| 화면 | One state of one page; a modal, sheet or shared area is its own screen | 화면설계서 (one per screen) |
| 화면요소 | One part of a screen the user sees, enters or receives | the 화면요소 section of the 화면설계서 |
| 정책 | One rule written as condition / actor / action, kind 처리 or 표시 | one line written directly into the graph |
| 기능 | One request the system receives and handles (one entry point) | code, by script |
| 코드 | A named unit of code (file, class, function) | code, by script |
| 데이터 | A value code reads or writes that is not a database | code: environment variable reads, and data a 바깥 rule names |
| 외부 연결 | A place where code calls a service outside the product | code, where a 바깥 rule names the other side |
| DB | Tables and columns | code: `CREATE TABLE` in a code string or a `.sql` file |
| 계측 이벤트 | An event code sends to an analytics tool | code (뽑지 않음 in this version) |

For a product without screens (a CLI, a plugin, a library), one kind of output the user receives (command output, a tool result, text a hook adds, an error message) is a 화면, and one part of that output is a 화면요소.

## Where each node comes from

- Nodes from code (기능, 코드, 데이터, 외부 연결, DB) are produced only from the source tree and the entry-rule table, by script. The same input gives byte-identical output.
- Nodes from documents (제품코어, 유저저니, IA, 유저 활동, 화면, 화면요소) come only from the documents the user writes.
- Two things are written directly: one rule line per 정책, and one meaning line per 기능 (kept in its own file, apart from script output).
- Run records (`실행 기록/`) hold what the project ran and what came back, handed to Lode; they make no node and are only evidence for 기능→화면요소 edges (see Run records below). Lode runs nothing.
- The graph itself is a generated file. Nobody edits it.

## IDs

| Node | ID shape | Example |
| --- | --- | --- |
| 화면 | `<묶음 앞머리>-<번호>` | `CHT-01` |
| 화면요소 | `<화면 ID>#<번호>`, sub-numbers for parts inside a part | `CHT-01#5`, `CHT-01#3-1` |
| 유저 활동 | `UA-<묶음 앞머리>-<번호>` | `UA-CHT-01` |
| 기능 (hook, command, tool, cli) | `<종류>:<이름>` | `hook:SessionStart`, `tool:lode_project_status` |
| 기능 (프론트) | `fe/<path without extension>/<component>@<event>:<target>` | `fe/app/ui/main_window/MainWindow@clicked:_save` |
| 코드 | `<path>` for a file, `<path>#<qualified name>` for a declaration, with `~<n>` when the name repeats in the file | `app/ui/main_window.py#MainWindow._save`, `app/util.py#helper~2` |
| 정책 | written in the policy file | `P1` |
| 데이터 | `data:env:<NAME>` for an environment variable, `data:<이름>` for data a 바깥 rule names | `data:env:HOME`, `data:settings` |
| 외부 연결 | `ext:<이름>`, the name a 바깥 rule gives | `ext:billing-api` |
| DB | `db:<table>`, `db:<table>.<column>` | `db:notes`, `db:notes.title` |

## Edges

An edge name is the two node types joined by `→`: 유저 활동→화면요소, 유저 활동→유저 활동, 화면→화면요소, 화면→화면, 화면→정책, 화면→코드, 화면→기능, 화면요소→화면요소, 화면요소→기능, 기능→화면요소, 정책→기능, 기능→코드, 코드→외부 연결. The original's three exceptions keep their own names: 포함, the 코드→코드 reference kinds (call, callback, framework-invoked, render, type reference, re-render, response, enqueue, navigate, http, defines), and read / write. One Lode name is added: 경계, a boundary written by hand in the entry-rule table (see 손으로 적는 연결 below). No other edge name is used.

Every document edge comes from an ID cited in a document; nothing is inferred from wording.

- A step of 차례 cites 화면요소 IDs (유저 활동→화면요소); 다음 활동 cites 유저 활동 IDs.
- A 화면요소 row cites the 기능 it runs when operated (화면요소→기능) and the 기능 whose result it shows (기능→화면요소).
- The 화면 정책 section cites 정책 IDs (화면→정책); 공통 영역 cites other 화면 (화면→화면); 그리는 코드 cites 코드 IDs (화면→코드).
- 화면→기능 is added for each `@effect` 기능 of the class a 화면 cites as its drawing code.
- 기능→코드 links each 기능 to the code that receives it, when that resolves, with 역할 "처리". A rule's 입구 adds 기능→코드 edges with 역할 "입구" (see below). A 기능 whose rule has 분기 carries the line ranges it passes on its edge.
- Besides the rows of a 화면설계서, a build adds 기능→화면요소 edges it finds from evidence (run output and code string literals); each edge lists its 근거. These machine edges are evidence, not approval (see Run records below).

Edges from code to 데이터, 외부 연결 and DB:

- read (and write) from the code that reads an environment variable to `data:env:<NAME>`; read or write to named data, and 코드→외부 연결, only where a 바깥 rule names the other side.
- 포함 from a table to each of its columns; read or write from code whose SQL names a known table.

## Store

The family lives in the Project store next to `context/product-model.json`:

```text
.lode/context/product-graph/
  제품 정의서.md
  유저 저니맵.md
  IA 문서.md
  유저플로우 기획서/UA-CHT-01.md
  화면설계서/CHT-01.md
  정책.md
  기능 뜻.md
  호출 방식 표.json
  승인/product-graph-approval-<id>.json
  확인/product-graph-check-<id>.json
  실행 기록/product-graph-run-<id>.json
  build/graph.json
  build/check.json
  build/check.txt
  build/baseline.json
  build/baseline-content.json
  build/build-context.json
```

- Documents, the policy file, the meaning file, the entry-rule table, approval records, confirmation records (`확인/`) and run records (`실행 기록/`, both described in [Using the product graph](product-graph-usage.md)) are user-owned Canon, like `product-model.json`: Lode reads them and never rewrites them on its own, and they are not in the managed manifest digest.
- `build/` is generated output. It is rebuilt from the files above and the source tree, and it is ignored by Git (a generated storage rule for new Projects, and its own `.gitignore` written on each build for existing ones). `build/baseline.json` is the baseline the build compares with: the first build takes it and only `product-graph-baseline` moves it (see [Using the product graph](product-graph-usage.md)). `build/baseline-content.json` keeps the bounded "before" text that only `changes --list content` shows, and `build/build-context.json` the scope the impact preview compares. Deleting `build/` loses only the list of changes since the baseline and that before/after display; Canon is preserved.
- File names are the original's document names and the node IDs. Korean names are used as is.
- Portable export and import carry the Canon files (not `build/`); importing into an existing Project archives them like other Canon instead of replacing the target's. Folder-copy adoption verifies them and requires them unchanged. Each of the three results says, under `productGraph`, how many documents and approval records it handled, which other user files, that `build/` is not carried, and which names it left out because Lode does not recognise them; a refusal on a differing existing file names that file. Run records are handled like confirmation records in all three and in snapshot GC; a run's output text is stored as the project gave it and a portable export carries it (Lode does not inspect it for secrets). A Project without `실행 기록/` simply has no run evidence. None of these files is a World input: World ids do not change when they change.
- Snapshot GC reads the Canon files as verified roots and skips `build/`. A file or folder in the family that Lode does not recognise is the user's own: never deleted, not a root, not an issue, and named as kept (`productGraphKept`). A recognised file that fails verification, or a link anywhere in the family, still stops the collection.

## Document formats

Each document uses the original's fixed headings. IDs in cells are separated by commas; backticks are optional. A `| 항목 | 내용 |` table holds the document's own facts.

화면설계서 (`화면설계서/<화면 ID>.md`):

```markdown
# CHT-01 대화 화면

## 이 화면이 무엇인가

| 항목 | 내용 |
|---|---|
| ID | CHT-01 |
| 이름 | 대화 화면 |
| IA 묶음 | CHT |
| 공통 영역 | CMN-01 |
| 그리는 코드 | app/ui/chat.py#ChatWindow |
| 추정 | 코드만 보고 쓴 추정 |

## 개요

## 화면 흐름

## 화면요소

| ID | 한 줄 | 위치 | 조작하면 실행되는 기능 | 보여 주는 기능 |
|---|---|---|---|---|
| CHT-01#1 | 보내기 버튼 | app/ui/chat.py:40 | fe/app/ui/chat/ChatWindow@clicked:_send | |
| CHT-01#2 | 대화 목록 | app/ui/chat.py:52 | | fe/app/ui/chat/ChatWindow@effect:_poll |

## 화면 정책

| 정책 | 조건 | 주체 | 행위 |
|---|---|---|---|
| P1 | 보낼 글이 비었다 | 대화 화면 | 보내기 버튼을 막는다 |
```

유저플로우 기획서 (`유저플로우 기획서/<유저 활동 ID>.md`):

```markdown
# UA-CHT-01 대화를 보낸다

| 항목 | 내용 |
|---|---|
| ID | UA-CHT-01 |
| 한 줄 | 대화를 보낸다 |
| 추정 | 화면만 보고 쓴 추정 |

## 무엇을 하는가

## 언제 하게 되나

## 차례

| 차례 | 하는 일 | 화면요소 |
|---|---|---|
| 시작 | 대화 목록을 본다 | CHT-01#2 |
| 1 | 보낸다 | CHT-01#1 |

## 얻는 것

## 다음 활동

- UA-CHT-02
```

The other files:

- 유저 저니맵: a table with columns 단계 and 유저 활동; the 유저 활동 column lists the activity IDs of each stage, in stage order.
- IA 문서: a table with columns 화면, 이름 and IA 묶음.
- 제품 정의서: sections 정체성, 타겟 유저, 제공 가치 and 브랜딩.
- 정책.md: a table with columns ID, 종류 (처리 or 표시), 조건, 주체, 행위 and 지키는 기능.
- 기능 뜻.md: a table with columns 기능 and 뜻.

## Entry rules (호출 방식 표)

One 기능 per entry point. Built-in rules find them; a Project can add rules in `호출 방식 표.json`. Every rule is marked as a judgement (판단) and states its handling as the original does: 따라간다 (emit the 기능 and follow it to its code), 경계로 둔다 (emit it, do not follow), 범위 밖 (do not emit; it is listed).

| 종류 | Found from | ID |
| --- | --- | --- |
| hook | hook configuration JSON of a Claude Code or Codex plugin or project | `hook:<event name>` |
| command | slash command files; skills the user can invoke | `command:<name>` |
| tool | MCP tools, by a project rule (a pattern over named files) | `tool:<name>` |
| cli | `package.json` bin; `pyproject.toml` scripts; subcommand tables by a project rule | `cli:<name>` |
| 프론트 | every place where a UI wires a user's signal to code, in any UI toolkit, by UI binding patterns | `fe/<path>/<component>@<event>:<target>` |

A project rule has 종류, an optional 처리 and 설명, and, for tool and cli, 파일 (paths under the source root), 패턴 (a regular expression whose first group is the name) and an optional 처리 코드: `줄을 감싼 코드` (the default), `파일`, or `항목` (the code the table row names; Lode addition 9). A rule with only 종류 and 처리 changes the handling of the built-in rule, and `source` lists path prefixes to leave out. Any rule may also carry 입구, and a pattern rule 분기 (both below).

Besides `rules`, the table has optional top-level keys: `"내장 이름"` (addition 10), `"손으로 적는 연결"`, `"바깥"` and `"빼는 연결"` (below). A table without them reads as before; an unknown key is still refused. Every rule under these keys is marked 판단.

### 입구 (entry code)

A rule may carry `"입구": [<코드 IDs>]`: the code a 기능 enters through before its 처리 코드, such as a dispatcher that every tool call passes. Every 기능 the rule produces gets a 기능→코드 edge with 역할 "입구"; the handler edge says 역할 "처리". A rule with only 종류 (no 파일 or 패턴) may carry 입구 for every 기능 of its kind. An ID that is not a 코드 node is a rule issue, 규칙이 가리키는 코드가 없음. The rule table Lode's tests use for Lode's own source (`test/fixtures/product-graph/lode-entry-rules.json`) names the MCP and CLI dispatchers as 입구.

Reach starts from both roles everywhere: the list of unreached code, `reach`, `changes`, `impact` and the reach hash. From 입구 the walk does not enter a node that is another 기능's 처리 코드 (that exact node only: a declaration inside a file that is a file-level handler is still entered), so a shared dispatcher does not make every 기능 reach every handler; code this 기능 also reaches through its own 처리 path is reached with via 처리. A stop is never silent: `reach <기능>` and the 기능's node answer print "입구에서 다른 기능의 처리 코드 앞에서 멈춤 N곳" with the stopped nodes and their 기능 (`entryStops` in the data), `tree` names the node and its 기능, and the limits block states the rule. What it can hide: a dispatcher that really calls one 기능's handler as a shared step for the others does not show that path. The baseline keeps each edge's 역할 when it is 입구, so the comparison rebuilds the earlier reach with the same rule.

### 분기 (branches)

A pattern rule whose 처리 코드 is the enclosing code (the default) may carry `"분기": true`, for a function that handles several 기능 in branches. Each 기능 then passes the function's lines minus the branch blocks of the other 기능. A branch block is the statement holding the match: to the matching close bracket in brace languages, from a `case` label to the next case, or to the end of the indented block in Python. The 기능→코드 edge carries those line ranges; reach from that handler follows only references on those lines (deeper code is reached whole), and the references of such a handler record every line they occur on. A match that cannot be delimited gives the whole function and is listed under 분기를 정하지 못함. Without 분기 nothing changes.

### 손으로 적는 연결 (connections written by hand)

Where the scan cannot see a connection, a person can write it as a judged rule: `{"판단": true, "종류": "framework-invoked" | "경계", "파일", "글", "대상": [<코드 IDs>], "설명"}`.

- framework-invoked: every code line of 파일 holding 글 gives a reference from its enclosing code to each 대상, marked as a judgement (`judgement: true`, text "(판단)"). Reach follows it.
- 경계: a boundary edge; reach does not cross it. Queries print "경계에서 멈춤: <설명> → <대상>" under the node where it stops, and `reach <code>` behind a boundary says "경계를 넘으면 닿는 기능 N개 (…)".

글 on no code line, a missing 파일, or a 대상 that is not a 코드 node is a rule issue, "규칙이 낡음 — …", listed and never a build failure.

### 바깥 (naming outside calls)

Calls on names imported from a table of outside modules are recorded as facts: JavaScript `fs`, `fs/promises`, `net`, `http`, `https`, `dgram`, `tls`, `child_process`, `readline`; Python built-in `open`, `os`, `shutil`, `pathlib`, `subprocess`, `socket`, `sqlite3`, `urllib`, `http.client`; and any module a 바깥 rule names. A fact becomes an edge only through a judged rule: `"바깥": [{"판단": true, "이름", "종류": "데이터" | "외부 연결", "닿는 곳": [{"모듈", "파일"?, "줄"?, "선언"?}], "설명"?}]`.

- 데이터: a node `data:<이름>` with read or write by the called api's name; an api in neither list is listed under 읽기·쓰기를 정하지 못함, never guessed.
- 외부 연결: a node `ext:<이름>` and a 코드→외부 연결 edge.
- Facts no rule claims are listed by module and file under 이름 없는 바깥 호출. A fact that two rules claim is a rule issue, unless exactly one of them narrows by 줄 or 선언.

### UI binding patterns (프론트)

A front 기능 is the user's signal through a UI: a click, a key, a change of a control, opening or closing a screen. The toolkit only decides how that wiring is spelled, so the toolkit is data. One mechanism reads every UI binding pattern; no toolkit has code of its own. A pattern is a 프론트 entry of the table with:

- 이름 and 확장자 (which files), and optionally 파일 표시 (a regular expression a file must contain);
- 모양, a regular expression whose named groups are `event`, `target` and optionally `emitter`, or 메서드, a regular expression over method names declared in a class (overridden event methods);
- 코드만 (the match must start in code), 대상 읽기 (식: the target runs to the end of the expression), 이벤트 고정 and 이벤트 바꾸기 (how the event name is written);
- 요소 이름 (where an element's name comes from when the target is not a handler name: the emitting object, the id of the same tag, or the name assigned on the same line);
- 유저 조작 (events that are a user's operation; `*` for every event, with 유저 조작 아님 as exceptions) and 스스로 도는 (events the screen runs by itself).

Lode's built-in patterns are entries of the same table, in the same format, and pass the same check as a Project entry. A Project entry with the same 이름 replaces a built-in one, and a new toolkit is added by writing an entry, with no change to Lode.

| Family | Built-in table entries (each one entry of the same table) | Example wiring |
| --- | --- | --- |
| DOM | `DOM addEventListener`, `DOM on<event> 속성`, `DOM 타이머`, `HTML on<event> 속성` | `button.addEventListener("click", save)` |
| Component templates | `JSX on<Event>`, `React useEffect`, `Vue @event / v-on:`, `Vue onMounted`, `Svelte on:event`, `Svelte onMount` | `onClick={save}` |
| Signal/slot and callback toolkits | `Qt signal.connect`, `Qt <name>Event 메서드`, `Tk command=`, `Tk bind`, `Tk after` | `button.clicked.connect(self.save)` |

Only events in an entry's user-operation list become 기능. Wiring that matches the shape but is not a user's operation (an internal notification, a custom signal, an animation-end event) is recorded as a 코드→코드 callback when its handler resolves and listed under 기능으로 삼지 않은 연결. A file that looks like UI code (by the table's 화면 코드 표시 signs, or named under 화면 파일) but yields no wiring from any pattern is listed under 화면 코드인데 규칙이 없음, so a missing pattern shows as a gap and not as zero 기능.

### Source size (source.제외, source.포함)

The table's optional `source` key takes `"제외"` (path prefixes never walked) and, since graph version 3, `"포함"` (path prefixes never left out as data-like). `제외` wins over `포함` for the same path; a table without `source` reads as before, and an unknown key under it is refused.

```json
{ "schemaVersion": 1, "kind": "LodeProductGraphEntryRules", "rules": [], "source": { "제외": ["recordings"], "포함": ["data/tools"] } }
```

A build counts the files it would read, not every file under the source root: code files (tests left out), UI-binding candidates (the extensions of the UI binding patterns and file signs), hook, command and cli configuration files, `.sql` files and files a rule names. The numbers below are judgement and are stated in the limits block:

- Limit: 50,000 files to read. The walk itself stops after 2,000,000 entries, a safety stop with its own message.
- A folder is data-like when it holds at least 2,000 files of which under 10% would be read or are code (a test file with a code extension counts as code here, so a tests folder is never data-like by that alone). Folders are looked at from the source root's children down; the outermost one that qualifies is taken, and a folder that does not qualify is looked into only when it holds at least 2,000 files. Never the root, a folder a rule names or contains (`파일`, `화면 파일`, the file of an `입구` code ID), or one at or under a `포함` path. Hook, command and cli configuration that a built-in rule finds by its name protects nothing: inside a data-like folder it is a file Lode would have read, counted apart from code.
- Data-like folders are always left out, whatever the number of files to read, and the build goes on (decided by the user on 2026-11-24, replacing an earlier rule that left them out only over the limit). Each is reported with its files, the files Lode would have read, how many of those are code (and configuration), the share, and what it holds by kind from file extensions alone, nothing opened: 문서 (`.md`, `.txt`, `.html`, `.htm`, `.pdf`, `.rst`), 데이터 (`.json`, `.jsonl`, `.csv`, `.tsv`, `.yaml`, `.yml`, `.xml`, `.log`), 이미지 (`.png`, `.jpg`, `.jpeg`, `.bmp`, `.tif`, `.tiff`, `.gif`, `.webp`, `.svg`), 코드 (the code extensions) and 그 밖; the lists are judgement. The two code numbers differ on purpose: "읽었을 코드 파일" counts code files Lode would have read, while 코드 among the kinds ("종류(확장자로)") counts every file with a code extension, tests included. It shows in the limits block ("읽지 않은 데이터 폴더 N개 …, 그 안의 코드 파일 M개도 읽지 않음"), `check.json` (`limits.sourceSize`, `lists.sourceSize`, each folder's `kinds`), `check.txt`, the overview and `gaps`; `graph.json` names the folders in `inputs.leftOutFolders`. `source.포함` brings a folder back (it is then listed as read through 포함). A project that builds today and has such a folder loses the code inside it from the graph once; the comparison names that on the "읽는 범위가 달라짐" line.
- When the files to read still pass the limit after that, the build fails with `PRODUCT_GRAPH_SOURCE_TOO_LARGE`; the message gives the files to read, the limit, the ten heaviest top-level folders (files / files to read) and that `source.제외` leaves a folder out.

## 정합성 검사

One check prints the original's six rows, each with its phrase and meaning:

| 그래프에서 보이는 것 | 뜻 |
| --- | --- |
| 제품코어와 부딪히는 정책 | 정책이나 제품코어 중 하나가 틀렸다 |
| 화면요소 → 기능이 있는데 그 화면요소를 가리키는 유저 활동이 없다 | 기획에 빠진 일이거나 쓰이지 않는 기능 |
| 앞 활동의 화면에서 다음 활동의 화면으로 가는 navigate가 없다 | 막힌 동선 |
| 어떤 유저 활동도 가리키지 않는 화면 | 목적 없는 화면 |
| 화면 정책 절과 정책 노드가 다르다 | 둘 중 하나가 낡았다 |
| 유저 활동의 다음 활동과 유저저니 순서가 다르다 | 둘 중 하나가 낡았다 |

Each row ends in exactly one of: findings with node IDs and positions, 0건, or 검사 못 함 with its reason. 0건 is printed only when at least one comparison was made.

- 제품코어 against 정책 is not decided by machine: the check prints both side by side for a reader.
- navigate is not extracted in this version, so that row always says why it could not run.
- The 화면 정책 row compares, by 정책 ID, the condition, actor and action written in the screen document with the policy line, and flags a 처리 policy listed as a screen policy.
- The journey row needs a 유저 저니맵 that lists activity IDs per stage. It flags a 다음 활동 that sits in an earlier stage, or an activity missing from the journey.

It also lists, with counts: IDs a document cites that do not exist; 기능 that no 화면요소 or 화면 points to; code no 기능 reaches (어느 기능에서도 닿지 않는 코드); unresolved calls by reason; files not read as code; 뜻 lines whose 기능 no longer exists (사라진 기능의 뜻); 기능 whose code did not resolve, with the reason; wiring not taken as 기능 (기능으로 삼지 않은 연결); files that look like UI code but match no pattern (화면 코드인데 규칙이 없음); every site read as running a file by its path (경로로 실행으로 읽은 곳, with paths that match several files counted as 경로가 여러 파일에 맞음); rule issues (규칙이 가리키는 코드가 없음, 규칙이 낡음 — …); 기능 whose branch could not be delimited (분기를 정하지 못함); outside calls no 바깥 rule names (이름 없는 바깥 호출) and named data whose access could not be told (읽기·쓰기를 정하지 못함); the run and evidence lists (see Run records below); node counts per type, with what the 데이터, 외부 연결 and DB counts cover (뽑지 않음 only for 계측 이벤트); and each document's status. Before all of this comes one block, 이 그래프가 답하지 못하는 것 (Lode addition 6).

## Approval

Only documents the user approved count as the product description. A document (or the policy file) is 승인 only while an approval record exists for its current text digest; editing it makes it 추정 again until it is approved again, and the check shows it as 승인 뒤 바뀜, apart from a document never approved.

The approval digest is taken over the document's text, not its bytes, because the user approved what the document says: decode the bytes as UTF-8, drop one leading BOM, turn every CRLF and lone CR into LF, normalise to NFC, and take SHA-256 of the UTF-8 bytes of the result. Nothing else is normalised: trailing spaces, a final newline, blank lines and every visible character still change it. The record names this basis in `digestBasis`. Other digests (generated files, export and import integrity, the GC inventory) stay raw-byte digests. A status word typed into a document proves nothing. An unapproved document carries which estimate it is, written in its `| 항목 | 내용 |` table as 추정: 코드만 보고 쓴 추정 or 화면만 보고 쓴 추정. By default the check uses approved documents only; with the estimate option it also uses 추정 documents and labels every finding that rests on one.

## Code layer and its precision

The 코드 layer reuses Lode's regex-based source analysis (the same scan as the repository World Model): one node per file and per declaration, with line range and kind. It is not a syntax tree, so:

- A declaration's range is a line range. A JavaScript or TypeScript function's body is the `{` after its parameter list, which is closed by its partner bracket, so a `{` in a default or a destructured parameter is not the body. A return type is read past its type literals, and a declaration with no `{` after its parameter list (an overload, a `declare`) is one statement. A parameter list that does not close keeps the older reading (the first `{` after the name); the limits block counts those as "매개변수 목록이 닫히지 않아 함수 범위를 예전 방식(이름 뒤 첫 `{`)으로 읽은 선언 N개", also when there are none.
- A 코드→코드 call is recorded only when the callee resolves to exactly one declaration or called value binding (same file, a `self.` or `this.` method of the enclosing class, or a name imported from a resolved module, with the further lexical rules of addition 10). Every other call is counted as unresolved.
- Python: a name imported from a package (`from pkg import mod`, `from pkg import mod as x`, `from . import mod`, `from .sub import mod`) is a module when the package's `__init__.py` has no declaration, value or re-export of that name and `pkg/mod.py` or `pkg/mod/__init__.py` is a read file; a declaration in the package wins, as in Python. Such a name resolves like a namespace import: `x.f()` to the module's function, `x.Store()` to the class and its constructor, `v = x.Store()` assigned once in a function and then `v.add()` to the method, and `x.f` used as a value to a callback. A longer dotted name (`pkg.mod.f()` after `import pkg.mod`, `sub.mod.f()` after `from pkg import sub`) walks modules one segment at a time while each step is a read file and resolves the rest by the two-part rules; when it does not walk modules from its head it stays unresolved, never resolved through the import of a later segment. The scan keeps only the last two segments of a callee, so the leading ones are read from the call's own line, and only when every use of that call on the line has the same ones; when one follows an expression (`obj.mod.f()`, `make().mod.f()`, a line starting `.mod.f(`), the name is a member of something else and the call is a method call on a receiver of unknown type. A name a package neither declares nor has as a read module, and a Python import whose module is not among the read files, are counted under their own reason with the scan-range hint. An import inside a function is read as an import of the whole file.
- Method calls on an instance attribute (`self.attr.method()`, `this.attr.method()`) resolve only when the class's own code says which class the attribute holds: every assignment in the class constructs the same product class (`self.attr = Name(…)`, a class-body `attr = Name(…)`, `this.attr = new Name(…)`, a field `attr = new Name(…)`, also `#attr`), the attribute has a declared type (`self.attr: Name`, a class-body `attr: Name`, a TypeScript field `attr: Name`, a constructor parameter property), or it is assigned a parameter with a declared type in the same method. `None`, `null` and `undefined` assignments are skipped; `Optional[Name]`, `Name | None`, `Name | null | undefined` and a quoted `"Name"` mean `Name`. All evidence must name one class, else the call stays a method call on a receiver of unknown type. A construction counts only when it is the whole assigned expression (anything after its closing bracket, such as `.build()`, `if … else`, `or`, `||` or `??`, makes it unknown), and every place in the class where the attribute is an assignment target (one of several targets, `with … as`, `for`, augmented assignments such as `+=` or `??=`) must be one of the forms above, else the attribute is unknown. Only assignments inside the class are seen (an attribute set from outside, or through `setattr` or `Object.assign`, is not), the attribute is looked up in the enclosing class only (a class with a base that does not assign it gives the inherited reason), and when the declared class is a base class or protocol the edge goes to its method, not to subclasses' implementations. Longer chains (`self.a.b.m()`), an attribute copied to a local first and a call of the attribute itself are not read. In JavaScript and TypeScript the receiver is read on the call's line, only when every such call there follows `this.` directly.
- Answers say where a path was lost, in two kinds kept apart: calls by name (every reason that could be product code but an unknown receiver) and method calls on a receiver of unknown type. Every member name the product defines makes every call of that name on an unknown receiver count in the second kind, built-in types' methods included. Every code node keeps, in an optional `unresolvedCalls` field of `graph.json` that takes no part in any hash, the calls made in it (`made`: the count of calls by name per reason, their first five callees with lines, and every method name of the second kind with its count and first line) and, counted exactly from all unresolved calls, those that may be the declaration (`mayBeThis`). `reach` and a 기능's node answer say "이 길에서 못 푼 호출 (제품 코드일 수 있음) — 이름으로 부른 것 N곳, 받는 쪽 타입을 모르는 메서드 호출 M곳: 닿는 범위가 실제보다 좁을 수 있다" (on every page of a reach), then the five nodes with the most calls by name and five method names, rarest first: fewest calls of that name on unknown receivers in the whole build (`referenceSummary.unresolvedMethodNames` in `graph.json`), each with its count here, the build-wide count and an example place, so a distinctive method called once is not hidden behind `get` or `append`. `tree` gives every code row with such calls a row under it with both counts and five names, calls by name first, then method names rarest first. A declaration with no resolved caller says, in `up`, `reach`, its node answer and `impact`, "이 선언일 수 있는 못 푼 호출 N곳" with up to five places: bare calls of its name when it can be called by that name (not a member of a class or object literal; a name of the built-in name table and a call of a parameter or local never count), and, when it is a member of a class or object literal, calls of its name on a receiver of unknown type with "받는 쪽 타입을 모름, 같은 이름의 선언 K개" (K counts such members; left out when it is 1). That line is a possibility: it creates no edge and leaves reach as it is. A method name a built-in type also has (`get`, `append`) cannot be told apart from the product's own, so such a declaration may show many possible calls.
- Three reference kinds are recorded: call, callback and framework-invoked. The kinds the scan cannot tell apart (render, type reference, re-render, response, enqueue, navigate, http, defines) are not recorded.
- callback is recorded for UI wiring that is not taken as 기능, and for a function used as a value. Such a use is an identifier that is not called, declared, imported, exported in a list, a property key or after a dot, and that resolves to one function or class declaration by the call rules. Members resolve only where a call would: `this.x` or `self.x` inside a class, static `C.x` on a product class, and `name.x` on a module-level object literal or a namespace import. Shorthand properties (`{ run }`) count. Parameters and locals are not resolved. TypeScript type positions (after `:` or `satisfies`), text inside `<…>`, decorators and `const { … } = require(…)` are not uses. The limits block counts "값으로 쓴 함수 N곳(이름 a, 멤버 b)" apart from calls.
- framework-invoked is recorded in two shapes. First, a code string or template literal that ends with the path of exactly one scanned code file (the full relative path, or a suffix starting at `/`), only when that literal is handed to a call that runs or loads it: a dynamic import; a process start (`spawn`, `spawnSync`, `fork`, `exec`, `execFile` and their sync forms; Python `subprocess.run`, `Popen`, `call`, `check_call`, `check_output`, `os.system`, the `exec` family, `runpy`); a `Worker`; or any call that also passes `process.execPath` or `sys.executable`. Path builders (`join`, `resolve`, `URL` and the like), arrays and objects are looked through. A literal with whitespace is a command line: its path counts only as the program itself or as the script after a language's own runner (`node`, `python` and the like, flags skipped), so `"git add src/x.js"` gives nothing. Second, a JavaScript or TypeScript `import "<relative path>"` with no bindings. A path that fits two files gives no edge and is counted (경로가 여러 파일에 맞음). Import, export and require specifiers are not read this way, and a file never refers to itself. Paths held in a constant and passed later, injection, decorators and routes decided by file names are not seen. Every site is listed under 경로로 실행으로 읽은 곳, so a wrong one can be reported. (An earlier rule took any literal that names a file; a 30-edge sample on Lode's own code found 15 that were only mentions, so the rule was narrowed to literals that are run or loaded.)
- JavaScript class methods are declarations (addition 10), but UI wiring inside one still takes the enclosing class as its component, and wiring inside a member of an object literal takes the enclosing function or the file name, so 프론트 IDs are what they were.
- UI wiring is found only by the patterns' regular expressions. Wiring spread over several lines, built from strings, connected automatically by name by a toolkit, or whose event name is computed at run time is not seen. For an entry marked 코드만, a character-level lexer decides what is code: in JavaScript, TypeScript and Python files a match inside a comment or a string (multi-line strings and template literals included) is dropped; in HTML, Vue and Svelte files only `<!-- -->` comments are; JSX `on<Event>={…}` attributes are not filtered. The lexer is not a parser and recognises a regular expression literal from the character before it. The id of the same tag is looked for between the nearest `<` and `>`, so a `>` inside an attribute can mislead it. An overridden event method is recognised by its name; whether its class really inherits from a UI class is not checked.
- Handlers in HTML, Vue and Svelte files are not resolved to code, because those files are not part of the source analysis; their 기능 are listed under 처리 코드를 찾지 못한 기능.
- 데이터 is read from environment variables only as `process.env.NAME`, `process.env["NAME"]`, `os.environ["NAME"]`, `os.environ.get("NAME")` and `os.getenv("NAME")`, each giving `data:env:NAME` with a read edge, or a write edge for an assignment to it or a `delete` of it; `const { NAME } = process.env` reads each name it takes. An environment object passed on under another name is not followed. Other 데이터 and every 외부 연결 come only from 바깥 rules; nothing is guessed from a call alone.
- DB is read from `CREATE TABLE` in a code string or a `.sql` file: `db:<table>` and `db:<table>.<column>` with 포함. A table counts only in its verb's own position, decided per table: `FROM <t>` or `JOIN <t>` reads; `INSERT INTO <t>`, `REPLACE INTO <t>`, `UPDATE <t> … SET` and `DELETE FROM <t>` write (so `INSERT INTO a SELECT … FROM b` writes a and reads b). A code string is a SQL site only when a verb stands in its own position followed by a name; each such string is listed under SQL로 읽은 곳, each name as read, write, or 표를 모름 when no `CREATE TABLE` made it (a real gap: the table exists somewhere the reading does not see). A string that only holds a verb word, like an English sentence, is not a site. Tables made any other way are not seen. Tables and data have no meaning lines.
- The node counts print numbers for 데이터, 외부 연결 and DB with what each covers. 계측 이벤트, navigate and C4 grouping are not extracted; the output says 뽑지 않음 for them instead of zero.

### Code no 기능 reaches

The original's 코드 definition asks for a list of the code that cannot be reached from the code handling any 기능 by following reference. Lode prints it as 어느 기능에서도 닿지 않는 코드:

- The walk starts from every 기능's resolved 처리 코드 and its 입구 code, and follows the resolved call, callback and framework-invoked references (judged ones included), transitively. It does not cross a 경계, and from 입구 it does not enter another 기능's 처리 코드. From a handler with 분기 it follows only the references on that 기능's lines.
- A handler that is a whole file (a hook script, a command file, a bin script) reaches that file and the calls made at its top level; a declaration in that file is reached only through a resolved reference. Reaching a class reaches its constructor (`__init__` or `constructor`).
- Every declaration not visited is listed. Files where nothing is reached are told apart from unreached declarations inside a file that is otherwise reached.
- The list is bounded by the references: its head gives the resolved calls out of all calls, and 닿지 않음 means that no resolved path was found, not that the code is dead. Whether an entry is a missing 기능 or dead code is a reader's judgement; the script gives no reason it did not find.

## Run records and evidence for 기능→화면요소

Lode runs nothing. A project can hand it what it ran (`product-graph-runs-add`, see [Using the product graph](product-graph-usage.md)); each run is stored with the 기능's content and reach hash from the build of that moment and the way code was read, so a run made on older code never becomes evidence for today's code. Runs are shown as `R<record short id>-<n>`.

Each build derives 기능→화면요소 edges from evidence, next to the rows of the 화면설계서:

- **Quoted phrases.** A 화면요소 row's phrases are the backtick segments of its 한 줄 cell with at least 4 literal characters; `<…>` and `…` inside one match any text. A row with a phrase of 10 or more literal characters ignores its shorter ones.
- **Run evidence.** A phrase found in the output of a current run gives an edge from that run's 기능, with 근거 "실행 <ids>".
- **Code evidence.** For an element no run matched, or whose row names a 보여 주는 기능 (the document then narrows the 기능 it may be, never widens), a phrase found in a code string literal, or at the uses of a module-level constant holding it, gives an edge from the 기능 that reach that code, with 근거 "코드 <file>:<line>". Uses of such a constant that do not resolve are listed.
- The row's own 보여 주는 기능 keeps 근거 "문서". An edge lists every kind of evidence it has.
- A judged rule `"빼는 연결": [{"판단": true, "기능", "화면요소", "이유"}]` in the entry-rule table removes a wrong machine edge (the document's own edge stays). A rule that matches no machine edge is a rule issue, 규칙이 낡음.

Machine edges follow the document's status (승인 or 추정), are evidence and not approval, never change a document, an approval or a 확인 record, are in no 다시 볼 것 list, and are derived again on every build. The check lists 문서에만 있음(실행·코드 근거 없음), 실행·코드에만 있음(문서에 없음), 이어지지 않은 화면요소 with the reason, unresolved constant uses, and machine edges removed by a rule.

A run whose 기능 changed since it was recorded (content, reach or the way code is read) gives no edge and is listed as 실행 뒤 코드가 바뀜; a newer run with the same 기능 and the same 실행 label replaces the older one. The limits block says that Lode ran nothing and which run records it read.

## Reader version 2

The 입구, framework-invoked, value-use, 데이터·외부 연결·DB and 분기 reading change how code is read (`PRODUCT_GRAPH_VERSION` 1 → 2), so the first build after the update compares with a baseline read the old way. That build tells the reader's differences apart from real changes; see [Using the product graph](product-graph-usage.md) for what it shows and how to take a new baseline.

## Reader version 3

Python calls through a module imported by name, the optional `unresolvedCalls` node field and the reading range change how code is read (`PRODUCT_GRAPH_VERSION` 2 → 3). The first build after the update compares with a baseline read the old way: reach that differs only in files whose text is the baseline's is counted as the reader's, never as 닿는 코드가 바뀜 or 다시 볼 것, and confirmation records show "다른 방식으로 읽은 때 확인함" until they are confirmed again. A folder now left out as data-like that the baseline read, or a data-like folder read now through `source.포함` of which the baseline read no file, is named on its own line, "읽는 범위가 달라짐: …", with the nodes that leave or come only because of it and the 기능 whose reach moves only there; none of them is 신규, 사라짐 or 닿는 코드가 바뀜. See [Using the product graph](product-graph-usage.md).

## Lode additions approved by the user on 2026-11-15

These are additions to the original, approved by the user, and are not in the original page.

1. **The 프론트 ID in any UI toolkit.** The original writes its 프론트 rule with React as the example. Lode applies the same rule to any UI toolkit: `<component>` is the enclosing component, class or function, or the file's own name for file-level wiring; `<event>` is the event or signal name as the toolkit spells it (`click` for `onClick`, `clicked`, `Button-1`), and for an overridden event method the method name without its `Event` suffix (`close`); `<target>` is the handler name, else the element's id or the emitting object's name, else `요소#순번`. What a screen runs by itself (`useEffect`, `DOMContentLoaded`, a timer) is `@effect:<name>`. The built-in pattern table above lists, per toolkit, examples of this one rule.
2. **Machine peers.** A machine peer (another service, a controller, a device) is an 외부 연결, not a user.
3. **Evidence for a product that was not run.** Evidence is a code position (file and line) only, the document is marked 코드만 보고 쓴 추정, and no run evidence is invented. Run evidence comes only from run records the project hands over.
4. **유저 활동 ID.** `UA-<묶음 앞머리>-<번호>`.
5. **Skills.** Skills the user can invoke count as command.
6. **이 그래프가 답하지 못하는 것.** Build and check text start with one fixed block, and the structured result and the generated files carry the same object (`limits`): how the code was read (a regex scan, no syntax tree, no types), the calls in three numbers (addition 10), the reference kinds written (call, callback, framework-invoked) and those not told apart, which framework-invoked shapes are read, the functions used as values (counted apart from calls), what is read for 데이터, 외부 연결 and DB with its counts, the node types and edges not extracted, the limits of the UI binding scan, that nothing was run (and, when there are run records, how many were read and how many still hold), and how many documents are 승인 and 추정 and which this run used. These facts are not repeated elsewhere in the text.
7. **Unresolved calls by reason.** Each unresolved call is counted under exactly one reason the scan determined: several declarations of the same name; a language keyword read as a call; no declaration of that name anywhere in the scanned code; a name imported from outside the product; a receiver of unknown type (including a method called on an expression, read from the call's own line); a declaration only in another file with no import linking it; and an explicit rest reason for anything else. The reasons add up to the total, and each has one line saying what would settle it. Files under the source root that are not read as code are counted by extension as not looked at, apart from code that was read. A 기능 whose handler did not resolve says why.
8. **Identity and preservation.** A node ID is the name structure and never contains a line number; file, line range and digest are attributes. A declaration whose qualified name repeats in its file, whatever its kind, gets `~<n>`, its order among those declarations in the file; it moves only when a same-named declaration is added, removed or reordered before it, and the first one gains `~1` when a second appears. `요소#순번` in a 프론트 ID is the original's own fallback and stays. `기능 뜻.md` and `정책.md` are never rewritten, reordered or trimmed by a build. A renamed 기능 gets a new ID: its old 뜻 line stays as written and is listed under 사라진 기능의 뜻 so a person can move it, and a 정책 line citing the old ID appears among the cited IDs that do not exist.
9. **처리 코드 from a table row.** Many products register entry points as rows of a table: an array of objects, a name → handler map, or a chain of registration calls. A tool or cli rule with `"처리 코드": "항목"` takes the 기능's 처리 코드 from its own row. The row is found with the code mask: the direct element of the outermost list, object or dict literal that holds the match (not crossing a function, class or block body); without such a literal, the statement that holds it, including call-chain lines that start with `.`, never reaching outside the innermost function, class or block body (two registration calls in one callback are two rows); when the match's line is a decorator line (it starts with `@`, whether the pattern starts with `@` or after it), the definition it decorates, skipping blank lines and other decorators. A JavaScript or TypeScript decorator counts only when the scan has the decorated definition as a declaration (a class method is one). In a statement row, the statement's own call chain (the registering call, such as `registry.register(…)` or `program.command(…).action(…)`) is not read as a handler, even when it is product code; its arguments are. The row is read like a function body: a name that resolves to one declaration (a function named as a value, a call inside an inline function), a `namespace.member` through an import, and a member taken in the same expression from a dynamic import with a literal path (`import("./x.mjs").then((m) => m.run)`, `.then(({ run }) => …)`, `(await import("./x.mjs")).run`, `const { run } = await import("./x.mjs")`). That dynamic-import form is read as a call wherever calls are read; a dynamic import with a non-literal path or no member named is counted under its own unresolved reason. Python dynamic imports (`importlib`) are not read. A row in which nothing resolves puts the 기능 among those whose code did not resolve, with the reason. A row in which some names resolved but a dynamic import did not keeps the resolved handlers and is also listed as partly resolved, with the dynamic-import reason. Known weakness: two 기능 found in the same row share the row's code. A 기능 found in more than one row keeps every row's handlers and is listed with its positions, so a pattern that also matches a mention shows up.
10. **Call precision.** The scan says what a call is, and resolves the calls it can resolve without types.
    - **Import lists in any layout.** An import list spread over lines, with a trailing comma or comments inside, gives the same bindings as the same list on one line, and so does a default import with a namespace import. In Python, a parenthesised list over lines and a line continued with a backslash read the same as one line.
    - **Members are declarations.** A method of a JavaScript or TypeScript class body (ordinary, async, static, generator, getter, setter, private) and a class field holding a function are declarations with the qualified name `<Class>.<method>`, as a Python method already was. A class expression bound to a name (`const A = class {`) is a class of that name, and an anonymous default class is the class `default`. A function-valued member of an object literal bound to a module-level name (`const api = { run() {…}, stop: () => {…} }`) is a declaration with the qualified name `<binding>.<member>`. Nested object literals, literals not bound to a module-level name, and quoted or computed names (`[Symbol.iterator]() {`) are not declarations. A method definition (`name(…) {`) and a TypeScript signature without a body (`abstract render(): void;`, overloads, interface members) are not counted as calls.
    - **Receivers, lexically.** `this.x(` (Python `self.x(`) inside a method or class field resolves to the class's member; when the class does not define it but extends another class or has it only as a signature without a body, the call is counted as possibly inherited (inheritance is not followed). `C.x(` resolves to a static method of a product class (any method in Python). `name.x(` resolves to a member of an object literal bound to that name, in the file or through an import. `v.x(` resolves when `v` is created once in the same function or at module level by `const v = new C(…)` (Python `v = C(…)`, assigned once); a reassigned variable is not inferred. Python `cls(…)` in a classmethod is a call of its class. Nothing is resolved because a name is unique in the product.
    - **Construction.** `new C(…)` is a reference to C, so reaching it reaches the constructor; it is read by the product graph, not added to the shared scan's call facts, which stay calls. A built-in class or one from outside the product falls under that reason. A TypeScript call with explicit type arguments (`make<T>(x)`) is not seen as a call.
    - **Value bindings.** A module-level binding to a value that is not a function expression (`const fail = failWith("X")`) becomes a 코드 node of kind `값`, ID `<file>#<name>`, when it is called somewhere in the scanned code; calls resolve to it, and its references are the calls in its initialiser, so reach continues through the factory. A value binding nobody calls is not a node.
    - **Re-exports.** A name imported from a module that does not declare it is followed through `export { a as b } from`, `export * from`, a local export list naming an import (`export { j }`) and the default export (`export { default } from`), and in Python through a name the package module imports, to the declaration. The steps are bounded and a cycle keeps its reason; `export * as ns from` is not read.
    - **Built-in calls.** Three reasons are decided mechanically: a member of a language or runtime namespace (`JSON.parse(x)`), a built-in function or constructor (`String(x)`), both only when the file does not declare, import or bind that name; and a method whose name is defined nowhere in the product (`items.map(f)`), which cannot be product code. "Defined" is a deliberately wide net: any method, class field, member of any object literal, signature, quoted name, function assigned to a property or a prototype, or defineProperty name in the scanned code, whether or not it is a declaration. Names built at run time (`obj[name] = fn`) are not seen. A product that defines its own `map` keeps that call under the unknown-receiver reason. The names are a judgement (판단) per language, extended by a project rule under `"내장 이름"` in `호출 방식 표.json`. JavaScript and TypeScript namespaces: Array, ArrayBuffer, Atomics, BigInt, Boolean, Buffer, Date, Error, Intl, JSON, Map, Math, Number, Object, Promise, Proxy, Reflect, RegExp, Set, String, Symbol, URL, WeakMap, WebAssembly, console, crypto, document, globalThis, navigator, performance, process, window. Functions and constructors: AbortController, AggregateError, Array, ArrayBuffer, BigInt, Blob, Boolean, DataView, Date, Error, Event, EventTarget, Float32Array, Float64Array, FormData, Headers, Int16Array, Int32Array, Int8Array, Map, Number, Object, Promise, Proxy, RangeError, ReferenceError, RegExp, Request, Response, Set, String, Symbol, SyntaxError, TextDecoder, TextEncoder, TypeError, URIError, URL, URLSearchParams, Uint16Array, Uint32Array, Uint8Array, Uint8ClampedArray, WeakMap, WeakRef, WeakSet, atob, btoa, clearImmediate, clearInterval, clearTimeout, decodeURI, decodeURIComponent, encodeURI, encodeURIComponent, eval, fetch, isFinite, isNaN, parseFloat, parseInt, queueMicrotask, require, setImmediate, setInterval, setTimeout, structuredClone. Python namespaces: bytes, dict, float, int, list, object, set, str, tuple, type. Functions and constructors: ArithmeticError, AssertionError, AttributeError, BaseException, Exception, FileNotFoundError, ImportError, IndexError, KeyError, LookupError, NotImplementedError, OSError, PermissionError, RuntimeError, StopIteration, TimeoutError, TypeError, UnicodeDecodeError, ValueError, abs, all, any, bool, bytearray, bytes, callable, chr, classmethod, delattr, dict, dir, divmod, enumerate, filter, float, format, frozenset, getattr, globals, hasattr, hash, hex, id, input, int, isinstance, issubclass, iter, len, list, locals, map, max, memoryview, min, next, object, oct, open, ord, pow, print, property, range, repr, reversed, round, set, setattr, slice, sorted, staticmethod, str, sum, super, tuple, type, vars, zip.
    - **A function in a parameter or local.** A plain call whose name is a parameter or local variable of an enclosing function (`handler()`) is counted under its own reason and makes no edge; what it holds needs data-flow analysis.
    - **Three numbers.** The limits block gives all calls; the calls that cannot be product code (built-in reasons and language keywords) and those into modules outside the product; and, of the calls that can be product code, how many resolved. Every call is still counted under exactly one reason, and the reasons add up to all. The unknown-receiver reason now means only that the method name exists in the product and the receiver is unknown.

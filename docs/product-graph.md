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
| 데이터 | A value code reads or writes that is not a database | code (뽑지 않음 in this version) |
| 외부 연결 | A place where code calls a service outside the product | code (뽑지 않음 in this version) |
| DB | Tables and columns | code (뽑지 않음 in this version) |
| 계측 이벤트 | An event code sends to an analytics tool | code (뽑지 않음 in this version) |

For a product without screens (a CLI, a plugin, a library), one kind of output the user receives (command output, a tool result, text a hook adds, an error message) is a 화면, and one part of that output is a 화면요소.

## Where each node comes from

- Nodes from code (기능, 코드) are produced only from the source tree, by script. The same input gives byte-identical output.
- Nodes from documents (제품코어, 유저저니, IA, 유저 활동, 화면, 화면요소) come only from the documents the user writes.
- Two things are written directly: one rule line per 정책, and one meaning line per 기능 (kept in its own file, apart from script output).
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

## Edges

An edge name is the two node types joined by `→`: 유저 활동→화면요소, 유저 활동→유저 활동, 화면→화면요소, 화면→화면, 화면→정책, 화면→코드, 화면→기능, 화면요소→화면요소, 화면요소→기능, 기능→화면요소, 정책→기능, 기능→코드. The original's three exceptions keep their own names: 포함, the 코드→코드 reference kinds (call, callback, framework-invoked, render, type reference, re-render, response, enqueue, navigate, http, defines), and read / write. No other edge name is used.

Every document edge comes from an ID cited in a document; nothing is inferred from wording.

- A step of 차례 cites 화면요소 IDs (유저 활동→화면요소); 다음 활동 cites 유저 활동 IDs.
- A 화면요소 row cites the 기능 it runs when operated (화면요소→기능) and the 기능 whose result it shows (기능→화면요소).
- The 화면 정책 section cites 정책 IDs (화면→정책); 공통 영역 cites other 화면 (화면→화면); 그리는 코드 cites 코드 IDs (화면→코드).
- 화면→기능 is added for each `@effect` 기능 of the class a 화면 cites as its drawing code.
- 기능→코드 links each 기능 to the code that receives it, when that resolves.

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
  build/graph.json
  build/check.json
  build/check.txt
```

- Documents, the policy file, the meaning file, the entry-rule table and approval records are user-owned Canon, like `product-model.json`: Lode reads them and never rewrites them on its own, and they are not in the managed manifest digest.
- `build/` is generated output. It is rebuilt from the files above and the source tree, and it is ignored by Git (a generated storage rule for new Projects, and its own `.gitignore` written on each build for existing ones).
- File names are the original's document names and the node IDs. Korean names are used as is.
- Portable export and import carry the Canon files (not `build/`); importing into an existing Project archives them like other Canon instead of replacing the target's. Folder-copy adoption verifies them and requires them unchanged. Each of the three results says, under `productGraph`, how many documents and approval records it handled, which other user files, that `build/` is not carried, and which names it left out because Lode does not recognise them; a refusal on a differing existing file names that file. None of these files is a World input: World ids do not change when they change.
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

A project rule has 종류, an optional 처리 and 설명, and, for tool and cli, 파일 (paths under the source root) and 패턴 (a regular expression whose first group is the name). A rule with only 종류 and 처리 changes the handling of the built-in rule, and `source` lists path prefixes to leave out.

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

It also lists, with counts: IDs a document cites that do not exist; 기능 that no 화면요소 or 화면 points to; code no 기능 reaches (어느 기능에서도 닿지 않는 코드); unresolved calls by reason; files not read as code; 뜻 lines whose 기능 no longer exists (사라진 기능의 뜻); 기능 whose code did not resolve, with the reason; wiring not taken as 기능 (기능으로 삼지 않은 연결); files that look like UI code but match no pattern (화면 코드인데 규칙이 없음); node counts per type (뽑지 않음 where it applies); and each document's status. Before all of this comes one block, 이 그래프가 답하지 못하는 것 (Lode addition 6).

## Approval

Only documents the user approved count as the product description. A document (or the policy file) is 승인 only while an approval record exists for its current text digest; editing it makes it 추정 again until it is approved again, and the check shows it as 승인 뒤 바뀜, apart from a document never approved.

The approval digest is taken over the document's text, not its bytes, because the user approved what the document says: decode the bytes as UTF-8, drop one leading BOM, turn every CRLF and lone CR into LF, normalise to NFC, and take SHA-256 of the UTF-8 bytes of the result. Nothing else is normalised: trailing spaces, a final newline, blank lines and every visible character still change it. The record names this basis in `digestBasis`. Other digests (generated files, export and import integrity, the GC inventory) stay raw-byte digests. A status word typed into a document proves nothing. An unapproved document carries which estimate it is, written in its `| 항목 | 내용 |` table as 추정: 코드만 보고 쓴 추정 or 화면만 보고 쓴 추정. By default the check uses approved documents only; with the estimate option it also uses 추정 documents and labels every finding that rests on one.

## Code layer and its precision

The 코드 layer reuses Lode's regex-based source analysis (the same scan as the repository World Model): one node per file and per declaration, with line range and kind. It is not a syntax tree, so:

- A 코드→코드 call is recorded only when the callee resolves to exactly one declaration (same file, a `self.` or `this.` method of the enclosing class, or a name imported from a resolved module). Every other call is counted as unresolved.
- Reference kinds the scan cannot tell apart (framework-invoked, render, type reference, re-render, response, enqueue, navigate, http, defines) are not recorded. callback is recorded only for UI wiring that is not taken as 기능.
- JavaScript class methods are not declarations to this scan, so wiring inside one takes the enclosing class or function, or else the file name, as its component.
- UI wiring is found only by the patterns' regular expressions. Wiring spread over several lines, built from strings, connected automatically by name by a toolkit, or whose event name is computed at run time is not seen. For an entry marked 코드만, a character-level lexer decides what is code: in JavaScript, TypeScript and Python files a match inside a comment or a string (multi-line strings and template literals included) is dropped; in HTML, Vue and Svelte files only `<!-- -->` comments are; JSX `on<Event>={…}` attributes are not filtered. The lexer is not a parser and recognises a regular expression literal from the character before it. The id of the same tag is looked for between the nearest `<` and `>`, so a `>` inside an attribute can mislead it. An overridden event method is recognised by its name; whether its class really inherits from a UI class is not checked.
- Handlers in HTML, Vue and Svelte files are not resolved to code, because those files are not part of the source analysis; their 기능 are listed under 처리 코드를 찾지 못한 기능.
- 데이터, 외부 연결, DB, 계측 이벤트, navigate and C4 grouping are not extracted; the output says 뽑지 않음 for them instead of zero.

### Code no 기능 reaches

The original's 코드 definition asks for a list of the code that cannot be reached from the code handling any 기능 by following reference. Lode prints it as 어느 기능에서도 닿지 않는 코드:

- The walk starts from every 기능's resolved handler and follows the resolved call and callback references, transitively.
- A handler that is a whole file (a hook script, a command file, a bin script) reaches that file and the calls made at its top level; a declaration in that file is reached only through a resolved reference. Reaching a class reaches its constructor (`__init__` or `constructor`).
- Every declaration not visited is listed. Files where nothing is reached are told apart from unreached declarations inside a file that is otherwise reached.
- The list is bounded by the references: its head gives the resolved calls out of all calls, and 닿지 않음 means that no resolved path was found, not that the code is dead. Whether an entry is a missing 기능 or dead code is a reader's judgement; the script gives no reason it did not find.

## Lode additions approved by the user on 2026-11-15

These are additions to the original, approved by the user, and are not in the original page.

1. **The 프론트 ID in any UI toolkit.** The original writes its 프론트 rule with React as the example. Lode applies the same rule to any UI toolkit: `<component>` is the enclosing component, class or function, or the file's own name for file-level wiring; `<event>` is the event or signal name as the toolkit spells it (`click` for `onClick`, `clicked`, `Button-1`), and for an overridden event method the method name without its `Event` suffix (`close`); `<target>` is the handler name, else the element's id or the emitting object's name, else `요소#순번`. What a screen runs by itself (`useEffect`, `DOMContentLoaded`, a timer) is `@effect:<name>`. The built-in pattern table above lists, per toolkit, examples of this one rule.
2. **Machine peers.** A machine peer (another service, a controller, a device) is an 외부 연결, not a user.
3. **Evidence for a product that was not run.** Evidence is a code position (file and line) only, the document is marked 코드만 보고 쓴 추정, and no run evidence is invented.
4. **유저 활동 ID.** `UA-<묶음 앞머리>-<번호>`.
5. **Skills.** Skills the user can invoke count as command.
6. **이 그래프가 답하지 못하는 것.** Build and check text start with one fixed block, and the structured result and the generated files carry the same object (`limits`): how the code was read (a regex scan, no syntax tree, no types), resolved calls out of all calls, the reference kinds written (call, callback) and those not told apart, the node types and edges not extracted, the limits of the UI binding scan, that nothing was run and no finding rests on execution, and how many documents are 승인 and 추정 and which this run used. These facts are not repeated elsewhere in the text.
7. **Unresolved calls by reason.** Each unresolved call is counted under exactly one reason the scan determined: several declarations of the same name; a language keyword read as a call; no declaration of that name anywhere in the scanned code; a name imported from outside the product; a receiver of unknown type (including a method called on an expression, read from the call's own line); a declaration only in another file with no import linking it; and an explicit rest reason for anything else. The reasons add up to the total, and each has one line saying what would settle it. Files under the source root that are not read as code are counted by extension as not looked at, apart from code that was read. A 기능 whose handler did not resolve says why.
8. **Identity and preservation.** A node ID is the name structure and never contains a line number; file, line range and digest are attributes. A declaration whose qualified name repeats in its file, whatever its kind, gets `~<n>`, its order among those declarations in the file; it moves only when a same-named declaration is added, removed or reordered before it, and the first one gains `~1` when a second appears. `요소#순번` in a 프론트 ID is the original's own fallback and stays. `기능 뜻.md` and `정책.md` are never rewritten, reordered or trimmed by a build. A renamed 기능 gets a new ID: its old 뜻 line stays as written and is listed under 사라진 기능의 뜻 so a person can move it, and a 정책 line citing the old ID appears among the cited IDs that do not exist.

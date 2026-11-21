> 이 문서는 [Using the product graph](../product-graph-usage.md)의 한국어판입니다.

# 제품 그래프 쓰는 법

이 문서는 [제품 그래프](product-graph.md)의 문서를 쓰고, 빌드하고, 검사하고, 승인하는 방법을 보여 줍니다. 노드 타입, ID, 문서 형식은 그 문서에 정의되어 있습니다.

## 문서 쓰기

문서는 Project 저장소의 `.lode/context/product-graph/` 아래에 문서마다 파일 하나로 둡니다. 제품 정의서, 유저 저니맵, IA 문서는 하나씩, 유저플로우 기획서는 유저 활동마다, 화면설계서는 화면마다 하나씩 그 ID를 이름으로 씁니다. 정책 줄은 `정책.md`에, 기능마다 뜻 한 줄은 `기능 뜻.md`에 적습니다. 이 프로젝트에만 있는 호출 방식(예: MCP tool을 등록하는 곳)은 `호출 방식 표.json`에 적습니다.

누가 확인하기 전에 쓴 문서는 추정입니다. 어느 쪽인지 `| 항목 | 내용 |` 표에 적습니다. 제품을 실행하지 않고 코드에서 썼으면 추정: 코드만 보고 쓴 추정, 화면만 보고 썼으면 화면만 보고 쓴 추정. 실행하지 않은 제품의 근거는 파일과 줄이며, 실행을 지어내지 않습니다.

기능과 코드는 쓰지 않아도 됩니다. 소스 트리에서 나옵니다. 화면요소 표에는 빌드가 보여 주는 기능 ID를 그대로 적습니다.

## 빌드

```bash
lode-agent product-graph-build <project>
```

빌드는 문서, 정책 파일과 뜻 파일, 호출 방식 표, 소스 트리를 읽고 `.lode/context/product-graph/build/` 아래에 `graph.json`, `check.json`, `check.txt`, `build-context.json`을, 처음에는 `baseline.json`과 `baseline-content.json`(기준 자신의 소스 본문. `changes --list content`에만 씁니다. 아래 참고)도 씁니다. 그 밖에는 아무것도 쓰지 않습니다. 문서, 승인 기록, `product-model.json`은 그대로입니다. 같은 입력을 같은 폴더에 두 번 빌드하면 바이트까지 같습니다. 결과를 한 단계씩 읽으려면 아래 그래프에 묻기를 보거나 [Graph Explorer](graph-explorer.md)의 제품 그래프 보기를 엽니다.

## 검사

```bash
lode-agent product-graph-check <project>
lode-agent product-graph-check <project> --include-estimates
```

검사는 읽기만 합니다. 정합성 검사 여섯 줄과 그 뒤의 목록을 한국어로 냅니다. 기본으로는 승인된 문서만 쓰고, 빼 둔 추정 문서가 몇 개인지 알려 줍니다. `--include-estimates`를 주면 추정 문서도 쓰고, 그것에 기댄 발견마다 `[추정: 코드만 보고 쓴 추정]` 같은 표시를 붙입니다.

MCP에서는 같은 연산이 묶음 tool `lode_product_graph`의 action `build`, `check`, `query`, `sample`, `coverage`, `baseline`, `confirm`, `runs_add`, `approve`이고, `lode_tools_call`(읽기만 하는 검사, 질의, 표본, 커버리지 비교는 `lode_tools_read`도 됨)로 부릅니다. 기본 tool 목록에는 없습니다.

## 승인

승인은 사용자가 문서 하나를 지금 내용 그대로 읽고 제품 설명으로 받아들였다는 기록입니다. 검사 글은 승인이 아닌 문서마다 그 줄에 승인 digest(`승인할 digest …`)를 적고, 구조화된 결과에는 `documents.list`의 `approvalDigest`로 들어갑니다. 사용자에게 그 내용을 보여 준 뒤 같은 digest로 결정을 기록합니다.

```json
{ "document": "화면설계서/CHT-01.md", "expectedSha256": "<digest from the check result>", "rationale": "Read with the user on the screen." }
```

```bash
lode-agent product-graph-approve <project> --input approval.json
```

digest를 받은 뒤 문서가 바뀌었으면 승인을 거절합니다. 승인된 문서를 고치면 다시 추정이 되고 승인 뒤 바뀜으로 나옵니다. digest는 본문으로 계산하므로(정의 문서 참고) 다른 편집기가 줄바꿈이나 BOM을 바꿔도 승인이 풀리지 않습니다. MCP에서는 `confirm_user_review: true`가 필요하고, subagent는 기록할 수 없습니다.

**승인 기록이란.** 사용자가 한 말의 기록이지 보안 경계가 아닙니다. Project 저장소에 파일을 쓸 수 있는 누구나 승인 기록을 만들 수 있습니다. MCP 경로는 확인 플래그를 요구하고 subagent는 쓸 수 없으며, CLI 경로는 사용자가 직접 하는 것입니다. 감사 기록은 `승인/` 폴더의 버전 관리 이력입니다.

## 결과 읽기

- **0건**은 적어도 한 쌍을 비교했고 아무것도 찾지 못했다는 뜻입니다.
- **검사 못 함: <이유>**는 검사를 할 수 없었다는 뜻이고 이유를 적습니다. 문서가 없음(제품 정의서가 없다), 문서는 있지만 아직 승인되지 않음, 문서에 검사에 필요한 내용이 없음, 이 판이 뽑지 않는 연결(navigate 연결을 뽑지 않음). "문제 없음"이라는 뜻이 아닙니다.
- 노드 타입 옆의 **뽑지 않음**(이제 계측 이벤트만)은 이 판이 그 타입을 뽑지 않는다는 뜻입니다. 0개라는 뜻이 아닙니다. 데이터, 외부 연결, DB의 개수는 수이고, 각각 무엇을 세는지 함께 적습니다. 환경 변수 이름과 바깥 규칙이 이름 붙인 데이터, 바깥 규칙이 이름 붙인 외부 연결, 코드 문자열과 `.sql` 파일의 `CREATE TABLE`로 만든 표와 그 열입니다.
- 제품코어와 정책은 늘 사람이 판단합니다. 검사는 둘을 나란히 냅니다.
- **처음 쓸 때 — 빠진 입력**은 검사에 필요한 문서가 없거나 아직 승인되지 않았을 때만 나옵니다. 줄마다 그 입력, 그것이 여는 검사와 목록, 다음에 할 일을 적습니다. 그 아래 검사들은 여전히 같은 이유로 검사 못 함으로 끝납니다.
- **이 그래프가 답하지 못하는 것**이 맨 먼저 나옵니다. 발견보다 먼저 읽습니다. 코드를 얼마나 풀었는지, 무엇을 뽑지 않았는지, UI 스캔이 무엇을 못 보는지, 아무것도 실행하지 않았다는 것, 이번 실행이 어떤 문서를 썼는지를 적습니다.
- **어느 기능에서도 닿지 않는 코드**는 풀린 reference로 어느 기능에서도 닿지 않는 선언을, 많은 파일부터 적습니다. 풀린 호출이 적으면 항목이 많은 것이 당연합니다. 항목은 판정이 아니라 읽는 사람에게 던지는 질문(빠진 기능인가, 죽은 코드인가)입니다.
- **하나로 정하지 못한 호출**은 이유마다 개수와 무엇이 있으면 정해지는지를 적습니다. 한계 블록은 호출을 세 수로 나눕니다. 전체, 제품 코드일 수 없거나 제품 밖 모듈로 가는 호출, 그리고 나머지 중 풀린 수입니다. **코드로 읽지 않은 파일**은 보지 않은 것을 세므로, 덮지 못한 곳이 드러납니다.
- **사라진 기능의 뜻**은 기능이 없어진 뜻 줄을 적습니다. 대개 이름을 바꾼 뒤입니다. 그 줄을 손으로 새 ID로 옮깁니다. 빌드는 `기능 뜻.md`를 고치지 않습니다.
- **경로로 실행으로 읽은 곳**은 경로로 파일을 실행하거나 적재한다고 읽은 곳(framework-invoked)을 모두 적습니다. 글자로 읽은 것이니 읽어 보고, 틀린 곳은 규칙으로 바로잡습니다. 여러 파일에 맞는 경로는 잇지 않고 셉니다.
- **규칙이 가리키는 코드가 없음**과 **규칙이 낡음 — …**은 규칙 문제입니다. 코드 노드가 아닌 입구·대상·선언, 스캔한 코드가 아닌 파일, 어느 코드 줄에도 없는 글, 아무것도 빼지 않는 빼는 연결입니다. 목록에만 나오고 빌드를 멈추지 않습니다.
- **분기를 정하지 못함**, **이름 없는 바깥 호출**, **읽기·쓰기를 정하지 못함**은 분기와 바깥 읽기가 멈춘 곳을 말합니다. 블록을 정하지 못한 분기(그 기능은 함수 전체를 지남), 어느 규칙도 이름 붙이지 않은 바깥 호출(모듈·파일별), 부르는 api가 읽기 목록에도 쓰기 목록에도 없는 이름 붙인 데이터입니다.
- **문서에만 있음(실행·코드 근거 없음)**, **실행·코드에만 있음(문서에 없음)**, **이어지지 않은 화면요소**, **실행 뒤 코드가 바뀜**은 문서의 기능→화면요소 줄을 근거와 비교합니다(아래 실행 기록 참고). 기계 연결은 승인이 아니고 문서를 바꾸지 않습니다.

## 그래프에 묻기

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

질의는 이미 있는 빌드를 읽기만 하고, 빌드·검사·승인·쓰기를 하지 않습니다. 모든 답은 세 줄로 시작합니다. `graph.json`을 쓴 시각과 빌드가 지금 소스 그대로인지(빌드 뒤 바뀐 것 없음, 빌드가 낡음: …, 소스가 바뀌었는지 알 수 없음), 제품 코드일 수 있는 호출 중 몇 개를 풀었는지, 기준 뒤 무엇이 바뀌었는지입니다. 그다음 경로 줄과 들여 쓴 트리가 빌드의 말로 나옵니다. 답은 쪽으로 나뉩니다(`--limit`, 기본 50, 그리고 `--cursor`). 더 있는 답은 몇 개가 남았는지와 다음 쪽 명령을 말합니다. `down`과 시작점 `@기능`, `@기능/<kind>`, `@화면`, `@유저 활동`, `@파일`, `@바뀐 것`은 한 단계씩 갑니다. 이미 경로에 있는 노드는 위에 있음으로 표시합니다. `reach`는 처리 코드와 입구 코드 양쪽에서 풀린 call·callback·framework-invoked 참조를 따라가고, 검사가 어느 기능에서도 닿지 않는 코드에 쓰는 것과 같은 닫힘입니다. 경계에서 멈추고, 입구에서는 다른 기능의 처리 코드로 들어가지 않습니다. `reach <기능>`에서는 입구로 닿은 코드에 "— 입구로 닿음"이, `reach <code>`에서는 입구로만 닿는 기능에 "— 입구로만 닿음"이 붙습니다. 기능의 자식 줄에는 역할이 붙고, 입구 코드는 "(입구)"로 표시합니다. 경계는 닿는 길이 멈춘 노드 아래에 "경계에서 멈춤: <설명> → <대상>"으로 나오고, 경계 뒤 코드의 `reach <code>`는 "경계를 넘으면 닿는 기능 N개 (…)"를 더합니다. 손으로 적는 연결은 "(판단)"으로 표시합니다.

`tree <기능>`은 역할마다 들여 쓴 트리 하나를, 처리부터 냅니다. 경계와, 코드 줄마다 그 코드가 하는 read, write, 외부 연결도 나옵니다. 이미 펼친 노드는 "— 위에서 펼침", 다른 기능의 처리 코드는 "— <기능>의 처리 코드라 펼치지 않음"으로 표시합니다. `user <유저 활동>`은 활동의 차례를 순서대로, 차례마다 화면요소, "부르는 기능", 근거가 붙은 "결과를 보여 주는 기능", 그리고 기능마다 "처리 코드"를 냅니다. 둘 다 다른 답처럼 쪽으로 나뉘고(이어짐 줄과 뒤의 쪽이 되풀이하는 줄에 표시가 붙습니다), 2000줄을 넘는 트리는 그렇다고 말하고 `down <ID>`를 안내합니다.

`--json`은 구조화된 결과를 줍니다. 글자는 같은 질문에 대한 뷰어의 "글자로 보기"와 같습니다. 빌드가 없으면 답은 `PRODUCT_GRAPH_NOT_BUILT`와 빌드 명령이고, 모르는 ID는 `PRODUCT_GRAPH_NODE_NOT_FOUND`와 가까운 것들입니다.

MCP에서는 묶은 도구 `lode_product_graph`의 `query` 동작(`lode_product_graph_query`)이 같은 질문입니다. 사용자 동작이 어떤 코드에 닿는지, 무엇이 한 파일에 닿는지, 빈 곳이 어디인지 알아야 할 때 도움이 됩니다. 타입 없는 스캔이고, 보통 작업의 전제가 아닙니다.

구조화된 답(`--json`, MCP `structuredContent`)은 줄을 데이터로 싣습니다. 그래프 노드를 나타내는 줄에는 `nodeType`(노드 종류), `changedSinceBaseline`(`changed`, `added`, `reachChanged`, `unchanged`. 빌드가 기준과 비교했을 때만), `confirmation`(그 노드를 가리키는 확인 기록 목록: `neverChecked`, `changedSinceCheck`, `textChanged`, `otherReader`)도 붙습니다. 뜻 줄은 그 기능을, 문서 줄은 양 끝을 모두 가리키므로 화면과 화면요소에도 붙습니다. 모든 답에는 `baselineComparison`(`compared`, 빌드 뒤에 기준을 옮겨 앞의 기준과 비교한 것이면 `baseline-moved`, `no-baseline`, `absent`)과 `confirmationComparison`이 있습니다: `compared`, `partial`(빌드가 확인 기록을 파일 이름 순으로 앞부분만 읽음. 모든 목록과 `confirmation`이 그것에서 나옴), `not-read`(독립 실행 빌드는 확인 기록을 읽지 않음), `absent`(확인 기록이 생기기 전에 만든 빌드). 뒤의 쪽이 앞의 쪽에서 되풀이하는 줄(뿌리, 머리 줄, 첫 항목이 이어 가는 묶음 줄)에는 `repeats: "earlierPage"`가 붙고, 글은 그대로입니다. `confirmationComparison`이 `compared`일 때만 `confirmation`이 없다는 것이 확인이 그대로이거나 확인할 것이 없다는 뜻입니다. 빌드는 그대로인 확인의 개수만 갖고 있습니다. 시작점(`@…`)에는 이 필드가 없습니다. 어떤 줄에는 더 붙습니다. 닿음 줄은 어느 역할로 닿았는지(`via`: `처리` 또는 `입구`. `reach <code>`에서 `입구`는 입구로만 닿는다는 뜻), 기능→코드 자식 줄은 `역할`, 손으로 적는 연결의 줄은 `judgement: true`, 닿는 길이 경계에서 멈춘 곳이나 경계를 넘으면 더해지는 것을 말하는 줄은 `boundary`(`from`, `to`, `설명`), 트리의 역할 머리 줄은 `role`, 이름만 대고 펼치지 않은 노드는 `notExpanded`(`otherFunction` 또는 `expandedAbove`), `user` 답의 차례 머리 줄은 `step`, 기능 줄은 `relation`(`calls` 또는 `shows`)과, `shows`이면 `evidence`(그 연결의 근거)를 갖습니다. 답에는 무엇에서 읽었는지를 가리키는 `buildSha256`(읽은 모든 빌드의 `graph.json`과 `check.json` 바이트, 그리고 기준. 저장하지 않음)도 있습니다. MCP에서 `lode_product_graph_query`, `_check`, `_build`, `_baseline`의 `structuredContent`는 구조화된 부분으로 전체 `text`가 그대로 되살아날 때 그 글을 싣지 않습니다(`changes --list content`의 전후 항목은 `rows[].detail`에서, check는 그 결과에서). 도구가 돌려주는 내용 글은 여전히 그 글로 시작하고, CLI의 `--json`도 그대로 싣습니다. 줄이 없는 답은 `text`를 그대로 둡니다. 빌드 없음, 읽지 못한 빌드, 거부(그 문장은 `message`에도 있음), 그리고 기준 바뀜(그 문장은 `text`에만 있음)입니다.

## 여러 질문을 한 번에

`lode_tools_read_chain`(CLI `tools-read-chain <project> --input chain.json`)은 여러 질문을 한 번에 묻고 요청한 줄만 개수와 함께 돌려줍니다. 단계, 상한, 상태는 [MCP 도구 표면](mcp-surface.md#연쇄-읽기)에 있습니다. 읽기 전용이고, 아무 권한도 주지 않고, 아무것도 쓰지 않습니다. 답 여러 개를 받아 그중 몇 줄만 고를 때 도움이 됩니다. 질문 하나이거나, 답의 모든 줄을 어차피 읽어야 하면 직접 묻습니다. 안쪽 호출은 제품 그래프 질문과 `lode_project_graph`입니다. 빠졌다고 Lode가 아는 것은 `knownMissing`에 있습니다. 목록이 비어 있다고 줄이 전부라는 뜻은 아닙니다.

다시 볼 것 목록, 그다음 항목마다 무엇이 가리키는지 세기:

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

찾기, 기준 뒤 바뀐 코드 노드만 남기기, 앞의 두 개 읽기:

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

연쇄 읽기는 두 빌드의 줄을 함께 돌려주지 않습니다. 변화를 막는 것이 아니라 호출마다 뒤에서 알아챕니다. 두 호출 사이에 빌드나 기준이 바뀌면 연쇄 읽기는 `CHAIN_BUILD_CHANGED`로 멈추고 줄을 하나도 돌려주지 않습니다. 빌드가 원하는 상태가 된 뒤 다시 묻습니다.

## 기준 뒤 바뀐 것

빌드는 읽은 것을 해시합니다. 코드 노드마다 그 글(파일은 전체, 선언은 줄 범위), 기능마다 종류·처리·처리 코드(그리고 닿는 코드 전체에 대한 두 번째 해시), 문서 노드마다 적힌 값, 읽은 소스 파일마다 그 글(`inputs.sourceFiles`)입니다. 글은 BOM을 빼고 CR LF와 CR을 LF로 바꾼 뒤 비교하므로, 다른 체크아웃의 줄 끝은 아무것도 바꾸지 않고, 선언을 글을 바꾸지 않은 채 파일 안에서 옮겨도 해시는 그대로입니다. 선언은 범위 끝의 빈 줄을 뺀 글로 해시하므로, 파일의 마지막 선언 뒤에 코드를 붙이면 그 파일과 새 선언만 바뀝니다. 줄 끝이 CR뿐인 파일은 파일 전체로는 LF 사본과 같은 해시이지만, 공유 스캔이 한 줄로 읽어서 선언의 줄 범위와 해시는 LF 사본과 다릅니다. 이 해시는 생성된 `build/` 폴더에만 있고, ID는 바뀌지 않습니다. 읽는 방식은 생성기, 그 그래프 버전, 소스 분석 버전으로 비교합니다. Lode 버전은 참고로만 적으므로, 코드를 똑같이 읽는 업그레이드는 바뀐 것으로 치지 않습니다.

첫 빌드는 자신을 기준(`build/baseline.json`)으로 삼고 "기준 없음 — 이번 빌드를 기준으로 삼았다"고 말합니다. 뒤의 빌드는 기준과 비교하고 기준을 옮기지 않으므로, 다시 빌드해도 기준 뒤 바뀐 것을 모두 계속 보여 줍니다. `check.txt`와 `check.json`(`changes`)은 한계 바로 다음에 이것을 줍니다. 기준을 잡은 때와 그 뒤 움직인 것(소스 파일, 문서, 호출 방식 표, 읽는 방식), 노드 종류별로 변화 없음은 수로, 변경·신규·사라짐은 ID로, 자신의 내용은 같지만 닿는 코드가 바뀐 기능(닿는 코드가 바뀜)과 바뀐 노드, 새로 생기거나 사라진 연결, 옮겨졌을 수 있는 쌍(같은 종류·이름·내용), 소스가 그대로인 곳에서 달라진 것, 그리고 **다시 볼 것**: 바뀐 것을 가리키는 뜻 줄과 문서 줄(화면요소→기능, 기능→화면요소, 화면→코드)과 그 문서의 상태입니다. 그중 승인된 문서는 "승인된 문서가 가리키는 것이 기준 뒤 바뀜"으로 표시하고 승인은 그대로 둡니다. 그 글이 아직 맞는지는 사람이 판단하기 때문입니다. 빌드는 문서, 뜻 줄, 승인을 바꾸지 않습니다. 기계가 만든 기능→화면요소 연결은 다시 볼 것에 들지 않습니다.

### 읽는 방식 2판으로 업데이트한 뒤

입구, framework-invoked 경로, 값으로 쓴 함수, 데이터·외부 연결·DB, 분기를 더한 업데이트는 코드를 다른 방식으로 읽습니다(`PRODUCT_GRAPH_VERSION` 1 → 2). 업데이트 뒤 첫 빌드는 옛 방식으로 읽은 기준과 비교하고, 새 읽는 방식 때문에 생긴 것을 실제로 바뀐 것과 나눠 둡니다.

- 닿는 범위가 달라졌는데 달라진 노드가 모두 기준과 글이 같은 파일에 있는 기능은 "읽는 방식이 달라져 닿는 범위가 달라진 기능 N개"로 세고, 닿는 코드가 바뀜과 다시 볼 것에 넣지 않습니다.
- 새로 생긴 데이터, 외부 연결, DB 노드는 신규가 아니라 "읽는 방식이 달라져 새로 생긴 노드"로 셉니다.
- 정말 바뀐 파일의 코드에 닿는 기능은 전처럼 나옵니다.
- 확인 기록은 다시 확인할 때까지 "다른 방식으로 읽은 때 확인함"으로 나옵니다.

그 목록을 살펴본 뒤 `product-graph-baseline`을 실행하면 새 방식으로 읽은 기준을 잡습니다. `호출 방식 표.json`에는 없어도 되는 항목 입구, 분기, 손으로 적는 연결, 바깥, 빼는 연결이 생겼습니다. 이 항목이 없는 표는 전처럼 읽고, 모르는 항목은 여전히 거절합니다. 새로 생긴 사용자 폴더 `실행 기록/`은 없어도 됩니다. 없으면 실행 근거가 없을 뿐입니다.

```bash
lode-agent product-graph-baseline <project>
```

기준은 이 명령으로만 옮겨집니다. 이미 있는 빌드를 기준으로 삼고, 그 빌드가 지금 소스 그대로가 아니면 `PRODUCT_GRAPH_BUILD_STALE`로 거절하며, 바뀐 것과 다시 볼 것 몇 개가 목록에서 빠지는지 말합니다. `build/baseline-content.json`(새 기준의 소스 본문)을 쓰고 이어서 `build/baseline.json`을 쓰며, 그 밖에는 쓰지 않습니다. `build/`를 지우면 그 목록과 전후 본문 표시만 잃습니다. 빌드가 지금 소스 그대로인지는 빌드가 읽은 모든 파일과 새로 생긴 코드 파일로 확인합니다. 코드가 아닌 새 파일(예: hook JSON이나 플러그인 매니페스트)은 다음 빌드에서야 보입니다. 같은 읽는 방식에서 기준과 글이 같은 파일의 노드가 해시나 줄 범위가 다르면 빌드는 `PRODUCT_GRAPH_NOT_REPRODUCIBLE`로 멈추고 아무것도 쓰지 않습니다.

## 확인 기록

"다시 볼 것"은 기준에 따라 정해집니다. 기준을 옮기면 아무도 보지 않았어도 사라지고, 기준보다 앞선 변경 뒤에 쓴 뜻 줄은 끝내 잡히지 않습니다. 확인 기록은 기준과 따로, 실제로 무엇을 확인했는지 남깁니다. 기록 하나(`.lode/context/product-graph/확인/product-graph-check-<id>.json`)는 확인한 뜻 줄(기능 ID와 그 줄 글의 해시)이나 문서 줄(화면요소→기능, 기능→화면요소, 화면→코드와 문서 글의 확인 값)을 적고, 그것이 가리키는 노드마다 그때의 내용 해시(기능이면 닿는 코드 전체의 해시도)와 코드를 읽은 방식을 적습니다. 한 번 쓰면 Lode가 고치거나 지우지 않습니다. 승인 기록처럼 내보내기·가져오기·폴더 복사로 함께 옮겨지고 GC가 남겨 둡니다. 역시 승인 기록처럼, `확인/`의 기록 하나가 검증되지 않으면 내보내기·가져오기·폴더 복사 채택·스냅숏 GC가 멈추고, 기록이 2000개를 넘으면 옮기기가 멈춥니다. 빌드는 그런 기록을 issue로 적기만 하고 계속합니다.

```
lode-agent product-graph-confirm <project> --input confirm.json
```

입력은 `{"features": ["<기능 ID>"], "documents": ["화면설계서/MAIN-01.md"], "rationale": "what was re-read"}`입니다(MCP: `lode_product_graph`의 action `confirm`). 각 줄이 설명하는 코드를 다시 읽은 뒤에만 씁니다. 에이전트의 확인(`agent-checked`)을 남길 뿐 사용자의 승인이 아니며 아무 권한도 주지 않습니다. 문서 이름을 주면 그 문서의 코드와 잇는 행 가운데 대상이 그래프에 있는 행을 모두 확인한 것으로 남깁니다(없는 것을 가리키는 행은 확인할 코드가 아니라 빈 곳입니다). 이미 있는 빌드를 읽고, 빌드가 지금 소스 그대로가 아닐 때(소스·문서·호출 방식 표가 바뀌었거나 지금은 코드를 다른 방식으로 읽음. 빌드 뒤 승인은 해당하지 않음) `PRODUCT_GRAPH_BUILD_STALE`로, 기능에 그래프 안의 뜻 줄이 없거나 문서에 그런 행이 없으면 `PRODUCT_GRAPH_CHECK_TARGET_MISSING`으로, 기록을 쓰면 폴더의 기록이 2000개를 넘을 때 `PRODUCT_GRAPH_CHECK_LIMIT`으로 거절하고, 거절하면 아무것도 쓰지 않습니다. 명령 하나는 항목에 필요한 만큼 기록을 쓰고(기록 하나는 항목 500개, 256 KiB까지) 몇 개를 썼는지 말합니다(`records`, `recordsWritten`). 지금 기록이 이미 같은 종류(에이전트 확인 또는 사용자 승인)이고 글과 코드 근거, 읽은 방식이 같은 항목은 다시 쓰지 않으며, 그런 명령은 `unchanged`로 답합니다. ID는 그래프에 있는 그대로 적습니다(파일 이름이 분해형으로 저장된 경우도). 기록은 문서와 따로 읽습니다. 파일 이름 순으로 앞의 2000개를, 하나에 256 KiB까지 읽고, 그보다 크거나 읽지 못하거나 개수를 넘는 기록은 파일 이름과 함께 나오며 아무것도 확인한 것으로 치지 않고, 블록이 몇 개를 읽지 않았는지 말합니다. 기록 때문에 빌드, 검사, 빌드 읽기, 승인, 기준 옮기기가 실패하지 않습니다. 목록을 읽을 수 없는 `확인/` 폴더도 이런 issue입니다. 개수를 넘은 기록은 앞의 100개만 이름을 적고 나머지는 셉니다. 이름이 분해형으로 저장된 `확인/`·`승인/` 폴더는 그대로 씁니다. 두 표기가 다 있으면 새 기록은 조합형(NFC) 폴더에 쓰고, 빌드는 둘 다 읽습니다. 쓰다가 도중에 멈추면(디스크가 가득 찬 경우 등) 쓴 기록과 쓰지 못한 기록을 답에 적습니다(`status: "partial"`, `notWritten`). 하나도 쓰지 못한 확인은 `PRODUCT_GRAPH_CHECK_WRITE_FAILED`로 실패하고, 폴더가 아닌 `확인`은 `PRODUCT_GRAPH_CHECK_FOLDER_INVALID`로 거절합니다. `product-graph-approve`도 지금 빌드로 승인한 문서의 행에 대한 기록(`user-approved`)을 함께 씁니다. 빌드가 지금 것이 아니거나 기록을 쓰지 못하면 글은 전처럼 승인하고, 코드 근거는 기록하지 않았다고 이유와 함께 말합니다(`codeBasis.status: "not-recorded"`). 이 단계의 어떤 것도 승인을 막지 않습니다. 바뀐 것 없이 같은 문서를 다시 승인하면 새 기록을 쓰지 않습니다(`codeBasis.status: "unchanged"`).

빌드는 (프로젝트에서만 — 독립 실행은 읽지 않고 그렇다고 말합니다) 기록을 읽어 기준과의 비교 다음에 **확인 기록**을 덧붙입니다. 확인할 수 있는 항목마다 지금 기록이 정합니다. 새 기록은 항목마다 그 항목의 지금 기록을, 서로 비긴 기록까지 모두 대신한다고 적습니다(`supersedes`). 그래서 확인이나 승인이 방금 쓴 기록이 시계와 상관없이 그 항목의 기록이 됩니다. 서로 대신하지 않는 기록 사이에서는 더 늦은 시각(시점으로 비교)이, 그다음 기록 ID가 정합니다. 뜻 줄이 둘인 기능은 그래프가 보여 주는 마지막 줄을 확인합니다. 상태는 이렇습니다: 확인한 적 없음, 확인 뒤 코드가 바뀜(가리키던 노드가 바뀌었거나 사라졌거나 닿는 코드가 바뀜 — 무엇이, 누가 언제 확인했는지와 함께), 확인 뒤 글이 바뀜(뜻 줄이나 문서 글이 바뀜), 다른 방식으로 읽은 때 확인함(코드를 다른 방식으로 읽던 때의 확인이라 다시 봄), 또는 그대로(수만 셈). 항목을 보여 주는 곳마다 에이전트 확인과 사용자 승인을 나눠 적습니다. 모양·내용 주소·프로젝트가 맞지 않는 기록은 파일 이름과 함께 "읽지 못한 확인 기록"에 나오고 아무것도 확인한 것으로 치지 않습니다. 기준을 옮겨도 이것은 바뀌지 않습니다. 빌드 뒤에 쓰거나 바꾸거나 지운 기록은 다음 빌드까지 `check.json`에 없고, 빌드를 읽을 때 기록의 이름과 크기를 비교해(기록을 읽지 않으므로, 크기가 같은 채 바뀐 기록은 다음 빌드에서 알아챕니다) 현재성 옆에 그렇다고 말합니다. `product-graph-query <project> changes`가 이 블록을 보여 주고, `--list neverChecked`, `changedSinceCheck`, `textChanged`, `otherReader`, `issues`로 상태 하나를 나열합니다. 뜻 줄을 확인했는데 그 확인이 더는 맞지 않는 기능(확인 뒤 코드가 바뀜, 확인 뒤 뜻 줄이 바뀜, 다른 방식으로 읽은 때 확인함)은 모든 답의 노드 줄과 페이지의 제품 그래프 트리에 `{뜻: …}`가 붙습니다. 아무도 확인하지 않은 줄에는 붙지 않고, 블록에만 나옵니다. Graph Explorer의 빈 곳 보기도 같은 블록을 보여 주고 항목마다 그 노드로 잇습니다.

## 다른 폴더를 건드리지 않고 비교하기

빌드와 검사는 Lode Project가 아닌 폴더에서도 돕니다. 모든 위치를 직접 줍니다. 분석하는 폴더에는 아무것도 쓰지 않고, 승인 기록을 읽지 않으므로 모든 문서가 추정입니다.

```bash
lode-agent product-graph-build <source-root> --documents <folder> --rules <entry-rules.json> --out <folder> --include-estimates
lode-agent product-graph-check <source-root> --documents <folder> --rules <entry-rules.json> --include-estimates
```

문서 폴더는 저장소 폴더와 같은 구조를 씁니다. 규칙 파일의 규칙 목록은 비어 있어도 됩니다. `--out`은 문서 폴더(또는 그 안)나 소스 루트일 수 없고, 지정한 폴더의 출력 파일 세 개는 빌드할 때마다 바뀝니다.

## 명령 표를 위한 규칙

제품이 명령을 표의 항목으로 등록한다면, 프로젝트 규칙으로 명령마다 그 항목에서 처리 코드를 가져올 수 있습니다. 이런 표라면:

```javascript
export const COMMANDS = [
  { command: "save", handler: saveFile },
  { command: "export", load: () => import("./export.mjs").then((m) => m.runExport) },
];
```

`호출 방식 표.json`에 이렇게 씁니다.

```json
{ "종류": "cli", "판단": true, "파일": ["src/commands.mjs"], "패턴": "command: \"([a-z-]+)\"", "처리 코드": "항목" }
```

그러면 `cli:save`의 처리 코드는 `saveFile`, `cli:export`의 처리 코드는 `runExport`가 됩니다. 패턴은 다른 곳의 언급이 아니라 항목 자신의 키에 맞게 씁니다. 여러 항목에서 나온 기능은 목록에 나오므로 패턴을 좁힐 수 있습니다.

## 표에 없는 전역 이름

내장 이름 표에 없는 런타임 전역(예를 들어 호스트가 따로 주는 전역)을 부르면 선언이 없는 호출로 셉니다. `호출 방식 표.json`의 `"내장 이름"`에 언어별로 그 이름을 더합니다.

```json
{ "schemaVersion": 1, "kind": "LodeProductGraphEntryRules", "rules": [], "내장 이름": { "javascript": { "함수": ["hostLog"], "네임스페이스": ["host"] } } }
```

그러면 그 이름을 선언·들여오거나 묶지 않는 모든 파일에서 `hostLog(x)`는 내장 함수, `host.run(x)`는 내장 네임스페이스의 멤버입니다.

## 입구, 분기, 스캔이 보지 못하는 연결

모두 `호출 방식 표.json`에 적고 판단으로 표시합니다. 각각을 정확히 어떻게 읽는지는 정의 문서에 있습니다. 규칙 문제(규칙이 가리키는 코드가 없음, 규칙이 낡음 — …)는 검사 목록에 나오고 빌드를 멈추지 않습니다.

모든 MCP tool 호출이 처리 코드 앞에 분배 함수 하나를 지난다면, 그 함수를 입구로 적습니다. 그러면 분배 함수는 tool 기능마다 닿은 것으로 치되, tool마다 다른 모든 처리 코드에 닿지는 않습니다.

```json
{ "종류": "tool", "판단": true, "입구": ["src/server.mjs#dispatch"] }
```

이처럼 종류만 있는 규칙은 그 종류의 모든 기능에 입구를 붙이고, 파일과 패턴이 있는 규칙은 그 규칙이 내는 기능에 붙입니다.

함수 하나가 여러 명령을 분기로 처리하면, 그 패턴 규칙의 `"분기": true`가 기능마다 자기 분기의 줄만 주게 합니다.

```json
{ "종류": "cli", "판단": true, "파일": ["src/cli.mjs"], "패턴": "case \"([a-z-]+)\":", "분기": true }
```

스캔이 보지 못하는 방식으로 코드가 무언가에 닿을 때(예를 들어 설정으로 핸들러를 부르는 프레임워크)는 연결을 손으로 적거나, 닿는 길이 멈출 곳을 표시합니다.

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

어느 바깥 규칙도 이름 붙이지 않은 바깥 호출은 이름 없는 바깥 호출에 모듈·파일별로 나오므로, 무엇에 이름을 붙일지 볼 수 있습니다. 두 규칙이 맡은 호출은 규칙 문제이고, 정확히 하나만 줄이나 선언으로 좁혔으면 그 규칙이 맡습니다.

## 연결 표본 확인하기

```bash
lode-agent product-graph-sample <project> [--seed n] [--count k] [--types call,callback]
```

표본은 이미 있는 빌드를 읽고, 사람이 소스와 맞춰 보도록 연결 `k`개(기본 30, 500까지)를 있는 연결 종류에 고루 뽑습니다. 연결마다 양 끝의 파일과 줄 범위, 어디서 읽었는지, 근거를 보여 줍니다. 시드를 출력하고, 시드를 주지 않으면 빌드에서 시드를 만들므로 같은 빌드는 같은 표본을 줍니다. 아무것도 저장하지 않고 판정도 하지 않습니다. 소스를 읽고 틀린 연결을 알립니다. MCP: `lode_product_graph`의 action `sample`(`lode_product_graph_sample`).

## 실행 기록

Lode는 아무것도 실행하지 않습니다. 프로젝트가 기능을 실행했다면(테스트, 스크립트, 터미널의 사람), 무엇을 실행했고 무엇이 돌아왔는지 Lode에 넘깁니다.

```json
{ "runs": [{ "기능": "cli:sync", "실행": "lode-agent sync ./demo", "상태": "ok", "출력": "<the raw output>", "종료": 0 }], "rationale": "why these runs were made" }
```

```bash
lode-agent product-graph-runs-add <project> --input runs.json
```

(MCP: `lode_product_graph`의 action `runs_add`.) 실행마다 지금 빌드의 기능 내용·닿는 코드 해시와 코드를 읽는 방식이 붙으므로, 옛 코드에서 한 실행이 오늘 코드의 근거가 되는 일은 없습니다. 기록은 `.lode/context/product-graph/실행 기록/product-graph-run-<id>.json`에 내용 주소로, 크기에 따라 나눠 쓰고, Lode는 고치거나 지우지 않습니다. 거절은 확인과 같고 아무것도 쓰지 않습니다. 빌드가 지금 소스 그대로가 아니면 `PRODUCT_GRAPH_BUILD_STALE`, 기능이 그래프에 없으면 `PRODUCT_GRAPH_RUN_TARGET_MISSING`, 기록이 2,000개를 넘거나 기록 하나가 256 KiB를 넘거나 출력이 16 KiB를 넘으면(자르지 않고 거절) `PRODUCT_GRAPH_RUN_LIMIT`입니다. 실행은 `R<기록 짧은 id>-<n>`으로 보입니다.

**출력은 준 그대로 저장됩니다.** Lode는 출력에 비밀이 있는지 보지 않고, 이동용 내보내기가 출력을 함께 싣습니다. 출력을 넘기기 전에 비밀을 지웁니다.

다음 빌드는 지금도 맞는 실행을 기능→화면요소 연결의 근거로 씁니다. 화면요소 줄의 한 줄 칸에서 백틱으로 묶은 글이 실행 출력에 있으면 됩니다. 코드 문자열 리터럴도 근거입니다(정의 문서 참고). 연결마다 근거("문서", "실행 <ids>", "코드 <file>:<line>")를 적습니다. 틀린 기계 연결은 판단 규칙으로 뺍니다.

```json
{ "빼는 연결": [{ "판단": true, "기능": "cli:sync", "화면요소": "CLI-01#2", "이유": "the phrase also appears in the help text" }] }
```

기계 연결은 근거이지 승인이 아닙니다. 문서, 승인, 확인 기록을 바꾸지 않고 다시 볼 것에 들지 않습니다. 기록한 뒤 기능이 바뀐 실행은 실행 뒤 코드가 바뀜으로 나오고 연결을 만들지 않습니다. 지금 코드에서 다시 기록합니다. 같은 기능·같은 실행 이름의 새 실행은 옛 실행을 대신합니다. `changes --list runsCurrent`와 `--list runsStale`이 실행을 나열하고, 실행이 낡은 기능은 노드 줄에 `{실행: 실행 뒤 코드가 바뀜}`가 붙습니다. 빌드를 읽을 때 빌드 뒤 실행 기록이 바뀌었으면 현재성 옆에 그렇게 적습니다("실행 기록이 빌드 뒤 바뀜 — 다시 빌드하면 연결에 반영된다").

## 기능의 닿는 범위를 실제 실행과 비교하기

```bash
NODE_V8_COVERAGE=<folder> <run the project so it does that one 기능>
lode-agent product-graph-coverage <project> --feature cli:sync --v8 <folder>
```

비교는 읽기만 하고 아무것도 저장하지 않습니다. Lode는 아무것도 실행하지 않고, 실행은 프로젝트가 합니다. "실행됐는데 닿는 범위 밖"(닿는 범위 밖에서 돈 코드. 그래프가 놓친 경로)과 "닿는다고 했는데 돌지 않음"(돌지 않은 닿는 범위. 가지 않은 분기와 오류 경로 포함)을 적습니다. 입구 코드는 닿는 범위 안입니다. 입구에서 걷는 길이 멈춘 곳(다른 기능의 처리 코드) 뒤에서 돈 코드는 "실행됐는데 입구에서 멈춘 곳 뒤에 있음"에 따로 적어, 멈춤을 빠진 연결로 잘못 읽지 않게 합니다. 실행 뒤 바뀐 파일은 건너뛰고 "실행한 파일이 지금 소스와 다름"에 이름을 적습니다. 아무것도 비교하지 못했으면 두 목록 모두 0이 아니라 "비교하지 않음 — <이유>"라고 말합니다. V8 커버리지 JSON만 읽습니다. V8 커버리지에는 소스 글이 없으므로, "같은 소스"인지는 스크립트 길이와, 커버리지 파일을 쓴 뒤 그 파일이 바뀌지 않았는지로 판단합니다. 파일의 맨 위(모듈을 불러올 때 도는 코드)는 세지 않습니다. MCP: `lode_product_graph`의 action `coverage`(`lode_product_graph_coverage`).


## 흐름을 찾고, 실제 변경과 제안 영향을 보기

ID를 몰라도 질문으로 시작할 수 있습니다.

```bash
lode-agent product-graph-query <project> find "메모를 저장할 때 오류"
lode-agent product-graph-query <project> find "saveNote" --node-types 기능 --related-to P1 --edge-types 정책→기능
lode-agent product-graph-query <project> changes --list content
lode-agent product-graph-query <project> impact --proposal-base-build <starting-build> --candidate-build <proposed-build>
```

**찾기**는 묻는 그래프마다 새로 만드는 BM25 단어 색인을 씁니다(그래프나 질문 사이에 남기는 것이 없습니다). 정확한 ID/경로를 먼저 보이고 동점 순서는 일정합니다. 종류, 기록된 근거 상태, edge 이웃 필터는 순위와 페이지 나누기 전에 적용합니다. `--edge-types`는 `--related-to`의 이웃만 좁힙니다. 그래프에 없는 `--related-to` ID는 빈 결과가 아니라 거절합니다(`PRODUCT_GRAPH_NODE_NOT_FOUND`). 코드 식별자는 나누고 한글은 두 글자 조각으로 활용형을 찾습니다. 단어 일치일 뿐 뜻 판단이 아니며, 비슷한 말이 연결·승인·현재성을 만들지 않습니다. 보이는 페이지의 결과에 대해서만 기록된 인접 edge를 함께 보입니다. 페이지의 찾기도 같은 코드입니다.

**내용 변경.** `check.json`, `check.txt`, 빌드·검사 응답(CLI, MCP), Graph Explorer 내보내기(로컬, `--share`)는 어떤 노드의 내용이 바뀌었는지와 이전 본문이 보관됐는지만 말하고 본문 자체는 넣지 않습니다. 본문은 `changes --list content` 질문으로만 보이며, 제품 소스 본문입니다. 이전은 보관 파일에서, 현재는 지금 소스에서 이 빌드와 여전히 맞는 곳만 읽습니다. 한 쪽은 16 KiB까지이고, 한 페이지는 256 KiB까지 온전한 항목만 담으며 다음 페이지는 빠진 첫 항목에서 시작합니다. 잘린 쪽은 생략한 바이트를 적습니다. 구조화된 응답에서 본문은 `rows[].detail`에만 있습니다. 빌드에서 연 페이지는 본문 대신 명령을 보입니다. 목록은 비교한 그 기준에 속합니다. `product-graph-baseline` 뒤나 보관 본문이 생기기 전에 만든 빌드에서는 다음 빌드까지 이 질문을 `PRODUCT_GRAPH_BUILD_STALE`로 거절하고 본문을 보이지 않습니다.

- 코드 내용은 정규화한 소스 구간입니다(BOM 제거, 줄끝 LF. 원래 바이트와 같다는 뜻이 아니며 스캐너의 줄 구간이지 AST 본문이 아닙니다). 다른 노드의 내용은 내용 해시가 다루는 필드 그대로라서 보이는 본문이 기록된 해시와 맞습니다. 기능의 위치와 한 줄 뜻은 여기에 들지 않으므로 진입점 위에서 줄이 밀려도 내용 변경이 아닙니다.
- 이전 본문은 `build/baseline.json` 옆의 `build/baseline-content.json`에 있습니다. 생성 파일이고 로컬이며 `build/`와 함께 Git이 무시하고, 파일 바이트로 2 MiB까지입니다(4 MiB를 넘는 파일은 읽지 않습니다). 온전한 내용만 작은 것부터 하나에 16 KiB까지 담으므로 보이는 이전 본문은 모두 기준의 내용 해시와 맞춰 본 것입니다. 그보다 크거나 예산을 넘는 내용은 항목이 없고 "보관되지 않음"으로 보입니다. 기준 파일의 바이트와 코드를 읽는 방식(생성기, 그래프 버전, 소스 분석)에 묶이며 설치된 Lode 버전에는 묶이지 않으므로, 코드를 같게 읽는 업데이트 뒤에도 그대로 씁니다. 손으로 고친 항목은 맞지 않아 보이지 않습니다. 이 파일은 파생물입니다. 없거나, 다른 기준의 것이거나(예: 두 번의 쓰기 사이에서 멈춘 기준 이동), 읽을 수 없으면 다음 빌드가 그 빌드의 소스에서 내용이 아직 기준과 같은 노드만 다시 쓰고 `changes.content.retainedFile`에 그렇게 적습니다. 기준을 다른 방식으로 코드를 읽은 버전이 잡았다면 아무것도 쓰지 않고 `product-graph-baseline`을 실행하라고 적습니다. 파일을 지우면 전후 본문 표시만 잃고 비교 자체는 그대로입니다. 포터블 export/import와 Graph Explorer 내보내기는 이 파일을 옮기지 않습니다. 폴더 복사는 `build/`를 있는 그대로 옮깁니다.

**영향**은 이미 있는 빌드 셋을 읽기만 하고 아무것도 바꾸지 않습니다. 제안이 출발한 상태, 지금 상태, 출발 상태에 제안을 적용한 상태입니다. 같은 최종값 변경과 서로 다른 변경, 동시 정책 변경, 지운 화면요소나 코드를 가리키는 남은 참조를 구분하고, 횟수가 있는 관계·출처·삭제 대 수정 충돌을 알립니다. 충돌이 없다는 것은 제품 승인이 아니고 정적 미리보기는 실행 증거가 아닙니다. 세 빌드가 같은 Project에서 나왔거나(빌드마다 `build/build-context.json`에 Project, 소스 루트 해시, 코드를 읽는 방식을 적습니다) 독립 실행이면 같은 소스 루트에서 나왔고, 코드를 같게 읽고 같은 호출 방식 표를 쓸 때만 "verified"입니다. Project 빌드와 독립 실행 `--out` 빌드가 섞였거나 서로 다른 독립 실행 루트(다른 worktree)면 "partial"이며 이유를 적습니다. 출발 빌드를 빼면(그때는 기록된 기준 해시를 씁니다) 역시 partial입니다. 읽을 수 없는 빌드 폴더를 주면 이유와 함께 거절합니다.

서로 다른 세 상태를 verified로 비교하려면 Project 안에서 빌드하고 매번 `build/`를 복사해 둡니다. 아래 단계는 스스로 만들지 않은 것은 아무것도 지우지 않으며, 깨끗한 작업 트리에서 시작해야 합니다. `git status --porcelain`이 아무것도 출력하지 않아야 합니다(내 작업은 먼저 커밋하거나 stash합니다. `build/`는 Git이 무시하므로 상관없습니다). 출발 커밋을 기준으로 만든 patch로 제안이 주어졌을 때:

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

`git apply -R`은 `git apply`가 한 일만 정확히 되돌리고, 작업 트리가 그 상태가 아니면 오류로 멈춥니다. 그 밖의 것은 건드리지 않습니다. 출발 커밋에서 갈라진 브랜치로 제안이 주어졌을 때:

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

제안은 출발 지점을 임시로 체크아웃한 곳에만 적용하고 지금 상태에는 적용하지 않습니다. 미리보기는 지금 적용하면 만날 것을 보입니다. 다른 커밋에서 빌드해도 기준은 옮겨지지 않습니다. 빌드는 기준을 옮기지 않습니다.

**페이지.** 출력된 다음 페이지 안내는 질문을 그대로 되풀이합니다. 필터, `--limit`, `--depth`, 빌드 폴더, 그리고 그 페이지가 무엇에서 답했는지(빌드 파일, 비교, 질문)의 해시인 `--expected-basis-sha256`을 담습니다. 그중 하나라도 바뀌었으면 다음 페이지는 섞지 않고 거절합니다(`PRODUCT_GRAPH_QUERY_BASIS_CHANGED`). 처음부터 다시 묻습니다. 응답은 같은 것을 `page.nextArguments`(Core/CLI 옵션 이름과 빌드 위치)와, Project일 때 `page.nextMcpArguments`(MCP 도구 인자 이름)에 담습니다. 그대로 보내면 됩니다. 기준 없이 손으로 친 cursor는 예전처럼 답합니다.

빌드는 매번 소스에서 모든 것을 다시 만듭니다. 파싱 캐시는 없습니다.

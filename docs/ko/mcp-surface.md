# MCP 도구 표면과 폐기 예정 이름

[영어 원문](../mcp-surface.md)

Lode는 작은 기본 MCP 도구 목록만 나열하고, 나머지 작업은 discovery와 두 라우터로
사용할 수 있게 합니다. 0.3부터 같은 자원에 대한 작업은 `action`을 받는 도구
하나로 묶입니다.

## 기본 목록

일반 `tools/list`의 도구는 23개입니다. 여기에는 `lode_tools_discover`,
`lode_tools_read`, `lode_tools_call`, `lode_tools_read_chain`이 포함됩니다. 묶음은 이 목록을 바꾸지 않고,
discovery와 managed maintenance `tools/list`에 보이는 것만 바꿉니다.

Claude 네이티브 Hook helper `lode_session_host_request_prepare`는 카탈로그 도구가
아닙니다. `tools/list`, discovery, router 어디에도 보이거나 라우팅되지 않으며,
동봉된 PreToolUse Hook만 이 helper를 호출합니다. 이전 버전은 이 helper를 23번째
도구로 나열했습니다.

## 묶음 도구

묶음 도구는 자원 이름을 따릅니다. 예를 들어 `lode_bounded_worker_wave`입니다.
`action`은 기존 작업 하나를 정확히 고릅니다.

```json
{
  "name": "lode_tools_call",
  "arguments": {
    "name": "lode_bounded_worker_wave",
    "execution_mode": "managed",
    "arguments": { "action": "seal", "project_root": "/path/to/project", "wave_id": "bounded-worker-wave-0123456789abcdef01234567" }
  }
}
```

- **경로.** 각 action은 원래 작업의 경로를 유지합니다. 읽기 전용 action은
  `lode_tools_read`로 호출합니다. `lode_tools_read`는 읽기 전용이 아닌 action을
  거부합니다. discovery는 `actions`를 반환하며, action마다 `invokeWith`, 필수
  필드, `executionMode`를 알려 줍니다.
- **managed action.** 원래 작업이 managed mutation인 action(위의 `seal` 등)은
  그 작업과 똑같이 `lode_tools_call`에 `execution_mode: "managed"`가 필요합니다.
  없으면 ordinary 표면이 `MANAGED_OPERATION_NOT_ON_DEFAULT_SURFACE`로 거부합니다.
  표에 이런 action이 표시되어 있고, discovery는 `executionMode: "managed"`로
  알려 줍니다.
- **인자.** 묶음 스키마는 `action`과 각 action이 쓰는 모든 필드를 선언합니다.
  Lode가 `action`을 떼어 내고 나머지 인자로 원래 작업을 실행하므로 필수 필드는
  여전히 action마다 검사됩니다. 다른 action만 쓰는 필드는 쓰이지 않습니다. 대부분의
  작업은 이를 무시하고, 일부는 거부합니다(예: `lode_project_bundle`). discovery는
  action마다 `required` 필드를 알려 줍니다.
- **결과.** 묶음 호출은 원래 작업의 결과를 그대로 반환하고, 같은 Session,
  write-guard, managed-surface 검사를 거칩니다.
- **오류.** `action`이 없거나 알 수 없는 값이면 작업을 실행하기 전에
  `INVALID_TOOL_ARGUMENTS`로 거부합니다.

## 연쇄 읽기

`lode_tools_read_chain`은 읽기 전용 Lode 도구 호출 여러 개를 단계 목록 하나로 받아
서버 안에서 잇고, 요청한 줄과 Lode가 센 개수, 그리고 빠졌다고 Lode가 아는 것
(`knownMissing`)만 돌려줍니다. 코드를 실행하지 않습니다. 단계는 식이 아니라 데이터입니다. 연쇄 읽기는 아무
권한도 주지 않고 아무것도 쓰지 않으며(기록, 캐시, 임시 파일 모두 없음), 연쇄 읽기가 한
어떤 일도 뒤의 호출이 할 수 있는 것이나 받는 것을 바꾸지 않습니다.

```json
{
  "project_root": "/path/to/project",
  "steps": [
    { "id": "todo", "read": { "name": "lode_product_graph_query", "arguments": { "question": "changes", "list": "reviewAgain" } }, "pages": 3 },
    { "id": "nodes", "from": "todo", "where": { "field": "kind", "eq": "node" } },
    { "id": "one", "from": "nodes", "unique": { "by": "id" } },
    { "id": "callers", "each": { "from": "one", "value": "id", "max": 20 },
      "read": { "name": "lode_product_graph_query", "arguments": { "question": "up", "id": { "$item": true } } } },
    { "id": "pointing", "from": "callers", "where": { "all": [{ "field": "kind", "eq": "node" }, { "field": "depth", "gte": 1 }] } },
    { "id": "busy", "from": "pointing", "count": { "by": "item" } },
    { "id": "top", "from": "busy", "sort": { "by": "count", "order": "desc" } }
  ],
  "return": [{ "from": "top", "limit": 10 }],
  "on_error": "continue"
}
```

- **안쪽 도구.** "답 없음", "다음 쪽", "잘림"을 어떻게 알리는지 밝힌 도구만 안쪽
  호출이 될 수 있습니다. `lode_product_graph_query`(`lode_product_graph`의
  `action: "query"`도 같음)와 `lode_project_graph`(`inventory_page` 없이)입니다.
  Session에 묶인 읽기를 포함해 다른 도구는 모두 호출 전에
  `CHAIN_TOOL_NOT_CHAINABLE`로 거부합니다. 그런 도구는 `lode_tools_read`로 직접
  부릅니다. 두 안쪽 도구는 Session에 묶이지 않고 호출자를 위해 기억해 두는 것이
  없으며, 안쪽 호출은 `lode_tools_read` 호출자가 보낼 요청 그대로이고 연쇄 읽기 요청의
  호출자, 표면, 환경, 취소 신호로 실행되므로, 안쪽 결과는 그 직접 호출과 같습니다.
  라우터, discovery 도구, 연쇄 읽기 자신, 없는 도구, 읽기 전용이 아닌 도구도 거부합니다.
- **단계.** 단계마다 `id`가 있고 줄 목록을 만들며(줄은 평범한 객체이고, 객체가
  아닌 항목은 `{ "value": … }`가 됩니다) 앞 단계만 읽습니다. 종류는 여덟 가지입니다.
  `read`(한 번 호출. `take`는 결과 안에서 줄 목록이 있는 곳으로, 점으로 잇는 경로이고
  기본은 도구가 밝힌 목록입니다. 그곳에 목록이 없으면 결과 전체가 한 줄이고 다 보지
  못한 것으로 셉니다. `pages` 1–10은 도구가 돌려준 다음 쪽 인자를 따라가며, 그런
  인자를 밝힌 도구에만 씁니다), `each`와 `read`(앞 단계의 줄마다 순서대로 한 번씩 호출.
  `value`는 넘길 필드이고, 인자 값 전체가 `{ "$item": true }`이면 그 값이 들어갑니다.
  나온 줄마다 `item`이 붙고, `max`는 쪽 넘김을 포함한 그 단계의 안쪽 호출 수입니다.
  값이 없는 줄은 호출하지 않고 세므로 먼저 걸러 냅니다), `where`(`eq`, `ne`, `in`,
  `contains`, `startsWith`, `exists`, `gte`, `lte`, `all` / `any`로 묶기), `pick`(점으로
  잇는 경로는 겹침을 그대로 둠), `sort`(`by`, `asc` / `desc`, 안정 정렬. 글자는 UTF-16
  코드 단위 순, 없거나 null인 값은 맨 뒤), `limit`, `unique`(`by`, 처음 줄이 남음),
  `count`(`by`, 처음 나온 순서의 `{ value, count }` 줄. 필드가 없는 줄은
  `{ value: null, missing: true, count }` 한 줄). 식, 정규식, 문자열 조립, 분기, 반복은
  없습니다. `lode_tools_discover`에 `name: "lode_tools_read_chain"`을 주면 이 설명을
  돌려줍니다.
- **호출 전 검사.** 프로그램 전체(형식, 단계 참조, 도구, 프로젝트 폴더, 상한)를 먼저
  검사하고 틀린 곳을 한꺼번에 `refused`로 알립니다. 그러면 안쪽 호출은 하나도
  일어나지 않습니다. `project_root`는 한 번만 적고 안쪽 호출마다 채워집니다. 안쪽
  `project_root`가 다른 폴더를 가리키면 거부합니다.
- **한 빌드.** 연쇄 읽기는 두 제품 그래프 빌드의 줄을 함께 돌려주지 않습니다. 이것은
  막는 것이 아니라 호출마다 뒤에서 알아채는 것입니다. 답이 나온 제품 그래프 질문마다
  `buildSha256`(읽은 모든 빌드의 `graph.json`과 `check.json` 바이트, 그리고 비교한
  기준)이 있습니다. 뒤의 답이 첫 답과 다르면 연쇄 읽기는 `CHAIN_BUILD_CHANGED`로 멈추고,
  답에는 줄도 어느 빌드의 내용도 없습니다. 코드와 개수, 그리고 `basis`에는 도구
  이름과 `pinned`만 남습니다(첫 빌드의 시각이나 신선도도 없음). 두 호출 사이에 다시
  빌드하거나 기준을 옮기면 이렇게 됩니다. 그런 변화 뒤의 다음 쪽은 도구가 스스로
  `basis-changed`로 알리고 연쇄 읽기는 같은 방식으로 멈춥니다. 첫 호출에 틀린
  `expected_basis_sha256`을 준 것은 그 호출의 실패입니다. `lode_project_graph`에는
  이런 식별값이 없어 `basis`에 `pinned: false`로 적힙니다.
- **실패.** 안쪽 호출이 실패하거나 거부되면 코드, 단계, 항목(줄여서)과 함께
  `issues`에 남기고 계속합니다. `on_error: "stop"`이면 거기서 멈춥니다. 다시 시도하지
  않고, 답이 아닌 것은 줄이 되지 않습니다.
- **같은 입력, 같은 출력.** 같은 입력과 같은 상태면 출력 바이트가 같습니다. 상태에는
  `lode_project_graph`의 프로세스 캐시도 들어갑니다. 같은 연쇄 읽기를 다시 하면 그
  도구가 앞선 결과를 다시 썼는지에 대해 말하는 것이 다를 수 있습니다. 답의
  `reuse.status`와, `sourceFallback.reasonCodes`(그래서
  `basis[].stated[].reasonCodes`에도)의 `PROJECT_GRAPH_SCOPED_VERIFICATION` 같은 이유
  코드입니다. 제품 그래프 답에는 이런 캐시가 없습니다.

### 상한

| 항목 | 값 |
| --- | --- |
| 단계 수 | 12 |
| 안쪽 호출 합계(쪽 넘김 포함) | 40 |
| `each` 한 번의 호출(쪽 넘김 포함) | 20 |
| `read` 한 번의 쪽 | 10 |
| `in` 하나의 값 | 100 |
| `pick` 하나의 필드 | 32 |
| 필드 경로의 부분 | 4 |
| `all` / `any` 겹침 | 2 |
| 입력의 겹침 | 32 |
| 돌려주는 크기(`max_bytes`) | 기본 16 KiB, 4 KiB부터 64 KiB까지 |
| 중간 줄 | 16 MiB |
| 입력 | 64 KiB |

프로그램 모양에 대한 상한(단계, 값, 필드, 경로 부분, 겹침, 입력, `max_bytes`, `max`,
`pages`)을 넘으면 호출 전에 거부합니다. 호출, 쪽, `each`, 중간 줄 상한은 자릅니다.
답에는 닿은 데까지의 결과와 보지 못한 개수가 들어갑니다. 보내는 답은 `max_bytes`를
넘지 않습니다. 줄 없이도 맞지 않으면 issue의 설명과 항목, 머리말, issue를 코드별
개수로, `basis`를 도구 이름으로 차례로 줄입니다.

### 답

```json
{
  "status": "completed",
  "knownMissing": [],
  "ran": { "steps": 7, "calls": 5, "failed": 0, "refused": 0 },
  "basis": [{ "tool": "lode_product_graph_query", "pinned": true, "builtAt": "…", "freshness": "…", "stated": [{ "confirmationComparison": "compared", "baselineComparison": "compared" }] }],
  "header": ["…"],
  "results": { "top": { "total": 3, "returned": 3, "cut": 0, "rows": [{ "value": "…", "count": 3 }] } },
  "notSeen": { "pagesLeft": 0, "itemsLeft": 0, "eachSkipped": 0, "eachNoValue": 0, "callsSkipped": 0, "rowsDropped": 0, "answersSaidIncomplete": 0, "takeNotAList": 0 },
  "issues": [],
  "persisted": false,
  "grantsAuthorization": false
}
```

- `status`: `completed`, `partial`(상한에 닿았거나, 도구가 답에 줄이나 내용이
  빠졌다고 했거나, 안쪽 호출이 실패·거부됐거나, `each` 값이 없는 줄이 있었거나,
  `take`가 가리킨 곳에 목록이 없던 답이 있음. 곧 0이 아닌 `notSeen` 항목), `stopped`(빌드나 기준이 바뀜,
  `on_error: "stop"`, 요청 취소), `refused`(프로그램이 틀림).
- `knownMissing`은 이 답들의 줄과 내용에서 무언가 빠졌다고 Lode가 아는 이유
  목록입니다. `STATUS_PARTIAL`이나 `STATUS_STOPPED`, `INNER_CALL_FAILED`,
  `INNER_CALL_REFUSED`, 0이 아닌 `notSeen` 항목마다 `NOT_SEEN_<count>`(따라가지 않은
  쪽은 `NOT_SEEN_pagesLeft`), `ROWS_CUT`, `STEP_NOT_REACHED`, 그리고 안쪽 답이 자기에
  대해 준 신호마다 `TOOL_SAID:<tool>:<signal>`입니다. 이 이름들도 `max_bytes`에 맞지
  않으면 도구 이유는 `TOOL_SAID_INCOMPLETE:<n>` 하나가 됩니다. **목록이 비어 있다고
  전부라는 뜻은 아닙니다. Lode가 알아챌 수 있는 빠진 것이 없었다는 뜻입니다.**
  그래프가 소스를 얼마나 덮는지는 이 목록에 없고, 제품 그래프의 `header`와
  `basis`의 `stated` 커버리지에 있습니다.
- 안쪽 도구마다 세는 신호는 다음과 같습니다. `lode_product_graph_query`는 따라가지
  않은 쪽(`page.remaining`), 답의 표시(`missing`. 무언가 검사하거나 비교하지
  않았다는 제목)와 줄의 표시(`rows[].missing`. 글로만 적힌 목록 잘림, 첫 단계
  아래에서 잘린 트리, 한 답의 줄 상한, 여섯 개로 잘린 찾기 결과의 연결, 하지 못한
  검사, 하지 않은 비교, 확인 기록 개수 한도, 읽지 못한 확인 기록), 상태가 `partial`이나
  `unavailable`인 전후 본문 한쪽, `compared`가 아닌 `confirmationComparison`이나
  `baselineComparison`(빌드가 확인 기록을 파일 이름 순으로 앞부분만 읽었으면
  `confirmationComparison`은 `partial`이고 모든 목록과 줄의 `confirmation`이 그것에서
  나옵니다. 빌드 뒤에 기준을 옮겼으면 `baselineComparison`은 `baseline-moved`입니다),
  `impact.status`가 `unavailable`이나 `partial`인 영향
  미리보기입니다.
  `lode_project_graph`는 `status` `source-fallback`(그래프에 맞는 것이 없음),
  `truncated`, `omittedMatchCount`, `boundary.items`, `boundary.omittedCount`,
  `boundary.omittedAnchorCount`, `unmatchedAnchorIds`, `integrity.excluded`,
  `integrity.omittedVerifiedRecordPathCount`, `coverage.state`,
  `coverage.layers[].status`, `coverage.inventoryBoundReached`,
  `sourceFallback.needed`, `sourceFallback.excludedInputs`, 노드의
  `contentPartial`, `directionContentCoverage.partial`, `workContentCoverage.partial`
  (요약의 방향 참조도)입니다. 프로젝트 그래프의 목록은 빠짐없는 것이 아니고, 그
  커버리지는 설계상 partial이므로 이 도구를 부르는 연쇄 읽기에는 늘 이유가 있습니다.
- 표시(`missing`)에는 `kind`(`cut`, `rowCap`, `connectionsCut`, `notChecked`,
  `notCompared`, `recordLimit`, `recordUnread`), 그 표시를 쓴 `site`, 그리고 아는
  것(`left`, `shown`과 `total`, `present`와 `read`, `check`(하지 못한 검사. 그 검사의
  목록을 따로 물은 답에도 붙음), `list`, `with`(비교하지 않은 것: `baseline`이나
  `confirmations`), `code`(읽지 못한 기록의 이유 코드), `rows`(줄 상한))이 있습니다.
  줄 상한 표시는 숨은 노드 줄을 셉니다. 그 수가 숨은 노드 줄 전부일 때만 `left`를
  가지며, 숨은 묶음 줄이나 "외 N개" 줄은 그 수에 들지 않습니다. 비교하지 않은 목록에
  답하는 "비교하지 않음 — …" 줄에는 따로 표시가 없고, 표시는 답에 있습니다.
- 다음은 답이 싣는 목록이 아니라 줄 하나나 한 덩어리의 글을 줄인 것이어서 빠졌다고
  알리지 않습니다. 기능의 위치를 줄 글에서 줄인 "… 외 N곳", `changes` 요약의 "본문은
  여기 넣지 않는다"(본문은 `changes --list content`에 있음), 빌드가 뽑지 않는 노드
  종류(개요의 "뽑지 않음". 머리말의 한계 줄에 있음), 40줄·한 줄 240자까지만 보이는
  내용 줄의 전후 본문(`rows[].detail`에 쪽 한도 안에서 전부 있음), 그리고
  `check.txt`와 Graph Explorer 페이지에만 있는 것(그곳에서 줄인 파일 목록과 나란히
  보기 글)입니다.
- 제품 그래프의 쪽 이어짐 줄(`continues: "nextPage"`)은 줄이 아니라 표시입니다.
  따라간 쪽은 그 줄들을 가져오고, 따라가지 않은 쪽은 `notSeen.pagesLeft`로 셉니다.
  뒤의 쪽이 되풀이하는 줄(뿌리, 머리 줄, 묶음 줄)은 다시 넣지 않으므로, 쪽을
  따라가면 충분히 큰 limit로 한 번 부른 것과 같은 줄이 나옵니다. 도구가 그 줄에
  표시를 달고(`repeats: "earlierPage"`) 표시된 줄만 뺍니다. 앞의 줄과 같은 줄은
  남습니다. 뒤의 쪽에서 시작한 연쇄 읽기는 그 줄들을 남깁니다. 결과의 `toolItems`는
  도구 자신이 센 항목 수(읽기마다 첫 쪽의 `page.total`, `each`면 그 호출들의 합)입니다.
- `basis`는 안쪽 도구마다 한 번씩 적습니다. `pinned`, 제품 그래프는 첫 답의
  `builtAt`과 신선도, 그리고 `stated`한 것(`confirmationComparison`,
  `baselineComparison`, impact면 그 상태와 이유), `lode_project_graph`는 `stated`한
  것(커버리지 상태, 소스로 돌아가야 하는지, 제외된 층과 이유 코드, 대체 이유 코드,
  `status`, `unmatchedAnchorIds`)입니다. 도구마다 서로 다른 것을 넷까지 싣고, 빈
  것은 싣지 않습니다. 목록은 여덟 개까지 싣고 나머지 수를 적습니다(`<name>Omitted`).
- `return`에 적은 단계만 줄을 싣습니다. `total`은 그 단계의 줄 수, `returned`는 답에
  실은 줄 수, `cut`은 나머지(`return`의 `limit`이나 `max_bytes`)입니다.
- `notSeen`: `pagesLeft`는 다음 쪽이 남은 채 멈춘 읽기 수, `itemsLeft`는 그 쪽들에
  남은 항목 수, `eachSkipped`는 `each` 상한을 넘은 줄 수, `eachNoValue`는 `each` 값이
  없는 줄 수, `callsSkipped`는 호출 상한이나 중간 줄 상한 때문에 하지 않은 호출 수,
  `rowsDropped`는 중간 줄 상한에서 버린 줄 수, `answersSaidIncomplete`는 자기에게서
  줄이나 내용이 빠졌다고 한 안쪽 답 수, `takeNotAList`는 `take`가 가리킨 곳에 목록이
  없던 답 수입니다.
- 모든 안쪽 답이 되풀이한 머리말은 `header`에 한 번만 싣습니다. 서로 다르면
  `headers`에 나온 단계와 함께 적습니다.
- 내용 글은 JSON 답 그 자체이고, 줄을 글로 한 번 더 싣지 않습니다.

CLI에도 같은 연쇄 읽기가 있고, 검사와 답도 같습니다:
`lode-agent tools-read-chain <project> --input chain.json`. 입력에서
`project_root`는 빼도 됩니다.

### 결과 모양

`lode_tools_discover`에 정확한 이름을 주면 짧은 `resultShape`를 돌려줍니다.
`lode_product_graph_query`(줄 `rows`, `header`, 쪽 `page.total`, `page.remaining`,
`page.nextMcpArguments`, `builtAt`, `buildSha256`, `confirmationComparison`),
`lode_project_graph`(줄 `nodes`, 그리고 `edges`. `inventory_page`가 있으면 줄은
`inventoryPage.rows`, 다음 호출은 `inventoryPage.next`), `lode_session_work_read`(줄
`records`, 그리고 `todoContext.items`, 다음 `nextAfterEvidenceId`)입니다. `chainable`은
그 도구가 안쪽 호출이 될 수 있는지 알려 줍니다. 묶음 도구는 모양이 있는 action마다
그 모양을 싣습니다.

## 폐기 예정 이름

묶음으로 대체된 작업 이름은 마이너 버전 두 개 동안 계속 호출할 수 있습니다.
직접 호출, `lode_tools_read` / `lode_tools_call` 경유 호출, 예전 `head_*` 표기가
모두 동작합니다. 제거 버전은 표 머리글에 적혀 있습니다.

- discovery는 묶음 도구만 나열합니다. 폐기 예정 이름으로 조회하면 그 묶음 도구를
  반환하며, `deprecatedAliases`에 옛 이름마다 `action`과 `removedIn` 버전이
  담깁니다.
- `hooks/claude.json`의 Claude Code `PreToolUse` matcher는 효과가 있거나 Session에
  묶인 action을 가진 모든 묶음 도구와, 그런 작업의 폐기 예정 이름을 포함합니다.
- 다음 호출을 알려 주는 작업 결과는 묶음 도구와 그 action을 씁니다. 예를 들어
  `lode_session`과 `action: "work_read"`, 또는 `lode_context`와
  `action: "prepare"`입니다. 폐기 예정 이름은 더 이상 안내하지 않으며, 제거 버전
  전까지는 계속 호출할 수 있습니다.

## 매핑

<!-- generated: mcp-surface-groups (node scripts/generate-mcp-surface-docs.mjs) -->

| 묶음 도구 | `action` | 경로 | 폐기 예정 이름 (0.5.0) |
| --- | --- | --- | --- |
| `lode_bounded_worker` | `prepare` | `lode_tools_call`, `execution_mode: managed` 필요 | `lode_bounded_worker_prepare` |
| `lode_bounded_worker` | `start` | `lode_tools_call`, `execution_mode: managed` 필요 | `lode_bounded_worker_start` |
| `lode_bounded_worker` | `reconcile` | `lode_tools_call`, `execution_mode: managed` 필요 | `lode_bounded_worker_reconcile` |
| `lode_bounded_worker` | `dispatch` | `lode_tools_call`, `execution_mode: managed` 필요 | `lode_bounded_worker_dispatch` |
| `lode_bounded_worker` | `status` | `lode_tools_read` | `lode_bounded_worker_status` |
| `lode_bounded_worker` | `wait` | `lode_tools_read` | `lode_bounded_worker_wait` |
| `lode_bounded_worker` | `apply_result` | `lode_tools_call`, `execution_mode: managed` 필요 | `lode_bounded_worker_apply_result` |
| `lode_bounded_worker_job` | `reconcile` | `lode_tools_call`, `execution_mode: managed` 필요 | `lode_bounded_worker_job_reconcile` |
| `lode_bounded_worker_job` | `patch` | `lode_tools_read` | `lode_bounded_worker_job_patch` |
| `lode_bounded_worker_wave` | `create` | `lode_tools_call`, `execution_mode: managed` 필요 | `lode_bounded_worker_wave_create` |
| `lode_bounded_worker_wave` | `read` | `lode_tools_read` | `lode_bounded_worker_wave_read` |
| `lode_bounded_worker_wave` | `seal` | `lode_tools_call`, `execution_mode: managed` 필요 | `lode_bounded_worker_wave_seal` |
| `lode_bounded_worker_wave` | `status` | `lode_tools_read` | `lode_bounded_worker_wave_status` |
| `lode_bounded_worker_wave` | `results` | `lode_tools_read` | `lode_bounded_worker_wave_results` |
| `lode_bounded_worker_wave` | `wait` | `lode_tools_read` | `lode_bounded_worker_wave_wait` |
| `lode_bounded_worker_wave` | `abandon` | `lode_tools_call`, `execution_mode: managed` 필요 | `lode_bounded_worker_wave_abandon` |
| `lode_project_document` | `prepare` | `lode_tools_call` | `lode_project_document_prepare` |
| `lode_project_document` | `publish` | `lode_tools_call` | `lode_project_document_publish` |
| `lode_project_document` | `status` | `lode_tools_read` | `lode_project_document_status` |
| `lode_work_document` | `configure` | `lode_tools_call` | `lode_work_document_configure` |
| `lode_work_document` | `prepare` | `lode_tools_call` | `lode_work_document_prepare` |
| `lode_work_document` | `publish` | `lode_tools_call` | `lode_work_document_publish` |
| `lode_work_document` | `status` | `lode_tools_read` | `lode_work_document_status` |
| `lode_onboarding` | `guide` | `lode_tools_read` | `lode_onboarding_guide` |
| `lode_onboarding` | `semantic_refresh` | `lode_tools_call` | `lode_onboarding_semantic_refresh` |
| `lode_onboarding` | `candidate_restore` | `lode_tools_call` | `lode_onboarding_candidate_restore` |
| `lode_onboarding` | `review` | `lode_tools_call` | `lode_onboarding_review` |
| `lode_onboarding` | `status` | `lode_tools_read` | `lode_onboarding_status` |
| `lode_project_bundle` | `export` | `lode_tools_call` | `lode_project_bundle_export` |
| `lode_project_bundle` | `read` | `lode_tools_read` | `lode_project_bundle_read` |
| `lode_project_bundle` | `import` | `lode_tools_call` | `lode_project_bundle_import` |
| `lode_product` | `signal_record` | `lode_tools_call` | `lode_product_signal_record` |
| `lode_product` | `hypothesis_record` | `lode_tools_call` | `lode_product_hypothesis_record` |
| `lode_product` | `initiative_propose` | `lode_tools_call` | `lode_product_initiative_propose` |
| `lode_product` | `initiative_review` | `lode_tools_call` | `lode_product_initiative_review` |
| `lode_product` | `outcome_observe` | `lode_tools_call` | `lode_product_outcome_observe` |
| `lode_product` | `operating_status` | `lode_tools_read` | `lode_product_operating_status` |
| `lode_product` | `policy_propose` | `lode_tools_call` | `lode_product_policy_propose` |
| `lode_product` | `policy_review` | `lode_tools_call` | `lode_product_policy_review` |
| `lode_product` | `policy_status` | `lode_tools_read` | `lode_product_policy_status` |
| `lode_product` | `policy_candidate` | `lode_tools_read` | `lode_product_policy_candidate` |
| `lode_product` | `policy_review_decision` | `lode_tools_read` | `lode_product_policy_review_decision` |
| `lode_metric` | `define` | `lode_tools_call` | `lode_metric_define` |
| `lode_metric` | `observe` | `lode_tools_call` | `lode_metric_observe` |
| `lode_metric` | `compare` | `lode_tools_call` | `lode_metric_compare` |
| `lode_metric` | `assess` | `lode_tools_call` | `lode_metric_assess` |
| `lode_metric` | `status` | `lode_tools_read` | `lode_metric_status` |
| `lode_metric` | `trace` | `lode_tools_read` | `lode_metric_trace` |
| `lode_delivery` | `observe` | `lode_tools_call` | `lode_delivery_observe` |
| `lode_delivery` | `status` | `lode_tools_read` | `lode_delivery_status` |
| `lode_delivery` | `release_observe` | `lode_tools_call` | `lode_release_observe` |
| `lode_delivery` | `release_status` | `lode_tools_read` | `lode_release_status` |
| `lode_runtime` | `adapters` | `lode_tools_read` | `lode_runtime_adapters` |
| `lode_runtime` | `invocation_authorization` | `lode_tools_read` | `lode_runtime_invocation_authorization` |
| `lode_runtime` | `invocation_result` | `lode_tools_read` | `lode_runtime_invocation_result` |
| `lode_runtime` | `state` | `lode_tools_read` | `lode_runtime_state` |
| `lode_feature_mapping` | `propose` | `lode_tools_call` | `lode_feature_mapping_propose` |
| `lode_feature_mapping` | `status` | `lode_tools_read` | `lode_feature_mapping_status` |
| `lode_feature_mapping` | `review` | `lode_tools_call` | `lode_feature_mapping_review` |
| `lode_product_graph` | `build` | `lode_tools_call` | `lode_product_graph_build` |
| `lode_product_graph` | `check` | `lode_tools_read` | `lode_product_graph_check` |
| `lode_product_graph` | `query` | `lode_tools_read` | `lode_product_graph_query` |
| `lode_product_graph` | `sample` | `lode_tools_read` | `lode_product_graph_sample` |
| `lode_product_graph` | `coverage` | `lode_tools_read` | `lode_product_graph_coverage` |
| `lode_product_graph` | `baseline` | `lode_tools_call` | `lode_product_graph_baseline` |
| `lode_product_graph` | `confirm` | `lode_tools_call` | `lode_product_graph_confirm` |
| `lode_product_graph` | `runs_add` | `lode_tools_call` | `lode_product_graph_runs_add` |
| `lode_product_graph` | `approve` | `lode_tools_call` | `lode_product_graph_approve` |
| `lode_vcs` | `change_set_status` | `lode_tools_read` | `lode_change_set_status` |
| `lode_vcs` | `evidence` | `lode_tools_read` | `lode_vcs_evidence` |
| `lode_vcs` | `git_history` | `lode_tools_read` | `lode_git_history` |
| `lode_conformance` | `prepare` | `lode_tools_read` | `lode_conformance_prepare` |
| `lode_conformance` | `propose` | `lode_tools_call` | `lode_conformance_propose` |
| `lode_conformance` | `queue` | `lode_tools_read` | `lode_conformance_queue` |
| `lode_conformance` | `read` | `lode_tools_read` | `lode_conformance_read` |
| `lode_conformance` | `disposition` | `lode_tools_call` | `lode_conformance_disposition` |
| `lode_conformance` | `resolution_propose` | `lode_tools_call` | `lode_conformance_resolution_propose` |
| `lode_conformance` | `trigger_status` | `lode_tools_read` | `lode_conformance_trigger_status` |
| `lode_conformance` | `trigger_prepare` | `lode_tools_call` | `lode_conformance_trigger_prepare` |
| `lode_source` | `context` | `lode_tools_call` | `lode_source_context` |
| `lode_source` | `observation_read` | `lode_tools_read` | `lode_source_observation_read` |
| `lode_context` | `prepare` | `lode_tools_read` | `lode_context_prepare` |
| `lode_context` | `preview` | `lode_tools_read` | `lode_context_preview` |
| `lode_context` | `capsule` | `lode_tools_read` | `lode_context_capsule` |
| `lode_session` | `work_record` | `lode_tools_call` | `lode_session_work_record` |
| `lode_session` | `work_read` | `lode_tools_read` | `lode_session_work_read` |
| `lode_session` | `continue` | `lode_tools_call` | `lode_session_continue` |
| `lode_run` | `integrate_checkpoint` | `lode_tools_call` | `lode_run_integrate_checkpoint` |
| `lode_run` | `integration` | `lode_tools_read` | `lode_run_integration` |
| `lode_run` | `start` | `lode_tools_call` | `lode_run_start` |
| `lode_world` | `model` | `lode_tools_read` | `lode_world_model` |
| `lode_world` | `query` | `lode_tools_read` | `lode_world_query` |
| `lode_projection` | `incremental_refresh_status` | `lode_tools_read` | `lode_incremental_refresh_status` |
| `lode_projection` | `incremental_refresh_receipt` | `lode_tools_read` | `lode_incremental_refresh_receipt` |
| `lode_projection` | `refresh_trigger_status` | `lode_tools_read` | `lode_refresh_trigger_status` |
| `lode_projection` | `refresh_trigger_delivery` | `lode_tools_read` | `lode_refresh_trigger_delivery` |
| `lode_projection` | `graph_projection_status` | `lode_tools_read` | `lode_graph_projection_status` |
| `lode_projection` | `graphdb_projection_status` | `lode_tools_read` | `lode_graphdb_projection_status` |
| `lode_projection` | `graphdb_database_status` | `lode_tools_read` | `lode_graphdb_database_status` |
| `lode_projection` | `graphdb_connection_preflight` | `lode_tools_read` | `lode_graphdb_connection_preflight` |
| `lode_projection` | `graphdb_database_initialize` | `lode_tools_call` | `lode_graphdb_database_initialize` |
| `lode_projection` | `graphdb_projection_activate` | `lode_tools_call` | `lode_graphdb_projection_activate` |
| `lode_projection` | `markdown_projection_build` | `lode_tools_call` | `lode_markdown_projection_build` |
| `lode_projection` | `markdown_projection_status` | `lode_tools_read` | `lode_markdown_projection_status` |
| `lode_projection` | `post_refresh_projection_status` | `lode_tools_read` | `lode_post_refresh_projection_status` |
| `lode_projection` | `post_refresh_projection_receipt` | `lode_tools_read` | `lode_post_refresh_projection_receipt` |
| `lode_document_change` | `candidates` | `lode_tools_read` | `lode_document_change_candidates` |
| `lode_document_change` | `review_status` | `lode_tools_read` | `lode_document_change_review_status` |
| `lode_document_change` | `review` | `lode_tools_read` | `lode_document_change_review` |
| `lode_document_change` | `application` | `lode_tools_read` | `lode_document_change_application` |
| `lode_graph_lineage` | `status` | `lode_tools_read` | `lode_graph_lineage_status` |
| `lode_graph_lineage` | `trace` | `lode_tools_read` | `lode_graph_lineage_trace` |
| `lode_graph_lineage` | `diff` | `lode_tools_read` | `lode_graph_lineage_diff` |
| `lode_compact` | `prepare` | `lode_tools_call` | `lode_compact_prepare` |
| `lode_compact` | `verify` | `lode_tools_call` | `lode_compact_verify` |
| `lode_compact` | `continue` | `lode_tools_call` | `lode_compact_continue` |
| `lode_compact` | `status` | `lode_tools_read` | `lode_compact_status` |
| `lode_compact` | `abort` | `lode_tools_call` | `lode_compact_abort` |
| `lode_compact` | `compaction_lifecycle_step` | `lode_tools_call` | `lode_compaction_lifecycle_step` |
| `lode_observation` | `sources` | `lode_tools_read` | `lode_observation_sources` |
| `lode_observation` | `prepare` | `lode_tools_read` | `lode_observation_prepare` |
| `lode_observation` | `collect_source` | `lode_tools_call` | `lode_observation_collect_source` |
| `lode_observation` | `ingest` | `lode_tools_call` | `lode_observation_ingest` |
| `lode_observation` | `derive` | `lode_tools_call` | `lode_observation_derive` |
| `lode_observation` | `read` | `lode_tools_read` | `lode_observation_read` |
| `lode_observation` | `query` | `lode_tools_read` | `lode_observation_query` |

<!-- end generated: mcp-surface-groups -->

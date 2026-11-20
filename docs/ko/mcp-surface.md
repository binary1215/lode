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

## 읽기 묶음

`lode_tools_read_chain`은 읽기 전용 Lode 도구 호출 여러 개를 단계 목록 하나로 받아
서버 안에서 잇고, 요청한 줄과 Lode가 센 개수만 돌려줍니다. 코드를 실행하지 않습니다.
단계는 식이 아니라 데이터입니다. 묶음은 아무 권한도 주지 않고 아무것도 쓰지 않습니다
(기록, 캐시, 임시 파일 모두 없음).

```json
{
  "project_root": "/path/to/project",
  "steps": [
    { "id": "todo", "read": { "name": "lode_product_graph_query", "arguments": { "question": "changes", "list": "reviewAgain" } }, "pages": 3 },
    { "id": "nodes", "from": "todo", "where": { "field": "kind", "eq": "node" } },
    { "id": "one", "from": "nodes", "unique": { "by": "id" } },
    { "id": "callers", "each": { "from": "one", "value": "id", "max": 20 },
      "read": { "name": "lode_product_graph_query", "arguments": { "question": "up", "id": { "$item": true } } } },
    { "id": "busy", "from": "callers", "count": { "by": "item" } },
    { "id": "top", "from": "busy", "sort": { "by": "count", "order": "desc" } }
  ],
  "return": [{ "from": "top", "limit": 10 }],
  "on_error": "continue"
}
```

- **단계.** 단계마다 `id`가 있고 줄 목록을 만듭니다(줄은 평범한 객체이고, 객체가
  아닌 항목은 `{ "value": … }`가 됩니다). 단계는 앞 단계만 읽습니다. 종류는 여덟
  가지입니다. `read`(한 번 호출. `take`는 결과 안에서 줄 목록이 있는 곳으로, 점으로
  잇는 경로이고 기본은 `rows`입니다. 그곳에 목록이 없으면 결과 전체가 한 줄입니다.
  `pages` 1–10은 도구가 돌려준 `page.nextMcpArguments`를 따라갑니다), `each`와
  `read`(앞 단계의 줄마다 순서대로 한 번씩 호출. `value`는 넘길 필드이고, 인자 값
  전체가 `{ "$item": true }`이면 그 값이 들어갑니다. 나온 줄마다 `item`이 붙습니다),
  `where`(`eq`, `ne`, `in`, `contains`, `startsWith`, `exists`, `gte`, `lte`,
  `all` / `any`로 두 겹까지), `pick`, `sort`(`by`, `asc` / `desc`, 안정 정렬),
  `limit`, `unique`(`by`, 처음 줄이 남음), `count`(`by`, 처음 나온 순서의
  `{ value, count }` 줄). 식, 정규식, 문자열 조립, 분기, 반복은 없습니다.
  `lode_tools_discover`에 `name: "lode_tools_read_chain"`을 주면 이 설명을
  돌려줍니다.
- **안쪽 호출.** `project_root`는 한 번만 적고, 스키마에 `project_root`가 있는 안쪽
  호출마다 채워집니다. 안쪽 호출이 다른 폴더를 가리키면 거부합니다. 안쪽 호출은
  `lode_tools_read` 호출자가 보낼 요청 그대로이고, 묶음 요청의 호출자, Session
  연결, 표면, 취소 신호로 실행되므로 그 경로의 검사가 모두 적용됩니다. 라우터,
  discovery 도구, 묶음 자신, 없는 도구, 읽기 전용이 아닌 도구는 호출 전에 거부합니다.
  안쪽 도구에 호출자의 Session 연결이 필요하면 묶음이 한 번 확인합니다(Claude
  Code에서는 PreToolUse Hook이 다른 라우터처럼 묶음에도 걸립니다).
- **호출 전 검사.** 프로그램 전체(형식, 단계 참조, 도구, 프로젝트 폴더)를 먼저
  검사하고 틀린 곳을 한꺼번에 `refused`로 알립니다. 그러면 안쪽 호출은 하나도
  일어나지 않습니다.
- **한 빌드.** 묶음은 두 제품 그래프 빌드의 줄을 함께 돌려주지 않습니다. 이것은
  막는 것이 아니라 호출마다 뒤에서 알아채는 것입니다. 답이 나온 제품 그래프 질문마다
  `buildSha256`(읽은 `graph.json`과 `check.json`의 바이트, 그리고 비교한 기준)이
  있습니다. 뒤의 `lode_product_graph_query` 답이 첫 답과 다르면 묶음은
  `CHAIN_BUILD_CHANGED`로 멈추고 줄을 하나도 돌려주지 않습니다. 두 호출 사이에 다시
  빌드하거나 기준을 옮기면 이렇게 됩니다. 그런 변화 뒤의 다음 쪽은 도구가 스스로
  `basis-changed`로 알리고, 묶음은 같은 방식으로 멈춥니다. 다른 도구에는 이런
  식별값이 없어 `basis`에 `pinned: false`로 적힙니다.
- **실패.** 안쪽 호출이 실패하거나 거부되면 코드, 단계, 항목과 함께 `issues`에
  남기고 계속합니다. `on_error: "stop"`이면 거기서 멈춥니다. 다시 시도하지 않습니다.
- **같은 입력, 같은 출력.** 같은 입력과 같은 상태면 출력 바이트가 같습니다.

### 상한

| 항목 | 값 |
| --- | --- |
| 단계 수 | 12 |
| 안쪽 호출 합계(쪽 넘김 포함) | 40 |
| `each` 한 번의 호출 | 20 |
| `read` 한 번의 쪽 | 10 |
| 돌려주는 크기(`max_bytes`) | 기본 16 KiB, 최대 64 KiB |
| 중간 줄 | 16 MiB |
| 입력 | 64 KiB |

형식이 틀렸거나 단계가 너무 많으면 호출 전에 거부합니다. 다른 상한은 자릅니다.
답에는 닿은 데까지의 결과와 보지 못한 개수가 들어갑니다.

### 답

```json
{
  "status": "completed",
  "ran": { "steps": 6, "calls": 5, "failed": 0, "refused": 0 },
  "basis": [{ "tool": "lode_product_graph_query", "builtAt": "…", "freshness": "…", "pinned": true }],
  "header": ["…"],
  "results": { "top": { "total": 3, "returned": 3, "cut": 0, "rows": [{ "value": "…", "count": 3 }] } },
  "notSeen": { "pagesLeft": 0, "itemsLeft": 0, "eachSkipped": 0, "callsSkipped": 0, "rowsDropped": 0 },
  "issues": [],
  "persisted": false,
  "grantsAuthorization": false
}
```

- `status`: `completed`, `partial`(상한에 닿았거나 안쪽 호출이 실패·거부됨),
  `stopped`(빌드가 바뀜, `on_error: "stop"`, 요청 취소), `refused`(프로그램이 틀림).
- `return`에 적은 단계만 줄을 싣습니다. `total`은 그 단계의 줄 수, `returned`는
  답에 실은 줄 수, `cut`은 나머지(`return`의 `limit`이나 `max_bytes`)입니다.
- `notSeen`: `pagesLeft`는 다음 쪽이 남은 채 멈춘 읽기 수, `itemsLeft`는 그 쪽들에
  남은 항목 수, `eachSkipped`는 `each` 상한을 넘은 줄 수, `callsSkipped`는 호출
  상한이나 중간 줄 상한 때문에 하지 않은 호출 수, `rowsDropped`는 중간 줄 상한에서
  버린 줄 수입니다.
- 상태가 `completed`이고, `ran.failed`와 `ran.refused`가 0이고, 모든 `cut`과
  `notSeen`이 0일 때만 전부 본 것입니다.
- 모든 안쪽 답이 되풀이한 머리말은 `header`에 한 번만 싣습니다. 서로 다르면
  `headers`에 나온 단계와 함께 적습니다.
- 내용 글은 JSON 답 그 자체이고, 줄을 글로 한 번 더 싣지 않습니다.

CLI에도 같은 묶음이 있고, 검사와 답도 같습니다:
`lode-agent tools-read-chain <project> --input chain.json`. 입력에서
`project_root`는 빼도 됩니다.

### 결과 모양

`lode_tools_discover`에 정확한 이름을 주면 짧은 `resultShape`를 돌려줍니다.
`lode_product_graph_query`(줄 `rows`, `header`, 쪽 `page.total`, `page.remaining`,
`page.nextMcpArguments`, 빌드 `builtAt`, `buildSha256`), `lode_project_graph`(줄
`nodes`, 그리고 `edges`), `lode_session_work_read`(줄 `records`, 그리고
`todoContext.items`, 다음 `nextAfterEvidenceId`)입니다. 묶음 도구는 모양이 있는
action마다 그 모양을 싣습니다. 다른 읽기 도구에는 `rows` 목록이 없습니다. `take`로
목록을 적거나, 아니면 답 전체가 한 줄이 됩니다.

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
| `lode_product_graph` | `baseline` | `lode_tools_call` | `lode_product_graph_baseline` |
| `lode_product_graph` | `confirm` | `lode_tools_call` | `lode_product_graph_confirm` |
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

# MCP 도구 표면과 폐기 예정 이름

[영어 원문](../mcp-surface.md)

Lode는 작은 기본 MCP 도구 목록만 나열하고, 나머지 작업은 discovery와 두 라우터로
사용할 수 있게 합니다. 0.3부터 같은 자원에 대한 작업은 `action`을 받는 도구
하나로 묶입니다.

## 기본 목록

일반 `tools/list`는 같은 이름과 스키마의 도구 23개를 그대로 유지합니다.
여기에는 `lode_tools_discover`, `lode_tools_read`, `lode_tools_call`이
포함됩니다. 묶음은 discovery와 managed maintenance `tools/list`에 보이는 것만
바꿉니다.

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
  필수·선택 필드는 여전히 action마다 검사됩니다. Lode가 `action`을 떼어 내고
  나머지 인자로 원래 작업을 실행하기 때문입니다.
- **결과.** 묶음 호출은 원래 작업의 결과를 그대로 반환하고, 같은 Session,
  write-guard, managed-surface 검사를 거칩니다.
- **오류.** `action`이 없거나 알 수 없는 값이면 작업을 실행하기 전에
  `INVALID_TOOL_ARGUMENTS`로 거부합니다.

## 폐기 예정 이름

묶음으로 대체된 작업 이름은 마이너 버전 두 개 동안 계속 호출할 수 있습니다.
직접 호출, `lode_tools_read` / `lode_tools_call` 경유 호출, 예전 `head_*` 표기가
모두 동작합니다. 제거 버전은 표 머리글에 적혀 있습니다.

- discovery는 묶음 도구만 나열합니다. 폐기 예정 이름으로 조회하면 그 묶음 도구를
  반환하며, `deprecatedAliases`에 옛 이름마다 `action`과 `removedIn` 버전이
  담깁니다.
- `hooks/claude.json`의 Claude Code `PreToolUse` matcher는 묶음 도구와 폐기 예정
  이름을 모두 포함합니다.

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

<!-- end generated: mcp-surface-groups -->

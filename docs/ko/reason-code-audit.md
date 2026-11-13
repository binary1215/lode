> 이 문서는 [reason-code-audit.md](../reason-code-audit.md)의 한국어판입니다. 코드, 명령, 프로토콜 식별자와 필드 이름은 원문 표기를 유지합니다.

# 거절 코드 감사

조사일: 2026-11-12, 0.3.0-beta.115(`main` b466613) 기준. 요약과 영역별 수치는 코드 한
개를 더한 0.3.0-beta.119 기준으로 다시 돌린 값입니다(beta.118에서 두 개 추가). 스크립트는 이 보고서 자체는
세지 않습니다.

이 감사는 `REASON_CODES`(`scripts/lib/core/errors.mjs`)에 있는 거절 코드마다,
메시지가 아니라 코드 값 자체를 무엇이 쓰는지 셉니다. 코드는 바꾸지 않습니다.
설계 항목 4.6의 조사 단계입니다. 아무도 쓰지 않는 코드를 묶을지는 다음 병합 단계에서
정하며, 이 감사는 그 결정에 쓸 숫자와 후보만 제시합니다.

숫자는 `node scripts/audit-reason-codes.mjs`로 다시 뽑습니다. `--json`을 붙이면 모든
행을 출력합니다.

## 방법

스크립트는 추적되는 파일을 한 번씩 읽고, 목록에 있는 코드가 나올 때마다 분류합니다.

| 분류 | 위치 | 판정 |
| --- | --- | --- |
| prefix 분기 | 배포 코드의 `code.startsWith("PREFIX")` | 사용됨 |
| 분기 | 배포 코드에서 비교하는 줄(`===`, `!==`, `case`, `includes`, `has`, `test`) | 사용됨 |
| 키 | 배포 코드 객체의 키(`CODE: …`) | 사용됨 |
| 목록 | 배포 코드의 배열이나 `Set` 리터럴 항목 | 사용됨(보통 분기용 집합) |
| Go | `native/**/*.go` | 사용됨(Go 워커나 브리지가 내거나 읽음) |
| 문서 | 영문 `docs/`, `README.md`, `skills/` | 문서화됨 |
| 테스트 | `test/`, `scripts/verify-*`, codemod | 테스트됨 |
| 발생 | 그 밖의 배포 코드 출현(`fail(…)`, `code` 필드) | 어느 쪽도 아님 |

**조용한 코드**는 사용되지도 문서화되지도 않은 코드입니다. 자기 `throw` 바깥에서는
아무것도 이 코드를 읽지 않으므로, 에이전트나 사용자는 메시지로만 원인을 압니다. 줄 단위
휴리스틱이어서 여러 줄에 걸친 비교나 변수를 거쳐 전달되는 코드는 놓칠 수 있습니다.
따라서 조용한 코드는 확인할 후보이지, 안 쓰인다고 증명된 것은 아닙니다.

## 요약

| 항목 | 코드 수 |
| --- | --- |
| `REASON_CODES` 항목 | 2,724 |
| 배포 코드나 Go에서 사용 | 359 |
| — 직접 비교 | 186 |
| — prefix 분기에 포함 | 20 |
| — 맵의 키로만 사용 | 5 |
| — 배열이나 `Set`에만 나열 | 147 |
| — Go 소스에 등장 | 17 |
| 영문 문서·스킬에 문서화 | 33(스킬 9) |
| 테스트·검증기가 단언 | 840 |
| **조용한 코드** | **2,350**(86%) |
| — 조용하지만 테스트가 단언 | 621 |
| — 조용하고 단언도 없음 | 1,729 |
| 옛 `HEAD_*` 표기를 아직 함께 돌려줌 | 121 |

**prefix 분기.** 다음 네 prefix가 코드 묶음으로 분기합니다.
- `CONVERSATION_PATH`(4곳, `conversation-messaging.mjs`)
- `SOURCE_EXPORT_`(`portable-source-originals.mjs`)
- `SESSION_RESTORE_`, `SESSION_RUN_`(`recovery-checkpoint-diagnosis.mjs`)

이 묶음 안의 코드를 합칠 때 prefix를 유지하지 않으면 동작이 바뀝니다.

**배포 JavaScript가 내지 않는 코드:** 다음 6개는 검증기에만 나옵니다.
- `LIVE_CODEX_E2E_*`(3개)
- `LIVE_RUNTIME_E2E_OPT_IN_REQUIRED`
- `PROCESS_SUPERVISOR_VERIFY_ERROR`
- `RUNTIME_LIFECYCLE_VERIFY_ERROR`

## 영역별

영역은 코드의 첫 단어입니다. 코드가 20개 이상인 영역만 적었습니다.

| 영역 | 코드 | 사용 | 문서 | 조용함 | 조용함·테스트 |
| --- | --- | --- | --- | --- | --- |
| `INVALID_*` | 576 | 60 | 4 | 515 | 100 |
| `NATIVE_*` | 252 | 40 | 3 | 209 | 61 |
| `CODEX_*` | 180 | 13 | 0 | 167 | 69 |
| `PROJECT_*` | 138 | 22 | 3 | 115 | 29 |
| `RUNTIME_*` | 92 | 10 | 1 | 82 | 29 |
| `ARCADEDB_*` | 83 | 12 | 0 | 71 | 15 |
| `DOCUMENT_*` | 78 | 6 | 2 | 71 | 10 |
| `ONBOARDING_*` | 75 | 7 | 2 | 68 | 11 |
| `PRODUCT_*` | 74 | 3 | 0 | 71 | 12 |
| `WORKER_*` | 61 | 18 | 0 | 43 | 23 |
| `SESSION_*` | 48 | 17 | 2 | 31 | 16 |
| `SNAPSHOT_*` | 47 | 12 | 1 | 34 | 16 |
| `SOURCE_*` | 45 | 23 | 0 | 22 | 7 |
| `UNSUPPORTED_*` | 42 | 6 | 0 | 36 | 6 |
| `REFRESH_*` | 41 | 1 | 1 | 40 | 3 |
| `CHANGE_*` | 35 | 2 | 0 | 33 | 2 |
| `CLAUDE_*` | 34 | 1 | 0 | 33 | 6 |
| `FEATURE_*` | 33 | 4 | 0 | 29 | 7 |
| `CONVERSATION_*` | 32 | 7 | 1 | 24 | 7 |
| `GRAPH_*` | 32 | 2 | 2 | 28 | 10 |
| `WORK_*` | 32 | 4 | 0 | 28 | 8 |
| `DISTRIBUTION_*` | 31 | 0 | 0 | 31 | 10 |
| `DUPLICATE_*` | 30 | 3 | 0 | 27 | 7 |
| `HISTORICAL_*` | 30 | 0 | 0 | 30 | 2 |
| `RUN_*` | 30 | 1 | 1 | 29 | 14 |
| `CONFORMANCE_*` | 27 | 5 | 1 | 22 | 8 |
| `PREPARED_*` | 27 | 3 | 0 | 24 | 8 |
| `TEMPORAL_*` | 27 | 2 | 0 | 25 | 7 |
| `BOUNDED_*` | 26 | 6 | 0 | 20 | 8 |
| `COMPACTION_*` | 25 | 6 | 0 | 19 | 8 |
| `GC_*` | 22 | 0 | 0 | 22 | 4 |
| `OBSERVATION_*` | 21 | 7 | 0 | 14 | 2 |
| `UNKNOWN_*` | 21 | 2 | 0 | 19 | 2 |
| `WORLD_*` | 21 | 4 | 1 | 17 | 5 |
| `POST_*` | 20 | 0 | 0 | 20 | 1 |

조용한 코드를 마지막 단어로 나누면 다음과 같습니다.

| 마지막 단어 | 조용한 코드 |
| --- | --- |
| (`INVALID_*` prefix) | 515 |
| `MISMATCH` | 397 |
| `INVALID` | 131 |
| `CONFLICT` | 114 |
| `REQUIRED` | 109 |
| `ERROR` | 86 |
| `UNAVAILABLE` | 69 |
| `MISSING` | 64 |
| `DRIFT` | 57 |
| `FOUND` | 50 |
| `LIMIT` | 45 |

## 문서화된 코드

영문 문서나 스킬이 이름을 밝힌 코드는 28개이며, 에이전트가 이 값으로 분기할 수 있습니다.
- `COMPUTE_OUTPUT_LIMIT`, `CONFORMANCE_RESOLUTION_STALE`,
  `CONVERSATION_ENTRY_BASIS_CHANGED`, `DIVERGENT_DEPLOYMENT_RESULT_REPLAY`
- `DOCUMENT_PROJECTION_UNREVIEWED_DRIFT`, `GRAPH_PROJECTION_STALE`,
  `GRAPH_SNAPSHOT_RECEIPT_SELF_REFERENCE`, `INVALID_SESSION_INPUT`
- `INVALID_SESSION_WORK_EVIDENCE`, `INVALID_SNAPSHOT_COMPOSITION`,
  `INVALID_TOOL_ARGUMENTS`, `MANAGED_OPERATION_NOT_ON_DEFAULT_SURFACE`
- `NATIVE_HOOK_DIRECT_INGRESS_REQUIRED`, `NATIVE_HOOK_INGRESS_REQUIRED`,
  `NATIVE_OPENCODE_BOOTSTRAP_UNQUALIFIED`, `NOT_INITIALIZED`
- `NO_PENDING_REVIEW`, `PROJECT_NATIVE_RUNTIME_ROOT_NOT_USED`,
  `PROJECT_NOT_READY`, `PROJECT_RELOCATION_PENDING`
- `RECOVERY_BASIS_NOT_HELD`, `REFRESH_WRITER_BUSY`,
  `RUNTIME_ADAPTER_CONTROL_NOT_ENABLED`, `RUN_RESULT_LEGACY_INTEGRATION_PENDING`
- `SESSION_PATH_ESCAPE`, `SNAPSHOT_GIT_EXECUTABLE_UNAVAILABLE`,
  `STORAGE_VERSION_MISMATCH`, `WORLD_MODEL_CANON_BASIS_CONFLICT`

## 병합 후보

병합 결정을 위한 제안이며 변경 사항이 아닙니다. 어느 후보든 사람이 읽는 메시지는
그대로 둡니다. 설계 4.6에 따라 예전 코드는 2개 마이너 버전 동안 응답의 별도 필드로 함께
돌려줍니다.

1. **그대로 둘 것.** 사용되는 356개와 문서화된 28개는 그대로 둡니다. prefix 분기 네
   묶음 안에서는 최소한 prefix를 유지합니다.
2. **1차 후보.** 테스트가 단언하지 않는 조용한 코드 1,729개입니다. 영역마다 마지막
   단어가 같은 코드를 영역 코드 하나로 묶습니다. 예를 들어 `PRODUCT_*_MISMATCH`는
   `PRODUCT_MISMATCH`로, `CODEX_*_INVALID`는 `CODEX_INVALID`로 묶습니다. 테스트는 바뀌지
   않고, 레지스트리 목록과 코드를 내는 곳만 바뀝니다.
3. **2차 후보.** 테스트가 단언하는 조용한 코드 621개입니다. 묶는 방식은 같지만, 테스트
   단언마다 영역 코드나 예전 코드 필드로 옮겨야 합니다.
4. **`INVALID_*`(576개).** 가장 큰 묶음이고 대부분 입력이나 기록의 형태 검사입니다.
   `INVALID_INPUT`(호출 입력)과 `INVALID_RECORD`(저장된 기록) 두 개로 대부분을 덮을 수
   있습니다. 사용되는 코드는 60개, 문서화된 코드는 4개뿐입니다.
5. **병합 대상에서 제외.** 옛 `HEAD_*` 표기를 아직 함께 돌려주는 121개는 3.6의 별칭
   기간을 먼저 따릅니다.

**여기서 정하지 않는 것:**
- 병합 여부
- 영역 코드의 이름
- 병합한 코드가 예전 코드도 함께 돌려줄지
- 이 저장소 밖의 사용처(Host 연동, 사용자 스크립트). 이 감사로는 볼 수 없습니다.
